/**
 * Extract a list from the response shapes used by the GridVis REST API.
 *
 * Some installations return the list directly, while others wrap it in a
 * `devices`, `projects`, `data`, or similar property. Keep this normalization
 * on the backend as well so server-owned caches contain the same entries the
 * browser displays.
 */
export function listDataFromResponse(data) {
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
