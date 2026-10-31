// Workspace isolation of member accounts, the account-takeover regression, migrations and backups (plan §2, §3.3, §9.6).
// Run through scripts/test-http.sh. Migration and backup scenarios use the second database MATDRAW_TEST_AUX_DB when it
// is set (fresh schema, empty, then upgraded); without it they fall back to the main test database.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readdirSync,statSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend=path.join(process.env.MATDRAW_TEST_RELEASE||repo,'backend');
const run=(script,args=[],env={},input)=>{const r=spawnSync(php,[path.join(backend,'bin',script),...args],{encoding:'utf8',env:{...process.env,...env},input,maxBuffer:50_000_000});return {code:r.status,out:r.stdout.trim(),err:r.stderr.trim()};};
// Small PHP programs against the database of MATDRAW_CONFIG; $pdo is ready, the result is printed as JSON.
const sql=(code,env={},input='')=>{const r=spawnSync(php,['-r',`require ${JSON.stringify(path.join(backend,'bootstrap.php'))};$pdo=matdraw_database(matdraw_config());$in=json_decode(stream_get_contents(STDIN)?:'null',true);echo json_encode((function()use($pdo,$in){${code}})());`],{encoding:'utf8',env:{...process.env,...env},input,maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);};
// Data hash of every table: explicit rows ordered by primary key (not CHECKSUM TABLE, which changes with the row format).
const HASH=`$t=[];foreach($pdo->query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")->fetchAll(PDO::FETCH_NUM) as [$n]){$k=$pdo->query("SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='$n' AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION")->fetchAll(PDO::FETCH_COLUMN);$rows=$pdo->query("SELECT * FROM \`$n\` ORDER BY ".($k?implode(',',array_map(fn($c)=>"\`$c\`",$k)):'1'))->fetchAll(PDO::FETCH_NUM);$t[$n]=hash('sha256',json_encode(array_map(fn($r)=>array_map('strval',array_map(fn($v)=>$v??"\\0NULL",$r)),$rows)));}ksort($t);return $t;`;
const memberRow=(email,env)=>sql('$q=$pdo->prepare("SELECT id,role,club_id,password_hash,auth_version,active FROM users WHERE email=?");$q->execute([$in]);return $q->fetch();',env,JSON.stringify(email));
before(()=>fixture('reset-limits'));

test('member accounts never enter the workspace and cannot be taken over through account.save',{skip:!base},async()=>{
 const email='czlonek.izolacja@test.example';
 const member=fixture('member',{email,password:'MemberPassword2026!',profile:true,exempt:true});
 const before=memberRow(email);assert.equal(before.role,'member');assert.equal(before.club_id,null);assert.equal(before.id,member.id);
 // Old login path: the member is not part of the workspace, so the login fails exactly like an unknown e-mail.
 // (Once the lightweight member login exists, a member gets an empty workspace and no commands instead.)
 const m=new Client();await m.req('session');const login=await m.req('login',{email,password:'MemberPassword2026!'});
 if(login.status===401)assert.equal(login.data.error,'Nieprawidłowy e-mail lub hasło.');
 else{
  assert.equal(login.status,200,JSON.stringify(login.data));const w=(await m.req('bootstrap')).data;
  for(const k of ['clubs','users','profiles','tournaments'])assert.deepEqual(w[k],[],k);
  assert.equal((await m.req('command',{type:'tournament.save',payload:{},expectedRevision:w.revision})).status,403);
 }
 const admin=new Client();await admin.login('admin@test.example','AdminForTests2026!');
 assert.ok(!JSON.stringify(admin.data).includes(email),'the member is not in the staff workspace');
 // Regression (D4): creating a staff account with the member's e-mail used to upsert over the member's row
 // (silently for a member without profile rows, which no foreign key protects).
 const bare='czlonek.bez.profilu@test.example';fixture('member',{email:bare});const bareBefore=memberRow(bare);
 const clubs=admin.data.clubs.length,revision=admin.data.revision;
 for(const variant of [bare,email,email.toUpperCase()]){
  const r=await admin.req('command',{type:'account.save',payload:{email:variant,password:'TakeoverAttempt2026!',clubName:'Klub przejęcia',role:'club'},expectedRevision:admin.data.revision});
  assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.error,'Konto z tym adresem e-mail już istnieje.');
 }
 assert.deepEqual(memberRow(email),before,'member row untouched (id, role, password hash, auth version)');assert.deepEqual(memberRow(bare),bareBefore);
 await admin.load();assert.equal(admin.data.clubs.length,clubs,'the whole command was rolled back');assert.equal(admin.data.revision,revision);
 // Changing an existing staff e-mail to the member's e-mail is refused too, and the staff row stays as it was.
 await admin.cmd('account.save',{email:'personel.izolacja@test.example',password:'TestPassword2026!',clubId:admin.data.user.clubId,role:'editor'});
 const staff=admin.data.users.find(u=>u.email==='personel.izolacja@test.example');
 const r=await admin.req('command',{type:'account.save',payload:{...staff,email},expectedRevision:admin.data.revision});
 assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.error,'Konto z tym adresem e-mail już istnieje.');
 assert.deepEqual(memberRow(email),before);assert.equal(memberRow('personel.izolacja@test.example').role,'editor');
 await admin.load();assert.equal(admin.data.users.find(u=>u.id===staff.id).email,'personel.izolacja@test.example');
 // Ordinary staff writes keep working after the refused ones (no stale state in the session or revision).
 await admin.cmd('account.save',{...admin.data.users.find(u=>u.id===staff.id),active:false});
 assert.equal(admin.data.users.find(u=>u.id===staff.id).active,false);
});

test('migrate.php on the main test database: a second run changes nothing',{skip:!base},()=>{
 const hash=sql(HASH),st=run('migrate.php',['--status']);
 assert.equal(st.code,0,st.err);assert.match(st.out,/^STATE=ready CURRENT=(\d+) TARGET=\1 PENDING=0 DESTRUCTIVE=0 FLOOR=\d+$/);
 const again=run('migrate.php');assert.equal(again.code,0,again.err);assert.match(again.out,/^Schemat aktualny/);
 assert.deepEqual(sql(HASH),hash);
});

test('migrations from empty and from version 1, rollback floor, dump.php --auto and restore',{skip:!base},()=>{
 const aux=process.env.MATDRAW_TEST_AUX_DB;
 // A config for the second database in <dir>/shared/config.php, so --auto writes to <dir>/backups like production.
 const dir=process.env.MATDRAW_TEST_SHARED_DIR?path.join(path.dirname(process.env.MATDRAW_TEST_SHARED_DIR),'aux'):mkdtempSync(path.join(tmpdir(),'matdraw-aux-'));
 mkdirSync(path.join(dir,'shared'),{recursive:true,mode:0o700});const config=path.join(dir,'shared','config.php');
 if(aux)sql('$c=require getenv("MATDRAW_CONFIG");$c["db"]["dsn"]=preg_replace("/dbname=[^;]+/","dbname=".$in["db"],$c["db"]["dsn"]);file_put_contents($in["path"],"<?php\\nreturn ".var_export($c,true).";\\n");chmod($in["path"],0600);return true;',{},JSON.stringify({db:aux,path:config}));
 else sql('copy(getenv("MATDRAW_CONFIG"),$in);chmod($in,0600);return true;',{},JSON.stringify(config));
 const env={MATDRAW_CONFIG:config};
 const status=()=>{const r=run('migrate.php',['--status'],env);assert.equal(r.code,0,r.err);return r.out;};
 const floor=()=>{const r=run('migrate.php',['--rollback-floor'],env);assert.equal(r.code,0,r.err);return Number(r.out);};
 const target=sql('require_once dirname(getenv("B")).chr(47)."src/Migrator.php";return MatDraw\\Migrator::target(getenv("B"));',{B:path.join(backend,'migrations')});
 if(aux){
  // Empty database: status says so, migrate exits 10 (run the installer), the floor is 1.
  assert.equal(status(),`STATE=empty CURRENT=0 TARGET=${target} PENDING=0 DESTRUCTIVE=0 FLOOR=1`);
  const empty=run('migrate.php',[],env);assert.equal(empty.code,10,empty.out+empty.err);assert.match(empty.out,/instalator/);
  // Version 1 (the frozen baseline) with existing staff data, as in production before 0002.
  sql('$pdo->exec(file_get_contents($in));$pdo->exec("INSERT INTO clubs (id,name) VALUES (\'c1\',\'Klub bazowy\')");$pdo->exec("INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES (\'u1\',\'c1\',\'admin@aux.example\',\'admin\',1,\'x\',1),(\'u2\',\'c1\',\'klub@aux.example\',\'club\',1,\'y\',3)");return true;',env,JSON.stringify(path.join(backend,'database','schema.sql')));
  assert.equal(status(),`STATE=ready CURRENT=1 TARGET=${target} PENDING=${target-1} DESTRUCTIVE=0 FLOOR=1`);
  const old=sql('return [$pdo->query("SELECT id,club_id,email,role,active,password_hash,auth_version FROM users ORDER BY id")->fetchAll(),$pdo->query("SELECT id,name FROM clubs ORDER BY id")->fetchAll()];',env);
  const dry=run('migrate.php',['--dry-run'],env);assert.equal(dry.code,0,dry.err);assert.match(dry.out,/\[dry-run\] Migracja 0002_accounts/);assert.match(dry.out,/CREATE TABLE IF NOT EXISTS user_profiles/);
  assert.match(status(),/^STATE=ready CURRENT=1 /,'--dry-run changes nothing');
  const up=run('migrate.php',[],env);assert.equal(up.code,0,up.err);assert.match(up.out,new RegExp(`Schemat: v1 -> v${target}`));
  // Additive: the old rows are unchanged, existing staff are grandfathered free accounts.
  assert.deepEqual(sql('return [$pdo->query("SELECT id,club_id,email,role,active,password_hash,auth_version FROM users ORDER BY id")->fetchAll(),$pdo->query("SELECT id,name FROM clubs ORDER BY id")->fetchAll()];',env),old);
  assert.deepEqual(sql('return $pdo->query("SELECT user_id,billing_exempt,exempt_reason,exempt_until FROM billing_accounts ORDER BY user_id")->fetchAll();',env),[{user_id:'u1',billing_exempt:1,exempt_reason:'grandfathered',exempt_until:null},{user_id:'u2',billing_exempt:1,exempt_reason:'grandfathered',exempt_until:null}]);
  assert.deepEqual(sql('return $pdo->query("SELECT COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'users\' AND COLUMN_NAME IN (\'role\',\'club_id\') ORDER BY COLUMN_NAME")->fetchAll(PDO::FETCH_NUM);',env),[['varchar(40)','YES'],["enum('admin','editor','club','member')",'NO']]);
  assert.equal(sql('return $pdo->query("SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'user_profiles\' AND COLUMN_NAME=\'name_display\'")->fetchColumn();',env).replace(/'/g,''),'initial');
  const hash=sql(HASH,env),again=run('migrate.php',[],env);assert.equal(again.code,0,again.err);assert.match(again.out,/^Schemat aktualny/);assert.deepEqual(sql(HASH,env),hash,'second run changes nothing');
 }
 // Rollback floor: 1 while no member exists, 2 (migration 0002) as soon as one does.
 const members=sql('return (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role=\'member\'")->fetchColumn();',env);
 if(!members)assert.equal(floor(),1);
 fixture('member',{email:'floor@aux.example',profile:{firstName:'Ewa',lastName:'Nowak',username:'ewa.floor'}},env);
 assert.equal(floor(),2);assert.match(status(),/ FLOOR=2$/);
 // dump.php --auto: a 600 file in a 700 directory next to shared/, valid gzip with the marker, restorable with equal data.
 const backups=path.join(dir,'backups'),hash=sql(HASH,env);
 const d=run('dump.php',['--auto'],env);assert.equal(d.code,0,d.err);assert.match(d.out,/Kopia bazy: /);
 const files=readdirSync(backups).filter(f=>/^db-\d{14}-daily\.sql\.gz$/.test(f));assert.equal(files.length,1,readdirSync(backups).join());
 const file=path.join(backups,files[0]);
 assert.equal(statSync(file).mode&0o777,0o600);assert.equal(statSync(backups).mode&0o777,0o700);
 assert.equal(spawnSync('gzip',['-t',file]).status,0,'gzip -t');
 const text=sql('return gzdecode(file_get_contents($in));',{},JSON.stringify(file));
 assert.match(text,/-- Dump completed on \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n$/);assert.match(text,/SET FOREIGN_KEY_CHECKS=0;/);assert.match(text,/DROP TABLE IF EXISTS `users`;\nCREATE TABLE `users`/);
 assert.ok(statSync(file).size>1024,'more than 1 KiB');
 // A second call within 20 hours does nothing.
 const second=run('dump.php',['--auto'],env);assert.equal(second.code,0,second.err);assert.match(second.out,/aktualna/);
 assert.deepEqual(readdirSync(backups).filter(f=>f.endsWith('.sql.gz')),files);
 // Restore as DEPLOY-PL.md describes: drop every table, import the copy; the data hash is equal.
 sql('$pdo->exec("SET FOREIGN_KEY_CHECKS=0");foreach($pdo->query("SHOW FULL TABLES WHERE Table_type=\'BASE TABLE\'")->fetchAll(PDO::FETCH_NUM) as [$n])$pdo->exec("DROP TABLE `$n`");$pdo->exec("SET FOREIGN_KEY_CHECKS=1");return true;',env);
 assert.equal(sql('return count($pdo->query("SHOW TABLES")->fetchAll());',env),0);
 sql('foreach(explode(";\\n",gzdecode(file_get_contents($in))) as $s){if(trim(preg_replace("/^--.*$/m","",$s))!=="")$pdo->exec($s);}return true;',env,JSON.stringify(file));
 assert.deepEqual(sql(HASH,env),hash,'restored data equals the dumped data');
 assert.match(status(),/ PENDING=0 DESTRUCTIVE=0 FLOOR=2$/);
 // Retention: copies older than 30 days go, but the newest copy always stays.
 const old=t=>{const f=path.join(backups,`db-2020010${t}000000-daily.sql.gz`);spawnSync('cp',[file,f]);const s=Date.now()/1000-(40+t)*86400;utimesSync(f,s,s);return f;};
 const o1=old(1),o2=old(2);utimesSync(file,Date.now()/1000-21*3600,Date.now()/1000-21*3600);
 const third=run('dump.php',['--auto'],env);assert.equal(third.code,0,third.err);
 const left=readdirSync(backups).filter(f=>f.endsWith('.sql.gz')).sort();
 assert.equal(left.length,2,left.join());assert.ok(left.includes(files[0])&&!left.includes(path.basename(o1))&&!left.includes(path.basename(o2)),left.join());
 for(const f of left)assert.equal(statSync(path.join(backups,f)).mode&0o777,0o600);
});
