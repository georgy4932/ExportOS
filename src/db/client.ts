import { Pool } from 'pg'

export function createDbClient(connectionString: string): Pool {
  const ssl = /sslmode=(require|verify-ca|verify-full)/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined
  return new Pool({ connectionString, ssl })
}

export type DbClient = Pool
