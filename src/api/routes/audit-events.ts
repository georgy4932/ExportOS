import { Router } from 'express'
import type { DbClient } from '../../db/client'
import { listAuditEvents } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function auditEventsRouter(client: DbClient): Router {
  const router = Router()

  // GET /audit-events[?entity_type=export_contract&entity_id=<uuid>]
  // Returns audit events scoped to the authenticated exporter, newest first.
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const entityType = req.query.entity_type as string | undefined
    const entityId   = req.query.entity_id   as string | undefined

    try {
      const { data, error } = await listAuditEvents(client, exporterId, { entityType, entityId })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[AUDIT] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
