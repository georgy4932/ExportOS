import type { DbClient } from '../client'
import type { BankEvidencePackRow } from '../types'

export interface ListEvidencePacksOptions {
  exporterId?: string
  shipmentId?: string
  sealed?: boolean
}

export async function listEvidencePacks(
  client: DbClient,
  options: ListEvidencePacksOptions = {},
): Promise<{ data: BankEvidencePackRow[] | null; error: Error | null }> {
  let query = client
    .from('bank_evidence_packs')
    .select('*')

  if (options.exporterId) query = query.eq('exporter_id', options.exporterId)
  if (options.shipmentId) query = query.eq('shipment_id', options.shipmentId)
  if (options.sealed !== undefined) query = query.eq('sealed', options.sealed)

  return query.order('generated_at', { ascending: false }) as unknown as Promise<{
    data: BankEvidencePackRow[] | null
    error: Error | null
  }>
}
