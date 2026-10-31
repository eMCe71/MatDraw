import {CONFIG} from './runtime-config.js';
import {initialWorkspace,execute,publicWorkspace,DomainError} from './workspace.js';
import {guestUpcoming,guestTournament,warsawToday} from './guest-view.js';
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
async function api(route,method='GET',data){let response;try{response=await fetch(CONFIG.apiBase+'?route='+encodeURIComponent(route),{method,credentials:'same-origin',headers:{Accept:'application/json',...(method!=='GET'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});}catch{throw new Error('Brak połączenia z serwerem. Zapis nie został potwierdzony.');}let result;try{result=await response.json();}catch{throw new Error('Serwer nie zwrócił odpowiedzi MatBravo. Sprawdź konfigurację PHP.');}if(result.csrf)csrf=result.csrf;if(!response.ok)throw new DomainError(result.error||'Nie udało się wykonać operacji.',response.status);return result;}
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
async function publicApi(params){
 const controller=typeof AbortController==='function'?new AbortController():null,timer=controller&&setTimeout(()=>controller.abort(),8000);
 try{
  let response;try{response=await fetch(CONFIG.apiBase+'?'+new URLSearchParams(params),{method:'GET',credentials:'omit',headers:{Accept:'application/json'},signal:controller?.signal});}catch{throw new Error('Brak połączenia z serwerem.');}
  let result;try{result=await response.json();}catch{throw new Error('Serwer nie zwrócił odpowiedzi MatBravo. Sprawdź konfigurację PHP.');}
  if(!response.ok)throw new DomainError(result.error||'Nie udało się wykonać operacji.',response.status);return result;
 }finally{clearTimeout(timer);}
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
