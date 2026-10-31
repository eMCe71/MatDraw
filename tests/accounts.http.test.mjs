// API core over real PHP and MariaDB/MySQL (plan §11, backend-api): lightweight session/login with unchanged shapes,
// member isolation, me for every role, public-config, the payment gate for staff, read-only peek sessions (no file, no
// cookie, activity refresh after idle/4 for members, for staff only on a chat-feed poll of someone reading the chat),
// maintenance and schema-behind 503, client_outdated, the session lock during
// background jobs, login timing and limits, and session housekeeping through bin/cron.php. Run through scripts/test-http.sh.
// Routes::dispatch paths that no route of this slice uses yet (session POST, upload, webhook, chat-off, null → 204, user
// rules, work after a session POST) run against test-only routes (TEST_ROUTES) written into the disposable release.
import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,unlinkSync,utimesSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client,base,eventually,fixture,php} from './helpers/http-client.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend=path.join(process.env.MATDRAW_TEST_RELEASE||repo,'backend');
const shared=process.env.MATDRAW_TEST_SHARED_DIR,sessions=shared?path.join(shared,'sessions'):'';
const skip=!base||!shared;
// The test-only routes go into the disposable build of scripts/test-http.sh only, never into the repository.
const release=process.env.MATDRAW_TEST_RELEASE,routesFile=release?path.join(release,'backend','routes','zz-test-routes.php'):null,skipRoutes=skip||!release;
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!';
const sessionFiles=()=>readdirSync(sessions).filter(f=>f.startsWith('sess_')).sort();
const now=()=>Math.floor(Date.now()/1000);
/** A POST with an exact body and Content-Type (none when type is null); never stores cookies. */
async function send(route,{cookie,csrf,type='application/json',data='',json,headers={}}={}){
 const body=Buffer.from(json!==undefined?JSON.stringify(json):data);
 const r=await fetch(base+'?route='+route,{method:'POST',headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(type?{'Content-Type':type}:{}),...headers},body});
 const text=await r.text();let parsed=null;try{parsed=text?JSON.parse(text):null;}catch{parsed={raw:text};}
 return {status:r.status,headers:r.headers,data:parsed,text};
}
/** One request with full control over cookies and headers; never stores cookies. */
async function raw(route,{method='GET',cookie,headers={},body}={}){
 const r=await fetch(base+'?route='+route,{method,headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const text=r.status===204?'':await r.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
 return {status:r.status,headers:r.headers,data};
}
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
const signIn=async(email,password=PASSWORD)=>{const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return Object.assign(c,{login:r});};
const sid=c=>c.cookie.split('=')[1];
const KEYS={user:['id','clubId','email','role','active'],profile:['publicId','username','firstName','lastName','country','sports','clubText','showClub','nameDisplay','avatar','complete','usernameChangeAt','mustChangePassword'],
 access:['full','state','until','canPost','block','mutedUntil'],billing:['enabled','enforce','mode','currency','amounts','exempt','hasCustomer','pending'],features:['signup','avatars','chat']};
async function me(c){
 const r=await raw('me',{cookie:c.cookie});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('cache-control'),'private, no-store');
 assert.deepEqual(Object.keys(r.data),['user','profile','access','billing','features']);
 for(const [k,keys] of Object.entries(KEYS))assert.deepEqual(Object.keys(r.data[k]),keys,k);
 // The composer block follows the documented order; with the chat not installed or off, only 'off' remains.
 const {access:a,features:f}=r.data;assert.equal(a.canPost,a.block===null);
 if(!f.chat)assert.notEqual(a.block,null);
 return r.data;
}
const blockOr=(data,block)=>block??(data.features.chat?null:'off');
async function until(probe,expected,ms=6000){let v;for(const end=Date.now()+ms;Date.now()<end;await sleep(200))if((v=await probe())===expected)break;return v;}
const TEST_ROUTES=String.raw`<?php
// Test-only routes of tests/accounts.http.test.mjs, written into the disposable release and removed after the tests.
declare(strict_types=1);
use MatDraw\{ApiError,Jobs,RouteContext};
$echo=static fn(RouteContext $ctx):array=>['route'=>$ctx->name,'role'=>$ctx->user()['role']??null,'body'=>$ctx->body,'len'=>strlen($ctx->raw())];
return [
 // Work after the response of a session POST, as in chat-send (§3.7): Jobs::maybe must release the session lock first.
 'zt-jobs'=>['method'=>'POST','auth'=>'session','handler'=>function(RouteContext $ctx):array{$pdo=$ctx->pdo();$c=$ctx->config;register_shutdown_function(static fn()=>Jobs::maybe($pdo,$c));return ['ok'=>true];}],
 // Control: slow work after the response that keeps the session open holds the next request of the same person.
 'zt-hold'=>['method'=>'POST','auth'=>'session','handler'=>function():array{register_shutdown_function(static fn()=>usleep(1500000));return ['ok'=>true];}],
 // The config value this request runs with: the tests poll it after a fixture rewrites config.php (never a fixed sleep).
 'zt-config'=>['method'=>'GET','auth'=>'public','handler'=>fn(RouteContext $ctx):array=>['jobTestSleepMs'=>$ctx->config['job_test_sleep_ms']]],
 'zt-post'=>['method'=>'POST','auth'=>'session','user'=>'optional','max'=>200,'handler'=>$echo],
 'zt-none'=>['method'=>'POST','auth'=>'session','user'=>'optional','handler'=>fn()=>null],
 'zt-fail'=>['method'=>'POST','auth'=>'session','user'=>'optional','handler'=>fn()=>throw new ApiError('Brak uprawnień.',409,['code'=>'zt'])],
 'zt-upload'=>['method'=>'POST','auth'=>'upload','types'=>['image/png','image/jpeg'],'max'=>16,'handler'=>$echo],
 'zt-upload-own'=>['method'=>'POST','auth'=>'upload','types'=>['image/png'],'max'=>16,'reject'=>fn(int $s)=>throw new ApiError('own '.$s,$s,['code'=>'own']),'handler'=>$echo],
 'zt-webhook'=>['method'=>'POST','auth'=>'webhook','max'=>32,'handler'=>$echo],
 'zt-chat'=>['method'=>'GET','auth'=>'public','tag'=>'chat','handler'=>fn()=>['ok'=>true]],
 'zt-anon'=>['method'=>'GET','auth'=>'session','user'=>'anon','handler'=>$echo],
 'zt-required'=>['method'=>'GET','auth'=>'session','handler'=>$echo],
 'zt-member'=>['method'=>'GET','auth'=>'session','user'=>'member','handler'=>$echo],
 'zt-admin'=>['method'=>'GET','auth'=>'session','user'=>'admin','handler'=>$echo],
 'zt-admin-peek'=>['method'=>'GET','auth'=>'peek','user'=>'admin','handler'=>$echo],
];
`;
before(()=>{fixture('reset-limits');if(!skipRoutes)writeFileSync(routesFile,TEST_ROUTES);});
after(()=>{if(routesFile&&existsSync(routesFile))unlinkSync(routesFile);});
// Every scenario signs in several times from 127.0.0.1 (8 attempts per address and e-mail in 15 minutes).
beforeEach(()=>fixture('reset-limits'));

test('session and login stay lightweight with the same response shapes; one message for every failed login',{skip},async()=>{
 const c=new Client(),s=await c.req('session');
 assert.equal(s.status,200);assert.deepEqual(s.data,{user:null,csrf:s.data.csrf});assert.match(s.data.csrf,/^[0-9a-f]{64}$/);
 const l=await c.req('login',{email:' Admin@Test.Example ',password:ADMIN[1]});
 assert.equal(l.status,200,JSON.stringify(l.data));assert.deepEqual(Object.keys(l.data),['user','csrf']);assert.deepEqual(Object.keys(l.data.user),KEYS.user);
 assert.equal(l.data.user.email,ADMIN[0]);assert.equal(l.data.user.role,'admin');assert.equal(typeof l.data.user.clubId,'string');assert.equal(l.data.user.active,true);
 assert.ok(!(l.headers.getSetCookie().at(-1)||'').match(/expires=/i),'staff keep a browser-session cookie');
 const again=await c.req('session');assert.deepEqual(again.data,{user:l.data.user,csrf:again.data.csrf});
 const stored=fixture('session-read',{sid:sid(c)}).data;assert.equal(stored.idle,1800);assert.equal(stored.max,43200);
 const blocked=fixture('member',{email:'zablokowany.api@test.example',password:PASSWORD,profile:true,exempt:true,active:false});assert.ok(blocked.id);
 for(const body of [{email:ADMIN[0],password:'WrongPassword2026!'},{email:'nobody.api@test.example',password:PASSWORD},{email:'zablokowany.api@test.example',password:PASSWORD},{email:'x'.repeat(250)+'@t.pl',password:PASSWORD},{}]){
  const r=await (await fresh()).req('login',body);assert.equal(r.status,401,JSON.stringify(body));assert.equal(r.data.error,'Nieprawidłowy e-mail lub hasło.');assert.ok(r.data.csrf);
 }
 const out=await c.req('logout',{});assert.equal(out.status,200);assert.equal((await c.req('session')).data.user,null);
});

test('a member signs in with a 30-day cookie, gets an empty workspace and can run no command',{skip},async()=>{
 const email='czlonek.api@test.example',m=fixture('member',{email,password:PASSWORD,profile:true,exempt:true});
 const c=await signIn(email);
 assert.deepEqual(c.login.data.user,{id:m.id,clubId:null,email,role:'member',active:true});
 const cookie=c.login.headers.getSetCookie().at(-1);
 const maxAge=Number(cookie.match(/Max-Age=(\d+)/i)?.[1]);assert.ok(Math.abs(maxAge-2592000)<=5,cookie);
 assert.match(cookie,/expires=/i);assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);assert.match(cookie,/path=\//i);
 const stored=fixture('session-read',{sid:sid(c)}).data;assert.equal(stored.idle,1209600);assert.equal(stored.max,2592000);assert.equal(stored.userId,m.id);
 assert.deepEqual((await c.req('session')).data.user,c.login.data.user);
 const b=await c.req('bootstrap');assert.equal(b.status,200);
 assert.deepEqual(b.data,{schemaVersion:2,revision:0,user:c.login.data.user,clubs:[],users:[],profiles:[],tournaments:[]});
 for(const type of ['tournament.save','account.password','account.save']){
  const r=await c.req('command',{type,payload:{id:m.id},expectedRevision:0});assert.equal(r.status,403,type);assert.equal(r.data.error,'Brak uprawnień.');
 }
 const admin=new Client();await admin.login(...ADMIN);assert.ok(!JSON.stringify(admin.data).includes(email),'members stay out of the staff workspace');
});

test('me returns the §4.3 shape for admin, staff and members; public-config for guests',{skip},async()=>{
 const t=now(),admin=new Client();await admin.login(...ADMIN);
 const a=await me(admin);
 assert.deepEqual(a.user,{...admin.data.user});assert.match(a.profile.publicId,/^[0-9A-Za-z]{12}$/);
 assert.deepEqual({...a.profile,publicId:0},{publicId:0,username:null,firstName:null,lastName:null,country:null,sports:[],clubText:null,showClub:false,nameDisplay:'initial',avatar:null,complete:false,usernameChangeAt:null,mustChangePassword:false});
 assert.deepEqual(a.access,{full:true,state:'staff',until:null,canPost:false,block:'profile',mutedUntil:null});
 assert.deepEqual(a.billing,{enabled:true,enforce:true,mode:'test',currency:null,amounts:{pln:899,usd:299},exempt:true,hasCustomer:false,pending:false});
 assert.equal(a.features.signup,true);assert.ok(['gd-webp','gd-jpeg','off'].includes(a.features.avatars));assert.equal(typeof a.features.chat,'boolean');
 assert.equal((await me(admin)).profile.publicId,a.profile.publicId,'the profile row is created once');
 // Staff account created by the Admin (no billing row): free by default.
 await admin.cmd('account.save',{email:'klub.me@test.example',password:PASSWORD,clubName:'Klub Me',role:'club'});
 const club=await me(await signIn('klub.me@test.example'));
 assert.deepEqual({state:club.access.state,full:club.access.full,until:club.access.until,exempt:club.billing.exempt},{state:'free',full:true,until:null,exempt:true});
 // Members: free and complete, not paying, paying in USD with a pending checkout, temporary password, no profile yet.
 const avatar='9f2c41ab07de0123456789abcdef0123.webp';
 const free=fixture('member',{email:'wolny.me@test.example',password:PASSWORD,profile:{firstName:'Marta',lastName:'Kowalska',username:'marta.me',sports:['taekwondo','karate'],clubText:'KS Tygrys',showClub:true,avatar,usernameChangedAt:t-10*86400},exempt:true});
 const f=await me(await signIn('wolny.me@test.example'));
 assert.deepEqual(f.user,{id:free.id,clubId:null,email:'wolny.me@test.example',role:'member',active:true});
 assert.deepEqual(f.profile,{publicId:free.publicId,username:'marta.me',firstName:'Marta',lastName:'Kowalska',country:'PL',sports:['taekwondo','karate'],clubText:'KS Tygrys',showClub:true,
  nameDisplay:'initial',avatar:'9f2c41ab07de',complete:true,usernameChangeAt:t-10*86400+30*86400,mustChangePassword:false});
 assert.deepEqual(f.access,{full:true,state:'free',until:null,canPost:blockOr(f,null)===null,block:blockOr(f,null),mutedUntil:null});
 assert.deepEqual(f.billing,{enabled:true,enforce:true,mode:'test',currency:'pln',amounts:{pln:899,usd:299},exempt:true,hasCustomer:false,pending:false});
 fixture('member',{email:'nieplacacy.me@test.example',password:PASSWORD,profile:{country:'DE',usernameChangedAt:t-31*86400}});
 const unpaid=await me(await signIn('nieplacacy.me@test.example'));
 assert.deepEqual(unpaid.access,{full:false,state:'none',until:null,canPost:false,block:'payment',mutedUntil:null});
 assert.equal(unpaid.billing.currency,'usd');assert.equal(unpaid.billing.exempt,false);assert.equal(unpaid.profile.usernameChangeAt,null);
 const paid=fixture('member',{email:'placacy.me@test.example',password:PASSWORD,profile:true});
 fixture('billing',{userId:paid.id,sub_status:'active',current_period_start:t-86400,current_period_end:t+29*86400,currency:'usd',stripe_customer_id:'cus_me_test',livemode:0,pending_checkout_id:'cs_test_me',pending_checkout_expires:t+600});
 const p=await me(await signIn('placacy.me@test.example'));
 assert.deepEqual({state:p.access.state,full:p.access.full,until:p.access.until},{state:'active',full:true,until:t+29*86400});
 assert.deepEqual({currency:p.billing.currency,hasCustomer:p.billing.hasCustomer,pending:p.billing.pending,exempt:p.billing.exempt},{currency:'usd',hasCustomer:true,pending:true,exempt:false},'an ongoing subscription keeps its currency');
 fixture('member',{email:'tymczasowe.me@test.example',password:PASSWORD,profile:{pwResetAt:t},exempt:true});
 const temp=await me(await signIn('tymczasowe.me@test.example'));
 assert.equal(temp.profile.mustChangePassword,true);assert.equal(temp.access.block,'password');assert.equal(temp.access.canPost,false);
 // block follows the chat-send checks (§5.5: payment, profile, temporary password); mustChangePassword stays true.
 fixture('member',{email:'tymczasowe.nieplacacy.me@test.example',password:PASSWORD,profile:{pwResetAt:t}});
 const tempUnpaid=await me(await signIn('tymczasowe.nieplacacy.me@test.example'));
 assert.deepEqual([tempUnpaid.access.block,tempUnpaid.profile.mustChangePassword],['payment',true]);
 fixture('member',{email:'tymczasowe.niepelny.me@test.example',password:PASSWORD,profile:{pwResetAt:t,sports:[]},exempt:true});
 const tempIncomplete=await me(await signIn('tymczasowe.niepelny.me@test.example'));
 assert.deepEqual([tempIncomplete.access.block,tempIncomplete.profile.complete,tempIncomplete.profile.mustChangePassword],['profile',false,true]);
 const bare=fixture('member',{email:'bez.profilu.me@test.example',password:PASSWORD,exempt:true});
 const n=await me(await signIn('bez.profilu.me@test.example'));
 assert.equal(bare.publicId,null);assert.match(n.profile.publicId,/^[0-9A-Za-z]{12}$/);assert.equal(n.profile.complete,false);assert.equal(n.access.block,'profile');assert.deepEqual(n.profile.sports,[]);
 // Without a session: 401, still no cookie; POST is not allowed.
 const anon=await raw('me');assert.equal(anon.status,401);assert.deepEqual(anon.data,{error:'Zaloguj się ponownie.'});assert.equal(anon.headers.get('set-cookie'),null);
 const post=await raw('me',{method:'POST',body:{}});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');
 // public-config: cacheable, cookie-free, the documented keys only.
 for(const cookie of [undefined,admin.cookie]){
  const pc=await raw('public-config',{cookie});assert.equal(pc.status,200);assert.equal(pc.headers.get('set-cookie'),null);
  assert.equal(pc.headers.get('cache-control'),'public, max-age=60');assert.doesNotMatch(pc.headers.get('vary')||'',/cookie/i);
  assert.deepEqual(pc.data,{signup:true,billing:true,amounts:{pln:899,usd:299},avatars:pc.data.avatars,support:'pomoc@example.test'});assert.equal(typeof pc.data.avatars,'boolean');
 }
 const pcPost=await raw('public-config',{method:'POST',body:{}});assert.equal(pcPost.status,405);assert.equal(pcPost.headers.get('allow'),'GET');
});

test('staff without full access keep the read-only workspace; commands answer 402 except their own password',{skip},async()=>{
 const admin=new Client();await admin.login(...ADMIN);
 const email='platny.klub@test.example',{id}=await admin.cmd('account.save',{email,password:PASSWORD,clubName:'Klub Płatny',role:'club'});
 fixture('billing',{userId:id,billing_exempt:0});
 const c=new Client();const w=await c.login(email,PASSWORD);assert.equal(w.user.id,id);assert.ok(Array.isArray(w.tournaments));
 const athlete={name:'Zawodnik Płatny',birthDate:'2010-02-01',sex:'M',weight:60,height:170,gradeType:'cup',grade:6,events:['forms']};
 const r=await c.req('command',{type:'profile.save',payload:athlete,expectedRevision:c.data.revision});
 assert.equal(r.status,402,JSON.stringify(r.data));assert.equal(r.data.error,'Ta funkcja wymaga aktywnej subskrypcji.');assert.ok(r.data.csrf);
 const m=await me(c);assert.deepEqual({state:m.access.state,full:m.access.full,block:m.access.block,exempt:m.billing.exempt},{state:'none',full:false,block:'payment',exempt:false});
 await c.cmd('account.password',{id,currentPassword:PASSWORD,password:'NewClubPassword2026!'});
 assert.equal((await c.req('bootstrap')).status,200,'still signed in after changing the own password');
 fixture('billing',{userId:id,billing_exempt:1,exempt_reason:'test'});
 await c.cmd('profile.save',athlete);assert.equal(c.data.profiles.length,1);
});

test('peek routes never send cookies or create session files; activity is refreshed at most once per idle/4',{skip},async()=>{
 const c=await signIn(...ADMIN),files=sessionFiles(),id=sid(c);
 const valid=await raw('me',{cookie:c.cookie});
 assert.equal(valid.status,200);assert.equal(valid.headers.get('set-cookie'),null);assert.equal(valid.headers.get('pragma'),null);assert.equal(valid.headers.get('expires'),null);
 for(const cookie of ['matdraw_session='+'A'.repeat(26),'matdraw_session='+'b'.repeat(40),'matdraw_session=../../etc/passwd','matdraw_session=x','other=1']){
  const r=await raw('me',{cookie});assert.equal(r.status,401,cookie);assert.equal(r.headers.get('set-cookie'),null,cookie);
 }
 assert.deepEqual(sessionFiles(),files,'no session file for unknown or invalid cookies');
 // Expired by idle time and by maximum age: 401 and nothing written (last stays as it was).
 let t=now();fixture('session-edit',{sid:id,set:{last:t-1801}});
 const idle=await raw('me',{cookie:c.cookie});assert.equal(idle.status,401);assert.equal(idle.headers.get('set-cookie'),null);
 assert.equal(fixture('session-read',{sid:id}).data.last,t-1801,'peek never clears or rewrites a session');assert.deepEqual(sessionFiles(),files);
 fixture('session-edit',{sid:id,set:{last:t,created:t-43201}});assert.equal((await raw('me',{cookie:c.cookie})).status,401);
 // Staff (admin, editor, club): a peek route never refreshes activity, below or above idle/4 (450 s): the 30-minute
 // idle limit counts from the last session request, so background polls cannot keep an unattended staff tab signed in.
 t=now();fixture('session-edit',{sid:id,set:{last:t-60,created:t-60}});
 assert.equal((await raw('me',{cookie:c.cookie})).status,200);assert.equal(fixture('session-read',{sid:id}).data.last,t-60);
 fixture('session-edit',{sid:id,set:{last:t-451}});
 const staffPeek=await raw('me',{cookie:c.cookie});assert.equal(staffPeek.status,200);assert.equal(staffPeek.headers.get('set-cookie'),null);
 assert.equal(fixture('session-read',{sid:id}).data.last,t-451,'a staff session is not refreshed by peek');assert.equal(fixture('session-read',{sid:id}).data.kind,'staff');
 assert.equal((await c.req('session')).data.user.id,c.login.data.user.id,'the same cookie keeps working');
 assert.ok(fixture('session-read',{sid:id}).data.last>=t,'a session request refreshes staff activity');
 // Members: idle/4 of 14 days; above it one write of last, same id, no cookie, no new file.
 fixture('member',{email:'peek.member@test.example',password:PASSWORD,profile:true,exempt:true});
 const m=await signIn('peek.member@test.example');t=now();const files2=sessionFiles();
 assert.equal(fixture('session-read',{sid:sid(m)}).data.kind,'member');
 fixture('session-edit',{sid:sid(m),set:{last:t-86400}});assert.equal((await raw('me',{cookie:m.cookie})).status,200);assert.equal(fixture('session-read',{sid:sid(m)}).data.last,t-86400);
 fixture('session-edit',{sid:sid(m),set:{last:t-302401}});const refreshed=await raw('me',{cookie:m.cookie});
 assert.equal(refreshed.status,200);assert.equal(refreshed.headers.get('set-cookie'),null);
 const after=fixture('session-read',{sid:sid(m)}).data;assert.ok(after.last>=t,JSON.stringify(after));assert.equal(after.userId,m.login.data.user.id);
 assert.deepEqual(sessionFiles(),files2);
 // A member session signed in before the kind was stored: its idle limit above the staff one marks it.
 fixture('session-edit',{sid:sid(m),set:{kind:null,last:t-302401}});assert.equal((await raw('me',{cookie:m.cookie})).status,200);assert.ok(fixture('session-read',{sid:sid(m)}).data.last>=t);
});

test('background polls (chat heads, moderation badge, me, chat-channels) never keep a staff session alive; members stay signed in',{skip},async()=>{
 const admin=await signIn(...ADMIN);
 fixture('member',{email:'poll.member@test.example',password:PASSWORD,profile:true,exempt:true});
 const m=await signIn('poll.member@test.example');
 // A short idle limit stored in both sessions (as sign-in stores it): 6 s, so the refresh threshold idle/4 is 1.5 s.
 const t=now();for(const c of [admin,m])fixture('session-edit',{sid:sid(c),set:{idle:6,last:t-4}});
 const polls=['chat-feed&h=1:0:0,2:0:0','me','chat-channels'];
 for(let round=0;round<2;round++){
  for(const route of [...polls,'admin-chat-reports'])assert.ok([200,204].includes((await raw(route,{cookie:admin.cookie})).status),route);
  for(const route of polls)assert.ok([200,204].includes((await raw(route,{cookie:m.cookie})).status),route);
 }
 assert.equal(fixture('session-read',{sid:sid(admin)}).data.last,t-4,'peek polls never refresh a staff session');
 assert.ok(fixture('session-read',{sid:sid(m)}).data.last>=t,'a member session is refreshed after idle/4');
 // Past the staff session's idle limit: signed out although the page kept polling; the member is still signed in.
 while(now()<t+3)await sleep(100);
 assert.equal((await raw('me',{cookie:admin.cookie})).status,401);
 assert.equal((await admin.req('session')).data.user,null,'the staff session expired after its idle limit');
 assert.equal((await m.req('session')).data.user?.id,m.login.data.user.id);
});

test('a staff session reading the chat (chat-feed with a=1 and a channel on screen) stays signed in; a=1 anywhere else refreshes nothing',{skip},async()=>{
 const reader=await signIn(...ADMIN),unattended=await signIn(...ADMIN);
 const t=now();for(const c of [reader,unattended])fixture('session-edit',{sid:sid(c),set:{idle:6,last:t-4}});
 // a=1 on a heads-only poll or on another peek route, and a chat on screen without a=1, are not someone reading.
 for(const route of ['chat-feed&h=1:0:0,2:0:0&a=1','me&a=1','chat-channels&a=1','admin-chat-reports&a=1','chat-feed&ch=1:0','chat-feed&ch=1:0&a=yes'])
  assert.ok([200,204].includes((await raw(route,{cookie:unattended.cookie})).status),route);
 assert.equal(fixture('session-read',{sid:sid(unattended)}).data.last,t-4,'no refresh without a reading poll');
 // Reading (plan §3.5 step 6): one refresh write after idle/4, same id, no cookie.
 const r=await raw('chat-feed&ch=1:0&a=1',{cookie:reader.cookie});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);
 assert.ok(fixture('session-read',{sid:sid(reader)}).data.last>=t,'reading the chat refreshes a staff session');
 // Past the idle limit both sessions started with: the reader is still signed in, the unattended session expired.
 while(now()<t+3)await sleep(100);
 assert.equal((await reader.req('session')).data.user?.id,reader.login.data.user.id);
 assert.equal((await unattended.req('session')).data.user,null);
});

test('maintenance file and schema behind code answer 503 with Retry-After; an outdated client gets 409',{skip},async()=>{
 const flag=path.join(shared,'maintenance');writeFileSync(flag,'');
 try{
  for(const route of ['session','me','public-config','public','bootstrap']){
   const r=await raw(route);assert.equal(r.status,503,route);assert.equal(r.headers.get('retry-after'),'120');assert.equal(r.headers.get('set-cookie'),null,'answered before the session');
   assert.deepEqual(r.data,{error:'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.'});
  }
  assert.equal((await raw('login',{method:'POST',body:{email:'a@b.c',password:'x'}})).status,503);
 }finally{unlinkSync(flag);}
 assert.equal((await raw('session')).status,200);
 const c=await signIn(...ADMIN);
 fixture('table-hide',{table:'user_profiles'});
 try{
  for(const r of [await raw('me',{cookie:c.cookie}),await (await fresh()).req('login',{email:ADMIN[0],password:ADMIN[1]})]){
   assert.equal(r.status,503,JSON.stringify(r.data));assert.equal(r.headers.get('retry-after'),'120');assert.equal(r.data.error,'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.');
  }
 }finally{fixture('table-restore',{table:'user_profiles'});}
 assert.equal((await raw('me',{cookie:c.cookie})).status,200);
 for(const route of ['session','public-config','public','me']){
  const r=await raw(route,{headers:{'X-MatBravo-Client':'0'}});assert.equal(r.status,409,route);assert.equal(r.headers.get('set-cookie'),null);
  assert.deepEqual(r.data,{error:'Dostępna jest nowa wersja MatBravo. Odśwież stronę.',code:'client_outdated'});
 }
 for(const v of ['1','2',' 1 ','abc',''])assert.equal((await raw('public-config',{headers:{'X-MatBravo-Client':v}})).status,200,JSON.stringify(v));
 const old=fixture('config-set',{set:{min_client_api:2}});
 try{assert.equal(await until(async()=>(await raw('public-config')).status,409),409);assert.equal((await raw('public-config',{headers:{'X-MatBravo-Client':'2'}})).status,200);}
 finally{fixture('config-set',{set:{min_client_api:old.min_client_api}});}
 assert.equal(await until(async()=>(await raw('public-config')).status,200),200);
 const unknown=await raw('no-such-route');assert.equal(unknown.status,404);assert.equal(unknown.data.error,'Nie ma takiej operacji.');
 const list=await fetch(base+'?route[]=me');assert.equal(list.status,404);
});

test('work after the response never holds the session: a second request with the same cookie answers in < 1 s',{skip:skipRoutes},async()=>{
 const c=await signIn(...ADMIN),second=async()=>{const t=performance.now(),r=await raw('session',{cookie:c.cookie});assert.equal(r.status,200);assert.equal(r.data.user.id,c.login.data.user.id);return performance.now()-t;};
 // Control: a shutdown function that keeps the session open holds the next request (so this measurement can fail).
 // Every request started here is awaited before the test ends, also when an assertion fails (no activity after the test).
 const hold=c.req('zt-hold',{});let held;try{await sleep(300);held=await second();}finally{assert.equal((await hold).status,200);}
 assert.ok(held>=1000,`the held session lock was not noticed (${Math.round(held)} ms)`);
 const jobSleep=async()=>(await raw('zt-config')).data?.jobTestSleepMs;
 const old=fixture('config-set',{set:{job_test_sleep_ms:2500}});
 try{
  assert.equal(await eventually(jobSleep,2500),2500,'the server runs with the slowed job');
  // A session POST (as chat-send) runs a slowed job after its response: Jobs::maybe released the session first.
  fixture('jobs-reset');let start=now(),t0=performance.now();
  const first=c.req('zt-jobs',{}).then(r=>({...r,took:performance.now()-t0}));let took;
  try{await sleep(400);took=await second();}finally{await first;}
  assert.ok(took<1000,`second request took ${Math.round(took)} ms`);
  // php -S has no fastcgi_finish_request: the first answer ends after the slowed job, which proves the job ran meanwhile.
  const a=await first;assert.equal(a.status,200);assert.ok(a.took>=2000,`the job was not slowed down (${Math.round(a.took)} ms)`);
  assert.equal(fixture('job-runs').filter(r=>r.last_run_at>=start).length,1,'exactly one job per request: '+JSON.stringify(fixture('job-runs')));
  assert.ok(existsSync(path.join(shared,'jobs-tick')),'the sampling file is touched');
  // Sampling: within 30 s of the tick no further job runs (me and the session POST).
  assert.equal((await raw('me',{cookie:c.cookie})).status,200);assert.equal((await c.req('zt-jobs',{})).status,200);
  assert.equal(fixture('job-runs').filter(r=>r.last_run_at>=start).length,1);
  // me runs one job after its response too.
  fixture('jobs-reset');start=now();t0=performance.now();
  const m=await raw('me',{cookie:c.cookie});assert.equal(m.status,200);assert.ok(performance.now()-t0>=2000,'me ran the slowed job');
  assert.equal(fixture('job-runs').filter(r=>r.last_run_at>=start).length,1);
 }finally{fixture('config-set',{set:{job_test_sleep_ms:old.job_test_sleep_ms}});assert.equal(await eventually(jobSleep,old.job_test_sleep_ms??0),old.job_test_sleep_ms??0,'restored');}
});

test('dispatch of session POST: Origin and CSRF, JSON type, size, depth and shape; errors carry csrf; null answers 204',{skip:skipRoutes},async()=>{
 const c=await fresh(),{cookie,csrf}=c,fail=error=>({error,csrf});
 assert.deepEqual(await send('zt-post',{cookie,json:{a:1}}).then(r=>[r.status,r.data]),[403,fail('Sesja formularza wygasła. Odśwież stronę.')]);
 assert.deepEqual(await send('zt-post',{cookie,csrf:'0'.repeat(64),json:{a:1}}).then(r=>[r.status,r.data]),[403,fail('Sesja formularza wygasła. Odśwież stronę.')]);
 assert.deepEqual(await send('zt-post',{cookie,csrf,json:{a:1},headers:{Origin:'https://evil.example'}}).then(r=>[r.status,r.data]),[403,fail('Niedozwolone źródło żądania.')]);
 let r=await c.req('zt-post',{a:'Zażółć'});assert.equal(r.status,200);assert.deepEqual(r.data,{route:'zt-post',role:null,body:{a:'Zażółć'},len:0});
 assert.deepEqual((await c.req('zt-post',[1,[2]])).data.body,[1,[2]]);
 assert.equal((await send('zt-post',{cookie,csrf,type:'Application/JSON; charset=utf-8',json:{b:2}})).status,200);
 assert.equal((await send('zt-post',{cookie,csrf,data:JSON.stringify({x:'y'.repeat(192)})})).status,200,'200 bytes is the limit');
 const nested=n=>'['.repeat(n)+']'.repeat(n);assert.equal((await send('zt-post',{cookie,csrf,data:nested(20)})).status,200);
 for(const [type,data,status,error] of [['text/plain','{"a":1}',415,'Wymagany format JSON.'],[null,'{"a":1}',415,'Wymagany format JSON.'],
  ['application/json',JSON.stringify({x:'y'.repeat(193)}),413,'Żądanie jest zbyt duże.'],['application/json','{',400,'Niepoprawny JSON.'],['application/json','',400,'Niepoprawny JSON.'],
  ['application/json',nested(40),400,'Niepoprawny JSON.'],['application/json','"x"',400,'Niepoprawny formularz.'],['application/json','12',400,'Niepoprawny formularz.']]){
  r=await send('zt-post',{cookie,csrf,type,data});assert.deepEqual([r.status,r.data],[status,fail(error)],`${type} ${data.slice(0,20)}`);
 }
 r=await send('zt-none',{cookie,csrf,json:{}});assert.equal(r.status,204);assert.equal(r.text,'');assert.equal(r.headers.get('content-type'),null);
 r=await c.req('zt-fail',{});assert.deepEqual([r.status,r.data],[409,{error:'Brak uprawnień.',csrf,code:'zt'}]);
 r=await raw('zt-post',{cookie});assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'POST');assert.equal(r.data.error,'Niedozwolona metoda.');
});

test('dispatch of upload and webhook: content types, size limits, own rejection messages, no session for webhooks',{skip:skipRoutes},async()=>{
 const admin=await signIn(...ADMIN),{cookie,csrf}=admin,png=Buffer.alloc(10,0x89),fail=error=>({error,csrf});
 let r=await send('zt-upload',{cookie,csrf,type:'image/png',data:png});assert.deepEqual([r.status,r.data],[200,{route:'zt-upload',role:'admin',body:[],len:10}]);
 assert.equal((await send('zt-upload',{cookie,csrf,type:'IMAGE/JPEG; charset=binary',data:Buffer.alloc(16)})).status,200);
 for(const [type,data,status,error] of [['image/gif',png,415,'Nieobsługiwany format danych.'],[null,png,415,'Nieobsługiwany format danych.'],['image/png',Buffer.alloc(17),413,'Żądanie jest zbyt duże.']]){
  r=await send('zt-upload',{cookie,csrf,type,data});assert.deepEqual([r.status,r.data],[status,fail(error)],String(type));
 }
 assert.deepEqual(await send('zt-upload-own',{cookie,csrf,type:'image/gif',data:png}).then(r=>[r.status,r.data]),[415,{...fail('own 415'),code:'own'}]);
 assert.deepEqual(await send('zt-upload-own',{cookie,csrf,type:'image/png',data:Buffer.alloc(17)}).then(r=>[r.status,r.data]),[413,{...fail('own 413'),code:'own'}]);
 assert.deepEqual(await send('zt-upload',{cookie,type:'image/png',data:png}).then(r=>[r.status,r.data]),[403,fail('Sesja formularza wygasła. Odśwież stronę.')]);
 const guest=await fresh();
 assert.deepEqual(await send('zt-upload',{cookie:guest.cookie,csrf:guest.csrf,type:'image/png',data:png}).then(r=>[r.status,r.data]),[401,{error:'Zaloguj się ponownie.',csrf:guest.csrf}]);
 // Webhook: no session, no CSRF, any content type; the raw body reaches the handler.
 for(const c of [undefined,cookie]){
  r=await send('zt-webhook',{cookie:c,type:'application/json',data:'{"id":"evt_1"}',headers:{'Stripe-Signature':'t=1,v1=x'}});
  assert.deepEqual([r.status,r.data],[200,{route:'zt-webhook',role:null,body:[],len:14}]);assert.equal(r.headers.get('set-cookie'),null);
 }
 r=await send('zt-webhook',{data:'x'.repeat(33)});assert.deepEqual([r.status,r.data],[413,{error:'Żądanie jest zbyt duże.'}]);
 r=await raw('zt-webhook');assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'POST');
});

test('dispatch: a chat-tagged route answers 503 chat_off while <shared>/chat-off exists; user rules answer 401 and 403 first',{skip:skipRoutes},async()=>{
 const flag=path.join(shared,'chat-off');
 assert.deepEqual(await raw('zt-chat').then(r=>[r.status,r.data]),[200,{ok:true}]);
 writeFileSync(flag,'');
 try{
  const r=await raw('zt-chat');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'300');
  assert.deepEqual(r.data,{error:'Czat jest chwilowo wyłączony. Spróbuj później.',code:'chat_off'});
 }finally{unlinkSync(flag);}
 assert.equal((await raw('zt-chat')).status,200);
 fixture('member',{email:'reguly.api@test.example',password:PASSWORD,profile:true,exempt:true});
 const guest=await fresh(),member=await signIn('reguly.api@test.example'),admin=await signIn(...ADMIN);
 const who={guest,member,admin},E401='Zaloguj się ponownie.',E403='Brak uprawnień.';
 // route: [guest, member, admin] → role on 200, else the status
 const rules={'zt-anon':[null,403,403],'zt-required':[401,'member','admin'],'zt-member':[401,'member',403],'zt-admin':[401,403,'admin'],'zt-admin-peek':[401,403,'admin']};
 for(const [route,expected] of Object.entries(rules))for(const [i,[name,c]] of Object.entries(Object.entries(who))){
  const r=await raw(route,{cookie:c.cookie}),want=expected[i],peek=route==='zt-admin-peek',label=route+' '+name;
  if(typeof want==='number'){assert.equal(r.status,want,label);assert.deepEqual(r.data,{error:want===401?E401:E403,...(peek?{}:{csrf:c.csrf})},label);}
  else{assert.equal(r.status,200,label);assert.equal(r.data.role,want,label);}
  if(peek)assert.equal(r.headers.get('set-cookie'),null,label);
 }
 assert.equal((await member.req('session')).data.user.role,'member','a refused route keeps the session');
});

test('login: equal cost for known and unknown e-mails; 8 attempts per address and e-mail, then 429 with Retry-After',{skip},async()=>{
 const times={known:[],unknown:[]};
 for(let i=0;i<10;i++){
  fixture('reset-limits');
  for(const [kind,email] of [['known',ADMIN[0]],['unknown',`nikt${i}.api@test.example`]]){
   const c=await fresh(),t=performance.now(),r=await c.req('login',{email,password:'WrongPassword2026!'});times[kind].push(performance.now()-t);assert.equal(r.status,401);
  }
 }
 const median=a=>{const s=[...a].sort((x,y)=>x-y);return (s[4]+s[5])/2;},ratio=median(times.known)/median(times.unknown);
 assert.ok(ratio>0.5&&ratio<2,`median ratio ${ratio.toFixed(2)} (${JSON.stringify(times)})`);
 fixture('reset-limits');const c=await fresh(),email='limit.api@test.example';
 for(let i=1;i<=8;i++)assert.equal((await c.req('login',{email,password:'WrongPassword2026!'})).status,401,'attempt '+i);
 const r=await c.req('login',{email,password:'WrongPassword2026!'});
 assert.equal(r.status,429);assert.equal(r.data.error,'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.');
 const retry=Number(r.headers.get('retry-after'));assert.ok(retry>0&&retry<=900,String(retry));assert.equal(r.data.retry,retry);assert.ok(r.data.csrf);
 assert.equal((await c.req('login',{email:'inny.api@test.example',password:'WrongPassword2026!'})).status,401,'other e-mails from the same address still try');
 fixture('reset-limits');
});

test('housekeeping (bin/cron.php) deletes session files by kind, only sess_ files of the own directory',{skip},async()=>{
 const t=now(),sidOf=n=>'hk'+String(n).padStart(24,'0'),member={userId:'m',authVersion:1,created:t,last:t,csrf:'x',idle:1209600,max:2592000};
 const cases=[[1,{csrf:'x'},4*3600,false],[2,{csrf:'x'},3600,true],[3,{userId:'s',authVersion:1,created:t,last:t,csrf:'x',idle:1800,max:43200},13*3600,false],
  [4,{userId:'old',authVersion:1,created:t,last:t,csrf:'x'},13*3600,false],[5,member,13*3600,true],[6,member,15*86400,false],[7,{userId:'s',csrf:'x',max:43200},11*3600,true]];
 for(const [n,data,age] of cases)fixture('session-create',{sid:sidOf(n),data,mtime:t-age});
 const other=path.join(sessions,'notes.txt');writeFileSync(other,'x');utimesSync(other,t-40*86400,t-40*86400);
 try{
  fixture('jobs-reset');
  const run=args=>spawnSync(php,[path.join(backend,'bin','cron.php'),...args],{encoding:'utf8',env:process.env});
  const r=run(['--job=housekeeping']);assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/^housekeeping: login_limits=\d+ sessions scanned=\d+ deleted=(\d+) next=0$/m);
  for(const [n,,,kept] of cases)assert.equal(existsSync(path.join(sessions,'sess_'+sidOf(n))),kept,'session '+n);
  assert.ok(existsSync(other),'only sess_ files are touched');
  const second=run(['--job=housekeeping']);assert.equal(second.status,0,second.stderr);assert.match(second.stdout,/Brak zaległych zadań/);
  const bad=run(['--job=nothing']);assert.equal(bad.status,1);assert.match(bad.stderr,/Nieznane zadanie/);
 }finally{for(const [n] of cases)try{unlinkSync(path.join(sessions,'sess_'+sidOf(n)));}catch{}unlinkSync(other);}
});
