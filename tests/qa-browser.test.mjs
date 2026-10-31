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
