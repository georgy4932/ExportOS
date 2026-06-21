import type { Pool } from 'pg'
import type { ShipmentReconciliationRow, ShipmentRow } from '../types'
import { insertAuditEvent } from './audit'

export interface CreateShipmentInput {
  contract_id: string
  shipment_reference: string
  nxp_reference: string
  port_of_loading: string
  port_of_discharge: string
  shipment_quantity: number
  shipment_value: number
  currency: string
  shipping_line?: string | null
  vessel_name?: string | null
  voyage_number?: string | null
}

export interface ListShipmentReconciliationOptions {
  exporterId?: string
  contractId?: string
  fullyReconciled?: boolean
}

export async function listShipmentReconciliation(
  pool: Pool,
  options: ListShipmentReconciliationOptions = {},
): Promise<{ data: ShipmentReconciliationRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)               { params.push(options.exporterId);       wheres.push(`exporter_id = $${params.length}`) }
    if (options.contractId)               { params.push(options.contractId);        wheres.push(`contract_id = $${params.length}`) }
    if (options.fullyReconciled !== undefined) { params.push(options.fullyReconciled); wheres.push(`fully_reconciled = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<ShipmentReconciliationRow>(
      `SELECT * FROM v_shipments_reconciliation${where} ORDER BY shipment_sequence ASC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getShipmentReconciliation(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: ShipmentReconciliationRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<ShipmentReconciliationRow>(
      'SELECT * FROM v_shipments_reconciliation WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

// Inserts a shipment and its audit event in a single transaction.
// exporter_id and actorUserId must be server-derived by the caller.
// shipment_sequence is auto-calculated as MAX(sequence) + 1 for the contract.
export async function createShipmentWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreateShipmentInput,
): Promise<{ data: ShipmentRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows: seqRows } = await pg.query<{ next_seq: number }>(
      `SELECT COALESCE(MAX(shipment_sequence), 0) + 1 AS next_seq
         FROM shipments WHERE contract_id = $1`,
      [input.contract_id],
    )
    const nextSeq = seqRows[0]!.next_seq

    const { rows } = await pg.query<ShipmentRow>(
      `INSERT INTO shipments (
        contract_id, exporter_id, shipment_reference, shipment_sequence,
        nxp_reference, port_of_loading, port_of_discharge,
        shipment_quantity, shipment_value, currency,
        shipping_line, vessel_name, voyage_number
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) RETURNING *`,
      [
        input.contract_id,
        exporterId,
        input.shipment_reference,
        nextSeq,
        input.nxp_reference,
        input.port_of_loading,
        input.port_of_discharge,
        input.shipment_quantity,
        input.shipment_value,
        input.currency,
        input.shipping_line ?? null,
        input.vessel_name ?? null,
        input.voyage_number ?? null,
      ],
    )
    const shipment = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'shipment',
      entityId:   shipment.id,
      action:     'CREATE',
      eventData:  shipment,
    })

    await pg.query('COMMIT')
    return { data: shipment, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}
