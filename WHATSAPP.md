# WhatsApp — what is actually allowed, and where the grey is

Internal reference. Decides §10 of `PLAN.md` and §4 of `PROPOSAL.md`.

**"Grey area" is not one thing.** It is six unrelated ambiguities that get
lumped together, and they carry very different risk. Three are survivable design
constraints, two are traps, one is not grey at all — it is simply against the
rules and sold as though it were not.

> Policy dates below verified Aug 2026. Meta changed this twice in 2026 alone.
> **Re-verify against Meta's own docs before signing anything**, not against a
> vendor's blog — every vendor writing about this is selling something.

---

## 1. First, the thing that is not grey

There are two entirely different products both marketed as "WhatsApp API".

| | Official | Unofficial |
|---|---|---|
| Name | WhatsApp Business Platform (Cloud API) | Baileys, whatsapp-web.js, WAHA, Evolution API, venom, wppconnect |
| How it works | Meta-run endpoint you are granted access to | Reverse-engineers the WhatsApp protocol, or drives WhatsApp Web with a headless browser, posing as a linked device |
| Setup | Business verification, dedicated number, display-name approval, privacy policy URL, template approval | **Scan a QR code** |
| Cost | per message | server rent only — effectively free |
| Templates | mandatory for business-initiated | none, send any text |
| Legality | permitted | **violates WhatsApp's Terms of Service** |
| Failure mode | a template gets rejected | **the number is banned, permanently, without warning, and appeals rarely succeed** |

This is the ecosystem most Indian clinic/shop software runs on, because it is
free and there is no paperwork. It is not a grey area — the ToS prohibits it
plainly. It *feels* grey because enforcement is probabilistic, so plenty of
people run it for a year and conclude it is fine.

**How detection works now (2026):** device fingerprinting, behavioural analysis
of send patterns, content pattern matching, user reports — and, added in 2026,
**counting messages that receive no reply**. It is automated. It does not wait
for anyone to complain.

That last mechanism matters enormously here. Dose reminders and supplier orders
are precisely the messages nobody replies to. A clinic on an unofficial library
sending 400 unanswered reminders a day is generating the exact signal the
detector looks for.

Vendor-published figures put ban rates high — one Indian vendor claims 68% of
SMBs using unofficial tooling saw a ban within 12 months, and a typical
reverse-engineered setup surviving 2–8 weeks. **Treat those numbers as
directional advertising, not data** — every source publishing them sells the
official alternative. The mechanism is real regardless of whether the percentage
is.

### Why this is disqualifying for this client specifically

Not on principle — on consequences:

| | |
|---|---|
| A ban takes the clinic's number, permanently | patients lose the channel, chat history, and the number printed on his card and board |
| It is his business number, not ours | the loss is his; the decision was ours; the liability conversation is ours |
| It fails silently and totally | not degraded service — zero service, mid-week, no notice |
| It cannot be insured, contracted around, or appealed | there is no support line that reverses it |
| Health data through a reverse-engineered client | a DPDP question with no good answer |

A doctor's clinic number is not a thing you gamble to save ₹500 a month.

### How to spot an unofficial vendor pitching you

He will be approached by these. The tells, in order of reliability:

| Tell | Why it gives them away |
|---|---|
| **"Just scan a QR code to connect"** | The official API never uses QR pairing. This alone is conclusive |
| "Works with your existing WhatsApp number" | Official requires a dedicated number, not on the WhatsApp or Business app |
| "No template approval needed" | Templates are mandatory for business-initiated messages. Always |
| "Unlimited messages, ₹999/month" | Meta charges per message. Nobody resells unlimited at a flat fee |
| No Meta business verification step | Mandatory since Jan 2026, no exceptions |
| "Free — no per-message cost" | See above |

Some Indian BSPs sell *both* official and unofficial products from the same
website, in similar language, and the buyer cannot tell which they bought. Ask
for the WABA ID and the Meta Business Manager account. If there isn't one, it is
unofficial.

---

## 2. Grey area one: opt-in is required but never verified

The genuine ambiguity, and the one that governs the supplier feature.

Meta's rule: you may only message someone who gave you their number **and**
opted in, where a compliant opt-in must show:

- the **exact business name** the person will receive messages from
- **explicitly that it is WhatsApp** they will be contacted on
- **what kind of messages** they are agreeing to receive

Meta does not check any of this. There is no opt-in registry, no API to query,
no proof uploaded. The business self-attests. Nothing technically prevents a
send to a number that never consented.

**So the written rule is far stricter than the enforced rule, and the enforced
rule is: do not get reported.** That gap is the grey area. It means:

| Situation | Written rule | What actually happens |
|---|---|---|
| Patient ticks a consent box at registration naming the clinic and WhatsApp | compliant | fine |
| Patient's number taken from an old paper register | not compliant | usually nothing — until someone reports it |
| Supplier's number off a business card | **not compliant** | fine until the day it isn't |
| Bought list | not compliant | number dies quickly |

Meta tightened this in 2026 with opt-in proof requirements and **lower
spam-report thresholds** — fewer reports now trigger a quality downgrade than a
year ago. The gap between written and enforced is narrowing, and it is narrowing
in the direction that hurts.

**Design consequence:** opt-in is enforced in our send function, not in the UI.
No `opt_in_at` on the contact row, no send, no exceptions, no override flag for
staff. If it is possible to bypass in a hurry, one day it will be.

---

## 3. Grey area two: Meta decides your template's category, and can change its mind

Templates are classified **utility**, **authentication**, **marketing** or
**service**. Marketing costs roughly six times utility in India.

You propose a category. **Meta classifies it, and reclassifies it later if it
decides the content has promotional intent.** Your per-message cost can multiply
without you changing a line.

The line is genuinely fuzzy:

| Message | Category | Why |
|---|---|---|
| "Your prescription is ready. [View]" | utility | transaction the user initiated |
| "Your bill for 12 Aug — ₹450. [View]" | utility | same |
| "Today's medicines: 3 doses. [View]" | utility | follows from a transaction |
| "Dr Rao is now in the clinic." | **probably marketing** | re-engagement — nothing the patient asked for, sent to bring them in |
| "Your prescription is ready. Ask about our health check package!" | marketing | one clause moved the whole message |

The fourth row is exactly what the client wants — telling patients the doctor
has arrived. It reads informational to him and re-engagement to Meta's
classifier. Sent to a whole patient list, it is also the single most reportable
message in the build: most recipients did not want it today.

**This is the strongest argument for pull-not-push on presence** (`PLAN.md`
§13.3), and it is a cost and survival argument, not a UX preference. A status
link costs nothing, is never miscategorised, and cannot be reported.

**Design consequence:** every template is drafted to be defensibly utility, with
no promotional clause anywhere near it. Template category changes are a monitored
event — if Meta reclassifies one, the bill moves and we need to know that week.

---

## 4. Grey area three: the 24-hour window, and gaming it

When a user messages the business, a 24-hour window opens in which free-form
replies are free and unrestricted. Outside it, templates only.

This is clean and legitimate — and it is why the **patient booking conversation
costs nothing**. The patient starts it, so the entire back-and-forth is inside
the window.

The grey part is the industry habit of keeping windows open artificially
("reply 1 to continue receiving updates"). Meta discourages it; it is hard to
police. **We do not do it** — it trains patients to ignore the channel, and it
is exactly the pattern that generates unanswered-message signals.

**Design consequence:** anything triggered by the patient is free. Anything we
initiate costs money and carries risk. That asymmetry should shape the whole
patient design — pull where possible, push only where the patient would
genuinely want the interruption.

---

## 5. Grey area four: healthcare sits next to a prohibited category

WhatsApp's Business Messaging Policy carries a prohibited and restricted goods
list. **Prescription drugs are on it.** Medical *services* are permitted;
selling or promoting prescription drugs is not.

A clinic pharmacy sits close to that line. Where it goes wrong:

| Safe | Not safe |
|---|---|
| "Your prescription is ready. [View]" | "Your Amoxicillin 500mg is ready for collection" |
| "Your order from the pharmacy is ready." | listing medicines and prices in the message body |
| A link to a page listing the medicines | a catalogue of prescription medicines attached to the WhatsApp business profile |
| "Today's medicines. [View]" | "Time for your Alprazolam" |

The rule already in the build — **a message carries the fact that something
exists plus a link, never the record itself** — was originally a cost and
privacy rule. It turns out to also be what keeps the pharmacy clear of the
restricted-goods line. Three reasons for one rule; it is not negotiable.

The dose-reminder template needs care: naming the drug in the message body is
both a privacy leak into a forwardable chat log and a step towards the line.
Reminder text says *"today's medicines"* and links out.

---

## 6. Grey area five: Cloud API messages are not end-to-end encrypted

Most people, including most vendors, get this wrong.

Consumer WhatsApp chats are end-to-end encrypted. **With Cloud API, Meta hosts
the business endpoint, so business messages are decrypted on Meta's
infrastructure.** Meta processes the content of every message the clinic sends
and receives.

For a clinic this is a real consideration, not a technicality:

| | |
|---|---|
| Under DPDP | Meta is a processor in the chain. The clinic's privacy policy must say so — and a privacy policy URL is mandatory for the account anyway since Jan 2026 |
| What that means practically | anything in a message body is data the clinic has shared with Meta |
| Which is why | the message carries no clinical content, only a link to a page we host in Mumbai. The record never enters Meta's systems |

Same rule as §5, arriving from a third direction.

---

## 7. Grey area six (India): which regulator, and DLT confusion

| | |
|---|---|
| **TRAI DLT registration** — header and template registration for SMS and voice | **Does not apply to WhatsApp.** Vendors sometimes claim it does, or charge for it. WhatsApp is governed by Meta's policy |
| **DPDP Act 2023** | Applies fully. Consent, purpose limitation, erasure, breach notification. Rules and the consent-manager framework have been phasing in — check current status before drafting the DPA |
| **OTT messaging under TRAI** | Has been discussed repeatedly. If it lands, WhatsApp business messaging gains an Indian regulator on top of Meta's policy. Worth watching, not worth planning for |

---

## 8. Every message in this build, classified

The practical output of all of the above.

| Message | Initiated by | Category | Opt-in | Risk | Cost |
|---|---|---|---|---|---|
| Booking conversation | patient | service (in window) | inherent — they messaged us | none | **free** |
| Token / queue query | patient | service | inherent | none | **free** |
| "Is the doctor in?" | patient | service | inherent | none | **free** |
| Appointment confirmed | us | utility | registration consent | low | per msg |
| Prescription ready | us | utility | registration consent | low | per msg |
| Bill ready | us | utility | registration consent | low | per msg |
| Daily dose digest | us | utility | **per-prescription opt-in** | low–medium — unanswered by design | per msg |
| Clinic closed today | us | utility | registration consent | low — genuinely wanted | per msg |
| **"Doctor has arrived"** | us | **likely marketing** | would need marketing consent | **high — reportable, 6× cost** | **not built** |
| Low-stock digest to staff | us | utility | employer, trivially consented | none | per msg |
| **Purchase order to supplier** | us | utility | **absent** | **highest in the build** | per msg |

The two red rows are the two things the client asked for most enthusiastically.
Both have safe replacements that give him what he actually wants:

- **"Doctor has arrived"** → the `/now` status link. Always current, free, never
  miscategorised, printable as a QR on the clinic door.
- **Unattended supplier orders** → drafted automatically, sent on one tap, from a
  second number.

---

## 9. The supplier problem, in full

The greyest thing in the build, so it gets stated plainly.

**The facts:**

1. The supplier has not opted in, and will not. There is no form he will sign.
2. Meta's written rule prohibits the send. Meta's enforcement will not notice —
   until the supplier taps "report".
3. Suppliers get automated order messages from many customers. Annoyance is
   cumulative and the reporting threshold dropped in 2026.
4. If it lands on the clinic's main number, **the patients lose the channel**.
5. The message contains a list of prescription medicines — §5 territory.

**The ladder, safest first:**

| Option | Policy risk | Cost | Feels automatic? |
|---|---|---|---|
| **Deep link — app composes, he sends from his own phone** | **none** | ₹0 | mostly |
| **Second number, one-tap approval** | low | ~₹200/mo + verification | yes |
| Second number, unattended send | medium | same | fully |
| Main number, one-tap | medium — patients exposed | ₹0 | yes |
| Main number, unattended | **high — do not** | ₹0 | fully |

**Recommendation: row 2**, with row 1 as the fallback if Meta verification for a
second number stalls. Row 1 is genuinely fine — it is how small clinics already
order, it costs nothing, and the automation he is paying for (knowing *what* to
order, and when) is entirely intact. The only thing he loses is the send itself.

Get a supplier's consent in writing where one is willing — a WhatsApp reply
saying "yes, send orders here" is a record, and it is more than most businesses
have.

**If he chooses unattended anyway**, it goes behind all five of: a per-supplier
flag, a written consent record per supplier, a rupee cap per order, a daily
order cap, and a 30-minute cancel window — plus the second number, which stops
being optional. And his choice goes in the contract in writing.

---

## 10. Rules this produces for the build

| # | Rule |
|---|---|
| 1 | **Official Cloud API only.** No unofficial library, no QR-pairing vendor, at any price, ever |
| 2 | **No opt-in row, no send.** Enforced in the send function. No staff override |
| 3 | **A message carries the fact and a link, never the record.** Cost, privacy, Meta's restricted-goods list — three reasons, one rule |
| 4 | **Every template must be defensibly utility.** No promotional clause anywhere near a transactional message |
| 5 | **Pull beats push.** If a link can answer it, do not spend a message and a reputation point on it |
| 6 | **Patient-initiated is free.** Design the patient flow to start with the patient wherever possible |
| 7 | **Supplier traffic never shares the patient number** |
| 8 | **Every send is a row before it is a send**, with an idempotency key, so a webhook retry cannot double-order |
| 9 | **Monitor the quality rating** in Business Manager. A drop is an incident, not a statistic |
| 10 | **Re-verify this document before the contract is signed.** Meta changed policy twice in 2026 |

---

## 11. What changed in 2026 (verify before quoting)

| Change | Effect here |
|---|---|
| Business verification **and a privacy policy URL** mandatory before any template send (Jan 2026) | Adds a client deliverable — the clinic needs a published privacy policy. That is now on the §7 list in the proposal |
| Opt-in proof requirements tightened | Consent capture at registration must be timestamped and stored, not assumed |
| Spam-report thresholds lowered | Fewer reports needed to damage the number. Raises the supplier risk |
| Unanswered-message counting added to detection | Reminder-heavy and order-heavy patterns look worse than they used to |
| Marketing-template review stricter | Reinforces keeping every template utility |

---

## Sources

Vendor documentation and analysis, cross-read; Meta's own policy pages are the
only authority and should be checked directly before the contract is signed.

- [Infobip — WhatsApp template compliance](https://www.infobip.com/docs/whatsapp/compliance/template-compliance)
- [Infobip — collecting WhatsApp opt-ins](https://www.infobip.com/blog/how-to-collect-whatsapp-business-opt-ins)
- [WhatsApp Business Policy (official)](https://whatsappbusiness.com/policy/)
- [Allync — compliance guide 2026](https://www.allyncai.com/blog/whatsapp-business-api-compliance-guide)
- [WeTarSeel — opt-in rules 2026](https://wetarseel.ai/whatsapp-business-api-opt-in-rules/)
- [Cloud API vs unofficial libraries](https://whatsapp.checkleaked.cc/blog/whatsapp-cloud-api-vs-unofficial)
- [Kraya AI — ban risk, India (vendor-published figures)](https://blog.kraya-ai.com/whatsapp-automation-ban-risk)
- [SporeSec — unofficial API ban risk](https://sporesec.com/en/blog/whatsapp-unofficial-api-ban-risk)
