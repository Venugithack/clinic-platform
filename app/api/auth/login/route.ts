import { NextResponse } from 'next/server'
import { createSession } from '@/lib/server/auth'

/**
 * Who is at the tablet.
 *
 * Used only to rate-limit wrong PINs, and only ever as an opaque key — see the
 * lockout note in lib/server/auth. Behind Cloudflare the real address is in
 * `cf-connecting-ip`; `x-forwarded-for` is a list and the client's is first.
 * With neither, everybody shares one bucket, which errs towards locking too
 * eagerly rather than not at all.
 */
function callerKey(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip')
  if (direct) return direct

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()

  return 'unknown-caller'
}

export async function POST(request: Request) {
  const body = (await request.json()) as { staffId?: string; pin?: string }
  const result = await createSession(body.staffId ?? '', body.pin ?? '', callerKey(request))

  if ('reason' in result) {
    // The wrong PIN and the unknown staff member give the same answer on
    // purpose: the lock screen already shows who works here, and confirming
    // which of them exists adds nothing except a way to enumerate them.
    const message =
      result.reason === 'locked'
        ? `Too many wrong PINs from this device. Try again in ${result.minutes} minutes.`
        : 'That PIN is not right.'

    return NextResponse.json({ ok: false, message }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true, message: 'Signed in.', session: result.session })
  response.cookies.set('jayamurugan_session', result.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 60,
  })
  return response
}
