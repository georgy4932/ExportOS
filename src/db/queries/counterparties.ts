import type { Pool } from 'pg'

export interface CounterpartySummary {
  id: string
  legal_name: string
  country_of_incorporation: string
}

export async function listCounterparties(
  pool: Pool,
  exporterId: string,
): Promise<{ data: CounterpartySummary[] | null; error: unknown }> {
  try {
    const { rows } = await pool.query<CounterpartySummary>(
      `SELECT id, legal_name, country_of_incorporation
         FROM counterparties
        WHERE exporter_id = $1
        ORDER BY legal_name`,
      [exporterId],
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
