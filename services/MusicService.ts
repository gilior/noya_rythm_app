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
    console.log(
      `[Session] START  initialHR=${initialHeartRate}  syncRange=[${Math.ceil(initialHeartRate * 0.95)}, ${initialHeartRate}]`,
    );

    // Initial sync: select a song at 95%–100% of HR — never faster than the user's heart (spec Step 1)
    await this.loadSong(initialHeartRate, {
      minBpm: Math.ceil(initialHeartRate * 0.95),
      maxBpm: initialHeartRate,
    });

    // Short artificial sync pause so the UI can show the syncing state
    await delay(2_000);

    this.setState({
      ...this.state,
      phase: "playing",
      isPlaying: true,
      message: "Your heart and music are now in sync",
    });

    console.log(`[Session] PHASE → playing  songBPM=${this.state.currentSongBPM}`);

    this.sound?.playAsync().catch(() => null);

    this.startSyncSongFlow();
  }

  updateSongBpmPerNewHeartRate(heartRate: number): void {
    if (this.state.phase === "idle" || this.state.phase === "syncing" || this.state.phase === "completed") return;
    if (this.state.currentHeartRate === 0) return;

    const prevHeartRate = this.state.currentHeartRate;
    const peakHeartRate = Math.max(this.state.peakHeartRate, heartRate);
    const hrChange = Math.abs(heartRate - prevHeartRate) / prevHeartRate;
    console.log(
      `[Session] HR_READ  hr=${heartRate}  prev=${prevHeartRate}  change=${(hrChange * 100).toFixed(1)}%  phase=${this.state.phase}`,
    );
    let { milestonesReached, message } = this.state;
    let nextMilestoneAt = this.nextMilestoneAt;

    if (heartRate <= nextMilestoneAt && nextMilestoneAt > 0) {
      milestonesReached++;
      nextMilestoneAt = nextMilestoneAt * (1 - MILESTONE_DROP_RATIO);
      const dropPct = Math.round((1 - heartRate / peakHeartRate) * 100);
      message = `Great job! Your heart slowed by ${dropPct}% 💫`;
    }

    this.nextMilestoneAt = nextMilestoneAt;

    if (this.state.phase === "playing") {
      // ── Step 2: still in sync phase — keep music matched to HR at 95%–100% ──
      this.setState({
        ...this.state,
        currentHeartRate: heartRate,
        peakHeartRate,
        milestonesReached,
        message,
      });

      if (!this.isLoadingLoop) {
        const syncMinBpm = Math.ceil(heartRate * 0.95);
        const syncMaxBpm = heartRate;
        const targetSongBPM = Math.round((syncMinBpm + syncMaxBpm) / 2);
        const effectiveSongBPM = this.state.currentSongBPM > 0 ? this.state.currentSongBPM : this.originSongBPM;
        const relativeSongBpmChange =
          effectiveSongBPM > 0 ? Math.abs(targetSongBPM - effectiveSongBPM) / effectiveSongBPM : 1;

        if (hrChange >= MINOR_CHANGE_THRESHOLD) {
          // Case B: HR changed ≥5% — load a new song at the updated sync range
          console.log(
            `[Session] SYNC Case B  hrChange=${(hrChange * 100).toFixed(1)}% ≥5%  newSyncRange=[${syncMinBpm}, ${syncMaxBpm}]  loadingNewSong`,
          );
          this.setState({ ...this.state, message: "Re-syncing to your heartbeat…" });
          this.loadSong(targetSongBPM, { minBpm: syncMinBpm, maxBpm: syncMaxBpm }); // fire-and-forget
        } else if (relativeSongBpmChange >= MINOR_CHANGE_THRESHOLD) {
          // Case A: minor change — adjust playback speed of current song, no switch
          console.log(
            `[Session] SYNC Case A  songBpmDrift=${(relativeSongBpmChange * 100).toFixed(1)}%  adjustingRate  target=${targetSongBPM}`,
          );
          this.adjustBPM(targetSongBPM);
          this.setState({ ...this.state, currentSongBPM: targetSongBPM });
        } else {
          console.log(
            `[Session] SYNC no-op  hrChange=${(hrChange * 100).toFixed(1)}%  songDrift=${(relativeSongBpmChange * 100).toFixed(1)}%  both <5%`,
          );
        }
        // Transition to slow-down phase only after 2 consecutive falling HR readings
        // to filter out single-sample noise and natural HR fluctuations.
        if (heartRate < prevHeartRate) {
          this.playingFallCount++;
          if (this.playingFallCount >= 2) {
            console.log(
              `[Session] PHASE → slowing  HR fell consistently (${this.playingFallCount} in a row, ${prevHeartRate}→${heartRate})`,
            );
            this.setState({
              ...this.state,
              phase: "slowing",
              message: "Synchronization achieved! Now let's slow things down…",
            });
            this.playingFallCount = 0;
          } else {
            console.log(`[Session] SYNC fall 1/2  waiting for 2nd consecutive drop (${prevHeartRate}→${heartRate})`);
          }
        } else {
          this.playingFallCount = 0; // HR stable or rising — reset the counter
        }
      }
    } else {
      // ── Step 3/4: slow-down phase — target 90%–95% of HR ──
      this.setState({
        ...this.state,
        phase: "slowing",
        currentHeartRate: heartRate,
        peakHeartRate,
        milestonesReached,
        message,
      });

      if (!this.isLoadingLoop) {
        const slowMinBpm = Math.ceil(heartRate * 0.9);
        const slowMaxBpm = Math.floor(heartRate * 0.95);
        const targetSongBPM = Math.round((slowMinBpm + slowMaxBpm) / 2);
        const effectiveSongBPM = this.state.currentSongBPM > 0 ? this.state.currentSongBPM : this.originSongBPM;
        const relativeSongBpmChange =
          effectiveSongBPM > 0 ? Math.abs(targetSongBPM - effectiveSongBPM) / effectiveSongBPM : 1;
        if (relativeSongBpmChange >= MINOR_CHANGE_THRESHOLD) {
          // Case B: HR changed ≥5% — load a new song at the slow-down range
          console.log(
            `[Session] SLOW Case B  songDrift=${(relativeSongBpmChange * 100).toFixed(1)}% ≥5%  slowRange=[${slowMinBpm}, ${slowMaxBpm}]  loadingNewSong`,
          );
          this.setState({ ...this.state, message: "Adapting music to your new rhythm…" });
          this.loadSong(targetSongBPM, { minBpm: slowMinBpm, maxBpm: slowMaxBpm }); // fire-and-forget
        } else {
          console.log(
            `[Session] SLOW Case A  songDrift=${(relativeSongBpmChange * 100).toFixed(1)}% <5%  intervalWillNudge`,
          );
        }
        // Case A (minor change) is handled by the adapt interval via adjustBPM
      }
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
    console.log(
      `[Session] PHASE → completed  finalHR=${this.state.currentHeartRate}  milestones=${this.state.milestonesReached}`,
    );
    this.stopSyncSongFlow();
    this.setState({
      ...this.state,
      phase: "completed",
      isPlaying: false,
      message: "Well done! Your heart rate is back to normal 🎉",
    });
  }

  continuePlaying(normalHeartRate: number): void {
    // After completion, play calming music at max = min(normalHeartRate, 80) per spec Step 5.
    // The adapt interval is intentionally NOT started here — the tempo is fixed at the cap
    // and should not be driven by the continuing HR readings.
    const targetSongBPM = Math.max(50, Math.min(normalHeartRate, 80));
    console.log(
      `[Session] CONTINUE_PLAYING  normalHR=${normalHeartRate}  calmingBPM=${targetSongBPM}  (cap=min(normalHR,80))`,
    );

    this.setState({
      ...this.state,
      phase: "slowing",
      currentSongBPM: targetSongBPM,
      isPlaying: true,
      message: "Enjoy some calming music…",
    });

    this.sound?.playAsync().catch(() => null);
    this.loadSong(targetSongBPM, { minBpm: 50, maxBpm: targetSongBPM }).catch(() => null);
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
    this.loadSong(this.state.currentSongBPM, bpmRange).catch(() => null);
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
        console.log(
          `[Session] INTERVAL nudge  phase=${this.state.phase}  currentBPM=${this.state.currentSongBPM}→${nudgedSongBPM}  target=${targetSongBPM}`,
        );
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

  private async loadSong(targetSongBPM: number, bpmRange?: { minBpm: number; maxBpm: number }): Promise<void> {
    // Pick a random preferred genre for this load; undefined means search all genres.
    const genre =
      this.preferredGenres.length > 0
        ? this.preferredGenres[Math.floor(Math.random() * this.preferredGenres.length)]
        : undefined;
    const excludeIds = this.recentlyPlayedIds.length > 0 ? [...this.recentlyPlayedIds] : undefined;
    console.log(
      `[Session] LOAD_SONG  target=${targetSongBPM}  range=${bpmRange ? `[${bpmRange.minBpm}, ${bpmRange.maxBpm}]` : "none (fallback)"}  genre=${genre ?? "any"}`,
    );
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
      console.log(
        `[Session] SONG_SELECTED  title="${song.title}"  catalogBPM=${song.bpm}  genre=${song.genre}  inRange=${inRange}`,
      );
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
