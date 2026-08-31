import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/server/auth'
import { readSnapshot } from '@/lib/server/snapshot'

export const dynamic = 'force-dynamic'

export async function GET() {
  const jar = await cookies()
  const session = await getSession(jar.get('jayamurugan_session')?.value)
  if (!session) return NextResponse.json({ ok: false, message: 'Sign in required.' }, { status: 401 })
  return NextResponse.json({ ok: true, snapshot: await readSnapshot(session) })
}
