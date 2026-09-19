# Slice 4 frontend contract: investigations, results, review and telling the patient

> **The backend is built. No screen renders any of it.** This document is what
> a screen would be built against, and it is deliberately written before one
> exists so that the first one does not quietly invent a rule.
>
> Owner policy items 84–88, `docs/OWNER_POLICY_REGISTER.md` §N. The schema and
> its reasoning are `docs/SCHEMA_AND_TYPES.md` §17.

Companion to [`SLICE1_FRONTEND_CONTRACT.md`](SLICE1_FRONTEND_CONTRACT.md) and
[`SLICE2_FRONTEND_CONTRACT.md`](SLICE2_FRONTEND_CONTRACT.md), which it extends
rather than replaces.

## Contents

1. [The four authorities](#1-the-four-authorities)
2. [Commands](#2-commands)
3. [Reads](#3-reads)
4. [States, and what a screen may say](#4-states-and-what-a-screen-may-say)
5. [Documents](#5-documents)
6. [Every refusal code this slice adds](#6-every-refusal-code-this-slice-adds)
7. [Retrying](#7-retrying)
8. [The role matrix, in one place](#8-the-role-matrix-in-one-place)
9. [What this contract does not answer](#9-what-this-contract-does-not-answer)

---

## 1. The four authorities

A screen that treats these as one will be wrong in a way nobody notices until
it matters. They are four different questions with four different answers.

| | Who | Used for |
|---|---|---|
| **authorized doctor** | the doctor role **and** `session.canPublishClinicalTemplates` | approving, retiring and versioning clinical catalogue content (item 84) |
| **doctor with standing** | the order's responsible doctor, the doctor who ordered it, or a doctor explicitly delegated to it | flagging, reviewing, authorizing a notice, contacting the patient (items 85–88) |
| **transcriber** | admin, nurse or doctor | filing a report and the flag the report itself carries; no clinical judgment of their own |
| **pharmacy** | — | nothing. Every command refuses, every read 403s, the `results` endpoint refuses before it reads a query string |

A session does not carry its standing on an order, so a screen cannot compute
"may I review this?" locally. Ask the read: `view.investigation_order` returns
`responsibleDoctor` and `delegatedDoctor` by name, and the command refuses with
`NOT_THE_RESPONSIBLE_DOCTOR` if the answer is no. **Do not hide the control
instead of calling the command** — a hidden button is not an authorization, and
the refusal carries the sentence the doctor needs to read.

`canPublishClinicalTemplates` **is** on the session, so a catalogue screen may
use it to choose between "Save draft" and "Save and approve". It is still
checked on the server.

---

## 2. Commands

All fourteen go to `POST /command` as `{ action, payload }`, like every other
command in this application.

### Catalogue — owner item 84

#### `draft_investigation` — admin, doctor

| Field | |
|---|---|
| `kind` | `investigation` \| `referral` |
| `displayName` | required |
| `category` | `haematology` \| `biochemistry` \| `microbiology` \| `histopathology` \| `imaging` \| `cardiology` \| `specialist_referral` \| `other` |
| `specimen` | optional; refused on a referral |
| `preparation` | optional — fasting, timing |
| `seriesId` | optional. Omitted starts a new series; supplied drafts the next version of one |
| `externalCode`, `codeSystem`, `defaultFacility`, `operationalLabel`, `orderable` | the operational half, optional |

Returns `{ catalogueId, seriesId, version, contentFingerprint }`. A draft
cannot be ordered. Re-drafting identical clinical content is refused with
`CATALOGUE_UNCHANGED` — the operational half is not in the fingerprint, so
correcting a facility's name is not a new version.

#### `approve_investigation` — **authorized doctor**

`{ catalogueId }`. Retires the previous approved version of the series in the
same transaction. Refuses `CATALOGUE_NOT_A_DRAFT`.

#### `retire_investigation` — **authorized doctor**

`{ catalogueId, reason }`. Requests already placed keep the definition they
were placed under. Refuses `CATALOGUE_NOT_APPROVED`.

#### `update_investigation_metadata` — admin, doctor

`{ catalogueId }` plus any of `externalCode`, `codeSystem`, `defaultFacility`,
`operationalLabel`, `orderable`. Omitted fields keep their value.

**This is the only catalogue command an administrator may complete.** The
clinical half is unreachable from here and from anywhere else: the table's
trigger refuses it. Refuses `CATALOGUE_RETIRED`.

### Ordering

#### `order_investigation` — **doctor only**

| Field | |
|---|---|
| `idempotencyKey` | **required** — see §7 |
| `patientId` | required |
| `items` | array of `catalogueId`, at least one |
| `encounterId` | optional; must be this patient's, enforced by a composite foreign key |
| `responsibleDoctorId` | optional, defaults to the caller; must hold the doctor role |
| `priority` | `routine` (default) \| `urgent` |
| `clinicalIndication`, `instructions`, `externalFacility` | optional |
| `expectedBy` | optional `YYYY-MM-DD`. An operational chase date. It never releases or reviews anything |

Returns `{ orderId, orderNumber, items: [{ itemId, name }] }`. On replay it
also returns `duplicate: true` and `cancelled: true|false`.

#### `cancel_investigation_order` — doctor with standing

`{ reason }` plus **either** `orderId` **or** `itemId`, not both. Refuses
`RESULT_ALREADY_RECEIVED` if a report has come back — cancelling then would
hide a result somebody has to read. Refuses `ALREADY_CANCELLED`.

#### `mark_investigation_sent` — admin, doctor, nurse

`{ itemId, note? }`. The specimen went, or the patient was sent. Operational;
it records no clinical judgment. Refuses `ALREADY_IN_PROGRESS`.

### The report — owner item 85

#### `record_result` — admin, doctor, nurse

| Field | |
|---|---|
| `idempotencyKey` | **required** |
| `orderItemId` | required |
| `source` | `external_laboratory` \| `external_facility` \| `imported_structured_feed` \| `clinic_recorded` |
| `sourceReference`, `reportedAt` | optional |
| `reportText` | the report as it arrived. Required unless a document will carry it |
| `sourceFlag` | `none` (default) \| `abnormal` \| `urgent` \| `critical` — **what the report said** |
| `sourceFlagOrigin` | `none` \| `external_report` \| `imported_structured` |
| `sourceFlagReference` | required whenever a flag is given |
| `externalValidatedBy`, `externalValidatedAt`, `externalSignatoryReference` | the laboratory's own sign-off, retained as evidence |
| `correctsResultId` + `correctionReason` | both or neither |

Returns `{ resultId, corrects?, supersededNotifications? }`.

**There is no parameter here that reaches a doctor's flag.** Item 85's third
origin is `flag_result` and nothing else.

A second report for one line without `correctsResultId` is refused with
`RESULT_ALREADY_RECORDED`. A correction makes the old report history and gives
the new one **no review and no authorization** — a screen must show that the
patient still cannot be told.

#### `flag_result` — doctor with standing

`{ resultId, flag: 'abnormal'|'urgent'|'critical', reason }`. Written once;
`ALREADY_FLAGGED` on a second attempt, and refused outright once a notice has
been authorized (`NOTIFICATION_ALREADY_AUTHORIZED`). It never overwrites what
the source reported; both flags are returned separately by the read.

#### `acknowledge_critical_result` — doctor with standing, **or the owner-doctor**

`{ resultId, note? }`. Item 87 escalates a critical result to the owner-doctor,
so they can acknowledge one they have no other standing on. Refuses
`NOT_A_CRITICAL_RESULT`. A second call returns `duplicate: true`.

Acknowledging is **not** reviewing, and the screen must not imply it is.

### Review and release — owner items 86 and 88

#### `delegate_result_review` — responsible doctor, ordering doctor, or the owner-doctor

`{ orderId, toDoctorId, reason }`. Item 86's "explicitly delegated doctor",
made explicit. Refuses `DELEGATE_IS_NOT_A_DOCTOR`.

#### `review_result` — doctor with standing

`{ resultId, conclusion, note? }` where `conclusion` is `no_action_needed` |
`patient_to_be_informed` | `clinical_action_taken`. Returns `{ basis }`.

A second review by the same doctor returns `duplicate: true` and the stored
conclusion; by a different doctor it is refused with `ALREADY_REVIEWED`, naming
who reviewed it first. Refuses `RESULT_SUPERSEDED` on a corrected report.

#### `authorize_result_notification` — doctor with standing

`{ resultId }`. Returns `{ scheduleId, consent }` where `consent` is
`opt_in` | `withdraw` | `none`.

Refusals worth building for:

- `RESULT_NOT_REVIEWED` — item 86's rule, held by a trigger as well as here.
- `CRITICAL_RESULT_NEEDS_DIRECT_CONTACT` — item 88. A critical result cannot
  enter the automated path at all; the screen should offer the telephone call
  instead.
- `RESULT_SUPERSEDED`, `ORDER_CANCELLED`.

**Authorization is not sending.** With `consent` anything but `opt_in`, or with
the clinic's WhatsApp connection unconfigured — which is its present state —
the message is suppressed into the admin's queue with a coded reason and
nobody is messaged. Say so rather than showing a tick.

#### `record_patient_result_contact` — admin, doctor, nurse

`{ resultId, method: 'telephone'|'in_person'|'other', note }`. Item 88's fourth
fact. A **critical** result's contact is doctor-only:
`CRITICAL_CONTACT_IS_CLINICIAN_LED`. Written once; a second call returns
`duplicate: true`.

---

## 3. Reads

All on `GET /workspace`, like every other on-demand read.

### `?view=result_review_queue` — admin, doctor

Everything current and unreviewed.

```jsonc
{
  "access": "clinical" | "operational",
  "escalationAfterClinicHours": 4,
  "escalationCeilingHour": 20,
  "criticalAcknowledgementMinutes": 15,
  "rows": [{
    "resultId": "…", "orderId": "…", "orderNumber": "REQ-000123",
    "patientName": "…", "itemName": "Full blood count",
    "receivedAt": "19 Sep 14:20", "waitingHours": 3.4,
    "responsibleDoctor": "…", "delegatedDoctor": "",
    "escalatedToOwnerDoctor": false,
    // clinical only — absent entirely for an administrator
    "flag": "none", "criticalUnacknowledged": false,
    "acknowledgementOverdue": false
  }]
}
```

A doctor sees their own; an authorized doctor also sees everything item 87 has
escalated to them, **and only that** — the owner-doctor's queue is the
escalation, not a second copy of every colleague's inbox. An administrator sees
all of them with `access: "operational"` and no clinical fields at all. Branch
on `access`; do not infer it from the role.

### `?view=result_escalations` — **doctor only**

```jsonc
{
  "backupDoctorConfigured": false,
  "criticalAcknowledgementMinutes": 15,
  "rows": [{
    "resultId": "…", "orderNumber": "…", "patientName": "…", "itemName": "…",
    "flag": "critical", "receivedAt": "…",
    "reason": "critical_unacknowledged" | "unreviewed_past_clinic_hours",
    "manualEscalationOwed": true,
    "responsibleDoctor": "…"
  }]
}
```

`manualEscalationOwed` means item 87's fifteen minutes have passed and somebody
owes a telephone call. **It is a statement about a person, not a trigger** —
nothing telephones anybody, releases anything or tells a patient.

`backupDoctorConfigured` is `false` and will stay false until the clinic
configures one. Do not render a backup doctor.

### `?view=investigation_order&orderId=…` — admin, doctor, nurse

One request form with its lines, each line's results newest first, each result
with its documents, its review, its notification and its contact. `access` is
`clinical` or `operational`; on `operational` the report text, the flags and
the review note are **absent keys**, not empty strings.

Every result carries `externalValidationIsNotClinicReview: true`. It is in the
payload rather than left to a caption because a table built later must not be
able to label the laboratory's signature as the clinic's review.

404 if the request does not exist; 403 if this caller may not see this
patient's results — a nurse not involved in their care gets the sentence that
tells them what to do about it.

### `?view=patient_investigations&patientId=…` — admin, doctor, nurse

`{ access, orders: [ …the same shape… ] }`, newest first, fifty at most.

---

## 4. States, and what a screen may say

`state` on each line, in the precedence the backend derives it:

| State | Say |
|---|---|
| `cancelled` | withdrawn, with the reason |
| `manually_contacted` | somebody spoke to the patient, and who |
| `notified` | **the only state that may say the patient was told by message.** It requires an authenticated provider delivery event |
| `provider_outcome_unknown` | the message went out and the reply was lost. Not sent, not failed, and never retried automatically |
| `notification_pending` | authorized, and anything short of delivered — queued, accepted by Meta, suppressed, failed |
| `closed` | reviewed, no further action |
| `reviewed` | a doctor has read it; the patient has not been told |
| `awaiting_review` | a report is in and nobody has read it |
| `overdue` | past the expected-by date, nothing back |
| `in_progress` | sent out |
| `ordered` | requested |

The rule behind the table: **an authorization, a queue entry, an HTTP 200 and
Meta accepting the message are each two or more steps short of the patient
knowing anything.** Each has its own state so that a screen cannot round them
up into a tick.

**The state does not depend on who is reading.** An administrator, who is not
shown a review's conclusion, still gets `closed` on a line a doctor sees as
`closed`. Whether a line still owes somebody work is operational, and a state
that changed with the reader would be discovered during an argument about
whether something was dealt with.

---

## 5. Documents

A separate endpoint, `/results`, because bytes are not JSON.

```text
POST /results                              multipart: attach a report
GET  /results?action=ticket&documentId=…   a sixty-second ticket
GET  /results?documentId=…&ticket=…        the bytes
```

**Upload** (`admin`, `doctor`, `nurse`) takes `resultId`, `idempotencyKey`,
`source`, optional `sourceReference`, `originalFilename`,
`supersedesDocumentId`, and `file` — PDF, JPEG or PNG, up to 20 MB. There is no
`patientId` field, deliberately: the patient comes off the result.

Returns `{ documentId, checksum, byteSize }`, plus `duplicate: true` when the
reference or the same bytes were already filed. 503 when storage is not
configured, and it says nothing was saved — because nothing was.

**Fetching** needs a session *and* a ticket, and the ticket is minted for one
document, one person and one purpose for sixty seconds. An `<img>` or an
`<object>` can carry a ticket in a URL; a session token must never be put in
one. The bytes are re-hashed on the way out and refused with 409 if they no
longer match what was stored.

**An administrator gets 403 on both the ticket and the bytes**, having been
allowed to upload. §1 explains why that is not a contradiction.

---

## 6. Every refusal code this slice adds

Codes are part of the contract: renaming one is a breaking change, adding one
is not. Every other refusal is a sentence to show and nothing more.

| Code | What to do about it |
|---|---|
| `NOT_AN_AUTHORIZED_DOCTOR` | only the owner-doctor or an explicitly authorized doctor approves clinical content |
| `NOT_THE_RESPONSIBLE_DOCTOR` | offer the delegation, or the doctor whose it is |
| `CATALOGUE_UNCHANGED` | nothing clinical changed; the operational half needs no version |
| `CATALOGUE_NOT_A_DRAFT` · `CATALOGUE_NOT_APPROVED` · `CATALOGUE_NOT_ORDERABLE` · `CATALOGUE_RETIRED` | refresh the catalogue; somebody moved it |
| `REFERRAL_HAS_NO_SPECIMEN` | clear the specimen field for a referral |
| `NOTHING_ORDERED` | at least one item |
| `RESPONSIBLE_IS_NOT_A_DOCTOR` · `DELEGATE_IS_NOT_A_DOCTOR` | pick a doctor |
| `INVESTIGATION_REFERENCE_REUSED` · `RESULT_REFERENCE_REUSED` | a client fault. Mint a fresh reference; **do not** show the earlier record |
| `ALREADY_CANCELLED` · `ALREADY_IN_PROGRESS` · `ALREADY_FLAGGED` · `ALREADY_REVIEWED` | refresh; somebody did it |
| `RESULT_ALREADY_RECEIVED` | cancel the outstanding lines instead |
| `RESULT_ALREADY_RECORDED` | this is a correction; ask which report and why |
| `FLAG_SOURCE_REQUIRED` · `FLAG_PROVENANCE_REQUIRED` | a flag says where it came from and where it is written |
| `CORRECTION_REASON_REQUIRED` · `CORRECTION_CROSSES_INVESTIGATION` · `ALREADY_SUPERSEDED` | correct the current report of the right investigation |
| `NOTHING_RECORDED` | type the report or attach it |
| `LINE_CANCELLED` · `ORDER_CANCELLED` | the request was withdrawn |
| `RESULT_SUPERSEDED` | the corrected report is the one to work on |
| `RESULT_NOT_REVIEWED` | review it first. Two acts, on purpose |
| `CRITICAL_RESULT_NEEDS_DIRECT_CONTACT` | telephone the patient and record the call |
| `CRITICAL_CONTACT_IS_CLINICIAN_LED` | a doctor makes this call |
| `NOTIFICATION_ALREADY_AUTHORIZED` · `NOTIFICATION_ALREADY_SCHEDULED` | refresh |
| `NOT_THIS_PATIENTS_CARE` | a nurse outside this patient's care. Record the vitals, or ask the doctor |

Suppression reasons a notice may carry, read from
`view.investigation_order` → `notification.suppressionReason`: Slice 3A's nine,
plus `result_superseded` and `result_not_authorized`.

---

## 7. Retrying

`order_investigation`, `record_result` and the document upload require an
`idempotencyKey` — a fresh uuid per **request**, not per session and not per
patient. `lib/api.ts`'s existing posture applies unchanged: a failed write is
an unknown outcome and never a known nothing.

Send the same key with the same request to retry. The server returns the
original outcome with `duplicate: true`, and — for an order — `cancelled` as
it stands **now**, so a reply that arrives an hour late is accurate about the
past without being silent about the present.

Send the same key with a materially different request and it is refused. That
is a client fault, and the only safe answer is to say so rather than hand back
somebody else's order number.

The other commands need no key: they write once, and a second press returns
what the first one did.

---

## 8. The role matrix, in one place

| | admin | doctor | authorized doctor | nurse | pharmacy |
|---|---|---|---|---|---|
| draft catalogue content | ✓ | ✓ | ✓ | — | — |
| approve / retire it | — | — | ✓ | — | — |
| maintain codes, facility, label | ✓ | ✓ | ✓ | — | — |
| order, cancel | — | ✓ ¹ | ✓ ¹ | — | — |
| mark sent | ✓ | ✓ | ✓ | ✓ ² | — |
| file a report, transcribe its flag | ✓ | ✓ | ✓ | ✓ ² | — |
| flag it clinically | — | ✓ ¹ | ✓ ¹ | — | — |
| acknowledge a critical result | — | ✓ ¹ | ✓ | — | — |
| delegate the review | — | ✓ ³ | ✓ | — | — |
| review | — | ✓ ¹ | ✓ ¹ | — | — |
| authorize the notice | — | ✓ ¹ | ✓ ¹ | — | — |
| record contacting the patient | ✓ ⁴ | ✓ | ✓ | ✓ ²⁴ | — |
| read the review queue | operational | own ¹ | own + escalated | — | — |
| read escalations | — | own ¹ | all | — | — |
| read a request | operational | ✓ | ✓ | ✓ ² | — |
| upload a document | ✓ | ✓ | ✓ | ✓ ² | — |
| open a document | — | ✓ | ✓ | ✓ ² | — |

¹ with standing on that order · ² while involved in that patient's care ·
³ if responsible or ordering · ⁴ not for a critical result

**Roles combine, and the union is what you get.** A staff member may hold more
than one, and the clinic's owner holds doctor and admin. On the review queue
that means the whole chase list *and* the clinical half — not the narrower of
the two, which is what the first version of the read gave him and is the
finding that produced this paragraph.

---

## 9. What this contract does not answer

- **What the screens look like.** Nothing here is a layout. `UI_UX_PLAN.md`
  governs that, and the interaction contract in it — action states, result
  overlays, durable evidence after the overlay closes — applies to every
  command above.
- **When the clinic closes.** Item 87's escalation ceiling is 20:00 because
  that is the only daily boundary this application can prove. See
  `SCHEMA_AND_TYPES.md` §17.7; a screen should not present it as opening hours.
- **Who the backup doctor is.** There isn't one, and `backupDoctorConfigured`
  says so.
- **Whether a result notice will actually be sent.** It will not, today: the
  clinic's WhatsApp connection is unconfigured and every authorized notice is
  suppressed into the admin's queue. `operations/ROLLOUT.md` §9 is what has to
  be true first.
- **Structured results.** There are none, and a screen must not present
  `reportText` as though it were parsed.
