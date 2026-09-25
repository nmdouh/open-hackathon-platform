'use strict';

// Database rows are snake_case; the API speaks camelCase.
const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function toApi(row) {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map(toApi);
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out;
}

module.exports = { toApi, camelKey };
