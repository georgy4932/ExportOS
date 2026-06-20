import type { Pool } from 'pg'
import type { BLDeadlineRow, DeadlineStatus } from '../types'

export interface ListBLDeadlinesOptions {
  exporterId?: string
  deadlineStatus?: DeadlineStatus
}

export async function listBLDeadlines(
  pool: Pool,
  options: ListBLDeadlinesOptions = {},
): Promise<{ data: BLDeadlineRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)     { params.push(options.exporterId);     wheres.push(`exporter_id = $${params.length}`) }
    if (options.deadlineStatus) { params.push(options.deadlineStatus); wheres.push(`deadline_status = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<BLDeadlineRow>(
      `SELECT * FROM v_bills_of_lading_deadline${where} ORDER BY repatriation_deadline ASC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
