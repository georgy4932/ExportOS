import type { Pool } from 'pg'
import type {
  EvidenceItemType,
  EvidenceLifecycleState,
  EvidenceActorRole,
} from '../types'

export type SupersedeEvidenceError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_TRANSITION'; currentState: EvidenceLifecycleState; allowedFrom: EvidenceLifecycleState[] }
  | { code: 'DB_ERROR'; cause: unknown }

export interface SupersedeEvidenceData {
  id: string
  evidence_type: EvidenceItemType
  lifecycle_state: EvidenceLifecycleState
  validation_status: string
  updated_at: string
}

export interface SupersedeEvidenceResult {
  data: SupersedeEvidenceData | null
  error: SupersedeEvidenceError | null
}

export interface SupersedeEvidenceParams {
  nxpReference:  string
  evidenceType:  EvidenceItemType
  exporterId:    string
  actorUserId:   string
  actorRole:     EvidenceActorRole
  reason:        string
}

// RC4_API_DESIGN.md §5: supersede is allowed only from 'validated' — narrower
// than validate/reject, which also accept 'uploaded'.
const ALLOWED_FROM: EvidenceLifecycleState[] = ['validated']

// Transitions an evidence item to superseded and writes one supersede event row,
// all within a single BEGIN/COMMIT block. Not idempotent: a repeat call finds
// lifecycle_state = 'superseded', which is not in ALLOWED_FROM, and is rejected
// with 409 INVALID_TRANSITION — mirroring validateEvidence/rejectEvidence.
export async function supersedeEvidence(
  pool: Pool,
  params: SupersedeEvidenceParams,
): Promise<SupersedeEvidenceResult> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    // Resolve nxp_reference → shipment_id scoped by exporter
    const { rows: shipRows } = await pg.query<{ id: string }>(
      'SELECT id FROM shipments WHERE nxp_reference = $1 AND exporter_id = $2 LIMIT 1',
      [params.nxpReference, params.exporterId],
    )
    const shipmentId = shipRows[0]?.id
    if (!shipmentId) {
      await pg.query('ROLLBACK')
      return { data: null, error: { code: 'NOT_FOUND' } }
    }

    // Lock the evidence_items row to prevent concurrent transitions
    const { rows: evRows } = await pg.query<{
      id: string
      lifecycle_state: EvidenceLifecycleState
      validation_status: string
    }>(
      `SELECT id, lifecycle_state, validation_status
         FROM evidence_items
        WHERE shipment_id = $1 AND exporter_id = $2 AND evidence_type = $3
        FOR UPDATE`,
      [shipmentId, params.exporterId, params.evidenceType],
    )
    const existing = evRows[0]
    if (!existing) {
      await pg.query('ROLLBACK')
      return { data: null, error: { code: 'NOT_FOUND' } }
    }

    if (!ALLOWED_FROM.includes(existing.lifecycle_state)) {
      await pg.query('ROLLBACK')
      return {
        data:  null,
        error: { code: 'INVALID_TRANSITION', currentState: existing.lifecycle_state, allowedFrom: ALLOWED_FROM },
      }
    }

    // Transition: validated → superseded
    const { rows: updRows } = await pg.query<SupersedeEvidenceData>(
      `UPDATE evidence_items
          SET lifecycle_state   = 'superseded',
              validation_status = 'not_applicable',
              updated_at        = NOW()
        WHERE id = $1
      RETURNING id, evidence_type, lifecycle_state, validation_status, updated_at`,
      [existing.id],
    )
    const updated = updRows[0]!

    // Append immutable audit event
    await pg.query(
      `INSERT INTO evidence_events (
          evidence_item_id, shipment_id, exporter_id, nxp_reference, evidence_type,
          previous_lifecycle_state, new_lifecycle_state,
          previous_validation_status, new_validation_status,
          actor_user_id, actor_role, event_type, reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        existing.id,
        shipmentId,
        params.exporterId,
        params.nxpReference,
        params.evidenceType,
        existing.lifecycle_state,
        'superseded',
        existing.validation_status,
        'not_applicable',
        params.actorUserId,
        params.actorRole,
        'supersede',
        params.reason,
      ],
    )

    await pg.query('COMMIT')
    return { data: updated, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: { code: 'DB_ERROR', cause: err } }
  } finally {
    pg.release()
  }
}
