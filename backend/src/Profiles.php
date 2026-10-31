<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Community profiles (plan §7.1–7.4): validation, usernames, suggestions and the owner's own projection. The same rules
 * run in dist/profile-data.js (tests/community.test.mjs compares both). A profile lives in user_profiles, one row per
 * account; e-mail, workspace club and role stay in users and are never part of a profile. Fields:
 *   firstName, lastName  1–50 characters after NFC and trim: letters, combining marks, space, - ' . (at least one letter)
 *   username             §7.2: ^[a-z][a-z0-9._]{2,23}$, no "..", "._", "_.", no final dot; stored lower case; RESERVED
 *                        names and the prefixes matbravo*, admin* are refused; changed at most once per 30 days (the
 *                        first setting does not count)
 *   country              a code of COUNTRIES (249 ISO 3166-1 alpha-2 codes + XK)
 *   sports               1–5 different slugs of SPORTS, the first is the main sport (stored "a,b")
 *   clubText             optional free text, Text::clean, at most 100 characters; never linked to a workspace club
 *   showClub, nameDisplay  bool; 'initial' ("Marta K.", default) or 'full'
 */
final class Profiles {
 public const SPORTS=['taekwondo','karate','judo','kickboxing','bjj','jujitsu','boxing','mma','wrestling','muaythai','other'];
 public const COUNTRIES=['AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA',
  'RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU',
  'WF','WS','XK','YE','YT','ZA','ZM','ZW'];
 public const RESERVED=['admin','administrator','root','matbravo','matdraw','meducase','moderator','mod','support','pomoc','kontakt','system','api','stripe','billing','null','undefined','organizator','sedzia','staff','team','official','info'];
 public const RESERVED_PREFIXES=['matbravo','admin'];
 public const SPORTS_MAX=5,NAME_MAX=50,CLUB_MAX=100,USERNAME_MAX=24,USERNAME_CHANGE_SECONDS=30*86400;
 private const TRANSLIT=['ł'=>'l','ś'=>'s','ż'=>'z','ź'=>'z','ą'=>'a','ę'=>'e','ć'=>'c','ń'=>'n','ó'=>'o'];

 /** Lower case (ASCII) and trimmed, or null for a non-string. */
 public static function normalizeUsername(mixed $v):?string{return is_string($v)?strtolower(trim($v)):null;}
 /** 'valid' | 'invalid' | 'reserved' (§7.2). */
 public static function usernameStatus(mixed $v):string {
  $u=self::normalizeUsername($v);
  if($u===null||!preg_match('/^[a-z][a-z0-9._]{2,23}$/D',$u)||preg_match('/\.\.|\._|_\./',$u)||str_ends_with($u,'.'))return 'invalid';
  if(in_array($u,self::RESERVED,true))return 'reserved';
  foreach(self::RESERVED_PREFIXES as $p)if(str_starts_with($u,$p))return 'reserved';
  return 'valid';
 }
 /** A valid username or the matching 422. */
 public static function username(mixed $v):string {
  $status=self::usernameStatus($v);
  if($status==='invalid')throw new AppError('Sprawdź pole: nazwa użytkownika.');
  if($status==='reserved')throw new AppError('Tej nazwy nie można użyć.');
  return (string)self::normalizeUsername($v);
 }
 /** First or last name (§7.1), or null; the same rule as validateName() in dist/profile-data.js. */
 public static function cleanName(mixed $v,int $max=self::NAME_MAX):?string {
  if(!is_string($v)||!mb_check_encoding($v,'UTF-8'))return null;
  if(class_exists(\Normalizer::class)){$n=\Normalizer::normalize($v,\Normalizer::FORM_C);if(is_string($n))$v=$n;}
  $s=trim($v);$n=mb_strlen($s);
  return $n>=1&&$n<=$max&&preg_match('/^[\p{L}\p{M} \'.-]+$/uD',$s)&&preg_match('/\p{L}/u',$s)?$s:null;
 }
 public static function firstName(mixed $v):string{$s=self::cleanName($v);if($s===null)Domain::txt(null,'imię',self::NAME_MAX);return $s;}
 public static function lastName(mixed $v):string{$s=self::cleanName($v);if($s===null)Domain::txt(null,'nazwisko',self::NAME_MAX);return $s;}
 public static function country(mixed $v):string{if(!is_string($v)||!in_array($v,self::COUNTRIES,true))throw new AppError('Wybierz kraj z listy.');return $v;}
 /** 1–5 different known slugs, order kept (the first is the main sport); repeated slugs are dropped. */
 public static function sports(mixed $v):array {
  if(!is_array($v)||!array_is_list($v)||!$v)throw new AppError('Wybierz co najmniej jeden sport.');
  $out=[];foreach($v as $s){if(!is_string($s)||!in_array($s,self::SPORTS,true))throw new AppError('Wybierz sport z listy.');if(!in_array($s,$out,true))$out[]=$s;}
  if(count($out)>self::SPORTS_MAX)throw new AppError('Wybierz najwyżej 5 sportów.');
  return $out;
 }
 /** Optional club or school text: null when empty, else Text::clean (one line) of at most 100 characters. */
 public static function clubText(mixed $v):?string {
  if($v===null||$v==='')return null;$s=Text::clean($v);
  if($s===null||mb_strlen($s)>self::CLUB_MAX)Domain::txt(null,'klub lub szkoła',self::CLUB_MAX);
  return $s===''?null:$s;
 }
 /**
  * user_profiles columns from camelCase input. Complete mode (signup, profile, admin create): every required field
  * must be present and valid. Partial mode (admin fix): only the keys present are validated and returned, and
  * username may be null (the member chooses a new one).
  */
 public static function validate(array $in,bool $partial=false):array {
  $has=fn(string $k)=>!$partial||array_key_exists($k,$in);$out=[];
  if($has('firstName'))$out['first_name']=self::firstName($in['firstName']??null);
  if($has('lastName'))$out['last_name']=self::lastName($in['lastName']??null);
  if($has('username'))$out['username']=$partial&&$in['username']===null?null:self::username($in['username']??null);
  if($has('country'))$out['country']=self::country($in['country']??null);
  if($has('sports'))$out['sports']=implode(',',self::sports($in['sports']??null));
  if($has('clubText'))$out['club_text']=self::clubText($in['clubText']??null);
  if($has('showClub'))$out['show_club']=($in['showClub']??false)===true?1:0;
  if($has('nameDisplay'))$out['name_display']=($in['nameDisplay']??'initial')==='full'?'full':'initial';
  return $out;
 }
 /** Lower-case ASCII form of a name (Polish letters transliterated, other marks dropped, [a-z0-9] kept); see slugName() in JS. */
 public static function slug(mixed $v):string {
  if(!is_string($v)||!mb_check_encoding($v,'UTF-8'))return '';
  $s=strtr(mb_strtolower($v),self::TRANSLIT);
  if(class_exists(\Normalizer::class)){$d=\Normalizer::normalize($s,\Normalizer::FORM_D);if(is_string($d))$s=(string)preg_replace('/\p{M}/u','',$d);}
  return (string)preg_replace('/[^a-z0-9]/','',$s);
 }
 /** Username candidates, best first (§7.2); the same list as suggestUsernames() in dist/profile-data.js. */
 public static function candidates(mixed $first,mixed $last,mixed $requested=''):array {
  $f=self::slug($first);$l=self::slug($last);$r=self::normalizeUsername($requested)??'';
  if(!preg_match('/^[a-z]/',$f))return [];
  $fit=fn(string $base,string $suffix='')=>rtrim(substr($base,0,self::USERNAME_MAX-strlen($suffix)),'._').$suffix;
  $req=self::usernameStatus($r)==='valid'?$fit($r,'2'):'';
  $list=$l!==''?[$fit("$f.$l"),$fit("{$f}_$l"),$fit("$f.$l[0]",'2'),$req,$fit($f.$l),$fit("$f.$l",'2'),$fit("$f.$l[0]",'3'),$fit("{$f}_$l",'2')]:[$fit($f),$req,$fit($f,'2'),$fit($f,'3')];
  $out=[];foreach($list as $c)if($c!==''&&$c!==$r&&!in_array($c,$out,true)&&self::usernameStatus($c)==='valid')$out[]=$c;
  return $out;
 }
 /** At most $max free candidates (one query). */
 public static function suggestions(PDO $pdo,mixed $first,mixed $last,mixed $requested='',int $max=3):array {
  $list=self::candidates($first,$last,$requested);if(!$list)return [];
  $q=$pdo->prepare('SELECT username FROM user_profiles WHERE username IN ('.implode(',',array_fill(0,count($list),'?')).')');$q->execute($list);
  $taken=$q->fetchAll(PDO::FETCH_COLUMN);
  return array_slice(array_values(array_diff($list,$taken)),0,$max);
 }
 /** Whether the username is held by another account. */
 public static function taken(PDO $pdo,string $username,?string $exceptUserId=null):bool {
  $q=$pdo->prepare('SELECT user_id FROM user_profiles WHERE username=?');$q->execute([$username]);$id=$q->fetchColumn();$q->closeCursor();
  return $id!==false&&$id!==$exceptUserId;
 }
 /** The owner's own profile (me.profile shape, §4.3) from a user_profiles row. */
 public static function own(array $p,?int $now=null):array {
  $now??=time();$change=$p['username_changed_at']!==null&&(int)$p['username_changed_at']+self::USERNAME_CHANGE_SECONDS>$now?(int)$p['username_changed_at']+self::USERNAME_CHANGE_SECONDS:null;
  return ['publicId'=>$p['public_id'],'username'=>$p['username'],'firstName'=>$p['first_name'],'lastName'=>$p['last_name'],'country'=>$p['country'],
   'sports'=>array_values(array_filter(explode(',',(string)$p['sports']),'strlen')),'clubText'=>$p['club_text'],'showClub'=>(bool)$p['show_club'],'nameDisplay'=>$p['name_display'],
   'avatar'=>is_string($p['avatar'])&&$p['avatar']!==''?substr($p['avatar'],0,12):null,'complete'=>Accounts::profileComplete($p),'usernameChangeAt'=>$change,'mustChangePassword'=>$p['pw_reset_at']!==null];
 }
 /**
  * The profile route (§4.3): every field as in signup, without e-mail and password. A username change other than the
  * first setting is allowed once per 30 days (429 with retry). Returns the own projection.
  */
 public static function save(PDO $pdo,array $u,array $in,?int $now=null):array {
  $now??=time();$cols=self::validate($in);$p=Accounts::profile($pdo,$u['id']);
  if($cols['username']!==$p['username']){
   if($p['username']!==null){
    $wait=$p['username_changed_at']!==null?(int)$p['username_changed_at']+self::USERNAME_CHANGE_SECONDS-$now:0;
    if($wait>0){$s=Routes::retryAfter($wait);throw new ApiError('Nazwę użytkownika można zmienić raz na 30 dni.',429,['retry'=>$s]);}
    $cols['username_changed_at']=$now;
   }
   if(self::taken($pdo,$cols['username'],$u['id']))throw new AppError('Ta nazwa użytkownika jest zajęta.',409);
  }
  $cols['updated_at']=$now;
  try{$pdo->prepare('UPDATE user_profiles SET '.implode(',',array_map(fn($k)=>"$k=?",array_keys($cols))).' WHERE user_id=?')->execute([...array_values($cols),$u['id']]);}
  catch(\PDOException $e){if(Members::duplicate($e)==='username')throw new AppError('Ta nazwa użytkownika jest zajęta.',409);throw $e;}
  return self::own(Accounts::profile($pdo,$u['id']),$now);
 }
}
