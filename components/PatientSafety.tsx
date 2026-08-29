import { Badge } from '@/components/ui';

/**
 * Who the patient is, and what would harm them. One line, every width.
 *
 * This exists because the two screens that most need it — the consult and the
 * dispense — kept it in the context pane, and the responsive shell folds that
 * pane into a `Details` disclosure below 768px. Folding is right for a
 * supplier's lead time and wrong for a penicillin allergy: it put the one fact
 * that stops a prescribing error one tap out of sight, on the screen where the
 * error gets made.
 *
 * So allergies are not context. They are the heading.
 *
 * The allergy is rendered as a `stop` badge and nothing else on the strip uses
 * that treatment, which is the whole of PLAN.md §5.3 rule 6 applied to one
 * line: a red thing means the same thing on every screen the clinic uses. When
 * there is nothing on file the strip says so rather than staying silent —
 * "none known" and "nobody has asked" are different facts, and a blank space
 * reads as the first while meaning the second.
 */
export function PatientSafety({
  token,
  name,
  age,
  sex,
  allergies,
}: {
  token?: number | string | null;
  name: string | null | undefined;
  age?: number | null;
  sex?: string | null;
  allergies?: string | null;
}) {
  const known = allergies?.trim();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {token ? (
        <span className="tabular shrink-0 font-mono text-sm text-ink-2">
          Token {token}
        </span>
      ) : null}

      <span className="min-w-0 truncate text-lg font-medium">{name ?? '…'}</span>

      <span className="shrink-0 text-sm text-ink-2">
        {[age != null ? `${age} yrs` : null, sex].filter(Boolean).join(' · ')}
      </span>

      <span className="ml-auto shrink-0">
        {known ? (
          <Badge tone="stop">Allergy: {known}</Badge>
        ) : (
          <span className="text-sm text-ink-2">No allergy recorded</span>
        )}
      </span>
    </div>
  );
}
