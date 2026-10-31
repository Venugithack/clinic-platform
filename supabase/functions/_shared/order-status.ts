import type { PurchaseOrderView } from './types.ts'

export function deliveredOrderStatus(ordered: number, received: number): PurchaseOrderView['status'] {
  if (received <= 0) return 'placed'
  return received >= ordered ? 'delivered' : 'partially_delivered'
}
