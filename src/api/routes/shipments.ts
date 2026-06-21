import { Router } from 'express'
import type { DbClient } from '../../db/client'
import { listShipmentReconciliation, getShipmentReconciliation, createShipmentWithAudit } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function shipmentsRouter(client: DbClient): Router {
  const router = Router()

  // GET /shipments[?contract_id=&fully_reconciled=true|false]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const contractId = req.query.contract_id as string | undefined
    const fullyReconciledParam = req.query.fully_reconciled as string | undefined
    const fullyReconciled =
      fullyReconciledParam === 'true'  ? true  :
      fullyReconciledParam === 'false' ? false :
      undefined

    try {
      const { data, error } = await listShipmentReconciliation(client, {
        exporterId,
        contractId,
        fullyReconciled,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /shipments
  // exporter_id is derived from JWT — any client-supplied exporter_id is discarded.
  // shipment_sequence is auto-assigned (MAX + 1 per contract, within the transaction).
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id: _ignored,
      contract_id, shipment_reference, nxp_reference,
      port_of_loading, port_of_discharge,
      shipment_quantity, shipment_value, currency,
      shipping_line, vessel_name, voyage_number,
    } = req.body as Record<string, unknown>

    const missing: string[] = []
    if (!contract_id)           missing.push('contract_id')
    if (!shipment_reference)    missing.push('shipment_reference')
    if (!nxp_reference)         missing.push('nxp_reference')
    if (!port_of_loading)       missing.push('port_of_loading')
    if (!port_of_discharge)     missing.push('port_of_discharge')
    if (shipment_quantity == null) missing.push('shipment_quantity')
    if (shipment_value == null)    missing.push('shipment_value')
    if (!currency)              missing.push('currency')

    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    const qty = Number(shipment_quantity)
    const val = Number(shipment_value)
    if (!isFinite(qty) || qty <= 0) { res.status(400).json({ error: 'shipment_quantity must be a positive number' }); return }
    if (!isFinite(val) || val <= 0) { res.status(400).json({ error: 'shipment_value must be a positive number' }); return }

    // Contract ownership check — IDOR protection
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
      console.error('[SHIPMENTS] POST / contract check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const { data, error } = await createShipmentWithAudit(client, exporterId, actorUserId, {
      contract_id:        String(contract_id),
      shipment_reference: String(shipment_reference),
      nxp_reference:      String(nxp_reference),
      port_of_loading:    String(port_of_loading),
      port_of_discharge:  String(port_of_discharge),
      shipment_quantity:  qty,
      shipment_value:     val,
      currency:           String(currency).toUpperCase().slice(0, 3),
      shipping_line:      shipping_line ? String(shipping_line) : null,
      vessel_name:        vessel_name   ? String(vessel_name)   : null,
      voyage_number:      voyage_number ? String(voyage_number) : null,
    })

    if (error) return sendQueryError(req, res, error)
    res.status(201).json({ data })
  })

  // GET /shipments/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getShipmentReconciliation(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Shipment not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
