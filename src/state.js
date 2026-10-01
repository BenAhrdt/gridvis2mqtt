import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const statePath = process.env.GRIDVIS2MQTT_STATE_FILE
  || fileURLToPath(new URL('../data/state.local.json', import.meta.url));

const REFRESH_INTERVALS = [0, 1, 2, 5, 10, 30, 60, 300];
const HISTORY_REFRESH_INTERVALS = [300, 600, 900, 1800, 2700, 3600, 7200, 21600, 43200, 86400];
const HISTORY_RANGES = new Set(['today', 'yesterday', 'last24hours', 'thisweek', 'lastweek', 'thismonth', 'lastmonth', 'thisyear', 'lastyear', 'last3months']);
const HISTORY_COMPARISON_UNITS = new Set(['same', 'hours', 'days', 'weeks', 'months', 'quarters', 'years']);
const DEFAULT_LIVE_REFRESH_INTERVAL = 2;
const DEFAULT_HISTORY_REFRESH_INTERVAL = 300;
const DEFAULT_HISTORY_MINUTE_OFFSET = 2;
const DEFAULT_HISTORY_RANGES = ['today', 'yesterday', 'lastmonth', 'thismonth', 'lastyear', 'thisyear'];
const CURRENT_DEFAULTS_VERSION = 1;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeHistoryComparisons(value, legacyOffset = 0) {
  const source = Array.isArray(value)
    ? value
    : Number(legacyOffset) === 1
      ? [{ unit: 'same', amount: 1 }]
      : [];
  const seen = new Set();
  const normalized = [];
  for (const item of source) {
    const unit = HISTORY_COMPARISON_UNITS.has(item?.unit) ? item.unit : '';
    if (!unit) continue;
    const range = item?.range === 'all' || HISTORY_RANGES.has(item?.range) ? item.range || 'all' : 'all';
    const amount = unit === 'same' ? 1 : Math.min(9999, Math.max(1, Math.trunc(Number(item?.amount) || 1)));
    const key = `${range}:${unit}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ range, unit, amount });
  }
  return normalized;
}

function defaultHistoricalSettings() {
  return {
    refreshInterval: DEFAULT_HISTORY_REFRESH_INTERVAL,
    minuteOffset: DEFAULT_HISTORY_MINUTE_OFFSET,
    comparisons: [],
    ranges: [...DEFAULT_HISTORY_RANGES]
  };
}

function migrateDefaults(value) {
  const source = objectOrEmpty(value);
  if (Number(source.mqttDefaultsVersion) >= CURRENT_DEFAULTS_VERSION) return source;

  // The previous defaults were stored in the state without a version. Move
  // those standard values to the currently requested defaults once. Explicit
  // per-measurement overrides remain in historicalSettings and are untouched.
  const migrated = structuredClone(source);
  migrated.mqttDefaultsVersion = CURRENT_DEFAULTS_VERSION;
  migrated.liveRefreshInterval = DEFAULT_LIVE_REFRESH_INTERVAL;
  migrated.historicalGlobalSettings = defaultHistoricalSettings();
  const measurementCache = objectOrEmpty(migrated.measurementCache);
  migrated.measurementCache = measurementCache;
  for (const cache of Object.values(measurementCache)) {
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) continue;
    cache.historicalDefaults = defaultHistoricalSettings();
  }
  return migrated;
}

function normalizeState(value = {}) {
  const source = migrateDefaults(value);
  return {
    version: 2,
    mqttDefaultsVersion: CURRENT_DEFAULTS_VERSION,
    selectedProject: String(source.selectedProject || ''),
    selectedDeviceIds: objectOrEmpty(source.selectedDeviceIds),
    selectedDeviceId: String(source.selectedDeviceId || ''),
    deviceSort: ['name', 'type', 'selected-name', 'selected-type'].includes(source.deviceSort)
      ? source.deviceSort
      : 'name',
    liveRefreshInterval: REFRESH_INTERVALS.includes(Number(source.liveRefreshInterval))
      ? Number(source.liveRefreshInterval)
      : DEFAULT_LIVE_REFRESH_INTERVAL,
    deviceRefreshIntervals: objectOrEmpty(source.deviceRefreshIntervals),
    historicalGlobalSettings: {
      refreshInterval: HISTORY_REFRESH_INTERVALS.includes(Number(source.historicalGlobalSettings?.refreshInterval))
        ? Number(source.historicalGlobalSettings.refreshInterval)
        : DEFAULT_HISTORY_REFRESH_INTERVAL,
      minuteOffset: Number.isInteger(Number(source.historicalGlobalSettings?.minuteOffset))
        && Number(source.historicalGlobalSettings.minuteOffset) >= 0
        && Number(source.historicalGlobalSettings.minuteOffset) <= 59
        ? Number(source.historicalGlobalSettings.minuteOffset)
        : DEFAULT_HISTORY_MINUTE_OFFSET,
      comparisons: normalizeHistoryComparisons(
        source.historicalGlobalSettings?.comparisons,
        source.historicalGlobalSettings?.comparisonOffset
      ),
      ranges: (() => {
        const configured = Array.isArray(source.historicalGlobalSettings?.ranges)
          ? source.historicalGlobalSettings.ranges
          : DEFAULT_HISTORY_RANGES;
        const valid = [...new Set(configured.filter((range) => HISTORY_RANGES.has(range)))];
        return valid.length ? valid : [...DEFAULT_HISTORY_RANGES];
      })()
    },
    deviceSearch: String(source.deviceSearch || ''),
    projects: Array.isArray(source.projects) ? source.projects : [],
    deviceCache: objectOrEmpty(source.deviceCache),
    measurementCache: objectOrEmpty(source.measurementCache)
  };
}

let stateInitialized = false;

function readState() {
  try {
    const state = normalizeState(JSON.parse(readFileSync(statePath, 'utf8')));
    stateInitialized = true;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeState();
    throw new Error(`Serverseitiger UI-Zustand konnte nicht gelesen werden: ${error.message}`);
  }
}

let runtimeState = readState();

function writeState() {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(runtimeState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(statePath, 0o600);
}

export function getState() {
  return structuredClone(runtimeState);
}

export function hasStoredState() {
  return stateInitialized;
}

export function updateState(value = {}) {
  runtimeState = normalizeState(value);
  writeState();
  stateInitialized = true;
  return getState();
}
