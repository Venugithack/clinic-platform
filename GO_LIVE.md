# Clinic go-live runbook

This is the final cutover sequence for the single-clinic build. Printer setup is intentionally deferred until real hardware exists.

## 1. Rehearse locally

Run the production-shaped clinic flow against a reset seeded development stack:

```bash
pnpm test:go-live
```

This covers one complete patient journey (registration → vitals → consultation → signed prescription → pharmacy dispense → stock deduction → billing) and the purchasing journey (reorder → draft PO → doctor approval → WhatsApp handoff → supplier reply → receiving).

The ordinary CI suite remains the wider regression gate.

## 2. Create the production services

Provision the clinic's production Supabase project and web deployment. Put only the public app values in the web deployment environment:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase publishable key)

`NEXT_PUBLIC_REALTIME_WS_URL` must be unset in production; hosted Supabase Realtime is used there.

Run:

```bash
pnpm go-live:check
```

The preflight refuses localhost/non-HTTPS database URLs, missing publishable keys and a development realtime URL.

## 3. Configure backups

The backup workflow requires these GitHub Actions secrets:

- `BACKUP_DB_URL`
- `BACKUP_AGE_RECIPIENT`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT`

Keep the age private key offline. GitHub receives only the public recipient.

After configuration, manually run one backup and restore drill before patient data is entered. Confirm the next scheduled backup also lands in R2.

## 4. Apply the database schema

Apply every repository migration to the production database in order using the production migration procedure documented in `HOSTING.md`. Do not copy individual table definitions by hand and do not skip old migrations.

Confirm the deployed application can reach the hosted database before entering clinic data.

## 5. First run

On a clinic device:

1. Create the clinic.
2. Create the first administrator/doctor and six-digit PIN.
3. Register the first clinic tablet.
4. Open Clinic settings and enter the real clinic identity, registration/licence details, consultation fee, contact details and opening hours.
5. Add the remaining staff and clinic tablets from **People & tablets**.

Do not use seed staff, seed PINs or seed devices in production.

## 6. Load the medicine master and suppliers

Use `data/templates/medicine-master.csv` as the header contract.

Required identity fields must be real clinic data; do not invent salts, strengths, forms or pack sizes. Use the Import screen's dry run first and fix every reported row before committing the file.

After import, review Suppliers and add the real WhatsApp numbers, lead times and return windows. Confirm each routinely purchased medicine has the correct preferred supplier.

## 7. Load opening stock — clinic closed

Do this once, with the physical shelf stable and the clinic closed to sales/dispensing.

Use `data/templates/opening-stock.csv`. Each row must be taken from the actual pack/batch:

- medicine name
- batch number
- expiry
- physical quantity and unit
- purchase rate and rate basis
- printed MRP
- supplier

Use the Opening stock dry run and compare its batch count, base-unit count and total cost value against the physical count before committing.

Never run the same opening-stock file twice. Subsequent stock enters through Receiving/GRN.

## 8. Production smoke test

Before the first real patient, use a clearly labelled disposable test patient and run the printerless clinic path on the actual tablets/Wi-Fi:

1. register patient and issue token
2. record vitals
3. open consultation
4. type diagnosis and prescription
5. sign prescription
6. confirm it appears at pharmacy
7. dispense using the supported barcode/name-confirmation path
8. raise and settle the bill
9. confirm stock dropped in Inventory
10. confirm the completed prescription left the pharmacy queue
11. create/review a low-stock draft if a safe test medicine is available
12. verify the WhatsApp PO deep link opens with the intended supplier/wording without sending a real order unless desired

Use the application's correction/void workflows for test financial records. Do not delete ledger, audit, bill or stock history directly.

## 9. Go/no-go checks

Go live only when all are true:

- production app environment passes `pnpm go-live:check`
- migrations are fully applied
- admin, doctor/nurse and counter roles open only their intended workspaces
- real clinic tablets unlock and idle-lock correctly
- registration, vitals, consultation, Rx, dispense and billing work on clinic Wi-Fi
- inventory reflects the real opening shelf
- supplier WhatsApp numbers and preferred mappings are reviewed
- one backup has been uploaded and one restore drill has succeeded
- scheduled backups are enabled
- no seed credentials/data are being used as production identities

## Deferred: printers

Prescription/receipt layouts already exist, but printer configuration and physical output testing remain intentionally deferred until the clinic has the actual printer hardware. Do not block the rest of the go-live preparation on a guessed printer integration.
