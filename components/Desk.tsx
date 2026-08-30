'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { currentSession, type StaffSession } from '@/lib/auth';
import { WorkspaceTabs } from '@/components/WorkspaceTabs';
import {
  WORKSPACES,
  homeFor,
  resolveSection,
  resolveTab,
  type WorkspaceId,
} from '@/lib/workspaces';
import type { PanelProps } from '@/components/panels/types';

import { CounterPanel } from '@/components/panels/Counter';
import { ShelfPanel } from '@/components/panels/Shelf';
import { AddStockPanel } from '@/components/panels/AddStock';
import { ExpiringPanel } from '@/components/panels/Expiring';
import { CountShelfPanel } from '@/components/panels/CountShelf';
import { RunningOutPanel } from '@/components/panels/RunningOut';
import { OrdersPanel } from '@/components/panels/Orders';
import { SuppliersPanel } from '@/components/panels/Suppliers';
import { MedicinesPanel } from '@/components/panels/Medicines';
import { BillsPanel } from '@/components/panels/Bills';
import { DayBookPanel } from '@/components/panels/DayBook';
import { RegistersPanel } from '@/components/panels/Registers';
import { WaitingPanel } from '@/components/panels/Waiting';
import { PresencePanel } from '@/components/panels/Presence';
import { TodayPanel } from '@/components/panels/Today';
import { StaffPanel } from '@/components/panels/Staff';
import { ClinicSettingsPanel } from '@/components/panels/ClinicSettings';
import { ImportDataPanel } from '@/components/panels/ImportData';

/**
 * One desk, everything on it.
 *
 * Replaces twenty routes behind a drawer with three: `/queue`, `/counter` and
 * `/admin/home`. Which panel is on screen is a query parameter, not a path, and
 * the reasons are in components/WorkspaceTabs.
 *
 * ── WHY THE PANELS ARE IMPORTED, NOT LAZY ───────────────────────────────────
 *
 * `next.config.ts` sets `output: 'export'`: the whole app is prerendered to
 * files on Cloudflare and there is no server to ask for a chunk mid-shift. A
 * pharmacist who opens Add stock on a dropped connection has to get Add stock,
 * so every panel this desk can show ships with the desk. The cost is a larger
 * first load on a screen that is opened once at the start of a shift and then
 * left open all day, which is the right trade in a clinic and would be the
 * wrong one almost anywhere else.
 */
const PANELS: Record<string, (props: PanelProps) => React.ReactNode> = {
  // Consulting room. The last two are the doctor wearing the proprietor's hat:
  // both screens allow `doctor` in their own permission checks, and the
  // administration desk that otherwise holds them is closed to a doctor by
  // app/(clinic)/layout.tsx. See OWNER in lib/workspaces.ts.
  'clinical/waiting': WaitingPanel,
  'clinical/presence': PresencePanel,
  'clinical/registers': RegistersPanel,
  'clinical/setup/clinic': ClinicSettingsPanel,
  'clinical/setup/import': ImportDataPanel,

  // Pharmacy — the doctor stands here too, which is why PHARMACY in
  // lib/workspaces.ts is ['counter', 'doctor'].
  'pharmacy/counter': CounterPanel,
  'pharmacy/shelf/on-hand': ShelfPanel,
  'pharmacy/shelf/add-stock': AddStockPanel,
  'pharmacy/shelf/expiring': ExpiringPanel,
  'pharmacy/shelf/count': CountShelfPanel,
  'pharmacy/buying/low-stock': RunningOutPanel,
  'pharmacy/buying/orders': OrdersPanel,
  'pharmacy/buying/suppliers': SuppliersPanel,
  'pharmacy/medicines': MedicinesPanel,
  'pharmacy/money/bills': BillsPanel,
  'pharmacy/money/day-book': DayBookPanel,
  'pharmacy/money/registers': RegistersPanel,

  // Administration. The two catalogue panels are the same components the
  // pharmacy desk mounts — the owner is locked out of /counter by the clinic
  // layout, so the masters have to be reachable from here as well.
  'admin/today': TodayPanel,
  'admin/staff': StaffPanel,
  'admin/clinic': ClinicSettingsPanel,
  'admin/catalogue/medicines': MedicinesPanel,
  'admin/catalogue/suppliers': SuppliersPanel,
  'admin/registers': RegistersPanel,
  'admin/import': ImportDataPanel,
};

export function Desk({ id }: { id: WorkspaceId }) {
  // useSearchParams() forces everything up to the nearest Suspense boundary to
  // be client-rendered, and a static export fails the build without one. Same
  // treatment as /consult and /counter/dispense, for the same reason.
  return (
    <Suspense fallback={null}>
      <DeskBody id={id} />
    </Suspense>
  );
}

function DeskBody({ id }: { id: WorkspaceId }) {
  const params = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<StaffSession | null>(null);
  const [read, setRead] = useState(false);

  // Read after mount, never during render: currentSession() touches storage,
  // and this page is prerendered at build time where there is no window.
  // Reading it in render is what makes a static export hydrate to different
  // markup than it shipped. Same rule as ThreePane.
  useEffect(() => {
    setSession(currentSession());
    setRead(true);
  }, []);

  const space = WORKSPACES.find((entry) => entry.id === id) ?? null;
  const role = session?.role;
  const tab = space ? resolveTab(space, role, params.get('tab')) : null;
  const section = resolveSection(tab, params.get('section'));

  /**
   * A desk with nothing on it for this person.
   *
   * The clinic layout bars an administrator from /counter and everybody else
   * from /admin, but nothing stops a nurse typing the pharmacy's URL — and
   * before this they got a blank screen: no error, no heading, nothing to
   * report to anybody. Send them to the desk they do work at instead.
   *
   * Guarded on `role` as well as `read`, because homeFor(undefined) is /queue
   * and firing this without a role would make /queue redirect to itself.
   */
  useEffect(() => {
    if (!read || tab || !role) return;
    router.replace(homeFor(role));
  }, [read, tab, role, router]);

  if (!space || !tab) return null;

  const key = section ? `${id}/${tab.id}/${section.id}` : `${id}/${tab.id}`;
  const Panel = PANELS[key];
  if (!Panel) return null;

  const chrome = (
    <WorkspaceTabs space={space} role={role} activeTab={tab} activeSection={section} />
  );

  // Keyed on the panel, so switching tabs remounts rather than handing the next
  // panel the last one's half-finished state. A stock-take that is three rows
  // in must not reappear underneath the dispensing counter.
  return <Panel key={key} chrome={chrome} />;
}
