/* =====================================================================
   MODULO VOLONTARI – anagrafica 1° RGPT (dal PIA ANA), corsi e abilitazioni
   ---------------------------------------------------------------------
   Caricato da index.html: usa le funzioni comuni definite lì (sb, state,
   escapeHtml, chiudiModal, livelloPermesso, caricaTutteLeRighe, cfValido,
   formatDataIt, attaccaListenerApriFile, STORAGE_BUCKET_DOC_VOLONTARI).
   Tabelle: vol_sezioni, vol_volontari (vista vol_volontari_v con la Regione),
   vol_requisiti, vol_eventi_requisito (storico BASE / AGGIORNAMENTO, mai
   cancellato: si annulla con vol_annulla_evento), vista vol_stato_requisiti
   (VALIDO / IN_SCADENZA / DA_AGGIORNARE / SCADUTO / ANOMALIA; nessuna riga =
   MANCANTE), RPC vol_eventi_f (storico con gli eventi della Scuola),
   vol_import_log; import tramite RPC vol_importa.
   SQL: sql/volontari_schema.sql + sql/volontari_v2.sql.
   Richieste alle Sezioni e validazione: volontari-sezioni.js.
   L'anagrafica è in sola lettura: cambia solo con "Importa da PIA".
   I dati si caricano una volta; filtri, ordinamento e riepilogo sono locali.
   ===================================================================== */

const VOL_REGIONI = ["PIEMONTE", "LIGURIA", "VALLE D'AOSTA"];
const VOL_AMBITI = [
  { k:"CAP",  label:"CAP",     sub:"Piemonte",                     regioni:["PIEMONTE"] },
  { k:"CAL",  label:"CAL",     sub:"Liguria",                      regioni:["LIGURIA"] },
  { k:"RGPT", label:"1° RGPT", sub:"Piemonte, Liguria, Valle d'Aosta", regioni:VOL_REGIONI },
];
const VOL_STATI = { ATTIVO:"Attivo", NON_IN_PIA:"Non in PIA", DIMESSO:"Dimesso" };
// stato di un requisito (vista vol_stato_requisiti); nessuna riga = MANCANTE
const VOL_STATI_REQ = {
  VALIDO:"Valido", IN_SCADENZA:"In scadenza", DA_AGGIORNARE:"Da aggiornare",
  SCADUTO:"Scaduto", ANOMALIA:"Anomalia (aggiornamento senza base)", MANCANTE:"Mancante"
};
const VOL_ORIGINI = { MANUALE:"Manuale", SCUOLA:"Scuola di Formazione", SEZIONE_LINK:"Sezione (link)", SEZIONE_EXCEL:"Sezione (Excel)" };
const VOL_COLONNE_STATO = "volontario_id, requisito_id, data_base, ultimo_aggiornamento, data, data_scadenza, origine, origine_base, origine_aggiornamento, stato, documento_path, edizione";
const VOL_COLONNE_SELECT = "id, cf, cognome, nome, data_nascita, sesso, sezione, regione, ordine_sezione, gruppo, squadra, matricola_gisa, matricola_vola, stato, da_verificare, ultimo_import";
const VOL_INTESTAZIONE_PIA = ["SEZIONE","MAT_GISA","MAT_VOLA","COGNOME_NOME","CF","GRUPPO","SQUADRA","OBSOLETO"];
const VOL_CAMPI_IMPORT = [
  { k:"SEZIONE",      label:"Sezione",                    re:/^SEZ/ },
  { k:"MAT_GISA",     label:"Matricola GISA",             re:/GISA/ },
  { k:"MAT_VOLA",     label:"Matricola VOLA",             re:/VOLA/ },
  { k:"COGNOME_NOME", label:"Cognome e nome (insieme)",   re:/COGNOME_?NOME|NOMINATIVO/ },
  { k:"COGNOME",      label:"Cognome (da solo)",          re:/^COGNOME$/ },
  { k:"NOME",         label:"Nome (da solo)",             re:/^NOME$/ },
  { k:"CF",           label:"Codice fiscale",             re:/^CF$|^C_F$|CODICE_?FISCALE/ },
  { k:"GRUPPO",       label:"Gruppo",                     re:/GRUPPO/ },
  { k:"SQUADRA",      label:"Squadra",                    re:/SQUADRA/ },
  { k:"OBSOLETO",     label:"Obsoleto (SI = dimesso)",    re:/OBSOLET|DIMESS/ },
];
// Bookmarklet "Copia da PIA" (da non modificare: legge la tabella Schede Volontari del PIA)
const VOL_BOOKMARKLET = String.raw`javascript:(()=>{const g=document.getElementById('gvCustomers');if(!g){alert('Apri PIA > Schede Volontari');return}if(document.querySelector('a[href*="Page$"]')&&!confirm('Ci sono altre pagine: imposta Righe = TUTTE e premi Filtra. Copiare comunque solo questa pagina?'))return;const out=['SEZIONE\tMAT_GISA\tMAT_VOLA\tCOGNOME_NOME\tCF\tGRUPPO\tSQUADRA\tOBSOLETO'];let n=0;[...g.rows].slice(1).forEach(r=>{if(r.cells.length<9)return;const c=[...r.cells].slice(1,9).map(x=>x.innerText.replace(/\s+/g,' ').trim());if(!/^[A-Z0-9]{16}$/i.test(c[4]))return;out.push(c.join('\t'));n++});navigator.clipboard.writeText(out.join('\n')).then(()=>alert(n+' volontari copiati. Incollali in Polo Logistico > Volontari > Importa da PIA'))})();`;

let _vol = { volontari:[], perId:new Map(), sezioni:[], requisiti:[], stato:new Map(), vista:"elenco" };
let _volFiltro = volFiltroIniziale();
let _volOrdine = { col:"cognome", dir:1 };
let _volImport = null;
let _volCatalogoCorsi = null;
let _volListenerDocumento = false;

function volFiltroIniziale(){
  return { regioni:[...VOL_REGIONI], sezioni:[], etaDa:"", etaA:"", stato:"ATTIVO", daVerificare:false, q:"", req:{} };
}

/* ---------- Permessi (solo interfaccia: il vero controllo è la RLS) ---------- */
function volPuoModificare(){ return livelloPermesso("volontari") === "completo"; }
function volGestore(){
  if (state.profile.ruolo === "it_admin") return true;
  return volPuoModificare() && !Array.isArray(state.profile.permessi?.volontari_sezioni);
}

/* ---------- Utility ---------- */
function volNorm(s){
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}
function volEta(dataIso){
  if (!dataIso) return null;
  const [a, m, g] = dataIso.split("-").map(Number);
  const oggi = new Date();
  let eta = oggi.getFullYear() - a;
  if (oggi.getMonth() + 1 < m || (oggi.getMonth() + 1 === m && oggi.getDate() < g)) eta--;
  return eta;
}
function volChiave(vid, rid){ return vid + "|" + rid; }
function volRequisitiAttivi(){ return _vol.requisiti.filter(r => r.attivo); }
function volStatoReq(vid, rid){ const s = _vol.stato.get(volChiave(vid, rid)); return s ? s.stato : "MANCANTE"; }

// Carica a blocchi di 1000 righe una query già ordinata (per le viste senza colonna id)
async function volCaricaPaginato(creaQuery){
  const BLOCCO = 1000;
  let tutte = [];
  for (let da = 0; ; da += BLOCCO){
    const { data, error } = await creaQuery().range(da, da + BLOCCO - 1);
    if (error) return { data:null, error };
    tutte = tutte.concat(data || []);
    if (!data || data.length < BLOCCO) break;
  }
  return { data:tutte, error:null };
}

/* ---------- Codice fiscale: separazione cognome / nome ---------- */
function volLettere(s){ return volNorm(s).replace(/[^A-Z]/g, ""); }
function volCodiceCognome(s){
  const l = volLettere(s);
  const cons = l.replace(/[AEIOU]/g, ""), voc = l.replace(/[^AEIOU]/g, "");
  return (cons + voc + "XXX").slice(0, 3);
}
function volCodiceNome(s){
  const l = volLettere(s);
  const cons = l.replace(/[AEIOU]/g, ""), voc = l.replace(/[^AEIOU]/g, "");
  if (cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + voc + "XXX").slice(0, 3);
}
// "DE LUCA MARIO ANTONIO" + CF → { cognome:"DE LUCA", nome:"MARIO ANTONIO", certo:true }
function volSeparaNome(completo, cf){
  const parole = volNorm(completo).replace(/[’`]/g, "'").split(" ").filter(Boolean);
  if (parole.length < 2) return { cognome: parole.join(" "), nome:"", certo:false };
  const obiettivo = String(cf || "").toUpperCase().slice(0, 6);
  const trovate = [];
  for (let i = 1; i < parole.length; i++){
    const cognome = parole.slice(0, i).join(" "), nome = parole.slice(i).join(" ");
    if (volCodiceCognome(cognome) + volCodiceNome(nome) === obiettivo) trovate.push({ cognome, nome });
  }
  if (trovate.length === 1) return { ...trovate[0], certo:true };
  if (trovate.length > 1) return { ...trovate[0], certo:false }; // più separazioni possibili
  return { cognome: parole[0], nome: parole.slice(1).join(" "), certo:false };
}

/* =====================================================================
   PAGINA
   ===================================================================== */
async function renderVolontari(){
  const content = document.getElementById("page-content");
  const errore = await volCaricaDati();
  if (errore){
    content.innerHTML = `<div class="placeholder-page"><h3>Errore</h3><p>${escapeHtml(errore)}</p></div>`;
    return;
  }
  volDisegnaPagina();
}

async function volCaricaDati(){
  const [rv, rs, rr, rst] = await Promise.all([
    caricaTutteLeRighe(() => sb.from("vol_volontari_v").select(VOL_COLONNE_SELECT)),
    sb.from("vol_sezioni").select("sezione, regione, ordine").order("ordine"),
    sb.from("vol_requisiti").select("*").order("ordine").order("id"),
    volCaricaPaginato(() => sb.from("vol_stato_requisiti")
      .select(VOL_COLONNE_STATO)
      .order("volontario_id").order("requisito_id"))
  ]);
  const err = rv.error || rs.error || rr.error || rst.error;
  if (err) return err.message;
  _vol.volontari = (rv.data || []).map(volPreparaVolontario);
  _vol.perId = new Map(_vol.volontari.map(v => [v.id, v]));
  _vol.sezioni = rs.data || [];
  _vol.requisiti = rr.data || [];
  _vol.stato = new Map((rst.data || []).map(s => [volChiave(s.volontario_id, s.requisito_id), s]));
  return null;
}

function volPreparaVolontario(v){
  return { ...v, eta: volEta(v.data_nascita), _cerca: volNorm(`${v.cognome} ${v.nome} ${v.cognome} ${v.cf}`) };
}

function volDisegnaPagina(){
  const content = document.getElementById("page-content");
  if (!content || state.route !== "volontari") return;
  const req = volRequisitiAttivi();
  const nReqFiltri = Object.values(_volFiltro.req).filter(Boolean).length;

  content.innerHTML = `
    <div class="vol-ambiti" role="group" aria-label="Ambito">
      <span class="vol-ambiti-lbl">Ambito</span>
      ${VOL_AMBITI.map(a => `<button type="button" class="vol-ambito" data-ambito="${a.k}" title="${escapeHtml(a.sub)}">${a.label}<small>${escapeHtml(a.sub)}</small></button>`).join("")}
    </div>

    <div class="toolbar">
      <input type="search" id="vol-q" placeholder="Cerca per nome o codice fiscale…" value="${escapeHtml(_volFiltro.q)}">
      <div id="vol-ms-regioni"></div>
      <div id="vol-ms-sezioni"></div>
      <span class="vol-eta">Età <input type="number" id="vol-eta-da" min="0" max="120" placeholder="da" value="${escapeHtml(_volFiltro.etaDa)}">
        <input type="number" id="vol-eta-a" min="0" max="120" placeholder="a" value="${escapeHtml(_volFiltro.etaA)}"></span>
      <select id="vol-stato">
        <option value="">Tutti gli stati</option>
        ${Object.entries(VOL_STATI).map(([k, l]) => `<option value="${k}" ${_volFiltro.stato === k ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <label class="vol-check"><input type="checkbox" id="vol-dav" ${_volFiltro.daVerificare ? "checked" : ""}> Da verificare</label>
      ${req.length ? `<button type="button" class="btn-add" id="vol-btn-filtri-req" style="background:var(--grigio-800);"><i class="ti ti-filter" aria-hidden="true"></i> Corsi e abilitazioni${nReqFiltri ? ` (${nReqFiltri})` : ""}</button>` : ""}
      <button type="button" class="btn-add" id="vol-azzera" style="background:var(--grigio-600);">Azzera filtri</button>
    </div>
    <div class="vol-req-filtri" id="vol-req-filtri" hidden>
      ${req.map(r => `
        <label>${escapeHtml(r.nome)}
          <select data-filtro-req="${r.id}">
            <option value="">indifferente</option>
            ${[["REGOLA","in regola (valido o in scadenza)"], ["VALIDO","valido"], ["IN_SCADENZA","in scadenza"],
               ...(r.prevede_aggiornamento ? [["DA_AGGIORNARE","da aggiornare"]] : []),
               ["SCADUTO","scaduto"], ["MANCANTE","mancante"], ["NON_REGOLA","non in regola"], ["ANOMALIA","anomalia"]]
              .map(([k, l]) => `<option value="${k}" ${_volFiltro.req[r.id] === k ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>`).join("")}
    </div>

    <div class="vol-azioni">
      <div class="modal-tabs vol-tabs">
        <span class="modal-tab ${_vol.vista === "elenco" ? "active" : ""}" data-vista="elenco">Elenco</span>
        <span class="modal-tab ${_vol.vista === "riepilogo" ? "active" : ""}" data-vista="riepilogo">Riepilogo</span>
        ${volGestore() ? `
        <span class="modal-tab ${_vol.vista === "richieste" ? "active" : ""}" data-vista="richieste">Richieste alle Sezioni</span>
        <span class="modal-tab ${_vol.vista === "validare" ? "active" : ""}" data-vista="validare">Da validare <span class="vol-tab-badge" id="vol-badge-validare" hidden></span></span>` : ""}
      </div>
      <span class="vol-sp"></span>
      <button type="button" class="btn-add-mini" id="vol-btn-excel"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Esporta Excel</button>
      ${volPuoModificare() ? `<button type="button" class="btn-add-mini" id="vol-btn-import"><i class="ti ti-download" aria-hidden="true"></i> Importa da PIA</button>` : ""}
      ${volGestore() ? `<button type="button" class="btn-add-mini" id="vol-btn-requisiti" style="background:var(--grigio-800);"><i class="ti ti-settings" aria-hidden="true"></i> Corsi e abilitazioni</button>` : ""}
    </div>
    <div class="results-count" id="vol-count"></div>
    <div id="vol-vista"></div>
  `;

  volAggiornaFiltriDipendenti();

  content.querySelectorAll("[data-ambito]").forEach(b => b.addEventListener("click", () => {
    const a = VOL_AMBITI.find(x => x.k === b.dataset.ambito);
    _volFiltro.regioni = [...a.regioni];
    volAggiornaFiltriDipendenti();
    volAggiornaVista();
  }));
  const qInput = document.getElementById("vol-q");
  let timer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { _volFiltro.q = qInput.value; volAggiornaVista(); }, 150);
  });
  document.getElementById("vol-eta-da").addEventListener("input", e => { _volFiltro.etaDa = e.target.value; volAggiornaVista(); });
  document.getElementById("vol-eta-a").addEventListener("input", e => { _volFiltro.etaA = e.target.value; volAggiornaVista(); });
  document.getElementById("vol-stato").addEventListener("change", e => { _volFiltro.stato = e.target.value; volAggiornaVista(); });
  document.getElementById("vol-dav").addEventListener("change", e => { _volFiltro.daVerificare = e.target.checked; volAggiornaVista(); });
  document.getElementById("vol-azzera").addEventListener("click", () => { _volFiltro = volFiltroIniziale(); volDisegnaPagina(); });
  const btnFR = document.getElementById("vol-btn-filtri-req");
  if (btnFR) btnFR.addEventListener("click", () => {
    const p = document.getElementById("vol-req-filtri");
    p.hidden = !p.hidden;
  });
  content.querySelectorAll("[data-filtro-req]").forEach(s => s.addEventListener("change", () => {
    _volFiltro.req[s.dataset.filtroReq] = s.value;
    const n = Object.values(_volFiltro.req).filter(Boolean).length;
    if (btnFR) btnFR.innerHTML = `<i class="ti ti-filter" aria-hidden="true"></i> Corsi e abilitazioni${n ? ` (${n})` : ""}`;
    volAggiornaVista();
  }));
  content.querySelectorAll("[data-vista]").forEach(t => t.addEventListener("click", () => {
    _vol.vista = t.dataset.vista;
    content.querySelectorAll("[data-vista]").forEach(x => x.classList.toggle("active", x === t));
    volAggiornaVista();
  }));
  document.getElementById("vol-btn-excel").addEventListener("click", volEsportaExcel);
  const bi = document.getElementById("vol-btn-import");
  if (bi) bi.addEventListener("click", volApriModalImport);
  const br = document.getElementById("vol-btn-requisiti");
  if (br) br.addEventListener("click", volApriModalRequisiti);

  if (!_volListenerDocumento){
    _volListenerDocumento = true;
    document.addEventListener("click", e => {
      if (!document.contains(e.target)) return; // elemento appena ridisegnato (es. Tutte/Nessuna)
      document.querySelectorAll(".vol-ms-pan").forEach(p => { if (!p.parentElement.contains(e.target)) p.hidden = true; });
      const pop = document.getElementById("vol-popover");
      if (pop && !pop.contains(e.target) && !e.target.closest(".vol-req")) pop.remove();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") volChiudiPopover(); });
    window.addEventListener("hashchange", volChiudiPopover);
  }

  volAggiornaVista();
  if (volGestore()) volsAggiornaBadge();
}

// Regione → Sezione → Gruppo: le opzioni si restringono in cascata
function volAggiornaFiltriDipendenti(){
  const f = _volFiltro;
  document.querySelectorAll("[data-ambito]").forEach(b => {
    const a = VOL_AMBITI.find(x => x.k === b.dataset.ambito);
    const uguale = a.regioni.length === f.regioni.length && a.regioni.every(r => f.regioni.includes(r));
    b.classList.toggle("on", uguale);
  });

  volMultiSelect(document.getElementById("vol-ms-regioni"), {
    etichetta:"Regione", tutte:"Tutte",
    opzioni: VOL_REGIONI.map(r => ({ value:r, label:r })),
    scelti: f.regioni,
    onChange: (scelti) => { f.regioni = scelti; volAggiornaFiltriDipendenti(); volAggiornaVista(); }
  });

  const regAttive = f.regioni.length ? f.regioni : VOL_REGIONI;
  const sezDisponibili = _vol.sezioni.filter(s => regAttive.includes(s.regione));
  f.sezioni = f.sezioni.filter(s => sezDisponibili.some(x => x.sezione === s));
  volMultiSelect(document.getElementById("vol-ms-sezioni"), {
    etichetta:"Sezione", tutte:"Tutte",
    opzioni: sezDisponibili.map(s => ({ value:s.sezione, label:s.sezione })),
    scelti: f.sezioni,
    onChange: (scelti) => { f.sezioni = scelti; volAggiornaFiltriDipendenti(); volAggiornaVista(); }
  });
}

// Menu a tendina con caselle. Nessuna scelta = tutte.
function volMultiSelect(wrap, { etichetta, tutte, opzioni, scelti, onChange }){
  if (!wrap) return;
  const aperto = !!wrap.querySelector(".vol-ms-pan:not([hidden])");
  const sel = new Set(scelti);
  const tutteScelte = sel.size === 0 || sel.size === opzioni.length;
  const testo = tutteScelte ? tutte : (sel.size <= 2 ? [...sel].join(", ") : `${sel.size} scelte`);
  wrap.innerHTML = `
    <div class="vol-ms">
      <button type="button" class="vol-ms-btn">${escapeHtml(etichetta)}: <b>${escapeHtml(testo)}</b> ▾</button>
      <div class="vol-ms-pan" ${aperto ? "" : "hidden"}>
        <div class="vol-ms-az"><button type="button" data-ms="tutte">Tutte</button><button type="button" data-ms="nessuna">Nessuna</button></div>
        ${opzioni.map(o => `<label><input type="checkbox" value="${escapeHtml(o.value)}" ${sel.has(o.value) ? "checked" : ""}> ${escapeHtml(o.label)}</label>`).join("")}
      </div>
    </div>`;
  const pan = wrap.querySelector(".vol-ms-pan");
  wrap.querySelector(".vol-ms-btn").addEventListener("click", () => { pan.hidden = !pan.hidden; });
  const leggi = () => [...pan.querySelectorAll("input:checked")].map(i => i.value);
  pan.querySelectorAll("input").forEach(i => i.addEventListener("change", () => onChange(leggi())));
  pan.querySelector('[data-ms="tutte"]').addEventListener("click", () => onChange(opzioni.map(o => o.value)));
  pan.querySelector('[data-ms="nessuna"]').addEventListener("click", () => onChange([]));
}

/* ---------- Filtri e ordinamento ---------- */
function volFiltra(){
  const f = _volFiltro;
  const reg = new Set(f.regioni), sez = new Set(f.sezioni);
  const q = volNorm(f.q);
  const da = f.etaDa === "" ? null : Number(f.etaDa);
  const a = f.etaA === "" ? null : Number(f.etaA);
  const attivi = new Set(volRequisitiAttivi().map(r => String(r.id)));
  const reqF = Object.entries(f.req).filter(([rid, modo]) => modo && attivi.has(rid));
  return _vol.volontari.filter(v => {
    if (reg.size && !reg.has(v.regione)) return false;
    if (sez.size && !sez.has(v.sezione)) return false;
    if (f.stato && v.stato !== f.stato) return false;
    if (f.daVerificare && !v.da_verificare) return false;
    if (da !== null && (v.eta === null || v.eta < da)) return false;
    if (a !== null && (v.eta === null || v.eta > a)) return false;
    if (q && !v._cerca.includes(q)) return false;
    for (const [rid, modo] of reqF){
      const st = volStatoReq(v.id, rid);
      const regola = st === "VALIDO" || st === "IN_SCADENZA";
      if (modo === "REGOLA"){ if (!regola) return false; }
      else if (modo === "NON_REGOLA"){ if (regola) return false; }
      else if (st !== modo) return false;
    }
    return true;
  });
}

function volOrdina(lista){
  const { col, dir } = _volOrdine;
  const testo = (a, b) => String(a || "").localeCompare(String(b || ""), "it");
  const base = (a, b) => testo(a.cognome, b.cognome) || testo(a.nome, b.nome);
  const PESI = { MANCANTE:0, ANOMALIA:1, SCADUTO:2, DA_AGGIORNARE:3, IN_SCADENZA:4, VALIDO:5 };
  const peso = (v, rid) => {
    const s = _vol.stato.get(volChiave(v.id, rid));
    return s ? [PESI[s.stato] ?? 0, s.data_scadenza || s.data || ""] : [0, ""];
  };
  let cmp;
  if (col.startsWith("r")){
    const rid = col.slice(1);
    cmp = (a, b) => { const pa = peso(a, rid), pb = peso(b, rid); return (pa[0] - pb[0]) || testo(pa[1], pb[1]); };
  } else if (col === "eta"){
    cmp = (a, b) => (a.eta ?? 999) - (b.eta ?? 999);
  } else if (col === "data_nascita"){
    cmp = (a, b) => testo(a.data_nascita, b.data_nascita);
  } else if (col === "sezione"){
    cmp = (a, b) => (a.ordine_sezione - b.ordine_sezione);
  } else if (col === "regione"){
    cmp = (a, b) => VOL_REGIONI.indexOf(a.regione) - VOL_REGIONI.indexOf(b.regione);
  } else {
    cmp = (a, b) => testo(a[col], b[col]);
  }
  return [...lista].sort((a, b) => (cmp(a, b) * dir) || base(a, b));
}

function volAggiornaVista(){
  const box = document.getElementById("vol-vista");
  const conta = document.getElementById("vol-count");
  if (!box) return;
  // schede richieste / validazione (volontari-sezioni.js): i filtri dell'elenco non si applicano
  const sezioni = _vol.vista === "richieste" || _vol.vista === "validare";
  document.querySelectorAll(".vol-ambiti, #page-content > .toolbar, #vol-req-filtri").forEach(el => el.classList.toggle("vol-nascosto", sezioni));
  if (sezioni){
    if (conta) conta.textContent = "";
    if (!volGestore()){ _vol.vista = "elenco"; return volAggiornaVista(); }
    if (_vol.vista === "richieste") volsRenderRichieste(box);
    else volsRenderDaValidare(box);
    return;
  }
  const lista = volFiltra();
  if (conta) conta.textContent = `${lista.length} volontari visualizzati su ${_vol.volontari.length}`;
  if (_vol.vista === "riepilogo") box.innerHTML = volHtmlRiepilogo(lista);
  else volRenderTabella(box, volOrdina(lista));
}

/* ---------- Tabella principale ---------- */
const VOL_COLONNE = [
  { k:"cognome", label:"Cognome", fisso:1 },
  { k:"nome", label:"Nome", fisso:2 },
  { k:"cf", label:"CF" },
  { k:"regione", label:"Regione" },
  { k:"sezione", label:"Sezione" },
  { k:"data_nascita", label:"Data nascita" },
  { k:"eta", label:"Età" },
  { k:"stato", label:"Stato" },
];

function volRenderTabella(box, lista){
  const vecchio = box.querySelector(".vol-wrap");
  const scroll = vecchio ? [vecchio.scrollLeft, vecchio.scrollTop] : [0, 0];
  const req = volRequisitiAttivi();
  if (!_vol.volontari.length){
    box.innerHTML = `<div class="storico-empty">Nessun volontario in anagrafica.${volPuoModificare() ? " Usa <b>Importa da PIA</b> per caricarli." : ""}</div>`;
    return;
  }
  const freccia = k => _volOrdine.col === k ? (_volOrdine.dir === 1 ? " ▲" : " ▼") : "";
  const th = VOL_COLONNE.map(c =>
    `<th data-ord="${c.k}" class="${c.fisso ? "vol-f" + c.fisso : ""}">${c.label}${freccia(c.k)}</th>`).join("") +
    req.map(r => `<th data-ord="r${r.id}" class="vol-th-req" title="${escapeHtml(r.nome)}${r.obbligatorio ? " (obbligatorio)" : ""}${r.validita_mesi ? ` – vale ${r.validita_mesi} mesi` : ""}">${escapeHtml(r.nome)}${r.obbligatorio ? " *" : ""}${freccia("r" + r.id)}</th>`).join("");

  const righe = lista.map(v => `
    <tr data-id="${v.id}">
      <td class="vol-f1">${escapeHtml(v.cognome)}${v.da_verificare ? ` <i class="ti ti-alert-circle vol-dav" title="Separazione cognome/nome da verificare" aria-label="da verificare"></i>` : ""}</td>
      <td class="vol-f2">${escapeHtml(v.nome)}</td>
      <td class="vol-cf">${escapeHtml(v.cf)}</td>
      <td>${escapeHtml(v.regione)}</td>
      <td>${escapeHtml(v.sezione)}</td>
      <td>${v.data_nascita ? formatDataIt(v.data_nascita) : ""}</td>
      <td>${v.eta ?? ""}</td>
      <td><span class="vol-stato ${v.stato}">${VOL_STATI[v.stato] || v.stato}</span></td>
      ${req.map(r => volHtmlCella(v, r)).join("")}
    </tr>`).join("");

  box.innerHTML = `
    <div class="vol-wrap">
      <table class="vol-tab">
        <thead><tr>${th}</tr></thead>
        <tbody>${righe || `<tr><td colspan="${VOL_COLONNE.length + req.length}" class="storico-empty">Nessun volontario con questi filtri.</td></tr>`}</tbody>
      </table>
    </div>
    <p class="vol-legenda">
      <span class="vol-req VALIDO vol-leg">✓</span> valido · <span class="vol-req IN_SCADENZA vol-leg">✓</span> in scadenza ·
      <span class="vol-req DA_AGGIORNARE vol-leg"><i class="ti ti-refresh" aria-hidden="true"></i></span> da aggiornare ·
      <span class="vol-req SCADUTO vol-leg">✓</span> scaduto · <span class="vol-req ANOMALIA vol-leg">!</span> anomalia ·
      <span class="vol-req VALIDO vol-leg"><i class="ti ti-school" aria-hidden="true"></i></span> dalla Scuola di Formazione ·
      clic su una cella per lo storico${volPuoModificare() ? " o per aggiungere una data" : ""}.
    </p>`;
  const wrap = box.querySelector(".vol-wrap");
  wrap.scrollLeft = scroll[0]; wrap.scrollTop = scroll[1];
  // dopo il ripristino dello scroll (che genera anch'esso un evento "scroll")
  setTimeout(() => wrap.addEventListener("scroll", volChiudiPopover, { passive:true }), 150);

  box.querySelector("thead").addEventListener("click", e => {
    const t = e.target.closest("[data-ord]");
    if (!t) return;
    const k = t.dataset.ord;
    _volOrdine = { col:k, dir: _volOrdine.col === k ? -_volOrdine.dir : 1 };
    volAggiornaVista();
  });
  box.querySelector("tbody").addEventListener("click", e => {
    const td = e.target.closest("td.vol-req");
    if (!td) return;
    volApriPopover(td, td.parentElement.dataset.id, Number(td.dataset.r));
  });
}

function volHtmlCella(v, r){
  const s = _vol.stato.get(volChiave(v.id, r.id));
  if (!s) return `<td class="vol-req" data-r="${r.id}"></td>`;
  const icona = s.stato === "ANOMALIA" ? "!"
    : s.stato === "DA_AGGIORNARE" ? `<i class="ti ti-refresh" aria-label="da aggiornare"></i>`
    : s.origine === "SCUOLA" ? `<i class="ti ti-school" aria-label="Scuola di Formazione"></i>` : "✓";
  const titolo = [
    VOL_STATI_REQ[s.stato] || s.stato,
    "Base: " + (s.data_base ? formatDataIt(s.data_base) : (s.stato === "ANOMALIA" ? "mancante" : "senza data")),
    s.ultimo_aggiornamento ? "Ultimo aggiornamento: " + formatDataIt(s.ultimo_aggiornamento) : "",
    s.data_scadenza ? "Scadenza: " + formatDataIt(s.data_scadenza) : "Non scade",
    s.origine === "SCUOLA" ? "Dalla Scuola di Formazione" : ""
  ].filter(Boolean).join("\n");
  return `<td class="vol-req ${s.stato}" data-r="${r.id}" title="${escapeHtml(titolo)}">${icona}</td>`;
}

/* ---------- Popover spunta ---------- */
function volChiudiPopover(){
  const p = document.getElementById("vol-popover");
  if (p) p.remove();
}

async function volApriPopover(td, vid, rid){
  volChiudiPopover();
  const v = _vol.perId.get(vid);
  const r = _vol.requisiti.find(x => x.id === rid);
  if (!v || !r) return;

  const pop = document.createElement("div");
  pop.id = "vol-popover";
  pop.className = "vol-popover";
  const rect = td.getBoundingClientRect();
  pop.style.top = (rect.bottom + 4) + "px";
  pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 340)) + "px";
  pop.innerHTML = `
    <div class="vol-pop-t">${escapeHtml(r.nome)}</div>
    <div class="vol-pop-sub">${escapeHtml(v.cognome)} ${escapeHtml(v.nome)}</div>
    <div class="vol-pop-stato"></div>
    <div id="vol-pop-corpo"><div class="loading-spin" style="padding:10px;">…</div></div>`;
  document.body.appendChild(pop);
  volAggiornaStatoPopover(pop, v, r);
  // vicino al fondo dello schermo: lo apro sopra la cella
  const posiziona = () => {
    const h = pop.offsetHeight;
    pop.style.top = (rect.bottom + 4 + h > window.innerHeight ? Math.max(8, rect.top - 4 - h) : rect.bottom + 4) + "px";
  };
  new ResizeObserver(posiziona).observe(pop);
  await volRenderStoricoPopover(pop, v, r);
}

function volAggiornaStatoPopover(pop, v, r){
  const s = _vol.stato.get(volChiave(v.id, r.id));
  const st = s ? s.stato : "MANCANTE";
  pop.querySelector(".vol-pop-stato").innerHTML = `<span class="vol-chip ${st}">${VOL_STATI_REQ[st]}</span>` +
    (s?.data_base ? ` base <b>${formatDataIt(s.data_base)}</b>` : "") +
    (s?.ultimo_aggiornamento ? ` · agg. <b>${formatDataIt(s.ultimo_aggiornamento)}</b>` : "") +
    (s?.data_scadenza ? ` · scade <b>${formatDataIt(s.data_scadenza)}</b>` : "");
}

// Storico degli eventi (manuali, Scuola, Sezioni) + aggiunta di Base / Aggiornamento
async function volRenderStoricoPopover(pop, v, r){
  const corpo = pop.querySelector("#vol-pop-corpo");
  const { data, error } = await sb.rpc("vol_eventi_f", { p_volontario: v.id });
  if (!document.body.contains(pop)) return;
  if (error){ corpo.innerHTML = `<p>Errore: ${escapeHtml(error.message)}</p>`; return; }
  const eventi = (data || []).filter(e => e.requisito_id === r.id)
    .sort((a, b) => String(b.data || "").localeCompare(String(a.data || "")));
  const puo = volPuoModificare();
  const oggi = new Date().toISOString().slice(0, 10);

  corpo.innerHTML = `
    ${eventi.length ? `<ul class="vol-storico">${eventi.map(e => `
      <li class="${e.annullato ? "annullato" : ""}">
        <div><b>${e.tipo === "BASE" ? "Base" : "Aggiornamento"}</b> · ${e.data ? formatDataIt(e.data) : "senza data"}
          <span class="vol-origine">${e.origine === "SCUOLA" ? `<i class="ti ti-school" aria-hidden="true"></i> ` : ""}${escapeHtml(VOL_ORIGINI[e.origine] || e.origine)}</span></div>
        ${e.edizione ? `<div class="vol-pop-nota">Corso: ${escapeHtml(e.edizione)}</div>` : ""}
        ${e.note ? `<div class="vol-pop-nota">${escapeHtml(e.note)}</div>` : ""}
        ${e.creato_da ? `<div class="vol-pop-nota">${e.origine === "MANUALE" ? "Inserito" : "Approvato"} da ${escapeHtml(e.creato_da)}</div>` : ""}
        ${e.annullato ? `<div class="vol-pop-nota">Annullato: ${escapeHtml(e.motivo_annullamento || "")}</div>` : ""}
        <div class="vol-ev-az">
          ${e.documento_path ? `<a href="#" role="button" data-apri-file="${escapeHtml(e.documento_path)}" data-bucket="${STORAGE_BUCKET_DOC_VOLONTARI}">Apri attestato</a>` : ""}
          ${puo && e.evento_id && !e.annullato ? `<button type="button" class="row-del" data-annulla="${e.evento_id}">Annulla</button>` : ""}
        </div>
      </li>`).join("")}</ul>` : `<p class="vol-pop-nota" style="margin-top:0;">Nessun evento registrato.</p>`}
    ${eventi.some(e => e.origine === "SCUOLA") ? `<p class="vol-pop-nota">Gli eventi della Scuola di Formazione arrivano dagli attestati e non si modificano da qui.</p>` : ""}
    ${puo ? `
      <form class="vol-ev-form" id="vol-ev-form">
        <div class="vol-ev-riga">
          <select name="tipo" aria-label="Tipo">
            <option value="BASE">Base</option>
            ${r.prevede_aggiornamento ? `<option value="AGGIORNAMENTO">Aggiornamento</option>` : ""}
          </select>
          <input type="date" name="data" required max="${oggi}" min="1950-01-01" aria-label="Data">
        </div>
        <input name="note" maxlength="500" placeholder="Note (facoltative)">
        <div class="vol-pop-az">
          <button type="button" class="btn-cancel" id="vol-pop-chiudi">Chiudi</button>
          <button type="submit" class="btn-save">Aggiungi</button>
        </div>
      </form>` : ""}`;
  attaccaListenerApriFile(corpo);

  corpo.querySelectorAll("[data-annulla]").forEach(b => b.addEventListener("click", async () => {
    const motivo = prompt("Motivo dell'annullamento (l'evento resta nello storico come annullato):");
    if (!motivo || !motivo.trim()) return;
    const { error: errA } = await sb.rpc("vol_annulla_evento", { p_id: Number(b.dataset.annulla), p_motivo: motivo.trim() });
    if (errA){ alert("Errore: " + errA.message); return; }
    await volDopoModificaEventi(pop, v, r);
  }));
  const chiudi = corpo.querySelector("#vol-pop-chiudi");
  if (chiudi) chiudi.addEventListener("click", volChiudiPopover);
  const f = corpo.querySelector("#vol-ev-form");
  if (f) f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const data = f.data.value;
    if (!data || data > oggi){ alert("Indica una data valida, non nel futuro."); return; }
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const { error: errI } = await sb.from("vol_eventi_requisito").insert({
      volontario_id: v.id, requisito_id: r.id, tipo: f.tipo.value, data, origine: "MANUALE",
      note: f.note.value.trim() || null
    });
    if (errI){ btn.disabled = false; alert("Errore: " + errI.message); return; }
    await volDopoModificaEventi(pop, v, r);
  });
}

async function volDopoModificaEventi(pop, v, r){
  await volRicaricaStatoVolontario(v.id);
  volAggiornaVista();
  if (!document.body.contains(pop)) return;
  volAggiornaStatoPopover(pop, v, r);
  await volRenderStoricoPopover(pop, v, r);
}

async function volRicaricaStatoVolontario(vid){
  const { data, error } = await sb.from("vol_stato_requisiti").select(VOL_COLONNE_STATO).eq("volontario_id", vid);
  if (error){ alert("Spunta salvata, ma non riesco a ricaricare la riga: " + error.message); return; }
  _vol.requisiti.forEach(r => _vol.stato.delete(volChiave(vid, r.id)));
  (data || []).forEach(s => _vol.stato.set(volChiave(s.volontario_id, s.requisito_id), s));
}

/* ---------- Riepilogo Sezione × requisito ---------- */
function volHtmlRiepilogo(lista){
  const req = volRequisitiAttivi();
  if (!req.length) return `<div class="storico-empty">Nessun corso o abilitazione definito.${volGestore() ? " Aggiungili da <b>Corsi e abilitazioni</b>." : ""}</div>`;
  if (!lista.length) return `<div class="storico-empty">Nessun volontario con questi filtri.</div>`;

  const conta = (vols) => {
    const n = {};
    req.forEach(r => { n[r.id] = { regola:0, scad:0, agg:0 }; });
    vols.forEach(v => req.forEach(r => {
      const st = volStatoReq(v.id, r.id);
      if (st === "VALIDO" || st === "IN_SCADENZA") n[r.id].regola++;
      if (st === "IN_SCADENZA") n[r.id].scad++;
      if (st === "DA_AGGIORNARE") n[r.id].agg++;
    }));
    return n;
  };
  const cella = (n, tot) => {
    if (!tot) return `<td class="vol-pct">—</td>`;
    const pct = Math.round(n * 100 / tot);
    const cl = pct >= 90 ? "alto" : pct >= 50 ? "medio" : "basso";
    return `<td class="vol-pct ${cl}"><b>${pct}%</b><small>${n}/${tot}</small></td>`;
  };
  const num = (n, cl) => `<td class="vol-num ${n ? cl : ""}">${n || "—"}</td>`;
  const riga = (nome, vols, classe) => {
    const n = conta(vols);
    return `<tr class="${classe}"><td class="vol-f1">${escapeHtml(nome)}</td><td class="vol-pct-tot">${vols.length}</td>${req.map(r =>
      cella(n[r.id].regola, vols.length) + num(n[r.id].scad, "IN_SCADENZA") + (r.prevede_aggiornamento ? num(n[r.id].agg, "DA_AGGIORNARE") : "")).join("")}</tr>`;
  };

  let corpo = "";
  VOL_REGIONI.forEach(reg => {
    const volsReg = lista.filter(v => v.regione === reg);
    if (!volsReg.length) return;
    _vol.sezioni.filter(s => s.regione === reg).forEach(s => {
      const vs = volsReg.filter(v => v.sezione === s.sezione);
      if (vs.length) corpo += riga(s.sezione, vs, "");
    });
    corpo += riga("Totale " + reg, volsReg, "vol-rie-reg");
  });
  corpo += riga("Totale generale", lista, "vol-rie-tot");

  return `
    <div class="vol-wrap">
      <table class="vol-tab vol-rie">
        <thead>
          <tr><th class="vol-f1">Sezione</th><th>Volontari</th>${req.map(r =>
            `<th class="vol-th-req vol-th-gruppo" colspan="${r.prevede_aggiornamento ? 3 : 2}">${escapeHtml(r.nome)}${r.obbligatorio ? " *" : ""}</th>`).join("")}</tr>
          <tr class="vol-th-sotto"><th class="vol-f1"></th><th></th>${req.map(r => `<th>In regola</th><th>In scad.</th>${r.prevede_aggiornamento ? "<th>Da agg.</th>" : ""}`).join("")}</tr>
        </thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>
    <p class="vol-legenda">In regola = valido o in scadenza. Percentuali sui volontari visualizzati con i filtri attivi.</p>`;
}

/* ---------- Export Excel (vista filtrata) ---------- */
function volEsportaExcel(){
  const lista = volOrdina(volFiltra());
  if (!lista.length){ alert("Nessun volontario da esportare con questi filtri."); return; }
  const req = volRequisitiAttivi();
  const intest = ["Cognome","Nome","Codice fiscale","Regione","Sezione","Squadra","Data nascita","Età","Stato"];
  req.forEach(r => {
    if (r.prevede_aggiornamento) intest.push(`${r.nome} – Base`, `${r.nome} – Ult. aggiornamento`, `${r.nome} – Scadenza`, `${r.nome} – Stato`);
    else intest.push(r.nome);
  });
  const d = x => x ? formatDataIt(x) : "";
  const righe = lista.map(v => {
    const riga = [v.cognome, v.nome, v.cf, v.regione, v.sezione, v.squadra || "",
      d(v.data_nascita), v.eta ?? "", VOL_STATI[v.stato] || v.stato];
    req.forEach(r => {
      const s = _vol.stato.get(volChiave(v.id, r.id));
      if (r.prevede_aggiornamento){
        riga.push(d(s?.data_base), d(s?.ultimo_aggiornamento), d(s?.data_scadenza), VOL_STATI_REQ[s ? s.stato : "MANCANTE"]);
      } else {
        riga.push(s && s.stato !== "ANOMALIA" ? (s.data ? formatDataIt(s.data) : "SI") : "");
      }
    });
    return riga;
  });
  const ws = XLSX.utils.aoa_to_sheet([intest, ...righe]);
  ws["!cols"] = intest.map((h, i) => ({ wch: i < 3 ? 18 : Math.max(10, Math.min(28, String(h).length + 2)) }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:righe.length, c:intest.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Volontari");
  const ambito = VOL_AMBITI.find(a => a.regioni.length === _volFiltro.regioni.length && a.regioni.every(r => _volFiltro.regioni.includes(r)));
  XLSX.writeFile(wb, `Volontari_${ambito ? ambito.label.replace(/\W+/g, "") : "filtro"}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* =====================================================================
   CORSI E ABILITAZIONI (vol_requisiti)
   ===================================================================== */
async function volApriModalRequisiti(){
  chiudiModal();
  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box modal-box-lg">
      <div class="modal-head">
        <h3>Corsi e abilitazioni</h3>
        <button class="modal-close" id="vol-req-chiudi">✕</button>
      </div>
      <div class="modal-body" id="vol-req-body"><div class="loading-spin">Caricamento…</div></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#vol-req-chiudi").addEventListener("click", () => { chiudiModal(); volDisegnaPagina(); });
  if (!_volCatalogoCorsi){
    const { data, error } = await sb.from("catalogo_corsi").select("id, codice, descrizione").order("codice");
    _volCatalogoCorsi = error ? [] : (data || []);
  }
  volRenderListaRequisiti(null);
}

function volRenderListaRequisiti(inModifica){
  const body = document.getElementById("vol-req-body");
  if (!body) return;
  const lista = _vol.requisiti;
  const corso = id => {
    const c = (_volCatalogoCorsi || []).find(x => x.id === id);
    return c ? `${c.codice}${c.descrizione ? " – " + c.descrizione : ""}` : (id ? `corso n. ${id}` : "");
  };
  const form = inModifica !== null ? volHtmlFormRequisito(inModifica === "nuovo" ? null : lista.find(r => r.id === inModifica)) : "";
  body.innerHTML = `
    <p style="font-size:12.5px;color:var(--grigio-600);margin-top:0;">
      Le colonne da spuntare nella pagina Volontari. Collegando un corso della Scuola di Formazione, chi ha l'attestato risulta spuntato in automatico.
      Le voci non si cancellano: si disattivano (le spunte restano salvate).
    </p>
    ${form}
    ${inModifica === null ? `<div class="storico-toolbar"><button class="btn-add-mini" id="vol-req-nuovo">+ Nuovo corso o abilitazione</button></div>` : ""}
    ${lista.length ? `
    <table class="storico-table">
      <thead><tr><th>Ordine</th><th>Nome</th><th>Tipo</th><th>Obbl.</th><th>Validità</th><th>Aggiornamento</th><th>Corso Scuola collegato</th><th>Attivo</th><th></th></tr></thead>
      <tbody>${lista.map((r, i) => `
        <tr style="${r.attivo ? "" : "opacity:.55;"}">
          <td style="white-space:nowrap;">
            <button class="row-del" style="color:var(--blu-500);" data-su="${i}" ${i === 0 ? "disabled" : ""} aria-label="Sposta su">▲</button>
            <button class="row-del" style="color:var(--blu-500);" data-giu="${i}" ${i === lista.length - 1 ? "disabled" : ""} aria-label="Sposta giù">▼</button>
          </td>
          <td>${escapeHtml(r.nome)}</td>
          <td>${r.tipo === "CORSO" ? "Corso" : "Abilitazione"}</td>
          <td>${r.obbligatorio ? "Sì" : "—"}</td>
          <td>${r.validita_mesi ? r.validita_mesi + " mesi" : "non scade"}<br><small style="color:var(--grigio-600);">preavviso ${r.preavviso_giorni ?? 90} gg</small></td>
          <td>${r.prevede_aggiornamento ? `Sì${r.validita_aggiornamento_mesi ? ` · ${r.validita_aggiornamento_mesi} mesi` : ""}${r.corso_aggiornamento_id ? `<br><small style="color:var(--grigio-600);">${escapeHtml(corso(r.corso_aggiornamento_id))}</small>` : ""}` : "—"}</td>
          <td>${escapeHtml(corso(r.corso_formazione_id)) || "—"}</td>
          <td><input type="checkbox" data-attivo="${r.id}" ${r.attivo ? "checked" : ""}></td>
          <td><button class="row-del" style="color:var(--blu-500);" data-modifica="${r.id}">Modifica</button></td>
        </tr>`).join("")}
      </tbody>
    </table>` : `<div class="storico-empty">Nessun corso o abilitazione definito.</div>`}`;

  const nuovo = body.querySelector("#vol-req-nuovo");
  if (nuovo) nuovo.addEventListener("click", () => volRenderListaRequisiti("nuovo"));
  body.querySelectorAll("[data-modifica]").forEach(b => b.addEventListener("click", () => volRenderListaRequisiti(Number(b.dataset.modifica))));
  body.querySelectorAll("[data-su]").forEach(b => b.addEventListener("click", () => volSpostaRequisito(Number(b.dataset.su), -1)));
  body.querySelectorAll("[data-giu]").forEach(b => b.addEventListener("click", () => volSpostaRequisito(Number(b.dataset.giu), 1)));
  body.querySelectorAll("[data-attivo]").forEach(cb => cb.addEventListener("change", async () => {
    const { error } = await sb.from("vol_requisiti").update({ attivo: cb.checked }).eq("id", Number(cb.dataset.attivo));
    if (error){ alert("Errore: " + error.message); cb.checked = !cb.checked; return; }
    await volRicaricaRequisiti();
    volRenderListaRequisiti(null);
  }));
  const f = body.querySelector("#vol-req-form");
  if (f){
    const mostraAgg = () => f.querySelectorAll(".vol-campo-agg").forEach(x => { x.style.display = f.prevede_aggiornamento.checked ? "" : "none"; });
    f.prevede_aggiornamento.addEventListener("change", mostraAgg);
    mostraAgg();
    f.addEventListener("submit", e => { e.preventDefault(); volSalvaRequisito(f, inModifica === "nuovo" ? null : inModifica); });
    f.querySelector("#vol-req-annulla").addEventListener("click", () => volRenderListaRequisiti(null));
  }
}

function volOpzioniCorsi(scelto){
  return `<option value="">— nessun collegamento —</option>` +
    (_volCatalogoCorsi || []).map(c => `<option value="${c.id}" ${scelto === c.id ? "selected" : ""}>${escapeHtml(c.codice)}${c.descrizione ? " – " + escapeHtml(c.descrizione) : ""}</option>`).join("");
}

function volHtmlFormRequisito(r){
  return `
    <form class="mini-form" id="vol-req-form">
      <div class="form-grid">
        <div class="form-field"><label>Nome *</label><input name="nome" required maxlength="80" value="${escapeHtml(r?.nome || "")}"></div>
        <div class="form-field"><label>Tipo</label>
          <select name="tipo">
            <option value="CORSO" ${r?.tipo !== "ABILITAZIONE" ? "selected" : ""}>Corso</option>
            <option value="ABILITAZIONE" ${r?.tipo === "ABILITAZIONE" ? "selected" : ""}>Abilitazione</option>
          </select></div>
        <div class="form-field"><label>Validità in mesi (vuoto = non scade)</label><input name="validita_mesi" type="number" min="1" max="600" value="${r?.validita_mesi ?? ""}"></div>
        <div class="form-field"><label>Obbligatorio</label>
          <div class="form-checkbox"><input type="checkbox" name="obbligatorio" ${r?.obbligatorio ? "checked" : ""}><label style="margin:0;">Requisito obbligatorio</label></div></div>
        <div class="form-field"><label>Preavviso "in scadenza" (giorni)</label><input name="preavviso_giorni" type="number" min="0" max="730" value="${r?.preavviso_giorni ?? 90}"></div>
        <div class="form-field full"><label>Corso della Scuola di Formazione (evento Base automatico dagli attestati)</label>
          <select name="corso_formazione_id">${volOpzioniCorsi(r?.corso_formazione_id)}</select></div>
        <div class="form-field full"><label>Aggiornamento</label>
          <div class="form-checkbox"><input type="checkbox" name="prevede_aggiornamento" id="vol-req-prevede" ${r?.prevede_aggiornamento ? "checked" : ""}><label for="vol-req-prevede" style="margin:0;">Quando scade si rinnova con un corso di aggiornamento (non si rifà da capo)</label></div></div>
        <div class="form-field vol-campo-agg"><label>Validità dell'aggiornamento in mesi (vuoto = come sopra)</label><input name="validita_aggiornamento_mesi" type="number" min="1" max="600" value="${r?.validita_aggiornamento_mesi ?? ""}"></div>
        <div class="form-field vol-campo-agg"><label>Corso di aggiornamento della Scuola (evento Aggiornamento automatico)</label>
          <select name="corso_aggiornamento_id">${volOpzioniCorsi(r?.corso_aggiornamento_id)}</select></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-cancel" id="vol-req-annulla">Annulla</button>
        <button type="submit" class="btn-save">Salva</button>
      </div>
    </form>`;
}

async function volSalvaRequisito(f, id){
  const payload = {
    nome: f.nome.value.trim(),
    tipo: f.tipo.value,
    validita_mesi: f.validita_mesi.value ? Number(f.validita_mesi.value) : null,
    obbligatorio: f.obbligatorio.checked,
    corso_formazione_id: f.corso_formazione_id.value ? Number(f.corso_formazione_id.value) : null,
    preavviso_giorni: f.preavviso_giorni.value === "" ? 90 : Number(f.preavviso_giorni.value),
    prevede_aggiornamento: f.prevede_aggiornamento.checked,
    validita_aggiornamento_mesi: f.prevede_aggiornamento.checked && f.validita_aggiornamento_mesi.value ? Number(f.validita_aggiornamento_mesi.value) : null,
    corso_aggiornamento_id: f.prevede_aggiornamento.checked && f.corso_aggiornamento_id.value ? Number(f.corso_aggiornamento_id.value) : null,
  };
  if (!payload.nome){ alert("Inserisci il nome."); return; }
  let error;
  if (id){
    ({ error } = await sb.from("vol_requisiti").update(payload).eq("id", id));
  } else {
    payload.ordine = _vol.requisiti.reduce((m, r) => Math.max(m, r.ordine || 0), 0) + 1;
    ({ error } = await sb.from("vol_requisiti").insert(payload));
  }
  if (error){ alert(error.code === "23505" ? "Esiste già una voce con questo nome." : "Errore: " + error.message); return; }
  // il collegamento al corso o la validità cambiano le spunte: ricarico tutto
  const err = await volCaricaDati();
  if (err) alert("Salvato, ma errore nel ricaricare i dati: " + err);
  volRenderListaRequisiti(null);
}

async function volSpostaRequisito(i, delta){
  const lista = [..._vol.requisiti];
  const j = i + delta;
  if (j < 0 || j >= lista.length) return;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  const cambi = lista.map((r, k) => ({ id:r.id, ordine:k + 1, prima:r.ordine })).filter(x => x.ordine !== x.prima);
  const esiti = await Promise.all(cambi.map(c => sb.from("vol_requisiti").update({ ordine:c.ordine }).eq("id", c.id)));
  const err = esiti.find(e => e.error);
  if (err) alert("Errore: " + err.error.message);
  await volRicaricaRequisiti();
  volRenderListaRequisiti(null);
}

async function volRicaricaRequisiti(){
  const { data, error } = await sb.from("vol_requisiti").select("*").order("ordine").order("id");
  if (error){ alert("Errore: " + error.message); return; }
  _vol.requisiti = data || [];
}

/* =====================================================================
   IMPORTA DA PIA
   ===================================================================== */
function volApriModalImport(){
  chiudiModal();
  _volImport = null;
  const overlay = document.createElement("div");
  overlay.id = "modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box modal-box-lg">
      <div class="modal-head">
        <h3>Importa da PIA</h3>
        <button class="modal-close" onclick="chiudiModal()">✕</button>
      </div>
      <div class="modal-body" id="vol-imp-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  volImportPasso1();
}

function volImportPasso1(){
  const body = document.getElementById("vol-imp-body");
  if (!body) return;
  body.innerHTML = `
    <details class="vol-istr" open>
      <summary>Come copiare i volontari dal PIA</summary>
      <ol>
        <li>Nel PIA apri <b>Volontari ANA &gt; Schede Volontari</b>.</li>
        <li>Imposta Raggruppamento <b>1Rgpt</b>, <b>NON Obsoleti</b>, Righe = <b>TUTTE</b>, poi premi <b>Filtra</b>.</li>
        <li>Clicca il preferito <b>Copia da PIA</b>.</li>
        <li>Torna qui e incolla nel riquadro sotto.</li>
      </ol>
      <div class="vol-bm-box">
        <a class="vol-bm" id="vol-bm" href="${escapeHtml(VOL_BOOKMARKLET)}" draggable="true" title="Trascinami nella barra dei preferiti"><i class="ti ti-clipboard-copy" aria-hidden="true"></i> Copia da PIA</a>
        <span>← trascina questo pulsante nella barra dei preferiti del browser (una volta sola)</span>
        <button type="button" class="btn-add-mini" id="vol-bm-copia" style="background:var(--grigio-800);"><i class="ti ti-copy" aria-hidden="true"></i> <span>Copia codice</span></button>
      </div>
      <p class="vol-pop-nota">Si può importare anche una Sezione alla volta: i volontari che non compaiono passano a "Non in PIA" solo nelle Sezioni presenti nell'import. Nessuno viene cancellato.</p>
    </details>
    <div class="form-field full">
      <label>Incolla da PIA</label>
      <textarea id="vol-imp-testo" rows="8" placeholder="SEZIONE&#9;MAT_GISA&#9;MAT_VOLA&#9;COGNOME_NOME&#9;CF&#9;GRUPPO&#9;SQUADRA&#9;OBSOLETO" style="font-family:monospace;font-size:12px;width:100%;"></textarea>
    </div>
    <div class="vol-imp-file">oppure carica un file Excel o CSV: <input type="file" id="vol-imp-file" accept=".xlsx,.xls,.csv,.txt"></div>
    <div class="form-actions">
      <button type="button" class="btn-cancel" onclick="chiudiModal()">Annulla</button>
      <button type="button" class="btn-save" id="vol-imp-analizza">Analizza</button>
    </div>
    <div id="vol-imp-storico"></div>`;

  body.querySelector("#vol-bm").addEventListener("click", e => {
    e.preventDefault();
    alert("Questo pulsante va trascinato nella barra dei preferiti e usato dentro il PIA, non qui.");
  });
  body.querySelector("#vol-bm-copia").addEventListener("click", async (ev) => {
    const lbl = ev.currentTarget.querySelector("span");
    try { await navigator.clipboard.writeText(VOL_BOOKMARKLET); lbl.textContent = "Copiato!"; }
    catch(e){ prompt("Copia il codice:", VOL_BOOKMARKLET); }
    setTimeout(() => { lbl.textContent = "Copia codice"; }, 2000);
  });
  body.querySelector("#vol-imp-analizza").addEventListener("click", async () => {
    const file = body.querySelector("#vol-imp-file").files[0];
    let righe;
    try {
      righe = file ? await volLeggiFile(file) : volLeggiTesto(body.querySelector("#vol-imp-testo").value);
    } catch(e){ alert("Non riesco a leggere i dati: " + e.message); return; }
    if (!righe.length){ alert("Incolla i dati dal PIA oppure scegli un file."); return; }
    volImportPreparaMappa(righe);
  });
  volRenderStoricoImport();
}

async function volRenderStoricoImport(){
  const box = document.getElementById("vol-imp-storico");
  if (!box) return;
  const { data, error } = await sb.from("vol_import_log").select("*").order("data", { ascending:false }).limit(10);
  if (error || !data || !data.length) return;
  box.innerHTML = `
    <div class="section-title" style="margin-top:22px;">Ultimi import</div>
    <table class="storico-table">
      <thead><tr><th>Data</th><th>Utente</th><th>Sezioni</th><th>Nuovi</th><th>Agg.</th><th>Invar.</th><th>Non in PIA</th><th>Dimessi</th><th>Da verif.</th><th>Scartati</th></tr></thead>
      <tbody>${data.map(l => `<tr>
        <td>${new Date(l.data).toLocaleString("it-IT", { dateStyle:"short", timeStyle:"short" })}</td>
        <td>${escapeHtml(l.utente_email || "")}</td>
        <td title="${escapeHtml((l.sezioni || []).join(", "))}">${(l.sezioni || []).length > 2 ? l.sezioni.length + " Sezioni" : escapeHtml((l.sezioni || []).join(", "))}</td>
        <td>${l.nuovi}</td><td>${l.aggiornati}</td><td>${l.invariati}</td><td>${l.non_in_pia}</td><td>${l.dimessi}</td><td>${l.da_verificare}</td><td>${l.scartati}</td>
      </tr>`).join("")}</tbody>
    </table>`;
}

function volLeggiTesto(testo){
  const righe = String(testo || "").replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (!righe.length) return [];
  const prima = righe[0];
  const sep = prima.includes("\t") ? "\t" : (prima.split(";").length > prima.split(",").length ? ";" : ",");
  return righe.map(l => l.split(sep).map(c => c.trim().replace(/^"(.*)"$/, "$1").trim()));
}

async function volLeggiFile(file){
  if (/\.(csv|txt)$/i.test(file.name)) return volLeggiTesto(await file.text());
  const wb = XLSX.read(await file.arrayBuffer(), { type:"array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header:1, raw:false, defval:"" })
    .map(r => r.map(c => String(c ?? "").trim()))
    .filter(r => r.some(c => c));
}

function volNormIntestazione(c){ return volNorm(c).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }

function volImportPreparaMappa(righe){
  // se la prima riga contiene un CF valido non c'è intestazione
  const haIntestazione = !righe[0].some(c => cfValido(String(c).replace(/\s/g, "").toUpperCase()));
  const intest = haIntestazione ? righe[0].map(volNormIntestazione) : [];
  const dati = haIntestazione ? righe.slice(1) : righe;
  const nCol = Math.max(...righe.map(r => r.length));

  const standard = VOL_INTESTAZIONE_PIA.every((h, i) => intest[i] === h);
  const mappa = {};
  if (standard){
    VOL_INTESTAZIONE_PIA.forEach((h, i) => { mappa[h] = i; });
    volImportAnteprima(dati, mappa);
    return;
  }
  VOL_CAMPI_IMPORT.forEach(c => {
    const i = intest.findIndex((h, idx) => c.re.test(h) && !Object.values(mappa).includes(idx));
    if (i >= 0) mappa[c.k] = i;
  });
  if (mappa.COGNOME_NOME != null){ delete mappa.COGNOME; delete mappa.NOME; }
  volImportPassoMappa(righe, haIntestazione, dati, nCol, mappa);
}

function volImportPassoMappa(righe, haIntestazione, dati, nCol, mappa){
  const body = document.getElementById("vol-imp-body");
  const esempio = dati[0] || [];
  const nomeCol = i => `Colonna ${i + 1}${haIntestazione && righe[0][i] ? ": " + righe[0][i] : ""}${esempio[i] ? ` (es. ${esempio[i]})` : ""}`;
  body.innerHTML = `
    <p style="font-size:13px;margin-top:0;">L'intestazione non è quella standard del bookmarklet: indica quale colonna contiene ogni dato. Obbligatori: <b>Sezione</b>, <b>Codice fiscale</b> e <b>Cognome e nome</b> (insieme, oppure Cognome e Nome separati).</p>
    <div class="form-grid">
      ${VOL_CAMPI_IMPORT.map(c => `
        <div class="form-field"><label>${c.label}</label>
          <select data-campo="${c.k}">
            <option value="">— non presente —</option>
            ${Array.from({ length:nCol }, (_, i) => `<option value="${i}" ${mappa[c.k] === i ? "selected" : ""}>${escapeHtml(nomeCol(i))}</option>`).join("")}
          </select></div>`).join("")}
    </div>
    <div class="form-actions">
      <button type="button" class="btn-cancel" id="vol-imp-indietro">Indietro</button>
      <button type="button" class="btn-save" id="vol-imp-avanti">Avanti</button>
    </div>`;
  body.querySelector("#vol-imp-indietro").addEventListener("click", volImportPasso1);
  body.querySelector("#vol-imp-avanti").addEventListener("click", () => {
    const m = {};
    body.querySelectorAll("[data-campo]").forEach(s => { if (s.value !== "") m[s.dataset.campo] = Number(s.value); });
    if (m.SEZIONE == null || m.CF == null || (m.COGNOME_NOME == null && m.COGNOME == null)){
      alert("Servono almeno Sezione, Codice fiscale e Cognome e nome (oppure Cognome).");
      return;
    }
    volImportAnteprima(dati, m);
  });
}

function volCostruisciRecord(riga, mappa, n){
  const g = k => mappa[k] != null ? String(riga[mappa[k]] ?? "").replace(/\s+/g, " ").trim() : "";
  const cf = g("CF").replace(/\s/g, "").toUpperCase();
  let cognome, nome, certo = true, grezzo;
  if (mappa.COGNOME_NOME != null){
    grezzo = volNorm(g("COGNOME_NOME"));
    ({ cognome, nome, certo } = volSeparaNome(grezzo, cf));
  } else {
    cognome = volNorm(g("COGNOME")); nome = volNorm(g("NOME"));
    grezzo = `${cognome} ${nome}`.trim();
  }
  return {
    n, cf, cognome, nome, grezzo, da_verificare: !certo,
    sezione: g("SEZIONE").toUpperCase().replace(/[’`]/g, "'"),
    gruppo: g("GRUPPO"), squadra: g("SQUADRA"),
    matricola_gisa: g("MAT_GISA"), matricola_vola: g("MAT_VOLA"),
    obsoleto: /^(SI|SÌ|S|X|1|TRUE|VERO|YES)$/i.test(g("OBSOLETO")),
  };
}

const VOL_CAMPI_DIFF = [
  ["sezione","Sezione"], ["cognome","Cognome"], ["nome","Nome"], ["gruppo","Gruppo"], ["squadra","Squadra"],
  ["matricola_gisa","Mat. GISA"], ["matricola_vola","Mat. VOLA"], ["stato","Stato"], ["da_verificare","Da verificare"],
];
function volDifferenze(e, r){
  const val = (k, x) => k === "da_verificare" ? (x ? "sì" : "no") : k === "stato" ? (VOL_STATI[x] || x || "") : String(x ?? "");
  return VOL_CAMPI_DIFF
    .filter(([k]) => val(k, e[k]) !== val(k, r[k]))
    .map(([k, l]) => ({ campo:l, prima:val(k, e[k]), dopo:val(k, r[k]) }));
}

function volImportAnteprima(dati, mappa){
  const record = dati.map((riga, i) => volCostruisciRecord(riga, mappa, i + 1)).filter(r => r.cf || r.grezzo);
  const sezNote = new Set(_vol.sezioni.map(s => s.sezione));
  // nome Sezione scritto in modo diverso (es. MONDOVI o MONDOVÌ invece di MONDOVI'): lo riconduco a quello del PIA
  const sezPerLettere = new Map(_vol.sezioni.map(s => [volLettere(s.sezione), s.sezione]));
  record.forEach(r => { if (!sezNote.has(r.sezione) && sezPerLettere.has(volLettere(r.sezione))) r.sezione = sezPerLettere.get(volLettere(r.sezione)); });
  const esistenti = new Map(_vol.volontari.map(v => [v.cf, v]));
  const g = { nuovi:[], aggiornati:[], invariati:[], non_in_pia:[], dimessi:[], cf_non_validi:[], sezioni_ignote:[], altre:[], da_verificare:[] };
  const visti = new Set();
  const valide = [];

  record.forEach(r => {
    if (!cfValido(r.cf)){ g.cf_non_validi.push(r); return; }
    if (!sezNote.has(r.sezione)){ g.sezioni_ignote.push(r); return; }
    if (!r.cognome){ g.altre.push({ ...r, motivo:"cognome mancante" }); return; }
    if (visti.has(r.cf)){ g.altre.push({ ...r, motivo:"CF ripetuto nell'import" }); return; }
    visti.add(r.cf);
    const e = esistenti.get(r.cf);
    // separazione incerta ma il nome completo è lo stesso già salvato: tengo quella salvata
    if (r.da_verificare && e && !e.da_verificare && volNorm(`${e.cognome} ${e.nome}`) === r.grezzo){
      r.cognome = e.cognome; r.nome = e.nome; r.da_verificare = false;
    }
    r.stato = r.obsoleto ? "DIMESSO" : "ATTIVO";
    valide.push(r);
    if (r.da_verificare) g.da_verificare.push(r);
    if (r.obsoleto && (!e || e.stato !== "DIMESSO")){ g.dimessi.push({ ...r, e }); return; }
    if (!e){ g.nuovi.push(r); return; }
    const diff = volDifferenze(e, r);
    (diff.length ? g.aggiornati : g.invariati).push({ ...r, e, diff });
  });

  const sezImport = [...new Set(valide.map(r => r.sezione))];
  _vol.volontari.forEach(v => {
    if (v.stato === "ATTIVO" && sezImport.includes(v.sezione) && !visti.has(v.cf)) g.non_in_pia.push(v);
  });
  const scartati = g.cf_non_validi.length + g.sezioni_ignote.length + g.altre.length;
  _volImport = { valide, sezioni:sezImport, scartati };

  // avviso se in una Sezione sparisce una parte grossa dei volontari (copia incompleta?)
  const avvisi = sezImport.map(s => {
    const attivi = _vol.volontari.filter(v => v.sezione === s && v.stato === "ATTIVO").length;
    const spariti = g.non_in_pia.filter(v => v.sezione === s).length;
    return attivi >= 10 && spariti / attivi > 0.3 ? `${s}: ${spariti} volontari attivi su ${attivi} passerebbero a "Non in PIA"` : null;
  }).filter(Boolean);

  const persona = r => `${escapeHtml(r.cognome)} ${escapeHtml(r.nome)}`;
  const gruppo = (titolo, lista, colonne, riga, apri = false, classe = "") => {
    if (!lista.length) return "";
    const MAX = 300;
    return `
      <details class="vol-imp-gruppo ${classe}" ${apri ? "open" : ""}>
        <summary><b>${lista.length}</b> ${titolo}</summary>
        <table class="storico-table">
          <thead><tr>${colonne.map(c => `<th>${c}</th>`).join("")}</tr></thead>
          <tbody>${lista.slice(0, MAX).map(riga).join("")}</tbody>
        </table>
        ${lista.length > MAX ? `<p class="vol-pop-nota">… e altri ${lista.length - MAX}.</p>` : ""}
      </details>`;
  };

  const body = document.getElementById("vol-imp-body");
  body.innerHTML = `
    <div class="vol-imp-riep">
      <span><b>${g.nuovi.length}</b> nuovi</span><span><b>${g.aggiornati.length}</b> aggiornati</span>
      <span><b>${g.invariati.length}</b> invariati</span><span><b>${g.non_in_pia.length}</b> diventano "Non in PIA"</span>
      <span><b>${g.dimessi.length}</b> dimessi</span><span><b>${g.da_verificare.length}</b> da verificare</span>
      <span><b>${scartati}</b> scartati</span>
    </div>
    <p style="font-size:12.5px;color:var(--grigio-600);">Sezioni nell'import (${sezImport.length}): ${escapeHtml(sezImport.join(", ") || "nessuna")}</p>
    ${avvisi.length ? `<div class="vol-avviso"><b>Attenzione:</b> ${avvisi.map(escapeHtml).join("<br>")}<br>Hai copiato tutte le righe (Righe = TUTTE nel PIA)?</div>` : ""}
    ${gruppo("nuovi", g.nuovi, ["Cognome e nome","CF","Sezione","Gruppo"], r => `<tr><td>${persona(r)}</td><td class="vol-cf">${r.cf}</td><td>${escapeHtml(r.sezione)}</td><td>${escapeHtml(r.gruppo)}</td></tr>`)}
    ${gruppo("aggiornati", g.aggiornati, ["Cognome e nome","CF","Differenze"], r => `<tr><td>${persona(r)}</td><td class="vol-cf">${r.cf}</td><td>${r.diff.map(d => `${escapeHtml(d.campo)}: <s>${escapeHtml(d.prima) || "—"}</s> → <b>${escapeHtml(d.dopo) || "—"}</b>`).join("<br>")}</td></tr>`, true)}
    ${gruppo("invariati", g.invariati, ["Cognome e nome","CF","Sezione"], r => `<tr><td>${persona(r)}</td><td class="vol-cf">${r.cf}</td><td>${escapeHtml(r.sezione)}</td></tr>`)}
    ${gruppo('diventeranno "Non in PIA"', g.non_in_pia, ["Cognome e nome","CF","Sezione","Gruppo"], v => `<tr><td>${persona(v)}</td><td class="vol-cf">${v.cf}</td><td>${escapeHtml(v.sezione)}</td><td>${escapeHtml(v.gruppo || "")}</td></tr>`, true, "attenzione")}
    ${gruppo("dimessi (OBSOLETO = SI)", g.dimessi, ["Cognome e nome","CF","Sezione"], r => `<tr><td>${persona(r)}</td><td class="vol-cf">${r.cf}</td><td>${escapeHtml(r.sezione)}</td></tr>`)}
    ${gruppo("CF non validi (scartati)", g.cf_non_validi, ["Riga","Cognome e nome","CF","Sezione"], r => `<tr><td>${r.n}</td><td>${escapeHtml(r.grezzo)}</td><td class="vol-cf">${escapeHtml(r.cf)}</td><td>${escapeHtml(r.sezione)}</td></tr>`, true, "errore")}
    ${gruppo("con Sezione non riconosciuta (scartati)", g.sezioni_ignote, ["Riga","Cognome e nome","CF","Sezione"], r => `<tr><td>${r.n}</td><td>${escapeHtml(r.grezzo)}</td><td class="vol-cf">${r.cf}</td><td><b>${escapeHtml(r.sezione) || "(vuota)"}</b></td></tr>`, true, "errore")}
    ${gruppo("altre righe scartate", g.altre, ["Riga","Cognome e nome","CF","Motivo"], r => `<tr><td>${r.n}</td><td>${escapeHtml(r.grezzo)}</td><td class="vol-cf">${r.cf}</td><td>${escapeHtml(r.motivo)}</td></tr>`, true, "errore")}
    ${gruppo("da verificare (separazione cognome/nome incerta)", g.da_verificare, ["Dal PIA","Cognome","Nome","CF"], r => `<tr><td>${escapeHtml(r.grezzo)}</td><td><b>${escapeHtml(r.cognome)}</b></td><td>${escapeHtml(r.nome)}</td><td class="vol-cf">${r.cf}</td></tr>`)}
    <div class="form-actions">
      <button type="button" class="btn-cancel" id="vol-imp-indietro">Indietro</button>
      <button type="button" class="btn-save" id="vol-imp-conferma" ${valide.length ? "" : "disabled"}>Conferma import (${valide.length})</button>
    </div>`;
  body.querySelector("#vol-imp-indietro").addEventListener("click", volImportPasso1);
  body.querySelector("#vol-imp-conferma").addEventListener("click", volImportConferma);
}

async function volImportConferma(ev){
  if (!_volImport || !_volImport.valide.length) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = "Import in corso…";
  const p_righe = _volImport.valide.map(r => ({
    cf:r.cf, cognome:r.cognome, nome:r.nome, sezione:r.sezione, gruppo:r.gruppo, squadra:r.squadra,
    matricola_gisa:r.matricola_gisa, matricola_vola:r.matricola_vola, obsoleto:r.obsoleto, da_verificare:r.da_verificare
  }));
  const { data, error } = await sb.rpc("vol_importa", { p_righe, p_sezioni:_volImport.sezioni, p_scartati:_volImport.scartati });
  if (error){
    btn.disabled = false;
    btn.textContent = "Conferma import";
    alert("Import non riuscito, nessun dato modificato.\n\n" + error.message);
    return;
  }
  _volImport = null;
  const errCarica = await volCaricaDati();
  const body = document.getElementById("vol-imp-body");
  if (body) body.innerHTML = `
    <div class="vol-imp-riep">
      <span><b>${data.nuovi}</b> nuovi</span><span><b>${data.aggiornati}</b> aggiornati</span><span><b>${data.invariati}</b> invariati</span>
      <span><b>${data.non_in_pia}</b> Non in PIA</span><span><b>${data.dimessi}</b> dimessi</span>
      <span><b>${data.da_verificare}</b> da verificare</span><span><b>${data.scartati}</b> scartati</span>
    </div>
    <p>Import completato e registrato.${errCarica ? " Errore nel ricaricare la pagina: " + escapeHtml(errCarica) : ""}</p>
    <div class="form-actions"><button type="button" class="btn-save" onclick="chiudiModal()">Chiudi</button></div>`;
  volDisegnaPagina();
}
