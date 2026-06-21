# ExportOS v0.2

System of record for Nigerian non-oil export contracts, shipments, payment evidence, reconciliation, compliance records, and bank evidence packs.

This is a local-development release. The `local_users` auth mechanism and direct `pg` connection are intentional for v0.2 and must be replaced before any production deployment.

---

## Demo quickstart

### Prerequisites

- Node.js 18+
- Docker (for the local Supabase stack)

### First-time setup

```bash
# 1. Clone and install
git clone https://github.com/georgy4932/ExportOS.git
cd ExportOS
npm install

# 2. Copy environment file
cp .env.example .env.local

# 3. Start the local database (Postgres + GoTrue only)
npm run db:start

# 4. Apply migrations and seed demo data
npm run db:reset

# 5. Start the API server (keep this terminal open)
npm run api
```

Then open `http://localhost:3000` in a browser.

### Demo reset (wipe and reseed)

```bash
npm run demo:reset
```

This replays all 6 migrations and the seed file from scratch. The API server does not need to be restarted.

---

## Demo login

| Field    | Value                       |
|----------|-----------------------------|
| Email    | `operator@akoboexports.ng`  |
| Password | `dev-seed-password`         |
| Role     | ADMIN (AKOBO AGRI-EXPORT COMPANY LTD) |

---

## What the dashboard demonstrates

The dashboard is a single-page HTML app (`public/index.html`) with seven cards covering the full operational lifecycle of a non-oil export:

| Card | What it shows |
|------|---------------|
| **Contracts** | Active export contract CTR-2026-SES-001 (100 MT sesame seeds, $80,000 USD, buyer EUROGRAIN HAMBURG GMBH) |
| **Shipments** | Two shipments (SHP-2026-01 fully reconciled, SHP-2026-02 partially reconciled) |
| **Bills of Lading** | Original B/Ls for each shipment; repatriation deadline auto-computed (BL date + 180 days) |
| **Payment Receipts** | Two SWIFT receipts; discrepancy status (CLEAN / DISCREPANT) computed against tolerance |
| **Invoices** | Commercial invoice for SHP-01, proforma for SHP-02 |
| **Compliance** | Per-shipment checklist (NXP, CCI, BL, payment evidence, credit advice); repatriation status |
| **Evidence Packs** | Bank evidence packs: Pack 1 sealed, Pack 2 draft (incomplete compliance) |

---

## Demo script: contract to sealed evidence pack

This script walks through the full lifecycle using the seeded data, then demonstrates creating and sealing a new pack via the UI.

### Step 1 — Log in

Open `http://localhost:3000` and log in with the credentials above. All seven cards load automatically.

### Step 2 — Review the contract

Open **Contracts**. One record: `CTR-2026-SES-001`, 100 MT sesame seeds at $800/MT, $80,000 total, CFR Hamburg. Status: ACTIVE.

### Step 3 — Review shipments

Open **Shipments**. Two rows:
- `SHP-2026-01` — vessel MSC AURORA (AU2601W), 50 MT, status `PROCEEDS_COMPLETE`
- `SHP-2026-02` — vessel MSC AURORA (AU2602W), 50 MT, status `PROCEEDS_PARTIAL`

### Step 4 — Review bills of lading

Open **Bills of Lading**. Two original B/Ls:
- `MSC-APAPA-2601` — BL date 2026-01-20, deadline 2026-07-19
- `MSC-APAPA-2602` — BL date 2026-03-15, deadline 2026-09-11

### Step 5 — Review payment receipts

Open **Payment Receipts**. Two receipts, both `CLEAN`:
- `RCPT-2026-001` — instructed $40,200, credited $40,000 (bank charges within tolerance)
- `RCPT-2026-002` — instructed $16,000, credited $15,900 (partial payment)

### Step 6 — Review invoices

Open **Invoices**. One commercial invoice (`INV-2026-001`, $40,000) and one proforma (`INV-2026-002`, $40,000).

### Step 7 — Review compliance

Open **Compliance**. Two rows:
- **SHP-2026-01** — status `COMPLETE`, all 5 checklist items ticked, `bank_evidence_pack_generated = true`
- **SHP-2026-02** — status `PARTIAL`, 3 of 5 items ticked (CCI and credit advice outstanding)

Click **Update** on SHP-2026-02 to demonstrate patching the checklist. Tick `CCI Obtained` and `Credit Advice Confirmed`, then submit. The row updates immediately; repatriation status remains system-controlled.

### Step 8 — Generate an evidence pack

Open **Evidence Packs**. Pack 1 is `Sealed`, Pack 2 is `Draft` (SHP-2026-02).

Click **Generate Pack** (top right). Select a shipment and submit. A new draft pack appears in the table.

### Step 9 — Attempt to seal an incomplete pack

If SHP-2026-02 still has incomplete compliance, click **Seal** on its draft pack. The modal stays open and displays the trigger error listing the missing fields. This is the expected behaviour: the sealing preconditions check is enforced in the database, not the application layer.

### Step 10 — Seal a complete pack

After completing the compliance checklist for SHP-2026-02 (Step 7), click **Seal** on the draft pack. The pack status changes to `Sealed` and the compliance row shows `bank_evidence_pack_generated = true`.

---

## Seeded data reference

| Entity | Reference | Value |
|--------|-----------|-------|
| Exporter | AKOBO AGRI-EXPORT COMPANY LTD | RC-1047832 |
| Counterparty | EUROGRAIN HAMBURG GMBH | Hamburg, DE |
| Contract | CTR-2026-SES-001 | $80,000 USD, 100 MT sesame seeds |
| Shipment 1 | SHP-2026-01 / NXP-2026-SES-001 | 50 MT, $40,000, fully reconciled |
| Shipment 2 | SHP-2026-02 / NXP-2026-SES-002 | 50 MT, $40,000, partially reconciled ($10,000 received) |
| B/L 1 | MSC-APAPA-2601 | 2026-01-20, deadline 2026-07-19 |
| B/L 2 | MSC-APAPA-2602 | 2026-03-15, deadline 2026-09-11 |
| Receipt 1 | RCPT-2026-001 | Instructed $40,200, credited $40,000 — CLEAN |
| Receipt 2 | RCPT-2026-002 | Instructed $16,000, credited $15,900 — CLEAN |
| Evidence Pack 1 | NXP-2026-SES-001 | Sealed |
| Evidence Pack 2 | NXP-2026-SES-002 | Draft (compliance incomplete) |

Charge tolerance: 2% of instructed amount, capped at $500. Receipt 1 difference ($200) and Receipt 2 difference ($100) are both within tolerance.

---

## API routes

All data routes require `Authorization: Bearer <token>`. Obtain a token via `POST /auth/login`.

```
POST /auth/login                       { email, password } → { token }
GET  /auth/me                          current user + exporter

GET  /counterparties
GET  /contracts[?status=]
GET  /contracts/:id
POST /contracts

GET  /shipments[?contract_id=&fully_reconciled=]
GET  /shipments/:id
POST /shipments

GET  /bills-of-lading[?deadline_status=]
POST /bills-of-lading

GET  /payment-receipts[?allocation_status=&discrepancy_status=]
GET  /payment-receipts/:id
POST /payment-receipts

GET  /payment-allocations[?receipt_id=&shipment_id=]
GET  /payment-allocations/:id
POST /payment-allocations

GET  /payment-evidence[?receipt_id=&evidence_type=]
GET  /payment-evidence/:id
POST /payment-evidence
PATCH /payment-evidence/:id/supersede

GET  /invoices[?contract_id=&shipment_id=&invoice_type=]
GET  /invoices/:id
POST /invoices

GET  /compliance[?status=&late_only=]
GET  /compliance/:shipmentId
PATCH /compliance/:shipmentId

GET  /evidence-packs[?shipment_id=&sealed=]
GET  /evidence-packs/:id
POST /evidence-packs
PATCH /evidence-packs/:id/seal

GET  /audit-events[?entity_type=&entity_id=]

GET  /health
```

---

## Verification scripts

Run after `npm run db:reset` with the API server running in a separate terminal.

| Script | Checks | Covers |
|--------|--------|--------|
| `npm run verify-auth-api` | 7 | Login, JWT, /auth/me, IDOR |
| `npm run verify-api` | — | Basic contract + counterparty reads |
| `npm run verify-write-api` | — | Contract POST |
| `npm run verify-audit-api` | — | Audit event immutability |
| `npm run verify-shipments-api` | — | Shipment POST + reads |
| `npm run verify-bl-api` | — | B/L POST, deadline trigger, compliance auto-creation |
| `npm run verify-receipts-api` | — | Payment receipt POST, discrepancy trigger |
| `npm run verify-allocations-api` | — | Allocation POST, side-effects trigger |
| `npm run verify-evidence-api` | — | Payment evidence POST |
| `npm run verify-supersede-evidence-api` | — | Evidence supersede flow |
| `npm run verify-invoices-api` | — | Invoice POST |
| `npm run verify-compliance-api` | 15 | Compliance PATCH, audit, system-field protection |
| `npm run verify-evidence-packs-api` | 15 | Pack POST, seal, trigger preconditions, audit |

All scripts exit 0 on full pass, 1 on any failure. Run `npm run typecheck` separately to check TypeScript compilation.

---

## Database

Local stack managed by Supabase CLI (Docker). Direct `pg` connection on port 54322.

### Migrations (applied in order by `db:reset`)

| File | Purpose |
|------|---------|
| `20260620000001_initial_schema.sql` | Core tables: exporters, contracts, shipments, B/Ls, receipts, allocations, evidence, compliance, packs |
| `20260620000002_foundation_fixes.sql` | Column and constraint corrections after initial review |
| `20260620000003_pre_merge_fixes.sql` | Trigger and enum adjustments |
| `20260620000004_local_auth.sql` | `local_users` table for v0.2 dev auth |
| `20260620000005_audit_trail.sql` | `audit_events` table + immutability triggers |
| `20260621000006_fix_sealing_preconditions_trigger.sql` | Fix `array_append` in sealing preconditions trigger (22P02 regression) |

### Key database triggers

| Trigger | Effect |
|---------|--------|
| `trg_bl_compute_deadline` | Sets `repatriation_deadline = bl_date + 180` on B/L insert |
| `trg_bl_auto_compliance_record` | Creates `compliance_records` row on B/L insert |
| `trg_payment_receipt_discrepancy` | Sets `discrepancy_status` (CLEAN/DISCREPANT) on receipt insert/update |
| `trg_allocation_side_effects` | Updates receipt allocation status, compliance proceeds, and shipment status on allocation insert |
| `trg_pack_sealing_preconditions` | Raises 23514 if `nxp_approved`, `cci_obtained`, `bl_uploaded`, `payment_evidence_uploaded`, or `credit_advice_confirmed` is false at seal time |
| `trg_bank_evidence_pack_sealed` | Sets `compliance_records.bank_evidence_pack_generated = TRUE` after successful seal |
| `trg_audit_events_no_update/no_delete` | Prevents any UPDATE or DELETE on `audit_events` |

---

## Known limitations before pilot

- **Auth**: `local_users` with bcrypt + JWT is a v0.2 dev mechanism only. It does not support multi-tenant isolation, password reset, session revocation, or MFA. Replace with Supabase Auth or equivalent before any pilot.
- **No file storage**: Evidence records store document references (strings) only. No actual file upload or storage is implemented.
- **No email or notifications**: No deadline alerts, no payment-received notifications.
- **Single exporter per login**: Each user maps to exactly one exporter. No org-switching or multi-exporter support.
- **No pagination**: All list endpoints return all rows for the exporter. For large datasets this will be slow.
- **No rate limiting**: The API has no per-IP or per-user rate limiting.
- **No HTTPS**: The dev server runs plain HTTP on port 3000. A reverse proxy with TLS is required before any non-local access.
- **Partial repatriation**: SHP-2026-02 has only $10,000 of $40,000 received. The seeded evidence pack for that shipment cannot be sealed until the compliance checklist is completed and (for a real pilot) the remaining proceeds are received.

---

## Scope

ExportOS v0.2 is intentionally a system of record only. The following are permanently out of scope:

- Payment movement or fund transfers
- Stablecoin or crypto wallets
- FX trading or conversion
- AI-assisted classification or screening
- Sanctions screening
- TRMS submission
