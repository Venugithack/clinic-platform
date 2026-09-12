import assert from 'node:assert/strict'
import { test } from 'node:test'
// Money has no imports of its own and no database, so the line between an
// amount a person typed and an amount the ledger computed can be checked by
// the gate that runs without Docker. Everything else about over-refunded bills
// needs a clinic; this does not.
import { money, parseBalance, parseMoney } from '../supabase/functions/_shared/money.ts'

test('a derived balance may be negative, and reading one does not raise', () => {
  // `jmc.invoice_balances.paid` really does come back as a negative string:
  // take ₹100, refund ₹40, reverse the ₹100, and minus forty rupees is the
  // arithmetic rather than a typo. Before `parseBalance` existed, every command
  // that read that column to decide what to tell the admin died on it first.
  assert.equal(parseBalance('-40.00', 'amount paid'), -4000)
  assert.equal(parseBalance('-0.01', 'amount paid'), -1)

  // And it is the same parser for the ordinary cases, so a balance column is
  // never read by two different rules depending on its sign.
  assert.equal(parseBalance('0.00', 'amount paid'), 0)
  assert.equal(parseBalance('300.00', 'amount paid'), 30000)
  assert.equal(parseBalance('1234.50', 'bill total'), 123450)
})

test('an amount typed at the counter still cannot be negative', () => {
  // The guard that matters. `signed` was added for the ledger's own figures,
  // and if it had leaked into the default a pharmacist could take a payment of
  // minus three hundred rupees and the bill would read as settled.
  assert.throws(
    () => parseMoney('-300.00', 'Payment 1'),
    /Payment 1 cannot be negative\./,
  )
  assert.throws(() => parseMoney(-1, 'Payment 1'), /cannot be negative/)
  assert.throws(() => parseMoney('-0.01', 'Refund 1'), /Refund 1 cannot be negative/)

  // Zero and above are read exactly as before.
  assert.equal(parseMoney('0', 'Payment 1'), 0)
  assert.equal(parseMoney('₹30.50', 'Payment 1'), 3050)
  assert.equal(parseMoney('1,234.50', 'Payment 1'), 123450)
})

test('an explicit minimum is still enforced, and says what it is', () => {
  assert.throws(
    () => parseMoney('4.99', 'Consultation fee', { min: 5 }),
    /Consultation fee must be at least ₹5\./,
  )
  assert.equal(parseMoney('5.00', 'Consultation fee', { min: 5 }), 500)
})

test('the old refusals survive the new option', () => {
  // A third decimal is a unit confusion or a typo, and rounding it silently is
  // how ₹1.005 becomes one rupee in one place and two in another.
  assert.throws(
    () => parseMoney('1.005', 'Payment 1'),
    /more than two decimal places/,
  )
  assert.throws(() => parseBalance('-1.005', 'amount paid'), /more than two decimal places/)

  assert.throws(() => parseMoney('', 'Payment 1'), /Payment 1 is required\./)
  assert.throws(() => parseBalance('', 'amount paid'), /amount paid is required\./)
  assert.throws(() => parseMoney('twelve', 'Payment 1'), /is not an amount in rupees/)

  // Ten digits before the point is what numeric(12,2) holds, on either side of
  // zero: a signed amount is not a licence to overflow the column.
  assert.throws(() => parseMoney('10000000000.00', 'Payment 1'), /larger than this clinic's ledger can hold/)
  assert.throws(() => parseBalance('-10000000000.00', 'amount paid'), /larger than this clinic's ledger can hold/)
})

test('a negative balance survives the round trip back into numeric', () => {
  // What is read out of `paid` has to be able to go back into a `numeric(12,2)`
  // parameter unchanged, or the figure on the financial review queue and the
  // figure in the refusal message are two different numbers.
  assert.equal(money(parseBalance('-40.00', 'amount paid')), '-40.00')
  assert.equal(money(parseBalance('-0.01', 'amount paid')), '-0.01')
  assert.equal(money(parseBalance('0.00', 'amount paid')), '0.00')
  assert.equal(money(parseBalance('-1234.05', 'amount paid')), '-1234.05')
})
