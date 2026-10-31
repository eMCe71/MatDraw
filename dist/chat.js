/* MatBravo chat interface (plan §5, §8.9; research 05 §2-§8, §14). Loaded lazily by chat-boot.js.
 * Views: the home card (desktop tabs; phone preview with chips, three messages and "Open chat"), the full chat (#chat in the shell,
 * public #chat for guests; rail of channels on desktop, chips on phones), the tournament tab of the guest preview, the strip above the
 * tournaments grid, plus counters ([data-chat-count], [data-chat-tab-count], [data-chat-tournament-link], menu badges).
 * State lives in this module (channels, cursors, messages, people), so a language switch or a re-render keeps channel, scroll and draft.
 * Rendering: values from the API reach the DOM only through textContent, createTextNode or h`` (plan §5.9); links are <a> elements
 * built with createElement, http(s) only. Drafts per channel in sessionStorage matdraw.chat.draft.*; read cursors, muted channels and
 * hidden people per person in localStorage (matdraw.chat.u.<publicId>.*). purgeIdentity() on sign-out, reset and 401. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {t as T,locale,getLanguage,translateMessage} from './i18n.js';
import {getMe,onMe,loadMe,personKey} from './me.js';
import {createTransport,normalizeCfg,clientId} from './chat-transport.js';
import {SPORTS} from './profile-data.js';
const Demo=Client.isDemo?await import('./chat-demo.js'):null;

export const MAX_DOM=300,GROUP_MS=300000,PREVIEW=3,SR_MS=15000,READ_MS=1000,FLOOR_PREVIEW=10000;
const DRAFT='matdraw.chat.draft.',SEEN='matdraw.chat.seen',LAST='matdraw.chat.channel',STRIP='matdraw.chat.strip';
const SLUGS=['taekwondo','taekwondo-pl','karate','general'];

// ——— Pure helpers (tests/chat-client.test.mjs) ———

export const LINK=/\bhttps?:\/\/[^\s<>"']+/g;
/** Text split into text and link tokens: http(s) URLs only, trailing .,;:!?) cut off, label without protocol, at most 60 characters. */
export function tokenize(text){
 const s=String(text??''),out=[];let last=0;
 for(const m of s.matchAll(LINK)){
  const raw=m[0].replace(/[.,;:!?)]+$/,'');if(!raw)continue;
  let url=null;try{url=new URL(raw);}catch{url=null;}
  if(!url||(url.protocol!=='http:'&&url.protocol!=='https:'))continue;
  if(m.index>last)out.push({t:'text',v:s.slice(last,m.index)});
  const bare=raw.replace(/^https?:\/\//i,'');
  out.push({t:'link',href:url.href,host:url.hostname,label:bare.length>60?bare.slice(0,59)+'…':bare});last=m.index+raw.length;
 }
 if(last<s.length)out.push({t:'text',v:s.slice(last)});
 return out;
}
/** Message text as DOM nodes: text nodes and, for members, <a rel="noopener noreferrer nofollow ugc" target="_blank">; guests see the domain as text. */
export function textNodes(doc,text,{links=true}={}){
 const frag=doc.createDocumentFragment();
 for(const tok of tokenize(text)){
  if(tok.t==='text'){frag.appendChild(doc.createTextNode(tok.v));continue;}
  if(!links){frag.appendChild(doc.createTextNode(tok.host));continue;}
  const a=doc.createElement('a');a.href=tok.href;a.rel='noopener noreferrer nofollow ugc';a.target='_blank';a.className='chat-link';a.textContent=tok.label;frag.appendChild(a);
 }
 return frag;
}
const pad=n=>String(n).padStart(2,'0');
/** Local calendar day of a time in ms: YYYY-MM-DD. */
export const dayKey=ms=>{const d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};
/** Day separator: Dzis, Wczoraj, "pt 14 lis" this year, "14 lis 2025" otherwise (UI locale). */
export function dayLabel(ms,now=Date.now()){
 const k=dayKey(ms);if(k===dayKey(now))return T('Dziś');
 const y=new Date(now);y.setDate(y.getDate()-1);if(k===dayKey(y.getTime()))return T('Wczoraj');
 const d=new Date(ms);return d.toLocaleDateString(locale(),d.getFullYear()===new Date(now).getFullYear()?{weekday:'short',day:'numeric',month:'short'}:{day:'numeric',month:'short',year:'numeric'});
}
/** Time of a message: "teraz" under a minute, "{n} min" under an hour, else HH:mm. */
export function timeLabel(ms,now=Date.now()){
 const d=now-ms;if(d<60000&&d>-60000)return T('teraz');if(d>0&&d<3600000)return T('{n} min',{n:Math.floor(d/60000)});
 return new Date(ms).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'});
}
const author=m=>m.a??(m.g!=null?'g'+m.g:null);
/**
 * Items of a message list (sorted by id): day separators, the "Nowe" divider before message `divider`, messages with group=true when
 * they continue the previous one (server cont, or an own pending message): same author, same day, under 5 minutes, no divider between
 * and the previous one is not a tombstone.
 */
export function layout(msgs,{divider=null,now=Date.now(),own=null}={}){
 const items=[];let prev=null,prevDay=null;const today=dayKey(now);
 for(const m of msgs){
  const d=dayKey(m.t);
  if(d!==prevDay){items.push({kind:'day',key:'d:'+d+':'+(d===today?'t':'')+getLanguage(),t:m.t});prevDay=d;prev=null;}
  if(divider!=null&&m.id===divider){items.push({kind:'new',key:'new'});prev=null;}
  const cont=m.pending?!!prev&&(!!prev.own||!!own&&prev.a===own):m.c===1;
  const group=!!prev&&!prev.x&&!m.x&&!prev.hidden&&!m.hidden&&cont&&author(prev)===author(m)&&m.t-prev.t<GROUP_MS&&m.t>=prev.t;
  items.push({kind:'msg',m,group});prev=m;
 }
 return items;
}
/** Default channel (plan §5.1): last used, else a member's sport and country, else the interface language. */
export function defaultSlug({stored,me,lang}){
 if(SLUGS.includes(stored))return stored;
 const p=me?.profile;
 if(p){const sport=p.sports?.[0];return sport==='taekwondo'?(p.country==='PL'?'taekwondo-pl':'taekwondo'):sport==='karate'?'karate':'general';}
 return lang==='pl'?'taekwondo-pl':'taekwondo';
}
/**
 * What closes or opens the composer: composer | readonly | off | wait | login | paid | free (guests, matrix §6.10 from public-config)
 * | activate (no full access) | profile | password | muted (me.access.block, in the order of the chat-send checks).
 */
export function footKind({signedIn,me,config,st,on=true}){
 if(st==='archive'||st==='closed')return 'readonly';
 if(!on)return 'off';
 if(!signedIn){if(!config?.signup)return 'login';return config.billing?'paid':'free';}
 if(!me)return 'wait';
 const block=me.access?.block;
 if(block==='payment')return 'activate';if(block==='profile')return 'profile';if(block==='password')return 'password';
 if(block==='muted')return 'muted';if(block==='off')return 'off';
 return me.access?.canPost===false?'activate':'composer';
}
/** Price of the plan for the interface language (PL: PLN, EN: USD), e.g. "8,99 zl" or "$2.99"; null without amounts. */
export function priceText(amounts,lang=getLanguage()){
 const cur=lang==='pl'?'pln':'usd',n=amounts?.[cur];if(!Number.isFinite(n))return null;
 try{return new Intl.NumberFormat(lang==='pl'?'pl-PL':'en-GB',{style:'currency',currency:cur.toUpperCase(),currencyDisplay:'narrowSymbol'}).format(n/100);}catch{return (n/100).toFixed(2)+' '+cur.toUpperCase();}
}
/** Avatar downloads, at most `max` at a time: the src is set only when a slot is free (plan §5.4); a slot is freed on load, error or after 10 s. */
export function avatarQueue(max=2,{setTimeout:later=(f,ms)=>setTimeout(f,ms)}={}){
 const waiting=[];let active=0;
 function next(){
  while(active<max&&waiting.length){
   const [img,src]=waiting.shift();if(img.isConnected===false)continue;active++;
   let done=false;const free=()=>{if(done)return;done=true;active--;next();};
   img.addEventListener?.('load',free,{once:true});img.addEventListener?.('error',free,{once:true});later(free,10000);img.src=src;
  }
 }
 return {add(img,src){waiting.push([img,src]);next();},clear(){waiting.length=0;},get active(){return active;},get waiting(){return waiting.length;}};
}

// ——— State ———

const S={mode:null,transport:null,channels:new Map(),lobby:[],tours:[],archive:[],byTid:new Map(),people:new Map(),status:'connecting',cfg:normalizeCfg(null),
 pending:new Map(),listsAt:0,listsP:null,listsError:null,unavailable:false,config:null,configP:null,views:new Set(),outdated:false,reported:new Set(),revealed:new Set(),
 scroll:new Map(),homeSlug:null,pageKey:null,lastSend:0,limitUntil:0,queued:null,flush:null};
const avatars=avatarQueue(2);
let ready=false,vid=0,minuteTimer=null;
const doc=()=>globalThis.document;
const ui=()=>registry.use('ui')||{};
const ws=()=>{try{return ui().getWorkspace?.()||null;}catch{return null;}};
const icon=(name,cls='')=>ui().icon?ui().icon(name,cls):h``;
const local={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{localStorage.setItem(k,v);}catch{}},json(k,f){try{const v=JSON.parse(localStorage.getItem(k));return v??f;}catch{return f;}}};
const session={get(k){try{return sessionStorage.getItem(k);}catch{return null;}},set(k,v){try{if(v)sessionStorage.setItem(k,v);else sessionStorage.removeItem(k);}catch{}}};
const pk=name=>personKey('matdraw.chat',name);
const myPid=()=>getMe()?.profile?.publicId||null;
const isAdmin=()=>ws()?.user?.role==='admin';
const signedIn=()=>!!ws();
const full=()=>!!getMe()?.access?.full;
const readMap=()=>{const k=pk('read');return k?local.json(k,{}):local.json(SEEN,{});};
function setRead(id,last){const k=pk('read')||SEEN,map=local.json(k,{});if((map[id]||0)>=last)return false;map[id]=last;const keys=Object.keys(map);if(keys.length>120)delete map[keys[0]];local.set(k,JSON.stringify(map));return true;}
const listOf=name=>{const k=pk(name);return k?local.json(k,[]):[];};
function toggleIn(name,value){const k=pk(name);if(!k)return;const list=new Set(local.json(k,[]));if(list.has(value))list.delete(value);else list.add(value);local.set(k,JSON.stringify([...list].slice(-200)));}
const hiddenPeople=()=>new Set(listOf('hidden'));
const mutedChannels=()=>new Set(listOf('muted'));
const today=()=>dayKey(Date.now());
const draftKey=key=>DRAFT+key;

function chan(key,props){let c=S.channels.get(key);if(!c){c={key,id:/^\d+$/.test(key)?key:null,msgs:new Map(),cursor:0,loaded:false,older:false,st:'open',known:0,n:0,count:0,counted:0,countedRead:0};S.channels.set(key,c);}Object.assign(c,props);return c;}
const sorted=c=>[...c.msgs.values()].sort((a,b)=>a.id-b.id);
const lastId=c=>{let m=c.known||0;for(const id of c.msgs.keys())if(id>m)m=id;return m;};
const chName=c=>!c?'':c.kind==='lobby'?(c.slug==='general'?T('Ogólny'):c.slug==='karate'?'Karate':'Taekwondo'):c.title||T('Czat turnieju');
const chScope=c=>c?.kind==='lobby'?(c.scope==='pl'?T('Polska'):T('Świat')):'';
const chFull=c=>c?.kind==='lobby'?chName(c)+' · '+chScope(c):chName(c);
const ABOUT={pl:()=>T('Rozmowy po polsku'),world:()=>T('Dowolny język — najlepiej angielski'),general:()=>T('Wszystko o sztukach walki i MatBravo')};
const chAbout=c=>!c?'':c.kind==='lobby'?(c.slug==='general'?ABOUT.general():c.scope==='pl'?ABOUT.pl():ABOUT.world()):[c.date?fmtDate(c.date):'',c.city||''].filter(Boolean).join(' · ');
const fmtDate=d=>{const x=new Date(d+'T12:00:00');return Number.isNaN(x.getTime())?d:x.toLocaleDateString(locale(),{day:'numeric',month:'long',year:'numeric'});};
const slugKey=slug=>S.lobby.find(k=>S.channels.get(k)?.slug===slug)||null;
const keyOfTid=tid=>S.byTid.get(tid)||null;
const routeOf=c=>c?.kind==='tournament'?{t:c.tid}:{c:c?.slug||'general'};

// ——— Transport ———

function mode(){return signedIn()?'feed':'public';}
function resetStore(){
 for(const c of S.channels.values()){c.msgs.clear();c.cursor=0;c.loaded=c.id===null;c.older=false;c.n=0;c.counted=0;}
 S.people.clear();S.pending.clear();S.listsAt=0;S.listsP=null;
 for(const v of S.views){v.nodes.clear();v.divider=undefined;}
}
function transport(){
 const m=mode();
 if(S.transport&&S.mode!==m){S.transport.stop();S.transport=null;resetStore();}
 S.mode=m;
 if(S.transport&&!S.transport.stopped)return S.transport;
 if(S.outdated)return null;
 const opts={mode:()=>S.mode,wants,isOwn:m=>!!m.a&&m.a===myPid(),onData:apply,onStatus:st=>{S.status=st;paintAll(false);},onUnauth:unauthorized,
  onOutdated:()=>{S.outdated=true;S.status='error';paintAll(false);}};
 S.transport=Demo?Demo.createDemoTransport({...opts,me:()=>getMe(),tournaments:()=>Client.upcoming().then(r=>r?.tournaments||[])}):createTransport(opts);
 S.status=S.transport.status;
 return S.transport;
}
const announce=()=>{if(S.transport&&!S.transport.stopped)S.transport.update();};
function liveViews(){for(const v of S.views)if(!v.el.isConnected){S.views.delete(v);v.io?.disconnect();}return [...S.views];}
/** What this tab needs from the poller: channels on screen with their cursors, background counters, pace hints. */
function wants(){
 const ch={},h={},init=[];let onScreen=false,floor=null;
 const views=liveViews();
 for(const v of views){
  const c=S.channels.get(v.key);if(!c?.id||c.gone)continue;
  ch[c.id]=c.cursor;if(!c.loaded&&!init.includes(c.id))init.push(c.id);
  if(v.kind!=='strip'&&v.visible&&!v.hiddenTab){onScreen=true;const f=v.compact?FLOOR_PREVIEW:0;floor=floor===null?f:Math.min(floor,f);}
 }
 if(views.length||signedIn()){
  const read=readMap(),heads=[...S.lobby,...(signedIn()?S.tours:[])].map(k=>S.channels.get(k)).filter(c=>c?.id&&!c.gone);
  // Members: knownLast is the last id the counter c.n was computed for (counted), not the channel's last id from the lists: a channel
  // that got messages while the person was away is counted on the first poll, and counted again after the read cursor moved (another
  // tab). Guests never see c.n (their dot is c.known > read), so they send the known last id and the server counts only on a change.
  const member=signedIn();
  for(const c of heads.slice(0,30))if(!(c.id in ch)){const r=read[c.id]||0;h[c.id]=[r,member?(c.countedRead===r?c.counted||0:0):c.known||0];}
 }
 return {ch,h,init,onScreen,floor:floor||0};
}
function unauthorized(){
 purgeIdentity();
 if(ws())ui().handleError?.(Object.assign(new Error('Zaloguj się ponownie.'),{status:401}));
 else{transport();announce();}
}
/** A poll answer (also broadcast from the leader tab): settings, people, channel changes, background counters. */
function apply(data,from={},sent=null){
 if(!data||typeof data!=='object')return;
 if(data.cfg)S.cfg=normalizeCfg(data.cfg);
 for(const [pid,p] of Object.entries(data.people||{}))if(p&&typeof p==='object')S.people.set(pid,p);
 const changed=new Set(),me=myPid(),others=new Map();
 for(const [id,e] of Object.entries(data.ch||{})){
  const c=S.channels.get(id);if(!c||!e)continue;changed.add(id);
  if(e.st==='gone'){c.gone=true;c.st='gone';continue;}
  if(e.st)c.st=e.st;c.gone=false;
  const list=Array.isArray(e.m)?e.m:[];
  if('older' in e){
   if(!c.loaded||c.cursor<(e.rev||0)){c.msgs.clear();c.older=!!e.older;}
   for(const m of list)upsert(c,m);
   c.loaded=true;c.cursor=Math.max(c.cursor,e.rev||0);
  }else{
   if(e.more||c.cursor<(from[id]??0)){c.cursor=0;c.reload=true;continue;}
   // A change to a message below the loaded window (a deletion, hide or restore far back) is not inserted: it would sit above the
   // window without a gap and 'older' would ask for history before it, skipping everything between. History brings it in its state.
   const floor=c.older&&c.msgs.size?sorted(c)[0].id:-Infinity;
   for(const m of list){if(!c.msgs.has(m?.id)&&m?.id<floor)continue;if(!c.msgs.has(m.id)&&!m.x&&m.a!==me)others.set(id,(others.get(id)||0)+1);upsert(c,m);}
   if(Number.isFinite(e.rev))c.cursor=Math.max(c.cursor,e.rev);
  }
  c.known=Math.max(c.known||0,lastId(c));
  if(c.msgs.size>MAX_DOM&&!liveViews().some(v=>v.key===id&&!v.pinned)){const drop=sorted(c).slice(0,c.msgs.size-MAX_DOM);for(const m of drop)c.msgs.delete(m.id);c.older=true;}
 }
 for(const [id,v] of Object.entries(data.heads||{})){
  const c=S.channels.get(id);if(!c||!v)continue;if(v.st==='gone'){c.gone=true;continue;}
  if(Number.isFinite(v.last))c.known=Math.max(c.known||0,v.last);
  // n was counted for the read cursor sent with the poll (sent[id][0]); when the cursor moved meanwhile (read here or in another tab
  // while the poll was in flight), counted() keeps the old cursor so the next wants() sends knownLast 0 and the server counts again.
  if(Number.isFinite(v.n)){const now=readMap()[c.id]||0,was=Array.isArray(sent?.[id])&&Number.isFinite(sent[id][0])?sent[id][0]:now;
   if(was!==now&&Number.isFinite(v.last)&&now>=v.last){c.n=0;counted(c,now,v.last);}else{c.n=v.n;if(Number.isFinite(v.last))counted(c,was,v.last);}}
  changed.add(id);
 }
 for(const v of liveViews())if(changed.has(v.key)||v.kind==='strip')paint(v,{others:others.get(v.key)||0});
 if([...changed].some(id=>S.channels.get(id)?.reload))S.transport?.poke();
 for(const c of S.channels.values())c.reload=false;
 counters();announce();
}
/** c.n is the number of unread messages up to `last` for read cursor `read` (sent back as knownLast while the cursor stays). */
function counted(c,read,last){c.counted=last;c.countedRead=read;}
function upsert(c,m){
 if(!m||!Number.isFinite(m.id))return;const old=c.msgs.get(m.id);if(old&&old.r>m.r)return;
 c.msgs.set(m.id,m);c.known=Math.max(c.known||0,m.id);
}

// ——— Lists and public settings ———

function ensureLists(force=false){
 const t=transport();if(!t)return Promise.resolve(false);
 if(S.listsP)return S.listsP;
 if(!force&&S.listsAt&&Date.now()-S.listsAt<(signedIn()?300000:60000))return Promise.resolve(true);
 const wanted=S.mode;
 S.listsP=t.lists().then(r=>{if(S.mode===wanted)applyLists(r);S.listsError=null;S.unavailable=false;return true;},error=>{
  S.listsError=error;if(error?.gone||error?.status===404)S.unavailable=true;if(error?.off)S.cfg={...S.cfg,on:false};return false;
 }).finally(()=>{S.listsP=null;paintAll(true);announce();});
 return S.listsP;
}
function applyLists(r){
 if(r?.cfg)S.cfg=normalizeCfg(r.cfg);
 S.lobby=[];S.tours=[];S.archive=[];S.byTid.clear();
 for(const x of r?.lobby||[]){if(!SLUGS.includes(x.slug))continue;const c=chan(String(x.id),{kind:'lobby',slug:x.slug,scope:x.scope,st:x.st||'open',count:x.count||0});c.known=Math.max(c.known||0,x.last||0);S.lobby.push(c.key);}
 const day=today();
 for(const x of r?.tournaments||[]){
  if(!x?.tournamentId)continue;const key=x.id!=null?String(x.id):'t:'+x.tournamentId;
  const c=chan(key,{kind:'tournament',tid:x.tournamentId,title:x.title,date:x.date,city:x.city,st:x.st||'open',count:x.count||0});
  c.known=Math.max(c.known||0,x.last||0);if(x.id==null){c.loaded=true;c.virtual=true;}
  S.byTid.set(x.tournamentId,key);(x.st==='archive'||(x.date&&x.date<day&&x.st!=='open')?S.archive:S.tours).push(key);
 }
 // A tournament channel created since the last lists replaces its virtual entry 't:<tournamentId>' (views and drafts move with it).
 for(const [k,c] of [...S.channels]){
  const real=c.virtual?keyOfTid(c.tid):null;if(!real||real===k)continue;
  const draft=session.get(draftKey(k));if(draft&&!session.get(draftKey(real)))session.set(draftKey(real),draft);session.set(draftKey(k),'');
  S.channels.delete(k);if(S.pageKey===k)S.pageKey=real;
  for(const v of S.views)if(v.key===k){const ta=v.footEl?.querySelector?.('textarea[data-chat-key]');if(ta)ta.dataset.chatKey=real;v.key=real;v.divider=undefined;v.nodes.clear();v.pinned=true;}
 }
 S.listsAt=Date.now();
 baseline();
}
/** Unread counts start at the first visit: a channel never read on this device counts from its last message known then. */
function baseline(){
 if(!signedIn()||!pk('read'))return;const read=readMap();let moved=false;
 for(const c of [...S.lobby,...S.tours].map(k=>S.channels.get(k)))if(c?.id&&read[c.id]===undefined&&c.known&&setRead(c.id,c.known)){c.n=0;counted(c,c.known,c.known);moved=true;}
 if(moved){counters();announce();}
}
function ensureConfig(){
 if(S.config||S.configP)return S.configP||Promise.resolve(S.config);
 S.configP=Client.publicGet({route:'public-config'}).then(r=>{S.config=r?.status===200&&r.data?r.data:{signup:false,billing:false};},()=>{S.config={signup:false,billing:false};}).finally(()=>{S.configP=null;paintAll(false);});
 return S.configP;
}

// ——— Identity ———

/** Drops everything that belongs to the signed-in person (plan §5.4, §8.3 point 8): people, messages, cursors, avatar URLs, drafts. */
export function purgeIdentity(){
 S.transport?.stop();S.transport=null;S.mode=null;
 S.people.clear();S.pending.clear();S.reported.clear();S.revealed.clear();S.scroll.clear();S.queued=null;
 S.channels.clear();S.lobby=[];S.tours=[];S.archive=[];S.byTid.clear();S.listsAt=0;S.listsP=null;S.pageKey=null;
 avatars.clear();
 for(const v of S.views)for(const ta of v.el.querySelectorAll?.('textarea[data-chat-key]')||[]){clearTimeout(ta.saveTimer);ta.value='';}
 try{const keys=[];for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k?.startsWith(DRAFT))keys.push(k);}for(const k of keys)sessionStorage.removeItem(k);}catch{}
 for(const v of S.views){v.nodes.clear();v.divider=undefined;v.key=null;v.foot=null;v.el.querySelectorAll?.('img').forEach(img=>img.removeAttribute('src'));}
}

// ——— Views ———

/** Mounts a view into el (kind home | page | tournament | strip); a view already mounted there is refreshed instead. */
export function mount(el,kind,opts={}){
 if(!el)return null;
 if(el.chatView&&S.views.has(el.chatView)){paint(el.chatView);return el.chatView;}
 ensureGlobal();transport();
 const v={id:++vid,el,kind,key:null,nodes:new Map(),pinned:true,unseen:0,firstUnseen:null,visible:kind!=='home',compact:false,tid:opts.tid||null,params:opts.params||new URLSearchParams(),divider:undefined,srN:0,srAt:0,srTimer:null,readTimer:null,foot:null};
 el.chatView=v;S.views.add(v);
 v.compact=kind==='home'&&matchesPhone();
 frame(v);
 if(kind==='home'||kind==='tournament'){
  try{v.io=new IntersectionObserver(entries=>{const was=v.visible;v.visible=entries.some(e=>e.isIntersecting);if(v.visible!==was){announce();if(v.visible)S.transport?.poke();}},{rootMargin:'200px'});v.io.observe(el);}catch{v.visible=true;}
 }
 ensureConfig();
 ensureLists().then(()=>{choose(v);paint(v,{open:true});announce();S.transport?.poke();});
 if(S.listsAt){choose(v);paint(v,{open:true});}
 return v;
}
const matchesPhone=()=>{try{return matchMedia('(max-width:650px)').matches;}catch{return false;}};
/** Picks the channel of a view from its route, the remembered choice or the default rules. */
function choose(v){
 const cur=v.key?S.channels.get(v.key):null;
 if(cur&&!cur.gone&&!(cur.virtual&&keyOfTid(cur.tid)&&keyOfTid(cur.tid)!==v.key))return;
 const me=getMe(),stored=local.get(LAST),fallback=()=>{v.auto=!stored&&!me&&signedIn();return slugKey(defaultSlug({stored,me,lang:getLanguage()}))||S.lobby[0]||null;};
 if(v.kind==='tournament'){v.key=keyOfTid(v.tid);if(!v.key)v.missing=true;return;}
 if(v.kind==='home'){v.key=(S.homeSlug&&slugKey(S.homeSlug))||fallback();return;}
 if(v.kind==='strip'){v.key=fallback();return;}
 const t=v.params.get('t'),c=v.params.get('c');
 if(t){v.key=keyOfTid(t);if(!v.key){v.missing=true;return;}}
 else if(c&&slugKey(c))v.key=slugKey(c);
 else v.key=(S.pageKey&&S.channels.has(S.pageKey)?S.pageKey:null)||fallback();
 v.missing=false;
}
function open(v,key){
 if(!key||v.key===key)return;v.auto=false;
 saveScroll(v);
 v.key=key;v.divider=undefined;v.nodes.clear();v.pinned=true;v.unseen=0;v.foot=null;v.missing=false;
 const c=S.channels.get(key);
 if(c?.kind==='lobby'){local.set(LAST,c.slug);if(v.kind==='home')S.homeSlug=c.slug;}
 if(v.kind==='page'){S.pageKey=key;if(registry.parseRoute(location.hash).page==='chat'){try{history.replaceState(null,'',registry.routeHash('chat',routeOf(c)));}catch{}}}
 frame(v);paint(v,{open:true});announce();S.transport?.poke();
}

// ——— Templates ———

const flagPl=()=>h`<span class="chat-flag" aria-hidden="true"><svg viewBox="0 0 16 10" focusable="false"><rect width="16" height="5" fill="#fff"/><rect y="5" width="16" height="5" fill="#dc143c"/></svg></span>`;
function chIcon(c){
 if(c?.kind==='tournament'){const d=c.date?new Date(c.date+'T12:00:00'):null;return d&&!Number.isNaN(d.getTime())?h`<span class="chat-ch-date${c.date===today()?' is-today':''}" aria-hidden="true"><small>${d.toLocaleDateString(locale(),{month:'short'}).replace('.','')}</small><strong>${d.getDate()}</strong></span>`:h`<span class="chat-ch-ico" aria-hidden="true">${icon('trophy')}</span>`;}
 return h`<span class="chat-ch-ico" aria-hidden="true">${c?.scope==='pl'?flagPl():icon('globe')}</span>`;
}
const langSwitch=()=>h`<div class="lang-switch" role="group" aria-label="Język / Language">${[['pl','PL','Polski'],['en','EN','English']].map(([code,label,name])=>h`<button type="button" class="lang-option" data-set-lang="${code}" lang="${code}" aria-pressed="${getLanguage()===code}" aria-label="${name}" title="${name}">${label}</button>`)}</div>`;
const live=()=>h`<span class="chat-live" data-chat-part="live" hidden><i aria-hidden="true"></i>${T('Na żywo')}</span>`;
/** Static frame of a view; dynamic parts are filled by paint(). */
function frame(v){
 saveDraft(v);
 const c=S.channels.get(v.key),hid='chat-v'+v.id;
 const main=h`<div class="chat-main"><div class="chat-banners" data-chat-part="banners"></div><div class="chat-log" data-chat-part="log" role="feed" tabindex="0" aria-busy="true" aria-label="${T('Wiadomości: {channel}',{channel:chFull(c)})}" aria-describedby="${hid}-feed-note"></div><button type="button" class="chat-pill" data-chat-act="pill" hidden>${icon('down')}<span data-chat-part="pill"></span></button></div><p class="sr-only" id="${hid}-feed-note">${signedIn()&&full()?'':T('Imiona uczestników widzą tylko członkowie MatBravo.')}</p>`;
 const foot=h`<div class="chat-foot" data-chat-part="foot"></div><div class="sr-only" aria-live="polite" aria-atomic="true" data-chat-part="sr"></div>`;
 let html;
 if(v.kind==='home'){
  html=h`<div class="chat-card chat-v-home${v.compact?' is-compact':''}"><div class="chat-head"><span class="chat-head-ico" aria-hidden="true">${icon('chat')}</span><div class="chat-grow"><h2 id="home-chat-title">${T('Czat MatBravo')}</h2><p>${T('Rozmowy środowiska — czytać może każdy')}</p></div>${live()}${v.compact?'':h`<a class="chat-icon-btn" data-chat-part="expand" href="${registry.routeHash('chat',routeOf(c))}" aria-label="${T('Otwórz pełny czat')}" title="${T('Otwórz pełny czat')}">${icon('expand')}</a>`}</div><div class="${v.compact?'chat-chips':'chat-tabs'}" role="tablist" aria-label="${T('Kanały')}" data-chat-part="tabs"></div><div role="tabpanel" class="chat-panel" id="${hid}-panel" aria-labelledby="${hid}-tab-${v.key||'x'}">${main}</div>${foot}</div>`;
 }else if(v.kind==='strip'){
  html=h``;
 }else if(v.kind==='tournament'){
  html=h`<div class="chat-card chat-v-tournament"><div class="chat-conv-head" data-chat-part="convhead"></div>${main}${foot}</div>`;
 }else{
  html=h`<div class="chat-full${signedIn()?'':' is-public'}"><nav class="chat-rail" aria-label="${T('Kanały czatu')}" data-chat-part="rail"></nav><section class="chat-conv" aria-label="${chFull(c)||T('Czat')}"><div class="chat-conv-head" data-chat-part="convhead"></div><div class="chat-chips" role="list" data-chat-part="chips"></div>${main}${foot}</section></div>`;
 }
 setHtml(v.el,html);
 if(v.kind==='home')v.el.setAttribute('aria-busy','false');
 const part=name=>v.el.querySelector('[data-chat-part="'+name+'"]');
 Object.assign(v,{log:part('log'),pillBtn:v.el.querySelector('.chat-pill'),pillText:part('pill'),footEl:part('foot'),banners:part('banners'),sr:part('sr'),tabs:part('tabs'),rail:part('rail'),chips:part('chips'),convhead:part('convhead'),strip:part('strip'),liveEl:part('live'),expand:part('expand')});
 v.nodes.clear();v.foot=null;
}

// ——— Painting ———

function paintAll(lists){for(const v of liveViews()){if(lists)choose(v);paint(v);}counters();}
/** Without the chat on the server (404) the home page drops the card (two columns, workspace.css). */
function unavailable(v){const centre=v.el.closest?.('.home-centre');if(centre)centre.hidden=S.unavailable;}
/** Updates a view from the state: navigation, header, banners, messages, pill and composer. */
function paint(v,{open:opening=false,others=0}={}){
 if(!v.el.isConnected)return;
 if(v.kind==='strip'){paintStrip(v);return;}
 if(v.kind==='home')unavailable(v);
 if(v.kind==='home'&&v.compact!==matchesPhone()){v.compact=matchesPhone();frame(v);}
 const c=S.channels.get(v.key);
 if(v.liveEl)v.liveEl.hidden=S.status!=='live';
 if(v.expand&&c)v.expand.href=registry.routeHash('chat',routeOf(c));
 if(v.tabs)paintTabs(v);if(v.rail)paintRail(v);if(v.chips)paintChips(v);if(v.convhead)paintConvHead(v,c);
 paintBanners(v,c);paintLog(v,c,opening,others);paintFoot(v,c);
}
/** Writes a navigation part only when its markup changed and keeps keyboard focus on the same control: polling repaints the
 * tabs, rail, chips, header and banners every few seconds, and a plain rewrite would drop the focus to <body>, re-announce
 * the role="status"/"alert" banners and collapse an opened archive. */
function swap(el,safe){
 if(!el||el.chatHtml===safe.html)return false;
 const a=doc()?.activeElement,inside=!!a&&a!==el&&!!el.contains?.(a),key=inside?a.dataset?.key:undefined,act=inside?a.dataset?.chatAct:undefined;
 // controls without data-chat-act: the archive toggle (<summary>) and the phone menu button (data-action)
 const summary=inside&&!act&&!!a.matches?.('details.chat-arch>summary'),action=inside&&!act&&!summary?a.dataset?.action:undefined;
 const arch=el.querySelector?.('details.chat-arch')?.open;
 setHtml(el,safe);el.chatHtml=safe.html;
 if(arch){const d=el.querySelector('details.chat-arch');if(d)d.open=true;}
 const n=!inside?null:act?[...el.querySelectorAll('[data-chat-act]')].find(x=>x.dataset.chatAct===act&&x.dataset.key===key)
  :summary?el.querySelector('details.chat-arch>summary'):action?[...el.querySelectorAll('[data-action]')].find(x=>x.dataset.action===action):null;
 n?.focus?.({preventScroll:true});
 return true;
}
function unreadDot(c){if(!c?.id)return false;const read=readMap()[c.id];return signedIn()?(c.n>0):(read!==undefined?(c.known||0)>read:false);}
function paintTabs(v){
 const keys=S.lobby,hid='chat-v'+v.id;
 if(!keys.length){swap(v.tabs,h``);return;}
 swap(v.tabs,h`${keys.map(k=>{const c=S.channels.get(k),on=k===v.key,dot=!on&&unreadDot(c);return h`<button type="button" role="tab" class="${v.compact?'chat-chip':'chat-tab'}" id="${hid}-tab-${k}" aria-selected="${on}" aria-controls="${hid}-panel" tabindex="${on?0:-1}" data-chat-act="tab" data-key="${k}" title="${chFull(c)}">${chIcon(c)}<span class="chat-tab-text"><b>${chName(c)}</b><small>${chScope(c)}</small></span>${dot?h`<i class="chat-dot" aria-hidden="true"></i><span class="sr-only">${T('Nowe od ostatniej wizyty')}</span>`:''}</button>`;})}`);
 v.el.querySelector('.chat-panel')?.setAttribute('aria-labelledby',hid+'-tab-'+v.key);
}
function railItem(v,k){
 const c=S.channels.get(k);if(!c)return '';const on=k===v.key,muted=mutedChannels().has(c.id),n=signedIn()&&!on?c.n:0;
 return h`<a class="chat-rail-item${on?' is-on':''}" href="${registry.routeHash('chat',routeOf(c))}" data-chat-act="open" data-key="${k}"${on?h` aria-current="page"`:''}>${chIcon(c)}<span class="chat-grow"><b>${chName(c)}</b><small>${c.kind==='lobby'?chScope(c):chAbout(c)}</small></span>${muted?h`<i class="chat-mdot" title="${T('Wyciszony')}"></i>`:n?h`<span class="chat-ub">${registry.badgeText(n)}<span class="sr-only"> ${T('{n} nieprzeczytanych',{n})}</span></span>`:unreadDot(c)&&!signedIn()&&!on?h`<i class="chat-dot" aria-hidden="true"></i>`:''}</a>`;
}
function paintRail(v){
 const tours=S.tours,arch=S.archive;
 swap(v.rail,h`<div class="chat-rail-sec"><h3>${T('Kanały')}</h3>${S.lobby.map(k=>railItem(v,k))}</div>${tours.length?h`<div class="chat-rail-sec"><h3>${T('Czaty turniejów')}</h3>${tours.map(k=>railItem(v,k))}</div>`:''}${arch.length?h`<details class="chat-rail-sec chat-arch"${arch.includes(v.key)?h` open`:''}><summary>${icon('archive')}<span>${T('Archiwum · {n} zakończone',{n:arch.length})}</span></summary>${arch.map(k=>railItem(v,k))}</details>`:''}`);
}
function paintChips(v){
 const keys=[...S.lobby,...S.tours];if(v.key&&!keys.includes(v.key))keys.push(v.key);
 if(!swap(v.chips,h`${keys.map(k=>{const c=S.channels.get(k),on=k===v.key;return h`<a role="listitem" class="chat-chip${on?' is-on':''}" href="${registry.routeHash('chat',routeOf(c))}" data-chat-act="open" data-key="${k}"${on?h` aria-current="page"`:''}>${chIcon(c)}<span>${c.kind==='lobby'?h`${chName(c)} <small>${chScope(c)}</small>`:chName(c)}</span>${!on&&signedIn()&&c.n?h`<span class="chat-ub">${registry.badgeText(c.n)}</span>`:''}</a>`;})}`))return;
 v.chips.querySelector('.is-on')?.scrollIntoView?.({block:'nearest',inline:'nearest'});
}
function paintConvHead(v,c){
 const muted=c?.id&&mutedChannels().has(c.id),bell=signedIn()&&c?.id&&v.kind==='page';
 const back=v.kind==='page'?(signedIn()?h`<button type="button" class="chat-icon-btn chat-back" data-action="menu" aria-label="${T('Otwórz menu')}">${icon('menu')}</button>`:h`<button type="button" class="chat-icon-btn chat-back" data-chat-act="home" aria-label="${T('Wstecz')}">${icon('left')}</button>`):'';
 const chip=c?.kind==='tournament'&&c.date===today()?h`<span class="chat-today">${T('Dziś zawody')}</span>`:'';
 swap(v.convhead,h`${back}${c?chIcon(c):''}<div class="chat-grow"><h2 class="chat-conv-title">${v.kind==='tournament'?T('Czat turnieju'):chFull(c)||T('Czat')}</h2><p><span class="chat-conv-sub">${v.kind==='tournament'?chName(c):chAbout(c)}</span>${chip}</p></div>${live()}${bell?h`<button type="button" class="chat-icon-btn${muted?' is-muted':''}" data-chat-act="mute" aria-pressed="${!!muted}" title="${muted?T('Powiadomienia: wyciszone'):T('Powiadomienia: włączone')}" aria-label="${muted?T('Powiadomienia: wyciszone'):T('Powiadomienia: włączone')}">${icon('bell')}</button>`:''}`);
 v.liveEl=v.convhead.querySelector('[data-chat-part="live"]');if(v.liveEl)v.liveEl.hidden=S.status!=='live';
}
function banner(kind,text,ico,extra=''){return h`<div class="chat-banner ${kind}" role="${kind==='error'?'alert':'status'}">${icon(ico)}<span>${text}</span>${extra}</div>`;}
function paintBanners(v,c){
 const list=[],me=getMe();
 if(S.unavailable)list.push(banner('archive',T('Funkcje społecznościowe są chwilowo niedostępne.'),'info'));
 else if(S.outdated)list.push(banner('archive',T('Nie udało się wczytać czatu.'),'alert'));
 else if(S.cfg.on===false||S.status==='off')list.push(banner('off',T('Czat jest chwilowo wyłączony. Spróbuj później.'),'pause'));
 else if(S.status==='offline'||globalThis.navigator?.onLine===false)list.push(banner('offline',T('Brak połączenia. Nowe wiadomości pojawią się po powrocie sieci.'),'alert'));
 else if(S.status==='reconnecting')list.push(banner('reconnect',T('Łączenie ponownie…'),'refresh'));
 else if(S.listsError&&!S.listsAt)list.push(banner('error',T('Nie udało się wczytać czatu.'),'alert',h`<button type="button" class="chat-banner-btn" data-chat-act="retry">${T('Spróbuj ponownie')}</button>`));
 if(S.cfg.notice)list.push(banner('notice',S.cfg.notice,'info'));
 if(v.missing||c?.gone)list.push(banner('archive',v.kind==='page'&&ui().getState?.()?.tournament?.status==='draft'&&registry.parseRoute(location.hash).page==='event-chat'?T('Czat turnieju będzie dostępny po otwarciu zapisów.'):T('Ten czat nie jest już dostępny.'),'archive'));
 else if(c?.st==='archive')list.push(banner('archive',T('Turniej zakończył się {date}. Czat jest tylko do odczytu.',{date:fmtDate(c.date)}),'archive'));
 else if(c?.st==='closed')list.push(banner('archive',T('Ten czat jest tylko do odczytu.'),'lock'));
 if(me?.access?.block==='muted'&&c&&c.st==='open'){const until=me.access.mutedUntil;list.push(banner('muted',until?T('Moderator wstrzymał Twoje pisanie do {time}.',{time:new Date(until*1000).toLocaleString(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}):T('Moderator wstrzymał Twoje pisanie bezterminowo.'),'shield'));}
 if(v.compact)list.length=Math.min(list.length,1);
 swap(v.banners,h`${list}`);
}

// Message list: keyed reconciliation, so appending keeps focus, images and scroll.
function itemKey(v,it){
 if(it.kind!=='msg')return it.key;
 const m=it.m,p=m.a?S.people.get(m.a):null,hidden=m.a&&!S.revealed.has(m.id)&&hiddenPeople().has(m.a);
 return 'm:'+(m.pending?'p'+m.cid+':'+m.state:m.id+':'+m.r)+':'+(it.group?1:0)+':'+(p?(p.n||'')+(p.av||'')+(p.inactive?'i':''):'')+':'+(S.reported.has(m.id)?'r':'')+(hidden?'h':'')+':'+getLanguage()+':'+(full()?'f':'g')+(isAdmin()?'a':'');
}
function paintLog(v,c,opening,others){
 const log=v.log;if(!log)return;
 if(!c||v.missing||c.gone){if(!log.querySelector('.chat-empty')){log.replaceChildren();v.nodes.clear();}log.setAttribute('aria-busy','false');if(!c&&!v.missing&&!S.listsError)skeleton(v);return;}
 if(!c.loaded){skeleton(v);return;}
 log.setAttribute('aria-busy','false');
 let msgs=sorted(c);for(const p of S.pending.values())if(p.key===c.key)msgs.push(p.m);
 if(v.kind==='home'&&v.compact)msgs=msgs.slice(-PREVIEW);
 if(v.divider===undefined){
  const read=readMap()[c.id],me=myPid();v.divider=null;
  if(signedIn()&&read!==undefined)v.divider=msgs.find(m=>!m.pending&&m.id>read&&!m.x&&m.a!==me)?.id??null;
  if(v.divider!=null)v.pinned=false;
  opening=true;
 }
 const items=layout(msgs.map(m=>m.a&&!S.revealed.has(m.id)&&hiddenPeople().has(m.a)?{...m,hidden:true}:m),{divider:v.divider,own:myPid()});
 const before=anchor(v);
 const keep=new Map(),order=[];
 if(!(v.kind==='home'&&v.compact)){const key='top:'+(c.older?'more':'start')+(c.loadingOlder?'l':'')+getLanguage()+chName(c);order.push([key,()=>topItem(v,c)]);}
 if(!msgs.length)order.push(['empty:'+getLanguage()+(signedIn()?'m':'g'),()=>emptyItem(c)]);
 for(const it of items){const key=itemKey(v,it);order.push([key,()=>it.kind==='day'?dayItem(it):it.kind==='new'?newItem():messageItem(v,c,it)]);}
 let prev=null;
 for(const [key,build] of order){
  let node=v.nodes.get(key);if(!node){node=build();node.dataset.chatKey=key;}
  keep.set(key,node);
  const want=prev?prev.nextSibling:log.firstChild;if(want!==node)log.insertBefore(node,want);prev=node;
 }
 for(const [key,node] of v.nodes)if(!keep.has(key))node.remove();
 for(const node of [...log.children])if(!keep.has(node.dataset.chatKey))node.remove();
 v.nodes=keep;
 // Scroll: opening goes to the "Nowe" divider (or the bottom), pinned views follow new messages, others keep their anchor.
 const saved=opening?S.scroll.get(v.kind+':'+c.key):null;
 if(opening&&saved&&!saved.pinned&&restoreAnchor(v,saved)){v.pinned=false;}
 else if(opening&&v.divider!=null){const el=log.querySelector('.chat-new-div');if(el)log.scrollTop=Math.max(0,el.offsetTop-24);v.pinned=nearBottom(log);}
 else if(v.pinned||opening){log.scrollTop=log.scrollHeight;v.pinned=true;v.unseen=0;}
 else{restoreAnchor(v,before);if(others>0){v.unseen+=others;v.firstUnseen??=msgs.find(m=>m.id>(v.lastSeenId||0)&&m.a!==myPid())?.id??null;}}
 if(v.pinned)v.lastSeenId=lastId(c);
 pill(v);scheduleRead(v,c);
 if(others>0&&v.kind!=='strip')announceSr(v,c,others);
 if(c.older&&v.kind!=='home')observeTop(v);
}
function skeleton(v){if(v.log.querySelector('.chat-skeleton'))return;v.nodes.clear();setHtml(v.log,h`<div class="chat-skeleton" aria-hidden="true">${[1,2,3,4].map(()=>h`<div><i></i><span></span></div>`)}</div><p class="sr-only">${T('Wczytywanie wiadomości…')}</p>`);v.log.setAttribute('aria-busy','true');}
const nearBottom=log=>log.scrollHeight-log.scrollTop-log.clientHeight<120;
function anchor(v){
 const log=v.log;if(v.pinned||!log)return null;
 for(const el of log.querySelectorAll('.chat-msg[data-id]'))if(el.offsetTop+el.offsetHeight>log.scrollTop)return {id:el.dataset.id,offset:el.offsetTop-log.scrollTop};
 return null;
}
function restoreAnchor(v,a){if(!a)return false;const el=v.log.querySelector('.chat-msg[data-id="'+a.id+'"]');if(!el)return false;v.log.scrollTop=el.offsetTop-a.offset;return true;}
function saveScroll(v){if(v.key&&v.log)S.scroll.set(v.kind+':'+v.key,{pinned:v.pinned,...(anchor(v)||{})});}
function pill(v){
 if(!v.pillBtn)return;const show=!v.pinned&&v.unseen>0;v.pillBtn.hidden=!show;
 if(show)v.pillText.textContent=T('Nowe wiadomości: {n}',{n:v.unseen});
}
function el(tag,cls,text){const e=doc().createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function topItem(v,c){
 const box=el('div','chat-top');
 if(c.older){const b=el('button','chat-more',c.loadingOlder?T('Wczytywanie wiadomości…'):T('Wczytaj wcześniejsze'));b.type='button';b.dataset.chatAct='older';box.appendChild(b);}
 else box.appendChild(el('p','chat-start',T('To początek kanału {channel}.',{channel:chFull(c)})));
 return box;
}
function emptyItem(c){
 const box=el('div','chat-empty'),fig=el('div','chat-empty-ico');setHtml(fig,ui().mascot?ui().mascot('avatar','chat-empty-mascot'):h``);
 box.append(fig,el('strong',null,T('Zacznij rozmowę')),el('p',null,signedIn()&&full()?T('W kanale {channel} nikt jeszcze nie napisał. Przywitaj się!',{channel:chFull(c)}):T('W kanale {channel} nikt jeszcze nie napisał. Załóż konto i napisz pierwszy.',{channel:chFull(c)})));
 return box;
}
function dayItem(it){const d=el('div','chat-day');d.setAttribute('role','separator');d.appendChild(el('span',null,dayLabel(it.t)));return d;}
function newItem(){const d=el('div','chat-new-div');d.setAttribute('role','separator');d.appendChild(el('span',null,T('Nowe')));return d;}
const initials=name=>String(name||'').trim().split(/\s+/).slice(0,2).map(p=>[...p][0]||'').join('').toUpperCase()||'?';
let regions=null;
const regionName=cc=>{try{regions=regions&&regions.lang===getLanguage()?regions:{lang:getLanguage(),dn:new Intl.DisplayNames([locale()],{type:'region'})};return regions.dn.of(cc)||cc;}catch{return cc;}};
const sportName=s=>{const x=SPORTS.find(([k])=>k===s);return x?T(x[1]):s;};
function avatarEl(m,p,size=36){
 const pid=m.a;
 if(m.g!=null&&!pid){const g=el('span','ghost-ava g'+((m.g??0)%5+1));g.setAttribute('aria-hidden','true');g.dataset.chatAct='ghost';return g;}
 if(!pid||!p||p.inactive){const s=el('span','chat-ava is-none');s.appendChild(el('span','chat-ini',p?.n?initials(p.n):'?'));s.setAttribute('aria-hidden','true');return s;}
 const b=el('button','chat-ava');b.type='button';b.dataset.chatAct='profile';b.dataset.pid=pid;b.setAttribute('aria-label',p.n||T('Uczestnik'));
 const ini=el('span','chat-ini',p.inactive?'?':initials(p.n));ini.setAttribute('aria-hidden','true');b.appendChild(ini);
 if(p.av&&!Demo){const img=el('img');img.alt='';img.width=size;img.height=size;img.loading='lazy';img.decoding='async';img.addEventListener('load',()=>b.classList.add('has-photo'),{once:true});img.addEventListener('error',()=>img.remove(),{once:true});b.appendChild(img);queueAvatar(img,Client.apiUrl({route:'avatar',id:pid,v:p.av,s:'64'}));}
 return b;
}
let avatarIo=null;
function queueAvatar(img,src){
 if(typeof IntersectionObserver!=='function'){avatars.add(img,src);return;}
 avatarIo??=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){avatarIo.unobserve(e.target);const s=e.target.dataset.src;delete e.target.dataset.src;if(s)avatars.add(e.target,s);}},{rootMargin:'200px'});
 img.dataset.src=src;queueMicrotask(()=>{if(img.isConnected)avatarIo.observe(img);});
}
function messageItem(v,c,{m,group}){
 const own=!!m.a&&m.a===myPid()||!!m.pending,p=m.a?S.people.get(m.a):null,ghost=m.g!=null&&!m.a,gone=!m.a&&!ghost&&!m.pending;
 const art=el('article','chat-msg'+(group?' cont':'')+(own?' own':'')+(m.x?' tomb':'')+(m.hidden?' is-hidden':''));
 if(!m.pending)art.dataset.id=m.id;art.tabIndex=-1;
 const name=m.pending?myName():ghost?T('Uczestnik ukryty dla gości'):gone?T('Konto usunięte'):p?.inactive?T('Konto nieaktywne'):(p?.n||T('Uczestnik'));
 const when=new Date(m.t);art.setAttribute('aria-label',name+' · '+timeLabel(m.t));
 if(m.hidden){
  art.append(el('span','chat-ava-space'));const row=el('div','chat-hidden-row');row.append(el('span',null,T('Ukryta wiadomość od wyciszonej osoby')+' · '));
  const b=el('button','chat-linkbtn',T('Pokaż'));b.type='button';b.dataset.chatAct='reveal';b.dataset.id=m.id;row.appendChild(b);art.appendChild(row);return art;
 }
 art.appendChild(m.pending?avatarEl({a:myPid()},myEntry()):avatarEl(m,p));
 const meta=el('div','chat-meta');
 if(!ghost){
  const card=!m.pending&&p&&!p.inactive,nb=el(card?'button':'span','chat-name',name);if(card){nb.type='button';nb.dataset.chatAct='profile';nb.dataset.pid=m.a;}meta.appendChild(nb);
  const who=m.pending?myEntry():p;
  if(who?.cc){const cc=el('span','chat-cc',who.cc);cc.title=regionName(who.cc);cc.setAttribute('aria-hidden','true');meta.append(cc,el('span','sr-only',regionName(who.cc)));}
  if(who?.sp?.[0]){const s=who.sp[0];meta.appendChild(el('span','chat-sport'+(s==='karate'?' karate':s==='taekwondo'?'':' other'),sportName(s)));}
  if(who?.mod)meta.appendChild(el('span','chat-mod',T('Moderator')));
  if(m.o)meta.appendChild(el('span','chat-org',T('Organizator')));
  if(own)meta.appendChild(el('span','chat-you',T('Ty')));
 }else{
  const bar=el('span','ghost-name w'+((m.g??0)%3+1));bar.setAttribute('aria-hidden','true');meta.append(bar,el('span','sr-only',T('Uczestnik ukryty dla gości')));
 }
 const time=el('time','chat-time',timeLabel(m.t));time.dateTime=when.toISOString();time.title=when.toLocaleString(locale(),{dateStyle:'full',timeStyle:'short'});time.dataset.ts=m.t;meta.appendChild(time);
 art.appendChild(meta);
 if(m.x){
  const tomb=el('div','chat-tomb');setHtml(tomb,h`${icon(m.x==='mod'?'shield':m.x==='review'?'eye':'close')}`);
  tomb.appendChild(el('span',null,m.x==='mod'?T('Wiadomość usunięta przez moderatora'):m.x==='review'?T('Wiadomość ukryta do czasu sprawdzenia'):T('Wiadomość usunięta')));art.appendChild(tomb);return art;
 }
 const body=el('div','chat-text');body.appendChild(textNodes(doc(),m.b,{links:signedIn()&&full()}));art.appendChild(body);
 if(m.pending){
  const st=el('div','chat-state'+(m.state==='failed'?' is-failed':''));
  if(m.state==='failed'){st.setAttribute('role','alert');st.appendChild(el('span',null,T('Nie wysłano.')+' '));const r=el('button','chat-linkbtn',T('Ponów'));r.type='button';r.dataset.chatAct='retry-send';r.dataset.cid=m.cid;const d=el('button','chat-linkbtn',T('Usuń'));d.type='button';d.dataset.chatAct='drop-send';d.dataset.cid=m.cid;st.append(r,el('span',null,' · '),d);}
  else st.textContent=m.state==='queued'?T('Wyślemy po odzyskaniu połączenia'):T('Wysyłanie…');
  art.appendChild(st);return art;
 }
 if(S.reported.has(m.id))art.appendChild(el('div','chat-state',T('Zgłoszono')));
 if(signedIn()&&full()){
  const bar=el('div','chat-actions');
  if(!own){const r=el('button');r.type='button';r.dataset.chatAct='report';r.dataset.id=m.id;r.title=T('Zgłoś');r.setAttribute('aria-label',T('Zgłoś wiadomość'));setHtml(r,h`${icon('flag')}`);bar.appendChild(r);}
  const more=el('button');more.type='button';more.dataset.chatAct='more';more.dataset.id=m.id;more.title=T('Więcej działań');more.setAttribute('aria-label',T('Więcej działań'));more.setAttribute('aria-haspopup','menu');setHtml(more,h`${icon('more')}`);bar.appendChild(more);
  art.appendChild(bar);
 }
 return art;
}
function myEntry(){const p=getMe()?.profile;if(!p)return null;const last=String(p.lastName||'').trim();return {n:(String(p.firstName||'').trim()+' '+(p.nameDisplay==='full'?last:last?[...last][0].toUpperCase()+'.':'')).trim(),u:p.username,cc:p.country,sp:p.sports||[],av:p.avatar||null,mod:ws()?.user?.role==='admin'};}
const myName=()=>myEntry()?.n||T('Ty');
function announceSr(v,c,n){
 const focusIn=v.el.contains(doc().activeElement);if(!focusIn&&v.kind!=='page')return;
 v.srN+=n;const now=Date.now(),flush=()=>{v.srTimer=null;if(!v.srN||!v.sr)return;v.sr.textContent=T('Nowe wiadomości w kanale {channel}: {n}',{channel:chFull(c),n:v.srN});v.srN=0;v.srAt=Date.now();};
 if(now-v.srAt>=SR_MS)flush();else if(!v.srTimer)v.srTimer=setTimeout(flush,SR_MS-(now-v.srAt));
}
function scheduleRead(v,c){
 clearTimeout(v.readTimer);if(!c?.id||!c.loaded)return;
 if(!v.pinned||doc().visibilityState==='hidden'||(v.kind==='home'&&!v.visible))return;
 v.readTimer=setTimeout(()=>{if(!v.pinned||doc().visibilityState==='hidden')return;const last=lastId(c);if(setRead(c.id,last)){c.n=0;counted(c,last,last);counters();announce();for(const x of liveViews())if(x!==v&&x.kind!=='strip'){if(x.tabs)paintTabs(x);if(x.rail)paintRail(x);}else if(x.kind==='strip')paintStrip(x);}},READ_MS);
}
const tops=new WeakMap();
function observeTop(v){
 if(typeof IntersectionObserver!=='function')return;const btn=v.log.querySelector('.chat-more');if(!btn||tops.get(v.log)===btn)return;
 tops.set(v.log,btn);const io=new IntersectionObserver(e=>{if(e.some(x=>x.isIntersecting)&&!v.pinned){io.disconnect();older(v);}},{root:v.log});io.observe(btn);
}
async function older(v){
 const c=S.channels.get(v.key);if(!c?.id||!c.older||c.loadingOlder)return;
 const first=sorted(c)[0];if(!first)return;
 c.loadingOlder=true;v.pinned=false;paint(v);
 try{const e=await S.transport.history(c.id,first.id);if(e?.st==='gone'){c.gone=true;}else{for(const m of e?.m||[])upsert(c,m);c.older=!!e?.older;}}
 catch{toast(T('Nie udało się wczytać czatu.'));}
 finally{c.loadingOlder=false;for(const x of liveViews())if(x.key===c.key)paint(x);}
}
function paintFoot(v,c){
 const box=v.footEl;if(!box)return;
 const me=getMe(),config=S.config,kind=v.kind==='home'&&v.compact?'preview':v.missing||!c||c.gone?'none':footKind({signedIn:signedIn(),me,config,st:c.st,on:S.cfg.on!==false&&S.status!=='off'});
 const sig=kind+':'+v.key+':'+getLanguage()+':'+(config?1:0)+(kind==='preview'?':'+(config?.signup?1:0):'');
 if(v.foot===sig)return;
 const ta=saveDraft(v),caret=ta&&doc().activeElement===ta?{key:ta.dataset.chatKey,start:ta.selectionStart,end:ta.selectionEnd}:null;
 v.foot=sig;
 const price=priceText(config?.amounts);
 const loginBtn=h`<button type="button" class="btn secondary" data-action="${doc().querySelector('#login-form')?'login-jump':'guest-login'}">${T('Zaloguj się')}</button>`;
 const signupBtn=h`<a class="btn primary" href="#signup">${T('Załóż konto')}</a>`;
 const gate=(ico,title,text,actions,note='')=>h`<div class="chat-gate"><div class="chat-gate-row"><span class="chat-gate-ico" aria-hidden="true">${icon(ico)}</span><div class="chat-gate-copy"><strong>${title}</strong><span>${text}</span></div><div class="chat-gate-actions">${actions}</div></div>${note?h`<p class="chat-gate-price">${note}</p>`:''}</div>`;
 const navBtn=(label,page,tab)=>h`<button type="button" class="btn primary" data-chat-act="nav" data-chat-page="${page}"${tab?h` data-tab="${tab}"`:''}>${label}</button>`;
 let html=h``;
 if(kind==='preview')html=h`<div class="chat-preview-foot"><a class="btn primary chat-open" href="${registry.routeHash('chat',routeOf(c))}">${icon('chat')}<span>${T('Otwórz czat')}</span></a>${config?.signup&&config?.billing&&price?h`<p>${T('Pisanie po założeniu konta · {price} / mies.',{price})}</p>`:''}</div>`;
 else if(kind==='login')html=gate('lock',T('Dołącz do rozmowy'),T('Zaloguj się, aby pisać.'),loginBtn);
 else if(kind==='paid')html=gate('lock',T('Dołącz do rozmowy'),T('Załóż konto, aby pisać i widzieć, kto rozmawia.'),h`${signupBtn}${loginBtn}`,price?T('{price} / mies. · anulujesz w dowolnym momencie',{price}):'');
 else if(kind==='free')html=gate('lock',T('Dołącz do rozmowy'),T('Załóż konto, aby pisać i widzieć, kto rozmawia.'),h`${signupBtn}${loginBtn}`);
 else if(kind==='activate')html=gate('sparkle',T('Aktywuj konto, aby pisać'),T('Zobaczysz też, kto rozmawia.'),navBtn(T('Aktywuj'),'billing'));
 else if(kind==='profile')html=gate('user',T('Uzupełnij profil, aby pisać na czacie.'),T('Imię, nazwa użytkownika, kraj i sport wystarczą.'),navBtn(T('Uzupełnij profil'),'profile'));
 else if(kind==='password')html=gate('lock',T('Najpierw zmień hasło tymczasowe.'),T('Potem możesz pisać na czacie.'),navBtn(T('Zmień hasło'),'profile','security'));
 else if(kind==='composer')html=composer(v,c);
 setHtml(box,html);
 if(kind==='composer'){const t=box.querySelector('textarea');t.value=session.get(draftKey(v.key))||'';grow(t);count(v,t);limitNote(v);if(caret?.key===v.key){t.focus();try{t.setSelectionRange(caret.start,caret.end);}catch{}}}
}
/** Saves the composer text under the channel it was built for (data-chat-key) before the composer or the frame is rebuilt. */
function saveDraft(v){const ta=v.footEl?.querySelector?.('textarea[data-chat-key]');if(!ta)return null;clearTimeout(ta.saveTimer);session.set(draftKey(ta.dataset.chatKey),ta.value);return ta;}
function composer(v,c){
 const id='chat-in-'+v.id,name=chFull(c);
 return h`<form class="chat-composer" id="chat-form-${v.id}" data-chat-form="${v.id}" novalidate><p class="chat-note" data-chat-part="note" role="status"></p><div class="chat-input"><label class="sr-only" for="${id}">${T('Wiadomość do kanału {channel}',{channel:name})}</label><textarea id="${id}" class="chat-textarea" rows="1" maxlength="1000" autocomplete="off" placeholder="${T('Napisz w kanale {channel}…',{channel:name})}" data-chat-input="${v.id}" data-chat-key="${v.key}"></textarea><button type="submit" class="chat-send" aria-label="${T('Wyślij')}" title="${T('Wyślij')}">${icon('send')}<span class="chat-cd" data-chat-part="cd"></span></button></div><div class="chat-hint"><span class="chat-keys">${T('Enter — wyślij · Shift+Enter — nowa linia')}</span><span class="chat-privacy">${T('Nie publikuj danych dzieci ani numerów telefonów.')}</span><span class="chat-count" data-chat-part="count" hidden></span></div></form>`;
}
function grow(t){if(!t)return;t.style.height='auto';const line=parseFloat(getComputedStyle(t).lineHeight)||20;t.style.height=Math.min(t.scrollHeight,line*6+14)+'px';}
function count(v,t){
 const n=[...t.value].length,box=v.footEl?.querySelector('[data-chat-part="count"]'),btn=v.footEl?.querySelector('.chat-send');
 if(btn)btn.setAttribute('aria-disabled',String(!t.value.trim()||Date.now()<S.limitUntil));
 if(!box)return;box.hidden=n<800;box.textContent=n+' / 1000';box.classList.toggle('is-warn',n>=950);
 const said=v.saidAt||0,mark=n>=1000?1000:n>=900?900:0;
 if(mark&&mark!==said&&v.sr){v.sr.textContent=mark===1000?T('Osiągnięto limit 1000 znaków'):T('Zostało {n} znaków',{n:1000-n});}
 v.saidAt=mark;
}
function limitNote(v){
 const note=v.footEl?.querySelector('[data-chat-part="note"]'),cd=v.footEl?.querySelector('[data-chat-part="cd"]');if(!note)return;
 const left=Math.ceil((S.limitUntil-Date.now())/1000);
 if(left>0){note.textContent=T('Zwolnij trochę — kolejna wiadomość za {s} s.',{s:left});note.className='chat-note is-limit';if(cd)cd.textContent=String(left);}
 else if(note.classList.contains('is-limit')){note.textContent='';note.className='chat-note';if(cd)cd.textContent='';}
}
function paintStrip(v){
 const c=S.channels.get(v.key);if(!c||c.gone||local.get(STRIP)==='off'){if(v.el.firstChild)v.el.replaceChildren();return;}
 if(!v.el.firstChild)setHtml(v.el,h`<div class="chat-strip"></div>`);const box=v.el.firstChild;
 const last=sorted(c).filter(m=>!m.x).at(-1),n=c.loaded?Math.min(99,sorted(c).filter(m=>m.id>(readMap()[c.id]||0)&&!m.x&&m.a!==myPid()).length):c.n;
 setHtml(box,h`<span class="chat-strip-ico" aria-hidden="true">${icon('chat')}</span><span class="chat-strip-text"><b>${T('Na czacie')}</b> · ${chFull(c)}${last?h` — <q></q>`:''}</span>${n?h`<span class="chat-strip-new">${T('Nowe: {n}',{n})}</span>`:''}<button type="button" class="btn primary chat-strip-open" data-chat-act="nav" data-chat-page="chat" data-c="${c.slug||''}">${T('Otwórz czat')}</button><button type="button" class="chat-icon-btn" data-chat-act="strip-off" aria-label="${T('Ukryj na tej stronie')}" title="${T('Ukryj na tej stronie')}">${icon('close')}</button>`);
 const q=box.querySelector('q');if(q&&last)q.textContent=[...last.b].slice(0,90).join('')+([...last.b].length>90?'…':'');
}

// ——— Counters outside the chat ———

const relevantTours=()=>{const ids=new Set((ws()?.tournaments||[]).filter(t=>(t.entries||[]).length).map(t=>t.id)),read=readMap();return S.tours.map(k=>S.channels.get(k)).filter(c=>c?.id&&(ids.has(c.tid)||read[c.id]!==undefined));};
function counters(){
 const d=doc();if(!d)return;
 if(signedIn()){
  const muted=mutedChannels(),open=new Set(liveViews().filter(v=>v.kind!=='strip').map(v=>v.key));
  const total=[...S.lobby.map(k=>S.channels.get(k)),...relevantTours()].filter(c=>c&&!muted.has(c.id)&&!open.has(c.key)).reduce((s,c)=>s+(c.n||0),0);
  registry.setBadge('chat',total);
  const tid=ui().getState?.()?.tournament?.id,tc=tid&&S.channels.get(keyOfTid(tid));registry.setBadge('event-chat',tc&&!muted.has(tc.id)&&!open.has(tc.key)?tc.n:0);
 }
 for(const span of d.querySelectorAll('[data-chat-count]')){
  const c=S.channels.get(keyOfTid(span.dataset.chatCount)),n=c?.count||0;
  if(!n){span.replaceChildren();continue;}
  const vis=el('span',null,T('czat · {n}',{n}));vis.setAttribute('aria-hidden','true');span.replaceChildren(vis,el('span','sr-only',T('Czat turnieju: {n} wiadomości',{n})));
 }
 // The tab label keeps its text; the count is drawn from data-n by chat.css (the home-embed tests read the label as text).
 for(const span of d.querySelectorAll('[data-chat-tab-count]')){const c=S.channels.get(keyOfTid(span.dataset.chatTabCount));if(c?.count)span.dataset.n=String(c.count);else delete span.dataset.n;}
 for(const slot of d.querySelectorAll('[data-chat-tournament-link]')){
  const tid=slot.dataset.chatTournamentLink,key=keyOfTid(tid),c=key&&S.channels.get(key);
  if(!c||c.gone){slot.replaceChildren();continue;}
  const n=signedIn()&&!mutedChannels().has(c.id)?c.n:0,sig=tid+':'+n+':'+getLanguage();if(slot.dataset.sig===sig&&slot.firstChild)continue;slot.dataset.sig=sig;
  setHtml(slot,h`<a class="chat-tlink" href="${registry.routeHash('chat',{t:tid})}" data-chat-act="nav" data-chat-page="chat" data-t="${tid}">${icon('chat')}<span>${T('Czat')}${n?' · '+T('Nowe: {n}',{n}):''}</span></a>`);
 }
}

// ——— Sending ———

async function send(v,text){
 const c=S.channels.get(v.key);if(!c)return;
 const body=String(text).replace(/\r\n?/g,'\n').trim();
 if(!body){note(v,T('Wiadomość jest pusta.'));return false;}
 if([...body].length>1000){note(v,T('Wiadomość może mieć najwyżej 1000 znaków.'));return false;}
 if(Date.now()<S.limitUntil){limitNote(v);return false;}
 const cid=clientId(),m={pending:true,own:true,cid,id:Number.MAX_SAFE_INTEGER-S.pending.size,t:Date.now(),a:myPid(),b:body,state:'sending'};
 const entry={key:c.key,m,payload:c.id?{ch:Number(c.id),cid,b:body}:{t:c.tid,cid,b:body}};
 if(globalThis.navigator?.onLine===false){
  if(S.queued){note(v,T('Wyślemy po odzyskaniu połączenia'));return false;}
  m.state='queued';S.queued=cid;S.pending.set(cid,entry);paintKey(c.key);return true;
 }
 S.pending.set(cid,entry);v.pinned=true;paintKey(c.key);
 deliver(entry,v);return true;
}
async function deliver(entry,v){
 const {m}=entry,c=S.channels.get(entry.key);m.state='sending';paintKey(entry.key);
 try{
  const r=await S.transport.send(entry.payload);
  S.pending.delete(m.cid);if(S.queued===m.cid)S.queued=null;
  for(const [pid,p] of Object.entries(r?.people||{}))S.people.set(pid,p);
  if(c&&r?.m)upsert(c,r.m);
  if(c?.virtual)ensureLists(true);
  S.lastSend=Date.now();registry.emit('chat:sent',{channel:c?.slug||c?.tid||entry.key});
  paintKey(entry.key);S.transport.poke();setTimeout(()=>S.transport?.poke(),1000);
 }catch(error){
  const status=error?.status;
  if(!status||status>=500){if(globalThis.navigator?.onLine===false&&!S.queued){m.state='queued';S.queued=m.cid;}else m.state='failed';paintKey(entry.key);return;}
  S.pending.delete(m.cid);if(S.queued===m.cid)S.queued=null;
  // The draft is never lost: the text goes back into an empty composer.
  const t=v?.footEl?.querySelector('textarea');if(t&&!t.value){t.value=m.b;grow(t);session.set(draftKey(entry.key),t.value);}
  if(status===429){S.limitUntil=Date.now()+Math.max(1,Number(error.data?.retry)||2)*1000;tickLimit();}
  else if(status===401){ui().handleError?.(error);return;}
  else{if([402,403].includes(status))loadMe({force:true});note(v,translateMessage(error.message));}
  paintKey(entry.key);
 }
}
function tickLimit(){for(const v of liveViews())limitNote(v);if(Date.now()<S.limitUntil)setTimeout(tickLimit,500);else for(const v of liveViews()){const t=v.footEl?.querySelector('textarea');if(t)count(v,t);}}
function note(v,text){const n=v?.footEl?.querySelector('[data-chat-part="note"]');if(n){n.textContent=text;n.className='chat-note is-error';n.setAttribute('role','alert');}}
function paintKey(key){for(const v of liveViews())if(v.key===key)paint(v);}
function flushQueue(){if(!S.queued)return;const e=S.pending.get(S.queued);if(e)deliver(e,liveViews().find(v=>v.key===e.key));}
const toast=message=>ui().toast?.(message);

// ——— Actions ———

function findMessage(id){for(const c of S.channels.values()){const m=c.msgs.get(Number(id));if(m)return [c,m];}return [];}
function profileCard(trigger,pid){
 closePop();const p=S.people.get(pid);if(!p||p.inactive)return;
 const hidden=hiddenPeople().has(pid),own=pid===myPid();
 const since=p.since&&/^\d{4}-\d{2}$/.test(p.since)?new Date(p.since+'-15T12:00:00').toLocaleDateString(locale(),{month:'short',year:'numeric'}):'';
 const pop=el('div','chat-pop');pop.setAttribute('role','dialog');pop.setAttribute('aria-label',p.n||T('Uczestnik'));pop.tabIndex=-1;
 setHtml(pop,h`<div class="chat-pop-top"><span class="chat-ava chat-ava-lg"><span class="chat-ini" aria-hidden="true">${initials(p.n)}</span></span><div><b>${p.n||''}</b>${p.u?h`<small>@${p.u}</small>`:''}</div><button type="button" class="chat-icon-btn chat-pop-x" data-chat-act="pop-close" aria-label="${T('Zamknij')}">${icon('close')}</button></div><div class="chat-pop-rows">${p.cc?h`<div><span class="chat-cc" aria-hidden="true">${p.cc}</span><span>${regionName(p.cc)}</span></div>`:''}${p.sp?.length?h`<div>${icon('trophy')}<span>${p.sp.map(sportName).join(' · ')}</span></div>`:''}${p.club?h`<div>${icon('users')}<span>${p.club}</span></div>`:''}${since?h`<div>${icon('calendar')}<span>${T('W MatBravo od {date}',{date:since})}</span></div>`:''}${p.mod?h`<div>${icon('shield')}<span>${T('Moderator')}</span></div>`:''}</div>${own?'':h`<div class="chat-pop-acts"><button type="button" class="btn secondary" data-chat-act="hide-person" data-pid="${pid}">${hidden?T('Pokaż wiadomości'):T('Ukryj u mnie')}</button></div>`}`);
 showPop(trigger,pop);
 if(p.av&&!Demo){const ava=pop.querySelector('.chat-ava');const img=el('img');img.alt='';img.width=56;img.height=56;img.addEventListener('load',()=>ava.classList.add('has-photo'),{once:true});img.addEventListener('error',()=>img.remove(),{once:true});ava.appendChild(img);avatars.add(img,Client.apiUrl({route:'avatar',id:pid,v:p.av,s:'256'}));}
}
function ghostCard(trigger){
 closePop();const pop=el('div','chat-pop chat-pop-ghost');pop.setAttribute('role','dialog');pop.setAttribute('aria-label',T('Kto pisze? Zobaczysz po założeniu konta.'));pop.tabIndex=-1;
 const cfg=S.config;setHtml(pop,h`<p>${T('Kto pisze? Zobaczysz po założeniu konta.')}</p><div class="chat-pop-acts">${cfg?.signup?h`<a class="btn primary" href="#signup">${T('Załóż konto')}</a>`:''}${signedIn()?h`<button type="button" class="btn primary" data-chat-act="nav" data-chat-page="billing">${T('Aktywuj')}</button>`:h`<button type="button" class="btn secondary" data-action="${doc().querySelector('#login-form')?'login-jump':'guest-login'}">${T('Zaloguj się')}</button>`}<button type="button" class="btn secondary" data-chat-act="pop-close">${T('Zamknij')}</button></div>`);
 showPop(trigger,pop);
}
let popState=null;
function showPop(trigger,pop){
 const host=trigger.closest('.chat-card,.chat-full')||doc().body;host.appendChild(pop);
 const hr=host.getBoundingClientRect(),tr=trigger.getBoundingClientRect();
 pop.style.left=Math.max(8,Math.min(tr.left-hr.left,hr.width-pop.offsetWidth-8))+'px';
 const below=tr.bottom-hr.top+8;pop.style.top=(below+pop.offsetHeight>hr.height-8?Math.max(8,tr.top-hr.top-pop.offsetHeight-8):below)+'px';
 popState={pop,trigger};(pop.querySelector('button,a')||pop).focus();
}
function closePop(focus=false){if(!popState)return;const {pop,trigger}=popState;popState=null;pop.remove();if(focus&&trigger?.isConnected)trigger.focus();}
function moreMenu(trigger,id){
 closePop();const [,m]=findMessage(id);if(!m)return;
 const own=m.a===myPid(),pop=el('div','chat-pop chat-menu');pop.setAttribute('role','menu');pop.setAttribute('aria-label',T('Więcej działań'));
 const items=[['copy',T('Kopiuj tekst')]];if(!own)items.push(['report',T('Zgłoś')]);if(own||isAdmin())items.push(['delete',T('Usuń wiadomość')]);if(!own&&m.a)items.push(['hide-person',hiddenPeople().has(m.a)?T('Pokaż wiadomości'):T('Ukryj u mnie')]);
 setHtml(pop,h`${items.map(([act,label])=>h`<button type="button" role="menuitem" data-chat-act="${act}" data-id="${id}" data-pid="${m.a||''}">${label}</button>`)}`);
 showPop(trigger,pop);
}
function openReport(id){
 closePop();const reasons=[['spam',T('Spam lub reklama')],['abuse',T('Obraźliwe lub nienawistne treści')],['harassment',T('Nękanie')],['child_data',T('Dane osobowe lub wizerunek dziecka')],['other',T('Inne')]];
 ui().modal?.(T('Zgłoś wiadomość'),h`<form id="chat-report-form" data-id="${id}"><fieldset><legend>${T('Powód zgłoszenia')}</legend>${reasons.map(([k,label],i)=>h`<label class="radio-card chat-reason"><input type="radio" name="reason" value="${k}"${i===0?h` checked`:''}><strong>${label}</strong></label>`)}</fieldset><label class="field-label chat-report-comment">${T('Komentarz (opcjonalnie)')}<input name="comment" maxlength="300" autocomplete="off"></label><div class="form-error" role="alert"></div></form>`,
  h`<button type="button" class="btn secondary" data-action="close-modal">${T('Anuluj')}</button><button type="submit" class="btn primary" form="chat-report-form">${T('Wyślij zgłoszenie')}</button>`);
}
function confirmDelete(id){
 closePop();ui().modal?.(T('Usuń wiadomość'),h`<p>${T('Usunąć tę wiadomość? Tej operacji nie można cofnąć.')}</p><div class="form-error" role="alert"></div>`,h`<button type="button" class="btn secondary" data-action="close-modal">${T('Anuluj')}</button><button type="button" class="btn primary chat-danger" data-chat-act="delete-confirm" data-id="${id}">${T('Usuń')}</button>`);
}
const viewOf=node=>node?.closest?.('[data-chat-mount]')?.chatView||null;
async function act(name,node,event){
 const v=viewOf(node),id=node.dataset.id;
 if(name==='tab'||name==='open'){event.preventDefault();if(v){if(v.kind==='page'&&registry.parseRoute(location.hash).page==='event-chat'){const c=S.channels.get(node.dataset.key);ui().navigate?.('chat',routeOf(c));return;}open(v,node.dataset.key);if(name==='tab')v.el.querySelector('[aria-selected="true"]')?.focus();}}
 else if(name==='pill'&&v){const target=v.firstUnseen&&v.log.querySelector('.chat-msg[data-id="'+v.firstUnseen+'"]');if(target){v.log.scrollTop=target.offsetTop-12;target.focus({preventScroll:true});}else v.log.scrollTop=v.log.scrollHeight;v.unseen=0;v.firstUnseen=null;onScroll(v);}
 else if(name==='older'&&v)older(v);
 else if(name==='retry'){S.listsError=null;ensureLists(true);ensureConfig();}
 else if(name==='profile')profileCard(node,node.dataset.pid);
 else if(name==='ghost')ghostCard(node);
 else if(name==='pop-close')closePop(true);
 else if(name==='more')moreMenu(node,id);
 else if(name==='report')openReport(id);
 else if(name==='delete')confirmDelete(id);
 else if(name==='copy'){closePop(true);const [,m]=findMessage(id);try{await navigator.clipboard.writeText(m?.b||'');toast(T('Skopiowano do schowka.'));}catch{toast(T('Nie udało się skopiować.'));}}
 else if(name==='hide-person'){closePop(true);toggleIn('hidden',node.dataset.pid);for(const x of liveViews())paint(x);}
 else if(name==='reveal'){S.revealed.add(Number(id));for(const x of liveViews())paint(x);}
 else if(name==='delete-confirm'){node.disabled=true;try{await S.transport.remove(Number(id));ui().closeModal?.();S.transport.poke();}catch(error){node.disabled=false;const box=doc().querySelector('.modal .form-error');if(box)box.textContent=translateMessage(error.message);if(error?.status===401)ui().handleError?.(error);}}
 else if(name==='retry-send'){const e=S.pending.get(node.dataset.cid);if(e)deliver(e,v);}
 else if(name==='drop-send'){const e=S.pending.get(node.dataset.cid);if(e){S.pending.delete(node.dataset.cid);if(S.queued===node.dataset.cid)S.queued=null;const t=v?.footEl?.querySelector('textarea');if(t&&!t.value){t.value=e.m.b;grow(t);}paintKey(e.key);}}
 else if(name==='mute'&&v){const c=S.channels.get(v.key);if(c?.id){toggleIn('muted',c.id);paint(v);counters();}}
 else if(name==='nav'){event.preventDefault();const params={};if(node.dataset.tab)params.tab=node.dataset.tab;if(node.dataset.c)params.c=node.dataset.c;if(node.dataset.t)params.t=node.dataset.t;if(node.dataset.chatPage==='chat'){S.pageKey=params.t?keyOfTid(params.t):params.c?slugKey(params.c):S.pageKey;}ui().navigate?.(node.dataset.chatPage,Object.keys(params).length?params:undefined);}
 else if(name==='strip-off'){local.set(STRIP,'off');if(v){v.el.replaceChildren();S.views.delete(v);announce();}}
 else if(name==='home'){event.preventDefault();location.hash='';}
}
async function submitReport(form){
 const box=form.querySelector('.form-error'),btn=doc().querySelector('.modal [type="submit"]'),f=new FormData(form),id=Number(form.dataset.id);
 if(btn)btn.disabled=true;if(box)box.textContent='';
 try{const comment=String(f.get('comment')||'').trim();await S.transport.report(id,String(f.get('reason')||''),comment||undefined);S.reported.add(id);ui().closeModal?.();toast(T('Dziękujemy. Moderator sprawdzi zgłoszenie.'));for(const v of liveViews())paint(v);}
 catch(error){if(box)box.textContent=translateMessage(error.message);if(error?.status===401)ui().handleError?.(error);}
 finally{if(btn?.isConnected)btn.disabled=false;}
}
function onScroll(v){
 const was=v.pinned;v.pinned=nearBottom(v.log);
 if(v.pinned){v.unseen=0;v.firstUnseen=null;v.lastSeenId=lastId(S.channels.get(v.key)||{msgs:new Map()});}
 if(was!==v.pinned||v.pinned)pill(v);
 if(v.pinned)scheduleRead(v,S.channels.get(v.key));
 saveScroll(v);
}
const finePointer=()=>{try{return matchMedia('(pointer: fine)').matches;}catch{return true;}};
/** Document listeners shared by every view (installed once). */
function ensureGlobal(){
 if(ready)return;ready=true;const d=doc();
 d.addEventListener('click',event=>{
  const node=event.target.closest?.('[data-chat-act]');
  if(popState&&!event.target.closest?.('.chat-pop')&&node!==popState.trigger)closePop();
  if(node)act(node.dataset.chatAct,node,event).catch(()=>{});
 });
 d.addEventListener('submit',event=>{
  const form=event.target;
  if(form.id==='chat-report-form'){event.preventDefault();submitReport(form);return;}
  if(!form.dataset?.chatForm)return;event.preventDefault();
  const v=viewOf(form),t=form.querySelector('textarea');if(!v||!t)return;
  send(v,t.value).then(ok=>{if(ok){t.value='';session.set(draftKey(v.key),'');grow(t);count(v,t);const n=form.querySelector('[data-chat-part="note"]');if(n&&!n.classList.contains('is-limit')){n.textContent='';n.className='chat-note';}t.focus();}});
 });
 d.addEventListener('input',event=>{
  const t=event.target;if(!t.matches?.('textarea[data-chat-input]'))return;const v=viewOf(t);if(!v)return;
  grow(t);count(v,t);clearTimeout(t.saveTimer);t.saveTimer=setTimeout(()=>session.set(draftKey(t.dataset.chatKey||v.key),t.value),300);S.touchedAt=Date.now();S.transport?.interact();
 });
 d.addEventListener('focusout',event=>{const t=event.target;if(t.matches?.('textarea[data-chat-key]')){clearTimeout(t.saveTimer);session.set(draftKey(t.dataset.chatKey),t.value);}});
 d.addEventListener('keydown',event=>{
  const t=event.target;
  if(event.key==='Escape'&&popState){event.preventDefault();closePop(true);return;}
  if(t.matches?.('textarea[data-chat-input]')&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&finePointer()){event.preventDefault();t.form?.requestSubmit?.();return;}
  const tab=t.closest?.('.chat-tabs [role="tab"],.chat-chips[role="tablist"] [role="tab"]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&!event.altKey&&!event.ctrlKey&&!event.metaKey){
   const tabs=[...tab.parentElement.querySelectorAll('[role="tab"]')],i=tabs.indexOf(tab),next=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
   event.preventDefault();next.click();return;
  }
  const log=t.closest?.('.chat-log');
  if(log&&(event.key==='PageDown'||event.key==='PageUp')){
   const arts=[...log.querySelectorAll('.chat-msg')],cur=t.closest('.chat-msg'),i=cur?arts.indexOf(cur):(event.key==='PageDown'?-1:arts.length);
   const next=arts[Math.max(0,Math.min(arts.length-1,i+(event.key==='PageDown'?1:-1)))];if(next){event.preventDefault();next.focus();}
  }
 });
 // Scrolling itself is not interaction (new messages scroll the log); wheel, touch, keys and pointer are.
 d.addEventListener('scroll',event=>{const log=event.target;if(!log?.classList?.contains('chat-log'))return;const v=viewOf(log);if(v)onScroll(v);},true);
 const interact=event=>{if(event.target.closest?.('[data-chat-mount]')){S.touchedAt=Date.now();S.transport?.interact();}};
 // Engagement for the PWA install card (pwa.js counts 10 s ticks): the chat is on screen and was used within the last minute.
 setInterval(()=>{if(d.visibilityState!=='hidden'&&Date.now()-(S.touchedAt||0)<60000&&liveViews().some(v=>v.kind!=='strip'&&v.visible))registry.emit('chat:active',{});},10000);
 d.addEventListener('pointerdown',interact,{passive:true});d.addEventListener('keydown',interact);d.addEventListener('wheel',interact,{passive:true});d.addEventListener('touchmove',interact,{passive:true});d.addEventListener('focusin',interact);
 d.addEventListener('visibilitychange',()=>{for(const v of liveViews()){v.hiddenTab=d.visibilityState==='hidden';if(!v.hiddenTab)scheduleRead(v,S.channels.get(v.key));}announce();});
 globalThis.addEventListener?.('online',()=>{flushQueue();paintAll(false);});
 globalThis.addEventListener?.('offline',()=>paintAll(false));
 // A tournament chat shown before its channel exists is not polled: the lists are read again every minute until it appears.
 minuteTimer=setInterval(()=>{for(const time of d.querySelectorAll('.chat-time[data-ts]'))time.textContent=timeLabel(Number(time.dataset.ts));if(d.visibilityState!=='hidden'&&liveViews().some(v=>v.visible&&!v.hiddenTab&&S.channels.get(v.key)?.virtual))ensureLists(true);},60000);
 try{matchMedia('(max-width:650px)').addEventListener('change',()=>{for(const v of liveViews())if(v.kind==='home')paint(v);announce();});}catch{}
 onMe(me=>{baseline();
  // A signed-in view that picked its channel before me arrived picks again by sport and country (plan §5.1).
  if(me)for(const v of liveViews())if(v.auto&&(v.kind==='page'||v.kind==='strip')){v.auto=false;const before=v.key;v.key=null;choose(v);const k=v.key;v.key=before;if(k&&k!==before)open(v,k);}if(S.mode&&S.mode!==mode()){transport();paintAll(true);ensureLists(true);}else{for(const v of liveViews())paint(v);}counters();});
}

// ——— Entry points used by chat-boot.js ———

/** Mounts every chat view and fills every counter in the page after a paint (plan §8.3 'painted'). */
export function scan(root=doc()){
 if(!root)return;
 for(const node of root.querySelectorAll('[data-chat-mount]')){
  const kind=node.dataset.chatMount;
  if(kind==='home')mount(node,'home');
  else if(kind==='tournament')mount(node,'tournament',{tid:node.dataset.tournamentId});
  else if(kind==='strip'){if(local.get(STRIP)!=='off')mount(node,'strip');}
  else if(kind==='page'){const route=registry.parseRoute(location.hash),params=new URLSearchParams(route.params);if(node.dataset.tournament&&!params.get('t')&&!params.get('c'))params.set('t',node.dataset.tournament);mount(node,'page',{params});}
 }
 if(root.querySelector('[data-chat-count],[data-chat-tab-count],[data-chat-tournament-link]')||signedIn()){transport();ensureLists().then(counters);}
 counters();
}
/** Counters only (upcoming list repainted): refresh the lists when stale. */
export function fillCounts(){transport();ensureLists().then(counters);counters();}
/** Guest page #chat (registerPublicPage in chat-boot.js): the guest bar and the full chat. */
export function publicFrame(){
 return h`<div class="guest-shell chat-public"><header class="guest-bar"><div class="guest-bar-inner"><button type="button" class="brand guest-brand" data-action="guest-login" aria-label="${T('MatBravo — wróć do logowania')}"><picture><source media="(max-width:650px)" srcset="./brand/matbravo-mark-white.svg" width="84" height="62"><img class="brand-logo" src="./brand/matbravo-logo-white.svg" alt="MatBravo" width="525" height="74"></picture></button><span class="guest-pill">${icon('chat')}<span>${T('Czat MatBravo')}</span></span><div class="guest-bar-actions">${langSwitch()}<button type="button" class="btn guest-login" data-action="guest-login">${icon('lock')}<span>${T('Zaloguj się')}</span></button></div></div></header><main id="main" class="chat-public-main"><div class="chat-page-mount" data-chat-mount="page"></div></main></div>`;
}
registry.on('logout',()=>{purgeIdentity();});
registry.on('language',()=>{
 const pub=doc()?.querySelector('#app > .chat-public');
 if(pub&&!signedIn()){for(const v of liveViews())saveScroll(v);setHtml(doc().querySelector('#app'),publicFrame());scan();return;}
 for(const v of liveViews()){v.nodes.clear();paint(v);}counters();
});
registry.on('client-outdated',()=>{S.outdated=true;S.transport?.stop();});

/** Tests only: the module state. */
export const _state=()=>S;
export const _internals={apply,applyLists,ensureLists,wants,transport,unauthorized,banner,railItem};
