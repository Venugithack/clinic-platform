'use client';

import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { ThreePane } from '@/components/ThreePane';
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
        title: 'Staff access',
        description: 'Doctors, nurses, pharmacy/counter staff, administrators and their PINs.',
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
      { title: 'Medicines', description: 'Medicine master, pack defaults, schedule and low-stock/reorder configuration.', href: '/medicines' },
      { title: 'Inventory', description: 'Current shelf stock, batches, stock movements and stock-take entry points.', href: '/inventory' },
      { title: 'Expiry & returns', description: 'Expiring batches, supplier return windows and expiry write-offs.', href: '/expiry' },
    ],
  },
  {
    title: 'Suppliers & purchasing',
    items: [
      { title: 'Suppliers', description: 'Supplier contacts, WhatsApp numbers and medicine-to-supplier mappings.', href: '/suppliers' },
      { title: 'Low stock & reorder', description: 'Review stock suggestions and create draft purchase orders without duplicating medicines already on order.', href: '/reorder' },
      { title: 'Purchase orders', description: 'Review orders, hand them to WhatsApp and record supplier replies.', href: '/orders' },
      { title: 'Receiving', description: 'Receive deliveries against purchase orders and update batch stock.', href: '/receiving' },
    ],
  },
  {
    title: 'Money & records',
    items: [
      { title: 'Billing', description: 'Bills, payments and counter billing workflows.', href: '/billing' },
      { title: 'Day book', description: 'Daily takings, cash movement and till reconciliation.', href: '/day-book' },
      { title: 'Reports', description: 'Clinical, pharmacy and statutory records already available in the system.', href: '/reports' },
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
          <p className="mt-1 text-lg">Clinic control center</p>
          <p className="mt-5 text-sm text-ink-2">
            Configuration and back-office work lives here. Doctor, nurse and pharmacy workflows stay on their own operational screens.
          </p>
          <p className="mt-4 text-sm text-ink-2">
            Sign out — under Go to — before handing a shared computer to another staff member. Their PIN will then identify their work separately.
          </p>
        </div>
      }
    >
      <PageHeader eyebrow="Administration" title="Clinic control center" sub={session?.staffName} />

      {!allowed ? (
        <Notice tone="bad">Only an administrator can open the clinic control center.</Notice>
      ) : (
        <div className="mt-6 max-w-5xl space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="eyebrow">{section.title}</h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
