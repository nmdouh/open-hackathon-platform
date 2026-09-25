'use strict';

const { tx } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const { badRequest, forbidden, notFound, conflict, fromPg } = require('../../lib/errors');
const { isAdmin } = require('../../auth/sessions');
const {
  loadHackathon, assertRegistrationOpen, assertIdeaSubmissionOpen, assertTeamingOpen,
} = require('../hackathons/service');

// Serialises everything one person does inside one hackathon (registering,
// changing role, applying, being accepted, leaving). Always taken before any
// team row lock so that lock order is consistent and deadlock-free.
async function lockParticipant(db, hackathonId, userId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${hackathonId}:${userId}`]);
}

async function activeRegistration(db, hackathonId, userId) {
  const { rows } = await db.query(
    "SELECT * FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active'",
    [hackathonId, userId],
  );
  return rows[0] || null;
}

async function membershipOf(db, hackathonId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
    [hackathonId, userId],
  );
  return rows[0] || null;
}

async function liveIdeaOf(db, hackathonId, userId) {
  const { rows } = await db.query(
    "SELECT * FROM ideas WHERE hackathon_id = $1 AND owner_id = $2 AND status <> 'withdrawn'",
    [hackathonId, userId],
  );
  return rows[0] || null;
}

async function teamSize(db, teamId) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM team_members WHERE team_id = $1', [teamId]);
  return rows[0].n;
}

// Wraps a transaction so unique-index violations become domain errors.
const run = (pool, fn) => tx(pool, fn).catch((e) => { throw fromPg(e); });

// ------------------------------------------------------------------ registration

async function register(pool, user, hackathonRef, { role, skills = [], bio = '' }) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    assertRegistrationOpen(h);
    await lockParticipant(db, h.id, user.id);
    if (await activeRegistration(db, h.id, user.id)) throw conflict('ALREADY_REGISTERED');
    // People who judge or coach a hackathon cannot also compete in it.
    const { rows: staff } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM mentors WHERE hackathon_id = $1 AND user_id = $2) AS mentor,
              EXISTS (SELECT 1 FROM round_reviewers v JOIN review_rounds r ON r.id = v.round_id
                       WHERE r.hackathon_id = $1 AND v.user_id = $2) AS reviewer`,
      [h.id, user.id],
    );
    if (staff[0].mentor) throw conflict('MENTORS_CANNOT_REGISTER');
    if (staff[0].reviewer) throw conflict('REVIEWERS_CANNOT_REGISTER');
    const { rows } = await db.query(
      `INSERT INTO registrations (hackathon_id, user_id, role, skills, bio)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [h.id, user.id, role, skills, bio],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'registration.created', entityType: 'registration', entityId: rows[0].id, details: { role } });
    return rows[0];
  });
}

async function updateRegistration(pool, user, hackathonRef, { role, skills, bio }) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    await lockParticipant(db, h.id, user.id);
    const reg = await activeRegistration(db, h.id, user.id);
    if (!reg) throw notFound('NOT_REGISTERED');
    if (role && role !== reg.role) {
      assertRegistrationOpen(h);
      // Changing role is only possible before anything depends on it:
      // an idea owner with an idea cannot become a member, and a member who
      // joined or applied to a team cannot become an idea owner.
      if (await membershipOf(db, h.id, user.id)) throw conflict('ROLE_LOCKED_IN_TEAM');
      if (await liveIdeaOf(db, h.id, user.id)) throw conflict('ROLE_LOCKED_HAS_IDEA');
      const { rows } = await db.query(
        "SELECT 1 FROM applications WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending' LIMIT 1",
        [h.id, user.id],
      );
      if (rows.length) throw conflict('ROLE_LOCKED_PENDING_APPLICATIONS');
    }
    const { rows } = await db.query(
      `UPDATE registrations SET role = COALESCE($2, role), skills = COALESCE($3, skills),
              bio = COALESCE($4, bio), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [reg.id, role ?? null, skills ?? null, bio ?? null],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'registration.updated', entityType: 'registration', entityId: reg.id, details: { roleFrom: reg.role, roleTo: rows[0].role } });
    return rows[0];
  });
}

async function withdrawRegistration(pool, user, hackathonRef) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    await lockParticipant(db, h.id, user.id);
    const reg = await activeRegistration(db, h.id, user.id);
    if (!reg) throw notFound('NOT_REGISTERED');
    const m = await membershipOf(db, h.id, user.id);
    if (m) throw conflict(m.role === 'owner' ? 'DISBAND_TEAM_FIRST' : 'LEAVE_TEAM_FIRST');
    await db.query(
      "UPDATE applications SET status = 'withdrawn', decided_at = now() WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending'",
      [h.id, user.id],
    );
    await db.query(
      "UPDATE ideas SET status = 'withdrawn', updated_at = now() WHERE hackathon_id = $1 AND owner_id = $2 AND status <> 'withdrawn'",
      [h.id, user.id],
    );
    await db.query("UPDATE registrations SET status = 'withdrawn', updated_at = now() WHERE id = $1", [reg.id]);
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'registration.withdrawn', entityType: 'registration', entityId: reg.id });
  });
}

// Everything the signed-in person needs to render their own dashboard.
async function myState(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const registration = await activeRegistration(pool, h.id, user.id);
  const idea = await liveIdeaOf(pool, h.id, user.id);
  const membership = await membershipOf(pool, h.id, user.id);
  const { rows: applications } = await pool.query(
    `SELECT a.*, t.name AS team_name, i.title AS idea_title, iu.display_name AS invited_by_name
       FROM applications a JOIN teams t ON t.id = a.team_id JOIN ideas i ON i.id = t.idea_id
       LEFT JOIN users iu ON iu.id = a.invited_by
      WHERE a.hackathon_id = $1 AND a.user_id = $2 ORDER BY (a.status = 'pending') DESC, a.created_at DESC`,
    [h.id, user.id],
  );
  return { hackathon: h, registration, idea, membership, applications };
}

// ------------------------------------------------------------------ ideas

const IDEA_FIELDS = {
  title: 'title', problem: 'problem', solution: 'solution', targetUsers: 'target_users',
  expectedImpact: 'expected_impact', dataAndTools: 'data_and_tools', trackId: 'track_id',
};

function assertSubmittable(idea) {
  const missing = ['title', 'problem', 'solution'].filter((k) => !String(idea[k] || '').trim());
  if (missing.length) throw badRequest('IDEA_INCOMPLETE', 'Title, problem and solution are required', missing);
}

async function assertTrack(db, hackathonId, trackId) {
  if (!trackId) return;
  const { rows } = await db.query('SELECT 1 FROM tracks WHERE id = $1 AND hackathon_id = $2', [trackId, hackathonId]);
  if (!rows.length) throw badRequest('UNKNOWN_TRACK');
}

async function createIdea(pool, user, hackathonRef, fields, { submit = false } = {}) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    assertIdeaSubmissionOpen(h);
    await lockParticipant(db, h.id, user.id);
    const reg = await activeRegistration(db, h.id, user.id);
    if (!reg) throw forbidden('NOT_REGISTERED');
    if (reg.role !== 'idea_owner') throw forbidden('ONLY_IDEA_OWNERS_SUBMIT');
    if (await liveIdeaOf(db, h.id, user.id)) throw conflict('IDEA_EXISTS');
    await assertTrack(db, h.id, fields.trackId);
    if (submit) assertSubmittable(fields);
    const { rows } = await db.query(
      `INSERT INTO ideas (hackathon_id, owner_id, track_id, title, problem, solution, target_users,
                          expected_impact, data_and_tools, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [h.id, user.id, fields.trackId || null, fields.title, fields.problem || '', fields.solution || '',
        fields.targetUsers || '', fields.expectedImpact || '', fields.dataAndTools || '',
        submit ? 'submitted' : 'draft', submit ? new Date() : null],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: submit ? 'idea.submitted' : 'idea.created', entityType: 'idea', entityId: rows[0].id });
    return rows[0];
  });
}

async function loadIdeaForOwner(db, user, ideaId, { lockOwner = false } = {}) {
  if (lockOwner) {
    const { rows: pre } = await db.query('SELECT hackathon_id FROM ideas WHERE id = $1', [ideaId]);
    if (pre[0]) await lockParticipant(db, pre[0].hackathon_id, user.id);
  }
  const { rows } = await db.query('SELECT * FROM ideas WHERE id = $1 FOR UPDATE', [ideaId]);
  const idea = rows[0];
  if (!idea) throw notFound('IDEA_NOT_FOUND');
  if (idea.owner_id !== user.id) throw forbidden('NOT_IDEA_OWNER');
  if (idea.status === 'withdrawn') throw conflict('IDEA_WITHDRAWN');
  return idea;
}

async function updateIdea(pool, user, ideaId, fields) {
  return run(pool, async (db) => {
    const idea = await loadIdeaForOwner(db, user, ideaId);
    const h = await loadHackathon(db, idea.hackathon_id, user);
    assertIdeaSubmissionOpen(h);
    await assertTrack(db, h.id, fields.trackId);
    const next = { ...idea };
    const sets = [];
    const vals = [];
    for (const [api, col] of Object.entries(IDEA_FIELDS)) {
      if (fields[api] === undefined) continue;
      next[col] = fields[api];
      vals.push(fields[api]);
      sets.push(`${col} = $${vals.length + 1}`);
    }
    if (!sets.length) return idea;
    if (idea.status === 'submitted') assertSubmittable(next);
    const { rows } = await db.query(
      `UPDATE ideas SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [idea.id, ...vals],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'idea.updated', entityType: 'idea', entityId: idea.id, details: { fields: Object.keys(fields) } });
    return rows[0];
  });
}

async function submitIdea(pool, user, ideaId) {
  return run(pool, async (db) => {
    const idea = await loadIdeaForOwner(db, user, ideaId);
    const h = await loadHackathon(db, idea.hackathon_id, user);
    assertIdeaSubmissionOpen(h);
    if (idea.status === 'submitted') return idea;
    assertSubmittable(idea);
    const { rows } = await db.query(
      "UPDATE ideas SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
      [idea.id],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'idea.submitted', entityType: 'idea', entityId: idea.id });
    return rows[0];
  });
}

async function withdrawIdea(pool, user, ideaId) {
  return run(pool, async (db) => {
    const idea = await loadIdeaForOwner(db, user, ideaId, { lockOwner: true });
    const { rows: teams } = await db.query(
      "SELECT id FROM teams WHERE idea_id = $1 AND status = 'active' FOR UPDATE", [idea.id],
    );
    if (teams.length) {
      if ((await teamSize(db, teams[0].id)) > 1) throw conflict('IDEA_HAS_TEAM_MEMBERS');
      await disbandLocked(db, user, teams[0].id, idea.hackathon_id);
    }
    const { rows } = await db.query(
      "UPDATE ideas SET status = 'withdrawn', updated_at = now() WHERE id = $1 RETURNING *", [idea.id],
    );
    await audit(db, { actorId: user.id, hackathonId: idea.hackathon_id, action: 'idea.withdrawn', entityType: 'idea', entityId: idea.id });
    return rows[0];
  });
}

async function canSeeHackathonContent(db, user, hackathonId) {
  if (isAdmin(user)) return true;
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active')
         OR EXISTS (SELECT 1 FROM mentors WHERE hackathon_id = $1 AND user_id = $2)
         OR EXISTS (SELECT 1 FROM round_reviewers v JOIN review_rounds r ON r.id = v.round_id
                     WHERE r.hackathon_id = $1 AND v.user_id = $2) AS ok`,
    [hackathonId, user.id],
  );
  return rows[0].ok;
}

// Participants see every submitted idea (so members can pick a team);
// drafts are visible to their owner and to administrators only.
async function listIdeas(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  if (!(await canSeeHackathonContent(pool, user, h.id))) throw forbidden('NOT_REGISTERED');
  const admin = isAdmin(user);
  const { rows } = await pool.query(
    `SELECT i.*, u.display_name AS owner_name, ${admin ? 'u.email AS owner_email,' : ''}
            tr.name_en AS track_name_en, tr.name_ar AS track_name_ar,
            t.id AS team_id, t.name AS team_name
       FROM ideas i
       JOIN users u ON u.id = i.owner_id
       LEFT JOIN tracks tr ON tr.id = i.track_id
       LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
      WHERE i.hackathon_id = $1
        AND (${admin ? 'true' : "i.status = 'submitted' OR i.owner_id = $2"})
      ORDER BY i.submitted_at DESC NULLS LAST, i.created_at DESC`,
    admin ? [h.id] : [h.id, user.id],
  );
  return rows;
}

async function getIdea(pool, user, ideaId) {
  const { rows } = await pool.query(
    `SELECT i.*, u.display_name AS owner_name, tr.name_en AS track_name_en, tr.name_ar AS track_name_ar
       FROM ideas i JOIN users u ON u.id = i.owner_id LEFT JOIN tracks tr ON tr.id = i.track_id
      WHERE i.id = $1`,
    [ideaId],
  );
  const idea = rows[0];
  if (!idea) throw notFound('IDEA_NOT_FOUND');
  const own = idea.owner_id === user.id;
  if (!own && !isAdmin(user)) {
    if (idea.status !== 'submitted' || !(await canSeeHackathonContent(pool, user, idea.hackathon_id))) {
      throw notFound('IDEA_NOT_FOUND');
    }
  }
  return idea;
}

// ------------------------------------------------------------------ teams

async function createTeam(pool, user, ideaId, { name, lookingFor = '' }) {
  return run(pool, async (db) => {
    const idea = await loadIdeaForOwner(db, user, ideaId, { lockOwner: true });
    if (idea.status !== 'submitted') throw conflict('IDEA_NOT_SUBMITTED');
    const h = await loadHackathon(db, idea.hackathon_id, user);
    assertTeamingOpen(h);
    const reg = await activeRegistration(db, h.id, user.id);
    if (!reg || reg.role !== 'idea_owner') throw forbidden('ONLY_IDEA_OWNERS_CREATE_TEAMS');
    if (await membershipOf(db, h.id, user.id)) throw conflict('ALREADY_IN_TEAM');
    const { rows } = await db.query(
      `INSERT INTO teams (hackathon_id, idea_id, owner_id, name, looking_for)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [h.id, idea.id, user.id, name, lookingFor],
    );
    await db.query(
      "INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
      [rows[0].id, h.id, user.id],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'team.created', entityType: 'team', entityId: rows[0].id, details: { ideaId: idea.id } });
    return rows[0];
  });
}

async function lockTeam(db, teamId) {
  const { rows } = await db.query('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
  if (!rows[0] || rows[0].status !== 'active') throw notFound('TEAM_NOT_FOUND');
  return rows[0];
}

function assertTeamManager(user, team) {
  if (team.owner_id !== user.id && !isAdmin(user)) throw forbidden('NOT_TEAM_OWNER');
}

async function updateTeam(pool, user, teamId, { name, lookingFor, isOpen }) {
  return run(pool, async (db) => {
    const team = await lockTeam(db, teamId);
    assertTeamManager(user, team);
    const { rows } = await db.query(
      `UPDATE teams SET name = COALESCE($2, name), looking_for = COALESCE($3, looking_for),
              is_open = COALESCE($4, is_open), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [team.id, name ?? null, lookingFor ?? null, isOpen ?? null],
    );
    await audit(db, { actorId: user.id, hackathonId: team.hackathon_id, action: 'team.updated', entityType: 'team', entityId: team.id });
    return rows[0];
  });
}

async function disbandLocked(db, user, teamId, hackathonId) {
  await db.query("UPDATE teams SET status = 'disbanded', is_open = false, updated_at = now() WHERE id = $1", [teamId]);
  await db.query(
    "UPDATE applications SET status = 'cancelled', decided_at = now() WHERE team_id = $1 AND status = 'pending'",
    [teamId],
  );
  await db.query(
    "UPDATE applications SET status = 'removed', decided_at = now() WHERE team_id = $1 AND status = 'accepted'",
    [teamId],
  );
  await db.query('DELETE FROM team_members WHERE team_id = $1', [teamId]);
  await audit(db, { actorId: user.id, hackathonId, action: 'team.disbanded', entityType: 'team', entityId: teamId });
}

// Owners can disband only an empty team; administrators can always disband.
async function disbandTeam(pool, user, teamId) {
  return run(pool, async (db) => {
    const team = await lockTeam(db, teamId);
    assertTeamManager(user, team);
    if (!isAdmin(user) && (await teamSize(db, team.id)) > 1) throw conflict('TEAM_HAS_MEMBERS');
    await disbandLocked(db, user, team.id, team.hackathon_id);
  });
}

async function listTeams(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  if (!(await canSeeHackathonContent(pool, user, h.id))) throw forbidden('NOT_REGISTERED');
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.looking_for, t.is_open, t.owner_id, t.created_at,
            i.id AS idea_id, i.title AS idea_title, i.problem AS idea_problem,
            tr.name_en AS track_name_en, tr.name_ar AS track_name_ar,
            u.display_name AS owner_name,
            (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count,
            (SELECT a.status FROM applications a WHERE a.team_id = t.id AND a.user_id = $2
              ORDER BY a.created_at DESC LIMIT 1) AS my_application_status,
            (SELECT count(*)::int FROM team_milestones tm WHERE tm.team_id = t.id) AS milestones_done,
            (SELECT count(*)::int FROM milestones ms WHERE ms.hackathon_id = t.hackathon_id) AS milestones_total
       FROM teams t
       JOIN ideas i ON i.id = t.idea_id
       JOIN users u ON u.id = t.owner_id
       LEFT JOIN tracks tr ON tr.id = i.track_id
      WHERE t.hackathon_id = $1 AND t.status = 'active'
      ORDER BY t.created_at`,
    [h.id, user.id],
  );
  return rows.map((t) => ({ ...t, capacity: h.max_team_size, is_full: t.member_count >= h.max_team_size }));
}

async function getTeam(pool, user, teamId) {
  const { rows } = await pool.query(
    `SELECT t.*, h.max_team_size AS capacity, i.title AS idea_title
       FROM teams t JOIN hackathons h ON h.id = t.hackathon_id JOIN ideas i ON i.id = t.idea_id
      WHERE t.id = $1 AND t.status = 'active'`,
    [teamId],
  );
  const team = rows[0];
  if (!team || !(await canSeeHackathonContent(pool, user, team.hackathon_id))) throw notFound('TEAM_NOT_FOUND');
  const { rows: members } = await pool.query(
    `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.email, r.skills
       FROM team_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN registrations r ON r.hackathon_id = m.hackathon_id AND r.user_id = m.user_id AND r.status = 'active'
      WHERE m.team_id = $1 ORDER BY m.role DESC, m.joined_at`,
    [team.id],
  );
  // Contact details are shared only inside the team and with administrators.
  const insider = isAdmin(user) || members.some((m) => m.user_id === user.id);
  return { team, members: members.map((m) => (insider ? m : { ...m, email: undefined })), insider };
}

// ------------------------------------------------------------------ applications

async function apply(pool, user, teamId, { message = '' }) {
  return run(pool, async (db) => {
    const { rows: pre } = await db.query('SELECT hackathon_id FROM teams WHERE id = $1', [teamId]);
    if (!pre[0]) throw notFound('TEAM_NOT_FOUND');
    const h = await loadHackathon(db, pre[0].hackathon_id, user);
    assertTeamingOpen(h);
    await lockParticipant(db, h.id, user.id);
    const team = await lockTeam(db, teamId);
    const reg = await activeRegistration(db, h.id, user.id);
    if (!reg) throw forbidden('NOT_REGISTERED');
    if (reg.role !== 'member') throw forbidden('IDEA_OWNERS_CANNOT_APPLY');
    if (await membershipOf(db, h.id, user.id)) throw conflict('ALREADY_IN_TEAM');
    if (!team.is_open) throw conflict('TEAM_CLOSED');
    if ((await teamSize(db, team.id)) >= h.max_team_size) throw conflict('TEAM_FULL');
    const { rows: pending } = await db.query(
      "SELECT count(*)::int AS n FROM applications WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending' AND direction = 'apply'",
      [h.id, user.id],
    );
    if (pending[0].n >= h.max_pending_applications) throw conflict('TOO_MANY_PENDING_APPLICATIONS');
    const { rows } = await db.query(
      `INSERT INTO applications (team_id, hackathon_id, user_id, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [team.id, h.id, user.id, message],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'application.created', entityType: 'application', entityId: rows[0].id, details: { teamId: team.id } });
    await notify(db, team.owner_id, {
      hackathonId: h.id, kind: 'application.received', link: `h/${h.slug}/teams/${team.id}`,
      data: { teamName: team.name, personName: user.display_name },
    });
    return rows[0];
  });
}

// A team owner invites a registered member who has no team yet. The invitee
// accepts or declines; all the usual team rules apply on acceptance.
async function invite(pool, user, teamId, { userId, message = '' }) {
  return run(pool, async (db) => {
    const { rows: pre } = await db.query('SELECT hackathon_id FROM teams WHERE id = $1', [teamId]);
    if (!pre[0]) throw notFound('TEAM_NOT_FOUND');
    const h = await loadHackathon(db, pre[0].hackathon_id, user);
    assertTeamingOpen(h);
    await lockParticipant(db, h.id, userId);
    const team = await lockTeam(db, teamId);
    assertTeamManager(user, team);
    const reg = await activeRegistration(db, h.id, userId);
    if (!reg || reg.role !== 'member') throw conflict('INVITEE_NOT_ELIGIBLE');
    if (await membershipOf(db, h.id, userId)) throw conflict('ALREADY_IN_TEAM');
    if ((await teamSize(db, team.id)) >= h.max_team_size) throw conflict('TEAM_FULL');
    const { rows } = await db.query(
      `INSERT INTO applications (team_id, hackathon_id, user_id, message, direction, invited_by)
       VALUES ($1, $2, $3, $4, 'invite', $5) RETURNING *`,
      [team.id, h.id, userId, message, user.id],
    );
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'invitation.created', entityType: 'application', entityId: rows[0].id, details: { teamId: team.id, personId: userId } });
    await notify(db, userId, {
      hackathonId: h.id, kind: 'invitation.received', link: `h/${h.slug}/me`,
      data: { teamName: team.name, personName: user.display_name },
    });
    return rows[0];
  });
}

async function loadApplication(db, applicationId) {
  const { rows } = await db.query('SELECT * FROM applications WHERE id = $1', [applicationId]);
  if (!rows[0]) throw notFound('APPLICATION_NOT_FOUND');
  return rows[0];
}

async function decide(pool, user, applicationId, decision) {
  return run(pool, async (db) => {
    const pre = await loadApplication(db, applicationId);
    const h = await loadHackathon(db, pre.hackathon_id, user);
    if (decision === 'accepted') {
      assertTeamingOpen(h);
      await lockParticipant(db, h.id, pre.user_id);
    }
    const team = await lockTeam(db, pre.team_id);
    // An application is answered by the team; an invitation by the invitee.
    if (pre.direction === 'invite') {
      if (pre.user_id !== user.id) throw forbidden('NOT_YOUR_INVITATION');
    } else {
      assertTeamManager(user, team);
    }
    const app = await loadApplication(db, applicationId);
    if (app.status !== 'pending') throw conflict('APPLICATION_NOT_PENDING');

    if (decision === 'accepted') {
      const reg = await activeRegistration(db, h.id, app.user_id);
      if (!reg || reg.role !== 'member') throw conflict('APPLICANT_NOT_ELIGIBLE');
      if (await membershipOf(db, h.id, app.user_id)) throw conflict('ALREADY_IN_TEAM');
      if ((await teamSize(db, team.id)) >= h.max_team_size) throw conflict('TEAM_FULL');
      await db.query(
        "INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'member')",
        [team.id, h.id, app.user_id],
      );
      // Joining one team ends the person's other open applications.
      await db.query(
        `UPDATE applications SET status = 'cancelled', decided_at = now()
          WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending' AND id <> $3`,
        [h.id, app.user_id, app.id],
      );
    }
    const { rows } = await db.query(
      'UPDATE applications SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *',
      [app.id, decision, user.id],
    );
    await audit(db, {
      actorId: user.id, hackathonId: h.id, action: `${app.direction === 'invite' ? 'invitation' : 'application'}.${decision}`,
      entityType: 'application', entityId: app.id, details: { teamId: team.id, personId: app.user_id },
    });
    if (app.direction === 'invite') {
      await notify(db, team.owner_id, {
        hackathonId: h.id, kind: `invitation.${decision}`, link: `h/${h.slug}/teams/${team.id}`,
        data: { teamName: team.name, personName: user.display_name },
      });
    } else {
      await notify(db, app.user_id, {
        hackathonId: h.id, kind: `application.${decision}`,
        link: decision === 'accepted' ? `h/${h.slug}/teams/${team.id}` : `h/${h.slug}/teams`,
        data: { teamName: team.name },
      });
    }
    return rows[0];
  });
}

async function withdrawApplication(pool, user, applicationId) {
  return run(pool, async (db) => {
    const pre = await loadApplication(db, applicationId);
    if (pre.direction === 'invite') {
      const { rows: t } = await db.query('SELECT * FROM teams WHERE id = $1', [pre.team_id]);
      assertTeamManager(user, t[0]);
    } else if (pre.user_id !== user.id) {
      throw forbidden('NOT_YOUR_APPLICATION');
    }
    await lockParticipant(db, pre.hackathon_id, pre.user_id);
    const { rows } = await db.query(
      "UPDATE applications SET status = 'withdrawn', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
      [pre.id],
    );
    if (!rows[0]) throw conflict('APPLICATION_NOT_PENDING');
    await audit(db, { actorId: user.id, hackathonId: pre.hackathon_id, action: `${pre.direction === 'invite' ? 'invitation' : 'application'}.withdrawn`, entityType: 'application', entityId: pre.id });
    return rows[0];
  });
}

async function teamApplications(pool, user, teamId) {
  const { rows: t } = await pool.query("SELECT * FROM teams WHERE id = $1 AND status = 'active'", [teamId]);
  if (!t[0]) throw notFound('TEAM_NOT_FOUND');
  assertTeamManager(user, t[0]);
  const { rows } = await pool.query(
    `SELECT a.*, u.display_name, u.email, r.skills, r.bio
       FROM applications a JOIN users u ON u.id = a.user_id
       LEFT JOIN registrations r ON r.hackathon_id = a.hackathon_id AND r.user_id = a.user_id AND r.status = 'active'
      WHERE a.team_id = $1 ORDER BY (a.status = 'pending') DESC, a.created_at DESC`,
    [teamId],
  );
  return rows;
}

// Removes a member (owner or admin) or lets a member leave. The owner can
// never be removed from their own team; the team must be disbanded instead.
async function removeMember(pool, user, teamId, memberId) {
  return run(pool, async (db) => {
    const { rows: pre } = await db.query('SELECT hackathon_id FROM teams WHERE id = $1', [teamId]);
    if (!pre[0]) throw notFound('TEAM_NOT_FOUND');
    await lockParticipant(db, pre[0].hackathon_id, memberId);
    const team = await lockTeam(db, teamId);
    const self = memberId === user.id;
    if (!self) assertTeamManager(user, team);
    if (memberId === team.owner_id) throw conflict('OWNER_CANNOT_LEAVE');
    const { rowCount } = await db.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, memberId]);
    if (!rowCount) throw notFound('NOT_A_MEMBER');
    await db.query(
      `UPDATE applications SET status = $3, decided_at = now()
        WHERE team_id = $1 AND user_id = $2 AND status = 'accepted'`,
      [team.id, memberId, self ? 'left' : 'removed'],
    );
    await audit(db, { actorId: user.id, hackathonId: team.hackathon_id, action: self ? 'team.member_left' : 'team.member_removed', entityType: 'team', entityId: team.id, details: { memberId } });
  });
}

// ------------------------------------------------------------------ admin overview

async function participants(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows } = await pool.query(
    `SELECT r.id AS registration_id, r.role, r.skills, r.created_at AS registered_at,
            u.id AS user_id, u.display_name, u.email,
            i.id AS idea_id, i.title AS idea_title, i.status AS idea_status,
            t.id AS team_id, t.name AS team_name, m.role AS team_role
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN ideas i ON i.hackathon_id = r.hackathon_id AND i.owner_id = r.user_id AND i.status <> 'withdrawn'
       LEFT JOIN team_members m ON m.hackathon_id = r.hackathon_id AND m.user_id = r.user_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE r.hackathon_id = $1 AND r.status = 'active'
      ORDER BY r.created_at`,
    [h.id],
  );
  return rows;
}

module.exports = {
  register, updateRegistration, withdrawRegistration, myState,
  createIdea, updateIdea, submitIdea, withdrawIdea, listIdeas, getIdea,
  createTeam, updateTeam, disbandTeam, listTeams, getTeam,
  apply, invite, decide, withdrawApplication, teamApplications, removeMember,
  participants, activeRegistration, lockParticipant,
};
