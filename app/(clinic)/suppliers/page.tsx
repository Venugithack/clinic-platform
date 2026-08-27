'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Field, Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import {
  allSupplierDrugLinks,
  allSuppliers,
  supplierMedicines,
  type SupplierAdminRow,
  type SupplierDrugRow,
  type SupplierMedicineRow,
} from '@/lib/db/suppliers';
import { addSupplier, setDrugSupplier, updateSupplier } from '@/lib/transitions/suppliers';

type EditorMode = 'add' | 'edit' | null;

interface FormState {
  name: string;
  contactName: string;
  whatsappNumber: string;
  phone: string;
  email: string;
  gstin: string;
  leadTimeDays: string;
  returnWindowDays: string;
  paymentTerms: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  contactName: '',
  whatsappNumber: '',
  phone: '',
  email: '',
  gstin: '',
  leadTimeDays: '',
  returnWindowDays: '',
  paymentTerms: '',
};

export default function SuppliersPage() {
  const router = useRouter();
  const session = currentSession();
  const allowed = session?.role === 'admin';

  const [suppliers, setSuppliers] = useState<SupplierAdminRow[]>([]);
  const [links, setLinks] = useState<SupplierDrugRow[]>([]);
  const [medicines, setMedicines] = useState<SupplierMedicineRow[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [linkDrugId, setLinkDrugId] = useState('');
  const [linkPreferred, setLinkPreferred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (keep?: string | null) => {
    setError(null);
    try {
      const [nextSuppliers, nextLinks, nextMedicines] = await Promise.all([
        allSuppliers(),
        allSupplierDrugLinks(),
        supplierMedicines(),
      ]);
      setSuppliers(nextSuppliers);
      setLinks(nextLinks);
      setMedicines(nextMedicines);
      const wanted = keep ?? pickedId;
      if (wanted && nextSuppliers.some((row) => row.id === wanted)) setPickedId(wanted);
      else if (!wanted && nextSuppliers.length > 0) setPickedId(nextSuppliers[0]?.id ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [pickedId]);

  useEffect(() => {
    if (allowed) void refresh(null);
  }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = suppliers.find((row) => row.id === pickedId) ?? null;
  const pickedLinks = useMemo(
    () => links.filter((row) => row.supplier_id === pickedId && row.active),
    [links, pickedId],
  );
  const linkedDrugIds = useMemo(
    () => new Set(pickedLinks.map((row) => row.drug_id)),
    [pickedLinks],
  );
  const availableMedicines = medicines.filter((drug) => !linkedDrugIds.has(drug.id));
  const medicineById = useMemo(
    () => new Map(medicines.map((drug) => [drug.id, drug])),
    [medicines],
  );

  const numberOrUndefined = (value: string): number | undefined => {
    if (value.trim() === '') return undefined;
    return Number(value);
  };

  const openAdd = () => {
    setMode('add');
    setForm(EMPTY_FORM);
    setError(null);
    setNotice(null);
  };

  const openEdit = () => {
    if (!picked) return;
    setMode('edit');
    setForm({
      name: picked.name,
      contactName: picked.contact_name ?? '',
      whatsappNumber: picked.whatsapp_number ?? '',
      phone: picked.phone ?? '',
      email: picked.email ?? '',
      gstin: picked.gstin ?? '',
      leadTimeDays: picked.lead_time_days?.toString() ?? '',
      returnWindowDays: picked.return_window_days?.toString() ?? '',
      paymentTerms: picked.payment_terms ?? '',
    });
    setError(null);
    setNotice(null);
  };

  const saveSupplier = async () => {
    if (!allowed || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const input = {
        name: form.name,
        contactName: form.contactName,
        whatsappNumber: form.whatsappNumber,
        phone: form.phone,
        email: form.email,
        gstin: form.gstin,
        leadTimeDays: numberOrUndefined(form.leadTimeDays),
        returnWindowDays: numberOrUndefined(form.returnWindowDays),
        paymentTerms: form.paymentTerms,
      };

      const saved = mode === 'edit' && picked
        ? await updateSupplier(picked.id, input)
        : await addSupplier(input);

      setMode(null);
      setForm(EMPTY_FORM);
      setNotice(`${saved.name} saved.`);
      await refresh(saved.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeActive = async () => {
    if (!picked || !allowed) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateSupplier(picked.id, { active: !picked.active });
      setNotice(
        saved.active
          ? `${saved.name} is available for purchasing again.`
          : `${saved.name} is inactive. Existing orders and receipts are unchanged.`,
      );
      await refresh(saved.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addMedicineLink = async () => {
    if (!picked || !linkDrugId || !allowed) return;
    setBusy(true);
    setError(null);
    try {
      await setDrugSupplier({
        drugId: linkDrugId,
        supplierId: picked.id,
        preferred: linkPreferred,
        active: true,
      });
      const drug = medicineById.get(linkDrugId);
      setNotice(
        `${drug?.name ?? 'Medicine'} linked to ${picked.name}${linkPreferred ? ' as preferred supplier' : ''}.`,
      );
      setLinkDrugId('');
      setLinkPreferred(false);
      await refresh(picked.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makePreferred = async (link: SupplierDrugRow) => {
    if (!picked || !allowed) return;
    setBusy(true);
    setError(null);
    try {
      await setDrugSupplier({
        drugId: link.drug_id,
        supplierId: picked.id,
        preferred: true,
        active: true,
      });
      setNotice(`${picked.name} is now the preferred supplier for ${medicineById.get(link.drug_id)?.name ?? 'this medicine'}.`);
      await refresh(picked.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlinkMedicine = async (link: SupplierDrugRow) => {
    if (!picked || !allowed) return;
    setBusy(true);
    setError(null);
    try {
      await setDrugSupplier({
        drugId: link.drug_id,
        supplierId: picked.id,
        preferred: false,
        active: false,
      });
      setNotice(`${medicineById.get(link.drug_id)?.name ?? 'Medicine'} unlinked from ${picked.name}.`);
      await refresh(picked.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <ThreePane
        context={<div />}
        rail={<RailButton onClick={() => router.push('/queue')}>Back</RailButton>}
      >
        <PageHeader eyebrow="Administration" title="Suppliers" />
        <Notice tone="bad">Only an administrator can manage suppliers.</Notice>
      </ThreePane>
    );
  }

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Suppliers</h2>
          <p className="mt-1 text-lg">
            {suppliers.filter((row) => row.active).length} active
          </p>

          <div className="mt-6 space-y-2">
            {suppliers.map((supplier) => (
              <button
                key={supplier.id}
                type="button"
                onClick={() => {
                  setPickedId(supplier.id);
                  setMode(null);
                }}
                className={`w-full rounded-box border px-3 py-3 text-left ${
                  supplier.id === pickedId ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'
                } ${supplier.active ? '' : 'opacity-50'}`}
              >
                <span className="block truncate">{supplier.name}</span>
                <span className="block text-xs text-ink-2">
                  {supplier.active ? 'Active' : 'Inactive'}
                  {supplier.whatsapp_number ? ` · ${supplier.whatsapp_number}` : ' · no WhatsApp'}
                </span>
              </button>
            ))}
          </div>
        </div>
      }
      rail={
        <>
          <RailButton tone="primary" disabled={busy} onClick={openAdd}>
            Add supplier
          </RailButton>
          {picked ? (
            <>
              <RailButton disabled={busy} onClick={openEdit}>Edit</RailButton>
              <RailButton disabled={busy} onClick={() => void changeActive()}>
                {picked.active ? 'Stop using' : 'Reactivate'}
              </RailButton>
            </>
          ) : null}
          <RailButton disabled={busy} onClick={() => void refresh(pickedId)}>Refresh</RailButton>
          <div className="flex-1" />
          <RailButton onClick={() => router.push('/admin')}>People & tablets</RailButton>
          <RailButton onClick={() => router.push('/queue')}>Back to queue</RailButton>
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="Suppliers" sub={session?.staffName} />

      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? (
        <p role="status" className="mt-4 max-w-3xl rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {mode ? (
        <SupplierEditor
          title={mode === 'add' ? 'New supplier' : `Edit ${picked?.name ?? 'supplier'}`}
          form={form}
          setForm={setForm}
          busy={busy}
          onSave={() => void saveSupplier()}
          onCancel={() => setMode(null)}
        />
      ) : picked ? (
        <div className="mt-6 max-w-4xl">
          <div className="rounded-box border border-rule bg-sheet p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-medium">{picked.name}</h2>
                <p className="mt-1 text-sm text-ink-2">
                  {picked.contact_name || 'No contact name'}
                </p>
              </div>
              <span className={`rounded-box px-3 py-1 text-sm ${picked.active ? 'bg-free-wash text-free' : 'bg-paper-2 text-ink-2'}`}>
                {picked.active ? 'Active' : 'Inactive'}
              </span>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
              <Info label="WhatsApp" value={picked.whatsapp_number} />
              <Info label="Phone" value={picked.phone} />
              <Info label="Email" value={picked.email} />
              <Info label="GSTIN" value={picked.gstin} />
              <Info label="Lead time" value={picked.lead_time_days === null ? null : `${picked.lead_time_days} days`} />
              <Info label="Return window" value={picked.return_window_days === null ? null : `${picked.return_window_days} days`} />
              <Info label="Payment terms" value={picked.payment_terms} />
            </dl>
          </div>

          <div className="mt-6 rounded-box border border-rule bg-sheet p-4">
            <h2 className="text-lg font-medium">Medicines supplied</h2>
            <p className="mt-1 text-sm text-ink-2">
              A medicine can have several suppliers. Preferred is the supplier used by the existing reorder screen.
            </p>

            {pickedLinks.length === 0 ? (
              <p className="mt-4 text-sm text-ink-2">No medicines linked yet.</p>
            ) : (
              <ul className="mt-3">
                {pickedLinks.map((link) => {
                  const drug = medicineById.get(link.drug_id);
                  return (
                    <li key={link.drug_id} className="flex items-center gap-3 border-b border-rule py-3 last:border-b-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{drug?.name ?? 'Unknown medicine'}</span>
                        <span className="text-sm text-ink-2">
                          {[drug?.strength, drug?.form].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {link.is_preferred ? (
                        <span className="rounded-box bg-free-wash px-3 py-2 text-sm text-free">Preferred</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || !picked.active}
                          onClick={() => void makePreferred(link)}
                          className="h-12 rounded-box border border-rule px-3 disabled:opacity-40"
                        >
                          Make preferred
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void unlinkMedicine(link)}
                        className="h-12 rounded-box border border-rule px-3 disabled:opacity-40"
                      >
                        Unlink
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {picked.active ? (
              <div className="mt-5 border-t border-rule pt-4">
                <p className="eyebrow">Link another medicine</p>
                <div className="mt-2 flex items-end gap-3">
                  <label className="min-w-0 flex-1">
                    <span className="block text-sm text-ink-2">Medicine</span>
                    <select
                      value={linkDrugId}
                      onChange={(event) => setLinkDrugId(event.target.value)}
                      aria-label="Medicine to link"
                      className="blank mt-1 h-14 w-full px-3"
                    >
                      <option value="">Choose medicine</option>
                      {availableMedicines.map((drug) => (
                        <option key={drug.id} value={drug.id}>
                          {drug.name} · {drug.strength}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    aria-pressed={linkPreferred}
                    onClick={() => setLinkPreferred((value) => !value)}
                    className={`h-14 rounded-box border px-4 ${linkPreferred ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'}`}
                  >
                    {linkPreferred ? 'Preferred ✓' : 'Make preferred'}
                  </button>

                  <button
                    type="button"
                    disabled={busy || !linkDrugId}
                    onClick={() => void addMedicineLink()}
                    className="h-14 rounded-box border border-ink bg-ink px-5 font-medium text-paper disabled:opacity-40"
                  >
                    Link
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-ink-2">Add the clinic&rsquo;s first supplier.</p>
      )}
    </ThreePane>
  );
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1">{value || '—'}</dd>
    </div>
  );
}

function SupplierEditor({
  title,
  form,
  setForm,
  busy,
  onSave,
  onCancel,
}: {
  title: string;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (key: keyof FormState, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="mt-6 max-w-3xl rounded-box border border-rule bg-sheet p-4">
      <h2 className="text-xl font-medium">{title}</h2>
      <div className="mt-5 grid grid-cols-2 gap-5">
        <Field label="Supplier name">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} aria-label="Supplier name" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="Contact person">
          <input value={form.contactName} onChange={(e) => set('contactName', e.target.value)} aria-label="Contact person" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="WhatsApp number">
          <input inputMode="tel" value={form.whatsappNumber} onChange={(e) => set('whatsappNumber', e.target.value)} aria-label="WhatsApp number" placeholder="+91…" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="Phone">
          <input inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} aria-label="Phone" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="Email">
          <input inputMode="email" value={form.email} onChange={(e) => set('email', e.target.value)} aria-label="Email" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="GSTIN">
          <input value={form.gstin} onChange={(e) => set('gstin', e.target.value)} aria-label="GSTIN" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="Claimed lead time (days)">
          <input inputMode="numeric" value={form.leadTimeDays} onChange={(e) => set('leadTimeDays', e.target.value)} aria-label="Lead time days" className="blank h-14 w-full px-3" />
        </Field>
        <Field label="Return window (days before expiry)">
          <input inputMode="numeric" value={form.returnWindowDays} onChange={(e) => set('returnWindowDays', e.target.value)} aria-label="Return window days" className="blank h-14 w-full px-3" />
        </Field>
        <div className="col-span-2">
          <Field label="Payment terms">
            <input value={form.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} aria-label="Payment terms" placeholder="Cash / 30 days / …" className="blank h-14 w-full px-3" />
          </Field>
        </div>
      </div>

      <div className="mt-6 flex gap-3">
        <button type="button" disabled={busy || !form.name.trim()} onClick={onSave} className="h-14 rounded-box border border-ink bg-ink px-6 font-medium text-paper disabled:opacity-40">
          {busy ? 'Saving…' : 'Save supplier'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="h-14 rounded-box border border-rule px-5 disabled:opacity-40">
          Cancel
        </button>
      </div>
    </div>
  );
}
