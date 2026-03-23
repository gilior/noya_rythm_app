import { router } from "expo-router";
import React, { useState } from "react";
import {
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { GENRES } from "../constants/genres";
import { Colors, Radius, Spacing } from "../constants/theme";
import { DEFAULT_PROFILE, useProfile } from "../contexts/ProfileContext";

const MAX_GENRES = 3;

export default function SetupScreen() {
  const { saveProfile } = useProfile();
  const [normalBPM, setNormalBPM] = useState(String(DEFAULT_PROFILE.normalBPM));
  const [tooFastBPM, setTooFastBPM] = useState(
    String(DEFAULT_PROFILE.tooFastBPM),
  );
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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
    const normal = parseInt(normalBPM, 10);
    const tooFast = parseInt(tooFastBPM, 10);

    if (isNaN(normal) || normal < 40 || normal > 120) {
      Alert.alert("Invalid value", "Normal BPM must be between 40 and 120.");
      return;
    }
    if (isNaN(tooFast) || tooFast <= normal || tooFast > 200) {
      Alert.alert(
        "Invalid value",
        '"Too fast" BPM must be above Normal BPM and ≤ 200.',
      );
      return;
    }
    if (selectedGenres.length === 0) {
      Alert.alert("Pick genres", "Please select at least one genre.");
      return;
    }

    setSaving(true);
    try {
      await saveProfile({
        normalBPM: normal,
        tooFastBPM: tooFast,
        preferredGenres: selectedGenres,
      });
      router.replace("/home" as any);
    } catch {
      Alert.alert("Error", "Could not save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{"Let's personalise\nyour experience"}</Text>
        <Text style={styles.subtitle}>
          {"We'll use this to detect when your heart rate is elevated."}
        </Text>

        {/* BPM Inputs */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Heart Rate Thresholds</Text>

          <View style={styles.inputRow}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Normal BPM</Text>
              <TextInput
                style={styles.input}
                value={normalBPM}
                onChangeText={setNormalBPM}
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
                value={tooFastBPM}
                onChangeText={setTooFastBPM}
                keyboardType="number-pad"
                maxLength={3}
                placeholderTextColor={Colors.textMuted}
                selectionColor={Colors.primary}
              />
            </View>
          </View>
        </View>

        {/* Genre selection */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>
            Preferred Genres{" "}
            <Text style={styles.genreCount}>
              ({selectedGenres.length}/{MAX_GENRES})
            </Text>
          </Text>
          <Text style={styles.genreHint}>Select up to 3</Text>
          <View style={styles.genreGrid}>
            {GENRES.map((genre) => {
              const selected = selectedGenres.includes(genre.id);
              return (
                <TouchableOpacity
                  key={genre.id}
                  style={[
                    styles.genreChip,
                    selected && styles.genreChipSelected,
                  ]}
                  onPress={() => toggleGenre(genre.id)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.genreEmoji}>{genre.emoji}</Text>
                  <Text
                    style={[
                      styles.genreLabel,
                      selected && styles.genreLabelSelected,
                    ]}
                  >
                    {genre.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          <Text style={styles.saveButtonText}>
            {saving ? "Saving…" : "Save & Continue"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Colors.background },
  container: {
    padding: Spacing.lg,
    paddingTop: 60,
    paddingBottom: 48,
    gap: Spacing.lg,
  },
  title: {
    fontSize: 30,
    fontWeight: "700",
    color: Colors.text,
    lineHeight: 38,
  },
  subtitle: {
    fontSize: 15,
    color: Colors.textMuted,
    marginTop: -Spacing.sm,
    lineHeight: 22,
  },
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
  inputRow: {
    flexDirection: "row",
    gap: Spacing.md,
  },
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
  genreHint: { fontSize: 13, color: Colors.textMuted, marginTop: -Spacing.sm },
  genreGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
  },
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
  saveButton: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: Radius.lg,
    alignItems: "center",
    marginTop: Spacing.sm,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { fontSize: 17, fontWeight: "700", color: Colors.text },
});
