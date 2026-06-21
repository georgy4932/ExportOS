import type { Pool } from 'pg'
import type { BillOfLadingRow, BlType, FreightTerms } from '../types'
import { insertAuditEvent } from './audit'

export interface CreateBillOfLadingInput {
  shipment_id: string
  bl_number: string
  bl_date: string
  bl_type: BlType
  shipper_name: string
  consignee_name: string
  description_of_goods: string
  nxp_reference: string
  notify_party?: string | null
  gross_weight_kg?: number | null
  number_of_packages?: number | null
  container_numbers?: string[] | null
  freight_terms?: FreightTerms | null
  place_of_receipt?: string | null
  place_of_delivery?: string | null
  document_url?: string | null
}

// Inserts a bill of lading and its audit event in a single transaction.
// exporter_id and actorUserId must be server-derived by the caller.
// repatriation_days and repatriation_deadline are set by the DB trigger
// trg_bl_compute_deadline on INSERT — never accepted from client.
export async function createBillOfLadingWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreateBillOfLadingInput,
): Promise<{ data: BillOfLadingRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<BillOfLadingRow>(
      `INSERT INTO bills_of_lading (
        shipment_id, exporter_id, bl_number, bl_date, bl_type,
        shipper_name, consignee_name, description_of_goods, nxp_reference,
        notify_party, gross_weight_kg, number_of_packages, container_numbers,
        freight_terms, place_of_receipt, place_of_delivery, document_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17
      ) RETURNING *`,
      [
        input.shipment_id,
        exporterId,
        input.bl_number,
        input.bl_date,
        input.bl_type,
        input.shipper_name,
        input.consignee_name,
        input.description_of_goods,
        input.nxp_reference,
        input.notify_party    ?? null,
        input.gross_weight_kg  ?? null,
        input.number_of_packages ?? null,
        input.container_numbers  ?? null,
        input.freight_terms   ?? null,
        input.place_of_receipt ?? null,
        input.place_of_delivery ?? null,
        input.document_url    ?? null,
      ],
    )
    const bl = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'bill_of_lading',
      entityId:   bl.id,
      action:     'CREATE',
      eventData:  bl,
    })

    await pg.query('COMMIT')
    return { data: bl, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}
