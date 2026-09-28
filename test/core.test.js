import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBridgeApplicationUrlDiscovery, buildBridgeDiscovery, buildDeviceInfoDiscoveries, buildHomeAssistantDiscovery } from '../src/discovery/home-assistant.js';
import { GridVisClient, groupOnlineValueRequests, normalizeOnlineValues } from '../src/gridvis-client.js';
import { MqttPublisher } from '../src/mqtt-publisher.js';

test('normalizes GridVis online value maps without relying on response order', () => {
  const values = normalizeOnlineValues({
    value: {
      '26.U_Effective.L1': 241.4,
      '26.U_Effective.L2': 239.8,
      '26.U_Effective.L2-L1': 416.2
    },
    time: {
      '26.U_Effective.L1': 100,
      '26.U_Effective.L2': 101,
      '26.U_Effective.L2-L1': 102
    },
    valueType: {}
  });

  assert.deepEqual(values.map((entry) => [entry.valueType.value, entry.valueType.type, entry.value]), [
    ['U_Effective', 'L1', 241.4],
    ['U_Effective', 'L2', 239.8],
    ['U_Effective', 'L2-L1', 416.2]
  ]);
  assert.equal(values[2].time, 102);
});

test('groups online value types like the ioBroker adapter', () => {
  assert.deepEqual(groupOnlineValueRequests([
    '27;U_Effective;L1',
    '27;U_Effective;L2',
    '27;U_Effective;L1',
    '161;PowerActive;SUM13',
    'invalid'
  ]), [
    '27;U_Effective;L1,L2',
    '161;PowerActive;SUM13',
    'invalid'
  ]);
});

test('uses one grouped online-values request for multiple types', async () => {
  const client = new GridVisClient({ baseUrl: 'http://gridvis.test' });
  let requestedPath = '';
  client.request = async (path) => {
    requestedPath = path;
    return { value: {} };
  };

  await client.getOnlineValues({
    project: 'EnergieMonitoring',
    values: ['27;U_Effective;L1', '27;U_Effective;L2']
  });

  assert.match(requestedPath, /value=27%3BU_Effective%3BL1%2CL2/);
  assert.doesNotMatch(requestedPath, /value=27%3BU_Effective%3BL1&/);
  assert.doesNotMatch(requestedPath, /appendValueType=/);
});

test('uses the current histenergy route for historical energy reads', async () => {
  const client = new GridVisClient({ baseUrl: 'http://gridvis.test' });
  let requestedPath = '';
  client.request = async (path) => {
    requestedPath = path;
    return { energy: 123 };
  };

  await client.getHistory({
    project: 'EnergieMonitoring',
    deviceId: 27,
    value: 'ActiveEnergy',
    type: 'SUM13',
    timebase: 900,
    start: 'NAMED_Yesterday',
    end: 'NAMED_Today',
    anchor: 'deprecated-anchor',
    energy: true
  });

  assert.match(requestedPath, /^\/rest\/1\/projects\/EnergieMonitoring\/devices\/27\/histenergy\?/);
  assert.match(requestedPath, /value=ActiveEnergy/);
  assert.match(requestedPath, /type=SUM13/);
  assert.doesNotMatch(requestedPath, /timebase=/);
  assert.doesNotMatch(requestedPath, /hist%2Fenergy|hist\/energy|anchor=/);
});

test('uses the aggregate histenergy route for non-energy historical reads', async () => {
  const client = new GridVisClient({ baseUrl: 'http://gridvis.test' });
  let requestedPath = '';
  client.request = async (path) => {
    requestedPath = path;
    return { energy: 237.8 };
  };

  await client.getHistory({
    project: 'EnergieMonitoring',
    deviceId: 27,
    value: 'U_Effective',
    type: 'L1',
    timebase: 60,
    start: 'NAMED_Today',
    end: 'NAMED_Today',
    anchor: 'deprecated-anchor'
  });

  assert.match(requestedPath, /^\/rest\/1\/projects\/EnergieMonitoring\/devices\/27\/histenergy\?/);
  assert.match(requestedPath, /value=U_Effective/);
  assert.match(requestedPath, /type=L1/);
  assert.doesNotMatch(requestedPath, /timebase=/);
  assert.doesNotMatch(requestedPath, /hist%2Fvalues|hist\/values|anchor=/);
});

test('sends GridVis Basic authentication only when explicitly enabled', async () => {
  const originalFetch = globalThis.fetch;
  const authorizationHeaders = [];
  globalThis.fetch = async (_url, options = {}) => {
    authorizationHeaders.push(new Headers(options.headers).get('authorization'));
    return {
      ok: true,
      status: 200,
      text: async () => '{}'
    };
  };

  try {
    await new GridVisClient({
      baseUrl: 'http://gridvis.test',
      username: 'gridvis-user',
      password: 'gridvis-password'
    }).getVersion();
    await new GridVisClient({
      baseUrl: 'http://gridvis.test',
      username: 'gridvis-user',
      password: 'gridvis-password',
      authEnabled: true
    }).getVersion();
    await new GridVisClient({
      baseUrl: 'http://gridvis.test',
      password: 'gridvis-password',
      authEnabled: true
    }).getVersion();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(authorizationHeaders, [
    null,
    'Basic ' + Buffer.from('gridvis-user:gridvis-password').toString('base64'),
    null
  ]);
});

test('creates a stable Home Assistant discovery message for a measurement', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'Haus',
    device: { id: 12, name: 'UMG 96', serialNr: '47001297', type: 'JanitzaUMG801', typeDisplayName: 'UMG 801' },
    measurement: { value: 'ActivePower', type: 'Overall', name: 'Aktive Leistung', unit: 'W' },
    discoveryPrefix: 'gridvis/discovery/#'
  });

  assert.equal(message.configTopic, 'gridvis/discovery/sensor/12/activepower_overall/config');
  assert.equal(message.stateTopic, 'gridvis2mqtt/haus/12/activepower_overall/state');
  assert.equal(message.payload.unit_of_measurement, 'W');
  assert.equal(message.payload.device_class, 'power');
  assert.equal(message.payload.value_template, '{{ value_json.value }}');
  assert.deepEqual(message.payload.device.identifiers, ['gridvis2mqtt_12']);
  assert.equal(message.payload.device.serial_number, '47001297');
  assert.equal(message.payload.device.model, 'UMG 801');
  assert.equal(message.payload.device.model_id, 'JanitzaUMG801');
  assert.equal(message.payload.device.via_device, 'gridvis2mqtt_bridge');
});

test('creates a parent bridge device for Home Assistant topology', () => {
  const message = buildBridgeDiscovery({
    topicPrefix: 'gridvis2mqtt',
    discoveryPrefix: 'homeassistant',
    profile: { id: 'homeassistant' },
    gridvisVersion: '8.0.2',
    gridvisInfo: { version: '8.0.2', build: '1234' }
  });

  assert.equal(message.configTopic, 'homeassistant/sensor/gridvis2mqtt/bridge_gridvis_version_homeassistant/config');
  assert.equal(message.stateTopic, 'gridvis2mqtt/bridge/gridvis_version/homeassistant/state');
  assert.equal(message.stateValue, '8.0.2');
  assert.deepEqual(message.payload.device.identifiers, ['gridvis2mqtt_bridge']);
  assert.equal(message.payload.device.name, 'GridVis2MQTT');
  assert.equal(message.payload.entity_category, 'diagnostic');
  assert.deepEqual(message.statePayload.attributes, { version: '8.0.2', build: '1234' });
  assert.equal(message.stateRetain, true);
});

test('discovers the GridVis2MQTT application URL on the parent device', () => {
  const message = buildBridgeApplicationUrlDiscovery({
    topicPrefix: 'gridvis2mqtt',
    discoveryPrefix: 'homeassistant',
    profile: { id: 'homeassistant' },
    applicationUrl: 'http://gridvis2mqtt:8080/'
  });

  assert.equal(message.configTopic, 'homeassistant/sensor/gridvis2mqtt/bridge_gridvis2mqtt_url_homeassistant/config');
  assert.equal(message.stateTopic, 'gridvis2mqtt/bridge/gridvis2mqtt_url/homeassistant/state');
  assert.equal(message.stateValue, 'http://gridvis2mqtt:8080/');
  assert.equal(message.payload.name, 'GridVis2MQTT-URL');
  assert.deepEqual(message.payload.device.identifiers, ['gridvis2mqtt_bridge']);
  assert.equal(message.stateRetain, true);
});

test('maps GridVis device detail information into HA metadata and diagnostics', () => {
  const device = {
    id: 27,
    name: 'Hauptverteilung',
    info: {
      firmware: '1.2.3',
      hardware: 'Rev B',
      serialNumber: '47001297',
      status: 'online',
      statusMsg: 'OK',
      type: 'JanitzaUMG801MeasurementGroup'
    }
  };
  const sensor = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device,
    measurement: { value: 'PowerActive', type: 'Overall', name: 'Wirkleistung', unit: 'W' }
  });
  const infos = buildDeviceInfoDiscoveries({ project: 'EnergieMonitoring', device });
  const firmware = infos.find((message) => message.objectId.startsWith('device_info_firmware_'));
  const status = infos.find((message) => message.objectId.startsWith('device_info_status_'));
  const statusMessage = infos.find((message) => message.objectId.startsWith('device_info_status_message_'));
  const iconUrl = infos.find((message) => message.objectId.startsWith('device_info_icon_url_'));

  assert.equal(sensor.payload.device.serial_number, '47001297');
  assert.equal(sensor.payload.device.hw_version, undefined);
  assert.equal(sensor.payload.device.sw_version, undefined);
  assert.equal(firmware.stateValue, '1.2.3');
  assert.equal(status.stateValue, 'online');
  assert.equal(statusMessage.stateValue, 'OK');
  assert.equal(status.payload.json_attributes_topic, undefined);
  assert.equal(status.payload.state_class, undefined);
  assert.equal(status.stateRetain, true);
  assert.match(status.stateTopic, /device_info\/status\//);
  assert.equal(iconUrl.stateValue, '/api/gridvis/projects/EnergieMonitoring/deviceicon/27');
  assert.equal(iconUrl.payload.name, 'iconURL');
  assert.equal(iconUrl.payload.entity_category, 'diagnostic');

  const absoluteIconUrl = buildDeviceInfoDiscoveries({
    project: 'EnergieMonitoring',
    device,
    applicationUrl: 'http://gridvis2mqtt:8080/'
  }).find((message) => message.objectId.startsWith('device_info_icon_url_'));
  assert.equal(absoluteIconUrl.stateValue, 'http://gridvis2mqtt:8080/api/gridvis/projects/EnergieMonitoring/deviceicon/27');
});

test('keeps measurement discovery stable when firmware or hardware changes', () => {
  const base = {
    id: 27,
    name: 'Hauptverteilung',
    serialNr: '47001297',
    type: 'JanitzaUMG801MeasurementGroup',
    info: { firmware: '1.0.0', hardware: '3' }
  };
  const changed = {
    ...base,
    info: { firmware: '1.1.0', hardware: '4' }
  };
  const first = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: base,
    measurement: { value: 'PowerActive', type: 'Overall', name: 'Wirkleistung', unit: 'W' }
  });
  const second = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: changed,
    measurement: { value: 'PowerActive', type: 'Overall', name: 'Wirkleistung', unit: 'W' }
  });
  assert.deepEqual(second.payload, first.payload);
});

test('uses a custom discovery namespace without publishing MQTT wildcards', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: { id: 26, name: 'Hauptverteilung 1A' },
    measurement: { value: 'U_Effective', type: 'L1', name: 'Spannung effektiv L1', unit: 'V' },
    discoveryPrefix: 'gridvis/discovery/#'
  });

  assert.equal(message.discoveryPrefix, 'gridvis/discovery');
  assert.equal(message.component, 'sensor');
  assert.equal(message.nodeId, '26');
  assert.equal(message.objectId, 'u_effective_l1');
  assert.equal(message.configTopic, 'gridvis/discovery/sensor/26/u_effective_l1/config');
  assert.equal(message.payload.state_topic, 'gridvis2mqtt/energiemonitoring/26/u_effective_l1/state');
});

test('keeps historical discovery entities separate from online entities', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: { id: 27 },
    measurement: {
      value: 'ActiveEnergyConsumed', type: 'Overall', name: 'Bezogene Wirkarbeit', unit: 'Wh',
      historical: true, historyRange: 'today'
    }
  });

  assert.equal(message.objectId, 'activeenergyconsumed_overall_history_today');
  assert.equal(message.configTopic, 'homeassistant/sensor/27/activeenergyconsumed_overall_history_today/config');
  assert.equal(message.stateTopic, 'gridvis2mqtt/energiemonitoring/27/activeenergyconsumed_overall_history_today/state');
  assert.equal(message.payload.name, 'Bezogene Wirkarbeit – Heute');
  assert.equal(message.payload.device_class, 'energy');
  assert.equal(message.payload.state_class, 'total');
});

test('names comparison periods as separate historical discovery entities', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: { id: 27 },
    measurement: {
      value: 'ActiveEnergyConsumed', type: 'Overall', name: 'Bezogene Wirkarbeit', unit: 'Wh',
      historical: true, historyRange: 'comparison_today'
    }
  });

  assert.equal(message.objectId, 'activeenergyconsumed_overall_history_comparison_today');
  assert.equal(message.payload.name, 'Bezogene Wirkarbeit – Vergleich: Gestern');
});

test('includes the original period in custom comparison names', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'EnergieMonitoring',
    device: { id: 27 },
    measurement: {
      value: 'ActiveEnergyConsumed', type: 'Overall', name: 'Bezogene Wirkarbeit', unit: 'Wh',
      historical: true, historyRange: 'comparison_thisyear_years_1'
    }
  });

  assert.equal(message.payload.name, 'Bezogene Wirkarbeit – Vergleich: 1 Jahr zuvor (Dieses Jahr)');
});

test('uses the configured topic templates of a discovery profile', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'Haus',
    device: { id: 12, name: 'UMG 96' },
    measurement: { value: 'ActivePower', type: 'L1', name: 'Leistung L1', unit: 'W' },
    profile: {
      id: 'custom-ha',
      discoveryPrefix: 'gridvis/discovery',
      component: 'sensor',
      topicPrefix: 'energy',
      stateTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/state',
      availabilityTopicTemplate: '{topicPrefix}/{project}/{deviceId}/{valueType}/availability',
      discoveryTopicTemplate: '{discoveryPrefix}/{component}/{deviceId}/{valueType}/config'
    }
  });

  assert.equal(message.profileId, 'custom-ha');
  assert.equal(message.configTopic, 'gridvis/discovery/sensor/12/activepower_l1/config');
  assert.equal(message.stateTopic, 'energy/haus/12/activepower_l1/state');
  assert.equal(message.availabilityTopic, 'energy/haus/12/activepower_l1/availability');
});

test('publishes an explicit display precision as Home Assistant discovery metadata', () => {
  const message = buildHomeAssistantDiscovery({
    project: 'Haus',
    device: { id: 12, name: 'UMG 96' },
    measurement: {
      value: 'ActivePower', type: 'Overall', name: 'Wirkleistung', unit: 'W',
      displaySettings: { decimals: 3 }
    }
  });

  assert.equal(message.payload.suggested_display_precision, 3);

  const current = buildHomeAssistantDiscovery({
    project: 'Haus',
    device: { id: 12, name: 'UMG 96' },
    measurement: { value: 'I_Effective', type: 'L1', name: 'Strom effektiv L1', unit: 'A' }
  });
  assert.equal(current.payload.suggested_display_precision, 1);
});

test('cleans retained discovery topics when a schema changes or is removed', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const first = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-1',
    configTopic: 'homeassistant/sensor/entity-1/config',
    availabilityTopic: 'gridvis/entity-1/availability', payload: { name: 'Alt' }
  };
  const changed = { ...first, configTopic: 'gridvis/discovery/sensor/entity-1/config', payload: { name: 'Neu' } };

  await publisher.publishDiscovery([first]);
  await publisher.publishDiscovery([changed]);
  await publisher.removeDiscovery([changed]);

  const emptyTopics = published.filter((entry) => entry.payload === '').map((entry) => entry.topic);
  assert.deepEqual(emptyTopics, [
    'homeassistant/sensor/entity-1/config',
    'gridvis/discovery/sensor/entity-1/config',
    'gridvis/entity-1/availability'
  ]);
  assert.ok(published.filter((entry) => entry.options.retain).length >= 6);
});

test('does not clear a non-retained state topic when an assignment is removed', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-stale-state',
    configTopic: 'homeassistant/sensor/entity-stale-state/config',
    availabilityTopic: 'gridvis/entity-stale-state/availability',
    stateTopic: 'gridvis/entity-stale-state/state',
    payload: { name: 'Spannung' }, stateRetain: false
  };

  await publisher.removeDiscovery([message]);

  const clearedState = published.find((entry) => entry.topic === message.stateTopic && entry.payload === '');
  assert.equal(clearedState, undefined);
});

test('reconciles retained discovery entries that are no longer in the backend selection', async () => {
  const published = [];
  const publisher = new MqttPublisher({ retainedDiscovery: [{
    key: 'broker-1|homeassistant|entity-stale',
    brokerId: 'broker-1',
    profileId: 'homeassistant',
    uniqueId: 'entity-stale',
    configTopic: 'homeassistant/sensor/entity-stale/config',
    availabilityTopic: 'gridvis/entity-stale/availability',
    stateTopic: 'gridvis/entity-stale/state',
    payload: { name: 'Alter Wert' },
    active: true
  }] });
  publisher.clients.set('broker-1', { connected: true });
  publisher.brokerStates.set('broker-1', { id: 'broker-1', connected: true, status: 'connected' });
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  await publisher.reconcileRetainedDiscovery(new Set());

  assert.deepEqual(published.filter((entry) => entry.payload === '').map((entry) => entry.topic), [
    'homeassistant/sensor/entity-stale/config',
    'gridvis/entity-stale/availability'
  ]);
  assert.equal(publisher.retainedDiscovery.size, 0);
});

test('retains an optional state value and removes it when disabled', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-2',
    configTopic: 'homeassistant/sensor/entity-2/config',
    availabilityTopic: 'gridvis/entity-2/availability',
    stateTopic: 'gridvis/entity-2/state', payload: { name: 'Wert' }, stateRetain: true
  };
  await publisher.publishDiscovery([message]);
  await publisher.publishValues([{ ...message, stateValue: 42 }]);
  await publisher.publishDiscovery([{ ...message, stateRetain: false }]);

  const clearedState = published.find((entry) => entry.topic === message.stateTopic && entry.payload === '');
  assert.equal(clearedState.options.retain, true);
  const valueMessage = published.find((entry) => entry.topic === message.stateTopic && typeof entry.payload === 'object');
  assert.equal(valueMessage.options.retain, true);
});

test('retains only discovery by default', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-default-retain',
    configTopic: 'homeassistant/sensor/entity-default-retain/config',
    availabilityTopic: 'gridvis/entity-default-retain/availability',
    stateTopic: 'gridvis/entity-default-retain/state', payload: { name: 'Wert' }, stateRetain: false
  };

  await publisher.publishDiscovery([message]);
  await publisher.publishValues([{ ...message, stateValue: 42 }]);

  const discovery = published.find((entry) => entry.topic === message.configTopic);
  const availability = published.find((entry) => entry.topic === message.availabilityTopic && entry.payload === 'online');
  const state = published.find((entry) => entry.topic === message.stateTopic);
  assert.equal(discovery.options.retain, true);
  assert.equal(availability.options.retain, true);
  assert.equal(state.options.retain, false);
});

test('does not republish unchanged discovery messages unless forced', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-deduplicated',
    configTopic: 'homeassistant/sensor/entity-deduplicated/config',
    availabilityTopic: 'gridvis/entity-deduplicated/availability',
    stateTopic: 'gridvis/entity-deduplicated/state', payload: { name: 'Wert' }, stateRetain: false
  };

  await publisher.publishDiscovery([message]);
  await publisher.publishDiscovery([message]);
  assert.equal(published.length, 2);

  await publisher.publishDiscovery([message], { force: true });
  assert.equal(published.length, 4);
});

test('does not publish a stale value after its discovery was removed', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-stale-value',
    configTopic: 'homeassistant/sensor/entity-stale-value/config',
    availabilityTopic: 'gridvis/entity-stale-value/availability',
    stateTopic: 'gridvis/entity-stale-value/state', payload: { name: 'Heute' }, stateRetain: false
  };

  await publisher.publishDiscovery([message]);
  await publisher.removeDiscovery([message]);
  const count = await publisher.publishValues([{ ...message, stateValue: 7000 }]);

  assert.equal(count, 0);
  assert.equal(published.some((entry) => entry.topic === message.stateTopic && entry.payload?.value === 7000), false);
});

test('keeps discovery retained and blocks values while MQTT is inactive', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.clients.set('broker-1', { connected: true });
  publisher.client = publisher.clients.get('broker-1');
  publisher.publish = async (topic, payload, options, brokerId) => {
    published.push({ topic, payload, options, brokerId });
  };

  const message = {
    brokerId: 'broker-1', profileId: 'homeassistant', uniqueId: 'entity-inactive',
    configTopic: 'homeassistant/sensor/entity-inactive/config',
    availabilityTopic: 'gridvis/entity-inactive/availability',
    stateTopic: 'gridvis/entity-inactive/state', payload: { name: 'Wert' }, stateRetain: false
  };

  await publisher.publishDiscovery([message]);
  await publisher.publishDiscovery([{ ...message, availabilityValue: 'offline' }]);
  const blocked = await publisher.publishValues([{ ...message, stateValue: 7000 }]);

  assert.equal(blocked, 0);
  assert.equal(publisher.retainedDiscovery.size, 1);
  assert.equal(publisher.retainedDiscovery.values().next().value.active, true);
  assert.equal(published.some((entry) => entry.payload === ''), false);
  assert.ok(published.some((entry) => entry.topic === message.availabilityTopic && entry.payload === 'offline'));

  await publisher.publishDiscovery([message]);
  const resumed = await publisher.publishValues([{ ...message, stateValue: 7100 }]);
  assert.equal(resumed, 1);
  assert.ok(published.some((entry) => entry.topic === message.stateTopic && entry.payload?.value === 7100));
});
