/* Admin panel "Members" (#members) and the plan fields of the staff accounts panel (plan §3.2, §3.9–3.10, §4.3, §6.7, §8.3 point 12).
 * Loaded lazily by members-boot.js. Three parts:
 *  - the #members page: list (POST admin-members: filter, search, 50 per page) and actions (POST admin-member): new free account,
 *    block, temporary password with the §3.10 checklist, e-mail change, profile fix, deletion; mute badge with a link to moderation;
 *    the "Plan" dialog of a member (the same plan fields and billing facts as the staff form, admin-billing + admin-billing-action);
 *  - the staff accounts panel: [data-billing-badge] (GET admin-billing?list=staff) and [data-account-billing] inside the account form
 *    (switch "Darmowe konto", reason, end date, require-from date, currency, sync state), saved by POST admin-billing-action after 'saved';
 *  - the bulk action "require payment from" for the grandfathered staff accounts.
 * Personal data (e-mails, names, search phrases) travels only in POST bodies, never in a URL. Every value from the API reaches the DOM
 * through h`…` (escaping) or textContent. Dialogs use ui.modal; their buttons carry data-mem-act (not data-action), handled here.
 * The plain functions up to "Page" are pure and tested in tests/members-ui.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,getLanguage,locale,translateMessage} from './i18n.js';
import {warsawToday} from './guest-view.js';
import {COUNTRIES,SPORTS,normalizeUsername} from './profile-data.js';

export const PAGE_SIZE=50,GRACE_DAYS=7,BULK_MIN_DAYS=14,FRESH_MS=15000,STAFF_MS=30000;
export const FILTERS=[['all',()=>T('Wszyscy')],['paid',()=>T('Płacący')],['free',()=>T('Darmowi')],['none',()=>T('Bez planu')],['problem',()=>T('Problem z płatnością')],['muted',()=>T('Wyciszeni')]];
const INTERNAL_REASONS=['grandfathered','staff-default'];
const ONGOING=['active','trialing','past_due'];

// ---- Dates ----
const pad=n=>String(n).padStart(2,'0');
/** Whether s is a real calendar date written YYYY-MM-DD. */
export const validDate=s=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\d$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s;};
/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone involved). */
export const dayAdd=(ymd,n)=>{const d=new Date(ymd+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());};
/** Epoch seconds -> YYYY-MM-DD in Europe/Warsaw, the day the server counts in. */
export const secToYmd=sec=>warsawToday(new Date(sec*1000));
export const fmtYmd=ymd=>validDate(ymd)?new Date(ymd+'T12:00:00Z').toLocaleDateString(locale(),{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}):'';
export const fmtSec=sec=>Number.isFinite(sec)?new Date(sec*1000).toLocaleDateString(locale(),{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Warsaw'}):'';
export const fmtTime=sec=>Number.isFinite(sec)?new Date(sec*1000).toLocaleString(locale(),{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'}):'';

/** Checks the date of "require payment from" (§3.2): a real date; for scope 'grandfathered' at least 14 days from today, for one account today or later. */
export function validateRequireFrom(date,{scope='user',today=warsawToday()}={}){
 if(!validDate(date))return {ok:false,error:T('Podaj poprawną datę.')};
 if(scope==='grandfathered'){if(date<dayAdd(today,BULK_MIN_DAYS))return {ok:false,error:T('Data musi być co najmniej 14 dni od dziś.')};}
 else if(date<today)return {ok:false,error:T('Data nie może być w przeszłości.')};
 return {ok:true,date};
}

// ---- Plan badges ----
/** {text,type} of a plan badge from the state the server computed (Access states, as if payments were enforced); null for no badge.
 * kind 'staff' is the accounts panel (admin-billing?list=staff), 'member' the members list. */
export function planBadge(entry,kind='member'){
 const {state,until,reason}=entry||{},date=until?fmtSec(until):'';
 switch(state){
  case 'staff':return {text:T('Bez płatności'),type:'neutral'};
  case 'free':return reason==='staff-default'?{text:T('Darmowe (domyślnie)'),type:'warning'}:date?{text:T('Darmowe do {date}',{date}),type:'success'}:{text:T('Darmowe'),type:'success'};
  case 'grace':return {text:date?T('Karencja do {date}',{date}):T('Karencja'),type:'warning'};
  case 'active':return {text:date?T('Płatne do {date}',{date}):T('Płatne'),type:'success'};
  case 'ending':return {text:date?T('Kończy się {date}',{date}):T('Kończy się'),type:'warning'};
  case 'past_due':return {text:T('Problem z płatnością'),type:'warning'};
  case 'processing':return {text:T('Płatność w toku'),type:'neutral'};
  case 'none':return kind==='staff'?{text:T('Wymaga płatności'),type:'warning'}:{text:T('Bez planu'),type:'neutral'};
  case 'ended':return kind==='staff'?{text:T('Wymaga płatności'),type:'warning'}:{text:T('Subskrypcja zakończona'),type:'neutral'};
  default:return null;
 }
}
export const badgeHtml=(b)=>b?h`<span class="badge ${b.type}">${b.text}</span>`:h``;

// ---- The "Darmowe konto" switch (§3.2) ----
/** Initial state of the switch: off for a new account (requirement 4), otherwise what admin-billing reports; hidden for the Admin role (never pays). */
export function freeToggle({isNew,role,exempt}){return role==='admin'?{visible:false,checked:true}:{visible:true,checked:isNew?false:!!exempt};}
/** Reason and end date of the current exemption for the form; the internal reasons (grandfathered, staff-default) are not shown as text. */
export function loadedExemption(detail){
 const reason=detail&&typeof detail.exemptReason==='string'&&!INTERNAL_REASONS.includes(detail.exemptReason)?detail.exemptReason:'';
 return {reason,until:detail?.exemptUntil?secToYmd(detail.exemptUntil):''};
}
/** The one admin-billing-action to send after account.save (§3.2): new account -> exempt (with reason) or require; existing free account
 * switched off -> requireFrom (default today: the 7-day grace protects the match day); switched on -> exempt; unchanged -> nothing.
 * Returns {ok:true,call:object|null} or {ok:false,error}. */
export function planBilling({isNew,wasExempt,free,reason='',until='',from='',today=warsawToday(),loaded={reason:'',until:''}}){
 reason=String(reason).trim();
 if(free){
  const changed=!isNew&&wasExempt&&((reason||loaded.reason)!==loaded.reason||until!==loaded.until);
  if(!isNew&&wasExempt&&!changed)return {ok:true,call:null};
  const why=reason||(wasExempt?loaded.reason:'');
  if(!why)return {ok:false,error:T('Podaj powód darmowego konta.')};
  if(until&&(!validDate(until)||until<=today))return {ok:false,error:T('Koniec darmowego okresu musi być w przyszłości.')};
  return {ok:true,call:{action:'exempt',reason:why,...(until?{until}:{})}};
 }
 if(isNew)return {ok:true,call:{action:'require'}};
 if(!wasExempt)return {ok:true,call:null};
 const check=validateRequireFrom(from||today,{scope:'user',today});
 return check.ok?{ok:true,call:{action:'requireFrom',date:check.date,scope:'user'}}:check;
}

/** Whether the reason field must be filled before the form is submitted (so a rejected plan change never follows a committed account save):
 * switch on for a new or not yet free account; for a free account whose loaded reason is internal (grandfathered, staff-default) when the end date changes. */
export const reasonRequired=({free,isNew,wasExempt,loaded={reason:'',until:''},until=''})=>!!free&&(!!isNew||!wasExempt||(!loaded.reason&&until!==loaded.until));
/** The 'currency' action (P20) for the select value, or null: nothing to send while a subscription runs (the server refuses it), without a loaded
 * account, or when the Admin override is unchanged ('' = the country rule). */
export function currencyChange(detail,value){
 if(!detail||ONGOING.includes(detail.subStatus)||value==null)return null;
 const next=value==='pln'||value==='usd'?value:null;
 return next===(detail.currencyOverride||null)?null:{action:'currency',currency:next};
}
/** Page to load again when the requested one is past the end (the last member of the last page was deleted or filtered out); null when fine. */
export const clampPage=(data,page)=>data&&!(data.items?.length)&&data.total>0&&page>1?Math.max(1,Math.ceil(data.total/PAGE_SIZE)):null;

// ---- Requests: only names, ids and bodies; personal data stays in the body ----
export const call=(route,body)=>({route,options:{method:'POST',body}});
export const listBody=({q='',filter='all',page=1}={})=>({q:String(q??'').trim().slice(0,100),filter:FILTERS.some(([key])=>key===filter)?filter:'all',page:Number.isInteger(page)&&page>=1?page:1});
export const listCall=state=>call('admin-members',listBody(state));
export const memberCall=(action,fields={})=>call('admin-member',{action,...fields});
export const billingCall=fields=>call('admin-billing-action',fields);
export const staffListParams=()=>({route:'admin-billing',list:'staff'});
export const billingDetailParams=userId=>({route:'admin-billing',userId});
/** Transport and demo switch behind one object so that tests can run the DOM glue without a server (the demo build has no API). */
export const io={request:(route,options)=>Client.request(route,options),demo:Client.isDemo};
export const send=spec=>io.request(spec.route,spec.options);
/** Body of admin-member create (§4.3): a free account with a reason; no password, so the server generates a temporary one. */
export function createBody(v){
 const sports=Array.isArray(v.sports)?v.sports:[];
 return {email:String(v.email??'').trim(),firstName:String(v.firstName??'').trim(),lastName:String(v.lastName??'').trim(),username:normalizeUsername(String(v.username??'')),country:v.country,sports,free:true,reason:String(v.reason??'').trim(),...(v.until?{until:v.until}:{})};
}
/** Fields of admin-member profile: only what changed (empty name fields stay as they are); username null makes the member choose a new name. */
export function profileFields(v,item={}){
 const out={},first=String(v.firstName??'').trim(),last=String(v.lastName??'').trim();
 if(first)out.firstName=first;if(last)out.lastName=last;
 if(v.dropUsername)out.username=null;
 else{const u=normalizeUsername(String(v.username??''));if(u&&u!==item.username)out.username=u;}
 if(v.country&&v.country!==item.country)out.country=v.country;
 if(v.clearClub)out.clubText='';
 return out;
}
/** Whether a members-list billing entry is a subscription the Admin may stop before blocking or deleting. */
export const hasLiveSubscription=b=>['active','past_due'].includes(b?.state);

// ---- Views (pure: SafeHtml) ----
const countryName=code=>{const c=COUNTRIES.find(x=>x[0]===code);return c?c[getLanguage()==='pl'?1:2]:code||'';};
const sportLabel=slug=>{const s=SPORTS.find(x=>x[0]===slug);return s?T(s[1]):slug;};
/** Joins SafeHtml parts (a plain-string concatenation would be escaped again by ui.modal). */
const all=(...parts)=>h`${parts}`;
const btn=(label,act,cls='secondary',attrs={})=>h`<button type="button" class="btn ${cls}" data-mem-act="${act}"${Object.entries(attrs).map(([k,v])=>v==null||v===false?'':v===true?h` ${k}`:h` ${k}="${v}"`)}>${label}</button>`;

/** One member row. Every API value is escaped by h. */
export function memberRow(m){
 const b=planBadge(m.billing,'member'),muted=m.muted,meta=[countryName(m.country),m.createdAt?T('Konto od {date}',{date:fmtSec(m.createdAt)}):'',m.lastLoginAt?T('Ostatnie logowanie: {date}',{date:fmtSec(m.lastLoginAt)}):T('Brak logowań')].filter(Boolean).join(' · ');
 return h`<li class="mem-row${m.active?'':' is-off'}" data-mem-id="${m.id}">
  <div class="mem-who"><strong class="mem-name">${m.name||T('Profil nieuzupełniony')}</strong>${m.username?h`<span class="mem-user">@${m.username}</span>`:''}<span class="mem-email">${m.email}</span></div>
  <div class="mem-plan">${badgeHtml(b)}${m.active?'':h`<span class="badge warning">${T('Zablokowane')}</span>`}${muted?h`<a class="badge warning mem-muted" href="#moderation" data-page="moderation">${m.mutedUntil?T('Wyciszony do {date}',{date:fmtSec(m.mutedUntil)}):T('Wyciszony')} · ${T('Moderacja')}</a>`:''}</div>
  <div class="mem-meta">${meta}</div>
  <div class="mem-actions">${btn(T('Plan'),'plan','small-btn',{'data-mem-id':m.id})}${btn(T('Hasło'),'password','small-btn',{'data-mem-id':m.id})}${btn(T('E-mail'),'email','small-btn',{'data-mem-id':m.id})}${btn(T('Profil'),'profile','small-btn',{'data-mem-id':m.id})}${btn(m.active?T('Zablokuj'):T('Odblokuj'),'active','small-btn',{'data-mem-id':m.id})}${btn(T('Usuń'),'delete','small-btn danger-text',{'data-mem-id':m.id})}</div>
 </li>`;
}
/** The list with count and paging, or the loading / error / empty state. */
export function resultsView(st){
 if(st.error)return h`<div class="mem-state"><p class="form-error" role="alert">${st.error}</p>${btn(T('Spróbuj ponownie'),'retry')}</div>`;
 if(!st.data)return h`<p class="muted mem-state" role="status">${T('Wczytuję członków…')}</p>`;
 const {items=[],total=0,page=1}=st.data,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 if(!items.length)return h`<div class="mem-state mem-empty"><p><strong>${T('Brak członków spełniających kryteria.')}</strong></p><p class="muted small">${T('Zmień filtr albo frazę wyszukiwania.')}</p></div>`;
 return h`<p class="mem-count muted small" role="status">${T('Znaleziono: {n}',{n:total})}</p><ul class="mem-list">${items.map(memberRow)}</ul>
  ${pages>1?h`<nav class="mem-pager" aria-label="${T('Strony listy')}">${btn(T('Poprzednia'),'prev','secondary',{disabled:page<=1})}<span class="muted small">${T('Strona {page} z {pages}',{page,pages})}</span>${btn(T('Następna'),'next','secondary',{disabled:page>=pages})}</nav>`:''}`;
}
/** Toolbar (search, filter, new account) and the bulk panel around the results region. */
export function pageView(st){
 return h`<form class="mem-toolbar" data-mem-form="search" role="search">
   <label class="mem-search"><span class="sr-only">${T('Szukaj członka')}</span><input type="search" name="q" maxlength="100" value="${st.q}" placeholder="${T('E-mail, nazwa użytkownika lub nazwisko')}" autocomplete="off"></label>
   <label class="mem-filter"><span class="sr-only">${T('Filtr')}</span><select name="filter">${FILTERS.map(([key,label])=>h`<option value="${key}"${key===st.filter?' selected':''}>${label()}</option>`)}</select></label>
   <button class="btn primary" type="submit">${T('Szukaj')}</button>
   ${btn(T('Nowe darmowe konto'),'create','secondary')}
  </form>
  <details class="mem-bulk"><summary>${T('Wymagaj płatności od…')}</summary>
   <form class="mem-bulk-form" data-mem-form="bulk">
    <p class="muted small">${T('Dotyczy kont personelu, które są darmowe od początku (istniejące konta). Od 14 dni przed datą zobaczą baner, od daty mają 7 dni karencji, potem tylko podgląd.')}</p>
    <p class="small" data-mem-bulk-count role="status"></p>
    <label class="field-label">${T('Płatność wymagana od')}<input type="date" name="date" required min="${dayAdd(warsawToday(),BULK_MIN_DAYS)}" value="${dayAdd(warsawToday(),30)}"></label>
    <div class="form-error" role="alert"></div>
    <button class="btn secondary" type="submit">${T('Wymagaj płatności od…')}</button>
   </form></details>
  <div class="mem-results" data-mem-results aria-live="polite">${resultsView(st)}</div>`;
}
/** Read-only facts of one account in the staff form: plan, subscription, currency, last synchronisation (§6.7). */
export function factsView(d){
 const subs={active:T('Aktywna'),trialing:T('Okres próbny'),past_due:T('Zaległa płatność'),canceled:T('Anulowana'),incomplete:T('Niedokończona'),incomplete_expired:T('Wygasła'),unpaid:T('Niezapłacona'),paused:T('Wstrzymana'),none:T('Brak subskrypcji')};
 const sub=(subs[d.subStatus]||d.subStatus||subs.none)+(d.periodEnd?' · '+(d.cancelAtPeriodEnd?T('kończy się {date}',{date:fmtSec(d.periodEnd)}):T('do {date}',{date:fmtSec(d.periodEnd)})):'');
 const plan=planBadge({state:d.state,until:d.until,reason:d.exemptReason},d.role==='member'?'member':'staff');
 return h`<dl class="mem-facts">
  <div><dt>${T('Stan planu')}</dt><dd>${badgeHtml(plan)}</dd></div>
  <div><dt>${T('Subskrypcja')}</dt><dd>${sub}${d.mode?h` <span class="badge neutral">${d.mode}</span>`:''}</dd></div>
  <div><dt>${T('Waluta')}</dt><dd>${d.currency?String(d.currency).toUpperCase():'—'}${d.currencyOverride?' · '+T('ustawiona przez Administratora'):''}</dd></div>
  <div><dt>${T('Ostatnia synchronizacja')}</dt><dd>${d.lastSyncedAt?fmtTime(d.lastSyncedAt):T('jeszcze nie było')}${d.syncError?h`<span class="mem-sync-error"> · ${T('Błąd synchronizacji')}: ${d.syncError}</span>`:''}</dd></div>
 </dl>`;
}
/** The Stripe dashboard link of a customer, only for the dashboard origin (plain navigation, plan §10). */
export const stripeDashboardUrl=u=>typeof u==='string'&&/^https:\/\/dashboard\.stripe\.com\/(?:test\/)?customers\/[A-Za-z0-9_]+$/.test(u)?u:null;
/** Whether the Admin may stop the subscription at the period end from this form. */
export const cancelable=d=>!!d&&ONGOING.includes(d.subStatus)&&!d.cancelAtPeriodEnd&&!!d.subscriptionId;

// ---- Page ----
const st={q:'',filter:'all',page:1,data:null,at:0,error:'',seq:0,staff:null,staffAt:0,staffPending:null};
export const state=st;
/** Forgets the member list, search phrase and staff plans (after sign-out or an expired session: no e-mails stay in memory, plan §8.3 point 8). */
export function forget(){st.seq++;Object.assign(st,{q:'',filter:'all',page:1,data:null,at:0,error:'',staff:null,staffAt:0,staffPending:null});}
registry.on('logout',forget);
const ui=()=>registry.use('ui');
const toast=message=>ui()?.toast?.(message);
const fail=error=>toast(translateMessage(error?.message||T('Nie udało się wykonać operacji.')));
const root=()=>document.querySelector('[data-members-root]');
const errorBox=el=>el?.closest?.('form')?.querySelector('.form-error')||document.querySelector('#modal-root .form-error');
const say=(el,message)=>{const box=errorBox(el);if(box)box.textContent=message||'';else if(message)toast(message);};
const openModal=(title,body,actions='',large=false)=>ui().modal(title,body,actions,large);
const closeModal=()=>ui().closeModal();
const memberById=id=>st.data?.items?.find(i=>i.id===id)||null;

/** Staff plans {userId:{state,exempt,until,reason}} (cached for 30 s, one request in flight); null when unavailable. */
export function staffPlans(force=false){
 if(io.demo)return Promise.resolve(null);
 if(!force&&st.staff&&Date.now()-st.staffAt<STAFF_MS)return Promise.resolve(st.staff);
 if(st.staffPending&&!force)return st.staffPending;
 const pending=io.request(staffListParams()).then(data=>{st.staff=data?.users&&typeof data.users==='object'?data.users:{};st.staffAt=Date.now();return st.staff;},()=>null).finally(()=>{if(st.staffPending===pending)st.staffPending=null;});
 return st.staffPending=pending;
}
/** Fills [data-billing-badge] in the staff accounts panel. */
export async function fillStaffBadges({force=false}={}){
 if(io.demo||!document.querySelector('[data-billing-badge]'))return;
 const users=await staffPlans(force);if(!users)return;
 for(const el of document.querySelectorAll('[data-billing-badge]')){const entry=users[el.dataset.billingBadge];setHtml(el,entry?badgeHtml(planBadge(entry,'staff')):h``);}
}
/** Accounts the bulk action changes: the server updates every row with reason 'grandfathered', also one whose end date has passed. */
export const grandfathered=users=>Object.values(users||{}).filter(e=>e&&e.reason==='grandfathered').length;
async function paintBulk(){
 const users=await staffPlans();const el=document.querySelector('[data-mem-bulk-count]');
 if(el)el.textContent=users?T('Konta personelu objęte zmianą: {n}',{n:grandfathered(users)}):'';
}
function paintResults(){const box=root()?.querySelector('[data-mem-results]');if(box)setHtml(box,resultsView(st));}
async function load(force=false){
 if(!force&&st.data&&Date.now()-st.at<FRESH_MS){paintResults();return;}
 const seq=++st.seq;st.error='';if(!st.data)paintResults();
 try{
  const data=await send(listCall(st));if(seq!==st.seq)return;
  const back=clampPage(data,st.page);if(back){st.page=back;return load(true);}
  st.data=data;st.at=Date.now();
 }
 catch(error){if(seq!==st.seq)return;st.error=translateMessage(error.message);}
 paintResults();
}
export const reload=()=>load(true);
/** Draws the #members page into [data-members-root] (called after 'painted'; the page keeps its filter and results across re-renders). */
export function mountMembersPage(el=root()){
 if(!el||el.dataset.memMounted)return;el.dataset.memMounted='1';
 if(io.demo){setHtml(el,h`<section class="panel mem-demo"><h3>${T('Konta członków działają z serwerem')}</h3><p class="muted">${T('Ta funkcja jest niedostępna w wersji demonstracyjnej.')}</p></section>`);return;}
 setHtml(el,pageView(st));load();paintBulk();
}

// ---- Dialogs ----
function copyField(label,text,id){return h`<div class="mem-copyline"><span class="muted small">${label}</span><code id="${id}">${text}</code>${btn(T('Kopiuj'),'copy','small-btn',{'data-mem-copy':text})}</div>`;}
/** The temporary password, shown once, with the address to send it to (copied from the panel, §3.10). */
export function secretView({email,password,created=false}){
 return h`<p class="modal-lead">${created?T('Konto zostało utworzone.'):T('Hasło tymczasowe zostało ustawione.')} ${T('Hasło widać tylko teraz. Po zamknięciu okna nie da się go odczytać.')}</p>
  <div class="mem-secret">${copyField(T('Hasło tymczasowe'),password,'mem-secret')}</div>
  ${copyField(T('Wyślij na adres'),email,'mem-mail')}
  <p class="muted small">${T('Wyślij hasło na ten adres, skopiowany z panelu, a nie na adres z nagłówka wiadomości. Osoba zmieni hasło przy pierwszym logowaniu; do tego czasu nie napisze na czacie.')}</p>`;
}
const showSecret=data=>openModal(data.created?T('Nowe konto'):T('Hasło tymczasowe'),secretView(data),btn(T('Zamknij'),'close','primary'));

/** Country <option>s sorted by name; blank adds a first empty choice (selected without a country) so that a save never sets a country nobody chose. */
export function countryOptions(selected,blank=false){
 const key=getLanguage()==='pl'?1:2,collator=new Intl.Collator(locale());
 const list=[...COUNTRIES].sort((a,b)=>collator.compare(a[key],b[key])).map(c=>h`<option value="${c[0]}"${c[0]===selected?' selected':''}>${c[key]}</option>`);
 return blank?[h`<option value=""${selected?'':' selected'}>—</option>`,...list]:list;
}
function createDialog(){
 const today=warsawToday();
 openModal(T('Nowe darmowe konto'),h`<form id="mem-create-form" data-mem-form="create"><div class="form-grid">
   <label class="span-two">${T('E-mail')}<input name="email" type="email" required maxlength="254" autocomplete="off"></label>
   <label>${T('Imię')}<input name="firstName" required maxlength="50" autocomplete="off"></label>
   <label>${T('Nazwisko')}<input name="lastName" required maxlength="50" autocomplete="off"></label>
   <label>${T('Nazwa użytkownika')}<input name="username" required maxlength="24" autocomplete="off" spellcheck="false" placeholder="marta.k"></label>
   <label>${T('Kraj')}<select name="country">${countryOptions('PL')}</select></label>
   <fieldset class="span-two mem-sports"><legend>${T('Sporty')}</legend>${SPORTS.map(([slug,label])=>h`<label class="mem-chip"><input type="checkbox" name="sports" value="${slug}"> ${T(label)}</label>`)}</fieldset>
   <label class="span-two">${T('Powód darmowego konta')}<input name="reason" required maxlength="200" autocomplete="off"></label>
   <label class="span-two">${T('Darmowe do (opcjonalnie)')}<input name="until" type="date" min="${dayAdd(today,1)}"></label>
  </div><p class="muted small form-note">${T('Hasło tymczasowe zostanie wygenerowane i pokazane jeden raz.')}</p><div class="form-error" role="alert"></div></form>`,
  all(btn(T('Anuluj'),'close'),h`<button class="btn primary" type="submit" form="mem-create-form">${T('Utwórz konto')}</button>`),true);
}
/** The "Plan" dialog of a member: the plan fields and billing facts of the staff form (mountAccountBilling), saved by FORMS.plan. */
async function planDialog(m){
 openModal(T('Plan członka'),h`<form id="mem-plan-form" data-mem-form="plan" data-mem-id="${m.id}"><p class="modal-lead">${T('Konto: {email}',{email:m.email})}</p>
  <div data-account-billing="${m.id}" data-mem-role="member"></div><div class="form-error" role="alert"></div></form>`,
  all(btn(T('Anuluj'),'close'),h`<button class="btn primary" type="submit" form="mem-plan-form">${T('Zapisz plan')}</button>`),true);
 const mount=document.querySelector('#modal-root [data-account-billing]');if(mount)await mountAccountBilling(mount);
}
const CHECKLIST=[()=>T('Prośba przyszła z adresu zapisanego w koncie.'),()=>T('Nie resetuję hasła na prośbę telefoniczną ani z innego adresu.'),()=>T('Hasło wyślę na adres skopiowany z tego panelu, a nie z nagłówka „Od” wiadomości.')];
function passwordDialog(m){
 openModal(T('Ustaw hasło tymczasowe'),h`<p class="modal-lead">${T('Konto: {email}',{email:m.email})}</p>
  <ul class="mem-checklist">${CHECKLIST.map(text=>h`<li><label class="checkbox-label"><input type="checkbox" data-mem-check> ${text()}</label></li>`)}</ul>
  ${copyField(T('Adres do odpowiedzi'),m.email,'mem-reply')}
  <p class="muted small">${T('Osoba zostanie wylogowana na wszystkich urządzeniach i po zalogowaniu musi ustawić własne hasło.')}</p><div class="form-error" role="alert"></div>`,
  all(btn(T('Anuluj'),'close'),btn(T('Ustaw hasło tymczasowe'),'password-go','primary',{'data-mem-id':m.id,disabled:true,'data-mem-needs-check':true})));
}
function emailDialog(m){
 openModal(T('Zmień adres e-mail'),h`<form id="mem-email-form" data-mem-form="email" data-mem-id="${m.id}"><p class="modal-lead">${T('Konto: {email}',{email:m.email})}</p>
  <label class="field-label">${T('Nowy adres e-mail')}<input name="email" type="email" required maxlength="254" autocomplete="off" value="${m.email}"></label>
  <p class="muted small form-note">${T('Zmiana wyloguje tę osobę ze wszystkich urządzeń. Adres trafi też do jej danych płatności.')}</p>
  <div class="form-error" role="alert"></div>
  <div class="mem-conflict" data-mem-conflict hidden><p class="small">${T('Ten adres jest już używany. Jeśli ktoś zajął cudzy adres, zmień adres tego konta albo usuń je (gdy nie jest opłacone), a dopiero potem przypisz adres prawowitemu właścicielowi.')}</p>${btn(T('Znajdź konto z tym adresem'),'find','small-btn',{'data-mem-copy':''})}</div></form>`,
  all(btn(T('Anuluj'),'close'),h`<button class="btn primary" type="submit" form="mem-email-form">${T('Zapisz adres')}</button>`));
}
function profileDialog(m){
 openModal(T('Popraw profil'),h`<form id="mem-profile-form" data-mem-form="profile" data-mem-id="${m.id}"><p class="modal-lead">${T('Konto: {email}',{email:m.email})} · ${m.name||T('Profil nieuzupełniony')}</p>
  <p class="muted small">${T('Zostaw puste pola, których nie zmieniasz.')}</p>
  <div class="form-grid"><label>${T('Imię')}<input name="firstName" maxlength="50" autocomplete="off"></label><label>${T('Nazwisko')}<input name="lastName" maxlength="50" autocomplete="off"></label>
   <label class="span-two">${T('Nazwa użytkownika')}<input name="username" maxlength="24" autocomplete="off" spellcheck="false" value="${m.username||''}"></label>
   <label class="span-two">${T('Kraj')}<select name="country">${countryOptions(m.country,true)}</select></label>
   <label class="checkbox-label span-two"><input type="checkbox" name="dropUsername"> ${T('Usuń nazwę użytkownika (osoba wybierze nową)')}</label>
   <label class="checkbox-label span-two"><input type="checkbox" name="clearClub"> ${T('Wyczyść tekst klubu')}</label></div>
  <div class="form-error" role="alert"></div></form>`,all(btn(T('Anuluj'),'close'),h`<button class="btn primary" type="submit" form="mem-profile-form">${T('Zapisz profil')}</button>`));
}
function activeDialog(m){
 const live=hasLiveSubscription(m.billing);
 openModal(T('Zablokuj konto'),h`<p class="modal-lead">${T('Konto: {email}',{email:m.email})}</p><p>${T('Zablokowana osoba zostanie wylogowana i nie wejdzie do czatu, dopóki jej nie odblokujesz.')}</p>
  ${live?h`<div class="notice mem-warn">${T('Ta osoba ma trwającą subskrypcję. Zablokowanie nie zatrzymuje płatności.')}</div><label class="checkbox-label"><input type="checkbox" data-mem-stop checked> ${T('Zatrzymaj subskrypcję na koniec okresu')}</label>`:''}
  <div class="form-error" role="alert"></div>`,all(btn(T('Anuluj'),'close'),btn(T('Zablokuj'),'active-go','primary',{'data-mem-id':m.id})));
}
function deleteDialog(m,confirmEnd=''){
 openModal(T('Usuń konto'),h`<p class="modal-lead">${T('Konto: {email}',{email:m.email})}</p>
  ${confirmEnd?h`<div class="notice mem-warn">${confirmEnd}</div>`:h`<p>${T('Dane osobowe zostaną usunięte, a wiadomości na czacie zostaną jako „Konto usunięte”. Klient w Stripe zostanie usunięty. Tego nie można cofnąć.')}</p><label class="checkbox-label"><input type="checkbox" data-mem-check> ${T('Rozumiem, że tego nie można cofnąć.')}</label>`}
  <div class="form-error" role="alert"></div>`,all(btn(T('Anuluj'),'close'),confirmEnd?btn(T('Zakończ subskrypcję i usuń konto'),'delete-go','danger-text',{'data-mem-id':m.id,'data-mem-end':'1'}):btn(T('Usuń konto'),'delete-go','primary',{'data-mem-id':m.id,disabled:true,'data-mem-needs-check':true})));
}

// ---- Actions ----
const busy=(el,on)=>{if(el)el.disabled=on;};
/** The submit button of a dialog form (it stands in the modal footer, outside the form, tied by the form attribute). */
const submitOf=form=>document.querySelector('button[type=submit][form="'+form.id+'"]')||form.querySelector('button[type=submit]');
async function run(el,fn){busy(el,true);try{await fn();}catch(error){say(el,translateMessage(error.message));}finally{busy(el,false);}}
async function stopSubscription(userId){try{await send(billingCall({action:'cancelAtPeriodEnd',userId}));staffPlans(true);}catch(error){fail(error);}}
async function copyText(text){
 try{await navigator.clipboard.writeText(text);return true;}catch{}
 try{const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();return ok;}catch{return false;}
}
const ACTS={
 close:()=>closeModal(),
 retry:()=>reload(),
 prev:()=>{if(st.page>1){st.page--;reload();}},
 next:()=>{st.page++;reload();},
 create:()=>createDialog(),
 plan:(el)=>{const m=memberById(el.dataset.memId);if(m)return planDialog(m);},
 password:(el)=>{const m=memberById(el.dataset.memId);if(m)passwordDialog(m);},
 email:(el)=>{const m=memberById(el.dataset.memId);if(m)emailDialog(m);},
 profile:(el)=>{const m=memberById(el.dataset.memId);if(m)profileDialog(m);},
 active:(el)=>{
  const m=memberById(el.dataset.memId);if(!m)return;
  if(m.active)return activeDialog(m);
  return run(el,async()=>{await send(memberCall('active',{userId:m.id,active:true}));toast(T('Konto odblokowane.'));await reload();});
 },
 delete:(el)=>{const m=memberById(el.dataset.memId);if(m)deleteDialog(m);},
 copy:async(el)=>{toast(await copyText(el.dataset.memCopy||'')?T('Skopiowano.'):T('Nie udało się skopiować. Zaznacz tekst ręcznie.'));},
 find:(el)=>{const email=el.dataset.memCopy||el.closest('.modal')?.querySelector('input[name=email]')?.value||'';st.q=email;st.filter='all';st.page=1;closeModal();const input=root()?.querySelector('input[name=q]');if(input)input.value=email;reload();},
 'password-go':(el)=>run(el,async()=>{
  const m=memberById(el.dataset.memId);if(!m)return;
  const r=await send(memberCall('password',{userId:m.id}));
  showSecret({email:m.email,password:r.temporaryPassword});reload();
 }),
 'active-go':(el)=>run(el,async()=>{
  const m=memberById(el.dataset.memId);if(!m)return;const stop=!!el.closest('.modal')?.querySelector('[data-mem-stop]:checked');
  await send(memberCall('active',{userId:m.id,active:false}));
  if(stop)await stopSubscription(m.id);
  closeModal();toast(T('Konto zablokowane.'));reload();
 }),
 'delete-go':(el)=>run(el,async()=>{
  const m=memberById(el.dataset.memId);if(!m)return;
  try{await send(memberCall('delete',{userId:m.id,...(el.dataset.memEnd?{endSubscription:true}:{})}));}
  catch(error){if(error?.status===409&&error.data?.confirmEnd){deleteDialog(m,translateMessage(error.message));return;}throw error;}
  closeModal();toast(T('Konto usunięte.'));staffPlans(true);reload();
 }),
 'bulk-go':(el)=>run(el,async()=>{
  const date=el.dataset.memDate,check=validateRequireFrom(date,{scope:'grandfathered'});if(!check.ok){say(el,check.error);return;}
  const r=await send(billingCall({action:'requireFrom',date,scope:'grandfathered'}));
  closeModal();toast(T('Zmieniono konta: {n}',{n:r?.count??0}));await staffPlans(true);paintBulk();fillStaffBadges();
 }),
 'bill-resync':(el)=>run(el,async()=>{
  const mount=el.closest('[data-account-billing]'),s=mounts.get(mount);if(!s?.id)return;
  const r=await send(billingCall({action:'resync',userId:s.id}));
  if(r?.account)s.detail=r.account;paintFacts(mount);toast(r?.busy?T('Synchronizacja już trwa.'):T('Zsynchronizowano.'));staffPlans(true).then(()=>fillStaffBadges());if(s.member)reload();
 }),
 'bill-stop':(el)=>run(el,async()=>{
  const mount=el.closest('[data-account-billing]'),s=mounts.get(mount);if(!s?.id)return;
  if(el.dataset.memArmed!=='1'){el.dataset.memArmed='1';el.textContent=T('Potwierdź zatrzymanie');setTimeout(()=>{if(el.isConnected){el.dataset.memArmed='';el.textContent=T('Zatrzymaj subskrypcję na koniec okresu');}},5000);return;}
  const r=await send(billingCall({action:'cancelAtPeriodEnd',userId:s.id}));
  if(r?.account)s.detail=r.account;paintFacts(mount);toast(T('Subskrypcja zakończy się z końcem okresu.'));staffPlans(true).then(()=>fillStaffBadges());if(s.member)reload();
 }),
 'stop-later':(el)=>run(el,async()=>{await send(billingCall({action:'cancelAtPeriodEnd',userId:el.dataset.memId}));closeModal();toast(T('Subskrypcja zakończy się z końcem okresu.'));staffPlans(true).then(()=>fillStaffBadges());if(root())reload();})
};
export const FORMS={
 search:(form)=>{const f=new FormData(form);st.q=String(f.get('q')||'');st.filter=String(f.get('filter')||'all');st.page=1;return reload();},
 bulk:(form)=>{
  const date=String(new FormData(form).get('date')||''),check=validateRequireFrom(date,{scope:'grandfathered'});
  if(!check.ok){say(form,check.error);return;}
  const n=grandfathered(st.staff);
  openModal(T('Wymagaj płatności od…'),h`<p class="modal-lead">${T('Płatność będzie wymagana od {date}.',{date:fmtYmd(date)})}</p>
   <ul class="mem-steps"><li>${T('Konta objęte zmianą: {n}',{n})}</li><li>${T('Baner „Od {date} konto wymaga płatności” pojawi się od {from}.',{date:fmtYmd(date),from:fmtYmd(dayAdd(date,-14))})}</li><li>${T('Karencja trwa do {date}, potem konta mają tylko podgląd.',{date:fmtYmd(dayAdd(date,GRACE_DAYS))})}</li></ul><div class="form-error" role="alert"></div>`,
   all(btn(T('Anuluj'),'close'),btn(T('Wymagaj płatności'),'bulk-go','primary',{'data-mem-date':date})));
 },
 create:(form)=>run(submitOf(form),async()=>{
  const f=new FormData(form),body=createBody({email:f.get('email'),firstName:f.get('firstName'),lastName:f.get('lastName'),username:f.get('username'),country:f.get('country'),sports:f.getAll('sports'),reason:f.get('reason'),until:f.get('until')});
  if(!body.sports.length){say(form,T('Wybierz co najmniej jeden sport.'));return;}
  const r=await send(memberCall('create',body));
  showSecret({email:body.email,password:r.temporaryPassword,created:true});reload();
 }),
 email:(form)=>run(submitOf(form),async()=>{
  const email=String(new FormData(form).get('email')||'').trim();
  try{await send(memberCall('email',{userId:form.dataset.memId,email}));}
  catch(error){if(error?.status===409){const box=form.querySelector('[data-mem-conflict]');if(box){box.hidden=false;box.querySelector('[data-mem-copy]').dataset.memCopy=email;}}throw error;}
  closeModal();toast(T('Adres e-mail zmieniony. Osoba została wylogowana.'));reload();
 }),
 plan:(form)=>run(submitOf(form),async()=>{
  const mount=form.querySelector('[data-account-billing]'),s=mount&&mounts.get(mount);
  if(!s?.detail){say(form,s?.error||T('Stan płatności nie został wczytany.'));return;}
  const r=await applyPlan({s,userId:s.id,v:readPlanValues(mount)});
  if(!r.ok){say(form,r.error);return;}
  if(r.offerStop)offerStopDialog(s.id);else closeModal();
  toast(r.changed?T('Zapisano ustawienia płatności.'):T('Nic nie zmieniono.'));staffPlans(true);reload();
 }),
 profile:(form)=>run(submitOf(form),async()=>{
  const f=new FormData(form),m=memberById(form.dataset.memId)||{},fields=profileFields({firstName:f.get('firstName'),lastName:f.get('lastName'),username:f.get('username'),country:f.get('country'),dropUsername:f.has('dropUsername'),clearClub:f.has('clearClub')},m);
  if(!Object.keys(fields).length){say(form,T('Nic nie zmieniono.'));return;}
  await send(memberCall('profile',{userId:form.dataset.memId,...fields}));
  closeModal();toast(T('Profil zapisany.'));reload();
 })
};
function onClick(event){
 const el=event.target.closest?.('[data-mem-act]');if(!el||el.disabled)return;
 const act=ACTS[el.dataset.memAct];if(!act)return;
 event.preventDefault();
 Promise.resolve().then(()=>act(el)).catch(fail);
}
function onSubmit(event){
 const form=event.target.closest?.('form[data-mem-form]');if(!form)return;
 event.preventDefault();const handler=FORMS[form.dataset.memForm];
 if(handler)Promise.resolve().then(()=>handler(form)).catch(error=>say(form,translateMessage(error.message)));
}
function onChange(event){
 const el=event.target;
 if(event.type==='input'&&el.name!=='mem-until')return;
 if(el.matches?.('[data-mem-check]')){const box=el.closest('.modal');const go=box?.querySelector('[data-mem-needs-check]');if(go)go.disabled=![...box.querySelectorAll('[data-mem-check]')].every(c=>c.checked);}
 const mount=el.closest?.('form')?.querySelector('[data-account-billing]');
 if(mount&&(el.matches?.('[data-mem-free]')||['role','active','mem-until'].includes(el.name)))syncBilling(mount);
}
if(typeof document!=='undefined'){document.addEventListener('click',onClick);document.addEventListener('submit',onSubmit);document.addEventListener('change',onChange);document.addEventListener('input',onChange);}

// ---- Plan fields: the staff account form and the "Plan" dialog of a member ([data-account-billing], §3.2, §6.7) ----
const mounts=new WeakMap();
const NOTE=s=>s.member?T('Darmowe konto daje pełny dostęp bez subskrypcji.'):T('Bez darmowego konta osoba po włączeniu płatności ma tylko podgląd, dopóki nie wykupi planu.');
const CURRENCIES=[['',()=>T('Z kraju w profilu')],['pln','PLN'],['usd','USD']];
function billingShell(s){
 const cur=s.detail?.currencyOverride||'',locked=!s.detail||ONGOING.includes(s.detail.subStatus);
 return h`<fieldset class="mem-bill" data-mem-bill><legend>${T('Płatności')}</legend>
  <label class="checkbox-label mem-free"><input type="checkbox" name="mem-free" data-mem-free${s.checked?' checked':''}> ${T('Darmowe konto (bez płatności)')}</label>
  <p class="muted small mem-note">${NOTE(s)}</p>
  <div class="mem-on" data-mem-on hidden><div class="form-grid">
   <label class="span-two">${T('Powód darmowego konta')}<input name="mem-reason" maxlength="200" autocomplete="off" value="${s.loaded.reason}"></label>
   <label class="span-two">${T('Darmowe do (opcjonalnie)')}<input name="mem-until" type="date" min="${dayAdd(warsawToday(),1)}" value="${s.loaded.until}"></label></div>
   <label class="checkbox-label mem-stop" data-mem-stop-row hidden><input type="checkbox" name="mem-stop"> ${T('Zatrzymaj też subskrypcję na koniec okresu')}</label></div>
  <div class="mem-off" data-mem-off hidden><label class="field-label">${T('Płatność wymagana od')}<input name="mem-from" type="date" min="${warsawToday()}" value="${warsawToday()}"></label>
   <p class="muted small">${T('Od tej daty konto wymaga płatności. Potem jest 7 dni karencji, a dopiero potem tylko podgląd.')}</p></div>
  <label class="checkbox-label mem-stop" data-mem-block-row hidden><input type="checkbox" name="mem-block-stop" checked> ${T('Konto jest blokowane, ale ma trwającą subskrypcję. Zatrzymaj ją na koniec okresu.')}</label>
  ${s.isNew?'':h`<div class="mem-currency" data-mem-currency-row><label class="field-label">${T('Waluta planu')}<select name="mem-currency" data-mem-currency${locked?' disabled':''}>${CURRENCIES.map(([key,label])=>h`<option value="${key}"${key===cur?' selected':''}>${typeof label==='function'?label():label}</option>`)}</select></label>
   ${s.detail&&locked?h`<p class="muted small">${T('Waluty nie zmienisz przy trwającej subskrypcji.')}</p>`:''}</div>`}
  <div class="mem-facts-box" data-mem-facts>${s.isNew?'':h`<p class="muted small" role="status">${T('Wczytuję stan płatności…')}</p>`}</div>
  <div class="mem-bill-actions" data-mem-bill-actions></div></fieldset>`;
}
function paintFacts(mount){
 const s=mounts.get(mount);if(!s||!mount.isConnected)return;
 const box=mount.querySelector('[data-mem-facts]'),acts=mount.querySelector('[data-mem-bill-actions]'),d=s.detail;
 if(!d){if(box&&!s.isNew)setHtml(box,h`<p class="form-error">${s.error||''}</p>`);return;}
 setHtml(box,factsView(d));
 const url=stripeDashboardUrl(d.dashboardUrl);
 setHtml(acts,h`${d.customerId?btn(T('Synchronizuj teraz'),'bill-resync','small-btn'):''}${url?h`<a class="btn small-btn secondary" href="${url}" target="_blank" rel="noopener noreferrer">${T('Otwórz w Stripe')}</a>`:''}${cancelable(d)?btn(T('Zatrzymaj subskrypcję na koniec okresu'),'bill-stop','small-btn danger-text'):''}`);
 syncBilling(mount);
}
/** Shows reason/end date or the require-from date for the switch position, and the Admin role hides the section. The reason becomes required
 * while a plan change would need it, so the browser refuses the form before the account is saved. */
export function syncBilling(mount){
 const s=mounts.get(mount);if(!s||!mount.isConnected)return;
 const form=mount.closest('form'),role=form?.querySelector('[name=role]')?.value||s.role,hide=role==='admin';
 const fieldset=mount.querySelector('[data-mem-bill]'),free=mount.querySelector('[data-mem-free]').checked;
 fieldset.hidden=hide;fieldset.disabled=hide;
 const on=mount.querySelector('[data-mem-on]'),off=mount.querySelector('[data-mem-off]'),showOn=!hide&&free,showOff=!hide&&!free&&!s.isNew&&s.wasExempt;
 on.hidden=!showOn;off.hidden=!showOff;
 for(const input of on.querySelectorAll('input'))input.disabled=!showOn;
 for(const input of off.querySelectorAll('input'))input.disabled=!showOff;
 mount.querySelector('[name=mem-reason]').required=reasonRequired({free:showOn,isNew:s.isNew,wasExempt:s.wasExempt,loaded:s.loaded,until:mount.querySelector('[name=mem-until]').value});
 mount.querySelector('[name=mem-from]').required=showOff;
 const stopRow=mount.querySelector('[data-mem-stop-row]');stopRow.hidden=!(showOn&&!s.wasExempt&&cancelable(s.detail));
 const blocking=!hide&&form?.querySelector('[name=active]')?.value==='no'&&s.detail?.active!==false;
 mount.querySelector('[data-mem-block-row]').hidden=!(blocking&&cancelable(s.detail));
}
/** Mounts the plan fields into [data-account-billing] of an opened account form or member dialog (members-boot calls it when the form appears). */
export async function mountAccountBilling(mount){
 if(io.demo||!mount?.isConnected||mount.dataset.memMounted)return;mount.dataset.memMounted='1';
 const id=mount.dataset.accountBilling||'',form=mount.closest('form'),member=mount.dataset.memRole==='member',role=form?.querySelector('[name=role]')?.value||(member?'member':'club');
 const s={id,isNew:!id,role,member,wasExempt:false,checked:false,detail:null,loaded:{reason:'',until:''},error:''};
 mounts.set(mount,s);
 setHtml(mount,billingShell(s));syncBilling(mount);
 if(s.isNew)return;
 try{
  const data=await io.request(billingDetailParams(id));if(!mount.isConnected)return;
  s.detail=data.account;s.wasExempt=!!s.detail.exempt;s.loaded=loadedExemption(s.detail);
  const sw=freeToggle({isNew:false,role:s.detail.role,exempt:s.detail.exempt});s.checked=sw.checked;
  setHtml(mount,billingShell(s));syncBilling(mount);paintFacts(mount);
 }catch(error){s.error=translateMessage(error.message);s.failed=true;paintFacts(mount);}
}
/** What the Admin entered in the plan fields, read from the elements (the form may already be closing). */
export function readPlanValues(mount){
 const q=n=>mount.querySelector('[name="'+n+'"]'),cur=q('mem-currency');
 return {free:!!q('mem-free')?.checked,reason:q('mem-reason')?.value||'',until:q('mem-until')?.value||'',from:q('mem-from')?.value||'',stop:!!q('mem-stop')?.checked,blockStop:!!q('mem-block-stop')?.checked,currency:cur&&!cur.disabled?cur.value:null};
}
/** Sends the plan change the fields ask for (§3.2): the exempt / require / requireFrom call of planBilling, the currency override, and, when the
 * account is being blocked, the subscription stop. Returns {ok:false,error} before anything is sent when the plan is invalid, else
 * {ok:true,changed,offerStop}: offerStop is set when a paying person was made free and the Admin did not tick the stop (§3.2, 03 §10.2). */
export async function applyPlan({s,userId,v,blocked=false}){
 const plan=planBilling({isNew:s.isNew,wasExempt:s.wasExempt,free:v.free,reason:v.reason,until:v.until,from:v.from,loaded:s.loaded});
 if(!plan.ok)return plan;
 let changed=false,stopped=false,offerStop=false;
 if(plan.call){
  const r=await send(billingCall({...plan.call,userId}));changed=true;
  if(plan.call.action==='exempt'&&r?.warnLive){if(v.stop){await stopSubscription(userId);stopped=true;}else offerStop=true;}
 }
 const cur=s.isNew?null:currencyChange(s.detail,v.currency);
 if(cur){await send(billingCall({...cur,userId}));changed=true;}
 if(blocked&&!stopped&&v.blockStop&&cancelable(s.detail)){await stopSubscription(userId);changed=true;}
 return {ok:true,changed,offerStop};
}
const offerStopDialog=userId=>openModal(T('Trwająca subskrypcja'),h`<p>${T('Ta osoba ma trwającą subskrypcję w Stripe. Nadal będzie z niej obciążana, dopóki jej nie zatrzymasz.')}</p>`,all(btn(T('Zostaw'),'close'),btn(T('Zatrzymaj subskrypcję na koniec okresu'),'stop-later','primary',{'data-mem-id':userId})));
/** After a successful account.save (event 'saved' with result.id): sends the plan change decided by applyPlan. The form may already be
 * closing, so the values are read from its elements at once. */
export async function onAccountSaved({payload,result,element}){
 const mount=element?.querySelector?.('[data-account-billing]'),s=mount&&mounts.get(mount);
 if(!s||s.failed||!result?.id||payload?.role==='admin'||(!s.isNew&&!s.detail))return;
 const v=readPlanValues(mount);
 try{
  const r=await applyPlan({s,userId:result.id,v,blocked:payload?.active===false});
  if(!r.ok){toast(r.error);return;}
  if(r.offerStop)offerStopDialog(result.id);
  if(r.changed)toast(T('Zapisano ustawienia płatności.'));
 }catch(error){fail(error);}
 finally{fillStaffBadges({force:true});}
}
