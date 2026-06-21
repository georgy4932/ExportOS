import type { Pool, PoolClient } from 'pg'
import type { AuditEventRow } from '../types'

export interface ListAuditEventsOptions {
  entityType?: string
  entityId?: string
}

// Called within an open transaction (PoolClient). Writes one audit event row.
// exporter_id and actor_user_id must already be server-derived by the caller.
export async function insertAuditEvent(
  pg: PoolClient,
  params: {
    exporterId: string
    actorUserId: string
    entityType: string
    entityId: string
    action: string
    eventData: unknown
  },
): Promise<void> {
  await pg.query(
    `INSERT INTO audit_events
       (exporter_id, actor_user_id, entity_type, entity_id, action, event_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.exporterId,
      params.actorUserId,
      params.entityType,
      params.entityId,
      params.action,
      JSON.stringify(params.eventData),
    ],
  )
}

export async function listAuditEvents(
  pool: Pool,
  exporterId: string,
  options: ListAuditEventsOptions = {},
): Promise<{ data: AuditEventRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = [exporterId]
    const wheres: string[] = ['exporter_id = $1']
    if (options.entityType) { params.push(options.entityType); wheres.push(`entity_type = $${params.length}`) }
    if (options.entityId)   { params.push(options.entityId);   wheres.push(`entity_id = $${params.length}`) }
    const where = `WHERE ${wheres.join(' AND ')}`
    const { rows } = await pool.query<AuditEventRow>(
      `SELECT * FROM audit_events ${where} ORDER BY created_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
