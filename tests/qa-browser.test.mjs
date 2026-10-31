// Browser regressions found in the integration QA (plan §11, manual list): the static demo (dist/ served with the production CSP)
// in Chromium. Keyboard focus on the chat channel tabs, the archive toggle and the phone menu button survives the repaints; the demo moderation page renders (its tab
// strip was a plain string); the print preview ends when the address changes; a member's shell avatar shows the member's own
// initials; the phone menu has a language switch (the full-screen chat covers the top bar); no console error, CSP violation or
// horizontal scroll on the main demo pages at 360 px.
// Opt-in like the other browser tests: MATDRAW_BROWSER_TESTS=1 node --test tests/qa-browser.test.mjs (skipped without Playwright).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS)try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'";
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('demo in a browser: tab focus across repaints, moderation page, print preview, member initials, no errors or overflow',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:180000},async t=>{
 const {server,url}=await serve();let browser;
 try{browser=await chromium.launch();}catch(error){server.close();t.skip('Chromium cannot start: '+error.message);return;}
 const problems=[];
 const open=async({width=1440,height=900}={})=>{
  const ctx=await browser.newContext({viewport:{width,height},locale:'pl-PL',serviceWorkers:'block'});
  await ctx.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));});
  const page=await ctx.newPage();
  page.on('pageerror',e=>problems.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error')problems.push('console: '+m.text().slice(0,200));});
  return {ctx,page};
 };
 const demoLogin=async(page,i=0)=>{await page.goto(url);await page.locator('[data-action="demo-login"]').nth(i).click();await page.waitForSelector('.app-shell');};
 const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 try{
  // 1. Home chat: arrow keys move the selection and the focus stays on the selected tab after the next repaints.
  { const {ctx,page}=await open();await page.goto(url);await page.waitForSelector('.chat-tabs [role="tab"][aria-selected="true"]');await sleep(800);
    await page.locator('.chat-tabs [role="tab"][aria-selected="true"]').focus();
    const first=await page.evaluate(()=>document.activeElement.dataset.key);
    await page.keyboard.press('ArrowRight');await sleep(3500);
    const after=await page.evaluate(()=>({focus:document.activeElement?.dataset?.key??null,role:document.activeElement?.getAttribute('role'),selected:document.querySelector('.chat-tabs [aria-selected="true"]')?.dataset.key}));
    assert.notEqual(after.selected,first,'ArrowRight selects the next channel');
    assert.equal(after.role,'tab','focus stays on a tab after the repaint');assert.equal(after.focus,after.selected,'on the selected one');
    await page.keyboard.press('ArrowLeft');await sleep(2500);
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.key),first);
    assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    await ctx.close();}
  // 2. Demo admin: moderation and members pages render their demo notice; print preview ends on navigation; staff keep club initials.
  { const {ctx,page}=await open();await demoLogin(page,0);
    await page.goto(url+'#moderation');await page.waitForSelector('[data-mod-root]');await sleep(500);
    assert.match(await page.locator('#main').innerText(),/niedostępna w wersji demonstracyjnej/);
    assert.equal(await page.locator('[data-mod-tabs] [role="tab"]').count(),0,'no tabs in the demo');
    await page.goto(url+'#draws');await page.locator('[data-action="category"]').first().click();
    await page.evaluate(()=>{window.print=()=>{};});
    await page.locator('#main button',{hasText:'Drukuj'}).first().click();await page.locator('#print-form').waitFor();
    await page.locator('.modal [type="submit"]').click();
    await page.waitForFunction(()=>document.body.classList.contains('print-preview'));
    await page.evaluate(()=>{location.hash='#overview';});await sleep(400);
    assert.equal(await page.evaluate(()=>document.body.classList.contains('print-preview')),false,'a new address leaves the print preview');
    assert.ok(await page.locator('#main').isVisible());
    assert.equal(await page.evaluate(async()=>{const m=await import('./account-boot.js');return [m.selfInitials({user:{role:'member'},profile:{firstName:' marta',lastName:'Kowalska'}}),m.selfInitials({user:{role:'admin'},profile:{firstName:'Anna',lastName:'Demo'}}),m.selfInitials(null)].join('|');}),'MK||');
    assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    await ctx.close();}
  // 2b. Chat page: when an unread count changes, the rail is rewritten and the focus stays on the archive toggle (a <summary>
  // without data-chat-act) with the archive kept open; on a phone a rewrite of the conversation header keeps the focus on the menu
  // button (data-action="menu"). The demo lists only upcoming tournaments, so the test adds an archived one to the chat lists.
  for(const [width,height,part,sel] of [[1440,900,'rail','.chat-rail details.chat-arch>summary'],[360,780,'convhead','.chat-conv-head [data-action="menu"]']]){
    const {ctx,page}=await open({width,height});await demoLogin(page,0);
    await page.goto(url+'#chat');await page.waitForSelector('[data-chat-part="'+part+'"] *');await sleep(800);
    await page.evaluate(async()=>{
     const chat=await import('./chat.js'),S=chat._state(),row=k=>{const c=S.channels.get(k);return c.kind==='lobby'?{id:Number(k),slug:c.slug,scope:c.scope,st:c.st,last:c.known||0,count:c.count||0}:{id:Number(k),tournamentId:c.tid,title:c.title,date:c.date,city:c.city,st:c.st,last:c.known||0,count:c.count||0};};
     chat._internals.applyLists({lobby:S.lobby.map(row),tournaments:[...S.tours.map(row),{id:990,tournamentId:'qa-past',title:'Puchar 2020',date:'2020-03-01',city:'Kraków',st:'archive',last:0,count:0}]});
     window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));
    });
    await page.waitForSelector(sel);await page.locator(sel).focus();
    if(part==='rail'){await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.querySelector('.chat-rail details.chat-arch').open),true,'Enter opens the archive');}
    await page.evaluate(async part=>{
     const chat=await import('./chat.js'),S=chat._state(),v=document.querySelector('.chat-full').closest('[data-chat-mount]')?.chatView;
     window.__before=document.activeElement;
     if(part==='rail')S.channels.get(S.lobby.find(k=>k!==v?.key)).n=7;else document.querySelector('[data-chat-part="convhead"]').chatHtml='';
     window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));
    },part);
    const st=await page.evaluate(sel=>({replaced:!window.__before.isConnected,on:document.activeElement===document.querySelector(sel),open:document.querySelector('.chat-rail details.chat-arch')?.open??null}),sel);
    assert.equal(st.replaced,true,part+' was rewritten');assert.equal(st.on,true,'focus stays on '+sel+' after the '+part+' repaint');
    if(part==='rail')assert.equal(st.open,true,'the archive stays open');
    assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    await ctx.close();}
  // 3. 360 px: home, public chat, guest preview and the demo club pages without horizontal scroll.
  { const {ctx,page}=await open({width:360,height:780});
    for(const hash of ['','#chat']){await page.goto(url+hash);await sleep(1200);assert.ok(await overflow(page)<=0,'no horizontal scroll on '+(hash||'home'));}
    await demoLogin(page,2);
    for(const hash of ['#tournaments','#athletes','#chat','#profile']){await page.goto(url+hash);await sleep(900);assert.ok(await overflow(page)<=0,'no horizontal scroll on '+hash);}
    // the full-screen chat covers the top bar on a phone: the menu carries the language switch, and a draft survives the switch
    await page.goto(url+'#chat');await page.locator('textarea[data-chat-input]').first().fill('Szkic');
    await page.locator('.chat-back[data-action="menu"]').click();
    const en=page.locator('.sidebar-lang [data-set-lang="en"]');assert.ok(await en.isVisible(),'language switch in the phone menu');
    await en.click();await page.waitForFunction(()=>document.documentElement.lang==='en');
    assert.equal(await page.locator('textarea[data-chat-input]').first().inputValue(),'Szkic');
    assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
    await ctx.close();}
  assert.deepEqual(problems,[],'no page or console errors');
 }finally{await browser.close();server.close();}
});

// Final review (ux-a11y): the modal focus trap reaches every control after a canvas or textarea (F5), closing a dialog or menu opened
// from a message toolbar returns focus to its button (F6), boolean ARIA states are never empty (F9) and the feed is named after the
// channel (F10).
const PNG=()=>readFile(join(root,'brand/icon-192.png'));
const EMPTY_ARIA='[aria-selected=""],[aria-pressed=""],[aria-checked=""],[aria-expanded=""]';
const active=page=>page.evaluate(()=>{const a=document.activeElement;if(!a||a===document.body)return 'BODY';return a.getAttribute('aria-label')||a.textContent.trim().slice(0,40)||a.tagName;});
test('final review in a browser: focus trap in the crop dialog, focus back to message toolbars, ARIA states, feed names',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:180000},async t=>{
 const {server,url}=await serve();let browser;
 try{browser=await chromium.launch();}catch(error){server.close();t.skip('Chromium cannot start: '+error.message);return;}
 const problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();
  page.on('pageerror',e=>problems.push('pageerror: '+e.message));page.on('console',m=>{if(m.type()==='error')problems.push('console: '+m.text().slice(0,200));});
  await page.goto(url);await page.waitForSelector('.chat-tabs [role="tab"]');await sleep(600);
  assert.deepEqual(await page.$$eval(EMPTY_ARIA,els=>els.map(e=>e.outerHTML.slice(0,80))),[],'home: no empty ARIA state');
  assert.match(await page.getAttribute('.chat-card .chat-log','aria-label'),/^Wiadomości: \S/,'home feed named after the channel');
  await page.locator('[data-action="demo-login"]').first().click();await page.waitForSelector('.app-shell');
  await page.goto(url+'#chat');await page.waitForSelector('.chat-full .chat-msg[data-id]');await sleep(600);
  assert.deepEqual(await page.$$eval(EMPTY_ARIA,els=>els.map(e=>e.outerHTML.slice(0,80))),[],'chat page: no empty ARIA state');
  const names=()=>page.evaluate(()=>[document.querySelector('.chat-full .chat-log').getAttribute('aria-label'),document.querySelector('.chat-conv').getAttribute('aria-label')]);
  const [feed,conv]=await names();assert.match(feed,/^Wiadomości: \S/);assert.notEqual(conv,'Czat');assert.equal(feed,'Wiadomości: '+conv);
  await page.locator('.chat-rail [data-chat-act="open"]:not([aria-current])').first().click();await sleep(500);
  const [feed2]=await names();assert.notEqual(feed2,feed,'the name follows a channel switch');
  // toolbar buttons: focus the message, then its button, open, close; focus must come back to the button (not <body>)
  const toolbar=async act=>{await page.evaluate(act=>{const m=[...document.querySelectorAll('.chat-full .chat-msg[data-id]')].reverse().find(x=>x.querySelector('[data-chat-act="'+act+'"]'));m.tabIndex=-1;m.focus();m.querySelector('[data-chat-act="'+act+'"]').focus();},act);return active(page);};
  const report=await toolbar('report');assert.equal(report,'Zgłoś wiadomość');
  await page.keyboard.press('Enter');await page.waitForSelector('#chat-report-form');await page.keyboard.press('Escape');await sleep(100);
  assert.equal(await active(page),'Zgłoś wiadomość','Esc in the report dialog');
  await page.keyboard.press('Enter');await page.waitForSelector('#chat-report-form');await page.click('.modal [data-action="close-modal"]');await sleep(100);
  assert.equal(await active(page),'Zgłoś wiadomość','Anuluj in the report dialog');
  const more=await toolbar('more');assert.equal(more,'Więcej działań');
  await page.keyboard.press('Enter');await page.waitForSelector('.chat-menu');await page.keyboard.press('Escape');await sleep(100);
  assert.equal(await active(page),'Więcej działań','Esc in the menu');
  await page.keyboard.press('Enter');await page.waitForSelector('.chat-menu');await page.focus('.chat-menu [data-chat-act="report"]');await page.keyboard.press('Enter');
  await page.waitForSelector('#chat-report-form');await page.keyboard.press('Escape');await sleep(100);
  assert.equal(await active(page),'Więcej działań','menu, Zgłoś, Esc');
  // avatar crop dialog: forward Tab from the canvas reaches the zoom, the nudges, Anuluj and Zapisz zdjęcie, then wraps
  await page.goto(url+'#profile');await page.waitForSelector('#acct-profile-form [data-acct-file]',{state:'attached'});
  assert.deepEqual(await page.$$eval(EMPTY_ARIA,els=>els.map(e=>e.outerHTML.slice(0,80))),[],'profile: no empty ARIA state');
  await page.setInputFiles('#acct-profile-form [data-acct-file]',{name:'a.png',mimeType:'image/png',buffer:await PNG()});
  await page.waitForFunction(()=>document.activeElement?.classList.contains('acct-crop-canvas'));
  const order=[];for(let i=0;i<14;i++){await page.keyboard.press('Tab');order.push(await active(page));}
  for(const label of ['Pomniejsz','Powiększ','W prawo','Anuluj','Zapisz zdjęcie'])assert.ok(order.includes(label),label+' in '+order.join(' | '));
  assert.equal(order[order.indexOf('Zapisz zdjęcie')+1],'Zamknij okno','after the last control Tab wraps to the first');
  const back=[];await page.focus('.acct-crop-canvas');for(let i=0;i<2;i++){await page.keyboard.press('Shift+Tab');back.push(await active(page));}
  assert.deepEqual(back,['Zamknij okno','Zapisz zdjęcie'],'Shift+Tab from the canvas');
  await ctx.close();
  // Phone menu opened from the full-screen chat (F14): focus moves into the drawer, Tab stays there, Esc closes it and focus returns
  // to the chat's menu button; the buttons expose aria-expanded.
  { const ctx3=await browser.newContext({viewport:{width:390,height:844},locale:'pl-PL',serviceWorkers:'block'}),p3=await ctx3.newPage();p3.on('pageerror',e=>problems.push('pageerror: '+e.message));
    await p3.goto(url);await p3.locator('[data-action="demo-login"]').first().click();await p3.waitForSelector('.app-shell');
    await p3.goto(url+'#chat');await p3.waitForSelector('.chat-back[data-action="menu"]');await sleep(400);
    assert.equal(await p3.getAttribute('.chat-back[data-action="menu"]','aria-expanded'),'false');
    await p3.focus('.chat-back[data-action="menu"]');await p3.keyboard.press('Enter');await p3.waitForSelector('#app-sidebar.open');
    assert.equal(await p3.evaluate(()=>!!document.activeElement?.closest('#app-sidebar')),true,'focus in the drawer');
    assert.equal(await p3.getAttribute('.topbar [data-action="menu"]','aria-expanded'),'true');
    const outside=[];for(let i=0;i<25;i++){await p3.keyboard.press(i%7===6?'Shift+Tab':'Tab');if(!(await p3.evaluate(()=>!!document.activeElement?.closest('#app-sidebar'))))outside.push(i);}
    assert.deepEqual(outside,[],'Tab stays in the drawer');
    await p3.keyboard.press('Escape');await p3.waitForFunction(()=>!document.querySelector('#app-sidebar.open'));
    await p3.waitForFunction(()=>document.activeElement?.matches('.chat-back[data-action="menu"]'),null,{timeout:3000});
    assert.equal(await p3.getAttribute('.chat-back[data-action="menu"]','aria-expanded'),'false');
    await ctx3.close();}
  // The login lead (F13) no longer says accounts come only from the Administrator (public sign-up exists).
  { const ctx2=await browser.newContext({viewport:{width:1440,height:900},locale:'en-GB',serviceWorkers:'block'});await ctx2.addInitScript(()=>{try{localStorage.setItem('matdraw.language','en');}catch{}});
    const p2=await ctx2.newPage();await p2.goto(url);await p2.waitForSelector('.login-form-content');
    assert.match(await p2.textContent('.login-form-content'),/club account or your MatBravo member account/);assert.doesNotMatch(await p2.textContent('.login-form-content'),/received from the Administrator/);
    await ctx2.close();}
  assert.deepEqual(problems,[],'no page or console errors');
 }finally{await browser.close();server.close();}
});

// Final review F8: a laptop at 200 % and 400 % zoom (640×400 and 320×256 CSS px) gets the phone layout; the full-screen chat must not
// squeeze the messages to a sliver, and the join prompt (with its price) or the composer must stay reachable by scrolling.
test('full chat on short screens (200 % and 400 % zoom): messages keep a usable height, the gate and the composer stay reachable',{skip:!chromium&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:180000},async t=>{
 const {server,url}=await serve();let browser;
 try{browser=await chromium.launch();}catch(error){server.close();t.skip('Chromium cannot start: '+error.message);return;}
 const problems=[];
 try{
  for(const [width,height] of [[640,400],[320,256]])for(const who of ['guest','member']){
   const ctx=await browser.newContext({viewport:{width,height},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();
   page.on('pageerror',e=>problems.push('pageerror: '+e.message));
   if(who==='member'){await page.goto(url);await page.locator('[data-action="demo-login"]').last().click();await page.waitForSelector('.app-shell');}
   await page.goto(url+'#chat');await page.waitForSelector('.chat-full .chat-msg');await sleep(600);
   if(who==='guest')await page.evaluate(async()=>{const c=await import('./chat.js'),S=c._state();S.config={...(S.config||{}),signup:true,billing:true,amounts:{pln:899,usd:299}};dispatchEvent(new Event('offline'));dispatchEvent(new Event('online'));});
   const target=who==='guest'?'.chat-full .chat-gate-price':'.chat-full textarea[data-chat-input]';await page.waitForSelector(target);
   const at=who+' '+width+'x'+height;
   assert.ok(await page.evaluate(()=>document.querySelector('.chat-full .chat-log').getBoundingClientRect().height)>=150,'message list at least 150 px: '+at);
   const reach=await page.evaluate(sel=>{const el=document.querySelector(sel);el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect(),x=b.left+Math.min(b.width/2,20),y=b.top+b.height/2;const hit=document.elementFromPoint(x,y);return {inView:b.top>=0&&b.bottom<=innerHeight,hit:!!hit&&(el===hit||el.contains(hit))};},target);
   assert.deepEqual(reach,{inView:true,hit:true},(who==='guest'?'price line':'composer')+' reachable: '+at);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no horizontal scroll: '+at);
   await ctx.close();
  }
  // A phone keeps the full-screen chat (position:fixed, no page scroll inside the chat).
  const ctx=await browser.newContext({viewport:{width:390,height:844},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();
  await page.goto(url);await page.locator('[data-action="demo-login"]').last().click();await page.waitForSelector('.app-shell');
  await page.goto(url+'#chat');await page.waitForSelector('.chat-full .chat-msg');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.chat-page-mount .chat-full')).position),'fixed');
  await ctx.close();
  // Review R1: on a touch phone the on-screen keyboard shrinks the viewport (interactive-widget=resizes-content) below 480 px; the
  // full chat must stay fixed above it, with the composer in view and the back button shown, not fall back to the zoom layout.
  for(const [width,height,keyboard] of [[412,800,450],[390,740,420],[360,640,340]]){
   const ctx=await browser.newContext({viewport:{width,height},locale:'pl-PL',serviceWorkers:'block',isMobile:true,hasTouch:true}),page=await ctx.newPage();
   page.on('pageerror',e=>problems.push('pageerror: '+e.message));
   await page.goto(url);await page.locator('[data-action="demo-login"]').last().click();await page.waitForSelector('.app-shell');
   await page.goto(url+'#chat');await page.waitForSelector('.chat-full textarea[data-chat-input]');await sleep(400);
   await page.focus('.chat-full textarea[data-chat-input]');
   await page.setViewportSize({width,height:keyboard});await sleep(300);
   const m=await page.evaluate(()=>{const ta=document.querySelector('.chat-full textarea[data-chat-input]'),b=ta.getBoundingClientRect(),back=document.querySelector('.chat-page-mount .chat-back');
    return {pos:getComputedStyle(document.querySelector('.chat-page-mount .chat-full')).position,composer:b.top>=0&&b.bottom<=innerHeight,back:!!back&&back.getClientRects().length>0,focused:document.activeElement===ta};});
   assert.deepEqual(m,{pos:'fixed',composer:true,back:true,focused:true},'keyboard open on a phone '+width+'x'+height+' -> '+width+'x'+keyboard);
   await ctx.close();
  }
  assert.deepEqual(problems,[],'no page errors');
 }finally{await browser.close();server.close();}
});
