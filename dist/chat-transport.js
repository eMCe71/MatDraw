/* Chat poller (plan §5.4, research 02 §5.6 with the plan's changes). One poller per browser: every tab announces the channels it
 * shows on BroadcastChannel('matbravo-chat'); the tab holding the Web Lock 'matbravo-chat-poller' (the leader) polls the union and
 * broadcasts each answer. Without Web Locks or BroadcastChannel every tab polls alone with doubled intervals.
 * Intervals: idle time counts only from the user's own interaction (pointer, keys, scroll, focus in the composer), never from new
 * messages; after a new message the pace goes to ms[0] only when the user interacted within cfg.boost seconds, otherwise one level
 * faster and never below ms[1]. bg when no visible tab has the chat on screen (unread counters), paused when every tab is hidden or the
 * browser is offline, +-20% jitter on every delay. One request at a time, 10 s timeout, back-off with Retry-After on 429/503/508, and
 * a report e=<n>:<status> of hosting answers (429/503/508, 0 = not JSON or no answer) sent with the next request.
 * 401 on chat-feed: every tab purges identity and continues on the public route. 409 client_outdated: polling stops for good.
 * The scheduling, report, query and leader helpers are pure exports (tests/chat-client.test.mjs). */
import * as Client from './client.js';
import {emit} from './registry.js';

export const DEFAULT_CFG={on:true,t:'poll',ms:[2500,5000,10000,30000,60000],idle:[60,180,600,1800],bg:30000,boost:300,safety:60000,notice:null};
export const LIMITS={ch:6,h:30,timeout:10000,boostWindow:120000,retry:15,report:50,tabTtl:60000,beat:20000,minGap:400,history:30};
export const LOCK='matbravo-chat-poller',CHANNEL='matbravo-chat';
const HOSTING=[429,503,508];

/** cfg from the server merged over the defaults; invalid parts keep the defaults. */
export function normalizeCfg(cfg){
 const c={...DEFAULT_CFG,...(cfg&&typeof cfg==='object'?cfg:{})},list=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(x=>Number.isFinite(x)&&x>0);
 if(!list(c.ms,5))c.ms=DEFAULT_CFG.ms;if(!list(c.idle,4))c.idle=DEFAULT_CFG.idle;
 for(const k of ['bg','boost','safety'])if(!Number.isFinite(c[k])||c[k]<0)c[k]=DEFAULT_CFG[k];
 c.on=c.on!==false;c.notice=typeof c.notice==='string'&&c.notice?c.notice:null;return c;
}
/** Pace level 0-4 from seconds without interaction: <idle[0] -> 0, then one level per threshold passed. */
export function idleLevel(idleS,idle=DEFAULT_CFG.idle){let level=0;for(const t of idle)if(idleS>=t)level++;return Math.min(4,level);}
/**
 * Delay before the next poll in ms (before jitter), or null while paused.
 * s: {now, interactionAt, messageAt (last new message from others), visible (any tab), onScreen (a visible tab shows the chat),
 *     online, cfg, solo (no leader election: doubled), floor (minimum delay, e.g. the phone preview's 10 s)}.
 */
export function pollDelay(s){
 const cfg=s.cfg||DEFAULT_CFG;
 if(s.online===false||!s.visible)return null;
 let d;
 if(!cfg.on)d=cfg.ms[4];
 else if(!s.onScreen)d=cfg.bg;
 else{
  const idle=Math.max(0,(s.now-(s.interactionAt||0))/1000);let level=idleLevel(idle,cfg.idle);
  if(s.messageAt&&s.now-s.messageAt<LIMITS.boostWindow)level=idle<cfg.boost?0:Math.max(1,level-1);
  d=cfg.ms[level];
 }
 if(s.floor)d=Math.max(d,s.floor);
 return s.solo?d*2:d;
}
/** +-20% random spread. */
export const jitter=(ms,random=Math.random)=>Math.round(ms*(0.8+0.4*random()));
/** Network or server failure number n (0-based): min(60 s, 2 s * 2^n) * rand(0.5..1). */
export const backoff=(n,random=Math.random)=>Math.round(Math.min(60000,2000*2**n)*(0.5+0.5*random()));
/** Delay after a failed poll: Retry-After (15 s by default) for 429/503/508, never shorter than the back-off. */
export function errorDelay(status,retryAfter,n,random=Math.random){
 const b=backoff(n,random);
 return HOSTING.includes(status)?Math.max((Number.isFinite(retryAfter)&&retryAfter>0?retryAfter:LIMITS.retry)*1000,b):b;
}
/** Retry-After header (seconds or an HTTP date) in seconds, or null. */
export function retryAfter(value,now=Date.now()){
 if(value==null||value==='')return null;const s=Number(value);if(Number.isFinite(s))return Math.max(0,s);
 const at=Date.parse(value);return Number.isFinite(at)?Math.max(0,Math.ceil((at-now)/1000)):null;
}
/** Hosting report (plan §5.10): counts per status since the last successful request. */
export const reportNew=()=>({});
export function reportAdd(r,status){const s=HOSTING.includes(status)?status:0;r[s]=Math.min(LIMITS.report,(r[s]||0)+1);return r;}
/** 'n:status' for the status with most answers, or null. */
export function reportParam(r){let best=null;for(const [s,n] of Object.entries(r||{}))if(n>0&&(!best||n>best[1]))best=[s,n];return best?best[1]+':'+best[0]:null;}
/** What an HTTP answer means for the poller: ok | none (204) | unauth | outdated | off | gone (route missing) | fail; report = status for e or null. */
export function classify(status,body,json){
 if(status===204)return {kind:'none',report:null};
 if(json&&status>=200&&status<300)return {kind:'ok',report:null};
 if(HOSTING.includes(status))return {kind:json&&body?.code==='chat_off'?'off':'fail',report:json&&body?.code==='chat_off'?null:status};
 if(!json)return {kind:'fail',report:0};
 if(status===401)return {kind:'unauth',report:null};
 if(status===409&&body?.code==='client_outdated')return {kind:'outdated',report:null};
 if(status===404)return {kind:'gone',report:null};
 return {kind:'fail',report:null};
}
/** Query of one poll (plan §5.4): at most 6 channels on screen (ch=id:rev) and 30 in the background (h=id:lastRead:knownLast). */
export function buildQuery({route,ch={},h={},cv=null,e=null}){
 const q={route},chIds=Object.keys(ch).filter(id=>/^\d+$/.test(id)).slice(0,LIMITS.ch);
 const hIds=Object.keys(h).filter(id=>/^\d+$/.test(id)&&!chIds.includes(id)).slice(0,LIMITS.h);
 if(chIds.length)q.ch=chIds.map(id=>id+':'+Math.max(0,Math.floor(ch[id]||0))).join(',');
 if(hIds.length)q.h=hIds.map(id=>id+':'+Math.max(0,Math.floor(h[id][0]||0))+':'+Math.max(0,Math.floor(h[id][1]||0))).join(',');
 if(Number.isInteger(cv))q.cv=String(cv);if(e)q.e=e;
 return q;
}
/**
 * Union of the wants of live tabs (init = channels still waiting for their first page): ch = lowest cursor per channel (visible tabs first, at most 6, the rest rotate by `turn`),
 * h = the background channels with the highest read id, onScreen/visible/interactionAt/floor aggregated over visible tabs.
 */
export function unionWants(tabs,turn=0){
 const ch={},h={},order=[],init=new Set();let visible=false,onScreen=false,interactionAt=0,floor=null,feed=false;
 const list=[...tabs].sort((a,b)=>(b.visible?1:0)-(a.visible?1:0));
 for(const tab of list){
  const w=tab.wants||{};if(tab.mode==='feed')feed=true;
  if(tab.visible){visible=true;interactionAt=Math.max(interactionAt,tab.interactionAt||0);if(w.onScreen){onScreen=true;floor=floor===null?(w.floor||0):Math.min(floor,w.floor||0);}}
 for(const id of w.init||[])init.add(String(id));
  for(const [id,rev] of Object.entries(w.ch||{})){if(!(id in ch)){ch[id]=rev;order.push(id);}else ch[id]=Math.min(ch[id],rev);}
  for(const [id,[read,known]] of Object.entries(w.h||{})){const cur=h[id];h[id]=cur?[Math.max(cur[0],read),Math.min(cur[1],known)]:[read,known];}
 }
 let ids=order;if(ids.length>LIMITS.ch){const k=turn%ids.length;ids=[...ids.slice(k),...ids.slice(0,k)].slice(0,LIMITS.ch);}
 const pick={};for(const id of ids)pick[id]=ch[id];
 for(const id of order)delete h[id];
 return {ch:pick,h,init:[...init].filter(id=>id in pick),visible,onScreen,interactionAt,floor:floor||0,mode:feed?'feed':'public',overflow:order.length>LIMITS.ch};
}
/** Leader election on Web Locks: onLead() runs while this tab holds the lock; release() hands it on (and queues again unless stop). */
export function createLeader({locks,name=LOCK,onLead,onLose}){
 let release=null,stopped=false,leading=false;
 function request(){
  if(stopped||!locks?.request)return;
  locks.request(name,()=>new Promise(resolve=>{if(stopped){resolve();return;}leading=true;release=()=>{leading=false;release=null;resolve();onLose?.();};onLead?.();})).catch(()=>{});
 }
 request();
 return {get leading(){return leading;},
  release({again=true}={}){const r=release;if(!r)return;r();if(again&&!stopped)request();},
  stop(){stopped=true;release?.();}};
}
const tabId=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Random client id of one message: 22 characters of [A-Za-z0-9_-] (plan §5.5; a new one for every message, §14.4). */
export function clientId(crypto=globalThis.crypto){
 const bytes=new Uint8Array(22);if(crypto?.getRandomValues)crypto.getRandomValues(bytes);else for(let i=0;i<22;i++)bytes[i]=Math.floor(Math.random()*256);
 let out='';for(const b of bytes)out+=B64[b&63];return out;
}

/**
 * The poller of this tab. opts: wants() -> {ch:{id:rev}, init:[ids without data yet], h:{id:[read,known]}, onScreen, floor}; mode() -> 'feed' | 'public';
 * isOwn(message) -> true for the person's own messages (they do not speed polling up); onData(data, from) with from = {id: cursor
 * the poll used}; onStatus('connecting'|'live'|'reconnecting'|'offline'|'off'|'error'); onUnauth(); onOutdated().
 * env (tests): fetch, locks, BroadcastChannel, now, random, setTimeout, clearTimeout, setInterval, clearInterval, online(), visible(),
 * apiUrl, emit, events (false: no window/document listeners).
 */
export function createTransport(opts){
 const env={fetch:(...a)=>globalThis.fetch(...a),locks:globalThis.navigator?.locks,BroadcastChannel:globalThis.BroadcastChannel,now:()=>Date.now(),random:Math.random,
  setTimeout:(f,ms)=>setTimeout(f,ms),clearTimeout:t=>clearTimeout(t),setInterval:(f,ms)=>setInterval(f,ms),clearInterval:t=>clearInterval(t),
  online:()=>globalThis.navigator?.onLine!==false,visible:()=>globalThis.document?.visibilityState!=='hidden',apiUrl:Client.apiUrl,emit,events:true,...opts.env};
 const id=tabId(),tabs=new Map();
 let synced=false,bc=null,leader=null,solo=true,timer=null,inFlight=false,again=false,stopped=false,fails=0,turn=0,lastStart=-1e9,lastEnd=0,factor=1,errorUntil=0;
 let cfg=normalizeCfg(null),cv=null,report=reportNew(),status='connecting',interactionAt=env.now(),messageAt=0,handedAt=-1e9;
 const leading=()=>solo||!!leader?.leading;
 const post=msg=>{try{bc?.postMessage(msg);}catch{}};
 const setStatus=s=>{if(s===status)return;status=s;opts.onStatus?.(s);if(!solo&&leading())post({type:'status',status:s,cfg,cv});};
 const self=()=>({tab:id,mode:opts.mode(),visible:env.visible(),interactionAt,wants:opts.wants()||{},at:env.now()});
 const work=u=>Object.keys(u.ch).length>0||Object.keys(u.h).length>0;
 const needsNow=u=>!synced||u.init.length>0;
 function live(){const now=env.now();for(const [k,t] of tabs)if(k!==id&&now-t.at>LIMITS.tabTtl)tabs.delete(k);tabs.set(id,self());return [...tabs.values()];}
 const delayFor=u=>pollDelay({now:env.now(),interactionAt:u.interactionAt,messageAt,visible:u.visible,onScreen:u.onScreen,online:env.online(),cfg,solo,floor:u.floor});
 /** (Re)arms the leader's timer from the current wants: at once for a channel without data, else last poll + paced delay. */
 function plan(now=false){
  if(stopped||!leading())return;
  if(inFlight){if(now)again=true;return;}
  env.clearTimeout(timer);timer=null;
  const u=unionWants(live(),turn);if(!work(u))return;
  if(!env.online()){setStatus('offline');return;}
  if(!u.visible)return;
  let due;
  if(now||needsNow(u))due=Math.max(env.now(),lastStart+LIMITS.minGap,errorUntil);
  else{const d=delayFor(u);if(d===null)return;due=Math.max(lastEnd+d*factor,errorUntil);}
  timer=env.setTimeout(poll,Math.max(0,due-env.now()));
 }
 function announce(){if(stopped)return;if(leading())plan();else post({type:'want',...self()});}
 async function poll(){
  timer=null;if(stopped||!leading())return;
  if(inFlight){again=true;return;}
  const tabsNow=live(),u=unionWants(tabsNow,turn);if(u.overflow)turn++;
  if(!work(u)||!u.visible)return;
  if(!env.online()){setStatus('offline');return;}
  const mode=u.mode,e=reportParam(report),q=buildQuery({route:mode==='feed'?'chat-feed':'public-chat',ch:u.ch,h:u.h,cv,e});
  inFlight=true;again=false;lastStart=env.now();
  let failed=null;
  try{
   const r=await request(q,mode),c=classify(r.status,r.body,r.json);
   if(c.report!==null)reportAdd(report,c.report);
   if(c.kind==='ok'||c.kind==='none'){
    if(e)report=reportNew();fails=0;errorUntil=0;synced=true;
    // 204 while a tab waits for a channel's first page: the channel is visible and empty (the server answers 'same' for rev 0).
    if(c.kind==='none'&&u.init.length)accept({ch:Object.fromEntries(u.init.filter(id=>!u.ch[id]).map(id=>[id,{rev:0,more:false,older:false,m:[]}]))},u.ch,tabsNow);
    if(c.kind==='ok')accept(r.body,u.ch,tabsNow);setStatus(cfg.on?'live':'off');
   }
   else if(c.kind==='unauth'){post({type:'unauth'});opts.onUnauth?.();}
   else if(c.kind==='outdated'){post({type:'outdated'});stop();opts.onOutdated?.();return;}
   else if(c.kind==='gone'){setStatus('error');stop();return;}
   else if(c.kind==='off'){fails=0;failed=Math.max((r.retry||0)*1000,cfg.ms[4]);setStatus('off');}
   else{failed=errorDelay(r.status,r.retry,fails,env.random);fails++;setStatus(fails>=2||failed>30000?'reconnecting':status);}
  }catch{
   if(env.online())reportAdd(report,0);failed=backoff(fails,env.random);fails++;setStatus(!env.online()?'offline':fails>=2?'reconnecting':status);
  }finally{inFlight=false;}
  if(stopped)return;
  lastEnd=env.now();factor=0.8+0.4*env.random();errorUntil=failed===null?0:lastEnd+failed;
  plan(again&&failed===null);
 }
 function accept(body,used,tabsNow){
  if(!body||typeof body!=='object')return;
  if(Number.isInteger(body.cv))cv=body.cv;if(body.cfg)cfg=normalizeCfg(body.cfg);
  let fresh=false;
  for(const [k,entry] of Object.entries(body.ch||{})){
   if(!entry||entry.st==='gone')continue;
   if(used[k]>0&&(entry.m||[]).some(m=>m.r>used[k]&&!m.x&&!opts.isOwn?.(m)))fresh=true;
   // Every tab applies the same answer, so their cursors move with the leader's at once (they announce again anyway).
   if(Number.isFinite(entry.rev)&&!entry.more)for(const t of tabsNow){const w=t.wants?.ch;if(w&&k in w)w[k]=Math.max(w[k]||0,entry.rev);}
  }
  for(const [k,v] of Object.entries(body.heads||{}))if(Number.isFinite(v?.last))for(const t of tabsNow){const w=t.wants?.h;if(w&&w[k])w[k]=[w[k][0],Math.max(w[k][1]||0,v.last)];}
  if(fresh)messageAt=env.now();
  opts.onData?.(body,used);post({type:'data',data:body,from:used,cv,cfg:body.cfg?cfg:null,fresh});
 }
 async function request(q,mode){
  const controller=typeof AbortController==='function'?new AbortController():null,t=controller&&env.setTimeout(()=>controller.abort(),LIMITS.timeout);
  try{
   const res=await env.fetch(env.apiUrl(q),{method:'GET',credentials:mode==='feed'?'same-origin':'omit',cache:mode==='feed'?'no-store':'default',headers:{Accept:'application/json','X-MatBravo-Client':String(Client.CLIENT_API)},...(controller?{signal:controller.signal}:{})});
   const retry=retryAfter(res.headers?.get?.('Retry-After'),env.now());
   if(res.status===204)return {status:204,json:true,body:null,retry};
   let body=null,json=false;try{body=await res.json();json=true;}catch{json=false;}
   return {status:res.status,json,body,retry:retry??(Number.isFinite(body?.retry)?body.retry:null)};
  }finally{if(t)env.clearTimeout(t);}
 }
 // A hidden leader is throttled by the browser: it hands the lock on while another tab is visible (at most every 2 s).
 function handOver(){env.setTimeout(()=>{if(!stopped&&leader?.leading&&!env.visible()&&[...tabs.values()].some(t=>t.tab!==id&&t.visible&&env.now()-t.at<LIMITS.tabTtl)&&env.now()-handedAt>2000){handedAt=env.now();leader.release();}},300);}
 try{if(typeof env.BroadcastChannel==='function'&&env.locks?.request){bc=new env.BroadcastChannel(CHANNEL);solo=false;}}catch{bc=null;solo=true;}
 if(bc){
  bc.onmessage=event=>{
   const m=event?.data;if(!m||typeof m!=='object'||stopped)return;
   if(m.type==='want'&&leading()){const known=tabs.has(m.tab);tabs.set(m.tab,{...m,at:env.now()});if(!known)post({type:'status',status,cfg,cv});plan();if(!env.visible())handOver();}
   else if(m.type==='bye'&&leading()){tabs.delete(m.tab);plan();}
   else if(m.type==='poke'&&leading()){const t=tabs.get(m.tab);if(t)t.visible=true;plan(true);}
   else if(m.type==='who'&&!leading())announce();
   else if(m.type==='data'&&!leading()){if(m.cv!=null)cv=m.cv;if(m.cfg)cfg=normalizeCfg(m.cfg);if(m.fresh)messageAt=env.now();opts.onData?.(m.data,m.from||{});}
   else if(m.type==='status'&&!leading()){if(m.cfg)cfg=normalizeCfg(m.cfg);if(m.cv!=null)cv=m.cv;if(m.status!==status){status=m.status;opts.onStatus?.(status);}}
   else if(m.type==='unauth')opts.onUnauth?.();
   else if(m.type==='outdated'){stop();opts.onOutdated?.();env.emit('client-outdated',{});}
  };
  leader=createLeader({locks:env.locks,onLead(){tabs.clear();cv=null;synced=false;post({type:'who'});tabs.set(id,self());handOver();plan();},onLose(){env.clearTimeout(timer);timer=null;}});
 }
 const wake=()=>{if(stopped)return;if(leading())plan(true);else{post({type:'want',...self()});post({type:'poke',tab:id});}};
 if(env.events){
  const doc=globalThis.document,win=globalThis.window,on=(target,event,fn)=>target?.addEventListener?.(event,fn);
  on(doc,'visibilitychange',()=>{if(env.visible())wake();else{announce();if(leading())handOver();}});
  for(const event of ['focus','pageshow','online'])on(win,event,wake);
  on(win,'offline',()=>{setStatus('offline');announce();});on(win,'pagehide',()=>post({type:'bye',tab:id}));
 }
 const beat=bc?env.setInterval(()=>{if(!stopped&&!leading())announce();},LIMITS.beat):null;
 function stop(){if(stopped)return;stopped=true;env.clearTimeout(timer);timer=null;if(beat)env.clearInterval(beat);post({type:'bye',tab:id});leader?.stop();try{bc?.close();}catch{}}
 queueMicrotask(()=>{if(!stopped)announce();});
 return {
  id,
  get leading(){return leading();},get status(){return status;},get cfg(){return cfg;},get cv(){return cv;},get stopped(){return stopped;},get solo(){return solo;},
  /** The wants of this tab changed (channel opened, cursor moved, view mounted or removed). */
  update:announce,
  /** Poll now (a channel opened, own message sent, tab visible again): the leader polls, a follower asks it to. */
  poke:wake,
  /** User interaction in this tab: restarts the idle clock; coming back from idle reaches the leader at once. */
  interact(){const now=env.now(),was=interactionAt;interactionAt=now;if(now-was>=cfg.idle[0]*500)announce();},
  /** One history page (30 messages before `before`) straight from this tab; it never moves the cursors. */
  async history(channel,before){
   const mode=opts.mode(),q=buildQuery({route:mode==='feed'?'chat-feed':'public-chat',ch:{[channel]:0}});q.before=String(before);
   const r=await request(q,mode),c=classify(r.status,r.body,r.json);
   if(c.kind!=='ok')throw Object.assign(new Error('Nie udało się wczytać czatu.'),{status:r.status});
   return r.body?.ch?.[channel]||{st:'gone'};
  },
  /** Channel lists: public-chat-channels for guests, chat-channels (creates missing tournament channels) when signed in. */
  async lists(){
   const mode=opts.mode(),r=await request({route:mode==='feed'?'chat-channels':'public-chat-channels'},mode),c=classify(r.status,r.body,r.json);
   if(c.kind==='unauth'){opts.onUnauth?.();throw Object.assign(new Error('Zaloguj się ponownie.'),{status:401});}
   if(c.kind==='outdated'){stop();opts.onOutdated?.();throw Object.assign(new Error('Nie udało się wczytać czatu.'),{status:409});}
   if(c.kind!=='ok')throw Object.assign(new Error('Nie udało się wczytać czatu.'),{status:r.status,off:c.kind==='off',gone:c.kind==='gone'});
   if(cv===null&&r.body?.cfg)cfg=normalizeCfg(r.body.cfg);
   return r.body;
  },
  send:body=>Client.request('chat-send',{method:'POST',body}),
  remove:messageId=>Client.request('chat-delete',{method:'POST',body:{id:messageId}}),
  report:(messageId,reason,comment)=>Client.request('chat-report',{method:'POST',body:comment?{id:messageId,reason,comment}:{id:messageId,reason}}),
  stop,
  /** Tests only. */
  _state:()=>({tabs,report,fails,cv,cfg,messageAt,interactionAt,inFlight,timer,errorUntil})
 };
}
