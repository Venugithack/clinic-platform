/**
 * Reading a barcode off a pharmacy strip. INVENTORY.md §2.
 *
 * `BarcodeDetector` where the tablet supports it. It is native, fast, and needs
 * no library — which matters, because the whole point of scanning here is that
 * it costs nothing: no scanner hardware, no drivers, no per-device licence.
 *
 * Two things this module deliberately keeps:
 *
 *   a manual fallback — a scuffed strip, a dead camera or a denied permission
 *   must not stop the counter. Typing the digits is slower, not impossible.
 *
 *   an explicit unsupported state — so the screen can say "this tablet cannot
 *   scan" once, rather than showing a camera button that never works.
 *
 * Note the secure-context requirement: getUserMedia does not exist over
 * http://192.168.x.x, so on the clinic LAN this needs the mkcert certificate
 * from BUILD.md §1.3. Without it the camera fails silently, which is exactly
 * what that section exists to prevent.
 */

/** The symbologies on Indian pharmacy packaging. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function detectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  return candidate ?? null;
}

export function scanningSupported(): boolean {
  return detectorConstructor() !== null && typeof navigator?.mediaDevices?.getUserMedia === 'function';
}

export interface Scanner {
  stop: () => void;
}

/**
 * Start the camera and call `onCode` for each distinct code seen.
 *
 * Repeats are suppressed: a strip sits in frame for many video frames, and the
 * counter should not get twenty scans for one box.
 */
export async function startScanning(
  video: HTMLVideoElement,
  onCode: (code: string) => void,
  onError?: (message: string) => void,
): Promise<Scanner> {
  const Detector = detectorConstructor();
  if (!Detector) {
    onError?.('This tablet cannot scan. Type the code instead.');
    return { stop: () => {} };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The rear camera, and a resolution high enough for a 13-digit EAN at
      // arm's length without being wasteful.
      video: { facingMode: 'environment', width: { ideal: 1280 } },
    });
  } catch {
    onError?.('The camera is not available. Type the code instead.');
    return { stop: () => {} };
  }

  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const detector = new Detector({ formats: FORMATS });
  let running = true;
  let last = '';
  let lastAt = 0;

  const tick = async () => {
    if (!running) return;
    try {
      const codes = await detector.detect(video);
      const code = codes[0]?.rawValue?.trim();
      // 1.5s between repeats of the same code: long enough not to double-count
      // one box, short enough to scan the same drug twice on purpose.
      if (code && (code !== last || Date.now() - lastAt > 1500)) {
        last = code;
        lastAt = Date.now();
        onCode(code);
      }
    } catch {
      // A frame that will not decode is the normal case, not an error.
    }
    if (running) requestAnimationFrame(() => void tick());
  };

  void tick();

  return {
    stop: () => {
      running = false;
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
