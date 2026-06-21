import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { RepatriationStatus } from '../../db/types'
import { listComplianceRecords, getComplianceByShipment, updateComplianceRecordWithAudit } from '../../db/queries/index'
import type { UpdateComplianceInput } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function complianceRouter(client: DbClient): Router {
  const router = Router()

  // GET /compliance[?status=OVERDUE&late_only=true]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const repatriationStatus = req.query.status as RepatriationStatus | undefined
    const lateOnly = req.query.late_only === 'true'

    try {
      const { data, error } = await listComplianceRecords(client, {
        exporterId,
        repatriationStatus,
        lateOnly: lateOnly || undefined,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /compliance/:shipmentId
  router.get('/:shipmentId', async (req, res) => {
    const exporterId = res.locals.exporterId
    const shipmentId = req.params['shipmentId'] as string

    try {
      const { data, error } = await getComplianceByShipment(
        client,
        shipmentId,
        exporterId,
      )
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Compliance record not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // PATCH /compliance/:shipmentId
  // Only operator-controlled checklist fields are accepted. All trigger-derived
  // and system fields are silently ignored. At least one patchable field required.
  router.patch('/:shipmentId', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId
    const shipmentId  = req.params['shipmentId'] as string

    const {
      nxp_submitted, nxp_approved, cci_obtained, bl_uploaded,
      payment_evidence_uploaded, credit_advice_confirmed,
      compliance_flags, last_reviewed_at, notes,
    } = req.body as Record<string, unknown>

    // Validate each boolean field
    const boolFields: Array<[string, unknown]> = [
      ['nxp_submitted',             nxp_submitted],
      ['nxp_approved',              nxp_approved],
      ['cci_obtained',              cci_obtained],
      ['bl_uploaded',               bl_uploaded],
      ['payment_evidence_uploaded', payment_evidence_uploaded],
      ['credit_advice_confirmed',   credit_advice_confirmed],
    ]
    for (const [name, val] of boolFields) {
      if (val !== undefined && typeof val !== 'boolean') {
        res.status(400).json({ error: `${name} must be a boolean` })
        return
      }
    }

    // Validate compliance_flags if provided and not null
    if (compliance_flags !== undefined && compliance_flags !== null) {
      if (
        !Array.isArray(compliance_flags) ||
        (compliance_flags as unknown[]).some(f => typeof f !== 'string')
      ) {
        res.status(400).json({ error: 'compliance_flags must be an array of strings or null' })
        return
      }
    }

    // Build update input — only fields that are not undefined
    const update: UpdateComplianceInput = {}
    if (nxp_submitted             !== undefined) update.nxp_submitted             = nxp_submitted             as boolean
    if (nxp_approved              !== undefined) update.nxp_approved              = nxp_approved              as boolean
    if (cci_obtained              !== undefined) update.cci_obtained              = cci_obtained              as boolean
    if (bl_uploaded               !== undefined) update.bl_uploaded               = bl_uploaded               as boolean
    if (payment_evidence_uploaded !== undefined) update.payment_evidence_uploaded = payment_evidence_uploaded as boolean
    if (credit_advice_confirmed   !== undefined) update.credit_advice_confirmed   = credit_advice_confirmed   as boolean
    if (compliance_flags          !== undefined) update.compliance_flags          = compliance_flags as string[] | null
    if (last_reviewed_at          !== undefined) update.last_reviewed_at          = last_reviewed_at as string | null
    if (notes                     !== undefined) update.notes                     = notes            as string | null

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'No patchable fields provided' })
      return
    }

    try {
      const { data, error } = await updateComplianceRecordWithAudit(
        client, shipmentId, exporterId, actorUserId, update,
      )
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Compliance record not found' })
      res.json({ data })
    } catch (err) {
      console.error('[COMPLIANCE] PATCH /:shipmentId error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
