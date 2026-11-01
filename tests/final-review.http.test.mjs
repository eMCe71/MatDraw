// Fixes of the final multi-lens review of the roles release, backend group (run through scripts/test-http.sh: config.php with
// sign-up on, Stripe enabled and enforced in test mode, Stripe stub on port+1): B10 members gain roles only while sign-up is
// open, B2 the budget of member transactions, B1 saved draws against outside entries, B8 the revision floor of migration
// 0007, B4/B5/B16 the Stripe check against the current configuration and the test-mode confirmation, B6 signup_force_off and
// the invite token, B14 the organizer places of a network under parallel sign-ups; round 1 of the review: R1.1 erasures keep
// saved draws, R1.6 tournaments of deactivated or blocked organizers take no new entries. Every test puts back what it changed.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client,base,fixture} from './helpers/http-client.mjs';
import {categories} from '../dist/engine.js';
const shared=process.env.MATDRAW_TEST_SHARED_DIR,skip=!base||!shared,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const stubBase=base?`http://127.0.0.1:${Number(new URL(base).port)+1}`:'';
const stub=async body=>{const r=await fetch(stubBase+'/__control',{method:'POST',body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;};
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
const now=()=>Math.floor(Date.now()/1000);
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const sid=c=>c.cookie.split('=')[1];
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
async function signIn(email,password=PASSWORD){const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));c.id=r.data.user.id;return c;}
const admin=async()=>{const c=await signIn(...ADMIN);await c.load();return c;};
/** A member with a complete profile and full access; organizer: users.organizer=1. */
function member(prefix,{organizer=false}={}){
 const email=uniq(prefix)+'@review.test',m=fixture('member',{email,profile:true,exempt:true});
 if(organizer)fixture('domain-organizer',{userId:m.id,organizer:true});
 return {...m,email};
}
const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']},E={events:['forms'],weight:70,height:175,gradeType:'cup',grade:5};
const T=(over={})=>({name:'Turniej Przeglądu',city:'Opole',date:day(30),mat:'Mata 1',status:'open',...over});
const athleteBody=(over={})=>({relation:'self',name:'Ola Nowak',birthDate:'1990-05-05',sex:'F',weight:60,height:168,gradeType:'cup',grade:6,club:{none:true},...over});
const command=(c,type,payload,revision=c.data.revision)=>c.req('command',{type,payload,expectedRevision:revision});
const error=(r,status,message)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(message)assert.equal(r.data.error,message);return r.data;};
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
/** A member with an own adult athlete profile (domain-run: as the athlete routes run it); returns {…member, profileId}. */
function athlete(prefix){
 const m=member(prefix),r=fixture('domain-run',{actor:m.id,type:'athlete.save',payload:athleteBody({name:'Zawodnik '+uniq('z'),sex:'M',birthDate:'1995-04-04',weight:70,height:175,grade:5})});
 assert.equal(r.status,200,JSON.stringify(r));return {...m,profileId:r.result.id};
}
async function guest(route){const r=await fetch(base+'?route='+route,{headers:{'X-MatBravo-Client':'1'}});return {status:r.status,data:await r.json()};}
/** A session that started the sign-up form 10 s ago (server-measured time). */
async function begun(body={}){const c=await fresh();const r=await c.req('signup-begin',body);if(r.status===200)fixture('session-edit',{sid:sid(c),set:{signup_at:now()-10}});return [c,r];}
const signupBody=(over={})=>({email:uniq('rej')+'@review.test',password:PASSWORD,firstName:'Ola',lastName:'Nowak',username:uniq('ola'),country:'PL',sports:['taekwondo'],clubText:null,showClub:false,website:'',...over});
const CLOSED='Rejestracja jest chwilowo wyłączona.',BUSY='Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.',OWN='Zbyt wiele operacji. Spróbuj ponownie za chwilę.';
const original={};
/** Rewrites keys of config.php (settings-config) and remembers the first old value of each for after(). */
function setConfig(set){const old=fixture('settings-config',{set});for(const k of Object.keys(old))if(!(k in original))original[k]=old[k];}

before(async()=>{if(skip)return;fixture('reset-limits');fixture('settings-reset');await stub({op:'clear-faults'});});
beforeEach(()=>fixture('reset-limits'));
after(async()=>{if(skip)return;await stub({op:'clear-faults'});fixture('settings-reset');if(Object.keys(original).length)fixture('settings-config',{set:original});fixture('reset-limits');});

test('B10: while sign-up is off members gain no roles (organizer, a new athlete profile) and nothing is written; existing roles keep working',{skip},async()=>{
 // The state right after the deploy: no switch opened (here a stored row with sign-up off, which wins over the test config.php).
 fixture('settings-set',{data:{signup:'off',payments:'free'}});
 try{
  const plain=member('b10'),c=await signIn(plain.email);
  const f=ok(await c.req('me')).features;assert.deepEqual([f.signupMode,f.rolesOpen],['off',false]);
  assert.equal((await guest('public-config')).data.rolesOpen,false);
  error(await c.req('roles',{organizer:true}),403,CLOSED);
  error(await c.req('athlete-save',athleteBody({club:{name:'Klub '+uniq('k')}})),403,CLOSED);
  const st=fixture('roles-user',{email:plain.email});
  assert.deepEqual([st.user.organizer,st.profiles.length,st.clubs.length],[0,0,0],'no organizer role, owned profile or club: nothing the 0007 floor counts (the rollback stays possible)');
  // An organizer from before keeps his tools and may switch the role off, but not on again while sign-up is off.
  const o=member('b10org',{organizer:true}),oc=await signIn(o.email);await oc.load();
  const t=(await oc.cmd('tournament.save',T({name:'Turniej Istniejącego Organizatora'}))).id;await oc.cmd('tournament.save',T({name:'Turniej Istniejącego Organizatora',id:t,status:'draft'}));
  assert.equal(ok(await oc.req('roles',{organizer:false})).caps.organizer,false);
  error(await oc.req('roles',{organizer:true}),403,CLOSED);
  // An athlete from before edits his profile and enters and withdraws.
  const a=await admin(),open=(await a.cmd('tournament.save',{...T({name:'Turniej Zawodnika B10'}),selfEntry:true})).id,x=athlete('b10ath'),xc=await signIn(x.email);
  assert.equal(ok(await xc.req('athlete-save',{...athleteBody({sex:'M',birthDate:'1995-04-04',weight:71,height:175,grade:5}),id:x.profileId,name:'Zawodnik Poprawiony'})).profile.name,'Zawodnik Poprawiony');
  ok(await xc.req('athlete-entry',{tournamentId:open,profileId:x.profileId,events:['forms']}));ok(await xc.req('athlete-withdraw',{tournamentId:open,profileId:x.profileId}));
  // Opening sign-up opens the roles.
  fixture('settings-set',{data:{signup:'on',payments:'free'}});
  assert.equal(ok(await c.req('me')).features.rolesOpen,true);assert.equal(ok(await c.req('roles',{organizer:true})).caps.organizer,true);
  assert.equal(ok(await c.req('athlete-save',athleteBody())).caps.athlete,true);
 }finally{fixture('settings-reset');}
});

test('B2: two organizers flooding junk commands use up neither the global bucket nor anybody else\'s budget; withdrawing is never refused',{skip},async()=>{
 const a=await admin(),t=(await a.cmd('tournament.save',{...T({name:'Turniej Rodzica B2'}),selfEntry:true})).id;
 const g=athlete('b2rodzic');assert.equal(fixture('domain-run',{actor:g.id,type:'entry.self',payload:{tournamentId:t,profileId:g.profileId,events:['forms']}}).status,200);
 const gc=await signIn(g.email);
 const h=member('b2uczciwy',{organizer:true}),hc=await signIn(h.email);await hc.load();const ht=(await hc.cmd('tournament.save',T({name:'Turniej Uczciwy'}))).id;
 const flood=[];for(const prefix of ['b2junka','b2junkb']){const c=await signIn(member(prefix,{organizer:true}).email);await c.load();flood.push(c);}
 // 2 × 60 commands within the minute (the per-account limit of commands), each refused by Domain (an empty payload).
 const junk=await Promise.all(flood.flatMap(c=>Array.from({length:60},()=>command(c,'tournament.save',{}))));
 const counts={};for(const r of junk)counts[r.status]=(counts[r.status]??0)+1;
 assert.ok(!counts[200],'nothing was saved: '+JSON.stringify(counts));
 assert.equal(junk.filter(r=>r.status===429).every(r=>r.data.error===OWN),true,'only the flooding accounts\' own budget (30 transactions a minute) runs out');
 assert.equal(counts[429],60,'30 refused per flooding account: '+JSON.stringify(counts));
 // Everybody else goes on: the honest organizer's command, the guardian's correction and withdrawal.
 await hc.load();assert.equal((await command(hc,'tournament.save',T({name:'Turniej Uczciwy',id:ht,city:'Kielce'}))).status,200,'another organizer is not refused');
 ok(await gc.req('athlete-save',{...athleteBody({sex:'M',birthDate:'1995-04-04',weight:72,height:175,grade:5}),id:g.profileId,name:'Zawodnik B2'}));
 ok(await gc.req('athlete-withdraw',{tournamentId:t,profileId:g.profileId}));
 // A full global bucket refuses new writes of members, never a withdrawal.
 assert.equal(fixture('domain-run',{actor:g.id,type:'entry.self',payload:{tournamentId:t,profileId:g.profileId,events:['forms']}}).status,200);
 fixture('roles-bucket',{scope:'member-tx',key:'all',attempts:120});
 error(await gc.req('athlete-save',{...athleteBody({sex:'M',birthDate:'1995-04-04',weight:73,height:175,grade:5}),id:g.profileId,name:'Zawodnik B2'}),429,BUSY);
 ok(await gc.req('athlete-withdraw',{tournamentId:t,profileId:g.profileId}));
});

test('B1: an organizer entering into or withdrawing from a drawn category of the Administrator\'s tournament gets 409; the draw stays',{skip},async()=>{
 const a=await admin(),t=(await a.cmd('tournament.save',{...T({name:'Turniej z Losowaniem'}),selfEntry:true})).id;
 const o=member('b1org',{organizer:true}),oc=await signIn(o.email);await oc.load();
 const own=(await oc.cmd('profile.save',{...A,name:'Zawodnik Organizatora',club:{none:true}})).id;await oc.cmd('entry.save',{...E,tournamentId:t,profileId:own});
 await a.load();for(const name of ['Adam Personel','Bartek Personel','Cezary Personel'])await a.cmd('profile.save',{...A,name:name+' '+uniq('p'),clubName:'Klub Losowania '+name,registration:{...E,tournamentId:t}});
 await a.load();const tour=a.data.tournaments.find(x=>x.id===t),key=categories(tour.entries).items.find(c=>c.type==='bracket').id;
 await a.cmd('draw.create',{tournamentId:t,categoryId:key});
 await oc.load();
 error(await command(oc,'entry.remove',{tournamentId:t,id:own}),409,'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.');
 const fake=(await oc.cmd('profile.save',{...A,name:'Obcy Zawodnik',club:{none:true}})).id;
 error(await command(oc,'entry.save',{...E,tournamentId:t,profileId:fake}),409,'Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.');
 error(await command(oc,'entry.save',{...E,tournamentId:t,profileId:own,update:true,weight:71}),409,'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.');
 await a.load();assert.deepEqual(Object.keys(a.data.tournaments.find(x=>x.id===t).draws),[key],'the saved draw is still there');
 // The manager still changes the category (and with it the draw), as before.
 await a.cmd('entry.remove',{tournamentId:t,id:own});assert.deepEqual(Object.keys(a.data.tournaments.find(x=>x.id===t).draws),[]);
});

// Round 1 of the review, R1.1: erasures (profile.forget, athlete-forget, account deletion) are no way around the rule of B1.
test('R1.1: forgetting a profile or deleting the account keeps the Administrator\'s saved draw; the entries stay as initials',{skip},async()=>{
 const a=await admin(),t=(await a.cmd('tournament.save',{...T({name:'Turniej Wymazań'}),selfEntry:true})).id;
 const o=member('r11org',{organizer:true}),oc=await signIn(o.email);await oc.load();
 const fake=(await oc.cmd('profile.save',{...A,name:'Fikcyjny Zawodnik',club:{none:true}})).id,twin=(await oc.cmd('profile.save',{...A,name:'Drugi Fikcyjny',club:{none:true}})).id;
 for(const id of [fake,twin])await oc.cmd('entry.save',{...E,tournamentId:t,profileId:id});
 const x=athlete('r11ath');ok(await (await signIn(x.email)).req('athlete-entry',{tournamentId:t,profileId:x.profileId,events:['forms']}));
 await a.load();for(const name of ['Adam Wymazań','Bartek Wymazań'])await a.cmd('profile.save',{...A,name:name+' '+uniq('p'),clubName:'Klub '+name,registration:{...E,tournamentId:t}});
 await a.load();const key=categories(a.data.tournaments.find(y=>y.id===t).entries).items.find(c=>c.type==='bracket').id;await a.cmd('draw.create',{tournamentId:t,categoryId:key});
 const draws=async()=>{await a.load();return Object.keys(a.data.tournaments.find(y=>y.id===t).draws);},names=()=>Object.fromEntries(fixture('roles-entries',{tournamentId:t}).map(e=>[e.profileId,e.snapshot.name]));
 await oc.load();error(await command(oc,'entry.remove',{tournamentId:t,id:fake}),409,'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.');
 assert.equal(ok(await command(oc,'profile.forget',{id:fake})).result.state,'anonymized','the erasure works');
 assert.deepEqual(await draws(),[key],'profile.forget: the draw stays');assert.equal(names()[fake],'F. Z.');
 const xc=await signIn(x.email);ok(await xc.req('athlete-forget',{profileId:x.profileId,password:PASSWORD}));
 assert.deepEqual(await draws(),[key],'athlete-forget: the draw stays');assert.match(names()[x.profileId],/^Z\. \S\.$/u);
 ok(await (await signIn(o.email)).req('account-delete',{password:PASSWORD}));
 assert.deepEqual(await draws(),[key],'account deletion of the organizer: the draw stays');assert.ok(twin in names(),'his other athlete stays in the drawn category');
 // The Administrator manages the tournament: his change drops the draw as before.
 await a.cmd('entry.remove',{tournamentId:t,id:twin});assert.deepEqual(await draws(),[]);
});

// R1.6: a tournament of an organizer the Administrator deactivated or blocked (without hiding it) takes no new entries from outside.
test('R1.6: no self-entries into tournaments of a deactivated or blocked organizer; back after reactivation; withdrawing works',{skip},async()=>{
 const a=await admin(),o=member('r16org',{organizer:true}),oc=await signIn(o.email);await oc.load();
 const t=(await oc.cmd('tournament.save',{...T({name:'Turniej Wyłączonego'}),selfEntry:true})).id;
 const x=athlete('r16ath'),xc=await signIn(x.email),y=athlete('r16in'),yc=await signIn(y.email);ok(await yc.req('athlete-entry',{tournamentId:t,profileId:y.profileId,events:['forms']}));
 const enter=()=>xc.req('athlete-entry',{tournamentId:t,profileId:x.profileId,events:['forms']}),CLOSED_T='Zapisy do tego turnieju są zamknięte.';
 assert.deepEqual(ok(await a.req('admin-member',{action:'active',userId:o.id,active:false})),{id:o.id,active:false});
 error(await enter(),403,CLOSED_T);
 ok(await yc.req('athlete-withdraw',{tournamentId:t,profileId:y.profileId}));
 ok(await a.req('admin-member',{action:'active',userId:o.id,active:true}));
 ok(await enter());ok(await xc.req('athlete-withdraw',{tournamentId:t,profileId:x.profileId}));
 ok(await a.req('admin-member',{action:'organizer',userId:o.id,blocked:true}));
 error(await enter(),403,CLOSED_T);
 ok(await a.req('admin-member',{action:'organizer',userId:o.id,blocked:false}));ok(await enter());
});

test('B8: a command based on a revision from before migration 0007 is stale even for objects never stamped since',{skip},async()=>{
 const a=await admin(),t=(await a.cmd('tournament.save',T({name:'Turniej Sprzed Migracji'}))).id,old=a.data.revision;
 await a.cmd('tournament.save',T({name:'Inny Turniej'}));// the global revision moves on, t is not touched
 const floor=fixture('domain-rev-floor',{now:true});
 try{
  assert.ok(old<floor.floor);
  error(await command(a,'tournament.save',T({name:'Turniej Sprzed Migracji',id:t,status:'closed'}),old),409,'Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.');
  await a.load();assert.equal(a.data.tournaments.find(x=>x.id===t).status,'open','nothing overwritten');
  assert.equal((await command(a,'tournament.save',T({name:'Turniej Sprzed Migracji',id:t,status:'closed'}),floor.floor)).status,200,'from the migration on: the scoped rule');
 }finally{fixture('domain-rev-floor',{floor:floor.old});}
});

test('B4, B5, B16: paid mode runs only against the Stripe configuration a check passed for; opening the paid sign-up in test mode needs the confirmation',{skip},async()=>{
 const c=await admin(),view=async()=>ok(await c.req('admin-settings')),save=async(body,status=200)=>{const r=await c.req('admin-settings-save',body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 const check=async(status=200)=>{const r=await c.req('admin-stripe-check',{});assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 const state=async()=>{const v=await view(),pc=(await guest('public-config')).data;return [v.effective.mode,v.effective.degraded,v.stripeCheck.ok,v.stripeCheck.stale,pc.signupMode,pc.billing];};
 let unpaid=null;const access=async()=>ok(await (await signIn(unpaid.email)).req('me')).access.full;
 try{
  let v=await view();assert.deepEqual(v.stripeCheck,{ok:false,stale:false,checkedAt:null,mode:null},'never checked');
  v=await save({version:v.version,payments:'free'});
  // The test window: payments on with sign-up off, test mode confirmed (allowTestMode, the new name of confirmTestMode).
  let r=await save({version:v.version,signup:'off',payments:'paid',freePeriod:{action:'keep'}},409);assert.deepEqual([r.code,r.confirmTestMode],['test_mode',true]);
  v=await save({version:v.version,signup:'off',payments:'paid',allowTestMode:true,freePeriod:{action:'keep'}});
  assert.deepEqual([v.mode,v.effective.mode,v.stripeCheck.ok,v.stripeCheck.stale,v.stripeCheck.mode],['off','off',true,false,'test']);assert.match(v.stripeCheck.checkedAt,/^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!('fp' in v.stripe.check),'the fingerprint stays on the server');
  unpaid=member('b4bez');fixture('billing',{userId:unpaid.id,billing_exempt:0});assert.equal(await access(),false,'payments enforced');
  // B5: opening the paid sign-up while Stripe is in test mode asks again.
  r=await save({version:v.version,signup:'on'},409);assert.deepEqual([r.code,r.confirmTestMode,r.error],['test_mode',true,'Stripe działa w trybie testowym: nikt nie zapłaci prawdziwymi pieniędzmi. Potwierdź, jeśli to zamierzone.']);
  assert.equal((await guest('public-config')).data.signupMode,'off','still closed');
  v=await save({version:v.version,signup:'on',allowTestMode:true});assert.deepEqual(await state(),['paid',null,true,false,'paid',true]);
  // B4: config.php changes after the check (here the advertised amount; the switch to live keys works the same way).
  const amounts=fixture('billing-config-set',{set:{billing_amounts:{pln:1299,usd:299}}});
  try{
   assert.deepEqual(await state(),['off','stripe-check',true,true,'off',false],'sign-up closed, enforcement lifted, the panel says why');
   assert.equal(await access(),true,'access fails open');
   // B16: the check compares the Stripe price with the amount guests see.
   r=await check(409);assert.deepEqual([r.code,r.stripeCheck.ok,r.stripeCheck.error,r.stripeCheck.prices],['stripe_not_ready',false,'amount_mismatch',{pln:false,usd:true}]);
   assert.deepEqual(await state(),['off','stripe-check',false,false,'off',false]);
  }finally{fixture('billing-config-set',{set:amounts});}
  assert.deepEqual(await state(),['off','stripe-check',false,true,'off',false],'back to the old amounts: the failed check still counts');
  r=await check();assert.deepEqual([r.stripeCheck.ok,r.stripeCheck.error],[true,null]);assert.deepEqual(await state(),['paid',null,true,false,'paid',true],'a fresh check opens it again');
  // A rotated key: stale until checked.
  setConfig({stripe_secret_key:'rk_'+'test_'+'rotated'});
  assert.deepEqual(await state(),['off','stripe-check',true,true,'off',false]);r=await check();assert.deepEqual(await state(),['paid',null,true,false,'paid',true]);
  // A failed manual check (Stripe refuses the key) takes the passed one back.
  await stub({op:'fault',method:'GET',path:'^/v1/prices',status:401,type:'invalid_request_error',times:4});
  r=await check(503);assert.equal(r.code,'stripe_unavailable');
  await stub({op:'clear-faults'});
  v=await view();assert.deepEqual([v.stripe.check.error,v.effective.degraded,v.stripeCheck.ok],['auth','stripe-check',false]);assert.equal((await guest('public-config')).data.signupMode,'off');
  await check();assert.deepEqual(await state(),['paid',null,true,false,'paid',true]);
 }finally{await stub({op:'clear-faults'});fixture('settings-reset');if('stripe_secret_key' in original)fixture('settings-config',{set:{stripe_secret_key:original.stripe_secret_key}});}
});

test('B6: signup_force_off closes the invite path of the paid test window too',{skip},async()=>{
 const token='tok'+'0123456789abcdefghijklmnop';
 fixture('settings-set',{data:{signup:'off',payments:'paid'}});setConfig({signup_invite_token:token});
 try{
  let [c,r]=await begun({invite:token});assert.equal(r.status,200,'the test window works with the token');
  assert.equal((await c.req('signup',signupBody({invite:token}))).status,200);
  setConfig({signup_force_off:true});
  [c,r]=await begun({invite:token});error(r,404,CLOSED);
  fixture('session-edit',{sid:sid(c),set:{signup_at:now()-10}});error(await c.req('signup',signupBody({invite:token})),404,CLOSED);
  const v=ok(await (await admin()).req('admin-settings'));assert.deepEqual(v.effective,{mode:'off',degraded:'force-off'},'the panel shows the emergency close');
 }finally{setConfig({signup_force_off:false,signup_invite_token:null});fixture('settings-reset');}
});

test('B14: parallel sign-ups with the organizer role from one network: exactly 3 of them get it',{skip},async()=>{
 const sessions=[];for(let i=0;i<10;i++){const [c,r]=await begun();assert.equal(r.status,200);sessions.push(c);}
 const out=await Promise.all(sessions.map(c=>c.req('signup',signupBody({roles:{organizer:true}}))));
 const statuses=out.map(r=>r.status).sort();
 assert.equal(out.filter(r=>r.status===200&&r.data.caps?.organizer===true).length,3,JSON.stringify(statuses));
 assert.ok(out.filter(r=>r.status!==200).every(r=>r.status===429&&r.data.error==='Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.'),JSON.stringify(statuses));
 // A sign-up that fails after the reservation gives its place back: after two failures the network still has 3 places.
 fixture('reset-limits');
 for(const bad of [{password:'short'},{email:'not an e-mail'}]){const [c]=await begun();assert.equal((await c.req('signup',signupBody({roles:{organizer:true},...bad}))).status,422);}
 for(let i=0;i<3;i++){const [c]=await begun();assert.equal(ok(await c.req('signup',signupBody({roles:{organizer:true}}))).caps.organizer,true,'place '+(i+1));}
});
