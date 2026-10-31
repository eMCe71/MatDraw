<?php
// Test data for the HTTP tests, CLI only, against the database of MATDRAW_CONFIG (never a production config).
// Input on STDIN: {"job":"<name>","payload":{...}}; output: the job's result as JSON. Called by fixture() in
// tests/helpers/http-client.mjs. Base jobs are below; each slice adds its own jobs in tests/helpers/fixture-<slice>.php
// returning ['job-name'=>function(PDO $pdo,array $payload,array $config):mixed{...}] (a duplicate name is an error).
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__,2).'/backend/bootstrap.php';
use MatDraw\Domain;
const FIXTURE_BILLING_COLUMNS=['billing_exempt','exempt_reason','exempt_by','exempt_at','exempt_until','currency','livemode','stripe_customer_id','customer_seq','stripe_subscription_id','sub_status','price_lookup_key','current_period_start','current_period_end','cancel_at_period_end','cancel_at','canceled_at','ended_at','latest_invoice_status','pending_checkout_id','pending_checkout_expires','last_synced_at','next_sync_at','sync_claimed_at','sync_error','stripe_redact_pending','deleted_at','created_at','updated_at'];
function fixture_public_id():string{$a='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';$s='';for($i=0;$i<12;$i++)$s.=$a[random_int(0,61)];return $s;}
function fixture_billing(PDO $pdo,string $userId,array $fields):array {
 foreach(array_keys($fields) as $k)if(!in_array($k,FIXTURE_BILLING_COLUMNS,true))throw new RuntimeException("billing: unknown column $k");
 $now=time();$row=array_replace(['created_at'=>$now,'updated_at'=>$now],$fields);$cols=array_keys($row);
 $pdo->prepare('INSERT INTO billing_accounts (user_id,'.implode(',',$cols).') VALUES (?'.str_repeat(',?',count($cols)).') ON DUPLICATE KEY UPDATE '.implode(',',array_map(fn($c)=>"$c=VALUES($c)",array_diff($cols,['created_at']))))->execute([$userId,...array_values($row)]);
 $q=$pdo->prepare('SELECT * FROM billing_accounts WHERE user_id=?');$q->execute([$userId]);return $q->fetch();
}
$jobs=[
 // A community account (role member, no workspace club). profile: false (no row; created lazily later), true
 // (complete default profile) or an object with camelCase fields; exempt: true or a reason (free account).
 // The default username is unique and valid under §7.2 (<local part, 15 chars>_<6 random>); a test that needs a
 // specific name passes profile.username.
 'member'=>function(PDO $pdo,array $p):array{
  $email=mb_strtolower(trim((string)($p['email']??'')));if(!filter_var($email,FILTER_VALIDATE_EMAIL))throw new RuntimeException('member: email required');
  $id=Domain::id();$now=time();$publicId=null;
  $pdo->prepare("INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES (?,NULL,?,'member',?,?,1)")->execute([$id,$email,($p['active']??true)?1:0,Domain::password((string)($p['password']??'TestPassword2026!'))]);
  if(!empty($p['profile'])){
   $f=is_array($p['profile'])?$p['profile']:[];$publicId=fixture_public_id();
   $user=preg_replace('/[^a-z0-9]/','',strtolower(strstr($email,'@',true)));$user=substr(preg_match('/^[a-z]/',$user)?$user:'u'.$user,0,15).'_'.substr(strtolower(fixture_public_id()),0,6);
   $pdo->prepare('INSERT INTO user_profiles (user_id,public_id,username,first_name,last_name,country,sports,club_text,show_club,name_display,avatar,username_changed_at,created_at,updated_at,last_login_at,pw_reset_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    ->execute([$id,$publicId,array_key_exists('username',$f)?$f['username']:$user,$f['firstName']??'Test',$f['lastName']??'Członek',$f['country']??'PL',implode(',',$f['sports']??['taekwondo']),$f['clubText']??null,!empty($f['showClub'])?1:0,$f['nameDisplay']??'initial',$f['avatar']??null,$f['usernameChangedAt']??null,$f['createdAt']??$now,$now,$f['lastLoginAt']??null,$f['pwResetAt']??null]);
  }
  if(!empty($p['exempt']))fixture_billing($pdo,$id,['billing_exempt'=>1,'exempt_reason'=>is_string($p['exempt'])?$p['exempt']:'test','exempt_at'=>$now]);
  return ['id'=>$id,'publicId'=>$publicId,'email'=>$email];
 },
 // Billing state of one account: any billing_accounts columns (upsert).
 'billing'=>function(PDO $pdo,array $p):array{$id=(string)($p['userId']??'');if($id==='')throw new RuntimeException('billing: userId required');unset($p['userId']);return fixture_billing($pdo,$id,$p);},
 // A tournament created by the first administrator (or createdBy), without entries; bumps the workspace revision.
 'tournament'=>function(PDO $pdo,array $p):array{
  $by=$p['createdBy']??$pdo->query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")->fetchColumn();if(!$by)throw new RuntimeException('tournament: no administrator');
  $id=Domain::id();$status=$p['status']??'open';if(!in_array($status,['draft','open','closed','finished'],true))throw new RuntimeException('tournament: status');
  $pdo->prepare('INSERT INTO tournaments (id,created_by,name,city,event_date,mat,status,activity) VALUES (?,?,?,?,?,?,?,?)')->execute([$id,$by,(string)($p['name']??'Turniej testowy'),(string)($p['city']??'Warszawa'),Domain::date($p['date']??'2030-06-01'),(string)($p['mat']??'Mata 1'),$status,'[]']);
  $pdo->exec('UPDATE app_meta SET revision=revision+1 WHERE id=1');return ['id'=>$id];
 },
 // All tests come from 127.0.0.1: clear login and rate-limit buckets so one file cannot block the next.
 'reset-limits'=>fn(PDO $pdo):array=>['deleted'=>$pdo->exec('DELETE FROM login_limits')],
];
foreach(glob(__DIR__.'/fixture-*.php')?:[] as $file){$more=require $file;if(!is_array($more))throw new RuntimeException(basename($file).' must return an array of jobs');foreach($more as $name=>$fn){if(isset($jobs[$name]))throw new RuntimeException("Duplicate fixture job $name in ".basename($file));$jobs[$name]=$fn;}}
try{
 $in=json_decode(stream_get_contents(STDIN),true,32,JSON_THROW_ON_ERROR);$job=$in['job']??'';
 if(!isset($jobs[$job]))throw new RuntimeException("Unknown fixture job: $job");
 $config=matdraw_config();$out=$jobs[$job](matdraw_database($config),is_array($in['payload']??null)?$in['payload']:[],$config);
 echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES),"\n";
}catch(Throwable $e){fwrite(STDERR,get_class($e).': '.$e->getMessage()."\n");exit(1);}
