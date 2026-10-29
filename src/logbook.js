const MAX_ENTRIES = 5000;
const COMPACTION_THRESHOLD = 1024;
const SENSITIVE_KEYS = new Set(['password', 'username', 'authorization', 'token', 'secret']);

let nextId = 1;
const entries = [];
let firstEntryIndex = 0;

function safeValue(value, key = '') {
  if (SENSITIVE_KEYS.has(String(key).toLowerCase())) return '[redacted]';
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([entryKey, entryValue]) => [entryKey, safeValue(entryValue, entryKey)]));
}

function normalizeDetails(details = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return { value: safeValue(details) };
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, safeValue(value, key)]));
}

function add(level, event, details = {}) {
  const entry = {
    id: nextId++,
    time: new Date().toISOString(),
    level,
    event: String(event || 'event'),
    details: normalizeDetails(details)
  };
  entries.push(entry);
  if (entries.length - firstEntryIndex > MAX_ENTRIES) firstEntryIndex += 1;
  // Do not shift the complete 5,000-entry array for every new log entry. Keep
  // the discarded prefix as a lazy offset and compact it in batches.
  if (firstEntryIndex >= COMPACTION_THRESHOLD) {
    entries.splice(0, firstEntryIndex);
    firstEntryIndex = 0;
  }
  return entry;
}

export const logbook = {
  info(event, details) { return add('info', event, details); },
  success(event, details) { return add('success', event, details); },
  warning(event, details) { return add('warning', event, details); },
  error(event, details) { return add('error', event, details); },
  list({ limit = 500, level = '', query = '' } = {}) {
    const normalizedLimit = Math.min(MAX_ENTRIES, Math.max(1, Number(limit) || 500));
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const retainedEntries = firstEntryIndex ? entries.slice(firstEntryIndex) : entries;
    return retainedEntries
      .filter((entry) => !level || entry.level === level)
      .filter((entry) => !normalizedQuery || JSON.stringify(entry).toLowerCase().includes(normalizedQuery))
      .slice(-normalizedLimit)
      .reverse();
  },
  clear() {
    entries.length = 0;
    firstEntryIndex = 0;
  },
  size() {
    return entries.length - firstEntryIndex;
  }
};

export const LOGBOOK_MAX_ENTRIES = MAX_ENTRIES;
