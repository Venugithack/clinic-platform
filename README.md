# Jayamurugan Clinic

Standalone, tablet-first clinic operations for one clinic and one facility.

## What is included

- Separate Admin, Doctor, Nurse and Pharmacy tablet workspaces
- Patients, queue, vitals, consultation, prescriptions and billing
- Four observation beds
- Rx dispensing and anonymous OTC sales
- Batch inventory, fixed-template CSV import/export and stock movements
- Suppliers, low-stock order drafts, partial/full goods receipt
- WhatsApp integration boundary with verified webhooks and configuration-gated sending
- Admin printer setup guide and AirPrint/Mopria-friendly native printing

The folder is intentionally independent from the parent hospital project. It has
its own package manifest, Next.js configuration, database and environment file.

## Local setup

```powershell
# Navigate to the new folder first
cd .\jayamurugan-clinic
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. On another tablet in the same network, use the
clinic computer's LAN address, for example `http://192.168.1.20:3000`.

Keep that computer on while the tablets are using the app. Every tablet connects
to this one server, so they all see the same queue, beds, stock and order states.

## Seeded sign-ins

The first local start creates demonstration accounts. Change these before using
real data.

| Station | Username | Password |
|---|---|---|
| Admin | `admin` | `clinic1234` |
| Doctor | `doctor` | `clinic1234` |
| Nurse | `nurse` | `clinic1234` |
| Pharmacy | `pharmacy` | `clinic1234` |

## WhatsApp status

Drafts, order state, receipt state and inbound/outbound message records are part
of the application. Real transmission stays disabled until the Meta values in
`.env.example` are configured. The application never simulates a successful send.

The webhook endpoint is `/api/whatsapp/webhook`. It verifies Meta signatures,
tracks sent/delivered/read/failed updates, and answers a patient asking whether
the doctor is in. That answer uses only a current doctor login session; there is
no manual presence switch.

## Inventory CSV

Use **Inventory → CSV template** for the fixed column layout. Import validates
the whole file before saving it, remembers the file hash to prevent accidental
double import, and refuses to overwrite an existing batch balance. Export
includes medicine, batch and preferred supplier details.

## Printing

Install an AirPrint-compatible printer for iPads or a Mopria-certified printer
for Android tablets. Keep printer and tablet on the same private Wi-Fi. Print
buttons open the tablet's normal system print dialog. Admin can use
**Printer → Print test page** on each tablet before the clinic opens.

## Local data and backup

The SQLite database is created at `data/jayamurugan-clinic.db` and is ignored by
Git. Stop the app before copying the `data` folder as a backup. Keep backup
copies encrypted and test restoring one before relying on the system.
