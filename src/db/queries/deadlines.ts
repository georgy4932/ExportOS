import type { DbClient } from '../client'
import type { BLDeadlineRow, DeadlineStatus } from '../types'

export interface ListBLDeadlinesOptions {
  exporterId?: string
  deadlineStatus?: DeadlineStatus
}

export async function listBLDeadlines(
  client: DbClient,
  options: ListBLDeadlinesOptions = {},
): Promise<{ data: BLDeadlineRow[] | null; error: Error | null }> {
  let query = client
    .from('v_bills_of_lading_deadline')
    .select('*')

  if (options.exporterId)     query = query.eq('exporter_id', options.exporterId)
  if (options.deadlineStatus) query = query.eq('deadline_status', options.deadlineStatus)

  return query.order('repatriation_deadline', { ascending: true }) as unknown as Promise<{
    data: BLDeadlineRow[] | null
    error: Error | null
  }>
}
