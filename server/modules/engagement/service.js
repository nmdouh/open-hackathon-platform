'use strict';

const { tx } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const { badRequest, forbidden, notFound, conflict } = require('../../lib/errors');
const { isAdmin } = require('../../auth/sessions');
const { loadHackathon } = require('../hackathons/service');
const { scoreSkills } = require('./matching');

// ------------------------------------------------------------------ notifications

async function listNotifications(pool, user, { limit, unreadOnly }) {
  const { rows } = await pool.query(
    `SELECT n.*, h.slug AS hackathon_slug FROM notifications n LEFT JOIN hackathons h ON h.id = n.hackathon_id
      WHERE n.user_id = $1 AND ($2::boolean IS FALSE OR n.read_at IS NULL)
      ORDER BY n.created_at DESC LIMIT $3`,
    [user.id, Boolean(unreadOnly), limit],
  );
  return rows;
}

async function unreadCount(pool, user) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  return rows[0].n;
}

async function markRead(pool, user, { ids, all }) {
  if (all) {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  } else if (ids && ids.length) {
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])',
      [user.id, ids],
    );
  }
  return unreadCount(pool, user);
}

// ------------------------------------------------------------------ matchmaking

// Members without a team get suggested teams; team owners get suggested
// people to invite. Everyone else gets nothing.
async function matches(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows: regRows } = await pool.query(
    "SELECT * FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active'", [h.id, user.id],
  );
  const reg = regRows[0];
  if (!reg) return { mode: null, teams: [], people: [] };
  const { rows: mine } = await pool.query(
    `SELECT t.*, i.title, i.problem, i.solution FROM team_members m JOIN teams t ON t.id = m.team_id JOIN ideas i ON i.id = t.idea_id
      WHERE m.hackathon_id = $1 AND m.user_id = $2 AND t.status = 'active'`,
    [h.id, user.id],
  );
  const myTeam = mine[0];

  if (reg.role === 'member' && !myTeam) {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.looking_for, i.title AS idea_title, i.problem, i.solution,
              tr.name_en AS track_name_en, tr.name_ar AS track_name_ar,
              (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count
         FROM teams t JOIN ideas i ON i.id = t.idea_id LEFT JOIN tracks tr ON tr.id = i.track_id
        WHERE t.hackathon_id = $1 AND t.status = 'active' AND t.is_open
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.team_id = t.id AND a.user_id = $2 AND a.status = 'pending')`,
      [h.id, user.id],
    );
    const teams = rows
      .filter((t) => t.member_count < h.max_team_size)
      .map((t) => ({
        ...t,
        capacity: h.max_team_size,
        ...scoreSkills(reg.skills, { lookingFor: t.looking_for, context: `${t.idea_title} ${t.problem} ${t.solution} ${t.track_name_en || ''}` }),
      }))
      // Best match first; among equals, teams that still need people most.
      .sort((a, b) => b.score - a.score || a.member_count - b.member_count)
      .slice(0, 6)
      .map(({ problem, solution, ...t }) => t);
    return { mode: 'teams', teams, people: [] };
  }

  if (myTeam && myTeam.owner_id === user.id) {
    const { rows } = await pool.query(
      `SELECT r.user_id, r.skills, r.bio, u.display_name
         FROM registrations r JOIN users u ON u.id = r.user_id
        WHERE r.hackathon_id = $1 AND r.status = 'active' AND r.role = 'member' AND u.is_active
          AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.hackathon_id = r.hackathon_id AND m.user_id = r.user_id)
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.team_id = $2 AND a.user_id = r.user_id AND a.status = 'pending')`,
      [h.id, myTeam.id],
    );
    const people = rows
      .map((p) => ({
        userId: p.user_id, displayName: p.display_name, skills: p.skills, bio: p.bio.slice(0, 280),
        ...scoreSkills(p.skills, { lookingFor: myTeam.looking_for, context: `${myTeam.title} ${myTeam.problem} ${myTeam.solution}` }),
      }))
      .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
      .slice(0, 8);
    return { mode: 'people', teamId: myTeam.id, teams: [], people };
  }
  return { mode: null, teams: [], people: [] };
}

// ------------------------------------------------------------------ milestones

const DEFAULT_MILESTONES = [
  ['Problem checked with real users', 'التحقق من المشكلة مع مستخدمين حقيقيين',
    'Spoke with at least three people who have the problem, and wrote down what they said.',
    'التحدث مع ثلاثة أشخاص على الأقل يعانون من المشكلة، وتدوين ما قالوه.'],
  ['Scope and critical path agreed', 'الاتفاق على النطاق والمسار الأساسي',
    'The team agreed on the one path the demo must prove, and what is out of scope.',
    'اتفق الفريق على المسار الوحيد الذي يجب أن يثبته العرض، وما هو خارج النطاق.'],
  ['First end-to-end version works', 'أول نسخة تعمل من البداية إلى النهاية',
    'The critical path runs from start to finish, even if parts are still rough.',
    'يعمل المسار الأساسي من البداية إلى النهاية، ولو كانت بعض الأجزاء بسيطة.'],
  ['Tested with users and measured', 'الاختبار مع المستخدمين والقياس',
    'Real users tried it; you have before-and-after numbers.',
    'جرّبه مستخدمون حقيقيون، ولديكم أرقام قبل وبعد.'],
  ['Data and AI risks reviewed', 'مراجعة مخاطر البيانات والذكاء الاصطناعي',
    'Personal data minimised, known limits written down, a person decides where it matters.',
    'تقليل البيانات الشخصية، وتدوين الحدود المعروفة، وقرار بشري حيث يلزم.'],
  ['Pitch rehearsed on time', 'التدرّب على العرض ضمن الوقت',
    'Full run-through with a timer, including the live demo and a fallback.',
    'تجربة كاملة مع مؤقّت، بما فيها العرض الحي وخطة بديلة.'],
];

async function listMilestones(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows } = await pool.query(
    `SELECT m.*, (SELECT count(*)::int FROM team_milestones tm WHERE tm.milestone_id = m.id) AS teams_done
       FROM milestones m WHERE m.hackathon_id = $1 ORDER BY m.sort_order, m.due_at NULLS LAST`,
    [h.id],
  );
  return rows;
}

async function createMilestone(pool, user, hackathonRef, b) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows } = await pool.query(
    `INSERT INTO milestones (hackathon_id, title_en, title_ar, description_en, description_ar, due_at, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [h.id, b.titleEn, b.titleAr, b.descriptionEn, b.descriptionAr, b.dueAt, b.sortOrder],
  );
  await audit(pool, { actorId: user.id, hackathonId: h.id, action: 'milestone.created', entityType: 'milestone', entityId: rows[0].id });
  return rows[0];
}

async function applyMilestoneTemplate(pool, user, hackathonRef) {
  return tx(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user, { lock: true });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM milestones WHERE hackathon_id = $1', [h.id]);
    if (rows[0].n) throw conflict('MILESTONES_EXIST');
    for (const [i, [te, ta, de, da]] of DEFAULT_MILESTONES.entries()) {
      await db.query(
        `INSERT INTO milestones (hackathon_id, title_en, title_ar, description_en, description_ar, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [h.id, te, ta, de, da, i],
      );
    }
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'milestone.template_applied', entityType: 'hackathon', entityId: h.id });
  });
}

async function updateMilestone(pool, user, id, b) {
  const map = { titleEn: 'title_en', titleAr: 'title_ar', descriptionEn: 'description_en', descriptionAr: 'description_ar', dueAt: 'due_at', sortOrder: 'sort_order' };
  const sets = [];
  const vals = [];
  for (const [api, col] of Object.entries(map)) {
    if (b[api] === undefined) continue;
    vals.push(b[api]);
    sets.push(`${col} = $${vals.length + 1}`);
  }
  if (!sets.length) throw badRequest('NOTHING_TO_UPDATE');
  const { rows } = await pool.query(`UPDATE milestones SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
  if (!rows[0]) throw notFound('MILESTONE_NOT_FOUND');
  await audit(pool, { actorId: user.id, hackathonId: rows[0].hackathon_id, action: 'milestone.updated', entityType: 'milestone', entityId: id });
  return rows[0];
}

async function deleteMilestone(pool, user, id) {
  const { rows } = await pool.query('DELETE FROM milestones WHERE id = $1 RETURNING hackathon_id', [id]);
  if (!rows[0]) throw notFound('MILESTONE_NOT_FOUND');
  await audit(pool, { actorId: user.id, hackathonId: rows[0].hackathon_id, action: 'milestone.deleted', entityType: 'milestone', entityId: id });
}

async function viewerCanSeeTeam(db, user, team) {
  if (isAdmin(user)) return true;
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active')
         OR EXISTS (SELECT 1 FROM mentors WHERE hackathon_id = $1 AND user_id = $2)
         OR EXISTS (SELECT 1 FROM round_reviewers v JOIN review_rounds r ON r.id = v.round_id WHERE r.hackathon_id = $1 AND v.user_id = $2) AS ok`,
    [team.hackathon_id, user.id],
  );
  return rows[0].ok;
}

async function loadActiveTeam(db, teamId) {
  const { rows } = await db.query("SELECT * FROM teams WHERE id = $1 AND status = 'active'", [teamId]);
  if (!rows[0]) throw notFound('TEAM_NOT_FOUND');
  return rows[0];
}

async function teamMilestones(pool, user, teamId) {
  const team = await loadActiveTeam(pool, teamId);
  if (!(await viewerCanSeeTeam(pool, user, team))) throw notFound('TEAM_NOT_FOUND');
  const { rows } = await pool.query(
    `SELECT m.*, tm.done_at, tm.evidence_url, u.display_name AS done_by_name
       FROM milestones m
       LEFT JOIN team_milestones tm ON tm.milestone_id = m.id AND tm.team_id = $2
       LEFT JOIN users u ON u.id = tm.done_by
      WHERE m.hackathon_id = $1 ORDER BY m.sort_order, m.due_at NULLS LAST`,
    [team.hackathon_id, team.id],
  );
  const { rows: member } = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, user.id]);
  return { milestones: rows, canEdit: member.length > 0 || isAdmin(user) };
}

async function setTeamMilestone(pool, user, teamId, milestoneId, { done, evidenceUrl }) {
  return tx(pool, async (db) => {
    const team = await loadActiveTeam(db, teamId);
    const { rows: member } = await db.query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, user.id]);
    if (!member.length && !isAdmin(user)) throw forbidden('NOT_A_TEAM_MEMBER');
    const { rows: ms } = await db.query('SELECT * FROM milestones WHERE id = $1 AND hackathon_id = $2', [milestoneId, team.hackathon_id]);
    if (!ms[0]) throw notFound('MILESTONE_NOT_FOUND');
    if (done) {
      await db.query(
        `INSERT INTO team_milestones (team_id, milestone_id, done_by, evidence_url) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, milestone_id) DO UPDATE SET evidence_url = EXCLUDED.evidence_url`,
        [team.id, milestoneId, user.id, evidenceUrl || ''],
      );
      const { rows: mentors } = await db.query('SELECT mentor_id FROM mentor_assignments WHERE team_id = $1', [team.id]);
      const { rows: h } = await db.query('SELECT slug FROM hackathons WHERE id = $1', [team.hackathon_id]);
      await notify(db, mentors.map((m) => m.mentor_id), {
        hackathonId: team.hackathon_id, kind: 'milestone.done', link: `h/${h[0].slug}/teams/${team.id}`,
        data: { teamName: team.name, titleEn: ms[0].title_en, titleAr: ms[0].title_ar },
      });
    } else {
      await db.query('DELETE FROM team_milestones WHERE team_id = $1 AND milestone_id = $2', [team.id, milestoneId]);
    }
    await audit(db, { actorId: user.id, hackathonId: team.hackathon_id, action: done ? 'milestone.done' : 'milestone.undone', entityType: 'team', entityId: team.id, details: { milestoneId } });
  });
}

// ------------------------------------------------------------------ statistics

// Headline numbers anyone who can see the hackathon may see.
async function stats(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM registrations WHERE hackathon_id = $1 AND status = 'active') AS participants,
       (SELECT count(*)::int FROM ideas WHERE hackathon_id = $1 AND status = 'submitted') AS ideas,
       (SELECT count(*)::int FROM teams WHERE hackathon_id = $1 AND status = 'active') AS teams,
       (SELECT count(*)::int FROM mentors WHERE hackathon_id = $1) AS mentors,
       (SELECT count(*)::int FROM tracks WHERE hackathon_id = $1) AS tracks,
       (SELECT COALESCE(sum(GREATEST($2 - c.n, 0)), 0)::int FROM (
          SELECT (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS n
            FROM teams t WHERE t.hackathon_id = $1 AND t.status = 'active' AND t.is_open) c) AS open_spots,
       (SELECT count(*)::int FROM registrations r WHERE r.hackathon_id = $1 AND r.status = 'active' AND r.role = 'member'
          AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.hackathon_id = $1 AND m.user_id = r.user_id)) AS looking_for_team`,
    [h.id, h.max_team_size],
  );
  return rows[0];
}

// Organiser dashboard: the funnel, tracks, reviews, mentoring and teams at risk.
async function dashboard(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const q = (sql, params = [h.id]) => pool.query(sql, params).then((r) => r.rows);
  const [funnel] = await q(
    `SELECT
       (SELECT count(*)::int FROM registrations WHERE hackathon_id = $1 AND status = 'active') AS registered,
       (SELECT count(*)::int FROM ideas WHERE hackathon_id = $1 AND status <> 'withdrawn') AS ideas_started,
       (SELECT count(*)::int FROM ideas WHERE hackathon_id = $1 AND status = 'submitted') AS ideas_submitted,
       (SELECT count(*)::int FROM teams WHERE hackathon_id = $1 AND status = 'active') AS teams,
       (SELECT count(*)::int FROM teams t WHERE t.hackathon_id = $1 AND t.status = 'active'
          AND (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) >= $2) AS teams_ready,
       (SELECT count(*)::int FROM (SELECT DISTINCT d.idea_id FROM round_decisions d JOIN review_rounds r ON r.id = d.round_id
          WHERE r.hackathon_id = $1 AND d.outcome = 'advance') x) AS advanced,
       (SELECT count(*)::int FROM registrations r WHERE r.hackathon_id = $1 AND r.status = 'active' AND r.role = 'member'
          AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.hackathon_id = $1 AND m.user_id = r.user_id)) AS looking_for_team`,
    [h.id, h.min_team_size],
  );
  const tracks = await q(
    `SELECT tr.id, tr.name_en, tr.name_ar,
            count(i.id) FILTER (WHERE i.status = 'submitted')::int AS ideas,
            count(t.id)::int AS teams
       FROM tracks tr
       LEFT JOIN ideas i ON i.track_id = tr.id
       LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
      WHERE tr.hackathon_id = $1 GROUP BY tr.id ORDER BY tr.sort_order`,
  );
  const rounds = await q(
    `SELECT r.id, r.name_en, r.name_ar, r.status, r.kind,
            (SELECT count(*)::int FROM round_reviewers v WHERE v.round_id = r.id) AS reviewers,
            (SELECT count(*)::int FROM evaluations e WHERE e.round_id = r.id AND e.status = 'submitted') AS evaluations,
            (SELECT count(*)::int FROM round_decisions d WHERE d.round_id = r.id) AS decided,
            (SELECT count(*)::int FROM round_decisions d WHERE d.round_id = r.id AND d.outcome = 'advance') AS advanced
       FROM review_rounds r WHERE r.hackathon_id = $1 ORDER BY r.sort_order, r.created_at`,
  );
  const [mentoring] = await q(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            count(*) FILTER (WHERE status = 'done')::int AS done
       FROM mentoring_requests WHERE hackathon_id = $1`,
  );
  const [activity] = await q(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS posts_24h,
            count(*) FILTER (WHERE kind = 'help' AND NOT resolved)::int AS open_help
       FROM progress_posts WHERE hackathon_id = $1`,
  );
  const teams = await q(
    `SELECT t.id, t.name, t.created_at,
            (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS members,
            (SELECT max(p.created_at) FROM progress_posts p WHERE p.team_id = t.id) AS last_post_at,
            (SELECT count(*)::int FROM team_milestones tm WHERE tm.team_id = t.id) AS milestones_done,
            (SELECT count(*)::int FROM milestones ms WHERE ms.hackathon_id = t.hackathon_id
               AND ms.due_at < now() AND NOT EXISTS (SELECT 1 FROM team_milestones tm WHERE tm.team_id = t.id AND tm.milestone_id = ms.id)) AS overdue,
            (SELECT count(*)::int FROM mentor_assignments a WHERE a.team_id = t.id) AS mentors
       FROM teams t WHERE t.hackathon_id = $1 AND t.status = 'active' ORDER BY t.name`,
  );
  const [{ n: milestonesTotal }] = await q('SELECT count(*)::int AS n FROM milestones WHERE hackathon_id = $1');
  const now = Date.now();
  const atRisk = [];
  for (const t of teams) {
    const reasons = [];
    if (t.members < h.min_team_size) reasons.push('understaffed');
    const last = new Date(t.last_post_at || t.created_at).getTime();
    if (now - last > 48 * 3600 * 1000) reasons.push('quiet');
    if (t.overdue > 0) reasons.push('behind');
    if (!t.mentors) reasons.push('no_mentor');
    if (reasons.length && !(reasons.length === 1 && reasons[0] === 'no_mentor')) atRisk.push({ ...t, reasons });
  }
  return { funnel, tracks, rounds, mentoring, activity, teams, milestonesTotal, atRisk, minTeamSize: h.min_team_size };
}

module.exports = {
  listNotifications, unreadCount, markRead, matches,
  listMilestones, createMilestone, applyMilestoneTemplate, updateMilestone, deleteMilestone,
  teamMilestones, setTeamMilestone, stats, dashboard, DEFAULT_MILESTONES,
};
