'use client'

import { createContext, useContext } from 'react'
import type { CommandResponse } from '@/lib/types'

/** Every write goes through one command endpoint. Names are unchanged. */
export type ActionRunner = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<CommandResponse>

/**
 * Whether a command is in flight.
 *
 * Four tablets share one clinic database, so a second tap while the first
 * request is still open is a duplicate bill or a duplicate stock movement.
 * Rather than thread a `busy` prop through every panel to every button, the
 * shell publishes it here and each control reads it — one source of truth for
 * "nothing may be pressed right now".
 */
export const BusyContext = createContext(false)

export function useBusy(): boolean {
  return useContext(BusyContext)
}
