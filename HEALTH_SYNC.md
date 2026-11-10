# Apple Health and openGym sync

This guide connects Apple Health (steps, active calories, workouts, weight) and openGym (detailed workouts) to the Meal Tracker,
so each day's calorie and protein targets follow what you actually did.

## How it fits together

```
iPhone                                Google (your account)
──────                                ─────────────────────
Apple Health ──► Shortcut ──POST──►   Health Bridge script ──► Meal/health_daily.csv ─┐
 (openGym also writes                  (receive-only, needs                             │
  workouts to Health)                   the secret key)                                 ├─► Meal Tracker
                                                                                        │   (reads the CSVs)
openGym ──► Export ──► share sheet: "Send to Meal Tracker" ──POST──► Health Bridge ──► Meal/openGym inbox/
                                                                    (imported into Meal/gym_workouts.csv when the tracker opens)
   or: Export ──► Import openGym file (in Meal Tracker Settings) ──► Meal/gym_workouts.csv ─┘
```

- **Why a separate bridge script?** Apple Health can't be read from a web page. Only an app on the iPhone can read it, and Shortcuts is
  Apple's built-in one. The Meal Tracker needs a Google sign-in, which a Shortcut can't do.
  The bridge is a second, tiny script with one job: accept a day's numbers if the secret key matches, and write them to `health_daily.csv`.
  It never sends any data back, so the URL and key can't be used to read your meals, InBody results or health data.
- **Why openGym CSV as well?** openGym writes workouts to Apple Health, but Health only keeps the summary (type, minutes, calories).
  The CSV adds the detail: exercises, sets, kg lifted and muscles trained.

## Part 1: Health Bridge (one-off, about 5 minutes, on a computer)

Use the **same Google account** as the Meal Tracker, because the bridge writes into that account's `Meal` folder.
A work Google Workspace account may not allow "Anyone" web apps, so use your personal Gmail account.

1. Go to <https://script.google.com>, then **New project**, and name it "Meal Tracker Health Bridge".
2. Replace `Code.gs` with [health-bridge/HealthBridge.gs](health-bridge/HealthBridge.gs).
   Then show the manifest (**Project Settings** → tick **Show "appsscript.json"**) and replace it with [health-bridge/appsscript.json](health-bridge/appsscript.json).
3. If your Meal Tracker folder isn't `Meal`, open **Project Settings → Script properties** and set `FOLDER_PATH`, for example `Health/Meal`.
4. Select `setupBridge` and click **Run**. Approve the Drive permission. The **Execution log** shows your **bridge key**.
   Copy it somewhere safe, like a password manager. Running `setupBridge` again creates a new key and the old one stops working.
5. Click **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

**Check it (optional, Windows PowerShell on your PC).** Replace the URL and key first:

```powershell
Invoke-RestMethod -Method Post -Uri "https://script.google.com/macros/s/XXXX/exec" -ContentType "application/json" -Body '{"key":"YOUR_KEY","date":"2026-01-01","steps":"1234"}'
```

You should get `ok: True, message: Saved 2026-01-01.`, and `Meal/health_daily.csv` gets a row for 2026-01-01.
Delete that test row in Drive afterwards, or leave it; it's harmless.

## Part 2: iPhone Shortcut (about 10 minutes)

Open **Shortcuts** and tap **+** to create a new shortcut called "Sync Health to Meal Tracker". Add these actions in order.
Wording can differ slightly between iOS versions.

| # | Action | Settings | Name the result |
|---|---|---|---|
| 1 | **Date** | Current Date | |
| 2 | **Format Date** | Date format: Custom, `yyyy-MM-dd` | `Day` |
| 3 | **Find Health Samples** | Type **Steps**, Start Date **is today** | |
| 4 | **Calculate Statistics** | **Sum** of Health Samples | `Steps` |
| 5 | **Find Health Samples** | Type **Active Energy**, Start Date **is today** | |
| 6 | **Calculate Statistics** | **Sum** | `ActiveKcal` |
| 7 | **Find Health Samples** | Type **Exercise Minutes**, Start Date **is today** | |
| 8 | **Calculate Statistics** | **Sum** | `ExerciseMin` |
| 9 | **Find Health Samples** | Type **Weight**, Start Date **is today**, Sort by **Start Date**, Order **Latest First**, Limit **1** | `WeightKg` |
| 10 | **Find Health Samples** | Type **Body Fat Percentage**, same as above | `BodyFat` |
| 11 | *(optional)* **Find Health Samples** | Type **Workouts**, Start Date **is today** | |
| 12 | *(optional)* **Repeat with Each** | Inside: **Text** → `[Repeat Item: Type] ; [Repeat Item: Source] ; [Repeat Item: Duration]`, then after **End Repeat**: **Combine Text** with **New Lines** | `Workouts` |
| 13 | **Get Contents of URL** | URL: your bridge `/exec` URL. Method **POST**. Request Body **JSON** with the fields below | |
| 14 | **Get Dictionary Value** | Key `message`, then **Show Notification** | |

JSON fields for step 13. Set every field's type to **Text** and insert the variable; the bridge removes units like "kcal" and "kg" itself.

| Key | Value |
|---|---|
| `key` | your bridge key |
| `date` | `Day` |
| `steps` | `Steps` |
| `activeKcal` | `ActiveKcal` |
| `exerciseMin` | `ExerciseMin` |
| `weightKg` | `WeightKg` |
| `bodyFatPct` | `BodyFat` |
| `workouts` | `Workouts` (leave out if you skipped steps 11–12) |

Notes:
- **Units:** in the Health app, set energy to **kcal**, not kJ (Health → profile → Units).
- **Missing weight or body fat:** if you didn't weigh in that day, those fields are sent empty and simply ignored.
- **Workouts:** if your iOS version has no "Workouts" type in step 11, skip steps 11–12. openGym sessions still come in through the CSV import (Part 3).
- **Run it once by hand** to test. You should see "Saved yyyy-mm-dd." The first run asks for Health access; allow every type listed.

### Run it automatically

In Shortcuts open **Automation → + → Time of Day**, set **22:00**, **Daily**, choose **Run Immediately**, then pick the shortcut.

- **Locked iPhone:** iOS keeps Health data locked while the iPhone is locked, so a run with the screen locked may fail.
  If that happens, add a second automation: **App → openGym → Is Closed → Run Immediately**, which runs right after each workout.
- **Running it more than once:** each run replaces that day's row, so a later run fixes an earlier, partial one.
  You can also add the shortcut to your Home Screen and tap it before checking the tracker.
- **Missed days:** a day the shortcut never ran stays empty, and the tracker uses your usual targets for it.

## Part 3: openGym workouts

**Why not the auto-backup?** openGym's "Auto-backup on changes" saves into openGym's own private storage on iPhone.
Neither the Files app nor Shortcuts can see that folder; only Android lets you pick a different backup folder.
So on iPhone the file has to leave openGym through the share sheet. With this Shortcut that takes two taps.

### Option A: "Send to Meal Tracker" share-sheet Shortcut (recommended)

It uses the same Health Bridge URL and key as Part 2. If you set up the bridge before this feature existed,
paste the new [HealthBridge.gs](health-bridge/HealthBridge.gs) into the bridge project and deploy it as a new version:
**Deploy → Manage deployments → Edit → Version: New version**, so the URL stays the same.

Create a new shortcut called **"Send to Meal Tracker"** with these actions:

| # | Action | Settings |
|---|---|---|
| 1 | **Receive** *Files* **input from** *Share Sheet* | This isn't in the action list. Tap the shortcut's name at the top → **Details** (on older iOS, the **ⓘ** button) → turn on **Show in Share Sheet** → **Done**. The block then appears at the top by itself. Tap **Any** in it, choose only **Files**, and set **If there's no input** to **Stop and Respond** |
| 2 | **Repeat with Each** item in *Shortcut Input* | openGym's CSV export shares two files (workouts and body), so each is sent separately |
| 3 | &nbsp;&nbsp;**Get Text from** *Repeat Item* | turns the file into text |
| 4 | &nbsp;&nbsp;**Get Contents of URL** | URL: your bridge `/exec` URL. Method **POST**. Request Body **JSON** with the fields below |
| 5 | &nbsp;&nbsp;**Get Dictionary Value** | Key `message` of *Contents of URL*, then **Show Notification** with it |
| 6 | **End Repeat** | |

JSON fields for step 4, all of type **Text**:

| Key | Value |
|---|---|
| `key` | your bridge key |
| `kind` | `opengym` (typed exactly like this) |
| `name` | *Repeat Item* → **Name** (tap the variable to pick the Name property) |
| `file` | *Text* (the result of step 3) |

**Using it after a workout:**
1. In openGym go to **Settings → Data & backup** and export.
   The **JSON backup** ("Export everything") has every workout and weigh-in in one file. The **CSV** export also works, and its muscle names are a little more complete (see below).
2. In the share sheet tap **Send to Meal Tracker**. You get the notification "Sent to Meal Tracker…".
3. Open the Meal Tracker. The file is imported as it loads and a message shows how many workouts were updated.

Every export is your full history (or the range you picked), and sessions are matched, so sending it every time is safe and never duplicates anything.

What happens to the file: the bridge checks it looks like an openGym file and saves it in `Meal/openGym inbox/`.
The Meal Tracker imports it when it opens and then moves it to the Drive trash, where you can restore it for 30 days.
If a file can't be imported it's renamed `FAILED - …`, left in the inbox, and the tracker shows the reason once.
To retry it, remove `FAILED - ` from the name.

### Option B: import by hand

In the Meal Tracker go to **Settings → Apple Health & openGym → Import openGym file** and pick the JSON backup or the CSV files.
You can also pick one of the auto-backup files if you've copied it out of openGym.

### What gets imported

| From | Workouts | Weigh-ins | Muscle names |
|---|---|---|---|
| JSON backup | ✓ | ✓ (with body fat if you log it as a measurement) | only for exercises you created yourself |
| CSV workouts file | ✓ | | ✓ all exercises |
| CSV body file | | ✓ | |

If a session was already imported from CSV, a later JSON import keeps the CSV's exercise and muscle names.

Each openGym session becomes one row of `gym_workouts.csv`:

| Column | How it's worked out |
|---|---|
| `duration_min` | end time − start time |
| `sets` | working sets; warm-ups and drop-set extensions not counted |
| `volume_kg` | Σ weight × reps, warm-ups excluded, lb converted to kg (same rule as openGym) |
| `cardio_min` | time on cardio rows (openGym marks them with a distance) |
| `exercises`, `body_parts` | from openGym's exercise and body part columns |

## How the tracker uses the data

With **"Adjust each day's targets…"** turned on (Settings), each day is handled like this:

| Day has | Calories | Protein |
|---|---|---|
| Nothing synced | your saved targets | your saved target |
| Apple Health active kcal | (BMR + 75% × active kcal) × 1.1, at least BMR × 1.2 (a sedentary day), then your goal (e.g. −15% to lose fat), never below BMR | the same every day: g/kg lean mass from Settings, +0.4 while losing fat |
| A training session (openGym, a strength workout in Health, or marked by hand) | as above | as above. Training changes the post-workout shake on the Supplements page, not the daily total |

- **Why only 75% of active kcal?** Wrist devices estimate calories with large errors; in one study no device was within 20%. Counting all of it would overstate what you can eat.
- **Why at least BMR × 1.2?** Without an Apple Watch, the iPhone only counts walking as active energy, so a gym day could otherwise look less active than a sedentary one.
- **Why × 1.1?** Digesting food uses about 10% of what you eat. The fixed activity level already includes this, so it's only added when using Health data.
- **Why doesn't protein go up on training days?** Muscle is built by eating enough protein every day over weeks, and muscle protein synthesis stays raised for 24–48 hours after training.
  A steady daily target, spread over meals, matches the evidence better than daily swings.
- **Protein per meal:** Breakfast, Lunch and Dinner each show protein eaten against a per-meal target, for example `P 24 / 39 g`.
  The target is the day's protein ÷ 3, and never less than 0.4 g × kg lean mass, the amount per meal that best supports muscle.
  Spreading protein over the day, including one meal within a couple of hours after training, works better for keeping muscle than eating it all at once.
- **Calendar and summary:** training days get 🏋️ on the calendar. The Summary adds steps, active kcal and training days for 7 and 30 days.
- **Activity section:** each day shows steps, active kcal, exercise minutes, weight, and each workout with sets, kg lifted and muscles.
  It also explains how that day's target was worked out.

These are general guidelines, not medical advice.

## Privacy and security

- **Where data lives:** all of it stays in your own Google Drive (`Meal/health_daily.csv`, `Meal/gym_workouts.csv`, `Meal/gym_body.csv`,
  and shared openGym files waiting in `Meal/openGym inbox/` until the tracker imports them).
- **The bridge:** it only accepts data that has the right key, and it never returns stored data.
  Health numbers are limited to 20 KB per request; openGym files to 20 MB, and only files that look like an openGym export are stored.
- **If the key leaks:** run `setupBridge` again for a new key and update the Shortcut. To switch syncing off completely, go to **Deploy → Manage deployments → Archive** in the bridge project.
- **The main tracker** always needs a Google sign-in, and each person only sees their own data. The bridge writes only into the Drive of the person who deployed it,
  so anyone else who wants Apple Health sync deploys their own bridge.
