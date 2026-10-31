/**
 * Private object storage, and the two places bytes are allowed to be.
 *
 * Clinical photographs never become a URL. There is no public bucket, no
 * signed link with an hour on it, and nothing a browser history or a shared
 * tablet can carry away: the bytes travel only through the authenticated
 * `images` Edge Function, which asks who is calling on every single request.
 *
 * ── TWO BACKENDS, ONE INTERFACE ────────────────────────────────────────────
 *
 * In the clinic this is Supabase Storage, reached with the service role key
 * from inside the Edge Function — which is the only place that key exists and
 * the only place it may ever be used. The bucket is private; the key never
 * leaves the function and never reaches a browser.
 *
 * In staging there is no Supabase, so objects go to a directory on disk. That
 * is not a pretend implementation of the same thing and it should not be
 * mistaken for one: it exercises the application's own logic — consent, the
 * access rules, the audit, the checksum — against real bytes, and says nothing
 * about Supabase's bucket policies. Those are a deployment check, and
 * docs/operations/STAGING.md says which checks staging cannot make.
 *
 * The guard is the same shape as the database guard: the local backend refuses
 * to write anywhere that is not an explicitly configured scratch directory,
 * because a storage root that defaults to somewhere plausible is a storage root
 * that will one day be somewhere real.
 */

/**
 * Two areas, and they are separate stores rather than two prefixes.
 *
 * `images` is clinical photographs, which this clinic TAKES of a patient under
 * a recorded consent. `documents` is reports the clinic RECEIVES about a
 * patient — Slice 4's laboratory PDFs and scans — which have no shutter and no
 * moment to consent to, and which owner item 86 governs rather than item 27.
 *
 * Keeping them apart costs one parameter and buys three things: a bucket
 * policy can differ, an accidental cross-fetch cannot resolve, and a retention
 * decision about photographs cannot reach a report. The parameter defaults to
 * `images`, so every caller written before Slice 4 means exactly what it
 * meant.
 */
export type StorageArea = 'images' | 'documents'

const BUCKETS: Record<StorageArea, string> = {
  images: Deno.env.get('CLINIC_IMAGE_BUCKET') ?? 'clinical-images',
  documents: Deno.env.get('CLINIC_DOCUMENT_BUCKET') ?? 'result-documents',
}

const ROOT_VARIABLES: Record<StorageArea, string> = {
  images: 'CLINIC_IMAGE_ROOT',
  documents: 'CLINIC_DOCUMENT_ROOT',
}

export type StoredObject = {
  key: string
  byteSize: number
  checksum: string
  contentType: string
}

export class StorageUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageUnavailable'
  }
}

/** SHA-256 of what was actually stored, so an original can prove it is one. */
export async function checksumOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function supabaseConfigured(): { url: string; key: string } | null {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  return url && key ? { url: url.replace(/\/+$/, ''), key } : null
}

/**
 * The local root, and the reason it has no default.
 *
 * An unset root is an error rather than a temp directory. "Storage is not
 * configured" is a sentence a deployment can act on; a photograph quietly
 * written to /tmp and gone at the next restart is not.
 */
function localRoot(area: StorageArea): string {
  const variable = ROOT_VARIABLES[area]
  // A document root nobody set falls back to the image root rather than
  // failing, because in staging one scratch directory is the whole point and
  // the two areas are separate SUBDIRECTORIES of it — `newDocumentStorageKey`
  // writes under `result-documents/`. In the clinic there is no fallback to
  // reach: Supabase is configured and each area has its own bucket.
  const root = Deno.env.get(variable) ?? Deno.env.get('CLINIC_IMAGE_ROOT') ?? ''
  if (!root) {
    throw new StorageUnavailable(
      'Private storage is not configured. Set SUPABASE_SERVICE_ROLE_KEY for the clinic, ' +
      `or ${variable} for a local scratch directory.`,
    )
  }
  return root
}

/**
 * Keys are generated here, never taken from a caller.
 *
 * A key a browser can choose is a key a browser can guess, and the object
 * store has no idea which patient anything belongs to. Two random halves plus
 * the patient id, so a leaked key for one photograph tells you nothing about
 * the next.
 */
export function newStorageKey(patientId: string, contentType: string): string {
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
  return `${patientId}/${crypto.randomUUID()}-${crypto.randomUUID().slice(0, 8)}.${extension}`
}

/**
 * The same, for a received report. Generated here and never taken from a
 * caller, for the reason above — and prefixed, so that a local scratch
 * directory keeps the two areas apart as visibly as two buckets do.
 *
 * The original filename never reaches the key. A laboratory's own naming is
 * routinely `SMITH_JOHN_HIV_2026.pdf`, and a key is the one string about a
 * document that ends up in a storage listing, a backup manifest and an error
 * message.
 */
export function newDocumentStorageKey(patientId: string, contentType: string): string {
  const extension = contentType === 'application/pdf'
    ? 'pdf'
    : contentType === 'image/png'
    ? 'png'
    : 'jpg'
  return `result-documents/${patientId}/${crypto.randomUUID()}-${crypto.randomUUID().slice(0, 8)}.${extension}`
}

export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  area: StorageArea = 'images',
): Promise<StoredObject> {
  const checksum = await checksumOf(bytes)
  const supabase = supabaseConfigured()

  if (supabase) {
    const response = await fetch(`${supabase.url}/storage/v1/object/${BUCKETS[area]}/${key}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${supabase.key}`,
        'content-type': contentType,
        // Never overwrite. A storage key is generated once and an upload that
        // collides is a bug, not something to resolve silently in favour of
        // whichever arrived second.
        'x-upsert': 'false',
      },
      body: bytes as unknown as BodyInit,
    })
    if (!response.ok) {
      throw new StorageUnavailable(`Storage refused the upload (${response.status}).`)
    }
  } else {
    const root = localRoot(area)
    const path = `${root}/${key}`
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await Deno.writeFile(path, bytes, { createNew: true })
  }

  return { key, byteSize: bytes.byteLength, checksum, contentType }
}

export async function getObject(key: string, area: StorageArea = 'images'): Promise<Uint8Array> {
  const supabase = supabaseConfigured()
  if (supabase) {
    const response = await fetch(`${supabase.url}/storage/v1/object/${BUCKETS[area]}/${key}`, {
      headers: { authorization: `Bearer ${supabase.key}` },
    })
    if (!response.ok) throw new StorageUnavailable(`Storage could not return the object (${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
  }
  return Deno.readFile(`${localRoot(area)}/${key}`)
}

/**
 * Remove the bytes. Used only by an approved retention decision, and the row
 * describing the image stays behind as a tombstone — policy register 29 calls
 * for an audited lifecycle event, not a disappearance.
 */
export async function deleteObject(key: string, area: StorageArea = 'images'): Promise<void> {
  const supabase = supabaseConfigured()
  if (supabase) {
    const response = await fetch(`${supabase.url}/storage/v1/object/${BUCKETS[area]}/${key}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${supabase.key}` },
    })
    if (!response.ok && response.status !== 404) {
      throw new StorageUnavailable(`Storage could not remove the object (${response.status}).`)
    }
    return
  }
  try {
    await Deno.remove(`${localRoot(area)}/${key}`)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}

/**
 * A ticket for ONE image, ONE actor and ONE action, good for sixty seconds.
 *
 * The brief asks for short-lived, operation-specific access. This is what an
 * `<img src>` can carry: it is not a session, it cannot be replayed against a
 * different image, and it dies before anybody can paste it anywhere useful.
 * The session token stays in the Authorization header, where a URL bar, a
 * referrer and a screenshot cannot reach it.
 */
const TICKET_SECONDS = 60

async function ticketKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('CLINIC_SESSION_SECRET')
  if (!secret) throw new StorageUnavailable('CLINIC_SESSION_SECRET is not set.')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function issueTicket(
  imageId: string,
  actorId: string,
  action: string,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + TICKET_SECONDS
  const body = `${imageId}.${actorId}.${action}.${expires}`
  const signature = await crypto.subtle.sign('HMAC', await ticketKey(), new TextEncoder().encode(body))
  const mac = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${expires}.${mac}`
}

export async function ticketIsValid(
  ticket: string,
  imageId: string,
  actorId: string,
  action: string,
): Promise<boolean> {
  const [expiresText, mac] = String(ticket).split('.')
  const expires = Number(expiresText)
  if (!Number.isFinite(expires) || !mac) return false
  if (expires < Math.floor(Date.now() / 1000)) return false

  const body = `${imageId}.${actorId}.${action}.${expires}`
  const expected = await crypto.subtle.sign('HMAC', await ticketKey(), new TextEncoder().encode(body))
  const expectedHex = [...new Uint8Array(expected)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')

  // Constant time, because a ticket is a secret and a length-or-prefix
  // comparison leaks it one character at a time.
  if (expectedHex.length !== mac.length) return false
  let difference = 0
  for (let index = 0; index < expectedHex.length; index += 1) {
    difference |= expectedHex.charCodeAt(index) ^ mac.charCodeAt(index)
  }
  return difference === 0
}

/** Whether bytes can be stored at all, for a screen that must not pretend. */
export function storageConfigured(area: StorageArea = 'images'): boolean {
  if (supabaseConfigured() !== null) return true
  return Boolean(Deno.env.get(ROOT_VARIABLES[area]) ?? Deno.env.get('CLINIC_IMAGE_ROOT'))
}
