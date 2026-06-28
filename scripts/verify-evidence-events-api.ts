/**
 * Runtime verification for GET /export-cases/:nxp/evidence/:type/events
 * — evidence event history retrieval (RC4 read path).
 *
 * Prerequisites:
 *   npm run db:reset            (applies migrations + seed; backfills evidence_events)
 *   npm run api                 (server running in a separate terminal)
 *   npm run verify-evidence-events-api
 *
 * Seed state assumed:
 *   - NXP_1 (NXP-2026-SES-001) exists with 7 evidence_items rows
 *   - RC4_004 migration backfilled one system_seed event per evidence_items row
 *   - NXP_1 is owned by the seeded exporter (b0b00001-...)
 *
 * Checks:
 *   1.  GET without auth → 401
 *   2.  GET invalid evidence_type → 400
 *   3.  GET unknown nxp_reference → 404
 *   4.  GET valid nxp_reference + evidence_type → 200 with array
 *   5.  Each event has required fields (id, evidence_item_id, event_type, etc.)
 *   6.  Events are ordered created_at ASC
 *   7.  system_seed event is present (from RC4_004 backfill)
 *   8.  actor_role = 'system' on system_seed event
 *   9.  actor_user_id = null on system_seed event
 *   10. GET a different evidence_type on same NXP returns its own events
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL      ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

const NXP_1       = 'NXP-2026-SES-001'
const NXP_UNKNOWN = 'NXP-DOES-NOT-EXIST'

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function get(
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'GET', headers })
  return { status: res.status, body: await res.json() }
}

const eventsPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}/events`

async function main() {
  console.log('=== ExportOS RC4 — GET /export-cases evidence events Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Authenticate
  const loginFetch = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const loginBody = await loginFetch.json() as Record<string, unknown>
  if (loginFetch.status !== 200 || typeof loginBody.token !== 'string') {
    console.error(`  Fatal: login failed (${loginFetch.status}): ${JSON.stringify(loginBody)}`)
    process.exit(1)
  }
  const token = loginBody.token as string
  console.log('  (auth OK)\n')

  // ── Check 1: GET without auth → 401 ─────────────────────────────────────
  {
    const { status } = await get(eventsPath(NXP_1, 'nxp_approval'))
    if (status !== 401) fail('GET without auth', `expected 401, got ${status}`)
    else ok('GET without auth — 401')
  }

  // ── Check 2: GET invalid evidence_type → 400 ────────────────────────────
  {
    const { status, body } = await get(eventsPath(NXP_1, 'tax_clearance'), token)
    if (status !== 400) fail('GET invalid evidence_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('GET invalid evidence_type (tax_clearance) — 400')
  }

  // ── Check 3: GET unknown nxp_reference → 404 ────────────────────────────
  {
    const { status } = await get(eventsPath(NXP_UNKNOWN, 'nxp_approval'), token)
    if (status !== 404) fail('GET unknown nxp_reference', `expected 404, got ${status}`)
    else ok('GET unknown nxp_reference — 404')
  }

  // ── Check 4: GET valid → 200 with array ─────────────────────────────────
  let events: Record<string, unknown>[] = []
  {
    const { status, body } = await get(eventsPath(NXP_1, 'nxp_approval'), token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      console.error(`  Fatal: GET events failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    events = b.data as Record<string, unknown>[]
    ok(`GET nxp_approval events — 200, ${events.length} event(s)`)
  }

  // ── Check 5: Required fields present ────────────────────────────────────
  {
    const required = [
      'id', 'evidence_item_id', 'shipment_id', 'exporter_id', 'nxp_reference',
      'evidence_type', 'previous_lifecycle_state', 'new_lifecycle_state',
      'actor_role', 'event_type', 'created_at',
    ]
    const first = events[0]
    if (!first) {
      fail('events array non-empty', 'got 0 events (expected at least system_seed from RC4_004)')
    } else {
      const missing = required.filter(f => !(f in first))
      if (missing.length > 0) fail('required fields present', `missing: ${missing.join(', ')}`)
      else ok('all required fields present on event row')
    }
  }

  // ── Check 6: Events ordered created_at ASC ───────────────────────────────
  {
    if (events.length < 2) {
      ok('ordering ASC — only 1 event, order trivially correct')
    } else {
      let ordered = true
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1]?.['created_at'] as string
        const curr = events[i]?.['created_at'] as string
        if (prev > curr) { ordered = false; break }
      }
      if (!ordered) fail('events ordered created_at ASC', 'out-of-order timestamps found')
      else ok(`events ordered created_at ASC (${events.length} events)`)
    }
  }

  // ── Check 7: system_seed event present ───────────────────────────────────
  {
    const seedEvent = events.find(e => e['event_type'] === 'system_seed')
    if (!seedEvent) fail('system_seed event present', `event_types found: ${events.map(e => e['event_type']).join(', ')}`)
    else ok('system_seed event present (RC4_004 backfill confirmed)')
  }

  // ── Check 8: actor_role = 'system' on system_seed ────────────────────────
  {
    const seedEvent = events.find(e => e['event_type'] === 'system_seed')
    if (!seedEvent) {
      ok('actor_role check — skipped (no system_seed found above)')
    } else if (seedEvent['actor_role'] !== 'system') {
      fail('actor_role = system on system_seed', `got '${seedEvent['actor_role']}'`)
    } else {
      ok(`actor_role = 'system' on system_seed event`)
    }
  }

  // ── Check 9: actor_user_id = null on system_seed ─────────────────────────
  {
    const seedEvent = events.find(e => e['event_type'] === 'system_seed')
    if (!seedEvent) {
      ok('actor_user_id check — skipped (no system_seed found above)')
    } else if (seedEvent['actor_user_id'] !== null) {
      fail('actor_user_id = null on system_seed', `got '${seedEvent['actor_user_id']}'`)
    } else {
      ok('actor_user_id = null on system_seed event')
    }
  }

  // ── Check 10: Different evidence_type returns its own events ──────────────
  {
    const { status, body } = await get(eventsPath(NXP_1, 'bill_of_lading'), token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      fail('GET bill_of_lading events', `expected 200 array, got ${status}: ${JSON.stringify(b).slice(0, 80)}`)
    } else {
      const blEvents = b.data as Record<string, unknown>[]
      const allBl = blEvents.every(e => e['evidence_type'] === 'bill_of_lading')
      if (!allBl) fail('bill_of_lading events scoped to type', 'found events with wrong evidence_type')
      else ok(`GET bill_of_lading events — 200, ${blEvents.length} event(s), all scoped to bill_of_lading`)
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
