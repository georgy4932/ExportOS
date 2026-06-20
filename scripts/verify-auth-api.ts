/**
 * Runtime verification for ExportOS v0.2 JWT authentication.
 *
 * Prerequisites:
 *   supabase db reset          (applies migrations incl. 0004 + seed with local_users)
 *   npm run api                (server running in a separate terminal)
 *   npm run verify-auth-api
 *
 * Checks:
 *   1. POST /auth/login with valid credentials → 200 + token
 *   2. GET /auth/me with token → correct exporterId
 *   3. GET /contracts with valid token → 200, AKOBO data present
 *   4. GET /contracts without token → 401
 *   5. GET /contracts with a bad/tampered token → 401
 *   6. POST /auth/login with wrong password → 401
 *   7. JWT signed for a userId with no exporter_users mapping → 403
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import jwt from 'jsonwebtoken'

const BASE     = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const EMAIL    = process.env.VERIFY_EMAIL    ?? 'operator@akoboexports.ng'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'dev-seed-password'
const EXPECTED_EXPORTER = process.env.VERIFY_EXPORTER_ID ?? 'b0b00001-0000-0000-0000-000000000001'
const JWT_SECRET = process.env.JWT_SECRET ?? 'local-dev-secret-change-in-production'

let passed = 0
let failed = 0

function ok(label: string) { console.log(`  ✓ ${label}`); passed++ }
function fail(label: string, detail: string) { console.error(`  ✗ ${label}: ${detail}`); failed++ }

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function get(path: string, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { headers })
  return { status: res.status, body: await res.json() }
}

async function main() {
  console.log('=== ExportOS v0.2 — Auth Verification ===')
  console.log(`  server: ${BASE}\n`)

  // ── Check 1: Valid login ───────────────────────────────────────────────────
  let token = ''
  {
    const { status, body } = await post('/auth/login', { email: EMAIL, password: PASSWORD })
    const b = body as Record<string, unknown>
    if (status !== 200 || typeof b.token !== 'string') {
      fail('POST /auth/login valid', `expected 200 + token, got ${status}: ${JSON.stringify(b)}`)
    } else {
      token = b.token
      ok(`POST /auth/login — 200, token received`)
    }
  }

  if (!token) {
    console.error('\nFatal: cannot continue without a valid token from check 1.')
    process.exit(1)
  }

  // ── Check 2: /auth/me returns correct exporterId ───────────────────────────
  {
    const { status, body } = await get('/auth/me', token)
    const b = body as Record<string, unknown>
    if (status !== 200) {
      fail('GET /auth/me', `expected 200, got ${status}`)
    } else if (b.exporterId !== EXPECTED_EXPORTER) {
      fail('GET /auth/me exporterId', `expected ${EXPECTED_EXPORTER}, got ${b.exporterId}`)
    } else {
      ok(`GET /auth/me — userId=${b.userId}, exporterId=${b.exporterId}`)
    }
  }

  // ── Check 3: Authenticated request returns data ────────────────────────────
  {
    const { status, body } = await get('/contracts', token)
    const b = body as Record<string, unknown>
    const data = b.data as unknown[]
    if (status !== 200) {
      fail('GET /contracts with token', `expected 200, got ${status}`)
    } else if (!Array.isArray(data) || data.length < 1) {
      fail('GET /contracts data', `expected >= 1 contract, got ${JSON.stringify(data)?.slice(0, 80)}`)
    } else {
      ok(`GET /contracts with token — 200, ${data.length} contract(s)`)
    }
  }

  // ── Check 4: No token → 401 ────────────────────────────────────────────────
  {
    const { status } = await get('/contracts')
    if (status !== 401) {
      fail('GET /contracts without token', `expected 401, got ${status}`)
    } else {
      ok(`GET /contracts without token — 401`)
    }
  }

  // ── Check 5: Bad/tampered token → 401 ─────────────────────────────────────
  {
    const { status } = await get('/contracts', token + 'tampered')
    if (status !== 401) {
      fail('GET /contracts with bad token', `expected 401, got ${status}`)
    } else {
      ok(`GET /contracts with bad token — 401`)
    }
  }

  // ── Check 6: Wrong password → 401 ─────────────────────────────────────────
  {
    const { status } = await post('/auth/login', { email: EMAIL, password: 'wrong-password' })
    if (status !== 401) {
      fail('POST /auth/login wrong password', `expected 401, got ${status}`)
    } else {
      ok(`POST /auth/login wrong password — 401`)
    }
  }

  // ── Check 7: Valid JWT for unknown userId → 403 (no exporter mapping) ──────
  {
    const unknownToken = jwt.sign(
      { sub: '00000000-dead-beef-0000-000000000000', email: 'ghost@nowhere.test' },
      JWT_SECRET,
      { expiresIn: '1h' },
    )
    const { status } = await get('/contracts', unknownToken)
    if (status !== 403) {
      fail('JWT with no exporter mapping', `expected 403, got ${status}`)
    } else {
      ok(`JWT with no exporter mapping — 403 (exporter isolation holds)`)
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
