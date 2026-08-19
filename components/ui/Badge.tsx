/**
 * Law 2 as a component. Five tones, and there is no sixth.
 *
 *   free  available · done · healthy · paid · in stock
 *   attn  waiting · low · nearing expiry · partial
 *   stop  overdue · blocked · expired · unpaid · refused
 *   live  happening right now — the one chromatic accent, at most once a screen
 *   (none) a fact with no state: discharged, cancelled, historical
 *
 * The recipe is one triple: border is the hue at 35% alpha, ground is its wash,
 * text is the hue at full strength. Nothing else in the clinic is allowed to
 * borrow these hues for emphasis, so a red thing means the same thing on the
 * expiry screen as it does on a bill.
 *
 * Colour is never the only signal — every badge carries a word. That is what
 * makes the system survive a greyscale print-out and a colour-blind reader
 * without a second pass, and it is not optional.
 */
const TONES = {
  free: 'border-free/35 bg-free-wash text-free',
  attn: 'border-attn/35 bg-attn-wash text-attn',
  stop: 'border-stop/35 bg-stop-wash text-stop',
  live: 'border-active bg-active text-sheet',
  none: 'border-rule bg-paper text-ink-2',
} as const;

export function Badge({
  tone = 'none',
  className = '',
  children,
}: {
  tone?: keyof typeof TONES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-box border px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.1em] ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
