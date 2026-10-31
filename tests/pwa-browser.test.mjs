// PWA interface in a real browser (plan §9.4): the DOM wiring of dist/pwa.js (heartbeat, detectors, #screen and print, fullscreen,
// in-app banner focus, logout, live regions). A harness page loads the real pwa.js in the API mode (runtime-config.js is overridden by
// the test server), so no backend is needed; service workers are blocked. Skipped when Playwright or Chromium is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
let chromium=null;try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const HARNESS={
 '/harness.html':['text/html; charset=utf-8','<!doctype html><html lang="pl"><head><meta charset="utf-8"><link rel="manifest" href="./manifest.webmanifest"><link rel="stylesheet" href="./pwa.css"></head><body><div id="toast"></div><div id="pwa-root"></div><form id="f"><input id="name" type="text"></form><form class="chat-composer"><input id="chat" type="text"></form><input id="plain" type="text"><script type="module" src="./harness.js"></script></body></html>'],
 '/harness.js':['text/javascript; charset=utf-8',"import {registry} from './registry.js';registry.provide('ui',{getWorkspace:()=>window.__ws||null,icon:()=>'',toast:m=>{(window.__toasts=window.__toasts||[]).push(m);}});window.__registry=registry;await import('./pwa.js');window.__ready=true;"],
 '/runtime-config.js':['text/javascript; charset=utf-8',"export const CONFIG={mode:'api',apiBase:'./api/index.php'};"]
};
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  const p=decodeURIComponent(new URL(req.url,'http://x').pathname);
  if(HARNESS[p]){res.writeHead(200,{'Content-Type':HARNESS[p][0],'Content-Security-Policy':CSP});res.end(HARNESS[p][1]);return;}
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const ANDROID='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const INSTAGRAM=ANDROID+' Instagram 330.0.0.0';
const WS={user:{id:'u1',clubId:'club-1'},tournaments:[]};

test('pwa.js in a browser: fullscreen is not an install, the card respects modal, signup mark, #screen and logout, in-app focus, live regions',{skip:!chromium&&'Playwright is not installed',timeout:120000},async()=>{
 const {server,url}=await serve();let browser;
 try{browser=await chromium.launch();}catch(error){server.close();return;}
 const errors=[];
 const open=async({ua,hash='',clipboard=false,seed=true}={})=>{
  const ctx=await browser.newContext({viewport:{width:390,height:800},serviceWorkers:'block',locale:'pl-PL',...(ua?{userAgent:ua,hasTouch:true,isMobile:true}:{})});
  await ctx.addInitScript(({seed,clipboard})=>{
   try{if(seed&&!localStorage.getItem('matdraw.pwa'))localStorage.setItem('matdraw.pwa',JSON.stringify({first:'2026-10-01',day:'2026-10-30',days:2}));}catch{}
   if(clipboard)Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(new Error('blocked'))},configurable:true});
  },{seed,clipboard});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-31T10:00:00Z')});
  await page.goto(url+'harness.html'+hash);await page.waitForFunction(()=>window.__ready===true);
  const signIn=()=>page.evaluate(ws=>{window.__ws=ws;window.__registry.emit('ready',{workspace:ws});},WS);
  const offer=()=>page.evaluate(()=>window.dispatchEvent(Object.assign(new Event('beforeinstallprompt',{cancelable:true}),{prompt(){},userChoice:Promise.resolve({outcome:'dismissed'})})));
  const card=()=>page.locator('.pwa-card,.pwa-chip').count();
  return {ctx,page,signIn,offer,card};
 };
 try{
  // fullscreen (the hall view's button, F11) is not an installed app: no remembered "installed", no data-standalone
  { const {ctx,page,signIn}=await open();await signIn();
    await page.evaluate(()=>document.documentElement.requestFullscreen());
    await page.waitForFunction(()=>!!document.fullscreenElement);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>matchMedia('(display-mode: fullscreen)').matches),true,'Chromium matches display-mode: fullscreen under the Fullscreen API');
    assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-standalone')),false);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.pwa')||'{}').installed||0),0,'fullscreen must not mute install prompts for good');
    await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.pwa')||'{}').installed||0),0);
    assert.equal(await page.evaluate(()=>window.__registry.use('pwa').standalone()),false);
    await ctx.close(); }

  // live regions are in the accessibility tree from the start, empty; the card region is hidden until used
  { const {ctx,page,signIn}=await open();await signIn();
    const regions=await page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('[data-pwa-region]')].map(el=>[el.dataset.pwaRegion,{hidden:el.hidden,role:el.getAttribute('role'),empty:el.childElementCount===0,height:el.getBoundingClientRect().height}])));
    assert.deepEqual(regions.update,{hidden:false,role:'status',empty:true,height:0});assert.deepEqual(regions.blocking,{hidden:false,role:'alert',empty:true,height:0});
    assert.equal(regions.card.hidden,true);
    await ctx.close(); }

  // the install card on a phone: never with a modal open, never during signup/payment, then it comes; gone after logout
  { const {ctx,page,signIn,offer,card}=await open({ua:ANDROID});await signIn();await offer();
    await page.evaluate(()=>document.body.classList.add('modal-open'));await page.clock.runFor(16000);
    assert.equal(await card(),0,'a modal is open');
    await page.evaluate(()=>{document.body.classList.remove('modal-open');sessionStorage.setItem('matdraw.flow.active',String(Date.now()));});await page.clock.runFor(6000);
    assert.equal(await card(),0,'signup or payment in progress');
    await page.evaluate(()=>{sessionStorage.removeItem('matdraw.flow.active');document.querySelector('#name').focus();});await page.clock.runFor(6000);
    assert.equal(await card(),0,'a field has focus');
    await page.evaluate(()=>document.activeElement.blur());await page.clock.runFor(6000);
    assert.equal(await page.locator('.pwa-card').count(),1,'the card is shown once everything permits');
    assert.match(await page.locator('.pwa-card').innerText(),/Zainstaluj/);
    await page.evaluate(()=>window.__registry.emit('logout',{expired:true}));
    assert.equal(await card(),0,'a person whose session expired is a guest: no card');
    await ctx.close(); }

  // typing marks a form dirty; searches and the chat composer do not
  { const {ctx,page,signIn}=await open();await signIn();
    await page.fill('#chat','hello');assert.equal(await page.evaluate(()=>document.querySelector('.chat-composer').hasAttribute('data-dirty')),false);
    await page.fill('#name','Anna');assert.equal(await page.evaluate(()=>document.querySelector('#f').hasAttribute('data-dirty')),true);
    await ctx.close(); }

  // #screen and the print preview: nothing is shown
  { const {ctx,page,signIn,offer,card}=await open({ua:ANDROID,hash:'#screen?tournament=t-1'});await signIn();await offer();await page.clock.runFor(21000);
    assert.equal(await card(),0,'never on #screen');
    await page.evaluate(()=>{location.hash='#chat';});await page.evaluate(()=>document.body.classList.add('print-preview'));await page.clock.runFor(6000);
    assert.equal(await card(),0,'never in the print preview');
    await ctx.close(); }

  // in-app browser, clipboard refused: the URL is focused once, later repaints do not steal focus from a dialog
  { const {ctx,page,signIn}=await open({ua:INSTAGRAM,clipboard:true});await signIn();await page.clock.runFor(5000);
    await page.locator('[data-pwa-act="copy"]').click();
    await page.waitForSelector('.pwa-url');
    assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('pwa-url')),true,'focused once after the fallback appears');
    await page.evaluate(()=>document.querySelector('#plain').focus());
    await page.evaluate(()=>document.body.classList.add('modal-open'));await page.evaluate(()=>document.body.classList.remove('modal-open'));
    await page.evaluate(()=>{location.hash='#x';});await page.evaluate(()=>window.__registry.emit('painted'));await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'plain','paint() never pulls focus back to the link field');
    await ctx.close(); }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});
