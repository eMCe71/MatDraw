/* Administrator's page "Uprawnienia" (#permissions): the permission matrix of backend/src/Permissions.php as a table, rows = account
 * types, columns = permissions, a checkbox at every intersection. Loaded lazily by settings-boot.js, Administrator only.
 * Tabs: "Wszystkie dyscypliny" (the global set) and one tab per discipline (sports.js); a discipline uses the global set until the
 * Administrator gives it its own set; then only the permissions that may differ per discipline are edited there.
 * Fixed cells (the Administrator's own abilities, abilities the code was not built for) are drawn locked and are never sent.
 * The last column "Paid account" (billing.required) is not an ability: who needs a subscription while payments are required in
 * Ustawienia (Access::compute); per discipline like the others (one subscription per account, required for actions in a
 * discipline where the account type pays), the Administrator is fixed free.
 * Routes: GET admin-permissions {version, global, sports, updatedAt, updatedBy, sportsList}; POST admin-permissions-save
 * {version, global, sports} → the same view (409 code stale: reloaded). Every API value reaches the DOM through h`…`.
 * The plain functions up to "Page" are pure and tested in tests/permissions.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,translateMessage} from './i18n.js';
import {SPORTS} from './sports.js';
import {TYPES,PERMS,EDITABLE,editable,fixedValue,normalize,defaults} from './permissions.js';
import {fmtTime} from './admin-members.js';

const TYPE_TEXT={admin:[()=>T('Administrator'),()=>T('Pełny dostęp. Nie można go ograniczyć.')],editor:[()=>T('Edytor'),()=>T('Personel MatBravo')],
 club:[()=>T('Klub'),()=>T('Reprezentant klubu')],organizer:[()=>T('Organizator'),()=>T('Członek z rolą organizatora turnieju')],
 athlete:[()=>T('Zawodnik'),()=>T('Członek z własnym profilem zawodnika')],guardian:[()=>T('Opiekun'),()=>T('Rodzic lub opiekun z profilem dziecka')],
 member:[()=>T('Członek'),()=>T('Konto bez roli organizatora i bez profilu zawodnika')],guest:[()=>T('Gość'),()=>T('Osoba niezalogowana')]};
const PERM_TEXT={'tournament.create':()=>T('Tworzy turnieje'),'tournament.manage':()=>T('Prowadzi turnieje'),'athletes.manage':()=>T('Dodaje i edytuje zawodników'),
 'entries.submit':()=>T('Zgłasza zawodników do turniejów'),'entries.self':()=>T('Zgłasza siebie lub dziecko'),'chat.write':()=>T('Pisze na czacie'),
 'chat.moderate':()=>T('Moderuje czat'),'admin.manage':()=>T('Konta, kluby, ustawienia i uprawnienia'),'billing.required':()=>T('Płatne konto')};
const PERM_HINT={'tournament.manage':()=>T('edycja, kontrola startowa, losowania, wyniki'),'billing.required':()=>T('wymaga subskrypcji, gdy płatności są włączone')};
/** The scope of an allowed cell, under its checkbox (what "allowed" means for this account type). */
const CELL_HINT={'admin|tournament.manage':()=>T('wszystkie'),'admin|athletes.manage':()=>T('wszyscy'),'admin|entries.submit':()=>T('wszystkie'),
 'editor|tournament.manage':()=>T('własne'),'editor|athletes.manage':()=>T('własni'),'club|athletes.manage':()=>T('swój klub'),'club|entries.submit':()=>T('swój klub'),
 'organizer|tournament.create':()=>T('limit 3 na dobę'),'organizer|tournament.manage':()=>T('własne'),'organizer|athletes.manage':()=>T('własni'),'organizer|entries.submit':()=>T('własni'),
 'athlete|entries.self':()=>T('siebie'),'guardian|entries.self':()=>T('dziecko')};
/** The column drawn apart from the abilities (not an ability: who pays). */
const BILLING='billing.required';
export const typeName=type=>(TYPE_TEXT[type]||[()=>type])[0]();
export const permName=perm=>(PERM_TEXT[perm]||(()=>perm))();
const sportName=slug=>T(SPORTS.find(s=>s.id===slug)?.label??slug);

// ---- Pure model ----
const clone=v=>JSON.parse(JSON.stringify(v));
/** The editable draft of a view: {global, sports} with every editable cell (Permissions::normalize). */
export function draftOf(view){return normalize({global:view?.global??{},sports:view?.sports??{}})??defaults();}
/** The value a cell shows in tab $sport ('all' or a slug): the sport's own set, else the global set; fixed cells their fixed value. */
export function cellValue(draft,type,perm,sport='all'){
 if(!editable(type,perm))return fixedValue(type,perm);
 if(sport!=='all'&&PERMS[perm]==='sport'&&draft.sports?.[sport])return draft.sports[sport][type]?.[perm]!==false;
 return (draft.global?.[type]?.[perm]??fixedValue(type,perm))===true;
}
/** Whether the cell can be switched in tab $sport: editable, and in a discipline tab only sport-scoped cells of a discipline with its own set. */
export function cellOpen(draft,type,perm,sport='all'){
 if(!editable(type,perm))return false;
 return sport==='all'||PERMS[perm]==='sport'&&!!draft.sports?.[sport];
}
/** A new draft with the cell set to $on (no change for a cell that is not open). */
export function setCell(draft,type,perm,sport,on){
 if(!cellOpen(draft,type,perm,sport))return draft;
 const next=clone(draft);if(sport==='all')next.global[type][perm]=!!on;else next.sports[sport][type][perm]=!!on;return next;
}
/** Gives discipline $sport its own set (a copy of the sport-scoped cells of the global set) or, with own=false, back to the global set. */
export function setOwn(draft,sport,own){
 const next=clone(draft);
 if(!own){delete next.sports[sport];return next;}
 if(next.sports[sport])return next;
 const set={};for(const [type,perms] of Object.entries(EDITABLE))for(const perm of perms)if(PERMS[perm]==='sport')(set[type]??={})[perm]=next.global[type][perm]!==false;
 next.sports[sport]=set;return next;
}
/** Number of differences between two drafts (cells and disciplines that got or lost their own set). */
export function changes(a,b){
 let n=0;const x=normalize(a)??defaults(),y=normalize(b)??defaults();
 for(const [type,perms] of Object.entries(EDITABLE))for(const perm of perms)if(x.global[type][perm]!==y.global[type][perm])n++;
 for(const s of SPORTS.map(s=>s.id)){
  const p=x.sports[s],q=y.sports[s];if(!p&&!q)continue;if(!p||!q){n++;continue;}
  for(const [type,perms] of Object.entries(q))for(const [perm,v] of Object.entries(perms))if(p[type]?.[perm]!==v)n++;
 }
 return n;
}
/** Body of admin-permissions-save. */
export const saveBody=(view,draft)=>({version:Number.isInteger(view?.version)?view.version:0,global:draft.global,sports:draft.sports});
/** Disciplines with their own set. */
export const ownSports=draft=>Object.keys(draft?.sports||{});

/** The history note of Permissions::diff ("editor.tournament.create=0, karate=own, judo=inherit") in words. */
export function permissionsNote(note){
 if(typeof note!=='string'||!note||note==='unchanged')return note==='unchanged'?T('bez zmian'):'';
 return note.split(', ').map(token=>{
  let m=/^(?:([a-z]+) )?([a-z]+)\.([a-z]+\.[a-z]+)=([01])$/.exec(token);
  if(m&&TYPES.includes(m[2])&&PERMS[m[3]])return (m[1]?sportName(m[1])+' · ':'')+typeName(m[2])+': '+permName(m[3])+' '+(m[4]==='1'?T('włączone'):T('wyłączone'));
  m=/^([a-z]+)=(own|inherit)$/.exec(token);
  if(m)return sportName(m[1])+': '+(m[2]==='own'?T('własny zestaw'):T('jak domyślnie'));
  return token;
 }).join(' · ');
}

// ---- Views ----
function tabsView(draft,sport){
 const tab=(id,label,own)=>h`<button type="button" class="prm-tab${sport===id?' is-active':''}" role="tab" aria-selected="${sport===id?'true':'false'}" data-prm-act="tab" data-prm-sport="${id}">${label}${own?h` <span class="prm-dot" title="${T('Własny zestaw')}" aria-label="${T('Własny zestaw')}">●</span>`:''}</button>`;
 return h`<div class="prm-tabs" role="tablist" aria-label="${T('Dyscyplina')}">${tab('all',T('Wszystkie dyscypliny'),false)}${SPORTS.map(s=>tab(s.id,T(s.label),!!draft.sports[s.id]))}</div>`;
}
function modeView(draft,sport){
 if(sport==='all')return h`<p class="muted small">${T('To ustawienia domyślne. Dyscypliny bez własnego zestawu korzystają właśnie z nich.')}</p>`;
 const own=!!draft.sports[sport];
 return h`<fieldset class="set-options set-options-two prm-mode"><legend class="set-legend">${T('Uprawnienia w dyscyplinie {sport}',{sport:sportName(sport)})}</legend>
  <label class="set-option"><input type="radio" name="prm-mode" value="inherit" data-prm-act="mode" ${own?'':'checked'}><span><strong>${T('Jak domyślnie')}</strong><small>${T('Ta dyscyplina korzysta z ustawień „Wszystkie dyscypliny”.')}</small></span></label>
  <label class="set-option"><input type="radio" name="prm-mode" value="own" data-prm-act="mode" ${own?'checked':''}><span><strong>${T('Własny zestaw')}</strong><small>${T('Osobne uprawnienia tylko dla tej dyscypliny.')}</small></span></label></fieldset>`;
}
function cellView(draft,type,perm,sport){
 const on=cellValue(draft,type,perm,sport),open=cellOpen(draft,type,perm,sport),fixed=!editable(type,perm),hint=on?CELL_HINT[type+'|'+perm]:null;
 const label=T('{type}: {perm}',{type:typeName(type),perm:permName(perm)});
 const why=fixed?T('Stałe, nie można zmienić'):!open?(PERMS[perm]==='global'?T('Wspólne dla wszystkich dyscyplin. Zmień w zakładce „Wszystkie dyscypliny”.'):T('Wybierz „Własny zestaw”, aby zmienić w tej dyscyplinie.')):'';
 return h`<td class="prm-cell${perm===BILLING?' prm-billing':''}${fixed?' is-fixed':''}${!open&&!fixed?' is-inherited':''}"><label class="prm-check" title="${why}"><input type="checkbox" data-prm-act="cell" data-prm-type="${type}" data-prm-perm="${perm}" aria-label="${label}" ${on?'checked':''} ${open?'':'disabled'}>${fixed?h`<span class="prm-lock" aria-hidden="true">🔒</span>`:''}</label>${hint?h`<small class="prm-hint">${hint()}</small>`:''}</td>`;
}
function tableView(draft,sport){
 const perms=Object.keys(PERMS);
 return h`<div class="prm-scroll" tabindex="0" role="region" aria-label="${T('Tabela uprawnień')}"><table class="prm-table"><thead><tr><th scope="col" class="prm-corner">${T('Rodzaj konta')}</th>${perms.map(p=>h`<th scope="col"${p===BILLING?h` class="prm-billing"`:''}><span>${permName(p)}</span>${PERM_HINT[p]?h`<small>${PERM_HINT[p]()}</small>`:''}${PERMS[p]==='global'?h`<small class="prm-global">${T('wspólne dla dyscyplin')}</small>`:''}</th>`)}</tr></thead>
  <tbody>${TYPES.map(type=>h`<tr><th scope="row"><strong>${typeName(type)}</strong><small>${(TYPE_TEXT[type]||[0,()=>''])[1]()}</small></th>${perms.map(p=>cellView(draft,type,p,sport))}</tr>`)}</tbody></table></div>`;
}
const NOTES=[()=>T('„Płatne konto” decyduje, kto musi mieć subskrypcję, ale tylko wtedy, gdy płatności są włączone w Ustawieniach (tryb rejestracji „Otwarta, płatna” albo „Wyłączona” z wymaganiem płatności). Przy płatnościach wyłączonych nikt nie płaci.'),
 ()=>T('Subskrypcja jest jedna na całe konto. W dyscyplinie, w której rodzaj konta jest darmowy, wszystko działa bez niej; w płatnej dyscyplinie (zgłoszenia, turnieje, czat turnieju) serwer poprosi o subskrypcję. Profil i czat ogólny działają bez subskrypcji, jeśli konto jest darmowe choć w jednej dyscyplinie.'),
 ()=>T('Darmowe konto albo „Wymagaj płatności” ustawione konkretnej osobie w panelu Członkowie zawsze wygrywa z ustawieniem jej rodzaju konta. Osoba z kilkoma rodzajami kont płaci, jeśli choć jeden z nich jest płatny. Kto już ma subskrypcję, płaci dalej, dopóki jej nie zatrzymasz.'),
 ()=>T('Pisanie na czacie wymaga też pełnego dostępu (subskrypcji) i uzupełnionego profilu.'),
 ()=>T('Osoba, która ma kilka ról (np. organizator i rodzic), ma sumę ich uprawnień.'),
 ()=>T('Wyłączenie „Prowadzi turnieje” zabiera też narzędzia w turniejach już utworzonych (kontrola startowa, losowania, wyniki), dopóki nie włączysz go z powrotem.'),
 ()=>T('Wycofanie i poprawka zgłoszenia już złożonego oraz usunięcie własnych danych działają zawsze.'),
 ()=>T('Pola z kłódką są stałe: Administrator ma zawsze pełny dostęp, a pozostałych możliwości kod MatBravo nie przewiduje dla danego rodzaju konta.')];
export function pageView(st){
 const v=st.view,d=st.draft,n=changes(draftOf(v),d),own=ownSports(d);
 const last=v.updatedAt?T('Ostatnia zmiana: {date}',{date:fmtTime(Date.parse(v.updatedAt)/1000)})+(v.updatedBy?.email?' · '+v.updatedBy.email:''):T('Obowiązują ustawienia domyślne (takie jak przed wprowadzeniem tej strony).');
 return h`<section class="panel set-section prm-section"><h2>${T('Kto co może')}</h2>
  <p class="muted">${T('Zaznacz, co może każdy rodzaj konta. Zmiana działa od razu po zapisaniu, bez wdrożenia. Serwer sprawdza uprawnienia przy każdej operacji.')}</p>
  ${tabsView(d,st.sport)}${modeView(d,st.sport)}${tableView(d,st.sport)}
  <p class="muted small" role="status">${last}${own.length?' · '+T('Własny zestaw: {list}',{list:own.map(sportName).join(', ')}):''}</p>
  <div class="set-row prm-actions"><button type="button" class="btn primary" data-prm-act="save" ${n?'':'disabled'}>${T('Zapisz uprawnienia')}</button>
   <button type="button" class="btn" data-prm-act="discard" ${n?'':'disabled'}>${T('Odrzuć zmiany')}</button>
   <button type="button" class="btn ghost" data-prm-act="defaults">${T('Przywróć domyślne')}</button>
   ${n?h`<span class="set-pending" role="status">${T('Niezapisane zmiany: {n}',{n})}</span>`:''}</div>
  <p class="form-error" role="alert">${st.error||''}</p></section>
  <section class="panel set-section"><h2>${T('Warto wiedzieć')}</h2><ul class="prm-notes">${NOTES.map(x=>h`<li>${x()}</li>`)}</ul></section>`;
}

// ---- Page ----
export const io={request:(route,options)=>Client.request(route,options),demo:Client.isDemo};
const st={view:null,draft:null,sport:'all',error:'',loadError:'',seq:0,busy:false};
export const state=st;
registry.on('logout',()=>{st.seq++;st.view=null;st.draft=null;st.error='';st.loadError='';});
const ui=()=>registry.use('ui');
const toast=message=>ui()?.toast?.(message);
const root=()=>typeof document!=='undefined'?document.querySelector('[data-permissions-root]'):null;
function paint(){
 const el=root();if(!el)return;
 if(st.loadError&&!st.view){setHtml(el,h`<div class="panel set-state"><p class="form-error" role="alert">${st.loadError}</p><button type="button" class="btn" data-prm-act="retry">${T('Spróbuj ponownie')}</button></div>`);return;}
 if(!st.view){setHtml(el,h`<p class="muted" role="status">${T('Wczytuję uprawnienia…')}</p>`);return;}
 setHtml(el,pageView(st));
}
export async function load(){
 const seq=++st.seq;st.loadError='';
 try{const view=await io.request('admin-permissions');if(seq!==st.seq)return;st.view=view;st.draft=draftOf(view);st.error='';}
 catch(error){if(seq!==st.seq)return;st.loadError=translateMessage(error.message);}
 paint();
}
/** One save: the new view, or the error under the table; a stale version reloads the page with the server's matrix. */
export async function save(){
 if(!st.view||st.busy)return;st.busy=true;st.error='';
 try{st.view=await io.request('admin-permissions-save',{method:'POST',body:saveBody(st.view,st.draft)});st.draft=draftOf(st.view);paint();toast(T('Zapisano uprawnienia.'));}
 catch(error){if(error?.data?.code==='stale'||error?.code==='stale'){await load();toast(translateMessage(error.message));}else{st.error=translateMessage(error.message);paint();}}
 finally{st.busy=false;}
}
export function mountPermissionsPage(el=root()){
 if(!el||el.dataset.prmMounted)return;el.dataset.prmMounted='1';
 if(io.demo){setHtml(el,h`<section class="panel set-section"><h2>${T('Uprawnienia działają z serwerem')}</h2><p class="muted">${T('Ta funkcja jest niedostępna w wersji demonstracyjnej.')}</p></section>`);return;}
 paint();load();
}
const ACTS={
 retry:()=>load(),
 tab:el=>{st.sport=el.dataset.prmSport||'all';paint();root()?.querySelector(`[data-prm-act="tab"][data-prm-sport="${st.sport}"]`)?.focus?.();},
 mode:el=>{if(st.sport==='all')return;st.draft=setOwn(st.draft,st.sport,el.value==='own');paint();},
 cell:el=>{st.draft=setCell(st.draft,el.dataset.prmType,el.dataset.prmPerm,st.sport,el.checked);paint();root()?.querySelector(`[data-prm-act="cell"][data-prm-type="${el.dataset.prmType}"][data-prm-perm="${el.dataset.prmPerm}"]`)?.focus?.();},
 discard:()=>{st.draft=draftOf(st.view);st.error='';paint();},
 defaults:()=>{st.draft=defaults();paint();},
 save:()=>save()
};
function onEvent(event){
 const el=event.target.closest?.('[data-prm-act]');if(!el||el.disabled||!el.closest('[data-permissions-root]'))return;
 const kind=el.dataset.prmAct;if((kind==='cell'||kind==='mode')!==(event.type==='change'))return;
 const act=ACTS[kind];if(!act)return;
 Promise.resolve().then(()=>act(el)).catch(error=>toast(translateMessage(error.message)));
}
if(typeof document!=='undefined'){document.addEventListener('click',onEvent);document.addEventListener('change',onEvent);}
