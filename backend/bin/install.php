<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
require_once dirname(__DIR__).'/src/Migrator.php';
use MatDraw\{Domain,Migrator,Repository};
$opts=getopt('',['email:','club:','password-stdin']);
try {
 $email=mb_strtolower(trim($opts['email']??''));$club=Domain::txt($opts['club']??null,'nazwa klubu');
 if(!filter_var($email,FILTER_VALIDATE_EMAIL))throw new RuntimeException('Use --email=admin@example.com --club="Club name".');
 if(!isset($opts['password-stdin']))throw new RuntimeException('Pipe an admin password with --password-stdin. Never pass it as a command argument.');
 $password=rtrim((string)fgets(STDIN),"\r\n");$hash=Domain::password($password);unset($password);
 // Frozen baseline (version 1), then every migration, then the first administrator (Repository needs the final schema).
 $pdo=matdraw_database(matdraw_config());$pdo->exec(file_get_contents(dirname(__DIR__).'/database/schema.sql'));
 (new Migrator($pdo,dirname(__DIR__).'/migrations'))->run(fn(string $line)=>fwrite(STDOUT,$line."\n"));
 // Any account (also a member, which the workspace does not load) means the database is already in use.
 (new Repository($pdo))->transaction(function(array &$db)use($pdo,$email,$club,$hash){if((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn())throw new RuntimeException('Already initialized. No changes to existing accounts.');$c=['id'=>Domain::id(),'name'=>$club];$db['clubs'][]=$c;$db['users'][]=['id'=>Domain::id(),'clubId'=>$c['id'],'email'=>$email,'role'=>'admin','active'=>true,'passwordHash'=>$hash,'authVersion'=>1];$db['revision']++;});
 fwrite(STDOUT,"MatDraw installed. Log in using your administrator account.\n");
}catch(Throwable $e){fwrite(STDERR,$e->getMessage()."\n");exit(1);}
