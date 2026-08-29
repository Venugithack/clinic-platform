'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RailButton, ThreePane } from '@/components/ThreePane';
import { Field, Notice, PageHeader } from '@/components/ui';
import { currentSession } from '@/lib/auth';
import { adminDrugs, type AdminDrugRow } from '@/lib/db/drugs';
import { addDrug, updateDrug } from '@/lib/transitions/drugs';

type Mode = 'add' | 'edit' | null;

type BaseUnit = 'tablet' | 'ml' | 'piece';
type Schedule = 'OTC' | 'H' | 'H1' | 'X';
type MrpBasis = 'unit' | 'strip' | 'box';

interface DrugForm {
  name: string;
  generic: string;
  saltComposition: string;
  strength: string;
  form: string;
  baseUnit: BaseUnit;
  unitsPerStrip: string;
  stripsPerBox: string;
  mrpBasis: MrpBasis;
  schedule: Schedule;
  hsn: string;
  reorderLevel: string;
  reorderQty: string;
}

const EMPTY_FORM: DrugForm = {
  name: '',
  generic: '',
  saltComposition: '',
  strength: '',
  form: 'tablet',
  baseUnit: 'tablet',
  unitsPerStrip: '1',
  stripsPerBox: '1',
  mrpBasis: 'strip',
  schedule: 'OTC',
  hsn: '',
  reorderLevel: '',
  reorderQty: '',
};

const INPUT =
  'mt-1 min-h-11 w-full rounded-box border border-rule bg-sheet px-3 py-2 text-base outline-none focus:border-ink';

function intOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.parseInt(trimmed, 10);
}

export default function MedicinesPage() {
  const session = currentSession();
  const allowed = session?.role === 'admin';

  const [drugs, setDrugs] = useState<AdminDrugRow[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [form, setForm] = useState<DrugForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (keep?: string | null) => {
    setError(null);
    try {
      const rows = await adminDrugs();
      setDrugs(rows);
      const wanted = keep ?? pickedId;
      if (wanted && rows.some((row) => row.id === wanted)) setPickedId(wanted);
      else if (!wanted && rows.length > 0) setPickedId(rows[0]?.id ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [pickedId]);

  useEffect(() => {
    if (allowed) void refresh(null);
  }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = drugs.find((row) => row.id === pickedId) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return drugs;
    return drugs.filter((row) =>
      [row.name, row.generic, row.salt_composition, row.strength]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [drugs, query]);

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
      generic: picked.generic ?? '',
      saltComposition: picked.salt_composition,
      strength: picked.strength,
      form: picked.form,
      baseUnit: picked.base_unit,
      unitsPerStrip: picked.default_units_per_strip?.toString() ?? '1',
      stripsPerBox: picked.default_strips_per_box?.toString() ?? '1',
      mrpBasis: picked.default_mrp_basis,
      schedule: picked.schedule,
      hsn: picked.hsn ?? '',
      reorderLevel: picked.reorder_level_base?.toString() ?? '',
      reorderQty: picked.reorder_qty_base?.toString() ?? '',
    });
    setError(null);
    setNotice(null);
  };

  const save = async () => {
    if (!allowed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let saved: AdminDrugRow;
      if (mode === 'add') {
        saved = await addDrug({
          name: form.name,
          generic: form.generic,
          saltComposition: form.saltComposition,
          strength: form.strength,
          form: form.form,
          baseUnit: form.baseUnit,
          unitsPerStrip: intOrUndefined(form.unitsPerStrip) ?? 1,
          stripsPerBox: intOrUndefined(form.stripsPerBox) ?? 1,
          mrpBasis: form.mrpBasis,
          schedule: form.schedule,
          hsn: form.hsn,
          reorderLevelBase: intOrUndefined(form.reorderLevel),
          reorderQtyBase: intOrUndefined(form.reorderQty),
        });
      } else if (mode === 'edit' && picked) {
        saved = await updateDrug(picked.id, {
          name: form.name,
          generic: form.generic,
          unitsPerStrip: intOrUndefined(form.unitsPerStrip),
          stripsPerBox: intOrUndefined(form.stripsPerBox),
          mrpBasis: form.mrpBasis,
          schedule: form.schedule,
          hsn: form.hsn,
          reorderLevelBase: intOrUndefined(form.reorderLevel),
          reorderQtyBase: intOrUndefined(form.reorderQty),
        });
      } else {
        return;
      }

      setMode(null);
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
      const saved = await updateDrug(picked.id, { active: !picked.active });
      setNotice(
        saved.active
          ? `${saved.name} is active again.`
          : `${saved.name} is inactive. Existing prescriptions, stock history and bills are unchanged.`,
      );
      await refresh(saved.id);
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
      >
        <PageHeader eyebrow="Administration" title="Medicines" />
        <Notice tone="bad">Only an administrator can manage the medicine master.</Notice>
      </ThreePane>
    );
  }

  return (
    <ThreePane
      context={
        <div>
          <h2 className="eyebrow">Medicine master</h2>
          <p className="mt-1 text-lg">{drugs.filter((row) => row.active).length} active</p>

          <label className="mt-5 block text-sm text-ink-2">
            Find medicine
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="name, generic or salt"
              className={INPUT}
            />
          </label>

          <div className="mt-4 max-h-[58vh] space-y-2 overflow-y-auto pr-1">
            {filtered.map((drug) => (
              <button
                key={drug.id}
                type="button"
                onClick={() => {
                  setPickedId(drug.id);
                  setMode(null);
                }}
                className={`w-full rounded-box border px-3 py-3 text-left ${
                  drug.id === pickedId ? 'border-ink bg-paper-2' : 'border-rule bg-sheet'
                } ${drug.active ? '' : 'opacity-50'}`}
              >
                <span className="block truncate">{drug.name} · {drug.strength}</span>
                <span className="block truncate text-xs text-ink-2">
                  {drug.generic || drug.salt_composition} · {drug.active ? 'Active' : 'Inactive'}
                </span>
              </button>
            ))}
          </div>
        </div>
      }
      rail={
        <>
          <RailButton tone="primary" disabled={busy} onClick={openAdd}>
            Add medicine
          </RailButton>
          {picked ? (
            <>
              <RailButton disabled={busy} onClick={openEdit}>Edit settings</RailButton>
              <RailButton disabled={busy} onClick={() => void changeActive()}>
                {picked.active ? 'Deactivate' : 'Reactivate'}
              </RailButton>
            </>
          ) : null}
          <RailButton disabled={busy} onClick={() => void refresh(pickedId)}>Refresh</RailButton>
          <div className="flex-1" />
        </>
      }
    >
      <PageHeader eyebrow="Administration" title="Medicines" sub={session?.staffName} />

      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? (
        <p role="status" className="mt-4 max-w-4xl rounded-box bg-free-wash p-3 text-free">
          {notice}
        </p>
      ) : null}

      {mode ? (
        <MedicineEditor
          mode={mode}
          form={form}
          setForm={setForm}
          busy={busy}
          onSave={() => void save()}
          onCancel={() => setMode(null)}
        />
      ) : picked ? (
        <MedicineDetail drug={picked} />
      ) : (
        <p className="mt-6 text-ink-2">Add a medicine or choose one from the list.</p>
      )}
    </ThreePane>
  );
}

function MedicineDetail({ drug }: { drug: AdminDrugRow }) {
  return (
    <div className="mt-6 max-w-4xl space-y-5">
      <div className="rounded-box border border-rule bg-sheet p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-medium">{drug.name} · {drug.strength}</h2>
            <p className="mt-1 text-sm text-ink-2">{drug.salt_composition} · {drug.form}</p>
          </div>
          <span className={`rounded-box px-3 py-1 text-sm ${drug.active ? 'bg-free-wash text-free' : 'bg-paper-2 text-ink-2'}`}>
            {drug.active ? 'Active' : 'Inactive'}
          </span>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Info label="Generic" value={drug.generic} />
          <Info label="Base unit" value={drug.base_unit} />
          <Info label="Schedule" value={drug.schedule} />
          <Info label="HSN" value={drug.hsn} />
          <Info label="Default strip" value={drug.default_units_per_strip ? `${drug.default_units_per_strip} ${drug.base_unit}s` : null} />
          <Info label="Default box" value={drug.default_strips_per_box ? `${drug.default_strips_per_box} strips` : null} />
        </dl>
      </div>

      <div className="rounded-box border border-rule bg-sheet p-5">
        <h2 className="text-lg font-medium">Reorder settings</h2>
        <p className="mt-1 text-sm text-ink-2">
          These are base-unit thresholds. The reorder screen may calculate a smarter suggested quantity from usage and lead time, but it still respects this clinic configuration.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <Info
            label="Alert at or below"
            value={drug.reorder_level_base === null ? 'Not set' : `${drug.reorder_level_base} ${drug.base_unit}s`}
          />
          <Info
            label="Configured reorder quantity"
            value={drug.reorder_qty_base === null ? 'Not set' : `${drug.reorder_qty_base} ${drug.base_unit}s`}
          />
        </dl>
      </div>

      <Notice tone="neutral">
        Strength, salt, form and base unit define the medicine identity and historical stock. To correct those, add the correct medicine and deactivate this row rather than rewriting history.
      </Notice>
    </div>
  );
}

function MedicineEditor({
  mode,
  form,
  setForm,
  busy,
  onSave,
  onCancel,
}: {
  mode: Exclude<Mode, null>;
  form: DrugForm;
  setForm: (next: DrugForm) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof DrugForm>(key: K, value: DrugForm[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <div className="mt-6 max-w-4xl rounded-box border border-rule bg-sheet p-5">
      <h2 className="text-xl font-medium">{mode === 'add' ? 'New medicine' : 'Edit medicine settings'}</h2>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <Field label="Medicine name">
          <input aria-label="Medicine name" value={form.name} onChange={(e) => set('name', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Generic name">
          <input aria-label="Generic name" value={form.generic} onChange={(e) => set('generic', e.target.value)} className={INPUT} />
        </Field>

        {mode === 'add' ? (
          <>
            <Field label="Salt composition">
              <input aria-label="Salt composition" value={form.saltComposition} onChange={(e) => set('saltComposition', e.target.value)} className={INPUT} />
            </Field>
            <Field label="Strength">
              <input aria-label="Strength" value={form.strength} onChange={(e) => set('strength', e.target.value)} placeholder="650mg" className={INPUT} />
            </Field>
            <Field label="Dosage form">
              <input aria-label="Dosage form" value={form.form} onChange={(e) => set('form', e.target.value)} placeholder="tablet" className={INPUT} />
            </Field>
            <Field label="Base unit">
              <select aria-label="Base unit" value={form.baseUnit} onChange={(e) => set('baseUnit', e.target.value as BaseUnit)} className={INPUT}>
                <option value="tablet">Tablet</option>
                <option value="ml">ml</option>
                <option value="piece">Piece</option>
              </select>
            </Field>
          </>
        ) : (
          <div className="col-span-2 rounded-box bg-paper-2 p-3 text-sm text-ink-2">
            Medicine identity is kept unchanged here: {form.saltComposition} · {form.strength} · {form.form} · {form.baseUnit}.
          </div>
        )}

        <Field label="Default units per strip">
          <input aria-label="Default units per strip" inputMode="numeric" value={form.unitsPerStrip} onChange={(e) => set('unitsPerStrip', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Default strips per box">
          <input aria-label="Default strips per box" inputMode="numeric" value={form.stripsPerBox} onChange={(e) => set('stripsPerBox', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Printed MRP basis">
          <select aria-label="Printed MRP basis" value={form.mrpBasis} onChange={(e) => set('mrpBasis', e.target.value as MrpBasis)} className={INPUT}>
            <option value="unit">Unit</option>
            <option value="strip">Strip</option>
            <option value="box">Box</option>
          </select>
        </Field>
        <Field label="Schedule">
          <select aria-label="Schedule" value={form.schedule} onChange={(e) => set('schedule', e.target.value as Schedule)} className={INPUT}>
            <option value="OTC">OTC</option>
            <option value="H">H</option>
            <option value="H1">H1</option>
            <option value="X">X</option>
          </select>
        </Field>
        <Field label="HSN">
          <input aria-label="HSN" value={form.hsn} onChange={(e) => set('hsn', e.target.value)} className={INPUT} />
        </Field>
        <div />
        <Field label="Low-stock threshold (base units)">
          <input aria-label="Low-stock threshold" inputMode="numeric" value={form.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Reorder quantity (base units)">
          <input aria-label="Reorder quantity" inputMode="numeric" value={form.reorderQty} onChange={(e) => set('reorderQty', e.target.value)} className={INPUT} />
        </Field>
      </div>

      <div className="mt-6 flex gap-3">
        <button type="button" disabled={busy} onClick={onSave} className="min-h-12 rounded-box bg-ink px-5 text-paper disabled:opacity-50">
          Save medicine
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="min-h-12 rounded-box border border-rule px-5 disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
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
