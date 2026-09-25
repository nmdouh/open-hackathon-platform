'use strict';

const { notFound, conflict } = require('../../lib/errors');
const { isAdmin } = require('../../auth/sessions');

// Loads a hackathon by id or slug. Drafts are invisible to non-admins.
async function loadHackathon(db, ref, user, { lock = false } = {}) {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const { rows } = await db.query(
    `SELECT * FROM hackathons WHERE ${byId ? 'id = $1' : 'slug = $1'}${lock ? ' FOR UPDATE' : ''}`,
    [ref],
  );
  const h = rows[0];
  if (!h || (h.status === 'draft' && !isAdmin(user))) throw notFound('HACKATHON_NOT_FOUND');
  return h;
}

function registrationOpen(h, now = new Date()) {
  if (h.status !== 'open' && h.status !== 'running') return false;
  if (h.registration_opens_at && now < h.registration_opens_at) return false;
  if (h.registration_closes_at && now > h.registration_closes_at) return false;
  return true;
}

function ideaSubmissionOpen(h, now = new Date()) {
  if (h.status !== 'open' && h.status !== 'running') return false;
  if (h.idea_submission_closes_at && now > h.idea_submission_closes_at) return false;
  return true;
}

// Team formation continues while the event runs, until it is closed.
function teamingOpen(h) {
  return h.status === 'open' || h.status === 'running';
}

function assertRegistrationOpen(h) {
  if (!registrationOpen(h)) throw conflict('REGISTRATION_CLOSED', 'Registration is closed');
}
function assertIdeaSubmissionOpen(h) {
  if (!ideaSubmissionOpen(h)) throw conflict('IDEA_SUBMISSION_CLOSED', 'Idea submission is closed');
}
function assertTeamingOpen(h) {
  if (!teamingOpen(h)) throw conflict('TEAMING_CLOSED', 'Team changes are closed');
}

module.exports = {
  loadHackathon, registrationOpen, ideaSubmissionOpen, teamingOpen,
  assertRegistrationOpen, assertIdeaSubmissionOpen, assertTeamingOpen,
};
