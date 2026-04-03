import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
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

export default function HomeScreen() {
  const { profile } = useProfile();
  const { heartRate, connected } = useHeartRate("idle");
  const [alertVisible, setAlertVisible] = useState(false);
  const alertShownRef = useRef(false);
  const isFocused = useIsFocused();

  // Pulse animation synced to BPM
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (pulseRef.current) pulseRef.current.stop();
    const interval = heartRate > 0 ? (60 / heartRate) * 1000 : 1000;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.18,
          duration: interval * 0.35,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: interval * 0.65,
          useNativeDriver: true,
        }),
      ]),
    );
    pulseRef.current = animation;
    animation.start();
    return () => animation.stop();
  }, [heartRate, pulseAnim]);

  // Trigger high-BPM alert (once per spike, only when this screen is in the foreground)
  useEffect(() => {
    if (!profile || !isFocused) return;
    if (heartRate > profile.tooFastHeartRate && !alertShownRef.current) {
      alertShownRef.current = true;
      setAlertVisible(true);
    }
    if (heartRate <= profile.tooFastHeartRate) {
      alertShownRef.current = false;
      setAlertVisible(false);
    }
  }, [heartRate, profile, isFocused]);

  // Dismiss any stale alert when the session screen is pushed on top
  useEffect(() => {
    if (!isFocused) {
      setAlertVisible(false);
      alertShownRef.current = false;
    }
  }, [isFocused]);

  const bpmColor =
    !profile || heartRate === 0
      ? Colors.textMuted
      : heartRate > profile.tooFastHeartRate
        ? Colors.danger
        : heartRate > profile.normalHeartRate
          ? Colors.warning
          : Colors.success;

  const statusText =
    !profile || heartRate === 0
      ? "Connecting…"
      : heartRate > profile.tooFastHeartRate
        ? "Heart rate elevated"
        : heartRate > profile.normalHeartRate
          ? "Slightly elevated"
          : "Heart rate normal";

  const startSession = () => {
    setAlertVisible(false);
    router.push({
      pathname: "/session" as any,
      params: { startHeartRate: String(heartRate) },
    });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.appName}>Noya Rhythm</Text>
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => router.push("/settings" as any)}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsIcon}>⚙️</Text>
          </TouchableOpacity>
        </View>

        {/* Connection indicator */}
        {!connected && (
          <View style={styles.disconnectedBanner}>
            <Text style={styles.disconnectedText}>⚠️ Wearable disconnected</Text>
          </View>
        )}

        {/* BPM Display */}
        <View style={styles.bpmSection}>
          <Animated.View style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]} />
          <View style={styles.bpmCard}>
            <Text style={[styles.bpmValue, { color: bpmColor }]}>{heartRate > 0 ? heartRate : "—"}</Text>
            <Text style={styles.bpmUnit}>BPM</Text>
          </View>
        </View>

        <Text style={[styles.statusText, { color: bpmColor }]}>{statusText}</Text>

        {/* Thresholds */}
        {profile && (
          <View style={styles.thresholdRow}>
            <ThresholdPill label="Normal" value={profile.normalHeartRate} color={Colors.success} />
            <ThresholdPill label="Alert" value={profile.tooFastHeartRate} color={Colors.danger} />
          </View>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.startBtn} onPress={startSession} activeOpacity={0.8}>
            <Text style={styles.startBtnText}>Start Session</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.monitoringNote}>Monitoring every 6 s · App must stay open</Text>
      </View>

      {/* High BPM Alert Modal */}
      <Modal visible={alertVisible} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>❤️ Heart Rate Alert</Text>
            <Text style={styles.modalBpm}>{heartRate} BPM</Text>
            <Text style={styles.modalBody}>
              Your heart rate is above your alert threshold ({profile?.tooFastHeartRate} BPM).
              {"\n\n"}Start a calming music session?
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalBtnSecondary}
                onPress={() => setAlertVisible(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.modalBtnSecondaryText}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnPrimary} onPress={startSession} activeOpacity={0.8}>
                <Text style={styles.modalBtnPrimaryText}>Start Session</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ThresholdPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillLabel, { color }]}>{label}</Text>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
    </View>
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
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    alignItems: "center",
    gap: Spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingTop: Spacing.lg,
  },
  appName: { fontSize: 20, fontWeight: "700", color: Colors.text },
  settingsBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsIcon: { fontSize: 22 },
  disconnectedBanner: {
    backgroundColor: `${Colors.warning}22`,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    width: "100%",
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.warning,
  },
  disconnectedText: { color: Colors.warning, fontSize: 13, fontWeight: "600" },
  bpmSection: {
    marginTop: Spacing.xl,
    width: 220,
    height: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  pulseRing: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: `${Colors.accent}18`,
    borderWidth: 2,
    borderColor: `${Colors.accent}40`,
  },
  bpmCard: {
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: Colors.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.border,
  },
  bpmValue: { fontSize: 60, fontWeight: "800", lineHeight: 68 },
  bpmUnit: {
    fontSize: 16,
    color: Colors.textMuted,
    fontWeight: "600",
    marginTop: -4,
  },
  statusText: { fontSize: 16, fontWeight: "600" },
  thresholdRow: {
    flexDirection: "row",
    gap: Spacing.md,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1.5,
    backgroundColor: Colors.surface,
  },
  pillLabel: { fontSize: 13, fontWeight: "600" },
  pillValue: { fontSize: 15, fontWeight: "700" },
  actions: { flex: 1, justifyContent: "flex-end", width: "100%" },
  startBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.lg,
    alignItems: "center",
  },
  startBtnText: { fontSize: 17, fontWeight: "700", color: Colors.text },
  monitoringNote: {
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: "center",
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.lg,
  },
  modalCard: {
    backgroundColor: Colors.card,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.md,
  },
  modalTitle: { fontSize: 20, fontWeight: "700", color: Colors.text },
  modalBpm: { fontSize: 48, fontWeight: "800", color: Colors.danger },
  modalBody: {
    fontSize: 15,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 22,
  },
  modalButtons: {
    flexDirection: "row",
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
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
    backgroundColor: Colors.primary,
  },
  modalBtnPrimaryText: { color: Colors.text, fontWeight: "700", fontSize: 15 },
});
