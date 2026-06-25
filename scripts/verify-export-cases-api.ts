/**
 * Runtime verification for ExportOS v0.2 Export Cases / Evidence API.
 *
 * Prerequisites:
 *   npm run db:reset        (applies all migrations including evidence_items + seed)
 *   npm run api             (server running in a separate terminal)
 *   npm run verify-export-cases-api
 *
 * Schema notes:
 *   - evidence_items rows are seeded automatically by trg_compliance_record_seeds_evidence
 *     when a bill_of_lading is inserted. Both seeded shipments have BLs, so both have
 *     7 evidence_items each.
 *   - SHIPMENT_1 → NXP-2026-SES-001   (b0b00001-0000-0000-0000-000000000005)
 *   - SHIPMENT_2 → NXP-2026-SES-002   (b0b00001-0000-0000-0000-000000000006)
 *
 * Checks:
 *   1.  GET list without auth → 401
 *   2.  GET list unknown nxp_reference → 404
 *   3.  GET list for valid nxp_reference → 200, 7 items, correct shape
 *   4.  All 7 expected evidence_type values present
 *   5.  System rows (shipment_record, compliance_summary) have lifecycle_state=uploaded
 *   6.  User rows have lifecycle_state=missing, validation_status=not_validated
 *   7.  GET single without auth → 401
 *   8.  GET single unknown nxp_reference → 404
 *   9.  GET single invalid evidence_type → 400
 *   10. GET single valid nxp_reference + evidence_type → 200, correct shape
 *   11. GET single for nxp_approval matches list item for same type
 *   12. Response includes error: null
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

const NXP_1          = 'NXP-2026-SES-001'  // shipment 1
const NXP_UNKNOWN    = 'NXP-DOES-NOT-EXIST'
const EVIDENCE_TYPE  = 'nxp_approval'
const INVALID_TYPE   = 'tax_clearance'      // not a valid evidence_type

const EXPECTED_TYPES = new Set([
  'nxp_approval', 'bill_of_lading', 'cci_document',
  'payment_evidence', 'credit_advice',
  'shipment_record', 'compliance_summary',
])
const SYSTEM_TYPES = new Set(['shipment_record', 'compliance_summary'])

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function req(
  method: 'GET',
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers })
  return { status: res.status, body: await res.json() }
}

async function main() {
  console.log('=== ExportOS v0.2 — Export Cases Evidence API Verification ===')
  console.log(`  server: ${BASE}\n`)

  // Authenticate
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const loginBody = await loginRes.json() as Record<string, unknown>
  if (loginRes.status !== 200 || typeof loginBody['token'] !== 'string') {
    console.error(`  Fatal: login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`)
    process.exit(1)
  }
  const token = loginBody['token'] as string
  console.log('  (auth OK)\n')

  const LIST_PATH   = `/export-cases/${NXP_1}/evidence`
  const SINGLE_PATH = `/export-cases/${NXP_1}/evidence/${EVIDENCE_TYPE}`

  // ── Check 1: GET list without auth → 401 ────────────────────────────────
  {
    const { status } = await req('GET', LIST_PATH)
    if (status !== 401) fail('GET list without auth', `expected 401, got ${status}`)
    else ok('GET evidence list without auth — 401')
  }

  // ── Check 2: GET list unknown nxp_reference → 404 ───────────────────────
  {
    const { status, body } = await req('GET', `/export-cases/${NXP_UNKNOWN}/evidence`, token)
    const b = body as Record<string, unknown>
    if (status !== 404) fail('GET list unknown NXP', `expected 404, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok(`GET evidence list unknown NXP — 404, error="${b['error']}"`)
  }

  // ── Check 3: GET list valid nxp_reference → 200, 7 items ────────────────
  let listItems: Record<string, unknown>[] = []
  {
    const { status, body } = await req('GET', LIST_PATH, token)
    const b = body as Record<string, unknown>
    const items = b['data']
    if (status !== 200 || !Array.isArray(items)) {
      fail('GET evidence list — 200 + array', `got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      console.error('\n  Fatal: cannot continue without list response.')
      process.exit(1)
    }
    listItems = items as Record<string, unknown>[]
    if (listItems.length !== 7) {
      fail('GET evidence list — 7 items', `got ${listItems.length} items`)
    } else {
      ok(`GET evidence list — 200, ${listItems.length} items`)
    }
  }

  // ── Check 4: All 7 evidence_type values present ──────────────────────────
  {
    const types = new Set(listItems.map(i => i['evidence_type']))
    const missing = [...EXPECTED_TYPES].filter(t => !types.has(t))
    if (missing.length > 0) {
      fail('All 7 evidence_types present', `missing: ${missing.join(', ')}`)
    } else {
      ok('All 7 evidence_type values present')
    }
  }

  // ── Check 5: System rows have lifecycle_state=uploaded ───────────────────
  {
    const systemItems = listItems.filter(i => SYSTEM_TYPES.has(String(i['evidence_type'])))
    const allUploaded = systemItems.every(i => i['lifecycle_state'] === 'uploaded')
    if (systemItems.length !== 2 || !allUploaded) {
      fail('System rows lifecycle_state=uploaded', `system rows: ${JSON.stringify(systemItems.map(i => ({ type: i['evidence_type'], state: i['lifecycle_state'] })))}`)
    } else {
      ok('System rows (shipment_record, compliance_summary) have lifecycle_state=uploaded')
    }
  }

  // ── Check 6: User rows have lifecycle_state=missing, not_validated ───────
  {
    const userItems = listItems.filter(i => !SYSTEM_TYPES.has(String(i['evidence_type'])))
    const allMissing = userItems.every(i => i['lifecycle_state'] === 'missing' && i['validation_status'] === 'not_validated')
    if (userItems.length !== 5 || !allMissing) {
      fail('User rows lifecycle_state=missing / not_validated', `user rows: ${JSON.stringify(userItems.map(i => ({ type: i['evidence_type'], state: i['lifecycle_state'], vs: i['validation_status'] })))}`)
    } else {
      ok('User rows (5) have lifecycle_state=missing, validation_status=not_validated')
    }
  }

  // ── Check 7: GET single without auth → 401 ──────────────────────────────
  {
    const { status } = await req('GET', SINGLE_PATH)
    if (status !== 401) fail('GET single without auth', `expected 401, got ${status}`)
    else ok('GET single evidence without auth — 401')
  }

  // ── Check 8: GET single unknown nxp_reference → 404 ─────────────────────
  {
    const { status } = await req('GET', `/export-cases/${NXP_UNKNOWN}/evidence/${EVIDENCE_TYPE}`, token)
    if (status !== 404) fail('GET single unknown NXP — 404', `expected 404, got ${status}`)
    else ok('GET single unknown NXP — 404')
  }

  // ── Check 9: GET single invalid evidence_type → 400 ─────────────────────
  {
    const { status, body } = await req('GET', `/export-cases/${NXP_1}/evidence/${INVALID_TYPE}`, token)
    const b = body as Record<string, unknown>
    if (status !== 400) {
      fail('GET single invalid evidence_type — 400', `expected 400, got ${status}`)
    } else {
      ok(`GET single invalid evidence_type — 400, error="${b['error']}"`)
    }
  }

  // ── Check 10: GET single valid → 200, correct shape ─────────────────────
  let singleItem: Record<string, unknown> = {}
  {
    const { status, body } = await req('GET', SINGLE_PATH, token)
    const b = body as Record<string, unknown>
    const item = b['data'] as Record<string, unknown> | null
    if (status !== 200 || !item) {
      fail('GET single evidence — 200 + data', `got ${status}: ${JSON.stringify(body).slice(0, 120)}`)
      console.error('\n  Fatal: cannot continue without single-item response.')
      process.exit(1)
    }
    singleItem = item

    const hasShape =
      'evidence_type'          in item &&
      'evidence_code'          in item &&
      'lifecycle_state'        in item &&
      'validation_status'      in item &&
      'required_for_compliance' in item &&
      'uploaded_at'            in item &&
      'last_checked_at'        in item &&
      'source_system'          in item &&
      'metadata_json'          in item
    if (!hasShape) {
      fail('GET single — response shape', `missing fields; got keys: ${Object.keys(item).join(', ')}`)
    } else {
      ok(`GET single evidence — 200, evidence_type=${item['evidence_type']}, lifecycle_state=${item['lifecycle_state']}`)
    }
  }

  // ── Check 11: Single matches list item for same type ────────────────────
  {
    const listMatch = listItems.find(i => i['evidence_type'] === EVIDENCE_TYPE)
    if (!listMatch) {
      fail('Single matches list item', `no ${EVIDENCE_TYPE} in list`)
    } else if (
      singleItem['evidence_type']     !== listMatch['evidence_type']     ||
      singleItem['lifecycle_state']   !== listMatch['lifecycle_state']   ||
      singleItem['validation_status'] !== listMatch['validation_status'] ||
      singleItem['evidence_code']     !== listMatch['evidence_code']
    ) {
      fail('Single matches list item', `mismatch: single=${JSON.stringify(singleItem)}, list=${JSON.stringify(listMatch)}`)
    } else {
      ok('GET single is consistent with GET list for same evidence_type')
    }
  }

  // ── Check 12: Response includes error: null ──────────────────────────────
  {
    const { body } = await req('GET', LIST_PATH, token)
    const b = body as Record<string, unknown>
    if (!('error' in b) || b['error'] !== null) {
      fail('List response includes error: null', `error field = ${JSON.stringify(b['error'])}`)
    } else {
      ok('List response includes error: null')
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
