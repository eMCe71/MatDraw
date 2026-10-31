/* MatBravo service worker. dist/sw.js is the template: scripts/build-pwa.mjs fills the two markers in the release (plan §9.2–9.3, research 04 §1.4).
 * Without a precache list (dist/ preview, local development, or an emergency release) the worker answers nothing and, when it activates,
 * removes every matbravo-* cache, so deploying the bare template is the kill switch for a bad release.
 * Rules, kept deliberately narrow because a wrong cache can pin old app code on a phone:
 * - only same-origin GET without Range is looked at; api/, u/ (uploads), live/, sw.js and version.json are never answered or stored
 *   (no respondWith: the browser goes straight to the network with its normal HTTP cache rules);
 * - the app shell comes from one cache per release, filled all-or-nothing on install; every file must match the SHA-256 the build
 *   recorded, so a half-deployed or stale server copy fails the install and the previous release keeps running;
 * - a navigation to the app root gets index.html from that cache; any other navigation goes to the network and gets offline.html offline;
 * - shell files are never cached at run time; other same-origin images and fonts use stale-while-revalidate in matbravo-static-1,
 *   and any other file (scripts, styles, pages, data outside the shell) is left to the network, so two releases are never mixed;
 * - a new worker waits: it takes over only after the page sends 'SKIP_WAITING' (the user clicked "Refresh", or the client_outdated path). */
const BUILD=/*@build*/'dev',PRECACHE=/*@precache*/[];
const live=PRECACHE.length>0,SHELL='matbravo-shell-'+BUILD,STATIC='matbravo-static-1',KEEP=live?[SHELL,STATIC]:[],STATIC_MAX=60;
const scope=new URL('./',self.location).pathname,at=p=>new URL(p,self.location).href,INDEX=at('./index.html'),OFFLINE=at('./offline.html');
const SHELL_PATHS=new Set(PRECACHE.map(([u])=>new URL(u,self.location).pathname));
const PRIVATE=new RegExp('^'+scope.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:api|u|live)(?:/|$)','i');
const NEVER=new Set([scope+'sw.js',scope+'version.json']),MEDIA=/\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?)$/i;
/** Decoded path (so /%61pi/ counts as api/); null when it cannot be decoded, and such a request is left alone. */
const decoded=u=>{try{return decodeURIComponent(u.pathname);}catch{return null;}};
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');

self.addEventListener('install',e=>{if(live)e.waitUntil(precache());});
async function precache(){
 const c=await caches.open(SHELL);
 // cache:'reload' bypasses the HTTP cache; a redirect, an error status or a checksum mismatch rejects the whole install.
 await Promise.all(PRECACHE.map(async([u,sum])=>{
  const res=await fetch(new Request(u,{cache:'reload',credentials:'same-origin'}));
  if(!res.ok||res.redirected)throw Error('precache '+u+': '+res.status+(res.redirected?' redirected':''));
  if(hex(await crypto.subtle.digest('SHA-256',await res.clone().arrayBuffer()))!==sum)throw Error('precache '+u+': content differs from build '+BUILD);
  await c.put(u,res);
 }));
}
self.addEventListener('activate',e=>e.waitUntil((async()=>{
 for(const k of await caches.keys())if(k.startsWith('matbravo-')&&!KEEP.includes(k))await caches.delete(k);
 await self.clients.claim();
})()));
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting();else if(e.data==='VERSION'&&e.source)e.source.postMessage({build:BUILD});});

self.addEventListener('fetch',e=>{
 const r=e.request;if(!live||r.method!=='GET'||r.headers.has('range')||(r.cache==='only-if-cached'&&r.mode!=='same-origin'))return;
 const u=new URL(r.url);if(u.origin!==self.location.origin)return;
 const p=decoded(u);if(p===null||PRIVATE.test(p)||NEVER.has(p)||NEVER.has(u.pathname))return;
 if(r.mode==='navigate')e.respondWith(navigation(r,p));
 else if(SHELL_PATHS.has(u.pathname))e.respondWith(shellFile(r));
 else if(MEDIA.test(p))e.respondWith(media(e,r));
});
/** The cached response, or undefined when the cache is missing or unreadable (the caller then uses the network). */
async function cached(name,r,opts){try{return await (await caches.open(name)).match(r,opts);}catch{return undefined;}}
async function navigation(r,p){
 if(p===scope||p===scope+'index.html'){const page=await cached(SHELL,INDEX,{ignoreVary:true});if(page)return page;}
 try{return await fetch(r);}catch(err){
  const page=await cached(SHELL,OFFLINE,{ignoreVary:true});if(!page)throw err;
  // offline.html uses relative links, so a deeper address is sent to the page at the root instead of being answered in place.
  return p.slice(scope.length).includes('/')?Response.redirect(OFFLINE,302):page;
 }
}
/** A shell file only ever comes from this release's cache; if the entry is missing (storage cleared), the network, never a runtime copy. */
async function shellFile(r){return await cached(SHELL,r,{ignoreSearch:true,ignoreVary:true})||fetch(r);}
async function media(e,r){
 const old=await cached(STATIC,r,{ignoreVary:true});
 const net=fetch(r).then(res=>{
  if(res.status===200&&res.type==='basic'&&!/no-store|private/i.test(res.headers.get('cache-control')||''))e.waitUntil(store(r,res.clone()));
  return res;
 });
 e.waitUntil(net.catch(()=>{}));
 return old||net;
}
async function store(r,res){try{
 const c=await caches.open(STATIC);await c.put(r,res);
 const keys=await c.keys();for(const k of keys.slice(0,Math.max(0,keys.length-STATIC_MAX)))await c.delete(k);
}catch{}}
