import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { AllocationStatus, DiscrepancyStatus } from '../../db/types'
import { createPaymentReceiptWithAudit, getPaymentReceipt, listPaymentReceipts } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const ALLOCATION_STATUSES: AllocationStatus[]   = ['UNALLOCATED', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED']
const DISCREPANCY_STATUSES: DiscrepancyStatus[] = ['CLEAN', 'AMOUNT_MISMATCH', 'DATE_MISMATCH', 'COUNTERPARTY_MISMATCH', 'UNMATCHED', 'MANUALLY_RESOLVED']

export function paymentReceiptsRouter(client: DbClient): Router {
  const router = Router()

  // GET /payment-receipts[?allocation_status=&discrepancy_status=]
  router.get('/', async (req, res) => {
    const exporterId         = res.locals.exporterId
    const allocationParam    = req.query.allocation_status  as string | undefined
    const discrepancyParam   = req.query.discrepancy_status as string | undefined

    if (allocationParam != null && !ALLOCATION_STATUSES.includes(allocationParam as AllocationStatus)) {
      res.status(400).json({ error: 'Invalid allocation_status', valid: ALLOCATION_STATUSES })
      return
    }
    if (discrepancyParam != null && !DISCREPANCY_STATUSES.includes(discrepancyParam as DiscrepancyStatus)) {
      res.status(400).json({ error: 'Invalid discrepancy_status', valid: DISCREPANCY_STATUSES })
      return
    }

    try {
      const { data, error } = await listPaymentReceipts(client, {
        exporterId,
        allocationStatus:  allocationParam  as AllocationStatus  | undefined,
        discrepancyStatus: discrepancyParam as DiscrepancyStatus | undefined,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[RECEIPTS] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })


  // GET /payment-receipts/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getPaymentReceipt(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Payment receipt not found' })
      res.json({ data })
    } catch (err) {
      console.error('[RECEIPTS] GET /:id error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /payment-receipts
  // exporter_id is derived from JWT — any client-supplied value is discarded.
  // discrepancy_status is set by DB trigger trg_payment_receipt_discrepancy.
  // charges_deducted and amount_variance are GENERATED columns — never accepted from client.
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id: _ignored,
      discrepancy_status: _disc,      // trigger-computed, never from client
      allocation_status: _alloc,      // DB default UNALLOCATED, managed by trigger
      charges_deducted: _charges,     // GENERATED ALWAYS AS
      amount_variance: _variance,     // GENERATED ALWAYS AS
      receipt_reference, credit_date, currency,
      instructed_amount, credited_amount,
      value_date, domiciliary_account_ref, ordering_bank_bic,
      ordering_customer_name, remittance_info, discrepancy_notes,
    } = req.body as Record<string, unknown>

    // Required field validation
    const missing: string[] = []
    if (!receipt_reference)      missing.push('receipt_reference')
    if (!credit_date)            missing.push('credit_date')
    if (!currency)               missing.push('currency')
    if (instructed_amount == null) missing.push('instructed_amount')
    if (credited_amount == null)   missing.push('credited_amount')

    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    // Numeric validation
    const instructed = Number(instructed_amount)
    const credited   = Number(credited_amount)
    if (!isFinite(instructed) || instructed <= 0) {
      res.status(400).json({ error: 'instructed_amount must be a positive number' })
      return
    }
    if (!isFinite(credited) || credited <= 0) {
      res.status(400).json({ error: 'credited_amount must be a positive number' })
      return
    }

    const { data, error } = await createPaymentReceiptWithAudit(client, exporterId, actorUserId, {
      receipt_reference:      String(receipt_reference),
      credit_date:            String(credit_date),
      currency:               String(currency).toUpperCase().slice(0, 3),
      instructed_amount:      instructed,
      credited_amount:        credited,
      value_date:             value_date             ? String(value_date)             : null,
      domiciliary_account_ref: domiciliary_account_ref ? String(domiciliary_account_ref) : null,
      ordering_bank_bic:      ordering_bank_bic      ? String(ordering_bank_bic)      : null,
      ordering_customer_name: ordering_customer_name ? String(ordering_customer_name) : null,
      remittance_info:        remittance_info        ? String(remittance_info)        : null,
      discrepancy_notes:      discrepancy_notes      ? String(discrepancy_notes)      : null,
    })

    if (error) {
      const pgErr = error as { code?: string; constraint?: string }
      if (pgErr.code === '23505') {
        res.status(400).json({ error: 'A payment receipt with this receipt_reference already exists for this exporter' })
        return
      }
      return sendQueryError(req, res, error)
    }
    res.status(201).json({ data })
  })

  return router
}
