// Home page per martial art (owner 2026-11-10) with the sport switcher, the sport's tournaments and federation filter, its chat card,
// the sign-in or account card, tournament preview tabs and the entry points in the shell (plan §8.9, §12.5).
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

test('renderHome: sport bar, tournaments, chat, sign-in or account card, footer in DOM order with the mount points of the feature modules',()=>{
 const home=tpl('function renderHome(');
 const inOrder=parts=>{const at=parts.map(s=>home.indexOf(s));assert.ok(at.every(i=>i>0)&&at.every((v,i)=>!i||v>at[i-1]),'DOM order '+parts.join(' | ')+': '+at);};
 inOrder(['${eventsSection(s)}','<div class="home-centre">${homeChat(s)}</div>','${side}']);
 inOrder(['${skips}${homeBar(user,sport)}','<main id="main" class="home-main" tabindex="-1">${main}','<div class="login-foot">']);
 assert.ok(home.includes('const side=user?accountCard(user):loginPanel(message)'),'signed in, the sign-in panel becomes the account card');
 assert.ok(home.includes(':chooserSection()+side'),'without a sport the chooser stands where the tournaments and the chat go');
 assert.ok(!app.includes('function renderLogin('),'one home page for guests and signed-in people');
 const chat=tpl('const homeChat=');assert.ok(chat.includes('data-chat-mount="home" data-sport="${s.id}"'));
 assert.match(chat,/<section class="home-chat"[^>]*aria-labelledby="home-chat-title"/);
 assert.equal((chat.slice(0,900).match(/<div><i><\/i><span><\/span><\/div>'\.repeat\(4\)/g)||[]).length,1,'a skeleton of 4 rows');
 const bar=tpl('function homeBar(');
 for(const s of ['<nav class="sport-nav" aria-label="${T(\'Sztuki walki\')}">','aria-current="page"','href="#home?s=${s.id}"','data-action="login-jump"','data-action="account-jump"'])assert.ok(bar.includes(s),s);
 for(const s of ['data-account-mount="join"','data-account-mount="login-help"','data-acct-banner','data-action="skip-events"','data-action="skip-chat"','data-action="skip-login"',"matdraw.knownDevice",'data-sport-count="${s.id}"','data-action="home-fed"','aria-pressed="${on===id}"'])assert.ok(app.includes(s),s);
 assert.match(tpl('function upcomingItem('),/<span class="upcoming-chat" data-chat-count="\$\{esc\(t\.id\)\}"><\/span>/);
 assert.match(app,/function afterLogin\(\)\{[^}]*else\{ui\.page='home';render\(\);\}/,'signing in keeps the home page unless the address names a page');
});
test('tournaments page and guest preview carry the chat mount points',()=>{
 const t=tpl('function tournamentsPage(');
 assert.ok(t.includes('data-chat-mount="strip"')&&t.includes('data-chat-tournament-link="${esc(t.id)}"'));
 const g=tpl('const guestChatPanel=');
 assert.match(g,/data-chat-mount="tournament" data-tournament-id="\$\{esc\(g\.id\)\}"/);
 assert.ok(app.includes("action==='guest-tab'")&&app.includes("'&tab=chat'")&&app.includes('data-action="guest-tab"'));
 assert.ok(app.includes('class="btn guest-login" data-page="home"'),'member preview has a Wróć button back to the home page');
});
test('the grid covers the plan\'s breakpoints and the print stylesheet hides the home page',()=>{
 for(const s of ['minmax(330px,410px) minmax(460px,1fr) clamp(330px,25vw,420px)','"events chat auth" "events chat foot"','minmax(410px,1fr) minmax(560px,800px) minmax(420px,1fr)','"events auth" "chat auth" "chat foot"','"events auth" "chat chat" "foot foot"','"events" "chat" "auth" "foot"','"auth" "events" "chat" "foot"','"chooser auth" "chooser foot"','min-height:560px;max-height:900px','height:calc(100dvh - 112px)','--mascot-h:232px'])assert.ok(css.includes(s),s);
 assert.match(css,/@media print\{\.home,/);
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
test('home page in a browser: sport chooser and switcher, layout, skip links, phone sign-in button, known device, preview tabs, member preview',{skip:!chromium&&'Playwright is not installed',timeout:180000},async()=>{
 // The server is closed also when Chromium cannot start, so no open handle keeps the test process alive.
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),errors=[];
 const open=async(width,height,init,hash='#home?s=taekwondo')=>{const ctx=await browser.newContext({viewport:{width,height},locale:'pl-PL'});if(init)await ctx.addInitScript(init);const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(url+hash);await page.waitForSelector('.home');return {ctx,page};};
 try{
  // First visit without a sport: the chooser of the eight martial arts; a tile opens the sport and the choice is remembered.
  {const {ctx,page}=await open(1440,900,null,'');
   await page.waitForSelector('.home.is-chooser');
   assert.deepEqual(await page.locator('.sport-tile').evaluateAll(t=>t.map(x=>x.dataset.sport)),['taekwondo','karate','boxing','judo','kickboxing','bjj','muaythai','mma']);
   assert.equal(await page.locator('.sport-tab[aria-current="page"]').count(),0);
   await page.click('.sport-tile[data-sport="karate"]');await page.waitForSelector('.home[data-sport="karate"] .upcoming-item');
   assert.deepEqual(await page.evaluate(()=>[location.hash,localStorage.getItem('matdraw.sport'),document.querySelector('.sport-tab[aria-current="page"]').dataset.sport,document.querySelectorAll('.fed-chip').length]),['#home?s=karate','karate','karate',4]);
   // Only the sport's tournaments; the chat follows the sport: Karate's general channel and one tab per federation.
   assert.deepEqual(await page.locator('.upcoming-name').allInnerTexts(),['Puchar Mazowsza Karate','Lubelskie Kumite Kyokushin']);
   await page.waitForSelector('.home-chat .chat-tab');
   assert.deepEqual(await page.locator('.home-chat .chat-tab b').allInnerTexts(),['Ogólny','WKF','Kyokushin','ITKF']);
   // A federation chip filters the list (a toggle button); an empty federation says so and offers every federation again.
   await page.click('.fed-chip[data-fed="kyokushin"]');await page.waitForFunction(()=>document.querySelectorAll('.upcoming-item').length===1);
   assert.deepEqual(await page.evaluate(()=>[document.querySelector('.fed-chip[data-fed="kyokushin"]').getAttribute('aria-pressed'),document.querySelector('.fed-chip[data-fed=""]').getAttribute('aria-pressed'),document.querySelector('.upcoming-name').textContent]),['true','false','Lubelskie Kumite Kyokushin']);
   await page.click('.fed-chip[data-fed="itkf"]');await page.waitForSelector('.upcoming-empty [data-action="home-fed"]');
   await page.click('.upcoming-empty [data-action="home-fed"]');await page.waitForFunction(()=>document.querySelectorAll('.upcoming-item').length===2);
   // The next visit without a sport in the address opens the remembered one; the switcher on top changes it. A sport with one
   // federation has no chips and no channel tabs.
   await page.goto(url);await page.waitForSelector('.home[data-sport="karate"]');
   await page.click('.sport-tab[data-sport="judo"]');await page.waitForSelector('.home[data-sport="judo"] .home-chat .chat-log');
   assert.deepEqual(await page.evaluate(()=>[document.querySelectorAll('.fed-chip').length,document.querySelectorAll('.home-chat [role="tab"]').length,localStorage.getItem('matdraw.sport')]),[0,0,'judo']);
   await ctx.close();}
  // no horizontal scroll; sign-in form on the right at desktop
  for(const [w,h] of [[1440,900],[1024,800],[390,844],[360,740],[340,740],[320,740]]){
   const {ctx,page}=await open(w,h);await page.waitForSelector('.upcoming-item');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'horizontal overflow at '+w);
   const order=await page.evaluate(()=>[...document.querySelector('.home-main').children].map(e=>e.className.split(' ')[0]));
   assert.deepEqual(order.filter(c=>/^(home-events|home-centre|login-form-panel)$/.test(c)),['home-events','home-centre','login-form-panel']);
   if(w===1440){
    const r=await page.evaluate(()=>{const f=document.querySelector('#login-form').getBoundingClientRect(),c=document.querySelector('.home-chat').getBoundingClientRect(),e=document.querySelector('.upcoming-card').getBoundingClientRect();return {form:f.left,chat:[c.left,c.right,c.height],events:e.right};});
    assert.ok(r.events<=r.chat[0]&&r.chat[1]<=r.form,JSON.stringify(r));assert.ok(r.chat[2]>=560&&r.chat[2]<=900);
    // skip links after the page's own one: the tournaments, the chat and the sign-in, then they move focus
    await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'skip-events');
    await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'home-events');
    await page.focus('[data-action="skip-chat"]');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'home-chat');
    await page.focus('[data-action="skip-login"]');await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.name),'email');
    // language switch keeps what was typed
    await page.fill('#login-form [name=email]','a@b.pl');await page.fill('#login-form [name=password]','x');await page.click('[data-set-lang="en"]');
    assert.deepEqual(await page.evaluate(()=>[document.querySelector('#login-form [name=email]').value,document.querySelector('#login-form [name=password]').value,document.querySelector('.home-chat h2').textContent,document.querySelector('.sport-tab[data-sport="boxing"]').textContent]),['a@b.pl','x','Chat · Taekwondo','Boxing']);
   }
   if(w<=390){const r=await page.evaluate(()=>[document.querySelector('.home-brand').getBoundingClientRect().right,document.querySelector('.home-bar .lang-switch').getBoundingClientRect().left]);assert.ok(r[0]<=r[1]-4,'logo runs under the language switch / sign-in button at '+w+': '+r);}
   if(w===390){
    assert.ok(await page.isVisible('.login-jump'),'sign-in button in the bar');
    await page.click('.login-jump');await page.waitForTimeout(800);
    assert.equal(await page.evaluate(()=>document.activeElement.name),'email');
    const y=await page.evaluate(()=>[document.querySelector('.home-events').getBoundingClientRect().top+scrollY,document.querySelector('.home-chat').getBoundingClientRect().top+scrollY,document.querySelector('.login-form-panel').getBoundingClientRect().top+scrollY]);assert.ok(y[0]<y[1]&&y[1]<y[2],'first visit: the sport\'s tournaments and chat above the sign-in form');
   }
   if(w===1440||w===1024)assert.ok(!(await page.isVisible('.login-jump')));
   await ctx.close();
  }
  // phones: the sport switcher scrolls sideways under the bar and keeps the chosen sport in view
  {const {ctx,page}=await open(320,740,null,'#home?s=mma');await page.waitForSelector('.home[data-sport="mma"]');
   const r=await page.evaluate(()=>{const n=document.querySelector('.sport-nav'),t=document.querySelector('.sport-tab[aria-current="page"]').getBoundingClientRect(),b=n.getBoundingClientRect();return {scroll:n.scrollWidth>n.clientWidth,inView:t.left>=b.left&&t.right<=b.right,over:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
   assert.deepEqual(r,{scroll:true,inView:true,over:0});await ctx.close();}
  {const {ctx,page}=await open(390,844,()=>{try{localStorage.setItem('matdraw.knownDevice','1');}catch{}});
   await page.waitForSelector('.home.known-device');
   const y=await page.evaluate(()=>[document.querySelector('.home-chat').getBoundingClientRect().top,document.querySelector('.login-form-panel').getBoundingClientRect().top,document.querySelector('.home-events').getBoundingClientRect().top]);assert.ok(y[1]<y[2]&&y[2]<y[0],'known device: sign-in above the tournaments and the chat');await ctx.close();}
  // very wide screens: the chat stops at 800px and the tournaments | chat | sign-in cluster stays centred (the production bug of the
  // first home page: everything drifted right, a big empty navy area on the left): the left column's card hugs the chat, the sign-in
  // form and the footer stay next to it, the empty margins on both sides match and the fills reach both screen edges
  for(const [w,h] of [[1680,1000],[1920,1080],[2000,1000],[2560,1300],[3840,1440]]){
   const {ctx,page}=await open(w,h);await page.waitForSelector('.upcoming-item');
   const r=await page.evaluate(()=>{const R=s=>document.querySelector(s).getBoundingClientRect(),c=R('.upcoming-card'),chat=R('.home-chat'),panel=R('.login-form-panel'),form=R('.login-form-content'),foot=R('.login-foot .footer'),main=R('.home-main'),vw=document.documentElement.clientWidth;
    return {cols:getComputedStyle(document.querySelector('.home-main')).gridTemplateColumns,card:c.width,gap:chat.left-c.right,ov:document.documentElement.scrollWidth-vw,left:c.left,right:vw-form.right,chat:(chat.left+chat.right)/2-vw/2,chatW:chat.width,
     formGap:form.left-chat.right,slot:[form.left-panel.left,foot.left-panel.left,foot.right-panel.left],navy:main.left,white:panel.right-vw};});
   const at=w+' '+JSON.stringify(r);
   assert.ok(r.card<=410&&r.card>=300&&r.gap>=0&&r.gap<=60&&r.ov===0&&r.chatW<=800,at);
   if(w===1680)assert.equal(r.cols,'440px 800px 440px',at);
   if(w>=2000){
    assert.ok(Math.abs(r.left-r.right)<=40,'empty margins left and right match: '+at);
    assert.ok(Math.abs(r.chat)<=40,'the chat card stays in the middle: '+at);
   }
   assert.ok(r.formGap>=20&&r.formGap<=100&&r.slot[0]>=34&&r.slot[1]>=34&&r.slot[2]<=440&&r.navy===0&&r.white===0,at);
   await ctx.close();
  }
  // the module event after the list is (re)painted: the placeholders exist when it fires
  {const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL'});
   await ctx.route('**/registry.js',async route=>{const res=await route.fetch(),body=await res.text();await route.fulfill({response:res,body:body+"\n;globalThis.__up=[];on('upcoming-painted',d=>globalThis.__up.push([document.querySelectorAll('.upcoming-item [data-chat-count]').length,d.tournaments.length]));"});});
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url+'#home?s=taekwondo');await page.waitForSelector('.upcoming-item');
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
   // after the sign-in: a page named in the address opens (strip and link mounts on the tournaments page)
   await page.goto(url+'#tournaments');await page.waitForSelector('.home #login-form');await page.click('[data-action="demo-login"][data-role="admin"]');await page.waitForSelector('.tournament-grid');
   assert.equal(await page.locator('[data-chat-mount="strip"]').count(),1);assert.ok(await page.locator('[data-chat-tournament-link]').count()>=1);
   await page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));const u=db.users.find(u=>u.role==='club');u.role='member';u.clubId=null;localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));});
   await page.click('[data-action="logout"]');await page.waitForSelector('.home #login-form');
   // a member signs in on the home page and stays there: the account card replaces the sign-in form
   const member=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).users.find(u=>u.role==='member').email);
   await page.fill('#login-form [name=email]',member);await page.fill('#login-form [name=password]','MatDrawDemo2026!');await page.click('.login-submit');await page.waitForSelector('.home.signed-in #home-account');
   assert.deepEqual(await page.evaluate(()=>[!!document.querySelector('#login-form'),document.querySelector('.home').dataset.sport,!!document.querySelector('.home-chat [data-chat-part="log"]')]),[false,'taekwondo',true]);
   // a member's preview without promo and with "Back" to the home page
   const id=await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).tournaments[0].id);
   await page.evaluate(i=>{location.hash='#guest?t='+i;},id);await page.waitForSelector('.guest-tabs');
   assert.deepEqual(await page.evaluate(()=>[!!document.querySelector('.promo'),!!document.querySelector('.access-card'),document.querySelector('.guest-login').dataset.page,document.querySelector('.guest-login').textContent.trim()]),[false,false,'home','Back']);
   await page.locator('.category-card').nth(1).click();await page.click('#guest-tab-chat');assert.ok(await page.locator('[data-chat-mount="tournament"]').count()===1);
   await page.click('#guest-tab-cats');await page.click('.guest-login');await page.waitForFunction(()=>location.hash==='#home');await page.waitForSelector('.home.signed-in');
   // "Wróć" (a data-page link) drops the preview: the next visit loads fresh data
   await page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));db.tournaments[0].name='Zmieniona nazwa';localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));});
   await page.evaluate(i=>{location.hash='#guest?t='+i;},id);await page.waitForSelector('.guest-tabs');
   assert.equal(await page.locator('#guest-title').innerText(),'Zmieniona nazwa','stale preview after Wróć');
   await ctx.close();}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});

// Final review F7: between 651 and 1199 px (and in the 1200 px centre column) the home chat card is narrow; the join prompt must
// stay readable, the list must show messages and every channel tab must be visible (no clipped tab strip). Sports with federations
// have four tabs (general and three federations; Karate's "Kyokushin" is the longest).
test('home chat card at tablet widths: readable join prompt, a usable message list, every channel tab visible',{skip:!chromium&&'Playwright is not installed',timeout:240000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),errors=[];
 try{
  for(const sport of ['taekwondo','karate'])for(const lang of ['pl','en'])for(const w of [651,700,768,820,900,1000,1001,1024,1100,1200,1280,1440,1650]){
   const ctx=await browser.newContext({viewport:{width:w,height:1024},locale:lang==='pl'?'pl-PL':'en-GB'});
   await ctx.addInitScript(l=>{try{localStorage.setItem('matdraw.language',l);}catch{}},lang);
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(url+'#home?s='+sport);await page.waitForSelector('.chat-card .chat-tab');
   // The demo has no sign-up: show the paid gate (create account + log in + price), the widest one, as the PHP build does.
   await page.evaluate(async()=>{const c=await import('./chat.js'),S=c._state();S.config={...(S.config||{}),signup:true,billing:true,amounts:{pln:899,usd:299}};dispatchEvent(new Event('offline'));dispatchEvent(new Event('online'));});
   await page.waitForSelector('.chat-card .chat-gate-price');
   const m=await page.evaluate(()=>{const q=s=>document.querySelector(s),r=s=>q(s).getBoundingClientRect(),tabs=q('.chat-card .chat-tabs'),box=tabs.getBoundingClientRect();
    const copy=q('.chat-gate-copy'),act=r('.chat-gate-actions'),c=r('.chat-gate-copy');
    return {copy:c.width,overlap:act.top<c.bottom-1&&act.left<c.right-1,clipped:copy.scrollWidth>copy.clientWidth+1,log:r('.chat-card .chat-log').height,n:tabs.querySelectorAll('.chat-tab').length,
     tabs:[...tabs.querySelectorAll('.chat-tab')].every(t=>{const b=t.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1;}),over:tabs.scrollWidth-tabs.clientWidth,
     rows:Object.values([...tabs.querySelectorAll('.chat-tab')].reduce((m,t)=>{const y=Math.round(t.getBoundingClientRect().top);m[y]=(m[y]||0)+1;return m;},{})),strip:box.width,hscroll:document.documentElement.scrollWidth-document.documentElement.clientWidth};});
   const at=sport+' '+lang+' '+w+' '+JSON.stringify(m);
   assert.equal(m.n,4,at);
   assert.ok(m.copy>=150,'join prompt copy column at least 150 px: '+at);assert.ok(!m.overlap&&!m.clipped,'copy not under the buttons: '+at);
   assert.ok(m.log>=200,'message list at least 200 px: '+at);assert.ok(m.tabs&&m.over<=0,'every tab inside the strip: '+at);assert.equal(m.hscroll,0,at);
   // Review R2: one row whenever the four tabs fit, otherwise an even grid, never a 3+1 row with an orphan.
   if(m.strip>=460)assert.equal(m.rows.length,1,'one tab row on a wide card: '+at);
   else assert.ok(m.rows.length===1||m.rows.every(n=>n===m.rows[0]),'even tab rows on a narrow card: '+at);
   if([1100,1280,1440,1650].includes(w))assert.equal(m.rows.length,1,'laptop widths keep one tab row: '+at);
   await ctx.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});
