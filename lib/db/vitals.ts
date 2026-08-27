/** Vitals are shared clinical intake: doctors and nurses may record them. */
import { db } from './index';

export interface VitalRecord {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  bp: string | null;
  pulse: number | null;
  temp: number | null;
  spo2: number | null;
  weight: number | null;
  height: number | null;
  recorded_by: string;
  recorded_at: string;
}

export interface NewVitals {
  patientId: string;
  recordedBy: string;
  bp?: string;
  pulse?: number;
  temp?: number;
  spo2?: number;
  weight?: number;
  height?: number;
}

export async function recordVitals(input: NewVitals): Promise<VitalRecord> {
  const { data, error } = await db()
    .from('vitals')
    .insert({
      patient_id: input.patientId,
      recorded_by: input.recordedBy,
      bp: input.bp?.trim() || null,
      pulse: input.pulse ?? null,
      temp: input.temp ?? null,
      spo2: input.spo2 ?? null,
      weight: input.weight ?? null,
      height: input.height ?? null,
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return data as VitalRecord;
}

export async function latestVitals(patientId: string): Promise<VitalRecord | null> {
  const { data, error } = await db()
    .from('vitals')
    .select('*')
    .eq('patient_id', patientId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as VitalRecord) ?? null;
}
