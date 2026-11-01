// The Administrator's settings over real PHP and MariaDB/MySQL (PLAN-REJESTRACJA-ROLE §3, §8, §12; slice settings-backend).
// Run through scripts/test-http.sh (config.php: sign-up on, billing enabled and enforced in test mode, Stripe stub on
// port+1). Scenarios: no row = config.php; the table missing (code ahead of 0008) = config.php, no 500; admin only;
// stale version; on → off → free (sign-up and payments follow at once, checkout refused while free); free → paid (Stripe
// not configured, prices missing, Stripe down, test mode, the decision about groups A and B incl. an account the Admin
// created in free mode, keep); paid → free → paid with requireFrom (< 14 days 422) and the bulk action; degraded when
// config.php loses Stripe; payments stored as paid while config.php says not enforced (billing-sync, me and command agree);
// organizers paused and trustRequired reach Domain through Settings::flags; the history. The row is removed afterwards.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client,base,eventually,fixture} from './helpers/http-client.mjs';
import {warsawToday} from '../dist/guest-view.js';
import {readFileSync} from 'node:fs';
const shared=process.env.MATDRAW_TEST_SHARED_DIR,skip=!base||!shared;
const stubBase=base?`http://127.0.0.1:${Number(new URL(base).port)+1}`:'';
const stub=async body=>{const r=await fetch(stubBase+'/__control',{method:'POST',body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;};
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const ERR={stale:'Ustawienia zmienił w międzyczasie ktoś inny. Odśwież stronę.',notReady:'Płatności nie są skonfigurowane. Najpierw skonfiguruj Stripe (DEPLOY-PL.md).',
 test:'Stripe działa w trybie testowym: nikt nie zapłaci prawdziwymi pieniędzmi. Potwierdź, jeśli to zamierzone.',decide:'Zdecyduj, co z kontami założonymi w okresie bezpłatnym.',
 notRequired:'Płatności nie są teraz wymagane.',unavailable:'Płatności są chwilowo niedostępne. Spróbuj ponownie później.',closed:'Rejestracja jest chwilowo wyłączona.',
 days:'Płatność można wymagać od daty co najmniej 14 dni od dziś.'};
const now=()=>Math.floor(Date.now()/1000),D=86400,day=n=>warsawToday(new Date(Date.now()+n*864e5));
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
async function signIn(email,password=PASSWORD){const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return Object.assign(c,{id:r.data.user.id});}
async function get(route,cookie){const r=await fetch(base+'?route='+route,{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{})}});let data=null;try{data=await r.json();}catch{}return {status:r.status,data};}
const member=(prefix,o={})=>{const email=uniq(prefix)+'@settings.test';return {...fixture('member',{email,profile:true,...o}),email};};
const row=userId=>fixture('billing-row',{userId});
let admin,lastAudit=0;const original={};
async function view(){const r=await admin.req('admin-settings');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function save(body,status=200){const r=await admin.req('admin-settings-save',body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
/** Rewrites switch keys of config.php and waits until the server applies them (observe() returns `want`). */
async function setConfig(set,observe,want){const old=fixture('settings-config',{set});for(const k of Object.keys(old))if(!(k in original))original[k]=old[k];assert.deepEqual(await eventually(observe,want),want,'server applies '+JSON.stringify(set));}
/** account_audit settings.* rows written since the previous call. */
const audit=()=>{const rows=fixture('settings-audit',{after:lastAudit});if(rows.length)lastAudit=rows.at(-1).id;return rows;};
const signupBegun=async()=>{const c=await fresh();const r=await c.req('signup-begin',{});if(r.status===200)fixture('session-edit',{sid:c.cookie.split('=')[1],set:{signup_at:now()-10}});return [c,r];};

before(async()=>{fixture('reset-limits');fixture('settings-reset');await stub({op:'clear-faults'});admin=await signIn(...ADMIN);audit();});
after(async()=>{
 if(!base)return;
 await stub({op:'clear-faults'});fixture('settings-reset');
 if(Object.keys(original).length)fixture('settings-config',{set:original});
});

test('no row: config.php decides; the settings routes are for the Administrator only',{skip},async()=>{
 assert.equal(fixture('settings-row'),null);
 const v=await view();
 assert.deepEqual(Object.keys(v).sort(),['effective','freeSignups','history','limits','mode','organizers','organizersPending','payments','signup','stripe','stripeCheck','support','trustRequired','updatedAt','updatedBy','version']);
 assert.deepEqual(v.stripeCheck,{ok:false,stale:false,checkedAt:null,mode:null},'final review B4: no check yet');
 assert.deepEqual({version:v.version,signup:v.signup,payments:v.payments,organizers:v.organizers,trustRequired:v.trustRequired,mode:v.mode,effective:v.effective,support:v.support,stripe:v.stripe,updatedAt:v.updatedAt,updatedBy:v.updatedBy},
  {version:0,signup:'on',payments:'paid',organizers:'on',trustRequired:false,mode:'paid',effective:{mode:'paid',degraded:null},support:{email:'pomoc@example.test',source:'config'},stripe:{enabled:true,mode:'test',check:null},updatedAt:null,updatedBy:null});
 assert.deepEqual(Object.keys(v.limits).sort(),['adultAge','athletesPerAccount','clubsDayGlobal','clubsDayPerUser','communityDayGlobal','minorSelfAge','organizerActive','organizerDay','organizerProfilesDay','retentionMonths']);
 assert.ok(Object.values(v.limits).every(n=>Number.isInteger(n)&&n>0));assert.ok(Number.isInteger(v.freeSignups.a)&&Number.isInteger(v.freeSignups.b)&&Number.isInteger(v.organizersPending));
 assert.ok(Array.isArray(v.history));
 const pc=await get('public-config');assert.deepEqual([pc.data.signup,pc.data.billing,pc.data.support],[true,true,'pomoc@example.test']);
 // Members get 403 before any data is read; guests 401.
 const m=member('nieadmin'),c=await signIn(m.email);
 for(const [route,body] of [['admin-settings'],['admin-settings-save',{version:0,signup:'off'}],['admin-stripe-check',{}]])assert.equal((await c.req(route,body)).status,403,route);
 assert.equal((await get('admin-settings')).status,401);
 assert.equal(fixture('settings-row'),null,'nothing written');
});

test('the table missing (code ahead of migration 0008): config.php decides, no 500; saving answers 503',{skip},async()=>{
 fixture('settings-table',{drop:true});
 try{
  const v=await view();assert.deepEqual([v.version,v.mode,v.effective],[0,'paid',{mode:'paid',degraded:null}]);
  const pc=await get('public-config');assert.equal(pc.status,200);assert.equal(pc.data.signup,true);
  const me=await get('me',admin.cookie);assert.equal(me.status,200);assert.equal(me.data.billing.enforce,true);
  const [,begin]=await signupBegun();assert.equal(begin.status,200);
  const r=await admin.req('admin-settings-save',{version:0,signup:'off'});assert.equal(r.status,503,JSON.stringify(r.data));
 }finally{fixture('settings-table',{drop:false});}
 assert.equal(fixture('settings-row'),null);
});

test('a stale version answers 409 and writes nothing; a save without a change writes nothing',{skip},async()=>{
 const r=await save({version:3,signup:'off'},409);assert.deepEqual([r.error,r.code],[ERR.stale,'stale']);
 assert.equal((await save({version:0,signup:'on',payments:'paid'})).version,0);
 assert.equal(fixture('settings-row'),null);assert.deepEqual(audit(),[]);
});

test('on → off → free: sign-up and payments follow the row at once; checkout is refused while payments are not required',{skip},async t=>{
 let v=await save({version:0,signup:'off'});
 assert.deepEqual([v.version,v.signup,v.payments,v.mode,v.effective.mode],[1,'off','paid','off','off']);
 assert.deepEqual(fixture('settings-row').data,{signup:'off',payments:'paid',organizers:'on',trustRequired:false,supportEmail:'pomoc@example.test'},'the first save stores every field');
 const [,closed]=await signupBegun();assert.deepEqual([closed.status,closed.data.error],[404,ERR.closed]);
 assert.equal((await get('public-config')).data.signup,false);
 assert.deepEqual(audit().map(a=>[a.action,a.actor_id,a.target_user_id,a.note]),[['settings.save',admin.id,null,'signup=off payments=paid organizers=on trustRequired=0']]);
 const mark=Date.now();
 v=await save({version:1,signup:'on',payments:'free'});
 assert.deepEqual([v.version,v.mode,v.effective],[2,'free',{mode:'free',degraded:null}]);
 assert.deepEqual((await stub({op:'requests'})).filter(x=>x.at>=mark),[],'paid → free needs no Stripe');
 const pc=await get('public-config');assert.deepEqual([pc.data.signup,pc.data.billing],[true,false]);
 // A new account in free mode: full access (open), no checkout.
 const [c]=await signupBegun();const email=uniq('wolny')+'@settings.test';
 const r=await c.req('signup',{email,password:PASSWORD,firstName:'Ola',lastName:'Wolna',username:uniq('o'),country:'PL',sports:['taekwondo'],clubText:null,showClub:false,website:''});
 assert.equal(r.status,200,JSON.stringify(r.data));
 const me=await get('me',c.cookie);assert.deepEqual([me.data.access.full,me.data.access.state,me.data.billing.enforce],[true,'open',false]);
 const ck=await c.req('billing-checkout',{});assert.deepEqual([ck.status,ck.data.error,ck.data.code],[409,ERR.notRequired,'not_required']);
 const b=row(r.data.user.id);
 if(b.exempt_reason!=='free-signup')t.todo('free-signup marker on sign-up in free mode: slice accounts-backend (Members::signup)');
 else assert.deepEqual([b.billing_exempt,b.exempt_until],[1,null]);
 v=await view();assert.deepEqual(v.history.slice(0,2).map(h=>[h.action,typeof h.at]),[['settings.save','number'],['settings.save','number']],'history: newest first');
 assert.equal(v.history[0].note,'signup=on payments=free organizers=on trustRequired=0');assert.ok(v.updatedAt>=now()-60);
 // The Administrator by display name (profile) or, without a profile, by the role label; never an e-mail or the internal id.
 for(const who of [v.history[0].actor,v.updatedBy])assert.ok(typeof who==='string'&&who!==''&&who!==admin.id&&!who.includes('@'),String(who));
});

test('free → paid: Stripe configured and answering, test mode confirmed, a decision about groups A and B; keep',{skip},async()=>{
 const a=member('grupaa',{exempt:'free-signup'}),b=member('grupab');
 // An account the Admin created in free mode: without "free" it would lose access in paid mode (group B), with the
 // free-signup marker of accounts-backend it is group A; either way the switch must decide about it.
 const createdEmail=uniq('adminowy')+'@settings.test';const made=await admin.req('admin-member',{action:'create',email:createdEmail,firstName:'Adam',lastName:'Nowy',username:uniq('adm'),country:'PL',sports:['karate'],password:PASSWORD});
 assert.equal(made.status,200,JSON.stringify(made.data));const created=made.data.id;
 let version=(await view()).version;
 // 1. Stripe not configured in config.php.
 await setConfig({billing_enabled:false,billing_enforce:false,signup_enabled:false},async()=>(await view()).stripe.enabled,false);
 let r=await save({version,payments:'paid',confirmTestMode:true},409);assert.deepEqual([r.error,r.code],[ERR.notReady,'stripe_not_ready']);
 await setConfig({billing_enabled:true,billing_enforce:true,signup_enabled:true},async()=>(await view()).stripe.enabled,true);
 // 2. Prices missing in Stripe: 409, the failed check is kept for the panel.
 await stub({op:'fault',method:'GET',path:'^/v1/prices',status:404,type:'invalid_request_error',code:'resource_missing',times:2});
 r=await save({version,payments:'paid',confirmTestMode:true},409);assert.deepEqual([r.error,r.code,r.stripeCheck.ok,r.stripeCheck.error],[ERR.notReady,'stripe_not_ready',false,'price_missing']);
 let v=await view();assert.deepEqual([v.version,v.payments,v.stripe.check.ok,v.stripe.check.error,v.stripe.check.prices],[version,'free',false,'price_missing',{pln:false,usd:false}],'a check is not a settings change');
 // 3. Stripe down: one generic 503.
 await stub({op:'fault',method:'GET',path:'^/v1/prices',status:500,times:20});
 r=await save({version,payments:'paid',confirmTestMode:true},503);assert.deepEqual([r.error,r.code],[ERR.unavailable,'stripe_unavailable']);
 await stub({op:'clear-faults'});assert.equal((await view()).stripe.check.error,'unavailable');
 // 4. Test mode needs an explicit confirmation.
 r=await save({version,payments:'paid'},409);assert.deepEqual([r.error,r.code],[ERR.test,'test_mode']);
 // 5. The decision: counts of both groups, nothing changed yet.
 const set=fixture('settings-free-set');
 assert.ok(set.a.includes(a.id),'free-signup exemption: group A');assert.ok(set.b.includes(b.id),'no exemption: group B');assert.ok(set.a.includes(created)||set.b.includes(created),'the Admin-created account is decided about');
 r=await save({version,payments:'paid',confirmTestMode:true},409);assert.deepEqual([r.error,r.code,r.counts],[ERR.decide,'free_period_decision',{a:set.a.length,b:set.b.length}]);
 v=await view();assert.deepEqual([v.version,v.payments,v.stripe.check.ok,v.stripe.check.prices,v.freeSignups.a,v.freeSignups.b],[version,'free',true,{pln:true,usd:true},set.a.length,set.b.length]);
 r=await save({version,payments:'paid',confirmTestMode:true,freePeriod:{action:'requireFrom',date:day(13)}},422);assert.equal(r.error,ERR.days);
 // 6. keep: group A unchanged, group B free from now on (free-signup exemption without an end).
 audit();v=await save({version,payments:'paid',confirmTestMode:true,freePeriod:{action:'keep'}});
 assert.deepEqual([v.version,v.mode,v.effective],[version+1,'paid',{mode:'paid',degraded:null}]);
 const rb=row(b.id);assert.deepEqual([rb.billing_exempt,rb.exempt_reason,rb.exempt_until,rb.exempt_by],[1,'free-signup',null,admin.id]);
 const ra=row(a.id);assert.deepEqual([ra.billing_exempt,ra.exempt_reason,ra.exempt_until],[1,'free-signup',null]);
 assert.deepEqual(audit().map(x=>[x.action,x.note]),[['settings.save',`signup=on payments=paid organizers=on trustRequired=0 keep a=${set.a.length} b=${set.b.length} test`]]);
 const meB=await get('me',(await signIn(b.email)).cookie);assert.deepEqual([meB.data.access.full,meB.data.access.state,meB.data.billing.enforce],[true,'free',true]);
 const meC=await get('me',(await signIn(createdEmail)).cookie);assert.deepEqual([meC.data.access.full,meC.data.access.state],[true,'free'],'the Admin-created account keeps access');
 const after=fixture('settings-free-set');assert.ok(!after.b.includes(b.id)&&after.a.includes(b.id));
 const pc=await get('public-config');assert.deepEqual([pc.data.signup,pc.data.billing],[true,true]);
});

test('paid → free → paid with requireFrom: both groups get the payment date, also a free period that ended earlier; bulk action',{skip},async()=>{
 let version=(await view()).version;
 let v=await save({version,payments:'free'});version=v.version;assert.equal(v.mode,'free');
 const lapsed=member('wygasly');fixture('billing',{userId:lapsed.id,billing_exempt:1,exempt_reason:'free-signup',exempt_at:now()-60*D,exempt_until:now()-30*D});
 const newB=member('nowyb'),a=member('grupaa2',{exempt:'free-signup'});
 // Not accounts of a free period: a subscriber who canceled in an earlier paid period and an account the Admin set to require payment.
 const canceled=member('anulowany');fixture('billing',{userId:canceled.id,livemode:0,sub_status:'canceled',stripe_subscription_id:'sub_'+uniq('anul'),current_period_end:now()-20*D});
 const required=member('wymagany');assert.equal((await admin.req('admin-billing-action',{action:'require',userId:required.id})).status,200);
 const before={canceled:row(canceled.id),required:row(required.id)};
 const set=fixture('settings-free-set');assert.ok(set.b.includes(lapsed.id)&&set.b.includes(newB.id)&&set.a.includes(a.id));
 for(const u of [canceled,required])assert.ok(!set.a.includes(u.id)&&!set.b.includes(u.id),u.email+' is not decided about as a free-period account');
 const r=await save({version,payments:'paid',confirmTestMode:true},409);assert.deepEqual(r.counts,{a:set.a.length,b:set.b.length});
 audit();v=await save({version,payments:'paid',confirmTestMode:true,freePeriod:{action:'requireFrom',date:day(20)}});assert.equal(v.mode,'paid');
 const from=row(a.id).exempt_until;
 assert.equal(warsawToday(new Date(from*1000)),day(20));assert.equal(warsawToday(new Date((from-1)*1000)),day(19),'00:00 Europe/Warsaw of the date');
 for(const u of [a,lapsed,newB]){const x=row(u.id);assert.deepEqual([x.billing_exempt,x.exempt_reason,x.exempt_until],[1,'free-signup',from],u.email);}
 for(const k of ['canceled','required'])assert.deepEqual(row({canceled,required}[k].id),before[k],k+': no free-signup exemption');
 const meX=(await get('me',(await signIn(canceled.email)).cookie)).data.access;assert.deepEqual([meX.full,meX.state],[false,'ended'],'the canceled subscriber pays again, as before the free period');
 const me=await get('me',(await signIn(lapsed.email)).cookie);assert.deepEqual([me.data.access.full,me.data.access.state,me.data.access.until],[true,'free',from]);
 assert.deepEqual(audit().map(x=>x.note),[`signup=on payments=paid organizers=on trustRequired=0 requireFrom:${day(20)} a=${set.a.length} b=${set.b.length} test`]);
 v=await view();assert.ok(v.freeSignups.scheduled.count>=set.a.length+set.b.length);assert.equal(v.freeSignups.scheduled.from,from);assert.equal(v.freeSignups.b,0);
 // The bulk action of the panel (admin-billing-action, scope free-signup): at least 14 days ahead, logged in the history;
 // while payments are required it changes group A only (no free period for an account without access, nor for a new one).
 const unpaid=member('niezaplacony');assert.equal(row(unpaid.id),null);
 let bulk=await admin.req('admin-billing-action',{action:'requireFrom',scope:'free-signup',date:day(13)});assert.deepEqual([bulk.status,bulk.data.error],[422,ERR.days]);
 bulk=await admin.req('admin-billing-action',{action:'requireFrom',scope:'free-signup',date:day(30)});assert.equal(bulk.status,200,JSON.stringify(bulk.data));
 assert.equal(bulk.data.count,bulk.data.a+bulk.data.b);assert.ok(bulk.data.a>=set.a.length+set.b.length);assert.equal(bulk.data.b,0);assert.equal(row(newB.id).exempt_until,bulk.data.from);
 assert.equal(row(unpaid.id),null);for(const k of ['canceled','required'])assert.deepEqual(row({canceled,required}[k].id),before[k],k+': untouched by the bulk action');
 assert.deepEqual(audit().map(x=>[x.action,x.note]),[['settings.freePeriod',`requireFrom:${day(30)} a=${bulk.data.a} b=${bulk.data.b}`]]);
 assert.equal((await view()).history[0].action,'settings.freePeriod');
});

test('degraded: payments paid in the database while config.php loses Stripe: sign-up closes, access opens, other fields can be saved',{skip},async()=>{
 const unpaid=member('bezdostepu');
 assert.deepEqual((await get('me',(await signIn(unpaid.email)).cookie)).data.access.full,false,'paid mode: no access without payment');
 await setConfig({billing_enabled:false,billing_enforce:false,signup_enabled:false},async()=>(await view()).effective.degraded,'billing-missing');
 let v=await view();assert.deepEqual([v.mode,v.payments,v.effective,v.stripe.enabled],['paid','paid',{mode:'off',degraded:'billing-missing'},false]);
 const pc=await get('public-config');assert.deepEqual([pc.data.signup,pc.data.billing],[false,false]);
 const [,closed]=await signupBegun();assert.equal(closed.status,404);
 const me=await get('me',(await signIn(unpaid.email)).cookie);assert.deepEqual([me.data.access.full,me.data.access.state],[true,'open'],'access fails open');
 audit();v=await save({version:v.version,supportEmail:' Biuro@Klub.TEST '});
 assert.deepEqual(v.support,{email:'biuro@klub.test',source:'db'});assert.equal((await get('public-config')).data.support,'biuro@klub.test');
 assert.deepEqual(audit().map(x=>[x.action,x.note]),[['settings.save','signup=on payments=paid organizers=on trustRequired=0'],['settings.support','pomoc@example.test -> biuro@klub.test']]);
 assert.equal((await save({version:v.version,supportEmail:''},422)).error,'Podaj poprawny e-mail.');
 v=await save({version:v.version,payments:'free'});
 const r=await save({version:v.version,payments:'paid',confirmTestMode:true,freePeriod:{action:'keep'}},409);assert.equal(r.code,'stripe_not_ready');
 await setConfig({billing_enabled:true,billing_enforce:true,signup_enabled:true},async()=>(await view()).stripe.enabled,true);
});

test('payments=paid in the database, billing_enforce=false in config.php: billing-sync, me and command agree on access',{skip},async()=>{
 fixture('settings-set',{data:{signup:'off',payments:'paid'},version:50});
 await setConfig({billing_enforce:false,signup_enabled:false,support_email:'plik@example.test'},async()=>(await view()).support.email,'plik@example.test');
 await admin.load();const email=uniq('klubplatny')+'@settings.test';
 const {id}=await admin.cmd('account.save',{email,password:PASSWORD,clubName:uniq('Klub Ustawień '),role:'club'});fixture('billing',{userId:id,billing_exempt:0});
 const club=new Client();await club.login(email,PASSWORD);
 const me=await get('me',club.cookie);assert.deepEqual([me.data.access.full,me.data.access.state,me.data.billing.enforce],[false,'none',true]);
 const sync=await club.req('billing-sync',{});assert.equal(sync.status,200,JSON.stringify(sync.data));assert.deepEqual([sync.data.access.full,sync.data.access.state],[false,'none']);
 const m=member('zgodny'),mc=await signIn(m.email);
 assert.equal((await get('me',mc.cookie)).data.access.full,false);assert.equal((await mc.req('billing-sync',{})).data.access.full,false);
 await setConfig({billing_enforce:true,signup_enabled:true,support_email:'pomoc@example.test'},async()=>(await view()).support.email,'pomoc@example.test');
});

// A TODO only while index.php has no overlay yet (slice accounts-backend): once it calls Settings::effective, the test is enforced.
const legacyOverlay=/Settings::effective\(/.test(readFileSync('backend/public/api/index.php','utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,''));
test('command of the legacy API uses the same effective configuration (index.php overlay, slice accounts-backend)',{skip,todo:legacyOverlay?false:'index.php computes Settings::effective in the slice accounts-backend'},async()=>{
 fixture('settings-set',{data:{signup:'off',payments:'paid'},version:51});
 await setConfig({billing_enforce:false,signup_enabled:false,support_email:'plik@example.test'},async()=>(await view()).support.email,'plik@example.test');
 try{
  await admin.load();const email=uniq('klubkomenda')+'@settings.test';
  const {id}=await admin.cmd('account.save',{email,password:PASSWORD,clubName:uniq('Klub Komend '),role:'club'});fixture('billing',{userId:id,billing_exempt:0});
  const club=new Client();await club.login(email,PASSWORD);
  const r=await club.req('command',{type:'profile.save',payload:{name:'Zawodnik Ustawień',birthDate:'2010-02-01',sex:'M',weight:60,height:170,gradeType:'cup',grade:6,events:['forms']},expectedRevision:club.data.revision});
  assert.equal(r.status,402,JSON.stringify(r.data));
 }finally{await setConfig({billing_enforce:true,signup_enabled:true,support_email:'pomoc@example.test'},async()=>(await view()).support.email,'pomoc@example.test');}
});

test('organizers paused and trustRequired are saved, audited and reach Domain through Settings::flags',{skip},async()=>{
 let v=await view();audit();
 v=await save({version:v.version,organizers:'paused',trustRequired:true});assert.deepEqual([v.organizers,v.trustRequired],['paused',true]);
 assert.match(audit()[0].note,/ organizers=paused trustRequired=1$/);
 const org=member('organizator');fixture('domain-organizer',{userId:org.id,organizer:true});
 const t={name:'Turniej Ustawień',city:'Opole',date:day(400),mat:'Mata 1',status:'open'};
 assert.deepEqual(fixture('domain-run',{actor:org.id,type:'tournament.save',payload:t}),{status:409,error:'Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.'},'the row wins over config.php');
 v=await save({version:v.version,organizers:'on',trustRequired:false});
 const ok=fixture('domain-run',{actor:org.id,type:'tournament.save',payload:{...t,status:'draft'}});assert.equal(ok.status,200,JSON.stringify(ok));
 assert.equal(ok.view.tournaments.find(x=>x.id===ok.result.id).trusted,true,'trustRequired=false: every organizer not blocked works as confirmed (§17)');
 assert.ok(v.history.some(h=>h.action==='settings.save'&&/organizers=paused/.test(h.note)));
});

test('history: actors by display name, club name or role label; never an e-mail or an internal id (§3.5 point 6, §11)',{skip},async()=>{
 await admin.load();const email=uniq('klubhistoria')+'@settings.test',clubName=uniq('Klub Historii ');
 const {id:club}=await admin.cmd('account.save',{email,password:PASSWORD,clubName,role:'club'});
 const {id:editor}=await admin.cmd('account.save',{email:uniq('redaktor')+'@settings.test',password:PASSWORD,clubName:uniq('Klub Redakcji '),role:'editor'});
 const named=member('nazwany',{profile:{firstName:'Marta',lastName:'Kowalska'}});
 const gone='u_'+uniq('usuniety');
 for(const [actor,note] of [[admin.id,'admin'],[editor,'editor'],[club,'club'],[named.id,'named'],[gone,'gone']])fixture('settings-audit-add',{actor,action:'settings.test',note});
 const h=Object.fromEntries((await view()).history.filter(x=>x.action==='settings.test').map(x=>[x.note,x.actor]));
 // The test Administrator may have a profile from an earlier file: then its display name, else the role label.
 assert.ok(h.admin==='Administrator'||/^\S+ \p{Lu}\.$/u.test(h.admin),h.admin);delete h.admin;
 assert.deepEqual(h,{editor:'Edytor',club:clubName,named:'Marta K.',gone:'Konto usunięte'});
 for(const x of (await view()).history)assert.ok(typeof x.actor==='string'&&!x.actor.includes('@')&&!/^[0-9a-f]{32}$/.test(x.actor),JSON.stringify(x));
});
