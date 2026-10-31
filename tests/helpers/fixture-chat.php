<?php
// Test-only fixture jobs of the chat-backend slice (loaded by tests/helpers/fixture.php; CLI, test database only).
//   chat-channel {slug | tournamentId}                 the channel row (a tournament channel is created when missing)
//   chat-messages {channelId, userId, n, body?, createdMs?, stepMs?, state?}   n messages written as chat-send would
//                                                      (next rev each, msg_count, last_message_id), without any limit
//   chat-message {id}                                  one chat_messages row
//   chat-settings {set?:{…}, reset?:true}             merges into the stored settings (send merged too), version + 1
//   chat-mute {userId, untilAt?: int|null, remove?}   writes or removes a mute / chat-mute-row {userId} reads it
//   chat-health {} / chat-health-add {hourAt,status,n} rows of chat_health / one row
//   chat-log {messageId? | targetUserId?}              chat_mod_log rows / chat-log-age {messageId, createdAt}
//   chat-reports {messageId}                           chat_reports rows / chat-report-age {messageId, resolvedAt}
//   chat-retention {}                                  runs the chat-retention job now (its result string)
//   chat-tombstone {userId}                            Chat::tombstoneUser (account deletion, §3.8)
//   chat-table {table, hide}                           renames chat_channels away and back (switch before the database)
declare(strict_types=1);
use MatDraw\{Chat,ChatSettings,Jobs};
/** One row of $sql or null. */
function fixture_chat_one(PDO $pdo,string $sql,array $params):?array{$q=$pdo->prepare($sql);$q->execute($params);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();return $r?:null;}
function fixture_chat_all(PDO $pdo,string $sql,array $params=[]):array{$q=$pdo->prepare($sql);$q->execute($params);return $q->fetchAll(PDO::FETCH_ASSOC);}
return [
 'chat-channel'=>function(PDO $pdo,array $p):array{
  if(isset($p['tournamentId']))return Chat::tournamentChannel($pdo,(string)$p['tournamentId'],time());
  return fixture_chat_one($pdo,'SELECT * FROM chat_channels WHERE slug=?',[(string)($p['slug']??'')])??throw new RuntimeException('chat-channel: no such slug');
 },
 'chat-messages'=>function(PDO $pdo,array $p):array{
  $ch=(int)($p['channelId']??0);$user=(string)($p['userId']??'');$n=max(1,(int)($p['n']??1));$state=(string)($p['state']??'visible');
  if(!in_array($state,['visible','deleted_author','deleted_mod','hidden_review'],true))throw new RuntimeException('chat-messages: state');
  $start=(int)($p['createdMs']??Chat::nowMs());$step=(int)($p['stepMs']??1);$out=[];
  $pdo->beginTransaction();
  try{
   $rev=(int)(fixture_chat_one($pdo,'SELECT rev FROM chat_channels WHERE id=? FOR UPDATE',[$ch])['rev']??throw new RuntimeException('chat-messages: channel'));
   $ins=$pdo->prepare('INSERT INTO chat_messages (channel_id,rev,user_id,client_id,body,cont,state,created_ms) VALUES (?,?,?,?,?,0,?,?)');$last=0;$visible=0;
   for($i=0;$i<$n;$i++){
    $body=str_replace('{i}',(string)($i+1),(string)($p['body']??'Wiadomość testowa {i}'));
    $ins->execute([$ch,++$rev,$user,substr(strtr(base64_encode(random_bytes(18)),'+/','-_'),0,22),str_starts_with($state,'deleted')?'':$body,$state,$start+$i*$step]);
    $last=(int)$pdo->lastInsertId();$visible+=$state==='visible'?1:0;$out[]=['id'=>$last,'rev'=>$rev];
   }
   $pdo->prepare('UPDATE chat_channels SET rev=?,last_message_id=?,msg_count=msg_count+? WHERE id=?')->execute([$rev,$last,$visible,$ch]);
   $pdo->commit();
  }catch(Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
  return ['messages'=>$out,'rev'=>$rev,'last'=>$last];
 },
 'chat-message'=>fn(PDO $pdo,array $p):?array=>fixture_chat_one($pdo,'SELECT * FROM chat_messages WHERE id=?',[(int)($p['id']??0)]),
 'chat-settings'=>function(PDO $pdo,array $p):array{
  $s=ChatSettings::get($pdo);$data=!empty($p['reset'])?ChatSettings::DEFAULTS:$s['data'];
  foreach((array)($p['set']??[]) as $k=>$v)$data[$k]=$k==='send'?array_replace($data['send'],(array)$v):$v;
  $pdo->prepare('UPDATE chat_settings SET version=version+1,data=?,updated_at=? WHERE id=1')->execute([json_encode($data,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE),time()]);
  return ChatSettings::get($pdo);
 },
 'chat-mute'=>function(PDO $pdo,array $p):bool{
  $id=(string)($p['userId']??'');if(!empty($p['remove'])){$pdo->prepare('DELETE FROM chat_mutes WHERE user_id=?')->execute([$id]);return true;}
  $by=$pdo->query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")->fetchColumn();
  $pdo->prepare('INSERT INTO chat_mutes (user_id,until_at,reason,created_by,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE until_at=VALUES(until_at),reason=VALUES(reason)')->execute([$id,$p['untilAt']??null,$p['reason']??null,$by,time()]);
  return true;
 },
 'chat-mute-row'=>fn(PDO $pdo,array $p):?array=>fixture_chat_one($pdo,'SELECT * FROM chat_mutes WHERE user_id=?',[(string)($p['userId']??'')]),
 'chat-health'=>fn(PDO $pdo):array=>fixture_chat_all($pdo,'SELECT hour_at,status,n FROM chat_health ORDER BY hour_at,status'),
 'chat-health-add'=>function(PDO $pdo,array $p):bool{$pdo->prepare('INSERT INTO chat_health (hour_at,status,n) VALUES (?,?,?) ON DUPLICATE KEY UPDATE n=VALUES(n)')->execute([(int)$p['hourAt'],(int)$p['status'],(int)$p['n']]);return true;},
 'chat-log'=>function(PDO $pdo,array $p):array{
  if(isset($p['messageId']))return fixture_chat_all($pdo,'SELECT * FROM chat_mod_log WHERE message_id=? ORDER BY id',[(int)$p['messageId']]);
  return fixture_chat_all($pdo,'SELECT * FROM chat_mod_log WHERE target_user_id=? ORDER BY id',[(string)($p['targetUserId']??'')]);
 },
 'chat-log-age'=>function(PDO $pdo,array $p):int{$q=$pdo->prepare('UPDATE chat_mod_log SET created_at=? WHERE message_id=?');$q->execute([(int)$p['createdAt'],(int)$p['messageId']]);return $q->rowCount();},
 'chat-reports'=>fn(PDO $pdo,array $p):array=>fixture_chat_all($pdo,'SELECT * FROM chat_reports WHERE message_id=? ORDER BY id',[(int)($p['messageId']??0)]),
 'chat-report-age'=>function(PDO $pdo,array $p):int{$q=$pdo->prepare("UPDATE chat_reports SET status=IF(status='open','dismissed',status),resolved_at=? WHERE message_id=?");$q->execute([(int)$p['resolvedAt'],(int)$p['messageId']]);return $q->rowCount();},
 'chat-retention'=>fn(PDO $pdo,array $p,array $c):string=>(Jobs::all()['chat-retention']['run'])($pdo,$c,time()),
 'chat-tombstone'=>fn(PDO $pdo,array $p):int=>Chat::tombstoneUser($pdo,(string)($p['userId']??'')),
 'chat-table'=>function(PDO $pdo,array $p):bool{
  if(($p['table']??'')!=='chat_channels')throw new RuntimeException('chat-table');
  $hidden=(bool)$pdo->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_channels__hidden'")->fetchColumn();
  if(!empty($p['hide'])&&!$hidden)$pdo->exec('RENAME TABLE chat_channels TO chat_channels__hidden');
  if(empty($p['hide'])&&$hidden)$pdo->exec('RENAME TABLE chat_channels__hidden TO chat_channels');
  return true;
 },
];
