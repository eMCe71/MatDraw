<?php
// Test-only fixture jobs of the accounts-profiles-backend slice (loaded by tests/helpers/fixture.php; CLI, test database only).
//   accounts-config {set:{key:value}}     rewrites MATDRAW_CONFIG atomically (allow-listed keys; null removes a key); returns the old values
//   accounts-state {userId}               users row (password hash only as a fingerprint), profile, billing row and audit actions
//   accounts-cleanup {config?,now?}       runs the accounts-cleanup job once with config overrides; returns its result
//   accounts-chat {userId,kind}           a chat message ('message') or a report filed by the user ('report'); creates the
//                                         chat tables with the DDL of plan §2.4 when migration 0003 is not installed
//   accounts-avatar-files {publicId}      files of a person's avatar directory with their modes (and the directory mode)
//   accounts-avatar-age {publicId,days,keep?}  sets the mtime of the directory and its files (except keep) $days back
//   accounts-avatar-orphan {publicId}     an avatar directory with one file for a public_id without a profile, two days old
declare(strict_types=1);
use MatDraw\{Avatars,Jobs};
const FIXTURE_ACCOUNTS_CONFIG_KEYS=['signup_enabled','signup_invite_token','signup_free_beta','billing_enforce','avatars_enabled','signup_limit_ip_hour','signup_limit_ip_day','signup_limit_global_hour','username_check_limit_session','username_check_limit_ip','abandoned_member_days'];
function fixture_accounts_one(PDO $pdo,string $sql,array $p):?array{$q=$pdo->prepare($sql);$q->execute($p);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();return $r?:null;}
function fixture_accounts_dir(array $c,string $pid):string{$d=Avatars::dir($c,$pid);if($d===null)throw new RuntimeException('avatar: invalid public id');return $d;}
return [
 'accounts-config'=>function(PDO $pdo,array $p):array{
  $path=getenv('MATDRAW_CONFIG');if(!$path||!is_file($path))throw new RuntimeException('accounts-config: MATDRAW_CONFIG');
  $c=require $path;$old=[];
  foreach((array)($p['set']??[]) as $k=>$v){if(!in_array($k,FIXTURE_ACCOUNTS_CONFIG_KEYS,true))throw new RuntimeException("accounts-config: key $k not allowed");$old[$k]=$c[$k]??null;if($v===null)unset($c[$k]);else $c[$k]=$v;}
  $tmp=$path.'.tmp.'.getmypid();file_put_contents($tmp,"<?php\nreturn ".var_export($c,true).";\n");chmod($tmp,0600);rename($tmp,$path);
  return $old;
 },
 'accounts-state'=>function(PDO $pdo,array $p):array{
  $id=(string)($p['userId']??'');$u=fixture_accounts_one($pdo,'SELECT id,club_id,email,role,active,password_hash,auth_version FROM users WHERE id=?',[$id]);
  if($u){$u['password_hash']=substr(hash('sha256',$u['password_hash']),0,16);$u['active']=(int)$u['active'];$u['auth_version']=(int)$u['auth_version'];}
  $q=$pdo->prepare('SELECT actor_id,action,note FROM account_audit WHERE target_user_id=? ORDER BY id');$q->execute([$id]);
  return ['user'=>$u,'profile'=>fixture_accounts_one($pdo,'SELECT * FROM user_profiles WHERE user_id=?',[$id]),'billing'=>fixture_accounts_one($pdo,'SELECT * FROM billing_accounts WHERE user_id=?',[$id]),'audit'=>$q->fetchAll(PDO::FETCH_ASSOC)];
 },
 'accounts-cleanup'=>function(PDO $pdo,array $p,array $c):string{
  $job=Jobs::all()['accounts-cleanup']??null;if(!$job)throw new RuntimeException('accounts-cleanup: job missing');
  return ($job['run'])($pdo,array_replace($c,(array)($p['config']??[])),(int)($p['now']??time()));
 },
 'accounts-chat'=>function(PDO $pdo,array $p):array{
  $id=(string)($p['userId']??'');$kind=$p['kind']??'';if(!in_array($kind,['message','report'],true))throw new RuntimeException('accounts-chat: kind');
  $has=fn(string $t)=>(bool)$pdo->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='$t'")->fetchColumn();
  // Plan §2.4 DDL (only when chat-backend's migration has not created the tables in this test database).
  if(!$has('chat_channels'))$pdo->exec("CREATE TABLE chat_channels (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,kind ENUM('lobby','tournament') NOT NULL,slug VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,scope ENUM('world','pl') NULL,sort SMALLINT NOT NULL DEFAULT 0,tournament_id VARCHAR(40) NULL,public_key CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,rev BIGINT UNSIGNED NOT NULL DEFAULT 0,last_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,msg_count INT UNSIGNED NOT NULL DEFAULT 0,status ENUM('open','readonly','closed') NOT NULL DEFAULT 'open',created_at BIGINT NOT NULL,UNIQUE KEY chat_channels_slug (slug),UNIQUE KEY chat_channels_tournament (tournament_id),UNIQUE KEY chat_channels_key (public_key),CONSTRAINT fk_chat_channels_tournament FOREIGN KEY (tournament_id) REFERENCES tournaments(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  if(!$has('chat_messages'))$pdo->exec("CREATE TABLE chat_messages (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,channel_id INT UNSIGNED NOT NULL,rev BIGINT UNSIGNED NOT NULL,user_id VARCHAR(40) NOT NULL,client_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,body VARCHAR(1000) NOT NULL,cont TINYINT(1) NOT NULL DEFAULT 0,state ENUM('visible','deleted_author','deleted_mod','hidden_review') NOT NULL DEFAULT 'visible',report_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,created_ms BIGINT UNSIGNED NOT NULL,changed_ms BIGINT UNSIGNED NULL,UNIQUE KEY chat_messages_channel_rev (channel_id,rev),UNIQUE KEY chat_messages_idem (user_id,client_id),KEY chat_messages_channel_id (channel_id,id),KEY chat_messages_user_time (user_id,created_ms),KEY chat_messages_created (created_ms),CONSTRAINT fk_chat_messages_channel FOREIGN KEY (channel_id) REFERENCES chat_channels(id),CONSTRAINT fk_chat_messages_user FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  if(!$has('chat_reports'))$pdo->exec("CREATE TABLE chat_reports (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,message_id BIGINT UNSIGNED NOT NULL,reporter_id VARCHAR(40) NOT NULL,reason ENUM('spam','abuse','harassment','child_data','other') NOT NULL,comment VARCHAR(300) NULL,status ENUM('open','dismissed','actioned') NOT NULL DEFAULT 'open',created_at BIGINT NOT NULL,resolved_by VARCHAR(40) NULL,resolved_at BIGINT NULL,UNIQUE KEY chat_reports_once (message_id,reporter_id),KEY chat_reports_status (status,created_at),KEY chat_reports_reporter (reporter_id),CONSTRAINT fk_chat_reports_message FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,CONSTRAINT fk_chat_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  $channel=$pdo->query('SELECT id FROM chat_channels ORDER BY id LIMIT 1')->fetchColumn();
  if(!$channel){$pdo->prepare("INSERT INTO chat_channels (kind,slug,scope,sort,public_key,created_at) VALUES ('lobby','fixture-accounts','world',99,?,?)")->execute([substr(bin2hex(random_bytes(8)),0,16),time()]);$channel=$pdo->lastInsertId();}
  $author=$kind==='message'?$id:$pdo->query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")->fetchColumn();
  $rev=random_int(1_000_000_000,2_000_000_000);$ms=(int)(microtime(true)*1000);
  $pdo->prepare("INSERT INTO chat_messages (channel_id,rev,user_id,client_id,body,cont,state,created_ms) VALUES (?,?,?,?,?,0,'visible',?)")->execute([$channel,$rev,$author,substr(bin2hex(random_bytes(11)),0,22),'fixture',$ms]);
  $message=(int)$pdo->lastInsertId();
  if($kind==='report')$pdo->prepare("INSERT INTO chat_reports (message_id,reporter_id,reason,status,created_at) VALUES (?,?,'spam','open',?)")->execute([$message,$id,time()]);
  return ['messageId'=>$message];
 },
 'accounts-avatar-files'=>function(PDO $pdo,array $p,array $c):array{
  $dir=fixture_accounts_dir($c,(string)($p['publicId']??''));if(!is_dir($dir))return ['dir'=>null,'files'=>new stdClass()];clearstatcache();
  $files=[];foreach(scandir($dir) as $f)if($f!=='.'&&$f!=='..')$files[$f]=sprintf('%04o',fileperms("$dir/$f")&0777);ksort($files);
  return ['dir'=>sprintf('%04o',fileperms($dir)&0777),'parent'=>sprintf('%04o',fileperms(dirname($dir))&0777),'files'=>(object)$files,'path'=>$dir];
 },
 'accounts-avatar-age'=>function(PDO $pdo,array $p,array $c):array{
  $dir=fixture_accounts_dir($c,(string)($p['publicId']??''));$t=time()-(int)($p['days']??2)*86400;$keep=(string)($p['keep']??'');$out=[];
  foreach(scandir($dir) as $f)if($f!=='.'&&$f!=='..'&&($keep===''||!str_starts_with($f,$keep))){touch("$dir/$f",$t);$out[]=$f;}
  touch($dir,$t);return $out;
 },
 'accounts-avatar-orphan'=>function(PDO $pdo,array $p,array $c):string{
  $dir=fixture_accounts_dir($c,(string)($p['publicId']??''));Avatars::mkdir($dir);$f="$dir/".str_repeat('a',32).'-256.webp';
  file_put_contents($f,'x');$t=time()-2*86400;touch($f,$t);touch($dir,$t);return $dir;
 },
];
