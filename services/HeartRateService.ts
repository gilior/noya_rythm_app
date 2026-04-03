/**
 * HeartRateService
 *
 * Provides BPM monitoring with a realistic simulator for development/demo.
 *
 * --- Production integration ---
 * iOS (HealthKit):  Use `react-native-health` (requires bare workflow + EAS build).
 *                   Replace `simulateReading()` body with a HealthKit query.
 * Android (Fit):    Use `react-native-google-fit` or Samsung Health SDK.
 *                   Replace `simulateReading()` body with the Fit polling call.
 *
 * The public API (onBPM / onStatusChange / startMonitoring / stopMonitoring)
 * is identical regardless of data source, so the rest of the app needs no changes.
 */

type BPMCallback = (bpm: number) => void;
type StatusCallback = (connected: boolean) => void;

const POLL_INTERVAL_MS = 6_000;
const SMOOTHING_WINDOW = 3;
const MAX_VALID_BPM = 200;
const MIN_VALID_BPM = 30;

class HeartRateService {
  private bpmListeners: Set<BPMCallback> = new Set();
  private statusListeners: Set<StatusCallback> = new Set();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private history: number[] = [];
  private connected = true;

  // Simulation state
  private simMode: "idle" | "session" = "idle";
  private currentSim = 72;
  private sessionStartHeartRate = 120;
  private sessionElapsedSec = 0;

  // ─── Public API ──────────────────────────────────────────────────────────────

  startMonitoring(mode: "idle" | "session" = "idle", startHeartRate?: number): void {
    this.simMode = mode;
    this.history = [];

    if (mode === "session" && startHeartRate != null) {
      this.sessionStartHeartRate = startHeartRate;
      this.currentSim = startHeartRate;
      this.sessionElapsedSec = 0;
      console.log(`[HR] startMonitoring  mode=session  startHR=${startHeartRate}  pollInterval=${POLL_INTERVAL_MS}ms`);
    } else {
      // Resting baseline 65–80
      this.currentSim = 65 + Math.random() * 15;
      console.log(
        `[HR] startMonitoring  mode=idle  baseline=${Math.round(this.currentSim)}  pollInterval=${POLL_INTERVAL_MS}ms`,
      );
    }

    if (this.intervalId) clearInterval(this.intervalId);
    // this.poll(); // immediate first reading
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`[HR] stopMonitoring  mode=${this.simMode}`);
    }
  }

  /** Inject a real BPM value from a native wearable layer */
  injectBPM(bpm: number): void {
    if (bpm >= MIN_VALID_BPM && bpm <= MAX_VALID_BPM) {
      this.currentSim = bpm;
      console.log(`[HR] injectBPM  bpm=${bpm}`);
      this.publish(bpm);
    } else {
      console.warn(`[HR] injectBPM rejected  bpm=${bpm}  (valid range: ${MIN_VALID_BPM}–${MAX_VALID_BPM})`);
    }
  }

  onBPM(cb: BPMCallback): () => void {
    this.bpmListeners.add(cb);
    return () => this.bpmListeners.delete(cb);
  }

  onStatusChange(cb: StatusCallback): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getCurrentBPM(): number {
    return Math.round(this.currentSim);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  private poll(): void {
    const raw = this.simulateReading();
    if (raw < MIN_VALID_BPM || raw > MAX_VALID_BPM) {
      console.warn(`[HR] poll  raw=${raw} out of valid range — discarded`);
      return;
    }

    this.history.push(raw);
    if (this.history.length > SMOOTHING_WINDOW) this.history.shift();

    const smoothed = Math.round(this.history.reduce((a, b) => a + b, 0) / this.history.length);
    console.log(
      `[HR] poll  raw=${raw}  smoothed=${smoothed}  history=[${this.history.join(", ")}]  mode=${this.simMode}${this.simMode === "session" ? `  elapsed=${Math.round(this.sessionElapsedSec)}s` : ""}`,
    );
    this.publish(smoothed);
  }

  private publish(bpm: number): void {
    this.bpmListeners.forEach((cb) => cb(bpm));
  }

  /**
   * Simulates realistic BPM readings.
   *
   * idle mode  – gentle random walk around a resting value (~68–80),
   *              with a rare spike above tooFastBPM for demo purposes.
   * session    – gradual decline from peak, simulating the calming effect.
   *              Drops ~40% over ~5 minutes with small noise.
   */
  private simulateReading(): number {
    if (this.simMode === "session") {
      this.sessionElapsedSec += POLL_INTERVAL_MS / 1_000;
      const progress = Math.min(this.sessionElapsedSec / 300, 1); // 300 s ≈ 5 min
      const drop = this.sessionStartHeartRate * 0.4 * progress;
      const noise = (Math.random() - 0.5) * 6;
      this.currentSim = Math.max(50, this.sessionStartHeartRate - drop + noise);
      console.log(
        `[HR] simulate  mode=session  elapsed=${Math.round(this.sessionElapsedSec)}s  progress=${(progress * 100).toFixed(0)}%  drop=${drop.toFixed(1)}  noise=${noise.toFixed(1)}  raw=${Math.round(this.currentSim)}`,
      );
    } else {
      const delta = (Math.random() - 0.5) * 4;
      this.currentSim = Math.max(55, Math.min(90, this.currentSim + delta));

      // ~5 % chance of a demonstrative spike so users can see the alert on Home
      if (Math.random() < 0.05) {
        this.currentSim = 105 + Math.random() * 30;
        console.log(`[HR] simulate  mode=idle  SPIKE  raw=${Math.round(this.currentSim)}`);
      } else {
        console.log(`[HR] simulate  mode=idle  delta=${delta.toFixed(1)}  raw=${Math.round(this.currentSim)}`);
      }
    }
    return Math.round(this.currentSim);
  }
}

// Singleton shared across the app
export const heartRateService = new HeartRateService();
