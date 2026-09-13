'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClinicSnapshot, CommandResponse, LockScreenStaffView, Role } from '@/lib/types'
import {
  BusyContext,
  ConnectionContext,
  SelectedPatientContext,
  type ActionResult,
  type ActionRunner,
} from './clinic-context'
import { NoAnswer, callApi, readToken, writeToken } from '@/lib/api'
import {
  landingFor,
  moreFor,
  navigationGroupsFor,
  primaryFor,
  ROLE_LABEL,
  type NavGroup,
  type View,
} from './navigation'
import { THEMES, useTheme, type ThemeChoice } from './theme'

/**
 * How many digits a PIN chosen from here has.
 *
 * Four, matching `requirePin` in the backend. It is a constant rather than a
 * literal because the number appears in six places on the first-start screen
 * — the dots, the two prompts, the confirm comparison, the ready check — and
 * five of those agreeing with the server while the sixth does not is an
 * administrator account on a clinic with no other staff that nobody can sign
 * into. The rule this must agree with is in
 * supabase/functions/bootstrap/index.ts.
 */
const NEW_PIN_LENGTH = 4
import { WorkspaceRouter } from './workspace-router'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  Field,
  Icon,
  Input,
  Notice,
  Numpad,
  Popover,
} from '@/components/ui'

/**
 * The application chrome: an identity header, the stations this role works out
 * of, and the workspace.
 *
 * Two shapes, for two jobs. A doctor, nurse or pharmacist repeats one job all
 * day and gets a short horizontal bar — three stations and **More** — so the
 * full width of the tablet belongs to the patient in front of them. An
 * administrator investigates exceptions across the whole clinic and keeps the
 * grouped rail, because twenty-one destinations is a building you navigate
 * rather than a job you repeat.
 *
 * Below 1024px the rail is not moved offscreen — it is not rendered. The
 * version this replaces translated it out of view with `-translate-x-full`,
 * where it stayed in the accessibility tree and the tab order, so a keyboard
 * user on a 768px tablet tabbed from the Menu button into twenty invisible
 * buttons. `hidden lg:flex` plus a real focus-trapping drawer is the whole fix.
 */

export function ClinicApp() {
  const [data, setData] = useState<ClinicSnapshot | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{
    tone: 'good' | 'bad' | 'unknown'
    message: string
  } | null>(null)
  const [view, setView] = useState<View>('overview')
  const [menuOpen, setMenuOpen] = useState(false)

  /**
   * How fresh the clinic on this screen is — kept apart from `notice`.
   *
   * These used to share one slot, so a background poll that failed on the
   * clinic Wi-Fi arrived in the same red strip, in the same voice, as a
   * hand-over the server had just refused; and a poll landing on the next tick
   * could overwrite the confirmation of something somebody had just done. A
   * stale queue and a refused command are not the same news.
   */
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [stale, setStale] = useState(false)

  /**
   * The patient the clinic is currently working on, held above the
   * workspaces rather than inside each of them.
   *
   * Queue, Vitals and Consult each used to keep their own copy, so the same
   * patient was chosen from the same all-patient dropdown three times in one
   * visit. The plan's first principle is that work follows the patient; this
   * is where that stops being a principle.
   *
   * It lives beside `view` because the two move together — `Call in` selects
   * a patient and opens Consult, and either half alone is useless.
   */
  const [selectedPatientId, setSelectedPatientId] = useState('')

  // The revision the screen is showing. A ref rather than state because it
  // must not re-create the poll on every tick.
  const revision = useRef<number | null>(null)

  /**
   * Everything a lost session has to forget.
   *
   * The selected patient is in here, and it is the reason this is a function
   * rather than four lines repeated twice. The 401 paths used to clear the
   * token, the session and the snapshot and leave `selectedPatientId` set; the
   * component never unmounts, so after the thirty-minute idle lock the next
   * person to pick that tablet up signed in and found the previous staff
   * member's patient already open, ready to have somebody else's vitals filed
   * against them.
   */
  const dropSession = useCallback(() => {
    writeToken(null)
    setHasSession(false)
    revision.current = null
    setData(null)
    setSelectedPatientId('')
    setLastUpdated(null)
    setStale(false)
  }, [])

  const loadSnapshot = useCallback(
    async (silent = false) => {
      setRefreshing(true)
      try {
        // Telling the server what we already have lets it answer "nothing new" in
        // one query instead of rebuilding the whole clinic in sixteen. Most polls
        // in a clinic day are that answer.
        const since = revision.current
        const query = silent && since !== null ? `?since=${since}` : ''

        const response = await callApi(`snapshot${query}`)
        if (response.status === 401) {
          dropSession()
          return
        }

        const result = (await response.json()) as {
          ok: boolean
          message?: string
          revision?: number
          unchanged?: boolean
          doctorPresent?: boolean
          snapshot?: ClinicSnapshot
        }

        if (!result.ok) {
          setStale(true)
          return
        }

        setStale(false)
        setLastUpdated(Date.now())
        if (typeof result.revision === 'number') revision.current = result.revision
        if (result.unchanged) {
          if (typeof result.doctorPresent === 'boolean') {
            setData((current) =>
              current && current.doctorPresent !== result.doctorPresent
                ? { ...current, doctorPresent: result.doctorPresent! }
                : current,
            )
          }
          return
        }
        if (result.snapshot) setData(result.snapshot)
      } catch {
        // A read that does not come back changed nothing. It is a connection
        // problem and it belongs in the connection indicator, not in the strip
        // where the results of somebody's actions appear.
        setStale(true)
      } finally {
        setRefreshing(false)
        if (!silent) setInitializing(false)
      }
    },
    [dropSession],
  )

  // localStorage is a browser API, so discover a saved tablet session only
  // after hydration. The nullable state keeps the opening screen stable until
  // that check completes; false means do not poll a protected route.
  useEffect(() => {
    setHasSession(Boolean(readToken()))
  }, [])

  // Four tablets share one clinic. A quiet poll is what keeps the queue on the
  // nurse's tablet and the counter's shelf figure telling the same story.
  useEffect(() => {
    if (hasSession === null) return
    if (!hasSession) {
      setInitializing(false)
      return
    }

    if (revision.current === null) void loadSnapshot()
    const timer = window.setInterval(() => void loadSnapshot(true), 15_000)
    return () => window.clearInterval(timer)
  }, [hasSession, loadSnapshot])

  const run = useCallback<ActionRunner>(
    async (action, payload = {}) => {
      setBusy(true)
      setNotice(null)
      try {
        const response = await callApi('command', {
          method: 'POST',
          body: JSON.stringify({ action, payload }),
        })

        let result: ActionResult & { revision?: number; snapshot?: ClinicSnapshot; unchanged?: boolean }
        try {
          result = await response.json()
        } catch {
          // The clinic was reached and did not answer in a language this
          // understands. Whether the transaction committed before it went wrong
          // is not knowable from here, so it is an unknown outcome and not a
          // refusal. Re-read the clinic so the screen at least shows the truth.
          void loadSnapshot(true)
          const unknown: ActionResult = {
            ok: false,
            unconfirmed: true,
            message: 'The clinic did not confirm this. Check the record before doing it again.',
          }
          setNotice({ tone: 'unknown', message: unknown.message })
          return unknown
        }

        setNotice({ tone: result.ok ? 'good' : 'bad', message: result.message })

        // A 401 is the thirty-minute idle lock, not a refusal to argue with:
        // the session is gone and every control on the workspace behind this
        // notice is now dead. Without this the user reads "Sign in required."
        // on a screen that still looks alive and goes on tapping it until the
        // fifteen-second poll happens to notice.
        if (response.status === 401) {
          dropSession()
          return result
        }

        // The command already carries the clinic as it now stands. Fetching it
        // again would double the wait on every action for no new information.
        //
        // Unless the command changed nothing — asking whether a patient is
        // already registered, say. Those answer without a snapshot on purpose,
        // and the `else` below would then go and fetch the whole clinic to
        // replace it with itself, which is the exact download the server just
        // took care to avoid.
        if (result.ok && result.snapshot) {
          if (typeof result.revision === 'number') revision.current = result.revision
          setData(result.snapshot)
          setLastUpdated(Date.now())
          setStale(false)
        } else if (result.ok && !result.unchanged) {
          await loadSnapshot(true)
        }
        return result
      } catch (error) {
        /*
         * The request did not come back.
         *
         * This is the case the application could not previously express. A
         * fetch that throws looks identical whether it never left the tablet or
         * reached Mumbai, moved the stock and lost the reply on the way home —
         * and reporting the second one as "the clinic server is not reachable"
         * tells a pharmacist nothing happened when something may well have.
         *
         * So a command that does not answer is an UNKNOWN outcome. The screens
         * that care keep the operator's typed work, say the outcome is not
         * confirmed, and re-check the record before letting the action run
         * again; the commands that move stock or money already carry an
         * idempotency key, so the retry that follows a check is safe.
         */
        const unconfirmed = !(error instanceof NoAnswer) || error.mutating
        const result: ActionResult = unconfirmed
          ? {
              ok: false,
              unconfirmed: true,
              message: 'The clinic did not confirm this. Check the record before doing it again.',
            }
          : { ok: false, message: 'The clinic server is not reachable.' }
        setNotice({ tone: unconfirmed ? 'unknown' : 'bad', message: result.message })
        if (unconfirmed) void loadSnapshot(true)
        return result
      } finally {
        setBusy(false)
      }
    },
    [dropSession, loadSnapshot],
  )

  const uploadCsv = useCallback(
    async (file: File): Promise<CommandResponse> => {
      setBusy(true)
      setNotice(null)
      try {
        const form = new FormData()
        form.set('file', file)
        const response = await callApi('csv', { method: 'POST', body: form })
        const result = (await response.json()) as CommandResponse
        setNotice({ tone: result.ok ? 'good' : 'bad', message: result.message })
        if (result.ok) await loadSnapshot(true)
        return result
      } catch {
        const result = {
          ok: false,
          message: 'The drug master upload was not confirmed. Check the formulary before sending it again.',
        }
        setNotice({ tone: 'unknown', message: result.message })
        void loadSnapshot(true)
        return result
      } finally {
        setBusy(false)
      }
    },
    [loadSnapshot],
  )

  async function login(staffId: string, pin: string) {
    setBusy(true)
    setNotice(null)
    try {
      const response = await callApi('login', {
        method: 'POST',
        body: JSON.stringify({ staffId, pin }),
      })
      const result = (await response.json()) as CommandResponse & {
        token?: string
        revision?: number
        snapshot?: ClinicSnapshot
      }
      if (!result.ok) setNotice({ tone: 'bad', message: result.message })
      else {
        // The token is the session now — everything after this call carries it.
        if (result.token) {
          writeToken(result.token)
          setHasSession(true)
        }
        // Nobody arrives at work to read a summary of the clinic they are
        // about to work in. The doctor opens on the queue, the nurse on what
        // is due, the pharmacist on a counter ready to sell.
        if (result.snapshot) setView(landingFor(result.snapshot.session.roles))

        // The clinic came back with the PIN. Asking for it again would put a
        // second wait between the last digit and seeing the queue.
        if (result.snapshot) {
          if (typeof result.revision === 'number') revision.current = result.revision
          setData(result.snapshot)
          setLastUpdated(Date.now())
          setStale(false)
        } else {
          await loadSnapshot(true)
        }
      }
    } catch {
      setNotice({ tone: 'bad', message: 'The clinic server is not reachable.' })
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    await callApi('logout', { method: 'POST' }).catch(() => {})
    // Dropped locally whatever the server said: a sign-out that leaves the
    // token on a shared tablet because the network hiccuped is not a sign-out.
    dropSession()
    setBusy(false)
    setNotice(null)
    setView('overview')
    setMenuOpen(false)
  }

  if (initializing) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-paper px-5">
        <ClinicMark className="h-16 w-auto" />
        <p className="flex items-center gap-2 font-mono text-[14px] text-ink-2">
          <Icon name="ring" size={18} className="jmc-spin" />
          Opening the clinic workspace…
        </p>
      </main>
    )
  }

  if (!data) return <LoginScreen onSignIn={login} busy={busy} notice={notice} />

  const roles = data.session.roles
  const railed = roles.includes('admin')
  const groups = navigationGroupsFor(roles)
  const primary = primaryFor(roles)
  const more = moreFor(roles)
  const items = groups.flatMap((group) => group.items)
  const current = items.find((item) => item.id === view) ?? items[0]

  const selectedPatient = {
    patientId: selectedPatientId,
    select: setSelectedPatientId,
    goTo: (next: string) => setView(next as View),
  }

  function open(next: View) {
    setView(next)
    setMenuOpen(false)
  }

  return (
    <BusyContext value={busy}>
      <ConnectionContext value={{ lastUpdated, refreshing, stale }}>
        <SelectedPatientContext value={selectedPatient}>
          <div className={railed ? 'flex min-h-screen' : 'flex min-h-screen flex-col'}>
            {railed ? (
              // Not moved offscreen — not rendered. `hidden` takes it out of
              // the accessibility tree and the tab order at the same time,
              // which is what a translated-away rail never did.
              <nav
                data-print="hide"
                data-ground="dark"
                aria-label="Clinic stations"
                className="hidden w-[212px] shrink-0 flex-col bg-ink lg:flex"
              >
                <RailIdentity name={data.session.name} roles={roles} />
                <RailStations groups={groups} current={current?.id} onOpen={open} />
                <RailFooter busy={busy} onSignOut={logout} />
              </nav>
            ) : null}

            <div className="flex min-w-0 flex-1 flex-col">
              <header
                data-print="hide"
                className="flex items-center justify-between gap-3 border-b border-rule bg-sheet px-4 py-2.5 lg:px-5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {railed ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="menu"
                      className="lg:hidden"
                      onClick={() => setMenuOpen(true)}
                    >
                      Stations
                    </Button>
                  ) : null}
                  <ClinicMark className="h-9 w-auto shrink-0" />
                  {/* Not an <h1>: every workspace states its own heading in
                      `PageHeader`, and two h1s on one screen is one too many
                      for anyone navigating by headings. The shell carries the
                      clinic's identity and who is holding the tablet — the
                      station name it used to repeat is already below. */}
                  <div className="min-w-0">
                    <p className="truncate text-[15px] leading-tight font-semibold">
                      {data.session.name}
                    </p>
                    <p className="truncate text-[13px] text-ink-2">
                      {roles.map((role) => ROLE_LABEL[role]).join(' · ')}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="hidden sm:inline">
                    <Badge tone={data.doctorPresent ? 'live' : 'plain'} icon="stethoscope">
                      {data.doctorPresent ? 'Doctor in' : 'Doctor out'}
                    </Badge>
                  </span>
                  <ConnectionMark
                    lastUpdated={lastUpdated}
                    refreshing={refreshing}
                    stale={stale}
                    onRefresh={() => void loadSnapshot()}
                  />
                  <ThemeChoice account={data.session.theme} run={run} />
                  {railed ? null : (
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      busy={busy}
                      busyLabel="…"
                      onClick={logout}
                    >
                      Sign out
                    </ActionButton>
                  )}
                </div>
              </header>

              {railed ? null : (
                <nav
                  data-print="hide"
                  aria-label="Clinic stations"
                  className="flex items-stretch gap-1 border-b border-rule bg-sheet px-2 lg:px-3"
                >
                  {primary.map((item) => {
                    const on = current?.id === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={on ? 'page' : undefined}
                        onClick={() => open(item.id)}
                        className={`flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-b-2 px-2 py-1.5 text-[13px] font-semibold transition-colors sm:flex-row sm:gap-2 ${
                          on
                            ? 'border-active text-active'
                            : 'border-transparent text-ink-2 hover:text-ink'
                        }`}
                      >
                        <Icon name={item.icon} size={21} />
                        <span className="truncate">{item.label}</span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setMenuOpen(true)}
                    aria-expanded={menuOpen}
                    className="flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 border-b-2 border-transparent px-3 py-1.5 text-[13px] font-semibold text-ink-2 transition-colors hover:text-ink sm:flex-row sm:gap-2"
                  >
                    <Icon name="more" size={21} />
                    <span>More</span>
                  </button>
                </nav>
              )}

              {notice ? (
                <div data-print="hide" className="px-4 pt-3 lg:px-5">
                  <Notice
                    tone={notice.tone === 'good' ? 'good' : notice.tone === 'unknown' ? 'unknown' : 'bad'}
                    onDismiss={() => setNotice(null)}
                  >
                    {notice.message}
                  </Notice>
                </div>
              ) : null}

              <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 py-5 lg:px-5">
                <WorkspaceRouter view={view} data={data} run={run} uploadCsv={uploadCsv} roles={roles} />
              </main>
            </div>

            {/*
             * Everything else this session is authorized for. Nothing has been
             * taken away to make the bar short — `moreFor` is defined as the
             * rail minus the bar, so a station can only move, never vanish.
             */}
            <Drawer
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              title={railed ? 'Clinic stations' : 'More'}
              sub={railed ? undefined : 'Everything else you are authorized for'}
              footer={
                <Button variant="secondary" icon="close" onClick={logout} disabled={busy}>
                  Sign out
                </Button>
              }
            >
              <div className="grid gap-4">
                {(railed ? groups : more).map((group, index) => (
                  <div key={group.heading ?? `more-${index}`}>
                    {group.heading ? <p className="eyebrow mb-1.5">{group.heading}</p> : null}
                    <div className="grid gap-1">
                      {group.items.map((item) => {
                        const on = current?.id === item.id
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={on ? 'page' : undefined}
                            onClick={() => open(item.id)}
                            className={`flex min-h-[48px] w-full items-center gap-3 rounded-box px-3 text-left text-[15px] font-medium transition-colors ${
                              on ? 'bg-active-wash text-active' : 'hover:bg-paper'
                            }`}
                          >
                            <Icon name={item.icon} size={20} className="text-ink-2" />
                            <span className="min-w-0">
                              <span className="block truncate">{item.label}</span>
                              <span className="block truncate text-[12px] text-ink-2">
                                {item.eyebrow}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </Drawer>
          </div>
        </SelectedPatientContext>
      </ConnectionContext>
    </BusyContext>
  )
}

/**
 * The clinic's mark.
 *
 * One component so the asset, its alt text and its size discipline live in one
 * place. The plan puts it on sign-in, in the identity area, and on anything
 * that prints — and nowhere else, because a logo repeated on every panel stops
 * being an identity and becomes furniture.
 */
function ClinicMark({ className = '' }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo-mark.png" alt="Jayamurugan Clinic" className={className} />
  )
}

function RailIdentity({ name, roles }: { name: string; roles: Role[] }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-paper/15 px-4 py-3.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon-192.png" alt="" className="h-8 w-8 shrink-0 rounded-[3px]" />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold text-paper">{name}</p>
        <p className="truncate text-[13px] text-paper/60">
          {roles.map((role) => ROLE_LABEL[role]).join(' · ')}
        </p>
      </div>
    </div>
  )
}

function RailStations({
  groups,
  current,
  onOpen,
}: {
  groups: NavGroup[]
  current: View | undefined
  onOpen: (view: View) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {groups.map((group, index) => {
        const headingId = group.heading
          ? `rail-${group.heading.toLowerCase().replaceAll(' ', '-')}`
          : undefined

        // A named group rather than a heading: a screen reader announces
        // "People and access, group" on entering it, and the page's heading
        // outline stays the workspace's own — the rail is not four headings in
        // front of the h1 every screen already sets.
        return (
          <div
            key={group.heading ?? `rail-top-${index}`}
            role={group.heading ? 'group' : undefined}
            aria-labelledby={headingId}
            className={index > 0 ? 'mt-3' : undefined}
          >
            {group.heading ? (
              <p id={headingId} className="eyebrow px-3 pt-1 pb-1.5 text-paper/60">
                {group.heading}
              </p>
            ) : null}
            {group.items.map((item) => {
              const on = current === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => onOpen(item.id)}
                  className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-box px-3 py-1.5 text-left text-[14px] font-medium transition-colors ${
                    on ? 'bg-paper text-ink' : 'text-paper/75 hover:bg-paper/10 hover:text-paper'
                  }`}
                >
                  <Icon name={item.icon} size={19} />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function RailFooter({ busy, onSignOut }: { busy: boolean; onSignOut: () => void }) {
  return (
    <div className="border-t border-paper/15 px-3 py-3">
      <button
        type="button"
        onClick={onSignOut}
        disabled={busy}
        className="inline-flex min-h-[44px] w-full items-center gap-2.5 rounded-box border border-paper/30 px-3 text-[14px] font-semibold text-paper/85 transition-colors hover:bg-paper/10 hover:text-paper disabled:opacity-40"
      >
        <Icon name="close" size={18} />
        Sign out
      </button>
    </div>
  )
}

/**
 * Whether what is on this screen is current.
 *
 * Four tablets poll the same clinic every fifteen seconds, and the one thing a
 * nurse cannot tell by looking is whether the queue in front of her is a minute
 * old or twenty because the Wi-Fi dropped in the corridor. This says which, in
 * words, and it is the only place a connection problem is ever reported — a
 * failed refresh has nothing to do with the result of anything anybody did.
 */
function ConnectionMark({
  lastUpdated,
  refreshing,
  stale,
  onRefresh,
}: {
  lastUpdated: number | null
  refreshing: boolean
  stale: boolean
  onRefresh: () => void
}) {
  const [, tick] = useState(0)

  // The label is a duration, so it has to change without anything else doing.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 20_000)
    return () => window.clearInterval(timer)
  }, [])

  const age = lastUpdated === null ? null : Math.floor((Date.now() - lastUpdated) / 1000)
  const when =
    age === null
      ? 'not yet updated'
      : age < 45
        ? 'up to date'
        : age < 5400
          ? `${Math.max(1, Math.round(age / 60))} min old`
          : `${Math.round(age / 3600)} h old`

  const label = refreshing ? 'Refreshing…' : stale ? `Not updating · ${when}` : when

  return (
    <button
      type="button"
      onClick={onRefresh}
      // Polite, not assertive: this changes on its own every fifteen seconds
      // and must never interrupt somebody mid-sentence in a consultation.
      aria-live="polite"
      title="Refresh now — the workspace also refreshes every 15 seconds"
      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-box px-2 text-[13px] font-medium transition-colors hover:bg-paper ${
        stale ? 'text-attn' : 'text-ink-2'
      }`}
    >
      <Icon
        name={stale ? 'signal-off' : refreshing ? 'ring' : 'signal'}
        size={18}
        className={refreshing ? 'jmc-spin' : undefined}
      />
      <span className="hidden md:inline">{label}</span>
      <span className="sr-only md:hidden">Refresh. {label}</span>
    </button>
  )
}

/** Paper and ink, Night shift or High contrast, anchored to its own control. */
/**
 * Paper and ink, Night shift or High contrast, anchored to its own control.
 *
 * The choice is saved to the staff account rather than to this browser, so it
 * follows the person onto whichever tablet they pick up next — which on four
 * shared tablets is the difference between a preference and a nuisance. The
 * colour changes the instant it is tapped; the clinic is told immediately
 * afterwards, and if it refuses, the screen goes back to what the account
 * actually holds.
 */
function ThemeChoice({ account, run }: { account: ThemeChoice; run: ActionRunner }) {
  const { choice, setChoice, saving } = useTheme({
    account,
    save: (theme) => run('set_theme', { theme }),
  })

  return (
    <Popover
      title="Appearance"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          title="Appearance"
          className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-box text-ink-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <Icon name={saving ? 'ring' : 'settings'} size={19} className={saving ? 'jmc-spin' : undefined} />
          <span className="sr-only">Appearance</span>
        </button>
      )}
    >
      {(close) =>
        THEMES.map((theme) => {
          const on = choice === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => {
                setChoice(theme.id)
                close()
              }}
              className={`flex min-h-[48px] w-full items-center gap-2.5 px-3 text-left text-[14px] transition-colors ${
                on ? 'bg-active-wash text-active' : 'hover:bg-paper'
              }`}
            >
              <Icon name={on ? 'check-circle' : 'ring'} size={18} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{theme.label}</span>
                <span className="block truncate text-[12px] text-ink-2">{theme.hint}</span>
              </span>
            </button>
          )
        })
      }
    </Popover>
  )
}

/**
 * The lock screen: choose your name, then type your PIN.
 *
 * A username and a password is a desk-and-chair idea. This is a tablet on a
 * counter that four people share and hand to each other twenty times a day, and
 * on that device a name you tap and a PIN you know is both faster and more
 * honest about what is happening — nobody is "logging into an account", they
 * are saying which of the people standing here is about to do something.
 *
 * The staff list is fetched unauthenticated, because you cannot ask somebody to
 * identify themselves and also require them to be identified first. It carries
 * names, roles, and how many digits that person's PIN is.
 *
 * ── WHY THE PAD'S LENGTH COMES FROM THE SERVER ─────────────────────────────
 *
 * The clinic is moving from six digits to four, and a stored hash cannot be
 * shortened, so for the length of the rollout both are live — one per staff
 * member, recorded on their row. The pad submits on the last digit rather than
 * making everyone tap a confirm button hundreds of times a day, so it has to
 * know which. Hardcoding four would submit early for everybody not yet reset
 * and lock them out of their own clinic; hardcoding six would never fire for
 * anybody who had been.
 */
function LoginScreen({
  onSignIn,
  busy,
  notice,
}: {
  onSignIn: (staffId: string, pin: string) => void | Promise<void>
  busy: boolean
  notice: { tone: 'good' | 'bad' | 'unknown'; message: string } | null
}) {
  const [staff, setStaff] = useState<LockScreenStaffView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LockScreenStaffView | null>(null)
  const [pin, setPin] = useState('')

  // How many dots this person's pad draws, and when it fires. Four for anybody
  // already reset, six for anybody still waiting. It falls back to six only if
  // an older deployment of the staff endpoint omits the field, which is the
  // safe direction: a pad that fires late asks for one more digit, while a pad
  // that fires early refuses a PIN that was correct.
  const pinLength = selected?.pinLength ?? 6

  // First start only: everything below exists for a database that has never
  // had a staff row in it. On every other day it is unreachable.
  const [opening, setOpening] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [saving, setSaving] = useState(false)
  // The lock screen's own voice. `notice` belongs to the sign-in that
  // ClinicApp runs; this carries what opening the clinic said, which has to
  // survive the jump to the PIN pad that follows it.
  const [said, setSaid] = useState<{ tone: 'good' | 'bad'; message: string } | null>(null)

  // The tablet's own appearance, before anybody is known. Signing in adopts
  // that person's account choice; until then the device's setting is all there
  // is to go on, which is exactly the fallback the plan specifies.
  useTheme()

  useEffect(() => {
    let cancelled = false
    callApi('staff')
      .then((response) => response.json() as Promise<{ ok: boolean; staff?: typeof staff; message?: string }>)
      .then((result) => {
        if (cancelled) return
        if (result.ok && result.staff) setStaff(result.staff)
        else setLoadError(result.message ?? 'The clinic staff list could not be read.')
      })
      .catch(() => { if (!cancelled) setLoadError('The clinic server is not reachable.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The last digit and it goes. A confirm button would be a tap every staff
  // member pays hundreds of times a day for nothing.
  useEffect(() => {
    if (!selected || pin.length !== pinLength || busy) return
    void onSignIn(selected.id, pin)
    setPin('')
  }, [pin, pinLength, selected, busy, onSignIn])

  // One message at a time: whatever the last sign-in attempt said, or — before
  // there has been one — whatever opening the clinic said.
  const shown = notice ?? said

  // The new PIN is typed twice, on the same pad, one after the other. This is
  // the opposite of the sign-in rule two functions up, and deliberately: there
  // the PIN is already known and confirming it is a tap paid hundreds of times
  // a day, while here it is being invented, the endpoint that set it disables
  // itself the moment it succeeds, and a slip of one digit is an administrator
  // account nobody can ever sign into on a clinic that has no other staff.
  function pushPinDigit(digit: string) {
    setSaid(null)
    if (newPin.length < NEW_PIN_LENGTH) {
      setNewPin(newPin + digit)
      return
    }
    const typedAgain = (confirmPin + digit).slice(0, NEW_PIN_LENGTH)
    if (typedAgain.length === NEW_PIN_LENGTH && typedAgain !== newPin) {
      setNewPin('')
      setConfirmPin('')
      setSaid({ tone: 'bad', message: 'Those two PINs were not the same. Start the four digits again.' })
      return
    }
    setConfirmPin(typedAgain)
  }

  function dropPinDigit() {
    setSaid(null)
    if (confirmPin.length > 0) setConfirmPin(confirmPin.slice(0, -1))
    else setNewPin(newPin.slice(0, -1))
  }

  const readyToOpen =
    newName.trim() !== '' && newUsername.trim() !== '' &&
    newPin.length === NEW_PIN_LENGTH && confirmPin === newPin

  async function openTheClinic() {
    setSaving(true)
    setSaid(null)
    try {
      const response = await callApi('bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          username: newUsername.trim(),
          pin: newPin,
        }),
      })
      const result = (await response.json()) as {
        ok: boolean
        message: string
        staff?: { id: string; name: string; roles: Role[] }
      }

      if (!result.ok || !result.staff) {
        setSaid({ tone: 'bad', message: result.message ?? 'The first administrator could not be created.' })
        return
      }

      // Straight to the PIN pad with their own name on it. The account exists
      // now; the next thing that has to happen is that PIN being typed against
      // the hash that was actually stored, while getting it wrong still costs
      // nothing but typing it again.
      //
      // pinLength is supplied here rather than taken from the response,
      // because bootstrap answers with the staff record it created and not
      // with a lock-screen row. It is NEW_PIN_LENGTH by construction: this
      // account was made a moment ago, by the pad above, at that length.
      const opened: LockScreenStaffView = { ...result.staff, pinLength: NEW_PIN_LENGTH }
      setStaff([opened])
      setSelected(opened)
      setOpening(false)
      setNewPin('')
      setConfirmPin('')
      setSaid({ tone: 'good', message: result.message })
    } catch {
      setSaid({ tone: 'bad', message: 'The clinic server is not reachable.' })
    } finally {
      setSaving(false)
    }
  }

  if (opening) {
    const step = newPin.length < NEW_PIN_LENGTH ? newPin : confirmPin
    return (
      <main className="mx-auto min-h-screen w-full max-w-lg px-4 py-10 sm:px-5">
        <header className="border-b-2 border-ink pb-4">
          <ClinicMark className="mb-5 h-20 w-auto" />
          <p className="eyebrow">First start · no staff yet</p>
          <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-tight">
            Open the clinic
          </h1>
          <p className="mt-1 font-mono text-[14px] text-ink-2">
            This happens once. Everyone else is added from inside.
          </p>
        </header>

        <Card variant="record" className="mt-5">
          <CardBody className="grid gap-4">
            <Field
              label="Your name"
              required
              hint="What the lock screen shows, and what stands against everything you do here."
            >
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                autoComplete="off"
                autoCapitalize="words"
                placeholder="S. Jayamurugan"
                disabled={saving}
              />
            </Field>

            <Field
              label="Username"
              required
              hint="For the staff record. You sign in by tapping your name, never by typing this."
            >
              <Input
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="jayamurugan"
                disabled={saving}
              />
            </Field>

            <div className="border-t border-rule pt-4">
              <p className="eyebrow text-center">
                {newPin.length < NEW_PIN_LENGTH
                  ? 'Choose a four-digit PIN'
                  : 'Type the same four digits again'}
              </p>

              <PinDots length={NEW_PIN_LENGTH} filled={step.length} label="PIN entry" />

              {/*
               * `w-full` under the cap, not a fixed 18rem.
               *
               * This pad was `w-72` — 288px — inside a card that spends 32px on
               * its own padding inside a main that spends another 40px. On a
               * 320px screen that is 248px of room for 288px of buttons, so the
               * very first screen anybody sees in this clinic scrolled
               * sideways, on the one screen where the controls are the entire
               * point.
               */}
              <div className="mx-auto mt-6 w-full max-w-[288px]">
                <Numpad disabled={saving} onDigit={pushPinDigit} onBackspace={dropPinDigit} />
              </div>

              <p className="mt-3 text-center text-[13px] leading-snug text-ink-2">
                Four digits. Not the same one four times, and not a run like 1234 — those are
                the first two anybody tries.
              </p>
            </div>
          </CardBody>
        </Card>

        {said ? (
          <div className="mt-5">
            <Notice tone={said.tone === 'good' ? 'good' : 'bad'}>{said.message}</Notice>
          </div>
        ) : null}

        <ActionButton
          variant="primary"
          className="mt-5 w-full"
          busy={saving}
          busyLabel="Opening…"
          disabled={!readyToOpen}
          disabledReason="Fill in a name and a username, then type the same four digits twice."
          onClick={() => void openTheClinic()}
        >
          Open the clinic
        </ActionButton>

        <Button
          variant="ghost"
          className="mt-3 w-full"
          disabled={saving}
          onClick={() => {
            setOpening(false)
            setNewPin('')
            setConfirmPin('')
            setSaid(null)
          }}
        >
          Not now
        </Button>
      </main>
    )
  }

  if (selected) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-lg px-4 py-10 sm:px-5">
        <header className="border-b-2 border-ink pb-4 text-center">
          <ClinicMark className="mx-auto mb-5 h-20 w-auto" />
          <p className="eyebrow">{selected.roles.map((role) => ROLE_LABEL[role]).join(' · ')}</p>
          <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-tight">{selected.name}</h1>
          <p className="mt-1 font-mono text-[14px] text-ink-2">
            {pinLength === 4 ? 'Enter your four-digit PIN' : 'Enter your six-digit PIN'}
          </p>
        </header>

        <PinDots length={pinLength} filled={pin.length} label={`${pinLength}-digit PIN entry`} />

        {shown ? (
          <div className="mt-5">
            <Notice tone={shown.tone === 'good' ? 'good' : shown.tone === 'unknown' ? 'unknown' : 'bad'}>
              {shown.message}
            </Notice>
          </div>
        ) : null}

        <div className="mx-auto mt-7 w-full max-w-[288px]">
          <Numpad
            disabled={busy}
            onDigit={(digit) => setPin((current) => (current + digit).slice(0, pinLength))}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
          />
        </div>

        <Button
          variant="ghost"
          icon="arrow-left"
          className="mt-7 w-full"
          onClick={() => { setSelected(null); setPin('') }}
        >
          Choose another person
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-lg px-4 py-10 sm:px-5">
      <header className="border-b-2 border-ink pb-4">
        <ClinicMark className="mb-5 h-20 w-auto" />
        <p className="eyebrow">Staff access · shared clinic tablet</p>
        <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-tight">
          Jayamurugan Clinic
        </h1>
        <p className="mt-1 font-mono text-[14px] text-ink-2">
          Sessions last 30 minutes on this tablet.
        </p>
      </header>

      <Card variant="record" className="mt-5">
        <CardBody>
          <p className="eyebrow">Who are you?</p>

          {loading ? (
            <p className="mt-3 flex items-center gap-2 text-[14px] text-ink-2">
              <Icon name="ring" size={17} className="jmc-spin" />
              Reading the staff list…
            </p>
          ) : null}

          {loadError ? (
            <div className="mt-3">
              <Notice tone="bad">{loadError}</Notice>
            </div>
          ) : null}

          {/*
            Nobody can sign in. This is what a clinic looks like on the day its
            database is built and before anyone has opened it, and until now the
            screen sent people to a first-start server log that no longer exists
            to be read — an instruction with no file behind it, given to
            somebody who cannot get into their own clinic. The way out is here.
          */}
          {!loading && !loadError && staff.length === 0 ? (
            <div className="mt-3 grid gap-3">
              <p className="text-[14px] leading-relaxed text-ink-2">
                Nobody can sign in yet. A clinic arrives with an empty staff list — the first
                administrator is created here, once, and everybody else is added from inside.
              </p>
              <Button variant="primary" icon="plus" onClick={() => setOpening(true)}>
                Create the first administrator
              </Button>
            </div>
          ) : null}

          <div className="mt-3 grid gap-2">
            {staff.map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => setSelected(person)}
                className="flex min-h-14 w-full items-center justify-between gap-3 rounded-box border border-rule bg-sheet px-4 text-left active:bg-paper-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[16px] font-medium">{person.name}</span>
                  <span className="block truncate text-[13px] text-ink-2">
                    {person.roles.map((role) => ROLE_LABEL[role]).join(' · ')}
                  </span>
                </span>
                <Icon name="chevron-right" size={20} className="text-ink-2" />
              </button>
            ))}
          </div>

          {shown ? (
            <div className="mt-4">
              <Notice tone={shown.tone === 'good' ? 'good' : shown.tone === 'unknown' ? 'unknown' : 'bad'}>
                {shown.message}
              </Notice>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </main>
  )
}

/**
 * How many digits have been typed, without showing which.
 *
 * `role="status"` so a screen-reader user hears the count rise; the label says
 * how many are expected, because a pad that submits on the last digit is
 * otherwise silent about how many that is.
 */
function PinDots({ length, filled, label }: { length: number; filled: number; label: string }) {
  return (
    <div className="mt-7 flex justify-center gap-3" role="status" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <span
          key={index}
          className={`h-4 w-4 rounded-full border border-rule ${index < filled ? 'bg-ink' : ''}`}
        />
      ))}
    </div>
  )
}
