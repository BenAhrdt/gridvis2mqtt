import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { APP_NAME, APP_VERSION, getConfig, getPublicConfig, updateConfig } from './config.js';
import {
  authStatus,
  changePassword,
  clearSession,
  createSession,
  authenticateCredentials,
  createUser,
  deleteUser,
  requireAdmin,
  requireAuthenticated,
  resetUserPassword,
  listUsers,
  updateOwnProfile,
  verifyUserPassword
} from './auth.js';
import { GridVisClient, normalizeOnlineValues } from './gridvis-client.js';
import { buildBridgeApplicationUrlDiscovery, buildBridgeDiscovery, buildDeviceInfoDiscoveries, buildDiscoveryMessages, normalizeDiscoveryPrefix } from './discovery/home-assistant.js';
import { MqttPublisher } from './mqtt-publisher.js';
import { getState, hasStoredState, updateState } from './state.js';
import { LOGBOOK_MAX_ENTRIES, logbook } from './logbook.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const execFile = promisify(execFileCallback);
const config = getConfig();
const gridvis = new GridVisClient(config.gridvis);
const mqtt = new MqttPublisher({
  retainedDiscovery: config.mqtt.retainedDiscovery,
  onRetainedDiscoveryChange: (entries) => updateConfig({ mqtt: { retainedDiscovery: entries } }),
  onBrokerConnected: (brokerId) => handleBrokerConnected(brokerId)
});

const MQTT_STATE_DELAY_MS = 2000;
const INFORMATION_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const INFORMATION_REFRESH_CONCURRENCY = 1;
const HISTORICAL_REFRESH_CONCURRENCY = 1;
const LIVE_REFRESH_INTERVALS = new Set([1, 2, 5, 10, 30, 60, 300]);

let cachedGridvisVersion = '';
let cachedGridvisInfo = {};
let cachedGridvisFetchedAt = 0;
let gridvisVersionRequest = null;
const deviceDetailsCache = new Map();
let informationRefreshTimer = null;
let informationRefreshRequest = null;
let liveRefreshTimer = null;
const liveRefreshInFlight = new Map();
const liveLastRequestedAt = new Map();
const liveValueCache = new Map();
// Historical MQTT values are fetched and owned by the backend. Keep the
// latest value per scheduled job so the browser can render the same result
// without starting another GridVis request.
const historicalValueCache = new Map();

// All state-changing requests must commit in arrival order. Several of the
// GridVis requests are deliberately asynchronous; without this queue an old
// /api/state snapshot could finish after a newer checkbox change and restore
// a Discovery entry that the user had just disabled.
let stateMutationQueue = Promise.resolve();

function enqueueStateMutation(callback) {
  const result = stateMutationQueue.then(callback, callback);
  stateMutationQueue = result.catch(() => {});
  return result;
}

function liveValueCacheKey(project, deviceId, value, type) {
  return `${project}::${deviceId}::${value}::${type}`;
}

function cacheLiveValue(project, deviceId, measurement, result) {
  liveValueCache.set(liveValueCacheKey(project, deviceId, measurement.value, measurement.type), {
    deviceId: String(deviceId),
    valueType: {
      value: measurement.value,
      type: measurement.type,
      typeName: measurement.typeLabel || measurement.type
    },
    value: result.value,
    time: result.time || '',
    updatedAt: new Date().toISOString()
  });
}

function cachePublishedLiveValues(input = {}, published = 0) {
  if (!published || !input.project) return 0;
  let cached = 0;
  for (const measurement of Array.isArray(input.measurements) ? input.measurements : []) {
    // The same publish endpoint is also used for historical MQTT values.
    // Those belong in the historical cache, never in the live-value cache.
    if (measurement?.historical === true || measurement?.liveValue === undefined || measurement?.liveValue === null || measurement.liveValue === '') continue;
    const device = measurement.device || input.device;
    const deviceId = measurement.deviceId
      ?? (typeof device === 'object' ? (device.id ?? device.deviceId) : device);
    if (deviceId === undefined || deviceId === null || deviceId === '' || !measurement.value || !measurement.type) continue;
    cacheLiveValue(input.project, deviceId, measurement, {
      value: measurement.liveValue,
      time: measurement.liveTime || ''
    });
    cached += 1;
  }
  return cached;
}

function cachedLiveValues(project, requestedValues = []) {
  return requestedValues.flatMap((requested) => {
    const [deviceId, value, type] = String(requested).split(';');
    if (!deviceId || !value || !type) return [];
    const cached = liveValueCache.get(liveValueCacheKey(project, deviceId, value, type));
    return cached ? [structuredClone(cached)] : [];
  });
}

function cacheHistoricalValue(job, value, time = '') {
  historicalValueCache.set(job.key, {
    value,
    time: time || '',
    updatedAt: new Date().toISOString()
  });
}

function historicalResultCacheKey(job) {
  return `${job.deviceId}:${job.measurement.value}:${job.measurement.type}:${job.range}`;
}

function activeHistoricalResultKeys(project, deviceId, snapshot = getState()) {
  return historicalJobsFromState(snapshot)
    .filter((job) => String(job.project) === String(project) && String(job.deviceId) === String(deviceId))
    .map(historicalResultCacheKey);
}

function historicalDiscoveryKeysForState(snapshot = {}) {
  return new Set(historicalJobsFromState(snapshot)
    .flatMap((job) => historicalValueMessages(job, '', '').map(discoveryMessageKey)));
}

function historicalJobsForDevice(snapshot = {}, project = '', deviceId = '') {
  return historicalJobsFromState(snapshot)
    .filter((job) => String(job.project) === String(project) && String(job.deviceId) === String(deviceId));
}

function historicalDiscoveryKeysForDevice(snapshot = {}, project = '', deviceId = '') {
  return new Set(historicalJobsForDevice(snapshot, project, deviceId)
    .flatMap((job) => historicalValueMessages(job, '', '').map(discoveryMessageKey)));
}

function newlyActiveHistoricalDiscoveryKeys(previousState = {}, nextState = {}) {
  // A job can already exist in the backend scheduler while its Discovery is
  // still absent or offline. In that case comparing only the job lists misses
  // the transition caused by opening a device or re-enabling MQTT, and no
  // value is fetched after the Discovery appears. Compare the actually online
  // Discovery keys instead.
  const previousOnlineKeys = onlineDiscoveryKeysFromState(previousState);
  const nextOnlineKeys = onlineDiscoveryKeysFromState(nextState);
  const nextHistoricalKeys = historicalDiscoveryKeysForState(nextState);
  return new Set([...nextHistoricalKeys]
    .filter((key) => nextOnlineKeys.has(key) && !previousOnlineKeys.has(key)));
}

function cachedHistoricalResults(project, deviceId, snapshot = getState()) {
  const results = {};
  const jobs = historicalJobsFromState(snapshot)
    .filter((job) => String(job.project) === String(project) && String(job.deviceId) === String(deviceId));
  for (const job of jobs) {
    const cached = historicalValueCache.get(job.key);
    if (!cached) continue;
    const resultKey = historicalResultCacheKey(job);
    results[resultKey] = [{
      value: cached.value,
      time: cached.time,
      updatedAt: cached.updatedAt
    }];
  }
  return results;
}

function extractGridvisVersion(data) {
  if (data && typeof data === 'object') {
    for (const key of ['value', 'version', 'fullVersion', 'full_version']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
    }
  }
  if (typeof data === 'string' && data.trim()) {
    try {
      const parsed = JSON.parse(data);
      return extractGridvisVersion(parsed) || data.trim();
    } catch {
      return data.trim();
    }
  }
  return '';
}

async function refreshCachedGridvisVersion({ force = false } = {}) {
  if (!gridvis.configured) return cachedGridvisVersion;
  if (!force && cachedGridvisFetchedAt && Date.now() - cachedGridvisFetchedAt < INFORMATION_REFRESH_INTERVAL_MS) {
    return cachedGridvisVersion;
  }
  if (gridvisVersionRequest) return gridvisVersionRequest;
  cachedGridvisFetchedAt = Date.now();
  gridvisVersionRequest = gridvis.getVersion()
    .then((data) => {
      const version = extractGridvisVersion(data);
      if (version) cachedGridvisVersion = version;
      if (data && typeof data === 'object' && !Array.isArray(data)) cachedGridvisInfo = structuredClone(data);
      else if (version) cachedGridvisInfo = { version };
      return cachedGridvisVersion;
    })
    .catch((error) => {
      console.warn('GridVis-Version konnte für MQTT-Discovery nicht geladen werden:', error.message);
      return cachedGridvisVersion;
    })
    .finally(() => {
      gridvisVersionRequest = null;
    });
  return gridvisVersionRequest;
}

function waitForMqttState() {
  return new Promise((resolve) => setTimeout(resolve, MQTT_STATE_DELAY_MS));
}

function stateItemId(item) {
  return String(item?.id ?? item?.deviceId ?? item?.serialNr ?? item?.serialNumber ?? item?.name ?? '');
}

function replaceDeviceDetail(base = {}, detail = {}) {
  const detailInfo = detail.info && typeof detail.info === 'object' && !Array.isArray(detail.info) ? detail.info : {};
  return {
    ...base,
    ...detail,
    info: { ...detailInfo }
  };
}

function hasDeviceDetails(device = {}) {
  return [device.info, device.deviceInfo, device.device_info]
    .some((value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function deviceDetailsCacheKey(project, deviceId) {
  return `${gridvis.baseUrl}::${project}::${deviceId}`;
}

async function getCachedDeviceDetails(project, deviceId, { force = false } = {}) {
  const key = deviceDetailsCacheKey(project, deviceId);
  const cached = deviceDetailsCache.get(key);
  if (cached?.request) return cached.request;
  if (!force && cached?.data && cached.fetchedAt && Date.now() - cached.fetchedAt < INFORMATION_REFRESH_INTERVAL_MS) {
    return cached.data;
  }

  const request = gridvis.getDeviceInfo(project, deviceId)
    .then((detail) => {
      const safeDetail = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
      // A temporary connection-test failure must not erase the last known
      // firmware/status values. A successful response with an info object may
      // however remove fields that GridVis no longer reports.
      const data = hasDeviceDetails(safeDetail) || !cached?.data
        ? safeDetail
        : cached.data;
      deviceDetailsCache.set(key, { data, fetchedAt: Date.now() });
      return data;
    })
    .catch((error) => {
      if (cached?.data) return cached.data;
      throw error;
    })
    .finally(() => {
      const current = deviceDetailsCache.get(key);
      if (current?.request === request) {
        if (current.data) deviceDetailsCache.set(key, { data: current.data, fetchedAt: current.fetchedAt || Date.now() });
        else deviceDetailsCache.delete(key);
      }
    });
  deviceDetailsCache.set(key, { ...(cached || {}), request });
  return request;
}

function getStoredDeviceDetails(project, deviceId) {
  const key = deviceDetailsCacheKey(project, deviceId);
  const cached = deviceDetailsCache.get(key)?.data;
  if (cached) return cached;
  const snapshot = getState();
  const device = (snapshot.deviceCache?.[project] || [])
    .find((entry) => stateItemId(entry) === String(deviceId));
  return device || { id: deviceId };
}

function mergeCachedDeviceInformation(previousState = {}, nextState = {}) {
  const previousCaches = previousState.deviceCache && typeof previousState.deviceCache === 'object'
    ? previousState.deviceCache
    : {};
  const nextCaches = nextState.deviceCache && typeof nextState.deviceCache === 'object'
    ? nextState.deviceCache
    : {};

  for (const [project, devices] of Object.entries(nextCaches)) {
    if (!Array.isArray(devices)) continue;
    const previousDevices = Array.isArray(previousCaches[project]) ? previousCaches[project] : [];
    for (let index = 0; index < devices.length; index += 1) {
      const device = devices[index];
      const id = stateItemId(device);
      if (!id) continue;
      const cached = deviceDetailsCache.get(deviceDetailsCacheKey(project, id))?.data;
      const previous = previousDevices.find((entry) => stateItemId(entry) === id);
      const source = hasDeviceDetails(device)
        ? device
        : cached && hasDeviceDetails(cached)
          ? cached
          : previous;
      if (source && hasDeviceDetails(source)) {
        const info = source.info && typeof source.info === 'object' && !Array.isArray(source.info)
          ? source.info
          : {};
        nextCaches[project][index] = { ...device, info: structuredClone(info) };
      }
    }
  }
  return nextState;
}

function backendMeasurementCacheKey(project, deviceId) {
  return `${project}::${deviceId}`;
}

function mergeDeviceIntoState(nextState, project, deviceId, detail) {
  const devices = Array.isArray(nextState.deviceCache?.[project])
    ? nextState.deviceCache[project]
    : [];
  if (!nextState.deviceCache || typeof nextState.deviceCache !== 'object') nextState.deviceCache = {};
  nextState.deviceCache[project] = devices;
  const id = String(deviceId);
  const index = devices.findIndex((entry) => stateItemId(entry) === id);
  const base = index >= 0 ? devices[index] : { id };
  const merged = replaceDeviceDetail(base, detail || {});
  if (index >= 0) devices[index] = merged;
  else devices.push(merged);
  return merged;
}

function stateMeasurementKey(measurement = {}) {
  if (measurement?.value === undefined || measurement?.type === undefined) return '';
  return `${measurement.value}:${measurement.type}`;
}

function preserveDiscoveryAssignmentsOnDeactivate(previousCache = {}, nextCache = {}) {
  const assignmentGroups = [
    {
      assignments: 'mqttAssignments',
      activeAssignments: 'mqttActiveAssignments',
      selectedFields: ['displayedMeasurements', 'selectedMeasurements']
    },
    {
      assignments: 'historicalMqttAssignments',
      activeAssignments: 'historicalMqttActiveAssignments',
      selectedFields: ['historicalSelectedMeasurements']
    }
  ];

  for (const group of assignmentGroups) {
    const previousActive = previousCache[group.activeAssignments];
    if (!previousActive || typeof previousActive !== 'object') continue;
    const nextAssignments = nextCache[group.assignments]
      && typeof nextCache[group.assignments] === 'object'
      ? nextCache[group.assignments]
      : {};
    const stillSelected = new Set(group.selectedFields.flatMap((field) => (
      Array.isArray(nextCache[field])
        ? nextCache[field].map(stateMeasurementKey).filter(Boolean)
        : []
    )));
    for (const [key, profileIds] of Object.entries(previousActive)) {
      if (!stillSelected.has(key) || nextAssignments[key] || !Array.isArray(profileIds) || !profileIds.length) continue;
      nextAssignments[key] = structuredClone(profileIds);
    }
    nextCache[group.assignments] = nextAssignments;
  }
  return nextCache;
}

function applyCurrentDeviceState(nextState, currentDeviceState) {
  if (!currentDeviceState || typeof currentDeviceState !== 'object') return;
  // Never allow an initial/partially loaded browser view to replace a
  // server-side device cache. The frontend sets this flag only after the
  // dedicated backend cache request completed successfully.
  if (currentDeviceState.loaded !== true) return;
  const project = String(currentDeviceState.project || '');
  const deviceId = String(currentDeviceState.deviceId || '');
  if (!project || !deviceId) return;

  if (!nextState.measurementCache || typeof nextState.measurementCache !== 'object') nextState.measurementCache = {};
  if (currentDeviceState.cache && typeof currentDeviceState.cache === 'object' && !Array.isArray(currentDeviceState.cache)) {
    const key = backendMeasurementCacheKey(project, deviceId);
    const previousCache = nextState.measurementCache[key]
      && typeof nextState.measurementCache[key] === 'object'
      ? nextState.measurementCache[key]
      : {};
    const nextCache = structuredClone(currentDeviceState.cache);
    nextState.measurementCache[key] = preserveDiscoveryAssignmentsOnDeactivate(previousCache, nextCache);
  }
  if (currentDeviceState.device && typeof currentDeviceState.device === 'object' && !Array.isArray(currentDeviceState.device)) {
    mergeDeviceIntoState(nextState, project, deviceId, currentDeviceState.device);
  }
}

function assignmentCount(assignments = {}) {
  return Object.values(assignments || {})
    .filter((ids) => Array.isArray(ids) && ids.length)
    .length;
}

function selectedMeasurementCount(measurements = []) {
  return new Set((Array.isArray(measurements) ? measurements : [])
    .map((measurement) => stateMeasurementKey(measurement))
    .filter(Boolean))
    .size;
}

function mqttDeviceSummariesForBrowser(snapshot = {}) {
  const summaries = {};
  for (const [key, cache] of Object.entries(snapshot.measurementCache || {})) {
    if (!cache || typeof cache !== 'object') continue;
    const liveActiveCount = assignmentCount(cache.mqttActiveAssignments);
    const historicalActiveCount = assignmentCount(cache.historicalMqttActiveAssignments);
    const liveDiscoveryCount = assignmentCount(cache.mqttAssignments);
    const historicalDiscoveryCount = assignmentCount(cache.historicalMqttAssignments);
    const liveSelectedCount = selectedMeasurementCount(cache.displayedMeasurements);
    const historicalSelectedCount = selectedMeasurementCount(cache.historicalSelectedMeasurements);
    if (liveActiveCount || historicalActiveCount || liveDiscoveryCount || historicalDiscoveryCount || liveSelectedCount || historicalSelectedCount) {
      summaries[key] = {
        liveActiveCount,
        historicalActiveCount,
        mqttActiveCount: liveActiveCount + historicalActiveCount,
        liveDiscoveryCount,
        historicalDiscoveryCount,
        discoveryCount: liveDiscoveryCount + historicalDiscoveryCount,
        liveSelectedCount,
        historicalSelectedCount
      };
    }
  }
  return summaries;
}

function stateForBrowser(snapshot = {}) {
  const browserState = structuredClone(snapshot);
  // Device lists, measurement definitions, results and device details are
  // backend-owned caches. The browser receives only UI preferences and the
  // current selection, then requests the needed device cache explicitly.
  delete browserState.projects;
  delete browserState.deviceCache;
  delete browserState.measurementCache;
  // The complete caches stay backend-only. This small derived summary lets
  // the device list visibly mark devices that have MQTT values configured.
  browserState.mqttDeviceSummaries = mqttDeviceSummariesForBrowser(snapshot);
  browserState.mqttDeviceCounts = Object.fromEntries(Object.entries(browserState.mqttDeviceSummaries)
    .filter(([, summary]) => summary.mqttActiveCount > 0)
    .map(([key, summary]) => [key, summary.mqttActiveCount]));
  const discoveryTopicKeys = new Set(activeDiscoveryMessagesFromState(snapshot)
    .filter((message) => !isBridgeDiscoveryMessage(message) && !isDeviceInfoDiscoveryMessage(message))
    .map(discoveryMessageKey));
  browserState.discoveryPreparedCount = discoveryTopicKeys.size;
  return browserState;
}

function listDataFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['projects', 'project', 'devices', 'device', 'items', 'results', 'data', 'value']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      const nested = listDataFromResponse(data[key]);
      if (nested.length) return nested;
    }
  }
  return Object.values(data).flatMap((value) => Array.isArray(value) ? value : []);
}

function persistProjects(projects) {
  const entries = listDataFromResponse(projects);
  if (projects == null) return;
  const nextState = getState();
  nextState.projects = structuredClone(entries);
  updateState(nextState);
}

function persistDeviceList(project, devices) {
  const entries = listDataFromResponse(devices);
  if (!project || devices == null) return;
  const nextState = getState();
  const previousDevices = Array.isArray(nextState.deviceCache?.[project]) ? nextState.deviceCache[project] : [];
  const previousById = new Map(previousDevices.map((device) => [stateItemId(device), device]));
  nextState.deviceCache[project] = entries.map((device) => {
    const previous = previousById.get(stateItemId(device));
    return previous?.info ? replaceDeviceDetail(device, previous) : structuredClone(device);
  });
  updateState(nextState);
}

function persistMeasurementDefinitions(project, deviceId, field, values) {
  if (!project || !deviceId || !['onlineValues', 'historicalValues'].includes(field) || !Array.isArray(values)) return;
  const nextState = getState();
  const key = backendMeasurementCacheKey(project, deviceId);
  const previous = nextState.measurementCache?.[key] && typeof nextState.measurementCache[key] === 'object'
    ? nextState.measurementCache[key]
    : {};
  nextState.measurementCache[key] = { ...previous, [field]: structuredClone(values) };
  updateState(nextState);
}

async function enrichActiveDeviceDetails(snapshot) {
  if (!gridvis.configured || !snapshot || typeof snapshot !== 'object') return snapshot;
  const measurementCaches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const deviceCaches = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const targets = new Map();

  for (const [cacheKey, cache] of Object.entries(measurementCaches)) {
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const project = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    const hasActiveMeasurements = Object.values(cache.mqttActiveAssignments || {}).some((ids) => Array.isArray(ids) && ids.length)
      || Object.values(cache.historicalMqttActiveAssignments || {}).some((ids) => Array.isArray(ids) && ids.length);
    if (!hasActiveMeasurements) continue;
    const devices = Array.isArray(deviceCaches[project]) ? deviceCaches[project] : [];
    const index = devices.findIndex((device) => stateItemId(device) === deviceId);
    if (index < 0) continue;
    const device = devices[index];
    targets.set(`${project}::${deviceId}`, { project, deviceId, devices, index, device });
  }

  await Promise.all([...targets.values()].map(async (target) => {
    try {
      const detail = await getCachedDeviceDetails(target.project, target.deviceId);
      target.devices[target.index] = replaceDeviceDetail(target.device, detail);
    } catch (error) {
      console.warn(`Detaildaten für GridVis-Gerät ${target.deviceId} konnten für MQTT nicht geladen werden:`, error.message);
      logbook.warning('gridvis.device-information', {
        project: target.project,
        deviceId: target.deviceId,
        error: error.message
      });
    }
  }));

  return snapshot;
}

function informationTargetsFromState(snapshot = {}) {
  const measurementCaches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const deviceCaches = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const targets = new Map();
  const mqttActiveKeys = new Set();

  for (const [cacheKey, cache] of Object.entries(measurementCaches)) {
    if (!cache || typeof cache !== 'object') continue;
    const hasActiveMeasurements = Object.values(cache.mqttActiveAssignments || {}).some((ids) => Array.isArray(ids) && ids.length)
      || Object.values(cache.historicalMqttActiveAssignments || {}).some((ids) => Array.isArray(ids) && ids.length);
    if (hasActiveMeasurements) mqttActiveKeys.add(cacheKey);
  }

  // The periodic backend refresh is for MQTT-active devices only. Devices
  // without MQTT remain in the device cache and are refreshed when a user
  // opens them explicitly.
  for (const [project, devices] of Object.entries(deviceCaches)) {
    if (!Array.isArray(devices)) continue;
    for (const [index, device] of devices.entries()) {
      const deviceId = stateItemId(device);
      if (deviceId && mqttActiveKeys.has(backendMeasurementCacheKey(project, deviceId))) {
        targets.set(`${project}::${deviceId}`, { project, deviceId, devices, index });
      }
    }
  }

  // Keep MQTT-active devices discoverable through a measurement cache even if
  // a device list was loaded before the device cache was persisted.
  for (const cacheKey of Object.keys(measurementCaches)) {
    if (!mqttActiveKeys.has(cacheKey)) continue;
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const project = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    const devices = Array.isArray(deviceCaches[project]) ? deviceCaches[project] : [];
    if (targets.has(`${project}::${deviceId}`)) continue;
    if (!Array.isArray(deviceCaches[project])) deviceCaches[project] = devices;
    devices.push({ id: deviceId });
    targets.set(`${project}::${deviceId}`, { project, deviceId, devices, index: devices.length - 1 });
  }
  return [...targets.values()];
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

async function refreshBackendInformation({ force = false, publish = true } = {}) {
  if (!gridvis.configured) return { changed: false, targets: 0 };
  if (informationRefreshRequest) return informationRefreshRequest;

  informationRefreshRequest = (async () => {
    const previousState = getState();
    const previousMessages = activeDiscoveryMessagesFromState(previousState);
    const refreshState = structuredClone(previousState);
    const targets = informationTargetsFromState(refreshState);
    const startedAt = Date.now();
    await refreshCachedGridvisVersion({ force });
    const refreshedDetails = new Map();

    // Keep the low-priority information scan gentle on GridVis. A single
    // device is processed at a time, and getDeviceInfo also performs its two
    // API calls sequentially. Live-value requests remain independent and can
    // therefore continue while this long-running queue is draining.
    await mapWithConcurrency(targets, INFORMATION_REFRESH_CONCURRENCY, async (target) => {
      try {
        const detail = await getCachedDeviceDetails(target.project, target.deviceId, { force });
        refreshedDetails.set(`${target.project}::${target.deviceId}`, detail);
      } catch (error) {
        logbook.warning('gridvis.device-information', {
          project: target.project,
          deviceId: target.deviceId,
          error: error.message
        });
      }
    });

    // The information requests can take many seconds. While they are in
    // flight, the browser or MQTT settings may legitimately update the
    // server state. Never write the old snapshot back here: doing so used to
    // erase the newer measurement selections and made retained discoveries
    // look inactive. Merge only the freshly fetched device details into the
    // latest state instead.
    const nextState = getState();
    let changed = false;
    for (const [key, detail] of refreshedDetails) {
      const separator = key.lastIndexOf('::');
      const project = key.slice(0, separator);
      const deviceId = key.slice(separator + 2);
      const current = (nextState.deviceCache?.[project] || [])
        .find((entry) => stateItemId(entry) === deviceId) || { id: deviceId };
      const merged = replaceDeviceDetail(current, detail);
      if (JSON.stringify(current) !== JSON.stringify(merged)) changed = true;
      mergeDeviceIntoState(nextState, project, deviceId, detail);
    }
    if (changed) {
      await enqueueStateMutation(() => {
        const latestState = getState();
        for (const [key, detail] of refreshedDetails) {
          const separator = key.lastIndexOf('::');
          const project = key.slice(0, separator);
          const deviceId = key.slice(separator + 2);
          mergeDeviceIntoState(latestState, project, deviceId, detail);
        }
        updateState(latestState);
      });
    }
    const stableState = getState();
    const nextMessages = activeDiscoveryMessagesFromState(stableState);
    await mqtt.reconcileRetainedDiscovery(new Set(nextMessages.map(discoveryMessageKey)));
    const syncResult = publish
      ? await syncNewStateToConnectedBrokers(previousState, stableState, { previousMessages, nextMessages })
      : { valuesPublishedFor: new Set() };

    if (publish) {
      const connectedBrokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
      await Promise.all(connectedBrokers
        .filter((broker) => !syncResult.valuesPublishedFor.has(broker.id))
        .flatMap((broker) => [
          publishBridgeValuesForBroker(stableState, broker.id),
          publishDeviceInfoValuesForBroker(stableState, broker.id)
        ]));
    }

    logbook.info('backend.information-refresh', {
      force,
      targets: targets.length,
      changed,
      durationMs: Date.now() - startedAt
    });
    return { changed, targets: targets.length };
  })().finally(() => {
    informationRefreshRequest = null;
  });
  return informationRefreshRequest;
}

function scheduleInformationRefresh() {
  if (informationRefreshTimer) clearTimeout(informationRefreshTimer);
  informationRefreshTimer = null;
  if (!gridvis.configured) return;
  informationRefreshTimer = setTimeout(async () => {
    if (!gridvis.configured) {
      informationRefreshTimer = null;
      return;
    }
    try {
      await refreshBackendInformation({ force: true });
    } catch (error) {
      logbook.error('backend.information-refresh', { error: error.message });
    } finally {
      scheduleInformationRefresh();
    }
  }, INFORMATION_REFRESH_INTERVAL_MS);
}

function stopGridvisSchedulers() {
  if (informationRefreshTimer) clearTimeout(informationRefreshTimer);
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  if (historicalRefreshTimer) clearTimeout(historicalRefreshTimer);
  informationRefreshTimer = null;
  liveRefreshTimer = null;
  historicalRefreshTimer = null;
}

function activeDiscoveryMessagesFromState(snapshot = {}) {
  const configured = getConfig();
  const messages = [];
  const bridgeMessages = [];
  const deviceInfoKeys = new Set();
  const measurementCaches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const deviceCaches = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const globalHistoryRanges = Array.isArray(snapshot.historicalGlobalSettings?.ranges)
    && snapshot.historicalGlobalSettings.ranges.length
    ? snapshot.historicalGlobalSettings.ranges
    : ['today'];

  const bridgeProfiles = new Map();
  for (const [cacheKey, cache] of Object.entries(measurementCaches)) {
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const project = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    const device = (deviceCaches[project] || []).find((entry) => stateItemId(entry) === deviceId) || { id: deviceId };
    const deviceDefaults = cache.historicalDefaults && typeof cache.historicalDefaults === 'object'
      ? cache.historicalDefaults
      : {};
    const deviceHistoryRanges = normalizedHistoryRanges(deviceDefaults.ranges, globalHistoryRanges);
    const deviceHistoryComparisons = Array.isArray(deviceDefaults.comparisons)
      ? deviceDefaults.comparisons
      : snapshot.historicalGlobalSettings?.comparisons;
    const onlineMeasurements = new Map();
    const historicalMeasurements = new Map();
    for (const measurement of cache.onlineValues || []) {
      if (measurement?.value !== undefined && measurement?.type !== undefined) {
        onlineMeasurements.set(`${measurement.value}:${measurement.type}`, measurement);
      }
    }
    for (const measurement of cache.historicalValues || []) {
      if (measurement?.value !== undefined && measurement?.type !== undefined) {
        historicalMeasurements.set(`${measurement.value}:${measurement.type}`, measurement);
      }
    }

    // The active and Discovery assignment maps can temporarily differ after
    // a migration or an older browser state. MQTT-active values are still
    // authoritative for startup: an active assignment without a matching
    // Discovery assignment must receive Discovery before its value is read.
    const mergeAssignments = (discoveryAssignments, activeAssignments) => {
      const merged = {};
      for (const key of new Set([
        ...Object.keys(discoveryAssignments || {}),
        ...Object.keys(activeAssignments || {})
      ])) {
        const profileIds = [...new Set([
          ...(Array.isArray(discoveryAssignments?.[key]) ? discoveryAssignments[key] : []),
          ...(Array.isArray(activeAssignments?.[key]) ? activeAssignments[key] : [])
        ])];
        if (profileIds.length) merged[key] = profileIds;
      }
      return merged;
    };
    const liveAssignments = mergeAssignments(cache.mqttAssignments, cache.mqttActiveAssignments);
    const historicalAssignments = mergeAssignments(cache.historicalMqttAssignments, cache.historicalMqttActiveAssignments);
    const liveActiveAssignments = cache.mqttActiveAssignments
      && typeof cache.mqttActiveAssignments === 'object'
      ? cache.mqttActiveAssignments
      : liveAssignments;
    const historicalActiveAssignments = cache.historicalMqttActiveAssignments
      && typeof cache.historicalMqttActiveAssignments === 'object'
      ? cache.historicalMqttActiveAssignments
      : historicalAssignments;
    for (const [source, historical, measurements] of [
      [liveAssignments, false, onlineMeasurements],
      [historicalAssignments, true, historicalMeasurements]
    ]) {
      for (const [measurementKey, profileIds] of Object.entries(source || {})) {
        const measurement = measurements.get(measurementKey);
        if (!measurement || !Array.isArray(profileIds)) continue;
        const activeProfileIds = new Set(
          (historical ? historicalActiveAssignments : liveActiveAssignments)?.[measurementKey] || []
        );
        const configuredRanges = cache.historicalSettings?.[measurementKey]?.ranges;
        const configuredComparisons = cache.historicalSettings?.[measurementKey]?.comparisons;
        const comparisons = historical && Array.isArray(configuredComparisons)
          ? configuredComparisons
          : deviceHistoryComparisons;
        const historyRanges = historicalRangesWithComparison(
          Array.isArray(configuredRanges) && configuredRanges.length
          ? configuredRanges
          : deviceHistoryRanges,
          comparisons
        );
        for (const profileId of profileIds) {
          messages.push(...buildDiscoveryMessagesForRequest({
            project,
            device,
            measurements: [{
              ...measurement,
              device,
              historical,
              historyRanges: historical ? historyRanges : undefined,
              mqttProfileIds: [profileId],
              displaySettings: cache.displaySettings?.[measurementKey] || measurement.displaySettings,
              retainState: historical
                ? cache.historicalRetainAssignments?.[measurementKey] === true
                : cache.mqttRetainAssignments?.[measurementKey] === true
            }]
          }, { prefix: 'homeassistant' }, {
            includeBridge: true,
            includeDeviceInfo: true,
            bridgeProfiles,
            deviceInfoKeys
          }).map((message) => ({
            ...message,
            availabilityValue: isDeviceInfoDiscoveryMessage(message)
              ? 'online'
              : (activeProfileIds.has(profileId) ? 'online' : 'offline')
          })));
        }
      }
    }
  }

  for (const [brokerId, profile] of bridgeProfiles) {
    const bridge = buildBridgeDiscovery({
      topicPrefix: profile.topicPrefix || configured.mqtt.topicPrefix,
      discoveryPrefix: profile.discoveryPrefix,
      profile,
      gridvisVersion: cachedGridvisVersion,
      gridvisInfo: cachedGridvisInfo,
      configurationUrl: configured.gridvis.baseUrl
    });
    const bridgeApplicationUrl = buildBridgeApplicationUrlDiscovery({
      topicPrefix: profile.topicPrefix || configured.mqtt.topicPrefix,
      discoveryPrefix: profile.discoveryPrefix,
      profile,
      applicationUrl: configured.application?.publicUrl
    });
    bridge.brokerId = brokerId;
    bridgeApplicationUrl.brokerId = brokerId;
    bridgeMessages.push(bridge, bridgeApplicationUrl);
  }

  // Register the bridge before its child devices reference it via
  // `via_device` on a fresh Home Assistant installation.
  return [...bridgeMessages, ...messages];
}

function discoveryMessageKey(message) {
  return [message.brokerId || 'default', message.profileId || 'homeassistant', message.uniqueId || message.configTopic].join('|');
}

function discoveryMessageSignature(message) {
  return JSON.stringify({
    configTopic: message.configTopic || '',
    availabilityTopic: message.availabilityTopic || '',
    stateTopic: message.stateTopic || '',
    stateRetain: message.stateRetain === true,
    availabilityValue: message.availabilityValue === 'offline' ? 'offline' : 'online',
    payload: message.payload || {}
  });
}

function activeDiscoveryKeysFromState(snapshot = {}) {
  return new Set(activeDiscoveryMessagesFromState(snapshot).map(discoveryMessageKey));
}

function onlineDiscoveryKeysFromState(snapshot = {}) {
  return new Set(activeDiscoveryMessagesFromState(snapshot)
    .filter((message) => message.availabilityValue !== 'offline')
    .map(discoveryMessageKey));
}

function mqttOverviewMeasurementName(measurement = {}) {
  return String(
    measurement.name
      || measurement.label
      || measurement.displayName
      || measurement.measurementName
      || measurement.valueName
      || measurement.value
      || 'Messwert'
  );
}

function mqttOverviewDeviceName(device = {}, fallback = '') {
  return String(
    device.name
      || device.label
      || device.title
      || device.serialNr
      || device.serialNumber
      || device.id
      || fallback
      || 'Unbenanntes Gerät'
  );
}

function mqttOverviewRows(snapshot = {}, project = '') {
  const configured = getConfig();
  const profiles = Array.isArray(configured.mqtt.profiles) ? configured.mqtt.profiles : [];
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.name || profile.id]));
  const caches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const devices = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const rows = [];
  const globalHistoryRanges = normalizedHistoryRanges(
    snapshot.historicalGlobalSettings?.ranges,
    ['today']
  );
  const globalHistoryComparisons = snapshot.historicalGlobalSettings?.comparisons;

  for (const [cacheKey, cache] of Object.entries(caches)) {
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const cacheProject = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    if (project && cacheProject !== project) continue;
    if (!cache || typeof cache !== 'object') continue;
    const device = (devices[cacheProject] || []).find((entry) => stateItemId(entry) === deviceId) || { id: deviceId };
    const liveValues = new Map((cache.onlineValues || [])
      .filter((measurement) => measurement?.value !== undefined && measurement?.type !== undefined)
      .map((measurement) => [stateMeasurementKey(measurement), measurement]));
    const historicalValues = new Map((cache.historicalValues || [])
      .filter((measurement) => measurement?.value !== undefined && measurement?.type !== undefined)
      .map((measurement) => [stateMeasurementKey(measurement), measurement]));
    const deviceHistoryDefaults = cache.historicalDefaults && typeof cache.historicalDefaults === 'object'
      ? cache.historicalDefaults
      : {};
    const deviceHistoryRanges = normalizedHistoryRanges(deviceHistoryDefaults.ranges, globalHistoryRanges);
    const deviceHistoryComparisons = Array.isArray(deviceHistoryDefaults.comparisons)
      ? deviceHistoryDefaults.comparisons
      : globalHistoryComparisons;
    const deviceName = mqttOverviewDeviceName(device, deviceId);
    const pushRows = (assignments, activeAssignments, measurements, historical) => {
      for (const [measurementKey, assignedProfileIds] of Object.entries(assignments || {})) {
        if (!Array.isArray(assignedProfileIds) || !assignedProfileIds.length) continue;
        const measurement = measurements.get(measurementKey);
        if (!measurement) continue;
        const activeProfileIds = Array.isArray(activeAssignments?.[measurementKey])
          ? activeAssignments[measurementKey].filter((id) => profileNames.has(id) && profiles.find((profile) => profile.id === id)?.enabled !== false)
          : [];
        const configuredSettings = cache.historicalSettings?.[measurementKey] || {};
        const ranges = historical
          ? historicalRangesWithComparison(
            Array.isArray(configuredSettings.ranges) && configuredSettings.ranges.length
              ? configuredSettings.ranges
              : deviceHistoryRanges,
            Array.isArray(configuredSettings.comparisons)
              ? configuredSettings.comparisons
              : deviceHistoryComparisons
          )
          : [];
        const values = {};
        let updatedAt = '';
        if (historical) {
          for (const range of ranges) {
            const jobKey = `${cacheProject}::${deviceId}::${measurementKey}::${range}`;
            const cached = historicalValueCache.get(jobKey);
            if (cached) {
              values[range] = cached.value;
              if (!updatedAt || String(cached.updatedAt) > updatedAt) updatedAt = cached.updatedAt || '';
            }
          }
        } else {
          const cached = liveValueCache.get(liveValueCacheKey(cacheProject, deviceId, measurement.value, measurement.type));
          if (cached) {
            values.live = cached.value;
            updatedAt = cached.updatedAt || '';
          }
        }
        const profileIds = [...new Set(assignedProfileIds)]
          .filter((id) => profileNames.has(id) && profiles.find((profile) => profile.id === id)?.enabled !== false);
        if (!profileIds.length) continue;
        rows.push({
          project: cacheProject,
          deviceId,
          deviceName,
          measurementKey,
          name: mqttOverviewMeasurementName(measurement),
          value: String(measurement.value),
          type: String(measurement.type),
          typeLabel: String(measurement.typeLabel || measurement.type),
          unit: String(measurement.unit || ''),
          mode: historical ? 'historical' : 'live',
          discovered: true,
          active: activeProfileIds.length > 0,
          profileIds,
          profiles: profileIds.map((id) => profileNames.get(id) || id),
          values,
          updatedAt,
          cycle: historical
            ? normalizedHistoryInterval(configuredSettings.interval, normalizedHistoryInterval(deviceHistoryDefaults.refreshInterval, normalizedHistoryInterval(snapshot.historicalGlobalSettings?.refreshInterval)))
            : (Number(snapshot.deviceRefreshIntervals?.[cacheKey]) || Number(snapshot.liveRefreshInterval) || 0),
          ranges,
          retain: historical
            ? cache.historicalRetainAssignments?.[measurementKey] === true
            : cache.mqttRetainAssignments?.[measurementKey] === true
        });
      }
    };
    const mergeAssignments = (assignments = {}, activeAssignments = {}) => {
      const merged = {};
      for (const measurementKey of new Set([...Object.keys(assignments), ...Object.keys(activeAssignments)])) {
        const profileIds = [...new Set([
          ...(Array.isArray(assignments[measurementKey]) ? assignments[measurementKey] : []),
          ...(Array.isArray(activeAssignments[measurementKey]) ? activeAssignments[measurementKey] : [])
        ])];
        if (profileIds.length) merged[measurementKey] = profileIds;
      }
      return merged;
    };
    pushRows(mergeAssignments(cache.mqttAssignments, cache.mqttActiveAssignments), cache.mqttActiveAssignments, liveValues, false);
    pushRows(mergeAssignments(cache.historicalMqttAssignments, cache.historicalMqttActiveAssignments), cache.historicalMqttActiveAssignments, historicalValues, true);
  }

  return rows.sort((left, right) => (
    left.deviceName.localeCompare(right.deviceName, 'de', { numeric: true, sensitivity: 'base' })
    || left.name.localeCompare(right.name, 'de', { numeric: true, sensitivity: 'base' })
    || left.value.localeCompare(right.value, 'de', { numeric: true, sensitivity: 'base' })
    || left.type.localeCompare(right.type, 'de', { numeric: true, sensitivity: 'base' })
    || left.mode.localeCompare(right.mode)
  ));
}

function mqttOverviewSnapshot(snapshot = {}, project = '') {
  const rows = mqttOverviewRows(snapshot, project);
  return {
    rows,
    summary: {
      topics: rows.reduce((count, row) => count + (row.mode === 'historical' ? Math.max(1, row.ranges.length) : 1), 0),
      measurements: rows.length,
      devices: new Set(rows.map((row) => row.deviceId)).size,
      active: rows.filter((row) => row.active).length
    }
  };
}

function logDiscoveryStateCommit(previousState, committedState, { source, clientMutationVersion, deviceKey = '' } = {}) {
  const previousKeys = activeDiscoveryKeysFromState(previousState);
  const nextKeys = activeDiscoveryKeysFromState(committedState);
  const added = [...nextKeys].filter((key) => !previousKeys.has(key));
  const removed = [...previousKeys].filter((key) => !nextKeys.has(key));
  if (!added.length && !removed.length) return;
  logbook.info('backend.state-commit', {
    source,
    deviceKey,
    clientMutationVersion: Number.isFinite(Number(clientMutationVersion)) ? Number(clientMutationVersion) : null,
    discoveryBefore: previousKeys.size,
    discoveryAfter: nextKeys.size,
    discoveryAdded: added.length,
    discoveryRemoved: removed.length
  });
}

async function publishStateDiscoveryForBroker(brokerId) {
  if (!gridvis.configured) {
    logbook.info('mqtt.broker-sync', { brokerId, phase: 'discovery-skipped', reason: 'gridvis-disconnected' });
    return { published: 0, queued: 0 };
  }
  const messages = activeDiscoveryMessagesFromState(getState())
    .filter((message) => (message.brokerId || 'default') === brokerId);
  if (!messages.length) {
    // The backend state is authoritative. As a safety net for a process that
    // reconnects before its first state read has completed, replay only the
    // still-active retained registry entries. Removed entries are already
    // marked inactive and are cleaned up by replayRetainedDiscovery().
    await mqtt.replayRetainedDiscovery(brokerId);
    logbook.warning('mqtt.broker-sync', {
      brokerId,
      phase: 'discovery-replayed-from-retained-registry',
      reason: 'no-active-discovery-in-backend-state'
    });
    return { published: 0, queued: 0 };
  }
  const result = await mqtt.publishDiscovery(messages, { force: true });
  logbook.info('mqtt.broker-sync', {
    brokerId,
    phase: 'discovery',
    messages: messages.length,
    published: result.published,
    queued: result.queued
  });
  console.info(`MQTT-Discovery beim Verbindungsaufbau veröffentlicht: ${result.published} gesendet, ${result.queued} vorgemerkt.`);
  return result;
}

function activeLiveJobsFromState(snapshot = {}, brokerId = '') {
  const measurementCaches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const deviceCaches = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const profiles = Array.isArray(getConfig().mqtt.profiles) ? getConfig().mqtt.profiles : [];
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const defaultRefreshInterval = Number(snapshot.liveRefreshInterval) || 0;
  const deviceRefreshIntervals = snapshot.deviceRefreshIntervals && typeof snapshot.deviceRefreshIntervals === 'object'
    ? snapshot.deviceRefreshIntervals
    : {};
  const jobs = [];

  for (const [cacheKey, cache] of Object.entries(measurementCaches)) {
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const project = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    const device = (deviceCaches[project] || []).find((entry) => stateItemId(entry) === deviceId) || { id: deviceId };
    const measurements = new Map((cache.onlineValues || [])
      .filter((measurement) => measurement?.value !== undefined && measurement?.type !== undefined)
      .map((measurement) => [`${measurement.value}:${measurement.type}`, measurement]));

    for (const [measurementKey, assignedProfileIds] of Object.entries(cache.mqttActiveAssignments || {})) {
      const measurement = measurements.get(measurementKey);
      if (!measurement || !Array.isArray(assignedProfileIds)) continue;
      const profileIds = [...new Set(assignedProfileIds)].filter((profileId) => {
        const profile = profileMap.get(profileId);
        return profile
          && profile.enabled !== false
          && profile.mode === 'homeassistant'
          && (!brokerId || (profile.brokerId || 'default') === brokerId);
      });
      if (!profileIds.length) continue;
      const deviceRefreshInterval = Number(deviceRefreshIntervals[cacheKey]) || 0;
      jobs.push({
        project,
        deviceId,
        device,
        measurement,
        profileIds,
        retainState: cache.mqttRetainAssignments?.[measurementKey] === true,
        refreshInterval: LIVE_REFRESH_INTERVALS.has(deviceRefreshInterval)
          ? deviceRefreshInterval
          : (LIVE_REFRESH_INTERVALS.has(defaultRefreshInterval) ? defaultRefreshInterval : 0),
        key: `${cacheKey}::${measurementKey}`
      });
    }
  }

  return jobs;
}

function onlineApiValue(data, measurement, deviceId) {
  const entries = normalizeOnlineValues(data);
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const valueType = entry?.valueType || entry?.value_type || {};
    const entryDeviceId = entry?.deviceId ?? entry?.device?.id ?? entry?.device?.deviceId;
    const value = valueType.value ?? valueType.name ?? entry?.valueName;
    const type = valueType.type ?? valueType.typeName ?? entry?.type;
    if (String(entryDeviceId) !== String(deviceId)
      || String(value) !== String(measurement.value)
      || String(type) !== String(measurement.type)) continue;
    if (entry.value === undefined || entry.value === null || entry.value === '') return null;
    return {
      value: entry.value,
      time: entry.time || entry.timestamp || ''
    };
  }
  return null;
}

async function publishCachedLiveValuesForBroker(snapshot, brokerId, messageKeys = null) {
  const jobs = activeLiveJobsFromState(snapshot, brokerId);
  const messages = jobs.flatMap((job) => {
    const cached = liveValueCache.get(liveValueCacheKey(
      job.project,
      job.deviceId,
      job.measurement.value,
      job.measurement.type
    ));
    if (!cached) return [];
    return buildDiscoveryMessagesForRequest({
      project: job.project,
      device: job.device,
      measurements: [{
        ...job.measurement,
        device: job.device,
        mqttProfileIds: job.profileIds,
        liveValue: cached.value,
        liveTime: cached.time,
        retainState: job.retainState
      }]
    }, { prefix: 'homeassistant' }).filter((message) => !messageKeys || messageKeys.has(discoveryMessageKey(message)));
  });
  logbook.info('mqtt.live-cache', {
    brokerId,
    phase: 'start',
    jobs: jobs.length,
    messages: messages.length,
    discoveryFilterKeys: messageKeys ? messageKeys.size : null
  });
  if (!messages.length) {
    logbook.info('mqtt.live-cache', { brokerId, phase: 'skipped', reason: 'no-cached-values' });
    return 0;
  }
  const published = await mqtt.publishValues(messages);
  logbook[published > 0 ? 'success' : 'warning']('mqtt.live-cache', {
    brokerId,
    phase: 'complete',
    messages: messages.length,
    published,
    reason: published > 0 ? undefined : 'mqtt-publisher-filtered'
  });
  return published;
}

async function publishLiveValuesForBroker(snapshot, brokerId, messageKeys = null, { force = false, onlyMissing = false } = {}) {
  if (!gridvis.configured || !mqtt.isBrokerConnected(brokerId)) return 0;
  const now = Date.now();
  let jobs = activeLiveJobsFromState(snapshot, brokerId).filter((job) => {
    if (force) return true;
    if (!job.refreshInterval) return false;
    const lastRequestedAt = liveLastRequestedAt.get(`${brokerId}|${job.key}`) || 0;
    return now - lastRequestedAt >= job.refreshInterval * 1000;
  });
  if (onlyMissing) {
    jobs = jobs.filter((job) => !liveValueCache.has(liveValueCacheKey(
      job.project,
      job.deviceId,
      job.measurement.value,
      job.measurement.type
    )));
  }
  if (messageKeys) {
    // A state change can concern only historical discovery. Do not query all
    // live devices first and discard their messages afterwards.
    jobs = jobs.filter((job) => buildDiscoveryMessagesForRequest({
      project: job.project,
      device: job.device,
      measurements: [{
        ...job.measurement,
        device: job.device,
        mqttProfileIds: job.profileIds,
        liveValue: '',
        retainState: job.retainState
      }]
    }, { prefix: 'homeassistant' }).some((message) => messageKeys.has(discoveryMessageKey(message))));
  }
  if (!jobs.length) return 0;
  const grouped = new Map();
  for (const job of jobs) {
    if (!grouped.has(job.project)) grouped.set(job.project, []);
    grouped.get(job.project).push(job);
  }

  const counts = await Promise.all([...grouped].map(async ([project, projectJobs]) => {
    try {
      for (const job of projectJobs) liveLastRequestedAt.set(`${brokerId}|${job.key}`, now);
      const values = [...new Set(projectJobs.map((job) => `${job.deviceId};${job.measurement.value};${job.measurement.type}`))];
      const data = await gridvis.getOnlineValues({ project, values, timeout: 500 });
      const liveResults = projectJobs.map((job) => {
        const result = onlineApiValue(data, job.measurement, job.deviceId);
        if (!result) return { job, result: null, messages: [] };
        const built = buildDiscoveryMessagesForRequest({
          project: job.project,
          device: job.device,
          measurements: [{
            ...job.measurement,
            device: job.device,
            mqttProfileIds: job.profileIds,
            liveValue: result.value,
            liveTime: result.time,
            retainState: job.retainState
          }]
        }, { prefix: 'homeassistant' });
        return {
          job,
          result,
          messages: messageKeys
            ? built.filter((message) => messageKeys.has(discoveryMessageKey(message)))
            : built
        };
      });
      const messages = liveResults.flatMap((entry) => entry.messages);
      if (!messages.length) return 0;
      const published = await mqtt.publishValues(messages);
      // Cache only values that were actually handed to MQTT successfully.
      // The browser uses this same backend cache for MQTT-active cards.
      if (published) {
        for (const entry of liveResults) {
          if (entry.result && entry.messages.length) {
            cacheLiveValue(project, entry.job.deviceId, entry.job.measurement, entry.result);
          }
        }
      }
      return published;
    } catch (error) {
      console.warn(`Live-MQTT-Werte für Broker ${brokerId} konnten nicht aktualisiert werden:`, error.message);
      return 0;
    }
  }));

  const published = counts.reduce((sum, count) => sum + count, 0);
  if (published) console.info(`Live-MQTT-Werte für Broker ${brokerId} veröffentlicht: ${published} Zustände.`);
  return published;
}

async function refreshLiveValuesForBroker(brokerId, { force = false, onlyMissing = false, snapshot = getState() } = {}) {
  if (liveRefreshInFlight.has(brokerId)) return liveRefreshInFlight.get(brokerId);
  const request = publishLiveValuesForBroker(snapshot, brokerId, null, { force, onlyMissing })
    .finally(() => liveRefreshInFlight.delete(brokerId));
  liveRefreshInFlight.set(brokerId, request);
  return request;
}

async function refreshLiveValuesForConnectedBrokers({ force = false, snapshot = getState() } = {}) {
  const brokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
  await Promise.all(brokers.map((broker) => refreshLiveValuesForBroker(broker.id, { force, snapshot })));
}

function scheduleLiveRefresh() {
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = null;
  if (!gridvis.configured) return;
  const snapshot = getState();
  const jobs = activeLiveJobsFromState(snapshot).filter((job) => job.refreshInterval > 0);
  const brokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
  if (!jobs.length || !brokers.length) return;

  const now = Date.now();
  const delays = brokers.flatMap((broker) => jobs.map((job) => {
    const lastRequestedAt = liveLastRequestedAt.get(`${broker.id}|${job.key}`) || 0;
    return Math.max(0, job.refreshInterval * 1000 - (now - lastRequestedAt));
  }));
  const delay = Math.max(250, Math.min(...delays));
  liveRefreshTimer = setTimeout(async () => {
    try {
      await refreshLiveValuesForConnectedBrokers();
    } catch (error) {
      logbook.error('gridvis.live-refresh', { error: error.message });
    } finally {
      scheduleLiveRefresh();
    }
  }, delay);
}

function isBridgeDiscoveryMessage(message) {
  return message?.nodeId === 'gridvis2mqtt' && String(message?.uniqueId || '').startsWith('gridvis2mqtt_bridge_');
}

function isDeviceInfoDiscoveryMessage(message) {
  return !isBridgeDiscoveryMessage(message) && String(message?.objectId || '').startsWith('device_info_');
}

async function publishBridgeValuesForBroker(snapshot, brokerId, messageKeys = null) {
  const messages = activeDiscoveryMessagesFromState(snapshot)
    .filter((message) => (message.brokerId || 'default') === brokerId)
    .filter(isBridgeDiscoveryMessage)
    .filter((message) => !messageKeys || messageKeys.has(discoveryMessageKey(message)));
  if (!messages.length) return 0;
  const published = await mqtt.publishValues(messages);
  if (published) console.info(`GridVis-Bridge-Informationen für Broker ${brokerId} veröffentlicht: ${published} Zustände.`);
  return published;
}

async function publishDeviceInfoValuesForBroker(snapshot, brokerId, messageKeys = null) {
  const messages = activeDiscoveryMessagesFromState(snapshot)
    .filter((message) => (message.brokerId || 'default') === brokerId)
    .filter(isDeviceInfoDiscoveryMessage)
    .filter((message) => !messageKeys || messageKeys.has(discoveryMessageKey(message)));
  if (!messages.length) return 0;
  const published = await mqtt.publishValues(messages);
  if (published) console.info(`Geräteinformationen für Broker ${brokerId} veröffentlicht: ${published} Zustände.`);
  return published;
}

async function publishCachedHistoricalValuesForBroker(snapshot, brokerId, messageKeys = null) {
  const jobs = historicalJobsFromState(snapshot, brokerId);
  const cachedJobs = jobs.filter((job) => historicalValueCache.has(job.key));
  const messages = jobs.flatMap((job) => {
    const cached = historicalValueCache.get(job.key);
    if (!cached) return [];
    return historicalValueMessages(job, cached.value, cached.time)
      .filter((message) => !messageKeys || messageKeys.has(discoveryMessageKey(message)));
  });
  logbook.info('mqtt.historical-cache', {
    brokerId,
    phase: 'start',
    jobs: jobs.length,
    cachedJobs: cachedJobs.length,
    messages: messages.length,
    discoveryFilterKeys: messageKeys ? messageKeys.size : null
  });
  if (!messages.length) {
    logbook.info('mqtt.historical-cache', { brokerId, phase: 'skipped', reason: 'no-cached-values' });
    return 0;
  }
  const published = await mqtt.publishValues(messages);
  if (published) console.info(`Gecachte historische MQTT-Werte für Broker ${brokerId} erneut veröffentlicht: ${published} Zustände.`);
  logbook[published > 0 ? 'success' : 'warning']('mqtt.historical-cache', {
    brokerId,
    phase: 'complete',
    messages: messages.length,
    published,
    reason: published > 0 ? undefined : 'mqtt-publisher-filtered'
  });
  return published;
}

const HISTORY_REFRESH_INTERVALS = new Set([300, 600, 900, 1800, 2700, 3600, 7200, 21600, 43200, 86400]);
const HISTORY_RANGE_EXPRESSIONS = {
  today: ['NAMED_Today', 'NAMED_Today'],
  yesterday: ['NAMED_Yesterday', 'NAMED_Yesterday'],
  last24hours: ['RELATIVE_-24HOUR', 'NAMED_Today'],
  thisweek: ['NAMED_ThisWeek', 'NAMED_Today'],
  lastweek: ['NAMED_LastWeek', 'NAMED_LastWeek'],
  thismonth: ['NAMED_ThisMonth', 'NAMED_Today'],
  lastmonth: ['NAMED_LastMonth', 'NAMED_LastMonth'],
  thisyear: ['NAMED_ThisYear', 'NAMED_Today'],
  lastyear: ['NAMED_LastYear', 'NAMED_LastYear'],
  last3months: ['RELATIVE_-3MONTH', 'NAMED_Today']
};

const HISTORY_COMPARISON_UNITS = new Set(['same', 'hours', 'days', 'weeks', 'months', 'quarters', 'years']);
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

function normalizeHistoryComparisons(comparisons) {
  const source = Array.isArray(comparisons)
    ? comparisons
    : Number(comparisons) === 1
      ? [{ unit: 'same', amount: 1 }]
      : [];
  const seen = new Set();
  const normalized = [];
  for (const item of source) {
    const unit = HISTORY_COMPARISON_UNITS.has(item?.unit) ? item.unit : '';
    if (!unit) continue;
    const range = item?.range === 'all' || Object.prototype.hasOwnProperty.call(HISTORY_RANGE_EXPRESSIONS, item?.range)
      ? item.range || 'all'
      : 'all';
    const amount = unit === 'same' ? 1 : Math.min(9999, Math.max(1, Math.trunc(Number(item?.amount) || 1)));
    const key = `${range}:${unit}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ range, unit, amount });
  }
  return normalized;
}

function comparisonRangeId(range, comparison) {
  return comparison.unit === 'same'
    ? `comparison_${range}`
    : `comparison_${range}_${comparison.unit}_${comparison.amount}`;
}

function historyComparisonDefinition(range, comparison) {
  const base = HISTORY_RANGE_EXPRESSIONS[range];
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

function historyComparisonDefinitions(comparisons = []) {
  return Object.keys(HISTORY_RANGE_EXPRESSIONS).flatMap((range) => normalizeHistoryComparisons(comparisons)
    .filter((comparison) => comparison.range === 'all' || comparison.range === range)
    .map((comparison) => historyComparisonDefinition(range, comparison))
    .filter(Boolean));
}

function historyComparisonForRange(range, comparisons = []) {
  return historyComparisonDefinitions(comparisons).find((definition) => definition.id === range);
}
let historicalRefreshTimer = null;
const historicalLastFetchedAt = new Map();
const historicalRefreshInFlight = new Map();

function normalizedHistoryInterval(value, fallback = 900) {
  const interval = Number(value);
  return HISTORY_REFRESH_INTERVALS.has(interval) ? interval : fallback;
}

function normalizedHistoryMinuteOffset(value, fallback = 0) {
  const offset = Number(value);
  return Number.isInteger(offset) && offset >= 0 && offset <= 59 ? offset : fallback;
}

function historicalScheduleSlotAtOrBefore(timestamp, interval, minuteOffset) {
  const period = normalizedHistoryInterval(interval) * 1000;
  const offset = normalizedHistoryMinuteOffset(minuteOffset) * 60 * 1000;
  const elapsed = ((timestamp - offset) % period + period) % period;
  return timestamp - elapsed;
}

function nextHistoricalScheduleAt(job, timestamp = Date.now()) {
  const period = normalizedHistoryInterval(job.interval) * 1000;
  return historicalScheduleSlotAtOrBefore(timestamp, job.interval, job.minuteOffset) + period;
}

function normalizedHistoryRanges(ranges, fallback = ['today']) {
  const valid = [...new Set((Array.isArray(ranges) ? ranges : []).filter((range) => HISTORY_RANGE_EXPRESSIONS[range]))];
  return valid.length ? valid : fallback;
}

function historicalRangeExpressions(range, comparisons = []) {
  return HISTORY_RANGE_EXPRESSIONS[range]
    || historyComparisonForRange(range, comparisons)?.expressions
    || HISTORY_RANGE_EXPRESSIONS.today;
}

function historicalUsesEnergyApi(measurement = {}) {
  const unit = String(measurement.unit || '').trim().replace('μ', 'µ').replace('VAr', 'var');
  const match = unit.match(/^[µmkMGT]?(Wh|varh|VAh|J)$/);
  if (match) return true;
  return /energy|consum|deliver|wirkarbeit|arbeit/i.test(
    `${measurement.value || ''} ${measurement.name || ''} ${measurement.typeLabel || ''}`
  );
}

function historicalRangeAnchor(range, comparisons = []) {
  return historyComparisonForRange(range, comparisons)?.anchor || '';
}

function historicalRangesWithComparison(ranges, comparisons = []) {
  const baseRanges = normalizedHistoryRanges(ranges);
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

function historicalJobsFromState(snapshot = {}, brokerId = '') {
  const measurementCaches = snapshot.measurementCache && typeof snapshot.measurementCache === 'object'
    ? snapshot.measurementCache
    : {};
  const deviceCaches = snapshot.deviceCache && typeof snapshot.deviceCache === 'object'
    ? snapshot.deviceCache
    : {};
  const globalSettings = snapshot.historicalGlobalSettings || {};
  const globalInterval = normalizedHistoryInterval(globalSettings.refreshInterval);
  const globalRanges = normalizedHistoryRanges(globalSettings.ranges);
  const globalMinuteOffset = normalizedHistoryMinuteOffset(globalSettings.minuteOffset);
  const profiles = Array.isArray(getConfig().mqtt.profiles) ? getConfig().mqtt.profiles : [];
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const jobs = [];

  for (const [cacheKey, cache] of Object.entries(measurementCaches)) {
    const separator = cacheKey.lastIndexOf('::');
    if (separator < 0) continue;
    const project = cacheKey.slice(0, separator);
    const deviceId = cacheKey.slice(separator + 2);
    const device = (deviceCaches[project] || []).find((entry) => stateItemId(entry) === deviceId) || { id: deviceId };
    const deviceDefaults = cache.historicalDefaults && typeof cache.historicalDefaults === 'object'
      ? cache.historicalDefaults
      : {};
    const deviceInterval = normalizedHistoryInterval(deviceDefaults.refreshInterval, globalInterval);
    const deviceMinuteOffset = normalizedHistoryMinuteOffset(deviceDefaults.minuteOffset, globalMinuteOffset);
    const deviceRanges = normalizedHistoryRanges(deviceDefaults.ranges, globalRanges);
    const deviceComparisons = Array.isArray(deviceDefaults.comparisons)
      ? deviceDefaults.comparisons
      : globalSettings.comparisons;
    const measurements = new Map((cache.historicalValues || [])
      .filter((measurement) => measurement?.value !== undefined && measurement?.type !== undefined)
      .map((measurement) => [`${measurement.value}:${measurement.type}`, measurement]));
    const activeAssignments = cache.historicalMqttActiveAssignments || {};

    for (const [measurementKey, assignedProfileIds] of Object.entries(activeAssignments)) {
      const measurement = measurements.get(measurementKey);
      if (!measurement || !Array.isArray(assignedProfileIds)) continue;
      const profileIds = [...new Set(assignedProfileIds)].filter((profileId) => {
        const profile = profileMap.get(profileId);
        return profile
          && profile.enabled !== false
          && profile.mode === 'homeassistant'
          && (!brokerId || (profile.brokerId || 'default') === brokerId);
      });
      if (!profileIds.length) continue;

      const settings = cache.historicalSettings?.[measurementKey] || {};
      const interval = normalizedHistoryInterval(settings.interval, deviceInterval);
      const energy = historicalUsesEnergyApi(measurement);
      const comparisons = Array.isArray(settings.comparisons)
        ? settings.comparisons
        : deviceComparisons;
      const ranges = historicalRangesWithComparison(
        Array.isArray(settings.ranges) && settings.ranges.length ? settings.ranges : deviceRanges,
        comparisons
      );
      for (const range of ranges) {
        jobs.push({
          key: `${project}::${deviceId}::${measurementKey}::${range}`,
          project,
          deviceId,
          device,
          measurement,
          range,
          interval,
          energy,
          profileIds,
          comparisons,
          minuteOffset: deviceMinuteOffset,
          retainState: cache.historicalRetainAssignments?.[measurementKey] === true
        });
      }
    }
  }

  return jobs;
}

function usableHistoricalValue(value, measurement) {
  if (value === null || value === undefined || value === '' || value === measurement.value) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  if (typeof value === 'string' && !value.trim()) return '';
  return value;
}

function historicalApiValue(data, measurement, { energy = false } = {}) {
  if (Array.isArray(data)) {
    for (const item of [...data].reverse()) {
      const value = historicalApiValue(item, measurement, { energy });
      if (value !== '') return value;
    }
    return '';
  }
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') return usableHistoricalValue(data, measurement);

  const valueKeys = energy
    // The current /histenergy endpoint returns the numeric reading as
    // values[].value. Older response variants used more descriptive names.
    ? ['energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'value']
    : [
      'energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'total',
      'avg', 'value', 'reading', 'measuredValue', 'measurementValue', 'actualValue',
      'sum', 'result'
    ];
  for (const key of valueKeys) {
    if (data[key] === undefined) continue;
    const value = historicalApiValue(data[key], measurement, { energy });
    if (value !== '') return value;
  }
  for (const key of ['data', 'response', 'payload', 'values']) {
    if (data[key] === undefined) continue;
    const value = historicalApiValue(data[key], measurement, { energy });
    if (value !== '') return value;
  }
  return '';
}

function historicalEnergyTotal(data, measurement) {
  if (Array.isArray(data)) {
    const values = data
      .map((item) => historicalApiValue(item, measurement, { energy: true }))
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) : '';
  }
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') {
    const value = usableHistoricalValue(data, measurement);
    const numeric = Number(value);
    return value !== '' && Number.isFinite(numeric) ? numeric : '';
  }

  // The current histenergy response contains one interval reading per entry
  // in values[].value. The requested period's consumption is their sum.
  if (Array.isArray(data.values)) return historicalEnergyTotal(data.values, measurement);

  for (const key of ['energy', 'consumption', 'consumptionValue', 'energyValue', 'amount', 'value']) {
    if (data[key] === undefined || typeof data[key] === 'object') continue;
    const value = usableHistoricalValue(data[key], measurement);
    const numeric = Number(value);
    if (value !== '' && Number.isFinite(numeric)) return numeric;
  }
  for (const key of ['data', 'response', 'payload', 'result']) {
    if (data[key] === undefined) continue;
    const value = historicalEnergyTotal(data[key], measurement);
    if (value !== '') return value;
  }
  return '';
}

function historicalApiTime(data) {
  if (!data || typeof data !== 'object') return '';
  for (const key of ['endTime', 'timestamp', 'time', 'datetime', 'date', 'startTime']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const milliseconds = value > 1e14 ? value / 1e6 : value > 1e11 ? value : value * 1000;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof value === 'string' && value.trim()) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  for (const key of ['data', 'response', 'payload', 'result', 'values']) {
    const nested = historicalApiTime(data[key]);
    if (nested) return nested;
  }
  return '';
}

function historicalValueMessages(job, value, time) {
  return buildDiscoveryMessagesForRequest({
    project: job.project,
    device: job.device,
    measurements: [{
      ...job.measurement,
      device: job.device,
      historical: true,
      historyRange: job.range,
      mqttProfileIds: job.profileIds,
      liveValue: value,
      liveTime: time,
      retainState: job.retainState
    }]
  }, { prefix: 'homeassistant' });
}

async function refreshHistoricalValuesForBroker(brokerId, {
  force = false,
  scheduled = false,
  onlyMissing = false,
  messageKeys = null,
  snapshot = getState()
} = {}) {
  if (historicalRefreshInFlight.has(brokerId)) return historicalRefreshInFlight.get(brokerId);
  const promise = (async () => {
    const brokerConnected = mqtt.isBrokerConnected(brokerId);
    const availableJobs = historicalJobsFromState(snapshot, brokerId);
    logbook.info('mqtt.historical-refresh', {
      brokerId,
      phase: 'start',
      force,
      scheduled,
      gridvisConfigured: gridvis.configured,
      brokerConnected,
      availableJobs: availableJobs.length,
      discoveryFilterKeys: messageKeys ? messageKeys.size : null
    });
    if (!gridvis.configured) {
      logbook.warning('mqtt.historical-refresh', {
        brokerId,
        phase: 'skipped',
        reason: 'gridvis-not-configured',
        availableJobs: availableJobs.length
      });
      return { requested: 0, published: 0, errors: 0 };
    }
    if (!brokerConnected) {
      logbook.warning('mqtt.historical-refresh', {
        brokerId,
        phase: 'skipped',
        reason: 'broker-not-connected',
        availableJobs: availableJobs.length
      });
      return { requested: 0, published: 0, errors: 0 };
    }
    const now = Date.now();
    const dueJobs = availableJobs
      .filter((job) => {
        const lastFetchedAt = historicalLastFetchedAt.get(`${brokerId}|${job.key}`) || 0;
        const due = scheduled
          ? lastFetchedAt < historicalScheduleSlotAtOrBefore(now, job.interval, job.minuteOffset)
          : now - lastFetchedAt >= job.interval * 1000;
        return (force || due) && (!onlyMissing || !historicalValueCache.has(job.key));
      });
    const jobs = dueJobs
      .filter((job) => !messageKeys || historicalValueMessages(job, '', '').some((message) => messageKeys.has(discoveryMessageKey(message))));
    logbook.info('mqtt.historical-refresh', {
      brokerId,
      phase: 'jobs-selected',
      availableJobs: availableJobs.length,
      dueJobs: dueJobs.length,
      selectedJobs: jobs.length,
      force,
      scheduled
    });
    if (!jobs.length) {
      logbook.warning('mqtt.historical-refresh', {
        brokerId,
        phase: 'skipped',
        reason: availableJobs.length ? (dueJobs.length ? 'discovery-filter-empty' : 'interval-not-due') : 'no-active-jobs',
        availableJobs: availableJobs.length,
        dueJobs: dueJobs.length
      });
      return { requested: 0, published: 0, errors: 0 };
    }

    // GridVis aborts a large batch of history requests after roughly 15
    // seconds. Keep the requests in a small, predictable queue instead of
    // opening one connection per measurement/range at broker startup.
    const results = await mapWithConcurrency(jobs, HISTORICAL_REFRESH_CONCURRENCY, async (job) => {
      try {
        const comparisons = job.comparisons || snapshot.historicalGlobalSettings?.comparisons || [];
        const [start, end] = historicalRangeExpressions(job.range, comparisons);
        const data = await gridvis.getHistory({
          project: job.project,
          deviceId: job.deviceId,
          value: job.measurement.value,
          type: job.measurement.type,
          start,
          end,
          energy: job.energy
        });
        const value = job.energy
          ? historicalEnergyTotal(data, job.measurement)
          : historicalApiValue(data, job.measurement, { energy: false });
        if (value === '') {
          // A 204/empty response means that the current value is genuinely
          // unavailable. Do not keep or replay an older value for this job.
          historicalValueCache.delete(job.key);
          console.warn(`Kein historischer Wert für ${job.measurement.value}/${job.measurement.type} (${job.range}) erhalten.`);
          logbook.warning('gridvis.historical-empty', {
            project: job.project,
            deviceId: job.deviceId,
            value: job.measurement.value,
            type: job.measurement.type,
            range: job.range,
            energy: job.energy,
            responseType: Array.isArray(data) ? 'array' : typeof data,
            responseKeys: data && typeof data === 'object' && !Array.isArray(data)
              ? Object.keys(data).slice(0, 12)
              : []
          });
          return { job, published: 0, empty: true };
        }
        const messages = historicalValueMessages(job, value, historicalApiTime(data));
        const activeKeys = new Set(activeDiscoveryMessagesFromState(getState()).map(discoveryMessageKey));
        const currentMessages = messages.filter((message) => activeKeys.has(discoveryMessageKey(message)));
        if (!currentMessages.length) {
          logbook.warning('mqtt.historical-refresh', {
            brokerId,
            phase: 'skipped',
            reason: 'discovery-not-active',
            project: job.project,
            deviceId: job.deviceId,
            value: job.measurement.value,
            type: job.measurement.type,
            range: job.range,
            activeDiscoveryMessages: activeKeys.size
          });
          return { job, published: 0, stale: true };
        }
        cacheHistoricalValue(job, value, historicalApiTime(data));
        const published = await mqtt.publishValues(currentMessages);
        if (!published) {
          logbook.warning('mqtt.historical-refresh', {
            brokerId,
            phase: 'not-published',
            reason: 'mqtt-publisher-filtered',
            project: job.project,
            deviceId: job.deviceId,
            value: job.measurement.value,
            type: job.measurement.type,
            range: job.range
          });
        }
        return { job, published };
      } catch (error) {
        console.warn(`Historischer Messwert ${job.measurement.value}/${job.measurement.type} (${job.range}) konnte nicht veröffentlicht werden:`, error.message);
        logbook.warning('gridvis.historical-error', {
          project: job.project,
          deviceId: job.deviceId,
          value: job.measurement.value,
          type: job.measurement.type,
          range: job.range,
          energy: job.energy,
          error: error.message
        });
        return { job, published: 0, error };
      }
    });

    for (const result of results) {
      if (!result.error) historicalLastFetchedAt.set(`${brokerId}|${result.job.key}`, now);
    }
    const published = results.reduce((sum, result) => sum + result.published, 0);
    console.info(`Historische MQTT-Werte für Broker ${brokerId} aktualisiert: ${published} Zustände.`);
    const errors = results.filter((result) => result.error).length;
    const empty = results.filter((result) => result.empty).length;
    const stale = results.filter((result) => result.stale).length;
    logbook[published > 0 ? 'success' : 'warning']('mqtt.historical-refresh', {
      brokerId,
      phase: 'complete',
      requested: jobs.length,
      published,
      errors,
      empty,
      stale
    });
    return {
      requested: jobs.length,
      published,
      errors
    };
  })().finally(() => historicalRefreshInFlight.delete(brokerId));
  historicalRefreshInFlight.set(brokerId, promise);
  return promise;
}

async function refreshHistoricalValuesForConnectedBrokers({ force = false, scheduled = false, messageKeys = null, snapshot = getState(), retryInFlight = false } = {}) {
  const brokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
  logbook.info('mqtt.historical-cycle', {
    phase: 'start',
    force,
    scheduled,
    connectedBrokers: brokers.map((broker) => broker.id),
    discoveryFilterKeys: messageKeys ? messageKeys.size : null,
    retryInFlight
  });
  if (!brokers.length) {
    logbook.warning('mqtt.historical-cycle', { phase: 'skipped', reason: 'no-connected-broker', force, scheduled });
    return { requested: 0, published: 0, errors: 0 };
  }
  if (retryInFlight) {
    await Promise.all(brokers
      .map((broker) => historicalRefreshInFlight.get(broker.id))
      .filter(Boolean));
  }
  const results = await Promise.all(brokers.map((broker) => refreshHistoricalValuesForBroker(broker.id, {
    force,
    scheduled,
    messageKeys,
    snapshot
  })));
  const summary = results.reduce((summary, result) => ({
    requested: summary.requested + Number(result?.requested || 0),
    published: summary.published + Number(result?.published || 0),
    errors: summary.errors + Number(result?.errors || 0)
  }), { requested: 0, published: 0, errors: 0 });
  logbook.info('mqtt.historical-cycle', { phase: 'complete', ...summary });
  return summary;
}

function scheduleHistoricalRefresh() {
  if (historicalRefreshTimer) clearTimeout(historicalRefreshTimer);
  historicalRefreshTimer = null;
  if (!gridvis.configured) {
    logbook.info('mqtt.historical-scheduler', {
      phase: 'disabled',
      reason: 'gridvis-disconnected'
    });
    return;
  }
  const jobs = historicalJobsFromState(getState());
  const brokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
  if (!brokers.length) {
    logbook.info('mqtt.historical-scheduler', {
      phase: 'disabled',
      reason: 'no-connected-broker'
    });
    return;
  }
  const now = Date.now();
  const nextRunAt = Math.min(...jobs
    .filter((job) => job.interval > 0)
    .map((job) => nextHistoricalScheduleAt(job, now)));
  if (!Number.isFinite(nextRunAt)) {
    logbook.warning('mqtt.historical-scheduler', {
      phase: 'disabled',
      reason: 'no-active-jobs',
      jobs: jobs.length
    });
    return;
  }
  const nextRunInMs = Math.max(250, nextRunAt - now);
  logbook.info('mqtt.historical-scheduler', {
    phase: 'scheduled',
    jobs: jobs.length,
    intervals: [...new Set(jobs.map((job) => job.interval))].sort((a, b) => a - b),
    minuteOffsets: [...new Set(jobs.map((job) => job.minuteOffset))].sort((a, b) => a - b),
    nextRunInMs
  });
  historicalRefreshTimer = setTimeout(async () => {
    try {
      await refreshHistoricalValuesForConnectedBrokers({ scheduled: true });
    } catch (error) {
      logbook.error('mqtt.historical-cycle', { phase: 'error', error: error.message });
    } finally {
      scheduleHistoricalRefresh();
    }
  }, nextRunInMs);
}

async function handleBrokerConnected(brokerId) {
  try {
    // A browser state commit may still be in flight while the MQTT socket
    // connects. Read the authoritative state only after that commit has
    // finished, otherwise the reconnect can legitimately see zero active
    // measurements and publish nothing.
    await stateMutationQueue.catch(() => {});
    const initialSnapshot = getState();
    const initialDiscoveryMessages = activeDiscoveryMessagesFromState(initialSnapshot)
      .filter((message) => (message.brokerId || 'default') === brokerId);
    const liveJobs = activeLiveJobsFromState(initialSnapshot, brokerId);
    const historicalJobs = historicalJobsFromState(initialSnapshot, brokerId);
    const missingLiveJobs = liveJobs.filter((job) => !liveValueCache.has(liveValueCacheKey(
      job.project,
      job.deviceId,
      job.measurement.value,
      job.measurement.type
    )));
    const missingHistoricalJobs = historicalJobs.filter((job) => !historicalValueCache.has(job.key));
    logbook.info('mqtt.broker-sync', {
      brokerId,
      phase: 'start',
      discoveryMessages: initialDiscoveryMessages.length,
      liveJobs: liveJobs.length,
      liveCacheJobs: liveJobs.length - missingLiveJobs.length,
      historicalJobs: historicalJobs.length,
      historicalCacheJobs: historicalJobs.length - missingHistoricalJobs.length,
      noTimebase: true
    });
    if (!gridvis.configured) {
      logbook.warning('mqtt.broker-sync', { brokerId, phase: 'skipped', reason: 'gridvis-disconnected' });
      return;
    }
    // Reconnects must be fast and independent of the browser. Replay the
    // backend-owned Discovery and cached values first. Only values that are
    // not cached yet need an initial GridVis request; a reconnect must not
    // refetch every active live/history job unconditionally.
    await publishStateDiscoveryForBroker(brokerId);
    await mqtt.cleanupInactiveRetainedDiscovery(brokerId);
    await waitForMqttState();
    await publishBridgeValuesForBroker(getState(), brokerId);
    await publishDeviceInfoValuesForBroker(getState(), brokerId);
    await publishCachedLiveValuesForBroker(getState(), brokerId);
    // Discovery may be recreated while the process is still running. Replay
    // already cached history values immediately instead of waiting for the
    // next historical queue cycle.
    await publishCachedHistoricalValuesForBroker(getState(), brokerId);
    logbook.success('mqtt.broker-sync', {
      brokerId,
      phase: 'cache-complete',
      missingLiveJobs: missingLiveJobs.length,
      missingHistoricalJobs: missingHistoricalJobs.length
    });

    // The following work is deliberately detached from the connection event.
    // It may take many seconds/minutes and must not hold up the initial
    // retained Discovery/value replay or the frontend request.
    const backgroundTasks = [];
    logbook.info('backend.information-refresh', {
      phase: 'skipped',
      reason: 'broker-reconnect-cache-sync',
      brokerId,
      note: 'Der reguläre DeviceInfo-Zyklus bleibt unabhängig aktiv.'
    });
    if (missingLiveJobs.length) {
      backgroundTasks.push(refreshLiveValuesForBroker(brokerId, {
        force: true,
        onlyMissing: true,
        snapshot: getState()
      }).catch((error) => logbook.error('gridvis.live-refresh', { brokerId, error: error.message })));
    } else {
      logbook.info('gridvis.live-refresh', { brokerId, phase: 'skipped', reason: 'all-values-cached' });
    }
    if (missingHistoricalJobs.length) {
      backgroundTasks.push(refreshHistoricalValuesForBroker(brokerId, {
        force: true,
        onlyMissing: true,
        snapshot: getState()
      }).then((historicalResult) => {
        logbook.info('mqtt.broker-sync', {
          brokerId,
          phase: 'historical-initial-complete',
          requested: historicalResult.requested,
          published: historicalResult.published,
          errors: historicalResult.errors
        });
      }).catch((error) => logbook.error('mqtt.historical-refresh', { brokerId, error: error.message })));
    } else {
      logbook.info('mqtt.historical-refresh', { brokerId, phase: 'skipped', reason: 'all-values-cached' });
    }
    void Promise.allSettled(backgroundTasks).then(() => {
      scheduleHistoricalRefresh();
      scheduleLiveRefresh();
      logbook.info('mqtt.broker-sync', { brokerId, phase: 'background-complete' });
    });

    // Start the continuous schedulers immediately. Their next run is based on
    // the configured intervals and the last request timestamp, not on the
    // completion of the information scan.
    scheduleLiveRefresh();
    scheduleHistoricalRefresh();
    logbook.success('mqtt.broker-sync', { brokerId, phase: 'complete' });
  } catch (error) {
    logbook.error('mqtt.broker-sync', { brokerId, phase: 'error', error: error.message });
    throw error;
  }
}

async function syncNewStateToConnectedBrokers(previousState, nextState, {
  previousMessages: suppliedPreviousMessages = null,
  nextMessages: suppliedNextMessages = null
} = {}) {
  if (!gridvis.configured) {
    logbook.info('mqtt.discovery.sync', { messages: 0, brokers: 0, reason: 'gridvis-disconnected' });
    return { discoveryChanged: false, valuesPublishedFor: new Set() };
  }
  const previousMessages = suppliedPreviousMessages || activeDiscoveryMessagesFromState(previousState);
  const previousDiscoveryKeys = new Set(previousMessages.map(discoveryMessageKey));
  const previousMessagesByKey = new Map(previousMessages.map((message) => [discoveryMessageKey(message), message]));
  const nextMessages = suppliedNextMessages || activeDiscoveryMessagesFromState(nextState);
  // An information refresh may have started before a checkbox change and
  // finish much later. Only publish messages that still match the currently
  // committed backend state; otherwise that stale refresh can recreate a
  // Discovery entry immediately after it was removed.
  const currentMessagesByKey = new Map(activeDiscoveryMessagesFromState(getState())
    .map((message) => [discoveryMessageKey(message), message]));
  const newMessages = nextMessages.filter((message) => {
    const key = discoveryMessageKey(message);
    const current = currentMessagesByKey.get(key);
    if (!current || discoveryMessageSignature(current) !== discoveryMessageSignature(message)) return false;
    return !previousDiscoveryKeys.has(key)
      || discoveryMessageSignature(previousMessagesByKey.get(key)) !== discoveryMessageSignature(message);
  });
  if (!newMessages.length) {
    logbook.info('mqtt.discovery.sync', {
      messages: 0,
      previousMessages: previousMessages.length,
      nextMessages: nextMessages.length,
      reason: previousMessages.length === nextMessages.length ? 'no-discovery-change' : 'state-has-no-active-discovery'
    });
    return { discoveryChanged: false, valuesPublishedFor: new Set() };
  }

  const brokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
  if (!brokers.length) {
    logbook.warning('mqtt.discovery.sync', {
      messages: newMessages.length,
      brokers: 0,
      reason: 'no-connected-broker'
    });
  }
  const valuesPublishedFor = new Set();
  await Promise.all(brokers.map(async (broker) => {
    const brokerMessages = newMessages.filter((message) => (message.brokerId || 'default') === broker.id);
    if (!brokerMessages.length) return;
    const result = await mqtt.publishDiscovery(brokerMessages);
    if (!result.published) return;
    const messageKeys = new Set(brokerMessages.map(discoveryMessageKey));
    await publishBridgeValuesForBroker(nextState, broker.id, messageKeys);
    await publishDeviceInfoValuesForBroker(nextState, broker.id, messageKeys);
    await publishCachedHistoricalValuesForBroker(nextState, broker.id, messageKeys);
    // A selection change only changes Discovery. Do not start a new GridVis
    // value request here: the opened device already has its display cache and
    // the regular live/history scheduler will publish the next MQTT value.
    // This keeps a checkbox change independent from every other MQTT device.
    valuesPublishedFor.add(broker.id);
  }));
  logbook.info('mqtt.discovery.sync', { messages: newMessages.length, brokers: brokers.length });
  return { discoveryChanged: true, valuesPublishedFor };
}

mqtt.reconcileRetainedDiscovery(activeDiscoveryKeysFromState(getState()));
scheduleHistoricalRefresh();
scheduleInformationRefresh();
if (config.gridvis?.baseUrl) {
  refreshBackendInformation({ force: true, publish: true }).catch((error) => {
    logbook.error('backend.information-refresh', { error: error.message });
  });
}
if (config.mqtt.brokers?.some((broker) => broker.enabled !== false && broker.url)) mqtt.connect(config.mqtt);
scheduleLiveRefresh();

const deviceIconCache = new Map();
const deviceIconRequests = new Map();
const DEVICE_ICON_CACHE_LIMIT = 256;
const deviceIconCacheDir = process.env.GRIDVIS2MQTT_ICON_CACHE_DIR
  || join(root, 'data', 'device-icons');

function deviceIconCacheKey(project, deviceId) {
  return `${gridvis.baseUrl}::${project}::${deviceId}`;
}

function deviceIconCachePath(key) {
  const filename = createHash('sha256').update(key).digest('hex') + '.json';
  return join(deviceIconCacheDir, filename);
}

async function readPersistentDeviceIcon(key) {
  try {
    const record = JSON.parse(await readFile(deviceIconCachePath(key), 'utf8'));
    if (!record || typeof record.body !== 'string' || !record.body.length) return null;
    return {
      body: Buffer.from(record.body, 'base64'),
      contentType: String(record.contentType || 'application/octet-stream')
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Geräteicon-Cache konnte nicht gelesen werden:', error.message);
    return null;
  }
}

async function writePersistentDeviceIcon(key, icon) {
  try {
    await mkdir(deviceIconCacheDir, { recursive: true });
    await writeFile(deviceIconCachePath(key), JSON.stringify({
      contentType: icon.contentType,
      body: icon.body.toString('base64')
    }), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // The in-memory cache still works if the persistent cache directory is
    // temporarily unavailable; serving an icon must not fail because of it.
    console.warn('Geräteicon-Cache konnte nicht gespeichert werden:', error.message);
  }
}

async function getCachedDeviceIcon(project, deviceId) {
  const key = deviceIconCacheKey(project, deviceId);
  const cached = deviceIconCache.get(key);
  if (cached) {
    deviceIconCache.delete(key);
    deviceIconCache.set(key, cached);
    return cached;
  }
  const pending = deviceIconRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const persistent = await readPersistentDeviceIcon(key);
    if (persistent) {
      deviceIconCache.set(key, persistent);
      return persistent;
    }
    const icon = await gridvis.getDeviceIcon(project, deviceId);
    deviceIconCache.set(key, icon);
    while (deviceIconCache.size > DEVICE_ICON_CACHE_LIMIT) {
      deviceIconCache.delete(deviceIconCache.keys().next().value);
    }
    await writePersistentDeviceIcon(key, icon);
    return icon;
  })().finally(() => deviceIconRequests.delete(key));

  deviceIconRequests.set(key, request);
  return request;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  sendJson(response, 502, { ok: false, error: error.message });
}

function getClientConfig() {
  const publicConfig = getPublicConfig();
  const mqttSnapshot = mqtt.getSnapshot();
  return {
    ...publicConfig,
    gridvis: {
      ...publicConfig.gridvis,
      connection: gridvis.getSnapshot()
    },
    mqtt: {
      ...publicConfig.mqtt,
      connection: mqttSnapshot
    }
  };
}

function createBackup(includeConnections = false) {
  const backup = {
    format: 'gridvis2mqtt-backup',
    formatVersion: 1,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    includes: {
      state: true,
      connections: includeConnections
    },
    state: getState()
  };
  if (includeConnections) backup.config = getConfig();
  return backup;
}

function validateBackup(input) {
  if (!input || typeof input !== 'object' || input.format !== 'gridvis2mqtt-backup' || input.formatVersion !== 1) {
    throw new Error('Ungültiges oder nicht unterstütztes GridVis2MQTT-Backup.');
  }
  if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) {
    throw new Error('Das Backup enthält keinen gültigen Anwendungszustand.');
  }
  if (input.includes?.connections && (!input.config || typeof input.config !== 'object' || Array.isArray(input.config))) {
    throw new Error('Das Backup markiert Verbindungsdaten, enthält aber keine gültige Konfiguration.');
  }
}

async function checkForUpdates() {
  const result = {
    currentVersion: APP_VERSION,
    supported: false,
    remote: '',
    updateAvailable: false,
    commitsBehind: 0,
    dirty: false,
    message: 'Kein Git-Remote eingerichtet.'
  };
  try {
    await execFile('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
    const remote = await execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    result.remote = remote.stdout.trim();
    result.supported = Boolean(result.remote);
    if (!result.supported) return result;

    const status = await execFile('git', ['-C', root, 'status', '--porcelain'], { timeout: 5000 });
    result.dirty = Boolean(status.stdout.trim());
    if (result.dirty) {
      result.message = 'Lokale Änderungen gefunden. Vor einem Update zuerst sichern oder committen.';
      return result;
    }

    try {
      await execFile('git', ['-C', root, 'fetch', '--dry-run', '--quiet', '--all'], { timeout: 15000 });
      const upstream = await execFile('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 5000 });
      if (upstream.stdout.trim()) {
        const ahead = await execFile('git', ['-C', root, 'rev-list', '--count', `HEAD..${upstream.stdout.trim()}`], { timeout: 5000 });
        result.commitsBehind = Number(ahead.stdout.trim()) || 0;
        result.updateAvailable = result.commitsBehind > 0;
        result.message = result.updateAvailable
          ? `${result.commitsBehind} Update(s) verfügbar.`
          : 'Die installierte Version ist aktuell.';
      } else {
        result.message = 'Kein Upstream-Branch für das Repository eingerichtet.';
      }
    } catch (error) {
      result.message = `Update konnte nicht geprüft werden: ${error.message}`;
    }
  } catch {
    // A source checkout is optional in packaged/manual deployments.
  }
  return result;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function pathParts(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function getDiscoveryRequestConfig(input = {}) {
  const configured = getConfig().discovery;
  const requested = input.discovery && typeof input.discovery === 'object' ? input.discovery : {};
  const requestedPrefix = typeof requested.prefix === 'string' && requested.prefix.trim()
    ? requested.prefix
    : configured.prefix;

  return {
    enabled: typeof requested.enabled === 'boolean' ? requested.enabled : configured.enabled,
    mode: typeof requested.mode === 'string' && requested.mode.trim() ? requested.mode.trim() : configured.mode,
    prefix: normalizeDiscoveryPrefix(requestedPrefix)
  };
}

function buildDiscoveryMessagesForRequest(input, discovery, {
  includeDisabled = false,
  includeBridge = false,
  bridgeProfiles: sharedBridgeProfiles = null,
  includeDeviceInfo = false,
  deviceInfoKeys: sharedDeviceInfoKeys = null
} = {}) {
  const configured = getConfig();
  const profiles = Array.isArray(configured.mqtt.profiles) ? configured.mqtt.profiles : [];
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const defaultProfileId = configured.mqtt.defaultProfileId || profiles.find((profile) => profile.isDefault)?.id || profiles[0]?.id;
  const messages = [];
  const bridgeMessages = [];
  const deviceInfoMessages = [];
  const bridgeProfiles = sharedBridgeProfiles || new Map();
  const deviceInfoKeys = sharedDeviceInfoKeys || new Set();

  for (const measurement of input.measurements || []) {
    const requestedProfileIds = Array.isArray(measurement.mqttProfileIds) && measurement.mqttProfileIds.length
      ? measurement.mqttProfileIds
      : [input.profileId || defaultProfileId];

    for (const profileId of [...new Set(requestedProfileIds)].filter(Boolean)) {
      const profile = profileMap.get(profileId);
      if (!profile || (!includeDisabled && profile.enabled === false)) continue;
      if (profile.mode !== 'homeassistant') throw new Error('Unbekannter Discovery-Modus: ' + profile.mode);
      const effectiveProfile = input.discovery?.prefix
        ? { ...profile, discoveryPrefix: discovery.prefix, component: 'sensor' }
        : { ...profile, component: 'sensor' };
      if (includeBridge) bridgeProfiles.set(profile.brokerId || 'default', effectiveProfile);
      if (includeDeviceInfo) {
        const deviceInfos = buildDeviceInfoDiscoveries({
          project: input.project,
          device: measurement.device || input.device,
          topicPrefix: effectiveProfile.topicPrefix || configured.mqtt.topicPrefix,
          discoveryPrefix: effectiveProfile.discoveryPrefix,
          profile: effectiveProfile,
          applicationUrl: configured.application?.publicUrl
        });
        for (const deviceInfo of deviceInfos) {
          const deviceInfoKey = discoveryMessageKey({
            ...deviceInfo,
            brokerId: profile.brokerId
          });
          if (!deviceInfoKeys.has(deviceInfoKey)) {
            deviceInfoKeys.add(deviceInfoKey);
            deviceInfoMessages.push({ ...deviceInfo, brokerId: profile.brokerId });
          }
        }
      }
      const historyRanges = measurement.historical === true && !measurement.historyRange && Array.isArray(measurement.historyRanges) && measurement.historyRanges.length
        ? measurement.historyRanges
        : [measurement.historyRange || null];
      const discoveryMeasurements = historyRanges.map((historyRange) => ({
        ...measurement,
        ...(historyRange ? { historyRange } : {})
      }));
      messages.push(...buildDiscoveryMessages({
        project: input.project,
        device: measurement.device || input.device,
        measurements: discoveryMeasurements,
        topicPrefix: effectiveProfile.topicPrefix || configured.mqtt.topicPrefix,
        discoveryPrefix: effectiveProfile.discoveryPrefix,
        profile: effectiveProfile
      }).map((message) => ({
        ...message,
        brokerId: profile.brokerId,
        stateValue: measurement.liveValue,
        stateTime: measurement.liveTime,
        stateRetain: measurement.retainState === true,
        availabilityValue: measurement.availabilityValue === 'offline' ? 'offline' : 'online'
      })));
    }
  }

  if (includeBridge && !sharedBridgeProfiles) {
    for (const [brokerId, profile] of bridgeProfiles) {
      const bridge = buildBridgeDiscovery({
        topicPrefix: profile.topicPrefix || configured.mqtt.topicPrefix,
        discoveryPrefix: profile.discoveryPrefix,
        profile,
        gridvisVersion: cachedGridvisVersion,
        gridvisInfo: cachedGridvisInfo,
        configurationUrl: configured.gridvis.baseUrl
      });
      const bridgeApplicationUrl = buildBridgeApplicationUrlDiscovery({
        topicPrefix: profile.topicPrefix || configured.mqtt.topicPrefix,
        discoveryPrefix: profile.discoveryPrefix,
        profile,
        applicationUrl: configured.application?.publicUrl
      });
      bridge.brokerId = brokerId;
      bridgeApplicationUrl.brokerId = brokerId;
      bridgeMessages.push(bridge, bridgeApplicationUrl);
    }
  }

  return [...bridgeMessages, ...deviceInfoMessages, ...messages];
}

function discoveryPrefixes(messages, fallback) {
  const prefixes = [...new Set(messages.map((message) => message.discoveryPrefix).filter(Boolean))];
  return prefixes.length ? prefixes.join(', ') : fallback;
}

function isPublicIconRequest(request, parts) {
  if (request.method !== 'GET' || getConfig().application.publicIconApi !== true) return false;
  const deviceIconPath = parts[0] === 'api'
    && parts[1] === 'gridvis'
    && parts[2] === 'projects'
    && parts[4] === 'deviceicon'
    && parts.length === 6;
  const legacyDeviceIconPath = parts[0] === 'api'
    && parts[1] === 'gridvis'
    && parts[2] === 'projects'
    && parts[4] === 'devices'
    && parts[6] === 'icon'
    && parts.length === 7;
  return deviceIconPath || legacyDeviceIconPath;
}

async function handleApi(request, response, url) {
  const parts = pathParts(url.pathname);

  if (request.method === 'GET' && url.pathname === '/api/auth/status') {
    return sendJson(response, 200, { ok: true, ...authStatus(request) });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const input = await readBody(request);
    const user = authenticateCredentials(input.username, input.password);
    if (!user) {
      return sendJson(response, 401, { ok: false, error: 'Benutzername oder Passwort ist falsch.' });
    }
    const cookie = createSession(user);
    return sendJson(response, 200, { ok: true, ...authStatus({ headers: { cookie } }) }, { 'Set-Cookie': cookie });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSession(request) });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/password') {
    const auth = requireAuthenticated(request, { allowPasswordChange: true });
    if (!auth.ok) return sendJson(response, auth.status, { ok: false, error: auth.error, code: auth.code });
    const input = await readBody(request);
    if (input.password !== input.confirmPassword) {
      return sendJson(response, 400, { ok: false, error: 'Die beiden neuen Passwörter stimmen nicht überein.' });
    }
    if (typeof input.password !== 'string' || input.password.length < 8) {
      return sendJson(response, 400, { ok: false, error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' });
    }
    changePassword(input.password, auth.session.userId);
    return sendJson(response, 200, { ok: true, ...authStatus(request) });
  }

  // Some browsers and older frontend builds may still request this legacy
  // endpoint. There is no API payload behind a favicon request, so answer
  // successfully without producing a noisy 404 in the console.
  if (request.method === 'GET' && url.pathname === '/api/favicon') {
    response.writeHead(204, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });
    response.end();
    return;
  }

  const publicIconRequest = isPublicIconRequest(request, parts);
  const auth = requireAuthenticated(request);
  if (!auth.ok && !publicIconRequest) return sendJson(response, auth.status, { ok: false, error: auth.error, code: auth.code });

  if (request.method === 'GET' && url.pathname === '/api/auth/profile') {
    return sendJson(response, 200, {
      ok: true,
      profile: auth.user,
      users: auth.user.role === 'admin' ? listUsers() : []
    });
  }

  if (request.method === 'PUT' && url.pathname === '/api/auth/profile') {
    const input = await readBody(request);
    const wantsPasswordChange = typeof input.password === 'string' && input.password.length > 0;
    if (!verifyUserPassword(auth.session.userId, input.currentPassword)) {
      return sendJson(response, 400, { ok: false, error: 'Das aktuelle Passwort ist nicht korrekt.' });
    }
    if (wantsPasswordChange && input.password !== input.confirmPassword) {
      return sendJson(response, 400, { ok: false, error: 'Die beiden neuen Passwörter stimmen nicht überein.' });
    }
    try {
      const profile = updateOwnProfile({
        userId: auth.session.userId,
        username: input.username,
        password: wantsPasswordChange ? input.password : undefined
      });
      return sendJson(response, 200, { ok: true, profile, ...authStatus(request) });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/users') {
    const admin = requireAdmin(request);
    if (!admin.ok) return sendJson(response, admin.status, { ok: false, error: admin.error, code: admin.code });
    try {
      const user = createUser(await readBody(request));
      return sendJson(response, 201, { ok: true, user, users: listUsers() });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'users' && parts[4] === 'password') {
    const admin = requireAdmin(request);
    if (!admin.ok) return sendJson(response, admin.status, { ok: false, error: admin.error, code: admin.code });
    const userId = parts[3];
    try {
      const user = resetUserPassword(userId, (await readBody(request)).password);
      return sendJson(response, 200, { ok: true, user, users: listUsers() });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === 'DELETE' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'users') {
    const admin = requireAdmin(request);
    if (!admin.ok) return sendJson(response, admin.status, { ok: false, error: admin.error, code: admin.code });
    if (parts[3] === auth.user.id) return sendJson(response, 400, { ok: false, error: 'Der aktuell angemeldete Benutzer kann nicht gelöscht werden.' });
    try {
      deleteUser(parts[3]);
      return sendJson(response, 200, { ok: true, users: listUsers() });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/update/check') {
    return sendJson(response, 200, { ok: true, update: await checkForUpdates() });
  }

  if (request.method === 'GET' && url.pathname === '/api/backup') {
    const includeConnections = url.searchParams.get('includeConnections') === 'true';
    const filename = `gridvis2mqtt-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const payload = JSON.stringify(createBackup(includeConnections), null, 2);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });
    response.end(`${payload}\n`);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/backup/restore') {
    const backup = await readBody(request);
    validateBackup(backup);
    const previousState = getState();
    const restoredState = updateState(backup.state);
    if (gridvis.configured) {
      await mqtt.reconcileRetainedDiscovery(activeDiscoveryKeysFromState(restoredState));
      await syncNewStateToConnectedBrokers(previousState, restoredState);
    }
    let connectionsRestored = false;
    if (backup.includes?.connections) {
      const previousConfig = getConfig();
      const restoredConfig = updateConfig(backup.config);
      connectionsRestored = true;
      const gridvisChanged = JSON.stringify(previousConfig.gridvis) !== JSON.stringify(restoredConfig.gridvis);
      const mqttChanged = JSON.stringify(previousConfig.mqtt) !== JSON.stringify(restoredConfig.mqtt);
      if (gridvisChanged) {
        gridvis.updateSettings(restoredConfig.gridvis);
        deviceDetailsCache.clear();
        cachedGridvisFetchedAt = 0;
        if (gridvis.configured) scheduleInformationRefresh();
        else stopGridvisSchedulers();
      }
      await mqtt.markProfilesChanged(previousConfig.mqtt.profiles, restoredConfig.mqtt.profiles);
      if (mqttChanged) mqtt.connect(restoredConfig.mqtt);
      if (gridvisChanged || mqttChanged) scheduleLiveRefresh();
    }
    scheduleHistoricalRefresh();
    scheduleLiveRefresh();
    return sendJson(response, 200, {
      ok: true,
      connectionsRestored,
      config: getClientConfig(),
      state: stateForBrowser(getState())
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/app') {
    return sendJson(response, 200, { ok: true, name: APP_NAME, version: APP_VERSION, config: getClientConfig(), mqtt: mqtt.getSnapshot() });
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(response, 200, {
      ok: true,
      gridvis: gridvis.getSnapshot(),
      mqtt: mqtt.getSnapshot()
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/logbook') {
    const limit = Math.min(LOGBOOK_MAX_ENTRIES, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    return sendJson(response, 200, {
      ok: true,
      limit,
      total: logbook.size(),
      entries: logbook.list({
        limit,
        level: url.searchParams.get('level') || '',
        query: url.searchParams.get('query') || ''
      })
    });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/logbook') {
    logbook.clear();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, { ok: true, config: getClientConfig() });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(response, 200, { ok: true, initialized: hasStoredState(), state: stateForBrowser(getState()) });
  }

  if (request.method === 'GET' && url.pathname === '/api/state/device') {
    const project = String(url.searchParams.get('project') || '');
    const deviceId = String(url.searchParams.get('deviceId') || '');
    const snapshot = getState();
    const device = (snapshot.deviceCache?.[project] || [])
      .find((entry) => stateItemId(entry) === deviceId) || null;
    const measurementCache = snapshot.measurementCache?.[backendMeasurementCacheKey(project, deviceId)] || null;
    const backendHistoricalResults = cachedHistoricalResults(project, deviceId, snapshot);
    const historicalCacheKeys = activeHistoricalResultKeys(project, deviceId, snapshot);
    const deviceMeasurementCache = measurementCache
      ? structuredClone(measurementCache)
      : {};
    const historicalResults = { ...(deviceMeasurementCache.historicalResults || {}) };
    // Remove old browser/state values for active MQTT jobs first. The
    // backend cache is authoritative, including the fact that a current
    // GridVis response may have no value at all.
    historicalCacheKeys.forEach((key) => delete historicalResults[key]);
    Object.assign(historicalResults, backendHistoricalResults);
    deviceMeasurementCache.historicalResults = historicalResults;
    const liveRequests = (measurementCache?.onlineValues || [])
      .filter((measurement) => measurement?.value !== undefined && measurement?.type !== undefined)
      .map((measurement) => `${deviceId};${measurement.value};${measurement.type}`);
    return sendJson(response, 200, {
      ok: true,
      project,
      deviceId,
      data: {
        device,
        measurementCache: measurementCache || historicalCacheKeys.length ? deviceMeasurementCache : null,
        historicalCacheKeys,
        liveValues: cachedLiveValues(project, liveRequests)
      }
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/mqtt/overview') {
    const project = String(url.searchParams.get('project') || '');
    const overview = mqttOverviewSnapshot(getState(), project);
    return sendJson(response, 200, { ok: true, project, ...overview });
  }

  if (request.method === 'PUT' && url.pathname === '/api/state/device') {
    const input = await readBody(request);
    const updatedState = await enqueueStateMutation(async () => {
      const previousState = getState();
      const nextState = structuredClone(previousState);
      applyCurrentDeviceState(nextState, input);
      const previousMessages = activeDiscoveryMessagesFromState(previousState);
      const committedState = updateState(nextState);
      const nextMessages = activeDiscoveryMessagesFromState(committedState);
      logDiscoveryStateCommit(previousState, committedState, {
        source: 'device',
        deviceKey: `${input?.project || ''}::${input?.deviceId || ''}`,
        clientMutationVersion: input?.clientMutationVersion
      });
      const newlyActiveHistoryKeys = newlyActiveHistoricalDiscoveryKeys(previousState, committedState);
      await mqtt.reconcileRetainedDiscovery(activeDiscoveryKeysFromState(committedState));
      await syncNewStateToConnectedBrokers(previousState, committedState, { previousMessages, nextMessages });
      if (newlyActiveHistoryKeys.size) {
        await refreshHistoricalValuesForConnectedBrokers({
          force: true,
          messageKeys: newlyActiveHistoryKeys,
          snapshot: committedState,
          retryInFlight: true
        });
      }
      scheduleHistoricalRefresh();
      scheduleLiveRefresh();
      return committedState;
    });
    return sendJson(response, 200, { ok: true, state: stateForBrowser(updatedState) });
  }

  if (['POST', 'PUT'].includes(request.method) && url.pathname === '/api/state') {
    const incomingState = await readBody(request);
    const nextState = await enqueueStateMutation(async () => {
      const previousState = getState();
      const nextInput = incomingState && typeof incomingState === 'object' && !Array.isArray(incomingState)
        ? incomingState
        : {};
      // The browser may persist UI preferences and, at most, the currently
      // visible device cache entry. All complete caches remain server-owned.
      nextInput.projects = structuredClone(previousState.projects);
      nextInput.deviceCache = structuredClone(previousState.deviceCache);
      nextInput.measurementCache = structuredClone(previousState.measurementCache);
      applyCurrentDeviceState(nextInput, incomingState?.currentDeviceState);
      mergeCachedDeviceInformation(previousState, nextInput);
      // Device information is refreshed by the backend scheduler. Never wait
      // for a GridVis information request while committing a checkbox change.
      // Doing so allowed a stale UI snapshot to overtake the current one.
      const committedState = updateState(nextInput);
      logDiscoveryStateCommit(previousState, committedState, {
        source: 'ui',
        deviceKey: `${incomingState?.currentDeviceState?.project || ''}::${incomingState?.currentDeviceState?.deviceId || ''}`,
        clientMutationVersion: incomingState?.clientMutationVersion
      });
      const newlyActiveHistoryKeys = newlyActiveHistoricalDiscoveryKeys(previousState, committedState);
      await mqtt.reconcileRetainedDiscovery(activeDiscoveryKeysFromState(committedState));
      // A state change is the authoritative selection event. Publish discovery
      // first and its matching value after a short broker-side delay, so this
      // also works while the browser tab is in the background.
      await syncNewStateToConnectedBrokers(previousState, committedState);
      if (newlyActiveHistoryKeys.size) {
        await refreshHistoricalValuesForConnectedBrokers({
          force: true,
          messageKeys: newlyActiveHistoryKeys,
          snapshot: committedState,
          retryInFlight: true
        });
      }
      scheduleHistoricalRefresh();
      scheduleLiveRefresh();
      return committedState;
    });
    return sendJson(response, 200, { ok: true, state: stateForBrowser(nextState) });
  }

  if (request.method === 'PUT' && url.pathname === '/api/config') {
    const input = await readBody(request);
    const previous = getConfig();
    const next = updateConfig(input);
    const full = getConfig();
    const gridvisChanged = JSON.stringify(previous.gridvis) !== JSON.stringify(full.gridvis);
    const mqttChanged = JSON.stringify(previous.mqtt) !== JSON.stringify(full.mqtt);
    const publicUrlChanged = previous.application?.publicUrl !== full.application?.publicUrl;
    if (gridvis.configured) await mqtt.markProfilesChanged(previous.mqtt.profiles, full.mqtt.profiles);
    if (gridvisChanged) {
      gridvis.updateSettings(full.gridvis);
      deviceDetailsCache.clear();
      cachedGridvisFetchedAt = 0;
      if (gridvis.configured) {
        scheduleInformationRefresh();
        refreshBackendInformation({ force: true, publish: true })
          .then(() => refreshLiveValuesForConnectedBrokers({ force: true }))
          .then(() => refreshHistoricalValuesForConnectedBrokers({ force: true }))
          .catch((error) => {
            logbook.error('backend.information-refresh', { error: error.message });
          });
      } else {
        stopGridvisSchedulers();
        logbook.info('gridvis.connection', { phase: 'disabled', reason: 'configuration' });
      }
    }
    if (mqttChanged) mqtt.connect(full.mqtt);
    if (publicUrlChanged && gridvis.configured) {
      const connectedBrokers = mqtt.getSnapshot().brokers.filter((broker) => broker.connected);
      await Promise.all(connectedBrokers.map(async (broker) => {
        const deviceInfoMessages = activeDiscoveryMessagesFromState(getState())
          .filter((message) => isDeviceInfoDiscoveryMessage(message) || isBridgeDiscoveryMessage(message))
          .filter((message) => (message.brokerId || 'default') === broker.id);
        if (!deviceInfoMessages.length) return;
        await mqtt.publishDiscovery(deviceInfoMessages);
        await waitForMqttState();
        await publishBridgeValuesForBroker(getState(), broker.id);
        await publishDeviceInfoValuesForBroker(getState(), broker.id);
      }));
    }
    if (gridvisChanged || mqttChanged) {
      scheduleLiveRefresh();
      scheduleHistoricalRefresh();
    }
    return sendJson(response, 200, { ok: true, config: getClientConfig(), mqtt: mqtt.getSnapshot() });
  }

  if (request.method === 'POST' && url.pathname === '/api/gridvis/disconnect') {
    updateConfig({ gridvis: { enabled: false } });
    gridvis.disconnect();
    stopGridvisSchedulers();
    logbook.info('gridvis.connection', { phase: 'manual-disconnect' });
    return sendJson(response, 200, { ok: true, config: getClientConfig(), mqtt: mqtt.getSnapshot() });
  }

  if (request.method === 'POST' && (url.pathname === '/api/mqtt/connect' || url.pathname === '/api/mqtt/disconnect')) {
    const input = await readBody(request);
    const brokerId = String(input.brokerId || '');
    const previous = getConfig();
    const broker = previous.mqtt.brokers.find((entry) => entry.id === brokerId);
    if (!broker) return sendJson(response, 404, { ok: false, error: 'MQTT-Broker nicht gefunden.' });
    const enabled = url.pathname === '/api/mqtt/connect';
    const brokers = previous.mqtt.brokers.map((entry) => entry.id === brokerId
      ? { ...entry, enabled }
      : entry);
    const next = updateConfig({ mqtt: { brokers } });
    mqtt.connect(next.mqtt);
    logbook.info('mqtt.connection', {
      brokerId,
      phase: enabled ? 'manual-connect' : 'manual-disconnect'
    });
    scheduleHistoricalRefresh();
    scheduleLiveRefresh();
    return sendJson(response, 200, { ok: true, config: getClientConfig(), mqtt: mqtt.getSnapshot() });
  }

  if (request.method === 'GET' && url.pathname === '/api/discovery/profiles') {
    const configured = getPublicConfig();
    return sendJson(response, 200, {
      ok: true,
      profiles: configured.mqtt.profiles.map((profile) => ({
        ...profile,
        description: profile.mode === 'homeassistant' ? 'MQTT Discovery für Home Assistant' : profile.mode
      }))
    });
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/gridvis/version') {
      return sendJson(response, 200, { ok: true, data: await refreshCachedGridvisVersion() });
    }
    if (request.method === 'POST' && url.pathname === '/api/gridvis/test') {
      const input = await readBody(request);
      const configured = getConfig();
      const candidate = new GridVisClient({
        ...configured.gridvis,
        ...input,
        enabled: true,
        authEnabled: input.authEnabled === true,
        password: input.password || configured.gridvis.password || ''
      });
      const data = await candidate.getVersion();
      return sendJson(response, 200, { ok: true, data, connection: candidate.getSnapshot() });
    }
    if (request.method === 'POST' && url.pathname === '/api/mqtt/test') {
      const input = await readBody(request);
      const configured = getConfig();
      const broker = configured.mqtt.brokers.find((entry) => entry.id === input.brokerId) || {};
      const settings = {
        ...broker,
        ...input,
        password: input.password || broker.password || ''
      };
      const result = await mqtt.testConnection(settings);
      return sendJson(response, 200, { ok: true, data: result });
    }
    if (request.method === 'GET' && url.pathname === '/api/gridvis/projects') {
      const data = await gridvis.getProjects();
      if (Array.isArray(data)) await enqueueStateMutation(() => persistProjects(data));
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'devices' && parts.length === 5) {
      const data = await gridvis.getDevices(parts[3]);
      if (Array.isArray(data)) await enqueueStateMutation(() => persistDeviceList(parts[3], data));
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'deviceicon' && parts.length === 6) {
      const icon = await getCachedDeviceIcon(parts[3], parts[5]);
      response.writeHead(200, {
        'Content-Type': icon.contentType,
        'Cache-Control': 'public, max-age=86400'
      });
      response.end(icon.body);
      return;
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'devices' && parts[6] === 'icon' && parts.length === 7) {
      const icon = await getCachedDeviceIcon(parts[3], parts[5]);
      response.writeHead(200, {
        'Content-Type': icon.contentType,
        'Cache-Control': 'public, max-age=86400'
      });
      response.end(icon.body);
      return;
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'devices' && parts.length === 6) {
      // Opening a device only reads the backend cache. GridVis refreshes are
      // performed by the backend scheduler and when a measurement becomes
      // MQTT-active, never as a side effect of a browser click.
      const data = url.searchParams.get('refresh') === 'true'
        ? await getCachedDeviceDetails(parts[3], parts[5], { force: true })
        : getStoredDeviceDetails(parts[3], parts[5]);
      if (url.searchParams.get('refresh') === 'true') {
        await enqueueStateMutation(() => {
          const nextState = getState();
          mergeDeviceIntoState(nextState, parts[3], parts[5], data);
          updateState(nextState);
        });
      }
      logbook.info('backend.device-cache', {
        project: parts[3],
        deviceId: parts[5],
        hit: Boolean(deviceDetailsCache.get(deviceDetailsCacheKey(parts[3], parts[5]))?.data)
      });
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'devices' && parts[6] === 'online-values') {
      const data = await gridvis.getOnlineValueDefinitions(parts[3], parts[5]);
      const definitions = listDataFromResponse(data);
      if (Array.isArray(data)) await enqueueStateMutation(() => persistMeasurementDefinitions(parts[3], parts[5], 'onlineValues', data));
      logbook[definitions.length ? 'info' : 'warning']('gridvis.online-definitions', {
        project: parts[3],
        deviceId: parts[5],
        definitions: definitions.length,
        reason: definitions.length ? undefined : 'empty-response'
      });
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'gridvis' && parts[2] === 'projects' && parts[4] === 'devices' && parts[6] === 'historical-values') {
      const data = await gridvis.getHistoricalValueDefinitions(parts[3], parts[5]);
      const definitions = listDataFromResponse(data);
      if (Array.isArray(data)) await enqueueStateMutation(() => persistMeasurementDefinitions(parts[3], parts[5], 'historicalValues', data));
      logbook[definitions.length ? 'info' : 'warning']('gridvis.historical-definitions', {
        project: parts[3],
        deviceId: parts[5],
        definitions: definitions.length,
        reason: definitions.length ? undefined : 'empty-response'
      });
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && url.pathname === '/api/gridvis/history') {
      const values = {
        project: url.searchParams.get('project'),
        deviceId: url.searchParams.get('deviceId'),
        value: url.searchParams.get('value'),
        type: url.searchParams.get('type') || 'Overall',
        start: url.searchParams.get('start'),
        end: url.searchParams.get('end'),
        anchor: url.searchParams.get('anchor') || undefined,
        energy: url.searchParams.get('energy') === 'true',
        online: url.searchParams.get('online') === 'true'
      };
      const data = await gridvis.getHistory(values);
      const hasData = Array.isArray(data)
        ? data.length > 0
        : Boolean(data && typeof data === 'object' && Object.keys(data).length);
      logbook[hasData ? 'info' : 'warning']('gridvis.history-display', {
        project: values.project,
        deviceId: values.deviceId,
        value: values.value,
        type: values.type,
        start: values.start,
        end: values.end,
        result: hasData ? 'received' : 'empty-response'
      });
      return sendJson(response, 200, { ok: true, data });
    }
    if (request.method === 'GET' && url.pathname === '/api/gridvis/live-cache') {
      const project = url.searchParams.get('project') || '';
      const values = url.searchParams.getAll('value');
      return sendJson(response, 200, {
        ok: true,
        data: cachedLiveValues(project, values)
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/gridvis/online') {
      const values = url.searchParams.getAll('value');
      const data = await gridvis.getOnlineValues({
        project: url.searchParams.get('project'),
        values,
        timeout: Number(url.searchParams.get('timeout')) || 500,
        timeliness: url.searchParams.get('timeliness') || undefined
      });
      const normalized = normalizeOnlineValues(data);
      const responseValues = listDataFromResponse(normalized);
      logbook[responseValues.length >= values.length ? 'info' : 'warning']('gridvis.live-display', {
        project: url.searchParams.get('project'),
        requested: values.length,
        returned: responseValues.length,
        missing: Math.max(0, values.length - responseValues.length),
        reason: responseValues.length >= values.length ? 'complete-response' : 'partial-or-empty-response'
      });
      return sendJson(response, 200, {
        ok: true,
        data: normalized
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/discovery/preview') {
      const input = await readBody(request);
      const discovery = getDiscoveryRequestConfig(input);
      if (!discovery.enabled) return sendJson(response, 200, { ok: true, enabled: false, mode: discovery.mode, prefix: discovery.prefix, messages: [] });
      const measurementOnly = input.previewScope === 'measurement';
      const messages = buildDiscoveryMessagesForRequest(input, discovery, {
        includeBridge: !measurementOnly,
        includeDeviceInfo: !measurementOnly
      });
      return sendJson(response, 200, { ok: true, enabled: true, mode: discovery.mode, prefix: discoveryPrefixes(messages, discovery.prefix), messages });
    }

    if (request.method === 'POST' && url.pathname === '/api/discovery/publish') {
      const input = await readBody(request);
      if (!gridvis.configured) {
        logbook.info('mqtt.discovery.publish', { published: 0, queued: 0, reason: 'gridvis-disconnected' });
        return sendJson(response, 200, { ok: true, enabled: false, published: 0, queued: 0, messages: [] });
      }
      const discovery = getDiscoveryRequestConfig(input);
      if (!discovery.enabled) return sendJson(response, 200, { ok: true, enabled: false, mode: discovery.mode, prefix: discovery.prefix, published: 0, messages: [] });
      const requestedMessages = buildDiscoveryMessagesForRequest(input, discovery, { includeBridge: true, includeDeviceInfo: true });
      // A delayed browser request must not recreate a measurement that has
      // already been disabled in the authoritative backend state. Bridge and
      // device-info messages remain explicitly publishable; measurement
      // messages need a currently active Discovery assignment.
      let messages = [];
      let skippedInactive = 0;
      const result = await enqueueStateMutation(async () => {
        const activeKeys = activeDiscoveryKeysFromState(getState());
        messages = requestedMessages.filter((message) => (
          isBridgeDiscoveryMessage(message)
          || isDeviceInfoDiscoveryMessage(message)
          || activeKeys.has(discoveryMessageKey(message))
        ));
        skippedInactive = requestedMessages.length - messages.length;
        return mqtt.publishDiscovery(messages);
      });
      const bridgeMessages = messages.filter(isBridgeDiscoveryMessage);
      const deviceInfoMessages = messages.filter(isDeviceInfoDiscoveryMessage);
      if (bridgeMessages.length || deviceInfoMessages.length) {
        const connectedBrokerIds = new Set(mqtt.getSnapshot().brokers.filter((broker) => broker.connected).map((broker) => broker.id));
        if (connectedBrokerIds.size) {
          await waitForMqttState();
          await mqtt.publishValues(bridgeMessages.filter((message) => connectedBrokerIds.has(message.brokerId || 'default')));
          await mqtt.publishValues(deviceInfoMessages.filter((message) => connectedBrokerIds.has(message.brokerId || 'default')));
        }
      }
      const messageKeys = new Set(messages.map(discoveryMessageKey));
      await Promise.all(mqtt.getSnapshot().brokers
        .filter((broker) => broker.connected)
        .map((broker) => publishCachedHistoricalValuesForBroker(getState(), broker.id, messageKeys)));
      logbook.info('mqtt.discovery.publish', {
        requested: requestedMessages.length,
        published: result.published,
        queued: result.queued,
        skippedInactive
      });
      return sendJson(response, 200, { ok: true, enabled: true, mode: discovery.mode, prefix: discoveryPrefixes(messages, discovery.prefix), skippedInactive, ...result, messages });
    }
    if (request.method === 'POST' && url.pathname === '/api/discovery/remove') {
      const input = await readBody(request);
      if (!gridvis.configured) {
        logbook.info('mqtt.discovery.remove', { removed: 0, queued: 0, reason: 'gridvis-disconnected' });
        return sendJson(response, 200, { ok: true, removed: 0, queued: 0, messages: [] });
      }
      const discovery = getDiscoveryRequestConfig(input);
      const requestedMessages = buildDiscoveryMessagesForRequest(input, discovery, { includeDisabled: true });
      // A remove request can arrive after the browser has already persisted a
      // re-enabled measurement. Never let that stale request delete the
      // freshly recreated Discovery topics again. The authoritative state
      // commit will remove them when the measurement is really inactive.
      let messages = [];
      let skippedActive = 0;
      const result = await enqueueStateMutation(async () => {
        const activeKeys = activeDiscoveryKeysFromState(getState());
        messages = requestedMessages.filter((message) => !activeKeys.has(discoveryMessageKey(message)));
        skippedActive = requestedMessages.length - messages.length;
        return mqtt.removeDiscovery(messages);
      });
      logbook.info('mqtt.discovery.remove', {
        requested: requestedMessages.length,
        skippedActive,
        removed: result.removed,
        queued: result.queued
      });
      return sendJson(response, 200, {
        ok: true,
        removed: result.removed,
        queued: result.queued,
        skippedActive,
        messages
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/mqtt/refresh-history') {
      const input = await readBody(request);
      const project = String(input.project || '').trim();
      const deviceId = String(input.deviceId || '').trim();
      if (!project || !deviceId) return sendJson(response, 400, { ok: false, error: 'Projekt und Gerät werden benötigt.' });
      const snapshot = getState();
      const jobs = historicalJobsForDevice(snapshot, project, deviceId);
      const messageKeys = historicalDiscoveryKeysForDevice(snapshot, project, deviceId);
      const result = await refreshHistoricalValuesForConnectedBrokers({
        force: true,
        messageKeys,
        snapshot,
        retryInFlight: true
      });
      return sendJson(response, 200, {
        ok: true,
        project,
        deviceId,
        requestedJobs: jobs.length,
        discoveryMessages: messageKeys.size,
        ...result
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/mqtt/publish-values') {
      const input = await readBody(request);
      if (!gridvis.configured) {
        logbook.info('mqtt.publish-values', { published: 0, reason: 'gridvis-disconnected' });
        return sendJson(response, 200, { ok: true, published: 0, messages: [] });
      }
      const discovery = getDiscoveryRequestConfig(input);
      if (!discovery.enabled) return sendJson(response, 200, { ok: true, published: 0, messages: [] });
      const messages = buildDiscoveryMessagesForRequest(input, discovery);
      const count = await mqtt.publishValues(messages);
      const cachedLiveValuesCount = cachePublishedLiveValues(input, count);
      return sendJson(response, 200, { ok: true, published: count, cachedLiveValues: cachedLiveValuesCount });
    }
  } catch (error) {
    logbook.error('api.error', { method: request.method, path: url.pathname, error: error.message });
    return sendError(response, error);
  }

  logbook.warning('api.not-found', { method: request.method, path: url.pathname });
  sendJson(response, 404, { ok: false, error: 'API-Endpunkt nicht gefunden.' });
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(publicDir, requested);
  if (!filePath.startsWith(publicDir)) return false;
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(request, response, url);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
      return;
    }
  }
  if (await serveStatic(response, url.pathname)) return;
  sendJson(response, 404, { ok: false, error: 'Nicht gefunden.' });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`${APP_NAME} ${APP_VERSION} läuft auf http://localhost:${port}`);
});

let shuttingDown = false;

function shutdown(signal) {
  // Signale können mehrfach eintreffen. Den Shutdown nur einmal starten,
  // damit nicht bei jedem weiteren Strg+C ein neuer close-Listener entsteht.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal || 'Shutdown'} – Server wird beendet ...`);
  mqtt.disconnect();

  // Offene Browser-/Icon-Anfragen dürfen den Prozess beim Beenden nicht
  // dauerhaft festhalten. Nach kurzer Frist beenden wir notfalls trotzdem.
  const forceExit = setTimeout(() => process.exit(0), 1500);
  forceExit.unref();

  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
