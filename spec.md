## **Terminology**

To avoid ambiguity, this spec uses these terms consistently throughout:

| Term           | Definition                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Heart rate** | The user's cardiac rhythm, measured in beats per minute. Comes from a wearable or device health API.                   |
| **Song tempo** | The musical pace of a track or loop, measured in beats per minute. Controlled by the Music Service.                    |

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

- Use **short loops (30–60 seconds)**
- Always crossfade between loops

### **Hybrid Music Source**

1. Pre-generated loops:
   - Song tempo range: 70–100
   - Stored locally

2. AI-generated loops:
   - For song tempos outside that range
   - Generated on demand

---

## **Synchronization Logic**

### **Step 1 – Initial Sync**

- Read current heart rate (e.g., 150)
- Select a loop whose song tempo falls within 95%–100% of the current heart rate
  - Example: for heart rate of 150 → select song tempo 143–150

- Start playback

---

### **Step 2 – Continuous Adaptation**

Every loop end or every 2 minutes:

#### Case A: Heart rate change < 5%

- Adjust song tempo of current loop slightly

#### Case B: Heart rate change ≥ 5%

- Generate/select a new loop at the new target song tempo range

---

### **Step 3 – Slow Down Phase**

After sync:

- Target song tempo = 90%–95% of current heart rate
- Example:
  - Heart rate of 150 → target song tempo 135–142

---

### **Step 4 – Feedback**

- Every 10% drop in heart rate from peak heart rate:
  - Show message:
    - “Great job! Your heart slowed by 10%”

---

### **Step 5 – Completion**

If heart rate ≤ `normalHeartRate`:

- Show popup:
  - "Well done. Your heart rate is back to normal"

- Options:
  - Continue → play calming music (song tempo ≤80)
  - Exit → go to Summary

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

- Select or generate loops based on current heart rate
- Handle:
  - Minor song tempo adjustments (heart rate change <5%)
  - New loop generation (heart rate change ≥5%)

- Crossfade transitions
- Cache generated loops if needed

---

## **Notifications / Alerts**

- High heart rate alert (Home screen)
- Sync message (session start)
- Encouragement messages (every 10% heart rate drop from peak)
- Completion message

---

## **Edge Cases**

- Device disconnected → pause session + notify
- No loop available → fallback to calming loop with song tempo ≤80
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
