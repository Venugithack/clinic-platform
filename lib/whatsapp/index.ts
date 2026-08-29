/**
 * WhatsApp deep links. WHATSAPP.md §0.
 *
 * This module is a few lines of string handling and it is the reason M5 needs
 * no Meta business verification, no dedicated number, no display-name approval,
 * no pre-approved templates, no opt-in machinery and no privacy policy URL.
 *
 * Meta's rules key on who *initiates* a conversation, not on volume. A Cloud
 * API call — even one a day, even approved by a human first — is a
 * business-initiated message and drags the whole apparatus in. Opening `wa.me`
 * on the doctor's own phone is a person typing to a contact, and needs none of
 * it. Commercial use of the link itself is explicitly permitted.
 *
 * What the clinic loses: the app cannot know whether he actually pressed send.
 * That is why `app.send_purchase_order` records the message as `handed_off` and
 * nothing in the build ever claims a delivery (PLAN.md §5.3 rule 6).
 */

/**
 * `wa.me` wants digits only, including the country code — no plus, no spaces,
 * no dashes. A number stored as "+91 90000 00001" silently opens a chat with
 * nobody if it is passed through unchanged.
 */
export function normaliseNumber(number: string): string {
  return number.replace(/\D/g, '');
}

/**
 * The country code is the part nobody types, and its absence is silent.
 *
 * Stripping punctuation is not enough. A supplier saved the way an Indian
 * number is normally written down — "63831 87889", ten digits, no +91 — passes
 * through `normaliseNumber` unchanged and produces `wa.me/6383187889`. WhatsApp
 * reads that as a number in the *sender's* country with a missing digit, so it
 * opens a chat with the wrong person or with nobody. Nothing downstream can
 * detect it: the hand-off is a link the doctor taps on his own phone, and this
 * app never learns what happened next (§0). So the check has to happen here.
 *
 * The bounds are E.164's: a country code plus a subscriber number is never
 * fewer than 11 digits in any country this clinic will order from, and never
 * more than 15 anywhere. A leading zero is a trunk prefix — a national dialling
 * habit that has no meaning once the country code is present.
 */
const MIN_INTERNATIONAL_DIGITS = 11;
const MAX_INTERNATIONAL_DIGITS = 15;

export function isDeliverable(number: string | null | undefined): boolean {
  const digits = normaliseNumber(number ?? '');
  return (
    digits.length >= MIN_INTERNATIONAL_DIGITS &&
    digits.length <= MAX_INTERNATIONAL_DIGITS &&
    !digits.startsWith('0')
  );
}

/** Why a number was refused, in the words the Suppliers screen should use. */
export function numberProblem(number: string | null | undefined): string | null {
  const digits = normaliseNumber(number ?? '');
  if (digits.length === 0) return 'Enter the supplier’s WhatsApp number.';
  if (digits.startsWith('0')) {
    return 'Drop the leading 0 and start with the country code, e.g. +91 for India.';
  }
  if (digits.length < MIN_INTERNATIONAL_DIGITS) {
    return 'Add the country code — a ten-digit number opens the wrong chat. Use +91 for India.';
  }
  if (digits.length > MAX_INTERNATIONAL_DIGITS) return 'That is too long to be a phone number.';
  return null;
}

export function deepLink(number: string, text: string): string {
  return `https://wa.me/${normaliseNumber(number)}?text=${encodeURIComponent(text)}`;
}
