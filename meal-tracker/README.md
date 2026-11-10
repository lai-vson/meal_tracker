# Meal Tracker (Google Apps Script)

A personal web app for logging Breakfast / Lunch / Dinner / Snack with calories, protein, carbs, sugar and fat.
It compares each day against targets based on your InBody result. Data is saved as CSV files in your Google Drive.

## Files

| File | Put it in Apps Script as |
|---|---|
| `Code.gs` | Script file `Code.gs` |
| `Index.html` | HTML file named `Index` (the editor adds `.html` itself) |
| `appsscript.json` | Project manifest (see step 3) |

## Setup (about 5 minutes)

1. Go to <https://script.google.com>, then **New project**. Rename it "Meal Tracker".
2. Replace the contents of `Code.gs` with this `Code.gs`. Click **+ > HTML**, name it `Index`, and paste `Index.html`.
3. Go to **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**.
   Then replace that file with this `appsscript.json`. It sets the time zone to Asia/Singapore, makes the web app run as the
   person using it (each person gets their own data, see [Sharing](#sharing-with-other-people)), and turns on the **Drive API**
   advanced service used to read InBody and label photos.
   If you get "Drive is not defined", add it under **Services (+) > Drive API > v3**.
4. In the editor, select the function `testLookups` and click **Run**. Approve the permissions:
   - Google Drive: create and read the CSV files.
   - External requests: reach HPB, Open Food Facts and USDA.

   Check the **Execution log**. It should show results for lor mee, milo and chicken breast, and create the `Meal` folder in your Drive.
5. Click **Deploy > New deployment > Web app**. Set Execute as **User accessing the web app** and Who has access **Anyone with Google account**, then click **Deploy**.
   Only people you give the link to can find it, and each of them sees only their own data.
   If you'd rather keep it to yourself, choose Execute as **Me** and Who has access **Only myself** instead.
6. Open the web app URL (the one ending in `/exec`).

### On iPhone

1. Open the `/exec` URL in **Safari** and sign in with the same Google account that owns the script.
   If several Google accounts are signed in, Apps Script may show an error. Sign out of the others, or use a private tab with just this account.
2. Tap **Share > Add to Home Screen**. The icon opens the tracker in Safari with your Google login remembered.
3. The layout follows iPhone conventions. A tab bar at the bottom switches between **Today**, **Calendar**, **Supplements** and **Settings**, and tapping a day in the calendar opens that day.
   Add-food, recipe and settings screens slide up as sheets. The app follows the iPhone's Light/Dark appearance.
   Number fields open the number keypad, and inputs won't zoom the page when you tap them.

**Refreshing:** a Home Screen web app has no reload button, so tap **⟳** in the header. It re-reads your data from Drive and imports any openGym files you've shared.
The app also refreshes by itself when you come back to it after 2 minutes or more, unless a form is open.
To reload the app itself (for example after deploying a new version), swipe it away in the App Switcher and open it again.

When you change the code later, go to **Deploy > Manage deployments > Edit > Version: New version**. This keeps the same URL.

## First use

Open **Settings**:
- Tap **Read InBody result (photo or PDF)**. On iPhone you can take a photo, choose one from Photos, or pick the PDF from Files.
  Google Drive OCR reads the sheet. You then see every value it found to check and correct, and **Save scan** fills in the body fields and suggests targets.
  If a photo can't be read, use **Enter scan by hand**.
- Pick your activity level and goal (Auto is recommended), then tap **Save**.

### How targets are calculated (body fat, not BMI)

BMI only uses height and weight, so someone with a BMI of 22 can still carry a high body fat %.
The targets use body composition instead:

| Step | Calculation |
|---|---|
| BMR | Taken from InBody, which works it out from fat-free mass (370 + 21.6 × FFM), so it already accounts for body fat |
| Daily burn | BMR × activity level |
| Goal (Auto) | Body fat above the healthy range (women 18–28%, men 10–20%) → **lose fat, keep muscle**. Below the range → small surplus. Within it → maintain. |
| Calories | Lose: 85% of daily burn (≈15% deficit). With Auto, high body fat but a normal BMI (under 25) uses a gentler **90%** ("recomposition"). Maintain: 100%. Gain: 110%. Never below BMR. Aim to lose about 0.5–1% of body weight a week. |
| Protein | 2.0 g (adjustable) × kg of **fat-free mass**, so body fat doesn't inflate it. **+0.4 g while losing fat** (2.4 g with the default), to protect muscle in a deficit. The same every day, training or not. |
| Fat / carbs / sugar | Fat 30% of kcal, carbs = what's left, sugar under 10% of kcal |
| Limits shown each day | Saturated fat under 10% of kcal, sodium under 2,000 mg (5 g salt), fibre at least 26 g (men) / 20 g (women) |

Why these numbers:
- **Protein:** 1.6 g/kg body weight is where extra protein stops adding muscle on average (Morton 2018, upper range 2.2). In a calorie deficit, 2.3–3.1 g/kg of lean mass is recommended to keep muscle (Helms 2014; ISSN 2017).
  Lean mass is used because body weight would overstate the need when body fat is high.
- **Protein per meal:** about 0.4 g/kg (Schoenfeld & Aragon 2018).
- **Limits:** fat, saturated fat and sugar follow the WHO healthy-diet guidance. Sodium follows WHO and HPB, and fibre follows HPB.
- **Sugar:** food labels list *total* sugars, including those from milk and fruit, while WHO's limit is for *free* (added) sugars. The sugar bar is therefore on the strict side.

Settings shows this working with your own numbers. These are general guidelines, not medical advice; check with your doctor or a dietitian for a personal plan.

### InBody files

- Originals are kept in `Meal/InBody/`, and the values you confirm go to `inbody_scans.csv`.
- The **Body composition** card shows your latest scan and the change since the previous one.
- Google OCR accepts files up to 2 MB. Photos are shrunk automatically, but a larger PDF needs a screenshot instead.
- **Folder**: the default is `Meal` in My Drive. Use `/` for sub-folders, e.g. `Health/Meal`. Missing folders are created.
- **USDA API key** (optional): get a free key at <https://api.data.gov/signup/>. Without it the shared `DEMO_KEY` is used, which allows only a few searches per hour.
  The key is kept in your Apps Script user properties and is never sent to the browser.

## How to log food

Click **+ Add** on a meal and choose a source:

| Tab | Use for | Notes |
|---|---|---|
| SG/MY dishes (HPB) | Hawker and home dishes: lor mee, nasi lemak, roti prata | Lists every match so you can pick one. The default portion comes from HPB (e.g. 1 bowl = 716 g). |
| Packaged (Open Food Facts) | Packaged food and drinks | Search by name or barcode number. SG/MY products are listed first. The data is crowd-sourced, so check the values. |
| Ingredients (USDA) | Raw ingredients for cooking | Values are per 100 g. Enter the grams you used. |
| My foods | Your saved recipes and custom foods | Per serving |
| Manual | Values from a nutrition label | **Photo of label**, **Product link** or **Paste text** fills the form for you (check the numbers). Reads Singapore/Malaysia panels ("Protein (g) 3.0 10.0"), EU and US labels. Add the serving size in g/ml to also log by weight. Tick "Save to My foods" to reuse it later. Label photos are kept in `Meal/Labels/`. |

You can enter amounts in **servings**, **grams**, **ml**, **teaspoons (tsp)** or **tablespoons (tbsp)**. Switching the unit converts the number for you (e.g. 1 tbsp becomes 3 tsp).

### Spoons and ml

- 1 tsp = 5 ml, and 1 tbsp = 15 ml = 3 tsp.
- What a spoon weighs depends on what's in it. For ml/tsp/tbsp the app shows **"What is it closest to?"**, guesses from the food name, and lets you change it or type your own grams per ml.

| Food | g per ml | 1 tsp ≈ | 1 tbsp ≈ |
|---|---|---|---|
| Water, milk, juice, soup, kopi/teh | 1.0 | 5 g | 15 g |
| Cooking oil, ghee, melted butter | 0.92 | 4.5 g | 14 g |
| Granulated sugar | 0.85 | 4 g | 12.5 g |
| Honey, syrup, kaya, condensed milk | 1.4 | 7 g | 21 g |
| Soy / oyster / fish sauce, kicap, ketchup | 1.2 | 6 g | 18 g |
| Salt | 1.2 | 6 g | 18 g |
| Flour, cornstarch, milk powder, cocoa | 0.55 | 3 g | 8 g |
| Uncooked rice, lentils | 0.85 | 4 g | 13 g |
| Peanut butter, jam, sambal, paste | 1.1 | 5.5 g | 16.5 g |

These are for level spoons. A heaped spoon can be 1.5–2× more, and a Chinese soup spoon holds about 1 tbsp.
For drinks, Open Food Facts lists values per 100 ml, so 1.0 g/ml gives the right result.

**Home cooking**: click **New recipe**. Add each ingredient with the amount used, then set how many servings the dish makes and save.
The recipe then appears under **My foods** with values per serving.

The **calendar** colours each day by calories against your target: amber below 90%, green within ±10%, red above 110%.
Click a day to see or edit it. The **Summary** shows the selected day plus 7-day and 30-day averages, counting only days you logged.

## Apple Health and openGym

Steps, active calories, workouts and weight can come in from Apple Health through an iPhone Shortcut and a small receive-only "Health Bridge" script.
openGym workouts come in through a "Send to Meal Tracker" share-sheet Shortcut, or with **Settings → Import openGym file** (JSON backup or CSV). Each day's targets then follow that day's activity, with more protein on training days.
Setup and how it works: [HEALTH_SYNC.md](../HEALTH_SYNC.md).

## Supplements (protein powder, creatine, others)

Tap **Open** in the **Supplements** section of the day view.

**Adding a product.** Tap **+ Add supplement**, then use any of these:

| Way | How | Notes |
|---|---|---|
| Product page | Paste the link, tap **Read page** | Works when the shop puts the nutrition table in the page itself (Myprotein does). Some shops block scripts or load the table later; then use a photo or pasted text. |
| Photo / screenshot | Take a photo of the label or a screenshot of the page | Read with Google Drive OCR, like InBody photos. Kept in `Meal/Supplements/`. |
| Paste text | In Safari, select the nutrition table, copy, paste, tap **Read text** | |
| By hand | Type the values from the label | |

Always check the numbers before saving. Type tells the app how to use the product:
- **Protein powder:** needs protein per serving.
- **Creatine:** needs creatine per serving.
- **Other** (BCAA, pre-workout…): no suggested amount. Log it when you take it, and its nutrients count towards the day.

When a table has a per-100 g column, per-serving values are worked out from it, which is more precise than the rounded "<0.5 g" printed per serving.
Salt is converted to sodium (× 0.4).

### How the amounts are worked out

| | Training day (openGym session or strength workout in Health) | Rest day |
|---|---|---|
| Protein shake | 0.4 g × kg lean mass (0.5 after a big session: 20+ working sets or 4+ muscle groups), max 50 g, never more than the protein you still need that day | Optional: food first. The same amount is offered if you can't reach your protein target from meals |
| Creatine | 0.03 g × kg body weight, kept between 3 and 5 g, with your post-workout shake | Same amount, with any meal |

- **Powder grams:** the amount divided by the product's content. For example, 21 g protein ÷ (23.1 g protein per 30 g scoop) = 27 g powder.
  Scoops are shown to the nearest quarter, with that product's scoop size, because scoops differ a lot between products: "22 g powder (≈ ¾ scoop; 1 scoop = 30 g)".
- **Whole creatine scoops:** if whole scoops give an amount within 3–5 g, the app suggests those instead of an exact weight. For example, 1 scoop of Impact Creatine is 3.4 g.
- **Creatine doesn't change with the workout.** It works by keeping your muscles topped up, so take the same amount every day.
- **Not imported yet?** Tick **Training today** to see training-day amounts before you've shared the workout from openGym.
- **Logging:** **Log** adds the powder to the meal chosen at the bottom (Snack by default), so its calories and protein count in the day's totals.
  Logged amounts are subtracted, so a second visit shows what's left, or "Done for today ✓".
- Without an InBody result or body weight in Settings, the app uses 25 g protein and 3 g creatine.

These are general guidelines, not medical advice. Check with your doctor before taking creatine if you have kidney problems.

## Sharing with other people

The web app runs as **whoever opens it**, so everyone uses the same link but has a completely separate tracker:

| | Where it's kept | Who can see it |
|---|---|---|
| Meals, supplements, workouts, InBody results | A `Meal` folder in **that person's** Google Drive | Only them |
| Settings, body numbers, targets, training days, USDA key | That person's Apps Script user settings | Only them |

**Switching your existing link** (keeps the same URL; your own data is unchanged because the app still runs as you when you open it):
1. Paste the updated `Code.gs` and `appsscript.json` into the project.
2. **Deploy → Manage deployments → ✏️ Edit**.
3. Set **Version: New version**, **Execute as: User accessing the web app**, **Who has access: Anyone with Google account**, then **Deploy**.
4. Open the link once yourself to check your data is still there.

**What the other person does:**
1. Open the link in Safari and sign in with their Google account. It must be a personal Gmail, or the same organisation's account if your Workspace only allows that.
2. On "Google hasn't verified this app", tap **Advanced → Go to Meal Tracker (unsafe)**, then **Allow**.
   This is normal for a personal Apps Script app. It asks for Drive (to save their CSV files) and external requests (food databases).
3. Open **Settings** and add their InBody result or body numbers. Their `Meal` folder is created on first save.
4. Optionally, **Share → Add to Home Screen**.

**Good to know:**
- **Who can get in:** anyone with the link and a Google account can open the app, but they only ever get their own empty tracker. Share the link only with people you choose.
  To stop sharing, set Who has access back to **Only myself** (or archive the deployment).
- **Apple Health sync:** the Health Bridge writes into the Drive of the person who deployed it, so it only works for you.
  Another person who wants Apple Health sync needs their own Health Bridge project ([HEALTH_SYNC.md](../HEALTH_SYNC.md)) with the same folder name.
  The openGym file import in Settings works for everyone.
- **What you can see as the owner:** the Apps Script **Executions** page lists everyone's runs (function name, time, success or error message).
  It never shows their meals or files, but error messages can mention a food name.
- **Limits:** an unverified Apps Script app can be authorised by up to about 100 people.
  Each person's Google account has its own daily quota for URL fetches and OCR, so one heavy user doesn't use up yours.

## Data files (in the Drive folder)

- `meal_log.csv`: one row per food logged.
  Columns: `id, date, meal, food_name, source, source_id, quantity, unit, grams, kcal, protein_g, carbs_g, sugar_g, fat_g, sat_fat_g, sodium_mg, fibre_g, notes, created_at`
- `my_foods.csv`: saved recipes and custom foods. Nutrients are per serving, and the ingredient list is stored as JSON.
- `supplements.csv`: your supplements. Nutrients and creatine are per serving. Logged supplements go to `meal_log.csv` with source `SUPP`.

You can open both files in Google Sheets or Excel. Text that starts with `=`, `+`, `-` or `@` gets a leading `'` so it can't run as a formula.
Don't edit the CSV while the app is saving. Each save rewrites the whole file, which is fine for years of personal logs.

## Caveats

- The HPB lookup uses the same public JSON endpoints as the HPB Food Search website (`/bff/v1/food-portal/...`). They are not an official, documented API, so HPB could change them.
  If HPB search stops working, run `testLookups` and check the log.
- HPB marks "not available" values as -1. The app counts those as 0.
- Open Food Facts limits searches to about 10 per minute. If you hit the limit, the app tells you to wait a minute.
