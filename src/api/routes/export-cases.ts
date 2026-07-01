import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { EvidenceItemType } from '../../db/types'
import { listEvidenceItems, getEvidenceItem, markEvidenceUploaded, listEvidenceEvents, submitForReview, validateEvidence, rejectEvidence, supersedeEvidence } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'
import { requireRole } from '../middleware/require-role'

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

// System-derived evidence types are not writable via the user-facing PATCH endpoint.
const SYSTEM_EVIDENCE_TYPES = new Set<string>([
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

  // PATCH /export-cases/:nxp_reference/evidence/:evidence_type
  // Marks a user-facing evidence item as uploaded (missing → uploaded).
  // Body: { "action": "mark_uploaded" }
  // System-derived types (shipment_record, compliance_summary) are rejected with 400.
  // Also updates the corresponding compliance_records boolean in the same transaction.
  router.patch('/:nxp_reference/evidence/:evidence_type', async (req, res) => {
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

    if (SYSTEM_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `evidence_type '${evidenceType}' is system-derived and cannot be updated via this endpoint`,
      })
      return
    }

    const { action } = req.body as Record<string, unknown>
    if (action !== 'mark_uploaded') {
      res.status(400).json({
        data:  null,
        error: `Unsupported action: '${String(action ?? '')}'. Supported actions: mark_uploaded`,
      })
      return
    }

    const result = await markEvidenceUploaded(client, {
      nxpReference,
      evidenceType: evidenceType as EvidenceItemType,
      exporterId,
    })

    if (result.error) {
      const e = result.error
      if (e.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Export case or evidence item not found' })
        return
      }
      if (e.code === 'CONFLICT') {
        res.status(409).json({
          data:  null,
          error: `Cannot mark uploaded: current lifecycle_state is '${e.currentState}'`,
        })
        return
      }
      // DB_ERROR
      return sendQueryError(req, res, e.cause)
    }

    res.json({ data: result.data, error: null })
  })

  // PATCH /export-cases/:nxp_reference/evidence/:evidence_type/submit-review
  // Moves an evidence item from uploaded → pending_review. reviewer/admin only.
  // Body: { "reason": "string (optional)" }
  // Writes one enter_review event row in the same transaction.
  router.patch('/:nxp_reference/evidence/:evidence_type/submit-review', requireRole('reviewer', 'admin'), async (req, res) => {
    const userId       = res.locals.userId
    const exporterId   = res.locals.exporterId
    const actorRole    = res.locals.actorRole
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

    if (SYSTEM_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `evidence_type '${evidenceType}' is system-derived and cannot be updated via this endpoint`,
      })
      return
    }

    const { reason } = req.body as Record<string, unknown>

    const result = await submitForReview(client, {
      nxpReference,
      evidenceType: evidenceType as EvidenceItemType,
      exporterId,
      actorUserId:  userId,
      actorRole,
      reason:       typeof reason === 'string' ? reason : null,
    })

    if (result.error) {
      const e = result.error
      if (e.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Export case or evidence item not found' })
        return
      }
      if (e.code === 'INVALID_TRANSITION') {
        res.status(409).json({
          data:         null,
          error:        `Transition not permitted: evidence_type '${evidenceType}' is currently '${e.currentState}'`,
          code:         'INVALID_TRANSITION',
          currentState: e.currentState,
          allowedFrom:  e.allowedFrom,
        })
        return
      }
      return sendQueryError(req, res, (e as { code: 'DB_ERROR'; cause: unknown }).cause)
    }

    res.json({ data: result.data, error: null })
  })

  // PATCH /export-cases/:nxp_reference/evidence/:evidence_type/validate
  // Moves an evidence item to validated. reviewer/admin only.
  // Allowed from: uploaded (direct validation, per RC4_API_DESIGN.md) or pending_review.
  // Body: { "reason": "string (required)" }
  // Writes one validate event row in the same transaction.
  router.patch('/:nxp_reference/evidence/:evidence_type/validate', requireRole('reviewer', 'admin'), async (req, res) => {
    const userId       = res.locals.userId
    const exporterId   = res.locals.exporterId
    const actorRole    = res.locals.actorRole
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

    if (SYSTEM_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `evidence_type '${evidenceType}' is system-derived and cannot be updated via this endpoint`,
      })
      return
    }

    const { reason } = req.body as Record<string, unknown>
    if (typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({
        data:  null,
        error: 'reason is required for validate',
        code:  'VALIDATION_REQUIRED',
      })
      return
    }

    const result = await validateEvidence(client, {
      nxpReference,
      evidenceType: evidenceType as EvidenceItemType,
      exporterId,
      actorUserId:  userId,
      actorRole,
      reason,
    })

    if (result.error) {
      const e = result.error
      if (e.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Export case or evidence item not found' })
        return
      }
      if (e.code === 'INVALID_TRANSITION') {
        res.status(409).json({
          data:         null,
          error:        `Transition not permitted: evidence_type '${evidenceType}' is currently '${e.currentState}'`,
          code:         'INVALID_TRANSITION',
          currentState: e.currentState,
          allowedFrom:  e.allowedFrom,
        })
        return
      }
      return sendQueryError(req, res, (e as { code: 'DB_ERROR'; cause: unknown }).cause)
    }

    res.json({ data: result.data, error: null })
  })

  // PATCH /export-cases/:nxp_reference/evidence/:evidence_type/reject
  // Moves an evidence item to rejected. reviewer/admin only.
  // Allowed from: uploaded or pending_review, per RC4_API_DESIGN.md.
  // Body: { "reason": "string (required)" }
  // Writes one reject event row in the same transaction.
  router.patch('/:nxp_reference/evidence/:evidence_type/reject', requireRole('reviewer', 'admin'), async (req, res) => {
    const userId       = res.locals.userId
    const exporterId   = res.locals.exporterId
    const actorRole    = res.locals.actorRole
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

    if (SYSTEM_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `evidence_type '${evidenceType}' is system-derived and cannot be updated via this endpoint`,
      })
      return
    }

    const { reason } = req.body as Record<string, unknown>
    if (typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({
        data:  null,
        error: 'reason is required for reject',
        code:  'VALIDATION_REQUIRED',
      })
      return
    }

    const result = await rejectEvidence(client, {
      nxpReference,
      evidenceType: evidenceType as EvidenceItemType,
      exporterId,
      actorUserId:  userId,
      actorRole,
      reason,
    })

    if (result.error) {
      const e = result.error
      if (e.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Export case or evidence item not found' })
        return
      }
      if (e.code === 'INVALID_TRANSITION') {
        res.status(409).json({
          data:         null,
          error:        `Transition not permitted: evidence_type '${evidenceType}' is currently '${e.currentState}'`,
          code:         'INVALID_TRANSITION',
          currentState: e.currentState,
          allowedFrom:  e.allowedFrom,
        })
        return
      }
      return sendQueryError(req, res, (e as { code: 'DB_ERROR'; cause: unknown }).cause)
    }

    res.json({ data: result.data, error: null })
  })

  // PATCH /export-cases/:nxp_reference/evidence/:evidence_type/supersede
  // Moves an evidence item to superseded. admin only (per RC4_API_DESIGN.md §5 —
  // reviewers receive 403, unlike submit-review/validate/reject which allow reviewer+admin).
  // Allowed from: validated only.
  // Body: { "reason": "string (required)" }
  // Writes one supersede event row in the same transaction.
  router.patch('/:nxp_reference/evidence/:evidence_type/supersede', requireRole('admin'), async (req, res) => {
    const userId       = res.locals.userId
    const exporterId   = res.locals.exporterId
    const actorRole    = res.locals.actorRole
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

    if (SYSTEM_EVIDENCE_TYPES.has(evidenceType)) {
      res.status(400).json({
        data:  null,
        error: `evidence_type '${evidenceType}' is system-derived and cannot be updated via this endpoint`,
      })
      return
    }

    const { reason } = req.body as Record<string, unknown>
    if (typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({
        data:  null,
        error: 'reason is required for supersede',
        code:  'VALIDATION_REQUIRED',
      })
      return
    }

    const result = await supersedeEvidence(client, {
      nxpReference,
      evidenceType: evidenceType as EvidenceItemType,
      exporterId,
      actorUserId:  userId,
      actorRole,
      reason,
    })

    if (result.error) {
      const e = result.error
      if (e.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Export case or evidence item not found' })
        return
      }
      if (e.code === 'INVALID_TRANSITION') {
        res.status(409).json({
          data:         null,
          error:        `Transition not permitted: evidence_type '${evidenceType}' is currently '${e.currentState}'`,
          code:         'INVALID_TRANSITION',
          currentState: e.currentState,
          allowedFrom:  e.allowedFrom,
        })
        return
      }
      return sendQueryError(req, res, (e as { code: 'DB_ERROR'; cause: unknown }).cause)
    }

    res.json({ data: result.data, error: null })
  })

  // GET /export-cases/:nxp_reference/evidence/:evidence_type/events
  // Returns all evidence_events for a single evidence item, ordered created_at ASC.
  router.get('/:nxp_reference/evidence/:evidence_type/events', async (req, res) => {
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
      console.error('[EXPORT-CASES] GET /:nxp/evidence/:type/events — shipment lookup error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ data: null, error: 'Internal server error' })
      return
    }

    if (!shipmentId) {
      res.status(404).json({ data: null, error: 'Export case not found' })
      return
    }

    const { data, error } = await listEvidenceEvents(client, {
      shipmentId,
      exporterId,
      evidenceType: evidenceType as EvidenceItemType,
    })

    if (error) {
      if (error.code === 'NOT_FOUND') {
        res.status(404).json({ data: null, error: 'Evidence item not found' })
        return
      }
      return sendQueryError(req, res, (error as { code: 'DB_ERROR'; cause: unknown }).cause)
    }

    res.json({ data: data ?? [], error: null })
  })

  return router
}
