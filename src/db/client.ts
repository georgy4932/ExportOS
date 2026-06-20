import { Pool } from 'pg'

export function createDbClient(connectionString: string): Pool {
  return new Pool({ connectionString })
}

export type DbClient = Pool
