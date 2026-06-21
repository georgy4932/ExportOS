import type { Pool } from 'pg'
import type { BankEvidencePackRow } from '../types'
import { insertAuditEvent } from './audit'

export interface ListEvidencePacksOptions {
  exporterId?: string
  shipmentId?: string
  sealed?: boolean
}

export interface CreateBankEvidencePackInput {
  shipment_id: string
  pack_url?: string | null
  notes?: string | null
}

export async function listEvidencePacks(
  pool: Pool,
  options: ListEvidencePacksOptions = {},
): Promise<{ data: BankEvidencePackRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)           { params.push(options.exporterId);  wheres.push(`exporter_id = $${params.length}`) }
    if (options.shipmentId)           { params.push(options.shipmentId);  wheres.push(`shipment_id = $${params.length}`) }
    if (options.sealed !== undefined) { params.push(options.sealed);      wheres.push(`sealed = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<BankEvidencePackRow>(
      `SELECT * FROM bank_evidence_packs${where} ORDER BY generated_at DESC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getEvidencePack(
  pool: Pool,
  id: string,
  exporterId: string,
): Promise<{ data: BankEvidencePackRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<BankEvidencePackRow>(
      'SELECT * FROM bank_evidence_packs WHERE id = $1 AND exporter_id = $2',
      [id, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

// Assembles all snapshot/ID fields server-side and inserts a new pack version.
// generated_by and exporter_id come from caller (JWT-derived), never from client input.
// version = MAX(version)+1 for this shipment, computed inside the transaction.
export async function createBankEvidencePackWithAudit(
  pool: Pool,
  exporterId: string,
  actorUserId: string,
  input: CreateBankEvidencePackInput,
): Promise<{ data: BankEvidencePackRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows: shipRows } = await pg.query(
      'SELECT * FROM shipments WHERE id = $1 AND exporter_id = $2',
      [input.shipment_id, exporterId],
    )
    const shipment = shipRows[0]
    if (!shipment) {
      await pg.query('ROLLBACK')
      return { data: null, error: null }
    }

    const { rows: blRows } = await pg.query<{ id: string }>(
      'SELECT id FROM bills_of_lading WHERE shipment_id = $1 AND exporter_id = $2 LIMIT 1',
      [input.shipment_id, exporterId],
    )
    const bl = blRows[0]
    if (!bl) {
      await pg.query('ROLLBACK')
      return { data: null, error: null }
    }

    const { rows: contractRows } = await pg.query(
      'SELECT * FROM export_contracts WHERE id = $1 AND exporter_id = $2',
      [shipment.contract_id, exporterId],
    )
    const contract = contractRows[0] ?? null

    const { rows: crRows } = await pg.query(
      'SELECT * FROM compliance_records WHERE shipment_id = $1 AND exporter_id = $2',
      [input.shipment_id, exporterId],
    )
    const compliance = crRows[0] ?? null

    const { rows: invRows } = await pg.query<{ id: string }>(
      'SELECT id FROM invoices WHERE shipment_id = $1 AND exporter_id = $2',
      [input.shipment_id, exporterId],
    )
    const invoice_ids = invRows.map(r => r.id)

    const { rows: allocRows } = await pg.query<{ id: string; receipt_id: string }>(
      'SELECT id, receipt_id FROM payment_allocations WHERE shipment_id = $1 AND exporter_id = $2',
      [input.shipment_id, exporterId],
    )
    const allocation_ids = allocRows.map(r => r.id)
    const receipt_ids = [...new Set(allocRows.map(r => r.receipt_id))]

    let payment_evidence_ids: string[] = []
    if (receipt_ids.length > 0) {
      const { rows: evRows } = await pg.query<{ id: string }>(
        'SELECT id FROM payment_evidence WHERE receipt_id = ANY($1) AND exporter_id = $2 AND superseded_by IS NULL',
        [receipt_ids, exporterId],
      )
      payment_evidence_ids = evRows.map(r => r.id)
    }

    const { rows: vRows } = await pg.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM bank_evidence_packs WHERE shipment_id = $1 AND exporter_id = $2',
      [input.shipment_id, exporterId],
    )
    const version = vRows[0]!.v

    const { rows: packRows } = await pg.query<BankEvidencePackRow>(
      `INSERT INTO bank_evidence_packs (
        shipment_id, exporter_id, version, generated_by,
        contract_snapshot, shipment_snapshot,
        invoice_ids, bl_id, nxp_reference,
        payment_evidence_ids, receipt_ids, allocation_ids,
        compliance_status_snapshot, repatriation_status,
        pack_url, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING *`,
      [
        input.shipment_id,
        exporterId,
        version,
        actorUserId,
        JSON.stringify(contract),
        JSON.stringify(shipment),
        invoice_ids,
        bl.id,
        shipment.nxp_reference,
        payment_evidence_ids,
        receipt_ids,
        allocation_ids,
        JSON.stringify(compliance),
        compliance?.repatriation_status ?? 'NOT_DUE',
        input.pack_url  ?? null,
        input.notes     ?? null,
      ],
    )
    const pack = packRows[0]!

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'bank_evidence_pack',
      entityId:   pack.id,
      action:     'CREATE',
      eventData:  { pack_id: pack.id, shipment_id: pack.shipment_id, version: pack.version },
    })

    await pg.query('COMMIT')
    return { data: pack, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}

// Sets sealed=TRUE on the pack and marks bank_evidence_pack_generated on the compliance record.
// Relies on trg_pack_sealing_preconditions (23514) to enforce checklist completeness.
// exporter_id and actorUserId are caller-supplied from JWT, never client input.
export async function sealBankEvidencePackWithAudit(
  pool: Pool,
  id: string,
  exporterId: string,
  actorUserId: string,
): Promise<{ data: BankEvidencePackRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    const { rows } = await pg.query<BankEvidencePackRow>(
      'UPDATE bank_evidence_packs SET sealed = TRUE WHERE id = $1 AND exporter_id = $2 RETURNING *',
      [id, exporterId],
    )
    const pack = rows[0] ?? null
    if (!pack) {
      await pg.query('ROLLBACK')
      return { data: null, error: null }
    }

    await pg.query(
      'UPDATE compliance_records SET bank_evidence_pack_generated = TRUE WHERE shipment_id = $1 AND exporter_id = $2',
      [pack.shipment_id, exporterId],
    )

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'bank_evidence_pack',
      entityId:   pack.id,
      action:     'SEAL',
      eventData:  { pack_id: pack.id, shipment_id: pack.shipment_id, version: pack.version },
    })

    await pg.query('COMMIT')
    return { data: pack, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}
