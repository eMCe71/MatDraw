// Release build of the PWA (plan §9.1, §9.3, research 04 §1.7): sw.js filled from the template, version.json, precache rules and budget,
// a deterministic build number, the two manifests with their icons, offline.html in both languages and the hooks in index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,cpSync,rmSync,symlinkSync,mkdirSync,appendFileSync,openSync,readSync,closeSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPwa,DENY,LIMIT} from '../scripts/build-pwa.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url)),DIST=path.join(ROOT,'dist');
const TMP=mkdtempSync(path.join(tmpdir(),'matdraw-pwa-'));
test.after(()=>rmSync(TMP,{recursive:true,force:true}));
const sha=b=>createHash('sha256').update(b).digest('hex');
/** Runs scripts/build-php.mjs like CI does (without GITHUB_SHA) and returns the release's public/ directory. */
function buildPhp(name){
 const target=path.join(TMP,name+'-matdraw-php'),env={...process.env};delete env.GITHUB_SHA;
 const r=spawnSync(process.execPath,['scripts/build-php.mjs',target],{cwd:ROOT,env,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);return path.join(target,'public');
}
/** A fresh copy of dist/ with the API runtime config, ready for buildPwa. */
function copyDist(name,edit=()=>{}){
 const pub=path.join(TMP,name);cpSync(DIST,pub,{recursive:true});
 writeFileSync(path.join(pub,'runtime-config.js'),"export const CONFIG={mode:'api',apiBase:'./api/index.php'};\n");edit(pub);return pub;
}
/** The two values build-pwa writes into the template. */
function filled(pub){
 const sw=readFileSync(path.join(pub,'sw.js'),'utf8'),m=sw.match(/const BUILD=("[0-9a-f]{12}"),PRECACHE=(\[.*?\]);\n/);
 assert.ok(m,'BUILD and PRECACHE filled in');return {sw,build:JSON.parse(m[1]),list:JSON.parse(m[2])};
}
/** Width and height from a PNG's IHDR chunk. */
function pngSize(file){
 const b=Buffer.alloc(24),fd=openSync(file,'r');readSync(fd,b,0,24,0);closeSync(fd);
 assert.equal(b.toString('latin1',1,4),'PNG',file);assert.equal(b.toString('latin1',12,16),'IHDR',file);return [b.readUInt32BE(16),b.readUInt32BE(20)];
}

let release;
test('build-php fills sw.js: no markers left, valid JavaScript, build number equal to version.json',()=>{
 release=buildPhp('a');const {sw,build,list}=filled(release);
 assert.doesNotMatch(sw,/\/\*@(build|precache)\*\//);
 const check=spawnSync(process.execPath,['--check',path.join(release,'sw.js')],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 const version=JSON.parse(readFileSync(path.join(release,'version.json'),'utf8'));
 assert.deepEqual(Object.keys(version),['build','commit','files']);assert.equal(version.build,build);assert.equal(version.commit,'local');assert.equal(version.files,list.length);
 assert.ok(sw.includes(JSON.stringify(build)),'deploy-verify greps the build number in sw.js');
});
test('precache: files exist with the recorded SHA-256, nothing private or excluded, under 1.5 MB',()=>{
 const {list}=filled(release);let bytes=0;
 for(const [url,sum] of list){
  assert.match(url,/^\.\/[^/]/);const rel=url.slice(2),file=path.join(release,rel);
  assert.ok(existsSync(file),url);const body=readFileSync(file);bytes+=body.length;assert.equal(sha(body),sum,url);
  assert.doesNotMatch(rel,/^(api|u|live)(\/|$)/i,url);assert.ok(!DENY.some(r=>r.test(rel)),url);
 }
 assert.ok(bytes<LIMIT,`${bytes} bytes`);
 const urls=list.map(([u])=>u);
 for(const u of ['./index.html','./offline.html','./manifest.webmanifest','./manifest.en.webmanifest','./app.js','./runtime-config.js','./lang-boot.js','./styles.css','./brand/shortcut-chat-96.png','./fonts/manrope-latin.woff2'])assert.ok(urls.includes(u),u);
 for(const u of ['./sw.js','./version.json','./api/index.php','./.htaccess','./architecture.html','./promo/kyoruvo-storefront-1200.webp','./vendor/noble-hashes/sha2.js','./brand/og-image.jpg','./favicon.ico','./fonts/OFL-Manrope.txt'])assert.ok(!urls.includes(u),u);
 assert.equal(new Set(urls).size,urls.length,'no duplicates');
 assert.match(readFileSync(path.join(release,'runtime-config.js'),'utf8'),/mode:'api'/,'precache hashed the final runtime-config.js');
});
test('two builds of the same content give the same build number; a CSS change gives another; backend and api/ do not count',async()=>{
 const again=filled(buildPhp('b')).build;assert.equal(again,filled(release).build);
 const base=(await buildPwa(copyDist('p1'))).build,same=(await buildPwa(copyDist('p2'))).build;assert.equal(base,same);
 const css=(await buildPwa(copyDist('p3',pub=>appendFileSync(path.join(pub,'styles.css'),'\n.x{}')))).build;assert.notEqual(css,base);
 const api=(await buildPwa(copyDist('p4',pub=>{mkdirSync(path.join(pub,'api'));writeFileSync(path.join(pub,'api/index.php'),'<?php // changed');writeFileSync(path.join(pub,'.htaccess'),'# changed');}))).build;
 assert.equal(api,base);
 const renamed=(await buildPwa(copyDist('p5',pub=>cpSync(path.join(pub,'icons.js'),path.join(pub,'icons2.js'))))).build;assert.notEqual(renamed,base,'a new file changes the build');
});
test('build-pwa refuses a filled, broken or oversized release and does not follow symlinks',async()=>{
 const twice=copyDist('t1');await buildPwa(twice);await assert.rejects(buildPwa(twice),/markers missing or duplicated/,'second run on the same release');
 await assert.rejects(buildPwa(copyDist('t2',pub=>appendFileSync(path.join(pub,'sw.js'),"\n//"+"/*@build*/'dev'"))),/markers missing or duplicated/);
 await assert.rejects(buildPwa(copyDist('t3',pub=>rmSync(path.join(pub,'offline.html')))),/offline\.html is missing/);
 await assert.rejects(buildPwa(copyDist('t4',pub=>writeFileSync(path.join(pub,'big.bin'),Buffer.alloc(LIMIT)))),/above the/);
 const linked=copyDist('t5',pub=>{mkdirSync(path.join(TMP,'uploads'));writeFileSync(path.join(TMP,'uploads/a.webp'),'private');symlinkSync(path.join(TMP,'uploads'),path.join(pub,'files'));});
 assert.ok(!(await buildPwa(linked)).urls.some(u=>u.startsWith('./files/')));
 const php=await buildPwa(copyDist('t6',pub=>{mkdirSync(path.join(pub,'hooks'));for(const f of ['health.php','hooks/stripe.PHP','x.phtml','y.phar','z.php8'])writeFileSync(path.join(pub,f),'<?php echo 1;');}));
 assert.deepEqual(php.urls.filter(u=>/\.ph/i.test(u)),[],'server-side scripts are never precached');
});
test('manifests PL and EN: valid JSON, one identity, start_url in scope, language, icons with the declared sizes, maskable, shortcuts',()=>{
 const read=f=>JSON.parse(readFileSync(path.join(DIST,f),'utf8'));
 const pl=read('manifest.webmanifest'),en=read('manifest.en.webmanifest');
 assert.equal(pl.lang,'pl');assert.equal(en.lang,'en');assert.notEqual(pl.description,en.description);
 for(const m of [pl,en]){
  assert.equal(m.id,'/');assert.equal(m.name,'MatBravo');assert.equal(m.display,'standalone');assert.deepEqual(m.display_override,['standalone','minimal-ui']);
  const base='https://matbravo.com/',scope=new URL(m.scope,base).href;
  assert.ok(new URL(m.start_url,base).href.startsWith(scope),'start_url inside scope');assert.equal(m.start_url,'./?source=pwa');
  assert.equal(m.background_color,'#EFF8FF');assert.equal(m.theme_color,'#00448A');assert.deepEqual(m.categories,['sports','social']);
  assert.ok(m.icons.some(i=>i.purpose==='maskable'),'maskable icon');assert.ok(m.icons.some(i=>i.sizes==='192x192')&&m.icons.some(i=>i.sizes==='512x512'));
  const icons=[...m.icons,...m.shortcuts.flatMap(s=>s.icons)];
  for(const i of icons){const file=path.join(DIST,i.src);assert.ok(existsSync(file),i.src);assert.equal(pngSize(file).join('x'),i.sizes,i.src);assert.equal(i.type,'image/png');}
  assert.deepEqual(m.shortcuts.map(s=>s.url),['./?source=shortcut#chat','./?source=shortcut#tournaments']);
  for(const s of m.shortcuts)assert.ok(new URL(s.url,base).href.startsWith(scope));
  for(const s of m.screenshots||[])assert.ok(existsSync(path.join(DIST,s.src)),s.src);
 }
 for(const k of ['id','start_url','scope','icons','display','theme_color'])assert.deepEqual(pl[k],en[k],k);
 assert.deepEqual(pl.shortcuts.map(s=>s.name),['Czat','Turnieje']);assert.deepEqual(en.shortcuts.map(s=>s.name),['Chat','Tournaments']);
});
test('offline.html: both language blocks, lang-boot.js, no inline script or handler, only local files, retry link to ./',()=>{
 const html=readFileSync(path.join(DIST,'offline.html'),'utf8');
 assert.match(html,/<div class="pl" lang="pl"><h1>Brak połączenia z internetem<\/h1>/);assert.match(html,/<div class="en" lang="en"><h1>You are offline<\/h1>/);
 assert.match(html,/href="\.\/">Spróbuj ponownie</);assert.match(html,/href="\.\/">Try again</);
 assert.match(html,/<script src="\.\/lang-boot\.js"><\/script>/);
 assert.equal((html.match(/<script\b/g)||[]).length,1,'no other script');assert.doesNotMatch(html,/\son[a-z]+\s*=/i,'no inline handlers');
 assert.doesNotMatch(html,/(?:src|href)="(?!\.\/)/,'every src/href is relative to the app');assert.doesNotMatch(html,/url\((?!\.\/)/,'local font only');
 for(const ref of html.match(/(?:src|href)="\.\/[^"]+"/g).map(x=>x.slice(x.indexOf('"')+3,-1)).filter(Boolean))assert.ok(existsSync(path.join(DIST,ref)),ref);
 assert.match(html,/html\[lang=en\] \.pl,html:not\(\[lang=en\]\) \.en\{display:none\}/);
});
test('index.html links the Polish manifest and keeps #pwa-root outside #app',()=>{
 const html=readFileSync(path.join(DIST,'index.html'),'utf8');
 assert.match(html,/<link rel="manifest" href="\.\/manifest\.webmanifest">/);assert.match(html,/<div id="app"><\/div>.*<div id="pwa-root"><\/div>/s);
 assert.match(html,/<meta name="apple-mobile-web-app-title" content="MatBravo">/);
});
test('dist/sw.js is the template: unfilled markers, so the demo and local previews only pass requests through',()=>{
 const sw=readFileSync(path.join(DIST,'sw.js'),'utf8');assert.equal(sw.split("/*@build*/'dev'").length,2);assert.equal(sw.split('/*@precache*/[]').length,2);
 assert.ok(!existsSync(path.join(DIST,'version.json')),'version.json exists only in a release');
});

// Opt-in real-browser run (Chromium through Playwright; not in CI): MATDRAW_BROWSER_TESTS=1 [MATDRAW_PWA_PORT=8142] node --test tests/pwa-build.test.mjs
// Registers the worker by hand as pwa.js will (plan §9.2) and walks install, offline, the update on user action only, a half-deployed
// release, the kill switch (bare template) and the demo, against a static server that answers api/ itself and never from files.
const playwright=(()=>{if(!process.env.MATDRAW_BROWSER_TESTS)return null;try{return createRequire(import.meta.url)('playwright');}catch{return null;}})();
test('browser: install, offline, update only on SKIP_WAITING, half-deployed release, kill switch, demo',{skip:!playwright&&'set MATDRAW_BROWSER_TESTS=1 (needs playwright)',timeout:120000},async()=>{
 const make=async(name,css)=>{const pub=copyDist('br-'+name,p=>css&&appendFileSync(path.join(p,'styles.css'),css));return {pub,build:(await buildPwa(pub)).build};};
 const A=await make('a'),B=await make('b','\nbody{--release:b}\n'),C=await make('c','\nbody{--release:c}\n');
 const half=path.join(TMP,'br-half'),kill=path.join(TMP,'br-kill');
 cpSync(B.pub,half,{recursive:true});cpSync(path.join(C.pub,'sw.js'),path.join(half,'sw.js'));cpSync(B.pub,kill,{recursive:true});cpSync(path.join(DIST,'sw.js'),path.join(kill,'sw.js'));
 const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2'};
 let root=DIST,apiHits=0;
 const server=http.createServer((q,s)=>{
  const u=new URL(q.url,'http://x');if(u.pathname.startsWith('/api/')){apiHits++;s.writeHead(404,{'content-type':'application/json','cache-control':'no-store'});s.end('{"error":"Nie znaleziono."}');return;}
  const f=path.join(root,decodeURIComponent(u.pathname),u.pathname.endsWith('/')?'index.html':'');
  if(!f.startsWith(root)||!existsSync(f)||!statSync(f).isFile()){s.writeHead(404);s.end('not found');return;}
  s.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream','cache-control':'no-cache','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"});s.end(readFileSync(f));
 });
 await new Promise(r=>server.listen(+(process.env.MATDRAW_PWA_PORT||0),'127.0.0.1',r));
 // The server is closed also when Chromium cannot start, so no open handle keeps the test process alive.
 const base=`http://127.0.0.1:${server.address().port}`,browser=await playwright.chromium.launch().catch(e=>{server.close();throw e;});
 try{
  const demo=await browser.newContext(),d=await demo.newPage();await d.goto(base+'/');await d.waitForTimeout(2500);
  assert.equal(await d.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0,'the demo registers no worker');await demo.close();
  root=A.pub;const ctx=await browser.newContext({locale:'pl-PL'}),page=await ctx.newPage(),viaWorker=[];
  page.on('response',r=>{if(/^\/(api|u|live)\//.test(new URL(r.url()).pathname)&&r.fromServiceWorker())viaWorker.push(r.url());});
  const run=fn=>page.evaluate(fn);
  const version=()=>run(()=>new Promise(res=>{const c=navigator.serviceWorker.controller;if(!c)return res(null);navigator.serviceWorker.addEventListener('message',e=>res(e.data.build),{once:true});c.postMessage('VERSION');}));
  const waiting=()=>page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting,null,{timeout:20000,polling:200});
  const skip=async()=>{const loaded=page.waitForEvent('load');await run(async()=>{const r=await navigator.serviceWorker.getRegistration();navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());r.waiting.postMessage('SKIP_WAITING');});await loaded;await page.waitForFunction(()=>!!navigator.serviceWorker.controller);};
  await page.goto(base+'/');
  await run(async()=>{await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);assert.equal(await version(),A.build);
  assert.ok((await page.reload()).fromServiceWorker(),'app root from the worker');
  const hits=apiHits;assert.equal(await run(async()=>(await fetch('./api/index.php?route=me')).status),404);assert.ok(apiHits>hits,'api reaches the server');
  const stored=await run(async()=>{const out=[];for(const n of await caches.keys())for(const r of await (await caches.open(n)).keys())out.push(n+' '+new URL(r.url).pathname);return out;});
  assert.ok(stored.includes('matbravo-shell-'+A.build+' /index.html'));assert.ok(!stored.some(k=>/ \/(api|u|live)\//.test(k)),'nothing private cached');
  await ctx.setOffline(true);
  assert.ok((await page.reload()).fromServiceWorker(),'offline: app root');
  await page.goto(base+'/architecture.html');assert.equal(await page.locator('.pl h1').textContent(),'Brak połączenia z internetem');
  await page.goto(base+'/a/b/c');assert.equal(new URL(page.url()).pathname,'/offline.html');assert.ok(await page.locator('.pl h1').isVisible());
  await ctx.setOffline(false);await page.goto(base+'/');
  root=B.pub;await run(async()=>(await navigator.serviceWorker.getRegistration()).update());await waiting();
  await page.reload();await page.waitForTimeout(1000);assert.equal(await version(),A.build,'a waiting release does not take over by itself');
  assert.ok(await run(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting));
  await skip();assert.equal(await version(),B.build);assert.equal((await run(()=>getComputedStyle(document.body).getPropertyValue('--release'))).trim(),'b');
  const names=await run(()=>caches.keys());assert.ok(!names.includes('matbravo-shell-'+A.build)&&names.includes('matbravo-shell-'+B.build),names.join());
  root=half;const state=await run(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update().catch(()=>{});for(let i=0;i<100&&r.installing;i++)await new Promise(f=>setTimeout(f,100));return [!!r.installing,!!r.waiting];});
  assert.deepEqual(state,[false,false],'a half-deployed release fails its install');await page.reload();assert.equal(await version(),B.build);
  root=kill;await run(async()=>(await navigator.serviceWorker.getRegistration()).update());await waiting();await skip();await page.waitForTimeout(300);
  assert.deepEqual((await run(()=>caches.keys())).filter(n=>n.startsWith('matbravo-')),[],'the bare template clears the caches');
  assert.ok(!(await page.reload()).fromServiceWorker(),'and passes the app root through');
  assert.deepEqual(viaWorker,[],'api/, u/ and live/ never answered by the worker');
  await ctx.close();
 }finally{await browser.close();server.close();}
});
