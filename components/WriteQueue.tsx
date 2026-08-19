'use client';

/**
 * What is waiting on this tablet. PLAN.md §16.
 *
 * It rides above every clinic screen, like the counter's questions do, because
 * the one thing worse than a queued write is a queued write nobody knows about.
 * The strip is absent when the queue is empty — a permanent "0 waiting" badge
 * teaches people to stop reading it.
 *
 * Two states, deliberately different in tone. **Waiting** is normal and says so
 * calmly. **Refused** means the database answered no while this tablet was
 * offline — almost always because the stock went to somebody else — and that
 * needs a person, not another retry.
 */
import { useCallback, useEffect, useState } from 'react';
import { flush, forget, pending, refused, type QueuedWrite } from '@/lib/offline/queue';

export function WriteQueue() {
  const [waiting, setWaiting] = useState<QueuedWrite[]>([]);
  const [stopped, setStopped] = useState<QueuedWrite[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setWaiting(pending());
    setStopped(refused());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('clinic:queue', refresh);
    return () => window.removeEventListener('clinic:queue', refresh);
  }, [refresh]);

  const send = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void flush()
      .then(refresh)
      .finally(() => setBusy(false));
  }, [busy, refresh]);

  useEffect(() => {
    // The browser telling us the network is back is the cheapest possible
    // trigger, and the interval is there because that event lies on captive
    // portals and on a 4G failover that connects before it routes.
    window.addEventListener('online', send);
    const timer = setInterval(() => {
      if (pending().length > 0) send();
    }, 20_000);

    return () => {
      window.removeEventListener('online', send);
      clearInterval(timer);
    };
  }, [send]);

  if (waiting.length === 0 && stopped.length === 0) return null;

  return (
    <div className="border-b border-rule" data-testid="write-queue">
      {waiting.length > 0 ? (
        <div className="flex items-center gap-4 bg-paper-2 px-5 py-3">
          <span className="tabular text-lg">
            {waiting.length} write{waiting.length === 1 ? '' : 's'} saved on this
            tablet, not yet in the ledger
          </span>
          <span className="flex-1 text-sm text-ink-2">
            They go in on their own when the network is back.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={send}
            className="h-11 rounded-box border border-ink px-4 text-sm active:bg-paper-2 disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Try now'}
          </button>
        </div>
      ) : null}

      {stopped.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-4 bg-stop-wash px-5 py-3 text-stop"
        >
          <span className="flex-1">{item.refusal}</span>
          <span className="text-sm">
            Saved {new Date(item.queuedAt).toLocaleTimeString('en-IN')} · this one
            needs doing again by hand
          </span>
          <button
            type="button"
            onClick={() => forget(item.key)}
            className="h-11 rounded-box border border-stop px-4 text-sm active:bg-paper-2"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
