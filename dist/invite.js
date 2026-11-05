/* The organizer's invitation (docs/plan/PLAN-MATERIALY.md §6): an elegant invitation from the organizer on the tournament's page,
 * next to the poster (Bogdan's template: event, venue, street, dates, the rules to download, categories, special techniques, strength
 * tests, the dates of entries, a closing note), in one of three visual styles (INVITE_STYLES: classic, gala, sport).
 * Contract: every tournament view may carry the sparse field invite {v, style}; the demo's views add fields. The fields come from the
 * material route (api/index.php?route=material&t=<id>&k=invite&v=<v>, JSON {style, fields}), the demo reads them from this browser.
 * Writing: invite-save (JSON {t, style, fields}) and material-delete {t, kind:'invite'}; the demo runs tournament.material with the
 * stored meta {s, d, at} (dist/invite-data.js mirrors Materials::inviteField and the strict check).
 *  - The "Materials" section of the tournament dialog shows the invitation row (block, through registry.provide('invite')): create,
 *    edit, remove with a confirmation; a new tournament gets it after it is created.
 *  - The editor is a full-screen sheet over the dialog: the style picker, the template's fields prefilled for a new invitation and a
 *    live preview (side by side on wide screens, a switch on phones); closing with unsaved changes asks first.
 *  - The guest page shows the card under the poster (guestSection, filled after the page is painted).
 * Templates (h`...` only, tests/xss-scan): user text never becomes markup; lists are one item per line. Pure helpers are exported for
 * tests/invite-ui.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,locale} from './i18n.js';
import {INVITE_FIELDS,INVITE_KEYS,INVITE_STYLES,inviteFields,chars} from './invite-data.js';
import {openLayer,closeLayer,layerOpen,messageOf,applied,reauth,removeMaterial,repaintSection,written,rulesLink,rulesOf} from './materials.js';

export {INVITE_FIELDS,INVITE_KEYS,INVITE_STYLES};
const ui=()=>registry.use('ui');
const icon=(name,cls='')=>ui()?.icon?.(name,cls)??'';

// ---- Data ----
/** The sparse invite of a tournament view, checked: {v, style, fields|null} or null. */
export function inviteOf(t){
 const i=t?.invite;if(!i||typeof i!=='object')return null;
 const style=INVITE_STYLES.includes(i.style)?i.style:'classic',f=i.fields&&typeof i.fields==='object'?i.fields:null;
 return {v:String(i.v??''),style,fields:f?pick(f):null};
}
/** Only the known fields, as strings. */
const pick=f=>{const out={};for(const k of INVITE_KEYS)if(typeof f?.[k]==='string'&&f[k])out[k]=f[k];return out;};
/** Names of the styles for the picker and the row. */
export const styleName=s=>({classic:T('Klasyczny'),gala:T('Gala'),sport:T('Sportowy')})[s]||T('Klasyczny');
const styleNote=s=>({classic:T('Kremowy papier, szeryfowe litery, złota linia.'),gala:T('Granat i złoto, uroczyście.'),sport:T('Biel i barwy MatBravo, dynamicznie.')})[s]||'';
/** Items of a multiline field: one per line, a leading "1.", "1)", "-", "•" or "–" dropped, empty lines skipped. */
export function lines(text){return String(text??'').split('\n').map(l=>l.trim().replace(/^(?:\d{1,3}[.)]|[-*•–])\s+/,'').trim()).filter(Boolean);}
const cache=new Map();
/** {style, fields} of tournament t: from the view (the demo's workspace), the demo's data, else the material route, kept per version. */
export async function loadInvite(t){
 const i=inviteOf(t);if(!i)return null;
 if(i.fields)return {style:i.style,fields:i.fields};
 const key=String(t.id)+'|'+i.v;if(cache.has(key))return cache.get(key);
 const fail=()=>{const e=new Error(T('Nie udało się wczytać zaproszenia. Sprawdź połączenie i spróbuj ponownie.'));e.materials=true;return e;};
 let out;
 if(Client.isDemo){const x=Client.demoInvite(String(t.id));if(!x)throw fail();out={style:INVITE_STYLES.includes(x.style)?x.style:i.style,fields:pick(x.fields)};}
 else{
  let res;try{res=await fetch(Client.apiUrl({route:'material',t:String(t.id),k:'invite',v:i.v}),{credentials:'same-origin',headers:{Accept:'application/json','X-MatBravo-Client':String(Client.CLIENT_API)}});}catch{throw fail();}
  if(!res.ok)throw fail();let data;try{data=await res.json();}catch{throw fail();}
  out={style:INVITE_STYLES.includes(data?.style)?data.style:i.style,fields:pick(data?.fields)};
 }
 cache.set(key,out);return out;
}
const cached=t=>{const i=inviteOf(t);if(!i)return null;if(i.fields)return {style:i.style,fields:i.fields};return cache.get(String(t?.id)+'|'+i.v)||null;};

// ---- The card ----
/** The invitation as SafeHtml: fields {event, venue, …}, style, t the tournament (its rules give the "download" link), live false in
 * the editor's preview (links drawn as text there). Parts without data are left out; the rules and categories lines are the template. */
export function renderInvite(fields,{style='classic',t=null,live=true,id='inv'}={}){
 const f=pick(fields),st=INVITE_STYLES.includes(style)?style:'classic',strong=x=>h`<strong>${x}</strong>`;
 const ol=items=>h`<ol class="inv-list">${items.map(x=>h`<li>${x}</li>`)}</ol>`;
 const hasRules=!!rulesOf(t);
 const download=hasRules?(live?rulesLink(t,{cls:'inv-rules-link',label:T('do pobrania stąd')}):h`<span class="inv-rules-link">${T('do pobrania stąd')}</span>`):'';
 // The venue sentence of the template: venue, street and dates, each optional.
 const where=[f.venue?h`${T('które odbędą się w')} ${strong(f.venue)}`:'',f.street?h`${f.venue?'':T('które odbędą się')+' '}${T('przy ulicy')} ${strong(f.street)}`:'',f.dates?h`${f.venue||f.street?'':T('które odbędą się')+' '}${T('w dniach')} ${strong(f.dates)}`:''].filter(String);
 const special=lines(f.special),women=lines(f.women),men=lines(f.men);
 const strength=women.length||men.length?h`<section class="inv-block"><h3 class="inv-h">${T('Testy siły')}</h3><p class="inv-muted">${T('W następującej kolejności:')}</p><div class="inv-cols">${women.length?h`<div class="inv-col"><h4>${T('Kobiety')}</h4>${ol(women)}</div>`:''}${men.length?h`<div class="inv-col"><h4>${T('Mężczyźni')}</h4>${ol(men)}</div>`:''}</div></section>`:'';
 const reg=f.open||f.close?h`<div class="inv-dates">${f.open?h`<div class="inv-date"><span>${T('Początek przyjmowania zgłoszeń')}</span><strong>${f.open}</strong></div>`:''}${f.close?h`<div class="inv-date"><span>${T('Zamknięcie list startowych')}</span><strong>${f.close}</strong></div>`:''}</div>`:'';
 const title=f.event||String(t?.name??'');
 return h`<article class="inv inv-${st}" aria-labelledby="${id}-title"><div class="inv-paper"><header class="inv-head"><p class="inv-eyebrow">${T('Zaproszenie od Organizatora')}</p><p class="inv-lead">${T('Zapraszamy na')}</p><h2 class="inv-title" id="${id}-title">${title}</h2><span class="inv-rule" aria-hidden="true"><i></i></span>${where.length?h`<p class="inv-where">${where.map((x,i)=>i?h` ${x}`:x)}.</p>`:''}</header><div class="inv-body"><section class="inv-block"><h3 class="inv-h">${T('Zasady i kategorie')}</h3><p>${T('Zasady rozgrywania konkurencji – zgodnie z załączonym Regulaminem Zawodów')}${download?h` (${download})`:''}.</p><p>${T('Kategorie – zgodne z Regulaminem Zawodów')}${f.except?h`, ${T('z wyłączeniem:')} ${strong(f.except)}`:''}.</p></section>${special.length?h`<section class="inv-block"><h3 class="inv-h">${T('Techniki specjalne')}</h3><p class="inv-muted">${T('W kategorii Technik Specjalnych zostaną rozegrane następujące konkurencje (w kolejności):')}</p>${ol(special)}</section>`:''}${strength}${reg}${f.note?h`<p class="inv-note">${icon('info')}<span>${f.note.split('\n').filter(x=>x.trim()).map((x,i)=>i?h`<br>${x}`:x)}</span></p>`:''}</div><footer class="inv-foot">${f.closing?h`<p class="inv-closing">${f.closing}</p>`:''}${f.sign?h`<p class="inv-sign">${f.sign}</p>`:''}</footer></div></article>`;
}

// ---- Guest page ----
/** The invitation's place on the guest page (under the poster and the heading); '' without one. Filled now from the cache or the
 * demo, else after the page is painted (fill). */
export function guestSection(t){
 const i=inviteOf(t);if(!i)return h``;
 const data=cached(t);
 return h`<section class="inv-section" data-invite-mount data-id="${t.id}" data-v="${i.v}" aria-label="${T('Zaproszenie od Organizatora')}"${data?'':h` aria-busy="true"`}>${data?renderInvite(data.fields,{style:data.style,t,id:'inv-guest'}):h`<div class="inv-skeleton" aria-hidden="true"><i></i><i></i><i></i></div><p class="sr-only">${T('Wczytywanie zaproszenia…')}</p>`}</section>`;
}
/** Fills every empty invitation mount of the page; t of each comes from known (the guest page's tournament). */
const shown=new Map();
export function fill(root=typeof document!=='undefined'?document:null){
 for(const box of root?.querySelectorAll?.('[data-invite-mount][aria-busy="true"]')||[]){
  const t=shown.get(box.dataset.id);if(!t)continue;
  loadInvite(t).then(data=>{if(!box.isConnected||!data)return;setHtml(box,renderInvite(data.fields,{style:data.style,t,id:'inv-guest'}));box.removeAttribute('aria-busy');},()=>{if(!box.isConnected)return;box.removeAttribute('aria-busy');box.hidden=true;});
 }
}
/** guestSection for the guest page, remembering t for fill(). */
export function guest(t){if(t?.id&&inviteOf(t))shown.set(String(t.id),t);return guestSection(t);}

// ---- The row in the "Materials" section ----
let row={id:null,confirm:false,busy:false,error:'',done:''};
const resetRow=id=>{if(row.id!==id)row={id,confirm:false,busy:false,error:'',done:''};};
/** The invitation row of the tournament dialog (SafeHtml): t the tournament (or {} for a new one), id its id (null before it exists). */
export function block(t,id){
 resetRow(id);const i=id?inviteOf(t):null;
 let note,buttons='';
 if(!id)note=T('Przygotujesz je zaraz po utworzeniu turnieju.');
 else if(row.busy)note=T('Usuwanie…');
 else if(i)note=T('Szablon: {style}. Widoczne na stronie turnieju, pod plakatem.',{style:styleName(i.style)});
 else note=T('Gotowy wzór do uzupełnienia: termin, miejsce, konkurencje, testy siły i zapisy. Pojawi się na stronie turnieju, pod plakatem.');
 if(id&&!row.busy){
  if(row.confirm)buttons=h`<span class="mat-confirm-text">${T('Usunąć zaproszenie?')}</span><button type="button" class="btn small-btn mat-danger" data-action="invite-remove-confirm">${T('Usuń zaproszenie')}</button><button type="button" class="btn small-btn" data-action="invite-remove-cancel">${T('Anuluj')}</button>`;
  else if(i)buttons=h`<button type="button" class="btn small-btn" data-action="invite-edit" data-id="${id}">${icon('pencil')}<span>${T('Edytuj')}</span></button><button type="button" class="btn small-btn" data-action="invite-remove">${T('Usuń')}</button>`;
  else buttons=h`<button type="button" class="btn small-btn mat-side-pick" data-action="invite-edit" data-id="${id}">${icon('plus')}<span>${T('Utwórz zaproszenie')}</span></button>`;
 }
 return h`<div class="mat-invite${i?' has-file':''}${id?'':' is-off'}"><span class="mat-doc mat-doc-invite" aria-hidden="true">${icon('mail')}</span><div class="mat-side"><strong class="mat-label">${T('Zaproszenie od Organizatora')}</strong><p class="mat-note">${note}</p>${buttons?h`<div class="mat-buttons">${buttons}</div>`:''}<p class="mat-error" role="alert" id="mat-error-invite">${row.error}</p>${row.done?h`<p class="mat-done">${icon('check')}<span>${row.done}</span></p>`:''}</div></div>`;
}
const tournamentOf=id=>id?ui()?.getWorkspace?.()?.tournaments?.find(x=>x.id===id)||null:null;
async function removeInvite(){
 const id=row.id;if(!id||row.busy)return;
 row.confirm=false;row.busy=true;row.error='';row.done='';repaintSection();
 try{await removeMaterial('invite',id);row.busy=false;row.done=T('Zaproszenie usunięte.');written(row.done);}
 catch(error){row.busy=false;if(error?.status===401&&error?.code!=='reauth'||error?.status===402){await ui()?.handleError?.(error);return;}row.error=messageOf(error);}
 finally{row.busy=false;repaintSection();}
}

// ---- Sending ----
/** Saves the invitation of tournament id ({style, fields} already cleaned: d of inviteFields). */
export async function sendInvite(id,style,d){
 if(Client.isDemo){const ws=ui()?.getWorkspace?.();return applied(await Client.command('tournament.material',{id,kind:'invite',value:{s:style,d,at:Math.floor(Date.now()/1000)}},Number(ws?.revision)||0));}
 return applied(await reauth(()=>Client.request('invite-save',{method:'POST',body:{t:id,style,fields:d}})));
}

// ---- The editor ----
/** Field groups of the form: [legend, [[key, label, placeholder, hint]]] in the template's order. */
const GROUPS=()=>[
 [T('Wydarzenie'),[['event',T('Zapraszamy na'),T('np. Puchar Polski, Mistrzostwa Europy, Zawody Mikołajkowe')]]],
 [T('Miejsce i termin'),[['venue',T('Które odbędą się w'),T('np. Hali Sportowej Orbita we Wrocławiu')],['street',T('Przy ulicy'),T('np. Wejherowskiej 34')],['dates',T('W dniach'),T('np. 6–7 grudnia 2026')]]],
 [T('Regulamin i kategorie'),[['except',T('Kategorie – z wyłączeniem (opcjonalnie)'),T('np. kategorii seniorów powyżej 35 lat'),T('Puste pole: kategorie zgodne z Regulaminem Zawodów.')]]],
 [T('Techniki specjalne'),[['special',T('Konkurencje w kolejności'),[T('Jedna konkurencja w linii, np.'),'Twimyo Nopi Ap Chagi','Twimyo Dollyo Chagi'].join('\n'),T('Każda linia to kolejny punkt listy.')]]],
 [T('Testy siły'),[['women',T('Kobiety'),[T('Jedna próba w linii, np.'),T('Pompki – 30 s'),T('Przysiady – 30 s')].join('\n')],['men',T('Mężczyźni'),[T('Jedna próba w linii, np.'),T('Pompki – 30 s'),T('Podciąganie na drążku')].join('\n')]]],
 [T('Zgłoszenia'),[['open',T('Początek przyjmowania zgłoszeń'),T('np. 1 października 2026')],['close',T('Zamknięcie list startowych'),T('np. 20 listopada 2026, godz. 23:59')]]],
 [T('Zakończenie'),[['note',T('Uwaga dla klubów'),''],['closing',T('Hasło na koniec'),T('ZAPRASZAMY!')],['sign',T('Podpis (opcjonalnie)'),T('np. Klub Taekwondo Orbita Wrocław')]]]
];
/** The fields of a new invitation: the tournament's name and date, the note and the closing of the template. */
export function defaults(t){
 let dates='';try{if(/^\d{4}-\d{2}-\d{2}$/.test(String(t?.date)))dates=new Intl.DateTimeFormat(locale(),{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(t.date+'T12:00:00Z'));}catch{}
 return {event:String(t?.name??''),...(dates?{dates}:{}),note:T('Prosimy o zwracanie uwagi na informacje przesyłane do Klubów przez Organizatora!'),closing:T('ZAPRASZAMY!')};
}
let ed=null;
function fieldHtml([key,label,placeholder,hint]){
 const [max,multi]=INVITE_FIELDS[key],value=ed.fields[key]??'',fid='inv-f-'+key,help=hint?h` aria-describedby="${fid}-hint"`:'';
 const control=multi?h`<textarea id="${fid}" name="${key}" rows="${key==='note'?3:4}" maxlength="${max}" placeholder="${placeholder}"${help}>${value}</textarea>`:h`<input id="${fid}" name="${key}" maxlength="${max}" value="${value}" placeholder="${placeholder}" autocomplete="off"${help}>`;
 return h`<div class="inv-field${multi?' is-multi':''}${key==='women'||key==='men'||key==='open'||key==='close'?' is-half':''}"><label for="${fid}">${label}</label>${control}${hint?h`<small class="inv-hint" id="${fid}-hint">${hint}</small>`:''}</div>`;
}
function rulesState(t){
 return rulesOf(t)?h`<p class="inv-info is-ok">${icon('check')}<span>${T('Link „do pobrania stąd” prowadzi do regulaminu dodanego w sekcji Materiały.')}</span></p>`:h`<p class="inv-info">${icon('info')}<span>${T('Dodaj regulamin w sekcji Materiały, a w zaproszeniu pojawi się link do jego pobrania.')}</span></p>`;
}
function editorHtml(t){
 const styles=INVITE_STYLES.map(s=>h`<label class="inv-style inv-style-${s}"><input type="radio" name="style" value="${s}"${ed.style===s?h` checked`:''}><span class="inv-swatch" aria-hidden="true"><i></i><i></i><i></i></span><span class="inv-style-text"><strong>${styleName(s)}</strong><small>${styleNote(s)}</small></span></label>`);
 const groups=GROUPS().map(([legend,fields],i)=>h`<fieldset class="inv-group"><legend>${legend}</legend>${i===2?rulesState(t):''}<div class="inv-fields">${fields.map(fieldHtml)}</div></fieldset>`);
 return h`<div class="mat-viewer inv-editor-root"><section class="inv-editor" role="dialog" aria-modal="true" aria-labelledby="inv-ed-title" tabindex="-1" data-view="form"><header class="mat-sheet-bar inv-ed-bar"><div class="mat-sheet-title"><span class="mat-sheet-eyebrow">${icon('mail')}<span>${T('Zaproszenie od Organizatora')}</span></span><h2 id="inv-ed-title">${t.name}</h2></div><button type="button" class="mat-viewer-close mat-sheet-close" data-mat-viewer="close" aria-label="${T('Zamknij edytor')}" title="${T('Zamknij edytor')}">${icon('close')}</button></header><div class="inv-ed-switch mat-switch" role="group" aria-label="${T('Widok edytora')}"><button type="button" data-inv-view="form" aria-pressed="true">${T('Edycja')}</button><button type="button" data-inv-view="preview" aria-pressed="false">${T('Podgląd')}</button></div><div class="inv-ed-body"><form class="inv-ed-form" data-inv-form novalidate><fieldset class="inv-group inv-styles"><legend>${T('Szablon')}</legend><div class="inv-style-list">${styles}</div></fieldset>${groups}</form><div class="inv-ed-preview" data-inv-preview aria-label="${T('Podgląd zaproszenia')}" role="region" tabindex="0">${renderInvite(ed.fields,{style:ed.style,t,live:false,id:'inv-ed'})}</div></div><footer class="inv-ed-foot"><div class="inv-ed-msg"><p class="mat-error" role="alert" data-inv-error></p><div class="inv-ed-confirm" data-inv-confirm hidden><span>${T('Masz niezapisane zmiany.')}</span><button type="button" class="btn small-btn mat-danger" data-inv="discard">${T('Odrzuć zmiany')}</button><button type="button" class="btn small-btn" data-inv="stay">${T('Wróć do edycji')}</button></div></div><div class="inv-ed-actions"><button type="button" class="btn" data-inv="cancel">${T('Anuluj')}</button><button type="button" class="btn primary" data-inv="save">${icon('check')}<span>${T('Zapisz zaproszenie')}</span></button></div></footer></section></div>`;
}
const snapshot=()=>JSON.stringify([ed.style,inviteFields(ed.fields).d]);
const dirty=()=>!!ed&&snapshot()!==ed.initial;
function readForm(){
 const form=ed?.root?.querySelector('[data-inv-form]');if(!form)return;
 for(const k of INVITE_KEYS){const el=form.elements.namedItem(k);if(el)ed.fields[k]=el.value;}
 const s=form.querySelector('input[name="style"]:checked')?.value;if(INVITE_STYLES.includes(s))ed.style=s;
}
let frame=0;
function preview(){
 if(frame)return;const run=()=>{frame=0;if(!ed?.root?.isConnected)return;readForm();const box=ed.root.querySelector('[data-inv-preview]');if(box)setHtml(box,renderInvite(ed.fields,{style:ed.style,t:ed.t,live:false,id:'inv-ed'}));};
 frame=typeof requestAnimationFrame==='function'?requestAnimationFrame(run):setTimeout(run,16);
}
function setError(text){const p=ed?.root?.querySelector('[data-inv-error]');if(p)p.textContent=text||'';}
function askDiscard(){
 const box=ed?.root?.querySelector('[data-inv-confirm]');if(!box)return;box.hidden=false;setError('');box.querySelector('[data-inv="stay"]')?.focus();
}
/** Opens the editor for tournament t (its invitation is read first when it has one). opener gets the focus back. */
export async function openEditor(t,opener=null){
 if(!t?.id||typeof document==='undefined')return false;
 const i=inviteOf(t);let data=null;
 if(i){try{data=await loadInvite(t);}catch(error){row.error=messageOf(error);repaintSection();return false;}}
 ed={t,id:String(t.id),style:data?.style||'classic',fields:data?{...data.fields}:defaults(t),busy:false,root:null,initial:''};
 ed.initial=snapshot();
 const root=openLayer(editorHtml(t),{opener,id:t.id,action:'invite-edit',focus:'#inv-f-event',guard:()=>{if(ed?.busy)return false;readForm();if(dirty()){askDiscard();return false;}ed=null;return true;}});
 ed.root=root;
 const form=root.querySelector('[data-inv-form]');
 form.addEventListener('input',()=>{preview();setError('');const c=root.querySelector('[data-inv-confirm]');if(c)c.hidden=true;});
 form.addEventListener('change',preview);
 form.addEventListener('submit',event=>{event.preventDefault();save();});
 root.addEventListener('click',event=>{
  const act=event.target.closest?.('[data-inv]')?.dataset.inv,view=event.target.closest?.('[data-inv-view]')?.dataset.invView;
  if(view){const sheet=root.querySelector('.inv-editor');readForm();sheet.dataset.view=view;for(const b of root.querySelectorAll('[data-inv-view]'))b.setAttribute('aria-pressed',String(b.dataset.invView===view));if(view==='preview')preview();return;}
  if(act==='save')save();
  else if(act==='cancel'){readForm();if(dirty())askDiscard();else{ed=null;closeLayer();}}
  else if(act==='discard'){ed=null;closeLayer();}
  else if(act==='stay'){const c=root.querySelector('[data-inv-confirm]');if(c)c.hidden=true;root.querySelector('[data-inv-form] input,[data-inv-form] textarea')?.focus();}
 });
 return true;
}
async function save(){
 if(!ed||ed.busy)return;readForm();
 const {d,error}=inviteFields(ed.fields);
 if(error==='empty'){setError(T('Wypełnij co najmniej jedno pole zaproszenia.'));return;}
 if(error){setError(T('Jedno z pól zaproszenia jest za długie.'));ed.root.querySelector('#inv-f-'+error)?.focus();return;}
 const c=ed,button=c.root.querySelector('[data-inv="save"]');c.busy=true;setError('');
 if(button){button.disabled=true;button.setAttribute('aria-busy','true');setHtml(button,h`<span>${T('Zapisywanie…')}</span>`);}
 try{
  await sendInvite(c.id,c.style,d);
  for(const k of [...cache.keys()])if(k.startsWith(c.id+'|'))cache.delete(k);
  c.busy=false;ed=null;closeLayer();row.error='';row.done=T('Zaproszenie zapisane.');written(row.done);repaintSection();
 }catch(error){
  c.busy=false;if(button){button.disabled=false;button.removeAttribute('aria-busy');setHtml(button,h`${icon('check')}<span>${T('Zapisz zaproszenie')}</span>`);}
  if(error?.status===401&&error?.code!=='reauth'||error?.status===402){ed=null;closeLayer(false);await ui()?.handleError?.(error);return;}
  setError(messageOf(error));
 }
}
export const editorOpen=()=>!!ed&&layerOpen();

// ---- Events ----
registry.provide('invite',{block,guest,fill});
registry.registerAction('invite-edit',el=>{const t=tournamentOf(row.id||el.dataset.id);if(t){row.error='';row.done='';openEditor(t,el);}});
registry.registerAction('invite-remove',()=>{if(!row.id||row.busy)return;row.confirm=true;row.error='';row.done='';repaintSection();document.querySelector('[data-action="invite-remove-confirm"]')?.focus();});
registry.registerAction('invite-remove-confirm',()=>removeInvite());
registry.registerAction('invite-remove-cancel',()=>{row.confirm=false;repaintSection();document.querySelector('[data-action="invite-remove"]')?.focus();});
if(typeof document!=='undefined'){
 registry.on('painted',({view}={})=>{if(view==='guest')fill();});
 registry.on('logout',()=>{cache.clear();shown.clear();ed=null;row={id:null,confirm:false,busy:false,error:'',done:''};});
}
