// =====================================================================
// Edge Function: admin-utenti
// Gestione utenti del Polo Logistico interamente dall'app (niente mail).
//
// Azioni (POST JSON, campo "azione"), sempre con il JWT dell'utente collegato:
//   crea              (it_admin) email, nome, ruolo, permessi -> utente confermato
//                     con password temporanea; app_users.deve_cambiare_password = true
//   modifica          (it_admin) id, nome, ruolo, permessi
//   reset_password    (it_admin) id -> nuova password temporanea, flag a true,
//                     chiusura delle sessioni
//   disattiva         (it_admin) id -> attivo = false, ban in auth, sessioni chiuse
//   riattiva          (it_admin) id -> attivo = true, ban tolto
//   password_cambiata (qualsiasi utente, solo per sé) -> flag a false
//
// Protezioni: il chiamante deve essere it_admin ATTIVO (letto da app_users con
// il suo JWT), altrimenti 403; un admin non può disattivare, declassare o
// resettare sé stesso; nessuna azione può lasciare il sistema senza it_admin
// attivi. Le password temporanee sono restituite solo nella risposta:
// mai salvate, mai scritte nei log.
//
// Deploy (la verifica del JWT la fa la funzione stessa):
//   verify_jwt = false
// Facoltativa: funzione SQL admin_termina_sessioni (sql/admin_utenti.sql).
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RUOLI = ["it_admin", "specialita", "segreteria", "standard"];
const BAN_DISATTIVATO = "876000h"; // ~100 anni

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const errore = (messaggio: string, status = 400) => json({ errore: messaggio }, status);

const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------- password temporanea: 12 caratteri, niente caratteri ambigui (0 O o 1 l I i) ----------
const MAIUSCOLE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MINUSCOLE = "abcdefghjkmnpqrstuvwxyz";
const CIFRE = "23456789";
function casuale(alfabeto: string): string {
  // campionamento senza distorsione (scarta i valori oltre il multiplo)
  const limite = 256 - (256 % alfabeto.length);
  const b = new Uint8Array(1);
  do { crypto.getRandomValues(b); } while (b[0] >= limite);
  return alfabeto[b[0] % alfabeto.length];
}
function passwordTemporanea(): string {
  const tutti = MAIUSCOLE + MINUSCOLE + CIFRE;
  const c = [casuale(MAIUSCOLE), casuale(MINUSCOLE), casuale(CIFRE)];
  while (c.length < 12) c.push(casuale(tutti));
  for (let i = c.length - 1; i > 0; i--) { // mescolo
    const b = new Uint32Array(1); crypto.getRandomValues(b);
    const j = b[0] % (i + 1);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.join("");
}

// ---------- validazione ----------
const emailValida = (e: unknown) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
function permessiPuliti(p: unknown): Record<string, unknown> | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (!/^[a-z_]{1,40}$/.test(k)) return null;
    if (k === "volontari_sezioni") {
      if (v === null) continue;
      if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === "string" && x.length <= 60)) return null;
      out[k] = v;
    } else if (typeof v === "boolean" || v === "base" || v === "completo") {
      out[k] = v;
    } else {
      return null;
    }
  }
  return JSON.stringify(out).length <= 4000 ? out : null;
}

async function adminAttiviEsclusi(idEscluso: string): Promise<number> {
  const { count, error } = await admin.from("app_users").select("id", { count: "exact", head: true })
    .eq("ruolo", "it_admin").or("attivo.is.null,attivo.eq.true").neq("id", idEscluso);
  if (error) throw new Error("controllo amministratori non riuscito");
  return count ?? 0;
}

async function terminaSessioni(id: string) {
  const { error } = await admin.rpc("admin_termina_sessioni", { p_user: id });
  if (error) console.warn("sessioni non chiuse (funzione admin_termina_sessioni assente?)", error.message);
}

async function utenteBersaglio(id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await admin.from("app_users").select("id, nome, email, ruolo, attivo").eq("id", id).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return errore("metodo non consentito", 405);

  // chi sta chiamando (JWT dell'utente collegato)
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return errore("accesso richiesto", 401);
  const { data: u, error: errU } = await admin.auth.getUser(jwt);
  if (errU || !u?.user) return errore("accesso richiesto", 401);
  const io = u.user;

  let b: any;
  try { b = await req.json(); } catch { return errore("richiesta non valida"); }
  const azione = b?.azione;

  // profilo del chiamante letto con il SUO JWT (vale la RLS di app_users)
  const comeUtente = createClient(SB_URL, SB_ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profilo } = await comeUtente.from("app_users").select("id, ruolo, attivo").eq("id", io.id).maybeSingle();

  // ---------- azione per sé stessi ----------
  if (azione === "password_cambiata") {
    if (!profilo || profilo.attivo === false) return errore("utente non abilitato", 403);
    const { error } = await admin.from("app_users").update({ deve_cambiare_password: false }).eq("id", io.id);
    if (error) return errore("aggiornamento non riuscito", 500);
    return json({ ok: true });
  }

  // ---------- da qui solo it_admin attivi ----------
  if (!profilo || profilo.ruolo !== "it_admin" || profilo.attivo === false) return errore("permesso negato", 403);

  try {
    if (azione === "crea") {
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const nome = typeof b.nome === "string" ? b.nome.trim().slice(0, 100) : "";
      const ruolo = b.ruolo;
      const permessi = permessiPuliti(b.permessi ?? {});
      if (!emailValida(email)) return errore("Email non valida");
      if (!nome) return errore("Il nome è obbligatorio");
      if (!RUOLI.includes(ruolo)) return errore("Ruolo non valido");
      if (!permessi) return errore("Permessi non validi");
      // confronto senza maiuscole; % e _ sono caratteri jolly in ilike: li rendo letterali
      const { data: esiste } = await admin.from("app_users").select("id")
        .ilike("email", email.replace(/[\\%_]/g, (m) => "\\" + m)).limit(1).maybeSingle();
      if (esiste) return errore("Esiste già un utente con questa email");

      const password = passwordTemporanea();
      const { data: creato, error: errC } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { nome },
      });
      if (errC || !creato?.user) {
        const msg = String(errC?.message ?? "");
        if (/already|registered|exists/i.test(msg)) return errore("Questa email è già registrata in Supabase: controlla in Authentication > Users");
        console.error("createUser", msg);
        return errore("Creazione dell'utente non riuscita", 500);
      }
      const { error: errI } = await admin.from("app_users").insert({
        id: creato.user.id, nome, email, ruolo, permessi, attivo: true, deve_cambiare_password: true,
      });
      if (errI) {
        // annullo: senza la riga in app_users l'utente non deve esistere
        await admin.auth.admin.deleteUser(creato.user.id);
        console.error("insert app_users", errI.message);
        return errore("Creazione dell'utente non riuscita", 500);
      }
      return json({ ok: true, id: creato.user.id, password });
    }

    const t = await utenteBersaglio(b.id);
    if (!t) return errore("Utente non trovato", 404);
    const sonoIo = t.id === io.id;

    if (azione === "modifica") {
      const nome = typeof b.nome === "string" ? b.nome.trim().slice(0, 100) : "";
      const ruolo = b.ruolo;
      const permessi = permessiPuliti(b.permessi ?? {});
      if (!nome) return errore("Il nome è obbligatorio");
      if (!RUOLI.includes(ruolo)) return errore("Ruolo non valido");
      if (!permessi) return errore("Permessi non validi");
      if (sonoIo && ruolo !== "it_admin") return errore("Non puoi togliere a te stesso il ruolo IT Administrator");
      if (t.ruolo === "it_admin" && t.attivo !== false && ruolo !== "it_admin" && (await adminAttiviEsclusi(t.id)) === 0) {
        return errore("Resterebbe nessun IT Administrator attivo");
      }
      const { error } = await admin.from("app_users").update({ nome, ruolo, permessi }).eq("id", t.id);
      if (error) return errore("Salvataggio non riuscito", 500);
      return json({ ok: true });
    }

    if (azione === "reset_password") {
      if (sonoIo) return errore("Non puoi reimpostare la tua password da qui: usa Impostazioni > Cambia password");
      const password = passwordTemporanea();
      const { error: errP } = await admin.auth.admin.updateUserById(t.id, { password });
      if (errP) { console.error("reset", errP.message); return errore("Reimpostazione non riuscita", 500); }
      const { error } = await admin.from("app_users").update({ deve_cambiare_password: true }).eq("id", t.id);
      if (error) return errore("Password cambiata, ma non riesco a impostare il cambio obbligatorio", 500);
      await terminaSessioni(t.id);
      return json({ ok: true, password });
    }

    if (azione === "disattiva") {
      if (sonoIo) return errore("Non puoi disattivare te stesso");
      if (t.ruolo === "it_admin" && t.attivo !== false && (await adminAttiviEsclusi(t.id)) === 0) {
        return errore("Resterebbe nessun IT Administrator attivo");
      }
      const { error } = await admin.from("app_users").update({ attivo: false }).eq("id", t.id);
      if (error) return errore("Disattivazione non riuscita", 500);
      const { error: errB } = await admin.auth.admin.updateUserById(t.id, { ban_duration: BAN_DISATTIVATO });
      if (errB) console.warn("ban non riuscito", errB.message);
      await terminaSessioni(t.id);
      return json({ ok: true });
    }

    if (azione === "riattiva") {
      const { error } = await admin.from("app_users").update({ attivo: true }).eq("id", t.id);
      if (error) return errore("Riattivazione non riuscita", 500);
      const { error: errB } = await admin.auth.admin.updateUserById(t.id, { ban_duration: "none" });
      if (errB) console.warn("unban non riuscito", errB.message);
      return json({ ok: true });
    }

    return errore("Azione sconosciuta");
  } catch (e) {
    console.error(azione, (e as Error).message);
    return errore("Errore interno", 500);
  }
});
