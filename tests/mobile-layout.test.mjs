// Phone layout (owner's iPhone 15 Pro screenshots): screens drifted sideways because iOS Safari zooms the page in when a
// focused field's text is under 16px and never zooms back out, and because iOS keeps the native width of date fields (the
// tournament form's date covered "Miasto"). In Chromium with an emulated iPhone (393 px, touch, iOS user agent) and the
// narrowest phone (320 px) this checks, on every page and the main dialogs:
//  - nothing is wider than the screen (document scroll width = viewport; no element sticks out unless a scroll box clips it);
//  - every visible text-like field (input, select, textarea) has at least 16px text, so iOS never zooms on focus;
//  - forms are one column below 440 px (the date and the city fields are stacked, both inside the dialog).
// The 320 px pass blocks the web font, so the layout must also hold on a wider fallback font.
// Static demo: every demo role, every page of its menu, "Moje konto", and the tournament, profile, entry and account dialogs.
// PHP build (under scripts/test-http.sh): sign-up with both roles and the athlete step, "Moje konto" with each tab,
// "Moje starty", and the Administrator's Ustawienia, Członkowie and Kluby.
// Opt-in like the other browser tests: MATDRAW_BROWSER_TESTS=1 node --test tests/mobile-layout.test.mjs; the PHP part runs via
// MATDRAW_BROWSER_TESTS=1 bash scripts/test-http.sh <port> <db> tests/mobile-layout.test.mjs (skipped otherwise).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const API=process.env.MATDRAW_TEST_URL;
const IOS='Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const phone=(width,lang)=>({viewport:{width,height:width<360?640:852},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:IOS,locale:lang==='pl'?'pl-PL':'en-GB',serviceWorkers:'block'});
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream'});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/** Runs in the page: horizontal overflow, elements sticking out (outside a clipping scroll box) and text fields under 16px. */
function audit(){
 const vw=document.documentElement.clientWidth,out={overflow:document.documentElement.scrollWidth-vw,out:[],small:[]};
 const path=el=>{const p=[];for(let e=el;e&&e!==document.body&&p.length<4;e=e.parentElement){let s=e.tagName.toLowerCase();if(e.id)s+='#'+e.id;else if(e.classList.length)s+='.'+[...e.classList].slice(0,2).join('.');p.unshift(s);}return p.join(' > ');};
 const shown=el=>{const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
 const clipped=el=>{for(let a=el.parentElement;a&&a!==document.documentElement;a=a.parentElement){const cs=getComputedStyle(a);if(cs.overflowX!=='visible'){const r=a.getBoundingClientRect();if(r.right<=vw+1&&r.left>=-1)return true;}if(cs.position==='fixed')break;}return false;};
 // The closed phone menu waits off-canvas on the left (translateX) on purpose; it is not part of the page width.
 const skip=el=>el.closest('#app-sidebar:not(.open)')||el.classList.contains('sr-only')||el.classList.contains('skip-link');
 for(const el of document.body.querySelectorAll('*')){
  if(skip(el)||!shown(el))continue;const r=el.getBoundingClientRect();
  // Past the right edge, or cut at the left edge; whatever waits wholly off-screen on the left (the sign-up honeypot) adds no width.
  const sticks=x=>x.right>vw+1||x.left<-1&&x.right>1;
  if(sticks(r)&&!clipped(el)&&!(el.parentElement&&sticks(el.parentElement.getBoundingClientRect())))out.out.push(path(el)+' ['+Math.round(r.left)+'..'+Math.round(r.right)+']');
 }
 // Account tabs wrap on phones: each one whole on screen (a sideways strip cut "Bezpieczeństwo" in the screenshot).
 for(const el of document.querySelectorAll('.acct-tab')){const r=el.getBoundingClientRect();if(shown(el)&&(r.left<-1||r.right>vw+1))out.out.push('tab '+el.id+' cut ['+Math.round(r.left)+'..'+Math.round(r.right)+']');}
 for(const el of document.querySelectorAll('input,select,textarea')){
  if(['checkbox','radio','range','file','hidden','submit','button','color','image','reset'].includes(el.type)||skip(el)||!shown(el))continue;
  const fs=parseFloat(getComputedStyle(el).fontSize);if(fs<16)out.small.push(path(el)+(el.name?'[name='+el.name+']':'')+' '+fs+'px');
 }
 return out;
}
const check=async(page,where,problems)=>{
 await sleep(200);const a=await page.evaluate(audit);
 if(a.overflow>0)problems.push(`${where}: page ${a.overflow}px wider than the screen`);
 for(const o of a.out.slice(0,3))problems.push(`${where}: sticks out ${o}`);
 for(const s of [...new Set(a.small)].slice(0,3))problems.push(`${where}: field under 16px ${s}`);
};

test('static demo on phones (393 px PL, 320 px EN): no page wider than the screen, every field at least 16px, one-column forms',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:600000},async t=>{
 const {server,url}=await serve();let browser;
 try{browser=await chromium.launch();}catch(error){server.close();t.skip('Chromium cannot start: '+error.message);return;}
 const problems=[],errors=[];
 try{
  for(const [width,lang] of [[393,'pl'],[320,'en']]){
   const ctx=await browser.newContext(phone(width,lang));
   // 320 px runs without Manrope: the page must also fit while the web font loads (font-display: swap) or on a fallback font,
   // which is wider (CI measured "New athlete" + "Add from database" 6px past the screen before the font arrived).
   if(width<360){
    await ctx.route('**/fonts/**',r=>r.abort());
    // The same wide fallback everywhere (DejaVu Sans is the CI runner's default sans-serif; locally it may be Inter).
    await ctx.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='@font-face{font-family:Manrope;src:local("DejaVu Sans")}@font-face{font-family:Manrope;font-weight:600 800;src:local("DejaVu Sans Bold")}';document.head.append(s);}));
   }
   await ctx.addInitScript(l=>{try{localStorage.setItem('matdraw.language',l);}catch{}},lang);
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(url);await page.waitForSelector('[data-action="demo-login"]');await check(page,`${width} ${lang} home`,problems);
   for(const hash of ['#signup','#guest']){await page.goto(url+hash);await sleep(600);await check(page,`${width} ${lang} ${hash}`,problems);}
   for(const role of ['admin','editor','club','organizer','athlete']){
    await page.goto(url);await page.waitForSelector('[data-action="demo-login"]');
    await page.click(`[data-action="demo-login"][data-role="${role}"]`);await page.waitForSelector('.app-shell');await sleep(300);
    const pages=await page.evaluate(()=>[...new Set([...document.querySelectorAll('[data-page]')].map(e=>e.dataset.page))]);
    for(const p of [...pages,'#profile']){
     if(p.startsWith('#'))await page.evaluate(h=>{location.hash=h;},p);else await page.evaluate(id=>document.querySelector(`[data-page="${id}"]`)?.click(),p);
     await sleep(500);await check(page,`${width} ${lang} ${role} ${p}`,problems);
    }
    if(role==='admin'){
     // The dialogs with forms: a new tournament (the screenshot), a new profile, a new entry, a new account.
     for(const [p,action] of [['tournaments','new-tournament'],['database','new-profile'],['athletes','new-entry'],['accounts','new-account']]){
      await page.evaluate(id=>document.querySelector(`[data-page="${id}"]`)?.click(),p);await sleep(500);
      const opener=page.locator(`main [data-action="${action}"]`).first();
      if(!await opener.count()){problems.push(`${width} ${lang}: no "${action}" button on ${p}`);continue;}
      await opener.click();await page.waitForSelector('#modal-root .modal');await check(page,`${width} ${lang} dialog ${action}`,problems);
      if(action==='new-tournament'){
       const g=await page.evaluate(()=>{const f=n=>document.querySelector(`#tournament-form [name="${n}"]`).getBoundingClientRect(),m=document.querySelector('#modal-root .modal').getBoundingClientRect(),d=f('date'),c=f('city');return {stacked:c.top>=d.bottom-1,inside:d.left>=m.left&&d.right<=m.right+0.5&&c.right<=m.right+0.5};});
       assert.deepEqual(g,{stacked:true,inside:true},`${width} ${lang}: the date and city fields of the tournament form are stacked inside the dialog`);
      }
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));
     }
    }
    await page.evaluate(()=>document.querySelector('[data-action="logout"]')?.click());await sleep(300);
   }
   await ctx.close();
  }
 }finally{await browser.close();server.close();}
 assert.deepEqual(errors,[]);
 assert.deepEqual(problems,[]);
});

test('PHP build on a 393 px phone: sign-up with roles, Moje konto tabs, Moje starty, Administrator panels',{skip:(!chromium||!API)&&'MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh needed',timeout:300000},async()=>{
 const {fixture}=await import('./helpers/http-client.mjs');
 fixture('reset-limits');const before=fixture('settings-row');fixture('settings-set',{data:{signup:'on',payments:'free'}});
 const app=API.replace(/api\/index\.php$/,''),browser=await chromium.launch(),problems=[],errors=[];
 const letters=n=>Array.from({length:n},()=>'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random()*26)]).join('');
 try{
  const ctx=await browser.newContext(phone(393,'pl'));
  await ctx.addInitScript(()=>{try{localStorage.setItem('matdraw.language','pl');}catch{}});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  // Sign-up: both roles, the athlete step ("Siebie", an adult, no club).
  await page.goto(app+'#signup');await page.waitForSelector('#acct-signup-1');
  await page.check('#acct-signup-1 [name="role-organizer"]');if(!await page.isChecked('#acct-signup-1 [name="role-athlete"]'))await page.check('#acct-signup-1 [name="role-athlete"]');
  await check(page,'signup step 1',problems);
  const begun=Date.now();
  await page.fill('#acct-signup-1 [name="email"]','e2e.mobile.'+letters(8)+'@example.test');await page.fill('#acct-signup-1 [name="password"]','Zielony-Rower-2026');
  await page.click('#acct-signup-1 button[type="submit"]');await page.waitForSelector('#acct-signup-2');await check(page,'signup step 2',problems);
  await page.fill('#acct-signup-2 [name="firstName"]','Qa'+letters(5));await page.fill('#acct-signup-2 [name="lastName"]','Mobile'+letters(5));
  await page.waitForSelector('#acct-signup-2 .acct-st.ok');await page.click('[data-sport="taekwondo"]');
  await sleep(Math.max(0,3500-(Date.now()-begun)));await page.click('#acct-signup-2 button[type="submit"]');
  await page.waitForSelector('#acct-signup-3');await check(page,'signup step 3 (athlete)',problems);
  await page.check('#acct-signup-3 input[name="relation"][value="self"]');await page.fill('#acct-signup-3 [name="birthDate"]','1993-03-03');
  await page.selectOption('#acct-signup-3 [name="sex"]','M');await page.fill('#acct-signup-3 [name="weight"]','72');await page.fill('#acct-signup-3 [name="height"]','180');
  await page.selectOption('#acct-signup-3 [name="grade"]','3');await page.check('#acct-signup-3 input[name="athleteClubMode"][value="none"]');
  await page.click('#acct-signup-3 button[type="submit"]');await page.waitForSelector('.app-shell',{timeout:20000});await sleep(500);
  await check(page,'after sign-up',problems);
  // Moje konto: every tab (the screenshot showed the Role tab wider than the phone).
  await page.evaluate(()=>{location.hash='#profile';});await page.waitForSelector('.acct-tab');
  for(const tab of await page.evaluate(()=>[...document.querySelectorAll('.acct-tab')].map(b=>b.id))){
   await page.click('#'+tab);await sleep(400);await check(page,'Moje konto '+tab,problems);
  }
  for(const hash of ['#starts','#chat']){await page.evaluate(h=>{location.hash=h;},hash);await sleep(800);await check(page,'member '+hash,problems);}
  await ctx.close();
  // The Administrator's panels.
  const actx=await browser.newContext(phone(393,'pl'));const admin=await actx.newPage();admin.on('pageerror',e=>errors.push(e.message));
  fixture('reset-limits');await admin.goto(app);await admin.fill('#login-form input[name="email"]','admin@test.example');await admin.fill('#login-form input[name="password"]','AdminForTests2026!');
  await admin.click('#login-form button[type="submit"]');await admin.waitForSelector('.app-shell',{timeout:20000});
  for(const hash of ['#settings','#members','#clubs','#profile']){await admin.evaluate(h=>{location.hash=h;},hash);await sleep(900);await check(admin,'admin '+hash,problems);}
  await actx.close();
 }finally{
  await browser.close();
  if(before)fixture('settings-set',{data:before.data,version:before.version});else fixture('settings-reset');fixture('reset-limits');
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(problems,[]);
});
