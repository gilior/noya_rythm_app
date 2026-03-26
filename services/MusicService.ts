/**
 * MusicService
 *
 * Manages the full music-session state machine and BPM synchronisation logic.
 *
 * --- Audio integration ---
 * The service is wired to expo-av for playback.  Drop audio loop files into
 * assets/audio/ (e.g. loop_70bpm.mp3 … loop_150bpm.mp3) and map them in
 * LOOP_LIBRARY below.  Without files the session UI still runs fully.
 *
 * For real-time tempo adjustment (time-stretching) you would need a native
 * audio library such as react-native-track-player + a custom DSP plugin.
 * That is outside Expo Go's scope and is documented here as the integration
 * point: replace adjustTempo() with a native call.
 *
 * AI-generated loops: call your generation API inside generateLoop() and
 * cache the result locally with expo-file-system.
 */

import { Audio } from "expo-av";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionPhase =
  | "idle"
  | "syncing"
  | "playing"
  | "slowing"
  | "completed";

export interface SessionState {
  phase: SessionPhase;
  currentBPM: number;
  musicBPM: number;
  peakBPM: number;
  startBPM: number;
  milestonesReached: number;
  /** BPM threshold at which the next milestone fires */
  nextMilestoneAt: number;
  startTime: number;
  isPlaying: boolean;
  message: string;
}

type StateChangeCallback = (state: SessionState) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Threshold for "minor" BPM change that uses tempo-stretch vs new loop */
const MINOR_CHANGE_THRESHOLD = 0.05;
/** After sync, target music at 92 % of current heart BPM to start slow-down */
const SLOW_TARGET_RATIO = 0.92;
/** Each milestone fires at every 10 % drop from peak */
const MILESTONE_DROP_RATIO = 0.1;
/** Music BPM nudge period (ms) */
const ADAPT_INTERVAL_MS = 10_000;

/**
 * Pre-generated loop library.
 * Keys are the BPM value, values are require() paths.
 * Add real files here:
 *   [80]:  require('../assets/audio/loop_80bpm.mp3'),
 *   [90]:  require('../assets/audio/loop_90bpm.mp3'),
 *   ...
 */
const LOOP_LIBRARY: Record<number, number> = {
  // populated by the developer once audio files are available
};

// ─── Service ──────────────────────────────────────────────────────────────────

class MusicService {
  private state: SessionState = this.defaultState();
  private listeners: Set<StateChangeCallback> = new Set();
  private sound: Audio.Sound | null = null;
  private adaptIntervalId: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async startSession(initialBPM: number): Promise<void> {
    this.setState({
      ...this.defaultState(),
      phase: "syncing",
      currentBPM: initialBPM,
      musicBPM: initialBPM,
      peakBPM: initialBPM,
      startBPM: initialBPM,
      startTime: Date.now(),
      nextMilestoneAt: initialBPM * (1 - MILESTONE_DROP_RATIO),
      message: "Syncing music to your heartbeat…",
    });

    await this.loadLoop(initialBPM);

    // Short artificial sync pause so the UI can show the syncing state
    await delay(2_000);

    this.setState({
      ...this.state,
      phase: "playing",
      isPlaying: true,
      message: "Your heart and music are now in sync",
    });

    this.startAdaptLoop();
  }

  /**
   * Called each time a new BPM reading arrives during a session.
   * Decides whether to adjust tempo (minor change) or load a new loop (major).
   */
  updateBPM(newBPM: number): void {
    if (this.state.phase === "idle" || this.state.phase === "completed") return;

    const relativeChange =
      Math.abs(newBPM - this.state.currentBPM) / this.state.currentBPM;

    let newMusicBPM = this.state.musicBPM;
    let message = this.state.message;

    if (relativeChange >= MINOR_CHANGE_THRESHOLD) {
      // Major change: select/generate a new loop at the new BPM range
      newMusicBPM = Math.round(newBPM * SLOW_TARGET_RATIO);
      message = "Adapting music to your new rhythm…";
      this.loadLoop(newMusicBPM); // fire-and-forget
    } else {
      // Minor change: small tempo adjustment
      newMusicBPM = Math.round(
        this.state.musicBPM - this.state.musicBPM * relativeChange * 0.5,
      );
      this.adjustTempo(newMusicBPM);
    }

    const peakBPM = Math.max(this.state.peakBPM, newBPM);
    let { milestonesReached, nextMilestoneAt } = this.state;

    if (newBPM <= nextMilestoneAt && nextMilestoneAt > 0) {
      milestonesReached++;
      nextMilestoneAt = nextMilestoneAt * (1 - MILESTONE_DROP_RATIO);
      const dropPct = Math.round((1 - newBPM / peakBPM) * 100);
      message = `Great job! Your heart slowed by ${dropPct}% 💫`;
    }

    this.setState({
      ...this.state,
      phase: "slowing",
      currentBPM: newBPM,
      musicBPM: Math.max(50, newMusicBPM),
      peakBPM,
      milestonesReached,
      nextMilestoneAt,
      message,
    });
  }

  /** Returns true when BPM has reached the user's normal level */
  checkCompletion(normalBPM: number): boolean {
    return (
      this.state.currentBPM > 0 &&
      this.state.currentBPM <= normalBPM &&
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
    // Switch to calming mode (≤ 80 BPM)
    this.setState({
      ...this.state,
      phase: "slowing",
      musicBPM: 75,
      isPlaying: true,
      message: "Enjoy some calming music…",
    });
    this.loadLoop(75);
  }

  /** Returns session summary and resets internal state */
  endSession(): {
    startBPM: number;
    lowestBPM: number;
    duration: number;
    milestonesReached: number;
  } {
    this.stopAdaptLoop();
    const result = {
      startBPM: this.state.startBPM,
      lowestBPM: this.state.currentBPM,
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
    const msg = this.state.message;
    this.setState({ ...this.state, message: "Loading next track…" });
    // Reload the loop at current music BPM
    this.loadLoop(this.state.musicBPM).then(() => {
      this.setState({ ...this.state, message: msg });
    });
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
      currentBPM: 0,
      musicBPM: 0,
      peakBPM: 0,
      startBPM: 0,
      milestonesReached: 0,
      nextMilestoneAt: 0,
      startTime: 0,
      isPlaying: false,
      message: "",
    };
  }

  private setState(newState: SessionState): void {
    this.state = newState;
    this.listeners.forEach((cb) => cb(this.state));
  }

  private startAdaptLoop(): void {
    this.stopAdaptLoop();
    this.adaptIntervalId = setInterval(() => {
      if (this.state.phase === "playing" || this.state.phase === "slowing") {
        const target = Math.round(this.state.currentBPM * SLOW_TARGET_RATIO);
        if (this.state.musicBPM > target) {
          const nudged = Math.max(target, this.state.musicBPM - 2);
          this.adjustTempo(nudged);
          this.setState({ ...this.state, musicBPM: nudged });
        }
      }
    }, ADAPT_INTERVAL_MS);
  }

  private stopAdaptLoop(): void {
    if (this.adaptIntervalId) {
      clearInterval(this.adaptIntervalId);
      this.adaptIntervalId = null;
    }
  }

  private getNearestSongIdForBPM(bpm: number): string {
    return "Km7B76mRIVw";
  }
  private async loadLoop(bpm: number): Promise<void> {
    await this.stopAudio();

    // 1. Instead of looping through a static LOOP_LIBRARY,
    // find a matching YouTube ID from your loaded JSON playlists.
    const youtubeId = this.getNearestSongIdForBPM(bpm);

    if (!youtubeId) {
      console.warn("No matching song found for BPM:", bpm);
      return;
    }

    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });

      // Tell UI we are loading
      this.setState({ ...this.state, message: "Fetching high-quality audio…" });

      // 2. Fetch the audio stream URL from a RapidAPI endpoint
      // TODO: Register on RapidAPI for a YouTube to MP3/Audio API (like youtube-mp36)
      // and place your API Key and Host here.
      const rapidApiKey = "YOUR_RAPIDAPI_KEY_HERE";
      const rapidApiHost = "youtube-mp36.p.rapidapi.com";
      const url = `https://${rapidApiHost}/dl?id=${youtubeId}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": rapidApiKey,
          "x-rapidapi-host": rapidApiHost,
        },
      });

      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }

      const data = await response.json();

      // The exact property name depends on the specific RapidAPI endpoint you choose.
      // Many return the direct stream link as `data.link` or `data.url`.
      const directAudioStreamUrl = data.link || data.url;

      if (!directAudioStreamUrl) {
        throw new Error("No download link found in API response");
      }

      // 3. Mount it to expo-av (treats it exactly like a local file!)
      const { sound } = await Audio.Sound.createAsync(
        { uri: directAudioStreamUrl },
        { isLooping: true, shouldPlay: this.state.isPlaying },
      );
      this.sound = sound;

      // Ensure the UI knows we are back in sync
      if (this.state.phase === "syncing") {
        this.setState({
          ...this.state,
          message: "Your heart and music are now in sync",
        });
      }
    } catch (e) {
      console.warn(
        "MusicService: failed to load YouTube stream via RapidAPI",
        e,
      );
    }
  }

  /**
   * Adjusts the playback rate to approximate a tempo change.
   * True pitch-preserving time-stretch requires a native DSP module.
   */
  private adjustTempo(targetBPM: number): void {
    if (!this.sound || this.state.musicBPM === 0) return;
    const rate = targetBPM / this.state.musicBPM;
    // Clamp to reasonable range to avoid distortion
    const clampedRate = Math.min(2.0, Math.max(0.5, rate));
    this.sound.setRateAsync(clampedRate, true).catch(() => null);
  }

  private async stopAudio(): Promise<void> {
    if (this.sound) {
      await this.sound.stopAsync().catch(() => null);
      await this.sound.unloadAsync().catch(() => null);
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
  return available.reduce((prev, cur) =>
    Math.abs(cur - target) < Math.abs(prev - target) ? cur : prev,
  );
}

// Singleton
export const musicService = new MusicService();
