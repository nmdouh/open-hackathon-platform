'use strict';

// Writes one audit entry using the caller's client, so the entry commits or
// rolls back together with the change it describes.
async function audit(db, { actorId, hackathonId = null, action, entityType, entityId = null, details = {} }) {
  await db.query(
    `INSERT INTO audit_log (actor_id, hackathon_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId || null, hackathonId, action, entityType, entityId === null ? null : String(entityId), details],
  );
}

module.exports = { audit };
