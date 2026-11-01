import {CONFIG} from './runtime-config.js';
import {initialWorkspace,execute,publicWorkspace,DomainError,organizer,trustedOrganizer} from './workspace.js';
import {guestUpcoming,guestTournament,warsawToday} from './guest-view.js';
import {emit} from './registry.js';
const KEY='matdraw.workspace.v2',SESSION='matdraw.session.v2';
export const isDemo=CONFIG.mode==='demo';
let db=null,session=null,csrf='',authVersion=null,demoQueue=Promise.resolve();
const locked=fn=>navigator.locks?navigator.locks.request('matdraw-workspace-write',fn):(demoQueue=demoQueue.catch(()=>{}).then(fn));
export function validatePassword(password){if(typeof password!=='string'||new TextEncoder().encode(password).length<12||new TextEncoder().encode(password).length>72)throw new Error('Hasło musi mieć 12–72 bajty (np. co najmniej 12 znaków łacińskich).');}
async function hash(password,salt){if(!crypto.subtle){const [{pbkdf2Async},{sha256}]=await Promise.all([import('./vendor/noble-hashes/pbkdf2.js'),import('./vendor/noble-hashes/sha2.js')]);return Array.from(await pbkdf2Async(sha256,password,salt,{c:210000,dkLen:32}),b=>b.toString(16).padStart(2,'0')).join('');}const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);return [...new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:210000,hash:'SHA-256'},key,256))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function credentials(user,password){validatePassword(password);user.passwordSalt=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');user.passwordHash=await hash(password,user.passwordSalt);user.authVersion=(user.authVersion||0)+1;}
const save=()=>localStorage.setItem(KEY,JSON.stringify(db));
function read(){const raw=localStorage.getItem(KEY);if(raw)db=JSON.parse(raw);}
function me(){const u=db?.users.find(u=>u.id===session&&u.active&&u.authVersion===authVersion);if(!u)throw new DomainError('Zaloguj się ponownie.',401);return u;}
/** Version of the client contract (plan §4.1, §8.4): sent as X-MatBravo-Client with every API request. A server that needs a newer
 * client answers 409 {code:'client_outdated'}; the registry then emits 'client-outdated' (pwa.js applies the update). */
export const CLIENT_API=1;
const CLIENT_HEADER={'X-MatBravo-Client':String(CLIENT_API)};
export const apiUrl=params=>CONFIG.apiBase+'?'+new URLSearchParams(typeof params==='string'?{route:params}:params);
/** Error from an API JSON body: message and status as before, plus every other field (retry, until, code, portal…) in error.data. */
function failure(result,status){
 const {error,csrf:_,...data}=result&&typeof result==='object'?result:{};
 const out=error?new DomainError(error,status):new DomainError('Nie udało się wykonać operacji.',status);out.data=data;if(data.code)out.code=data.code;
 if(status===409&&data.code==='client_outdated')emit('client-outdated',{message:out.message});
 return out;
}
async function call(params,{method='GET',body,contentType,signal}={}){
 const write=method!=='GET'&&method!=='HEAD',headers={Accept:'application/json',...CLIENT_HEADER,...(write?{'Content-Type':contentType||'application/json','X-CSRF-Token':csrf}:{})};
 let response;try{response=await fetch(apiUrl(params),{method,credentials:'same-origin',headers,...(write&&body!==undefined?{body:contentType?body:JSON.stringify(body)}:{}),...(signal?{signal}:{})});}
 catch(error){if(signal?.aborted)throw error;throw write?new Error('Brak połączenia z serwerem. Zapis nie został potwierdzony.'):new Error('Brak połączenia z serwerem.');}
 if(response.status===204)return null;
 let result;try{result=await response.json();}catch{throw new Error('Serwer nie zwrócił odpowiedzi MatBravo. Sprawdź konfigurację PHP.');}
 if(result?.csrf)csrf=result.csrf;if(!response.ok)throw failure(result,response.status);return result;
}
async function api(route,method='GET',data){return call({route},{method,body:data});}
/** Session request for feature routes (plan §8.4). route is a route name or a params object with route (GET query: ids, cursors).
 * JSON body by default; contentType sends body as raw bytes (avatar upload). 204 gives null. The demo has no server. */
export async function request(route,{method='GET',body,contentType,signal}={}){
 if(isDemo)throw new Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.');
 return call(typeof route==='string'?{route}:route,{method,body,contentType,signal});
}
export async function init(){
 if(!isDemo){const s=await api('session');return s.user?await bootstrap():null;}
 read();if(!db){let old;try{old=JSON.parse(localStorage.getItem('matdraw.demo.v1')||'null');}catch{}db=initialWorkspace(old);for(const u of db.users)await credentials(u,'MatDrawDemo2026!');save();}
 try{const saved=JSON.parse(sessionStorage.getItem(SESSION)||'null');session=saved?.id;authVersion=saved?.version;return me()?publicWorkspace(db,me()):null;}catch{return null;}
}
export async function bootstrap(){if(!isDemo)return api('bootstrap');read();return publicWorkspace(db,me());}
export async function login(email,password){
 if(!isDemo){await api('login','POST',{email,password});return bootstrap();}
 read();const u=db.users.find(u=>u.email.toLowerCase()===email.trim().toLowerCase()&&u.active);
 if(!u||await hash(password,u.passwordSalt)!==u.passwordHash)throw new Error('Nieprawidłowy e-mail lub hasło.');
 session=u.id;authVersion=u.authVersion;sessionStorage.setItem(SESSION,JSON.stringify({id:session,version:authVersion}));return publicWorkspace(db,u);
}
export async function logout(){if(!isDemo)await api('logout','POST',{});session=null;authVersion=null;sessionStorage.removeItem(SESSION);}
export async function command(type,payload,expectedRevision){
 if(!isDemo)return api('command','POST',{type,payload,expectedRevision});
 return locked(async()=>{
  read();const actor=me();let next,result;
  if(type==='account.password'){
   if(payload.id!==actor.id&&actor.role!=='admin')throw new DomainError('Brak uprawnień.',403);
   if(expectedRevision!==db.revision)throw new DomainError('Dane zmieniły się. Odśwież widok.',409);
   if(payload.id===actor.id&&await hash(payload.currentPassword||'',actor.passwordSalt)!==actor.passwordHash)throw new Error('Nieprawidłowe obecne hasło.');
   next=structuredClone(db);const u=next.users.find(u=>u.id===payload.id);if(!u)throw new Error('Konto nie istnieje.');await credentials(u,payload.password);next.revision++;result={id:u.id};
  }else{
   const out=execute(db,actor.id,type,payload,expectedRevision);next=out.db;result=out.result;
   if(type==='account.save'&&payload.password){const u=next.users.find(u=>u.id===result.id);await credentials(u,payload.password);}
   if(type==='account.save'&&!payload.id&&!payload.password)throw new Error('Podaj hasło nowego konta.');
  }
  db=next;save();const updated=db.users.find(u=>u.id===actor.id);
  if(result.id===actor.id&&updated.active){authVersion=updated.authVersion;sessionStorage.setItem(SESSION,JSON.stringify({id:session,version:authVersion}));}
  return {workspace:publicWorkspace(db,me()),result};
 });
}
export const dataKey=KEY;
// Public guest data (login screen list and read-only preview): GET only, without cookies or CSRF.
// The demo serves the same projection (dist/guest-view.js) from this browser's demo data.
async function publicFetch(params,{signal,timeout=8000}={}){
 const controller=typeof AbortController==='function'?new AbortController():null,timer=controller&&setTimeout(()=>controller.abort(),timeout);
 const stop=()=>controller?.abort();if(signal){if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});}
 try{
  let response;try{response=await fetch(apiUrl(params),{method:'GET',credentials:'omit',headers:{Accept:'application/json',...CLIENT_HEADER},signal:controller?.signal});}
  catch(error){if(signal?.aborted)throw error;throw new Error('Brak połączenia z serwerem.');}
  if(response.status===204)return {status:204,data:null};
  let result;try{result=await response.json();}catch{throw new Error('Serwer nie zwrócił odpowiedzi MatBravo. Sprawdź konfigurację PHP.');}
  if(response.status===409&&result?.code==='client_outdated')throw failure(result,409);
  return {status:response.status,data:result};
 }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',stop);}
}
async function publicApi(params){const {status,data}=await publicFetch(params);if(status<200||status>299)throw failure(data,status);return data;}
/** public-config of the demo: the keys of the server (PLAN-REJESTRACJA-ROLE §8.1). The demo has no sign-up (signupMode 'off',
 * §10.7) and no payments; amounts are the defaults of config.php; roles: the demo has the member roles. */
const DEMO_PUBLIC_CONFIG=()=>({signup:false,signupMode:'off',billing:false,amounts:{pln:899,usd:299},avatars:false,support:null,roles:true});
const NO_CAPS={organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:false};
/** Demo only: the role fields of me for demo account userId (§8.1, §8.2, the shapes of the me route), from this browser's
 * demo data: caps {organizer, organizerBlocked, organizerTrusted, athlete} (as Actors::build; all false for staff),
 * athletes [{profileId,name,relation,archived}] of the account (by id), signupMode 'off' (no sign-up in the demo, §10.7),
 * selfEntry true (self entries run on the demo data, §10.7) and, for the Administrator only, pendingOrganizers: active
 * organizers not blocked and not confirmed, 0 while the confirmation is not required (db.flags.trustRequired=false, §17). */
export function demoAccount(userId){
 if(!isDemo)throw new Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.');
 read();const u=db?.users.find(x=>x.id===userId)||null,member=u?.role==='member';
 const owned=member?db.profiles.filter(p=>p.ownerId===userId).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0):[];
 const caps=member?{organizer:organizer(u),organizerBlocked:u.organizerBlockedAt!=null,organizerTrusted:u.organizerTrustedAt!=null,athlete:owned.some(p=>!p.archived)}:{...NO_CAPS};
 const athletes=owned.map(p=>({profileId:p.id,name:typeof p.name==='string'?p.name:'',relation:['self','guardian'].includes(p.relation)?p.relation:null,archived:!!p.archived}));
 const features={signupMode:'off',selfEntry:true};
 if(u?.role==='admin')features.pendingOrganizers=db.users.filter(x=>x.role==='member'&&x.active&&organizer(x)&&!trustedOrganizer(db,x.id)).length;
 return {caps,athletes,features};
}
/** Public GET without cookies (plan §8.4): {status,data} for every HTTP answer (204 gives data null), so callers can read 429/503.
 * Network failure, timeout (default 8 s) and non-JSON answers throw; an aborted signal rethrows the AbortError. */
export async function publicGet(params,options={}){
 if(isDemo){if(params?.route==='public-config')return {status:200,data:DEMO_PUBLIC_CONFIG()};throw new Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.');}
 return publicFetch(params,options);
}
const demoTournaments=()=>{read();return db?.tournaments||[];};
export async function upcoming(){
 if(!isDemo)return publicApi({route:'public'});
 return JSON.parse(JSON.stringify(guestUpcoming(demoTournaments(),warsawToday())));
}
export async function publicTournament(id){
 if(!isDemo)return publicApi({route:'public-tournament',id});
 const out=guestTournament(demoTournaments(),id,warsawToday());if(!out)throw new DomainError('Turniej nie jest dostępny.',404);
 return JSON.parse(JSON.stringify(out));
}
