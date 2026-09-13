'use client'

import { createContext, useContext } from 'react'
import type { CommandResponse } from '@/lib/types'

/**
 * What a command answers.
 *
 * `CommandResponse` is the backend's shape and stays exactly as the backend
 * defines it. `unconfirmed` is the client's own addition and is never sent by
 * the server: it marks the case where the request may have reached the clinic
 * and the answer did not come back.
 *
 * It travels with `ok: false`, so all sixty-odd existing `if (!result.ok)`
 * call sites keep behaving correctly — they preserve the operator's typed work
 * and say nothing was saved. What changes is that a screen which cares about
 * the difference can now tell it, because "the clinic refused this" and
 * "nobody knows whether this happened" are different things to say to somebody
 * standing at a counter with a patient in front of them.
 */
export type ActionResult = CommandResponse & { unconfirmed?: boolean }

/** Every write goes through one command endpoint. Names are unchanged. */
export type ActionRunner = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<ActionResult>

/**
 * Whether a command is in flight.
 *
 * Four tablets share one clinic database, so a second tap while the first
 * request is still open is a duplicate bill or a duplicate stock movement.
 * Rather than thread a `busy` prop through every panel to every button, the
 * shell publishes it here and each control reads it — one source of truth for
 * "nothing may be pressed right now".
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is a floor, not the feedback. It is one boolean for the whole tablet, so
 * while a nurse saves one patient's vitals it also greys out the queue, and
 * while `Call in` is open on row two it relabels rows one and three — which is
 * exactly the confusion the plan's action-specific loading states exist to
 * remove. Anything a person watches while it happens should own a `useTask`
 * (`components/ui/task.tsx`) and show its own state; this remains underneath
 * as the crude guarantee that nothing else is pressed meanwhile.
 */
export const BusyContext = createContext(false)

export function useBusy(): boolean {
  return useContext(BusyContext)
}

/**
 * How fresh the clinic on this screen is.
 *
 * Published separately from action results on purpose. Both used to share one
 * notice slot, so a failed background poll and a failed hand-over arrived in
 * the same red strip in the same words, and a poll landing on the next tick
 * could quietly overwrite the confirmation of something a person had just
 * done. A stale queue and a refused command are not the same news and they do
 * not belong in the same place.
 */
export type Connection = {
  /** When the clinic last answered a refresh, as epoch milliseconds. */
  lastUpdated: number | null
  /** A refresh is open right now. */
  refreshing: boolean
  /** The last refresh did not come back. What is on screen may be old. */
  stale: boolean
}

export const ConnectionContext = createContext<Connection>({
  lastUpdated: null,
  refreshing: false,
  stale: false,
})

export function useConnection(): Connection {
  return useContext(ConnectionContext)
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
