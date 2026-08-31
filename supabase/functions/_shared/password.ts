import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * PIN hashing.
 *
 * ── WHY THIS IS ASYNCHRONOUS ────────────────────────────────────────────────
 *
 * It used to be `scryptSync`, which is the obvious way to write it and fine on
 * a Node server with a thread to spare. On a Cloudflare Worker it is not: scrypt
 * spends tens of milliseconds of solid CPU, synchronously, and the runtime's
 * watchdog reads a blocked event loop as a hung request and cancels it —
 * "your Worker's code had hung and would never generate a response". It showed
 * up as roughly one sign-in in ten failing, which is exactly the kind of fault
 * that gets blamed on the tablet, or the wifi, or the person typing.
 *
 * The callback form does the same work on the platform's own threadpool, so the
 * loop stays free and the watchdog stays quiet.
 *
 * The cost parameters are deliberately left at Node's defaults. A six-digit PIN
 * carries about twenty bits of entropy, so the only thing standing between a
 * stolen hash and the PIN is how expensive each guess is — this is not the
 * place to buy speed.
 */

function derive(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 64, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(
  password: string,
  salt = randomBytes(16).toString('hex'),
): Promise<{ salt: string; hash: string }> {
  const key = await derive(password, salt)
  return { salt, hash: key.toString('hex') }
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHex: string,
): Promise<boolean> {
  const actual = await derive(password, salt)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
