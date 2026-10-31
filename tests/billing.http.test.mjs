// Payments over real PHP, MariaDB/MySQL and the Stripe stub (plan §11, §12.8; report 03 §14.2). Run through
// scripts/test-http.sh, which starts tests/stubs/stripe-stub.mjs on <port+1> and writes billing_enabled/enforce=true,
// billing_mode test, rk_test_stub and whsec_test_secret into the test config.
// Scenarios: no full access without payment; checkout (currency from the country, never from the client; Customer with
// its Idempotency-Key; a double click reuses the session; 422 without a country); confirm (foreign or malformed session
// 403, open/expired/incomplete/active, 409 {portal:true} afterwards); staff 402 until paid; Portal; billing-sync and its
// 10 s limit; past_due with grace and its end (billing-due through bin/cron.php); requireFrom → grace → none and the
// grandfathered scope; webhook (valid, duplicate, bad signature, stale timestamp, livemode, bad JSON, unknown type,
// processing failure → 500 then retry, 404 without secrets); /v1/events pull without double processing (stripe-sync.php)
// and forward from the cursor (more than one page, time budget, one fetch per object, a refused event skipped, 429 stops,
// unknown cursor, an event listed late behind the cursor and the 120 s margin); subscription precedence (reconcile and a
// late event about an old canceled subscription); Admin tools with audit (exempt + warnLive, require, cancelAtPeriodEnd,
// currency, resync); no second subscription next to an incomplete one or a session paid elsewhere (also while another
// sync holds the claim), and 'sub.multiple' for two ongoing ones; two parallel syncs = one Stripe call; circuit breaker
// after a network error; account deletion (DELETE /v1/customers, failure → stripe_redact_pending →
// billing-due retry, tombstone) and refused deletions that cannot starve billing-due; e-mail pushed to Stripe and
// corrected by sync; 503 when Stripe fails, transparent retry of one 500; a new customer for another currency
// (Customer.currency first, Stripe's refusal as the fallback); and every request the app sent carried the pinned
// Stripe-Version, Bearer rk_test_stub and (POST) an Idempotency-Key.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client,base,eventually,fixture,php} from './helpers/http-client.mjs';
const release=process.env.MATDRAW_TEST_RELEASE,skip=!base||!release;
const fixtureScript=fileURLToPath(new URL('./helpers/fixture.php',import.meta.url));
const stubBase=base?`http://127.0.0.1:${Number(new URL(base).port)+1}`:'';
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!',VERSION='2026-09-30.endive',SECRET='whsec_test_secret';
const ERR={unavailable:'Płatności są chwilowo niedostępne. Spróbuj ponownie później.',confirm:'Nie można potwierdzić tej płatności.'};
const now=()=>Math.floor(Date.now()/1000),D=86400;
/** Polls until the server answers `expected` (e.g. after a config rewrite; scripts/test-http.sh re-validates config.php on every request). */
async function until(probe,expected,ms=8000){let v;for(const end=Date.now()+ms;Date.now()<end;await sleep(250))if((v=await probe())===expected)break;return v;}
const stub=async body=>{const r=await fetch(stubBase+'/__control',{method:'POST',body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;};
/** Stub requests recorded since a marker (Date.now() before the action), optionally filtered by method and path regex. */
const since=async(t,method,re)=>(await stub({op:'requests'})).filter(x=>x.at>=t&&(!method||x.method===method)&&(!re||re.test(x.path)));
const prices=async()=>{const s=await stub({op:'state'});return Object.fromEntries(Object.values(s.prices).filter(p=>p.lookup_key).map(p=>[p.lookup_key,p.id]));};
let seq=0;const email=tag=>`billing.${tag}.${process.pid}.${++seq}@test.example`;
async function signIn(address,password=PASSWORD){const c=new Client();await c.req('session');const r=await c.req('login',{email:address,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
async function me(c){const r=await c.req('me');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
function member(tag,profile={country:'PL'},extra={}){const address=email(tag);return {...fixture('member',{email:address,password:PASSWORD,profile,...extra}),email:address};}
const sessionOf=url=>new URL(url).pathname.split('/').pop();
/** A member who has paid: checkout, the stub completes the session, confirm → active. */
async function paidMember(tag,country='PL',status='active'){
 const m=member(tag,{country});const c=await signIn(m.email);
 const r=await c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 const sessionId=sessionOf(r.data.url);const sub=await stub({op:'pay',sessionId,status});
 const ok=await c.req('billing-confirm',{sessionId});assert.equal(ok.status,200,JSON.stringify(ok.data));
 return {...m,c,sessionId,sub:sub.id,customer:sub.customer};
}
const row=userId=>fixture('billing-row',{userId});
const audit=(userId,action)=>fixture('billing-audit',{userId,...(action?{action}:{})});
const run=(fn,extra={})=>fixture('billing-run',{fn,...extra});
function cli(script,args=[]){const r=spawnSync(php,[path.join(release,'backend/bin',script),...args],{encoding:'utf8',env:process.env});return {code:r.status,out:r.stdout,err:r.stderr};}
const event=(type,object,o={})=>({id:'evt_'+crypto.randomBytes(9).toString('hex'),object:'event',api_version:VERSION,type,livemode:false,created:now(),data:{object},...o});
async function webhook(ev,{secret=SECRET,t=now(),header,raw,method='POST'}={}){
 const body=raw??JSON.stringify(ev);const sig=header??`t=${t},v1=${crypto.createHmac('sha256',secret).update(t+'.'+body).digest('hex')}`;
 const r=await fetch(base+'?route=stripe-webhook',{method,headers:{'Content-Type':'application/json','Stripe-Signature':sig},...(method==='POST'?{body}:{})});
 const text=await r.text();let data=null;try{data=JSON.parse(text);}catch{data={raw:text};}
 return {status:r.status,data,headers:r.headers};
}
let admin;
/** A club account created by the Admin (workspace reloaded first: other sessions change the revision). */
async function staff(address,clubName){await admin.load();return admin.cmd('account.save',{email:address,password:PASSWORD,clubName,role:'club'});}
before(async()=>{if(skip)return;fixture('reset-limits');fixture('billing-kv',{set:{stripe_down_until:null}});admin=new Client();await admin.login(...ADMIN);});

test('without payment a member has no full access; checkout takes the currency from the country and reuses an open session',{skip},async()=>{
 const pl=member('pl'),c=await signIn(pl.email),keys=await prices();
 let m=await me(c);
 assert.deepEqual([m.access.full,m.access.state,m.access.block],[false,'none','payment']);
 assert.deepEqual([m.billing.enabled,m.billing.enforce,m.billing.currency,m.billing.hasCustomer,m.billing.pending],[true,true,'pln',false,false]);
 const t=Date.now();
 // The client cannot choose currency, amount or price: those fields are ignored.
 const r=await c.req('billing-checkout',{currency:'usd',amount:1,price:keys.matbravo_monthly_usd,lang:'pl'});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(Object.keys(r.data),['url']);
 assert.match(r.data.url,/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_[A-Za-z0-9]{24}$/);
 const [cus]=await since(t,'POST',/^\/v1\/customers$/);
 assert.deepEqual(cus.body,{email:pl.email,preferred_locales:['pl'],metadata:{matbravo_user_id:pl.id,matbravo_env:'test'}});
 assert.equal(cus.idempotencyKey,`matbravo-customer-${pl.id}-test-0`);
 const [cs]=await since(t,'POST',/^\/v1\/checkout\/sessions$/);const b=cs.body,app=new URL(base).origin;
 assert.equal(b.line_items[0].price,keys.matbravo_monthly_pln,'PLN for a profile in Poland');assert.equal(b.line_items[0].quantity,'1');
 assert.deepEqual([b.mode,b.customer,b.client_reference_id,b.locale,b.billing_address_collection],['subscription',row(pl.id).stripe_customer_id,pl.id,'pl','required']);
 assert.match(b.customer,/^cus_/);
 assert.deepEqual([b.success_url,b.cancel_url],[`${app}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,`${app}/?billing=cancel`]);
 assert.deepEqual(b.subscription_data.metadata,{matbravo_user_id:pl.id});assert.deepEqual(b.customer_update,{address:'auto',name:'auto'});
 assert.ok(!('payment_method_types' in b)&&!('currency' in b)&&!('allow_promotion_codes' in b));
 assert.ok(Math.abs(Number(b.expires_at)-(now()+3600))<30);
 const saved=row(pl.id);assert.deepEqual([saved.pending_checkout_id,saved.currency,saved.livemode],[sessionOf(r.data.url),'pln',0]);
 m=await me(c);assert.deepEqual([m.billing.hasCustomer,m.billing.pending],[true,true]);
 // A double click: the same open session, read back instead of created again.
 const t2=Date.now();const again=await c.req('billing-checkout',{});assert.equal(again.data.url,r.data.url);
 assert.deepEqual((await since(t2)).map(x=>[x.method,x.path]),[['GET','/v1/checkout/sessions/'+sessionOf(r.data.url)]]);
 // Any other country pays in USD; without a country the plan asks for one first.
 const de=member('de',{country:'DE'}),cd=await signIn(de.email);const t3=Date.now();
 assert.equal((await cd.req('billing-checkout',{currency:'pln'})).status,200);
 assert.equal((await since(t3,'POST',/^\/v1\/checkout\/sessions$/))[0].body.line_items[0].price,keys.matbravo_monthly_usd);
 const none=member('nocountry',false),cn=await signIn(none.email);const t4=Date.now();
 const nc=await cn.req('billing-checkout',{});assert.equal(nc.status,422);assert.equal(nc.data.error,'Wybierz kraj w profilu, aby wybrać plan.');assert.ok(nc.data.csrf);
 assert.deepEqual(await since(t4),[],'nothing is sent to Stripe before the plan can be chosen');
 const audits=audit(pl.id).map(a=>a.action);assert.ok(audits.includes('customer.create')&&audits.includes('checkout.create'));
 assert.ok(!JSON.stringify(audit(pl.id)).includes('@'),'no e-mail in billing_audit');
});

test('confirm: foreign or malformed sessions answer 403; open, paid and expired sessions; then checkout sends to the Portal',{skip},async()=>{
 const a=member('confirm-a'),ca=await signIn(a.email),b=member('confirm-b'),cb=await signIn(b.email);
 const sa=sessionOf((await ca.req('billing-checkout',{})).data.url);await cb.req('billing-checkout',{});
 for(const sessionId of [sa,'cs_test_short','cs_live_'+'x'.repeat(5),'../cs_test_aaaaaaaaaaaa',123,null]){
  const r=await cb.req('billing-confirm',{sessionId});assert.equal(r.status,403,String(sessionId));assert.equal(r.data.error,ERR.confirm);
 }
 const nobody=member('confirm-none'),cn=await signIn(nobody.email);
 assert.equal((await cn.req('billing-confirm',{sessionId:sa})).status,403,'no customer at all');
 const open=await ca.req('billing-confirm',{sessionId:sa});assert.equal(open.status,200);assert.equal(open.data.status,'open');assert.equal(open.data.access.full,false);
 await stub({op:'pay',sessionId:sa});
 const ok=await ca.req('billing-confirm',{sessionId:sa});assert.equal(ok.status,200,JSON.stringify(ok.data));
 assert.deepEqual(Object.keys(ok.data),['access','billing','status']);assert.equal(ok.data.status,'active');
 assert.deepEqual([ok.data.access.full,ok.data.access.state],[true,'active']);assert.ok(ok.data.access.until>now()+25*D);
 assert.deepEqual([ok.data.billing.hasCustomer,ok.data.billing.pending,ok.data.billing.currency],[true,false,'pln']);
 const r=row(a.id);assert.deepEqual([r.sub_status,r.price_lookup_key,r.latest_invoice_status,r.pending_checkout_id,r.currency],['active','matbravo_monthly_pln','paid',null,'pln']);
 assert.ok(r.next_sync_at>now()+6*D&&r.next_sync_at<=now()+7*D+5,'paid: next look after period end + 2 h, capped at 7 days');
 const m=await me(ca);assert.deepEqual([m.access.full,m.access.state],[true,'active']);assert.notEqual(m.access.block,'payment');
 assert.deepEqual(audit(a.id,'status.change').map(x=>[x.old_status,x.new_status,x.actor]),[['none','active',a.id]]);
 const again=await ca.req('billing-checkout',{});assert.equal(again.status,409);assert.deepEqual([again.data.error,again.data.portal],['Masz już aktywną subskrypcję.',true]);
 // Portal: the stored customer, our return URL and the configured configuration; the client checks the origin.
 const t=Date.now();const p=await ca.req('billing-portal',{lang:'en'});assert.equal(p.status,200);assert.match(p.data.url,/^https:\/\/billing\.stripe\.com\/p\/session\//);
 const [ps]=await since(t,'POST',/^\/v1\/billing_portal\/sessions$/);
 assert.deepEqual(ps.body,{customer:r.stripe_customer_id,return_url:new URL(base).origin+'/?billing=portal',locale:'en',configuration:'bpc_stub'});
 const np=await cn.req('billing-portal',{});assert.equal(np.status,409);assert.equal(np.data.error,'Najpierw wybierz plan.');
 // An expired session: confirm says so and the pending checkout is cleared.
 const e=member('confirm-expired'),ce=await signIn(e.email);const se=sessionOf((await ce.req('billing-checkout',{})).data.url);
 await stub({op:'expire-session',sessionId:se});const ex=await ce.req('billing-confirm',{sessionId:se});
 assert.deepEqual([ex.status,ex.data.status,row(e.id).pending_checkout_id],[200,'expired',null]);
});

test('staff without a free account: preview only (402) until the payment is confirmed',{skip},async()=>{
 const address=email('staff');const {id}=await staff(address,'Klub Płacący');
 fixture('billing',{userId:id,billing_exempt:0});fixture('billing-country',{userId:id,country:'PL'});
 const c=new Client();await c.login(address,PASSWORD);
 const athlete={name:'Zawodnik Opłacony',birthDate:'2010-02-01',sex:'M',weight:60,height:170,gradeType:'cup',grade:6,events:['forms']};
 const denied=await c.req('command',{type:'profile.save',payload:athlete,expectedRevision:c.data.revision});assert.equal(denied.status,402);
 const sessionId=sessionOf((await c.req('billing-checkout',{})).data.url);await stub({op:'pay',sessionId});
 assert.equal((await c.req('billing-confirm',{sessionId})).data.status,'active');
 await c.cmd('profile.save',athlete);assert.equal(c.data.profiles.length,1);
});

test('incomplete payment: processing until Stripe says active; billing-sync allows one call per 10 s',{skip},async()=>{
 const m=member('incomplete'),c=await signIn(m.email);const sessionId=sessionOf((await c.req('billing-checkout',{})).data.url);
 const sub=await stub({op:'pay',sessionId,status:'incomplete'});
 const r=await c.req('billing-confirm',{sessionId});assert.equal(r.data.status,'incomplete');assert.deepEqual([r.data.access.full,r.data.access.state],[false,'processing']);
 const next=row(m.id).next_sync_at;assert.ok(next>=now()+590&&next<=now()+610,'incomplete: next look in 10 minutes');
 await stub({op:'subscription',id:sub.id,status:'active',invoice:'paid'});
 const t=Date.now();const s=await c.req('billing-sync',{});assert.equal(s.status,200,JSON.stringify(s.data));
 assert.deepEqual([s.data.status,s.data.access.state,s.data.access.full],['active','active',true]);
 const [list]=await since(t,'GET',/^\/v1\/subscriptions$/);
 assert.deepEqual(list.query,{customer:row(m.id).stripe_customer_id,status:'all',limit:'20',expand:['data.latest_invoice','data.customer']});
 const limited=await c.req('billing-sync',{});assert.equal(limited.status,429);assert.equal(limited.data.error,'Zbyt wiele prób płatności. Spróbuj ponownie później.');
 assert.ok(limited.data.retry>=1&&limited.data.retry<=10);assert.equal(limited.headers.get('retry-after'),String(limited.data.retry));
});

test('past_due keeps access for the grace days, then access ends (billing-due through bin/cron.php and stripe-sync.php)',{skip},async()=>{
 const p=await paidMember('pastdue');const start=now()-2*D;
 await stub({op:'subscription',id:p.sub,status:'past_due',current_period_start:start,invoice:'open',event:false});
 fixture('billing',{userId:p.id,next_sync_at:now()-1});fixture('jobs-reset');
 const cron=cli('cron.php',['--job=billing-due']);assert.equal(cron.code,0,cron.err);assert.match(cron.out,/^billing-due: synced=[1-5] busy=0 failed=0 /m);
 let m=await me(p.c);assert.deepEqual([m.access.full,m.access.state,m.access.until],[true,'past_due',start+7*D]);
 assert.ok(row(p.id).next_sync_at>=now()+6*3600-5,'past_due: next look in 6 h');
 await stub({op:'subscription',id:p.sub,current_period_start:now()-8*D,event:false});fixture('billing',{userId:p.id,next_sync_at:now()-1});
 const sync=cli('stripe-sync.php',['--due']);assert.equal(sync.code,0,sync.err+sync.out);assert.match(sync.out,/^due: synced=[1-9]\d* busy=0 failed=0 /m);assert.ok(!sync.out.includes('@'),'counters only');
 m=await me(p.c);assert.deepEqual([m.access.full,m.access.state,m.access.block],[false,'none','payment']);
});

test('requireFrom: free until the date, then 7 days of grace, then payment; the grandfathered scope needs 14 days',{skip},async()=>{
 const address=email('grand');const {id}=await staff(address,'Klub Darmowy');
 let list=await admin.req('admin-billing&list=staff');assert.equal(list.status,200);
 assert.deepEqual(list.data.users[id],{state:'free',exempt:true,until:null,reason:'staff-default'});
 const adminId=admin.data.user.id;assert.equal(list.data.users[adminId].state,'staff');
 const day=n=>new Date(Date.now()+n*D*1000).toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'});
 const past=await admin.req('admin-billing-action',{action:'requireFrom',scope:'user',userId:id,date:day(-1)});assert.equal(past.status,422);
 const bad=await admin.req('admin-billing-action',{action:'requireFrom',scope:'user',userId:id,date:'2030-02-30'});assert.equal(bad.status,422);assert.equal(bad.data.error,'Podaj poprawną datę.');
 const r=await admin.req('admin-billing-action',{action:'requireFrom',scope:'user',userId:id,date:day(20)});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual([r.data.account.state,r.data.account.exempt,r.data.account.exemptReason],['free',true,'staff-default']);const from=r.data.account.exemptUntil;assert.equal(r.data.account.until,from);
 const c=new Client();await c.login(address,PASSWORD);
 let m=await me(c);assert.deepEqual([m.access.state,m.access.until,m.billing.exempt],['free',from,true]);
 const ended=now()-D;fixture('billing',{userId:id,exempt_until:ended});m=await me(c);assert.deepEqual([m.access.full,m.access.state,m.access.until],[true,'grace',ended+7*D]);
 fixture('billing',{userId:id,exempt_until:now()-8*D});m=await me(c);assert.deepEqual([m.access.full,m.access.state],[false,'none']);
 assert.equal((await c.req('command',{type:'profile.save',payload:{},expectedRevision:c.data.revision})).status,402);
 assert.ok(audit(id,'exempt.requireFrom').every(a=>a.actor===adminId));
 const notFree=member('notfree');const nf=await admin.req('admin-billing-action',{action:'requireFrom',scope:'user',userId:notFree.id,date:day(3)});
 assert.deepEqual([nf.status,nf.data.error],[409,'To konto nie jest darmowe.']);
 // Every account free since migration 0002 at once ('grandfathered'): at least 14 days ahead, one audit entry per account.
 const old=email('grandfathered');const {id:gid}=await staff(old,'Klub Stary');
 fixture('billing',{userId:gid,billing_exempt:1,exempt_reason:'grandfathered'});
 const soon=await admin.req('admin-billing-action',{action:'requireFrom',scope:'grandfathered',date:day(13)});assert.equal(soon.status,422);
 const g=await admin.req('admin-billing-action',{action:'requireFrom',scope:'grandfathered',date:day(30)});assert.equal(g.status,200,JSON.stringify(g.data));
 assert.ok(g.data.count>=1);assert.equal(row(gid).exempt_until,g.data.from);
 assert.deepEqual(audit(gid,'exempt.requireFrom').map(a=>[a.actor,a.detail]),[[adminId,`from=${day(30)} scope=grandfathered`]]);
 list=await admin.req('admin-billing&list=staff');assert.deepEqual(list.data.users[gid],{state:'free',exempt:true,until:g.data.from,reason:'grandfathered'});
});

test('webhook: signature, duplicates, livemode, bad JSON, unknown types, processing failure and 404 without secrets',{skip},async()=>{
 const p=await paidMember('webhook');
 await stub({op:'subscription',id:p.sub,cancel_at_period_end:true,event:false});
 const ev=event('customer.subscription.updated',{id:p.sub,object:'subscription',customer:p.customer,status:'active'});
 let t=Date.now();let r=await webhook(ev);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data,{received:true});
 assert.equal((await since(t,'GET',new RegExp('^/v1/subscriptions/'+p.sub+'$'))).length,1,'the object is fetched again, not read from the payload');
 assert.deepEqual([row(p.id).cancel_at_period_end,(await me(p.c)).access.state],[1,'ending']);
 t=Date.now();r=await webhook(ev);assert.deepEqual([r.status,r.data],[200,{received:true}]);assert.deepEqual(await since(t),[],'a duplicate is not processed again');
 const stored=fixture('stripe-events').find(x=>x.event_id===ev.id);assert.deepEqual([stored.type,stored.source,stored.attempts,stored.livemode,stored.error],['customer.subscription.updated','webhook',1,0,null]);assert.ok(stored.processed_at);
 const bad=[[{header:`t=${now()},v1=${'0'.repeat(64)}`},'bad signature'],[{secret:'whsec_other'},'other secret'],[{t:now()-301},'stale timestamp'],[{header:'garbage'},'malformed header'],
  [{raw:JSON.stringify(ev)+' ',header:`t=${now()},v1=${crypto.createHmac('sha256',SECRET).update(now()+'.'+JSON.stringify(ev)).digest('hex')}`},'tampered body']];
 for(const [o,name] of bad){r=await webhook(event('invoice.paid',{id:'in_x'}),o);assert.equal(r.status,400,name);assert.equal(r.data.error,'Niepoprawny podpis.',name);}
 r=await webhook(event('invoice.paid',{id:'in_x'},{livemode:true}));assert.deepEqual([r.status,r.data.error],[400,'Niepoprawne zdarzenie.']);
 r=await webhook(null,{raw:'{"id":'});assert.deepEqual([r.status,r.data.error],[400,'Niepoprawny JSON.']);
 r=await webhook(event('invoice.paid',{id:'in_x'},{object:'charge'}));assert.equal(r.status,400);
 const unknown=event('customer.updated',{id:p.customer,object:'customer'});r=await webhook(unknown);assert.equal(r.status,200);
 assert.ok(fixture('stripe-events').find(x=>x.event_id===unknown.id).processed_at,'unknown types are recorded and acknowledged');
 assert.equal((await webhook(ev,{method:'GET'})).status,405);
 // Processing failure: 500 so Stripe retries; the retry succeeds and counts the attempt.
 await stub({op:'fault',method:'GET',path:'^/v1/subscriptions/'+p.sub+'$',status:500});
 const ev2=event('customer.subscription.updated',{id:p.sub,object:'subscription'});
 r=await webhook(ev2);assert.equal(r.status,500);let s=fixture('stripe-events').find(x=>x.event_id===ev2.id);assert.deepEqual([s.processed_at,s.error],[null,'stripe 500 api_error/-']);
 r=await webhook(ev2);assert.equal(r.status,200);s=fixture('stripe-events').find(x=>x.event_id===ev2.id);assert.deepEqual([s.attempts,s.error],[2,null]);assert.ok(s.processed_at);
 // Without secrets the route does not exist.
 const old=fixture('billing-config-set',{set:{stripe_webhook_secrets:[]}});
 try{assert.equal(await until(async()=>(await webhook(ev)).status,404),404);}
 finally{fixture('billing-config-set',{set:old});}
 assert.equal(await until(async()=>(await webhook(event('customer.updated',{id:p.customer}))).status,200),200,'restored');
});

test('events pull: an event received by webhook is not processed again by stripe-sync.php --events',{skip},async()=>{
 const p=await paidMember('events');
 await stub({op:'subscription',id:p.sub,status:'past_due',current_period_start:now()-D});
 const e1=(await stub({op:'events'})).find(e=>e.type==='customer.subscription.updated'&&e.data.object.id===p.sub);
 assert.equal((await webhook(e1)).status,200);assert.equal((await me(p.c)).access.state,'past_due');
 await stub({op:'subscription',id:p.sub,status:'active',current_period_start:now(),invoice:'paid'});
 const e2=(await stub({op:'events'})).find(e=>e.data.object.id===p.sub&&e.id!==e1.id&&e.type==='customer.subscription.updated');
 const t=Date.now();const out=cli('stripe-sync.php',['--events']);assert.equal(out.code,0,out.err+out.out);
 const counts=out.out.match(/^events: events=(\d+) processed=(\d+) deduped=(\d+) duplicates=(\d+) skipped=0 failed=0 late=0 complete=yes$/m);assert.ok(counts,out.out);assert.ok(Number(counts[4])>=1,'the webhook event counts as a duplicate');
 const events=fixture('stripe-events');
 assert.deepEqual([events.find(x=>x.event_id===e1.id).source,events.find(x=>x.event_id===e1.id).attempts],['webhook',1]);assert.equal(events.find(x=>x.event_id===e2.id).source,'pull');
 // The state is fetched again (the session with its subscription expanded, oldest event first); the later events about
 // the same subscription in that page are answered from that fetch.
 const state=new RegExp('^/v1/(subscriptions/'+p.sub+'|checkout/sessions/'+p.sessionId+')$');
 const fetched=await since(t,'GET',state);assert.equal(fetched.length,1,JSON.stringify(fetched.map(x=>x.path)));assert.ok(Number(counts[3])>=2,'deduped');
 const evReq=(await since(t,'GET',/^\/v1\/events$/))[0];assert.equal(evReq.query.types.length,15);assert.ok(Number(evReq.query.created.gte)>0);
 assert.equal((await me(p.c)).access.state,'active');
 const before=fetched.length;const again=cli('stripe-sync.php',['--events']);assert.equal(again.code,0);
 assert.equal((await since(t,'GET',state)).length,before,'a second pull fetches nothing again');
 assert.ok(fixture('billing-kv',{})['events_cursor:test'],'cursor stored');
});

test('events pull: an event listed late behind the cursor is handled through the 120 s margin, the cursor stays',{skip},async()=>{
 const p=await paidMember('late');assert.equal(run('events',{pages:50}).complete,true);
 const cursor=()=>JSON.parse(fixture('billing-kv',{})['events_cursor:test']);const at=cursor();
 // The subscription changes in Stripe; its event was created 30 s before the cursor event but shows up in the list only
 // now, so ending_before=<cursor> never returns it (report 03 §8.5).
 await stub({op:'subscription',id:p.sub,status:'past_due',event:false});
 const late=await stub({op:'event',type:'customer.subscription.updated',object:{id:p.sub,object:'subscription',customer:p.customer},created:at.created-30});
 let t=Date.now();let r=run('events',{limit:20});
 assert.deepEqual([r.events,r.late,r.processed,r.failed,r.complete],[0,1,1,0,true],JSON.stringify(r));
 assert.equal(row(p.id).sub_status,'past_due');assert.deepEqual(cursor(),at,'the cursor stays on the newest event');
 const reads=await since(t,'GET',/^\/v1\/events$/);
 assert.ok(reads.length>=2);// the forward read, then the margin (pages of 100 when earlier tests left many events there)
 assert.deepEqual(reads.map(x=>[x.query.ending_before??null,x.query.created??null,x.query.limit]),reads.map((x,i)=>i?[null,{gte:String(at.created-120),lte:String(at.created)},'100']:[at.id,null,'20']));
 assert.equal(fixture('stripe-events').find(x=>x.event_id===late.id).source,'pull');
 // Handled once: the next run finds nothing behind the cursor and fetches nothing.
 t=Date.now();r=run('events',{});assert.deepEqual([r.late,r.processed,r.complete],[0,0,true]);
 assert.deepEqual(await since(t,'GET',new RegExp('^/v1/subscriptions/'+p.sub+'$')),[]);
 // A late event that cannot be fetched now (429) leaves the run incomplete and is retried by the next one.
 await stub({op:'subscription',id:p.sub,status:'active',invoice:'paid',event:false});
 const again=await stub({op:'event',type:'customer.subscription.updated',object:{id:p.sub,object:'subscription',customer:p.customer},created:at.created-10});
 await stub({op:'fault',method:'GET',path:'^/v1/subscriptions/'+p.sub+'$',status:429,type:'rate_limit_error',times:1});
 r=run('events',{background:true});assert.deepEqual([r.late,r.failed,r.complete],[1,1,false]);assert.equal(row(p.id).sub_status,'past_due');
 r=run('events',{});assert.deepEqual([r.late,r.processed,r.complete],[1,1,true]);assert.equal(row(p.id).sub_status,'active');
 assert.ok(fixture('stripe-events').find(x=>x.event_id===again.id).processed_at);assert.deepEqual(cursor(),at);
});
test('events pull walks forward from the cursor: more than a page, time budget, one fetch per object, a refused event is skipped',{skip},async()=>{
 const p=await paidMember('forward');
 assert.equal(run('events',{pages:50}).complete,true,'caught up: the cursor is the newest event');
 const cursor=()=>JSON.parse(fixture('billing-kv',{})['events_cursor:test']);const start=cursor().id;
 // 150 events after the cursor, read one page of 100 per run (the shape the review found skipping 50 of them).
 const objects=Array.from({length:150},(_,i)=>({id:`sub_missing${process.pid}x${i}`,object:'subscription'}));
 const ids=await stub({op:'bulk-events',type:'customer.subscription.updated',objects});
 let t=Date.now();let r=run('events',{pages:1});
 assert.deepEqual([r.events,r.processed,r.failed,r.complete],[100,100,0,false]);assert.equal(cursor().id,ids[99],'the cursor stops at the last event handled');
 r=run('events',{pages:1});assert.deepEqual([r.events,r.processed,r.complete],[50,50,true]);assert.equal(cursor().id,ids[149]);
 const done=new Set(fixture('stripe-events').filter(x=>x.processed_at).map(x=>x.event_id));
 assert.deepEqual(ids.filter(id=>!done.has(id)),[],'every one of the 150 events was handled');
 const reads=await since(t,'GET',/^\/v1\/events$/),fwd=reads.filter(x=>x.query.ending_before);assert.deepEqual(fwd.map(x=>x.query.ending_before),[start,ids[99]]);
 assert.ok(fwd.every(x=>!x.query.created&&x.query.types.length===15&&x.query.limit==='100'));
 // Only the complete run reads the 120 s up to the cursor once more (nothing late there): more than 100 events, so pages.
 const margin=reads.filter(x=>!x.query.ending_before),c2=cursor().created;
 assert.ok(margin.length>=2&&margin.length<=3,'pages of 100, at most 3: '+margin.length);
 assert.deepEqual(margin.map(x=>[x.query.created.gte,x.query.created.lte,x.query.limit,x.query.types.length,Boolean(x.query.starting_after)]),margin.map((x,i)=>[String(c2-120),String(c2),'100',15,i>0]));
 // A time budget: one event per run at least, and the cursor moves exactly past what was handled.
 const three=await stub({op:'bulk-events',type:'customer.subscription.updated',objects:objects.slice(0,3).map(o=>({...o,id:o.id+'b'}))});
 r=run('events',{budget:0.000001});assert.deepEqual([r.processed,r.complete],[1,false]);assert.equal(cursor().id,three[0]);
 r=run('events',{budget:0.000001});assert.equal(cursor().id,three[1]);
 r=run('events',{limit:20});assert.deepEqual([r.processed,r.complete],[1,true]);assert.equal(cursor().id,three[2]);
 // Three events about one subscription in one page: one fetch, the other two answered from it.
 const sub={id:p.sub,object:'subscription',customer:p.customer};
 await stub({op:'event',type:'customer.subscription.updated',object:sub});await stub({op:'event',type:'customer.subscription.updated',object:sub});
 await stub({op:'event',type:'invoice.paid',object:{id:'in_forward',object:'invoice',customer:p.customer,parent:{type:'subscription_details',subscription_details:{subscription:p.sub}}}});
 t=Date.now();r=run('events',{});assert.deepEqual([r.events,r.processed,r.deduped,r.complete],[3,1,2,true]);
 assert.equal((await since(t,'GET',new RegExp('^/v1/subscriptions/'+p.sub+'$'))).length,1);
 // 429 stops the run before the event (the next run starts with it); a refusal that cannot succeed (400) is given up,
 // audited, and the events after it are handled.
 const bad=await stub({op:'bulk-events',type:'customer.subscription.updated',objects:[{id:'sub_refused'+process.pid,object:'subscription'},{id:'sub_after'+process.pid,object:'subscription'}]});
 const before=cursor().id;await stub({op:'fault',method:'GET',path:'^/v1/subscriptions/sub_refused',status:429,type:'rate_limit_error',times:1});
 r=run('events',{background:true});assert.deepEqual([r.failed,r.processed,r.skipped,r.complete],[1,0,0,false]);assert.equal(cursor().id,before);
 await stub({op:'fault',method:'GET',path:'^/v1/subscriptions/sub_refused',status:400,type:'invalid_request_error',times:1});
 r=run('events',{background:true});assert.deepEqual([r.skipped,r.processed,r.failed,r.complete],[1,1,0,true]);assert.equal(cursor().id,bad[1]);
 const refused=fixture('stripe-events').find(x=>x.event_id===bad[0]);assert.ok(refused.processed_at);assert.equal(refused.attempts,2);
 assert.equal(refused.error,'skipped: stripe 400 invalid_request_error/-');
 assert.ok(audit(undefined,'event.skipped').some(a=>a.detail===`${bad[0]} customer.subscription.updated stripe 400 invalid_request_error/-`&&a.actor==='cron'));
 // A cursor Stripe no longer knows (events are kept 30 days): the window from its time minus 120 s, then forward again.
 fixture('billing-kv',{set:{'events_cursor:test':JSON.stringify({created:now()-60,id:'evt_gone'+process.pid})}});
 t=Date.now();r=run('events',{pages:5});assert.equal(r.complete,true,JSON.stringify(r));assert.ok(r.duplicates>=1);
 const [gone,window]=await since(t,'GET',/^\/v1\/events$/);assert.equal(gone.query.ending_before,'evt_gone'+process.pid);
 assert.ok(!window.query.ending_before&&Number(window.query.created.gte)<=now()-180&&Number(window.query.created.gte)>=now()-200);
 assert.equal(cursor().id,bad[1],'back on the newest event');
 // The job: background client, pages of 20, the counters in job_runs.
 fixture('jobs-reset');const cron=cli('cron.php',['--job=billing-events']);assert.equal(cron.code,0,cron.err);
 assert.match(cron.out,/^billing-events: events=0 processed=0 deduped=0 duplicates=0 skipped=0 failed=0 late=0 complete=yes pruned=\d+$/m);
});
test('subscription precedence: reconcile keeps the active B over an old canceled A; a late event about A changes nothing',{skip},async()=>{
 const p=await paidMember('prec');
 const a=await stub({op:'create-subscription',customer:p.customer,status:'canceled',created:now()-1000});
 const out=cli('stripe-sync.php',['--reconcile']);assert.equal(out.code,0,out.err+out.out);assert.match(out.out,/^reconcile: subscriptions=\d+ customers=\d+ /m);
 let r=row(p.id);assert.deepEqual([r.stripe_subscription_id,r.sub_status],[p.sub,'active']);
 const late=await webhook(event('customer.subscription.deleted',{id:a.id,object:'subscription',customer:p.customer}));assert.equal(late.status,200);
 r=row(p.id);assert.deepEqual([r.stripe_subscription_id,r.sub_status],[p.sub,'active']);assert.equal((await me(p.c)).access.state,'active');
 assert.ok(audit(p.id,'sub.ignored').some(x=>x.detail.startsWith(a.id)&&x.new_status==='canceled'),'the late event is only audited');
 // The opposite: the row still points at an old canceled A, the customer has a newer active B → B wins.
 const q=await paidMember('prec2');const old=await stub({op:'create-subscription',customer:q.customer,status:'canceled',created:now()-5000});
 fixture('billing',{userId:q.id,stripe_subscription_id:old.id,sub_status:'canceled',last_synced_at:0});
 assert.equal((await me(q.c)).access.state,'ended');
 assert.ok(run('reconcile').updated>=1);r=row(q.id);assert.deepEqual([r.stripe_subscription_id,r.sub_status],[q.sub,'active']);
 assert.ok(audit(q.id,'sub.replace').some(x=>x.detail===`${old.id} -> ${q.sub}`));
 // Two subscriptions of one customer through the per-account sync: the best one, whatever the order.
 await stub({op:'subscription',id:q.sub,status:'canceled'});const b2=await stub({op:'create-subscription',customer:q.customer,status:'active',created:now()+10});
 run('sync',{userId:q.id});r=row(q.id);assert.deepEqual([r.stripe_subscription_id,r.sub_status],[b2.id,'active']);
});

test('Admin: exempt with audit and warnLive, require, cancel at period end, currency, resync; only for admins',{skip},async()=>{
 const p=await paidMember('admin');
 const ex=await admin.req('admin-billing-action',{action:'exempt',userId:p.id,reason:'  Sponsor klubu  '});assert.equal(ex.status,200,JSON.stringify(ex.data));
 assert.deepEqual([ex.data.ok,ex.data.warnLive,ex.data.account.state,ex.data.account.exempt,ex.data.account.exemptReason],[true,true,'free',true,'Sponsor klubu']);
 const adminId=admin.data.user.id;
 const [g]=audit(p.id,'exempt.grant');assert.deepEqual([g.actor,g.old_status,g.new_status],[adminId,'active','free']);
 for(const [body,status] of [[{action:'exempt',userId:p.id,reason:''},422],[{action:'exempt',userId:p.id,reason:'x',until:'2001-01-01'},422],[{action:'exempt',userId:'nobody-'+seq,reason:'x'},404],[{action:'nonsense',userId:p.id},400]]){
  const r=await admin.req('admin-billing-action',body);assert.equal(r.status,status,JSON.stringify(body));
 }
 const det=await admin.req('admin-billing&userId='+p.id);assert.equal(det.status,200);
 assert.deepEqual(Object.keys(det.data),['account','audit']);assert.ok(det.data.audit.length>=3&&det.data.audit.length<=50);
 assert.equal(det.data.account.dashboardUrl,'https://dashboard.stripe.com/test/customers/'+p.customer);assert.equal(det.data.account.subscriptionId,p.sub);
 assert.ok(!JSON.stringify(det.data.audit).includes(p.email),'no e-mail in the audit');
 const rq=await admin.req('admin-billing-action',{action:'require',userId:p.id});assert.deepEqual([rq.status,rq.data.account.state,rq.data.account.exempt],[200,'active',false]);
 const cur=await admin.req('admin-billing-action',{action:'currency',userId:p.id,currency:'usd'});assert.equal(cur.status,409);
 const t=Date.now();const cancel=await admin.req('admin-billing-action',{action:'cancelAtPeriodEnd',userId:p.id});assert.equal(cancel.status,200,JSON.stringify(cancel.data));
 assert.equal(cancel.data.account.state,'ending');const [post]=await since(t,'POST',new RegExp('^/v1/subscriptions/'+p.sub+'$'));assert.equal(post.body.cancel_at_period_end,'true');
 assert.equal((await me(p.c)).access.state,'ending');assert.equal(audit(p.id,'cancel.request')[0].actor,adminId);
 const resync=await admin.req('admin-billing-action',{action:'resync',userId:p.id});assert.deepEqual([resync.status,resync.data.account.state],[200,'ending']);
 // Currency override for a person without a subscription: checkout follows it (the country would say USD).
 const de=member('admin-cur',{country:'DE'});const keys=await prices();
 assert.equal((await admin.req('admin-billing-action',{action:'currency',userId:de.id,currency:'eur'})).status,422);
 assert.equal((await admin.req('admin-billing-action',{action:'currency',userId:de.id,currency:'pln'})).data.account.currency,'pln');
 const cd=await signIn(de.email);assert.equal((await me(cd)).billing.currency,'pln','me shows the Admin override, not the country rule');
 const t2=Date.now();await cd.req('billing-checkout',{});
 assert.equal((await since(t2,'POST',/^\/v1\/checkout\/sessions$/))[0].body.line_items[0].price,keys.matbravo_monthly_pln);
 // Not for members or staff, and before reading anything.
 for(const [route,body] of [['admin-billing&list=staff',undefined],['admin-billing&userId='+p.id,undefined],['admin-billing-action',{action:'exempt',userId:p.id,reason:'x'}]]){
  const r=await p.c.req(route,body);assert.equal(r.status,403,route);
 }
 assert.equal((await admin.req('admin-billing')).status,400);
});

/** fixture() in a child process that runs in parallel with others (php -S may serve two requests one after the other). */
function fixtureAsync(job,payload){
 return new Promise((resolve,reject)=>{const p=spawn(php,[fixtureScript],{env:process.env});let out='',err='';
  p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err||out)));p.stdin.end(JSON.stringify({job,payload}));});
}
test('two parallel syncs of one account make one Stripe call (60 s claim)',{skip},async()=>{
 const p=await paidMember('parallel');
 await stub({op:'delay',method:'GET',path:'^/v1/subscriptions$',ms:3000,times:2});
 const t=Date.now();
 // The second sync starts once the first holds the claim and waits for the delayed Stripe answer, so the outcome does
 // not depend on how fast two PHP processes start on a loaded machine. Both are awaited before any assertion.
 const first=fixtureAsync('billing-run',{fn:'sync-user',userId:p.id});
 const claimed=await eventually(()=>Number(row(p.id).sync_claimed_at)>0,true,10000,50);
 const outcomes=await Promise.all([first,claimed?fixtureAsync('billing-run',{fn:'sync-user',userId:p.id}):'not started']);
 assert.ok(claimed,'the first sync claims the account');
 assert.equal(outcomes.filter(o=>o==='busy').length,1,'the second one finds the claim: '+outcomes);
 assert.ok(outcomes.some(o=>['updated','unchanged'].includes(o)),String(outcomes));
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/)).length,1,'one Stripe call');assert.equal(row(p.id).sync_claimed_at,0,'claim released');
 // The Admin's resync goes through the same claim: with a fresh claim held by someone else it reports busy without calling Stripe.
 fixture('billing',{userId:p.id,sync_claimed_at:now()});const t2=Date.now();
 const busy=await admin.req('admin-billing-action',{action:'resync',userId:p.id});assert.deepEqual([busy.status,busy.data.busy],[200,true]);
 assert.deepEqual(await since(t2,'GET',/^\/v1\/subscriptions$/),[]);
 fixture('billing',{userId:p.id,sync_claimed_at:now()-61});assert.equal((await admin.req('admin-billing-action',{action:'resync',userId:p.id})).data.busy,undefined,'an expired claim (60 s) is taken over');
 await stub({op:'clear-faults'});
});

test('circuit breaker: a network error in the background pauses background syncs; people are not affected',{skip},async()=>{
 fixture('billing-kv',{set:{stripe_down_until:null}});
 const p=await paidMember('breaker');fixture('billing',{userId:p.id,next_sync_at:now()-1});
 await stub({op:'fault',method:'GET',path:'^/v1/subscriptions$',kind:'drop'});
 let r=run('due',{background:true,limit:5});assert.ok(r.failed>=1,JSON.stringify(r));
 const until=Number(fixture('billing-kv',{})['stripe_down_until']);assert.ok(until>=now()+590&&until<=now()+605,'open for stripe_down_seconds');
 assert.match(String(row(p.id).sync_error),/^stripe 0 network/);
 let t=Date.now();r=run('due',{background:true});run('lazy',{userId:p.id});
 assert.deepEqual(await since(t),[],'nothing sent while the breaker is open');
 fixture('jobs-reset');const cron=cli('cron.php',['--job=billing-due']);assert.match(cron.out,/^billing-due: stripe down \d+s$/m);
 t=Date.now();const s=await p.c.req('billing-sync',{});assert.equal(s.status,200,'interactive calls ignore the breaker');assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/)).length,1);
 fixture('billing-kv',{set:{stripe_down_until:null}});
 // The lazy sync of me (run after the response through Jobs::afterSent; php -S cannot send early, so it is called here):
 // only when next_sync_at is due and the last sync is older than billing_sync_min_interval.
 await stub({op:'subscription',id:p.sub,status:'past_due',current_period_start:now()-D,event:false});
 fixture('billing',{userId:p.id,next_sync_at:now()-1,last_synced_at:now()-60});t=Date.now();run('lazy',{userId:p.id});
 assert.deepEqual(await since(t),[],'synced a minute ago: not yet');
 fixture('billing',{userId:p.id,next_sync_at:now()+3600,last_synced_at:now()-3600});run('lazy',{userId:p.id});assert.deepEqual(await since(t),[],'not due');
 fixture('billing',{userId:p.id,next_sync_at:now()-1,last_synced_at:now()-3600});run('lazy',{userId:p.id});
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/)).length,1);assert.deepEqual([row(p.id).sub_status,(await me(p.c)).access.state],['past_due','past_due']);
});

test('account deletion: the Stripe customer is deleted; a failure leaves stripe_redact_pending for billing-due; tombstones stay unchanged',{skip},async()=>{
 const p=await paidMember('delete');let t=Date.now();
 assert.equal(run('delete-customer',{userId:p.id}),true);
 assert.deepEqual((await since(t,'DELETE')).map(x=>x.path),['/v1/customers/'+p.customer]);
 assert.equal(row(p.id).stripe_redact_pending,0);assert.deepEqual(await stub({op:'customer',id:p.customer}),{id:p.customer,object:'customer',deleted:true});
 assert.ok(audit(p.id,'customer.redact').length===1);
 const q=await paidMember('delete-retry');
 await stub({op:'fault',method:'DELETE',path:'^/v1/customers/',status:500,times:3});
 assert.equal(run('delete-customer',{userId:q.id}),false);assert.equal(row(q.id).stripe_redact_pending,1);assert.ok(audit(q.id,'customer.redact.pending').length===1);
 fixture('billing-tombstone',{userId:q.id});
 const before=row(q.id);
 // The forced sync of the deletion flow and events about the customer never change a tombstone.
 assert.equal(run('sync',{userId:q.id}).sub_status,'active');
 const late=await webhook(event('customer.subscription.updated',{id:q.sub,object:'subscription',customer:q.customer}));assert.equal(late.status,200);
 assert.equal(row(q.id).sub_status,before.sub_status);assert.ok(audit(q.id,'tombstone').length>=1);
 t=Date.now();const due=run('due',{limit:5});assert.ok(due.redacted>=1,JSON.stringify(due));
 assert.ok((await since(t,'DELETE')).some(x=>x.path==='/v1/customers/'+q.customer));assert.equal(row(q.id).stripe_redact_pending,0);
 assert.equal(run('delete-customer',{userId:member('delete-none').id}),true,'nothing to delete without a customer');
});

test('e-mail changes reach the Stripe customer; every sync corrects a different address',{skip},async()=>{
 const p=await paidMember('email');const first=email('email-new');fixture('billing-user-email',{userId:p.id,email:first});
 let t=Date.now();assert.equal(run('push-email',{userId:p.id}),true);
 assert.deepEqual((await since(t,'POST',/^\/v1\/customers\//)).map(x=>[x.path,x.body.email]),[['/v1/customers/'+p.customer,first]]);
 const second=email('email-sync');fixture('billing-user-email',{userId:p.id,email:second});
 t=Date.now();const s=await p.c.req('billing-sync',{});assert.equal(s.status,200,JSON.stringify(s.data));
 assert.deepEqual((await since(t,'POST',/^\/v1\/customers\//)).map(x=>x.body.email),[second]);
 assert.equal((await stub({op:'customer',id:p.customer})).email,second);assert.ok(audit(p.id,'customer.email').every(a=>!String(a.detail).includes('@')));
 await stub({op:'fault',method:'POST',path:'^/v1/customers/',status:500,times:3});
 assert.equal(run('push-email',{userId:p.id}),false);assert.ok(Math.abs(row(p.id).next_sync_at-now())<=5,'retry at the next sync');
});

test('Stripe failures: one 500 or 429 is retried with the same Idempotency-Key; persistent failures answer 503',{skip},async()=>{
 const a=member('retry'),ca=await signIn(a.email);
 await stub({op:'fault',method:'POST',path:'^/v1/checkout/sessions$',status:500,times:1});
 await stub({op:'fault',method:'POST',path:'^/v1/customers$',status:429,shouldRetry:true,times:1});
 let t=Date.now();const ok=await ca.req('billing-checkout',{});assert.equal(ok.status,200,JSON.stringify(ok.data));
 const posts=await since(t,'POST',/^\/v1\/checkout\/sessions$/);assert.equal(posts.length,2);assert.equal(posts[0].idempotencyKey,posts[1].idempotencyKey);
 const cus=await since(t,'POST',/^\/v1\/customers$/);assert.deepEqual(cus.map(x=>x.fault??null),[429,null]);
 const b=member('fail'),cb=await signIn(b.email);
 await stub({op:'fault',method:'POST',path:'^/v1/checkout/sessions$',status:503,times:3});
 const r=await cb.req('billing-checkout',{});assert.equal(r.status,503);assert.deepEqual([r.data.error,r.data.code],[ERR.unavailable,'stripe_unavailable']);assert.ok(r.data.csrf);
 assert.ok(!JSON.stringify(r.data).includes('Stub failure'),'the Stripe message is never shown');
 await stub({op:'clear-faults'});
});

test('a new Stripe customer when the old one keeps another currency or was deleted in the Dashboard',{skip},async()=>{
 const p=await paidMember('swap','DE');const keys=await prices();
 await stub({op:'subscription',id:p.sub,status:'canceled'});assert.equal((await p.c.req('billing-sync',{})).data.access.state,'ended');
 fixture('billing-country',{userId:p.id,country:'PL'});assert.equal((await stub({op:'customer',id:p.customer})).currency,'usd');
 // Customer.currency (usd, from the first invoice) differs from the plan (pln): Stripe is asked first and the new customer
 // comes before the session, so Stripe never has to refuse it.
 let t=Date.now();const r=await p.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/))[0].query.customer,p.customer);
 const sessions=await since(t,'POST',/^\/v1\/checkout\/sessions$/);assert.deepEqual(sessions.map(x=>x.body.line_items[0].price),[keys.matbravo_monthly_pln]);
 const [created]=await since(t,'POST',/^\/v1\/customers$/);assert.equal(created.idempotencyKey,`matbravo-customer-${p.id}-test-1`);
 const swapped=row(p.id);assert.notEqual(swapped.stripe_customer_id,p.customer);assert.equal(sessions[0].body.customer,swapped.stripe_customer_id);
 assert.deepEqual([swapped.customer_seq,swapped.stripe_subscription_id,swapped.sub_status],[1,null,'none']);
 assert.ok(audit(p.id,'customer.replace').some(a=>a.detail===`${p.customer} -> ${swapped.stripe_customer_id}`));
 // Fallback when Customer.currency says nothing: Stripe's currency refusal still leads to a new customer.
 const f=await paidMember('swap-fallback','DE');await stub({op:'subscription',id:f.sub,status:'canceled'});await stub({op:'hide-currency',id:f.customer});
 assert.equal(run('sync',{userId:f.id}).sub_status,'canceled');fixture('billing-country',{userId:f.id,country:'PL'});
 t=Date.now();const fr=await f.c.req('billing-checkout',{});assert.equal(fr.status,200,JSON.stringify(fr.data));
 const fs=await since(t,'POST',/^\/v1\/checkout\/sessions$/);assert.deepEqual(fs.map(x=>[x.body.customer,x.body.line_items[0].price]),[[f.customer,keys.matbravo_monthly_pln],[row(f.id).stripe_customer_id,keys.matbravo_monthly_pln]]);
 assert.notEqual(row(f.id).stripe_customer_id,f.customer);assert.equal(row(f.id).customer_seq,1);
 // Deleted in the Dashboard: the next checkout notices it, forgets the customer and starts with a new one.
 const q=member('gone'),cq=await signIn(q.email);const first=await cq.req('billing-checkout',{});const old=row(q.id).stripe_customer_id;
 await stub({op:'expire-session',sessionId:sessionOf(first.data.url)});await stub({op:'delete-customer',id:old});
 t=Date.now();const again=await cq.req('billing-checkout',{});assert.equal(again.status,200,JSON.stringify(again.data));
 const fresh=row(q.id);assert.notEqual(fresh.stripe_customer_id,old);assert.equal(fresh.customer_seq,1);
 assert.deepEqual((await since(t,'POST',/^\/v1\/customers$/)).map(x=>x.idempotencyKey),[`matbravo-customer-${q.id}-test-1`]);
 assert.ok(audit(q.id,'customer.deleted').some(a=>a.detail===old));
});

test('checkout: no second subscription next to an incomplete one or a session paid elsewhere; two ongoing subscriptions are audited',{skip},async()=>{
 const m=member('lock'),c=await signIn(m.email);let sessionId=sessionOf((await c.req('billing-checkout',{})).data.url);
 const first=await stub({op:'pay',sessionId,status:'incomplete'});assert.equal((await c.req('billing-confirm',{sessionId})).data.status,'incomplete');
 // Still incomplete in Stripe (an async payment): Stripe is asked first, then the Portal answer, and no new session.
 let t=Date.now();let r=await c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.error,r.data.portal],[409,'Masz już aktywną subskrypcję.',true]);
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/)).length,1);assert.deepEqual(await since(t,'POST'),[]);
 // Expired in Stripe while the cache still says incomplete: a new checkout, with the same customer (same currency).
 await stub({op:'subscription',id:first.id,status:'incomplete_expired',event:false});assert.equal(row(m.id).sub_status,'incomplete');
 t=Date.now();r=await c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal((await since(t,'POST',/^\/v1\/checkout\/sessions$/))[0].body.customer,first.customer);assert.equal(row(m.id).sub_status,'incomplete_expired');
 // That session is paid in another tab and never confirmed here: the next click finds the subscription, not a new session.
 sessionId=sessionOf(r.data.url);const paid=await stub({op:'pay',sessionId});
 t=Date.now();r=await c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.portal],[409,true]);assert.deepEqual(await since(t,'POST',/^\/v1\/checkout\/sessions$/),[]);
 const rw=row(m.id);assert.deepEqual([rw.stripe_subscription_id,rw.sub_status,rw.pending_checkout_id],[paid.id,'active',null]);
 // A second ongoing subscription of the customer (report 03 §5.3 guard 4): 'sub.multiple' once, in the Admin's detail.
 const second=await stub({op:'create-subscription',customer:first.customer,status:'active',created:now()+5});
 assert.equal((await c.req('billing-sync',{})).status,200);run('sync',{userId:m.id});
 const multi=audit(m.id,'sub.multiple');assert.equal(multi.length,1,'written once per set of ids');assert.equal(multi[0].detail,[paid.id,second.id].sort().join(' '));
 const det=await admin.req('admin-billing&userId='+m.id);assert.ok(det.data.audit.some(a=>a.action==='sub.multiple'&&a.detail===multi[0].detail));
 // The Admin's free-account warning covers every ongoing state (an incomplete payment may still go through).
 const ex=await admin.req('admin-billing-action',{action:'exempt',userId:m.id,reason:'Test'});assert.equal(ex.data.warnLive,true);
});

test('checkout while another sync holds the claim: Stripe is read without writing, so the lock and Customer.currency still apply',{skip},async()=>{
 const keys=await prices();
 // A session paid in another tab, unknown to the cache, while a lazy sync (or a double click) holds the claim.
 const m=member('busy'),c=await signIn(m.email);const sessionId=sessionOf((await c.req('billing-checkout',{})).data.url);
 const paid=await stub({op:'pay',sessionId});const held=now();fixture('billing',{userId:m.id,sync_claimed_at:held});
 let t=Date.now();let r=await c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.portal],[409,true],JSON.stringify(r.data));
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/))[0].query.customer,paid.customer);assert.deepEqual(await since(t,'POST'),[]);
 let rw=row(m.id);assert.deepEqual([rw.sub_status,rw.stripe_subscription_id,Number(rw.sync_claimed_at)],['none',null,held],'nothing written, the claim untouched');
 // Once the claim is free the same click syncs as usual.
 fixture('billing',{userId:m.id,sync_claimed_at:0});r=await c.req('billing-checkout',{});assert.equal(r.status,409);
 rw=row(m.id);assert.deepEqual([rw.sub_status,rw.stripe_subscription_id],['active',paid.id]);
 // Customer.currency (usd) differs from the plan (pln) while the claim is held: a new customer before the one session.
 const p=await paidMember('busy-cur','DE');await stub({op:'subscription',id:p.sub,status:'canceled'});assert.equal(run('sync',{userId:p.id}).sub_status,'canceled');
 fixture('billing-country',{userId:p.id,country:'PL'});fixture('billing',{userId:p.id,sync_claimed_at:now()});
 t=Date.now();r=await p.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 const sessions=await since(t,'POST',/^\/v1\/checkout\/sessions$/),swapped=row(p.id);
 assert.deepEqual(sessions.map(x=>[x.body.customer,x.body.line_items[0].price]),[[swapped.stripe_customer_id,keys.matbravo_monthly_pln]],'one session, no refusal first');
 assert.notEqual(swapped.stripe_customer_id,p.customer);assert.equal(swapped.customer_seq,1);
 assert.ok(audit(p.id,'customer.replace').some(a=>a.detail===`${p.customer} -> ${swapped.stripe_customer_id}`));
});

test('checkout on a cached ongoing status without access asks Stripe first: past_due after the grace days → Portal, a stale active row → Checkout',{skip},async()=>{
 const portal=['Masz już aktywną subskrypcję.',true];
 // past_due beyond the grace days while Stripe still retries the card: no access, and Stripe confirms the subscription,
 // so the answer stays 409 {portal:true} (the card is updated in the Portal, not with a second subscription).
 const p=await paidMember('stale-pastdue');
 await stub({op:'subscription',id:p.sub,status:'past_due',current_period_start:now()-9*D,invoice:'open',event:false});
 assert.equal(run('sync',{userId:p.id}).sub_status,'past_due');
 let m=await me(p.c);assert.deepEqual([m.access.full,m.access.state,m.access.block],[false,'none','payment']);
 let t=Date.now();let r=await p.c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.error,r.data.portal],[409,...portal]);
 assert.equal((await since(t,'GET',/^\/v1\/subscriptions$/)).length,1,'Stripe is asked before the refusal');assert.deepEqual(await since(t,'POST'),[]);
 // A stale active row (not synced since its period ended + 72 h) while Stripe says canceled: Checkout opens.
 const s=await paidMember('stale-active');await stub({op:'subscription',id:s.sub,status:'canceled',event:false});
 fixture('billing',{userId:s.id,current_period_start:now()-33*D,current_period_end:now()-80*3600,next_sync_at:now()+D});
 m=await me(s.c);assert.deepEqual([m.access.full,m.access.state],[false,'none']);assert.equal(row(s.id).sub_status,'active');
 t=Date.now();r=await s.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.match(r.data.url,/^https:\/\/checkout\.stripe\.com\//);assert.equal(row(s.id).sub_status,'canceled','the sync wrote what Stripe said');
 assert.equal((await since(t,'POST',/^\/v1\/checkout\/sessions$/))[0].body.customer,s.customer,'same customer, same currency');
 // A renewal the row missed (no lazy sync, no jobs): the click repairs the row and sends to the Portal; access is back.
 const n=await paidMember('stale-renewed');await stub({op:'subscription',id:n.sub,current_period_start:now()-D,current_period_end:now()+29*D,event:false});
 fixture('billing',{userId:n.id,current_period_start:now()-33*D,current_period_end:now()-80*3600,next_sync_at:now()+D});
 assert.equal((await me(n.c)).access.state,'none');
 r=await n.c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.error,r.data.portal],[409,...portal]);
 m=await me(n.c);assert.deepEqual([m.access.full,m.access.state],[true,'active']);assert.ok(row(n.id).current_period_end>now()+28*D);
 // While another sync holds the claim, Stripe's read-only answer decides, not the stale row.
 const b=await paidMember('stale-busy');await stub({op:'subscription',id:b.sub,status:'canceled',event:false});
 fixture('billing',{userId:b.id,current_period_start:now()-33*D,current_period_end:now()-80*3600,next_sync_at:now()+D,sync_claimed_at:now()});
 r=await b.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 // A row whose cached status still gives access keeps the fast refusal without any Stripe call.
 const f=await paidMember('fast-lock');t=Date.now();r=await f.c.req('billing-checkout',{});assert.deepEqual([r.status,r.data.portal],[409,true]);assert.deepEqual(await since(t),[]);
});

test('a replaced customer: its open Checkout sessions are expired first, so an old tab cannot be paid; a superseded pending session too',{skip},async()=>{
 // A former PLN subscriber opens Checkout (session A on the PLN customer), then moves to the US and clicks again.
 const p=await paidMember('replace-open');await stub({op:'subscription',id:p.sub,status:'canceled'});assert.equal(run('sync',{userId:p.id}).sub_status,'canceled');
 let r=await p.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));const a=sessionOf(r.data.url);
 fixture('billing-country',{userId:p.id,country:'US'});
 let t=Date.now();r=await p.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));const b=sessionOf(r.data.url);
 const lists=await since(t,'GET',/^\/v1\/checkout\/sessions$/);assert.deepEqual(lists.map(x=>[x.query.customer,x.query.status]),[[p.customer,'open']]);
 assert.deepEqual((await since(t,'POST',/\/expire$/)).map(x=>x.path),['/v1/checkout/sessions/'+a+'/expire'],'expired before the customer is replaced');
 const swapped=row(p.id);assert.notEqual(swapped.stripe_customer_id,p.customer);
 let st=await stub({op:'state'});assert.deepEqual([st.sessions[a].status,st.sessions[b].status,st.sessions[b].customer],['expired','open',swapped.stripe_customer_id]);
 // The old tab can no longer be paid (Stripe, like the stub, refuses a session that is not open): no subscription on
 // the old customer, charged every month without access.
 await assert.rejects(stub({op:'pay',sessionId:a}),/no longer active/);
 assert.ok(audit(p.id,'checkout.expire').some(x=>x.detail===a));
 // Both customers are remembered for the account deletion.
 assert.deepEqual(fixture('billing-customers',{userId:p.id}).map(x=>x.customer_id).sort(),[p.customer,swapped.stripe_customer_id].sort());
 // A subscription that still appears on the old customer (e.g. paid just before the expiry) is an orphan the Admin sees
 // in the account's audit, not an anonymous one.
 const stray=await stub({op:'create-subscription',customer:p.customer,status:'active'});
 const wh=await webhook(event('customer.subscription.created',{id:stray.id,object:'subscription',customer:p.customer}));assert.equal(wh.status,200);
 assert.ok(audit(p.id,'orphan').some(x=>x.detail===`${stray.id} ${p.customer}`),'orphan audit with the account');
 // Same customer, no replacement: the pending session in another currency is ended before the new one is created.
 const q=member('supersede'),cq=await signIn(q.email);const x=sessionOf((await cq.req('billing-checkout',{})).data.url);
 fixture('billing-country',{userId:q.id,country:'DE'});
 t=Date.now();r=await cq.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));const y=sessionOf(r.data.url);
 assert.deepEqual((await since(t,'POST',/\/expire$/)).map(x=>x.path),['/v1/checkout/sessions/'+x+'/expire']);
 // A pending session about to expire (less than 5 minutes left) is not reused but ended too.
 fixture('billing',{userId:q.id,pending_checkout_expires:now()+200});
 t=Date.now();r=await cq.req('billing-checkout',{});assert.equal(r.status,200);const z=sessionOf(r.data.url);
 assert.deepEqual((await since(t,'POST',/\/expire$/)).map(x=>x.path),['/v1/checkout/sessions/'+y+'/expire']);
 st=await stub({op:'state'});assert.deepEqual([st.sessions[x].status,st.sessions[y].status,st.sessions[z].status],['expired','expired','open']);
 // A pending session paid in another tab after the sync but before its expiry: Stripe refuses the expiry, the payment is
 // written to the account and the click answers with the Portal instead of a second session.
 fixture('billing',{userId:q.id,pending_checkout_expires:now()+200});await stub({op:'delay',method:'POST',path:'/expire$',ms:1500});
 t=Date.now();const pending=cq.req('billing-checkout',{});
 assert.equal((await eventually(async()=>(await since(t,'POST',/\/expire$/)).length,1)),1);await stub({op:'pay',sessionId:z});
 r=await pending;assert.deepEqual([r.status,r.data.portal],[409,true],JSON.stringify(r.data));
 assert.deepEqual(await since(t,'POST',/^\/v1\/checkout\/sessions$/),[]);const paid=row(q.id);assert.deepEqual([paid.sub_status,paid.pending_checkout_id],['active',null]);
});

test('account deletion deletes every Stripe customer the account ever had; a failed deletion of a replaced one is retried by billing-due',{skip},async()=>{
 const p=await paidMember('erase-replaced');await stub({op:'subscription',id:p.sub,status:'canceled'});assert.equal(run('sync',{userId:p.id}).sub_status,'canceled');
 fixture('billing-country',{userId:p.id,country:'US'});assert.equal((await p.c.req('billing-checkout',{})).status,200);
 const current=row(p.id).stripe_customer_id;assert.notEqual(current,p.customer);
 // The old customer's deletion is refused once: the account is still deleted, the old customer waits for billing-due.
 await stub({op:'fault',method:'DELETE',path:'^/v1/customers/'+p.customer+'$',status:400,type:'invalid_request_error',times:1});
 let t=Date.now();const del=await p.c.req('account-delete',{password:PASSWORD});assert.equal(del.status,200,JSON.stringify(del.data));
 assert.deepEqual((await since(t,'DELETE')).map(x=>x.path).sort(),['/v1/customers/'+current,'/v1/customers/'+p.customer].sort());
 assert.equal((await stub({op:'customer',id:current})).deleted,true);assert.notEqual((await stub({op:'customer',id:p.customer})).deleted,true);
 let rw=row(p.id);assert.deepEqual([rw.stripe_redact_pending,rw.deleted_at>0],[1,true]);
 assert.ok(audit(p.id,'customer.redact.pending').some(x=>x.detail===p.customer));
 t=Date.now();const due=run('due',{limit:5});assert.ok(due.redacted>=1,JSON.stringify(due));
 assert.deepEqual((await since(t,'DELETE')).map(x=>x.path),['/v1/customers/'+p.customer],'only the one still pending');
 assert.equal((await stub({op:'customer',id:p.customer})).deleted,true);rw=row(p.id);assert.deepEqual([rw.stripe_redact_pending,rw.sync_error],[0,null]);
 assert.ok(fixture('billing-customers',{userId:p.id}).every(x=>x.redacted_at>0),'both deletions confirmed');
});

test('billing-due: refused customer deletions take at most half of the slots and then wait; due accounts are still synced',{skip},async()=>{
 const p=await paidMember('due-share');fixture('billing',{userId:p.id,next_sync_at:now()-1});
 const stuck=Array.from({length:5},(_,i)=>{const s=member('stuck'+i);fixture('billing',{userId:s.id,stripe_customer_id:`cus_stuck${process.pid}x${i}`,stripe_redact_pending:1,deleted_at:now(),livemode:0,updated_at:now()-7200+i});return s;});
 await stub({op:'fault',method:'DELETE',path:'^/v1/customers/cus_stuck',status:400,type:'invalid_request_error',times:20});
 let r=run('due',{limit:5});assert.deepEqual([r.redactFailed,r.redacted],[2,0],'two of the five slots');assert.ok(r.synced+r.busy+r.failed>=1,JSON.stringify(r));
 for(const s of stuck.slice(0,2)){const x=row(s.id);assert.deepEqual([x.sync_error,x.stripe_redact_pending],['redact stripe 400 invalid_request_error/-',1]);}
 // A refused deletion waits an hour at the back of the queue: the next runs take the others, then none of them.
 r=run('due',{limit:5});assert.deepEqual([r.redactFailed,r.redacted],[2,0]);
 r=run('due',{limit:5});assert.deepEqual([r.redactFailed,r.redacted],[1,0]);
 r=run('due',{limit:5});assert.deepEqual([r.redactFailed,r.redacted],[0,0]);
 // After the wait, with Stripe answering again (the stub does not know these customers: gone counts as deleted).
 await stub({op:'clear-faults'});for(const s of stuck)fixture('billing',{userId:s.id,updated_at:now()-3601});
 r=run('due',{limit:10});assert.equal(r.redacted,5,JSON.stringify(r));
 for(const s of stuck){const x=row(s.id);assert.deepEqual([x.stripe_redact_pending,x.sync_error],[0,null]);}
});

test('a new price after stripe-setup --reprice is used at once: a cached price id of another amount is read again',{skip},async()=>{
 // The owner raises the amount in billing_amounts and runs --reprice: the lookup key moves to a new price (the old one
 // stays active for existing subscribers), as stripe-setup.php does with transfer_lookup_key.
 const api=async(path,params)=>{const r=await fetch(stubBase+path,{method:'POST',headers:{Authorization:'Bearer rk_test_stub','Stripe-Version':VERSION,'Idempotency-Key':'matbravo-test-'+crypto.randomUUID(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params).toString()});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;};
 const reprice=amount=>api('/v1/prices',{product:'matbravo_membership',currency:'pln',unit_amount:String(amount),'recurring[interval]':'month',lookup_key:'matbravo_monthly_pln',transfer_lookup_key:'true'});
 const warm=member('reprice-warm'),cw=await signIn(warm.email);assert.equal((await cw.req('billing-checkout',{})).status,200);
 const keys=await prices();assert.equal(JSON.parse(fixture('billing-kv',{})['price:test:matbravo_monthly_pln']).id,keys.matbravo_monthly_pln,'the price id is cached');
 const old=fixture('billing-config-set',{set:{billing_amounts:{pln:999,usd:299}}});const fresh=await reprice(999);
 try{
  const m=member('reprice'),c=await signIn(m.email);assert.equal((await me(c)).billing.amounts.pln,999);
  const t=Date.now();assert.equal((await c.req('billing-checkout',{})).status,200);
  assert.equal((await since(t,'POST',/^\/v1\/checkout\/sessions$/))[0].body.line_items[0].price,fresh.id,'the new price, not the cached old one');
  assert.equal((await since(t,'GET',/^\/v1\/prices$/)).length,1);
 }finally{fixture('billing-config-set',{set:old});await reprice(899);}
});

test('every request the app sent to Stripe carried the pinned version and rk_test_stub, every POST an Idempotency-Key; routes need a session and CSRF',{skip},async()=>{
 const reqs=(await stub({op:'requests'})).filter(x=>!x.probe);assert.ok(reqs.length>50,String(reqs.length));
 for(const x of reqs){
  assert.equal(x.version,VERSION,x.method+' '+x.path);assert.equal(x.authorization,'Bearer rk_test_stub',x.path);
  if(x.method==='POST')assert.match(String(x.idempotencyKey),/^matbravo-/,x.path);else assert.equal(x.idempotencyKey,null,x.path);
 }
 const guest=new Client();await guest.req('session');
 for(const route of ['billing-checkout','billing-sync'])assert.equal((await guest.req(route,{})).status,401,route);
 assert.equal((await fetch(base+'?route=billing-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403,'no CSRF token');
});
