import { Router } from 'express'
import type { DbClient } from '../../db/client'
import { listCounterparties } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function counterpartiesRouter(client: DbClient): Router {
  const router = Router()

  // GET /counterparties — returns id + legal_name scoped to the authenticated exporter.
  // Used to populate the counterparty dropdown in the contract creation form.
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    try {
      const { data, error } = await listCounterparties(client, exporterId)
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [] })
    } catch (err) {
      console.error('[COUNTERPARTIES] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
