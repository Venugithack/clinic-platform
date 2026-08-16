-- Recent and frequent drugs, for the search overlay's resting state.
--
-- TABLET.md §4: "Recent and frequent drugs before any typing at all. In a
-- single-doctor general practice the top 40 drugs are most of the
-- prescriptions, and this turns most searches into one tap."
--
-- That is the whole justification. It is not personalisation and it is not a
-- suggestion — rule 8 forbids inferring anything clinical, and this infers
-- nothing: it counts what this doctor has actually written, and puts the list
-- in front of him in that order. Choosing is still entirely his.

create view drugs_frequently_prescribed as
select
  d.id,
  d.name,
  d.salt_composition,
  d.strength,
  d.form,
  d.schedule,
  count(*)::int             as times_prescribed,
  max(p.signed_at)          as last_prescribed_at
from prescriptions p
cross join lateral jsonb_array_elements(p.items) as line(item)
join drugs d on d.id = (line.item ->> 'drug_id')::uuid
where p.signed_at is not null
  and p.signed_at > now() - interval '90 days'
  and d.active
group by d.id;

comment on view drugs_frequently_prescribed is
  'Counts what was actually prescribed. Infers nothing (PLAN.md §5.3 rule 8).';

grant select on drugs_frequently_prescribed to authenticated;
