import type { Pool } from 'pg'
import type { ShipmentReconciliationRow } from '../types'

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
