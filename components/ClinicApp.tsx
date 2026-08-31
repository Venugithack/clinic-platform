'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClinicSnapshot, CommandResponse, Role } from '@/lib/types'
import { BusyContext, type ActionRunner } from './clinic-context'
import { callApi, writeToken } from '@/lib/api'
import {
  AuditPanel,
  BedsPanel,
  BillingPanel,
  OverviewPanel,
  PatientsPanel,
  PrinterPanel,
  ClinicSettingsPanel,
  RegistersPanel,
} from './shared-panels'
import { ConsultationPanel, QueuePanel, RecordsPanel, VitalsPanel } from './care-workspaces'
import { CounterPanel, InventoryPanel, OrdersPanel, SuppliersPanel } from './pharmacy-workspace'
import { ExpiringPanel } from './expiring-panel'
import { DayBookPanel } from './day-book-panel'
import { StockTakePanel } from './stock-take-panel'
import { StaffPanel } from './staff-panel'
import { ActionButton, Badge, Button, Card, CardBody, Notice, Numpad } from '@/components/ui'

/**
 * The application chrome: an ink rail of stations, a header, and the workspace.
 *
 * Adapted from the hospital application's `Shell`. There the rail is 44px wide
 * and carries one rotated word, because that demo has one screen per role. A
 * clinic tablet has ten screens behind one login, so the rail widens into a
 * list — same ink ground, same tracked caps, same rule weights. Below 1024px
 * it slides away and returns as a drawer, so a 768px tablet in portrait gets
 * the full width for the register it is showing.
 */

type View =
  | 'overview'
  | 'patients'
  | 'queue'
  | 'vitals'
  | 'consultation'
  | 'records'
  | 'beds'
  | 'billing'
  | 'staff'
  | 'clinic'
  | 'registers'
  | 'expiring'
  | 'daybook'
  | 'stocktake'
  | 'counter'
  | 'inventory'
  | 'suppliers'
  | 'orders'
  | 'printer'
  | 'audit'

type NavItem = { id: View; label: string; eyebrow: string }

const NAV: Record<Role, NavItem[]> = {
  admin: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'staff', label: 'Staff', eyebrow: 'Admin control' },
    { id: 'clinic', label: 'Clinic', eyebrow: 'Details that print' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
    { id: 'inventory', label: 'Inventory', eyebrow: 'Batch inventory' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders' },
    { id: 'printer', label: 'Printer', eyebrow: 'Tablet printing' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1' },
    { id: 'audit', label: 'Activity', eyebrow: 'Accountability' },
  ],
  doctor: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'queue', label: 'Queue', eyebrow: "Today's flow" },
    { id: 'consultation', label: 'Consult', eyebrow: 'Doctor workspace' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'records', label: 'Records', eyebrow: 'Clinical record' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Approve a count' },
  ],
  nurse: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'queue', label: 'Queue', eyebrow: "Today's flow" },
    { id: 'vitals', label: 'Vitals', eyebrow: 'Nursing station' },
    { id: 'patients', label: 'Patients', eyebrow: 'Patient registry' },
    { id: 'beds', label: 'Beds', eyebrow: 'Four-bed observation' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
  ],
  pharmacy: [
    { id: 'overview', label: 'Overview', eyebrow: 'The clinic today' },
    { id: 'counter', label: 'Counter', eyebrow: 'Pharmacy counter' },
    { id: 'inventory', label: 'Inventory', eyebrow: 'Batch inventory' },
    { id: 'expiring', label: 'Expiring', eyebrow: 'Return or write off' },
    { id: 'stocktake', label: 'Stock-take', eyebrow: 'Count the shelf' },
    { id: 'suppliers', label: 'Suppliers', eyebrow: 'Supply network' },
    { id: 'orders', label: 'Orders', eyebrow: 'Purchase orders' },
    { id: 'billing', label: 'Billing', eyebrow: 'Collected at the clinic' },
    { id: 'daybook', label: 'Day book', eyebrow: 'Cash and day-close' },
    { id: 'registers', label: 'Registers', eyebrow: 'Schedule H1' },
  ],
}

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacy: 'Pharmacy',
}

export function ClinicApp() {
  const [data, setData] = useState<ClinicSnapshot | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; message: string } | null>(null)
  const [view, setView] = useState<View>('overview')
  const [menuOpen, setMenuOpen] = useState(false)

  // The revision the screen is showing. A ref rather than state because it
  // must not re-create the poll on every tick.
  const revision = useRef<number | null>(null)

  const loadSnapshot = useCallback(async (silent = false) => {
    try {
      // Telling the server what we already have lets it answer "nothing new" in
      // one query instead of rebuilding the whole clinic in sixteen. Most polls
      // in a clinic day are that answer.
      const since = revision.current
      const query = silent && since !== null ? `?since=${since}` : ''

      const response = await callApi(`snapshot${query}`)
      if (response.status === 401) {
        setData(null)
        return
      }

      const result = (await response.json()) as {
        ok: boolean
        revision?: number
        unchanged?: boolean
        snapshot?: ClinicSnapshot
      }

      if (!result.ok) return
      if (typeof result.revision === 'number') revision.current = result.revision
      if (result.unchanged) return
      if (result.snapshot) setData(result.snapshot)
    } catch {
      if (!silent) setNotice({ tone: 'bad', message: 'The clinic server is not reachable.' })
    } finally {
      if (!silent) setInitializing(false)
    }
  }, [])

  // Four tablets share one clinic. A quiet poll is what keeps the queue on the
  // nurse's tablet and the counter's shelf figure telling the same story.
  useEffect(() => {
    void loadSnapshot()
    const timer = window.setInterval(() => void loadSnapshot(true), 15_000)
    return () => window.clearInterval(timer)
  }, [loadSnapshot])

  const run = useCallback<ActionRunner>(
    async (action, payload = {}) => {
      setBusy(true)
      setNotice(null)
      try {
        const response = await callApi('command', {
          method: 'POST',
          body: JSON.stringify({ action, payload }),
        })
        const result = (await response.json()) as CommandResponse & {
          revision?: number
          snapshot?: ClinicSnapshot
        }
        setNotice({ tone: result.ok ? 'good' : 'bad', message: result.message })

        // The command already carries the clinic as it now stands. Fetching it
        // again would double the wait on every action for no new information.
        if (result.ok && result.snapshot) {
          if (typeof result.revision === 'number') revision.current = result.revision
          setData(result.snapshot)
        } else if (result.ok) {
          await loadSnapshot(true)
        }
        return result
      } catch {
        const result = { ok: false, message: 'The clinic server is not reachable.' }
        setNotice({ tone: 'bad', message: result.message })
        return result
      } finally {
        setBusy(false)
      }
    },
    [loadSnapshot],
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
        const result = { ok: false, message: 'CSV upload could not reach the clinic server.' }
        setNotice({ tone: 'bad', message: result.message })
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
        if (result.token) writeToken(result.token)
        setView('overview')

        // The clinic came back with the PIN. Asking for it again would put a
        // second wait between tapping six digits and seeing the queue.
        if (result.snapshot) {
          if (typeof result.revision === 'number') revision.current = result.revision
          setData(result.snapshot)
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
    writeToken(null)
    setData(null)
    setBusy(false)
    setNotice(null)
    setView('overview')
  }

  if (initializing) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-paper">
        <p className="eyebrow">Jayamurugan Clinic</p>
        <p className="font-mono text-[13px] text-ink-2">Opening the clinic workspace…</p>
      </main>
    )
  }

  if (!data) return <LoginScreen onSignIn={login} busy={busy} notice={notice} />

  const roles = data.session.roles
  const items = [...new Map(roles.flatMap((role) => NAV[role]).map((item) => [item.id, item])).values()]
  const current = items.find((item) => item.id === view) ?? items[0]
  const roleName = roles.map((role) => ROLE_LABEL[role]).join(' · ')

  return (
    <BusyContext value={busy}>
      <div className="flex min-h-screen">
        {/* The rail. Ink ground, because this is the spine of the building. */}
        <nav
          data-print="hide"
          aria-label="Clinic stations"
          className={`fixed inset-y-0 left-0 z-40 flex w-[240px] shrink-0 flex-col bg-ink transition-transform duration-150 lg:static lg:w-[212px] lg:translate-x-0 ${
            menuOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-paper/15 px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icon-192.png"
                alt=""
                className="h-8 w-8 shrink-0 rounded-[3px]"
              />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold tracking-[0.1em] text-paper uppercase">
                  Jayamurugan
                </p>
                <p className="eyebrow mt-0.5 text-paper/55">Clinic</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
              className="-mr-2 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center font-mono text-[18px] text-paper/70 hover:text-paper lg:hidden"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {items.map((item) => {
              const on = current?.id === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => {
                    setView(item.id)
                    setMenuOpen(false)
                  }}
                  className={`flex min-h-[48px] w-full items-center rounded-box px-3 py-2 text-left text-[13px] font-semibold tracking-[0.1em] uppercase transition-colors ${
                    on ? 'bg-paper text-ink' : 'text-paper/70 hover:bg-paper/10 hover:text-paper'
                  }`}
                >
                  {item.label}
                </button>
              )
            })}
          </div>

          <div className="border-t border-paper/15 px-4 py-3">
            <p className="truncate text-[14px] font-semibold text-paper">{data.session.name}</p>
            <p className="eyebrow mt-0.5 truncate text-paper/55">{roleName}</p>
            <button
              type="button"
              onClick={logout}
              disabled={busy}
              className="mt-2 inline-flex min-h-[44px] w-full items-center rounded-box border border-paper/30 px-3 text-[12px] font-semibold tracking-[0.08em] text-paper/80 uppercase transition-colors hover:bg-paper/10 hover:text-paper disabled:opacity-40"
            >
              Sign out
            </button>
          </div>
        </nav>

        {menuOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            data-print="hide"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 bg-ink/35 lg:hidden"
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            data-print="hide"
            className="flex items-center justify-between gap-3 border-b-2 border-ink px-4 py-2.5 lg:px-5"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                className="lg:hidden"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
              >
                Menu
              </Button>
              {/* Not an <h1>: every workspace states its own heading in
                  `PageHeader`, and two h1s on one screen is one too many for
                  anyone navigating by headings. */}
              <div className="min-w-0">
                <p className="eyebrow truncate">{current?.eyebrow ?? 'Clinic'}</p>
                <p className="truncate text-[15px] font-semibold tracking-[0.1em] uppercase">
                  {current?.label ?? 'Overview'}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden sm:inline">
                <Badge tone={data.doctorPresent ? 'live' : 'plain'}>
                  {data.doctorPresent ? 'Doctor in' : 'Doctor out'}
                </Badge>
              </span>
              <span className="hidden md:inline">
                <Badge tone={data.whatsapp.configured ? 'free' : 'attn'}>
                  {data.whatsapp.configured ? 'WhatsApp live' : 'WhatsApp pending'}
                </Badge>
              </span>
              <ActionButton
                size="sm"
                variant="ghost"
                busy={busy}
                busyLabel="…"
                onClick={() => void loadSnapshot()}
                title="Refresh now — the workspace also refreshes every 15 seconds"
              >
                Refresh
              </ActionButton>
            </div>
          </header>

          {notice ? (
            <div data-print="hide" className="px-4 pt-3 lg:px-5">
              <Notice tone={notice.tone === 'good' ? 'good' : 'bad'} onDismiss={() => setNotice(null)}>
                {notice.message}
              </Notice>
            </div>
          ) : null}

          <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 py-5 lg:px-5">
            {renderPanel(view, data, run, uploadCsv, roles)}
          </main>
        </div>
      </div>
    </BusyContext>
  )
}

function renderPanel(
  view: View,
  data: ClinicSnapshot,
  run: ActionRunner,
  uploadCsv: (file: File) => Promise<CommandResponse>,
  roles: Role[],
) {
  switch (view) {
    case 'patients':
      return (
        <PatientsPanel
          data={data}
          run={run}
          canRegister={!roles.includes('doctor') || roles.includes('admin') || roles.includes('nurse')}
        />
      )
    case 'queue':
      return <QueuePanel data={data} run={run} />
    case 'vitals':
      return <VitalsPanel data={data} run={run} />
    case 'consultation':
      return <ConsultationPanel data={data} run={run} />
    case 'records':
      return <RecordsPanel data={data} />
    case 'beds':
      return <BedsPanel data={data} run={run} />
    case 'billing':
      return <BillingPanel data={data} run={run} />
    case 'stocktake':
      return <StockTakePanel data={data} run={run} />
    case 'daybook':
      return <DayBookPanel data={data} run={run} />
    case 'expiring':
      return <ExpiringPanel data={data} run={run} />
    case 'registers':
      return <RegistersPanel data={data} />
    case 'clinic':
      return <ClinicSettingsPanel data={data} run={run} />
    case 'staff':
      return <StaffPanel data={data} run={run} />
    case 'counter':
      return <CounterPanel data={data} run={run} />
    case 'inventory':
      return <InventoryPanel data={data} run={run} uploadCsv={uploadCsv} />
    case 'suppliers':
      return <SuppliersPanel data={data} run={run} />
    case 'orders':
      return <OrdersPanel data={data} run={run} />
    case 'printer':
      return <PrinterPanel />
    case 'audit':
      return <AuditPanel data={data} />
    default:
      return <OverviewPanel data={data} />
  }
}

/**
 * The lock screen: choose your name, then type your PIN.
 *
 * A username and a password is a desk-and-chair idea. This is a tablet on a
 * counter that four people share and hand to each other twenty times a day, and
 * on that device a name you tap and six digits you know is both faster and more
 * honest about what is happening — nobody is "logging into an account", they
 * are saying which of the people standing here is about to do something.
 *
 * The staff list is fetched unauthenticated, because you cannot ask somebody to
 * identify themselves and also require them to be identified first. It carries
 * names and roles and nothing else.
 */
function LoginScreen({
  onSignIn,
  busy,
  notice,
}: {
  onSignIn: (staffId: string, pin: string) => void | Promise<void>
  busy: boolean
  notice: { tone: 'good' | 'bad'; message: string } | null
}) {
  const [staff, setStaff] = useState<Array<{ id: string; name: string; roles: Role[] }>>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ id: string; name: string; roles: Role[] } | null>(null)
  const [pin, setPin] = useState('')

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

  // Six digits and it goes. A confirm button would be a tap every staff member
  // pays hundreds of times a day for nothing.
  useEffect(() => {
    if (pin.length !== 6 || !selected || busy) return
    void onSignIn(selected.id, pin)
    setPin('')
  }, [pin, selected, busy, onSignIn])

  if (selected) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-lg px-5 py-10">
        <header className="border-b-2 border-ink pb-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="mx-auto mb-5 h-20 w-auto" />
          <p className="eyebrow">{selected.roles.map((role) => ROLE_LABEL[role]).join(' · ')}</p>
          <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-tight">{selected.name}</h1>
          <p className="mt-1 font-mono text-[13px] text-ink-2">Enter your six-digit PIN</p>
        </header>

        <div className="mt-7 flex justify-center gap-3" role="status" aria-label="PIN entry">
          {Array.from({ length: 6 }, (_, index) => (
            <span
              key={index}
              className={`h-4 w-4 rounded-full border border-rule ${index < pin.length ? 'bg-ink' : ''}`}
            />
          ))}
        </div>

        {notice ? (
          <div className="mt-5">
            <Notice tone={notice.tone === 'good' ? 'good' : 'bad'}>{notice.message}</Notice>
          </div>
        ) : null}

        <div className="mx-auto mt-7 w-72">
          <Numpad
            disabled={busy}
            onDigit={(digit) => setPin((current) => (current + digit).slice(0, 6))}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
          />
        </div>

        <Button
          variant="ghost"
          className="mt-7 w-full"
          onClick={() => { setSelected(null); setPin('') }}
        >
          Choose another person
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-lg px-5 py-10">
      <header className="border-b-2 border-ink pb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" className="mb-5 h-20 w-auto" />
        <p className="eyebrow">Staff access · shared clinic tablet</p>
        <h1 className="mt-1.5 text-[26px] leading-tight font-semibold tracking-tight">
          Jayamurugan Clinic
        </h1>
        <p className="mt-1 font-mono text-[13px] text-ink-2">
          Sessions last 30 minutes on this tablet.
        </p>
      </header>

      <Card variant="record" className="mt-5">
        <CardBody>
          <p className="eyebrow">Who are you?</p>

          {loading ? <p className="mt-3 text-[13px] text-ink-2">Reading the staff list…</p> : null}

          {loadError ? (
            <div className="mt-3">
              <Notice tone="bad">{loadError}</Notice>
            </div>
          ) : null}

          {!loading && !loadError && staff.length === 0 ? (
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              No active staff. The clinic database has no one who can sign in — check the server
              log from the first start, which prints the administrator PIN once.
            </p>
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
                  <span className="block truncate text-[15px] font-medium">{person.name}</span>
                  <span className="block truncate text-[12px] text-ink-2">
                    {person.roles.map((role) => ROLE_LABEL[role]).join(' · ')}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 font-mono text-ink-2">
                  →
                </span>
              </button>
            ))}
          </div>

          {notice ? (
            <div className="mt-4">
              <Notice tone={notice.tone === 'good' ? 'good' : 'bad'}>{notice.message}</Notice>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </main>
  )
}
