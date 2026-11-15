-- =====================================================================
-- VOLONTARI v2.1 – corsi già fatti con la Scuola di Formazione bloccati
-- Progetto Supabase: hzovguvwnadoptwrdyub  ·  da eseguire DOPO volontari_v2.sql
--
-- Se un corso risulta VALIDO grazie a un attestato della Scuola di Formazione
-- interna, la Sezione non può proporre date per quel corso:
--  - vol_pub_apri passa alla pagina pubblica anche l'origine della data
--    (la pagina mostra "Valido · Scuola di Formazione" senza campi);
--  - vol_crea_proposte ignora le date inviate per quei corsi (link ed Excel),
--    anche se qualcuno le forzasse.
-- Idempotente (solo create or replace di due funzioni). Non tocca i dati.
-- =====================================================================
begin;

create or replace function public.vol_pub_apri(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ric vol_richieste_sezione%rowtype;
begin
  ric := vol_pub_trova(p_token);
  if ric.stato = 'APERTA' and ric.scadenza < now() then raise exception 'RICHIESTA_SCADUTA'; end if;
  return jsonb_build_object(
    'sezione', ric.sezione,
    'note', ric.note_master,
    'scadenza', ric.scadenza,
    'stato', ric.stato,
    'modificabile', ric.stato = 'APERTA',
    'compilatore_nome', ric.compilatore_nome,
    'compilatore_ruolo', ric.compilatore_ruolo,
    'inviata_at', ric.inviata_at,
    'bozza', ric.bozza,
    'bozza_at', ric.bozza_at,
    'requisiti', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'nome', r.nome, 'tipo', r.tipo, 'aggiornamento', r.prevede_aggiornamento)
                       order by r.ordine, r.id)
      from vol_requisiti r where r.id = any(ric.requisiti_inclusi)), '[]'::jsonb),
    'volontari', coalesce((
      select jsonb_agg(jsonb_build_object('id', v.id, 'cognome', v.cognome, 'nome', v.nome, 'gruppo', v.gruppo,
                                          'eta', case when v.data_nascita is not null then date_part('year', age(v.data_nascita))::int end,
                                          'cf4', right(v.cf, 4))
                       order by v.cognome, v.nome)
      from vol_volontari v where v.sezione = ric.sezione and v.stato = 'ATTIVO'), '[]'::jsonb),
    'stato_attuale', coalesce((
      select jsonb_agg(jsonb_build_object('v', s.volontario_id, 'r', s.requisito_id, 'stato', s.stato,
                                          'base', s.data_base, 'agg', s.ultimo_aggiornamento, 'scad', s.data_scadenza,
                                          'origine', s.origine))
      from vol_stato_calcola(null, ric.sezione) s
      join vol_volontari v on v.id = s.volontario_id and v.stato = 'ATTIVO'
      where s.requisito_id = any(ric.requisiti_inclusi)), '[]'::jsonb)
  );
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

-- create or replace mantiene i permessi, ma li ribadisco
revoke execute on function public.vol_pub_apri(text) from public, anon, authenticated;
grant execute on function public.vol_pub_apri(text) to service_role;
revoke execute on function public.vol_crea_proposte(bigint, jsonb, jsonb, text, text) from public, anon, authenticated;

commit;
