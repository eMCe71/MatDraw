/* Administrator's page "Ustawienia" (#settings, PLAN-REJESTRACJA-ROLE §3.4–§3.6, §8.1–§8.2, §10.5, §17). Loaded lazily by settings-boot.js.
 * Sections: sign-up of new accounts (three modes, plus the payments of existing accounts while sign-up is off), Stripe (state and check),
 * the help address, accounts of the free period (groups A and B, bulk "require payment from"), organizers (publishing on or paused, the
 * switch "require confirmation of organizers" = organizers.trustRequired, the confirmation queue) and the history of changes.
 * Routes: GET admin-settings (with stripeCheck {ok, stale, checkedAt, mode}: contract (b), a stale or failed check pauses paid sign-up
 * and payment enforcement until a fresh check passes), POST admin-settings-save {version,…} (409 stale | stripe_not_ready | test_mode
 * (also any 409 with confirmTestMode:true, contract (c): the answer is resent with allowTestMode:true) | free_period_decision),
 * POST admin-stripe-check, POST admin-billing-action {action:'requireFrom',scope:'free-signup',date}. Decision and test-mode dialogs use
 * ui.modal; their buttons carry data-set-act (not data-action), handled here. Every API value reaches the DOM through h`…`.
 * The plain functions up to "Page" are pure and tested in tests/settings-ui.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,translateMessage} from './i18n.js';
import {warsawToday} from './guest-view.js';
import {ROLES} from './workspace.js';
import {validateRequireFrom,dayAdd,fmtYmd,fmtTime,secToYmd,BULK_MIN_DAYS} from './admin-members.js';

export const MODES=['off','free','paid'];
const MODE_TEXT={off:[()=>T('Wyłączona'),()=>T('Nowe konta zakłada tylko Administrator. Zalogowani członkowie korzystają z MatBravo jak dotąd.')],
 free:[()=>T('Otwarta, bezpłatna'),()=>T('Każdy może założyć konto bez płatności. Takie konta są oznaczone jako konta z okresu bezpłatnego.')],
 paid:[()=>T('Otwarta, płatna'),()=>T('Nowe konta wybierają plan i płacą w Stripe.')]};
export const modeName=mode=>(MODE_TEXT[mode]||MODE_TEXT.off)[0]();

// ---- Mode mapping (§3.1): off = signup off; free = signup on + payments free; paid = signup on + payments paid ----
/** The owner's mode of a view (or of the stored fields signup/payments). */
export const modeOf=v=>v?.signup==='on'?(v?.payments==='paid'?'paid':'free'):'off';
/** Fields for a chosen mode; with 'off' the payments of existing accounts follow the extra switch (paymentsOn). */
export function modeFields(mode,{paymentsOn=false}={}){
 if(mode==='free')return {signup:'on',payments:'free'};
 if(mode==='paid')return {signup:'on',payments:'paid'};
 return {signup:'off',payments:paymentsOn?'paid':'free'};
}
/** Only the fields that differ from the view (the server saves nothing for an unchanged form). */
export function changedFields(view,fields){const out={};for(const [k,v] of Object.entries(fields||{}))if(v!==undefined&&v!==view?.[k]&&!(k==='supportEmail'&&v===view?.support?.email))out[k]=v;return out;}
/** Whether payments can be switched on: Stripe configured in config.php ({ok:false,reason} otherwise; a stored 'paid' stays selectable). */
export function paidAvailable(view){
 if(view?.stripe?.enabled)return {ok:true,reason:''};
 return {ok:false,reason:T('Płatności nie są skonfigurowane w config.php. Najpierw skonfiguruj Stripe (DEPLOY-PL.md).')};
}
/** Whether the change stops requiring payments (paid -> free): subscriptions keep renewing, so the panel warns first (§3.4). */
export const stopsPayments=(view,fields)=>view?.payments==='paid'&&fields?.payments==='free';
/** Body of admin-settings-save: the loaded version, the changed fields and the answers of the dialogs (allowTestMode, freePeriod).
 * An allowed test mode is sent as allowTestMode (contract (c)) and as confirmTestMode, the field of servers before that contract. */
export function saveBody(view,fields,{allowTestMode=false,confirmTestMode=false,freePeriod=null}={}){
 const test=allowTestMode||confirmTestMode;
 return {version:Number.isInteger(view?.version)?view.version:0,...fields,...(test?{allowTestMode:true,confirmTestMode:true}:{}),...(freePeriod?{freePeriod}:{})};
}
/** The Stripe check state of a view (contract (b)): stale (the Stripe configuration changed since the last check) and paused (payments
 * are required by the settings, but paid sign-up and enforcement wait for a fresh passing check). A view without stripeCheck: neither.
 * Paused follows the server's own signal, effective.degraded 'stripe-check' (Settings::effective); without effective, a check that was
 * made (checkedAt) and failed or went stale. A check that never ran pauses nothing: the server enforces payments then (R1.2).
 * rearm (stripeCheck.rearm, R2.4): paused although the check passed (the Stripe mode changed, test <-> live, or nothing was confirmed
 * in the panel): more checks resume nothing, only a save of the sign-up mode does (the server's save gate, resumes() below). */
export function stripeState(v){
 const c=v?.stripeCheck;if(!c||typeof c!=='object')return {stale:false,paused:false,rearm:false};
 const stale=c.stale===true,e=v?.effective;
 const paused=e&&typeof e==='object'&&'degraded' in e?e.degraded==='stripe-check':v?.payments==='paid'&&c.checkedAt!=null&&(stale||c.ok!==true);
 return {stale,paused,rearm:paused&&c.rearm===true};
}
/** Whether a save of the sign-up mode without changes still goes to the server: payments are required but paused by the Stripe check,
 * and the server's save gate resumes them (Settings::save $resume: a fresh check, then the test-mode and free-period dialogs, R1.2). */
export const resumes=v=>v?.payments==='paid'&&v?.effective?.degraded==='stripe-check';
/** Extra of the sign-up mode save (FORMS.mode): {resume:true} when nothing changed and resumes(view), else nothing. */
export const modeExtra=(view,fields)=>!Object.keys(fields||{}).length&&resumes(view)?{resume:true}:{};
/** The decision about accounts of the free period (§3.4 point 5): keep, or require payment from a date at least 14 days ahead. */
export function decisionBody(choice,date,today=warsawToday()){
 if(choice==='keep')return {ok:true,freePeriod:{action:'keep'}};
 if(choice!=='requireFrom')return {ok:false,error:T('Wybierz, co zrobić z tymi kontami.')};
 const check=validateRequireFrom(date,{scope:'grandfathered',today});
 return check.ok?{ok:true,freePeriod:{action:'requireFrom',date:check.date}}:check;
}
/** What a refused save asks for next: {kind:'test_mode'|'decision'|'stale'|'stripe'|'error', counts?, message}. */
export function outcome(error){
 const code=error?.code||error?.data?.code,message=translateMessage(error?.message||T('Nie udało się wykonać operacji.'));
 if(error?.status===409&&(code==='test_mode'||error?.data?.confirmTestMode===true))return {kind:'test_mode',message};
 if(error?.status===409&&code==='free_period_decision'){const c=error.data?.counts||{};return {kind:'decision',counts:{a:Math.max(0,Number(c.a)||0),b:Math.max(0,Number(c.b)||0)},message};}
 if(error?.status===409&&code==='stale')return {kind:'stale',message};
 if(error?.status===409&&code==='stripe_not_ready')return {kind:'stripe',message};
 return {kind:'error',message};
}
/** What the page does after a refused save that opens no new dialog: 'stale' closes an open dialog and reloads (the question no longer
 * applies to the new version); 'stripe' and 'error' keep an open dialog with its question, so that its button can try again. */
export const refusalPlan=(kind,{dialog=false}={})=>kind==='stale'?{close:true,reload:true,keep:false}:{close:false,reload:false,keep:!!dialog};
/** Whether a saved change moves the pending-organizer count of me.features (the nav badge of #members, 0 while confirmation is off). */
export const touchesPending=fields=>!!fields&&(Object.hasOwn(fields,'trustRequired')||Object.hasOwn(fields,'organizers'));
/** Body of the bulk action "require payment from" for groups A and B (Billing::adminAction scope free-signup). */
export const bulkBody=date=>({action:'requireFrom',scope:'free-signup',date});

// ---- Texts of the view ----
// Labels Settings::names gives instead of a display name (workspace ROLES, a member without a profile, an erased account); the last two
// are written with escapes because interface modules keep Polish text inside T() only (tests/i18n.test.mjs).
const ROLE_LABELS=new Set([...Object.values(ROLES),'Cz\u0142onek','Konto usuni\u0119te']);
/** History actor: a display name as it is; role labels and "account deleted" translated; the codes system and self named. */
export function actorLabel(actor){
 if(actor==='system')return T('System');if(actor==='self')return T('Sam użytkownik');
 if(typeof actor!=='string'||!actor)return '—';return ROLE_LABELS.has(actor)?T(actor):actor;
}
const ACTIONS={'settings.save':()=>T('Zmiana ustawień'),'settings.support':()=>T('Zmiana adresu pomocy'),'settings.freePeriod':()=>T('Płatność kont z okresu bezpłatnego'),
 'organizer.trust':()=>T('Potwierdzenie organizatora'),'organizer.untrust':()=>T('Cofnięcie potwierdzenia organizatora'),'organizer.block':()=>T('Odebranie roli organizatora'),'organizer.unblock':()=>T('Przywrócenie roli organizatora'),
 'tournament.hide':()=>T('Ukrycie lub przywrócenie turnieju'),'profile.forget':()=>T('Usunięcie danych zawodnika'),'club.save':()=>T('Zmiana klubu'),'club.merge':()=>T('Scalenie klubów'),'club.adopt':()=>T('Klub z oczekującej nazwy')};
export const actionLabel=action=>ACTIONS[action]?.()||String(action??'');
const TOKENS={'signup=on':()=>T('rejestracja otwarta'),'signup=off':()=>T('rejestracja wyłączona'),'payments=paid':()=>T('płatności wymagane'),'payments=free':()=>T('płatności wyłączone'),
 'organizers=on':()=>T('publikowanie włączone'),'organizers=paused':()=>T('publikowanie wstrzymane'),'trustRequired=1':()=>T('potwierdzanie organizatorów włączone'),'trustRequired=0':()=>T('potwierdzanie organizatorów wyłączone'),
 keep:()=>T('bezpłatny dostęp zostaje'),test:()=>T('Stripe w trybie testowym'),'scope=free-signup':()=>''};
/** A readable note of a history entry (codes of the server become words; names and addresses stay as they are). */
export function noteText(action,note){
 const s=typeof note==='string'?note:'';if(!s)return '';
 if(action==='settings.save'||action==='settings.freePeriod')return s.split(/\s+/).map(token=>{
  if(TOKENS[token])return TOKENS[token]();
  let m=/^requireFrom:(\d{4}-\d\d-\d\d)$/.exec(token);if(m)return T('płatność od {date}',{date:fmtYmd(m[1])});
  m=/^([ab])=(\d+)$/.exec(token);if(m)return m[1]==='a'?T('grupa A: {n}',{n:Number(m[2])}):T('grupa B: {n}',{n:Number(m[2])});
  return token;
 }).filter(Boolean).join(' · ');
 let m=/^(hidden|restored) \S+ · ([\s\S]*)$/.exec(s);if(action==='tournament.hide'&&m)return m[1]==='hidden'?T('Ukryto: {name}',{name:m[2]}):T('Przywrócono: {name}',{name:m[2]});
 m=/^\S+ (deleted|anonymized)$/.exec(s);if(action==='profile.forget'&&m)return m[1]==='deleted'?T('Dane usunięte'):T('Dane zanonimizowane');
 if(action.startsWith?.('club.')){m=/^(?:\S+ → )?\S+ · ([\s\S]*?)(?: · profiles=(\d+))?$/.exec(s);if(m)return m[2]?T('{name} · zawodnicy: {n}',{name:m[1],n:Number(m[2])}):m[1];}
 return s;
}
const CHECK_ERRORS={unavailable:()=>T('Stripe nie odpowiada. Spróbuj ponownie za chwilę.'),auth:()=>T('Klucz Stripe jest nieprawidłowy albo nie ma uprawnień.'),
 price_missing:()=>T('W Stripe brakuje ceny planu. Sprawdź identyfikatory cen w config.php.'),error:()=>T('Stripe zwrócił błąd.')};
export const checkError=code=>code?(CHECK_ERRORS[code]||CHECK_ERRORS.error)():'';
const DEGRADED={'billing-missing':()=>T('Zapisany jest tryb płatny, ale w config.php nie ma już konfiguracji Stripe. Rejestracja jest zamknięta, a istniejące konta mają pełny dostęp. Przywróć konfigurację Stripe albo wybierz inny tryb.'),
 'force-off':()=>T('Rejestracja jest zamknięta awaryjnie przez signup_force_off w config.php. Panel znów zdecyduje po usunięciu tego klucza (SSH).')};
const LIMITS=[['organizerDay',()=>T('Nowe turnieje organizatora na dobę')],['organizerActive',()=>T('Opublikowane nadchodzące turnieje organizatora')],['communityDayGlobal',()=>T('Nowe turnieje niepotwierdzonych organizatorów na dobę (razem)')],
 ['organizerProfilesDay',()=>T('Zawodnicy dodani przez organizatora na dobę')],['clubsDayPerUser',()=>T('Nowe kluby na konto na dobę')],['clubsDayGlobal',()=>T('Nowe kluby na dobę (razem)')],
 ['minorSelfAge',()=>T('Wiek, od którego zawodnik zakłada profil sam')],['adultAge',()=>T('Pełnoletność przy samodzielnych zgłoszeniach')],['athletesPerAccount',()=>T('Profile zawodnika na konto')],['retentionMonths',()=>T('Przechowywanie danych społeczności (miesiące)')]];

// ---- Views (pure: SafeHtml) ----
const all=(...parts)=>h`${parts}`;
const btn=(label,act,cls='secondary',attrs={})=>h`<button type="button" class="btn ${cls}" data-set-act="${act}"${Object.entries(attrs).map(([k,v])=>v==null||v===false?'':v===true?h` ${k}`:h` ${k}="${v}"`)}>${label}</button>`;
const SOURCES={db:()=>T('ustawiony w panelu'),config:()=>T('z pliku config.php'),default:()=>T('domyślny')};

function signupSection(v){
 const mode=modeOf(v),paid=paidAvailable(v),off=mode==='off',payOn=v.payments==='paid',deg=v.effective?.degraded;
 const option=key=>{const [name,desc]=MODE_TEXT[key],disabled=key==='paid'&&!paid.ok&&mode!=='paid';
  return h`<label class="set-option${disabled?' is-disabled':''}"><input type="radio" name="mode" value="${key}"${key===mode?' checked':''}${disabled?' disabled':''}${disabled?h` aria-describedby="set-paid-why"`:''}><span><strong>${name()}</strong><small>${desc()}</small></span></label>`;};
 return h`<section class="panel set-section" aria-labelledby="set-h-signup"><h2 id="set-h-signup">${T('Rejestracja nowych kont')}</h2>
  ${deg&&DEGRADED[deg]?h`<div class="set-alert" role="alert">${DEGRADED[deg]()}</div>`:''}
  <form data-set-form="mode"><fieldset class="set-options"><legend class="sr-only">${T('Tryb rejestracji')}</legend>${MODES.map(option)}</fieldset>
   ${paid.ok?'':h`<p class="muted small" id="set-paid-why">${paid.reason}</p>`}
   <label class="set-switch" data-set-payments${off?'':' hidden'}><input type="checkbox" name="payments" value="paid"${payOn?' checked':''}${!paid.ok&&!payOn?' disabled':''}><span><strong>${T('Płatności istniejących kont')}</strong><small>${T('Włączone: konta bez darmowego planu muszą mieć subskrypcję, aby pisać na czacie i zgłaszać się do turniejów.')}</small></span></label>
   ${v.effective&&v.effective.mode!==mode?h`<p class="small set-effective">${T('Obowiązuje teraz: {mode}',{mode:modeName(v.effective.mode)})}</p>`:''}
   ${stripeState(v).paused?h`<p class="notice set-warn">${pausedNote(stripeState(v))}</p>`:''}
   <div class="form-error" role="alert"></div><button class="btn primary" type="submit">${T('Zapisz tryb rejestracji')}</button></form></section>`;
}
const PAUSED=()=>T('Płatna rejestracja i wymaganie płatności są wstrzymane, dopóki nowa kontrola Stripe nie przejdzie.');
/** The pause notice: after a passing check that resumed nothing (rearm) it names the save that does. */
const pausedNote=state=>state.rearm?T('Kontrola Stripe przeszła, ale płatności są dalej wstrzymane: zmienił się tryb Stripe (test ↔ live) albo tej konfiguracji nie potwierdzono jeszcze w panelu. Wznowi je zapis trybu rejestracji: kliknij „Zapisz tryb rejestracji”.'):PAUSED();
function stripeSection(v){
 const s=v.stripe||{},c=s.check,state=stripeState(v);
 const prices=c?.prices?['pln','usd'].map(k=>k.toUpperCase()+': '+(c.prices[k]?T('jest'):T('brak'))).join(' · '):'';
 return h`<section class="panel set-section" aria-labelledby="set-h-stripe"><h2 id="set-h-stripe">${T('Stripe')}</h2>
  <dl class="set-facts"><div><dt>${T('Konfiguracja')}</dt><dd>${s.enabled?T('Klucze Stripe są w config.php'):T('Brak (płatności wyłączone w config.php)')}</dd></div>
   <div><dt>${T('Tryb Stripe')}</dt><dd>${s.mode==='live'?h`<span class="badge success">${T('Produkcyjny (live)')}</span>`:h`<span class="badge warning">${T('Testowy (test)')}</span>`}</dd></div>
   <div><dt>${T('Ostatnia kontrola')}</dt><dd data-set-check>${c?h`${fmtTime(c.at)} · ${c.ok?h`<span class="badge success">${T('Działa')}</span>`:h`<span class="badge warning">${T('Problem')}</span> ${checkError(c.error)}`}${prices?h`<br><span class="muted small">${T('Ceny planu')}: ${prices}</span>`:''}`:T('jeszcze nie było')}</dd></div></dl>
  ${state.stale?h`<div class="set-alert" role="alert"><strong>${T('Konfiguracja Stripe zmieniła się od ostatniego sprawdzenia — sprawdź ponownie')}</strong>${state.paused?h` ${pausedNote(state)}`:''}</div>`:state.paused?h`<p class="notice set-warn">${pausedNote(state)}</p>`:''}
  <div class="set-row">${btn(T('Sprawdź Stripe'),'stripe-check','secondary',{disabled:!s.enabled})}<span class="muted small">${T('Najwyżej 6 kontroli na godzinę.')}</span></div></section>`;
}
function supportSection(v){
 const sup=v.support||{};
 return h`<section class="panel set-section" aria-labelledby="set-h-support"><h2 id="set-h-support">${T('Adres pomocy')}</h2>
  <form data-set-form="support" class="set-inline"><label class="field-label">${T('E-mail pomocy')}<input type="email" name="supportEmail" required maxlength="254" autocomplete="off" value="${sup.email||''}"></label>
   <button class="btn secondary" type="submit">${T('Zapisz adres')}</button><div class="form-error" role="alert"></div></form>
  <p class="muted small">${T('Ten adres widzi każdy w „Nie pamiętasz hasła?”. Upewnij się, że skrzynka istnieje i ją czytasz.')} ${SOURCES[sup.source]?h`<span>(${SOURCES[sup.source]()})</span>`:''}</p></section>`;
}
function freeSection(v){
 const f=v.freeSignups||{a:0,b:0,scheduled:{count:0,from:null}},today=warsawToday(),total=(f.a||0)+(f.b||0),sch=f.scheduled||{};
 return h`<section class="panel set-section" aria-labelledby="set-h-free"><h2 id="set-h-free">${T('Konta z okresu bezpłatnego')}</h2>
  <dl class="set-facts"><div><dt>${T('Grupa A')}</dt><dd><strong>${f.a||0}</strong> · ${T('konta założone, gdy rejestracja była bezpłatna; bezpłatny dostęp trwa')}</dd></div>
   <div><dt>${T('Grupa B')}</dt><dd><strong>${f.b||0}</strong> · ${T('konta, które po włączeniu płatności straciłyby dostęp od razu (bez darmowego planu i bez subskrypcji)')}</dd></div>
   <div><dt>${T('Z ustaloną datą płatności')}</dt><dd>${sch.count?T('{n} · najwcześniej {date}',{n:sch.count,date:fmtYmd(secToYmd(sch.from))}):'0'}</dd></div></dl>
  <form data-set-form="bulk" class="set-inline"><label class="field-label">${T('Płatność wymagana od')}<input type="date" name="date" required min="${dayAdd(today,BULK_MIN_DAYS)}" value="${dayAdd(today,30)}"${total?'':' disabled'}></label>
   <button class="btn secondary" type="submit"${total?'':' disabled'}>${T('Wymagaj płatności od…')}</button><div class="form-error" role="alert"></div></form>
  <p class="muted small">${T('Dotyczy grup A i B. Od 14 dni przed datą konta widzą baner, od daty mają 7 dni karencji, potem tylko podgląd.')}</p></section>`;
}
function organizersSection(v){
 const paused=v.organizers==='paused',trust=v.trustRequired===true,n=Math.max(0,Number(v.organizersPending)||0),limits=v.limits||{};
 return h`<section class="panel set-section" aria-labelledby="set-h-org"><h2 id="set-h-org">${T('Organizatorzy')}</h2>
  <form data-set-form="organizers"><fieldset class="set-options set-options-two"><legend class="set-legend">${T('Publikowanie turniejów przez nowych organizatorów')}</legend>
    <label class="set-option"><input type="radio" name="organizers" value="on"${paused?'':' checked'}><span><strong>${T('Włączone')}</strong><small>${T('Organizatorzy publikują turnieje w limitach poniżej.')}</small></span></label>
    <label class="set-option"><input type="radio" name="organizers" value="paused"${paused?' checked':''}><span><strong>${T('Wstrzymane')}</strong><small>${T('Niepotwierdzeni organizatorzy nie opublikują nowego turnieju. Już opublikowane turnieje działają dalej.')}</small></span></label></fieldset>
   <label class="set-switch"><input type="checkbox" name="trustRequired" value="1"${trust?' checked':''}><span><strong>${T('Wymagaj potwierdzenia organizatorów')}</strong>
    <small>${T('Włączone: turnieje niepotwierdzonych organizatorów są dostępne tylko pod własnym adresem (nie ma ich na stronie głównej ani w lobby czatu), a osoby niepełnoletnie nie zgłoszą się do nich same, dopóki nie potwierdzisz organizatora w panelu Członkowie.')}</small>
    <small>${T('Wyłączone (domyślnie): każdy organizator bez blokady działa jak potwierdzony.')}</small></span></label>
   ${paused&&!trust?h`<p class="notice set-warn">${T('Przy wyłączonym potwierdzaniu każdy organizator działa jak potwierdzony, więc wstrzymanie publikowania nikogo nie zatrzyma. Włącz też potwierdzanie organizatorów.')}</p>`:''}
   <div class="form-error" role="alert"></div><button class="btn primary" type="submit">${T('Zapisz ustawienia organizatorów')}</button></form>
  ${trust?h`<div class="set-row set-pending"><span>${T('Do potwierdzenia: {n}',{n})}</span>${btn(T('Pokaż w panelu Członkowie'),'pending','secondary small-btn')}</div>`:h`<p class="muted small">${T('Potwierdzanie jest wyłączone, więc kolejka „Do potwierdzenia” nie jest potrzebna.')}</p>`}
  <details class="set-limits"><summary>${T('Limity (tylko do odczytu)')}</summary><dl class="set-facts">${LIMITS.filter(([k])=>limits[k]!=null).map(([k,label])=>h`<div><dt>${label()}</dt><dd>${limits[k]}</dd></div>`)}</dl></details></section>`;
}
/** The history list (newest first). */
export function historyView(items){
 const list=Array.isArray(items)?items:[];
 if(!list.length)return h`<p class="muted small">${T('Brak zmian.')}</p>`;
 return h`<ol class="set-history">${list.map(e=>{const note=noteText(e.action,e.note);return h`<li><time>${fmtTime(e.at)}</time><span class="set-who">${actorLabel(e.actor)}</span><strong>${actionLabel(e.action)}</strong>${note?h`<span class="set-note">${note}</span>`:''}</li>`;})}</ol>`;
}
/** The whole panel for a loaded view. */
export function pageView(v){
 return h`${signupSection(v)}${stripeSection(v)}${supportSection(v)}${freeSection(v)}${organizersSection(v)}
  <section class="panel set-section" aria-labelledby="set-h-history"><h2 id="set-h-history">${T('Historia zmian')}</h2>
   ${v.updatedAt?h`<p class="muted small">${T('Ostatni zapis ustawień: {date}',{date:fmtTime(v.updatedAt)})}${v.updatedBy?h` · ${actorLabel(v.updatedBy)}`:''}</p>`:''}${historyView(v.history)}</section>`;
}
/** The decision dialog body (§3.4 point 5): both group counts with their meaning and the two answers. */
export function decisionView(counts,today=warsawToday()){
 return h`<form id="set-decision-form" data-set-form="decision"><p class="modal-lead">${T('Zdecyduj, co z kontami założonymi w okresie bezpłatnym.')}</p>
  <ul class="set-groups"><li><strong>${T('Grupa A: {n}',{n:counts.a})}</strong> · ${T('konta założone, gdy rejestracja była bezpłatna; bezpłatny dostęp trwa')}</li>
   <li><strong>${T('Grupa B: {n}',{n:counts.b})}</strong> · ${T('konta, które po włączeniu płatności straciłyby dostęp od razu (bez darmowego planu i bez subskrypcji)')}</li></ul>
  <fieldset class="set-options"><legend class="sr-only">${T('Decyzja')}</legend>
   <label class="set-option"><input type="radio" name="choice" value="keep" checked><span><strong>${T('Zostaw im bezpłatny dostęp')}</strong><small>${T('Grupa A bez zmian; grupa B dostaje bezpłatny dostęp bez daty końca. Możesz to zmienić później akcją zbiorczą.')}</small></span></label>
   <label class="set-option"><input type="radio" name="choice" value="requireFrom"><span><strong>${T('Wymagaj płatności od daty')}</strong><small>${T('Obie grupy płacą od wybranej daty (co najmniej 14 dni od dziś). Wcześniej zobaczą baner, potem mają 7 dni karencji.')}</small></span></label></fieldset>
  <label class="field-label">${T('Płatność wymagana od')}<input type="date" name="date" min="${dayAdd(today,BULK_MIN_DAYS)}" value="${dayAdd(today,30)}"></label>
  <div class="form-error" role="alert"></div></form>`;
}

// ---- Requests ----
/** Transport and demo switch behind one object so that tests can run the flow without a server. */
export const io={request:(route,options)=>Client.request(route,options),demo:Client.isDemo,refreshMe:()=>import('./me.js').then(m=>m.loadMe({force:true})).catch(()=>{})};
export const loadView=()=>io.request('admin-settings');
/** One save attempt: {ok:true,view} or {ok:false,...outcome(error)}; the caller opens the dialog the outcome asks for. */
export async function attempt(view,fields,extra={}){
 try{return {ok:true,view:await io.request('admin-settings-save',{method:'POST',body:saveBody(view,fields,extra)})};}
 catch(error){if(error?.status===401||error?.status===403)throw error;return {ok:false,...outcome(error)};}
}

// ---- Page ----
const st={view:null,error:'',seq:0};
export const state=st;
registry.on('logout',()=>{st.seq++;st.view=null;st.error='';});
const ui=()=>registry.use('ui');
const toast=message=>ui()?.toast?.(message);
const root=()=>document.querySelector('[data-settings-root]');
const say=(el,message)=>{const box=el?.closest?.('form')?.querySelector('.form-error')||document.querySelector('#modal-root .form-error');if(box)box.textContent=message||'';else if(message)toast(message);};
function paint(){
 const el=root();if(!el)return;
 if(st.error&&!st.view){setHtml(el,h`<div class="panel set-state"><p class="form-error" role="alert">${st.error}</p>${btn(T('Spróbuj ponownie'),'retry')}</div>`);return;}
 if(!st.view){setHtml(el,h`<p class="muted" role="status">${T('Wczytuję ustawienia…')}</p>`);return;}
 setHtml(el,pageView(st.view));
}
async function load(){
 const seq=++st.seq;st.error='';
 try{const view=await loadView();if(seq!==st.seq)return;st.view=view;}catch(error){if(seq!==st.seq)return;st.error=translateMessage(error.message);}
 paint();
}
/** Draws the panel into [data-settings-root] (after 'painted'); the demo has no server. */
export function mountSettingsPage(el=root()){
 if(!el||el.dataset.setMounted)return;el.dataset.setMounted='1';
 if(io.demo){setHtml(el,h`<section class="panel set-section"><h2>${T('Ustawienia działają z serwerem')}</h2><p class="muted">${T('Ta funkcja jest niedostępna w wersji demonstracyjnej.')}</p></section>`);return;}
 paint();load();
}

// ---- Save flow with the dialogs ----
const openModal=(title,body,actions,large=false)=>ui().modal(title,body,actions,large);
const closeModal=()=>ui().closeModal();
/** Pending save while a dialog asks a question: the fields and the answers given so far. */
let pending=null;
/** The pending save (tests only). */
export const pendingSave=()=>pending;
/** One save with its dialogs (exported for tests/settings-ui.test.mjs, which runs it against a stub document and io). */
export async function save(el,fields,extra={},done=T('Zapisano ustawienia.')){
 if(!st.view)return;
 // extra.resume: the unchanged sign-up mode save that resumes paused payments (resumes(); saveBody sends only the version then).
 if(!Object.keys(fields).length&&extra.resume!==true){say(el,T('Nic nie zmieniono.'));return;}
 // The panel's form the save started from (a dialog's button carries none: the pending save remembers it), for the focus afterwards.
 const origin=originOf(el)||pending?.origin||null;
 const r=await attempt(st.view,fields,extra);
 if(r.ok){pending=null;st.view=r.view;closeIfOpen();paint();refocus(origin);toast(done);if(touchesPending(fields))io.refreshMe();return;}
 pending={fields,extra,done,origin};
 if(r.kind==='test_mode'){openModal(T('Stripe w trybie testowym'),h`<p class="modal-lead">${T('Stripe działa w trybie testowym — każdy dostanie pełny dostęp kartą testową. Otworzyć mimo to?')}</p><p class="muted small">${T('W trybie testowym karty testowe przechodzą, a prawdziwe płatności nie. Przełącz Stripe na tryb live w config.php przed prawdziwym otwarciem płatności.')}</p><div class="form-error" role="alert"></div>`,
  all(btn(T('Anuluj'),'close'),btn(T('Otwórz mimo to'),'test-go','primary')));return;}
 if(r.kind==='decision'){openModal(T('Konta z okresu bezpłatnego'),decisionView(r.counts),all(btn(T('Anuluj'),'close'),h`<button class="btn primary" type="submit" form="set-decision-form">${T('Zapisz decyzję')}</button>`),true);return;}
 const plan=refusalPlan(r.kind,{dialog:dialogOpen()});pending=plan.keep?{fields,extra,done,origin}:null;
 if(plan.close)closeIfOpen();
 if(plan.reload){await load();toast(r.message);return;}
 say(el,r.message);
}
/** data-set-form of the panel form el belongs to (the dialog forms 'decision' and the modal buttons do not count). */
export const originOf=el=>{const f=el?.closest?.('form[data-set-form]');return f&&!f.closest('#modal-root')?f.dataset.setForm:null;};
/** After a save the whole panel is drawn again: the keyboard focus goes back to the submit button of the form it started from. */
function refocus(origin){if(!origin)return;const b=root()?.querySelector(`form[data-set-form="${origin}"] button[type="submit"]`);if(b&&typeof b.focus==='function')b.focus();}
const dialogOpen=()=>!!document.querySelector('#modal-root .modal');
const closeIfOpen=()=>{if(dialogOpen())closeModal();};
const busy=async(el,fn)=>{const b=el?.matches?.('form')?document.querySelector('button[type=submit][form="'+el.id+'"]')||el.querySelector('button[type=submit]'):el;if(b)b.disabled=true;try{await fn();}catch(error){say(el,translateMessage(error.message));}finally{if(b?.isConnected)b.disabled=false;}};
const ACTS={
 close:()=>{pending=null;closeModal();},
 retry:()=>load(),
 pending:()=>ui().navigate('members',{filter:'organizers-pending'}),
 'test-go':el=>busy(el,()=>pending&&save(el,pending.fields,{...pending.extra,allowTestMode:true},pending.done)),
 'stripe-check':el=>checkStripe(el),
 'bulk-go':el=>busy(el,async()=>{
  const r=await io.request('admin-billing-action',{method:'POST',body:bulkBody(el.dataset.setDate)});
  closeModal();toast(T('Zmieniono konta: {n}',{n:r?.count??0}));await load();
 })
};
/** The Stripe check button: admin-stripe-check, the result at once, then the server's view again. */
export const checkStripe=el=>busy(el,async()=>{
  let check=null;
  try{check=(await io.request('admin-stripe-check',{method:'POST',body:{}}))?.stripeCheck||null;}
  catch(error){
   check=error?.data?.stripeCheck||null;
   // A server error (503 stripe_unavailable) comes after the failed check was saved, so the server view changed (paused, degraded): load it again (R2.1).
   // A refusal that saved nothing (429, 409 without stripeCheck, 401/403) keeps the view.
   if(!check){toast(translateMessage(error.message));if(Number(error?.status)>=500)await load();return;}
  }
  // The result at once; then the server's view again, so stale, effective and degraded match what applies now (R1.2).
  if(st.view)st.view={...st.view,stripe:{...st.view.stripe,check}};
  paint();toast(check?.ok?T('Stripe działa.'):checkError(check?.error)||T('Stripe zwrócił błąd.'));
  await load();root()?.querySelector('[data-set-act="stripe-check"]')?.focus?.();
});
const FORMS={
 mode:(form)=>{
  const f=new FormData(form),fields=changedFields(st.view,modeFields(String(f.get('mode')||modeOf(st.view)),{paymentsOn:f.get('payments')==='paid'}));
  if(stopsPayments(st.view,fields)){pending={fields,extra:{},done:T('Zapisano ustawienia.'),origin:'mode'};openModal(T('Płatności przestaną być wymagane'),h`<p class="modal-lead">${T('Osoby z aktywną subskrypcją dalej płacą. Zatrzymaj subskrypcje w panelu Członkowie albo w Stripe, jeśli tak zdecydujesz.')}</p><div class="form-error" role="alert"></div>`,all(btn(T('Anuluj'),'close'),btn(T('Zapisz tryb rejestracji'),'confirm-go','primary')));return;}
  // Nothing changed while payments are paused by the Stripe check: the save still goes, the server's gate resumes them (R2.4).
  return busy(form,()=>save(form,fields,modeExtra(st.view,fields)));
 },
 support:(form)=>busy(form,()=>save(form,changedFields(st.view,{supportEmail:String(new FormData(form).get('supportEmail')||'').trim()}),{},T('Zapisano adres pomocy.'))),
 organizers:(form)=>{const f=new FormData(form);return busy(form,()=>save(form,changedFields(st.view,{organizers:f.get('organizers')==='paused'?'paused':'on',trustRequired:f.has('trustRequired')})));},
 decision:(form)=>{
  const f=new FormData(form),d=decisionBody(String(f.get('choice')||''),String(f.get('date')||''));
  if(!d.ok){say(form,d.error);return;}
  if(!pending)return closeModal();
  return busy(form,()=>save(form,pending.fields,{...pending.extra,freePeriod:d.freePeriod},pending.done));
 },
 bulk:(form)=>{
  const date=String(new FormData(form).get('date')||''),check=validateRequireFrom(date,{scope:'grandfathered'});if(!check.ok){say(form,check.error);return;}
  const f=st.view?.freeSignups||{};
  openModal(T('Wymagaj płatności od…'),h`<p class="modal-lead">${T('Płatność będzie wymagana od {date}.',{date:fmtYmd(date)})}</p><ul class="set-groups"><li>${T('Grupa A: {n}',{n:f.a||0})}</li><li>${T('Grupa B: {n}',{n:f.b||0})}</li></ul><p class="muted small">${T('Dotyczy grup A i B. Od 14 dni przed datą konta widzą baner, od daty mają 7 dni karencji, potem tylko podgląd.')}</p><div class="form-error" role="alert"></div>`,
   all(btn(T('Anuluj'),'close'),btn(T('Wymagaj płatności'),'bulk-go','primary',{'data-set-date':date})));
 }
};
ACTS['confirm-go']=el=>busy(el,()=>pending&&save(el,pending.fields,pending.extra,pending.done));
function onClick(event){
 const el=event.target.closest?.('[data-set-act]');if(!el||el.disabled)return;
 const act=ACTS[el.dataset.setAct];if(!act)return;
 event.preventDefault();Promise.resolve().then(()=>act(el)).catch(error=>toast(translateMessage(error.message)));
}
function onSubmit(event){
 const form=event.target.closest?.('form[data-set-form]');if(!form)return;
 event.preventDefault();const handler=FORMS[form.dataset.setForm];
 if(handler)Promise.resolve().then(()=>handler(form)).catch(error=>say(form,translateMessage(error.message)));
}
/** The payments switch of existing accounts is shown only for the mode "off". */
function onChange(event){
 const el=event.target;if(el?.name!=='mode'||!el.closest?.('form[data-set-form="mode"]'))return;
 const sw=el.form.querySelector('[data-set-payments]');if(sw)sw.hidden=el.value!=='off';
}
if(typeof document!=='undefined'){document.addEventListener('click',onClick);document.addEventListener('submit',onSubmit);document.addEventListener('change',onChange);}
