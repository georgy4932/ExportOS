/**
 * Runtime verification for ExportOS v0.2 audit trail.
 *
 * Prerequisites:
 *   npm run db:reset       (applies migration 0005 + seed)
 *   npm run api            (server running in a separate terminal)
 *   npm run verify-audit-api
 *
 * Checks:
 *   1. GET /audit-events without auth → 401
 *   2. GET /audit-events with auth → 200, array
 *   3. POST /contracts → GET /audit-events?entity_type=export_contract&entity_id=<id> returns 1 event
 *   4. Audit event action = 'CREATE'
 *   5. Audit event exporter_id is server-derived (matches authenticated exporter)
 *   6. Audit event actor_user_id is server-derived (matches JWT sub)
 *   7. Audit event_data contains the contract snapshot (has contract_reference)
 *   8. GET /audit-events with JWT for unknown user → 403 (exporter isolation)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE              = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL             = process.env.VERIFY_EMAIL       ?? 'operator@akoboexports.ng'
const PASSWORD          = process.env.VERIFY_PASSWORD    ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const COUNTERPARTY_ID   = 'b0b00001-0000-0000-0000-000000000002'
const JWT_SECRET        = process.env.JWT_SECRET         ?? 'local-dev-secret-change-in-production'

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function req(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body)  headers['Content-Type']  = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  console.log('=== ExportOS v0.2 — Audit Trail Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Get token + userId
  const loginRes = await req('POST', '/auth/login', undefined, { email: EMAIL, password: PASSWORD })
  const loginBody = loginRes.body as Record<string, unknown>
  if (loginRes.status !== 200 || typeof loginBody.token !== 'string') {
    console.error(`  Fatal: login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`)
    process.exit(1)
  }
  const token = loginBody.token as string
  // Decode JWT to get the userId (sub claim) for check 6
  const payload = jwt.decode(token) as Record<string, unknown>
  const expectedUserId = payload['sub'] as string
  console.log(`  (auth OK — userId=${expectedUserId})\n`)

  // ── Check 1: No auth → 401 ────────────────────────────────────────────────
  {
    const { status } = await req('GET', '/audit-events')
    if (status !== 401) fail('GET /audit-events without auth', `expected 401, got ${status}`)
    else ok('GET /audit-events without auth — 401')
  }

  // ── Check 2: With auth → 200, array ───────────────────────────────────────
  {
    const { status, body } = await req('GET', '/audit-events', token)
    const b = body as Record<string, unknown>
    if (status !== 200 || !Array.isArray(b.data)) {
      fail('GET /audit-events with auth', `expected 200 + data array, got ${status}: ${JSON.stringify(b).slice(0, 100)}`)
    } else {
      ok(`GET /audit-events with auth — 200, ${(b.data as unknown[]).length} event(s)`)
    }
  }

  // ── Create a contract to produce an audit event ───────────────────────────
  const ref = `AUDIT-TEST-${Date.now()}`
  let contractId = ''
  {
    const { status, body } = await req('POST', '/contracts', token, {
      contract_reference:  ref,
      counterparty_id:     COUNTERPARTY_ID,
      commodity:           'Groundnut Oil',
      commodity_type:      'NON_OIL',
      hs_code:             '1508.10',
      contract_quantity:   200,
      quantity_unit:       'MT',
      contract_value:      160000,
      currency:            'USD',
      unit_price:          800,
      incoterms:           'CIF',
      destination_country: 'NL',
      payment_terms:       'LC AT SIGHT',
      contract_date:       '2026-07-15',
    })
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      console.error(`  Fatal: contract creation failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    contractId = data.id as string
    console.log(`  (contract created: ${contractId})\n`)
  }

  // Fetch the audit event for this contract
  const { status: evStatus, body: evBody } = await req(
    'GET', `/audit-events?entity_type=export_contract&entity_id=${contractId}`, token,
  )
  const evData = (evBody as Record<string, unknown>).data as Record<string, unknown>[]

  // ── Check 3: Event exists ─────────────────────────────────────────────────
  if (evStatus !== 200 || !Array.isArray(evData) || evData.length === 0) {
    fail('Audit event written for contract', `expected 1 event, got ${evStatus}: ${JSON.stringify(evBody).slice(0, 100)}`)
    console.error('\n  Fatal: no audit event found — cannot continue remaining checks.')
    process.exit(1)
  }
  ok(`Audit event written — 1 event for entity_id=${contractId}`)

  const ev = evData[0]

  // ── Check 4: action = CREATE ──────────────────────────────────────────────
  if (ev['action'] !== 'CREATE') fail('Audit event action', `expected CREATE, got ${ev['action']}`)
  else ok(`Audit event action = CREATE`)

  // ── Check 5: exporter_id is server-derived ────────────────────────────────
  if (ev['exporter_id'] !== EXPECTED_EXPORTER) {
    fail('Audit event exporter_id', `expected ${EXPECTED_EXPORTER}, got ${ev['exporter_id']}`)
  } else {
    ok(`Audit event exporter_id = ${ev['exporter_id']} (server-derived)`)
  }

  // ── Check 6: actor_user_id is server-derived (matches JWT sub) ───────────
  if (ev['actor_user_id'] !== expectedUserId) {
    fail('Audit event actor_user_id', `expected ${expectedUserId}, got ${ev['actor_user_id']}`)
  } else {
    ok(`Audit event actor_user_id = ${ev['actor_user_id']} (server-derived from JWT)`)
  }

  // ── Check 7: event_data contains contract snapshot ────────────────────────
  const eventData = ev['event_data'] as Record<string, unknown>
  if (!eventData || eventData['contract_reference'] !== ref) {
    fail('Audit event_data snapshot', `expected contract_reference=${ref}, got ${JSON.stringify(eventData)?.slice(0, 80)}`)
  } else {
    ok(`Audit event_data contains contract snapshot (contract_reference=${ref})`)
  }

  // ── Check 8: Unknown user JWT → 403 (exporter isolation) ─────────────────
  {
    const unknownToken = jwt.sign(
      { sub: '00000000-dead-beef-0000-000000000000', email: 'ghost@nowhere.test' },
      JWT_SECRET,
      { expiresIn: '1h' },
    )
    const { status } = await req('GET', '/audit-events', unknownToken)
    if (status !== 403) fail('GET /audit-events unknown user', `expected 403, got ${status}`)
    else ok('GET /audit-events unknown user → 403 (exporter isolation holds)')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
