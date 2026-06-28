import type { Pool } from 'pg'
import type { EvidenceEventRow, EvidenceItemType } from '../types'

export type ListEvidenceEventsError =
  | { code: 'NOT_FOUND' }
  | { code: 'DB_ERROR'; cause: unknown }

export interface ListEvidenceEventsResult {
  data: EvidenceEventRow[] | null
  error: ListEvidenceEventsError | null
}

export interface ListEvidenceEventsOptions {
  shipmentId: string
  exporterId: string
  evidenceType: EvidenceItemType
}

// Returns all evidence_events for a single evidence item, ordered created_at ASC.
// First verifies the evidence item exists for the given shipment+exporter scope;
// returns NOT_FOUND if the item row does not exist.
export async function listEvidenceEvents(
  pool: Pool,
  options: ListEvidenceEventsOptions,
): Promise<ListEvidenceEventsResult> {
  try {
    // Verify evidence item exists within exporter scope (enforces tenant boundary)
    const { rows: itemRows } = await pool.query<{ id: string }>(
      `SELECT id FROM evidence_items
        WHERE shipment_id = $1 AND exporter_id = $2 AND evidence_type = $3`,
      [options.shipmentId, options.exporterId, options.evidenceType],
    )
    if (!itemRows[0]) {
      return { data: null, error: { code: 'NOT_FOUND' } }
    }

    // Fetch events ordered chronologically; query by FK for index efficiency
    const { rows } = await pool.query<EvidenceEventRow>(
      `SELECT * FROM evidence_events
        WHERE evidence_item_id = $1
        ORDER BY created_at ASC`,
      [itemRows[0].id],
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: { code: 'DB_ERROR', cause: err } }
  }
}
