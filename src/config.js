import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'GridVis2MQTT';
export const APP_VERSION = '0.3.11';

const isProduction = process.env.NODE_ENV === 'production';
const localConfigPath = process.env.GRIDVIS2MQTT_CONFIG_FILE
  || (!isProduction ? fileURLToPath(new URL('../data/config.local.json', import.meta.url)) : '');
const canWriteLocalConfig = Boolean(localConfigPath)
  && (!isProduction || process.env.GRIDVIS2MQTT_ALLOW_CONFIG_WRITE === 'true');

function readLocalConfig() {
  if (!localConfigPath) return {};
  try {
    const content = readFileSync(localConfigPath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Lokale Konfiguration konnte nicht gelesen werden: ${error.message}`);
  }
}

const localConfig = readLocalConfig();

function configuredValue(environmentName, section, key, fallback = '') {
  return process.env[environmentName] ?? localConfig[section]?.[key] ?? fallback;
}

function normalizeDiscoveryPrefix(value) {
  const prefix = String(value || 'homeassistant')
    .trim()
    .replace(/(?:\/(?:#|\+))+$/g, '')
    .replace(/^\/+|\/+$/g, '');
  return prefix && !/[# +]/.test(prefix) ? prefix : 'homeassistant';
}

function normalizePublicUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeId(value, fallback) {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return id || fallback;
}

function normalizeBroker(value = {}, index = 0, fallback = {}) {
  return {
    id: normalizeId(value.id || fallback.id, 'broker-' + (index + 1)),
    name: String(value.name || fallback.name || 'MQTT-Broker ' + (index + 1)).trim(),
    url: String(value.url ?? fallback.url ?? '').trim(),
    clientId: String(value.clientId ?? fallback.clientId ?? 'gridvis2mqtt').trim() || 'gridvis2mqtt',
    username: String(value.username ?? fallback.username ?? '').trim(),
    password: String(value.password ?? fallback.password ?? ''),
    enabled: value.enabled !== false
  };
}

function normalizeProfile(value = {}, index = 0, brokerId = 'broker-1', fallback = {}) {
  return {
    id: normalizeId(value.id || fallback.id, 'profile-' + (index + 1)),
    name: String(value.name || fallback.name || 'MQTT-Profil ' + (index + 1)).trim(),
    mode: String(value.mode || fallback.mode || 'homeassistant').trim(),
    brokerId: String(value.brokerId || fallback.brokerId || brokerId).trim(),
    enabled: value.enabled !== false,
    isDefault: value.isDefault === true || fallback.isDefault === true,
    discoveryPrefix: normalizeDiscoveryPrefix(value.discoveryPrefix || value.prefix || fallback.discoveryPrefix || fallback.prefix || 'homeassistant'),
    component: 'sensor',
    topicPrefix: String(value.topicPrefix || fallback.topicPrefix || 'gridvis2mqtt').trim() || 'gridvis2mqtt',
    stateTopicTemplate: String(value.stateTopicTemplate || fallback.stateTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/state').trim(),
    availabilityTopicTemplate: String(value.availabilityTopicTemplate || fallback.availabilityTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/availability').trim(),
    discoveryTopicTemplate: String(value.discoveryTopicTemplate || fallback.discoveryTopicTemplate || '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config').trim()
  };
}

function normalizeRetainedDiscovery(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && entry.configTopic && entry.brokerId)
    .map((entry) => ({
      key: String(entry.key || `${entry.brokerId}|${entry.profileId || 'homeassistant'}|${entry.uniqueId || entry.configTopic}`),
      brokerId: String(entry.brokerId),
      profileId: String(entry.profileId || 'homeassistant'),
      uniqueId: String(entry.uniqueId || ''),
      configTopic: String(entry.configTopic),
      availabilityTopic: String(entry.availabilityTopic || ''),
      availabilityRetain: entry.availabilityRetain === true,
      availabilityValue: entry.availabilityValue === 'offline' ? 'offline' : 'online',
      payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : {},
      stateTopic: String(entry.stateTopic || ''),
      stateRetain: entry.stateRetain === true,
      statePayload: entry.statePayload,
      cleanupTopics: Array.isArray(entry.cleanupTopics) ? entry.cleanupTopics.map((topic) => String(topic)).filter(Boolean) : [],
      active: entry.active !== false
    }));
}

const legacyMqtt = {
  url: configuredValue('MQTT_URL', 'mqtt', 'url'),
  clientId: configuredValue('MQTT_CLIENT_ID', 'mqtt', 'clientId', 'gridvis2mqtt'),
  username: configuredValue('MQTT_USERNAME', 'mqtt', 'username'),
  password: configuredValue('MQTT_PASSWORD', 'mqtt', 'password'),
  topicPrefix: configuredValue('MQTT_TOPIC_PREFIX', 'mqtt', 'topicPrefix', 'gridvis2mqtt')
};

const legacyDiscovery = {
  enabled: process.env.DISCOVERY_ENABLED !== undefined
    ? process.env.DISCOVERY_ENABLED !== 'false'
    : localConfig.discovery?.enabled !== false,
  mode: configuredValue('DISCOVERY_MODE', 'discovery', 'mode', 'homeassistant'),
  prefix: normalizeDiscoveryPrefix(configuredValue('DISCOVERY_PREFIX', 'discovery', 'prefix', 'homeassistant'))
};

const publicIconApi = process.env.GRIDVIS2MQTT_PUBLIC_ICON_API !== undefined
  ? process.env.GRIDVIS2MQTT_PUBLIC_ICON_API !== 'false'
  : localConfig.application?.publicIconApi !== false;

const initialBrokers = Array.isArray(localConfig.mqtt?.brokers) && localConfig.mqtt.brokers.length
  ? localConfig.mqtt.brokers.map((broker, index) => normalizeBroker(broker, index))
  : [normalizeBroker({ id: 'default', name: 'Hauptbroker', ...legacyMqtt }, 0, { id: 'default', name: 'Hauptbroker' })];

const initialProfiles = Array.isArray(localConfig.mqtt?.profiles) && localConfig.mqtt.profiles.length
  ? localConfig.mqtt.profiles.map((profile, index) => normalizeProfile(profile, index, initialBrokers[0]?.id, legacyDiscovery))
  : [normalizeProfile({
    id: 'homeassistant',
    name: 'Home Assistant',
    mode: legacyDiscovery.mode,
    brokerId: initialBrokers[0]?.id,
    enabled: legacyDiscovery.enabled,
    isDefault: true,
    discoveryPrefix: legacyDiscovery.prefix,
    topicPrefix: legacyMqtt.topicPrefix
  }, 0, initialBrokers[0]?.id, legacyDiscovery)];

if (!initialProfiles.some((profile) => profile.isDefault)) initialProfiles[0].isDefault = true;

const runtimeConfig = {
  application: {
    publicUrl: normalizePublicUrl(configuredValue('GRIDVIS2MQTT_PUBLIC_URL', 'application', 'publicUrl')),
    publicIconApi
  },
  gridvis: {
    baseUrl: configuredValue('GRIDVIS_URL', 'gridvis', 'baseUrl'),
    username: configuredValue('GRIDVIS_USERNAME', 'gridvis', 'username'),
    password: configuredValue('GRIDVIS_PASSWORD', 'gridvis', 'password'),
    project: configuredValue('GRIDVIS_PROJECT', 'gridvis', 'project'),
    authEnabled: process.env.GRIDVIS_AUTH_ENABLED !== undefined
      ? process.env.GRIDVIS_AUTH_ENABLED !== 'false'
      : localConfig.gridvis?.authEnabled === true,
    enabled: localConfig.gridvis?.enabled !== false
  },
  mqtt: {
    ...legacyMqtt,
    brokers: initialBrokers,
    profiles: initialProfiles,
    defaultProfileId: initialProfiles.find((profile) => profile.isDefault)?.id || initialProfiles[0].id,
    retainedDiscovery: normalizeRetainedDiscovery(localConfig.mqtt?.retainedDiscovery)
  },
  discovery: legacyDiscovery
};

function syncCompatibilityConfig() {
  const primaryBroker = runtimeConfig.mqtt.brokers[0] || normalizeBroker({ id: 'default', name: 'Hauptbroker' });
  const defaultProfile = runtimeConfig.mqtt.profiles.find((profile) => profile.id === runtimeConfig.mqtt.defaultProfileId)
    || runtimeConfig.mqtt.profiles.find((profile) => profile.isDefault)
    || runtimeConfig.mqtt.profiles[0];
  runtimeConfig.mqtt.url = primaryBroker.url;
  runtimeConfig.mqtt.username = primaryBroker.username;
  runtimeConfig.mqtt.password = primaryBroker.password;
  runtimeConfig.mqtt.topicPrefix = defaultProfile?.topicPrefix || runtimeConfig.mqtt.topicPrefix || 'gridvis2mqtt';
  if (defaultProfile) {
    runtimeConfig.mqtt.defaultProfileId = defaultProfile.id;
    runtimeConfig.discovery = {
      enabled: defaultProfile.enabled,
      mode: defaultProfile.mode,
      prefix: defaultProfile.discoveryPrefix
    };
  }
}

syncCompatibilityConfig();

function writeLocalConfig() {
  if (!canWriteLocalConfig) return;
  mkdirSync(dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(localConfigPath, 0o600);
}

export function getConfig() {
  return structuredClone(runtimeConfig);
}

export function getPublicConfig() {
  const safeBrokers = runtimeConfig.mqtt.brokers.map((broker) => ({
    id: broker.id,
    name: broker.name,
    url: broker.url,
    clientId: broker.clientId,
    username: broker.username,
    passwordConfigured: Boolean(broker.password),
    enabled: broker.enabled
  }));
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    application: {
      publicUrl: runtimeConfig.application.publicUrl,
      publicIconApi: runtimeConfig.application.publicIconApi
    },
    gridvis: {
      baseUrl: runtimeConfig.gridvis.baseUrl,
      username: runtimeConfig.gridvis.username,
      passwordConfigured: Boolean(runtimeConfig.gridvis.password),
      authEnabled: runtimeConfig.gridvis.authEnabled === true,
      project: runtimeConfig.gridvis.project,
      enabled: runtimeConfig.gridvis.enabled !== false,
      configured: Boolean(runtimeConfig.gridvis.baseUrl) && runtimeConfig.gridvis.enabled !== false
    },
    mqtt: {
      url: runtimeConfig.mqtt.url,
      topicPrefix: runtimeConfig.mqtt.topicPrefix,
      configured: Boolean(runtimeConfig.mqtt.url),
      brokers: safeBrokers,
      profiles: structuredClone(runtimeConfig.mqtt.profiles),
      defaultProfileId: runtimeConfig.mqtt.defaultProfileId
    },
    discovery: structuredClone(runtimeConfig.discovery)
  };
}

export function updateConfig(input = {}) {
  for (const section of ['application', 'gridvis', 'mqtt']) {
    if (!input[section] || typeof input[section] !== 'object') continue;
    for (const [key, value] of Object.entries(input[section])) {
      if (typeof value === 'boolean') {
        runtimeConfig[section][key] = value;
      } else if (typeof value === 'string' && key !== 'password') {
        runtimeConfig[section][key] = value.trim();
      } else if (key === 'password' && typeof value === 'string' && value.length > 0) {
        runtimeConfig[section][key] = value;
      }
    }
  }

  runtimeConfig.application.publicUrl = normalizePublicUrl(runtimeConfig.application.publicUrl);

  if (input.mqtt && typeof input.mqtt === 'object') {
    if (Array.isArray(input.mqtt.brokers)) {
      const previous = new Map(runtimeConfig.mqtt.brokers.map((broker) => [broker.id, broker]));
      runtimeConfig.mqtt.brokers = input.mqtt.brokers.map((broker, index) => {
        const old = previous.get(broker.id) || {};
        const next = { ...old, ...broker };
        if (!broker.password && old.password) next.password = old.password;
        return normalizeBroker(next, index, old);
      });
    }

    if (Array.isArray(input.mqtt.profiles) && input.mqtt.profiles.length) {
      runtimeConfig.mqtt.profiles = input.mqtt.profiles.map((profile, index) => normalizeProfile(
        profile,
        index,
        runtimeConfig.mqtt.brokers[0]?.id,
        runtimeConfig.mqtt.profiles[index] || {}
      ));
    }

    if (typeof input.mqtt.defaultProfileId === 'string' && input.mqtt.defaultProfileId.trim()) {
      runtimeConfig.mqtt.defaultProfileId = input.mqtt.defaultProfileId.trim();
    }

    if (Array.isArray(input.mqtt.retainedDiscovery)) {
      runtimeConfig.mqtt.retainedDiscovery = normalizeRetainedDiscovery(input.mqtt.retainedDiscovery);
    }
  }

  if (input.discovery && typeof input.discovery === 'object') {
    const defaultProfile = runtimeConfig.mqtt.profiles.find((profile) => profile.id === runtimeConfig.mqtt.defaultProfileId);
    if (typeof input.discovery.enabled === 'boolean') {
      runtimeConfig.discovery.enabled = input.discovery.enabled;
      if (defaultProfile) defaultProfile.enabled = input.discovery.enabled;
    }
    if (typeof input.discovery.mode === 'string' && input.discovery.mode.trim()) {
      runtimeConfig.discovery.mode = input.discovery.mode.trim();
      if (defaultProfile) defaultProfile.mode = input.discovery.mode.trim();
    }
    if (typeof input.discovery.prefix === 'string' && input.discovery.prefix.trim()) {
      if (defaultProfile) defaultProfile.discoveryPrefix = normalizeDiscoveryPrefix(input.discovery.prefix);
    }
  }

  syncCompatibilityConfig();
  writeLocalConfig();
  return getConfig();
}
