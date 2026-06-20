import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

export function createDbClient(url: string, key: string) {
  return createClient<Database>(url, key)
}

export type DbClient = ReturnType<typeof createDbClient>
