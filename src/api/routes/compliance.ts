import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { RepatriationStatus } from '../../db/types'
import { listComplianceRecords, getComplianceByShipment } from '../../db/queries/index'
import { requireExporterId } from '../middleware/require-exporter'

export function complianceRouter(client: DbClient): Router {
  const router = Router()

  // GET /compliance[?status=OVERDUE&late_only=true]
  router.get('/', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const repatriationStatus = req.query.status as RepatriationStatus | undefined
    const lateOnly = req.query.late_only === 'true'

    try {
      const { data, error } = await listComplianceRecords(client, {
        exporterId,
        repatriationStatus,
        lateOnly: lateOnly || undefined,
      })
      if (error) return res.status(502).json({ error: (error as Error).message })
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /compliance/:shipmentId
  router.get('/:shipmentId', requireExporterId, async (req, res) => {
    const exporterId = res.locals.exporterId
    const shipmentId = req.params['shipmentId'] as string

    try {
      const { data, error } = await getComplianceByShipment(
        client,
        shipmentId,
        exporterId,
      )
      if (error) return res.status(502).json({ error: (error as Error).message })
      if (!data) return res.status(404).json({ error: 'Compliance record not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
