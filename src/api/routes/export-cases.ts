import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { EvidenceItemType } from '../../db/types'
import { listEvidenceItems, getEvidenceItem } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

// Mirrors the CHECK constraint on evidence_items.evidence_type.
const VALID_EVIDENCE_TYPES = new Set<string>([
  'nxp_approval',
  'bill_of_lading',
  'cci_document',
  'payment_evidence',
  'credit_advice',
  'shipment_record',
  'compliance_summary',
])

export function exportCasesRouter(client: DbClient): Router {
  const router = Router()

  // Resolves a CBN NXP reference to the underlying shipment UUID for the
  // authenticated exporter. Returns null if not found (route → 404).
  // nxp_reference callers should URL-encode slashes (e.g. NXP%2FCBN%2F2026%2F001).
  async function resolveShipmentId(nxpReference: string, exporterId: string): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM shipments WHERE nxp_reference = $1 AND exporter_id = $2 LIMIT 1',
      [nxpReference, exporterId],
    )
    return rows[0]?.id ?? null
  }

  // GET /export-cases/:nxp_reference/evidence
  // Returns all 7 evidence items for the export case identified by nxp_reference.
  router.get('/:nxp_reference/evidence', async (req, res) => {
    const exporterId   = res.locals.exporterId
    const nxpReference = req.params['nxp_reference'] as string

    let shipmentId: string | null
    try {
      shipmentId = await resolveShipmentId(nxpReference, exporterId)
    } catch (err) {
      console.error('[EXPORT-CASES] GET /:nxp/evidence — shipment lookup error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ data: null, error: 'Internal server error' })
      return
    }

    if (!shipmentId) {
      res.status(404).json({ data: null, error: 'Export case not found' })
      return
    }

    const { data, error } = await listEvidenceItems(client, { shipmentId, exporterId })
    if (error) return sendQueryError(req, res, error)
    res.json({ data: data ?? [], error: null })
  })

  // GET /export-cases/:nxp_reference/evidence/:evidence_type
  // Returns a single evidence item for the given type within the export case.
  router.get('/:nxp_reference/evidence/:evidence_type', async (req, res) => {
    const exporterId   = res.locals.exporterId
    const nxpReference = req.params['nxp_reference'] as string
    const evidenceType = req.params['evidence_type'] as string

    if (!VALID_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `Invalid evidence_type: '${evidenceType}'`,
        valid: Array.from(VALID_EVIDENCE_TYPES),
      })
      return
    }

    let shipmentId: string | null
    try {
      shipmentId = await resolveShipmentId(nxpReference, exporterId)
    } catch (err) {
      console.error('[EXPORT-CASES] GET /:nxp/evidence/:type — shipment lookup error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ data: null, error: 'Internal server error' })
      return
    }

    if (!shipmentId) {
      res.status(404).json({ data: null, error: 'Export case not found' })
      return
    }

    const { data, error } = await getEvidenceItem(client, shipmentId, exporterId, evidenceType as EvidenceItemType)
    if (error) return sendQueryError(req, res, error)
    if (!data) {
      res.status(404).json({ data: null, error: 'Evidence item not found' })
      return
    }
    res.json({ data, error: null })
  })

  return router
}
