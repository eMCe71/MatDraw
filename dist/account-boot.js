/* Accounts entry module (plan §8.1, §8.9, §12.12), imported statically by app.js and kept small; the screens live in the lazily
 * loaded account-flow.js (sign-up, profile, e-mail and password, plan and Stripe returns, subscription, account deletion).
 * Here: the pages signup (public steps 1-2, signed-in step 3), profile and billing; the actions access-cta and my-account;
 * ACCESS.kind and the home sign-up card from public-config (matrix §6.10); the "forgot password" panel (§3.10); the Stripe
 * return parameters (?billing=success|cancel|portal&session_id=, read here before app.js routes, then removed from the address);
 * matdraw.knownDevice after a login; 402 -> #billing; mustChangePassword -> #profile?tab=security with the other pages blocked;
 * the staff banners "payment required from {date}" / grace / view only; the signed-in person's photo in the sidebar.
 * Flow mark (plan §9.4, contract with pwa.js): sessionStorage['matdraw.flow.active']=Date.now() during the whole sign-up and
 * from the return from Stripe until confirm ends; removed when the flow finishes or is left. Templates: h`…` and setHtml only. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {getMe,onMe} from './me.js';
import {ACCESS,setAccessKind} from './promo.js';
import {t as T,getLanguage} from './i18n.js';

export const FLOW_MARK='matdraw.flow.active',FLOW_MS=18e5,RETURN_KEY='matdraw.billing.return',RETURN_MS=36e5,KNOWN_DEVICE='matdraw.knownDevice',NOTICE_KEY='matdraw.account.notice';
export const SESSION_ID=/^cs_(?:test|live)_[A-Za-z0-9]{10,250}$/;
export const ROLES=['admin','editor','club','member'],FLOW_PAGES=['signup','billing'];
const ui=()=>registry.use('ui');
const sessionStore=()=>{try{return globalThis.sessionStorage||null;}catch{return null;}};

// ---- Pure helpers (tests/account-ui.test.mjs) ----
/** ACCESS.kind from public-config (plan §6.10): no sign-up -> 'login'; sign-up with enforced payments -> 'paid'; sign-up without -> 'free'. */
export const accessKind=cfg=>!cfg?.signup?'login':cfg.billing?'paid':'free';
/** Currency of the price shown before the country is known: the interface language decides (05 §6.3); the plan follows the country. */
export const priceCurrency=lang=>lang==='pl'?'pln':'usd';
/** Monthly price for display (05 §15): the language's own currency with its symbol (PLN in Polish, $ in English), the other one
 * with its code ('2,99 USD' in Polish, 'PLN 8.99' in English). '' for bad input. */
export function formatPrice(minor,currency,lang=getLanguage()){
 const cur=String(currency||'').toUpperCase(),n=Number(minor);if(!/^[A-Z]{3}$/.test(cur)||!Number.isFinite(n)||n<0)return '';
 const pl=lang==='pl',home=pl?'PLN':'USD';
 try{return new Intl.NumberFormat(pl?'pl-PL':'en-GB',{style:'currency',currency:cur,currencyDisplay:cur!==home?'code':cur==='USD'?'narrowSymbol':'symbol'}).format(n/100);}catch{return (n/100).toFixed(2)+' '+cur;}
}
/** ?billing=success|cancel|portal (&session_id=cs_…) from location.search, or null. A malformed session id is dropped (sync instead). */
export function parseBillingReturn(search){
 let q;try{q=new URLSearchParams(String(search||''));}catch{return null;}
 const kind=q.get('billing');if(!['success','cancel','portal'].includes(kind))return null;
 const id=q.get('session_id');return {kind,sessionId:kind==='success'&&SESSION_ID.test(id||'')?id:null};
}
/** The search string without billing and session_id ('' or '?…'), e.g. '?source=pwa' stays. */
export function stripBillingParams(search){
 let q;try{q=new URLSearchParams(String(search||''));}catch{return '';}
 q.delete('billing');q.delete('session_id');const s=q.toString();return s?'?'+s:'';
}
/** Flow mark (plan §9.4): set at the start of sign-up and on the return from Stripe, removed when the flow ends. */
export function flowStart(storage=sessionStore(),now=Date.now()){try{storage?.setItem(FLOW_MARK,String(now));}catch{}}
export function flowEnd(storage=sessionStore()){try{storage?.removeItem(FLOW_MARK);}catch{}}
export function flowActive(storage=sessionStore(),now=Date.now()){try{const v=Number(storage?.getItem(FLOW_MARK));return v>0&&now-v<FLOW_MS;}catch{return false;}}
/** The pending Stripe return kept in sessionStorage (purged at sign-out with the other matdraw.billing.* keys); 1 hour at most. */
export function saveReturn(ret,storage=sessionStore(),now=Date.now()){try{storage?.setItem(RETURN_KEY,JSON.stringify({kind:ret.kind,sessionId:ret.sessionId||null,at:now}));}catch{}}
export function readReturn(storage=sessionStore(),now=Date.now()){
 try{const r=JSON.parse(storage?.getItem(RETURN_KEY)||'null');
  if(!r||!['success','cancel','portal'].includes(r.kind)||!(now-Number(r.at)<RETURN_MS))return null;
  return {kind:r.kind,sessionId:SESSION_ID.test(r.sessionId||'')?r.sessionId:null};}catch{return null;}
}
export function clearReturn(storage=sessionStore()){try{storage?.removeItem(RETURN_KEY);}catch{}}
/** Staff banner (plan §3.2, §6.6) for me at unix time now: {kind:'soon'|'grace',until} or {kind:'blocked'} or null. */
export function bannerInfo(me,now=Date.now()/1000){
 if(!me?.billing?.enabled||!me.billing.enforce)return null;
 const a=me.access||{};
 if(a.state==='grace'&&a.until)return {kind:'grace',until:a.until};
 if(a.state==='free'&&a.until>now&&a.until-now<=14*86400)return {kind:'soon',until:a.until};
 if(a.full===false&&me.user?.role!=='member')return {kind:'blocked',until:null};
 return null;
}
export const formatDate=unix=>{try{return new Date(Number(unix)*1000).toLocaleDateString(getLanguage()==='pl'?'pl-PL':'en-GB',{day:'numeric',month:'long',year:'numeric'});}catch{return '';}};

// ---- Runtime state ----
const browser=typeof window!=='undefined'&&typeof document!=='undefined';
let config=null,paymentMessage='';
const workspace=()=>{try{return ui()?.getWorkspace?.()||null;}catch{return null;}};
const route=()=>registry.parseRoute(browser?location.hash:'');
let flowModule=null;
/** account-flow.js, loaded once on demand. */
export const flow=()=>flowModule||=import('./account-flow.js').catch(error=>{flowModule=null;throw error;});
/** public-config as loaded (null before it arrives or when the server has none). */
export const publicConfig=()=>config;
/** Takes the 402 message once (shown at the top of the plan page). */
export const takePaymentMessage=()=>{const m=paymentMessage;paymentMessage='';return m;};
const guestPrice=()=>{const cur=priceCurrency(getLanguage()),a=config?.amounts?.[cur];return a?formatPrice(a,cur):null;};

// Return from Stripe (05 §11.2): remember it for this tab, drop the parameters and route to #billing before app.js reads the hash.
if(browser){const ret=parseBillingReturn(location.search);if(ret){saveReturn(ret);flowStart();try{history.replaceState(null,'',location.pathname+stripBillingParams(location.search)+'#billing');}catch{}}}

const configReady=browser?Client.publicGet({route:'public-config'}).then(({status,data})=>status===200&&data&&typeof data==='object'?data:null,()=>null).then(c=>{config=c;applyConfig();return c;}):Promise.resolve(null);
function applyConfig(){
 const before=ACCESS.kind;setAccessKind(accessKind(config),{price:guestPrice,translate:T});
 paintLogin();
 // An open guest preview drew its access card with the previous kind: redraw it (only the unlocked preview has one).
 if(before!==ACCESS.kind&&!workspace()&&document.querySelector('.access-card'))ui()?.render?.();
}

// ---- Home page: sign-up card and the "forgot password" panel (plan §8.9, §3.10) ----
const icon=(name,cls='')=>ui()?.icon?.(name,cls)??h``;
function joinCard(){
 const kind=ACCESS.kind;if(kind==='login')return h``;
 const cur=priceCurrency(getLanguage()),other=cur==='pln'?'usd':'pln',a=config?.amounts||{};
 const price=kind==='paid'&&a[cur]?formatPrice(a[cur],cur):'',otherPrice=kind==='paid'&&a[other]?formatPrice(a[other],other):'';
 const fine=otherPrice?(cur==='pln'?T('Poza Polską: {price} / miesiąc · płatność przez Stripe',{price:otherPrice}):T('W Polsce: {price} / miesiąc · płatność przez Stripe',{price:otherPrice})):'';
 return h`<section class="acct-join" aria-labelledby="acct-join-title"><div class="acct-join-top"><div><span class="eyebrow">${T('NOWE KONTO')}</span><strong id="acct-join-title">${T('Dołącz do społeczności')}</strong></div>${price?h`<div class="acct-price"><b>${price}</b><span>${T('miesięcznie')}</span></div>`:''}</div><ul>${[T('Pisz w czatach i czatach turniejów'),T('Profil z Twoim sportem, krajem i klubem'),T('Widzisz, kto rozmawia')].map(b=>h`<li>${icon('check')}<span>${b}</span></li>`)}</ul><a class="btn secondary acct-join-cta" href="#signup">${T('Załóż konto')} ${icon('arrow')}</a>${fine?h`<p class="acct-fine">${fine}</p>`:''}</section>`;
}
function helpView(){
 const support=typeof config?.support==='string'?config.support:'',signup=!!config?.signup;
 return h`<span class="acct-help">${T('Konta klubów zakłada Administrator turnieju.')} <button type="button" class="acct-link" data-acct-act="help" aria-expanded="false" aria-controls="acct-help-panel">${T('Nie pamiętasz hasła?')}</button>${signup?h` <span class="acct-help-join">${T('Nie masz konta?')} <a class="acct-link" href="#signup">${T('Załóż konto')}</a></span>`:''}</span><span class="acct-help-panel" id="acct-help-panel" hidden><strong>${T('Odzyskiwanie dostępu')}</strong><span>${support?T('Napisz z adresu, na który założono konto, na adres pomocy MatBravo. Odpowiemy tylko na ten adres.'):T('Skontaktuj się z Administratorem turnieju.')}</span>${support?h`<a class="acct-help-mail" href="mailto:${support}">${icon('mail')}<span>${support}</span></a>`:''}<span>${T('Dostaniesz hasło tymczasowe. Po zalogowaniu ustawisz własne.')}</span></span>`;
}
function paintLogin(){
 if(!browser||workspace())return;
 const join=document.querySelector('[data-account-mount="join"]');if(join)setHtml(join,joinCard());
 const help=document.querySelector('[data-account-mount="login-help"]');
 if(help&&(config?.support||config?.signup)&&!help.querySelector('.acct-help')){help.classList.add('acct-help-host');setHtml(help,helpView());}
 if(readReturn()){const box=document.querySelector('#login-form .form-error');if(box)box.textContent=T('Zaloguj się ponownie, aby dokończyć aktywację konta.');}
}

// ---- Signed-in shell: banner, own photo, forced password change, pages ----
function bannerView(b){
 const date=b.until?formatDate(b.until):'';
 const title=b.kind==='soon'?T('Od {date} konto wymaga płatności.',{date}):b.kind==='grace'?T('Karencja do {date}.',{date}):T('Konto wymaga płatności.');
 const text=b.kind==='soon'?T('Wybierz plan, aby zachować pełny dostęp.'):b.kind==='grace'?T('Darmowy okres się skończył. Po tym dniu konto będzie tylko do podglądu, dopóki nie wybierzesz planu.'):T('Masz dostęp tylko do podglądu. Wybierz plan, aby zapisywać zmiany.');
 return h`<span class="acct-banner-icon">${icon('card')}</span><p><strong>${title}</strong> ${text}</p><button type="button" class="btn primary acct-banner-btn" data-acct-act="plan">${T('Wybierz plan')}</button>`;
}
function paintBanner(page){
 const main=document.querySelector('#main');if(!main)return;
 main.querySelector(':scope>.acct-banner')?.remove();
 const b=FLOW_PAGES.includes(page)?null:bannerInfo(getMe());if(!b)return;
 const el=document.createElement('div');el.className='acct-banner'+(b.kind==='blocked'?' blocked':'');el.setAttribute('role','status');setHtml(el,bannerView(b));main.prepend(el);
}
/** URL of a profile photo: the avatar route ('?route=avatar&id=…&v=…&s=64|256', plan §4.3) or the demo's data: URL. */
export function avatarSrc(profile,size=64){
 const v=profile?.avatar;if(typeof v!=='string'||!v)return null;
 if(/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v))return v;
 return /^[0-9a-f]{12}$/.test(v)&&/^[A-Za-z0-9]{6,32}$/.test(profile.publicId||'')?Client.apiUrl({route:'avatar',id:profile.publicId,v,s:size>64?256:64}):null;
}
function paintSelf(){
 const src=avatarSrc(getMe()?.profile,64);
 for(const el of document.querySelectorAll('[data-self-avatar]')){
  if(el.dataset.acctInitials===undefined)el.dataset.acctInitials=el.textContent;
  const img=el.querySelector('img.acct-self-img');
  if(!src){if(img){el.textContent=el.dataset.acctInitials;}continue;}
  if(img?.getAttribute('src')===src)continue;
  const next=document.createElement('img');next.className='acct-self-img';next.alt='';next.width=34;next.height=34;next.decoding='async';
  next.addEventListener('error',()=>{el.textContent=el.dataset.acctInitials||'';},{once:true});next.src=src;el.replaceChildren(next);
 }
}
/** §3.10: with a temporary password every page except #profile?tab=security leads there. */
function guard(){
 const me=getMe(),ws=workspace();if(!ws?.user||!me?.profile?.mustChangePassword||me.user?.id!==ws.user.id)return false;
 const r=route();if(r.page==='screen'||(r.page==='profile'&&r.params.get('tab')==='security'))return false;
 ui()?.closeModal?.();ui()?.navigate?.('profile',{tab:'security'});return true;
}
function mountPage(page){
 const el=document.querySelector('[data-acct-page]');if(!el)return;
 flow().then(m=>m.mount(page,el)).catch(error=>{try{console.error('MatBravo account page failed',error);}catch{}setHtml(el,h`<p class="acct-loading">${T('Nie udało się wczytać strony. Odśwież stronę.')}</p>`);});
}
/** A sign-up or payment flow that was left (another page, the login page) drops its mark; a pending Stripe return keeps it. */
function leaveFlow(page){if(flowActive()&&!readReturn()&&!FLOW_PAGES.includes(page))flowEnd();}

const page=(id,title,subtitle,roles=ROLES)=>({id,icon:'user',nav:null,roles,order:900,label:title,title,
 render:()=>ui().shell(h`<div class="acct-page" data-acct-page="${id}" aria-busy="true"><p class="acct-loading" role="status">${T('Wczytywanie…')}</p></div>`,title(),subtitle())});
const safely=fn=>{try{fn();}catch(error){try{console.error('MatBravo account registration failed',error);}catch{}}};
safely(()=>registry.registerPage(page('profile',()=>T('Moje konto'),()=>T('Profil, subskrypcja i bezpieczeństwo konta.'))));
safely(()=>registry.registerPage(page('billing',()=>T('Plan i płatności'),()=>T('Konto MatBravo z pełnym dostępem do społeczności.'))));
safely(()=>registry.registerPage(page('signup',()=>T('Wybierz plan'),()=>T('Ostatni krok zakładania konta.'),['member'])));
safely(()=>registry.registerPublicPage({id:'signup',render(params){
 const app=document.querySelector('#app');document.body.classList.remove('projection','print-preview');document.title='MatBravo — '+T('Załóż konto');
 setHtml(app,h`<div class="acct-public" data-acct-public="signup" aria-busy="true"><p class="acct-loading" role="status">${T('Wczytywanie…')}</p></div>`);
 flow().then(m=>m.mountPublic(app,params)).catch(error=>{try{console.error('MatBravo sign-up failed',error);}catch{}setHtml(app,h`<p class="acct-loading">${T('Nie udało się wczytać strony. Odśwież stronę.')}</p>`);});
}}));
// Guest access card, chat CTA and the plan prompt of unpaid members (plan §6.10, 05 §6.3): sign-up for guests, the plan when signed in.
safely(()=>registry.registerAction('access-cta',(el,id,ctx={})=>{if(ctx.workspace||workspace())ui()?.navigate?.('billing');else if(ACCESS.kind!=='login')location.hash='#signup';},{public:true}));
safely(()=>registry.registerAction('my-account',()=>{if(workspace())ui()?.navigate?.('profile');}));
// For other modules (e.g. the chat CTA): the loaded public-config, the access kind and price formatting.
registry.provide('account',{ready:configReady,config:()=>config,accessKind:()=>ACCESS.kind,formatPrice,priceLabel:guestPrice,avatarSrc});

if(browser){
 registry.on('painted',({view,page:p,memberPreview}={})=>{
  if(view==='login'){paintLogin();leaveFlow('login');
   let notice=null;try{notice=sessionStorage.getItem(NOTICE_KEY);sessionStorage.removeItem(NOTICE_KEY);}catch{}
   if(notice==='deleted')ui()?.toast?.(T('Konto zostało usunięte.'));}
  else if(view==='app'){if(guard())return;leaveFlow(p);paintBanner(p);paintSelf();if(['profile','billing','signup'].includes(p))mountPage(p);}
  else if(view==='guest'){if(memberPreview&&guard())return;leaveFlow('guest');}
  else if(view==='public'&&p!=='signup')leaveFlow(p);
 });
 registry.on('login',()=>{
  try{localStorage.setItem(KNOWN_DEVICE,'1');}catch{}
  // Login after the session expired during payment: confirm replays on the plan page.
  if(readReturn())ui()?.navigate?.('billing');
 });
 registry.on('language',()=>{if(document.querySelector('[data-acct-public]'))flow().then(m=>m.repaint()).catch(()=>{});});
 registry.on('payment-required',({message}={})=>{
  if(!workspace()?.user||route().page==='billing')return;
  paymentMessage=message||'';ui()?.closeModal?.();ui()?.navigate?.('billing');
 });
 onMe(()=>{if(guard())return;const r=route();if(workspace()&&!['screen','guest'].includes(r.page))paintBanner(r.page);paintSelf();});
 document.addEventListener('click',event=>{
  const el=event.target.closest?.('[data-acct-act]');if(!el)return;const act=el.dataset.acctAct;
  if(act==='help'){const panel=document.getElementById('acct-help-panel');if(!panel)return;const open=panel.hidden;panel.hidden=!open;el.setAttribute('aria-expanded',String(open));}
  else if(act==='plan')ui()?.navigate?.('billing');
 });
}
