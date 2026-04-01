import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  StatusBar as RNStatusBar,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Colors, Radius, Spacing } from "../constants/theme";
import { useProfile } from "../contexts/ProfileContext";
import { useHeartRate } from "../hooks/useHeartRate";
import { useMusicSession } from "../hooks/useMusicSession";
import { musicService } from "../services/MusicService";

export default function SessionScreen() {
  const { startHeartRate: startHeartRateParam } = useLocalSearchParams<{
    startHeartRate: string;
  }>();
  const startHeartRate = parseInt(startHeartRateParam ?? "120", 10);
  console.log(`[Session] startHeartRateParam (raw): ${startHeartRateParam} | parsed: ${startHeartRate}`);
  const { profile, saveSessionStats } = useProfile();
  const { heartRate } = useHeartRate("session", startHeartRate);
  const sessionState = useMusicSession();

  const [completionVisible, setCompletionVisible] = useState(false);
  const completedRef = useRef(false);

  // Start the music session on mount
  useEffect(() => {
    musicService.startSession(startHeartRate);
    return () => {
      // Clean up if user navigates away without ending session
      musicService.endSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed new heart-rate readings into the music service
  useEffect(() => {
    if (heartRate > 0) {
      musicService.updateSongBpmPerNewHeartRate(heartRate);
    }
  }, [heartRate]);

  // Check completion
  useEffect(() => {
    if (!profile || completedRef.current) return;
    if (sessionState.peakHeartRate > profile.normalHeartRate && musicService.checkCompletion(profile.normalHeartRate)) {
      completedRef.current = true;
      musicService.completeSession();
      setCompletionVisible(true);
    }
  }, [heartRate, profile, sessionState.peakHeartRate]);

  // BPM bar animation (progress toward normal)
  const progressAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!profile || startHeartRate === 0) return;
    const reference = Math.max(startHeartRate, sessionState.peakHeartRate);
    const progress =
      reference <= profile.normalHeartRate
        ? 0
        : Math.min(1, Math.max(0, (reference - heartRate) / (reference - profile.normalHeartRate)));
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [heartRate, profile, startHeartRate, sessionState.peakHeartRate, progressAnim]);

  const handleContinue = () => {
    setCompletionVisible(false);
    musicService.continuePlaying();
  };

  const handleEnd = async () => {
    setCompletionVisible(false);
    const stats = musicService.endSession();
    await saveSessionStats({
      startHeartRate: stats.startHeartRate,
      lowestHeartRate: stats.lowestHeartRate,
      duration: stats.duration,
      milestonesReached: stats.milestonesReached,
      date: new Date().toISOString(),
    });
    router.replace({
      pathname: "/summary" as any,
      params: {
        startHeartRate: String(stats.startHeartRate),
        lowestHeartRate: String(stats.lowestHeartRate),
        duration: String(stats.duration),
        milestones: String(stats.milestonesReached),
      },
    });
  };

  const handleExitManual = async () => {
    const stats = musicService.endSession();
    await saveSessionStats({
      startHeartRate: stats.startHeartRate,
      lowestHeartRate: stats.lowestHeartRate,
      duration: stats.duration,
      milestonesReached: stats.milestonesReached,
      date: new Date().toISOString(),
    });
    router.replace({
      pathname: "/summary" as any,
      params: {
        startHeartRate: String(stats.startHeartRate),
        lowestHeartRate: String(stats.lowestHeartRate),
        duration: String(stats.duration),
        milestones: String(stats.milestonesReached),
      },
    });
  };

  const phaseLabel: Record<string, string> = {
    syncing: "Syncing…",
    playing: "In sync ♫",
    slowing: "Slowing down ↓",
    completed: "Complete ✓",
    idle: "",
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleExitManual} activeOpacity={0.7}>
            <Text style={styles.exitText}>✕ End</Text>
          </TouchableOpacity>
          <Text style={styles.phaseLabel}>{phaseLabel[sessionState.phase] ?? ""}</Text>
        </View>

        {/* Message */}
        <View style={styles.messageCard}>
          <Text style={styles.messageText}>{sessionState.message}</Text>
        </View>

        {/* BPM comparison */}
        <View style={styles.bpmRow}>
          <BPMBlock label="Your Heart" value={heartRate} color={Colors.accent} large />
          <View style={styles.bpmDivider} />
          <BPMBlock
            label="Music"
            value={sessionState.currentSongBPM > 0 ? sessionState.currentSongBPM : "—"}
            color={Colors.primaryLight}
            large
          />
        </View>

        {/* Progress bar */}
        <View style={styles.progressSection}>
          <View style={styles.progressLabelRow}>
            <Text style={styles.progressLabel}>Progress to normal</Text>
            <Text style={styles.progressLabel}>Target: {profile?.normalHeartRate ?? "—"} BPM</Text>
          </View>
          <View style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0%", "100%"],
                  }),
                },
              ]}
            />
          </View>
        </View>

        {/* Milestones */}
        <View style={styles.milestoneRow}>
          <Text style={styles.milestoneText}>🏅 Milestones reached: {sessionState.milestonesReached}</Text>
        </View>

        {/* Now Playing */}
        {sessionState.currentSong && (
          <View style={styles.nowPlayingRow}>
            <Text style={styles.nowPlayingText} numberOfLines={1}>
              ♪ {sessionState.currentSong.title}
              {sessionState.currentSong.bpm != null ? `  ·  ${sessionState.currentSong.bpm} BPM` : ""}
            </Text>
          </View>
        )}

        {/* Playback controls */}
        <View style={styles.controls}>
          <ControlButton
            label="⏮"
            onPress={() => musicService.skipLoop()}
            disabled={sessionState.phase === "idle" || sessionState.phase === "completed"}
          />
          <ControlButton
            label={sessionState.isPlaying ? "⏸" : "▶"}
            onPress={() => musicService.togglePlayback()}
            primary
            disabled={sessionState.phase === "idle" || sessionState.phase === "syncing"}
          />
          <ControlButton
            label="⏭"
            onPress={() => musicService.skipLoop()}
            disabled={sessionState.phase === "idle" || sessionState.phase === "completed"}
          />
        </View>
      </View>

      {/* Completion Modal */}
      <Modal visible={completionVisible} transparent animationType="slide" statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🎉 Well done!</Text>
            <Text style={styles.modalBody}>
              Your heart rate is back to normal.{"\n"}
              Current BPM: <Text style={styles.modalBpm}>{heartRate}</Text>
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalBtnSecondary} onPress={handleContinue} activeOpacity={0.7}>
                <Text style={styles.modalBtnSecondaryText}>Continue ♫</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnPrimary} onPress={handleEnd} activeOpacity={0.8}>
                <Text style={styles.modalBtnPrimaryText}>View Summary</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function BPMBlock({
  label,
  value,
  color,
  large,
}: {
  label: string;
  value: number | string;
  color: string;
  large?: boolean;
}) {
  return (
    <View style={styles.bpmBlock}>
      <Text style={styles.bpmBlockLabel}>{label}</Text>
      <Text style={[styles.bpmBlockValue, large && styles.bpmBlockValueLarge, { color }]}>{value}</Text>
      <Text style={styles.bpmBlockUnit}>BPM</Text>
    </View>
  );
}

function ControlButton({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.ctrlBtn, primary && styles.ctrlBtnPrimary, disabled && styles.ctrlBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
    >
      <Text style={[styles.ctrlBtnIcon, primary && styles.ctrlBtnIconPrimary]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingTop: Platform.OS === "android" ? RNStatusBar.currentHeight : 0,
  },
  container: {
    flex: 1,
    padding: Spacing.lg,
    gap: Spacing.lg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  exitText: { color: Colors.textMuted, fontSize: 15, fontWeight: "600" },
  phaseLabel: { color: Colors.primary, fontSize: 14, fontWeight: "700" },
  messageCard: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 72,
    justifyContent: "center",
  },
  messageText: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 24,
  },
  bpmRow: {
    flexDirection: "row",
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  bpmDivider: { width: 1, backgroundColor: Colors.border },
  bpmBlock: {
    flex: 1,
    alignItems: "center",
    paddingVertical: Spacing.xl,
    gap: 2,
  },
  bpmBlockLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  bpmBlockValue: { fontSize: 36, fontWeight: "800" },
  bpmBlockValueLarge: { fontSize: 48 },
  bpmBlockUnit: { fontSize: 13, color: Colors.textMuted },
  progressSection: { gap: Spacing.sm },
  progressLabelRow: { flexDirection: "row", justifyContent: "space-between" },
  progressLabel: { fontSize: 13, color: Colors.textMuted },
  progressTrack: {
    height: 10,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: Radius.full,
    backgroundColor: Colors.success,
  },
  nowPlayingRow: {
    alignItems: "center",
    paddingHorizontal: Spacing.md,
  },
  nowPlayingText: {
    fontSize: 13,
    color: Colors.textMuted,
    fontStyle: "italic",
  },
  milestoneRow: {
    alignItems: "center",
  },
  milestoneText: { fontSize: 15, color: Colors.textMuted, fontWeight: "500" },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: Spacing.md,
    marginTop: "auto",
  },
  ctrlBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  ctrlBtnPrimary: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  ctrlBtnDisabled: { opacity: 0.35 },
  ctrlBtnIcon: { fontSize: 20, color: Colors.textMuted },
  ctrlBtnIconPrimary: { color: Colors.text, fontSize: 24 },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: "flex-end",
    padding: Spacing.lg,
    paddingBottom: 48,
  },
  modalCard: {
    backgroundColor: Colors.card,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modalTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  modalBody: {
    fontSize: 16,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 24,
  },
  modalBpm: { color: Colors.success, fontWeight: "800" },
  modalButtons: { flexDirection: "row", gap: Spacing.md },
  modalBtnSecondary: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  modalBtnSecondaryText: {
    color: Colors.textMuted,
    fontWeight: "600",
    fontSize: 15,
  },
  modalBtnPrimary: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radius.lg,
    alignItems: "center",
    backgroundColor: Colors.success,
  },
  modalBtnPrimaryText: { color: "#000", fontWeight: "700", fontSize: 15 },
});
