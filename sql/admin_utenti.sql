-- =====================================================================
-- GESTIONE UTENTI – chiusura delle sessioni di un utente
-- Progetto Supabase: hzovguvwnadoptwrdyub
--
-- La libreria di Supabase non permette di chiudere le sessioni di un ALTRO
-- utente partendo dal suo id. Questa funzione lo fa (le righe di
-- auth.refresh_tokens collegate si eliminano a cascata), così dopo un reset
-- password o una disattivazione l'utente non può più rinnovare l'accesso.
-- Eseguibile SOLO dal service role (Edge Function admin-utenti).
-- Non tocca app_users. Idempotente.
-- =====================================================================
begin;

create or replace function public.admin_termina_sessioni(p_user uuid)
returns int language plpgsql security definer set search_path = public, auth as $$
declare n int;
begin
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.admin_termina_sessioni(uuid) from public, anon, authenticated;
grant execute on function public.admin_termina_sessioni(uuid) to service_role;

commit;
