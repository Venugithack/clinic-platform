/**
 * The outcome, stated where the action was taken.
 *
 * Inline, at the top of the screen the work happened on. Never a toast: a
 * pharmacist looking down at a strip while the confirmation fades out has not
 * been told anything, and the one message that matters most — a refusal — is
 * the one they were least likely to be looking at.
 *
 * role="status" so a screen reader announces it without stealing focus from
 * whatever is being typed.
 *
 * Refusals name who can act, never a code. "Only the doctor can void a bill"
 * tells the counter what to do next; "Error: unauthorised (403)" tells them to
 * find someone with a laptop.
 */
const TONES = {
  good: 'border-free bg-free-wash text-free',
  bad: 'border-stop bg-stop-wash text-stop',
  attn: 'border-attn bg-attn-wash text-attn',
  plain: 'border-rule bg-paper text-ink-2',
} as const;

export function Notice({
  tone = 'plain',
  className = '',
  children,
  ...rest
}: {
  tone?: keyof typeof TONES;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div
      role="status"
      className={`rounded-box border px-3 py-2 text-sm leading-relaxed ${TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
