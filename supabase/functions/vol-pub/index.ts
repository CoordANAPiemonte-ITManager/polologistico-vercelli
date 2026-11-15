// =====================================================================
// Edge Function: vol-pub
// Pagina pubblica volontari-sezione.html: le Sezioni aggiornano corsi e
// abilitazioni dei propri volontari tramite un link con token.
//
// Azioni (POST JSON, campo "azione", sempre con "token"):
//   apri   -> dati della richiesta (solo volontari ATTIVI della Sezione, CF ridotto)
//   salva  -> salva la bozza (richiesta APERTA e non scaduta)
//   invia  -> invia: le date diverse dall'archivio diventano proposte da validare
//
// Sicurezza: token validato lato server (64 caratteri esadecimali, stato,
// scadenza) dalle funzioni SQL vol_pub_*, eseguibili solo da service_role;
// limite di richieste per IP (impronta SHA-256, mai l'IP in chiaro);
// corpo massimo 500 KB. Nessun dato se il token non è valido.
//
// Deploy SENZA verifica JWT (la pagina non ha login):
//   npx supabase@2.122.0 functions deploy vol-pub --no-verify-jwt --use-api
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_CORPO = 500_000;
const LIMITE_RICHIESTE = 120; // per IP ogni 10 minuti
const LIMITE_TOKEN_ERRATI = 20; // tentativi con token non valido per IP ogni 10 minuti

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

// errori noti sollevati dalle funzioni SQL → codice per la pagina
const ERRORI = [
  "TOKEN_NON_VALIDO", "RICHIESTA_REVOCATA", "RICHIESTA_SCADUTA", "RICHIESTA_NON_APERTA",
  "NOME_MANCANTE", "DATI_NON_VALIDI", "VOLONTARIO_NON_VALIDO", "REQUISITO_NON_VALIDO", "DATA_NON_VALIDA",
];
function codiceErrore(msg: string | undefined): string {
  const m = String(msg ?? "");
  return ERRORI.find((e) => m.includes(e)) ?? "errore_interno";
}

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function limiteSuperato(chiave: string, max: number): Promise<boolean> {
  const { data, error } = await admin.rpc("vol_pub_limite", { p_chiave: chiave, p_max: max, p_minuti: 10 });
  if (error){ console.error("limite", error); return false; } // il limite non deve bloccare il servizio
  return data === false;
}

const testo = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ errore: "metodo_non_consentito" }, 405);

  const lung = Number(req.headers.get("content-length") ?? "0");
  if (lung > MAX_CORPO) return json({ errore: "DATI_NON_VALIDI" }, 413);
  let corpo: string;
  try { corpo = await req.text(); } catch { return json({ errore: "richiesta_non_valida" }, 400); }
  if (corpo.length > MAX_CORPO) return json({ errore: "DATI_NON_VALIDI" }, 413);
  let b: any;
  try { b = JSON.parse(corpo); } catch { return json({ errore: "richiesta_non_valida" }, 400); }

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "sconosciuto";
  const impronta = await sha256Hex("vol-pub|" + ip);
  if (await limiteSuperato(impronta, LIMITE_RICHIESTE)) return json({ errore: "troppe_richieste" }, 429);

  const token = typeof b?.token === "string" ? b.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)){
    if (await limiteSuperato("errato|" + impronta, LIMITE_TOKEN_ERRATI)) return json({ errore: "troppe_richieste" }, 429);
    return json({ errore: "TOKEN_NON_VALIDO" }, 404);
  }

  let rpc: { data: unknown; error: { message?: string } | null };
  switch (b?.azione) {
    case "apri":
      rpc = await admin.rpc("vol_pub_apri", { p_token: token });
      break;
    case "salva":
      rpc = await admin.rpc("vol_pub_salva", { p_token: token, p_bozza: b.bozza ?? null });
      break;
    case "invia":
      rpc = await admin.rpc("vol_pub_invia", {
        p_token: token, p_bozza: b.bozza ?? null,
        p_nome: testo(b.nome, 100), p_ruolo: testo(b.ruolo, 100),
      });
      break;
    default:
      return json({ errore: "azione_sconosciuta" }, 400);
  }

  if (rpc.error){
    const codice = codiceErrore(rpc.error.message);
    if (codice === "errore_interno") console.error(b?.azione, rpc.error);
    if (codice === "TOKEN_NON_VALIDO"){
      if (await limiteSuperato("errato|" + impronta, LIMITE_TOKEN_ERRATI)) return json({ errore: "troppe_richieste" }, 429);
      return json({ errore: codice }, 404);
    }
    return json({ errore: codice }, codice === "errore_interno" ? 500 : 400);
  }
  return json({ ok: true, dati: rpc.data });
});
