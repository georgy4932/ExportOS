import type { Pool } from 'pg'
import type { CommodityType, ContractStatus, ContractSummaryRow, ExportContractRow } from '../types'

export interface CreateContractInput {
  contract_reference: string
  counterparty_id: string
  commodity: string
  commodity_type: CommodityType
  hs_code: string
  contract_quantity: number
  quantity_unit: string
  contract_value: number
  currency: string
  unit_price: number
  incoterms: string
  destination_country: string
  destination_port?: string | null
  payment_terms: string
  partial_shipment_allowed?: boolean
  contract_date: string
  expiry_date?: string | null
  notes?: string | null
}

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

export async function createContract(
  pool: Pool,
  exporterId: string,
  input: CreateContractInput,
): Promise<{ data: ExportContractRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<ExportContractRow>(
      `INSERT INTO export_contracts (
        exporter_id, contract_reference, counterparty_id,
        commodity, commodity_type, hs_code,
        contract_quantity, quantity_unit, contract_value,
        currency, unit_price, incoterms,
        destination_country, destination_port, payment_terms,
        partial_shipment_allowed, contract_date, expiry_date, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      ) RETURNING *`,
      [
        exporterId,
        input.contract_reference,
        input.counterparty_id,
        input.commodity,
        input.commodity_type,
        input.hs_code,
        input.contract_quantity,
        input.quantity_unit,
        input.contract_value,
        input.currency,
        input.unit_price,
        input.incoterms,
        input.destination_country,
        input.destination_port ?? null,
        input.payment_terms,
        input.partial_shipment_allowed ?? false,
        input.contract_date,
        input.expiry_date ?? null,
        input.notes ?? null,
      ],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
