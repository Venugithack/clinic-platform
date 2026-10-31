'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ThemeChoice } from '@/lib/types'

export type { ThemeChoice }

/** What the document is actually wearing once `system` has been resolved. */
export type ThemeApplied = 'paper' | 'night' | 'contrast'

export const THEMES: ReadonlyArray<{ id: ThemeChoice; label: string; hint: string }> = [
  { id: 'paper', label: 'Paper and ink', hint: 'Warm paper, green ink, white work surfaces' },
  { id: 'night', label: 'Night shift', hint: 'Low glare for a dim room' },
  { id: 'contrast', label: 'High contrast', hint: 'Stronger boundaries and focus marks' },
  { id: 'system', label: 'Match this tablet', hint: "Follow the device's own light or dark setting" },
]

/**
 * The device's fallback, and the ONLY thing stored in this browser.
 *
 * The appearance belongs to the staff member and lives on their row —
 * `jmc.staff.theme`, added by 20260917000000 — so it follows them onto whatever
 * tablet they pick up next. This key exists for the one moment the account
 * cannot answer: the lock screen, before anybody has said who they are, and the
 * boot script in `<head>` that runs before React exists at all.
 *
 * Writing it on every change is deliberate. It means the tablet a nurse hands
 * to the pharmacist opens in something sensible rather than flashing white in a
 * dark room while the session loads.
 */
const DEVICE_KEY = 'jayamurugan_theme'

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'paper' || value === 'night' || value === 'contrast' || value === 'system'
}

/**
 * The script in `<head>`, run while the HTML is still parsing.
 *
 * It has to be a string, it duplicates `resolveTheme` below, and the two have
 * to agree — so the rule is one line in both: a stored named theme wins,
 * otherwise the device's dark setting picks Night shift.
 *
 * It reads only the device key. Nothing knows who is signed in this early; the
 * account's own choice is applied the moment the session arrives, which is
 * after this has already prevented the flash.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('${DEVICE_KEY}');var t=(s==='paper'||s==='night'||s==='contrast')?s:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'night':'paper');document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

function prefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  } catch {
    return false
  }
}

export function resolveTheme(choice: ThemeChoice): ThemeApplied {
  if (choice === 'paper' || choice === 'night' || choice === 'contrast') return choice
  return prefersDark() ? 'night' : 'paper'
}

function readDevice(): ThemeChoice | null {
  try {
    const value = globalThis.localStorage?.getItem(DEVICE_KEY)
    return isChoice(value) ? value : null
  } catch {
    // Private browsing, or storage disabled by policy. The tablet still works;
    // it simply forgets the fallback when the tab closes.
    return null
  }
}

function writeDevice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') globalThis.localStorage?.removeItem(DEVICE_KEY)
    else globalThis.localStorage?.setItem(DEVICE_KEY, choice)
  } catch {
    // As above — not fatal.
  }
}

/** `useLayoutEffect` in the browser, `useEffect` while prerendering. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * The current appearance, and the way to change it.
 *
 * `account` is the signed-in staff member's stored choice, straight off
 * `session.theme`. When it is present it IS the answer — the device key is not
 * consulted, because the whole point is that the person's choice travels and
 * the tablet's does not. Pass `undefined` on the lock screen, where nobody is
 * identified and the device is all there is to go on.
 *
 * `save` persists the change to the account. The colour changes immediately
 * rather than waiting for the round trip — a tablet that stays white for a
 * second after somebody asks for Night shift feels broken — and if the clinic
 * refuses or never answers, the applied theme is put back to what the account
 * actually holds, so the screen and the record never disagree for long.
 */
export function useTheme({
  account,
  save,
}: {
  account?: ThemeChoice
  save?: (theme: ThemeChoice) => Promise<{ ok: boolean }>
} = {}): {
  choice: ThemeChoice
  applied: ThemeApplied
  setChoice: (next: ThemeChoice) => void
  /** True while the account is being told. The colour has already changed. */
  saving: boolean
} {
  const [local, setLocal] = useState<ThemeChoice | null>(null)
  const [applied, setApplied] = useState<ThemeApplied>('paper')
  const [saving, setSaving] = useState(false)

  // What is on screen: an unsaved local pick, else the account, else the
  // device, else follow the tablet.
  const choice = local ?? account ?? 'system'

  // Adopt whichever preference applies now, before paint. This also repairs
  // the attribute React's Strict Mode remount strips off <html> in
  // development, where the boot script's work would otherwise be thrown away.
  useIsomorphicLayoutEffect(() => {
    const wanted = local ?? account ?? readDevice() ?? 'system'
    const next = resolveTheme(wanted)
    document.documentElement.setAttribute('data-theme', next)
    setApplied(next)
  }, [local, account])

  /*
   * Once the account has caught up with the local pick, stop overriding it.
   *
   * Without this the optimistic value would outrank the account for the rest
   * of the session, so a second tablet's change — or an admin resetting
   * something — would never be seen.
   */
  useEffect(() => {
    if (local !== null && account === local) setLocal(null)
  }, [local, account])

  // A tablet switched to dark at dusk by its own schedule follows along, but
  // only for somebody who has not chosen for themselves.
  useEffect(() => {
    if (choice !== 'system') return
    let media: MediaQueryList
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const onChange = () => {
      const next = resolveTheme('system')
      document.documentElement.setAttribute('data-theme', next)
      setApplied(next)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [choice])

  const inFlight = useRef(false)

  const setChoice = useCallback(
    (next: ThemeChoice) => {
      // Immediately, and on the device too, so the next person to pick this
      // tablet up — and the boot script, which runs before anybody is known —
      // opens in something sensible rather than reverting to white.
      setLocal(next)
      writeDevice(next)

      if (!save || inFlight.current) return
      inFlight.current = true
      setSaving(true)
      void save(next)
        .then((result) => {
          // Refused, or the answer never came back. Put the screen back to
          // what the account actually holds rather than leaving it showing a
          // preference the clinic did not accept.
          if (!result.ok) setLocal(null)
        })
        .catch(() => setLocal(null))
        .finally(() => {
          inFlight.current = false
          setSaving(false)
        })
    },
    [save],
  )

  return { choice, applied, setChoice, saving }
}
