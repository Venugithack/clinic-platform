import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/*
 * Both faces are self-hosted at build time by next/font, so the clinic tablet
 * fetches nothing from Google at runtime. That matters here for more than
 * privacy: HOSTING.md §1a runs this on the clinic LAN, where a broadband
 * failure must not change what the screen looks like mid-consult.
 *
 * Archivo carries words. Plex Mono carries every value that has to be read
 * exactly — tokens, doses, batch numbers, quantities, money — because if
 * transcribing it wrong would matter, it is set in mono.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-archivo',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Jayamurugan Clinic',
  description: 'Consulting room and pharmacy',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Jayamurugan Clinic',
  },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A shared tablet on a stand: pinch-zoom mid-consult is an accident, not a
  // feature (TABLET.md §2 rule 7).
  maximumScale: 1,
  userScalable: false,
  // The clinic's own teal, so the installed app's chrome matches its masthead.
  themeColor: '#01554e',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
