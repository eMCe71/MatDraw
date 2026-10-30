<?php
declare(strict_types=1);
namespace MatDraw;
class AppError extends \RuntimeException{public function __construct(string $message,public int $status=422){parent::__construct($message);}}
final class Domain {
 public static function id():string{return bin2hex(random_bytes(16));}
 public static function txt(mixed $v,string $label,int $max=100):string{if(!is_string($v)||trim($v)===''||mb_strlen(trim($v))>$max)throw new AppError('Sprawdź pole: '.$label.'.');return trim($v);}
 public static function number(mixed $v,float $min,float $max,bool $integer=false):int|float{if((!is_int($v)&&!is_float($v)&&!is_string($v))||!is_numeric($v))throw new AppError('Niepoprawna wartość liczbowa.');$n=(float)$v;if(!is_finite($n)||$n<$min||$n>$max||($integer&&floor($n)!==$n))throw new AppError('Wartość liczbowa jest poza zakresem.');return $integer?(int)$n:$n;}
 public static function date(mixed $v):string{if(!is_string($v)||!preg_match('/^\d{4}-\d{2}-\d{2}$/D',$v)||!($d=\DateTimeImmutable::createFromFormat('!Y-m-d',$v))||$d->format('Y-m-d')!==$v)throw new AppError('Podaj poprawną datę.');return $v;}
 public static function ageAt(string $birth,string $date):int{self::date($birth);self::date($date);$b=new \DateTimeImmutable($birth);$d=new \DateTimeImmutable($date);return $d<$b?-1:$b->diff($d)->y;}
 public static function &entity(array &$rows,mixed $id,string $label):array{foreach($rows as &$r)if($r['id']===$id)return $r;throw new AppError($label.' nie istnieje.',404);}
 public static function manages(array $u,array $t):bool{return $u['role']==='admin'||$u['role']==='editor'&&$t['createdBy']===$u['id'];}
 public static function managesProfile(array $u,array $a):bool{return $u['role']==='admin'||$u['role']==='club'&&$a['clubId']===$u['clubId']||$u['role']==='editor'&&$a['createdBy']===$u['id'];}
 public static function canEnter(array $u,array $t):bool{return $t['status']!=='finished'&&(self::manages($u,$t)||$t['status']==='open');}
 public static function safeUser(array $u):array{unset($u['passwordHash'],$u['passwordSalt'],$u['authVersion']);return $u;}
 public static function publicData(array $db,array $u):array{
  $isClub=$u['role']==='club';$own=fn($a)=>!$isClub||$a['clubId']===$u['clubId'];$tours=[];
  foreach($db['tournaments'] as $t){$entries=array_values(array_filter($t['entries'],$own));if(!self::manages($u,$t)&&($t['status']==='draft'||($isClub&&$t['status']!=='open'&&!count($entries))))continue;$t['entries']=$entries;if($isClub){$t['draws']=[];$t['activity']=[];}$t['draws']=(object)array_map(static function($d){$d['results']=(object)$d['results'];return $d;},$t['draws']);$tours[]=$t;}
  return ['schemaVersion'=>2,'revision'=>$db['revision'],'user'=>self::safeUser($u),'clubs'=>array_values(array_filter($db['clubs'],fn($c)=>!$isClub||$c['id']===$u['clubId'])),'users'=>$u['role']==='admin'?array_map([self::class,'safeUser'],$db['users']):[],'profiles'=>array_values(array_filter($db['profiles'],$own)),'tournaments'=>$tours];
 }
 private static function audit(array &$t,string $message):void{array_unshift($t['activity'],['text'=>$message,'time'=>gmdate('c')]);$t['activity']=array_slice($t['activity'],0,40);}
 private static function reconcile(array &$t,array $entries):void{$cats=Rules::categories($entries);foreach($t['draws'] as $key=>$d){$c=$cats[$key]??null;if(!$c||count($c['athletes'])<3||Rules::signature($c['athletes'])!==$d['signature']){if(count($d['results']))throw new AppError('Ta zmiana narusza kategorię z wynikami. Najpierw wycofaj zależne wyniki.',409);unset($t['draws'][$key]);}}$t['entries']=array_values($entries);}
 public static function password(string $password):string{if(strlen($password)<12||strlen($password)>72)throw new AppError('Hasło musi mieć od 12 do 72 bajtów.');return password_hash($password,defined('PASSWORD_ARGON2ID')?PASSWORD_ARGON2ID:PASSWORD_DEFAULT);}
 public static function execute(array &$db,string $actorId,string $type,array $p,int $revision):array{
  $u=self::entity($db['users'],$actorId,'Konto');if(!$u['active'])throw new AppError('Konto jest zablokowane.',403);if($revision!==$db['revision'])throw new AppError('Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409);
  $result=self::apply($db,$u,$type,$p);$db['revision']++;return $result;
 }
 private static function apply(array &$db,array $u,string $type,array $p):array {
  if($type==='account.password'){
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
   if(!$club&&!empty($p['clubName'])){$name=self::txt($p['clubName'],'nazwa klubu');foreach($db['clubs'] as $c)if(mb_strtolower($c['name'])===mb_strtolower($name))$club=$c;if(!$club){$club=['id'=>self::id(),'name'=>$name];$db['clubs'][]=$club;}}
   if(!$club)throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');
   $a=$old??['id'=>self::id(),'authVersion'=>1];$a=array_replace($a,['email'=>$email,'clubId'=>$club['id'],'role'=>$p['role'],'active'=>$active]);
   if($old&&($old['role']!==$a['role']||$old['clubId']!==$a['clubId']||$old['active']!==$a['active']||$old['email']!==$email))$a['authVersion']++;
   if(!empty($p['password'])){$a['passwordHash']=self::password((string)$p['password']);$a['authVersion']++;}elseif(!$old)throw new AppError('Podaj hasło nowego konta.');
   if($old){$target=&self::entity($db['users'],$old['id'],'Konto');$target=$a;}else $db['users'][]=$a;return ['id'=>$a['id']];
  }
  if($type==='tournament.save'){
   if(!in_array($u['role'],['admin','editor'],true))throw new AppError('Nie możesz tworzyć turniejów.',403);$old=isset($p['id'])?self::entity($db['tournaments'],$p['id'],'Turniej'):null;
   if($old&&!self::manages($u,$old))throw new AppError('Możesz edytować tylko własne turnieje.',403);$date=self::date($p['date']??null);
   if(!in_array($p['status']??null,['draft','open','closed','finished'],true))throw new AppError('Niepoprawny status turnieju.');
   if($old&&count($old['entries'])&&$date!==$old['date'])throw new AppError('Data turnieju ze zgłoszeniami jest zablokowana.',409);
   $t=array_replace($old??['id'=>self::id(),'createdBy'=>$u['id'],'entries'=>[],'draws'=>[],'activity'=>[]],['name'=>self::txt($p['name']??null,'nazwa turnieju'),'city'=>self::txt($p['city']??null,'miasto'),'date'=>$date,'mat'=>self::txt($p['mat']??'Mata 1','mata',50),'status'=>$p['status']]);self::audit($t,$old?'Zaktualizowano ustawienia turnieju.':'Utworzono turniej.');
   if($old){$target=&self::entity($db['tournaments'],$old['id'],'Turniej');$target=$t;}else $db['tournaments'][]=$t;return ['id'=>$t['id']];
  }
  if($type==='profile.save'){
   $old=isset($p['id'])?self::entity($db['profiles'],$p['id'],'Zawodnik'):null;if($old&&!self::managesProfile($u,$old))throw new AppError('Nie możesz edytować tej kartoteki.',403);
   $clubId=$u['role']==='club'?$u['clubId']:($p['clubId']??null);self::entity($db['clubs'],$clubId,'Klub');if($old&&$old['clubId']!==$clubId&&$u['role']!=='admin')throw new AppError('Klub może zmienić Administrator.',403);
   $birth=!empty($p['birthDate'])?self::date($p['birthDate']):null;if(!$birth&&!isset($old['legacyAge']))throw new AppError('Podaj datę urodzenia.');if($birth&&($birth<'1900-01-01'||$birth>date('Y-m-d')))throw new AppError('Sprawdź datę urodzenia.');
   $a=array_replace($old??['id'=>self::id(),'createdBy'=>$u['id'],'archived'=>false],['name'=>self::txt($p['name']??null,'imię i nazwisko'),'clubId'=>$clubId,'birthDate'=>$birth,'sex'=>$p['sex']??null,'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true),'events'=>is_array($p['events']??null)?array_values(array_unique($p['events'])):['forms'],'champion'=>(bool)($p['champion']??false)]);
   Rules::validate(array_replace($a,['age'=>25,'club'=>'Klub','events'=>['forms']]));if(!count($a['events']))throw new AppError('Wybierz konkurencję.');foreach($a['events'] as $e)if(!is_string($e)||!isset(Rules::EVENTS[$e]))throw new AppError('Nieznana konkurencja.');
   if($old){$target=&self::entity($db['profiles'],$old['id'],'Zawodnik');$target=$a;}else $db['profiles'][]=$a;
   if(isset($p['registration']))self::apply($db,$u,'entry.save',array_replace($p['registration'],['profileId'=>$a['id']]));return ['id'=>$a['id']];
  }
  if($type==='profile.archive'){$a=&self::entity($db['profiles'],$p['id']??null,'Zawodnik');if(!self::managesProfile($u,$a))throw new AppError('Brak uprawnień.',403);$a['archived']=(bool)($p['archived']??false);return ['id'=>$a['id']];}
  $t=&self::entity($db['tournaments'],$p['tournamentId']??null,'Turniej');
  if($type==='entry.save'){
   if(!self::canEnter($u,$t))throw new AppError('Zapisy do tego turnieju są zamknięte.',403);$a=self::entity($db['profiles'],$p['profileId']??null,'Zawodnik');if($a['archived'])throw new AppError('Zawodnik jest zarchiwizowany.');if($u['role']==='club'&&$a['clubId']!==$u['clubId'])throw new AppError('Możesz zgłaszać tylko własny klub.',403);
   $old=null;foreach($t['entries'] as $e)if($e['profileId']===$a['id'])$old=$e;if($old&&empty($p['update']))throw new AppError('Zawodnik jest już zgłoszony.',409);
   if($old&&$u['role']==='editor'&&!self::manages($u,$t)&&$a['createdBy']!==$u['id'])throw new AppError('Nie możesz zmienić tego zgłoszenia.',403);
   if($old)foreach($t['draws'] as $d)if(in_array($old['id'],$d['slots'],true)&&count($d['results']))throw new AppError('Zawodnik ma zapisane wyniki.',409);
   $club=self::entity($db['clubs'],$a['clubId'],'Klub');$entry=['id'=>$a['id'],'profileId'=>$a['id'],'clubId'=>$a['clubId'],'name'=>$a['name'],'club'=>$club['name'],'sex'=>$a['sex'],'age'=>$a['birthDate']?self::ageAt($a['birthDate'],$t['date']):self::number($p['age']??null,7,100,true),'weight'=>self::number($p['weight']??null,10,250),'height'=>self::number($p['height']??null,70,250),'gradeType'=>$p['gradeType']??null,'grade'=>self::number($p['grade']??null,1,10,true),'events'=>is_array($p['events']??null)?array_values(array_unique($p['events'])):[],'champion'=>(bool)($p['champion']??false),'presence'=>$old['presence']??'pending','actualWeight'=>$old['actualWeight']??null];Rules::validate($entry);
   $list=$old?array_map(fn($e)=>$e['id']===$entry['id']?$entry:$e,$t['entries']):[...$t['entries'],$entry];self::reconcile($t,$list);self::audit($t,($old?'Zmieniono zgłoszenie: ':'Zgłoszono: ').$entry['name']);return ['id'=>$entry['id']];
  }
  if($type==='entry.remove'){
   if(!self::canEnter($u,$t))throw new AppError('Zapisy są zamknięte.',403);$a=self::entity($t['entries'],$p['id']??null,'Zgłoszenie');$profile=self::entity($db['profiles'],$a['profileId'],'Zawodnik');
   if(!self::manages($u,$t)&&($u['role']==='club'?$a['clubId']!==$u['clubId']:$profile['createdBy']!==$u['id']))throw new AppError('Nie możesz wycofać tego zgłoszenia.',403);self::reconcile($t,array_filter($t['entries'],fn($e)=>$e['id']!==$a['id']));self::audit($t,'Wycofano zgłoszenie: '.$a['name']);return ['id'=>$a['id']];
  }
  if(!self::manages($u,$t))throw new AppError('Brak uprawnień do zarządzania tym turniejem.',403);if($t['status']==='finished')throw new AppError('Zakończony turniej jest tylko do odczytu.',409);
  if($type==='checkin.save'){
   $a=self::entity($t['entries'],$p['id']??null,'Zgłoszenie');$presence=$p['presence']??'';if(!in_array($presence,['present','pending','absent'],true))throw new AppError('Niepoprawny status.');$weight=$presence==='present'?self::number($p['actualWeight']??null,10,250):$a['actualWeight'];
   foreach($t['draws'] as $d)if(in_array($a['id'],$d['slots'],true)&&count($d['results'])&&($a['presence']!==$presence||$a['actualWeight']!=$weight))throw new AppError('Zawodnik ma zapisane wyniki.',409);
   self::reconcile($t,array_map(fn($e)=>$e['id']===$a['id']?array_replace($a,['presence'=>$presence,'actualWeight'=>$weight]):$e,$t['entries']));self::audit($t,'Kontrola startowa: '.$a['name']);return ['id'=>$a['id']];
  }
  if($type==='draw.create'){$cats=Rules::categories($t['entries']);$key=(string)($p['categoryId']??'');$c=$cats[$key]??null;if(!$c||$c['type']!=='bracket')throw new AppError('Nie ma takiej kategorii.');$old=$t['draws'][$key]??null;if($old&&count($old['results']))throw new AppError('Nie można losować po zapisaniu wyników.',409);$d=Rules::makeDraw($c['athletes']);$d['revision']=($old['revision']??0)+1;$t['draws'][$key]=$d;self::audit($t,'Zapisano losowanie: '.$c['title'].' · '.$c['subtitle']);return ['id'=>$key];}
  if(in_array($type,['result.save','result.clear'],true)){if($type==='result.save')self::txt($p['winnerId']??null,'zwycięzca');$key=(string)($p['categoryId']??'');if(!isset($t['draws'][$key]))throw new AppError('Najpierw zapisz losowanie.');Rules::result($t['draws'][$key],(string)($p['matchId']??''),$type==='result.save'?(string)($p['winnerId']??''):null);self::audit($t,'Zaktualizowano wynik walki.');return ['id'=>$p['matchId']];}
  throw new AppError('Nieznana operacja.',400);
 }
}
