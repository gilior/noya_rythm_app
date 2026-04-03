## **Terminology**

To avoid ambiguity, this spec uses these terms consistently throughout:

| Term           | Definition                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **Heart rate** | The user's cardiac rhythm, measured in beats per minute. Comes from a wearable or device health API. |
| **Song tempo** | The musical pace of a track or loop, measured in beats per minute. Controlled by the Music Service.  |

---

## **Overview**

A mobile app (Expo / React Native) that helps users with atrial fibrillation **calm their heart rate using music synchronized to their heartbeat**.

**Core flow:**

- Read heart rate from wearable device
- Detect high heart rate
- Start music session with song tempo synchronized to heart rate
- Gradually slow heart rate by reducing song tempo using adaptive music
- Provide feedback and encouragement

**Important constraint:**

- The app **must be running (foreground or background)** to monitor heart rate
- Fully closed app **cannot trigger sessions (especially on iOS)**

---

## **User Model (NO AUTHENTICATION)**

### **Local User Profile**

The app supports a **single local user profile stored on device**.

**Profile fields:**

- `normalHeartRate` (default: 70) — heart rate threshold considered normal
- `tooFastHeartRate` (default: 100) — heart rate threshold that triggers a calming session
- `preferredGenres` (array, max 3)
- Optional:
  - `lastSessionStats`
  - `heartRateHistory`

**Storage:**

- Use local storage (AsyncStorage or SecureStore)
- Load on app start
- Persist on every update

---

## **App Launch Flow**

```text
App Launch
   ↓
Load local profile
   ↓
IF profile does not exist → Setup Screen
IF profile exists → Home Screen
```

---

## **UI / Screens**

### **1. Setup Screen (First-Time Use)**

Purpose: create local user profile

**UI Elements:**

- Title: “Let’s personalize your experience”
- Input:
  - Normal heart rate (default: 70)
  - Too fast heart rate (default: 100)

- Multi-select genres (max 3)
- Button: “Save & Continue”

**Behavior:**

- Save profile locally
- Navigate to Home Screen

---

### **2. Home Screen (Heart Rate Monitor)**

Purpose: monitor heart rate continuously

**UI Elements:**

- Current heart rate display (always visible)
- Optional calming animation
- Button: "Start Session" (manual trigger)
- Button: "Settings"

**Behavior:**

- Start heart rate monitoring on mount
- Poll heart rate every 5–10 seconds
- If heart rate > `tooFastHeartRate`:
  - Show alert:
    - “Your heart rate is high. Start calming session?”
    - Yes → navigate to Music Session
    - No → dismiss

---

### **3. Music Session Screen**

Purpose: synchronize and slow heart rate using music

**UI Elements:**

- Message area:
  - “Your heart and music are now in sync”
  - “Let’s try to slow your heart”

- Current heart rate display
- Current song tempo display
- Playback controls: Play / Pause / Skip
- Progress indicator

---

## **Music Behavior (Core Logic)**

### **Loop Strategy**

- Songs are played sequentially, transitioning at natural end points
- Always crossfade between songs

### **Hybrid Music Source**

All music comes from a **pre-catalogued library of audio files**. Each song in the catalog has:

- `id` — unique identifier
- `genre` — music genre (e.g., ambient, lofi, classical)
- `title` — song name
- `channel` — source channel name
- `songTempo` — the song's tempo in beats per minute
- `audioUrl` — URL to the hosted audio file

Songs are selected from this catalog by matching `songTempo` to the target range and filtering by the user's `preferredGenres`.

---

## **Synchronization Logic**

### **Step 1 – Sync Phase**

Target song tempo = 95–100% of current heart rate. This phase runs from session start until sync is confirmed (heart rate has begun to slow).

**Initial song selection:**

- Read current heart rate (e.g., 150)
- Select a song from the catalog whose song tempo falls within 95%–100% of the current heart rate
  - Example: for heart rate of 150 → select a song with song tempo 143–150
  - Rounding rule: lower bound (95% of HR) rounds **up** (\Math.ceil\) if not an integer
- Song tempo must **never exceed** the current heart rate — no song faster than the user’s heart may be played
- If no exact match exists, select the closest available song tempo in the catalog
- Start playback

**Ongoing adaptation (every song end or every 2 minutes):**

#### Case A: Heart rate change < 5%

- Do **not** switch songs — adapt the current song’s playback speed to match the new target tempo (tempo-stretch within ±5% of the song’s native BPM)

#### Case B: Heart rate change ≥ 5%

- Select a new song from the catalog at the updated target song tempo range (95%–100% of the new heart rate)

**Transition to Step 2:** Once synchronization is confirmed and heart rate has begun to slow, show the message “Your heart and music are now in sync — let’s try to slow your heart” and enter **Step 2**.

---

### **Step 2 – Slow Down Phase**

Entered after sync is confirmed. Target song tempo = 90%–95% of current heart rate. This phase runs until heart rate reaches ormalHeartRate\.

**Initial song selection:**

- Select a song from the catalog at 90%–95% of the current (now lower) heart rate
  - Example: for heart rate of 150 → select a song with song tempo 135–142
  - Rounding rules:
    - Lower bound (90% of HR) → round **up** (\Math.ceil\) if not an integer
    - Upper bound (95% of HR) → round **down** (\Math.floor\) if not an integer

**Ongoing adaptation (every song end or every 2 minutes):**

#### Case A: Heart rate change < 5%

- Do **not** switch songs — adapt the current song’s playback speed to stay within the 90%–95% target range

#### Case B: Heart rate change ≥ 5%

- Select a new song from the catalog at 90%–95% of the updated heart rate

**Re-sync:** If heart rate has slowed further and sync is re-confirmed, repeat Step 2 targeting 90%–95% of the new (lower) heart rate.

---

### **Step 3 – Feedback**

- Every 10% drop in heart rate from peak heart rate:
  - Show message:
    - “Great job! Your heart slowed by 10%”

---

### **Step 4 – Completion**

If heart rate ≤ ormalHeartRate\:

- Show popup:
  - “Well done. Your heart rate is back to normal”

- Options:
  - Continue → play a calming song from the catalog with song tempo ≤ \min(normalHeartRate, 80)  - Exit → go to Summary
---

## **4. Summary Screen**

**Displays:**

- Start heart rate
- Lowest heart rate reached
- Session duration
- Number of milestones reached

---

## **5. Settings Screen**

**Editable fields:**

- Normal heart rate (`normalHeartRate`)
- Too fast heart rate (`tooFastHeartRate`)
- Genres

**Behavior:**

- Update local profile
- Persist immediately

---

## **Heart Rate Service**

### Responsibilities:

- Connect to device API (HealthKit / Google Fit / wearable SDK)
- Poll heart rate every 5–10 seconds
- Smooth small heart rate fluctuations
- Ignore extreme heart rate spikes (above 200 beats per minute)

**Important:**

- Works only if app is running
- Must handle:
  - Device disconnect
  - Missing data

---

## **Music Service**

### Responsibilities:

- Select songs from the catalog based on current heart rate and user's preferred genres
- Handle:
  - Adjusting playback speed of the current song by up to ±5% to adapt tempo without switching tracks (for heart rate change < 5%)
  - Selecting a new song at a lower song tempo range (heart rate change ≥5%)

- Enforce that no selected song tempo ever exceeds the user's current heart rate
- Crossfade transitions between songs
- Track which songs have already been played to avoid immediate repeats

---

## **Notifications / Alerts**

- High heart rate alert (Home screen)
- Sync message (session start)
- Encouragement messages (every 10% heart rate drop from peak)
- Completion message

---

## **Edge Cases**

- Device disconnected → pause session + notify
- No song available at the target song tempo range → fallback to the nearest available song tempo in the catalog; if none, play a calming song with song tempo ≤80
- App closed → no heart rate monitoring (user must reopen)
- Sudden heart rate spikes → show warning

---

## **Platform Constraints**

### iOS:

- Cannot monitor heart rate if app is fully closed
- Background heart rate monitoring limited (HealthKit / workouts)

### Android:

- Can use foreground service
- Still stoppable by user

---

## **Final Flow (Simplified)**

```text
App Launch
   ↓
Load Profile
   ↓
Setup (if first time) → Home
   ↓
Monitor heart rate
   ↓
High heart rate detected
   ↓
Prompt user → Start Session
   ↓
Sync song tempo to heart rate
   ↓
Adapt music continuously
   ↓
Gradually slow song tempo
   ↓
Normal heart rate reached
   ↓
Continue or End → Summary
```
