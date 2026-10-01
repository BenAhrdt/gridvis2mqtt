import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import * as display from '../public/measurement-display.js';
import { buildHomeAssistantDiscovery } from '../src/discovery/home-assistant.js';
import { MqttPublisher } from '../src/mqtt-publisher.js';

const energy = { value: 'ActiveEnergyConsumed', type: 'SUM', typeLabel: 'Summe L1..L3', name: 'Bezogene Wirkarbeit', unit: 'Wh' };

test('formats work at native Wh thresholds with German fixed precision', () => {
  for (const [raw, value, unit] of [
    [0, '0', 'Wh'], [800, '800', 'Wh'], [999, '999', 'Wh'],
    [1000, '1,0', 'kWh'], [900800, '900,8', 'kWh'], [999999, '1000,0', 'kWh'],
    [1000000, '1,000', 'MWh'], [1234000, '1,234', 'MWh'], [64114500, '64,115', 'MWh'],
    [-1234000, '-1,234', 'MWh'], ['900800', '900,8', 'kWh']
  ]) assert.deepEqual(display.formatMeasurementValue(raw, energy), { value, unit });
  assert.deepEqual(display.formatMeasurementValue(900.8, { ...energy, unit: 'kWh' }), { value: '900,8', unit: 'kWh' });
  assert.deepEqual(display.formatMeasurementValue(0.0008, { ...energy, unit: 'MWh' }), { value: '800', unit: 'Wh' });
});

test('uses one decimal by default for electrical and future measurement values', () => {
  for (const unit of ['W', 'VA', 'var', 'V']) {
    assert.deepEqual(display.formatMeasurementValue(-1652.530517578125, { unit }), { value: '-1652,5', unit });
    assert.deepEqual(display.formatMeasurementValue(0, { unit }), { value: '0,0', unit });
    assert.deepEqual(display.formatMeasurementValue(-0.001, { unit }), { value: '0,0', unit });
  }
  assert.deepEqual(display.formatMeasurementValue(2.345, { value: 'TotalHarmonicDisturbation_U', name: 'THD Spannung', unit: '%' }), { value: '2,3', unit: '%' });
  assert.deepEqual(display.formatMeasurementValue(2.523995, { value: 'I_Effective', unit: 'A' }), { value: '2,5', unit: 'A' });
});

test('allows separate precision and unit overrides without changing the input', () => {
  const raw = 64114500.125;
  const measurement = Object.freeze({ ...energy });
  assert.deepEqual(display.formatMeasurementValue(raw, measurement, { unit: 'kWh', decimals: 2 }), { value: '64114,50', unit: 'kWh' });
  assert.deepEqual(display.formatMeasurementValue(raw, measurement, { unit: 'api', decimals: 3 }), { value: '64114500,125', unit: 'Wh' });
  assert.deepEqual(display.formatMeasurementValue(raw, measurement, { decimals: 1 }), { value: '64,1', unit: 'MWh' });
  assert.deepEqual(display.formatMeasurementValue(raw, measurement, { unit: 'MWh' }), { value: '64,115', unit: 'MWh' });
  assert.deepEqual(display.formatMeasurementValue(0.01234, { unit: 'A' }, { unit: 'mA', decimals: 2 }), { value: '12,34', unit: 'mA' });
  assert.deepEqual(display.formatMeasurementValue(230123, { unit: 'mV' }, { unit: 'V', decimals: 2 }), { value: '230,12', unit: 'V' });
  assert.deepEqual(display.formatMeasurementValue(raw, measurement, {}), { value: '64,115', unit: 'MWh' });
  assert.equal(raw, 64114500.125);
  assert.equal(measurement.unit, 'Wh');
});

test('handles unavailable values and ignores invalid display settings', () => {
  for (const raw of [undefined, null, '', ' ', NaN, Infinity, 'NaN', 'Infinity', {}, false]) {
    assert.deepEqual(display.formatMeasurementValue(raw, energy), { value: '—', unit: 'Wh' });
  }
  assert.deepEqual(display.normalizeDisplaySettings({ unit: 'kW', decimals: -1 }, energy), {});
  assert.deepEqual(display.normalizeDisplaySettings({ unit: 'Wh', decimals: 100 }, energy), { unit: 'Wh' });
  assert.deepEqual(display.measurementDisplayUnits({ unit: '°C' }), []);
});

test('discovers active energy counters with native Wh and unambiguous names', () => {
  for (const [value, name] of [
    ['ActiveEnergy', 'Wirkarbeit'], ['ActiveEnergyConsumed', 'Bezogene Wirkarbeit'], ['ActiveEnergyDelivered', 'Gelieferte Wirkarbeit']
  ]) {
    const message = buildHomeAssistantDiscovery({ project: 'Haus', device: { id: 26 }, measurement: { ...energy, value, displaySettings: { unit: 'MWh', decimals: 3 } } });
    assert.equal(message.payload.name, `${name} Summe L1..L3`);
    assert.equal(message.payload.device_class, 'energy');
    assert.equal(message.payload.state_class, 'total_increasing');
    assert.equal(message.payload.unit_of_measurement, 'Wh');
    assert.equal(message.payload.value_template, '{{ value_json.value }}');
  }
  const net = buildHomeAssistantDiscovery({ device: { id: 26 }, measurement: { value: 'ActiveEnergyNet', name: 'Nettoenergie', unit: 'Wh' } });
  assert.equal(net.payload.state_class, 'total');
});

test('uses HA-compatible classes and native units for electrical measurements', () => {
  for (const [value, unit, deviceClass, stateClass] of [
    ['PowerActive', 'W', 'power', 'measurement'],
    ['U_Effective', 'V', 'voltage', 'measurement'],
    ['I_Effective', 'A', 'current', 'measurement'],
    ['Frequency', 'Hz', 'frequency', 'measurement'],
    ['PowerApparent', 'VA', 'apparent_power', 'measurement'],
    ['PowerReactive', 'var', 'reactive_power', 'measurement'],
    ['ReactiveEnergyConsumed', 'varh', 'reactive_energy', 'total_increasing'],
    ['PowerFactor', '', 'power_factor', 'measurement'],
    ['Temperature', '°C', 'temperature', 'measurement'],
    ['TotalHarmonicDisturbation_U', '%', undefined, 'measurement'],
    ['U_CrestFactor', '', undefined, 'measurement']
  ]) {
    const message = buildHomeAssistantDiscovery({ device: { id: 26 }, measurement: { value, name: value, type: 'L1', unit } });
    assert.equal(message.payload.device_class, deviceClass, value);
    assert.equal(message.payload.state_class, stateClass, value);
    assert.equal(message.payload.unit_of_measurement, unit || undefined, value);
    assert.ok(message.payload.name.endsWith(' L1'));
  }
});

test('MQTT publishes full precision and original scale after UI formatting', async () => {
  const published = [];
  const publisher = new MqttPublisher();
  publisher.publish = async (topic, payload) => published.push({ topic, payload });
  for (const [measurement, raw, settings] of [
    [energy, 64114500.125, { unit: 'MWh', decimals: 3 }],
    [{ value: 'PowerActive', type: 'SUM', unit: 'W' }, -1652.530517578125, { decimals: 0 }]
  ]) {
    display.formatMeasurementValue(raw, measurement, settings);
    const message = buildHomeAssistantDiscovery({ device: { id: 26 }, measurement });
    await publisher.publishDiscovery([message]);
    await publisher.publishValues([{ ...message, stateValue: raw }]);
    assert.equal(published.at(-1).payload.value, raw);
    assert.equal(message.payload.unit_of_measurement, measurement.unit);
  }
});

test('live and quick-info displays resolve preferences per device; cache and MQTT keep raw values', async () => {
  const elements = { '#project-select': { value: 'Haus' }, '#device-select': { value: '26' } };
  let persisted;
  const context = createContext({
    ...display, Intl, console,
    setTimeout, clearTimeout,
    fetch: async (_path, options) => {
      persisted = JSON.parse(options.body);
      return { ok: true };
    },
    window: { localStorage: { getItem: () => null, removeItem: () => {} } },
    document: { querySelector: (selector) => elements[selector] || null }
  });
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInContext(app.replace(/^import .*;\n/, '').replace(/attachEvents\(\);\s*loadInitial\(\)\.catch\(showError\);\s*$/, ''), context);
  runInContext(`
    state.currentDevice = { id: '26' };
    state.backendDeviceStateKey = 'Haus::26';
    state.displaySettings = { 'ActiveEnergyConsumed:SUM': { unit: 'kWh', decimals: 2 } };
    state.measurementCache = {
      'Haus::26': {},
      'Haus::27': { displaySettings: { 'ActiveEnergyConsumed:SUM': { unit: 'MWh', decimals: 3 } } }
    };
    state.liveResults = [{ deviceId: '26', valueType: { value: 'ActiveEnergyConsumed', type: 'SUM' }, value: 64114500.125 }];
  `, context);
  context.measurement = energy;
  const current = runInContext("liveValueMarkup(measurement, state.liveResults[0], '26')", context);
  const other = runInContext("liveValueMarkup(measurement, {value: 64114500.125}, '27')", context);
  assert.equal(current, '64114,50 <em>kWh</em>');
  assert.equal(other, '64,115 <em>MWh</em>');
  assert.equal(runInContext("liveValueMarkup({...measurement, lastValue: 0}, {}, '26')", context), '0,00 <em>kWh</em>');
  runInContext('enableServerStatePersistence()', context);
  runInContext('writeUiCache()', context);
  await runInContext('flushUiState()', context);
  assert.deepEqual(persisted.currentDeviceState.cache.displaySettings, { 'ActiveEnergyConsumed:SUM': { unit: 'kWh', decimals: 2 } });
  assert.equal(persisted.currentDeviceState.cache.liveResults[0].value, 64114500.125);
  assert.equal(persisted.deviceCache, undefined);
  assert.equal(persisted.measurementCache, undefined);
});

test('does not classify an online measurement as historical when the key also exists historically', async () => {
  const context = createContext({
    ...display, Intl, console,
    setTimeout, clearTimeout,
    window: { localStorage: { getItem: () => null, removeItem: () => {} } },
    document: { querySelector: () => null }
  });
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInContext(app.replace(/^import .*;\n/, '').replace(/attachEvents\(\);\s*loadInitial\(\)\.catch\(showError\);\s*$/, ''), context);
  assert.equal(runInContext("isHistoricalMeasurement({ value: 'ActiveEnergyConsumed', type: 'SUM13', online: true, historical: false })", context), false);
  assert.equal(runInContext("isHistoricalMeasurement({ value: 'ActiveEnergyConsumed', type: 'SUM13', online: false, historical: true, timebases: [900] })", context), true);
});

test('restores device defaults for legacy untouched MQTT history settings', async () => {
  const context = createContext({
    ...display, Intl, console,
    setTimeout, clearTimeout,
    window: { localStorage: { getItem: () => null, removeItem: () => {} } },
    document: { querySelector: () => null }
  });
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInContext(app.replace(/^import .*;\n/, '').replace(/attachEvents\(\);\s*loadInitial\(\)\.catch\(showError\);\s*$/, ''), context);

  assert.deepEqual(JSON.parse(JSON.stringify(runInContext(`historicalSettingsOverride(
    { interval: 900, ranges: ['today'], comparisons: [] },
    { refreshInterval: 900, ranges: ['today'], comparisons: [] }
  )`, context))), { interval: 900, ranges: ['today'], comparisons: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(runInContext(`historicalSettingsOverride(
    { interval: 900, ranges: ['today'], comparisons: [] },
    { refreshInterval: 900, ranges: ['today', 'yesterday'], comparisons: [] }
  )`, context))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(runInContext(`historicalSettingsOverride(
    { mode: 'custom', interval: 900, ranges: ['today'], comparisons: [] },
    { refreshInterval: 900, ranges: ['today', 'yesterday'], comparisons: [] }
  )`, context))), { mode: 'custom', interval: 900, ranges: ['today'], comparisons: [] });
});

test('keeps the energy value when GridVis wraps it with valueType metadata', async () => {
  const context = createContext({
    ...display, Intl, console,
    setTimeout, clearTimeout,
    window: { localStorage: { getItem: () => null, removeItem: () => {} } },
    document: { querySelector: () => null }
  });
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  runInContext(app.replace(/^import .*;\n/, '').replace(/attachEvents\(\);\s*loadInitial\(\)\.catch\(showError\);\s*$/, ''), context);
  const rows = runInContext("historicalDataRows({ valueType: { value: 'ActiveEnergyConsumed', type: 'SUM13' }, startTime: 1, endTime: 2, unit: 'Wh', energy: 1234 })", context);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].energy, 1234);
  context.energyRow = rows[0];
  assert.equal(runInContext("historicalResultValue(energyRow, { value: 'ActiveEnergyConsumed' })", context), 1234);
  assert.equal(runInContext("historicalDataRows([{ valueType: { value: 'ActiveEnergyConsumed' }, avg: 64114552 }], { energy: true })", context).length, 0);
});
