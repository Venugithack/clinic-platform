'use client';

/**
 * Purchase orders. PLAN.md §10.4, §12.5, WHATSAPP.md §0.
 *
 * The doctor asked for automatic ordering. This is one tap short of it, and the
 * tap is the point: an order is a financial commitment to a third party, and one
 * wrong reorder level is ten times the stock, paid for. Four seconds a day buys
 * never waking up to an order nobody wanted.
 *
 * The send opens WhatsApp on this device with the text already written. It does
 * not go through Meta's API, which is why the clinic needs no business
 * verification, no second number and no approved templates — and why this screen
 * cannot tell you the supplier received anything. What it can tell you is
 * exactly what was composed and when, which is what the message list is for.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Numpad } from '@/components/Numpad';
import {
  messagesFor,
  openOrders,
  orderLines,
  type OpenOrder,
  type OrderLine,
  type SentMessage,
} from '@/lib/db/purchasing';
import {
  cancelPurchaseOrder,
  recordSupplierReply,
  sendPurchaseOrder,
  setPoLines,
} from '@/lib/transitions/purchasing';
import { deepLink } from '@/lib/whatsapp';
import { currentSession } from '@/lib/auth';
import { formatQty } from '@/lib/units';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft — not sent',
  sent: 'Sent, no reply yet',
  acknowledged: 'Supplier confirmed',
  partial: 'Part delivered',
};

export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [picked, setPicked] = useState<OpenOrder | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [messages, setMessages] = useState<SentMessage[]>([]);
  const [link, setLink] = useState<{ href: string; body: string } | null>(null);

  const [editing, setEditing] = useState<OrderLine | null>(null);
  const [digits, setDigits] = useState('');
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = currentSession();
  const canSend = session?.role === 'doctor' || session?.role === 'admin';

  const refresh = useCallback(
    (keep?: string) => {
      // Cleared before the read, never after it. A read landing is not evidence
      // that the last WRITE succeeded, and clearing on completion erased a
      // refusal somebody was in the middle of reading (M11e).
      setError(null);
      void (async () => {
        try {
          const rows = await openOrders();
          setOrders(rows);
          const still = keep ? rows.find((row) => row.po_id === keep) : null;
          setPicked(still ?? null);
          if (still) {
            setLines(await orderLines(still.po_id));
            setMessages(await messagesFor(still.po_id));
          } else {
            setLines([]);
            setMessages([]);
          }
        } catch (cause) {
          setError((cause as Error).message);
        }
      })();
    },
    [],
  );

  useEffect(() => refresh(), [refresh]);

  const open = async (order: OpenOrder) => {
    setPicked(order);
    setLink(null);
    setReplying(false);
    setLines(await orderLines(order.po_id));
    setMessages(await messagesFor(order.po_id));
  };

  const saveQty = async (qtyBase: number) => {
    if (!picked || !editing) return;
    setBusy(true);
    try {
      const next = lines.map((line) =>
        line.po_line_id === editing.po_line_id
          ? { ...line, ordered_qty_base: qtyBase }
          : line,
      );
      await setPoLines(
        picked.po_id,
        next
          .filter((line) => line.ordered_qty_base > 0)
          .map((line) => ({
            drugId: line.drug_id,
            qtyBase: line.ordered_qty_base,
            suggestedQtyBase: line.suggested_qty_base ?? undefined,
            expectedCostPerBaseUnit: line.expected_cost_per_base_unit ?? undefined,
          })),
      );
      setEditing(null);
      setDigits('');
      refresh(picked.po_id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await sendPurchaseOrder(picked.po_id);
      const href = deepLink(sent.send_to_number, sent.message_body);
      setLink({ href, body: sent.message_body });
      setNotice(
        `${sent.order_no} recorded. WhatsApp opens with the order written — press send there.`,
      );
      // The hand-off. If the browser blocks it, the link below is the same one.
      window.open(href, '_blank', 'noopener');
      refresh(picked.po_id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveReply = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await recordSupplierReply(picked.po_id, reply);
      setNotice('Reply recorded.');
      setReply('');
      setReplying(false);
      refresh(picked.po_id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThreePane
      context={
        <div>
          <h2 className="text-sm uppercase tracking-wide text-muted">Orders</h2>
          <p className="mt-1 text-lg">{orders.length} open</p>

          {picked ? (
            <>
              <p className="mt-6 text-lg">{picked.supplier_name}</p>
              <p className="tabular text-sm text-muted">
                {picked.po_no ?? 'not yet numbered'} ·{' '}
                {STATUS_LABEL[picked.status] ?? picked.status}
              </p>
              <p className="tabular mt-2 text-sm text-muted">
                about ₹{Number(picked.estimated_total).toFixed(2)}
              </p>
              {picked.whatsapp_number ? (
                <p className="tabular mt-1 text-sm text-muted">
                  {picked.whatsapp_number}
                </p>
              ) : (
                <p className="mt-1 text-sm text-danger">
                  No WhatsApp number for this supplier.
                </p>
              )}
              {picked.expected_on ? (
                <p className="mt-2 text-sm text-muted">
                  expected {new Date(picked.expected_on).toLocaleDateString('en-IN')}
                </p>
              ) : null}
            </>
          ) : null}

          <p className="mt-8 text-sm text-muted">
            The order opens in WhatsApp with the text already written. It is sent
            from the clinic&rsquo;s own phone, so nothing here is a business
            message and nothing needs Meta&rsquo;s approval — and this screen
            cannot know whether the supplier read it.
          </p>
        </div>
      }
      rail={
        <>
          {picked && (picked.status === 'draft' || picked.status === 'sent') ? (
            <RailButton
              tone="primary"
              disabled={busy || !canSend}
              onClick={() => void send()}
            >
              {picked.status === 'draft' ? 'Approve & send' : 'Send again'}
            </RailButton>
          ) : null}

          {picked && !canSend && picked.status === 'draft' ? (
            <p className="text-sm text-muted">
              The doctor sends orders. This one is ready for him.
            </p>
          ) : null}

          {picked && ['sent', 'acknowledged'].includes(picked.status) ? (
            <RailButton disabled={busy} onClick={() => setReplying(true)}>
              Supplier replied
            </RailButton>
          ) : null}

          {picked && ['sent', 'acknowledged', 'partial'].includes(picked.status) ? (
            <RailButton
              onClick={() => router.push(`/receiving?po=${picked.po_id}` as Route)}
            >
              Receive goods
            </RailButton>
          ) : null}

          {picked && ['draft', 'sent', 'acknowledged'].includes(picked.status) ? (
            <RailButton
              tone="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void cancelPurchaseOrder(picked.po_id, 'cancelled at the counter')
                  .then(() => {
                    setNotice('Order cancelled.');
                    refresh();
                  })
                  .catch((cause: Error) => setError(cause.message))
                  .finally(() => setBusy(false));
              }}
            >
              Cancel order
            </RailButton>
          ) : null}

          <RailButton onClick={() => router.push('/reorder')}>Reorder list</RailButton>
          <RailButton onClick={() => refresh(picked?.po_id)}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/counter')}>Back</RailButton>
        </>
      }
    >
      <h1 className="text-2xl font-semibold">Purchase orders</h1>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/15 p-3 text-danger">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-lg bg-ok/10 p-3 text-ok">
          {notice}
        </p>
      ) : null}

      {/* The hand-off. Rendered as a link and not only as a popup, because a
          blocked popup must not lose the order. */}
      {link ? (
        <div className="mt-4 max-w-2xl rounded-xl border border-ink bg-white p-4">
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="wa-link"
            className="flex h-14 items-center justify-center rounded-xl border border-ink bg-ink px-4 font-medium text-white"
          >
            Open WhatsApp
          </a>
          <pre className="mt-3 whitespace-pre-wrap text-sm text-muted">{link.body}</pre>
        </div>
      ) : null}

      {orders.length === 0 ? (
        <p className="mt-6 text-muted">
          Nothing on order. The reorder list is where orders start.
        </p>
      ) : null}

      <ul className="mt-4 max-w-3xl">
        {orders.map((order) => (
          <li key={order.po_id}>
            <button
              type="button"
              aria-pressed={picked?.po_id === order.po_id}
              onClick={() => void open(order)}
              className={`flex h-16 w-full items-center gap-4 border-b border-line px-3 text-left active:bg-line ${
                picked?.po_id === order.po_id ? 'bg-ink/5' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg">{order.supplier_name}</span>
                <span className="tabular block text-sm text-muted">
                  {order.po_no ?? 'draft'} · {order.lines} line
                  {order.lines === 1 ? '' : 's'}
                  {order.sends > 1 ? ` · sent ${order.sends}×` : ''}
                </span>
              </span>
              <span className="w-40 shrink-0 text-sm text-muted">
                {STATUS_LABEL[order.status] ?? order.status}
              </span>
              <span className="tabular w-24 shrink-0 text-right">
                ₹{Number(order.estimated_total).toFixed(2)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {picked ? (
        <>
          <h2 className="mt-8 text-lg font-medium">Lines</h2>
          <table className="mt-2 w-full max-w-3xl">
            <thead>
              <tr className="border-b border-line text-left text-sm text-muted">
                <th className="py-2">Drug</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">Outstanding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const pack = {
                  unitsPerStrip: line.default_units_per_strip ?? 1,
                  stripsPerBox: line.default_strips_per_box ?? 1,
                };
                return (
                  <tr key={line.po_line_id} className="border-b border-line">
                    <td className="py-3">
                      {line.drug_name}{' '}
                      <span className="text-sm text-muted">{line.strength}</span>
                      <span className="block text-sm text-muted">
                        {formatQty(line.ordered_qty_base, pack, line.base_unit, {
                          boxes: true,
                        })}
                      </span>
                    </td>
                    <td className="tabular text-right">{line.ordered_qty_base}</td>
                    <td className="tabular text-right">{line.received_qty_base}</td>
                    <td
                      className={`tabular text-right ${
                        line.outstanding_qty_base > 0 ? 'text-danger' : 'text-ok'
                      }`}
                    >
                      {line.outstanding_qty_base}
                    </td>
                    <td className="py-3 pl-3 text-right">
                      {picked.status === 'draft' ? (
                        <button
                          type="button"
                          aria-label={`Change ${line.drug_name}`}
                          onClick={() => {
                            setEditing(line);
                            setDigits('');
                          }}
                          className="h-11 rounded-lg border border-line px-3 text-sm active:bg-line"
                        >
                          Change
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {editing ? (
            <div className="mt-4 max-w-md rounded-xl border border-line bg-white p-4">
              <p className="text-lg">{editing.drug_name}</p>
              <p className="text-sm text-muted">
                Suggested {editing.suggested_qty_base ?? editing.ordered_qty_base} —
                the supplier&rsquo;s minimum order is a judgement this screen does
                not make.
              </p>
              <p className="tabular mt-3 text-4xl font-medium">{digits || '0'}</p>
              <div className="mt-4 w-64">
                <Numpad
                  onDigit={(digit) => setDigits((c) => (c + digit).slice(0, 6))}
                  onBackspace={() => setDigits((c) => c.slice(0, -1))}
                />
              </div>
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  disabled={busy || digits === ''}
                  onClick={() => void saveQty(Number(digits || '0'))}
                  className="h-14 flex-1 rounded-xl border border-ink bg-ink px-4 font-medium text-white disabled:opacity-40"
                >
                  Set quantity
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="h-14 rounded-xl border border-line px-5 text-muted active:bg-line"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {replying ? (
            <div className="mt-4 max-w-xl rounded-xl border border-line bg-white p-4">
              <label className="block text-sm text-muted" htmlFor="reply">
                What did the supplier say?
              </label>
              <input
                id="reply"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                className="mt-1 h-14 w-full rounded-xl border border-line px-3 text-lg"
              />
              <p className="mt-2 text-sm text-muted">
                Typed in by hand, because a deep link has no reply channel back
                into the app. It is worse than an API and much better than an
                order nobody is tracking.
              </p>
              <button
                type="button"
                disabled={busy || reply.trim() === ''}
                onClick={() => void saveReply()}
                className="mt-3 h-14 w-full rounded-xl border border-ink bg-ink font-medium text-white disabled:opacity-40"
              >
                Record reply
              </button>
            </div>
          ) : null}

          {picked.supplier_reply ? (
            <p className="mt-4 max-w-2xl rounded-lg bg-ok/10 p-3">
              Supplier: {picked.supplier_reply}
            </p>
          ) : null}

          {messages.length > 0 ? (
            <>
              <h2 className="mt-8 text-lg font-medium">What was sent</h2>
              <ul className="mt-2 max-w-2xl">
                {messages.map((message) => (
                  <li key={message.id} className="border-b border-line py-3">
                    <p className="tabular text-sm text-muted">
                      {new Date(message.at).toLocaleString('en-IN')} ·{' '}
                      {message.to_number} · {message.status}
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap text-sm">{message.body}</pre>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </ThreePane>
  );
}
