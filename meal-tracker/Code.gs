/**
 * Meal Tracker - Google Apps Script web app.
 *
 * Logs Breakfast / Lunch / Dinner / Snack entries to CSV files in Google Drive
 * (default folder: "Meal") and looks up nutrition from:
 *   - HPB SG FoodID  (Singapore / Malaysia dishes, e.g. lor mee, nasi lemak)
 *   - Open Food Facts (packaged products, search by name or barcode)
 *   - USDA FoodData Central (raw ingredients for home cooking)
 *   - "My foods" (your own saved recipes / custom meals)
 */

const DEFAULT_FOLDER_PATH = 'Meal';
const LOG_FILE = 'meal_log.csv';
const FOODS_FILE = 'my_foods.csv';
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
// Quantity units. Volume units (ml/tsp/tbsp) are converted to grams in the browser; the
// "grams" column always holds the weight the nutrients were calculated from.
const UNITS = ['serving', 'g', 'ml', 'tsp', 'tbsp'];

// Internal nutrient key -> CSV column name.
const NUTRIENT_COLS = {
  kcal: 'kcal',
  protein: 'protein_g',
  carbs: 'carbs_g',
  sugar: 'sugar_g',
  fat: 'fat_g',
  satFat: 'sat_fat_g',
  sodium: 'sodium_mg',
  fibre: 'fibre_g',
};
const NUTRIENT_KEYS = Object.keys(NUTRIENT_COLS);

const LOG_HEADERS = ['id', 'date', 'meal', 'food_name', 'source', 'source_id', 'quantity', 'unit', 'grams',
  ...Object.values(NUTRIENT_COLS), 'notes', 'created_at'];
const FOODS_HEADERS = ['id', 'name', 'serving_desc', 'serving_g',
  ...Object.values(NUTRIENT_COLS), 'ingredients_json', 'created_at'];

const HPB_API = 'https://pphtpc.hpb.gov.sg/bff/v1/food-portal';
const OFF_API = 'https://world.openfoodfacts.org';
const OFF_SEARCH_API = 'https://search.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,brands,quantity,serving_size,serving_quantity,nutriments,countries_tags';
const USDA_API = 'https://api.nal.usda.gov/fdc/v1';
const HTTP_HEADERS = { Accept: 'application/json', 'User-Agent': 'MealTracker-AppsScript/1.0 (personal use)' };

// InBody scans: originals are kept in <folder>/InBody, parsed values in inbody_scans.csv.
const INBODY_FOLDER = 'InBody';
const INBODY_FILE = 'inbody_scans.csv';
const INBODY_FIELDS = ['scanDate', 'sex', 'age', 'heightCm', 'weightKg', 'smmKg', 'bodyFatKg', 'pbf', 'ffmKg',
  'bmi', 'bmr', 'visceralFat', 'score'];
const INBODY_HEADERS = ['id', 'scan_date', 'sex', 'age', 'height_cm', 'weight_kg', 'smm_kg', 'body_fat_kg', 'pbf_pct',
  'ffm_kg', 'bmi', 'bmr_kcal', 'visceral_fat', 'inbody_score', 'source_file', 'created_at'];
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // Drive OCR accepts images/PDFs up to 2 MB

// Apple Health days, written by the separate Health Bridge script (health-bridge/HealthBridge.gs).
const HEALTH_FILE = 'health_daily.csv';
const HEALTH_HEADERS = ['date', 'steps', 'active_kcal', 'exercise_min', 'weight_kg', 'body_fat_pct',
  'workouts_json', 'updated_at'];
// openGym workouts, one row per session, summarised from openGym's per-set CSV export.
const GYM_FILE = 'gym_workouts.csv';
const GYM_HEADERS = ['key', 'date', 'start', 'end', 'name', 'duration_min', 'sets', 'volume_kg', 'cardio_min',
  'exercises', 'body_parts', 'imported_at'];
const LB_TO_KG = 0.45359237;

const DEFAULT_SETTINGS = {
  folderPath: DEFAULT_FOLDER_PATH,
  targets: { kcal: 2000, protein: 100, carbs: 250, sugar: 40, fat: 65 },
  bmr: 0,
  activityFactor: 1.4,
  weightKg: 0,
  sex: '', // 'M' | 'F' - picks the healthy body-fat range
  ffmKg: 0, // fat-free (lean) mass from InBody
  pbf: 0, // percent body fat
  goal: 'auto', // auto | lose | maintain | gain
  proteinPerKgFfm: 2.0,
  dailyAdjust: true, // adjust each day's targets from Apple Health activity and training
};

/* ------------------------------------------------------------------ */
/* Web app entry point                                                */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Meal Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ */
/* Public API (called from Index.html via google.script.run)          */
/* ------------------------------------------------------------------ */

function getInitData() {
  let gymInbox = null;
  try {
    gymInbox = processGymInbox_();
  } catch (err) {
    gymInbox = { files: 0, workouts: 0, errors: [err.message] }; // never block the app from opening
  }
  return { settings: publicSettings_(), meals: MEALS, scans: getInBodyScans_(), supplements: getSupplements(),
    trainingDays: getTrainingDays_(), gymInbox };
}

/**
 * Days switched to "Training today" on the Supplements page, before the workout is imported
 * from openGym / Apple Health. Only the supplement amounts use them. Returns the updated list.
 */
function setTrainingDay(date, on) {
  assertDate_(date);
  // Locked so two quick taps can't read the same old list and overwrite each other.
  return withLock_(() => {
    const list = getTrainingDays_().filter(d => d !== date);
    if (on) list.push(date);
    list.sort();
    // Only the latest ~6 months are kept, so the property stays small.
    const kept = list.slice(-180);
    PropertiesService.getUserProperties().setProperty('TRAINING_DAYS', JSON.stringify(kept));
    return kept;
  });
}

function getTrainingDays_() {
  try {
    const list = JSON.parse(PropertiesService.getUserProperties().getProperty('TRAINING_DAYS') || '[]');
    return Array.isArray(list) ? list.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) : [];
  } catch (err) {
    return [];
  }
}

/** Returns log entries with start <= date <= end (yyyy-MM-dd strings). */
function getEntries(start, end) {
  assertDate_(start);
  assertDate_(end);
  return readCsv_(getCsvFile_(LOG_FILE, LOG_HEADERS))
    .filter(r => r.date >= start && r.date <= end)
    .map(rowToEntry_);
}

/**
 * Everything the calendar needs for a date range in one round trip:
 * meal entries, Apple Health days and openGym workouts.
 */
function getMonthData(start, end) {
  assertDate_(start);
  assertDate_(end);
  const inRange = r => r.date >= start && r.date <= end;
  const gymRows = readCsv_(getCsvFile_(GYM_FILE, GYM_HEADERS));
  const maxOf = key => gymRows.reduce((m, r) => (r[key] > m ? r[key] : m), '');
  return {
    entries: getEntries(start, end),
    health: readCsv_(getCsvFile_(HEALTH_FILE, HEALTH_HEADERS)).filter(inRange).map(rowToHealth_),
    gym: gymRows.filter(inRange).map(rowToGym_),
    weighIns: readCsv_(getCsvFile_(GYM_BODY_FILE, GYM_BODY_HEADERS)).filter(inRange)
      .map(r => ({ date: r.date, weightKg: num_(r.weight_kg), bodyFatPct: num_(r.body_fat_pct) })),
    lastHealthSync: lastHealthDate_(),
    // Every row of an import gets the same imported_at, so the newest one is the last import.
    lastGymImport: { at: maxOf('imported_at'), lastWorkout: maxOf('date') },
  };
}

/**
 * Imports an openGym file: the JSON backup ("Export everything" or an auto-backup copy)
 * or the CSV export (workouts file, one row per set, or the body file).
 * Re-importing the same or a longer history is safe: sessions are matched by
 * date + start time + name and replaced, not duplicated.
 */
function importOpenGymFile(text) {
  const s = String(text || '').replace(/^﻿/, '').trim();
  if (s.startsWith('{')) {
    let state;
    try { state = JSON.parse(s); } catch (err) { throw new Error('The openGym backup file is damaged (not valid JSON).'); }
    return importOpenGymJson_(state);
  }
  return importOpenGymCsv(s);
}

/** Kept for older Index.html versions; use importOpenGymFile. */
function importOpenGymCsv(text) {
  const rows = Utilities.parseCsv(String(text || '').replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('The file is empty.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (head.includes('exercise') && head.includes('set_type')) return importGymWorkouts_(head, rows.slice(1));
  if (head[0] === 'date' && head.some(h => /^weight_(kg|lb)$/.test(h))) return importGymBody_(head, rows.slice(1));
  throw new Error('This is not an openGym CSV export. In openGym use Settings > Data > Export as CSV.');
}

/** Appends entries to the log. Returns the saved entries (with ids). */
function addEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Nothing to add.');
  const clean = entries.map(sanitizeEntry_);
  return withLock_(() => {
    const file = getCsvFile_(LOG_FILE, LOG_HEADERS);
    const rows = readCsv_(file);
    clean.forEach(e => rows.push(entryToRow_(e)));
    writeCsv_(file, LOG_HEADERS, rows);
    return clean;
  });
}

function deleteEntry(id) {
  return withLock_(() => {
    const file = getCsvFile_(LOG_FILE, LOG_HEADERS);
    const rows = readCsv_(file);
    const kept = rows.filter(r => r.id !== id);
    if (kept.length === rows.length) throw new Error('Entry not found.');
    writeCsv_(file, LOG_HEADERS, kept);
    return true;
  });
}

/** source: HPB | OFF | USDA. Returns { total, items: [food] }. */
function searchFoods(source, query, page) {
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Type at least 2 characters.');
  const p = Math.max(1, Number(page) || 1);
  switch (source) {
    case 'HPB': return hpbSearch_(q, p);
    case 'OFF': return /^\d{8,14}$/.test(q) ? offBarcode_(q) : offSearch_(q, p);
    case 'USDA': return usdaSearch_(q, p);
    default: throw new Error(`Unknown source: ${source}`);
  }
}

/** Full nutrient details for a search result that has needsDetails = true. */
function getFoodDetails(source, sourceId) {
  if (source !== 'HPB') throw new Error(`Details lookup not supported for ${source}.`);
  return hpbDetails_(sourceId);
}

function getMyFoods() {
  return readCsv_(getCsvFile_(FOODS_FILE, FOODS_HEADERS)).map(rowToMyFood_);
}

/** Saves a custom meal / recipe. Nutrients are per serving. */
function saveMyFood(food) {
  const name = safeText_(food && food.name);
  if (!name) throw new Error('Name is required.');
  const per = {};
  NUTRIENT_KEYS.forEach(k => { per[k] = clampNum_(food.perServing && food.perServing[k]); });
  const row = {
    id: Utilities.getUuid(),
    name,
    serving_desc: safeText_(food.servingDesc) || '1 serving',
    serving_g: clampNum_(food.servingGrams),
    ingredients_json: Array.isArray(food.ingredients) ? JSON.stringify(food.ingredients.slice(0, 100)) : '',
    created_at: nowIso_(),
  };
  NUTRIENT_KEYS.forEach(k => { row[NUTRIENT_COLS[k]] = per[k]; });
  return withLock_(() => {
    const file = getCsvFile_(FOODS_FILE, FOODS_HEADERS);
    const rows = readCsv_(file);
    rows.push(row);
    writeCsv_(file, FOODS_HEADERS, rows);
    return rowToMyFood_(row);
  });
}

function deleteMyFood(id) {
  return withLock_(() => {
    const file = getCsvFile_(FOODS_FILE, FOODS_HEADERS);
    const rows = readCsv_(file);
    writeCsv_(file, FOODS_HEADERS, rows.filter(r => r.id !== id));
    return true;
  });
}

function saveSettings(input) {
  const cur = getSettings_();
  const t = (input && input.targets) || {};
  const folderPath = String(input.folderPath || '').split('/').map(s => s.trim()).filter(Boolean).join('/');
  const next = {
    folderPath: folderPath || DEFAULT_FOLDER_PATH,
    targets: {
      kcal: clampNum_(t.kcal) || cur.targets.kcal,
      protein: clampNum_(t.protein) || cur.targets.protein,
      carbs: clampNum_(t.carbs) || cur.targets.carbs,
      sugar: clampNum_(t.sugar) || cur.targets.sugar,
      fat: clampNum_(t.fat) || cur.targets.fat,
    },
    bmr: clampNum_(input.bmr),
    activityFactor: clampNum_(input.activityFactor) || DEFAULT_SETTINGS.activityFactor,
    weightKg: clampNum_(input.weightKg),
    sex: ['M', 'F'].includes(input.sex) ? input.sex : '',
    ffmKg: clampNum_(input.ffmKg),
    pbf: clampNum_(input.pbf),
    goal: ['auto', 'lose', 'maintain', 'gain'].includes(input.goal) ? input.goal : 'auto',
    proteinPerKgFfm: clampNum_(input.proteinPerKgFfm) || DEFAULT_SETTINGS.proteinPerKgFfm,
    dailyAdjust: input.dailyAdjust !== false,
  };
  const props = PropertiesService.getUserProperties();
  props.setProperty('SETTINGS', JSON.stringify(next));
  // The API key is stored server-side only and never sent back to the browser.
  if (input.clearUsdaKey) props.deleteProperty('USDA_API_KEY');
  else if (input.usdaApiKey) props.setProperty('USDA_API_KEY', String(input.usdaApiKey).trim());
  return publicSettings_();
}

/**
 * Reads an InBody result sheet (photo or PDF) with Google Drive OCR.
 * file = { name, mimeType, base64 }. The original is kept in <folder>/InBody;
 * the temporary OCR copy is deleted. Returns the parsed values for the user to
 * check, plus the recognised text so they can fix anything OCR got wrong.
 */
function readInBody(file) {
  const { text, original } = ocrUpload_(file, INBODY_FOLDER, 'InBody', 'the InBody result sheet');
  return { values: parseInBody_(text), text, fileName: original.getName(), fileUrl: original.getUrl() };
}

/**
 * Saves an uploaded photo/PDF ({ name, mimeType, base64 }) in <folder>/<folderName> and reads its
 * text with Google Drive OCR. The temporary Google Doc used for OCR is deleted afterwards.
 */
function ocrUpload_(file, folderName, prefix, what) {
  const mime = String(file && file.mimeType);
  if (!/^image\/(jpeg|png|gif|webp)$|^application\/pdf$/.test(mime)) {
    throw new Error(`Please choose a photo (JPG/PNG) or a PDF of ${what}.`);
  }
  const bytes = Utilities.base64Decode(String(file.base64 || ''));
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error('File is larger than 2 MB, which Google OCR cannot read. Take a screenshot instead.');
  }
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(bytes, mime, `${prefix}_${stamp}.${ext}`);
  const folder = getSubFolder_(folderName);
  const original = folder.createFile(blob);

  // Converting to a Google Doc with ocrLanguage runs Drive's OCR on images and PDFs.
  const doc = Drive.Files.create(
    { name: `tmp-ocr-${stamp}`, mimeType: MimeType.GOOGLE_DOCS, parents: [folder.getId()] },
    blob,
    { ocrLanguage: 'en', fields: 'id' });
  let text;
  try {
    text = DocumentApp.openById(doc.id).getBody().getText();
  } finally {
    Drive.Files.remove(doc.id); // temporary OCR copy only; the original upload is kept
  }
  return { text, original };
}

/** Saves a (user-checked) scan and copies its body numbers into Settings. */
function saveInBodyScan(v) {
  const scan = sanitizeScan_(v || {});
  if (!scan.weightKg) throw new Error('Weight is required.');
  const row = { id: Utilities.getUuid(), source_file: safeText_(v.sourceFile), created_at: nowIso_() };
  INBODY_FIELDS.forEach((k, i) => { row[INBODY_HEADERS[i + 1]] = scan[k]; });
  withLock_(() => {
    const file = getCsvFile_(INBODY_FILE, INBODY_HEADERS);
    const rows = readCsv_(file);
    rows.push(row);
    writeCsv_(file, INBODY_HEADERS, rows);
  });
  // Only overwrite settings with values the scan actually has.
  const s = getSettings_();
  if (scan.bmr) s.bmr = scan.bmr;
  if (scan.weightKg) s.weightKg = scan.weightKg;
  if (scan.ffmKg) s.ffmKg = scan.ffmKg;
  if (scan.pbf) s.pbf = scan.pbf;
  if (scan.sex) s.sex = scan.sex;
  PropertiesService.getUserProperties().setProperty('SETTINGS', JSON.stringify(s));
  return { settings: publicSettings_(), scans: getInBodyScans_() };
}

/**
 * Run from the editor once to authorise, create the Drive folder + CSV files,
 * and check each food lookup. Each step is reported on its own, so one failing
 * lookup does not hide the others.
 */
function testLookups() {
  const steps = [
    ['Drive', () => {
      const folder = getFolder_();
      getCsvFile_(LOG_FILE, LOG_HEADERS);
      getCsvFile_(FOODS_FILE, FOODS_HEADERS);
      return `folder "${getSettings_().folderPath}" ready (${folder.getUrl()}) with ${LOG_FILE} and ${FOODS_FILE}`;
    }],
    ['HPB', () => {
      const r = hpbSearch_('lor mee', 1);
      if (!r.items.length) return 'no results';
      const d = hpbDetails_(r.items[0].sourceId);
      return `${r.total} results; ${d.name}: ${d.per100g.kcal} kcal/100 g, serving ${d.servingDesc}`;
    }],
    ['Open Food Facts', () => {
      const r = offSearch_('milo', 1);
      return `${r.total} results; first = ${r.items[0] ? r.items[0].name : 'none'}`;
    }],
    ['USDA', () => {
      const r = usdaSearch_('chicken breast raw', 1);
      return `${r.total} results; first = ${r.items[0] ? r.items[0].name : 'none'}`;
    }],
  ];
  let failed = 0;
  steps.forEach(([name, fn]) => {
    try {
      console.log(`OK   ${name}: ${fn()}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}: ${err.message}`);
    }
  });
  console.log(failed ? `${failed} step(s) failed - see FAIL lines above.` : 'All checks passed.');
}

/* ------------------------------------------------------------------ */
/* HPB SG FoodID                                                      */
/* ------------------------------------------------------------------ */

function hpbSearch_(q, page) {
  const data = fetchJson_(`${HPB_API}/foods?pageNumber=${page}&searchText=${encodeURIComponent(q)}`);
  const list = Array.isArray(data) ? data : [];
  return {
    total: list.length ? Number(list[0].totalCount) || list.length : 0,
    items: list.filter(f => !f.isDeactivated).map(f => ({
      source: 'HPB',
      sourceId: f.crId,
      name: f.name,
      detail: [f.description, f.l2Category].filter(Boolean).join(' · '),
      needsDetails: true,
    })),
  };
}

function hpbDetails_(crId) {
  if (!/^[A-Za-z0-9]+$/.test(String(crId))) throw new Error('Invalid HPB food id.');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(`hpb:${crId}`);
  if (cached) return JSON.parse(cached);

  const d = fetchJson_(`${HPB_API}/foods/details/${crId}`);
  const b = d.baseFoodNutrients || {}; // per 100 g edible portion
  const food = {
    source: 'HPB',
    sourceId: d.crId,
    name: d.name,
    detail: d.description || '',
    per100g: {
      kcal: num_(b.energy),
      protein: num_(b.protein),
      carbs: num_(b.carbohydrate),
      sugar: num_(b.sugar),
      fat: num_(b.fat),
      satFat: num_(b.saturatedFat),
      sodium: num_(b.sodium),
      fibre: num_(b.dietaryFibre),
    },
    servingGrams: num_(d.defaultWeight) || 100,
    servingDesc: d.defaultPortion || '100 g',
    note: d.alternativePortions && d.alternativePortions !== '-' ? `Other portions: ${d.alternativePortions}` : '',
  };
  cache.put(`hpb:${crId}`, JSON.stringify(food), 21600);
  return food;
}

/* ------------------------------------------------------------------ */
/* Open Food Facts                                                    */
/* ------------------------------------------------------------------ */

/**
 * Uses the newer search service (search.openfoodfacts.org). Falls back to the
 * legacy cgi/search.pl, which often returns 503 to server-side callers.
 */
function offSearch_(q, page) {
  let products, count;
  try {
    const d = fetchJson_(`${OFF_SEARCH_API}/search?q=${encodeURIComponent(q)}&page=${page}&page_size=20&fields=${OFF_FIELDS}`);
    products = d.hits || [];
    count = d.count;
  } catch (err) {
    console.warn(`OFF search service failed, trying legacy search: ${err.message}`);
    const d = fetchJson_(`${OFF_API}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process`
      + `&json=1&page=${page}&page_size=20&fields=${OFF_FIELDS}`);
    products = d.products || [];
    count = d.count;
  }
  const items = products
    .filter(p => p.product_name && p.nutriments)
    .map(offToFood_)
    // Products sold in Singapore / Malaysia first.
    .sort((a, b) => Number(b.local) - Number(a.local));
  return { total: Number(count) || items.length, items };
}

function offBarcode_(code) {
  const d = fetchJson_(`${OFF_API}/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);
  if (!d.product || !d.product.product_name) return { total: 0, items: [] };
  return { total: 1, items: [offToFood_(Object.assign({ code }, d.product))] };
}

function offToFood_(p) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n.energy_100g != null) kcal = Number(n.energy_100g) / 4.184; // kJ -> kcal
  const servingG = num_(p.serving_quantity);
  const tags = p.countries_tags || [];
  return {
    source: 'OFF',
    sourceId: p.code,
    name: p.product_name,
    // The search service returns brands as an array, the product API as a string.
    detail: [[].concat(p.brands || []).join(', '), p.quantity].filter(Boolean).join(' · '),
    per100g: {
      kcal: round2_(num_(kcal)),
      protein: num_(n.proteins_100g),
      carbs: num_(n.carbohydrates_100g),
      sugar: num_(n.sugars_100g),
      fat: num_(n.fat_100g),
      satFat: num_(n['saturated-fat_100g']),
      sodium: round2_(num_(n.sodium_100g) * 1000), // g -> mg
      fibre: num_(n.fiber_100g),
    },
    servingGrams: servingG || 100,
    servingDesc: p.serving_size || (servingG ? `${servingG} g` : '100 g'),
    local: tags.includes('en:singapore') || tags.includes('en:malaysia'),
  };
}

/* ------------------------------------------------------------------ */
/* USDA FoodData Central                                              */
/* ------------------------------------------------------------------ */

function usdaSearch_(q, page) {
  const key = PropertiesService.getUserProperties().getProperty('USDA_API_KEY') || 'DEMO_KEY';
  const d = fetchJson_(`${USDA_API}/foods/search?api_key=${encodeURIComponent(key)}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      query: q,
      pageSize: 20,
      pageNumber: page,
      dataType: ['Foundation', 'SR Legacy', 'Survey (FNDDS)'],
    }),
  });
  const items = (d.foods || []).map(f => {
    const list = f.foodNutrients || [];
    const pick = numbers => {
      for (const no of numbers) {
        const hit = list.find(x => String(x.nutrientNumber) === no && x.value != null);
        if (hit) return num_(hit.value);
      }
      return 0;
    };
    return {
      source: 'USDA',
      sourceId: String(f.fdcId),
      name: f.description,
      detail: [f.dataType, f.foodCategory].filter(Boolean).join(' · '),
      per100g: {
        kcal: pick(['208', '958', '957']),
        protein: pick(['203']),
        carbs: pick(['205']),
        sugar: pick(['269', '269.3']),
        fat: pick(['204']),
        satFat: pick(['606']),
        sodium: pick(['307']),
        fibre: pick(['291']),
      },
      servingGrams: 100,
      servingDesc: '100 g',
    };
  });
  return { total: Number(d.totalHits) || items.length, items };
}

/* ------------------------------------------------------------------ */
/* Supplements (protein powder, creatine, others)                     */
/* ------------------------------------------------------------------ */

// Nutrients are per serving; creatine_g is creatine (monohydrate) per serving.
const SUPP_FILE = 'supplements.csv';
const SUPP_FOLDER = 'Supplements'; // label photos are kept here
const SUPP_TYPES = ['protein', 'creatine', 'other'];
const SUPP_HEADERS = ['id', 'name', 'type', 'url', 'serving_g', 'serving_desc', 'servings_per_pack',
  ...Object.values(NUTRIENT_COLS), 'creatine_g', 'notes', 'created_at', 'updated_at'];
const PAGE_HEADERS = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; MealTracker-AppsScript/1.0; personal use)' };

function getSupplements() {
  return readCsv_(getCsvFile_(SUPP_FILE, SUPP_HEADERS)).map(rowToSupp_);
}

/** Adds a supplement, or updates it when v.id is set. Returns the full list. */
function saveSupplement(v) {
  const name = safeText_(v && v.name);
  if (!name) throw new Error('Name is required.');
  const servingG = clampNum_(v.servingG);
  if (!servingG) throw new Error('Serving size in grams is required, e.g. 30 for one scoop.');
  if (v.type === 'creatine' && !clampNum_(v.creatineG)) throw new Error('Creatine per serving is required, e.g. 3 g.');
  const row = {
    name,
    type: SUPP_TYPES.includes(v.type) ? v.type : 'other',
    url: safeUrl_(v.url),
    serving_g: servingG,
    serving_desc: safeText_(v.servingDesc) || '1 scoop',
    servings_per_pack: clampNum_(v.servingsPerPack),
    creatine_g: clampNum_(v.creatineG),
    notes: safeText_(v.notes),
    updated_at: nowIso_(),
  };
  NUTRIENT_KEYS.forEach(k => { row[NUTRIENT_COLS[k]] = clampNum_(v.perServing && v.perServing[k]); });
  return withLock_(() => {
    const file = getCsvFile_(SUPP_FILE, SUPP_HEADERS);
    const rows = readCsv_(file);
    const i = v.id ? rows.findIndex(r => r.id === v.id) : -1;
    if (i >= 0) Object.assign(rows[i], row);
    else rows.push(Object.assign({ id: Utilities.getUuid(), created_at: nowIso_() }, row));
    writeCsv_(file, SUPP_HEADERS, rows);
    return rows.map(rowToSupp_);
  });
}

function deleteSupplement(id) {
  return withLock_(() => {
    const file = getCsvFile_(SUPP_FILE, SUPP_HEADERS);
    const rows = readCsv_(file).filter(r => r.id !== id);
    writeCsv_(file, SUPP_HEADERS, rows);
    return rows.map(rowToSupp_);
  });
}

/**
 * Reads a product page and pulls out the name, serving size and nutrition table.
 * Works for shops that put the table in the page itself (e.g. Myprotein); pages that
 * load it later with JavaScript or block scripts need a screenshot or pasted text instead.
 */
function readSupplementUrl(url) {
  const parsed = readProductPage_(url, false);
  parsed.values.type = guessSuppType_(parsed.values);
  return parsed;
}

/**
 * Fetches and reads a product page. allowPer100: for foods, a label with only a "per 100 g"
 * column is read as a 100 g serving. Supplements leave the serving empty instead, so the
 * real scoop size has to be entered.
 */
function readProductPage_(url, allowPer100) {
  const u = safeUrl_(url);
  if (!u) throw new Error('Enter the full product link, starting with https://');
  const res = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true, headers: PAGE_HEADERS });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`The shop's page could not be read (HTTP ${code}). Take a screenshot of the nutrition table instead.`);
  }
  const html = res.getContentText();
  const parsed = parseSupplementText_(htmlToText_(html), allowPer100);
  parsed.values.name = pageProductName_(html);
  parsed.values.url = u;
  return parsed;
}

/** Reads a photo/screenshot/PDF of a label with Google Drive OCR. */
function readSupplementImage(file) {
  const { text, original } = ocrUpload_(file, SUPP_FOLDER, 'Supplement', 'the nutrition label');
  const parsed = parseSupplementText_(text);
  parsed.values.type = guessSuppType_(parsed.values);
  parsed.fileName = original.getName();
  return parsed;
}

/*
 * Same readers for any food ("Manual" in Add food). Nutrients come back per serving,
 * with the serving weight when the label gives one. Label photos are kept in <folder>/Labels.
 */
const LABEL_FOLDER = 'Labels';

function readLabelUrl(url) {
  return readProductPage_(url, true);
}

function readLabelImage(file) {
  const { text, original } = ocrUpload_(file, LABEL_FOLDER, 'Label', 'the nutrition label');
  const parsed = parseSupplementText_(text, true);
  parsed.fileName = original.getName();
  return parsed;
}

function parseLabelText(text) {
  return parseSupplementText_(String(text || '').slice(0, 200000), true);
}

/** Text copied from a product page or label (e.g. from Safari). */
function parseSupplementText(text) {
  const parsed = parseSupplementText_(String(text || '').slice(0, 200000));
  parsed.values.type = guessSuppType_(parsed.values);
  return parsed;
}

/**
 * Finds the serving size and per-serving nutrients in label text. Handles EU-style tables
 * ("Per 100g / Per 30g" columns, kJ and kcal, salt), US "Supplement/Nutrition Facts"
 * (Serving Size 1 scoop (33 g), Calories, sodium mg) and active-ingredient lists
 * ("Creatine Monohydrate 3.4g"). When a per-100 g column exists, the per-serving value is
 * worked out from it, which is more precise than the rounded "<0.5g" printed per serving.
 * allowPer100: with only a "per 100 g/ml" column and no serving size, read it as a 100 g/ml
 * serving (right for foods; supplements need the real scoop size instead).
 */
function parseSupplementText_(raw, allowPer100) {
  const flat = String(raw || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  // The nutrition table: the first heading that's followed closely by an amount.
  const anchorRe = /typical values|nutrition(?:al)? (?:information|facts)|supplement facts|active ingredients|amount per serving|per 100 ?g/gi;
  let start = -1;
  for (const m of flat.matchAll(anchorRe)) {
    if (/\d\s*(?:g|mg|kcal|kj)\b/i.test(flat.slice(m.index, m.index + 300))) { start = m.index; break; }
  }
  let section = start >= 0 ? flat.slice(start, start + 1500) : flat.slice(0, 4000);
  // Stop at what follows the table. Only look after the first amount, so headings like
  // "Active Ingredients" or "% Daily Value" at the top don't cut it short.
  const firstAmt = Math.max(0, section.search(/\d\s*(?:g|mg|kcal|kj)\b/i));
  const end = section.slice(firstAmt).search(/reference intake|\bingredients\b|suggested use|directions|frequently asked|allergen|percent daily values|daily value not established/i);
  if (end >= 0) section = section.slice(0, firstAmt + end);

  // Column headings, e.g. "Per 100g Per 30g" or "Per Daily Serving".
  const head = section.slice(0, 250);
  const colMatches = [...head.matchAll(/per\s*(\d+(?:\.\d+)?)\s*(g|ml)\b|per\s+(?:daily\s+)?(?:serving|scoop|portion)/gi)];
  const cols = colMatches.map(m => (m[1] ? Number(m[1]) : 0));
  const per100Idx = cols.indexOf(100);
  const servIdx = cols.findIndex(c => c !== 100);

  // First match of a pattern whose group 1 is an amount and group 2 its unit (g or ml).
  let servingUnit = 'g';
  const firstNum = (re, s) => {
    const m = (s || flat).match(re);
    if (!m) return 0;
    if (m[2]) servingUnit = m[2].toLowerCase();
    return Number(m[1]);
  };
  let servingG = 0;
  if (servIdx >= 0 && cols[servIdx]) {
    servingG = cols[servIdx];
    servingUnit = colMatches[servIdx][2].toLowerCase();
  }
  servingG = servingG
    || firstNum(/per\s+(?:daily\s+)?serving\s*\(?\s*(\d+(?:\.\d+)?)\s*(g|ml)\b/i, section)
    || firstNum(/serving size\s*:?\s*(?:[\d.\/]+\s*(?:level\s+)?(?:scoops?|servings?|tbsp|tsp)\s*)?\(?\s*(\d+(?:\.\d+)?)\s*(g|ml)\b/i)
    || firstNum(/\bmix\s+(\d+(?:\.\d+)?)\s*(g)\b/i)
    || firstNum(/(\d+(?:\.\d+)?)\s*(g)\s*\(approx\.?\s*1\s*scoop\)/i);
  // Only a "per 100 g" column and no serving size (common on food packs): for foods, use 100 g as the serving.
  const per100Only = !!allowPer100 && !servingG && per100Idx >= 0 && servIdx < 0;
  if (per100Only) servingG = 100;
  const per100Unit = /per\s*100\s*ml\b/i.test(head) ? 'ml' : 'g'; // drinks are labelled per 100 ml
  const servingsPerPack = firstNum(/servings per (?:container|pack|tub)\s*:?\s*(?:about\s*)?(\d+)/i)
    || firstNum(/(?:contains|approx\.?)\s*(\d+)\s*servings/i) || firstNum(/\b(\d+)\s*servings\b/i);

  const NUM = /(<|less than\s*)?\s*(\d+(?:[.,]\d+)?)\s*(mcg|µg|mg|g|kcal|kj|%)?/gi;
  const toNum = s => Number(s.replace(/,(\d{3})\b/, '$1').replace(',', '.'));
  // Amounts straight after a label: "Protein 77g 23g" -> [77 g, 23 g]. %DV columns are ignored.
  // Singapore/Malaysia panels put the unit after the label instead: "Protein (g) 5.0 16.7".
  const valuesAfter = label => {
    const re = new RegExp(`(?:${label})\\s*(?:\\((mcg|µg|mg|g|kcal|kj)\\))?\\s*:?((?:\\s*(?:<|less than\\s*)?\\s*\\d+(?:[.,]\\d+)?\\s*(?:mcg|µg|mg|g|kcal|kj|%)?(?![a-z]))+)`, 'i');
    const m = section.match(re);
    if (!m) return null;
    const labelUnit = (m[1] || '').toLowerCase();
    return [...m[2].matchAll(NUM)].map(x => ({ v: toNum(x[2]), unit: (x[3] || labelUnit).toLowerCase(), lt: !!x[1] }))
      .filter(x => x.unit !== '%');
  };
  const convert = (x, to) => {
    const f = { mcg: 1e-6, 'µg': 1e-6, mg: 1e-3, g: 1, '': to === 'mg' ? 1e-3 : 1 }[x.unit];
    const grams = x.v * (f === undefined ? 1 : f);
    return to === 'mg' ? grams * 1000 : grams;
  };
  // One value per serving from the columns found.
  const pick = (vals, to) => {
    if (!vals || !vals.length) return null;
    let p100 = null;
    let serv = null;
    if (per100Idx >= 0 && servIdx >= 0) {
      // Two columns but one number: can't tell which column it belongs to, so leave it for the user.
      if (vals.length < 2) return null;
      p100 = vals[per100Idx];
      serv = vals[servIdx];
    } else if (cols.length === 1 && per100Idx === 0) p100 = vals[0];
    else serv = vals[0];
    if (p100 && servingG) return round2_(convert(p100, to) * servingG / 100);
    if (serv) return serv.lt ? 0 : round2_(convert(serv, to));
    return null;
  };

  const per = {};
  const kcal = [...section.matchAll(/(\d+(?:[.,]\d+)?)\s*kcal/gi)].map(m => ({ v: toNum(m[1]), unit: 'g', lt: false }));
  const kj = [...section.matchAll(/(\d+(?:[.,]\d+)?)\s*kj/gi)].map(m => ({ v: toNum(m[1]) / 4.184, unit: 'g', lt: false }));
  per.kcal = pick(kcal.length ? kcal : kj, 'g');
  if (per.kcal === null) {
    // "Energy (kcal) 120 400", "Energy (kJ) 502 1673" or US "Calories 120".
    let e = valuesAfter('\\b(?:energy|calories)(?=\\s*\\(kcal\\))') || valuesAfter('\\benergy|\\bcalories');
    // Keep one unit only, so "1673kJ 400kcal" isn't read as two columns.
    if (e && e.some(x => x.unit === 'kcal')) e = e.filter(x => x.unit === 'kcal');
    else if (e && e.some(x => x.unit === 'kj')) e = e.filter(x => x.unit === 'kj');
    per.kcal = pick(e && e.map(x => (x.unit === 'kj' ? { v: x.v / 4.184, unit: 'g', lt: x.lt } : Object.assign({}, x, { unit: 'g' }))), 'g');
  }
  per.protein = pick(valuesAfter('\\bprotein'), 'g');
  per.carbs = pick(valuesAfter('\\b(?:total\\s+)?carbohydrates?'), 'g');
  per.sugar = pick(valuesAfter('\\b(?:of which\\s+|total\\s+)?sugars?'), 'g');
  per.fat = pick(valuesAfter('(?<!saturated\\s|trans\\s)\\b(?:total\\s+)?fat'), 'g');
  per.satFat = pick(valuesAfter('\\b(?:of which\\s+)?saturates|\\bsaturated(?:\\s+fat)?'), 'g');
  per.fibre = pick(valuesAfter('\\b(?:dietary\\s+)?fib(?:re|er)'), 'g');
  per.sodium = pick(valuesAfter('\\bsodium'), 'mg');
  if (per.sodium === null) {
    const salt = pick(valuesAfter('\\bsalt'), 'g');
    if (salt !== null) per.sodium = round2_(salt * 400); // salt is 40% sodium
  }
  const creatine = pick(valuesAfter('\\bcreatine monohydrate'), 'g') ?? pick(valuesAfter('\\bcreatine'), 'g');

  const found = Object.values(per).filter(v => v !== null).length + (creatine ? 1 : 0);
  const perServing = {};
  NUTRIENT_KEYS.forEach(k => { perServing[k] = per[k] || 0; });
  return {
    values: {
      servingG: round2_(servingG),
      servingDesc: per100Only ? `100 ${per100Unit}` : /\bscoop/i.test(flat) ? '1 scoop' : '1 serving',
      servingUnit: per100Only ? per100Unit : servingUnit, // g or ml
      servingsPerPack,
      perServing,
      // Nutrients actually on the label (a 0 here is a real 0, not "not found").
      foundKeys: NUTRIENT_KEYS.filter(k => per[k] !== null && per[k] !== undefined),
      creatineG: creatine || 0,
    },
    found,
    text: section.slice(0, 1500),
  };
}

function guessSuppType_(v) {
  const name = String(v.name || '');
  const p = (v.perServing && v.perServing.protein) || 0;
  if (v.creatineG && p < (v.servingG || 0) * 0.3) return 'creatine';
  if (/whey|casein|protein|isolate/i.test(name) || (v.servingG && p >= v.servingG * 0.5)) return 'protein';
  if (/creatine/i.test(name)) return 'creatine';
  return 'other';
}

/** Page HTML -> plain text, one table cell / block per line. */
function htmlToText_(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]*\n\s*/g, '\n');
}

/** Product name from the page's structured data, then og:title, then <title>. */
function pageProductName_(html) {
  const ldMatch = String(html).match(/"@type"\s*:\s*"(?:Product|ProductGroup)"[\s\S]{0,400}?"name"\s*:\s*"((?:[^"\\]|\\.){2,150})"/);
  let ld = '';
  if (ldMatch) {
    try { ld = JSON.parse(`"${ldMatch[1]}"`); } catch (err) { ld = ldMatch[1]; } // decodes &, \" ...
  }
  const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=(["'])(.*?)\1/i);
  const title = String(html).match(/<title[^>]*>([^<]+)/i);
  const name = ld || (og && og[2]) || (title && title[1]) || '';
  // "Impact Creatine | Myprotein SG" -> "Impact Creatine" (but keep "Pre-Workout").
  return safeText_(htmlToText_(name).replace(/\s*\|[^|]*$/, '').replace(/\s+[–-]\s+[^–-]*$/, '').replace(/^buy\s+/i, '').trim()).slice(0, 120);
}

/** Only plain http(s) links are stored or fetched. */
function safeUrl_(v) {
  const s = String(v || '').trim();
  return /^https?:\/\/[^\s"'<>]{3,500}$/i.test(s) ? s : '';
}

function rowToSupp_(r) {
  const perServing = {};
  NUTRIENT_KEYS.forEach(k => { perServing[k] = num_(r[NUTRIENT_COLS[k]]); });
  return {
    id: r.id,
    name: r.name,
    type: SUPP_TYPES.includes(r.type) ? r.type : 'other',
    url: safeUrl_(r.url), // re-checked in case the CSV was edited by hand
    servingG: num_(r.serving_g),
    servingDesc: r.serving_desc || '1 scoop',
    servingsPerPack: num_(r.servings_per_pack),
    perServing,
    creatineG: num_(r.creatine_g),
    notes: r.notes,
  };
}

/* ------------------------------------------------------------------ */
/* Apple Health + openGym                                             */
/* ------------------------------------------------------------------ */

const GYM_BODY_FILE = 'gym_body.csv';
const GYM_INBOX_FOLDER = 'openGym inbox'; // must match the Health Bridge
const GYM_BODY_HEADERS = ['date', 'weight_kg', 'body_fat_pct'];

/** Summarises openGym's per-set rows into one row per session and merges them in. */
function importGymWorkouts_(head, rows) {
  const col = name => head.indexOf(name);
  const get = (r, name) => (col(name) >= 0 ? String(r[col(name)] || '').replace(/^'/, '').trim() : '');
  const sessions = new Map();
  rows.forEach(r => {
    const date = get(r, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const start = get(r, 'start_time');
    const name = get(r, 'workout');
    const key = `${date}|${start}|${name}`;
    if (!sessions.has(key)) {
      sessions.set(key, { key, date, start, end: get(r, 'end_time'), name, sets: 0, volume: 0, cardioSec: 0,
        exercises: new Set(), parts: new Set() });
    }
    const s = sessions.get(key);
    const type = get(r, 'set_type');
    const exercise = get(r, 'exercise');
    if (exercise) s.exercises.add(exercise);
    if (get(r, 'body_part')) s.parts.add(get(r, 'body_part'));
    // openGym fills distance_km on every cardio row (even "0") and leaves it empty for holds like planks.
    if (get(r, 'distance_km') !== '') {
      s.cardioSec += parseFloat(get(r, 'seconds')) || 0;
      return;
    }
    // Same rule as openGym's volume: warm-ups don't count; drop sets add volume but not a set.
    if (type === 'warmup') return;
    if (type !== 'drop') s.sets++;
    const w = parseFloat(get(r, 'weight')) || 0;
    const reps = parseFloat(get(r, 'reps')) || 0;
    s.volume += w * reps * (get(r, 'unit') === 'lb' ? LB_TO_KG : 1);
  });
  return saveGymSessions_([...sessions.values()]);
}

/** Writes summarised sessions ({key, date, start, end, name, sets, volume, cardioSec, exercises, parts}). */
function saveGymSessions_(sessions, kind) {
  if (!sessions.length) throw new Error('No workouts found in the file.');
  const now = nowIso_();
  const imported = sessions.map(s => ({
    key: s.key,
    date: s.date,
    start: safeText_(s.start),
    end: safeText_(s.end),
    name: safeText_(s.name) || 'Workout',
    duration_min: minutesBetween_(s.start, s.end),
    sets: s.sets,
    volume_kg: Math.round(s.volume),
    cardio_min: Math.round(s.cardioSec / 60),
    exercises: safeText_([...s.exercises].join('; ')),
    body_parts: safeText_([...s.parts].join('; ')),
    imported_at: now,
  }));
  return withLock_(() => {
    const file = getCsvFile_(GYM_FILE, GYM_HEADERS);
    const keys = new Set(imported.map(x => x.key));
    const existing = readCsv_(file);
    // The JSON backup has no muscle names for built-in exercises; keep the CSV import's names if there are any.
    const old = new Map(existing.map(r => [r.key, r]));
    imported.forEach(x => {
      const prev = old.get(x.key);
      if (prev && !x.body_parts && prev.body_parts) {
        x.exercises = prev.exercises;
        x.body_parts = prev.body_parts;
      }
    });
    const rows2 = existing.filter(r => !keys.has(r.key)).concat(imported)
      .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));
    writeCsv_(file, GYM_HEADERS, rows2);
    const dates = imported.map(x => x.date).sort();
    return { kind: kind || 'workouts', count: imported.length, from: dates[0], to: dates[dates.length - 1] };
  });
}

/** openGym's body file: weight per day (kg or lb) and body fat % if logged. */
function importGymBody_(head, rows) {
  const wCol = head.findIndex(h => /^weight_(kg|lb)$/.test(h));
  const toKg = head[wCol] === 'weight_lb' ? LB_TO_KG : 1;
  const fCol = head.findIndex(h => /fat/.test(h));
  const imported = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0])).map(r => ({
    date: r[0],
    weight_kg: parseFloat(r[wCol]) > 0 ? Math.round(parseFloat(r[wCol]) * toKg * 10) / 10 : '',
    body_fat_pct: fCol >= 0 && parseFloat(r[fCol]) > 0 ? parseFloat(r[fCol]) : '',
  })).filter(r => r.weight_kg || r.body_fat_pct);
  return saveGymBody_(imported);
}

function saveGymBody_(imported) {
  if (!imported.length) throw new Error('No weigh-ins found in the file.');
  return withLock_(() => {
    const file = getCsvFile_(GYM_BODY_FILE, GYM_BODY_HEADERS);
    const dates = new Set(imported.map(x => x.date));
    const all = readCsv_(file).filter(r => !dates.has(r.date)).concat(imported)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    writeCsv_(file, GYM_BODY_HEADERS, all);
    const d = imported.map(x => x.date).sort();
    return { kind: 'body', count: imported.length, from: d[0], to: d[d.length - 1] };
  });
}

/**
 * openGym's JSON backup is its raw app state: workouts[] with start/end (epoch ms), d (day),
 * name and entries[] of { id, sets[] }. Sets hold w (weight in the app's unit), r (reps),
 * done, phase/warmup, type ('dropset' + drops[], 'restpause' + clusters[]), min/speed for cardio,
 * and sides.L / sides.R for one-side-at-a-time sets. Counted with the same rules as the CSV import.
 */
function importOpenGymJson_(raw) {
  const state = raw && Array.isArray(raw.workouts) ? raw
    : [raw && raw.state, raw && raw.data].find(x => x && Array.isArray(x.workouts));
  if (!state) throw new Error('This is not an openGym backup file.');
  const tz = Session.getScriptTimeZone();
  const toKg = state.unit === 'lb' ? LB_TO_KG : 1;
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const at = ms => (n(ms) > 0 ? Utilities.formatDate(new Date(n(ms)), tz, 'yyyy-MM-dd HH:mm') : '');
  const custom = new Map((Array.isArray(state.customEx) ? state.customEx : [])
    .filter(x => x && x.id).map(x => [String(x.id), x]));
  const exName = id => {
    const c = custom.get(String(id));
    if (c && c.n) return String(c.n);
    return String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  };
  const isWarmup = s => {
    const phase = String(s.phase || '').trim().toLowerCase();
    return phase ? /^warm[-_ ]?up$/.test(phase) : s.warmup === true;
  };

  const sessions = [];
  state.workouts.forEach(w => {
    if (!w || !Array.isArray(w.entries)) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(w.d || '')) ? String(w.d)
      : n(w.start) > 0 ? Utilities.formatDate(new Date(n(w.start)), tz, 'yyyy-MM-dd') : '';
    if (!date) return;
    const start = at(w.start);
    const name = String(w.name || '');
    const s = { key: `${date}|${start}|${name}`, date, start, end: n(w.end) > n(w.start) ? at(w.end) : '', name,
      sets: 0, volume: 0, cardioSec: 0, exercises: new Set(), parts: new Set() };
    w.entries.forEach(e => {
      if (!e || !Array.isArray(e.sets)) return;
      let any = false;
      e.sets.forEach(set => {
        if (!set) return;
        const sided = set.sides && set.sides.L && set.sides.R;
        const rows = (sided ? [set.sides.L, set.sides.R] : [set]).filter(x => x && x.done === true);
        rows.forEach(x => {
          any = true;
          const cardio = !(n(x.r) > 0) && (set.mode === 'cardio' || x.min != null || x.speed != null);
          if (cardio) {
            s.cardioSec += n(x.min) * 60;
            return;
          }
          if (isWarmup(set)) return;
          s.sets++;
          s.volume += n(x.w) * n(x.r) * toKg;
          if (set.type === 'dropset' && Array.isArray(x.drops)) {
            x.drops.forEach(d => { s.volume += n(d && d.w) * n(d && d.r) * toKg; });
          }
          if (set.type === 'restpause' && Array.isArray(x.clusters)) {
            x.clusters.forEach(c => { s.volume += n(x.w) * n(c && c.r) * toKg; });
          }
        });
      });
      if (!any) return;
      s.exercises.add(exName(e.id));
      const c = custom.get(String(e.id));
      if (c && c.bp) s.parts.add(String(c.bp));
    });
    if (s.exercises.size) sessions.push(s);
  });

  // Weigh-ins: bodyweight[] of { d, w } in the app's unit; body fat comes from measurements if logged.
  const fat = new Map();
  (Array.isArray(state.measurements) ? state.measurements : []).forEach(m => {
    const k = m && Object.keys(m).find(x => /fat/i.test(x) && n(m[x]) > 0 && n(m[x]) < 75);
    if (k) fat.set(m.d, n(m[k]));
  });
  const weighIns = (Array.isArray(state.bodyweight) ? state.bodyweight : [])
    .filter(b => b && /^\d{4}-\d{2}-\d{2}$/.test(String(b.d)) && n(b.w) > 0)
    .map(b => ({ date: b.d, weight_kg: Math.round(n(b.w) * toKg * 10) / 10, body_fat_pct: fat.get(b.d) || '' }));
  if (!sessions.length && !weighIns.length) throw new Error('No finished workouts or weigh-ins found in the backup.');
  // A backup with only weigh-ins (no finished workouts yet) is still imported.
  const result = sessions.length ? saveGymSessions_(sessions, 'backup') : { kind: 'backup', count: 0, from: '', to: '' };
  if (weighIns.length) {
    const b = saveGymBody_(weighIns);
    result.weighIns = b.count;
    if (!sessions.length) Object.assign(result, { from: b.from, to: b.to });
  }
  return result;
}

/**
 * Files the iPhone share-sheet Shortcut sent through the Health Bridge wait in
 * "<folder>/openGym inbox". They're imported here (oldest first) and moved to the Drive
 * trash once done (restorable for 30 days). A file that fails is renamed "FAILED - ..." and left.
 */
function processGymInbox_() {
  const it = getFolder_().getFoldersByName(GYM_INBOX_FOLDER);
  if (!it.hasNext()) return null;
  const files = [];
  const fi = it.next().getFiles();
  while (fi.hasNext()) {
    const f = fi.next();
    if (!/^FAILED - /.test(f.getName())) files.push(f);
  }
  if (!files.length) return null;
  files.sort((a, b) => (a.getName() < b.getName() ? -1 : 1));
  const out = { files: 0, workouts: 0, errors: [] };
  files.forEach(f => {
    try {
      const r = importOpenGymFile(f.getBlob().getDataAsString('UTF-8'));
      out.files++;
      out.workouts += r.kind === 'body' ? 0 : r.count;
      f.setTrashed(true);
    } catch (err) {
      out.errors.push(`${f.getName()}: ${err.message}`);
      f.setName(`FAILED - ${f.getName()}`);
    }
  });
  return out;
}

/** "2026-03-02 18:05" -> "2026-03-02 19:10" = 65. */
function minutesBetween_(a, b) {
  const parse = s => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
  };
  const d = (parse(b) - parse(a)) / 60000;
  return Number.isFinite(d) && d > 0 && d < 24 * 60 ? Math.round(d) : '';
}

function rowToHealth_(r) {
  let workouts = [];
  try { workouts = r.workouts_json ? JSON.parse(r.workouts_json) : []; } catch (err) { workouts = []; }
  return {
    date: r.date,
    steps: num_(r.steps),
    activeKcal: num_(r.active_kcal),
    exerciseMin: num_(r.exercise_min),
    weightKg: num_(r.weight_kg),
    bodyFatPct: num_(r.body_fat_pct),
    workouts,
  };
}

function rowToGym_(r) {
  return {
    date: r.date,
    start: r.start,
    name: r.name,
    durationMin: num_(r.duration_min),
    sets: num_(r.sets),
    volumeKg: num_(r.volume_kg),
    cardioMin: num_(r.cardio_min),
    exercises: r.exercises ? r.exercises.split('; ') : [],
    bodyParts: r.body_parts ? r.body_parts.split('; ') : [],
  };
}

function lastHealthDate_() {
  const rows = readCsv_(getCsvFile_(HEALTH_FILE, HEALTH_HEADERS));
  return rows.length ? rows.map(r => r.date).sort().pop() : '';
}

/* ------------------------------------------------------------------ */
/* InBody parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Pulls the key numbers out of OCR text. InBody sheets differ by model, and OCR
 * can scramble the layout, so for each label we take the first number after it
 * that falls in a plausible range. Anything not found is left null for the user
 * to fill in, and missing values are derived where possible.
 */
function parseInBody_(text) {
  const t = String(text || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');
  const v = {
    weightKg: findValue_(t, ['\\bWeight\\b(?!\\s*Control)'], 25, 250),
    smmKg: findValue_(t, ['Skeletal Muscle Mass', '\\bSMM\\b'], 8, 80),
    bodyFatKg: findValue_(t, ['Body Fat Mass'], 1, 150),
    pbf: findValue_(t, ['\\bPBF\\b', 'Percent Body Fat', 'Body Fat Percentage', 'Body Fat %'], 3, 75),
    ffmKg: findValue_(t, ['Fat Free Mass', '\\bFFM\\b'], 20, 150),
    bmi: findValue_(t, ['\\bBMI\\b', 'Body Mass Index'], 12, 70),
    bmr: findValue_(t, ['Basal Metabolic Rate', '\\bBMR\\b'], 700, 4000),
    visceralFat: findValue_(t, ['Visceral Fat Level', 'Visceral Fat'], 1, 30),
    score: findValue_(t, ['InBody Score'], 30, 110),
    heightCm: findValue_(t, ['\\bHeight\\b'], 120, 220),
    age: findValue_(t, ['\\bAge\\b'], 10, 100),
    sex: /\bFemale\b/i.test(t) ? 'F' : /\bMale\b/i.test(t) ? 'M' : '',
    scanDate: findDate_(t),
  };
  const derived = [];
  const r1 = n => Math.round(n * 10) / 10;
  if (!v.ffmKg && v.weightKg && v.bodyFatKg) { v.ffmKg = r1(v.weightKg - v.bodyFatKg); derived.push('ffmKg'); }
  if (!v.bodyFatKg && v.weightKg && v.pbf) { v.bodyFatKg = r1(v.weightKg * v.pbf / 100); derived.push('bodyFatKg'); }
  if (!v.pbf && v.weightKg && v.bodyFatKg) { v.pbf = r1(v.bodyFatKg / v.weightKg * 100); derived.push('pbf'); }
  if (!v.ffmKg && v.weightKg && v.bodyFatKg) { v.ffmKg = r1(v.weightKg - v.bodyFatKg); derived.push('ffmKg'); }
  if (!v.bmi && v.weightKg && v.heightCm) { v.bmi = r1(v.weightKg / Math.pow(v.heightCm / 100, 2)); derived.push('bmi'); }
  // InBody's own BMR formula (Katch-McArdle): 370 + 21.6 x fat-free mass.
  if (!v.bmr && v.ffmKg) { v.bmr = Math.round(370 + 21.6 * v.ffmKg); derived.push('bmr'); }
  v.derived = derived;
  return v;
}

function findValue_(text, labels, min, max) {
  for (const label of labels) {
    // OCR often breaks long labels over lines ("Skeletal\nMuscle Mass"), so any space matches any whitespace.
    const re = new RegExp(label.replace(/ /g, '\\s+'), 'gi');
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[0].length;
      const nums = text.slice(start, start + 120).match(/\d{1,4}(?:[.,]\d{1,2})?/g) || [];
      for (const s of nums) {
        const n = parseFloat(s.replace(',', '.'));
        if (n >= min && n <= max) return n;
      }
    }
  }
  return null;
}

/** First date on the sheet as yyyy-MM-dd (InBody prints 2025.03.14 or 14.03.2025). */
function findDate_(text) {
  const pad = n => String(n).padStart(2, '0');
  let m = text.match(/\b(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})\b/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

function sanitizeScan_(v) {
  const out = {};
  INBODY_FIELDS.forEach(k => { out[k] = clampNum_(v[k]); });
  out.scanDate = /^\d{4}-\d{2}-\d{2}$/.test(String(v.scanDate))
    ? v.scanDate : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  out.sex = ['M', 'F'].includes(v.sex) ? v.sex : '';
  return out;
}

function getInBodyScans_() {
  return readCsv_(getCsvFile_(INBODY_FILE, INBODY_HEADERS))
    .map(r => {
      const s = { id: r.id, sourceFile: r.source_file };
      INBODY_FIELDS.forEach((k, i) => { s[k] = r[INBODY_HEADERS[i + 1]]; });
      INBODY_FIELDS.filter(k => !['scanDate', 'sex'].includes(k)).forEach(k => { s[k] = num_(s[k]); });
      return s;
    })
    .sort((a, b) => (a.scanDate < b.scanDate ? -1 : a.scanDate > b.scanDate ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Drive / CSV helpers                                                */
/* ------------------------------------------------------------------ */

function getFolder_() {
  let folder = DriveApp.getRootFolder();
  getSettings_().folderPath.split('/').filter(Boolean).forEach(name => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  return folder;
}

function getSubFolder_(name) {
  const parent = getFolder_();
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getCsvFile_(name, headers) {
  const folder = getFolder_();
  const it = folder.getFilesByName(name);
  if (it.hasNext()) return it.next();
  return folder.createFile(name, toCsv_([headers]), MimeType.CSV);
}

function readCsv_(file) {
  const text = file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const rows = Utilities.parseCsv(text);
  const head = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(c => c !== ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])));
}

function writeCsv_(file, headers, rows) {
  file.setContent(toCsv_([headers, ...rows.map(o => headers.map(h => (o[h] !== undefined ? o[h] : '')))]));
}

function toCsv_(rows) {
  return rows.map(r => r.map(csvCell_).join(',')).join('\r\n') + '\r\n';
}

function csvCell_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function entryToRow_(e) {
  const row = {
    id: e.id, date: e.date, meal: e.meal, food_name: e.name, source: e.source, source_id: e.sourceId,
    quantity: e.quantity, unit: e.unit, grams: e.grams, notes: e.notes, created_at: e.createdAt,
  };
  NUTRIENT_KEYS.forEach(k => { row[NUTRIENT_COLS[k]] = e.n[k]; });
  return row;
}

function rowToEntry_(r) {
  const n = {};
  NUTRIENT_KEYS.forEach(k => { n[k] = num_(r[NUTRIENT_COLS[k]]); });
  return {
    id: r.id, date: r.date, meal: r.meal, name: r.food_name, source: r.source, sourceId: r.source_id,
    quantity: num_(r.quantity), unit: r.unit, grams: num_(r.grams), notes: r.notes, createdAt: r.created_at, n,
  };
}

function rowToMyFood_(r) {
  const perServing = {};
  NUTRIENT_KEYS.forEach(k => { perServing[k] = num_(r[NUTRIENT_COLS[k]]); });
  let ingredients = [];
  try { ingredients = r.ingredients_json ? JSON.parse(r.ingredients_json) : []; } catch (err) { ingredients = []; }
  return {
    source: 'MY',
    sourceId: r.id,
    name: r.name,
    detail: ingredients.length ? `${ingredients.length} ingredients` : 'Custom food',
    perServing,
    servingGrams: num_(r.serving_g),
    servingDesc: r.serving_desc || '1 serving',
    ingredients,
  };
}

function sanitizeEntry_(e) {
  if (!e) throw new Error('Empty entry.');
  assertDate_(e.date);
  if (!MEALS.includes(e.meal)) throw new Error(`Invalid meal: ${e.meal}`);
  const name = safeText_(e.name);
  if (!name) throw new Error('Food name is required.');
  const n = {};
  NUTRIENT_KEYS.forEach(k => { n[k] = clampNum_(e.n && e.n[k]); });
  return {
    id: Utilities.getUuid(),
    date: e.date,
    meal: e.meal,
    name,
    source: ['HPB', 'OFF', 'USDA', 'MY', 'MANUAL', 'SUPP'].includes(e.source) ? e.source : 'MANUAL',
    sourceId: safeText_(e.sourceId),
    quantity: clampNum_(e.quantity),
    unit: UNITS.includes(e.unit) ? e.unit : 'serving',
    grams: clampNum_(e.grams),
    notes: safeText_(e.notes),
    createdAt: nowIso_(),
    n,
  };
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                       */
/* ------------------------------------------------------------------ */

function fetchJson_(url, opts) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, headers: HTTP_HEADERS }, opts || {}));
  const code = res.getResponseCode();
  const where = url.split('?')[0]; // never echo query strings (may hold an API key)
  if (code === 429) throw new Error('Food database rate limit reached. Wait a minute and try again.');
  const body = res.getContentText();
  // First bit of the reply, tags stripped, to tell e.g. a firewall block page from an API error.
  const snippet = () => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (code < 200 || code >= 300) throw new Error(`Lookup failed (HTTP ${code}) at ${where}: ${snippet()}`);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`Unexpected (non-JSON) response from ${where}: ${snippet()}`);
  }
}

function getSettings_() {
  const raw = PropertiesService.getUserProperties().getProperty('SETTINGS');
  const s = raw ? JSON.parse(raw) : {};
  return Object.assign({}, DEFAULT_SETTINGS, s, {
    targets: Object.assign({}, DEFAULT_SETTINGS.targets, s.targets || {}),
  });
}

function publicSettings_() {
  const s = getSettings_();
  s.hasUsdaKey = !!PropertiesService.getUserProperties().getProperty('USDA_API_KEY');
  return s;
}

/** Each user's CSV files are their own, so one user's save never waits for another's. */
function withLock_(fn) {
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function assertDate_(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error(`Invalid date: ${d}`);
}

/** Trims, limits length, and stops spreadsheet formula injection when the CSV is opened in Sheets. */
function safeText_(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** Number or 0. HPB uses -1 for "not available". */
function num_(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampNum_(v) {
  return round2_(Math.min(num_(v), 1e6));
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}
