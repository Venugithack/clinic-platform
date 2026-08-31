import { createHash, randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { parse } from 'csv-parse/sync'
import { getSession, hasRole } from '@/lib/server/auth'
import { audit, db, isoNow, transaction } from '@/lib/server/db'
import type { SaleClass } from '@/lib/types'

const headers = [
  'code', 'name', 'strength', 'dosage_form', 'unit', 'barcode', 'sale_class', 'reorder_level',
  'target_stock', 'supplier_code', 'batch_number', 'expiry', 'quantity', 'mrp', 'purchase_price', 'selling_price',
] as const

type CsvRow = Record<(typeof headers)[number], string>

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvResponse(rows: unknown[][], filename: string) {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  return new Response(`\uFEFF${csv}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(request: Request) {
  const jar = await cookies()
  const session = await getSession(jar.get('jayamurugan_session')?.value)
  if (!session || !hasRole(session, 'admin', 'pharmacy')) {
    return NextResponse.json({ ok: false, message: 'Inventory access required.' }, { status: 401 })
  }

  if (new URL(request.url).searchParams.get('template') === '1') {
    return csvResponse([
      [...headers],
      ['MED-100', 'Vitamin C', '500 mg', 'Tablet', 'tablets', '890100000100', 'otc', 20, 100,
        'SUP-001', 'VC2601', '2027-12-31', 50, 65, 42, 60],
    ], 'jayamurugan-inventory-template.csv')
  }

  const rows = await db.prepare(`select m.code,m.name,m.strength,m.dosage_form,m.unit,m.barcode,m.sale_class,
      m.reorder_level,m.target_stock,s.code supplier_code,b.batch_number,b.expiry,b.available_quantity,
      b.mrp,b.purchase_price,b.selling_price
    from medicines m left join suppliers s on s.id=m.preferred_supplier_id
    left join batches b on b.medicine_id=m.id order by m.name,b.expiry`).all() as Array<Record<string, unknown>>
  const exported = rows.map((row) => [
    row.code, row.name, row.strength, row.dosage_form, row.unit, row.barcode, row.sale_class,
    row.reorder_level, row.target_stock, row.supplier_code, row.batch_number, row.expiry,
    row.available_quantity, row.mrp, row.purchase_price, row.selling_price,
  ])
  return csvResponse([[...headers], ...exported], `jayamurugan-inventory-${isoNow().slice(0, 10)}.csv`)
}

function required(row: CsvRow, field: keyof CsvRow, index: number) {
  const result = String(row[field] ?? '').trim()
  if (!result) throw new Error(`Row ${index}: ${field} is required.`)
  return result
}

function amount(row: CsvRow, field: keyof CsvRow, index: number, minimum = 0) {
  const result = Number(required(row, field, index))
  if (!Number.isFinite(result) || result < minimum) throw new Error(`Row ${index}: ${field} must be at least ${minimum}.`)
  return result
}

export async function POST(request: Request) {
  const jar = await cookies()
  const session = await getSession(jar.get('jayamurugan_session')?.value)
  if (!session || !hasRole(session, 'admin', 'pharmacy')) {
    return NextResponse.json({ ok: false, message: 'Inventory access required.' }, { status: 401 })
  }

  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a CSV file.')
    if (file.size > 2_000_000) throw new Error('CSV must be smaller than 2 MB.')
    const text = await file.text()
    const hash = createHash('sha256').update(text).digest('hex')
    const duplicate = await db.prepare('select id from csv_imports where file_hash=?').get(hash)
    if (duplicate) throw new Error('This exact CSV file was already imported.')

    const rows = parse(text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[]
    if (rows.length === 0) throw new Error('The CSV has no medicine rows.')
    if (rows.length > 1_000) throw new Error('Import up to 1,000 rows at a time.')
    const seenBatches = new Set<string>()

    await transaction(async () => {
      for (const [offset, row] of rows.entries()) {
        const index = offset + 2
        const code = required(row, 'code', index).toUpperCase()
        const name = required(row, 'name', index)
        const unit = required(row, 'unit', index)
        const saleClass = required(row, 'sale_class', index) as SaleClass
        if (!['otc', 'prescription', 'restricted', 'unknown'].includes(saleClass)) {
          throw new Error(`Row ${index}: sale_class is not valid.`)
        }
        const reorderLevel = Math.floor(amount(row, 'reorder_level', index))
        const targetStock = Math.floor(amount(row, 'target_stock', index))
        if (targetStock < reorderLevel) throw new Error(`Row ${index}: target_stock must be at least reorder_level.`)
        const supplierCode = String(row.supplier_code ?? '').trim().toUpperCase()
        const supplier = supplierCode
          ? await db.prepare('select id from suppliers where code=? and active=1').get(supplierCode) as { id: string } | undefined
          : undefined
        if (supplierCode && !supplier) throw new Error(`Row ${index}: supplier_code ${supplierCode} was not found.`)

        const existing = await db.prepare('select id from medicines where code=?').get(code) as { id: string } | undefined
        const medicineId = existing?.id ?? randomUUID()
        if (existing) {
          await db.prepare(`update medicines set name=?,strength=?,dosage_form=?,unit=?,barcode=?,sale_class=?,
            reorder_level=?,target_stock=?,preferred_supplier_id=coalesce(?,preferred_supplier_id) where id=?`).run(
              name, row.strength ?? '', row.dosage_form ?? '', unit, row.barcode ?? '', saleClass,
              reorderLevel, targetStock, supplier?.id ?? null, medicineId,
            )
        } else {
          await db.prepare(`insert into medicines
            (id,code,name,strength,dosage_form,unit,barcode,sale_class,reorder_level,target_stock,preferred_supplier_id,active,created_at)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              medicineId, code, name, row.strength ?? '', row.dosage_form ?? '', unit, row.barcode ?? '', saleClass,
              reorderLevel, targetStock, supplier?.id ?? null, 1, isoNow(),
            )
        }
        if (supplier) {
          await db.prepare(`insert into supplier_medicines (supplier_id,medicine_id,active) values (?,?,1)
            on conflict (supplier_id,medicine_id) do update set active=1`)
            .run(supplier.id, medicineId)
        }

        const batchNumber = String(row.batch_number ?? '').trim()
        const quantity = Number(row.quantity || 0)
        if (batchNumber || quantity > 0) {
          if (!batchNumber) throw new Error(`Row ${index}: batch_number is required when quantity is provided.`)
          const key = `${medicineId}:${batchNumber.toLowerCase()}`
          if (seenBatches.has(key)) throw new Error(`Row ${index}: batch ${batchNumber} is repeated in the file.`)
          seenBatches.add(key)
          if (await db.prepare('select id from batches where medicine_id=? and lower(batch_number)=lower(?)').get(medicineId, batchNumber)) {
            throw new Error(`Row ${index}: batch ${batchNumber} already exists. CSV never overwrites stock balances.`)
          }
          const finalQuantity = Math.floor(amount(row, 'quantity', index, 1))
          const expiry = required(row, 'expiry', index)
          const batchId = randomUUID()
          await db.prepare(`insert into batches
            (id,medicine_id,batch_number,expiry,available_quantity,mrp,purchase_price,selling_price,received_from_supplier_id,received_at)
            values (?,?,?,?,?,?,?,?,?,?)`).run(
              batchId, medicineId, batchNumber, expiry, finalQuantity, amount(row, 'mrp', index),
              amount(row, 'purchase_price', index), amount(row, 'selling_price', index), supplier?.id ?? null, isoNow(),
            )
          await db.prepare(`insert into stock_movements
            (id,medicine_id,batch_id,movement_type,quantity_delta,reference_type,reference_id,actor_id,created_at)
            values (?,?,?,?,?,?,?,?,?)`).run(
              randomUUID(), medicineId, batchId, 'csv_import', finalQuantity, 'csv_import', hash, session.staffId, isoNow(),
            )
        }
      }
      await db.prepare(`insert into csv_imports (id,file_hash,row_count,actor_id,created_at) values (?,?,?,?,?)`)
        .run(randomUUID(), hash, rows.length, session.staffId, isoNow())
      await audit(session.staffId, 'inventory.csv_import', 'csv_import', hash, `Imported ${rows.length} inventory row(s)`)
    })

    return NextResponse.json({ ok: true, message: `${rows.length} inventory row(s) imported.` })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CSV import failed.'
    return NextResponse.json({ ok: false, message }, { status: 400 })
  }
}
