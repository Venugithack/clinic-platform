# The PIN reset appointment

Moving Jayamurugan Clinic from a six-digit PIN to a four-digit one, without
locking anybody out.

This is the procedure for the day it happens at the clinic. It is short on
purpose. The engineering half is done and tested; what remains is a person
sitting down with each member of staff, and the only way that goes wrong is by
doing it in the wrong order.

---

## 1. Why this cannot be done from a keyboard

A stored PIN is a scrypt hash. A hash reveals nothing about what went into it,
so there is no way to turn a six-digit PIN into a four-digit one, and no way to
"shorten" anybody's PIN remotely. Every staff member has to choose a new one,
in person, and prove it works before you move on.

That is also why the migration is two-stage. Until somebody is reset, their old
six-digit PIN keeps working — the clinic never stops running. The moment they
are reset, only the new four-digit PIN works for them, and the old one is dead.

The software tracks which is which on each staff row, so nobody has to
remember. **Staff and roles** shows you.

---

## 2. Before the day

| | |
|---|---|
| **Confirm the recovery administrator** | Dr. Jayamurugan is the intended recovery administrator. Open **Staff and roles** and confirm he actually holds the **admin** role, not only **doctor**. If he does not, grant it first. The whole runbook below depends on there being someone who can reset the person doing the resetting. |
| **Prefer two administrators** | If two people hold admin, they reset each other and nobody has to reset themselves. That is the better shape and it removes the only awkward step in §4. |
| **Book enough time** | A few minutes each. It is not the typing, it is the "choose something you will remember, and not your birthday" conversation. |
| **Do not do it mid-clinic** | A staff member who is reset is signed out of every tablet they were signed in on. That is correct behaviour and a bad surprise halfway through a consultation. |

---

## 3. What a good PIN is here

The software refuses the obvious ones. It will not accept:

- fewer or more than four digits
- the same digit four times — `0000`, `7777`
- a run in either direction, including one that wraps — `1234`, `4321`,
  `8901`, `1098`

It cannot refuse a birthday, a house number, or the PIN somebody already uses
for their bank card, and those are the ones worth talking about while you are
sitting there. Four digits is ten thousand combinations. What makes that safe
enough is not the number, it is everything around it: one PIN per person, five
wrong tries per device per fifteen minutes, a thirty-minute idle lock, and an
audit trail with a name on it. Sharing a PIN takes all of that away at once.

**Nobody types anybody else's PIN.** The person it belongs to enters it. The
audit trail says who did what, and it is only true if that holds.

---

## 4. The order, and why it is this order

### If there are two administrators

1. Administrator A resets everyone who is not an administrator.
2. Administrator A resets administrator B.
3. Administrator B resets administrator A.

Nobody resets themselves. Nothing below applies.

### If there is only one administrator

1. **Everyone else first.** For each staff member, with them present:
   - Open **Staff and roles**, choose them, choose **Reset PIN**.
   - They enter their new four digits.
   - **They sign in with it, on a tablet, before you move on.** Not later. A
     PIN that turns out to be wrong is a two-minute problem now and a locked-out
     nurse on Monday morning.
2. **The administrator last, on themselves.**
   - Resetting your own PIN signs you out immediately. This is deliberate — a
     PIN is changed when somebody thinks it is known, and leaving the tablet
     signed in would defeat the point — and the screen says so before you
     confirm.
   - **Sign straight back in with the new PIN, before leaving the building.**

### The step that actually goes wrong

Resetting yourself first. You are then signed out, and if the new PIN was
mistyped there is no administrator left who can reset it — on a clinic where
you are the only one. That is the failure this ordering exists to prevent, and
it is why two administrators is the better arrangement.

---

## 5. Knowing when it is finished

**Staff and roles** shows how many active staff are still on a six-digit PIN.
When it reads zero, the migration is complete.

Two things follow from zero and neither is automatic:

- Six-digit compatibility can be removed from the code. Until then it stays,
  because removing it early locks out everybody not yet reset.
- Somebody who has left the clinic is not counted. They cannot be sat down and
  reset, so counting them would mean the number never reaches zero. If a former
  staff member's account is still active, deactivate it — that is the right
  answer regardless of PINs.

---

## 6. If something goes wrong

| What happened | What to do |
|---|---|
| Somebody mistyped their new PIN and cannot sign in | Any administrator resets them again. Nothing is lost. |
| The device says "Too many wrong PINs from this device" | Wait fifteen minutes, or use a different tablet. The limit is charged to the device, not the person — which is why nobody can lock the doctor out by tapping wrong PINs in the waiting room. |
| The only administrator is locked out | This is the case §4 exists to prevent. Recovery requires database access. Do not let it happen: reset yourself last, and verify immediately. |
| Somebody's tablet signed itself out during the appointment | Expected. A reset revokes that person's sessions everywhere. They sign in again with the new PIN. |
| A staff member wants their old six-digit PIN back | Not possible, and not desirable. The old hash is overwritten by the reset. |

---

## 7. What has been verified, and what has not

Verified against the staging database, as automated tests
(`tests/characterization/slice1-gate.test.mjs`):

- a staff member not yet reset still signs in with six digits
- a reset staff member signs in with four, and their old PIN is dead
- a six-digit account refuses a four-digit attempt and the reverse, with the
  same generic message either way
- the whole runbook in sequence, ending with the administrator resetting
  themselves, being signed out, and signing back in
- the legacy count reaching zero
- throttling still charged to the device, not the account
- a reset revoking that person's sessions

**Not verified, and it cannot be from here:** the clinic's actual staff list,
who holds the admin role today, and the clinic's own tablets and Wi-Fi. Those
are the day itself.
