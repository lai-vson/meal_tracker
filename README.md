# Meal Tracker

A personal Google Apps Script web app for logging meals against targets based on an InBody body-composition result.
It's built for Singapore and Malaysia food, and the layout is designed for iPhone.

- Looks up hawker and home dishes in HPB SG FoodID, packaged food in Open Food Facts and ingredients in USDA, or reads them from a label photo, product link or pasted text.
- Sets calorie and protein targets from body composition rather than BMI, with daily limits for sodium, saturated fat and fibre.
- Syncs activity from Apple Health (through an iPhone Shortcut) and workouts from openGym.
- Suggests protein powder and creatine amounts for the day.
- Saves everything as CSV files in each user's own Google Drive.

| Folder / file | What it is |
|---|---|
| [meal-tracker/](meal-tracker/) | The web app (`Code.gs`, `Index.html`, `appsscript.json`). Setup: [meal-tracker/README.md](meal-tracker/README.md) |
| [health-bridge/](health-bridge/) | Optional receive-only script for Apple Health sync |
| [HEALTH_SYNC.md](HEALTH_SYNC.md) | Apple Health and openGym setup, and how the targets use them |

No data is stored in this repository. Each user's meals, InBody results and settings stay in their own Google account.
The targets are general guidelines, not medical advice.
