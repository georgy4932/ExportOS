import { Router } from 'express'
import type { DbClient } from '../../db/client'
import { listEvidencePacks, getEvidencePack } from '../../db/queries/index'
import { requireExporterId } from '../middleware/require-exporter'
import { sendQueryError } from '../middleware/query-error'

export function evidencePacksRouter(client: DbClient): Router {
  const router = Router()

  // GET /evidence-packs[?shipment_id=&sealed=true|false]
  router.get('/', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const shipmentId = req.query.shipment_id as string | undefined
    const sealedParam = req.query.sealed as string | undefined
    const sealed =
      sealedParam === 'true'  ? true  :
      sealedParam === 'false' ? false :
      undefined

    try {
      const { data, error } = await listEvidencePacks(client, {
        exporterId,
        shipmentId,
        sealed,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /evidence-packs/:id
  router.get('/:id', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getEvidencePack(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Evidence pack not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
