// Lint of backend/migrations (plan §2.1, §11; report 04 §2.a.2): the SQL must run on MariaDB 10.6 and MySQL 8.0 and
// every migration must be additive, so the previous release keeps working on the new schema (rollback safety).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir='backend/migrations';
const files=readdirSync(dir).filter(f=>f.endsWith('.php')).sort();
// Statements on existing tables that 0002 may run although they modify columns (plan §2.3 a–b).
const ALLOWED={2:["ALTER TABLE users MODIFY role ENUM('admin','editor','club','member') NOT NULL",'ALTER TABLE users MODIFY club_id VARCHAR(40) NULL']};
const stripComments=s=>s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"])\/\/.*$/gm,'$1').replace(/^\s*#.*$/gm,'').replace(/--[^\n'"]*$/gm,'');
const parsed=files.map(name=>{const text=readFileSync(`${dir}/${name}`,'utf8');return {name,text,code:stripComments(text),id:Number(name.slice(0,4)),destructive:/'destructive'\s*=>\s*true/.test(text)};});

test('migration files are named NNNN_name.php with contiguous ids from 2 that match the returned id',()=>{
 assert.ok(files.length>=1);
 parsed.forEach((m,i)=>{assert.match(m.name,/^\d{4}_[a-z0-9_]+\.php$/);assert.equal(m.id,i+2,`${m.name}: expected ${String(i+2).padStart(4,'0')}`);
  assert.match(m.text,new RegExp(`'id'\\s*=>\\s*${m.id}\\s*,`),`${m.name}: 'id'=>${m.id}`);assert.match(m.text,/'destructive'\s*=>\s*(true|false)/,`${m.name}: destructive flag`);assert.match(m.text,/^<\?php[\s\S]*declare\(strict_types=1\);/,m.name);});
});

test('every CREATE TABLE is InnoDB utf8mb4_unicode_ci and names its foreign keys fk_<table>_…',()=>{
 for(const m of parsed){
  const creates=[...m.code.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*?)\)\s*(ENGINE[^"';]*)/gi)];
  assert.equal(creates.length,(m.code.match(/CREATE\s+TABLE/gi)||[]).length,`${m.name}: every CREATE TABLE ends with ENGINE=…`);
  for(const [,table,body,tail] of creates){
   assert.match(tail,/^ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\s*$/,`${m.name}: ${table}`);
   const fks=(body.match(/FOREIGN\s+KEY/gi)||[]).length,named=[...body.matchAll(/CONSTRAINT\s+`?(\w+)`?\s+FOREIGN\s+KEY/gi)].map(x=>x[1]);
   assert.equal(named.length,fks,`${m.name}: ${table} has an unnamed foreign key`);
   for(const fk of named)assert.ok(fk.startsWith(`fk_${table}_`),`${m.name}: ${fk} must start with fk_${table}_`);
   assert.ok(!/\bJSON\b[^,\n]*\bDEFAULT\b/i.test(body),`${m.name}: ${table} has a DEFAULT on a JSON column`);
   assert.ok(!/\bTIMESTAMP\b|\bDATETIME\b/i.test(body),`${m.name}: ${table} stores time as BIGINT epoch, not TIMESTAMP/DATETIME`);
  }
 }
});

test('no SQL outside the shared MariaDB 10.6 / MySQL 8.0 subset',()=>{
 const banned=[[/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i,'ADD COLUMN IF NOT EXISTS (use $m->addColumn)'],[/(CREATE|ADD)\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i,'INDEX IF NOT EXISTS (use $m->addIndex)'],[/\bRETURNING\b/i,'RETURNING'],[/->>/,'->>'],[/\bJSON_VALUE\b/i,'JSON_VALUE'],[/\bNOW\s*\(/i,'NOW()'],[/\bCURRENT_TIMESTAMP\b/i,'CURRENT_TIMESTAMP'],[/\bVALUES\s*\([^)]*\)\s+AS\s+\w+/i,'row alias in upsert'],[/\bALGORITHM\s*=/i,'ALGORITHM= hint'],[/\bOVER\s*\(/i,'window function'],[/ADD\s+(CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY/i,'new foreign key on an existing table']];
 for(const m of parsed)for(const [re,label] of banned)assert.ok(!re.test(m.code),`${m.name}: ${label}`);
});

test('DROP, MODIFY, CHANGE and RENAME only in destructive migrations or the allowed 0002 statements',()=>{
 for(const m of parsed){
  if(m.destructive)continue;let code=m.code;
  for(const s of ALLOWED[m.id]||[]){assert.ok(code.includes(s),`${m.name}: allowed statement missing or altered: ${s}`);code=code.split(s).join('');}
  const hit=code.match(/\b(DROP|MODIFY|CHANGE|RENAME)\b/i);assert.ok(!hit,`${m.name}: ${hit?.[0]} requires 'destructive'=>true`);
 }
});

test('0002 matches plan §2.3: conditional ALTERs, privacy defaults, floor on member rows',()=>{
 const m=parsed.find(x=>x.id===2).code;
 assert.match(m,/if\(!\$m->enumHas\('users','role','member'\)\)\$m->exec\("ALTER TABLE users MODIFY role/);
 assert.match(m,/if\(!\$m->columnNullable\('users','club_id'\)\)\$m->exec\('ALTER TABLE users MODIFY club_id/);
 assert.match(m,/name_display ENUM\('full','initial'\) NOT NULL DEFAULT 'initial'/);
 for(const c of ['pw_reset_at BIGINT NULL','stripe_redact_pending TINYINT(1) NOT NULL DEFAULT 0','deleted_at BIGINT NULL','CREATE TABLE IF NOT EXISTS account_audit','CREATE TABLE IF NOT EXISTS job_runs','INSERT IGNORE INTO billing_accounts'])assert.ok(m.includes(c),c);
 assert.match(m,/'floor'=>fn\(PDO \$pdo\):bool=>\(bool\)\$pdo->query\("SELECT 1 FROM users WHERE role='member' LIMIT 1"\)->fetchColumn\(\)/);
});

test('0005 and 0006 are additive and need no floor: the staff index through addIndex, billing_customers filled from billing_accounts',()=>{
 const m5=parsed.find(x=>x.id===5),m6=parsed.find(x=>x.id===6);assert.ok(m5&&m6);
 for(const m of [m5,m6]){assert.equal(m.destructive,false,m.name);assert.ok(!/'floor'\s*=>/.test(m.code),`${m.name}: an index or a new table never needs a newer release, so no floor`);}
 assert.match(m5.code,/\$m->addIndex\('users','users_role','role'\)/);assert.equal((m5.code.match(/\$m->/g)||[]).length,1,'0005 only adds the index');
 assert.match(m6.code,/CREATE TABLE IF NOT EXISTS billing_customers \(/);assert.match(m6.code,/customer_id VARCHAR\(255\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY/);
 assert.match(m6.code,/INSERT IGNORE INTO billing_customers \(customer_id,user_id,livemode,created_at,redacted_at\)\s+SELECT stripe_customer_id,user_id,livemode,created_at,/);
 // The Repository query reads staff by the index: role IN (…), not role<>'member' (an ENUM index cannot serve <>).
 assert.match(readFileSync('backend/src/Repository.php','utf8'),/SELECT \* FROM users WHERE role IN \('admin','editor','club'\) ORDER BY email,id/);
});

test('PHP loads every migration with the declared shape and Migrator::target() is the highest id',{skip:!process.env.PHP_BIN},()=>{
 const code=`require 'backend/src/Migrator.php';$out=[];foreach(MatDraw\\Migrator::files('${dir}') as $id=>$f){$m=require $f;$out[]=[$id,$m['id'],$m['name'],$m['destructive'],is_callable($m['up']),!isset($m['floor'])||is_callable($m['floor'])];}echo json_encode(['list'=>$out,'target'=>MatDraw\\Migrator::target('${dir}'),'none'=>MatDraw\\Migrator::target('backend/no-such-dir')]);`;
 const r=spawnSync(process.env.PHP_BIN,['-r',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);const out=JSON.parse(r.stdout);
 assert.equal(out.list.length,files.length);for(const [id,declared,name,destructive,up,floor] of out.list){assert.equal(declared,id);assert.equal(typeof name,'string');assert.equal(typeof destructive,'boolean');assert.ok(up&&floor,String(id));}
 assert.equal(out.target,Math.max(1,...parsed.map(m=>m.id)));assert.equal(out.none,1);
});

test('migrate.php prints database errors without the row values MySQL quotes in them (§10: no personal data in logs)',{skip:!process.env.PHP_BIN},()=>{
 const cases=[
  ["SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'jan.o'kowalski@example.pl' for key 'users.user_email'","SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry '…' for key 'users.user_email'"],
  ["SQLSTATE[HY000]: General error: 1366 Incorrect string value: '\\xF0\\x9F\\x98 Zofia' for column 'first_name' at row 1","SQLSTATE[HY000]: General error: 1366 Incorrect string value: '…' for column 'first_name' at row 1"],
  ["SQLSTATE[22007]: Invalid datetime format: 1292 Truncated incorrect DOUBLE value: 'Marta Nowak'","SQLSTATE[22007]: Invalid datetime format: 1292 Truncated incorrect DOUBLE value: '…'"],
  // MariaDB names the column with backticks; ER_WRONG_VALUE_FOR_TYPE ends with "for function <name>".
  ["SQLSTATE[22007]: Invalid datetime format: 1292 Incorrect date value: 'Ewa' for column `matdraw`.`users`.`birth` at row 2","SQLSTATE[22007]: Invalid datetime format: 1292 Incorrect date value: '…' for column `matdraw`.`users`.`birth` at row 2"],
  ["SQLSTATE[HY000]: General error: 1411 Incorrect datetime value: 'Jan Kowalski' for function str_to_date","SQLSTATE[HY000]: General error: 1411 Incorrect datetime value: '…' for function str_to_date"],
  // A format without a known suffix loses everything from the quote on instead of printing the value.
  ["SQLSTATE[HY000]: General error: 1525 Incorrect DATE value: 'Jan Kowalski' in an unknown place, 'x'","SQLSTATE[HY000]: General error: 1525 Incorrect DATE value: '…'"],
  ["SQLSTATE[HY000]: General error: 1300 Invalid utf8mb4 character string: 'Zofia\xF0'","SQLSTATE[HY000]: General error: 1300 Invalid utf8mb4 character string: '…'"],
  ["SQLSTATE[HY000]: General error: 3854 Cannot convert string 'Zofia\xF0' from binary to utf8mb4","SQLSTATE[HY000]: General error: 3854 Cannot convert string '…'"],
  ["SQLSTATE[42S01]: Base table or view already exists: 1050 Table 'chat_mutes' already exists","SQLSTATE[42S01]: Base table or view already exists: 1050 Table 'chat_mutes' already exists"],
 ];
 const code="require 'backend/src/Migrator.php';echo json_encode(array_map(fn($m)=>MatDraw\\Migrator::safeMessage(new PDOException($m)),json_decode(stream_get_contents(STDIN),true)),JSON_UNESCAPED_UNICODE);";
 const r=spawnSync(process.env.PHP_BIN,['-r',code],{input:JSON.stringify(cases.map(c=>c[0])),encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);
 assert.deepEqual(JSON.parse(r.stdout),cases.map(c=>c[1]));
 assert.match(readFileSync('backend/bin/migrate.php','utf8'),/Migrator::safeMessage\(\$e\)/,'migrate.php prints the safe message');
});

test('0007 matches PLAN-REJESTRACJA-ROLE §9.1: columns through addColumn (NULL or DEFAULT), the owner index, tombstones, staff_rev, a floor, no rows of existing tables',()=>{
 const m=parsed.find(x=>x.id===7);assert.ok(m,'0007_roles.php');assert.equal(m.name,'0007_roles.php');assert.equal(m.destructive,false);
 const columns=[['users','organizer','TINYINT(1) NOT NULL DEFAULT 0'],['users','organizer_blocked_at','BIGINT NULL'],['users','organizer_trusted_at','BIGINT NULL'],['users','organizer_trusted_by','VARCHAR(40) NULL'],
  ['profiles','owner_user_id','VARCHAR(40) NULL'],['profiles','rev','BIGINT NOT NULL DEFAULT 0'],['clubs','verified','TINYINT(1) NOT NULL DEFAULT 1'],['clubs','created_by','VARCHAR(40) NULL'],['clubs','created_at','BIGINT NULL'],['clubs','merged_into','VARCHAR(40) NULL'],
  ['tournaments','created_at','BIGINT NULL'],['tournaments','hidden_by','VARCHAR(40) NULL'],['tournaments','hidden_from','VARCHAR(10) CHARACTER SET ascii NULL'],['tournaments','hide_reason','VARCHAR(200) NULL'],['tournaments','self_entry','TINYINT(1) NOT NULL DEFAULT 0'],['tournaments','rev','BIGINT NOT NULL DEFAULT 0'],
  ['app_meta','staff_rev','BIGINT NOT NULL DEFAULT 0']];
 for(const [t,c,d] of columns)assert.ok(m.code.includes(`$m->addColumn('${t}','${c}','${d}');`),`${t}.${c}`);
 assert.equal((m.code.match(/\$m->addColumn\(/g)||[]).length,columns.length,'no other column');
 for(const [,,d] of columns)assert.match(d,/ NULL$|DEFAULT /,'instant ADD COLUMN: NULL or a DEFAULT');
 assert.match(m.code,/\$m->addIndex\('profiles','profiles_owner','owner_user_id'\);/,'non-unique owner index (R7)');
 assert.match(m.code,/\$m->exec\('UPDATE app_meta SET staff_rev=revision WHERE id=1 AND staff_rev=0'\);/);
 assert.match(m.code,/CREATE TABLE IF NOT EXISTS entry_withdrawals \(\s*profile_id VARCHAR\(40\) NOT NULL,\s*tournament_id VARCHAR\(40\) NOT NULL,\s*by_kind VARCHAR\(12\) CHARACTER SET ascii NOT NULL,\s*created_at BIGINT NOT NULL,\s*PRIMARY KEY \(profile_id, tournament_id\),\s*KEY entry_withdrawals_tournament \(tournament_id\)\s*\)/);
 assert.ok(!/FOREIGN\s+KEY/i.test(m.code),'no new foreign keys (rule of 0002)');
 assert.ok(!/\b(INSERT|DELETE|REPLACE)\b/i.test(m.code)&&(m.code.match(/\bUPDATE\b/gi)||[]).length===1,'rows of existing tables stay as they are (the unaffiliated club comes from Clubs::ensure)');
 for(const part of ['FROM profiles WHERE owner_user_id IS NOT NULL',"FROM profiles p JOIN users u ON u.id=p.created_by WHERE u.role='member'","FROM tournaments t JOIN users u ON u.id=t.created_by WHERE u.role='member'",'FROM tournaments WHERE hidden_by IS NOT NULL',"FROM clubs c JOIN users u ON u.id=c.created_by WHERE u.role='member'",'FROM clubs WHERE merged_into IS NOT NULL'])
  assert.ok(m.code.includes(part),'floor: '+part);
 assert.match(m.code,/'floor'=>fn\(PDO \$pdo\):bool=>/);
});
