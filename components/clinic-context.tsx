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

/**
 * The patient everyone is currently working on.
 *
 * Queue, Vitals and Consult each used to keep their own `useState` for this,
 * which meant the same patient was chosen from the same all-patient dropdown
 * three times in one visit — once to take vitals, again to open the
 * consultation, and again by whoever picked up the next step. On a tablet, in
 * a corridor, with a similar name two rows below, that is not merely slow.
 *
 * So the selection lives above the workspaces and they read it. The plan's
 * first principle is that work follows the patient; this is the mechanism.
 *
 * `goTo` is here for the same reason. `Call in` has to select the patient AND
 * open Consult, and a screen that can do the first but not the second leaves
 * the doctor to navigate there himself and find nothing selected.
 */
export type SelectedPatient = {
  patientId: string
  /** Selecting nobody is valid — it is what a finished consultation leaves. */
  select: (patientId: string) => void
  /** Move to another workspace, keeping the selection. */
  goTo: (view: string) => void
}

export const SelectedPatientContext = createContext<SelectedPatient>({
  patientId: '',
  select: () => {},
  goTo: () => {},
})

export function useSelectedPatient(): SelectedPatient {
  return useContext(SelectedPatientContext)
}
