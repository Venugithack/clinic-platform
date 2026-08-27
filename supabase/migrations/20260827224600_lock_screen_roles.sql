-- The public sign-in screen needs only a person's id, display name and role.
-- No credential or contact data is exposed.
create or replace view lock_screen_staff as
select id, name, role
from staff
where active
order by name;

grant select on lock_screen_staff to authenticated;
