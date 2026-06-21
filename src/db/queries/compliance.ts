import type { Pool } from 'pg'
import type { ComplianceRecordRow, ComplianceRecordWithShipmentRow, RepatriationStatus } from '../types'
import { insertAuditEvent } from './audit'

export interface ListComplianceRecordsOptions {
  exporterId?: string
  repatriationStatus?: RepatriationStatus
  lateOnly?: boolean
}

// Fields an operator may update. All trigger-derived/system fields are excluded.
// bank_evidence_pack_generated is reserved for the evidence pack generation endpoint.
// undefined means "not provided" (field stays unchanged).
// null is accepted for compliance_flags, last_reviewed_at, and notes to allow clearing.
export interface UpdateComplianceInput {
  nxp_submitted?: boolean
  nxp_approved?: boolean
  cci_obtained?: boolean
  bl_uploaded?: boolean
  payment_evidence_uploaded?: boolean
  credit_advice_confirmed?: boolean
  compliance_flags?: string[] | null
  last_reviewed_at?: string | null
  notes?: string | null
}

export async function listComplianceRecords(
  pool: Pool,
  options: ListComplianceRecordsOptions = {},
): Promise<{ data: ComplianceRecordWithShipmentRow[] | null; error: unknown }> {
  try {
    const params: unknown[] = []
    const wheres: string[] = []
    if (options.exporterId)         { params.push(options.exporterId);          wheres.push(`cr.exporter_id = $${params.length}`) }
    if (options.repatriationStatus) { params.push(options.repatriationStatus);  wheres.push(`cr.repatriation_status = $${params.length}`) }
    if (options.lateOnly)           { params.push(true);                         wheres.push(`cr.was_repatriated_late = $${params.length}`) }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''
    const { rows } = await pool.query<ComplianceRecordWithShipmentRow>(
      `SELECT cr.*, s.shipment_reference, s.nxp_reference
       FROM compliance_records cr
       LEFT JOIN shipments s ON s.id = cr.shipment_id AND s.exporter_id = cr.exporter_id${where}
       ORDER BY cr.repatriation_deadline ASC`,
      params,
    )
    return { data: rows, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

export async function getComplianceByShipment(
  pool: Pool,
  shipmentId: string,
  exporterId: string,
): Promise<{ data: ComplianceRecordRow | null; error: unknown }> {
  try {
    const { rows } = await pool.query<ComplianceRecordRow>(
      'SELECT * FROM compliance_records WHERE shipment_id = $1 AND exporter_id = $2',
      [shipmentId, exporterId],
    )
    return { data: rows[0] ?? null, error: null }
  } catch (err) {
    return { data: null, error: err }
  }
}

// Updates only the operator-controlled checklist fields and writes an UPDATE audit event
// in a single transaction. updated_at is auto-refreshed by trg_compliance_records_updated_at.
// Returns { data: null, error: null } if no row matched (caller returns 404).
export async function updateComplianceRecordWithAudit(
  pool: Pool,
  shipmentId: string,
  exporterId: string,
  actorUserId: string,
  input: UpdateComplianceInput,
): Promise<{ data: ComplianceRecordRow | null; error: unknown }> {
  const pg = await pool.connect()
  try {
    await pg.query('BEGIN')

    // Build a dynamic SET clause from only the fields present in input.
    // updated_at is handled by the BEFORE UPDATE trigger — not listed here.
    const sets: string[] = []
    const params: unknown[] = []

    const addField = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${params.length}`)
    }

    if (input.nxp_submitted !== undefined)             addField('nxp_submitted', input.nxp_submitted)
    if (input.nxp_approved !== undefined)              addField('nxp_approved', input.nxp_approved)
    if (input.cci_obtained !== undefined)              addField('cci_obtained', input.cci_obtained)
    if (input.bl_uploaded !== undefined)               addField('bl_uploaded', input.bl_uploaded)
    if (input.payment_evidence_uploaded !== undefined) addField('payment_evidence_uploaded', input.payment_evidence_uploaded)
    if (input.credit_advice_confirmed !== undefined)   addField('credit_advice_confirmed', input.credit_advice_confirmed)
    if (input.compliance_flags !== undefined)          addField('compliance_flags', input.compliance_flags)
    if (input.last_reviewed_at !== undefined)          addField('last_reviewed_at', input.last_reviewed_at)
    if (input.notes !== undefined)                     addField('notes', input.notes)

    if (sets.length === 0) {
      await pg.query('ROLLBACK')
      return { data: null, error: null }
    }

    params.push(shipmentId)
    params.push(exporterId)

    const { rows } = await pg.query<ComplianceRecordRow>(
      `UPDATE compliance_records
          SET ${sets.join(', ')}
        WHERE shipment_id = $${params.length - 1} AND exporter_id = $${params.length}
      RETURNING *`,
      params,
    )
    const updated = rows[0]
    if (!updated) {
      await pg.query('ROLLBACK')
      return { data: null, error: null }
    }

    await insertAuditEvent(pg, {
      exporterId,
      actorUserId,
      entityType: 'compliance_record',
      entityId:   updated.id,
      action:     'UPDATE',
      eventData:  updated,
    })

    await pg.query('COMMIT')
    return { data: updated, error: null }
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => {})
    return { data: null, error: err }
  } finally {
    pg.release()
  }
}
