import { Audio } from "expo-av";
import { SessionState } from "../types";
import { songCatalogService } from "./SongCatalogService";

type StateChangeCallback = (state: SessionState) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Threshold for "minor" BPM change that uses tempo-stretch vs new loop */
const MINOR_CHANGE_THRESHOLD = 0.05;
/** After sync, target music at 92 % of current heart BPM to start slow-down */
const SLOW_TARGET_RATIO = 0.92;
/** Each milestone fires at every 10 % drop from peak */
const MILESTONE_DROP_RATIO = 0.1;
/** Music BPM nudge period (ms) */
const ADAPT_INTERVAL_MS = 30_000;

// ─── Service ──────────────────────────────────────────────────────────────────

class MusicService {
  private currentRate = 1.0;
  private originSongBPM = 0;
  private state: SessionState = this.defaultState();
  private listeners: Set<StateChangeCallback> = new Set();
  private sound: Audio.Sound | null = null;
  private adaptIntervalId: ReturnType<typeof setInterval> | null = null;
  private isLoadingLoop = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async startSession(initialHeartRate: number): Promise<void> {
    this.setState({
      ...this.defaultState(),
      phase: "syncing",
      currentHeartRate: initialHeartRate,
      currentSongBPM: initialHeartRate,
      peakHeartRate: initialHeartRate,
      startHeartRate: initialHeartRate,
      startTime: Date.now(),
      nextMilestoneAt: initialHeartRate * (1 - MILESTONE_DROP_RATIO),
      message: "Syncing music to your heartbeat…",
    });

    await this.loadLoop(initialHeartRate);

    // Short artificial sync pause so the UI can show the syncing state
    await delay(2_000);

    this.setState({
      ...this.state,
      phase: "playing",
      isPlaying: true,
      message: "Your heart and music are now in sync",
    });

    this.sound?.playAsync().catch(() => null);

    this.startAdaptLoop();
  }

  updateSongBpmPerNewHeartRate(heartRate: number): void {
    if (this.state.phase === "idle" || this.state.phase === "syncing" || this.state.phase === "completed") return;
    if (this.state.currentHeartRate === 0) return;

    const peakHeartRate = Math.max(this.state.peakHeartRate, heartRate);
    let { milestonesReached, nextMilestoneAt, message } = this.state;

    if (heartRate <= nextMilestoneAt && nextMilestoneAt > 0) {
      milestonesReached++;
      nextMilestoneAt = nextMilestoneAt * (1 - MILESTONE_DROP_RATIO);
      const dropPct = Math.round((1 - heartRate / peakHeartRate) * 100);
      message = `Great job! Your heart slowed by ${dropPct}% 💫`;
    }

    this.setState({
      ...this.state,
      phase: "slowing",
      currentHeartRate: heartRate,
      peakHeartRate,
      milestonesReached,
      nextMilestoneAt,
      message,
    });

    // Major change: load a new loop immediately (adapt loop handles minor nudges)
    if (!this.isLoadingLoop) {
      const targetSongBPM = Math.round(heartRate * SLOW_TARGET_RATIO);
      const relativeSongBpmChange =
        this.originSongBPM > 0 ? Math.abs(targetSongBPM - this.originSongBPM) / this.originSongBPM : 1;
      if (relativeSongBpmChange >= MINOR_CHANGE_THRESHOLD) {
        this.setState({ ...this.state, message: "Adapting music to your new rhythm…" });
        this.loadLoop(targetSongBPM); // fire-and-forget
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
    this.stopAdaptLoop();
    this.setState({
      ...this.state,
      phase: "completed",
      isPlaying: false,
      message: "Well done! Your heart rate is back to normal 🎉",
    });
  }

  continuePlaying(): void {
    const targetSongBPM = Math.max(
      50,
      Math.round(this.state.currentHeartRate || this.state.currentSongBPM || this.state.startHeartRate),
    );

    this.setState({
      ...this.state,
      phase: "slowing",
      currentSongBPM: targetSongBPM,
      isPlaying: true,
      message: "Enjoy some calming music…",
    });

    this.sound?.playAsync().catch(() => null);
    this.startAdaptLoop();
    this.loadLoop(targetSongBPM).catch(() => null);
  }

  /** Returns session summary and resets internal state */
  endSession(): {
    startHeartRate: number;
    lowestHeartRate: number;
    duration: number;
    milestonesReached: number;
  } {
    this.stopAdaptLoop();
    const result = {
      startHeartRate: this.state.startHeartRate,
      lowestHeartRate: this.state.currentHeartRate,
      duration: Math.round((Date.now() - this.state.startTime) / 1_000),
      milestonesReached: this.state.milestonesReached,
    };
    this.stopAudio();
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
    this.loadLoop(this.state.currentSongBPM).catch(() => null);
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
      nextMilestoneAt: 0,
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

  private startAdaptLoop(): void {
    this.stopAdaptLoop();
    this.adaptIntervalId = setInterval(() => {
      if (this.state.phase !== "playing" && this.state.phase !== "slowing") return;
      if (this.isLoadingLoop) return; // a major-change load is already in progress

      const targetSongBPM = Math.round(this.state.currentHeartRate * SLOW_TARGET_RATIO);
      const relativeSongBpmChange =
        this.originSongBPM > 0 ? Math.abs(targetSongBPM - this.originSongBPM) / this.originSongBPM : 1;

      if (relativeSongBpmChange >= MINOR_CHANGE_THRESHOLD) {
        // Major drift — HR handler fires loadLoop on readings; nothing to do here
        return;
      }

      // Minor change: nudge down only if music is still above target
      if (this.state.currentSongBPM > targetSongBPM) {
        const nudgedSongBPM = Math.max(targetSongBPM, this.state.currentSongBPM - 2);
        const actualSongBPM = this.adjustTempo(nudgedSongBPM);
        this.setState({ ...this.state, currentSongBPM: actualSongBPM });
      }
    }, ADAPT_INTERVAL_MS);
  }

  private stopAdaptLoop(): void {
    if (this.adaptIntervalId) {
      clearInterval(this.adaptIntervalId);
      this.adaptIntervalId = null;
    }
  }

  private async loadLoop(targetSongBPM: number): Promise<void> {
    console.log("[MusicService] [loadLoop]", targetSongBPM);
    this.isLoadingLoop = true;
    try {
      await this.stopAudio();

      // Pick a song from the catalog that matches the target BPM (±10 BPM).
      // Falls back to a wider search across all genres if nothing is found.
      const song =
        songCatalogService.pickRandomSong({ targetBpm: targetSongBPM, bpmTolerance: 10 }) ??
        songCatalogService.pickRandomSong();

      if (!song) {
        console.warn("No matching song found for BPM:", targetSongBPM);
        return;
      }

      this.originSongBPM = song.bpm ?? targetSongBPM;
      this.currentRate = 1.0;
      this.setState({
        ...this.state,
        currentSong: { title: song.title, bpm: song.bpm },
        currentSongBPM: Math.round(this.originSongBPM),
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
  private adjustTempo(targetSongBPM: number): number {
    if (!this.sound || this.originSongBPM === 0) return this.state.currentSongBPM;

    const rate = targetSongBPM / this.originSongBPM;
    const clampedRate = Math.min(2.0, Math.max(0.5, rate));

    console.log(
      `[MusicService] [adjustTempo] nativeSongBPM=${this.originSongBPM} targetSongBPM=${targetSongBPM} rate=${clampedRate.toFixed(3)}`,
    );

    this.currentRate = clampedRate;
    this.sound.setRateAsync(clampedRate, true).catch(() => null);
    return Math.round(this.originSongBPM * clampedRate);
  }

  private async stopAudio(): Promise<void> {
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

function findNearestBPM(target: number, available: number[]): number | null {
  if (available.length === 0) return null;
  return available.reduce((prev, cur) => (Math.abs(cur - target) < Math.abs(prev - target) ? cur : prev));
}

// Singleton
export const musicService = new MusicService();
