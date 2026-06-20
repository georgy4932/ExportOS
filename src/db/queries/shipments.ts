import type { DbClient } from '../client'
import type { ShipmentReconciliationRow } from '../types'

export async function getShipmentReconciliation(
  client: DbClient,
  id: string,
  exporterId: string,
): Promise<{ data: ShipmentReconciliationRow | null; error: Error | null }> {
  return client
    .from('v_shipments_reconciliation')
    .select('*')
    .eq('id', id)
    .eq('exporter_id', exporterId)
    .maybeSingle() as unknown as Promise<{
      data: ShipmentReconciliationRow | null
      error: Error | null
    }>
}

export interface ListShipmentReconciliationOptions {
  exporterId?: string
  contractId?: string
  fullyReconciled?: boolean
}

export async function listShipmentReconciliation(
  client: DbClient,
  options: ListShipmentReconciliationOptions = {},
): Promise<{ data: ShipmentReconciliationRow[] | null; error: Error | null }> {
  let query = client
    .from('v_shipments_reconciliation')
    .select('*')

  if (options.exporterId)       query = query.eq('exporter_id', options.exporterId)
  if (options.contractId)       query = query.eq('contract_id', options.contractId)
  if (options.fullyReconciled !== undefined)
    query = query.eq('fully_reconciled', options.fullyReconciled)

  return query.order('shipment_sequence', { ascending: true }) as unknown as Promise<{
    data: ShipmentReconciliationRow[] | null
    error: Error | null
  }>
}
