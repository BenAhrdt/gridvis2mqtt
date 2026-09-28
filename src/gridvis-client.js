import { logbook } from './logbook.js';

function encode(value) {
  return encodeURIComponent(String(value));
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOnlineValueKey(key) {
  const parts = String(key || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const type = parts.pop();
  const deviceId = parts.shift();
  const value = parts.join('.');
  if (!deviceId || !value || !type) return null;
  return { deviceId, value, type };
}

/**
 * GridVis accepts several types for one device/value as a comma-separated
 * list. Keep one request entry per device/value so large online-value reads
 * use the same compact form as the ioBroker adapter.
 */
export function groupOnlineValueRequests(values = []) {
  const grouped = new Map();
  const passthrough = [];
  for (const raw of values) {
    const parts = String(raw || '').split(';');
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts.slice(2).join(';')) {
      passthrough.push(String(raw));
      continue;
    }
    const deviceId = parts.shift();
    const typeList = parts.pop();
    const value = parts.join(';');
    const key = `${deviceId};${value}`;
    if (!grouped.has(key)) grouped.set(key, new Set());
    for (const type of typeList.split(',').map((item) => item.trim()).filter(Boolean)) {
      grouped.get(key).add(type);
    }
  }
  return [
    ...[...grouped].map(([key, types]) => `${key};${[...types].join(',')}`),
    ...passthrough
  ];
}

/**
 * GridVis returns the global online-values resource as maps keyed by
 * "deviceId.value.type", for example "26.U_Effective.L1". Convert that
 * response into explicit value records before it reaches the browser. This
 * prevents a response-order based mapping when multiple types are requested.
 */
export function normalizeOnlineValues(data) {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return data;

  const values = isRecord(data.value) ? data.value : null;
  if (!values) return data;

  const metadata = isRecord(data.valueType) ? data.valueType : {};
  const timestamps = isRecord(data.time) ? data.time : {};
  const entries = Object.entries(values)
    .map(([key, value]) => {
      const parsed = parseOnlineValueKey(key);
      if (!parsed) return null;
      const keyedMetadata = isRecord(metadata[key]) ? metadata[key] : {};
      const valueType = {
        ...keyedMetadata,
        value: keyedMetadata.value || parsed.value,
        type: keyedMetadata.type || parsed.type,
        typeName: keyedMetadata.typeName || parsed.type
      };
      return {
        deviceId: parsed.deviceId,
        valueType,
        value,
        time: timestamps[key]
      };
    })
    .filter(Boolean);

  return entries.length ? entries : data;
}

export class GridVisClient {
  constructor(settings = {}) {
    this.lastConnection = 'unknown';
    this.lastCheckedAt = null;
    this.controllers = new Set();
    this.updateSettings(settings);
  }

  updateSettings(settings = {}) {
    this.baseUrl = stripTrailingSlash(settings.baseUrl);
    this.username = settings.username || '';
    this.password = settings.password || '';
    this.authEnabled = settings.authEnabled === true;
    this.timeoutMs = Number(settings.timeoutMs || 15000);
    this.enabled = settings.enabled !== false;
    this.lastConnection = this.baseUrl && this.enabled ? 'unknown' : (this.baseUrl ? 'disconnected' : 'unconfigured');
    this.lastCheckedAt = null;
  }

  get configured() {
    return Boolean(this.baseUrl && this.enabled);
  }

  getSnapshot() {
    return {
      configured: this.configured,
      enabled: this.enabled !== false,
      manuallyDisconnected: Boolean(this.baseUrl && this.enabled === false),
      status: this.lastConnection,
      lastCheckedAt: this.lastCheckedAt
    };
  }

  disconnect() {
    this.enabled = false;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.lastConnection = this.baseUrl ? 'disconnected' : 'unconfigured';
    this.lastCheckedAt = new Date().toISOString();
  }

  connect() {
    this.enabled = true;
    this.lastConnection = this.baseUrl ? 'unknown' : 'unconfigured';
    this.lastCheckedAt = null;
  }

  async request(path, options = {}) {
    if (!this.configured) {
      const reason = this.baseUrl && this.enabled === false ? 'manually-disconnected' : 'not-configured';
      logbook.warning('gridvis.api', { method: options.method || 'GET', path, phase: 'skipped', reason });
      throw new Error(this.baseUrl && this.enabled === false
        ? 'Die GridVis-Verbindung wurde manuell getrennt.'
        : 'GridVis ist noch nicht konfiguriert.');
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');

    if (this.authEnabled && this.username) {
      headers.set('Authorization', `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`);
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      const text = await response.text();
      let body = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Some GridVis installations return text for version and error endpoints.
      }

      if (!response.ok) {
        const detail = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`GridVis antwortete mit HTTP ${response.status}: ${detail}`);
      }
      this.lastConnection = 'online';
      this.lastCheckedAt = new Date().toISOString();
      logbook.success('gridvis.api', {
        method: options.method || 'GET',
        path,
        status: response.status,
        durationMs: Date.now() - startedAt
      });
      return body;
    } catch (error) {
      this.lastConnection = this.enabled === false ? 'disconnected' : 'offline';
      this.lastCheckedAt = new Date().toISOString();
      logbook.error('gridvis.api', {
        method: options.method || 'GET',
        path,
        status: error.status || 'error',
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  async requestBinary(path, options = {}) {
    if (!this.configured) {
      const reason = this.baseUrl && this.enabled === false ? 'manually-disconnected' : 'not-configured';
      logbook.warning('gridvis.binary', { method: options.method || 'GET', path, phase: 'skipped', reason });
      throw new Error(this.baseUrl && this.enabled === false
        ? 'Die GridVis-Verbindung wurde manuell getrennt.'
        : 'GridVis ist noch nicht konfiguriert.');
    }

    const { timeoutMs = this.timeoutMs, ...requestOptions } = options;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(requestOptions.headers || {});
    if (!headers.has('Accept')) headers.set('Accept', 'image/svg+xml,image/*;q=0.9,*/*;q=0.1');

    if (this.authEnabled && this.username) {
      headers.set('Authorization', `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`);
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...requestOptions,
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`GridVis antwortete mit HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      this.lastConnection = 'online';
      this.lastCheckedAt = new Date().toISOString();
      logbook.success('gridvis.binary', {
        method: requestOptions.method || 'GET',
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        bytes: body.length
      });
      return { body, contentType };
    } catch (error) {
      if (error.status !== 404) {
        this.lastConnection = this.enabled === false ? 'disconnected' : 'offline';
        this.lastCheckedAt = new Date().toISOString();
      }
      logbook.error('gridvis.binary', {
        method: requestOptions.method || 'GET',
        path,
        status: error.status || 'error',
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  getVersion() {
    return this.request('/rest/common/info/version/full');
  }

  getProjects() {
    return this.request('/rest/1/projects');
  }

  getDevices(project) {
    return this.request(`/rest/1/projects/${encode(project)}/devices`);
  }

  getDevice(project, deviceId) {
    return this.request(`/rest/1/projects/${encode(project)}/devices/${encode(deviceId)}`);
  }

  getDeviceConnectionInfo(project, deviceId) {
    return this.request(`/rest/1/projects/${encode(project)}/devices/${encode(deviceId)}/connectiontest`);
  }

  async getDeviceInfo(project, deviceId) {
    // GridVis can become slow when the base device resource and the
    // connection test are requested at the same time. Keep the information
    // request itself sequential; the caller also serializes the device queue.
    const device = await this.getDevice(project, deviceId);
    let connectionInfo = {};
    try {
      connectionInfo = await this.getDeviceConnectionInfo(project, deviceId);
    } catch (error) {
      // The base device resource remains useful if a device is offline or the
      // GridVis version does not support the connection-test resource.
      console.warn(`Geräteverbindungsinformationen für ${deviceId} konnten nicht geladen werden:`, error.message);
    }
    const info = connectionInfo && typeof connectionInfo === 'object' && !Array.isArray(connectionInfo)
      ? connectionInfo
      : {};
    return { ...device, info };
  }

  async getDeviceIcon(project, deviceId) {
    return this.requestBinary(`/rest/1/projects/${encode(project)}/deviceicon/${encode(deviceId)}`, {
      timeoutMs: 5000,
      headers: { Accept: 'image/png' }
    });
  }

  getOnlineValueDefinitions(project, deviceId) {
    return this.request(`/rest/1/projects/${encode(project)}/devices/${encode(deviceId)}/online/values`);
  }

  getHistoricalValueDefinitions(project, deviceId) {
    return this.request(`/rest/1/projects/${encode(project)}/devices/${encode(deviceId)}/hist/values`);
  }

  getHistory({ project, deviceId, value, type, start, end, anchor, online = false, energy = false }) {
    // GridVis aggregates both energy and non-energy values on histenergy when
    // no timebase is supplied: energy values are summed, other values are
    // averaged. The old histvalues route is therefore not needed here.
    const path = `/rest/1/projects/${encode(project)}/devices/${encode(deviceId)}/histenergy`;
    const query = new URLSearchParams();
    // The former /hist/energy/... and /hist/values/... paths are deprecated.
    query.set('value', value);
    query.set('type', type);
    // Never send timebase here. It changes histenergy from one aggregate into
    // a potentially very large interval series.
    if (start) query.set('start', start);
    if (end) query.set('end', end);
    // `anchor` is not part of either current history endpoint. Comparison
    // ranges are already expressed through their start/end values.
    if (online) query.set('online', 'true');
    return this.request(`${path}?${query}`);
  }

  getOnlineValues({ project, values = [], timeout = 500, timeliness }) {
    const query = new URLSearchParams();
    for (const value of groupOnlineValueRequests(values)) query.append('value', value);
    query.set('timeout', String(timeout));
    if (timeliness) query.set('timeliness', timeliness);
    return this.request(`/rest/1/projects/${encode(project)}/onlinevalues?${query}`);
  }
}
