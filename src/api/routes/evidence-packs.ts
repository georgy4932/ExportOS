import { Router } from 'express'
import type { DbClient } from '../../db/client'
import {
  listEvidencePacks,
  getEvidencePack,
  createBankEvidencePackWithAudit,
  sealBankEvidencePackWithAudit,
} from '../../db/queries/index'
import { sendQueryError } from '../middleware/query-error'

export function evidencePacksRouter(client: DbClient): Router {
  const router = Router()

  // GET /evidence-packs[?shipment_id=&sealed=true|false]
  router.get('/', async (req, res) => {
    const exporterId = res.locals.exporterId
    const shipmentId = req.query.shipment_id as string | undefined
    const sealedParam = req.query.sealed as string | undefined
    const sealed =
      sealedParam === 'true'  ? true  :
      sealedParam === 'false' ? false :
      undefined

    try {
      const { data, error } = await listEvidencePacks(client, {
        exporterId,
        shipmentId,
        sealed,
      })
      if (error) return sendQueryError(req, res, error)
      res.json({ data: data ?? [], count: data?.length ?? 0 })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // GET /evidence-packs/:id
  router.get('/:id', async (req, res) => {
    const exporterId = res.locals.exporterId
    const id = req.params['id'] as string

    try {
      const { data, error } = await getEvidencePack(client, id, exporterId)
      if (error) return sendQueryError(req, res, error)
      if (!data) return res.status(404).json({ error: 'Evidence pack not found' })
      res.json({ data })
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // POST /evidence-packs
  // Only shipment_id, pack_url, and notes are accepted from the client.
  // exporter_id and generated_by are server-derived from JWT.
  // All snapshot/ID fields are assembled server-side inside the transaction.
  router.post('/', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId

    const {
      exporter_id:   _ignoredExporter,
      generated_by:  _ignoredGeneratedBy,
      shipment_id,
      pack_url,
      notes,
    } = req.body as Record<string, unknown>

    if (!shipment_id || typeof shipment_id !== 'string') {
      res.status(400).json({ error: 'Missing required field: shipment_id' })
      return
    }

    // IDOR check: shipment must belong to authenticated exporter
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
      console.error('[EVIDENCE-PACKS] POST / shipment check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    // Bill of lading must exist — required for pack assembly
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM bills_of_lading WHERE shipment_id = $1 AND exporter_id = $2 LIMIT 1',
        [shipment_id, exporterId],
      )
      if (!rows.length) {
        res.status(400).json({ error: 'No bill of lading found for this shipment — upload a BL before generating an evidence pack' })
        return
      }
    } catch (err) {
      console.error('[EVIDENCE-PACKS] POST / BL check error:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    const { data, error } = await createBankEvidencePackWithAudit(client, exporterId, actorUserId, {
      shipment_id,
      pack_url: pack_url ? String(pack_url) : null,
      notes:    notes    ? String(notes)    : null,
    })

    if (error) {
      const e = error as Record<string, unknown>
      if ((e.code as string) === '23505') {
        res.status(409).json({ error: 'Version conflict — another pack was created concurrently. Retry.' })
        return
      }
      return sendQueryError(req, res, error)
    }
    if (!data) {
      res.status(400).json({ error: 'Could not create evidence pack — shipment or bill of lading not found' })
      return
    }
    res.status(201).json({ data })
  })

  // PATCH /evidence-packs/:id/seal
  // Seals the pack and marks compliance_records.bank_evidence_pack_generated = TRUE.
  // exporter_id and actor_user_id are server-derived from JWT.
  // Precondition enforcement delegated to trg_pack_sealing_preconditions (23514).
  router.patch('/:id/seal', async (req, res) => {
    const exporterId  = res.locals.exporterId
    const actorUserId = res.locals.userId
    const id          = req.params['id'] as string

    const { data: pack, error: fetchErr } = await getEvidencePack(client, id, exporterId)
    if (fetchErr) return sendQueryError(req, res, fetchErr)
    if (!pack) {
      res.status(404).json({ error: 'Evidence pack not found' })
      return
    }

    if (pack.sealed) {
      res.status(409).json({ error: 'Bank evidence pack has already been sealed' })
      return
    }

    const { data, error } = await sealBankEvidencePackWithAudit(client, id, exporterId, actorUserId)

    if (error) {
      const e = error as Record<string, unknown>
      if ((e.code as string) === '23514') {
        const msg = String(e.message ?? '')
        // trg_bank_evidence_pack_sealed fires for already-sealed (race condition)
        if (msg.includes('sealed and cannot be modified')) {
          res.status(409).json({ error: 'Bank evidence pack has already been sealed' })
        } else {
          res.status(400).json({ error: msg })
        }
        return
      }
      return sendQueryError(req, res, error)
    }

    if (!data) {
      res.status(404).json({ error: 'Evidence pack not found' })
      return
    }
    res.json({ data })
  })

  return router
}
