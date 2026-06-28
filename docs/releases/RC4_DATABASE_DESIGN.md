# RC4 Database Design — Evidence Validation

**Date:** 2026-06-27
**ADR:** [ADR-012 — Evidence Validation Lifecycle](../adr/ADR-012-evidence-validation-lifecycle.md)
**Scope:** [RC4_SCOPE.md](RC4_SCOPE.md)
**Prerequisite:** RC3 complete (`f1f7efe`)

## Current Tables Affected

### `evidence_items`

The current source of truth for evidence state. One row per `(shipment_id, evidence_type)`.

**Fields relevant to RC4:**

| Field | Current CHECK values | Required additions |
|---|---|---|
| `lifecycle_state` | `missing`, `uploaded`, `under_review`, `validated`, `rejected` | rename `under_review` → `pending_review` (decided — see Open Questions #1); add `superseded` |
| `validation_status` | `not_validated`, `pending`, `passed`, `failed`, `not_applicable` | No additions required; `passed`/`failed` map to post-validation states |

**Existing constraints that interact with RC4:**

- `UNIQUE (shipment_id, evidence_type)` — one row per type; this is the current-snapshot model
- `evidence_type` is immutable after creation (`trg_evidence_type_immutable`)
- `validation_status = 'passed'` is blocked when `lifecycle_state = 'missing'` (trigger constraint)
- `updated_at` is auto-maintained by `trg_evidence_items_updated_at`

The `evidence_items` row is updated in-place on every transition. RC4 adds a paired write to `evidence_events` in the same transaction.

### `shipments`

No structural changes. `shipment_id` and `nxp_reference` are denormalised into `evidence_events` at write time for query efficiency, sourced from the corresponding `evidence_items` row.

### `exporter_users`

Currently holds `role VARCHAR(50) DEFAULT 'MEMBER'`. RC4 requires `REVIEWER` and `ADMIN` role values to be distinguishable by the actor resolution middleware. No new columns are needed if these values are added to the existing `role` field. The open question is whether reviewer scope is per-exporter (matching the current `exporter_users` model) or global.

---

## Proposed New Table: `evidence_events`

Append-only audit log. One row per lifecycle transition. Never updated or deleted.

### Column Definitions

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | `DEFAULT gen_random_uuid()`, primary key |
| `evidence_item_id` | `UUID` | NOT NULL | FK → `evidence_items(id)` |
| `shipment_id` | `UUID` | NOT NULL | Denormalised from `evidence_items` at write time |
| `exporter_id` | `UUID` | NOT NULL | Denormalised from `evidence_items` at write time |
| `nxp_reference` | `TEXT` | NOT NULL | Denormalised from `evidence_items` at write time |
| `evidence_type` | `TEXT` | NOT NULL | Denormalised from `evidence_items` at write time |
| `previous_lifecycle_state` | `TEXT` | NOT NULL | State before the transition |
| `new_lifecycle_state` | `TEXT` | NOT NULL | State after the transition |
| `previous_validation_status` | `TEXT` | NOT NULL | Validation status before the transition |
| `new_validation_status` | `TEXT` | NOT NULL | Validation status after the transition |
| `actor_user_id` | `UUID` | NULLABLE | JWT `sub` of the acting user; NULL for system-originated events |
| `actor_role` | `TEXT` | NOT NULL | One of: `exporter`, `reviewer`, `admin`, `system` |
| `event_type` | `TEXT` | NOT NULL | Machine-readable event name (see values below) |
| `reason` | `TEXT` | NULLABLE | Required when `actor_role` IN (`reviewer`, `admin`); optional otherwise |
| `metadata` | `JSONB` | NULLABLE | Extensible payload for future use (e.g. file reference, external reviewer ID) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `DEFAULT NOW()` set by the database; never set by the caller |

### `event_type` Values

| Value | Triggered by |
|---|---|
| `mark_uploaded` | Exporter submits a document (`missing → uploaded`) |
| `resubmit` | Exporter re-submits after rejection (`rejected → uploaded`) |
| `enter_review` | System moves item into review queue (`uploaded → pending_review`) |
| `validate` | Reviewer accepts the document (`pending_review → validated`) |
| `reject` | Reviewer rejects the document (`pending_review → rejected` or `uploaded → rejected`) |
| `supersede` | Admin replaces a validated item with a newer version (`validated → superseded`) |
| `system_seed` | Backfill event recording initial state for pre-existing items (created_at = migration time) |

### Constraints

```sql
PRIMARY KEY (id)

FOREIGN KEY (evidence_item_id) REFERENCES evidence_items(id)
-- No CASCADE DELETE: evidence_events must survive evidence_items archival

CHECK (actor_role IN ('exporter', 'reviewer', 'admin', 'system'))

CHECK (previous_lifecycle_state IN (
  'missing', 'uploaded', 'pending_review', 'validated', 'rejected', 'superseded'
))

CHECK (new_lifecycle_state IN (
  'missing', 'uploaded', 'pending_review', 'validated', 'rejected', 'superseded'
))

CHECK (previous_validation_status IN (
  'not_validated', 'pending', 'passed', 'failed', 'not_applicable'
))

CHECK (new_validation_status IN (
  'not_validated', 'pending', 'passed', 'failed', 'not_applicable'
))

CHECK (event_type IN (
  'mark_uploaded', 'resubmit', 'enter_review', 'validate',
  'reject', 'supersede', 'system_seed'
))

-- Immutability guard: no row may be updated or deleted
-- Enforced by trigger (BEFORE UPDATE OR DELETE → RAISE EXCEPTION)
-- and by withholding UPDATE/DELETE privileges from exportos_app on this table
```

### Indexes

```sql
-- Primary audit access pattern: history for a specific evidence item
CREATE INDEX idx_evidence_events_item_id
  ON evidence_events (evidence_item_id, created_at);

-- Tenant-scoped queries (all events for an exporter)
CREATE INDEX idx_evidence_events_exporter_id
  ON evidence_events (exporter_id, created_at);

-- Shipment-scoped queries (all events for a shipment)
CREATE INDEX idx_evidence_events_shipment_id
  ON evidence_events (shipment_id, created_at);

-- Actor audit: all actions by a specific user
CREATE INDEX idx_evidence_events_actor_user_id
  ON evidence_events (actor_user_id, created_at)
  WHERE actor_user_id IS NOT NULL;
```

---

## Relationship: Current Snapshot vs Append-Only History

```
evidence_items (1 row per shipment+type)          evidence_events (N rows per item)
────────────────────────────────────               ───────────────────────────────────
id ◄──────────────────────────────────────── evidence_item_id
lifecycle_state   (current)                  previous_lifecycle_state  new_lifecycle_state
validation_status (current)                  previous_validation_status new_validation_status
updated_at        (last change time)         created_at (each event time)
```

**Read pattern — current state:** Always read `evidence_items`. Never derive current state by replaying events.

**Read pattern — history:** Query `evidence_events WHERE evidence_item_id = $1 ORDER BY created_at ASC`. The first row's `previous_lifecycle_state` will be `missing` (initial seed event); the last row's `new_lifecycle_state` is the current state (should match `evidence_items.lifecycle_state`).

**Write pattern — every transition:**
1. `UPDATE evidence_items SET lifecycle_state = $new, validation_status = $newVS, updated_at = NOW() WHERE id = $id`
2. `INSERT INTO evidence_events (...) VALUES (...)`
Both steps in a single `BEGIN … COMMIT` block. If either fails, the transaction rolls back entirely.

---

## Backfill Strategy for Existing Items

RC3 (`f1f7efe`) backfilled `evidence_items` rows for all pre-existing compliance records. Those rows have no corresponding `evidence_events` history. RC4 must create a `system_seed` event for each existing `evidence_items` row so the audit trail is complete from the point of migration forward.

**Backfill INSERT logic:**

```sql
INSERT INTO evidence_events (
  evidence_item_id, shipment_id, exporter_id, nxp_reference, evidence_type,
  previous_lifecycle_state, new_lifecycle_state,
  previous_validation_status, new_validation_status,
  actor_user_id, actor_role, event_type,
  reason, created_at
)
SELECT
  id, shipment_id, exporter_id, nxp_reference, evidence_type,
  'missing',        lifecycle_state,      -- previous always 'missing' at seed
  'not_validated',  validation_status,
  NULL, 'system', 'system_seed',
  'Backfilled at RC4 migration — no prior event history',
  created_at                              -- preserve original created_at
FROM evidence_items
ON CONFLICT DO NOTHING;
```

This produces one `system_seed` event per item, timestamped at the item's `created_at`. The audit trail for any item that was already `uploaded` before RC4 will show a direct `missing → uploaded` transition attributed to system, which is accurate — the original upload occurred before event tracking existed.

---

## RLS / Privilege Considerations

### RLS on `evidence_events`

```sql
ALTER TABLE evidence_events ENABLE ROW LEVEL SECURITY;

-- Exporters: read their own records; no write access via RLS
CREATE POLICY rls_evidence_events_exporter_read ON evidence_events
  FOR SELECT
  USING (exporter_id IN (SELECT current_user_exporter_ids()));

-- Reviewers and admins: read all (requires role check in middleware, not RLS)
-- A second policy or BYPASSRLS for the reviewer role is required
```

`exportos_app` already holds BYPASSRLS. Application-layer role checks (middleware) enforce actor boundaries before the DB call is made. RLS provides a secondary tenant-isolation layer for exporter reads.

### Privileges for `exportos_app`

| Privilege | Required | Reason |
|---|---|---|
| `SELECT` | yes | History read endpoint |
| `INSERT` | yes | Every transition write |
| `UPDATE` | **no** | Table is append-only; withholding UPDATE enforces immutability at the role level |
| `DELETE` | **no** | Records are never deleted |

Grant statement (do not apply until migration is written):
```sql
GRANT SELECT, INSERT ON evidence_events TO exportos_app;
```

An immutability trigger (`BEFORE UPDATE OR DELETE → RAISE EXCEPTION`) provides a second layer of protection independent of the role grant.

---

## Migration Sequencing

Migrations must be applied in this order. Each depends on the previous.

| Order | Migration name (proposed) | Purpose |
|---|---|---|
| 1 | `RC4_001_evidence_items_extend_states` | Rename `under_review` → `pending_review` in `lifecycle_state` CHECK; add `superseded` to allowed values; update any rows with `under_review` (currently zero) |
| 2 | `RC4_002_evidence_events_table` | Create `evidence_events` table, constraints, indexes, immutability trigger, RLS policy |
| 3 | `RC4_003_evidence_events_grant` | `GRANT SELECT, INSERT ON evidence_events TO exportos_app` |
| 4 | `RC4_004_backfill_evidence_events` | Insert `system_seed` events for all existing `evidence_items` rows |
| 5 | `RC4_005_exporter_users_reviewer_role` | Add CHECK constraint `role IN ('MEMBER', 'ADMIN', 'REVIEWER')` to `exporter_users`; no existing constraint to drop (none present in schema); existing `ADMIN` row is valid under the new constraint |

Migrations 1–4 are independent of reviewer role storage and can proceed before open question 1 (ADR-012) is resolved. Migration 5 depends on that decision.

---

## Test Requirements

**Before any migration is applied:**
- Snapshot current `evidence_items` row counts per `lifecycle_state`
- Verify `evidence_events` does not exist (confirm clean starting state)

**After migration 1 (`extend_states`):**
- Confirm `superseded` is accepted by the CHECK constraint via a test INSERT + rollback
- Confirm current rows are unaffected

**After migration 2 (`evidence_events_table`):**
- Confirm table exists with correct column list
- Confirm immutability trigger blocks UPDATE and DELETE on any row
- Confirm RLS policy restricts exporter reads to own `exporter_id`

**After migration 3 (`evidence_events_grant`):**
- Confirm `exportos_app` can INSERT a row
- Confirm `exportos_app` cannot UPDATE or DELETE any row

**After migration 4 (`backfill_evidence_events`):**
- Confirm row count in `evidence_events` equals row count in `evidence_items`
- Confirm every `system_seed` event's `new_lifecycle_state` matches the corresponding `evidence_items.lifecycle_state`
- Confirm `created_at` on each event matches `evidence_items.created_at`

**After migration 5 (`reviewer_role`):**
- Confirm `REVIEWER` and `ADMIN` role values are accepted in `exporter_users` (or `reviewer_users`)
- Confirm seed operator row is unaffected

---

## Open Questions

1. ~~**`under_review` vs `pending_review` naming mismatch.**~~ **RESOLVED.** Decision: rename `under_review` → `pending_review` in the `lifecycle_state` CHECK constraint. Zero existing rows use `under_review`, so no data migration is needed. All RC4 documents and code must use `pending_review`. Migration RC4_001 encodes this rename.

2. ~~**Reviewer role storage.**~~ **RESOLVED.** Decision: extend `exporter_users.role` to include `REVIEWER` (and confirm `ADMIN` is already in use). No separate `reviewer_users` table. Rationale: simpler migration, reuses existing auth/user model, sufficient for RC4 role-gated validation, avoids premature institutional reviewer model; can be refactored if ExportOS later introduces regulator/bank/government reviewer organizations. Note: the existing `role` column has no CHECK constraint in the current schema (confirmed 2026-06-28) — migration RC4_005 adds one: `CHECK (role IN ('MEMBER', 'ADMIN', 'REVIEWER'))`. Existing `ADMIN` row is unaffected.

3. **`validation_status` alignment.** The current CHECK uses `passed` / `failed`; ADR-012 does not define `validation_status` values explicitly. Confirm whether `passed` maps to the `validated` lifecycle state and `failed` maps to `rejected`, or whether both fields evolve independently.

4. **`metadata` JSONB schema.** The column is intentionally open-ended for now. Define a minimal required shape (e.g. `{ "file_id": "...", "reviewer_notes": "..." }`) before the first non-system actor writes an event, to avoid uncontrolled structure accumulation.

5. **Cascading compliance sync.** Currently `compliance_records` booleans sync on `uploaded`. The compliance sync change from `uploaded` to `validated` is **deferred out of RC4** — it requires auditing all compliance read paths first and carries medium rollback risk. Design the sync change as its own migration post-RC4, not bundled with the state machine changes.
