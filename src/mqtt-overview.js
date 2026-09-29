function measurementKey(measurement = {}) {
  if (measurement?.value === undefined || measurement?.type === undefined) return '';
  return `${measurement.value}:${measurement.type}`;
}

function cacheKey(project, deviceId) {
  return `${project}::${deviceId}`;
}

/**
 * Apply a bulk MQTT overview action to a cloned backend state.
 * Discovery assignments and active assignments are deliberately separate:
 * disabling keeps Discovery, while removing deletes the complete selection.
 */
export function applyMqttOverviewRows(nextState, { project = '', action = '', rows = [] } = {}) {
  const normalizedProject = String(project || '').trim();
  const normalizedAction = ['remove', 'disable', 'toggle', 'enable'].includes(action) ? action : '';
  if (!normalizedProject || !normalizedAction || !Array.isArray(rows)) {
    return { requested: 0, changed: 0, ignored: 0, touchedDevices: [] };
  }

  const touchedDevices = new Set();
  let changed = 0;
  let requested = 0;

  for (const row of rows) {
    const deviceId = String(row?.deviceId || '').trim();
    const valueKey = String(row?.measurementKey || '').trim();
    const mode = row?.mode === 'historical' ? 'historical' : row?.mode === 'live' ? 'live' : '';
    if (!deviceId || !valueKey || !mode) continue;
    requested += 1;

    const stateCacheKey = cacheKey(normalizedProject, deviceId);
    const cache = nextState.measurementCache?.[stateCacheKey];
    if (!cache || typeof cache !== 'object') continue;
    const valueField = mode === 'historical' ? 'historicalValues' : 'onlineValues';
    const assignmentField = mode === 'historical' ? 'historicalMqttAssignments' : 'mqttAssignments';
    const activeField = mode === 'historical' ? 'historicalMqttActiveAssignments' : 'mqttActiveAssignments';
    const selectedField = mode === 'historical' ? 'historicalSelectedMeasurements' : 'selectedMeasurements';
    const retainField = mode === 'historical' ? 'historicalRetainAssignments' : 'mqttRetainAssignments';
    const measurement = (Array.isArray(cache[valueField]) ? cache[valueField] : [])
      .find((candidate) => measurementKey(candidate) === valueKey);
    if (!measurement) continue;

    const assignments = cache[assignmentField] && typeof cache[assignmentField] === 'object'
      ? cache[assignmentField]
      : {};
    const activeAssignments = cache[activeField] && typeof cache[activeField] === 'object'
      ? cache[activeField]
      : {};
    const selected = Array.isArray(cache[selectedField]) ? cache[selectedField] : [];
    const activeProfileIds = Array.isArray(activeAssignments[valueKey]) ? activeAssignments[valueKey] : [];
    const hasActiveAssignment = activeProfileIds.length > 0;
    const hasDiscoveryAssignment = Array.isArray(assignments[valueKey]) && assignments[valueKey].length > 0;
    const shouldEnable = normalizedAction === 'enable'
      || (normalizedAction === 'toggle' && !hasActiveAssignment);

    if (normalizedAction === 'disable' || (normalizedAction === 'toggle' && hasActiveAssignment)) {
      if (!hasActiveAssignment) continue;
      if (!hasDiscoveryAssignment) assignments[valueKey] = [...activeProfileIds];
      delete activeAssignments[valueKey];
    } else if (shouldEnable) {
      const profileIds = hasDiscoveryAssignment ? assignments[valueKey] : activeProfileIds;
      if (!profileIds.length) continue;
      const uniqueProfileIds = [...new Set(profileIds)];
      assignments[valueKey] = uniqueProfileIds;
      activeAssignments[valueKey] = uniqueProfileIds;
      if (!selected.some((entry) => measurementKey(entry) === valueKey)) {
        cache[selectedField] = [...selected, measurement];
      }
      if (mode === 'live') {
        const displayed = Array.isArray(cache.displayedMeasurements) ? cache.displayedMeasurements : [];
        if (!displayed.some((entry) => measurementKey(entry) === valueKey)) {
          cache.displayedMeasurements = [...displayed, measurement];
        }
      }
    } else if (normalizedAction === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(assignments, valueKey)
        && !Object.prototype.hasOwnProperty.call(activeAssignments, valueKey)) continue;
      delete assignments[valueKey];
      delete activeAssignments[valueKey];
      if (cache[retainField] && typeof cache[retainField] === 'object') delete cache[retainField][valueKey];
      cache[selectedField] = selected.filter((entry) => measurementKey(entry) !== valueKey);
      if (mode === 'historical') {
        cache.historicalSettings = { ...(cache.historicalSettings || {}) };
        delete cache.historicalSettings[valueKey];
        const resultPrefix = `${deviceId}:${valueKey}`;
        cache.historicalResults = Object.fromEntries(Object.entries(cache.historicalResults || {})
          .filter(([resultKey]) => resultKey !== resultPrefix && !resultKey.startsWith(`${resultPrefix}:`)));
      } else {
        cache.displayedMeasurements = (Array.isArray(cache.displayedMeasurements) ? cache.displayedMeasurements : [])
          .filter((entry) => measurementKey(entry) !== valueKey);
        cache.liveResults = (Array.isArray(cache.liveResults) ? cache.liveResults : [])
          .filter((entry) => measurementKey(entry?.valueType || entry) !== valueKey);
      }
    }

    cache[assignmentField] = assignments;
    cache[activeField] = activeAssignments;
    if (normalizedAction === 'disable') cache[selectedField] = selected;
    touchedDevices.add(`${normalizedProject}::${deviceId}`);
    changed += 1;
  }

  return {
    requested,
    changed,
    ignored: Math.max(0, requested - changed),
    touchedDevices: [...touchedDevices]
  };
}
