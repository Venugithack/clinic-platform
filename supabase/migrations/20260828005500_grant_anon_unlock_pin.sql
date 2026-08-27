-- Staff PIN login happens before a Supabase user session exists, so the public
-- browser role must be allowed to call the SECURITY DEFINER unlock function.
-- The function itself performs PIN verification, lockout and session issuance.
grant execute on function app.unlock_pin(uuid, text) to anon;
