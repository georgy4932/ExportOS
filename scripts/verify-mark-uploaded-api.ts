/**
 * Runtime verification for ExportOS v0.2 PATCH /export-cases/:nxp/evidence/:type
 * — mark_uploaded action (Evidence Write Path W1).
 *
 * Prerequisites:
 *   npm run db:reset            (applies migrations + seed; resets evidence_items to 'missing')
 *   npm run api                 (server running in a separate terminal)
 *   npm run verify-mark-uploaded-api
 *
 * Seed state assumed:
 *   - NXP_1 (NXP-2026-SES-001) has 5 user evidence rows at lifecycle_state='missing'
 *   - NXP_1 is owned by the seeded exporter (b0b00001-...)
 *   - compliance_records row for NXP_1 has nxp_approved=false initially
 *
 * Checks:
 *   1.  PATCH without auth → 401
 *   2.  PATCH invalid evidence_type → 400
 *   3.  PATCH unsupported action → 400
 *   4.  PATCH system-derived evidence type (shipment_record) → 400
 *   5.  PATCH system-derived evidence type (compliance_summary) → 400
 *   6.  PATCH unknown nxp_reference → 404
 *   7.  PATCH valid nxp_reference + nxp_approval with mark_uploaded → 200
 *   8.  Response: lifecycle_state = 'uploaded'
 *   9.  Response: uploaded_at is not null
 *   10. Response: validation_status = 'pending'
 *   11. Compliance record: nxp_approved = true after mark_uploaded
 *   12. GET single evidence item reflects uploaded state
 *   13. PATCH same item again → 409 conflict
 *   14. PATCH missing evidence_type (cci_document) → 200, compliance cci_obtained = true
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

const BASE     = (process.env.API_URL      ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'

// Seeded values from seed data / verify-export-cases-api.ts
const NXP_1       = 'NXP-2026-SES-001'
const NXP_UNKNOWN = 'NXP-DOES-NOT-EXIST'
const SHIPMENT_1  = 'b0b00001-0000-0000-0000-000000000005'

let passed = 0
let failed = 0

function ok(label: string)                   { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function req(
  method: 'GET' | 'PATCH',
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

const nxpPath = (nxp: string, type: string) =>
  `/export-cases/${encodeURIComponent(nxp)}/evidence/${type}`

async function main() {
  console.log('=== ExportOS v0.2 — PATCH /export-cases evidence mark_uploaded Verification ===')
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

  // ── Check 1: PATCH without auth → 401 ────────────────────────────────────
  {
    const { status } = await req('PATCH', nxpPath(NXP_1, 'nxp_approval'), undefined, { action: 'mark_uploaded' })
    if (status !== 401) fail('PATCH without auth', `expected 401, got ${status}`)
    else ok('PATCH without auth — 401')
  }

  // ── Check 2: PATCH invalid evidence_type → 400 ───────────────────────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'tax_clearance'), token, { action: 'mark_uploaded' })
    if (status !== 400) fail('PATCH invalid evidence_type', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH invalid evidence_type (tax_clearance) — 400')
  }

  // ── Check 3: PATCH unsupported action → 400 ──────────────────────────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'nxp_approval'), token, { action: 'mark_validated' })
    if (status !== 400) fail('PATCH unsupported action', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH unsupported action (mark_validated) — 400')
  }

  // ── Check 4: PATCH system-derived type (shipment_record) → 400 ───────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'shipment_record'), token, { action: 'mark_uploaded' })
    if (status !== 400) fail('PATCH shipment_record', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH system type shipment_record — 400')
  }

  // ── Check 5: PATCH system-derived type (compliance_summary) → 400 ────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'compliance_summary'), token, { action: 'mark_uploaded' })
    if (status !== 400) fail('PATCH compliance_summary', `expected 400, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH system type compliance_summary — 400')
  }

  // ── Check 6: PATCH unknown nxp_reference → 404 ───────────────────────────
  {
    const { status } = await req('PATCH', nxpPath(NXP_UNKNOWN, 'nxp_approval'), token, { action: 'mark_uploaded' })
    if (status !== 404) fail('PATCH unknown nxp_reference', `expected 404, got ${status}`)
    else ok('PATCH unknown nxp_reference — 404')
  }

  // ── Check 7: PATCH valid nxp_approval with mark_uploaded → 200 ───────────
  let patchedData: Record<string, unknown> = {}
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'nxp_approval'), token, { action: 'mark_uploaded' })
    const b = body as Record<string, unknown>
    const data = b.data as Record<string, unknown>
    if (status !== 200 || !data?.['id']) {
      console.error(`  Fatal: mark_uploaded failed (${status}): ${JSON.stringify(body).slice(0, 120)}`)
      process.exit(1)
    }
    patchedData = data
    console.log(`  (nxp_approval marked uploaded: id=${patchedData['id']})\n`)
    ok('PATCH nxp_approval mark_uploaded — 200')
  }

  // ── Check 8: lifecycle_state = 'uploaded' ────────────────────────────────
  if (patchedData['lifecycle_state'] !== 'uploaded') {
    fail('lifecycle_state = uploaded', `got ${patchedData['lifecycle_state']}`)
  } else {
    ok(`lifecycle_state = '${patchedData['lifecycle_state']}'`)
  }

  // ── Check 9: uploaded_at not null ────────────────────────────────────────
  if (!patchedData['uploaded_at']) {
    fail('uploaded_at not null', `got ${patchedData['uploaded_at']}`)
  } else {
    ok(`uploaded_at = ${patchedData['uploaded_at']}`)
  }

  // ── Check 10: validation_status = 'pending' ───────────────────────────────
  if (patchedData['validation_status'] !== 'pending') {
    fail('validation_status = pending', `got ${patchedData['validation_status']}`)
  } else {
    ok(`validation_status = '${patchedData['validation_status']}'`)
  }

  // ── Check 11: compliance_records boolean sync (nxp_approved = true) ───────
  {
    const compRes = await fetch(`${BASE}/compliance/${SHIPMENT_1}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const compBody = await compRes.json() as Record<string, unknown>
    const compData = compBody.data as Record<string, unknown>
    if (compRes.status !== 200 || !compData) {
      fail('GET compliance for sync check', `expected 200, got ${compRes.status}`)
    } else if (compData['nxp_approved'] !== true) {
      fail('nxp_approved boolean sync', `expected true, got ${compData['nxp_approved']}`)
    } else {
      ok(`compliance_records.nxp_approved = true (boolean sync confirmed)`)
    }
  }

  // ── Check 12: GET single evidence item reflects uploaded state ─────────────
  {
    const { status, body } = await req('GET', nxpPath(NXP_1, 'nxp_approval'), token)
    const data = (body as Record<string, unknown>).data as Record<string, unknown>
    if (status !== 200 || data?.['lifecycle_state'] !== 'uploaded') {
      fail('GET single after mark_uploaded', `expected 200 + uploaded, got ${status}: ${JSON.stringify(data).slice(0, 80)}`)
    } else {
      ok('GET single evidence item after mark_uploaded — lifecycle_state=uploaded')
    }
  }

  // ── Check 13: PATCH same item again → 409 conflict ────────────────────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'nxp_approval'), token, { action: 'mark_uploaded' })
    if (status !== 409) fail('PATCH already uploaded → 409', `expected 409, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    else ok('PATCH already uploaded — 409 conflict')
  }

  // ── Check 14: cci_document → cci_obtained = true ──────────────────────────
  {
    const { status, body } = await req('PATCH', nxpPath(NXP_1, 'cci_document'), token, { action: 'mark_uploaded' })
    if (status !== 200) {
      fail('PATCH cci_document', `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 80)}`)
    } else {
      ok('PATCH cci_document mark_uploaded — 200')

      const compRes = await fetch(`${BASE}/compliance/${SHIPMENT_1}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const compBody = await compRes.json() as Record<string, unknown>
      const compData = compBody.data as Record<string, unknown>
      if (compData?.['cci_obtained'] !== true) {
        fail('cci_obtained boolean sync', `expected true, got ${compData?.['cci_obtained']}`)
      } else {
        ok('compliance_records.cci_obtained = true (boolean sync confirmed)')
      }
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
