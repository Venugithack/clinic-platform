import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clinic',
  description: 'Consulting room and pharmacy',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Clinic' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A shared tablet on a stand: pinch-zoom mid-consult is an accident, not a
  // feature (TABLET.md §2 rule 7).
  maximumScale: 1,
  userScalable: false,
  themeColor: '#ffffff',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
