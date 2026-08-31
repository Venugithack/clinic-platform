import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Jayamurugan Clinic',
    short_name: 'Jayamurugan',
    description: 'Tablet-first clinic operations for Jayamurugan Clinic.',
    start_url: '/',
    display: 'standalone',
    // Ledger stock and ink — the two surfaces the whole interface is built on.
    background_color: '#e7e6e0',
    theme_color: '#191c1a',
    orientation: 'any',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
