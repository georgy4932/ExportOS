import type { Pool } from 'pg'
import type { EvidenceItemRow, EvidenceItemType } from '../types'

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
