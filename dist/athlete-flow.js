/* Athlete screens (PLAN-REJESTRACJA-ROLE §7.3–§7.6, §10.3), loaded on demand by athlete-boot.js:
 *  - "Moje starty" (#starts): profile switcher (more than one profile only), profile card with a link to the Role tab, own entries
 *    with the §7.6 status, events, categories, the line of a saved draw and the read-only bracket with the own slot (ui.bracket),
 *    the edit and withdraw buttons (canEdit / canWithdraw from the server), withdrawn entries (tombstones) and open tournaments
 *    with the enter button, the community badge and the minor-untrusted explanation;
 *  - the entry window: events as checkboxes; events that are not possible (age or grade on the tournament day, a drawn category)
 *    are visible text with the reason, tied to the group by aria-describedby; category preview; measures from the profile with
 *    "save to the profile too" (ticked); the privacy notice of every tournament with its audience; an empty consent slot;
 *  - the call to action in a member's preview ([data-athlete-cta]): enter / entered / add athlete data, otherwise the reason.
 * 402 goes through ui.handleError ('payment-required' -> #billing); other errors stay in the window. Templates: h`…` and setHtml
 * only; every value from the API is escaped by h. Pure texts for the tests: statusText, positionText, withdrawnText, noticeTexts. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {getMe} from './me.js';
import {t as T,locale,ruleLabel,ruleText,translateMessage,gradeLabel,gradeName} from './i18n.js';
import {EVENTS} from './engine.js';
import {warsawToday} from './guest-view.js';
import {athleteUser,cachedView,loadView} from './athlete-boot.js';
import {eventOptions,chosenEvents,categoryPreview,measuresOf,measuresValid,entryStatus,positionStatus,sortEntries,activeProfiles,openItem,entryItem,ctaFor,unavailableReason,entryBody,entryAge} from './athlete-data.js';

const ui=()=>registry.use('ui');
const icon=(name,cls='')=>ui()?.icon?.(name,cls)??'';
const signedIn=()=>{try{return ui()?.getWorkspace?.()?.user||null;}catch{return null;}};
const eventName=k=>ruleLabel(EVENTS[k]);
const fmtDate=date=>{if(typeof date!=='string'||!date)return T('Brak daty');const d=new Date(date+'T12:00:00');return Number.isNaN(d.getTime())?date:d.toLocaleDateString(locale(),{day:'numeric',month:'long',year:'numeric'});};
const fmtNumber=n=>Number.isFinite(Number(n))?Number(n).toLocaleString(locale(),{maximumFractionDigits:1}):'';
const fmtAt=at=>Number.isFinite(Number(at))&&Number(at)>0?new Date(Number(at)*1000).toLocaleDateString(locale(),{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Warsaw'}):'';
const initialsOf=name=>String(name??'').trim().split(/\s+/).filter(Boolean).slice(0,2).map(w=>[...w][0]).join('').toUpperCase()||'?';
const female=sex=>sex==='F';

// ---- Texts (pure: tests/athlete-ui.test.mjs) ----
/** Status of an own entry (§7.6) as text; sex chooses the Polish form of "absent". */
export function statusText(status,sex){
 switch(status?.code){
  case 'paused':return T('Turniej wstrzymany');
  case 'finished':return T('Turniej zakończony');
  case 'absent':return female(sex)?T('Nieobecna na kontroli startowej'):T('Nieobecny na kontroli startowej');
  case 'present':return status.weight==null?T('Obecność potwierdzona'):T('Obecność potwierdzona · waga {kg} kg',{kg:fmtNumber(status.weight)});
  case 'closed':return T('Zapisy zamknięte — czekaj na kontrolę startową');
  default:return T('Zgłoszenie przyjęte');
 }
}
const opponentText=(o,sex)=>!o?'':o.club===''?o.initials+' ('+(female(sex)?T('Niezrzeszona'):T('Niezrzeszony'))+')':o.club?o.initials+' ('+o.club+')':o.initials;
/** The line of a saved draw: fight, round and opponent (initials and club only), or the result. */
export function positionText(p,sex){
 if(!p)return '';
 const n=p.match,r=p.round;
 switch(p.code){
  case 'next':return p.opponent?T('Losowanie: walka {n}, runda {r}, przeciwnik {opponent}',{n,r,opponent:opponentText(p.opponent,sex)}):T('Losowanie: walka {n}, runda {r}',{n,r});
  case 'waiting':return T('Losowanie: walka {n}, runda {r}, przeciwnik jeszcze nieznany',{n,r});
  case 'bye':return T('Wolny los · następna walka {n}, runda {r}',{n,r});
  case 'won':return T('Wygrana · następna walka {n}, runda {r}',{n,r});
  case 'lost':return T('Porażka');
  case 'champion':return T('Zwycięzca kategorii');
  default:return '';
 }
}
/** Tombstone text by who withdrew the entry (entry_withdrawals.by). */
export function withdrawnText(by){
 return by==='admin'?T('Zgłoszenie wycofane przez Administratora'):by==='system'?T('Zgłoszenie wycofane, bo turniej odwołano'):T('Zgłoszenie wycofane przez organizatora');
}
/** "Organizator: {n}." for a community organizer's display name (People::project; "Ula U." keeps one final dot). */
const organizerText=n=>T('Organizator: {n}.',{n:String(n).replace(/\.+$/,'')});
/** The privacy notice of the entry window (§10.3, PS-17): who sees the entry data, for every tournament; a community tournament
 * adds its organizer and whether MatBravo confirmed them (trusted=false only while the Administrator requires confirmation, §17). */
export function noticeTexts(t){
 const out=[T('Dane zgłoszenia (imię i nazwisko, wiek, płeć, waga, wzrost, stopień, klub) zobaczą organizatorzy turnieju i Administrator MatBravo. W publicznej drabince widać tylko inicjały i klub.')];
 if(t?.community){
  const who=typeof t.organizer?.n==='string'&&t.organizer.n?organizerText(t.organizer.n)+' ':'';
  out.push(who+(t.trusted===false?T('Turniej społeczności — organizator niepotwierdzony przez MatBravo.'):T('Turniej społeczności — prowadzi go członek MatBravo, nie zespół MatBravo.')));
 }else out.push(T('Turniej prowadzi zespół MatBravo.'));
 return out;
}
const unavailableText=reason=>reason==='finished'?T('Ten turniej już się odbył.'):reason==='off'?T('Organizator nie włączył samodzielnych zgłoszeń. Zgłosi Cię klub albo organizator turnieju.'):T('Zapisy do tego turnieju są zamknięte.');
const BLOCKED=()=>T('Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.');
const STATE_ICON={paused:'pause',finished:'trophy',absent:'alert',present:'check',closed:'clock',accepted:'check'};
const STATE_TONE={paused:'warn',finished:'done',absent:'warn',present:'ok',closed:'wait',accepted:'ok'};
const CATEGORY_STATE=()=>({finished:[T('Zakończona'),'success'],progress:[T('W toku'),'teal'],drawn:[T('Gotowa do rozegrania'),'teal'],pending:[T('Przed losowaniem'),'neutral'],underfilled:[T('Wymaga decyzji'),'warning'],list:[T('Lista startowa'),'neutral']});
const categoryBadge=state=>{const states=CATEGORY_STATE(),[label,type]=states[state]||states.pending;return h`<span class="badge ${type}">${label}</span>`;};
const clubText=(club,sex)=>!club?'':club.unaffiliated?(female(sex)?T('Niezrzeszona'):T('Niezrzeszony')):club.verified===false?T('{club} (klub czeka na weryfikację)',{club:club.name||T('Klub')}):String(club.name||'');
const communityMarks=t=>t?.community?h`<span class="badge neutral">${T('Turniej społeczności')}</span>${t.trusted===false?h`<span class="badge warning">${T('Organizator niepotwierdzony')}</span>`:''}`:'';

// ---- "Moje starty" ----
let selected=null;
const profileOf=view=>{const list=activeProfiles(view).length?activeProfiles(view):view?.profiles||[];return list.find(p=>p.id===selected)||list[0]||null;};
function profileCard(p){
 const meta=[clubText(p.club,p.sex),p.grade?gradeLabel(p.grade,p.gradeType):'',p.weight!=null?fmtNumber(p.weight)+' kg':'',p.height!=null?fmtNumber(p.height)+' cm':''].filter(Boolean).join(' · ');
 return h`<section class="panel ath-profile" aria-labelledby="ath-profile-name"><span class="avatar large" aria-hidden="true">${initialsOf(p.name)}</span><div class="ath-profile-main"><div class="eyebrow">${p.relation==='self'?T('TWÓJ PROFIL ZAWODNIKA'):T('ZAWODNIK POD TWOJĄ OPIEKĄ')}</div><h2 id="ath-profile-name">${p.name}</h2><p class="ath-profile-meta">${meta}</p>${p.club?.pending?h`<p class="ath-profile-note">${icon('info')}<span>${T('Klub „{club}” zapiszemy po sprawdzeniu przez Administratora.',{club:p.club.pending})}</span></p>`:''}</div><a class="btn secondary ath-profile-edit" href="#profile?tab=roles">${icon('user')}<span>${T('Zmień dane')}</span></a></section>`;
}
function switcher(view,current){
 const list=activeProfiles(view);if(list.length<2)return '';
 return h`<div class="ath-switch" role="group" aria-label="${T('Zawodnik')}">${list.map(p=>h`<button type="button" class="ath-switch-btn" data-action="athlete-profile" data-id="${p.id}" aria-pressed="${p.id===current.id}">${p.name}</button>`)}</div>`;
}
function categoryItem(c,sex,open){
 const pos=positionStatus(c),line=positionText(pos,sex),bracket=c.bracket?ui()?.bracket?.(c,{highlight:Number.isInteger(c.position?.slot)?c.position.slot:null})??'':'';
 return h`<li class="ath-cat"><div class="ath-cat-head"><span class="category-code">${c.code}</span><span class="ath-cat-name"><strong>${ruleText(c.title)}</strong> <span>${ruleText(c.subtitle)}</span></span>${categoryBadge(c.state)}</div>${line?h`<p class="ath-pos ath-pos-${pos.code}">${icon(pos.code==='champion'||pos.code==='won'?'trophy':'bracket')}<span>${line}</span></p>`:''}${String(bracket)?h`<details class="ath-bracket"${open?h` open`:''}><summary>${T('Drabinka {code}',{code:c.code})}</summary>${bracket}</details>`:''}</li>`;
}
function entryCard(item,profile,today){
 const t=item.tournament||{},e=item.entry||{},s=entryStatus(item),sex=profile?.sex,title='ath-entry-'+t.id;
 if(t.available===false)return h`<article class="panel ath-card ath-card-paused" aria-labelledby="${title}"><header class="ath-card-head"><div><h3 id="${title}">${t.name}</h3><p class="ath-when">${icon('calendar')}<span>${fmtDate(t.date)}</span></p></div></header><p class="ath-status ath-tone-warn">${icon('pause')}<strong>${statusText(s,sex)}</strong></p><p class="ath-note">${T('Organizator lub Administrator wstrzymał ten turniej. Twoje zgłoszenie zostaje zapisane.')}</p></article>`;
 const facts=[[T('Konkurencje'),(e.events||[]).map(eventName).join(', ')],[T('Waga'),e.weight!=null?fmtNumber(e.weight)+' kg':''],[T('Wzrost'),e.height!=null?fmtNumber(e.height)+' cm':''],[T('Stopień'),e.grade?gradeLabel(e.grade,e.gradeType):''],[T('Klub'),clubText(e.club,sex)]].filter(([,v])=>v);
 const coming=String(t.date)>=today,actions=[
  item.canEdit?h`<button type="button" class="btn secondary" data-action="athlete-edit" data-id="${t.id}" data-profile="${item.profileId}" aria-label="${T('Zmień zgłoszenie: {name}',{name:t.name})}">${icon('settings')}<span>${T('Zmień zgłoszenie')}</span></button>`:'',
  item.canWithdraw?h`<button type="button" class="btn secondary ath-withdraw" data-action="athlete-withdraw" data-id="${t.id}" data-profile="${item.profileId}" aria-label="${T('Wycofaj zgłoszenie: {name}',{name:t.name})}">${icon('close')}<span>${T('Wycofaj')}</span></button>`:'',
  h`<a class="text-btn ath-preview-link" href="#guest?t=${encodeURIComponent(t.id)}" aria-label="${T('Podgląd turnieju: {name}',{name:t.name})}">${icon('eye')}<span>${T('Podgląd turnieju')}</span></a>`];
 const closedHint=coming&&t.status==='closed'&&!item.canWithdraw?h`<p class="ath-note">${T('Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.')}</p>`:'';
 // Events the engine could not place (the organizer decides the category); only while categories are shown (recent tournaments).
 const cats=item.categories||[],placed=new Set(cats.map(c=>c.event)),loose=(cats.length||coming)&&e.presence!=='absent'?(e.events||[]).filter(ev=>!placed.has(ev)):[];
 return h`<article class="panel ath-card" aria-labelledby="${title}"><header class="ath-card-head"><div><h3 id="${title}">${t.name}</h3><p class="ath-when">${icon('calendar')}<span>${fmtDate(t.date)}</span>${t.city?h`<span aria-hidden="true">·</span>${icon('pin')}<span>${t.city}</span>`:''}</p></div><div class="ath-marks">${communityMarks(t)}</div></header><p class="ath-status ath-tone-${STATE_TONE[s.code]}">${icon(STATE_ICON[s.code])}<strong>${statusText(s,sex)}</strong></p>${closedHint}<dl class="ath-facts">${facts.map(([k,v])=>h`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>${cats.length||loose.length?h`<ul class="ath-cats" aria-label="${T('Kategorie')}">${cats.map((c,i)=>categoryItem(c,sex,i===0&&t.status!=='finished'))}${loose.map(ev=>h`<li class="ath-cat ath-cat-loose"><div class="ath-cat-head"><span class="ath-cat-name"><strong>${eventName(ev)}</strong> <span>${T('Kategorię ustali organizator')}</span></span></div></li>`)}</ul>`:''}<div class="ath-actions">${actions}</div></article>`;
}
function openCard(t,profile,selfEntry){
 const row=(t.profiles||[]).find(p=>p.id===profile?.id)||null,title='ath-open-'+t.id;
 let action;
 if(!row)action='';
 else if(row.entered)action=h`<span class="badge teal ath-entered">${icon('check')}${T('Na liście zgłoszeń')}</span>`;
 else if(row.blocked)action=h`<p class="ath-blocked">${icon('lock')}<span>${BLOCKED()}</span></p>`;
 else if(selfEntry)action=h`<button type="button" class="btn primary" data-action="athlete-enter" data-id="${t.id}" data-profile="${row.id}" aria-label="${T('Zgłoś się: {name}',{name:t.name})}">${T('Zgłoś się')}</button>`;
 else action='';
 return h`<article class="ath-open" aria-labelledby="${title}"><div class="ath-open-main"><h3 id="${title}">${t.name}</h3><p class="ath-when">${icon('calendar')}<span>${fmtDate(t.date)}</span>${t.city?h`<span aria-hidden="true">·</span>${icon('pin')}<span>${t.city}</span>`:''}</p>${t.community?h`<div class="ath-marks">${communityMarks(t)}${t.organizer?.n?h`<span class="ath-organizer">${organizerText(t.organizer.n)}</span>`:''}</div>`:''}</div><div class="ath-open-side">${action}<a class="text-btn ath-preview-link" href="#guest?t=${encodeURIComponent(t.id)}" aria-label="${T('Podgląd turnieju: {name}',{name:t.name})}">${icon('eye')}<span>${T('Podgląd turnieju')}</span></a></div></article>`;
}
/** The content of #starts for a view (SafeHtml). */
export function startsHtml(view,{today=warsawToday(),selfEntry=true}={}){
 const p=profileOf(view);
 if(!p)return h`<section class="panel empty-state">${ui()?.emptyMascot?.()??''}<h3>${T('Nie masz jeszcze danych zawodnika.')}</h3><p>${T('Dodaj je w zakładce „Role” swojego konta, aby zgłaszać się do turniejów.')}</p><a class="btn primary" href="#profile?tab=roles&amp;add=1">${T('Dodaj dane zawodnika')}</a></section>`;
 const entries=sortEntries((view.entries||[]).filter(x=>x.profileId===p.id),today),gone=(view.withdrawn||[]).filter(w=>w.profileId===p.id),open=view.open||[];
 return h`${switcher(view,p)}${profileCard(p)}
<section class="ath-section" aria-labelledby="ath-entries-title"><div class="ath-section-head"><h2 id="ath-entries-title">${T('Moje zgłoszenia')}</h2></div>${entries.length?h`<div class="ath-list">${entries.map(x=>entryCard(x,p,today))}</div>`:h`<div class="panel ath-empty"><p><strong>${T('Nie masz jeszcze zgłoszeń.')}</strong> ${open.length?T('Wybierz turniej z listy „Otwarte turnieje” i zgłoś się.'):T('Gdy organizator otworzy zapisy, turniej pojawi się poniżej.')}</p></div>`}</section>
${gone.length?h`<section class="ath-section" aria-labelledby="ath-gone-title"><div class="ath-section-head"><h2 id="ath-gone-title">${T('Wycofane')}</h2></div><ul class="panel ath-gone">${gone.map(w=>h`<li><div><strong>${w.tournament.name}</strong><span>${fmtDate(w.tournament.date)}</span></div><p>${icon('alert')}<span>${withdrawnText(w.by)}${fmtAt(w.at)?' · '+fmtAt(w.at):''}</span></p></li>`)}</ul></section>`:''}
<section class="ath-section" aria-labelledby="ath-open-title"><div class="ath-section-head"><h2 id="ath-open-title">${T('Otwarte turnieje')}</h2><span>${T('Zgłoszenia przyjmowane przez MatBravo')}</span></div>${open.length?h`<div class="panel ath-open-list">${open.map(t=>openCard(t,p,selfEntry))}</div>`:h`<div class="panel ath-empty"><p>${T('Teraz żaden turniej nie przyjmuje zgłoszeń od zawodników.')}</p></div>`}</section>`;
}
const features=()=>getMe()?.features||{};
const paintKey=view=>JSON.stringify([view,selected,getLocaleKey(),features().selfEntry]);
const getLocaleKey=()=>{try{return locale();}catch{return '';}};
function paintStarts(view,{force=false}={}){
 const root=document.querySelector('[data-starts-root]');if(!root)return;
 const key=paintKey(view);if(!force&&root.dataset.athKey===key)return;
 setHtml(root,startsHtml(view,{selfEntry:features().selfEntry!==false}));root.dataset.athKey=key;root.removeAttribute('aria-busy');
}
function paintError(error){
 const root=document.querySelector('[data-starts-root]');if(!root)return;
 setHtml(root,h`<section class="panel empty-state ath-error" role="alert"><h3>${T('Nie udało się wczytać Twoich startów.')}</h3><p>${translateMessage(error?.message||'')}</p><button type="button" class="btn primary" data-action="athlete-refresh">${icon('refresh')}<span>${T('Spróbuj ponownie')}</span></button></section>`);
 root.removeAttribute('aria-busy');delete root.dataset.athKey;
}
/** After 'painted' of #starts: the cached view at once, a fresh one when it is older than 60 s. */
export async function mountStarts(){
 const cached=cachedView();if(cached)paintStarts(cached,{force:true});
 try{const view=await loadView();if(view)paintStarts(view,{force:!cached});}
 catch(error){if(error?.status===401){ui()?.handleError?.(error);return;}if(!cached)paintError(error);}
}
/** The 60-second refresh (and after the tab is visible again): repaints only when the answer changed. */
export async function refreshStarts(){
 try{const view=await loadView({force:true});if(view)paintStarts(view);}catch(error){if(error?.status===401)ui()?.handleError?.(error);}
}

// ---- Call to action in a member's tournament preview ----
const publicCache=new Map();
async function publicInfo(id){
 const hit=publicCache.get(id);if(hit&&Date.now()-hit.at<60000)return hit.t;
 const t=await Client.publicTournament(id).then(d=>d?.tournament||null,()=>null);publicCache.set(id,{t,at:Date.now()});return t;
}
/** The call to action as SafeHtml for state (ctaFor) of tournament id. */
export function ctaHtml(state,id,{view=null,reason='closed'}={}){
 if(!state)return h``;
 const p=state.profileId?(view?.profiles||[]).find(x=>x.id===state.profileId):null;
 if(state.kind==='add')return h`<div class="ath-cta"><span class="ath-cta-icon">${icon('user')}</span><div class="ath-cta-copy"><strong>${T('Zapisy są otwarte')}</strong><p>${T('Dodaj dane zawodnika, aby się zgłosić. Wystarczy raz: przy następnych turniejach użyjesz ich ponownie.')}</p></div><a class="btn primary" href="#profile?tab=roles&amp;add=1&amp;then=${encodeURIComponent(id)}">${T('Dodaj dane zawodnika, aby się zgłosić')}</a></div>`;
 if(state.kind==='enter')return h`<div class="ath-cta"><span class="ath-cta-icon">${icon('trophy')}</span><div class="ath-cta-copy"><strong>${T('Zapisy są otwarte')}</strong><p>${p?T('Zgłoś zawodnika: {name}. Sprawdzimy konkurencje i kategorię przed wysłaniem.',{name:p.name}):T('Sprawdzimy konkurencje i kategorię przed wysłaniem.')}</p></div><button type="button" class="btn primary" data-action="athlete-enter" data-id="${id}" data-profile="${state.profileId}">${T('Zgłoś się')}</button></div>`;
 if(state.kind==='entered')return h`<div class="ath-cta ath-cta-done"><span class="ath-cta-icon">${icon('check')}</span><div class="ath-cta-copy"><strong>${p?T('Zgłoszenie przyjęte: {name}',{name:p.name}):T('Zgłoszenie przyjęte')}</strong><p>${T('Status, kategorię i drabinkę znajdziesz w „Moich startach”.')}</p></div><div class="ath-cta-actions">${state.canEdit?h`<button type="button" class="btn secondary" data-action="athlete-edit" data-id="${id}" data-profile="${state.profileId}">${T('Zmień zgłoszenie')}</button>`:''}<a class="btn primary" href="#starts">${T('Moje starty')}</a></div></div>`;
 if(state.kind==='blocked')return h`<div class="ath-cta ath-cta-off"><span class="ath-cta-icon">${icon('lock')}</span><div class="ath-cta-copy"><strong>${T('Samodzielne zgłoszenie niedostępne')}</strong><p>${BLOCKED()}</p></div></div>`;
 return h`<div class="ath-cta ath-cta-off"><span class="ath-cta-icon">${icon('info')}</span><div class="ath-cta-copy"><strong>${T('Samodzielne zgłoszenie niedostępne')}</strong><p>${unavailableText(reason)}</p></div></div>`;
}
let ctaTicket=0;
/** After 'painted' {view:'guest', memberPreview:true}: fills [data-athlete-cta]. #guest?t=…&enter=1 opens the entry window once. */
export async function mountCta(mount){
 const id=mount.dataset.tournamentId,ticket=String(++ctaTicket),u=signedIn(),athlete=athleteUser(u),selfEntry=features().selfEntry!==false;mount.dataset.athTicket=ticket;
 if(!id||!u)return;
 let view=null;
 if(athlete){try{view=await loadView();}catch(error){if(error?.status===401){ui()?.handleError?.(error);return;}view=null;}if(!view)return;}
 let state=ctaFor(view,id,{athlete,selfEntry}),reason='closed';
 if(state&&(state.kind==='add'||state.kind==='unavailable')){
  const t=await publicInfo(id),today=warsawToday();reason=unavailableReason(t,today);
  if(state.kind==='add'&&(!t||t.status!=='open'||t.date<today))state=null;// no "add data" call where nobody can enter
 }
 if(!mount.isConnected||mount.dataset.athTicket!==ticket)return;
 setHtml(mount,ctaHtml(state,id,{view,reason}));
 const q=new URLSearchParams(location.hash.split('?')[1]||'');
 if(q.get('enter')==='1'){q.delete('enter');history.replaceState(null,'','#guest?'+q.toString());if(state?.kind==='enter')openEntry(id,state.profileId,false).catch(()=>{});}
}

// ---- Entry window ----
let dialog=null,busy=false;
const formMeasures=form=>{const f=new FormData(form);return {weight:f.get('weight'),height:f.get('height'),gradeType:f.get('gradeType'),grade:f.get('grade')};};
/** Events of the window: allowed ones as checkboxes (category preview as description), the others as text with the reason. */
export function eventsHtml(options,checked){
 return h`<div class="ath-events">${options.map(o=>{
  const id='ath-ev-'+o.event;
  if(o.state==='allowed')return h`<label class="checkbox-label ath-event"><input type="checkbox" name="events" value="${o.event}"${checked.includes(o.event)?h` checked`:''}${o.category||o.note?h` aria-describedby="${id}"`:''}><span class="ath-event-text"><span>${eventName(o.event)}</span>${o.category?h`<small id="${id}">${ruleText(o.category.subtitle)}</small>`:o.note?h`<small id="${id}">${translateMessage(o.note)}</small>`:''}</span></label>`;
  return h`<p class="ath-event ath-event-off" id="${id}"><span class="ath-event-text"><span>${eventName(o.event)}</span><small>${o.state==='drawn'?T('Niedostępne: losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.'):T('Niedostępne: {reason}',{reason:translateMessage(o.reason)})}</small></span></p>`;
 })}</div>`;
}
/** Ids of the events shown as unavailable text (the fieldset's aria-describedby). */
export const offIds=options=>options.filter(o=>o.state!=='allowed').map(o=>'ath-ev-'+o.event).join(' ');
/** Category preview of the chosen events (the subtitle of the engine: age group, sex, weight or height band). */
export function previewHtml(options,events,valid){
 const rows=categoryPreview(options,events);
 if(!rows.length)return h`<p class="ath-preview-empty">${T('Wybierz konkurencję, aby zobaczyć kategorię.')}</p>`;
 if(!valid)return h`<p class="ath-preview-empty">${T('Uzupełnij wagę, wzrost i stopień, aby zobaczyć kategorię.')}</p>`;
 return h`<ul>${rows.map(r=>h`<li><strong>${eventName(r.event)}</strong><span>${r.subtitle?ruleText(r.subtitle):T('Kategorię ustali organizator')+(r.note?' — '+translateMessage(r.note):'')}</span></li>`)}</ul>`;
}
function measureFields(m){
 return h`<label>${T('Waga zgłoszona (kg)')}<input name="weight" type="number" inputmode="decimal" min="10" max="250" step="0.1" value="${m.weight??''}" required></label><label>${T('Wzrost (cm)')}<input name="height" type="number" inputmode="numeric" min="70" max="250" step="1" value="${m.height??''}" required></label><label>${T('Rodzaj stopnia')}<select name="gradeType"><option value="cup"${m.gradeType==='cup'?h` selected`:''}>${gradeName('cup')}</option><option value="dan"${m.gradeType==='dan'?h` selected`:''}>Dan</option></select></label><label>${T('Stopień')}<input name="grade" type="number" inputmode="numeric" min="1" max="10" step="1" value="${m.grade??''}" required></label>`;
}
/** Body of the entry window (SafeHtml) for dialog d = {tournament, profile, profiles, item, update}. */
export function entryHtml(d){
 const t=d.tournament,p=d.profile,m=d.item?measuresOf(d.item.entry):measuresOf(p),checked=d.item?[...(d.item.entry.events||[])]:[],options=eventOptions(p,m,t),age=entryAge(p,t.date);
 const who=d.profiles.length>1&&!d.update?h`<fieldset class="ath-who-pick"><legend>${T('Wybierz zawodnika')}</legend>${d.profiles.map(x=>h`<label class="checkbox-label"><input type="radio" name="profileId" value="${x.id}"${x.id===p.id?h` checked`:''}>${x.name}</label>`)}</fieldset>`:h`<p class="ath-who"><span class="avatar" aria-hidden="true">${initialsOf(p.name)}</span><span><strong>${p.name}</strong>${age!=null?h`<small>${T('Wiek w dniu zawodów: {n}',{n:age})}</small>`:''}</span></p>`;
 const off=offIds(options);
 return h`<p class="entry-event-name ath-event-name">${icon('trophy')} ${t.name} · ${fmtDate(t.date)}${t.city?' · '+t.city:''}</p><form id="ath-entry-form" data-tournament="${t.id}" data-profile="${p.id}" data-update="${d.update?'yes':''}" novalidate>${who}
<fieldset class="ath-fieldset" data-ath-events-box${off?h` aria-describedby="${off}"`:''}><legend>${T('Konkurencje w tym turnieju')}</legend><div data-ath-events>${eventsHtml(options,checked)}</div></fieldset>
<div class="ath-preview" aria-live="polite"><span class="ath-preview-title">${T('Kategoria')}</span><div data-ath-preview>${previewHtml(options,checked,measuresValid(m))}</div></div>
<div class="form-grid ath-measures">${measureFields(m)}<label class="checkbox-label span-two ath-save-profile"><input type="checkbox" name="saveToProfile" checked><span>${T('Zapisz też w profilu')}<small>${T('Waga, wzrost i stopień zmienią się w Twoim profilu zawodnika. Wcześniejsze zgłoszenia zostają bez zmian.')}</small></span></label></div>
<div class="notice info-notice privacy-note ath-privacy">${icon('lock')}<span>${noticeTexts(t).map((s,i)=>h`${i?' ':''}${s}`)}</span></div>
<div class="consent-slot" data-consent-slot hidden></div>
<div class="form-error" role="alert"></div></form>`;
}
/** Opens the entry window for tournament id (update: correct the own entry). */
export async function openEntry(id,profileId,update){
 const view=await loadView({maxAge:15000}),profiles=activeProfiles(view),profile=profiles.find(p=>p.id===profileId)||profileOf(view);
 const item=update?entryItem(view,id,profile?.id):null,open=openItem(view,id);
 const tournament=open||(item?{...item.tournament,drawn:[],organizer:null}:null);
 if(!profile||!tournament||(update&&!item?.canEdit)){ui()?.toast?.(T('Zapisy do tego turnieju są zamknięte.'));paintStarts(view,{force:true});return;}
 if(!update&&(open?.profiles||[]).some(p=>p.id===profile.id&&p.entered)){ui()?.toast?.(T('Jesteś już zgłoszony do tego turnieju.'));return;}
 dialog={tournament,profile,profiles,item,update:!!update};
 ui().modal(update?T('Zmień zgłoszenie'):T('Zgłoszenie do turnieju'),entryHtml(dialog),h`<button type="button" class="btn secondary" data-action="close-modal">${T('Anuluj')}</button><button type="submit" class="btn primary" form="ath-entry-form">${update?T('Zapisz zmiany'):T('Zgłoś się')}</button>`,true);
}
/** input/change inside the window: measures and the profile re-check the events (keeping the ticks), events refresh the preview. */
export function entryChanged(form,target){
 if(!dialog||!form.isConnected)return;
 const name=target?.name;
 if(name==='profileId'){const p=dialog.profiles.find(x=>x.id===target.value);if(p){dialog.profile=p;form.dataset.profile=p.id;}}
 const m=formMeasures(form),options=eventOptions(dialog.profile,m,dialog.tournament),checked=new FormData(form).getAll('events');
 if(['weight','height','gradeType','grade','profileId'].includes(name)){
  const box=form.querySelector('[data-ath-events]');if(box)setHtml(box,eventsHtml(options,checked));
  const set=form.querySelector('[data-ath-events-box]'),off=offIds(options);if(set){if(off)set.setAttribute('aria-describedby',off);else set.removeAttribute('aria-describedby');}
 }
 const preview=form.querySelector('[data-ath-preview]');if(preview)setHtml(preview,previewHtml(options,new FormData(form).getAll('events'),measuresValid(m)));
}
async function after(){
 try{const view=await loadView({force:true});paintStarts(view,{force:true});const mount=document.querySelector('[data-athlete-cta]');if(mount)await mountCta(mount);}
 catch(error){if(error?.status===401)ui()?.handleError?.(error);}
}
/** Sends the window (athlete-entry). 401 and 402 go to ui.handleError (sign-in, payment prompt); other errors stay in the window. */
export async function submitEntry(form,submit){
 if(busy||!dialog)return;
 const box=form.querySelector('.form-error'),f=new FormData(form),d=dialog,m=formMeasures(form),options=eventOptions(d.profile,m,d.tournament),events=chosenEvents(options,f.getAll('events'));
 if(box)box.textContent='';
 if(!measuresValid(m)){if(box)box.textContent=T('Sprawdź wagę (10–250 kg), wzrost (70–250 cm) i stopień.');return;}
 if(!events.length){if(box)box.textContent=T('Wybierz co najmniej jedną konkurencję.');return;}
 busy=true;if(submit)submit.disabled=true;
 try{
  await Client.athleteRequest('athlete-entry',entryBody({tournamentId:d.tournament.id,profileId:d.profile.id,events,...m,saveToProfile:f.has('saveToProfile'),update:d.update}));
  dialog=null;ui()?.closeModal?.();ui()?.toast?.(d.update?T('Zgłoszenie zmienione.'):T('Zgłoszenie wysłane.'));await after();
 }catch(error){
  if(error?.status===401||error?.status===402){dialog=null;await ui()?.handleError?.(error,form);return;}
  if(box)box.textContent=translateMessage(error?.message||'');
  if([403,404,409].includes(error?.status))loadView({force:true}).then(view=>paintStarts(view)).catch(()=>{});
 }finally{busy=false;if(submit?.isConnected)submit.disabled=false;}
}
/** Withdraw confirmation text (§7.3). */
export const withdrawQuestion=name=>T('Wycofać zgłoszenie z {tournament}? Po zamknięciu zapisów nie zgłosisz się ponownie.',{tournament:name});
/** Registered actions (athlete-boot.js): enter, edit, withdraw (with confirmation), switch profile, retry. */
export async function action(name,el,id){
 const profileId=el?.dataset?.profile||null;
 if(name==='athlete-enter'||name==='athlete-edit'){
  try{await openEntry(id,profileId,name==='athlete-edit');}catch(error){if(error?.status===401||error?.status===402)ui()?.handleError?.(error);else ui()?.toast?.(translateMessage(error?.message||''));}
  return;
 }
 if(name==='athlete-withdraw'){
  const view=cachedView(),item=entryItem(view,id,profileId);if(!item)return;
  ui().modal(T('Wycofać zgłoszenie?'),h`<p>${withdrawQuestion(item.tournament.name)}</p>`,h`<button type="button" class="btn secondary" data-action="close-modal">${T('Anuluj')}</button><button type="button" class="btn primary" data-action="athlete-withdraw-confirm" data-id="${id}" data-profile="${item.profileId}">${T('Wycofaj zgłoszenie')}</button>`);
  return;
 }
 if(name==='athlete-withdraw-confirm'){
  if(busy)return;busy=true;el.disabled=true;
  try{await Client.athleteRequest('athlete-withdraw',{tournamentId:id,profileId});ui()?.closeModal?.();ui()?.toast?.(T('Zgłoszenie wycofane.'));await after();}
  catch(error){if(error?.status===401){ui()?.handleError?.(error);return;}ui()?.closeModal?.();ui()?.toast?.(translateMessage(error?.message||''));after();}
  finally{busy=false;if(el.isConnected)el.disabled=false;}
  return;
 }
 if(name==='athlete-profile'){selected=id;const view=cachedView();if(view)paintStarts(view,{force:true});return;}
 if(name==='athlete-refresh'){const root=document.querySelector('[data-starts-root]');if(root){root.setAttribute('aria-busy','true');}await mountStarts();}
}
