// backend-api units through tests/php-bridge-core.php (plan §11): Access::compute (every row of §6.5 with its time
// boundaries), RateLimit (window logic on an in-memory stand-in), People (shape, initial by default), Paths (refusal of
// the docroot), Text::clean, Config (defaults and refused switch combinations), Accounts::dummyHash (same algorithm and
// parameters as Domain::password), ClientIp (IPv6 /64, trusted proxies), the route and job registries, RouteContext (no
// database connection for guests) and Jobs (session released, work after the response only once it was sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const php=process.env.PHP_BIN;
function bridge(input){const r=spawnSync(php,['tests/php-bridge-core.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const skip=!php;

const NOW=1_800_000_000,H=3600,D=86400;
const CFG={billing_enforce:true,billing_mode:'test',billing_grace_days:7,billing_stale_leeway_hours:72};
const member={id:'m',role:'member'},club={id:'c',role:'club'},editor={id:'e',role:'editor'},admin={id:'a',role:'admin'};
const sub=(status,fields={})=>({billing_exempt:0,exempt_until:null,livemode:0,sub_status:status,current_period_start:NOW-20*D,current_period_end:NOW+10*D,cancel_at_period_end:0,...fields});
const exempt=until=>({billing_exempt:1,exempt_until:until,livemode:0,sub_status:'none'});
test('Access::compute follows every row of the state table, with its time boundaries',{skip},()=>{
 const cases=[
  // [name, row, user, cfg, expected {full,state,until}]
  ['1 enforce off: member without row',null,member,{...CFG,billing_enforce:false},[true,'open',null]],
  ['1 enforce off: admin',sub('canceled'),admin,{...CFG,billing_enforce:false},[true,'open',null]],
  ['2 admin',sub('canceled'),admin,CFG,[true,'staff',null]],
  ['2 admin without row',null,admin,CFG,[true,'staff',null]],
  ['3 editor without row',null,editor,CFG,[true,'free',null]],
  ['3 club without row',null,club,CFG,[true,'free',null]],
  ['11 member without row',null,member,CFG,[false,'none',null]],
  ['4 exempt without end',exempt(null),member,CFG,[true,'free',null]],
  ['4 exempt until later',exempt(NOW+1),member,CFG,[true,'free',NOW+1]],
  ['8 exempt ends exactly now → grace',exempt(NOW),member,CFG,[true,'grace',NOW+7*D]],
  ['8 grace, last second',exempt(NOW-7*D+1),member,CFG,[true,'grace',NOW+1]],
  ['11 grace over',exempt(NOW-7*D),member,CFG,[false,'none',null]],
  ['8 staff with a row: exemption ended (requireFrom)',exempt(NOW-D),club,CFG,[true,'grace',NOW+6*D]],
  ['11 staff with a row, not exempt (new paid staff account)',{billing_exempt:0,exempt_until:null,livemode:0,sub_status:'none'},club,CFG,[false,'none',null]],
  ['5 active',sub('active'),member,CFG,[true,'active',NOW+10*D]],
  ['5 trialing',sub('trialing'),member,CFG,[true,'active',NOW+10*D]],
  ['5 active, stale period inside the 72 h leeway',sub('active',{current_period_end:NOW-72*H+1}),member,CFG,[true,'active',NOW-72*H+1]],
  ['5 active, leeway over → none',sub('active',{current_period_end:NOW-72*H}),member,CFG,[false,'none',null]],
  ['5 active without period end → none',sub('active',{current_period_end:null}),member,CFG,[false,'none',null]],
  ['5 active for staff with a row',sub('active'),editor,CFG,[true,'active',NOW+10*D]],
  ['6 ending',sub('active',{cancel_at_period_end:1}),member,CFG,[true,'ending',NOW+10*D]],
  ['6 ending, last second',sub('trialing',{cancel_at_period_end:1,current_period_end:NOW+1}),member,CFG,[true,'ending',NOW+1]],
  ['6 ending at period end → none',sub('active',{cancel_at_period_end:1,current_period_end:NOW}),member,CFG,[false,'none',null]],
  ['7 past_due inside grace',sub('past_due',{current_period_start:NOW-7*D+1}),member,CFG,[true,'past_due',NOW+1]],
  ['7 past_due, grace over → none',sub('past_due',{current_period_start:NOW-7*D}),member,CFG,[false,'none',null]],
  ['7 grace days from config',sub('past_due',{current_period_start:NOW-2*D}),member,{...CFG,billing_grace_days:1},[false,'none',null]],
  ['9 incomplete',sub('incomplete'),member,CFG,[false,'processing',null]],
  ...['canceled','unpaid','incomplete_expired','paused','foreign'].map(s=>['10 '+s,sub(s),member,CFG,[false,'ended',null]]),
  ['11 none',sub('none'),member,CFG,[false,'none',null]],
  ['livemode mismatch: test row in live mode → none',sub('active'),member,{...CFG,billing_mode:'live'},[false,'none',null]],
  ['livemode mismatch: live row in test mode → none',sub('active',{livemode:1}),member,CFG,[false,'none',null]],
  ['live row in live mode',sub('active',{livemode:1}),member,{...CFG,billing_mode:'live'},[true,'active',NOW+10*D]],
  ['exemption still applies to a row of the other mode',{...exempt(null),livemode:1},member,CFG,[true,'free',null]],
  ['expired exemption with a live subscription → active, not grace',{...sub('active'),billing_exempt:1,exempt_until:NOW-D},member,CFG,[true,'active',NOW+10*D]],
  ['expired exemption with a canceled subscription → grace',{...sub('canceled'),billing_exempt:1,exempt_until:NOW-D},member,CFG,[true,'grace',NOW+6*D]],
  ['valid exemption wins over an ended subscription',{...sub('canceled'),billing_exempt:1,exempt_until:null},member,CFG,[true,'free',null]],
 ];
 const out=bridge({job:'access',cases:cases.map(([,row,user,cfg])=>({row,user,cfg,now:NOW}))});
 cases.forEach(([name,,,,[full,state,until]],i)=>assert.deepEqual(out[i],{full,state,until},name));
 for(const r of out)assert.deepEqual(Object.keys(r),['full','state','until']);
});
test('Access::currency: an ongoing subscription keeps its currency, otherwise the country decides',{skip},()=>{
 const cases=[[null,'PL','pln'],[null,'DE','usd'],[null,'US','usd'],[null,null,null],[null,'pl',null],
  [sub('active',{currency:'usd'}),'PL','usd'],[sub('past_due',{currency:'pln'}),'US','pln'],[sub('incomplete',{currency:'usd'}),'PL','usd'],
  [sub('canceled',{currency:'usd'}),'PL','pln'],[sub('active',{currency:'usd',livemode:1}),'PL','pln'],[{...exempt(null),currency:'usd'},'PL','pln']];
 assert.deepEqual(bridge({job:'currency',cases:cases.map(([row,country])=>({row,country,cfg:CFG}))}),cases.map(c=>c[2]));
});

test('Text::clean: NFC, control and format characters, white space and line rules',{skip},()=>{
 const lines=Array.from({length:25},(_,i)=>'l'+(i+1)).join('\n');
 const cases=[
  [{s:123},null],[{s:null},null],[{s:['a']},null],[{hex:'61ff62'},null],
  [{s:'Ala'},'Ala'],[{s:'  Ala ma kota  '},'Ala ma kota'],[{s:' 　Ala '},'Ala'],[{s:'a\tb'},'a b'],
  [{s:'a\u0000b\u0007c\u007fd\u0085e\u009bf'},'abcdef'],
  [{s:'a\nb'},'ab'],[{s:'a\r\nb'},'ab'],[{s:'a\nb',multiline:true},'a\nb'],[{s:'a\r\nb\rc',multiline:true},'a\nb\nc'],
  [{s:'abc‮def‪ghi⁦j⁧k⁨l⁩m'},'abcdefghijklm'],
  [{s:'x‎y‏z؜!'},'xyz!'],[{s:'​z‌w⁠q﻿'},'zwq'],[{s:'mi­kki'},'mikki'],
  [{s:'👨‍👩‍👧 rodzina'},'👨‍👩‍👧 rodzina'],[{s:'👍🏽 ok'},'👍🏽 ok'],
  [{s:'Café'},'Café'],[{s:'Zażółć'},'Zażółć'],
  [{s:'a\n\n\n\n\nb',multiline:true},'a\n\n\nb'],[{s:'a\n   \n  \n\t\nb',multiline:true},'a\n\n\nb'],
  [{s:'\n\n  a\n\n',multiline:true},'a'],[{s:'a\n\n\nb\n\n\n\nc',multiline:true},'a\n\n\nb\n\n\nc'],
  [{s:lines,multiline:true},Array.from({length:19},(_,i)=>'l'+(i+1)).join('\n')+'\nl20 l21 l22 l23 l24 l25'],
  [{s:'​‍​'},'‍'],[{s:'​​'},''],[{s:'   '},''],
 ];
 const out=bridge({job:'clean',cases:cases.map(c=>c[0])});
 cases.forEach(([input,expected],i)=>assert.equal(out[i],expected,JSON.stringify(input)));
});
test('Accounts::profileComplete accepts database rows and camelCase projections',{skip},()=>{
 const row={first_name:'Marta',last_name:'Kowalska',username:'marta.k',country:'PL',sports:'taekwondo,karate'};
 const cases=[[row,true],[{firstName:'Marta',lastName:'K',username:'mk',country:'DE',sports:['judo']},true],
  [{...row,username:null},false],[{...row,sports:''},false],[{...row,sports:','},false],[{...row,country:'pl'},false],[{...row,country:null},false],
  [{...row,first_name:'  '},false],[{...row,last_name:null},false],[{firstName:'A',lastName:'B',username:'ab',country:'PL',sports:[]},false],[null,false],[{},false]];
 assert.deepEqual(bridge({job:'complete',cases:cases.map(c=>c[0])}),cases.map(c=>c[1]));
});

test('Accounts::dummyHash uses the algorithm and parameters of Domain::password and never verifies',{skip},()=>{
 const out=bridge({job:'hash'});
 assert.deepEqual(out.dummy,out.domain);assert.ok(['argon2id','bcrypt'].includes(out.dummy.algoName),JSON.stringify(out.dummy));
 assert.equal(out.verifies,false);assert.equal(out.same,true);
 const ids=bridge({job:'public-ids',n:300});assert.equal(new Set(ids).size,300);for(const id of ids)assert.match(id,/^[0-9A-Za-z]{12}$/);
});

const KEY='rk_test_abc123',SUPPORT={support_email:'pomoc@example.test'};
test('Config: defaults are merged and unsafe switch combinations are refused',{skip},()=>{
 const BILL='RuntimeException: Invalid billing configuration.',SIGN='RuntimeException: Invalid signup configuration.',on={billing_enabled:true,stripe_secret_key:KEY};
 const cases=[
  [{},'valid'],[{billing_enforce:true},BILL],[{billing_enabled:true},BILL],[on,'valid'],[{...on,billing_enforce:true},'valid'],
  [{...on,billing_mode:'live'},BILL],[{...on,billing_mode:'live',stripe_secret_key:'rk_live_abc'},'valid'],[{...on,billing_mode:'live',stripe_secret_key:'sk_live_abc'},'valid'],
  [{...on,stripe_secret_key:'pk_test_abc'},BILL],[{...on,billing_mode:'prod'},BILL],
  [{...on,stripe_webhook_secrets:['abc']},BILL],[{...on,stripe_webhook_secrets:['whsec_abc','whsec_def']},'valid'],[{...on,stripe_webhook_secrets:'whsec_abc'},BILL],
  [{...on,stripe_api_base:'http://api.stripe.com'},BILL],[{...on,stripe_api_base:'http://127.0.0.1:12111',allow_insecure_http:true},'valid'],
  [{...on,stripe_api_base:'http://127.0.0.1:12111'},BILL],[{...on,stripe_api_base:'http://evil.example',allow_insecure_http:true},BILL],
  [{...on,stripe_prices:{eur:'matbravo_eur'}},BILL],[{...on,stripe_prices:{pln:'Bad Key'}},BILL],[{...on,billing_amounts:{pln:'899'}},BILL],[{...on,billing_amounts:{pln:0}},BILL],
  [{...on,billing_address_collection:'never'},BILL],
  [{signup_enabled:true},SIGN],[{...on,billing_enforce:true,signup_enabled:true},SIGN],[{...on,billing_enforce:true,signup_enabled:true,...SUPPORT},'valid'],
  [{...on,billing_enforce:true,signup_enabled:true,support_email:'not an address'},SIGN],
  // §6.10 matrix: a free beta only without billing; an invite token alone only with enforced payments (test window).
  [{signup_enabled:true,signup_free_beta:true,...SUPPORT},'valid'],[{signup_enabled:true,signup_free_beta:true},SIGN],
  [{...on,signup_enabled:true,signup_free_beta:true,...SUPPORT},SIGN],[{...on,billing_enforce:true,signup_enabled:true,signup_free_beta:true,...SUPPORT},'valid'],
  [{...on,signup_enabled:true,...SUPPORT},SIGN],
  [{...on,billing_enforce:true,signup_invite_token:'short-token',...SUPPORT},SIGN],[{...on,billing_enforce:true,signup_invite_token:'x'.repeat(24)},SIGN],
  [{...on,billing_enforce:true,signup_invite_token:'x'.repeat(24),...SUPPORT},'valid'],[{...on,billing_enforce:true,billing_mode:'live',stripe_secret_key:'rk_live_abc',signup_invite_token:'x'.repeat(24),...SUPPORT},'valid'],
  [{signup_invite_token:'x'.repeat(24),...SUPPORT},SIGN],[{...on,signup_invite_token:'x'.repeat(24),...SUPPORT},SIGN],[{signup_invite_token:'x'.repeat(24),signup_free_beta:true,...SUPPORT},SIGN],
  [{signup_enabled:true,signup_free_beta:true,signup_invite_token:'x'.repeat(24),...SUPPORT},'valid'],[{...on,billing_enforce:true,signup_enabled:true,signup_invite_token:'x'.repeat(24),...SUPPORT},'valid'],
  [{signup_invite_token:''},'valid'],[{signup_invite_token:null},'valid'],
 ];
 const out=bridge({job:'config',cases:cases.map(c=>c[0])});
 cases.forEach(([input,expected],i)=>assert.deepEqual(out[i],expected==='valid'?{ok:'valid'}:{error:expected},JSON.stringify(input)));
 const base={app_url:'https://matbravo.test',db:{dsn:'mysql:host=localhost;dbname=x',user:'x',password:'x'},app_key:'a'.repeat(64)};
 const keys=['session_idle_seconds','member_session_idle_seconds','member_session_max_seconds','login_limit_ip','min_client_api','stripe_prices','billing_amounts','signup_enabled','job_test_sleep_ms','uploads_dir','app_url'];
 const loaded=bridge({job:'config-load',config:{...base,session_idle_seconds:900},keys});
 assert.deepEqual(loaded.ok,{app_url:'https://matbravo.test',session_idle_seconds:900,member_session_idle_seconds:1209600,member_session_max_seconds:2592000,login_limit_ip:100,min_client_api:1,
  stripe_prices:{pln:'matbravo_monthly_pln',usd:'matbravo_monthly_usd'},billing_amounts:{pln:899,usd:299},signup_enabled:false,job_test_sleep_ms:0,uploads_dir:null});
 assert.deepEqual(bridge({job:'config-load',config:{...base,signup_enabled:true},keys}),{error:SIGN},'matdraw_config() validates the merged config');
 assert.deepEqual(bridge({job:'config-load',config:{...base,billing_enabled:true,billing_mode:'live',stripe_secret_key:KEY},keys}),{error:BILL},'a test key in live mode is refused');
 const api=[['https://api.stripe.com',false,true],['http://127.0.0.1:12111',true,true],['http://127.0.0.1:12111',false,false],['http://[::1]:9',true,true],['http://localhost:9',true,true],
  ['http://evil.test',true,false],['ftp://127.0.0.1',true,false],['https://user:pw@api.stripe.com',false,false],[null,true,false]];
 assert.deepEqual(bridge({job:'api-base',cases:api.map(([u,i])=>[u,i])}),api.map(c=>c[2]));
});

test('ClientIp: REMOTE_ADDR, trusted proxies only, IPv6 grouped by /64',{skip},()=>{
 const xff='trusted_proxy_header',cases=[
  [{remote:'203.0.113.5'},['203.0.113.5','203.0.113.5']],
  [{remote:'2001:db8:1:2:3:4:5:6'},['2001:db8:1:2:3:4:5:6','2001:db8:1:2::/64']],
  [{remote:'2001:DB8:1:2:aaaa::1'},['2001:DB8:1:2:aaaa::1','2001:db8:1:2::/64']],
  [{remote:'::ffff:198.51.100.7'},['::ffff:198.51.100.7','198.51.100.7']],
  [{remote:'198.51.100.1',server:{HTTP_X_FORWARDED_FOR:'1.2.3.4'}},['198.51.100.1','198.51.100.1']],
  [{remote:'198.51.100.1',server:{HTTP_X_FORWARDED_FOR:'1.2.3.4'},cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.0.0.0/8']}},['198.51.100.1','198.51.100.1']],
  [{remote:'10.0.0.1',server:{HTTP_X_FORWARDED_FOR:'1.2.3.4, 198.51.100.9, 10.0.0.2'},cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.0.0.0/8']}},['198.51.100.9','198.51.100.9']],
  [{remote:'10.0.0.1',server:{HTTP_X_FORWARDED_FOR:'garbage'},cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.0.0.1']}},['10.0.0.1','10.0.0.1']],
  [{remote:'10.0.0.1',cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.0.0.1']}},['10.0.0.1','10.0.0.1']],
  [{remote:'2001:db8::1',server:{HTTP_X_REAL_IP:'2001:db8:aa:bb:1::2'},cfg:{[xff]:'X-Real-IP',trusted_proxies:['2001:db8::/48']}},['2001:db8:aa:bb:1::2','2001:db8:aa:bb::/64']],
  [{remote:'10.0.0.1',server:{HTTP_X_FORWARDED_FOR:'198.51.100.9'},cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.0.0.2','bad','10.0.0.0/33']}},['10.0.0.1','10.0.0.1']],
  [{remote:'10.1.2.3',server:{HTTP_X_FORWARDED_FOR:'198.51.100.9'},cfg:{[xff]:'X-Forwarded-For',trusted_proxies:['10.1.0.0/15']}},['198.51.100.9','198.51.100.9']],
 ];
 const out=bridge({job:'client-ip',cases:cases.map(c=>c[0])});
 cases.forEach(([input,expected],i)=>assert.deepEqual(out[i],expected,JSON.stringify(input)));
 assert.deepEqual(bridge({job:'buckets',ips:['','abc','1.2.3','::1','fe80::1:2:3:4']}),['unknown','unknown','unknown','::/64','fe80::/64']);
});

test('RateLimit: fixed window per scope and key, HMAC buckets only, retry until the window ends',{skip},()=>{
 const h=(now,extra={})=>({scope:'login',key:'203.0.113.5',limit:3,window:60,now,...extra});
 const out=bridge({job:'rate-limit',hits:[h(1000),h(1001),h(1002),h(1003),h(1059),h(1060),h(1061),h(1061,{key:'203.0.113.6'}),h(1061,{scope:'signup'}),h(1100,{limit:0})]});
 assert.deepEqual(out.results,[0,0,0,57,1,0,0,0,0,20]);
 assert.deepEqual(out.plain,[],'only HMAC buckets are stored');assert.equal(out.buckets.length,3);
 assert.deepEqual([...new Set(out.expected)].sort(),[...out.buckets].sort(),'bucket = HMAC(scope|key, app_key)');
});

test('People::project: one query, default initial, allow-listed fields, blocked accounts',{skip},()=>{
 const created=Date.UTC(2026,9,15,12)/1000;
 const rows=[
  {id:'u1',role:'member',active:1,public_id:'Xk3P9aQ2LmZt',username:'marta.k',first_name:'Marta',last_name:'kowalska',country:'PL',sports:'taekwondo,karate',club_text:'KS Tygrys',show_club:1,name_display:'initial',avatar:'9f2c41ab07de0123456789abcdef0123.webp',created_at:created},
  {id:'u2',role:'admin',active:1,public_id:'Qw8eR7tY6uI5',username:'jan.n',first_name:'Jan',last_name:'Nowak',country:'DE',sports:'',club_text:'Ukryty klub',show_club:0,name_display:'full',avatar:null,created_at:created},
  {id:'u3',role:'member',active:0,public_id:'Zz1Yy2Xx3Ww4',username:'x',first_name:'Ewa',last_name:'Lis',country:'PL',sports:'judo',club_text:null,show_club:0,name_display:'full',avatar:null,created_at:created},
 ];
 const r=bridge({job:'people',rows,ids:['u1','u2','u3','u1','missing',7]});
 assert.equal(r.queries,1,'one query for all ids');assert.deepEqual(r.params,['u1','u2','u3','missing']);
 assert.deepEqual(r.out,{
  u1:{pid:'Xk3P9aQ2LmZt',n:'Marta K.',u:'marta.k',cc:'PL',sp:['taekwondo','karate'],club:'KS Tygrys',av:'9f2c41ab07de',mod:false,since:'2026-10'},
  u2:{pid:'Qw8eR7tY6uI5',n:'Jan Nowak',u:'jan.n',cc:'DE',sp:[],club:null,av:null,mod:true,since:'2026-10'},
  u3:{pid:'Zz1Yy2Xx3Ww4',inactive:true}});
 assert.deepEqual(bridge({job:'names',cases:[['Marta','kowalska',false],['Łucja','żak-Nowicka',false],['Ana',null,false],['Ana','Lis',true],[' Ola ',' Ćwik ',false],['','Nowak',false]]}),
  ['Marta K.','Łucja Ż.','Ana','Ana Lis','Ola Ć.','N.']);
});

test('Paths: uploads never inside the docroot (also through .. or a symlink); save path formats',{skip},()=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'md-paths-'))),root=path.join(dir,'public_html'),outside=path.join(dir,'shared');
 mkdirSync(root);mkdirSync(outside);symlinkSync(outside,path.join(root,'link'));symlinkSync(root,path.join(dir,'alias'));
 try{
  const r=bridge({job:'paths',docroot:root,uploads:[root+'/uploads',root,root+'/../shared/uploads',outside+'/uploads',root+'/link/uploads',dir+'/alias/uploads',outside+'/../public_html/x'],
   resolve:[dir+'/x/../shared/a/./b',dir+'/alias/new'],savePath:['/var/lib/php/sessions','2;/tmp/s','2;0600;/tmp/s']});
  const refused=/RuntimeException: The uploads directory must be outside the public document root\./;
  assert.match(r.uploads[0].error,refused);assert.match(r.uploads[1].error,refused);
  assert.deepEqual(r.uploads[2],{ok:outside+'/uploads'});assert.deepEqual(r.uploads[3],{ok:outside+'/uploads'});
  assert.match(r.uploads[4].error,refused,'a symlink inside the docroot is served by the web server');
  assert.match(r.uploads[5].error,refused,'a symlink to the docroot resolves into it');assert.match(r.uploads[6].error,refused);
  assert.deepEqual(r.resolve,[outside+'/a/b',root+'/new']);
  assert.deepEqual(r.savePath,[['/var/lib/php/sessions',0],['/tmp/s',2],['/tmp/s',2]]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Route and job registries: modes, unique names, refused definitions; describe() keeps PDO messages out of logs',{skip},()=>{
 const routes=bridge({job:'routes'});
 assert.deepEqual(routes.me,['GET','peek','required',null]);assert.deepEqual(routes['public-config'],['GET','public',null,null]);
 for(const name of ['session','bootstrap','login','logout','command','public','public-tournament'])assert.ok(!(name in routes),name);
 assert.deepEqual(bridge({job:'jobs'}).housekeeping,[3600,false]);
 const dir=mkdtempSync(path.join(tmpdir(),'md-routes-'));
 const write=(file,body)=>writeFileSync(path.join(dir,file),'<?php return '+body+';');
 const routesIn=files=>{rmSync(dir,{recursive:true,force:true});mkdirSync(dir);for(const [f,b] of Object.entries(files))write(f,b);return bridge({job:'routes',dir});};
 const h="'handler'=>fn()=>null";
 try{
  assert.deepEqual(routesIn({'a.php':`['x-one'=>['method'=>'POST','auth'=>'session',${h}],'x-two'=>['method'=>'GET','auth'=>'peek','user'=>'admin',${h}]]`}).ok,{'x-one':['POST','session','required'],'x-two':['GET','peek','admin']});
  assert.match(routesIn({'a.php':`['x'=>['method'=>'GET','auth'=>'public',${h}]]`,'b.php':`['x'=>['method'=>'GET','auth'=>'public',${h}]]`}).error,/RuntimeException: Duplicate route x in b\.php/);
  assert.match(routesIn({'a.php':`['session'=>['method'=>'GET','auth'=>'public',${h}]]`}).error,/Duplicate route session/,'legacy names cannot be taken over');
  for(const bad of [`['x'=>['method'=>'POST','auth'=>'public',${h}]]`,`['x'=>['method'=>'GET','auth'=>'public','user'=>'required',${h}]]`,`['x'=>['method'=>'POST','auth'=>'upload',${h}]]`,
   `['x'=>['method'=>'GET','auth'=>'peek','user'=>'root',${h}]]`,`['x'=>['method'=>'GET','auth'=>'other',${h}]]`,`['x'=>['method'=>'GET','auth'=>'peek']]`,`['X'=>['method'=>'GET','auth'=>'peek',${h}]]`,
   `['x'=>['method'=>'POST','auth'=>'webhook','max'=>0,${h}]]`,`['x'=>['method'=>'GET','auth'=>'peek','tag'=>'other',${h}]]`])
   assert.match(routesIn({'a.php':bad}).error,/RuntimeException: Invalid route definition/,bad);
  rmSync(dir,{recursive:true,force:true});mkdirSync(dir);
  write('a.php',"['j'=>['every'=>60,'run'=>fn()=>'ok']]");write('b.php',"['j'=>['every'=>60,'run'=>fn()=>'ok']]");
  assert.match(bridge({job:'jobs',dir}).error,/Duplicate job j in b\.php/);
  rmSync(path.join(dir,'b.php'));assert.deepEqual(bridge({job:'jobs',dir}).ok,{j:[60,false]});
  write('b.php',"['k'=>['every'=>0,'run'=>fn()=>'ok']]");assert.match(bridge({job:'jobs',dir}).error,/Invalid job definition: k/);
 }finally{rmSync(dir,{recursive:true,force:true});}
 const dbDir=realpathSync(mkdtempSync(path.join(tmpdir(),'md-lazy-')));writeFileSync(path.join(dbDir,'config.php'),'<?php return [];');
 try{
  const live='live'+'a'.repeat(24),anon='anon'+'b'.repeat(24),r=bridge({job:'lazy-db',dir:dbDir,live,anon,cookies:[null,'../../etc/passwd','u'.repeat(26),anon,live]});
  assert.deepEqual(r.peek.slice(0,4),[{ok:null},{ok:null},{ok:null},{ok:null}],'a guest poll (me) opens no database connection');
  assert.match(r.peek[4].error,/^PDOException/,'a live session reads the account');
  assert.deepEqual(r.session[0],{ok:null},'an anonymous session needs no database either');assert.match(r.session[1].error,/^PDOException/);
 }finally{rmSync(dbDir,{recursive:true,force:true});}
 const jobsDir=mkdtempSync(path.join(tmpdir(),'md-jobs-'));writeFileSync(path.join(jobsDir,'config.php'),'<?php return [];');writeFileSync(path.join(jobsDir,'jobs-tick'),'');
 try{assert.deepEqual(bridge({job:'jobs-release',dir:jobsDir}),{before:true,after:false,written:true},'Jobs::maybe closes the session before anything else');}
 finally{rmSync(jobsDir,{recursive:true,force:true});}
 const d=bridge({job:'describe',email:'secret.person@example.test'});
 assert.ok(!d.pdo.includes('secret.person'),d.pdo);assert.match(d.pdo,/^PDOException php-bridge-core\.php:\d+ SQLSTATE 23000 code 1062$/);
 assert.equal(d.other.length,'RuntimeException php-bridge-core.php:'.length+String(d.other.match(/:(\d+) /)[1]).length+1+200);
 assert.equal(d.behind,true);assert.equal(d.notBehind,false);
});
