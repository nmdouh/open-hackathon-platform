'use strict';

// Errors carry a stable machine-readable code. The web UI translates codes,
// so messages here are for logs and API consumers only.
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new HttpError(400, code, message, details);
const unauthorized = (code = 'NOT_SIGNED_IN', message = 'Sign in required') => new HttpError(401, code, message);
const forbidden = (code = 'FORBIDDEN', message = 'Not allowed') => new HttpError(403, code, message);
const notFound = (code = 'NOT_FOUND', message = 'Not found') => new HttpError(404, code, message);
const conflict = (code, message) => new HttpError(409, code, message);

// Maps a PostgreSQL unique-violation on a named index to a domain error, so a
// rule enforced by the database surfaces with the same code as the app check.
const UNIQUE_INDEX_CODES = {
  users_email_uq: 'EMAIL_TAKEN',
  hackathons_slug_key: 'SLUG_TAKEN',
  registrations_active_uq: 'ALREADY_REGISTERED',
  ideas_owner_live_uq: 'IDEA_EXISTS',
  teams_idea_uq: 'TEAM_EXISTS_FOR_IDEA',
  teams_owner_uq: 'OWNER_HAS_TEAM',
  team_members_one_team_uq: 'ALREADY_IN_TEAM',
  team_members_pkey: 'ALREADY_IN_TEAM',
  applications_pending_uq: 'DUPLICATE_APPLICATION',
};

function fromPg(err) {
  if (err && err.code === '23505' && UNIQUE_INDEX_CODES[err.constraint]) {
    return conflict(UNIQUE_INDEX_CODES[err.constraint]);
  }
  if (err && err.code === '22P02') return badRequest('INVALID_ID', 'Malformed identifier');
  if (err && err.code === '23514') return badRequest('CONSTRAINT_FAILED', err.constraint);
  return err;
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, fromPg };
