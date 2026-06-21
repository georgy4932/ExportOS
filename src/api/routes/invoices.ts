import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { InvoiceType } from '../../db/types'
import { createInvoiceWithAudit, getInvoice, listInvoices } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const INVOICE_TYPES: InvoiceType[] = ['PROFORMA', 'COMMERCIAL']

export function invoicesRouter(client: DbClient): Router {
  const router = Router()

  // GET /invoices[?contract_id=&shipment_id=&invoice_type=]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const contractId = req.query.contract_id  as string | undefined
    const shipmentId = req.query.shipment_id  as string | undefined
    const typeParam  = req.query.invoice_type as string | undefined

    if (typeParam != null && !INVOICE_TYPES.includes(typeParam as InvoiceType)) {
      res.status(400).json({ error: 'Invalid invoice_type', valid: INVOICE_TYPES })
      return
    }

    try {
      const { data, error } = await listInvoices(client, {
        exporterId,
        contractId,
        shipmentId,
        invoiceType: typeParam as InvoiceType | undefined,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[INVOICES] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /invoices/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getInvoice(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Invoice not found' })
      res.json({ data })
    } catch (err) {
      console.error('[INVOICES] GET /:id error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /invoices
  // exporter_id is derived from JWT — any client-supplied value is discarded.
  // shipment_id is optional: proforma invoices may exist before shipment assignment
  //   (schema decision #4 in migration comments).
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id: _ignoredExporter,  // server-derived from JWT
      contract_id, shipment_id,
      invoice_number, invoice_type, invoice_date,
      invoice_amount, currency,
      description, document_url,
    } = req.body as Record<string, unknown>

    // Required field check
    const missing: string[] = []
    if (!contract_id)           missing.push('contract_id')
    if (!invoice_number)        missing.push('invoice_number')
    if (!invoice_type)          missing.push('invoice_type')
    if (!invoice_date)          missing.push('invoice_date')
    if (invoice_amount == null) missing.push('invoice_amount')
    if (!currency)              missing.push('currency')
    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    // Enum validation
    if (!INVOICE_TYPES.includes(invoice_type as InvoiceType)) {
      res.status(400).json({ error: 'Invalid invoice_type', valid: INVOICE_TYPES })
      return
    }

    // Numeric validation
    const amount = Number(invoice_amount)
    if (!isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'invoice_amount must be a positive number' })
      return
    }

    // IDOR check: contract_id must belong to authenticated exporter
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM export_contracts WHERE id = $1 AND exporter_id = $2',
        [contract_id, exporterId],
      )
      if (!rows.length) {
        res.status(400).json({ error: 'contract_id not found for this exporter' })
        return
      }
    } catch (err) {
      console.error('[INVOICES] POST / contract check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    // IDOR check: shipment_id must belong to authenticated exporter (if provided)
    if (shipment_id != null) {
      try {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM shipments WHERE id = $1 AND exporter_id = $2',
          [shipment_id, exporterId],
        )
        if (!rows.length) {
          res.status(400).json({ error: 'shipment_id not found for this exporter' })
          return
        }
      } catch (err) {
        console.error('[INVOICES] POST / shipment check error:', err instanceof Error ? err.message : String(err))
        res.status(500).json({ error: 'Internal server error' })
        return
      }
    }

    const { data, error } = await createInvoiceWithAudit(client, exporterId, actorUserId, {
      contract_id:    String(contract_id),
      shipment_id:    shipment_id    ? String(shipment_id)    : null,
      invoice_number: String(invoice_number),
      invoice_type:   invoice_type   as InvoiceType,
      invoice_date:   String(invoice_date),
      invoice_amount: amount,
      currency:       String(currency).toUpperCase().slice(0, 3),
      description:    description    ? String(description)    : null,
      document_url:   document_url   ? String(document_url)   : null,
    })

    if (error) {
      const pgErr = error as { code?: string }
      if (pgErr.code === '23505') {
        res.status(400).json({ error: 'An invoice with this number already exists for this exporter' })
        return
      }
      return sendQueryError(req, res, error)
    }
    res.status(201).json({ data })
  })

  return router
}
