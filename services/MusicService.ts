import { Audio } from "expo-av";
import { SessionState } from "../types";
import { songCatalogService } from "./SongCatalogService";

type StateChangeCallback = (state: SessionState) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Threshold for "minor" BPM change that uses tempo-stretch vs new loop */
const MINOR_CHANGE_THRESHOLD = 0.05;
/** Each milestone fires at every 10 % drop from peak */
const MILESTONE_DROP_RATIO = 0.1;
/** Music BPM nudge period (ms) — spec: "every song end or every 2 minutes" */
const ADAPT_INTERVAL_MS = 120_000;

// ─── Service ──────────────────────────────────────────────────────────────────

class MusicService {
  private currentRate = 1.0;
  private originSongBPM = 0;
  private nextMilestoneAt = 0;
  private state: SessionState = this.defaultState();
  private listeners: Set<StateChangeCallback> = new Set();
  private sound: Audio.Sound | null = null;
  private adaptIntervalId: ReturnType<typeof setInterval> | null = null;
  private isLoadingLoop = false;
  /** Number of consecutive falling HR readings while in playing phase. Transition to slowing requires ≥2. */
  private playingFallCount = 0;
  /** User's preferred genres, used to filter song selection per spec. */
  private preferredGenres: string[] = [];
  /** IDs of the last 3 songs played, passed as excludeIds to avoid immediate repeats per spec. */
  private recentlyPlayedIds: string[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async startSession(initialHeartRate: number, preferredGenres: string[] = []): Promise<void> {
    this.preferredGenres = preferredGenres;
    this.recentlyPlayedIds = [];
    this.nextMilestoneAt = initialHeartRate * (1 - MILESTONE_DROP_RATIO);
    this.setState({
      ...this.defaultState(),
      phase: "syncing",
      currentHeartRate: initialHeartRate,
      currentSongBPM: initialHeartRate,
      peakHeartRate: initialHeartRate,
      startHeartRate: initialHeartRate,
      startTime: Date.now(),
      message: "Syncing music to your heartbeat…",
    });

    this.playingFallCount = 0;

    // Initial sync: select a song at 95%–100% of HR — never faster than the user's heart (spec Step 1)
    await this.loadSong(
      initialHeartRate,
      {
        minBpm: Math.ceil(initialHeartRate * 0.95),
        maxBpm: initialHeartRate,
      },
      "initial-sync",
    );

    // Short artificial sync pause so the UI can show the syncing state
    await delay(2_000);

    this.setState({
      ...this.state,
      phase: "playing",
      isPlaying: true,
      message: "Your heart and music are now in sync",
    });

    this.sound?.playAsync().catch(() => null);

    this.startSyncSongFlow();
  }

  updateSongBpmPerNewHeartRate(heartRate: number): void {
    if (this.state.phase === "idle" || this.state.phase === "syncing" || this.state.phase === "completed") return;
    if (this.state.currentHeartRate === 0) return;

    const prevHeartRate = this.state.currentHeartRate;
    const peakHeartRate = Math.max(this.state.peakHeartRate, heartRate);
    const hrChange = Math.abs(heartRate - prevHeartRate) / prevHeartRate;
    const { milestonesReached, message } = this.computeMilestoneUpdate(heartRate, peakHeartRate);

    if (this.state.phase === "playing") {
      this.handleSyncPhase(heartRate, prevHeartRate, peakHeartRate, hrChange, milestonesReached, message);
    } else {
      this.handleSlowDownPhase(heartRate, peakHeartRate, hrChange, milestonesReached, message);
    }
  }

  /** Returns true when BPM has reached the user's normal level */
  checkCompletion(normalHeartRate: number): boolean {
    return (
      this.state.currentHeartRate > 0 &&
      this.state.currentHeartRate <= normalHeartRate &&
      this.state.phase !== "completed" &&
      this.state.phase !== "idle"
    );
  }

  completeSession(): void {
    this.stopSyncSongFlow();
    this.setState({
      ...this.state,
      phase: "completed",
      isPlaying: false,
      message: "Well done! Your heart rate is back to normal 🎉",
    });
  }

  continuePlaying(normalHeartRate: number): void {
    // After completion, play calming music at max = min(normalHeartRate, 80) per spec Step 4.
    // The adapt interval is intentionally NOT started here — the tempo is fixed at the cap
    // and should not be driven by the continuing HR readings.
    const targetSongBPM = Math.max(50, Math.min(normalHeartRate, 80));

    this.setState({
      ...this.state,
      phase: "slowing",
      currentSongBPM: targetSongBPM,
      isPlaying: true,
      message: "Enjoy some calming music…",
    });

    this.sound?.playAsync().catch(() => null);
    this.loadSong(targetSongBPM, { minBpm: 50, maxBpm: targetSongBPM }, "post-completion-calming").catch(() => null);
  }

  /** Returns session summary and resets internal state */
  endSession(): {
    startHeartRate: number;
    lowestHeartRate: number;
    duration: number;
    milestonesReached: number;
  } {
    this.stopSyncSongFlow();
    const result = {
      startHeartRate: this.state.startHeartRate,
      lowestHeartRate: this.state.currentHeartRate,
      duration: Math.round((Date.now() - this.state.startTime) / 1_000),
      milestonesReached: this.state.milestonesReached,
    };
    this.preferredGenres = [];
    this.recentlyPlayedIds = [];
    this.stopSong();
    this.setState(this.defaultState());
    return result;
  }

  togglePlayback(): void {
    const isPlaying = !this.state.isPlaying;
    if (isPlaying) {
      this.sound?.playAsync().catch(() => null);
    } else {
      this.sound?.pauseAsync().catch(() => null);
    }
    this.setState({ ...this.state, isPlaying });
  }

  skipLoop(): void {
    if (this.state.phase === "idle" || this.state.phase === "completed") return;
    this.setState({ ...this.state, message: "Loading next track…" });
    const hr = this.state.currentHeartRate || this.state.startHeartRate;
    // Use sync range during the initial playing phase, slow-down range once we're slowing
    const bpmRange =
      this.state.phase === "playing"
        ? { minBpm: Math.ceil(hr * 0.95), maxBpm: hr }
        : { minBpm: Math.ceil(hr * 0.9), maxBpm: Math.floor(hr * 0.95) };
    this.loadSong(this.state.currentSongBPM, bpmRange, "user-skip").catch(() => null);
  }

  onStateChange(cb: StateChangeCallback): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  getState(): SessionState {
    return this.state;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns updated milestone count and message if the heart rate crossed
   * the next 10% drop threshold. Also advances nextMilestoneAt.
   */
  private computeMilestoneUpdate(
    heartRate: number,
    peakHeartRate: number,
  ): { milestonesReached: number; message: string } {
    if (heartRate > this.nextMilestoneAt || this.nextMilestoneAt === 0) {
      return { milestonesReached: this.state.milestonesReached, message: this.state.message };
    }
    const dropPct = Math.round((1 - heartRate / peakHeartRate) * 100);
    this.nextMilestoneAt *= 1 - MILESTONE_DROP_RATIO;
    return {
      milestonesReached: this.state.milestonesReached + 1,
      message: `Great job! Your heart slowed by ${dropPct}% 💫`,
    };
  }

  /**
   * Step 1 – Sync Phase: music stays matched to HR at 95%–100%.
   * Runs until two consecutive falling HR readings confirm sync, then transitions to Step 2.
   */
  private handleSyncPhase(
    heartRate: number,
    prevHeartRate: number,
    peakHeartRate: number,
    hrChange: number,
    milestonesReached: number,
    message: string,
  ): void {
    this.setState({ ...this.state, currentHeartRate: heartRate, peakHeartRate, milestonesReached, message });
    if (this.isLoadingLoop) return;
    this.adaptSyncPhaseSong(heartRate, hrChange);
    this.checkSyncToSlowTransition(heartRate, prevHeartRate);
  }

  /**
   * Adapts music during the sync phase:
   * - Case B (HR change ≥5%): load a new song at 95%–100% of updated HR.
   * - Case A (minor drift): stretch current song's playback speed.
   */
  private adaptSyncPhaseSong(heartRate: number, hrChange: number): void {
    const minBpm = Math.ceil(heartRate * 0.95);
    const maxBpm = heartRate;
    const targetBpm = Math.round((minBpm + maxBpm) / 2);

    if (hrChange >= MINOR_CHANGE_THRESHOLD) {
      this.setState({ ...this.state, message: "Re-syncing to your heartbeat…" });
      this.loadSong(
        targetBpm,
        { minBpm, maxBpm },
        `sync-phase-major-hr-change (hrChange: ${(hrChange * 100).toFixed(1)}%, HR: ${heartRate})`,
      ); // fire-and-forget
      return;
    }

    const effectiveBpm = this.state.currentSongBPM > 0 ? this.state.currentSongBPM : this.originSongBPM;
    const songDrift = effectiveBpm > 0 ? Math.abs(targetBpm - effectiveBpm) / effectiveBpm : 1;
    if (songDrift >= MINOR_CHANGE_THRESHOLD) {
      this.adjustBPM(targetBpm);
      this.setState({ ...this.state, currentSongBPM: targetBpm });
    }
  }

  /**
   * Detects transition from sync phase to slow-down phase.
   * Requires 2 consecutive falling HR readings to avoid reacting to noise.
   */
  private checkSyncToSlowTransition(heartRate: number, prevHeartRate: number): void {
    if (heartRate >= prevHeartRate) {
      this.playingFallCount = 0;
      return;
    }

    this.playingFallCount++;
    if (this.playingFallCount < 2) return;

    this.playingFallCount = 0;
    const minBpm = Math.ceil(heartRate * 0.9);
    const maxBpm = Math.floor(heartRate * 0.95);
    this.setState({
      ...this.state,
      phase: "slowing",
      message: "Your heart and music are now in sync — let's try to slow your heart",
    });
    this.loadSong(
      Math.round((minBpm + maxBpm) / 2),
      { minBpm, maxBpm },
      `transition-to-slow-phase (HR: ${heartRate}, prev: ${prevHeartRate})`,
    ); // fire-and-forget
  }

  /**
   * Step 2 – Slow Down Phase: music targets 90%–95% of HR.
   * - Case B (HR change ≥5%): load a new song at the lower range.
   * - Case A (minor change): handled by the 2-min adapt interval.
   */
  private handleSlowDownPhase(
    heartRate: number,
    peakHeartRate: number,
    hrChange: number,
    milestonesReached: number,
    message: string,
  ): void {
    this.setState({
      ...this.state,
      phase: "slowing",
      currentHeartRate: heartRate,
      peakHeartRate,
      milestonesReached,
      message,
    });
    if (this.isLoadingLoop) return;

    if (hrChange >= MINOR_CHANGE_THRESHOLD) {
      const minBpm = Math.ceil(heartRate * 0.9);
      const maxBpm = Math.floor(heartRate * 0.95);
      this.setState({ ...this.state, message: "Adapting music to your new rhythm…" });
      this.loadSong(
        Math.round((minBpm + maxBpm) / 2),
        { minBpm, maxBpm },
        `slow-phase-major-hr-change (hrChange: ${(hrChange * 100).toFixed(1)}%, HR: ${heartRate})`,
      ); // fire-and-forget
    }
    // Case A: minor change nudged by the adapt interval via adjustBPM
  }

  private defaultState(): SessionState {
    return {
      phase: "idle",
      currentHeartRate: 0,
      currentSongBPM: 0,
      peakHeartRate: 0,
      startHeartRate: 0,
      milestonesReached: 0,
      startTime: 0,
      isPlaying: false,
      message: "",
      currentSong: null,
    };
  }

  private setState(newState: SessionState): void {
    this.state = newState;
    this.listeners.forEach((cb) => cb(this.state));
  }

  private startSyncSongFlow(): void {
    this.stopSyncSongFlow();
    this.adaptIntervalId = setInterval(() => {
      if (this.state.phase !== "playing" && this.state.phase !== "slowing") return;
      if (this.isLoadingLoop) return; // a major-change load is already in progress

      const hr = this.state.currentHeartRate;
      // Phase-aware target: sync range midpoint during 'playing', slow-down midpoint during 'slowing'
      const targetSongBPM =
        this.state.phase === "playing"
          ? Math.round((Math.ceil(hr * 0.95) + hr) / 2)
          : Math.round((Math.ceil(hr * 0.9) + Math.floor(hr * 0.95)) / 2);

      const effectiveSongBPM = this.state.currentSongBPM > 0 ? this.state.currentSongBPM : this.originSongBPM;
      const relativeSongBpmChange =
        effectiveSongBPM > 0 ? Math.abs(targetSongBPM - effectiveSongBPM) / effectiveSongBPM : 1;

      if (relativeSongBpmChange >= MINOR_CHANGE_THRESHOLD) {
        // Major drift — HR handler fires loadSong on readings; nothing to do here
        return;
      }

      // Minor change (Case A): nudge playback speed toward target without switching songs.
      // In slowing phase, only nudge downward — never let the interval push tempo up.
      const needsNudge =
        this.state.phase === "playing"
          ? this.state.currentSongBPM !== targetSongBPM
          : this.state.currentSongBPM > targetSongBPM;
      if (needsNudge) {
        const nudgedSongBPM =
          this.state.phase === "playing"
            ? Math.min(targetSongBPM, this.state.currentSongBPM + 2) // can nudge up or hold during sync
            : Math.max(targetSongBPM, this.state.currentSongBPM - 2); // only nudge down during slow-down
        const actualSongBPM = this.adjustBPM(nudgedSongBPM);
        this.setState({ ...this.state, currentSongBPM: actualSongBPM });
      }
    }, ADAPT_INTERVAL_MS);
  }

  private stopSyncSongFlow(): void {
    if (this.adaptIntervalId) {
      clearInterval(this.adaptIntervalId);
      this.adaptIntervalId = null;
    }
  }

  private async loadSong(
    targetSongBPM: number,
    bpmRange?: { minBpm: number; maxBpm: number },
    reason = "unknown",
  ): Promise<void> {
    console.log(
      `[MusicService] loadSong — reason: "${reason}" | targetBPM: ${targetSongBPM}` +
        (bpmRange ? ` | range: [${bpmRange.minBpm}–${bpmRange.maxBpm}]` : "") +
        ` | phase: ${this.state.phase} | currentHR: ${this.state.currentHeartRate} | currentSongBPM: ${this.state.currentSongBPM}`,
    );
    // Pick a random preferred genre for this load; undefined means search all genres.
    const genre =
      this.preferredGenres.length > 0
        ? this.preferredGenres[Math.floor(Math.random() * this.preferredGenres.length)]
        : undefined;
    const excludeIds = this.recentlyPlayedIds.length > 0 ? [...this.recentlyPlayedIds] : undefined;
    this.isLoadingLoop = true;
    try {
      await this.stopSong();

      // Priority: preferred genre + exact range + no repeats, falling back progressively.
      // The hard maxBpm cap is preserved in all BPM-range searches (spec: never exceed HR).
      const song = bpmRange
        ? ((genre &&
            songCatalogService.pickRandomSong({
              minBpm: bpmRange.minBpm,
              maxBpm: bpmRange.maxBpm,
              genre,
              excludeIds,
            })) ??
          (genre && songCatalogService.pickRandomSong({ minBpm: bpmRange.minBpm, maxBpm: bpmRange.maxBpm, genre })) ??
          songCatalogService.pickRandomSong({ minBpm: bpmRange.minBpm, maxBpm: bpmRange.maxBpm, excludeIds }) ??
          songCatalogService.pickRandomSong({ minBpm: bpmRange.minBpm, maxBpm: bpmRange.maxBpm }) ??
          (genre &&
            songCatalogService.pickRandomSong({
              targetBpm: targetSongBPM,
              bpmTolerance: 15,
              maxBpm: bpmRange.maxBpm,
              genre,
            })) ??
          songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 15, maxBpm: bpmRange.maxBpm }) ??
          songCatalogService.pickRandomSong())
        : ((genre &&
            songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 5, genre, excludeIds })) ??
          (genre && songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 5, genre })) ??
          songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 5, excludeIds }) ??
          songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 5 }) ??
          songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 15 }) ??
          songCatalogService.pickRandomSong());

      if (!song) {
        console.warn("No matching song found for BPM:", targetSongBPM);
        return;
      }

      this.originSongBPM = song.bpm ?? targetSongBPM;
      this.currentRate = 1.0;
      // Track recently played IDs to avoid immediate repeats (spec requirement)
      this.recentlyPlayedIds = [song.id, ...this.recentlyPlayedIds].slice(0, 3);
      const inRange = bpmRange ? song.bpm !== null && song.bpm >= bpmRange.minBpm && song.bpm <= bpmRange.maxBpm : true;
      // Guard: if session ended while this async load was in-flight, discard the result
      if (this.state.phase === "idle" || this.state.phase === "completed") return;
      // When a fallback is out of range, track currentSongBPM at target so drift
      // calculation on the next HR reading doesn't immediately trigger another load.
      this.setState({
        ...this.state,
        currentSong: { title: song.title, bpm: song.bpm },
        currentSongBPM: inRange ? Math.round(this.originSongBPM) : targetSongBPM,
      });

      if (!song.audioUrl) {
        console.warn("MusicService: song has no audioUrl, skipping:", song.id);
        return;
      }

      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });

      const { sound } = await Audio.Sound.createAsync(
        { uri: song.audioUrl },
        { isLooping: true, shouldPlay: this.state.isPlaying },
      );
      this.sound = sound;

      if (this.state.phase === "syncing") {
        this.setState({
          ...this.state,
          message: "Your heart and music are now in sync",
        });
      }
    } catch (e) {
      console.warn("MusicService: failed to load audio", e);
    } finally {
      this.isLoadingLoop = false;
    }
  }

  /**
   * Adjusts the playback rate to approximate a tempo change.
   * True pitch-preserving time-stretch requires a native DSP module.
   */
  private adjustBPM(targetSongBPM: number): number {
    if (!this.sound || this.originSongBPM === 0) return this.state.currentSongBPM;

    const rate = targetSongBPM / this.originSongBPM;
    // Spec: "tempo-stretch within ±5% of the song's native BPM"
    const clampedRate = Math.min(1.05, Math.max(0.95, rate));

    this.currentRate = clampedRate;
    this.sound.setRateAsync(clampedRate, true).catch(() => null);
    return Math.round(this.originSongBPM * clampedRate);
  }

  private async stopSong(): Promise<void> {
    if (this.sound) {
      await this.sound.stopAsync().catch(() => null);
      this.sound = null;
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton
export const musicService = new MusicService();
