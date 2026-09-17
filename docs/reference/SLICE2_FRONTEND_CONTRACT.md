# Slice 2 frontend contract: the appointment book, and the way out of an unresolved attempt

> **Slice 2 was accepted on 17 September 2026** after six bounded acceptance
> corrections. Their evidence is retained in
> [`BACKEND_PROGRAMME_REGISTER.md`](BACKEND_PROGRAMME_REGISTER.md) §12.1–§12.7.
> The bounded consultation-attempt frontend safety cutover was implemented
> locally on 17 September 2026. It has not been deployed. The appointment-book
> and full calendar screens described here remain unbuilt.

This remains the settled backend contract. Its reconciliation read and command
are now used by the existing doctor consultation screen; the appointment and
calendar material remains the contract for later frontend work.

Companion to [`SLICE1_FRONTEND_CONTRACT.md`](SLICE1_FRONTEND_CONTRACT.md),
which this extends rather than replaces. Where the two disagree about
`sign_consultation`, this one is later and is authoritative; §1 says exactly
what changed and why.

Owner policy items 65–74, `docs/OWNER_POLICY_REGISTER.md` §L.

## Contents

1. [What changed in `sign_consultation`](#1-what-changed-in-sign_consultation)
2. [Resolving an attempt: the command](#2-resolving-an-attempt-the-command)
3. [Resolving an attempt: the read behind the control](#3-resolving-an-attempt-the-read-behind-the-control)
4. [The appointment book: commands](#4-the-appointment-book-commands)
5. [The calendar and a patient's history](#5-the-calendar-and-a-patients-history)
6. [Two new work lists](#6-two-new-work-lists)
7. [The queue: one field, and one ordering](#7-the-queue-one-field-and-one-ordering)
8. [The role matrix, in one place](#8-the-role-matrix-in-one-place)
9. [Every refusal code this slice adds](#9-every-refusal-code-this-slice-adds)
10. [What this contract does not answer](#10-what-this-contract-does-not-answer)

---

## 1. What changed in `sign_consultation`

One refusal split into two. Nothing else about the command changed: the same
fields, the same replay, the same `openedVisitId`/`appointmentId` pair, the
same compatibility with a caller that sends no key at all.

| Situation | Slice 1 | Slice 2 |
|---|---|---|
| The key names a different **patient or doctor** | `ATTEMPT_NAMES_ANOTHER_CONSULTATION` | unchanged |
| The key names a different **visit**, both real | `ATTEMPT_NAMES_ANOTHER_CONSULTATION` | **`ATTEMPT_NEEDS_RECONCILIATION`** |

**Why.** The Slice 1 client rotated on `ATTEMPT_NAMES_ANOTHER_CONSULTATION` —
the server's own message promised it would. That is right when the key belongs to
somebody else's consultation, because then it provably is not a retry of this
one. It is wrong for a different visit, because two real visits for one patient
on one day is exactly what this looks like:

> A signing on queued visit A commits. The reply is lost. Signing set A to
> `done`, so the fifteen-second poll drops it, and reception — seeing the
> patient still standing at the desk — arrives them again as visit B. The
> doctor presses Finish on the unchanged sheet.

Owner item 74: *"Reception creating B is not, by itself, proof of a second
consultation."* Rotating there writes a second encounter and a second ₹300 fee
for one attendance. So it fails closed, and a doctor resolves it.

**It is also raised before a FIRST signing**, and that half was missing. An
attempt that has committed nothing, sending `openedVisitId = A` with
`appointmentId = B`, used to sign B on the spot — an encounter, a ₹300 fee, and
A left standing in the queue, stepped around without anybody deciding anything.
Owner item 74 again: *"If A did not commit, the doctor explicitly chooses which
active attendance continues; the abandoned path is preserved in audit."* The
server has both identities and must not ignore one because the other is
present.

So the rule is the same whichever side of the signing it lands on: **two real
visits and one attempt is a question for a person.** Cancelling one of them
afterwards does not answer it either.

**`ATTEMPT_NEEDS_RECONCILIATION` must not be rotated on.** Hold the attempt,
show the refusal, and offer the resolution control (§3). The exact message:

> This reference already signed a consultation as RX-000123, against a
> different visit for this patient. Nothing was recorded twice and nothing was
> charged. If that was this same attendance, close it as the same attendance;
> if the patient has genuinely come back, record a new attendance — and the
> clinic will not decide which it was on its own.

There is also a **new** refusal on a key a doctor has already settled:

| `ATTEMPT_SETTLED_BY_RECONCILIATION` | A doctor recorded **New attendance** or an abandoned attempt for this reference, and nothing was written under it. **Rotate.** This is the one audited release owner item 73 permits — "Only that audited resolution, or an already-confirmed successful replay, may release the attempt" — and `lib/consultation-attempt.ts` already does it. |
| `ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE` | A doctor recorded **this** visit — or, where none is named, the consultation itself — as the same attendance. **Do not rotate.** Open the patient's record. A visit the determination did NOT name gets `ATTEMPT_SETTLED_BY_RECONCILIATION` instead, which does rotate. |

### 1.1 The bounded frontend safety cutover

At backend acceptance, one client path still minted a fresh reference when a
different live visit appeared; another held the reference but had no recovery
control. The historical evidence remains in `BACKEND_PROGRAMME_REGISTER.md`.

The 17 September 2026 cutover landed the two required changes together:

1. `beginAttempt` never mints merely because the live visit changed. The attempt
   retains its original `openedVisitId` while the screen sends the current
   `appointmentId` separately.
2. The doctor screen reads §3 and calls §2. It permits a retry only when the read
   proves nothing committed and the visit identities are compatible; otherwise
   it offers only the backend-approved Same attendance, New attendance, or
   abandoned-attempt choices.

Signing and reconciliation remain fail-closed in flight and when the earlier
outcome is unknown. Dismissal, elapsed time, reload, unmount, or a lost response
does not release the attempt. A confirmed response may release it when the
contract says so; after a lost reconciliation response, a durable resolved read
may prove the audited outcome and release it. Nurses, pharmacy users, and
administrators without the doctor role cannot see or invoke these controls.

This was a safety integration into the existing consultation UI. It did not
build the full appointment calendar and did not start Slice 3 messaging.

## 2. Resolving an attempt: the command

```text
resolve_consultation_attempt
```

Owner items 72, 73 and 74. **Doctor only** — an administrator who is not also a
doctor is refused, as are reception, nurse and pharmacy.

### Request

| Field | Type | Required | Meaning |
|---|---|:-:|---|
| `patientId` | string | yes | The patient the attempt belongs to. |
| `idempotencyKey` | string | yes | The attempt being resolved — the reference the tablet is holding. |
| `resolution` | `same_attendance` \| `new_attendance` \| `abandoned_attempt` | yes | What the doctor determined. |
| `reason` | string | yes | Why. Non-empty; it is on the record with the doctor's name against it. |
| `subjectVisitId` | string | no, **except** on `same_attendance` when the patient has an open queue row | The queue row being decided about — the leftover visit, or the second arrival. Absent where there is no queue row, which is the ordinary shape for a patient opened from the register. |
| `openedVisitId` | string | no (**required** for `abandoned_attempt`) | The visit the attempt was opened against, exactly as `sign_consultation` takes it. |

**Every visit named must be this patient's**, on all three determinations, and
so must the encounter the reference signed. The command refuses a cross-patient
reference with `VISIT_NOT_THIS_PATIENTS` before anything is written, and
`20260921000000` adds composite foreign keys on `(visit, patient)` so the
schema refuses it too. Slice 2 checked the encounter and neither visit.

### What each resolution does

| | `same_attendance` | `new_attendance` | `abandoned_attempt` |
|---|---|---|---|
| Requires the prior outcome to be | `committed` | either | `not_committed` |
| Also requires | — | — | the opened visit to be cancelled, closed, or gone |
| The signed encounter | **untouched** | untouched | there is none |
| `subjectVisitId` | closed (`done`) if it was open | **left open**, to be consulted normally | must not be sent |
| Encounter, invoice, fee line, prescription, follow-up | **none written** | none written | none written |
| The attempt | released | released | released |

**`same_attendance` must name the visit it closes**, whenever there is one to
name. Owner item 72 defines it as creating the link *and* closing the leftover
visit; recording it with a visit still in the queue and none named would settle
the reference, close nothing, and leave the doctor holding a visit they could
no longer sign or resolve — one resolution per reference, for ever. Without an
open queue row none is asked for: `SUBJECT_VISIT_REQUIRED` names the tokens
that are waiting.

**And the visit it names must be usable.** Owner policy item 75, decided 16
September 2026:

> A doctor may retrospectively link `same_attendance` to a same-patient visit
> already marked done. Record whether the resolution closed it now or found it
> already done; never claim the resolution performed a closure it did not
> perform. A cancelled visit remains ineligible until separately corrected.
> Other open visits remain untouched.

So the reply carries `subjectVisitDisposition`, and a screen should show what
it says rather than inferring from a boolean:

| Value | What happened | What to show |
|---|---|---|
| `closed_now` | this determination closed the visit | "JMC-0009 closed as the same attendance" |
| `already_done` | the visit was already finished; the link is retrospective | "linked to JMC-0009, which was already finished" |
| `not_applicable` | no visit was named, or this determination does not close visits | nothing about a visit |

`subjectVisitClosed` is still there and still means "this determination
performed a closure" — it is `true` exactly when the disposition is
`closed_now`. Do not use it to decide whether a visit was named.

The `message` distinguishes all three as well, so a screen that surfaces it
directly is not wrong; the field is still the thing to branch on.

A **cancelled** visit is refused with `SUBJECT_VISIT_NOT_OPEN`, before anything
is written, so the reference is unspent: it was not an attendance, and if the
cancellation was the mistake that is its own correction first.

**A visit that already has a consultation of its own is refused too**, with
`SUBJECT_VISIT_ALREADY_CONSULTED`. Owner item 75 links to a visit that was left
*finished*, not to one that was *seen*. If a signing under a different reference
got there first, that visit has its own encounter and its own fee, and recording
it as the same attendance as an earlier consultation would hide a duplicate
rather than resolve one. The message says so: the patient has been charged
twice, and that is its own correction. The consultation this determination is
about is excluded — a doctor who signed with the visit on screen and lost the
reply is exactly who this control is for.

The closure itself is performed by the database: recording the
`closed_on_reconciliation` event is what moves the visit out of the queue, and
that event is written in the determining doctor's name, read from the stored
determination rather than from whoever is calling. `jmc.consultation_attempt_resolutions`
carries the rest of the rule as a **deferred constraint trigger** that reads the
visit and the closure event rather than the flag. An earlier version of this section said a check constraint made a false
closure unrecordable by any route; it did not — the check asked only whether
the writer had set the boolean, and the fourth acceptance review inserted a
claimed closure over a visit that was still waiting.

**And a visit reconciled as the same attendance stays closed.** `done` is the
only status it may still take: `set_appointment_status` refuses anything else
with `VISIT_RECONCILED_AND_CLOSED`, and so does the database, by any route.
Signing against one is refused with the same code. Putting it back in the queue
would let one attendance be consulted and charged twice; **cancelling it** would
say the attendance never happened, beside a determination saying the patient was
seen at it. Without that, the closure could be
undone and the attendance consulted and charged a second time, which is the
whole reason owner item 72 closes it. If the patient is genuinely back, arrive
them afresh; that path is untouched.

`same_attendance` never edits `encounters.appointment_id`. Owner item 72's
first clause is that a signed record is not rewritten, so the link between the
consultation and the visit lives in `jmc.consultation_attempt_resolutions` and
the encounter stays exactly as it was signed. A screen showing "this visit was
reconciled to RX-000123" reads that row, not the encounter.

### Response

```json
{
  "ok": true,
  "message": "Recorded as one attendance. The consultation already signed stands unchanged, the visit is closed, and nothing was charged again.",
  "data": {
    "resolutionId": "…",
    "resolution": "same_attendance",
    "priorOutcome": "committed",
    "attemptReleased": true,
    "encounterId": "…",
    "prescriptionNumber": "RX-000123",
    "signedAt": "2026-09-15T04:32:11.004Z",
    "subjectVisitId": "…",
    "subjectVisitClosed": true
  },
  "revision": 412,
  "snapshot": { … }
}
```

**`attemptReleased` is the field to act on.** It is `true` on every successful
resolution, including a replay. On seeing it, call
`abandonConsultationAttempt(patientId)` — the reference is settled and the next
consultation opens under a fresh one.

**None of these messages says "completed".** Nothing clinical or financial
happened: no encounter, no fee, no prescription. What each confirms is a
decision recorded and a reference let go. The result treatment should be the
quiet two-second one, not the large completion overlay a signing gets.

### Retrying

One resolution per attempt, enforced by a unique index on `idempotency_key`.

- **The same request again** → the original, with `duplicate: true` and the
  same `resolutionId`. Nothing is recorded twice.
- **A materially different determination under the same reference** → refused,
  `code: "RECONCILIATION_ALREADY_RESOLVED"`, naming the doctor who recorded it.
  Changing one's mind is a real thing to do and this is not the way: look at
  what was recorded.
- **Two doctors resolving at once** → exactly one row; both are answered
  truthfully and exactly one is told it was a repeat.

Material identity is `patientId`, `resolution`, `reason`, `subjectVisitId` and
`openedVisitId`. Editing the reason and pressing again is a different request.

## 3. Resolving an attempt: the read behind the control

```text
GET workspace?view=reconciliation&key=<idempotencyKey>&patientId=<id>[&openedVisitId=<id>]
```

**Doctor only**, capability `view.consultation_reconciliation`.

```json
{
  "ok": true,
  "reconciliation": {
    "key": "…",
    "patientId": "…",
    "priorOutcome": "committed",
    "consultation": {
      "encounterId": "…",
      "prescriptionNumber": "RX-000123",
      "signedAt": "2026-09-15T04:32:11.004Z",
      "visitId": "…",
      "visitToken": "JMC-0007"
    },
    "resolved": null,
    "openVisits": [
      { "visitId": "…", "token": "JMC-0009", "status": "waiting", "scheduledAt": "…" }
    ],
    "options": [
      { "resolution": "same_attendance", "available": true,  "detail": "The consultation already signed IS this attendance…" },
      { "resolution": "new_attendance",  "available": true,  "detail": "The patient has genuinely come back…" },
      { "resolution": "abandoned_attempt", "available": false, "refusalCode": "ATTEMPT_ALREADY_COMMITTED",
        "detail": "A consultation WAS signed under this reference, so the attempt was not abandoned." }
    ]
  }
}
```

**Render only the options where `available` is true.** An option the command
would REFUSE carries the exact code it would refuse with, so a screen never
offers a button the server will reject. An option that is unavailable because
the request is incomplete carries no code and says what it needs instead —
`abandoned_attempt` without `openedVisitId` is the only one today.

That promise is kept by a table rather than by care. The read walks the
command's refusals **in the command's own order**, once per determination, and
the first that holds is the answer:

| # | Holds when | Stops | Code |
|---|---|---|---|
| 1 | this reference is already resolved, **for any patient** | all three | `RECONCILIATION_ALREADY_RESOLVED` |
| 2 | a **signing** under it is in flight | all three | `ATTEMPT_OUTCOME_NOT_ESTABLISHED` |
| 2b | a **determination** under it is in flight | all three | *(none — the command waits rather than refusing)* |
| 3 | it signed for a different patient | all three | `ATTEMPT_NAMES_ANOTHER_CONSULTATION` |
| 4 | nothing committed | `same_attendance` | `ATTEMPT_NOT_COMMITTED` |
| 5 | something committed | `abandoned_attempt` | `ATTEMPT_ALREADY_COMMITTED` |
| 6 | no `openedVisitId` given | `abandoned_attempt` | *(none — it is a question, not a verdict)* |
| 7 | `openedVisitId` is unknown or another patient's | all three | `VISIT_NOT_THIS_PATIENTS` |
| 8 | the opened visit is still open | `abandoned_attempt` | `ATTEMPT_VISIT_STILL_ACTIVE` |

Row 1 says "for any patient" because the key is unique across the clinic and
the command looks it up that way. The read filters what it SHOWS by patient —
`resolved` is null and no stranger's reason is handed over — but a reference
settled elsewhere is still settled, and an earlier version filtered the lookup
itself, so all three options came back available and the command refused every
one of them.

One asymmetry to expect: the command is gentler than this table. An **exact**
retry of a determination already recorded replays it with `duplicate: true`,
because that is the lost-reply case the reference exists for. The read marks
every option unavailable anyway, because what belongs in front of a doctor at
that point is what was recorded, not the buttons again.

Row 7 is the one the third review reproduced. It was written against
`abandoned_attempt` alone, so Same attendance and New attendance were offered
as available against a visit belonging to somebody else, and the doctor found
out by pressing them. Row 5 ordering matters for the same reason: a committed
attempt with an unknown opened visit is refused as already committed, not as an
unknown visit, and the read has to say the same.

**Three of the command's refusals are not in that table, and cannot be.** They
turn on `subjectVisitId`, which the read is never given — it receives the key,
the patient and the opened visit, and nothing else. So the table covers what
the read is in a position to know, and these three are the screen's own
responsibility:

| Refusal | When | What the screen must do |
|---|---|---|
| `SUBJECT_VISIT_REQUIRED` | Same attendance **or new attendance**, a visit open, none named | Send the visit. The `detail` on the available option already says to. |
| `SUBJECT_VISIT_NOT_OPEN` | Same attendance naming a **cancelled** visit, or new attendance naming one that is cancelled or finished | Offer only visits from `openVisits` for a new attendance; a same attendance may also name a finished one. |
| `VISIT_NOT_THIS_PATIENTS` | any determination naming another patient's visit | Never send an id the read did not hand you. |

All three refuse before anything is written and leave the reference unspent, so
a screen that gets one wrong costs a press and not a determination.

`same_attendance` and `new_attendance` both stay **available** while the patient
has an open visit, both require `subjectVisitId` then, and both say so in the
`detail` a screen shows. An earlier version said it for the first and not the
second, so a screen built to this contract would have submitted a new
attendance with no visit and met `SUBJECT_VISIT_REQUIRED` — the promise the
option list exists to keep, broken for the case the same correction had just
created. Sending it without one when
a visit is open is refused with `SUBJECT_VISIT_REQUIRED`, and naming a visit
that is already cancelled or finished is refused with `SUBJECT_VISIT_NOT_OPEN`
— owner item 72 closes the leftover visit, so a determination that could close
nothing is not that determination. Both refusals happen **before** anything is
written, so the reference is unspent and the doctor can say what they meant.

Pass `openedVisitId` whenever the tablet has it. Owner item 73 defines an
abandoned attempt BY the state of the visit it was opened against, so without
that field neither this read nor the command can answer, and both say so rather
than guessing.

**`inFlight` says which of the two.** When `priorOutcome` is `unknown` the
payload carries `inFlight: "signing"` or `inFlight: "resolution"`, and they are
different situations: a signing is owner item 73's fail-closed state and the
command refuses against it, while a determination is another doctor deciding —
the command waits for them and then replays or reports what they recorded. An
earlier version watched one advisory lock and said "a consultation is being
signed under this reference right now" about both; a resolution holds that lock
too, so the sentence was false whenever a determination was what was running.

The answer is read **per backend**, and `signing` wins. A resolution holds both
locks on one connection; a signing holds the attempt lock alone. A version that
asked only whether each lock was held *somewhere* reported "resolution" whenever
both appeared — so a doctor signing on one connection, while a different doctor
resolved on another, was told nothing was being signed.

### `priorOutcome`, and the third value

| Value | Meaning |
|---|---|
| `committed` | An encounter carries this reference. `consultation` says which. |
| `not_committed` | No record carries it, and no signing is in flight. |
| `unknown` | **A signing under this reference is executing right now.** |

`unknown` is owner item 73's fail-closed state. The read tests the same
advisory lock the write takes, so it can tell "nothing committed" from "nothing
has committed *yet*" — but **at the instant it asked**, and the encounter is
looked up in a second statement, so a signing can start and commit between the
two and this can report `not_committed` about a reference that has just
committed. That is survivable because this read releases nothing: the command
holds the lock for its whole transaction, re-reads under it, and is the thing
that refuses. Treat `not_committed` here as what the clinic held a moment ago,
and the command's answer as the decision. An earlier version of this section
said the read answered under the lock, which would have invited a screen to
believe it.

When it does say `unknown`, every option is unavailable with
`ATTEMPT_OUTCOME_NOT_ESTABLISHED`. Show the doctor that the clinic is still
deciding and let them look again; do not offer a resolution.

`resolved` is non-null when this reference has already been determined, and
then every option is unavailable with `RECONCILIATION_ALREADY_RESOLVED`. It
carries the resolution, the reason, the doctor's name and the time — enough to
show what happened instead of an error.

## 4. The appointment book: commands

Every one of these is a `command` POST and returns the ordinary
`{ ok, message, data?, revision, snapshot }` envelope.

**A booking is not in the snapshot.** Nothing joins the whole-clinic poll in
this programme, so after booking, the calendar is read through §5 rather than
found in `snapshot.appointments`. The one command whose result DOES change the
snapshot is `check_in_appointment`, because that creates a queue row.

### 4.0 Every one of them requires `idempotencyKey`

Not optional, and not idempotent by inspecting the clinic afterwards.

Slice 2 shipped four of these deciding "have I already done this?" from the
booking's CURRENT state — is it already at this time, is it already checked in.
The acceptance review reproduced what that costs, because the whole reason a
retry arrives late is that the state moved:

> Move to 11:00. Reply lost. Somebody moves it to 12:00. The lost reply's retry
> arrives, finds the booking is not at 11:00, decides it is therefore not a
> duplicate, and moves it **back** to 11:00.

> Check in; JMC-0001 is issued. Reply lost. The appointment is rescheduled and
> that arrival cancelled. The retry arrives, finds the booking `booked`, and
> mints **JMC-0002** while dragging the booking back into `checked_in`.

Send one reference per attempt and reuse it across every retry of that attempt.
The rules:

| | |
|---|---|
| Same reference, same request | The **original** outcome, with `duplicate: true`. Nothing happens twice. |
| Same reference, materially different request | Refused, `code: "APPOINTMENT_REFERENCE_REUSED"`. Nothing is changed. |
| Two people, one reference | Also `APPOINTMENT_REFERENCE_REUSED`. The actor is part of what a reference names, because answering the second with the first's outcome attributes an act to the wrong person. |
| No reference at all | Refused. These commands have no deployed caller, so there is nobody to be compatible with, and a compatibility window nobody needs is a hole beside the guarantee it defeats. |
| Two sent at once | One serialization point. One result, one receipt, and exactly one of the two is told it was a repeat. |
| A refused command | No receipt. The reference is unspent and may be sent again. |

Only two things happen before the receipt is read: the role check, and
canonicalising what the caller sent. Every question about the clinic *now* —
the ninety-day horizon, which doctor, what today's date is — is asked after it,
because a retry arrives precisely when "now" has moved. A reference that has
already been spent is told so, rather than being told something about a
calendar it cannot act on.

**A replay carries the present as well as the past.** `duplicate: true` comes
with `current…` fields and with `superseded`, on every command. Show both: what
you did, and whether it still holds. A screen that prints only the token prints
a token for a patient who is not in the queue.

**`superseded` is about the whole effect, not one field of it.** A request that
set a time, a type and a duration stands only while all three are still what it
set. The first correction compared the scheduled instant alone, so a second
reschedule to the *same* time with a longer type replayed the thirty-minute
outcome, reported the current duration as forty-five, and said
`superseded: false` in the same breath. Read the table as: "this reply still
describes the clinic".

| Command | Stands while | `current…` |
|---|---|---|
| `book_appointment` | the booking is open **and** still at the time, type, duration and override flags this request set | `currentStatus`, `currentScheduledAt`, `currentAppointmentTypeId`, `currentDurationMinutes`, `currentOverbooked`, `currentOutsideAvailability` |
| `reschedule_appointment` | the same, for what *this move* set | the same |
| `cancel_appointment` | it is cancelled | the same |
| `mark_no_show` | it is closed as a no-show | the same |
| `check_in_appointment` | the arrival is not cancelled and the booking is still `checked_in` | `currentArrivalStatus`, `currentBookingStatus` |
| `set_queue_priority` | the visit is still open **and** carries this request's flag *and* its reason | `currentVisitStatus`, `currentUrgent`, `currentUrgentReason` |
| `create_appointment_type`, `update_appointment_type` | every field **this request set** still holds that value | `currentName`, `currentDurationMinutes`, `currentActive` |
| `publish_availability` | the window is active | `currentActive` |
| `retire_availability` | the window is retired | `currentActive` |

Two distinctions in that table earn their place:

- The appointment type is compared **by id**, not through its duration. Two
  types may both run thirty minutes, and moving a patient from Review to
  Dressing is a change even though no number moved.
- A creation and an update ask the same question, and it is about the fields
  the request set rather than about the row existing. "Antenatal added, 30
  minutes" is a sentence about a name and a duration; a type since renamed and
  lengthened makes it untrue, and a replay hands that sentence back. Nothing
  deletes an appointment type, so "stands while the row exists" would have been
  a constant `false` as well as the wrong question.
- Neither is superseded because somebody changed a field it never mentioned.
  An update that sent only a duration says nothing about the name; a creation
  says nothing about `active`.

**Two fields, two zones, and they are not a mistake.** `scheduledAt` in a
replay is the instant as recorded — UTC ISO-8601 with milliseconds, the same
string the first reply carried. `currentScheduledAt` beside it is clinic-local
`YYYY-MM-DD HH:MM`, for printing. Compare instants with `scheduledAt`, show
people `currentScheduledAt`, and do not compare the two with each other.
Milliseconds are preserved end to end: a booking sent for `10:30:00.500` is
recorded, replayed and compared at `10:30:00.500`, and is not superseded by
its own rounding.

The check-in above replays JMC-0001 *and* says
`currentArrivalStatus: "cancelled"`, `currentBookingStatus: "booked"`,
`superseded: true`. A reschedule retry arriving after a newer move replays the
time it asked for *and* says `superseded: true` with the time the booking is
actually at.

**Material identity is what the caller sent.** Everything that reaches a
durable record is in the fingerprint — including `overrideReason`, which Slice 2
left out, so two requests differing only in why an override was allowed were
treated as one. Nothing *derived from mutable state* is in it. `doctorId` is
the doctor the caller **asked for**, which may be nothing; the clinic's answer
to "who is the only doctor today" is not part of the request, because a locum
joining tomorrow would otherwise turn an exact retry into a different request
and put the stored outcome out of reach. What the server resolved comes back in
the result — `doctorId`, `appointmentTypeId`, `availabilityId` — and a replay
returns the same values it returned the first time.

### `create_appointment_type` · `update_appointment_type` — doctor, admin

Owner item 65. `{ name, durationMinutes? }` → `{ appointmentTypeId }`. Default
15 minutes, maximum 480. `update_appointment_type` takes
`{ appointmentTypeId, name?, durationMinutes?, active? }`.

A change here **never** rewrites a booking already made — the duration is
copied onto the booking when it is made, exactly as the consultation fee is
copied onto the encounter. The success message says so, and a screen should
not imply otherwise.

### `publish_availability` · `retire_availability` — doctor, admin

Owner item 71. A window is recurring or dated, never both:

| Field | Meaning |
|---|---|
| `kind` | `open` (default) or `blocked`. A blocked window subtracts from an open one. |
| `weekday` | `0` Sunday … `6` Saturday. With `effectiveFrom`, optional `effectiveTo`. |
| `onDate` | `YYYY-MM-DD`, for one day only. Mutually exclusive with `weekday`. |
| `startsAt`, `endsAt` | `HH:MM`, clinic-local. |
| `note` | Free text — "Closed for a wedding". |

`retire_availability` takes `{ availabilityId, reason }` and deactivates it.
**Neither ever moves or cancels a booking**, which is item 71's last sentence;
both messages say so, because a doctor blocking an afternoon needs to know the
three people already booked into it are still coming.

### `book_appointment` — admin, doctor, nurse

| Field | Required | Meaning |
|---|:-:|---|
| `patientId` | yes | |
| `reason` | yes | Travels onto the queue row at check-in, where it is what the doctor reads before calling somebody in. |
| `scheduledAt` | yes | `YYYY-MM-DDTHH:MM` is read as **clinic-local**; a value carrying a zone is absolute. Send what the `datetime-local` input gives you. |
| `doctorId` | no | Omit where the clinic has one doctor. With several and no doctor named, a doctor books themselves and anybody else is asked to say. |
| `appointmentTypeId` | no | Its duration is copied onto the booking. |
| `overrideReason` | no | Required only when a conflict or the published hours are being overridden — see below. |
| `idempotencyKey` | **yes** | One per booking attempt, reused across every retry of it. See §4.0. |

Returns `{ bookingId, scheduledAt, durationMinutes, overbooked, outsideAvailability }`.

**The two-step override (owner items 67 and 71).** Booking into an occupied
slot, or outside published hours, is refused first and offered second:

| Caller | Slot taken, or outside published hours |
|---|---|
| nurse | Refused. `SLOT_ALREADY_TAKEN` naming who has it, or `OUTSIDE_PUBLISHED_AVAILABILITY`. There is no override; ask a doctor or an administrator. |
| doctor, admin, no reason sent | Refused, `OVERRIDE_REASON_REQUIRED`. The message asks for the reason. |
| doctor, admin, `overrideReason` sent | Booked, with `overbooked` and/or `outsideAvailability` true and the reason on the record. |

So the screen shape is: try, and on `OVERRIDE_REASON_REQUIRED` open a short
modal asking why, then send the same request with `overrideReason`. On
`SLOT_ALREADY_TAKEN` or `OUTSIDE_PUBLISHED_AVAILABILITY` there is nothing to
ask for — say who has the slot and offer another time.

One sentence covers both overrides, and the calendar returns it as
`overbookedReason` whichever it was — the field is named for the override it
was written for. Read it beside `overbooked` and `outsideAvailability`, either
or both of which may be true.

**A day with no published open window is a day a nurse cannot book.** Owner
item 71 says *within* published availability and admits no exception; Slice 2
read one in, and the acceptance review reproduced a nurse booking a patient for
three in the morning. The rule now:

- **nurse** — the whole appointment must fall inside an open window for that
  day, and no blocked window may overlap it. Otherwise
  `OUTSIDE_PUBLISHED_AVAILABILITY`, and there is no override.
- **doctor, admin** — may place it anyway, with `overrideReason`, and the
  booking carries `outsideAvailability` and the reason.

The clinic is not locked out on its first morning: a doctor or an admin books
it, and publishing hours is simply the first thing a clinic does. **That the
doctor keeps an override at all is an implementation default**, not something
item 71 says — item 71 constrains the nurse and is silent about the doctor, who
owns the hours, and item 67 supplies the shape of a recorded override rather
than this inventing a second one.

The same rule governs rescheduling, because item 71's sentence names both.

**Two published sessions that meet are one stretch of published time.** A
clinic that publishes 09:00–13:00 and 13:00–17:00 has published 09:00–17:00,
and an appointment at 12:55 is inside it. Coverage, not containment: every
minute of the appointment must be published, by any combination of windows, and
any overlapping blocked window blocks the whole appointment. An appointment
that would cross midnight is outside by construction.

**Two new refusal codes:** `SUBJECT_VISIT_REQUIRED` and
`SUBJECT_VISIT_NOT_OPEN` — see §2.

### `reschedule_appointment` · `cancel_appointment` — admin, doctor, nurse

Owner item 68. Both require a `reason`, and both keep the whole history.

`reschedule_appointment` takes `{ bookingId, scheduledAt, reason, appointmentTypeId?, overrideReason? }`
and runs the same conflict and availability rules as booking.

**After check-in, only doctor and admin may do either** — `CHECKED_IN_ALREADY`
for a nurse. Both then also cancel the queue row the patient is standing in,
and the message names the token that left the queue. A visit whose consultation
has been signed cannot be cancelled or moved: `VISIT_ALREADY_FINISHED`.

**A retry is the same reference; a repeat is not.** Sending the same reference
again replays (§4.0). Sending a NEW reference to cancel an already-cancelled
booking, or to mark an already-closed one absent, is a second act on a closed
record and is `APPOINTMENT_CLOSED`. Slice 2 conflated the two by reading the
booking's state, which made a lost reply and a deliberate second request
indistinguishable.

**A reschedule is not only a time.** A request at the appointment's existing
time that changes `appointmentTypeId` applies that change and writes its
history once — Slice 2 treated "same `scheduled_at`" as a duplicate and
silently kept the old type and duration.

**And it applies the override it validates.** Moving into a clear,
inside-hours slot clears `overbooked`, `outsideAvailability` and the reason;
moving into a conflict or outside hours sets them, with the reason given for
THIS move. Slice 2 validated the new slot and then kept the flags the original
booking was made under, so an appointment moved out of a conflict went on
claiming it was overbooked. The schema now refuses a flag without a sentence
and a sentence without a flag, so getting it wrong is a constraint violation
rather than a quiet lie.

The `rescheduled` event records the time before and after, the type and
duration before and after, whether a conflict or the hours were overridden, the
override reason, the actor and the time.

### `mark_no_show` — admin, doctor, nurse

Owner item 69. `{ bookingId, reason? }`.

**Nothing marks a no-show automatically, and nothing in this application ever
will.** A booking is eligible thirty minutes after its scheduled start; earlier
is `TOO_EARLY_FOR_NO_SHOW`, with the scheduled time in the message. A patient
who checked in cannot be a no-show: `APPOINTMENT_CLOSED`, *"This patient
checked in, so they did not fail to attend."*

### `check_in_appointment` — admin, doctor, nurse

Owner item 70, and the one door between the calendar and the queue.

`{ bookingId }` → `{ arrivalId, token, duplicate? }`.

The arrival is an ordinary `jmc.appointments` row: a token from the same `JMC-`
series a walk-in gets, `waiting`, and — this is the part that matters —
`scheduled_at` stamped **now** rather than copied from the booked time. A
patient booked for 09:00 who arrives at 11:20 goes behind the walk-in who came
at 11:00, which is what everybody in the room can see is fair.

**Retrying under the same reference** returns the original token with
`duplicate: true`, plus `superseded` and the current arrival and booking status
(§4.0). Two requests sent at once under one reference both succeed and name
one arrival. A **new** reference against a booking already checked in is
`CHECKED_IN_ALREADY` — two references are two requests.

### `set_queue_priority` — **doctor only**

Owner item 70's urgency override. `{ appointmentId, urgent?, reason }` —
`urgent` defaults to `true`; send `false` to put the patient back in arrival
order. The reason is required either way and is recorded with the doctor's
name.

Doctor alone, and not admin: this is a judgement about who is sicker, which is
the one thing on the queue that is not an administrative fact. A visit that is
finished or cancelled is refused with `VISIT_NOT_OPEN`.

## 5. The calendar and a patient's history

```text
GET workspace?view=calendar&from=YYYY-MM-DD[&to=YYYY-MM-DD][&doctorId=…]
GET workspace?view=appointments&patientId=…
```

Both: **admin, doctor, nurse**. Pharmacy is refused — the counter has no queue
station and identifies a patient by name and prescription rather than by token.

`to` defaults to `from`. The range is clinic-local days and is capped at the
ninety-day booking horizon; a malformed date, a reversed range and a range too
wide all answer the same 400, *"Ask for a day, or a range of up to ninety days,
as YYYY-MM-DD."*

```json
{
  "calendar": {
    "from": "2026-09-16", "to": "2026-09-16",
    "bookings": [{
      "bookingId": "…", "patientId": "…", "patientName": "…",
      "doctorId": "…", "doctorName": "…",
      "scheduledAt": "2026-09-16T04:30:00.000Z", "durationMinutes": 15,
      "reason": "Fever", "status": "checked_in",
      "appointmentType": "Long review",
      "overbooked": false, "outsideAvailability": false, "overbookedReason": null,
      "checkedInAt": "…",
      "arrivalId": "…", "arrivalToken": "JMC-0009", "arrivalStatus": "waiting",
      "lastEvent": { "event": "checked_in", "reason": "", "by": "Nirmaladevi Ponnusamy", "at": "…" }
    }],
    "availability": [{
      "availabilityId": "…", "doctorId": "…", "kind": "open",
      "weekday": 2, "onDate": null, "startsAt": "09:00", "endsAt": "13:00",
      "effectiveFrom": "2026-09-01", "effectiveTo": null, "note": ""
    }],
    "truncated": false
  }
}
```

`status` is one of `booked`, `checked_in`, `cancelled`, `no_show`. `arrivalToken`
is present once the patient has checked in and is how a calendar row and a
queue row are shown to be the same person.

**The availability list is not expanded per day.** A weekly window is three
lines of data, and turning it into ninety rows of the same three lines is
sending a calendar the long way round. Expand it on the client against the days
you are drawing: a `weekday` window applies on that weekday inside
`effectiveFrom`…`effectiveTo`; an `onDate` window applies on that date; and
`kind: "blocked"` subtracts from whatever `open` windows overlap it.

`workspace?view=appointments` returns up to fifty of one patient's bookings,
newest first, each with a `history` array of every transition:
`{ event, reason, detail, by, at }`, oldest first. That is where owner item
68's *"the prior state, actor, time, and reason remain in append-only history"*
is read back, and it is what a screen shows instead of a deleted row.

## 6. Two new work lists

Both on the existing `workspace?view=workload` and
`workspace?view=list&list=…`, admin/doctor/nurse, and both reconcile with their
drill-down by construction.

| Id | Label | What is on it |
|---|---|---|
| `list.appointments_today` | Expected today | `booked` bookings whose clinic day is today. Rows carry `late: true` past the half hour. |
| `list.no_show_review` | No-show review | `booked` bookings more than thirty minutes past their start, any day. Rows carry `minutes_late`. |

**They overlap on purpose.** A booking forty minutes late is on both, because
there are two things to do about it and they belong to different moments: check
them in if they are standing there, confirm the no-show if they are not. Taking
a late patient off the check-in list would hide them from the person most
likely to be looking at it when they walk in.

`no_show_review` is deliberately not bounded to today — a booking from last
Thursday that nobody closed is exactly what it is for.

## 7. The queue: one field, and one ordering

`AppointmentView` gains one optional field:

```ts
urgent?: boolean
```

Absent means false; a build older than Slice 2 does not send it. The snapshot
now orders `urgent desc, scheduled_at`, which cannot move any existing row —
every row is `false` until a doctor presses a control that does not exist yet.

**The reason is deliberately not on the snapshot.** `appointments` is the one
snapshot collection with no role boolean in front of it, so everything on it
reaches a pharmacy tablet every fifteen seconds, and *"moved up: chest pain,
looks grey"* is a clinical statement the counter has no business with. The
reason, the doctor who set it and the time are on `list.today_queue`, which is
gated on admin/doctor/nurse. That list also carries `booking_id`, which says
whether the patient was expected or walked in.

A queue screen should sort `urgent` first and mark those rows with an icon and
a word — never colour alone — and the reason belongs in the row's detail rather
than in its heading.

## 8. The role matrix, in one place

| | admin | doctor | nurse | pharmacy |
|---|:-:|:-:|:-:|:-:|
| `create_appointment_type`, `update_appointment_type` | ✓ | ✓ | | |
| `publish_availability`, `retire_availability` | ✓ | ✓ | | |
| `book_appointment` | ✓ | ✓ | ✓ | |
| …overriding a conflict or the published hours | ✓ | ✓ | | |
| `reschedule_appointment`, `cancel_appointment` — before check-in | ✓ | ✓ | ✓ | |
| …after check-in | ✓ | ✓ | | |
| `mark_no_show` | ✓ | ✓ | ✓ | |
| `check_in_appointment` | ✓ | ✓ | ✓ | |
| `set_queue_priority` | | ✓ | | |
| `resolve_consultation_attempt` | | ✓ | | |
| `view.appointment_calendar`, `view.patient_appointments` | ✓ | ✓ | ✓ | |
| `view.consultation_reconciliation` | | ✓ | | |
| `list.appointments_today`, `list.no_show_review` | ✓ | ✓ | ✓ | |

An administrator who is also a doctor holds the doctor rows through that role,
as everywhere else here. An administrator who is not gets neither
`set_queue_priority` nor `resolve_consultation_attempt`.

## 9. Every refusal code this slice adds

Codes arrive as `{ ok: false, message, code }`. Never branch on message text.

| Code | Raised by | What the screen should do |
|---|---|---|
| `ATTEMPT_NEEDS_RECONCILIATION` | `sign_consultation`, before a first signing as well as on a replay | **Hold the attempt.** Offer the resolution control (§3). Never rotate. |
| `VISIT_NOT_THIS_PATIENTS` | `resolve_consultation_attempt`, and §3's option list | A named visit belongs to somebody else, or does not exist. A client fault; nothing was changed. |
| `SUBJECT_VISIT_REQUIRED` | `resolve_consultation_attempt` | Same attendance with a queue row open and none named. The message names the waiting tokens; send one. |
| `SUBJECT_VISIT_NOT_OPEN` | `resolve_consultation_attempt` | Same attendance naming a cancelled visit, or new attendance naming one that is no longer open. Nothing was changed and the reference is unspent; name a usable visit, or none. |
| `VISIT_RECONCILED_AND_CLOSED` | `set_appointment_status` (any status but `done`), `sign_consultation` | That visit was already recorded as the same attendance as a signed consultation. It has been seen and paid for; it does not return to the queue and is not cancelled. Arrive the patient afresh. |
| `SUBJECT_VISIT_ALREADY_CONSULTED` | `resolve_consultation_attempt` | Same attendance naming a visit that has its own consultation. **This patient has two consultations and two fees.** Nothing was changed; show the duplicate rather than closing over it. |
| `ATTEMPT_SETTLED_BY_RECONCILIATION` | `sign_consultation` | The reference was closed by a doctor and nothing was written under it. Start a new consultation, which mints. |
| `ATTEMPT_OUTCOME_NOT_ESTABLISHED` | `resolve_consultation_attempt` | A signing is in flight. Nothing changed. Look again in a moment. |
| `ATTEMPT_NOT_COMMITTED` | `resolve_consultation_attempt` | Nothing was signed under this reference, so there is nothing for a visit to be the same attendance as. Sign it. |
| `ATTEMPT_ALREADY_COMMITTED` | `resolve_consultation_attempt` | A consultation was signed, so the attempt was not abandoned. Offer same/new attendance. |
| `ATTEMPT_VISIT_STILL_ACTIVE` | `resolve_consultation_attempt` | The opened visit is still in the queue, so nothing has been abandoned. Sign it, or cancel the visit. |
| `RECONCILIATION_ALREADY_RESOLVED` | `resolve_consultation_attempt` | Show what was recorded, by whom, and when. Do not offer the buttons again. |
| `SLOT_ALREADY_TAKEN` | `book_appointment`, `reschedule_appointment` | Say who has the slot; offer another time. A nurse has no override. |
| `OUTSIDE_PUBLISHED_AVAILABILITY` | `book_appointment`, `reschedule_appointment` | Offer a time inside the published hours. A nurse has no override. |
| `OVERRIDE_REASON_REQUIRED` | `book_appointment`, `reschedule_appointment` | Ask why, then resend with `overrideReason`. |
| `APPOINTMENT_REFERENCE_REUSED` | every appointment command | The reference already names a different request, or one sent by somebody else. A client fault. Send this one under a reference of its own. |
| `CHECKED_IN_ALREADY` | `reschedule_appointment`, `cancel_appointment` | A nurse cannot change a visit that has started. Ask a doctor or an administrator. |
| `VISIT_ALREADY_FINISHED` | `reschedule_appointment`, `cancel_appointment` | The consultation is signed; the record stands. |
| `APPOINTMENT_CLOSED` | `reschedule_appointment`, `cancel_appointment`, `mark_no_show`, `check_in_appointment` | Two different acts disagreeing — the booking is closed in the other direction. Book a new one. A REPEAT of the same act is a success with `duplicate: true`, not this. |
| `TOO_EARLY_FOR_NO_SHOW` | `mark_no_show` | Say when it becomes available; the patient may still be on their way. |
| `VISIT_NOT_OPEN` | `set_queue_priority` | The visit is finished or cancelled; its place in the queue decides nothing. |

## 10. What this contract does not answer

- **The bounded reconciliation screen cannot discover a finished visit for a
  retrospective link.** The command accepts Same attendance naming a
  same-patient visit already marked `done`, but §3 returns only `openVisits`.
  The frontend therefore has no permitted finished-visit id to offer. This is
  recorded as a remaining contract/UI limitation; the safety cutover did not
  change the accepted backend contract.
- **No reminder is sent, scheduled, or queued.** `jmc.appointment_events` is
  the durable hook a later scheduler reads, and it carries every transition
  with its actor, reason and time. Owner-policy items 76–83 now answer the
  channel, timing, quiet hours, per-purpose consent, failed-delivery ownership,
  template, opt-out and recall questions in D8–D12c. Slice 3 owns their
  implementation and has not started.
- **No public booking page.** Slice 5 owns that, and it must reuse this
  slice's conflict and idempotency engine rather than forking it.
- **No multi-provider, room or equipment scheduling.** The clinic model is one
  doctor; `doctorId` exists so that a second one is an extension rather than a
  fork, and nothing more has been built.
- **Vitals still cannot be tied to a visit**, so a patient who attends twice in
  one day has one vitals stream. Unchanged from Slice 1, and it belongs to a
  slice that may alter `jmc.vitals`.
- **Whether a nurse should see allergy alerts** is still an owner question, and
  nothing here widened it.
- **One resolution per attempt reference, for ever.** A patient left holding
  two leftover queue rows for one attendance can have one closed by
  **Same attendance**; the second call is `RECONCILIATION_ALREADY_RESOLVED`,
  and the second row is closed from the queue in the ordinary way.
- **A booking's material identity** — what makes a reused reference a refusal
  rather than a replay — is the **actor**, the patient, the doctor, the
  appointment type, the reason, the scheduled instant and the **override
  reason**. The first version of this line named five of the seven and omitted
  exactly the two the acceptance correction added, which is the same shape of
  mistake the correction was fixing. Editing only the reason and resending
  under the same reference is a different request and is refused.
- **`check_in_appointment` has no horizon.** A booking ninety days out can be
  checked into today's queue. A patient standing at the desk is a patient
  standing at the desk.
- **`reschedule_appointment` cannot clear an appointment type.** Sending an
  empty `appointmentTypeId` keeps the existing one rather than removing it; the
  way back to the clinic default is a type whose duration is fifteen minutes.
- **A slot held by a patient who has already checked in does not conflict.**
  The conflict check looks at `booked` bookings only, so a nurse may book over
  somebody who is already in the room. Pre-existing and arguable either way;
  recorded rather than decided.
- **The 480-minute ceiling on an appointment type is not owner policy.** Item
  65 decided the fifteen-minute default and the per-type override and said
  nothing about a maximum. Eight hours is an implementation bound against a
  mistyped number. Do not present it to anybody as a clinic rule.
