import type { Pool } from 'pg'
import type { ContractStatus, ContractSummaryRow } from '../types'

export interface ListContractSummariesOptions {
  exporterId?: string
  status?: ContractStatus
}

export async function listContractSummaries(
  pool: Pool,
  options: ListContractSummariesOptions = {},
): Promise<{ data: ContractSummaryRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId) { params.push(options.exporterId); wheres.push(`exporter_id = $${params.length}`) }
    if (options.status)     { params.push(options.status);     wheres.push(`status = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<ContractSummaryRow>(
      `SELECT * FROM v_export_contracts_summary${where} ORDER BY contract_date DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getContractSummary(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: ContractSummaryRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<ContractSummaryRow>(
      'SELECT * FROM v_export_contracts_summary WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
