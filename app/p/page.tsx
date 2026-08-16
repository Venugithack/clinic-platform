/**
 * The patient portal. Public, and default-deny (PLAN.md §5.3 rule 7).
 * Built in M7 (PLAN.md §14).
 *
 * Everything under app/p is subject to the lint rule in eslint.config.mjs: a
 * clinician's shorthand is written for the clinician, and the person it is
 * about is not the intended reader. What a patient sees is composed
 * deliberately — advice, medicines, follow-up date — never a projection of the
 * encounter record with a few fields removed.
 */
export default function PatientPortalPage() {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Your visit</h1>
      <p className="mt-2 text-muted">Published in M7.</p>
    </main>
  );
}
