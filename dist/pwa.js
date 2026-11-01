/* MatBravo PWA in the interface (plan §9.2, §9.4; research 04 §1.4.3, §1.5 and 05 §13). Imported statically by app.js, so that the
 * deferred `beforeinstallprompt` is captured before `await Client.init()`.
 * - Service worker: registered ~2 s after 'ready', API mode only, updateViaCache:'none'; reg.update() when the tab becomes visible
 *   again (at most hourly). A new worker waits; the update bar ("Refresh") sends SKIP_WAITING and reloads this tab only. Other tabs
 *   get a passive notice. Nothing is ever shown on #screen or in the print preview.
 * - 'client-outdated' (409, plan §9.4): no unsaved form (form[data-dirty]), no signup/payment in progress -> the waiting worker is
 *   applied and the tab reloads; otherwise a blocking bar. #screen reloads at once (it has no fields). A reload that did not help is
 *   not repeated within a minute (no reload loop when the server needs a client the cached shell cannot provide); on #screen the page then
 *   waits for a worker that finishes installing (applied at once) and retries after the guard, so the hall display never stays stuck.
 * - Install card: only for a signed-in person, never on the first visit, in the demo, standalone, on #screen, in the print preview,
 *   during signup or payment, with a modal open, while a field has focus, within the first 15 s of a page or twice in a session.
 *   Dismissal memory in localStorage['matdraw.pwa'] (30 days; after the third refusal never). Without working storage nothing is shown.
 * - iOS sheet (3 steps), in-app browser banner (with "Copy link"), standalone detection (html[data-standalone], appinstalled).
 * Templates use h`…` and setHtml (plan §5.9). The rules and the update flow are plain functions/factories so that tests run them
 * without a browser; the browser wiring at the bottom runs only when a window exists. */
import {registry,h,setHtml} from './registry.js';
import {CONFIG} from './runtime-config.js';
import {t as T} from './i18n.js';
import {warsawToday} from './guest-view.js';
import {resolveClub} from './workspace.js';

export const KEY='matdraw.pwa',DAY=864e5,MUTE_MS=30*DAY,INAPP_MUTE_MS=7*DAY,MAX_REFUSALS=3;
export const MIN_AGE=15e3,INAPP_AGE=4e3,SENT_DELAY=3e3,ACTIVE_NEED=9e4,ACTIVE_TICK=1e4,LOOP_GUARD_MS=6e4,CHECK_MS=36e5;
export const MANIFEST={pl:'./manifest.webmanifest',en:'./manifest.en.webmanifest'};

// ---- Memory (localStorage['matdraw.pwa'], every access guarded) ----
const count=(v,max)=>Number.isFinite(v)&&v>0?Math.min(Math.floor(v),max):0;
const stamp=(v,now)=>Number.isFinite(v)&&v>0?Math.min(v,now):0;
const dayOf=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)?v:null;
/** Validated record: first visit day, last signed-in day and the number of such days, refusals, dismissal/in-app/installed times. */
export const cleanRecord=(raw,now=Date.now())=>{const r=raw&&typeof raw==='object'?raw:{};return {first:dayOf(r.first),day:dayOf(r.day),days:count(r.days,9999),refusals:count(r.refusals,99),dismissedAt:stamp(r.dismissedAt,now),inappAt:stamp(r.inappAt,now),installed:stamp(r.installed,now)};};
/** Why prompts are silent for this record: 'installed' | 'never' (3 refusals) | 'dismissed' (30 days) | ''. */
export const muted=(r,now)=>r.installed?'installed':r.refusals>=MAX_REFUSALS?'never':r.dismissedAt&&now-r.dismissedAt<MUTE_MS?'dismissed':'';
export const refused=(r,now)=>({...r,refusals:r.refusals+1,dismissedAt:now});
export const inappMuted=(r,now)=>!!r.inappAt&&now-r.inappAt<INAPP_MUTE_MS;
/** A visit: remembers the first day; a signed-in visit on a new day raises the day count. */
export const visited=(r,today,signedIn)=>({...r,first:r.first||today,...(signedIn&&r.day!==today?{day:today,days:r.days+1}:{})});
/** Store over a Storage-like object. read() is null when storage is unusable; update(fn) never throws and reports whether it persisted. */
export function createStore(storage,now=Date.now){
 const store={ok:false,
  read(){try{const raw=storage.getItem(KEY);let data=null;try{data=raw?JSON.parse(raw):null;}catch{}return cleanRecord(data,now());}catch{return null;}},
  update(fn){const r=store.read();if(!r){store.ok=false;return null;}const next=fn(r);try{storage.setItem(KEY,JSON.stringify(next));store.ok=true;}catch{store.ok=false;}return store.ok?next:null;}
 };
 return store;
}

// ---- Environment detection ----
/** 'ios' (iPhone, iPad, iPadOS posing as a Mac) | 'android' | 'other'. */
export const platformOf=({ua='',platform='',touch=0}={})=>/iP(?:hone|ad|od)/.test(ua)||(platform==='MacIntel'&&touch>1)?'ios':/Android/i.test(ua)?'android':'other';
const IN_APP=/Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|musical_ly|BytedanceWebview|TikTok|Snapchat|\bLine\/|LinkedInApp/i;
/** Conservative user-agent test for in-app browsers (Instagram, Facebook, TikTok, …); best effort, those apps can change their UA. */
export const inAppBrowser=ua=>IN_APP.test(String(ua||''));
export const manifestHref=lang=>lang==='en'?MANIFEST.en:MANIFEST.pl;
/** Points <link rel="manifest"> at the manifest of the language (guarded: also called in environments without a document). */
export function setManifestLanguage(lang,doc=globalThis.document){
 try{const link=doc?.querySelector?.('link[rel="manifest"]');if(link&&link.getAttribute('href')!==manifestHref(lang))link.setAttribute('href',manifestHref(lang));}catch{}
}
/** Installed-app display mode (display-mode media queries, iOS navigator.standalone). 'fullscreen' is deliberately not here: Chromium
 * matches (display-mode: fullscreen) whenever the Fullscreen API is active (the hall view full-screen button, F11), in a plain tab too. */
export const standaloneNow=(w=globalThis)=>{try{return ['standalone','minimal-ui'].some(m=>w.matchMedia?.('(display-mode: '+m+')').matches)||w.navigator?.standalone===true;}catch{return false;}};
/** What may be remembered as "installed" for good: a standalone window or iOS home-screen launch, never minimal-ui (also a mere hint). */
export const installedNow=(w=globalThis)=>{try{return !!w.matchMedia?.('(display-mode: standalone)').matches||w.navigator?.standalone===true;}catch{return false;}};
/** Whether this club has entries in a tournament dated today (Warsaw time): the "tournament day" trigger. A snapshot's club is read
 * through the Administrator's merges (resolveClub, as Domain::entryVisible; final review R1.5). */
export const tournamentToday=(workspace,today)=>{
 const user=workspace?.user;if(!user)return false;const clubs=workspace.clubs||[];
 return (workspace.tournaments||[]).some(t=>t.date===today&&t.status!=='draft'&&(t.entries||[]).some(e=>(resolveClub(clubs,e.clubId)?.id??e.clubId)===user.clubId));
};
/** True on the first visit ever (storage works and no first day was recorded before this page). */
export const isFirstVisit=before=>!!before&&!before.first;
export const isScreenHash=hash=>String(hash||'').startsWith('#screen');
/** Print preview or projection mode of the shell. */
export const isPrinting=doc=>!!doc?.body&&(doc.body.classList.contains('print-preview')||doc.body.classList.contains('projection'));
/** An app modal is open (shell marks body.modal-open and fills #modal-root). */
export const modalOpen=doc=>!!doc?.body&&(doc.body.classList.contains('modal-open')||!!doc.querySelector('#modal-root .modal'));
/** The focused element takes text (a click on a button or a checkbox is not typing). */
export const typingIn=a=>!!a&&!!(a.isContentEditable||a.matches?.('textarea,select,input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=file])'));
/** A form the person has typed in (form[data-dirty]; searches and the chat composer never mark it). */
export const dirtyForm=doc=>!!doc?.querySelector?.('form[data-dirty]');
/** Whether an input event dirties its form: not for [data-no-dirty] forms, the chat composer or search fields. */
export const dirties=el=>{const form=el?.closest?.('form');return !!form&&!form.matches('[data-no-dirty],.chat-composer')&&!el.matches('[type=search]');};
export const FLOW_MARK='matdraw.flow.active',FLOW_MS=18e5,FLOW_KEYS_MS=6e5,FLOW_KEYS=/^matdraw\.(?:signup|billing)\./;
/** Signup or payment in progress. The contract: account-frontend sets sessionStorage['matdraw.flow.active']=Date.now() while a flow runs
 * and removes it on completion or cancel (a mark older than 30 minutes is stale). Leftover matdraw.signup.* / matdraw.billing.* keys
 * count too, but only for 10 minutes after this page first saw them, so a key that is never removed cannot block the tab for good. */
export function flowBusy({mark,keys=[],seen,now}){
 const m=Number(mark);if(m>0&&now-m<FLOW_MS)return true;
 let busy=false;for(const k of [...seen.keys()])if(!keys.includes(k))seen.delete(k);
 for(const k of keys){if(!seen.has(k))seen.set(k,now);if(now-seen.get(k)<FLOW_KEYS_MS)busy=true;}
 return busy;
}
/** Hash routes where the person is registering or paying (nothing is shown, nothing is reloaded behind their back). */
export const busyRoute=(hash,search='')=>/^#(?:signup|billing)(?:[?/]|$)/.test(hash||'')||/(?:^|[?&])billing=/.test(search||'');

// ---- Install card rules ----
/** Why no install prompt may be shown now ('' when nothing speaks against it). ctx comes from the browser wiring; tests pass their own. */
export function blocker(c){
 if(c.mode!=='api')return 'demo';
 if(!c.storage)return 'storage';
 if(!c.signedIn)return 'guest';
 if(c.standalone)return 'standalone';
 const m=muted(c.record,c.now);if(m)return m;
 if(c.inApp)return 'in-app';
 if(c.firstVisit)return 'first-visit';
 if(c.age<MIN_AGE)return 'too-early';
 if(c.shown)return 'shown';
 if(c.screen)return 'screen';
 if(c.printing)return 'print';
 if(c.busy)return 'busy';
 if(c.modal)return 'modal';
 if(c.typing)return 'typing';
 if(c.hidden)return 'hidden';
 if(!c.canInstall)return 'no-path';
 return '';
}
/** Which trigger is due: desktop only a return visit (3rd day of use, a small chip); a phone: tournament day, 3 s after the first
 * sent chat message, the second day of use, 90 s of active chat. */
export function dueTrigger(c){
 const days=c.record.days;
 if(c.platform==='other')return days>=3?'return-visit':'';
 if(c.tournamentToday)return 'tournament-day';
 if(c.sentAt&&c.now-c.sentAt>=SENT_DELAY)return 'chat-sent';
 if(days>=2)return 'second-day';
 if(c.activeMs>=ACTIVE_NEED)return 'chat-active';
 return '';
}
export const decide=c=>{const reason=blocker(c);return {reason,trigger:reason?'':dueTrigger(c)};};
/** The in-app browser banner: API mode, an in-app UA, not installed, working storage, not dismissed within 7 days, not on the first paint. */
export const inappDue=c=>c.mode==='api'&&c.inApp&&c.storage&&!c.standalone&&!c.screen&&!c.printing&&!inappMuted(c.record,c.now)&&c.age>=INAPP_AGE;
/** The URL to copy: origin and path only, never the query or hash (they can carry invite tokens or payment session ids). */
export const shareUrl=loc=>String(loc.origin||'')+String(loc.pathname||'/');

// ---- Update flow ----
/** Service worker registration, update offer and the required update. env: {mode, sw, secure, hash(), dirty(), busy(), reload(),
 * show(kind|null) with kind 'update'|'passive'|'blocking', later(fn,ms), now(), recent(), mark()}; everything is injected for tests. */
export function createUpdater(env){
 const s={reg:null,waiting:null,refreshing:false,controlled:false,outdated:false,awaiting:false,checkedAt:0};
 // A worker that finishes installing while a required update is stuck on #screen (s.awaiting) is applied at once; otherwise it is offered.
 const offer=(w,fresh)=>{s.waiting=w;if(!s.outdated){env.show('update');return;}if(fresh&&s.awaiting){s.awaiting=false;env.mark();go(w);}};
 const track=w=>w.addEventListener('statechange',()=>{if(w.state==='installed'&&env.sw.controller)offer(w,true);});
 function go(w){s.refreshing=true;w.postMessage('SKIP_WAITING');env.later(()=>env.reload(),5000);}
 function watch(reg){
  s.reg=reg;s.checkedAt=env.now();
  if(reg.waiting&&env.sw.controller)offer(reg.waiting);
  if(reg.installing)track(reg.installing);
  reg.addEventListener('updatefound',()=>{if(reg.installing)track(reg.installing);});
 }
 async function register(){
  if(env.mode!=='api'||!env.sw||!env.secure)return null;
  s.controlled=!!env.sw.controller;
  // The first install takes control (clients.claim): that is not an update. Only a change after a controller existed is announced.
  env.sw.addEventListener('controllerchange',()=>{const was=s.controlled;s.controlled=true;if(s.refreshing)env.reload();else if(was&&!s.outdated)env.show('passive');});
  try{watch(await env.sw.register('./sw.js',{scope:'./',updateViaCache:'none'}));}catch{return null;}
  return s.reg;
 }
 /** Hourly at most; called when the tab becomes visible. */
 async function check(){if(!s.reg||env.now()-s.checkedAt<CHECK_MS)return;s.checkedAt=env.now();try{await s.reg.update();}catch{}}
 /** The person clicked "Refresh": this tab takes the waiting worker and reloads when it has taken control. */
 function refresh(){
  if(!s.waiting){env.reload();return;}
  s.refreshing=true;s.waiting.postMessage('SKIP_WAITING');env.later(()=>env.reload(),4000);
 }
 const pause=ms=>new Promise(r=>env.later(r,ms));
 async function ensureWaiting(){
  if(s.waiting)return s.waiting;
  let reg=s.reg;if(!reg&&env.sw){try{reg=await env.sw.getRegistration('./');}catch{}}
  if(!reg)return null;
  s.reg=reg;if(reg.waiting)return reg.waiting;
  try{await Promise.race([reg.update(),pause(6000)]);}catch{}
  if(reg.waiting)return reg.waiting;
  const w=reg.installing;if(!w)return null;
  return new Promise(res=>{
   const done=()=>res(w.state==='installed'?w:null);
   if(w.state==='installed'||w.state==='redundant')return done();
   w.addEventListener('statechange',()=>{if(w.state==='installed'||w.state==='redundant')done();});env.later(()=>res(null),8000);
  });
 }
 /** Applies the newest release now: waiting worker -> SKIP_WAITING -> reload on controllerchange; without a worker a plain reload. */
 async function applyNow(){
  s.refreshing=true;env.mark();
  const w=await ensureWaiting();
  if(w)go(w);else env.reload();
 }
 /** 409 client_outdated (plan §9.4); returns the promise of the automatic update when one is started. */
 function outdated(){
  if(s.outdated)return;s.outdated=true;
  const screen=String(env.hash()).startsWith('#screen');
  if(env.recent()){
   if(!screen){env.show('blocking');return;}
   // The hall screen has nobody to press a button: wait for a worker that finishes installing, ask for one, and try again after the guard.
   s.awaiting=true;try{s.reg?.update?.()?.catch?.(()=>{});}catch{}
   env.later(()=>{if(s.awaiting){s.awaiting=false;applyNow();}},LOOP_GUARD_MS+1000);return;
  }
  if(screen||!(env.dirty()||env.busy()))return applyNow();
  env.show('blocking');
 }
 return {state:s,register,check,refresh,applyNow,outdated};
}

// ---- Templates (SafeHtml) ----
const ui=()=>{try{return registry.use('ui')||null;}catch{return null;}};
const ico=(name,cls='')=>ui()?.icon?.(name,cls)||'';
const btn=(label,act,cls='secondary')=>h`<button type="button" class="btn ${cls} pwa-btn" data-pwa-act="${act}">${label}</button>`;
const BENEFIT=()=>T('Drabinki i czat jednym stuknięciem — także w hali, bez szukania karty w przeglądarce.');
/** Update bars: kind 'update' (new version waiting), 'passive' (another tab updated), 'blocking' (client_outdated with unsaved work). */
export function updateView(kind){
 if(kind==='update')return h`<div class="pwa-bar"><p class="pwa-bar-text">${T('Dostępna jest nowa wersja MatBravo.')}</p>${btn(T('Odśwież'),'refresh','primary')}</div>`;
 if(kind==='passive')return h`<div class="pwa-bar"><p class="pwa-bar-text">${T('Wersja została zaktualizowana. Odśwież stronę, gdy będzie wygodnie.')}</p>${btn(T('Odśwież'),'reload','primary')}</div>`;
 if(kind==='blocking')return h`<div class="pwa-bar pwa-bar-block"><p class="pwa-bar-text">${T('Wymagana aktualizacja MatBravo.')}</p>${btn(T('Odśwież teraz'),'update-now','primary')}</div>`;
 return null;
}
/** Install prompt: a card on phones, a small chip on desktop. */
export function cardView({trigger,kind,ios}){
 if(kind==='chip')return h`<section class="pwa-chip" aria-label="${T('Zainstaluj MatBravo')}"><img class="pwa-chip-icon" src="./brand/icon-192.png" width="24" height="24" alt=""><button type="button" class="pwa-chip-main" data-pwa-act="install">${T('Zainstaluj aplikację')}</button><button type="button" class="pwa-x" data-pwa-act="later" aria-label="${T('Nie teraz')}" title="${T('Nie teraz')}">${ico('close')}</button></section>`;
 return h`<section class="pwa-card" aria-labelledby="pwa-card-title"><img class="pwa-icon" src="./brand/icon-192.png" width="44" height="44" alt=""><div class="pwa-copy"><strong id="pwa-card-title">${T('Zainstaluj MatBravo')}</strong><p>${trigger==='tournament-day'?T('Dziś zawody — miej drabinki pod ręką.'):BENEFIT()}</p></div><div class="pwa-actions">${btn(ios?T('Jak zainstalować?'):T('Zainstaluj'),ios?'how':'install','primary')}${btn(T('Nie teraz'),'later')}</div></section>`;
}
/** iOS "Add to Home Screen" sheet. Steps follow research 05 §19.11 [to be checked on a Polish iPhone, iOS 26 moved Share into the ⋯ menu]. */
export function sheetView(){
 const step=(n,icon,text)=>h`<li><span class="pwa-step-n" aria-hidden="true">${n}</span><span class="pwa-step-ico" aria-hidden="true">${icon}</span><span>${text}</span></li>`;
 return h`<div class="pwa-sheet-backdrop" data-pwa-backdrop><section class="pwa-sheet" role="dialog" aria-modal="true" aria-labelledby="pwa-sheet-title" tabindex="-1"><div class="pwa-sheet-head">${ui()?.mascot?.('guide','pwa-mascot')||''}<div><h2 id="pwa-sheet-title">${T('Dodaj MatBravo do ekranu początkowego')}</h2><p>${BENEFIT()}</p></div></div><ol class="pwa-steps">${step(1,ico('share'),T('Stuknij Udostępnij'))}${step(2,ico('plus-square'),T('Wybierz „Do ekranu początkowego”'))}${step(3,ico('check'),T('Potwierdź przyciskiem Dodaj'))}</ol><p class="pwa-note">${T('Nie widzisz przycisku? Stuknij ⋯, potem Udostępnij.')}</p><p class="pwa-note">${T('Po dodaniu zaloguj się ponownie w aplikacji: iPhone przechowuje dane aplikacji osobno od Safari.')}</p><div class="pwa-sheet-actions">${btn(T('Gotowe'),'sheet-close','primary')}</div></section></div>`;
}
/** In-app browser banner; copied: the link was copied, fallback: the URL to select by hand when the clipboard is blocked. */
export function inappView({platform,copied,fallback}){
 const steps=platform==='ios'?T('Stuknij ⋯, potem „Otwórz w Safari”.'):T('Stuknij ⋮, potem „Otwórz w Chrome”.');
 return h`<section class="pwa-inapp" aria-label="${T('Otwórz w przeglądarce, aby zainstalować MatBravo i pozostać zalogowanym')}"><div class="pwa-inapp-copy"><strong>${T('Otwórz w przeglądarce, aby zainstalować MatBravo i pozostać zalogowanym')}</strong><p>${steps}</p>${fallback?h`<input class="pwa-url" type="text" readonly value="${fallback}" aria-label="${T('Zaznacz i skopiuj link.')}">`:''}</div><div class="pwa-actions">${btn(copied?T('Link skopiowany.'):T('Kopiuj link'),'copy','primary')}<button type="button" class="pwa-x" data-pwa-act="inapp-close" aria-label="${T('Zamknij')}" title="${T('Zamknij')}">${ico('close')}</button></div></section>`;
}

// ---- Browser wiring ----
const browser=typeof window!=='undefined'&&typeof document!=='undefined';
/** Hooks for the profile page and other modules (registry.use('pwa')). */
const api={canInstall:()=>false,install:async()=>'unavailable'};
registry.provide('pwa',api);

if(browser){
 const win=window,doc=document,nav=win.navigator,started=Date.now(),mode=CONFIG.mode;
 const store=createStore((()=>{try{return win.localStorage;}catch{return {getItem(){throw new TypeError();},setItem(){throw new TypeError();}};}})());
 const platform=platformOf({ua:nav.userAgent,platform:nav.platform,touch:nav.maxTouchPoints}),inApp=inAppBrowser(nav.userAgent);
 const view={update:null,blocking:false,card:null,inapp:false,sheet:false,copied:false,fallback:'',focusUrl:false};
 let deferred=null,sentAt=0,activeMs=0,firstVisit=false,previousFocus=null,regions=null;
 const SHOWN='matdraw.pwa.shown',RELOADED='matdraw.pwa.reloaded';
 const session={get:k=>{try{return win.sessionStorage.getItem(k);}catch{return null;}},set:(k,v)=>{try{win.sessionStorage.setItem(k,v);}catch{}},keys:re=>{try{const out=[];for(let i=0;i<win.sessionStorage.length;i++){const k=win.sessionStorage.key(i);if(k&&re.test(k))out.push(k);}return out;}catch{return [];}}};
 const workspace=()=>{try{return ui()?.getWorkspace?.()||null;}catch{return null;}};
 const onScreen=()=>isScreenHash(win.location.hash);
 const printing=()=>isPrinting(doc);
 const seenKeys=new Map();
 const busy=()=>busyRoute(win.location.hash,win.location.search)||flowBusy({mark:session.get(FLOW_MARK),keys:session.keys(FLOW_KEYS),seen:seenKeys,now:Date.now()});
 const dirty=()=>dirtyForm(doc);
 const standalone=()=>standaloneNow(win);

 // -- storage and visits --
 const touch=signedIn=>store.update(r=>visited(r,warsawToday(),signedIn));
 { const before=store.read();firstVisit=isFirstVisit(before);touch(false); }

 // -- update bars --
 const updater=createUpdater({mode,sw:nav.serviceWorker||null,secure:win.isSecureContext!==false,hash:()=>win.location.hash,dirty,busy,
  reload:()=>win.location.reload(),later:(fn,ms)=>win.setTimeout(fn,ms),now:()=>Date.now(),
  recent:()=>Date.now()-(Number(session.get(RELOADED))||0)<LOOP_GUARD_MS,mark:()=>session.set(RELOADED,String(Date.now())),
  show:kind=>{view.blocking=kind==='blocking';view.update=kind==='blocking'?null:kind;paint();}});

 // -- rendering --
 function ensureRegions(){
  const root=doc.querySelector('#pwa-root');if(!root)return null;
  if(regions&&regions.root===root)return regions;
  root.textContent='';
  const make=(parent,name,attrs={})=>{const el=doc.createElement('div');el.className='pwa-region';el.dataset.pwaRegion=name;if(attrs.role)el.dataset.live='';else el.hidden=true;for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);parent.append(el);return el;};
  const top=doc.createElement('div');top.className='pwa-top';root.append(top);
  const stack=doc.createElement('div');stack.className='pwa-stack';root.append(stack);
  regions={root,inapp:make(top,'inapp'),update:make(stack,'update',{role:'status'}),blocking:make(stack,'blocking',{role:'alert'}),card:make(stack,'card'),sheet:make(root,'sheet')};
  root.addEventListener('click',onClick);
  return regions;
 }
 /** Writes a region only when its HTML changed (role=status/alert regions stay in the tree, empty, so screen readers announce what is inserted); keeps the focused control focused across a re-render. */
 function put(el,safe){
  const key=safe?String(safe):'';if(!('live' in el.dataset))el.hidden=!safe;
  if(el.dataset.key===key)return;
  const act=el.contains(doc.activeElement)?doc.activeElement.dataset?.pwaAct:null;
  if(safe)setHtml(el,safe);else el.textContent='';
  el.dataset.key=key;
  if(act)el.querySelector('[data-pwa-act="'+act+'"]')?.focus();
 }
 function paint(){
  const r=ensureRegions();if(!r)return;
  const hide=onScreen()||printing();
  put(r.update,!hide&&view.update?updateView(view.update):null);
  put(r.blocking,!hide&&view.blocking?updateView('blocking'):null);
  put(r.card,!hide&&!busy()&&view.card?cardView(view.card):null);
  put(r.inapp,!hide&&view.inapp?inappView({platform,copied:view.copied,fallback:view.fallback}):null);
  const open=!hide&&view.sheet;
  put(r.sheet,open?sheetView():null);
  if(open&&!r.sheet.contains(doc.activeElement))r.sheet.querySelector('.pwa-sheet')?.focus();
  if(view.focusUrl&&view.fallback&&!hide){const input=r.inapp.querySelector('.pwa-url');if(input){view.focusUrl=false;input.focus();input.select();}}
 }

 // -- install --
 async function install(){
  if(deferred){
   const event=deferred;deferred=null;view.card=null;paint();
   try{
    event.prompt();const choice=await event.userChoice;
    if(choice?.outcome==='accepted'){store.update(r=>({...r,installed:Date.now()}));return 'accepted';}
    store.update(r=>refused(r,Date.now()));return 'dismissed';
   }catch{return 'unavailable';}
  }
  if(platform==='ios'&&!standalone()&&!inApp){openSheet();return 'sheet';}
  return 'unavailable';
 }
 api.canInstall=()=>mode==='api'&&!standalone()&&!inApp&&(!!deferred||platform==='ios');
 api.install=install;api.standalone=standalone;
 function openSheet(){previousFocus=doc.activeElement;view.card=null;view.sheet=true;paint();}
 function closeSheet(){view.sheet=false;paint();if(previousFocus?.isConnected)previousFocus.focus();previousFocus=null;}
 function later(){store.update(r=>refused(r,Date.now()));view.card=null;paint();}
 async function copyLink(){
  const url=shareUrl(win.location);
  try{await nav.clipboard.writeText(url);view.copied=true;view.fallback='';ui()?.toast?.(T('Link skopiowany.'));}catch{view.copied=false;view.fallback=url;view.focusUrl=true;}
  paint();
 }
 const ACTS={refresh:()=>updater.refresh(),reload:()=>win.location.reload(),'update-now':()=>updater.applyNow(),install,how:openSheet,later,'sheet-close':closeSheet,copy:copyLink,
  'inapp-close':()=>{store.update(r=>({...r,inappAt:Date.now()}));view.inapp=false;view.fallback='';view.focusUrl=false;paint();}};
 function onClick(event){
  const target=event.target;if(!target?.closest)return;
  if(target.hasAttribute('data-pwa-backdrop')){closeSheet();return;}
  const el=target.closest('[data-pwa-act]'),act=el&&ACTS[el.dataset.pwaAct];
  if(act)Promise.resolve(act()).catch(()=>{});
 }
 doc.addEventListener('keydown',event=>{
  if(!view.sheet)return;
  const sheet=regions?.sheet;if(!sheet)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeSheet();return;}
  if(event.key==='Tab')registry.trapTab(event,sheet);
 },true);

 // -- the card: evaluated on a slow heartbeat and on events --
 function context(){
  const rec=store.read(),ws=workspace(),now=Date.now(),signedIn=!!ws?.user;
  return {mode,storage:!!rec&&store.ok,record:rec||cleanRecord(null),now,signedIn,standalone:standalone(),inApp,firstVisit,age:now-started,shown:!!session.get(SHOWN),
   screen:onScreen(),printing:printing(),busy:busy(),modal:modalOpen(doc),typing:typingIn(doc.activeElement),hidden:doc.hidden,canInstall:api.canInstall(),platform,
   sentAt,activeMs,tournamentToday:signedIn&&tournamentToday(ws,warsawToday())};
 }
 function check(){
  if(mode!=='api')return;
  const c=context();
  if(!view.inapp&&inappDue(c)){view.inapp=true;paint();}
  if(view.card||c.shown)return;
  const {trigger}=decide(c);if(!trigger)return;
  session.set(SHOWN,'1');view.card={trigger,kind:platform==='other'?'chip':'card',ios:platform==='ios'};paint();
 }
 if(mode==='api')win.setInterval(check,5e3);

 // -- standalone, install events --
 function applyStandalone(){
  if(doc.fullscreenElement)return;
  const on=standalone();doc.documentElement.toggleAttribute('data-standalone',on);
  if(!on)return;
  if(installedNow(win))store.update(r=>r.installed?r:{...r,installed:Date.now()});
  if(view.card||view.sheet){view.card=null;view.sheet=false;paint();}
 }
 applyStandalone();
 for(const m of ['standalone','minimal-ui']){try{win.matchMedia('(display-mode: '+m+')').addEventListener('change',applyStandalone);}catch{}}
 win.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferred=event;});
 win.addEventListener('appinstalled',()=>{deferred=null;store.update(r=>({...r,installed:Date.now()}));view.card=null;view.sheet=false;paint();applyStandalone();ui()?.toast?.(T('MatBravo jest na ekranie głównym.'));});

 // -- unsaved forms: form[data-dirty] marks a form the person has typed in (searches and the chat composer do not count) --
 doc.addEventListener('input',event=>{
  const el=event.target;
  if(dirties(el))el.closest('form').setAttribute('data-dirty','');
 },true);
 doc.addEventListener('reset',event=>event.target?.removeAttribute?.('data-dirty'),true);
 registry.on('saved',detail=>detail?.element?.removeAttribute?.('data-dirty'));

 // -- registry signals --
 registry.on('ready',({workspace:ws}={})=>{
  touch(!!ws?.user);setManifestLanguage(doc.documentElement.lang);paint();
  if(mode==='api')win.setTimeout(()=>updater.register(),2000);
 });
 registry.on('login',()=>{touch(true);});
 registry.on('logout',()=>{view.card=null;view.sheet=false;sentAt=0;activeMs=0;paint();});
 registry.on('language',({lang}={})=>{setManifestLanguage(lang);paint();});
 registry.on('painted',()=>paint());
 registry.on('client-outdated',()=>updater.outdated());
 registry.on('chat:sent',()=>{sentAt=sentAt||Date.now();});
 registry.on('chat:active',()=>{activeMs=Math.min(activeMs+ACTIVE_TICK,9e5);});
 win.addEventListener('hashchange',paint);
 try{new MutationObserver(paint).observe(doc.body,{attributes:true,attributeFilter:['class']});}catch{}
 doc.addEventListener('visibilitychange',()=>{if(!doc.hidden){updater.check();check();}});
}
