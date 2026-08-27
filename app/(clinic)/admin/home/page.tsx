'use client';

import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';

interface AdminDestination {
  title: string;
  description: string;
  href?: Route;
}

const SECTIONS: Array<{ title: string; items: AdminDestination[] }> = [
  {
    title: 'Clinic setup',
    items: [
      {
        title: 'People & access',
        description: 'Doctors, nurses, pharmacy staff, roles and everyday PIN access.',
        href: '/admin',
      },
      {
        title: 'Clinic settings',
        description: 'Clinic identity, consultation fee, licences, opening hours and contact details.',
        href: '/settings',
      },
    ],
  },
  {
    title: 'Go-live data',
    items: [
      {
        title: 'Import medicine master',
        description: 'Load the medicine catalogue and suppliers from CSV with a dry-run preview before anything is written.',
        href: '/import',
      },
      {
        title: 'Opening stock',
        description: 'Load the physical shelf after the medicine master, with batch, expiry, quantity, rate basis, MRP and supplier.',
        href: '/import',
      },
    ],
  },
  {
    title: 'Medicines & stock',
    items: [
      {
        title: 'Medicines',
        description: 'Medicine master, pack defaults, schedule and low-stock/reorder configuration.',
        href: '/medicines',
      },
      {
        title: 'Inventory',
        description: 'Current shelf stock, batches, stock movements and stock-take entry points.',
        href: '/inventory',
      },
      {
        title: 'Expiry & returns',
        description: 'Expiring batches, supplier return windows and expiry write-offs.',
        href: '/expiry',
      },
    ],
  },
  {
    title: 'Suppliers & purchasing',
    items: [
      {
        title: 'Suppliers',
        description: 'Supplier contacts, WhatsApp numbers and medicine-to-supplier mappings.',
        href: '/suppliers',
      },
      {
        title: 'Low stock & reorder',
        description: 'Review stock suggestions and create draft purchase orders without duplicating medicines already on order.',
        href: '/reorder',
      },
      {
        title: 'Purchase orders',
        description: 'Review orders, hand them to WhatsApp and record supplier replies.',
        href: '/orders',
      },
      {
        title: 'Receiving',
        description: 'Receive deliveries against purchase orders and update batch stock.',
        href: '/receiving',
      },
    ],
  },
  {
    title: 'Money & records',
    items: [
      {
        title: 'Billing',
        description: 'Bills, payments and pharmacy billing workflows.',
        href: '/billing',
      },
      {
        title: 'Day book',
        description: 'Daily takings, cash movement and till reconciliation.',
        href: '/day-book',
      },
      {
        title: 'Reports',
        description: 'Clinical, pharmacy and statutory records already available in the system.',
        href: '/reports',
      },
    ],
  },
];

export default function AdminHomePage() {
  const router = useRouter();
  const session = typeof window === 'undefined' ? null : currentSession();
  const allowed = session?.role === 'admin';

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Administration</h2>
          <p className="mt-1 text-lg">Clinic control panel</p>
          <p className="mt-5 text-sm text-ink-2">
            Configure the team, medicines, stock, suppliers and clinic settings here. Staff can then sign in from any browser using their name and PIN.
          </p>
        </div>
      }
      rail={
        <>
          <RailButton tone="primary" onClick={() => router.push('/')}>
            Staff sign in
          </RailButton>
          <RailButton onClick={() => router.push('/admin')}>People & access</RailButton>
          <RailButton onClick={() => router.push('/medicines')}>Medicines</RailButton>
          <RailButton onClick={() => router.push('/suppliers')}>Suppliers</RailButton>
          <RailButton onClick={() => router.push('/reorder')}>Low stock</RailButton>
          <RailButton onClick={() => router.push('/import')}>Import data</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/settings')}>Clinic settings</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="Clinic control panel" sub={session?.staffName} />

      {!allowed ? (
        <Notice tone="bad">Only an administrator can open the clinic control panel.</Notice>
      ) : (
        <div className="mt-6 max-w-5xl space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="eyebrow">{section.title}</h2>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {section.items.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    disabled={!item.href}
                    onClick={() => item.href && router.push(item.href)}
                    className="min-h-28 rounded-box border border-rule bg-sheet p-4 text-left active:bg-paper-2 disabled:cursor-default disabled:opacity-55"
                  >
                    <span className="text-lg font-medium">{item.title}</span>
                    <span className="mt-2 block text-sm leading-5 text-ink-2">{item.description}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </ThreePane>
  );
}
