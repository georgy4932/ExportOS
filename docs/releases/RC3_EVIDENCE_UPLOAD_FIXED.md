# ExportOS RC3 — Evidence Upload Fixed

**Date:** 2026-06-27
**Tag:** `exportos-rc3-evidence-upload-fixed`
**Commit:** `f1f7efe`

## Summary

RC3 restores the end-to-end evidence upload workflow in production after resolving three independent issues discovered during deployment. Each issue presented as a distinct error at a different layer of the stack: authentication, database permissions, and missing seed data. All three had to be resolved in sequence before a successful upload could complete.

## Incident timeline

1. Login succeeded.
2. Upload logged the user out.
3. Authorization header regression identified.
4. Upload returned "permission denied for table evidence_items".
5. Database privileges corrected.
6. Upload returned "Export case or evidence item not found".
7. Root cause traced to missing evidence_items rows.
8. Backfill migration applied.
9. Production browser verification passed.
10. Database persistence verified.

## Root causes

### RC3-1

Authorization header lost during PATCH because `apiFetch` spread order overwrote headers.

`markUploaded` is the only caller that passes `options.headers`. The spread `{ headers: authHeaders(), ...options }` allowed `options.headers` to overwrite the `Authorization: Bearer` token, causing the server to reject the request as unauthenticated and the frontend to redirect to the sign-in screen.

**Fix:** Move `...options` before `headers` so the auth header always wins.

### RC3-2

`exportos_app` lacked `SELECT`, `INSERT`, and `UPDATE` on `evidence_items`.

The table was created in migration 0008 after the one-time broad `GRANT ALL ON ALL TABLES` had already been applied. New tables are not covered retroactively. `SELECT … FOR UPDATE` (required by the mark-uploaded write path) requires `UPDATE` privilege, which was never granted.

**Fix:** Migration `20260627000001_evidence_items_grant.sql`

### RC3-3

Production `compliance_records` predated the `evidence_items` trigger.

Migration 0008 introduced a `seed_evidence_items()` function that fires `AFTER INSERT ON compliance_records`. The production database already had `compliance_records` rows from the initial seed. `AFTER INSERT` triggers do not fire retroactively, so `evidence_items` was empty for all seeded shipments.

**Fix:** Migration `20260627000002_backfill_evidence_items.sql`

## Production verification

- Login successful
- Upload ADV successful on NXP-2026-SES-001
- PATCH returned success
- UI updated to "Document marked as uploaded"
- `lifecycle_state` changed to `uploaded`
- `uploaded_at` populated (`2026-06-27 23:28:27 UTC`)
- `updated_at` changed

## Lessons learned

- New trigger-based tables require explicit backfills for existing production data.
- Verify database grants whenever introducing new tables after an initial schema deployment.
- End-to-end production validation is required before declaring deployment complete.
- Data migrations should be treated as first-class release artifacts.

## Status

RC3 complete.
