import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Colors } from "../constants/theme";
import { useCatalog } from "../contexts/CatalogContext"; // ← add
import { useProfile } from "../contexts/ProfileContext";

export default function Index() {
  const { profile, isLoading } = useProfile();
  const { isReady } = useCatalog(); // ← add

  useEffect(() => {
    if (!isLoading && isReady) {
      router.replace((profile ? "/home" : "/setup") as any);
    }
  }, [isLoading, profile, isReady]);

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
