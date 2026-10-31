'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { callApi } from '@/lib/api'
import type { ActionRunner } from './clinic-context'
import { useBusy } from './clinic-context'
import {
  ActionButton,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  Input,
  Notice,
  Select,
  Textarea,
  formatDate,
} from '@/components/ui'

/**
 * Clinical photographs, and the four questions the screen has to keep asking.
 *
 * Consent before capture. The patient on the screen is the patient in the
 * frame. The original is never edited. And nothing is shown to somebody the
 * server would refuse — which this panel does not decide: it asks, and draws
 * what it is told.
 *
 * ── WHY THERE IS NO `<img src>` POINTING AT STORAGE ────────────────────────
 *
 * Every image drawn here is fetched with the session token, turned into a blob
 * URL that lives in this tab and dies with it, and revoked when the panel
 * unmounts. No clinical photograph ever becomes a URL that survives the page:
 * not in the browser history, not in a referrer, not in a screenshot of the
 * address bar, and not in a shared tablet's disk cache.
 */

type ImageRecord = {
  id: string
  patientId: string
  encounterId: string
  consentId: string
  category: 'before' | 'progress' | 'after' | 'other'
  seriesKey: string
  bodySite: string
  side: string
  caption: string
  contentType: string
  byteSize: number
  checksum: string
  status: 'active' | 'entered_in_error'
  errorReason: string
  errorByName: string
  capturedByName: string
  capturedAt: string
  consentPurpose: string
  consentWithdrawn: boolean
  derivativeCount: number
}

type Consent = {
  id: string
  purpose: string
}

const CATEGORY_LABEL: Record<ImageRecord['category'], string> = {
  before: 'Before',
  progress: 'Progress',
  after: 'After',
  other: 'Other',
}

/** A photograph, fetched with the session and never given a durable URL. */
function Thumbnail({ imageId, alt }: { imageId: string; alt: string }) {
  const [src, setSrc] = useState('')
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let revoked = false
    let objectUrl = ''

    ;(async () => {
      try {
        const ticketResponse = await callApi(`images?action=ticket&imageId=${encodeURIComponent(imageId)}`)
        const ticket = await ticketResponse.json()
        if (!ticket.ok) throw new Error(ticket.message ?? 'That image could not be opened.')

        const bytes = await callApi(
          `images?imageId=${encodeURIComponent(imageId)}&ticket=${encodeURIComponent(ticket.ticket)}`,
        )
        if (!bytes.ok) {
          const body = await bytes.json().catch(() => ({}))
          throw new Error(body.message ?? 'That image could not be opened.')
        }
        objectUrl = URL.createObjectURL(await bytes.blob())
        if (!revoked) setSrc(objectUrl)
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'That image could not be opened.')
      }
    })()

    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [imageId])

  if (problem) {
    return (
      <div className="flex min-h-[120px] items-center justify-center border border-rule bg-sheet p-3 text-[12px] text-ink-2">
        {problem}
      </div>
    )
  }
  if (!src) {
    return (
      <div className="flex min-h-[120px] items-center justify-center border border-rule bg-sheet p-3 text-[12px] text-ink-2">
        Opening…
      </div>
    )
  }
  return <img src={src} alt={alt} className="w-full border border-rule bg-sheet object-contain" />
}

export function ImagesPanel({
  patientId,
  patientName,
  encounterId,
  run,
  canCapture,
}: {
  patientId: string
  patientName: string
  encounterId?: string
  run: ActionRunner
  canCapture: boolean
}) {
  const busy = useBusy()
  const [images, setImages] = useState<ImageRecord[]>([])
  const [canSeeContent, setCanSeeContent] = useState(false)
  const [consents, setConsents] = useState<Consent[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)

  const [capture, setCapture] = useState({
    category: 'before' as ImageRecord['category'],
    consentId: '',
    bodySite: '',
    side: '',
    seriesKey: '',
    caption: '',
  })

  const load = useCallback(async () => {
    if (!patientId) return
    setLoading(true)
    setProblem('')
    try {
      const response = await callApi(`images?patientId=${encodeURIComponent(patientId)}`)
      const body = await response.json()
      if (!body.ok) throw new Error(body.message ?? 'Images could not be read.')
      setImages(body.images as ImageRecord[])
      setCanSeeContent(Boolean(body.canSeeContent))
      // The live consents this patient has, taken from the images themselves
      // plus whatever the capture form recorded this session. A consent with no
      // photograph yet is the normal case, so it is offered explicitly below.
      setConsents((current) => {
        const seen = new Map(current.map((item) => [item.id, item]))
        for (const image of body.images as ImageRecord[]) {
          if (!image.consentWithdrawn) {
            seen.set(image.consentId, { id: image.consentId, purpose: image.consentPurpose })
          }
        }
        return [...seen.values()]
      })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Images could not be read.')
    } finally {
      setLoading(false)
    }
  }, [patientId])

  useEffect(() => { void load() }, [load])

  const active = useMemo(() => images.filter((image) => image.status === 'active'), [images])
  const inError = useMemo(() => images.filter((image) => image.status !== 'active'), [images])

  async function recordConsent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const result = await run('record_image_consent', {
      patientId,
      consentingPerson: String(form.get('consentingPerson') ?? ''),
      relationship: String(form.get('relationship') ?? 'self'),
      method: String(form.get('method') ?? 'verbal'),
      purpose: String(form.get('purpose') ?? ''),
    })
    if (result.ok) {
      const consentId = (result.data as { consentId?: string } | undefined)?.consentId ?? ''
      setConsents((current) => [
        ...current,
        { id: consentId, purpose: String(form.get('purpose') ?? '') },
      ])
      setCapture((current) => ({ ...current, consentId }))
      setNotice(result.message)
    } else {
      setProblem(result.message)
    }
  }

  /**
   * The upload, and the one thing it must never do.
   *
   * A failure is said out loud and the file is left in the picker so it can be
   * tried again. It is never reported as saved: an image that the doctor
   * believes is on the record and is not is worse than no image at all.
   */
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProblem('')
    setNotice('')
    const element = event.currentTarget
    const chosen = new FormData(element).get('file')
    const file = chosen instanceof File && chosen.size > 0 ? chosen : null
    if (!file) {
      setProblem('Choose a photograph first.')
      return
    }
    if (!capture.consentId) {
      setProblem('Record consent for this patient before taking a photograph.')
      return
    }

    setUploading(true)
    try {
      const form = new FormData()
      form.set('patientId', patientId)
      if (encounterId) form.set('encounterId', encounterId)
      form.set('consentId', capture.consentId)
      form.set('category', capture.category)
      form.set('bodySite', capture.bodySite)
      form.set('side', capture.side)
      form.set('seriesKey', capture.seriesKey)
      form.set('caption', capture.caption)
      form.set('file', file)

      const response = await callApi('images', { method: 'POST', body: form })
      const body = await response.json()
      if (!body.ok) throw new Error(body.message ?? 'The photograph was not saved.')

      setNotice('Photograph saved to this patient’s record.')
      element.reset()
      setCapture((current) => ({ ...current, caption: '' }))
      await load()
    } catch (error) {
      setProblem(
        `${error instanceof Error ? error.message : 'The photograph was not saved.'} ` +
        'Nothing was added to the record — the photograph is still in the picker, so you can try again.',
      )
    } finally {
      setUploading(false)
    }
  }

  async function exportImage(image: ImageRecord) {
    setProblem('')
    try {
      const response = await callApi(
        `images?action=export&imageId=${encodeURIComponent(image.id)}`,
        { method: 'POST' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.message ?? 'That image could not be exported.')
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `clinical-image-${image.id.slice(0, 8)}.jpg`
      anchor.click()
      URL.revokeObjectURL(url)
      setNotice('Export recorded on the image’s access log.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That image could not be exported.')
    }
  }

  return (
    <Card>
      <CardHeader
        title="Clinical images"
        sub={`${active.length} on the record for ${patientName}`}
      />
      <CardBody className="space-y-4">
        {problem ? <Notice tone="bad" onDismiss={() => setProblem('')}>{problem}</Notice> : null}
        {notice ? <Notice tone="good" onDismiss={() => setNotice('')}>{notice}</Notice> : null}

        {!canSeeContent && !loading ? (
          <Notice tone="info">
            You can see that these photographs exist, and their audit trail, but not the photographs
            themselves. A doctor can grant access for a named reason and a fixed time.
          </Notice>
        ) : null}

        {canCapture ? (
          <Disclosure
            label="Consent for photographs"
            hint="Recorded before any photograph is taken"
          >
            <form className="space-y-3" onSubmit={recordConsent}>
              <Notice tone="info">
                Say who agreed, how they agreed, and what the photographs may be used for. A
                photograph cannot be taken without this, and the consent can be withdrawn later.
              </Notice>
              <FieldRow cols={2}>
                <Field label="Who consented" required>
                  <Input name="consentingPerson" defaultValue={patientName} required />
                </Field>
                <Field label="Their relationship to the patient">
                  <Select name="relationship" defaultValue="self">
                    <option value="self">The patient</option>
                    <option value="parent">Parent</option>
                    <option value="guardian">Guardian</option>
                    <option value="spouse">Spouse</option>
                    <option value="other">Someone else</option>
                  </Select>
                </Field>
              </FieldRow>
              <FieldRow cols={2}>
                <Field label="How consent was given" required>
                  <Select name="method" defaultValue="verbal">
                    <option value="verbal">Spoken, in the room</option>
                    <option value="written">Signed on paper</option>
                    <option value="digital">Signed on the tablet</option>
                  </Select>
                </Field>
                <Field label="What the photographs are for" required hint="Be specific.">
                  <Input name="purpose" placeholder="Recording this wound before and after dressing" required />
                </Field>
              </FieldRow>
              <ActionButton type="submit" variant="primary" busy={busy} busyLabel="Recording…">
                Record consent
              </ActionButton>
            </form>
          </Disclosure>
        ) : null}

        {canCapture ? (
          <form className="space-y-3 border border-rule bg-sheet p-3" onSubmit={upload}>
            <p className="eyebrow">Take a photograph</p>
            <FieldRow cols={2}>
              <Field label="Consent" required hint="Which consent this photograph is taken under.">
                <Select
                  value={capture.consentId}
                  onChange={(event) => setCapture((current) => ({ ...current, consentId: event.target.value }))}
                >
                  <option value="">Choose the consent</option>
                  {consents.map((consent) => (
                    <option key={consent.id} value={consent.id}>{consent.purpose}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Category" required>
                <Select
                  value={capture.category}
                  onChange={(event) =>
                    setCapture((current) => ({
                      ...current, category: event.target.value as ImageRecord['category'],
                    }))}
                >
                  <option value="before">Before</option>
                  <option value="progress">Progress</option>
                  <option value="after">After</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow cols={3}>
              <Field label="Body site">
                <Input
                  value={capture.bodySite}
                  placeholder="Left forearm"
                  onChange={(event) => setCapture((current) => ({ ...current, bodySite: event.target.value }))}
                />
              </Field>
              <Field label="Side">
                <Select
                  value={capture.side}
                  onChange={(event) => setCapture((current) => ({ ...current, side: event.target.value }))}
                >
                  <option value="">Not stated</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                  <option value="bilateral">Both</option>
                  <option value="not_applicable">Not applicable</option>
                </Select>
              </Field>
              <Field label="Series" hint="Ties Before to After for the same thing.">
                <Input
                  value={capture.seriesKey}
                  placeholder="forearm-dressing"
                  onChange={(event) => setCapture((current) => ({ ...current, seriesKey: event.target.value }))}
                />
              </Field>
            </FieldRow>
            <Field label="Caption">
              <Textarea
                rows={2}
                value={capture.caption}
                onChange={(event) => setCapture((current) => ({ ...current, caption: event.target.value }))}
              />
            </Field>
            <Field label="Photograph" required hint="JPEG, PNG or WebP, up to 12 MB.">
              <Input name="file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" />
            </Field>
            <ActionButton type="submit" variant="primary" busy={uploading} busyLabel="Saving…" disabled={busy}>
              Save to this patient’s record
            </ActionButton>
          </form>
        ) : null}

        {loading ? (
          <p className="text-[13px] text-ink-2">Reading the image record…</p>
        ) : active.length === 0 ? (
          <EmptyState
            title="No photographs on this record"
            direction={canCapture
              ? 'Record consent, then take one from this patient’s open visit.'
              : 'A doctor or a nurse involved in this patient’s care can take one.'}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {active.map((image) => (
              <div key={image.id} className="space-y-2 border border-rule p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="plain">{CATEGORY_LABEL[image.category]}</Badge>
                    {image.seriesKey ? <Badge tone="live">{image.seriesKey}</Badge> : null}
                    {image.consentWithdrawn ? <Badge tone="attn">Consent withdrawn</Badge> : null}
                  </span>
                  <span className="font-mono text-[11px] text-ink-2">{formatDate(image.capturedAt)}</span>
                </div>

                {canSeeContent
                  ? <Thumbnail imageId={image.id} alt={`${CATEGORY_LABEL[image.category]} — ${image.bodySite || 'clinical photograph'}`} />
                  : (
                    <div className="flex min-h-[120px] items-center justify-center border border-rule bg-sheet p-3 text-center text-[12px] text-ink-2">
                      Record only. The photograph itself is not shown to your role.
                    </div>
                  )}

                <p className="text-[12px]">
                  {[image.bodySite, image.side && image.side !== 'not_applicable' ? image.side : '']
                    .filter(Boolean).join(' · ') || 'Site not recorded'}
                </p>
                {image.caption ? <p className="text-[12px] text-ink-2">{image.caption}</p> : null}
                <p className="font-mono text-[11px] text-ink-2">
                  {image.capturedByName} · {Math.round(image.byteSize / 1024)} KB
                  {image.derivativeCount > 0 ? ` · ${image.derivativeCount} crop/annotation` : ''}
                </p>

                {canSeeContent ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy || image.consentWithdrawn} onClick={() => exportImage(image)}>
                      Give to the patient
                    </Button>
                    {canCapture ? (
                      <MarkInError
                        image={image}
                        run={run}
                        onDone={load}
                        onProblem={setProblem}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {inError.length > 0 ? (
          <Disclosure label={`${inError.length} marked captured in error`} hint="Kept on the record">
            <ul className="space-y-2">
              {inError.map((image) => (
                <li key={image.id} className="text-[12px]">
                  <b>{CATEGORY_LABEL[image.category]}</b> · {formatDate(image.capturedAt)} ·{' '}
                  {image.capturedByName}
                  <span className="mt-0.5 block text-ink-2">
                    {image.errorReason}
                    {image.errorByName ? ` — ${image.errorByName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * Captured in error, reason first.
 *
 * The reason is typed before the confirmation rather than after it, because a
 * confirmation dialog with an empty box in it is a dialog people dismiss. The
 * photograph is never deleted — it stays on the record saying who decided it
 * was wrong, and why.
 */
function MarkInError({
  image,
  run,
  onDone,
  onProblem,
}: {
  image: ImageRecord
  run: ActionRunner
  onDone: () => Promise<void>
  onProblem: (message: string) => void
}) {
  const busy = useBusy()
  const [reason, setReason] = useState('')

  return (
    <Disclosure label="Captured in error" hint="It stays on the record">
      <div className="space-y-2">
        <Field label="Why" required hint="Kept with the image, permanently.">
          <Input
            value={reason}
            placeholder="Photograph of the wrong side"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <ConfirmButton
          size="sm"
          variant="danger"
          busy={busy}
          disabled={reason.trim() === ''}
          disabledReason="Say why it was wrong."
          title="Mark this photograph captured in error"
          question={
            <>
              It stays on the record and stops counting as a clinical image. It is never deleted,
              and this reason is kept with it.
            </>
          }
          confirmLabel="Mark captured in error"
          onConfirm={async () => {
            const result = await run('mark_image_entered_in_error', { imageId: image.id, reason })
            if (result.ok) {
              setReason('')
              await onDone()
            } else {
              onProblem(result.message)
            }
          }}
        >
          Mark captured in error
        </ConfirmButton>
      </div>
    </Disclosure>
  )
}
