import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { ContractStatus } from '../../db/types'
import { listContractSummaries, getContractSummary } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function contractsRouter(client: DbClient): Router {
  const router = Router()

  // GET /contracts[?status=ACTIVE]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const status = req.query.status as ContractStatus | undefined

    try {
      const { data, error } = await listContractSummaries(client, { exporterId, status })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /contracts/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getContractSummary(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Contract not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
