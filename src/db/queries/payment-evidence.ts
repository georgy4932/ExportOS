import type { Pool } from 'pg'
import type { ChargesCode, EvidenceType, PaymentEvidenceRow } from '../types'
import { insertAuditEvent } from './audit'

export interface CreatePaymentEvidenceInput {
  evidence_type: EvidenceType
  // optional for all types
  receipt_id?: string | null
  source_document_ref?: string | null
  sender_bic?: string | null
  receiver_bic?: string | null
  instructed_amount?: number | null
  instructed_currency?: string | null
  value_date?: string | null
  charges_code?: ChargesCode | null
  ordering_customer?: string | null
  beneficiary_customer?: string | null
  remittance_info?: string | null
  document_url?: string | null
  // BANK_CREDIT_ADVICE fields — required when evidence_type = BANK_CREDIT_ADVICE
  credited_amount?: number | null
  credited_currency?: string | null
  credit_date?: string | null
  bank_ref?: string | null
  payer_account?: string | null
  payer_name?: string | null
}

export interface ListPaymentEvidenceOptions {
  exporterId?: string
  receiptId?: string
  evidenceType?: EvidenceType
}

// Inserts a payment_evidence row and its audit event in a single transaction.
// exporter_id and uploaded_by must be server-derived by the caller.
// superseded_by is NOT accepted on create — corrections work by creating a new
// row and then PATCHing the old row's superseded_by to point at the new one.
// All fields except receipt_id and superseded_by are immutable after creation
// (enforced by trg_payment_evidence_immutable BEFORE UPDATE).
export async function createPaymentEvidenceWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreatePaymentEvidenceInput,
): Promise<{ data: PaymentEvidenceRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<PaymentEvidenceRow>(
      `INSERT INTO payment_evidence (
        exporter_id, receipt_id, evidence_type,
        source_document_ref, sender_bic, receiver_bic,
        instructed_amount, instructed_currency, value_date, charges_code,
        ordering_customer, beneficiary_customer, remittance_info, document_url,
        credited_amount, credited_currency, credit_date,
        bank_ref, payer_account, payer_name,
        uploaded_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      ) RETURNING *`,
      [
        exporterId,
        input.receipt_id          ?? null,
        input.evidence_type,
        input.source_document_ref ?? null,
        input.sender_bic          ?? null,
        input.receiver_bic        ?? null,
        input.instructed_amount   ?? null,
        input.instructed_currency ?? null,
        input.value_date          ?? null,
        input.charges_code        ?? null,
        input.ordering_customer   ?? null,
        input.beneficiary_customer ?? null,
        input.remittance_info     ?? null,
        input.document_url        ?? null,
        input.credited_amount     ?? null,
        input.credited_currency   ?? null,
        input.credit_date         ?? null,
        input.bank_ref            ?? null,
        input.payer_account       ?? null,
        input.payer_name          ?? null,
        actorUserId,
      ],
    )
    const evidence = rows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'payment_evidence',
      entityId:   evidence.id,
      action:     'CREATE',
      eventData:  evidence,
    })

    await pg.query('COMMIT')
    return { data: evidence, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}

export async function listPaymentEvidence(
  pool: Pool,
  options: ListPaymentEvidenceOptions = {},
): Promise<{ data: PaymentEvidenceRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)   { params.push(options.exporterId);   wheres.push(`exporter_id   = $${params.length}`) }
    if (options.receiptId)    { params.push(options.receiptId);    wheres.push(`receipt_id    = $${params.length}`) }
    if (options.evidenceType) { params.push(options.evidenceType); wheres.push(`evidence_type = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<PaymentEvidenceRow>(
      `SELECT * FROM payment_evidence${where} ORDER BY created_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getPaymentEvidence(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: PaymentEvidenceRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<PaymentEvidenceRow>(
      'SELECT * FROM payment_evidence WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}
