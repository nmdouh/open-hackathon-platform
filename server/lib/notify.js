'use strict';

// Queues in-app notifications inside the caller's transaction, so a
// notification exists exactly when the change it announces was committed.
async function notify(db, userIds, { hackathonId = null, kind, data = {}, link = '' }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return;
  await db.query(
    `INSERT INTO notifications (user_id, hackathon_id, kind, data, link)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5`,
    [ids, hackathonId, kind, data, link],
  );
}

// Everyone actively registered in a hackathon, plus its mentors.
async function hackathonAudience(db, hackathonId) {
  const { rows } = await db.query(
    `SELECT user_id FROM registrations WHERE hackathon_id = $1 AND status = 'active'
     UNION SELECT user_id FROM mentors WHERE hackathon_id = $1`,
    [hackathonId],
  );
  return rows.map((r) => r.user_id);
}

async function teamMemberIds(db, teamId) {
  const { rows } = await db.query('SELECT user_id FROM team_members WHERE team_id = $1', [teamId]);
  return rows.map((r) => r.user_id);
}

module.exports = { notify, hackathonAudience, teamMemberIds };
