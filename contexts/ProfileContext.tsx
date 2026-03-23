import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";
import { SessionStats, UserProfile } from "../types";

const PROFILE_KEY = "@noya_profile";

export const DEFAULT_PROFILE: UserProfile = {
  normalBPM: 70,
  tooFastBPM: 100,
  preferredGenres: [],
};

interface ProfileContextValue {
  profile: UserProfile | null;
  isLoading: boolean;
  saveProfile: (profile: UserProfile) => Promise<void>;
  updateProfile: (partial: Partial<UserProfile>) => Promise<void>;
  saveSessionStats: (stats: SessionStats) => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(PROFILE_KEY)
      .then((stored) => {
        if (stored) setProfile(JSON.parse(stored));
      })
      .catch((e) => console.error("Failed to load profile:", e))
      .finally(() => setIsLoading(false));
  }, []);

  const saveProfile = useCallback(async (newProfile: UserProfile) => {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(newProfile));
    setProfile(newProfile);
  }, []);

  const updateProfile = useCallback(
    async (partial: Partial<UserProfile>) => {
      const updated = { ...(profile ?? DEFAULT_PROFILE), ...partial };
      await saveProfile(updated);
    },
    [profile, saveProfile],
  );

  const saveSessionStats = useCallback(
    async (stats: SessionStats) => {
      if (!profile) return;
      const updated: UserProfile = {
        ...profile,
        lastSessionStats: stats,
        bpmHistory: [
          ...(profile.bpmHistory ?? []).slice(-99),
          { value: stats.startBPM, timestamp: Date.now() },
        ],
      };
      await saveProfile(updated);
    },
    [profile, saveProfile],
  );

  return (
    <ProfileContext.Provider
      value={{
        profile,
        isLoading,
        saveProfile,
        updateProfile,
        saveSessionStats,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within ProfileProvider");
  return ctx;
}
