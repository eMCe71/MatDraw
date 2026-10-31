// Local stand-in for the Stripe API (plan §6.11, §12.8; replaces report 03 §14.2): node tests/stubs/stripe-stub.mjs <port> [--empty]
// scripts/test-http.sh starts it on <port+1>. State lives in memory; nothing leaves 127.0.0.1.
// Strict about the client contract: every /v1 request needs "Authorization: Bearer (sk|rk)_test_…" and a Stripe-Version
// header, every POST an Idempotency-Key (same key + same parameters → the stored answer, other parameters → 400
// idempotency_error, like Stripe); Checkout refuses payment_method_types (removed in 'endive'). Objects have the 'basil'+
// shapes: subscription periods on the items, invoice → parent.subscription_details.subscription.
// Without a key GET /v1/charges answers 401 JSON (the reachability probe). --empty starts without product and prices
// (stripe-setup.php test); otherwise matbravo_membership with matbravo_monthly_pln (899) and _usd (299) and the portal
// configuration bpc_stub exist.
// Control (no auth): POST /__control {op,…} with op
//   reset {empty?}  requests {path?, clear?} → recorded requests  clear  state
//   pay {sessionId, status='active', invoice='paid', created?}      completes a Checkout Session with a new subscription
//   subscription {id, status?, cancel_at_period_end?, current_period_start?, current_period_end?, invoice?, created?, event?}
//   create-subscription {customer, status='active', created?, lookup_key='matbravo_monthly_pln', metadata?, invoice?}
//   expire-session {sessionId}   event {type, object}   events {}   customer {id}   delete-customer {id} (as in the Dashboard)
//   A customer keeps the currency of its first paid session: Checkout in another currency answers 400 (03 §3.3).
//   fault {method?, path? (regex), kind:'status'|'drop', status, type?, code?, message?, param?, shouldRetry?, times=1}
//   delay {method?, path?, ms, times=1}   clear-faults {}
// Every /v1 request is recorded as {method, path, query, body, version, idempotencyKey, authorization, fault?}.
import http from 'node:http';
import crypto from 'node:crypto';

const port=Number(process.argv[2]??12111),EMPTY=process.argv.includes('--empty');
const now=()=>Math.floor(Date.now()/1000),clone=o=>o==null?o:structuredClone(o);
const ALNUM='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const rand=(n=14)=>Array.from(crypto.randomBytes(n),b=>ALNUM[b%62]).join('');
let S;
function reset(empty=EMPTY){
 S={seq:0,products:{},prices:{},customers:{},sessions:{},subscriptions:{},invoices:{},portal:{},webhooks:{},events:[],requests:[],idem:{},faults:[],delays:[]};
 if(empty)return;
 S.products.matbravo_membership={id:'matbravo_membership',object:'product',active:true,name:'MatBravo',description:'MatBravo account (monthly)',metadata:{matbravo_key:'membership'},livemode:false};
 for(const [cur,amount] of [['pln',899],['usd',299]])price({product:'matbravo_membership',currency:cur,unit_amount:amount,recurring:{interval:'month',interval_count:1},lookup_key:'matbravo_monthly_'+cur,nickname:'MatBravo monthly '+cur.toUpperCase(),metadata:{matbravo_key:'monthly_'+cur}});
 S.portal.bpc_stub={id:'bpc_stub',object:'billing_portal.configuration',active:true,metadata:{matbravo_key:'portal_v1'},features:{},livemode:false};
}
function price(p){const id='price_'+rand();S.prices[id]={id,object:'price',active:true,type:'recurring',product:p.product,currency:p.currency,unit_amount:Number(p.unit_amount),recurring:{interval:p.recurring?.interval,interval_count:Number(p.recurring?.interval_count||1)},lookup_key:p.lookup_key||null,nickname:p.nickname||null,metadata:p.metadata||{},livemode:false,created:now()};return S.prices[id];}
reset();

class StripeErr extends Error{constructor(status,type,message,code,param,headers={}){super(message);Object.assign(this,{status,type,code,param,headers});}}
const missing=(what,id,param)=>new StripeErr(404,'invalid_request_error',`No such ${what}: '${id}'`,'resource_missing',param);
const invalid=(message,param,code)=>new StripeErr(400,'invalid_request_error',message,code,param);

/** Stripe form/query decoding with brackets: a[b][0]=x, a[]=y. Objects whose keys are 0..n-1 become arrays. */
function parseForm(s){
 const out={};
 for(const part of (s||'').split('&')){if(!part)continue;const i=part.indexOf('=');const dec=x=>decodeURIComponent(x.replace(/\+/g,' '));
  const k=dec(i<0?part:part.slice(0,i)),v=dec(i<0?'':part.slice(i+1));const m=k.match(/^([^[\]]+)((?:\[[^\]]*\])*)$/);if(!m)continue;
  const path=[m[1],...[...m[2].matchAll(/\[([^\]]*)\]/g)].map(x=>x[1])];let o=out;
  for(let j=0;j<path.length;j++){let key=path[j];if(key==='')key=String(Object.keys(o).length);if(j===path.length-1)o[key]=v;else{if(typeof o[key]!=='object')o[key]={};o=o[key];}}
 }
 const arrays=o=>{if(o&&typeof o==='object'){for(const k of Object.keys(o))o[k]=arrays(o[k]);const ks=Object.keys(o);if(ks.length&&ks.every((k,i)=>k===String(i)))return ks.map(k=>o[k]);}return o;};
 return arrays(out);
}
const list=(url,data,has_more=false)=>({object:'list',url,has_more,data});
function page(url,items,q){// newest first; starting_after; limit
 let start=0;if(q.starting_after){const i=items.findIndex(x=>x.id===q.starting_after);start=i<0?items.length:i+1;}
 const limit=Math.min(100,Math.max(1,Number(q.limit||10)));const data=items.slice(start,start+limit);return list(url,data,start+limit<items.length);
}
const newestFirst=(a,b)=>(b.created-a.created)||(b._seq-a._seq);
const strip=o=>{if(o&&typeof o==='object'){if(Array.isArray(o))return o.map(strip);const r={};for(const [k,v] of Object.entries(o))if(!k.startsWith('_'))r[k]=strip(v);return r;}return o;};

function event(type,object){const e={id:'evt_'+rand(),object:'event',api_version:'2026-09-30.endive',type,livemode:false,created:now(),data:{object:strip(clone(object))},_seq:++S.seq};S.events.push(e);return e;}
function customerView(id){const c=S.customers[id];if(!c)return id;return c.deleted?{id,object:'customer',deleted:true}:strip(clone(c));}
function invoice(sub,status){const id='in_'+rand();S.invoices[id]={id,object:'invoice',status,customer:sub.customer,currency:sub.currency,parent:{type:'subscription_details',subscription_details:{subscription:sub.id,metadata:sub.metadata}},livemode:false,created:now()};return S.invoices[id];}
function subView(sub,expand=[]){
 const o=strip(clone(sub));
 if(expand.includes('latest_invoice')&&o.latest_invoice)o.latest_invoice=strip(clone(S.invoices[o.latest_invoice]));
 if(expand.includes('customer'))o.customer=customerView(o.customer);
 return o;
}
function sessionView(s,expand=[]){const o=strip(clone(s));if(expand.includes('subscription')&&o.subscription)o.subscription=subView(S.subscriptions[o.subscription],expand.filter(x=>x.startsWith('subscription.')).map(x=>x.slice(13)));return o;}
function newSubscription({customer,priceId,status='active',created=now(),metadata={},invoiceStatus='paid',start=now(),end}){
 const p=S.prices[priceId];if(!p)throw missing('price',priceId);
 const id='sub_'+rand();const sub={id,object:'subscription',customer,status,created:Number(created),currency:p.currency,livemode:false,metadata:metadata||{},cancel_at_period_end:false,cancel_at:null,canceled_at:null,ended_at:null,
  items:{object:'list',data:[{id:'si_'+rand(),object:'subscription_item',quantity:1,price:clone(p),current_period_start:Number(start),current_period_end:Number(end??Number(start)+30*86400)}]},latest_invoice:null,_seq:++S.seq};
 S.subscriptions[id]=sub;sub.latest_invoice=invoice(sub,invoiceStatus).id;return sub;
}
function setSub(sub,f){
 if(f.status!==undefined){sub.status=f.status;if(['canceled','incomplete_expired'].includes(f.status)){sub.ended_at??=now();sub.canceled_at??=now();}}
 if(f.cancel_at_period_end!==undefined){const on=f.cancel_at_period_end===true||f.cancel_at_period_end==='true';sub.cancel_at_period_end=on;sub.cancel_at=on?sub.items.data[0].current_period_end:null;sub.canceled_at=on?now():null;}
 for(const k of ['current_period_start','current_period_end'])if(f[k]!==undefined)sub.items.data[0][k]=Number(f[k]);
 if(f.created!==undefined)sub.created=Number(f.created);
 if(f.invoice!==undefined)sub.latest_invoice=invoice(sub,f.invoice).id;
}

/** Routes of the fake API: (method, path segments, query, body, idempotency key) → [status, object]. */
function api(m,parts,q,b){
 const [res,id,sub]=parts;const exp=[].concat(q.expand||b.expand||[]);
 if(res==='charges'&&m==='GET')return list('/v1/charges',[]);
 if(res==='account'&&m==='GET')return {id:'acct_stub',object:'account',country:'PL',default_currency:'pln',settings:{dashboard:{display_name:'MatBravo (stub)'}}};
 if(res==='products'){
  if(m==='GET'&&id){const p=S.products[id];if(!p)throw missing('product',id);return p;}
  if(m==='POST'&&!id){if(!b.id||!b.name)throw invalid('Missing required param: name.','name');if(S.products[b.id])throw new StripeErr(400,'invalid_request_error','Product already exists.','resource_already_exists','id');
   return S.products[b.id]={id:b.id,object:'product',active:true,name:b.name,description:b.description||null,metadata:b.metadata||{},livemode:false};}
  if(m==='POST'&&id){const p=S.products[id];if(!p)throw missing('product',id);if(b.active!==undefined)p.active=b.active==='true';return p;}
 }
 if(res==='prices'){
  if(m==='GET'&&!id){let all=Object.values(S.prices);const keys=[].concat(q.lookup_keys||[]);if(keys.length)all=all.filter(p=>keys.includes(p.lookup_key));if(q.active!==undefined)all=all.filter(p=>String(p.active)===q.active);return page('/v1/prices',all,q);}
  if(m==='POST'&&!id){if(!S.products[b.product])throw missing('product',b.product,'product');
   const old=Object.values(S.prices).find(p=>b.lookup_key&&p.lookup_key===b.lookup_key);
   if(old){if(b.transfer_lookup_key!=='true')throw invalid('A price with this lookup key already exists.','lookup_key');old.lookup_key=null;}
   return price(b);}
 }
 if(res==='customers'){
  if(m==='POST'&&!id){const c={id:'cus_'+rand(),object:'customer',email:b.email||null,preferred_locales:[].concat(b.preferred_locales||[]),metadata:b.metadata||{},livemode:false,created:now()};return S.customers[c.id]=c;}
  const c=S.customers[id];
  if(!c||(c.deleted&&m!=='GET'))throw missing('customer',id);
  if(m==='GET')return customerView(id);
  if(m==='POST'){if(b.email!==undefined)c.email=b.email;if(b.metadata)Object.assign(c.metadata,b.metadata);event('customer.updated',c);return c;}
  if(m==='DELETE'){c.deleted=true;for(const s of Object.values(S.subscriptions))if(s.customer===id&&!['canceled','incomplete_expired'].includes(s.status)){setSub(s,{status:'canceled'});event('customer.subscription.deleted',s);}
   event('customer.deleted',{id,object:'customer',deleted:true});return {id,object:'customer',deleted:true};}
 }
 if(res==='checkout'&&id==='sessions'){
  const sid=sub;
  if(m==='POST'&&!sid){
   if(b.payment_method_types!==undefined)throw invalid('Received unknown parameter: payment_method_types','payment_method_types');
   if(b.mode!=='subscription')throw invalid('mode must be subscription in this stub','mode');
   if(!S.customers[b.customer]||S.customers[b.customer].deleted)throw missing('customer',b.customer,'customer');
   const li=b.line_items?.[0];const p=S.prices[li?.price];if(!p||!p.active)throw missing('price',li?.price,'line_items[0][price]');
   if(S.customers[b.customer]._currency&&S.customers[b.customer]._currency!==p.currency)throw invalid('You cannot combine currencies on a single customer.','currency');
   if(!String(b.success_url||'').includes('{CHECKOUT_SESSION_ID}'))throw invalid('success_url needs {CHECKOUT_SESSION_ID} in this stub','success_url');
   const id='cs_test_'+rand(24);
   return S.sessions[id]={id,object:'checkout.session',status:'open',payment_status:'unpaid',mode:'subscription',customer:b.customer,client_reference_id:b.client_reference_id||null,
    url:'https://checkout.stripe.com/c/pay/'+id,expires_at:Number(b.expires_at||now()+86400),metadata:b.metadata||{},currency:p.currency,livemode:false,subscription:null,locale:b.locale||null,
    _price:p.id,_subMeta:b.subscription_data?.metadata||{},success_url:b.success_url,cancel_url:b.cancel_url};
  }
  if(m==='GET'&&sid){const s=S.sessions[sid];if(!s)throw missing('checkout.session',sid);return sessionView(s,exp);}
 }
 if(res==='subscriptions'){
  if(m==='GET'&&!id){let all=Object.values(S.subscriptions).sort(newestFirst);if(q.customer)all=all.filter(s=>s.customer===q.customer);
   if(q.status&&q.status!=='all')all=all.filter(s=>s.status===q.status);else if(!q.status)all=all.filter(s=>s.status!=='canceled');
   const p=page('/v1/subscriptions',all,q);const inner=exp.filter(x=>x.startsWith('data.')).map(x=>x.slice(5));p.data=p.data.map(s=>subView(s,inner));return p;}
  const s=S.subscriptions[id];if(!s)throw missing('subscription',id);
  if(m==='GET')return subView(s,exp);
  if(m==='POST'){setSub(s,b);event('customer.subscription.updated',s);return subView(s,exp);}
 }
 if(res==='billing_portal'){
  if(id==='sessions'&&m==='POST'){if(!S.customers[b.customer]||S.customers[b.customer].deleted)throw missing('customer',b.customer,'customer');if(b.configuration&&!S.portal[b.configuration])throw missing('billing_portal.configuration',b.configuration,'configuration');
   return {id:'bps_'+rand(),object:'billing_portal.session',customer:b.customer,return_url:b.return_url,locale:b.locale||null,url:'https://billing.stripe.com/p/session/test_'+rand(20)};}
  if(id==='configurations'){
   if(m==='GET'&&!sub){let all=Object.values(S.portal);if(q.active!==undefined)all=all.filter(p=>String(p.active)===q.active);return page('/v1/billing_portal/configurations',all,q);}
   if(m==='POST'&&!sub){const c={id:'bpc_'+rand(),object:'billing_portal.configuration',active:true,...b,livemode:false};return S.portal[c.id]=c;}
   if(m==='POST'&&sub){const c=S.portal[sub];if(!c)throw missing('billing_portal.configuration',sub);Object.assign(c,b);return c;}
  }
 }
 if(res==='events'&&m==='GET'){let all=[...S.events].sort(newestFirst);const gte=q.created?.gte;if(gte!==undefined)all=all.filter(e=>e.created>=Number(gte));const types=[].concat(q.types||[]);if(types.length)all=all.filter(e=>types.includes(e.type));const p=page('/v1/events',all,q);p.data=strip(p.data);return p;}
 if(res==='webhook_endpoints'){
  if(m==='GET'&&!id)return page('/v1/webhook_endpoints',Object.values(S.webhooks).map(w=>({...w,secret:undefined})),q);
  if(m==='POST'&&!id){const w={id:'we_'+rand(),object:'webhook_endpoint',url:b.url,enabled_events:[].concat(b.enabled_events||[]),api_version:b.api_version||null,description:b.description||null,metadata:b.metadata||{},status:'enabled',livemode:false};S.webhooks[w.id]=w;return {...w,secret:'whsec_'+rand(32)};}
  const w=S.webhooks[id];if(!w)throw missing('webhook_endpoint',id);
  if(m==='POST'){if(b.enabled_events)w.enabled_events=[].concat(b.enabled_events);return w;}
  if(m==='DELETE'){delete S.webhooks[id];return {id,object:'webhook_endpoint',deleted:true};}
 }
 throw new StripeErr(404,'invalid_request_error',`Unrecognized request URL (${m}: /v1/${parts.join('/')}).`);
}

function control(b){
 switch(b.op){
  case 'reset':reset(Boolean(b.empty));return {ok:true};
  case 'requests':{let r=S.requests;if(b.path)r=r.filter(x=>new RegExp(b.path).test(x.path));if(b.method)r=r.filter(x=>x.method===b.method);const out=clone(r);if(b.clear)S.requests=[];return out;}
  case 'clear':S.requests=[];return {ok:true};
  case 'state':return strip({customers:S.customers,sessions:S.sessions,subscriptions:S.subscriptions,prices:S.prices,products:S.products,portal:S.portal,webhooks:S.webhooks,events:S.events.length});
  case 'pay':{const s=S.sessions[b.sessionId];if(!s)throw missing('checkout.session',b.sessionId);
   const sub=newSubscription({customer:s.customer,priceId:s._price,status:b.status||'active',created:b.created,metadata:s._subMeta,invoiceStatus:b.invoice||(b.status==='incomplete'?'open':'paid')});
   S.customers[s.customer]._currency=S.prices[s._price].currency;
   Object.assign(s,{status:'complete',payment_status:b.status==='incomplete'?'unpaid':'paid',subscription:sub.id});
   event('checkout.session.completed',s);event('customer.subscription.created',sub);event(sub.status==='active'?'invoice.paid':'invoice.payment_action_required',S.invoices[sub.latest_invoice]);
   return subView(sub,['latest_invoice']);}
  case 'subscription':{const sub=S.subscriptions[b.id];if(!sub)throw missing('subscription',b.id);setSub(sub,b);if(b.event!==false)event(b.status==='canceled'?'customer.subscription.deleted':'customer.subscription.updated',sub);return subView(sub,['latest_invoice']);}
  case 'create-subscription':{const p=Object.values(S.prices).find(x=>x.lookup_key===(b.lookup_key||'matbravo_monthly_pln'));if(!S.customers[b.customer])throw missing('customer',b.customer);
   const sub=newSubscription({customer:b.customer,priceId:p.id,status:b.status||'active',created:b.created,metadata:b.metadata,invoiceStatus:b.invoice||'paid',start:b.current_period_start,end:b.current_period_end});
   if(b.status==='canceled')setSub(sub,{status:'canceled'});if(b.event)event('customer.subscription.created',sub);return subView(sub,['latest_invoice']);}
  case 'expire-session':{const s=S.sessions[b.sessionId];if(!s)throw missing('checkout.session',b.sessionId);s.status='expired';event('checkout.session.expired',s);return sessionView(s);}
  case 'event':return strip(event(b.type,b.object));
  case 'events':return strip([...S.events].sort(newestFirst));
  case 'customer':return customerView(b.id);
  case 'delete-customer':{const c=S.customers[b.id];if(!c)throw missing('customer',b.id);c.deleted=true;return customerView(b.id);}
  case 'fault':S.faults.push({method:b.method,path:b.path,kind:b.kind||'status',status:b.status||500,type:b.type||'api_error',code:b.code,message:b.message||'Stub failure',param:b.param,shouldRetry:b.shouldRetry,times:b.times||1});return {ok:true};
  case 'delay':S.delays.push({method:b.method,path:b.path,ms:b.ms||500,times:b.times||1});return {ok:true};
  case 'clear-faults':S.faults=[];S.delays=[];return {ok:true};
 }
 throw new StripeErr(400,'invalid_request_error','unknown control op '+b.op);
}
const take=(arr,m,path)=>{const f=arr.find(x=>x.times>0&&(!x.method||x.method===m)&&(!x.path||new RegExp(x.path).test(path)));if(f)f.times--;return f;};

const server=http.createServer((req,res)=>{
 const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
  const url=new URL(req.url,'http://stub');const raw=Buffer.concat(chunks).toString('utf8');const reqId='req_'+rand();
  const send=(status,obj,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Request-Id':reqId,...(req.headers['stripe-version']?{'Stripe-Version':req.headers['stripe-version']}:{}),...headers});res.end(JSON.stringify(obj));};
  const fail=e=>e instanceof StripeErr?send(e.status,{error:{type:e.type,message:e.message,...(e.code?{code:e.code}:{}),...(e.param?{param:e.param}:{})}},e.headers):send(500,{error:{type:'api_error',message:String(e?.message||e)}});
  try{
   if(url.pathname.startsWith('/__control')){const b=req.method==='GET'?{op:url.pathname.split('/')[2]||'requests'}:JSON.parse(raw||'{}');return send(200,control(b));}
   if(!url.pathname.startsWith('/v1/'))throw new StripeErr(404,'invalid_request_error','Unrecognized request URL.');
   const q=parseForm(url.search.slice(1)),b=req.method==='POST'?parseForm(raw):{};const auth=req.headers.authorization||'';
   const rec={method:req.method,path:url.pathname,query:q,body:b,version:req.headers['stripe-version']||null,idempotencyKey:req.headers['idempotency-key']||null,authorization:auth||null,at:Date.now()};
   if(!auth&&req.method==='GET'&&url.pathname==='/v1/charges'){rec.probe=true;S.requests.push(rec);throw new StripeErr(401,'invalid_request_error','You did not provide an API key.');}
   S.requests.push(rec);
   const d=take(S.delays,req.method,url.pathname);if(d)await new Promise(r=>setTimeout(r,d.ms));
   const f=take(S.faults,req.method,url.pathname);
   if(f){rec.fault=f.kind==='drop'?'drop':f.status;if(f.kind==='drop'){req.socket.destroy();return;}
    throw new StripeErr(f.status,f.type,f.message,f.code,f.param,f.shouldRetry===undefined?{}:{'Stripe-Should-Retry':String(f.shouldRetry)});}
   if(!/^Bearer (sk|rk)_test_[A-Za-z0-9_]+$/.test(auth))throw new StripeErr(401,'invalid_request_error','Invalid API Key provided.');
   if(!rec.version)throw invalid('Stub: a Stripe-Version header is required.');
   if(req.method==='POST'){
    if(!rec.idempotencyKey)throw invalid('Stub: an Idempotency-Key header is required on POST.');
    const k=auth+' '+rec.idempotencyKey,seen=S.idem[k];
    if(seen){if(seen.body!==raw||seen.path!==url.pathname)throw new StripeErr(400,'idempotency_error','Keys for idempotent requests can only be used with the same parameters they were first used with.');rec.replayed=true;return send(seen.status,seen.out);}
    try{const out=strip(clone(api('POST',url.pathname.slice(4).split('/'),q,b)));S.idem[k]={body:raw,path:url.pathname,status:200,out};return send(200,out);}
    catch(e){if(e instanceof StripeErr&&e.status<500&&e.status!==429)S.idem[k]={body:raw,path:url.pathname,status:e.status,out:{error:{type:e.type,message:e.message,code:e.code,param:e.param}}};throw e;}
   }
   send(200,strip(clone(api(req.method,url.pathname.slice(4).split('/'),q,b))));
  }catch(e){fail(e);}
 });
});
// Port 0 picks a free port (unit tests); the first line of output names the port actually used.
server.listen(port,'127.0.0.1',()=>console.log(`stripe stub on 127.0.0.1:${server.address().port}`));
