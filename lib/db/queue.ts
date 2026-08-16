/**
 * Today's queue — the default screen on both tablets (TABLET.md §7).
 */
import { db } from './index';

export type AppointmentStatus = 'booked' | 'waiting' | 'in_consult' | 'done' | 'no_show';

export interface QueueEntry {
  appointment_id: string;
  token_no: number;
  status: AppointmentStatus;
  source: 'walkin' | 'whatsapp' | 'phone';
  reason: string | null;
  patient_id: string;
  patient_name: string;
  age: number | null;
  sex: string | null;
  phone: string | null;
  allergies: string | null;
  encounter_id: string | null;
  ahead: number;
}

export async function todaysQueue(): Promise<QueueEntry[]> {
  const { data, error } = await db()
    .from('queue_today')
    .select('*')
    .order('token_no');

  if (error) throw new Error(error.message);
  return (data ?? []) as QueueEntry[];
}

export async function queueEntry(appointmentId: string): Promise<QueueEntry | null> {
  const { data, error } = await db()
    .from('queue_today')
    .select('*')
    .eq('appointment_id', appointmentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as QueueEntry) ?? null;
}
