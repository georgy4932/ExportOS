import type { Pool } from 'pg'
import type { AllocationStatus, DiscrepancyStatus, PaymentReceiptRow } from '../types'
import { insertAuditEvent } from './audit'

export interface CreatePaymentReceiptInput {
  receipt_reference: string
  credit_date: string
  currency: string
  instructed_amount: number
  credited_amount: number
  // optional
  value_date?: string | null
  domiciliary_account_ref?: string | null
  ordering_bank_bic?: string | null
  ordering_customer_name?: string | null
  remittance_info?: string | null
  discrepancy_notes?: string | null
}

export interface ListPaymentReceiptsOptions {
  exporterId?: string
  allocationStatus?: AllocationStatus
  discrepancyStatus?: DiscrepancyStatus
}

// Inserts a payment receipt and its audit event in a single transaction.
// exporter_id and actorUserId must be server-derived by the caller.
// discrepancy_status is set by DB trigger trg_payment_receipt_discrepancy (BEFORE INSERT).
// charges_deducted and amount_variance are GENERATED columns — never accepted from client.
export async function createPaymentReceiptWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreatePaymentReceiptInput,
): Promise<{ data: PaymentReceiptRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<PaymentReceiptRow>(
      `INSERT INTO payment_receipts (
        exporter_id, receipt_reference, credit_date, currency,
        instructed_amount, credited_amount,
        value_date, domiciliary_account_ref, ordering_bank_bic,
        ordering_customer_name, remittance_info, discrepancy_notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) RETURNING *`,
      [
        exporterId,
        input.receipt_reference,
        input.credit_date,
        input.currency,
        input.instructed_amount,
        input.credited_amount,
        input.value_date           ?? null,
        input.domiciliary_account_ref ?? null,
        input.ordering_bank_bic    ?? null,
        input.ordering_customer_name  ?? null,
        input.remittance_info      ?? null,
        input.discrepancy_notes    ?? null,
      ],
    )
    const receipt = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'payment_receipt',
      entityId:   receipt.id,
      action:     'CREATE',
      eventData:  receipt,
    })

    await pg.query('COMMIT')
    return { data: receipt, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}

export async function getPaymentReceipt(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: PaymentReceiptRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<PaymentReceiptRow>(
      'SELECT * FROM payment_receipts WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function listPaymentReceipts(
  pool: Pool,
  options: ListPaymentReceiptsOptions = {},
): Promise<{ data: PaymentReceiptRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)       { params.push(options.exporterId);       wheres.push(`exporter_id = $${params.length}`) }
    if (options.allocationStatus) { params.push(options.allocationStatus); wheres.push(`allocation_status = $${params.length}`) }
    if (options.discrepancyStatus){ params.push(options.discrepancyStatus);wheres.push(`discrepancy_status = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<PaymentReceiptRow>(
      `SELECT * FROM payment_receipts${where} ORDER BY credit_date DESC, created_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
