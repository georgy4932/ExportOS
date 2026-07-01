import type { Pool } from 'pg'
import type {
  EvidenceItemType,
  EvidenceLifecycleState,
  EvidenceActorRole,
} from '../types'

export type ValidateEvidenceError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_TRANSITION'; currentState: EvidenceLifecycleState; allowedFrom: EvidenceLifecycleState[] }
  | { code: 'DB_ERROR'; cause: unknown }

export interface ValidateEvidenceData {
  id: string
  evidence_type: EvidenceItemType
  lifecycle_state: EvidenceLifecycleState
  validation_status: string
  updated_at: string
}

export interface ValidateEvidenceResult {
  data: ValidateEvidenceData | null
  error: ValidateEvidenceError | null
}

export interface ValidateEvidenceParams {
  nxpReference:  string
  evidenceType:  EvidenceItemType
  exporterId:    string
  actorUserId:   string
  actorRole:     EvidenceActorRole
  reason:        string
}

// RC4_API_DESIGN.md: direct validation from 'uploaded' is intentionally permitted,
// bypassing the pending_review queue, in addition to the normal pending_review path.
const ALLOWED_FROM: EvidenceLifecycleState[] = ['uploaded', 'pending_review']

// Transitions an evidence item to validated and writes one validate event row,
// all within a single BEGIN/COMMIT block. Not idempotent: a repeat call finds
// lifecycle_state = 'validated', which is not in ALLOWED_FROM, and is rejected
// with 409 INVALID_TRANSITION — mirroring submitForReview's non-idempotent design.
export async function validateEvidence(
  pool: Pool,
  params: ValidateEvidenceParams,
): Promise<ValidateEvidenceResult> {
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

    // Transition: uploaded | pending_review → validated
    const { rows: updRows } = await pg.query<ValidateEvidenceData>(
      `UPDATE evidence_items
          SET lifecycle_state   = 'validated',
              validation_status = 'passed',
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
        'validated',
        existing.validation_status,
        'passed',
        params.actorUserId,
        params.actorRole,
        'validate',
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
