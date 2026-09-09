-- The browser never queries jmc through PostgREST. Edge Functions use the
-- private database connection and enforce the clinic's role model themselves.
-- Keep that boundary true even if API schema settings or default grants change.
revoke all privileges on schema jmc from public, anon, authenticated, service_role;
revoke all privileges on all tables in schema jmc from public, anon, authenticated, service_role;
revoke all privileges on all sequences in schema jmc from public, anon, authenticated, service_role;
revoke all privileges on all functions in schema jmc from public, anon, authenticated, service_role;

alter default privileges in schema jmc revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema jmc revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema jmc revoke all on functions from public, anon, authenticated, service_role;

alter table jmc.appointments enable row level security;
alter table jmc.audit_events enable row level security;
alter table jmc.batches enable row level security;
alter table jmc.beds enable row level security;
alter table jmc.bills enable row level security;
alter table jmc.cash_movements enable row level security;
alter table jmc.clinic_revision enable row level security;
alter table jmc.clinic_settings enable row level security;
alter table jmc.csv_imports enable row level security;
alter table jmc.encounters enable row level security;
alter table jmc.medicines enable row level security;
alter table jmc.otc_sales enable row level security;
alter table jmc.patients enable row level security;
alter table jmc.pin_attempts enable row level security;
alter table jmc.prescriptions enable row level security;
alter table jmc.purchase_order_lines enable row level security;
alter table jmc.purchase_orders enable row level security;
alter table jmc.sessions enable row level security;
alter table jmc.staff enable row level security;
alter table jmc.stock_movements enable row level security;
alter table jmc.stock_take_lines enable row level security;
alter table jmc.stock_takes enable row level security;
alter table jmc.stock_writeoffs enable row level security;
alter table jmc.supplier_medicines enable row level security;
alter table jmc.supplier_returns enable row level security;
alter table jmc.suppliers enable row level security;
alter table jmc.till_sessions enable row level security;
alter table jmc.vitals enable row level security;
alter table jmc.whatsapp_messages enable row level security;

-- PostgreSQL does not create indexes for the referencing side of foreign keys.
-- These cover the live jmc relationships reported by Supabase's advisor.
create index if not exists appointments_patient_id_idx on jmc.appointments (patient_id);
create index if not exists audit_events_actor_id_idx on jmc.audit_events (actor_id);
create index if not exists batches_received_from_supplier_id_idx on jmc.batches (received_from_supplier_id);
create index if not exists beds_patient_id_idx on jmc.beds (patient_id);
create index if not exists bills_patient_id_idx on jmc.bills (patient_id);
create index if not exists cash_movements_actor_id_idx on jmc.cash_movements (actor_id);
create index if not exists clinic_settings_updated_by_idx on jmc.clinic_settings (updated_by);
create index if not exists csv_imports_actor_id_idx on jmc.csv_imports (actor_id);
create index if not exists encounters_appointment_id_idx on jmc.encounters (appointment_id);
create index if not exists encounters_doctor_id_idx on jmc.encounters (doctor_id);
create index if not exists encounters_patient_id_idx on jmc.encounters (patient_id);
create index if not exists medicines_preferred_supplier_id_idx on jmc.medicines (preferred_supplier_id);
create index if not exists otc_sales_created_by_idx on jmc.otc_sales (created_by);
create index if not exists pin_attempts_staff_id_idx on jmc.pin_attempts (staff_id);
create index if not exists prescriptions_doctor_id_idx on jmc.prescriptions (doctor_id);
create index if not exists prescriptions_encounter_id_idx on jmc.prescriptions (encounter_id);
create index if not exists prescriptions_patient_id_idx on jmc.prescriptions (patient_id);
create index if not exists purchase_order_lines_medicine_id_idx on jmc.purchase_order_lines (medicine_id);
create index if not exists purchase_orders_created_by_idx on jmc.purchase_orders (created_by);
create index if not exists purchase_orders_supplier_id_idx on jmc.purchase_orders (supplier_id);
create index if not exists sessions_staff_id_idx on jmc.sessions (staff_id);
create index if not exists stock_movements_actor_id_idx on jmc.stock_movements (actor_id);
create index if not exists stock_movements_batch_id_idx on jmc.stock_movements (batch_id);
create index if not exists stock_movements_medicine_id_idx on jmc.stock_movements (medicine_id);
create index if not exists stock_take_lines_batch_id_idx on jmc.stock_take_lines (batch_id);
create index if not exists stock_take_lines_counted_by_idx on jmc.stock_take_lines (counted_by);
create index if not exists stock_take_lines_medicine_id_idx on jmc.stock_take_lines (medicine_id);
create index if not exists stock_takes_posted_by_idx on jmc.stock_takes (posted_by);
create index if not exists stock_takes_started_by_idx on jmc.stock_takes (started_by);
create index if not exists stock_takes_submitted_by_idx on jmc.stock_takes (submitted_by);
create index if not exists stock_writeoffs_actor_id_idx on jmc.stock_writeoffs (actor_id);
create index if not exists stock_writeoffs_batch_id_idx on jmc.stock_writeoffs (batch_id);
create index if not exists stock_writeoffs_medicine_id_idx on jmc.stock_writeoffs (medicine_id);
create index if not exists supplier_medicines_medicine_id_idx on jmc.supplier_medicines (medicine_id);
create index if not exists supplier_returns_actor_id_idx on jmc.supplier_returns (actor_id);
create index if not exists supplier_returns_batch_id_idx on jmc.supplier_returns (batch_id);
create index if not exists supplier_returns_medicine_id_idx on jmc.supplier_returns (medicine_id);
create index if not exists till_sessions_closed_by_idx on jmc.till_sessions (closed_by);
create index if not exists till_sessions_opened_by_idx on jmc.till_sessions (opened_by);
create index if not exists vitals_patient_id_idx on jmc.vitals (patient_id);
create index if not exists vitals_recorded_by_idx on jmc.vitals (recorded_by);

-- The previous application's public views remain for recovery purposes. Make
-- them obey the caller's grants and RLS instead of the view owner's privileges.
do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'available_stock', 'batch_trace', 'clinic_health', 'clinic_now',
    'clinic_screens', 'clinic_setup_state', 'consumption_velocity', 'day_book',
    'dispense_margin', 'drug_availability', 'drugs_frequently_prescribed',
    'email_access_state', 'expired_stock', 'expiring_soon',
    'expiry_writeoff_register', 'h1_register', 'lock_screen_staff',
    'open_counter_queries', 'open_supplier_credits', 'pharmacy_queue',
    'presence_detail', 'purchase_order_lines', 'purchase_orders_open',
    'purchase_register', 'queue_today', 'reorder_suggestions', 'sales_register',
    'stock_cache_drift', 'stock_take_variance', 'stock_valuation',
    'stockout_history', 'supplier_lead_time', 'supplier_price_history',
    'till_reconciliation'
  ]
  loop
    execute format('alter view public.%I set (security_invoker = true)', view_name);
  end loop;
end
$$;

-- These retired anonymous RPCs are no longer part of the live application.
-- In particular, the two unlock_pin overloads must not remain a public PIN
-- verification surface.
revoke execute on function app.clinic_is_open(timestamp with time zone) from anon;
revoke execute on function app.current_staff_id() from anon;
revoke execute on function app.current_staff_role() from anon;
revoke execute on function app.unlock_pin(uuid, text) from anon;
revoke execute on function app.unlock_pin(uuid, text, text) from anon;
