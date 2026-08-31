import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server/auth'
import { runCommand } from '@/lib/server/commands'

export async function POST(request: Request) {
  const jar = await cookies()
  const session = await getSession(jar.get('jayamurugan_session')?.value)
  if (!session) return NextResponse.json({ ok: false, message: 'Sign in required.' }, { status: 401 })

  try {
    const body = (await request.json()) as { action?: string; payload?: Record<string, unknown> }
    const result = await runCommand(session, body.action ?? '', body.payload ?? {})
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request could not be completed.'
    return NextResponse.json({ ok: false, message }, { status: 400 })
  }
}
