// API core over real PHP and MariaDB/MySQL (plan §11, backend-api): lightweight session/login with unchanged shapes,
// member isolation, me for every role, public-config, the payment gate for staff, read-only peek sessions (no file, no
// cookie, activity refresh after idle/4), maintenance and schema-behind 503, client_outdated, the session lock during
// background jobs, login timing and limits, and session housekeeping through bin/cron.php. Run through scripts/test-http.sh.
import test,{before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,unlinkSync,utimesSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend=path.join(process.env.MATDRAW_TEST_RELEASE||repo,'backend');
const shared=process.env.MATDRAW_TEST_SHARED_DIR,sessions=shared?path.join(shared,'sessions'):'';
const skip=!base||!shared;
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!';
const sessionFiles=()=>readdirSync(sessions).filter(f=>f.startsWith('sess_')).sort();
const now=()=>Math.floor(Date.now()/1000);
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
// The server may serve a cached config.php for up to opcache.revalidate_freq (2 s) after a rewrite.
const CONFIG_RELOAD_MS=2600;
async function until(probe,expected,ms=6000){let v;for(const end=Date.now()+ms;Date.now()<end;await sleep(200))if((v=await probe())===expected)break;return v;}
before(()=>fixture('reset-limits'));
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
 // Below idle/4 (450 s for staff): no write. Above it: one write of last, same id, no cookie.
 t=now();fixture('session-edit',{sid:id,set:{last:t-60,created:t-60}});
 assert.equal((await raw('me',{cookie:c.cookie})).status,200);assert.equal(fixture('session-read',{sid:id}).data.last,t-60);
 fixture('session-edit',{sid:id,set:{last:t-451}});const t0=now();
 const refreshed=await raw('me',{cookie:c.cookie});assert.equal(refreshed.status,200);assert.equal(refreshed.headers.get('set-cookie'),null);
 const after=fixture('session-read',{sid:id}).data;assert.ok(after.last>=t0,JSON.stringify(after));assert.equal(after.userId,c.login.data.user.id);
 assert.deepEqual(sessionFiles(),files);
 assert.equal((await c.req('session')).data.user.id,c.login.data.user.id,'the same cookie keeps working');
 // Members: idle/4 of 14 days.
 fixture('member',{email:'peek.member@test.example',password:PASSWORD,profile:true,exempt:true});
 const m=await signIn('peek.member@test.example');t=now();
 fixture('session-edit',{sid:sid(m),set:{last:t-86400}});assert.equal((await raw('me',{cookie:m.cookie})).status,200);assert.equal(fixture('session-read',{sid:sid(m)}).data.last,t-86400);
 fixture('session-edit',{sid:sid(m),set:{last:t-302401}});assert.equal((await raw('me',{cookie:m.cookie})).status,200);assert.ok(fixture('session-read',{sid:sid(m)}).data.last>=t);
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

test('a slow background job does not hold the session: a second request with the same cookie answers in < 1 s',{skip},async()=>{
 const c=await signIn(...ADMIN);
 const old=fixture('config-set',{set:{job_test_sleep_ms:2500}});await sleep(CONFIG_RELOAD_MS);
 try{
  fixture('jobs-reset');const start=now(),t0=performance.now();
  const first=raw('me',{cookie:c.cookie}).then(r=>({...r,took:performance.now()-t0}));await sleep(400);
  const t=performance.now(),second=await raw('session',{cookie:c.cookie}),took=performance.now()-t;
  assert.equal(second.status,200);assert.equal(second.data.user.id,c.login.data.user.id);assert.ok(took<1000,`second request took ${Math.round(took)} ms`);
  // php -S has no fastcgi_finish_request: the first answer ends after the slowed job, which proves the job ran meanwhile.
  const a=await first;assert.equal(a.status,200);assert.ok(a.took>=2000,`the job was not slowed down (${Math.round(a.took)} ms)`);
  const ran=fixture('job-runs').filter(r=>r.last_run_at>=start);assert.equal(ran.length,1,'exactly one job per request: '+JSON.stringify(fixture('job-runs')));
  assert.ok(existsSync(path.join(shared,'jobs-tick')),'the sampling file is touched');
  // Sampling: within 30 s of the tick no further job runs.
  assert.equal((await raw('me',{cookie:c.cookie})).status,200);assert.equal(fixture('job-runs').filter(r=>r.last_run_at>=start).length,1);
 }finally{fixture('config-set',{set:{job_test_sleep_ms:old.job_test_sleep_ms}});}
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
