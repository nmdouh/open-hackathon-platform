// Thin wrapper over fetch for the JSON API. Cookies carry the session, so
// no token is ever stored in JavaScript or localStorage.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message, e.details);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

export const enc = encodeURIComponent;
