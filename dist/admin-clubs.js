/* Administrator's page "Kluby" (#clubs) and the tournament card tools ([data-tournament-admin] in app.js tournamentsPage),
 * PLAN-REJESTRACJA-ROLE §5.5, §10.5. Loaded lazily by settings-boot.js. Both work on the Administrator's workspace (every club with
 * verified, mergedInto and createdBy; every profile with pendingClubName; staff accounts) through ui.commit, so they work in the demo too:
 *  - #clubs: filters (unverified, all, merged) and a name search; profile count and creator type (staff or member); "Verify",
 *    "Rename" (club.save) and "Merge into" (club.merge, also into "Niezrzeszony"); pending club names with "Create club and assign"
 *    (club.adopt). Snapshots of entries keep the club of the entry day; public brackets show the current name.
 *  - tournament cards: "Hide" with a reason and the withdrawSelf option, "Restore" (tournament.hide), "Show organizer" (#members
 *    filtered by ownerOf) and "Confirm organizer" (admin-member organizer-trust) for a community tournament whose organizer does not count
 *    as confirmed: unconfirmed while confirmation is required, or blocked, or erased (the workspace cannot tell these apart; the answer's
 *    caps.organizerBlocked sends the Administrator to #members, an erased account answers 404).
 * Buttons carry data-clb-act and forms data-clb-form (not data-action), handled here. Every value reaches the DOM through h`…`.
 * The plain functions up to "Page" are pure and tested in tests/settings-ui.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,translateMessage} from './i18n.js';
import {clubKey} from './profile-data.js';
import {STAFF,UNAFFILIATED} from './workspace.js';

export const FILTERS=[['unverified',()=>T('Niezweryfikowane')],['all',()=>T('Wszystkie')],['merged',()=>T('Scalone')]];
export const REASON_MAX=200;

// ---- Clubs (pure) ----
const staffSet=ws=>new Set((ws?.users||[]).filter(u=>STAFF.includes(u.role)).map(u=>u.id));
/** Creator type of a club: 'staff' (an account of the staff), 'member' (a community account) or 'unknown' (seed data, imports). */
export function creatorType(club,staff){const by=club?.createdBy;if(typeof by!=='string'||!by)return 'unknown';return staff.has(by)?'staff':'member';}
/** The state of a club: 'merged' (mergedInto set), 'unverified' (verified false) or 'verified'. */
export const clubState=c=>c?.mergedInto!=null&&c.mergedInto!==''?'merged':c?.verified===false?'unverified':'verified';
/** Table rows for a filter and a search phrase: {club, state, profiles, creator, into}; "Niezrzeszony" never appears (it cannot change). */
export function clubRows(ws,{filter='unverified',q=''}={}){
 const clubs=Array.isArray(ws?.clubs)?ws.clubs:[],profiles=Array.isArray(ws?.profiles)?ws.profiles:[],staff=staffSet(ws),key=clubKey(String(q||''));
 const counts=new Map();for(const p of profiles)counts.set(p.clubId,(counts.get(p.clubId)||0)+1);
 const byId=new Map(clubs.map(c=>[c.id,c]));
 return clubs.filter(c=>c.id!==UNAFFILIATED).map(c=>({club:c,state:clubState(c),profiles:counts.get(c.id)||0,creator:creatorType(c,staff),into:c.mergedInto===UNAFFILIATED?T('Niezrzeszony'):byId.get(c.mergedInto)?.name||''}))
  .filter(r=>filter==='merged'?r.state==='merged':filter==='unverified'?r.state==='unverified':r.state!=='merged')
  .filter(r=>!key||clubKey(r.club.name).includes(key))
  .sort((a,b)=>String(a.club.name).localeCompare(String(b.club.name),'pl'));
}
/** Clubs a club can be merged into: verified or not, never merged, never itself; "Niezrzeszony" first. */
export function mergeTargets(ws,clubId){
 const clubs=(ws?.clubs||[]).filter(c=>c.id!==clubId&&clubState(c)!=='merged');
 return [...clubs.filter(c=>c.id===UNAFFILIATED),...clubs.filter(c=>c.id!==UNAFFILIATED).sort((a,b)=>String(a.name).localeCompare(String(b.name),'pl'))];
}
/** Pending club names (§6.3): profiles saved as "Niezrzeszony" with the name of a club that could not be created, grouped by the club key. */
export function pendingNames(ws){
 const groups=new Map();
 for(const p of ws?.profiles||[]){
  const name=typeof p.pendingClubName==='string'?p.pendingClubName.trim():'';if(!name)continue;
  const key=clubKey(name)||name;const g=groups.get(key)||{key,name,profileIds:[]};g.profileIds.push(p.id);groups.set(key,g);
 }
 return [...groups.values()].sort((a,b)=>b.profileIds.length-a.profileIds.length||a.name.localeCompare(b.name,'pl'));
}
/** The club.adopt payload of a pending name group. */
export const adoptBody=g=>({name:g.name,profileIds:[...g.profileIds]});

// ---- Tournament card tools (pure) ----
/** Actions of the Administrator for a tournament: restore (hidden), hide (community, not hidden), owner (community), trust (community
 * whose organizer does not count as confirmed, t.trusted false: unconfirmed while confirmation is required (§17), blocked or erased). */
export function toolsFor(t,user){
 if(user?.role!=='admin'||!t)return [];
 const out=[];if(t.hidden)out.push('restore');else if(t.community)out.push('hide');
 // A blocked organizer (sparse organizerBlocked:true from the server) cannot become trusted: no "trust" action then.
 if(t.community){out.push('owner');if(t.trusted===false&&typeof t.createdBy==='string'&&t.organizerBlocked!==true)out.push('trust');}
 return out;
}
/** tournament.hide payload: hidden with the cleaned reason (at most 200 characters) and withdrawSelf, or restored. */
export function hideBody(tournamentId,{hidden=true,reason='',withdrawSelf=false}={}){
 if(!hidden)return {ok:true,payload:{tournamentId,hidden:false}};
 const text=String(reason??'').replace(/\s+/g,' ').trim();
 if([...text].length>REASON_MAX)return {ok:false,error:T('Powód może mieć najwyżej 200 znaków.')};
 return {ok:true,payload:{tournamentId,hidden:true,reason:text,withdrawSelf:!!withdrawSelf}};
}
/** Self entries of a tournament (entries made by athletes themselves). */
export const selfEntries=t=>(t?.entries||[]).filter(e=>e?.self===true).length;
export const trustBody=userId=>({action:'organizer-trust',userId,trusted:true});
/** The message after organizer-trust: a blocked organizer stays without trust on the tournament (Domain::trustedOrganizer), so the
 * Administrator is told to give the role back in #members instead of a success that changes nothing on the card. */
export function trustOutcome(r){
 if(r?.caps?.organizerBlocked)return {ok:false,message:T('Potwierdzenie zapisane, ale rola organizatora tej osoby jest odebrana, więc turniej dalej jest niepotwierdzony. Przywróć rolę w panelu Członkowie.')};
 return {ok:true,message:T('Organizator potwierdzony.')};
}

// ---- Views (pure: SafeHtml) ----
const btn=(label,act,cls='secondary',attrs={})=>h`<button type="button" class="btn ${cls}" data-clb-act="${act}"${Object.entries(attrs).map(([k,v])=>v==null||v===false?'':v===true?h` ${k}`:h` ${k}="${v}"`)}>${label}</button>`;
const CREATOR={staff:()=>T('Personel'),member:()=>T('Członek'),unknown:()=>'—'};
const STATE={verified:()=>h`<span class="badge success">${T('Zweryfikowany')}</span>`,unverified:()=>h`<span class="badge warning">${T('Niezweryfikowany')}</span>`,merged:()=>h`<span class="badge neutral">${T('Scalony')}</span>`};
/** One club row. */
export function clubRow(r){
 const c=r.club,id=c.id;
 return h`<li class="clb-row" data-clb-id="${id}"><div class="clb-name"><strong>${c.name}</strong>${r.state==='merged'&&r.into?h`<span class="muted small">${T('Scalony z: {name}',{name:r.into})}</span>`:''}</div>
  <div class="clb-state">${STATE[r.state]()}</div>
  <div class="clb-meta small"><span>${T('Zawodnicy: {n}',{n:r.profiles})}</span><span>${T('Utworzył: {who}',{who:CREATOR[r.creator]()})}</span></div>
  <div class="clb-actions">${r.state==='merged'?'':h`${r.state==='unverified'?btn(T('Zweryfikuj'),'verify','small-btn',{'data-clb-id':id}):''}${btn(T('Zmień nazwę'),'rename','small-btn',{'data-clb-id':id})}${btn(T('Scal z…'),'merge','small-btn',{'data-clb-id':id})}`}</div></li>`;
}
/** The page: toolbar, the table of the filter and the pending names. */
export function pageView(ws,st){
 const rows=clubRows(ws,st),pending=pendingNames(ws);
 return h`<form class="clb-toolbar" data-clb-form="search" role="search">
   <div class="segmented clb-filters" role="group" aria-label="${T('Filtr klubów')}">${FILTERS.map(([key,label])=>h`<button type="button" class="${key===st.filter?'active':''}" data-clb-act="filter" data-clb-filter="${key}" aria-pressed="${key===st.filter}">${label()}</button>`)}</div>
   <label class="clb-search"><span class="sr-only">${T('Szukaj klubu')}</span><input type="search" name="q" maxlength="80" value="${st.q}" placeholder="${T('Nazwa klubu')}" autocomplete="off"></label>
   <button class="btn secondary" type="submit">${T('Szukaj')}</button></form>
  <p class="muted small clb-note">${T('Zgłoszenia zachowują dane z chwili zgłoszenia; publiczne drabinki pokazują bieżącą nazwę klubu.')}</p>
  ${rows.length?h`<p class="muted small" role="status">${T('Znaleziono: {n}',{n:rows.length})}</p><ul class="clb-list">${rows.map(clubRow)}</ul>`:h`<div class="panel clb-empty"><p><strong>${st.filter==='unverified'&&!st.q?T('Brak klubów do weryfikacji.'):T('Brak klubów spełniających kryteria.')}</strong></p></div>`}
  <section class="panel clb-pending" aria-labelledby="clb-h-pending"><h2 id="clb-h-pending">${T('Oczekujące nazwy klubów')}</h2>
   <p class="muted small">${T('Gdy dzienny limit nowych klubów był wyczerpany, zawodnik został zapisany jako „Niezrzeszony” z nazwą klubu do utworzenia.')}</p>
   ${pending.length?h`<ul class="clb-list">${pending.map(g=>h`<li class="clb-row clb-row-pending"><div class="clb-name"><strong>${g.name}</strong></div><div class="clb-meta small"><span>${T('Zawodnicy: {n}',{n:g.profileIds.length})}</span></div><div class="clb-actions">${btn(T('Utwórz klub i przypisz'),'adopt','small-btn',{'data-clb-key':g.key})}</div></li>`)}</ul>`:h`<p class="small">${T('Brak oczekujących nazw.')}</p>`}</section>`;
}
/** Card tools of one tournament (SafeHtml; empty for non-admins and tournaments without actions). */
export function toolsView(t,user){
 const acts=toolsFor(t,user);if(!acts.length)return h``;
 const id=t.id,labels={restore:T('Przywróć'),hide:T('Ukryj'),owner:T('Pokaż organizatora'),trust:T('Potwierdź organizatora')};
 return h`<span class="tadm">${t.hidden&&t.hideReason?h`<span class="tadm-reason small">${T('Powód ukrycia: {reason}',{reason:t.hideReason})}</span>`:''}${acts.map(a=>btn(labels[a],'t-'+a,'small-btn'+(a==='hide'?' danger-text':''),{'data-clb-id':id}))}</span>`;
}
export function hideView(t){
 const n=selfEntries(t);
 return h`<form id="clb-hide-form" data-clb-form="hide" data-clb-id="${t.id}"><p class="modal-lead">${T('Turniej: {name}',{name:t.name})}</p>
  <p class="small">${T('Turniej zniknie z list publicznych i zmieni status na roboczy. Organizator zobaczy powód i adres pomocy, nie zmieni statusu i straci podgląd zgłoszeń samych zawodników.')}</p>
  <label class="field-label">${T('Powód (widzi go organizator)')}<textarea name="reason" maxlength="200" rows="3"></textarea></label>
  <label class="checkbox-label"><input type="checkbox" name="withdrawSelf"${n?' checked':''}> ${T('Wycofaj też zgłoszenia samych zawodników ({n})',{n})}</label>
  <div class="form-error" role="alert"></div></form>`;
}

// ---- Page ----
export const io={request:(route,options)=>Client.request(route,options),demo:Client.isDemo,refreshMe:()=>import('./me.js').then(m=>m.loadMe({force:true})).catch(()=>{})};
const st={filter:'unverified',q:'',touched:false};
export const state=st;
registry.on('logout',()=>{st.filter='unverified';st.q='';st.touched=false;});
const ui=()=>registry.use('ui');
const ws=()=>ui()?.getWorkspace?.()||null;
const toast=message=>ui()?.toast?.(message);
const root=()=>document.querySelector('[data-clubs-root]');
const paint=()=>{const el=root();if(el)setHtml(el,pageView(ws(),st));};
/** Draws #clubs into [data-clubs-root] after 'painted'; the first visit without unverified clubs opens "all". */
export function mountClubsPage(el=root()){
 if(!el||el.dataset.clbMounted)return;el.dataset.clbMounted='1';
 if(!st.touched&&!clubRows(ws(),{filter:'unverified'}).length)st.filter='all';
 paint();applyFocus();
}
/** Fills every [data-tournament-admin] of the tournaments page. */
export function mountTournamentTools(){
 const w=ws();if(w?.user?.role!=='admin')return;
 for(const el of document.querySelectorAll('[data-tournament-admin]')){
  const t=w.tournaments.find(x=>x.id===el.dataset.tournamentAdmin);setHtml(el,toolsView(t,w.user));
 }
 applyFocus();
}
const openModal=(title,body,actions)=>ui().modal(title,body,actions);
const closeModal=()=>ui().closeModal();
const clubById=id=>ws()?.clubs?.find(c=>c.id===id)||null;
const tournamentById=id=>ws()?.tournaments?.find(t=>t.id===id)||null;
const submitOf=form=>document.querySelector('button[type=submit][form="'+form.id+'"]')||form.querySelector('button[type=submit]');
/** Runs a workspace command and re-renders (the page mounts again after 'painted'); errors go through ui.handleError (409 reloads). */
/** The control that should hold the keyboard focus after a command re-renders the page: the same action of the same club or
 * tournament (a dialog form stands for the button that opened it), else another action of that row or card, else the selected
 * filter. An action without a club or tournament id (adopt-go of a pending name: the row leaves the list) goes to the selected
 * filter. Without it the focus fell to <body> after every verify, merge, hide, restore or adopt. */
const FORM_ACT={rename:'rename',merge:'merge',hide:'t-hide'};
export function focusTarget(doc,{id,act}){
 const same=id?[...doc.querySelectorAll('[data-clb-act]')].filter(b=>b.dataset.clbId===id&&!b.disabled):[];
 return same.find(b=>b.dataset.clbAct===act)||same[0]||doc.querySelector('[data-clb-filter][aria-pressed="true"]')||null;
}
// The page and the card tools mount again after 'painted' through a dynamic import (settings-boot.js): the target waits for that
// mount (at most 3 s, so a later visit does not grab the focus).
let focusAfter=null;
const refocus=target=>{focusAfter=target?{...target,until:Date.now()+3000}:null;};
function applyFocus(){const t=focusAfter;if(!t||typeof document==='undefined')return;focusAfter=null;if(Date.now()>t.until)return;const el=focusTarget(document,t);if(el)el.focus();}
async function command(el,type,payload,done){
 const form=el?.matches?.('form'),button=form?submitOf(el):el;if(button)button.disabled=true;
 const target={id:el?.dataset?.clbId||null,act:form?FORM_ACT[el.dataset.clbForm]:el?.dataset?.clbAct};
 try{await ui().commit(type,payload);closeModal();ui().render();refocus(target);toast(done);}
 catch(error){await ui().handleError(error,el?.matches?.('form')?el:null);}
 finally{if(button?.isConnected)button.disabled=false;}
}
const ACTS={
 close:()=>closeModal(),
 filter:el=>{st.filter=el.dataset.clbFilter;st.touched=true;paint();root()?.querySelector(`[data-clb-filter="${CSS.escape(st.filter)}"]`)?.focus();},
 verify:el=>command(el,'club.save',{id:el.dataset.clbId,verified:true},T('Klub zweryfikowany.')),
 rename:el=>{const c=clubById(el.dataset.clbId);if(!c)return;
  openModal(T('Zmień nazwę klubu'),h`<form id="clb-rename-form" data-clb-form="rename" data-clb-id="${c.id}"><label class="field-label">${T('Nazwa klubu')}<input name="name" required maxlength="120" autocomplete="off" value="${c.name}"></label><p class="muted small">${T('Gdy taki klub już istnieje, użyj scalania.')}</p><div class="form-error" role="alert"></div></form>`,
   h`${btn(T('Anuluj'),'close')}<button class="btn primary" type="submit" form="clb-rename-form">${T('Zapisz nazwę')}</button>`);},
 merge:el=>{const c=clubById(el.dataset.clbId);if(!c)return;const targets=mergeTargets(ws(),c.id);
  openModal(T('Scal klub'),h`<form id="clb-merge-form" data-clb-form="merge" data-clb-id="${c.id}"><p class="modal-lead">${T('Klub: {name}',{name:c.name})}</p>
   <label class="field-label">${T('Scal z klubem')}<select name="into" required><option value="" selected disabled>${T('Wybierz klub')}</option>${targets.map(x=>h`<option value="${x.id}">${x.id===UNAFFILIATED?T('Niezrzeszony'):x.name}${clubState(x)==='unverified'?' · '+T('niezweryfikowany'):''}</option>`)}</select></label>
   <p class="small">${T('Zawodnicy i konta personelu tego klubu przejdą do wybranego klubu (konta personelu zostaną wylogowane). Tego nie można cofnąć.')}</p><div class="form-error" role="alert"></div></form>`,
   h`${btn(T('Anuluj'),'close')}<button class="btn primary" type="submit" form="clb-merge-form">${T('Scal')}</button>`);},
 adopt:el=>{const g=pendingNames(ws()).find(x=>x.key===el.dataset.clbKey);if(!g)return;
  openModal(T('Utwórz klub i przypisz'),h`<p class="modal-lead">${T('Klub: {name}',{name:g.name})}</p><p>${T('Powstanie zweryfikowany klub (albo zostanie użyty istniejący o tej nazwie), a zawodnicy z tą nazwą zostaną do niego przypisani: {n}.',{n:g.profileIds.length})}</p><div class="form-error" role="alert"></div>`,
   h`${btn(T('Anuluj'),'close')}${btn(T('Utwórz klub i przypisz'),'adopt-go','primary',{'data-clb-key':g.key})}`);},
 'adopt-go':el=>{const g=pendingNames(ws()).find(x=>x.key===el.dataset.clbKey);if(g)return command(el,'club.adopt',adoptBody(g),T('Klub utworzony, zawodnicy przypisani.'));},
 't-hide':el=>{const t=tournamentById(el.dataset.clbId);if(!t)return;
  openModal(T('Ukryj turniej'),hideView(t),h`${btn(T('Anuluj'),'close')}<button class="btn primary" type="submit" form="clb-hide-form">${T('Ukryj turniej')}</button>`);},
 't-restore':el=>command(el,'tournament.hide',{tournamentId:el.dataset.clbId,hidden:false},T('Turniej przywrócony.')),
 't-owner':el=>{if(io.demo){toast(T('Ta funkcja jest niedostępna w wersji demonstracyjnej.'));return;}ui().navigate('members',{ownerOf:el.dataset.clbId});},
 't-trust':async el=>{
  const t=tournamentById(el.dataset.clbId);if(!t)return;if(io.demo){toast(T('Ta funkcja jest niedostępna w wersji demonstracyjnej.'));return;}
  el.disabled=true;
  try{const r=trustOutcome(await io.request('admin-member',{method:'POST',body:trustBody(t.createdBy)}));toast(r.message);io.refreshMe();
   if(r.ok)document.querySelector('.topbar [data-action="refresh"]')?.click();else ui().navigate('members',{ownerOf:t.id});}
  catch(error){toast(translateMessage(error.message));}finally{if(el.isConnected)el.disabled=false;}
 }
};
const FORMS={
 search:form=>{st.q=String(new FormData(form).get('q')||'').trim();if(st.q&&st.filter==='unverified')st.filter='all';st.touched=true;paint();},
 rename:form=>{const name=String(new FormData(form).get('name')||'').trim();const c=clubById(form.dataset.clbId);if(!c)return;if(name===c.name){closeModal();return;}return command(form,'club.save',{id:c.id,name},T('Nazwa klubu zmieniona.'));},
 merge:form=>{const into=String(new FormData(form).get('into')||'');if(!into)return;return command(form,'club.merge',{id:form.dataset.clbId,into},T('Kluby scalone.'));},
 hide:form=>{const f=new FormData(form),r=hideBody(form.dataset.clbId,{reason:f.get('reason'),withdrawSelf:f.has('withdrawSelf')});
  if(!r.ok){const box=form.querySelector('.form-error');if(box)box.textContent=r.error;return;}
  return command(form,'tournament.hide',r.payload,T('Turniej ukryty.'));}
};
function onClick(event){
 const el=event.target.closest?.('[data-clb-act]');if(!el||el.disabled)return;
 const act=ACTS[el.dataset.clbAct];if(!act)return;
 event.preventDefault();Promise.resolve().then(()=>act(el)).catch(error=>toast(translateMessage(error.message)));
}
function onSubmit(event){
 const form=event.target.closest?.('form[data-clb-form]');if(!form)return;
 event.preventDefault();const handler=FORMS[form.dataset.clbForm];
 if(handler)Promise.resolve().then(()=>handler(form)).catch(error=>toast(translateMessage(error.message)));
}
if(typeof document!=='undefined'){document.addEventListener('click',onClick);document.addEventListener('submit',onSubmit);}
