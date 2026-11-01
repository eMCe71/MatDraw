// Chat client (plan §5.4, §5.9, §11, §12.10): tokenizing and safe rendering, grouping and day separators, the poll schedule (idle time
// only from interaction, limited boost), back-off and the hosting report, leader election (one source of polls for many tabs),
// purgeIdentity after logout/reset/401, the avatar queue, the stop and 'client-outdated' after client_outdated, background counters
// (knownLast), the demo adapter and, in a real browser (MATDRAW_BROWSER_TESTS=1), per-channel "new messages", a tournament channel
// created after the first lists, and drafts/focus kept across repaints.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

// Browser stand-ins installed before the modules load (me.js opens a BroadcastChannel, the demo uses localStorage).
class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage=new MemoryStorage();globalThis.sessionStorage=new MemoryStorage();
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Bus{
 static channels=new Set();
 constructor(name){this.name=name;this.onmessage=null;Bus.channels.add(this);}
 postMessage(data){const copy=structuredClone(data);for(const c of Bus.channels)if(c!==this&&c.name===this.name)setImmediate(()=>c.onmessage?.({data:copy}));}
 close(){Bus.channels.delete(this);}
}
globalThis.BroadcastChannel=Bus;

const T=await import('../dist/chat-transport.js');
const {registry,SafeHtml}=await import('../dist/registry.js');
const chat=await import('../dist/chat.js');
const {setLanguage}=await import('../dist/i18n.js');setLanguage('pl',{persist:false});
const {createDemoTransport,KEY:DEMO_KEY}=await import('../dist/chat-demo.js');
const CFG=T.normalizeCfg(null);

// ——— Fake DOM pieces ———
function fakeDocument(){
 const make=tag=>({tag,children:[],attrs:{},appendChild(n){this.children.push(n);return n;},append(...n){this.children.push(...n);},setAttribute(k,v){this.attrs[k]=String(v);}});
 return {createDocumentFragment:()=>make('#fragment'),createTextNode:v=>({tag:'#text',text:v}),createElement:tag=>make(tag)};
}
const walk=(node,out=[])=>{out.push(node);for(const c of node.children||[])walk(c,out);return out;};

test('tokenize: http(s) links only, trailing punctuation cut, long labels shortened',()=>{
 const toks=chat.tokenize('See https://example.org/rules?a=1&b=2). Or http://x.pl, javascript:alert(1) and ftp://y.example');
 assert.deepEqual(toks.filter(t=>t.t==='link').map(t=>[t.href,t.label,t.host]),[['https://example.org/rules?a=1&b=2','example.org/rules?a=1&b=2','example.org'],['http://x.pl/','x.pl','x.pl']]);
 assert.equal(toks.map(t=>t.t==='text'?t.v:t.label).join(''),'See example.org/rules?a=1&b=2). Or x.pl, javascript:alert(1) and ftp://y.example');
 const long=chat.tokenize('https://example.com/'+'a'.repeat(80))[0];assert.equal(long.label.length,60);assert.ok(long.label.endsWith('…'));
 assert.deepEqual(chat.tokenize(''),[]);
});
test('message text: hostile input becomes text nodes and safe <a> elements only',()=>{
 const doc=fakeDocument();
 for(const evil of ['<img src=x onerror=alert(1)>','"><svg onload=alert(1)>','javascript:alert(1)','‮evil‬ <b>x</b>','https://ok.example/"><script>alert(1)</script>','<a href="javascript:x">y</a>']){
  const nodes=walk(chat.textNodes(doc,evil)).slice(1);
  for(const n of nodes){
   assert.ok(n.tag==='#text'||n.tag==='a','only text and links: '+n.tag);
   if(n.tag==='a'){assert.match(n.href,/^https?:\/\//);assert.equal(n.rel,'noopener noreferrer nofollow ugc');assert.equal(n.target,'_blank');assert.equal(n.children.length,0);assert.ok(!/[<>"]/.test(n.textContent),n.textContent);}
  }
  assert.equal(nodes.map(n=>n.tag==='a'?n.textContent:n.text).join('').replace(/…$/,'').length>0,true);
 }
 const guest=walk(chat.textNodes(doc,'Rules on https://example.org/rules now',{links:false})).slice(1);
 assert.deepEqual(guest.map(n=>[n.tag,n.text]),[['#text','Rules on '],['#text','example.org'],['#text',' now']],'guests see the domain as text, no link');
});
test('notice and tournament title from the API are escaped in templates',()=>{
 const notice=chat._internals.banner('notice','<img src=x onerror=alert(1)> & "q"','info');
 assert.ok(notice instanceof SafeHtml);assert.ok(!notice.html.includes('<img'));assert.ok(notice.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
 chat._internals.applyLists({cv:1,lobby:[],tournaments:[{id:77,tournamentId:'t-x',title:'<script>alert(1)</script>Puchar',date:'2099-05-01',city:'"><svg onload=1>',st:'open',last:0,count:0}]});
 const item=chat._internals.railItem({key:null},'77').html;
 assert.ok(!item.includes('<script')&&!item.includes('<svg'),item);assert.ok(item.includes('&lt;script&gt;alert(1)&lt;/script&gt;Puchar'));
 chat.purgeIdentity();
});
test('organizer badge: o:1 "Organizator", o:2 "Organizator (społeczność)" for a community organizer not yet confirmed (PS-12)',async()=>{
 assert.equal(chat.orgLabel(1),'Organizator');assert.equal(chat.orgLabel(2),'Organizator (społeczność)');
 assert.equal(chat.orgLabel(0),null);assert.equal(chat.orgLabel(undefined),null);
 setLanguage('en',{persist:false});try{assert.equal(chat.orgLabel(2),'Organizer (community)');assert.equal(chat.orgLabel(1),'Organizer');}finally{setLanguage('pl',{persist:false});}
 const {readFileSync}=await import('node:fs');assert.match(readFileSync(new URL('../dist/chat.js',import.meta.url),'utf8'),/if\(m\.o\)meta\.appendChild\(el\('span','chat-org',orgLabel\(m\.o\)\)\);/,'the message header uses it');
});
test('layout: grouping by cont, day separators, the "Nowe" divider and tombstones break groups',()=>{
 const day=Date.UTC(2026,9,30,10,0,0),m=(id,t,extra)=>({id,r:id,t,a:'A',c:1,b:'x',...extra});
 const list=[m(1,day,{c:0}),m(2,day+60000),m(3,day+120000,{a:'B'}),m(4,day+180000,{x:'mod',c:undefined}),m(5,day+200000),m(6,day+86400000*1.2),m(7,day+86400000*1.2+1000),m(8,day+86400000*1.2+2000)];
 const items=chat.layout(list,{divider:8,now:day+86400000*2});
 assert.deepEqual(items.map(i=>i.kind==='msg'?i.m.id+(i.group?'g':''):i.kind),['day','1','2g','3','4','5','day','6','7g','new','8']);
 const late=chat.layout([m(1,day,{c:0}),m(2,day+GROUP+1)],{now:day});assert.equal(late[2].group,false,'5 minutes apart: a new group');
 const ghosts=chat.layout([{id:1,r:1,t:day,g:2,c:0,b:'a'},{id:2,r:2,t:day+1000,g:2,c:1,b:'b'},{id:3,r:3,t:day+2000,g:3,c:1,b:'c'}],{now:day});
 assert.deepEqual(ghosts.filter(i=>i.kind==='msg').map(i=>i.group),[false,true,false],'guest projection groups by cont and the variant');
 const own=chat.layout([m(1,day,{a:'Me'}),{id:9e15,t:day+5000,a:'Me',b:'y',pending:true}],{now:day,own:'Me'});assert.equal(own[2].group,true,'own pending message continues own message');
});
const GROUP=chat.GROUP_MS;
test('day labels and times',()=>{
 const now=new Date(2026,9,30,12,0,0).getTime();
 assert.equal(chat.dayLabel(now-3600000,now),'Dziś');assert.equal(chat.dayLabel(now-86400000,now),'Wczoraj');
 assert.equal(chat.timeLabel(now-30000,now),'teraz');assert.equal(chat.timeLabel(now-7*60000,now),'7 min');assert.match(chat.timeLabel(now-3*3600000,now),/^\d{2}:\d{2}$/);
});
test('default channel, composer gate and price',()=>{
 assert.equal(chat.defaultSlug({stored:'karate',me:null,lang:'pl'}),'karate');
 assert.equal(chat.defaultSlug({stored:'bogus',me:{profile:{sports:['taekwondo'],country:'PL'}},lang:'en'}),'taekwondo-pl');
 assert.equal(chat.defaultSlug({me:{profile:{sports:['taekwondo'],country:'DE'}}}),'taekwondo');
 assert.equal(chat.defaultSlug({me:{profile:{sports:['karate']}}}),'karate');assert.equal(chat.defaultSlug({me:{profile:{sports:['judo']}}}),'general');
 assert.equal(chat.defaultSlug({lang:'pl'}),'taekwondo-pl');assert.equal(chat.defaultSlug({lang:'en'}),'taekwondo');
 const f=(x)=>chat.footKind({signedIn:false,config:null,st:'open',...x});
 assert.equal(f({}),'login');assert.equal(f({config:{signup:false,billing:true}}),'login');assert.equal(f({config:{signup:true,billing:true}}),'paid');assert.equal(f({config:{signup:true,billing:false}}),'free');
 const member=block=>chat.footKind({signedIn:true,me:{access:{block,canPost:block===null}},st:'open'});
 assert.deepEqual(['payment','profile','password','muted','off',null].map(member),['activate','profile','password','muted','off','composer']);
 assert.equal(chat.footKind({signedIn:true,me:null,st:'open'}),'wait');assert.equal(f({st:'archive'}),'readonly');assert.equal(f({on:false}),'off');
 assert.equal(chat.priceText({pln:899,usd:299},'pl').replace(/\s/g,' '),'8,99 zł');assert.equal(chat.priceText({pln:899,usd:299},'en'),'$2.99');assert.equal(chat.priceText(null,'pl'),null);
});

// ——— Schedule ———
test('schedule: idle levels from interaction only, ms[0] while active, bg off screen, paused hidden or offline',()=>{
 const base={now:1e6,interactionAt:1e6,visible:true,onScreen:true,online:true,cfg:CFG};
 assert.equal(T.pollDelay(base),2500);
 assert.deepEqual([30,61,200,700,2000].map(s=>T.pollDelay({...base,now:1e6+s*1000})),[2500,5000,10000,30000,60000]);
 assert.equal(T.pollDelay({...base,onScreen:false}),30000);assert.equal(T.pollDelay({...base,visible:false}),null);assert.equal(T.pollDelay({...base,online:false}),null);
 assert.equal(T.pollDelay({...base,solo:true}),5000,'no leader election: doubled');assert.equal(T.pollDelay({...base,floor:10000}),10000,'phone preview');
 assert.equal(T.pollDelay({...base,cfg:{...CFG,on:false}}),60000,'switched off: retry after ms[4]');
});
test('schedule: an unattended visible card in a busy channel slows to ms[2] or slower within 10 minutes; boost only after interaction',()=>{
 const run=interactEvery=>{let t=0,messageAt=null,next=0,interactionAt=0;const out=[];
  while(t<=630000){while(next<=t){messageAt=next;next+=60000;}if(interactEvery&&t-interactionAt>=interactEvery)interactionAt=t;
   const d=T.pollDelay({now:t,interactionAt,messageAt,visible:true,onScreen:true,online:true,cfg:CFG});out.push([t,d]);t+=d;}
  return out;};
 const idle=run(0);
 assert.ok(idle.filter(([t])=>t>=300000).every(([,d])=>d>=5000),'never below ms[1] once the last interaction is older than cfg.boost');
 assert.ok(idle.filter(([t])=>t>=60000&&t<300000).some(([,d])=>d===2500),'full boost while the last interaction is recent');
 assert.ok(idle.filter(([t])=>t>=600000).every(([,d])=>d>=10000),'ms[2] or slower after 10 minutes');
 assert.ok(idle.filter(([t])=>t>=300000&&t<600000).every(([,d])=>d===5000),'one level faster than idle (10 s) while messages keep coming');
 assert.ok(run(30000).every(([,d])=>d===2500),'active user: ms[0]');
 for(let i=0;i<50;i++){const j=T.jitter(10000,()=>i/49);assert.ok(j>=8000&&j<=12000);}
});
test('back-off, Retry-After and the hosting report e',()=>{
 assert.deepEqual([0,1,2,3,4,5,9].map(n=>T.backoff(n,()=>1)),[2000,4000,8000,16000,32000,60000,60000]);
 assert.equal(T.backoff(3,()=>0),8000);
 assert.equal(T.errorDelay(429,null,0,()=>1),15000);assert.equal(T.errorDelay(503,40,0,()=>1),40000);assert.equal(T.errorDelay(508,1,5,()=>1),60000);assert.equal(T.errorDelay(500,99,0,()=>1),2000);
 assert.equal(T.retryAfter('7'),7);assert.equal(T.retryAfter(new Date(10000+30000).toUTCString(),10000),30);assert.equal(T.retryAfter(null),null);
 const r=T.reportNew();assert.equal(T.reportParam(r),null);
 T.reportAdd(r,429);T.reportAdd(r,429);T.reportAdd(r,0);T.reportAdd(r,418);assert.equal(r[0],2,'other statuses count as 0');
 assert.ok(['2:429','2:0'].includes(T.reportParam(r)));for(let i=0;i<80;i++)T.reportAdd(r,503);assert.equal(T.reportParam(r),'50:503','at most 50');
 assert.deepEqual(T.classify(204,null,true),{kind:'none',report:null});assert.deepEqual(T.classify(503,null,false),{kind:'fail',report:503});
 assert.deepEqual(T.classify(200,null,false),{kind:'fail',report:0},'not JSON');assert.deepEqual(T.classify(503,{code:'chat_off'},true),{kind:'off',report:null});
 assert.equal(T.classify(401,{},true).kind,'unauth');assert.equal(T.classify(409,{code:'client_outdated'},true).kind,'outdated');assert.equal(T.classify(429,{error:'x'},true).report,429);
});
test('query: at most 6 channels on screen and 30 in the background, h without channels already in ch',()=>{
 const ch=Object.fromEntries(Array.from({length:9},(_,i)=>[String(i+1),i]));const h=Object.fromEntries(Array.from({length:40},(_,i)=>[String(i+1),[i,i+1]]));
 const q=T.buildQuery({route:'chat-feed',ch,h,cv:3,e:'2:429'});
 assert.equal(q.ch.split(',').length,6);assert.equal(q.h.split(',').length,30);assert.ok(!q.h.split(',').some(x=>Number(x.split(':')[0])<=6));
 assert.equal(q.cv,'3');assert.equal(q.e,'2:429');assert.match(q.ch,/^1:0,2:1/);
 const u=T.unionWants([{visible:false,wants:{ch:{'5':9},h:{'1':[3,10]}}},{visible:true,interactionAt:50,wants:{ch:{'5':4,'6':0},h:{'1':[7,8]},onScreen:true,floor:10000}}]);
 assert.deepEqual(u.ch,{'5':4,'6':0});assert.deepEqual(u.h,{'1':[7,8]});assert.equal(u.visible,true);assert.equal(u.onScreen,true);assert.equal(u.floor,10000);
 assert.match(T.clientId(),/^[A-Za-z0-9_-]{22}$/);assert.notEqual(T.clientId(),T.clientId());
});

test('reading (plan §3.5 step 6): a=1 only for a feed poll with a chat on screen, a channel in ch and own interaction within idle[3]',()=>{
 const now=1_800_000_000_000,recent={ch:{'1':4},h:{},onScreen:true,interactionAt:now-CFG.idle[3]*1000};
 assert.equal(T.reading(recent,'feed',CFG,now),true,'interaction exactly idle[3] ago still counts');
 assert.equal(T.reading({...recent,interactionAt:now-CFG.idle[3]*1000-1},'feed',CFG,now),false,'older interaction: not reading');
 assert.equal(T.reading(recent,'public',CFG,now),false,'never on the public chat');
 assert.equal(T.reading({...recent,onScreen:false},'feed',CFG,now),false,'never in the background');
 assert.equal(T.reading({...recent,ch:{},h:{'1':[3,4]}},'feed',CFG,now),false,'never on a heads-only poll');
 const cfg=T.normalizeCfg({idle:[1,2,3,4]});
 assert.equal(T.reading({...recent,interactionAt:now-4000},'feed',cfg,now),true,'the server\'s idle levels count');
 assert.equal(T.reading({...recent,interactionAt:now-4001},'feed',cfg,now),false);
});

// ——— Runtime: fake clock, locks and fetch ———
function fakeClock(){
 let now=1_800_000_000_000,seq=0;const q=[];
 const c={now:()=>now,setTimeout(f,ms){const t={id:++seq,at:now+Math.max(0,ms||0),f};q.push(t);return t.id;},clearTimeout(id){const i=q.findIndex(t=>t.id===id);if(i>=0)q.splice(i,1);},
  setInterval(f,ms){const id=++seq;const tick=()=>{const t={id,at:now+ms,f:()=>{tick();f();}};q.push(t);};tick();return id;},clearInterval(id){for(let i=q.length-1;i>=0;i--)if(q[i].id===id)q.splice(i,1);},
  async advance(ms){const end=now+ms;for(;;){await flush();q.sort((a,b)=>a.at-b.at);const t=q[0];if(!t||t.at>end)break;q.shift();now=t.at;t.f();}now=end;await flush();}};
 return c;
}
function fakeLocks(){
 const queue=[];let held=false;
 function grant(){if(held||!queue.length)return;const {cb,resolve}=queue.shift();held=true;Promise.resolve(cb({})).then(v=>{held=false;resolve(v);grant();});}
 return {request(name,cb){return new Promise(resolve=>{queue.push({cb,resolve});grant();});}};
}
const json=(status,body,headers={})=>({status,headers:{get:k=>headers[k]??null},json:async()=>{if(body===undefined)throw new Error('not json');return body;}});
function tab(clock,locks,{wants,fetch,visible=()=>true,mode='public',...more}){
 return T.createTransport({mode:()=>mode,wants,...more,env:{fetch,locks,BroadcastChannel:Bus,now:clock.now,random:()=>0.5,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,setInterval:clock.setInterval,clearInterval:clock.clearInterval,online:()=>true,visible,apiUrl:q=>'?'+new URLSearchParams(q),emit:()=>{},events:false}});
}
test('leader election: five tabs give one source of polls; a closed leader hands over',async()=>{
 const clock=fakeClock(),locks=fakeLocks(),calls=[];
 const tabs=Array.from({length:5},(_,i)=>tab(clock,locks,{wants:()=>({ch:{'1':5},h:{},onScreen:true}),fetch:async url=>{calls.push([i,url]);return json(204);}}));
 await clock.advance(30000);
 const sources=new Set(calls.map(([i])=>i));
 assert.equal(sources.size,1,'one tab polls: '+[...sources]);assert.ok(calls.length>=8&&calls.length<=14,'about every 2.5 s: '+calls.length);
 assert.equal(tabs.filter(t=>t.leading).length,1);
 const first=[...sources][0];tabs[first].stop();calls.length=0;
 await clock.advance(30000);
 const next=new Set(calls.map(([i])=>i));assert.equal(next.size,1);assert.ok(!next.has(first),'another tab took over');
 for(const t of tabs)t.stop();
 const solo=Array.from({length:2},(_,i)=>T.createTransport({mode:()=>'public',wants:()=>({ch:{'1':5},onScreen:true}),env:{fetch:async()=>{calls.push([i]);return json(204);},locks:undefined,BroadcastChannel:undefined,now:clock.now,random:()=>0.5,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,setInterval:clock.setInterval,clearInterval:clock.clearInterval,online:()=>true,visible:()=>true,apiUrl:()=>'x',events:false}}));
 calls.length=0;await clock.advance(30000);
 assert.equal(new Set(calls.map(([i])=>i)).size,2,'without Web Locks every tab polls alone');assert.ok(calls.length<=16,'with doubled intervals: '+calls.length);
 for(const t of solo)t.stop();
});
test('hidden tabs stop polling; data reaches every tab; the report e rides on the next request',async()=>{
 const clock=fakeClock(),locks=fakeLocks(),calls=[],got=[[],[]];let visible=true,status=204;
 const fetch=async url=>{calls.push(url);if(status===503)return json(503,undefined,{'Retry-After':'20'});if(status===200)return json(200,{cv:1,ch:{'1':{rev:6,st:'open',more:false,m:[{id:9,r:6,t:1,g:0,c:0,b:'hi'}]}},heads:{}});return json(204);};
 const a=tab(clock,locks,{wants:()=>({ch:{'1':5},onScreen:true}),fetch,visible:()=>visible,onData:d=>got[0].push(d)});
 const b=tab(clock,locks,{wants:()=>({ch:{'1':5},onScreen:true}),fetch,visible:()=>visible,onData:d=>got[1].push(d)});
 await clock.advance(5000);assert.ok(calls.length>0);
 status=200;await clock.advance(5000);assert.ok(got[0].length>=1&&got[1].length>=1,'both tabs get the answer');assert.equal(got[1][0].ch['1'].m[0].b,'hi');
 status=503;calls.length=0;await clock.advance(3000);assert.equal(calls.length,1);
 await clock.advance(15000);assert.equal(calls.length,1,'Retry-After 20 s is respected');
 status=204;calls.length=0;await clock.advance(10000);assert.match(calls[0],/e=1%3A503/,'report sent with the next request');
 assert.ok(calls.length>1&&!/&e=/.test(calls.at(-1)),'and cleared after a success');
 visible=false;a.update();b.update();await clock.advance(1000);calls.length=0;await clock.advance(120000);assert.equal(calls.length,0,'all tabs hidden: paused');
 a.stop();b.stop();
});
test('401 calls onUnauth; 409 client_outdated stops polling for good',async()=>{
 const clock=fakeClock(),locks=fakeLocks();let unauth=0,outdated=0,n=0;
 const t1=tab(clock,locks,{mode:'feed',wants:()=>({ch:{'1':0},onScreen:true}),fetch:async()=>{n++;return json(401,{error:'Zaloguj się ponownie.'});},onUnauth:()=>unauth++});
 await clock.advance(3000);assert.ok(unauth>=1);t1.stop();
 n=0;const t2=tab(clock,locks,{wants:()=>({ch:{'1':0},onScreen:true}),fetch:async()=>{n++;return json(409,{error:'x',code:'client_outdated'});},onOutdated:()=>outdated++});
 await clock.advance(60000);assert.equal(n,1);assert.equal(outdated,1);assert.equal(t2.stopped,true);
});

test('a=1 rides only on feed polls of someone reading: not after idle[3] without interaction, not on heads-only, public or history requests',async()=>{
 const clock=fakeClock(),locks=fakeLocks(),urls=[],params=()=>urls.map(u=>new URLSearchParams(u.slice(1)));let wants={ch:{'1':5},h:{'2':[1,1]},onScreen:true};
 const fetch=async url=>{urls.push(url);if(new URLSearchParams(url.slice(1)).has('before'))return json(200,{ch:{'1':{rev:5,st:'open',more:false,older:false,m:[]}}});return json(204);};
 const t=tab(clock,locks,{mode:'feed',wants:()=>wants,fetch});
 await clock.advance(10000);
 assert.ok(urls.length>=2);for(const q of params()){assert.equal(q.get('route'),'chat-feed');assert.equal(q.get('a'),'1',String(q));assert.ok(q.has('ch'));}
 // No interaction for longer than idle[3] (30 min): the polls continue without a=1.
 await clock.advance(CFG.idle[3]*1000+1000);urls.length=0;await clock.advance(130000);
 assert.ok(urls.length>=1,'still polling');for(const q of params())assert.equal(q.get('a'),null,String(q));
 // Own interaction again: a=1 is back on the next poll.
 t.interact();urls.length=0;await clock.advance(10000);assert.ok(urls.length>=1);for(const q of params())assert.equal(q.get('a'),'1',String(q));
 // History pages never carry it.
 urls.length=0;await t.history('1',40);const hist=params().find(q=>q.has('before'));assert.ok(hist);assert.equal(hist.get('a'),null);
 // Heads only (chat not on screen, no channel in ch): background polls never carry it.
 wants={ch:{},h:{'2':[1,1]},onScreen:false};t.interact();t.update();urls.length=0;await clock.advance(70000);
 assert.ok(urls.length>=1);for(const q of params()){assert.ok(!q.has('ch'));assert.equal(q.get('a'),null,String(q));}
 t.stop();
 // The public chat never carries it.
 urls.length=0;const p=tab(clock,locks,{mode:'public',wants:()=>({ch:{'1':5},onScreen:true}),fetch});
 await clock.advance(10000);assert.ok(urls.length>=1);for(const q of params()){assert.equal(q.get('route'),'public-chat');assert.equal(q.get('a'),null);}
 p.stop();
});
test('409 client_outdated emits registry client-outdated once in every tab: alone, as the leader, as a follower and from lists',async()=>{
 const clock=fakeClock(),outdated=async()=>json(409,{error:'x',code:'client_outdated'});
 const make=(emits,more,wants=()=>({ch:{'1':0},onScreen:true}))=>T.createTransport({mode:()=>'public',wants,onOutdated:()=>{},env:{fetch:outdated,now:clock.now,random:()=>0.5,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,setInterval:clock.setInterval,clearInterval:clock.clearInterval,online:()=>true,visible:()=>true,apiUrl:q=>'?'+new URLSearchParams(q),emit:event=>emits.push(event),events:false,...more}});
 const alone=[],t1=make(alone,{locks:undefined,BroadcastChannel:undefined});
 await clock.advance(30000);assert.deepEqual(alone,['client-outdated'],'a tab polling alone tells pwa.js');assert.equal(t1.stopped,true);
 const locks=fakeLocks(),seen=[[],[]],tabs=seen.map(e=>make(e,{locks,BroadcastChannel:Bus}));
 await clock.advance(30000);assert.equal(tabs.filter(t=>t.stopped).length,2);
 assert.deepEqual(seen,[['client-outdated'],['client-outdated']],'the leader that got the 409 and the follower that got the broadcast');
 const fromLists=[],t3=make(fromLists,{locks:undefined,BroadcastChannel:undefined},()=>({}));
 await assert.rejects(t3.lists(),e=>e.status===409);await assert.rejects(t3.lists(),e=>e.status===409);
 assert.deepEqual(fromLists,['client-outdated'],'channel lists too, once');assert.equal(t3.stopped,true);
});
test('background counters: the first poll counts what came while away; knownLast is the id the count was made for',()=>{
 const S=chat._state(),SEEN='matdraw.chat.seen';registry.provide('ui',{getWorkspace:()=>({user:{id:'u1',role:'club'}})});
 try{
  localStorage.setItem(SEEN,JSON.stringify({'1':100}));
  chat._internals.applyLists({cv:1,lobby:[{id:1,slug:'taekwondo',scope:'world',last:105,count:9,st:'open'}],tournaments:[]});
  const first=chat._internals.wants().h;assert.deepEqual(first,{'1':[100,0]},'not the last id from the lists (the server would answer same)');
  assert.match(T.buildQuery({route:'chat-feed',h:first}).h,/^1:100:0$/);
  chat._internals.apply({cv:1,heads:{'1':{last:105,n:5}}},{},{'1':[100,0]});
  assert.equal(S.channels.get('1').n,5);assert.deepEqual(chat._internals.wants().h,{'1':[100,105]},'later polls: 204 until the channel changes');
  localStorage.setItem(SEEN,JSON.stringify({'1':103}));assert.deepEqual(chat._internals.wants().h,{'1':[103,0]},'read in another tab: counted again');
  // The cursor moves while a poll is in flight: the answer was counted for the cursor sent, not the one current when it arrives.
  localStorage.setItem(SEEN,JSON.stringify({'1':108}));
  chat._internals.apply({cv:1,heads:{'1':{last:110,n:7}}},{},{'1':[103,0]});
  assert.deepEqual(chat._internals.wants().h,{'1':[108,0]},'counted for 103, read is 108 now: the next poll counts again');
  chat._internals.apply({cv:1,heads:{'1':{last:110,n:2}}},{},{'1':[108,0]});
  assert.equal(S.channels.get('1').n,2);assert.deepEqual(chat._internals.wants().h,{'1':[108,110]});
  localStorage.setItem(SEEN,JSON.stringify({'1':110}));
  chat._internals.apply({cv:1,heads:{'1':{last:110,n:2}}},{},{'1':[108,0]});
  assert.equal(S.channels.get('1').n,0,'read up to the last id meanwhile: nothing unread, no stale badge');
  assert.deepEqual(chat._internals.wants().h,{'1':[110,110]},'and nothing to count again');
 }finally{registry.provide('ui',undefined);localStorage.removeItem(SEEN);chat.purgeIdentity();}
});
test('background counters for guests: the known last id from the lists, so the server counts only after a change (§5.4, H4)',()=>{
 const S=chat._state(),SEEN='matdraw.chat.seen',view={el:{isConnected:true},key:'none',kind:'strip'};
 try{
  localStorage.setItem(SEEN,JSON.stringify({'1':100}));
  chat._internals.applyLists({cv:1,lobby:[{id:1,slug:'taekwondo',scope:'world',last:105,count:9,st:'open'},{id:2,slug:'karate',scope:'world',last:40,count:3,st:'open'}],tournaments:[]});
  assert.deepEqual(chat._internals.wants().h,{},'no chat on screen: no background counters');
  S.views.add(view);
  assert.deepEqual(chat._internals.wants().h,{'1':[100,105],'2':[0,40]},'the server answers same until last_message_id changes');
  chat._internals.apply({cv:1,heads:{'1':{last:107,n:7}}},{},{'1':[100,105]});
  assert.deepEqual(chat._internals.wants().h,{'1':[100,107],'2':[0,40]});
 }finally{S.views.delete(view);localStorage.removeItem(SEEN);chat.purgeIdentity();}
});

test('a change to a message below the loaded window is not inserted: history keeps asking before the first loaded id (no gap)',()=>{
 const S=chat._state(),msg=(id,r=id,extra={})=>({id,r,t:Date.now(),a:'PidMarta0001',c:0,b:'m'+id,...extra});
 try{
  chat._internals.applyLists({cv:1,lobby:[{id:1,slug:'taekwondo',scope:'world',last:149,count:150,st:'open'}],tournaments:[]});
  const page=[];for(let id=100;id<150;id++)page.push(msg(id));
  chat._internals.apply({cv:1,ch:{'1':{rev:149,st:'open',more:false,older:true,m:page}}},{});
  const c=S.channels.get('1'),first=()=>[...c.msgs.keys()].sort((a,b)=>a-b)[0];
  assert.equal(first(),100);assert.equal(c.older,true);
  // A moderator deletes message 20 and restores message 30 (both far back), and someone edits 120 and posts 150.
  chat._internals.apply({cv:1,ch:{'1':{rev:153,st:'open',more:false,m:[msg(20,150,{x:'mod',b:''}),msg(30,151),msg(120,152,{x:'mod',b:''}),msg(150,153)]}}},{'1':149});
  assert.equal(first(),100,'the old ids stay out: older() asks for history before 100');
  assert.ok(!c.msgs.has(20)&&!c.msgs.has(30));assert.equal(c.msgs.get(120).x,'mod','a change inside the window applies');assert.ok(c.msgs.has(150),'a new message is added');
  assert.equal(c.cursor,153,'the cursor still moves past the skipped rows');
  // The whole channel loaded (older false): nothing lies below the window, so every change applies.
  chat._internals.apply({cv:1,ch:{'1':{rev:160,st:'open',more:false,older:false,m:[msg(150,153)]}}},{});
  chat._internals.apply({cv:1,ch:{'1':{rev:161,st:'open',more:false,m:[msg(140,161)]}}},{'1':160});
  assert.ok(c.msgs.has(140),'without older history an earlier id is inserted');
 }finally{chat.purgeIdentity();}
});

// ——— purgeIdentity ———
function populate(){
 const S=chat._state();
 chat._internals.applyLists({cv:1,lobby:[{id:1,slug:'taekwondo',scope:'world',last:5,count:1,st:'open'}],tournaments:[{id:3,tournamentId:'t-1',title:'Puchar',date:'2099-01-01',city:'X',st:'open',last:0,count:0}]});
 chat._internals.apply({cv:1,ch:{'1':{rev:7,st:'open',more:false,older:false,m:[{id:5,r:7,t:Date.now(),a:'PidMarta0001',c:0,b:'Cześć'}]}},people:{PidMarta0001:{n:'Marta K.',u:'marta.k'}}},{});
 sessionStorage.setItem('matdraw.chat.draft.1','szkic');sessionStorage.setItem('matdraw.other','keep');
 assert.equal(S.people.size,1);assert.equal(S.channels.get('1').msgs.size,1);assert.equal(S.channels.get('1').cursor,7);
}
function assertPurged(){
 const S=chat._state();
 assert.equal(S.people.size,0,'people');assert.equal([...S.channels.values()].reduce((n,c)=>n+c.msgs.size,0),0,'messages');
 assert.ok([...S.channels.values()].every(c=>!c.cursor),'cursors');assert.equal(S.pending.size,0);
 assert.equal(sessionStorage.getItem('matdraw.chat.draft.1'),null,'drafts');assert.equal(sessionStorage.getItem('matdraw.other'),'keep');
}
test('purgeIdentity after logout, a reset from another tab and a 401',async()=>{
 populate();registry.emit('logout');assertPurged();
 populate();registry.emit('logout',{remote:true});assertPurged();
 populate();chat._internals.unauthorized();assertPurged();
 await flush();chat._state().transport?.stop();
});

// ——— Avatar queue ———
test('avatar queue: at most two downloads at a time, src set only when a slot is free',()=>{
 const timers=[];const q=chat.avatarQueue(2,{setTimeout:(f,ms)=>timers.push([f,ms])});
 const imgs=Array.from({length:5},(_,i)=>{const handlers={};return {i,src:'',isConnected:true,addEventListener(e,f){handlers[e]=f;},fire(e){handlers[e]?.();}};});
 imgs.forEach((img,i)=>q.add(img,'u'+i));
 assert.deepEqual(imgs.map(i=>i.src),['u0','u1','','','']);assert.equal(q.active,2);assert.equal(q.waiting,3);
 imgs[0].fire('load');assert.deepEqual(imgs.map(i=>i.src),['u0','u1','u2','','']);
 imgs[1].fire('error');imgs[2].fire('load');assert.equal(q.active,2);assert.deepEqual(imgs.map(i=>i.src),['u0','u1','u2','u3','u4']);
 imgs[3].fire('load');imgs[3].fire('load');assert.equal(q.active,1,'a slot is freed once');
 const gone={src:'',isConnected:false,addEventListener(){}};q.add(gone,'x');imgs[4].fire('load');assert.equal(gone.src,'','removed images are skipped');
 assert.ok(timers.every(([,ms])=>ms===10000),'a stuck download frees its slot after 10 s');
});

// ——— Demo ———
test('demo adapter: seeded channels, member and guest projections, a demo account posts at once',async()=>{
 localStorage.removeItem(DEMO_KEY);
 const me={user:{id:'demo-admin',role:'admin'},profile:{publicId:'DemoAdmin001',firstName:'Anna',lastName:'Demo',username:'anna.demo',country:'PL',sports:['taekwondo'],nameDisplay:'initial'},access:{full:true,canPost:true,block:null}};
 let wants={ch:{},h:{}},mode='feed';const data=[];
 const t=createDemoTransport({mode:()=>mode,wants:()=>wants,me:()=>me,tournaments:async()=>[{id:'t-a',name:'Puchar',date:'2099-01-02',city:'Kraków'}],onData:d=>data.push(d)});
 const lists=await t.lists();
 assert.deepEqual(lists.lobby.map(c=>c.slug),['taekwondo-pl','taekwondo','karate','general']);assert.ok(lists.lobby.every(c=>c.count===8));
 assert.equal(lists.tournaments[0].tournamentId,'t-a');assert.equal(lists.tournaments[0].count,8);
 wants={ch:{'2':0},h:{'1':[0,0]}};t.update();await flush();await new Promise(r=>setTimeout(r,5));
 const page=data.at(-1).ch['2'];assert.equal(page.m.length,8);assert.ok(page.m.every(m=>m.a&&!('g' in m)));assert.ok(data.at(-1).people[page.m[0].a].n);assert.equal(data.at(-1).heads['1'].n,8);
 const sent=await t.send({ch:2,cid:T.clientId(),b:'  Cześć z demo  '});
 assert.equal(sent.m.a,'DemoAdmin001');assert.equal(sent.m.b,'Cześć z demo');assert.equal(sent.people.DemoAdmin001.n,'Anna D.');
 await assert.rejects(t.send({ch:2,cid:T.clientId(),b:'drugi'}),e=>e.status===429&&e.data.retry===2);
 await assert.rejects(t.send({ch:2,cid:T.clientId(),b:'   '}),e=>e.status===422);
 mode='public';wants={ch:{'2':0}};t.update();await new Promise(r=>setTimeout(r,5));
 const guest=data.at(-1);assert.ok(!guest.people);assert.ok(guest.ch['2'].m.every(m=>!('a' in m)&&Number.isInteger(m.g)&&m.g>=0&&m.g<5));
 assert.ok(!JSON.stringify(guest).includes('Anna'),'no names in the guest projection');
 const older=await t.history('2',guest.ch['2'].m[2].id);assert.equal(older.m.length,2);
 await t.remove(sent.m.id);mode='feed';wants={ch:{'2':0}};t.update();await new Promise(r=>setTimeout(r,5));assert.equal(data.at(-1).ch['2'].m.find(m=>m.id===sent.m.id).x,'author');
 t.stop();
});

// ——— Real browser (opt-in like tests/pwa-browser.test.mjs: MATDRAW_BROWSER_TESTS=1, skipped without Playwright) ———
// A harness page loads the real chat.js in the API mode; the test server answers the chat routes from `api` below.
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS)try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const DIST=fileURLToPath(new URL('../dist/',import.meta.url));
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const HARNESS={
 '/harness.html':['text/html; charset=utf-8','<!doctype html><html lang="pl"><head><meta charset="utf-8"><style>.chat-log{height:240px;overflow:auto}</style></head><body><div id="a" data-chat-mount="page"></div><div id="b" data-chat-mount="page"></div><div id="t" data-chat-mount="tournament"></div><script type="module" src="./harness.js"></script></body></html>'],
 '/harness.js':['text/javascript; charset=utf-8',"import {registry} from './registry.js';registry.provide('ui',{getWorkspace:()=>window.__ws||null,icon:()=>'',toast:()=>{},getState:()=>({})});window.__registry=registry;window.__i18n=await import('./i18n.js');window.__me=await import('./me.js');window.__chat=await import('./chat.js');window.__ready=true;"],
 '/runtime-config.js':['text/javascript; charset=utf-8',"export const CONFIG={mode:'api',apiBase:'./api/index.php'};"]
};
const DAY=Date.UTC(2026,9,31,9,0,0);
const msgs=(from,n,member)=>Array.from({length:n},(_,i)=>({id:from+i,r:from+i,t:DAY+(from+i)*60000,c:0,b:'Wiadomość '+(from+i),...(member?{a:'PidMarta0001'}:{g:i%5})}));
function chatApi(){
 const api={channels:{'1':msgs(1,40),'2':[],'3':msgs(101,40),'4':[]},tour:{id:null},me:null};
 api.answer=(route,q)=>{
  const member=route==='chat-feed'||route==='chat-channels';
  if(route==='public-config')return [200,{signup:false,billing:false}];
  if(route==='me')return api.me?[200,api.me]:[401,{error:'Zaloguj się ponownie.'}];
  if(route==='public-chat-channels'||route==='chat-channels'){
   const lobby=[['taekwondo','world'],['taekwondo-pl','pl'],['karate','world'],['general','world']].map(([slug,scope],i)=>({id:i+1,slug,scope,st:'open',last:api.channels[i+1].at(-1)?.id||0,count:api.channels[i+1].length}));
   return [200,{cv:1,lobby,tournaments:[{id:api.tour.id,tournamentId:'t-1',title:'Puchar',date:'2099-01-01',city:'Kraków',st:'open',last:0,count:0}],archive:[]}];
  }
  if(route==='public-chat'||route==='chat-feed'){
   const ch={};for(const p of (q.get('ch')||'').split(',').filter(Boolean)){const [id,rev]=p.split(':');const list=(api.channels[id]||[]).map(m=>member?{id:m.id,r:m.r,t:m.t,c:m.c,b:m.b,a:'PidMarta0001'}:m);if(rev==='0')ch[id]={rev:list.at(-1)?.r||0,st:'open',more:false,older:false,m:list};}
   return Object.keys(ch).length?[200,{cv:1,ch,heads:{},...(member?{people:{PidMarta0001:{n:'Marta K.',u:'marta.k'}}}:{})}]:[204,null];
  }
  return [404,{error:'x'}];
 };
 return api;
}
const serveChat=api=>new Promise(resolve=>{
 const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
 const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=decodeURIComponent(u.pathname);
  if(p==='/api/index.php'){const [status,body]=api.answer(u.searchParams.get('route'),u.searchParams);res.writeHead(status,status===204?{}:{'Content-Type':'application/json'});res.end(status===204?undefined:JSON.stringify(body));return;}
  if(HARNESS[p]){res.writeHead(200,{'Content-Type':HARNESS[p][0],'Content-Security-Policy':CSP});res.end(HARNESS[p][1]);return;}
  try{const body=await readFile(join(DIST,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
test('chat.js in a browser: "new messages" per channel, a tournament channel created later, the draft and focus kept across repaints',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:120000},async t=>{
 const api=chatApi(),{server,url}=await serveChat(api);let browser;
 try{browser=await chromium.launch();}catch(error){server.close();t.skip('Chromium cannot start: '+error.message);return;}
 const errors=[];
 const open=async()=>{const ctx=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'block',locale:'pl-PL'});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url+'harness.html');await page.waitForFunction(()=>window.__ready===true);return {ctx,page};};
 const mountPage=(page,id,params)=>page.evaluate(([id,params])=>{window.__chat.mount(document.getElementById(id),'page',{params:new URLSearchParams(params)});},[id,params]);
 try{
  // Guest, two full chats in one tab: a poll with 1 new message in one channel and 3 in the other counts each view's own channel.
  { const {ctx,page}=await open();
    await mountPage(page,'a','c=taekwondo');await mountPage(page,'b','c=karate');
    await page.waitForFunction(()=>['a','b'].every(id=>document.querySelectorAll('#'+id+' .chat-msg').length===40));
    await page.evaluate(()=>{for(const id of ['a','b']){const log=document.querySelector('#'+id+' .chat-log');log.scrollTop=0;log.dispatchEvent(new Event('scroll'));}});
    await page.waitForFunction(()=>['a','b'].every(id=>document.getElementById(id).chatView.pinned===false));
    await page.evaluate(([one,three])=>window.__chat._internals.apply({cv:1,ch:{'1':{rev:41,st:'open',more:false,m:one},'3':{rev:143,st:'open',more:false,m:three}}},{'1':40,'3':140}),[msgs(41,1),msgs(141,3)]);
    assert.deepEqual(await page.evaluate(()=>['a','b'].map(id=>document.querySelector('#'+id+' [data-chat-part="pill"]').textContent)),['Nowe wiadomości: 1','Nowe wiadomości: 3']);
    await ctx.close(); }

  // Guest, tournament tab before the channel exists: once a member posts and the channel appears, the view moves to it.
  { const {ctx,page}=await open();
    await page.evaluate(()=>window.__chat.mount(document.getElementById('t'),'tournament',{tid:'t-1'}));
    await page.waitForFunction(()=>document.getElementById('t').chatView.key==='t:t-1'&&!!document.querySelector('#t .chat-empty'));
    api.tour.id=5;api.channels['5']=msgs(301,2);
    await page.evaluate(()=>window.__chat._internals.ensureLists(true));
    await page.waitForFunction(()=>document.querySelectorAll('#t .chat-msg').length===2);
    assert.equal(await page.evaluate(()=>document.getElementById('t').chatView.key),'5');
    assert.equal(await page.evaluate(()=>window.__chat._state().channels.has('t:t-1')),false,'the virtual entry is gone');
    api.tour.id=null;delete api.channels['5'];await ctx.close(); }

  // Member typing: a language switch and a me refresh within the 300 ms draft delay keep text, focus and caret; switching channel saves it.
  { const {ctx,page}=await open();
    api.me={user:{id:'u1',role:'club'},profile:{publicId:'PidAnna00001',username:'anna',firstName:'Anna',lastName:'K',country:'PL',sports:['taekwondo'],complete:true},access:{full:true,canPost:true,block:null}};
    await page.evaluate(async()=>{window.__ws={user:{id:'u1',role:'club'},tournaments:[]};await window.__me.loadMe();});
    await mountPage(page,'a','c=taekwondo');
    await page.waitForSelector('#a textarea[data-chat-key="1"]');
    const ta='#a textarea';
    await page.type(ta,'Cześć');
    // A real switch: the footer signature changes, the composer is rebuilt from the saved draft with focus and caret restored.
    await page.evaluate(ta=>{document.querySelector(ta).__before=true;window.__i18n.setLanguage('en',{persist:false});window.__registry.emit('language',{lang:'en'});},ta);
    assert.deepEqual(await page.evaluate(ta=>{const t=document.querySelector(ta);return [t.__before,t.value,document.activeElement===t,t.selectionStart,t.placeholder.startsWith('Write in ')];},ta),[undefined,'Cześć',true,5,true],'a new textarea');
    await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
    await page.evaluate(()=>{window.__i18n.setLanguage('pl',{persist:false});window.__registry.emit('language',{lang:'pl'});});
    assert.deepEqual(await page.evaluate(ta=>{const t=document.querySelector(ta);return [t.value,document.activeElement===t,t.selectionStart,t.placeholder.startsWith('Napisz w kanale ')];},ta),['Cześć',true,3,true],'the caret where it was, not at the end');
    await page.keyboard.press('End');
    await page.type(ta,' wszystkim');
    await page.evaluate(()=>window.__me.loadMe({force:true}));
    assert.deepEqual(await page.evaluate(ta=>{const t=document.querySelector(ta);return [t.value,document.activeElement===t,t.selectionStart];},ta),['Cześć wszystkim',true,15]);
    await page.type(ta,'!');
    await page.evaluate(()=>document.querySelector('#a [data-chat-act="open"][data-key="3"]').click());
    await page.waitForSelector('#a textarea[data-chat-key="3"]');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('matdraw.chat.draft.1')),'Cześć wszystkim!','saved under its channel before the rebuild');
    await page.evaluate(()=>document.querySelector('#a [data-chat-act="open"][data-key="1"]').click());
    await page.waitForSelector('#a textarea[data-chat-key="1"]');
    assert.equal(await page.evaluate(()=>document.querySelector('#a textarea').value),'Cześć wszystkim!');
    await page.evaluate(()=>window.__registry.emit('logout'));
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('matdraw.chat.draft.1')),null,'sign-out leaves no draft behind');
    api.me=null;await ctx.close(); }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});
