export interface UserProfile {
  normalBPM: number;
  tooFastBPM: number;
  preferredGenres: string[];
  lastSessionStats?: SessionStats;
  bpmHistory?: BPMReading[];
}

export interface SessionStats {
  startBPM: number;
  lowestBPM: number;
  duration: number; // seconds
  milestonesReached: number;
  date: string;
}

export interface BPMReading {
  value: number;
  timestamp: number;
}

export type HeartRateStatus = 'normal' | 'elevated' | 'high' | 'unknown';
