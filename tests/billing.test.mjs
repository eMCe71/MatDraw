// billing-backend units through tests/php-bridge-billing.php (plan §11, report 03 §14.1): StripeSignature::verify (every
// case with an injected clock, rotation and the ±300 s window), subscription shapes ('basil'+ item periods and the older
// top-level fields), next_sync_at, StripeClient::norm, the subscription precedence rule (all pairs of states) and the
// best-of-list used by reconcile, invoice → subscription, event validation, the config checks of billing, and the HTTP
// client against the Stripe stub (retries with the same Idempotency-Key, Stripe-Should-Retry, background mode without
// retries and its circuit breaker, the reachability probe).
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const php=process.env.PHP_BIN,skip=!php;
function bridge(input){const r=spawnSync(php,['tests/php-bridge-billing.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const NOW=1_800_000_000,D=86400,H=3600;
const sign=(payload,secret,t)=>crypto.createHmac('sha256',secret).update(t+'.'+payload).digest('hex');

test('StripeSignature::verify: valid, tampered, wrong secret, rotation, several v1, ±300 s, malformed headers',{skip},()=>{
 const body='{"id":"evt_1","object":"event"}',s='whsec_test_secret',other='whsec_other_secret',t=NOW;
 const v=sign(body,s,t),cases=[
  ['valid',body,`t=${t},v1=${v}`,[s],true],
  ['valid with spaces and a v0',body,`t=${t}, v1=${v}, v0=${'0'.repeat(64)}`,[s],true],
  ['tampered body',body+' ',`t=${t},v1=${v}`,[s],false],
  ['wrong secret',body,`t=${t},v1=${v}`,[other],false],
  ['rotation: second of two secrets',body,`t=${t},v1=${v}`,[other,s],true],
  ['two v1 values, the second valid',body,`t=${t},v1=${sign(body,other,t)},v1=${v}`,[s],true],
  ['two v1 values, none valid',body,`t=${t},v1=${sign(body,other,t)},v1=${'a'.repeat(64)}`,[s],false],
  ['300 s old is accepted',body,`t=${t-300},v1=${sign(body,s,t-300)}`,[s],true],
  ['301 s old',body,`t=${t-301},v1=${sign(body,s,t-301)}`,[s],false],
  ['301 s in the future',body,`t=${t+301},v1=${sign(body,s,t+301)}`,[s],false],
  ['signature of another timestamp',body,`t=${t},v1=${sign(body,s,t-1)}`,[s],false],
  ['missing t',body,`v1=${v}`,[s],false],
  ['non-numeric t',body,`t=12a,v1=${v}`,[s],false],
  ['non-hex v1',body,`t=${t},v1=${'z'.repeat(64)}`,[s],false],
  ['upper-case hex',body,`t=${t},v1=${v.toUpperCase()}`,[s],false],
  ['short v1',body,`t=${t},v1=${v.slice(0,63)}`,[s],false],
  ['only v0',body,`t=${t},v0=${v}`,[s],false],
  ['empty secrets list',body,`t=${t},v1=${v}`,[],false],
  ['empty header',body,'',[s],false],
 ];
 const out=bridge({job:'signature',cases:cases.map(([,payload,header,secrets])=>({payload,header,secrets,now:NOW}))});
 cases.forEach(([name,,,,want],i)=>assert.equal(out[i],want,name));
 const window=bridge({job:'signature',cases:[{payload:body,header:`t=${t-50},v1=${sign(body,s,t-50)}`,secrets:[s],now:NOW,tolerance:30}]});
 assert.deepEqual(window,[false],'tolerance parameter');
});

const KEYS=['matbravo_monthly_pln','matbravo_monthly_usd'];
const item=(lookup,extra={})=>({id:'si_1',object:'subscription_item',price:{id:'price_1',product:'matbravo_membership',lookup_key:lookup,currency:'pln'},...extra});
const basil=(o={})=>({id:'sub_A',object:'subscription',customer:'cus_1',status:'active',created:NOW-10*D,currency:'pln',livemode:false,cancel_at_period_end:false,cancel_at:null,canceled_at:null,ended_at:null,
 items:{data:[item('matbravo_monthly_pln',{current_period_start:NOW-5*D,current_period_end:NOW+25*D})]},latest_invoice:{id:'in_1',status:'paid'},...o});
test('stateFromSubscription: basil item periods, older top-level periods, foreign prices, invoice id or object',{skip},()=>{
 const old={...basil(),current_period_start:NOW-1,current_period_end:NOW+1,items:{data:[item('matbravo_monthly_usd')]},latest_invoice:'in_2',currency:'USD',customer:{id:'cus_2',object:'customer',email:'x@y.z'}};
 const subs=[basil(),old,basil({items:{data:[item('someone_else',{price:{id:'price_x',product:'prod_other',lookup_key:'someone_else'}})]}}),
  basil({items:{data:[{id:'si_r',price:{id:'price_r',product:'matbravo_membership',lookup_key:null},current_period_start:1,current_period_end:2}]}}),
  basil({cancel_at_period_end:true,cancel_at:NOW+25*D,canceled_at:NOW,livemode:true,status:'trialing'}),
  basil({items:{data:[item('matbravo_monthly_pln',{current_period_start:NOW-5*D,current_period_end:NOW+25*D})]},current_period_start:1,current_period_end:2})];
 const out=bridge({job:'state',keys:KEYS,subs});
 assert.deepEqual(out[0],{stripe_subscription_id:'sub_A',sub_status:'active',price_lookup_key:'matbravo_monthly_pln',currency:'pln',current_period_start:NOW-5*D,current_period_end:NOW+25*D,
  cancel_at_period_end:0,cancel_at:null,canceled_at:null,ended_at:null,latest_invoice_status:'paid',livemode:0,stripe_customer_id:'cus_1',created:NOW-10*D});
 assert.deepEqual([out[1].current_period_start,out[1].current_period_end,out[1].latest_invoice_status,out[1].currency,out[1].stripe_customer_id,out[1].price_lookup_key],[NOW-1,NOW+1,null,'usd','cus_2','matbravo_monthly_usd'],'pre-basil fields, invoice id, expanded customer');
 assert.deepEqual([out[2].sub_status,out[2].price_lookup_key],['foreign',null],'a price of another product');
 assert.deepEqual([out[3].sub_status,out[3].price_lookup_key,out[3].current_period_end],['active',null,2],'repriced: our product without the lookup key');
 assert.deepEqual([out[4].sub_status,out[4].cancel_at_period_end,out[4].cancel_at,out[4].livemode],['trialing',1,NOW+25*D,1]);
 assert.equal(out[5].current_period_end,NOW+25*D,'item periods win over stale top-level fields');
});

test('next_sync_at follows 03 §8.3: renewal, cancel at period end, past_due, incomplete, pending checkout, none; 7-day cap and minimum interval',{skip},()=>{
 const end=NOW+5*D,st=(sub_status,o={})=>({sub_status,current_period_end:end,cancel_at_period_end:0,latest_invoice_status:'paid',...o});
 const cases=[
  ['active, invoice paid → period end + 2 h',st('active'),end+2*H],
  ['trialing, invoice paid',st('trialing'),end+2*H],
  ['active, renewal invoice open → now + 2 h',st('active',{latest_invoice_status:'open'}),NOW+2*H],
  ['active, renewal invoice draft',st('active',{latest_invoice_status:'draft'}),NOW+2*H],
  ['active, unknown invoice status',st('active',{latest_invoice_status:null}),end+2*H],
  ['cancel at period end → period end + 5 min',st('active',{cancel_at_period_end:1}),end+300],
  ['past_due → now + 6 h',st('past_due'),NOW+6*H],
  ['incomplete → now + 10 min',st('incomplete'),NOW+600],
  ['paused → 7 days',st('paused'),NOW+7*D],
  ['pending checkout, no subscription → expiry + 5 min',{sub_status:'none',pending_checkout_id:'cs_test_x',pending_checkout_expires:NOW+3600},NOW+3900],
  ['pending checkout after a canceled subscription',{sub_status:'canceled',pending_checkout_id:'cs_test_x',pending_checkout_expires:NOW+3600},NOW+3900],
  ...['canceled','incomplete_expired','unpaid','none','foreign'].map(s=>[s+' → no polling',st(s),null]),
  ['cap at 7 days',st('active',{current_period_end:NOW+40*D}),NOW+7*D],
  ['period end in the past → not before the minimum interval',st('active',{current_period_end:NOW-5*D}),NOW+600],
 ];
 const out=bridge({job:'next',cases:cases.map(([,state])=>({state,now:NOW}))});
 cases.forEach(([name,,want],i)=>assert.equal(out[i],want,name));
 assert.deepEqual(bridge({job:'next',cases:[{state:st('incomplete'),now:NOW,min:1800}]}),[NOW+1800],'billing_sync_min_interval');
});

test('requireFrom for the grandfathered scope: 14 calendar days in Europe/Warsaw, also across both clock changes',{skip},()=>{
 const at=(iso)=>Math.floor(Date.parse(iso)/1000);
 const out=bridge({job:'grandfathered',cases:[
  {now:at('2027-03-20T11:00:00Z'),date:'2027-04-03'},// spring change on 2027-03-28: 14 days are 14*86400 − 3600
  {now:at('2027-03-20T23:30:00Z'),date:'2027-04-04'},// 00:30 on 21 March in Warsaw: the day of now counts
  {now:at('2026-10-20T10:00:00Z'),date:'2026-11-03'},// autumn change on 2026-10-25
  {now:at('2026-11-05T10:00:00Z'),date:'2026-11-19'},
 ]});
 for(const [min,day] of out)assert.equal(day,min,'the date 14 calendar days ahead is exactly the earliest allowed one');
 assert.equal(out[0][0],at('2027-04-02T22:00:00Z'),'00:00 CEST on 3 April');
});

test('StripeClient::norm: booleans as true/false, nulls dropped, nested arrays and lists in Stripe brackets',{skip},()=>{
 const out=bridge({job:'norm',params:{a:true,b:false,c:null,d:{e:1,f:['x','y'],g:null},h:'s t',expand:['data.customer']}});
 assert.deepEqual(out.norm,{a:'true',b:'false',d:{e:'1',f:['x','y']},h:'s t',expand:['data.customer']});
 assert.equal(out.encoded,'a=true&b=false&d%5Be%5D=1&d%5Bf%5D%5B0%5D=x&d%5Bf%5D%5B1%5D=y&h=s+t&expand%5B0%5D=data.customer');
});

const STATES=['active','trialing','past_due','incomplete','canceled','incomplete_expired','unpaid','paused','foreign','none'],ONGOING=new Set(STATES.slice(0,4));
test('subscription precedence: non-terminal beats terminal, then the newer created; ties keep the current one (all pairs)',{skip},()=>{
 const cases=[];for(const cur of STATES)for(const inc of STATES)for(const [cc,ic] of [[100,200],[200,100],[150,150]])cases.push([cur,cc,inc,ic]);
 const out=bridge({job:'prefer',cases});
 cases.forEach(([cur,cc,inc,ic],i)=>{const want=ONGOING.has(inc)!==ONGOING.has(cur)?ONGOING.has(inc):ic>cc;assert.equal(out[i],want,`${cur}@${cc} vs incoming ${inc}@${ic}`);});
 // The case of the review (S5): A canceled, B active.
 const [keepB,takeB]=bridge({job:'prefer',cases:[['active',200,'canceled',100],['canceled',100,'active',200]]});
 assert.equal(keepB,false,'an old canceled subscription never replaces a new active one');assert.equal(takeB,true);
 const s=(id,sub_status,created)=>({stripe_subscription_id:id,sub_status,created});
 const lists=[[s('sub_A','canceled',100),s('sub_B','active',200)],[s('sub_B','active',200),s('sub_A','canceled',100)],[s('sub_A','canceled',300),s('sub_B','past_due',100)],
  [s('sub_A','active',300),s('sub_B','active',200)],[s('sub_A','canceled',100),s('sub_B','unpaid',200)],[s('sub_A','active',100),s('sub_B','active',100)],[s('sub_B','active',100),s('sub_A','active',100)],[]];
 assert.deepEqual(bridge({job:'best',lists}),['sub_B','sub_B','sub_B','sub_A','sub_B','sub_B','sub_B',null]);
});

test('invoice → subscription id (basil parent, older field, expanded object) and event validation',{skip},()=>{
 const inv=[{parent:{type:'subscription_details',subscription_details:{subscription:'sub_1'}}},{subscription:'sub_2'},{parent:{type:'quote_details'},subscription:'sub_3'},
  {parent:{type:'subscription_details',subscription_details:{subscription:{id:'sub_4',object:'subscription'}}}},{},{parent:null,subscription:null}];
 assert.deepEqual(bridge({job:'invoice-sub',invoices:inv}),['sub_1','sub_2','sub_3','sub_4',null,null]);
 const ev=(o={})=>({id:'evt_1AbC',object:'event',type:'invoice.paid',livemode:false,data:{object:{id:'in_1'}},...o});
 const cases=[[ev(),'test',true],[ev({livemode:true}),'live',true],[ev({livemode:true}),'test',false],[ev(),'live',false],[ev({object:'charge'}),'test',false],[ev({id:'evt_'}),'test',false],
  [ev({id:'evt_../x'}),'test',false],[ev({id:'ch_1'}),'test',false],[ev({livemode:'false'}),'test',false],[ev({data:{}}),'test',false],[ev({type:'Invoice Paid'}),'test',false],['x','test',false]];
 assert.deepEqual(bridge({job:'valid-event',cases:cases.map(([event,mode])=>({event,mode}))}),cases.map(c=>c[2]));
});

test('routes and jobs of the payments are registered with the modes, users, limits and needsFlush of §4.2 and §3.7',{skip},()=>{
 const routes=['billing-checkout','billing-confirm','billing-portal','billing-sync','admin-billing','admin-billing-action','stripe-webhook'];
 const out=bridge({job:'registry',routes,jobs:['billing-due','billing-events']});
 assert.deepEqual(out.routes,{'billing-checkout':['POST','session','required',1024],'billing-confirm':['POST','session','required',1024],'billing-portal':['POST','session','required',1024],
  'billing-sync':['POST','session','required',1024],'admin-billing':['GET','peek','admin',null],'admin-billing-action':['POST','session','admin',4096],'stripe-webhook':['POST','webhook',null,1048576]});
 assert.deepEqual(out.jobs,{'billing-due':[600,true],'billing-events':[900,true]});
});

test('matdraw_config refuses a key of another mode and webhook secrets without whsec_',{skip},()=>{
 const BILL={error:'RuntimeException: Invalid billing configuration.'},on={billing_enabled:true,allow_insecure_http:true};
 const cases=[[{...on,stripe_secret_key:'rk_test_abc'},{ok:'valid'}],[{...on,stripe_secret_key:'rk_live_abc'},BILL],[{...on,billing_mode:'live',stripe_secret_key:'rk_test_abc'},BILL],
  [{...on,billing_mode:'live',stripe_secret_key:'rk_live_abc'},{ok:'valid'}],[{...on,stripe_secret_key:'pk_test_abc'},BILL],[{...on,stripe_secret_key:'rk_test_abc',stripe_webhook_secrets:['whsec_a','whsec_b']},{ok:'valid'}],
  [{...on,stripe_secret_key:'rk_test_abc',stripe_webhook_secrets:['secret_a']},BILL],[{...on,stripe_secret_key:'rk_test_abc',stripe_webhook_secrets:['whsec_a','b']},BILL],
  [{...on,stripe_secret_key:'rk_test_abc',stripe_api_base:'http://127.0.0.1:1'},{ok:'valid'}],[{...on,stripe_secret_key:'rk_test_abc',stripe_api_base:'http://stripe.example'},BILL]];
 assert.deepEqual(bridge({job:'config',cases:cases.map(c=>c[0])}),cases.map(c=>c[1]));
});

// ---- HTTP client against the stub (an ephemeral port; nothing leaves 127.0.0.1) ----------------------------------
let stub=null,base='';
before(async()=>{
 if(skip)return;
 stub=spawn(process.execPath,['tests/stubs/stripe-stub.mjs','0'],{stdio:['ignore','pipe','inherit']});
 base=await new Promise((ok,fail)=>{let out='';stub.stdout.on('data',d=>{out+=d;const m=out.match(/127\.0\.0\.1:(\d+)/);if(m)ok('http://127.0.0.1:'+m[1]);});stub.on('exit',()=>fail(Error('stub exited')));});
});
after(()=>stub?.kill());
const control=async body=>(await fetch(base+'/__control',{method:'POST',body:JSON.stringify(body)})).json();
const closed='http://127.0.0.1:1';

test('StripeClient: pinned version and Bearer key on every request, retries reuse the Idempotency-Key, Stripe-Should-Retry decides',{skip},async()=>{
 await control({op:'reset'});
 await control({op:'fault',method:'POST',path:'^/v1/customers$',status:500,times:1});
 await control({op:'fault',method:'GET',path:'^/v1/prices$',status:429,shouldRetry:true,times:1});
 const [cus,prices]=bridge({job:'client',base,cases:[{method:'POST',path:'/v1/customers',params:{email:'a@example.test'},idem:'matbravo-test-1'},{method:'GET',path:'/v1/prices',params:{lookup_keys:['matbravo_monthly_pln']}}]});
 assert.match(cus.ok.id,/^cus_/);assert.equal(prices.ok.data.length,1);
 let r=await control({op:'requests',clear:true});
 assert.deepEqual(r.map(x=>[x.method,x.path,x.fault??null]),[['POST','/v1/customers',500],['POST','/v1/customers',null],['GET','/v1/prices',429],['GET','/v1/prices',null]]);
 for(const x of r){assert.equal(x.version,'2026-09-30.endive');assert.equal(x.authorization,'Bearer rk_test_stub');}
 assert.deepEqual(r.filter(x=>x.method==='POST').map(x=>x.idempotencyKey),['matbravo-test-1','matbravo-test-1'],'the retry reuses the key');
 assert.equal(r.find(x=>x.method==='GET').idempotencyKey,null,'no key on GET');
 // Stripe-Should-Retry: false stops retries even for a 500; 400 is never retried; a dropped connection is.
 await control({op:'fault',method:'GET',path:'^/v1/account$',status:500,shouldRetry:false,times:2});
 await control({op:'fault',method:'GET',path:'^/v1/products/',status:400,type:'invalid_request_error',times:2});
 await control({op:'fault',method:'GET',path:'^/v1/events$',kind:'drop',times:1});
 const [noRetry,bad,dropped,auto]=bridge({job:'client',base,cases:[{method:'GET',path:'/v1/account'},{method:'GET',path:'/v1/products/matbravo_membership'},{method:'GET',path:'/v1/events'},{method:'POST',path:'/v1/customers',params:{email:'b@example.test'}}]});
 assert.deepEqual([noRetry.status,bad.status,dropped.ok.object],[500,400,'list']);
 r=await control({op:'requests',clear:true});
 assert.deepEqual(r.map(x=>x.path),['/v1/account','/v1/products/matbravo_membership','/v1/events','/v1/events','/v1/customers']);
 assert.match(auto.ok.id,/^cus_/);assert.match(r.at(-1).idempotencyKey,/^matbravo-[0-9a-f]{32}$/,'a random key when none is given');
});

test('StripeClient background mode: no retries, a 5xx or network error opens the breaker, an open breaker sends nothing',{skip},async()=>{
 await control({op:'reset'});await control({op:'clear'});
 await control({op:'fault',method:'GET',path:'^/v1/subscriptions$',status:503,times:1});
 const t0=Math.floor(Date.now()/1000);
 const [five,again,missing]=bridge({job:'client',base,cases:[{background:true,method:'GET',path:'/v1/subscriptions'},{background:true,method:'GET',path:'/v1/subscriptions'},{background:true,method:'GET',path:'/v1/subscriptions/sub_nope',kv:{}}]});
 assert.equal(five.status,503);const until=Number(five.kv.stripe_down_until);assert.ok(until>=t0+600&&until<=t0+610,'stripe_down_until = now + stripe_down_seconds');
 assert.deepEqual([again.type,again.status],['circuit_open',0],'open breaker: no request');
 assert.deepEqual([missing.status,missing.kv],[404,[]],'a 4xx does not open the breaker');
 let r=await control({op:'requests',clear:true});assert.deepEqual(r.map(x=>x.path),['/v1/subscriptions','/v1/subscriptions/sub_nope'],'one request for the 503, none while open');
 const [net,interactive]=bridge({job:'client',cases:[{base:closed,background:true,method:'GET',path:'/v1/events',cfg:{stripe_down_seconds:120}},{base:closed,method:'GET',path:'/v1/events',cfg:{stripe_timeout_seconds:2}}]});
 assert.deepEqual([net.type,net.status],['network',0]);assert.ok(Number(net.kv.stripe_down_until)>=t0+120);
 assert.deepEqual([interactive.type,interactive.status],['network',0]);assert.ok(interactive.ms>=500,'interactive retried with backoff before giving up');
 const expired=bridge({job:'client',base,cases:[{background:true,method:'GET',path:'/v1/events',kv:{stripe_down_until:String(t0-1)}}]})[0];
 assert.equal(expired.ok.object,'list','a breaker in the past is closed');
});

test('probe: unauthenticated GET /v1/charges, 401 JSON = reachable; refused connection and refused bases are reported',{skip},async()=>{
 await control({op:'clear'});
 const [ok,down,https]=bridge({job:'probe',bases:[base,closed,'http://example.com']});
 assert.deepEqual([ok.reachable,ok.status,ok.error],[true,401,null]);assert.equal(typeof ok.ms,'number');assert.ok(ok.tls===null||typeof ok.tls==='string');
 assert.equal(down.reachable,false);assert.match(down.error,/^curl \d+: /);
 assert.deepEqual([https.reachable,https.error],[false,'stripe_api_base not allowed']);
 const r=await control({op:'requests',clear:true});assert.deepEqual(r.map(x=>[x.path,x.authorization,x.probe]),[['/v1/charges',null,true]],'never a key');
 assert.match(bridge({job:'bad-path',base,path:'/v1/customers?email=x'}).error,/Invalid Stripe path/);
 assert.match(bridge({job:'bad-path',base,path:'/v2/../v1/x'}).error,/Invalid Stripe path/);
 const bases=bridge({job:'bad-base',bases:[[base,false],['http://10.0.0.1',true],['https://api.stripe.com',false]]});
 assert.deepEqual(bases.map(b=>b.error??'ok'),['RuntimeException: Invalid billing configuration.','RuntimeException: Invalid billing configuration.','ok']);
});
