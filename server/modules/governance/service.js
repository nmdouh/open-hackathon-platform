'use strict';

const { tx } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { notify, hackathonAudience } = require('../../lib/notify');
const { HttpError, badRequest, forbidden, notFound, conflict, fromPg } = require('../../lib/errors');
const { isAdmin } = require('../../auth/sessions');
const { loadHackathon } = require('../hackathons/service');
const { lockParticipant } = require('../participation/service');
const { TEMPLATES } = require('./templates');
const { weightedTotal, validateScores, aggregate, suggest } = require('./scoring');

const run = (pool, fn) => tx(pool, fn).catch((e) => { throw fromPg(e); });

// ------------------------------------------------------------------ loading and access

// lock: false, true (FOR UPDATE) or 'share' (FOR SHARE, lets many reviewers
// save at once while stopping the round from changing state underneath them).
async function loadRound(db, roundId, { lock = false } = {}) {
  const clause = lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : '';
  const { rows } = await db.query(`SELECT * FROM review_rounds WHERE id = $1${clause}`, [roundId]);
  if (!rows[0]) throw notFound('ROUND_NOT_FOUND');
  return rows[0];
}

async function access(db, user, round) {
  const { rows } = await db.query('SELECT is_chair FROM round_reviewers WHERE round_id = $1 AND user_id = $2', [round.id, user.id]);
  const admin = isAdmin(user);
  const reviewer = rows.length > 0;
  return { admin, reviewer, chair: reviewer && rows[0].is_chair, canDecide: admin || (reviewer && rows[0].is_chair) };
}

function assertStatus(round, allowed, code = 'ROUND_STATE') {
  if (!allowed.includes(round.status)) throw conflict(code, `Round is ${round.status}`);
}

async function criteriaOf(db, roundId) {
  const { rows } = await db.query('SELECT * FROM round_criteria WHERE round_id = $1 ORDER BY sort_order, name_en', [roundId]);
  return rows;
}

// The ideas a round evaluates: those advanced by the source round, or every
// submitted idea when the round has no source.
async function candidateIds(db, round) {
  if (round.source_round_id) {
    const { rows } = await db.query(
      `SELECT d.idea_id FROM round_decisions d JOIN ideas i ON i.id = d.idea_id
        WHERE d.round_id = $1 AND d.outcome = 'advance' AND i.status = 'submitted'`,
      [round.source_round_id],
    );
    return rows.map((r) => r.idea_id);
  }
  const { rows } = await db.query(
    "SELECT id FROM ideas WHERE hackathon_id = $1 AND status = 'submitted' ORDER BY submitted_at",
    [round.hackathon_id],
  );
  return rows.map((r) => r.id);
}

// Why a reviewer may not evaluate an idea, or null. Covers owning the idea,
// being on its team, and mentoring its team.
async function automaticConflict(db, ideaId, reviewerId) {
  const { rows } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM ideas WHERE id = $1 AND owner_id = $2) AS owner,
       EXISTS (SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
                WHERE t.idea_id = $1 AND t.status = 'active' AND m.user_id = $2) AS member,
       EXISTS (SELECT 1 FROM teams t JOIN mentor_assignments a ON a.team_id = t.id
                WHERE t.idea_id = $1 AND t.status = 'active' AND a.mentor_id = $2) AS mentor`,
    [ideaId, reviewerId],
  );
  const r = rows[0];
  if (r.owner) return 'owns_idea';
  if (r.member) return 'team_member';
  if (r.mentor) return 'mentors_team';
  return null;
}

// ------------------------------------------------------------------ round administration (admins)

async function createRound(pool, user, hackathonRef, b) {
  return run(pool, async (db) => {
    const h = await loadHackathon(db, hackathonRef, user);
    if (b.sourceRoundId) {
      const src = await loadRound(db, b.sourceRoundId);
      if (src.hackathon_id !== h.id) throw badRequest('SOURCE_ROUND_OTHER_HACKATHON');
    }
    const { rows } = await db.query(
      `INSERT INTO review_rounds (hackathon_id, kind, name_en, name_ar, source_round_id, assignment_mode,
                                  min_reviewers, advance_count, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [h.id, b.kind, b.nameEn, b.nameAr, b.sourceRoundId || null, b.assignmentMode, b.minReviewers,
        b.advanceCount ?? null, b.sortOrder],
    );
    const round = rows[0];
    const template = b.useTemplate ? TEMPLATES[b.kind] : [];
    for (const [i, c] of template.entries()) {
      await db.query(
        `INSERT INTO round_criteria (round_id, name_en, name_ar, description_en, description_ar, weight, min_score, max_score, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [round.id, c.nameEn, c.nameAr, c.descriptionEn, c.descriptionAr, c.weight, c.minScore ?? 1, c.maxScore ?? 5, i],
      );
    }
    await audit(db, { actorId: user.id, hackathonId: h.id, action: 'round.created', entityType: 'round', entityId: round.id, details: { kind: b.kind, template: Boolean(b.useTemplate) } });
    return round;
  });
}

const ROUND_FIELDS = {
  nameEn: 'name_en', nameAr: 'name_ar', assignmentMode: 'assignment_mode', minReviewers: 'min_reviewers',
  advanceCount: 'advance_count', sortOrder: 'sort_order', sourceRoundId: 'source_round_id',
};
// Fields that change who or what is evaluated are frozen once a round opens.
const STRUCTURAL = new Set(['assignmentMode', 'sourceRoundId']);

async function updateRound(pool, user, roundId, b) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft', 'open', 'closed']);
    const sets = [];
    const vals = [];
    for (const [api, col] of Object.entries(ROUND_FIELDS)) {
      if (b[api] === undefined) continue;
      if (STRUCTURAL.has(api) && round.status !== 'draft') throw conflict('ROUND_NOT_DRAFT');
      if (api === 'sourceRoundId' && b[api]) {
        const src = await loadRound(db, b[api]);
        if (src.hackathon_id !== round.hackathon_id || src.id === round.id) throw badRequest('BAD_SOURCE_ROUND');
      }
      vals.push(b[api]);
      sets.push(`${col} = $${vals.length + 1}`);
    }
    if (!sets.length) return round;
    const { rows } = await db.query(`UPDATE review_rounds SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [round.id, ...vals]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.updated', entityType: 'round', entityId: round.id, details: b });
    return rows[0];
  });
}

async function deleteRound(pool, user, roundId) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft'], 'ROUND_NOT_DRAFT');
    const { rows } = await db.query('SELECT 1 FROM review_rounds WHERE source_round_id = $1 LIMIT 1', [round.id]);
    if (rows.length) throw conflict('ROUND_IS_A_SOURCE');
    await db.query('DELETE FROM review_rounds WHERE id = $1', [round.id]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.deleted', entityType: 'round', entityId: round.id });
  });
}

async function addCriterion(pool, user, roundId, c) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft'], 'ROUND_NOT_DRAFT');
    const { rows } = await db.query(
      `INSERT INTO round_criteria (round_id, name_en, name_ar, description_en, description_ar, weight, min_score, max_score, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [round.id, c.nameEn, c.nameAr, c.descriptionEn, c.descriptionAr, c.weight, c.minScore, c.maxScore, c.sortOrder],
    );
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'criterion.created', entityType: 'round', entityId: round.id, details: { criterionId: rows[0].id } });
    return rows[0];
  });
}

async function updateCriterion(pool, user, criterionId, c) {
  return run(pool, async (db) => {
    const { rows: pre } = await db.query('SELECT round_id FROM round_criteria WHERE id = $1', [criterionId]);
    if (!pre[0]) throw notFound('CRITERION_NOT_FOUND');
    const round = await loadRound(db, pre[0].round_id, { lock: true });
    assertStatus(round, ['draft'], 'ROUND_NOT_DRAFT');
    const map = {
      nameEn: 'name_en', nameAr: 'name_ar', descriptionEn: 'description_en', descriptionAr: 'description_ar',
      weight: 'weight', minScore: 'min_score', maxScore: 'max_score', sortOrder: 'sort_order',
    };
    const sets = [];
    const vals = [];
    for (const [api, col] of Object.entries(map)) {
      if (c[api] === undefined) continue;
      vals.push(c[api]);
      sets.push(`${col} = $${vals.length + 1}`);
    }
    if (!sets.length) throw badRequest('NOTHING_TO_UPDATE');
    const { rows } = await db.query(`UPDATE round_criteria SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [criterionId, ...vals]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'criterion.updated', entityType: 'round', entityId: round.id, details: { criterionId } });
    return rows[0];
  });
}

async function deleteCriterion(pool, user, criterionId) {
  return run(pool, async (db) => {
    const { rows: pre } = await db.query('SELECT round_id FROM round_criteria WHERE id = $1', [criterionId]);
    if (!pre[0]) throw notFound('CRITERION_NOT_FOUND');
    const round = await loadRound(db, pre[0].round_id, { lock: true });
    assertStatus(round, ['draft'], 'ROUND_NOT_DRAFT');
    await db.query('DELETE FROM round_criteria WHERE id = $1', [criterionId]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'criterion.deleted', entityType: 'round', entityId: round.id, details: { criterionId } });
  });
}

async function addReviewer(pool, user, roundId, { userId, email, isChair }) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft', 'open', 'closed']);
    const { rows: found } = await db.query(
      'SELECT id FROM users WHERE is_active AND (id = $1 OR lower(email) = lower($2))',
      [userId || null, email || ''],
    );
    if (!found[0]) throw notFound('USER_NOT_FOUND');
    const reviewerId = found[0].id;
    await lockParticipant(db, round.hackathon_id, reviewerId);
    const { rows: reg } = await db.query(
      "SELECT 1 FROM registrations WHERE hackathon_id = $1 AND user_id = $2 AND status = 'active'",
      [round.hackathon_id, reviewerId],
    );
    if (reg.length) throw conflict('REVIEWER_IS_PARTICIPANT', 'Participants cannot review in their own hackathon');
    if (isChair) await db.query('UPDATE round_reviewers SET is_chair = false WHERE round_id = $1', [round.id]);
    await db.query(
      `INSERT INTO round_reviewers (round_id, user_id, is_chair) VALUES ($1, $2, $3)
       ON CONFLICT (round_id, user_id) DO UPDATE SET is_chair = EXCLUDED.is_chair`,
      [round.id, reviewerId, Boolean(isChair)],
    );
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.reviewer_added', entityType: 'round', entityId: round.id, details: { reviewerId, isChair: Boolean(isChair) } });
    return { userId: reviewerId, isChair: Boolean(isChair) };
  });
}

async function removeReviewer(pool, user, roundId, reviewerId) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft', 'open', 'closed']);
    const { rows } = await db.query(
      "SELECT 1 FROM evaluations WHERE round_id = $1 AND reviewer_id = $2 AND status = 'submitted' LIMIT 1",
      [round.id, reviewerId],
    );
    // Submitted votes are part of the record; keep the reviewer so they stay attributable.
    if (rows.length) throw conflict('REVIEWER_HAS_SUBMITTED');
    const { rowCount } = await db.query('DELETE FROM round_reviewers WHERE round_id = $1 AND user_id = $2', [round.id, reviewerId]);
    if (!rowCount) throw notFound('REVIEWER_NOT_FOUND');
    await db.query('DELETE FROM evaluations WHERE round_id = $1 AND reviewer_id = $2', [round.id, reviewerId]);
    await db.query('DELETE FROM round_assignments WHERE round_id = $1 AND reviewer_id = $2', [round.id, reviewerId]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.reviewer_removed', entityType: 'round', entityId: round.id, details: { reviewerId } });
  });
}

// Replaces the reviewer list of one idea (assignment mode "assigned").
async function setAssignments(pool, user, roundId, ideaId, reviewerIds) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['draft', 'open']);
    if (round.assignment_mode !== 'assigned') throw conflict('ROUND_NOT_ASSIGNED_MODE');
    if (round.status === 'open' && !(await candidateIds(db, round)).includes(ideaId)) throw badRequest('NOT_A_CANDIDATE');
    const { rows: members } = await db.query('SELECT user_id FROM round_reviewers WHERE round_id = $1', [round.id]);
    const committee = new Set(members.map((m) => m.user_id));
    for (const id of reviewerIds) {
      if (!committee.has(id)) throw badRequest('NOT_A_REVIEWER');
      const why = await automaticConflict(db, ideaId, id);
      if (why) throw conflict('CONFLICT_OF_INTEREST', why);
    }
    await db.query('DELETE FROM round_assignments WHERE round_id = $1 AND idea_id = $2', [round.id, ideaId]);
    for (const id of reviewerIds) {
      await db.query('INSERT INTO round_assignments (round_id, idea_id, reviewer_id) VALUES ($1, $2, $3)', [round.id, ideaId, id]);
    }
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.assignments_set', entityType: 'round', entityId: round.id, details: { ideaId, reviewerIds } });
  });
}

// draft -> open -> closed -> finalized, with closed -> open allowed for corrections.
async function transition(pool, user, roundId, action) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    let next;
    if (action === 'open') {
      assertStatus(round, ['draft', 'closed']);
      if (round.status === 'draft') {
        if (!(await criteriaOf(db, round.id)).length) throw conflict('ROUND_HAS_NO_CRITERIA');
        const { rows } = await db.query('SELECT count(*)::int AS n FROM round_reviewers WHERE round_id = $1', [round.id]);
        if (!rows[0].n) throw conflict('ROUND_HAS_NO_REVIEWERS');
        if (round.source_round_id) {
          const src = await loadRound(db, round.source_round_id);
          if (src.status !== 'finalized') throw conflict('SOURCE_ROUND_NOT_FINALIZED');
        }
      }
      next = 'open';
    } else if (action === 'close') {
      assertStatus(round, ['open']);
      next = 'closed';
    } else {
      throw badRequest('UNKNOWN_TRANSITION');
    }
    const stamp = next === 'open' ? 'opened_at' : 'closed_at';
    const { rows } = await db.query(`UPDATE review_rounds SET status = $2, ${stamp} = now() WHERE id = $1 RETURNING *`, [round.id, next]);
    const name = next === 'closed' ? 'round.closed' : round.status === 'closed' ? 'round.reopened' : 'round.opened';
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: name, entityType: 'round', entityId: round.id });
    if (next === 'open') {
      const { rows: rv } = await db.query('SELECT user_id FROM round_reviewers WHERE round_id = $1', [round.id]);
      const { rows: hs } = await db.query('SELECT slug FROM hackathons WHERE id = $1', [round.hackathon_id]);
      await notify(db, rv.map((x) => x.user_id), {
        hackathonId: round.hackathon_id, kind: 'round.opened', link: `h/${hs[0].slug}/reviews/${round.id}`,
        data: { nameEn: round.name_en, nameAr: round.name_ar },
      });
    }
    return rows[0];
  });
}

async function publishResults(pool, user, roundId, published) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    assertStatus(round, ['finalized'], 'ROUND_NOT_FINALIZED');
    const { rows } = await db.query('UPDATE review_rounds SET results_published = $2 WHERE id = $1 RETURNING *', [round.id, published]);
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: published ? 'round.results_published' : 'round.results_unpublished', entityType: 'round', entityId: round.id });
    if (published && !round.results_published) {
      const { rows: hs } = await db.query('SELECT slug FROM hackathons WHERE id = $1', [round.hackathon_id]);
      await notify(db, await hackathonAudience(db, round.hackathon_id), {
        hackathonId: round.hackathon_id, kind: 'results.published', link: `h/${hs[0].slug}`,
        data: { nameEn: round.name_en, nameAr: round.name_ar },
      });
    }
    return rows[0];
  });
}

// ------------------------------------------------------------------ reading rounds

async function listRounds(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT count(*)::int FROM round_criteria c WHERE c.round_id = r.id) AS criteria_count,
            (SELECT count(*)::int FROM round_reviewers v WHERE v.round_id = r.id) AS reviewer_count,
            EXISTS (SELECT 1 FROM round_reviewers v WHERE v.round_id = r.id AND v.user_id = $2) AS i_review,
            EXISTS (SELECT 1 FROM round_reviewers v WHERE v.round_id = r.id AND v.user_id = $2 AND v.is_chair) AS i_chair
       FROM review_rounds r WHERE r.hackathon_id = $1 ORDER BY r.sort_order, r.created_at`,
    [h.id, user.id],
  );
  return isAdmin(user) ? rows : rows.filter((r) => r.i_review);
}

async function getRound(pool, user, roundId) {
  const round = await loadRound(pool, roundId);
  const a = await access(pool, user, round);
  if (!a.admin && !a.reviewer) throw notFound('ROUND_NOT_FOUND');
  const criteria = await criteriaOf(pool, round.id);
  const { rows: reviewers } = await pool.query(
    `SELECT v.user_id, v.is_chair, u.display_name, ${a.admin ? 'u.email,' : ''}
            (SELECT count(*)::int FROM evaluations e WHERE e.round_id = v.round_id AND e.reviewer_id = v.user_id AND e.status = 'submitted') AS submitted
       FROM round_reviewers v JOIN users u ON u.id = v.user_id WHERE v.round_id = $1 ORDER BY v.is_chair DESC, u.display_name`,
    [round.id],
  );
  return { round, criteria, reviewers, access: a };
}

// What one reviewer should evaluate, with their own progress.
async function myCandidates(pool, user, roundId) {
  const round = await loadRound(pool, roundId);
  const a = await access(pool, user, round);
  if (!a.reviewer) throw forbidden('NOT_A_REVIEWER');
  let ids = await candidateIds(pool, round);
  if (round.assignment_mode === 'assigned') {
    const { rows } = await pool.query('SELECT idea_id FROM round_assignments WHERE round_id = $1 AND reviewer_id = $2', [round.id, user.id]);
    const mine = new Set(rows.map((r) => r.idea_id));
    ids = ids.filter((id) => mine.has(id));
  }
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.problem, t.id AS team_id, t.name AS team_name,
            tr.name_en AS track_name_en, tr.name_ar AS track_name_ar,
            e.status AS my_status, e.total AS my_total, e.conflict AS my_conflict
       FROM ideas i
       LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
       LEFT JOIN tracks tr ON tr.id = i.track_id
       LEFT JOIN evaluations e ON e.round_id = $2 AND e.idea_id = i.id AND e.reviewer_id = $3
      WHERE i.id = ANY($1::uuid[])
      ORDER BY i.title`,
    [ids, round.id, user.id],
  );
  for (const r of rows) r.auto_conflict = await automaticConflict(pool, r.id, user.id);
  return rows;
}

async function assertCanEvaluate(db, user, round, ideaId) {
  const a = await access(db, user, round);
  if (!a.reviewer) throw forbidden('NOT_A_REVIEWER');
  if (!(await candidateIds(db, round)).includes(ideaId)) throw notFound('NOT_A_CANDIDATE');
  if (round.assignment_mode === 'assigned') {
    const { rows } = await db.query(
      'SELECT 1 FROM round_assignments WHERE round_id = $1 AND idea_id = $2 AND reviewer_id = $3',
      [round.id, ideaId, user.id],
    );
    if (!rows.length) throw forbidden('NOT_ASSIGNED');
  }
  return a;
}

// The full submission as the reviewer sees it, plus their own evaluation.
async function candidateDetail(pool, user, roundId, ideaId) {
  const round = await loadRound(pool, roundId);
  const a = await access(pool, user, round);
  if (!a.admin) await assertCanEvaluate(pool, user, round, ideaId);
  const { rows } = await pool.query(
    `SELECT i.*, u.display_name AS owner_name, tr.name_en AS track_name_en, tr.name_ar AS track_name_ar,
            t.id AS team_id, t.name AS team_name
       FROM ideas i JOIN users u ON u.id = i.owner_id
       LEFT JOIN tracks tr ON tr.id = i.track_id
       LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
      WHERE i.id = $1`,
    [ideaId],
  );
  if (!rows[0]) throw notFound('IDEA_NOT_FOUND');
  const { rows: members } = rows[0].team_id
    ? await pool.query(
      `SELECT u.display_name, m.role FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1 ORDER BY m.role DESC, m.joined_at`, [rows[0].team_id])
    : { rows: [] };
  const { rows: mine } = await pool.query(
    'SELECT * FROM evaluations WHERE round_id = $1 AND idea_id = $2 AND reviewer_id = $3',
    [round.id, ideaId, user.id],
  );
  return {
    round, idea: rows[0], members, criteria: await criteriaOf(pool, round.id),
    evaluation: mine[0] || null, autoConflict: a.reviewer ? await automaticConflict(pool, ideaId, user.id) : null,
  };
}

// ------------------------------------------------------------------ evaluating

async function saveEvaluation(pool, user, roundId, ideaId, b) {
  return run(pool, async (db) => {
    const fresh = await loadRound(db, roundId, { lock: 'share' });
    assertStatus(fresh, ['open'], 'ROUND_NOT_OPEN');
    await assertCanEvaluate(db, user, fresh, ideaId);
    const why = await automaticConflict(db, ideaId, user.id);
    if (why) throw conflict('CONFLICT_OF_INTEREST', why);

    const criteria = await criteriaOf(db, fresh.id);
    let scores = b.scores || {};
    let total = null;
    let status = b.submit ? 'submitted' : 'draft';
    if (b.conflict) {
      // A declared conflict is final for this reviewer and excluded from results.
      scores = {};
      status = 'submitted';
      if (!String(b.conflictReason || '').trim()) throw badRequest('CONFLICT_REASON_REQUIRED');
    } else {
      const problem = validateScores(criteria, scores);
      if (b.submit && problem) throw badRequest('SCORES_INVALID', 'Every criterion needs a score in range', problem);
      if (!b.submit && problem && problem.problem !== 'missing') throw badRequest('SCORES_INVALID', 'Score out of range', problem);
      if (fresh.kind === 'screening' && b.submit && !b.recommendation) throw badRequest('RECOMMENDATION_REQUIRED');
      total = problem ? null : weightedTotal(criteria, scores);
    }
    const { rows: prev } = await db.query(
      'SELECT * FROM evaluations WHERE round_id = $1 AND idea_id = $2 AND reviewer_id = $3 FOR UPDATE',
      [fresh.id, ideaId, user.id],
    );
    if (prev[0] && prev[0].conflict) throw conflict('CONFLICT_ALREADY_DECLARED');
    if (prev[0] && prev[0].status === 'submitted' && !b.submit && !b.conflict) throw conflict('ALREADY_SUBMITTED');
    const { rows } = await db.query(
      `INSERT INTO evaluations (round_id, idea_id, reviewer_id, status, scores, comment, recommendation,
                               conflict, conflict_reason, total, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $4 = 'submitted' THEN now() END)
       ON CONFLICT (round_id, idea_id, reviewer_id) DO UPDATE SET
         status = EXCLUDED.status, scores = EXCLUDED.scores, comment = EXCLUDED.comment,
         recommendation = EXCLUDED.recommendation, conflict = EXCLUDED.conflict,
         conflict_reason = EXCLUDED.conflict_reason, total = EXCLUDED.total,
         submitted_at = COALESCE(EXCLUDED.submitted_at, evaluations.submitted_at), updated_at = now()
       RETURNING *`,
      [fresh.id, ideaId, user.id, status, scores, b.comment || '', b.conflict ? null : (b.recommendation || null),
        Boolean(b.conflict), b.conflict ? b.conflictReason : '', total],
    );
    if (status === 'submitted') {
      await audit(db, {
        actorId: user.id, hackathonId: fresh.hackathon_id,
        action: b.conflict ? 'evaluation.conflict_declared' : (prev[0] && prev[0].status === 'submitted' ? 'evaluation.resubmitted' : 'evaluation.submitted'),
        entityType: 'evaluation', entityId: rows[0].id, details: { roundId: fresh.id, ideaId, total },
      });
    }
    return rows[0];
  });
}

// ------------------------------------------------------------------ board, decisions, finalisation

async function computeBoard(db, round) {
  const ids = await candidateIds(db, round);
  if (!ids.length) return [];
  const { rows: ideas } = await db.query(
    `SELECT i.id, i.title, t.id AS team_id, t.name AS team_name, tr.name_en AS track_name_en, tr.name_ar AS track_name_ar
       FROM ideas i LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
       LEFT JOIN tracks tr ON tr.id = i.track_id
      WHERE i.id = ANY($1::uuid[])`,
    [ids],
  );
  const { rows: evals } = await db.query('SELECT * FROM evaluations WHERE round_id = $1', [round.id]);
  const { rows: decisions } = await db.query('SELECT * FROM round_decisions WHERE round_id = $1', [round.id]);
  const byIdea = new Map(ids.map((id) => [id, []]));
  for (const e of evals) if (byIdea.has(e.idea_id)) byIdea.get(e.idea_id).push(e);
  const decided = new Map(decisions.map((d) => [d.idea_id, d]));
  const candidates = ideas.map((i) => ({
    id: i.id, idea: i, aggregate: aggregate(byIdea.get(i.id), round.min_reviewers), decision: decided.get(i.id) || null,
  }));
  return suggest(candidates, { advanceCount: round.advance_count })
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.idea.title.localeCompare(b.idea.title));
}

async function board(pool, user, roundId) {
  const round = await loadRound(pool, roundId);
  const a = await access(pool, user, round);
  if (!a.canDecide) throw forbidden('CHAIR_OR_ADMIN_ONLY');
  return { round, rows: await computeBoard(pool, round) };
}

// Every individual evaluation of one candidate, for the chair and admins.
async function candidateEvaluations(pool, user, roundId, ideaId) {
  const round = await loadRound(pool, roundId);
  const a = await access(pool, user, round);
  if (!a.canDecide) throw forbidden('CHAIR_OR_ADMIN_ONLY');
  const { rows } = await pool.query(
    `SELECT e.*, u.display_name AS reviewer_name FROM evaluations e JOIN users u ON u.id = e.reviewer_id
      WHERE e.round_id = $1 AND e.idea_id = $2 ORDER BY e.submitted_at NULLS LAST`,
    [round.id, ideaId],
  );
  return { criteria: await criteriaOf(pool, round.id), evaluations: rows };
}

// Records (or replaces) the decision on one candidate. A decision that differs
// from the computed suggestion, or that is taken without enough votes, is an
// override and must carry a written reason.
async function decideOne(db, user, round, row, outcome, note) {
  const isOverride = row.suggestion !== outcome;
  if (isOverride && !String(note || '').trim()) throw badRequest('NOTE_REQUIRED_FOR_OVERRIDE', null, { ideaId: row.id, suggestion: row.suggestion });
  await db.query(
    `INSERT INTO round_decisions (round_id, idea_id, outcome, rank, score, reviewer_count, is_override, note, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (round_id, idea_id) DO UPDATE SET outcome = EXCLUDED.outcome, rank = EXCLUDED.rank,
       score = EXCLUDED.score, reviewer_count = EXCLUDED.reviewer_count, is_override = EXCLUDED.is_override,
       note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
    [round.id, row.id, outcome, row.rank, row.aggregate.score, row.aggregate.reviewerCount, isOverride, note || '', user.id],
  );
  await audit(db, {
    actorId: user.id, hackathonId: round.hackathon_id, action: isOverride ? 'decision.override' : 'decision.recorded',
    entityType: 'idea', entityId: row.id,
    details: { roundId: round.id, outcome, suggestion: row.suggestion, score: row.aggregate.score, reviewers: row.aggregate.reviewerCount, note: note || '' },
  });
}

async function decide(pool, user, roundId, ideaId, { outcome, note }) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    const a = await access(db, user, round);
    if (!a.canDecide) throw forbidden('CHAIR_OR_ADMIN_ONLY');
    assertStatus(round, ['open', 'closed']);
    const row = (await computeBoard(db, round)).find((r) => r.id === ideaId);
    if (!row) throw notFound('NOT_A_CANDIDATE');
    await decideOne(db, user, round, row, outcome, note);
    return { ideaId, outcome, suggestion: row.suggestion, isOverride: row.suggestion !== outcome };
  });
}

// Locks the round. Every candidate needs a decision; with applySuggestions the
// undecided ones take their suggestion (only possible where one exists).
async function finalize(pool, user, roundId, { applySuggestions }) {
  return run(pool, async (db) => {
    const round = await loadRound(db, roundId, { lock: true });
    const a = await access(db, user, round);
    if (!a.canDecide) throw forbidden('CHAIR_OR_ADMIN_ONLY');
    assertStatus(round, ['closed'], 'CLOSE_ROUND_FIRST');
    const rows = await computeBoard(db, round);
    const undecided = rows.filter((r) => !r.decision);
    if (undecided.length && !applySuggestions) throw conflict('UNDECIDED_CANDIDATES', undecided.map((r) => r.id).join(','));
    const stuck = undecided.filter((r) => !r.suggestion);
    if (stuck.length) throw new HttpError(409, 'NO_SUGGESTION_FOR_SOME', 'Decide these candidates explicitly', stuck.map((r) => r.id));
    for (const r of undecided) await decideOne(db, user, round, r, r.suggestion, '');
    const { rows: upd } = await db.query(
      "UPDATE review_rounds SET status = 'finalized', finalized_at = now(), finalized_by = $2 WHERE id = $1 RETURNING *",
      [round.id, user.id],
    );
    const { rows: tally } = await db.query(
      'SELECT outcome, count(*)::int AS n FROM round_decisions WHERE round_id = $1 GROUP BY outcome', [round.id],
    );
    await audit(db, { actorId: user.id, hackathonId: round.hackathon_id, action: 'round.finalized', entityType: 'round', entityId: round.id, details: { tally } });
    return upd[0];
  });
}

// ------------------------------------------------------------------ results for participants

async function results(pool, user, hackathonRef) {
  const h = await loadHackathon(pool, hackathonRef, user);
  const { rows: rounds } = await pool.query(
    "SELECT id, kind, name_en, name_ar, finalized_at FROM review_rounds WHERE hackathon_id = $1 AND status = 'finalized' AND results_published ORDER BY sort_order, created_at",
    [h.id],
  );
  const out = [];
  for (const r of rounds) {
    // Only advancing ideas are listed publicly; others learn their own outcome.
    const { rows: advanced } = await pool.query(
      `SELECT d.idea_id, d.rank, i.title, t.name AS team_name
         FROM round_decisions d JOIN ideas i ON i.id = d.idea_id
         LEFT JOIN teams t ON t.idea_id = i.id AND t.status = 'active'
        WHERE d.round_id = $1 AND d.outcome = 'advance' ORDER BY d.rank NULLS LAST, i.title`,
      [r.id],
    );
    const { rows: mine } = await pool.query(
      `SELECT d.outcome FROM round_decisions d JOIN ideas i ON i.id = d.idea_id
        WHERE d.round_id = $1 AND (i.owner_id = $2 OR EXISTS (
          SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
           WHERE t.idea_id = i.id AND t.status = 'active' AND m.user_id = $2))`,
      [r.id, user.id],
    );
    out.push({ ...r, advanced, myOutcome: mine[0] ? mine[0].outcome : null });
  }
  return out;
}

module.exports = {
  createRound, updateRound, deleteRound, addCriterion, updateCriterion, deleteCriterion,
  addReviewer, removeReviewer, setAssignments, transition, publishResults,
  listRounds, getRound, myCandidates, candidateDetail, saveEvaluation,
  board, candidateEvaluations, decide, finalize, results, automaticConflict, TEMPLATES,
};
