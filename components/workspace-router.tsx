import type { ClinicSnapshot, CommandResponse, Role } from '@/lib/types'
import { ConsultationPanel, QueuePanel, RecordsPanel, VitalsPanel } from './care-workspaces'
import type { ActionRunner } from './clinic-context'
import { DayBookPanel } from './day-book-panel'
import { ExpiringPanel } from './expiring-panel'
import type { View } from './navigation'
import { CounterPanel, InventoryPanel, OrdersPanel, SuppliersPanel } from './pharmacy-workspace'
import {
  AuditPanel,
  BedsPanel,
  BillingPanel,
  ClinicSettingsPanel,
  OverviewPanel,
  PatientsPanel,
  PrinterPanel,
  RegistersPanel,
} from './shared-panels'
import { StaffPanel } from './staff-panel'
import { StockTakePanel } from './stock-take-panel'

type WorkspaceRouterProps = {
  view: View
  data: ClinicSnapshot
  run: ActionRunner
  uploadCsv: (file: File) => Promise<CommandResponse>
  roles: Role[]
}

/** Maps navigation state to a feature workspace so the application shell stays UI-agnostic. */
export function WorkspaceRouter({ view, data, run, uploadCsv, roles }: WorkspaceRouterProps) {
  switch (view) {
    case 'patients':
      return (
        <PatientsPanel
          data={data}
          run={run}
          canRegister={!roles.includes('doctor') || roles.includes('admin') || roles.includes('nurse')}
        />
      )
    case 'queue':
      return <QueuePanel data={data} run={run} />
    case 'vitals':
      return <VitalsPanel data={data} run={run} />
    case 'consultation':
      return <ConsultationPanel data={data} run={run} />
    case 'records':
      return <RecordsPanel data={data} />
    case 'beds':
      return <BedsPanel data={data} run={run} />
    case 'billing':
      return <BillingPanel data={data} run={run} />
    case 'stocktake':
      return <StockTakePanel data={data} run={run} />
    case 'daybook':
      return <DayBookPanel data={data} run={run} />
    case 'expiring':
      return <ExpiringPanel data={data} run={run} />
    case 'registers':
      return <RegistersPanel data={data} />
    case 'clinic':
      return <ClinicSettingsPanel data={data} run={run} />
    case 'staff':
      return <StaffPanel data={data} run={run} />
    case 'counter':
      return <CounterPanel data={data} run={run} />
    case 'inventory':
      return <InventoryPanel data={data} run={run} uploadCsv={uploadCsv} />
    case 'suppliers':
      return <SuppliersPanel data={data} run={run} />
    case 'orders':
      return <OrdersPanel data={data} run={run} />
    case 'printer':
      return <PrinterPanel />
    case 'audit':
      return <AuditPanel data={data} />
    default:
      return <OverviewPanel data={data} />
  }
}
