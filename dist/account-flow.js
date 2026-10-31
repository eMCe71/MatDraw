/* Account screens (plan §3.6-§3.10, §6.1-§6.2, §7.1-§7.5, §12.12; research 05 §9-§11), loaded on demand by account-boot.js.
 *  - Sign-up in 3 steps (05 §10): 1 account (signup-begin with the invite from the address; e-mail, password with a strength hint,
 *    empty consent slot, bot trap), 2 profile (the account is created here: username check by POST 400 ms after typing stops with
 *    the names in the body, suggestions, country from navigator.languages, sports, optional photo, "show my full name" unticked),
 *    3 plan (skipped while payments are off). The flow mark (plan §9.4) stays set for the whole sign-up.
 *  - #profile with the tabs Profile | Subscription | Security: profile and photo; subscription state with the Stripe portal;
 *    password (staff: ui.commit('account.password'), members: member-password), e-mail (member-email), install the app (pwa),
 *    delete the account (password, then a second confirmation when the server answers confirmEnd).
 *  - #billing: plan (currency from the country, price from the server; billing-checkout sends no currency), return states after
 *    Stripe (confirm every 3 s for up to 30 s), portal return (billing-sync). Stripe pages open only after the origin check.
 * Demo (plan §8.8): sign-up and payments show the demo message; profile edits and the photo (data: URL) stay in localStorage.
 * Every value from the API reaches the DOM through h`…`/setHtml or textContent (plan §5.9). Form ids carry the acct- prefix. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {getMe,loadMe,saveDemoProfile,purgeSession} from './me.js';
import {t as T,getLanguage,translateMessage} from './i18n.js';
import {COUNTRIES,SPORTS,SPORTS_MAX,CLUB_MAX,validateUsername,normalizeUsername,validateName,suggestUsernames,slugName,cleanText} from './profile-data.js';
import {openCrop} from './avatar-crop.js';
import {flowStart,flowEnd,readReturn,clearReturn,formatPrice,formatDate,publicConfig,takePaymentMessage,avatarSrc,KNOWN_DEVICE,NOTICE_KEY} from './account-boot.js';

export const CHECKOUT_ORIGIN='https://checkout.stripe.com',PORTAL_ORIGIN='https://billing.stripe.com',CHECK_DELAY=400,CONFIRM_EVERY=3000,SYNC_EVERY=11000,CONFIRM_LIMIT=30000;
const CODES=new Set(COUNTRIES.map(c=>c[0])),EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,COMMON=/pass(?:word)?|has(?:l|\u0142)o|qwert|12345|abcde|matbravo|matdraw|taekwondo/;
const FAILED=['expired','canceled','incomplete_expired','unpaid','paused','foreign'];

// ---- Pure helpers (tests/account-ui.test.mjs) ----
/** Country from navigator.languages (05 §10.4): the first tag with a region (pl-PL -> PL, de-AT -> AT); a bare pl -> PL; else null. */
export function defaultCountry(languages){
 for(const tag of Array.isArray(languages)?languages:[languages]){
  if(typeof tag!=='string')continue;
  const m=/^([a-z]{2,3})(?:[-_][a-z]{4})?(?:[-_]([a-z]{2}))?(?=[-_]|$)/i.exec(tag.trim());if(!m)continue;
  const code=(m[2]||(m[1].toLowerCase()==='pl'?'pl':'')).toUpperCase();if(code&&CODES.has(code))return code;
 }
 return null;
}
/** Plan currency from the profile country (plan §6.1): PL -> pln, any other listed country -> usd, none -> null. */
export const currencyFor=country=>typeof country==='string'&&CODES.has(country)?(country==='PL'?'pln':'usd'):null;
/** Strength hint without composition rules (05 §10.2): level 0 too short/long, 1 weak, 2 good, 3 very good. */
export function passwordStrength(value){
 const s=String(value??''),bytes=new TextEncoder().encode(s).length;
 if(bytes<12)return {level:0,key:'short'};if(bytes>72)return {level:0,key:'long'};
 const chars=[...s],unique=new Set(chars.map(c=>c.toLowerCase())).size;
 const classes=[/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9]/].filter(r=>r.test(s)).length;
 const score=(chars.length>=16)+(chars.length>=20)+(classes>=3)+(unique>=10);
 if(unique<6||COMMON.test(s.toLowerCase())||score<=1)return {level:1,key:'weak'};
 return score===2?{level:2,key:'good'}:{level:3,key:'strong'};
}
/** Country select entries [code,name] for the interface language: Poland first, then by name (localeCompare). */
export function countryOptions(lang=getLanguage()){
 const i=lang==='en'?2:1,loc=lang==='en'?'en-GB':'pl-PL',pl=COUNTRIES.find(c=>c[0]==='PL');
 return [[pl[0],pl[i]],...COUNTRIES.filter(c=>c[0]!=='PL').map(c=>[c[0],c[i]]).sort((a,b)=>a[1].localeCompare(b[1],loc))];
}
/** Editable profile fields from a profile (or empty ones for the sign-up): "show my full name" is unticked unless chosen (§7.1). */
export function newFields(profile=null,languages=[]){
 return {first:profile?.firstName||'',last:profile?.lastName||'',username:profile?.username||'',own:profile?.username||null,
  country:profile?.country||defaultCountry(languages),sports:Array.isArray(profile?.sports)?[...profile.sports]:[],club:profile?.clubText||'',
  showClub:!!profile?.showClub,full:profile?.nameDisplay==='full',touched:!!profile?.username,status:null};
}
/** Body of signup/profile (plan §4.3): the names travel only in this POST body; nameDisplay 'initial' unless the box was ticked. */
export function profileBody(f){
 const club=cleanText(f.club||'');
 return {firstName:String(f.first||'').trim(),lastName:String(f.last||'').trim(),username:normalizeUsername(f.username)||'',country:f.country||null,
  sports:[...f.sports],clubText:club||null,showClub:!!f.showClub,nameDisplay:f.full?'full':'initial'};
}
/** The first problem of the fields as an Error with the server's message key (translated when shown), or null. */
export function fieldsError(f){
 if(!validateName(f.first))return new Error('Sprawdź pole: imię.');
 if(!validateName(f.last))return new Error('Sprawdź pole: nazwisko.');
 const u=validateUsername(f.username);
 if(u==='invalid')return new Error('Sprawdź pole: nazwa użytkownika.');
 if(u==='reserved')return new Error('Tej nazwy nie można użyć.');
 if(!CODES.has(f.country||''))return new Error('Wybierz kraj z listy.');
 if(!f.sports.length)return new Error('Wybierz co najmniej jeden sport.');
 const club=cleanText(f.club||'');if(club===null||[...club].length>CLUB_MAX)return new Error('Sprawdź pole: klub lub szkoła.');
 return null;
}
/** The username filled in while the sign-up field is untouched (§7.7, privacy by default): the first name and the surname's initial
 * only (marta.k), never the full surname, whatever the full-name box says; the person may still type any valid name. */
export const prefillUsername=f=>suggestUsernames(f?.first,f?.last,'',{full:false})[0]||'';
/** Server suggestions for a taken name, as shown: without the full surname unless "show my full name" is ticked. */
export function shownSuggestions(list,f){
 const last=slugName(f?.last||''),hide=!f?.full&&last.length>1;
 return (Array.isArray(list)?list:[]).filter(x=>typeof x==='string'&&validateUsername(x)==='valid'&&!(hide&&x.includes(last))).slice(0,3);
}
/** Only an https address on exactly this origin (Checkout or the portal) may be opened (plan §6.2); otherwise null. */
export function stripeUrl(value,origin){
 try{const u=new URL(String(value));return u.protocol==='https:'&&u.origin===origin&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
/** Screen after billing-confirm/billing-sync: 'success' (full access), 'processing' (still incomplete) or 'failed'. */
export function confirmView(r){
 const a=r?.access||{},st=r?.status;
 if(FAILED.includes(st))return 'failed';
 if(a.full)return 'success';
 if(st==null||['incomplete','open','none','active','trialing','past_due'].includes(st)||a.state==='processing')return 'processing';
 return 'failed';
}
/**
 * Return from Stripe (05 §11.2): cancel -> 'cancel'; portal -> billing-sync -> 'portal'; success -> billing-confirm every 3 s (without
 * a session id billing-sync every 11 s: the server allows one per 10 s) for up to 30 s -> 'success' | 'still' | 'failed'. A 429 is
 * not a failure: the next call waits for data.retry when that still fits in the 30 s, otherwise the screen says 'still' (confirm
 * allows 30 per hour). The flow mark is set while this runs and removed at the end; the pending return is cleared, except after a
 * 401 ('expired': confirm replays after login) or an error without an answer ('error': retried by the button).
 * deps: request(route,options), wait(ms), now(), storage (sessionStorage), onState(view).
 */
export async function handleReturn(ret,{request,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,storage,onState=()=>{},every=CONFIRM_EVERY,syncEvery=SYNC_EVERY,limit=CONFIRM_LIMIT}={}){
 flowStart(storage);
 const done=(out,keep=false)=>{if(!keep)clearReturn(storage);flowEnd(storage);return out;};
 if(ret?.kind==='cancel')return done({view:'cancel'});
 if(ret?.kind==='portal'){
  try{await request('billing-sync',{method:'POST',body:{}});}catch(error){if(error?.status===401)return {view:'expired',error};}
  return done({view:'portal'});
 }
 const start=now();
 for(;;){
  let r;
  const step=ret?.sessionId?every:syncEvery;
  try{r=ret?.sessionId?await request('billing-confirm',{method:'POST',body:{sessionId:ret.sessionId}}):await request('billing-sync',{method:'POST',body:{}});}
  catch(error){
   if(error?.status===401)return {view:'expired',error};
   if(error?.status===429){const ms=(Number(error.data?.retry)||0)*1000;if(ms>0&&now()-start+ms<=limit){onState({view:'processing'});await wait(ms);continue;}return done({view:'still',until:null,state:null});}
   return error?.status===403?done({view:'failed',error}):done({view:'error',error},true);
  }
  const view=confirmView(r);
  if(view==='processing'&&now()-start+step<=limit){onState({view:'processing'});await wait(step);continue;}
  return done({view:view==='processing'?'still':view,until:r?.access?.until??null,state:r?.access?.state??null});
 }
}

// ---- State ----
const ui=()=>registry.use('ui');
const icon=(name,cls='')=>ui()?.icon?.(name,cls)??h``;
const languages=()=>{try{return navigator.languages?.length?[...navigator.languages]:[navigator.language];}catch{return [];}};
const message=error=>translateMessage(String(error?.message||error||''));
const workspace=()=>{try{return ui()?.getWorkspace?.()||null;}catch{return null;}};
const newSignup=()=>({step:1,email:'',password:'',website:'',invite:null,begin:null,beginError:'',f:newFields(null,languages()),avatar:null,error:''});
const S={signup:null,draft:null,draftFor:null,ret:null,payment:'',del:null};
S.signup=newSignup();
const sportLabel=slug=>SPORTS.find(s=>s[0]===slug)?.[1]||slug;
const initials=f=>((f?.first||'').trim()[0]||'')+((f?.last||'').trim()[0]||'');
const goChat=()=>{const role=getMe()?.user?.role||workspace()?.user?.role;ui()?.navigate?.(registry.allows(registry.page('chat'),role)?'chat':registry.defaultPage(role));};
const planStep=()=>!!publicConfig()?.billing;

// ---- Shared fields (sign-up step 2 and the profile tab) ----
function statusView(f){
 const st=f.status?.state||'idle',rule=T('3–24 znaki: małe litery, cyfry, kropka i podkreślnik; zacznij od litery.');
 if(st==='checking')return h`<span class="acct-st"><span class="acct-spin" aria-hidden="true"></span>${T('Sprawdzanie…')}</span>`;
 if(st==='available')return h`<span class="acct-st ok">${icon('check')}${T('Nazwa jest dostępna')}</span>`;
 if(st==='own')return h`<span class="acct-st ok">${icon('check')}${T('To Twoja obecna nazwa.')}</span>`;
 if(st==='taken')return h`<span class="acct-st bad">${icon('close')}${T('Ta nazwa jest zajęta.')}</span>${f.status.suggestions?.length?h`<span class="acct-suggest">${T('Propozycje:')} ${f.status.suggestions.map(n=>h`<button type="button" class="acct-chip small" data-acct-act="use-name" data-name="${n}">${n}</button>`)}</span>`:''}`;
 if(st==='reserved')return h`<span class="acct-st bad">${icon('close')}${T('Tej nazwy nie można użyć.')}</span>`;
 if(st==='invalid')return h`<span class="acct-st bad">${icon('close')}${rule}</span>`;
 if(st==='error')return h`<span class="acct-st bad">${f.status.message}</span>`;
 return h`<span class="acct-st">${rule}</span>`;
}
function sportsView(f){
 const sel=f.sports;
 return h`<legend>${T('Sporty')}</legend><p class="acct-hint">${T('Wybierz od 1 do 5. Pierwszy wybrany jest sportem głównym.')}</p><div class="acct-chips">${SPORTS.map(([slug,label])=>{const i=sel.indexOf(slug);return h`<button type="button" class="acct-chip${i===0?' main':''}" data-acct-act="sport" data-sport="${slug}" aria-pressed="${i>=0}"${i<0&&sel.length>=SPORTS_MAX?h` disabled`:''}>${icon(i===0?'trophy':i>0?'check':'plus')}<span>${T(label)}${i===0?h`<span class="sr-only"> (${T('Główny sport')})</span>`:''}</span></button>`;})}</div>${sel.length>1?h`<label class="field-label acct-main-sport">${T('Główny sport')}<select name="mainSport">${sel.map(s=>h`<option value="${s}"${s===sel[0]?h` selected`:''}>${T(sportLabel(s))}</option>`)}</select></label>`:''}`;
}
const countrySelect=value=>h`<option value=""${value?'':h` selected`}>${T('Wybierz kraj')}</option>${countryOptions().map(([code,name],i)=>h`${i===1?h`<option disabled>──────────</option>`:''}<option value="${code}"${code===value?h` selected`:''}>${name}</option>`)}`;
export function fieldsView(f,{id,signup}){
 const at=!signup&&getMe()?.profile?.usernameChangeAt,locked=!!at&&at*1000>Date.now();
 return h`<div class="acct-grid"><label class="field-label">${T('Imię')}<input name="firstName" autocomplete="given-name" maxlength="50" required value="${f.first}"></label><label class="field-label">${T('Nazwisko')}<input name="lastName" autocomplete="family-name" maxlength="50" required value="${f.last}"></label></div>
<div class="acct-field"><label class="field-label" for="${id}-username">${T('Nazwa użytkownika')}</label><div class="acct-at"><span aria-hidden="true">@</span><input id="${id}-username" name="username" maxlength="24" autocomplete="nickname" autocapitalize="none" spellcheck="false" required value="${f.username}" aria-describedby="${id}-username-status"${locked?h` readonly`:''}></div><div class="acct-status" id="${id}-username-status" aria-live="polite">${statusView(f)}</div>${signup?h`<p class="acct-hint">${T('Nazwę użytkownika widzą członkowie czatu.')}</p>`:h`<p class="acct-hint">${locked?T('Kolejna zmiana nazwy będzie możliwa {date}.',{date:formatDate(at)}):T('Nazwę użytkownika można zmienić raz na 30 dni.')}</p>`}</div>
<label class="field-label">${T('Kraj')}<select name="country" required>${countrySelect(f.country)}</select></label>
<fieldset class="acct-sports" data-acct-sports>${sportsView(f)}</fieldset>
<label class="field-label">${T('Klub lub szkoła (opcjonalnie)')}<input name="clubText" maxlength="100" autocomplete="organization" value="${f.club}"></label>
<label class="checkbox-label acct-check"><input type="checkbox" name="showClub"${f.showClub?h` checked`:''}>${T('Pokaż klub w profilu')}</label>
<label class="checkbox-label acct-check"><input type="checkbox" name="fullName"${f.full?h` checked`:''}>${T('Pokazuj członkom moje pełne nazwisko')}</label><p class="acct-hint acct-check-hint">${T('Bez zaznaczenia inni członkowie widzą imię i inicjał nazwiska, np. Marta K.')}</p>`;
}
function photoView(src,f,{remove}){
 return h`<div class="acct-photo"><span class="acct-avatar large">${src?h`<img src="${src}" alt="" width="96" height="96" decoding="async">`:initials(f)?h`<span>${initials(f)}</span>`:icon('user')}</span><div class="acct-photo-actions"><div class="acct-photo-btns"><label class="btn secondary acct-file">${icon('camera')}<span>${src?T('Zmień zdjęcie'):T('Dodaj zdjęcie')}</span><input type="file" class="sr-only" accept="image/jpeg,image/png,image/webp" data-acct-file></label>${remove&&src?h`<button type="button" class="btn secondary acct-photo-remove" data-acct-act="photo-remove">${T('Usuń zdjęcie')}</button>`:''}</div><p class="acct-hint">${T('Opcjonalnie. JPG, PNG lub WebP do 8 MB. Zdjęcie widzą tylko członkowie MatBravo.')}</p></div></div>`;
}
function passwordField({name,id,label,autocomplete,meter=false}){
 return h`<div class="acct-field"><label class="field-label" for="${id}">${label}</label><div class="acct-pw"><input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" required minlength="12" maxlength="72"${meter?h` data-acct-meter aria-describedby="${id}-hint"`:''}><button type="button" class="acct-pw-toggle" data-acct-act="pw-toggle" aria-controls="${id}" aria-pressed="false" aria-label="${T('Pokaż hasło')}" title="${T('Pokaż hasło')}">${icon('eye')}</button></div>${meter?h`<p class="acct-meter-line" id="${id}-hint" aria-live="polite"><span class="acct-meter" data-level="0" aria-hidden="true"><i></i><i></i><i></i></span><span class="acct-meter-text">${T('Minimum 12 znaków.')}</span></p>`:''}</div>`;
}
const meterText=st=>st.key==='long'?T('Hasło musi mieć 12–72 bajty (np. co najmniej 12 znaków łacińskich).'):st.key==='weak'?T('Hasło: słabe'):st.key==='good'?T('Hasło: dobre'):st.key==='strong'?T('Hasło: bardzo dobre'):T('Minimum 12 znaków.');
function paintMeter(input){
 const line=document.getElementById(input.id+'-hint');if(!line)return;const st=passwordStrength(input.value);
 line.querySelector('.acct-meter')?.setAttribute('data-level',String(st.level));const text=line.querySelector('.acct-meter-text');if(text)text.textContent=meterText(st);
}

// ---- Sign-up (public steps 1-2, signed-in step 3) ----
const LOGO=h`<picture><source media="(max-width:650px)" srcset="./brand/matbravo-mark-white.svg" width="84" height="62"><img class="brand-logo" src="./brand/matbravo-logo-white.svg" alt="MatBravo" width="525" height="74"></picture>`;
const langSwitch=()=>h`<div class="lang-switch" role="group" aria-label="Język / Language">${[['pl','PL','Polski'],['en','EN','English']].map(([code,label,name])=>h`<button type="button" class="lang-option" data-set-lang="${code}" lang="${code}" aria-pressed="${getLanguage()===code}" aria-label="${name}" title="${name}">${label}</button>`)}</div>`;
function stepsView(n,total){
 const names=[T('Konto'),T('Profil'),T('Plan')].slice(0,total);
 return h`<div class="acct-steps"><p class="acct-steps-label">${T('Krok {n} z {total}',{n,total})} · ${names[n-1]}</p><ol aria-hidden="true">${names.map((x,i)=>h`<li class="${i+1<n?'done':i+1===n?'current':''}"><span>${i+1<n?icon('check'):String(i+1)}</span>${x}</li>`)}</ol></div>`;
}
function stepOne(){
 const s=S.signup;
 if(!s.begin||s.begin==='pending')return h`<section class="acct-card"><p class="acct-loading" role="status">${T('Wczytywanie…')}</p></section>`;
 if(s.begin!=='ok')return h`<section class="acct-card"><h1 id="acct-step-title" tabindex="-1">${T('Załóż konto MatBravo')}</h1><div class="notice info-notice">${icon('info')}<p>${s.beginError}</p></div><div class="acct-actions">${s.begin==='error'?h`<button type="button" class="btn secondary" data-acct-act="signup-retry">${icon('refresh')} ${T('Spróbuj ponownie')}</button>`:''}<button type="button" class="btn primary" data-acct-act="to-login">${T('Wróć do logowania')}</button></div></section>`;
 return h`<form id="acct-signup-1" class="acct-card" novalidate><h1 id="acct-step-title" tabindex="-1">${T('Załóż konto MatBravo')}</h1><p class="acct-lead">${T('Konto członka społeczności: czaty, profil i podglądy turniejów. Konta klubów zakłada Administrator turnieju.')}</p>
<label class="field-label">${T('E-mail')}<input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" value="${s.email}"></label>
${passwordField({name:'password',id:'acct-signup-pw',label:T('Hasło'),autocomplete:'new-password',meter:true})}
<div class="acct-consents" data-acct-consents></div>
<div class="acct-hp" aria-hidden="true"><label>website<input name="website" tabindex="-1" autocomplete="off" value=""></label></div>
<div class="form-error" role="alert">${s.error}</div><div class="acct-actions"><button type="submit" class="btn primary">${T('Dalej')} ${icon('arrow')}</button></div></form>`;
}
function stepTwo(){
 const s=S.signup,photos=!!publicConfig()?.avatars;
 return h`<form id="acct-signup-2" class="acct-card" novalidate><h1 id="acct-step-title" tabindex="-1">${T('Twój profil')}</h1><p class="acct-lead">${T('Te dane widzą członkowie MatBravo. Adres e-mail pozostaje prywatny.')}</p>${photos?photoView(s.avatar?.preview||null,s.f,{remove:true}):''}${fieldsView(s.f,{id:'acct-s',signup:true})}
<div class="form-error" role="alert">${s.error}</div><div class="acct-actions"><button type="button" class="btn secondary" data-acct-act="signup-back">${icon('left')} ${T('Wstecz')}</button><button type="submit" class="btn primary">${T('Utwórz konto')} ${icon('arrow')}</button></div></form>`;
}
function publicView(){
 const s=S.signup;
 return h`<div class="guest-shell acct-public" data-acct-public="signup"><header class="guest-bar"><div class="guest-bar-inner"><button type="button" class="brand guest-brand" data-acct-act="to-login" aria-label="${T('MatBravo — wróć do logowania')}">${LOGO}</button><div class="guest-bar-actions">${langSwitch()}<button type="button" class="btn guest-login" data-acct-act="to-login">${icon('lock')}<span><span class="acct-wide">${T('Masz konto?')} </span>${T('Zaloguj się')}</span></button></div></div></header><main id="main" class="acct-main"><div class="acct-column">${s.begin==='ok'?stepsView(s.step,planStep()?3:2):''}${s.step===2&&s.begin==='ok'?stepTwo():stepOne()}</div></main></div>`;
}
function renderPublic(focusTitle=false){
 const app=document.querySelector('#app');if(!app)return;
 const lang=document.activeElement?.closest?.('.lang-switch')?document.activeElement.dataset.setLang:null;
 setHtml(app,publicView());document.title='MatBravo — '+T('Załóż konto');
 for(const [form,name] of [['acct-signup-1','password']]){const el=document.getElementById(form)?.elements?.[name];if(el){el.value=S.signup.password;if(el.value)paintMeter(el);}}
 if(lang)document.querySelector(`.lang-switch [data-set-lang="${lang}"]`)?.focus();
 else if(focusTitle)document.getElementById('acct-step-title')?.focus();
}
const onSignup=()=>!!document.querySelector('[data-acct-public]')&&!workspace();
async function begin(){
 const s=S.signup;s.begin='pending';s.beginError='';
 // An answer for a sign-up that was left meanwhile (Back, logo, another page) must not set the flow mark again (§9.4).
 const current=()=>s===S.signup&&onSignup();
 try{await Client.request('signup-begin',{method:'POST',body:s.invite?{invite:s.invite}:{}});s.begin='ok';if(current())flowStart();}
 catch(error){s.begin=Client.isDemo?'demo':error?.status===404?'off':'error';s.beginError=message(error);if(current())flowEnd();}
 if(current())renderPublic(true);
}
/** Public #signup (steps 1-2). An invite token from the address is kept in memory and removed from the address bar. */
export async function mountPublic(app,params){
 wire();const s=S.signup,invite=params?.get?.('invite');
 if(invite&&invite!==s.invite){s.invite=invite.slice(0,256);s.begin=null;}
 if(invite)try{history.replaceState(null,'',location.pathname+location.search+'#signup');}catch{}
 s.step=params?.get?.('step')==='2'&&s.email&&s.password?2:1;
 await registry.use('account')?.ready;
 if(!document.querySelector('[data-acct-public]'))return;
 if(!s.begin)begin();
 renderPublic(s.begin==='ok');
}
/** Re-renders the visible account view from the module state (language switch, state changes). */
export function repaint(){
 if(onSignup()){renderPublic();return;}
 const el=document.querySelector('[data-acct-page]');if(el)render(el.dataset.acctPage,el);
}
function submitStepOne(form){
 const s=S.signup,el=form.elements;s.email=el.email.value.trim();s.password=el.password.value;s.website=el.website?.value||'';
 if(!EMAIL.test(s.email)||s.email.length>254)throw new Error('Podaj poprawny adres e-mail.');
 Client.validatePassword(s.password);
 s.step=2;s.error='';flowStart();history.replaceState(null,'',location.pathname+location.search+'#signup?step=2');renderPublic(true);
}
async function submitSignup(form){
 const s=S.signup,f=s.f;readForm(form,f);const problem=fieldsError(f);if(problem)throw problem;
 try{await Client.request('signup',{method:'POST',body:{email:s.email,password:s.password,...profileBody(f),website:s.website||'',invite:s.invite||null}});}
 catch(error){if(error?.status===400){s.begin=null;begin();}throw error;}
 flowStart();try{localStorage.setItem(KNOWN_DEVICE,'1');}catch{}
 if(s.avatar?.blob){try{await Client.request('avatar-upload',{method:'POST',body:s.avatar.blob,contentType:s.avatar.type});}catch{try{sessionStorage.setItem(NOTICE_KEY,'avatar-failed');}catch{}}}
 S.signup=newSignup();
 // The new session needs the member workspace: reload into step 3 (the flow mark survives in sessionStorage).
 history.replaceState(null,'',location.pathname+location.search+'#signup?step=3');location.reload();
}
function leaveSignup(){
 flowEnd();S.signup=newSignup();
 history.replaceState(null,'',location.pathname+location.search);ui()?.render?.();
 document.querySelector('#login-form input[name="email"]')?.focus();
}

// ---- Plan, Stripe return, subscription ----
function planView(m,{signup=false}={}){
 const b=m.billing||{},a=m.access||{},cur=b.currency,amount=cur?b.amounts?.[cur]:null,back=signup?h`<button type="button" class="acct-link acct-later" data-acct-act="later">${T('Później · wróć do czatu')}</button>`:'';
 if(!b.enabled)return h`<section class="acct-plan panel"><p class="acct-lead">${T('Płatności są wyłączone.')} ${T('Masz pełny dostęp do społeczności MatBravo.')}</p>${back}</section>`;
 if(a.full&&['active','ending','past_due'].includes(a.state))return h`<section class="acct-plan panel"><h2>${T('Masz już aktywną subskrypcję.')}</h2><p class="acct-lead">${subscriptionState(m).text}</p><div class="form-error" role="alert"></div><div class="acct-actions"><button type="button" class="btn primary" data-acct-act="portal">${icon('external')} ${T('Zarządzaj subskrypcją')}</button></div><p class="acct-fine">${T('Otworzy się bezpieczna strona Stripe.')}</p>${back}</section>`;
 if(a.full&&(a.state!=='free'||!a.until)&&a.state!=='grace')return h`<section class="acct-plan panel"><h2>${T('Masz pełny dostęp.')}</h2><p class="acct-lead">${subscriptionState(m).text}</p>${back}</section>`;
 if(!cur||!amount)return h`<section class="acct-plan panel"><h2>${T('Wybierz kraj w profilu, aby wybrać plan.')}</h2><p class="acct-lead">${T('Cena i waluta zależą od kraju: Polska płaci w złotych, inne kraje w dolarach.')}</p><div class="acct-actions"><button type="button" class="btn primary" data-acct-act="go-profile">${T('Uzupełnij profil')}</button></div>${back}</section>`;
 return h`<section class="acct-plan panel" aria-labelledby="acct-plan-title"><div class="acct-plan-head"><div><span class="eyebrow">${T('PLAN MIESIĘCZNY')}</span><h2 id="acct-plan-title">${T('Konto MatBravo')}</h2></div><p class="acct-price"><b>${formatPrice(amount,cur)}</b><span>${T('miesięcznie')}</span></p></div>
<p class="acct-currency">${icon('globe')}<span>${T('Waluta')}: <strong>${cur==='pln'?T('PLN · Polska'):T('USD · inne kraje')}</strong>. ${T('Waluta wynika z kraju w profilu.')}</span></p>
<ul class="acct-benefits">${[T('Pisanie we wszystkich czatach'),T('Pełne profile uczestników'),T('Czaty turniejów')].map(x=>h`<li>${icon('check')}<span>${x}</span></li>`)}</ul>
<p class="acct-fine">${T('Odnawia się co miesiąc. Anulujesz w panelu Stripe jednym kliknięciem; dostęp zostaje do końca opłaconego okresu.')}</p>
${b.mode==='test'?h`<p class="acct-test">${T('Tryb testowy płatności: karty testowe Stripe, bez prawdziwych opłat.')}</p>`:''}
<div class="form-error" role="alert"></div><button type="button" class="btn primary acct-pay" data-acct-act="checkout">${T('Przejdź do płatności')} ${icon('arrow')}</button>
<p class="acct-fine acct-stripe">${icon('lock')}<span>${T('Płatność obsługuje Stripe. Nie zapisujemy danych karty.')}</span></p>${back}</section>`;
}
/** Text, badge tone and buttons of the subscription state (05 §11.3). */
export function subscriptionState(m){
 const a=m?.access||{},b=m?.billing||{},date=a.until?formatDate(a.until):'';
 switch(a.state){
  case 'staff':return {text:T('Konto zespołu MatBravo'),tone:'teal'};
  case 'free':return {text:a.until?T('Konto darmowe do {date}',{date}):T('Konto darmowe (przyznane przez Administratora)'),tone:'teal',activate:!!a.until};
  case 'open':return {text:T('Pełny dostęp bez opłat.'),tone:'teal'};
  case 'grace':return {text:T('Karencja do {date}.',{date}),tone:'warning',activate:true};
  case 'active':return {text:T('Aktywna do {date}',{date}),tone:'success',manage:true};
  case 'ending':return {text:T('Kończy się {date}',{date}),tone:'warning',manage:true};
  case 'past_due':return {text:T('Problem z płatnością — zaktualizuj kartę'),tone:'warning',manage:true};
  case 'processing':return {text:T('Płatność w toku'),tone:'neutral',manage:!!b.hasCustomer};
  default:return {text:T('Brak aktywnej subskrypcji'),tone:'neutral',activate:true,manage:!!b.hasCustomer};
 }
}
function subscriptionView(m){
 const b=m.billing||{};
 if(!b.enabled)return h`<div class="acct-sub"><h2>${T('Subskrypcja')}</h2><p class="acct-lead">${T('Płatności są wyłączone.')} ${T('Masz pełny dostęp do społeczności MatBravo.')}</p></div>`;
 const st=subscriptionState(m),cur=b.currency,amount=cur?b.amounts?.[cur]:null;
 return h`<div class="acct-sub"><div class="acct-sub-head"><div><span class="eyebrow">${T('SUBSKRYPCJA')}</span><h2>${T('Konto MatBravo')}</h2>${amount?h`<p>${T('{price} / miesiąc',{price:formatPrice(amount,cur)})}</p>`:''}</div><span class="badge ${st.tone} acct-sub-state">${st.text}</span></div>
${b.mode==='test'?h`<p class="acct-test">${T('Tryb testowy płatności: karty testowe Stripe, bez prawdziwych opłat.')}</p>`:''}<div class="form-error" role="alert"></div>
<div class="acct-actions">${st.activate?h`<button type="button" class="btn primary" data-acct-act="plan">${T('Aktywuj')}</button>`:''}${st.manage?h`<button type="button" class="btn secondary" data-acct-act="portal">${icon('external')} ${T('Zarządzaj subskrypcją')}</button>`:''}</div>${st.manage?h`<p class="acct-fine">${T('Otworzy się bezpieczna strona Stripe.')}</p>`:''}</div>`;
}
function returnView(r){
 const chat=(cls='primary')=>h`<button type="button" class="btn ${cls}" data-acct-act="to-chat">${T('Przejdź do czatu MatBravo')}</button>`;
 if(r.view==='processing')return h`<section class="acct-return panel" role="status"><span class="acct-spin big" aria-hidden="true"></span><h2>${T('Potwierdzamy płatność…')}</h2><p>${T('To zwykle trwa kilka sekund. Możesz zamknąć tę stronę — konto aktywuje się samo.')}</p></section>`;
 if(r.view==='success')return h`<section class="acct-return panel success" role="status">${ui()?.mascot?.('success','acct-return-mascot')??''}<h2 tabindex="-1">${T('Gotowe! Twoje konto jest aktywne.')}</h2>${r.until&&r.state==='active'?h`<p>${T('Następne odnowienie: {date}.',{date:formatDate(r.until)})}</p>`:''}<div class="acct-actions">${chat()}</div></section>`;
 if(r.view==='still')return h`<section class="acct-return panel" role="status">${icon('clock','acct-return-icon')}<h2 tabindex="-1">${T('Płatność jest jeszcze przetwarzana. Sprawdzimy ją ponownie przy następnym wejściu.')}</h2><div class="acct-actions"><button type="button" class="btn secondary" data-acct-act="refresh-status">${icon('refresh')} ${T('Odśwież status')}</button>${chat()}</div></section>`;
 if(r.view==='cancel')return h`<section class="acct-return panel" role="status">${icon('info','acct-return-icon')}<h2 tabindex="-1">${T('Płatność przerwana. Nic nie zostało pobrane.')}</h2><div class="acct-actions"><button type="button" class="btn primary" data-acct-act="retry-plan">${T('Spróbuj ponownie')}</button><button type="button" class="btn secondary" data-acct-act="to-chat">${T('Wróć do czatu')}</button></div></section>`;
 const retry=r.view==='error'?'refresh-status':'retry-plan';
 return h`<section class="acct-return panel failed" role="alert">${icon('alert','acct-return-icon')}<h2 tabindex="-1">${r.view==='error'?T('Nie udało się sprawdzić płatności.'):T('Płatność nie powiodła się. Spróbuj innej karty lub metody.')}</h2>${r.message?h`<p>${r.message}</p>`:''}<div class="acct-actions"><button type="button" class="btn primary" data-acct-act="${retry}">${T('Spróbuj ponownie')}</button>${chat('secondary')}</div></section>`;
}
async function startReturn(ret){
 S.ret={...ret,view:ret.kind==='cancel'?'cancel':'processing',running:true,message:''};repaint();
 const out=await handleReturn(ret,{request:(route,options)=>Client.request(route,options),onState:st=>{Object.assign(S.ret,st);repaint();}});
 S.ret.running=false;
 if(out.view==='expired'){S.ret=null;ui()?.handleError?.(out.error);return;}
 if(out.view==='portal'){
  S.ret=null;await loadMe({force:true});ui()?.toast?.(T('Zaktualizowano informacje o subskrypcji.'));
  if(registry.parseRoute(location.hash).page==='billing')ui()?.navigate?.('profile',{tab:'subscription'});return;
 }
 Object.assign(S.ret,{view:out.view,until:out.until,state:out.state,message:out.error&&out.error.status!==403?message(out.error):''});
 if(out.view==='success'||out.view==='still')await loadMe({force:true});
 repaint();document.querySelector('.acct-return h2')?.focus();
}
async function openStripe(button,route,origin){
 const box=button.closest('section,.acct-sub')?.querySelector('.form-error'),label=[...button.childNodes];
 button.disabled=true;if(box)box.textContent='';if(route==='billing-checkout')button.textContent=T('Otwieranie bezpiecznej płatności…');
 try{
  const r=await Client.request(route,{method:'POST',body:{lang:getLanguage()}}),url=stripeUrl(r?.url,origin);
  if(!url)throw new Error('Nie udało się otworzyć strony Stripe. Spróbuj ponownie później.');
  if(route==='billing-checkout')flowEnd();
  location.assign(url);
 }catch(error){
  button.disabled=false;button.replaceChildren(...label);
  if(error?.status===401||error?.status===402){ui()?.handleError?.(error);return;}
  if(box)box.textContent=message(error);else ui()?.toast?.(message(error));
  if(error?.data?.portal){await loadMe({force:true});repaint();}
 }
}

// ---- Profile page ----
function ensureDraft(m){if(!S.draft||S.draftFor!==m.user?.id){S.draft=newFields(m.profile,languages());S.draftFor=m.user?.id;}}
const tabOf=m=>{if(m.profile?.mustChangePassword)return 'security';const t=registry.parseRoute(location.hash).params.get('tab');return ['profile','subscription','security'].includes(t)?t:'profile';};
function profileTab(m){
 const f=S.draft,mode=m.features?.avatars;
 return h`<form id="acct-profile-form" class="acct-form" novalidate>${m.profile&&!m.profile.complete?h`<div class="notice info-notice">${icon('info')}<p>${T('Uzupełnij imię, nazwisko, nazwę użytkownika, kraj i sport, aby pisać na czacie.')}</p></div>`:''}${mode&&mode!=='off'?photoView(avatarSrc(m.profile,256),f,{remove:true}):''}${fieldsView(f,{id:'acct-p',signup:false})}<div class="form-error" role="alert"></div><div class="acct-actions"><button type="button" class="btn secondary" data-acct-act="profile-cancel">${T('Anuluj')}</button><button type="submit" class="btn primary">${T('Zapisz zmiany')}</button></div></form>`;
}
function securityView(m){
 const member=m.user?.role==='member',must=!!m.profile?.mustChangePassword,pwa=registry.use('pwa');
 const standalone=!!pwa?.standalone?.(),install=!standalone&&!!pwa?.canInstall?.();
 return h`${must?h`<div class="notice acct-must" role="alert">${icon('alert')}<p><strong>${T('Ustaw nowe hasło.')}</strong> ${T('Logujesz się hasłem tymczasowym. Do czasu zmiany pozostałe strony są niedostępne.')}</p></div>`:''}
<form id="acct-password-form" class="acct-form acct-block" novalidate><h2>${T('Zmień hasło')}</h2><label class="field-label">${must?T('Hasło tymczasowe'):T('Obecne hasło')}<input name="currentPassword" type="password" required autocomplete="current-password"></label>${passwordField({name:'password',id:'acct-new-pw',label:T('Nowe hasło'),autocomplete:'new-password',meter:true})}<p class="acct-hint">${T('Pozostałe sesje zostaną wylogowane.')}</p><div class="form-error" role="alert"></div><div class="acct-actions"><button type="submit" class="btn primary">${T('Zmień hasło')}</button></div></form>
${member&&!must?h`<form id="acct-email-form" class="acct-form acct-block" novalidate><h2>${T('Adres e-mail')}</h2><p class="acct-lead">${T('Obecny adres:')} <strong>${m.user?.email||''}</strong></p><label class="field-label">${T('Nowy adres e-mail')}<input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254"></label><label class="field-label">${T('Obecne hasło')}<input name="currentPassword" type="password" required autocomplete="current-password"></label><p class="acct-hint">${T('Po zmianie adresu inne urządzenia zostaną wylogowane.')}</p><div class="form-error" role="alert"></div><div class="acct-actions"><button type="submit" class="btn secondary">${T('Zapisz adres e-mail')}</button></div></form>`:''}
${standalone||install?h`<section class="acct-block acct-install"><h2>${T('Aplikacja MatBravo')}</h2>${standalone?h`<p class="acct-lead">${icon('check')} ${T('MatBravo działa na tym urządzeniu jako aplikacja.')}</p>`:h`<p class="acct-lead">${T('Drabinki i czat jednym stuknięciem, z ekranu głównego.')}</p><div class="acct-actions"><button type="button" class="btn secondary" data-acct-act="install">${icon('download')} ${T('Zainstaluj aplikację')}</button></div>`}</section>`:''}
${member&&!must?h`<section class="acct-block acct-danger"><h2>${T('Usuń konto')}</h2><p class="acct-lead">${T('Usunięcie jest nieodwracalne. Profil i zdjęcie znikną, a Twoje wiadomości zostaną zastąpione informacją o usunięciu. Trwająca subskrypcja zakończy się od razu.')}</p><div class="acct-actions"><button type="button" class="btn acct-danger-btn" data-acct-act="delete-open">${T('Usuń konto…')}</button></div></section>`:''}`;
}
function profileView(m){
 const tab=tabOf(m),p=m.profile||{},f=S.draft,must=!!p.mustChangePassword,src=avatarSrc(p,64),name=[p.firstName,p.lastName].filter(Boolean).join(' ');
 const tabs=[['profile',T('Profil')],['subscription',T('Subskrypcja')],['security',T('Bezpieczeństwo')]];
 return h`<div class="acct-wrap"><section class="acct-head panel"><span class="acct-avatar">${src?h`<img src="${src}" alt="" width="56" height="56" decoding="async">`:initials(f)?h`<span>${initials(f)}</span>`:icon('user')}</span><div class="acct-head-text"><strong>${name||m.user?.email||''}</strong>${p.username?h`<span>@${p.username}</span>`:h`<span>${T('Profil nie jest jeszcze uzupełniony.')}</span>`}<span class="acct-private">${icon('lock')}<span>${m.user?.email||''} · ${T('widoczny tylko dla Ciebie i Administratora')}</span></span></div></section>
<div class="acct-tabs" role="tablist" aria-label="${T('Moje konto')}">${tabs.map(([k,label])=>h`<button type="button" role="tab" class="acct-tab" id="acct-tab-${k}" data-acct-act="tab" data-tab="${k}" aria-selected="${tab===k}" aria-controls="acct-panel" tabindex="${tab===k?'0':'-1'}"${must&&k!=='security'?h` disabled`:''}>${label}</button>`)}</div>
<section class="acct-panel panel" role="tabpanel" id="acct-panel" aria-labelledby="acct-tab-${tab}">${tab==='subscription'?subscriptionView(m):tab==='security'?securityView(m):profileTab(m)}</section></div>`;
}
async function saveProfile(form){
 const f=S.draft;readForm(form,f);const problem=fieldsError(f);if(problem)throw problem;
 const body=profileBody(f);
 if(Client.isDemo)saveDemoProfile(body);else{await Client.request('profile',{method:'POST',body});await loadMe({force:true});}
 S.draft=null;ensureDraft(getMe());form.removeAttribute('data-dirty');repaint();ui()?.toast?.(T('Zapisano profil.'));
}
async function savePassword(form){
 const el=form.elements,current=el.currentPassword.value,password=el.password.value,m=getMe(),must=!!m?.profile?.mustChangePassword;
 Client.validatePassword(password);
 if(m?.user?.role==='member'){await Client.request('member-password',{method:'POST',body:{currentPassword:current,password}});await loadMe({force:true});}
 else{try{await ui().commit('account.password',{id:workspace().user.id,currentPassword:current,password});}catch(error){error.app=true;throw error;}}
 form.reset();form.removeAttribute('data-dirty');ui()?.toast?.(T('Hasło zostało zmienione. Pozostałe sesje zostały wylogowane.'));
 if(must)goChat();else repaint();
}
async function saveEmail(form){
 const el=form.elements,email=el.email.value.trim();
 if(!EMAIL.test(email)||email.length>254)throw new Error('Podaj poprawny adres e-mail.');
 await Client.request('member-email',{method:'POST',body:{currentPassword:el.currentPassword.value,email}});
 await loadMe({force:true});form.removeAttribute('data-dirty');repaint();ui()?.toast?.(T('Zapisano nowy adres e-mail. Inne urządzenia zostały wylogowane.'));
}
function openDelete(){
 S.del={password:'',confirmEnd:false};
 ui().modal(T('Usunąć konto?'),h`<form id="acct-delete-form" novalidate><p class="modal-lead">${T('Tej operacji nie można cofnąć. Wpisz hasło, aby potwierdzić.')}</p><label class="field-label acct-del-pw">${T('Hasło')}<input name="password" type="password" required autocomplete="current-password"></label><div class="notice acct-delete-end" hidden></div><div class="form-error" role="alert"></div></form>`,h`${ui().button(T('Anuluj'),'close-modal')}<button type="submit" class="btn acct-danger-btn" form="acct-delete-form">${T('Usuń konto')}</button>`);
}
async function deleteAccount(form){
 const d=S.del||(S.del={password:'',confirmEnd:false}),field=form.elements.password,password=field.value||d.password;
 if(!password)throw new Error('Nieprawidłowe obecne hasło.');
 try{await Client.request('account-delete',{method:'POST',body:d.confirmEnd?{password,endSubscription:true}:{password}});}
 catch(error){
  if(error?.status===409&&error.data?.confirmEnd){
   d.password=password;d.confirmEnd=true;const box=form.querySelector('.acct-delete-end');box.hidden=false;box.setAttribute('role','alert');
   setHtml(box,h`${icon('alert')}<p><strong>${message(error)}</strong> ${T('Potwierdź jeszcze raz, aby usunąć konto i zakończyć subskrypcję.')}</p>`);
   const submit=document.querySelector('#modal-root button[form="acct-delete-form"]');if(submit)submit.textContent=T('Usuń konto i zakończ subskrypcję');
   field.closest('label').hidden=true;return;
  }
  throw error;
 }
 S.del=null;try{sessionStorage.setItem(NOTICE_KEY,'deleted');}catch{}
 registry.emit('logout');purgeSession();location.replace(location.pathname);
}

// ---- Rendering of the signed-in pages ----
function render(page,el){
 const m=getMe();
 if(!m){setHtml(el,h`<section class="panel empty-state">${ui()?.emptyMascot?.()??''}<h3>${T('Funkcje konta są chwilowo niedostępne.')}</h3><p>${T('Spróbuj ponownie później.')}</p></section>`);el.removeAttribute('aria-busy');return;}
 if(page==='profile'){ensureDraft(m);setHtml(el,profileView(m));}
 else if(page==='billing')setHtml(el,h`<div class="acct-wrap acct-narrow">${S.payment&&!S.ret?h`<div class="notice">${icon('alert')}<p>${S.payment}</p></div>`:''}${S.ret?.view?returnView(S.ret):planView(m)}</div>`);
 else if(page==='signup')setHtml(el,h`<div class="acct-wrap acct-narrow">${stepsView(3,3)}<div class="notice info-notice acct-created">${icon('check')}<p>${T('Konto utworzone. Możesz czytać czaty; pisanie włączy aktywacja konta.')}</p></div>${planView(m,{signup:true})}</div>`);
 el.removeAttribute('aria-busy');
}
/** Signed-in pages profile, billing and signup (step 3); el is the [data-acct-page] placeholder of the shell. */
export async function mount(page,el){
 wire();let m=getMe();
 if(!m){m=await loadMe();if(!el.isConnected)return;}
 if(page==='signup'){
  let notice=null;try{notice=sessionStorage.getItem(NOTICE_KEY);if(notice==='avatar-failed')sessionStorage.removeItem(NOTICE_KEY);}catch{}
  if(notice==='avatar-failed')ui()?.toast?.(T('Nie udało się wysłać zdjęcia. Spróbuj ponownie.'));
  if(m&&(!m.billing?.enabled||m.access?.full)){flowEnd();ui()?.toast?.(T('Konto utworzone.'));goChat();return;}
  flowStart();
 }
 if(page==='billing'){const p=takePaymentMessage();if(p)S.payment=p;const ret=readReturn();if(ret&&!S.ret?.running){startReturn(ret);return;}}
 render(page,el);
}

// ---- Events (installed once) ----
function readForm(form,f){
 const el=form.elements;
 if(el.firstName)f.first=el.firstName.value;if(el.lastName)f.last=el.lastName.value;if(el.username)f.username=el.username.value;
 if(el.country)f.country=el.country.value||null;if(el.clubText)f.club=el.clubText.value;if(el.showClub)f.showClub=el.showClub.checked;if(el.fullName)f.full=el.fullName.checked;
}
const modelFor=form=>form?.id==='acct-signup-2'?S.signup.f:form?.id==='acct-profile-form'?S.draft:null;
let checkTimer=0,checkAbort=null;
function setStatus(form,f,status){f.status=status;const el=form?.querySelector('.acct-status');if(el)setHtml(el,statusView(f));}
function scheduleCheck(f,form){
 clearTimeout(checkTimer);checkAbort?.abort();checkAbort=null;
 const u=normalizeUsername(f.username)||'',local=u?validateUsername(u):'idle';
 if(f.own&&u===f.own)return setStatus(form,f,{state:'own'});
 if(local!=='valid'||Client.isDemo)return setStatus(form,f,{state:local==='valid'?'idle':local});
 setStatus(form,f,{state:'checking'});
 checkTimer=setTimeout(async()=>{
  const abort=checkAbort=typeof AbortController==='function'?new AbortController():null;
  try{
   const r=await Client.request('username-check',{method:'POST',body:{u,firstName:String(f.first||''),lastName:String(f.last||'')},signal:abort?.signal});
   if(abort?.signal.aborted||normalizeUsername(f.username)!==u)return;
   const state=['available','taken','invalid','reserved'].includes(r?.status)?r.status:'idle';
   setStatus(document.getElementById(form.id),f,{state,suggestions:state==='taken'?shownSuggestions(r.suggestions,f):[]});
  }catch(error){if(abort?.signal.aborted)return;setStatus(document.getElementById(form.id),f,{state:'error',message:message(error)});}
 },CHECK_DELAY);
}
function paintSports(form,f,focus){
 const box=form.querySelector('[data-acct-sports]');if(!box)return;setHtml(box,sportsView(f));
 (focus?box.querySelector(focus):null)?.focus();
}
async function handleFile(input){
 const file=input.files?.[0],form=input.closest('form');input.value='';if(!file)return;
 const signup=form?.id==='acct-signup-2',box=form?.querySelector('.form-error');if(box)box.textContent='';
 try{
  await openCrop(file,{dataUrl:Client.isDemo&&!signup,onSave:async out=>{
   if(signup){S.signup.avatar=out;}
   else if(Client.isDemo){if(!out.dataUrl)throw new Error('Plik jest za duży.');saveDemoProfile({avatar:out.dataUrl});}
   else{await Client.request('avatar-upload',{method:'POST',body:out.blob,contentType:out.type});await loadMe({force:true});}
   // The dialog closes right after onSave: repaint then (the page keeps the typed fields from the module state).
   setTimeout(()=>{repaint();if(!signup)ui()?.toast?.(T('Zapisano zdjęcie.'));},0);
  }});
 }catch(error){if(box)box.textContent=message(error);else ui()?.toast?.(message(error));}
}
async function removePhoto(form){
 if(form?.id==='acct-signup-2'){S.signup.avatar=null;repaint();return;}
 if(Client.isDemo)saveDemoProfile({avatar:null});else{await Client.request('avatar-delete',{method:'POST',body:{}});await loadMe({force:true});}
 repaint();ui()?.toast?.(T('Usunięto zdjęcie.'));
}
function failed(error,form){
 if(error?.app||error?.status===401||error?.status===402){ui()?.handleError?.(error,form);return;}
 const box=form?.querySelector('.form-error'),text=message(error);if(box)box.textContent=text;else ui()?.toast?.(text);
}
async function onSubmit(event){
 const form=event.target;if(!form?.id?.startsWith('acct-'))return;event.preventDefault();
 const submit=event.submitter||form.querySelector('[type="submit"]')||document.querySelector(`[form="${form.id}"]`);if(submit?.disabled)return;
 const box=form.querySelector('.form-error');if(box)box.textContent='';if(submit)submit.disabled=true;if(form.id.startsWith('acct-signup-'))S.signup.error='';
 try{
  if(form.id==='acct-signup-1')submitStepOne(form);
  else if(form.id==='acct-signup-2')await submitSignup(form);
  else if(form.id==='acct-profile-form')await saveProfile(form);
  else if(form.id==='acct-password-form')await savePassword(form);
  else if(form.id==='acct-email-form')await saveEmail(form);
  else if(form.id==='acct-delete-form')await deleteAccount(form);
 }catch(error){
  if(form.id==='acct-signup-2'||form.id==='acct-signup-1')S.signup.error=message(error);
  failed(error,document.getElementById(form.id)||form);
 }finally{
  // A disabled button drops the focus to <body>; when the form stays (an error, the deletion's second step) it goes back to the button.
  if(submit?.isConnected){submit.disabled=false;const a=document.activeElement;if(!a||a===document.body)submit.focus();}
 }
}
function onInput(event){
 const t=event.target,form=t.closest?.('form');if(!form?.id?.startsWith('acct-'))return;
 if(t.dataset.acctMeter!==undefined)paintMeter(t);
 if(form.id==='acct-signup-1'){S.signup.email=form.elements.email.value;S.signup.password=form.elements.password.value;return;}
 const f=modelFor(form);if(!f)return;readForm(form,f);
 if(t.name==='username'){f.touched=true;scheduleCheck(f,form);}
 else if((t.name==='firstName'||t.name==='lastName')&&form.id==='acct-signup-2'&&!f.touched&&f.first.trim()&&f.last.trim()){
  const c=prefillUsername(f);if(c&&c!==f.username){f.username=c;form.elements.username.value=c;scheduleCheck(f,form);}
 }
}
function onChange(event){
 const t=event.target;if(t.matches?.('[data-acct-file]')){handleFile(t);return;}
 const form=t.closest?.('form'),f=modelFor(form);if(!f)return;
 if(t.name==='mainSport'){f.sports=[t.value,...f.sports.filter(s=>s!==t.value)];paintSports(form,f,'select[name="mainSport"]');return;}
 readForm(form,f);
}
async function onClick(event){
 const el=event.target.closest?.('[data-acct-act]');if(!el)return;
 const act=el.dataset.acctAct,form=el.closest('form');
 try{
  if(act==='to-login'){event.preventDefault();leaveSignup();}
  else if(act==='signup-back'){S.signup.step=1;S.signup.error='';history.replaceState(null,'',location.pathname+location.search+'#signup');renderPublic(true);}
  else if(act==='signup-retry'){S.signup.begin=null;begin();renderPublic();}
  else if(act==='sport'){const f=modelFor(form);if(!f)return;const slug=el.dataset.sport;f.sports=f.sports.includes(slug)?f.sports.filter(s=>s!==slug):f.sports.length<SPORTS_MAX?[...f.sports,slug]:f.sports;paintSports(form,f,`[data-sport="${slug}"]`);}
  else if(act==='use-name'){const f=modelFor(form);if(!f)return;f.username=el.dataset.name;f.touched=true;form.elements.username.value=f.username;scheduleCheck(f,form);form.elements.username.focus();}
  else if(act==='pw-toggle'){const input=document.getElementById(el.getAttribute('aria-controls'));if(!input)return;const show=input.type==='password';input.type=show?'text':'password';el.setAttribute('aria-pressed',String(show));const label=show?T('Ukryj hasło'):T('Pokaż hasło');el.setAttribute('aria-label',label);el.title=label;}
  else if(act==='tab'){if(el.disabled)return;history.replaceState(null,'',registry.routeHash('profile',{tab:el.dataset.tab}));repaint();document.getElementById('acct-tab-'+el.dataset.tab)?.focus();}
  else if(act==='checkout')await openStripe(el,'billing-checkout',CHECKOUT_ORIGIN);
  else if(act==='portal')await openStripe(el,'billing-portal',PORTAL_ORIGIN);
  else if(act==='later'){flowEnd();goChat();}
  else if(act==='to-chat'){S.ret=null;goChat();}
  else if(act==='retry-plan'){S.ret=null;repaint();}
  else if(act==='refresh-status'){const sessionId=S.ret?.sessionId||null;startReturn({kind:'success',sessionId});}
  else if(act==='go-profile')ui()?.navigate?.('profile');
  else if(act==='profile-cancel'){S.draft=null;repaint();}
  else if(act==='photo-remove'){el.disabled=true;await removePhoto(form);}
  else if(act==='install'){await registry.use('pwa')?.install?.();repaint();}
  else if(act==='delete-open')openDelete();
 }catch(error){if(el.isConnected)el.disabled=false;failed(error,form||el.closest('section'));}
}
function onKey(event){
 const tab=event.target.closest?.('.acct-tab');if(!tab||event.altKey||event.ctrlKey||event.metaKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 const tabs=[...tab.parentElement.querySelectorAll('.acct-tab:not([disabled])')],i=tabs.indexOf(tab);if(i<0)return;
 const next=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
 event.preventDefault();next.click();
}
let wired=false;
function wire(){
 if(wired||typeof document==='undefined')return;wired=true;
 document.addEventListener('submit',onSubmit);document.addEventListener('input',onInput);document.addEventListener('change',onChange);
 document.addEventListener('click',onClick);document.addEventListener('keydown',onKey);
 // A finished return screen stays while the plan page is re-rendered (language) and is dropped once another page is shown.
 registry.on('painted',({view,page}={})=>{
  if(view==='app'&&page!=='billing'){S.payment='';if(S.ret&&!S.ret.running)S.ret=null;}
  // Shared devices (plan §8.3 point 8): the typed e-mail, password and profile of a sign-up that was left (Back, logo, another hash)
  // are forgotten, and so is an unsaved profile draft once another page is shown (a language re-render keeps the same page).
  if(!(view==='public'&&page==='signup'))S.signup=newSignup();
  if(!(view==='app'&&page==='profile')){S.draft=null;S.draftFor=null;}
 });
 registry.on('logout',()=>{S.signup=newSignup();S.draft=null;S.draftFor=null;S.ret=null;S.del=null;S.payment='';});
 // Back/forward cache: a page left for another site keeps its DOM and no 'painted' follows its return, so the typed sign-up
 // and the passwords are dropped before it is stored, and a sign-up shown again starts over (§8.3 point 8).
 addEventListener('pagehide',forget);
 addEventListener('pageshow',event=>{if(event.persisted&&onSignup())ui()?.render?.();});
}
function forget(){
 S.signup=newSignup();if(S.del)S.del.password='';
 for(const el of document.querySelectorAll('[data-acct-public] input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[data-acct-public] textarea,[data-acct-page] input[type=password],#acct-delete-form input[type=password]'))el.value='';
}
