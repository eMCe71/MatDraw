<?php
declare(strict_types=1);
namespace MatDraw;
class AppError extends \RuntimeException{public function __construct(string $message,public int $status=422){parent::__construct($message);}}
/**
 * Workspace rules (plan §5, §6, §7 of PLAN-REJESTRACJA-ROLE). dist/workspace.js mirrors every public rule and command
 * (tests/roles-parity.test.mjs); forgetMember() and retain() are PHP only.
 * Roles: staff (admin, editor, club) as before; a member is an organizer when users.organizer=1 and the Administrator has
 * not blocked the role (organizer()), and owns athlete profiles (ownerId). A member enters $db only as the actor of the
 * own request (Repository::transaction). Read-only parts of $db: organizers {userId:{trusted, blocked}} (members who
 * created tournaments), flags {organizers:'on'|'paused', trustRequired:bool} (Settings::flags), withdrawals (tombstones
 * written by this request) and staffRev.
 * Visibility (§5.2): community(t) = creator not staff; trusted(t) = staff tournament, or a creator confirmed by the
 * Administrator and not blocked, or any organizer not blocked when trustRequired is false (§17). A member gets the same
 * 404 for a missing and an unseen tournament ('Turniej nie jest dostępny.') or profile ('Zawodnik nie istnieje.').
 * Revisions (§5.8): stale() rejects a command only when the objects it touches changed after the client's revision;
 * execute() stamps every changed tournament and profile (rev) and staff accounts or existing clubs (staffRev).
 * Log lines naming an athlete carry its profileId (audit()), so forgetting a profile rewrites only lines about it and
 * never another tenant's tournament for a namesake; publicData() shows text and time only.
 */
final class Domain {
 public const ORGANIZER_DAY=3,ORGANIZER_ACTIVE=10,COMMUNITY_DAY_GLOBAL=50,ORGANIZER_PROFILES_DAY=300,CLUBS_DAY_PER_USER=3,CLUBS_DAY_GLOBAL=30,MINOR_SELF_AGE=16,ADULT_AGE=18,ATHLETES_PER_ACCOUNT=5,RETENTION_MONTHS=24;
 public const STAFF=['admin','editor','club'];
 public const ORGANIZER_TYPES=['tournament.save','profile.save','profile.archive','profile.forget','entry.save','entry.remove','checkin.save','draw.create','result.save','result.clear'];
 /** Web addresses, e-mails and numbers of 9+ digits in texts of members (§5.4); the same pattern is CONTACT in dist/workspace.js. */
 public const CONTACT='~(?:https?://|www\.|@|(?<![\p{L}\p{N}_])[\p{L}\p{N}-]+\.(?:pl|com|eu|net|org|info|io|me|app|link|ly|gg|online|site|shop|xyz)(?![\p{L}\p{N}_])|\p{Nd}(?:[\s./-]?\p{Nd}){8,})~iu';
 public const DELETED='Dane usunięte';
 /** Tournament log lines that end with an athlete's name (entries, self-entries, check-in, withdrawals); audit() marks each with the athlete's profileId, retain() and forgetProfile() turn the name into initials. */
 private const NAMED='/^((?:Zgłoszono|Zmieniono zgłoszenie|Zgłoszenie własne|Zmieniono zgłoszenie własne|Zmieniono klub w zgłoszeniu|Kontrola startowa|Wycofano zgłoszenie): )(.+)$/su';
 private const TOURNAMENT_SCOPE=['entry.remove','checkin.save','draw.create','result.save','result.clear','tournament.hide'];
 public static function id():string{return bin2hex(random_bytes(16));}
 public static function txt(mixed $v,string $label,int $max=100):string{if(!is_string($v)||trim($v)===''||mb_strlen(trim($v))>$max)throw new AppError('Sprawdź pole: '.$label.'.');return trim($v);}
 public static function number(mixed $v,float $min,float $max,bool $integer=false):int|float{if((!is_int($v)&&!is_float($v)&&!is_string($v))||!is_numeric($v))throw new AppError('Niepoprawna wartość liczbowa.');$n=(float)$v;if(!is_finite($n)||$n<$min||$n>$max||($integer&&floor($n)!==$n))throw new AppError('Wartość liczbowa jest poza zakresem.');return $integer?(int)$n:$n;}
 public static function date(mixed $v):string{if(!is_string($v)||!preg_match('/^\d{4}-\d{2}-\d{2}$/D',$v)||!($d=\DateTimeImmutable::createFromFormat('!Y-m-d',$v))||$d->format('Y-m-d')!==$v)throw new AppError('Podaj poprawną datę.');return $v;}
 public static function ageAt(string $birth,string $date):int{self::date($birth);self::date($date);$b=new \DateTimeImmutable($birth);$d=new \DateTimeImmutable($date);return $d<$b?-1:$b->diff($d)->y;}
 public static function &entity(array &$rows,mixed $id,string $label):array{foreach($rows as &$r)if($r['id']===$id)return $r;throw new AppError($label.' nie istnieje.',404);}
 public static function contact(string $s):bool{return (bool)preg_match(self::CONTACT,$s);}
 // Roles and visibility (§5.7). Without $db, profile and tournament rules read the view fields staff, community, trusted.
 public static function organizer(array $u):bool{return ($u['role']??null)==='member'&&!empty($u['organizer'])&&empty($u['organizerBlockedAt']);}
 private static array $staffMemo=[null,[]];
 public static function staffIds(array $db):array{if(self::$staffMemo[0]!==$db['users']){$s=[];foreach($db['users'] as $u)if(in_array($u['role']??null,self::STAFF,true))$s[$u['id']]=true;self::$staffMemo=[$db['users'],$s];}return self::$staffMemo[1];}
 public static function staffProfile(?array $db,array $a):bool{return $db===null?($a['staff']??false)===true:($a['ownerId']??null)===null&&isset(self::staffIds($db)[$a['createdBy']??'']);}
 public static function community(?array $db,array $t):bool{return $db===null?!empty($t['community']):!isset(self::staffIds($db)[$t['createdBy']??'']);}
 public static function trustRequired(array $db):bool{return ($db['flags']['trustRequired']??true)!==false;}
 /** A member creator confirmed by the Administrator and not blocked; with trustRequired=false every creator not blocked (§17). */
 public static function trustedOrganizer(array $db,mixed $id):bool {
  if(!is_string($id))return false;
  // Repository::load() lists members who created tournaments; the actor of the request (also before his first tournament) and the demo hold the fields themselves.
  $o=$db['organizers'][$id]??null;
  if($o===null)foreach($db['users'] as $u)if($u['id']===$id&&($u['role']??null)==='member')$o=['trusted'=>($u['organizerTrustedAt']??null)!==null,'blocked'=>($u['organizerBlockedAt']??null)!==null];
  return $o!==null&&empty($o['blocked'])&&(!empty($o['trusted'])||!self::trustRequired($db));
 }
 public static function trusted(?array $db,array $t):bool{return $db===null?empty($t['community'])||!empty($t['trusted']):!self::community($db,$t)||self::trustedOrganizer($db,$t['createdBy']??null);}
 public static function manages(array $u,array $t):bool{return $u['role']==='admin'||($u['role']==='editor'||self::organizer($u))&&($t['createdBy']??null)===$u['id'];}
 public static function managesProfile(array $u,array $a,?array $db=null):bool {
  if($u['role']==='admin')return true;
  if(($a['ownerId']??null)!==null)return $a['ownerId']===$u['id'];
  if($u['role']==='club')return self::staffProfile($db,$a)&&($a['clubId']??null)===$u['clubId'];
  return ($u['role']==='editor'||self::organizer($u))&&($a['createdBy']??null)===$u['id'];
 }
 public static function outsideEntry(array $u,array $t,?array $db=null):bool{return ($t['status']??null)==='open'&&self::trusted($db,$t)&&($u['role']==='club'||$u['role']==='editor'||self::organizer($u)&&($t['selfEntry']??false)===true);}
 public static function canEnter(array $u,array $t,?array $db=null):bool{return ($t['status']??null)!=='finished'&&(self::manages($u,$t)||self::outsideEntry($u,$t,$db));}
 public static function canCreateTournament(array $u):bool{return $u['role']==='admin'||$u['role']==='editor'||self::organizer($u);}
 /** An entry of tournament $t that $u (not its manager) may see: club → own club and staff profile; editor → every entry in staff tournaments, own profiles in community ones; organizer → own profiles. */
 private static function entryVisible(array $db,array $u,array $t,array $e,array $profiles):bool {
  $a=$profiles[$e['profileId']??'']??null;
  if($u['role']==='club')return ($e['clubId']??null)===$u['clubId']&&$a!==null&&self::staffProfile($db,$a);
  if($u['role']==='editor')return !self::community($db,$t)||$a!==null&&($a['ownerId']??null)===null&&($a['createdBy']??null)===$u['id'];
  return self::organizer($u)&&$a!==null&&self::managesProfile($u,$a,$db);
 }
 private static function byId(array $rows):array{$o=[];foreach($rows as $r)$o[$r['id']]=$r;return $o;}
 /** Whether $u sees tournament $t (§5.2): admin and the manager always; others never drafts and only trusted tournaments. */
 public static function sees(array $db,array $u,array $t,?array $profiles=null):bool {
  if($u['role']==='admin'||self::manages($u,$t))return true;
  if(($t['status']??null)==='draft'||!self::trusted($db,$t)||!in_array($u['role'],['editor','club','member'],true)||$u['role']==='member'&&!self::organizer($u))return false;
  if($u['role']==='editor'&&!self::community($db,$t))return true;
  if(($t['status']??null)==='open'&&($u['role']!=='member'||($t['selfEntry']??false)===true))return true;
  $profiles??=self::byId($db['profiles']);foreach($t['entries'] as $e)if(self::entryVisible($db,$u,$t,$e,$profiles))return true;
  return false;
 }
 private static function profileVisible(array $db,array $u,array $a):bool{return match(true){$u['role']==='admin'=>true,$u['role']==='editor'=>self::staffProfile($db,$a),$u['role']==='club'=>self::staffProfile($db,$a)&&($a['clubId']??null)===$u['clubId'],default=>self::organizer($u)&&self::managesProfile($u,$a,$db)};}
 public static function safeUser(array $u):array{unset($u['passwordHash'],$u['passwordSalt'],$u['authVersion']);return $u;}
 /** The workspace of $u (§5.2 matrix); a member without the organizer role gets the empty shape. */
 public static function publicData(array $db,array $u):array {
  $role=$u['role'];$admin=$role==='admin';$out=['schemaVersion'=>2,'revision'=>$db['revision'],'user'=>self::safeUser($u),'clubs'=>[],'users'=>[],'profiles'=>[],'tournaments'=>[]];
  if($role==='member'&&!self::organizer($u))return $out;
  $profiles=self::byId($db['profiles']);$used=[];
  foreach($db['tournaments'] as $t){
   if(!self::sees($db,$u,$t,$profiles))continue;
   $manager=$admin||self::manages($u,$t);$community=self::community($db,$t);$hidden=($t['hiddenBy']??null)!==null;$entries=[];
   foreach($t['entries'] as $e){if($manager?$hidden&&!$admin&&!empty($e['self']):!self::entryVisible($db,$u,$t,$e,$profiles))continue;$entries[]=$e;$used[$e['clubId']??'']=true;}
   $full=$manager||$role==='editor'&&!$community;$draws=$full?$t['draws']:[];$activity=$full?array_map(static fn($x)=>array_intersect_key($x,['text'=>1,'time'=>1]),$t['activity']):[];
   // A tournament hidden by the Administrator: its manager loses the self-entries (PS-16), the draws holding them and the log naming them.
   if($manager&&$hidden&&!$admin){$ids=array_column($entries,'id');$draws=array_filter($draws,fn($d)=>!array_diff(array_filter($d['slots']),$ids));$activity=[];}
   $v=$t;$v['entries']=$entries;$v['draws']=(object)array_map(static function($d){$d['results']=(object)$d['results'];return $d;},$draws);$v['activity']=$activity;
   $v['community']=$community;$v['trusted']=self::trusted($db,$t);$v['selfEntry']=($t['selfEntry']??false)===true;$v['rev']=(int)($t['rev']??0);
   if($manager){$v['hidden']=$hidden;$v['hideReason']=$t['hideReason']??null;}else unset($v['hideReason'],$v['createdAt']);
   if($admin){$v['hiddenBy']=$t['hiddenBy']??null;$v['hiddenFrom']=$t['hiddenFrom']??null;}else unset($v['hiddenBy'],$v['hiddenFrom']);
   if(!$manager&&($community||$role==='member'))unset($v['createdBy']);
   $out['tournaments'][]=$v;
  }
  foreach($db['profiles'] as $a){
   if(!self::profileVisible($db,$u,$a))continue;
   $owner=($a['ownerId']??null)!==null&&$a['ownerId']===$u['id'];$v=$a;$v['staff']=self::staffProfile($db,$a);
   if(!$admin&&!$owner)unset($v['ownerId']);
   if(!$admin&&!$owner&&($a['createdBy']??null)!==$u['id'])unset($v['relation'],$v['guardianDeclaredAt'],$v['guardianConsentAt'],$v['consentBy'],$v['pendingClubName']);
   $out['profiles'][]=$v;$used[$a['clubId']??'']=true;
  }
  foreach($db['clubs'] as $c){
   if($admin){$out['clubs'][]=$c;continue;}
   if($role==='club'?$c['id']!==$u['clubId']:!((($c['verified']??true)!==false&&($c['mergedInto']??null)===null)||isset($used[$c['id']])))continue;
   unset($c['createdBy'],$c['createdAt']);$out['clubs'][]=$c;
  }
  if($admin)$out['users']=array_values(array_map([self::class,'safeUser'],array_filter($db['users'],fn($x)=>in_array($x['role']??null,self::STAFF,true))));
  return $out;
 }
 // Revisions (§5.8).
 private static function revOf(array $rows,mixed $id):int{if(!is_string($id))return 0;foreach($rows as $x)if($x['id']===$id)return (int)($x['rev']??0);return 0;}
 /**
  * Whether a command at the client's $expected revision is stale: only when the objects it touches changed later. A new
  * tournament or profile is also stale when the actor's own tournaments (profiles) changed after $expected, so a second
  * tab or a repeated click does not create a duplicate (tests/http.test.mjs: two creations at one revision → 200, 409).
  */
 public static function stale(array $db,string $type,array $p,int $expected,?string $actorId=null):bool {
  $rev=(int)$db['revision'];if($expected===$rev)return false;if($expected>$rev)return true;
  $tour=fn($id)=>self::revOf($db['tournaments'],$id)>$expected;$prof=fn($id)=>self::revOf($db['profiles'],$id)>$expected;$staff=(int)($db['staffRev']??0)>$expected;
  $own=function(string $k)use($db,$actorId,$expected):bool{if($actorId===null)return false;foreach($db[$k] as $x)if(($x['createdBy']??null)===$actorId&&($x['ownerId']??null)===null&&(int)($x['rev']??0)>$expected)return true;return false;};
  $reg=is_array($p['registration']??null)?($p['registration']['tournamentId']??null):null;
  return match(true){
   $type==='entry.save'=>$tour($p['tournamentId']??null)||$prof($p['profileId']??null),
   in_array($type,self::TOURNAMENT_SCOPE,true)=>$tour($p['tournamentId']??null),
   $type==='tournament.save'=>isset($p['id'])?$tour($p['id']):$staff||$own('tournaments'),
   $type==='profile.save'=>(isset($p['id'])?$prof($p['id']):$staff||$own('profiles'))||$tour($reg),
   $type==='profile.archive'||$type==='profile.forget'=>$prof($p['id']??null),
   str_starts_with($type,'account.')||str_starts_with($type,'club.')=>$staff,
   default=>true,
  };
 }
 private static function canon(mixed $v):mixed{if(is_float($v)&&is_finite($v)&&floor($v)===$v&&abs($v)<9.0E15)return (int)$v;if(!is_array($v))return $v;$o=[];foreach($v as $k=>$x)$o[$k]=self::canon($x);if(!array_is_list($o))ksort($o,SORT_STRING);return $o;}
 private static function same(mixed $a,mixed $b):bool{return $a===$b||self::canon($a)===self::canon($b);}
 /** Stamps changed tournaments and profiles with R=revision+1, staffRev on a change of staff accounts or existing clubs; sets revision=R ($always, or when something changed). */
 private static function stamp(array $before,array &$db,bool $always=true):bool {
  $R=(int)$db['revision']+1;$changed=false;
  foreach(['tournaments','profiles'] as $k){$old=self::byId($before[$k]);if(count($old)!==count($db[$k]))$changed=true;foreach($db[$k] as $i=>$x){$o=$old[$x['id']]??null;if($o!==null&&self::same($o,$x))continue;$db[$k][$i]['rev']=$R;$changed=true;}}
  $staff=fn(array $d)=>array_values(array_filter($d['users'],fn($u)=>in_array($u['role']??null,self::STAFF,true)));$clubs=self::byId($before['clubs']);$staffChanged=!self::same($staff($before),$staff($db));
  foreach($db['clubs'] as $c)if(isset($clubs[$c['id']])&&!self::same($clubs[$c['id']],$c))$staffChanged=true;
  if($staffChanged)$db['staffRev']=$R;$changed=$changed||$staffChanged||count($clubs)!==count($db['clubs'])||($db['withdrawals']??[])!==($before['withdrawals']??[]);
  if($changed||$always)$db['revision']=$R;return $changed;
 }
 /** A log line; $profileId marks a line naming an athlete (NAMED), so forgetProfile() finds it by the profile and never by the name text. publicData() shows text and time only. */
 private static function audit(array &$t,string $message,?string $profileId=null):void{array_unshift($t['activity'],['text'=>$message,'time'=>gmdate('c')]+($profileId===null?[]:['profileId'=>$profileId]));$t['activity']=array_slice($t['activity'],0,40);}
 private static function reconcile(array &$t,array $entries):void{$cats=Rules::categories($entries);foreach($t['draws'] as $key=>$d){$c=$cats[$key]??null;if(!$c||count($c['athletes'])<3||Rules::signature($c['athletes'])!==$d['signature']){if(count($d['results']))throw new AppError('Ta zmiana narusza kategorię z wynikami. Najpierw wycofaj zależne wyniki.',409);unset($t['draws'][$key]);}}$t['entries']=array_values($entries);}
 public static function password(string $password):string{if(strlen($password)<12||strlen($password)>72)throw new AppError('Hasło musi mieć od 12 do 72 bajtów.');return password_hash($password,defined('PASSWORD_ARGON2ID')?PASSWORD_ARGON2ID:PASSWORD_DEFAULT);}
 public static function execute(array &$db,string $actorId,string $type,array $p,int $revision):array {
  $u=self::entity($db['users'],$actorId,'Konto');if(!$u['active'])throw new AppError('Konto jest zablokowane.',403);
  if(self::stale($db,$type,$p,$revision,$u['id']))throw new AppError('Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409);
  $db['withdrawals']??=[];$before=$db;$result=self::apply($db,$u,$type,$p);self::stamp($before,$db);return $result;
 }
 // Lookups for members: a missing and an unseen object give the same 404 (PS-15).
 private static function &tour(array &$db,array $u,mixed $id,bool $seen=true):array {
  if($u['role']!=='member')return self::entity($db['tournaments'],$id,'Turniej');
  foreach($db['tournaments'] as &$t)if($t['id']===$id&&(!$seen||self::sees($db,$u,$t)))return $t;
  throw new AppError('Turniej nie jest dostępny.',404);
 }
 private static function &prof(array &$db,array $u,mixed $id,bool $allowed=false):array {
  if($u['role']!=='member')return self::entity($db['profiles'],$id,'Zawodnik');
  foreach($db['profiles'] as &$a)if($a['id']===$id&&($allowed||self::managesProfile($u,$a,$db)))return $a;
  throw new AppError('Zawodnik nie istnieje.',404);
 }
 private static function clubChoice(array $p):array{if(is_array($p['club']??null))return $p['club'];if(!empty($p['clubName'])&&empty($p['clubId']))return ['name'=>$p['clubName']];return ['id'=>$p['clubId']??null];}
 private static function events(array $p,array $default=[]):array{return is_array($p['events']??null)?array_values(array_unique($p['events'])):$default;}
 private static function within(array $rows,int $now,callable $match):array{$at=[];foreach($rows as $x){$c=$x['createdAt']??null;if(is_numeric($c)&&(int)$c>$now-86400&&$match($x))$at[]=(int)$c;}return $at;}
 private static function pending(array $db,string $profileId):bool{foreach($db['tournaments'] as $t)if(in_array($t['status'],['open','closed'],true))foreach($t['entries'] as $e)if($e['profileId']===$profileId)return true;return false;}
 private static function inDraw(array $t,string $entryId):bool{foreach($t['draws'] as $d)if(in_array($entryId,$d['slots'],true))return true;return false;}
 private static function unWithdraw(array &$db,string $profileId,string $tournamentId):void{$db['withdrawals']=array_values(array_filter($db['withdrawals']??[],fn($w)=>!($w['profileId']===$profileId&&$w['tournamentId']===$tournamentId)));}
 private static function withdrawn(array &$db,array $e,string $tournamentId,string $by):void{$db['withdrawals'][]=['profileId'=>$e['profileId'],'tournamentId'=>$tournamentId,'by'=>$by,'at'=>time()];}
 /** Snapshot of profile $a for tournament $t (§7.2): the same function for staff, organizer and self entries. */
 private static function snapshot(array $db,array $a,array $t,array $p,?array $old,bool $self=false):array {
  $club=self::entity($db['clubs'],$a['clubId'],'Klub');
  $e=['id'=>$a['id'],'profileId'=>$a['id'],'clubId'=>$a['clubId'],'name'=>$a['name'],'club'=>$club['name'],'sex'=>$a['sex'],'age'=>$a['birthDate']?self::ageAt($a['birthDate'],$t['date']):self::number($p['age']??null,7,100,true),'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true),'events'=>self::events($p),'champion'=>!$self&&(bool)($p['champion']??false),'presence'=>$old['presence']??'pending','actualWeight'=>$old['actualWeight']??null];
  if($self)$e['self']=true;return $e;
 }
 /**
  * Athlete fields of athlete.save and the sign-up (§6.1, R19), without the database: relation, name (Text::clean), birth
  * date (required, 1900-01-01…today), sex, weight, height, grade (Rules::validate), club {id}|{name}|{none:true}. A 'self'
  * profile under MINOR_SELF_AGE is refused with a message that suggests no way around it (UX-1).
  */
 public static function athleteFields(array $p,string $today):array {
  $relation=$p['relation']??null;if(!in_array($relation,['self','guardian'],true))throw new AppError('Wybierz, kogo zgłaszasz.');
  $name=self::txt(Text::clean($p['name']??null),'imię i nazwisko');
  if(empty($p['birthDate']))throw new AppError('Podaj datę urodzenia.');$birth=self::date($p['birthDate']);if($birth<'1900-01-01'||$birth>$today)throw new AppError('Sprawdź datę urodzenia.');
  $f=['name'=>$name,'birthDate'=>$birth,'sex'=>$p['sex']??null,'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true)];
  Rules::validate($f+['age'=>25,'club'=>'Klub','events'=>['forms']]);
  $c=$p['club']??null;
  if(is_array($c)&&($c['none']??null)===true)$f['club']=['none'=>true];elseif(is_array($c)&&is_string($c['id']??null))$f['club']=['id'=>$c['id']];elseif(is_array($c)&&is_string($c['name']??null))$f['club']=['name'=>$c['name']];
  else throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');
  if($relation==='self'&&self::ageAt($birth,$today)<self::MINOR_SELF_AGE)throw new AppError('Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
  $f['relation']=$relation;return $f;
 }
 /** Organizer limits of tournament.save (§5.4), counted on $db under the workspace lock. */
 private static function organizerLimits(array $db,array $u,?array $old,string $status,string $date):void {
  $now=time();$today=date('Y-m-d');$trusted=self::trustedOrganizer($db,$u['id']);
  if($status==='finished'&&$date>$today)throw new AppError('Turniej można zakończyć najwcześniej w dniu zawodów.');
  if(($db['flags']['organizers']??'on')==='paused'&&!$trusted&&$status!=='draft'&&(!$old||$old['status']==='draft'))throw new AppError('Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.',409);
  if(!$old){
   $mine=self::within($db['tournaments'],$now,fn($t)=>$t['createdBy']===$u['id']);
   if(count($mine)>=self::ORGANIZER_DAY)throw new ApiError('Limit nowych turniejów: 3 na dobę.',429,['retry'=>max(1,min($mine)+86400-$now)]);
   $all=self::within($db['tournaments'],$now,fn($t)=>self::community($db,$t)&&!self::trustedOrganizer($db,$t['createdBy']));
   if(!$trusted&&count($all)>=self::COMMUNITY_DAY_GLOBAL)throw new ApiError('Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.',429,['retry'=>max(1,min($all)+86400-$now)]);
  }
  if($status!=='draft'&&$date>=$today){
   $n=0;foreach($db['tournaments'] as $t)if($t['createdBy']===$u['id']&&$t['id']!==($old['id']??null)&&$t['status']!=='draft'&&$t['date']>=$today&&($t['hiddenBy']??null)===null)$n++;
   if($n>=self::ORGANIZER_ACTIVE)throw new AppError('Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.',429);
  }
 }
 // Removal and retention of personal data (§6.6–§6.7).
 /** The entry leaves its tournament, unless the tournament is finished, closed with a saved draw in one of the entry's categories, or reconcile refuses (results). */
 public static function detach(array &$t,string $entryId):bool {
  $e=null;foreach($t['entries'] as $x)if($x['id']===$entryId)$e=$x;if(!$e)return false;
  $status=($t['hiddenBy']??null)!==null?($t['hiddenFrom']??$t['status']):$t['status'];if($status==='finished')return false;
  if($status==='closed')foreach(Rules::categories($t['entries']) as $key=>$c)if(isset($t['draws'][$key])&&in_array($entryId,array_column($c['athletes'],'id'),true))return false;
  $next=$t;try{self::reconcile($next,array_filter($t['entries'],fn($x)=>$x['id']!==$entryId));}catch(AppError){return false;}
  $t=$next;self::audit($t,'Wycofano zgłoszenie: '.GuestView::initials((string)$e['name']),$e['profileId']);return true;
 }
 /**
  * Forgets profile $id: every entry is detached; without remaining entries the profile leaves $db (persist() deletes the
  * row), otherwise it is anonymized. Tournament logs never keep its name: every line marked with its id gets initials in
  * every tournament, whatever name it carries (also one from before a rename or of an entry withdrawn earlier). Lines
  * without a mark (written before 0007) are matched by a name the profile has (the current one and those of its
  * snapshots) only in tournaments where it has an entry or that the actor $u manages (the Administrator: all), never in
  * other tenants' tournaments, and not when an entry of another profile there carries that name. $initials
  * (profile.forget, athlete.forget) also turns the name in the remaining snapshots into initials; otherwise they keep it
  * as results history (O7). Returns 'deleted', 'anonymized' or 'missing'.
  */
 public static function forgetProfile(array &$db,string $id,bool $initials=false,?array $u=null):string {
  $i=null;foreach($db['profiles'] as $k=>$a)if($a['id']===$id)$i=$k;if($i===null)return 'missing';
  $names=[(string)($db['profiles'][$i]['name']??'')];foreach($db['tournaments'] as $t)foreach($t['entries'] as $e)if($e['profileId']===$id)$names[]=(string)$e['name'];
  $names=array_values(array_diff(array_unique($names),['',self::DELETED]));$left=false;
  foreach($db['tournaments'] as $k=>$t){
   $has=in_array($id,array_column($t['entries'],'profileId'),true);if($has&&!self::detach($t,$id))$left=true;
   if($initials)foreach($t['entries'] as $j=>$e)if($e['profileId']===$id)$t['entries'][$j]['name']=GuestView::initials((string)$e['name']);
   self::unname($t,$id,$names,$has||$u!==null&&self::manages($u,$t));$db['tournaments'][$k]=$t;
  }
  if(!$left){array_splice($db['profiles'],$i,1);return 'deleted';}
  $db['profiles'][$i]=array_replace($db['profiles'][$i],['name'=>self::DELETED,'birthDate'=>null,'ownerId'=>null,'relation'=>null,'guardianDeclaredAt'=>null,'guardianConsentAt'=>null,'consentBy'=>null,'pendingClubName'=>null,'archived'=>true]);
  return 'anonymized';
 }
 /** Log lines of $t marked with $id get initials; unmarked ones ($legacy) when they end with ': '.<one of $names> and no entry of another profile carries that name (a namesake). */
 private static function unname(array &$t,string $id,array $names,bool $legacy):void {
  $kept=[];foreach($t['entries'] as $e)if($e['profileId']!==$id)$kept[(string)$e['name']]=true;
  foreach($t['activity'] as $j=>$x){
   $s=(string)$x['text'];$mark=$x['profileId']??null;
   if($mark===$id){if(preg_match(self::NAMED,$s,$m))$t['activity'][$j]['text']=$m[1].GuestView::initials($m[2]);continue;}
   if($mark===null&&$legacy)foreach($names as $n)if(!isset($kept[$n])&&str_ends_with($s,': '.$n)){$t['activity'][$j]['text']=substr($s,0,-strlen($n)).GuestView::initials($n);break;}
  }
 }
 /** Account deletion (§6.6, PHP only, idempotent): owned profiles forgotten; as organizer, upcoming tournaments hidden by 'system' (self-entries of others detached, tombstone 'system') and created profiles forgotten. */
 public static function forgetMember(array &$db,string $userId):array {
  $db['withdrawals']??=[];$before=$db;$today=date('Y-m-d');$out=['profiles'=>0,'tournaments'=>0];
  foreach($db['profiles'] as $a)if(($a['ownerId']??null)===$userId&&self::forgetProfile($db,$a['id'])!=='missing')$out['profiles']++;
  foreach($db['tournaments'] as $k=>$t){
   if($t['createdBy']!==$userId||$t['date']<$today||($t['hiddenBy']??null)!==null)continue;
   foreach($t['entries'] as $e)if(!empty($e['self'])&&self::detach($t,$e['id']))self::withdrawn($db,$e,$t['id'],'system');
   $t['hiddenFrom']=$t['status'];$t['status']='draft';$t['hiddenBy']='system';self::audit($t,'Konto organizatora zostało usunięte.');$db['tournaments'][$k]=$t;$out['tournaments']++;
  }
  foreach($db['profiles'] as $a)if(($a['ownerId']??null)===null&&($a['createdBy']??null)===$userId&&($a['name']??null)!==self::DELETED&&self::forgetProfile($db,$a['id'])!=='missing')$out['profiles']++;
  self::stamp($before,$db,false);return $out;
 }
 /**
  * Retention of community data (§6.7, PHP only): organizers' profiles idle since $cutoff are forgotten (at most $limit),
  * names in snapshots and log lines of community tournaments before $cutoff become initials (also of entries withdrawn
  * long ago), old tombstones are purged. Returns counts only.
  */
 public static function retain(array &$db,string $cutoff,int $limit=200):array {
  $db['withdrawals']??=[];$before=$db;$last=[];$n=0;$s=0;$l=0;
  foreach($db['tournaments'] as $t)foreach($t['entries'] as $e)$last[$e['profileId']]=max($last[$e['profileId']]??'',$t['date']);
  foreach($db['profiles'] as $a){
   if($n>=$limit)break;if(($a['ownerId']??null)!==null||self::staffProfile($db,['ownerId'=>null,'createdBy'=>$a['createdBy']??null])||($a['name']??null)===self::DELETED)continue;
   $ref=$last[$a['id']]??(is_numeric($a['createdAt']??null)?date('Y-m-d',(int)$a['createdAt']):null);
   if($ref!==null&&$ref<$cutoff&&self::forgetProfile($db,$a['id'])!=='missing')$n++;
  }
  foreach($db['tournaments'] as $k=>$t){
   if($t['date']>=$cutoff||!self::community($db,$t))continue;
   foreach($t['entries'] as $j=>$e){$x=GuestView::initials((string)$e['name']);if($x!==$e['name']){$db['tournaments'][$k]['entries'][$j]['name']=$x;$s++;}}
   foreach($t['activity'] as $j=>$a)if(preg_match(self::NAMED,(string)$a['text'],$m)&&($x=$m[1].GuestView::initials($m[2]))!==$a['text']){$db['tournaments'][$k]['activity'][$j]['text']=$x;$l++;}
  }
  $db['withdrawalsPurge']=date('Y-m-d',strtotime('-30 days'));self::stamp($before,$db,false);
  return ['profiles'=>$n,'snapshots'=>$s,'logs'=>$l];
 }
 private static function apply(array &$db,array $u,string $type,array $p):array {
  $now=time();$today=date('Y-m-d');$member=$u['role']==='member';$admin=$u['role']==='admin';
  if($type==='account.password'){
   if($member)throw new AppError('Brak uprawnień.',403);
   if(($p['id']??null)!==$u['id']&&$u['role']!=='admin')throw new AppError('Brak uprawnień.',403);
   if(($p['id']??null)===$u['id']&&!password_verify((string)($p['currentPassword']??''),$u['passwordHash']))throw new AppError('Nieprawidłowe obecne hasło.');
   $a=&self::entity($db['users'],$p['id']??null,'Konto');$a['passwordHash']=self::password(is_string($p['password']??null)?$p['password']:'');$a['authVersion']++;return ['id'=>$a['id']];
  }
  if($type==='account.save'){
   if($u['role']!=='admin')throw new AppError('Tylko Administrator zarządza kontami.',403);
   $old=isset($p['id'])?self::entity($db['users'],$p['id'],'Konto'):null;$email=mb_strtolower(self::txt($p['email']??null,'e-mail',254));if(!filter_var($email,FILTER_VALIDATE_EMAIL))throw new AppError('Podaj poprawny e-mail.');
   foreach($db['users'] as $a)if($a['id']!==($old['id']??null)&&mb_strtolower($a['email'])===$email)throw new AppError('Konto z tym adresem e-mail już istnieje.',409);
   if(!in_array($p['role']??null,['admin','editor','club'],true))throw new AppError('Wybierz poprawną rolę.');$active=($p['active']??true)!==false;
   if($old&&$old['role']==='admin'&&$old['active']&&($p['role']!=='admin'||!$active)&&!count(array_filter($db['users'],fn($x)=>$x['id']!==$old['id']&&$x['role']==='admin'&&$x['active'])))throw new AppError('Musi pozostać aktywny Administrator.',409);
   $club=null;foreach($db['clubs'] as $c)if($c['id']===($p['clubId']??''))$club=$c;
   if($club&&($club['id']===Clubs::UNAFFILIATED||($club['mergedInto']??null)!==null))throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');
   if(!$club&&!empty($p['clubName'])){$r=Clubs::pick($db['clubs'],$u,['name'=>$p['clubName']],$now);if($r['clubId']===Clubs::UNAFFILIATED)throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');if(isset($r['newClub']))$db['clubs'][]=$r['newClub'];$club=['id'=>$r['clubId']];}
   if(!$club)throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');
   $a=$old??['id'=>self::id(),'authVersion'=>1];$a=array_replace($a,['email'=>$email,'clubId'=>$club['id'],'role'=>$p['role'],'active'=>$active]);
   if($old&&($old['role']!==$a['role']||$old['clubId']!==$a['clubId']||$old['active']!==$a['active']||$old['email']!==$email))$a['authVersion']++;
   if(!empty($p['password'])){$a['passwordHash']=self::password((string)$p['password']);$a['authVersion']++;}elseif(!$old)throw new AppError('Podaj hasło nowego konta.');
   if($old){$target=&self::entity($db['users'],$old['id'],'Konto');$target=$a;}else $db['users'][]=$a;return ['id'=>$a['id']];
  }
  if($type==='tournament.save'){
   if(!self::canCreateTournament($u))throw new AppError('Nie możesz tworzyć turniejów.',403);$old=isset($p['id'])?self::tour($db,$u,$p['id']):null;
   if($old&&!self::manages($u,$old))throw new AppError('Możesz edytować tylko własne turnieje.',403);$date=self::date($p['date']??null);
   if(!in_array($p['status']??null,['draft','open','closed','finished'],true))throw new AppError('Niepoprawny status turnieju.');
   if($old&&count($old['entries'])&&$date!==$old['date'])throw new AppError('Data turnieju ze zgłoszeniami jest zablokowana.',409);
   $name=self::txt(Text::clean($p['name']??null),'nazwa turnieju');$city=self::txt(Text::clean($p['city']??null),'miasto');$mat=self::txt(Text::clean($p['mat']??'Mata 1'),'mata',50);$status=$p['status'];
   if($member)foreach([$name,$city,$mat] as $s)if(self::contact($s))throw new AppError('Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.');
   if($old&&($old['hiddenBy']??null)!==null&&$status!=='draft')throw new AppError('Turniej ukrył Administrator. Status może zmienić tylko Administrator.',409);
   if(self::organizer($u))self::organizerLimits($db,$u,$old,$status,$date);
   $selfEntry=array_key_exists('selfEntry',$p)?$p['selfEntry']===true:($old?($old['selfEntry']??false)===true:self::organizer($u));
   $t=array_replace($old??['id'=>self::id(),'createdBy'=>$u['id'],'createdAt'=>$now,'entries'=>[],'draws'=>[],'activity'=>[]],['name'=>$name,'city'=>$city,'date'=>$date,'mat'=>$mat,'status'=>$status,'selfEntry'=>$selfEntry]);self::audit($t,$old?'Zaktualizowano ustawienia turnieju.':'Utworzono turniej.');
   if($old){$target=&self::entity($db['tournaments'],$old['id'],'Turniej');$target=$t;}else $db['tournaments'][]=$t;return ['id'=>$t['id']];
  }
  if($type==='profile.save'){
   $old=isset($p['id'])?self::prof($db,$u,$p['id']):null;
   if(!$old&&$member&&!self::organizer($u))throw new AppError('Brak uprawnień.',403);
   if($old&&(!self::managesProfile($u,$old,$db)||($old['ownerId']??null)!==null&&!$admin))throw new AppError('Nie możesz edytować tej kartoteki.',403);
   $pick=null;$choice=[];if($u['role']==='club'){$clubId=$u['clubId'];self::entity($db['clubs'],$clubId,'Klub');}
   else{$choice=self::clubChoice($p);$pick=Clubs::pick($db['clubs'],$u,$choice,$now,$member?Clubs::counts($db['clubs'],$u,$now):[]);$clubId=$pick['clubId'];}
   if($old&&$old['clubId']!==$clubId&&!$admin)throw new AppError('Klub może zmienić Administrator.',403);
   $birth=!empty($p['birthDate'])?self::date($p['birthDate']):null;if(!$birth&&!isset($old['legacyAge']))throw new AppError('Podaj datę urodzenia.');if($birth&&($birth<'1900-01-01'||$birth>$today))throw new AppError('Sprawdź datę urodzenia.');
   if($member&&!$old){$made=self::within($db['profiles'],$now,fn($a)=>($a['createdBy']??null)===$u['id']&&($a['ownerId']??null)===null);if(count($made)>=self::ORGANIZER_PROFILES_DAY)throw new ApiError('Limit nowych zawodników na dziś został osiągnięty.',429,['retry'=>max(1,min($made)+86400-$now)]);}
   $a=array_replace($old??['id'=>self::id(),'createdBy'=>$u['id'],'createdAt'=>$now,'archived'=>false,'ownerId'=>null],['name'=>self::txt(Text::clean($p['name']??null),'imię i nazwisko'),'clubId'=>$clubId,'birthDate'=>$birth,'sex'=>$p['sex']??null,'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true),'events'=>self::events($p,['forms']),'champion'=>(bool)($p['champion']??false)]);
   Rules::validate(array_replace($a,['age'=>25,'club'=>'Klub','events'=>['forms']]));if(!count($a['events']))throw new AppError('Wybierz konkurencję.');foreach($a['events'] as $e)if(!is_string($e)||!isset(Rules::EVENTS[$e]))throw new AppError('Nieznana konkurencja.');
   // Minors added by an organizer need the guardian's consent (§5.3); staff unchanged.
   if($member&&$birth&&self::ageAt($birth,$today)<self::MINOR_SELF_AGE){if(($p['guardianConsent']??null)!==true)throw new AppError('Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.');$a['guardianConsentAt']=$now;$a['consentBy']=$u['id'];}
   $pending=$pick['pendingClubName']??($clubId===Clubs::UNAFFILIATED&&($choice['id']??null)===Clubs::UNAFFILIATED?($old['pendingClubName']??null):null);
   if($pending!==null)$a['pendingClubName']=$pending;else unset($a['pendingClubName']);
   if(isset($pick['newClub']))$db['clubs'][]=$pick['newClub'];
   if($old){$target=&self::entity($db['profiles'],$old['id'],'Zawodnik');$target=$a;unset($target);}else $db['profiles'][]=$a;
   if(isset($p['registration']))self::apply($db,$u,'entry.save',array_replace($p['registration'],['profileId'=>$a['id']]));
   return ['id'=>$a['id']]+(isset($pick['notice'])?['notice'=>$pick['notice']]:[]);
  }
  if($type==='profile.archive'){$a=&self::prof($db,$u,$p['id']??null);if(!self::managesProfile($u,$a,$db)||($a['ownerId']??null)!==null&&!$admin)throw new AppError('Brak uprawnień.',403);$a['archived']=(bool)($p['archived']??false);return ['id'=>$a['id']];}
  if($type==='profile.forget'){
   $a=self::prof($db,$u,$p['id']??null);
   if(!$admin){
    if(!self::managesProfile($u,$a,$db)||($a['ownerId']??null)!==null||($a['createdBy']??null)!==$u['id'])throw new AppError('Brak uprawnień.',403);
    foreach($db['tournaments'] as $t)if($t['status']==='finished'&&in_array($a['id'],array_column($t['entries'],'profileId'),true))throw new AppError('Zawodnik ma zgłoszenia w zakończonych turniejach. Usunięcie danych może zlecić Administrator.',409);
   }
   return ['id'=>$a['id'],'state'=>self::forgetProfile($db,$a['id'],true,$u)];
  }
  // Own athlete profiles of a member (§6.1, §4.5, §6.6).
  if(in_array($type,['athlete.save','athlete.archive','athlete.forget','entry.self'],true)&&!$member)throw new AppError('Brak uprawnień.',403);
  $owned=fn($id)=>is_string($id)?array_values(array_filter($db['profiles'],fn($a)=>$a['id']===$id&&($a['ownerId']??null)===$u['id']))[0]??null:null;
  if($type==='athlete.save'){
   $f=self::athleteFields($p,$today);$old=null;
   if(isset($p['id'])){$old=$owned($p['id']);if(!$old)throw new AppError('Zawodnik nie istnieje.',404);}
   $mine=array_filter($db['profiles'],fn($a)=>($a['ownerId']??null)===$u['id']);
   if(!$old&&count($mine)>=self::ATHLETES_PER_ACCOUNT)throw new AppError('Na jednym koncie może być najwyżej 5 zawodników.',409);
   if($f['relation']==='self')foreach($mine as $a)if($a['id']!==($old['id']??null)&&($a['relation']??null)==='self')throw new AppError('Na koncie jest już Twój własny profil zawodnika.',409);
   $pick=Clubs::pick($db['clubs'],$u,$f['club'],$now,Clubs::counts($db['clubs'],$u,$now));
   if($old&&($pick['clubId']!==$old['clubId']||$f['birthDate']!==($old['birthDate']??null)||$f['sex']!==($old['sex']??null))&&self::pending($db,$old['id']))throw new AppError('Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.',409);
   $a=array_replace($old??['id'=>self::id(),'ownerId'=>$u['id'],'createdBy'=>$u['id'],'createdAt'=>$now],['archived'=>false,'name'=>$f['name'],'clubId'=>$pick['clubId'],'birthDate'=>$f['birthDate'],'sex'=>$f['sex'],'weight'=>$f['weight'],'height'=>$f['height'],'gradeType'=>$f['gradeType'],'grade'=>$f['grade'],'events'=>['forms'],'champion'=>false,'relation'=>$f['relation']]);
   $pending=$pick['pendingClubName']??($pick['clubId']===Clubs::UNAFFILIATED&&($f['club']['id']??null)===Clubs::UNAFFILIATED?($old['pendingClubName']??null):null);
   if($pending!==null)$a['pendingClubName']=$pending;else unset($a['pendingClubName']);
   if($f['relation']==='guardian')$a['guardianDeclaredAt']=($old['relation']??null)==='guardian'&&isset($old['guardianDeclaredAt'])?$old['guardianDeclaredAt']:$now;else unset($a['guardianDeclaredAt']);
   if(isset($pick['newClub']))$db['clubs'][]=$pick['newClub'];
   if($old){$target=&self::entity($db['profiles'],$old['id'],'Zawodnik');$target=$a;unset($target);}else $db['profiles'][]=$a;
   return ['id'=>$a['id']]+(isset($pick['notice'])?['notice'=>$pick['notice']]:[]);
  }
  if($type==='athlete.archive'){
   $old=$owned($p['profileId']??null);if(!$old)throw new AppError('Zawodnik nie istnieje.',404);$archived=($p['archived']??true)!==false;
   if($archived&&self::pending($db,$old['id']))throw new AppError('Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.',409);
   $a=&self::entity($db['profiles'],$old['id'],'Zawodnik');$a['archived']=$archived;return ['id'=>$a['id']];
  }
  if($type==='athlete.forget'){$old=$owned($p['profileId']??null);if(!$old)throw new AppError('Zawodnik nie istnieje.',404);return ['id'=>$old['id'],'state'=>self::forgetProfile($db,$old['id'],true,$u)];}
  if($type==='entry.self')return self::selfEntry($db,$u,$p,$owned);
  // Clubs (§5.5): the Administrator only.
  if(str_starts_with($type,'club.')){
   if(!$admin)throw new AppError('Brak uprawnień.',403);
   if($type==='club.adopt'){
    $ids=$p['profileIds']??null;if(!is_array($ids)||!$ids||count($ids)>500)throw new AppError('Wybierz zawodników.');
    $r=Clubs::pick($db['clubs'],$u,['name'=>$p['name']??null],$now);if($r['clubId']===Clubs::UNAFFILIATED)throw new AppError('Sprawdź pole: nazwa klubu.');
    foreach(array_unique($ids) as $id){$a=&self::entity($db['profiles'],$id,'Zawodnik');$a['clubId']=$r['clubId'];unset($a['pendingClubName'],$a);}
    if(isset($r['newClub']))$db['clubs'][]=$r['newClub'];return ['id'=>$r['clubId']];
   }
   $c=self::entity($db['clubs'],$p['id']??null,'Klub');if($c['id']===Clubs::UNAFFILIATED||($c['mergedInto']??null)!==null)throw new AppError('Tego klubu nie można zmienić.',409);
   if($type==='club.save'){
    $next=$c;
    if(array_key_exists('name',$p)){$name=self::txt(Text::clean($p['name']),'nazwa klubu');$key=Clubs::key($name);if(mb_strlen($key)<2||!preg_match('/\p{L}/u',$name))throw new AppError('Sprawdź pole: nazwa klubu.');foreach($db['clubs'] as $x)if($x['id']!==$c['id']&&Clubs::key($x['name'])===$key)throw new AppError('Klub o takiej nazwie już istnieje. Użyj scalania.',409);$next['name']=$name;}
    if(array_key_exists('verified',$p))$next['verified']=$p['verified']===true;
    $target=&self::entity($db['clubs'],$c['id'],'Klub');$target=$next;return ['id'=>$c['id']];
   }
   if($type==='club.merge'){
    $into=self::entity($db['clubs'],$p['into']??null,'Klub');if($into['id']===$c['id']||($into['mergedInto']??null)!==null)throw new AppError('Tego klubu nie można zmienić.',409);
    // 'unaffiliated' may absorb a club of athletes (e.g. a member's "no club" entry), never staff accounts: account.save refuses it and a club account there would see every unaffiliated staff profile.
    if($into['id']===Clubs::UNAFFILIATED)foreach($db['users'] as $x)if(in_array($x['role']??null,self::STAFF,true)&&($x['clubId']??null)===$c['id'])throw new AppError('Ten klub ma konta personelu. Przypisz je do innego klubu przed scaleniem z „Niezrzeszony”.',409);
    foreach($db['profiles'] as &$a)if($a['clubId']===$c['id'])$a['clubId']=$into['id'];unset($a);
    foreach($db['users'] as &$x)if(in_array($x['role'],self::STAFF,true)&&$x['clubId']===$c['id']){$x['clubId']=$into['id'];$x['authVersion']++;}unset($x);
    foreach($db['clubs'] as &$x)if($x['id']===$c['id']||($x['mergedInto']??null)===$c['id'])$x['mergedInto']=$into['id'];unset($x);
    return ['id'=>$into['id']];
   }
  }
  if($type==='entry.remove')return self::removeEntry($db,$u,$p);
  $t=&self::tour($db,$u,$p['tournamentId']??null);
  if($type==='tournament.hide'){
   if(!$admin)throw new AppError('Brak uprawnień.',403);$hidden=($t['hiddenBy']??null)!==null;
   if(($p['hidden']??null)===true){
    $reason=Text::clean($p['reason']??'');if($reason===null||mb_strlen($reason)>200)throw new AppError('Sprawdź pole: powód.');
    if(($p['withdrawSelf']??null)===true)foreach($t['entries'] as $e)if(!empty($e['self'])&&self::detach($t,$e['id']))self::withdrawn($db,$e,$t['id'],'admin');
    if(!$hidden){$t['hiddenFrom']=$t['status'];$t['status']='draft';$t['hiddenBy']=$u['id'];self::audit($t,'Administrator ukrył turniej.');}
    $t['hideReason']=$reason===''?null:$reason;return ['id'=>$t['id']];
   }
   if($hidden){$t['status']=in_array($t['hiddenFrom']??null,['draft','open','closed','finished'],true)?$t['hiddenFrom']:'draft';$t['hiddenBy']=null;$t['hiddenFrom']=null;$t['hideReason']=null;self::audit($t,'Administrator przywrócił turniej.');}
   return ['id'=>$t['id']];
  }
  if($type==='entry.save'){
   if(!self::canEnter($u,$t,$db))throw new AppError('Zapisy do tego turnieju są zamknięte.',403);
   $manager=self::manages($u,$t);$old=null;foreach($t['entries'] as $e)if($e['profileId']===($p['profileId']??null))$old=$e;
   $a=self::prof($db,$u,$p['profileId']??null,$old!==null&&$manager);if($a['archived'])throw new AppError('Zawodnik jest zarchiwizowany.');
   if($u['role']==='club'&&($a['clubId']!==$u['clubId']||!self::staffProfile($db,$a)))throw new AppError('Możesz zgłaszać tylko własny klub.',403);
   if(!$old&&$u['role']==='editor'&&!(self::community($db,$t)?($a['ownerId']??null)===null&&$a['createdBy']===$u['id']:self::staffProfile($db,$a)))throw new AppError('Nie możesz zgłosić tego zawodnika.',403);
   if($old&&empty($p['update']))throw new AppError('Zawodnik jest już zgłoszony.',409);
   if($old&&!$manager&&$u['role']!=='club'&&$a['createdBy']!==$u['id'])throw new AppError('Nie możesz zmienić tego zgłoszenia.',403);
   if($old)foreach($t['draws'] as $d)if(in_array($old['id'],$d['slots'],true)&&count($d['results']))throw new AppError('Zawodnik ma zapisane wyniki.',409);
   $clubChanged=false;
   if($old&&!empty($old['self'])){
    // A self-entry corrected by the manager keeps its identity; only the club may change (verification at check-in, D3).
    $entry=['id'=>$old['id'],'profileId'=>$old['profileId'],'clubId'=>$old['clubId'],'name'=>$old['name'],'club'=>$old['club'],'sex'=>$old['sex'],'age'=>$old['age'],'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true),'events'=>self::events($p),'champion'=>false,'presence'=>$old['presence']??'pending','actualWeight'=>$old['actualWeight']??null,'self'=>true];
    if(isset($p['clubId'])&&$p['clubId']!==$old['clubId']){$c=null;foreach($db['clubs'] as $x)if($x['id']===$p['clubId']&&($x['mergedInto']??null)===null)$c=$x;if(!$c)throw new AppError('Klub nie istnieje.',404);$entry['clubId']=$c['id'];$entry['club']=$c['name'];$clubChanged=true;}
   }else $entry=self::snapshot($db,$a,$t,$p,$old);
   Rules::validate($entry);
   $list=$old?array_map(fn($e)=>$e['id']===$entry['id']?$entry:$e,$t['entries']):[...$t['entries'],$entry];self::reconcile($t,$list);
   self::audit($t,$clubChanged?'Zmieniono klub w zgłoszeniu: '.$entry['name']:($old?'Zmieniono zgłoszenie: ':'Zgłoszono: ').$entry['name'],$entry['profileId']);
   if(!$old)self::unWithdraw($db,$entry['profileId'],$t['id']);return ['id'=>$entry['id']];
  }
  if(!self::manages($u,$t))throw new AppError('Brak uprawnień do zarządzania tym turniejem.',403);if($t['status']==='finished')throw new AppError('Zakończony turniej jest tylko do odczytu.',409);
  if($type==='checkin.save'){
   $a=self::entity($t['entries'],$p['id']??null,'Zgłoszenie');$presence=$p['presence']??'';if(!in_array($presence,['present','pending','absent'],true))throw new AppError('Niepoprawny status.');$weight=$presence==='present'?self::number($p['actualWeight']??null,10,250):$a['actualWeight'];
   foreach($t['draws'] as $d)if(in_array($a['id'],$d['slots'],true)&&count($d['results'])&&($a['presence']!==$presence||$a['actualWeight']!=$weight))throw new AppError('Zawodnik ma zapisane wyniki.',409);
   self::reconcile($t,array_map(fn($e)=>$e['id']===$a['id']?array_replace($a,['presence'=>$presence,'actualWeight'=>$weight]):$e,$t['entries']));self::audit($t,'Kontrola startowa: '.$a['name'],$a['profileId']);return ['id'=>$a['id']];
  }
  if($type==='draw.create'){$cats=Rules::categories($t['entries']);$key=(string)($p['categoryId']??'');$c=$cats[$key]??null;if(!$c||$c['type']!=='bracket')throw new AppError('Nie ma takiej kategorii.');$old=$t['draws'][$key]??null;if($old&&count($old['results']))throw new AppError('Nie można losować po zapisaniu wyników.',409);$d=Rules::makeDraw($c['athletes']);$d['revision']=($old['revision']??0)+1;$t['draws'][$key]=$d;self::audit($t,'Zapisano losowanie: '.$c['title'].' · '.$c['subtitle']);return ['id'=>$key];}
  if(in_array($type,['result.save','result.clear'],true)){if($type==='result.save')self::txt($p['winnerId']??null,'zwycięzca');$key=(string)($p['categoryId']??'');if(!isset($t['draws'][$key]))throw new AppError('Najpierw zapisz losowanie.');Rules::result($t['draws'][$key],(string)($p['matchId']??''),$type==='result.save'?(string)($p['winnerId']??''):null);self::audit($t,'Zaktualizowano wynik walki.');return ['id'=>$p['matchId']];}
  throw new AppError('Nieznana operacja.',400);
 }
 /** entry.remove (§5.7): the owner's branch first (open registration, entry outside saved draws, no canEnter), then the rules of staff and organizers; a self-entry removed by someone else leaves a tombstone. */
 private static function removeEntry(array &$db,array $u,array $p):array {
  $t=&self::tour($db,$u,$p['tournamentId']??null,false);$e=null;foreach($t['entries'] as $x)if($x['id']===($p['id']??null))$e=$x;
  $profile=null;if($e)foreach($db['profiles'] as $a)if($a['id']===$e['profileId'])$profile=$a;
  if($e&&$profile&&($profile['ownerId']??null)!==null&&$profile['ownerId']===$u['id']){
   if($t['status']!=='open')throw new AppError('Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.',403);
   if(self::inDraw($t,$e['id']))throw new AppError('Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.',409);
   self::reconcile($t,array_filter($t['entries'],fn($x)=>$x['id']!==$e['id']));self::audit($t,'Wycofano zgłoszenie: '.$e['name'],$e['profileId']);return ['id'=>$e['id']];
  }
  if($u['role']==='member'&&!self::sees($db,$u,$t))throw new AppError('Turniej nie jest dostępny.',404);
  if(!self::canEnter($u,$t,$db))throw new AppError('Zapisy są zamknięte.',403);
  $a=self::entity($t['entries'],$p['id']??null,'Zgłoszenie');$profile=self::entity($db['profiles'],$a['profileId'],'Zawodnik');$manager=self::manages($u,$t);
  if(!$manager&&!($u['role']==='club'?$a['clubId']===$u['clubId']&&self::staffProfile($db,$profile):($profile['ownerId']??null)===null&&$profile['createdBy']===$u['id'])){
   if($u['role']==='member')throw new AppError('Zgłoszenie nie istnieje.',404);throw new AppError('Nie możesz wycofać tego zgłoszenia.',403);
  }
  self::reconcile($t,array_filter($t['entries'],fn($x)=>$x['id']!==$a['id']));self::audit($t,'Wycofano zgłoszenie: '.$a['name'],$a['profileId']);
  if(!empty($a['self']))self::withdrawn($db,$a,$t['id'],$u['role']==='admin'?'admin':'organizer');return ['id'=>$a['id']];
 }
 /** entry.self (§7.1–§7.2): an athlete enters an own profile; never into a category with a saved draw; minors only in trusted tournaments. */
 private static function selfEntry(array &$db,array $u,array $p,callable $owned):array {
  if(!is_string($p['profileId']??null)||$p['profileId']==='')throw new AppError('Najpierw uzupełnij dane zawodnika.',409);
  $a=$owned($p['profileId']);if(!$a)throw new AppError('Zawodnik nie istnieje.',404);if($a['archived'])throw new AppError('Najpierw uzupełnij dane zawodnika.',409);
  $t=null;foreach($db['tournaments'] as $x)if($x['id']===($p['tournamentId']??null)&&$x['status']!=='draft')$t=$x;if(!$t)throw new AppError('Turniej nie jest dostępny.',404);
  if($t['status']!=='open'||($t['selfEntry']??false)!==true||$t['date']<date('Y-m-d'))throw new AppError('Zapisy do tego turnieju są zamknięte.',403);
  $old=null;foreach($t['entries'] as $e)if($e['profileId']===$a['id'])$old=$e;$update=($p['update']??null)===true;
  if($old&&!$update)throw new AppError('Jesteś już zgłoszony do tego turnieju.',409);if(!$old&&$update)throw new AppError('Zgłoszenie nie istnieje.',404);
  if($old&&self::inDraw($t,$old['id']))throw new AppError('Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.',409);
  if(!self::trusted($db,$t)&&(($a['relation']??null)!=='self'||self::ageAt((string)$a['birthDate'],$t['date'])<self::ADULT_AGE))throw new AppError('Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.',409);
  $measures=['weight'=>$p['weight']??$a['weight'],'height'=>$p['height']??$a['height'],'gradeType'=>$p['gradeType']??$a['gradeType'],'grade'=>$p['grade']??$a['grade']];
  if(($p['saveToProfile']??null)===true){
   $f=['weight'=>self::number($measures['weight'],10,250),'height'=>self::number($measures['height'],70,250),'gradeType'=>$measures['gradeType'],'grade'=>self::number($measures['grade'],1,10,true)];
   Rules::validate($f+['name'=>$a['name'],'sex'=>$a['sex'],'age'=>25,'club'=>'Klub','events'=>['forms']]);
   $target=&self::entity($db['profiles'],$a['id'],'Zawodnik');$target=array_replace($target,$f);$a=$target;unset($target);
  }
  $entry=self::snapshot($db,$a,$t,$measures+['events'=>$p['events']??null],$old,true);Rules::validate($entry);
  $list=$old?array_map(fn($e)=>$e['id']===$entry['id']?$entry:$e,$t['entries']):[...$t['entries'],$entry];
  foreach(Rules::categories($list) as $key=>$c)if(isset($t['draws'][$key])&&in_array($entry['id'],array_column($c['athletes'],'id'),true))throw new AppError('Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.',409);
  $target=&self::entity($db['tournaments'],$t['id'],'Turniej');self::reconcile($target,$list);self::audit($target,($old?'Zmieniono zgłoszenie własne: ':'Zgłoszenie własne: ').$entry['name'],$entry['profileId']);unset($target);
  self::unWithdraw($db,$a['id'],$t['id']);return ['id'=>$entry['id'],'tournamentId'=>$t['id']];
 }
}
