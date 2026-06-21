import type { Pool } from 'pg'
import type { InvoiceRow, InvoiceType } from '../types'
import { insertAuditEvent } from './audit'

export interface CreateInvoiceInput {
  contract_id: string
  invoice_number: string
  invoice_type: InvoiceType
  invoice_date: string
  invoice_amount: number
  currency: string
  // optional
  shipment_id?: string | null
  description?: string | null
  document_url?: string | null
}

export interface ListInvoicesOptions {
  exporterId?: string
  contractId?: string
  shipmentId?: string
  invoiceType?: InvoiceType
}

// Inserts an invoice row and its audit event in a single transaction.
// exporter_id must be server-derived by the caller.
export async function createInvoiceWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreateInvoiceInput,
): Promise<{ data: InvoiceRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<InvoiceRow>(
      `INSERT INTO invoices (
        exporter_id, contract_id, shipment_id,
        invoice_number, invoice_type, invoice_date,
        invoice_amount, currency, description, document_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      ) RETURNING *`,
      [
        exporterId,
        input.contract_id,
        input.shipment_id    ?? null,
        input.invoice_number,
        input.invoice_type,
        input.invoice_date,
        input.invoice_amount,
        input.currency,
        input.description    ?? null,
        input.document_url   ?? null,
      ],
    )
    const invoice = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'invoice',
      entityId:   invoice.id,
      action:     'CREATE',
      eventData:  invoice,
    })

    await pg.query('COMMIT')
    return { data: invoice, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}

export async function getInvoice(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: InvoiceRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function listInvoices(
  pool: Pool,
  options: ListInvoicesOptions = {},
): Promise<{ data: InvoiceRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)  { params.push(options.exporterId);  wheres.push(`exporter_id  = $${params.length}`) }
    if (options.contractId)  { params.push(options.contractId);  wheres.push(`contract_id  = $${params.length}`) }
    if (options.shipmentId)  { params.push(options.shipmentId);  wheres.push(`shipment_id  = $${params.length}`) }
    if (options.invoiceType) { params.push(options.invoiceType); wheres.push(`invoice_type = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT * FROM invoices${where} ORDER BY invoice_date DESC, created_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
