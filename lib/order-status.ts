import type { PurchaseOrderView } from './types'

export function deliveredOrderStatus(ordered: number, received: number): PurchaseOrderView['status'] {
  if (received <= 0) return 'placed'
  return received >= ordered ? 'delivered' : 'partially_delivered'
}

export function reorderQuantity(available: number, targetStock: number) {
  return Math.max(Math.floor(targetStock) - Math.floor(available), 1)
}
