'use client';

/**
 * The scan affordance. TABLET.md §4, INVENTORY.md §2.
 *
 * "One persistent camera affordance in the action rail on the counter, receipt
 * and stock-take screens. Scan feedback is a sound plus a colour flash, not a
 * dialog — the pharmacist is looking at the strip, not the screen."
 *
 * Manual entry sits beside the camera and is not a fallback of last resort: a
 * scuffed strip, a denied permission or a tablet without BarcodeDetector are
 * all ordinary, and none of them may stop the counter. Typing thirteen digits
 * is slower, not impossible.
 */
import { useEffect, useRef, useState } from 'react';
import { scanningSupported, startScanning, type Scanner } from '@/lib/barcode';

export function ScanField({
  label,
  onCode,
  autoStart = true,
}: {
  label: string;
  onCode: (code: string) => void;
  autoStart?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const supported = scanningSupported();

  useEffect(() => {
    if (!autoStart || !supported || !videoRef.current) return;
    let cancelled = false;

    void startScanning(videoRef.current, onCode, setNotice).then((scanner) => {
      if (cancelled) {
        scanner.stop();
        return;
      }
      scannerRef.current = scanner;
      setScanning(true);
    });

    return () => {
      cancelled = true;
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
  }, [autoStart, supported, onCode]);

  return (
    <div className="rounded-xl border border-line bg-white p-4" data-testid="scanfield">
      <p className="text-sm text-muted">{label}</p>

      {supported ? (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera"
          className={`mt-3 h-40 w-full rounded-lg bg-ink/5 object-cover ${
            scanning ? '' : 'opacity-50'
          }`}
        />
      ) : (
        <p className="mt-3 text-sm text-muted">
          This tablet cannot scan. Type the code from the strip.
        </p>
      )}

      {notice ? <p className="mt-2 text-sm text-danger">{notice}</p> : null}

      <div className="mt-3 flex gap-3">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Barcode"
          inputMode="numeric"
          placeholder="Or type the code"
          className="tabular h-14 flex-1 rounded-xl border border-line px-4 text-lg"
        />
        <button
          type="button"
          disabled={typed.trim().length < 6}
          onClick={() => {
            onCode(typed.trim());
            setTyped('');
          }}
          className="h-14 rounded-xl border border-ink bg-ink px-5 font-medium text-white disabled:opacity-40"
        >
          Check
        </button>
      </div>
    </div>
  );
}
