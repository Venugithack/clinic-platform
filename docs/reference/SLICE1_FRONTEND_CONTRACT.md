# Slice 1 frontend contract

> Historical contract note: this records the Slice 1 handoff as it stood on
> 14 September 2026. The later Slice 2 contract supersedes its visit-change
> rotation rule, and the bounded frontend safety cutover was implemented locally
> on 17 September 2026. The historical rules below are retained as evidence.

What the backend now answers, for the later frontend programme. Nothing in this
document is on a screen yet, and nothing here authorizes putting it on one: the
backend programme
([`CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md`](CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md)
§3) defers every visual change, and §19 asks each slice to leave behind exactly
this — fields, permissions, states, errors, retry rules and example fixtures —
so the interface can be built against a contract rather than against a guess.

Status: **Slice 1 complete, 14 September 2026.** One new Edge Function
(`workspace`), one changed command (`sign_consultation`), two forward-only
migrations, no change to the clinic snapshot.

## Contents

1. [The one command that changed](#1-the-one-command-that-changed)
2. [The new endpoint](#2-the-new-endpoint)
3. [Patient search](#3-patient-search)
4. [Patient context](#4-patient-context)
5. [Workload counts and drill-downs](#5-workload-counts-and-drill-downs)
6. [Visit progress](#6-visit-progress)
7. [Safe-exit obligations](#7-safe-exit-obligations)
8. [Outcome lookup](#8-outcome-lookup)
9. [Eligible equivalents](#9-eligible-equivalents)
10. [The role matrix, in one place](#10-the-role-matrix-in-one-place)
11. [What this contract does not answer](#11-what-this-contract-does-not-answer)

---

> **Superseded in one place by Slice 2.** `sign_consultation` now splits the
> refusal this section calls `ATTEMPT_NAMES_ANOTHER_CONSULTATION`: a different
> PATIENT or DOCTOR keeps that code and still rotates, while a different VISIT
> becomes `ATTEMPT_NEEDS_RECONCILIATION`, which must **not** rotate — owner
> policy item 74, "Reception creating B is not, by itself, proof of a second
> consultation." Everywhere below that says a different visit rotates, read
> [`SLICE2_FRONTEND_CONTRACT.md`](SLICE2_FRONTEND_CONTRACT.md) §1 instead. The
> rest of this document stands.

## 1. The one command that changed

`sign_consultation` (and its alias `save_consultation`) now accepts two
optional fields. Both are **additive**: a caller that sends neither behaves
exactly as it did before this slice, which is what keeps the build already
deployed on the clinic's tablets working.

| Field | Type | Required | Meaning |
|---|---|:-:|---|
| `idempotencyKey` | string | no | The name this attempt at this consultation is signed under. |
| `openedVisitId` | string | no | The visit the attempt was **opened against**. Immutable for the life of the attempt. |

`appointmentId` was already part of this command and keeps its meaning: the
visit the tablet has **on screen now**.

**Two visit identities, and neither replaces the other.** They answer different
questions and each has been dropped once, with a reproduced fault each time:

- Send only `openedVisitId` and you lose the visit that appeared afterwards. A
  walk-in signed from the register, reply lost, doctor then creates today's
  visit (policy item 3 allows it) — the consultation succeeded and the visit
  sat in the queue as `waiting`, attached to nothing.
- Send only `appointmentId` and you lose what the attempt began against. An
  attempt opened on a visit, first request never committed, visit then
  cancelled: the poll removes it, the tablet has nothing live to send, and the
  server wrote a **direct** consultation — the cancellation bypassed, the
  encounter attached to nothing, ₹300 charged for an attendance somebody had
  said did not happen.

**What the server does with it.** The key is stored on the encounter with a
unique index, alongside a SHA-256 fingerprint of the material request. Three
outcomes:

| Call | Answer |
|---|---|
| A key never seen before | The consultation is signed. `data` is `{ encounterId, prescriptionId?, prescriptionNumber?, signedAt }` as before. |
| The same key, the same patient, doctor, visit and sheet | The **original** outcome, with `duplicate: true` added and the original `signedAt`. Message: *"This consultation was already signed as RX-000123. Nothing was recorded twice."* |
| The same key, a different patient or doctor, or a **different** visit from the one stored | Refused, `code: "ATTEMPT_NAMES_ANOTHER_CONSULTATION"`. Nothing is written. The key belongs to somebody else's consultation, so this request is provably not a retry of it — the client should mint a fresh reference and the next press will sign. Note this is *different* visits, both present; a visit named where the encounter has none is the row below. |
| The same key, the same visit, a **different sheet** | Refused, `code: "CONSULTATION_ALREADY_SIGNED"`, naming the prescription number. Nothing is written. This IS the consultation the key named and it committed; signing is immutable. The client must **not** rotate here — a fresh key would write a second encounter and a second fee for one visit. |
| The same key, a visit named where the encounter has **none** | Refused, `code: "CONSULTATION_SIGNED_WITHOUT_THIS_VISIT"`. Nothing is written. The consultation was signed before this visit existed. **Do not rotate.** The visit stays `waiting` and is carried as an `unlinked_consultation` obligation. |
| A key never seen before, whose `openedVisitId` names a visit since **cancelled or closed** | Refused, `code: "ATTEMPT_VISIT_NO_LONGER_ACTIVE"`. Nothing is written and nothing is charged. **Do not rotate** — a fresh key here writes exactly the unlinked consultation this refusal exists to prevent. The way forward is a clinic act: create today's visit, which mints a new attempt through the ordinary rule and signs against it. |

**Refusal codes.** A refusal that the client must *act* on carries a `code`
beside its `message` (`{ ok: false, message, code }`). Everything else carries
`message` alone, exactly as before, so nothing that reads only `message` is
affected. Codes are part of this contract: adding one is additive, renaming one
is breaking. Never branch on the text of a message.

### 1.1 What identifies one consultation attempt

Two questions, answered separately, because they need different words and
different responses.

**Who and which visit** — the patient, the doctor, and the two visit identities
the request carries. Compared against the encounter the key already names, as a
case analysis rather than an equality test, because most of the cases are not
"stale".

A different patient or doctor is `ATTEMPT_NAMES_ANOTHER_CONSULTATION` before
anything else is looked at. Then, **when the request names a live visit**
(`appointmentId`), that is what it is asserting the consultation is about:

| Stored on the encounter | `appointmentId` | Verdict |
|---|---|---|
| the same visit | that visit | Compatible. |
| **no** visit | a visit | `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT`. The consultation was signed before this visit existed. **Do not rotate** — see below. |
| a **different** visit | a visit | ~~`ATTEMPT_NAMES_ANOTHER_CONSULTATION`. Two real visits that are not the same visit. Rotate.~~ **Superseded by Slice 2:** `ATTEMPT_NEEDS_RECONCILIATION`, and do NOT rotate — owner item 74. |

`openedVisitId` is deliberately **not** consulted in this branch, even where it
would prove the request comes from the attempt that signed the stored
encounter. A tablet naming a live visit is asserting *this consultation is
about that visit*, and where the stored one is a different real visit, the
honest answer is that they are two visits and this is a second attendance —
which is what a rotation goes on to record. The client never reaches this row
in practice, because `beginAttempt` mints a new reference the moment a
different visit goes live. A second signing surface that reuses one reference
across a visit change would, and it would rotate into a second encounter and a
second fee; see *Two arrivals for one attendance* in the programme register's
**What Slice 1 did not close**.

**When it names no live visit**, the attempt's own `openedVisitId` answers
instead — because signing sets the appointment to `done` and the poll takes it
out of the snapshot, so having nothing live to send is the ordinary shape of a
retry rather than a claim that no visit exists:

| Stored on the encounter | `openedVisitId` | Verdict |
|---|---|---|
| any | absent | Compatible. A caller that sends neither field is the pre-slice shape, and silence from a client with nothing else to say is not a disagreement. |
| **no** visit | any | Compatible. |
| the same visit | that visit | Compatible. |
| a **different** visit | a visit | ~~`ATTEMPT_NAMES_ANOTHER_CONSULTATION`. Rotate.~~ **Superseded by Slice 2:** `ATTEMPT_NEEDS_RECONCILIATION`, and do NOT rotate. |

And before any of that, on a key never seen before: if the request names no
live visit but its `openedVisitId` points at a visit that has since been
**cancelled or closed**, or has vanished from the records, signing is refused
with `ATTEMPT_VISIT_NO_LONGER_ACTIVE`. Signing it would have to become a direct
consultation, which is the bypass. A visit still `waiting` or `in_consult` is
signed against normally — the tablet's snapshot was simply behind.

**What was written** — every clinical field, every prescription line's
medicine, dose, frequency, timing, route, duration, directions, instructions
and quantity, the fee decision (charge/override/waive and its reason), and —
when there are lines — the validity fields. Hashed into
`encounters.request_fingerprint`. A difference here means the consultation was
edited after it was signed.

Deliberately **not** part of either: the medicine name and strength snapshots
copied from the formulary at signing, the clinic's default fee, and whitespace
or key order in the payload.

**The visit is material, and it took four tries to say how.** The first
version left the appointment out of the identity entirely, so a retry sending
nothing would match — which made one patient's Monday and Thursday the same
consultation. The second made the client re-send the visit the attempt was
opened against, which fixed that and broke something quieter: for a walk-in
that value is `null` forever, so a doctor who signed from the register, lost
the reply, then created today's visit and pressed again got a consultation that
succeeded while the visit sat in the queue as `waiting`, attached to nothing.
The third sent the live visit alone, which fixed *that* and lost the other
half: an attempt whose visit was cancelled under it had nothing to send, and
the server accepted a direct consultation, bypassing the cancellation and
charging ₹300 against no visit at all.

The fourth sends **both**, and keeps them apart. The live visit decides what a
first signing attaches to and what a retry is asserting; the opened one says
which consultation this is when the live one has gone, and stops a cancelled
visit being stepped around. Collapsing them into one field is how they come to
disagree, and each single-field version above is one half of that collapse.

**`CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` is the one that needs care.** It
means the consultation committed when the tablet could not hear it, and a visit
row has appeared since. Three things are true at once: nothing was recorded
twice, the consultation exists and is named, and the visit on screen is still
waiting and attached to nothing. The client must **not** rotate — a fresh
reference signs the same consultation a second time — and must not treat it as
a failure to retry. Slice 1 deliberately did not decide what happens to the
leftover visit; it is carried as an `unlinked_consultation` obligation (§7) so
it survives the message being dismissed. Owner items 72–74 have since approved
an explicit, append-only doctor resolution, whose backend transition and
contract belong to Slice 2.

**The rule the client must follow**, in two halves that are easy to confuse.

*Which attempt.* One per consultation, named by the patient. Keep it across a
refusal, a lost reply and an outcome-unknown. Release it only when the clinic
confirms the signing, or when the operator explicitly starts a new consultation.
A new attempt is minted in exactly one situation: the attempt already holds a
visit id and a **different** one is live — both present, both real, not the
same. Nothing else mints. **Not** a visit appearing where the attempt held
none, and **not** the clinic day changing.

*Which visit to send.* **Both of them, in their own fields.** The visit the
tablet has on screen goes as `appointmentId`; the attempt's own stored
`visitId` — what it was opened against — goes as `openedVisitId`. Send the
field as absent when the value is absent; do not substitute one for the other,
and do not omit either because the other is present.

Those two halves are separate because they used to be one, and no single answer
served both. An attempt that remembered "no visit" kept sending "no visit"
after the doctor created one, so a consultation could succeed while the visit
it belonged to sat in the queue as `waiting`, attached to nothing. Then sending
only the live value lost the other half: an attempt whose visit was **cancelled
under it** had nothing live to send, so the request looked like a direct
consultation and the clinic wrote one — the cancellation bypassed, ₹300 charged
against no visit at all. Sending both is safe because the server reads them as
a case analysis rather than an equality test — see §1.1.

`lib/attempt-key.ts` stores it and `lib/consultation-attempt.ts` is the
lifecycle — `openConsultationAttempt`, `settleConsultationAttempt`,
`abandonConsultationAttempt`. Both are wired into
`components/consultation-workspace.tsx`. A new surface that signs a
consultation should call the lifecycle rather than mint its own key.

**Attempt lifetime and recovery.**

| Situation | What the attempt does |
|---|---|
| Refused by the clinic | Held. The sheet is corrected and re-sent under the same reference. |
| Reply lost / outcome unknown | Held. This is the case it exists for. |
| Panel unmounted, station changed, tablet reloaded | Held — it is in `sessionStorage`, not component state. |
| Signing confirmed | Released. |
| Operator presses **Next patient** | Released. |
| A draft is discarded | **Held.** A discard says nothing about whether a signing committed. |
| The clinic day rolls over | **The same attempt.** Elapsed time says nothing about what committed. This used to mint, and a reply lost at 23:59 and retried at 00:01 therefore wrote a second encounter and a second fee. The earlier outcome is reconciled instead: the same sheet replays, a different one is refused. |
| A **different** visit id, where the attempt already had one | A new attempt. A patient arrived again under a new token, while the previous attempt was unresolved, is an explicit second arrival. |
| A visit id appears where the attempt had **none** | The **same** attempt, and the new visit is what gets sent. A walk-in opened from the register has no visit row, and a doctor creating one mid-attempt (policy item 3 allows it) is tidying the record, not starting a second consultation. Minting here wrote a second encounter and a second fee; sending the old `null` left the visit waiting and unlinked. |
| `ATTEMPT_NAMES_ANOTHER_CONSULTATION` | The reference was stale; mint a fresh one and sign again. |
| `ATTEMPT_VISIT_NO_LONGER_ACTIVE` | **Held.** Nothing was recorded and nothing was charged. Somebody cancelled or closed the visit this consultation was opened against; creating today's visit mints a new attempt through the rule above and that one signs. |
| `CONSULTATION_ALREADY_SIGNED` | Do not rotate. The visit is signed and the record stands; open the patient's record. |
| `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` | Do not rotate. The consultation is signed and is attached to no visit; the visit on screen is still waiting and somebody has to close it. |

The one case with no automatic exit is two direct consultations for the same
patient, on the same clinic day, in the same tab, where the first ended
outcome-unknown and was never confirmed. The clinic has no appointment to tell
them apart, so the second is treated as possibly the same until something
resolves it. That is the safe direction to fail in: the alternative writes a
second fee for one visit.

#### How each of the two non-rotating refusals actually ends

They do not end the same way, and an earlier version of this document said they
did. The difference is the **order of the two checks inside the replay**: the
binding — patient, doctor, visit — is judged first, and only a request that
survives it has its sheet compared at all. So restoring the sheet is the exit
from a refusal about the *sheet*, and no exit whatever from a refusal about the
*visit*.

**`CONSULTATION_ALREADY_SIGNED` — send the sheet as it was signed.** The
refusal names the prescription number where there is one (a consultation with
no medicines has none, which is the common shape of this state), so the doctor
can see what the clinic recorded. Restoring the sheet to that and pressing
Finish returns the replay — a success, `duplicate: true` — which releases the
attempt, and the next consultation opens under a fresh reference. It is safe
precisely because an unedited sheet replays rather than writing anything.

**`CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` — the sheet is irrelevant.** The
consultation is attached to no visit and the tablet is holding one, so
`compareBinding` refuses on that and the fingerprint is never looked at. A
byte-perfect sheet is refused exactly as an edited one is, with the same code.
**Retyping cannot end this state**, and this document previously implied it
could.

What ends it is a clinic act on the **visit**, because the visit is what the
disagreement is about: closing or cancelling the queue row removes the live
visit from the snapshot, the attempt's own identity then answers instead, the
fingerprint is finally compared, and the original consultation replays and
releases the attempt. That is also exactly what the `unlinked_consultation`
obligation asks somebody to do, so the obligation and the exit are the same
action — which is the property that makes the state survivable at all. Pinned
by `(e3)` in `tests/characterization/consultation-visit-identity.test.mjs`.

**Nothing else works from that screen, and that is a known gap.** Creating
today's visit does *not* mint — the table above is the authority, and the mint
rule needs the attempt to already hold a *different* visit id; pressing Finish
after creating one returns `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` and leaves
an orphaned `waiting` row as well. The next clinic day does not mint either.
**Next patient** releases an attempt but is rendered only after a confirmed
signing, which in this state is exactly what has not happened. Closing the tab
clears `sessionStorage` and is not a workflow.

So one refusal is escaped by restoring a sheet and the other by closing a
queue row, and neither is a control the doctor has in front of them at the
moment they read it. Owner items 72–74 now choose the safe closure: never
release automatically, establish the prior outcome, and require an explicit
doctor resolution. Slice 2 owns that backend transition and contract; the later
frontend programme owns the control. It remains a gap in the Slice 1 client.

**The day boundary no longer mints.** It used to, and that was a known road
back to W1: a reply lost at 23:59 and retried at 00:01 got a fresh reference
and wrote a second encounter and a second ₹300 fee. An unresolved attempt is
retained across midnight and reconciled against what the clinic recorded — the
same sheet replays, a different one is refused — and starting a genuinely new
consultation is an explicit act rather than a date change. The cost is the
other way round now: a patient with no visit row, consulted again the next day
under a sheet that differs, meets `CONSULTATION_ALREADY_SIGNED` until the
operator makes that transition. A refusal that says why is the right side of
that trade.

**Next patient** also releases an attempt, but it is reachable only after a
confirmed signing on that tablet — which, in this state, is exactly what has
not happened. It is not a recovery from this refusal and must not be described
as one.

**Compatibility.** A caller that sends no key still works and still gets the
pre-W1 behaviour, which is to say no protection. That window is deliberate and
is pinned by a test — see [§11](#11-what-this-contract-does-not-answer).

## 2. The new endpoint

```text
GET {FUNCTIONS_URL}/workspace?view=<name>&…
Authorization: Bearer <session token>
```

Reads only; `POST` is refused with 405. Every response is
`{ ok: true, … }` or `{ ok: false, message }`.

| Status | Means |
|---|---|
| 200 | The answer. An empty answer is still 200. |
| 400 | Unknown view, unknown list, or a required parameter missing. |
| 401 | Not signed in. |
| 403 | Signed in, and this role does not hold this view. |
| 404 | The patient or prescription line asked for does not exist. |
| 405 | Not a GET. |
| 500 | Something went wrong; the detail is logged server-side and not returned. |

Note the status split against `/command`, which returns **400** for a role
refusal because it catches a thrown error. This endpoint returns **403**, like
`reports` does.

Every view is on demand. **Nothing here is in the clinic snapshot and nothing
here may be added to it** — the snapshot already carries five unbounded
collections and the programme's contract sequence forbids a sixth.

## 3. Patient search

```text
GET /workspace?view=patients&q=<query>
```

`q` shorter than two characters returns `[]` rather than the register.

```jsonc
{
  "ok": true,
  "patients": [
    {
      "patientId": "…",
      "name": "Murugan Selvaraj",
      "phoneEnding": "3210",        // last four digits, every role
      "matchedOn": "phone",         // phone | token | id | name
      "age": 41,                    // admin, doctor, nurse only
      "sex": "male",                // admin, doctor, nurse only
      "token": "JMC-0007",          // only when a visit is open today
      "arrivalStatus": "waiting"    // waiting | in_consult
    }
  ]
}
```

- Matches: phone (last ten digits, any formatting), today's token, patient id,
  and name (whitespace-collapsed, lowercased).
- Ranked: exact phone, then token, then id, then name-prefix, then name-contains.
- **Two passes.** The indexed questions run first — phone, token, id, name
  prefix. Only if those return nothing does a second statement run the
  middle-of-a-name match, which no btree can serve. So a surname typed on its
  own still works and costs a scan; everything else is an index lookup. Both
  passes are asserted by plan against a generated register of 20,000 patients
  — see [§11](#11-what-this-contract-does-not-answer).
- **One row per patient.** The passes are a UNION of branches and a patient can
  match more than one of them, so the result is de-duplicated on the server and
  each person appears once, under their best-ranked match. `matchedOn` names
  that match. A caller never has to de-duplicate this list.
- **The query is a name, never a pattern.** `%`, `_` and `\` are escaped and
  every LIKE names its escape character, so they match literally. Typing `%`
  finds nobody rather than everybody, and a patient actually called `R_D Kumar`
  is found by typing `R_D`.
- Capped at **25**. There is no cursor; narrow the query.
- `phoneEnding` is four digits for every role including admin. The full number
  is in the snapshot where it is actually used; a search result is a
  disambiguation aid, not a copy of the register.

**States**: `ready` (results), `empty` (no match — say "No patient found", not
"error"), `failed`. No working state is needed beyond a typing debounce; this
is a fast indexed read.

## 4. Patient context

```text
GET /workspace?view=patient&patientId=<id>
```

```jsonc
{
  "ok": true,
  "context": {
    "patientId": "…",
    "sections": ["identity", "demographics", "arrival", "vitals", "clinical_alerts"],
    "identity":     { "name": "Murugan Selvaraj", "phoneEnding": "3210" },
    "demographics": { "age": 41, "sex": "male" },
    "arrival":      { "token": "JMC-0007", "status": "waiting", "scheduledAt": "2026-09-14T04:12:00Z" },
    "vitals":       { "recordedAt": "…", "pulse": 78, "notMeasuredNote": "Cuff was in use" },
    "clinicalAlerts": { "allergyStatus": "not_recorded", "allergyNotes": "", "clinicalFlags": "" },
    "supply":       { "prescriptionsWaiting": 1, "linesWaiting": 2 },
    "money":        { "outstanding": "300.00", "openInvoices": 1, "underReview": 0 }
  }
}
```

**`sections` is the important field.** It lists which sections this role was
given, so the interface can distinguish *"no allergy is recorded"* from *"your
role is not shown allergies"* — two very different sentences to put above a
prescription. A section absent from `sections` will also be absent from the
body; do not treat its absence as a negative fact.

| Section | admin | doctor | nurse | pharmacy |
|---|:-:|:-:|:-:|:-:|
| `identity` | ● | ● | ● | ● |
| `demographics` | ● | ● | ● | |
| `arrival` | ● | ● | ● | |
| `vitals` | ● | ● | ● | |
| `clinical_alerts` | | ● | | |
| `supply` | ● | | | ● |
| `money` | ● | | | ● |

Absences that are facts rather than gaps:

- `arrival: null` — no visit open. Not an error.
- `vitals: null` — nothing ever recorded. A reading that exists but is partial
  omits the *measurements* nobody took: `bp` absent is "not measured", and a
  value of 0 would be a reading. Never render an absent measurement as a zero.
- `allergyStatus: "not_recorded"` — nobody has asked. This is **not**
  `no_known`, and flattening the two is a clinical error.
- `outstanding` is a **string** (`"300.00"`). It is `numeric(12,2)` in the
  database and parsing it into a JavaScript number is how a rupee goes missing.

## 5. Workload counts and drill-downs

```text
GET /workspace?view=workload
GET /workspace?view=list&list=<id>
```

```jsonc
// view=workload
{ "ok": true, "counts": [ { "id": "list.today_queue", "label": "Waiting", "owner": "doctor", "count": 6 } ] }

// view=list&list=list.today_queue
{ "ok": true, "list": {
  "id": "list.today_queue", "label": "Waiting", "owner": "doctor",
  "count": 6,             // the exact size of the actionable set
  "rows": [ /* … */ ],    // at most 200 of them
  "truncated": false
} }
```

**The guarantee**: the count and the list are one SELECT, so they cannot
disagree. `count` is always the true size; `rows` is capped at 200 and
`truncated` says whether the cap bit. All the counts in one `view=workload`
response are read in **one statement**, so a badge row is a description of the
clinic at an instant rather than of a few seconds of it.

`view=workload` returns only the lists this role holds — an empty array is a
valid answer. Every count it returns can be opened by the same role; never show
a badge whose drill-down would be refused.

| List | Label | Owner | admin | doctor | nurse | pharmacy |
|---|---|---|:-:|:-:|:-:|:-:|
| `list.today_queue` | Waiting | doctor | ● | ● | ● | |
| `list.vitals_missing` | No reading today | nurse | ● | ● | ● | |
| `list.observation_due` | Observation due | nurse | ● | ● | ● | |
| `list.observation_handoff` | Doctor asked for | doctor | ● | ● | ● | |
| `list.prescriptions_needs_review` | Needs a doctor | doctor | ● | ● | | |
| `list.follow_ups_due` | Follow-up due | doctor | ● | ● | ● | |
| `list.counter_waiting` | At the counter | pharmacy | ● | | | ● |
| `list.payments_due` | Money due | pharmacy | ● | | | ● |
| `list.financial_review` | Financial review | admin | ● | | | |
| `list.expiring_soon` | Expiring | pharmacy | ● | ● | | ● |
| `list.stock_count_open` | Count open | pharmacy | ● | | | ● |

Two exclusions the interface must not undo, because they are policy:

- A prescription past its validity is **not** on `list.counter_waiting`. The
  pharmacist cannot supply the remainder (policy register 18); it appears as a
  `blocked` obligation owned by the doctor instead.
- A bill that is over-refunded, or cancelled and not at zero, is **not** on
  `list.payments_due`. Policy register 55 is explicit that filing it with
  ordinary unpaid bills is how it comes to be ignored. It has
  `list.financial_review`, and only an admin sees it.

`list.expiring_soon` uses a 180-day horizon, which is what the
`expiry_and_holds` report has always meant by expiring. Rows carry `days_left`
and `inside_return_window` so the urgent ones can be shown as urgent.

## 6. Visit progress

```text
GET /workspace?view=progress&patientId=<id>
```

Six stages, always all six, always in order:

```jsonc
{ "ok": true, "stages": [
  { "stage": "arrival",  "state": "in_progress", "owner": "nurse",    "detail": "JMC-0007 · waiting", "ageMinutes": 12 },
  { "stage": "vitals",   "state": "done",        "owner": "nurse",    "detail": "Recorded today" },
  { "stage": "consult",  "state": "not_started", "owner": "doctor",   "detail": "No consultation today." },
  { "stage": "counter",  "state": "withheld",    "owner": "pharmacy", "detail": "Not shown to your role." },
  { "stage": "payment",  "state": "withheld",    "owner": "pharmacy", "detail": "Not shown to your role." },
  { "stage": "follow_up","state": "not_applicable","owner": "doctor", "detail": "None arranged." }
] }
```

| `state` | Render as |
|---|---|
| `not_started` | Neutral. Has a `nextAction` where one is safe. |
| `in_progress` | Amber — somebody owns this now. |
| `done` | Green. |
| `blocked` | Amber or red with the `nextAction`; a named role must decide before it can move. |
| `not_applicable` | Muted. Nothing prescribed, no follow-up arranged. |
| `withheld` | Muted, naming `owner`. **Not** an error and **not** an empty stage. |

`withheld` exists so a doctor can see that the next move belongs to the counter
without being shown the bill. It leaks nothing — every visit has a counter
stage. Do not hide a withheld stage; hiding it is what makes a workflow look
finished when it is not. A nurse gets `withheld` for `consult` too: `encounters`
and `consultation_drafts` are doctor-only today, and this slice reproduced that
boundary rather than widening it.

`ageMinutes` is whole minutes and is absent where the underlying time is not
knowable.

**Three of these stages are the day and three are the patient.** `arrival`,
`vitals` and `consult` are filtered to the clinic day and describe today.
`counter`, `payment` and `follow_up` are **not** — a prescription signed last
week with medicine still on it, and a balance carried from August, are both
genuinely outstanding and both genuinely somebody's next move, and scoping them
to today would hide them on the one screen whose job is to say what is
unfinished. Their `detail` strings say "on this patient's account" for exactly
this reason. **Do not render them as today's visit state.** If a screen needs
"what happened in this visit", it needs a different question, and the schema
cannot answer it for vitals at all (see §11).

## 7. Safe-exit obligations

```text
GET /workspace?view=obligations&patientId=<id>
```

```jsonc
{ "ok": true, "obligations": [
  { "kind": "counter", "severity": "blocked", "owner": "doctor",
    "detail": "2 lines left over after the prescription's validity ran out. The remainder needs a new or amended order from the doctor." },
  { "kind": "unsigned_draft", "severity": "pending", "owner": "doctor",
    "detail": "A consultation draft is saved and not signed. Pharmacy cannot see it and nothing is charged." },
  { "kind": "unlinked_consultation", "severity": "blocked", "owner": "doctor",
    "detail": "A consultation was signed today and is attached to no visit, while JMC-0007 is still waiting in the queue. Nothing was recorded twice. Close the visit, or decide what it was for — the clinic will not attach a signed consultation to it by itself." }
] }
```

**The kinds.** `counter`, `payment`, `consult`, `vitals` and `follow_up` are the
visit stages read the other way round (§6). Two are their own:

| Kind | Who sees it | What it means |
|---|---|---|
| `unsigned_draft` | doctor | A draft is saved and unsigned. Pharmacy cannot see it and nothing is charged. |
| `unlinked_consultation` | doctor | A consultation was signed today against no visit while a visit for that patient **scheduled for today** is still waiting — the day the visit is *for*, not the day somebody typed it in, so tomorrow's appointment booked this morning does not raise it and today's appointment booked last week does. The residue of a reply lost on a direct consultation. **Nothing was recorded twice** — say so, because the reflex on reading it is to assume something was. Owner item 72 requires a doctor to resolve Same attendance or New attendance through the append-only transition Slice 2 will provide; until then a person closes the queue row through the existing workflow. |

Both are gated on `consultation_progress` (doctor only), because both disclose
that a consultation exists. A nurse or an administrator asking for the same
patient's obligations will not see either, and their absence is not evidence
that there is nothing there.

Use it when somebody closes a patient — the moment an unfinished thing is
cheapest to notice. An empty array means nothing is outstanding **for this
role**; the `withheld` stages in `view=progress` are where other roles' work
shows up.

`severity: "pending"` is work somebody can pick up now. `severity: "blocked"`
needs a decision from the named `owner` first. Keep them visually apart: a list
that mixes them teaches people the list contains things nobody can act on.

Merely waiting in the waiting room is deliberately not an obligation.

## 8. Outcome lookup

```text
GET /workspace?view=outcome&key=<idempotency key>
```

```jsonc
{ "ok": true, "outcome": {
  "key": "…", "operation": "consultation", "committed": true,
  "reference": "RX-000123", "at": "2026-09-14T05:40:11Z",
  "detail": "Consultation signed as RX-000123."
} }
```

`operation` is one of `consultation`, `dispense`, `otc_sale`, `payment`,
`goods_receipt`, `unknown`.

**`committed: true` with `operation: "unknown"`** is the answer for a key that
an appointment command spent (added 24 September 2026). This lookup does not
describe appointment commands — no `reference`, no `at`, no detail beyond
pointing at `view=appointment_outcome`, which answers the reference's own
sender (`SLICE2_FRONTEND_CONTRACT.md` §4.0a). Do not treat it as one of the
five operations above, and never read it as licence to retry.

**This is the answer to outcome-unknown.** `lib/api.ts` cannot tell a request
that never left the tablet from one that committed and lost its reply; both
arrive as the same `TypeError`. The tablet already holds the key it sent, so it
can now ask what that key did, instead of a person going to look at the record
by eye.

`committed: false` means no record carries this key. For the five commands that
take one this is conclusive, because the key is written in the same transaction
as the work. It licenses retrying **the same request under the same key** — and
nothing else.

**Read `detail`, not just `committed`.** A `committed: false` given to a role
that *could* have created this kind of key says *"…The same request may be sent
again under the same reference."* A `committed: false` given to a role that was
never allowed to look says *"Your role cannot resolve a reference of this kind.
This is not a statement that nothing happened."* The second must never be shown
as "nothing happened" and must never offer a retry.

A key is only resolved for a role that could have created it: a consultation
key answers a doctor and reads as `unknown` to a nurse. It is **not** scoped to
the individual staff member — any doctor can resolve any doctor's consultation
key, and any admin or pharmacist any counter key. Keys are random UUIDs, wildcards
are escaped before they reach the LIKE that matches split payments, and every
field returned is already within that role's existing access.

Split payments: `take_payment` stores one row per part keyed `<key>:1`,
`<key>:2`, so the key the tablet holds matches none of them exactly. The lookup
handles both shapes; pass the key you sent.

## 9. Eligible equivalents

```text
GET /workspace?view=equivalents&lineId=<prescription line id>
```

```jsonc
{ "ok": true, "equivalents": {
  "eligible": true,
  "prescribed": { "medicineId": "…", "name": "Paracetamol 500", "clinicalDrugId": "…", "clinicalDrugName": "Paracetamol 500 mg tablet" },
  "candidates": [ { "medicineId": "…", "name": "…", "brandName": "…", "strength": "500 mg", "dosageForm": "tablet", "availableBaseQuantity": 50 } ],
  "constraints": [ "Every candidate points at the same clinical drug as the signed order.", "…" ]
} }
```

or

```jsonc
{ "ok": true, "equivalents": { "eligible": false,
  "prescribed": { "medicineId": "…", "name": "Amoxil 500" },
  "reason": "Amoxil 500 was prescribed by brand (Amoxil). A brand-specific order is supplied exactly as written." } }
```

The counter already offers substitutes, by filtering the polled snapshot in
`components/counter-math.ts` — a copy of the server's rule, computed against
data up to fifteen seconds old. This is the authoritative version, reading the
same rows `dispense_rx` reads at the moment it is asked.

**It never chooses.** Policy register 21 permits a pharmacist to select an
in-stock brand against a genuinely generic order when the clinical drug matches
exactly, and permits nothing else. Render `candidates` as a list and
`constraints` as the rules; do not sort in a way that reads as a
recommendation, do not preselect, and do not describe any candidate as
equivalent in any sense beyond "the same clinical drug". The reason is still
required at `dispense_rx`, and the refusals are still the command's.

`eligible: false` carries a `reason` written in clinic words — show it as
written. The frontend must not re-derive eligibility.

## 10. The role matrix, in one place

Every row below is declared in `supabase/functions/_shared/capabilities.ts` and
tested by `tests/characterization/workspace-authorization.test.mjs`, which walks
that table rather than repeating it. A screen may mirror these to decide what to
offer; the refusal is always at the endpoint.

| View | admin | doctor | nurse | pharmacy |
|---|:-:|:-:|:-:|:-:|
| `view.patient_search` | ● | ● | ● | ● |
| `view.patient_context` | ● | ● | ● | ● |
| `view.workload` | ● | ● | ● | ● |
| `view.visit_progress` | ● | ● | ● | ● |
| `view.safe_exit` | ● | ● | ● | ● |
| `view.outcome` | ● | ● | ● | ● |
| `view.eligible_equivalents` | ● | | | ● |

Admission to a view is not admission to all of it — see the section table in
[§4](#4-patient-context) and the list table in [§5](#5-workload-counts-and-drill-downs).

## 11. What this contract does not answer

Stated here rather than discovered later.

**A pre-W1 build can still sign twice.** The server accepts a call with no
idempotency key, because the build deployed today sends none and refusing it
would lock the clinic out of signing. Until every tablet is running a build
that sends the key, a cached old build retains the original exposure: two
encounters, two invoices, two consultation fees. This is asserted by
`consultation-idempotency.test.mjs` ("a caller that sends no key is still
unprotected"), so that when the compatibility window closes, that test is what
fails and says so. Closing it means requiring the key — a separate, deliberate
change after the frontend cutover.

**Vitals cannot be tied to a visit.** `jmc.vitals` carries a patient and a time
and no appointment or encounter reference. So the vitals stage reports *"was
anything recorded for this patient today"*, which is the most the schema can
say and is not the same question for a patient who attends twice in one day.
Inventing the link would mean writing a column that guesses. The honest fix is
a foreign key on `vitals`, and it belongs to a slice that may change that table.

**A nurse is not shown allergy alerts, and is separately not shown
consultation status.** Only the doctor reads the clinical record today (the
`record` endpoint is doctor-only), and this slice reproduced that boundary
rather than widening it. Whether a nurse taking vitals should see recorded
allergies is an owner decision and is recorded as one.

These are two capabilities and not one. `clinical_alerts` gates the allergy
record; `consultation_progress` gates whether a consultation is drafted or
signed for this patient today, which is the state of the doctor's own work.
They hold the same roles right now, which is exactly the condition under which
one gets quietly used for the other — and the first version of the read models
did use the allergy gate for both. Granting a nurse allergy access would then
also have handed every nurse the doctor's unsigned drafts. The separation is
asserted, including by performing that widening on a copy of the table and
proving the draft gate does not move with it.

**A surname typed on its own is still a scan.** The phone, token, id and
name-prefix passes are index lookups; the middle-of-a-name fallback is a
sequential scan, bounded by the table and capped at 25 rows, and it runs only
when the indexed pass found nothing. A trigram index would fix it and `pg_trgm`
is not installed on this database; installing an extension is a deployment
decision rather than a read model's.

**There is no cursor.** Search caps at 25 and a work list at 200, which is the
convention every other on-demand read here follows. A list of things somebody is
about to do is not a report; if 200 is ever the wrong answer, the question is
wrong.

**Performance is asserted, reproducibly, and as plans rather than
milliseconds.** `tests/characterization/workspace-performance.test.mjs` builds
a register of 20,000 patients from a deterministic generator, runs `EXPLAIN
ANALYZE` over the *same* statements the endpoint runs — they come from
`searchStatements` and `PATIENT_READS` in `workspace.ts`, so a test cannot pass
against a copy of a query nobody uses any more — and removes everything it
built afterwards. The per-patient statements were paraphrased here until the
correction pass, and the paraphrases had already drifted: the real vitals
lookup behind the visit stage carries a clinic-day predicate the copy did not.
The generator seeds arrivals, readings, encounters and drafts as well as the
register, because a plan over an empty table proves nothing and every
"does not scan" assertion is true of a table with no rows in it. What it holds
is structural, because that is what does not drift with the machine: each
indexed branch reaches the register through an index and none of them reads all
of it; the middle-of-a-name fallback is the sequential scan it is documented to
be; the per-patient lookups behind the band and the visit stages do not scan;
and no answer grows with the clinic — search caps at 25, a work list at 200 and
reports its true count, and the workload summary names none of the twenty
thousand. The single timing assertion is a ratio between two plans measured in
the same run, which is a comparison rather than a threshold.

This replaces the earlier evidence, which was a table bulked to 20,001 rows by
hand and a set of millisecond figures nobody else could reproduce and nothing
re-ran.

**The client's lifecycle is tested, not only reviewed.**
`tests/attempt-key.test.ts` exercises `lib/consultation-attempt.ts` — reuse
after a refusal, reuse after an outcome-unknown, unmount and remount, reload
recovery through `sessionStorage`, the retry after the visit has left the
snapshot, release only on a confirmed signing, and a later visit getting its
own attempt. `tests/browser/consultation-attempt.test.mjs` drives the real
Consult screen against a real database and inspects what the tab is holding at
each step, including a dropped connection mid-signing and a full reload. The
gap this replaces — a storage helper tested in isolation while the wiring above
it was reviewed only — is what let two of the three review defects through.
