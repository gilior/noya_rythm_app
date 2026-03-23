import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Colors } from "../constants/theme";
import { useProfile } from "../contexts/ProfileContext";

export default function Index() {
  const { profile, isLoading } = useProfile();

  useEffect(() => {
    if (!isLoading) {
      router.replace((profile ? "/home" : "/setup") as any);
    }
  }, [isLoading, profile]);

  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: Colors.background,
      }}
    >
      <ActivityIndicator color={Colors.primary} size="large" />
    </View>
  );
}
