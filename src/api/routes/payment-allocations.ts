import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { AllocationMethod } from '../../db/types'
import {
  createPaymentAllocationWithAudit,
  getPaymentAllocation,
  listPaymentAllocations,
} from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const ALLOCATION_METHODS: AllocationMethod[] = ['MANUAL', 'FIFO', 'PRO_RATA', 'INSTRUCTION_MATCHED']

export function paymentAllocationsRouter(client: DbClient): Router {
  const router = Router()

  // GET /payment-allocations[?receipt_id=&shipment_id=]
  router.get('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const receiptId   = req.query.receipt_id  as string | undefined
    const shipmentId  = req.query.shipment_id as string | undefined

    try {
      const { data, error } = await listPaymentAllocations(client, { exporterId, receiptId, shipmentId })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[ALLOCATIONS] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /payment-allocations/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getPaymentAllocation(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Payment allocation not found' })
      res.json({ data })
    } catch (err) {
      console.error('[ALLOCATIONS] GET /:id error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /payment-allocations
  // exporter_id is derived from JWT — any client-supplied value is discarded.
  // allocated_by is derived from JWT — any client-supplied value is discarded.
  // trg_allocation_integrity (BEFORE INSERT) enforces SUM <= credited_amount.
  // trg_allocation_side_effects (AFTER INSERT) syncs allocation_status,
  //   compliance proceeds_received, repatriation_status, and shipment status.
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id: _ignoredExporter,  // server-derived from JWT
      allocated_by: _ignoredAllocBy,  // server-derived from JWT
      receipt_id, shipment_id,
      allocated_amount, allocation_method, allocation_date,
      invoice_id, notes,
    } = req.body as Record<string, unknown>

    // Required field validation
    const missing: string[] = []
    if (!receipt_id)                     missing.push('receipt_id')
    if (!shipment_id)                    missing.push('shipment_id')
    if (allocated_amount == null)        missing.push('allocated_amount')
    if (!allocation_method)              missing.push('allocation_method')
    if (!allocation_date)                missing.push('allocation_date')

    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    // Enum validation
    if (!ALLOCATION_METHODS.includes(allocation_method as AllocationMethod)) {
      res.status(400).json({ error: 'Invalid allocation_method', valid: ALLOCATION_METHODS })
      return
    }

    // Numeric validation
    const amount = Number(allocated_amount)
    if (!isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'allocated_amount must be a positive number' })
      return
    }

    // IDOR check: receipt_id must belong to authenticated exporter
    try {
      const { rows: receiptRows } = await client.query<{ id: string }>(
        'SELECT id FROM payment_receipts WHERE id = $1 AND exporter_id = $2',
        [receipt_id, exporterId],
      )
      if (!receiptRows.length) {
        res.status(400).json({ error: 'receipt_id not found for this exporter' })
        return
      }
    } catch (err) {
      console.error('[ALLOCATIONS] POST / receipt check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    // IDOR check: shipment_id must belong to authenticated exporter
    try {
      const { rows: shipmentRows } = await client.query<{ id: string }>(
        'SELECT id FROM shipments WHERE id = $1 AND exporter_id = $2',
        [shipment_id, exporterId],
      )
      if (!shipmentRows.length) {
        res.status(400).json({ error: 'shipment_id not found for this exporter' })
        return
      }
    } catch (err) {
      console.error('[ALLOCATIONS] POST / shipment check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    // IDOR check: invoice_id must belong to same exporter and shipment (if provided)
    if (invoice_id != null) {
      try {
        const { rows: invoiceRows } = await client.query<{ id: string }>(
          'SELECT id FROM invoices WHERE id = $1 AND exporter_id = $2 AND shipment_id = $3',
          [invoice_id, exporterId, shipment_id],
        )
        if (!invoiceRows.length) {
          res.status(400).json({ error: 'invoice_id not found for this exporter and shipment' })
          return
        }
      } catch (err) {
        console.error('[ALLOCATIONS] POST / invoice check error:', err instanceof Error ? err.message : String(err))
        res.status(500).json({ error: 'Internal server error' })
        return
      }
    }

    const { data, error } = await createPaymentAllocationWithAudit(client, exporterId, actorUserId, {
      receipt_id:         String(receipt_id),
      shipment_id:        String(shipment_id),
      allocated_amount:   amount,
      allocation_method:  allocation_method as AllocationMethod,
      allocation_date:    String(allocation_date),
      invoice_id:         invoice_id  ? String(invoice_id)  : null,
      notes:              notes       ? String(notes)        : null,
    })

    if (error) {
      const pgErr = error as { code?: string; message?: string }
      if (pgErr.code === '23505') {
        res.status(400).json({ error: 'A payment allocation for this receipt and shipment already exists' })
        return
      }
      if (pgErr.code === '23514') {
        res.status(400).json({ error: 'allocated_amount would exceed receipt credited_amount' })
        return
      }
      return sendQueryError(req, res, error)
    }
    res.status(201).json({ data })
  })

  return router
}
