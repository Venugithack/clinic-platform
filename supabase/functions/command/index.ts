import { runCommand } from '../_shared/commands.ts'
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
    return json({ ok: true, ...result })
  } catch (error) {
    // A refusal the clinic needs to read — "Only medicines marked OTC can be
    // sold here" — arrives as an exception and must reach the screen intact.
    const message =
      error instanceof Error ? error.message : 'The request could not be completed.'
    return json({ ok: false, message }, 400)
  }
})
