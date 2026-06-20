import { Router } from 'express'
import type { DbClient } from '../../db/client'
import { listShipmentReconciliation, getShipmentReconciliation } from '../../db/queries/index'
import { requireExporterId } from '../middleware/require-exporter'
import { sendQueryError } from '../middleware/query-error'

export function shipmentsRouter(client: DbClient): Router {
  const router = Router()

  // GET /shipments[?contract_id=&fully_reconciled=true|false]
  router.get('/', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const contractId = req.query.contract_id as string | undefined
    const fullyReconciledParam = req.query.fully_reconciled as string | undefined
    const fullyReconciled =
      fullyReconciledParam === 'true'  ? true  :
      fullyReconciledParam === 'false' ? false :
      undefined

    try {
      const { data, error } = await listShipmentReconciliation(client, {
        exporterId,
        contractId,
        fullyReconciled,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /shipments/:id
  router.get('/:id', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getShipmentReconciliation(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Shipment not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
