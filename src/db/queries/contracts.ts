import type { DbClient } from '../client'
import type { ContractStatus, ContractSummaryRow } from '../types'

export interface ListContractSummariesOptions {
  exporterId?: string
  status?: ContractStatus
}

export async function listContractSummaries(
  client: DbClient,
  options: ListContractSummariesOptions = {},
): Promise<{ data: ContractSummaryRow[] | null; error: Error | null }> {
  let query = client
    .from('v_export_contracts_summary')
    .select('*')

  if (options.exporterId) query = query.eq('exporter_id', options.exporterId)
  if (options.status)     query = query.eq('status', options.status)

  return query.order('contract_date', { ascending: false }) as unknown as Promise<{
    data: ContractSummaryRow[] | null
    error: Error | null
  }>
}
