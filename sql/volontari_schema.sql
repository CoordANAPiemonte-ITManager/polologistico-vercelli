-- =====================================================================
-- Pagina VOLONTARI – anagrafica 1° RGPT (Piemonte, Liguria, Valle d'Aosta)
-- Progetto Supabase: hzovguvwnadoptwrdyub
--
-- Idempotente: si può rieseguire. Non cancella dati.
-- Fonte dell'anagrafica: PIA ANA, solo tramite import (RPC vol_importa).
-- Corsi e abilitazioni: spunte manuali (vol_requisiti_volontario) oppure
-- automatiche dagli attestati della Scuola di Formazione (vista vol_stato_requisiti).
--
-- Permesso: chiave "volontari" in app_users.permessi (base | completo).
-- Limite per Sezione (per il futuro): app_users.permessi.volontari_sezioni
--   assente/null  = tutte le Sezioni
--   ["VERCELLI"]  = solo le Sezioni elencate (lista vuota = nessuna)
-- Oggi nessun utente ha la chiave: vedono la pagina solo gli it_admin.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Sezioni (nomi esattamente come li scrive il PIA)
-- ---------------------------------------------------------------------
create table if not exists public.vol_sezioni (
  sezione text primary key,
  regione text not null check (regione in ('PIEMONTE','LIGURIA','VALLE D''AOSTA')),
  ordine  int  not null default 0
);

insert into public.vol_sezioni (sezione, regione, ordine) values
  ('ACQUI TERME','PIEMONTE',1), ('ALESSANDRIA','PIEMONTE',2), ('ASTI','PIEMONTE',3),
  ('BIELLA','PIEMONTE',4), ('CASALE MONFERRATO','PIEMONTE',5), ('CEVA','PIEMONTE',6),
  ('CUNEO','PIEMONTE',7), ('DOMODOSSOLA','PIEMONTE',8), ('INTRA','PIEMONTE',9),
  ('IVREA','PIEMONTE',10), ('MONDOVI''','PIEMONTE',11), ('NOVARA','PIEMONTE',12),
  ('OMEGNA','PIEMONTE',13), ('PINEROLO','PIEMONTE',14), ('SALUZZO','PIEMONTE',15),
  ('TORINO','PIEMONTE',16), ('VALSESIANA','PIEMONTE',17), ('VALSUSA','PIEMONTE',18),
  ('VERCELLI','PIEMONTE',19),
  ('GENOVA','LIGURIA',20), ('IMPERIA','LIGURIA',21), ('LA SPEZIA','LIGURIA',22), ('SAVONA','LIGURIA',23),
  ('AOSTA','VALLE D''AOSTA',24)
on conflict (sezione) do update set regione = excluded.regione, ordine = excluded.ordine;

-- ---------------------------------------------------------------------
-- 2. Funzioni di permesso
-- ---------------------------------------------------------------------
-- Può vedere (p_scrittura=false: base o completo) o modificare (true: completo)
-- i volontari di quella Sezione.
create or replace function public.vol_permesso_sezione(p_sezione text, p_scrittura boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid() and coalesce(u.attivo, true)
      and (
        u.ruolo = 'it_admin'
        or (
          (u.permessi->>'volontari') in (case when p_scrittura then 'completo' else 'base' end, 'completo', 'true')
          and (
            u.permessi->'volontari_sezioni' is null
            or jsonb_typeof(u.permessi->'volontari_sezioni') = 'null'
            or (jsonb_typeof(u.permessi->'volontari_sezioni') = 'array'
                and u.permessi->'volontari_sezioni' ? p_sezione)
          )
        )
      )
  );
$$;

-- Gestisce le impostazioni comuni (elenco corsi/abilitazioni): completo senza limite di Sezione.
create or replace function public.vol_gestore()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid() and coalesce(u.attivo, true)
      and (
        u.ruolo = 'it_admin'
        or ((u.permessi->>'volontari') in ('completo','true')
            and (u.permessi->'volontari_sezioni' is null
                 or jsonb_typeof(u.permessi->'volontari_sezioni') = 'null'))
      )
  );
$$;

-- ---------------------------------------------------------------------
-- 3. Data di nascita e sesso dal CF (gestisce anche l'omocodia)
-- ---------------------------------------------------------------------
create or replace function public.vol_cf_cifre(p text)
returns text language sql immutable as $$
  select translate(p, 'LMNPQRSTUV', '0123456789');
$$;

create or replace function public.vol_data_nascita_da_cf(p_cf text)
returns date language plpgsql stable set search_path = public as $$
declare
  aa int; mm int; gg int; anno int;
begin
  if p_cf is null or length(p_cf) <> 16 then return null; end if;
  aa := vol_cf_cifre(substr(p_cf, 7, 2))::int;
  mm := position(substr(p_cf, 9, 1) in 'ABCDEHLMPRST');
  gg := vol_cf_cifre(substr(p_cf, 10, 2))::int;
  if mm = 0 then return null; end if;
  if gg > 40 then gg := gg - 40; end if;
  anno := case when aa > (extract(year from current_date)::int % 100) then 1900 + aa else 2000 + aa end;
  return make_date(anno, mm, gg);
exception when others then
  return null;
end;
$$;

create or replace function public.vol_sesso_da_cf(p_cf text)
returns text language plpgsql immutable set search_path = public as $$
begin
  if p_cf is null or length(p_cf) <> 16 then return null; end if;
  return case when vol_cf_cifre(substr(p_cf, 10, 2))::int > 40 then 'F' else 'M' end;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Volontari
-- ---------------------------------------------------------------------
create table if not exists public.vol_volontari (
  id              uuid primary key default gen_random_uuid(),
  cf              text not null unique,
  cognome         text not null,
  nome            text not null default '',
  data_nascita    date,
  sesso           text check (sesso in ('M','F')),
  sezione         text not null references public.vol_sezioni(sezione) on update cascade,
  gruppo          text,
  squadra         text,
  matricola_gisa  text,
  matricola_vola  text,
  stato           text not null default 'ATTIVO' check (stato in ('ATTIVO','NON_IN_PIA','DIMESSO')),
  da_verificare   boolean not null default false,
  ultimo_import   timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vol_volontari_cf_check') then
    alter table public.vol_volontari
      add constraint vol_volontari_cf_check check (cf = upper(cf) and public.cf_valido(cf));
  end if;
end $$;

create index if not exists vol_volontari_sezione_idx on public.vol_volontari (sezione);
create index if not exists vol_volontari_stato_idx   on public.vol_volontari (stato);

create or replace function public.vol_volontari_prima_di_salvare()
returns trigger language plpgsql set search_path = public as $$
begin
  new.cf := upper(btrim(new.cf));
  new.data_nascita := vol_data_nascita_da_cf(new.cf);
  new.sesso := vol_sesso_da_cf(new.cf);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_vol_volontari_prima on public.vol_volontari;
create trigger trg_vol_volontari_prima before insert or update on public.vol_volontari
  for each row execute function public.vol_volontari_prima_di_salvare();

-- Vista con la Regione (non è un campo da compilare).
-- Se in futuro si aggiungono colonne a vol_volontari, rieseguire questo blocco.
create or replace view public.vol_volontari_v with (security_invoker = true) as
  select v.*, s.regione, s.ordine as ordine_sezione
  from public.vol_volontari v
  join public.vol_sezioni s on s.sezione = v.sezione;

-- ---------------------------------------------------------------------
-- 5. Requisiti (colonne da spuntare) e spunte manuali
-- ---------------------------------------------------------------------
create table if not exists public.vol_requisiti (
  id                  bigint generated by default as identity primary key,
  nome                text not null,
  tipo                text not null check (tipo in ('CORSO','ABILITAZIONE')),
  obbligatorio        boolean not null default false,
  validita_mesi       int check (validita_mesi is null or validita_mesi > 0),
  ordine              int not null default 0,
  attivo              boolean not null default true,
  corso_formazione_id bigint references public.catalogo_corsi(id) on delete set null,
  created_at          timestamptz not null default now()
);
create unique index if not exists vol_requisiti_nome_uk on public.vol_requisiti (upper(nome));

-- Una riga per spunta. Togliere la spunta = conseguito false (mai cancellare).
create table if not exists public.vol_requisiti_volontario (
  volontario_id      uuid   not null references public.vol_volontari(id),
  requisito_id       bigint not null references public.vol_requisiti(id),
  conseguito         boolean not null default true,
  data_conseguimento date,
  note               text,
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  primary key (volontario_id, requisito_id)
);

create or replace function public.vol_spunta_prima_di_salvare()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_vol_spunta_prima on public.vol_requisiti_volontario;
create trigger trg_vol_spunta_prima before insert or update on public.vol_requisiti_volontario
  for each row execute function public.vol_spunta_prima_di_salvare();

-- Registro modifiche (come gli altri moduli). Non su vol_volontari: l'import
-- toccherebbe 1.500 righe a volta; per l'import c'è vol_import_log.
drop trigger if exists trg_log_attivita on public.vol_requisiti;
create trigger trg_log_attivita after insert or update or delete on public.vol_requisiti
  for each row execute function public.fn_log_attivita();
drop trigger if exists trg_log_attivita on public.vol_requisiti_volontario;
create trigger trg_log_attivita after insert or update or delete on public.vol_requisiti_volontario
  for each row execute function public.fn_log_attivita();

-- ---------------------------------------------------------------------
-- 6. Registro import
-- ---------------------------------------------------------------------
create table if not exists public.vol_import_log (
  id            bigint generated by default as identity primary key,
  data          timestamptz not null default now(),
  utente_id     uuid,
  utente_email  text,
  sezioni       text[] not null default '{}',
  nuovi         int not null default 0,
  aggiornati    int not null default 0,
  invariati     int not null default 0,
  non_in_pia    int not null default 0,
  dimessi       int not null default 0,
  da_verificare int not null default 0,
  scartati      int not null default 0
);

-- ---------------------------------------------------------------------
-- 7. Stato requisiti: spunte manuali + attestati della Scuola di Formazione
--    Funzione security definer (chi ha "volontari" vede le spunte automatiche
--    anche senza il permesso Formazione), filtrata per Sezione consentita.
-- ---------------------------------------------------------------------
create or replace function public.vol_stato_requisiti_f()
returns table (
  volontario_id uuid, requisito_id bigint, data date, data_scadenza date,
  origine text, stato text, documento_path text, edizione text
)
language sql stable security definer set search_path = public as $$
  with manuali as (
    select rv.volontario_id, rv.requisito_id, rv.data_conseguimento as data,
           'MANUALE'::text as origine, null::text as documento_path, null::text as edizione
    from vol_requisiti_volontario rv
    where rv.conseguito
  ),
  scuola as (
    select distinct on (v.id, r.id)
           v.id as volontario_id, r.id as requisito_id,
           coalesce(i.data_completamento, e.data_corso) as data,
           'SCUOLA'::text as origine, d.storage_path as documento_path, e.label as edizione
    from vol_requisiti r
    join edizioni_corso e        on e.catalogo_corso_id = r.corso_formazione_id
    join iscrizioni_corsi i      on i.edizione_corso_id = e.id
    join volontari_formazione vf on vf.id = i.volontario_id
    join vol_volontari v         on v.cf = upper(btrim(vf.codice_fiscale))
    left join documenti_volontario d on d.iscrizione_id = i.id and d.tipo = 'attestato'
    where r.corso_formazione_id is not null
      and (d.id is not null or i.attestato_rilasciato)
    order by v.id, r.id, coalesce(i.data_completamento, e.data_corso) desc nulls last, d.id desc nulls last
  ),
  tutte as (
    select * from manuali
    union all
    select * from scuola
  ),
  scelta as (
    -- se ci sono entrambe vince la data più recente (a parità, la Scuola)
    select distinct on (t.volontario_id, t.requisito_id) t.*
    from tutte t
    order by t.volontario_id, t.requisito_id, t.data desc nulls last, (t.origine = 'SCUOLA') desc
  )
  select s.volontario_id, s.requisito_id, s.data,
         case when r.validita_mesi is not null and s.data is not null
              then (s.data + make_interval(months => r.validita_mesi))::date end as data_scadenza,
         s.origine,
         case when r.validita_mesi is not null and s.data is not null
                   and (s.data + make_interval(months => r.validita_mesi))::date < current_date
              then 'SCADUTO' else 'VALIDO' end as stato,
         s.documento_path, s.edizione
  from scelta s
  join vol_requisiti r on r.id = s.requisito_id
  join vol_volontari v on v.id = s.volontario_id
  where vol_permesso_sezione(v.sezione, false);
$$;

create or replace view public.vol_stato_requisiti with (security_invoker = true) as
  select * from public.vol_stato_requisiti_f();

-- ---------------------------------------------------------------------
-- 8. Import dal PIA (tutto in un'unica transazione)
--    p_righe: [{cf, cognome, nome, sezione, gruppo, squadra, matricola_gisa,
--               matricola_vola, obsoleto (bool), da_verificare (bool)}]
--    p_sezioni: Sezioni coinvolte (solo lì i mancanti diventano NON_IN_PIA)
-- ---------------------------------------------------------------------
create or replace function public.vol_importa(p_righe jsonb, p_sezioni text[], p_scartati int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  esistente vol_volontari%rowtype;
  v_cf text; v_stato text; v_sez text;
  v_cognome text; v_nome text; v_gruppo text; v_squadra text; v_gisa text; v_vola text; v_dv boolean;
  cfs text[] := '{}';
  n_nuovi int := 0; n_agg int := 0; n_inv int := 0; n_dim int := 0; n_dv int := 0; n_nip int := 0;
  n_scart int := coalesce(p_scartati, 0);
  s text;
begin
  if p_sezioni is null or cardinality(p_sezioni) = 0 then
    raise exception 'Nessuna Sezione nell''import';
  end if;
  foreach s in array p_sezioni loop
    if not exists (select 1 from vol_sezioni where sezione = s) then
      raise exception 'Sezione sconosciuta: %', s;
    end if;
    if not vol_permesso_sezione(s, true) then
      raise exception 'Permesso negato per la Sezione %', s;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_righe, '[]'::jsonb)) loop
    v_cf      := upper(btrim(r->>'cf'));
    v_sez     := btrim(r->>'sezione');
    v_cognome := nullif(btrim(r->>'cognome'), '');
    v_nome    := coalesce(btrim(r->>'nome'), '');
    v_gruppo  := nullif(btrim(r->>'gruppo'), '');
    v_squadra := nullif(btrim(r->>'squadra'), '');
    v_gisa    := nullif(btrim(r->>'matricola_gisa'), '');
    v_vola    := nullif(btrim(r->>'matricola_vola'), '');
    v_dv      := coalesce((r->>'da_verificare')::boolean, false);
    v_stato   := case when coalesce((r->>'obsoleto')::boolean, false) then 'DIMESSO' else 'ATTIVO' end;

    if v_cf is null or not cf_valido(v_cf) or v_cognome is null
       or not (v_sez = any(p_sezioni)) or v_cf = any(cfs) then
      n_scart := n_scart + 1;
      continue;
    end if;
    cfs := cfs || v_cf;
    if v_dv then n_dv := n_dv + 1; end if;

    select * into esistente from vol_volontari where cf = v_cf for update;

    if not found then
      insert into vol_volontari (cf, cognome, nome, sezione, gruppo, squadra, matricola_gisa, matricola_vola,
                                 stato, da_verificare, ultimo_import)
      values (v_cf, v_cognome, v_nome, v_sez, v_gruppo, v_squadra, v_gisa, v_vola, v_stato, v_dv, now());
      if v_stato = 'DIMESSO' then n_dim := n_dim + 1; else n_nuovi := n_nuovi + 1; end if;
    else
      if v_stato = 'DIMESSO' and esistente.stato <> 'DIMESSO' then
        n_dim := n_dim + 1;
      elsif (esistente.cognome, esistente.nome, esistente.sezione, esistente.gruppo, esistente.squadra,
             esistente.matricola_gisa, esistente.matricola_vola, esistente.stato, esistente.da_verificare)
            is distinct from
            (v_cognome, v_nome, v_sez, v_gruppo, v_squadra, v_gisa, v_vola, v_stato, v_dv) then
        n_agg := n_agg + 1;
      else
        n_inv := n_inv + 1;
      end if;
      update vol_volontari set
        cognome = v_cognome, nome = v_nome, sezione = v_sez, gruppo = v_gruppo, squadra = v_squadra,
        matricola_gisa = v_gisa, matricola_vola = v_vola, stato = v_stato, da_verificare = v_dv,
        ultimo_import = now()
      where id = esistente.id;
    end if;
  end loop;

  -- attivi non presenti nell'import, solo per le Sezioni importate: NON_IN_PIA (mai cancellare)
  update vol_volontari set stato = 'NON_IN_PIA'
  where sezione = any(p_sezioni) and stato = 'ATTIVO' and not (cf = any(cfs));
  get diagnostics n_nip = row_count;

  insert into vol_import_log (utente_id, utente_email, sezioni, nuovi, aggiornati, invariati,
                              non_in_pia, dimessi, da_verificare, scartati)
  values (auth.uid(), auth.jwt()->>'email', p_sezioni, n_nuovi, n_agg, n_inv, n_nip, n_dim, n_dv, n_scart);

  return jsonb_build_object('nuovi', n_nuovi, 'aggiornati', n_agg, 'invariati', n_inv,
                            'non_in_pia', n_nip, 'dimessi', n_dim, 'da_verificare', n_dv, 'scartati', n_scart);
end;
$$;

-- ---------------------------------------------------------------------
-- 9. RLS e permessi
-- ---------------------------------------------------------------------
alter table public.vol_sezioni              enable row level security;
alter table public.vol_volontari            enable row level security;
alter table public.vol_requisiti            enable row level security;
alter table public.vol_requisiti_volontario enable row level security;
alter table public.vol_import_log           enable row level security;

revoke all on public.vol_sezioni, public.vol_volontari, public.vol_requisiti,
              public.vol_requisiti_volontario, public.vol_import_log,
              public.vol_volontari_v, public.vol_stato_requisiti from anon;

-- vol_sezioni: lettura con il permesso, modifica solo it_admin
drop policy if exists "vol_sezioni: lettura" on public.vol_sezioni;
create policy "vol_sezioni: lettura" on public.vol_sezioni for select to authenticated
  using (ha_accesso('volontari'));
drop policy if exists "vol_sezioni: scrittura" on public.vol_sezioni;
create policy "vol_sezioni: scrittura" on public.vol_sezioni for all to authenticated
  using (is_it_admin()) with check (is_it_admin());

-- vol_volontari: lettura per Sezione consentita; scrittura solo tramite vol_importa
-- (anagrafica in sola lettura nell'app, nessuna cancellazione)
drop policy if exists "vol_volontari: lettura" on public.vol_volontari;
create policy "vol_volontari: lettura" on public.vol_volontari for select to authenticated
  using (vol_permesso_sezione(sezione, false));

-- vol_requisiti: lettura con il permesso; inserimento/modifica dal gestore; mai cancellare (attivo = false)
drop policy if exists "vol_requisiti: lettura" on public.vol_requisiti;
create policy "vol_requisiti: lettura" on public.vol_requisiti for select to authenticated
  using (ha_accesso('volontari'));
drop policy if exists "vol_requisiti: inserimento" on public.vol_requisiti;
create policy "vol_requisiti: inserimento" on public.vol_requisiti for insert to authenticated
  with check (vol_gestore());
drop policy if exists "vol_requisiti: modifica" on public.vol_requisiti;
create policy "vol_requisiti: modifica" on public.vol_requisiti for update to authenticated
  using (vol_gestore()) with check (vol_gestore());

-- vol_requisiti_volontario: per Sezione consentita del volontario; nessuna cancellazione
drop policy if exists "vol_spunte: lettura" on public.vol_requisiti_volontario;
create policy "vol_spunte: lettura" on public.vol_requisiti_volontario for select to authenticated
  using (vol_permesso_sezione((select v.sezione from vol_volontari v where v.id = volontario_id), false));
drop policy if exists "vol_spunte: inserimento" on public.vol_requisiti_volontario;
create policy "vol_spunte: inserimento" on public.vol_requisiti_volontario for insert to authenticated
  with check (vol_permesso_sezione((select v.sezione from vol_volontari v where v.id = volontario_id), true));
drop policy if exists "vol_spunte: modifica" on public.vol_requisiti_volontario;
create policy "vol_spunte: modifica" on public.vol_requisiti_volontario for update to authenticated
  using (vol_permesso_sezione((select v.sezione from vol_volontari v where v.id = volontario_id), true))
  with check (vol_permesso_sezione((select v.sezione from vol_volontari v where v.id = volontario_id), true));

-- vol_import_log: lettura con il permesso; scrittura solo da vol_importa
drop policy if exists "vol_import_log: lettura" on public.vol_import_log;
create policy "vol_import_log: lettura" on public.vol_import_log for select to authenticated
  using (ha_accesso('volontari'));

-- Funzioni: niente accesso anonimo
revoke execute on function public.vol_permesso_sezione(text, boolean) from public, anon;
revoke execute on function public.vol_gestore() from public, anon;
revoke execute on function public.vol_stato_requisiti_f() from public, anon;
revoke execute on function public.vol_importa(jsonb, text[], int) from public, anon;
grant  execute on function public.vol_permesso_sezione(text, boolean) to authenticated;
grant  execute on function public.vol_gestore() to authenticated;
grant  execute on function public.vol_stato_requisiti_f() to authenticated;
grant  execute on function public.vol_importa(jsonb, text[], int) to authenticated;

commit;
