// Service worker harness (plan §9.2, research 04 §1.4.2 and §1.7): dist/sw.js runs in node:vm with mocked caches, fetch and events.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const TEMPLATE=readFileSync(new URL('../dist/sw.js',import.meta.url),'utf8');
const ORIGIN='https://matbravo.test',abs=u=>new URL(u,ORIGIN+'/').href,sha=s=>createHash('sha256').update(s).digest('hex');
const SHELL_FILES={'./index.html':'<!doctype html>index-v1','./offline.html':'<!doctype html>offline-v1','./app.js':'app-v1','./styles.css':'css-v1','./brand/icon-192.png':'icon-v1'};

/** Fake origin: path -> {body,status,redirected,headers}; records every network request; can go offline. */
function server(files){
 const s={files:new Map(Object.entries(files).map(([u,body])=>[abs(u),{body}])),log:[],offline:false};
 s.fetch=async req=>{
  const url=typeof req==='string'?abs(req):req.url;s.log.push(url);
  if(s.offline)throw new TypeError('Failed to fetch');
  const f=s.files.get(url.split('?')[0].replace(/\/$/,'/index.html'))||{body:'missing',status:404};
  const res=new Response(f.body,{status:f.status||200,headers:f.headers||{}});
  Object.defineProperty(res,'type',{value:f.type||'basic'});Object.defineProperty(res,'redirected',{value:!!f.redirected});
  return res;
 };
 return s;
}
/** Cache Storage keyed by URL; honours ignoreSearch, and, more strictly than a browser, misses any stored response that carries Vary
 * unless ignoreVary is set (in Chromium a Vary: Accept-Encoding from mod_deflate can make an otherwise equal request miss). */
function cacheStorage(){
 const stores=new Map();
 const make=()=>{const m=new Map();return {m,
  async put(r,res){const u=typeof r==='string'?abs(r):r.url;await res.clone().arrayBuffer();m.set(u,res.clone());},
  async match(r,o={}){const u=typeof r==='string'?abs(r):r.url;const hit=m.get(u)||(o.ignoreSearch?m.get(u.split('?')[0]):undefined);return hit&&(o.ignoreVary||!hit.headers.has('vary'))?hit.clone():undefined;},
  async keys(){return [...m.keys()].map(url=>({url}));},
  async delete(r){return m.delete(typeof r==='string'?r:r.url);}};};
 return {stores,
  async open(n){if(!stores.has(n))stores.set(n,make());return stores.get(n);},
  async keys(){return [...stores.keys()];},
  async delete(n){return stores.delete(n);},
  async has(n){return stores.has(n);}};
}
class Req extends Request{constructor(u,o){super(typeof u==='string'?abs(u):u,o);}}
/** Loads the worker. list: precache entries [url,sha256]; null keeps the template untouched (pass-through mode). */
function load({list=Object.entries(SHELL_FILES).map(([u,b])=>[u,sha(b)]),build='abc123def456',files=SHELL_FILES,caches=cacheStorage()}={}){
 const src=list?TEMPLATE.replace("/*@build*/'dev'",JSON.stringify(build)).replace('/*@precache*/[]',JSON.stringify(list)):TEMPLATE;
 const net=server(files),L={},sw={location:new URL(ORIGIN+'/sw.js'),skipped:0,claimed:0,addEventListener:(t,f)=>{L[t]=f;},clients:{claim:async()=>{sw.claimed++;}},skipWaiting:async()=>{sw.skipped++;}};
 vm.runInNewContext(src,{self:sw,caches,fetch:net.fetch,Request:Req,Response,Headers,URL,Promise,Error,TypeError,Set,Map,Uint8Array,crypto:globalThis.crypto,decodeURIComponent,console});
 /** Dispatches an event; resolves with the response given to respondWith (undefined when not intercepted) after every waitUntil. */
 const run=async(type,ev={})=>{const waits=[];let responded;ev.waitUntil=p=>{waits.push(p);};ev.respondWith=p=>{responded=p;};L[type](ev);
  const res=responded?await responded:undefined;await Promise.all(waits);return res;};
 const fetchEvent=(url,o={})=>run('fetch',{request:{url:abs(url),method:'GET',mode:'no-cors',cache:'default',headers:new Headers(),...o}});
 return {sw,net,caches,run,fetchEvent,build};
}
const installed=async(opts)=>{const w=load(opts);await w.run('install');await w.run('activate');w.net.log.length=0;return w;};

test('install precaches every listed file with cache:reload, all or nothing',async()=>{
 const w=load();await w.run('install');
 assert.deepEqual(w.net.log.sort(),Object.keys(SHELL_FILES).map(abs).sort(),'one network request per precache entry');
 const shell=w.caches.stores.get('matbravo-shell-'+w.build);assert.ok(shell,'versioned shell cache');assert.equal(shell.m.size,5);
 assert.equal(await (await shell.match('./app.js')).text(),'app-v1');
});
test('install uses cache:reload so the HTTP cache cannot supply a stale copy',async()=>{
 assert.match(TEMPLATE,/new Request\(u,\{cache:'reload'/);
 const w=load(),modes=[];const orig=globalThis.Request;
 const Spy=class extends Req{constructor(u,o){super(u,o);modes.push(o&&o.cache);}};
 const L={};vm.runInNewContext(TEMPLATE.replace("/*@build*/'dev'","'x'").replace('/*@precache*/[]',JSON.stringify([['./app.js',sha('app-v1')]])),{self:{location:new URL(ORIGIN+'/sw.js'),addEventListener:(t,f)=>{L[t]=f;}},caches:cacheStorage(),fetch:w.net.fetch,Request:Spy,Response,Headers,URL,Promise,Error,Set,Map,Uint8Array,crypto:globalThis.crypto,decodeURIComponent});
 let p;L.install({waitUntil:x=>{p=x;}});await p;assert.deepEqual(modes,['reload']);assert.equal(globalThis.Request,orig);
});
test('install fails on a 404, a redirect or content that differs from the build checksum',async()=>{
 for(const change of [{status:404},{redirected:true},{body:'app-v2 (deployed half-way)'}]){
  const w=load();Object.assign(w.net.files.get(abs('./app.js')),change);
  await assert.rejects(w.run('install'),/precache \.\/app\.js/,JSON.stringify(change));
 }
});
test('navigation to the app root is answered from the precache with no network request, query ignored',async()=>{
 const w=await installed();
 for(const url of ['/','/?source=pwa','/index.html','/?billing=success&session_id=cs_1']){
  const res=await w.fetchEvent(url,{mode:'navigate'});assert.equal(await res.text(),'<!doctype html>index-v1',url);
 }
 assert.equal(w.net.log.length,0);
 w.net.offline=true;assert.equal(await (await w.fetchEvent('/',{mode:'navigate'})).text(),'<!doctype html>index-v1','works offline');
});
test('private and non-GET requests are never intercepted, so they are never cached',async()=>{
 const w=await installed();
 const cases=[['/api/index.php?route=bootstrap'],['/api/index.php?route=public-chat',{mode:'cors'}],['/API/index.php'],['/%61pi/x.png'],['/u/abc/avatar.webp'],['/live/lobby.json'],['/api/index.php',{mode:'navigate'}],['/u/abc/avatar.webp',{mode:'navigate'}],
  ['/api/index.php',{method:'POST'}],['/app.js',{method:'HEAD'}],['https://evil.test/app.js'],['https://evil.test/',{mode:'navigate'}],['/app.js',{headers:new Headers({range:'bytes=0-1'})}],
  ['/sw.js'],['/version.json'],['/version.json',{mode:'navigate'}],['/brand/icon-192.png',{cache:'only-if-cached',mode:'no-cors'}],
  ['//u/abc/avatar.webp'],['///api//x.png'],['/%2Fu/abc/avatar.webp'],['//live/lobby.json',{mode:'navigate'}],['//sw.js']];
 for(const [url,o] of cases)assert.equal(await w.fetchEvent(url,o),undefined,url+' '+JSON.stringify(o||{}));
 for(const store of w.caches.stores.values())for(const k of store.m.keys())assert.doesNotMatch(new URL(k).pathname,/^\/(api|u|live)\//i,k);
});
test('a shell file comes from the versioned cache, also with a query string and offline',async()=>{
 const w=await installed();
 assert.equal(await (await w.fetchEvent('/app.js',{mode:'cors'})).text(),'app-v1');
 assert.equal(await (await w.fetchEvent('/styles.css?v=9')).text(),'css-v1');
 w.net.offline=true;assert.equal(await (await w.fetchEvent('/app.js')).text(),'app-v1');assert.equal(w.net.log.length,0);
});
test('a shell file missing from the cache goes to the network and is not copied into a runtime cache',async()=>{
 const w=await installed();await w.caches.stores.get('matbravo-shell-'+w.build).delete(abs('./app.js'));
 w.net.files.get(abs('./app.js')).body='app-v2';
 assert.equal(await (await w.fetchEvent('/app.js')).text(),'app-v2');
 assert.ok(!w.caches.stores.has('matbravo-static-1')||![...w.caches.stores.get('matbravo-static-1').m.keys()].some(k=>k.endsWith('/app.js')));
});
test('code outside the precache is left to the network (no runtime caching of scripts, styles or pages)',async()=>{
 const w=await installed({files:{...SHELL_FILES,'./vendor/noble-hashes/sha2.js':'v','./architecture.js':'a'}});
 for(const url of ['/vendor/noble-hashes/sha2.js','/architecture.js','/new-module.js','/x.css','/data.json'])assert.equal(await w.fetchEvent(url),undefined,url);
});
test('other images and fonts: stale-while-revalidate in matbravo-static-1, served offline',async()=>{
 const w=await installed({files:{...SHELL_FILES,'./promo/ad.webp':'ad-v1'}});
 assert.equal(await (await w.fetchEvent('/promo/ad.webp')).text(),'ad-v1');assert.equal(w.net.log.length,1);
 w.net.files.get(abs('./promo/ad.webp')).body='ad-v2';
 assert.equal(await (await w.fetchEvent('/promo/ad.webp')).text(),'ad-v1','stale copy first');
 assert.equal(await (await w.fetchEvent('/promo/ad.webp')).text(),'ad-v2','revalidated in the background');
 w.net.offline=true;assert.equal(await (await w.fetchEvent('/promo/ad.webp')).text(),'ad-v2','offline from the static cache');
});
test('runtime images: no-store, private, error or non-basic responses are not stored, and the cache is capped',async()=>{
 const files={...SHELL_FILES,'./a.png':'a','./b.png':'b','./c.png':'c'};const w=await installed({files});
 w.net.files.get(abs('./a.png')).headers={'cache-control':'private, max-age=60'};w.net.files.get(abs('./b.png')).status=500;w.net.files.get(abs('./c.png')).type='opaque';
 for(const u of ['/a.png','/b.png','/c.png'])await w.fetchEvent(u);
 assert.equal((w.caches.stores.get('matbravo-static-1')?.m.size)||0,0);
 for(let i=0;i<65;i++){w.net.files.set(abs(`./g${i}.png`),{body:'g'+i});await w.fetchEvent(`/g${i}.png`);}
 assert.equal(w.caches.stores.get('matbravo-static-1').m.size,60);
});
test('another navigation uses the network, and offline.html when offline (deeper paths are sent to it)',async()=>{
 const w=await installed({files:{...SHELL_FILES,'./architecture.html':'arch'}});
 assert.equal(await (await w.fetchEvent('/architecture.html',{mode:'navigate'})).text(),'arch');
 w.net.offline=true;
 assert.equal(await (await w.fetchEvent('/architecture.html',{mode:'navigate'})).text(),'<!doctype html>offline-v1');
 const deep=await w.fetchEvent('/a/b/c',{mode:'navigate'});assert.equal(deep.status,302);assert.equal(deep.headers.get('location'),abs('./offline.html'));
});
test('activate removes earlier MatBravo caches, keeps foreign ones and claims the open pages',async()=>{
 const caches=cacheStorage();for(const n of ['matbravo-shell-old','matbravo-static-0','other-app','workbox-precache'])await caches.open(n);
 const w=load({caches});await w.run('install');await w.run('activate');
 assert.deepEqual((await caches.keys()).sort(),['matbravo-shell-'+w.build,'other-app','workbox-precache'].sort());assert.equal(w.sw.claimed,1);
});
test('a new worker waits: skipWaiting only on the SKIP_WAITING message; VERSION answers the build',async()=>{
 const w=load();await w.run('install');assert.equal(w.sw.skipped,0,'not on install');await w.run('activate');assert.equal(w.sw.skipped,0,'not on activate');
 w.run('message',{data:'noise'});w.run('message',{data:{type:'SKIP_WAITING'}});assert.equal(w.sw.skipped,0);
 w.run('message',{data:'SKIP_WAITING'});assert.equal(w.sw.skipped,1);
 const got=[];w.run('message',{data:'VERSION',source:{postMessage:m=>got.push(m)}});assert.equal(JSON.stringify(got),JSON.stringify([{build:w.build}]));
 const code=TEMPLATE.replace(/\/\*[\s\S]*?\*\//g,'').split('\n').filter(l=>/skipWaiting/.test(l));
 assert.equal(code.length,1);assert.match(code[0],/addEventListener\('message'.*e\.data==='SKIP_WAITING'\)self\.skipWaiting\(\)/,'the only skipWaiting call is behind the message');
});
test('the template (no precache list) passes everything through and its activation clears every MatBravo cache',async()=>{
 const caches=cacheStorage(),got=[];for(const n of ['matbravo-shell-abc','matbravo-static-1','other-app'])await caches.open(n);
 const w=load({list:null,caches});await w.run('install');assert.equal(w.net.log.length,0,'install fetches nothing');
 for(const [url,o] of [['/',{mode:'navigate'}],['/app.js'],['/promo/ad.webp']])assert.equal(await w.fetchEvent(url,o),undefined,url);
 await w.run('activate');assert.deepEqual(await caches.keys(),['other-app']);
 w.run('message',{data:'VERSION',source:{postMessage:m=>got.push(m)}});assert.equal(JSON.stringify(got),'[{"build":"dev"}]');
});
test('responses with Vary (mod_deflate) still come from the caches: root navigation, shell files and runtime images',async()=>{
 const w=load({files:{...SHELL_FILES,'./promo/ad.webp':'ad-v1'}});for(const f of w.net.files.values())f.headers={vary:'Accept-Encoding'};
 await w.run('install');await w.run('activate');w.net.log.length=0;
 assert.equal(await (await w.fetchEvent('/?source=pwa',{mode:'navigate'})).text(),'<!doctype html>index-v1');
 assert.equal(await (await w.fetchEvent('/app.js?v=2')).text(),'app-v1');assert.equal(w.net.log.length,0,'no network for the shell');
 await w.fetchEvent('/promo/ad.webp');w.net.offline=true;
 assert.equal(await (await w.fetchEvent('/promo/ad.webp')).text(),'ad-v1','runtime image offline');
 assert.equal(await (await w.fetchEvent('/a/b',{mode:'navigate'})).status,302,'offline page found');
 assert.equal(await (await w.fetchEvent('/architecture.html',{mode:'navigate'})).text(),'<!doctype html>offline-v1');
});
test('an unreadable cache never breaks a request: the network answers',async()=>{
 const w=await installed();w.caches.open=async()=>{throw new Error('storage broken');};
 assert.equal(await (await w.fetchEvent('/',{mode:'navigate'})).text(),'<!doctype html>index-v1');
 assert.equal(await (await w.fetchEvent('/app.js')).text(),'app-v1');assert.equal(w.net.log.length,2);
});
