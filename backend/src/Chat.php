<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Chat channels, polling, sending and deleting (plan §5.1–5.5, §2.4). Never touches Repository::transaction/snapshot or
 * app_meta (D5): every write is one short transaction serialized only by the channel row (SELECT … FOR UPDATE), taken
 * before anything else; the only other rows it locks are the message rows it then changes and, when sending, the
 * sender's users row (after the channel row, the order account deletion uses too), so the send limits hold for parallel
 * sessions of one account. Writers of one channel queue on that row, writers of different channels never meet. Times are computed in PHP (milliseconds in created_ms and
 * changed_ms, seconds elsewhere), never by the database.
 *
 * Visibility (§5.2), one rule for reading and writing (visibleFor): a global channel is visible to everyone; a tournament
 * channel is hidden for everyone while the tournament is a draft (404), open to everyone from the moment it is not a
 * draft until its date (event_date ≥ today, the window of GuestView), open to signed-in people only on the grace day(s)
 * after it (settings graceDays, default 1), and an archive (read only) for signed-in people only after that. The Admin's
 * channel status readonly or closed makes it read only ('closed'); closed also hides a tournament channel from guests.
 * Everything a person may not see answers like something that does not exist (st 'gone' in a poll, one 404 message for
 * writes), so hidden channels cannot be probed.
 *
 * Polling (§5.4): ch=<id>:<rev>,… (≤ 6 channels on screen; rev 0 = the last 50 messages, with before=<message id> the 30
 * before it), h=<id>:<lastReadId>:<knownLast>,… (≤ 30 background channels, unread counters only), cv=<settings version>,
 * e=<n>:<status> (hosting answers seen by the client since its last success), a=1 (chat-feed only: someone is reading,
 * so a staff session's activity is refreshed too, active()). One SELECT reads every channel of ch and h,
 * one the tournaments behind them, one the settings; nothing changed → 204 (also with h). Changes come by rev (LIMIT 101:
 * more=true after 100, the client reloads); unread counts are computed only for channels whose last_message_id differs
 * from knownLast. Answer {cv, cfg (only when cv is stale), ch:{id:{rev, st, more, older?, m}}, heads:{id:{last, n}},
 * people (full access only)}; a gone channel is {st:'gone'}; a channel that did not change is left out unless it was
 * loaded from 0. A history page (before=) carries no rev and no more: it never moves the client's cursor.
 * Member message {id, r, t, a?, o?, c, b} / tombstone {id, r, t, a?, o?, x}: a = public_id of the author (absent for a
 * deleted account), o = 1 for the organiser of the tournament (tournaments.created_by). Guests and signed-in people
 * without full access get ChatGuestView (no people at all).
 */
final class Chat {
 /** Global channels (requirement 1, §5.1): fixed order; names and descriptions are interface texts (dictionaries). */
 public const LOBBY=[
  'taekwondo'=>['scope'=>'world','sort'=>10,'name'=>'Taekwondo','about'=>'Dowolny język — najlepiej angielski'],
  'taekwondo-pl'=>['scope'=>'pl','sort'=>20,'name'=>'Taekwondo','about'=>'Rozmowy po polsku'],
  'karate'=>['scope'=>'world','sort'=>30,'name'=>'Karate','about'=>'Dowolny język — najlepiej angielski'],
  'general'=>['scope'=>'world','sort'=>40,'name'=>'Ogólny','about'=>'Wszystko o sztukach walki i MatBravo'],
 ];
 public const SCOPES=['world'=>'Świat','pl'=>'Polska'];
 public const MAX_CH=6,MAX_H=30,PAGE=50,HISTORY=30,BATCH=100,UNREAD_CAP=100,ARCHIVE=50,UPCOMING=100,BODY_MAX=1000,CONT_MS=300000;
 private const MSG='id,rev,user_id,body,cont,state,created_ms';
 private const CHANNEL='id,kind,slug,scope,tournament_id,rev,last_message_id,msg_count,status';
 private const T_STATUSES="'open','closed','finished'";

 public static function nowMs():int{return (int)floor(microtime(true)*1000);}
 /** Today in Europe/Warsaw (matdraw_config sets the time zone), as GuestView. */
 public static function today():string{return date('Y-m-d');}
 public static function shiftDate(string $day,int $days):string{return (new \DateTimeImmutable($day.' 12:00:00'))->modify(($days<0?'':'+').$days.' days')->format('Y-m-d');}
 /** 16 random base62 characters (uniform). */
 public static function publicKey():string {
  $a='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';$s='';
  while(strlen($s)<16)foreach(str_split(random_bytes(24)) as $b){$n=ord($b);if($n<248&&strlen($s)<16)$s.=$a[$n%62];}
  return $s;
 }
 private static function marks(array $ids):string{return implode(',',array_fill(0,count($ids),'?'));}

 // ——— Visibility (§5.2) ———

 /**
  * State of a tournament's chat for a viewer (null = guest), without the Admin's channel status: hidden (no tournament
  * or a draft: nobody, 404), open (event_date ≥ today for everyone; the grace days after it for signed-in people),
  * archive (later, signed-in people only) or gone (exists, but not for this viewer: a guest after the tournament day).
  */
 public static function tournamentState(?array $t,string $today,?array $viewer,int $graceDays=1):string {
  if(!$t||!in_array($t['status']??null,['open','closed','finished'],true))return 'hidden';
  $date=(string)($t['event_date']??'');
  if($date>=$today)return 'open';
  if($viewer===null)return 'gone';
  return $date>=self::shiftDate($today,-max(0,$graceDays))?'open':'archive';
 }
 /**
  * Effective state of channel $ch (kind, status) for a viewer: open, archive or closed (read only), or null when this
  * viewer may not see it. The same function decides reading (st 'gone') and writing (404) (§5.5 point 7, §10).
  */
 public static function visibleFor(array $ch,?array $t,?array $viewer,string $today,int $graceDays=1):?string {
  $status=$ch['status']??'open';$readOnly=$status!=='open';
  if(($ch['kind']??'')==='lobby')return $readOnly?'closed':'open';
  $s=self::tournamentState($t,$today,$viewer,$graceDays);
  if($s==='hidden'||$s==='gone'||$viewer===null&&$status==='closed')return null;
  return $readOnly?'closed':$s;
 }

 // ——— Viewer ———

 /**
  * The account of a chat request with what the chat needs, in one query by primary key: users ⋈ billing_accounts (access,
  * §6.5) and, with $posting, ⋈ user_profiles ⋈ chat_mutes (§5.5 points 3–6). Null for an unknown or blocked account.
  * {id, role, authVersion, full, access, profile (row or null), pwReset, muted: null | true (no end) | int (until)}.
  */
 public static function viewer(PDO $pdo,string $userId,array $c,int $now,bool $posting=false):?array {
  $q=$pdo->prepare('SELECT u.id,u.club_id,u.email,u.role,u.active,u.password_hash,u.auth_version,b.user_id AS b_user,b.billing_exempt,b.exempt_until,b.livemode,b.sub_status,b.current_period_start,b.current_period_end,b.cancel_at_period_end'
   .($posting?',p.user_id AS p_user,p.public_id,p.first_name,p.last_name,p.username,p.country,p.sports,p.pw_reset_at,m.user_id AS m_user,m.until_at':'')
   .' FROM users u LEFT JOIN billing_accounts b ON b.user_id=u.id'.($posting?' LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN chat_mutes m ON m.user_id=u.id':'').' WHERE u.id=?');
  $q->execute([$userId]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(!$r||!(int)$r['active'])return null;
  $u=Accounts::fromRow($r);
  $row=$r['b_user']===null?null:array_intersect_key($r,array_flip(['billing_exempt','exempt_until','livemode','sub_status','current_period_start','current_period_end','cancel_at_period_end']));
  $access=Access::compute($row,$u,$c,$now);
  $v=['id'=>$u['id'],'role'=>$u['role'],'authVersion'=>$u['authVersion'],'full'=>$access['full'],'access'=>$access];
  if($posting){
   $v['profile']=$r['p_user']===null?null:array_intersect_key($r,array_flip(['public_id','first_name','last_name','username','country','sports']));
   $v['pwReset']=$r['p_user']!==null&&$r['pw_reset_at']!==null;
   $v['muted']=$r['m_user']===null?null:($r['until_at']===null?true:((int)$r['until_at']>$now?(int)$r['until_at']:null));
  }
  return $v;
 }
 /**
  * Viewer of a peek route (chat-feed): Auth::peek, then one query; null for no, stale or blocked session. The database
  * opens only when the cookie names a live session (a guest's poll costs no connection here). $active (active()) lets
  * the poll refresh a staff session's activity too.
  */
 public static function peekViewer(array $c,\Closure $pdo,int $now,bool $active=false):?array {
  $s=Auth::peek($c,$active);if(!$s||!is_string($s['userId']))return null;
  $v=self::viewer($pdo(),$s['userId'],$c,$now);
  return $v&&$v['authVersion']===$s['authVersion']?$v:null;
 }

 /**
  * A poll by someone reading the chat (plan §3.5 step 6): a=1, which the client may add only while a chat is on screen
  * and the person's own last interaction is within the last idle level (cfg.idle[3]), on a poll that carries ch= (a
  * channel on screen). Background head polls (h= only) never count, whatever they carry, so they cannot keep an
  * unattended staff tab signed in.
  */
 public static function active(array $get,array $q):bool{return ($get['a']??null)==='1'&&$q['ch']!==[];}

 // ——— Reading (§5.4) ———

 /** Strict parser of the polling query (§5.4); anything else → 400 'Niepoprawne zapytanie czatu.'. */
 public static function parseQuery(array $get):array {
  $bad=fn()=>throw new AppError('Niepoprawne zapytanie czatu.',400);
  $str=function(string $k)use($get,$bad):?string{if(!array_key_exists($k,$get))return null;return is_string($get[$k])?$get[$k]:$bad();};
  $ch=[];$h=[];$cv=null;$e=null;$before=null;
  if(($s=$str('ch'))!==null){
   if(!preg_match('/^\d{1,10}:\d{1,18}(?:,\d{1,10}:\d{1,18}){0,'.(self::MAX_CH-1).'}$/D',$s))$bad();
   foreach(explode(',',$s) as $p){[$id,$rev]=array_map('intval',explode(':',$p));if($id<1||isset($ch[$id]))$bad();$ch[$id]=$rev;}
  }
  if(($s=$str('h'))!==null){
   if(!preg_match('/^\d{1,10}:\d{1,18}:\d{1,18}(?:,\d{1,10}:\d{1,18}:\d{1,18}){0,'.(self::MAX_H-1).'}$/D',$s))$bad();
   foreach(explode(',',$s) as $p){[$id,$read,$known]=array_map('intval',explode(':',$p));if($id<1||isset($h[$id]))$bad();$h[$id]=[$read,$known];}
  }
  if(($s=$str('cv'))!==null){if(!preg_match('/^\d{1,9}$/D',$s))$bad();$cv=(int)$s;}
  if(($s=$str('e'))!==null){if(!preg_match('/^(\d{1,2}):(0|429|503|508)$/D',$s,$m)||(int)$m[1]<1||(int)$m[1]>50)$bad();$e=[(int)$m[1],(int)$m[2]];}
  if(($s=$str('before'))!==null){if(!preg_match('/^\d{1,18}$/D',$s)||(int)$s<1||count($ch)!==1||reset($ch)!==0)$bad();$before=(int)$s;}
  return ['ch'=>$ch,'h'=>$h,'cv'=>$cv,'e'=>$e,'before'=>$before];
 }
 /**
  * What a poll needs (pure, §5.4 steps 3–6): per ch channel gone | initial (cursor 0) | history (before=) | since (rows
  * after the cursor) | ahead (cursor beyond the channel: reload) | same; per h channel gone | count (last_message_id ≠
  * knownLast, the only case that runs COUNT) | same; none = answer 204 (nothing changed, settings current, no history).
  */
 public static function decide(array $q,array $channels,array $state,bool $cvStale):array {
  $ch=[];$heads=[];
  foreach($q['ch'] as $id=>$rev){
   if(!isset($state[$id])){$ch[$id]='gone';continue;}
   $cur=(int)$channels[$id]['rev'];
   $ch[$id]=$q['before']!==null?'history':($rev===0?($cur===0?'same':'initial'):($rev<$cur?'since':($rev>$cur?'ahead':'same')));
  }
  foreach($q['h'] as $id=>[,$known])$heads[$id]=!isset($state[$id])?'gone':((int)$channels[$id]['last_message_id']!==$known?'count':'same');
  $none=!$cvStale&&!in_array('history',$ch,true)&&!array_filter($ch,fn($a)=>$a!=='same')&&!array_filter($heads,fn($a)=>$a!=='same');
  // A cursor of 0 on an empty channel is "same" for the 204 decision, but loaded (empty) when anything else is answered.
  foreach($q['ch'] as $id=>$rev)if($rev===0&&$ch[$id]==='same')$ch[$id]='initial';
  return ['ch'=>$ch,'heads'=>$heads,'none'=>$none];
 }
 /**
  * One poll (public-chat with $viewer null, chat-feed otherwise); null = 204. A hosting report (e) counts once per
  * reporter (the address bucket of a guest, the account of a signed-in person), status and hour: the route is public
  * and cookie-less, and the Admin acts on these figures (DEPLOY-PL.md), so a script repeating e=50:503 adds 50, not
  * 50 per request.
  */
 public static function feed(PDO $pdo,array $c,array $q,?array $viewer,int $nowMs):?array {
  if($q['e']&&RateLimit::hit($pdo,$c['app_key'],'chat-health-'.$q['e'][1],$viewer!==null?'u:'.$viewer['id']:'ip:'.ClientIp::bucket($c),1,3600,intdiv($nowMs,1000))===0)
   ChatSettings::report($pdo,$q['e'][0],$q['e'][1],intdiv($nowMs,1000));
  $channels=self::channelRows($pdo,array_values(array_unique([...array_keys($q['ch']),...array_keys($q['h'])])));
  $tours=self::tournamentRows($pdo,$channels);$settings=ChatSettings::get($pdo);$today=self::today();$grace=$settings['data']['graceDays'];
  $state=[];$tour=fn(array $row):?array=>$row['tournament_id']!==null?$tours[$row['tournament_id']]??null:null;
  foreach($channels as $id=>$row)if(($s=self::visibleFor($row,$tour($row),$viewer,$today,$grace))!==null)$state[$id]=$s;
  $stale=$q['cv']!==$settings['version'];$plan=self::decide($q,$channels,$state,$stale);
  if($plan['none'])return null;
  $full=$viewer!==null&&$viewer['full'];$out=['cv'=>$settings['version']];if($stale)$out['cfg']=ChatSettings::client($settings['data']);
  $ch=[];$batches=[];
  foreach($plan['ch'] as $id=>$action){
   if($action==='gone'){$ch[$id]=['st'=>'gone'];continue;}
   if($action==='same')continue;
   $cur=(int)$channels[$id]['rev'];$entry=['rev'=>$cur,'st'=>$state[$id],'more'=>false];
   if($action==='initial'||$action==='history'){
    $limit=$action==='history'?self::HISTORY:self::PAGE;
    $sql='SELECT '.self::MSG.' FROM chat_messages WHERE channel_id=?'.($action==='history'?' AND id<?':'').' ORDER BY id DESC LIMIT '.($limit+1);
    $rows=self::rows($pdo,$sql,$action==='history'?[$id,$q['before']]:[$id]);
    $older=count($rows)>$limit;$rows=array_reverse(array_slice($rows,0,$limit));
    $entry=$action==='history'?['st'=>$state[$id],'older'=>$older]:$entry+['older'=>$older];
   }elseif($action==='ahead'){$rows=[];$entry['more']=true;}// cursor beyond the channel (restored database): reload
   else{
    $rows=self::rows($pdo,'SELECT '.self::MSG.' FROM chat_messages WHERE channel_id=? AND rev>? ORDER BY rev LIMIT '.(self::BATCH+1),[$id,$q['ch'][$id]]);
    if(count($rows)>self::BATCH){$rows=array_slice($rows,0,self::BATCH);$entry['more']=true;$entry['rev']=(int)end($rows)['rev'];}
   }
   $ch[$id]=$entry;$batches[$id]=$rows;
  }
  $heads=[];
  foreach($plan['heads'] as $id=>$action){
   if($action==='gone')$heads[$id]=['st'=>'gone'];
   elseif($action==='count'){
    $last=(int)$channels[$id]['last_message_id'];[$read]=$q['h'][$id];$n=0;
    if($last>$read){$cq=$pdo->prepare('SELECT COUNT(*) FROM (SELECT id FROM chat_messages WHERE channel_id=? AND id>? AND state=\'visible\' LIMIT '.self::UNREAD_CAP.') x');$cq->execute([$id,$read]);$n=(int)$cq->fetchColumn();$cq->closeCursor();}
    $heads[$id]=['last'=>$last,'n'=>$n];
   }
  }
  $pids=[];$people=[];
  if($full){
   $authors=[];foreach($batches as $rows)foreach($rows as $m)$authors[$m['user_id']]=true;
   foreach(People::project($pdo,array_map('strval',array_keys($authors))) as $uid=>$p){$pids[$uid]=$p['pid'];unset($p['pid']);$people[$pids[$uid]]=$p;}
  }
  foreach($batches as $id=>$rows){
   $organizer=$tour($channels[$id])['created_by']??null;
   $ch[$id]['m']=array_map(fn($m)=>$full?self::memberMessage($m,$pids[$m['user_id']]??null,$organizer!==null&&$m['user_id']===$organizer):ChatGuestView::message($m,$id,$c['app_key']),$rows);
  }
  $out+=['ch'=>(object)$ch,'heads'=>(object)$heads];
  if($full)$out['people']=(object)$people;
  return $out;
 }
 /** Member projection of one message: {id, r, t, a?, o?, c, b} or the tombstone {id, r, t, a?, o?, x}. */
 public static function memberMessage(array $m,?string $pid,bool $organizer):array {
  $o=['id'=>(int)$m['id'],'r'=>(int)$m['rev'],'t'=>(int)$m['created_ms']];
  if($pid!==null)$o['a']=$pid;
  if($organizer)$o['o']=1;
  return $m['state']==='visible'?$o+['c'=>(int)$m['cont'],'b'=>(string)$m['body']]:$o+['x'=>ChatGuestView::X[$m['state']]??'mod'];
 }
 private static function rows(PDO $pdo,string $sql,array $params):array{$q=$pdo->prepare($sql);$q->execute($params);$r=$q->fetchAll(PDO::FETCH_ASSOC);$q->closeCursor();return $r;}
 /** chat_channels rows by id in one query: id => row. */
 public static function channelRows(PDO $pdo,array $ids):array {
  $ids=array_values(array_filter(array_map('intval',$ids),fn($i)=>$i>0));if(!$ids)return [];$out=[];
  foreach(self::rows($pdo,'SELECT '.self::CHANNEL.' FROM chat_channels WHERE id IN ('.self::marks($ids).')',$ids) as $r)$out[(int)$r['id']]=$r;
  return $out;
 }
 /** The tournaments behind the tournament channels of $channels, in one query: id => {id, event_date, status, created_by}. */
 public static function tournamentRows(PDO $pdo,array $channels):array {
  $ids=array_values(array_unique(array_filter(array_map(fn($c)=>$c['tournament_id'],$channels),'is_string')));if(!$ids)return [];$out=[];
  foreach(self::rows($pdo,'SELECT id,name,city,event_date,status,created_by FROM tournaments WHERE id IN ('.self::marks($ids).')',$ids) as $r)$out[$r['id']]=$r;
  return $out;
 }
 public static function tournamentRow(PDO $pdo,string $id):?array{return self::rows($pdo,'SELECT id,name,city,event_date,status,created_by FROM tournaments WHERE id=?',[$id])[0]??null;}

 // ——— Channel lists ———

 /**
  * public-chat-channels ($viewer null) and chat-channels (signed in): {cv, cfg, lobby:[{id, slug, scope, last, count, st}],
  * tournaments:[{id, tournamentId, title, date, city, st, last, count}]}. Guests: tournaments visible to guests (not
  * drafts, event_date ≥ today, not closed by the Admin), id null while the channel does not exist; nothing is written.
  * Signed in: also the grace days, the missing channels of those tournaments are created (INSERT IGNORE, §5.2), and the
  * archive (at most 50, newest first) of tournaments whose chat was ever used (an archive cannot be written, so an empty
  * one is not worth a row). Title, date and city are public through the public route already.
  */
 public static function lists(PDO $pdo,?array $viewer,int $now):array {
  $settings=ChatSettings::get($pdo);$today=self::today();$grace=$settings['data']['graceDays'];
  $lobby=[];
  foreach(self::rows($pdo,"SELECT ".self::CHANNEL.",sort FROM chat_channels WHERE kind='lobby' ORDER BY sort,id",[]) as $r)if(isset(self::LOBBY[$r['slug']]))
   $lobby[]=['id'=>(int)$r['id'],'slug'=>$r['slug'],'scope'=>$r['scope'],'last'=>(int)$r['last_message_id'],'count'=>(int)$r['msg_count'],'st'=>self::visibleFor($r,null,$viewer,$today,$grace)];
  $cols='t.id,t.name,t.city,t.event_date,t.status,t.created_by,c.id AS cid,c.last_message_id,c.msg_count,c.status AS cstatus';
  $upcoming=fn()=>self::rows($pdo,"SELECT $cols FROM tournaments t LEFT JOIN chat_channels c ON c.tournament_id=t.id WHERE t.status IN (".self::T_STATUSES.") AND t.event_date>=? ORDER BY t.event_date,t.id LIMIT ".self::UPCOMING,[$viewer===null?$today:self::shiftDate($today,-$grace)]);
  $rows=$upcoming();$archive=[];
  if($viewer!==null){
   $missing=array_filter($rows,fn($r)=>$r['cid']===null);
   if($missing){foreach($missing as $r)self::tournamentChannel($pdo,$r['id'],$now);$rows=$upcoming();}
   $archive=self::rows($pdo,"SELECT $cols FROM tournaments t JOIN chat_channels c ON c.tournament_id=t.id WHERE t.status IN (".self::T_STATUSES.") AND t.event_date<? AND c.rev>0 ORDER BY t.event_date DESC,t.id LIMIT ".self::ARCHIVE,[self::shiftDate($today,-$grace)]);
  }
  $items=[];
  foreach([...$rows,...$archive] as $r){
   $st=self::visibleFor(['kind'=>'tournament','status'=>$r['cstatus']??'open'],$r,$viewer,$today,$grace);if($st===null)continue;
   $items[]=['id'=>$r['cid']===null?null:(int)$r['cid'],'tournamentId'=>$r['id'],'title'=>$r['name'],'date'=>$r['event_date'],'city'=>$r['city'],'st'=>$st,'last'=>(int)($r['last_message_id']??0),'count'=>(int)($r['msg_count']??0)];
  }
  return ['cv'=>$settings['version'],'cfg'=>ChatSettings::client($settings['data']),'lobby'=>$lobby,'tournaments'=>$items];
 }
 /** The channel of tournament $tid, created when missing (INSERT IGNORE; a public_key collision is retried). */
 public static function tournamentChannel(PDO $pdo,string $tid,int $now):array {
  for($try=0;$try<4;$try++){
   if($r=self::channelOf($pdo,$tid))return $r;
   if($try<3)$pdo->prepare("INSERT IGNORE INTO chat_channels (kind,tournament_id,public_key,created_at) VALUES ('tournament',?,?,?)")->execute([$tid,self::publicKey(),$now]);
  }
  throw new \RuntimeException('Cannot create the tournament channel.');
 }
 private static function channelOf(PDO $pdo,string $tid):?array{return self::rows($pdo,'SELECT '.self::CHANNEL.' FROM chat_channels WHERE tournament_id=?',[$tid])[0]??null;}

 // ——— Sending (§5.5) ———

 /** Text of a message: Text::clean (multiline), then 1–1000 characters (mb_strlen); 422 otherwise. */
 public static function body(mixed $b):string {
  $s=Text::clean($b,['multiline'=>true]);
  if($s===null||$s==='')throw new AppError('Wiadomość jest pusta.',422);
  if(mb_strlen($s)>self::BODY_MAX)throw new AppError('Wiadomość może mieć najwyżej 1000 znaków.',422);
  return $s;
 }
 /**
  * cont (§5.3): the previous message of the channel is visible, by the same author, less than 5 minutes older and of the
  * same UTC day. The day matters for guests: their variant g is keyed by the UTC day (ChatGuestView), and c=1 across
  * midnight would tell them that today's variant is yesterday's one of the same person, linking the days.
  */
 public static function cont(?array $prev,string $userId,int $nowMs):int {
  return $prev&&$prev['user_id']===$userId&&$prev['state']==='visible'&&$nowMs-(int)$prev['created_ms']<self::CONT_MS
   &&intdiv((int)$prev['created_ms'],86400000)===intdiv($nowMs,86400000)?1:0;
 }
 /**
  * Seconds until the next message is allowed (0 = now), from the sender's last day {day_n, day_first, last_ms, minute_n,
  * minute_first} and the limits {gap s, perMin, perDay} (pure).
  */
 public static function wait(array $r,array $send,int $nowMs):int {
  $ms=0;
  if($r['last_ms']!==null&&(int)$r['last_ms']+$send['gap']*1000>$nowMs)$ms=(int)$r['last_ms']+$send['gap']*1000-$nowMs;
  if((int)$r['minute_n']>=$send['perMin'])$ms=max($ms,(int)$r['minute_first']+60000-$nowMs);
  if((int)$r['day_n']>=$send['perDay'])$ms=max($ms,(int)$r['day_first']+86400000-$nowMs);
  return $ms>0?(int)ceil($ms/1000):0;
 }
 /**
  * Send limits from one query on the index (user_id, created_ms); 429 with Retry-After and retry. send() runs it once
  * before its transaction (a cheap refusal) and again inside it, after locking the sender's users row: parallel requests
  * from several sessions of one account otherwise all read the same count and all pass.
  */
 private static function limit(PDO $pdo,string $userId,array $send,int $nowMs):void {
  $minute=$nowMs-60000;
  $q=$pdo->prepare('SELECT COUNT(*) AS day_n,MIN(created_ms) AS day_first,MAX(created_ms) AS last_ms,SUM(created_ms>?) AS minute_n,MIN(CASE WHEN created_ms>? THEN created_ms END) AS minute_first FROM chat_messages WHERE user_id=? AND created_ms>?');
  $q->execute([$minute,$minute,$userId,$nowMs-86400000]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(($w=self::wait($r,$send,$nowMs))>0){$s=Routes::retryAfter($w);throw new ApiError('Wysyłasz wiadomości zbyt szybko. Spróbuj za chwilę.',429,['retry'=>$s]);}
 }
 private static function byClientId(PDO $pdo,string $userId,string $cid):?array{return self::rows($pdo,'SELECT '.self::MSG.',channel_id FROM chat_messages WHERE user_id=? AND client_id=?',[$userId,$cid])[0]??null;}
 /**
  * chat-send {ch | t, cid, b} (§5.5), checks in this order: 1 chat on (503), 2 signed in (401), 3 full access (402),
  * 4 complete profile (403), 5 no temporary password (403), 6 not muted (403 with until), 7 channel visible to this
  * person (404), 8 channel open (409), 9 text and cid (422/400), 10 limits (429). A repeated cid returns the stored
  * message (also when the first answer was lost), but only to the channel it was sent to: a cid is single-use, so the
  * same cid sent to another channel is a client error (400), never a confirmation of a message that is somewhere else.
  * {m: member projection, rev, people: {own public_id: entry}}.
  */
 public static function send(PDO $pdo,array $c,?array $viewer,array $settings,array $in,?int $nowMs=null):array {
  $d=$settings['data'];
  if(!$d['on']){Routes::retryAfter(300);throw new ApiError('Czat jest chwilowo wyłączony. Spróbuj później.',503,['code'=>'chat_off']);}
  if(!$viewer)throw new AppError('Zaloguj się ponownie.',401);
  if(!$viewer['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
  if(!Accounts::profileComplete($viewer['profile']))throw new AppError('Uzupełnij profil, aby pisać na czacie.',403);
  if($viewer['pwReset'])throw new AppError('Najpierw zmień hasło tymczasowe.',403);
  if($viewer['muted']!==null)throw new ApiError('Moderator wstrzymał Twoje pisanie.',403,['until'=>is_int($viewer['muted'])?$viewer['muted']:null]);
  $now=time();$today=self::today();$grace=$d['graceDays'];
  [$channel,$t]=self::target($pdo,$in,$viewer,$today,$grace,$now);
  $state=self::visibleFor($channel,$t,$viewer,$today,$grace);
  if($state===null)throw new AppError('Ten czat nie istnieje.',404);
  if($state!=='open')throw new AppError('Ten czat jest tylko do odczytu.',409);
  $body=self::body($in['b']??null);
  $cid=$in['cid']??null;if(!is_string($cid)||!preg_match('/^[A-Za-z0-9_-]{22}$/D',$cid))throw new AppError('Niepoprawny formularz.',400);
  $again=function(array $old)use($pdo,$viewer,$channel):array{if((int)$old['channel_id']!==(int)$channel['id'])throw new AppError('Niepoprawny formularz.',400);return self::sent($pdo,$old,$viewer['id']);};
  if($old=self::byClientId($pdo,$viewer['id'],$cid))return $again($old);
  self::limit($pdo,$viewer['id'],$d['send'],$nowMs??self::nowMs());
  $organizer=$t!==null&&($t['created_by']??null)===$viewer['id'];
  $id=(int)$channel['id'];
  $pdo->beginTransaction();
  try{
   $l=$pdo->prepare('SELECT rev,status FROM chat_channels WHERE id=? FOR UPDATE');$l->execute([$id]);$cur=$l->fetch(PDO::FETCH_ASSOC);$l->closeCursor();
   if(!$cur||$cur['status']!=='open')throw new AppError('Ten czat jest tylko do odczytu.',409);
   $u=$pdo->prepare('SELECT id FROM users WHERE id=? FOR UPDATE');$u->execute([$viewer['id']]);$u->fetchAll();
   self::limit($pdo,$viewer['id'],$d['send'],$nowMs??self::nowMs());
   $prev=self::rows($pdo,'SELECT user_id,created_ms,state FROM chat_messages WHERE channel_id=? ORDER BY id DESC LIMIT 1',[$id])[0]??null;
   $ms=$nowMs??self::nowMs();$rev=(int)$cur['rev']+1;$cont=self::cont($prev,$viewer['id'],$ms);
   $pdo->prepare("INSERT INTO chat_messages (channel_id,rev,user_id,client_id,body,cont,state,created_ms) VALUES (?,?,?,?,?,?,'visible',?)")->execute([$id,$rev,$viewer['id'],$cid,$body,$cont,$ms]);
   $mid=(int)$pdo->lastInsertId();
   $pdo->prepare('UPDATE chat_channels SET rev=?,last_message_id=?,msg_count=msg_count+1 WHERE id=?')->execute([$rev,$mid,$id]);
   $pdo->commit();
  }catch(\Throwable $e){
   if($pdo->inTransaction())$pdo->rollBack();
   // The same cid sent twice at once: the second insert hits chat_messages_idem; answer with the stored message.
   if($e instanceof \PDOException&&(int)($e->errorInfo[1]??0)===1062&&($old=self::byClientId($pdo,$viewer['id'],$cid)))return $again($old);
   throw $e;
  }
  ChatBus::published($id,$rev);
  return self::sent($pdo,['id'=>$mid,'rev'=>$rev,'user_id'=>$viewer['id'],'body'=>$body,'cont'=>$cont,'state'=>'visible','created_ms'=>$ms,'channel_id'=>$id],$viewer['id'],$organizer);
 }
 /** The channel a send names: {ch} (an existing channel) or {t} (a tournament; its channel is created when it may be written now). */
 private static function target(PDO $pdo,array $in,array $viewer,string $today,int $grace,int $now):array {
  $ch=$in['ch']??null;$tid=$in['t']??null;
  if(is_int($ch)&&$ch>0&&$tid===null){
   $channel=self::channelRows($pdo,[$ch])[$ch]??null;if(!$channel)throw new AppError('Ten czat nie istnieje.',404);
   return [$channel,$channel['tournament_id']!==null?self::tournamentRow($pdo,$channel['tournament_id']):null];
  }
  if($ch===null&&is_string($tid)&&preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$tid)){
   $t=self::tournamentRow($pdo,$tid);$channel=$t?self::channelOf($pdo,$tid):null;
   if(!$channel&&$t&&self::tournamentState($t,$today,$viewer,$grace)==='open')$channel=self::tournamentChannel($pdo,$tid,$now);
   return [$channel??['id'=>null,'kind'=>'tournament','status'=>'open','tournament_id'=>$tid],$t];
  }
  throw new AppError('Niepoprawny formularz.',400);
 }
 /** Answer of chat-send for a stored message of $userId ($organizer null: looked up, for a repeated cid). */
 private static function sent(PDO $pdo,array $m,string $userId,?bool $organizer=null):array {
  $organizer??=(self::rows($pdo,'SELECT t.created_by FROM chat_channels c JOIN tournaments t ON t.id=c.tournament_id WHERE c.id=?',[$m['channel_id']])[0]['created_by']??null)===$userId;
  $p=People::project($pdo,[$userId])[$userId]??null;$pid=$p['pid']??null;unset($p['pid']);
  return ['m'=>self::memberMessage($m,$pid,$organizer),'rev'=>(int)$m['rev'],'people'=>(object)($pid!==null?[$pid=>$p]:[])];
 }

 // ——— Deleting and state changes ———

 /**
  * Message $id with its channel and tournament, when the channel is visible to $viewer; one 404 'Wiadomość nie istnieje.'
  * for hidden channels and missing messages alike (§5.5, §5.6). {message (with the channel's kind, slug, scope,
  * tournament_id, status, channel_rev), tournament, state}; 400 for an id that is not a positive integer.
  * $panel (actions of the Admin's moderation panel, role admin only): the message only has to exist. The report queue
  * lists every channel, also one of a tournament set back to a draft, so its actions must reach those messages (state
  * is then null); chat-delete and chat-report in the chat keep the participant's rule.
  */
 public static function locate(PDO $pdo,mixed $id,?array $viewer,int $graceDays,bool $panel=false):array {
  if(!is_int($id)||$id<1)throw new AppError('Niepoprawny formularz.',400);
  $r=self::rows($pdo,'SELECT m.id,m.rev,m.user_id,m.body,m.cont,m.state,m.created_ms,m.channel_id,c.kind,c.slug,c.scope,c.tournament_id,c.status,c.rev AS channel_rev FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id WHERE m.id=?',[$id])[0]??null;
  $t=$r&&$r['tournament_id']!==null?self::tournamentRow($pdo,$r['tournament_id']):null;
  $st=$r?self::visibleFor($r,$t,$viewer,self::today(),$graceDays):null;
  if(!$r||$st===null&&!($panel&&($viewer['role']??null)==='admin'))throw new AppError('Wiadomość nie istnieje.',404);
  return ['message'=>$r,'tournament'=>$t,'state'=>$st];
 }
 /**
  * Gives message $id the state $to under the channel row lock (its own transaction unless the caller has one open): the
  * next channel rev on the message (the change reaches every poller like a new message), body cleared for deleted
  * states, msg_count kept equal to the number of visible messages. $guard(locked row) may refuse the change (state
  * changed meanwhile); $also(locked row, rev) runs in the same transaction (log, reports). Returns {message, rev} or null.
  */
 public static function setState(PDO $pdo,int $id,string $to,int $nowMs,callable $guard,?callable $also=null):?array {
  $q=$pdo->prepare('SELECT channel_id FROM chat_messages WHERE id=?');$q->execute([$id]);$channelId=$q->fetchColumn();$q->closeCursor();
  if($channelId===false)return null;$channelId=(int)$channelId;
  $own=!$pdo->inTransaction();if($own)$pdo->beginTransaction();
  try{
   $l=$pdo->prepare('SELECT rev FROM chat_channels WHERE id=? FOR UPDATE');$l->execute([$channelId]);$rev=(int)$l->fetchColumn();$l->closeCursor();
   $m=self::rows($pdo,'SELECT '.self::MSG.',channel_id FROM chat_messages WHERE id=? FOR UPDATE',[$id])[0]??null;
   if(!$m||!$guard($m)){if($own)$pdo->rollBack();return null;}
   $rev++;$delta=($to==='visible'?1:0)-($m['state']==='visible'?1:0);
   $pdo->prepare('UPDATE chat_messages SET state=?,body=?,rev=?,changed_ms=? WHERE id=?')->execute([$to,str_starts_with($to,'deleted')?'':$m['body'],$rev,$nowMs,$id]);
   $pdo->prepare('UPDATE chat_channels SET rev=?'.($delta>0?',msg_count=msg_count+1':($delta<0?',msg_count=GREATEST(msg_count,1)-1':'')).' WHERE id=?')->execute([$rev,$channelId]);
   if($also)$also($m,$rev);
   if($own)$pdo->commit();
  }catch(\Throwable $e){if($own&&$pdo->inTransaction())$pdo->rollBack();throw $e;}
  if($own)ChatBus::published($channelId,$rev);
  return ['message'=>$m,'rev'=>$rev];
 }
 /**
  * chat-delete {id, note?} and the Admin's delete (§5.5): the author deletes their own visible message (deleted_author),
  * the Admin any message (deleted_mod; from the moderation panel always, in the chat when it is not their own). The text
  * is copied to chat_mod_log only for a moderator's deletion or when the message has open reports; an ordinary deletion
  * of one's own message leaves no copy. A message already deleted answers {ok:true} again. From the panel the message
  * only has to exist (locate $panel), in the chat its channel must be visible to the person.
  */
 public static function delete(PDO $pdo,array $viewer,mixed $id,mixed $note,int $graceDays,bool $panel=false,?int $nowMs=null):array {
  $m=self::locate($pdo,$id,$viewer,$graceDays,$panel)['message'];$id=(int)$m['id'];
  $admin=$viewer['role']==='admin';$author=$m['user_id']===$viewer['id'];
  if(!$admin&&!$author)throw new AppError('Brak uprawnień.',403);
  if(str_starts_with($m['state'],'deleted'))return ['ok'=>true];
  $mod=$admin&&($panel||!$author);
  if(!$mod&&$m['state']!=='visible')throw new AppError('Brak uprawnień.',403);
  $note=$mod?ChatModeration::text($note,'note'):null;$nowMs??=self::nowMs();$now=intdiv($nowMs,1000);
  $done=self::setState($pdo,$id,$mod?'deleted_mod':'deleted_author',$nowMs,fn($x)=>$mod?!str_starts_with($x['state'],'deleted'):$x['state']==='visible',
   function(array $x)use($pdo,$viewer,$mod,$note,$now){
    $open=self::rows($pdo,"SELECT COUNT(*) AS n FROM chat_reports WHERE message_id=? AND status='open'",[(int)$x['id']])[0]['n'];
    if($mod){
     ChatModeration::log($pdo,$viewer['id'],'delete_mod',(int)$x['id'],$x['user_id'],$note,$x['body']!==''?$x['body']:null,$now);
     $pdo->prepare("UPDATE chat_reports SET status='actioned',resolved_by=?,resolved_at=? WHERE message_id=? AND status='open'")->execute([$viewer['id'],$now,(int)$x['id']]);
    }elseif((int)$open>0)ChatModeration::log($pdo,$viewer['id'],'delete_author',(int)$x['id'],$x['user_id'],null,$x['body'],$now);
   });
  if($done===null&&!str_starts_with((string)(self::rows($pdo,'SELECT state FROM chat_messages WHERE id=?',[$id])[0]['state']??'deleted'),'deleted'))throw new AppError('Brak uprawnień.',403);
  return ['ok'=>true];
 }
 /**
  * Account deletion (§3.8, called by Members through class_exists, usually inside its transaction): every message of the
  * person that is still visible or hidden becomes an author's tombstone (body '', state deleted_author), each with its
  * own new rev, channel by channel in ascending id order (the lock order of every chat writer), msg_count corrected
  * (read under the channel lock and written as a number: GREATEST(msg_count,?) with a bound value compares as strings
  * in MySQL 8.0). No copy of the text is logged. Returns the number of messages changed.
  */
 public static function tombstoneUser(PDO $pdo,string $userId,?int $nowMs=null):int {
  $nowMs??=self::nowMs();
  $q=$pdo->prepare("SELECT DISTINCT channel_id FROM chat_messages WHERE user_id=? AND state IN ('visible','hidden_review') ORDER BY channel_id");$q->execute([$userId]);
  $channels=array_map('intval',$q->fetchAll(PDO::FETCH_COLUMN));$q->closeCursor();if(!$channels)return 0;
  $own=!$pdo->inTransaction();if($own)$pdo->beginTransaction();$done=[];$n=0;
  try{
   foreach($channels as $ch){
    $l=$pdo->prepare('SELECT rev,msg_count FROM chat_channels WHERE id=? FOR UPDATE');$l->execute([$ch]);$lock=$l->fetch(PDO::FETCH_ASSOC);$l->closeCursor();$rev=(int)$lock['rev'];
    $rows=self::rows($pdo,"SELECT id,state FROM chat_messages WHERE user_id=? AND channel_id=? AND state IN ('visible','hidden_review') ORDER BY id FOR UPDATE",[$userId,$ch]);
    if(!$rows)continue;$visible=0;
    $u=$pdo->prepare("UPDATE chat_messages SET state='deleted_author',body='',rev=?,changed_ms=? WHERE id=?");
    foreach($rows as $r){$u->execute([++$rev,$nowMs,(int)$r['id']]);$visible+=$r['state']==='visible'?1:0;}
    $pdo->prepare('UPDATE chat_channels SET rev=?,msg_count=? WHERE id=?')->execute([$rev,max(0,(int)$lock['msg_count']-$visible),$ch]);
    $done[$ch]=$rev;$n+=count($rows);
   }
   if($own)$pdo->commit();
  }catch(\Throwable $e){if($own&&$pdo->inTransaction())$pdo->rollBack();throw $e;}
  // Inside the caller's transaction the signal precedes its commit: harmless with the v1 driver none (stage 2 must defer it).
  foreach($done as $ch=>$rev)ChatBus::published($ch,$rev);
  return $n;
 }
}
