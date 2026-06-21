/**
 * Runtime verification for ExportOS v0.2 POST /contracts (write workflow).
 *
 * Prerequisites:
 *   npm run db:reset       (applies migrations + seed)
 *   npm run api            (server running in a separate terminal)
 *   npm run verify-write-api
 *
 * Checks:
 *   1. POST /contracts without auth → 401
 *   2. POST /contracts with missing required fields → 400 with field list
 *   3. POST /contracts with invalid commodity_type → 400
 *   4. POST /contracts with valid body → 201 + contract row
 *   5. Created contract has exporter_id from auth (not from body)
 *   6. Client-supplied exporter_id in body is ignored
 *   7. Created contract appears in GET /contracts list
 *   8. GET /contracts (existing read path) still works after write
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE             = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL            = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD         = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const COUNTERPARTY_ID  = 'b0b00001-0000-0000-0000-000000000002'   // EUROGRAIN HAMBURG GMBH (seeded)

let passed = 0
let failed = 0

function ok(label: string)                     { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string)   { console.error(`  ✗ ${label}: ${detail}`); failed++ }

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

function validBody(ref: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_reference:   ref,
    counterparty_id:      COUNTERPARTY_ID,
    commodity:            'Sesame Seeds',
    commodity_type:       'NON_OIL',
    hs_code:              '1207.40',
    contract_quantity:    500,
    quantity_unit:        'MT',
    contract_value:       425000,
    currency:             'USD',
    unit_price:           850,
    incoterms:            'FOB',
    destination_country:  'DE',
    destination_port:     'Hamburg',
    payment_terms:        'LC AT SIGHT',
    contract_date:        '2026-07-01',
    ...overrides,
  }
}

async function main() {
  console.log('=== ExportOS v0.2 — Write API Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Get a valid token first
  const loginRes = await req('POST', '/auth/login', undefined, { email: EMAIL, password: PASSWORD })
  const loginBody = loginRes.body as Record<string, unknown>
  if (loginRes.status !== 200 || typeof loginBody.token !== 'string') {
    console.error(`  Fatal: login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`)
    console.error('  Is the API running? Start it with: npm run api')
    process.exit(1)
  }
  const token = loginBody.token as string
  console.log('  (auth OK — proceeding with write checks)\n')

  // ── Check 1: No auth → 401 ────────────────────────────────────────────────
  {
    const { status } = await req('POST', '/contracts', undefined, validBody('TEST-NOAUTH'))
    if (status !== 401) fail('POST /contracts without auth', `expected 401, got ${status}`)
    else ok('POST /contracts without auth — 401')
  }

  // ── Check 2: Missing required fields → 400 with field list ────────────────
  {
    const { status, body } = await req('POST', '/contracts', token, {
      contract_reference: 'TEST-MISSING',
      // omit everything else
    })
    const b = body as Record<string, unknown>
    if (status !== 400) {
      fail('POST /contracts missing fields', `expected 400, got ${status}`)
    } else if (!Array.isArray(b.fields) || b.fields.length === 0) {
      fail('POST /contracts missing fields response', `expected fields array, got ${JSON.stringify(b)}`)
    } else {
      ok(`POST /contracts missing fields — 400, fields: [${(b.fields as string[]).join(', ')}]`)
    }
  }

  // ── Check 3: Invalid commodity_type → 400 ────────────────────────────────
  {
    const { status } = await req('POST', '/contracts', token,
      validBody('TEST-BADTYPE', { commodity_type: 'OIL' }))
    if (status !== 400) fail('POST /contracts invalid commodity_type', `expected 400, got ${status}`)
    else ok('POST /contracts invalid commodity_type — 400')
  }

  // ── Check 4: Valid body → 201 + contract row ──────────────────────────────
  const ref = `TEST-${Date.now()}`
  let createdId = ''
  {
    const { status, body } = await req('POST', '/contracts', token, validBody(ref))
    const b = body as Record<string, unknown>
    const data = b.data as Record<string, unknown>
    if (status !== 201 || !data?.id) {
      fail('POST /contracts valid', `expected 201 + {data.id}, got ${status}: ${JSON.stringify(b).slice(0, 120)}`)
    } else {
      createdId = data.id as string
      ok(`POST /contracts valid — 201, id=${createdId}`)
    }
  }

  if (!createdId) {
    console.error('\n  Fatal: cannot continue without a created contract id.')
    process.exit(1)
  }

  // ── Check 5: Created contract has server-derived exporter_id ─────────────
  {
    const { body } = await req('GET', `/contracts/${createdId}`, token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (!data) {
      fail('GET /contracts/:id after create', 'no data returned')
    } else if (data.exporter_id !== EXPECTED_EXPORTER) {
      fail('exporter_id server-derived', `expected ${EXPECTED_EXPORTER}, got ${data.exporter_id}`)
    } else {
      ok(`Created contract exporter_id = ${data.exporter_id} (server-derived)`)
    }
  }

  // ── Check 6: Client-supplied exporter_id is ignored ──────────────────────
  {
    const fakeExporterId = '00000000-dead-beef-0000-000000000000'
    const { status, body } = await req('POST', '/contracts', token,
      validBody(`TEST-IDOR-${Date.now()}`, { exporter_id: fakeExporterId }))
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 201) {
      fail('POST /contracts with client exporter_id', `expected 201, got ${status}`)
    } else if (data?.exporter_id === fakeExporterId) {
      fail('client-supplied exporter_id accepted', `response has fake exporter_id — SECURITY ISSUE`)
    } else if (data?.exporter_id !== EXPECTED_EXPORTER) {
      fail('client-supplied exporter_id result', `expected ${EXPECTED_EXPORTER}, got ${data?.exporter_id}`)
    } else {
      ok('Client-supplied exporter_id ignored — response has correct server-derived exporter_id')
    }
  }

  // ── Check 7: Created contract appears in GET /contracts ───────────────────
  {
    const { status, body } = await req('GET', '/contracts', token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>[]
    if (status !== 200 || !Array.isArray(data)) {
      fail('GET /contracts after write', `expected 200 + array, got ${status}`)
    } else {
      const found = data.some(r => r.id === createdId)
      if (!found) fail('Created contract in list', `contract ${createdId} not found in GET /contracts`)
      else ok(`Created contract appears in GET /contracts (${data.length} total)`)
    }
  }

  // ── Check 8: Read-only endpoints unaffected ───────────────────────────────
  {
    const { status } = await req('GET', '/shipments', token)
    if (status !== 200) fail('GET /shipments still works', `expected 200, got ${status}`)
    else ok('GET /shipments still works — 200')
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`)
  console.error('Is the API server running? Start it with: npm run api')
  process.exit(1)
})
