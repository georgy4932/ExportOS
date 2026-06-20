import type { Pool } from 'pg'
import type { ComplianceRecordRow, RepatriationStatus } from '../types'

export interface ListComplianceRecordsOptions {
  exporterId?: string
  repatriationStatus?: RepatriationStatus
  lateOnly?: boolean
}

export async function listComplianceRecords(
  pool: Pool,
  options: ListComplianceRecordsOptions = {},
): Promise<{ data: ComplianceRecordRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)         { params.push(options.exporterId);          wheres.push(`exporter_id = $${params.length}`) }
    if (options.repatriationStatus) { params.push(options.repatriationStatus);  wheres.push(`repatriation_status = $${params.length}`) }
    if (options.lateOnly)           { params.push(true);                         wheres.push(`was_repatriated_late = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<ComplianceRecordRow>(
      `SELECT * FROM compliance_records${where} ORDER BY repatriation_deadline ASC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getComplianceByShipment(
  pool: Pool,
  shipmentId: string,
  exporterId: string,
): Promise<{ data: ComplianceRecordRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<ComplianceRecordRow>(
      'SELECT * FROM compliance_records WHERE shipment_id = $1 AND exporter_id = $2',
      [shipmentId, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
