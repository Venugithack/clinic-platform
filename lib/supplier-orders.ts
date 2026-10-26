/**
 * What still needs ordering, and the link that hands an order to WhatsApp.
 *
 * `create_order` decides what to draft on the server with the same rule; this
 * is the screen's copy of it, so the Orders list and the Counter's reminder
 * never offer something the draft would then leave out. The rule: a medicine
 * needs an order when what is on the shelf plus what is already on its way is
 * at or below its reorder level.
 */
import type { MedicineView, PurchaseOrderView } from '@/lib/types'

/** An order whose outstanding quantity is still coming. */
const OPEN: ReadonlyArray<PurchaseOrderView['status']> = ['pending', 'placed', 'partially_delivered']

/** Base units ordered and not yet received, per medicine, across open orders. */
export function onOrderByMedicine(orders: readonly PurchaseOrderView[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const order of orders) {
    if (!OPEN.includes(order.status)) continue
    for (const line of order.lines) {
      const outstanding = Math.max(line.orderedQuantity - line.receivedQuantity, 0)
      totals.set(line.medicineId, (totals.get(line.medicineId) ?? 0) + outstanding)
    }
  }
  return totals
}

export type ReorderRow = {
  medicine: MedicineView
  onOrder: number
  /** True when shelf plus on-order is at or below the reorder level. */
  needsOrder: boolean
}

/**
 * Every active medicine at or below its reorder level on the shelf, and whether
 * what is already on order covers it.
 */
export function reorderRows(
  medicines: readonly MedicineView[],
  orders: readonly PurchaseOrderView[],
): ReorderRow[] {
  const onOrder = onOrderByMedicine(orders)
  return medicines
    .filter((medicine) => medicine.active && medicine.totalAvailable <= medicine.reorderLevel)
    .map((medicine) => {
      const coming = onOrder.get(medicine.id) ?? 0
      return {
        medicine,
        onOrder: coming,
        needsOrder: medicine.totalAvailable + coming <= medicine.reorderLevel,
      }
    })
}

/**
 * WhatsApp's click-to-chat link, with the message filled in.
 *
 * It opens the pharmacist's own WhatsApp — the app on a phone or tablet,
 * WhatsApp Web on a desktop — so nothing leaves from the clinic's business
 * number and nothing is sent until the person presses send there. `number` is
 * already dialable: country code, digits only, as the snapshot provides it.
 */
export function whatsAppLink(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`
}
