# RC4 Frontend Design — Evidence Validation

**Date:** 2026-06-28
**ADR:** [ADR-012 — Evidence Validation Lifecycle](../adr/ADR-012-evidence-validation-lifecycle.md)
**Scope:** [RC4_SCOPE.md](RC4_SCOPE.md)
**DB Design:** [RC4_DATABASE_DESIGN.md](RC4_DATABASE_DESIGN.md)
**API Design:** [RC4_API_DESIGN.md](RC4_API_DESIGN.md)
**Prerequisite:** RC3 complete (`f1f7efe`)

---

## Existing Screens Affected

All frontend changes are contained in `public/app/index.html` (the single-file SPA).

### Export Case Detail — Evidence Checklist

The evidence checklist (`eck()` function, ~line 3955) currently renders two states per row: `uploaded` (✓ green, "On file" + View button) and everything else (✗ red, "Missing" + Upload button). RC4 must extend this to render all six `lifecycle_state` values with distinct visual treatments and role-appropriate action buttons.

The `getEvidenceState()` helper (~line 3551) already passes `lifecycle_state` through from `_evidenceCache`. New states will surface automatically once the API returns them. The gap is in `badgeClass` (currently only `'on-file'` and `'missing'`), button selection logic, and the hardcoded red/green binary treatment in CSS.

### Export Case Detail — Evidence Summary Card

The Evidence Summary card's Next Missing Document section (~line 4059) uses `nmdPriority` to pick the first missing type from `chkBlocking`. `chkBlocking` currently collects items where `evState.state !== 'uploaded'`. This must be updated to distinguish between actionable states (missing, rejected → show Upload) and non-actionable states from the exporter's perspective (pending_review, validated, superseded → no upload action needed).

### Dashboard Overview — Most Urgent Case Panel

`loadOverview()` (~line 2335) derives `nextAction` and `blocker` by checking `state !== 'uploaded'`. With RC4 states, an item in `pending_review` or `validated` no longer requires exporter action. The `nextAction` and `blocker` derivation must be updated to treat `pending_review` and `validated` as non-blocking for exporters. `rejected` must surface as its own next action ("Re-upload [type]").

### `/auth/me` Response — Role Awareness

The SPA currently stores only the JWT token in `sessionStorage`. RC4 requires the actor role (`exporter`, `reviewer`, `admin`) to be fetched from `GET /auth/me` (which RC4 API extends with `actorRole`) and stored in memory alongside the session. Role is used to gate action buttons — it must never be derived client-side from email or name.

---

## New UI States

### State visual treatment

Each `lifecycle_state` maps to a distinct badge colour, icon, status label, and CSS modifier class on `.ec-chk`.

| `lifecycle_state` | Badge colour | Icon | Status label | CSS modifier |
|---|---|---|---|---|
| `missing` | Red | ✗ | Missing | `chk-miss` (existing) |
| `uploaded` | Amber | ⏳ | Awaiting review | `chk-uploaded` (new) |
| `pending_review` | Blue | ◷ | In review | `chk-review` (new) |
| `validated` | Green | ✓ | Validated | `chk-done` (new) |
| `rejected` | Red (dark) | ✗ | Rejected | `chk-rejected` (new) |
| `superseded` | Grey | — | Superseded | `chk-superseded` (new) |

**Design note on `uploaded`:** RC3 treated `uploaded` as a terminal success state (green ✓, "On file"). RC4 changes this: `uploaded` means submitted but not yet reviewed. The visual should signal pending action rather than completion. Green should be reserved for `validated` only.

### `badgeClass` extension in `getEvidenceState()`

The `badgeClass` returned by `getEvidenceState()` currently maps `isPresent → 'on-file'` and `!isPresent → 'missing'`. RC4 replaces this with a per-state mapping:

```
missing        → 'missing'
uploaded       → 'awaiting-review'
pending_review → 'in-review'
validated      → 'validated'
rejected       → 'rejected'
superseded     → 'superseded'
```

All callers of `getEvidenceState()` that branch on `badgeClass` must be updated, but callers that only compare `state === 'uploaded'` (the compliance check) must be deliberately left alone until the compliance sync point decision (RC4 open question) is resolved.

---

## User Actions by Role

The action button rendered per checklist row depends on both `lifecycle_state` and `actorRole`. The two axes produce the following matrix.

**Note on UI vs API scope:** The API permits `validate` and `reject` from both `uploaded` and `pending_review` states. The frontend intentionally shows Validate/Reject buttons only on `pending_review` rows for reviewers — `uploaded` rows show only "Submit for Review →". This is a workflow guardrail, not an API restriction. The API path `uploaded → validated` remains available for admin use and future automation; the UI simply does not surface it to reviewers to encourage consistent queue discipline.

| State | exporter/operator | reviewer | admin |
|---|---|---|---|
| `missing` | Upload → | — | — |
| `uploaded` | — | Submit for Review → | Validate → / Reject → |
| `pending_review` | — | Validate → / Reject → | Validate → / Reject → |
| `validated` | View → | View → | Supersede → |
| `rejected` | Re-upload → | — | — |
| `superseded` | View → | View → | View → |

Rules:
- Exporters never see Validate, Reject, or Supersede buttons.
- Reviewers never see Upload or Re-upload buttons.
- Admins see all actions; their transitions require a reason in all cases.
- The View button appears for any actor on `validated` and `superseded` items (future file storage integration).
- "—" means no action button is rendered; the row is display-only.

`actorRole` is fetched once on session start from `/auth/me` and stored in a module-level variable `_actorRole`. It must not be re-derived per render.

---

## Evidence Timeline Component

Each evidence item's detail view gains a collapsible audit trail panel showing all `evidence_events` for that item in chronological order.

### Data source

`GET /export-cases/:nxp_reference/evidence/:evidence_type/events`

Fetched lazily when the user expands the panel. Not prefetched on case open. Stored in a separate cache `_eventsCache[nxpRef][evidenceType]` to avoid polluting `_evidenceCache`.

### Layout (per event row)

```
[timestamp]  [actor badge]  [transition arrow]  [reason snippet]
2026-06-27   SYSTEM         missing → uploaded
2026-06-28   REVIEWER       uploaded → validated   "Document confirmed..."
```

Columns:
- **Timestamp:** formatted as `YYYY-MM-DD HH:mm UTC` using the existing `date()` helper
- **Actor badge:** pill showing `actor_role` value (`SYSTEM`, `EXPORTER`, `REVIEWER`, `ADMIN`)
- **Transition:** `previous_lifecycle_state → new_lifecycle_state` in monospace
- **Reason:** first 80 characters of `reason` if present; truncated with `…` and a "Show more" toggle

Empty state: "No history available" if the events array is empty (should not occur after RC4 migration 4 backfill, but defensive).

### Expand/collapse

The panel is collapsed by default. A chevron toggle button sits in the evidence item detail card header. Keyboard-accessible: `aria-expanded`, `aria-controls`.

---

## Review Action UI

### Submit for Review (reviewer / admin only)

Appears as a button on rows in `uploaded` state, visible only to `reviewer` and `admin` actors.

**Interaction:** Single click → immediate PATCH to `/submit-review` → optimistic UI update to `pending_review`. No modal required; no reason needed.

**Failure:** If PATCH returns non-200, revert optimistic state and show inline error toast.

### Validate (reviewer / admin only)

Appears on rows in `uploaded` or `pending_review` state.

**Interaction:**
1. Click **Validate →**
2. Inline confirmation row expands below the checklist row (no full-screen modal)
3. Text field: "Validation note (required)" — pre-filled placeholder "Document confirmed accurate and complete"
4. Submit / Cancel buttons
5. Submit sends PATCH to `/validate` with `{ reason }` → optimistic update to `validated` (green)
6. Cancel collapses without change

**Validation:** Submit button disabled until text field contains at least 5 characters.

### Reject with Reason (reviewer / admin only)

Appears on rows in `uploaded` or `pending_review` state.

**Interaction:**
1. Click **Reject →**
2. Inline row expands (same pattern as validate)
3. Text field: "Rejection reason (required)" — no pre-fill; must be explicit
4. Submit / Cancel
5. Submit sends PATCH to `/reject` with `{ reason }` → optimistic update to `rejected` (red)
6. Cancel collapses without change

**Validation:** Submit button disabled until text field contains at least 10 characters (rejection reasons must be substantive).

**Post-rejection:** The row immediately shows the rejection reason beneath the label in the checklist, visible to all actors including the exporter.

### Re-upload (exporter / admin only)

Appears on rows in `rejected` state for exporter/operator actors.

**Interaction:** Single click → identical to existing Upload → flow (PATCH to existing mark_uploaded endpoint). The rejection reason remains visible below the new Upload button so the exporter knows what to fix.

### Supersede (admin only)

Appears on rows in `validated` state for admin actors.

**Interaction:**
1. Click **Supersede →**
2. Inline row expands
3. Text field: "Supersession reason (required)"
4. Submit / Cancel
5. Submit sends PATCH to `/supersede` with `{ reason }` → row moves to `superseded` (grey)
6. Cancel collapses without change

---

## Error and Loading States

### Loading state (during PATCH)

When any review action PATCH is in flight:
- The action button is replaced with a spinner text ("Saving…")
- The checklist row is dimmed (`opacity: 0.6`)
- Other action buttons on the same row are hidden to prevent concurrent writes
- No full-screen overlay — the rest of the case remains interactive

### Error state (PATCH fails)

When a PATCH returns a non-200 response:
- The optimistic state update is reverted immediately
- A toast notification appears: `"[Action] failed: [error message from response body]"`
- The reason input (if open) is preserved so the user does not lose their text
- For `409 INVALID_TRANSITION`: toast explains current state — "Cannot validate: item is currently [state]"
- For `403 FORBIDDEN`: toast — "You do not have permission to perform this action"
- For `400 VALIDATION_REQUIRED`: toast — "A reason is required before submitting"

### Loading state (events panel fetch)

When `GET .../events` is in flight after expanding the timeline panel:
- Panel shows a single row: "Loading history…" with a subtle pulsing placeholder
- No spinner overlay

### Error state (events fetch fails)

Panel shows: "Could not load history. [Retry]" — clicking Retry re-fetches.

---

## Empty States

### All evidence validated

When all `required_for_compliance` items reach `validated` state:
- Evidence Summary card: "Evidence pack complete and validated" (replaces the existing "No missing documents" message)
- Next Missing Document section: hidden

### Exporter view — all items in review

When all `required_for_compliance` items are `uploaded` or `pending_review` (none `missing` or `rejected`):
- Evidence Summary card: "All documents submitted — awaiting reviewer sign-off"
- Upload buttons not shown
- Next action for exporter: none

### No events in timeline

"No transition history available for this item." Shown only if the events endpoint returns an empty array; should not occur in normal operation after the RC4 backfill.

---

## Accessibility Considerations

1. **State icons must not rely on colour alone.** Each state has both an icon character (✗ / ✓ / ⏳ / ◷ / —) and a text label ("Missing", "Validated", etc.). Colour is additive, not the sole signal.

2. **Action buttons must have `aria-label`.** The existing pattern (`aria-label="Upload document for Credit Advice"`) must be extended for new actions: `aria-label="Validate Credit Advice"`, `aria-label="Reject Credit Advice"`, `aria-label="View audit trail for Credit Advice"`.

3. **Inline expand panels must use `aria-expanded` and `aria-controls`.** The confirm/cancel row for validate/reject must be reachable by keyboard in tab order immediately after the triggering button.

4. **Toast notifications must use `role="alert"` or `aria-live="polite"`.** The existing toast system should be verified against this requirement before RC4 ships.

5. **Disabled submit buttons must have `aria-disabled="true"` and `title` explaining the requirement.** "Validation note is required (minimum 5 characters)"

6. **Timeline panel toggle:** The chevron button must have a visible label that updates on state change — "Show history" / "Hide history" — not just a rotating arrow icon.

---

## `nextAction` and `blocker` Logic Updates

The existing `loadOverview()` derivation treats `state !== 'uploaded'` as a missing/blocking condition. RC4 must update both chains:

**`nextAction` (for exporter):**
```
missing    → "Upload [type]"
rejected   → "Re-upload [type]"  ← new
uploaded   → (not blocking — in reviewer queue)
pending_review → (not blocking)
validated  → (not blocking)
```

**`blocker` (compliance gate):**
```
missing    → "Missing [type]"
rejected   → "Rejected — re-upload required"  ← new
uploaded   → "Awaiting reviewer sign-off"      ← new (soft blocker)
pending_review → "Under review"               ← new (soft blocker)
validated  → (not blocking)
```

Soft blockers (`uploaded`, `pending_review`) indicate the exporter has done their part but the pack cannot seal until a reviewer validates. They should display with a different visual treatment than hard blockers (`missing`, `rejected`) — amber rather than red.

---

## Test Requirements

No separate test framework. Tests follow the existing verify-script and Playwright patterns.

**Playwright verification script: `verify-evidence-validation-ui.ts` (new)**

Playwright is available at `/opt/pw-browsers/chromium`. Script runs against the production or local environment.

1. Login as exporter — confirm Validate / Reject buttons not visible on any row
2. Login as reviewer — confirm Upload button not visible; Validate / Reject visible on `uploaded` rows
3. Reviewer: expand validate inline form → confirm Submit disabled until text entered → submit → row turns green
4. Reviewer: expand reject inline form → confirm Submit disabled until 10 chars → submit → row turns red
5. Exporter (after rejection): confirm rejection reason visible; Re-upload button present; click Re-upload → row returns to amber `uploaded`
6. Expand timeline panel → confirm events list appears with correct state sequence
7. Admin: confirm Supersede button visible on `validated` row
8. Toast on 403: confirm "You do not have permission" message appears when exporter attempts a reviewer action via the console

**Manual check (cannot automate in container):**
- Colour contrast of new badge states meets WCAG AA (4.5:1 for text)
- Keyboard tab order through inline expand panels is logical
- `aria-expanded` toggles correctly on timeline panel

---

## Out of Scope

Per RC4_SCOPE.md and permanent scope constraints:

- OCR, AI validation, external file storage, notifications, government integrations
- Payment movement, FX, stablecoin wallets, sanctions screening, TRMS
- Marketing sections, invented customer data, testimonials
- Any screen not listed in this document
- Frontend changes for the `supersede` endpoint beyond the admin-only button — full supersession workflow (selecting a replacement document) is deferred
- Mobile-specific reviewer workflow — responsive layout for the inline expand panels is in scope; a dedicated mobile reviewer flow is not
- Bulk review actions (validate/reject all) — deferred
