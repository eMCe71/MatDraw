// Accounts, profiles and photos over real PHP and MariaDB/MySQL (plan §11, accounts-profiles-backend). Run through
// scripts/test-http.sh (signup on, billing enabled and enforced, uploads in the work directory). Scenarios: sign-up
// (signup-begin, server-measured time, bot trap, invite token, disabled, duplicates, address limit); username-check
// (POST only, 403 before sign-up, states, suggestions without the full surname unless it is shown, limit); profile (validation, default initial, 30-day rule);
// photos (formats, dimensions, size, EXIF removed, access before 304, two people with the same picture); the Admin's
// member panel (literal LIKE, filters, create/active/password/email/profile/delete, members only); member-email,
// member-password, account-delete (confirmEnd); the abandoned-account cleanup; diagnostics.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client,base,eventually,fixture} from './helpers/http-client.mjs';
const shared=process.env.MATDRAW_TEST_SHARED_DIR;const skip=!base||!shared;
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!',NEW_PASSWORD='Another-Password-2026';
const now=()=>Math.floor(Date.now()/1000);
const image=name=>readFileSync(new URL('./fixtures/avatars/'+name,import.meta.url));
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
async function signIn(email,password=PASSWORD){const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
const sid=c=>c.cookie.split('=')[1];
async function get(route,{cookie,headers={}}={}){
 const r=await fetch(base+'?route='+route,{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{}),...headers}});
 const buf=Buffer.from(await r.arrayBuffer());let data=null;try{data=JSON.parse(buf.toString('utf8'));}catch{}
 return {status:r.status,headers:r.headers,data,buf};
}
async function upload(c,bytes,type='image/webp'){
 const r=await fetch(base+'?route=avatar-upload',{method:'POST',headers:{'X-MatBravo-Client':'1',Cookie:c.cookie,'X-CSRF-Token':c.csrf,'Content-Type':type},body:bytes});
 const data=await r.json();if(data?.csrf)c.csrf=data.csrf;return {status:r.status,data,headers:r.headers};
}
/** A member from the fixture with a complete profile; exempt=true gives full access (billing is enforced in the test config). */
function member(prefix,{exempt=false,profile={}}={}){const email=uniq(prefix)+'@example.test';return {...fixture('member',{email,profile:{firstName:'Test',lastName:'Członek',...profile},exempt}),email};}
/** Rewrites config keys (fixture accounts-config), then polls observe() until the server returns `want` (no fixed sleeps). */
async function setConfig(set,observe,want){const old=fixture('accounts-config',{set});assert.deepEqual(await eventually(observe,want),want,'the server applies '+JSON.stringify(set));return old;}
const publicConfig=async key=>(await get('public-config')).data?.[key];
async function me(c){const r=await get('me',{cookie:c.cookie});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
/** A session that started the sign-up form $age seconds ago (server-side time, §3.6). */
async function begun(age=10,body={}){const c=await fresh();const r=await c.req('signup-begin',body);assert.equal(r.status,200,JSON.stringify(r.data));if(age)fixture('session-edit',{sid:sid(c),set:{signup_at:now()-age}});return c;}
const signupBody=(over={})=>({email:uniq('new')+'@example.test',password:PASSWORD,firstName:'Marta',lastName:'Kowalska',username:uniq('m'),country:'PL',sports:['taekwondo'],clubText:null,showClub:false,website:'',...over});

before(()=>fixture('reset-limits'));
beforeEach(()=>fixture('reset-limits'));

test('sign-up: signup-begin, server-measured time, bot trap, success with an empty billing row',{skip},async()=>{
 let c=await fresh();
 assert.equal((await c.req('signup',signupBody())).status,400,'without signup-begin');
 c=await begun(0);const quick=await c.req('signup',signupBody());
 assert.equal(quick.status,400);assert.equal(quick.data.error,'Nie udało się założyć konta. Spróbuj ponownie.');
 c=await begun();const trap=await c.req('signup',signupBody({website:'http://spam.example'}));assert.deepEqual([trap.status,trap.data.error],[400,quick.data.error],'same message for the trap');
 assert.equal((await c.req('signup',signupBody({country:'XX'}))).status,422);
 assert.equal((await c.req('signup',signupBody({password:'short'}))).status,422);
 const body=signupBody({email:'  '+uniq('Marta.New')+'@Example.TEST ',username:uniq('Marta.N')});
 const r=await c.req('signup',body);assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual(Object.keys(r.data).sort(),['csrf','user']);assert.equal(r.data.user.role,'member');assert.equal(r.data.user.clubId,null);assert.equal(r.data.user.email,body.email.trim().toLowerCase());
 const m=await me(c);
 assert.deepEqual([m.profile.username,m.profile.firstName,m.profile.nameDisplay,m.profile.complete,m.profile.showClub,m.profile.usernameChangeAt],[body.username.toLowerCase(),'Marta','initial',true,false,null]);
 assert.deepEqual([m.access.full,m.access.state,m.billing.exempt],[false,'none',false],'paid account without a plan');
 const state=fixture('accounts-state',{userId:r.data.user.id});
 assert.equal(state.billing.billing_exempt,0);assert.equal(state.profile.username_changed_at,null,'the first username does not count');assert.ok(state.profile.last_login_at>0);
 assert.equal((await c.req('signup',signupBody())).status,403,'signed in: anonymous only');
 assert.equal((await c.req('signup-begin',{})).status,403);
});
test('sign-up: duplicates give 409 with neutral messages',{skip},async()=>{
 const taken=member('dup');const c=await begun();
 const email=await c.req('signup',signupBody({email:taken.email.toUpperCase()}));
 assert.deepEqual([email.status,email.data.error],[409,'Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.']);
 const u=uniq('dupname');member('dupname',{profile:{username:u}});
 const name=await c.req('signup',signupBody({username:u.toUpperCase()}));assert.deepEqual([name.status,name.data.error],[409,'Ta nazwa użytkownika jest zajęta.']);
 const staff=await c.req('signup',signupBody({email:ADMIN[0]}));assert.equal(staff.status,409,'a staff e-mail is taken too');
});
test('sign-up: 30 attempts per hour per address, then 429 with Retry-After',{skip},async()=>{
 const c=await begun();let r;
 for(let i=0;i<30;i++){r=await c.req('signup',signupBody({website:'x'}));assert.equal(r.status,400,'attempt '+i);}
 r=await c.req('signup',signupBody());assert.equal(r.status,429);assert.equal(r.data.error,'Zbyt wiele prób zakładania konta. Spróbuj ponownie później.');
 assert.ok(r.data.retry>0&&Number(r.headers.get('retry-after'))>0);
});
test('sign-up: the global brake counts accounts created, not attempts; junk cannot block others; 0 switches it off',{skip},async()=>{
 const old=fixture('accounts-config',{set:{signup_limit_global_hour:3,signup_limit_ip_hour:1000,signup_limit_ip_day:1000}});
 try{
  const tooMany='Zbyt wiele prób zakładania konta. Spróbuj ponownie później.';
  // Junk without signup-begin, a too-quick form and the bot trap: twice the global limit of failed requests.
  for(let i=0;i<3;i++){
   assert.equal((await (await fresh()).req('signup',{junk:1})).status,400,'junk '+i);
   assert.equal((await (await begun()).req('signup',signupBody({website:'http://spam.example'}))).status,400,'trap '+i);
  }
  // A real person still gets through, and so do the next ones up to the limit of 3 created accounts in the hour.
  for(let i=0;i<3;i++){const r=await (await begun()).req('signup',signupBody());assert.equal(r.status,200,`account ${i}: ${JSON.stringify(r.data)}`);}
  const blocked=await (await begun()).req('signup',signupBody());
  assert.deepEqual([blocked.status,blocked.data.error],[429,tooMany]);assert.ok(blocked.data.retry>0&&Number(blocked.headers.get('retry-after'))>0);
  // A refused attempt does not count either: lifting the limit to 4 lets exactly one more account in.
  fixture('accounts-config',{set:{signup_limit_global_hour:4}});
  assert.equal((await (await begun()).req('signup',signupBody())).status,200);
  assert.equal((await (await begun()).req('signup',signupBody())).status,429);
  // 0 switches the brake off (the owner's lever during an attack on the counter); the address limits stay.
  fixture('accounts-config',{set:{signup_limit_global_hour:0}});
  assert.equal((await (await begun()).req('signup',signupBody())).status,200,'no global brake with 0');
 }finally{fixture('accounts-config',{set:old});}
});
test('sign-up switched off, then the invite-only window (§3.6, §6.10)',{skip},async()=>{
 const token='invite-'+'x'.repeat(30),signup=()=>publicConfig('signup');assert.equal(await signup(),true);
 const old=await setConfig({signup_enabled:false},signup,false);
 try{
  let c=await fresh();
  for(const route of ['signup-begin','signup']){const r=await c.req(route,route==='signup'?signupBody():{});assert.deepEqual([r.status,r.data.error],[404,'Rejestracja jest chwilowo wyłączona.'],route);}
  // public-config never advertises the invite mode: the token itself is the observation.
  await setConfig({signup_invite_token:token},async()=>(await (await fresh()).req('signup-begin',{invite:token})).status,200);
  fixture('reset-limits');c=await fresh();
  assert.equal((await c.req('signup-begin',{})).status,404,'without the token');
  assert.equal((await c.req('signup-begin',{invite:token.slice(0,-1)+'y'})).status,404,'wrong token');
  assert.equal((await get('public-config')).data.signup,false,'invite mode is never advertised');
  c=await begun(10,{invite:token});
  assert.equal((await c.req('signup',signupBody())).status,404,'signup needs the token too');
  const r=await c.req('signup',signupBody({invite:token}));assert.equal(r.status,200,JSON.stringify(r.data));
 }finally{await setConfig({signup_enabled:old.signup_enabled,signup_invite_token:null},signup,true);}
});

test('username-check: POST only, after signup-begin or signed in; states and free suggestions',{skip},async()=>{
 let c=await fresh();
 const no=await c.req('username-check',{u:'anything'});assert.deepEqual([no.status,no.data.error],[403,'Najpierw rozpocznij rejestrację.']);
 assert.equal((await get('username-check&u=marta')).status,405,'never in a URL');
 c=await begun(0);
 member('suggest',{profile:{username:'zofia.nowakowska'}});member('suggest',{profile:{username:'zofia.n2'}});
 const check=async(u,extra={})=>(await c.req('username-check',{u,firstName:'Zofia',lastName:'Nowakowska',...extra})).data;
 assert.deepEqual(await check('ab'),{status:'invalid',suggestions:[]});
 assert.deepEqual(await check('Administrator'),{status:'reserved',suggestions:[]});
 assert.deepEqual(await check(uniq('free')),{status:'available',suggestions:[]});
 const taken=await check('Zofia.Nowakowska',{nameDisplay:'full'});
 assert.equal(taken.status,'taken');assert.deepEqual(taken.suggestions,['zofia_nowakowska','zofia.nowakowska2','zofianowakowska'],'free candidates only (zofia.n2 is taken), at most 3');
 // Without the full name shown (nameDisplay 'initial' or not given): never the full surname, only the initial (plus the typed name + 2).
 for(const extra of [{},{nameDisplay:'initial'},{nameDisplay:'bogus'}])
  assert.deepEqual((await check('Zofia.Nowakowska',extra)).suggestions,['zofia.n','zofia_n','zofia.nowakowska2'],JSON.stringify(extra));
 // A long name: the full-surname forms are cut to 24 characters (katarzyna.szczepanskawis), and those are left out too.
 member('suggest',{profile:{username:'katarzyna.s'}});
 const long=async extra=>(await c.req('username-check',{u:'katarzyna.s',firstName:'Katarzyna',lastName:'Szczepańska-Wiśniewska',...extra})).data;
 assert.deepEqual((await long({nameDisplay:'full'})).suggestions,['katarzyna.szczepanskawis','katarzyna_szczepanskawis','katarzyna.s2']);
 const hidden=await long({});assert.equal(hidden.status,'taken');assert.deepEqual(hidden.suggestions,['katarzyna_s','katarzyna.s2','katarzynas']);
 for(const x of hidden.suggestions)assert.ok(!x.slice('katarzyna'.length).includes('sz'),x);
 const owner=member('own',{exempt:true});const s=await signIn(owner.email);const ownName=(await me(s)).profile.username;
 assert.equal((await s.req('username-check',{u:ownName})).data.status,'available','the own name');
});
test('username-check: 30 per 10 minutes per session',{skip},async()=>{
 const c=await begun(0);let r;
 for(let i=0;i<30;i++){r=await c.req('username-check',{u:'name'+i});assert.equal(r.status,200);}
 r=await c.req('username-check',{u:'one.more'});assert.equal(r.status,429);assert.ok(r.data.retry>0);
});

test('profile: validation, defaults, duplicates and the 30-day username rule',{skip},async()=>{
 const m=member('prof',{profile:{username:null}});const c=await signIn(m.email);
 const base={firstName:'Ola',lastName:'Wiśniewska',username:uniq('ola'),country:'DE',sports:['judo','karate'],clubText:' KS ‮Orzeł ',showClub:true};
 assert.equal((await c.req('profile',{...base,sports:[]})).status,422);
 assert.equal((await c.req('profile',{...base,firstName:'<b>'})).status,422);
 let r=await c.req('profile',base);assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual([r.data.profile.clubText,r.data.profile.nameDisplay,r.data.profile.sports,r.data.profile.usernameChangeAt],['KS Orzeł','initial',['judo','karate'],null],'first username: no 30-day wait');
 const other=uniq('other');member('other',{profile:{username:other}});
 r=await c.req('profile',{...base,username:other});assert.deepEqual([r.status,r.data.error],[409,'Ta nazwa użytkownika jest zajęta.']);
 const second=uniq('ola2');r=await c.req('profile',{...base,username:second,nameDisplay:'full'});assert.equal(r.status,200);
 assert.equal(r.data.profile.nameDisplay,'full');assert.ok(r.data.profile.usernameChangeAt>now()+29*86400);
 r=await c.req('profile',{...base,username:uniq('ola3')});assert.equal(r.status,429);assert.equal(r.data.error,'Nazwę użytkownika można zmienić raz na 30 dni.');assert.ok(r.data.retry>29*86400);
 assert.equal((await c.req('profile',{...base,username:second,country:'PL'})).status,200,'other fields change without a username change');
 const admin=await signIn(...ADMIN);r=await admin.req('profile',{...base,username:uniq('staff')});assert.equal(r.status,200,'staff have a profile too');
});

test('photos: formats by content, dimensions, size, metadata removed, files 0600 in the owner directory',{skip},async()=>{
 const m=member('photo',{exempt:true});const c=await signIn(m.email);
 const ok=await upload(c,image('exif-gps.jpg'),'image/jpeg');assert.equal(ok.status,200,JSON.stringify(ok.data));assert.match(ok.data.avatar,/^[0-9a-f]{12}$/);
 for(const [name,type] of [['photo.webp','image/webp'],['photo.png','image/png']]){const r=await upload(c,image(name),type);assert.equal(r.status,200,name);}
 for(const [name,type,status,error] of [['vector.svg','image/png',415,'To nie jest obraz JPG, PNG ani WebP.'],['anim.gif','image/png',415],['polyglot.jpg','image/jpeg',415],['photo.png','image/svg+xml',415],['photo.png','image/gif',415],
  ['tiny.png','image/png',422,'Zdjęcie ma niepoprawne wymiary.'],['wide.png','image/png',422]]){
  const r=await upload(c,image(name),type);assert.equal(r.status,status,name+' '+type);if(error)assert.equal(r.data.error,error);
 }
 const big=await upload(c,Buffer.concat([image('photo.png'),Buffer.alloc(600*1024)]),'image/png');assert.deepEqual([big.status,big.data.error],[413,'Plik jest za duży.']);
 const p=(await me(c)).profile;const files=fixture('accounts-avatar-files',{publicId:p.publicId});
 assert.equal(files.dir,'0700');assert.equal(files.parent,'0700');assert.ok(files.path.includes('/avatars/'+p.publicId.slice(0,2)+'/'+p.publicId));
 const names=Object.keys(files.files).sort();assert.equal(names.length,2,'only the current photo stays: '+names);
 assert.match(names[0],new RegExp('^'+p.avatar+'[0-9a-f]{20}-256\\.webp$'));assert.match(names[1],new RegExp('^'+p.avatar+'[0-9a-f]{20}-64\\.webp$'));
 assert.ok(Object.values(files.files).every(mode=>mode==='0600'));
 // The EXIF upload, served to its owner: no metadata in the bytes (limits reset: 10 uploads per hour).
 fixture('reset-limits');
 const again=await upload(c,image('exif-gps.jpg'),'image/jpeg');const r=await get(`avatar&id=${p.publicId}&v=${again.data.avatar}&s=256`,{cookie:c.cookie});
 assert.equal(r.status,200);assert.ok(!/Exif|MatBravoSecretExifMarker|GPS/.test(r.buf.toString('latin1')));
 const t=(await upload(c,image('trailing.jpg'),'image/jpeg')).data.avatar;
 assert.ok(!(await get(`avatar&id=${p.publicId}&v=${t}&s=64`,{cookie:c.cookie})).buf.toString('latin1').includes('MatBravoTrailingPayload'),'appended data removed');
});
test('photos: served only with full access or to the owner, access checked before 304',{skip},async()=>{
 const owner=member('own',{exempt:true}),viewer=member('view',{exempt:true}),unpaid=member('unpaid');
 const o=await signIn(owner.email),v=await signIn(viewer.email),u=await signIn(unpaid.email);
 const up=await upload(u,image('photo.jpg'),'image/jpeg');assert.equal(up.status,200,'an unpaid member may set a photo');
 const av=(await upload(o,image('photo.webp'))).data.avatar;const pid=(await me(o)).profile.publicId;const url=`avatar&id=${pid}&v=${av}&s=256`;
 const r=await get(url,{cookie:o.cookie});assert.equal(r.status,200);
 assert.equal(r.headers.get('content-type'),'image/webp');assert.equal(r.headers.get('etag'),`"${av}-256"`);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
 assert.equal(r.headers.get('content-security-policy'),"default-src 'none'; sandbox");assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');
 assert.equal(r.headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal(r.headers.get('set-cookie'),null);
 assert.equal((await get(url,{cookie:v.cookie})).status,200,'a viewer with full access');
 const etag={'If-None-Match':`"${av}-256"`};
 const cached=await get(url,{cookie:v.cookie,headers:etag});assert.equal(cached.status,304);assert.equal(cached.buf.length,0);
 for(const [who,cookie] of [['guest',undefined],['unpaid member',u.cookie],['forged cookie','matdraw_session='+'a'.repeat(32)]]){
  const g=await get(url,{cookie,headers:etag});assert.equal(g.status,404,who+' with a valid ETag');assert.equal(g.data.error,'Nie znaleziono zdjęcia.');
 }
 const own=(await me(u)).profile;assert.equal((await get(`avatar&id=${own.publicId}&v=${own.avatar}&s=64`,{cookie:u.cookie})).status,200,'the unpaid owner sees the own photo');
 for(const bad of [`avatar&id=${pid}&v=${av}&s=128`,`avatar&id=${pid}&v=000000000000&s=64`,`avatar&id=${pid.slice(1)}&v=${av}&s=64`,`avatar&id=${pid}&v=${av.toUpperCase()}&s=64`])assert.equal((await get(bad,{cookie:v.cookie})).status,404,bad);
 const newer=(await upload(o,image('photo.png'),'image/png')).data.avatar;assert.notEqual(newer,av);
 assert.equal((await get(url,{cookie:v.cookie})).status,404,'an old URL');
 assert.equal((await fetch(base+'?route=avatar&id='+pid,{method:'POST',headers:{'X-MatBravo-Client':'1'}})).status,405);
});
test('photos: the same picture of two people lives in two directories; deleting one keeps the other',{skip},async()=>{
 const a=member('twin',{exempt:true}),b=member('twin',{exempt:true});const ca=await signIn(a.email),cb=await signIn(b.email);
 const va=(await upload(ca,image('photo.jpg'),'image/jpeg')).data.avatar,vb=(await upload(cb,image('photo.jpg'),'image/jpeg')).data.avatar;assert.equal(va,vb,'same bytes, same name');
 const pb=(await me(cb)).profile.publicId,pa=(await me(ca)).profile.publicId;
 const del=await ca.req('avatar-delete',{});assert.deepEqual([del.status,del.data.avatar],[200,null]);
 assert.equal((await me(ca)).profile.avatar,null);assert.deepEqual(fixture('accounts-avatar-files',{publicId:pa}).files,{});
 assert.equal((await get(`avatar&id=${pb}&v=${vb}&s=64`,{cookie:ca.cookie})).status,200,'the other person still has the photo');
});
test('photos: switched off → 503 before anything else',{skip},async()=>{
 const m=member('off',{exempt:true});const c=await signIn(m.email);const avatars=()=>publicConfig('avatars'),before=await avatars();
 const old=await setConfig({avatars_enabled:false},avatars,false);
 try{
  for(const [bytes,type] of [[image('photo.webp'),'image/webp'],[image('vector.svg'),'image/svg+xml'],[Buffer.alloc(600*1024),'image/png']]){const r=await upload(c,bytes,type);assert.deepEqual([r.status,r.data.error],[503,'Zdjęcia profilowe są chwilowo wyłączone.'],type);}
  assert.equal(await avatars(),false);
 }finally{await setConfig({avatars_enabled:old.avatars_enabled},avatars,before);}
});

test('admin-members: admin only, POST, literal LIKE with _ and %, Polish letters, billing filters',{skip},async()=>{
 const tag=uniq('zq');const lit=member(tag+'_x',{exempt:true}),plain=member(tag+'ax'),pct=member(tag+'%y');
 const c=await signIn(...ADMIN);const list=async body=>{const r=await c.req('admin-members',body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const ids=d=>d.items.map(i=>i.id).sort();
 assert.deepEqual(ids(await list({q:tag+'_'})),[lit.id],'_ is literal');assert.deepEqual(ids(await list({q:tag+'%'})),[pct.id],'% is literal');
 assert.deepEqual(ids(await list({q:tag.toUpperCase()})),[lit.id,plain.id,pct.id].sort(),'case-insensitive prefix');
 const d=await list({q:tag+'_'});const item=d.items[0];
 assert.deepEqual(Object.keys(item),['id','email','username','name','country','createdAt','lastLoginAt','active','billing','muted','mutedUntil']);
 assert.deepEqual([d.total,d.page,item.email,item.name,item.billing.state,item.billing.exempt,item.muted,item.mutedUntil],[1,1,lit.email,'Test Członek','free',true,false,null]);
 assert.deepEqual(ids(await list({q:tag,filter:'free'})),[lit.id]);assert.deepEqual(ids(await list({q:tag,filter:'none'})),[plain.id,pct.id].sort());
 assert.deepEqual(ids(await list({q:tag,filter:'paid'})),[]);
 const surname=uniq('Zzlast');const named=member('named',{profile:{lastName:surname}});assert.deepEqual(ids(await list({q:surname.toLowerCase()})),[named.id],'by last name');
 // A phrase outside ASCII (username is ascii_bin) still searches e-mails and last names, without a collation error.
 const pl='Świątek'+uniq('q');const polish=member('polish',{profile:{lastName:pl}});
 assert.deepEqual(ids(await list({q:pl.slice(0,-1)})),[polish.id],'Polish last name');assert.deepEqual(ids(await list({q:pl.toLowerCase()})),[polish.id],'any case');
 assert.ok((await list({q:'Żak'})).items.every(i=>i.id!==polish.id));
 assert.equal((await c.req('admin-members',{q:'x'.repeat(101)})).status,422);assert.equal((await c.req('admin-members',{filter:'bogus'})).status,422);
 assert.equal((await get('admin-members&q=x',{cookie:c.cookie})).status,405,'search terms never in a URL');
 const muted=await list({q:tag,filter:'muted'});assert.ok(Array.isArray(muted.items));
 const m=await signIn(lit.email);assert.equal((await m.req('admin-members',{})).status,403);
});
test('admin-member: create with a temporary password → forced change; active; password; e-mail; profile fix; members only',{skip},async()=>{
 const admin=await signIn(...ADMIN);const act=body=>admin.req('admin-member',body);
 const email=uniq('created')+'@example.test',username=uniq('created');
 let r=await act({action:'create',email,firstName:'Jan',lastName:'Kos',username,country:'PL',sports:['karate'],free:true,reason:'Klub partnerski',until:'2035-01-31'});
 assert.equal(r.status,200,JSON.stringify(r.data));const id=r.data.id,temp=r.data.temporaryPassword;assert.match(temp,/^[A-Za-z0-9]{16}$/);
 let st=fixture('accounts-state',{userId:id});
 assert.deepEqual([st.user.role,st.billing.billing_exempt,st.billing.exempt_reason,st.audit.map(a=>a.action)],['member',1,'Klub partnerski',['create']]);assert.ok(st.profile.pw_reset_at>0&&st.billing.exempt_until>now());
 assert.equal((await act({action:'create',email:email.toUpperCase(),firstName:'Jan',lastName:'Kos',username:uniq('x'),country:'PL',sports:['karate']})).status,409);
 let m=await signIn(email,temp);let state=await me(m);
 assert.deepEqual([state.profile.mustChangePassword,state.access.block,state.access.canPost],[true,'password',false]);
 r=await m.req('member-password',{currentPassword:temp,password:NEW_PASSWORD});assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data),['csrf']);
 state=await me(m);assert.equal(state.profile.mustChangePassword,false,'the change clears the temporary password');
 // active: blocked accounts lose every session and cannot sign in.
 assert.equal((await act({action:'active',userId:id,active:false})).status,200);assert.equal((await get('me',{cookie:m.cookie})).status,401);
 assert.equal((await (await fresh()).req('login',{email,password:NEW_PASSWORD})).status,401);
 assert.equal((await act({action:'active',userId:id,active:true})).status,200);m=await signIn(email,NEW_PASSWORD);
 // password: a new temporary password, other sessions end.
 r=await act({action:'password',userId:id});assert.equal(r.status,200);assert.equal((await get('me',{cookie:m.cookie})).status,401);
 m=await signIn(email,r.data.temporaryPassword);assert.equal((await me(m)).profile.mustChangePassword,true);
 // email: sessions end, the new address signs in, duplicates are refused.
 const next=uniq('moved')+'@example.test';assert.equal((await act({action:'email',userId:id,email:next.toUpperCase()})).status,200);
 assert.equal((await get('me',{cookie:m.cookie})).status,401);await signIn(next,r.data.temporaryPassword);
 assert.deepEqual([(await act({action:'email',userId:id,email:ADMIN[0]})).status,(await act({action:'email',userId:id,email:'bad'})).status],[409,422]);
 // profile fix: an offensive username removed, the member chooses again.
 r=await act({action:'profile',userId:id,username:null,clubText:'Nowy klub'});assert.equal(r.status,200);assert.deepEqual([r.data.profile.username,r.data.profile.clubText,r.data.profile.complete],[null,'Nowy klub',false]);
 assert.equal((await act({action:'profile',userId:id,username:'admin.x'})).status,422);
 st=fixture('accounts-state',{userId:id});assert.deepEqual(st.audit.map(a=>a.action),['create','active','active','password.reset','email.change','profile.fix']);
 assert.ok(st.audit.every(a=>!JSON.stringify(a).includes('@')),'no e-mails in the audit');
 // Staff accounts and unknown ids are not members.
 const staffId=(await admin.load()).users.find(u=>u.email===ADMIN[0]).id;
 for(const action of ['active','password','email','profile','delete'])assert.deepEqual([(await act({action,userId:staffId,active:true,email:'x@example.test',firstName:'X'})).status],[404],action);
 assert.equal((await act({action:'password',userId:'nope'})).status,404);assert.equal((await act({action:'bogus',userId:id})).status,400);
 const plain=member('nonadmin',{exempt:true});assert.equal((await (await signIn(plain.email)).req('admin-member',{action:'password',userId:id})).status,403);
});
test('admin-member delete and account-delete anonymise the account and keep a billing tombstone',{skip},async()=>{
 const admin=await signIn(...ADMIN);const a=member('gone',{exempt:true});const ca=await signIn(a.email);await upload(ca,image('photo.webp'));const pa=(await me(ca)).profile.publicId;
 let r=await admin.req('admin-member',{action:'delete',userId:a.id});assert.equal(r.status,200,JSON.stringify(r.data));
 let st=fixture('accounts-state',{userId:a.id});
 assert.deepEqual([st.user.email,st.user.active,st.user.role,st.profile],[`deleted+${a.id}@invalid.matbravo`,0,'member',null]);
 assert.ok(st.billing.deleted_at>0&&st.billing.billing_exempt===0&&st.billing.exempt_reason===null);assert.deepEqual(st.audit.map(x=>x.action),['delete']);
 assert.equal(fixture('accounts-avatar-files',{publicId:pa}).dir,null,'avatar directory removed');
 assert.equal((await get('me',{cookie:ca.cookie})).status,401);
 assert.ok(!(await admin.req('admin-members',{q:a.email})).data.items.length,'deleted accounts leave the panel');
 // A deleted account is gone for the panel's actions too: only a repeated delete answers (as done), nothing is revived.
 for(const action of ['active','password','email','profile'])assert.equal((await admin.req('admin-member',{action,userId:a.id,active:true,email:uniq('back')+'@example.test',firstName:'X'})).status,404,action);
 r=await admin.req('admin-member',{action:'delete',userId:a.id});assert.deepEqual([r.status,r.data],[200,{id:a.id,deleted:true}]);
 const again=fixture('accounts-state',{userId:a.id});assert.deepEqual([again.user,again.profile,again.billing.deleted_at,again.audit.map(x=>x.action)],[st.user,null,st.billing.deleted_at,['delete']]);
 // Self-service deletion.
 const b=member('self');const cb=await signIn(b.email);
 assert.deepEqual([(await cb.req('account-delete',{password:'wrong-password-123'})).status],[422]);
 r=await cb.req('account-delete',{password:PASSWORD});assert.equal(r.status,200);assert.equal(r.data.ok,true);assert.match(r.data.csrf,/^[0-9a-f]{64}$/);
 assert.equal((await get('me',{cookie:cb.cookie})).status,401);assert.equal((await (await fresh()).req('login',{email:b.email,password:PASSWORD})).status,401);
 st=fixture('accounts-state',{userId:b.id});assert.deepEqual([st.user.active,st.profile,st.audit.map(x=>x.action)],[0,null,['self.delete']]);
 const staff=await signIn(...ADMIN);assert.equal((await staff.req('account-delete',{password:ADMIN[1]})).status,403,'members only');
});
test('account-delete: a running subscription needs confirmEnd; a Stripe customer stays on the tombstone',{skip},async()=>{
 const m=member('sub');fixture('billing',{userId:m.id,sub_status:'active',livemode:0,currency:'pln',current_period_start:now()-86400,current_period_end:now()+20*86400,cancel_at_period_end:0});
 const c=await signIn(m.email);
 let r=await c.req('account-delete',{password:PASSWORD});
 assert.deepEqual([r.status,r.data.confirmEnd,r.data.error],[409,true,'Masz aktywną subskrypcję. Usunięcie konta zakończy ją od razu, bez zwrotu za bieżący okres.']);
 assert.equal(fixture('accounts-state',{userId:m.id}).user.active,1,'nothing deleted yet');
 r=await c.req('account-delete',{password:PASSWORD,endSubscription:true});assert.equal(r.status,200,JSON.stringify(r.data));
 const ending=member('ending');fixture('billing',{userId:ending.id,sub_status:'active',livemode:0,current_period_end:now()+86400,cancel_at_period_end:1});
 assert.equal((await (await signIn(ending.email)).req('account-delete',{password:PASSWORD})).status,200,'ending subscriptions do not block');
 const cust=member('cust');
 // With billing-backend the account deletion syncs with Stripe first: the customer has to exist in the Stripe stub.
 const stripe=await fetch(`http://127.0.0.1:${Number(new URL(base).port)+1}/v1/customers`,{method:'POST',headers:{Authorization:'Bearer rk_test_stub','Stripe-Version':'2026-09-30.endive','Idempotency-Key':uniq('fixture-'),'Content-Type':'application/x-www-form-urlencoded'},body:'metadata[matbravo_user_id]='+cust.id}).then(r=>r.json()).catch(()=>null);
 const customer=stripe?.id??'cus_fixture'+uniq('');fixture('billing',{userId:cust.id,stripe_customer_id:customer,sub_status:'canceled',livemode:0});
 r=await (await signIn(cust.email)).req('account-delete',{password:PASSWORD,endSubscription:true});assert.equal(r.status,200,JSON.stringify(r.data));
 const st=fixture('accounts-state',{userId:cust.id});
 assert.equal(st.billing.stripe_customer_id,customer);assert.ok(st.billing.deleted_at>0);assert.ok([0,1].includes(st.billing.stripe_redact_pending));
});
test('member-email and member-password: password check, neutral 409, sessions renewed',{skip},async()=>{
 const m=member('mail',{exempt:true});const c=await signIn(m.email),other=await signIn(m.email);
 assert.equal((await c.req('member-email',{currentPassword:'wrong-password-123',email:uniq('x')+'@example.test'})).status,422);
 let r=await c.req('member-email',{currentPassword:PASSWORD,email:ADMIN[0]});assert.deepEqual([r.status,r.data.error],[409,'Nie można użyć tego adresu e-mail.']);
 assert.equal((await c.req('member-email',{currentPassword:PASSWORD,email:'not-an-email'})).status,422);
 const next=uniq('Next')+'@Example.test';r=await c.req('member-email',{currentPassword:PASSWORD,email:next});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.user.email,next.toLowerCase());assert.ok(r.data.csrf);
 assert.equal((await me(c)).user.email,next.toLowerCase(),'this session continues');assert.equal((await get('me',{cookie:other.cookie})).status,401,'other sessions end');
 assert.deepEqual(fixture('accounts-state',{userId:m.id}).audit.map(a=>[a.actor_id,a.action]),[['self','self.email']]);
 assert.equal((await c.req('member-password',{currentPassword:'wrong-password-123',password:NEW_PASSWORD})).status,422);
 assert.equal((await c.req('member-password',{currentPassword:PASSWORD,password:'short'})).status,422);
 assert.equal((await c.req('member-password',{currentPassword:PASSWORD,password:NEW_PASSWORD})).status,200);await signIn(next,NEW_PASSWORD);
 const staff=await signIn(...ADMIN);assert.equal((await staff.req('member-email',{currentPassword:ADMIN[1],email:'x@example.test'})).status,403);
});

test('accounts-cleanup: abandoned sign-ups only with enforced payments; reporters, writers, exempt and recent accounts stay',{skip},async()=>{
 const old=now()-40*86400;const p=(extra={})=>({profile:{createdAt:old,...extra}});
 const make=(prefix,opts={},billing={sub_status:'none'})=>{const m=member(prefix,opts);if(billing)fixture('billing',{userId:m.id,...billing});return m;};
 const abandoned=make('aband',p()),reporter=make('reporter',p()),writer=make('writer',p()),free=member('free',{...p(),exempt:true}),recent=make('recent'),
  active=make('loggedin',p({lastLoginAt:now()-86400})),customer=make('customer',p(),{sub_status:'none',stripe_customer_id:'cus_'+uniq('c')}),noRow=make('norow',p(),null);
 fixture('accounts-chat',{userId:reporter.id,kind:'report'});fixture('accounts-chat',{userId:writer.id,kind:'message'});
 const pid=abandoned.publicId;fixture('accounts-avatar-orphan',{publicId:pid});// a photo directory of the abandoned account
 const exists=id=>fixture('accounts-state',{userId:id}).user!==null;
 assert.match(fixture('accounts-cleanup',{config:{billing_enforce:false}}),/abandoned=off deleted=0/);assert.ok(exists(abandoned.id),'not without billing_enforce');
 const out=fixture('accounts-cleanup',{});assert.match(out,/abandoned=on deleted=\d+ failed=0/);
 assert.ok(!exists(abandoned.id)&&!exists(noRow.id),'abandoned accounts deleted');assert.equal(fixture('accounts-avatar-files',{publicId:pid}).dir,null);
 for(const [name,m] of Object.entries({reporter,writer,free,recent,active,customer}))assert.ok(exists(m.id),name+' kept');
});
test('accounts-cleanup: old files beside the current photo and directories without a profile',{skip},async()=>{
 const m=member('sweep',{exempt:true});const c=await signIn(m.email);await upload(c,image('photo.webp'));const p=(await me(c)).profile;
 fixture('accounts-avatar-age',{publicId:p.publicId,days:3});// the current photo is kept whatever its age
 fixture('accounts-avatar-orphan',{publicId:p.publicId});// an old file that is not the current photo, in the live directory
 const orphan='Zz'+uniq('').replace(/[^A-Za-z0-9]/g,'').padEnd(10,'q').slice(0,10);fixture('accounts-avatar-orphan',{publicId:orphan});
 fixture('accounts-cleanup',{config:{billing_enforce:false}});
 const files=Object.keys(fixture('accounts-avatar-files',{publicId:p.publicId}).files);
 assert.equal(files.length,2,'current photo kept, the old foreign file removed: '+files.join(','));assert.ok(files.every(f=>f.startsWith(p.avatar)));
 assert.equal(fixture('accounts-avatar-files',{publicId:orphan}).dir,null,'directory without a profile removed');
});
test('accounts-cleanup: the avatar sweep resumes where the previous run stopped',{skip},async()=>{
 const tail=uniq('').replace(/[^A-Za-z0-9]/g,'').padEnd(9,'q').slice(-9),pid=k=>'Zy'+tail+k;
 for(const k of 'abc')fixture('accounts-avatar-orphan',{publicId:pid(k)});
 const gone=k=>fixture('accounts-avatar-files',{publicId:pid(k)}).dir===null;
 // A run with a budget of one directory stops after it and names it as the cursor.
 assert.deepEqual(fixture('accounts-sweep',{after:pid('0'),budget:1}),{files:0,dirs:1,next:pid('a')});assert.deepEqual(['a','b','c'].map(gone),[true,false,false]);
 // The job reads the cursor of its previous result: directories up to it wait for the next pass.
 const out=fixture('accounts-cleanup',{config:{billing_enforce:false},prev:'abandoned=off deleted=0 failed=0 avatar_files=0 avatar_dirs=1 avatar_next='+pid('b')});
 assert.match(out,/ avatar_next=(-|[A-Za-z0-9]{12})$/);assert.deepEqual(['b','c'].map(gone),[false,true],'resumed after b');
 assert.match(fixture('accounts-cleanup',{config:{billing_enforce:false},prev:'avatar_next=-'}),/avatar_dirs=[1-9]/);assert.ok(gone('b'),'the next pass starts from the beginning');
});
test('diagnostics: admin only, no secrets; probe=stripe limited to 6 per hour',{skip},async()=>{
 const c=await signIn(...ADMIN);const r=await get('diagnostics',{cookie:c.cookie});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual(Object.keys(r.data),['php','gd','exif','curl','openssl','intl','server','uploadsWritable','avatarMode','schema','sessions','backups','billing','chat','stripe']);
 // php -S cannot send a response early: the payment sync and jobs after the response would never run there (cron needed).
 assert.deepEqual(r.data.server,{sapi:'cli-server',afterResponse:false});
 assert.equal(r.data.uploadsWritable,true);assert.equal(r.data.schema.db,r.data.schema.code);assert.deepEqual([r.data.sessions.ownDir,typeof r.data.sessions.files],[true,'number']);
 assert.deepEqual(r.data.billing,{enabled:true,mode:'test'});assert.equal(r.data.stripe,null);assert.equal(r.headers.get('cache-control'),'private, no-store');
 assert.ok(!/rk_test|whsec_|password|app_key/.test(JSON.stringify(r.data)),'no secrets');
 for(let i=0;i<6;i++){const p=await get('diagnostics&probe=stripe',{cookie:c.cookie});assert.equal(p.status,200);assert.deepEqual(Object.keys(p.data.stripe).sort(),['error','ms','reachable','status','tls']);}
 assert.equal((await get('diagnostics&probe=stripe',{cookie:c.cookie})).status,429);
 const m=member('diag',{exempt:true});assert.equal((await get('diagnostics',{cookie:(await signIn(m.email)).cookie})).status,403);
 assert.equal((await get('diagnostics')).status,401);
});
after(()=>fixture('reset-limits'));
