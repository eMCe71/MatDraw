// backend/bin/stripe-setup.php against the Stripe stub (plan §6.9, §10, §12.8; S4/H11): the full key is refused in argv,
// read from a pipe or from a terminal with echo off (never printed, logged or written to disk), checked against --mode;
// product, prices and portal configuration are created once and found again (idempotent), --reprice and --webhook,
// --dry-run changes nothing; the config block and the reminder to roll the sk_ key are printed.
// The stub runs on an ephemeral port in a temporary directory; nothing leaves 127.0.0.1.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const php=process.env.PHP_BIN,skip=!php;
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url))),script=path.join(repo,'backend/bin/stripe-setup.php');
const KEY='sk_'+'test_SetupSecretKey0123456789',LIVE='sk_'+'live_SetupSecretKey0123456789';
let stub=null,base='',dir='',config='';
const control=async body=>(await fetch(base+'/__control',{method:'POST',body:JSON.stringify(body)})).json();
function writeConfig(extra=''){writeFileSync(config,`<?php\nreturn ['app_url'=>'https://matbravo.test','db'=>['dsn'=>'mysql:host=127.0.0.1;dbname=none','user'=>'x','password'=>'x'],'app_key'=>'${'ab'.repeat(32)}','allow_insecure_http'=>true,'stripe_api_base'=>'${base}'${extra}];\n`);}
/** Runs the script with STDIN from a pipe; cwd and HOME are the temporary directory. */
function run(args,input=KEY+'\n'){
 const r=spawnSync(php,[script,...args],{input,encoding:'utf8',cwd:dir,env:{...process.env,MATDRAW_CONFIG:config,HOME:dir}});
 return {code:r.status,out:r.stdout,err:r.stderr,all:r.stdout+r.stderr};
}
/** Every file under dir (except the PHP symlink) as text, to prove the key never reached the disk. */
const filesText=d=>readdirSync(d,{recursive:true}).map(f=>path.join(d,f)).filter(f=>{try{return statSync(f).isFile();}catch{return false;}}).map(f=>readFileSync(f,'latin1')).join('\n');
before(async()=>{
 if(skip)return;
 dir=mkdtempSync(path.join(tmpdir(),'matdraw-setup-'));config=path.join(dir,'config.php');
 stub=spawn(process.execPath,[path.join(repo,'tests/stubs/stripe-stub.mjs'),'0','--empty'],{stdio:['ignore','pipe','inherit']});
 base=await new Promise((ok,fail)=>{let out='';stub.stdout.on('data',d=>{out+=d;const m=out.match(/127\.0\.0\.1:(\d+)/);if(m)ok('http://127.0.0.1:'+m[1]);});stub.on('exit',()=>fail(Error('stub exited')));});
 writeConfig();
});
after(()=>{stub?.kill();if(dir)rmSync(dir,{recursive:true,force:true});});

test('a key in argv is refused before anything else, without repeating it',{skip},async()=>{
 await control({op:'clear'});
 for(const args of [['--mode=test','--key='+KEY],['--mode=test',KEY],['--key',KEY,'--mode=test'],['--mode=test','--secret='+KEY],['--mode='+KEY],['--mode=test','rk_'+'test_Abc12345678'],['--mode=test','--api-key=x']]){
  const r=run(args,'');assert.equal(r.code,2,args.join(' '));assert.match(r.err,/nie może być podany w linii poleceń/);assert.match(r.err,/read -rs K/);
  assert.ok(!r.all.includes(KEY)&&!r.all.includes('Abc12345678'),'the key is never echoed: '+args.join(' '));
 }
 assert.deepEqual(await control({op:'requests'}),[],'no request reached Stripe');
});

test('mode, arguments and key format are checked; the key is never shown',{skip},async()=>{
 await control({op:'clear'});
 let r=run([]);assert.equal(r.code,2);assert.match(r.err,/--mode=test albo --mode=live/);
 r=run(['--mode=test','--unknown']);assert.equal(r.code,2);assert.match(r.err,/Nieznany argument/);
 r=run(['--mode=live']);assert.equal(r.code,2);assert.match(r.err,/nie pasuje do trybu --mode=live/);assert.ok(!r.all.includes(KEY));
 r=run(['--mode=test'],LIVE+'\n');assert.equal(r.code,2);assert.ok(!r.all.includes(LIVE));
 r=run(['--mode=test'],'pk_test_123456789\n');assert.equal(r.code,2);assert.match(r.err,/To nie wygląda na klucz Stripe/);assert.ok(!r.all.includes('pk_test_123456789'));
 r=run(['--mode=test'],'');assert.equal(r.code,2);
 assert.deepEqual(await control({op:'requests'}),[]);
});

test('setup creates product, prices and portal once; the second run finds them; nothing written to disk',{skip},async()=>{
 await control({op:'reset',empty:true});
 const dry=run(['--mode=test','--dry-run']);assert.equal(dry.code,0,dry.all);
 assert.match(dry.out,/\[dry-run\] Utworzyłbym produkt matbravo_membership/);assert.match(dry.out,/\[dry-run\] Utworzyłbym cenę matbravo_monthly_pln \(899 pln\)/);
 assert.deepEqual((await control({op:'requests',clear:true})).filter(x=>x.method!=='GET'),[],'dry-run only reads');
 const first=run(['--mode=test']);assert.equal(first.code,0,first.all);
 for(const line of ['Produkt matbravo_membership: utworzony.','Cena matbravo_monthly_pln: utworzona (899 pln).','Cena matbravo_monthly_usd: utworzona (299 usd).',"'billing_mode' => 'test',",
  "'stripe_secret_key' => 'REPLACE_WITH_rk_test_key'","'stripe_prices' => ['pln' => 'matbravo_monthly_pln', 'usd' => 'matbravo_monthly_usd'],","'billing_amounts' => ['pln' => 899, 'usd' => 299],",
  'Po konfiguracji wygeneruj nowy klucz sk_ w panelu Stripe (Roll key). Na serwerze zostaje tylko klucz ograniczony rk_.'])assert.ok(first.out.includes(line),line);
 const bpc=first.out.match(/'stripe_portal_configuration' => '(bpc_[A-Za-z0-9]+)'/);assert.ok(bpc,'portal configuration id printed');
 assert.ok(!first.out.includes('stripe_webhook_secrets'),'no webhook without --webhook');
 assert.ok(!first.all.includes(KEY),'the key is never printed');
 let reqs=await control({op:'requests',clear:true});
 for(const x of reqs){assert.equal(x.authorization,'Bearer '+KEY);assert.equal(x.version,'2026-09-30.endive');if(x.method==='POST')assert.match(x.idempotencyKey,/^matbravo-/);}
 const posts=reqs.filter(x=>x.method==='POST');
 assert.deepEqual(posts.map(x=>x.path),['/v1/products','/v1/prices','/v1/prices','/v1/billing_portal/configurations']);
 assert.deepEqual(posts[0].body,{id:'matbravo_membership',name:'MatBravo',description:'MatBravo account (monthly)',metadata:{matbravo_key:'membership'}});
 assert.deepEqual(posts[1].body,{product:'matbravo_membership',currency:'pln',unit_amount:'899',recurring:{interval:'month',interval_count:'1'},lookup_key:'matbravo_monthly_pln',nickname:'MatBravo monthly PLN',metadata:{matbravo_key:'monthly_pln'}});
 const portal=posts[3].body;
 assert.deepEqual([portal.features.subscription_cancel.mode,portal.features.subscription_update.enabled,portal.login_page.enabled,portal.metadata.matbravo_key,portal.default_return_url],['at_period_end','false','false','portal_v1','https://matbravo.test/?billing=portal']);
 const second=run(['--mode=test']);assert.equal(second.code,0,second.all);
 assert.match(second.out,/Produkt matbravo_membership: jest\./);assert.match(second.out,/Cena matbravo_monthly_pln: jest \(899 pln\)\./);assert.match(second.out,new RegExp(`Portal klienta: zaktualizowany \\(${bpc[1]}\\)`));
 reqs=await control({op:'requests',clear:true});
 assert.deepEqual(reqs.filter(x=>x.method==='POST').map(x=>x.path),['/v1/billing_portal/configurations/'+bpc[1]],'idempotent: only the portal is updated in place');
 assert.ok(!filesText(dir).includes(KEY.slice(8)),'the key is not written anywhere in the working directory');
});

test('a price that differs stops the setup unless --reprice creates a new one with the lookup key',{skip},async()=>{
 writeConfig(",'billing_amounts'=>['pln'=>999,'usd'=>299]");
 try{
  const stop=run(['--mode=test']);assert.equal(stop.code,3,stop.all);assert.match(stop.out,/Cena matbravo_monthly_pln różni się od oczekiwanej \(999 pln miesięcznie\)\. Uruchom z --reprice/);
  await control({op:'clear'});
  const re=run(['--mode=test','--reprice']);assert.equal(re.code,0,re.all);assert.match(re.out,/Cena matbravo_monthly_pln: nowa \(999 pln\)/);
  const p=(await control({op:'requests',clear:true})).find(x=>x.method==='POST'&&x.path==='/v1/prices');
  assert.deepEqual([p.body.unit_amount,p.body.transfer_lookup_key,p.body.lookup_key],['999','true','matbravo_monthly_pln']);
  assert.match(run(['--mode=test']).out,/Cena matbravo_monthly_pln: jest \(999 pln\)\./);
 }finally{writeConfig();}
});

test('--webhook creates the endpoint once and prints its secret once; --rotate-webhook replaces it',{skip},async()=>{
 await control({op:'reset'});// seeded account: product, both prices (899/299) and a portal configuration
 await control({op:'clear'});
 const w=run(['--mode=test','--webhook']);assert.equal(w.code,0,w.all);
 const secret=w.out.match(/'stripe_webhook_secrets' => \['(whsec_[A-Za-z0-9]+)'\]/);assert.ok(secret,'secret printed in the config block');
 const created=(await control({op:'requests',clear:true})).find(x=>x.method==='POST'&&x.path==='/v1/webhook_endpoints').body;
 assert.equal(created.url,'https://matbravo.test/api/index.php?route=stripe-webhook');assert.equal(created.api_version,'2026-09-30.endive');
 assert.equal(created.enabled_events.length,15);assert.ok(created.enabled_events.includes('invoice.paid')&&created.enabled_events.includes('customer.deleted'));
 const again=run(['--mode=test','--webhook']);assert.match(again.out,/Webhook: jest \(we_/);assert.ok(!again.out.includes('whsec_'),'the secret is shown only when created');
 const rot=run(['--mode=test','--rotate-webhook']);assert.match(rot.out,/Webhook: usunięty przed ponownym utworzeniem\./);
 const fresh=rot.out.match(/'stripe_webhook_secrets' => \['(whsec_[A-Za-z0-9]+)'\]/);assert.ok(fresh&&fresh[1]!==secret[1],'a new secret');
});

const hasScript=!skip&&spawnSync('sh',['-c','command -v script && command -v stty'],{encoding:'utf8'}).status===0;
/** Runs the script in a pseudo-terminal (util-linux script); types the key only after the prompt appeared. */
function inTerminal(cmd,key){
 return new Promise(resolve=>{
  const p=spawn('script',['-qec',cmd,'/dev/null'],{cwd:dir,env:{...process.env,MATDRAW_CONFIG:config,HOME:dir}});let out='',typed=false;
  const timer=setTimeout(()=>p.kill(),20000);
  p.stdout.on('data',d=>{out+=d;if(!typed&&key!==null&&out.includes('Wklej klucz')){typed=true;p.stdin.write(key+'\n');}});
  p.on('close',code=>{clearTimeout(timer);resolve({code,out});});
 });
}
test('on a terminal the key is typed with echo off and echo is restored; without stty the script refuses with read -rs',{skip:!hasScript},async()=>{
 const q=s=>"'"+s.replace(/'/g,"'\\''")+"'";
 const r=await inTerminal(`${q(php)} ${q(script)} --mode=test --dry-run; echo "rc=$?"; stty -a | tr ' ' '\\n' | grep -x -- '-\\?echo'`,KEY);
 assert.match(r.out,/Wklej klucz sk_test_… \(nie będzie widoczny\)/);assert.match(r.out,/Stripe: konfiguracja w trybie test \(dry-run: bez zmian\)\./);assert.match(r.out,/rc=0/);
 assert.ok(!r.out.includes(KEY),'the typed key is not echoed');assert.match(r.out,/^echo\r?$/m,'terminal echo is on again afterwards');
 mkdirSync(path.join(dir,'bin'),{recursive:true});try{symlinkSync(php,path.join(dir,'bin','php'));}catch{}
 const n=await inTerminal(`env PATH=${q(path.join(dir,'bin'))} php ${q(script)} --mode=test; echo "rc=$?"`,null);
 assert.match(n.out,/Nie można ukryć wpisywanego klucza/);assert.match(n.out,/read -rs K; printf '%s\\n' "\$K" \| \/usr\/local\/php83\/bin\/php stripe-setup\.php --mode=test; unset K/);assert.match(n.out,/rc=2/);
});
