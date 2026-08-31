import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server/auth'
import { currentRevision } from '@/lib/server/db'
import { readSnapshot } from '@/lib/server/snapshot'

export const dynamic = 'force-dynamic'

/**
 * The clinic, as of now — or "nothing has happened", which is the usual answer.
 *
 * Four tablets poll this every fifteen seconds and building the snapshot costs
 * sixteen queries, so answering every poll in full is about 150,000 queries a
 * day for a clinic where almost nothing happens between patients. With `since`,
 * a poll that finds nothing new costs one query, and the sixteen are spent only
 * when there is something to spend them on.
 *
 * ── WHY THE REVISION IS READ FIRST ──────────────────────────────────────────
 *
 * Read after the snapshot, a write landing mid-read would be included in the
 * data but also counted in the revision the tablet stores — and the tablet
 * would then never ask for it again. Read first, the revision is always at or
 * behind the data, so the worst case is one redundant refetch and the tablet
 * cannot silently miss a change. A wasted query is cheap; a counter tablet
 * showing yesterday's shelf is not.
 */
export async function GET(request: Request) {
  const jar = await cookies()
  // `touch: false` — polling is not activity.
  //
  // The tablets poll every fifteen seconds whether anybody is there or not, and
  // refreshing the session on each poll meant a tablet left on the counter
  // never reached its thirty-minute idle lock. On a device four people share,
  // that is the timeout not existing. Doing something — dispensing, billing,
  // recording vitals — goes through /api/command, which does refresh it.
  //
  // It also halves the cost of a quiet poll, from two queries to one.
  const session = await getSession(jar.get('jayamurugan_session')?.value, false)
  if (!session) return NextResponse.json({ ok: false, message: 'Sign in required.' }, { status: 401 })

  const revision = await currentRevision()

  const since = Number(new URL(request.url).searchParams.get('since') ?? Number.NaN)
  if (Number.isFinite(since) && since === revision) {
    return NextResponse.json({ ok: true, unchanged: true, revision })
  }

  return NextResponse.json({ ok: true, revision, snapshot: await readSnapshot(session) })
}
