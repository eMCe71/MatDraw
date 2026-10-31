<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Chat moderation (plan §5.6): reports by people with full access, automatic hiding after autoHide distinct reporters,
 * the Admin's report queue, actions and mutes, and the moderation log chat_mod_log. The moderator in v1 is the role admin.
 * Every action of the Admin and every automatic hiding is logged; a copy of a message text (original_body) is logged only
 * for a moderator's deletion, an automatic hiding, or an author's deletion of a reported message (§5.5), and is cleared
 * after modKeepDays by chat-retention.
 * Contracts for other slices (called through class_exists):
 *   mutedUntil(PDO,$userId): null (not muted) | true (muted without an end) | int (muted until, epoch seconds)   → me
 *   mutedIds(PDO,?array $ids): [userId => true | int] of the currently muted among $ids (null: everybody muted) → admin-members
 * They are the only readers of chat_mutes outside the chat.
 */
final class ChatModeration {
 public const REASONS=['spam','abuse','harassment','child_data','other'];
 public const DURATIONS=['1h'=>3600,'24h'=>86400,'7d'=>604800,'perm'=>null];
 public const TEXT_MAX=300,PAGE=20,MUTED_MAX=200;

 /** A moderation log row (no foreign keys; the text copy is cut to the column size). */
 public static function log(PDO $pdo,string $actor,string $action,?int $messageId,?string $target,?string $note,?string $original,int $now):void {
  $pdo->prepare('INSERT INTO chat_mod_log (actor_id,action,message_id,target_user_id,note,original_body,created_at) VALUES (?,?,?,?,?,?,?)')
   ->execute([$actor,$action,$messageId,$target,$note===null?null:mb_substr($note,0,self::TEXT_MAX),$original===null?null:mb_substr($original,0,Chat::BODY_MAX),$now]);
 }
 /**
  * A free text of a report or an action (Text::clean; comment multi-line, note and reason one line), at most 300
  * characters; null when empty or absent. 400 for a value that is not text, 422 when too long.
  */
 public static function text(mixed $s,string $kind):?string {
  if($s===null)return null;if(!is_string($s))throw new AppError('Niepoprawny formularz.',400);
  $t=Text::clean($s,['multiline'=>$kind==='comment']);if($t===null||$t==='')return null;
  if(mb_strlen($t)>self::TEXT_MAX)throw match($kind){'comment'=>new AppError('Komentarz może mieć najwyżej 300 znaków.',422),'reason'=>new AppError('Powód może mieć najwyżej 300 znaków.',422),default=>new AppError('Notatka może mieć najwyżej 300 znaków.',422)};
  return $t;
 }

 // ——— Reports (§5.6) ———

 /**
  * chat-report {id, reason, comment?}: visibility first (one 404 for hidden and missing), then full access (402), not
  * one's own message (403); deleted messages cannot be reported (404). Repeating a report is idempotent. When open
  * reports of autoHide distinct people are reached, the message becomes hidden_review with a new rev (auto_hide logged
  * with the text). A message hidden for review is already waiting for the moderator and people see only its tombstone:
  * a report of it is accepted without a row (no report_count, nothing in the queue). The state is read again under the
  * channel lock, the lock every state change holds. Limit 20/h per person in the route.
  */
 public static function report(PDO $pdo,array $viewer,array $in,array $settings,?int $nowMs=null):array {
  $loc=Chat::locate($pdo,$in['id']??null,$viewer,$settings['data']['graceDays']);$m=$loc['message'];$id=(int)$m['id'];
  if(!$viewer['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
  if($m['user_id']===$viewer['id'])throw new AppError('Nie możesz zgłosić własnej wiadomości.',403);
  if(str_starts_with($m['state'],'deleted'))throw new AppError('Wiadomość nie istnieje.',404);
  $reason=$in['reason']??null;if(!is_string($reason)||!in_array($reason,self::REASONS,true))throw new AppError('Wybierz powód zgłoszenia.',422);
  $comment=self::text($in['comment']??null,'comment');
  $nowMs??=Chat::nowMs();$now=intdiv($nowMs,1000);$hidden=null;
  $pdo->beginTransaction();
  try{
   // The channel row first, as every chat writer: an automatic hiding below changes the channel's rev.
   $l=$pdo->prepare('SELECT rev FROM chat_channels WHERE id=? FOR UPDATE');$l->execute([(int)$m['channel_id']]);$l->fetchAll();
   $s=$pdo->prepare('SELECT state FROM chat_messages WHERE id=?');$s->execute([$id]);$state=(string)$s->fetchColumn();$s->closeCursor();
   if($state===''||str_starts_with($state,'deleted'))throw new AppError('Wiadomość nie istnieje.',404);
   $added=false;
   if($state==='visible'){$ins=$pdo->prepare("INSERT IGNORE INTO chat_reports (message_id,reporter_id,reason,comment,status,created_at) VALUES (?,?,?,?,'open',?)");$ins->execute([$id,$viewer['id'],$reason,$comment,$now]);$added=$ins->rowCount()===1;}
   if($added){
    $pdo->prepare('UPDATE chat_messages SET report_count=LEAST(report_count+1,65535) WHERE id=?')->execute([$id]);
    $q=$pdo->prepare("SELECT COUNT(*) FROM chat_reports WHERE message_id=? AND status='open'");$q->execute([$id]);$open=(int)$q->fetchColumn();$q->closeCursor();
    if($open>=$settings['data']['autoHide'])$hidden=Chat::setState($pdo,$id,'hidden_review',$nowMs,fn($x)=>$x['state']==='visible',
     fn(array $x)=>self::log($pdo,'system','auto_hide',$id,$x['user_id'],'reports='.$open,$x['body'],$now));
   }
   $pdo->commit();
  }catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
  if($hidden)ChatBus::published((int)$m['channel_id'],$hidden['rev']);
  return ['ok'=>true];
 }

 // ——— Mutes ———

 /** Mute of one person now: null (none or expired), true (without an end) or the end in epoch seconds. */
 public static function mutedUntil(PDO $pdo,string $userId,?int $now=null):int|bool|null {
  $now??=time();$q=$pdo->prepare('SELECT until_at FROM chat_mutes WHERE user_id=?');$q->execute([$userId]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(!$r)return null;if($r['until_at']===null)return true;
  return (int)$r['until_at']>$now?(int)$r['until_at']:null;
 }
 /** The currently muted among $ids (null: everybody currently muted): [userId => true (without an end) | int (until)]. */
 public static function mutedIds(PDO $pdo,?array $ids=null,?int $now=null):array {
  $now??=time();$out=[];
  if($ids!==null){$ids=array_values(array_unique(array_filter($ids,fn($v)=>is_string($v)&&$v!=='')));if(!$ids)return [];}
  foreach($ids===null?[null]:array_chunk($ids,500) as $chunk){
   $q=$pdo->prepare('SELECT user_id,until_at FROM chat_mutes WHERE (until_at IS NULL OR until_at>?)'.($chunk===null?'':' AND user_id IN ('.implode(',',array_fill(0,count($chunk),'?')).')'));
   $q->execute([$now,...($chunk??[])]);
   foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$out[(string)$r['user_id']]=$r['until_at']===null?true:(int)$r['until_at'];
  }
  return $out;
 }

 // ——— Admin (§5.6) ———

 /** Accounts for the Admin panel: id => {id, email, role, active, publicId, username, name, country}. */
 private static function people(PDO $pdo,array $ids):array {
  $ids=array_values(array_unique(array_filter($ids,fn($v)=>is_string($v)&&$v!=='')));if(!$ids)return [];$out=[];
  $q=$pdo->prepare('SELECT u.id,u.email,u.role,u.active,p.public_id,p.username,p.first_name,p.last_name,p.country FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id IN ('.implode(',',array_fill(0,count($ids),'?')).')');$q->execute($ids);
  foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$out[$r['id']]=['id'=>$r['id'],'email'=>$r['email'],'role'=>$r['role'],'active'=>(bool)$r['active'],'publicId'=>$r['public_id'],'username'=>$r['username'],
   'name'=>trim(($r['first_name']??'').' '.($r['last_name']??''))?:null,'country'=>$r['country']];
  return $out;
 }
 /** Latest logged copy of the text per message id (for deleted messages). */
 private static function originals(PDO $pdo,array $ids):array {
  if(!$ids)return [];$out=[];
  $q=$pdo->prepare('SELECT message_id,original_body FROM chat_mod_log WHERE original_body IS NOT NULL AND message_id IN ('.implode(',',array_fill(0,count($ids),'?')).') ORDER BY id DESC');$q->execute($ids);
  foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$out[(int)$r['message_id']]??=$r['original_body'];
  return $out;
 }
 private static function mute(true|int|null $m):?array{return $m===null?null:['until'=>$m===true?null:$m];}
 /**
  * admin-chat-reports (GET, admin). ?status=open|dismissed|actioned|all&page=N: reports grouped by message, newest report
  * first, 20 per page: {total, page, items:[{message:{id, channelId, channel, state, body, original, createdMs,
  * reportCount}, author, muted, reports:{count, reasons:{reason:n}, items:[{reason, comment, status, createdAt,
  * reporter:{id, username}}], lastAt}}]}. ?context=<message id>: two messages before and after it in its channel.
  * ?view=muted: the people muted now. Texts, comments, e-mails and names are shown by the panel as plain text only.
  */
 public static function adminReports(PDO $pdo,array $get,int $now):array {
  $bad=fn()=>throw new AppError('Niepoprawne zapytanie czatu.',400);
  $arg=function(string $k)use($get,$bad):?string{if(!array_key_exists($k,$get))return null;return is_string($get[$k])?$get[$k]:$bad();};
  if(($ctx=$arg('context'))!==null){if(!preg_match('/^\d{1,18}$/D',$ctx))$bad();return self::context($pdo,(int)$ctx);}
  if(($view=$arg('view'))!==null){if($view!=='muted')$bad();return self::muted($pdo,$now);}
  $status=$arg('status')??'open';if(!in_array($status,['open','dismissed','actioned','all'],true))$bad();
  $page=$arg('page')??'1';if(!preg_match('/^\d{1,5}$/D',$page)||(int)$page<1)$bad();$page=(int)$page;
  $where=$status==='all'?'':' WHERE status=?';$params=$status==='all'?[]:[$status];
  $q=$pdo->prepare('SELECT COUNT(DISTINCT message_id) FROM chat_reports'.$where);$q->execute($params);$total=(int)$q->fetchColumn();$q->closeCursor();
  $q=$pdo->prepare('SELECT message_id,MAX(created_at) AS last_at FROM chat_reports'.$where.' GROUP BY message_id ORDER BY last_at DESC,message_id DESC LIMIT '.self::PAGE.' OFFSET '.(($page-1)*self::PAGE));
  $q->execute($params);$groups=$q->fetchAll(PDO::FETCH_ASSOC);
  $ids=array_map(fn($g)=>(int)$g['message_id'],$groups);if(!$ids)return ['total'=>$total,'page'=>$page,'items'=>[]];
  $in=implode(',',array_fill(0,count($ids),'?'));
  $q=$pdo->prepare("SELECT m.id,m.channel_id,m.user_id,m.body,m.state,m.report_count,m.created_ms,c.kind,c.slug,c.scope,c.tournament_id,c.status AS channel_status,t.name AS t_name,t.event_date FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id LEFT JOIN tournaments t ON t.id=c.tournament_id WHERE m.id IN ($in)");$q->execute($ids);
  $messages=[];foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$messages[(int)$r['id']]=$r;
  $q=$pdo->prepare("SELECT r.message_id,r.reason,r.comment,r.status,r.created_at,r.reporter_id,p.username FROM chat_reports r LEFT JOIN user_profiles p ON p.user_id=r.reporter_id WHERE r.message_id IN ($in)".($status==='all'?'':' AND r.status=?').' ORDER BY r.created_at,r.id');
  $q->execute([...$ids,...$params]);$reports=[];foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$reports[(int)$r['message_id']][]=$r;
  $authors=self::people($pdo,array_column($messages,'user_id'));$muted=self::mutedIds($pdo,array_keys($authors),$now);$originals=self::originals($pdo,$ids);
  $items=[];
  foreach($groups as $g){
   $id=(int)$g['message_id'];$m=$messages[$id]??null;if(!$m)continue;$rs=$reports[$id]??[];$reasons=[];
   foreach($rs as $r)$reasons[$r['reason']]=($reasons[$r['reason']]??0)+1;
   $items[]=['message'=>['id'=>$id,'channelId'=>(int)$m['channel_id'],
     'channel'=>['kind'=>$m['kind'],'slug'=>$m['slug'],'scope'=>$m['scope'],'status'=>$m['channel_status'],'tournamentId'=>$m['tournament_id'],'title'=>$m['t_name'],'date'=>$m['event_date']],
     'state'=>$m['state'],'body'=>$m['body'],'original'=>$originals[$id]??null,'createdMs'=>(int)$m['created_ms'],'reportCount'=>(int)$m['report_count']],
    'author'=>$authors[$m['user_id']]??['id'=>$m['user_id']],'muted'=>self::mute($muted[$m['user_id']]??null),
    'reports'=>['count'=>count($rs),'reasons'=>(object)$reasons,'lastAt'=>(int)$g['last_at'],
     'items'=>array_map(fn($r)=>['reason'=>$r['reason'],'comment'=>$r['comment'],'status'=>$r['status'],'createdAt'=>(int)$r['created_at'],'reporter'=>['id'=>$r['reporter_id'],'username'=>$r['username']]],$rs)]];
  }
  return ['total'=>$total,'page'=>$page,'items'=>$items];
 }
 /** Two messages before and after message $id in its channel, with full texts for the Admin. */
 private static function context(PDO $pdo,int $id):array {
  $q=$pdo->prepare('SELECT channel_id FROM chat_messages WHERE id=?');$q->execute([$id]);$ch=$q->fetchColumn();$q->closeCursor();
  if($ch===false)throw new AppError('Wiadomość nie istnieje.',404);
  $cols='id,user_id,body,state,created_ms';
  $get=function(string $sql,array $p)use($pdo):array{$q=$pdo->prepare($sql);$q->execute($p);return $q->fetchAll(PDO::FETCH_ASSOC);};
  $rows=[...array_reverse($get("SELECT $cols FROM chat_messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT 2",[$ch,$id])),...$get("SELECT $cols FROM chat_messages WHERE channel_id=? AND id>=? ORDER BY id LIMIT 3",[$ch,$id])];
  $people=self::people($pdo,array_column($rows,'user_id'));$originals=self::originals($pdo,array_map(fn($r)=>(int)$r['id'],$rows));
  return ['messageId'=>$id,'channelId'=>(int)$ch,'items'=>array_map(fn($r)=>['id'=>(int)$r['id'],'state'=>$r['state'],'body'=>$r['body'],'original'=>$originals[(int)$r['id']]??null,'createdMs'=>(int)$r['created_ms'],
   'author'=>array_intersect_key($people[$r['user_id']]??['id'=>$r['user_id']],array_flip(['id','username','name','publicId','role']))],$rows)];
 }
 /** People muted now: {items:[{user, until (null = without an end), reason, createdAt, createdBy:{id, email}}]}. */
 private static function muted(PDO $pdo,int $now):array {
  $q=$pdo->prepare('SELECT user_id,until_at,reason,created_by,created_at FROM chat_mutes WHERE until_at IS NULL OR until_at>? ORDER BY created_at DESC,user_id LIMIT '.self::MUTED_MAX);$q->execute([$now]);$rows=$q->fetchAll(PDO::FETCH_ASSOC);
  $people=self::people($pdo,[...array_column($rows,'user_id'),...array_column($rows,'created_by')]);
  return ['items'=>array_map(fn($r)=>['user'=>$people[$r['user_id']]??['id'=>$r['user_id']],'until'=>$r['until_at']===null?null:(int)$r['until_at'],'reason'=>$r['reason'],'createdAt'=>(int)$r['created_at'],
   'createdBy'=>['id'=>$r['created_by'],'email'=>$people[$r['created_by']]['email']??null]],$rows)];
 }
 /**
  * admin-chat-action {action, …} (POST, admin), each logged in chat_mod_log:
  *   delete {messageId, note?}   deleted_mod with a tombstone, the text copied to the log, open reports actioned
  *   restore {messageId}         only hidden_review → visible (reports stay open)
  *   dismiss {messageId, note?}  open reports dismissed; a hidden_review message becomes visible again
  *   mute {userId, duration: 1h|24h|7d|perm, reason?}   upsert in chat_mutes (an Admin cannot be muted)
  *   unmute {userId}
  *   channel {channelId, status: open|readonly|closed}  the channel's rev moves, so pollers learn the new state
  * delete, restore and dismiss only need the message to exist (Chat::locate $panel): the queue lists reports of every
  * channel, also of a tournament set back to a draft, and the Admin must be able to settle them.
  */
 public static function adminAction(PDO $pdo,array $admin,array $in,array $settings,?int $nowMs=null):array {
  $nowMs??=Chat::nowMs();$now=intdiv($nowMs,1000);$action=$in['action']??null;
  $msg=function()use($pdo,$in,$admin,$settings):int{$id=$in['messageId']??null;Chat::locate($pdo,$id,$admin,$settings['data']['graceDays'],true);return $id;};
  $user=function()use($pdo,$in):array{$id=$in['userId']??null;if(!is_string($id)||$id===''||strlen($id)>40)throw new AppError('Niepoprawny formularz.',400);
   $q=$pdo->prepare('SELECT id,role FROM users WHERE id=?');$q->execute([$id]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();if(!$r)throw new AppError('Konto nie istnieje.',404);return $r;};
  switch($action){
   case 'delete':return Chat::delete($pdo,$admin,$in['messageId']??null,$in['note']??null,$settings['data']['graceDays'],true,$nowMs);
   case 'restore':
    $id=$msg();
    $done=Chat::setState($pdo,$id,'visible',$nowMs,fn($x)=>$x['state']==='hidden_review',fn(array $x)=>self::log($pdo,$admin['id'],'restore',$id,$x['user_id'],null,null,$now));
    if(!$done)throw new AppError('Tej wiadomości nie można przywrócić.',409);
    return ['ok'=>true];
   case 'dismiss':
    $id=$msg();$note=self::text($in['note']??null,'note');
    $pdo->beginTransaction();
    try{
     $restored=Chat::setState($pdo,$id,'visible',$nowMs,fn($x)=>$x['state']==='hidden_review');
     $u=$pdo->prepare("UPDATE chat_reports SET status='dismissed',resolved_by=?,resolved_at=? WHERE message_id=? AND status='open'");$u->execute([$admin['id'],$now,$id]);
     $a=$pdo->prepare('SELECT user_id FROM chat_messages WHERE id=?');$a->execute([$id]);$author=(string)$a->fetchColumn();$a->closeCursor();
     self::log($pdo,$admin['id'],'dismiss',$id,$author,trim('reports='.$u->rowCount().($restored?' restored':'').($note!==null?' · '.$note:'')),null,$now);
     $pdo->commit();
    }catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
    if($restored)ChatBus::published((int)$restored['message']['channel_id'],$restored['rev']);
    return ['ok'=>true];
   case 'mute':
    $u=$user();if($u['role']==='admin')throw new AppError('Nie można wyciszyć Administratora.',422);
    $duration=$in['duration']??null;if(!is_string($duration)||!array_key_exists($duration,self::DURATIONS))throw new AppError('Wybierz czas wyciszenia.',422);
    $reason=self::text($in['reason']??null,'reason');$until=self::DURATIONS[$duration]===null?null:$now+self::DURATIONS[$duration];
    $pdo->prepare('INSERT INTO chat_mutes (user_id,until_at,reason,created_by,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE until_at=VALUES(until_at),reason=VALUES(reason),created_by=VALUES(created_by),created_at=VALUES(created_at)')
     ->execute([$u['id'],$until,$reason,$admin['id'],$now]);
    self::log($pdo,$admin['id'],'mute',null,$u['id'],$duration.($reason!==null?' · '.$reason:''),null,$now);
    return ['ok'=>true,'until'=>$until];
   case 'unmute':
    $u=$user();$d=$pdo->prepare('DELETE FROM chat_mutes WHERE user_id=?');$d->execute([$u['id']]);
    self::log($pdo,$admin['id'],'unmute',null,$u['id'],null,null,$now);
    return ['ok'=>true];
   case 'channel':
    $id=$in['channelId']??null;$status=$in['status']??null;
    if(!is_int($id)||$id<1)throw new AppError('Niepoprawny formularz.',400);
    if(!is_string($status)||!in_array($status,['open','readonly','closed'],true))throw new AppError('Niepoprawny status kanału.',422);
    $pdo->beginTransaction();
    try{
     $q=$pdo->prepare('SELECT rev,status FROM chat_channels WHERE id=? FOR UPDATE');$q->execute([$id]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
     if(!$r)throw new AppError('Ten czat nie istnieje.',404);
     $rev=(int)$r['rev'];
     if($r['status']!==$status){$rev++;$pdo->prepare('UPDATE chat_channels SET status=?,rev=? WHERE id=?')->execute([$status,$rev,$id]);self::log($pdo,$admin['id'],'channel_status',null,null,'channel='.$id.' '.$r['status'].'>'.$status,null,$now);}
     $pdo->commit();
    }catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
    if($rev!==(int)$r['rev'])ChatBus::published($id,$rev);
    return ['ok'=>true];
  }
  throw new AppError('Nieznana operacja moderacji.',400);
 }
}
