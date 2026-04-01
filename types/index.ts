export interface UserProfile {
  normalHeartRate: number;
  tooFastHeartRate: number;
  preferredGenres: string[];
  lastSessionStats?: SessionStats;
  heartRateHistory?: BPMReading[];
}

export interface SessionStats {
  startHeartRate: number;
  lowestHeartRate: number;
  duration: number; // seconds
  milestonesReached: number;
  date: string;
}

export interface BPMReading {
  value: number;
  timestamp: number;
}

export type HeartRateStatus = "normal" | "elevated" | "high" | "unknown";

export type SessionPhase = "idle" | "syncing" | "playing" | "slowing" | "completed";

export interface SessionState {
  phase: SessionPhase;
  currentHeartRate: number;
  currentSongBPM: number;
  peakHeartRate: number;
  startHeartRate: number;
  milestonesReached: number;
  startTime: number;
  isPlaying: boolean;
  message: string;
  currentSong: { title: string; bpm: number | null } | null;
}
