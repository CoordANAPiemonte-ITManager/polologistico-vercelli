-- =====================================================================
-- VOLONTARI v2.2 – riapertura delle richieste alle Sezioni
-- Progetto Supabase: hzovguvwnadoptwrdyub  ·  da eseguire DOPO volontari_v2_1.sql
--
--  - vol_richiesta_azione: nuova azione RIAPRI (richiesta INVIATA o CHIUSA →
--    APERTA, scadenza ad almeno N giorni da oggi). La bozza resta: la Sezione
--    ritrova quanto aveva compilato e può correggere e inviare di nuovo.
--  - vol_crea_proposte: a ogni invio, le proposte della stessa richiesta ancora
--    IN_ATTESA vengono chiuse come RIFIUTATA con motivo "Sostituita da un nuovo
--    invio della Sezione" (nessun doppione; le approvate/rifiutate restano).
-- Idempotente (solo create or replace di due funzioni). Non cancella dati.
-- =====================================================================
begin;

-- REVOCA / PROROGA (giorni) / CHIUDI / RIAPRI (giorni)
create or replace function public.vol_richiesta_azione(p_id bigint, p_azione text, p_giorni int default null)
returns void language plpgsql security definer set search_path = public as $$
declare ric vol_richieste_sezione%rowtype;
begin
  if not vol_gestore() then raise exception 'Permesso negato'; end if;
  select * into ric from vol_richieste_sezione where id = p_id for update;
  if not found then raise exception 'Richiesta non trovata'; end if;
  if p_azione = 'REVOCA' then
    if ric.stato <> 'APERTA' then raise exception 'Si può revocare solo una richiesta aperta'; end if;
    update vol_richieste_sezione set stato = 'REVOCATA', chiusa_at = now() where id = p_id;
  elsif p_azione = 'PROROGA' then
    if ric.stato <> 'APERTA' then raise exception 'Si può prorogare solo una richiesta aperta'; end if;
    if p_giorni is null or p_giorni < 1 or p_giorni > 180 then raise exception 'Giorni non validi (da 1 a 180)'; end if;
    update vol_richieste_sezione set scadenza = greatest(scadenza, now()) + make_interval(days => p_giorni) where id = p_id;
  elsif p_azione = 'CHIUDI' then
    if ric.stato <> 'INVIATA' then raise exception 'Si può chiudere solo una richiesta inviata'; end if;
    if exists (select 1 from vol_proposte where richiesta_id = p_id and stato = 'IN_ATTESA') then
      raise exception 'Ci sono ancora proposte da validare';
    end if;
    update vol_richieste_sezione set stato = 'CHIUSA', chiusa_at = now() where id = p_id;
  elsif p_azione = 'RIAPRI' then
    if ric.stato not in ('INVIATA', 'CHIUSA') then raise exception 'Si può riaprire solo una richiesta inviata o chiusa'; end if;
    if p_giorni is null or p_giorni < 1 or p_giorni > 180 then raise exception 'Giorni non validi (da 1 a 180)'; end if;
    update vol_richieste_sezione
       set stato = 'APERTA', chiusa_at = null,
           scadenza = greatest(scadenza, now() + make_interval(days => p_giorni))
     where id = p_id;
  else
    raise exception 'Azione non valida';
  end if;
end;
$$;

create or replace function public.vol_crea_proposte(p_richiesta bigint, p_righe jsonb, p_segn jsonb, p_nome text, p_ruolo text)
returns int language plpgsql security definer set search_path = public as $$
declare
  ric vol_richieste_sezione%rowtype;
  riga jsonb; rq jsonb; sg jsonb;
  v_vid uuid; v_rid bigint; v_db date; v_da date; v_cb date; v_ca date; v_prev boolean;
  v_stato text; v_origine text;
  v_note text; v_testo text;
  n int := 0; n_vol int;
begin
  select * into ric from vol_richieste_sezione where id = p_richiesta for update;
  if not found then raise exception 'RICHIESTA_NON_TROVATA'; end if;
  if ric.stato <> 'APERTA' then raise exception 'RICHIESTA_NON_APERTA'; end if;
  if ric.scadenza < now() then raise exception 'RICHIESTA_SCADUTA'; end if;
  if nullif(btrim(coalesce(p_nome, '')), '') is null then raise exception 'NOME_MANCANTE'; end if;
  if jsonb_typeof(coalesce(p_righe, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_righe, '[]'::jsonb)) > 1500
     or jsonb_typeof(coalesce(p_segn, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_segn, '[]'::jsonb)) > 200 then
    raise exception 'DATI_NON_VALIDI';
  end if;

  -- richiesta riaperta: le proposte del precedente invio non ancora validate vengono sostituite
  update vol_proposte
     set stato = 'RIFIUTATA', motivo_rifiuto = 'Sostituita da un nuovo invio della Sezione', validata_at = now()
   where richiesta_id = ric.id and stato = 'IN_ATTESA';

  for riga in select * from jsonb_array_elements(coalesce(p_righe, '[]'::jsonb)) loop
    begin
      v_vid := (riga->>'volontario_id')::uuid;
    exception when others then
      raise exception 'VOLONTARIO_NON_VALIDO';
    end;
    if not exists (select 1 from vol_volontari where id = v_vid and sezione = ric.sezione and stato = 'ATTIVO') then
      raise exception 'VOLONTARIO_NON_VALIDO';
    end if;
    v_note := nullif(left(btrim(coalesce(riga->>'note', '')), 500), '');
    n_vol := 0;

    for rq in select * from jsonb_array_elements(coalesce(riga->'requisiti', '[]'::jsonb)) loop
      begin
        v_rid := (rq->>'requisito_id')::bigint;
      exception when others then
        raise exception 'REQUISITO_NON_VALIDO';
      end;
      if v_rid is null or not (v_rid = any(ric.requisiti_inclusi)) then raise exception 'REQUISITO_NON_VALIDO'; end if;
      v_db := vol_data_sicura(rq->>'data_base');
      v_da := vol_data_sicura(rq->>'data_agg');
      select prevede_aggiornamento into v_prev from vol_requisiti where id = v_rid;
      v_cb := null; v_ca := null; v_stato := null; v_origine := null;
      select s.data_base, s.ultimo_aggiornamento, s.stato, s.origine into v_cb, v_ca, v_stato, v_origine
        from vol_stato_calcola(v_vid, null) s where s.requisito_id = v_rid;

      -- corso valido grazie alla Scuola di Formazione: nessuna proposta
      if v_stato = 'VALIDO' and v_origine = 'SCUOLA' then
        continue;
      end if;

      if v_db is not null and v_db is distinct from v_cb then
        insert into vol_proposte (richiesta_id, volontario_id, requisito_id, tipo_evento, data, valore_attuale, note)
        values (ric.id, v_vid, v_rid, 'BASE', v_db, v_cb, v_note);
        n := n + 1; n_vol := n_vol + 1;
      end if;
      if v_da is not null and v_prev and v_da is distinct from v_ca then
        insert into vol_proposte (richiesta_id, volontario_id, requisito_id, tipo_evento, data, valore_attuale, note)
        values (ric.id, v_vid, v_rid, 'AGGIORNAMENTO', v_da, v_ca, v_note);
        n := n + 1; n_vol := n_vol + 1;
      end if;
    end loop;

    -- nota senza date nuove: diventa una segnalazione su quel volontario
    if v_note is not null and n_vol = 0 then
      insert into vol_proposte (richiesta_id, volontario_id, tipo_proposta, note)
      values (ric.id, v_vid, 'SEGNALAZIONE', v_note);
      n := n + 1;
    end if;
  end loop;

  for sg in select * from jsonb_array_elements(coalesce(p_segn, '[]'::jsonb)) loop
    v_testo := nullif(left(btrim(coalesce(sg->>'testo', '')), 500), '');
    if v_testo is not null then
      insert into vol_proposte (richiesta_id, tipo_proposta, note) values (ric.id, 'SEGNALAZIONE', v_testo);
      n := n + 1;
    end if;
  end loop;

  update vol_richieste_sezione set
    stato = case when n = 0 then 'CHIUSA' else 'INVIATA' end,
    chiusa_at = case when n = 0 then now() end,
    inviata_at = now(),
    compilatore_nome = left(btrim(p_nome), 100),
    compilatore_ruolo = left(nullif(btrim(coalesce(p_ruolo, '')), ''), 100)
  where id = ric.id;
  return n;
end;
$$;

revoke execute on function public.vol_richiesta_azione(bigint, text, int) from public, anon;
grant execute on function public.vol_richiesta_azione(bigint, text, int) to authenticated;
revoke execute on function public.vol_crea_proposte(bigint, jsonb, jsonb, text, text) from public, anon, authenticated;

commit;
