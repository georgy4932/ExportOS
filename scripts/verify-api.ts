/**
 * Runtime verification for the ExportOS read-only API.
 * Calls the running server and asserts correctness against seeded data.
 *
 * Prerequisites:
 *   supabase start && supabase db reset   (seed data must be loaded)
 *   npm run api                           (server must be running, separate terminal)
 *   npm run verify-api
 *
 * Checks:
 *   1. GET /contracts          — 200, >= 1 contract
 *   2. GET /shipments          — 200, >= 2 shipments
 *   3. GET /compliance         — 200, >= 2 compliance records
 *   4. GET /evidence-packs     — 200, >= 2 packs
 *   5. Missing header          — 400 on any endpoint
 *   6. Unknown exporter ID     — 200 but empty results (no data leak)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE       = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EXPORTER   = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const UNKNOWN_ID = '00000000-dead-beef-0000-000000000000'

let passed = 0
let failed = 0

function ok(label: string) {
  console.log(`  ✓ ${label}`)
  passed++
}

function fail(label: string, detail: string) {
  console.error(`  ✗ ${label}: ${detail}`)
  failed++
}

type JsonBody = { data?: unknown[]; count?: number; error?: string } | null

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: JsonBody }> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers })
    const body = await res.json() as JsonBody
    return { status: res.status, body }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`fetch ${BASE}${path} failed: ${msg}`)
  }
}

async function main() {
  console.log('=== ExportOS v0.2 — API Verification ===')
  console.log(`  server:      ${BASE}`)
  console.log(`  exporter_id: ${EXPORTER}\n`)

  const H = { 'X-Exporter-Id': EXPORTER }

  // ── Check 1: GET /contracts returns 200 and >= 1 contract ─────────────────
  {
    const { status, body } = await get('/contracts', H)
    const data = body?.data
    if (status !== 200) {
      fail('GET /contracts — status', `expected 200, got ${status}`)
    } else if (!Array.isArray(data) || data.length < 1) {
      fail('GET /contracts — count', `expected >= 1 contract, got ${Array.isArray(data) ? data.length : 'non-array'}`)
    } else {
      ok(`GET /contracts — 200, ${data.length} contract(s)`)
    }
  }

  // ── Check 2: GET /shipments returns 200 and >= 2 shipments ────────────────
  {
    const { status, body } = await get('/shipments', H)
    const data = body?.data
    if (status !== 200) {
      fail('GET /shipments — status', `expected 200, got ${status}`)
    } else if (!Array.isArray(data) || data.length < 2) {
      fail('GET /shipments — count', `expected >= 2 shipments, got ${Array.isArray(data) ? data.length : 'non-array'}`)
    } else {
      ok(`GET /shipments — 200, ${data.length} shipment(s)`)
    }
  }

  // ── Check 3: GET /compliance returns 200 and >= 2 records ─────────────────
  {
    const { status, body } = await get('/compliance', H)
    const data = body?.data
    if (status !== 200) {
      fail('GET /compliance — status', `expected 200, got ${status}`)
    } else if (!Array.isArray(data) || data.length < 2) {
      fail('GET /compliance — count', `expected >= 2 records, got ${Array.isArray(data) ? data.length : 'non-array'}`)
    } else {
      ok(`GET /compliance — 200, ${data.length} record(s)`)
    }
  }

  // ── Check 4: GET /evidence-packs returns 200 and >= 2 packs ──────────────
  {
    const { status, body } = await get('/evidence-packs', H)
    const data = body?.data
    if (status !== 200) {
      fail('GET /evidence-packs — status', `expected 200, got ${status}`)
    } else if (!Array.isArray(data) || data.length < 2) {
      fail('GET /evidence-packs — count', `expected >= 2 packs, got ${Array.isArray(data) ? data.length : 'non-array'}`)
    } else {
      ok(`GET /evidence-packs — 200, ${data.length} pack(s)`)
    }
  }

  // ── Check 5: Missing X-Exporter-Id returns 400 ────────────────────────────
  {
    const { status, body } = await get('/contracts')  // no header
    if (status !== 400) {
      fail('missing X-Exporter-Id — status', `expected 400, got ${status}`)
    } else if (!body?.error) {
      fail('missing X-Exporter-Id — error body', 'expected { error: string }')
    } else {
      ok(`missing X-Exporter-Id — 400 "${body.error}"`)
    }
  }

  // ── Check 6: Unknown exporter ID returns empty results, not 403 ───────────
  {
    const { status, body } = await get('/contracts', { 'X-Exporter-Id': UNKNOWN_ID })
    const data = body?.data
    if (status !== 200) {
      fail('unknown exporter_id — status', `expected 200 (empty), got ${status}`)
    } else if (!Array.isArray(data) || data.length !== 0) {
      fail('unknown exporter_id — data leak', `expected empty array, got ${JSON.stringify(data)?.slice(0, 80)}`)
    } else {
      ok(`unknown exporter_id — 200, 0 results (no data leak)`)
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
