import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Colors } from "../constants/theme";
import { CatalogProvider } from "../contexts/CatalogContext";
import { ProfileProvider } from "../contexts/ProfileContext";

export default function RootLayout() {
  return (
    <ProfileProvider>
      <CatalogProvider>
        {" "}
        {/* ← add here */}
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Colors.background },
            animation: "fade",
          }}
        />
      </CatalogProvider>
    </ProfileProvider>
  );
}
