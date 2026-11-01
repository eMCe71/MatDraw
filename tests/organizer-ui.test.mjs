// Organizer in the existing interface (PLAN-REJESTRACJA-ROLE §4.6, §10.4, §10.7): roles in the registry, the club picker (pure parts and,
// in a browser, the keyboard), the password confirmation that retries a request once, and the structure of app.js. Browser checks
// (Playwright + Chromium) run with MATDRAW_BROWSER_TESTS=1: the static demo (organizer, editor, copy link, club picker) and the API mode
// against a stub server (reauth prompt at start-up, a wrong and a right password, cancelling; the hall screen's polling under page.clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
const {registry,SafeHtml}=await import('../dist/registry.js');
const {setLanguage}=await import('../dist/i18n.js');setLanguage('pl',{persist:false});
const picker=await import('../dist/club-picker.js');
const Client=await import('../dist/client.js');
const DIST=fileURLToPath(new URL('../dist/',import.meta.url));
const app=readFileSync(DIST+'app.js','utf8');

test('communityOnly, defaultPage(role,user) and visible(user): an organizer works in the workspace, other members do not',()=>{
 const org={role:'member',caps:{organizer:true}},blocked={role:'member',caps:{organizer:false,organizerBlocked:true}},athlete={role:'member',caps:{athlete:true}};
 assert.deepEqual([org,blocked,athlete,{role:'member'},{role:'club'},{role:'admin'}].map(registry.communityOnly),[false,true,true,true,false,false]);
 assert.equal(registry.defaultPage('member',org),'tournaments');assert.equal(registry.defaultPage('admin',{role:'admin'}),'tournaments');
 registry.registerPage({id:'chat',label:'Czat',nav:'global',roles:['admin','editor','club','member'],order:10,render:()=>registry.h``});
 registry.registerPage({id:'qa-starts',label:'Moje starty',nav:'global',roles:['member'],order:15,visible:u=>!!u?.caps?.athlete,render:()=>registry.h``});
 assert.equal(registry.defaultPage('member',athlete),'chat');assert.equal(registry.defaultPage('member',blocked),'chat','a blocked organizer is a member like others');
 assert.deepEqual(registry.navItems(athlete).map(x=>x.id),['chat','qa-starts']);assert.deepEqual(registry.navItems(org).map(x=>x.id),['chat']);
 assert.ok(registry.allows(registry.page('qa-starts'),'member',athlete)&&!registry.allows(registry.page('qa-starts'),'member',org)&&!registry.allows(registry.page('qa-starts'),'admin',{role:'admin',caps:{athlete:true}}));
});

test('final review F9: the tournament summary labels do not depend on the count (no genitive plural after 1)',()=>{
 const summary=app.slice(app.indexOf('<div class="workspace-summary">'),app.indexOf('${firstRun}'));
 assert.ok(summary.length>0);
 for(const bad of ['Moich turniejów','Turniejów','Zawodników klubu','Moich zawodników','Otwartych zapisów'])assert.ok(!summary.includes("T('"+bad+"')"),bad);
 for(const good of ['Moje turnieje','Turnieje','Zawodnicy klubu','Moi zawodnicy','W bazie zawodników','Otwarte zapisy'])assert.ok(summary.includes("T('"+good+"')"),good);
});
test('app.js uses the roles: communityOnly in the shell, render, the hall screen polling and rerenderLanguage; mount points for wave 3',()=>{
 const shell=app.slice(app.indexOf('function shell('),app.indexOf('function roundName('));
 assert.match(shell,/member=communityOnly\(user\)/);assert.match(shell,/home=registry\.defaultPage\(user\.role,user\)/);
 const render=app.slice(app.indexOf('function render(){'),app.indexOf('function memberHome('));
 assert.match(render,/member=communityOnly\(user\)/);assert.match(render,/registry\.allows\(found,role,user\)/,'visible(user) applies to registered pages');
 assert.match(app,/setInterval\(async\(\)=>\{if\(workspace&&!communityOnly\(workspace\.user\)&&location\.hash\.startsWith\('#screen'\)/);
 assert.match(app,/Client\.bootstrap\(t\.id&&Number\.isInteger\(t\.rev\)\?\{t:t\.id,rev:t\.rev\}:\{\}\)/);assert.match(app,/if\(next\?\.unchanged\)\{if\(!ui\.screenAuto\)return;\}/,'an unchanged answer keeps the picture');
 assert.match(app,/else if\(location\.hash\.startsWith\('#screen'\)&&!communityOnly\(workspace\.user\)/);
 assert.ok(!/member=role==='member'|member=user\.role==='member'/.test(shell+render)&&!/workspace\.user\.role!=='member'&&location/.test(app),'no role test that would treat an organizer as a plain member');
 assert.match(app,/import '\.\/athlete-boot\.js';import '\.\/settings-boot\.js';/);
 assert.match(app,/<div class="athlete-cta-mount" data-athlete-cta data-tournament-id="\$\{esc\(g\.id\)\}"><\/div>/);
 assert.match(app,/data-tournament-admin="\$\{esc\(t\.id\)\}"/);
 assert.match(app,/bracket:\(category,\{highlight=null\}=\{\}\)=>trustedHtml\(publicBracket\(category,highlight\)\)/);
 const index=readFileSync(DIST+'index.html','utf8');assert.match(index,/<link rel="stylesheet" href="\.\/athlete\.css"><link rel="stylesheet" href="\.\/settings\.css">/);
 for(const f of ['athlete-boot.js','settings-boot.js','athlete.css','settings.css'])assert.ok(readFileSync(DIST+f,'utf8').length>0,f);
});

test('tournamentForm defaults per role (R11, UX-4): an organizer opens entries with self-entry, staff keep a draft',()=>{
 const form=app.slice(app.indexOf('function tournamentForm('),app.indexOf('function databasePage('));
 assert.match(form,/\|\|\{name:'',city:'',date:'',status:org\?'open':'draft',mat:T\('Mata 1'\),selfEntry:org\}/);
 assert.match(form,/<input type="checkbox" name="selfEntry" \$\{t\.selfEntry\?'checked':''\}>/);
 assert.match(form,/<select name="status" \$\{hidden\?'disabled':''\}>/,'a hidden tournament keeps its status');
 assert.match(app,/selfEntry:f\.has\('selfEntry'\)/);
});

test('integration QA: the PHP bootstrap user (caps only, no organizer field) manages its own tournaments and profiles in the browser',async()=>{
 const W=await import('../dist/workspace.js');
 // workspace.user from the PHP bootstrap carries caps {organizer, organizerBlocked} and no organizer/organizerBlockedAt fields.
 const php={id:'u1',role:'member',clubId:null,caps:{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false}};
 const own={id:'t1',createdBy:'u1',status:'open',community:true,trusted:true,selfEntry:true},other={...own,id:'t2',createdBy:'u2'};
 assert.equal(W.organizer(php),true,'caps.organizer counts without the DB fields');
 assert.equal(W.managesTournament(php,own),true,'the own tournament: copy link, settings, check-in');assert.equal(W.managesTournament(php,other),false);
 assert.equal(W.organizer({...php,caps:{organizer:false,organizerBlocked:true}}),false,'a blocked organizer');
 assert.equal(W.organizer({...php,caps:{organizer:true,organizerBlocked:true}}),false);
 assert.equal(W.organizer({id:'u1',role:'member',caps:{athlete:true}}),false);assert.equal(W.organizer({...php,role:'club'}),false);
 // Domain-shaped users (demo db.users, the actors of execute) keep their fields as the source, also against stale caps.
 assert.equal(W.organizer({role:'member',organizer:true,organizerBlockedAt:null}),true);
 assert.equal(W.organizer({role:'member',organizer:true,organizerBlockedAt:5,caps:{organizer:true}}),false);
 assert.equal(W.organizer({role:'member',organizer:false,organizerBlockedAt:null,caps:{organizer:true}}),false);
});

test('club picker: list, filter by key, "did you mean", result shapes {id}/{name}/{none:true}',()=>{
 const clubs=[{id:'c2',name:'UKS Smok Kraków'},{id:'unaffiliated',name:'Niezrzeszony'},{id:'c1',name:'TKD Warszawa'},{id:'c3',name:'Stary klub',mergedInto:'c1'},{id:'c4',name:'Klub Nowy',verified:false},{id:'c5',name:'Krakowska Akademia'}];
 const list=picker.listClubs(clubs);
 assert.deepEqual(list.map(c=>c.id),['c4','c5','c1','c2'],'sorted by name, without merged clubs and without "Niezrzeszony" (its own option)');
 assert.deepEqual(picker.filterClubs(list,'krak').map(c=>c.id),['c5','c2'],'key prefix first, then containing');
 assert.deepEqual(picker.filterClubs(list,'KRAKÓW').map(c=>c.id),['c5','c2'],'case and Polish letters do not matter');
 assert.deepEqual(picker.filterClubs(list,'').length,4);assert.deepEqual(picker.filterClubs(list,'zzz'),[]);
 assert.equal(picker.suggestClub(list,'tkd  warszawa ')?.id,'c1');assert.equal(picker.suggestClub(list,'tkd war')?.id,'c1');assert.equal(picker.suggestClub(list,'smok')?.id,'c2');
 assert.equal(picker.suggestClub(list,'x'),null);assert.equal(picker.suggestClub(list,'Orły Gdańsk'),null);
 assert.deepEqual(picker.clubChoice({mode:'list',id:'c1'}),{id:'c1'});assert.deepEqual(picker.clubChoice({mode:'new',name:'  Nowy Klub '}),{name:'Nowy Klub'});
 assert.deepEqual(picker.clubChoice({mode:'none'}),{none:true});assert.deepEqual(picker.clubChoice({mode:'list',id:'unaffiliated'}),{none:true});
 assert.equal(picker.clubChoice({mode:'list',id:''}),null);assert.equal(picker.clubChoice({mode:'new',name:'  '}),null);assert.equal(picker.clubChoice({}),null);
});

test('club picker keyboard (ARIA 1.2 combobox): arrows open and move, Home/End, Enter picks, Escape closes then clears',()=>{
 const k=(s,key)=>{const r=picker.comboKey(s,key);return [r.open,r.active,r.pick,r.clear,r.handled];};
 assert.deepEqual(k({open:false,active:-1,count:3},'ArrowDown'),[true,0,null,false,true]);
 assert.deepEqual(k({open:true,active:0,count:3},'ArrowDown'),[true,1,null,false,true]);
 assert.deepEqual(k({open:true,active:2,count:3},'ArrowDown'),[true,2,null,false,true],'stays on the last option');
 assert.deepEqual(k({open:false,active:-1,count:3},'ArrowUp'),[true,2,null,false,true],'ArrowUp opens on the last option');
 assert.deepEqual(k({open:true,active:0,count:3},'ArrowUp'),[true,0,null,false,true]);
 assert.deepEqual(k({open:true,active:1,count:3},'End'),[true,2,null,false,true]);assert.deepEqual(k({open:true,active:2,count:3},'Home'),[true,0,null,false,true]);
 assert.deepEqual(k({open:false,active:-1,count:3},'Home'),[false,-1,null,false,false],'closed: Home/End move the caret');
 assert.deepEqual(k({open:true,active:1,count:3},'Enter'),[false,1,1,false,true]);
 assert.deepEqual(k({open:true,active:-1,count:3},'Enter'),[true,-1,null,false,false],'Enter without an active option submits the form');
 assert.deepEqual(k({open:true,active:1,count:3},'Escape'),[false,-1,null,false,true]);assert.deepEqual(k({open:false,active:-1,count:3},'Escape'),[false,-1,null,true,true]);
 assert.deepEqual(k({open:false,active:-1,count:0},'ArrowDown'),[true,-1,null,false,true],'no options: the list opens with "no matching clubs"');
 assert.deepEqual(k({open:true,active:0,count:3},'a'),[true,0,null,false,false]);
});

test('club picker markup: a native select below the threshold, a combobox from it; names escaped; no new club at check-in',()=>{
 const clubs=[{id:'c1',name:'TKD <b>Warszawa</b>'},{id:'c2',name:'Klub "B"',verified:false},{id:'unaffiliated',name:'Niezrzeszony'}];
 const select=picker.pickerHtml({name:'club',clubs,value:{id:'c1'}});assert.ok(select instanceof SafeHtml);const s=String(select);
 assert.match(s,/<fieldset class="club-picker span-two" data-club-picker data-name="club"/);
 assert.equal((s.match(/type="radio" name="clubMode"/g)||[]).length,3);assert.match(s,/value="list" checked/);
 assert.match(s,/<select id="cp-club-select" name="clubId" data-cp-select>/);assert.match(s,/<option value="c1" selected>TKD &lt;b&gt;Warszawa&lt;\/b&gt;<\/option>/);
 assert.match(s,/Klub &quot;B&quot; · niezweryfikowany/);assert.ok(!s.includes('value="unaffiliated"'),'"Niezrzeszony" is the radio option');
 assert.match(s,/data-cp-panel="new" hidden/);assert.match(s,/data-cp-panel="none" hidden/);
 const combo=String(picker.pickerHtml({name:'club',clubs,value:{none:true},threshold:2}));
 assert.match(combo,/<input id="cp-club-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cp-club-list"/);
 assert.match(combo,/<ul id="cp-club-list" class="cp-list" role="listbox" aria-label="Kluby" hidden data-cp-list><\/ul><input type="hidden" name="clubId" value="" data-cp-value>/);
 assert.match(combo,/value="none" checked/);assert.match(combo,/aria-live="polite" data-cp-status/);
 const fresh=String(picker.pickerHtml({name:'club',clubs,value:{name:'Mój <klub>'}}));assert.match(fresh,/value="new" checked/);assert.match(fresh,/value="Mój &lt;klub&gt;"/);
 const check=String(picker.pickerHtml({name:'entryClub',clubs,value:{id:'c2'},allowNew:false,legend:'Klub w zgłoszeniu'}));
 assert.ok(!check.includes('value="new"')&&!check.includes('data-cp-name'));assert.match(check,/<legend>Klub w zgłoszeniu<\/legend>/);
 assert.equal(picker.readPicker(null),null);
});

test('password confirmation (§4.6): a 401 reauth asks once and the request runs exactly once more',async()=>{
 const reauth=()=>Object.assign(new Error('Potwierdź hasło, aby otworzyć narzędzia organizatora.'),{status:401,code:'reauth'});
 let calls=0,asked=0;const ok=await Client.withReauth(async()=>{calls++;if(calls===1)throw reauth();return 'data';},async e=>{asked++;assert.equal(e.code,'reauth');return true;});
 assert.deepEqual([ok,calls,asked],['data',2,1]);
 calls=0;asked=0;await assert.rejects(Client.withReauth(async()=>{calls++;throw reauth();},async()=>{asked++;return true;}),e=>e.code==='reauth');
 assert.deepEqual([calls,asked],[2,1],'a second refusal is not retried again');
 calls=0;asked=0;await assert.rejects(Client.withReauth(async()=>{calls++;throw reauth();},async()=>{asked++;return false;}),e=>e.code==='reauth');
 assert.deepEqual([calls,asked],[1,1],'a cancelled prompt does not retry');
 calls=0;asked=0;await assert.rejects(Client.withReauth(async()=>{calls++;throw Object.assign(new Error('Zaloguj się ponownie.'),{status:401});},async()=>{asked++;return true;}),e=>e.status===401&&!e.code);
 assert.deepEqual([calls,asked],[1,0],'an expired session is not a password prompt');
 await assert.rejects(Client.withReauth(async()=>{throw reauth();}),e=>e.code==='reauth','without a prompt the error passes');
 assert.equal(await Client.withReauth(async()=>7,async()=>{throw new Error('never');}),7);
 // app.js wires it to commit, every reload of the workspace and the start-up.
 assert.match(app,/Client\.withReauth\(\(\)=>Client\.command\(type,payload,expected\),askPassword\)/);
 assert.match(app,/const reload=\(\)=>Client\.withReauth\(\(\)=>Client\.bootstrap\(\),askPassword\);/);
 assert.match(app,/workspace=await Client\.withReauth\(\(\)=>Client\.init\(\),askPassword\)/);
 assert.match(app,/if\(error\.status===401&&error\.code==='reauth'\)\{[^\n]*return;\}\/\/ a cancelled password prompt: the session stays/,'a cancelled prompt never signs out');
});

test('review round 1: registered pages with visible(user) render, the club of an edited profile is kept, check-in retry and screen polling',()=>{
 const render=app.slice(app.indexOf('function render(){'),app.indexOf('function memberHome('));
 assert.match(render,/reg=found&&registry\.allows\(found,role,user\)\?found:null,app=document\.querySelector\('#app'\);let own=!!reg;/,'own follows the check made with the user');
 assert.ok(!/registry\.allows\(reg,role\)/.test(render),'no second check without the user (visible(null) would hide the page)');
 const form=app.slice(app.indexOf('function profileForm('),app.indexOf('function toggleConsent('));
 assert.match(form,/const lockClub=!!id&&user\.role!=='admin';/);assert.match(form,/disabled:lockClub\}\)\)\+\(lockClub\?`<p class="muted small span-two club-locked">\$\{T\('Klub zawodnika może zmienić Administrator\.'\)\}<\/p>`:''\)/);
 assert.match(app,/if\(picker&&old\?\.clubId&&workspace\.user\.role!=='admin'\)club=\{id:old\.clubId\};else if\(old\?\.clubId===UNAFFILIATED&&club\?\.none\)club=\{id:UNAFFILIATED\};/,'"Niezrzeszony" again keeps the pending club name');
 assert.match(app,/for\(const el of \[form,form\.closest\('\.modal'\)\]\)if\(el\)el\.dataset\.revision=workspace\.revision;\}/,'after entry.save the retry of the check-in uses the new revision');
 assert.match(app,/location\.hash\.startsWith\('#screen'\)&&fullView\(workspace\.user,state\.tournament\)&&!screenPaused&&!unlocking&&!screenBusy\)\{screenBusy=true;try\{/,'no tick while a prompt is open or a tick still waits (review round 2)');
 assert.match(app,/catch\(error\)\{if\(error\?\.status===401&&error\.code==='reauth'\)screenPaused=true;await handleError\(error\);\}finally\{screenBusy=false;\}\}\},15000\);/,'a cancelled prompt on the hall screen stops the polling');
 assert.match(app,/addEventListener\('hashchange',\(\)=>\{document\.body\.classList\.remove\('print-preview'\);screenPaused=false;/);assert.match(app,/await Client\.unlock\(new FormData\(form\)\.get\('password'\)\);screenPaused=false;unlockFinish/);
 const chat=readFileSync(DIST+'chat-boot.js','utf8');assert.match(chat,/id:'event-chat'[^\n]*visible:u=>!registry\.communityOnly\(u\)/);
});

// ---- Browser checks ----
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
/** Static server of dist/; api (optional) answers /api/index.php and switches runtime-config.js to the API mode. */
const serve=api=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');let p=decodeURIComponent(u.pathname);if(p.endsWith('/'))p+='index.html';
  if(api&&p==='/api/index.php'){let body='';for await(const c of req)body+=c;const [status,out]=api(u.searchParams.get('route'),req.method,body?JSON.parse(body):null);res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(out));return;}
  if(api&&p==='/runtime-config.js'){res.writeHead(200,{'Content-Type':TYPES['.js'],'Content-Security-Policy':CSP});res.end("export const CONFIG={mode:'api',apiBase:'./api/index.php'};");return;}
  if(p==='/sw.js'){res.writeHead(404);res.end();return;}
  try{const body=await readFile(join(DIST,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('demo in a browser: organizer and editor defaults, copy link with its fallback, the club picker by keyboard',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:180000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 const open=async({clipboard}={})=>{const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'});
  await ctx.addInitScript(mode=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));
   if(mode){window.__copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:mode==='deny'?async()=>{throw new DOMException('denied','NotAllowedError');}:async t=>{window.__copied.push(t);}}});}},clipboard||null);
  const page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,200));});await page.goto(url);await page.waitForSelector('.login-page');return {ctx,page};};
 try{
  // Editor: a new tournament stays a draft without self-entry.
  {const {ctx,page}=await open();await page.click('[data-action="demo-login"][data-role="editor"]');await page.waitForSelector('.tournament-grid');
   await page.click('.heading-actions [data-action="new-tournament"]');await page.waitForSelector('#tournament-form');
   assert.deepEqual(await page.evaluate(()=>[document.querySelector('#tournament-form [name=status]').value,document.querySelector('#tournament-form [name=selfEntry]').checked]),['draft',false]);await ctx.close();}
  // Organizer: lands on "Moje turnieje" with the first-run card; a new tournament opens with self-entry; copy link (clipboard and fallback).
  {const {ctx,page}=await open({clipboard:'deny'});await page.click('[data-action="demo-login"][data-role="organizer"]');await page.waitForSelector('.first-run');
   assert.equal(await page.evaluate(()=>location.hash),'#tournaments');assert.equal(await page.locator('h1').innerText(),'Moje turnieje');
   assert.equal(await page.locator('.nav-link[data-page="database"]').innerText(),'Moi zawodnicy');
   await page.click('.heading-actions [data-action="new-tournament"]');await page.waitForSelector('#tournament-form');
   assert.deepEqual(await page.evaluate(()=>[document.querySelector('#tournament-form [name=status]').value,document.querySelector('#tournament-form [name=selfEntry]').checked]),['open',true]);
   await page.fill('#tournament-form [name=name]','Puchar Organizatora');await page.fill('#tournament-form [name=date]','2027-03-14');await page.fill('#tournament-form [name=city]','Opole');
   await page.click('button[form="tournament-form"]');await page.waitForSelector('[data-action="copy-link"]');
   const id=await page.locator('[data-action="copy-link"]').first().getAttribute('data-id');
   // Final review F9: the summary labels are headings in the nominative, right for any count ("1 Moich turniejów" was wrong).
   assert.deepEqual(await page.locator('.workspace-summary span').allInnerTexts(),['Moje turnieje','Moi zawodnicy','Otwarte zapisy']);
   assert.equal(await page.locator('.workspace-summary strong').first().innerText(),'1');
   await page.click('[data-action="copy-link"]');await page.waitForSelector('#copy-link-field');
   assert.deepEqual(await page.evaluate(()=>{const f=document.querySelector('#copy-link-field');return [f.value,f.readOnly,f.selectionStart,f.selectionEnd===f.value.length];}),[url+'#guest?t='+id,true,0,true],'fallback: the address selected in a read-only field');
   await page.keyboard.press('Escape');await ctx.close();
   const ok=await open({clipboard:'allow'});
   await ok.page.click('[data-action="demo-login"][data-role="organizer"]');await ok.page.waitForSelector('.first-run');
   await ok.page.click('.heading-actions [data-action="new-tournament"]');await ok.page.fill('#tournament-form [name=name]','Puchar Linku');await ok.page.fill('#tournament-form [name=date]','2027-03-20');await ok.page.fill('#tournament-form [name=city]','Opole');
   await ok.page.click('button[form="tournament-form"]');await ok.page.waitForSelector('[data-action="copy-link"]');await ok.page.click('[data-action="copy-link"]');
   await ok.page.waitForFunction(()=>document.querySelector('#toast').textContent==='Link skopiowany.');
   assert.match((await ok.page.evaluate(()=>window.__copied))[0],/#guest\?t=[0-9a-f]{32}$/);assert.equal(await ok.page.locator('#copy-link-field').count(),0);
   assert.deepEqual(await ok.page.evaluate(()=>window.__csp),[]);await ok.ctx.close();}
  // Club picker as a combobox (threshold 0): keyboard and the result shapes.
  {const {ctx,page}=await open();
   const r=await page.evaluate(async()=>{const P=await import('./club-picker.js'),{setHtml}=await import('./registry.js');const box=document.createElement('form');box.id='cp-test';document.body.append(box);
    setHtml(box,P.pickerHtml({name:'club',clubs:[{id:'c1',name:'TKD Warszawa'},{id:'c2',name:'UKS Smok Kraków'},{id:'c3',name:'Krakowska Akademia'}],threshold:0}));return P.readPicker(box.querySelector('[data-club-picker]'));});
   assert.equal(r,null,'nothing chosen yet');
   const input=page.locator('#cp-test [role="combobox"]');await input.focus();await page.keyboard.type('krak');
   const state=()=>page.evaluate(()=>{const i=document.querySelector('#cp-test [role="combobox"]'),opts=[...document.querySelectorAll('#cp-test [role="option"]')];return {expanded:i.getAttribute('aria-expanded'),options:opts.map(o=>o.textContent),active:i.getAttribute('aria-activedescendant'),selected:opts.findIndex(o=>o.getAttribute('aria-selected')==='true'),value:i.value};});
   let s=await state();assert.deepEqual([s.expanded,s.options,s.selected],['true',['Krakowska Akademia','UKS Smok Kraków'],-1]);
   await page.keyboard.press('ArrowDown');s=await state();assert.equal(s.selected,0);assert.equal(s.active,'cp-club-list-o0');
   await page.keyboard.press('End');assert.equal((await state()).selected,1);await page.keyboard.press('Home');assert.equal((await state()).selected,0);
   await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');s=await state();assert.deepEqual([s.expanded,s.value],['false','UKS Smok Kraków']);
   assert.deepEqual(await page.evaluate(async()=>(await import('./club-picker.js')).readPicker(document.querySelector('#cp-test [data-club-picker]'))),{id:'c2'});
   await page.keyboard.press('ArrowDown');assert.equal((await state()).expanded,'true');await page.keyboard.press('Escape');s=await state();assert.deepEqual([s.expanded,s.value],['false','UKS Smok Kraków'],'Escape closes the list first');
   await page.keyboard.press('Escape');assert.equal((await state()).value,'','a second Escape clears the field');
   assert.equal(await page.evaluate(async()=>(await import('./club-picker.js')).readPicker(document.querySelector('#cp-test [data-club-picker]'))),null);
   await page.check('#cp-test [data-cp-mode][value="new"]');assert.ok(await page.isVisible('#cp-test [data-cp-name]'));await page.fill('#cp-test [data-cp-name]','tkd warsz');
   await page.waitForSelector('#cp-test [data-cp-match]:not([hidden])');assert.match(await page.locator('#cp-test [data-cp-match]').innerText(),/Czy chodzi o: TKD Warszawa\?/);
   await page.click('#cp-test [data-cp-use]');assert.deepEqual(await page.evaluate(async()=>(await import('./club-picker.js')).readPicker(document.querySelector('#cp-test [data-club-picker]'))),{id:'c1'},'"did you mean" selects the club from the list');
   await page.check('#cp-test [data-cp-mode][value="new"]');await page.fill('#cp-test [data-cp-name]','Orły Opole');
   assert.deepEqual(await page.evaluate(async()=>(await import('./club-picker.js')).readPicker(document.querySelector('#cp-test [data-club-picker]'))),{name:'Orły Opole'});
   await page.check('#cp-test [data-cp-mode][value="none"]');assert.deepEqual(await page.evaluate(async()=>(await import('./club-picker.js')).readPicker(document.querySelector('#cp-test [data-club-picker]'))),{none:true});
   await ctx.close();}
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('API mode in a browser: a reauth at start-up asks for the password, a wrong one stays in the dialog, the right one retries bootstrap once; cancel keeps the session',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const user={id:'u-org',clubId:null,email:'org@example.test',role:'member',active:true,organizer:true,caps:{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false}};
 const ws={schemaVersion:2,revision:7,user,clubs:[{id:'unaffiliated',name:'Niezrzeszony',verified:true}],users:[],profiles:[],tournaments:[{id:'t1',name:'Turniej Organizatora',city:'Opole',date:'2099-03-14',mat:'Mata 1',status:'open',createdBy:'u-org',selfEntry:true,rev:7,community:true,trusted:true,hidden:false,hideReason:null,entries:[],draws:{},activity:[]}]};
 const log=[];let unlocked=false;
 const api=(route,method,body)=>{log.push(route);
  if(route==='session')return [200,{user:{...user,caps:undefined},csrf:'c1'}];
  if(route==='bootstrap')return unlocked?[200,ws]:[401,{error:'Potwierdź hasło, aby otworzyć narzędzia organizatora.',code:'reauth'}];
  if(route==='organizer-unlock'){if(body?.password!=='Prawidlowe-Haslo-2026')return [422,{error:'Nieprawidłowe obecne hasło.'}];unlocked=true;return [200,{ok:true,csrf:'c2'}];}
  if(route==='public-config')return [200,{signup:false,billing:false,support:'hello@matbravo.com'}];
  return [404,{error:'Nie ma takiej operacji.'}];};
 const {server,url}=await serve(api),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));
  await page.goto(url+'#tournaments');await page.waitForSelector('#unlock-form');
  assert.match(await page.locator('.modal').innerText(),/Potwierdź hasło, aby otworzyć narzędzia organizatora\./);
  assert.equal(await page.evaluate(()=>document.activeElement?.name),'password','focus in the password field');
  await page.fill('#unlock-form [name=password]','zle-haslo-123');await page.click('button[form="unlock-form"]');
  await page.waitForFunction(()=>document.querySelector('#unlock-form .form-error').textContent.length>0);
  assert.equal(await page.locator('#unlock-form .form-error').innerText(),'Nieprawidłowe obecne hasło.');assert.equal(log.filter(r=>r==='bootstrap').length,1,'no retry before the password is confirmed');
  await page.fill('#unlock-form [name=password]','Prawidlowe-Haslo-2026');await page.click('button[form="unlock-form"]');
  await page.waitForSelector('.tournament-grid');assert.equal(await page.locator('h1').innerText(),'Moje turnieje');
  assert.deepEqual(log.filter(r=>['bootstrap','organizer-unlock'].includes(r)),['bootstrap','organizer-unlock','organizer-unlock','bootstrap'],'bootstrap retried exactly once');
  assert.equal(await page.locator('.modal').count(),0);await ctx.close();
  // Cancel: the member's pages stay (no sign-out) with "Narzędzia organizatora" to try again.
  unlocked=false;log.length=0;const c2=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),p2=await c2.newPage();p2.on('pageerror',e=>problems.push(e.message));
  await p2.goto(url);await p2.waitForSelector('#unlock-form');await p2.keyboard.press('Escape');
  await p2.waitForSelector('[data-action="organizer-unlock"]');assert.equal(await p2.locator('.login-page').count(),0,'still signed in');
  assert.equal(log.filter(r=>r==='bootstrap').length,1);
  await p2.click('[data-action="organizer-unlock"]');await p2.waitForSelector('#unlock-form');await p2.fill('#unlock-form [name=password]','Prawidlowe-Haslo-2026');await p2.click('button[form="unlock-form"]');
  await p2.waitForSelector('.tournament-grid');assert.equal(await p2.locator('[data-action="organizer-unlock"]').count(),0);
  await c2.close();assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('final review F1, demo in a browser (390 and 1440): the Administrator erases an account-owned athlete profile; an erased record is read-only',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:180000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  for(const [w,hh] of [[390,844],[1440,900]]){
   const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();
   page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,200));});
   await page.goto(url);await page.click('[data-action="demo-login"][data-role="admin"]');await page.waitForSelector('.app-shell');
   // The parent's child (an athlete account's profile) has an entry in a tournament that then finishes: the result is kept.
   await page.evaluate(async()=>{
    const W=await import('./workspace.js');let db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));
    db=W.execute(db,'demo-admin','entry.save',{tournamentId:'t-autumn-2026',profileId:'demo-athlete-child',weight:42,height:152,gradeType:'cup',grade:7,events:['forms']}).db;
    db.tournaments.find(t=>t.id==='t-autumn-2026').status='finished';localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));
   });
   await page.goto(url+'#database');await page.reload();await page.waitForSelector('.roster-table');
   const row=page.locator('.roster-table tbody tr').filter({hasText:'Zuzanna Demo'});
   assert.match(await row.innerText(),/Konto zawodnika/);
   await row.locator('[data-action="edit-profile"]').click();await page.waitForSelector('#profile-form');
   // The Administrator sees the erase action on an account's profile, with the text for an owned profile.
   await page.click('.modal [data-action="forget-profile"]');await page.waitForSelector('.modal [data-action="confirm-forget-profile"]');
   assert.match(await page.locator('.modal').innerText(),/Konto zostaje, ale jego profil zawodnika zniknie\..*w zachowanych wynikach zostaną tylko inicjały/s);
   await page.click('.modal [data-action="confirm-forget-profile"]');await page.waitForFunction(()=>/Dane zawodnika usunięte/.test(document.querySelector('#toast')?.textContent||''));
   const db=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')));
   const kept=db.profiles.find(p=>p.id==='demo-athlete-child');
   assert.deepEqual([kept.name,kept.ownerId,kept.birthDate,kept.archived],['Dane usunięte',null,null,true],'anonymised: the result is kept');
   assert.equal(db.tournaments.find(t=>t.id==='t-autumn-2026').entries.find(e=>e.profileId==='demo-athlete-child').name,'Z. D.','the kept result shows initials');
   // The erased record in the archive: read-only, no date prompt, no entry, no edit; the tournament that keeps it; only further erasure.
   await page.check('[data-control="archive"]');await page.waitForSelector('.roster-table tbody tr:has-text("Dane usunięte")');
   const erased=page.locator('.roster-table tbody tr').filter({hasText:'Dane usunięte'});
   const text=await erased.innerText();
   assert.ok(!/Uzupełnij datę/.test(text),'no date prompt');assert.match(text,/Puchar/,'the tournament that keeps the result');
   assert.equal(await erased.locator('[data-action="edit-profile"],[data-action="register-profile"],[data-action="archive-profile"]').count(),0);
   assert.equal(await erased.locator('[data-action="forget-profile"]').count(),1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no horizontal scroll');
   // Opened any other way, the record's card has no fields and no restore.
   await page.evaluate(()=>{const b=document.createElement('button');b.dataset.action='edit-profile';b.dataset.id='demo-athlete-child';b.id='qa-open-erased';document.querySelector('#main').append(b);});
   await page.click('#qa-open-erased');await page.waitForSelector('.modal .erased-list');
   assert.equal(await page.locator('.modal input,.modal select').count(),0,'read-only');assert.equal(await page.locator('.modal [data-action="archive-profile"]').count(),0,'no restore');
   assert.equal(await page.locator('.modal [data-action="forget-profile"]').count(),1);
   await ctx.close();
  }
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});
test('demo in a browser: a page with visible(user) renders for its user, #event-chat stays closed to an athlete, an edited unaffiliated profile keeps its pending club name',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:180000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,200));});
 const stored=id=>page.evaluate(id=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).profiles.find(p=>p.id===id),id);
 const signIn=async role=>{await page.evaluate(()=>sessionStorage.clear());await page.goto(url);await page.reload();await page.waitForSelector('.login-page');await page.click(`[data-action="demo-login"][data-role="${role}"]`);await page.waitForSelector('.app-shell');};
 const editSave=async(id,change)=>{await page.evaluate(()=>{location.hash='#database';});await page.waitForSelector(`[data-action="edit-profile"][data-id="${id}"]`);await page.click(`[data-action="edit-profile"][data-id="${id}"]`);await page.waitForSelector('#profile-form');
  const state=await page.evaluate(()=>({disabled:[...document.querySelectorAll('#profile-form [data-cp-mode]')].every(r=>r.disabled),mode:document.querySelector('#profile-form [data-cp-mode]:checked')?.value,note:document.querySelector('#profile-form .club-locked')?.textContent||null}));
  await change();await page.click('button[form="profile-form"]');await page.waitForFunction(()=>!document.querySelector('#profile-form'));return state;};
 try{
  await page.goto(url);await page.waitForSelector('.login-page');await page.click('[data-action="demo-login"][data-role="athlete"]');await page.waitForSelector('.app-shell');
  const r=await page.evaluate(async()=>{const {registry,h}=await import('./registry.js'),wait=()=>new Promise(r=>setTimeout(r,300));
   registry.registerPage({id:'qa-starts',icon:'trophy',label:'Moje starty QA',nav:'global',roles:['member'],order:15,visible:u=>!!u?.caps?.athlete,title:'Moje starty QA',render:()=>registry.use('ui').shell(h`<div id="qa-starts-body">STARTS</div>`,'Moje starty QA','')});
   location.hash='#qa-starts';await wait();const starts={body:!!document.querySelector('#qa-starts-body'),title:document.title};
   location.hash='#event-chat';await wait();return {starts,eventChat:location.hash,eventMount:!!document.querySelector('[data-chat-mount][data-tournament]')};});
  assert.deepEqual(r.starts,{body:true,title:'MatBravo — Moje starty QA'},'the page itself, not memberHome');
  assert.equal(r.eventChat,'#chat','a typed #event-chat sends an athlete to the start page');assert.equal(r.eventMount,false);
  // An organizer's unaffiliated athlete with a club name waiting for the Administrator (§6.3).
  await signIn('organizer');
  await page.evaluate(()=>{const key='matdraw.workspace.v2',db=JSON.parse(localStorage.getItem(key));db.profiles.push({id:'qa-pending',name:'Jan Oczekujący',clubId:'unaffiliated',pendingClubName:'Orły Opole',sex:'M',birthDate:'1990-05-01',weight:60,height:175,gradeType:'cup',grade:5,events:['forms'],champion:false,createdBy:'demo-organizer',createdAt:Math.floor(Date.now()/1000),archived:false,ownerId:null});db.revision++;localStorage.setItem(key,JSON.stringify(db));});
  await page.reload();await page.waitForSelector('.app-shell');
  const org=await editSave('qa-pending',()=>page.fill('#profile-form [name=weight]','61'));
  assert.deepEqual(org,{disabled:true,mode:'none',note:'Klub zawodnika może zmienić Administrator.'},'an organizer sees the club read-only');
  let p=await stored('qa-pending');assert.deepEqual([p.weight,p.clubId,p.pendingClubName],[61,'unaffiliated','Orły Opole']);
  await signIn('admin');
  const admin=await editSave('qa-pending',()=>page.fill('#profile-form [name=weight]','62'));
  assert.deepEqual(admin,{disabled:false,mode:'none',note:null},'the Administrator can change the club');
  p=await stored('qa-pending');assert.deepEqual([p.weight,p.clubId,p.pendingClubName],[62,'unaffiliated','Orły Opole'],'"Niezrzeszony" again keeps the pending name');
  const club=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).clubs.find(c=>c.id!=='unaffiliated'&&!c.mergedInto).id);
  await editSave('qa-pending',async()=>{await page.check('#profile-form [data-cp-mode][value="list"]');await page.selectOption('#profile-form [data-cp-select]',club);});
  p=await stored('qa-pending');assert.deepEqual([p.clubId,p.pendingClubName],[club,undefined],'another club replaces it');
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('review round 2, demo in a browser: a check-in that fails after the club was corrected is retried without a 409 and without a second entry.save',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,200));});
  await page.goto(url);await page.waitForSelector('.login-page');await page.click('[data-action="demo-login"][data-role="organizer"]');await page.waitForSelector('.app-shell');
  // The organizer's own tournament with an adult athlete's self-entry (club "Niezrzeszony", waiting for the check-in).
  const club=await page.evaluate(()=>{const key='matdraw.workspace.v2',db=JSON.parse(localStorage.getItem(key)),club=db.clubs.find(c=>c.id!=='unaffiliated'&&!c.mergedInto);
   db.profiles.push({id:'qa-self',name:'Ola Samodzielna',clubId:'unaffiliated',sex:'F',birthDate:'1995-04-02',weight:58,height:168,gradeType:'cup',grade:6,events:['forms'],champion:false,createdBy:'demo-athlete',createdAt:1793484000,archived:false,ownerId:'demo-athlete',relation:'self'});
   db.tournaments.push({id:'qa-t',name:'Puchar Kontroli',city:'Opole',date:'2027-05-15',mat:'Mata 1',status:'open',createdBy:'demo-organizer',selfEntry:true,rev:1,entries:[{id:'qa-self',profileId:'qa-self',clubId:'unaffiliated',name:'Ola Samodzielna',club:'Niezrzeszony',sex:'F',age:32,weight:58,height:168,gradeType:'cup',grade:6,champion:false,events:['forms'],presence:'pending',actualWeight:null,self:true}],draws:{},activity:[]});
   db.revision++;localStorage.setItem(key,JSON.stringify(db));sessionStorage.setItem('matdraw.activeTournament','qa-t');return club.id;});
  await page.evaluate(()=>{location.hash='#checkin';});await page.reload();await page.waitForSelector('[data-action="check-athlete"][data-id="qa-self"]');
  const stored=()=>page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2')),t=db.tournaments.find(t=>t.id==='qa-t');return {entry:t.entries[0],activity:t.activity.map(a=>a.text),revision:db.revision};});
  const before=await stored();
  await page.click('[data-action="check-athlete"][data-id="qa-self"]');await page.waitForSelector('#check-form');
  await page.check('#check-form [data-cp-mode][value="list"]');await page.selectOption('#check-form [data-cp-select]',club);await page.fill('#check-form [name=actualWeight]','');
  await page.click('button[form="check-form"]');await page.waitForFunction(()=>document.querySelector('#check-form .form-error')?.textContent.length>0);
  assert.equal(await page.locator('#check-form .form-error').innerText(),'Podaj wagę od 10 do 250 kg.','the check-in fails, the dialog stays');
  let s=await stored();assert.deepEqual([s.entry.clubId,s.entry.presence,s.revision],[club,'pending',before.revision+1],'entry.save went through, checkin.save did not');
  await page.fill('#check-form [name=actualWeight]','58.4');await page.click('button[form="check-form"]');
  await page.waitForFunction(()=>!document.querySelector('#check-form')||/\S/.test(document.querySelector('#check-form .form-error').textContent));
  assert.equal(await page.locator('#check-form').count(),0,'the retry saves: '+(await page.locator('#check-form .form-error').count()?await page.locator('#check-form .form-error').innerText():''));
  s=await stored();assert.deepEqual([s.entry.clubId,s.entry.presence,s.entry.actualWeight,s.revision],[club,'present',58.4,before.revision+2]);
  assert.equal(s.activity.filter(x=>x.startsWith('Zmieniono klub w zgłoszeniu: ')).length,1,'entry.save ran once');assert.equal(s.activity.filter(x=>x.startsWith('Kontrola startowa: ')).length,1);
  await ctx.close();assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('review round 2, API mode in a browser: the hall screen polls once behind an open password prompt, a cancel pauses it, a new category hash resumes it',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const user={id:'u-org',clubId:null,email:'org@example.test',role:'member',active:true,organizer:true,caps:{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false}};
 const ws={schemaVersion:2,revision:7,user,clubs:[{id:'unaffiliated',name:'Niezrzeszony',verified:true}],users:[],profiles:[],tournaments:[{id:'t1',name:'Turniej Organizatora',city:'Opole',date:'2099-03-14',mat:'Mata 1',status:'open',createdBy:'u-org',selfEntry:true,rev:7,community:true,trusted:true,hidden:false,hideReason:null,entries:[],draws:{},activity:[]}]};
 const log=[];let expired=false;
 const api=(route,method,body)=>{log.push(route);
  if(route==='session')return [200,{user:{...user,caps:undefined},csrf:'c1'}];
  if(route==='bootstrap')return expired?[401,{error:'Potwierdź hasło, aby otworzyć narzędzia organizatora.',code:'reauth'}]:[200,ws];
  if(route==='organizer-unlock'){if(body?.password!=='Prawidlowe-Haslo-2026')return [422,{error:'Nieprawidłowe obecne hasło.'}];expired=false;return [200,{ok:true,csrf:'c2'}];}
  if(route==='public-config')return [200,{signup:false,billing:false,support:'hello@matbravo.com'}];
  return [404,{error:'Nie ma takiej operacji.'}];};
 const {server,url}=await serve(api),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1280,height:720},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));
  await page.clock.install();await page.goto(url+'#screen?tournament=t1&category=a');await page.waitForSelector('.screen-empty');
  const boots=()=>log.filter(r=>r==='bootstrap').length,tick=async(n=1)=>{for(let i=0;i<n;i++){await page.clock.fastForward(15000);await sleep(250);}};
  await tick();const start=boots();assert.ok(start>=2,'the screen polls');
  // The step-up expires on an unattended projector: one tick asks, the following ticks wait without queueing retries.
  expired=true;await tick();await page.waitForSelector('#unlock-form');assert.equal(boots(),start+1);
  await tick(4);assert.equal(boots(),start+1,'no bootstrap while the prompt is open');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#unlock-form'));
  await tick(4);assert.equal(boots(),start+1,'a cancelled prompt pauses the polling');assert.equal(await page.locator('#unlock-form').count(),0);
  // Another category resumes it; the password confirmed in the new prompt retries that one request once, then the polling goes on.
  await page.evaluate(()=>{location.hash='#screen?tournament=t1&category=b';});await tick();await page.waitForSelector('#unlock-form');assert.equal(boots(),start+2);
  await tick(2);assert.equal(boots(),start+2);
  await page.fill('#unlock-form [name=password]','Prawidlowe-Haslo-2026');await page.click('button[form="unlock-form"]');await page.waitForFunction(()=>!document.querySelector('#unlock-form'));await sleep(250);
  assert.equal(boots(),start+3,'the waiting tick runs once more');await tick();assert.equal(boots(),start+4,'polling goes on after the unlock');
  await ctx.close();assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('final review R1.5, demo in a browser: after club.merge the club account edits and withdraws an entry made under the former club',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,200));});
  await page.goto(url);await page.waitForSelector('.login-page');await page.click('[data-action="demo-login"][data-role="club"]');await page.waitForSelector('.app-shell');
  // A club the Administrator merged into the club of this account; the entry snapshot keeps the former club (PS-10).
  await page.evaluate(()=>{const key='matdraw.workspace.v2',db=JSON.parse(localStorage.getItem(key)),club=db.users.find(u=>u.id==='demo-club').clubId,t=db.tournaments.find(t=>t.id==='t-autumn-2026');
   db.clubs.push({id:'qa-old',name:'Stary Klub QA',verified:true,createdBy:null,createdAt:null,mergedInto:club});
   db.profiles.push({id:'qa-merged',name:'Adam Scalony',clubId:club,sex:'M',birthDate:'2000-04-02',weight:70,height:175,gradeType:'cup',grade:5,events:['forms'],champion:false,createdBy:'demo-club',createdAt:1793484000,archived:false,ownerId:null});
   t.entries.push({id:'qa-merged',profileId:'qa-merged',clubId:'qa-old',name:'Adam Scalony',club:'Stary Klub QA',sex:'M',age:26,weight:70,height:175,gradeType:'cup',grade:5,champion:false,events:['forms'],presence:'pending',actualWeight:null});
   db.revision++;localStorage.setItem(key,JSON.stringify(db));sessionStorage.setItem('matdraw.activeTournament',t.id);});
  await page.evaluate(()=>{location.hash='#athletes';});await page.reload();await page.waitForSelector('.roster-panel');
  assert.equal(await page.locator('[data-action="edit-entry"][data-id="qa-merged"]').count(),1,'"Edytuj" for the former club entry');
  assert.equal(await page.locator('[data-action="remove-entry"][data-id="qa-merged"]').count(),1,'"Wycofaj" for the former club entry');
  await page.click('[data-action="remove-entry"][data-id="qa-merged"]');await page.click('[data-action="confirm-remove-entry"]');
  await page.waitForFunction(()=>!document.querySelector('[data-action="remove-entry"][data-id="qa-merged"]'));
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).tournaments.find(t=>t.id==='t-autumn-2026').entries.some(e=>e.id==='qa-merged')),false,'the withdrawal went through');
  await ctx.close();assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});
