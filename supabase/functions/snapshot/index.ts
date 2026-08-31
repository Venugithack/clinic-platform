import { currentRevision } from '../_shared/db.ts'
import { readSnapshot } from '../_shared/snapshot.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'

/**
 * The clinic as of now — or "nothing has happened", which is the usual answer.
 *
 * The revision is read BEFORE the snapshot. Read after, a write landing
 * mid-read would be in the data and also counted in the revision the tablet
 * stores, and that tablet would never ask for the change again. Read first, the
 * worst case is one redundant fetch rather than a counter showing yesterday's
 * shelf.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const session = await sessionFrom(request, false)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  try {
    const revision = await currentRevision()

    const since = Number(new URL(request.url).searchParams.get('since') ?? Number.NaN)
    if (Number.isFinite(since) && since === revision) {
      return json({ ok: true, unchanged: true, revision })
    }

    return json({ ok: true, revision, snapshot: await readSnapshot(session) })
  } catch (error) {
    console.error('snapshot failed:', error)
    return json({ ok: false, message: 'The clinic database is not reachable.' }, 503)
  }
})
