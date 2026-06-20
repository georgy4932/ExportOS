/**
 * ExportOS v0.2 — Read-Only API Server
 *
 * Exposes the existing query layer over HTTP. No write endpoints.
 * All routes require X-Exporter-Id header for tenant scoping.
 *
 * Run:
 *   cp .env.example .env.local   (fill in DATABASE_URL)
 *   npm run api
 *
 * Routes:
 *   GET /contracts                         list contracts (optional ?status=)
 *   GET /contracts/:id                     single contract
 *   GET /shipments                         list shipments (optional ?contract_id= ?fully_reconciled=)
 *   GET /shipments/:id                     single shipment
 *   GET /compliance                        list compliance records (optional ?status= ?late_only=)
 *   GET /compliance/:shipmentId            compliance record for a shipment
 *   GET /evidence-packs                    list evidence packs (optional ?shipment_id= ?sealed=)
 *   GET /evidence-packs/:id               single evidence pack
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import express from 'express'
import { createDbClient } from '../db/client'
import { contractsRouter } from './routes/contracts'
import { shipmentsRouter } from './routes/shipments'
import { complianceRouter } from './routes/compliance'
import { evidencePacksRouter } from './routes/evidence-packs'

const dbUrl = process.env.DATABASE_URL

if (!dbUrl) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env.local and fill in values.')
  process.exit(1)
}

const client = createDbClient(dbUrl)

const app = express()
app.disable('x-powered-by')
app.use(express.json())

app.use('/contracts',      contractsRouter(client))
app.use('/shipments',      shipmentsRouter(client))
app.use('/compliance',     complianceRouter(client))
app.use('/evidence-packs', evidencePacksRouter(client))

// Health check — no exporter scoping required
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// 404 for anything else
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

const PORT = Number(process.env.PORT ?? 3000)
app.listen(PORT, () => {
  console.log(`ExportOS API listening on http://localhost:${PORT}`)
  console.log('Routes: GET /contracts /shipments /compliance /evidence-packs (each with /:id)')
})
