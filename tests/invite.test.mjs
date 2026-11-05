// The organizer's invitation (docs/plan/PLAN-MATERIALY.md §6): the field cleaning and the strict meta of backend/src/Materials.php
// against dist/invite-data.js (PHP bridge), the views (Materials::view against dist/workspace.js and dist/guest-view.js: the same v),
// the demo domain (tournament.material kind 'invite'), the card's template (escaping, parts left out, the rules link) and, with
// MATDRAW_BROWSER_TESTS=1, the static demo: the editor in the tournament dialog, the styles, unsaved changes, the guest page at 393 px.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,extname,normalize} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {inviteField,inviteCheck,inviteJson,inviteFields,INVITE_FIELDS,INVITE_KEYS,INVITE_STYLES} from '../dist/invite-data.js';
import {initialWorkspace,execute,publicWorkspace,materialMeta,materialsView} from '../dist/workspace.js';
import {publicMaterials} from '../dist/guest-view.js';

const php=process.env.PHP_BIN,skip=!php;
const DIST=fileURLToPath(new URL('../dist/',import.meta.url));
function bridge(input){const r=spawnSync(php,['tests/php-bridge-materials.php'],{input:JSON.stringify(input),encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const sha=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const META={s:'gala',d:{event:'Puchar Polski',dates:'6–7 grudnia 2026',special:'Twimyo Nopi Ap Chagi\nTwimyo Dollyo Chagi',closing:'ZAPRASZAMY!'},at:1793484000};

test('the fields and styles are the server\'s: Bogdan\'s template in its order, three styles',{skip},()=>{
 const out=spawnSync(php,['-r','require "backend/bootstrap.php";echo json_encode([MatDraw\\Materials::INVITE_FIELDS,MatDraw\\Materials::INVITE_STYLES,MatDraw\\Materials::KINDS]);'],{encoding:'utf8'});
 assert.deepEqual(JSON.parse(out.stdout),[INVITE_FIELDS,INVITE_STYLES,['poster','rules','invite']]);
 assert.deepEqual(INVITE_KEYS,['event','venue','street','dates','except','special','women','men','open','close','note','closing','sign']);
});

test('inviteField: PHP and JavaScript clean every field the same way (single-line fields lose line breaks)',{skip},()=>{
 const cases=[['event','  Puchar\r\nPolski  '],['event','A\n\n\nB'],['special','  1. Raz\r\n\r\n\r\n\r\n2. Dwa\t '],['note','Uwaga‮!​'],['venue','é'],['sign',''],['street',5],['nope','x'],['men','Pompki – 30 s\nPodciąganie']];
 assert.deepEqual(bridge({job:'inviteField',cases}),cases.map(([k,v])=>inviteField(k,v)));
 assert.deepEqual(cases.slice(0,4).map(([k,v])=>inviteField(k,v)),['Puchar Polski','A B','1. Raz\n\n\n2. Dwa','Uwaga!']);
});

test('inviteMeta (invite-save) against inviteFields: cleaned, empty fields left out, canonical order, refusals',{skip},()=>{
 const long='x'.repeat(121);
 const cases=[['classic',{note:' Prosimy\r\n',event:'Puchar',sign:''}],['sport',{}],['gala',{event:long}],['neon',{event:'x'}],['classic',['x']],['classic',{bad:'x'}],['classic',{event:7}]];
 const out=bridge({job:'inviteMeta',cases});
 assert.deepEqual(out.map(r=>r.status??200),[200,422,422,422,400,400,400]);
 assert.deepEqual(out[0].ok,{s:'classic',d:{event:'Puchar',note:'Prosimy'}});
 assert.deepEqual(Object.keys(out[0].ok.d),['event','note'],'stored in the template\'s order');
 assert.equal(out[1].error,'Wypełnij co najmniej jedno pole zaproszenia.');assert.equal(out[2].error,'Jedno z pól zaproszenia jest za długie.');assert.equal(out[3].error,'Wybierz szablon zaproszenia.');
 // The client's own check gives the same answers before anything is sent.
 assert.deepEqual(inviteFields(cases[0][1]),{d:{event:'Puchar',note:'Prosimy'},error:null});
 assert.equal(inviteFields({}).error,'empty');assert.equal(inviteFields({event:long}).error,'event');
});

test('the strict meta and the views: the same v in PHP, the demo domain and the guest view; the fields never in a server view',{skip},()=>{
 const bad=[{...META,s:'neon'},{...META,d:{}},{...META,d:{...META.d,event:'A\nB'}},{...META,d:{...META.d,extra:'x'}},{...META,d:{...META.d,note:' x'}},{...META,at:-1},{...META,more:1},{...META,d:{event:'x'.repeat(121)}}];
 const [ok,...rest]=bridge({job:'meta',cases:[{kind:'invite',v:META},...bad.map(v=>({kind:'invite',v}))]});
 assert.deepEqual(ok,{s:'gala',d:{event:'Puchar Polski',dates:'6–7 grudnia 2026',special:'Twimyo Nopi Ap Chagi\nTwimyo Dollyo Chagi',closing:'ZAPRASZAMY!'},at:1793484000});
 assert.deepEqual(rest,bad.map(()=>null));assert.deepEqual(bad.map(v=>inviteCheck(v)),bad.map(()=>null));assert.deepEqual(inviteCheck(META),ok);
 const [view]=bridge({job:'view',cases:[{invite:META}]});
 const v=sha(inviteJson(META));assert.deepEqual(view,{invite:{v,style:'gala'}});
 assert.deepEqual(publicMaterials({invite:META}),{invite:{v,style:'gala'}});
 assert.deepEqual(materialsView({invite:META}),{invite:{v,style:'gala',fields:META.d}},'the demo adds the fields');
});

test('demo domain: the organizer saves and removes the invitation of a tournament he manages; others are refused',()=>{
 let db=initialWorkspace();
 const own=execute(db,'demo-organizer','tournament.save',{name:'Zawody Mikołajkowe',city:'Opole',date:'2027-12-06',mat:'Mata 1',status:'open'});db=own.db;const id=own.result.id;
 let r=execute(db,'demo-organizer','tournament.material',{id,kind:'invite',value:META});db=r.db;
 assert.deepEqual(r.result,{kind:'invite',previous:null});
 const mine=()=>publicWorkspace(db,db.users.find(u=>u.id==='demo-organizer')).tournaments.find(x=>x.id===id);
 assert.deepEqual(mine().invite,{v:sha(inviteJson(META)),style:'gala',fields:META.d});assert.ok(!('materials' in mine()));
 assert.throws(()=>execute(db,'demo-organizer','tournament.material',{id,kind:'invite',value:{...META,d:{event:' x'}}}),e=>e.status===400,'an uncleaned field');
 assert.throws(()=>execute(db,'demo-club','tournament.material',{id:'t-autumn-2026',kind:'invite',value:null}),e=>e.status===403);
 db=execute(db,'demo-organizer','tournament.material',{id,kind:'invite',value:null}).db;assert.ok(!('invite' in mine()));
 assert.deepEqual(materialMeta('invite',initialWorkspace().tournaments[0].materials.invite),initialWorkspace().tournaments[0].materials.invite,'the demo seed is a strict meta');
});

// ---- the card (dist/invite.js needs a DOM only for its events) ----
class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
globalThis.BroadcastChannel=undefined;// me.js would keep the process alive
const {registry,h}=await import('../dist/registry.js');
const {t,setLanguage}=await import('../dist/i18n.js');setLanguage('pl',{persist:false});
registry.provide('ui',{T:t,icon:name=>h`<svg data-icon="${name}"></svg>`});
const I=await import('../dist/invite.js');
test('the card: user text escaped, parts without data left out, lists one item per line, the rules link only with rules',()=>{
 const evil='<img src=x onerror=alert(1)>';
 const html=String(I.renderInvite({event:evil,venue:'Hali "Orbita"',special:'1. Raz\n- Dwa\n\n• Trzy',women:'Pompki'},{style:'sport',t:{id:'t1',name:'X'}}));
 assert.ok(!html.includes('<img'),'no markup from the fields');assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(html,/<article class="inv inv-sport"/);
 assert.deepEqual(I.lines('1. Raz\n- Dwa\n\n• Trzy'),['Raz','Dwa','Trzy']);
 assert.equal((html.match(/<li>/g)||[]).length,4,'three techniques and one test');
 assert.match(html,/Kobiety/);assert.doesNotMatch(html,/Mężczyźni/,'no men\'s list without data');
 assert.doesNotMatch(html,/inv-dates|inv-note|inv-closing|do pobrania/,'no dates, note, closing or rules link without data');
 const withRules=String(I.renderInvite({event:'A'},{t:{id:'t1',name:'X',rules:{v:'a',size:10,type:'pdf',src:'./demo/regulamin-demo.pdf'}}}));
 assert.match(withRules,/class="inv-rules-link"[^>]*>|inv-rules-link/);assert.match(withRules,/do pobrania stąd/);
 assert.match(String(I.renderInvite({},{style:'neon',t:{name:'Nazwa turnieju'}})),/inv-classic[\s\S]*Nazwa turnieju/,'an unknown style is classic; the title falls back to the tournament');
 const d=I.defaults({name:'Puchar',date:'2026-12-06'});assert.equal(d.event,'Puchar');assert.match(d.dates,/6/);assert.equal(d.closing,'ZAPRASZAMY!');
 assert.deepEqual(I.inviteOf({invite:{v:'abc',style:'gala',fields:{event:'A',x:'y',men:7}}}),{v:'abc',style:'gala',fields:{event:'A'}});
});

// ---- browser checks on the static demo ----
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.pdf':'application/pdf','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(DIST,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const PHONE={viewport:{width:393,height:852},isMobile:true,hasTouch:true};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
test('static demo: create an invitation in the dialog, pick a style, unsaved changes ask first, the guest page shows it (desktop and 393 px)',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:240000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch();
 try{
  for(const options of [{viewport:{width:1440,height:900}},PHONE]){
   const phone=!!options.isMobile,ctx=await browser.newContext({...options,locale:'pl-PL',serviceWorkers:'block'});
   await ctx.addInitScript(()=>{try{localStorage.setItem('matdraw.language','pl');}catch{}});
   const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('dialog',d=>{errors.push('dialog '+d.message());d.dismiss();});
   await page.goto(url);await page.click('[data-action="demo-login"][data-role="admin"]');await page.waitForSelector('.app-shell');
   await page.click('main .tournament-card-actions [data-action="edit-tournament"][data-id="t-winter-2027"]');await page.waitForSelector('#tournament-form .mat-invite');
   assert.match(await page.textContent('.mat-invite'),/Utwórz zaproszenie/);
   await page.click('.mat-invite [data-action="invite-edit"]');await page.waitForSelector('.inv-editor[role="dialog"]');
   assert.equal(await page.evaluate(()=>document.activeElement?.id),'inv-f-event','focus on the first field');
   assert.equal(await page.inputValue('#inv-f-event'),'Puchar Zimy 2027','prefilled with the tournament\'s name');
   assert.equal(await page.inputValue('#inv-f-closing'),'ZAPRASZAMY!');
   await page.fill('#inv-f-venue','Hali <b>Orbita</b>');await page.fill('#inv-f-special','Twimyo Nopi Ap Chagi\nTwimyo Dollyo Chagi');
   await page.click('.inv-style-gala');
   if(phone){assert.equal(await overflow(page),0,'the editor fits 393 px');await page.click('[data-inv-view="preview"]');}
   await page.waitForFunction(()=>document.querySelector('[data-inv-preview] .inv-gala')?.textContent.includes('Hali <b>Orbita</b>'));
   // Escape with unsaved changes asks first; "Wróć do edycji" keeps them.
   await page.keyboard.press('Escape');await page.waitForSelector('[data-inv-confirm]:not([hidden])');
   await page.click('[data-inv="stay"]');assert.equal(await page.locator('.inv-editor').count(),1);
   if(phone)await page.click('[data-inv-view="form"]');
   await page.click('[data-inv="save"]');await page.waitForFunction(()=>!document.querySelector('.inv-editor'));
   await page.waitForSelector('.mat-invite.has-file');assert.match(await page.textContent('.mat-invite'),/Szablon: Gala/);
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));
   await page.evaluate(()=>document.querySelector('[data-action="logout"]')?.click());await page.waitForSelector('[data-action="demo-login"]');
   await page.goto(url+'#guest?t=t-winter-2027');await page.click('.promo [data-action="close-modal"]').catch(()=>{});
   await page.waitForSelector('.inv-section .inv-gala');
   const card=await page.textContent('.inv-section');
   assert.match(card,/Puchar Zimy 2027/);assert.match(card,/Hali <b>Orbita<\/b>/);assert.match(card,/Twimyo Dollyo Chagi/);assert.match(card,/ZAPRASZAMY!/);
   if(phone)assert.equal(await overflow(page),0,'the guest page with the invitation fits 393 px');
   // The demo tournament's seeded invitation (classic) links its rules.
   await page.goto(url+'#guest?t=t-autumn-2026');await page.reload();await page.click('.promo [data-action="close-modal"]').catch(()=>{});await page.waitForSelector('.inv-section .inv-classic .inv-rules-link');
   assert.deepEqual(errors,[]);await ctx.close();
  }
 }finally{await browser.close();server.close();}
});
