import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Colors } from "../constants/theme";
import { ProfileProvider } from "../contexts/ProfileContext";

export default function RootLayout() {
  return (
    <ProfileProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.background },
          animation: "fade",
        }}
      />
    </ProfileProvider>
  );
}
