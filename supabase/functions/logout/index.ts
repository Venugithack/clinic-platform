import { destroySession } from '../_shared/auth.ts'
import { json, preflight } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (token) await destroySession(token)

  return json({ ok: true, message: 'Signed out.' })
})
