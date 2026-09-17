/**
 * Saying the same thing twice, and being understood once.
 *
 * Four tablets share one clinic over a connection that drops. A command that
 * changes something can therefore reach the database, commit, and lose its
 * answer on the way home — and the tablet holding a spinner cannot tell that
 * from a request that never left the building. The application's whole posture
 * on this is that a failed write is an UNKNOWN outcome and never a known
 * nothing (`lib/api.ts`), which is only honest if the server can be asked the
 * same question twice and give the same answer.
 *
 * Five commands already did this, each in its own hand-rolled way: a key from
 * the browser, a pre-check, and a unique index behind it. This module is the
 * two pieces that were being written out longhand each time and the one piece
 * nobody had written at all.
 *
 * ── THE PIECE NOBODY HAD WRITTEN: THE FINGERPRINT ───────────────────────────
 *
 * A key on its own answers "have I seen this?" and then hands back whatever it
 * finds. That is safe exactly as long as the key and the request are welded
 * together. When they come apart it stops being a retry guard and becomes a
 * way to lose work: the counter met this when one payment key was minted per
 * session rather than per bill, a lost reply on one invoice kept the key, the
 * next invoice reused it, and the clinic answered the second payment with the
 * first one's receipt. Nothing was charged and the screen said it had been.
 *
 * A fingerprint closes that by storing what the request actually SAID beside
 * the key that named it. Same key and same material request is a retry and
 * gets the original outcome. Same key and a materially different request is a
 * client fault, and the only safe answer is to refuse it out loud — never to
 * reply with the earlier record's identity, which is how one patient's
 * consultation comes to be reported under another's.
 *
 * What counts as "material" belongs to each command, because only the command
 * knows which of its fields reach a durable record. What belongs here is that
 * the hash of a given set of facts does not depend on the order somebody
 * happened to write them in.
 */
import { createHash } from 'node:crypto'

/**
 * The advisory-lock namespace one consultation attempt serializes in.
 *
 * It lives in this module rather than beside either of its two users because
 * both of them have to pick the same number, and an advisory lock only holds
 * anybody back if everybody asks for the same one. `commands.ts` takes it
 * while signing and while resolving; `workspace.ts` tests it, without waiting,
 * to answer whether a signing is in flight.
 *
 * Arbitrary, like `bootstrap`'s. What matters is that nothing else in this
 * application uses this pair of integers for anything else.
 */
export const ATTEMPT_LOCK_NAMESPACE = 913_774

/**
 * And the namespace two RESOLUTIONS of one attempt serialize in, which is a
 * different lock for a reason that took a failing test to find.
 *
 * `ATTEMPT_LOCK_NAMESPACE` answers one question: is a signing in flight under
 * this reference? A resolution asks it as a TRY-lock, because the honest
 * answer to "somebody is signing right now" is that the prior outcome cannot
 * be established (owner item 73) rather than "wait and I will tell you".
 *
 * Two doctors resolving the same reference at the same moment are not that.
 * Sharing one lock made the loser's try fail and told it the outcome was
 * unsettled — when what had actually happened was that the other doctor had
 * just settled it, and the truthful answer was the determination they
 * recorded. So a resolution takes THIS lock first and blocking, which
 * serializes resolutions against each other, and then tries the other, which
 * fails closed only against a signing. A signing never takes this one, so the
 * two orders cannot form a cycle.
 */
export const ATTEMPT_RESOLUTION_LOCK_NAMESPACE = 913_775


/**
 * JSON with every object key in sorted order, all the way down.
 *
 * `JSON.stringify` preserves insertion order, so `{a, b}` and `{b, a}` are the
 * same facts and different text — and a fingerprint built on that would start
 * refusing honest retries the first time somebody reordered a field in the
 * object literal that builds it. Sorting makes the hash a property of the
 * facts rather than of the source code that assembled them.
 *
 * Arrays keep their order, because in a prescription the order of the lines is
 * itself a fact. `undefined` disappears exactly as it does in `JSON.stringify`,
 * so an absent field and a field set to undefined are the same request.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * The material identity of a request, as 64 hex characters.
 *
 * SHA-256 because this is a comparison and not a secret: nothing is unlocked
 * by producing a matching digest, the worst a collision could do is let a
 * genuinely different request replay as an earlier one, and at 2^-128 that is
 * not the risk worth designing against. What it must be is stable across
 * deployments, which rules out anything seeded per process.
 */
export function requestFingerprint(material: unknown): string {
  return createHash('sha256').update(canonicalJson(material)).digest('hex')
}

/**
 * Whether an error is Postgres refusing a duplicate, optionally on one index.
 *
 * This is the second half of every idempotent command here, and until now no
 * command had it: each one pre-checked for an existing row and relied on the
 * unique index only to turn a race into an ugly error rather than a duplicate.
 * That is the right order of protection — the check is the courteous path, the
 * index is the guarantee — but it leaves the racing caller holding a constraint
 * name instead of an answer, when the answer it needs (the other caller's
 * result) is sitting in the table.
 *
 * `postgres@3` surfaces the server's fields on the thrown object, so `code` is
 * the SQLSTATE and `constraint_name` is the index that refused. The name is
 * checked when one is asked for, because a command retrying on the wrong 23505
 * — a duplicate batch number, say — would loop rather than report.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const detail = error as { code?: unknown; constraint_name?: unknown; message?: unknown }
  if (String(detail.code) !== '23505') return false
  if (!constraint) return true
  if (String(detail.constraint_name ?? '') === constraint) return true
  // Older drivers and wrapped errors do not always carry the field; the server
  // always names the index in the message.
  return String(detail.message ?? '').includes(constraint)
}
