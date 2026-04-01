import { useEffect, useState } from "react";
import { heartRateService } from "../services/HeartRateService";

/**
 * Subscribes to the HeartRateService.
 *
 * @param mode     'idle' for the Home screen, 'session' for the Session screen
 * @param startBPM Initial BPM for session simulation
 */
export function useHeartRate(mode: "idle" | "session" = "idle", startHeartRate?: number) {
  const [heartRate, setHeartRate] = useState<number>(heartRateService.getCurrentBPM());
  const [connected, setConnected] = useState(heartRateService.isConnected());

  useEffect(() => {
    heartRateService.startMonitoring(mode, startHeartRate);
    const unsubBpm = heartRateService.onBPM(setHeartRate);
    const unsubStatus = heartRateService.onStatusChange(setConnected);

    return () => {
      unsubBpm();
      unsubStatus();
      heartRateService.stopMonitoring();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { heartRate, connected };
}
