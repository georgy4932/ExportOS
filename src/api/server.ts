/**
 * ExportOS v0.2 — Read-Only API Server
 *
 * Run:
 *   cp .env.example .env.local
 *   npm run api
 *
 * Routes (all read-only):
 *   POST /auth/login                       { email, password } → { token }
 *   GET  /auth/me                          current user + exporter
 *   GET  /contracts[?status=]
 *   GET  /contracts/:id
 *   GET  /shipments[?contract_id=&fully_reconciled=]
 *   GET  /shipments/:id
 *   GET  /compliance[?status=&late_only=]
 *   GET  /compliance/:shipmentId
 *   GET  /evidence-packs[?shipment_id=&sealed=]
 *   GET  /evidence-packs/:id
 *   GET  /health
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import express from 'express'
import path from 'path'
import { createDbClient } from '../db/client'
import { requireAuth } from './middleware/require-auth'
import { authRouter } from './routes/auth'
import { contractsRouter } from './routes/contracts'
import { shipmentsRouter } from './routes/shipments'
import { complianceRouter } from './routes/compliance'
import { evidencePacksRouter } from './routes/evidence-packs'

const dbUrl     = process.env.DATABASE_URL
const jwtSecret = process.env.JWT_SECRET

if (!dbUrl) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env.local.')
  process.exit(1)
}
if (!jwtSecret) {
  console.error('Missing JWT_SECRET. Copy .env.example to .env.local.')
  process.exit(1)
}

const client = createDbClient(dbUrl)

const app = express()
app.disable('x-powered-by')
app.use(express.json())
app.use(express.static(path.join(process.cwd(), 'public')))

// Health check — no auth required
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Auth routes — no token required to reach /auth/login
app.use('/auth', authRouter(client))

// All data routes require a valid Bearer JWT
const auth = requireAuth(client)
app.use('/contracts',      auth, contractsRouter(client))
app.use('/shipments',      auth, shipmentsRouter(client))
app.use('/compliance',     auth, complianceRouter(client))
app.use('/evidence-packs', auth, evidencePacksRouter(client))

// 404 for anything else
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

const PORT = Number(process.env.PORT ?? 3000)
app.listen(PORT, () => {
  console.log(`ExportOS API listening on http://localhost:${PORT}`)
  console.warn('[WARN] local_users auth is active (v0.2 dev mode). Not for production use.')
})
