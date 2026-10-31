// Payments over real PHP, MariaDB/MySQL and the Stripe stub (plan §11, §12.8; report 03 §14.2). Run through
// scripts/test-http.sh, which starts tests/stubs/stripe-stub.mjs on <port+1> and writes billing_enabled/enforce=true,
// billing_mode test, rk_test_stub and whsec_test_secret into the test config.
// Scenarios: no full access without payment; checkout (currency from the country, never from the client; Customer with
// its Idempotency-Key; a double click reuses the session; 422 without a country); confirm (foreign or malformed session
// 403, open/expired/incomplete/active, 409 {portal:true} afterwards); staff 402 until paid; Portal; billing-sync and its
// 10 s limit; past_due with grace and its end (billing-due through bin/cron.php); requireFrom → grace → none and the
// grandfathered scope; webhook (valid, duplicate, bad signature, stale timestamp, livemode, bad JSON, unknown type,
// processing failure → 500 then retry, 404 without secrets); /v1/events pull without double processing (stripe-sync.php);
// subscription precedence (reconcile and a late event about an old canceled subscription); Admin tools with audit
// (exempt + warnLive, require, cancelAtPeriodEnd, currency, resync); two parallel syncs = one Stripe call; circuit breaker
// after a network error; account deletion (DELETE /v1/customers, failure → stripe_redact_pending → billing-due retry,
// tombstone); e-mail pushed to Stripe and corrected by sync; 503 when Stripe fails, transparent retry of one 500; and
// every request the app sent carried the pinned Stripe-Version, Bearer rk_test_stub and (POST) an Idempotency-Key.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
const release=process.env.MATDRAW_TEST_RELEASE,skip=!base||!release;
const fixtureScript=fileURLToPath(new URL('./helpers/fixture.php',import.meta.url));
const stubBase=base?`http://127.0.0.1:${Number(new URL(base).port)+1}`:'';
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!',VERSION='2026-09-30.endive',SECRET='whsec_test_secret';
const ERR={unavailable:'Płatności są chwilowo niedostępne. Spróbuj ponownie później.',confirm:'Nie można potwierdzić tej płatności.'};
const now=()=>Math.floor(Date.now()/1000),D=86400;
/** The server may serve a cached config.php for up to ~3 s after a rewrite (opcache.revalidate_freq=2, whole seconds). */
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
 const counts=out.out.match(/^events: events=(\d+) processed=(\d+) duplicates=(\d+) failed=0 complete=yes$/m);assert.ok(counts,out.out);assert.ok(Number(counts[3])>=1,'the webhook event counts as a duplicate');
 const events=fixture('stripe-events');
 assert.deepEqual([events.find(x=>x.event_id===e1.id).source,events.find(x=>x.event_id===e1.id).attempts],['webhook',1]);assert.equal(events.find(x=>x.event_id===e2.id).source,'pull');
 const fetched=await since(t,'GET',new RegExp('^/v1/subscriptions/'+p.sub+'$'));assert.ok(fetched.length>=1);
 const evReq=(await since(t,'GET',/^\/v1\/events$/))[0];assert.equal(evReq.query.types.length,15);assert.ok(Number(evReq.query.created.gte)>0);
 assert.equal((await me(p.c)).access.state,'active');
 const before=fetched.length;const again=cli('stripe-sync.php',['--events']);assert.equal(again.code,0);
 assert.equal((await since(t,'GET',new RegExp('^/v1/subscriptions/'+p.sub+'$'))).length,before,'a second pull fetches nothing again');
 assert.ok(fixture('billing-kv',{})['events_cursor:test'],'cursor stored');
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
 const cd=await signIn(de.email);const t2=Date.now();await cd.req('billing-checkout',{});
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
 await stub({op:'delay',method:'GET',path:'^/v1/subscriptions$',ms:1500,times:2});
 const t=Date.now();
 const outcomes=await Promise.all([fixtureAsync('billing-run',{fn:'sync-user',userId:p.id}),fixtureAsync('billing-run',{fn:'sync-user',userId:p.id})]);
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
 fixture('billing-country',{userId:p.id,country:'PL'});
 let t=Date.now();const r=await p.c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 const sessions=await since(t,'POST',/^\/v1\/checkout\/sessions$/);assert.deepEqual(sessions.map(x=>x.body.line_items[0].price),[keys.matbravo_monthly_pln,keys.matbravo_monthly_pln]);
 const [created]=await since(t,'POST',/^\/v1\/customers$/);assert.equal(created.idempotencyKey,`matbravo-customer-${p.id}-test-1`);
 const swapped=row(p.id);assert.notEqual(swapped.stripe_customer_id,p.customer);assert.equal(sessions[1].body.customer,swapped.stripe_customer_id);
 assert.deepEqual([swapped.customer_seq,swapped.stripe_subscription_id,swapped.sub_status],[1,null,'none']);
 assert.ok(audit(p.id,'customer.replace').some(a=>a.detail===`${p.customer} -> ${swapped.stripe_customer_id}`));
 // Deleted in the Dashboard: the next checkout notices it, forgets the customer and starts with a new one.
 const q=member('gone'),cq=await signIn(q.email);const first=await cq.req('billing-checkout',{});const old=row(q.id).stripe_customer_id;
 await stub({op:'expire-session',sessionId:sessionOf(first.data.url)});await stub({op:'delete-customer',id:old});
 t=Date.now();const again=await cq.req('billing-checkout',{});assert.equal(again.status,200,JSON.stringify(again.data));
 const fresh=row(q.id);assert.notEqual(fresh.stripe_customer_id,old);assert.equal(fresh.customer_seq,1);
 assert.deepEqual((await since(t,'POST',/^\/v1\/customers$/)).map(x=>x.idempotencyKey),[`matbravo-customer-${q.id}-test-1`]);
 assert.ok(audit(q.id,'customer.deleted').some(a=>a.detail===old));
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
