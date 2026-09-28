import { displayPrecisionLabel, formatMeasurementValue, measurementDisplayName, measurementDisplayUnits, measurementUnitInfo, normalizeDisplaySettings } from './measurement-display.js';

const state = {
  auth: null,
  config: null,
  projects: [],
  devices: [],
  onlineValues: [],
  historicalValues: [],
  historicalSelectedMeasurements: [],
  historicalMqttAssignments: {},
  historicalMqttActiveAssignments: {},
  historicalRetainAssignments: {},
  historicalSettings: {},
  historicalDefaults: { refreshInterval: 900, minuteOffset: 0, comparisons: [], ranges: ['today'] },
  historicalGlobalSettings: { refreshInterval: 900, minuteOffset: 0, comparisons: [], ranges: ['today'] },
  historicalResults: {},
  liveResults: [],
  displayedMeasurements: [],
  selectedMeasurements: [],
  mqttAssignments: {},
  mqttActiveAssignments: {},
  mqttRetainAssignments: {},
  displaySettings: {},
  currentDevice: null,
  currentView: 'overview',
  currentDetailTab: 'info',
  deviceSort: 'name',
  gridvisOnline: false,
  gridvisConnection: 'unknown',
  deviceCache: {},
  mqttDeviceCounts: {},
  mqttDeviceSummaries: {},
  discoveryPreparedCount: 0,
  mqttOverview: { project: '', rows: [], summary: {} },
  selectedDeviceIds: {},
  measurementCache: {},
  backendDeviceStateKey: '',
  // Opening several devices in quick succession must not let an older,
  // slower response overwrite the device that is currently displayed.
  deviceSelectionToken: 0,
  liveRefreshInterval: 0,
  deviceRefreshIntervals: {},
  liveLastFetchedAt: {},
  liveLastRequestedAt: {},
  liveVisibleRequestKey: '',
  liveRefreshTimer: null,
  liveCacheRefreshTimer: null,
  liveCacheRequestInFlight: false,
  livePublishPendingKeys: new Set(),
  selectionFilters: {
    live: { discovery: false, mqtt: false },
    historical: { discovery: false, mqtt: false }
  },
  logbookRefreshTimer: null,
  logbookRequestInFlight: false,
  deviceInfoRefreshTimer: null,
  liveRequestInFlight: false,
  historicalRefreshTimer: null,
  historicalLastFetchedAt: {},
  historicalLastRequestedAt: {},
  historicalVisibleRequestKey: '',
  historicalRequestInFlight: false,
  connectionStatusTimer: null,
  discoveryPreviewRequest: 0,
  // Any asynchronous definition/history request that started before a user
  // changed an MQTT selection must not be allowed to restore that old state.
  measurementMutationVersion: 0,
  editingMeasurement: null,
  editingMeasurementDevice: null,
  infoDevice: null,
  liveDragMeasurementKey: '',
  historicalDragMeasurementKey: '',
  mqttStateReadyAt: 0,
  mqttTestStatus: {},
  toastTimer: null
};

let pendingBackup = null;

const mqttDialogState = {
  modes: new Set(['live']),
  tab: 'selection',
  selectedDeviceIds: new Set(),
  deviceData: new Map(),
  selectedKeys: new Set(),
  deviceSearch: '',
  valueSearch: '',
  initialMeasurementKey: '',
  openDeviceGroups: new Set(),
  openDeviceNodes: new Set(),
  openMeasurementGroups: new Set(),
  openMeasurementSubGroups: new Set(),
  loading: false,
  dataRequestToken: 0,
  historySettingsTouched: false
};

const viewLabels = {
  overview: 'Übersicht',
  devices: 'Geräte',
  mqtt: 'MQTT',
  'device-detail': 'Gerätedetails',
  alarms: 'Alarme',
  logbook: 'Logbuch',
  settings: 'Verbindungen',
  administration: 'Einstellungen'
};

const HISTORY_CYCLE_OPTIONS = [
  [300, 'Alle 5 Minuten'],
  [600, 'Alle 10 Minuten'],
  [900, 'Alle 15 Minuten (Standard)'],
  [1800, 'Alle 30 Minuten'],
  [2700, 'Alle 45 Minuten'],
  [3600, 'Jede Stunde'],
  [7200, 'Alle 2 Stunden'],
  [21600, 'Alle 6 Stunden'],
  [43200, 'Alle 12 Stunden'],
  [86400, 'Alle 24 Stunden']
];

const HISTORY_RANGE_OPTIONS = [
  ['today', 'Heute'],
  ['yesterday', 'Gestern'],
  ['last24hours', 'Letzte 24 Stunden'],
  ['thisweek', 'Diese Woche'],
  ['lastweek', 'Letzte Woche'],
  ['thismonth', 'Dieser Monat'],
  ['lastmonth', 'Letzter Monat'],
  ['thisyear', 'Dieses Jahr'],
  ['lastyear', 'Letztes Jahr'],
  ['last3months', 'Letzte 3 Monate']
];
const HISTORY_COMPARISON_SCOPE_OPTIONS = [
  ['all', 'Alle ausgewählten Zeitbereiche'],
  ...HISTORY_RANGE_OPTIONS
];

const HISTORY_COMPARISON_UNITS = [
  ['same', 'Vorheriger gleicher Zeitraum'],
  ['hours', 'Stunden zuvor'],
  ['days', 'Tage zuvor'],
  ['weeks', 'Wochen zuvor'],
  ['months', 'Monate zuvor'],
  ['quarters', 'Quartale zuvor'],
  ['years', 'Jahre zuvor']
];
const HISTORY_COMPARISON_UNIT_TYPES = {
  hours: 'HOUR',
  days: 'DATE',
  weeks: 'WEEK_OF_YEAR',
  months: 'MONTH',
  quarters: 'MONTH',
  years: 'YEAR'
};
const HISTORY_COMPARISON_SAME_OFFSETS = {
  today: ['DATE', 1],
  yesterday: ['DATE', 1],
  last24hours: ['HOUR', 24],
  thisweek: ['WEEK_OF_YEAR', 1],
  lastweek: ['WEEK_OF_YEAR', 1],
  thismonth: ['MONTH', 1],
  lastmonth: ['MONTH', 1],
  thisyear: ['YEAR', 1],
  lastyear: ['YEAR', 1],
  last3months: ['MONTH', 3]
};
const HISTORY_RUNNING_RANGES = new Set(['today', 'thisweek', 'thismonth', 'thisyear']);
const HISTORY_ROLLING_RANGES = new Set(['last24hours', 'last3months']);

const HISTORY_COMPARISON_LABELS = {
  comparison_today: 'Vergleich: Gestern',
  comparison_yesterday: 'Vergleich: Vorgestern',
  comparison_last24hours: 'Vergleich: Vorherige 24 Stunden',
  comparison_thisweek: 'Vergleich: Letzte Woche',
  comparison_lastweek: 'Vergleich: Vorletzte Woche',
  comparison_thismonth: 'Vergleich: Letzter Monat',
  comparison_lastmonth: 'Vergleich: Vorletzter Monat',
  comparison_thisyear: 'Vergleich: Letztes Jahr',
  comparison_lastyear: 'Vergleich: Vorletztes Jahr',
  comparison_last3months: 'Vergleich: Vorherige 3 Monate'
};

const MQTT_STATE_DELAY_MS = 2000;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function waitForMqttState() {
  return new Promise((resolve) => setTimeout(resolve, MQTT_STATE_DELAY_MS));
}

function deferMqttValues() {
  state.mqttStateReadyAt = Math.max(state.mqttStateReadyAt, Date.now() + MQTT_STATE_DELAY_MS + 500);
}

let statePersistenceReady = false;
let statePersistenceTimer = null;
let statePersistenceInFlight = false;
let statePersistencePromise = null;
let statePersistencePending = null;
let statePersistenceErrorShown = false;

function cacheKey(project, device) {
  return `${project}::${device}`;
}

function isLoadedDeviceState(project, device) {
  return Boolean(project && device && state.backendDeviceStateKey === cacheKey(project, device));
}

function isCurrentDeviceRequest(token, id = '') {
  if (token !== state.deviceSelectionToken) return false;
  return !id || String(deviceId(state.currentDevice || {})) === String(id);
}

function serializeUiState() {
  const project = $('#project-select')?.value || '';
  const selectedDeviceId = state.currentDevice
    ? deviceId(state.currentDevice)
    : $('#device-select')?.value || state.selectedDeviceIds[project] || '';
  const currentMeasurementCache = project && selectedDeviceId
    ? state.measurementCache[cacheKey(project, selectedDeviceId)] || {}
    : {};
  const currentDeviceKey = project && selectedDeviceId ? cacheKey(project, selectedDeviceId) : '';
  const currentDeviceState = currentDeviceKey && state.backendDeviceStateKey === currentDeviceKey
    ? {
      project,
      deviceId: selectedDeviceId,
      loaded: true,
      cache: {
        ...currentMeasurementCache,
        displayedMeasurements: state.displayedMeasurements,
        selectedMeasurements: state.selectedMeasurements,
        mqttAssignments: state.mqttAssignments,
        mqttActiveAssignments: state.mqttActiveAssignments,
        mqttRetainAssignments: state.mqttRetainAssignments,
        displaySettings: state.displaySettings,
        liveResults: state.liveResults,
        historicalSelectedMeasurements: state.historicalSelectedMeasurements,
        historicalMqttAssignments: state.historicalMqttAssignments,
        historicalMqttActiveAssignments: state.historicalMqttActiveAssignments,
        historicalRetainAssignments: state.historicalRetainAssignments,
        historicalSettings: state.historicalSettings,
        historicalDefaults: state.historicalDefaults,
        historicalResults: state.historicalResults
      }
    }
    : null;
  return {
    version: 2,
    clientMutationVersion: state.measurementMutationVersion,
    selectedProject: project,
    selectedDeviceIds: state.selectedDeviceIds,
    selectedDeviceId,
    deviceSort: state.deviceSort,
    liveRefreshInterval: state.liveRefreshInterval,
    deviceRefreshIntervals: state.deviceRefreshIntervals,
    historicalGlobalSettings: state.historicalGlobalSettings,
    deviceSearch: $('#device-search')?.value || '',
    currentDeviceState
  };
}

async function flushUiState() {
  if (!statePersistenceReady) return;
  if (statePersistenceInFlight) {
    await statePersistencePromise;
    if (statePersistencePending) return flushUiState();
    return;
  }
  if (!statePersistencePending) return;
  const payload = statePersistencePending;
  statePersistencePending = null;
  statePersistenceInFlight = true;
  const request = (async () => {
    try {
      const response = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json().catch(() => ({}));
      if (result.state?.mqttDeviceCounts && typeof result.state.mqttDeviceCounts === 'object') {
        state.mqttDeviceCounts = result.state.mqttDeviceCounts;
      }
      if (result.state?.mqttDeviceSummaries && typeof result.state.mqttDeviceSummaries === 'object') {
        state.mqttDeviceSummaries = result.state.mqttDeviceSummaries;
      }
      if (Number.isFinite(Number(result.state?.discoveryPreparedCount))) {
        state.discoveryPreparedCount = Number(result.state.discoveryPreparedCount);
      }
      updateSelectedCounters();
      renderDeviceList();
      statePersistenceErrorShown = false;
    } catch (error) {
      console.warn('Serverseitiger UI-Zustand konnte nicht gespeichert werden:', error);
      // The backend is authoritative. Do not replay a browser-only change after
      // the server comes back, for example during a later page refresh.
      statePersistencePending = null;
      if (!statePersistenceErrorShown) {
        showToast('Einstellungen konnten serverseitig nicht gespeichert werden.', 'warning');
        statePersistenceErrorShown = true;
      }
    }
  })();
  statePersistencePromise = request;
  try {
    await request;
  } finally {
    statePersistenceInFlight = false;
    statePersistencePromise = null;
    if (statePersistencePending) void flushUiState();
  }
}

function writeUiCache() {
  if (!statePersistenceReady) return;
  statePersistencePending = serializeUiState();
  clearTimeout(statePersistenceTimer);
  statePersistenceTimer = setTimeout(() => flushUiState(), 50);
}

async function waitForLiveRequestIdle() {
  while (state.liveRequestInFlight) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitForHistoricalRequestIdle() {
  while (state.historicalRequestInFlight) await new Promise((resolve) => setTimeout(resolve, 50));
}

function enableServerStatePersistence() {
  statePersistenceReady = true;
  // Reading the backend state must not immediately write it back. Otherwise
  // an old page or cached response could overwrite the backend on startup.
  statePersistencePending = null;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  if (!text.trim()) throw new Error(`Leere Antwort vom Server (HTTP ${response.status})`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Ungültige Serverantwort (HTTP ${response.status})`);
  }
  if (response.status === 401 || response.status === 403) {
    if (response.status === 401) showLoginScreen();
    if (response.status === 403 && body.code === 'PASSWORD_CHANGE_REQUIRED') showPasswordChangeScreen();
  }
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function listData(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['projects', 'project', 'devices', 'device', 'values', 'value', 'items', 'results', 'data']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      const nested = listData(data[key]);
      if (nested.length) return nested;
    }
  }
  return Object.values(data).flatMap((value) => {
    if (Array.isArray(value)) return value;
    return value && typeof value === 'object' ? [value] : [];
  });
}

function expandLiveResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [result];
  const valueKeys = ['reading', 'onlineValue', 'measuredValue', 'measurementValue', 'actualValue', 'rawValue', 'current', 'currentValue', 'val', 'value', 'values'];
  const valueKey = valueKeys.find((key) => result[key] !== undefined);
  const payload = valueKey ? result[valueKey] : result;
  const ignoredKeys = new Set(['value', 'unit', 'timestamp', 'time', 'quality', 'status', 'flag', 'valid', 'online', 'lastUpdate', 'deviceId', 'device', 'project']);
  const channelEntries = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.entries(payload).filter(([key]) => !ignoredKeys.has(key))
    : [];
  const baseValue = itemValue(result, 'valueType.value', 'value_type.value', 'valueName', 'name');
  const baseType = itemValue(result, 'valueType.type', 'value_type.type', 'type');
  if (!valueKey && channelEntries.length && channelEntries.every(([, value]) => value && typeof value === 'object' && !Array.isArray(value))) {
    return channelEntries.flatMap(([valueName, value]) => expandLiveResult({ valueType: { value: valueName }, value }));
  }
  if (channelEntries.length > 1 || (channelEntries.length === 1 && /^(?:L\d|L\dL\d|SUM\d+|Overall|Main|Aux|Neutralleiter)/i.test(channelEntries[0][0]))) {
    return channelEntries.map(([type, value]) => ({
      ...result,
      [valueKey || 'value']: value,
      valueType: { ...(result.valueType && typeof result.valueType === 'object' ? result.valueType : {}), value: baseValue, type },
      value_type: { ...(result.value_type && typeof result.value_type === 'object' ? result.value_type : {}), value: baseValue, type }
    }));
  }
  const types = Array.isArray(baseType)
    ? baseType.map((type) => String(type).trim()).filter(Boolean)
    : String(baseType || '').split(',').map((type) => type.trim()).filter(Boolean);
  if (Array.isArray(payload) && types.length > 1) {
    if (types.length === payload.length) {
      return payload.map((value, index) => ({
        ...result,
        [valueKey || 'value']: value,
        valueType: { ...(result.valueType && typeof result.valueType === 'object' ? result.valueType : {}), value: baseValue, type: types[index] },
        value_type: { ...(result.value_type && typeof result.value_type === 'object' ? result.value_type : {}), value: baseValue, type: types[index] }
      }));
    }
  }
  return [result];
}

function liveResultList(data) {
  let results = [];
  if (Array.isArray(data)) results = data;
  else if (data && typeof data === 'object') {
    const valueMap = data.value && typeof data.value === 'object' && !Array.isArray(data.value)
      ? data.value
      : null;
    const keyedValues = valueMap
      ? Object.entries(valueMap).map(([key, rawValue]) => {
        const parts = String(key).split('.').map((part) => part.trim()).filter(Boolean);
        if (parts.length < 3) return null;
        const type = parts.pop();
        const deviceId = parts.shift();
        const valueName = parts.join('.');
        return {
          deviceId,
          valueType: { value: valueName, type, typeName: type },
          value: rawValue,
          reading: rawValue,
          time: data.time?.[key]
        };
      }).filter(Boolean)
      : [];
    if (keyedValues.length) results = keyedValues;
    else if (data.valueType || data.value_type) results = [data];
    else {
      for (const key of ['results', 'values', 'data', 'items']) {
        if (Array.isArray(data[key])) {
          results = data[key];
          break;
        }
      }
      if (!results.length) {
        const keyedEntries = Object.entries(data).filter(([key, value]) => value !== null && typeof value !== 'object' && key.includes(';'));
        if (keyedEntries.length) {
          results = keyedEntries.map(([key, value]) => {
            const parts = key.split(';').map((part) => part.trim()).filter(Boolean);
            return parts.length >= 2
              ? { valueType: { value: parts.at(-2), type: parts.at(-1) }, value }
              : { value };
          });
        } else {
          const primitiveEntries = Object.entries(data).filter(([, value]) => value !== null && typeof value !== 'object');
          results = primitiveEntries.length && primitiveEntries.length === Object.keys(data).length
            ? primitiveEntries.map(([, value]) => ({ value }))
            : listData(data);
        }
      }
    }
  }
  return results.flatMap(expandLiveResult);
}

function itemValue(item, ...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((current, part) => current?.[part], item);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value ?? '');
}

function showToast(message, type = 'error') {
  const toast = $('#toast');
  if (!toast) return;
  if (typeof toast.show === 'function') {
    if (!toast.open) toast.show();
  } else {
    toast.setAttribute('open', '');
  }
  toast.textContent = message;
  toast.classList.remove('success', 'warning', 'error');
  toast.classList.add(type);
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    if (typeof toast.close === 'function' && toast.open) toast.close();
    else toast.removeAttribute('open');
  }, 5200);
}

function setStatus(message, online = state.gridvisOnline) {
  const pending = online === null;
  const unknown = online === 'unknown';
  if (!pending && !unknown) {
    state.gridvisOnline = online;
    state.gridvisConnection = online ? 'online' : 'offline';
  } else if (pending) {
    state.gridvisConnection = 'checking';
  } else {
    state.gridvisConnection = 'unknown';
  }
  for (const selector of ['#sidebar-status', '#sidebar-status-small', '#topbar-status']) {
    $(selector)?.classList.toggle('online', state.gridvisOnline);
    $(selector)?.classList.toggle('pending', pending);
    $(selector)?.classList.toggle('unknown', unknown);
  }
  setText('#sidebar-status-text', message);
  setText('#sidebar-source', pending ? 'Verbindung wird geprüft' : unknown ? 'noch nicht geprüft' : state.gridvisOnline ? 'verbunden' : 'nicht verbunden');
  setText('#topbar-status-text', pending ? 'Prüfe ...' : unknown ? 'Nicht geprüft' : state.gridvisOnline ? 'Online' : 'Offline');
  applyStatusDot('#topbar-status', pending ? 'pending' : unknown ? 'unknown' : state.gridvisOnline ? 'online' : 'offline');
  setText('#footer-status', message);
  setText('#connection-pill', pending ? 'prüfe ...' : unknown ? 'nicht geprüft' : state.gridvisOnline ? 'online' : 'offline');
  $('#connection-pill')?.classList.toggle('offline', !pending && !unknown && !state.gridvisOnline);
  $('#connection-pill')?.classList.toggle('online', !pending && state.gridvisOnline);
  $('#connection-pill')?.classList.toggle('pending', pending);
  $('#connection-pill')?.classList.toggle('unknown', unknown);
  setText('#connection-title', pending ? 'GridVis-Verbindung wird geprüft' : state.gridvisOnline ? 'GridVis ist verbunden' : 'Noch keine GridVis-Verbindung');
  if (unknown) setText('#connection-title', 'GridVis-Verbindung ist konfiguriert');
  setText('#stat-online', pending ? '…' : state.gridvisOnline ? 'Ja' : '–');
}

function applyStatusDot(selector, status) {
  const element = $(selector);
  if (!element) return;
  element.classList.toggle('online', status === 'online');
  element.classList.toggle('pending', status === 'pending');
  element.classList.toggle('unknown', status === 'unknown');
}

function updateTopbarGridvisStatus(runtimeConnection = null) {
  const connection = runtimeConnection || state.config?.gridvis?.connection || {};
  const configured = Boolean(state.config?.gridvis?.baseUrl);
  const status = runtimeConnection
    ? connection.status === 'online'
      ? 'online'
      : connection.status === 'offline' || connection.status === 'disconnected'
        ? 'offline'
        : 'unknown'
    : state.gridvisConnection === 'checking'
      ? 'pending'
      : state.gridvisConnection === 'online'
        ? 'online'
        : state.gridvisConnection === 'offline'
          ? 'offline'
          : connection.status === 'online'
            ? 'online'
            : connection.status === 'offline' || connection.status === 'disconnected'
              ? 'offline'
              : 'unknown';
  const label = status === 'online'
    ? 'Online'
    : status === 'offline'
      ? (connection.status === 'disconnected' || state.config?.gridvis?.enabled === false ? 'Getrennt' : 'Offline')
      : status === 'pending'
        ? 'Prüfe ...'
        : configured ? 'Nicht geprüft' : 'Nicht konfiguriert';
  applyStatusDot('#topbar-status', status);
  setText('#topbar-status-text', label);
}

function updateTopbarMqttStatus() {
  const mqtt = state.config?.mqtt || {};
  const brokers = Array.isArray(mqtt.brokers) ? mqtt.brokers : [];
  const hasBrokerUrl = Boolean(mqtt.url) || brokers.some((broker) => broker?.url);
  const activeBrokers = brokers.filter((broker) => broker?.enabled !== false && broker?.url);
  const connection = mqtt.connection || {};
  const status = connection.status || 'disabled';
  let variant = 'unknown';
  let label = 'Nicht geprüft';
  if (!hasBrokerUrl) {
    variant = 'unknown';
    label = 'Nicht konfiguriert';
  } else if (!activeBrokers.length) {
    variant = 'offline';
    label = 'Getrennt';
  } else if (connection.connected || status === 'connected') {
    variant = 'online';
    label = 'Verbunden';
  } else if (status === 'partial') {
    variant = 'pending';
    label = 'Teilweise';
  } else if (status === 'connecting') {
    variant = 'pending';
    label = 'Verbinde ...';
  } else if (status === 'error') {
    variant = 'offline';
    label = 'Fehler';
  } else if (status === 'disconnected') {
    variant = 'offline';
    label = 'Getrennt';
  }
  applyStatusDot('#topbar-mqtt-status', variant);
  setText('#topbar-mqtt-status-text', label);
}

async function refreshConnectionStatus() {
  const result = await api('/api/status');
  if (state.config?.gridvis) state.config.gridvis.connection = result.gridvis || {};
  if (state.config?.mqtt) state.config.mqtt.connection = result.mqtt || {};
  updateTopbarGridvisStatus(result.gridvis || {});
  updateTopbarMqttStatus();
}

function configureConnectionStatusRefresh() {
  clearInterval(state.connectionStatusTimer);
  state.connectionStatusTimer = setInterval(() => {
    refreshConnectionStatus().catch((error) => console.warn('Verbindungsstatus konnte nicht aktualisiert werden:', error.message));
  }, 5000);
}

function showError(error) {
  const message = error?.message || String(error);
  setStatus(message, false);
  setText('#connection-detail', message);
  showToast(message);
  console.error(error);
}

function isOutsideDialog(dialog, event) {
  return event.target === dialog || !dialog.contains(event.target);
}

function closeDeviceInfoDialog() {
  $('#device-info-dialog')?.close();
  state.infoDevice = null;
  configureLiveRefresh();
}

const dialogMouseDownOutside = new WeakMap();
if (typeof document.addEventListener === 'function') {
  document.addEventListener('mousedown', (event) => {
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (dialog.id !== 'toast') dialogMouseDownOutside.set(dialog, isOutsideDialog(dialog, event));
    }
  }, true);
  document.addEventListener('mouseup', (event) => {
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter((dialog) => dialog.id !== 'toast');
    const topmostDialog = dialogs.at(-1);
    if (topmostDialog
      && dialogMouseDownOutside.get(topmostDialog)
      && isOutsideDialog(topmostDialog, event)) {
      dialogMouseDownOutside.delete(topmostDialog);
      if (topmostDialog.id === 'device-info-dialog') closeDeviceInfoDialog();
      else topmostDialog.close();
    }
  }, true);
}

function setView(view, updateHash = true) {
  const target = $(`[data-view="${view}"]`);
  if (!target) return;
  if (view !== 'device-detail' && state.currentView === 'device-detail') {
    state.deviceSelectionToken += 1;
  }
  state.currentView = view;
  $$('.page-view').forEach((section) => section.classList.toggle('active', section === target));
  $$('.nav-link').forEach((link) => {
    const isActive = link.dataset.viewLink === view || (view === 'device-detail' && link.dataset.viewLink === 'devices');
    link.classList.toggle('active', isActive);
  });
  setText('#breadcrumb-current', viewLabels[view] || view);
  if (updateHash && view !== 'device-detail') history.replaceState(null, '', `#${view}`);
  $('#sidebar')?.classList.remove('open');
  configureLiveRefresh();
  configureHistoricalRefresh();
  configureLogbookRefresh();
  configureDeviceInfoRefresh();
  if (view === 'logbook') loadLogbook({ silent: true }).catch(reportLogbookError);
  if (view === 'administration') loadAdministration().catch(showError);
  if (view === 'mqtt') loadMqttOverview({ silent: true }).catch(reportBackgroundError);
}

function setDetailTab(tab) {
  state.currentDetailTab = tab;
  $$('.detail-tab').forEach((button) => button.classList.toggle('active', button.dataset.detailTab === tab));
  $$('[data-detail-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.detailPanel === tab));
  if (tab === 'live' && state.currentDevice) {
    // The list renderer requests the values that are currently visible after
    // applying search and filters. This keeps the first page load aligned
    // with the rows the user is actually looking at.
    renderDisplayValues();
  }
  configureLiveRefresh();
  if (tab === 'history' && state.currentDevice) {
    renderHistoricalValues();
    renderHistoricalSelection();
    // Opening the tab is display-only. MQTT history is published by the
    // backend queue; otherwise this creates a second request series for the
    // same device while the backend is already processing it.
    loadHistoricalData({ silent: true, publishMqtt: false }).catch(reportBackgroundError);
  }
}

function mqttOverviewCycleLabel(seconds, mode) {
  const value = Number(seconds) || 0;
  if (!value) return 'Standardzyklus';
  const options = mode === 'historical'
    ? HISTORY_CYCLE_OPTIONS
    : [[1, 'Jede Sekunde'], [2, 'Alle 2 Sekunden'], [5, 'Alle 5 Sekunden'], [10, 'Alle 10 Sekunden'], [30, 'Alle 30 Sekunden'], [60, 'Jede Minute'], [300, 'Alle 5 Minuten']];
  return options.find(([candidate]) => candidate === value)?.[1] || `Alle ${value} Sekunden`;
}

function mqttOverviewValue(value, unit = '') {
  if (value === undefined || value === null || value === '') return '–';
  const formatted = typeof value === 'number'
    ? value.toLocaleString('de-DE', { maximumFractionDigits: 3 })
    : String(value);
  return `${formatted}${unit ? ` ${unit}` : ''}`;
}

function mqttOverviewRangeMarkup(row) {
  if (row.mode !== 'historical') return `<span class="mqtt-cycle-label">${escapeHtml(mqttOverviewCycleLabel(row.cycle, row.mode))}</span>`;
  const ranges = Array.isArray(row.ranges) ? row.ranges : [];
  const values = row.values && typeof row.values === 'object' ? row.values : {};
  const chips = ranges.slice(0, 4).map((range) => `<span class="mqtt-range-chip"><strong>${escapeHtml(historyRangeLabel(range))}</strong><em>${escapeHtml(mqttOverviewValue(values[range], row.unit))}</em></span>`);
  if (ranges.length > 4) chips.push(`<span class="mqtt-range-more">+${ranges.length - 4} weitere</span>`);
  return `<div class="mqtt-range-cell">${chips.join('') || '<span class="mqtt-cycle-label">Keine Zeitbereiche</span>'}<small>${escapeHtml(mqttOverviewCycleLabel(row.cycle, row.mode))}</small></div>`;
}

function mqttOverviewLatestHistoryValue(row) {
  const values = row.values && typeof row.values === 'object' ? row.values : {};
  const range = (row.ranges || []).find((candidate) => values[candidate] !== undefined && values[candidate] !== null && values[candidate] !== '');
  return range ? mqttOverviewValue(values[range], row.unit) : '–';
}

function mqttOverviewRowsForDisplay() {
  const query = ($('#mqtt-overview-search')?.value || '').trim().toLocaleLowerCase('de');
  const mode = $('#mqtt-overview-mode')?.value || 'all';
  const status = $('#mqtt-overview-status')?.value || 'all';
  return (state.mqttOverview.rows || []).filter((row) => {
    if (mode !== 'all' && row.mode !== mode) return false;
    if (status === 'active' && !row.active) return false;
    if (status === 'inactive' && row.active) return false;
    if (!query) return true;
    return `${row.deviceName} ${row.name} ${row.value} ${row.type} ${row.typeLabel}`.toLocaleLowerCase('de').includes(query);
  });
}

function renderMqttOverview() {
  const summary = state.mqttOverview.summary || {};
  setText('#mqtt-overview-topic-count', summary.topics || 0);
  setText('#mqtt-overview-measurement-count', summary.measurements || 0);
  setText('#mqtt-overview-measurement-detail', `${summary.devices || 0} ${summary.devices === 1 ? 'Gerät' : 'Geräte'}`);
  setText('#mqtt-overview-active-count', summary.active || 0);
  setText('#mqtt-nav-count', summary.topics || 0);
  const rows = mqttOverviewRowsForDisplay();
  const body = $('#mqtt-overview-table-body');
  if (!body) return;
  if (!rows.length) {
    const message = state.mqttOverview.project
      ? 'Keine passenden MQTT-Discovery-Werte gefunden.'
      : 'Wähle zuerst ein GridVis-Projekt aus.';
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state compact"><span class="empty-icon">⌁</span><strong>${escapeHtml(message)}</strong><p>Nur Messwerte mit vorbereiteter Discovery werden hier angezeigt.</p></div></td></tr>`;
  } else {
    body.replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      const profileText = row.profiles?.length ? row.profiles.join(', ') : 'MQTT-Profil';
      const status = row.active
        ? '<span class="value-status mqtt">MQTT aktiv</span>'
        : '<span class="value-status discovery">Discovery vorbereitet</span>';
      const liveValue = row.mode === 'live' ? mqttOverviewValue(row.values?.live, row.unit) : '';
      const rowData = `data-device-id="${escapeHtml(row.deviceId)}" data-measurement-key="${escapeHtml(row.measurementKey)}" data-mode="${escapeHtml(row.mode)}"`;
      tr.innerHTML = `<td><strong>${escapeHtml(row.deviceName)}</strong><small class="mqtt-table-meta">ID ${escapeHtml(row.deviceId)}</small></td><td><strong>${escapeHtml(row.name)}</strong><small class="mqtt-table-meta">${escapeHtml(row.value)} · ${escapeHtml(row.typeLabel)}${row.unit ? ` · ${escapeHtml(row.unit)}` : ''}</small></td><td><span class="mqtt-mode-badge ${row.mode}">${row.mode === 'historical' ? 'Historie' : 'Live'}</span></td><td><span class="mqtt-live-value">${escapeHtml(row.mode === 'live' ? liveValue : mqttOverviewLatestHistoryValue(row))}</span></td><td>${mqttOverviewRangeMarkup(row)}</td><td><div class="mqtt-status-cell"><button class="mqtt-status-toggle ${row.active ? 'active' : 'inactive'}" type="button" data-mqtt-row-toggle aria-label="${row.active ? 'MQTT-Veröffentlichung deaktivieren' : 'MQTT-Veröffentlichung aktivieren'}" aria-pressed="${row.active ? 'true' : 'false'}" ${rowData}>${status}</button><small>${escapeHtml(profileText)}</small></div></td><td><div class="mqtt-row-actions"><button class="button button-quiet mqtt-row-action" type="button" data-mqtt-row-edit ${rowData}>Öffnen</button><button class="button button-quiet mqtt-row-remove" type="button" data-mqtt-row-remove aria-label="Messwert ${escapeHtml(row.name)} vollständig entfernen" ${rowData}>Entfernen</button></div></td>`;
      return tr;
    }));
  }
  setText('#mqtt-overview-status-text', `${rows.length} ${rows.length === 1 ? 'Eintrag' : 'Einträge'} angezeigt`);
}

async function loadMqttOverview({ silent = false } = {}) {
  const project = $('#project-select')?.value || '';
  if (!project) {
    state.mqttOverview = { project: '', rows: [], summary: {} };
    renderMqttOverview();
    return;
  }
  if (!silent) setText('#mqtt-overview-status-text', 'Lade MQTT-Übersicht …');
  const result = await api(`/api/mqtt/overview?project=${encodeURIComponent(project)}`);
  state.mqttOverview = {
    project,
    rows: Array.isArray(result.rows) ? result.rows : [],
    summary: result.summary && typeof result.summary === 'object' ? result.summary : {}
  };
  renderMqttOverview();
}

function mqttOverviewRowFromButton(button) {
  return (state.mqttOverview.rows || []).find((row) => (
    String(row.deviceId) === String(button.dataset.deviceId)
    && String(row.measurementKey) === String(button.dataset.measurementKey)
    && row.mode === button.dataset.mode
  )) || null;
}

async function updateMqttOverviewRow(row, { enabled = null, remove = false } = {}) {
  if (!row) return;
  const project = row.project || $('#project-select')?.value || '';
  const id = String(row.deviceId || '');
  if (!project || !id) return;
  markMeasurementMutation();
  await flushUiState();
  const result = await api(`/api/state/device?project=${encodeURIComponent(project)}&deviceId=${encodeURIComponent(id)}`);
  const cache = structuredClone(result.data?.measurementCache || {});
  const historical = row.mode === 'historical';
  const values = historical ? cache.historicalValues || [] : cache.onlineValues || [];
  const measurement = values.find((item) => measurementKey(item) === row.measurementKey);
  if (!measurement) {
    showToast('Der Messwert ist im Gerätezustand nicht mehr verfügbar.', 'warning');
    return;
  }
  const assignmentField = historical ? 'historicalMqttAssignments' : 'mqttAssignments';
  const activeField = historical ? 'historicalMqttActiveAssignments' : 'mqttActiveAssignments';
  const selectedField = historical ? 'historicalSelectedMeasurements' : 'selectedMeasurements';
  const retainField = historical ? 'historicalRetainAssignments' : 'mqttRetainAssignments';
  const key = measurementKey(measurement);
  cache[assignmentField] = { ...(cache[assignmentField] || {}) };
  cache[activeField] = { ...(cache[activeField] || {}) };
  cache[retainField] = { ...(cache[retainField] || {}) };
  cache[selectedField] = Array.isArray(cache[selectedField]) ? cache[selectedField] : [];

  if (remove) {
    delete cache[assignmentField][key];
    delete cache[activeField][key];
    delete cache[retainField][key];
    cache[selectedField] = cache[selectedField].filter((item) => measurementKey(item) !== key);
    if (historical) {
      cache.historicalSettings = { ...(cache.historicalSettings || {}) };
      delete cache.historicalSettings[key];
      const prefix = `${id}:${key}`;
      cache.historicalResults = Object.fromEntries(Object.entries(cache.historicalResults || {})
        .filter(([resultKey]) => resultKey !== prefix && !resultKey.startsWith(`${prefix}:`)));
    } else {
      cache.displayedMeasurements = (Array.isArray(cache.displayedMeasurements) ? cache.displayedMeasurements : [])
        .filter((item) => measurementKey(item) !== key);
      cache.liveResults = (Array.isArray(cache.liveResults) ? cache.liveResults : [])
        .filter((item) => !liveResultMatches(item, measurement, id));
    }
  } else if (enabled) {
    const profileIds = Array.isArray(cache[assignmentField][key]) && cache[assignmentField][key].length
      ? cache[assignmentField][key]
      : (Array.isArray(row.profileIds) && row.profileIds.length ? row.profileIds : [defaultMqttProfileId()]);
    cache[assignmentField][key] = [...new Set(profileIds)];
    cache[activeField][key] = [...new Set(profileIds)];
    cache[selectedField] = appendUniqueMeasurement(cache[selectedField], measurement);
    if (!historical) cache.displayedMeasurements = appendUniqueMeasurement(cache.displayedMeasurements, measurement);
  } else {
    delete cache[activeField][key];
  }

  const cacheKeyValue = cacheKey(project, id);
  state.measurementCache[cacheKeyValue] = cache;
  await persistBackendDeviceState(project, id, cache);
  if (isLoadedDeviceState(project, id)) restoreMeasurementCache(project, id);
  writeUiCache();
  await flushUiState();
  await loadMqttOverview({ silent: true });
  showToast(remove
    ? 'Messwert wurde vollständig entfernt.'
    : enabled ? 'MQTT-Veröffentlichung aktiviert.' : 'MQTT-Veröffentlichung deaktiviert.', 'success');
}

function mqttDialogSelectedMeasurementKeys() {
  return [...mqttDialogState.selectedKeys];
}

function mqttDialogSelectedModes() {
  return ['live', 'historical'].filter((mode) => mqttDialogState.modes.has(mode));
}

function mqttDialogDataPending() {
  const modes = mqttDialogSelectedModes();
  return [...mqttDialogState.selectedDeviceIds].some((id) => {
    const data = mqttDialogState.deviceData.get(id);
    return !data || modes.some((mode) => !data.loadedModes.has(mode));
  });
}

function mqttDialogModeLabel(mode) {
  return mode === 'historical' ? 'Historie' : 'Live';
}

function mqttDialogSelectedModeLabel() {
  const modes = mqttDialogSelectedModes();
  return modes.length === 2 ? 'Live und Historie' : mqttDialogModeLabel(modes[0] || 'live');
}

function mqttDialogAvailableMeasurementsForMode(mode, { recordedOnly = false } = {}) {
  const ids = [...mqttDialogState.selectedDeviceIds];
  if (!ids.length || ids.some((id) => !mqttDialogState.deviceData.has(id))) return [];
  const lists = ids.map((id) => {
    const data = mqttDialogState.deviceData.get(id);
    const values = mode === 'historical' ? data.historical : data.live;
    return new Map(values.map((measurement) => [measurementKey(measurement), measurement]));
  });
  if (!lists.length) return [];
  const common = [...lists[0].entries()].filter(([key]) => lists.slice(1).every((list) => list.has(key)));
  return common
    .map(([, measurement]) => measurement)
    .filter((measurement) => {
      if (!recordedOnly) return true;
      const recorded = itemValue(measurement.raw, 'recorded', 'isRecorded', 'recording', 'logged');
      return recorded === '' || !['false', '0', 'no'].includes(String(recorded).toLowerCase());
    })
    .sort((left, right) => measurementDisplayName(left).localeCompare(measurementDisplayName(right), 'de', { numeric: true, sensitivity: 'base' }));
}

function mqttDialogAvailableMeasurements() {
  const measurements = new Map();
  for (const mode of mqttDialogSelectedModes()) {
    const values = mqttDialogAvailableMeasurementsForMode(mode, {
      recordedOnly: mode === 'historical' && $('#mqtt-dialog-recorded')?.checked === true
    });
    for (const measurement of values) {
      if (!measurements.has(measurementKey(measurement))) measurements.set(measurementKey(measurement), measurement);
    }
  }
  return [...measurements.values()].sort((left, right) => measurementDisplayName(left).localeCompare(measurementDisplayName(right), 'de', { numeric: true, sensitivity: 'base' }));
}

function mqttDialogKnownMeasurements() {
  const measurements = new Map();
  for (const mode of ['live', 'historical']) {
    const values = mqttDialogAvailableMeasurementsForMode(mode, {
      recordedOnly: mode === 'historical' && $('#mqtt-dialog-recorded')?.checked === true
    });
    for (const measurement of values) {
      if (!measurements.has(measurementKey(measurement))) measurements.set(measurementKey(measurement), measurement);
    }
  }
  return [...measurements.values()].sort((left, right) => measurementDisplayName(left).localeCompare(measurementDisplayName(right), 'de', { numeric: true, sensitivity: 'base' }));
}

function mqttDialogMeasurementAvailabilityMap() {
  return {
    live: new Set(mqttDialogAvailableMeasurementsForMode('live').map((measurement) => measurementKey(measurement))),
    historical: new Set(mqttDialogAvailableMeasurementsForMode('historical', {
      recordedOnly: $('#mqtt-dialog-recorded')?.checked === true
    }).map((measurement) => measurementKey(measurement)))
  };
}

function mqttDialogMeasurementAvailability(key, availability = mqttDialogMeasurementAvailabilityMap()) {
  return { live: availability.live.has(key), historical: availability.historical.has(key) };
}

function mqttDialogExistingMeasurementState(key, availability = mqttDialogMeasurementAvailabilityMap()) {
  const ids = [...mqttDialogState.selectedDeviceIds];
  const applicableModes = mqttDialogSelectedModes().filter((mode) => availability[mode].has(key));
  const configuredModes = applicableModes.filter((mode) => {
    const field = mode === 'historical' ? 'historicalMqttAssignments' : 'mqttAssignments';
    return ids.length > 0 && ids.every((id) => {
      const assignments = mqttDialogState.deviceData.get(id)?.cache?.[field];
      return Array.isArray(assignments?.[key]) && assignments[key].length > 0;
    });
  });
  return { configured: configuredModes.length, total: applicableModes.length, all: configuredModes.length > 0 && configuredModes.length === applicableModes.length };
}

function mqttDialogSelectedMeasurements() {
  const selectedKeys = new Set(mqttDialogSelectedMeasurementKeys());
  return mqttDialogKnownMeasurements().filter((measurement) => selectedKeys.has(measurementKey(measurement)));
}

function mqttDialogConfigurableMeasurements() {
  const availability = mqttDialogMeasurementAvailabilityMap();
  return mqttDialogSelectedMeasurements().filter((measurement) => {
    const key = measurementKey(measurement);
    return mqttDialogSelectedModes().some((mode) => availability[mode].has(key));
  });
}

function mqttDeviceGroupName(device) {
  const type = deviceType(device).trim();
  const compact = type.toLocaleLowerCase('de').replace(/[^a-z0-9]/g, '');
  if (compact === 'janitzaumg801') return 'UMG 801';
  if (compact.includes('janitzaumg801basemodule')) return 'UMG 801 Basismodul';
  if (compact.includes('janitzaumg801measurementgroup')) return 'UMG 801 Messgruppe';
  if (compact.includes('virtualkpi') || compact.includes('kpi')) return 'KPI';
  if (compact.includes('externvalues') || compact === 'di' || compact.includes('digitalinput')) return 'DI';
  if (compact.includes('genericmodbus') || compact === 'modbus') return 'Modbus';
  if (compact === 'xxxvirtual' || compact === 'virtual' || compact.includes('virtualdevice')) return 'VD';
  return mqttFriendlyDeviceType(type);
}

function mqttFriendlyDeviceType(type) {
  const raw = String(type || '').trim();
  if (!raw || raw === 'GridVis-Messgerät') return 'Weitere Geräte';
  const withoutTechnicalPrefix = raw.replace(/^(xxx|zz)/i, '');
  const spaced = withoutTechnicalPrefix
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced || raw;
}

function mqttDeviceTextParts(device) {
  return deviceName(device).split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
}

function mqttDeviceDisplayName(device) {
  const name = deviceLeafName(device);
  const normalized = name.toLocaleLowerCase('de');
  if (normalized === 'xxxexternvalues') return 'Externe Werte';
  if (normalized === 'xxxvirtualkpi') return 'KPI';
  if (normalized === 'xxxvirtual') return 'Virtuelles Gerät';
  if (normalized === 'zzgenericmodbus') return 'Modbus-Gerät';
  return name;
}

function mqttDeviceDisplayPath(device) {
  const parts = mqttDeviceTextParts(device);
  return (parts.length ? parts : [deviceName(device)]).map((part) => {
    const normalized = part.toLocaleLowerCase('de');
    if (normalized === 'xxxexternvalues') return 'Externe Werte';
    if (normalized === 'xxxvirtualkpi') return 'KPI';
    if (normalized === 'xxxvirtual') return 'Virtuelles Gerät';
    if (normalized === 'zzgenericmodbus') return 'Modbus-Gerät';
    return part;
  }).join(' / ');
}

function mqttDeviceIcon(device) {
  const text = `${deviceType(device)} ${deviceName(device)}`.toLocaleLowerCase('de');
  if (/kpi/.test(text)) return 'kpi';
  if (/modbus/.test(text)) return 'modbus';
  if (/digital|\bdi\b|eingang/.test(text)) return 'digital';
  if (/virtu|software|proxmox/.test(text)) return 'virtual';
  return 'meter';
}

function mqttFolderIcon() {
  return '<svg class="mqtt-tree-icon mqtt-tree-folder-svg" viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1.5-1.5Z"></path></svg>';
}

function mqttDeviceIconMarkup(device) {
  const icon = mqttDeviceIcon(device);
  const extra = icon === 'kpi' ? '<path d="M5 19V9M12 19V5M19 19v-7"></path><path d="M4 19h17"></path>'
    : icon === 'digital' ? '<path d="M5 12h14M8 8v8M16 8v8"></path>'
    : icon === 'modbus' ? '<path d="M5 8h14v8H5zM8 5v3M16 5v3M8 16v3M16 16v3"></path>'
      : icon === 'virtual' ? '<path d="m12 4 7 4v8l-7 4-7-4V8l7-4Z"></path><path d="m8 12 2.5 2.5L16 9"></path>'
        : '<rect class="mqtt-meter-body" x="3" y="5" width="18" height="13" rx="1.5"></rect><path class="mqtt-meter-detail" d="M7 9h10M7 13h6"></path><path class="mqtt-meter-terminal" d="M7 18v2M17 18v2"></path>';
  return `<svg class="mqtt-tree-icon mqtt-tree-device-svg mqtt-tree-device-svg-${icon}" viewBox="0 0 24 24" focusable="false" aria-hidden="true">${extra}</svg>`;
}

function mqttDeviceIconMarkupWithSource(device) {
  const source = deviceIconSource(device);
  return source
    ? `<img class="mqtt-tree-device-image" data-mqtt-device-icon src="${escapeHtml(source)}" alt="" loading="lazy">`
    : mqttDeviceIconMarkup(device);
}

function wireMqttDeviceIcon(container, device) {
  const image = container?.querySelector('[data-mqtt-device-icon]');
  if (!image) return;
  image.addEventListener('error', () => {
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', mqttDeviceIconMarkup(device));
  }, { once: true });
}

function mqttDeviceTree(devices) {
  const byId = new Map(devices.map((device) => [deviceId(device), device]));
  const byName = new Map(devices.map((device) => [deviceName(device).toLocaleLowerCase('de'), device]));
  const children = new Map();
  const roots = [];
  for (const device of devices) {
    const reference = deviceParentReference(device);
    let parent = reference
      ? (byId.get(reference) || byName.get(reference.toLocaleLowerCase('de')))
      : null;
    if (!parent) parent = inferredDeviceParent(device, devices);
    if (parent && deviceId(parent) !== deviceId(device)) {
      const parentId = deviceId(parent);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(device);
    } else {
      roots.push(device);
    }
  }
  const sortDevices = (left, right) => compareDeviceText(mqttDeviceDisplayName(left), mqttDeviceDisplayName(right)) || compareDeviceText(deviceId(left), deviceId(right));
  const build = (device, trail = new Set()) => {
    const id = deviceId(device);
    if (trail.has(id)) return { device, children: [] };
    const nextTrail = new Set(trail).add(id);
    return {
      device,
      children: (children.get(id) || []).sort(sortDevices).map((child) => build(child, nextTrail))
    };
  };
  return roots.sort(sortDevices).map((root) => build(root));
}

function mqttDeviceTreeContainsQuery(node, query, ancestorMatches = false) {
  if (!query) return true;
  const text = `${mqttDeviceDisplayPath(node.device)} ${deviceType(node)} ${deviceId(node.device)}`.toLocaleLowerCase('de');
  const matches = ancestorMatches || text.includes(query);
  return matches || node.children.some((child) => mqttDeviceTreeContainsQuery(child, query));
}

function mqttVisibleDeviceTree(node, query, ancestorMatches = false) {
  const text = `${mqttDeviceDisplayPath(node.device)} ${deviceType(node)} ${deviceId(node.device)}`.toLocaleLowerCase('de');
  const matches = ancestorMatches || text.includes(query);
  const children = node.children
    .filter((child) => !query || matches || mqttDeviceTreeContainsQuery(child, query))
    .map((child) => mqttVisibleDeviceTree(child, query, matches));
  return { device: node.device, children };
}

function mqttFlattenDeviceTree(nodes, result = []) {
  for (const node of nodes) {
    result.push(node.device);
    mqttFlattenDeviceTree(node.children, result);
  }
  return result;
}

function mqttDeviceSubtreeIds(node, result = []) {
  result.push(deviceId(node.device));
  for (const child of node.children) mqttDeviceSubtreeIds(child, result);
  return result;
}

function mqttDeviceSelectionMarkup(node, ids) {
  const selectedCount = ids.filter((id) => mqttDialogState.selectedDeviceIds.has(id)).length;
  return `<input type="checkbox"${selectedCount === ids.length ? ' checked' : ''}${selectedCount > 0 && selectedCount < ids.length ? ' data-indeterminate="true"' : ''}><span class="mqtt-tree-device-icon">${mqttDeviceIconMarkupWithSource(node.device)}</span><span><strong>${escapeHtml(mqttDeviceDisplayName(node.device))}</strong><small>${escapeHtml(mqttDeviceDisplayPath(node.device))} · ID ${escapeHtml(deviceId(node.device))}</small></span>`;
}

function attachMqttDeviceSelection(input, ids) {
  input.indeterminate = ids.some((id) => mqttDialogState.selectedDeviceIds.has(id))
    && !ids.every((id) => mqttDialogState.selectedDeviceIds.has(id));
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('change', (event) => {
    for (const id of ids) {
      if (event.target.checked) mqttDialogState.selectedDeviceIds.add(id);
      else mqttDialogState.selectedDeviceIds.delete(id);
    }
    renderMqttDialogDevices();
    refreshMqttDialogData().catch(reportBackgroundError);
  });
}

function renderMqttDialogDeviceNode(node, depth = 0) {
  const ids = mqttDeviceSubtreeIds(node);
  if (node.children.length) {
    const details = document.createElement('details');
    details.className = 'mqtt-device-node';
    details.style.setProperty('--mqtt-device-indent', `${10 + (depth * 20)}px`);
    const nodeId = deviceId(node.device);
    details.open = mqttDialogState.openDeviceNodes.has(nodeId);
    details.addEventListener('toggle', () => {
      if (details.open) mqttDialogState.openDeviceNodes.add(nodeId);
      else mqttDialogState.openDeviceNodes.delete(nodeId);
    });
    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="mqtt-tree-toggle" aria-hidden="true">▸</span>${mqttDeviceSelectionMarkup(node, ids)}`;
    wireMqttDeviceIcon(summary.querySelector('.mqtt-tree-device-icon'), node.device);
    attachMqttDeviceSelection(summary.querySelector('input'), ids);
    details.append(summary);
    const children = document.createElement('div');
    children.className = 'mqtt-device-node-children';
    children.append(...node.children.map((child) => renderMqttDialogDeviceNode(child, depth + 1)));
    details.append(children);
    return details;
  }
  const row = document.createElement('label');
  row.className = 'mqtt-picker-item mqtt-device-item';
  row.style.setProperty('--mqtt-device-indent', `${10 + (depth * 20)}px`);
  row.innerHTML = mqttDeviceSelectionMarkup(node, ids);
  wireMqttDeviceIcon(row.querySelector('.mqtt-tree-device-icon'), node.device);
  attachMqttDeviceSelection(row.querySelector('input'), ids);
  return row;
}

function renderMqttDialogDevices() {
  const list = $('#mqtt-dialog-devices');
  if (!list) return;
  const query = mqttDialogState.deviceSearch.trim().toLocaleLowerCase('de');
  const roots = mqttDeviceTree(state.devices)
    .filter((node) => mqttDeviceTreeContainsQuery(node, query))
    .map((node) => mqttVisibleDeviceTree(node, query));
  if (!roots.length) {
    list.innerHTML = '<div class="mqtt-picker-empty">Keine passenden Geräte gefunden.</div>';
  } else {
    const groups = new Map();
    for (const node of roots) {
      const groupName = mqttDeviceGroupName(node.device);
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(node);
    }
    const groupEntries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'de', { numeric: true, sensitivity: 'base' }));
    const groupElements = groupEntries.map(([groupName, groupNodes]) => {
      const groupDevices = mqttFlattenDeviceTree(groupNodes);
      const group = document.createElement('details');
      group.className = 'mqtt-device-group';
      group.open = mqttDialogState.openDeviceGroups.has(groupName);
      group.addEventListener('toggle', () => {
        if (group.open) mqttDialogState.openDeviceGroups.add(groupName);
        else mqttDialogState.openDeviceGroups.delete(groupName);
      });
      const selectedCount = groupDevices.filter((device) => mqttDialogState.selectedDeviceIds.has(deviceId(device))).length;
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="mqtt-tree-toggle" aria-hidden="true">▸</span><input class="mqtt-tree-group-check" type="checkbox"${selectedCount === groupDevices.length ? ' checked' : ''}${selectedCount > 0 && selectedCount < groupDevices.length ? ' data-indeterminate="true"' : ''}><span class="mqtt-tree-folder-icon">${mqttFolderIcon()}</span><strong>${escapeHtml(groupName)}</strong><small>${groupDevices.length}</small>`;
      const groupCheckbox = summary.querySelector('input');
      groupCheckbox.indeterminate = selectedCount > 0 && selectedCount < groupDevices.length;
      groupCheckbox.addEventListener('click', (event) => event.stopPropagation());
      groupCheckbox.addEventListener('change', (event) => {
        for (const device of groupDevices) {
          const id = deviceId(device);
          if (event.target.checked) mqttDialogState.selectedDeviceIds.add(id);
          else mqttDialogState.selectedDeviceIds.delete(id);
        }
        renderMqttDialogDevices();
        refreshMqttDialogData().catch(reportBackgroundError);
      });
      group.append(summary);
      const children = document.createElement('div');
      children.className = 'mqtt-device-group-items';
      // The type folder is level 0. Its first device starts at level 1 so
      // the hierarchy is visible even when the row also contains a caret.
      children.replaceChildren(...groupNodes.map((node) => renderMqttDialogDeviceNode(node, 1)));
      group.append(children);
      return group;
    });
    const allDevices = mqttFlattenDeviceTree(roots);
    const root = document.createElement('div');
    root.className = 'mqtt-device-tree-root';
    const rootRow = document.createElement('div');
    rootRow.className = 'mqtt-device-tree-root-row';
    const selectedCount = allDevices.filter((device) => mqttDialogState.selectedDeviceIds.has(deviceId(device))).length;
    rootRow.innerHTML = `<input type="checkbox"${selectedCount === allDevices.length ? ' checked' : ''}${selectedCount > 0 && selectedCount < allDevices.length ? ' data-indeterminate="true"' : ''}><strong>Alle Elemente</strong>`;
    const rootCheckbox = rootRow.querySelector('input');
    rootCheckbox.indeterminate = selectedCount > 0 && selectedCount < allDevices.length;
    rootCheckbox.addEventListener('change', (event) => {
      for (const device of allDevices) {
        const id = deviceId(device);
        if (event.target.checked) mqttDialogState.selectedDeviceIds.add(id);
        else mqttDialogState.selectedDeviceIds.delete(id);
      }
      renderMqttDialogDevices();
      refreshMqttDialogData().catch(reportBackgroundError);
    });
    root.append(rootRow, ...groupElements);
    list.replaceChildren(root);
  }
  setText('#mqtt-dialog-device-count', `${mqttDialogState.selectedDeviceIds.size} ausgewählt`);
}

function mqttMeasurementGroup(measurement) {
  const text = `${measurementDisplayName(measurement)} ${measurement.value || ''} ${measurement.type || ''} ${measurement.typeLabel || ''}`.toLocaleLowerCase('de');
  if (/spannung|voltage|u_effective|u_/.test(text)) return { group: 'Spannung', subGroup: '' };
  if (/strom|current|i_effective|i_/.test(text)) return { group: 'Strom', subGroup: '' };
  if (/frequenz|frequency|freq/.test(text)) return { group: 'Frequenz', subGroup: '' };
  if (/leistung|power|watt|wirkleistung|p_/.test(text)) return { group: 'Leistung', subGroup: '' };
  if (/energie|energy|arbeit|consum|deliver|supply|verbrauch|blindarbeit|reactive/.test(text)) {
    if (/induktiv/.test(text)) return { group: 'Elektrische Energie', subGroup: 'Bezogene induktive Blindarbeit' };
    if (/kapazitiv/.test(text)) return { group: 'Elektrische Energie', subGroup: 'Bezogene kapazitive Blindarbeit' };
    if (/blindarbeit|reactive/.test(text)) return { group: 'Elektrische Energie', subGroup: 'Blindarbeit' };
    if (/geliefer|deliver|supply/.test(text)) return { group: 'Elektrische Energie', subGroup: 'Gelieferte Wirkarbeit' };
    if (/bezogen|consum|verbrauch|import/.test(text)) return { group: 'Elektrische Energie', subGroup: 'Bezogene Wirkarbeit' };
    return { group: 'Elektrische Energie', subGroup: 'Wirkarbeit' };
  }
  return { group: 'Weitere Messwerte', subGroup: '' };
}

function renderMqttDialogMeasurementItem(measurement, availabilityMap) {
  const key = measurementKey(measurement);
  const availability = mqttDialogMeasurementAvailability(key, availabilityMap);
  const existing = mqttDialogExistingMeasurementState(key, availabilityMap);
  const availabilityMarkup = `<span class="mqtt-value-availability"><span class="mqtt-availability-badge${availability.live ? ' available' : ''}">Live${availability.live ? ' verfügbar' : ' –'}</span><span class="mqtt-availability-badge${availability.historical ? ' available' : ''}">Historie${availability.historical ? ' verfügbar' : ' –'}</span></span>`;
  const existingMarkup = existing.configured
    ? `<span class="mqtt-existing-badge">${existing.all ? 'Bereits konfiguriert' : `${existing.configured}/${existing.total} Arten konfiguriert`}</span>`
    : '';
  const row = document.createElement('label');
  row.className = 'mqtt-picker-item mqtt-value-item';
  row.innerHTML = `<input type="checkbox"${mqttDialogState.selectedKeys.has(key) ? ' checked' : ''}><span><strong>${escapeHtml(measurementDisplayName(measurement))}</strong><small>${escapeHtml(measurement.value)} · ${escapeHtml(measurement.typeLabel || measurement.type)}${measurement.unit ? ` · ${escapeHtml(measurement.unit)}` : ''}</small><span class="mqtt-value-status">${availabilityMarkup}${existingMarkup}</span></span>`;
  row.querySelector('input').addEventListener('change', (event) => {
    if (event.target.checked) mqttDialogState.selectedKeys.add(key);
    else mqttDialogState.selectedKeys.delete(key);
    renderMqttDialogCommonValues();
    renderMqttDialogSelectedValues();
    updateMqttDialogStatus();
  });
  return row;
}

function renderMqttDialogCommonValues() {
  const list = $('#mqtt-dialog-common-values');
  if (!list) return;
  const values = mqttDialogAvailableMeasurements();
  const knownKeys = new Set(mqttDialogKnownMeasurements().map((measurement) => measurementKey(measurement)));
  for (const key of [...mqttDialogState.selectedKeys]) {
    if (!knownKeys.has(key)) mqttDialogState.selectedKeys.delete(key);
  }
  const query = mqttDialogState.valueSearch.trim().toLocaleLowerCase('de');
  const filtered = values.filter((measurement) => !query || `${measurementDisplayName(measurement)} ${measurement.value} ${measurement.type} ${measurement.typeLabel}`.toLocaleLowerCase('de').includes(query));
  if (!mqttDialogState.selectedDeviceIds.size) {
    list.innerHTML = '<div class="mqtt-picker-empty">Wähle links mindestens ein Gerät aus.</div>';
  } else if (mqttDialogState.loading && mqttDialogDataPending()) {
    list.innerHTML = '<div class="mqtt-picker-empty">Messwertdefinitionen werden geladen …</div>';
  } else if (!filtered.length) {
    const onlyHistorical = mqttDialogSelectedModes().length === 1 && mqttDialogSelectedModes()[0] === 'historical';
    list.innerHTML = `<div class="mqtt-picker-empty">${onlyHistorical ? 'Keine historischen gemeinsamen Messwerte verfügbar.' : 'Keine gemeinsamen Messwerte gefunden.'}</div>`;
  } else {
    const availabilityMap = mqttDialogMeasurementAvailabilityMap();
    const groups = new Map();
    for (const measurement of filtered) {
      const category = mqttMeasurementGroup(measurement);
      if (!groups.has(category.group)) groups.set(category.group, new Map());
      const subGroups = groups.get(category.group);
      if (!subGroups.has(category.subGroup)) subGroups.set(category.subGroup, []);
      subGroups.get(category.subGroup).push(measurement);
    }
    const groupOrder = ['Spannung', 'Strom', 'Frequenz', 'Leistung', 'Elektrische Energie', 'Weitere Messwerte'];
    const sortedGroups = [...groups.entries()].sort(([left], [right]) => {
      const leftIndex = groupOrder.indexOf(left);
      const rightIndex = groupOrder.indexOf(right);
      return (leftIndex < 0 ? groupOrder.length : leftIndex) - (rightIndex < 0 ? groupOrder.length : rightIndex) || left.localeCompare(right, 'de');
    });
    list.replaceChildren(...sortedGroups.map(([groupName, subGroups]) => {
      const group = document.createElement('details');
      group.className = 'mqtt-measurement-group';
      group.open = mqttDialogState.openMeasurementGroups.has(groupName);
      group.addEventListener('toggle', () => {
        if (group.open) mqttDialogState.openMeasurementGroups.add(groupName);
        else mqttDialogState.openMeasurementGroups.delete(groupName);
      });
      const groupCount = [...subGroups.values()].reduce((sum, entries) => sum + entries.length, 0);
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="mqtt-tree-toggle" aria-hidden="true">▸</span><span class="mqtt-tree-folder-icon">${mqttFolderIcon()}</span><strong>${escapeHtml(groupName)}</strong><small>${groupCount}</small>`;
      group.append(summary);
      const sortedSubGroups = [...subGroups.entries()].sort(([left], [right]) => {
        const order = ['Wirkarbeit', 'Bezogene Wirkarbeit', 'Gelieferte Wirkarbeit', 'Bezogene induktive Blindarbeit', 'Bezogene kapazitive Blindarbeit', 'Blindarbeit'];
        return (order.indexOf(left) < 0 ? order.length : order.indexOf(left)) - (order.indexOf(right) < 0 ? order.length : order.indexOf(right)) || left.localeCompare(right, 'de');
      });
      for (const [subGroupName, measurements] of sortedSubGroups) {
        const entries = measurements.sort((left, right) => measurementDisplayName(left).localeCompare(measurementDisplayName(right), 'de', { numeric: true, sensitivity: 'base' }));
        if (subGroupName) {
          const subGroup = document.createElement('details');
          subGroup.className = 'mqtt-measurement-subgroup';
          const subGroupKey = `${groupName}:${subGroupName}`;
          subGroup.open = mqttDialogState.openMeasurementSubGroups.has(subGroupKey);
          subGroup.addEventListener('toggle', () => {
            if (subGroup.open) mqttDialogState.openMeasurementSubGroups.add(subGroupKey);
            else mqttDialogState.openMeasurementSubGroups.delete(subGroupKey);
          });
          const subSummary = document.createElement('summary');
          subSummary.innerHTML = `<span class="mqtt-tree-toggle" aria-hidden="true">▸</span><span class="mqtt-tree-folder-icon">${mqttFolderIcon()}</span><strong>${escapeHtml(subGroupName)}</strong><small>${entries.length}</small>`;
          subGroup.append(subSummary);
          subGroup.append(...entries.map((measurement) => renderMqttDialogMeasurementItem(measurement, availabilityMap)));
          group.append(subGroup);
        } else {
          group.append(...entries.map((measurement) => renderMqttDialogMeasurementItem(measurement, availabilityMap)));
        }
      }
      return group;
    }));
  }
  setText('#mqtt-dialog-common-count', `${values.length} verfügbar`);
}

function renderMqttDialogSelectedValues() {
  const list = $('#mqtt-dialog-selected-values');
  if (!list) return;
  const modeLabel = mqttDialogSelectedModes().length === 2
    ? 'Live- und historische Messwerte'
    : mqttDialogSelectedModes()[0] === 'historical' ? 'historische Messwerte' : 'Live-Messwerte';
  setText('#mqtt-dialog-selected-mode', `Werden als ${modeLabel} gespeichert`);
  const selected = mqttDialogSelectedMeasurements();
  if (!selected.length) {
    list.innerHTML = '<div class="mqtt-picker-empty">Noch keine Messwerte ausgewählt.</div>';
  } else {
    list.replaceChildren(...selected.map((measurement) => {
      const row = document.createElement('div');
      row.className = 'mqtt-picker-selected-item';
      const key = measurementKey(measurement);
      const availability = mqttDialogMeasurementAvailability(key);
      const selectedModeLabels = mqttDialogSelectedModes().filter((mode) => availability[mode]).map(mqttDialogModeLabel);
      const unavailableModeLabels = mqttDialogSelectedModes().filter((mode) => !availability[mode]).map(mqttDialogModeLabel);
      const modeStatus = [
        selectedModeLabels.length ? `${selectedModeLabels.join(' und ')} wird gespeichert` : '',
        unavailableModeLabels.length ? `${unavailableModeLabels.join(' und ')} nicht verfügbar` : ''
      ].filter(Boolean).join(' · ');
      row.innerHTML = `<div><strong>${escapeHtml(measurementDisplayName(measurement))}</strong><small>${escapeHtml(measurement.value)} · ${escapeHtml(measurement.typeLabel || measurement.type)}${measurement.unit ? ` · ${escapeHtml(measurement.unit)}` : ''}</small><span class="mqtt-selected-mode-badge${selectedModeLabels.length ? '' : ' unavailable'}">${escapeHtml(modeStatus)}</span></div><button type="button" data-mqtt-selected-remove aria-label="${escapeHtml(measurementDisplayName(measurement))} entfernen">×</button>`;
      row.querySelector('[data-mqtt-selected-remove]').addEventListener('click', () => {
        mqttDialogState.selectedKeys.delete(key);
        renderMqttDialogCommonValues();
        renderMqttDialogSelectedValues();
        updateMqttDialogStatus();
      });
      return row;
    }));
  }
  setText('#mqtt-dialog-selected-count', `${selected.length} ausgewählt`);
}

function updateMqttDialogAdvanced() {
  const modes = mqttDialogSelectedModes();
  const historical = modes.includes('historical');
  const live = modes.includes('live');
  const historySettings = $('#mqtt-dialog-history-settings');
  const liveSettings = $('#mqtt-dialog-live-settings');
  const recorded = $('.mqtt-dialog-recorded');
  if (historySettings) historySettings.hidden = !historical;
  if (liveSettings) liveSettings.hidden = !live;
  if (recorded) recorded.hidden = !historical;
  const profileSelect = $('#mqtt-dialog-profile');
  if (profileSelect && !profileSelect.options.length) {
    profileSelect.replaceChildren(...mqttProfiles().map((profile) => new Option(profile.name, profile.id)));
    profileSelect.value = defaultMqttProfileId();
  }
  const historyInterval = $('#mqtt-dialog-history-interval');
  if (historyInterval && !historyInterval.options.length) {
    historyInterval.replaceChildren(...HISTORY_CYCLE_OPTIONS.map(([seconds, label]) => new Option(label, String(seconds))));
    historyInterval.value = '900';
  }
  const historyRanges = $('#mqtt-dialog-history-ranges');
  if (historyRanges && !historyRanges.children.length) {
    renderHistoryRangeOptions(historyRanges, ['today'], 'mqtt-dialog-history-range');
  }
  const historyComparisons = $('#mqtt-dialog-history-comparisons');
  if (historyComparisons && !historyComparisons.children.length) {
    renderHistoryComparisons(historyComparisons, []);
  }
}

function initializeMqttDialogExistingSettings() {
  const measurementKeyValue = mqttDialogState.initialMeasurementKey;
  const deviceIdValue = [...mqttDialogState.selectedDeviceIds][0];
  if (!measurementKeyValue || !deviceIdValue) return false;
  const data = mqttDialogState.deviceData.get(deviceIdValue);
  if (!data) return false;
  const cache = data.cache || {};
  const historicalSettings = cache.historicalSettings?.[measurementKeyValue] || {};
  const historicalDefaults = cache.historicalDefaults || state.historicalGlobalSettings || {};
  const historicalAssignments = cache.historicalMqttAssignments?.[measurementKeyValue];
  const liveAssignments = cache.mqttAssignments?.[measurementKeyValue];
  const selectedModes = mqttDialogSelectedModes();
  const profileIds = selectedModes.includes('historical') && Array.isArray(historicalAssignments)
    ? historicalAssignments
    : Array.isArray(liveAssignments) ? liveAssignments : historicalAssignments;
  const profileSelect = $('#mqtt-dialog-profile');
  if (profileSelect && Array.isArray(profileIds) && profileIds[0]
    && [...profileSelect.options].some((option) => option.value === profileIds[0])) {
    profileSelect.value = profileIds[0];
  }

  const interval = historicalSettings.interval || historicalDefaults.refreshInterval;
  const historyInterval = $('#mqtt-dialog-history-interval');
  if (historyInterval && interval) historyInterval.value = String(normalizeHistoryRefreshInterval(interval));
  const ranges = historicalSettings.ranges || historicalDefaults.ranges || ['today'];
  renderHistoryRangeOptions($('#mqtt-dialog-history-ranges'), ranges, 'mqtt-dialog-history-range');
  const comparisons = historicalSettings.comparisons ?? historicalDefaults.comparisons ?? [];
  renderHistoryComparisons($('#mqtt-dialog-history-comparisons'), comparisons);
  const retain = selectedModes.includes('historical')
    ? cache.historicalRetainAssignments?.[measurementKeyValue] === true
    : cache.mqttRetainAssignments?.[measurementKeyValue] === true;
  const retainInput = $('#mqtt-dialog-retain');
  if (retainInput) retainInput.checked = retain;
  const liveInterval = Number(state.deviceRefreshIntervals[cacheKey($('#project-select')?.value || '', deviceIdValue)]) || 0;
  const liveIntervalInput = $('#mqtt-dialog-live-interval');
  if (liveIntervalInput && liveInterval) liveIntervalInput.value = String(liveInterval);
  mqttDialogState.historySettingsTouched = false;
  mqttDialogState.initialMeasurementKey = '';
  return true;
}

function updateMqttDialogStatus() {
  const devices = mqttDialogState.selectedDeviceIds.size;
  const values = mqttDialogSelectedMeasurements().length;
  const configurable = mqttDialogConfigurableMeasurements().length;
  const modes = mqttDialogSelectedModes();
  const modeText = modes.length ? mqttDialogSelectedModeLabel() : 'keine Messwertart';
  setText('#mqtt-dialog-status', devices && values && configurable
    ? `${devices} ${devices === 1 ? 'Gerät' : 'Geräte'} · ${values} ${values === 1 ? 'Messwert' : 'Messwerte'} · ${modeText} wird auf alle ausgewählten Geräte angewendet.`
    : values && !configurable
      ? 'Keine der ausgewählten Messwerte ist für die gewählte Messwertart verfügbar.'
      : modes.length ? 'Noch keine Geräte und Messwerte ausgewählt.' : 'Bitte mindestens Live oder Historie auswählen.');
  const save = $('#mqtt-selection-save');
  if (save) save.disabled = !modes.length || !devices || !configurable || mqttDialogState.loading;
}

function setMqttDialogTab(tab) {
  mqttDialogState.tab = tab;
  $$('[data-mqtt-dialog-tab]').forEach((button) => button.classList.toggle('active', button.dataset.mqttDialogTab === tab));
  $$('[data-mqtt-dialog-panel]').forEach((panel) => {
    const active = panel.dataset.mqttDialogPanel === tab;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

async function loadMqttDialogDeviceData(device, modes = mqttDialogSelectedModes(), requestToken = mqttDialogState.dataRequestToken) {
  const project = $('#project-select')?.value || '';
  const id = deviceId(device);
  if (!project || !id) return null;
  const existing = mqttDialogState.deviceData.get(id);
  if (existing && modes.every((mode) => existing.loadedModes.has(mode))) return existing;
  const stateResult = existing
    ? { data: { measurementCache: existing.cache } }
    : await api(`/api/state/device?project=${encodeURIComponent(project)}&deviceId=${encodeURIComponent(id)}`);
  const sourceCache = stateResult.data?.measurementCache && typeof stateResult.data.measurementCache === 'object'
    ? stateResult.data.measurementCache
    : {};
  const loadedModes = existing?.loadedModes || new Set(
    [
      Array.isArray(sourceCache.onlineValues) ? 'live' : '',
      Array.isArray(sourceCache.historicalValues) ? 'historical' : ''
    ].filter(Boolean)
  );
  let onlineRaw = existing?.live || (Array.isArray(sourceCache.onlineValues) ? sourceCache.onlineValues : null);
  let historicalRaw = existing?.historical || (Array.isArray(sourceCache.historicalValues) ? sourceCache.historicalValues : null);
  const requests = [];
  if (modes.includes('live') && !loadedModes.has('live')) {
    requests.push(api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices/${encodeURIComponent(id)}/online-values`).then((result) => {
      onlineRaw = listData(result.data);
      loadedModes.add('live');
    }));
  }
  if (modes.includes('historical') && !loadedModes.has('historical')) {
    requests.push(api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices/${encodeURIComponent(id)}/historical-values`).then((result) => {
      historicalRaw = listData(result.data);
      loadedModes.add('historical');
    }));
  }
  if (requests.length) await Promise.all(requests);
  if (requestToken !== mqttDialogState.dataRequestToken) return mqttDialogState.deviceData.get(id) || null;
  const current = mqttDialogState.deviceData.get(id);
  const mergedLoadedModes = new Set([...(current?.loadedModes || []), ...loadedModes]);
  const live = mergedLoadedModes.has('live')
    ? (onlineRaw || current?.live || []).map((item) => normalizeMeasurement(item, 'live'))
    : (current?.live || existing?.live || []);
  const historical = mergedLoadedModes.has('historical')
    ? mergeHistoricalMeasurements((historicalRaw || []).map((item) => normalizeMeasurement(item, 'historical'))).filter(historicalMeasurementAvailable)
    : (current?.historical || existing?.historical || []);
  const cache = {
    ...structuredClone(sourceCache),
    ...structuredClone(current?.cache || {}),
    ...(mergedLoadedModes.has('live') ? { onlineValues: live } : {}),
    ...(mergedLoadedModes.has('historical') ? { historicalValues: historical } : {})
  };
  const data = { device: current?.device || device, cache, live, historical, loadedModes: mergedLoadedModes };
  mqttDialogState.deviceData.set(id, data);
  return data;
}

async function refreshMqttDialogData() {
  const requestToken = ++mqttDialogState.dataRequestToken;
  const ids = [...mqttDialogState.selectedDeviceIds];
  const modes = mqttDialogSelectedModes();
  mqttDialogState.loading = mqttDialogDataPending();
  setText('#mqtt-dialog-loading', mqttDialogState.loading ? 'Messwertdefinitionen werden geladen …' : '');
  renderMqttDialogCommonValues();
  updateMqttDialogStatus();
  if (!ids.length) return;
  try {
    await Promise.all(ids.map((id) => loadMqttDialogDeviceData(state.devices.find((device) => deviceId(device) === id), modes, requestToken)));
    if (requestToken !== mqttDialogState.dataRequestToken) return;
    if (mqttDialogState.initialMeasurementKey
      && mqttDialogAvailableMeasurements().some((measurement) => measurementKey(measurement) === mqttDialogState.initialMeasurementKey)) {
      mqttDialogState.selectedKeys.add(mqttDialogState.initialMeasurementKey);
      initializeMqttDialogExistingSettings();
    }
  } finally {
    if (requestToken !== mqttDialogState.dataRequestToken) return;
    mqttDialogState.loading = false;
    setText('#mqtt-dialog-loading', '');
    renderMqttDialogCommonValues();
    renderMqttDialogSelectedValues();
    updateMqttDialogStatus();
  }
}

function openMqttSelectionDialog({ deviceIdValue = '', mode = 'live', measurementKeyValue = '' } = {}) {
  const project = $('#project-select')?.value || '';
  if (!project) {
    showToast('Bitte zuerst ein GridVis-Projekt auswählen.', 'warning');
    setView('settings');
    return;
  }
  if (!state.devices.length) {
    showToast('Bitte zuerst die Geräte des Projekts laden.', 'warning');
    setView('devices');
    return;
  }
  const initialMode = mode === 'historical' ? 'historical' : 'live';
  mqttDialogState.dataRequestToken += 1;
  mqttDialogState.modes = new Set([initialMode]);
  mqttDialogState.tab = 'selection';
  mqttDialogState.selectedDeviceIds = new Set(deviceIdValue && state.devices.some((device) => deviceId(device) === String(deviceIdValue))
    ? [String(deviceIdValue)]
    : []);
  mqttDialogState.deviceData = new Map();
  mqttDialogState.selectedKeys = new Set();
  mqttDialogState.deviceSearch = '';
  mqttDialogState.valueSearch = '';
  mqttDialogState.initialMeasurementKey = measurementKeyValue;
  mqttDialogState.openDeviceGroups = new Set();
  mqttDialogState.openDeviceNodes = new Set();
  mqttDialogState.openMeasurementGroups = new Set();
  mqttDialogState.openMeasurementSubGroups = new Set();
  mqttDialogState.historySettingsTouched = false;
  $('#mqtt-dialog-mode-live').checked = initialMode === 'live';
  $('#mqtt-dialog-mode-historical').checked = initialMode === 'historical';
  $('#mqtt-dialog-device-search').value = '';
  $('#mqtt-dialog-value-search').value = '';
  $('#mqtt-dialog-profile').replaceChildren(...mqttProfiles().map((profile) => new Option(profile.name, profile.id)));
  $('#mqtt-dialog-profile').value = defaultMqttProfileId();
  $('#mqtt-dialog-live-interval').value = '0';
  $('#mqtt-dialog-history-interval').replaceChildren(...HISTORY_CYCLE_OPTIONS.map(([seconds, label]) => new Option(label, String(seconds))));
  $('#mqtt-dialog-history-interval').value = '900';
  $('#mqtt-dialog-retain').checked = false;
  $('#mqtt-dialog-overwrite').checked = false;
  renderHistoryRangeOptions($('#mqtt-dialog-history-ranges'), ['today'], 'mqtt-dialog-history-range');
  renderHistoryComparisons($('#mqtt-dialog-history-comparisons'), []);
  setMqttDialogTab('selection');
  renderMqttDialogDevices();
  renderMqttDialogCommonValues();
  renderMqttDialogSelectedValues();
  updateMqttDialogAdvanced();
  const dialog = $('#mqtt-selection-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  refreshMqttDialogData().catch((error) => {
    mqttDialogState.loading = false;
    renderMqttDialogCommonValues();
    updateMqttDialogStatus();
    showError(error);
  });
}

function closeMqttSelectionDialog() {
  const dialog = $('#mqtt-selection-dialog');
  if (dialog?.open && typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog?.removeAttribute('open');
  }
  mqttDialogState.loading = false;
}

function appendUniqueMeasurement(list, measurement) {
  const next = Array.isArray(list) ? [...list] : [];
  if (!next.some((entry) => measurementKey(entry) === measurementKey(measurement))) next.push(measurement);
  return next;
}

async function saveMqttSelection() {
  const project = $('#project-select')?.value || '';
  const ids = [...mqttDialogState.selectedDeviceIds];
  const measurements = mqttDialogSelectedMeasurements();
  const configurableMeasurements = mqttDialogConfigurableMeasurements();
  const modes = mqttDialogSelectedModes();
  if (!modes.length) {
    showToast('Bitte Live und/oder Historie auswählen.', 'warning');
    return;
  }
  if (!project || !ids.length || !measurements.length || !configurableMeasurements.length) {
    showToast('Bitte mindestens ein Gerät und einen Messwert auswählen.', 'warning');
    return;
  }
  // Invalidate an older definition/history request before changing the
  // assignments. Otherwise its captured pre-save selection could be written
  // back after this dialog has already saved the new Live/Historie state.
  markMeasurementMutation();
  // Drain a UI-state request that may have been queued before the dedicated
  // device-cache update. The cache update below must be the newer write.
  await flushUiState();
  const button = $('#mqtt-selection-save');
  if (button) {
    button.disabled = true;
    button.textContent = 'Speichere …';
  }
  const profileId = $('#mqtt-dialog-profile').value || defaultMqttProfileId();
  const retain = $('#mqtt-dialog-retain').checked === true;
  const overwrite = $('#mqtt-dialog-overwrite').checked === true;
  const liveInterval = Number($('#mqtt-dialog-live-interval').value) || 0;
  const historyInterval = normalizeHistoryRefreshInterval($('#mqtt-dialog-history-interval').value);
  const historyRanges = selectedHistoryRanges($('#mqtt-dialog-history-ranges'));
  const historyComparisons = normalizeHistoryComparisons(selectedHistoryComparisons($('#mqtt-dialog-history-comparisons')));
  let saved = 0;
  const savedByMode = { live: 0, historical: 0 };
  let skipped = 0;
  let unavailable = 0;
  const savedCaches = new Map();
  try {
    for (const id of ids) {
      const data = await loadMqttDialogDeviceData(state.devices.find((device) => deviceId(device) === id));
      const cache = structuredClone(data.cache || {});
      let changed = false;
      for (const mode of modes) {
        const historical = mode === 'historical';
        const available = historical ? data.historical : data.live;
        const availableByKey = new Map(available.map((measurement) => [measurementKey(measurement), measurement]));
        const assignmentField = historical ? 'historicalMqttAssignments' : 'mqttAssignments';
        const activeField = historical ? 'historicalMqttActiveAssignments' : 'mqttActiveAssignments';
        const selectedField = historical ? 'historicalSelectedMeasurements' : 'selectedMeasurements';
        const retainField = historical ? 'historicalRetainAssignments' : 'mqttRetainAssignments';
        cache[assignmentField] = { ...(cache[assignmentField] || {}) };
        cache[activeField] = { ...(cache[activeField] || {}) };
        cache[retainField] = { ...(cache[retainField] || {}) };
        cache[selectedField] = Array.isArray(cache[selectedField]) ? cache[selectedField] : [];
        if (historical) cache.historicalSettings = { ...(cache.historicalSettings || {}) };
        for (const selected of measurements) {
          const measurement = availableByKey.get(measurementKey(selected));
          if (!measurement) {
            unavailable += 1;
            continue;
          }
          const key = measurementKey(measurement);
          const alreadyConfigured = Array.isArray(cache[assignmentField][key]) && cache[assignmentField][key].length > 0;
          const nextHistoricalSettings = historical ? {
            interval: historyInterval,
            ranges: historyRanges,
            comparisons: historyComparisons
          } : null;
          if (historical && mqttDialogState.historySettingsTouched) {
            const previousSettings = cache.historicalSettings[key] || {};
            if (JSON.stringify(previousSettings) !== JSON.stringify(nextHistoricalSettings)) {
              cache.historicalSettings[key] = nextHistoricalSettings;
              changed = true;
              saved += 1;
              savedByMode[mode] += 1;
            }
          }
          if (alreadyConfigured && !overwrite) {
            skipped += 1;
            continue;
          }
          cache[assignmentField][key] = [profileId];
          cache[activeField][key] = [profileId];
          cache[selectedField] = appendUniqueMeasurement(cache[selectedField], measurement);
          if (!historical) cache.displayedMeasurements = appendUniqueMeasurement(cache.displayedMeasurements, measurement);
          if (retain) cache[retainField][key] = true;
          else delete cache[retainField][key];
          if (historical) {
            cache.historicalSettings[key] = nextHistoricalSettings;
          } else if (liveInterval > 0 || overwrite) {
            const refreshKey = cacheKey(project, id);
            if (liveInterval > 0) state.deviceRefreshIntervals[refreshKey] = liveInterval;
            else delete state.deviceRefreshIntervals[refreshKey];
          }
          changed = true;
          saved += 1;
          savedByMode[mode] += 1;
        }
      }
      if (!changed) continue;
      const key = cacheKey(project, id);
      state.measurementCache[key] = cache;
      savedCaches.set(key, cache);
      await persistBackendDeviceState(project, id, cache);
    }
    // The dedicated endpoint above is authoritative. Keep the legacy
    // top-level browser fields in sync as well, so the following UI-state
    // flush cannot serialize an older cache for the currently open device.
    const currentDeviceKey = cacheKey(project, deviceId(state.currentDevice || {}));
    const currentSavedCache = savedCaches.get(currentDeviceKey);
    if (currentSavedCache && isLoadedDeviceState(project, deviceId(state.currentDevice || {}))) {
      restoreMeasurementCache(project, deviceId(state.currentDevice || {}));
    }
    writeUiCache();
    await flushUiState();
    closeMqttSelectionDialog();
    await loadMqttOverview({ silent: true });
    const details = [
      `${saved} ${saved === 1 ? 'Zuordnung' : 'Zuordnungen'} gespeichert`,
      savedByMode.live ? `Live: ${savedByMode.live}` : '',
      savedByMode.historical ? `Historie: ${savedByMode.historical}` : '',
      skipped ? `${skipped} bereits vorhanden` : '',
      unavailable ? `${unavailable} in der gewählten Art nicht verfügbar` : ''
    ].filter(Boolean).join(', ');
    const message = `${details}.`;
    showToast(message, 'success');
  } catch (error) {
    showError(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Speichern und veröffentlichen';
    }
  }
}

function isLiveFocusActive() {
  return state.currentView === 'device-detail' && state.currentDetailTab === 'live';
}

function hasDeviceDataFocus() {
  return state.currentView === 'device-detail' || Boolean($('#device-info-dialog')?.open);
}

function liveFocusDeviceId() {
  if ($('#device-info-dialog')?.open && state.infoDevice) return deviceId(state.infoDevice);
  if (isLiveFocusActive()) return deviceId(state.currentDevice || {});
  return '';
}

function liveTargetsForCurrentFocus() {
  const infoFocusDeviceId = $('#device-info-dialog')?.open && state.infoDevice ? deviceId(state.infoDevice) : '';
  const targets = liveTargetsForFocus({
    includeDisplay: isLiveFocusActive() || Boolean(infoFocusDeviceId),
    includeAvailable: isLiveFocusActive()
  });
  if (!isLiveFocusActive()) return targets;
  const project = $('#project-select')?.value || '';
  const focusedId = deviceId(state.currentDevice || {});
  // The table is viewport-limited, but selected cards are always part of the
  // live focus as well. Otherwise a card whose row is currently scrolled out
  // of view would neither refresh nor be included in a manual MQTT publish.
  const focusedMeasurements = uniqueMeasurements([
    ...(state.displayedMeasurements || []),
    ...(state.selectedMeasurements || []),
    ...valuesInListViewport('live', $('#display-value-list'))
  ]);
  const visibleTarget = liveTargetForMeasurements(
    project,
    focusedId,
    focusedMeasurements
  );
  return visibleTarget ? [visibleTarget] : [];
}

function liveTargetsStillFocused(targets) {
  const focusedId = liveFocusDeviceId();
  return Boolean(focusedId)
    && Array.isArray(targets)
    && targets.length > 0
    && targets.every((target) => String(target.deviceId) === String(focusedId));
}

function mqttLiveTargets(project, targets) {
  return targets.map((target) => ({
    ...target,
    measurements: target.measurements.filter((measurement) => (
      isLoadedDeviceState(project, target.deviceId)
        ? measurementMqttActive(measurement)
        : measurement.mqttActiveProfileIds?.length > 0
    ))
  })).filter((target) => target.measurements.length);
}

function configureLiveRefresh() {
  clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = null;
  clearInterval(state.liveCacheRefreshTimer);
  state.liveCacheRefreshTimer = null;
  if (!state.config?.gridvis?.configured || !hasDeviceDataFocus()) return;
  const interval = Number($('#live-refresh-interval')?.value || state.liveRefreshInterval || 0);
  state.liveRefreshInterval = [0, 1, 2, 5, 10, 30, 60, 300].includes(interval) ? interval : 0;
  const targets = liveTargetsForCurrentFocus();
  const tick = Math.min(...targets.map((target) => target.refreshInterval).filter((value) => value > 0));
  if (Number.isFinite(tick)) {
    state.liveRefreshTimer = setInterval(() => {
      const now = Date.now();
      const dueTargets = liveTargetsForCurrentFocus().filter((target) => {
        const lastRequestedAt = state.liveLastRequestedAt[target.deviceId] || 0;
        return target.refreshInterval > 0 && now - lastRequestedAt >= target.refreshInterval * 1000;
      });
      if (dueTargets.length) loadLiveData({ silent: true, targets: dueTargets, requestedAt: now }).catch(reportBackgroundError);
    }, tick * 1000);
  }
  const project = $('#project-select')?.value || '';
  if (mqttLiveTargets(project, targets).length) {
    state.liveCacheRefreshTimer = setInterval(() => {
      if (state.liveRequestInFlight || state.liveCacheRequestInFlight) return;
      const focusedTargets = mqttLiveTargets(project, liveTargetsForCurrentFocus());
      if (!focusedTargets.length) return;
      state.liveCacheRequestInFlight = true;
      loadLiveData({ silent: true, cacheOnly: true, targets: focusedTargets })
        .catch(reportBackgroundError)
        .finally(() => { state.liveCacheRequestInFlight = false; });
    }, 500);
  }
}

function historicalSettingsFor(measurement, settings = state.historicalSettings) {
  const configured = settings?.[measurementKey(measurement)] || {};
  const defaults = currentHistoricalDefaults();
  const comparisons = Array.isArray(configured.comparisons)
    ? configured.comparisons
    : defaults.comparisons;
  return {
    interval: normalizeHistoryRefreshInterval(configured.interval || defaults.refreshInterval),
    ranges: historicalRangesWithComparison(
      configured.ranges || defaults.ranges,
      comparisons
    ),
    comparisons
  };
}

function historicalSettingsForTarget(measurement, target) {
  const project = target?.project || $('#project-select')?.value || '';
  const cache = state.measurementCache[cacheKey(project, target?.deviceId)] || {};
  const settings = isLoadedDeviceState(project, target?.deviceId)
    ? state.historicalSettings
    : cache.historicalSettings || {};
  const defaults = historicalDefaultsForTarget(target);
  const configured = settings?.[measurementKey(measurement)] || {};
  const comparisons = Array.isArray(configured.comparisons)
    ? configured.comparisons
    : defaults.comparisons;
  return {
    interval: normalizeHistoryRefreshInterval(configured.interval || defaults.refreshInterval),
    ranges: historicalRangesWithComparison(
      configured.ranges || defaults.ranges,
      comparisons
    ),
    comparisons
  };
}

function historicalDiscoveryRanges(measurement, target = null) {
  return historicalSettingsForTarget(measurement, target).ranges;
}

function historicalTargetForDevice(project, id, { includeDisplay = true } = {}) {
  const current = isLoadedDeviceState(project, id);
  const cache = state.measurementCache[cacheKey(project, id)] || {};
  const available = current ? state.historicalValues : (cache.historicalValues || []);
  const selected = current ? state.historicalSelectedMeasurements : (cache.historicalSelectedMeasurements || []);
  const assignments = current ? state.historicalMqttAssignments : cache.historicalMqttAssignments || {};
  const activeAssignments = current ? state.historicalMqttActiveAssignments : cache.historicalMqttActiveAssignments || {};
  const selectedKeys = new Set(selected.map(measurementKey));
  const measurements = available.filter((measurement) => includeDisplay && selectedKeys.has(measurementKey(measurement)) && historicalMeasurementAvailable(measurement))
    .map((measurement) => {
      return {
      ...measurement,
      ...(Array.isArray(assignments[measurementKey(measurement)]) ? { mqttProfileIds: assignments[measurementKey(measurement)] } : {}),
      ...(Array.isArray(activeAssignments[measurementKey(measurement)]) ? { mqttActiveProfileIds: activeAssignments[measurementKey(measurement)] } : {}),
      historyRanges: historicalDiscoveryRanges(measurement, { project, deviceId: String(id) }),
      retainState: (current ? state.historicalRetainAssignments : cache.historicalRetainAssignments || {})[measurementKey(measurement)] === true
      };
    });
  if (!measurements.length) return null;
  return { project, deviceId: String(id), device: liveTargetDevice(project, id), measurements };
}

function historicalTargetsForProject() {
  const project = $('#project-select')?.value || '';
  if (!project) return [];
  // Browser history is display data for the currently open device. The
  // backend scheduler publishes MQTT history for all devices independently;
  // fetching every cached device here made a checkbox change fan out into a
  // large GridVis request batch.
  const currentId = deviceId(state.currentDevice || {});
  if (!currentId) return [];
  const target = historicalTargetForDevice(project, currentId);
  return target ? [target] : [];
}

function configureHistoricalRefresh() {
  clearTimeout(state.historicalRefreshTimer);
  state.historicalRefreshTimer = null;
  if (!state.config?.gridvis?.configured || state.currentView !== 'device-detail') return;
  const targets = historicalTargetsForProject();
  const intervals = targets.flatMap((target) => target.measurements.map((measurement) => historicalSettingsForTarget(measurement, target).interval));
  const interval = Math.min(...intervals.filter((value) => value > 0));
  if (!Number.isFinite(interval)) return;
  const period = interval * 1000;
  const offset = normalizeHistoryMinuteOffset(currentHistoricalDefaults().minuteOffset) * 60 * 1000;
  const elapsed = ((Date.now() - offset) % period + period) % period;
  const delay = period - elapsed;
  state.historicalRefreshTimer = setTimeout(async () => {
    try {
      // The backend owns MQTT history polling. The browser timer only keeps
      // the currently visible device display fresh and must not publish a
      // second copy of the same history requests.
      await loadHistoricalData({ silent: true, scheduled: true, publishMqtt: false });
    } catch (error) {
      reportBackgroundError(error);
    } finally {
      configureHistoricalRefresh();
    }
  }, Math.max(250, delay));
}

function mqttProfiles() {
  const profiles = state.config?.mqtt?.profiles;
  if (Array.isArray(profiles) && profiles.length) return profiles;
  return [{
    id: 'homeassistant',
    name: 'Home Assistant',
    mode: 'homeassistant',
    enabled: state.config?.discovery?.enabled !== false,
    isDefault: true,
    discoveryPrefix: state.config?.discovery?.prefix || 'homeassistant',
    component: 'sensor',
    topicPrefix: state.config?.mqtt?.topicPrefix || 'gridvis2mqtt',
    stateTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/state',
    availabilityTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/availability',
    discoveryTopicTemplate: '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config'
  }];
}

function defaultMqttProfileId() {
  const profiles = mqttProfiles();
  return state.config?.mqtt?.defaultProfileId
    || profiles.find((profile) => profile.isDefault)?.id
    || profiles[0]?.id
    || 'homeassistant';
}

function isHistoricalMeasurement(measurement) {
  // Online and historical GridVis definitions can have the same value/type
  // pair (for example ActiveEnergyConsumed/SUM13). The source flag is the
  // discriminator; looking up the key in the other list mixes both sources.
  if (!measurement || typeof measurement !== 'object') return false;
  if (measurement.historical === true) return true;
  if (measurement.historical === false) return false;
  return measurement.online === false && measurement.value !== 'UserDefined';
}

function historicalUsesEnergyApi(measurement) {
  const baseUnit = measurementUnitInfo(measurement).baseUnit;
  if (['Wh', 'varh', 'VAh', 'J'].includes(baseUnit)) return true;
  return /energy|consum|deliver|wirkarbeit|arbeit/i.test(
    `${measurement?.value || ''} ${measurement?.name || ''} ${measurement?.typeLabel || ''}`
  );
}

function measurementProfileIds(measurement) {
  const key = measurementKey(measurement);
  const assignments = isHistoricalMeasurement(measurement) ? state.historicalMqttAssignments : state.mqttAssignments;
  const selected = isHistoricalMeasurement(measurement) ? state.historicalSelectedMeasurements : state.selectedMeasurements;
  if (Array.isArray(measurement.mqttProfileIds)) {
    return measurement.mqttProfileIds.filter((id) => mqttProfiles().some((profile) => profile.id === id));
  }
  if (Array.isArray(assignments[key])) {
    return assignments[key].filter((id) => mqttProfiles().some((profile) => profile.id === id));
  }
  return selected.some((item) => measurementKey(item) === key)
    ? [defaultMqttProfileId()]
    : [];
}

function measurementActiveProfileIds(measurement) {
  const key = measurementKey(measurement);
  const assignments = isHistoricalMeasurement(measurement) ? state.historicalMqttActiveAssignments : state.mqttActiveAssignments;
  const selected = isHistoricalMeasurement(measurement) ? state.historicalSelectedMeasurements : state.selectedMeasurements;
  if (Array.isArray(measurement.mqttActiveProfileIds)) {
    return measurement.mqttActiveProfileIds.filter((id) => mqttProfiles().some((profile) => profile.id === id));
  }
  if (Array.isArray(assignments[key])) {
    return assignments[key].filter((id) => mqttProfiles().some((profile) => profile.id === id));
  }
  // Historical values remain selected for display when MQTT is switched off.
  // Selection alone must therefore not reactivate their MQTT publication.
  if (isHistoricalMeasurement(measurement)) return [];
  return selected.some((item) => measurementKey(item) === key)
    ? measurementProfileIds(measurement)
    : [];
}

function measurementMqttActive(measurement) {
  return measurementActiveProfileIds(measurement).length > 0;
}

function measurementRetainState(measurement) {
  if (typeof measurement?.retainState === 'boolean') return measurement.retainState;
  const historical = isHistoricalMeasurement(measurement);
  const assignments = historical ? state.historicalRetainAssignments : state.mqttRetainAssignments;
  return historical ? assignments[measurementKey(measurement)] === true : assignments[measurementKey(measurement)] === true;
}

function measurementRetainStateForDevice(measurement, device = selectedDevice()) {
  const project = $('#project-select')?.value || '';
  if (isLoadedDeviceState(project, deviceId(device))) return measurementRetainState(measurement);
  const cache = state.measurementCache[cacheKey(project, deviceId(device))] || {};
  const assignments = isHistoricalMeasurement(measurement)
    ? cache.historicalRetainAssignments
    : cache.mqttRetainAssignments;
  if (isHistoricalMeasurement(measurement)) {
    return measurement.retainState === true || assignments?.[measurementKey(measurement)] === true;
  }
  return measurement.retainState === true || assignments?.[measurementKey(measurement)] === true;
}

function measurementProfileIdsForDevice(measurement, device = selectedDevice()) {
  const project = $('#project-select')?.value || '';
  if (isLoadedDeviceState(project, deviceId(device))) return measurementProfileIds(measurement);
  const cache = state.measurementCache[cacheKey(project, deviceId(device))] || {};
  const assignments = isHistoricalMeasurement(measurement) ? cache.historicalMqttAssignments : cache.mqttAssignments;
  const ids = assignments?.[measurementKey(measurement)];
  return Array.isArray(ids) ? ids : measurementProfileIds(measurement);
}

function measurementActiveForDevice(measurement, device = selectedDevice()) {
  const project = $('#project-select')?.value || '';
  if (isLoadedDeviceState(project, deviceId(device))) return measurementMqttActive(measurement);
  const cache = state.measurementCache[cacheKey(project, deviceId(device))] || {};
  const assignments = isHistoricalMeasurement(measurement) ? cache.historicalMqttActiveAssignments : cache.mqttActiveAssignments;
  return Array.isArray(assignments?.[measurementKey(measurement)])
    && assignments[measurementKey(measurement)].length > 0;
}

function setMeasurementProfileIds(measurement, profileIds) {
  state.measurementMutationVersion += 1;
  const key = measurementKey(measurement);
  const assignments = isHistoricalMeasurement(measurement) ? state.historicalMqttAssignments : state.mqttAssignments;
  const ids = [...new Set(profileIds)].filter((id) => mqttProfiles().some((profile) => profile.id === id));
  if (ids.length) assignments[key] = ids;
  else delete assignments[key];
  updateSelectedCounters();
  updateDiscoveryProfileSummary();
  configureLiveRefresh();
  configureHistoricalRefresh();
  writeUiCache();
}

function markMeasurementMutation() {
  state.measurementMutationVersion += 1;
}

function setMeasurementMqttActive(measurement, enabled) {
  state.measurementMutationVersion += 1;
  const key = measurementKey(measurement);
  const profileIds = measurementProfileIds(measurement);
  const historical = isHistoricalMeasurement(measurement);
  const assignments = historical ? state.historicalMqttAssignments : state.mqttAssignments;
  const activeAssignments = historical ? state.historicalMqttActiveAssignments : state.mqttActiveAssignments;
  const selectedMeasurements = historical ? state.historicalSelectedMeasurements : state.selectedMeasurements;
  const allMeasurements = historical ? state.historicalValues : state.onlineValues;
  const current = allMeasurements.find((item) => measurementKey(item) === key) || measurement;
  // Keep the Discovery assignment separate from the publication switch. Older
  // states may only contain the active assignment; restore its profile before
  // removing the active assignment so deactivation publishes `offline`
  // instead of clearing the retained Discovery.
  const configuredProfileIds = profileIds.length
    ? profileIds
    : (Array.isArray(activeAssignments[key]) ? activeAssignments[key] : []);
  if (configuredProfileIds.length && (!Array.isArray(assignments[key]) || !assignments[key].length)) {
    assignments[key] = [...configuredProfileIds];
  }
  if (enabled && configuredProfileIds.length) {
    activeAssignments[key] = [...configuredProfileIds];
    if (!selectedMeasurements.some((item) => measurementKey(item) === key)) {
      selectedMeasurements.push(current);
    }
  } else {
    delete activeAssignments[key];
    if (!historical) state.selectedMeasurements = selectedMeasurements.filter((item) => measurementKey(item) !== key);
  }
  updateSelectedCounters();
  if (enabled) deferMqttValues();
  configureLiveRefresh();
  configureHistoricalRefresh();
  writeUiCache();
}

function updateMqttState() {
  const brokers = state.config?.mqtt?.brokers || [];
  const configured = Boolean(state.config?.mqtt?.url || brokers.some((broker) => broker.url));
  const connection = state.config?.mqtt?.connection || {};
  const brokerStates = Array.isArray(connection.brokers) ? connection.brokers : [];
  const connected = brokerStates.some((broker) => broker.connected);
  const connecting = brokerStates.some((broker) => ['connecting', 'reconnecting'].includes(broker.status));
  const defaultProfile = mqttProfiles().find((profile) => profile.id === defaultMqttProfileId());
  setText('#mqtt-state', !configured ? 'deaktiviert' : connected ? 'verbunden' : connecting ? 'verbinde ...' : 'getrennt');
  setText('#mqtt-state-detail', !configured
    ? 'Kein Broker konfiguriert'
    : connected ? (state.config?.mqtt?.url || 'Broker verbunden')
      : connecting ? 'Broker-Verbindung wird aufgebaut ...'
        : 'Alle Broker sind getrennt oder nicht erreichbar');
  updateTopbarMqttStatus();
  setText('#discovery-status-badge', defaultProfile?.enabled === false ? 'deaktiviert' : 'aktiv');
  $('#discovery-status-badge')?.classList.toggle('offline', defaultProfile?.enabled === false);
  updateDiscoveryProfileSummary();
}

function updateDiscoveryProfileSummary() {
  const profiles = mqttProfiles();
  const counts = new Map();
  for (const ids of [...Object.values(state.mqttAssignments), ...Object.values(state.historicalMqttAssignments)]) {
    for (const id of ids || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const summary = profiles
    .map((profile) => profile.name + ': ' + (counts.get(profile.id) || 0))
    .join(' · ');
  setText('#discovery-profile-summary', summary || 'Noch keine MQTT-Zuordnung vorhanden.');
}

function fillSelect(select, entries, placeholder, value = '', getValue = null, getLabel = null) {
  if (!select) return;
  select.replaceChildren(new Option(placeholder, ''));
  for (const entry of entries) {
    const id = String(getValue ? getValue(entry) : itemValue(entry, 'name', 'id', 'path'));
    const label = String(getLabel ? getLabel(entry) : itemValue(entry, 'name', 'label', 'id', 'path') || id);
    select.append(new Option(label, id));
  }
  if (value && [...select.options].some((option) => option.value === String(value))) select.value = String(value);
}

function deviceId(device) {
  return String(itemValue(device, 'id', 'deviceId', 'serialNr', 'serialNumber', 'name'));
}

function deviceName(device) {
  return String(itemValue(device, 'name', 'label', 'title', 'serialNr', 'serialNumber', 'id') || 'Unbenanntes Gerät');
}

function deviceLeafName(device) {
  const name = deviceName(device);
  const parts = name.split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) || name;
}

function deviceOnline(device) {
  const status = deviceDetailValue(device, 'status', 'state', 'online', 'connected');
  if (typeof status === 'boolean') return status;
  return !['offline', 'disconnected', 'false', '0'].includes(String(status).toLowerCase());
}

function deviceType(device) {
  return String(deviceDetailValue(device, 'type', 'model', 'deviceType', 'product') || 'GridVis-Messgerät');
}

function deviceDetailValue(device, ...keys) {
  const nestedKeys = keys.flatMap((key) => [`info.${key}`, `deviceInfo.${key}`, `device_info.${key}`]);
  return itemValue(device, ...keys, ...nestedKeys);
}

async function loadDeviceDetails(device, { refresh = false, selectionToken = null } = {}) {
  const project = $('#project-select')?.value || '';
  const id = deviceId(device);
  if (!project || !id) return device;
  try {
    const refreshQuery = refresh ? '?refresh=true' : '';
    const result = await api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices/${encodeURIComponent(id)}${refreshQuery}`);
    const detail = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
    if (selectionToken !== null && !isCurrentDeviceRequest(selectionToken, id)) return device;
    const baseInfo = device?.info && typeof device.info === 'object' && !Array.isArray(device.info) ? device.info : {};
    const detailInfo = detail.info && typeof detail.info === 'object' && !Array.isArray(detail.info) ? detail.info : {};
    const merged = {
      ...device,
      ...detail,
      info: { ...baseInfo, ...detailInfo }
    };
    const index = state.devices.findIndex((entry) => deviceId(entry) === id);
    if (index >= 0) state.devices[index] = merged;
    state.deviceCache[project] = state.devices;
    if (state.currentDevice && deviceId(state.currentDevice) === id) state.currentDevice = merged;
    if (state.currentView === 'device-detail' && state.currentDevice && deviceId(state.currentDevice) === id) {
      renderDeviceInfo(merged);
      setDeviceInfoLoading(false);
    }
    if (state.currentDevice && deviceId(state.currentDevice) === id) {
      renderDeviceSelect(id);
      renderDeviceList();
    }
    return merged;
  } catch (error) {
    console.warn(`Detaildaten für GridVis-Gerät ${id} konnten nicht geladen werden:`, error.message);
    if ((selectionToken === null || isCurrentDeviceRequest(selectionToken, id))
      && state.currentView === 'device-detail' && state.currentDevice && deviceId(state.currentDevice) === id) {
      setDeviceInfoLoading(false);
    }
    return device;
  }
}

function deviceParentReference(device) {
  const parent = itemValue(
    device,
    'parentId',
    'parentID',
    'parentDeviceId',
    'parentDeviceID',
    'parent.id',
    'parent.deviceId',
    'parentDevice.id',
    'parentDevice.deviceId',
    'parent',
    'parentDevice'
  );
  if (!parent || typeof parent !== 'object') return String(parent || '');
  return String(itemValue(parent, 'id', 'deviceId', 'serialNr', 'serialNumber', 'name'));
}

function deviceParentName(device) {
  const parent = itemValue(device, 'parent', 'parentDevice');
  if (!parent || typeof parent !== 'object') return '';
  return String(itemValue(parent, 'name', 'label', 'title', 'id') || '');
}

function inferredDeviceParent(device, devices) {
  const name = deviceName(device).trim();
  if (!name || !name.includes(' / ')) return null;

  const normalizedName = name.toLocaleLowerCase('de');
  return devices
    .filter((candidate) => deviceId(candidate) !== deviceId(device))
    .filter((candidate) => {
      const candidateName = deviceName(candidate).trim();
      return candidateName
        && normalizedName.startsWith(`${candidateName.toLocaleLowerCase('de')} / `);
    })
    .sort((left, right) => deviceName(right).length - deviceName(left).length)[0] || null;
}

function compareDeviceText(left, right) {
  return String(left).localeCompare(String(right), 'de', { numeric: true, sensitivity: 'base' });
}

function isDeviceSortMode(value) {
  return ['name', 'type', 'selected-name', 'selected-type'].includes(value);
}

function deviceHasSelection(project, id) {
  return mqttDeviceCount(project, id) > 0;
}

function compareDevices(left, right) {
  const typeFirst = state.deviceSort === 'type' || state.deviceSort === 'selected-type';
  const primary = typeFirst ? deviceType(left) : deviceName(left);
  const secondary = typeFirst ? deviceName(left) : deviceType(left);
  const primaryRight = typeFirst ? deviceType(right) : deviceName(right);
  const secondaryRight = typeFirst ? deviceName(right) : deviceType(right);
  return compareDeviceText(primary, primaryRight)
    || compareDeviceText(secondary, secondaryRight)
    || compareDeviceText(deviceId(left), deviceId(right));
}

function orderedDevices(devices) {
  const byId = new Map(devices.map((device) => [deviceId(device), device]));
  const byName = new Map();
  for (const device of devices) byName.set(deviceName(device).toLocaleLowerCase('de'), device);

  const children = new Map();
  const roots = [];
  for (const device of devices) {
    const reference = deviceParentReference(device);
    let parent = reference
      ? (byId.get(reference) || byName.get(reference.toLocaleLowerCase('de')))
      : null;
    if (!parent) parent = inferredDeviceParent(device, devices);
    if (parent && deviceId(parent) !== deviceId(device)) {
      const parentId = deviceId(parent);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(device);
    } else {
      roots.push(device);
    }
  }

  const project = $('#project-select')?.value || '';
  const selectionFirst = state.deviceSort === 'selected-name' || state.deviceSort === 'selected-type';
  const branchHasSelection = (device, trail = new Set()) => {
    const id = deviceId(device);
    if (deviceHasSelection(project, id)) return true;
    if (trail.has(id)) return false;
    const nextTrail = new Set(trail).add(id);
    return (children.get(id) || []).some((child) => branchHasSelection(child, nextTrail));
  };
  const compareRoots = (left, right) => {
    if (selectionFirst) {
      const leftSelected = branchHasSelection(left);
      const rightSelected = branchHasSelection(right);
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    }
    return compareDevices(left, right);
  };
  const result = [];
  const visited = new Set();
  const appendBranch = (device, depth, parent = null) => {
    const id = deviceId(device);
    if (visited.has(id)) return;
    visited.add(id);
    result.push({ device, depth, parent });
    const branch = [...(children.get(id) || [])].sort(compareRoots);
    for (const child of branch) appendBranch(child, depth + 1, device);
  };

  for (const root of [...roots].sort(compareRoots)) appendBranch(root, 0);
  for (const device of [...devices].sort(compareDevices)) appendBranch(device, 0);
  if (!selectionFirst) return result;
  return result.sort((left, right) => {
    const leftSelected = deviceHasSelection(project, deviceId(left.device));
    const rightSelected = deviceHasSelection(project, deviceId(right.device));
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return compareDevices(left.device, right.device);
  });
}

function renderDeviceSelect(selectedId = '', placeholder = 'Gerät direkt öffnen') {
  const entries = orderedDevices(state.devices);
  fillSelect(
    $('#device-select'),
    entries,
    state.devices.length ? placeholder : 'Erst Projekt laden',
    selectedId,
    ({ device }) => deviceId(device),
    ({ device, depth }) => `${depth ? `${'\u00a0\u00a0'.repeat(depth)}↳ ` : ''}${deviceName(device)}`
  );
}

function deviceIconSource(device) {
  const rawIcon = itemValue(device, 'iconUrl', 'iconUri', 'imageUrl', 'deviceIconUrl', 'icon', 'image');
  const icon = rawIcon && typeof rawIcon === 'object'
    ? itemValue(rawIcon, 'url', 'href', 'uri', 'src')
    : rawIcon;
  const project = $('#project-select')?.value;
  const id = deviceId(device);
  return project && id
    ? `/api/gridvis/projects/${encodeURIComponent(project)}/deviceicon/${encodeURIComponent(id)}`
    : String(icon || '').startsWith('data:image/') ? String(icon) : '';
}

function setDeviceAvatar(element, device) {
  if (!element) return;
  const fallback = () => {
    element.replaceChildren();
    const type = deviceType(device).toLowerCase();
    element.textContent = type.includes('virtual') ? '◌' : type.includes('measurement') ? '⌁' : '▦';
  };
  const source = deviceIconSource(device);
  if (!source) {
    fallback();
    return;
  }
  const image = document.createElement('img');
  image.src = source;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', fallback, { once: true });
  element.replaceChildren(image);
}

function restoreMeasurementCache(project, id) {
  const cached = project && id ? state.measurementCache[cacheKey(project, id)] : null;
  state.onlineValues = cached?.onlineValues || [];
  state.historicalValues = mergeHistoricalMeasurements(cached?.historicalValues || []).filter(historicalMeasurementAvailable);
  state.displayedMeasurements = cached?.displayedMeasurements || [];
  state.selectedMeasurements = cached?.selectedMeasurements || [];
  state.mqttAssignments = cached?.mqttAssignments && typeof cached.mqttAssignments === 'object'
    ? cached.mqttAssignments
    : Object.fromEntries(state.selectedMeasurements.map((measurement) => [measurementKey(measurement), [defaultMqttProfileId()]]));
  state.mqttActiveAssignments = cached?.mqttActiveAssignments && typeof cached.mqttActiveAssignments === 'object'
    ? cached.mqttActiveAssignments
    : Object.fromEntries(state.selectedMeasurements.map((measurement) => [measurementKey(measurement), measurementProfileIds(measurement)]));
  state.mqttRetainAssignments = cached?.mqttRetainAssignments && typeof cached.mqttRetainAssignments === 'object'
    ? cached.mqttRetainAssignments
    : {};
  state.historicalSelectedMeasurements = (cached?.historicalSelectedMeasurements || []).filter((measurement) =>
    state.historicalValues.some((item) => measurementKey(item) === measurementKey(measurement)));
  state.historicalMqttAssignments = cached?.historicalMqttAssignments && typeof cached.historicalMqttAssignments === 'object'
    ? cached.historicalMqttAssignments
    : Object.fromEntries(state.historicalSelectedMeasurements.map((measurement) => [measurementKey(measurement), [defaultMqttProfileId()]]));
  state.historicalMqttActiveAssignments = cached?.historicalMqttActiveAssignments && typeof cached.historicalMqttActiveAssignments === 'object'
    ? cached.historicalMqttActiveAssignments
    : Object.fromEntries(state.historicalSelectedMeasurements.map((measurement) => [measurementKey(measurement), measurementProfileIds(measurement)]));
  state.historicalRetainAssignments = cached?.historicalRetainAssignments && typeof cached.historicalRetainAssignments === 'object'
    ? cached.historicalRetainAssignments
    : {};
  state.historicalSettings = cached?.historicalSettings && typeof cached.historicalSettings === 'object' ? cached.historicalSettings : {};
  state.historicalDefaults = normalizeHistoricalDefaults(cached?.historicalDefaults, state.historicalGlobalSettings);
  const cacheKeyValue = project && id ? cacheKey(project, id) : '';
  if (cacheKeyValue && !cached?.historicalDefaults) {
    state.measurementCache[cacheKeyValue] = {
      ...cached,
      historicalDefaults: state.historicalDefaults
    };
  }
  state.historicalResults = cached?.historicalResults && typeof cached.historicalResults === 'object' ? cached.historicalResults : {};
  state.displaySettings = cached?.displaySettings && typeof cached.displaySettings === 'object' ? cached.displaySettings : {};
  state.liveResults = cached?.liveResults || [];
  updateMeasurementCounters();
  renderLiveValues();
  renderDisplayValues();
  renderHistoricalValues();
  renderHistoricalSelection();
  syncHistoricalDefaultControls();
  configureHistoricalRefresh();
}

async function loadBackendDeviceState(project, id, selectionToken = null, { activate = true } = {}) {
  if (!project || !id) return null;
  const key = cacheKey(project, id);
  if (activate) state.backendDeviceStateKey = '';
  try {
    const result = await api(`/api/state/device?project=${encodeURIComponent(project)}&deviceId=${encodeURIComponent(id)}`);
    if (selectionToken !== null && !isCurrentDeviceRequest(selectionToken, id)) return null;
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const cachedDevice = data.device && typeof data.device === 'object' ? data.device : null;
    if (cachedDevice) {
      const index = state.devices.findIndex((entry) => deviceId(entry) === String(id));
      if (index >= 0) state.devices[index] = { ...state.devices[index], ...cachedDevice, info: { ...(state.devices[index].info || {}), ...(cachedDevice.info || {}) } };
      else state.devices.push(cachedDevice);
      state.deviceCache[project] = state.devices;
      if (activate) state.currentDevice = state.devices.find((entry) => deviceId(entry) === String(id)) || cachedDevice;
    }
    state.measurementCache[key] = data.measurementCache && typeof data.measurementCache === 'object'
      ? data.measurementCache
      : {};
    if (activate && String(id) === String(deviceId(state.currentDevice || {}))) {
      state.historicalResults = {
        ...state.historicalResults,
        ...(state.measurementCache[key].historicalResults || {})
      };
      renderHistoricalValues();
    }
    if (Array.isArray(data.liveValues) && data.liveValues.length) {
      // MQTT-active live cards must start with the value that the backend
      // already published, not with an older browser-side result.
      state.measurementCache[key].liveResults = data.liveValues;
      if (activate) state.liveResults = data.liveValues;
    }
    if (activate) state.backendDeviceStateKey = key;
    return data;
  } catch (error) {
    if (activate && (selectionToken === null || isCurrentDeviceRequest(selectionToken, id))) state.backendDeviceStateKey = '';
    throw error;
  }
}

async function refreshBackendHistoricalResults(project, id) {
  if (!project || !id) return;
  const result = await api(`/api/state/device?project=${encodeURIComponent(project)}&deviceId=${encodeURIComponent(id)}`);
  const backendCache = result.data?.measurementCache;
  if (!backendCache || typeof backendCache !== 'object') return;
  const key = cacheKey(project, id);
  const localCache = state.measurementCache[key] || {};
  const historicalResults = { ...(localCache.historicalResults || {}) };
  for (const resultKey of result.data?.historicalCacheKeys || []) delete historicalResults[resultKey];
  const backendResults = backendCache.historicalResults && typeof backendCache.historicalResults === 'object'
    ? backendCache.historicalResults
    : {};
  Object.assign(historicalResults, backendResults);
  state.measurementCache[key] = {
    ...localCache,
    historicalResults
  };
  if (isLoadedDeviceState(project, id)) {
    for (const resultKey of result.data?.historicalCacheKeys || []) delete state.historicalResults[resultKey];
    Object.assign(state.historicalResults, backendResults);
  }
}

async function persistBackendDeviceState(project, id, cache) {
  const result = await api('/api/state/device', {
    method: 'PUT',
    body: JSON.stringify({
      project,
      deviceId: String(id),
      loaded: true,
      cache
    })
  });
  if (result.state?.mqttDeviceCounts && typeof result.state.mqttDeviceCounts === 'object') state.mqttDeviceCounts = result.state.mqttDeviceCounts;
  if (result.state?.mqttDeviceSummaries && typeof result.state.mqttDeviceSummaries === 'object') state.mqttDeviceSummaries = result.state.mqttDeviceSummaries;
  if (Number.isFinite(Number(result.state?.discoveryPreparedCount))) state.discoveryPreparedCount = Number(result.state.discoveryPreparedCount);
  updateSelectedCounters();
  renderDeviceList();
  return result;
}

function restoreProjectData(project) {
  state.devices = project && Array.isArray(state.deviceCache[project]) ? state.deviceCache[project] : [];
  const selectedId = state.selectedDeviceIds[project] || '';
  state.currentDevice = state.devices.find((device) => deviceId(device) === selectedId) || null;
  renderDeviceSelect(selectedId);
  updateDeviceCounters();
  renderDeviceList();
  restoreMeasurementCache(project, selectedId);
  configureLiveRefresh();
}

function restoreUiState(cached = {}) {
  // The backend is the sole owner of project/device/measurement caches. These
  // objects are intentionally reset here; the current device is loaded from
  // /api/state/device after the device list has been loaded.
  state.projects = [];
  state.deviceCache = {};
  state.mqttDeviceCounts = cached.mqttDeviceCounts && typeof cached.mqttDeviceCounts === 'object' ? cached.mqttDeviceCounts : {};
  state.mqttDeviceSummaries = cached.mqttDeviceSummaries && typeof cached.mqttDeviceSummaries === 'object' ? cached.mqttDeviceSummaries : {};
  state.discoveryPreparedCount = Number.isFinite(Number(cached.discoveryPreparedCount)) ? Number(cached.discoveryPreparedCount) : 0;
  state.backendDeviceStateKey = '';
  state.selectedDeviceIds = cached.selectedDeviceIds && typeof cached.selectedDeviceIds === 'object' ? cached.selectedDeviceIds : {};
  state.measurementCache = {};
  if (isDeviceSortMode(cached.deviceSort)) state.deviceSort = cached.deviceSort;
  if ([0, 1, 2, 5, 10, 30, 60, 300].includes(Number(cached.liveRefreshInterval))) state.liveRefreshInterval = Number(cached.liveRefreshInterval);
  state.historicalGlobalSettings = {
    refreshInterval: normalizeHistoryRefreshInterval(cached.historicalGlobalSettings?.refreshInterval),
    minuteOffset: normalizeHistoryMinuteOffset(cached.historicalGlobalSettings?.minuteOffset),
    comparisons: normalizeHistoryComparisons(
      cached.historicalGlobalSettings?.comparisons,
      cached.historicalGlobalSettings?.comparisonOffset
    ),
    ranges: normalizeHistoryRanges(cached.historicalGlobalSettings?.ranges)
  };
  state.historicalDefaults = normalizeHistoricalDefaults(null, state.historicalGlobalSettings);
  state.deviceRefreshIntervals = cached.deviceRefreshIntervals && typeof cached.deviceRefreshIntervals === 'object'
    ? cached.deviceRefreshIntervals
    : {};
  if ($('#device-sort')) $('#device-sort').value = state.deviceSort;
  if ($('#live-refresh-interval')) $('#live-refresh-interval').value = String(state.liveRefreshInterval);
  syncHistoricalDefaultControls();
  if ($('#device-search')) $('#device-search').value = cached.deviceSearch || '';

  const selectedProject = cached.selectedProject || '';
  fillSelect($('#project-select'), state.projects, 'Projekt auswählen', selectedProject, (project) => String(itemValue(project, 'name', 'id', 'path')), (project) => itemValue(project, 'name', 'label', 'id', 'path'));
  restoreProjectData($('#project-select')?.value || '');
}

function updateDeviceCounters() {
  const count = state.devices.length;
  setText('#stat-devices', count);
  setText('#stat-devices-detail', count ? `${count} im aktiven Projekt` : 'Noch nicht geladen');
  setText('#device-nav-count', count);
  setText('#tree-device-count', count);
  setText('#device-list-caption', `${count} ${count === 1 ? 'Gerät' : 'Geräte'} im Projekt`);
  setText('#tree-project-name', $('#project-select')?.selectedOptions[0]?.textContent || 'Kein Projekt');
}

function selectedMeasurementCount(measurements = []) {
  return new Set((Array.isArray(measurements) ? measurements : [])
    .map((measurement) => measurementKey(measurement))
    .filter(Boolean))
    .size;
}

function mqttDeviceSummaryFromCache(cache = {}) {
  const liveActiveCount = Object.values(cache.mqttActiveAssignments || {})
    .filter((ids) => Array.isArray(ids) && ids.length)
    .length;
  const historicalActiveCount = Object.values(cache.historicalMqttActiveAssignments || {})
    .filter((ids) => Array.isArray(ids) && ids.length)
    .length;
  return {
    liveActiveCount,
    historicalActiveCount,
    mqttActiveCount: liveActiveCount + historicalActiveCount,
    liveSelectedCount: selectedMeasurementCount(cache.displayedMeasurements),
    historicalSelectedCount: selectedMeasurementCount(cache.historicalSelectedMeasurements)
  };
}

function mqttDeviceSummary(project, id) {
  const key = cacheKey(project, id);
  if (state.backendDeviceStateKey === key) {
    return mqttDeviceSummaryFromCache({
      mqttActiveAssignments: state.mqttActiveAssignments,
      historicalMqttActiveAssignments: state.historicalMqttActiveAssignments,
      displayedMeasurements: state.displayedMeasurements,
      historicalSelectedMeasurements: state.historicalSelectedMeasurements
    });
  }
  const summary = state.mqttDeviceSummaries[key];
  if (summary && typeof summary === 'object') return summary;
  const cache = state.measurementCache[key];
  return cache ? mqttDeviceSummaryFromCache(cache) : {};
}

function mqttDeviceCount(project, id) {
  const summary = mqttDeviceSummary(project, id);
  return Number(summary.mqttActiveCount || state.mqttDeviceCounts[cacheKey(project, id)] || 0);
}

function updateSelectedCounters() {
  const localCount = new Set(Object.keys(state.mqttAssignments)).size
    + new Set(Object.keys(state.historicalMqttAssignments)).size;
  const hasGlobalSummary = Object.keys(state.mqttDeviceSummaries || {}).length > 0;
  const count = hasGlobalSummary ? Number(state.discoveryPreparedCount || 0) : localCount;
  setText('#selected-count', count);
  setText('#info-selected-count', count);
  setText('#live-selection-status', `${count} ausgewählt`);
  setText('#stat-discovery-detail', count ? 'Topics vorbereitet' : 'Keine Topics vorbereitet');
}

function renderDeviceList() {
  const list = $('#device-list');
  if (!list) return;
  const query = ($('#device-search')?.value || '').trim().toLowerCase();
  const devices = orderedDevices(state.devices).filter(({ device, parent }) => `${deviceName(device)} ${deviceId(device)} ${deviceType(device)} ${parent ? deviceName(parent) : ''}`.toLowerCase().includes(query));
  if (!devices.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">▦</span><strong>${state.devices.length ? 'Kein passendes Gerät' : 'Noch keine Geräte geladen'}</strong><p>${state.devices.length ? 'Ändere den Suchbegriff und versuche es erneut.' : 'Verbinde GridVis und wähle ein Projekt aus, um die Geräteübersicht zu laden.'}</p>${state.devices.length ? '' : '<button class="button button-primary" id="empty-settings" type="button">Verbindung einrichten</button>'}</div>`;
    $('#empty-settings')?.addEventListener('click', () => setView('settings'));
    return;
  }
  list.replaceChildren(...devices.map(({ device, depth, parent }) => {
    const id = deviceId(device);
    const fullName = deviceName(device);
    const name = depth > 0 ? deviceLeafName(device) : fullName;
    const online = deviceOnline(device);
    const project = $('#project-select')?.value || '';
    const summary = mqttDeviceSummary(project, id);
    const mqttCount = mqttDeviceCount(project, id);
    const mqttInfoClass = mqttCount > 0 ? ' mqtt-active' : '';
    const historySelectedCount = Number(summary.historicalSelectedCount || 0);
    const liveSelectedCount = Number(summary.liveSelectedCount || 0);
    const liveActiveCount = Number(summary.liveActiveCount || 0);
    const historicalActiveCount = Number(summary.historicalActiveCount || 0);
    const signalParts = [];
    if (liveActiveCount > 0) signalParts.push({ label: `MQTT Live ${liveActiveCount}`, className: 'mqtt' });
    if (historicalActiveCount > 0) signalParts.push({ label: `MQTT Historie ${historicalActiveCount}`, className: 'mqtt-history' });
    if (historySelectedCount > historicalActiveCount) signalParts.push({ label: `Historie ${historySelectedCount} gewählt`, className: 'history' });
    if (!mqttCount && liveSelectedCount > 0) signalParts.push({ label: `Live ${liveSelectedCount} gewählt`, className: 'live' });
    const mqttInfoLabel = signalParts.length
      ? `Schnellübersicht für ${fullName} – ${signalParts.map((part) => part.label).join(', ')}`
      : `Schnellübersicht für ${fullName}`;
    const signalMarkup = signalParts.length
      ? `<div class="device-card-signals">${signalParts.map((part) => `<span class="device-card-signal ${part.className}">${escapeHtml(part.label)}</span>`).join('')}</div>`
      : '';
    const serial = deviceDetailValue(device, 'serialNr', 'serialNumber', 'serial', 'serialNo', 'id') || 'Keine Seriennummer';
    const description = itemValue(device, 'description', 'comment', 'location') || 'Keine Beschreibung hinterlegt';
    const card = document.createElement('article');
    card.className = 'device-card' + (depth > 0 ? ' is-child' : '');
    const avatar = document.createElement('div');
    avatar.className = 'device-avatar';
    setDeviceAvatar(avatar, device);
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${fullName} öffnen`);
    card.innerHTML = `<div class="device-card-main"><div class="device-card-copy"><div class="device-card-top"><h3 title="${escapeHtml(fullName)}"><button class="device-name-link" type="button">${escapeHtml(name)}</button></h3><div class="device-card-actions"><span class="state-badge ${online ? '' : 'offline'}"><span class="state-badge-dot"></span>${online ? 'Online' : 'Offline'}</span><button class="device-info-button${mqttInfoClass}" type="button" aria-label="${escapeHtml(mqttInfoLabel)}" title="${escapeHtml(mqttInfoLabel)}">i</button></div></div><p class="device-card-type" title="${escapeHtml(deviceType(device))}">${escapeHtml(deviceType(device))}</p><p class="device-card-description" title="${escapeHtml(description)}">${escapeHtml(description)}</p>${signalMarkup}${parent ? `<small class="device-parent-path">↳ unter ${escapeHtml(deviceName(parent))}</small>` : ''}</div></div><div class="device-card-footer"><div class="device-card-tags"><span class="device-tag">ID ${escapeHtml(id)}</span><span class="device-tag">${escapeHtml(serial)}</span></div></div>`;
    card.querySelector('.device-card-main').prepend(avatar);
    const open = () => openDevice(device).catch(showError);
    card.querySelector('.device-name-link').addEventListener('click', open);
    card.querySelector('.device-info-button').addEventListener('click', (event) => {
      event.stopPropagation();
      openDeviceInfo(device).catch(showError);
    });
    card.addEventListener('click', (event) => { if (!event.target.closest('button')) open(); });
    card.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
        event.preventDefault();
        open();
      }
    });
    return card;
  }));
}

async function openDeviceInfo(device) {
  const dialog = $('#device-info-dialog');
  if (!dialog) return;
  state.infoDevice = device;
  setDeviceAvatar($('#device-info-avatar'), device);
  setText('#device-info-name', deviceLeafName(device));
  setText('#device-info-subtitle', deviceType(device));
  setText('#device-info-status', deviceOnline(device) ? 'online' : 'offline');
  $('#device-info-status')?.classList.toggle('offline', !deviceOnline(device));
  setText('#device-info-id', `ID ${deviceId(device)}`);
  setText('#device-info-serial', deviceDetailValue(device, 'serialNr', 'serialNumber', 'serial', 'serialNo', 'id') || '–');
  renderDeviceInfoValues(device);
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  const project = $('#project-select')?.value || '';
  const infoDeviceId = deviceId(device);
  configureLiveRefresh();
  loadBackendDeviceState(project, infoDeviceId, null, { activate: false }).then((data) => {
    if (!dialog.open || !state.infoDevice || deviceId(state.infoDevice) !== infoDeviceId) return;
    const cachedDevice = data?.device && typeof data.device === 'object' ? data.device : null;
    if (cachedDevice) state.infoDevice = cachedDevice;
    renderDeviceInfoValues(state.infoDevice);
    renderDeviceList();
    configureLiveRefresh();
    const target = liveTargetForDevice(project, infoDeviceId, { includeDisplay: true });
    if (target) loadLiveData({ silent: true, targets: [target] }).catch(reportBackgroundError);
  }).catch(reportBackgroundError);
  loadDeviceDetails(device, { refresh: true }).then((updated) => {
    if (dialog.open && state.infoDevice && deviceId(state.infoDevice) === deviceId(updated)) {
      state.infoDevice = updated;
      setDeviceAvatar($('#device-info-avatar'), updated);
      setText('#device-info-name', deviceLeafName(updated));
      setText('#device-info-subtitle', deviceType(updated));
      setText('#device-info-serial', deviceDetailValue(updated, 'serialNr', 'serialNumber', 'serial', 'serialNo', 'id') || '–');
      renderDeviceInfoValues(updated);
    }
  }).catch(reportBackgroundError);
}

async function openQuickInfoMeasurementSettings(device, measurement) {
  openMeasurementSettings(measurement, device);
}

function createMeasurementCard(measurement, { result, deviceIdValue, mqttActive, historical = false, onRemove, onSettings, onMqttChange, onHistoryDetails, valueMarkup = liveValueMarkup }) {
  const card = document.createElement('article');
  card.className = `measurement-card${historical ? ' historical-measurement-card' : ''}`;
  card.dataset.measurementKey = measurementKey(measurement);
  card.innerHTML = `<div class="measurement-card-top"><div><h3>${escapeHtml(measurementDisplayName(measurement))}</h3><small class="measurement-card-meta">${escapeHtml(measurement.value)} · ${escapeHtml(measurement.typeLabel || measurement.type)}</small></div><button class="measurement-card-remove" type="button" data-measurement-remove aria-label="${escapeHtml(measurementDisplayName(measurement))} abwählen" title="Messwert abwählen">×</button></div><div class="measurement-card-value">${valueMarkup(measurement, result, deviceIdValue)}</div><div class="measurement-card-controls"><button class="button button-quiet" type="button" data-measurement-settings>Einstellungen</button><label><input type="checkbox" data-measurement-mqtt${mqttActive ? ' checked' : ''}> MQTT aktiv</label></div>`;
  if (historical && onHistoryDetails) {
    const detailsButton = document.createElement('button');
    detailsButton.className = 'measurement-history-info-button';
    detailsButton.type = 'button';
    detailsButton.dataset.measurementHistoryInfo = 'true';
    detailsButton.textContent = 'i';
    detailsButton.setAttribute('aria-label', `Historische Zeitbereiche für ${measurementDisplayName(measurement)} anzeigen`);
    detailsButton.title = 'Alle historischen Zeitbereiche anzeigen';
    detailsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      onHistoryDetails(event);
    });
    card.querySelector('.measurement-card-top')?.append(detailsButton);
  }
  card.querySelector('[data-measurement-remove]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    onRemove?.(event);
  });
  card.querySelector('[data-measurement-settings]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    onSettings?.(event);
  });
  card.querySelector('[data-measurement-mqtt]')?.addEventListener('change', (event) => {
    event.stopPropagation();
    onMqttChange?.(event.target.checked, event);
  });
  return card;
}

function renderDeviceInfoValues(device) {
  const target = $('#device-info-values');
  const empty = $('#device-info-empty');
  if (!target || !empty || !device) return;
  const project = $('#project-select')?.value || '';
  const id = deviceId(device);
  const cache = state.measurementCache[cacheKey(project, id)] || {};
  const isCurrent = isLoadedDeviceState(project, id);
  const liveMeasurements = uniqueMeasurements(isCurrent ? state.displayedMeasurements : cache.displayedMeasurements || []);
  const historicalMeasurements = uniqueMeasurementList(isCurrent ? state.historicalSelectedMeasurements : cache.historicalSelectedMeasurements || []);
  const results = liveResultList(isCurrent ? state.liveResults : cache.liveResults || []);
  const historyResultStore = isCurrent ? state.historicalResults : cache.historicalResults || {};
  const createLiveCard = (measurement) => {
    const result = results.find((entry) => liveResultMatches(entry, measurement, id));
    const mqttActive = isCurrent
      ? measurementMqttActive(measurement)
      : Array.isArray(cache.mqttActiveAssignments?.[measurementKey(measurement)])
        && cache.mqttActiveAssignments[measurementKey(measurement)].length > 0;
    const card = createMeasurementCard(measurement, {
      result,
      deviceIdValue: id,
      mqttActive,
      onRemove: () => removeQuickInfoMeasurement(device, measurement).catch(showError),
      onSettings: () => openQuickInfoMeasurementSettings(device, measurement).catch(showError),
      onMqttChange: (enabled, event) => setQuickInfoMqttActive(device, measurement, enabled).catch((error) => {
        event.target.checked = !event.target.checked;
        showError(error);
      })
    });
    return card;
  };
  const createHistoricalCard = (measurement) => createMeasurementCard(measurement, {
    deviceIdValue: id,
    historical: true,
    mqttActive: isCurrent
      ? measurementMqttActive(measurement)
      : Array.isArray(cache.historicalMqttActiveAssignments?.[measurementKey(measurement)])
        && cache.historicalMqttActiveAssignments[measurementKey(measurement)].length > 0,
    valueMarkup: (item, result, itemDeviceId) => historicalValueMarkup(item, result, itemDeviceId, historyResultStore),
    onHistoryDetails: () => openHistoryDetails(measurement, id, historyResultStore),
    onRemove: () => removeQuickInfoMeasurement(device, measurement).catch(showError),
    onSettings: () => openQuickInfoMeasurementSettings(device, measurement).catch(showError),
    onMqttChange: (enabled, event) => setQuickInfoMqttActive(device, measurement, enabled).catch((error) => {
      event.target.checked = !event.target.checked;
      showError(error);
    })
  });
  const groups = [];
  if (liveMeasurements.length) {
    const group = document.createElement('section');
    group.className = 'device-info-value-group';
    group.innerHTML = '<h3>Live-Werte</h3>';
    group.append(...liveMeasurements.map(createLiveCard));
    groups.push(group);
  }
  if (historicalMeasurements.length) {
    const group = document.createElement('section');
    group.className = 'device-info-value-group historical';
    group.innerHTML = '<h3>Historische Werte</h3>';
    group.append(...historicalMeasurements.map(createHistoricalCard));
    groups.push(group);
  }
  target.replaceChildren(...groups);
  empty.hidden = groups.length > 0;
}

function renderDeviceInfo(device) {
  if (!device) return;
  const name = deviceName(device);
  const id = deviceId(device);
  const serial = deviceDetailValue(device, 'serialNr', 'serialNumber', 'serial', 'serialNo') || '–';
  const description = itemValue(device, 'description', 'comment', 'location') || '–';
  const firmware = deviceDetailValue(device, 'firmware', 'firmwareVersion', 'swVersion') || '–';
  const hardware = deviceDetailValue(device, 'hardware', 'hardwareVersion', 'hwVersion') || '–';
  const status = deviceDetailValue(device, 'status', 'state', 'online', 'connected') || '–';
  const statusMessage = deviceDetailValue(device, 'statusMsg', 'statusMessage', 'message') || '–';
  setText('#device-detail-name', name);
  setText('#device-detail-subtitle', `${deviceType(device)} · ${description}`);
  setText('#detail-path-name', name);
  setText('#device-detail-id', `ID ${id}`);
  setText('#device-detail-model', deviceType(device));
  setText('#device-detail-status', deviceOnline(device) ? 'online' : 'offline');
  $('#device-detail-status')?.classList.toggle('offline', !deviceOnline(device));
  setDeviceAvatar($('#view-device-detail .device-avatar.large'), device);
  setText('#info-name', name);
  setText('#info-id', id);
  setText('#info-serial', serial);
  setText('#info-type', deviceType(device));
  setText('#info-description', description);
  setText('#info-firmware', firmware);
  setText('#info-hardware', hardware);
  setText('#info-status', status);
  setText('#info-status-message', statusMessage);
}

function setDeviceInfoLoading(loading) {
  for (const selector of ['#info-firmware', '#info-hardware', '#info-status', '#info-status-message']) {
    const element = $(selector);
    if (!element) continue;
    const marker = element.querySelector('[data-device-info-loading]');
    if (loading) {
      element.classList.add('is-loading');
      if (!marker) {
        const note = document.createElement('small');
        note.dataset.deviceInfoLoading = 'true';
        note.className = 'device-info-loading-note';
        note.textContent = '(wird abgerufen)';
        element.append(' ', note);
      }
    } else {
      marker?.remove();
      element.classList.remove('is-loading');
    }
  }
}

function normalizeMeasurement(item, mode = '') {
  const value = itemValue(item, 'value', 'valueType.value', 'value_type.value', 'id', 'name') || 'value';
  const type = itemValue(item, 'type', 'valueType.type', 'value_type.type', 'valueType.typeName', 'value_type.typeName') || 'Overall';
  const typeLabel = itemValue(item, 'typeName', 'valueType.typeName', 'value_type.typeName') || type;
  return {
    raw: item,
    id: String(itemValue(item, 'id') || `${value}-${type}`),
    value: String(value),
    type: String(type),
    typeLabel: String(typeLabel),
    name: String(itemValue(item, 'name', 'label', 'displayName', 'measurementName', 'valueName', 'valueType.valueName', 'value_type.valueName', 'value') || value),
    unit: itemValue(item, 'unit', 'unitOfMeasurement', 'valueType.unit', 'value_type.unit'),
    online: mode === 'live' || Boolean(item?.online),
    historical: mode === 'historical',
    lastValue: itemValue(item, 'lastValue', 'currentValue', 'reading')
  };
}

function mergeHistoricalMeasurements(measurements) {
  const merged = new Map();
  for (const measurement of measurements || []) {
    const key = measurementKey(measurement);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...measurement, historical: true });
      continue;
    }
  }
  return [...merged.values()];
}

function historicalMeasurementAvailable(measurement) {
  return measurement?.value !== 'UserDefined';
}

function normalizeHistoryRefreshInterval(value) {
  const interval = Number(value);
  return HISTORY_CYCLE_OPTIONS.some(([seconds]) => seconds === interval) ? interval : 900;
}

function normalizeHistoryMinuteOffset(value) {
  const offset = Number(value);
  return Number.isInteger(offset) && offset >= 0 && offset <= 59 ? offset : 0;
}

function normalizeHistoryRanges(ranges) {
  const allowed = new Set(HISTORY_RANGE_OPTIONS.map(([value]) => value));
  const normalized = [...new Set((Array.isArray(ranges) ? ranges : []).filter((value) => allowed.has(value)))];
  return normalized.length ? normalized : ['today'];
}

function normalizeHistoryComparisons(comparisons, legacyOffset = 0) {
  const source = Array.isArray(comparisons)
    ? comparisons
    : Number(legacyOffset) === 1
      ? [{ unit: 'same', amount: 1 }]
      : [];
  const validUnits = new Set(HISTORY_COMPARISON_UNITS.map(([unit]) => unit));
  const validRanges = new Set(HISTORY_RANGE_OPTIONS.map(([range]) => range));
  const seen = new Set();
  const normalized = [];
  for (const item of source) {
    const unit = validUnits.has(item?.unit) ? item.unit : '';
    if (!unit) continue;
    const range = item?.range === 'all' || validRanges.has(item?.range) ? item.range || 'all' : 'all';
    const amount = unit === 'same' ? 1 : Math.min(9999, Math.max(1, Math.trunc(Number(item?.amount) || 1)));
    const key = `${range}:${unit}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ range, unit, amount });
  }
  return normalized;
}

function normalizeHistoricalDefaults(value = {}, fallback = state.historicalGlobalSettings) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    refreshInterval: normalizeHistoryRefreshInterval(source.refreshInterval ?? base.refreshInterval),
    minuteOffset: normalizeHistoryMinuteOffset(source.minuteOffset ?? base.minuteOffset),
    comparisons: normalizeHistoryComparisons(
      source.comparisons ?? base.comparisons,
      source.comparisonOffset ?? base.comparisonOffset
    ),
    ranges: normalizeHistoryRanges(source.ranges ?? base.ranges)
  };
}

function historicalDefaultsForTarget(target = null) {
  const project = target?.project || $('#project-select')?.value || '';
  const targetId = target?.deviceId === undefined || target?.deviceId === null
    ? deviceId(state.currentDevice || {})
    : String(target.deviceId);
  if (project && targetId && isLoadedDeviceState(project, targetId)) {
    return normalizeHistoricalDefaults(state.historicalDefaults, state.historicalGlobalSettings);
  }
  const cached = project && targetId
    ? state.measurementCache[cacheKey(project, targetId)] || {}
    : {};
  return normalizeHistoricalDefaults(cached.historicalDefaults, state.historicalGlobalSettings);
}

function currentHistoricalDefaults() {
  return normalizeHistoricalDefaults(state.historicalDefaults, state.historicalGlobalSettings);
}

function comparisonRangeId(range, comparison) {
  return comparison.unit === 'same'
    ? `comparison_${range}`
    : `comparison_${range}_${comparison.unit}_${comparison.amount}`;
}

function historyComparisonDefinition(range, comparison) {
  const named = {
    today: ['NAMED_Today', 'NAMED_Today'],
    yesterday: ['NAMED_Yesterday', 'NAMED_Yesterday'],
    thisweek: ['NAMED_ThisWeek', 'NAMED_Today'],
    lastweek: ['NAMED_LastWeek', 'NAMED_LastWeek'],
    thismonth: ['NAMED_ThisMonth', 'NAMED_Today'],
    lastmonth: ['NAMED_LastMonth', 'NAMED_LastMonth'],
    thisyear: ['NAMED_ThisYear', 'NAMED_Today'],
    lastyear: ['NAMED_LastYear', 'NAMED_LastYear'],
    last24hours: ['RELATIVE_-24HOUR', 'NAMED_Today'],
    last3months: ['RELATIVE_-3MONTH', 'NAMED_Today']
  };
  const base = named[range];
  if (!base) return null;
  const normalized = normalizeHistoryComparisons([comparison])[0];
  if (!normalized) return null;
  const [offsetType, offsetAmount] = normalized.unit === 'same'
    ? (HISTORY_COMPARISON_SAME_OFFSETS[range] || [])
    : [
      HISTORY_COMPARISON_UNIT_TYPES[normalized.unit],
      normalized.unit === 'quarters' ? normalized.amount * 3 : normalized.amount
    ];
  if (!offsetType || !offsetAmount) return null;
  const anchor = `RELATIVE_-${offsetAmount}${offsetType}`;
  const expressions = HISTORY_ROLLING_RANGES.has(range)
    ? [range === 'last24hours' ? 'RELATIVE_-24HOUR' : 'RELATIVE_-3MONTH', 'RELATIVE_+0SECOND']
    : [base[0], HISTORY_RUNNING_RANGES.has(range) ? 'RELATIVE_+0SECOND' : base[1]];
  return {
    id: comparisonRangeId(range, normalized),
    expressions,
    anchor,
    comparison: normalized
  };
}

function historyComparisonDefinitions(comparisons = currentHistoricalDefaults().comparisons) {
  return HISTORY_RANGE_OPTIONS.flatMap(([range]) => normalizeHistoryComparisons(comparisons)
    .filter((comparison) => comparison.range === 'all' || comparison.range === range)
    .map((comparison) => historyComparisonDefinition(range, comparison))
    .filter(Boolean));
}

function historyComparisonForRange(range, comparisons = currentHistoricalDefaults().comparisons) {
  return historyComparisonDefinitions(comparisons).find((definition) => definition.id === range);
}

function historicalRangesWithComparison(ranges, comparisons = []) {
  const baseRanges = normalizeHistoryRanges(ranges);
  const normalizedComparisons = normalizeHistoryComparisons(comparisons);
  if (!normalizedComparisons.length) return baseRanges;
  return [...new Set([
    ...baseRanges,
    ...baseRanges.flatMap((range) => normalizedComparisons
      .filter((comparison) => comparison.range === 'all' || comparison.range === range)
      .map((comparison) => historyComparisonDefinition(range, comparison)?.id)
      .filter(Boolean))
  ])];
}

function renderHistoryComparisons(container = $('#history-comparisons'), selectedComparisons = currentHistoricalDefaults().comparisons) {
  if (!container) return;
  const comparisons = normalizeHistoryComparisons(selectedComparisons);
  if (container.id === 'history-comparisons') state.historicalDefaults.comparisons = comparisons;
  if (!comparisons.length) {
    const empty = document.createElement('p');
    empty.className = 'history-comparisons-empty';
    empty.textContent = 'Keine Vergleichszeiträume ausgewählt.';
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(...comparisons.map((comparison, index) => {
    const row = document.createElement('div');
    row.className = 'history-comparison-row';
    row.dataset.index = String(index);

    const scope = document.createElement('select');
    scope.dataset.comparisonRange = 'true';
    scope.setAttribute('aria-label', 'Gültig für Zeitbereich');
    for (const [value, label] of HISTORY_COMPARISON_SCOPE_OPTIONS) {
      const option = new Option(label, value);
      option.selected = comparison.range === value;
      scope.append(option);
    }

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.max = '9999';
    amount.step = '1';
    amount.value = String(comparison.amount);
    amount.disabled = comparison.unit === 'same';
    amount.title = 'Anzahl der Zeiträume';
    amount.setAttribute('aria-label', 'Anzahl des Vergleichs');

    const unit = document.createElement('select');
    unit.dataset.comparisonUnit = 'true';
    unit.setAttribute('aria-label', 'Einheit des Vergleichs');
    for (const [value, label] of HISTORY_COMPARISON_UNITS) {
      const option = new Option(label, value);
      option.selected = comparison.unit === value;
      unit.append(option);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-quiet history-comparison-remove';
    remove.dataset.removeComparison = String(index);
    remove.textContent = '×';
    remove.title = 'Vergleichszeitraum entfernen';
    remove.setAttribute('aria-label', 'Vergleichszeitraum entfernen');

    row.append(scope, amount, unit, remove);
    return row;
  }));
}

function selectedHistoryComparisons(container) {
  if (!container) return [];
  return normalizeHistoryComparisons([...container.querySelectorAll('.history-comparison-row')].map((row) => ({
    range: row.querySelector('[data-comparison-range]')?.value || 'all',
    unit: row.querySelector('[data-comparison-unit]')?.value,
    amount: row.querySelector('input')?.value
  })));
}

function refreshAfterHistoryComparisonChange() {
  renderHistoryComparisons();
  renderHistoricalValues();
  configureHistoricalRefresh();
  writeUiCache();
  loadHistoricalData({ silent: true, publishMqtt: false }).catch(reportBackgroundError);
}

function nextHistoryComparison(comparisons) {
  const candidates = [
    { range: 'all', unit: 'same', amount: 1 },
    { range: 'all', unit: 'hours', amount: 1 },
    { range: 'all', unit: 'days', amount: 1 },
    { range: 'all', unit: 'weeks', amount: 1 },
    { range: 'all', unit: 'months', amount: 1 },
    { range: 'all', unit: 'quarters', amount: 1 },
    { range: 'all', unit: 'years', amount: 1 }
  ];
  const existing = new Set(comparisons.map((comparison) => `${comparison.range}:${comparison.unit}:${comparison.amount}`));
  let next = candidates.find((candidate) => !existing.has(`${candidate.range}:${candidate.unit}:${candidate.amount}`));
  if (!next) {
    const nextDays = Math.max(1, ...comparisons.filter((comparison) => comparison.unit === 'days').map((comparison) => comparison.amount)) + 1;
    next = { range: 'all', unit: 'days', amount: nextDays };
  }
  return next;
}

function addHistoryComparison() {
  const comparisons = normalizeHistoryComparisons(currentHistoricalDefaults().comparisons);
  state.historicalDefaults.comparisons = [...comparisons, nextHistoryComparison(comparisons)];
  refreshAfterHistoryComparisonChange();
}

function syncHistoricalDefaultControls() {
  const defaults = currentHistoricalDefaults();
  if ($('#history-refresh-interval')) $('#history-refresh-interval').value = String(defaults.refreshInterval);
  if ($('#history-refresh-offset')) $('#history-refresh-offset').value = String(defaults.minuteOffset);
  renderHistoryComparisons($('#history-comparisons'), defaults.comparisons);
  renderHistoryRangeOptions($('#history-default-ranges'), defaults.ranges, 'history-default-range');
}

function renderHistoryRangeOptions(container, selectedRanges = ['today'], namePrefix = 'history-range') {
  if (!container) return;
  const selected = new Set(normalizeHistoryRanges(selectedRanges));
  container.replaceChildren(...HISTORY_RANGE_OPTIONS.map(([value, label]) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'history-range-option';
    wrapper.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}"${selected.has(value) ? ' checked' : ''}><span>${escapeHtml(label)}</span>`;
    return wrapper;
  }));
  container.dataset.namePrefix = namePrefix;
}

function selectedHistoryRanges(container) {
  return normalizeHistoryRanges([...container?.querySelectorAll('input:checked') || []].map((input) => input.value));
}

function updateMeasurementHistoryRangeMode() {
  const mode = $('#measurement-settings-history-range-mode')?.value || 'standard';
  const fieldset = $('#measurement-settings-history-range-fieldset');
  if (fieldset) fieldset.hidden = mode !== 'custom';
  updateMeasurementSettingsRestRequest();
}

function updateMeasurementHistoryComparisonMode() {
  const mode = $('#measurement-settings-history-comparison-mode')?.value || 'standard';
  const fieldset = $('#measurement-settings-history-comparison-fieldset');
  if (fieldset) fieldset.hidden = mode !== 'custom';
  updateMeasurementSettingsRestRequest();
  updateMeasurementSettingsDiscovery();
}

function refreshMeasurementHistoryComparisonsEditor() {
  const container = $('#measurement-settings-history-comparisons');
  if (!container) return;
  renderHistoryComparisons(container, selectedHistoryComparisons(container));
  updateMeasurementSettingsTopic();
  updateMeasurementSettingsRestRequest();
  updateMeasurementSettingsDiscovery();
}

function historyRangeExpressions(range, comparisons = currentHistoricalDefaults().comparisons) {
  const end = 'NAMED_Today';
  const named = {
    today: ['NAMED_Today', end],
    yesterday: ['NAMED_Yesterday', 'NAMED_Yesterday'],
    thisweek: ['NAMED_ThisWeek', end],
    lastweek: ['NAMED_LastWeek', 'NAMED_LastWeek'],
    thismonth: ['NAMED_ThisMonth', end],
    lastmonth: ['NAMED_LastMonth', 'NAMED_LastMonth'],
    thisyear: ['NAMED_ThisYear', end],
    lastyear: ['NAMED_LastYear', 'NAMED_LastYear'],
    last24hours: ['RELATIVE_-24HOUR', end],
    last3months: ['RELATIVE_-3MONTH', end]
  };
  return named[range] || historyComparisonForRange(range, comparisons)?.expressions || named.today;
}

function historyRangeAnchor(range, comparisons = currentHistoricalDefaults().comparisons) {
  return historyComparisonForRange(range, comparisons)?.anchor || '';
}

function measurementLabel(measurement) {
  const channel = measurement.typeLabel || measurement.type;
  return [measurement.name, measurement.value, channel].filter(Boolean).join(' · ');
}

function measurementKey(measurement) {
  return `${measurement.value}:${measurement.type}`;
}

function liveTargetDevice(project, id) {
  const devices = state.deviceCache[project]?.length ? state.deviceCache[project] : state.devices;
  return devices.find((device) => deviceId(device) === String(id)) || { id: String(id), name: String(id) };
}

function uniqueMeasurements(measurements) {
  const byKey = new Map();
  for (const measurement of measurements || []) {
    if (!measurement?.online) continue;
    byKey.set(measurementKey(measurement), measurement);
  }
  return [...byKey.values()];
}

function uniqueMeasurementList(measurements) {
  const byKey = new Map();
  for (const measurement of measurements || []) {
    if (!measurement || measurement.value === undefined || measurement.type === undefined) continue;
    byKey.set(measurementKey(measurement), measurement);
  }
  return [...byKey.values()];
}

function isRefreshInterval(value) {
  return [1, 2, 5, 10, 30, 60, 300].includes(Number(value));
}

function deviceRefreshInterval(project, id) {
  const override = Number(state.deviceRefreshIntervals[cacheKey(project, id)] || 0);
  return isRefreshInterval(override) ? override : state.liveRefreshInterval;
}

function liveTargetForDevice(project, id, { includeDisplay = false, includeAvailable = false } = {}) {
  const current = isLoadedDeviceState(project, id);
  const cache = state.measurementCache[cacheKey(project, id)] || {};
  const available = current ? state.onlineValues : cache.onlineValues || [];
  const displayed = current ? state.displayedMeasurements : cache.displayedMeasurements || [];
  const mqttSelected = current ? state.selectedMeasurements : cache.selectedMeasurements || [];
  const assignments = current ? state.mqttAssignments : cache.mqttAssignments || {};
  const activeAssignments = current ? state.mqttActiveAssignments : cache.mqttActiveAssignments || {};
  const retainAssignments = current ? state.mqttRetainAssignments : cache.mqttRetainAssignments || {};
  const measurements = uniqueMeasurements([
    ...(includeAvailable ? available : []),
    ...(includeDisplay ? displayed : []),
    ...mqttSelected
  ]).map((measurement) => {
    const profileIds = assignments[measurementKey(measurement)];
    const activeProfileIds = activeAssignments[measurementKey(measurement)] || [];
    return {
      ...measurement,
      ...(Array.isArray(profileIds) ? { mqttProfileIds: profileIds } : {}),
      ...(Array.isArray(activeProfileIds) ? { mqttActiveProfileIds: activeProfileIds } : {}),
      retainState: retainAssignments[measurementKey(measurement)] === true
    };
  });
  if (!measurements.length) return null;
  return {
    project,
    deviceId: String(id),
    device: liveTargetDevice(project, id),
    refreshInterval: deviceRefreshInterval(project, id),
    measurements
  };
}

function liveTargetsForProject({ includeDisplay = isLiveFocusActive(), displayDeviceId = '' } = {}) {
  const project = $('#project-select')?.value || '';
  if (!project) return [];
  const currentId = state.currentDevice
    ? deviceId(state.currentDevice)
    : $('#device-select')?.value || '';
  const deviceIds = new Set((state.deviceCache[project] || state.devices).map(deviceId));
  if (currentId) deviceIds.add(String(currentId));

  return [...deviceIds]
    .map((id) => liveTargetForDevice(project, id, {
      includeDisplay: includeDisplay || String(id) === String(displayDeviceId)
    }))
    .filter(Boolean);
}

function liveTargetsForFocus({ includeDisplay = null, includeAvailable = false } = {}) {
  const project = $('#project-select')?.value || '';
  if (!project) return [];
  const dialogOpen = Boolean($('#device-info-dialog')?.open && state.infoDevice);
  const focusedId = dialogOpen
    ? deviceId(state.infoDevice)
    : state.currentView === 'device-detail'
      ? deviceId(state.currentDevice || {})
      : '';
  if (!focusedId) return [];
  const target = liveTargetForDevice(project, focusedId, {
    includeDisplay: includeDisplay === null ? (dialogOpen || isLiveFocusActive()) : includeDisplay,
    includeAvailable: includeAvailable || isLiveFocusActive()
  });
  return target ? [target] : [];
}

function liveResultValueName(result) {
  const value = itemValue(result, 'valueType.value', 'value_type.value', 'valueName', 'measurement.value');
  return typeof value === 'string' ? value : '';
}

function liveResultType(result) {
  const explicit = itemValue(result, 'valueType.type', 'value_type.type', 'type', 'valueType.typeName', 'value_type.typeName', 'valueType.name', 'value_type.name', 'channel', 'phase');
  if (explicit) return Array.isArray(explicit) ? String(explicit[0]) : String(explicit);
  const rawType = itemValue(result, 'valueType', 'value_type');
  const source = typeof rawType === 'string' ? rawType : JSON.stringify(result || {});
  const match = String(source).match(/\b(L\d(?:[-_]L\d|L\d)?|SUM\d+|Overall|Main|Aux|Neutralleiter)\b/i);
  return match ? match[1] : '';
}

function liveResultDeviceId(result) {
  return String(itemValue(result, 'deviceId', 'device.id', 'device.deviceId') || '');
}

function liveMeasurementKey(measurement, deviceIdValue = '') {
  return `${String(deviceIdValue || itemValue(measurement, 'deviceId', 'raw.deviceId') || '')}:${measurementKey(measurement)}`;
}

function liveResultKey(result, fallbackDeviceId = '') {
  return `${liveResultDeviceId(result) || String(fallbackDeviceId)}:${liveResultValueName(result)}:${liveResultType(result) || 'Overall'}`;
}

function liveResultMatches(result, measurement, deviceIdValue = '') {
  const resultDeviceId = liveResultDeviceId(result);
  if (deviceIdValue && resultDeviceId && resultDeviceId !== String(deviceIdValue)) return false;
  if (liveResultKey(result, deviceIdValue) === liveMeasurementKey(measurement, deviceIdValue)) return true;
  const resultType = liveResultType(result);
  const resultValue = liveResultValueName(result);
  if (!resultType || !resultValue) return false;
  const normalizeMatch = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalizeMatch(resultType) === normalizeMatch(measurement.type)
    && normalizeMatch(resultValue) === normalizeMatch(measurement.value);
}

function unwrapLiveValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    for (const entry of [...value].reverse()) {
      const unwrapped = unwrapLiveValue(entry);
      if (unwrapped !== '') return unwrapped;
    }
    return '';
  }
  if (typeof value !== 'object') return value;
  for (const key of ['reading', 'onlineValue', 'measuredValue', 'measurementValue', 'actualValue', 'rawValue', 'current', 'currentValue', 'val', 'lastValue', 'avg', 'value', 'values']) {
    if (value[key] !== undefined) {
      const unwrapped = unwrapLiveValue(value[key]);
      if (unwrapped !== '') return unwrapped;
    }
  }
  const ignoredKeys = new Set(['valueType', 'value_type', 'type', 'typeName', 'name', 'valueName', 'unit', 'id', 'deviceId', 'timestamp', 'time']);
  for (const [key, nested] of Object.entries(value)) {
    if (ignoredKeys.has(key)) continue;
    const unwrapped = unwrapLiveValue(nested);
    if (unwrapped !== '') return unwrapped;
  }
  return '';
}

function liveResultValue(result, measurement) {
  if (result !== null && typeof result !== 'object') return result !== measurement.value ? result : '';
  for (const key of ['reading', 'onlineValue', 'measuredValue', 'measurementValue', 'actualValue', 'rawValue', 'current', 'currentValue', 'val', 'data', 'result', 'lastValue', 'avg', 'value', 'values']) {
    const candidate = itemValue(result, key);
    const value = unwrapLiveValue(candidate);
    if (value !== '' && value !== measurement.value) return value;
  }
  const direct = unwrapLiveValue(result);
  if (direct !== '' && direct !== measurement.value) return direct;
  return '';
}

function measurementDisplaySettings(measurement, id = deviceId(selectedDevice())) {
  const project = $('#project-select')?.value || '';
  const settings = isLoadedDeviceState(project, id)
    ? state.displaySettings
    : state.measurementCache[cacheKey(project, id)]?.displaySettings || {};
  return normalizeDisplaySettings(settings[measurementKey(measurement)], measurement);
}

function updateMeasurementCounters() {
  const project = $('#project-select')?.value || '';
  const currentId = deviceId(state.currentDevice || {});
  const deviceStateLoading = state.currentView === 'device-detail'
    && project
    && currentId
    && state.backendDeviceStateKey !== cacheKey(project, currentId);
  const total = deviceStateLoading ? '…' : state.onlineValues.length + state.historicalValues.length;
  const liveCount = deviceStateLoading ? '…' : state.onlineValues.length;
  const historyCount = deviceStateLoading ? '…' : state.historicalValues.length;
  const displayedCount = deviceStateLoading ? '…' : state.displayedMeasurements.length;
  const selectedHistoryCount = deviceStateLoading ? '…' : state.historicalSelectedMeasurements.length;
  setText('#stat-values', total);
  setText('#stat-values-detail', state.currentDevice ? deviceName(state.currentDevice) : 'Ausgewähltes Gerät');
  setText('#info-live-count', liveCount);
  setText('#info-history-count', historyCount);
  setText('#live-tab-count', displayedCount);
  setText('#history-tab-count', selectedHistoryCount);
  setText('#tree-value-count', total);
  setText('#live-display-status', deviceStateLoading ? 'Wird geladen …' : `${state.displayedMeasurements.length} ausgewählt`);
  setText('#historical-display-status', deviceStateLoading ? 'Wird geladen …' : `${state.historicalSelectedMeasurements.length} ausgewählt`);
  updateSelectedCounters();
}

async function publishMqttSetup(measurement, device = selectedDevice()) {
  const project = $('#project-select')?.value || '';
  const profileIds = measurementProfileIdsForDevice(measurement, device);
  if (!profileIds.length) return;
  const configuredMeasurement = {
    ...measurement,
    device,
    mqttProfileIds: profileIds,
    ...(isHistoricalMeasurement(measurement)
      ? { historyRanges: historicalDiscoveryRanges(measurement, { project, deviceId: deviceId(device) }) }
      : {})
  };
  try {
    if (!measurementActiveForDevice(measurement, device)) {
      const result = await api('/api/discovery/publish', {
        method: 'POST',
        body: JSON.stringify(discoveryInput({
          measurements: [{ ...configuredMeasurement, availabilityValue: 'offline' }]
        }))
      });
      if (Number(result.published || 0) + Number(result.queued || 0)) {
        showToast(result.queued ? 'Discovery vorgemerkt; der Messwert bleibt deaktiviert.' : 'Discovery erhalten; Messwert ist nicht verfügbar.', 'success');
      }
      return;
    }
    const discoveryResult = await api('/api/discovery/publish', { method: 'POST', body: JSON.stringify(discoveryInput({ measurements: [configuredMeasurement] })) });
    if (!discoveryResult.published) {
      showToast('MQTT-Discovery vorgemerkt; wird bei Broker-Verbindung veröffentlicht.', 'success');
      return;
    }
    await waitForMqttState();
    if (isHistoricalMeasurement(configuredMeasurement)) {
      if (isLoadedDeviceState(project, deviceId(device))) {
        const target = historicalTargetsForProject().find((entry) => entry.deviceId === String(deviceId(device)));
        if (target) await loadHistoricalData({
          silent: true,
          targets: [{ ...target, measurements: [configuredMeasurement] }]
        });
      }
      showToast(discoveryResult.queued ? 'MQTT-Discovery vorgemerkt; wird bei Broker-Verbindung veröffentlicht.' : 'MQTT-Discovery und Wert wurden veröffentlicht.', 'success');
      return;
    }
    if (!isLoadedDeviceState(project, deviceId(device))) {
      showToast(discoveryResult.queued ? 'MQTT-Discovery vorgemerkt; wird bei Broker-Verbindung veröffentlicht.' : 'MQTT-Discovery wurde veröffentlicht.', 'success');
      return;
    }
    const currentDeviceId = deviceId(selectedDevice());
    const result = liveResultList(state.liveResults).find((entry) => liveResultMatches(entry, configuredMeasurement, currentDeviceId));
    const currentTarget = liveTargetsForProject().find((target) => target.deviceId === String(currentDeviceId));
    if (result && currentTarget) await publishMqttValues([{ ...currentTarget, measurements: [configuredMeasurement] }]);
    else if (currentTarget) await loadLiveData({
      silent: true,
      targets: [{ ...currentTarget, measurements: [configuredMeasurement] }]
    });
    showToast(discoveryResult.queued ? 'MQTT-Discovery vorgemerkt; wird bei Broker-Verbindung veröffentlicht.' : 'MQTT-Discovery und Wert wurden veröffentlicht.', 'success');
  } catch (error) {
    showError(error);
  }
}

async function removeMqttDiscovery(measurements) {
  const entries = measurements.filter((measurement) => Array.isArray(measurement.mqttProfileIds) && measurement.mqttProfileIds.length);
  if (!entries.length) return;
  const result = await api('/api/discovery/remove', {
    method: 'POST',
    body: JSON.stringify(discoveryInput({ measurements: entries }))
  });
  const count = Number(result.removed || 0) + Number(result.queued || 0);
  if (count) showToast(result.queued ? 'Discovery-Löschung für den Broker vorgemerkt.' : 'Discovery wurde vom Broker entfernt.', 'success');
}

async function publishConfiguredDiscovery() {
  const liveTargets = liveTargetsForProject({ includeDisplay: true })
    .map((target) => ({
      ...target,
      measurements: target.measurements.filter((measurement) => {
        const activeProfileIds = measurement.mqttActiveProfileIds;
        return (Array.isArray(activeProfileIds)
          ? activeProfileIds.length > 0
          : measurementActiveForDevice(measurement, target.device))
          && (Array.isArray(measurement.mqttProfileIds) ? measurement.mqttProfileIds.length > 0 : measurementProfileIdsForDevice(measurement, target.device).length);
      })
    }))
    .filter((target) => target.measurements.length);
  const historicalTargets = historicalTargetsForProject()
    .map((target) => ({
      ...target,
      measurements: target.measurements.filter((measurement) => {
        const activeProfileIds = measurement.mqttActiveProfileIds;
        return (Array.isArray(activeProfileIds)
          ? activeProfileIds.length > 0
          : measurementActiveForDevice(measurement, target.device))
          && (Array.isArray(measurement.mqttProfileIds) ? measurement.mqttProfileIds.length > 0 : measurementProfileIdsForDevice(measurement, target.device).length);
      })
    }))
    .filter((target) => target.measurements.length);
  const targets = [...liveTargets, ...historicalTargets];
  if (!targets.length) return;
  await api('/api/discovery/publish', {
    method: 'POST',
    body: JSON.stringify(discoveryInput({ targets }))
  });
}

function toggleMqttMeasurement(measurement, enabled, { refresh = true } = {}) {
  if (enabled) {
    if (!state.displayedMeasurements.some((selected) => measurementKey(selected) === measurementKey(measurement))) {
      state.displayedMeasurements.push(measurement);
    }
    if (!measurementProfileIds(measurement).length) setMeasurementProfileIds(measurement, [defaultMqttProfileId()]);
    setMeasurementMqttActive(measurement, true);
    renderDisplayValues();
    renderLiveValues();
    if (refresh) {
      const project = $('#project-select')?.value || '';
      const currentDeviceId = deviceId(state.currentDevice || {});
      const target = liveTargetForDevice(project, currentDeviceId, { includeDisplay: true });
      const focusedMeasurement = target?.measurements.find((item) => measurementKey(item) === measurementKey(measurement));
      if (focusedMeasurement) {
        flushUiState()
          .then(waitForLiveRequestIdle)
          .then(() => loadLiveData({
            silent: true,
            publishMqtt: true,
            targets: [{ ...target, measurements: [focusedMeasurement] }]
          }))
          .catch(reportBackgroundError);
      }
    }
  } else {
    setMeasurementMqttActive(measurement, false);
    renderDisplayValues();
    renderLiveValues();
    showToast('MQTT-Werte werden für diesen Parameter nicht mehr veröffentlicht.', 'success');
  }
}

async function setQuickInfoMqttActive(device, measurement, enabled) {
  const project = $('#project-select')?.value || '';
  const id = deviceId(device);
  const key = cacheKey(project, id);
  const cache = state.measurementCache[key] || {};
  const previousCache = structuredClone(cache);
  const measurementKeyValue = measurementKey(measurement);

  if (isLoadedDeviceState(project, id)) {
    if (isHistoricalMeasurement(measurement)) toggleHistoricalMqttMeasurement(measurement, enabled);
    else toggleMqttMeasurement(measurement, enabled, { refresh: false });
    renderDeviceInfoValues(device);
    if (enabled && !isHistoricalMeasurement(measurement)) {
      await flushUiState();
      await waitForLiveRequestIdle();
      const target = liveTargetForDevice(project, id, { includeDisplay: true });
      const focusedMeasurement = target?.measurements.find((item) => measurementKey(item) === measurementKeyValue);
      if (focusedMeasurement) {
        await loadLiveData({
          silent: true,
          publishMqtt: true,
          targets: [{ ...target, measurements: [focusedMeasurement] }]
        });
      }
    }
    return;
  }

  const assignments = cache.mqttAssignments && typeof cache.mqttAssignments === 'object'
    ? cache.mqttAssignments
    : {};
  const activeAssignments = cache.mqttActiveAssignments && typeof cache.mqttActiveAssignments === 'object'
    ? cache.mqttActiveAssignments
    : {};
  const profileIds = Array.isArray(assignments[measurementKeyValue]) && assignments[measurementKeyValue].length
    ? assignments[measurementKeyValue]
    : [defaultMqttProfileId()];
  assignments[measurementKeyValue] = profileIds;

  if (enabled) {
    deferMqttValues();
    activeAssignments[measurementKeyValue] = profileIds;
    if (!Array.isArray(cache.selectedMeasurements)) cache.selectedMeasurements = [];
    if (!cache.selectedMeasurements.some((item) => measurementKey(item) === measurementKeyValue)) {
      cache.selectedMeasurements.push(measurement);
    }
  } else {
    delete activeAssignments[measurementKeyValue];
    cache.selectedMeasurements = (cache.selectedMeasurements || [])
      .filter((item) => measurementKey(item) !== measurementKeyValue);
  }

  cache.mqttAssignments = assignments;
  cache.mqttActiveAssignments = activeAssignments;
  state.measurementCache[key] = cache;
  try {
    await persistBackendDeviceState(project, id, cache);
  } catch (error) {
    state.measurementCache[key] = previousCache;
    renderDeviceInfoValues(device);
    throw error;
  }
  renderDeviceInfoValues(device);
}

async function removeQuickInfoMeasurement(device, measurement) {
  const project = $('#project-select')?.value || '';
  const id = deviceId(device);
  const key = cacheKey(project, id);
  const measurementKeyValue = measurementKey(measurement);

  if (isLoadedDeviceState(project, id)) {
    deselectMeasurement(measurement);
    renderDeviceInfoValues(device);
    return;
  }

  const cache = state.measurementCache[key] || {};
  const previousCache = structuredClone(cache);
  cache.displayedMeasurements = (cache.displayedMeasurements || [])
    .filter((item) => measurementKey(item) !== measurementKeyValue);
  cache.selectedMeasurements = (cache.selectedMeasurements || [])
    .filter((item) => measurementKey(item) !== measurementKeyValue);
  cache.mqttAssignments = { ...(cache.mqttAssignments || {}) };
  cache.mqttActiveAssignments = { ...(cache.mqttActiveAssignments || {}) };
  delete cache.mqttAssignments[measurementKeyValue];
  delete cache.mqttActiveAssignments[measurementKeyValue];
  cache.liveResults = (cache.liveResults || [])
    .filter((result) => !liveResultMatches(result, measurement, id));
  state.measurementCache[key] = cache;
  try {
    await persistBackendDeviceState(project, id, cache);
  } catch (error) {
    state.measurementCache[key] = previousCache;
    renderDeviceInfoValues(device);
    throw error;
  }
  renderDeviceInfoValues(device);
}

function openMeasurementSettings(measurement, device = selectedDevice()) {
  state.editingMeasurement = measurement;
  state.editingMeasurementDevice = device;
  setText('#measurement-settings-name', measurementDisplayName(measurement));
  setText('#measurement-settings-detail', `${measurement.value} · ${measurement.typeLabel || measurement.type}`);
  const assigned = measurementProfileIds(measurement);
  const profileSelect = $('#measurement-settings-profile');
  profileSelect.replaceChildren(...mqttProfiles().map((profile) => new Option(profile.name, profile.id)));
  profileSelect.value = assigned[0] || defaultMqttProfileId();
  $('#measurement-settings-retain').checked = measurementRetainStateForDevice(measurement, device);
  updateMeasurementSettingsTopic();
  const display = measurementDisplaySettings(measurement, deviceId(device));
  const unitSelect = $('#measurement-settings-unit');
  const units = measurementDisplayUnits(measurement);
  unitSelect.replaceChildren(
    new Option('Standard', ''),
    new Option(`API-Einheit (${measurement.unit || 'ohne Einheit'})`, 'api'),
    ...units.map((unit) => new Option(unit, unit))
  );
  unitSelect.value = display.unit || '';
  unitSelect.disabled = !units.length;
  const decimalsSelect = $('#measurement-settings-decimals');
  decimalsSelect.replaceChildren(
    new Option(displayPrecisionLabel(measurement), ''),
    ...Array.from({ length: 7 }, (_, count) => new Option(String(count), String(count)))
  );
  decimalsSelect.value = display.decimals === undefined ? '' : String(display.decimals);
  updateMeasurementDisplayPreview();
  updateMeasurementSettingsDiscovery();
  const project = $('#project-select')?.value || '';
  const currentDeviceId = deviceId(device);
  const deviceDefaults = historicalDefaultsForTarget({ project, deviceId: currentDeviceId });
  const historyOptions = $('#measurement-settings-history-options');
  const intervalLabel = $('#measurement-settings-interval-label');
  const intervalSelect = $('#measurement-settings-interval');
  if (isHistoricalMeasurement(measurement)) {
    if (intervalLabel) intervalLabel.textContent = 'Historienzyklus';
    setText('#measurement-settings-interval-hint', 'Standardmäßig gilt der Historienzyklus dieses Geräts. Eigene Zyklen werden an den festen Zeitpunkten des gewählten Intervalls ausgeführt.');
    intervalSelect.replaceChildren(new Option('Standardzyklus verwenden', '0'), ...HISTORY_CYCLE_OPTIONS.map(([seconds, label]) => new Option(label, String(seconds))));
    const cache = state.measurementCache[cacheKey(project, currentDeviceId)] || {};
    const settings = isLoadedDeviceState(project, currentDeviceId)
      ? state.historicalSettings[measurementKey(measurement)] || {}
      : cache.historicalSettings?.[measurementKey(measurement)] || {};
    intervalSelect.value = String(settings.interval || 0);
    const rangeMode = $('#measurement-settings-history-range-mode');
    if (rangeMode) rangeMode.value = Array.isArray(settings.ranges) && settings.ranges.length ? 'custom' : 'standard';
    renderHistoryRangeOptions($('#measurement-settings-history-ranges'), settings.ranges || deviceDefaults.ranges, 'measurement-history-range');
    const comparisonMode = $('#measurement-settings-history-comparison-mode');
    if (comparisonMode) comparisonMode.value = Array.isArray(settings.comparisons) ? 'custom' : 'standard';
    renderHistoryComparisons(
      $('#measurement-settings-history-comparisons'),
      Array.isArray(settings.comparisons) ? settings.comparisons : deviceDefaults.comparisons
    );
    updateMeasurementHistoryRangeMode();
    updateMeasurementHistoryComparisonMode();
    updateMeasurementSettingsTopic();
    if (historyOptions) historyOptions.hidden = false;
  } else {
    if (intervalLabel) intervalLabel.textContent = 'Gerätezyklus';
    setText('#measurement-settings-interval-hint', 'Der Gerätezyklus gilt für alle ausgewählten Parameter dieses Geräts. Geräte mit demselben Zyklus werden gemeinsam abgefragt.');
    intervalSelect.replaceChildren(new Option('Standardzyklus verwenden', '0'), new Option('Jede Sekunde', '1'), new Option('Alle 2 Sekunden', '2'), new Option('Alle 5 Sekunden', '5'), new Option('Alle 10 Sekunden', '10'), new Option('Alle 30 Sekunden', '30'), new Option('Jede Minute', '60'), new Option('Alle 5 Minuten', '300'));
    intervalSelect.value = String(state.deviceRefreshIntervals[cacheKey(project, currentDeviceId)] || 0);
    if (historyOptions) historyOptions.hidden = true;
  }
  updateMeasurementSettingsRestRequest();
  const dialog = $('#measurement-settings-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function mqttSlug(value) {
  return String(value || 'unknown')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'unknown';
}

function mqttStateTopic(measurement, device = selectedDevice()) {
  const profile = mqttProfiles().find((entry) => entry.id === measurementProfileIds(measurement)[0]) || mqttProfiles()[0];
  if (!profile) return '';
  const project = $('#project-select')?.value || '';
  const historical = isHistoricalMeasurement(measurement);
  const historyRange = historical
    ? (measurement.historyRange || historicalDiscoveryRanges(measurement, { project, deviceId: deviceId(device) })[0] || 'today')
    : '';
  const valueType = mqttSlug(`${measurement.value}_${measurement.type}${historical ? `_history_${historyRange}` : ''}`);
  const topicValues = {
    topicPrefix: String(profile.topicPrefix || state.config?.mqtt?.topicPrefix || 'gridvis2mqtt').replace(/^\/+|\/+$/g, ''),
    discoveryPrefix: String(profile.discoveryPrefix || 'homeassistant').replace(/^\/+|\/+$/g, ''),
    component: 'sensor',
    project: mqttSlug(project),
    deviceId: mqttSlug(deviceId(device)),
    valueType,
    measurement: mqttSlug(measurement.value),
    type: mqttSlug(measurement.type),
    postfix: 'state'
  };
  return String(profile.stateTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/state')
    .replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) => topicValues[key] ?? match)
    .split('/')
    .filter(Boolean)
    .join('/');
}

function updateMeasurementSettingsTopic() {
  const measurement = state.editingMeasurement;
  const profileId = $('#measurement-settings-profile')?.value;
  if (!measurement || !profileId) {
    setText('#measurement-settings-topic', '–');
    return;
  }
  const device = state.editingMeasurementDevice || selectedDevice();
  const configured = { ...measurement, mqttProfileIds: [profileId] };
  const topic = mqttStateTopic(configured, device);
  const ranges = isHistoricalMeasurement(configured)
    ? (!$('#measurement-settings-history-options')?.hidden
      ? measurementSettingsHistoryRanges()
      : configured.historyRanges?.length
      ? configured.historyRanges
      : historicalDiscoveryRanges(configured, { project: $('#project-select')?.value || '', deviceId: deviceId(device) }))
    : [];
  setText('#measurement-settings-topic', ranges.length > 1
    ? `${topic} (+${ranges.length - 1} weitere Zeiträume)`
    : topic);
}

function historyRangeLabel(range) {
  const baseLabel = HISTORY_RANGE_OPTIONS.find(([value]) => value === range)?.[1];
  if (baseLabel) return baseLabel;
  if (HISTORY_COMPARISON_LABELS[range]) return HISTORY_COMPARISON_LABELS[range];
  const match = /^comparison_(today|yesterday|last24hours|thisweek|lastweek|thismonth|lastmonth|thisyear|lastyear|last3months)_(hours|days|weeks|months|quarters|years)_(\d+)$/.exec(String(range || ''));
  if (match) {
    const units = {
      hours: ['Stunde', 'Stunden'],
      days: ['Tag', 'Tage'],
      weeks: ['Woche', 'Wochen'],
      months: ['Monat', 'Monate'],
      quarters: ['Quartal', 'Quartale'],
      years: ['Jahr', 'Jahre']
    };
    const baseLabel = HISTORY_RANGE_OPTIONS.find(([value]) => value === match[1])?.[1] || match[1];
    const amount = Number(match[3]);
    const [singular, plural] = units[match[2]];
    return `Vergleich: ${amount} ${amount === 1 ? singular : plural} zuvor (${baseLabel})`;
  }
  return range;
}

function measurementSettingsHistoryRanges() {
  const mode = $('#measurement-settings-history-range-mode')?.value || 'standard';
  const defaults = historicalDefaultsForTarget({
    project: $('#project-select')?.value || '',
    deviceId: deviceId(state.editingMeasurementDevice || selectedDevice())
  });
  const baseRanges = mode === 'custom'
    ? selectedHistoryRanges($('#measurement-settings-history-ranges'))
    : normalizeHistoryRanges(defaults.ranges);
  const comparisons = measurementSettingsHistoryComparisons();
  return historicalRangesWithComparison(baseRanges, comparisons);
}

function measurementSettingsHistoryComparisons() {
  const mode = $('#measurement-settings-history-comparison-mode')?.value || 'standard';
  const defaults = historicalDefaultsForTarget({
    project: $('#project-select')?.value || '',
    deviceId: deviceId(state.editingMeasurementDevice || selectedDevice())
  });
  return mode === 'custom'
    ? selectedHistoryComparisons($('#measurement-settings-history-comparisons'))
    : defaults.comparisons;
}

function updateMeasurementSettingsRestRequest() {
  const measurement = state.editingMeasurement;
  const request = $('#measurement-settings-rest-request');
  const hint = $('#measurement-settings-rest-hint');
  if (!measurement || !request) return;

  const device = state.editingMeasurementDevice || selectedDevice();
  const project = $('#project-select')?.value || state.config?.gridvis?.project || '';
  const currentDeviceId = deviceId(device);
  if (!project || !currentDeviceId) {
    request.textContent = '–';
    if (hint) hint.textContent = 'Projekt und Gerät müssen zuerst geladen werden.';
    return;
  }

  const projectPath = encodeURIComponent(project);
  const devicePath = encodeURIComponent(currentDeviceId);
  if (!isHistoricalMeasurement(measurement)) {
    const query = new URLSearchParams({
      value: `${currentDeviceId};${measurement.value};${measurement.type}`,
      timeout: '500'
    });
    request.textContent = `GET /rest/1/projects/${projectPath}/onlinevalues?${query}`;
    if (hint) hint.textContent = 'Livewerte werden über onlinevalues abgefragt. Mehrere ausgewählte Werte werden im Betrieb gemeinsam gebündelt.';
    return;
  }

  const comparisons = measurementSettingsHistoryComparisons();
  const ranges = measurementSettingsHistoryRanges();
  const historyPath = 'histenergy';
  request.textContent = ranges.map((range) => {
    const [start, end] = historyRangeExpressions(range, comparisons);
    const query = new URLSearchParams({
      value: measurement.value,
      type: measurement.type,
      start,
      end
    });
    return `${historyRangeLabel(range)}: GET /rest/1/projects/${projectPath}/devices/${devicePath}/${historyPath}?${query}`;
  }).join('\n');
  if (hint) hint.textContent = 'Historische Werte werden je Zeitbereich über histenergy als aggregiertes JSON abgefragt: Energie-/Verbrauchswerte als Summe, alle anderen Werte als Durchschnitt. Eine timebase wird absichtlich nicht übertragen.';
}

async function updateMeasurementSettingsDiscovery() {
  const measurement = state.editingMeasurement;
  const profileId = $('#measurement-settings-profile')?.value;
  const topic = $('#measurement-settings-discovery-topic');
  const payload = $('#measurement-settings-discovery-payload');
  const requestId = ++state.discoveryPreviewRequest;
  if (!measurement || !profileId) {
    if (topic) topic.textContent = '–';
    if (payload) payload.textContent = '–';
    return;
  }
  if (topic) topic.textContent = 'wird geladen ...';
  if (payload) payload.textContent = 'wird geladen ...';
  try {
    const device = state.editingMeasurementDevice || selectedDevice();
    const previewInput = discoveryInput({
      measurements: [{
        ...measurement,
        device,
        historyRanges: measurementSettingsHistoryRanges(),
        mqttProfileIds: [profileId],
        retainState: measurementRetainStateForDevice(measurement, device),
        displaySettings: normalizeDisplaySettings(measurementDisplaySettingsInput(), measurement)
      }]
    });
    // This panel describes the selected measurement only. Bridge and device
    // information discoveries are separate retained messages and belong in
    // the global discovery preview, not in this per-measurement preview.
    previewInput.previewScope = 'measurement';
    const result = await api('/api/discovery/preview', {
      method: 'POST',
      body: JSON.stringify(previewInput)
    });
    if (requestId !== state.discoveryPreviewRequest) return;
    const messages = result.messages || [];
    const message = messages[0];
    if (!message) {
      if (topic) topic.textContent = '–';
      if (payload) payload.textContent = result.enabled === false
        ? 'Discovery ist für diese Ausgabevariante deaktiviert.'
        : 'Keine Discovery-Nachricht verfügbar.';
      return;
    }
    if (topic) topic.textContent = messages.map((entry) => entry.configTopic).filter(Boolean).join('\n') || '–';
    if (payload) payload.textContent = JSON.stringify(messages.length === 1
      ? message.payload || {}
      : messages.map((entry) => ({ topic: entry.configTopic, payload: entry.payload || {} })), null, 2);
  } catch (error) {
    if (requestId !== state.discoveryPreviewRequest) return;
    if (topic) topic.textContent = '–';
    if (payload) payload.textContent = `Vorschau nicht verfügbar: ${error.message}`;
  }
}

function measurementDisplaySettingsInput() {
  const decimals = $('#measurement-settings-decimals').value;
  return {
    unit: $('#measurement-settings-unit').value,
    ...(decimals === '' ? {} : { decimals: Number(decimals) })
  };
}

function updateMeasurementDisplayPreview() {
  const measurement = state.editingMeasurement;
  if (!measurement) return;
  const device = state.editingMeasurementDevice || selectedDevice();
  const id = deviceId(device);
  const project = $('#project-select')?.value || '';
  const results = isLoadedDeviceState(project, id)
    ? state.liveResults
    : state.measurementCache[cacheKey(project, id)]?.liveResults || [];
  const result = liveResultList(results).find((entry) => liveResultMatches(entry, measurement, id));
  const current = liveResultValue(result || {}, measurement);
  const formatted = formatMeasurementValue(current !== '' ? current : measurement.lastValue, measurement, measurementDisplaySettingsInput());
  setText('#measurement-settings-display-preview', `${formatted.value} ${formatted.unit}`.trim());
}

function liveValueDisplay(measurement, result, deviceIdValue = deviceId(selectedDevice())) {
  const current = liveResultValue(result || {}, measurement);
  const rawDisplay = current !== '' ? current : measurement.lastValue;
  return formatMeasurementValue(rawDisplay, measurement, measurementDisplaySettings(measurement, deviceIdValue));
}

function liveValueMarkup(measurement, result, deviceIdValue = deviceId(selectedDevice())) {
  const formatted = liveValueDisplay(measurement, result, deviceIdValue);
  return `${escapeHtml(formatted.value)} <em>${escapeHtml(formatted.unit)}</em>`;
}

function historicalResultValue(result, measurement) {
  if (!result) return '';
  if (result !== null && typeof result !== 'object') return result;
  for (const key of ['energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'total', 'avg', 'value', 'reading', 'measuredValue', 'measurementValue', 'actualValue', 'sum', 'min', 'max']) {
    const value = unwrapLiveValue(result[key]);
    if (value !== '' && value !== measurement.value) return value;
  }
  for (const key of ['data', 'result', 'response', 'payload']) {
    if (result[key] && typeof result[key] === 'object') {
      const value = historicalResultValue(result[key], measurement);
      if (value !== '' && value !== measurement.value) return value;
    }
  }
  return '';
}

function historicalValueForRows(rows, measurement) {
  if (!Array.isArray(rows) || !rows.length) return '';
  if (!historicalUsesEnergyApi(measurement)) return historicalResultValue(rows.at(-1), measurement);
  const values = rows
    .map((row) => Number(historicalResultValue(row, measurement)))
    .filter((value) => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : '';
}

function historicalResultKey(deviceIdValue, measurement, range = '') {
  return `${deviceIdValue}:${measurementKey(measurement)}${range ? `:${range}` : ''}`;
}

function historicalResultStoreForDevice(deviceIdValue, resultStore = null) {
  if (resultStore && typeof resultStore === 'object') return resultStore;
  const project = $('#project-select')?.value || '';
  if (isLoadedDeviceState(project, deviceIdValue)) return state.historicalResults;
  return state.measurementCache[cacheKey(project, deviceIdValue)]?.historicalResults || {};
}

function historicalResultList(measurement, deviceIdValue = deviceId(selectedDevice()), range = '', resultStore = null) {
  const store = historicalResultStoreForDevice(deviceIdValue, resultStore);
  const rows = store[historicalResultKey(deviceIdValue, measurement, range)]
    || store[historicalResultKey(deviceIdValue, measurement)];
  return Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : [];
}

function historicalValueMarkup(measurement, _result, deviceIdValue = deviceId(selectedDevice()), resultStore = null) {
  const project = $('#project-select')?.value || '';
  const ranges = historicalSettingsForTarget(measurement, { project, deviceId: deviceIdValue }).ranges;
  const range = ranges[0] || 'today';
  const rows = historicalResultList(measurement, deviceIdValue, range, resultStore);
  const raw = rows.length ? historicalValueForRows(rows, measurement) : measurement.lastValue;
  const formatted = formatMeasurementValue(raw, measurement, measurementDisplaySettings(measurement, deviceIdValue));
  return `${escapeHtml(formatted.value)} <em>${escapeHtml(formatted.unit)}</em>`;
}

function openHistoryDetails(measurement, deviceIdValue, resultStore = null) {
  const dialog = $('#history-details-dialog');
  const list = $('#history-details-list');
  if (!dialog || !list || !measurement) return;
  const project = $('#project-select')?.value || '';
  const settings = historicalSettingsForTarget(measurement, { project, deviceId: deviceIdValue });
  const ranges = settings.ranges.length ? settings.ranges : ['today'];
  const store = historicalResultStoreForDevice(deviceIdValue, resultStore);
  setText('#history-details-name', measurementDisplayName(measurement));
  setText('#history-details-subtitle', `${measurement.value} · ${measurement.typeLabel || measurement.type}`);
  setText('#history-details-intro', `${ranges.length} ausgewählte Zeitbereiche · Werte aus dem Backend-Cache`);
  list.replaceChildren(...ranges.map((range) => {
    const rows = historicalResultList(measurement, deviceIdValue, range, store);
    const raw = rows.length ? historicalValueForRows(rows, measurement) : '';
    const formatted = formatMeasurementValue(raw, measurement, measurementDisplaySettings(measurement, deviceIdValue));
    const row = document.createElement('div');
    row.className = 'history-details-row';
    row.innerHTML = `<div><strong>${escapeHtml(historyRangeLabel(range))}</strong><small>${rows.length ? `${rows.length} ${rows.length === 1 ? 'Eintrag' : 'Einträge'} im Cache` : 'Noch kein Cachewert'}</small></div><b>${escapeHtml(formatted.value)} <em>${escapeHtml(formatted.unit)}</em></b>`;
    return row;
  }));
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
}

function updateLiveCardValues() {
  const currentDeviceId = deviceId(selectedDevice());
  const results = liveResultList(state.liveResults);
  $$('#live-values .measurement-card').forEach((card) => {
    const measurement = state.displayedMeasurements.find((item) => measurementKey(item) === card.dataset.measurementKey);
    if (!measurement) return;
    const result = results.find((item) => liveResultMatches(item, measurement, currentDeviceId));
    const value = card.querySelector('.measurement-card-value');
    if (value) value.innerHTML = liveValueMarkup(measurement, result, currentDeviceId);
  });
  if ($('#measurement-settings-dialog')?.open) updateMeasurementDisplayPreview();
  const infoDialog = $('#device-info-dialog');
  if (infoDialog?.open && state.infoDevice) renderDeviceInfoValues(state.infoDevice);
  if ($('#display-value-list')) renderDisplayValues();
}

function renderLiveValues() {
  const target = $('#live-values');
  if (!target) return;
  if (!state.displayedMeasurements.length) {
    target.innerHTML = '<div class="empty-state compact"><span class="empty-icon">⌁</span><strong>Keine Live-Messwerte ausgewählt</strong><p>Wähle unten die Werte für die Live-Anzeige aus und rufe sie anschließend ab.</p></div>';
    return;
  }
  const results = liveResultList(state.liveResults);
  const currentDeviceId = deviceId(selectedDevice());
  target.replaceChildren(...state.displayedMeasurements.map((measurement) => {
    const result = results.find((item) => liveResultMatches(item, measurement, currentDeviceId)) || {};
    const assigned = measurementMqttActive(measurement);
    const card = createMeasurementCard(measurement, {
      result,
      deviceIdValue: currentDeviceId,
      mqttActive: assigned,
      onRemove: () => deselectMeasurement(measurement),
      onSettings: () => openMeasurementSettings(measurement),
      onMqttChange: (enabled) => toggleMqttMeasurement(measurement, enabled)
    });
    card.draggable = true;
    card.addEventListener('dragstart', (event) => {
      state.liveDragMeasurementKey = measurementKey(measurement);
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.liveDragMeasurementKey);
    });
    card.addEventListener('dragend', () => {
      state.liveDragMeasurementKey = '';
      card.classList.remove('dragging');
      $$('#live-values .measurement-card.drag-over').forEach((entry) => entry.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (state.liveDragMeasurementKey && state.liveDragMeasurementKey !== measurementKey(measurement)) card.classList.add('drag-over');
      event.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      reorderLiveMeasurement(event.dataTransfer.getData('text/plain') || state.liveDragMeasurementKey, measurementKey(measurement));
    });
    return card;
  }));
}

function reorderLiveMeasurement(sourceKey, targetKey) {
  if (!sourceKey || sourceKey === targetKey) return;
  const sourceIndex = state.displayedMeasurements.findIndex((item) => measurementKey(item) === sourceKey);
  const targetIndex = state.displayedMeasurements.findIndex((item) => measurementKey(item) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [measurement] = state.displayedMeasurements.splice(sourceIndex, 1);
  const nextTargetIndex = state.displayedMeasurements.findIndex((item) => measurementKey(item) === targetKey);
  state.displayedMeasurements.splice(nextTargetIndex + (sourceIndex < targetIndex ? 1 : 0), 0, measurement);
  renderLiveValues();
  writeUiCache();
}

function deselectMeasurement(measurement) {
  const key = measurementKey(measurement);
  const previousProfileIds = measurementProfileIds(measurement);
  const previousRetainState = measurementRetainState(measurement);
  const previousHistoryRanges = isHistoricalMeasurement(measurement)
    ? historicalDiscoveryRanges(measurement, { project: $('#project-select')?.value || '', deviceId: deviceId(selectedDevice()) })
    : [];
  const currentDeviceId = deviceId(selectedDevice());
  state.displayedMeasurements = state.displayedMeasurements.filter((selected) => measurementKey(selected) !== key);
  setMeasurementMqttActive(measurement, false);
  setMeasurementProfileIds(measurement, []);
  state.liveResults = state.liveResults.filter((result) => !liveResultMatches(result, measurement, currentDeviceId));
  updateMeasurementCounters();
  renderLiveValues();
  renderDisplayValues();
  configureLiveRefresh();
  writeUiCache();
  if (previousProfileIds.length) {
    flushUiState()
      .then(() => removeMqttDiscovery([{ ...measurement, mqttProfileIds: previousProfileIds, historyRanges: previousHistoryRanges, retainState: previousRetainState }]))
      .catch(showError);
  }
}

function renderHistoricalValues() {
  const target = $('#historical-values');
  if (!target) return;
  if (!state.historicalSelectedMeasurements.length) {
    target.innerHTML = '<div class="empty-state compact"><span class="empty-icon">⌁</span><strong>Keine historischen Messwerte ausgewählt</strong><p>Wähle unten die verfügbaren historischen Werte aus.</p></div>';
    return;
  }
  const currentDeviceId = deviceId(selectedDevice());
  target.replaceChildren(...state.historicalSelectedMeasurements.map((measurement) => {
    const card = createMeasurementCard(measurement, {
      deviceIdValue: currentDeviceId,
      historical: true,
      mqttActive: measurementMqttActive(measurement),
      valueMarkup: historicalValueMarkup,
      onHistoryDetails: () => openHistoryDetails(measurement, currentDeviceId),
      onRemove: () => deselectHistoricalMeasurement(measurement),
      onSettings: () => openMeasurementSettings(measurement),
      onMqttChange: (enabled) => toggleHistoricalMqttMeasurement(measurement, enabled)
    });
    card.draggable = true;
    card.addEventListener('dragstart', (event) => {
      state.historicalDragMeasurementKey = measurementKey(measurement);
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.historicalDragMeasurementKey);
    });
    card.addEventListener('dragend', () => {
      state.historicalDragMeasurementKey = '';
      card.classList.remove('dragging');
      $$('#historical-values .measurement-card.drag-over').forEach((entry) => entry.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (state.historicalDragMeasurementKey && state.historicalDragMeasurementKey !== measurementKey(measurement)) card.classList.add('drag-over');
      event.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drag-over');
      reorderHistoricalMeasurement(event.dataTransfer.getData('text/plain') || state.historicalDragMeasurementKey, measurementKey(measurement));
    });
    return card;
  }));
}

function reorderHistoricalMeasurement(sourceKey, targetKey) {
  if (!sourceKey || sourceKey === targetKey) return;
  const sourceIndex = state.historicalSelectedMeasurements.findIndex((item) => measurementKey(item) === sourceKey);
  const targetIndex = state.historicalSelectedMeasurements.findIndex((item) => measurementKey(item) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return;
  markMeasurementMutation();
  const [measurement] = state.historicalSelectedMeasurements.splice(sourceIndex, 1);
  const nextTargetIndex = state.historicalSelectedMeasurements.findIndex((item) => measurementKey(item) === targetKey);
  state.historicalSelectedMeasurements.splice(nextTargetIndex + (sourceIndex < targetIndex ? 1 : 0), 0, measurement);
  renderHistoricalValues();
  writeUiCache();
}

function deselectHistoricalMeasurement(measurement) {
  // This path changes the selection directly instead of using the two setter
  // helpers below. Invalidate any older async definition/history response so
  // it cannot write the removed measurement back into the state.
  markMeasurementMutation();
  const key = measurementKey(measurement);
  const previousProfileIds = measurementProfileIds(measurement);
  const previousRetainState = measurementRetainState(measurement);
  const previousHistoryRanges = historicalDiscoveryRanges(measurement, {
    project: $('#project-select')?.value || '',
    deviceId: deviceId(selectedDevice())
  });
  state.historicalSelectedMeasurements = state.historicalSelectedMeasurements.filter((item) => measurementKey(item) !== key);
  delete state.historicalMqttActiveAssignments[key];
  delete state.historicalMqttAssignments[key];
  delete state.historicalRetainAssignments[key];
  delete state.historicalSettings[key];
  const resultPrefix = `${deviceId(selectedDevice())}:${key}`;
  Object.keys(state.historicalResults).filter((resultKey) => resultKey === resultPrefix || resultKey.startsWith(`${resultPrefix}:`)).forEach((resultKey) => {
    delete state.historicalResults[resultKey];
  });
  updateMeasurementCounters();
  renderHistoricalValues();
  renderHistoricalSelection();
  configureHistoricalRefresh();
  writeUiCache();
  if (previousProfileIds.length) {
    flushUiState()
      .then(() => removeMqttDiscovery([{
        ...measurement,
        mqttProfileIds: previousProfileIds,
        historyRanges: previousHistoryRanges,
        retainState: previousRetainState
      }]))
      .catch(showError);
  }
}

function republishHistoricalMeasurementAfterEnable(measurement) {
  const mutationVersion = state.measurementMutationVersion;
  const project = $('#project-select')?.value || '';
  const currentDeviceId = deviceId(state.currentDevice || {});
  flushUiState()
    .then(waitForHistoricalRequestIdle)
    .then(() => {
      // A quick disable/re-enable sequence may finish while the publish is
      // waiting behind another request. Never publish an obsolete enable.
      if (state.measurementMutationVersion !== mutationVersion || !measurementMqttActive(measurement)) return null;
      const target = historicalTargetForDevice(project, currentDeviceId);
      const configuredMeasurement = target?.measurements.find((item) => measurementKey(item) === measurementKey(measurement));
      if (!configuredMeasurement) return null;
      return publishMqttSetup(configuredMeasurement, state.currentDevice);
    })
    .catch(reportBackgroundError);
}

function toggleHistoricalMqttMeasurement(measurement, enabled) {
  if (enabled) {
    if (!state.historicalSelectedMeasurements.some((item) => measurementKey(item) === measurementKey(measurement))) {
      state.historicalSelectedMeasurements.push(measurement);
    }
    if (!measurementProfileIds(measurement).length) setMeasurementProfileIds(measurement, [defaultMqttProfileId()]);
    setMeasurementMqttActive(measurement, true);
    renderHistoricalValues();
    renderHistoricalSelection();
    republishHistoricalMeasurementAfterEnable(measurement);
  } else {
    setMeasurementMqttActive(measurement, false);
    renderHistoricalValues();
    renderHistoricalSelection();
    showToast('MQTT-Werte werden für diesen historischen Parameter nicht mehr veröffentlicht.', 'success');
  }
}

function selectionFilterState(kind) {
  return state.selectionFilters?.[kind] || { discovery: false, mqtt: false };
}

function measurementMatchesSelectionFilters(measurement, kind) {
  const filters = selectionFilterState(kind);
  if (filters.discovery && !measurementProfileIds(measurement).length) return false;
  if (filters.mqtt && !measurementMqttActive(measurement)) return false;
  return true;
}

function updateSelectionFilterControls(kind, measurements) {
  const prefix = kind === 'historical' ? 'historical' : 'live';
  const values = Array.isArray(measurements) ? measurements : [];
  setText(`#${prefix}-filter-discovery-count`, values.filter((measurement) => measurementProfileIds(measurement).length).length);
  setText(`#${prefix}-filter-mqtt-count`, values.filter(measurementMqttActive).length);
  const filters = selectionFilterState(kind);
  const discovery = $(`#${prefix}-filter-discovery`);
  const mqtt = $(`#${prefix}-filter-mqtt`);
  if (discovery) discovery.checked = filters.discovery === true;
  if (mqtt) mqtt.checked = filters.mqtt === true;
}

function selectionStatusMarkup(measurement) {
  const statuses = [];
  if (measurementProfileIds(measurement).length) statuses.push('<span class="value-status discovery">Discovery</span>');
  if (measurementMqttActive(measurement)) statuses.push('<span class="value-status mqtt">MQTT aktiv</span>');
  return statuses.join('') || '<span class="value-status muted">–</span>';
}

function historicalRangeColumns(values, deviceIdValue) {
  const project = $('#project-select')?.value || '';
  const ranges = [];
  for (const measurement of values || []) {
    const configured = historicalSettingsForTarget(measurement, {
      project,
      deviceId: deviceIdValue
    }).ranges;
    for (const range of configured) {
      if (!ranges.includes(range)) ranges.push(range);
    }
  }
  return ranges.length ? ranges : ['today'];
}

function historicalListGridTemplate(rangeCount) {
  return `58px minmax(220px, .8fr) repeat(${Math.max(1, rangeCount)}, minmax(125px, 1fr)) minmax(150px, .45fr)`;
}

function applyHistoricalListGridLayout(element, rangeCount) {
  if (!element) return;
  element.style.gridTemplateColumns = historicalListGridTemplate(rangeCount);
  element.style.minWidth = `${Math.max(690, 58 + 220 + Math.max(1, rangeCount) * 145 + 150)}px`;
}

function valueListHeaderMarkup(kind, historyRanges = []) {
  const header = document.createElement('div');
  header.className = `value-table-head ${kind === 'historical' ? 'historical-list-head' : 'live-list-head'}`;
  const columns = kind === 'historical'
    ? ['Auswahl', 'Messwert', ...historyRanges.map(historyRangeLabel), 'Status']
    : ['Auswahl', 'Messwert', 'Livewert', 'Status'];
  if (kind === 'historical') applyHistoricalListGridLayout(header, historyRanges.length);
  columns.forEach((column, index) => {
    const cell = document.createElement('span');
    if (index === 0) {
      cell.className = 'value-table-select-head';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = kind === 'historical' ? 'historical-visible-selection' : 'live-visible-selection';
      checkbox.setAttribute('aria-label', 'Sichtbare Messwerte auswählen oder abwählen');
      // GridVis uses a blank selection column. Keep the accessible label on
      // the checkbox, but do not render the word "Auswahl" in the header.
      cell.append(checkbox);
    } else {
      cell.textContent = column;
    }
    header.append(cell);
  });
  return header;
}

function isMeasurementSelectedForList(kind, measurement) {
  const selected = kind === 'historical'
    ? state.historicalSelectedMeasurements
    : state.displayedMeasurements;
  return selected.some((item) => measurementKey(item) === measurementKey(measurement));
}

function updateVisibleSelectionCheckbox(kind, values) {
  const id = kind === 'historical' ? 'historical-visible-selection' : 'live-visible-selection';
  const checkbox = $(`#${id}`);
  if (!checkbox) return;
  const visibleValues = Array.isArray(values) ? values : [];
  const selectedCount = visibleValues.filter((measurement) => isMeasurementSelectedForList(kind, measurement)).length;
  checkbox.checked = visibleValues.length > 0 && selectedCount === visibleValues.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < visibleValues.length;
  checkbox.disabled = visibleValues.length === 0;
}

function applyVisibleSelection(kind, values, enabled) {
  const visibleValues = Array.isArray(values) ? values : [];
  if (kind === 'historical') {
    if (enabled) {
      for (const measurement of visibleValues) {
        if (!isMeasurementSelectedForList(kind, measurement)) state.historicalSelectedMeasurements.push(measurement);
        if (!measurementProfileIds(measurement).length) setMeasurementProfileIds(measurement, [defaultMqttProfileId()]);
        setMeasurementMqttActive(measurement, true);
      }
      updateMeasurementCounters();
      renderHistoricalSelection();
      renderHistoricalValues();
      configureHistoricalRefresh();
      writeUiCache();
      loadHistoricalData({ silent: true, publishMqtt: false }).catch(reportBackgroundError);
      return;
    }
    for (const measurement of visibleValues) {
      if (isMeasurementSelectedForList(kind, measurement)) deselectHistoricalMeasurement(measurement);
    }
    updateMeasurementCounters();
    renderHistoricalSelection();
    renderHistoricalValues();
    configureHistoricalRefresh();
    writeUiCache();
    return;
  }

  if (enabled) {
    for (const measurement of visibleValues) {
      if (!isMeasurementSelectedForList(kind, measurement)) state.displayedMeasurements.push(measurement);
      if (!measurementProfileIds(measurement).length) setMeasurementProfileIds(measurement, [defaultMqttProfileId()]);
      setMeasurementMqttActive(measurement, true);
    }
    updateMeasurementCounters();
    renderDisplayValues();
    renderLiveValues();
    configureLiveRefresh();
    writeUiCache();
    if (isLiveFocusActive()) {
      loadLiveData({ silent: true, publishMqtt: false, targets: liveTargetsForFocus({ includeDisplay: true }) })
        .catch(reportBackgroundError);
    }
    return;
  }

  for (const measurement of visibleValues) {
    if (isMeasurementSelectedForList(kind, measurement)) deselectMeasurement(measurement);
  }
  updateMeasurementCounters();
  renderDisplayValues();
  renderLiveValues();
  configureLiveRefresh();
  writeUiCache();
}

function liveSelectionValueMarkup(measurement, result, deviceIdValue) {
  const current = liveResultValue(result || {}, measurement);
  const hasValue = current !== '' || measurement.lastValue !== undefined && measurement.lastValue !== null && measurement.lastValue !== '';
  const markup = liveValueMarkup(measurement, result, deviceIdValue);
  return `<span class="value-reading${hasValue ? '' : ' is-empty'}">${markup}${hasValue ? '' : '<small>Nicht verfügbar</small>'}</span>`;
}

function historicalSelectionRangeMarkup(measurement, deviceIdValue, range) {
  const project = $('#project-select')?.value || '';
  const rows = historicalResultList(measurement, deviceIdValue, range);
  const raw = rows.length ? historicalValueForRows(rows, measurement) : '';
  const formatted = formatMeasurementValue(raw, measurement, measurementDisplaySettings(measurement, deviceIdValue));
  const hasValue = raw !== '' && raw !== undefined && raw !== null;
  return `<span class="history-range-value${hasValue ? '' : ' is-empty'}">${hasValue ? `${escapeHtml(formatted.value)} <em>${escapeHtml(formatted.unit)}</em>` : '–'}</span>`;
}

function liveTargetForMeasurements(project, id, measurements) {
  const current = isLoadedDeviceState(project, id);
  const cache = state.measurementCache[cacheKey(project, id)] || {};
  const sourceMeasurements = uniqueMeasurements(measurements);
  if (!sourceMeasurements.length) return null;
  const assignments = current ? state.mqttAssignments : cache.mqttAssignments || {};
  const activeAssignments = current ? state.mqttActiveAssignments : cache.mqttActiveAssignments || {};
  const retainAssignments = current ? state.mqttRetainAssignments : cache.mqttRetainAssignments || {};
  return {
    project,
    deviceId: String(id),
    device: liveTargetDevice(project, id),
    refreshInterval: deviceRefreshInterval(project, id),
    measurements: sourceMeasurements.map((measurement) => {
      const key = measurementKey(measurement);
      const profileIds = assignments[key];
      const activeProfileIds = activeAssignments[key] || [];
      return {
        ...measurement,
        ...(Array.isArray(profileIds) ? { mqttProfileIds: profileIds } : {}),
        ...(Array.isArray(activeProfileIds) ? { mqttActiveProfileIds: activeProfileIds } : {}),
        retainState: retainAssignments[key] === true
      };
    })
  };
}

function requestVisibleLiveValues(values) {
  // The page may still be showing cached definitions while GridVis is
  // currently offline. Do not silently skip the display request here; the
  // API call must either return values or produce a visible/logged error.
  if (!state.currentDevice || state.currentDetailTab !== 'live') return;
  const project = $('#project-select')?.value || '';
  const currentId = deviceId(state.currentDevice || {});
  const focusedMeasurements = uniqueMeasurements([
    ...(state.displayedMeasurements || []),
    ...(state.selectedMeasurements || []),
    ...(values || [])
  ]);
  const target = liveTargetForMeasurements(project, currentId, focusedMeasurements);
  if (!target) return;
  const requestKey = `${project}::${currentId}::${target.measurements.map(measurementKey).join('|')}`;
  if (state.liveVisibleRequestKey === requestKey) return;
  state.liveVisibleRequestKey = requestKey;
  loadLiveData({ silent: true, publishMqtt: false, targets: [target] }).catch((error) => {
    if (state.liveVisibleRequestKey === requestKey) state.liveVisibleRequestKey = '';
    reportBackgroundError(error);
  });
}

function historicalTargetForMeasurements(project, id, measurements) {
  const current = isLoadedDeviceState(project, id);
  const cache = state.measurementCache[cacheKey(project, id)] || {};
  const assignments = current ? state.historicalMqttAssignments : cache.historicalMqttAssignments || {};
  const activeAssignments = current ? state.historicalMqttActiveAssignments : cache.historicalMqttActiveAssignments || {};
  const retainAssignments = current ? state.historicalRetainAssignments : cache.historicalRetainAssignments || {};
  const sourceMeasurements = uniqueMeasurementList(measurements).filter(historicalMeasurementAvailable);
  if (!sourceMeasurements.length) return null;
  return {
    project,
    deviceId: String(id),
    device: liveTargetDevice(project, id),
    measurements: sourceMeasurements.map((measurement) => {
      const key = measurementKey(measurement);
      const profileIds = assignments[key];
      const activeProfileIds = activeAssignments[key] || [];
      return {
        ...measurement,
        ...(Array.isArray(profileIds) ? { mqttProfileIds: profileIds } : {}),
        ...(Array.isArray(activeProfileIds) ? { mqttActiveProfileIds: activeProfileIds } : {}),
        historyRanges: historicalDiscoveryRanges(measurement, { project, deviceId: String(id) }),
        retainState: retainAssignments[key] === true
      };
    })
  };
}

function requestVisibleHistoricalValues(values) {
  if (!state.currentDevice || state.currentDetailTab !== 'history') return;
  const project = $('#project-select')?.value || '';
  const currentId = deviceId(state.currentDevice || {});
  const target = historicalTargetForMeasurements(project, currentId, values);
  if (!target) return;
  const requestKey = `${project}::${currentId}::${target.measurements.map((measurement) => {
    const ranges = historicalSettingsForTarget(measurement, target).ranges.join(',');
    return `${measurementKey(measurement)}:${ranges}`;
  }).join('|')}`;
  if (state.historicalVisibleRequestKey === requestKey) return;
  state.historicalVisibleRequestKey = requestKey;
  loadHistoricalData({
    silent: true,
    publishMqtt: false,
    retryDisplayAfterInFlight: true,
    targets: [target]
  }).catch((error) => {
    if (state.historicalVisibleRequestKey === requestKey) state.historicalVisibleRequestKey = '';
    reportBackgroundError(error);
  });
}

function valuesInListViewport(kind, list) {
  if (!list) return [];
  const available = kind === 'historical'
    ? state.historicalValues.filter(historicalMeasurementAvailable)
    : state.onlineValues;
  const listRect = list.getBoundingClientRect();
  const rows = [...list.querySelectorAll('.value-row')];
  return rows
    .filter((row) => {
      const rowRect = row.getBoundingClientRect();
      return rowRect.bottom > listRect.top && rowRect.top < listRect.bottom;
    })
    .map((row) => available.find((measurement) => measurementKey(measurement) === row.dataset.measurementKey))
    .filter(Boolean);
}

function bindVisibleListScroll(kind, list) {
  if (!list || list.dataset.visibleRequestBound === kind) return;
  list.dataset.visibleRequestBound = kind;
  list.addEventListener('scroll', () => {
    const values = valuesInListViewport(kind, list);
    if (kind === 'historical') requestVisibleHistoricalValues(values);
    else requestVisibleLiveValues(values);
  }, { passive: true });
}

function renderHistoricalSelection() {
  const list = $('#historical-value-list');
  if (!list) return;
  const currentDeviceId = deviceId(selectedDevice());
  const query = ($('#historical-display-search')?.value || '').trim().toLowerCase();
  const allValues = state.historicalValues.filter(historicalMeasurementAvailable);
  updateSelectionFilterControls('historical', allValues);
  const values = allValues
    .filter((item) => `${measurementDisplayName(item)} ${item.value} ${item.type}`.toLowerCase().includes(query))
    .filter((item) => measurementMatchesSelectionFilters(item, 'historical'));
  if (!values.length) {
    list.innerHTML = '<div class="empty-state compact">Keine verfügbaren historischen Messwerte gefunden.</div>';
    return;
  }
  const historyRanges = historicalRangeColumns(values, currentDeviceId);
  const header = valueListHeaderMarkup('historical', historyRanges);
  list.replaceChildren(header, ...values.map((item) => {
    const key = measurementKey(item);
    const row = document.createElement('div');
    row.className = 'value-row historical-value-row';
    row.dataset.measurementKey = key;
    applyHistoricalListGridLayout(row, historyRanges.length);
    const rangeCells = historyRanges.map((range) => `<span class="value-history-cell">${historicalSelectionRangeMarkup(item, currentDeviceId, range)}</span>`).join('');
    row.innerHTML = `<span class="value-select"><input type="checkbox" aria-label="${escapeHtml(measurementDisplayName(item))} auswählen"></span><span class="value-main"><strong>${escapeHtml(measurementDisplayName(item))}</strong><small>${escapeHtml(item.value)} · ${escapeHtml(item.typeLabel || item.type)} · ${escapeHtml(item.unit || 'ohne Einheit')}</small></span>${rangeCells}<span class="value-statuses">${selectionStatusMarkup(item)}</span>`;
    const checkbox = row.querySelector('input');
    checkbox.checked = state.historicalSelectedMeasurements.some((selected) => measurementKey(selected) === key);
    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) {
        if (!state.historicalSelectedMeasurements.some((selected) => measurementKey(selected) === key)) state.historicalSelectedMeasurements.push(item);
        if (!measurementProfileIds(item).length) setMeasurementProfileIds(item, [defaultMqttProfileId()]);
        setMeasurementMqttActive(item, true);
        // Re-publish the Discovery explicitly after the backend state commit.
        // The backend history queue then refreshes the value and publishes it.
        republishHistoricalMeasurementAfterEnable(item);
      } else {
        deselectHistoricalMeasurement(item);
      }
      updateMeasurementCounters();
      renderHistoricalValues();
      renderHistoricalSelection();
      configureHistoricalRefresh();
      writeUiCache();
    });
    return row;
  }));
  updateVisibleSelectionCheckbox('historical', values);
  header.querySelector('input')?.addEventListener('change', (event) => {
    applyVisibleSelection('historical', values, event.target.checked);
  });
  bindVisibleListScroll('historical', list);
  requestVisibleHistoricalValues(valuesInListViewport('historical', list));
}

function renderDisplayValues() {
  const list = $('#display-value-list');
  if (!list) return;
  const currentDeviceId = deviceId(selectedDevice());
  const query = ($('#live-display-search')?.value || '').trim().toLowerCase();
  const allValues = state.onlineValues;
  updateSelectionFilterControls('live', allValues);
  const values = allValues
    .filter((item) => `${measurementDisplayName(item)} ${item.value} ${item.type}`.toLowerCase().includes(query))
    .filter((item) => measurementMatchesSelectionFilters(item, 'live'));
  if (!values.length) {
    list.innerHTML = '<div class="empty-state compact">Keine passenden Online-Messwerte gefunden.</div>';
    return;
  }
  const results = liveResultList(state.liveResults);
  const header = valueListHeaderMarkup('live');
  list.replaceChildren(header, ...values.map((item) => {
    const key = measurementKey(item);
    const result = results.find((entry) => liveResultMatches(entry, item, currentDeviceId));
    const row = document.createElement('div');
    row.className = 'value-row live-value-row';
    row.dataset.measurementKey = key;
    row.innerHTML = `<span class="value-select"><input type="checkbox" aria-label="${escapeHtml(measurementDisplayName(item))} auswählen"></span><span class="value-main"><strong>${escapeHtml(measurementDisplayName(item))}</strong><small>${escapeHtml(item.value)} · ${escapeHtml(item.typeLabel || item.type)} · ${escapeHtml(item.unit || 'ohne Einheit')}</small></span><span class="value-live">${liveSelectionValueMarkup(item, result, currentDeviceId)}</span><span class="value-statuses">${selectionStatusMarkup(item)}</span>`;
    const checkbox = row.querySelector('input');
    checkbox.checked = state.displayedMeasurements.some((selected) => measurementKey(selected) === key);
    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) {
        if (!state.displayedMeasurements.some((selected) => measurementKey(selected) === key)) state.displayedMeasurements.push(item);
        if (!measurementProfileIds(item).length) setMeasurementProfileIds(item, [defaultMqttProfileId()]);
        setMeasurementMqttActive(item, true);
      } else {
        deselectMeasurement(item);
      }
      state.liveResults = state.liveResults.filter((result) => {
        const resultDeviceId = liveResultDeviceId(result);
        return (resultDeviceId && resultDeviceId !== String(currentDeviceId))
          || state.displayedMeasurements.some((selected) => liveResultMatches(result, selected, currentDeviceId));
      });
      updateMeasurementCounters();
      renderLiveValues();
      renderDisplayValues();
      configureLiveRefresh();
      writeUiCache();
      if (event.target.checked) {
        // A newly selected display value should not wait for the next timer
        // tick before its first value becomes visible or reaches MQTT. Flush
        // Discovery first, then query only the currently opened device.
        if (isLiveFocusActive()) {
          flushUiState()
            .then(waitForLiveRequestIdle)
            .then(() => loadLiveData({
              silent: true,
              publishMqtt: true,
              targets: liveTargetsForFocus({ includeDisplay: true })
            }))
            .catch(reportBackgroundError);
        }
      }
    });
    return row;
  }));
  updateVisibleSelectionCheckbox('live', values);
  header.querySelector('input')?.addEventListener('change', (event) => {
    applyVisibleSelection('live', values, event.target.checked);
  });
  bindVisibleListScroll('live', list);
  requestVisibleLiveValues(valuesInListViewport('live', list));
}

function selectedDevice() {
  return state.currentDevice || state.devices.find((device) => deviceId(device) === $('#device-select')?.value) || { id: $('#device-select')?.value || '', name: $('#device-select')?.selectedOptions[0]?.textContent || '' };
}

function showLoginScreen(message = '') {
  $('#app-shell').hidden = true;
  $('#password-change-screen').hidden = true;
  $('#login-screen').hidden = false;
  setText('#login-error', message);
  $('#login-username')?.focus();
}

function showPasswordChangeScreen(message = '') {
  $('#app-shell').hidden = true;
  $('#login-screen').hidden = true;
  $('#password-change-screen').hidden = false;
  setText('#password-change-error', message);
  $('#new-password')?.focus();
}

function showAppScreen() {
  $('#login-screen').hidden = true;
  $('#password-change-screen').hidden = true;
  $('#app-shell').hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();
  const button = $('#login-form button[type="submit"]');
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  setText('#login-error', '');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    $('#login-password').value = '';
    if (result.mustChangePassword) showPasswordChangeScreen();
    else await loadInitial();
  } catch (error) {
    setText('#login-error', error.message);
    $('#login-password').select();
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const button = $('#password-change-form button[type="submit"]');
  const password = $('#new-password').value;
  const confirmPassword = $('#new-password-confirm').value;
  setText('#password-change-error', '');
  if (password !== confirmPassword) {
    setText('#password-change-error', 'Die beiden neuen Passwörter stimmen nicht überein.');
    return;
  }
  if (button) button.disabled = true;
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ password, confirmPassword })
    });
    $('#new-password').value = '';
    $('#new-password-confirm').value = '';
    showToast('Passwort gespeichert.', 'success');
    await loadInitial();
  } catch (error) {
    setText('#password-change-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function authRoleLabel(role) {
  return role === 'admin' ? 'Administrator' : 'Benutzer';
}

function renderAuthUsers(users = []) {
  const list = $('#auth-user-list');
  if (!list) return;
  if (!users.length) {
    list.innerHTML = '<p class="form-hint">Keine Benutzer gefunden.</p>';
    return;
  }
  list.replaceChildren(...users.map((user) => {
    const row = document.createElement('div');
    row.className = 'auth-user-row';
    row.dataset.userId = user.id;
    const isCurrent = user.id === state.auth?.userId;
    row.innerHTML = `<div class="auth-user-details"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(authRoleLabel(user.role))}${isCurrent ? ' · angemeldet' : ''}</span></div><div class="auth-user-actions"><input data-auth-user-password type="password" minlength="8" placeholder="Neues Passwort" autocomplete="new-password"><button class="button button-quiet" type="button" data-auth-action="reset"${isCurrent ? ' disabled' : ''}>Zurücksetzen</button><button class="button button-quiet" type="button" data-auth-action="delete"${isCurrent ? ' disabled' : ''}>Löschen</button></div>`;
    return row;
  }));
}

async function loadAdministration() {
  const result = await api('/api/auth/profile');
  state.auth = result.profile || state.auth;
  $('#profile-username').value = state.auth?.username || '';
  renderAuthUsers(result.users || []);
  const isAdmin = state.auth?.role === 'admin';
  const management = $('#user-management-panel');
  if (management) management.hidden = !isAdmin;
}

async function submitProfile(event) {
  event.preventDefault();
  const form = $('#profile-form');
  const button = form?.querySelector('button[type="submit"]');
  const input = Object.fromEntries(new FormData(form).entries());
  if (input.password && input.password !== input.confirmPassword) {
    throw new Error('Die beiden neuen Passwörter stimmen nicht überein.');
  }
  if (button) button.disabled = true;
  try {
    const result = await api('/api/auth/profile', { method: 'PUT', body: JSON.stringify(input) });
    state.auth = result.profile || state.auth;
    $('#profile-current-password').value = '';
    $('#profile-new-password').value = '';
    $('#profile-confirm-password').value = '';
    setText('#profile-status', 'Profil gespeichert.');
    showToast('Profil gespeichert.', 'success');
    await loadAdministration();
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitNewUser(event) {
  event.preventDefault();
  const form = $('#user-create-form');
  const button = form?.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await api('/api/auth/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
    form.reset();
    await loadAdministration();
    showToast('Benutzer angelegt.', 'success');
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleAuthUserAction(event) {
  const button = event.target.closest('[data-auth-action]');
  if (!button) return;
  const row = button.closest('[data-user-id]');
  const userId = row?.dataset.userId;
  if (!userId) return;
  if (button.dataset.authAction === 'delete') {
    if (!window.confirm('Diesen Benutzer wirklich löschen?')) return;
    button.disabled = true;
    try {
      await api(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      await loadAdministration();
      showToast('Benutzer gelöscht.', 'success');
    } finally {
      button.disabled = false;
    }
    return;
  }
  const password = row.querySelector('[data-auth-user-password]')?.value || '';
  if (!password) throw new Error('Bitte zuerst ein neues Passwort eingeben.');
  button.disabled = true;
  try {
    await api(`/api/auth/users/${encodeURIComponent(userId)}/password`, {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    row.querySelector('[data-auth-user-password]').value = '';
    showToast('Passwort zurückgesetzt.', 'success');
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}

async function downloadBackup() {
  const includeConnections = Boolean($('#backup-include-connections')?.checked);
  const response = await fetch(`/api/backup?includeConnections=${includeConnections}`, { cache: 'no-store' });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the HTTP fallback if the server returned no JSON error.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'gridvis2mqtt-backup.json';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(includeConnections ? 'Backup inklusive Verbindungsdaten heruntergeladen.' : 'Backup ohne Verbindungsdaten heruntergeladen.', 'success');
}

async function selectBackupFile(event) {
  const file = event.target.files?.[0];
  pendingBackup = null;
  $('#backup-restore').disabled = true;
  setText('#backup-file-name', file ? file.name : 'Keine Datei ausgewählt.');
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== 'gridvis2mqtt-backup' || backup?.formatVersion !== 1) {
      throw new Error('Das ist kein unterstütztes GridVis2MQTT-Backup.');
    }
    pendingBackup = backup;
    $('#backup-restore').disabled = false;
    setText('#backup-file-name', `${file.name} · gültiges Backup${backup.includes?.connections ? ' inklusive Verbindungsdaten' : ''}`);
  } catch (error) {
    setText('#backup-file-name', `${file.name} · ${error.message}`);
  }
}

async function restoreBackup() {
  if (!pendingBackup) return;
  const includesConnections = pendingBackup.includes?.connections === true;
  const warning = includesConnections
    ? 'Dieses Backup enthält GridVis- und MQTT-Zugangsdaten. Sie werden die aktuellen Einstellungen ersetzen. Fortfahren?'
    : 'Die gespeicherten MQTT-Zuordnungen und Anwendungseinstellungen werden ersetzt. Fortfahren?';
  if (!window.confirm(warning)) return;
  const button = $('#backup-restore');
  button.disabled = true;
  try {
    await api('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(pendingBackup)
    });
    showToast('Backup wiederhergestellt. Die Seite wird neu geladen.', 'success');
    window.setTimeout(() => window.location.reload(), 700);
  } finally {
    button.disabled = false;
  }
}

async function checkForUpdate() {
  const button = $('#update-check');
  const originalLabel = button?.textContent || 'Update prüfen';
  if (button) {
    button.disabled = true;
    button.textContent = 'Prüfe ...';
  }
  try {
    const result = await api('/api/update/check');
    const update = result.update || {};
    setText('#update-current-version', update.currentVersion ? `v${update.currentVersion}` : '–');
    setText('#update-status', update.message || 'Kein Update-Status verfügbar.');
    if (update.updateAvailable) showToast(update.message, 'success');
    else if (!update.supported) showToast(update.message, 'warning');
    else showToast(update.message, 'success');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function loadInitial() {
  const auth = await api('/api/auth/status');
  state.auth = auth;
  if (!auth.authenticated) {
    showLoginScreen();
    return;
  }
  if (auth.mustChangePassword) {
    showPasswordChangeScreen();
    return;
  }
  showAppScreen();
  const hash = location.hash.slice(1);
  if (viewLabels[hash]) setView(hash, false);
  const [configResult, stateResult] = await Promise.all([api('/api/config'), api('/api/state')]);
  state.config = configResult.config;
  const serverState = stateResult.state && typeof stateResult.state === 'object' ? stateResult.state : {};
  const hasServerState = stateResult.initialized === true && Number(serverState.version) >= 2;
  restoreUiState(hasServerState ? serverState : {});
  enableServerStatePersistence();
  updateGridvisConnectionControl();
  if (state.config.gridvis.enabled === false) {
    setStatus('GridVis manuell getrennt', false);
    setText('#connection-detail', 'Es werden keine GridVis-Abfragen ausgeführt.');
  } else if (state.config.gridvis.configured) {
    const connectionStatus = state.config.gridvis.connection?.status;
    if (connectionStatus === 'online') setStatus('Verbindung besteht – zuletzt erfolgreich geprüft', true);
    else if (connectionStatus === 'offline') setStatus('Verbindung gespeichert, zuletzt nicht erreichbar', false);
    else setStatus('Verbindung gespeichert – noch nicht geprüft', 'unknown');
  }
  setText('#app-version', `v${state.config.version}`);
  $('#gridvis-form [name="baseUrl"]').value = state.config.gridvis.baseUrl || '';
  $('#application-public-url').value = state.config.application?.publicUrl || '';
  $('#gridvis-form [name="username"]').value = state.config.gridvis.username || '';
  $('#gridvis-auth-enabled').checked = state.config.gridvis.authEnabled === true;
  $('#gridvis-form [name="password"]').placeholder = state.config.gridvis.passwordConfigured
    ? 'gespeichert – leer lassen zum Beibehalten'
    : 'wird nicht angezeigt';
  $('#application-public-icon-api').checked = state.config.application?.publicIconApi !== false;
  setText('#gridvis-form button[type="submit"]', 'Verbinden und Projekte laden');
  renderMqttBrokers();
  renderMqttProfiles();
  updateMqttState();
  updateTopbarGridvisStatus();
  configureConnectionStatusRefresh();
  configureLiveRefresh();
  if ($('#device-sort')) $('#device-sort').value = state.deviceSort;
  if (!state.config.gridvis.configured) {
    if (state.config.gridvis.enabled !== false) setStatus('Nicht verbunden', false);
  } else {
    loadProjects({ navigate: false, notifyEmpty: false, background: true }).catch(reportBackgroundError);
    checkVersion({ silent: true });
  }
}

function reportBackgroundError(error) {
  console.warn('Hintergrundaktualisierung fehlgeschlagen:', error);
  if (state.projects.length || state.devices.length) {
    setStatus('Cache angezeigt – GridVis-Aktualisierung fehlgeschlagen', false);
    setText('#connection-detail', 'Die zuletzt geladenen Daten werden angezeigt. Aktualisierung später erneut versuchen.');
    showToast('Cache wird angezeigt. GridVis konnte gerade nicht aktualisiert werden.', 'warning');
  } else {
    showError(error);
  }
}

function logbookFilters() {
  return {
    limit: Number($('#logbook-limit')?.value) || 500,
    level: $('#logbook-level')?.value || '',
    query: $('#logbook-search')?.value || ''
  };
}

function logbookTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '–') : date.toLocaleString('de-DE');
}

function logbookLevelLabel(level) {
  return { success: 'OK', info: 'Info', warning: 'Warnung', error: 'Fehler' }[level] || level;
}

function renderLogbook(entries = []) {
  const list = $('#logbook-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div class="logbook-empty">Keine passenden Einträge vorhanden.</div>';
    return;
  }
  list.replaceChildren(...entries.map((entry) => {
    const row = document.createElement('div');
    row.className = 'logbook-entry';
    const details = entry.details && Object.keys(entry.details).length
      ? JSON.stringify(entry.details, null, 2)
      : '';
    row.innerHTML = `<time class="logbook-time">${escapeHtml(logbookTime(entry.time))}</time><span class="logbook-level ${escapeHtml(entry.level)}">${escapeHtml(logbookLevelLabel(entry.level))}</span><div class="logbook-event"><strong>${escapeHtml(entry.event)}</strong>${details ? `<pre>${escapeHtml(details)}</pre>` : ''}</div>`;
    return row;
  }));
}

async function loadLogbook({ silent = false } = {}) {
  if (state.logbookRequestInFlight) return;
  state.logbookRequestInFlight = true;
  const filters = logbookFilters();
  const params = new URLSearchParams({ limit: String(filters.limit) });
  if (filters.level) params.set('level', filters.level);
  if (filters.query) params.set('query', filters.query);
  try {
    const result = await api(`/api/logbook?${params}`);
    renderLogbook(result.entries || []);
    setText('#logbook-status', `${result.entries?.length || 0} von ${result.total || 0} Einträgen`);
    if (!silent) showToast('Logbuch aktualisiert.', 'success');
  } finally {
    state.logbookRequestInFlight = false;
  }
}

function reportLogbookError(error) {
  console.warn('Logbuchaktualisierung fehlgeschlagen:', error);
  showToast('Logbuch konnte nicht aktualisiert werden.', 'warning');
}

async function downloadLogbook() {
  const filters = logbookFilters();
  const params = new URLSearchParams({ limit: String(filters.limit) });
  if (filters.level) params.set('level', filters.level);
  if (filters.query) params.set('query', filters.query);
  const result = await api(`/api/logbook?${params}`);
  const blob = new Blob([JSON.stringify(result.entries || [], null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gridvis2mqtt-logbuch-${new Date().toISOString().replaceAll(':', '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function clearLogbook() {
  if (typeof window.confirm === 'function' && !window.confirm('Das Logbuch wirklich leeren?')) return;
  await api('/api/logbook', { method: 'DELETE' });
  await loadLogbook({ silent: true });
}

function configureLogbookRefresh() {
  if (state.logbookRefreshTimer) clearInterval(state.logbookRefreshTimer);
  state.logbookRefreshTimer = null;
}

function configureDeviceInfoRefresh() {
  clearInterval(state.deviceInfoRefreshTimer);
  state.deviceInfoRefreshTimer = null;
  if (!state.config?.gridvis?.configured || state.currentView !== 'device-detail' || !state.currentDevice) return;
  state.deviceInfoRefreshTimer = setInterval(() => {
    const currentId = deviceId(state.currentDevice);
    loadDeviceDetails(state.currentDevice).then((updated) => {
      if (state.currentView !== 'device-detail' || !state.currentDevice || deviceId(state.currentDevice) !== currentId) return;
      state.currentDevice = updated;
      renderDeviceInfo(updated);
      if (state.infoDevice && deviceId(state.infoDevice) === currentId) {
        state.infoDevice = updated;
        renderDeviceInfoValues(updated);
      }
    }).catch(reportBackgroundError);
  }, 60 * 1000);
}

async function loadProjects({ navigate = false, notifyEmpty = true, background = false } = {}) {
  if (!state.config?.gridvis?.configured) {
    setView('settings');
    throw new Error(state.config?.gridvis?.enabled === false
      ? 'Die GridVis-Verbindung wurde manuell getrennt.'
      : 'Bitte zuerst eine GridVis-URL konfigurieren.');
  }
  const previousProject = $('#project-select')?.value || state.config.gridvis.project || '';
  if (!background) setStatus('Lade GridVis-Projekte ...', null);
  const result = await api('/api/gridvis/projects');
  state.projects = listData(result.data);
  const projectValue = (project) => String(itemValue(project, 'name', 'id', 'path'));
  const configuredProject = String(state.config?.gridvis?.project || '');
  const configuredProjectExists = state.projects.some((project) => projectValue(project) === configuredProject);
  const previousProjectExists = state.projects.some((project) => projectValue(project) === previousProject);
  const projectSelection = previousProjectExists
    ? previousProject
    : configuredProjectExists
      ? configuredProject
      : state.projects.length === 1 ? projectValue(state.projects[0]) : '';
  fillSelect($('#project-select'), state.projects, 'Projekt auswählen', projectSelection, projectValue, (project) => itemValue(project, 'name', 'label', 'id', 'path'));
  const selectedProject = $('#project-select').value;
  restoreProjectData(selectedProject);
  setStatus(state.projects.length
    ? `${state.projects.length} ${state.projects.length === 1 ? 'Projekt' : 'Projekte'} geladen`
    : 'Verbunden, keine Projekte geladen', true);
  setText('#connection-detail', state.projects.length
    ? `${state.projects.length} GridVis-Projekte geladen.`
    : 'GridVis antwortet, meldet aber keine geladenen Projekte.');
  if (selectedProject) await loadDevices({ navigate: false, background });
  if (state.currentView === 'mqtt') await loadMqttOverview({ silent: true });
  if (navigate && state.projects.length > 0) setView('devices');
  if (state.projects.length === 0 && notifyEmpty) showToast('Verbunden, aber GridVis meldet keine geladenen Projekte.', 'warning');
  writeUiCache();
}

async function refreshDevices() {
  if (!$('#project-select')?.value) {
    await loadProjects({ navigate: false });
    return;
  }
  await loadDevices();
}

async function loadDevices({ navigate = true, background = false } = {}) {
  const project = $('#project-select')?.value;
  if (!project) {
    const message = 'Bitte zuerst ein GridVis-Projekt auswählen.';
    setStatus(message);
    showToast(message, 'warning');
    return;
  }
  const previousDeviceId = state.selectedDeviceIds[project] || deviceId(state.currentDevice || {}) || $('#device-select')?.value || '';
  if (!background) setStatus('Lade Geräte ...', null);
  const result = await api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices`);
  state.devices = listData(result.data);
  state.deviceCache[project] = state.devices;
  const nextDeviceId = state.devices.some((device) => deviceId(device) === previousDeviceId) ? previousDeviceId : '';
  state.selectedDeviceIds[project] = nextDeviceId;
  state.currentDevice = state.devices.find((device) => deviceId(device) === nextDeviceId) || null;
  renderDeviceSelect(nextDeviceId);
  updateDeviceCounters();
  renderDeviceList();
  if (state.currentView === 'device-detail' && state.currentDevice) renderDeviceInfo(state.currentDevice);
  setText('#selection-status', `${state.devices.length} Geräte gefunden`);
  setStatus(`${state.devices.length} Geräte geladen`, true);
  if (navigate) setView('devices');
  writeUiCache();
}

async function openDevice(device) {
  let resolved = typeof device === 'string' ? state.devices.find((entry) => deviceId(entry) === device) : device;
  if (!resolved) {
    showToast('Bitte zuerst ein Gerät auswählen.');
    setView('devices');
    return;
  }
  const project = $('#project-select')?.value || '';
  const id = deviceId(resolved);
  const selectionToken = state.deviceSelectionToken + 1;
  state.deviceSelectionToken = selectionToken;
  state.currentDevice = resolved;
  state.backendDeviceStateKey = '';
  state.liveVisibleRequestKey = '';
  state.historicalVisibleRequestKey = '';
  if (project) state.selectedDeviceIds[project] = id;
  if ($('#device-select')) $('#device-select').value = id;
  renderDeviceInfo(resolved);
  setView('device-detail');
  setDetailTab('info');
  updateMeasurementCounters();
  setDeviceInfoLoading(true);
  const detailRequest = loadDeviceDetails(resolved, { refresh: true, selectionToken }).catch(reportBackgroundError);
  let backendStateLoaded = false;
  try {
    await loadBackendDeviceState(project, id, selectionToken);
    backendStateLoaded = true;
  } catch (error) {
    reportBackgroundError(error);
  }
  if (!backendStateLoaded || !isCurrentDeviceRequest(selectionToken, id)) return;
  resolved = state.devices.find((entry) => deviceId(entry) === id) || resolved;
  state.currentDevice = resolved;
  restoreMeasurementCache(project, id);
  // The device card's MQTT marker is derived from the just-loaded device
  // cache. Refresh the list immediately so it does not briefly look inactive
  // while the detail view is already showing the selected values.
  renderDeviceList();
  renderDeviceInfo(resolved);
  const hasCachedValues = state.onlineValues.length > 0 || state.historicalValues.length > 0;
  if (hasCachedValues) {
    await loadValues({ navigate: false, silent: true, background: true, selectionToken });
  } else {
    await loadValues({ navigate: false, silent: true, selectionToken });
  }
  if (!isCurrentDeviceRequest(selectionToken, id)) return;
  await detailRequest;
  if (isCurrentDeviceRequest(selectionToken, id)) writeUiCache();
}

async function loadValues({ navigate = true, silent = false, background = false, selectionToken = state.deviceSelectionToken } = {}) {
  const project = $('#project-select')?.value;
  const device = selectedDevice();
  const deviceIdValue = deviceId(device);
  if (!project || !deviceIdValue) throw new Error('Bitte zuerst Projekt und Gerät auswählen.');
  state.liveVisibleRequestKey = '';
  state.historicalVisibleRequestKey = '';
  if (!silent && !background) setStatus('Lade Messpunktdefinitionen ...');
  const measurementMutationVersion = state.measurementMutationVersion;
  const previousOnlineValues = state.onlineValues;
  const previousHistoricalValues = state.historicalValues;
  const previousDisplayedMeasurements = state.displayedMeasurements;
  const displayedKeys = new Set(state.displayedMeasurements.map(measurementKey));
  const selectedKeys = new Set(state.selectedMeasurements.map(measurementKey));
  const previousHistoricalSelected = state.historicalSelectedMeasurements;
  const previousHistoricalAssignments = state.historicalMqttAssignments || {};
  const previousHistoricalActiveAssignments = state.historicalMqttActiveAssignments || {};
  const previousHistoricalRetainAssignments = state.historicalRetainAssignments || {};
  const previousHistoricalSettings = state.historicalSettings || {};
  const previousHistoricalDefaults = currentHistoricalDefaults();
  const previousHistoricalResults = state.historicalResults || {};
  const [online, historical] = await Promise.all([
    api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices/${encodeURIComponent(deviceIdValue)}/online-values`),
    api(`/api/gridvis/projects/${encodeURIComponent(project)}/devices/${encodeURIComponent(deviceIdValue)}/historical-values`)
  ]);
  if (!isCurrentDeviceRequest(selectionToken, deviceIdValue)) return;
  // The request may have started while the user changed a checkbox or a
  // profile. Its captured assignments are then stale and must never be
  // written back to the backend or used to recreate a Discovery entry.
  if (state.measurementMutationVersion !== measurementMutationVersion) return;
  state.onlineValues = listData(online.data).map((item) => normalizeMeasurement(item, 'live'));
  state.historicalValues = mergeHistoricalMeasurements(listData(historical.data)
    .map((item) => normalizeMeasurement(item, 'historical')))
    .filter(historicalMeasurementAvailable);
  const previousAssignments = state.mqttAssignments;
  const previousActiveAssignments = state.mqttActiveAssignments || {};
  const displayedCandidates = state.onlineValues.filter((item) => displayedKeys.has(measurementKey(item)) || selectedKeys.has(measurementKey(item)) || Array.isArray(previousAssignments[measurementKey(item)]));
  const displayedCandidateMap = new Map(displayedCandidates.map((item) => [measurementKey(item), item]));
  state.displayedMeasurements = previousDisplayedMeasurements
    .map((item) => displayedCandidateMap.get(measurementKey(item)))
    .filter(Boolean);
  for (const item of displayedCandidates) {
    if (!state.displayedMeasurements.some((selected) => measurementKey(selected) === measurementKey(item))) state.displayedMeasurements.push(item);
  }
  const byId = new Map();
  for (const item of state.onlineValues) byId.set(`${item.value}:${item.type}`, item);
  const previousRetainAssignments = state.mqttRetainAssignments;
  const onlineKeys = new Set(state.onlineValues.map(measurementKey));
  const previousMeasurements = new Map(previousOnlineValues.map((item) => [measurementKey(item), item]));
  const removedMeasurements = [...previousMeasurements.entries()]
    .filter(([key]) => Array.isArray(previousAssignments[key]) && previousAssignments[key].length && !onlineKeys.has(key))
    .map(([key, measurement]) => ({
      ...measurement,
      mqttProfileIds: previousAssignments[key],
      retainState: previousRetainAssignments[key] === true
    }));
  state.selectedMeasurements = [];
  state.mqttAssignments = {};
  state.mqttActiveAssignments = {};
  state.mqttRetainAssignments = {};
  state.liveResults = background ? state.liveResults : [];
  for (const item of byId.values()) {
    const key = measurementKey(item);
    if (previousRetainAssignments[key] === true) state.mqttRetainAssignments[key] = true;
    const profileIds = Array.isArray(previousAssignments[key])
      ? previousAssignments[key].filter((id) => mqttProfiles().some((profile) => profile.id === id))
      : displayedKeys.has(key) || selectedKeys.has(key) ? [defaultMqttProfileId()] : [];
    if (profileIds.length) {
      state.mqttAssignments[key] = profileIds;
      const activeProfileIds = Array.isArray(previousActiveAssignments[key])
        ? previousActiveAssignments[key].filter((id) => profileIds.includes(id))
        : selectedKeys.has(key) ? profileIds : [];
      if (activeProfileIds.length && item.online) {
        state.mqttActiveAssignments[key] = activeProfileIds;
        state.selectedMeasurements.push(item);
      }
    }
  }
  const historicalMap = new Map(state.historicalValues.map((item) => [measurementKey(item), item]));
  state.historicalSelectedMeasurements = previousHistoricalSelected
    .map((item) => historicalMap.get(measurementKey(item)))
    .filter(Boolean);
  state.historicalMqttAssignments = {};
  state.historicalMqttActiveAssignments = {};
  state.historicalRetainAssignments = {};
  state.historicalSettings = {};
  state.historicalResults = {};
  for (const item of state.historicalSelectedMeasurements) {
    const key = measurementKey(item);
    const profileIds = Array.isArray(previousHistoricalAssignments[key])
      ? previousHistoricalAssignments[key].filter((id) => mqttProfiles().some((profile) => profile.id === id))
      : [defaultMqttProfileId()];
    if (profileIds.length) state.historicalMqttAssignments[key] = profileIds;
    const activeProfileIds = Array.isArray(previousHistoricalActiveAssignments[key])
      ? previousHistoricalActiveAssignments[key].filter((id) => profileIds.includes(id))
      : profileIds;
    if (activeProfileIds.length) state.historicalMqttActiveAssignments[key] = activeProfileIds;
    if (typeof previousHistoricalRetainAssignments[key] === 'boolean') {
      state.historicalRetainAssignments[key] = previousHistoricalRetainAssignments[key];
    }
    if (previousHistoricalSettings[key]) state.historicalSettings[key] = previousHistoricalSettings[key];
    const resultPrefix = historicalResultKey(deviceIdValue, item);
    for (const [resultKey, values] of Object.entries(previousHistoricalResults)) {
      if (resultKey === resultPrefix || resultKey.startsWith(`${resultPrefix}:`)) state.historicalResults[resultKey] = values;
    }
  }
  const removedHistoricalMeasurements = [...previousHistoricalSelected]
    .filter((measurement) => !historicalMap.has(measurementKey(measurement)))
    .map((measurement) => ({
      ...measurement,
      mqttProfileIds: previousHistoricalAssignments[measurementKey(measurement)] || [],
      historyRanges: historicalSettingsFor(measurement, previousHistoricalSettings).ranges,
      retainState: previousHistoricalRetainAssignments[measurementKey(measurement)] === true
    }))
    .filter((measurement) => measurement.mqttProfileIds.length);
  updateMeasurementCounters();
  renderLiveValues();
  renderDisplayValues();
  renderHistoricalValues();
  renderHistoricalSelection();
  configureLiveRefresh();
  configureHistoricalRefresh();
  setText('#selection-status', `${byId.size + state.historicalValues.length} Messwerte gefunden`);
  if (!silent) showToast(`${byId.size + state.historicalValues.length} Messwertdefinitionen geladen.`, 'success');
  setStatus(`${byId.size + state.historicalValues.length} Messwerte geladen`, true);
  state.measurementCache[cacheKey(project, deviceIdValue)] = {
    onlineValues: state.onlineValues,
    historicalValues: state.historicalValues,
    displayedMeasurements: state.displayedMeasurements,
    selectedMeasurements: state.selectedMeasurements,
    mqttAssignments: state.mqttAssignments,
    mqttActiveAssignments: state.mqttActiveAssignments,
    mqttRetainAssignments: state.mqttRetainAssignments,
    historicalSelectedMeasurements: state.historicalSelectedMeasurements,
    historicalMqttAssignments: state.historicalMqttAssignments,
    historicalMqttActiveAssignments: state.historicalMqttActiveAssignments,
    historicalRetainAssignments: state.historicalRetainAssignments,
    historicalSettings: state.historicalSettings,
    historicalDefaults: previousHistoricalDefaults,
    historicalResults: state.historicalResults,
    displaySettings: state.displaySettings,
    liveResults: state.liveResults
  };
  writeUiCache();
  if (removedMeasurements.length) removeMqttDiscovery(removedMeasurements).catch(reportBackgroundError);
  if (removedHistoricalMeasurements.length) removeMqttDiscovery(removedHistoricalMeasurements).catch(reportBackgroundError);
  if (navigate) {
    setView('device-detail');
    setDetailTab('live');
  }
}

async function publishMqttValues(targets, { force = false } = {}) {
  if (!force && Date.now() < state.mqttStateReadyAt) return;
  const activeTargets = targets
    .map((target) => ({
      ...target,
      measurements: target.measurements.filter((measurement) => measurementMqttActive(measurement))
    }))
    .filter((target) => target.measurements.length);
  if (!activeTargets.length) return;
  const results = liveResultList(state.liveResults);
  const payloadTargets = activeTargets.map((target) => ({
    ...target,
    measurements: target.measurements.map((measurement) => {
      const result = results.find((entry) => liveResultMatches(entry, measurement, target.deviceId));
      return {
        ...measurement,
        liveValue: result ? liveResultValue(result, measurement) : '',
        liveTime: result ? itemValue(result, 'time', 'timestamp') : '',
        mqttProfileIds: measurementProfileIds(measurement)
      };
    }).filter((measurement) => measurement.liveValue !== '')
  })).filter((target) => target.measurements.length);
  if (!payloadTargets.length) return;
  const pendingKeys = payloadTargets.flatMap((target) => target.measurements.map((measurement) => (
    `${target.deviceId}:${measurement.value}:${measurement.type}`
  )));
  pendingKeys.forEach((key) => state.livePublishPendingKeys.add(key));
  try {
    await api('/api/mqtt/publish-values', {
      method: 'POST',
      body: JSON.stringify(discoveryInput({ targets: payloadTargets }))
    });
  } finally {
    pendingKeys.forEach((key) => state.livePublishPendingKeys.delete(key));
  }
}

async function loadLiveData({ silent = false, publishMqtt = false, force = false, cacheOnly = false, targets = liveTargetsForFocus(), requestedAt = Date.now() } = {}) {
  const project = $('#project-select')?.value;
  if (!project || !targets.length) throw new Error('Bitte zuerst Live-Messwerte für ein Gerät auswählen.');
  if (state.liveRequestInFlight) {
    await waitForLiveRequestIdle();
    const nextTargets = liveTargetsForCurrentFocus();
    if (!nextTargets.length) return;
    return loadLiveData({
      silent,
      publishMqtt,
      force,
      cacheOnly,
      targets: nextTargets,
      requestedAt: Date.now()
    });
  }
  if (!liveTargetsStillFocused(targets)) return;
  state.liveRequestInFlight = true;
  if (!cacheOnly) {
    for (const target of targets) state.liveLastRequestedAt[target.deviceId] = requestedAt;
  }
  const query = new URLSearchParams({ project });
  try {
    const requestedValues = new Map();
    for (const target of targets) {
      for (const measurement of target.measurements) {
        const valueKey = `${target.deviceId}:${measurement.value}`;
        if (!requestedValues.has(valueKey)) requestedValues.set(valueKey, { deviceId: target.deviceId, value: measurement.value, types: new Set() });
        requestedValues.get(valueKey).types.add(measurement.type);
      }
    }
    const requestedEntries = [...requestedValues.values()].flatMap(({ deviceId: targetDeviceId, value, types }) =>
      [...types].map((type) => ({ deviceId: targetDeviceId, value, type })));
    const cacheQuery = new URLSearchParams({ project });
    for (const entry of requestedEntries) cacheQuery.append('value', `${entry.deviceId};${entry.value};${entry.type}`);

    // MQTT-active values are produced by the backend scheduler. Read the
    // backend cache first so the UI shows the exact value that MQTT received.
    // Only values that are not cached (typically display-only values) fall
    // back to a direct browser-triggered GridVis request.
    let cachedResults = [];
    try {
      const cached = await api(`/api/gridvis/live-cache?${cacheQuery}`);
      cachedResults = liveResultList(cached.data);
    } catch (error) {
      console.warn('Backend-Live-Cache konnte nicht gelesen werden:', error);
    }
    if (force) {
      cachedResults = [];
    } else {
      const mqttCachedKeys = new Set(targets.flatMap((target) => target.measurements
        .filter((measurement) => isLoadedDeviceState(project, target.deviceId)
          ? measurementMqttActive(measurement)
          : measurement.mqttActiveProfileIds?.length > 0)
        .map((measurement) => `${target.deviceId}:${measurement.value}:${measurement.type}`)));
      cachedResults = cachedResults.filter((result) => mqttCachedKeys.has(liveResultKey(result)));
      // A manual live refresh has already put the fresh value into the UI,
      // but MQTT may still be publishing it. Do not let the cache poller
      // briefly replace it with the previous backend cache value.
      if (cacheOnly) cachedResults = cachedResults.filter((result) => !state.livePublishPendingKeys.has(liveResultKey(result)));
    }
    const missingEntries = cacheOnly
      ? []
      : force
      ? requestedEntries
      : requestedEntries.filter((entry) => {
        const measurement = { value: entry.value, type: entry.type };
        return !cachedResults.some((result) => liveResultMatches(result, measurement, entry.deviceId));
      });
    let fetchedResults = [];
    if (missingEntries.length) {
      for (const entry of missingEntries) query.append('value', `${entry.deviceId};${entry.value};${entry.type}`);
      query.set('timeout', '500');
      if (!silent) setStatus('Frage Live-Werte ab ...');
      const result = await api(`/api/gridvis/online?${query}`);
      fetchedResults = liveResultList(result.data);
    }
    if (!liveTargetsStillFocused(targets)) return;
    const freshResults = [...cachedResults, ...fetchedResults];
    const requestedKeys = new Set(requestedEntries.map((entry) => `${entry.deviceId}:${entry.value}:${entry.type}`));
    const currentTargets = targets.filter((target) => isLoadedDeviceState(project, target.deviceId));
    if (currentTargets.length) {
      const freshKeys = new Set(freshResults.map((entry) => liveResultKey(entry)));
      state.liveResults = cacheOnly
        ? [
          ...state.liveResults.filter((entry) => !freshKeys.has(liveResultKey(entry))),
          ...freshResults
        ]
        : [
          ...state.liveResults.filter((entry) => !requestedKeys.has(liveResultKey(entry))),
          ...freshResults
        ];
      updateLiveCardValues();
    }
    const fetchedAt = Date.now();
    if (!cacheOnly) {
      for (const target of targets) state.liveLastFetchedAt[target.deviceId] = fetchedAt;
    }
    for (const target of targets) {
      const projectDevice = cacheKey(project, target.deviceId);
      const cache = state.measurementCache[projectDevice];
      if (!cache) continue;
      if (isLoadedDeviceState(project, target.deviceId)) {
        cache.liveResults = state.liveResults;
        continue;
      }
      const targetResults = freshResults.filter((result) => target.measurements.some((measurement) => (
        liveResultMatches(result, measurement, target.deviceId)
      )));
      const previousResults = liveResultList(cache.liveResults || []);
      const targetResultKeys = new Set(targetResults.map((result) => liveResultKey(result)));
      cache.liveResults = cacheOnly
        ? [
          ...previousResults.filter((result) => !targetResultKeys.has(liveResultKey(result))),
          ...targetResults
        ]
        : [
          ...previousResults.filter((result) => !target.measurements.some((measurement) => (
            liveResultMatches(result, measurement, target.deviceId)
          ))),
          ...targetResults
        ];
    }
    // Live results are display data only. Persisting this browser request
    // here could enqueue an old UI snapshot behind a newer MQTT selection.
    const infoDialog = $('#device-info-dialog');
    if (infoDialog?.open && state.infoDevice) renderDeviceInfoValues(state.infoDevice);
    // A slow MQTT broker must not hold the live-request lock and thereby
    // delay the configured GridVis polling cycle.
    state.liveRequestInFlight = false;
    if (publishMqtt && !cacheOnly) {
      try {
        await publishMqttValues(targets, { force: publishMqtt });
      } catch (error) {
        if (!silent) showError(error);
        else showToast(`MQTT-Wert konnte nicht veröffentlicht werden: ${error.message}`, 'warning');
      }
    }
    if (!cacheOnly) {
      setStatus('Live-Werte aktualisiert', true);
      if (!silent) showToast('Live-Werte wurden aktualisiert.', 'success');
    }
  } finally {
    state.liveRequestInFlight = false;
  }
}

function addMqttBroker() {
  if (!state.config?.mqtt) return;
  if (!Array.isArray(state.config.mqtt.brokers)) state.config.mqtt.brokers = [];
  state.config.mqtt.brokers.push({
    id: 'broker-' + Date.now(),
    name: `MQTT-Broker ${state.config.mqtt.brokers.length + 1}`,
    url: '',
    clientId: 'gridvis2mqtt',
    username: '',
    passwordConfigured: false,
    enabled: true
  });
  renderMqttBrokers();
  renderMqttProfiles();
}

function mqttBrokerStatus(broker) {
  const runtime = state.config?.mqtt?.connection?.brokers?.find((entry) => entry.id === broker.id);
  if (broker.enabled === false) return { label: 'manuell getrennt', className: 'error', title: 'Der Broker wurde manuell getrennt.' };
  if (runtime?.connected) return { label: 'verbunden', className: 'success', title: 'Der Broker ist aktuell verbunden.' };
  if (runtime?.status === 'connecting') return { label: 'verbinde ...', className: 'pending', title: 'Die Broker-Verbindung wird aufgebaut.' };
  if (runtime?.status === 'reconnecting') return { label: 'verbinde erneut ...', className: 'pending', title: 'Die Broker-Verbindung wird wieder aufgebaut.' };
  if (runtime?.status === 'error') return { label: 'Fehler', className: 'error', title: runtime.lastError || 'Die Broker-Verbindung ist fehlgeschlagen.' };
  if (runtime?.status === 'disconnected') return { label: 'getrennt', className: 'error', title: 'Der Broker ist aktuell nicht verbunden.' };
  const tested = state.mqttTestStatus?.[broker.id];
  if (tested) return tested;
  return { label: 'nicht geprüft', className: '', title: 'Noch kein Verbindungstest für diesen Broker.' };
}

async function refreshMqttConnectionState() {
  const result = await api('/api/config');
  state.config = result.config;
  renderMqttBrokers();
  updateMqttState();
  configureLiveRefresh();
  configureHistoricalRefresh();
  return result.config?.mqtt?.connection || {};
}

async function pollMqttBrokerConnection(brokerId, shouldBeConnected) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const connection = await refreshMqttConnectionState();
    const runtime = connection.brokers?.find((entry) => entry.id === brokerId);
    if (shouldBeConnected && runtime?.connected) return;
    if (!shouldBeConnected && !runtime) return;
    if (!shouldBeConnected && runtime?.status === 'disconnected') return;
    if (runtime?.status === 'error') return;
  }
}

function renderMqttBrokers() {
  const list = $('#mqtt-brokers-list');
  if (!list) return;
  const brokers = state.config?.mqtt?.brokers?.length
    ? state.config.mqtt.brokers
    : [{ id: 'default', name: 'Hauptbroker', url: '', clientId: 'gridvis2mqtt', username: '', passwordConfigured: false, enabled: true }];
  if (!state.config?.mqtt?.brokers?.length) state.config.mqtt.brokers = brokers;

  list.replaceChildren(...brokers.map((broker, index) => {
    const card = document.createElement('article');
    card.className = 'mqtt-broker-card';
    card.dataset.brokerId = broker.id;
    const enabled = broker.enabled !== false;
    const statusInfo = mqttBrokerStatus(broker);
    card.innerHTML = `<div class="mqtt-profile-card-header"><div><strong>${escapeHtml(broker.name || `MQTT-Broker ${index + 1}`)}</strong><small>${index === 0 ? 'Primärer Broker' : 'Zusätzlicher Broker'}</small></div><div class="mqtt-broker-actions"><span class="connection-test-status ${statusInfo.className}" title="${escapeHtml(statusInfo.title)}" data-broker-status>${escapeHtml(statusInfo.label)}</span><button class="button button-quiet" type="button" data-broker-action="test">Verbindung testen</button><button class="button button-quiet" type="button" data-broker-action="${enabled ? 'disconnect' : 'connect'}">${enabled ? 'Trennen' : 'Verbinden'}</button><button class="button button-quiet" type="button" data-broker-action="delete"${brokers.length <= 1 ? ' disabled' : ''}>Entfernen</button></div></div><div class="mqtt-profile-fields"><label class="field"><span>Brokername</span><input data-broker-field="name" type="text" value="${escapeHtml(broker.name || '')}"></label><label class="field"><span>Broker-URL</span><input data-broker-field="url" type="url" placeholder="mqtt://localhost:1883" value="${escapeHtml(broker.url || '')}"></label><label class="field"><span>Client-ID</span><input data-broker-field="clientId" type="text" autocomplete="off" placeholder="gridvis2mqtt" value="${escapeHtml(broker.clientId || 'gridvis2mqtt')}"></label><label class="field"><span>Benutzername</span><input data-broker-field="username" type="text" autocomplete="username" value="${escapeHtml(broker.username || '')}"></label><label class="field"><span>Passwort</span><input data-broker-field="password" type="password" autocomplete="current-password" placeholder="${broker.passwordConfigured ? 'gespeichert – leer lassen zum Beibehalten' : 'wird nicht angezeigt'}"></label></div>`;
    const connectionActions = document.createElement('div');
    connectionActions.className = 'panel-actions mqtt-broker-connection-actions';
    const testButton = card.querySelector('[data-broker-action="test"]');
    const connectionButton = card.querySelector('[data-broker-action="connect"], [data-broker-action="disconnect"]');
    if (testButton && connectionButton) {
      testButton.remove();
      connectionButton.remove();
      connectionActions.append(testButton, connectionButton);
      card.append(connectionActions);
    }
    card.querySelector('[data-broker-action="test"]').addEventListener('click', () => testMqttBroker(card).catch(showError));
    card.querySelector('[data-broker-action="connect"], [data-broker-action="disconnect"]')
      .addEventListener('click', () => toggleMqttBroker(card).catch(showError));
    card.querySelector('[data-broker-action="delete"]').addEventListener('click', () => {
      if (brokers.length <= 1) return;
      state.config.mqtt.brokers = state.config.mqtt.brokers.filter((entry) => entry.id !== broker.id);
      const firstBrokerId = state.config.mqtt.brokers[0]?.id;
      for (const profile of state.config.mqtt.profiles || []) {
        if (profile.brokerId === broker.id) profile.brokerId = firstBrokerId;
      }
      renderMqttBrokers();
      renderMqttProfiles();
    });
    return card;
  }));
}

async function toggleMqttBroker(card) {
  const broker = state.config?.mqtt?.brokers?.find((entry) => entry.id === card.dataset.brokerId);
  if (!broker) return;
  // Persist a selection changed immediately before opening the connection.
  // Otherwise the MQTT connect event can run before /api/state has committed
  // the current device's active measurements.
  await flushUiState();
  const enabled = broker.enabled !== false;
  const button = card.querySelector('[data-broker-action="connect"], [data-broker-action="disconnect"]');
  if (button) {
    button.disabled = true;
    button.textContent = enabled ? 'Trenne ...' : 'Verbinde ...';
  }
  const result = await api(`/api/mqtt/${enabled ? 'disconnect' : 'connect'}`, {
    method: 'POST',
    body: JSON.stringify({ brokerId: broker.id })
  });
  state.config = result.config;
  delete state.mqttTestStatus[broker.id];
  renderMqttBrokers();
  renderMqttProfiles();
  updateMqttState();
  configureLiveRefresh();
  configureHistoricalRefresh();
  showToast(enabled ? 'MQTT-Broker wurde getrennt.' : 'MQTT-Broker wird verbunden.', 'success');
  if (!enabled) pollMqttBrokerConnection(broker.id, true).catch((error) => console.warn('MQTT-Status konnte nicht aktualisiert werden:', error));
}

function readMqttBrokers() {
  return $$('.mqtt-broker-card').map((card) => {
    const field = (name) => card.querySelector('[data-broker-field="' + name + '"]');
    const configured = state.config?.mqtt?.brokers?.find((entry) => entry.id === card.dataset.brokerId);
    return {
      id: card.dataset.brokerId,
      name: field('name')?.value.trim() || card.dataset.brokerId,
      url: field('url')?.value.trim() || '',
      clientId: field('clientId')?.value.trim() || 'gridvis2mqtt',
      username: field('username')?.value.trim() || '',
      password: field('password')?.value || '',
      enabled: configured?.enabled !== false
    };
  });
}

async function testMqttBroker(card) {
  const field = (name) => card.querySelector('[data-broker-field="' + name + '"]');
  const button = card.querySelector('[data-broker-action="test"]');
  const status = card.querySelector('[data-broker-status]');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Teste ...';
  try {
    await api('/api/mqtt/test', {
      method: 'POST',
      body: JSON.stringify({
        brokerId: card.dataset.brokerId,
        url: field('url')?.value.trim() || '',
        clientId: field('clientId')?.value.trim() || 'gridvis2mqtt',
        username: field('username')?.value.trim() || '',
        password: field('password')?.value || ''
      })
    });
    state.mqttTestStatus[card.dataset.brokerId] = {
      label: 'verbunden',
      className: 'success',
      title: 'Der letzte Verbindungstest war erfolgreich.'
    };
    if (status) {
      status.textContent = 'verbunden';
      status.title = 'Der letzte Verbindungstest war erfolgreich.';
      status.classList.remove('error');
      status.classList.add('success');
    }
    showToast('MQTT-Broker ist erreichbar.', 'success');
  } catch (error) {
    state.mqttTestStatus[card.dataset.brokerId] = {
      label: 'Fehler',
      className: 'error',
      title: error.message
    };
    if (status) {
      status.textContent = 'Fehler';
      status.title = error.message;
      status.classList.remove('success');
      status.classList.add('error');
    }
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function addMqttProfile() {
  if (!state.config?.mqtt) return;
  if (!Array.isArray(state.config.mqtt.profiles)) state.config.mqtt.profiles = mqttProfiles().map((profile) => ({ ...profile }));
  const id = 'profile-' + Date.now();
  state.config.mqtt.profiles.push({
    id,
    name: 'Neues MQTT-Profil',
    mode: 'homeassistant',
    brokerId: state.config.mqtt.brokers?.[0]?.id || 'default',
    enabled: true,
    isDefault: false,
    discoveryPrefix: 'homeassistant',
    component: 'sensor',
    topicPrefix: state.config.mqtt.topicPrefix || 'gridvis2mqtt',
    stateTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/state',
    availabilityTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/availability',
    discoveryTopicTemplate: '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config'
  });
  renderMqttProfiles();
}

function renderMqttProfiles() {
  const list = $('#mqtt-profiles-list');
  if (!list) return;
  const brokers = state.config?.mqtt?.brokers?.length
    ? state.config.mqtt.brokers
    : [{ id: 'default', name: 'Hauptbroker' }];
  const profiles = mqttProfiles();
  list.replaceChildren(...profiles.map((profile) => {
    const card = document.createElement('article');
    card.className = 'mqtt-profile-card';
    card.dataset.profileId = profile.id;
    const brokerOptions = brokers.map((broker) => '<option value="' + escapeHtml(broker.id) + '"' + (broker.id === profile.brokerId ? ' selected' : '') + '>' + escapeHtml(broker.name) + '</option>').join('');
    card.innerHTML = '<div class="mqtt-profile-card-header"><div><strong>' + escapeHtml(profile.name) + '</strong><small>' + escapeHtml(profile.mode) + '</small></div><button class="button button-quiet" type="button" data-profile-action="delete">Entfernen</button></div><div class="mqtt-profile-section"><span class="mqtt-profile-section-title">Zuordnung</span><div class="mqtt-profile-fields"><label class="field"><span>Profilname</span><input data-profile-field="name" type="text" value="' + escapeHtml(profile.name) + '"></label><label class="field"><span>Discovery-Modus</span><select data-profile-field="mode"><option value="homeassistant">Home Assistant</option></select></label><label class="field"><span>Broker</span><select data-profile-field="brokerId">' + brokerOptions + '</select></label></div></div><div class="mqtt-profile-section"><span class="mqtt-profile-section-title">Namespaces</span><div class="mqtt-profile-fields"><label class="field"><span>Discovery-Prefix</span><input data-profile-field="discoveryPrefix" type="text" value="' + escapeHtml(profile.discoveryPrefix || 'homeassistant') + '"></label><label class="field"><span>State-/Veröffentlichungs-Prefix</span><input data-profile-field="topicPrefix" type="text" value="' + escapeHtml(profile.topicPrefix || 'gridvis2mqtt') + '"></label></div></div><div class="mqtt-profile-section"><span class="mqtt-profile-section-title">Topic-Vorlagen</span><div class="mqtt-profile-fields"><label class="field field-wide"><span>State-Topic-Vorlage</span><input data-profile-field="stateTopicTemplate" type="text" value="' + escapeHtml(profile.stateTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/state') + '"></label><label class="field field-wide"><span>Availability-Topic-Vorlage</span><input data-profile-field="availabilityTopicTemplate" type="text" value="' + escapeHtml(profile.availabilityTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/availability') + '"></label><label class="field field-wide"><span>Discovery-Topic-Vorlage</span><input data-profile-field="discoveryTopicTemplate" type="text" value="' + escapeHtml(profile.discoveryTopicTemplate || '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config') + '"></label></div></div><div class="mqtt-profile-section mqtt-profile-options"><label class="profile-default-field"><input data-profile-field="enabled" type="checkbox"' + (profile.enabled !== false ? ' checked' : '') + '> Profil aktiv</label><label class="profile-default-field"><input data-profile-field="isDefault" type="checkbox"' + (profile.id === defaultMqttProfileId() ? ' checked' : '') + '> Standardprofil für neue Zuordnungen</label></div>';
    card.querySelector('[data-profile-field="mode"]').value = profile.mode || 'homeassistant';
    card.querySelector('[data-profile-action="delete"]').disabled = profiles.length <= 1;
    card.querySelector('[data-profile-action="delete"]').addEventListener('click', () => {
      if (profiles.length <= 1) return;
      state.config.mqtt.profiles = mqttProfiles().filter((entry) => entry.id !== profile.id);
      if (state.config.mqtt.defaultProfileId === profile.id) state.config.mqtt.defaultProfileId = state.config.mqtt.profiles[0].id;
      renderMqttProfiles();
      renderLiveValues();
      renderDisplayValues();
    });
    return card;
  }));
}

function readMqttProfiles() {
  const cards = $$('.mqtt-profile-card');
  const profiles = cards.map((card) => {
    const field = (name) => card.querySelector('[data-profile-field="' + name + '"]');
    return {
      id: card.dataset.profileId,
      name: field('name')?.value.trim() || card.dataset.profileId,
      mode: field('mode')?.value || 'homeassistant',
      brokerId: field('brokerId')?.value || 'default',
      discoveryPrefix: field('discoveryPrefix')?.value.trim() || 'homeassistant',
      component: state.config?.mqtt?.profiles?.find((profile) => profile.id === card.dataset.profileId)?.component || 'sensor',
      topicPrefix: field('topicPrefix')?.value.trim() || 'gridvis2mqtt',
      stateTopicTemplate: field('stateTopicTemplate')?.value.trim() || '{topicPrefix}/{project}/{deviceId}/{valueType}/state',
      availabilityTopicTemplate: field('availabilityTopicTemplate')?.value.trim() || '{topicPrefix}/{project}/{deviceId}/{valueType}/availability',
      discoveryTopicTemplate: field('discoveryTopicTemplate')?.value.trim() || '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config',
      enabled: Boolean(field('enabled')?.checked),
      isDefault: Boolean(field('isDefault')?.checked)
    };
  });
  if (profiles.length && !profiles.some((profile) => profile.isDefault)) profiles[0].isDefault = true;
  const defaultProfile = profiles.find((profile) => profile.isDefault);
  for (const profile of profiles) profile.isDefault = profile.id === defaultProfile?.id;
  return profiles;
}

function connectionPayload({ enableGridvis = false } = {}) {
  const form = new FormData($('#gridvis-form'));
  const brokers = readMqttBrokers();
  const profiles = readMqttProfiles();
  const defaultProfile = profiles.find((profile) => profile.isDefault) || profiles[0];
  const primaryBroker = brokers[0] || { id: 'default', name: 'Hauptbroker', url: '', clientId: 'gridvis2mqtt', username: '', password: '' };
  return {
    gridvis: {
      baseUrl: form.get('baseUrl'),
      username: form.get('username'),
      password: form.get('password'),
      authEnabled: $('#gridvis-auth-enabled')?.checked === true,
      project: $('#project-select').value,
      enabled: enableGridvis || state.config?.gridvis?.enabled !== false
    },
    mqtt: {
      url: primaryBroker.url,
      username: primaryBroker.username,
      password: primaryBroker.password,
      topicPrefix: defaultProfile?.topicPrefix || 'gridvis2mqtt',
      brokers,
      profiles,
      defaultProfileId: defaultProfile?.id || 'homeassistant'
    },
    discovery: {
      enabled: defaultProfile?.enabled !== false,
      mode: defaultProfile?.mode || 'homeassistant'
    }
  };
}

function saveConnections({ reloadGridvis = true, connectGridvis = reloadGridvis } = {}) {
  const config = connectionPayload({ enableGridvis: connectGridvis });
  return api('/api/config', { method: 'PUT', body: JSON.stringify(config) }).then(async (result) => {
    state.config = result.config;
    updateGridvisConnectionControl();
    renderMqttProfiles();
    renderMqttBrokers();
    updateMqttState();
    configureLiveRefresh();
    configureHistoricalRefresh();
    publishConfiguredDiscovery().catch(reportBackgroundError);
    if (reloadGridvis) {
      await loadProjects({ navigate: false });
      await checkVersion({ silent: true });
      showToast(state.projects.length
        ? 'Verbindungen gespeichert. Projekte wurden geladen.'
        : 'Verbindungen gespeichert, aber GridVis meldet keine geladenen Projekte.', 'success');
    } else {
      showToast('MQTT- und Profil-Einstellungen gespeichert.', 'success');
    }
  });
}

function saveApplicationUrl() {
  const input = $('#application-public-url');
  const iconApi = $('#application-public-icon-api');
  const button = $('#application-form button[type="submit"]');
  const originalLabel = button?.textContent || 'URL speichern';
  if (button) {
    button.disabled = true;
    button.textContent = 'Speichere ...';
  }
  return api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ application: {
      publicUrl: input?.value.trim() || '',
      publicIconApi: iconApi?.checked === true
    } })
  }).then((result) => {
    state.config = result.config;
    if (input) input.value = state.config.application?.publicUrl || '';
    if (iconApi) iconApi.checked = state.config.application?.publicIconApi !== false;
    showToast('Öffentliche URL und Icon-Freigabe gespeichert.', 'success');
  }).finally(() => {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
}

function saveConnection() {
  return saveConnections({ reloadGridvis: true, connectGridvis: true });
}

function discoveryInput({ measurements = state.displayedMeasurements, targets = null } = {}) {
  const requestMeasurements = targets
    ? targets.flatMap((target) => target.measurements.map((measurement) => ({ ...measurement, device: target.device })))
    : measurements;
  const project = $('#project-select')?.value || '';
  const defaultProfile = mqttProfiles().find((profile) => profile.id === defaultMqttProfileId());
  const enabledProfileIds = new Set(requestMeasurements.flatMap((measurement) => measurementProfileIds(measurement)));
  const hasEnabledProfile = mqttProfiles().some((profile) => enabledProfileIds.has(profile.id) && profile.enabled !== false);
  return {
    project,
    device: selectedDevice(),
    profileId: defaultMqttProfileId(),
    measurements: requestMeasurements.map((measurement) => {
      const device = measurement.device || selectedDevice();
      const historical = isHistoricalMeasurement(measurement);
      const configuredRanges = Array.isArray(measurement.historyRanges) && measurement.historyRanges.length
        ? measurement.historyRanges
        : historical
          ? historicalDiscoveryRanges(measurement, { project, deviceId: deviceId(device) })
          : undefined;
      return {
        ...measurement,
        ...(historical ? {
          historical: true,
          historyRanges: configuredRanges
        } : {
          historical: false,
          historyRange: undefined,
          historyRanges: undefined
        }),
        displaySettings: measurement.displaySettings && typeof measurement.displaySettings === 'object'
          ? measurement.displaySettings
          : measurementDisplaySettings(measurement, deviceId(device)),
        mqttProfileIds: measurement.mqttProfileIds || measurementProfileIds(measurement),
        retainState: measurementRetainState(measurement),
        ...(measurement.availabilityValue === 'offline' ? { availabilityValue: 'offline' } : {})
      };
    }),
    discovery: {
      enabled: hasEnabledProfile || (requestMeasurements.length === 0 && defaultProfile?.enabled !== false),
      mode: defaultProfile?.mode || 'homeassistant'
    }
  };
}

async function previewDiscovery() {
  const result = await api('/api/discovery/preview', { method: 'POST', body: JSON.stringify(discoveryInput()) });
  $('#discovery-preview').textContent = result.enabled === false
    ? 'Discovery ist deaktiviert.'
    : `Modus: ${result.mode}\nPrefix: ${result.prefix}\n\n${JSON.stringify(result.messages, null, 2)}`;
}

async function publishDiscovery() {
  const result = await api('/api/discovery/publish', { method: 'POST', body: JSON.stringify(discoveryInput()) });
  $('#discovery-preview').textContent = result.enabled === false
    ? 'Discovery ist deaktiviert.'
    : `Veröffentlicht: ${result.published} Discovery-Nachrichten\nPrefix: ${result.prefix}\n\n${JSON.stringify(result.messages, null, 2)}`;
}

function drawChart(data) {
  const canvas = $('#history-chart');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const values = listData(data).flatMap((item) => ['avg', 'value', 'max', 'min'].map((key) => Number(item?.[key])).filter((value) => Number.isFinite(value)));
  if (!values.length) return;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
  context.strokeStyle = '#257897'; context.lineWidth = 3; context.lineJoin = 'round'; context.lineCap = 'round'; context.beginPath();
  values.forEach((value, index) => {
    const x = 18 + index * ((canvas.width - 36) / Math.max(1, values.length - 1));
    const y = canvas.height - 25 - ((value - min) / span) * (canvas.height - 50);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

async function loadHistory(event) {
  event.preventDefault();
  const selected = state.historicalValues.find((item) => measurementKey(item) === $('#history-value').value);
  if (!selected) throw new Error('Bitte zuerst einen historischen Messwert auswählen.');
  if (measurementMqttActive(selected)) {
    const project = $('#project-select').value;
    const currentId = deviceId(selectedDevice());
    await refreshBackendHistoricalResults(project, currentId);
    const range = historicalSettingsFor(selected).ranges[0];
    const rows = historicalResultList(selected, currentId, range);
    setText('#history-count', `${rows.length} Werte aus dem Backend-Cache`);
    setText('#history-chart-title', selected.name);
    $('#history-output').textContent = JSON.stringify(rows, null, 2);
    drawChart(rows);
    setStatus(rows.length ? 'Historische Daten aus dem Backend-Cache geladen' : 'Noch kein Backend-Wert vorhanden', Boolean(rows.length));
    return;
  }
  const query = new URLSearchParams({ project: $('#project-select').value, deviceId: deviceId(selectedDevice()), value: selected.value, type: selected.type });
  const start = gridVisTime($('#history-start-expression')?.value || $('#history-start').value);
  const end = gridVisTime($('#history-end-expression')?.value || $('#history-end').value);
  if (start) query.set('start', start);
  if (end) query.set('end', end);
  setStatus('Lade historische Daten ...');
  const result = await api(`/api/gridvis/history?${query}`);
  const rows = listData(result.data);
  setText('#history-count', `${rows.length} Werte`);
  setText('#history-chart-title', selected.name);
  $('#history-output').textContent = JSON.stringify(result.data, null, 2);
  drawChart(result.data);
  setStatus(`${rows.length} historische Werte geladen`, true);
}

function historicalRowsTimestamp(row) {
  const value = itemValue(row, 'time', 'timestamp', 'date', 'datetime', 'endTime', 'startTime', 'start', 'from');
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e14 ? value / 1e6 : value > 1e11 ? value : value * 1000;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function historicalDataRows(data, { energy = false } = {}) {
  const valueKeys = energy
    // The current /histenergy response stores interval readings in
    // values[].value. Keep that field so the UI can sum the same data that
    // the backend publishes to MQTT.
    ? ['energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'value']
    : ['energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'total', 'avg', 'value', 'reading', 'measuredValue', 'measurementValue', 'actualValue', 'sum'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (valueKeys.some((key) => data[key] !== undefined)) return [data];
    for (const key of ['data', 'result', 'response', 'payload']) {
      if (data[key] && typeof data[key] === 'object') {
        const nested = historicalDataRows(data[key], { energy });
        if (nested.length) return nested;
      }
    }
  }
  const rows = listData(data);
  return energy
    ? rows.filter((row) => row && typeof row === 'object' && valueKeys.some((key) => row[key] !== undefined))
    : rows;
}

async function publishHistoricalMqttValues(targets, { force = false } = {}) {
  if (!force && Date.now() < state.mqttStateReadyAt) return;
  const payloadTargets = targets.map((target) => {
    const project = target.project || $('#project-select')?.value || '';
    const currentTarget = isLoadedDeviceState(project, target.deviceId);
    const measurements = target.measurements.filter((measurement) => currentTarget
      ? measurementMqttActive(measurement)
      : measurement.mqttActiveProfileIds?.length > 0).flatMap((measurement) => {
      const cache = state.measurementCache[cacheKey(project, target.deviceId)] || {};
      const resultMap = isLoadedDeviceState(project, target.deviceId)
        ? state.historicalResults
        : cache.historicalResults || {};
      const ranges = Array.isArray(measurement.historyRanges) && measurement.historyRanges.length
        ? measurement.historyRanges
        : historicalDiscoveryRanges(measurement, target);
      return ranges.map((range) => {
        const storedRows = resultMap[historicalResultKey(target.deviceId, measurement, range)]
          || resultMap[historicalResultKey(target.deviceId, measurement)];
        const rows = Array.isArray(storedRows) ? storedRows : Array.isArray(storedRows?.rows) ? storedRows.rows : [];
        const row = rows.at(-1);
        const value = historicalValueForRows(rows, measurement);
        return {
          ...measurement,
          historyRange: range,
          historyRanges: undefined,
          liveValue: value,
          liveTime: row ? itemValue(row, 'time', 'timestamp', 'date', 'datetime', 'endTime', 'startTime') : '',
          mqttProfileIds: measurement.mqttProfileIds || measurementProfileIds(measurement)
        };
      });
    }).filter((measurement) => measurement.liveValue !== '');
    return { ...target, measurements };
  }).filter((target) => target.measurements.length);
  if (!payloadTargets.length) return;
  await api('/api/mqtt/publish-values', {
    method: 'POST',
    body: JSON.stringify(discoveryInput({ targets: payloadTargets }))
  });
}

async function loadHistoricalData({ silent = false, scheduled = false, publishMqtt = true, retryDisplayAfterInFlight = false, targets = historicalTargetsForProject(), rangesOverride = null } = {}) {
  const project = $('#project-select')?.value;
  if (!project || !targets.length) return;
  if (state.historicalRequestInFlight) {
    await waitForHistoricalRequestIdle();
    // A manual MQTT refresh must continue after the display-only request has
    // finished. A visible-list refresh also continues, because its ranges may
    // have changed while the previous request was still running. Scheduled
    // display refreshes may still stop here and wait for their next timer.
    if (!publishMqtt && !retryDisplayAfterInFlight) return;
  }
  const measurementMutationVersion = state.measurementMutationVersion;
  state.historicalRequestInFlight = true;
  const requestedAt = Date.now();
  try {
    const currentId = deviceId(state.currentDevice || {});
    const currentDeviceId = isLoadedDeviceState(project, currentId) ? currentId : '';
    const hasActiveHistoryTarget = targets.some((target) => (
      String(target.deviceId) === String(currentDeviceId)
      && target.measurements.some((measurement) => measurementMqttActive(measurement))
    ));
    if (currentDeviceId && hasActiveHistoryTarget) {
      // The manual button explicitly refreshes the active history jobs for
      // this device. The backend performs the GridVis queue and publishes the
      // matching MQTT values; the browser then reads the authoritative cache.
      if (publishMqtt || retryDisplayAfterInFlight) {
        // The button can be pressed directly after changing a checkbox. Make
        // sure the backend queue sees the new active assignments and the
        // current standard ranges before the cache is read.
        await flushUiState();
        if (publishMqtt) {
          await api('/api/mqtt/refresh-history', {
            method: 'POST',
            body: JSON.stringify({ project, deviceId: currentDeviceId })
          });
        }
      }
      await refreshBackendHistoricalResults(project, currentDeviceId);
      renderHistoricalValues();
      renderHistoricalSelection();
    }
    const requests = [];
    for (const target of targets) {
      for (const measurement of target.measurements) {
        // MQTT-active historical measurements are fetched and published by
        // the backend queue. The browser only renders its backend cache.
        if (measurementMqttActive(measurement)) continue;
        const settings = historicalSettingsForTarget(measurement, target);
        const resultKey = `${target.deviceId}:${measurementKey(measurement)}`;
        if (scheduled && state.historicalLastFetchedAt[resultKey]
          && requestedAt - state.historicalLastFetchedAt[resultKey] < settings.interval * 1000) continue;
        const ranges = Array.isArray(rangesOverride) ? rangesOverride : settings.ranges;
        for (const range of ranges) {
          const [start, end] = historyRangeExpressions(range, settings.comparisons);
          const query = new URLSearchParams({
            project,
            deviceId: target.deviceId,
            value: measurement.value,
            type: measurement.type,
            start,
            end
          });
          // Do not start the request here. Creating promises in this loop
          // would immediately fan out one request per measurement/period.
          requests.push({ target, measurement, range, path: `/api/gridvis/history?${query}` });
        }
        state.historicalLastRequestedAt[resultKey] = requestedAt;
      }
    }
    const results = [];
    for (const { target, measurement, range, path } of requests) {
      results.push({ target, measurement, range, data: await api(path) });
    }
    if (state.measurementMutationVersion !== measurementMutationVersion) return;
    const grouped = new Map();
    for (const { target, measurement, range, data } of results) {
      const key = historicalResultKey(target.deviceId, measurement, range);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(...historicalDataRows(data.data, { energy: historicalUsesEnergyApi(measurement) }));
      state.historicalLastFetchedAt[historicalResultKey(target.deviceId, measurement)] = requestedAt;
    }
    for (const [key, rows] of grouped) {
      const unique = new Map();
      rows.sort((a, b) => historicalRowsTimestamp(a) - historicalRowsTimestamp(b)).forEach((row, index) => {
        unique.set(JSON.stringify([historicalRowsTimestamp(row), row]), { row, index });
      });
      const values = [...unique.values()].map(({ row }) => row);
      const separator = key.indexOf(':');
      const id = key.slice(0, separator);
      const cacheKeyValue = cacheKey(project, id);
      if (isLoadedDeviceState(project, id)) {
        state.historicalResults[key] = values;
      } else {
        const cache = state.measurementCache[cacheKeyValue] || {};
        cache.historicalResults = { ...(cache.historicalResults || {}), [key]: values };
        state.measurementCache[cacheKeyValue] = cache;
      }
    }
    renderHistoricalValues();
    renderHistoricalSelection();
    if (state.currentView === 'device-detail') writeUiCache();
    if (!silent) showToast('Historische Messwerte aktualisiert.', 'success');
  } finally {
    state.historicalRequestInFlight = false;
  }
}

function gridVisTime(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  const prefixed = /^(UTC|UTCSEC|UTCNANO|ISO8601|EUROPEAN|US|NAMED|RELATIVE)_(.+)$/i.exec(input);
  if (prefixed) return `${prefixed[1].toUpperCase()}_${prefixed[2]}`;

  const named = {
    today: 'Today',
    yesterday: 'Yesterday',
    thisweek: 'ThisWeek',
    lastweek: 'LastWeek',
    thismonth: 'ThisMonth',
    lastmonth: 'LastMonth',
    thisquarter: 'ThisQuarter',
    lastquarter: 'LastQuarter',
    thisyear: 'ThisYear',
    lastyear: 'LastYear'
  };
  const namedValue = named[input.toLowerCase().replaceAll(/\s+/g, '')];
  if (namedValue) return `NAMED_${namedValue}`;

  const relative = input.replaceAll(/\s+/g, '');
  if (/^[+-]?\d+(?:YEAR|MONTH|WEEK_OF_YEAR|WEEK_OF_MONTH|DATE|DAY_OF_YEAR|DAY_OF_WEEK|DAY_OF_WEEK_IN_MONTH|HOUR|HOUR_OF_DAY|MINUTE|SECOND)(?:[+-]\d+(?:YEAR|MONTH|WEEK_OF_YEAR|WEEK_OF_MONTH|DATE|DAY_OF_YEAR|DAY_OF_WEEK|DAY_OF_WEEK_IN_MONTH|HOUR|HOUR_OF_DAY|MINUTE|SECOND))*$/i.test(relative)) {
    return `RELATIVE_${relative}`;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(input);
  if (iso) {
    const [, year, month, day, hour, minute, seconds = '00', fraction = '', offset = ''] = iso;
    const milliseconds = fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : '';
    return `ISO8601_${year}-${month}-${day}${hour ? `T${hour}:${minute}:${seconds}${milliseconds}${offset}` : ''}`;
  }

  const timestamp = Date.parse(input);
  if (Number.isFinite(timestamp)) return `UTC_${timestamp}`;
  throw new Error(`Ungültiger GridVis-Zeitwert: ${input}`);
}

function localDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function applyHistoryPreset(preset) {
  if (!preset || preset === 'custom') return;
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);
  const dayStart = (date) => date.setHours(0, 0, 0, 0);
  const dayEnd = (date) => date.setHours(23, 59, 0, 0);
  const weekStart = (date) => {
    dayStart(date);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  };
  switch (preset) {
    case 'today':
      dayStart(start); dayEnd(end); break;
    case 'yesterday':
      start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); dayStart(start); dayEnd(end); break;
    case 'thisweek':
      weekStart(start); break;
    case 'lastweek':
      weekStart(start); start.setDate(start.getDate() - 7); end = new Date(start); end.setDate(end.getDate() + 6); dayEnd(end); break;
    case 'thismonth':
      start.setDate(1); dayStart(start); break;
    case 'lastmonth':
      start = new Date(start.getFullYear(), start.getMonth() - 1, 1); dayStart(start); end = new Date(start.getFullYear(), start.getMonth() + 1, 0); dayEnd(end); break;
    case 'thisyear':
      start = new Date(start.getFullYear(), 0, 1); dayStart(start); break;
    case 'lastyear':
      start = new Date(start.getFullYear() - 1, 0, 1); dayStart(start); end = new Date(start.getFullYear(), 11, 31); dayEnd(end); break;
    case 'last24hours':
      start.setHours(start.getHours() - 24); break;
    case 'last3months':
      start.setMonth(start.getMonth() - 3); break;
    default:
      return;
  }
  $('#history-start').value = localDateTimeValue(start);
  $('#history-end').value = localDateTimeValue(end);
  $('#history-start-expression').value = '';
  $('#history-end-expression').value = '';
}

function formatGridvisVersion(data) {
  if (data && typeof data === 'object' && typeof data.value === 'string') return data.value;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.value === 'string') return parsed.value;
    } catch {
      // The endpoint may return a plain version string.
    }
    return data;
  }
  return data == null ? '–' : JSON.stringify(data);
}

async function checkVersion({ silent = false } = {}) {
  try {
    const result = await api('/api/gridvis/version');
    setText('#gridvis-version', formatGridvisVersion(result.data));
    setText('#gridvis-version-detail', 'Aus GridVis REST API');
    if (!silent) setStatus('GridVis-Version geprüft', true);
  } catch (error) {
    if (silent) console.warn('GridVis-Version konnte nicht automatisch geladen werden:', error);
    else showError(error);
  }
}

async function checkGridvisConnection() {
  const button = $('#gridvis-test');
  const originalLabel = button?.textContent || 'Verbindung testen';
  if (button) {
    button.disabled = true;
    button.textContent = 'Teste ...';
  }
  try {
    const form = new FormData($('#gridvis-form'));
    await api('/api/gridvis/test', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: form.get('baseUrl'),
        username: form.get('username'),
        password: form.get('password'),
        authEnabled: $('#gridvis-auth-enabled')?.checked === true
      })
    });
    setStatus('GridVis-Verbindung ist erreichbar', true);
    showToast('GridVis-Verbindung erfolgreich getestet.', 'success');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

function updateGridvisConnectionControl() {
  const button = $('#gridvis-disconnect');
  if (!button) return;
  const gridvis = state.config?.gridvis || {};
  const enabled = gridvis.enabled !== false;
  const hasUrl = Boolean(gridvis.baseUrl);
  button.textContent = enabled ? 'GridVis trennen' : 'GridVis verbinden';
  button.disabled = !hasUrl;
  button.title = enabled
    ? 'Automatische GridVis-Abfragen und Live-/Historienabrufe stoppen.'
    : 'GridVis-Abfragen wieder aktivieren und die Verbindung speichern.';
}

async function toggleGridvisConnection() {
  const enabled = state.config?.gridvis?.enabled !== false;
  if (!enabled) {
    await saveConnection();
    return;
  }
  const result = await api('/api/gridvis/disconnect', { method: 'POST' });
  state.config = result.config;
  updateGridvisConnectionControl();
  configureLiveRefresh();
  configureHistoricalRefresh();
  configureDeviceInfoRefresh();
  setStatus('GridVis manuell getrennt', false);
  setText('#connection-detail', 'Es werden keine GridVis-Abfragen mehr ausgeführt.');
  showToast('GridVis wurde getrennt.', 'success');
}

function attachEvents() {
  $('#login-form')?.addEventListener('submit', (event) => submitLogin(event).catch((error) => setText('#login-error', error.message)));
  $('#password-change-form')?.addEventListener('submit', (event) => submitPasswordChange(event).catch((error) => setText('#password-change-error', error.message)));
  $('#profile-form')?.addEventListener('submit', (event) => submitProfile(event).catch(showError));
  $('#user-create-form')?.addEventListener('submit', (event) => submitNewUser(event).catch(showError));
  $('#auth-user-list')?.addEventListener('click', (event) => handleAuthUserAction(event).catch(showError));
  $('#logout')?.addEventListener('click', () => logout().catch(showError));
  $('#backup-download')?.addEventListener('click', () => downloadBackup().catch(showError));
  $('#backup-file')?.addEventListener('change', (event) => selectBackupFile(event).catch(showError));
  $('#backup-restore')?.addEventListener('click', () => restoreBackup().catch(showError));
  $('#update-check')?.addEventListener('click', () => checkForUpdate().catch(showError));
  $$('[data-view-link]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    setView(link.dataset.viewLink);
  }));
  $$('.detail-tab').forEach((button) => button.addEventListener('click', () => setDetailTab(button.dataset.detailTab)));
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.add('open'));
  $('#sidebar-close').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#project-select').addEventListener('change', () => {
    const project = $('#project-select').value;
    restoreProjectData(project);
    writeUiCache();
    loadDevices({ navigate: state.currentView !== 'settings' }).catch(showError);
    if (state.currentView === 'mqtt') loadMqttOverview({ silent: true }).catch(reportBackgroundError);
  });
  $('#device-select').addEventListener('change', () => openDevice($('#device-select').value).catch(showError));
  $('#device-search').addEventListener('input', () => { renderDeviceList(); writeUiCache(); });
  $('#device-sort')?.addEventListener('change', (event) => {
    state.deviceSort = isDeviceSortMode(event.target.value) ? event.target.value : 'name';
    renderDeviceSelect($('#device-select')?.value || '');
    renderDeviceList();
    writeUiCache();
  });
  $('#mqtt-add-measurement')?.addEventListener('click', () => openMqttSelectionDialog());
  $('#mqtt-refresh-overview')?.addEventListener('click', () => loadMqttOverview().catch(showError));
  $('#mqtt-overview-mode')?.addEventListener('change', renderMqttOverview);
  $('#mqtt-overview-status')?.addEventListener('change', renderMqttOverview);
  $('#mqtt-overview-search')?.addEventListener('input', renderMqttOverview);
  $('#mqtt-overview-table-body')?.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-mqtt-row-toggle]');
    if (toggle) {
      const row = mqttOverviewRowFromButton(toggle);
      updateMqttOverviewRow(row, { enabled: toggle.getAttribute('aria-pressed') !== 'true' }).catch(showError);
      return;
    }
    const remove = event.target.closest('[data-mqtt-row-remove]');
    if (remove) {
      const row = mqttOverviewRowFromButton(remove);
      if (!row || !window.confirm(`„${row.name}“ (${row.mode === 'historical' ? 'Historie' : 'Live'}) wirklich vollständig entfernen?`)) return;
      updateMqttOverviewRow(row, { remove: true }).catch(showError);
      return;
    }
    const button = event.target.closest('[data-mqtt-row-edit]');
    if (!button) return;
    openMqttSelectionDialog({ deviceIdValue: button.dataset.deviceId, measurementKeyValue: button.dataset.measurementKey, mode: button.dataset.mode });
  });
  $('#mqtt-selection-close')?.addEventListener('click', closeMqttSelectionDialog);
  $('#mqtt-selection-cancel')?.addEventListener('click', closeMqttSelectionDialog);
  $('#mqtt-selection-dialog')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMqttSelectionDialog();
  });
  $$('[data-mqtt-dialog-tab]').forEach((button) => button.addEventListener('click', () => setMqttDialogTab(button.dataset.mqttDialogTab)));
  $$('[data-mqtt-dialog-mode]')?.forEach((input) => input.addEventListener('change', (event) => {
    const selected = $$('[data-mqtt-dialog-mode]:checked');
    if (!selected.length) {
      event.target.checked = true;
      showToast('Mindestens eine Messwertart muss ausgewählt sein.', 'warning');
    }
    mqttDialogState.modes = new Set($$('[data-mqtt-dialog-mode]:checked').map((checkbox) => checkbox.value));
    updateMqttDialogAdvanced();
    refreshMqttDialogData().catch(reportBackgroundError);
  }));
  $('#mqtt-dialog-device-search')?.addEventListener('input', (event) => {
    mqttDialogState.deviceSearch = event.target.value;
    renderMqttDialogDevices();
  });
  $('#mqtt-dialog-value-search')?.addEventListener('input', (event) => {
    mqttDialogState.valueSearch = event.target.value;
    renderMqttDialogCommonValues();
  });
  $('#mqtt-dialog-recorded')?.addEventListener('change', () => {
    renderMqttDialogCommonValues();
    renderMqttDialogSelectedValues();
    updateMqttDialogStatus();
  });
  $('#mqtt-dialog-history-interval')?.addEventListener('change', () => {
    mqttDialogState.historySettingsTouched = true;
  });
  $('#mqtt-dialog-history-ranges')?.addEventListener('change', () => {
    mqttDialogState.historySettingsTouched = true;
  });
  $('#add-mqtt-dialog-history-comparison')?.addEventListener('click', () => {
    mqttDialogState.historySettingsTouched = true;
    const container = $('#mqtt-dialog-history-comparisons');
    const comparisons = selectedHistoryComparisons(container);
    renderHistoryComparisons(container, [...comparisons, nextHistoryComparison(comparisons)]);
  });
  $('#mqtt-dialog-history-comparisons')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-comparison]');
    if (!button) return;
    mqttDialogState.historySettingsTouched = true;
    const index = Number(button.dataset.removeComparison);
    const container = $('#mqtt-dialog-history-comparisons');
    const comparisons = selectedHistoryComparisons(container);
    if (!Number.isInteger(index) || index < 0 || index >= comparisons.length) return;
    comparisons.splice(index, 1);
    renderHistoryComparisons(container, comparisons);
  });
  $('#mqtt-dialog-history-comparisons')?.addEventListener('change', (event) => {
    const row = event.target.closest('.history-comparison-row');
    if (!row) return;
    mqttDialogState.historySettingsTouched = true;
    const index = Number(row.dataset.index);
    const container = $('#mqtt-dialog-history-comparisons');
    const comparisons = selectedHistoryComparisons(container);
    if (!Number.isInteger(index) || !comparisons[index]) return;
    if (event.target.dataset.comparisonUnit) comparisons[index].unit = event.target.value;
    if (event.target.dataset.comparisonRange) comparisons[index].range = event.target.value;
    if (event.target.matches('input')) comparisons[index].amount = Number(event.target.value);
    renderHistoryComparisons(container, normalizeHistoryComparisons(comparisons));
  });
  $('#mqtt-selection-save')?.addEventListener('click', () => saveMqttSelection().catch(showError));
  $('#gridvis-form').addEventListener('submit', (event) => { event.preventDefault(); saveConnection().catch(showError); });
  $('#application-form')?.addEventListener('submit', (event) => { event.preventDefault(); saveApplicationUrl().catch(showError); });
  $('#gridvis-test')?.addEventListener('click', () => checkGridvisConnection().catch(showError));
  $('#gridvis-disconnect')?.addEventListener('click', () => toggleGridvisConnection().catch(showError));
  $('#mqtt-form')?.addEventListener('submit', (event) => { event.preventDefault(); saveConnections({ reloadGridvis: false }).catch(showError); });
  $('#add-mqtt-broker')?.addEventListener('click', addMqttBroker);
  $('#add-mqtt-profile')?.addEventListener('click', addMqttProfile);
  $('#save-mqtt-profiles')?.addEventListener('click', () => saveConnections({ reloadGridvis: false }).catch(showError));
  $('#logbook-refresh')?.addEventListener('click', () => loadLogbook().catch(reportLogbookError));
  $('#logbook-download')?.addEventListener('click', () => downloadLogbook().catch(reportLogbookError));
  $('#logbook-clear')?.addEventListener('click', () => clearLogbook().catch(reportLogbookError));
  $('#logbook-limit')?.addEventListener('change', () => loadLogbook({ silent: true }).catch(reportLogbookError));
  $('#logbook-level')?.addEventListener('change', () => loadLogbook({ silent: true }).catch(reportLogbookError));
  $('#logbook-search')?.addEventListener('input', () => loadLogbook({ silent: true }).catch(reportLogbookError));
  $('#info-load-values')?.addEventListener('click', () => loadValues().then(() => setDetailTab('live')).catch(showError));
  $('#refresh-live').addEventListener('click', () => loadLiveData({
    publishMqtt: true,
    force: true,
    targets: liveTargetsForCurrentFocus()
  }).catch(showError));
  $('#live-refresh-interval')?.addEventListener('change', () => {
    state.liveRefreshInterval = Number($('#live-refresh-interval').value) || 0;
    configureLiveRefresh();
    writeUiCache();
  });
  $('#live-display-search')?.addEventListener('input', renderDisplayValues);
  $('#live-filter-discovery')?.addEventListener('change', (event) => {
    state.selectionFilters.live.discovery = event.target.checked;
    renderDisplayValues();
  });
  $('#live-filter-mqtt')?.addEventListener('change', (event) => {
    state.selectionFilters.live.mqtt = event.target.checked;
    renderDisplayValues();
  });
  $('#history-refresh-interval')?.addEventListener('change', () => {
    state.historicalDefaults.refreshInterval = normalizeHistoryRefreshInterval($('#history-refresh-interval').value);
    configureHistoricalRefresh();
    writeUiCache();
  });
  $('#history-refresh-offset')?.addEventListener('change', () => {
    state.historicalDefaults.minuteOffset = normalizeHistoryMinuteOffset($('#history-refresh-offset').value);
    $('#history-refresh-offset').value = String(state.historicalDefaults.minuteOffset);
    configureHistoricalRefresh();
    writeUiCache();
  });
  $('#add-history-comparison')?.addEventListener('click', addHistoryComparison);
  $('#history-comparisons')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-comparison]');
    if (!button) return;
    const index = Number(button.dataset.removeComparison);
    const comparisons = normalizeHistoryComparisons(currentHistoricalDefaults().comparisons);
    if (!Number.isInteger(index) || index < 0 || index >= comparisons.length) return;
    comparisons.splice(index, 1);
    state.historicalDefaults.comparisons = comparisons;
    refreshAfterHistoryComparisonChange();
  });
  $('#history-comparisons')?.addEventListener('change', (event) => {
    const row = event.target.closest('.history-comparison-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    const comparisons = normalizeHistoryComparisons(currentHistoricalDefaults().comparisons);
    if (!Number.isInteger(index) || !comparisons[index]) return;
    if (event.target.dataset.comparisonUnit) comparisons[index].unit = event.target.value;
    if (event.target.dataset.comparisonRange) comparisons[index].range = event.target.value;
    if (event.target.matches('input')) comparisons[index].amount = Number(event.target.value);
    state.historicalDefaults.comparisons = normalizeHistoryComparisons(comparisons);
    refreshAfterHistoryComparisonChange();
  });
  $('#history-default-ranges')?.addEventListener('change', () => {
    state.historicalDefaults.ranges = selectedHistoryRanges($('#history-default-ranges'));
    writeUiCache();
    renderHistoricalSelection();
    configureHistoricalRefresh();
    loadHistoricalData({ silent: true, publishMqtt: false })
      .then(() => renderHistoricalSelection())
      .catch(reportBackgroundError);
  });
  // The manual button refreshes only the historical values shown in the UI.
  // MQTT history publishing belongs exclusively to the backend scheduler and
  // must not be triggered by a browser action.
  $('#refresh-history')?.addEventListener('click', () => loadHistoricalData().catch(showError));
  $('#historical-display-search')?.addEventListener('input', renderHistoricalSelection);
  $('#historical-filter-discovery')?.addEventListener('change', (event) => {
    state.selectionFilters.historical.discovery = event.target.checked;
    renderHistoricalSelection();
  });
  $('#historical-filter-mqtt')?.addEventListener('change', (event) => {
    state.selectionFilters.historical.mqtt = event.target.checked;
    renderHistoricalSelection();
  });
  $('#measurement-settings-close')?.addEventListener('click', () => $('#measurement-settings-dialog')?.close());
  $('#measurement-settings-profile')?.addEventListener('change', () => {
    updateMeasurementSettingsTopic();
    updateMeasurementSettingsDiscovery();
  });
  $('#measurement-settings-unit')?.addEventListener('change', updateMeasurementDisplayPreview);
  $('#measurement-settings-history-range-mode')?.addEventListener('change', () => {
    updateMeasurementHistoryRangeMode();
    updateMeasurementSettingsTopic();
  });
  $('#measurement-settings-history-ranges')?.addEventListener('change', () => {
    updateMeasurementSettingsTopic();
    updateMeasurementSettingsRestRequest();
  });
  $('#measurement-settings-history-comparison-mode')?.addEventListener('change', () => {
    updateMeasurementHistoryComparisonMode();
    updateMeasurementSettingsTopic();
  });
  $('#add-measurement-history-comparison')?.addEventListener('click', () => {
    const container = $('#measurement-settings-history-comparisons');
    const comparisons = selectedHistoryComparisons(container);
    renderHistoryComparisons(container, [...comparisons, nextHistoryComparison(comparisons)]);
    updateMeasurementSettingsTopic();
    updateMeasurementSettingsRestRequest();
    updateMeasurementSettingsDiscovery();
  });
  $('#measurement-settings-history-comparisons')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-comparison]');
    if (!button) return;
    const index = Number(button.dataset.removeComparison);
    const container = $('#measurement-settings-history-comparisons');
    const comparisons = selectedHistoryComparisons(container);
    if (!Number.isInteger(index) || index < 0 || index >= comparisons.length) return;
    comparisons.splice(index, 1);
    renderHistoryComparisons(container, comparisons);
    updateMeasurementSettingsTopic();
    updateMeasurementSettingsRestRequest();
    updateMeasurementSettingsDiscovery();
  });
  $('#measurement-settings-history-comparisons')?.addEventListener('change', refreshMeasurementHistoryComparisonsEditor);
  $('#measurement-settings-decimals')?.addEventListener('change', () => {
    updateMeasurementDisplayPreview();
    updateMeasurementSettingsDiscovery();
  });
  $('#measurement-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const measurement = state.editingMeasurement;
    if (!measurement) return;
    const device = state.editingMeasurementDevice || selectedDevice();
    const currentDeviceId = deviceId(device);
    const project = $('#project-select')?.value || '';
    const isCurrentDevice = isLoadedDeviceState(project, currentDeviceId);
    const previousProfileIds = measurementProfileIdsForDevice(measurement, device);
    const wasMqttActive = measurementActiveForDevice(measurement, device);
    const refreshKey = cacheKey(project, currentDeviceId);
    const displaySettings = normalizeDisplaySettings(measurementDisplaySettingsInput(), measurement);
    const measurementKeyValue = measurementKey(measurement);
    const cache = state.measurementCache[refreshKey] || {};
    if (isCurrentDevice) {
      if (Object.keys(displaySettings).length) state.displaySettings[measurementKeyValue] = displaySettings;
      else delete state.displaySettings[measurementKeyValue];
    } else {
      cache.displaySettings = { ...(cache.displaySettings || {}) };
      if (Object.keys(displaySettings).length) cache.displaySettings[measurementKeyValue] = displaySettings;
      else delete cache.displaySettings[measurementKeyValue];
    }
    const interval = Number($('#measurement-settings-interval').value) || 0;
    const retainState = Boolean($('#measurement-settings-retain')?.checked);
    const historical = isHistoricalMeasurement(measurement);
    if (isCurrentDevice) {
      const retainAssignments = historical ? state.historicalRetainAssignments : state.mqttRetainAssignments;
      if (historical) retainAssignments[measurementKeyValue] = retainState;
      else if (retainState) retainAssignments[measurementKeyValue] = true;
      else delete retainAssignments[measurementKeyValue];
    } else {
      const cacheField = historical ? 'historicalRetainAssignments' : 'mqttRetainAssignments';
      cache[cacheField] = { ...(cache[cacheField] || {}) };
      if (historical) cache[cacheField][measurementKeyValue] = retainState;
      else if (retainState) cache[cacheField][measurementKeyValue] = true;
      else delete cache[cacheField][measurementKeyValue];
    }
    if (historical) {
      const settings = {
        interval: interval || 0,
        ...(($('#measurement-settings-history-range-mode')?.value || 'standard') === 'custom'
          ? { ranges: selectedHistoryRanges($('#measurement-settings-history-ranges')) }
          : {}),
        ...(($('#measurement-settings-history-comparison-mode')?.value || 'standard') === 'custom'
          ? { comparisons: selectedHistoryComparisons($('#measurement-settings-history-comparisons')) }
          : {})
      };
      if (isCurrentDevice) state.historicalSettings[measurementKeyValue] = settings;
      else {
        cache.historicalSettings = { ...(cache.historicalSettings || {}), [measurementKeyValue]: settings };
      }
    } else if (isRefreshInterval(interval)) state.deviceRefreshIntervals[refreshKey] = interval;
    else delete state.deviceRefreshIntervals[refreshKey];
    const nextProfileId = $('#measurement-settings-profile').value;
    const profileChanged = previousProfileIds.length && previousProfileIds[0] !== nextProfileId;
    if (previousProfileIds.length) {
      if (isCurrentDevice) {
        setMeasurementProfileIds(measurement, [nextProfileId]);
        if (wasMqttActive) setMeasurementMqttActive(measurement, true);
      } else {
        const assignmentField = historical ? 'historicalMqttAssignments' : 'mqttAssignments';
        const activeField = historical ? 'historicalMqttActiveAssignments' : 'mqttActiveAssignments';
        cache[assignmentField] = { ...(cache[assignmentField] || {}), [measurementKeyValue]: [nextProfileId] };
        cache[activeField] = { ...(cache[activeField] || {}) };
        if (wasMqttActive) cache[activeField][measurementKeyValue] = [nextProfileId];
        else delete cache[activeField][measurementKeyValue];
      }
    }
    if (!isCurrentDevice) state.measurementCache[refreshKey] = cache;
    $('#measurement-settings-dialog')?.close();
    if (isCurrentDevice) {
      if (historical) {
        renderHistoricalValues();
        renderHistoricalSelection();
      } else {
        renderLiveValues();
        renderDisplayValues();
      }
    }
    if (state.infoDevice && String(deviceId(state.infoDevice)) === String(currentDeviceId)) renderDeviceInfoValues(state.infoDevice);
    configureLiveRefresh();
    configureHistoricalRefresh();
    writeUiCache();
    const configuredMeasurement = {
      ...measurement,
      device,
      mqttProfileIds: previousProfileIds.length ? [nextProfileId] : [],
      retainState
    };
    const finalProfileIds = measurementProfileIdsForDevice(configuredMeasurement, device);
    const publish = () => finalProfileIds.length
      ? publishMqttSetup({ ...configuredMeasurement, mqttProfileIds: finalProfileIds }, device)
      : Promise.resolve();
    const cleanup = profileChanged
      ? removeMqttDiscovery([{ ...measurement, device, mqttProfileIds: previousProfileIds, retainState }])
      : Promise.resolve();
    cleanup.then(publish).then(() => {
      if (!finalProfileIds.length) showToast('Messwert-Einstellungen übernommen.', 'success');
    }).catch(showError);
  });
  $('#back-to-devices').addEventListener('click', () => setView('devices'));
  $('#discovery-enabled')?.addEventListener('change', updateMqttState);
  $('#device-info-close')?.addEventListener('click', () => {
    closeDeviceInfoDialog();
  });
  $('#history-details-close')?.addEventListener('click', () => $('#history-details-dialog')?.close());
}

attachEvents();
loadInitial().catch(showError);
