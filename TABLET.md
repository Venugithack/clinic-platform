# Tablet-first — the UI/UX brief

Venu's instruction: this runs on tablets. That is not a responsive-design note,
it changes the interaction model. Two tablets, in two rooms, used all day by two
people who are looking at a patient more than at a screen.

| Screen | Where | Who | Posture |
|---|---|---|---|
| **Consult** | doctor's cabin | the doctor | on a stand, arm's length, glanced at between looking at the patient |
| **Counter** | pharmacy window | the pharmacist | on a stand or held, one hand often holding a strip |

---

## 1. Hardware — a client deliverable, and one trap

| Item | Spec | Note |
|---|---|---|
| 2 × tablet | 10–11", Android 13+, ≥4 GB RAM, Chrome | ~₹15–20k each. iPad works; Android is cheaper and Web Bluetooth/camera support is better |
| 2 × stand | tilting, landscape | not a nice-to-have. A tablet flat on a counter is unusable at arm's length |
| 1 × Bluetooth keyboard | at the counter | for drug-master data entry only. Typing 400 drugs on glass is cruel |
| Wi-Fi | reaching both rooms | the app *and* the printers depend on it |

### The printing trap — settle this before go-live

**A tablet can only print to a printer the tablet can reach over the network.**
Not USB, and — corrected 16 Aug 2026 — **not Bluetooth either.**

| | Requirement | If not |
|---|---|---|
| **Existing A4** | reachable over **Wi-Fi or the LAN** | a ~₹2,000 Wi-Fi print server, or it cannot be used from a tablet at all |
| ↳ *settled:* | **HP Smart Tank 580** — Wi-Fi 2.4 GHz, Mopria, no Ethernet | nothing to buy; see below |
| **Small printer, when he buys it** | **80 mm thermal, Wi-Fi or LAN** | a Bluetooth-only thermal needs a native companion app — days of work plus an app to maintain forever. Buy Wi-Fi |

Print itself is plain HTML with `@page` rules — A4 for prescriptions and full
bills, 80 mm for counter receipts — rendered client-side and sent through the
OS print dialog. Same codebase, two stylesheets, no server involved and nothing
to install.

#### Bluetooth is not the escape hatch — corrected 16 Aug 2026

An earlier version of this section said a Bluetooth-only printer "works on
Android via Web Bluetooth but is fragile." **That was wrong**, and it was the
kind of wrong that only surfaces on go-live day. Three independent facts close
the path:

| Fact | Consequence |
|---|---|
| The **Web Bluetooth API is BLE GATT only** — it does not speak Bluetooth Classic SPP/RFCOMM, and there is no BLE replacement for SPP | ESC/POS thermal printers are Classic SPP. The PWA cannot open a socket to one |
| The **Web Serial API** *can* speak RFCOMM to paired Classic devices — but only in **Chrome 117+ on desktop** | The clinic's devices are Android tablets. The one web-native path that exists does not exist on the hardware being bought |
| **Mopria Print Service explicitly excludes Bluetooth**: it prints over Wi-Fi or Wi-Fi Direct only | `window.print()` reaches the Android print framework, and the print framework cannot see the printer |

So a Bluetooth-only printer is in the same category as a USB-only one, with one
extra hazard: everybody assumes Bluetooth works, so nobody checks.

**A printer that is Bluetooth *and* Wi-Fi is completely fine.** Use the Wi-Fi
and ignore the Bluetooth. Many mid-range A4 printers are both, which is why the
model number — not the word "Bluetooth" — is the thing that settles this.

#### Settled — and the model, 17 Aug 2026

**It is an HP Smart Tank 580 (1F3Y2A).** Nothing to buy and nothing to build:
it is Wi-Fi, it is Mopria-certified, and HP publish an Android print service
plugin for it. From HP's own spec sheet:

| | |
|---|---|
| Connectivity | 1 Hi-Speed USB 2.0 · 1 Wi-Fi 802.11b/g/n · 1 Wi-Fi Direct |
| Mobile printing | HP Smart app · Apple AirPrint · **Mopria Print Service** · **HP Print Service Plugin (Android)** · Wi-Fi Direct |
| Paper | A4 all-in-one (print, scan, copy) |

Three corrections to what was written on 16 Aug, and the second one is the
operational one:

**There is no Ethernet port.** The earlier note said "Wi-Fi/Ethernet". This
model has Wi-Fi and USB, nothing else. It does not change the plan — the
tablets were always going to reach it over Wi-Fi — but it removes the wired
fallback. If the clinic Wi-Fi is down, the printer is unreachable, full stop,
and there is no cable that fixes it.

**Its Wi-Fi is 2.4 GHz only.** This is the one that actually bites, and it
bites on a router that looks perfectly healthy. A dual-band router presenting
one SSID will put the tablets on 5 GHz and the printer on 2.4 GHz; on most
home routers those are bridged and printing works, but where the bands are
isolated — or where "AP isolation" or a guest network is switched on — the
tablet and the printer are on the same Wi-Fi and cannot see each other.
Discovery is mDNS, and mDNS does not cross that boundary. The symptom is a
print dialog that finds nothing, which reads as a broken printer.

**Its Bluetooth is for setup, not printing.** HP's BLE radio is how the HP
Smart app onboards the printer onto Wi-Fi. It is not a print transport, which
is exactly what the section above says about Bluetooth in general — so the
earlier phrasing, "Bluetooth *and* Wi-Fi", was right about the outcome and
wrong about why.

Two steps remain, both in the M0 §1.3 tablet setup because that is when both
tablets are already in hand:

> **1. Put the printer and both tablets on the same 2.4 GHz network**, and
> check AP isolation is off. Confirm it by opening the print dialog on each
> tablet and seeing the printer by name — not by pinging it, which passes on a
> network where discovery still fails.
>
> **2. Install HP Print Service Plugin on both tablets.** Android does not
> discover network printers by itself; it goes through Mopria Print Service or
> the manufacturer's plugin. Either works here — HP's own is the safer pick
> for an HP printer. Without one, the print dialog finds nothing and the
> printer looks broken when it is not.

Then print one real prescription on it before go-live. That is the last thing
standing between M1 and a closed gate.

Sources: [Chrome — Serial over Bluetooth on the
web](https://developer.chrome.com/blog/serial-over-bluetooth) ·
[WICG/serial Bluetooth
explainer](https://github.com/WICG/serial/blob/main/EXPLAINER_BLUETOOTH.md) ·
[Mopria print and scan support FAQ](https://mopria.org/faq)

---

## 2. The rules

Eight, matching the house style of `PLAN.md` §5.3.

| # | Rule | Because |
|---|---|---|
| 1 | **Nothing depends on hover.** No hover tooltips, no reveal-on-hover actions | there is no cursor. A hover-only affordance is invisible |
| 2 | **44 px minimum touch target, 56 px for anything destructive or primary** | a pharmacist's finger, in a hurry, next to "cancel prescription" |
| 3 | **Numbers get a custom on-screen numpad, never the OS keyboard** | the OS keyboard eats half a 10" screen to type "6" |
| 4 | **Search is a full-screen overlay, results above the keyboard** | otherwise the keyboard covers exactly the list being chosen from |
| 5 | **Two panes, no stacked modals** | landscape has the room. A modal over a modal on a tablet is a dead end |
| 6 | **Primary actions live in a fixed right-hand rail** | reachable, never scrolled away, never behind the keyboard |
| 7 | **Landscape locked on both clinic screens** | they are on stands. Rotation is only a source of layout bugs |
| 8 | **Every destructive action needs a deliberate second gesture** | pockets, sleeves and counters all press glass |

---

## 3. Layout

Target viewport: **1024–1366 CSS px, landscape.** Not a phone breakpoint that
grew; a design that starts here. The doctor's phone gets exactly one screen —
the presence toggle (`PLAN.md` §13.2) — and nothing else.

```
┌────────────────────────────────────────────────┬──────────────┐
│  context pane          │  work pane            │  action rail │
│  (who / what)          │  (the task)           │  (fixed)     │
│                        │                       │              │
│  patient, age, last    │  the consult form,    │  [ Sign Rx ] │
│  visit, allergies      │  or the dispense      │  [ Save    ] │
│  ─────────             │  lines, or the        │  [ Cancel  ] │
│  today's queue         │  counter basket       │              │
│                        │                       │  ──────────  │
│                        │                       │  live stock  │
│  ~320px                │  flexible             │  ~200px      │
└────────────────────────┴───────────────────────┴──────────────┘
```

**Typography for arm's length, not for a laptop.** Base 17–18 px, not 16.
Quantities, doses, prices and stock counts in tabular figures so digits line up
in a column. Expiries always as `Mar 2027` — month and year, as printed on the
strip (`PLAN.md` §12.3).

**Density.** Desktop pharmacy software puts 40 rows on screen. Twelve, at a
tappable height, is the right number here. If a list needs more, it needs a
filter, not smaller rows.

---

## 4. The three interactions that decide whether this feels good

Everything else is layout. These three are used hundreds of times a day, and
they are where a tablet build is won or lost.

### Drug search — the one that matters most

Used in the prescription composer and at the counter, dozens of times a day.

- Full-screen overlay the moment it is tapped.
- Results render **above** the keyboard, in the top half of the screen.
- Matches on brand, salt and common misspellings; 3 characters is enough.
- Each row carries the live stock badge inline — `18 in stock · Mar 2027`,
  `OUT — 2 alternatives` (`PLAN.md` §11.2, `INVENTORY.md` §7).
- Recent and frequent drugs before any typing at all. In a single-doctor
  general practice the top 40 drugs are most of the prescriptions, and this
  turns most searches into one tap.
- A camera button in the corner: scan the strip instead of typing it.

### Quantity entry

A custom numpad, laid out large, with the units the pharmacy actually uses
beside it — `tablets` / `strips` / `boxes`, converting live against the batch
pack config (`INVENTORY.md` §1) and showing the resulting base units under the
field. The OS keyboard never appears for a number in this app.

Above it, quick chips for what gets typed most: `1 strip`, `10`, `15`, `1 box`.

### Scan

One persistent camera affordance in the action rail on the counter, receipt and
stock-take screens. Scan feedback is a sound plus a colour flash, not a dialog —
the pharmacist is looking at the strip, not the screen. Wrong-drug-at-dispense
is a red flash and a stop; nothing else in the app uses that treatment.

---

## 5. Sign-in on a shared device

Email-and-password on a tablet, several times a day, will be defeated by the
staff within a week — they will pick a short password or never log out. So it
is designed around instead:

| | Design |
|---|---|
| Device | Registered once by Venu, marked `is_clinic_device` (`PLAN.md` §13.2). A long-lived session lives on the device |
| Person | **6-digit staff PIN** to unlock, per staff member |
| Idle | Locks after 3 minutes on the counter, 10 in the cabin |
| Attribution | Every write carries the staff id from the PIN, so the audit log names a person, not a tablet |
| Lost tablet | Session revoked from the admin screen. A PIN alone is useless on any other device |

The device holds the session; the PIN holds the identity. Attribution stays
exact — which the H1 register legally requires — and nobody types a password
forty times a day.

---

## 6. Installed, not a browser tab

Both tablets get the app **installed as a PWA**: home-screen icon, fullscreen,
no URL bar, no accidental navigation.

> **During local development this needs HTTPS on the LAN.** A service worker
> will not register over `http://192.168.x.x`, and neither will the camera —
> so PWA install, the offline queue and barcode scanning all fail silently on
> the tablets until `mkcert` and the root CA are in place. Set it up in M0:
> `HOSTING.md` §1a.

This is also where `PLAN.md` §5.2's offline story finally has a proper home. The
service worker caches the shell; IndexedDB holds the write queue; a persistent
banner shows connection state and pending-write count. When the line drops
mid-consult the doctor sees *"offline — 3 changes waiting"* rather than a failed
save, and the queue flushes on reconnect.

Fullscreen also means the browser cannot be navigated away from mid-consult,
which is a real failure mode on a shared tablet.

---

## 7. Screen by screen

| Screen | Tablet-specific design |
|---|---|
| **Queue / today** | The default screen on both tablets. Big rows, token number dominant, one tap to open. Auto-scrolls to the current token |
| **Consult** | Context pane = patient history. Work pane = the form. Rail = Sign Rx. Sections collapse; nothing is more than one scroll |
| **Rx composer** | The §4 search, then a compact line list. Each line shows stock inline. Long-press a line to edit, swipe to remove, both with undo |
| **Pharmacy queue** | Newest prescription at the top, arriving live. Colour-coded: fully in stock / partial / out |
| **Dispense** | Line-by-line with scan-to-verify. Substitution request goes to the doctor from here (`INVENTORY.md` §7) |
| **Counter sale** | Scan-driven basket, running total large enough to read from the customer's side, numpad for anything manual |
| **Goods receipt** | The heaviest data-entry screen — scan first, keyboard second. Batch, expiry, MRP, cost per line |
| **Stock-take** | Blind entry (`INVENTORY.md` §5). Scan, count, next. Optimised for someone standing at a shelf holding the tablet |
| **Reports / registers** | Read-mostly, print to A4. The one place a desktop-ish density is acceptable |
| **`/now` status page** | Public, phone-first, 3 seconds to load on 3G. This one is not a tablet screen |

---

## 8. Testing

| | |
|---|---|
| Playwright | All E2E at 1280×800 with touch emulation, never at desktop width |
| Lint rule | CI fails on any interactive element under 44 px |
| Lint rule | CI fails on `:hover`-only affordances outside `@media (hover: hover)` |
| Real device | Both tablets tested on the clinic's own Wi-Fi before go-live. Emulation does not catch keyboard-overlap or camera-permission behaviour |
| Print | Physical test on his actual printer, both paper sizes, before go-live |

---

## 9. What this adds to the estimate

| Item | Days |
|---|---|
| Tablet layout system — panes, rail, type scale, density | 2 |
| Numpad, full-screen search overlay, scan affordance | 2 |
| PWA install, service worker, offline queue UI | 1.5 |
| PIN auth over device session | 1 |
| Print CSS, both sizes, on real hardware | 1 |
| Real-device testing and correction pass | 1.5 |
| **Total** | **+9 days** |

Some of this was already priced as generic UI work in `PLAN.md` §8, so the true
increment is nearer **+6 days**. It is not decoration: a desktop layout on a
10-inch screen on a stand is the difference between software the pharmacist uses
and software the pharmacist works around.
