/**
 * The shapes the clinic is made of.
 *
 * They live with the functions that produce them, not here, because a type
 * describing what `/snapshot` returns and a second copy describing what the
 * page expects is two things that agree until the day they quietly do not —
 * and the way you find out is a blank column on a tablet.
 *
 * This file is the client's door to them and nothing else. Add a field in
 * supabase/functions/_shared/types.ts and both ends see it at once.
 */
export * from '../supabase/functions/_shared/types.ts'
