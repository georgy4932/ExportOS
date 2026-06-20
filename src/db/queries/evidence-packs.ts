import type { Pool } from 'pg'
import type { BankEvidencePackRow } from '../types'

export interface ListEvidencePacksOptions {
  exporterId?: string
  shipmentId?: string
  sealed?: boolean
}

export async function listEvidencePacks(
  pool: Pool,
  options: ListEvidencePacksOptions = {},
): Promise<{ data: BankEvidencePackRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)           { params.push(options.exporterId);  wheres.push(`exporter_id = $${params.length}`) }
    if (options.shipmentId)           { params.push(options.shipmentId);  wheres.push(`shipment_id = $${params.length}`) }
    if (options.sealed !== undefined) { params.push(options.sealed);      wheres.push(`sealed = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<BankEvidencePackRow>(
      `SELECT * FROM bank_evidence_packs${where} ORDER BY generated_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getEvidencePack(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: BankEvidencePackRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<BankEvidencePackRow>(
      'SELECT * FROM bank_evidence_packs WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
