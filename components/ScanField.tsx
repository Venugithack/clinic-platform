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
    <div className="rounded-box border border-rule bg-sheet p-4" data-testid="scanfield">
      <p className="eyebrow">{label}</p>

      {supported ? (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera"
          className={`mt-3 h-40 w-full rounded-box bg-paper-2 object-cover ${
            scanning ? '' : 'opacity-50'
          }`}
        />
      ) : (
        <p className="mt-3 text-sm text-ink-2">
          This device cannot scan. Type the code from the strip.
        </p>
      )}

      {notice ? <p className="mt-2 text-sm text-stop">{notice}</p> : null}

      {/*
        `min-w-0` and `flex-wrap` are both load-bearing, and this is the same
        failure the shell grid had, one level down.

        An <input> carries an intrinsic width from its `size` attribute —
        twenty characters, about 248px here. `flex-1` is `flex: 1 1 0%`, but a
        flex item's `min-width` defaults to `auto`, which is that intrinsic
        width. So the input refused to shrink, and in the 200px action rail it
        pushed "Check" 186px past the right-hand edge — off the screen, on the
        two screens where a pharmacist scans a strip.

        Caught at 1024px AND at 1280px, which is the tablet the clinic actually
        uses and the viewport the e2e suite runs at.

        With `min-w-0` the input can shrink, and `basis-32` + `flex-wrap` puts
        the button on its own line rather than crushing both: in the rail they
        stack, and in a wide work pane they sit side by side.
      */}
      <div className="mt-3 flex flex-wrap gap-3">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Barcode"
          inputMode="numeric"
          placeholder="Code"
          className="blank tabular h-14 min-w-0 flex-1 basis-32 px-4 text-lg"
        />
        <button
          type="button"
          disabled={typed.trim().length < 6}
          onClick={() => {
            onCode(typed.trim());
            setTyped('');
          }}
          className="h-14 shrink-0 grow rounded-box border border-ink bg-ink px-5 font-medium text-paper disabled:border-rule disabled:bg-transparent disabled:text-ink-3"
        >
          Check
        </button>
      </div>
    </div>
  );
}
