# Clinic platform — proposal

Prepared for **[ clinic name ]** · [ date ]

A custom platform for a single-doctor clinic with its own pharmacy. Built around
the four things you asked for: the consulting room connected to the pharmacy
counter, proper stock control of your medicines, orders that reach your supplier
on WhatsApp, and a WhatsApp channel for your patients.

This is not the hospital demo with parts removed. It is a smaller system built
deeper in the places that matter to a clinic.

---

## 1. What you asked for, and what it becomes

| You said | What gets built |
|---|---|
| "connection between the doctor room and pharmacy" | A prescription you sign appears on the pharmacy counter screen in under a second. The counter can send a question back — *"Amoxicillin is out, substitute?"* — and you answer it without leaving your chair |
| "inventory management of the medicines" | Every medicine, every batch, every expiry date. Stock goes up when you receive goods and down when you dispense, and the system can always tell you why it moved |
| "low stock notification" | A live list on screen, plus one WhatsApp message each morning listing what has run low. One message, not one per medicine |
| "auto message send to supplier in whatsapp" | The system prepares the order by itself, grouped per supplier. You look at it and tap **Send**. See §4 — there is a decision for you there |
| "patients whatsapp… know if the doctor is available or not" | A live clinic status your patients can check any time, driven by whether you are logged in at the clinic — with safeguards so it is never wrong. See §5 |
| "appointment booking and prescription checking" | Patients book on WhatsApp, get a token number, see how many are ahead of them, and open their prescription and bill on a link |

---

## 2. What is included

| Included | Can be added later | Not included |
|---|---|---|
| Patient records, searchable by phone; families on one number | Online payment / UPI collection | Beds, wards, admissions |
| Appointments, token numbers, live queue | Lab tests — ordering and results | Video consultation |
| Consultation form, diagnosis, prescription | Uploading outside lab reports and scans | Any software that suggests a diagnosis or a dose — see §8 |
| Prescription reaching the counter instantly | Medical certificates | Drug interaction checking — see §8 |
| Dispensing, part-dispensing, substitution | Accounting export (Tally) | Home delivery of medicines |
| Over-the-counter sale at the pharmacy | Second branch | Sharing your patient data with anyone |
| Medicine catalogue, suppliers, batches, expiry | Staff attendance | |
| Receiving goods, purchase orders, stock count | Insurance / TPA claims | |
| Low-stock and expiry alerts | | |
| Supplier orders on WhatsApp | | |
| Billing — consultation fee plus medicines, printed | | |
| Patient WhatsApp: booking, token, prescription, bill | | |
| Live clinic status page | | |
| Schedule H1 register, daily sales, stock valuation reports | | |
| A record of every change, showing who made it and when | | |

Anything in the middle column is quoted separately once the first version is
live and running well.

---

## 3. The consulting room and the pharmacy

The part you cared about most, so it is built first after the foundations.

```
   Your room                                 Pharmacy counter
   ─────────                                 ────────────────
   you sign the prescription  ──────────►    it is on their screen instantly
                                             stock and expiry checked live
                                             the oldest-expiring batch is used
                                             short of something? ──────┐
      ◄──────────────────────────────────────────────────────────────┘
   "Counter: Amoxicillin 500 out of stock."
   you substitute or approve — one tap
```

**One extra thing worth knowing about:** while you are writing the
prescription, each medicine shows its own stock beside it — *18 in stock,
expires 03/2027*, or *out of stock, 2 alternatives available*. You stop
prescribing what is not on your own shelf, and the patient stops being sent
elsewhere. It costs almost nothing to add once the stock system is live, and in
practice it is the feature clinics notice first.

**What the counter will refuse to do**, by design:

- dispense against a prescription that does not exist, or was already dispensed
- dispense an expired batch, at all, under any circumstances
- dispense more than is actually on the shelf
- sell a Schedule H1 medicine over the counter without a prescription

And if any one line of a prescription cannot be filled, nothing is deducted
until you decide what to do — a prescription is handed over whole.

---

## 4. Stock, low-stock alerts and supplier orders

### How stock works

Every movement is recorded permanently — goods received, dispensed, sold,
returned, written off at expiry. Nothing is quietly overwritten. If the shelf
and the screen ever disagree, the system can show exactly when they started to,
which is the whole point of keeping stock on a computer.

Two batches of the same medicine with different expiry dates are handled
properly: the earlier-expiring one is always used first, and every sale records
which batch it came from — so if a manufacturer ever recalls a batch, you can
answer the question in seconds.

Alerts you will get:

| Alert | When |
|---|---|
| Low stock | on screen live; one WhatsApp summary each morning |
| Expiring soon | 90 / 60 / 30 days before, so there is still time to return it |
| Expired | blocked from sale immediately, and listed for disposal |

### Supplier orders — a decision for you

You asked for the order to go to the supplier automatically. The system will
prepare it automatically. **My recommendation is that a person taps Send.**
Three reasons:

1. **WhatsApp's rules.** Meta requires the person receiving a business message
   to have agreed to receive them. Suppliers do not fill in consent forms. If
   one of them marks your message as unwanted, WhatsApp can restrict *your
   clinic's number* — the same number your patients use. That is a large risk to
   take for a saved tap.
2. **It is your money.** An order sent without anyone looking at it is a
   purchase commitment. If a reorder level is set slightly wrong in the first
   months, you could pay for ten times the stock you meant to buy.
3. **Pack sizes.** Whether an order should be in strips, boxes or the supplier's
   minimum quantity is a judgement call for the first few months, until the
   system has learnt your buying pattern.

**What you would actually experience:**

> 8:00 am — one WhatsApp message: *"3 orders ready for approval."* You open it,
> glance at the quantities, tap **Send**. About four seconds.

If you would still prefer it fully automatic, two safer ways to do it:

| Option | What it means |
|---|---|
| **Second WhatsApp number** for supplier orders only | A problem with a supplier can never affect the number your patients use. About ₹200/month. Worth doing regardless |
| **Send from your own phone** | The system writes the order and opens WhatsApp on your phone with the message ready. You press send. No cost, no rules to worry about, and it is how most clinics order today |

Whichever you choose, please tell me before the build starts — it changes how
the system is put together.

---

## 5. Your patients, and whether you are in

### The availability problem

You suggested that being logged in should mean you are in the clinic. That is
the right idea, but on its own it goes wrong in ordinary ways: you close the
laptop and go home without logging out, or you log in from home on a Sunday to
check something. A patient who is told you are there and finds the clinic locked
will not blame the software.

So it works like this:

| | |
|---|---|
| Your device checks in every 30 seconds | if it stops, you are marked away within 5 minutes |
| Only devices registered as *clinic devices* can show you as in | logging in from home changes nothing |
| You can set it yourself | In clinic · With a patient · Back by 4:30 · Done for the day |
| It closes itself at your closing time | regardless of whether you logged out |
| One "leaving now" button | on your computer and on your phone |

And the wording patients see is **"Dr [name] is in the clinic — as of 2 minutes
ago"**, never a flat "available". A reading that might be a few minutes old
should never read as a promise.

### What patients can do

| | |
|---|---|
| On WhatsApp | Book an appointment · check my token · my prescription · my bill · is the doctor in? |
| On a link — no app to install | Live clinic status, their token and how many are ahead, prescriptions, bills, past visits |

**Medication reminders** are included, with one decision attached. Sending a
patient a reminder for every single dose means about 15 WhatsApp messages per
prescription, and WhatsApp charges per message — roughly ₹2,200 a month at 40
prescriptions a day. **One "today's medicines" message each morning** does
almost the same job for around ₹150 a month. That is the default, patients can
opt out, and you can switch the whole feature off if you would rather.

**What patients will never see:** your clinical notes and examination findings.
Those are written by you, for you, in shorthand. Patients see their diagnosis,
your advice, the follow-up date, the prescription and the bill — and nothing
else. This is enforced in the software itself, not left to care.

A forwarded link is also handled: a link shared with someone else shows only
that an appointment exists. Opening a prescription or a past visit asks for the
patient's date of birth once on each device.

---

## 6. How long it takes

**10 to 12 weeks from signing to going live.** Roughly nine weeks of building,
and the rest is waiting on things outside anyone's control.

| Stage | |
|---|---|
| Foundations, security, records | week 1–2 |
| Consultation, prescriptions, printing | week 2–3 |
| **Consulting room ↔ pharmacy link** | week 3–4 |
| Stock, batches, expiry, receiving goods | week 4–6 |
| Billing | week 6 |
| Supplier orders on WhatsApp | week 6–7 |
| Clinic status and presence | week 7 |
| Patient WhatsApp and the patient link | week 7–9 |
| Registers and reports | week 9 |
| Testing, backups, training | week 9–10 |
| **Running alongside your paper records** | 2 weeks |
| Go live | week 12 |

Two things start on day one, before any software is written, because they take
the longest and nothing waits for them:

- **WhatsApp business verification with Meta** — anywhere from 3 days to 3
  weeks, and not predictable. It has to be in your clinic's name.
- **Your medicine list** — see §7. This is usually the slowest item.

---

## 7. What you need to provide

Nothing here is unusual, but the build genuinely cannot finish without it.

| Item | Notes |
|---|---|
| **List of medicines you stock** — name, strength, pack size, MRP, usual supplier | The biggest single item. Usually taken from your purchase invoices. Allow a week or two, or I can type it up for you as a separate quoted task |
| **Supplier list** with WhatsApp numbers | |
| **A physical stock count** on one day, clinic closed | Everything after this depends on the opening numbers being right |
| **Documents for Meta verification** — GST certificate or registration, address proof | Start day one |
| **A privacy policy published on your website** | Meta has required this since January 2026 before any automated message can be sent. I draft it, you approve and publish |
| **A new SIM** for WhatsApp | It cannot be a number already on WhatsApp or WhatsApp Business |
| **A 4G backup on your internet router** | ~₹300/month. So a broadband failure never stops a consultation |
| **Drug licence and pharmacist details** | Needed for the Schedule H1 register |
| **Your clinical sign-off** | See §8 |
| **One person available for training** | Whoever will run the counter |

---

## 8. Safety, privacy and the law

### What the software will not do

This is deliberate, and I will not build it in later without a serious
conversation first:

- It will never **suggest a diagnosis**. Software that proposes a diagnosis from
  symptoms falls under medical-device regulation and carries clinical liability.
  The system records what you decide; it never decides.
- It will never **invent a dose or a schedule**. A reminder repeats only a
  schedule you ticked yourself. A medicine you did not schedule stays silent.
- It will never mark a value as high or low. Ranges are shown exactly as
  printed; nothing is compared or interpreted.
- **Drug interaction checking is not included.** Doing it properly means
  licensing a clinical drug database with an annual fee. If you want it, it is a
  separate decision with a separate cost.

### Your sign-off

Because the software prints prescriptions in your name, **you review and approve
in writing**: the medicine list, the dose timings (what "morning / afternoon /
night" mean in hours), the fields on the consultation form, and the layout of
the printed prescription. Nothing clinical goes live without that.

### Patient data

| | |
|---|---|
| Where it is stored | Servers in Mumbai, India |
| Who can see it | You and your staff. No third party, no advertiser, no other clinic |
| Consent | Recorded when a patient registers and again when they agree to WhatsApp messages. They can opt out any time |
| Deletion and correction | A patient can ask for their data; there is a screen to export or remove it, within what the law requires you to retain |
| A written agreement | A data processing agreement between you and me, signed before a single real patient record is entered |

### Registers

The Schedule H1 register is generated from your actual sales — date, patient
name and address, medicine, quantity, prescriber — and exports for any date
range, in a form an inspector can be handed. Purchase records, batch
traceability and expiry write-offs are all kept.

---

## 9. How we make sure it works

You said there should be no room for error. That is the right standard, and here
is what it means in practice:

| | |
|---|---|
| **Nothing half-happens** | Every sale, dispense and goods receipt either completes fully or does not happen at all. A partial record is impossible |
| **Everything is traceable** | Every change records who made it, when, and what it was before |
| **Automatic testing** | The system is re-tested automatically on every change, including every one of the refusals listed in §3 |
| **A practice copy** | A complete second copy of the system, with your real medicine list and imaginary patients. Every change goes there first |
| **Backups** | Daily, stored separately — and a full restore is *performed and proven* before go-live, not just configured. Repeated every three months |
| **Nightly stock check** | The system reconciles itself every night and alerts me if any number has drifted |
| **Monitoring** | I am alerted if anything breaks, whether or not anyone tells me |
| **Two weeks running alongside paper** | Non-negotiable. It is the only reliable way to find the things about how your clinic actually works that neither of us thought to mention |

**Going live:**

1. Medicine list, suppliers and opening stock loaded — one day, clinic closed
2. Week 1 — pharmacy only. You keep writing on paper, but every sale is entered
   and the stock is checked against the shelf each night
3. Week 2 — the full system, still with your prescription pad as backup
4. Patient WhatsApp switched on for about 20 regular patients first, not everyone
5. Full switch-over. I am present in the clinic on the first day and reachable on
   the second
6. 30 days of warranty support, then an ongoing support arrangement

---

## 10. Costs

### Building it

**₹[ to be filled in ]**, payable as:

| | |
|---|---|
| 40% | on signing |
| 30% | when the consulting-room ↔ pharmacy link is working on your real stock — you will see it before you pay this |
| 30% | on go-live acceptance |

Followed by 30 days of warranty support at no charge, then an optional monthly
support arrangement covering hosting oversight, backups, WhatsApp template
changes and support hours.

### Running it, monthly

These are paid by you directly to the service providers, in your own name, so
you own every account. Rounded figures; confirmed exactly at signing.

| | ₹/month |
|---|---|
| Database and hosting | ~2,100 |
| Application hosting | ~1,700 |
| Domain name | ~100 |
| WhatsApp messages | 300–800 |
| 4G backup on the router | ~300 |
| Second WhatsApp number for suppliers (recommended) | ~200 |
| **Total** | **~4,700–5,200** |

WhatsApp charges per message and the rates are set by Meta, not by me. The
figure above assumes the once-daily reminder design in §5; per-dose reminders
would push it to roughly ₹2,900.

A cheaper hosting option exists at around ₹1,200/month, but it has a worse
recovery story if something fails. For a clinic running its pharmacy on this, I
do not recommend it.

---

## 11. What I need to know from you

The build cannot be finalised until these are answered.

| | Question | Why it matters |
|---|---|---|
| 1 | Do you hold a retail drug licence, and is a registered pharmacist on record? | Decides whether the pharmacy can sell over the counter, or whether the system only tracks what you dispense to your own patients |
| 2 | Will anyone besides you be at the counter? | Decides whether this is two screens or one |
| 3 | Does the pharmacy serve walk-ins without a prescription? | Adds the counter-sale module |
| 4 | Are you GST registered? What must the bill show? | Bill layout and tax |
| 5 | Supplier orders — one-tap approval, or fully automatic? (§4) | Please read §4 before answering |
| 6 | How many suppliers, and are they all reachable on WhatsApp? | |
| 7 | Roughly how many patients a day? How many have a smartphone with data? | Decides how much the WhatsApp message must carry on its own |
| 8 | Any existing software, and is there data in it to bring across? | Could add time |
| 9 | What printer — A5, thermal, or your existing letterhead? | Printed prescriptions and bills |
| 10 | Clinic hours, weekly off, and how you handle out-of-hours calls | Sets when the status closes itself |
| 11 | Are you comfortable with patients seeing their diagnosis in writing? | Some doctors prefer advice only. Either is a setting |
| 12 | Anything you do daily that I have not mentioned anywhere above? | The most useful question on this list |

---

## 12. Agreement

```
Scope in §2 agreed as written                        [ ]   date ________
Questions in §11 answered                            [ ]   date ________
Supplier order method chosen (§4)                    [ ]   date ________
Items in §7 to be provided, and by when              [ ]   date ________
Price, milestones and monthly costs accepted         [ ]   date ________
Data processing agreement signed                     [ ]   date ________
Clinical sign-off process agreed (§8)                [ ]   date ________


Client ______________________     Developer ______________________

Date   ______________________     Date      ______________________
```

Anything not listed in §2 is a written change request, quoted separately and
scheduled after go-live — so that the first version reaches your clinic on time.
