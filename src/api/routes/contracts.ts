import { Router } from 'express'
import type { DbClient } from '../../db/client'
import type { CommodityType, ContractStatus } from '../../db/types'
import { listContractSummaries, getContractSummary, createContract } from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

const COMMODITY_TYPES: CommodityType[] = ['NON_OIL', 'OIL_GAS']

export function contractsRouter(client: DbClient): Router {
  const router = Router()

  // GET /contracts[?status=ACTIVE]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const status = req.query.status as ContractStatus | undefined

    try {
      const { data, error } = await listContractSummaries(client, { exporterId, status })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      console.error('[CONTRACTS] GET / error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /contracts/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getContractSummary(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Contract not found' })
      res.json({ data })
    } catch (err) {
      console.error('[CONTRACTS] GET /:id error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /contracts
  // exporter_id is derived from the authenticated user — any client-supplied value is discarded.
  router.post('/', async (req, res) => {
    const exporterId = res.locals.exporterId

    const {
      exporter_id: _ignored,  // strip: never accepted from client
      contract_reference, counterparty_id, commodity, commodity_type,
      hs_code, contract_quantity, quantity_unit, contract_value,
      currency, unit_price, incoterms, destination_country,
      destination_port, payment_terms, partial_shipment_allowed,
      contract_date, expiry_date, notes,
    } = req.body as Record<string, unknown>

    // Required field check
    const missing: string[] = []
    if (!contract_reference)       missing.push('contract_reference')
    if (!counterparty_id)          missing.push('counterparty_id')
    if (!commodity)                missing.push('commodity')
    if (!commodity_type)           missing.push('commodity_type')
    if (!hs_code)                  missing.push('hs_code')
    if (contract_quantity == null) missing.push('contract_quantity')
    if (!quantity_unit)            missing.push('quantity_unit')
    if (contract_value == null)    missing.push('contract_value')
    if (!currency)                 missing.push('currency')
    if (unit_price == null)        missing.push('unit_price')
    if (!incoterms)                missing.push('incoterms')
    if (!destination_country)      missing.push('destination_country')
    if (!payment_terms)            missing.push('payment_terms')
    if (!contract_date)            missing.push('contract_date')

    if (missing.length > 0) {
      res.status(400).json({ error: 'Missing required fields', fields: missing })
      return
    }

    // Enum validation
    if (!COMMODITY_TYPES.includes(commodity_type as CommodityType)) {
      res.status(400).json({ error: 'Invalid commodity_type', valid: COMMODITY_TYPES })
      return
    }

    // Numeric validation
    const qty   = Number(contract_quantity)
    const val   = Number(contract_value)
    const price = Number(unit_price)
    if (!isFinite(qty)   || qty   <= 0) { res.status(400).json({ error: 'contract_quantity must be a positive number' }); return }
    if (!isFinite(val)   || val   <= 0) { res.status(400).json({ error: 'contract_value must be a positive number' }); return }
    if (!isFinite(price) || price <= 0) { res.status(400).json({ error: 'unit_price must be a positive number' }); return }

    // Counterparty ownership check — prevents supplying a counterparty from another exporter
    try {
      const { rows: cpRows } = await client.query<{ id: string }>(
        'SELECT id FROM counterparties WHERE id = $1 AND exporter_id = $2',
        [counterparty_id, exporterId],
      )
      if (!cpRows.length) {
        res.status(400).json({ error: 'counterparty_id not found for this exporter' })
        return
      }
    } catch (err) {
      console.error('[CONTRACTS] POST / counterparty check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const { data, error } = await createContract(client, exporterId, {
      contract_reference: String(contract_reference),
      counterparty_id:    String(counterparty_id),
      commodity:          String(commodity),
      commodity_type:     commodity_type as CommodityType,
      hs_code:            String(hs_code),
      contract_quantity:  qty,
      quantity_unit:      String(quantity_unit),
      contract_value:     val,
      currency:           String(currency).toUpperCase().slice(0, 3),
      unit_price:         price,
      incoterms:          String(incoterms).toUpperCase(),
      destination_country: String(destination_country).toUpperCase().slice(0, 2),
      destination_port:   destination_port ? String(destination_port) : null,
      payment_terms:      String(payment_terms),
      partial_shipment_allowed: Boolean(partial_shipment_allowed),
      contract_date:      String(contract_date),
      expiry_date:        expiry_date ? String(expiry_date) : null,
      notes:              notes ? String(notes) : null,
    })

    if (error) return sendQueryError(req, res, error)
    res.status(201).json({ data })
  })

  return router
}
