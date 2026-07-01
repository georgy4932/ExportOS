import type { Pool } from 'pg'
import type {
  EvidenceItemType,
  EvidenceLifecycleState,
  EvidenceActorRole,
} from '../types'

export type SubmitReviewError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_TRANSITION'; currentState: EvidenceLifecycleState; allowedFrom: EvidenceLifecycleState[] }
  | { code: 'DB_ERROR'; cause: unknown }

export interface SubmitReviewData {
  id: string
  evidence_type: EvidenceItemType
  lifecycle_state: EvidenceLifecycleState
  validation_status: string
  updated_at: string
}

export interface SubmitReviewResult {
  data: SubmitReviewData | null
  error: SubmitReviewError | null
}

export interface SubmitReviewParams {
  nxpReference:  string
  evidenceType:  EvidenceItemType
  exporterId:    string
  actorUserId:   string
  actorRole:     EvidenceActorRole
  reason?:       string | null
}

const ALLOWED_FROM: EvidenceLifecycleState[] = ['uploaded']

// Transitions an evidence item from uploaded → pending_review and writes one
// enter_review event row, all within a single BEGIN/COMMIT block.
export async function submitForReview(
  pool: Pool,
  params: SubmitReviewParams,
): Promise<SubmitReviewResult> {
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

    // Only uploaded → pending_review is permitted
    if (!ALLOWED_FROM.includes(existing.lifecycle_state)) {
      await pg.query('ROLLBACK')
      return {
        data:  null,
        error: { code: 'INVALID_TRANSITION', currentState: existing.lifecycle_state, allowedFrom: ALLOWED_FROM },
      }
    }

    // Transition: uploaded → pending_review
    const { rows: updRows } = await pg.query<SubmitReviewData>(
      `UPDATE evidence_items
          SET lifecycle_state   = 'pending_review',
              validation_status = 'pending',
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
        existing.lifecycle_state,    // 'uploaded'
        'pending_review',
        existing.validation_status,  // 'pending' (set on mark_uploaded)
        'pending',                   // stays pending through submit-review
        params.actorUserId,
        params.actorRole,
        'enter_review',
        params.reason ?? null,
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
