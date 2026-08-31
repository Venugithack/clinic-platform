'use client'

import { useState, type FormEvent } from 'react'
import type { ClinicSnapshot, Role, StaffView } from '@/lib/types'
import { useBusy, type ActionRunner } from './clinic-context'
import { Stack } from './shared-panels'
import {
  ActionButton,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CheckRow,
  ConfirmButton,
  Disclosure,
  Field,
  FieldRow,
  Input,
  Notice,
  PageHeader,
  formatDate,
} from '@/components/ui'

const ROLE_OPTIONS: Role[] = ['admin', 'doctor', 'nurse', 'pharmacy']
const title = (role: string) => role[0].toUpperCase() + role.slice(1)

/**
 * The staff list, and the four things you actually need to do to it.
 *
 * Until now this screen could create an account and disable one, and nothing
 * else. A misspelled name, a wrong phone number, a person given the wrong role
 * on their first day, or a PIN that somebody has learned — every one of those
 * had the same and only remedy: disable the account and make a new one, which
 * detaches them from every prescription, bill and stock movement they had
 * signed. Editing is not a convenience here, it is what keeps the audit trail
 * attached to one continuous person.
 */
export function StaffPanel({ data, run }: { data: ClinicSnapshot; run: ActionRunner }) {
  const busy = useBusy()
  const admins = data.staff.filter((s) => s.active && s.roles.includes('admin'))

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const result = await run('create_staff', {
      name: values.get('name'),
      username: values.get('username'),
      phone: values.get('phone'),
      pin: values.get('pin'),
      roles: values.getAll('roles'),
    })
    if (result.ok) form.reset()
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Admin control"
        title="Staff & access"
        sub={`${data.staff.filter((s) => s.active).length} active of ${data.staff.length}`}
      />

      {admins.length === 1 ? (
        <Notice tone="info">
          {admins[0].name} is the only admin. Give a second person the admin role before you need
          it — a clinic with one admin account is one forgotten PIN away from nobody being able to
          add staff or change the settings.
        </Notice>
      ) : null}

      <div data-print="hide">
        <Disclosure label="Add a staff account" hint="One account may hold several roles">
          <form onSubmit={create} className="space-y-4">
            <FieldRow cols={4}>
              <Field label="Name" required>
                <Input name="name" required autoComplete="off" />
              </Field>
              <Field label="Username" required>
                <Input name="username" required autoCapitalize="none" spellCheck={false} />
              </Field>
              <Field label="Phone">
                <Input name="phone" type="tel" inputMode="tel" />
              </Field>
              <Field
                label="Sign-in PIN"
                required
                hint="Six digits. This is what they tap on the lock screen — tell them privately."
              >
                <Input
                  name="pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  autoComplete="off"
                  required
                />
              </Field>
            </FieldRow>
            <RolePicker />
            <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Creating…">
              Create account
            </ActionButton>
          </form>
        </Disclosure>
      </div>

      <Card>
        <CardHeader title="Staff" sub={`${data.staff.length} accounts`} />
        <CardBody>
          <div className="space-y-2">
            {data.staff.map((staff) => (
              <StaffRow
                key={staff.id}
                staff={staff}
                run={run}
                busy={busy}
                isSelf={staff.id === data.session.staffId}
              />
            ))}
          </div>
        </CardBody>
      </Card>
    </Stack>
  )
}

function RolePicker({ selected }: { selected?: Role[] }) {
  return (
    <div>
      <p className="eyebrow">Roles</p>
      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ROLE_OPTIONS.map((role) => (
          <CheckRow
            key={role}
            name="roles"
            value={role}
            label={title(role)}
            defaultChecked={selected ? selected.includes(role) : undefined}
          />
        ))}
      </div>
    </div>
  )
}

function StaffRow({
  staff,
  run,
  busy,
  isSelf,
}: {
  staff: StaffView
  run: ActionRunner
  busy: boolean
  isSelf: boolean
}) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    await run('update_staff', {
      staffId: staff.id,
      name: values.get('name'),
      username: values.get('username'),
      phone: values.get('phone'),
      roles: values.getAll('roles'),
    })
  }

  const pinReady = /^[0-9]{6}$/.test(pin) && pin === confirmPin

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[12rem] flex-1">
          <p className="font-semibold">
            {staff.name}{' '}
            <span className="font-normal text-ink-2">@{staff.username}</span>
          </p>
          <p className="text-[12px] text-ink-2">
            {staff.roles.map(title).join(' · ')} ·{' '}
            {staff.lastLogin ? `last signed in ${formatDate(staff.lastLogin)}` : 'never signed in'}
          </p>
        </div>
        <Badge tone={staff.active ? 'free' : 'stop'}>{staff.active ? 'Active' : 'Disabled'}</Badge>
        <ConfirmButton
          size="sm"
          variant={staff.active ? 'danger' : 'secondary'}
          confirmVariant={staff.active ? 'danger' : 'primary'}
          busy={busy}
          busyLabel="…"
          disabled={isSelf}
          title={staff.active ? 'Disable access' : 'Enable access'}
          question={
            staff.active ? (
              <>
                Disable <span className="font-semibold">{staff.name}</span>? They are signed out
                everywhere and cannot sign back in. Their record of what they did is kept.
              </>
            ) : (
              <>
                Let <span className="font-semibold">{staff.name}</span> sign in again?
              </>
            )
          }
          confirmLabel={staff.active ? 'Disable' : 'Enable'}
          onConfirm={() => run('toggle_staff', { staffId: staff.id })}
        >
          {staff.active ? 'Disable' : 'Enable'}
        </ConfirmButton>
      </div>

      {staff.active ? (
        <div className="mt-2" data-print="hide">
          <Disclosure label="Edit" hint="Details, roles, or a new PIN">
            <form onSubmit={save} className="space-y-4">
              <FieldRow cols={3}>
                <Field label="Name" required>
                  <Input name="name" defaultValue={staff.name} required autoComplete="off" />
                </Field>
                <Field label="Username" required>
                  <Input
                    name="username"
                    defaultValue={staff.username}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    defaultValue={staff.phone}
                  />
                </Field>
              </FieldRow>
              <RolePicker selected={staff.roles} />
              {isSelf ? (
                <Notice tone="info">
                  This is your own account. You cannot take the admin role off it — that is how a
                  clinic ends up with nobody who can add staff or reset a PIN.
                </Notice>
              ) : null}
              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Saving…">
                Save changes
              </ActionButton>
            </form>

            <div className="mt-5 border-t border-line pt-4">
              <p className="eyebrow">New sign-in PIN</p>
              <p className="mt-1 text-[12px] text-ink-2">
                Six digits. Typed twice because nobody can see what they typed, and a PIN with a
                typo in it locks {isSelf ? 'you' : 'them'} out of the clinic until someone resets
                it. Every signed-in session ends immediately.
              </p>
              <FieldRow cols={2}>
                <Field label="New PIN">
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
                <Field label="Type it again">
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
              </FieldRow>
              {pin !== '' && confirmPin !== '' && pin !== confirmPin ? (
                <Notice tone="bad">The two PINs are not the same.</Notice>
              ) : null}
              <div className="mt-3">
                <ConfirmButton
                  variant="primary"
                  disabled={busy || !pinReady}
                  title="Set a new PIN?"
                  question={
                    <>
                      <span className="font-semibold">{staff.name}</span> will need the new PIN the
                      next time they sign in, and every session they have open now ends. Make sure
                      they are told it privately.
                    </>
                  }
                  confirmLabel="Set the new PIN"
                  onConfirm={async () => {
                    const result = await run('set_staff_pin', { staffId: staff.id, pin })
                    if (result.ok) {
                      setPin('')
                      setConfirmPin('')
                    }
                  }}
                >
                  Set the new PIN
                </ConfirmButton>
              </div>
            </div>
          </Disclosure>
        </div>
      ) : null}
    </div>
  )
}
