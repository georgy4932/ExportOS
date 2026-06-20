import type { DbClient } from '../client'
import type { ComplianceRecordRow, RepatriationStatus } from '../types'

export async function getComplianceByShipment(
  client: DbClient,
  shipmentId: string,
  exporterId: string,
): Promise<{ data: ComplianceRecordRow | null; error: Error | null }> {
  return client
    .from('compliance_records')
    .select('*')
    .eq('shipment_id', shipmentId)
    .eq('exporter_id', exporterId)
    .maybeSingle() as unknown as Promise<{
      data: ComplianceRecordRow | null
      error: Error | null
    }>
}

export interface ListComplianceRecordsOptions {
  exporterId?: string
  repatriationStatus?: RepatriationStatus
  lateOnly?: boolean
}

export async function listComplianceRecords(
  client: DbClient,
  options: ListComplianceRecordsOptions = {},
): Promise<{ data: ComplianceRecordRow[] | null; error: Error | null }> {
  let query = client
    .from('compliance_records')
    .select('*')

  if (options.exporterId)          query = query.eq('exporter_id', options.exporterId)
  if (options.repatriationStatus)  query = query.eq('repatriation_status', options.repatriationStatus)
  if (options.lateOnly)            query = query.eq('was_repatriated_late', true)

  return query.order('repatriation_deadline', { ascending: true }) as unknown as Promise<{
    data: ComplianceRecordRow[] | null
    error: Error | null
  }>
}
