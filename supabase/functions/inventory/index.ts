/**
 * The inventory reads that are too big for the poll.
 *
 * `docs/AGENT_IMPLEMENTATION_BRIEF.md` §3: "Large history, stock ledgers,
 * payment history, and clinical-image bytes are fetched on demand, not added
 * to the whole-clinic polling snapshot." Four tablets asking every fifteen
 * seconds for a stock ledger that grows by a row per sale is how a free
 * database plan stops being free, and it is also how a snapshot stops fitting
 * in a response.
 *
 * So the package ladders — small, a handful of rows per product, and needed to
 * draw the counter's buttons — stay in the snapshot, and everything here is
 * asked for when somebody opens the thing that needs it:
 *
 *   ?view=ledger&batchId=…       one batch's movements, newest first
 *   ?view=receipts               recent goods receipts with their lines
 *   ?view=receipt&id=…           one receipt in full
 *   ?view=barcode&code=…         what a scan means, or that it means nothing
 *   ?view=formulary              substances and clinical drugs
 *
 * Reads only. Every write is a command, and `record_unknown_barcode` is the
 * command the barcode view's caller should post when this answers "unknown" —
 * it is not done here, because a GET that writes is a GET that a retry, a
 * prefetch or a browser's speculative fetch turns into three.
 */
import { hasRole } from '../_shared/auth.ts'
import { db } from '../_shared/db.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'
import { decompose, describeEntry, ladderFromRows } from '../_shared/packages.ts'

type Row = Record<string, unknown>

const text = (value: unknown) => String(value ?? '')
const num = (value: unknown) => Number(value ?? 0)

/**
 * A jsonb column, handed on as data rather than as text.
 *
 * The driver parses jsonb into an object on this connection and hands back raw
 * text on others, so `String(value)` produces "[object Object]" exactly half
 * the time — which is the sort of thing that reaches a tablet rather than a
 * test. Normalising here means the response shape does not depend on which
 * pool answered.
 */
function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** A batch's frozen ladder, or null for a batch received before Slice 3. */
function ladderOf(row: Row) {
  const raw = row.package_snapshot
  if (!raw) return null
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      baseUnit: string
      levels: Parameters<typeof ladderFromRows>[1]
    }
    return parsed?.levels?.length ? ladderFromRows(parsed.baseUnit, parsed.levels) : null
  } catch {
    return null
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  // The shelf roles, matching the snapshot's own `shelf` gate. A nurse has no
  // inventory station and is not given the ledger.
  if (!hasRole(session, 'admin', 'doctor', 'pharmacy')) {
    return json({ ok: false, message: 'Your role cannot read the stock ledger.' }, 403)
  }

  const url = new URL(request.url)
  const view = url.searchParams.get('view') ?? ''

  try {
    switch (view) {
      /** One batch, its movements, and what it decomposes into today. */
      case 'ledger': {
        const batchId = url.searchParams.get('batchId') ?? ''
        if (!batchId) return json({ ok: false, message: 'No batch asked for.' }, 400)

        const batch = (await db.prepare(
          `select b.*, m.name as medicine_name, a.pickable, a.expired
             from batches b
             join medicines m on m.id = b.medicine_id
             join batch_availability a on a.id = b.id
            where b.id = ?`,
        ).get(batchId)) as Row | undefined
        if (!batch) return json({ ok: false, message: 'That batch was not found.' }, 404)

        const movements = (await db.prepare(
          `select v.id, v.movement_type, v.quantity_delta, v.bucket, v.reference_type,
                  v.reference_id, v.reason, v.created_at, v.package_entry,
                  v.reverses_movement_id,
                  s.name as actor_name, approver.name as approved_by_name
             from stock_movements v
             join staff s on s.id = v.actor_id
             left join staff approver on approver.id = v.approved_by
            where v.batch_id = ?
            order by v.created_at desc, v.id desc
            limit 500`,
        ).all(batchId)) as Row[]

        const ladder = ladderOf(batch)
        return json({
          ok: true,
          batch: {
            id: text(batch.id),
            medicineId: text(batch.medicine_id),
            medicineName: text(batch.medicine_name),
            batchNumber: text(batch.batch_number),
            expiry: text(batch.expiry),
            baseUnit: text(batch.base_unit),
            status: text(batch.status),
            statusReason: text(batch.status_reason),
            availableQuantity: num(batch.available_quantity),
            quarantinedQuantity: num(batch.quarantined_quantity),
            blockedQuantity: num(batch.blocked_quantity),
            pickable: batch.pickable === true,
            expired: batch.expired === true,
            mrp: num(batch.mrp),
            mrpBasisLevel: text(batch.mrp_basis_level),
            mrpBasisFactor: num(batch.mrp_basis_factor) || 1,
            purchasePrice: num(batch.purchase_price),
            packageBreakdown: ladder
              ? describeEntry(decompose(ladder, num(batch.available_quantity)))
              : '',
          },
          movements: movements.map((row) => ({
            id: text(row.id),
            movementType: text(row.movement_type),
            quantityDelta: num(row.quantity_delta),
            bucket: text(row.bucket),
            referenceType: text(row.reference_type),
            referenceId: text(row.reference_id),
            reason: text(row.reason),
            createdAt: text(row.created_at),
            actorName: text(row.actor_name),
            approvedByName: text(row.approved_by_name),
            reversesMovementId: text(row.reverses_movement_id),
            packageEntry: jsonValue(row.package_entry),
          })),
        })
      }

      /** The deliveries, newest first. Headers only; ask for one to see its lines. */
      case 'receipts': {
        const receipts = (await db.prepare(
          `select g.id, g.grn_number, g.status, g.supplier_invoice_number, g.supplier_invoice_date,
                  g.subtotal, g.tax_total, g.total, g.received_at, g.note,
                  s.name as supplier_name, r.name as received_by_name,
                  (select count(*)::int from goods_receipt_lines l where l.goods_receipt_id = g.id) as line_count
             from goods_receipts g
             join suppliers s on s.id = g.supplier_id
             join staff r on r.id = g.received_by
            order by g.received_at desc
            limit 100`,
        ).all()) as Row[]

        return json({
          ok: true,
          receipts: receipts.map((row) => ({
            id: text(row.id),
            grnNumber: text(row.grn_number),
            status: text(row.status),
            supplierName: text(row.supplier_name),
            supplierInvoiceNumber: text(row.supplier_invoice_number),
            supplierInvoiceDate: text(row.supplier_invoice_date),
            subtotal: num(row.subtotal),
            taxTotal: num(row.tax_total),
            total: num(row.total),
            receivedAt: text(row.received_at),
            receivedByName: text(row.received_by_name),
            note: text(row.note),
            lineCount: num(row.line_count),
          })),
        })
      }

      /** One delivery, with the physical entry each line was typed as. */
      case 'receipt': {
        const id = url.searchParams.get('id') ?? ''
        if (!id) return json({ ok: false, message: 'No delivery asked for.' }, 400)

        const receipt = (await db.prepare(
          `select g.*, s.name as supplier_name, r.name as received_by_name
             from goods_receipts g
             join suppliers s on s.id = g.supplier_id
             join staff r on r.id = g.received_by
            where g.id = ?`,
        ).get(id)) as Row | undefined
        if (!receipt) return json({ ok: false, message: 'That delivery was not found.' }, 404)

        const lines = (await db.prepare(
          `select l.*, m.name as medicine_name, b.batch_number as batch_number_on_shelf
             from goods_receipt_lines l
             join medicines m on m.id = l.medicine_id
             left join batches b on b.id = l.batch_id
            where l.goods_receipt_id = ?
            order by l.line_number`,
        ).all(id)) as Row[]

        return json({
          ok: true,
          receipt: {
            id: text(receipt.id),
            grnNumber: text(receipt.grn_number),
            status: text(receipt.status),
            supplierName: text(receipt.supplier_name),
            supplierInvoiceNumber: text(receipt.supplier_invoice_number),
            supplierInvoiceDate: text(receipt.supplier_invoice_date),
            subtotal: num(receipt.subtotal),
            taxTotal: num(receipt.tax_total),
            total: num(receipt.total),
            receivedAt: text(receipt.received_at),
            receivedByName: text(receipt.received_by_name),
            note: text(receipt.note),
          },
          lines: lines.map((row) => ({
            lineNumber: num(row.line_number),
            medicineName: text(row.medicine_name),
            batchNumber: text(row.batch_number),
            expiry: text(row.expiry),
            entry: jsonValue(row.entry_json),
            acceptedBaseQuantity: num(row.accepted_base_quantity),
            freeBaseQuantity: num(row.free_base_quantity),
            quarantinedBaseQuantity: num(row.quarantined_base_quantity),
            rejectedBaseQuantity: num(row.rejected_base_quantity),
            rejectionReason: text(row.rejection_reason),
            mrpAmount: num(row.mrp_amount),
            mrpBasisLevel: text(row.mrp_basis_level),
            mrpBasisFactor: num(row.mrp_basis_factor),
            purchaseAmount: num(row.purchase_amount),
            purchaseBasisLevel: text(row.purchase_basis_level),
            purchaseBasisFactor: num(row.purchase_basis_factor),
            taxRate: num(row.tax_rate),
            taxAmount: num(row.tax_amount),
            lineTotal: num(row.line_total),
          })),
        })
      }

      /**
       * What a scan means.
       *
       * `carriesBatch` is false for an ordinary GTIN and the caller must treat
       * it that way: the code identifies the pack, not the lot. Only a GS1-128,
       * DataMatrix or QR payload that actually encodes application identifiers
       * (10) and (17) is recorded as carrying batch and expiry, and the
       * pharmacist still confirms them.
       */
      case 'barcode': {
        const code = (url.searchParams.get('code') ?? '').trim()
        if (!code) return json({ ok: false, message: 'No code scanned.' }, 400)

        const mapped = (await db.prepare(
          `select c.code, c.level_name, c.symbology, c.carries_batch,
                  m.id as medicine_id, m.name as medicine_name, m.base_unit,
                  v.name as verified_by_name, c.verified_at
             from medicine_barcodes c
             join medicines m on m.id = c.medicine_id
             left join staff v on v.id = c.verified_by
            where c.code = ?`,
        ).get(code)) as Row | undefined

        if (!mapped) {
          // Also say whether anybody has met it before, so the counter knows
          // the difference between "new" and "reported ten times and still
          // not mapped".
          const seen = (await db.prepare(
            'select seen_count, last_seen_at from unmapped_barcodes where code = ? and resolved_at is null',
          ).get(code)) as Row | undefined
          return json({
            ok: true,
            known: false,
            code,
            seenCount: num(seen?.seen_count),
            message: 'That code is not mapped to any medicine. Search by name, and ask an admin to map it.',
          })
        }

        const levelRow = (await db.prepare(
          `select l.base_factor, l.sellable, l.receivable, l.minimum_sale_multiple
             from package_levels l
             join medicine_active_package p on p.package_version_id = l.package_version_id
            where p.medicine_id = ? and lower(l.level_name) = lower(?)`,
        ).get(text(mapped.medicine_id), text(mapped.level_name))) as Row | undefined

        return json({
          ok: true,
          known: true,
          code,
          medicineId: text(mapped.medicine_id),
          medicineName: text(mapped.medicine_name),
          baseUnit: text(mapped.base_unit),
          levelName: text(mapped.level_name),
          symbology: text(mapped.symbology),
          carriesBatch: mapped.carries_batch === true,
          verifiedByName: text(mapped.verified_by_name),
          verifiedAt: text(mapped.verified_at),
          baseFactor: num(levelRow?.base_factor) || null,
          sellable: levelRow?.sellable === true,
          receivable: levelRow?.receivable === true,
          minimumSaleMultiple: num(levelRow?.minimum_sale_multiple) || 1,
        })
      }

      /** The substances and clinical drugs a pharmacist can link a product to. */
      case 'formulary': {
        const substances = (await db.prepare(
          'select id, name, source, source_code from substances where active order by name',
        ).all()) as Row[]

        const drugs = (await db.prepare(
          `select d.id, d.display_name, d.dosage_form, d.route, d.release_type,
                  coalesce(string_agg(s.name || ' ' || i.strength_value::text || ' ' || i.strength_unit,
                                      ' + ' order by i.ordinal), '') as ingredients
             from clinical_drugs d
             left join clinical_drug_ingredients i on i.clinical_drug_id = d.id
             left join substances s on s.id = i.substance_id
            where d.active
            group by d.id
            order by d.display_name`,
        ).all()) as Row[]

        return json({
          ok: true,
          substances: substances.map((row) => ({
            id: text(row.id), name: text(row.name),
            source: text(row.source), sourceCode: text(row.source_code),
          })),
          clinicalDrugs: drugs.map((row) => ({
            id: text(row.id),
            displayName: text(row.display_name),
            dosageForm: text(row.dosage_form),
            route: text(row.route),
            releaseType: text(row.release_type),
            ingredients: text(row.ingredients),
          })),
        })
      }

      default:
        return json({ ok: false, message: 'Unknown inventory view.' }, 400)
    }
  } catch (error) {
    console.error('inventory read failed:', error)
    return json({ ok: false, message: 'That could not be read.' }, 500)
  }
})
