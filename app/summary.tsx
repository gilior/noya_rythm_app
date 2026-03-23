import { router, useLocalSearchParams } from "expo-router";
import React from "react";
import {
    Platform,
    StatusBar as RNStatusBar,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { Colors, Radius, Spacing } from "../constants/theme";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function SummaryScreen() {
  const { startBPM, lowestBPM, duration, milestones } = useLocalSearchParams<{
    startBPM: string;
    lowestBPM: string;
    duration: string;
    milestones: string;
  }>();

  const start = parseInt(startBPM ?? "0", 10);
  const lowest = parseInt(lowestBPM ?? "0", 10);
  const dur = parseInt(duration ?? "0", 10);
  const miles = parseInt(milestones ?? "0", 10);
  const dropPct = start > 0 ? Math.round(((start - lowest) / start) * 100) : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.emoji}>🎉</Text>
        <Text style={styles.title}>Session Complete</Text>
        <Text style={styles.subtitle}>
          {dropPct >= 20
            ? "Outstanding work! Your heart noticeably calmed down."
            : dropPct >= 10
              ? "Good effort! Every bit of relaxation counts."
              : "Well done for taking the time to calm down."}
        </Text>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <StatCard
            label="Start BPM"
            value={start}
            unit="bpm"
            color={Colors.danger}
          />
          <StatCard
            label="Lowest BPM"
            value={lowest}
            unit="bpm"
            color={Colors.success}
          />
          <StatCard
            label="Duration"
            value={formatDuration(dur)}
            color={Colors.primaryLight}
          />
          <StatCard
            label="Milestones"
            value={miles}
            unit={miles === 1 ? "reached" : "reached"}
            color={Colors.warning}
          />
        </View>

        {/* Drop highlight */}
        {dropPct > 0 && (
          <View style={styles.dropCard}>
            <Text style={styles.dropLabel}>Heart rate reduced by</Text>
            <Text style={styles.dropValue}>{dropPct}%</Text>
            <Text style={styles.dropSub}>
              {start} → {lowest} BPM
            </Text>
          </View>
        )}

        {/* Milestone badges */}
        {miles > 0 && (
          <View style={styles.badgeRow}>
            {Array.from({ length: miles }).map((_, i) => (
              <View key={i} style={styles.badge}>
                <Text style={styles.badgeText}>🏅 {(i + 1) * 10}% drop</Text>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.homeBtn}
          onPress={() => router.replace("/home" as any)}
          activeOpacity={0.8}
        >
          <Text style={styles.homeBtnText}>Back to Home</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: number | string;
  unit?: string;
  color: string;
}) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
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
    padding: Spacing.lg,
    paddingTop: Spacing.xl,
    paddingBottom: 48,
    alignItems: "center",
    gap: Spacing.lg,
  },
  emoji: { fontSize: 56 },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 300,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.md,
    width: "100%",
  },
  statCard: {
    flex: 1,
    minWidth: "44%",
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  statLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    fontWeight: "600",
  },
  statValue: { fontSize: 28, fontWeight: "800" },
  statUnit: { fontSize: 14, fontWeight: "400" },
  dropCard: {
    backgroundColor: `${Colors.success}18`,
    borderRadius: Radius.lg,
    padding: Spacing.xl,
    alignItems: "center",
    width: "100%",
    borderWidth: 1,
    borderColor: `${Colors.success}44`,
    gap: Spacing.xs,
  },
  dropLabel: { fontSize: 13, color: Colors.textMuted, fontWeight: "600" },
  dropValue: { fontSize: 56, fontWeight: "800", color: Colors.success },
  dropSub: { fontSize: 14, color: Colors.textMuted },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    justifyContent: "center",
  },
  badge: {
    backgroundColor: `${Colors.warning}22`,
    borderRadius: Radius.full,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
  },
  badgeText: { color: Colors.warning, fontSize: 13, fontWeight: "600" },
  homeBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.lg,
    alignItems: "center",
    width: "100%",
    marginTop: Spacing.sm,
  },
  homeBtnText: { fontSize: 17, fontWeight: "700", color: Colors.text },
});
