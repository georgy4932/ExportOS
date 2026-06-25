# ExportOS UI Specification v1.0

Status: Approved Design Contract
Audience: Claude Code (implementation), future contributors
Version: 1.0
Principle: Case-first compliance operations

---

## 1. Product Purpose

ExportOS exists to help Nigerian exporters and compliance officers:

* Track export obligations
* Monitor repatriation deadlines
* Collect compliance evidence
* Generate evidence packs
* Resolve compliance exceptions

The system is not a document repository.

The system is not a reporting dashboard.

The system is not a collection of modules.

The primary object is the Export Case.

Everything revolves around an Export Case.

---

## 2. Core Information Architecture

### Approved Navigation

```
COMMAND CENTER
  Overview
  Work Queue
OPERATIONS
  Exports
ACCOUNT
  Settings
```

Nothing else appears in the primary sidebar.

---

### Explicitly Removed

These are backend concepts, not navigation concepts.

- Contracts
- Shipments
- Bills of Lading
- Payment Receipts
- Payment Evidence
- Compliance Records

They may exist in the database.

They do not appear as top-level destinations.

They are accessed through an Export Case.

---

## 3. Core Object Model

### Export Case

An Export Case is the primary working object.

Everything belongs to a case.

```
Export Case
├─ Shipment
├─ NXP
├─ Compliance Status
├─ Repatriation Status
├─ Documents
├─ Evidence
├─ Evidence Pack
├─ Timeline
└─ Follow-Up
```

Users should never need to navigate to another module to understand a case.

---

## 4. Status Model

Only these statuses exist.

### Case Statuses

- CRITICAL
- OVERDUE
- AT RISK
- COMPLIANT
- CLOSED

### Definitions

#### CRITICAL

Immediate regulatory risk.

Examples:
* Missing mandatory document near deadline
* Compliance breach requiring escalation

---

#### OVERDUE

Deadline passed.

Outstanding obligation exists.

Examples:
* Repatriation deadline passed
* Outstanding proceeds remain

---

#### AT RISK

Not overdue yet.

Action required before deadline.

Examples:
* Missing evidence
* Partial proceeds
* Unresolved discrepancy

---

#### COMPLIANT

All requirements satisfied.

No action required.

---

#### CLOSED

Case complete.

Archived.

---

## 5. Overview Screen

### Purpose

Answer:

> What needs attention today?

Not:

> Show me analytics.

---

### Layout Order

#### Section 1 — Severity Summary

- Critical
- Overdue
- At Risk

Raw counts only.

No percentages.

No charts.

---

#### Section 2 — Most Urgent Case

Contains:
- Case Name
- Status
- Outstanding amount
- Next Required Action

Single case only.

---

#### Section 3 — Upcoming Deadlines

Sorted ascending by date.

Shows:
- Case Name
- Deadline
- Days Remaining
- Status

---

#### Section 4 — Attention Required

Simple action list.

Example:
```
Sesame Export — UAE
Missing credit advice

Cashew Export — Spain
Outstanding proceeds
```

---

### Explicitly Excluded

- Revenue charts
- Ring charts
- Compliance percentages
- Large KPI dashboards
- Trend analytics

---

## 6. Work Queue Screen

### Purpose

Answer:

> What should I work on right now?

---

### Layout

#### Pipeline Strip

- Critical
- Overdue
- At Risk
- Compliant

Counts only.

---

#### Priority Groups

- CRITICAL
- OVERDUE
- AT RISK

Each group rendered separately.

---

### Queue Card Structure

Every card contains:

#### Identity

- Human Name
- NXP
- Shipment Reference

---

#### WHY

Required.

Explains why the case appears.

Example:
```
Repatriation deadline passed.
USD 480,000 outstanding.
Credit advice missing.
```

---

#### NEXT ACTION

Exactly one action.

Example:
```
Upload credit advice
```

---

#### OWNER

Example:
```
Finance Team
Compliance Team
Operations
```

---

#### Follow-Up State

One of:
- No Follow-Up
- WAITING
- FOLLOW-UP OVERDUE

---

#### Open Case Button

```
Open Case →
```

Required.

---

## 7. Exports Screen

### Purpose

Answer:

> Find any case.

---

### Layout

Single searchable list.

---

### Columns

- Case Name
- NXP
- Shipment Ref
- Status
- Deadline
- Outstanding Amount
- Evidence Pack Status

---

### Filters

- All
- Overdue
- At Risk
- Compliant
- Outstanding Proceeds

---

### Sorts

- Deadline
- Status
- Outstanding Amount
- Newest
- Oldest

---

### Deadlines Screen

Does not exist.

Deadline view is a filter/sort state inside Exports.

---

## 8. Export Case Screen

### Purpose

Answer:

> What happened?
> What is missing?
> What should I do?

---

### Information Order

#### 1. Case Identity

- Human Name
- NXP
- Shipment Ref
- Exporter
- Buyer
- Commodity
- Shipment Value

Human name is H1.

NXP is secondary.

---

#### 2. Status Banner

Single deterministic status.

Example:
```
OVERDUE
```

---

#### 3. Next Required Action

Must appear before all data.

Example:
```
Upload credit advice
```

---

#### 4. Follow-Up Panel

Contains:
- Status
- Owner
- Note
- Expected Resolution Date
- Last Updated

---

#### 5. Timeline

Required.

Most important section.

Shows:
- Expected events
- Completed events
- Missing events
- Late events

Example:
```
✓ Shipment created
✓ NXP approved
✓ Vessel departed
○ Payment expected
✗ Payment not received
✗ Deadline passed
```

The timeline must show missing expected events.

Not only completed events.

---

#### 6. Compliance Checklist

- NXP
- BL
- CCI
- Payment Evidence
- Credit Advice

Simple pass/fail structure.

---

#### 7. Proceeds & Repatriation

- Required
- Received
- Outstanding
- Deadline
- Late Flag

---

#### 8. Shipment Details

Reference information.

Lowest priority section.

---

### Explicitly Excluded

- No tab navigation
- No separate Compliance tab
- No separate Payment tab
- No separate Evidence Pack tab

The case is one scrollable workspace.

---

## 9. Follow-Up System

### Purpose

Answer:

> Is somebody actively handling this?

---

### States

- NONE
- WAITING
- FOLLOW-UP OVERDUE
- RESOLVED

---

### Follow-Up Fields

- Owner Role
- Owner Name
- Expected Resolution Date
- Note
- Last Updated

---

### Rules

#### WAITING

Expected resolution date in future.

---

#### FOLLOW-UP OVERDUE

Expected date passed.

Automatically escalated visually.

---

#### RESOLVED

Follow-up complete.

Underlying case may still remain open.

---

## 10. Evidence Pack Screen

### Purpose

Answer:

> Can this pack be sealed?

---

### Information Order

#### Pack Identity

- Pack Reference
- Version
- Status
- Related Case

---

#### Readiness Banner

Example:
```
PACK NOT READY
Missing:
- Payment Evidence
- Credit Advice
```

---

#### Document Inventory

Table.

Columns:
- Document
- Status
- Uploaded Date
- Action

---

#### Pack Actions

- Seal Pack
- Download Draft
- View Audit Log

Seal Pack disabled if incomplete.

---

#### Audit Trail

Required.

Shows:
- Timestamp
- Action
- Actor

---

## 11. Design Rules

### Layout

| Property | Value |
|---|---|
| Sidebar width | 196px |
| Content padding horizontal | 24px |
| Content padding vertical | 20px |
| Card radius | 7px |

### Typography

| Property | Value |
|---|---|
| Base | 13px |
| Labels | 12px |
| Uppercase metadata | 9–10px |

### Color Meaning

| Color | Meaning |
|---|---|
| Green | Complete, Success |
| Red | Overdue, Critical, Missing |
| Orange | At Risk |

---

## 12. Implementation Constraints For Claude Code

Claude Code must not:

### Change Navigation

Sidebar is fixed.

---

### Add New Screens

Without approval.

---

### Invent KPIs

Without approval.

---

### Replace Case-First Design

With module-first navigation.

---

### Hide Next Action

Behind tabs.

---

### Move Follow-Up

Away from the case screen.

---

### Remove Timeline

Timeline is mandatory.

---

## 13. Screenshot Acceptance Checklist

Implementation is approved only if:

### Overview

* Severity counts visible
* Most urgent case visible
* Upcoming deadlines visible
* Attention required visible

---

### Work Queue

* WHY visible on every card
* NEXT ACTION visible
* OWNER visible
* Follow-up visible

---

### Exports

* Filterable
* Searchable
* Deadline sortable

---

### Export Case

* Human name first
* Next action near top
* Follow-up panel present
* Timeline present
* Checklist present
* Proceeds present

---

### Evidence Pack

* Readiness banner present
* Missing items visible
* Inventory table present
* Seal disabled when incomplete
* Audit trail present
