// Settings of the Administrator (PLAN-REJESTRACJA-ROLE §3.1–§3.3, §3.6, §9.2, §12) through tests/php-bridge-settings.php:
// the full switch matrix of Settings::effective (with a stored row, without one, with the table missing), idempotence and
// the cache per connection, normalize, the input checks of save, the overlay of Routes::dispatch (which routes compute the
// effective configuration; guest routes without a cookie never open a connection for it), migration 0008 and the guard
// against raw reads of the switches (a route reading config.php directly would bypass the Administrator's settings).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {warsawToday} from '../dist/guest-view.js';
const php=process.env.PHP_BIN,skip=!php;
function run(input){return spawnSync(php,['tests/php-bridge-settings.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10_000_000});}
function bridge(input){const r=run(input);assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}

const FILE={signup_enabled:false,billing_enabled:false,billing_enforce:false,support_email:null,signup_force_off:false,billing_mode:'test'};
const pick=e=>({signup_enabled:e.signup_enabled,billing_enforce:e.billing_enforce,signup_mode:e.signup_mode,degraded:e.settings_degraded??null,free_beta:e.signup_free_beta});

test('Settings::effective: the full §3.3 matrix from a stored row, idempotent, one query per connection',{skip},()=>{
 const on={billing_enabled:true};
 const cases=[
  // [label, config, row, expected {signup_enabled, billing_enforce, signup_mode, degraded, free_beta}]
  ['no row: config.php decides (production: off)',{},undefined,[false,false,'off',null,true]],
  ['no row: config.php with enforced payments',{signup_enabled:true,billing_enabled:true,billing_enforce:true},undefined,[true,true,'paid',null,false]],
  ['off + free, Stripe off',{},{signup:'off',payments:'free'},[false,false,'off',null,true]],
  ['off + free, Stripe on',on,{signup:'off',payments:'free'},[false,false,'off',null,true]],
  ['off + paid with Stripe (test window, pause)',on,{signup:'off',payments:'paid'},[false,true,'off',null,false]],
  ['on + free before Stripe (D1)',{},{signup:'on',payments:'free'},[true,false,'free',null,true]],
  ['on + free with Stripe ready (new row)',on,{signup:'on',payments:'free'},[true,false,'free',null,true]],
  ['on + paid with Stripe',on,{signup:'on',payments:'paid'},[true,true,'paid',null,false]],
  ['on + paid, Stripe gone: off + free, degraded',{},{signup:'on',payments:'paid'},[false,false,'off','billing-missing',true]],
  ['off + paid, Stripe gone: degraded',{},{signup:'off',payments:'paid'},[false,false,'off','billing-missing',true]],
  ['signup_force_off over on + free',{signup_force_off:true},{signup:'on',payments:'free'},[false,false,'off','force-off',true]],
  ['signup_force_off over on + paid',{signup_force_off:true,billing_enabled:true},{signup:'on',payments:'paid'},[false,true,'off','force-off',false]],
  ['signup_force_off with signup off: nothing to report',{signup_force_off:true},{signup:'off',payments:'free'},[false,false,'off',null,true]],
  ['the row wins over config.php',{signup_enabled:true,billing_enabled:true,billing_enforce:true},{signup:'off',payments:'free'},[false,false,'off',null,true]],
  ['a partial row: missing fields from config.php',{signup_enabled:true,billing_enabled:true,billing_enforce:true},{supportEmail:'biuro@klub.test'},[true,true,'paid',null,false]],
  ['invalid values fall back to config.php',{signup_enabled:true,billing_enabled:true,billing_enforce:true},{signup:'yes',payments:1,organizers:'off',trustRequired:'true',supportEmail:'nope'},[true,true,'paid',null,false]],
  ['a row that is not JSON',{},'garbage{',[false,false,'off',null,true]],
 ];
 const out=bridge({job:'effective',cases:cases.map(([,c,row])=>({config:{...FILE,...c},...(row===undefined?{}:{row})}))});
 cases.forEach(([label,,,want],i)=>{
  const o=out[i];assert.equal(o.status,200,label+': '+JSON.stringify(o));
  assert.deepEqual(Object.values(pick(o.result.effective)),want,label);
  assert.ok(o.result.again&&o.result.twice,label+': idempotent');assert.equal(o.result.queries,1,label+': one query, cached per connection');
 });
 // Support address, organizers and trust (§3.6, §17).
 const more=bridge({job:'effective',cases:[{config:FILE},{config:{...FILE,support_email:'pomoc@example.test'}},{config:FILE,row:{supportEmail:' Pomoc@Klub.TEST '}},{config:{...FILE,support_email:'pomoc@example.test'},row:{supportEmail:'zly adres'}},
  {config:FILE,row:{organizers:'paused',trustRequired:true}},{config:{...FILE,organizers:'paused',organizers_trust_required:true}},{config:{...FILE,organizers:'paused',organizers_trust_required:true},row:{organizers:'on',trustRequired:false}}]});
 assert.deepEqual(more.map(o=>o.result.effective.support_email),['hello@matbravo.com','pomoc@example.test','pomoc@klub.test','pomoc@example.test','hello@matbravo.com','hello@matbravo.com','hello@matbravo.com']);
 assert.deepEqual(more.map(o=>o.result.flags),[{organizers:'on',trustRequired:false},{organizers:'on',trustRequired:false},{organizers:'on',trustRequired:false},{organizers:'on',trustRequired:false},
  {organizers:'paused',trustRequired:true},{organizers:'paused',trustRequired:true},{organizers:'on',trustRequired:false}],'trustRequired defaults to false (§17), the row wins over config.php');
});

test('Settings::effective: a missing table gives the values of config.php alone (no 503); other database errors are not hidden',{skip},()=>{
 const cfg={...FILE,signup_enabled:true,billing_enabled:true,billing_enforce:true,support_email:'pomoc@example.test'};
 const [missing,other,none]=bridge({job:'effective',cases:[{config:cfg,table:false},{config:cfg,error:'HY000'},{config:cfg}]});
 assert.equal(missing.status,200);assert.deepEqual(missing.result.effective,none.result.effective);assert.equal(missing.result.queries,1,'the missing table is remembered too');
 assert.deepEqual(pick(missing.result.effective),{signup_enabled:true,billing_enforce:true,signup_mode:'paid',degraded:null,free_beta:false});
 assert.deepEqual(other,{status:'pdo',state:'HY000'});
});

test('Settings::normalize and defaults: closed values, lower-case e-mail, stripeCheck codes only, unknown keys left out of the result',{skip},()=>{
 const check={at:1,ok:false,mode:'test',prices:{pln:true,usd:false,eur:true},error:'price_missing'};
 const [n1,n2,n3,n4]=bridge({job:'normalize',cases:[{data:{signup:'on',payments:'paid',organizers:'paused',trustRequired:true,supportEmail:'A@B.PL',stripeCheck:check,future:1},config:FILE},
  {data:{stripeCheck:{...check,error:'Stripe said: card <b>'}},config:FILE},{data:{stripeCheck:{...check,mode:'prod'}},config:FILE},{data:null,config:{...FILE,signup_enabled:true,billing_enforce:true}}]});
 assert.deepEqual(n1,{signup:'on',payments:'paid',organizers:'paused',trustRequired:true,supportEmail:'a@b.pl',stripeCheck:{at:1,ok:false,mode:'test',prices:{pln:true,usd:false},error:'price_missing'}});
 assert.equal(n2.stripeCheck,null,'free text never stored as an error code');assert.equal(n3.stripeCheck,null);
 assert.deepEqual(n4,{signup:'on',payments:'paid',organizers:'on',trustRequired:false,supportEmail:'hello@matbravo.com',stripeCheck:null});
 assert.deepEqual(bridge({job:'defaults',cases:[{},{support_email:'zły'},{organizers_trust_required:'yes'}]}).map(d=>[d.signup,d.payments,d.supportEmail,d.trustRequired]),
  [['off','free','hello@matbravo.com',false],['off','free','hello@matbravo.com',false],['off','free','hello@matbravo.com',false]]);
 assert.deepEqual(bridge({job:'mode',cases:[{signup:'off',payments:'paid'},{signup:'on',payments:'free'},{signup:'on',payments:'paid'}]}),['off','free','paid']);
});

test('Settings::save: input checks before any database work (400 form, 422 e-mail and dates); valid input reaches the database',{skip},()=>{
 const now=Math.floor(Date.now()/1000),day=n=>warsawToday(new Date(Date.now()+n*864e5));
 const cases=[{},{version:'0'},{version:-1},{version:0,signup:'maybe'},{version:0,payments:1},{version:0,organizers:'off'},{version:0,trustRequired:'yes'},{version:0,confirmTestMode:1},
  {version:0,supportEmail:5},{version:0,supportEmail:''},{version:0,supportEmail:'nope'},{version:0,freePeriod:'keep'},{version:0,freePeriod:{action:'drop'}},
  {version:0,freePeriod:{action:'requireFrom',date:'2030-02-30'}},{version:0,freePeriod:{action:'requireFrom',date:day(13)}},
  {version:0,freePeriod:{action:'requireFrom',date:day(15)}},{version:0,signup:'on',payments:'free',organizers:'paused',trustRequired:true,supportEmail:'Pomoc@Klub.test',freePeriod:{action:'keep'},confirmTestMode:true}];
 const out=bridge({job:'save',now,cases});
 assert.deepEqual(out.map(o=>o.status),[400,400,400,400,400,400,400,400,400,422,422,400,400,422,422,'db','db']);
 assert.deepEqual([out[9].error,out[13].error,out[14].error],['Podaj poprawny e-mail.','Podaj poprawną datę.','Płatność można wymagać od daty co najmniej 14 dni od dziś.']);
});

test('Routes::needsSettings: session and upload routes always, peek routes only with a session cookie, public routes only when flagged; guests cost no connection',{skip},()=>{
 const all=bridge({job:'needs'});
 for(const [name,[mode,none,cookie,bad]] of Object.entries(all)){
  const want=mode==='session'||mode==='upload'?[true,true,true]:mode==='peek'?[false,true,false]:name==='public-config'?[true,true,true]:[false,false,false];
  assert.deepEqual([none,cookie,bad],want,name+' ('+mode+')');
 }
 for(const name of ['public-chat','public-chat-channels','chat-feed','avatar','admin-settings','admin-settings-save','admin-stripe-check','public-config','stripe-webhook'])assert.ok(all[name],name+' is registered');
 assert.deepEqual(all['public-chat'].slice(1,4),[false,false,false],'guest chat never opens a connection for the settings');
 assert.deepEqual(all['admin-settings'][0],'peek');assert.deepEqual(all['admin-settings-save'][0],'session');
});

test('Routes::dispatch: the overlay opens a connection only where needed (a database that cannot be opened answers 500 at the first attempt)',{skip},()=>{
 const call=(route,cookie)=>{const r=run({job:'dispatch',name:'t-route',route:{method:'GET',...route},...(cookie?{cookie}:{})});assert.equal(r.status,0,r.stderr);const [body,status]=r.stdout.split('\nSTATUS ');return {status:Number(status),body:JSON.parse(body)};};
 const cookie='a'.repeat(26);
 // A guest: no connection, the raw file as config (no switch overlay), even when a cookie arrives at a public route.
 for(const [route,c] of [[{auth:'public'}],[{auth:'public'},cookie],[{auth:'peek'}],[{auth:'peek'},'not a session id']]){
  const r=call(route,c);assert.equal(r.status,200,JSON.stringify([route,c,r]));assert.deepEqual(r.body,{user:null,same:true,mode:null});
 }
 // A session cookie on a peek route, or a public route that needs the settings: the overlay tries to connect first.
 assert.equal(call({auth:'peek'},cookie).status,500);assert.equal(call({auth:'public',settings:true}).status,500);
});

test('migration 0008: app_settings as in §9.2, no starting row, no floor, additive',()=>{
 const text=readFileSync('backend/migrations/0008_settings.php','utf8');
 assert.match(text,/'id'=>8,'name'=>'settings','destructive'=>false/);assert.doesNotMatch(text,/'floor'\s*=>/);assert.doesNotMatch(text,/\bINSERT\b|\bUPDATE\b|\bALTER\b|\bDROP\b/i);
 const body=text.match(/CREATE TABLE IF NOT EXISTS app_settings \(([\s\S]*?)\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/)[1].trim().split(/,\s*\n/).map(s=>s.trim());
 assert.deepEqual(body,['id TINYINT NOT NULL PRIMARY KEY','version INT UNSIGNED NOT NULL','data TEXT NOT NULL','updated_at BIGINT NOT NULL','updated_by VARCHAR(40) NULL']);
});

// ---- Guard: no raw reads of the switches (§3.2, PS-13) ------------------------------------------------------------------
const SWITCHES=['billing_enforce','signup_enabled','support_email','organizers'];
// Files allowed to read the raw values: the overlay itself, the access rules (they get the effective config) and the file check.
const ANY=new Set(['backend/src/Settings.php','backend/src/Access.php','backend/src/Config.php']);
// Entry points that call matdraw_config() and pass it on without the overlay: none of them reads a switch.
const RAW_ENTRY={'backend/bin/install.php':'installer','backend/bin/migrate.php':'migrations','backend/bin/dump.php':'backup','backend/bin/stripe-setup.php':'Stripe objects',
 'backend/bin/stripe-sync.php':'payment sync (reads no switch)','backend/bin/cron.php':'every job calls Settings::effective itself','backend/bin/seed-athletes.php':'demo data',
 'backend/routes/accounts.php':'the 413/415 message of an upload (Avatars::reject)','backend/bootstrap.php':'defines it','backend/config.example.php':'documentation'};
// Files of slices of the same wave that add Settings::effective (PLAN-REJESTRACJA-ROLE §3.2, slice accounts-backend): their
// findings are reported as TODO only while the file has no Settings::effective call yet; once that slice is merged (the
// file calls it), they are enforced like every other file without editing this test.
const PENDING={'backend/public/api/index.php':'accounts-backend','backend/jobs/accounts.php':'accounts-backend'};
const pendingOpen=(file,files)=>!!PENDING[file]&&!/Settings::effective\(/.test(strip(files[file]??''));
const strip=src=>src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const CONFIG_BASE=/^(\$(c|cfg|config|conf|eff|file)|\$(ctx|this)->(config|file)|matdraw_config\(\))$/;
/** Findings for {path: source}: raw switch reads and entry points without the overlay. */
function guard(files){
 const out=[];const read=new RegExp(String.raw`(\$[A-Za-z_]\w*(?:->\w+)*|matdraw_config\(\))\s*\[\s*'(${SWITCHES.join('|')})'\s*\]`,'g');
 for(const [file,src] of Object.entries(files)){
  const code=strip(src);const overlay=/Settings::effective\(/.test(code);
  if(!ANY.has(file))for(const m of code.matchAll(read)){
   const [,base,key]=m;if(!CONFIG_BASE.test(base))continue;// $db['organizers'] (workspace map), request bodies, rows
   const raw=/(^\$file$|->file$|^matdraw_config)/.test(base);
   const entry=/^backend\/(jobs|bin|public)\//.test(file);
   if(raw||entry&&!overlay)out.push(`${file}: ${base}['${key}']`+(raw?' reads config.php directly':' without Settings::effective'));
  }
  if(/matdraw_config\(\)/.test(code)&&!overlay&&!RAW_ENTRY[file]&&!/^backend\/src\//.test(file))out.push(`${file}: matdraw_config() without Settings::effective`);
 }
 return out;
}
const tree=dir=>readdirSync(dir).flatMap(f=>{const p=dir+'/'+f;return statSync(p).isDirectory()?tree(p):p.endsWith('.php')?[p]:[];});

test('guard: the switches are read only from the effective configuration (Settings::effective), never from config.php directly',t=>{
 const files=Object.fromEntries(tree('backend').map(f=>[f,readFileSync(f,'utf8')]));
 const found=guard(files),open=f=>pendingOpen(f.split(':')[0],files),pending=found.filter(open),rest=found.filter(f=>!open(f));
 assert.deepEqual(rest,[]);
 if(pending.length)t.todo(pending.map(f=>f+' (until '+PENDING[f.split(':')[0]]+' is merged)').join('; '));
 // The one place of the overlay for registry routes, and the raw file kept apart in RouteContext.
 assert.match(files['backend/src/Routes.php'],/if\(self::needsSettings\(\$name,\$r,\$_COOKIE\[Auth::COOKIE\]\?\?null\)\)\{\$pdo=\\matdraw_database\(\$c\);\$eff=Settings::effective\(\$pdo,\$c\);\}/);
 assert.match(files['backend/src/Routes.php'],/new RouteContext\(\$name,\$r,\$eff,\$body,\$raw,\$pdo,\$c\)/);
 assert.equal((files['backend/src/Routes.php'].match(/matdraw_database\(/g)||[]).length,1,'dispatch opens no other connection');
 for(const f of tree('backend/routes'))assert.doesNotMatch(files[f].replace(/^\s*\/\/.*$/gm,''),new RegExp(String.raw`->file\[\s*'(${SWITCHES.join('|')})'`),f);
});
test('guard: planted violations are found',()=>{
 assert.deepEqual(guard({
  'backend/routes/x.php':"$ok=$ctx->config['signup_enabled'];$bad=$ctx->file['billing_enforce'];$ws=$db['organizers'];$body=$in['support_email'];",
  'backend/jobs/x.php':"'run'=>function(PDO $pdo,array $c,int $now){if(!empty($c['billing_enforce']))return 'x';}",
  'backend/jobs/y.php':"'run'=>function(PDO $pdo,array $c,int $now){$c=Settings::effective($pdo,$c);if(!empty($c['billing_enforce']))return 'x';}",
  'backend/bin/z.php':"$c=matdraw_config();Access::of($pdo,$u,$c);",
  'backend/src/Settings.php':"$c['organizers'];",
 }),["backend/routes/x.php: $ctx->file['billing_enforce'] reads config.php directly","backend/jobs/x.php: $c['billing_enforce'] without Settings::effective","backend/bin/z.php: matdraw_config() without Settings::effective"]);
});

// ---- Guard: a route that reaches a switch gets the overlay on every path to its handler (§3.2) ---------------------------
// The guard above finds raw reads; this one finds a route whose handler reads a switch through $ctx->config (directly or
// through a method of backend/src that reads one, at any depth) while a guest reaches it without the overlay: public and
// webhook routes without 'settings'=>true (or Routes::SETTINGS), peek routes for optional or anonymous users. Settings and
// Config read config.php by design (the overlay itself and the file check): a method calling Settings::effective computes
// the overlay itself and is not a reader.
const OVERLAY_CLASSES=new Set(['Settings','Config']);
const SWITCH_READ=new RegExp(String.raw`(\$(?:c|cfg|config|conf|eff)|\$(?:ctx|this)->config)\s*\[\s*'(${SWITCHES.join('|')})'\s*\]`);
// Routes a guest reaches without the overlay although a method they call reads a switch, with the reason that is safe.
const GUEST_SAFE={'chat-feed':'Chat::peekViewer reads access only for a live session, whose cookie computes the overlay'};
/** Class::method of backend/src files that read a switch of their configuration, directly or through another such method. */
function switchReaders(srcFiles){
 const methods={};
 for(const [file,src] of Object.entries(srcFiles)){
  const cls=file.split('/').pop().replace(/\.php$/,'');if(OVERLAY_CLASSES.has(cls))continue;
  for(const part of strip(src).split(/\n (?=(?:(?:public|private|protected) )?(?:static )?function \w+\()/)){const m=part.match(/^(?:(?:public|private|protected) )?(?:static )?function (\w+)\(/);if(m)methods[cls+'::'+m[1]]=part;}
 }
 const calls=(body,cls,ref)=>{const [c,m]=ref.split('::');return new RegExp(String.raw`(?<![\w\\])${c}::${m}\(`).test(body)||c===cls&&new RegExp(String.raw`(?:self|static)::${m}\(`).test(body);};
 const readers=new Set(Object.keys(methods).filter(k=>SWITCH_READ.test(methods[k])));
 for(let grew=true;grew;){grew=false;for(const [k,body] of Object.entries(methods))if(!readers.has(k)&&[...readers].some(r=>calls(body,k.split('::')[0],r))){readers.add(k);grew=true;}}
 return readers;
}
/** name => source of each route definition of backend/routes files (a route starts with "\n '<name>'=>[" at the top level). */
function routeSpans(routeFiles){
 const out={};
 for(const src of Object.values(routeFiles))for(const part of strip(src).split(/\n (?='[a-z][a-z0-9-]*'=>\[)/).slice(1))out[part.match(/^'([a-z0-9-]+)'/)[1]]=part;
 return out;
}
/** Findings for route and src sources and the registry {name: [auth, needsSettings without a cookie, …, user]}. */
function routeGuard(routeFiles,srcFiles,registry){
 const readers=[...switchReaders(srcFiles)],out=[];
 for(const [name,span] of Object.entries(routeSpans(routeFiles))){
  const hits=[...(SWITCH_READ.test(span)?['$ctx->config']:[]),...readers.filter(r=>new RegExp(String.raw`(?<![\w\\])${r}\(`).test(span))];
  if(!hits.length)continue;
  if(!registry[name]){out.push(`${name}: not registered`);continue;}
  const [mode,none,,,user]=registry[name];
  const guest=mode==='public'||mode==='webhook'||mode==='peek'&&['optional','anon'].includes(user);
  if(guest&&!none&&!GUEST_SAFE[name])out.push(`${name}: ${hits.join(', ')} without the effective configuration for a guest`);
 }
 return out;
}
const sources=dir=>Object.fromEntries(tree(dir).map(f=>[f,readFileSync(f,'utf8')]));

test('guard: every route that reads a switch gets the effective configuration on each path to its handler',{skip},()=>{
 const registry=bridge({job:'needs'}),routeFiles=sources('backend/routes'),srcFiles=sources('backend/src');
 assert.deepEqual(routeGuard(routeFiles,srcFiles,registry),[]);
 const readers=switchReaders(srcFiles);
 for(const m of ['Access::compute','Billing::state','Members::signupOpen','Chat::viewer'])assert.ok(readers.has(m),m+' is known to read a switch');
 assert.ok(![...readers].some(m=>/^(Settings|Config)::/.test(m)),'the overlay itself is not a reader');
 assert.ok(SWITCH_READ.test(routeSpans(routeFiles)['public-config']),'public-config reads switches (and gets the overlay)');
 for(const name of Object.keys(GUEST_SAFE))assert.ok(registry[name],name+' is registered');
});
test('guard: planted route violations are found',()=>{
 const route=(name,auth,body,extra='')=>`\n '${name}'=>['method'=>'GET','auth'=>'${auth}'${extra},'handler'=>fn(RouteContext $ctx):array=>${body}],`;
 const routeFiles={'backend/routes/x.php':'<?php\nreturn ['+route('x-public','public',"['s'=>$ctx->config['signup_enabled']]")+route('x-flagged','public',"['s'=>$ctx->config['signup_enabled']]",",'settings'=>true")
  +route('x-helper','public','Foo::bar($ctx->config)')+route('x-member','peek',"['s'=>$ctx->config['support_email']]")+route('x-guest','peek','Foo::bar($ctx->config)',",'user'=>'optional'")
  +route('x-chat','public','ChatSettings::get($ctx->pdo())')+route('x-own','public','Chat::trust($ctx->pdo(),$ctx->config)')+route('x-hook','webhook',"Billing::hook($ctx->config)")+'\n];'};
 const srcFiles={'backend/src/Foo.php':"<?php\nfinal class Foo {\n public static function bar(array $c):bool{return self::inner($c);}\n private static function inner(array $c):bool{return !empty($c['billing_enforce']);}\n}",
  'backend/src/Settings.php':"<?php\nfinal class Settings {\n public static function effective(?PDO $pdo,array $c):array{return ['s'=>$c['signup_enabled']];}\n}",
  'backend/src/ChatSettings.php':"<?php\nfinal class ChatSettings {\n public static function get(PDO $pdo):array{return [];}\n}",
  'backend/src/Chat.php':"<?php\nfinal class Chat {\n public static function trust(PDO $pdo,array $c):bool{return Settings::effective($pdo,$c)['organizers']==='on';}\n public static function get(PDO $pdo,array $c):bool{return $c['organizers']==='on';}\n}",
  'backend/src/Billing.php':"<?php\nfinal class Billing {\n public static function hook(array $c):array{return Access::compute(null,[],$c,0);}\n}",
  'backend/src/Access.php':"<?php\nfinal class Access {\n public static function compute(?array $row,array $u,array $cfg,int $now):array{return empty($cfg['billing_enforce'])?[]:[1];}\n}"};
 const registry={'x-public':['public',false,false,false,null],'x-flagged':['public',true,true,true,null],'x-helper':['public',false,false,false,null],'x-member':['peek',false,true,false,'required'],
  'x-guest':['peek',false,true,false,'optional'],'x-chat':['public',false,false,false,null],'x-own':['public',false,false,false,null],'x-hook':['webhook',false,false,false,null]};
 assert.deepEqual([...switchReaders(srcFiles)].sort(),['Access::compute','Billing::hook','Chat::get','Foo::bar','Foo::inner']);
 assert.deepEqual(routeGuard(routeFiles,srcFiles,registry),["x-public: $ctx->config without the effective configuration for a guest","x-helper: Foo::bar without the effective configuration for a guest",
  "x-guest: Foo::bar without the effective configuration for a guest","x-hook: Billing::hook without the effective configuration for a guest"]);
});
