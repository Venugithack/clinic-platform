/**
 * WhatsApp deep links. WHATSAPP.md §0.
 *
 * This module is four lines of string handling and it is the reason M5 needs no
 * Meta business verification, no dedicated number, no display-name approval, no
 * pre-approved templates, no opt-in machinery and no privacy policy URL.
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

export function deepLink(number: string, text: string): string {
  return `https://wa.me/${normaliseNumber(number)}?text=${encodeURIComponent(text)}`;
}
