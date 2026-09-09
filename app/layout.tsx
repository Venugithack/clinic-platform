import type { Metadata, Viewport } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'

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
  themeColor: '#191c1a',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
