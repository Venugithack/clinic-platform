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
| "low stock notification" | A live list on the screen the counter is already looking at, with what has run low at the top of the ordering screen. Not a WhatsApp message — see the note under §4 |
| "auto message send to supplier in whatsapp" | The system prepares the order by itself, grouped per supplier. You look at it and tap **Send**, and it goes from your own WhatsApp. See §4 |
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
| Low stock | on screen, live |
| Expiring soon | on screen, from 90 days out — and sooner when your supplier's return deadline falls first, so there is still time to send it back |
| Expired | blocked from sale immediately, and listed for disposal |

### The stock system, in more detail

Since you want this to be the strongest part of the build, here is what that
means in practice:

| | |
|---|---|
| **Boxes, strips and loose tablets** | You buy a box of 10 strips and sell 6 tablets. The system understands all three, converts between them, and shows "19 strips + 9 loose" rather than a number nobody can act on |
| **Scan the strip** | The tablet's camera reads the barcode. Receiving goods, selling, stock-taking — all by scanning instead of typing. At dispensing it checks what was picked off the shelf against what was prescribed, and stops the wrong box before it reaches the patient |
| **What your shelf is worth** | Stock valuation on any date, and what you actually made on each sale. Ready for your accountant on 31 March |
| **Stock-take that finds mistakes** | The counted figure is entered without showing the expected one first — otherwise people confirm the number on the screen instead of counting the shelf. Differences are listed by rupee value, and you approve before anything changes |
| **Expiry returns tracked to the credit note** | Each supplier's return window is recorded, and the expiring list is ordered by whose window closes first — so stock goes back while it still can, and the credit is chased until it appears on an invoice |
| **Substitution that knows the salt** | When something is out of stock, the alternatives shown are the same salt at the same strength — with price differences — and you approve the swap from your screen. It never substitutes on its own |
| **Ordering that learns** | How fast each supplier actually delivers, measured from your own order history rather than what they promise. Purchase orders show what you paid last time, and to whom |

### Supplier orders — decided 16 August 2026

You asked for the order to go to the supplier automatically. The system prepares
it automatically. **A person taps Send.** Three reasons:

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

> You open the orders screen. What has run low is already there, grouped into one
> order per supplier. You glance at the quantities and tap **Send**. WhatsApp
> opens on your phone with the order written and the supplier chosen. You press
> send. About four seconds.

**This is what has been built.** The order leaves from your own WhatsApp rather
than from a business account, which is why it costs nothing per message and needs
no approval from Meta. It also removes reason 1 above entirely: there is no
business number that can be restricted.

A second WhatsApp number, for supplier orders only, is still worth having if you
ever want the clinic's number kept clear of supplier traffic — about ₹200/month.
Nothing in this build depends on it.

---

## 5. Your patients, and whether you are in

### The availability problem

You suggested that being logged in should mean you are in the clinic. That is
the right idea, but on its own it goes wrong in ordinary ways: you leave the
tablet on the desk and go home without logging out, or you log in from home on
a Sunday to check something. A patient who is told you are there and finds the
clinic locked will not blame the software.

So it works like this:

| | |
|---|---|
| Your device checks in every 30 seconds | if it stops, you are marked away within 5 minutes |
| Only devices registered as *clinic devices* can show you as in | logging in from home changes nothing |
| You can set it yourself | In clinic · With a patient · Back by 4:30 · Done for the day |
| It closes itself at your closing time | regardless of whether you logged out |
| One "leaving now" button | one tap on your tablet on the way out — or from your phone once you have already left |

And the wording patients see is **"Dr [name] is in the clinic — as of 2 minutes
ago"**, never a flat "available". A reading that might be a few minutes old
should never read as a promise.

### What patients can do

| | |
|---|---|
| On WhatsApp | Book an appointment · check my token · my prescription · my bill · is the doctor in? |
| On a link — no app to install | Live clinic status, their token and how many are ahead, prescriptions, bills, past visits |

**How the WhatsApp side works, and why it costs almost nothing.** Your clinic's
WhatsApp answers patients rather than chasing them. A patient messages first —
usually by scanning a QR code on your door or on their appointment card, which
opens the chat with the message already typed — and the system replies with
simple buttons: *book an appointment · my token · my prescription · my bill · is
the doctor in?*

The useful part: once a patient has messaged you, WhatsApp lets you reply freely
for the next 24 hours **at no charge**. So one scan on arrival covers the whole
visit — you're next but one, your prescription is ready, your bill is ₹340 — all
of it free, none of it needing WhatsApp's approval in advance.

This is not a compromise to save money. It is also the safest design: you never
message anyone who did not ask, so your clinic's number cannot be reported as
spam, and that is the one thing that could take the whole channel away from you.

**One button always reaches a person.** A menu that cannot answer *"my child has
a fever, can I come now?"* would be worse than no system at all, so there is
always a *talk to the clinic* option, and your staff see it on their screen.

**Medication reminders** are the one thing this design cannot do for free — a
reminder the next morning falls outside that 24-hour window, and WhatsApp
charges for those. My suggestion is to **leave them out at first**, run the
clinic for a month, and add them only if you find you miss them. They would cost
roughly ₹150 a month as a single daily "today's medicines" message. Reminding
per dose would be about ₹2,200 a month, and I would not recommend it.

**What patients will never see:** your clinical notes and examination findings.
Those are written by you, for you, in shorthand. Patients see their diagnosis,
your advice, the follow-up date, the prescription and the bill — and nothing
else. This is enforced in the software itself, not left to care.

A forwarded link is also handled: a link shared with someone else shows only
that an appointment exists. Opening a prescription or a past visit asks for the
patient's date of birth once on each device.

---

## 6. How long it takes

**14 to 16 weeks from signing to going live.** Roughly fourteen weeks of
building, and the rest is waiting on things outside anyone's control.

This is longer than the ten to twelve weeks I first estimated, and the reason is
your own answers: the stock system you asked to be the centrepiece is
substantially deeper than a basic one (§4), and building for tablets rather than
computers is its own piece of work. Both are worth the time. Neither is padding.

| Stage | |
|---|---|
| Foundations, security, records | week 1–2 |
| Consultation, prescriptions, printing, tablet layout | week 2–4 |
| **Consulting room ↔ pharmacy link** | week 4–5 |
| Stock, batches, expiry, receiving goods, barcode scanning | week 5–9 |
| Billing, counter sale, cash day-close | week 9–10 |
| Supplier orders on WhatsApp | week 10–11 |
| Clinic status and presence | week 11 |
| Patient WhatsApp and the patient link | week 11–13 |
| Registers and reports | week 13 |
| Testing, backups, training, printing on your hardware | week 13–14 |
| **Running alongside your paper records** | 2 weeks |
| Go live | week 16 |

Three things start on day one, before any software is written, because they take
the longest and nothing waits for them:

- **WhatsApp business verification with Meta** — anywhere from 3 days to 3
  weeks, and not predictable. It has to be in your clinic's name.
- **Your medicine list** — see §7. This is usually the slowest item.
- **Ordering the tablets**, and checking your printer — see §10.

---

## 7. What you need to provide

Nothing here is unusual, but the build genuinely cannot finish without it.

| Item | Notes |
|---|---|
| **List of medicines you stock** — name, **salt composition**, strength, pack size, MRP, usual supplier | The biggest single item. Usually taken from your purchase invoices — your last six months of invoices *are* your real list, roughly 300–500 medicines, not the tens of thousands in a national database. Allow a week or two, or I can type it up for you as a separate quoted task. The salt is what makes the out-of-stock alternatives in §4 work |
| **Supplier list** with WhatsApp numbers **and return windows** | How many months before expiry each one accepts returns. This is what turns expiring stock back into money |
| **2 tablets and stands**, and a Bluetooth keyboard for the counter | ~₹35,000–45,000. See §10 |
| **A printer that connects over Wi-Fi or network** — not USB only | Please send me the model number of your current A4 printer. See §10 |
| **A physical stock count** on one day, clinic closed | Everything after this depends on the opening numbers being right |
| **Documents for Meta verification** — address proof, and your GST registration certificate if you hold one | Start day one, and tell me **which of the two you have**. Setting GST billing aside (§11, Q4) is not the same as not being registered. If you are registered, this is the quick path. If you are not, Meta wants your drug licence, clinic registration and a utility bill instead, and that route is slower — which is why I need the answer in week one rather than week six |
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
| **Backups** | Hourly, stored separately — and a full restore is *performed and proven* before go-live, not just configured. Repeated every three months |
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
| Database and hosting | **0** |
| Application hosting | **0** |
| Backups and monitoring | **0** |
| Domain name | ~70 |
| WhatsApp — patients | **0** — see §5 |
| WhatsApp — supplier orders | **0** — sent from your own WhatsApp |
| WhatsApp — "clinic closed today" notices | ~20 |
| 4G backup on the router | ~300 |
| **Total** | **~390** |

**Hosting costs you nothing.** The services this runs on have free plans that
are genuinely production-grade at the size of one clinic, and they stay free —
this is not a trial period that expires. Your database sits in Mumbai either
way, which is what the privacy law requires.

WhatsApp charges per message and the rates are set by Meta, not by me. **The
~₹390 above carries no medicine reminders at all** — §5 recommends going live
without them and adding them once you have seen the system in use. If you want
them later, the two designs cost:

| Reminder design | Added per month | New total |
|---|---|---|
| One message a day, listing that day's doses | ~₹150 | **~₹540** |
| One message per dose | ~₹2,200 | **~₹2,590** |

**What free hosting means in practice, honestly.** Two things are different from
a paid plan, and you should decide with both in front of you:

- If one of these services has an outage, there is no support line to escalate
  to. We wait. Your clinic falls back to paper for the duration, and the system
  backfills afterwards — the same plan as an internet failure.
- Your data is backed up **every hour** and a restore is tested every week. On a
  paid plan the recovery point would be five minutes instead of an hour. In the
  worst imaginable case — total loss — you would re-enter up to one hour of
  consultations and sales from that day's paper.

If either is uncomfortable, **₹2,100/month** upgrades the database half alone
and brings five-minute recovery and a support agreement with it. Hosting stays
free either way. My recommendation: **start free.** Moving to paid later is a
setting, not a rebuild, and you can make that call after six months of seeing
how it actually runs.

### One-time equipment

| | ₹ |
|---|---|
| 2 tablets (10–11") with tilting stands | ~35,000–45,000 |
| A Bluetooth keyboard for the counter | ~1,500 |
| Possibly a Wi-Fi adapter for your printer, or a network-capable printer | ~2,000, or the cost of the printer |

**One thing to check this week:** a tablet cannot print to a printer connected
by USB cable — there is no way around this. If your A4 printer is USB-only it
needs a small Wi-Fi adapter, or replacing. Please send me its model number. When
you buy the small receipt printer later, it must be a **Wi-Fi or network** model,
not USB-only.

---

## 11. What I need to know from you

**Answered on 16 August 2026.** Recorded here so we are both working from the
same page.

| | Question | Your answer | What it settles |
|---|---|---|---|
| 1 | Retail drug licence and pharmacist? | Yes, both. The pharmacy sells over-the-counter medicines too, and bills from the pharmacist's window | The full pharmacy is in — counter sales, Schedule H1, the lot |
| 2 | Anyone besides you at the counter? | Two screens — you in your cabin, the pharmacist at the counter | The live link between the two rooms is the centre of the build, as you wanted |
| 3 | Walk-ins without a prescription? | Yes, add the counter-sale monitor | Counter sale, a till, and a cash count at day-end |
| 4 | GST? | Set aside for now, plan it later | The system records cost, MRP and HSN from day one anyway, so switching GST on later is a settings change — not a rebuild. Nothing is lost by deferring |
| 5 | Supplier orders? | One-tap approval | The safe option, and the one I recommended. Six details still to settle — see below |
| 6 | Suppliers on WhatsApp? | Any number of them, all on WhatsApp | You can add suppliers yourself, without limit |
| 7 | Patients per day? | Varies | Doesn't hold anything up. Worth a rough number before we build the patient side |
| 8 | Existing software to move across? | No | Nothing to migrate, which saves time. It also means the medicine list is typed from scratch — §7 |
| 9 | Printer? | A4 now, a small one later | Both supported. Please check the USB point in §10 |
| 10 | Clinic hours and weekly off? | You'll set them once it's ready | They're settings you control, not something fixed in the software |
| 11 | Patients seeing their diagnosis? | Depends | Built as a switch, off by default. You can change your mind any time |
| 12 | Who owns the software? | Thinking about it | Needed before we sign, not before we start |

### Still to settle

| | | When |
|---|---|---|
| **A 30-minute WhatsApp conversation** — six decisions about which number sends what, and to whom | I'll walk you through each one | Before day one, because Meta verification depends on it |
| **Roughly how many patients a day**, and how many use a smartphone | Affects how much the patient side leans on WhatsApp versus the web link | Before week 7 |
| **Who owns the software** | Assignment or a permanent licence to you — both are fine, they just say different things | Before signing |
| **Whether you accept free hosting**, having read §10 | Your call, and worth ~₹4,300 a month. We build locally first, so you make this one with the working system in front of you rather than on paper | Around week 7, once billing works |
| **Anything you do daily that I have not mentioned** | Still the most useful question on this list | Any time |

---

## 12. Agreement

```
Scope in §2 agreed as written                        [ ]   date ________
Questions in §11 answered                            [~]   9 of 12, 16-08-2026
Supplier order method chosen (§4)                    [x]   one-tap, 16-08-2026
WhatsApp conversation held (§11)                     [ ]   date ________
Free hosting and its trade-offs accepted (§10)       [ ]   date ________
Items in §7 to be provided, and by when              [ ]   date ________
Price, milestones and monthly costs accepted         [ ]   date ________
Data processing agreement signed                     [ ]   date ________
Clinical sign-off process agreed (§8)                [ ]   date ________


Client ______________________     Developer ______________________

Date   ______________________     Date      ______________________
```

Anything not listed in §2 is a written change request, quoted separately and
scheduled after go-live — so that the first version reaches your clinic on time.
