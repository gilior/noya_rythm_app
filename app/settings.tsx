import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
    Alert,
    KeyboardAvoidingView,
    Platform,
    StatusBar as RNStatusBar,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { GENRES } from "../constants/genres";
import { Colors, Radius, Spacing } from "../constants/theme";
import { useProfile } from "../contexts/ProfileContext";

const MAX_GENRES = 3;

export default function SettingsScreen() {
  const { profile, updateProfile } = useProfile();
  const [normalHeartRate, setNormalHeartRate] = useState(String(profile?.normalHeartRate ?? 70));
  const [tooFastHeartRate, setTooFastHeartRate] = useState(String(profile?.tooFastHeartRate ?? 100));
  const [selectedGenres, setSelectedGenres] = useState<string[]>(profile?.preferredGenres ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync form if profile loads late
  useEffect(() => {
    if (profile) {
      setNormalHeartRate(String(profile.normalHeartRate));
      setTooFastHeartRate(String(profile.tooFastHeartRate));
      setSelectedGenres(profile.preferredGenres);
    }
  }, [profile]);

  const toggleGenre = (id: string) => {
    setSelectedGenres((prev) => {
      if (prev.includes(id)) return prev.filter((g) => g !== id);
      if (prev.length >= MAX_GENRES) {
        Alert.alert("Max genres", `You can select up to ${MAX_GENRES} genres.`);
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleSave = async () => {
    const normal = parseInt(normalHeartRate, 10);
    const tooFast = parseInt(tooFastHeartRate, 10);

    if (isNaN(normal) || normal < 40 || normal > 120) {
      Alert.alert("Invalid value", "Normal BPM must be between 40 and 120.");
      return;
    }
    if (isNaN(tooFast) || tooFast <= normal || tooFast > 200) {
      Alert.alert("Invalid value", '"Too fast" BPM must be above Normal BPM and ≤ 200.');
      return;
    }
    if (selectedGenres.length === 0) {
      Alert.alert("Pick genres", "Please select at least one genre.");
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        normalHeartRate: normal,
        tooFastHeartRate: tooFast,
        preferredGenres: selectedGenres,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      Alert.alert("Error", "Could not save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
              <Text style={styles.backText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Settings</Text>
            <View style={{ width: 56 }} />
          </View>

          {/* BPM Thresholds */}
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Heart Rate Thresholds</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Normal BPM</Text>
                <TextInput
                  style={styles.input}
                  value={normalHeartRate}
                  onChangeText={setNormalHeartRate}
                  keyboardType="number-pad"
                  maxLength={3}
                  placeholderTextColor={Colors.textMuted}
                  selectionColor={Colors.primary}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Too Fast BPM</Text>
                <TextInput
                  style={styles.input}
                  value={tooFastHeartRate}
                  onChangeText={setTooFastHeartRate}
                  keyboardType="number-pad"
                  maxLength={3}
                  placeholderTextColor={Colors.textMuted}
                  selectionColor={Colors.primary}
                />
              </View>
            </View>
          </View>

          {/* Genres */}
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>
              Preferred Genres{" "}
              <Text style={styles.genreCount}>
                ({selectedGenres.length}/{MAX_GENRES})
              </Text>
            </Text>
            <View style={styles.genreGrid}>
              {GENRES.map((genre) => {
                const selected = selectedGenres.includes(genre.id);
                return (
                  <TouchableOpacity
                    key={genre.id}
                    style={[styles.genreChip, selected && styles.genreChipSelected]}
                    onPress={() => toggleGenre(genre.id)}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.genreEmoji}>{genre.emoji}</Text>
                    <Text style={[styles.genreLabel, selected && styles.genreLabelSelected]}>{genre.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Last session */}
          {profile?.lastSessionStats && (
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>Last Session</Text>
              <View style={styles.lastSessionRow}>
                <LastStat label="Start" value={`${profile.lastSessionStats.startHeartRate} bpm`} />
                <LastStat label="Lowest" value={`${profile.lastSessionStats.lowestHeartRate} bpm`} />
                <LastStat label="Duration" value={formatDuration(profile.lastSessionStats.duration)} />
                <LastStat label="Milestones" value={String(profile.lastSessionStats.milestonesReached)} />
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[styles.saveButton, (saving || saved) && styles.saveButtonAlt]}
            onPress={handleSave}
            disabled={saving || saved}
            activeOpacity={0.8}
          >
            <Text style={styles.saveButtonText}>{saved ? "✓ Saved" : saving ? "Saving…" : "Save Settings"}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function LastStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.lastStat}>
      <Text style={styles.lastStatLabel}>{label}</Text>
      <Text style={styles.lastStatValue}>{value}</Text>
    </View>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingTop: Platform.OS === "android" ? RNStatusBar.currentHeight : 0,
  },
  flex: { flex: 1 },
  container: {
    padding: Spacing.lg,
    paddingBottom: 48,
    gap: Spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Spacing.sm,
  },
  backText: { fontSize: 15, color: Colors.primary, fontWeight: "600" },
  title: { fontSize: 20, fontWeight: "700", color: Colors.text },
  card: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  inputRow: { flexDirection: "row", gap: Spacing.md },
  inputGroup: { flex: 1, gap: Spacing.xs },
  inputLabel: { fontSize: 14, color: Colors.textMuted },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: Spacing.sm,
  },
  genreCount: { color: Colors.primary, fontWeight: "700" },
  genreGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  genreChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: Radius.full,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  genreChipSelected: {
    borderColor: Colors.primary,
    backgroundColor: `${Colors.primary}22`,
  },
  genreEmoji: { fontSize: 16 },
  genreLabel: { fontSize: 14, color: Colors.textMuted, fontWeight: "500" },
  genreLabelSelected: { color: Colors.primaryLight },
  lastSessionRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  lastStat: { flex: 1, minWidth: "44%", alignItems: "center", gap: 2 },
  lastStatLabel: {
    fontSize: 11,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  lastStatValue: { fontSize: 16, color: Colors.text, fontWeight: "700" },
  saveButton: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.lg,
    alignItems: "center",
  },
  saveButtonAlt: { backgroundColor: Colors.success },
  saveButtonText: { fontSize: 17, fontWeight: "700", color: Colors.text },
});
