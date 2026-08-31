import { NextResponse } from 'next/server'
import { lockScreenStaff } from '@/lib/server/auth'

export const dynamic = 'force-dynamic'

/**
 * The names on the lock screen, before anybody has signed in.
 *
 * Unauthenticated by necessity — you cannot ask someone to identify themselves
 * and also require them to be identified first. It returns a name and the roles
 * that name works in, and nothing else: no PIN material, no phone number, no
 * last-login. That is the same trade the old app made with its
 * `lock_screen_staff` view, and it is the reason this is a separate endpoint
 * rather than a slice of the snapshot.
 */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, staff: await lockScreenStaff() })
  } catch {
    // A clinic tablet opening before the database is reachable should say so on
    // the screen, not hang on a spinner with no explanation.
    return NextResponse.json(
      { ok: false, message: 'The clinic database is not reachable.' },
      { status: 503 },
    )
  }
}
