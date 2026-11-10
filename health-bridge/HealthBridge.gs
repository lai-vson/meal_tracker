/**
 * Meal Tracker - Health Bridge (receive-only).
 *
 * A separate, tiny Apps Script web app that iPhone Shortcuts can POST to.
 * It only ACCEPTS data: a day's Apple Health numbers (written to health_daily.csv)
 * or an openGym file shared from the iPhone (dropped in "openGym inbox" for the
 * Meal Tracker to import). It never returns any stored data, so even someone
 * with the URL and key could not read anything.
 *
 * Setup (details in HEALTH_SYNC.md):
 *   1. Paste this file into a NEW Apps Script project ("Meal Tracker Health Bridge").
 *   2. Run setupBridge() once and copy the key it prints into your Shortcut.
 *   3. Deploy > New deployment > Web app: Execute as Me, Who has access: Anyone.
 */

const DEFAULT_FOLDER_PATH = 'Meal'; // must match the Meal Tracker folder setting
const HEALTH_FILE = 'health_daily.csv';
const HEALTH_HEADERS = ['date', 'steps', 'active_kcal', 'exercise_min', 'weight_kg', 'body_fat_pct',
  'workouts_json', 'updated_at'];
const MAX_BODY_BYTES = 20000;
// openGym files shared from the iPhone (JSON backup or CSV export). They're only stored here;
// the Meal Tracker imports them from this folder the next time it opens.
const GYM_INBOX_FOLDER = 'openGym inbox'; // must match the Meal Tracker
const MAX_GYM_FILE_BYTES = 20 * 1024 * 1024;

/** Run once from the editor. Creates (or replaces) the secret key and prints it. */
function setupBridge() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BRIDGE_KEY', key);
  if (!props.getProperty('FOLDER_PATH')) props.setProperty('FOLDER_PATH', DEFAULT_FOLDER_PATH);
  getHealthFile_(); // creates the folder/CSV and triggers the Drive permission prompt
  console.log(`Bridge key (put this in your Shortcut, keep it private):\n${key}`);
  console.log('Running setupBridge() again makes a new key and the old one stops working.');
}

/** Opening the URL in a browser shows nothing useful on purpose. */
function doGet() {
  return ContentService.createTextOutput('Meal Tracker health bridge is running.');
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > MAX_GYM_FILE_BYTES + 2000) return reply_(false, 'Request too large.');
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return reply_(false, 'Body is not valid JSON.');
    }
    const key = PropertiesService.getScriptProperties().getProperty('BRIDGE_KEY');
    if (!key || !safeEquals_(String(body.key || ''), key)) return reply_(false, 'Wrong key.');
    if (body.kind === 'opengym') return saveGymFile_(body);
    if (raw.length > MAX_BODY_BYTES) return reply_(false, 'Request too large.');

    const row = toRow_(body);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const file = getHealthFile_();
      const rows = readCsv_(file).filter(r => r.date !== row.date); // one row per day: re-sending a day replaces it
      rows.push(row);
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      file.setContent(toCsv_([HEALTH_HEADERS, ...rows.map(r => HEALTH_HEADERS.map(h => r[h]))]));
    } finally {
      lock.releaseLock();
    }
    return reply_(true, `Saved ${row.date}.`);
  } catch (err) {
    return reply_(false, err.message);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Stores a shared openGym file in "<folder>/openGym inbox". Only a quick shape check is done
 * here; the Meal Tracker does the real import (and reports problems) when it opens.
 */
function saveGymFile_(b) {
  const text = String(b.file == null ? '' : b.file).replace(/^﻿/, '');
  if (!text.trim()) return reply_(false, 'The shared file is empty.');
  const firstLine = text.slice(0, 2000).split(/\r?\n/)[0].toLowerCase();
  let ext = '';
  if (/^\s*\{/.test(text)) {
    try {
      const s = JSON.parse(text);
      const st = Array.isArray(s.workouts) ? s : [s.state, s.data].find(x => x && Array.isArray(x.workouts));
      if (st) ext = 'json';
    } catch (err) { /* falls through to the error below */ }
  } else if (/\bset_type\b/.test(firstLine) || /^date,.*weight_(kg|lb)/.test(firstLine)) {
    ext = 'csv';
  }
  if (!ext) return reply_(false, 'Not an openGym backup (.json) or CSV export.');

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const label = String(b.name || 'opengym').replace(/\.[a-z]+$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const parent = getHealthFile_().getParents().next();
    const it = parent.getFoldersByName(GYM_INBOX_FOLDER);
    const inbox = it.hasNext() ? it.next() : parent.createFolder(GYM_INBOX_FOLDER);
    inbox.createFile(`${stamp}-${label}.${ext}`, text, ext === 'json' ? MimeType.PLAIN_TEXT : MimeType.CSV);
  } finally {
    lock.releaseLock();
  }
  return reply_(true, 'Sent to Meal Tracker. It imports when you next open the app.');
}

function toRow_(b) {
  const date = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be yyyy-MM-dd.');
  return {
    date,
    steps: num_(b.steps, 0, 200000, 0),
    active_kcal: num_(b.activeKcal, 0, 10000, 0),
    exercise_min: num_(b.exerciseMin, 0, 1440, 0),
    weight_kg: num_(b.weightKg, 20, 400, 1),
    body_fat_pct: pct_(b.bodyFatPct),
    workouts_json: JSON.stringify(workouts_(b.workouts)),
    updated_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"),
  };
}

/**
 * Workouts from the Shortcut, either as a list of {name, source, minutes} objects or as
 * text with one workout per line: "name ; source ; minutes".
 */
function workouts_(w) {
  let list = [];
  if (Array.isArray(w)) list = w;
  else if (typeof w === 'string') {
    list = w.split(/\r?\n/).filter(s => s.trim()).map(line => {
      const [name, source, minutes] = line.split(';').map(s => s.trim());
      return { name, source, minutes };
    });
  }
  return list.slice(0, 20).map(x => ({
    name: text_(x && x.name),
    source: text_(x && x.source),
    minutes: num_(x && x.minutes, 0, 1440, 0),
  })).filter(x => x.name || x.minutes);
}

/** Health numbers arrive with units or commas ("8,123", "62.4 kg"); keep the number only. */
function num_(v, min, max, dp) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) return '';
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/** Shortcuts gives body fat as 0.252 or 25.2 depending on the unit chosen. */
function pct_(v) {
  let n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1) n *= 100;
  return n <= 75 ? Math.round(n * 10) / 10 : '';
}

function text_(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function safeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(ok, message) {
  return ContentService.createTextOutput(JSON.stringify({ ok, message }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getHealthFile_() {
  const path = PropertiesService.getScriptProperties().getProperty('FOLDER_PATH') || DEFAULT_FOLDER_PATH;
  let folder = DriveApp.getRootFolder();
  path.split('/').map(s => s.trim()).filter(Boolean).forEach(name => {
    const it = folder.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : folder.createFolder(name);
  });
  const it = folder.getFilesByName(HEALTH_FILE);
  return it.hasNext() ? it.next() : folder.createFile(HEALTH_FILE, toCsv_([HEALTH_HEADERS]), MimeType.CSV);
}

function readCsv_(file) {
  const text = file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const rows = Utilities.parseCsv(text);
  const head = rows.shift();
  return rows.filter(r => r.some(c => c !== ''))
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])));
}

function toCsv_(rows) {
  return rows.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}
