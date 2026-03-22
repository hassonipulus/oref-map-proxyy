import express from 'express';
import { readFileSync, appendFileSync } from 'fs';

const PORT = 3001;
const DEBUG = process.argv.includes('--debug');

const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const ALERTS_URL   = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';
const HISTORY_URL  = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
const EXTENDED_URL = 'https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1';

const LIVE_POLL_MS    = 1000;   // every 1s — mirrors production
const HISTORY_POLL_MS = 10000;  // every 10s — mirrors production
const EXTENDED_TTL_MS = 60000;  // cache extended history for 60s

// --- Debug mode: load interesting-map.json ---

const DEBUG_TIMESTAMP = '2026-03-14T16:38';

function loadDebugData() {
  const raw = readFileSync(new URL('./interesting-map.json', import.meta.url), 'utf8');
  const entries = JSON.parse(raw); // alarms-history format

  // Convert to history format: alertDate ISO → "YYYY-MM-DD HH:MM:SS", category_desc → title
  const historyEntries = entries.map(e => ({
    alertDate: e.alertDate.replace('T', ' '),
    title: e.category_desc,
    data: e.data,
    category: e.category,
  }));

  // Build alerts response from entries active at DEBUG_TIMESTAMP
  // Group locations by title; take the first (highest priority) title group
  const atTime = entries.filter(e => e.alertDate.startsWith(DEBUG_TIMESTAMP));
  const byTitle = {};
  for (const e of atTime) {
    if (!byTitle[e.category_desc]) byTitle[e.category_desc] = { cat: e.category, rid: e.rid, locations: [] };
    byTitle[e.category_desc].locations.push(e.data);
  }
  const firstTitle = Object.keys(byTitle)[0];
  const alertsBody = firstTitle
    ? JSON.stringify({
        id:    String(byTitle[firstTitle].rid),
        cat:   byTitle[firstTitle].cat,
        title: firstTitle,
        desc:  firstTitle,
        data:  byTitle[firstTitle].locations,
      })
    : '\ufeff';

  return {
    extended: raw,
    history: JSON.stringify(historyEntries),
    alerts: alertsBody,
  };
}

const USAGE_LOG = new URL('./usage.log', import.meta.url).pathname;

// --- In-memory cache ---

const cache = {
  alerts:  { body: '\ufeff', updatedAt: null },  // BOM = no active alert (Oref convention)
  history: { body: '[]',     updatedAt: null },
  extended: { body: '[]',    updatedAt: null, fetchedAt: null },
};

// --- Fetch helpers ---

async function fetchOref(url) {
  const resp = await fetch(url, { headers: OREF_HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.text();
}

// --- Polling ---

async function pollAlerts() {
  try {
    cache.alerts.body = await fetchOref(ALERTS_URL);
    cache.alerts.updatedAt = Date.now();
  } catch (err) {
    console.error('[alerts] poll error:', err.message);
  }
}

async function pollHistory() {
  try {
    cache.history.body = await fetchOref(HISTORY_URL);
    cache.history.updatedAt = Date.now();
  } catch (err) {
    console.error('[history] poll error:', err.message);
  }
}

let extendedInFlight = null;

async function fetchExtended() {
  if (extendedInFlight) return extendedInFlight;
  extendedInFlight = fetchOref(EXTENDED_URL).then(body => {
    cache.extended.body = body;
    cache.extended.fetchedAt = Date.now();
    cache.extended.updatedAt = Date.now();
  }).finally(() => {
    extendedInFlight = null;
  });
  return extendedInFlight;
}

// --- Express app ---

const app = express();

// Allow cross-origin requests from the local web-server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://oref-map.org');
  next();
});

// Count incoming requests for usage log
let requestCount = 0;
app.use((req, res, next) => { requestCount++; next(); });

let currentMinute = null;

setInterval(() => {
  const now = new Date();
  const minute = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  if (minute !== currentMinute) {
    const prefix = currentMinute === null ? '' : '\n';
    appendFileSync(USAGE_LOG, `${prefix}${minute} `);
    currentMinute = minute;
  }
  appendFileSync(USAGE_LOG, `${requestCount}, `);
  requestCount = 0;
}, 2000);

app.get(['/api/alerts', '/api2/alerts'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.alerts.body);
});

app.get(['/api/history', '/api2/history'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.history.body);
});

app.get(['/api/alarms-history', '/api2/alarms-history'], async (req, res) => {
  const age = cache.extended.fetchedAt ? Date.now() - cache.extended.fetchedAt : Infinity;
  if (age > EXTENDED_TTL_MS) {
    try {
      await fetchExtended();
    } catch (err) {
      console.error('[alarms-history] fetch error:', err.message);
      // Return stale data if available, empty array otherwise
    }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.extended.body);
});

// Health check — shows last update times
app.get('/status', (req, res) => {
  res.json({
    alerts:  { updatedAt: cache.alerts.updatedAt },
    history: { updatedAt: cache.history.updatedAt },
    extended: { updatedAt: cache.extended.updatedAt, fetchedAt: cache.extended.fetchedAt },
  });
});

// --- Start ---

app.listen(PORT, () => {
  if (DEBUG) {
    console.log(`Status server listening on http://localhost:${PORT} [DEBUG MODE]`);
    const data = loadDebugData();
    cache.extended.body = data.extended;
    cache.extended.fetchedAt = Date.now();
    cache.extended.updatedAt = Date.now();
    cache.history.body = data.history;
    cache.history.updatedAt = Date.now();
    cache.alerts.body = data.alerts;
    cache.alerts.updatedAt = Date.now();
    console.log('Loaded interesting-map.json — no live polling.');
  } else {
    console.log(`Status server listening on http://localhost:${PORT}`);
    console.log('Starting polls...');
    pollAlerts();
    pollHistory();
    setInterval(pollAlerts,  LIVE_POLL_MS);
    setInterval(pollHistory, HISTORY_POLL_MS);
  }
});
