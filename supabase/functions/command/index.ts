import { runCommand } from '../_shared/commands.ts'
import { currentRevision } from '../_shared/db.ts'
import { readSnapshot } from '../_shared/snapshot.ts'
import { json, preflight, sessionFrom } from '../_shared/http.ts'

/** Everything the clinic does that changes something. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  // touch: true — doing something IS activity, and is what keeps the session
  // from reaching its idle lock while somebody is working.
  const session = await sessionFrom(request, true)
  if (!session) return json({ ok: false, message: 'Sign in required.' }, 401)

  try {
    const body = (await request.json()) as {
      action?: string
      payload?: Record<string, unknown>
    }
    const result = await runCommand(session, body.action ?? '', body.payload ?? {})

    // The screen needs the new state before it can redraw, and it used to go
    // and fetch it in a second request — so every tap in the clinic cost two
    // round trips end to end and the button sat busy through both. The write
    // has just happened on this connection; reading it back here costs about
    // thirty milliseconds and saves a whole trip to Mumbai and back.
    const revision = await currentRevision()
    return json({ ok: true, ...result, revision, snapshot: await readSnapshot(session) })
  } catch (error) {
    // A refusal the clinic needs to read — "Only medicines marked OTC can be
    // sold here" — arrives as an exception and must reach the screen intact.
    const message =
      error instanceof Error ? error.message : 'The request could not be completed.'
    return json({ ok: false, message }, 400)
  }
})
