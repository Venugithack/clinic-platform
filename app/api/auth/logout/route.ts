import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { destroySession } from '@/lib/server/auth'

export async function POST() {
  const jar = await cookies()
  await destroySession(jar.get('jayamurugan_session')?.value)
  const response = NextResponse.json({ ok: true, message: 'Signed out.' })
  response.cookies.delete('jayamurugan_session')
  return response
}
