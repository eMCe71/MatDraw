/* MatBravo chat moderation panel (#moderation, Admin only; plan §5.6, §5.9, §5.10, research 05 §12.3). Loaded lazily by moderation-boot.js.
 * - Reported messages (admin-chat-reports, grouped by message): reasons and counts, author, context (2 messages before and after), actions
 *   delete / restore / dismiss / mute / unmute / channel status (admin-chat-action), plus the list of muted people, a history of settled
 *   reports and the chat settings (switch, pace preset, notice) with the hosting counter "answers in the last hour" (admin-chat-settings).
 * - Every value from the API (message, original_body, comments, e-mails, names, titles, the notice) reaches the page only through the escaping
 *   h`…` template: plain text, never a link (plan §5.9). Request bodies and views are plain functions, so that tests run them without a browser.
 * - Forms use the mod- prefix (plan §8.3 point 8): modal forms are handled by one document listener, the settings form by the same listener. */
import {registry,h,setHtml} from './registry.js';
import {t as T,locale,translateMessage} from './i18n.js';
import * as Client from './client.js';

export const REASONS=['spam','abuse','harassment','child_data','other'];
export const DURATIONS=['1h','24h','7d','perm'];
export const STATUSES=['open','readonly','closed'];
export const TABS=['reports','muted','history','settings'];
export const TEXT_MAX=300;
/** Orientation threshold of DEPLOY-PL.md: more than this many 429 answers in an hour suggest the "saver" pace preset (plan §5.10). */
export const HOSTING_429_HINT=50;
const DURATION_SECONDS={'1h':3600,'24h':86400,'7d':604800,perm:null};
const ui=()=>registry.use('ui');

// ---- Formatting ----
/** Date and time in the hall's time zone, in the interface language. */
export const fmtTime=ms=>{try{return new Date(ms).toLocaleString(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'});}catch{return '';}};
export const fmtSeconds=s=>fmtTime(Number(s)*1000);
export const fmtInterval=ms=>ms<60000?(ms/1000).toLocaleString(locale())+' s':(ms/60000).toLocaleString(locale())+' min';
export const reasonLabel=reason=>({spam:T('Spam lub reklama'),abuse:T('Obraźliwe lub nienawistne treści'),harassment:T('Nękanie'),child_data:T('Dane osobowe lub wizerunek dziecka'),other:T('Inne')})[reason]??String(reason);
export const durationLabel=d=>({'1h':T('1 godzina'),'24h':T('24 godziny'),'7d':T('7 dni'),perm:T('Na stałe')})[d]??String(d);
export const statusLabel=s=>({open:T('Otwarty do pisania'),readonly:T('Tylko do odczytu'),closed:T('Zamknięty dla gości')})[s]??String(s);
export const statusAbout=s=>({open:T('Wszyscy z dostępem mogą pisać.'),readonly:T('Wiadomości są widoczne, ale nikt nie może pisać.'),closed:T('Goście nie widzą tego czatu, zalogowani mogą go tylko czytać.')})[s]??'';
export const presetLabel=p=>({normal:T('Normalne'),saver:T('Oszczędne'),emergency:T('Awaryjne'),custom:T('Własne (ustawione w bazie)')})[p]??String(p);
export const presetSteps=ms=>(Array.isArray(ms)?ms:[]).map(fmtInterval).join(' · ');
/** Reason counts as [{reason,n}], most frequent first (ties in the order of REASONS). */
export const groupReasons=reasons=>Object.entries(reasons||{}).map(([reason,n])=>({reason,n:Number(n)||0})).filter(x=>x.n>0).sort((a,b)=>b.n-a.n||REASONS.indexOf(a.reason)-REASONS.indexOf(b.reason));
const LOBBY_NAMES={taekwondo:'Taekwondo','taekwondo-pl':'Taekwondo',karate:'Karate'};
/** Title of a channel from the report queue: a global channel by name and scope, a tournament by its title and date. */
export function channelTitle(channel){
 if(!channel)return '';
 if(channel.kind==='tournament')return [channel.title||T('Czat turnieju'),channel.date].filter(Boolean).join(' · ');
 const name=channel.slug==='general'?T('Ogólny'):LOBBY_NAMES[channel.slug]||String(channel.slug||'');
 const scope=channel.scope==='pl'?T('Polska'):channel.scope==='world'?T('Świat'):'';
 return scope?name+' · '+scope:name;
}
/** Hash of the chat that holds a message: #chat?c=<slug> or #chat?t=<tournament id>. */
export const chatHash=channel=>channel?.kind==='tournament'&&channel.tournamentId?'#chat?'+new URLSearchParams({t:channel.tournamentId}):channel?.slug?'#chat?'+new URLSearchParams({c:channel.slug}):'#chat';
export const roleLabel=role=>({admin:T('Administrator'),editor:T('Edytor'),club:T('Reprezentant klubu'),member:T('Członek')})[role]??String(role);
/** Name of a person for the Admin: full name, else user name, else e-mail; never an empty string. */
export const personName=p=>p?.name||(p?.username?'@'+p.username:'')||p?.email||T('Konto usunięte lub anonimowe');
/** What the muted person sees (research 05 §12.3): a preview for the mute dialog; now in epoch seconds. */
export function muteNotice(duration,now=Math.floor(Date.now()/1000)){
 const s=DURATION_SECONDS[duration];
 return s==null?T('Moderator wstrzymał Twoje pisanie bezterminowo.'):T('Moderator wstrzymał Twoje pisanie do {time}.',{time:fmtSeconds(now+s)});
}
/** Whether the 429 counter is above the orientation threshold. */
export const hostingHigh=health=>Number(health?.[429])>HOSTING_429_HINT;

// ---- Request bodies and URLs (validated like the server does) ----
const one=value=>{const text=String(value??'').trim();return text===''?null:text;};
const limited=(value,error)=>{const text=one(value);if(text!==null&&[...text].length>TEXT_MAX)throw error();return text;};
const noteText=value=>limited(value,()=>new Error('Notatka może mieć najwyżej 300 znaków.'));
const messageId=id=>{const n=Number(id);if(!Number.isInteger(n)||n<1)throw new Error('Niepoprawny formularz.');return n;};
/** Body of admin-chat-action for one action: delete, restore, dismiss, mute, unmute or channel. Optional texts are left out when empty. */
export function actionBody(action,input={}){
 const note=noteText(input.note);
 switch(action){
  case 'delete':case 'dismiss':return {action,messageId:messageId(input.messageId),...(note!==null?{note}:{})};
  case 'restore':return {action,messageId:messageId(input.messageId)};
  case 'mute':{
   if(!DURATIONS.includes(input.duration))throw new Error('Wybierz czas wyciszenia.');
   const reason=limited(input.reason,()=>new Error('Powód może mieć najwyżej 300 znaków.'));
   return {action,userId:String(input.userId||''),duration:input.duration,...(reason!==null?{reason}:{})};
  }
  case 'unmute':return {action,userId:String(input.userId||'')};
  case 'channel':{
   const channelId=Number(input.channelId);
   if(!Number.isInteger(channelId)||channelId<1)throw new Error('Niepoprawny formularz.');
   if(!STATUSES.includes(input.status))throw new Error('Niepoprawny status kanału.');
   return {action,channelId,status:input.status};
  }
 }
 throw new Error('Nieznana operacja moderacji.');
}
/** Body of admin-chat-settings-save: only what differs from the loaded settings, plus the loaded version (409 when somebody saved meanwhile). */
export function settingsBody(current,input){
 const out={version:current.version},notice=limited(input.notice,()=>new Error('Komunikat może mieć najwyżej 300 znaków.'));
 if(typeof input.on==='boolean'&&input.on!==current.on)out.on=input.on;
 if(input.preset&&input.preset!==current.preset&&input.preset!=='custom')out.preset=input.preset;
 if(notice!==(current.notice??null))out.notice=notice;
 return out;
}
export const changed=body=>Object.keys(body).some(k=>k!=='version');
export const listUrl=(kind,{page=1,status='actioned'}={})=>kind==='muted'?{route:'admin-chat-reports',view:'muted'}:kind==='settings'?{route:'admin-chat-settings'}
 :{route:'admin-chat-reports',status:kind==='history'?status:'open',page:String(page)};
export const contextUrl=id=>({route:'admin-chat-reports',context:String(messageId(id))});

// ---- Views (SafeHtml) ----
const stateBadge=state=>state==='hidden_review'?h`<span class="badge warning">${T('Ukryta do sprawdzenia')}</span>`:state==='deleted_mod'?h`<span class="badge neutral">${T('Usunięta przez moderatora')}</span>`:state==='deleted_author'?h`<span class="badge neutral">${T('Usunięta przez autora')}</span>`:'';
const isDeleted=state=>String(state).startsWith('deleted');
/** A message text for the Admin: the stored body, or the logged copy of a deleted message, or a note that nothing is left. Always plain text. */
const messageText=(m,deleted)=>{
 const text=deleted?m.original:m.body;
 return text?h`<blockquote class="mod-body" dir="auto">${text}</blockquote>`:h`<p class="mod-body mod-gone">${deleted?T('Treść nie jest już dostępna.'):''}</p>`;
};
const mutedBadge=muted=>muted?h`<span class="badge warning">${muted.until==null?T('Wyciszony bezterminowo'):T('Wyciszony do {time}',{time:fmtSeconds(muted.until)})}</span>`:'';
function authorLine(author,muted){
 const a=author||{};
 return h`<p class="mod-author"><strong dir="auto">${personName(a)}</strong>${a.username&&a.name?h` <span dir="auto">@${a.username}</span>`:''}${a.email?h` <span class="mod-email" dir="auto">${a.email}</span>`:''}${a.role?h` <span class="mod-role">${roleLabel(a.role)}</span>`:''} ${mutedBadge(muted)}</p>`;
}
const act=(kind,label,cls='')=>h`<button type="button" class="btn small-btn ${cls}" data-mod="${kind}">${label}</button>`;
function contextView(ctx,targetId){
 if(!ctx||ctx.status==='loading')return h`<p class="mod-note" role="status">${T('Wczytywanie kontekstu…')}</p>`;
 if(ctx.status==='error')return h`<p class="form-error" role="alert">${ctx.message}</p>`;
 return h`<ol class="mod-context" aria-label="${T('Kontekst rozmowy')}">${ctx.items.map(m=>h`<li class="${m.id===targetId?'mod-ctx-row is-target':'mod-ctx-row'}"><span class="mod-ctx-head"><strong dir="auto">${personName(m.author)}</strong> <time>${fmtTime(m.createdMs)}</time> ${stateBadge(m.state)}</span><span class="mod-ctx-text" dir="auto">${isDeleted(m.state)?(m.original||T('Treść nie jest już dostępna.')):m.body}</span></li>`)}</ol>`;
}
/** One queue item (a reported message with its reports); history items have no actions. */
export function reportItem(it,{open=false,ctx=null,history=false}={}){
 const m=it.message,rs=it.reports||{},deleted=isDeleted(m.state),muted=it.muted,author=it.author||{},admin=author.role==='admin';
 return h`<article class="mod-item" data-message="${m.id}" aria-labelledby="mod-item-${m.id}">
<header class="mod-item-head"><h3 id="mod-item-${m.id}" class="mod-channel" dir="auto">${channelTitle(m.channel)}</h3><time class="mod-when">${fmtTime(m.createdMs)}</time>${stateBadge(m.state)}</header>
<p class="mod-reasons"><span class="mod-count">${T('Liczba zgłoszeń: {n}',{n:rs.count??0})}</span>${groupReasons(rs.reasons).map(x=>h` <span class="mod-chip">${reasonLabel(x.reason)} ×${x.n}</span>`)}</p>
${authorLine(author,muted)}
${messageText(m,deleted)}${deleted&&m.original?h`<p class="mod-note">${T('Treść zapisana w dzienniku moderacji (widoczna tylko dla administratorów).')}</p>`:''}
<details class="mod-reports"><summary>${T('Powody i komentarze')}</summary><ul>${(rs.items||[]).map(r=>h`<li><span class="mod-reason">${reasonLabel(r.reason)}</span> <span class="mod-who" dir="auto">${r.reporter?.username?'@'+r.reporter.username:T('Zgłaszający bez nazwy użytkownika')}</span> <time>${fmtSeconds(r.createdAt)}</time>${history?h` <span class="badge neutral">${r.status==='dismissed'?T('Odrzucone'):r.status==='open'?T('Otwarte zgłoszenie'):T('Z podjętym działaniem')}</span>`:''}${r.comment?h`<q class="mod-comment" dir="auto">${r.comment}</q>`:''}</li>`)}</ul></details>
<div class="mod-actions">${act('ctx',open?T('Ukryj kontekst'):T('Pokaż kontekst'))}${history?'':h`${deleted?'':act('delete',T('Usuń wiadomość'),'danger-text')}${m.state==='hidden_review'?act('restore',T('Przywróć wiadomość')):''}${act('dismiss',T('Odrzuć zgłoszenie'))}${muted?act('unmute',T('Przywróć pisanie')):author.id&&!admin?act('mute',T('Wycisz autora…')):''}${act('channel',T('Status czatu…'))}`}<a class="btn small-btn" href="${chatHash(m.channel)}">${T('Otwórz w czacie')}</a></div>
${open?h`<div class="mod-ctx">${contextView(ctx,m.id)}</div>`:''}
</article>`;
}
function pager(data,kind){
 const pages=Math.max(1,Math.ceil((data.total||0)/20)),page=data.page||1;
 return pages>1?h`<nav class="mod-pager" aria-label="${T('Strony')}"><button type="button" class="btn small-btn" data-mod="page" data-dir="-1"${page<=1?' disabled':''}>${T('Poprzednia')}</button><span>${T('Strona {page} z {pages}',{page,pages})}</span><button type="button" class="btn small-btn" data-mod="page" data-dir="1"${page>=pages?' disabled':''}>${T('Następna')}</button></nav>`:'';
}
const empty=(text,extra='')=>h`<div class="mod-empty">${ui()?.emptyMascot?.()??''}<h3>${text}</h3>${extra}</div>`;
const historyEmpty=status=>status==='dismissed'?T('Brak odrzuconych zgłoszeń.'):status==='all'?T('Brak zgłoszeń w historii.'):T('Brak zgłoszeń z podjętym działaniem.');
export function queueView(data,state,history=false){
 const items=data?.items||[];
 const filter=history?h`<label class="mod-filter">${T('Pokaż')}<select data-mod-history-status>${[['actioned',T('Z podjętym działaniem')],['dismissed',T('Odrzucone')],['all',T('Wszystkie')]].map(([v,l])=>h`<option value="${v}"${state.historyStatus===v?' selected':''}>${l}</option>`)}</select></label>`:'';
 if(!items.length)return h`${filter}${empty(history?historyEmpty(state.historyStatus):T('Brak zgłoszeń. Społeczność jest w formie!'))}`;
 return h`${filter}<div class="mod-list">${items.map(it=>reportItem(it,{history,open:state.open.has(it.message.id),ctx:state.ctx[it.message.id]}))}</div>${pager(data)}`;
}
export function mutedView(data){
 const items=data?.items||[];
 if(!items.length)return empty(T('Nikt nie jest teraz wyciszony.'));
 return h`<ul class="mod-list mod-muted">${items.map(x=>h`<li class="mod-item" data-user="${x.user?.id}"><div><strong dir="auto">${personName(x.user)}</strong>${x.user?.email&&personName(x.user)!==x.user.email?h` <span class="mod-email" dir="auto">${x.user.email}</span>`:''} ${mutedBadge({until:x.until})}</div>
<p class="mod-note">${T('Wyciszył(a): {name}, {time}',{name:x.createdBy?.email||T('Konto usunięte lub anonimowe'),time:fmtSeconds(x.createdAt)})}</p>${x.reason?h`<p class="mod-reason-text"><span class="mod-note">${T('Powód:')}</span> <span dir="auto">${x.reason}</span></p>`:''}
<div class="mod-actions"><button type="button" class="btn small-btn" data-mod="unmute" data-user="${x.user?.id}">${T('Przywróć pisanie')}</button></div></li>`)}</ul>`;
}
const healthTile=(status,label,n,warn)=>h`<div class="${warn?'mod-tile is-warn':'mod-tile'}"><dt>${label}</dt><dd>${n??0}</dd></div>`;
export function settingsView(s,{saved=false,error=''}={}){
 const presets=Object.keys(s.presets||{}),health=s.health||{},high=hostingHigh(health),current=s.preset||'custom';
 return h`<form id="mod-settings-form" class="mod-settings" data-kind="settings" novalidate>
<fieldset class="mod-fieldset"><legend>${T('Czat')}</legend><label class="mod-check"><input type="checkbox" name="on"${s.on?' checked':''}> <span>${T('Czat włączony')}</span></label><p class="mod-note">${T('Po wyłączeniu czat zatrzymuje się u wszystkich, bez wdrożenia, do ponownego włączenia.')}</p></fieldset>
<fieldset class="mod-fieldset"><legend>${T('Tempo odświeżania czatu')}</legend>${current==='custom'?h`<label class="mod-radio"><input type="radio" name="preset" value="custom" checked><span><strong>${presetLabel('custom')}</strong><small>${presetSteps(s.ms)}</small></span></label>`:''}${presets.map(p=>h`<label class="mod-radio"><input type="radio" name="preset" value="${p}"${p===current?' checked':''}><span><strong>${presetLabel(p)}</strong><small>${presetSteps(s.presets[p])}</small></span></label>`)}</fieldset>
<div class="mod-fieldset"><label class="mod-field" for="mod-notice">${T('Komunikat dla użytkowników czatu')}</label><textarea id="mod-notice" name="notice" rows="3" maxlength="300" dir="auto" aria-describedby="mod-notice-hint">${s.notice||''}</textarea><p id="mod-notice-hint" class="mod-note">${T('Do 300 znaków. Pokazywany nad czatem jako zwykły tekst, bez tłumaczenia.')}</p></div>
<div class="form-error" role="alert">${error}</div>
<div class="mod-actions"><button class="btn primary" type="submit">${T('Zapisz ustawienia')}</button>${saved?h`<span class="mod-saved" role="status">${T('Ustawienia czatu zapisane.')}</span>`:''}${s.updatedAt?h`<span class="mod-note">${T('Ostatnia zmiana: {time}',{time:fmtSeconds(s.updatedAt)})}</span>`:''}</div>
</form>
<section class="mod-health" aria-labelledby="mod-health-title"><div class="mod-health-head"><h3 id="mod-health-title">${T('Odpowiedzi hostingu w ostatniej godzinie')}</h3><button type="button" class="btn small-btn" data-mod="reload">${T('Odśwież')}</button></div>
<dl class="mod-tiles">${healthTile(429,'429',health[429],high)}${healthTile(503,'503',health[503])}${healthTile(508,'508',health[508])}${healthTile(0,T('Błędy sieci'),health[0])}</dl>
<p class="${high?'mod-note is-warn':'mod-note'}">${high?T('Liczba odpowiedzi 429 przekracza próg orientacyjny ({n}). Rozważ tempo „Oszczędne”.',{n:HOSTING_429_HINT}):T('Próg orientacyjny: ponad {n} odpowiedzi 429 w godzinie to powód, by wybrać tempo „Oszczędne”.',{n:HOSTING_429_HINT})}</p><p class="mod-note">${T('Liczby zgłaszają przeglądarki użytkowników, bez adresów i kont. Decyzję o zmianie tempa podejmujesz Ty.')}</p></section>`;
}
const tabLabel=tab=>({reports:T('Zgłoszone wiadomości'),muted:T('Wyciszeni'),history:T('Historia'),settings:T('Ustawienia czatu')})[tab];

// ---- Controller ----
const S={tab:'reports',data:{},err:{},busy:{},ticket:{},page:{reports:1,history:1},historyStatus:'actioned',open:new Set(),ctx:{},root:null,request:null,demo:false,saved:false,settingsError:''};
const request=(...args)=>(S.request||Client.request)(...args);
export const state=S;
const live=text=>{const el=S.root?.querySelector('[data-mod-live]');if(el)el.textContent=text||'';};
const loadingView=()=>h`<div class="mod-skeleton" aria-hidden="true">${[0,1,2].map(()=>h`<div class="mod-skel-row"></div>`)}</div>`;
function panelView(){
 if(S.demo)return h`<div class="mod-empty">${ui()?.emptyMascot?.()??''}<h3>${T('Ta funkcja jest niedostępna w wersji demonstracyjnej.')}</h3></div>`;
 const kind=S.tab,data=S.data[kind];
 if(S.err[kind]&&!data)return h`<div class="mod-empty"><p class="form-error" role="alert">${S.err[kind]}</p><button type="button" class="btn" data-mod="reload">${T('Spróbuj ponownie')}</button></div>`;
 if(!data)return loadingView();
 const err=S.err[kind]?h`<p class="form-error" role="alert">${S.err[kind]}</p>`:'';
 if(kind==='settings')return h`${err}${settingsView(data,{saved:S.saved,error:S.settingsError})}`;
 if(kind==='muted')return h`${err}${mutedView(data)}`;
 return h`${err}${queueView(data,S,kind==='history')}`;
}
function tabsView(){
 if(S.demo)return '';
 const count=tab=>tab==='reports'?(S.data.reports?.total??registry.badge('moderation')):tab==='muted'?S.data.muted?.items?.length:null;
 return h`${TABS.map(tab=>h`<button type="button" role="tab" id="mod-tab-${tab}" class="mod-tab" data-mod="tab" data-tab="${tab}" aria-selected="${String(tab===S.tab)}" aria-controls="mod-panel" tabindex="${tab===S.tab?0:-1}">${tabLabel(tab)}${count(tab)?h` <span class="mod-tab-count">${count(tab)}</span>`:''}</button>`)}`;
}
function focusKey(){
 const el=document.activeElement;if(!el||!S.root?.contains(el))return null;
 if(el.id)return '#'+el.id;
 const item=el.closest('[data-message]');return item&&el.dataset.mod?{message:item.dataset.message,mod:el.dataset.mod}:null;
}
function refocus(key){
 let el=null;
 if(typeof key==='string')el=S.root.querySelector('[id="'+key.slice(1).replace(/["\\]/g,'')+'"]');
 else if(key)el=S.root.querySelector('[data-message="'+String(key.message).replace(/["\\]/g,'')+'"] [data-mod="'+key.mod+'"]');
 el?.focus({preventScroll:true});
}
function drawTabs(){
 const tabs=S.root?.querySelector('[data-mod-tabs]');if(!tabs)return;
 const had=tabs.contains(document.activeElement)?document.activeElement.id:'';
 setHtml(tabs,tabsView());
 if(had)tabs.querySelector('[id="'+had.replace(/["\\]/g,'')+'"]')?.focus({preventScroll:true});
}
function drawPanel({keep=true}={}){
 const panel=S.root?.querySelector('[data-mod-panel]');if(!panel)return;
 const key=keep?focusKey():null;
 setHtml(panel,panelView());panel.setAttribute('aria-labelledby','mod-tab-'+S.tab);panel.setAttribute('aria-busy',String(!!S.busy[S.tab]&&!S.data[S.tab]));
 if(key)refocus(key);
}
function drawAll(){drawTabs();drawPanel();}
/** Loads one list (reports, muted, history or settings); a newer load of the same list wins. */
export async function load(kind,{quiet=false}={}){
 if(S.demo)return;
 const ticket=S.ticket[kind]=(S.ticket[kind]||0)+1;S.busy[kind]=true;S.err[kind]='';
 if(kind===S.tab&&!S.data[kind])drawPanel();
 try{
  const data=await request(listUrl(kind,{page:S.page[kind],status:S.historyStatus}));
  if(ticket!==S.ticket[kind])return;
  // The last item of the last page was settled: show the new last page.
  if((kind==='reports'||kind==='history')&&!data?.items?.length&&S.page[kind]>1){S.page[kind]=Math.max(1,Math.ceil((data?.total||0)/20));return load(kind,{quiet});}
  S.data[kind]=data;
  if(kind==='reports')registry.setBadge('moderation',data?.total||0);
 }catch(error){
  if(ticket!==S.ticket[kind])return;
  if(error?.status===401){ui()?.handleError?.(error);return;}
  S.err[kind]=translateMessage(error.message);
 }finally{
  if(ticket===S.ticket[kind]){S.busy[kind]=false;drawTabs();if(kind===S.tab)drawPanel();if(!quiet&&kind===S.tab)live(S.err[kind]||'');}
 }
}
function setTab(tab,{focus=false}={}){
 if(!TABS.includes(tab))return;
 S.tab=tab;S.saved=false;S.settingsError='';drawTabs();drawPanel({keep:false});
 if(focus)S.root.querySelector('#mod-tab-'+tab)?.focus();
 load(tab,{quiet:true});
}
/** After a change: the other lists are stale (dropped), the open one is loaded again. */
function reloadAfterChange(){
 for(const kind of TABS)if(kind!==S.tab&&kind!=='settings')S.data[kind]=null;
 S.ctx={};S.open.clear();
 return load(S.tab);
}
async function loadContext(id){
 S.ctx[id]={status:'loading'};drawPanel();
 try{const data=await request(contextUrl(id));S.ctx[id]={status:'ready',items:data.items||[]};}
 catch(error){if(error?.status===401){ui()?.handleError?.(error);return;}S.ctx[id]={status:'error',message:translateMessage(error.message)};}
 drawPanel();
}
function toggleContext(id){
 if(S.open.has(id)){S.open.delete(id);drawPanel();return;}
 S.open.add(id);
 if(S.ctx[id]?.status==='ready'){drawPanel();return;}
 loadContext(id);
}
const itemOf=id=>[...(S.data.reports?.items||[]),...(S.data.history?.items||[])].find(it=>String(it.message.id)===String(id))||null;
const modalActions=(label,formId,cls='primary')=>h`${ui().button(T('Anuluj'),'close-modal')}<button class="btn ${cls}" form="${formId}" type="submit">${label}</button>`;
const noteField=()=>h`<label class="mod-field">${T('Notatka wewnętrzna (opcjonalnie)')}<textarea name="note" rows="3" maxlength="300" dir="auto"></textarea></label>`;
function deleteModal(it){
 ui().modal(T('Usuń wiadomość'),h`<form id="mod-delete-form" data-kind="delete" data-message="${it.message.id}"><p class="modal-lead">${T('Wiadomość zostanie zastąpiona informacją o usunięciu. Kopia tekstu zostaje w dzienniku moderacji przez 30 dni.')}</p>${messageText(it.message,false)}${noteField()}<div class="form-error" role="alert"></div></form>`,modalActions(T('Usuń wiadomość'),'mod-delete-form','primary mod-danger'));
}
function dismissModal(it){
 ui().modal(T('Odrzuć zgłoszenie'),h`<form id="mod-dismiss-form" data-kind="dismiss" data-message="${it.message.id}"><p class="modal-lead">${it.message.state==='hidden_review'?T('Zgłoszenia zostaną zamknięte, a ukryta wiadomość wróci do czatu.'):T('Zgłoszenia tej wiadomości zostaną zamknięte.')}</p>${noteField()}<div class="form-error" role="alert"></div></form>`,modalActions(T('Odrzuć zgłoszenie'),'mod-dismiss-form'));
}
function muteModal(it){
 const name=personName(it.author);
 ui().modal(T('Wycisz {name}',{name}),h`<form id="mod-mute-form" data-kind="mute" data-user="${it.author.id}"><fieldset class="mod-fieldset"><legend>${T('Czas wyciszenia')}</legend>${DURATIONS.map(d=>h`<label class="mod-radio"><input type="radio" name="duration" value="${d}"${d==='24h'?' checked':''}><span><strong>${durationLabel(d)}</strong></span></label>`)}</fieldset>
<label class="mod-field">${T('Powód (widoczny tylko dla administratorów)')}<textarea name="reason" rows="2" maxlength="300" dir="auto"></textarea></label>
<p class="mod-note">${T('Użytkownik zobaczy:')}</p><p class="mod-preview" data-mod-preview>${muteNotice('24h')}</p><div class="form-error" role="alert"></div></form>`,modalActions(T('Wycisz'),'mod-mute-form'));
}
function channelModal(it){
 const channel=it.message.channel||{};
 ui().modal(T('Status czatu'),h`<form id="mod-channel-form" data-kind="channel" data-channel="${it.message.channelId}"><p class="modal-lead" dir="auto">${channelTitle(channel)}</p><fieldset class="mod-fieldset"><legend>${T('Status czatu')}</legend>${STATUSES.map(s=>h`<label class="mod-radio"><input type="radio" name="status" value="${s}"${s===channel.status?' checked':''}><span><strong>${statusLabel(s)}</strong><small>${statusAbout(s)}</small></span></label>`)}</fieldset><div class="form-error" role="alert"></div></form>`,modalActions(T('Zapisz status'),'mod-channel-form'));
}
async function post(body){return request('admin-chat-action',{method:'POST',body});}
const doneText=action=>({delete:T('Wiadomość usunięta.'),restore:T('Wiadomość przywrócona.'),dismiss:T('Zgłoszenia odrzucone.'),mute:T('Użytkownik wyciszony.'),unmute:T('Przywrócono możliwość pisania.'),channel:T('Status czatu zmieniony.')})[action]||'';
/** Runs an action that needs no dialog (restore, unmute); failures are shown as a toast. */
async function quick(action,input,button){
 if(button)button.disabled=true;
 try{await post(actionBody(action,input));ui()?.toast?.(doneText(action));await reloadAfterChange();S.root.querySelector('[data-mod-panel]')?.focus({preventScroll:true});}
 catch(error){if(error?.status===401){ui()?.handleError?.(error);return;}ui()?.toast?.(translateMessage(error.message));if(button)button.disabled=false;}
}
function run(kind,el){
 const id=el.closest('[data-message]')?.dataset.message,it=id?itemOf(id):null;
 if(kind==='tab')setTab(el.dataset.tab);
 else if(kind==='reload')load(S.tab);
 else if(kind==='page'){const next=Math.max(1,(S.page[S.tab]||1)+Number(el.dataset.dir));S.page[S.tab]=next;S.data[S.tab]=null;load(S.tab);}
 else if(kind==='ctx'&&id)toggleContext(Number(id));
 else if(kind==='delete'&&it)deleteModal(it);
 else if(kind==='dismiss'&&it)dismissModal(it);
 else if(kind==='mute'&&it)muteModal(it);
 else if(kind==='channel'&&it)channelModal(it);
 else if(kind==='restore'&&it)quick('restore',{messageId:it.message.id},el);
 else if(kind==='unmute'){const user=el.dataset.user||it?.author?.id;if(user)quick('unmute',{userId:user},el);}
}
function bind(root){
 if(bound.has(root))return;bound.add(root);
 root.addEventListener('click',event=>{const el=event.target.closest('[data-mod]');if(el&&root.contains(el))run(el.dataset.mod,el);});
 root.addEventListener('keydown',event=>{
  const tab=event.target.closest?.('[role="tab"]');if(!tab)return;
  const i=TABS.indexOf(tab.dataset.tab),to={ArrowRight:(i+1)%TABS.length,ArrowLeft:(i+TABS.length-1)%TABS.length,Home:0,End:TABS.length-1}[event.key];
  if(to!==undefined){event.preventDefault();setTab(TABS[to],{focus:true});}
 });
 root.addEventListener('change',event=>{
  if(event.target.matches?.('[data-mod-history-status]')){S.historyStatus=event.target.value;S.page.history=1;S.data.history=null;load('history');}
 });
}
const bound=new WeakSet();

// ---- Forms: modal dialogs and the settings form (prefix mod-, one document listener) ----
async function submit(event){
 const form=event.target;if(!form?.id||!form.id.startsWith('mod-')||!form.dataset?.kind)return;
 event.preventDefault();
 const f=new FormData(form),box=form.querySelector('.form-error'),button=event.submitter;
 if(button?.disabled)return;if(button)button.disabled=true;if(box)box.textContent='';
 try{
  const kind=form.dataset.kind;
  if(kind==='settings'){
   const body=settingsBody(S.data.settings,{on:f.has('on'),preset:f.get('preset'),notice:f.get('notice')});
   if(!changed(body)){S.saved=false;if(box)box.textContent=T('Brak zmian do zapisania.');return;}
   S.data.settings=await request('admin-chat-settings-save',{method:'POST',body});S.saved=true;S.settingsError='';
   ui()?.toast?.(T('Ustawienia czatu zapisane.'));drawPanel();return;
  }
  const input={messageId:form.dataset.message,userId:form.dataset.user,channelId:form.dataset.channel,note:f.get('note'),reason:f.get('reason'),duration:f.get('duration'),status:f.get('status')};
  await post(actionBody(kind,input));
  ui()?.closeModal?.();ui()?.toast?.(doneText(kind));
  await reloadAfterChange();S.root?.querySelector('[data-mod-panel]')?.focus({preventScroll:true});
 }catch(error){
  if(error?.status===401){ui()?.handleError?.(error);return;}
  const message=translateMessage(error.message);
  // 409: somebody saved meanwhile, so the form is rebuilt from the fresh state. Any other failure (network, 429/503, 422) keeps what the Admin typed.
  if(form.dataset.kind==='settings'&&error?.status===409){S.saved=false;await load('settings',{quiet:true});S.settingsError=message;drawPanel();}
  else if(box)box.textContent=message;
 }finally{if(button?.isConnected)button.disabled=false;}
}
function preview(event){
 const form=event.target.form;
 if(event.target.name==='duration'&&form?.id==='mod-mute-form'){const el=form.querySelector('[data-mod-preview]');if(el)el.textContent=muteNotice(event.target.value);}
}
if(typeof document!=='undefined'){document.addEventListener('submit',submit);document.addEventListener('change',preview);}

/** Draws the panel into root (the page's [data-mod-root]); the state of the last visit (tab, page, open contexts) is kept across redraws.
 * options.request and options.demo are for tests; by default the session client is used and the demo shows a notice. */
export function mount(root,{request:custom,demo=Client.isDemo}={}){
 S.root=root;S.request=custom||null;S.demo=!!demo;
 bind(root);
 setHtml(root,h`<div class="mod-tabs" role="tablist" aria-label="${T('Moderacja')}" data-mod-tabs></div><section class="mod-panel" id="mod-panel" role="tabpanel" tabindex="-1" data-mod-panel aria-busy="true"></section><div class="mod-live" role="status" aria-live="polite" data-mod-live></div>`);
 root.removeAttribute('aria-busy');
 drawAll();
 if(!S.demo){load(S.tab,{quiet:true});if(S.tab!=='reports')load('reports',{quiet:true});}
}
