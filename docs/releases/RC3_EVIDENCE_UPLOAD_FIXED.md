# ExportOS RC3 — Evidence Upload Fixed

**Date:** 2026-06-27
**Tag:** `exportos-rc3-evidence-upload-fixed`
**Tagged commit:** `f1f7efe`

## Production Verification

Upload ADV on `NXP-2026-SES-001` was tested in a production browser session.
The PATCH request returned 200, the UI changed to "document marked as uploaded",
and the DB row was confirmed:

| field | value |
|---|---|
| `lifecycle_state` | `uploaded` |
| `uploaded_at` | `2026-06-27 23:28:27 UTC` |
| `updated_at` | `2026-06-27 23:28:27 UTC` |
| `validation_status` | `pending` |

## Root Cause Chain

Three layered bugs prevented evidence upload from working end-to-end.
Each had to be fixed in order.

### 1. `apiFetch` Authorization header regression

`apiFetch` spread `...options` after the `headers` object, so any call that
passed `options.headers` (only `markUploaded`) silently overwrote the
`Authorization: Bearer` token. The PATCH reached the server unauthenticated
and returned 401, which the frontend interpreted as a session expiry and
redirected to the sign-in screen.

**Fix:** Moved `...options` before `headers` in the fetch init object so the
auth header always wins. (`e10376d`, PR #53)

### 2. Missing `evidence_items` table privileges for `exportos_app`

`evidence_items` was created in migration 0008 after the one-time broad
`GRANT ALL ON ALL TABLES` had already been applied to `exportos_app`. New
tables are not covered retroactively. `SELECT … FOR UPDATE` (used by the
mark-uploaded write path) requires UPDATE privilege, which was never granted,
so the first DB query on the PATCH path failed with
`permission denied for table evidence_items`.

**Fix:** New migration granting `SELECT, INSERT, UPDATE` to `exportos_app`.

**Migration:** `20260627000001_evidence_items_grant.sql`

### 3. No `evidence_items` rows for pre-existing compliance records

Migration 0008 seeded `evidence_items` via an `AFTER INSERT ON compliance_records`
trigger (`seed_evidence_items()`). The production DB already had
`compliance_records` rows from the initial seed; `AFTER INSERT` triggers do not
fire retroactively. `evidence_items` was therefore empty for all seeded
shipments. With permissions now fixed, the PATCH passed authentication and
permissions but returned 404 (`Export case or evidence item not found`) because
the `SELECT … FOR UPDATE` returned zero rows.

**Fix:** New migration that backfills `evidence_items` for every existing
`compliance_record` using the same INSERT logic as the trigger, with
`ON CONFLICT (shipment_id, evidence_type) DO NOTHING` for idempotency.
21 rows inserted across 3 shipments (7 evidence types each).

**Migration:** `20260627000002_backfill_evidence_items.sql`

## Migrations

| File | Purpose |
|---|---|
| `supabase/migrations/20260627000001_evidence_items_grant.sql` | Grant SELECT, INSERT, UPDATE on evidence_items to exportos_app |
| `supabase/migrations/20260627000002_backfill_evidence_items.sql` | Backfill evidence_items rows for pre-existing compliance_records |

## Final Verified Result

Upload ADV on `NXP-2026-SES-001` succeeded in production. The
`evidence_items` row for `credit_advice` persisted `lifecycle_state = uploaded`
in the database, confirming the full write path — authentication, DB
permissions, row existence, UPDATE, and compliance_records boolean sync —
is working end-to-end.
