-- The edge function calls these RPCs with a table-level fallback; adding them
-- makes ai-run counting work and credit refunds atomic.
create or replace function public.increment_ai_run(p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.credits set ai_runs_used = ai_runs_used + 1 where user_id = p_user_id;
end; $$;

create or replace function public.refund_credit(p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.credits set lookups_used = greatest(lookups_used - 1, 0) where user_id = p_user_id;
end; $$;
