// Home page with the chat card, tournament preview tabs and the entry points in the shell (plan §8.9, §12.5).
// Structure checks read dist/app.js; the browser checks (Playwright + Chromium, static demo served from dist/) are skipped without Playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
const app=readFileSync(root+'app.js','utf8'),css=readFileSync(root+'workspace.css','utf8');
const tpl=(name)=>{const i=app.indexOf(name);assert.ok(i>=0,name);return app.slice(i,i+9000);};

test('renderLogin: story, chat, sign-in, upcoming, footer in DOM order with the mount points of the feature modules',()=>{
 const login=tpl('function renderLogin(');
 const order=['class="login-story"','${homeChat()}','class="login-form-panel"','${upcomingSection()}','class="login-foot"'].map(s=>login.indexOf(s));
 assert.ok(order.every(i=>i>0)&&order.every((v,i)=>!i||v>order[i-1]),'DOM order '+order);
 const home=tpl('const homeChat=');assert.ok(home.includes('data-chat-mount="home"'));
 assert.match(home,/<section class="home-chat"[^>]*aria-labelledby="home-chat-title"/);
 assert.equal((home.slice(0,900).match(/<div><i><\/i><span><\/span><\/div>'\.repeat\(4\)/g)||[]).length,1,'a skeleton of 4 rows');
 for(const s of ['data-account-mount="join"','data-account-mount="login-help"','data-action="skip-chat"','data-action="skip-login"','data-action="login-jump"',"matdraw.knownDevice"])assert.ok(login.includes(s)||app.includes(s),s);
 assert.match(tpl('function upcomingItem('),/<span class="upcoming-chat" data-chat-count="\$\{esc\(t\.id\)\}"><\/span>/);
});
test('tournaments page and guest preview carry the chat mount points',()=>{
 const t=tpl('function tournamentsPage(');
 assert.ok(t.includes('data-chat-mount="strip"')&&t.includes('data-chat-tournament-link="${esc(t.id)}"'));
 const g=tpl('const guestChatPanel=');
 assert.match(g,/data-chat-mount="tournament" data-tournament-id="\$\{esc\(g\.id\)\}"/);
 assert.ok(app.includes("action==='guest-tab'")&&app.includes("'&tab=chat'")&&app.includes('data-action="guest-tab"'));
 assert.ok(app.includes('data-page="${esc(registry.defaultPage(workspace?.user?.role))}"'),'member preview has a Wróć button with data-page');
});
test('the grid covers the plan\'s breakpoints and the print stylesheet hides the chat',()=>{
 for(const s of ['minmax(340px,388px) minmax(460px,1fr) clamp(400px,30vw,480px)','minmax(560px,760px) 520px','"story auth" "chat auth" "upcoming foot"','"story" "auth" "chat" "upcoming" "foot"','min-height:560px;max-height:900px','height:calc(100dvh - 48px)','--mascot-h:196px'])assert.ok(css.includes(s),s);
 assert.match(css,/@media print\{[^}]*\.home-centre/);
 assert.deepEqual([...new Set([...css.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px/g)].map(m=>+m[1]))].filter(w=>![440,650,760,800,1000,1180,1199,1650].includes(w)),[],'plan 8.7: no new breakpoint (760 and 1180 predate the slice)');
 assert.match(readFileSync(root+'styles.css','utf8'),/@media print\{[^@]*#app,[^}]*display:none!important/,'the app shell (home page, guest preview) is never part of a printout: prints go through #print-root');
});

// ---- browser checks ----
let chromium=null;try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'"});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
test('home page in a browser: layout, skip links, phone sign-in button, known device, preview tabs, member preview',{skip:!chromium&&'Playwright is not installed',timeout:120000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch(),errors=[];
 const open=async(width,height,init)=>{const ctx=await browser.newContext({viewport:{width,height},locale:'pl-PL'});if(init)await ctx.addInitScript(init);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(url);await page.waitForSelector('.login-page');return {ctx,page};};
 try{
  // no horizontal scroll; sign-in form on the right at desktop
  for(const [w,h] of [[1440,900],[1024,800],[390,844],[360,740],[340,740],[320,740]]){
   const {ctx,page}=await open(w,h);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'horizontal overflow at '+w);
   const order=await page.evaluate(()=>[...document.querySelector('.login-page').children].map(e=>e.className.split(' ')[0]));
   assert.deepEqual(order.filter(c=>/^(login-story|home-centre|login-form-panel)$/.test(c)),['login-story','home-centre','login-form-panel']);
   if(w===1440){
    const r=await page.evaluate(()=>{const f=document.querySelector('#login-form').getBoundingClientRect(),c=document.querySelector('.home-chat').getBoundingClientRect(),s=document.querySelector('.login-story').getBoundingClientRect();return {form:f.left,chat:[c.left,c.height],story:s.right};});
    assert.ok(r.form>r.chat[0]+r.chat[1]*0&&r.chat[0]>=r.story&&r.chat[0]<r.form,JSON.stringify(r));assert.ok(r.chat[1]>=560&&r.chat[1]<=900);
    // skip links: the second and third tab stops, then they move focus
    await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'skip-chat');
    await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'home-chat');
    await page.focus('[data-action="skip-login"]');await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.name),'email');
    // language switch keeps what was typed
    await page.fill('#login-form [name=email]','a@b.pl');await page.fill('#login-form [name=password]','x');await page.click('[data-set-lang="en"]');
    assert.deepEqual(await page.evaluate(()=>[document.querySelector('#login-form [name=email]').value,document.querySelector('#login-form [name=password]').value,document.querySelector('.home-chat h2').textContent]),['a@b.pl','x','MatBravo chat']);
   }
   if(w<=390){const r=await page.evaluate(()=>[document.querySelector('.login-story .brand-logo').getBoundingClientRect().right,document.querySelector('.login-lang').getBoundingClientRect().left]);assert.ok(r[0]<=r[1]-4,'logo runs under the language switch / sign-in button at '+w+': '+r);}
   if(w===390){
    assert.ok(await page.isVisible('.login-jump'),'sign-in button in the phone hero');
    await page.click('.login-jump');await page.waitForTimeout(800);
    assert.equal(await page.evaluate(()=>document.activeElement.name),'email');
    const y=await page.evaluate(()=>[document.querySelector('.home-chat').getBoundingClientRect().top+scrollY,document.querySelector('.login-form-panel').getBoundingClientRect().top+scrollY]);assert.ok(y[0]<y[1],'first visit: chat above the sign-in form');
   }
   if(w===1440||w===1024)assert.ok(!(await page.isVisible('.login-jump')));
   await ctx.close();
  }
  {const {ctx,page}=await open(390,844,()=>{try{localStorage.setItem('matdraw.knownDevice','1');}catch{}});
   await page.waitForSelector('.login-page.known-device');
   const y=await page.evaluate(()=>[document.querySelector('.home-chat').getBoundingClientRect().top,document.querySelector('.login-form-panel').getBoundingClientRect().top]);assert.ok(y[1]<y[0],'known device: sign-in above the chat');await ctx.close();}
  // very wide screens: the content of the left column stays 400px wide, right-aligned against the chat (no 1200px card)
  for(const [w,h] of [[1920,1080],[2560,1300]]){
   const {ctx,page}=await open(w,h);await page.waitForSelector('.upcoming-item');
   const r=await page.evaluate(()=>{const c=document.querySelector('.upcoming-card').getBoundingClientRect(),h=document.querySelector('.home-centre').getBoundingClientRect();return {card:c.width,gap:h.left-c.right,ov:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
   assert.ok(r.card<=400&&r.card>=300&&r.gap>=0&&r.gap<=60&&r.ov===0,w+' '+JSON.stringify(r));await ctx.close();
  }
  // the module event after the list is (re)painted: the placeholders exist when it fires
  {const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL'});
   await ctx.route('**/registry.js',async route=>{const res=await route.fetch(),body=await res.text();await route.fulfill({response:res,body:body+"\n;globalThis.__up=[];on('upcoming-painted',d=>globalThis.__up.push([document.querySelectorAll('.upcoming-item [data-chat-count]').length,d.tournaments.length]));"});});
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForSelector('.upcoming-item');
   const seen=await page.evaluate(()=>globalThis.__up);assert.ok(seen.length>=1&&seen.every(([spans,n])=>n>=1&&spans===n),'upcoming-painted '+JSON.stringify(seen));await ctx.close();}
  // upcoming list placeholder, promo, preview tabs
  {const {ctx,page}=await open(1440,900);
   await page.waitForSelector('.upcoming-item');assert.ok(await page.locator('.upcoming-item .upcoming-chat[data-chat-count]').count()>=1);
   await page.click('.upcoming-item');await page.waitForSelector('.promo');await page.click('.promo [data-action="close-modal"].btn.primary');await page.waitForSelector('.guest-tabs');
   assert.deepEqual(await page.locator('.guest-tab').evaluateAll(t=>t.map(x=>[x.getAttribute('aria-selected'),x.tabIndex])),[['true',0],['false',-1]]);
   await page.click('#guest-tab-chat');
   assert.ok(await page.evaluate(()=>location.hash.endsWith('&tab=chat')&&!!document.querySelector('[data-chat-mount="tournament"][data-tournament-id]')&&document.activeElement.id==='guest-tab-chat'));
   // browser shortcuts are left alone (Alt+Arrow = Back/Forward, Ctrl+Home/End)
   for(const combo of ['Alt+ArrowLeft','Alt+ArrowRight','Control+Home','Control+End','Meta+ArrowLeft']){await page.keyboard.press(combo);assert.ok(await page.evaluate(()=>location.hash.endsWith('&tab=chat')&&document.activeElement.id==='guest-tab-chat'),combo+' must not switch the tab');}
   await page.keyboard.press('ArrowLeft');assert.ok(await page.evaluate(()=>!location.hash.includes('tab=')&&document.activeElement.id==='guest-tab-cats'&&!document.querySelector('[data-chat-mount="tournament"]')&&!!document.querySelector('.category-card')));
   await page.click('#guest-tab-chat');await page.click('[data-set-lang="en"]');assert.equal(await page.locator('.guest-tab[aria-selected="true"]').innerText(),'Tournament chat');
   // after the sign-in: strip and link mounts on the tournaments page, and a member's preview without promo and with "Wróć"
   await page.goto(url+'#tournaments');await page.waitForSelector('.login-page');await page.click('[data-action="demo-login"][data-role="admin"]');await page.waitForSelector('.tournament-grid');
   assert.equal(await page.locator('[data-chat-mount="strip"]').count(),1);assert.ok(await page.locator('[data-chat-tournament-link]').count()>=1);
   await page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));const u=db.users.find(u=>u.role==='club');u.role='member';u.clubId=null;localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));});
   await page.click('[data-action="logout"]');await page.waitForSelector('.login-page');
   const member=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).users.find(u=>u.role==='member').email);
   await page.fill('#login-form [name=email]',member);await page.fill('#login-form [name=password]','MatDrawDemo2026!');await page.click('.login-submit');await page.waitForFunction(()=>location.hash==='#chat');
   const id=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).tournaments[0].id);
   await page.evaluate(i=>{location.hash='#guest?t='+i;},id);await page.waitForSelector('.guest-tabs');
   assert.deepEqual(await page.evaluate(()=>[!!document.querySelector('.promo'),!!document.querySelector('.access-card'),document.querySelector('.guest-login').dataset.page,document.querySelector('.guest-login').textContent.trim()]),[false,false,'chat','Back']);
   await page.locator('.category-card').nth(1).click();await page.click('#guest-tab-chat');assert.ok(await page.locator('[data-chat-mount="tournament"]').count()===1);
   await page.click('#guest-tab-cats');await page.click('.guest-login');await page.waitForFunction(()=>location.hash==='#chat');
   // "Wróć" (a data-page link) drops the preview: the next visit loads fresh data
   await page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));db.tournaments[0].name='Zmieniona nazwa';localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));});
   await page.evaluate(i=>{location.hash='#guest?t='+i;},id);await page.waitForSelector('.guest-tabs');
   assert.equal(await page.locator('#guest-title').innerText(),'Zmieniona nazwa','stale preview after Wróć');
   await ctx.close();}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});
