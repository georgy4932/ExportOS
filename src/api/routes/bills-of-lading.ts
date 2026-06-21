import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { BlType, DeadlineStatus, FreightTerms } from '../../db/types'
import { createBillOfLadingWithAudit, listBLDeadlines } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const BL_TYPES: BlType[]               = ['ORIGINAL', 'TELEX_RELEASE', 'SEA_WAYBILL', 'EXPRESS_BL']
const FREIGHT_TERMS: FreightTerms[]    = ['PREPAID', 'COLLECT']
const DEADLINE_STATUSES: DeadlineStatus[] = ['SAFE', 'WARNING', 'CRITICAL', 'OVERDUE']

export function billsOfLadingRouter(client: DbClient): Router {
  const router = Router()

  // GET /bills-of-lading[?deadline_status=SAFE|WARNING|CRITICAL|OVERDUE]
  router.get('/', async (req, res) => {
    const exporterId         = res.locals.exporterId
    const deadlineStatusParam = req.query.deadline_status as string | undefined

    if (deadlineStatusParam != null && !DEADLINE_STATUSES.includes(deadlineStatusParam as DeadlineStatus)) {
      res.status(400).json({ error: 'Invalid deadline_status', valid: DEADLINE_STATUSES })
      return
    }
    const deadlineStatus = deadlineStatusParam as DeadlineStatus | undefined

    try {
      const { data, error } = await listBLDeadlines(client, { exporterId, deadlineStatus })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[BL] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /bills-of-lading
  // exporter_id and actorUserId are derived from JWT — any client-supplied exporter_id is discarded.
  // repatriation_days and repatriation_deadline are computed by DB trigger trg_bl_compute_deadline.
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id: _ignored,
      repatriation_days: _rep_days,       // trigger-computed, never from client
      repatriation_deadline: _rep_dl,     // trigger-computed, never from client
      shipment_id, bl_number, bl_date, bl_type,
      shipper_name, consignee_name, description_of_goods, nxp_reference,
      notify_party, gross_weight_kg, number_of_packages, container_numbers,
      freight_terms, place_of_receipt, place_of_delivery, document_url,
    } = req.body as Record<string, unknown>

    // Required field validation
    const missing: string[] = []
    if (!shipment_id)           missing.push('shipment_id')
    if (!bl_number)             missing.push('bl_number')
    if (!bl_date)               missing.push('bl_date')
    if (!bl_type)               missing.push('bl_type')
    if (!shipper_name)          missing.push('shipper_name')
    if (!consignee_name)        missing.push('consignee_name')
    if (!description_of_goods)  missing.push('description_of_goods')
    if (!nxp_reference)         missing.push('nxp_reference')

    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    // Enum validation
    if (!BL_TYPES.includes(bl_type as BlType)) {
      res.status(400).json({ error: 'Invalid bl_type', valid: BL_TYPES })
      return
    }
    if (freight_terms != null && !FREIGHT_TERMS.includes(freight_terms as FreightTerms)) {
      res.status(400).json({ error: 'Invalid freight_terms', valid: FREIGHT_TERMS })
      return
    }

    // Numeric validation for optional numeric fields
    if (gross_weight_kg != null) {
      const w = Number(gross_weight_kg)
      if (!isFinite(w) || w <= 0) { res.status(400).json({ error: 'gross_weight_kg must be a positive number' }); return }
    }
    if (number_of_packages != null) {
      const n = Number(number_of_packages)
      if (!isFinite(n) || n <= 0 || !Number.isInteger(n)) { res.status(400).json({ error: 'number_of_packages must be a positive integer' }); return }
    }

    // Shipment ownership check — IDOR protection
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
      console.error('[BL] POST / shipment check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const { data, error } = await createBillOfLadingWithAudit(client, exporterId, actorUserId, {
      shipment_id:          String(shipment_id),
      bl_number:            String(bl_number),
      bl_date:              String(bl_date),
      bl_type:              bl_type as BlType,
      shipper_name:         String(shipper_name),
      consignee_name:       String(consignee_name),
      description_of_goods: String(description_of_goods),
      nxp_reference:        String(nxp_reference),
      notify_party:         notify_party         ? String(notify_party)           : null,
      gross_weight_kg:      gross_weight_kg      != null ? Number(gross_weight_kg)      : null,
      number_of_packages:   number_of_packages   != null ? Number(number_of_packages)   : null,
      container_numbers:    Array.isArray(container_numbers) ? container_numbers.map(String) : null,
      freight_terms:        freight_terms        ? freight_terms as FreightTerms   : null,
      place_of_receipt:     place_of_receipt     ? String(place_of_receipt)        : null,
      place_of_delivery:    place_of_delivery    ? String(place_of_delivery)       : null,
      document_url:         document_url         ? String(document_url)            : null,
    })

    if (error) {
      const pgErr = error as { code?: string; constraint?: string }
      if (pgErr.code === '23505') {
        const msg = pgErr.constraint === 'bills_of_lading_shipment_id_key'
          ? 'A bill of lading already exists for this shipment'
          : 'A bill of lading with this bl_number already exists for this exporter'
        res.status(400).json({ error: msg })
        return
      }
      return sendQueryError(req, res, error)
    }
    res.status(201).json({ data })
  })

  return router
}
