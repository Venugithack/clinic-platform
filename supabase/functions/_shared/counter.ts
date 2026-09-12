/**
 * The counter: handing medicine over, selling across it, and taking money.
 *
 * Slice 4. Three rules run through every command here.
 *
 *   A SIGNED PRESCRIPTION IS IMMUTABLE CLINICAL INTENT. Opening it moves
 *   nothing; typing a `Give now` quantity moves nothing; only `dispense_rx`
 *   moves stock, and it can only ever move less than or equal to what is left
 *   of what was prescribed.
 *
 *   MONEY IS EVENTS, NOT A STATUS. An invoice line is what was charged and
 *   never changes. A payment is money that arrived. A refund is money that
 *   went back. Unpaid, part paid and paid are arithmetic over those three,
 *   computed by `jmc.invoice_balances` every time they are asked for.
 *
 *   A RETRY IS NOT A SECOND EVENT. Every command that moves stock or money
 *   carries an idempotency key backed by a unique index, so a slow network and
 *   an impatient thumb produce one dispense and one receipt.
 */
import { randomUUID } from 'node:crypto'
import { audit, db, isoNow, transaction } from './db.ts'
import type { SessionView } from './types.ts'
import {
  booleanValue, numberValue, optional, optionalDate, optionalPositiveInteger,
  requireChoice, requireRole, sequence, value, type Payload,
} from './command-input.ts'
import { money, parseBalance, parseMoney, proRata, rupees, sum as sumMoney, times } from './money.ts'
import { ladderRows, moveStock, packageEntries } from './inventory.ts'
import { runImageCommand } from './images.ts'
import { baseQuantityOf, levelNamed, plural } from './packages.ts'

const CLINIC_TODAY = `(now() at time zone 'Asia/Kolkata')::date`

type SupplyRow = {
  id: string
  prescription_id: string
  line_number: number
  medicine_name_snapshot: string
  effective_medicine_id: string | null
  effective_quantity: number | null
  needs_review: boolean
  supplied: number
  remaining: number
  outcome: string | null
  supplyable: boolean
  supply_state: string
}

type Allocation = {
  batchId: string
  batchNumber: string
  quantity: number
  unitAmountPaise: number
  movementId: string
}

/**
 * Earliest expiry first, and never from a batch that should not be picked.
 *
 * `jmc.batch_availability.pickable` is the single eligibility rule — active,
 * in date, and holding something — so this cannot drift from what the screen
 * showed or from what an OTC sale allows.
 *
 * The lock is the UPDATE itself. `set available_quantity = available_quantity
 * - ? where id = ? and available_quantity >= ?` takes the row lock and does the
 * arithmetic in one statement, so two transactions racing for the last tablet
 * cannot both succeed: the second changes zero rows, and this retries against
 * what the batch actually holds now before moving on. Candidates are taken in
 * (expiry, id) order everywhere, which is what keeps two dispenses from
 * deadlocking against each other.
 */
async function allocateFefo(options: {
  medicineId: string
  quantity: number
  actorId: string
  referenceType: string
  referenceId: string
}): Promise<Allocation[]> {
  const candidates = await db.prepare(
    `select id, batch_number, available_quantity, selling_price
       from batch_availability
      where medicine_id=? and pickable
      order by expiry, id`,
  ).all(options.medicineId) as Array<{
    id: string
    batch_number: string
    available_quantity: number
    selling_price: string
  }>

  const offered = candidates.reduce((total, row) => total + Number(row.available_quantity), 0)
  if (offered < options.quantity) {
    throw new Error(
      offered === 0
        ? 'None of that is on the shelf.'
        : `Only ${offered} unit(s) can be supplied; ${options.quantity} were asked for.`,
    )
  }

  const allocations: Allocation[] = []
  let remaining = options.quantity

  for (const candidate of candidates) {
    if (remaining === 0) break
    let take = Math.min(Number(candidate.available_quantity), remaining)

    while (take > 0) {
      const update = await db.prepare(
        `update batches set available_quantity=available_quantity-?, version=version+1
          where id=? and status='active' and available_quantity>=?`,
      ).run(take, candidate.id, take)
      if (Number(update.changes) === 1) break

      // Somebody else got there first. Ask the batch what it actually holds
      // now rather than failing the whole hand-over on a stale read.
      const current = await db.prepare(
        `select available_quantity from batch_availability where id=? and pickable`,
      ).get(candidate.id) as { available_quantity: number } | undefined
      take = Math.min(Number(current?.available_quantity ?? 0), remaining)
    }
    if (take === 0) continue

    /*
     * The ledger row, written here rather than through `moveStock`.
     *
     * `moveStock` does the decrement and the row together, which is right
     * everywhere else. Here the decrement has already happened above — it had
     * to, because the retry loop needs to know whether it won the race before
     * it can say how much it took — so what is left is the row, in exactly the
     * shape `moveStock` writes it.
     */
    const id = randomUUID()
    await db.prepare(
      `insert into stock_movements
        (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,
         actor_id,created_at,bucket)
       values (?,?,?,?,?,?,?,?,?, 'available')`,
    ).run(
      id, options.medicineId, candidate.id, options.referenceType, -take,
      options.referenceType, options.referenceId, options.actorId, isoNow(),
    )

    allocations.push({
      batchId: candidate.id,
      batchNumber: candidate.batch_number,
      quantity: take,
      unitAmountPaise: parseMoney(candidate.selling_price, 'selling price'),
      movementId: id,
    })
    remaining -= take
  }

  if (remaining > 0) {
    /*
     * Somebody else took it between the read and the write, and the loser
     * should be told what is actually on the shelf rather than that something
     * changed. Asked again here, because by now it has.
     */
    const now = await db.prepare(
      `select coalesce(sum(available_quantity), 0)::int as available
         from batch_availability where medicine_id=? and pickable`,
    ).get(options.medicineId) as { available: number }
    throw new Error(
      Number(now.available) === 0
        ? 'None of that is on the shelf — another tablet took the last of it. Check the shelf and try again.'
        : `Only ${now.available} unit(s) can be supplied; ${options.quantity} were asked for. ` +
          'Another tablet took some while this was open.',
    )
  }
  return allocations
}

/**
 * The invoice this charge belongs on.
 *
 * One visit, one bill: the consultation fee, the medicine handed over and
 * anything bought across the counter during the same encounter all land on the
 * same invoice, which is what policy register 48 means by a unified checkout.
 * A patient with no encounter — an over-the-counter sale — gets their own.
 */
export async function openInvoice(options: {
  patientId: string | null
  encounterId: string | null
  actorId: string
}): Promise<string> {
  if (options.encounterId) {
    const existing = await db.prepare(
      `select id from invoices where encounter_id=? and status='open' order by created_at limit 1`,
    ).get(options.encounterId) as { id: string } | undefined
    if (existing) return existing.id
  }

  const id = randomUUID()
  const number = await sequence('INV')
  await db.prepare(
    `insert into invoices (id,invoice_number,patient_id,encounter_id,status,created_by,created_at)
     values (?,?,?,?, 'open', ?, now())`,
  ).run(id, number, options.patientId, options.encounterId, options.actorId)
  return id
}

/** Append one charge to an invoice. The source key is what makes a retry safe. */
export async function addInvoiceLine(invoiceId: string, line: {
  source: 'consultation_fee' | 'prescription' | 'otc' | 'adjustment'
  sourceKey: string
  description: string
  quantity: number
  unitAmountPaise: number
  amountPaise: number
  encounterId?: string | null
  dispenseLineId?: string | null
  otcLineId?: string | null
  medicineId?: string | null
}): Promise<void> {
  const next = await db.prepare(
    'select coalesce(max(line_number),0)::int as line_number from invoice_lines where invoice_id=?',
  ).get(invoiceId) as { line_number: number }

  await db.prepare(
    `insert into invoice_lines
      (id,invoice_id,line_number,source,encounter_id,dispense_line_id,otc_line_id,medicine_id,
       description,quantity,unit_amount,amount,source_key)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(), invoiceId, Number(next.line_number) + 1, line.source,
    line.encounterId ?? null, line.dispenseLineId ?? null, line.otcLineId ?? null,
    line.medicineId ?? null,
    line.description, line.quantity, money(line.unitAmountPaise), money(line.amountPaise),
    line.sourceKey,
  )
}

/** What one bill adds up to. Every figure is derived; none is stored. */
type Balance = {
  invoiceNumber: string
  patientId: string | null
  status: string
  paymentState: string
  totalPaise: number
  paidPaise: number
  duePaise: number
}

/**
 * Read that back out of the ledger.
 *
 * Every figure here is DERIVED, so every figure here is read with
 * `parseBalance` rather than `parseMoney`. `paid` is the one that matters:
 * refund ₹40 against a ₹100 receipt and then reverse the receipt and it is
 * minus forty rupees, which the input validator refuses to read at all.
 */
async function balanceOf(invoiceId: string): Promise<Balance> {
  const row = await db.prepare(
    `select invoice_number, patient_id, total, paid, due, payment_state, status
       from invoice_balances where id=?`,
  ).get(invoiceId) as {
    invoice_number: string; patient_id: string | null
    total: string; paid: string; due: string; payment_state: string; status: string
  } | undefined
  if (!row) throw new Error('That bill was not found.')
  return {
    invoiceNumber: row.invoice_number,
    patientId: row.patient_id,
    status: row.status,
    paymentState: row.payment_state,
    totalPaise: parseBalance(row.total, 'bill total'),
    paidPaise: parseBalance(row.paid, 'amount paid'),
    duePaise: parseBalance(row.due, 'amount due'),
  }
}

/**
 * What an over-refunded bill says, wherever somebody meets one.
 *
 * Policy register 50 fixes the words, and they are the same words on every
 * screen on purpose: this is not a bill in an unusual state, it is a bill that
 * has stopped being a counter's business until somebody with the books open
 * has looked at it.
 */
function overRefunded(balance: Balance): Error {
  return new Error(
    `Over-refunded — financial correction required. ` +
    `${rupees(-balance.paidPaise)} more has gone back out on ${balance.invoiceNumber} than ever came in. ` +
    `Nothing has been changed. It is on the financial review queue for the admin or accountant.`,
  )
}

/** What is still owed on an invoice, in paise. */
async function dueOn(invoiceId: string): Promise<number> {
  const balance = await balanceOf(invoiceId)
  if (balance.status === 'void') throw new Error('That bill has been voided.')
  /*
   * `due` on an over-refunded bill is total MINUS a negative number, so it is
   * bigger than the bill. Handing that figure to the counter would charge the
   * patient for the clinic's own error, which is why this refuses rather than
   * returning it.
   */
  if (balance.paidPaise < 0) throw overRefunded(balance)
  return balance.duePaise
}

/**
 * Take money, in one or more parts, against one invoice.
 *
 * Split payment is several `parts` in one call — cash and UPI on the same
 * bill is one transaction and two payment records, each with its own receipt
 * number, because that is what the two entries in the day book have to
 * reconcile against.
 */
async function recordPayments(options: {
  invoiceId: string
  patientId: string | null
  parts: Array<{ method: 'cash' | 'upi' | 'card'; amountPaise: number; reference: string }>
  idempotencyKey: string
  actorId: string
  kind?: 'payment' | 'refund'
  note?: string
}): Promise<{ receipts: string[]; takenPaise: number }> {
  const receipts: string[] = []
  let taken = 0
  let index = 0

  for (const part of options.parts) {
    index += 1
    const id = randomUUID()
    const receipt = await sequence('RCP')
    await db.prepare(
      `insert into payments
        (id,receipt_number,kind,patient_id,method,reference,amount,status,idempotency_key,note,
         received_by,received_at)
       values (?,?,?,?,?,?,?, 'received', ?, ?, ?, now())`,
    ).run(
      id, receipt, options.kind ?? 'payment', options.patientId, part.method, part.reference,
      money(part.amountPaise), `${options.idempotencyKey}:${index}`, options.note ?? '',
      options.actorId,
    )
    await db.prepare(
      'insert into payment_allocations (id,payment_id,invoice_id,amount,created_at) values (?,?,?,?,now())',
    ).run(randomUUID(), id, options.invoiceId, money(part.amountPaise))
    receipts.push(receipt)
    taken += part.amountPaise
  }

  return { receipts, takenPaise: taken }
}

function paymentParts(payload: Payload, key = 'parts') {
  const raw = Array.isArray(payload[key]) ? payload[key] as Payload[] : []
  return raw.map((part, index) => {
    const amountPaise = parseMoney(part.amount, `Payment ${index + 1}`, { min: 0 })
    if (amountPaise <= 0) throw new Error(`Payment ${index + 1} must be more than zero.`)
    return {
      // Policy register 23: the method is required, the reference is not.
      method: requireChoice(part, 'method', ['cash', 'upi', 'card'] as const),
      amountPaise,
      reference: optional(part, 'reference'),
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════

export async function runCounterCommand(session: SessionView, action: string, payload: Payload) {
  switch (action) {
    /*
     * How long the remainder of this prescription may be collected against.
     *
     * Policy register 18: the clinic default is seven calendar days from
     * signing and the doctor may shorten or extend it for one prescription.
     * Doctor only — this is a clinical direction about a signed order, not a
     * counter setting.
     */
    case 'set_prescription_validity': {
      requireRole(session, 'doctor')
      const prescriptionId = value(payload, 'prescriptionId')
      const validUntil = optionalDate(payload, 'validUntil')
      if (!validUntil) throw new Error('Say the last day this may be supplied.')
      const reason = value(payload, 'reason')
      const supplyInParts = payload.supplyInParts === undefined
        ? true : booleanValue(payload, 'supplyInParts')

      await transaction(async () => {
        const rx = await db.prepare(
          `select id, prescription_number, signed_at, valid_until from prescriptions where id=? for update`,
        ).get(prescriptionId) as {
          id: string; prescription_number: string; signed_at: string; valid_until: string
        } | undefined
        if (!rx) throw new Error('That prescription was not found.')

        const before = await db.prepare(
          `select (?::date < (?::timestamptz at time zone 'Asia/Kolkata')::date) as early`,
        ).get(validUntil, rx.signed_at) as { early: boolean }
        if (before.early) {
          throw new Error('A prescription cannot stop being valid before it was signed.')
        }

        await db.prepare(
          `update prescriptions set valid_until=?, supply_in_parts=?, validity_set_by=?, validity_reason=?
            where id=?`,
        ).run(validUntil, supplyInParts, session.staffId, reason, prescriptionId)
        await audit(session.staffId, 'prescription.validity', 'prescription', prescriptionId,
          `${rx.prescription_number} may be supplied until ${validUntil}` +
          `${supplyInParts ? '' : ', in one supply only'}: ${reason}`)
      })
      return { message: `Valid until ${validUntil}.` }
    }

    /*
     * The two ways a line stops being supplied, kept apart.
     *
     * Policy register 20. Patient Declined is the patient's choice and is
     * recorded at the counter by whoever was told; Doctor Cancelled is the
     * doctor withdrawing the order. Neither is the other, and "not supplied"
     * is neither of them.
     */
    case 'record_prescription_line_outcome': {
      const outcome = requireChoice(
        payload, 'outcome', ['patient_declined', 'doctor_cancelled'] as const,
      )
      if (outcome === 'doctor_cancelled') requireRole(session, 'doctor')
      else requireRole(session, 'admin', 'pharmacy')

      const lineId = value(payload, 'prescriptionLineId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const line = await db.prepare(
          `select id, line_number, medicine_name_snapshot, supplied, remaining, outcome
             from prescription_line_supply where id=?`,
        ).get(lineId) as SupplyRow | undefined
        if (!line) throw new Error('That prescription line was not found.')
        if (line.outcome) {
          throw new Error(
            `Line ${line.line_number} is already recorded as ${line.outcome.replace('_', ' ')}.`,
          )
        }

        await db.prepare(
          `insert into prescription_line_outcomes
            (id,prescription_line_id,outcome,reason,recorded_by,recorded_at)
           values (?,?,?,?,?,now())`,
        ).run(randomUUID(), lineId, outcome, reason, session.staffId)

        await audit(session.staffId, `prescription_line.${outcome}`, 'prescription_line', lineId,
          `Line ${line.line_number} (${line.medicine_name_snapshot}) ` +
          `${outcome === 'patient_declined' ? 'declined by the patient' : 'cancelled by the doctor'}` +
          `${Number(line.supplied) > 0 ? `, after ${line.supplied} already supplied` : ''}: ${reason}`)
      })
      return {
        message: outcome === 'patient_declined'
          ? 'Recorded: the patient declined this line.'
          : 'Recorded: the doctor cancelled this line.',
      }
    }

    /*
     * Confirm and hand over.
     *
     * One transaction, in the order the brief sets out: authorize, enforce
     * idempotency, lock the prescription, recheck what is left to supply,
     * recheck and allocate the batches, write the dispense and its allocations,
     * write the negative movements, create the medicine bill lines, commit.
     *
     * The prescription row lock is what makes the recheck mean anything. Two
     * counters supplying the same line at the same moment used to both read
     * "ten remaining" and both hand over ten; now the second waits here, then
     * re-reads under READ COMMITTED and sees what the first actually left.
     */
    case 'dispense_rx': {
      /*
       * Pharmacy alone, and not the administrator.
       *
       * Owner decision, 12 September 2026, recorded at policy register item
       * 17: medicine leaving the shelf always requires a pharmacist. An
       * administrator reviews what happened and can void, refund, reverse and
       * take part in an authorised return — all of which are corrections to a
       * hand-over a pharmacist made — but cannot make the hand-over.
       *
       * The owner also holds the pharmacy role, so this does not stop the
       * owner working the counter; it stops the office doing it.
       */
      requireRole(session, 'pharmacy')
      const prescriptionId = value(payload, 'prescriptionId')
      const idempotencyKey = optional(payload, 'idempotencyKey') || `dispense:${randomUUID()}`

      const already = await db.prepare(
        'select id, dispense_number from dispenses where idempotency_key=?',
      ).get(idempotencyKey) as { id: string; dispense_number: string } | undefined
      if (already) {
        return {
          message: `${already.dispense_number} was already handed over. Nothing was given twice.`,
          data: { dispenseId: already.id, dispenseNumber: already.dispense_number, duplicate: true },
        }
      }

      const requested = Array.isArray(payload.lines) ? payload.lines as Payload[] : []
      const dispenseId = randomUUID()
      let dispenseNumber = ''
      let invoiceId = ''
      let chargedPaise = 0
      const handed: string[] = []

      await transaction(async () => {
        const rx = await db.prepare(
          `select p.id, p.prescription_number, p.patient_id, p.encounter_id, p.supply_in_parts,
                  to_char(p.valid_until, 'YYYY-MM-DD') as valid_until,
                  (p.valid_until < ${CLINIC_TODAY}) as expired
             from prescriptions p where p.id=? for update`,
        ).get(prescriptionId) as {
          id: string; prescription_number: string; patient_id: string
          encounter_id: string | null; supply_in_parts: boolean
          valid_until: string; expired: boolean
        } | undefined
        if (!rx) throw new Error('Prescription was not found.')

        const lines = await db.prepare(
          `select * from prescription_line_supply where prescription_id=? order by line_number`,
        ).all(prescriptionId) as SupplyRow[]

        const unreadable = lines.filter((line) => line.needs_review)
        if (unreadable.length > 0) {
          const first = unreadable[0]
          const missing = first.effective_medicine_id === null
            ? 'which medicine it was'
            : 'what quantity it authorized'
          throw new Error(
            `Line ${first.line_number} (${first.medicine_name_snapshot}) is from before this ` +
            `system and does not record ${missing}. A doctor must resolve it before anything ` +
            `is handed over.`,
          )
        }

        // Nothing supplied yet is a first supply and is always in time; the
        // validity date governs the REMAINDER, which is what policy register 18
        // is about.
        const suppliedSoFar = lines.reduce((total, line) => total + Number(line.supplied), 0)
        if (rx.expired) {
          throw new Error(
            `This prescription could be supplied until ${rx.valid_until}. ` +
            `${suppliedSoFar > 0 ? 'The remainder needs' : 'Supplying it now needs'} a new or amended order from the doctor.`,
          )
        }

        // What the counter asked for, or everything that can still be supplied.
        const asked = requested.length > 0
          ? requested.map((entry) => ({
            lineId: value(entry, 'prescriptionLineId'),
            quantity: optionalPositiveInteger(entry, 'quantity'),
            medicineId: optional(entry, 'medicineId'),
            substitutionReason: optional(entry, 'substitutionReason'),
          }))
          : lines.filter((line) => line.supplyable).map((line) => ({
            lineId: line.id, quantity: undefined as number | undefined,
            medicineId: '', substitutionReason: '',
          }))

        if (asked.length === 0) throw new Error('There is nothing left to hand over on this prescription.')

        dispenseNumber = await sequence('DSP')
        await db.prepare(
          `insert into dispenses
            (id,dispense_number,prescription_id,patient_id,idempotency_key,status,note,
             dispensed_by,dispensed_at)
           values (?,?,?,?,?, 'completed', ?, ?, now())`,
        ).run(
          dispenseId, dispenseNumber, prescriptionId, rx.patient_id, idempotencyKey,
          optional(payload, 'note'), session.staffId,
        )

        invoiceId = await openInvoice({
          patientId: rx.patient_id, encounterId: rx.encounter_id, actorId: session.staffId,
        })

        for (const entry of asked) {
          const line = lines.find((row) => row.id === entry.lineId)
          if (!line) throw new Error('That prescription line is not on this prescription.')

          if (line.outcome) {
            throw new Error(
              `Line ${line.line_number} (${line.medicine_name_snapshot}) is recorded as ` +
              `${line.outcome.replace('_', ' ')} and supplies nothing further.`,
            )
          }
          if (!line.supplyable) {
            throw new Error(
              `Line ${line.line_number} (${line.medicine_name_snapshot}) has nothing left to supply.`,
            )
          }

          const remaining = Number(line.remaining)
          const quantity = entry.quantity ?? remaining
          if (quantity > remaining) {
            throw new Error(
              `Line ${line.line_number} (${line.medicine_name_snapshot}) has ${remaining} left of ` +
              `${line.effective_quantity} prescribed. ${quantity} cannot be handed over.`,
            )
          }
          if (!rx.supply_in_parts && quantity < remaining) {
            throw new Error(
              `${rx.prescription_number} is marked to be supplied in one go. ` +
              `Hand over all ${remaining} of line ${line.line_number}, or none of it.`,
            )
          }

          /*
           * Substitution, and the narrow door policy register 21 leaves open.
           *
           * A pharmacist may never change the clinical drug, the dose, the
           * frequency or the duration, and may never substitute against a
           * brand-specific prescription. The single case allowed is a
           * genuinely GENERIC order — the doctor chose an unbranded product —
           * where the in-stock brand's ingredient(s), strength, form, route
           * and release characteristics match exactly. "Exactly" is not a
           * judgement made here: both products must point at the SAME clinical
           * drug row, which Slice 3 built precisely so that this question has
           * an answer rather than an opinion.
           */
          let medicineId = String(line.effective_medicine_id)
          let substitutedFor: string | null = null
          if (entry.medicineId && entry.medicineId !== medicineId) {
            const prescribed = await db.prepare(
              'select id,name,brand_name,clinical_drug_id from medicines where id=?',
            ).get(medicineId) as {
              id: string; name: string; brand_name: string; clinical_drug_id: string | null
            } | undefined
            const offered = await db.prepare(
              'select id,name,brand_name,clinical_drug_id from medicines where id=? and active=1',
            ).get(entry.medicineId) as {
              id: string; name: string; brand_name: string; clinical_drug_id: string | null
            } | undefined
            if (!offered) throw new Error('That substitute is not in the active formulary.')
            if (!prescribed?.clinical_drug_id || !offered.clinical_drug_id) {
              throw new Error(
                `${prescribed?.name ?? 'That medicine'} is not linked to a clinical drug, so no substitution can be checked. ` +
                'A doctor must amend the prescription.',
              )
            }
            if (prescribed.brand_name) {
              throw new Error(
                `${prescribed.name} was prescribed by brand. Only the doctor can authorize a different product.`,
              )
            }
            if (prescribed.clinical_drug_id !== offered.clinical_drug_id) {
              throw new Error(
                `${offered.name} is not the same clinical drug as ${prescribed.name}. Only the doctor can change what was prescribed.`,
              )
            }
            if (!entry.substitutionReason) {
              throw new Error('Say why a different product is being supplied.')
            }
            substitutedFor = prescribed.clinical_drug_id
            medicineId = offered.id
          }

          const dispenseLineId = randomUUID()
          await db.prepare(
            `insert into dispense_lines
              (id,dispense_id,prescription_line_id,medicine_id,quantity,
               substituted_for_clinical_drug_id,substitution_reason)
             values (?,?,?,?,?,?,?)`,
          ).run(
            dispenseLineId, dispenseId, line.id, medicineId, quantity,
            substitutedFor, entry.substitutionReason,
          )

          const allocations = await allocateFefo({
            medicineId, quantity, actorId: session.staffId,
            referenceType: 'prescription', referenceId: prescriptionId,
          })

          let linePaise = 0
          for (const allocation of allocations) {
            await db.prepare(
              `insert into dispense_allocations
                (id,dispense_line_id,batch_id,quantity,unit_amount,stock_movement_id)
               values (?,?,?,?,?,?)`,
            ).run(
              randomUUID(), dispenseLineId, allocation.batchId, allocation.quantity,
              money(allocation.unitAmountPaise), allocation.movementId,
            )
            linePaise += times(allocation.unitAmountPaise, allocation.quantity)
          }

          const medicine = await db.prepare('select name,strength,base_unit,unit from medicines where id=?')
            .get(medicineId) as { name: string; strength: string; base_unit: string; unit: string }
          const unit = medicine.base_unit || medicine.unit

          // Medicine is charged for what was actually handed over, and nothing
          // else. A later supply of the remainder adds only that later charge.
          await addInvoiceLine(invoiceId, {
            source: 'prescription',
            sourceKey: `dispense:${dispenseLineId}`,
            description: `${medicine.name} ${medicine.strength}`.trim(),
            quantity,
            unitAmountPaise: allocations.length === 1
              ? allocations[0].unitAmountPaise
              : Math.round(linePaise / quantity),
            amountPaise: linePaise,
            dispenseLineId,
            medicineId,
          })
          chargedPaise += linePaise
          handed.push(`${medicine.name} ${quantity} ${plural(unit, quantity)}`)
        }

        // Kept up to date for every reader that still asks the old question.
        // It is derived, not decided: the prescription is finished when no line
        // can still be supplied.
        const after = await db.prepare(
          `select count(*)::int as open from prescription_line_supply
            where prescription_id=? and supplyable`,
        ).get(prescriptionId) as { open: number }
        await db.prepare(
          `update prescriptions set dispensed_at = case when ? then coalesce(dispensed_at, ?) else null end
            where id=?`,
        ).run(Number(after.open) === 0, isoNow(), prescriptionId)

        await audit(session.staffId, 'prescription.dispensed', 'prescription', prescriptionId,
          `${dispenseNumber}: ${handed.join(', ')}` +
          `${Number(after.open) > 0 ? ' — remainder to collect' : ''}`)
      })

      return {
        message: chargedPaise > 0
          ? `Handed over. ${rupees(chargedPaise)} added to the bill.`
          : 'Handed over.',
        data: { dispenseId, dispenseNumber, invoiceId, charged: money(chargedPaise), lines: handed },
      }
    }

    /*
     * A dispense that should not have happened.
     *
     * The stock comes back to QUARANTINE, never to the sellable shelf: it has
     * left the counter, and policy register 47 is explicit that returned
     * medicine does not become saleable again by itself. The charge is answered
     * by a compensating invoice line rather than by deleting the original,
     * because the patient was charged and that is a fact.
     */
    case 'reverse_dispense': {
      requireRole(session, 'admin')
      const dispenseId = value(payload, 'dispenseId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        const dispense = await db.prepare(
          `select id,dispense_number,prescription_id,status from dispenses where id=? for update`,
        ).get(dispenseId) as {
          id: string; dispense_number: string; prescription_id: string; status: string
        } | undefined
        if (!dispense) throw new Error('That hand-over was not found.')
        if (dispense.status === 'reversed') throw new Error('That hand-over is already reversed.')

        const allocations = await db.prepare(
          `select a.id, a.batch_id, a.quantity, a.unit_amount, l.medicine_id, l.id as dispense_line_id
             from dispense_allocations a join dispense_lines l on l.id = a.dispense_line_id
            where l.dispense_id=?`,
        ).all(dispenseId) as Array<{
          id: string; batch_id: string; quantity: number; unit_amount: string
          medicine_id: string; dispense_line_id: string
        }>

        let refundedPaise = 0
        for (const allocation of allocations) {
          await moveStock({
            batchId: allocation.batch_id, medicineId: allocation.medicine_id,
            bucket: 'quarantine', delta: Number(allocation.quantity),
            movementType: 'dispense_reversal', referenceType: 'dispense', referenceId: dispenseId,
            actorId: session.staffId, approvedBy: session.staffId,
            reason: `Hand-over ${dispense.dispense_number} reversed: ${reason}`,
          })
          refundedPaise += times(parseMoney(allocation.unit_amount, 'price'), Number(allocation.quantity))
        }

        const charged = await db.prepare(
          `select l.invoice_id, sum(l.amount) as amount from invoice_lines l
             join dispense_lines d on d.id = l.dispense_line_id
            where d.dispense_id=? group by l.invoice_id`,
        ).all(dispenseId) as Array<{ invoice_id: string; amount: string }>

        /*
         * The charge is answered by a credit line, not by editing the line
         * that made it.
         *
         * An `adjustment` line is the only kind that may be negative, and it
         * is the whole reason that exception exists: the original charge stays
         * on the bill exactly as it was printed, and the bill's total comes
         * down because something was added to it rather than because something
         * was changed.
         */
        for (const row of charged) {
          const amountPaise = parseBalance(row.amount, 'charge')
          await addInvoiceLine(row.invoice_id, {
            source: 'adjustment',
            sourceKey: `dispense-reversal:${dispenseId}:${row.invoice_id}`,
            description: `Credit for reversed hand-over ${dispense.dispense_number}: ${reason}`,
            quantity: 1,
            unitAmountPaise: -amountPaise,
            amountPaise: -amountPaise,
          })
        }

        await db.prepare(
          `update dispenses set status='reversed', reversed_by=?, reversed_at=now(), reversal_reason=?
            where id=?`,
        ).run(session.staffId, reason, dispenseId)
        await db.prepare('update prescriptions set dispensed_at=null where id=?')
          .run(dispense.prescription_id)

        await audit(session.staffId, 'dispense.reversed', 'dispense', dispenseId,
          `${dispense.dispense_number} reversed; ${allocations.length} allocation(s) worth ` +
          `${rupees(refundedPaise)} returned to quarantine: ${reason}`)
      })
      return {
        message: 'Hand-over reversed. The medicine is in quarantine and does not go back on the shelf by itself.',
      }
    }

    /*
     * A counter sale.
     *
     * Anonymous sales are allowed for appropriately classified OTC products and
     * must be paid in full at the time (policy register 45, 46). A registered
     * patient may part-pay or pay later. An unreviewed classification cannot be
     * sold anonymously at all, which is the whole reason the classification has
     * a verification column rather than only a value.
     */
    case 'otc_sale': {
      /*
       * Pharmacy alone. Same rule as `dispense_rx` and for the same reason:
       * this is medicine crossing the counter, and an over-the-counter sale is
       * the path with no prescription behind it, so the pharmacist's judgement
       * is the only check there is. `otc_return` keeps the administrator,
       * because a return is a correction.
       */
      requireRole(session, 'pharmacy')
      const idempotencyKey = optional(payload, 'idempotencyKey') || `otc:${randomUUID()}`
      const patientId = optional(payload, 'patientId') || null

      const already = await db.prepare(
        'select id, receipt_number from otc_sales where idempotency_key=?',
      ).get(idempotencyKey) as { id: string; receipt_number: string } | undefined
      if (already) {
        return {
          message: `${already.receipt_number} was already rung up. Nothing was sold twice.`,
          data: { saleId: already.id, receiptNumber: already.receipt_number, duplicate: true },
        }
      }

      const rawLines = Array.isArray(payload.lines) ? payload.lines as Payload[] : []
      if (rawLines.length === 0) throw new Error('Add at least one medicine.')
      const parts = paymentParts(payload)

      const saleId = randomUUID()
      let receiptNumber = ''
      let invoiceId = ''
      let totalPaise = 0
      const receipts: string[] = []

      await transaction(async () => {
        if (patientId) {
          const patient = await db.prepare('select id from patients where id=?').get(patientId)
          if (!patient) throw new Error('That patient was not found.')
        }

        receiptNumber = await sequence('OTC')
        invoiceId = await openInvoice({
          patientId, encounterId: optional(payload, 'encounterId') || null, actorId: session.staffId,
        })

        await db.prepare(
          `insert into otc_sales
            (id,receipt_number,total,payment_method,lines_json,created_by,created_at,
             patient_id,invoice_id,status,idempotency_key)
           values (?,?,0,null,'[]',?,?,?,?, 'completed', ?)`,
        ).run(saleId, receiptNumber, session.staffId, isoNow(), patientId, invoiceId, idempotencyKey)

        let lineNumber = 0
        for (const raw of rawLines) {
          lineNumber += 1
          const medicineId = value(raw, 'medicineId')
          const medicine = await db.prepare(
            `select m.id, m.name, m.strength, m.sale_class, m.schedule, m.base_unit, m.unit,
                    m.schedule_verified_at,
                    p.package_version_id, p.base_unit as package_base_unit
               from medicines m
               left join medicine_active_package p on p.medicine_id = m.id
              where m.id=? and m.active=1`,
          ).get(medicineId) as {
            id: string; name: string; strength: string; sale_class: string; schedule: string
            base_unit: string; unit: string; schedule_verified_at: string | null
            package_version_id: string | null; package_base_unit: string | null
          } | undefined
          if (!medicine) throw new Error(`Line ${lineNumber}: that medicine is not in the active formulary.`)

          if (medicine.sale_class !== 'otc') {
            throw new Error(
              `${medicine.name} is not an over-the-counter medicine. It needs a prescription.`,
            )
          }
          if (!patientId) {
            if (medicine.schedule === 'unset' || !medicine.schedule_verified_at) {
              throw new Error(
                `${medicine.name} has not had its regulatory class reviewed by a pharmacist, ` +
                'so it cannot be sold anonymously. Record the sale against a registered patient, ' +
                'or classify it first.',
              )
            }
            if (medicine.schedule !== 'OTC') {
              throw new Error(
                `${medicine.name} is Schedule ${medicine.schedule} and cannot be sold across the counter without a prescription.`,
              )
            }
          }

          // What the counter chose: a package level and a count, a plain base
          // quantity, or both. Slice 3's ladder does the conversion, and it
          // refuses a level that is not configured sellable.
          const entries = packageEntries(raw.entry, 'sale')
          const flat = optionalPositiveInteger(raw, 'quantity')
          let quantity = 0
          let levelName = ''
          let levelCount: number | null = null

          if (entries.length > 0) {
            if (!medicine.package_version_id) {
              throw new Error(`${medicine.name} has no verified package, so it can only be sold by the ${medicine.base_unit || medicine.unit}.`)
            }
            const ladder = await ladderRows(
              medicine.package_base_unit ?? medicine.base_unit, medicine.package_version_id,
            )
            quantity = baseQuantityOf(ladder, entries, { require: 'sellable' })
            const first = entries.find((entry) => entry.count > 0)
            if (first) {
              levelName = levelNamed(ladder, first.levelName).levelName
              levelCount = first.count
            }
          } else if (flat !== undefined) {
            /*
             * A plain quantity, and it still has to obey the package.
             *
             * This branch existed as the path for a product with no package at
             * all, and it took any positive integer — so a medicine whose base
             * level was deliberately configured NOT sellable, a sealed bottle
             * that may only leave whole, could still be sold loose by sending
             * a number instead of a level. The rule belongs to the package, so
             * it is asked of the package wherever one exists.
             */
            if (medicine.package_version_id) {
              const ladder = await ladderRows(
                medicine.package_base_unit ?? medicine.base_unit, medicine.package_version_id,
              )
              quantity = baseQuantityOf(
                ladder,
                [{ levelName: ladder.levels[0].levelName, count: flat }],
                { require: 'sellable' },
              )
              levelName = ladder.levels[0].levelName
            } else {
              quantity = flat
              levelName = medicine.base_unit || medicine.unit
            }
            levelCount = flat
          } else {
            throw new Error(`Line ${lineNumber}: enter how many.`)
          }

          const otcLineId = randomUUID()
          const allocations = await allocateFefo({
            medicineId, quantity, actorId: session.staffId,
            referenceType: 'otc_sale', referenceId: saleId,
          })

          let linePaise = 0
          for (const allocation of allocations) {
            linePaise += times(allocation.unitAmountPaise, allocation.quantity)
          }

          await db.prepare(
            `insert into otc_lines
              (id,otc_sale_id,line_number,medicine_id,package_level_name,package_count,
               quantity,unit_amount,amount)
             values (?,?,?,?,?,?,?,?,?)`,
          ).run(
            otcLineId, saleId, lineNumber, medicineId, levelName, levelCount, quantity,
            money(Math.round(linePaise / quantity)), money(linePaise),
          )

          for (const allocation of allocations) {
            await db.prepare(
              `insert into otc_allocations
                (id,otc_line_id,batch_id,quantity,unit_amount,stock_movement_id)
               values (?,?,?,?,?,?)`,
            ).run(
              randomUUID(), otcLineId, allocation.batchId, allocation.quantity,
              money(allocation.unitAmountPaise), allocation.movementId,
            )
          }

          await addInvoiceLine(invoiceId, {
            source: 'otc',
            sourceKey: `otc:${otcLineId}`,
            description: `${medicine.name} ${medicine.strength}`.trim(),
            quantity,
            unitAmountPaise: Math.round(linePaise / quantity),
            amountPaise: linePaise,
            otcLineId,
            medicineId,
          })
          totalPaise += linePaise
        }

        await db.prepare('update otc_sales set total=? where id=?').run(money(totalPaise), saleId)

        const takenPaise = sumMoney(parts.map((part) => part.amountPaise))
        if (!patientId && takenPaise < totalPaise) {
          throw new Error(
            `An anonymous sale is paid in full at the counter. ${rupees(totalPaise)} is due and ` +
            `${rupees(takenPaise)} was offered — take the rest, or record the sale against a registered patient.`,
          )
        }
        if (takenPaise > totalPaise) {
          throw new Error(`${rupees(takenPaise)} was offered against a bill of ${rupees(totalPaise)}.`)
        }

        if (parts.length > 0) {
          const result = await recordPayments({
            invoiceId, patientId, parts, idempotencyKey, actorId: session.staffId,
          })
          receipts.push(...result.receipts)
        }

        await audit(session.staffId, 'otc.sale', 'otc_sale', saleId,
          `${receiptNumber} ${rupees(totalPaise)}` +
          `${patientId ? '' : ' (anonymous)'}` +
          `${parts.length === 0 ? ' — unpaid' : ` — ${parts.map((part) => `${part.method} ${rupees(part.amountPaise)}`).join(' + ')}`}`)
      })

      return {
        message: parts.length > 0
          ? `Sold. ${rupees(totalPaise)} collected.`
          : `Sold. ${rupees(totalPaise)} added to the patient's balance.`,
        data: { saleId, receiptNumber, invoiceId, total: money(totalPaise), receipts },
      }
    }

    /*
     * A return across the counter.
     *
     * Policy register 47: pharmacist or admin authorization and a reason, the
     * medicine into quarantine rather than back onto the shelf, and the
     * original sale left exactly as it was.
     */
    case 'otc_return': {
      requireRole(session, 'admin', 'pharmacy')
      const otcLineId = value(payload, 'otcLineId')
      const quantity = Math.floor(numberValue(payload, 'quantity', 1))
      const reason = value(payload, 'reason')
      const refundParts = paymentParts(payload, 'refund')

      let refundedPaise = 0
      await transaction(async () => {
        const line = await db.prepare(
          `select l.id, l.otc_sale_id, l.medicine_id, l.quantity, l.unit_amount,
                  s.receipt_number, s.patient_id, s.invoice_id, m.name
             from otc_lines l
             join otc_sales s on s.id = l.otc_sale_id
             join medicines m on m.id = l.medicine_id
            where l.id=? for update`,
        ).get(otcLineId) as {
          id: string; otc_sale_id: string; medicine_id: string; quantity: number
          unit_amount: string; receipt_number: string; patient_id: string | null
          invoice_id: string | null; name: string
        } | undefined
        if (!line) throw new Error('That sale line was not found.')

        const returned = await db.prepare(
          'select coalesce(sum(quantity),0)::int as returned from otc_returns where otc_line_id=?',
        ).get(otcLineId) as { returned: number }
        const left = Number(line.quantity) - Number(returned.returned)
        if (quantity > left) {
          throw new Error(
            `${line.name}: ${left} of ${line.quantity} on ${line.receipt_number} can still be returned.`,
          )
        }

        const unitPaise = parseMoney(line.unit_amount, 'price')
        refundedPaise = times(unitPaise, quantity)
        const offered = sumMoney(refundParts.map((part) => part.amountPaise))
        if (offered > refundedPaise) {
          throw new Error(
            `${rupees(offered)} would be refunded against ${rupees(refundedPaise)} of goods.`,
          )
        }

        // Back into quarantine, against the batches it actually came from.
        let toReturn = quantity
        const allocations = await db.prepare(
          'select id,batch_id,quantity from otc_allocations where otc_line_id=? order by id',
        ).all(otcLineId) as Array<{ id: string; batch_id: string; quantity: number }>
        for (const allocation of allocations) {
          if (toReturn === 0) break
          const take = Math.min(Number(allocation.quantity), toReturn)
          await moveStock({
            batchId: allocation.batch_id, medicineId: line.medicine_id,
            bucket: 'quarantine', delta: take,
            movementType: 'otc_return', referenceType: 'otc_sale', referenceId: line.otc_sale_id,
            actorId: session.staffId, approvedBy: session.staffId,
            reason: `Returned against ${line.receipt_number}: ${reason}`,
          })
          toReturn -= take
        }
        if (toReturn > 0) {
          throw new Error('That sale has no batch record to return the medicine to. Record it as a stock adjustment instead.')
        }

        await db.prepare(
          `insert into otc_returns
            (id,otc_sale_id,otc_line_id,quantity,reason,refund_amount,authorized_by,created_at)
           values (?,?,?,?,?,?,?,now())`,
        ).run(
          randomUUID(), line.otc_sale_id, otcLineId, quantity, reason, money(offered),
          session.staffId,
        )

        if (refundParts.length > 0 && line.invoice_id) {
          await recordPayments({
            invoiceId: line.invoice_id, patientId: line.patient_id, parts: refundParts,
            idempotencyKey: `refund:${otcLineId}:${randomUUID()}`,
            actorId: session.staffId, kind: 'refund',
            note: `Return against ${line.receipt_number}: ${reason}`,
          })
        }

        await audit(session.staffId, 'otc.returned', 'otc_sale', line.otc_sale_id,
          `${quantity} ${line.name} returned against ${line.receipt_number} into quarantine` +
          `${offered > 0 ? `, ${rupees(offered)} refunded` : ''}: ${reason}`)
      })

      return {
        message: 'Return recorded. The medicine is in quarantine and does not go back on the shelf by itself.',
      }
    }

    /*
     * Take money.
     *
     * Cash, UPI, card, or any split of them, against one bill. Part payment is
     * simply taking less than is due; pay later is taking nothing at all, and
     * is refused for an anonymous bill because there is nobody to owe it.
     */
    case 'take_payment': {
      /*
       * The payment counter: admin and pharmacy, and nobody else.
       *
       * The nurse used to be here, inherited from the retired application
       * rather than decided. Policy register item 17 now names the roles: a
       * doctor does not collect, and neither does a nurse. If no authorised
       * counter staff member is on, the balance stays pending — which is a
       * real outcome the system already models, not an error state.
       */
      requireRole(session, 'admin', 'pharmacy')
      const invoiceId = value(payload, 'invoiceId')
      const idempotencyKey = optional(payload, 'idempotencyKey') || `pay:${randomUUID()}`
      const parts = paymentParts(payload)
      if (parts.length === 0) throw new Error('Enter what was paid, and how.')

      const already = await db.prepare(
        'select receipt_number from payments where idempotency_key=?',
      ).get(`${idempotencyKey}:1`) as { receipt_number: string } | undefined
      if (already) {
        return {
          message: `Receipt ${already.receipt_number} was already taken. Nothing was charged twice.`,
          data: { receipts: [already.receipt_number], duplicate: true },
        }
      }

      let receipts: string[] = []
      let takenPaise = 0
      let dueAfter = 0

      await transaction(async () => {
        const invoice = await db.prepare(
          'select id,invoice_number,patient_id,status from invoices where id=? for update',
        ).get(invoiceId) as {
          id: string; invoice_number: string; patient_id: string | null; status: string
        } | undefined
        if (!invoice) throw new Error('That bill was not found.')
        if (invoice.status === 'void') throw new Error('That bill has been voided.')

        const due = await dueOn(invoiceId)
        takenPaise = sumMoney(parts.map((part) => part.amountPaise))
        if (takenPaise > due) {
          throw new Error(
            due <= 0
              ? `${invoice.invoice_number} is already settled.`
              : `${rupees(due)} is due on ${invoice.invoice_number} and ${rupees(takenPaise)} was offered.`,
          )
        }

        const result = await recordPayments({
          invoiceId, patientId: invoice.patient_id, parts, idempotencyKey,
          actorId: session.staffId, note: optional(payload, 'note'),
        })
        receipts = result.receipts
        dueAfter = due - takenPaise

        await audit(session.staffId, 'payment.taken', 'invoice', invoiceId,
          `${invoice.invoice_number}: ${parts.map((part) => `${part.method} ${rupees(part.amountPaise)}`).join(' + ')}` +
          `${dueAfter > 0 ? `, ${rupees(dueAfter)} still due` : ' — settled'}`)
      })

      return {
        message: dueAfter > 0
          ? `${rupees(takenPaise)} taken. ${rupees(dueAfter)} still due.`
          : `${rupees(takenPaise)} taken. Settled.`,
        data: { receipts, taken: money(takenPaise), due: money(dueAfter) },
      }
    }

    /*
     * Money back, or money that never arrived.
     *
     * A REFUND is a payment in the other direction and reduces what has been
     * paid. A REVERSAL says the payment never happened at all — a mis-keyed
     * card, a UPI that failed after the receipt printed — and removes it from
     * the arithmetic entirely. They are not the same and the day book needs to
     * tell them apart.
     */
    case 'reverse_payment': {
      requireRole(session, 'admin')
      const paymentId = value(payload, 'paymentId')
      const reason = value(payload, 'reason')
      let receiptNumber = ''

      await transaction(async () => {
        const payment = await db.prepare(
          'select id,receipt_number,kind,status,amount from payments where id=? for update',
        ).get(paymentId) as {
          id: string; receipt_number: string; kind: string; status: string; amount: string
        } | undefined
        if (!payment) throw new Error('That receipt was not found.')
        if (payment.status === 'reversed') throw new Error('That receipt is already reversed.')
        receiptNumber = payment.receipt_number

        /*
         * ── WHAT THIS REVERSAL WOULD DO TO EVERY BILL IT TOUCHES ──────────
         *
         * A receipt can be split across more than one bill, and saying "the
         * money never arrived" says it about all of them at once. So the
         * question is not whether this receipt can be reversed but whether
         * EVERY bill it is allocated to survives the arithmetic — and if one
         * does not, none of it happens. There is no partial reversal: a
         * receipt is one event and it either happened or it did not.
         *
         * The order matters as much as the check. Take ₹100, refund ₹40, then
         * reverse the ₹100: what is left is a bill with minus forty rupees
         * paid against it and two receipts that both describe real money.
         * Nothing in the schema forbids it and no later screen can undo it,
         * so it is forbidden here — reverse the ₹40 refund first (policy
         * register 51) and the ₹100 reversal then lands on zero.
         *
         * Locks: the receipt, then its bills in id order, which is the order
         * every other command in this file takes them in.
         */
        const links = await db.prepare(
          'select invoice_id, amount from payment_allocations where payment_id=? order by invoice_id',
        ).all(paymentId) as Array<{ invoice_id: string; amount: string }>

        for (const link of links) {
          await db.prepare('select id from invoices where id=? for update').get(link.invoice_id)
        }

        for (const link of links) {
          const balance = await balanceOf(link.invoice_id)
          // Stored, and constrained positive — an operator amount, not a
          // derived one, so it is read by the reader that refuses negatives.
          const allocated = parseMoney(link.amount, 'allocated amount')
          // Reversing money IN takes it back out of what has been paid;
          // reversing money OUT — an erroneous refund — puts it back.
          const after = payment.kind === 'refund'
            ? balance.paidPaise + allocated
            : balance.paidPaise - allocated
          if (after >= 0) continue

          // The refunds that would have to go first — never including the
          // receipt being reversed, which is the one thing that cannot be the
          // answer to its own refusal.
          const refunds = await db.prepare(
            `select y.receipt_number
               from payment_allocations a join payments y on y.id=a.payment_id
              where a.invoice_id=? and y.kind='refund' and y.status='received' and y.id<>?
              order by y.received_at, y.receipt_number`,
          ).all(link.invoice_id, paymentId) as Array<{ receipt_number: string }>

          throw new Error(
            `${balance.invoiceNumber} would be ${rupees(-after)} over-refunded if ` +
            `${payment.receipt_number} were reversed, so nothing has been reversed. ` +
            (refunds.length > 0
              ? `Reverse the refund${refunds.length > 1 ? 's' : ''} first ` +
                `(${refunds.map((row) => row.receipt_number).join(', ')}), then this receipt.`
              : `That bill is already under financial review.`),
          )
        }

        await db.prepare(
          `update payments set status='reversed', reversed_by=?, reversed_at=now(), reversal_reason=?
            where id=?`,
        ).run(session.staffId, reason, paymentId)
        await audit(session.staffId, 'payment.reversed', 'payment', paymentId,
          `${payment.receipt_number} (${payment.kind}, ` +
          `${rupees(parseMoney(payment.amount, 'amount'))}) reversed: ${reason}`)
      })
      return {
        message: `${receiptNumber} reversed. It keeps its number and stays on the record as reversed.`,
      }
    }

    case 'refund_payment': {
      requireRole(session, 'admin')
      const invoiceId = value(payload, 'invoiceId')
      const reason = value(payload, 'reason')
      const parts = paymentParts(payload, 'refund')
      if (parts.length === 0) throw new Error('Say how much is being refunded, and how.')

      const idempotencyKey = optional(payload, 'idempotencyKey') || `refund:${randomUUID()}`
      let receipts: string[] = []

      await transaction(async () => {
        /*
         * The lock, taken before the balance is read.
         *
         * Two admins refunding ₹100 each on a ₹100 bill in the same second is
         * the ordinary way an over-refund is created: both read `paid` as 100,
         * both decide 100 is refundable, and the bill ends at minus a hundred.
         * Locking the invoice row first — the same row `take_payment` and
         * `void_invoice` lock, in the same place — makes the second one read
         * the first one's refund and refuse.
         */
        const invoice = await db.prepare(
          'select id from invoices where id=? for update',
        ).get(invoiceId) as { id: string } | undefined
        if (!invoice) throw new Error('That bill was not found.')

        const balance = await balanceOf(invoiceId)
        const paid = balance.paidPaise
        if (paid < 0) throw overRefunded(balance)

        const refunding = sumMoney(parts.map((part) => part.amountPaise))
        if (refunding > paid) {
          throw new Error(
            paid === 0
              ? `Nothing has been paid on ${balance.invoiceNumber}, so ${rupees(refunding)} cannot be refunded.`
              : `${rupees(paid)} has been paid on ${balance.invoiceNumber}; ${rupees(refunding)} cannot be refunded.`,
          )
        }

        const result = await recordPayments({
          invoiceId, patientId: balance.patientId, parts, idempotencyKey,
          actorId: session.staffId, kind: 'refund', note: reason,
        })
        receipts = result.receipts

        await audit(session.staffId, 'payment.refunded', 'invoice', invoiceId,
          `${balance.invoiceNumber}: ${rupees(refunding)} refunded — ${reason}`)
      })
      return { message: 'Refund recorded against the bill.', data: { receipts } }
    }

    /*
     * Voiding a bill.
     *
     * It keeps its number and its lines. Policy register 24: a cancelled
     * transaction retains its number and its status, and numbers are never
     * silently deleted — a gap in a printed series is a question somebody asks.
     */
    case 'void_invoice': {
      requireRole(session, 'admin')
      const invoiceId = value(payload, 'invoiceId')
      const reason = value(payload, 'reason')

      await transaction(async () => {
        // Locked before the balance is read, so a payment landing at the same
        // moment is either included in the figure below or waits behind it.
        const invoice = await db.prepare(
          'select id,status from invoices where id=? for update',
        ).get(invoiceId) as { id: string; status: string } | undefined
        if (!invoice) throw new Error('That bill was not found.')
        if (invoice.status === 'void') throw new Error('That bill is already void.')

        /*
         * ── THE ONLY BALANCE A BILL MAY BE VOIDED ON IS EXACTLY ZERO ───────
         *
         * Policy register 49. Three cases, and the middle one used to be the
         * only one this command knew about:
         *
         *   ABOVE zero — money came in against it. Refund it first, or
         *   voiding the bill loses track of money the clinic is holding.
         *
         *   EXACTLY zero — nothing came in, or everything that came in has
         *   been refunded or reversed back to nothing. Void it.
         *
         *   BELOW zero — more went out than came in. This is not a bill that
         *   can be tidied away; it is an accounting exception, and voiding it
         *   would close the only record of where the money went. It used to
         *   reach `parseMoney`, which refused it with "amount paid cannot be
         *   negative" — a complaint about an input, printed at an admin who
         *   had not typed one. Now it says what is actually wrong.
         */
        const balance = await balanceOf(invoiceId)
        if (balance.paidPaise < 0) throw overRefunded(balance)
        if (balance.paidPaise > 0) {
          throw new Error(
            `${balance.invoiceNumber} has been paid against. Refund the payment first; voiding it would lose the money.`,
          )
        }

        await db.prepare(
          `update invoices set status='void', void_reason=?, voided_by=?, voided_at=now() where id=?`,
        ).run(reason, session.staffId, invoiceId)
        await audit(session.staffId, 'invoice.voided', 'invoice', invoiceId,
          `${balance.invoiceNumber} voided: ${reason}`)
      })
      return { message: 'Bill voided. It keeps its number and stays on the record.' }
    }

    /*
     * Clinical images are in images.ts — the one part of this application
     * where the authorization rule is the feature, and where it therefore
     * belongs in a file of its own.
     */
    default:
      return runImageCommand(session, action, payload)
  }
}
