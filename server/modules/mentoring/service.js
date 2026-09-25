'use strict';

const { tx } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { notify, teamMemberIds } = require('../../lib/notify');

async function slugOf(db, hackathonId) {
  const { rows } = await db.query('SELECT slug FROM hackathons WHERE id = $1', [hackathonId]);
  return rows[0].slug;
}
const { badRequest, forbidden, notFound, conflict, fromPg } = require('../../lib/errors');
const { isAdmin } = require('../../auth/sessions');
const { loadHackathon } = require('../hackathons/service');
const { lockParticipant } = require('../participation/service');

const run = (pool, fn) => tx(pool, fn).catch((e) => { throw fromPg(e); });
const MAX_OPEN_REQUESTS_PER_TEAM = 3;

async function isMentor(db, hackathonId, userId) {
  const { rows } = await db.query('SELECT 1 FROM mentors WHERE hackathon_id = $1 AND user_id = $2', [hackathonId, userId]);
  return rows.length > 0;
}

async function teamOfMember(db, teamId, userId) {
  const { rows } = await db.query(
    `SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id
      WHERE t.id = $1 AND t.status = 'active' AND m.user_id = $2`,
    [teamId, userId],
  );
  return rows[0] || null;
}

// ------------------------------------------------------------------ mentor roster (admins)

async function addMentor(pool, user, hackathonRef, { userId, email, expertise = [], bio = '', maxTeams = 5 }) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    const { rows: found } = await db.query(
      'SELECT id FROM users WHERE is_active AND (id = $1 OR lower(email) = lower($2))',
      [userId || null, email || ''],
    );
    if (!found[0]) throw notFound('USER_NOT_FOUND');
    const mentorId = found[0].id;
    await lockParticipant(db, h.id, mentorId);
    const { rows: reg } = await db.query(
      "SELECT 1 FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active'",
      [h.id, mentorId],
    );
    if (reg.length) throw conflict('MENTOR_IS_PARTICIPANT', 'Participants cannot mentor in their own hackathon');
    const { rows } = await db.query(
      `INSERT INTO mentors (hackathon_id, user_id, expertise, bio, max_teams) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hackathon_id, user_id) DO UPDATE SET expertise = EXCLUDED.expertise, bio = EXCLUDED.bio, max_teams = EXCLUDED.max_teams
       RETURNING *`,
      [h.id, mentorId, expertise, bio, maxTeams],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'mentor.added', entityType: 'user', entityId: mentorId });
    return rows[0];
  });
}

async function removeMentor(pool, user, hackathonRef, mentorId) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    const { rowCount } = await db.query('DELETE FROM mentors WHERE hackathon_id = $1 AND user_id = $2', [h.id, mentorId]);
    if (!rowCount) throw notFound('MENTOR_NOT_FOUND');
    await db.query('DELETE FROM mentor_assignments WHERE hackathon_id = $1 AND mentor_id = $2', [h.id, mentorId]);
    await db.query(
      "UPDATE mentoring_requests SET mentor_id = NULL, status = 'open', updated_at = now() WHERE hackathon_id = $1 AND mentor_id = $2 AND status = 'accepted'",
      [h.id, mentorId],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'mentor.removed', entityType: 'user', entityId: mentorId });
  });
}

async function listMentors(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const admin = isAdmin(user);
  const { rows } = await pool.query(
    `SELECT m.user_id, m.expertise, m.bio, m.max_teams, u.display_name, ${admin ? 'u.email,' : ''}
            (SELECT count(*)::int FROM mentor_assignments a WHERE a.hackathon_id = m.hackathon_id AND a.mentor_id = m.user_id) AS team_count
       FROM mentors m JOIN users u ON u.id = m.user_id
      WHERE m.hackathon_id = $1 ORDER BY u.display_name`,
    [h.id],
  );
  return rows;
}

async function assignLocked(db, actor, hackathonId, teamId, mentorId) {
  const { rows: m } = await db.query(
    'SELECT * FROM mentors WHERE hackathon_id = $1 AND user_id = $2 FOR UPDATE', [hackathonId, mentorId],
  );
  if (!m[0]) throw notFound('MENTOR_NOT_FOUND');
  const { rows: existing } = await db.query('SELECT 1 FROM mentor_assignments WHERE team_id = $1 AND mentor_id = $2', [teamId, mentorId]);
  if (existing.length) return false;
  const { rows: count } = await db.query(
    'SELECT count(*)::int AS n FROM mentor_assignments WHERE hackathon_id = $1 AND mentor_id = $2', [hackathonId, mentorId],
  );
  if (count[0].n >= m[0].max_teams) throw conflict('MENTOR_AT_CAPACITY');
  await db.query(
    'INSERT INTO mentor_assignments (team_id, mentor_id, hackathon_id, assigned_by) VALUES ($1, $2, $3, $4)',
    [teamId, mentorId, hackathonId, actor.id],
  );
  await audit(db, { actorId: actor.id, hackathonId, action: 'mentor.assigned', entityType: 'team', entityId: teamId, details: { mentorId } });
  if (actor.id !== mentorId) {
    const { rows: t } = await db.query('SELECT name FROM teams WHERE id = $1', [teamId]);
    await notify(db, mentorId, {
      hackathonId, kind: 'mentor.assigned', link: `h/${await slugOf(db, hackathonId)}/teams/${teamId}`,
      data: { teamName: t[0].name },
    });
  }
  return true;
}

async function assignMentor(pool, user, teamId, mentorId) {
  return run(pool, async (db) => {
    const { rows } = await db.query("SELECT * FROM teams WHERE id = $1 AND status = 'active'", [teamId]);
    if (!rows[0]) throw notFound('TEAM_NOT_FOUND');
    await assignLocked(db, user, rows[0].hackathon_id, teamId, mentorId);
  });
}

async function unassignMentor(pool, user, teamId, mentorId) {
  return run(pool, async (db) => {
    const { rows } = await db.query('DELETE FROM mentor_assignments WHERE team_id = $1 AND mentor_id = $2 RETURNING hackathon_id', [teamId, mentorId]);
    if (!rows[0]) throw notFound('ASSIGNMENT_NOT_FOUND');
    await audit(db, { actorId: user.id, hackathonId: rows[0].hackathon_id, action: 'mentor.unassigned', entityType: 'team', entityId: teamId, details: { mentorId } });
  });
}

// ------------------------------------------------------------------ requests

async function createRequest(pool, user, teamId, { topic, details = '', mentorId = null }) {
  return run(pool, async (db) => {
    const team = await teamOfMember(db, teamId, user.id);
    if (!team) throw forbidden('NOT_A_TEAM_MEMBER');
    await db.query('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [team.id]);
    if (mentorId && !(await isMentor(db, team.hackathon_id, mentorId))) throw badRequest('NOT_A_MENTOR');
    const { rows: open } = await db.query(
      "SELECT count(*)::int AS n FROM mentoring_requests WHERE team_id = $1 AND status IN ('open', 'accepted')", [team.id],
    );
    if (open[0].n >= MAX_OPEN_REQUESTS_PER_TEAM) throw conflict('TOO_MANY_OPEN_REQUESTS');
    const { rows } = await db.query(
      `INSERT INTO mentoring_requests (hackathon_id, team_id, requested_by, mentor_id, topic, details)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [team.hackathon_id, team.id, user.id, mentorId, topic, details],
    );
    await audit(db, { actorId: user.id, hackathonId: team.hackathon_id, action: 'mentoring.requested', entityType: 'mentoring_request', entityId: rows[0].id });
    let recipients = mentorId ? [mentorId] : [];
    if (!mentorId) {
      const { rows: all } = await db.query('SELECT user_id FROM mentors WHERE hackathon_id = $1', [team.hackathon_id]);
      recipients = all.map((m) => m.user_id);
    }
    await notify(db, recipients, {
      hackathonId: team.hackathon_id, kind: 'mentoring.requested', link: `h/${await slugOf(db, team.hackathon_id)}/mentoring`,
      data: { teamName: team.name, topic },
    });
    return rows[0];
  });
}

async function loadRequest(db, requestId) {
  const { rows } = await db.query('SELECT * FROM mentoring_requests WHERE id = $1 FOR UPDATE', [requestId]);
  if (!rows[0]) throw notFound('REQUEST_NOT_FOUND');
  return rows[0];
}

// Mentor actions: accept (claims the request and, if needed, the team),
// decline (only a request addressed to them), complete with notes.
async function mentorAction(pool, user, requestId, action, { scheduledAt, notes } = {}) {
  return run(pool, async (db) => {
    const req = await loadRequest(db, requestId);
    if (!(await isMentor(db, req.hackathon_id, user.id))) throw forbidden('NOT_A_MENTOR');
    if (action === 'accept') {
      if (req.status !== 'open') throw conflict('REQUEST_NOT_OPEN');
      if (req.mentor_id && req.mentor_id !== user.id) throw forbidden('ADDRESSED_TO_ANOTHER_MENTOR');
      await assignLocked(db, user, req.hackathon_id, req.team_id, user.id);
      await db.query(
        "UPDATE mentoring_requests SET status = 'accepted', mentor_id = $2, scheduled_at = $3, updated_at = now() WHERE id = $1",
        [req.id, user.id, scheduledAt || null],
      );
    } else if (action === 'decline') {
      if (req.status !== 'open' || req.mentor_id !== user.id) throw conflict('CANNOT_DECLINE');
      // Declining returns the request to the shared queue instead of dropping it.
      await db.query("UPDATE mentoring_requests SET mentor_id = NULL, updated_at = now() WHERE id = $1", [req.id]);
    } else if (action === 'complete') {
      if (req.status !== 'accepted' || req.mentor_id !== user.id) throw conflict('CANNOT_COMPLETE');
      await db.query(
        "UPDATE mentoring_requests SET status = 'done', mentor_notes = $2, updated_at = now() WHERE id = $1",
        [req.id, notes || ''],
      );
    } else {
      throw badRequest('UNKNOWN_ACTION');
    }
    await audit(db, { actorId: user.id, hackathonId: req.hackathon_id, action: `mentoring.${action}`, entityType: 'mentoring_request', entityId: req.id });
    if (action === 'accept' || action === 'complete') {
      await notify(db, await teamMemberIds(db, req.team_id), {
        hackathonId: req.hackathon_id, kind: action === 'accept' ? 'mentoring.accepted' : 'mentoring.done',
        link: `h/${await slugOf(db, req.hackathon_id)}/mentoring`,
        data: { topic: req.topic, personName: user.display_name },
      });
    }
    const { rows } = await db.query('SELECT * FROM mentoring_requests WHERE id = $1', [req.id]);
    return rows[0];
  });
}

async function cancelRequest(pool, user, requestId) {
  return run(pool, async (db) => {
    const req = await loadRequest(db, requestId);
    if (!(await teamOfMember(db, req.team_id, user.id)) && !isAdmin(user)) throw forbidden('NOT_A_TEAM_MEMBER');
    if (!['open', 'accepted'].includes(req.status)) throw conflict('REQUEST_CLOSED');
    await db.query("UPDATE mentoring_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [req.id]);
    await audit(db, { actorId: user.id, hackathonId: req.hackathon_id, action: 'mentoring.cancelled', entityType: 'mentoring_request', entityId: req.id });
  });
}

const REQUEST_SELECT = `
  SELECT r.*, t.name AS team_name, u.display_name AS requested_by_name, mu.display_name AS mentor_name
    FROM mentoring_requests r
    JOIN teams t ON t.id = r.team_id
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN users mu ON mu.id = r.mentor_id`;

// Team members see their team's requests; mentors see the open queue plus
// their own; administrators see everything.
async function listRequests(pool, user, hackathonRef, { teamId } = {}) {
  const h = await loadHackathon(pool, hackathonRef, user);
  if (teamId) {
    if (!isAdmin(user) && !(await teamOfMember(pool, teamId, user.id))) {
      const { rows } = await pool.query('SELECT 1 FROM mentor_assignments WHERE team_id = $1 AND mentor_id = $2', [teamId, user.id]);
      if (!rows.length) throw forbidden('NOT_A_TEAM_MEMBER');
    }
    const { rows } = await pool.query(`${REQUEST_SELECT} WHERE r.team_id = $1 ORDER BY r.created_at DESC`, [teamId]);
    return rows;
  }
  if (isAdmin(user)) {
    const { rows } = await pool.query(`${REQUEST_SELECT} WHERE r.hackathon_id = $1 ORDER BY r.created_at DESC`, [h.id]);
    return rows;
  }
  if (!(await isMentor(pool, h.id, user.id))) throw forbidden('NOT_A_MENTOR');
  const { rows } = await pool.query(
    `${REQUEST_SELECT}
      WHERE r.hackathon_id = $1
        AND ((r.status = 'open' AND (r.mentor_id IS NULL OR r.mentor_id = $2)) OR r.mentor_id = $2)
      ORDER BY (r.status = 'open') DESC, r.created_at DESC`,
    [h.id, user.id],
  );
  return rows;
}

async function myMentoring(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const mentor = await isMentor(pool, h.id, user.id);
  const { rows: teams } = mentor
    ? await pool.query(
      `SELECT t.id, t.name, i.title AS idea_title FROM mentor_assignments a
         JOIN teams t ON t.id = a.team_id JOIN ideas i ON i.id = t.idea_id
        WHERE a.hackathon_id = $1 AND a.mentor_id = $2 AND t.status = 'active' ORDER BY t.name`,
      [h.id, user.id])
    : { rows: [] };
  return { isMentor: mentor, teams };
}

async function teamMentors(pool, user, teamId) {
  const { rows: t } = await pool.query("SELECT * FROM teams WHERE id = $1 AND status = 'active'", [teamId]);
  if (!t[0]) throw notFound('TEAM_NOT_FOUND');
  const { rows } = await pool.query(
    `SELECT a.mentor_id AS user_id, u.display_name, m.expertise FROM mentor_assignments a
       JOIN users u ON u.id = a.mentor_id
       LEFT JOIN mentors m ON m.hackathon_id = a.hackathon_id AND m.user_id = a.mentor_id
      WHERE a.team_id = $1 ORDER BY u.display_name`,
    [teamId],
  );
  return rows;
}

module.exports = {
  isMentor, addMentor, removeMentor, listMentors, assignMentor, unassignMentor,
  createRequest, mentorAction, cancelRequest, listRequests, myMentoring, teamMentors,
};
