import type { Pool } from 'pg'
import type { AllocationMethod, PaymentAllocationRow } from '../types'
import { insertAuditEvent } from './audit'

export interface CreatePaymentAllocationInput {
  receipt_id: string
  shipment_id: string
  allocated_amount: number
  allocation_method: AllocationMethod
  allocation_date: string
  // optional
  invoice_id?: string | null
  notes?: string | null
}

export interface ListPaymentAllocationsOptions {
  exporterId?: string
  receiptId?: string
  shipmentId?: string
}

// Inserts a payment allocation and its audit event in a single transaction.
// exporter_id and allocated_by must be server-derived by the caller.
// Caller must have already verified receipt_id, shipment_id, and invoice_id (if set)
// belong to the authenticated exporter.
// trg_allocation_integrity fires BEFORE INSERT and raises check_violation (23514)
// if total allocated would exceed receipt credited_amount.
// trg_allocation_side_effects fires AFTER INSERT and syncs:
//   - payment_receipts.allocation_status
//   - compliance_records.proceeds_received + repatriation_status
//   - shipments.status (if departed)
export async function createPaymentAllocationWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreatePaymentAllocationInput,
): Promise<{ data: PaymentAllocationRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<PaymentAllocationRow>(
      `INSERT INTO payment_allocations (
        exporter_id, receipt_id, shipment_id, invoice_id,
        allocated_amount, allocation_method, allocation_date,
        allocated_by, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      ) RETURNING *`,
      [
        exporterId,
        input.receipt_id,
        input.shipment_id,
        input.invoice_id   ?? null,
        input.allocated_amount,
        input.allocation_method,
        input.allocation_date,
        actorUserId,
        input.notes        ?? null,
      ],
    )
    const allocation = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'payment_allocation',
      entityId:   allocation.id,
      action:     'CREATE',
      eventData:  allocation,
    })

    await pg.query('COMMIT')
    return { data: allocation, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}

export async function listPaymentAllocations(
  pool: Pool,
  options: ListPaymentAllocationsOptions = {},
): Promise<{ data: PaymentAllocationRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId) { params.push(options.exporterId); wheres.push(`exporter_id = $${params.length}`) }
    if (options.receiptId)  { params.push(options.receiptId);  wheres.push(`receipt_id  = $${params.length}`) }
    if (options.shipmentId) { params.push(options.shipmentId); wheres.push(`shipment_id = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<PaymentAllocationRow>(
      `SELECT * FROM payment_allocations${where} ORDER BY allocation_date DESC, created_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getPaymentAllocation(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: PaymentAllocationRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<PaymentAllocationRow>(
      'SELECT * FROM payment_allocations WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
