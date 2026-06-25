import type { Pool } from 'pg'
import type { EvidenceItemRow, EvidenceItemType, EvidenceLifecycleState } from '../types'

// User-facing evidence types that may be marked uploaded.
// System-derived types (shipment_record, compliance_summary) are excluded here;
// the route layer rejects them with 400 before calling this function.
const LEGACY_BOOL_MAP: Partial<Record<EvidenceItemType, string>> = {
  nxp_approval:    'nxp_approved',
  bill_of_lading:  'bl_uploaded',
  cci_document:    'cci_obtained',
  payment_evidence:'payment_evidence_uploaded',
  credit_advice:   'credit_advice_confirmed',
}

export type MarkUploadedError =
  | { code: 'NOT_FOUND' }
  | { code: 'CONFLICT'; currentState: EvidenceLifecycleState }
  | { code: 'DB_ERROR'; cause: unknown }

export interface MarkUploadedResult {
  data: EvidenceItemRow | null
  error: MarkUploadedError | null
}

export interface ListEvidenceItemsOptions {
  exporterId: string
  shipmentId: string
}

export async function listEvidenceItems(
  pool: Pool,
  options: ListEvidenceItemsOptions,
): Promise<{ data: EvidenceItemRow[] | null; error: unknown }> {
  try {
    const { rows } = await pool.query<EvidenceItemRow>(
      `SELECT * FROM evidence_items
        WHERE shipment_id = $1 AND exporter_id = $2
        ORDER BY evidence_code ASC`,
      [options.shipmentId, options.exporterId],
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getEvidenceItem(
  pool: Pool,
  shipmentId: string,
  exporterId: string,
  evidenceType: EvidenceItemType,
): Promise<{ data: EvidenceItemRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<EvidenceItemRow>(
      `SELECT * FROM evidence_items
        WHERE shipment_id = $1 AND exporter_id = $2 AND evidence_type = $3`,
      [shipmentId, exporterId, evidenceType],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

// Marks one user-facing evidence item as uploaded and derives the matching
// compliance_records boolean in the same transaction (W1 write path).
//
// Invariants enforced here:
//   - nxp_reference must resolve to a shipment owned by exporterId
//   - evidence_items row must exist
//   - lifecycle_state must be 'missing' (only missing → uploaded is permitted)
//   - uploaded_at is set to NOW() if not already present
//   - validation_status is set to 'pending'
//   - legacy compliance_records boolean is updated in the same BEGIN/COMMIT
export async function markEvidenceUploaded(
  pool: Pool,
  params: { nxpReference: string; evidenceType: EvidenceItemType; exporterId: string },
): Promise<MarkUploadedResult> {
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

    // Lock the evidence_items row for update
    const { rows: evRows } = await pg.query<EvidenceItemRow>(
      `SELECT * FROM evidence_items
        WHERE shipment_id = $1 AND exporter_id = $2 AND evidence_type = $3
        FOR UPDATE`,
      [shipmentId, params.exporterId, params.evidenceType],
    )
    const existing = evRows[0]
    if (!existing) {
      await pg.query('ROLLBACK')
      return { data: null, error: { code: 'NOT_FOUND' } }
    }

    // Only missing → uploaded is permitted in W1
    if (existing.lifecycle_state !== 'missing') {
      await pg.query('ROLLBACK')
      return { data: null, error: { code: 'CONFLICT', currentState: existing.lifecycle_state } }
    }

    // Transition: missing → uploaded
    const { rows: updRows } = await pg.query<EvidenceItemRow>(
      `UPDATE evidence_items
          SET lifecycle_state   = 'uploaded',
              validation_status = 'pending',
              uploaded_at       = COALESCE(uploaded_at, NOW()),
              updated_at        = NOW()
        WHERE id = $1
      RETURNING *`,
      [existing.id],
    )
    const updated = updRows[0]!

    // Derive legacy compliance_records boolean in the same transaction
    const boolField = LEGACY_BOOL_MAP[params.evidenceType]
    if (boolField) {
      await pg.query(
        `UPDATE compliance_records
            SET ${boolField} = true
          WHERE shipment_id = $1 AND exporter_id = $2`,
        [shipmentId, params.exporterId],
      )
    }

    await pg.query('COMMIT')
    return { data: updated, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: { code: 'DB_ERROR', cause: err } }
  } finally {
    pg.release()
  }
}
