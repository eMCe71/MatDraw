<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * What a member sees on "Moje starty" (PLAN-REJESTRACJA-ROLE §7.4, R9): an allow-list projection like GuestView, without
 * loading the workspace. dist/athlete-view.js mirrors project() and fromWorkspace() (tests/athlete-view.test.mjs).
 *  project(profiles, tournaments, withdrawals, today, organizers) is pure:
 *   profiles     the account's own profiles (workspace shape) with clubRow {id, name, verified} (the current club, merged →
 *                target, raw name) or null;
 *   tournaments  {id, name, city, date, status, selfEntry, hiddenBy, createdBy, community, trusted, entries, draws}; every
 *                entry snapshot carries currentClub {id, name} as Repository::guestTournaments gives it (name null for an
 *                unverified club, '' for 'unaffiliated'); old tournaments may hold only the own entries;
 *   withdrawals  [{profileId, tournament:{id, name, date}, by, at}] (entry_withdrawals with the tournament's name and date);
 *   organizers   {userId: {n}}: display names ("Marta K.", People::project) of community organizers (O11).
 *  Answer (every key listed, nothing copied wholesale):
 *   profiles  [{id, name, birthDate, sex, weight, height, gradeType, grade, club:{id, name, verified, unaffiliated, pending},
 *              relation, archived, minor, locked}], sorted by id; club.name is '' for 'unaffiliated' (the interface says
 *              "Niezrzeszony/-a"), pending the club name waiting for the Administrator (PS-9) or null; minor: under ADULT_AGE
 *              today; locked: entries in open or closed tournaments (club, birth date and sex cannot change, §6.1).
 *   entries   [{profileId, tournament, entry, canWithdraw, canEdit, categories}], newest tournament first, at most 100:
 *              tournament {id, name, city, date, status, available:true, community, trusted}, or only {id, name, date,
 *              available:false} for a draft or hidden tournament ("Organizator lub Administrator wstrzymał ten turniej.");
 *              entry {events, weight, height, gradeType, grade, age, club:{id, name, verified, unaffiliated}, presence,
 *              actualWeight} (the own snapshot; club: the current verified name, else the name of the snapshot);
 *              canWithdraw: open registration and the entry outside every saved draw (entry.remove, owner's branch);
 *              canEdit: canWithdraw, self-entries on, not past, and allowed for minors (entry.self with update);
 *              categories (available tournaments dated within RECENT_DAYS only) [{event, code, title, subtitle, type,
 *              state, athletes, drawn, position, bracket}]: codes and order of GuestView::categoryList, drawn = a saved
 *              draw, bracket as in GuestView (initials and club only), position null | {slot (index in bracket.slots),
 *              round (1 = first), match (fight number), status waiting|next|won|lost|bye|champion, opponent null |
 *              {initials, club} (next and lost only)}.
 *   withdrawn [{profileId, tournament:{id, name, date}, by:'organizer'|'admin'|'system', at}] newest first, at most 100.
 *   open      [{id, name, city, date, community, trusted, organizer:null|{n}, profiles:[{id, entered, blocked:null|
 *              'minor-untrusted'}], drawn:[category ids with a saved draw]}]: open, self-entries on, not hidden, dated today
 *              or later, nearest first, at most 50; profiles are the non-archived own ones; blocked when the tournament is
 *              not trusted and the profile is not an adult 'self' on the tournament day (§7.1); drawn lets the entry
 *              window mark events whose category was already drawn (engine.js classify gives the category id).
 *              $include (the route's ?t=<id>, a tournament the member came from: a guest preview, a shared link) is
 *              always in the list when it qualifies, appended after the first OPEN_LIMIT (it is later than all of them).
 *  Never: other athletes beyond initials and club inside brackets, ids of other entries or profiles, e-mails, creators of
 *  staff tournaments, logs, mats, revisions.
 * build(pdo, u, today, flags, include) reads the same inputs with a few queries (own profiles; own entries, newest 100; open
 * tournaments, 50, plus $include when it qualifies; all entries and draws only of tournaments with own entries that are
 * recent or still open or closed; tombstones; organizer names) in one read transaction. fromWorkspace(db, u, today,
 * withdrawals, organizers, include) builds them from a workspace (the demo and the equivalence test: build() equals
 * fromWorkspace() of the full workspace).
 */
final class AthleteView {
 public const RECENT_DAYS=30,ENTRY_LIMIT=100,OPEN_LIMIT=50,WITHDRAWN_LIMIT=100;
 public const BY=['organizer','admin','system'];
 /** The first date whose tournaments still show categories and brackets: $today minus RECENT_DAYS. */
 public static function recentFrom(string $today):string{return (new \DateTimeImmutable($today.' 00:00:00',new \DateTimeZone('UTC')))->modify('-'.self::RECENT_DAYS.' days')->format('Y-m-d');}
 /** The club shown for a snapshot's clubId (as Repository::guestTournaments): merged → target, '' for 'unaffiliated', null when unverified. */
 public static function currentClub(array $clubs,mixed $clubId):array{$c=Clubs::resolve($clubs,$clubId);$id=$c['id']??$clubId;return ['id'=>$id,'name'=>$id===Clubs::UNAFFILIATED?'':($c!==null&&($c['verified']??true)!==false?(string)$c['name']:null)];}
 private static function profileClub(array $a):array {
  $c=is_array($a['clubRow']??null)?$a['clubRow']:null;$id=$c['id']??($a['clubId']??null);$none=$id===Clubs::UNAFFILIATED;
  return ['id'=>$id,'name'=>$none?'':(string)($c['name']??''),'verified'=>$none||$c!==null&&!empty($c['verified']),'unaffiliated'=>$none,'pending'=>is_string($a['pendingClubName']??null)?$a['pendingClubName']:null];
 }
 private static function entryClub(array $e):array {
  $c=is_array($e['currentClub']??null)?$e['currentClub']:null;$id=$c['id']??($e['clubId']??null);$none=$id===Clubs::UNAFFILIATED;$verified=$none||$c!==null&&($c['name']??null)!==null;
  return ['id'=>$id,'name'=>$none?'':($verified?(string)$c['name']:(string)($e['club']??'')),'verified'=>$verified,'unaffiliated'=>$none];
 }
 /** Self-entries of this profile need a trusted tournament (§7.1): not a 'self' profile or under ADULT_AGE on the day. */
 private static function minorOn(array $a,string $date):bool{return ($a['relation']??null)!=='self'||!is_string($a['birthDate']??null)||Domain::ageAt($a['birthDate'],$date)<Domain::ADULT_AGE;}
 private static function inDraw(array $draws,string $id):bool{foreach($draws as $d)if(is_array($d)&&in_array($id,$d['slots']??[],true))return true;return false;}
 /** Where entry $id stands in saved draw $d (slots of $bracket, the public bracket of the same draw). */
 public static function position(array $d,string $id,array $bracket):?array {
  $slots=array_values($d['slots']??[]);$slot=array_search($id,$slots,true);if($slot===false)return null;
  $last=null;$prev=null;foreach(Rules::resolve(['slots'=>$slots,'results'=>is_array($d['results']??null)?$d['results']:[]]) as $round)foreach($round as $m)if($m['a']===$id||$m['b']===$id){$prev=$last;$last=$m;}
  if($last===null)return null;
  $other=$last['a']===$id?$last['b']:$last['a'];
  $status=$last['settled']?($last['winner']===$id?'champion':'lost'):($last['ready']?'next':($prev!==null&&$prev['auto']?'bye':($prev!==null&&$prev['winner']===$id?'won':'waiting')));
  $opponent=null;if(($status==='next'||$status==='lost')&&is_string($other)&&($i=array_search($other,$slots,true))!==false)$opponent=$bracket['slots'][$i]??null;
  return ['slot'=>$slot,'round'=>$last['round']+1,'match'=>$last['number'],'status'=>$status,'opponent'=>$opponent];
 }
 private static function byDate(array $a,array $b,bool $newest):int{return ($newest?strcmp((string)$b['date'],(string)$a['date']):strcmp((string)$a['date'],(string)$b['date']))?:strcmp((string)$a['id'],(string)$b['id']);}
 public static function project(array $profiles,array $tournaments,array $withdrawals,string $today,array $organizers,?string $include=null):array {
  usort($profiles,fn($a,$b)=>strcmp((string)$a['id'],(string)$b['id']));$own=[];foreach($profiles as $a)$own[(string)$a['id']]=$a;
  $pending=[];$entered=[];
  foreach($tournaments as $t)foreach($t['entries']??[] as $e){$pid=(string)($e['profileId']??'');$entered[$t['id'].'/'.$pid]=true;if(isset($own[$pid])&&in_array($t['status']??null,['open','closed'],true))$pending[$pid]=true;}
  $out=['profiles'=>[],'entries'=>[],'withdrawn'=>[],'open'=>[]];
  foreach($profiles as $a)$out['profiles'][]=['id'=>$a['id'],'name'=>$a['name'],'birthDate'=>$a['birthDate']??null,'sex'=>$a['sex']??null,'weight'=>$a['weight']??null,'height'=>$a['height']??null,'gradeType'=>$a['gradeType']??null,'grade'=>$a['grade']??null,
   'club'=>self::profileClub($a),'relation'=>$a['relation']??null,'archived'=>!empty($a['archived']),'minor'=>!is_string($a['birthDate']??null)||Domain::ageAt($a['birthDate'],$today)<Domain::ADULT_AGE,'locked'=>isset($pending[$a['id']])];
  $list=$tournaments;usort($list,fn($a,$b)=>self::byDate($a,$b,true));$recent=self::recentFrom($today);
  foreach($list as $t){
   $mine=array_values(array_filter($t['entries']??[],fn($e)=>isset($own[(string)($e['profileId']??'')])));if(!$mine)continue;
   usort($mine,fn($a,$b)=>strcmp((string)$a['profileId'],(string)$b['profileId']));
   $draws=is_array($t['draws']??null)?$t['draws']:[];$available=($t['status']??null)!=='draft'&&($t['hiddenBy']??null)===null;
   $cats=$available&&$t['date']>=$recent?GuestView::categoryList(array_values($t['entries']),$draws):[];
   foreach($mine as $e){
    if(count($out['entries'])>=self::ENTRY_LIMIT)break 2;
    $a=$own[(string)$e['profileId']];$withdraw=$available&&$t['status']==='open'&&!self::inDraw($draws,(string)$e['id']);
    $categories=[];
    foreach($cats as $c){
     if(!in_array($e['id'],array_column($c['athletes'],'id'),true))continue;$p=$c['public'];$d=$draws[$c['id']]??null;
     $categories[]=['event'=>$p['event'],'code'=>$p['code'],'title'=>$p['title'],'subtitle'=>$p['subtitle'],'type'=>$p['type'],'state'=>$p['state'],'athletes'=>$p['athletes'],'drawn'=>is_array($d),'position'=>$p['bracket']!==null&&is_array($d)?self::position($d,(string)$e['id'],$p['bracket']):null,'bracket'=>$p['bracket']];
    }
    $out['entries'][]=['profileId'=>$e['profileId'],
     'tournament'=>$available?['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['date'],'status'=>$t['status'],'available'=>true,'community'=>!empty($t['community']),'trusted'=>!empty($t['trusted'])]:['id'=>$t['id'],'name'=>$t['name'],'date'=>$t['date'],'available'=>false],
     'entry'=>['events'=>array_values($e['events']??[]),'weight'=>$e['weight']??null,'height'=>$e['height']??null,'gradeType'=>$e['gradeType']??null,'grade'=>$e['grade']??null,'age'=>$e['age']??null,'club'=>self::entryClub($e),'presence'=>$e['presence']??'pending','actualWeight'=>$e['actualWeight']??null],
     'canWithdraw'=>$withdraw,'canEdit'=>$withdraw&&($t['selfEntry']??false)===true&&$t['date']>=$today&&(!empty($t['trusted'])||!self::minorOn($a,$t['date'])),'categories'=>$categories];
   }
  }
  $gone=array_values(array_filter($withdrawals,fn($w)=>isset($own[(string)($w['profileId']??'')])&&in_array($w['by']??null,self::BY,true)&&!isset($entered[($w['tournament']['id']??'').'/'.$w['profileId']])));
  usort($gone,fn($a,$b)=>(int)$b['at']<=>(int)$a['at']?:strcmp((string)$a['tournament']['id'],(string)$b['tournament']['id'])?:strcmp((string)$a['profileId'],(string)$b['profileId']));
  foreach(array_slice($gone,0,self::WITHDRAWN_LIMIT) as $w)$out['withdrawn'][]=['profileId'=>$w['profileId'],'tournament'=>['id'=>$w['tournament']['id'],'name'=>$w['tournament']['name'],'date'=>$w['tournament']['date']],'by'=>$w['by'],'at'=>(int)$w['at']];
  $open=array_values(array_filter($tournaments,fn($t)=>($t['status']??null)==='open'&&($t['selfEntry']??false)===true&&($t['hiddenBy']??null)===null&&is_string($t['date']??null)&&$t['date']>=$today));
  usort($open,fn($a,$b)=>self::byDate($a,$b,false));$shown=array_slice($open,0,self::OPEN_LIMIT);
  if($include!==null&&!in_array($include,array_column($shown,'id'),true))foreach($open as $t)if($t['id']===$include)$shown[]=$t;
  foreach($shown as $t){
   $in=[];foreach($t['entries']??[] as $e)$in[(string)($e['profileId']??'')]=true;$keys=array_map('strval',array_keys(is_array($t['draws']??null)?$t['draws']:[]));sort($keys,SORT_STRING);
   $n=!empty($t['community'])?($organizers[$t['createdBy']??'']['n']??null):null;
   $out['open'][]=['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['date'],'community'=>!empty($t['community']),'trusted'=>!empty($t['trusted']),'organizer'=>is_string($n)&&$n!==''?['n'=>$n]:null,
    'profiles'=>array_values(array_map(fn($a)=>['id'=>$a['id'],'entered'=>isset($in[$a['id']]),'blocked'=>empty($t['trusted'])&&self::minorOn($a,$t['date'])?'minor-untrusted':null],array_filter($profiles,fn($a)=>empty($a['archived'])))),'drawn'=>$keys];
  }
  return $out;
 }
 /** The inputs of project() from a workspace ($db with flags for trust, §17), for the demo mirror and the equivalence test. */
 public static function fromWorkspace(array $db,array $u,string $today,?array $withdrawals=null,array $organizers=[],?string $include=null):array {
  $clubs=$db['clubs'];$profiles=[];$tournaments=[];$byId=[];
  foreach($db['profiles'] as $a){if(($a['ownerId']??null)===null||$a['ownerId']!==$u['id'])continue;$c=Clubs::resolve($clubs,$a['clubId']??null);$a['clubRow']=$c===null?null:['id'=>$c['id'],'name'=>$c['name'],'verified'=>($c['verified']??true)!==false];$profiles[]=$a;}
  foreach($db['tournaments'] as $t){
   $byId[$t['id']]=$t;
   $tournaments[]=['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['date'],'status'=>$t['status'],'selfEntry'=>($t['selfEntry']??false)===true,'hiddenBy'=>$t['hiddenBy']??null,'createdBy'=>$t['createdBy']??null,'community'=>Domain::community($db,$t),'trusted'=>Domain::trusted($db,$t),
    'entries'=>array_map(fn($e)=>array_replace($e,['currentClub'=>self::currentClub($clubs,$e['clubId']??null)]),$t['entries']),'draws'=>$t['draws']];
  }
  $gone=[];foreach($withdrawals??($db['withdrawals']??[]) as $w){$t=$byId[$w['tournamentId']??'']??null;if($t)$gone[]=['profileId'=>$w['profileId'],'tournament'=>['id'=>$t['id'],'name'=>$t['name'],'date'=>$t['date']],'by'=>$w['by'],'at'=>(int)$w['at']];}
  return self::project($profiles,$tournaments,$gone,$today,$organizers,$include);
 }
 private static function in(array $values):string{return implode(',',array_fill(0,count($values),'?'));}
 /** Current club of a row joined as c (the club) and m (its merge target): {id, name, verified} with the raw name. */
 private static function joined(array $r,?string $fallback):array{return $r['mid']!==null?['id'=>$r['mid'],'name'=>$r['mname'],'verified'=>(int)$r['mver']===1]:['id'=>$r['cid']??$fallback,'name'=>$r['cname'],'verified'=>$r['cver']!==null&&(int)$r['cver']===1];}
 /**
  * AthleteView of member $u from the database (no workspace, no lock); $flags: Settings::flags of the effective config
  * (trustRequired); $include: a tournament id that the open list must hold when it qualifies (the route's ?t=, F1).
  */
 public static function build(PDO $pdo,array $u,string $today,array $flags=[],?string $include=null):array {
  $any=($flags['trustRequired']??true)===false;$recent=self::recentFrom($today);
  $decode=static fn(string $v):array=>json_decode($v,true,512,JSON_THROW_ON_ERROR);
  $club=' LEFT JOIN clubs c ON c.id=%s LEFT JOIN clubs m ON m.id=c.merged_into';$cols='c.id cid,c.name cname,c.verified cver,m.id mid,m.name mname,m.verified mver';
  $pdo->beginTransaction();
  try{
   $q=$pdo->prepare("SELECT p.id,p.club_id,p.created_by,p.archived,p.owner_user_id,p.data,$cols FROM profiles p".sprintf($club,'p.club_id').' WHERE p.owner_user_id=? ORDER BY p.id');$q->execute([$u['id']]);$profiles=[];
   foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r){$c=self::joined($r,null);$profiles[]=array_replace($decode((string)$r['data']),['id'=>$r['id'],'clubId'=>$r['club_id'],'createdBy'=>$r['created_by'],'archived'=>(bool)$r['archived'],'ownerId'=>$r['owner_user_id'],'clubRow'=>$c['id']===null?null:$c]);}
   $ids=array_column($profiles,'id');$mine=[];
   if($ids){$q=$pdo->prepare('SELECT e.tournament_id FROM entries e JOIN tournaments t ON t.id=e.tournament_id WHERE e.profile_id IN ('.self::in($ids).') ORDER BY t.event_date DESC,t.id,e.profile_id LIMIT '.self::ENTRY_LIMIT);$q->execute($ids);$mine=array_values(array_unique($q->fetchAll(PDO::FETCH_COLUMN)));}
   $q=$pdo->prepare("SELECT id FROM tournaments WHERE status='open' AND self_entry=1 AND hidden_by IS NULL AND event_date>=? ORDER BY event_date,id LIMIT ".self::OPEN_LIMIT);$q->execute([$today]);$open=$q->fetchAll(PDO::FETCH_COLUMN);
   // The tournament the member came from is never cut off by OPEN_LIMIT (the same conditions, one query by key).
   if($include!==null&&!in_array($include,$open,true)){$q=$pdo->prepare("SELECT id FROM tournaments WHERE id=? AND status='open' AND self_entry=1 AND hidden_by IS NULL AND event_date>=?");$q->execute([$include,$today]);if(($x=$q->fetchColumn())!==false)$open[]=$x;}
   $all=array_values(array_unique([...$mine,...$open]));$tournaments=[];$full=[];$part=[];$creators=[];
   if($all){
    $q=$pdo->prepare('SELECT t.id,t.name,t.city,t.event_date,t.status,t.self_entry,t.hidden_by,t.created_by,u.role,u.organizer_trusted_at,u.organizer_blocked_at FROM tournaments t LEFT JOIN users u ON u.id=t.created_by WHERE t.id IN ('.self::in($all).')');$q->execute($all);
    foreach($q->fetchAll(PDO::FETCH_ASSOC) as $t){
     $community=!in_array($t['role'],Domain::STAFF,true);$trusted=!$community||$t['role']==='member'&&$t['organizer_blocked_at']===null&&($t['organizer_trusted_at']!==null||$any);
     $tournaments[$t['id']]=['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['event_date'],'status'=>$t['status'],'selfEntry'=>(bool)$t['self_entry'],'hiddenBy'=>$t['hidden_by'],'createdBy'=>$t['created_by'],'community'=>$community,'trusted'=>$trusted,'entries'=>[],'draws'=>[]];
     if(in_array($t['id'],$mine,true)){if($t['event_date']>=$recent||in_array($t['status'],['open','closed'],true))$full[]=$t['id'];else $part[]=$t['id'];}
     if($community&&in_array($t['id'],$open,true))$creators[]=$t['created_by'];
    }
   }
   $entries=function(string $where,array $args)use($pdo,$decode,$club,$cols,&$tournaments):void{
    $q=$pdo->prepare("SELECT e.tournament_id,e.snapshot,$cols FROM entries e".sprintf($club,'e.club_id')." WHERE $where ORDER BY e.tournament_id,e.profile_id");$q->execute($args);
    foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r){$s=$decode((string)$r['snapshot']);$c=self::joined($r,$s['clubId']??null);$s['currentClub']=['id'=>$c['id'],'name'=>$c['id']===Clubs::UNAFFILIATED?'':($c['verified']?(string)$c['name']:null)];$tournaments[$r['tournament_id']]['entries'][]=$s;}
   };
   if($full)$entries('e.tournament_id IN ('.self::in($full).')',$full);
   if($part)$entries('e.tournament_id IN ('.self::in($part).') AND e.profile_id IN ('.self::in($ids).')',[...$part,...$ids]);
   if($full){$q=$pdo->prepare('SELECT tournament_id,category_key,data FROM draws WHERE tournament_id IN ('.self::in($full).') ORDER BY tournament_id,category_key');$q->execute($full);foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$tournaments[$r['tournament_id']]['draws'][$r['category_key']]=$decode((string)$r['data']);}
   // Open tournaments without own entries: only which categories are drawn.
   $keysOnly=array_values(array_diff($open,$full));
   if($keysOnly){$q=$pdo->prepare('SELECT tournament_id,category_key FROM draws WHERE tournament_id IN ('.self::in($keysOnly).') ORDER BY tournament_id,category_key');$q->execute($keysOnly);foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$tournaments[$r['tournament_id']]['draws'][$r['category_key']]=true;}
   $gone=[];
   if($ids){
    $q=$pdo->prepare('SELECT w.profile_id,w.tournament_id,w.by_kind,w.created_at,t.name,t.event_date FROM entry_withdrawals w JOIN tournaments t ON t.id=w.tournament_id WHERE w.profile_id IN ('.self::in($ids).') ORDER BY w.created_at DESC,w.tournament_id,w.profile_id LIMIT '.self::WITHDRAWN_LIMIT);$q->execute($ids);
    foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$gone[]=['profileId'=>$r['profile_id'],'tournament'=>['id'=>$r['tournament_id'],'name'=>$r['name'],'date'=>$r['event_date']],'by'=>$r['by_kind'],'at'=>(int)$r['created_at']];
   }
   $pdo->commit();
  }catch(\Throwable $e){$pdo->rollBack();throw $e;}
  $organizers=[];foreach(People::project($pdo,$creators) as $id=>$p)if(isset($p['n']))$organizers[$id]=['n'=>$p['n']];
  return self::project($profiles,array_values($tournaments),$gone,$today,$organizers,$include);
 }
}
