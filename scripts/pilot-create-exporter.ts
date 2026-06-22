/**
 * ExportOS — Manual Pilot Onboarding
 *
 * Creates one exporter company and one login user in the live database.
 * Run with DATABASE_URL set in .env.local:
 *
 *   npm run pilot:create-exporter
 *
 * Never expose this script or its output publicly.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as rlp from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { createDbClient } from '../src/db/client'

async function ask(rl: rlp.Interface, question: string): Promise<string> {
  return (await rl.question(question)).trim()
}

async function main() {
  const rl = rlp.createInterface({ input, output })

  console.log('\n=== ExportOS — Manual Pilot Onboarding ===\n')

  const legalName       = await ask(rl, 'Exporter company name (legal):        ')
  const registrationNum = await ask(rl, 'Registration number (RC / CAC):       ')
  const country         = (await ask(rl, 'Country code (2-letter, e.g. NG):     ')).toUpperCase()
  const contactEmail    = await ask(rl, 'Contact email (your records only):    ')
  const loginEmail      = await ask(rl, 'Login email:                          ')
  const tempPassword    = await ask(rl, 'Temporary password (min 8 chars):     ')

  rl.close()

  // Validate inputs
  const errors: string[] = []
  if (!legalName)
    errors.push('Company name is required.')
  if (!country || country.length !== 2 || !/^[A-Z]{2}$/.test(country))
    errors.push('Country must be exactly 2 uppercase letters (e.g. NG).')
  if (!loginEmail || !loginEmail.includes('@'))
    errors.push('Login email must be a valid email address.')
  if (!tempPassword || tempPassword.length < 8)
    errors.push('Password must be at least 8 characters.')

  if (errors.length) {
    console.error('\nValidation errors:')
    errors.forEach(e => console.error(`  - ${e}`))
    process.exit(1)
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('\nError: DATABASE_URL is not set. Check .env.local.')
    process.exit(1)
  }

  const db = createDbClient(dbUrl)
  const exporterId   = randomUUID()
  const userId       = randomUUID()
  const passwordHash = await bcrypt.hash(tempPassword, 10)

  try {
    await db.query('BEGIN')

    // 1. auth.users — required by exporter_users(user_id) foreign key
    await db.query(`
      INSERT INTO auth.users (
        id, instance_id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at,
        confirmation_token, recovery_token,
        email_change_token_new, email_change
      ) VALUES (
        $1,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        $2,
        crypt($3, gen_salt('bf')),
        NOW(),
        '{"provider":"email","providers":["email"]}',
        '{}',
        NOW(), NOW(), '', '', '', ''
      )
    `, [userId, loginEmail, tempPassword])

    // 2. local_users — v0.2 JWT login store; id must match auth.users.id
    await db.query(
      'INSERT INTO local_users (id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, loginEmail, passwordHash],
    )

    // 3. exporters
    await db.query(`
      INSERT INTO exporters (id, legal_name, country, registration_number)
      VALUES ($1, $2, $3, $4)
    `, [exporterId, legalName, country, registrationNum || null])

    // 4. exporter_settings — default tolerances (2% / $500 cap, 180-day non-oil)
    await db.query(
      'INSERT INTO exporter_settings (exporter_id) VALUES ($1)',
      [exporterId],
    )

    // 5. exporter_users — grants ADMIN access to this exporter
    await db.query(`
      INSERT INTO exporter_users (exporter_id, user_id, role)
      VALUES ($1, $2, 'ADMIN')
    `, [exporterId, userId])

    await db.query('COMMIT')

    const line = '━'.repeat(44)
    console.log(`\n✓  Exporter created successfully.\n`)
    console.log(line)
    console.log('  PILOT LOGIN CREDENTIALS')
    console.log(line)
    console.log(`  Company:       ${legalName}`)
    if (registrationNum) console.log(`  Reg. number:   ${registrationNum}`)
    if (contactEmail)    console.log(`  Contact email: ${contactEmail}`)
    console.log(`  Login URL:     https://exportos.ng`)
    console.log(`  Login email:   ${loginEmail}`)
    console.log(`  Password:      ${tempPassword}`)
    console.log(`  Exporter ID:   ${exporterId}  (internal)`)
    console.log(line)
    console.log('\n  Send credentials securely. The exporter will see\n  an empty dashboard on first login.\n')

  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      console.error(`\n  Error: ${loginEmail} is already registered. Choose a different login email.`)
    } else {
      console.error('\n  Error:', msg)
    }
    process.exit(1)
  } finally {
    await db.end()
  }
}

main()
