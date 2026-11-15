/* =====================================================================
   MODULO VOLONTARI – richieste alle Sezioni, Excel e validazione
   ---------------------------------------------------------------------
   Caricato da index.html dopo volontari.js: usa le sue funzioni e i suoi dati
   (_vol, volGestore, volCaricaDati, volRicaricaStatoVolontario, VOL_STATI_REQ…)
   e le funzioni comuni di index.html (sb, escapeHtml, chiudiModal, formatDataIt).
   Solo per il gestore (vol_gestore: it_admin o "volontari" completo senza
   limite di Sezione). Tabelle: vol_richieste_sezione (mai select del token:
   colonne esplicite, il link arriva da vol_richiesta_link) e vol_proposte.
   Due canali, stessa coda: link pubblico (volontari-sezione.html + Edge
   Function vol-pub) ed Excel (ExcelJS, generato e ricaricato qui).
   Nulla entra nei dati senza approvazione (vol_valida_proposta).
   ===================================================================== */

const VOLS_STATI_RIC = { APERTA:"Aperta", INVIATA:"Da validare", CHIUSA:"Chiusa", REVOCATA:"Revocata" };
const VOLS_COLONNE_RIC = "id, sezione, requisiti_inclusi, canale, scadenza, stato, note_master, created_at, compilatore_nome, compilatore_ruolo, inviata_at, bozza_at, chiusa_at";
const VOLS_COLONNE_PROP = "id, richiesta_id, volontario_id, requisito_id, tipo_evento, data, valore_attuale, note, tipo_proposta, stato, motivo_rifiuto, nota_master, validata_at, created_at";
const VOLS_EXCELJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
const VOLS_FOGLIO = "Volontari";
const VOLS_FOGLIO_RIC = "_richiesta";
const VOLS_SEGNALAZIONI_RIGHE = 60;

let _vols = { richieste:[], conteggi:new Map(), filtro:"attive" };

/* ---------- Badge "Da validare" (sidebar e scheda) ---------- */
async function volsAggiornaBadge(){
  const nav = document.getElementById("badge-volontari");
  const tab = document.getElementById("vol-badge-validare");
  if (!state?.profile || !userCanSee("volontari") || !volGestore()){
    if (nav) nav.style.display = "none";
    return;
  }
  const { count, error } = await sb.from("vol_proposte").select("id", { count:"exact", head:true }).eq("stato", "IN_ATTESA");
  if (error) return;
  const n = count || 0;
  if (nav){ nav.textContent = n; nav.style.display = n ? "inline-block" : "none"; }
  const t = document.getElementById("vol-badge-validare");
  if (t){ t.textContent = n; t.hidden = !n; }
}

/* ---------- utilità ---------- */
function volsNomeVolontario(id){
  const v = _vol.perId.get(id);
  return v ? `${v.cognome} ${v.nome}` : "(volontario non trovato)";
}
function volsRequisitiDi(ric){
  return _vol.requisiti.filter(r => (ric.requisiti_inclusi || []).map(Number).includes(r.id));
}
function volsScaduta(ric){ return ric.stato === "APERTA" && new Date(ric.scadenza) < new Date(); }
function volsDataOra(iso){ return iso ? new Date(iso).toLocaleString("it-IT", { dateStyle:"short", timeStyle:"short" }) : ""; }
function volsLink(token){ return new URL(`volontari-sezione.html?t=${encodeURIComponent(token)}`, location.href).href; }
function volsIsoDaDate(d){
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function volsDateUtc(iso){ const [a, m, g] = iso.split("-").map(Number); return new Date(Date.UTC(a, m - 1, g)); }

let _volsExcelJS = null;
function volsCaricaExcelJS(){
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (_volsExcelJS) return _volsExcelJS;
  _volsExcelJS = new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = VOLS_EXCELJS_URL;
    s.onload = () => window.ExcelJS ? ok(window.ExcelJS) : ko(new Error("Libreria Excel non disponibile."));
    s.onerror = () => { _volsExcelJS = null; ko(new Error("Impossibile caricare la libreria Excel: controlla la connessione.")); };
    document.head.appendChild(s);
  });
  return _volsExcelJS;
}

function volsApriModal(titolo, larga = true){
  chiudiModal();
  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box ${larga ? "modal-box-lg" : ""}">
      <div class="modal-head"><h3>${escapeHtml(titolo)}</h3><button class="modal-close" onclick="chiudiModal()">✕</button></div>
      <div class="modal-body" id="vols-modal-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay.querySelector("#vols-modal-body");
}

/* =====================================================================
   SCHEDA "RICHIESTE ALLE SEZIONI"
   ===================================================================== */
async function volsCaricaRichieste(){
  const [rr, rp] = await Promise.all([
    sb.from("vol_richieste_sezione").select(VOLS_COLONNE_RIC).order("created_at", { ascending:false }),
    caricaTutteLeRighe(() => sb.from("vol_proposte").select("id, richiesta_id, stato"))
  ]);
  if (rr.error) return rr.error.message;
  if (rp.error) return rp.error.message;
  _vols.richieste = rr.data || [];
  _vols.conteggi = new Map();
  (rp.data || []).forEach(p => {
    const c = _vols.conteggi.get(p.richiesta_id) || { IN_ATTESA:0, APPROVATA:0, RIFIUTATA:0, GESTITA:0 };
    c[p.stato] = (c[p.stato] || 0) + 1;
    _vols.conteggi.set(p.richiesta_id, c);
  });
  return null;
}

async function volsRenderRichieste(box){
  box.innerHTML = `<div class="loading-spin">Caricamento…</div>`;
  const err = await volsCaricaRichieste();
  if (_vol.vista !== "richieste") return;
  if (err){ box.innerHTML = `<div class="storico-empty">Errore: ${escapeHtml(err)}</div>`; return; }
  const lista = _vols.richieste.filter(r => _vols.filtro === "tutte" || r.stato === "APERTA" || r.stato === "INVIATA");

  box.innerHTML = `
    <div class="vols-barra">
      <p class="vol-legenda" style="margin:0;flex:1;">Chiedi alle Sezioni di completare le date di corsi e abilitazioni, con un link da aprire anche dal cellulare oppure con un file Excel. Quello che arriva va nella scheda <b>Da validare</b>: nulla entra nei dati senza la tua approvazione.</p>
      <select id="vols-filtro">
        <option value="attive" ${_vols.filtro === "attive" ? "selected" : ""}>Aperte e da validare</option>
        <option value="tutte" ${_vols.filtro === "tutte" ? "selected" : ""}>Tutte (storico)</option>
      </select>
      <button type="button" class="btn-add-mini" id="vols-nuova">+ Nuova richiesta</button>
    </div>
    ${lista.length ? `
    <div class="vol-wrap" style="max-height:none;">
      <table class="storico-table vols-tab">
        <thead><tr><th>Sezione</th><th>Canale</th><th>Corsi richiesti</th><th>Creata</th><th>Scadenza</th><th>Stato</th><th>Esito</th><th></th></tr></thead>
        <tbody>${lista.map(volsHtmlRigaRichiesta).join("")}</tbody>
      </table>
    </div>` : `<div class="storico-empty">${_vols.filtro === "tutte" ? "Nessuna richiesta." : "Nessuna richiesta aperta. Usa <b>+ Nuova richiesta</b>."}</div>`}`;

  box.querySelector("#vols-filtro").addEventListener("change", e => { _vols.filtro = e.target.value; volsRenderRichieste(box); });
  box.querySelector("#vols-nuova").addEventListener("click", volsApriNuovaRichiesta);
  box.querySelectorAll("[data-az]").forEach(b => b.addEventListener("click", () => {
    const ric = _vols.richieste.find(r => r.id === Number(b.dataset.id));
    if (ric) volsAzioneRichiesta(b.dataset.az, ric, b);
  }));
}

function volsHtmlRigaRichiesta(r){
  const c = _vols.conteggi.get(r.id) || {};
  const scaduta = volsScaduta(r);
  const esito = [
    c.IN_ATTESA ? `<b>${c.IN_ATTESA}</b> da validare` : "",
    c.APPROVATA ? `${c.APPROVATA} approvate` : "",
    c.RIFIUTATA ? `${c.RIFIUTATA} rifiutate` : "",
    c.GESTITA ? `${c.GESTITA} segnalazioni gestite` : "",
  ].filter(Boolean).join(" · ") || (r.stato === "CHIUSA" && r.inviata_at ? "nessuna modifica" : "—");
  const az = [];
  if (r.stato === "APERTA"){
    if (r.canale === "LINK") az.push(["link", "Copia link"], ["mail", "Invia mail"]);
    else az.push(["genera", "Genera Excel"], ["carica", "Carica Excel compilato"]);
    az.push(["proroga", "Proroga"], ["revoca", "Revoca"]);
  }
  if (r.stato === "INVIATA" && !c.IN_ATTESA) az.push(["chiudi", "Chiudi"]);
  if (r.stato !== "APERTA") az.push(["dettaglio", "Dettaglio"]);
  return `
    <tr>
      <td><b>${escapeHtml(r.sezione)}</b>${r.note_master ? `<br><small class="vols-nota" title="${escapeHtml(r.note_master)}">${escapeHtml(r.note_master.slice(0, 60))}${r.note_master.length > 60 ? "…" : ""}</small>` : ""}</td>
      <td>${r.canale === "LINK" ? `<i class="ti ti-link" aria-hidden="true"></i> Link` : `<i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel`}</td>
      <td>${volsRequisitiDi(r).map(q => escapeHtml(q.nome)).join(", ")}</td>
      <td>${volsDataOra(r.created_at)}</td>
      <td>${r.stato === "APERTA" ? `${formatDataIt(r.scadenza.slice(0, 10))}${scaduta ? ` <span class="vols-scaduta">scaduta</span>` : ""}` : "—"}</td>
      <td><span class="vols-stato ${r.stato}">${VOLS_STATI_RIC[r.stato]}</span>
        ${r.inviata_at ? `<br><small>inviata ${volsDataOra(r.inviata_at)}${r.compilatore_nome ? ` da ${escapeHtml(r.compilatore_nome)}` : ""}</small>`
          : r.bozza_at ? `<br><small>bozza salvata ${volsDataOra(r.bozza_at)}</small>` : ""}</td>
      <td>${esito}</td>
      <td class="vols-azioni">${az.map(([k, l]) => `<button type="button" class="row-del" data-az="${k}" data-id="${r.id}">${l}</button>`).join("")}</td>
    </tr>`;
}

async function volsAzioneRichiesta(az, ric, btn){
  if (az === "link" || az === "mail"){
    const { data, error } = await sb.rpc("vol_richiesta_link", { p_id: ric.id });
    if (error || !data?.[0]?.token){ alert("Errore: " + (error?.message || "link non disponibile")); return; }
    const link = volsLink(data[0].token);
    if (az === "link"){
      try { await navigator.clipboard.writeText(link); const t = btn.textContent; btn.textContent = "Copiato!"; setTimeout(() => { btn.textContent = t; }, 2000); }
      catch(e){ prompt("Copia il link:", link); }
    } else {
      volsMailto(ric, link, data[0].email_pc);
    }
    return;
  }
  if (az === "genera"){ volsGeneraExcel(ric).catch(e => alert("Errore: " + e.message)); return; }
  if (az === "carica"){ volsScegliFileExcel(ric); return; }
  if (az === "dettaglio"){ volsApriDettaglio(ric); return; }
  if (az === "proroga"){
    const g = prompt(`Di quanti giorni prorogare la richiesta per ${ric.sezione}?`, "15");
    if (!g) return;
    const { error } = await sb.rpc("vol_richiesta_azione", { p_id: ric.id, p_azione:"PROROGA", p_giorni: Number(g) });
    if (error){ alert("Errore: " + error.message); return; }
  }
  if (az === "revoca"){
    if (!confirm(`Revocare la richiesta per ${ric.sezione}? ${ric.canale === "LINK" ? "Il link smetterà subito di funzionare." : "L'Excel non potrà più essere caricato."}`)) return;
    const { error } = await sb.rpc("vol_richiesta_azione", { p_id: ric.id, p_azione:"REVOCA" });
    if (error){ alert("Errore: " + error.message); return; }
  }
  if (az === "chiudi"){
    const { error } = await sb.rpc("vol_richiesta_azione", { p_id: ric.id, p_azione:"CHIUDI" });
    if (error){ alert("Errore: " + error.message); return; }
  }
  volAggiornaVista();
}

function volsMailto(ric, link, email){
  const scad = formatDataIt(ric.scadenza.slice(0, 10));
  const corsi = volsRequisitiDi(ric).map(q => "- " + q.nome).join("\n");
  const oggetto = `Aggiornamento corsi e abilitazioni volontari – Sezione di ${ric.sezione}`;
  const testo = `Buongiorno,\n\nvi chiediamo di controllare e completare le date dei seguenti corsi e abilitazioni per i volontari della Sezione di ${ric.sezione}:\n${corsi}\n\n` +
    (ric.note_master ? ric.note_master + "\n\n" : "") +
    `Potete compilare direttamente da questo link, anche dal cellulare, entro il ${scad}:\n${link}\n\n` +
    `Si può salvare una bozza e riprendere più tardi dallo stesso link. Le date inviate saranno verificate dal Polo Logistico prima di essere registrate.\n\nGrazie,\nPolo Logistico 1° RGPT/CAP Vercelli`;
  location.href = `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(testo)}`;
}

/* ---------- Nuova richiesta ---------- */
function volsApriNuovaRichiesta(){
  const body = volsApriModal("Nuova richiesta alla Sezione", false);
  const attivi = new Map();
  _vol.volontari.filter(v => v.stato === "ATTIVO").forEach(v => attivi.set(v.sezione, (attivi.get(v.sezione) || 0) + 1));
  const req = _vol.requisiti.filter(r => r.attivo);
  body.innerHTML = `
    <form id="vols-form-nuova">
      <div class="form-field"><label>Sezione *</label>
        <select name="sezione" required>
          <option value="">— scegli —</option>
          ${_vol.sezioni.map(s => `<option value="${escapeHtml(s.sezione)}">${escapeHtml(s.sezione)} (${attivi.get(s.sezione) || 0} attivi)</option>`).join("")}
        </select></div>
      <div class="form-field" style="margin-top:12px;"><label>Corsi e abilitazioni da compilare *</label>
        <div class="vols-scelte">${req.map(r => `<label><input type="checkbox" name="req" value="${r.id}"> ${escapeHtml(r.nome)}${r.prevede_aggiornamento ? " <small>(con aggiornamento)</small>" : ""}</label>`).join("")}</div></div>
      <div class="form-field" style="margin-top:12px;"><label>Canale</label>
        <div class="vols-scelte">
          <label><input type="radio" name="canale" value="LINK" checked> Link da aprire (anche da cellulare)</label>
          <label><input type="radio" name="canale" value="EXCEL"> File Excel da compilare e rimandare</label>
        </div></div>
      <div class="form-field" style="margin-top:12px;"><label>Scadenza (giorni da oggi)</label><input type="number" name="giorni" min="1" max="180" value="30"></div>
      <div class="form-field" style="margin-top:12px;"><label>Nota per la Sezione (facoltativa)</label><textarea name="note" rows="3" maxlength="1000" placeholder="es. Compilate entro fine mese, servono per l'esercitazione di primavera"></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn-cancel" onclick="chiudiModal()">Annulla</button>
        <button type="submit" class="btn-save">Crea richiesta</button>
      </div>
    </form>`;
  const f = body.querySelector("#vols-form-nuova");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const requisiti = [...f.querySelectorAll("[name=req]:checked")].map(c => Number(c.value));
    if (!f.sezione.value){ alert("Scegli la Sezione."); return; }
    if (!requisiti.length){ alert("Scegli almeno un corso o abilitazione."); return; }
    if (!attivi.get(f.sezione.value) && !confirm("Questa Sezione non ha volontari attivi in anagrafica. Creare comunque la richiesta?")) return;
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const { data, error } = await sb.rpc("vol_richiesta_crea", {
      p_sezione: f.sezione.value, p_requisiti: requisiti, p_canale: f.canale.value,
      p_giorni: Number(f.giorni.value || 30), p_note: f.note.value.trim() || null
    });
    if (error){ btn.disabled = false; alert("Errore: " + error.message); return; }
    await volsCaricaRichieste();
    const ric = _vols.richieste.find(r => r.id === data.id);
    volAggiornaVista();
    if (ric) volsMostraCreata(ric, data.token);
    else chiudiModal();
  });
}

function volsMostraCreata(ric, token){
  const body = volsApriModal("Richiesta creata", false);
  if (ric.canale === "LINK"){
    const link = volsLink(token);
    body.innerHTML = `
      <p>Richiesta per la Sezione di <b>${escapeHtml(ric.sezione)}</b>, valida fino al <b>${formatDataIt(ric.scadenza.slice(0, 10))}</b>.</p>
      <div class="vols-link"><input readonly value="${escapeHtml(link)}" id="vols-link-txt"></div>
      <p class="vol-legenda">Il link si può copiare di nuovo in qualsiasi momento dalla scheda Richieste alle Sezioni.</p>
      <div class="form-actions">
        <button type="button" class="btn-cancel" id="vols-c-mail">Invia mail</button>
        <button type="button" class="btn-save" id="vols-c-copia">Copia link</button>
      </div>`;
    body.querySelector("#vols-c-copia").addEventListener("click", async (ev) => {
      try { await navigator.clipboard.writeText(link); ev.currentTarget.textContent = "Copiato!"; }
      catch(e){ body.querySelector("#vols-link-txt").select(); }
    });
    body.querySelector("#vols-c-mail").addEventListener("click", async () => {
      const { data } = await sb.rpc("vol_richiesta_link", { p_id: ric.id });
      volsMailto(ric, link, data?.[0]?.email_pc);
    });
  } else {
    body.innerHTML = `
      <p>Richiesta Excel per la Sezione di <b>${escapeHtml(ric.sezione)}</b>, valida fino al <b>${formatDataIt(ric.scadenza.slice(0, 10))}</b>.</p>
      <p class="vol-legenda">Scarica il file e mandalo alla Sezione. Quando torna compilato, caricalo con <b>Carica Excel compilato</b> dalla scheda Richieste alle Sezioni.</p>
      <div class="form-actions">
        <button type="button" class="btn-cancel" onclick="chiudiModal()">Chiudi</button>
        <button type="button" class="btn-save" id="vols-c-genera">Genera Excel</button>
      </div>`;
    body.querySelector("#vols-c-genera").addEventListener("click", () => volsGeneraExcel(ric).catch(e => alert("Errore: " + e.message)));
  }
}

/* ---------- Dettaglio (storico esiti) ---------- */
async function volsApriDettaglio(ric){
  const body = volsApriModal(`Richiesta n. ${ric.id} – ${ric.sezione}`);
  body.innerHTML = `<div class="loading-spin">Caricamento…</div>`;
  const { data, error } = await sb.from("vol_proposte").select(VOLS_COLONNE_PROP).eq("richiesta_id", ric.id).order("id");
  if (error){ body.innerHTML = `<p>Errore: ${escapeHtml(error.message)}</p>`; return; }
  const reqNome = id => _vol.requisiti.find(r => r.id === id)?.nome || "";
  const ESITI = { IN_ATTESA:"Da validare", APPROVATA:"Approvata", RIFIUTATA:"Rifiutata", GESTITA:"Gestita" };
  body.innerHTML = `
    <p class="vol-legenda" style="margin-top:0;">${ric.canale === "LINK" ? "Link" : "Excel"} · creata ${volsDataOra(ric.created_at)}
      ${ric.inviata_at ? ` · inviata ${volsDataOra(ric.inviata_at)}${ric.compilatore_nome ? ` da ${escapeHtml(ric.compilatore_nome)}${ric.compilatore_ruolo ? " (" + escapeHtml(ric.compilatore_ruolo) + ")" : ""}` : ""}` : ""}
      · stato <b>${VOLS_STATI_RIC[ric.stato]}</b></p>
    ${(data || []).length ? `
    <table class="storico-table">
      <thead><tr><th>Volontario</th><th>Corso</th><th>Proposta</th><th>Esito</th></tr></thead>
      <tbody>${data.map(p => `
        <tr>
          <td>${p.volontario_id ? escapeHtml(volsNomeVolontario(p.volontario_id)) : "—"}</td>
          <td>${p.tipo_proposta === "EVENTO" ? `${escapeHtml(reqNome(p.requisito_id))}<br><small>${p.tipo_evento === "BASE" ? "Base" : "Aggiornamento"}</small>` : "<i>Segnalazione</i>"}</td>
          <td>${p.tipo_proposta === "EVENTO" ? `${p.valore_attuale ? formatDataIt(p.valore_attuale) : "—"} → <b>${formatDataIt(p.data)}</b>` : ""}${p.note ? `<div class="vol-pop-nota">${escapeHtml(p.note)}</div>` : ""}</td>
          <td><span class="vols-esito ${p.stato}">${ESITI[p.stato]}</span>${p.motivo_rifiuto ? `<div class="vol-pop-nota">${escapeHtml(p.motivo_rifiuto)}</div>` : ""}${p.nota_master ? `<div class="vol-pop-nota">${escapeHtml(p.nota_master)}</div>` : ""}</td>
        </tr>`).join("")}</tbody>
    </table>` : `<div class="storico-empty">${ric.inviata_at ? "La Sezione ha inviato senza modifiche." : "Nessuna proposta."}</div>`}`;
}

/* =====================================================================
   EXCEL: genera e ricarica
   ===================================================================== */
async function volsGeneraExcel(ric){
  const ExcelJS = await volsCaricaExcelJS();
  const req = volsRequisitiDi(ric);
  const vols = _vol.volontari.filter(v => v.sezione === ric.sezione && v.stato === "ATTIVO")
    .sort((a, b) => a.cognome.localeCompare(b.cognome, "it") || a.nome.localeCompare(b.nome, "it"));

  // colonne: chiave (riletta al caricamento), titolo, larghezza, modificabile, tipo
  const cols = [
    { k:"id", t:"ID", w:10 }, { k:"cognome", t:"Cognome", w:20 }, { k:"nome", t:"Nome", w:18 }, { k:"gruppo", t:"Gruppo", w:16 },
  ];
  req.forEach(r => {
    cols.push({ k:`s_${r.id}`, t:`${r.nome}\nsituazione attuale`, w:26 });
    cols.push({ k:`b_${r.id}`, t:`${r.nome}\nData base`, w:14, mod:true, data:true });
    if (r.prevede_aggiornamento) cols.push({ k:`a_${r.id}`, t:`${r.nome}\nData aggiornamento`, w:16, mod:true, data:true });
  });
  cols.push({ k:"note", t:"Note", w:40, mod:true });

  const wb = new ExcelJS.Workbook();
  wb.creator = "Polo Logistico 1° RGPT/CAP Vercelli";
  wb.created = new Date();
  const ws = wb.addWorksheet(VOLS_FOGLIO, { views:[{ state:"frozen", xSplit:4, ySplit:1 }] });
  ws.columns = cols.map(c => ({ header:c.t, key:c.k, width:c.w }));
  ws.getColumn(1).hidden = true;
  const testa = ws.getRow(1);
  testa.height = 42;
  testa.eachCell((cella, n) => {
    const mod = cols[n - 1].mod;
    cella.font = { bold:true, color:{ argb: mod ? "FF0B2545" : "FFFFFFFF" } };
    cella.alignment = { vertical:"middle", horizontal:"center", wrapText:true };
    cella.fill = { type:"pattern", pattern:"solid", fgColor:{ argb: mod ? "FFFDF3DA" : "FF1D4E89" } };
  });

  vols.forEach(v => {
    const valori = cols.map(c => {
      if (c.k === "id") return v.id;
      if (c.k === "cognome" || c.k === "nome") return v[c.k];
      if (c.k === "gruppo") return v.gruppo || "";
      if (c.k === "note") return "";
      const rid = Number(c.k.slice(2));
      const s = _vol.stato.get(volChiave(v.id, rid));
      if (c.k.startsWith("s_")){
        if (!s) return "Mancante";
        return [VOL_STATI_REQ[s.stato].replace(/ \(.*\)/, ""), s.data_scadenza ? "scade " + formatDataIt(s.data_scadenza) : ""].filter(Boolean).join(" · ");
      }
      const iso = c.k.startsWith("b_") ? s?.data_base : s?.ultimo_aggiornamento;
      return iso ? volsDateUtc(iso) : null;
    });
    ws.addRow(valori);
  });

  const ultima = vols.length + 1;
  for (let r = 2; r <= ultima; r++){
    cols.forEach((c, i) => {
      const cella = ws.getRow(r).getCell(i + 1);
      if (c.mod){
        cella.protection = { locked:false };
        cella.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFFFFDF5" } };
      } else {
        cella.font = { color:{ argb:"FF3D4452" } };
      }
      if (c.data){
        cella.numFmt = "dd/mm/yyyy";
        cella.alignment = { horizontal:"center" };
        cella.dataValidation = {
          type:"date", operator:"between", allowBlank:true, showErrorMessage:true,
          formulae:[new Date(Date.UTC(1950, 0, 1)), new Date(Date.UTC(2100, 0, 1))],
          errorTitle:"Data non valida", error:"Scrivi una data nel formato gg/mm/aaaa (es. 15/03/2024)."
        };
      }
      if (c.k === "note") cella.alignment = { wrapText:true, vertical:"top" };
    });
  }
  await ws.protect("", { selectLockedCells:true, selectUnlockedCells:true, formatColumns:true, formatRows:true });

  // Segnalazioni
  const sg = wb.addWorksheet("Segnalazioni");
  sg.columns = [{ header:"Segnalazione (volontari mancanti, non più attivi, altro)", key:"t", width:110 }];
  sg.getRow(1).font = { bold:true, color:{ argb:"FFFFFFFF" } };
  sg.getRow(1).getCell(1).fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF1D4E89" } };
  for (let r = 2; r <= VOLS_SEGNALAZIONI_RIGHE + 1; r++){
    const cella = sg.getRow(r).getCell(1);
    cella.protection = { locked:false };
    cella.alignment = { wrapText:true };
  }
  await sg.protect("", { selectLockedCells:true, selectUnlockedCells:true, formatRows:true });

  // Istruzioni (+ chi compila, in B3 / B4)
  const ist = wb.addWorksheet("Istruzioni");
  ist.getColumn(1).width = 34;
  ist.getColumn(2).width = 80;
  const righe = [
    ["Aggiornamento corsi e abilitazioni – 1° Raggruppamento", ""],
    ["Sezione", ric.sezione],
    ["Compilato da (nome e cognome)", ""],
    ["Ruolo nella Sezione", ""],
    ["Da rimandare entro il", formatDataIt(ric.scadenza.slice(0, 10))],
    ["", ""],
    ["Come compilare", ""],
    ["", "• Nel foglio \"Volontari\" trovate i volontari attivi della Sezione e la situazione che risulta al Polo Logistico."],
    ["", "• Compilate solo le colonne gialle: \"Data base\" (corso completo) e, dove c'è, \"Data aggiornamento\" (ultimo corso di aggiornamento)."],
    ["", "• Le date già presenti sono quelle che risultano a noi: correggetele solo se sono sbagliate. Le date si scrivono gg/mm/aaaa."],
    ["", "• Per dubbi o correzioni su un volontario scrivete nella colonna \"Note\"."],
    ["", "• Volontari mancanti o non più attivi: scriveteli nel foglio \"Segnalazioni\" (una riga ciascuno)."],
    ["", "• Non aggiungete righe o colonne e non cambiate l'ordine: il file viene riletto in automatico."],
    ["", "• Compilate le celle \"Compilato da\" e \"Ruolo\" qui sopra, salvate e rimandate il file al Polo Logistico."],
    ["", "Le date inviate vengono controllate dal Polo Logistico prima di essere registrate."],
  ];
  righe.forEach(([a, b], i) => {
    const r = ist.addRow([a, b]);
    r.getCell(2).alignment = { wrapText:true, vertical:"top" };
    if (i === 0 || a === "Come compilare") r.font = { bold:true, size:12 };
    else if (a) r.getCell(1).font = { bold:true };
  });
  [3, 4].forEach(n => {
    const c = ist.getRow(n).getCell(2);
    c.protection = { locked:false };
    c.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFFDF3DA" } };
    c.border = { bottom:{ style:"thin", color:{ argb:"FFB8860B" } } };
  });
  await ist.protect("", { selectLockedCells:true, selectUnlockedCells:true });
  wb.views = [{ activeTab: 0 }];

  // Foglio nascosto: id richiesta, Sezione e chiavi delle colonne (per rileggere il file con certezza)
  const nasc = wb.addWorksheet(VOLS_FOGLIO_RIC, { state:"veryHidden" });
  nasc.addRow(["VOL_RICHIESTA", ric.id]);
  nasc.addRow(["SEZIONE", ric.sezione]);
  nasc.addRow(["COLONNE"]);
  nasc.addRow(cols.map(c => c.k));

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `Corsi_${ric.sezione.replace(/[^a-zA-Z0-9]+/g, "_")}_richiesta_${ric.id}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function volsScegliFileExcel(ric){
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".xlsx";
  inp.addEventListener("change", () => { if (inp.files[0]) volsLeggiExcel(inp.files[0], ric).catch(e => alert("Non riesco a leggere il file: " + e.message)); });
  inp.click();
}

function volsTestoCella(cella){
  const v = cella?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object"){
    if (v instanceof Date) return v;
    if (v.richText) return v.richText.map(t => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return v.result;
  }
  return v;
}

// Data da cella Excel → "yyyy-mm-dd" | "" (vuota) | null (non valida)
function volsDataDaCella(v){
  if (v === "" || v === null || v === undefined) return "";
  let iso = null;
  if (v instanceof Date && !isNaN(v)) iso = volsIsoDaDate(v);
  else if (typeof v === "number" && v > 0) iso = volsIsoDaDate(new Date(Math.round((v - 25569) * 86400000)));
  else {
    const t = String(v).trim();
    let m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
    if (m) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) iso = t;
    if (iso){
      const d = volsDateUtc(iso);
      if (isNaN(d) || volsIsoDaDate(d) !== iso) iso = null; // es. 31/02
    }
  }
  if (!iso) return null;
  if (iso < "1950-01-01" || iso > new Date().toISOString().slice(0, 10)) return null;
  return iso;
}

async function volsLeggiExcel(file, ric){
  const ExcelJS = await volsCaricaExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const nasc = wb.getWorksheet(VOLS_FOGLIO_RIC);
  const ws = wb.getWorksheet(VOLS_FOGLIO);
  if (!nasc || !ws || volsTestoCella(nasc.getCell("A1")) !== "VOL_RICHIESTA"){
    alert("File non riconosciuto: usa l'Excel generato da questa pagina (Genera Excel).");
    return;
  }
  const idFile = Number(volsTestoCella(nasc.getCell("B1")));
  if (idFile !== ric.id){
    alert(`Questo file appartiene alla richiesta n. ${idFile}, non alla n. ${ric.id} (${ric.sezione}). Usa "Carica Excel compilato" sulla riga giusta.`);
    return;
  }
  // stato aggiornato della richiesta
  const { data: aggiornata, error: errR } = await sb.from("vol_richieste_sezione").select(VOLS_COLONNE_RIC).eq("id", ric.id).maybeSingle();
  if (errR || !aggiornata){ alert("Richiesta non trovata."); return; }
  if (aggiornata.stato !== "APERTA"){ alert(`La richiesta è "${VOLS_STATI_RIC[aggiornata.stato]}": non si può più caricare.`); return; }
  if (volsScaduta(aggiornata)){ alert("La richiesta è scaduta: prorogala prima di caricare il file."); return; }
  if (String(volsTestoCella(nasc.getCell("B2"))) !== ric.sezione){ alert("La Sezione del file non corrisponde alla richiesta."); return; }

  const chiavi = [];
  nasc.getRow(4).eachCell({ includeEmpty:true }, (c, n) => { chiavi[n - 1] = String(volsTestoCella(c)); });
  const idx = k => chiavi.indexOf(k) + 1;
  if (!idx("id")){ alert("Il file è stato modificato nella struttura e non si può rileggere."); return; }

  const req = volsRequisitiDi(ric);
  const ammessi = new Map(_vol.volontari.filter(v => v.sezione === ric.sezione && v.stato === "ATTIVO").map(v => [v.id, v]));
  const errori = [], cambi = [], note = [], avvisi = [];
  const righe = new Map(); // vid → { volontario_id, note, requisiti:[] }

  ws.eachRow({ includeEmpty:false }, (row, n) => {
    if (n === 1) return;
    const vid = String(volsTestoCella(row.getCell(idx("id"))) || "").trim();
    const nome = `${volsTestoCella(row.getCell(idx("cognome")))} ${volsTestoCella(row.getCell(idx("nome")))}`.trim();
    if (!vid && !nome) return;
    const v = ammessi.get(vid);
    if (!v){ errori.push(`Riga ${n} (${nome || "senza nome"}): volontario non riconosciuto o non più attivo nella Sezione.`); return; }
    const voce = { volontario_id: v.id, note:"", requisiti:[] };
    req.forEach(r => {
      const s = _vol.stato.get(volChiave(v.id, r.id));
      const prova = (k, attuale, etichetta, campo) => {
        if (!idx(k)) return null;
        const d = volsDataDaCella(volsTestoCella(row.getCell(idx(k))));
        if (d === null){ errori.push(`Riga ${n} (${nome}): "${r.nome} – ${etichetta}" non è una data valida (gg/mm/aaaa, non nel futuro, non prima del 1950).`); return null; }
        if (d === "" && attuale){ avvisi.push(`${nome}: cancellata la data ${etichetta.toLowerCase()} di "${r.nome}" (le cancellazioni non vengono registrate: usare le note).`); return null; }
        if (d && d !== attuale){
          cambi.push({ nome, req:r.nome, tipo:etichetta, prima:attuale, dopo:d });
          return d;
        }
        return null;
      };
      const b = prova(`b_${r.id}`, s?.data_base || "", "Base");
      const a = r.prevede_aggiornamento ? prova(`a_${r.id}`, s?.ultimo_aggiornamento || "", "Aggiornamento") : null;
      if (b || a) voce.requisiti.push({ requisito_id: r.id, data_base: b, data_agg: a });
    });
    const nota = idx("note") ? String(volsTestoCella(row.getCell(idx("note"))) || "").trim().slice(0, 500) : "";
    if (nota){ voce.note = nota; note.push({ nome, nota }); }
    if (voce.requisiti.length || voce.note) righe.set(v.id, voce);
  });

  const segnalazioni = [];
  const sg = wb.getWorksheet("Segnalazioni");
  if (sg) sg.eachRow({ includeEmpty:false }, (row, n) => {
    if (n === 1) return;
    const t = String(volsTestoCella(row.getCell(1)) || "").trim();
    if (t) segnalazioni.push({ testo: t.slice(0, 500) });
  });
  const ist = wb.getWorksheet("Istruzioni");
  const compilatore = ist ? String(volsTestoCella(ist.getCell("B3")) || "").trim() : "";
  const ruolo = ist ? String(volsTestoCella(ist.getCell("B4")) || "").trim() : "";

  volsAnteprimaExcel(ric, { errori, avvisi, cambi, note, segnalazioni, righe:[...righe.values()], compilatore, ruolo });
}

function volsAnteprimaExcel(ric, e){
  const body = volsApriModal(`Excel compilato – ${ric.sezione}`);
  const d = x => x ? formatDataIt(x) : "—";
  body.innerHTML = `
    <div class="vol-imp-riep">
      <span><b>${e.cambi.length}</b> date nuove o cambiate</span><span><b>${e.note.length}</b> note</span>
      <span><b>${e.segnalazioni.length}</b> segnalazioni</span><span><b>${e.errori.length}</b> errori</span>
    </div>
    ${e.errori.length ? `<details class="vol-imp-gruppo errore" open><summary><b>${e.errori.length}</b> errori da correggere nel file (poi ricaricalo)</summary>
      <ul class="vols-elenco">${e.errori.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></details>` : ""}
    ${e.avvisi.length ? `<details class="vol-imp-gruppo attenzione"><summary><b>${e.avvisi.length}</b> avvisi</summary>
      <ul class="vols-elenco">${e.avvisi.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></details>` : ""}
    ${e.cambi.length ? `<details class="vol-imp-gruppo" open><summary><b>${e.cambi.length}</b> proposte di date</summary>
      <table class="storico-table"><thead><tr><th>Volontario</th><th>Corso</th><th>Tipo</th><th>Attuale → proposto</th></tr></thead>
      <tbody>${e.cambi.map(c => `<tr><td>${escapeHtml(c.nome)}</td><td>${escapeHtml(c.req)}</td><td>${c.tipo}</td><td>${d(c.prima)} → <b>${d(c.dopo)}</b></td></tr>`).join("")}</tbody></table></details>` : ""}
    ${e.note.length ? `<details class="vol-imp-gruppo"><summary><b>${e.note.length}</b> note</summary>
      <ul class="vols-elenco">${e.note.map(n => `<li><b>${escapeHtml(n.nome)}</b>: ${escapeHtml(n.nota)}</li>`).join("")}</ul></details>` : ""}
    ${e.segnalazioni.length ? `<details class="vol-imp-gruppo"><summary><b>${e.segnalazioni.length}</b> segnalazioni</summary>
      <ul class="vols-elenco">${e.segnalazioni.map(s => `<li>${escapeHtml(s.testo)}</li>`).join("")}</ul></details>` : ""}
    <div class="form-grid" style="margin-top:12px;">
      <div class="form-field"><label>Compilato da *</label><input id="vols-x-nome" maxlength="100" value="${escapeHtml(e.compilatore)}"></div>
      <div class="form-field"><label>Ruolo</label><input id="vols-x-ruolo" maxlength="100" value="${escapeHtml(e.ruolo)}"></div>
    </div>
    <p class="vol-legenda">Confermando, le date diventano proposte nella scheda <b>Da validare</b> e la richiesta passa a "Da validare". Nulla viene registrato finché non approvi.</p>
    <div class="form-actions">
      <button type="button" class="btn-cancel" onclick="chiudiModal()">Annulla</button>
      <button type="button" class="btn-save" id="vols-x-conferma" ${e.errori.length ? "disabled title=\"Correggi prima gli errori\"" : ""}>Conferma caricamento</button>
    </div>`;
  const btn = body.querySelector("#vols-x-conferma");
  btn.addEventListener("click", async () => {
    const nome = body.querySelector("#vols-x-nome").value.trim();
    if (!nome){ alert("Indica chi ha compilato il file."); return; }
    if (!e.cambi.length && !e.note.length && !e.segnalazioni.length &&
        !confirm("Il file non contiene modifiche. Chiudere la richiesta come \"nessuna modifica\"?")) return;
    btn.disabled = true;
    const { data, error } = await sb.rpc("vol_richiesta_carica", {
      p_id: ric.id, p_righe: e.righe, p_segn: e.segnalazioni, p_nome: nome, p_ruolo: body.querySelector("#vols-x-ruolo").value.trim() || null
    });
    if (error){ btn.disabled = false; alert("Caricamento non riuscito, nessun dato modificato.\n\n" + error.message); return; }
    chiudiModal();
    alert(data ? `${data} proposte inviate nella scheda Da validare.` : "Nessuna modifica: richiesta chiusa.");
    volsAggiornaBadge();
    volAggiornaVista();
  });
}

/* =====================================================================
   SCHEDA "DA VALIDARE"
   ===================================================================== */
async function volsRenderDaValidare(box){
  box.innerHTML = `<div class="loading-spin">Caricamento…</div>`;
  const { data: prop, error } = await sb.from("vol_proposte").select(VOLS_COLONNE_PROP).eq("stato", "IN_ATTESA").order("id");
  if (_vol.vista !== "validare") return;
  if (error){ box.innerHTML = `<div class="storico-empty">Errore: ${escapeHtml(error.message)}</div>`; return; }
  const ids = [...new Set((prop || []).map(p => p.richiesta_id))];
  let richieste = [];
  if (ids.length){
    const { data, error: errR } = await sb.from("vol_richieste_sezione").select(VOLS_COLONNE_RIC).in("id", ids);
    if (errR){ box.innerHTML = `<div class="storico-empty">Errore: ${escapeHtml(errR.message)}</div>`; return; }
    richieste = data || [];
  }
  volsAggiornaBadge();
  if (!prop || !prop.length){
    box.innerHTML = `<div class="storico-empty">Niente da validare. Le risposte delle Sezioni compariranno qui.</div>`;
    return;
  }
  const reqNome = id => _vol.requisiti.find(r => r.id === id)?.nome || "";
  const d = x => x ? formatDataIt(x) : "—";

  box.innerHTML = richieste.sort((a, b) => String(a.inviata_at).localeCompare(String(b.inviata_at))).map(ric => {
    const mie = prop.filter(p => p.richiesta_id === ric.id);
    const eventi = mie.filter(p => p.tipo_proposta === "EVENTO");
    const segn = mie.filter(p => p.tipo_proposta === "SEGNALAZIONE");
    return `
      <div class="vols-gruppo">
        <div class="vols-gruppo-t">
          <div><b>${escapeHtml(ric.sezione)}</b> · ${ric.canale === "LINK" ? "link" : "Excel"} · inviata ${volsDataOra(ric.inviata_at)}
            ${ric.compilatore_nome ? ` da <b>${escapeHtml(ric.compilatore_nome)}</b>${ric.compilatore_ruolo ? " (" + escapeHtml(ric.compilatore_ruolo) + ")" : ""}` : ""}</div>
          ${eventi.length > 1 ? `<button type="button" class="btn-add-mini" data-tutte="${ric.id}">Approva tutte (${eventi.length})</button>` : ""}
        </div>
        ${eventi.length ? `
        <table class="storico-table">
          <thead><tr><th>Volontario</th><th>Corso</th><th>Tipo</th><th>Attuale → proposto</th><th>Note</th><th></th></tr></thead>
          <tbody>${eventi.map(p => `
            <tr>
              <td>${escapeHtml(volsNomeVolontario(p.volontario_id))}</td>
              <td>${escapeHtml(reqNome(p.requisito_id))}</td>
              <td>${p.tipo_evento === "BASE" ? "Base" : "Aggiornamento"}</td>
              <td>${d(p.valore_attuale)} → <b>${d(p.data)}</b></td>
              <td>${escapeHtml(p.note || "")}</td>
              <td class="vols-azioni">
                <button type="button" class="btn-add-mini vols-ok" data-approva="${p.id}">Approva</button>
                <button type="button" class="row-del" data-rifiuta="${p.id}">Rifiuta</button>
              </td>
            </tr>`).join("")}</tbody>
        </table>` : ""}
        ${segn.length ? `
        <div class="vols-segn-t">Segnalazioni</div>
        <table class="storico-table">
          <tbody>${segn.map(p => `
            <tr>
              <td style="width:28%;">${p.volontario_id ? escapeHtml(volsNomeVolontario(p.volontario_id)) : "<i>generale</i>"}</td>
              <td>${escapeHtml(p.note || "")}</td>
              <td class="vols-azioni"><button type="button" class="btn-add-mini" data-gestita="${p.id}">Segna gestita</button></td>
            </tr>`).join("")}</tbody>
        </table>
        <p class="vol-legenda">Le segnalazioni non modificano l'anagrafica, che si aggiorna solo con l'import dal PIA.</p>` : ""}
      </div>`;
  }).join("");

  const esegui = async (id, esito, nota, btn) => {
    btn.disabled = true;
    const { error: errV } = await sb.rpc("vol_valida_proposta", { p_id: id, p_esito: esito, p_nota: nota });
    if (errV){ btn.disabled = false; alert("Errore: " + errV.message); return; }
    const p = prop.find(x => x.id === id);
    if (esito === "APPROVA" && p?.volontario_id) await volRicaricaStatoVolontario(p.volontario_id);
    volsRenderDaValidare(box);
  };
  box.querySelectorAll("[data-approva]").forEach(b => b.addEventListener("click", () => esegui(Number(b.dataset.approva), "APPROVA", null, b)));
  box.querySelectorAll("[data-rifiuta]").forEach(b => b.addEventListener("click", () => {
    const motivo = prompt("Motivo del rifiuto (resta nello storico della richiesta):");
    if (!motivo || !motivo.trim()) return;
    esegui(Number(b.dataset.rifiuta), "RIFIUTA", motivo.trim(), b);
  }));
  box.querySelectorAll("[data-gestita]").forEach(b => b.addEventListener("click", () => {
    const nota = prompt("Come è stata gestita? (facoltativo)", "");
    if (nota === null) return;
    esegui(Number(b.dataset.gestita), "GESTITA", nota.trim() || null, b);
  }));
  box.querySelectorAll("[data-tutte]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Approvare tutte le date proposte da questa Sezione? Le segnalazioni restano da gestire.")) return;
    b.disabled = true;
    const { data, error: errT } = await sb.rpc("vol_approva_tutte", { p_richiesta: Number(b.dataset.tutte) });
    if (errT){ b.disabled = false; alert("Errore: " + errT.message); return; }
    const err = await volCaricaDati();
    if (err) alert(`${data} proposte approvate, ma errore nel ricaricare i dati: ${err}`);
    volsRenderDaValidare(box);
  }));
}
