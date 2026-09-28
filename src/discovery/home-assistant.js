import { APP_NAME, APP_VERSION } from '../config.js';
import { measurementDisplayName, measurementUnitInfo } from '../../public/measurement-display.js';

function slugify(value) {
  return String(value || 'unknown')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'unknown';
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export const BRIDGE_DEVICE_IDENTIFIER = 'gridvis2mqtt_bridge';

function rawDeviceInfo(device = {}) {
  const info = firstValue(device.info, device.deviceInfo, device.device_info);
  return info && typeof info === 'object' && !Array.isArray(info) ? info : {};
}

function buildDeviceInfo(device, deviceId) {
  const info = rawDeviceInfo(device);
  const modelId = firstValue(device?.modelId, device?.model_id, device?.type, info.modelId, info.model_id, info.type);
  const deviceInfo = {
    identifiers: [`gridvis2mqtt_${deviceId}`],
    name: firstValue(device?.name, device?.serialNr, `GridVis ${deviceId}`),
    manufacturer: firstValue(device?.manufacturer, info.manufacturer, 'Janitza'),
    model: firstValue(device?.model, device?.typeDisplayName, info.model, modelId, 'GridVis-Messgerät'),
    model_id: modelId,
    serial_number: firstValue(device?.serialNr, device?.serialNumber, device?.serial, device?.serialNo, info.serialNumber, info.serialNr),
    configuration_url: firstValue(device?.configurationUrl, device?.configuration_url),
    // Home Assistant expects an identifier of an already discovered parent
    // device here, not the parent's display name.
    via_device: BRIDGE_DEVICE_IDENTIFIER
  };

  for (const key of Object.keys(deviceInfo)) {
    if (deviceInfo[key] === undefined) delete deviceInfo[key];
  }
  return deviceInfo;
}

function deviceInfoAttributes(device = {}) {
  const info = rawDeviceInfo(device);
  const attributes = { ...device, ...info };
  delete attributes.info;
  delete attributes.deviceInfo;
  delete attributes.device_info;
  const aliases = [
    ['firmware', ['firmware', 'firmwareVersion']],
    ['hardware', ['hardware', 'hardwareVersion']],
    ['serialNumber', ['serialNumber', 'serialNr', 'serial', 'serialNo']],
    ['status', ['status', 'state', 'online', 'connected']],
    ['statusMsg', ['statusMsg', 'statusMessage', 'message']],
    ['type', ['type', 'model', 'deviceType', 'product']]
  ];
  for (const [name, keys] of aliases) {
    const value = firstValue(...keys.map((key) => device?.[key]), ...keys.map((key) => info?.[key]));
    if (value !== undefined) attributes[name] = value;
  }
  return attributes;
}

function deviceIconProxyUrl(project, deviceId, applicationUrl = '') {
  const path = `/api/gridvis/projects/${encodeURIComponent(project)}/deviceicon/${encodeURIComponent(deviceId)}`;
  const base = String(applicationUrl || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

/**
 * A discovery prefix is a namespace, not a publish wildcard.
 * A trailing /# is accepted as subscription notation, but the wildcard
 * must not be part of a published topic.
 */
export function normalizeDiscoveryPrefix(value = 'homeassistant') {
  const prefix = String(value || 'homeassistant')
    .trim()
    .replace(/(?:\/(?:#|\+))+$/g, '')
    .replace(/^\/+|\/+$/g, '');

  return prefix && !/[# +]/.test(prefix) ? prefix : 'homeassistant';
}

function normalizeComponent(value = 'sensor') {
  const component = String(value || 'sensor').trim().replace(/^\/+|\/+$/g, '');
  return component || 'sensor';
}

function renderTopicTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) => values[key] ?? match)
    .split('/')
    .filter(Boolean)
    .join('/');
}

function getValueType(measurement = {}) {
  return measurement.valueType || measurement.value_type || {};
}

const HISTORY_RANGE_LABELS = {
  today: 'Heute',
  yesterday: 'Gestern',
  last24hours: 'Letzte 24 Stunden',
  thisweek: 'Diese Woche',
  lastweek: 'Letzte Woche',
  thismonth: 'Dieser Monat',
  lastmonth: 'Letzter Monat',
  thisyear: 'Dieses Jahr',
  lastyear: 'Letztes Jahr',
  last3months: 'Letzte 3 Monate',
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

function historyRangeLabel(value) {
  if (HISTORY_RANGE_LABELS[value]) return HISTORY_RANGE_LABELS[value];
  const match = /^comparison_(today|yesterday|last24hours|thisweek|lastweek|thismonth|lastmonth|thisyear|lastyear|last3months)_(hours|days|weeks|months|quarters|years)_(\d+)$/.exec(String(value || ''));
  if (match) {
    const units = {
      hours: ['Stunde', 'Stunden'],
      days: ['Tag', 'Tage'],
      weeks: ['Woche', 'Wochen'],
      months: ['Monat', 'Monate'],
      quarters: ['Quartal', 'Quartale'],
      years: ['Jahr', 'Jahre']
    };
    const baseLabel = HISTORY_RANGE_LABELS[match[1]];
    const amount = Number(match[3]);
    const [singular, plural] = units[match[2]];
    return `Vergleich: ${amount} ${amount === 1 ? singular : plural} zuvor (${baseLabel})`;
  }
  return String(value || 'Heute');
}

export function normalizeMeasurement(measurement = {}) {
  const valueType = getValueType(measurement);
  const value = firstValue(measurement.value, valueType.value, measurement.id, measurement.name, 'value');
  const type = firstValue(measurement.type, valueType.type, valueType.typeName, 'Overall');
  const historyRanges = Array.isArray(measurement.historyRanges) ? measurement.historyRanges : [];
  const displaySettings = measurement.displaySettings && typeof measurement.displaySettings === 'object'
    ? measurement.displaySettings
    : {};
  return {
    id: String(firstValue(measurement.id, value, `${value}-${type}`)),
    value: String(value),
    type: String(type),
    typeLabel: String(firstValue(measurement.typeLabel, valueType.typeName, type)),
    name: String(firstValue(measurement.name, valueType.valueName, value)),
    unit: firstValue(measurement.unit, valueType.unit, null),
    online: Boolean(measurement.online),
    historical: measurement.historical === true || Boolean(measurement.historyRange) || historyRanges.length > 0,
    historyRange: measurement.historyRange || null,
    historyRanges,
    displaySettings: Number.isInteger(displaySettings.decimals) && displaySettings.decimals >= 0 && displaySettings.decimals <= 6
      ? { decimals: displaySettings.decimals }
      : {}
  };
}

// Only assign HA classes for compatible native units. Display-unit preferences
// never change the MQTT unit (e.g. an API value in Wh stays Wh); an explicit
// decimal preference is forwarded as a Home Assistant display suggestion.
export function homeAssistantSensorMetadata(measurement, { historical = false } = {}) {
  const { unit, baseUnit } = measurementUnitInfo(measurement);
  const unitsByClass = {
    energy: ['mWh', 'Wh', 'kWh', 'MWh', 'GWh', 'TWh', 'J', 'kJ', 'MJ', 'GJ'],
    power: ['mW', 'W', 'kW', 'MW', 'GW', 'TW'],
    voltage: ['µV', 'mV', 'V', 'kV', 'MV'],
    current: ['µA', 'mA', 'A'],
    frequency: ['mHz', 'Hz', 'kHz', 'MHz', 'GHz'],
    apparent_power: ['mVA', 'VA', 'kVA'],
    reactive_power: ['mvar', 'var', 'kvar'],
    reactive_energy: ['varh', 'kvarh'],
    temperature: ['°C', '°F', 'K']
  };
  let deviceClass = Object.keys(unitsByClass).find((key) => unitsByClass[key].includes(unit));
  const identity = `${measurement.value} ${measurement.name}`;
  if ((!unit || unit === '%') && /power.?factor|cos.?phi|leistungsfaktor/i.test(identity)) deviceClass = 'power_factor';
  const energy = deviceClass === 'energy' || deviceClass === 'reactive_energy' || baseUnit === 'VAh';
  // Separate consumption/production counters increase; a signed net meter can
  // decrease and must never be classified as total_increasing.
  const net = /\bnet\b|EnergyNet\b|netto|saldo|balance|signed|difference/i.test(identity);
  const counter = /^(?:Active|Reactive|Apparent)Energy/i.test(measurement.value)
    || /(?:wirk|blind|schein)arbeit|consumed|delivered|import|export|bezug|bezogen|geliefert|zähler/i.test(identity);
  const configuredDecimals = measurement.displaySettings?.decimals;
  return {
    device_class: deviceClass,
    state_class: energy ? (historical ? 'total' : (counter && !net ? 'total_increasing' : 'total')) : 'measurement',
    unit_of_measurement: unit || undefined,
    suggested_display_precision: Number.isInteger(configuredDecimals)
      ? configuredDecimals
      : ['voltage', 'power', 'current', 'frequency', 'apparent_power', 'reactive_power', 'temperature', 'power_factor'].includes(deviceClass) ? 1 : undefined
  };
}

export function buildHomeAssistantDiscovery({
  project,
  device,
  measurement,
  topicPrefix = 'gridvis2mqtt',
  discoveryPrefix = 'homeassistant',
  component = 'sensor',
  profile = {}
}) {
  const normalized = normalizeMeasurement(measurement);
  const historical = normalized.historical === true;
  const selectedHistoryRange = normalized.historyRange || normalized.historyRanges[0] || (historical ? 'today' : '');
  const deviceId = slugify(firstValue(device?.id, device?.serialNr, device?.serialNumber, device?.name));
  const entityId = slugify([
    normalized.value,
    normalized.type,
    ...(historical ? ['history', selectedHistoryRange] : [])
  ].join('_'));
  const uniqueId = 'gridvis2mqtt_' + deviceId + '_' + entityId;
  const profileTopicPrefix = String(profile.topicPrefix || topicPrefix || 'gridvis2mqtt').replace(/^\/+|\/+$/g, '');
  const normalizedDiscoveryPrefix = normalizeDiscoveryPrefix(profile.discoveryPrefix || discoveryPrefix);
  const normalizedComponent = normalizeComponent(profile.component || component);
  const topicValues = {
    topicPrefix: profileTopicPrefix,
    discoveryPrefix: normalizedDiscoveryPrefix,
    component: normalizedComponent,
    project: slugify(project),
    deviceId,
    valueType: entityId,
    measurement: slugify(normalized.value),
    type: slugify(normalized.type),
    postfix: 'state',
    historyRange: selectedHistoryRange ? slugify(selectedHistoryRange) : ''
  };
  const stateTopic = renderTopicTemplate(
    profile.stateTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/state',
    topicValues
  );
  const availabilityTopic = renderTopicTemplate(
    profile.availabilityTopicTemplate || '{topicPrefix}/{project}/{deviceId}/{valueType}/availability',
    { ...topicValues, postfix: 'availability' }
  );
  const configTopic = renderTopicTemplate(
    profile.discoveryTopicTemplate || '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config',
    { ...topicValues, postfix: 'config' }
  );

  const payload = {
    name: historical
      ? `${measurementDisplayName(normalized)} – ${historyRangeLabel(selectedHistoryRange)}`
      : measurementDisplayName(normalized),
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: '{{ value_json.value }}',
    availability_topic: availabilityTopic,
    payload_available: 'online',
    payload_not_available: 'offline',
    ...homeAssistantSensorMetadata(normalized, { historical }),
    device: buildDeviceInfo(device, deviceId),
    origin: {
      name: APP_NAME,
      sw: APP_VERSION
    }
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  return {
    profile: 'homeassistant-mqtt',
    discoveryPrefix: normalizedDiscoveryPrefix,
    component: normalizedComponent,
    profileId: profile.id || 'homeassistant',
    nodeId: deviceId,
    objectId: entityId,
    configTopic,
    stateTopic,
    availabilityTopic,
    uniqueId,
    payload
  };
}

export function buildDeviceInfoDiscoveries({
  project,
  device,
  topicPrefix = 'gridvis2mqtt',
  discoveryPrefix = 'homeassistant',
  profile = {},
  applicationUrl = ''
} = {}) {
  const deviceId = slugify(firstValue(device?.id, device?.serialNr, device?.serialNumber, device?.name));
  const profileTopicPrefix = String(profile.topicPrefix || topicPrefix || 'gridvis2mqtt').replace(/^\/+|\/+$/g, '');
  const normalizedDiscoveryPrefix = normalizeDiscoveryPrefix(profile.discoveryPrefix || discoveryPrefix);
  const normalizedComponent = normalizeComponent(profile.component || 'sensor');
  const profileId = slugify(profile.id || 'homeassistant');
  const attributes = deviceInfoAttributes(device);
  const iconURL = firstValue(
    attributes.iconURL,
    attributes.iconUrl,
    attributes.icon_url,
    deviceIconProxyUrl(project, deviceId, applicationUrl)
  );
  attributes.icon_url = iconURL;
  const definitions = [
    { id: 'firmware', name: 'Firmware', keys: ['firmware', 'firmwareVersion'], icon: 'mdi:chip' },
    { id: 'hardware', name: 'Hardware', keys: ['hardware', 'hardwareVersion'], icon: 'mdi:memory' },
    { id: 'serial_number', name: 'Seriennummer', keys: ['serialNumber', 'serialNr', 'serial', 'serialNo'], icon: 'mdi:identifier' },
    { id: 'status', name: 'Status', keys: ['status', 'state', 'online', 'connected'], icon: 'mdi:connection' },
    { id: 'status_message', name: 'Statusmeldung', keys: ['statusMsg', 'statusMessage', 'message'], icon: 'mdi:message-text-outline' },
    { id: 'type', name: 'Typ', keys: ['type', 'model', 'deviceType', 'product'], icon: 'mdi:information-outline' },
    { id: 'icon_url', name: 'iconURL', keys: ['iconURL', 'iconUrl', 'icon_url'], icon: 'mdi:image-outline' }
  ];

  return definitions.flatMap((definition) => {
    const value = firstValue(attributes[definition.id], ...definition.keys.map((key) => attributes[key]));
    if (value === undefined || value === null || value === '') return [];

    const objectId = `device_info_${definition.id}_${profileId}`;
    const stateTopic = `${profileTopicPrefix}/${slugify(project)}/${deviceId}/device_info/${definition.id}/${profileId}/state`;
    const availabilityTopic = `${profileTopicPrefix}/${slugify(project)}/${deviceId}/device_info/${definition.id}/${profileId}/availability`;
    const configTopic = `${normalizedDiscoveryPrefix}/${normalizedComponent}/${deviceId}/${objectId}/config`;
    const payload = {
      name: definition.name,
      unique_id: `gridvis2mqtt_${deviceId}_${objectId}`,
      state_topic: stateTopic,
      value_template: '{{ value_json.value }}',
      availability_topic: availabilityTopic,
      payload_available: 'online',
      payload_not_available: 'offline',
      entity_category: 'diagnostic',
      icon: definition.icon,
      device: buildDeviceInfo(device, deviceId),
      origin: {
        name: APP_NAME,
        sw: APP_VERSION
      }
    };

    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }

    return [{
      profile: 'homeassistant-mqtt',
      discoveryPrefix: normalizedDiscoveryPrefix,
      component: normalizedComponent,
      profileId: profile.id || 'homeassistant',
      nodeId: deviceId,
      objectId,
      configTopic,
      stateTopic,
      availabilityTopic,
      uniqueId: payload.unique_id,
      stateValue: typeof value === 'string' ? value : JSON.stringify(value),
      stateTime: new Date().toISOString(),
      stateRetain: true,
      payload
    }];
  });
}

// Kept for callers that only need the first diagnostic item. New publishing
// code should use the plural function so every device detail is represented.
export function buildDeviceInfoDiscovery(options = {}) {
  return buildDeviceInfoDiscoveries(options)[0] || null;
}

/**
 * Home Assistant cannot create a standalone device from a single-component
 * discovery payload. This small diagnostic entity gives the MQTT bridge its
 * own device registry entry, so measurement devices can reference it via
 * `via_device`.
 */
export function buildBridgeDiscovery({
  topicPrefix = 'gridvis2mqtt',
  discoveryPrefix = 'homeassistant',
  profile = {},
  gridvisVersion = '',
  gridvisInfo = {},
  configurationUrl = ''
} = {}) {
  const profileTopicPrefix = String(profile.topicPrefix || topicPrefix || 'gridvis2mqtt').replace(/^\/+|\/+$/g, '');
  const normalizedDiscoveryPrefix = normalizeDiscoveryPrefix(profile.discoveryPrefix || discoveryPrefix);
  const normalizedComponent = normalizeComponent(profile.component || 'sensor');
  const profileId = slugify(profile.id || 'homeassistant');
  const objectId = `bridge_gridvis_version_${profileId}`;
  const stateTopic = `${profileTopicPrefix}/bridge/gridvis_version/${profileId}/state`;
  const availabilityTopic = `${profileTopicPrefix}/bridge/availability`;
  const configTopic = `${normalizedDiscoveryPrefix}/${normalizedComponent}/gridvis2mqtt/${objectId}/config`;
  const version = String(gridvisVersion || 'unbekannt');
  const bridgeDevice = {
    identifiers: [BRIDGE_DEVICE_IDENTIFIER],
    name: APP_NAME,
    manufacturer: APP_NAME,
    model: 'GridVis MQTT Bridge',
    model_id: 'gridvis2mqtt',
    sw_version: APP_VERSION,
    configuration_url: firstValue(configurationUrl)
  };

  const payload = {
    name: 'GridVis-Version',
    unique_id: `gridvis2mqtt_${objectId}`,
    state_topic: stateTopic,
    value_template: '{{ value_json.value }}',
    json_attributes_topic: stateTopic,
    json_attributes_template: '{{ value_json.attributes | tojson }}',
    availability_topic: availabilityTopic,
    payload_available: 'online',
    payload_not_available: 'offline',
    entity_category: 'diagnostic',
    icon: 'mdi:application-cog',
    device: bridgeDevice,
    origin: {
      name: APP_NAME,
      sw: APP_VERSION
    }
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  return {
    profile: 'homeassistant-mqtt',
    discoveryPrefix: normalizedDiscoveryPrefix,
    component: normalizedComponent,
    profileId: profile.id || 'homeassistant',
    nodeId: 'gridvis2mqtt',
    objectId,
    configTopic,
    stateTopic,
    availabilityTopic,
    uniqueId: payload.unique_id,
    stateValue: version,
    stateTime: new Date().toISOString(),
    statePayload: {
      attributes: gridvisInfo && typeof gridvisInfo === 'object' && !Array.isArray(gridvisInfo)
        ? gridvisInfo
        : { version }
    },
    stateRetain: true,
    payload
  };
}

export function buildBridgeApplicationUrlDiscovery({
  topicPrefix = 'gridvis2mqtt',
  discoveryPrefix = 'homeassistant',
  profile = {},
  applicationUrl = ''
} = {}) {
  const profileTopicPrefix = String(profile.topicPrefix || topicPrefix || 'gridvis2mqtt').replace(/^\/+|\/+$/g, '');
  const normalizedDiscoveryPrefix = normalizeDiscoveryPrefix(profile.discoveryPrefix || discoveryPrefix);
  const normalizedComponent = normalizeComponent(profile.component || 'sensor');
  const profileId = slugify(profile.id || 'homeassistant');
  const objectId = `bridge_gridvis2mqtt_url_${profileId}`;
  const stateTopic = `${profileTopicPrefix}/bridge/gridvis2mqtt_url/${profileId}/state`;
  const availabilityTopic = `${profileTopicPrefix}/bridge/availability`;
  const configTopic = `${normalizedDiscoveryPrefix}/${normalizedComponent}/gridvis2mqtt/${objectId}/config`;
  const base = String(applicationUrl || '').replace(/\/+$/, '');
  const applicationUrlValue = String(applicationUrl || '').trim() || 'nicht konfiguriert';
  const bridgeDevice = {
    identifiers: [BRIDGE_DEVICE_IDENTIFIER],
    name: APP_NAME,
    manufacturer: APP_NAME,
    model: 'GridVis MQTT Bridge',
    model_id: 'gridvis2mqtt',
    sw_version: APP_VERSION,
    configuration_url: firstValue(applicationUrl)
  };
  const payload = {
    name: 'GridVis2MQTT-URL',
    unique_id: `gridvis2mqtt_${objectId}`,
    state_topic: stateTopic,
    value_template: '{{ value_json.value }}',
    availability_topic: availabilityTopic,
    payload_available: 'online',
    payload_not_available: 'offline',
    entity_category: 'diagnostic',
    icon: 'mdi:web',
    device: bridgeDevice,
    origin: {
      name: APP_NAME,
      sw: APP_VERSION
    }
  };

  return {
    profile: 'homeassistant-mqtt',
    discoveryPrefix: normalizedDiscoveryPrefix,
    component: normalizedComponent,
    profileId: profile.id || 'homeassistant',
    nodeId: 'gridvis2mqtt',
    objectId,
    configTopic,
    stateTopic,
    availabilityTopic,
    uniqueId: payload.unique_id,
    stateValue: applicationUrlValue,
    stateTime: new Date().toISOString(),
    stateRetain: true,
    payload
  };
}

export function buildDiscoveryMessages({ project, device, measurements, topicPrefix, discoveryPrefix, profile }) {
  return measurements.map((measurement) => buildHomeAssistantDiscovery({
    project,
    device,
    measurement,
    topicPrefix,
    discoveryPrefix,
    profile
  }));
}
