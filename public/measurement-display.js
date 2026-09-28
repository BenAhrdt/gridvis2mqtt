// Display conversions never alter the API reading or its MQTT unit.
const PREFIX_FACTORS = { 'µ': 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
const DISPLAY_PREFIXES = ['µ', 'm', '', 'k', 'M'];
const ENERGY_NAMES = {
  ActiveEnergy: 'Wirkarbeit',
  ActiveEnergyConsumed: 'Bezogene Wirkarbeit',
  ActiveEnergyDelivered: 'Gelieferte Wirkarbeit'
};

export function measurementDisplayName(measurement) {
  const name = ENERGY_NAMES[measurement.value] || measurement.name || measurement.value || 'Messwert';
  const channel = measurement.typeLabel || measurement.type;
  return !channel || channel === 'Overall' || name.endsWith(` ${channel}`) ? name : `${name} ${channel}`;
}

export function measurementUnitInfo(measurement) {
  const unit = String(measurement?.unit || '').trim().replace('μ', 'µ').replace('VAr', 'var');
  const match = unit.match(/^([µmkMGT]?)(Wh|varh|VAh|W|VA|var|V|A|Hz|J)$/);
  return match
    ? { unit, baseUnit: match[2], factor: PREFIX_FACTORS[match[1]], scalable: true }
    : { unit, baseUnit: unit, factor: 1, scalable: false };
}

export function measurementDisplayUnits(measurement) {
  const info = measurementUnitInfo(measurement);
  return info.scalable ? [...new Set([...DISPLAY_PREFIXES.map((prefix) => prefix + info.baseUnit), info.unit])] : [];
}

export function normalizeDisplaySettings(settings = {}, measurement) {
  if (!settings || typeof settings !== 'object') return {};
  const normalized = {};
  if (settings.unit === 'api' || measurementDisplayUnits(measurement).includes(settings.unit)) normalized.unit = settings.unit;
  if (Number.isInteger(settings.decimals) && settings.decimals >= 0 && settings.decimals <= 6) normalized.decimals = settings.decimals;
  return normalized;
}

function isWork(info) {
  return ['Wh', 'varh', 'VAh'].includes(info.baseUnit);
}

export function displayPrecisionLabel(measurement) {
  const info = measurementUnitInfo(measurement);
  if (isWork(info)) return 'Standard (Basis: 0 · kilo: 1 · Mega: 3)';
  return 'Standard (1 Nachkommastelle)';
}

export function formatMeasurementValue(value, measurement, preferences = {}) {
  const source = measurementUnitInfo(measurement);
  const settings = normalizeDisplaySettings(preferences, measurement);
  let unit = settings.unit && settings.unit !== 'api' ? settings.unit : source.unit;
  // Missing/non-finite values must not be displayed as zero or as a reading.
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) {
    return { value: '—', unit };
  }
  const numeric = Number(value);
  if (!settings.unit && isWork(source)) {
    const magnitude = Math.abs(numeric * source.factor);
    unit = (magnitude < 1e3 ? '' : magnitude < 1e6 ? 'k' : 'M') + source.baseUnit;
  }
  const target = measurementUnitInfo({ unit });
  const scaled = numeric / (target.factor / source.factor);
  if (!Number.isFinite(scaled)) return { value: '—', unit };
  let decimals = settings.decimals;
  if (decimals === undefined) {
    if (isWork(source)) decimals = target.factor >= 1e6 ? 3 : target.factor >= 1e3 ? 1 : 0;
    else decimals = 1;
  }
  return {
    value: new Intl.NumberFormat('de-DE', {
      useGrouping: false,
      minimumFractionDigits: decimals ?? 0,
      maximumFractionDigits: decimals ?? 20
    }).format(scaled).replace(/^-(0(?:,0+)?)$/, '$1'),
    unit
  };
}
