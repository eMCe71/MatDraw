// PWA interface (plan §9.4, §11 point "pwa-ui"): install card rules, iOS and in-app detection, dismissal memory, the update flow and the
// required update (client-outdated). dist/pwa.js exposes its rules and the update flow as plain functions, so no browser is needed here;
// the DOM wiring was checked by hand in Chromium (see the slice report).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {registry,SafeHtml} from '../dist/registry.js';
import {setLanguage} from '../dist/i18n.js';
import * as pwa from '../dist/pwa.js';
import {KEY,DAY,MUTE_MS,MIN_AGE,SENT_DELAY,ACTIVE_NEED,LOOP_GUARD_MS,CHECK_MS,cleanRecord,muted,refused,inappMuted,visited,createStore,platformOf,inAppBrowser,
 manifestHref,setManifestLanguage,tournamentToday,busyRoute,blocker,dueTrigger,decide,inappDue,shareUrl,createUpdater,updateView,cardView,sheetView,inappView} from '../dist/pwa.js';

const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const POLISH_LETTERS=/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const NOW=Date.UTC(2026,9,31,10,0,0);
setLanguage('pl',{persist:false});

// ---- Context for the card rules: everything permits; each test removes one permission. ----
const ctx=over=>({mode:'api',storage:true,record:cleanRecord({first:'2026-10-01',day:'2026-10-31',days:2},NOW),now:NOW,signedIn:true,standalone:false,inApp:false,firstVisit:false,age:MIN_AGE+1,
 shown:false,screen:false,printing:false,busy:false,modal:false,typing:false,hidden:false,canInstall:true,platform:'android',sentAt:0,activeMs:0,tournamentToday:false,...over});

test('importing pwa.js in Node has no side effects and offers a safe pwa helper (install unavailable)',async()=>{
 const api=registry.use('pwa');
 assert.equal(typeof api.canInstall,'function');assert.equal(api.canInstall(),false);assert.equal(await api.install(),'unavailable');
 assert.equal(pwa.KEY,'matdraw.pwa');
});

// ---- Dismissal memory ----
test('memory: "Not now" silences for 30 days, the third refusal for good; installed is forever',()=>{
 let r=cleanRecord(null,NOW);assert.equal(muted(r,NOW),'');
 r=refused(r,NOW);assert.equal(r.refusals,1);
 assert.equal(muted(r,NOW+MUTE_MS-1),'dismissed');assert.equal(muted(r,NOW+MUTE_MS),'','30 days later prompts may come back');
 r=refused(refused(r,NOW+MUTE_MS),NOW+2*MUTE_MS);assert.equal(r.refusals,3);
 assert.equal(muted(r,NOW+10*MUTE_MS),'never','after the third refusal never again');
 assert.equal(muted({...cleanRecord(null,NOW),installed:NOW},NOW+500*DAY),'installed');
});
test('memory: garbage and future timestamps are cleaned, counters are bounded',()=>{
 assert.deepEqual(cleanRecord('x',NOW),cleanRecord(null,NOW));assert.deepEqual(cleanRecord([],NOW),cleanRecord({},NOW));
 const r=cleanRecord({first:'tomorrow',day:20261031,days:-5,refusals:'3',dismissedAt:NOW+1e12,inappAt:NaN,installed:'yes'},NOW);
 assert.deepEqual(r,{first:null,day:null,days:0,refusals:0,dismissedAt:NOW,inappAt:0,installed:0},'a clock far in the future cannot mute for good');
 assert.equal(cleanRecord({days:1e9,refusals:1e9},NOW).days,9999);assert.equal(cleanRecord({refusals:1e9},NOW).refusals,99);
});
test('memory: visits remember the first day and count signed-in days once per day',()=>{
 let r=visited(cleanRecord(null,NOW),'2026-10-30',false);assert.deepEqual([r.first,r.days,r.day],['2026-10-30',0,null],'a guest visit counts no day of use');
 r=visited(r,'2026-10-30',true);r=visited(r,'2026-10-30',true);assert.equal(r.days,1);
 r=visited(r,'2026-10-31',true);assert.deepEqual([r.first,r.days,r.day],['2026-10-30',2,'2026-10-31']);
});
test('store: round trip, unusable storage reads as null and reports failure, a failing write is not persisted',()=>{
 const mem=new Map(),ok={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,v)};
 const s=createStore(ok,()=>NOW);assert.equal(s.ok,false);
 const written=s.update(r=>refused(r,NOW));assert.equal(written.refusals,1);assert.equal(s.ok,true);assert.equal(JSON.parse(mem.get(KEY)).refusals,1);assert.equal(s.read().refusals,1);
 mem.set(KEY,'{not json');assert.deepEqual(s.read(),cleanRecord(null,NOW),'a corrupt value is an empty record');
 const blocked=createStore({getItem(){throw new TypeError();},setItem(){throw new TypeError();}},()=>NOW);
 assert.equal(blocked.read(),null);assert.equal(blocked.update(r=>r),null);assert.equal(blocked.ok,false);
 const readonly=createStore({getItem:()=>null,setItem(){throw new TypeError();}},()=>NOW);
 assert.equal(readonly.update(r=>refused(r,NOW)),null,'dismissal that cannot be remembered counts as storage failure');assert.equal(readonly.ok,false);
 assert.equal(blocker(ctx({storage:readonly.ok})),'storage','without working storage nothing is shown');
});

// ---- Detection ----
test('platformOf: iPhone, iPad, iPadOS posing as a Mac, Android and desktops',()=>{
 const IPHONE='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
 assert.equal(platformOf({ua:IPHONE,platform:'iPhone',touch:5}),'ios');
 assert.equal(platformOf({ua:'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)',platform:'iPad',touch:5}),'ios');
 assert.equal(platformOf({ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',platform:'MacIntel',touch:5}),'ios','iPadOS reports a Mac with touch');
 assert.equal(platformOf({ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',platform:'MacIntel',touch:0}),'other','a real Mac');
 assert.equal(platformOf({ua:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',platform:'Linux armv81',touch:5}),'android');
 assert.equal(platformOf({ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',platform:'Win32',touch:10}),'other','a Windows touch laptop is a desktop');
 assert.equal(platformOf(),'other');
});
test('inAppBrowser: Instagram, Facebook, Messenger, TikTok, Snapchat, Line, LinkedIn yes; real browsers no',()=>{
 for(const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0.0',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0]','Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]',
  'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36 musical_ly_33.0.0','Mozilla/5.0 (iPhone) Mobile/15E148 BytedanceWebview/d8a21c6','Mozilla/5.0 (iPhone) Mobile Snapchat/12.0',
  'Mozilla/5.0 (Linux; Android 12) Chrome/110 Mobile Safari/537.36 Line/13.0.0','Mozilla/5.0 (iPhone) Mobile/15E148 LinkedInApp','Mozilla/5.0 (iPhone) Mobile/15E148 Messenger'])assert.equal(inAppBrowser(ua),true,ua);
 for(const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1','Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Spline/1','',undefined,null])assert.equal(inAppBrowser(ua),false,String(ua));
});
test('standalone is detected from display-mode and navigator.standalone',()=>{
 const mm=on=>({matchMedia:q=>({matches:on.includes(q)}),navigator:{}});
 assert.equal(pwa.standaloneNow(mm(['(display-mode: standalone)'])),true);assert.equal(pwa.standaloneNow(mm(['(display-mode: minimal-ui)'])),true);
 assert.equal(pwa.standaloneNow(mm([])),false);assert.equal(pwa.standaloneNow({matchMedia:()=>({matches:false}),navigator:{standalone:true}}),true,'iOS');
 assert.equal(pwa.standaloneNow({matchMedia(){throw new TypeError();},navigator:{}}),false,'never throws');
});
test('manifest language: English manifest for en, Polish for everything else, guarded without a document',()=>{
 assert.equal(manifestHref('en'),'./manifest.en.webmanifest');assert.equal(manifestHref('pl'),'./manifest.webmanifest');assert.equal(manifestHref('de'),'./manifest.webmanifest');
 const link={href:'./manifest.webmanifest',getAttribute(k){return k==='href'?this.href:null;},setAttribute(k,v){if(k==='href')this.href=v;}};
 const doc={querySelector:s=>s==='link[rel="manifest"]'?link:null};
 setManifestLanguage('en',doc);assert.equal(link.href,'./manifest.en.webmanifest');setManifestLanguage('pl',doc);assert.equal(link.href,'./manifest.webmanifest');
 assert.doesNotThrow(()=>{setManifestLanguage('en',undefined);setManifestLanguage('en',{});setManifestLanguage('en',{querySelector:()=>null});});
});
test('lang-boot.js switches the manifest for English and leaves Polish and querySelector-less pages alone',()=>{
 const code=read('dist/lang-boot.js');
 const run=(languages,withLink=true,withQuery=true)=>{
  const link={href:'./manifest.webmanifest',setAttribute(k,v){this[k]=v;}},html={lang:'pl'};
  const document={documentElement:html,...(withQuery?{querySelector:s=>s==='link[rel="manifest"]'&&withLink?link:null}:{})};
  vm.runInNewContext(code,{window:{localStorage:{getItem:()=>null},navigator:{languages,language:languages[0]}},document});return {lang:html.lang,href:link.href};
 };
 assert.deepEqual(run(['en-US']),{lang:'en',href:'./manifest.en.webmanifest'});assert.deepEqual(run(['pl-PL']),{lang:'pl',href:'./manifest.webmanifest'});
 assert.equal(run(['en-US'],false).lang,'en','offline.html has no manifest link');assert.equal(run(['en-US'],true,false).lang,'en','no querySelector, no error');
});
test('tournamentToday: the club has entries in a non-draft tournament dated today',()=>{
 const ws=(tournaments,clubId='club-1')=>({user:{clubId},tournaments});
 const t=(date,over={})=>({date,status:'open',entries:[{clubId:'club-1'}],...over});
 assert.equal(tournamentToday(ws([t('2026-10-31')]),'2026-10-31'),true);
 assert.equal(tournamentToday(ws([t('2026-11-01')]),'2026-10-31'),false,'another day');
 assert.equal(tournamentToday(ws([t('2026-10-31',{entries:[{clubId:'club-2'}]})]),'2026-10-31'),false,'another club');
 assert.equal(tournamentToday(ws([t('2026-10-31',{entries:[]})]),'2026-10-31'),false,'no entries');
 assert.equal(tournamentToday(ws([t('2026-10-31',{status:'draft'})]),'2026-10-31'),false);
 assert.equal(tournamentToday(null,'2026-10-31'),false);assert.equal(tournamentToday({user:{clubId:'x'}},'2026-10-31'),false);
});
test('busyRoute: signup and billing routes and the return-from-payment query',()=>{
 for(const [hash,search] of [['#signup',''],['#signup?step=2',''],['#billing',''],['#billing?x=1',''],['#chat','?billing=success&session_id=cs_1'],['','?x=1&billing=cancel']])assert.equal(busyRoute(hash,search),true,hash+search);
 for(const [hash,search] of [['#chat',''],['#profile?tab=security',''],['#signups',''],['#tournaments','?source=pwa'],['','']])assert.equal(busyRoute(hash,search),false,hash+search);
});
test('shareUrl copies origin and path only (no invite token, payment session or route)',()=>{
 assert.equal(shareUrl({origin:'https://matbravo.com',pathname:'/',search:'?billing=success&session_id=cs_live_1',hash:'#signup?invite=secret'}),'https://matbravo.com/');
 assert.equal(shareUrl({origin:'https://x.test',pathname:'/app/'}),'https://x.test/app/');
});

// ---- Install card rules ----
test('card: a fully permitted context has no blocker',()=>assert.equal(blocker(ctx()),''));
test('card: never on the first visit, as a guest, in the demo, standalone, installed or in an in-app browser',()=>{
 assert.equal(blocker(ctx({firstVisit:true})),'first-visit');assert.equal(blocker(ctx({signedIn:false})),'guest');assert.equal(blocker(ctx({mode:'demo'})),'demo');
 assert.equal(blocker(ctx({standalone:true})),'standalone');assert.equal(blocker(ctx({record:cleanRecord({days:3,installed:NOW-DAY},NOW)})),'installed');
 assert.equal(blocker(ctx({inApp:true})),'in-app');assert.equal(blocker(ctx({storage:false})),'storage');
});
test('card: never on #screen, in print, during signup or payment, with a modal, while typing, in a hidden tab, or twice in a session',()=>{
 for(const [key,reason] of [['screen','screen'],['printing','print'],['busy','busy'],['modal','modal'],['typing','typing'],['hidden','hidden'],['shown','shown']])assert.equal(blocker(ctx({[key]:true})),reason,key);
 assert.equal(blocker(ctx({canInstall:false})),'no-path','no deferred prompt and not iOS');
});
test('card: not within the first 15 seconds of a page',()=>{
 assert.equal(blocker(ctx({age:0})),'too-early');assert.equal(blocker(ctx({age:MIN_AGE-1})),'too-early');assert.equal(blocker(ctx({age:MIN_AGE})),'');
});
test('card: dismissal memory is honoured at the boundaries',()=>{
 const dismissed=ago=>ctx({record:cleanRecord({days:3,refusals:1,dismissedAt:NOW-ago},NOW)});
 assert.equal(blocker(dismissed(MUTE_MS-1000)),'dismissed');assert.equal(blocker(dismissed(MUTE_MS)),'');
 assert.equal(blocker(ctx({record:cleanRecord({days:3,refusals:3,dismissedAt:NOW-400*DAY},NOW)})),'never');
});
test('triggers: phone – tournament day, first sent message after 3 s, second day of use, 90 s of active chat',()=>{
 const rec=days=>cleanRecord({first:'2026-10-01',days},NOW);
 assert.equal(dueTrigger(ctx({record:rec(1)})),'','first day of use: nothing');
 assert.equal(dueTrigger(ctx({record:rec(2)})),'second-day');assert.equal(dueTrigger(ctx({record:rec(5)})),'second-day');
 assert.equal(dueTrigger(ctx({record:rec(1),sentAt:NOW-SENT_DELAY+1})),'','3 s have not passed since the message');
 assert.equal(dueTrigger(ctx({record:rec(1),sentAt:NOW-SENT_DELAY})),'chat-sent');
 assert.equal(dueTrigger(ctx({record:rec(1),activeMs:ACTIVE_NEED-1})),'');assert.equal(dueTrigger(ctx({record:rec(1),activeMs:ACTIVE_NEED})),'chat-active');
 assert.equal(dueTrigger(ctx({record:rec(1),tournamentToday:true})),'tournament-day');assert.equal(dueTrigger(ctx({record:rec(3),tournamentToday:true,sentAt:NOW-9e3})),'tournament-day','tournament day wins');
});
test('triggers: desktop – only a return visit (3rd day of use), never chat or tournament signals',()=>{
 const rec=days=>cleanRecord({first:'2026-10-01',days},NOW);
 for(const platform of ['other'])for(const extra of [{},{sentAt:NOW-9e3,activeMs:ACTIVE_NEED,tournamentToday:true}]){
  assert.equal(dueTrigger(ctx({platform,record:rec(1),...extra})),'');assert.equal(dueTrigger(ctx({platform,record:rec(2),...extra})),'');assert.equal(dueTrigger(ctx({platform,record:rec(3),...extra})),'return-visit');
 }
});
test('decide: blockers beat triggers (a chat message on the first visit shows nothing)',()=>{
 assert.deepEqual(decide(ctx({firstVisit:true,sentAt:NOW-9e3})),{reason:'first-visit',trigger:''});
 assert.deepEqual(decide(ctx({sentAt:NOW-9e3})),{reason:'',trigger:'chat-sent'});
 assert.deepEqual(decide(ctx({record:cleanRecord({first:'2026-10-31',days:1},NOW)})),{reason:'',trigger:''},'permitted but nothing due');
 assert.equal(decide(ctx({modal:true,tournamentToday:true})).trigger,'');
 assert.equal(decide(ctx({screen:true,tournamentToday:true})).trigger,'');
 assert.equal(decide(ctx({signedIn:false,tournamentToday:true})).trigger,'','a guest preview of today\'s tournament does not trigger');
});
test('in-app banner: only in the API mode, only in an in-app UA, 7 days of silence after closing, never at first paint',()=>{
 const c=over=>ctx({inApp:true,age:5e3,...over});
 assert.equal(inappDue(c()),true);assert.equal(inappDue(c({age:100})),false,'not on the first paint');assert.equal(inappDue(c({mode:'demo'})),false);
 assert.equal(inappDue(c({inApp:false})),false);assert.equal(inappDue(c({standalone:true})),false);assert.equal(inappDue(c({storage:false})),false,'cannot remember the dismissal');
 assert.equal(inappDue(c({screen:true})),false);assert.equal(inappDue(c({printing:true})),false);
 const closed=ago=>c({record:cleanRecord({inappAt:NOW-ago},NOW)});
 assert.equal(inappMuted(closed(6*DAY).record,NOW),true);assert.equal(inappDue(closed(6*DAY)),false);assert.equal(inappDue(closed(7*DAY)),true);
});

// ---- Templates ----
const html=safe=>{assert.ok(safe instanceof SafeHtml,'templates return SafeHtml');return safe.html;};
test('templates: update, passive and blocking bars; the card for Chromium and iOS; the chip; the sheet; the in-app banner',()=>{
 assert.equal(updateView(null),null);
 const update=html(updateView('update'));assert.match(update,/Dostępna jest nowa wersja MatBravo\./);assert.match(update,/data-pwa-act="refresh"[^>]*>Odśwież</);
 assert.match(html(updateView('passive')),/Wersja została zaktualizowana\./);assert.match(html(updateView('passive')),/data-pwa-act="reload"/);
 const blocking=html(updateView('blocking'));assert.match(blocking,/Wymagana aktualizacja MatBravo\./);assert.match(blocking,/data-pwa-act="update-now"[^>]*>Odśwież teraz</);
 assert.ok(!/data-pwa-act="(?:later|sheet-close)"/.test(blocking),'the blocking bar cannot be dismissed');
 const chromium=html(cardView({trigger:'second-day',kind:'card',ios:false}));
 assert.match(chromium,/aria-labelledby="pwa-card-title"/);assert.match(chromium,/data-pwa-act="install"[^>]*>Zainstaluj</);assert.match(chromium,/data-pwa-act="later"[^>]*>Nie teraz</);assert.ok(!/mascot/.test(chromium),'no mascot on the compact card');
 const ios=html(cardView({trigger:'second-day',kind:'card',ios:true}));assert.match(ios,/data-pwa-act="how"[^>]*>Jak zainstalować\?</);
 assert.match(html(cardView({trigger:'tournament-day',kind:'card'})),/Dziś zawody — miej drabinki pod ręką\./);
 const chip=html(cardView({trigger:'return-visit',kind:'chip'}));assert.match(chip,/class="pwa-chip"/);assert.match(chip,/data-pwa-act="install"[^>]*>Zainstaluj aplikację</);assert.match(chip,/data-pwa-act="later"/);
 const sheet=html(sheetView());assert.match(sheet,/role="dialog" aria-modal="true" aria-labelledby="pwa-sheet-title"/);assert.equal((sheet.match(/<li>/g)||[]).length,3,'three steps');
 assert.match(sheet,/Stuknij ⋯, potem Udostępnij\./);assert.match(sheet,/data-pwa-backdrop/);assert.match(sheet,/data-pwa-act="sheet-close"/);
 const banner=html(inappView({platform:'ios'}));assert.match(banner,/Otwórz w przeglądarce, aby zainstalować MatBravo i pozostać zalogowanym/);assert.match(banner,/Otwórz w Safari/);assert.match(banner,/data-pwa-act="copy"[^>]*>Kopiuj link</);
 assert.match(html(inappView({platform:'android'})),/Otwórz w Chrome/);assert.match(html(inappView({platform:'ios',copied:true})),/Link skopiowany\./);
});
test('templates: the fallback URL is escaped; no inline handlers or scripts anywhere',()=>{
 const evil='https://x.test/"><img src=x onerror=alert(1)>';
 const banner=html(inappView({platform:'android',fallback:evil}));
 assert.ok(!banner.includes('<img'),banner);assert.match(banner,/value="https:\/\/x\.test\/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
 for(const out of [updateView('update'),updateView('passive'),updateView('blocking'),cardView({trigger:'x',kind:'card',ios:true}),cardView({kind:'chip'}),sheetView(),inappView({platform:'ios'})].map(html)){
  assert.ok(!/<script|\son[a-z]+\s*=|javascript:/i.test(out),out);assert.ok(!/(?:src|href)="(?:https?:)?\/\//.test(out),'only own files: '+out);
 }
});
test('English: every template renders without Polish letters',()=>{
 setLanguage('en',{persist:false});
 try{
  const outputs=[updateView('update'),updateView('passive'),updateView('blocking'),cardView({trigger:'second-day',kind:'card',ios:false}),cardView({trigger:'tournament-day',kind:'card',ios:true}),cardView({kind:'chip'}),sheetView(),inappView({platform:'ios',copied:true}),inappView({platform:'android'})].map(html);
  for(const out of outputs)assert.ok(!POLISH_LETTERS.test(out),out);
  assert.match(outputs[0],/A new version of MatBravo is available\./);assert.match(outputs[2],/A MatBravo update is required\./);assert.match(outputs[6],/Tap Share/);assert.match(outputs[7],/Link copied\./);
 }finally{setLanguage('pl',{persist:false});}
});

// ---- Update flow ----
class Worker extends EventTarget{constructor(state='installed'){super();this.state=state;this.sent=[];}postMessage(m){this.sent.push(m);}become(state){this.state=state;this.dispatchEvent(new Event('statechange'));}}
function harness(over={}){
 const log={shown:[],reloads:0,marks:0,timers:[],updates:0},clock={t:NOW},flags={hash:'#tournaments',dirty:false,busy:false,recent:false};
 const sw=new EventTarget();sw.controller=over.controller===undefined?{}:over.controller;sw.registered=[];
 const reg=new EventTarget();reg.waiting=over.waiting||null;reg.installing=null;
 reg.update=async()=>{log.updates++;await reg.onUpdate?.();};
 sw.register=async(url,opts)=>{sw.registered.push([url,opts]);return reg;};
 sw.getRegistration=async()=>over.noRegistration?undefined:reg;
 const env={mode:'api',sw:over.noWorker?null:sw,secure:true,hash:()=>flags.hash,dirty:()=>flags.dirty,busy:()=>flags.busy,reload:()=>{log.reloads++;},show:k=>log.shown.push(k),
  later:(fn,ms)=>log.timers.push([fn,ms]),now:()=>clock.t,recent:()=>flags.recent,mark:()=>{log.marks++;},...over.env};
 return {env,log,clock,flags,sw,reg,updater:createUpdater(env)};
}
const takeControl=sw=>sw.dispatchEvent(new Event('controllerchange'));

test('update flow: registers ./sw.js with updateViaCache none in the API mode only (demo, no worker support or insecure: nothing)',async()=>{
 const a=harness();assert.ok(await a.updater.register());assert.deepEqual(a.sw.registered,[['./sw.js',{scope:'./',updateViaCache:'none'}]]);
 const demo=harness({env:{mode:'demo'}});assert.equal(await demo.updater.register(),null);assert.deepEqual(demo.sw.registered,[],'the demo registers no worker');
 assert.equal(await harness({noWorker:true}).updater.register(),null);assert.equal(await harness({env:{secure:false}}).updater.register(),null);
 const failing=harness();failing.sw.register=async()=>{throw new TypeError();};assert.equal(await failing.updater.register(),null,'never throws');
});
test('update flow: a waiting worker is offered, not applied; "Refresh" sends SKIP_WAITING and only the controllerchange reloads this tab',async()=>{
 const w=new Worker(),{updater,log,sw}=harness({waiting:w});
 await updater.register();assert.deepEqual(log.shown,['update']);assert.deepEqual(w.sent,[],'nothing is applied by itself');assert.equal(log.reloads,0);
 updater.refresh();assert.deepEqual(w.sent,['SKIP_WAITING']);assert.equal(log.reloads,0,'reload waits for the new worker to take control');
 takeControl(sw);assert.equal(log.reloads,1);
 assert.ok(log.timers.some(([,ms])=>ms>0),'a fallback timer reloads if control never changes');
});
test('update flow: updatefound -> installed with a controller offers the update; without a controller (first install) it does not',async()=>{
 const a=harness();await a.updater.register();const w=new Worker('installing');a.reg.installing=w;a.reg.dispatchEvent(new Event('updatefound'));
 w.become('installed');assert.deepEqual(a.log.shown,['update']);
 const first=harness({controller:null});await first.updater.register();const f=new Worker('installing');first.reg.installing=f;first.reg.dispatchEvent(new Event('updatefound'));f.become('installed');
 assert.deepEqual(first.log.shown,[],'the very first install is not an update');
});
test('update flow: another tab updated -> passive notice; the first claim of control is not an update; a refresh in this tab reloads, never shows the notice',async()=>{
 const other=harness();await other.updater.register();takeControl(other.sw);assert.deepEqual(other.log.shown,['passive']);assert.equal(other.log.reloads,0);
 const first=harness({controller:null});await first.updater.register();takeControl(first.sw);assert.deepEqual(first.log.shown,[],'clients.claim() after the first install');
 takeControl(first.sw);assert.deepEqual(first.log.shown,['passive'],'but a later change of controller is announced');
 const mine=harness({waiting:new Worker()});await mine.updater.register();mine.updater.refresh();takeControl(mine.sw);assert.equal(mine.log.reloads,1);assert.deepEqual(mine.log.shown,['update']);
});
test('update flow: reg.update() when the tab becomes visible, at most once an hour',async()=>{
 const {updater,log,clock}=harness();await updater.register();
 await updater.check();assert.equal(log.updates,0,'registered just now');
 clock.t+=CHECK_MS-1;await updater.check();assert.equal(log.updates,0);
 clock.t+=1;await updater.check();assert.equal(log.updates,1);clock.t+=60000;await updater.check();assert.equal(log.updates,1,'once an hour');
 clock.t+=CHECK_MS;await updater.check();assert.equal(log.updates,2);
 await harness().updater.check();
});
test('client-outdated: nothing unsaved and no signup or payment -> the waiting worker gets SKIP_WAITING and the tab reloads after controllerchange',async()=>{
 const w=new Worker(),h=harness({waiting:w});await h.updater.register();
 await h.updater.outdated();
 assert.deepEqual(w.sent,['SKIP_WAITING']);assert.equal(h.log.marks,1);assert.ok(!h.log.shown.includes('blocking'));assert.equal(h.log.reloads,0);
 takeControl(h.sw);assert.equal(h.log.reloads,1);
 await h.updater.outdated();assert.deepEqual(w.sent,['SKIP_WAITING'],'a second event does nothing');
});
test('client-outdated: unsaved forms or a signup/payment in progress -> a blocking bar and no automatic update; "Refresh now" applies it',async()=>{
 for(const flag of ['dirty','busy']){
  const w=new Worker(),h=harness({waiting:w});await h.updater.register();h.log.shown.length=0;h.flags[flag]=true;
  await h.updater.outdated();assert.deepEqual(h.log.shown,['blocking'],flag);assert.deepEqual(w.sent,[],flag+': the form is left alone');assert.equal(h.log.reloads,0);
  await h.updater.applyNow();assert.deepEqual(w.sent,['SKIP_WAITING']);takeControl(h.sw);assert.equal(h.log.reloads,1);
 }
});
test('client-outdated: the update bar is replaced by the blocking one and later offers stay quiet',async()=>{
 const h=harness({waiting:new Worker()});await h.updater.register();h.flags.dirty=true;await h.updater.outdated();
 const w2=new Worker('installing');h.reg.installing=w2;h.reg.dispatchEvent(new Event('updatefound'));w2.become('installed');
 assert.deepEqual(h.log.shown,['update','blocking'],'no second update bar after the blocking one');
});
test('client-outdated on #screen: reloads at once, even with unsaved forms (the hall screen has no fields)',async()=>{
 const w=new Worker(),h=harness({waiting:w});await h.updater.register();h.log.shown.length=0;h.flags.hash='#screen?tournament=t-1&category=c';h.flags.dirty=true;h.flags.busy=true;
 await h.updater.outdated();assert.deepEqual(w.sent,['SKIP_WAITING']);assert.deepEqual(h.log.shown,[],'no bar on the hall screen');takeControl(h.sw);assert.equal(h.log.reloads,1);
});
test('client-outdated without a worker: a plain reload',async()=>{
 const h=harness({noWorker:true});await h.updater.outdated();assert.equal(h.log.reloads,1);
 const none=harness({noRegistration:true});await none.updater.register();none.updater.state.reg=null;await none.updater.outdated();assert.equal(none.log.reloads,1);
});
test('client-outdated with no waiting worker yet: asks for an update, waits for the install, then applies it',async()=>{
 const h=harness();await h.updater.register();const w=new Worker('installing');
 h.reg.onUpdate=()=>{h.reg.installing=w;queueMicrotask(()=>w.become('installed'));};
 await h.updater.outdated();assert.equal(h.log.updates,1);assert.deepEqual(w.sent,['SKIP_WAITING']);
 const none=harness();await none.updater.register();await none.updater.outdated();assert.equal(none.log.reloads,1,'an update check that finds nothing falls back to a reload');
});
test('client-outdated: a reload that did not help is not repeated within a minute (blocking bar instead; silence on #screen)',async()=>{
 const h=harness({waiting:new Worker()});await h.updater.register();h.log.shown.length=0;h.flags.recent=true;
 await h.updater.outdated();assert.deepEqual(h.log.shown,['blocking']);assert.equal(h.log.reloads,0);
 const screen=harness({waiting:new Worker()});await screen.updater.register();screen.flags.recent=true;screen.flags.hash='#screen';await screen.updater.outdated();
 assert.equal(screen.log.reloads,0);assert.deepEqual(screen.log.shown,['update']);
 assert.ok(LOOP_GUARD_MS>=3e4);
});

// ---- Static guarantees ----
test('pwa.js: never touches the network or the server (no counters), never skips waiting by itself, no HTML sinks',()=>{
 const code=read('dist/pwa.js').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:\\])\/\/.*$/gm,'$1');
 assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(code),'no network use');
 assert.ok(!/\bskipWaiting\s*\(/.test(code),'only the page sends SKIP_WAITING, and only on a click or client-outdated');
 assert.equal((code.match(/'SKIP_WAITING'/g)||[]).length,2,'refresh() and applyNow()');
 assert.ok(!/\.innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code));
 assert.ok(/\{scope:'\.\/',updateViaCache:'none'\}/.test(code));
 assert.ok(/'#screen'/.test(code),'#screen is excluded');
});
test('pwa.css: prefixed selectors only, layers 90 and 95 from the tokens, print and reduced motion handled',()=>{
 const css=read('dist/pwa.css').replace(/\/\*[\s\S]*?\*\//g,'');
 assert.match(css,/z-index:var\(--z-pwa-bar,90\)/);assert.match(css,/z-index:var\(--z-pwa-sheet,95\)/);assert.match(read('dist/tokens.css'),/--z-pwa-bar:90;--z-pwa-sheet:95/);
 assert.match(css,/@media print\{#pwa-root\{display:none!important\}\}/);assert.match(css,/body\.print-preview #pwa-root/);assert.match(css,/body\.projection #pwa-root/);
 assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/env\(safe-area-inset-bottom/);
 const selectors=css.replace(/@keyframes [\w-]+\{(?:[^{}]*\{[^{}]*\})+\}/g,'').replace(/@media[^{]*\{/g,'').replace(/\{[^{}]*\}/g,'|').split('|').map(s=>s.replace(/[}]/g,'').trim()).filter(Boolean).flatMap(s=>s.split(','));
 const stray=selectors.map(s=>s.trim()).filter(s=>s&&!/^(?:\.pwa-|#pwa-root|body\.(?:print-preview|projection) #pwa-root|html\[data-standalone\] \.pwa-)/.test(s));
 assert.deepEqual(stray,[],'no global selectors');
});
test('index.html loads pwa.css before brand.css and has #pwa-root after #toast; the dictionary has no entry pwa.js does not use',()=>{
 const index=read('dist/index.html');
 assert.ok(index.indexOf('href="./pwa.css"')>0&&index.indexOf('href="./pwa.css"')<index.indexOf('href="./brand.css"'));assert.match(index,/<div id="toast"[^>]*><\/div><div id="pwa-root"><\/div>/);
 const used=new Set([...read('dist/pwa.js').matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'/g)].map(m=>m[1]));
 return import('../dist/i18n/pwa-en.js').then(({default:dict})=>{
  assert.deepEqual(Object.keys(dict).filter(k=>!used.has(k)),[],'dictionary entries without a use in pwa.js');
  assert.deepEqual([...used].filter(k=>!Object.hasOwn(dict,k)&&k!=='Zamknij'),[],'texts without an English entry');
 });
});
