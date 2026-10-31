import type { Metadata, Viewport } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import { THEME_BOOT_SCRIPT } from '@/components/theme'

/**
 * Archivo labels, names and prose. IBM Plex Mono carries every value that has
 * to be read exactly — tokens, ids, doses, stock counts, amounts, vitals,
 * times. The split is the typographic rule of this system: if transcribing it
 * wrong would matter, it is set in mono.
 *
 * Both are self-hosted at build time, so the clinic tablets never call out to
 * a font CDN on the clinic Wi-Fi.
 */
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Jayamurugan Clinic',
  description: 'Clinic operations, pharmacy and patient care from one tablet-first workspace.',
  applicationName: 'Jayamurugan Clinic',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately no maximumScale: a nurse holding a tablet at arm's length
  // must be able to pinch-zoom a batch number or an expiry date.
  //
  // Two colours, because the browser paints its own chrome from this and a
  // pale bar above Night shift is the one part of the tablet the theme cannot
  // otherwise reach.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f0f5f3' },
    { media: '(prefers-color-scheme: dark)', color: '#121815' },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      // The boot script below rewrites `data-theme` before React sees the
      // document, so the server's guess and the browser's truth differ by
      // design. Without this, React treats the correction as a hydration error
      // and re-renders from the nearest boundary — which throws the correction
      // away and paints the wrong theme.
      data-theme="paper"
      suppressHydrationWarning
      className={`${archivo.variable} ${plexMono.variable}`}
    >
      <head>
        {/*
         * Runs while the HTML is still being parsed, before the first paint.
         *
         * A static export has no server to read a preference at request time,
         * and an effect runs after paint — which on a tablet waking up in a
         * dim room means a white flash in somebody's face before Night shift
         * arrives. The Content-Security-Policy in public/_headers allows
         * 'unsafe-inline' for exactly this.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
