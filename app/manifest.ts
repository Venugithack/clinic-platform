import type { MetadataRoute } from 'next';

/**
 * Installed, not a browser tab. TABLET.md §6.
 *
 * Fullscreen matters for more than looks: it means the browser cannot be
 * navigated away from mid-consult, which is a real failure mode on a device
 * three people share.
 *
 * This requires a secure context to install. On the clinic LAN that means
 * mkcert and the root CA on both tablets — see scripts/lan-https.sh and
 * BUILD.md §1.3. A service worker will not register over http://192.168.x.x,
 * and neither will the camera, so barcode scanning fails silently too.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Clinic',
    short_name: 'Clinic',
    start_url: '/',
    display: 'fullscreen',
    orientation: 'landscape',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
