/**
 * The public status page. Phone-first, 3 seconds on 3G — this one is not a
 * tablet screen (TABLET.md §7). Built properly in M6 (PLAN.md §13).
 *
 * Rule 6 governs everything that will ever render here: presence is never a
 * promise. Whatever this page says about the doctor being in, it says with an
 * "as of" time beside it, and it expires without a heartbeat. A patient who
 * drives 20 km to a locked door blames the app, and they are right to.
 *
 * It replaces the "doctor has arrived" broadcast the clinic asked about, which
 * is marketing-category WhatsApp traffic and gets a number reported
 * (PLAN.md §18.2). A free, always-current link does the same job.
 */
export default function NowPage() {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Clinic status</h1>
      <p className="mt-2 text-muted">Published in M6.</p>
    </main>
  );
}
