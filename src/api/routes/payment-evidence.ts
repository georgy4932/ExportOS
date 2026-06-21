import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { ChargesCode, EvidenceType } from '../../db/types'
import {
  createPaymentEvidenceWithAudit,
  getPaymentEvidence,
  listPaymentEvidence,
} from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const EVIDENCE_TYPES: EvidenceType[] = ['MT103', 'PACS008', 'MT910', 'BANK_CREDIT_ADVICE', 'MT940_LINE', 'MT950_LINE', 'MANUAL']
const CHARGES_CODES: ChargesCode[]   = ['OUR', 'SHA', 'BEN']

export function paymentEvidenceRouter(client: DbClient): Router {
  const router = Router()

  // GET /payment-evidence[?receipt_id=&evidence_type=]
  router.get('/', async (req, res) => {
    const exporterId    = res.locals.exporterId
    const receiptId     = req.query.receipt_id    as string | undefined
    const evidenceParam = req.query.evidence_type as string | undefined

    if (evidenceParam != null && !EVIDENCE_TYPES.includes(evidenceParam as EvidenceType)) {
      res.status(400).json({ error: 'Invalid evidence_type', valid: EVIDENCE_TYPES })
      return
    }

    try {
      const { data, error } = await listPaymentEvidence(client, {
        exporterId,
        receiptId,
        evidenceType: evidenceParam as EvidenceType | undefined,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[EVIDENCE] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /payment-evidence/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getPaymentEvidence(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Payment evidence not found' })
      res.json({ data })
    } catch (err) {
      console.error('[EVIDENCE] GET /:id error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /payment-evidence
  // exporter_id is derived from JWT — any client-supplied value is discarded.
  // uploaded_by is derived from JWT — any client-supplied value is discarded.
  // superseded_by is not accepted on create — corrections require a new row,
  //   then PATCH the old row's superseded_by to point at the new one.
  // All fields except receipt_id and superseded_by are immutable after creation
  //   (enforced by trg_payment_evidence_immutable BEFORE UPDATE).
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id:   _ignoredExporter,   // server-derived from JWT
      uploaded_by:   _ignoredUploadedBy, // server-derived from JWT
      superseded_by: _ignoredSuperseded, // not accepted on create
      evidence_type,
      receipt_id,
      source_document_ref, sender_bic, receiver_bic,
      instructed_amount, instructed_currency, value_date, charges_code,
      ordering_customer, beneficiary_customer, remittance_info, document_url,
      credited_amount, credited_currency, credit_date,
      bank_ref, payer_account, payer_name,
    } = req.body as Record<string, unknown>

    // evidence_type required and must be valid
    if (!evidence_type) {
      res.status(400).json({ error: 'Missing required fields', fields: ['evidence_type'] })
      return
    }
    if (!EVIDENCE_TYPES.includes(evidence_type as EvidenceType)) {
      res.status(400).json({ error: 'Invalid evidence_type', valid: EVIDENCE_TYPES })
      return
    }

    // BANK_CREDIT_ADVICE requires credited_amount, credited_currency, credit_date
    if (evidence_type === 'BANK_CREDIT_ADVICE') {
      const bcaMissing: string[] = []
      if (credited_amount == null) bcaMissing.push('credited_amount')
      if (!credited_currency)      bcaMissing.push('credited_currency')
      if (!credit_date)            bcaMissing.push('credit_date')
      if (bcaMissing.length > 0) {
        res.status(400).json({
          error:  'BANK_CREDIT_ADVICE requires credited_amount, credited_currency, and credit_date',
          fields: bcaMissing,
        })
        return
      }
    }

    // Validate charges_code enum if provided
    if (charges_code != null && !CHARGES_CODES.includes(charges_code as ChargesCode)) {
      res.status(400).json({ error: 'Invalid charges_code', valid: CHARGES_CODES })
      return
    }

    // Validate instructed_amount > 0 if provided
    if (instructed_amount != null) {
      const amt = Number(instructed_amount)
      if (!isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: 'instructed_amount must be a positive number' })
        return
      }
    }

    // Validate credited_amount > 0 if provided
    if (credited_amount != null) {
      const camt = Number(credited_amount)
      if (!isFinite(camt) || camt <= 0) {
        res.status(400).json({ error: 'credited_amount must be a positive number' })
        return
      }
    }

    // IDOR check: receipt_id must belong to authenticated exporter (if provided)
    if (receipt_id != null) {
      try {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM payment_receipts WHERE id = $1 AND exporter_id = $2',
          [receipt_id, exporterId],
        )
        if (!rows.length) {
          res.status(400).json({ error: 'receipt_id not found for this exporter' })
          return
        }
      } catch (err) {
        console.error('[EVIDENCE] POST / receipt check error:', err instanceof Error ? err.message : String(err))
        res.status(500).json({ error: 'Internal server error' })
        return
      }
    }

    const { data, error } = await createPaymentEvidenceWithAudit(client, exporterId, actorUserId, {
      evidence_type:        evidence_type as EvidenceType,
      receipt_id:           receipt_id           ? String(receipt_id)           : null,
      source_document_ref:  source_document_ref  ? String(source_document_ref)  : null,
      sender_bic:           sender_bic           ? String(sender_bic)           : null,
      receiver_bic:         receiver_bic         ? String(receiver_bic)         : null,
      instructed_amount:    instructed_amount != null ? Number(instructed_amount)  : null,
      instructed_currency:  instructed_currency  ? String(instructed_currency).toUpperCase().slice(0, 3) : null,
      value_date:           value_date           ? String(value_date)           : null,
      charges_code:         charges_code         ? charges_code as ChargesCode  : null,
      ordering_customer:    ordering_customer    ? String(ordering_customer)    : null,
      beneficiary_customer: beneficiary_customer ? String(beneficiary_customer) : null,
      remittance_info:      remittance_info      ? String(remittance_info)      : null,
      document_url:         document_url         ? String(document_url)         : null,
      credited_amount:      credited_amount != null ? Number(credited_amount)   : null,
      credited_currency:    credited_currency    ? String(credited_currency).toUpperCase().slice(0, 3) : null,
      credit_date:          credit_date          ? String(credit_date)          : null,
      bank_ref:             bank_ref             ? String(bank_ref)             : null,
      payer_account:        payer_account        ? String(payer_account)        : null,
      payer_name:           payer_name           ? String(payer_name)           : null,
    })

    if (error) return sendQueryError(req, res, error)
    res.status(201).json({ data })
  })

  return router
}
