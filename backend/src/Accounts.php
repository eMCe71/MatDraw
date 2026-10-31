<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Lightweight account reads (plan §2.7, §3.3): one query by key instead of a workspace snapshot. An account array has
 * the workspace shape {id, clubId, email, role, active, passwordHash, authVersion}, so Domain::safeUser() gives the same
 * {id, clubId, email, role, active} as before. Members (role member, clubId null) never enter the workspace.
 */
final class Accounts {
 private const COLUMNS='id,club_id,email,role,active,password_hash,auth_version';
 /**
  * Verification hash for unknown accounts, with the algorithm and parameters of Domain::password() (Argon2id with PHP's
  * defaults m=65536, t=4, p=1; bcrypt cost 10 without Argon2id), so a login costs the same for every e-mail (§3.3).
  * Random secrets; no password verifies against them.
  */
 private const DUMMY_ARGON2ID='$argon2id$v=19$m=65536,t=4,p=1$aUdWL1hIVk05bW1xTmJXZg$Dy+ab4pOd4tXkQQIb9oRV0csnd2gxJ3fbhe1IiWh150';
 private const DUMMY_BCRYPT='$2y$10$bJGuVDpuTaOmuAtekakRyOfxFIZRYCF42ZwppHDyTxqdd.L0eKE2e';
 private static ?string $dummy=null;
 /** Workspace-shaped account from a users row. */
 public static function fromRow(array $r):array{return ['id'=>$r['id'],'clubId'=>$r['club_id'],'email'=>$r['email'],'role'=>$r['role'],'active'=>(bool)$r['active'],'passwordHash'=>$r['password_hash'],'authVersion'=>(int)$r['auth_version']];}
 public static function find(PDO $pdo,string $id):?array{return self::one($pdo,'SELECT '.self::COLUMNS.' FROM users WHERE id=?',$id);}
 /** By e-mail (stored lower case; the user_email key is case-insensitive). */
 public static function findByEmail(PDO $pdo,string $email):?array{return self::one($pdo,'SELECT '.self::COLUMNS.' FROM users WHERE email=?',mb_strtolower(trim($email)));}
 private static function one(PDO $pdo,string $sql,string $value):?array{$q=$pdo->prepare($sql);$q->execute([$value]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();return $r?self::fromRow($r):null;}
 /**
  * The signed-in account of a started session (Auth::start). An unknown, blocked or outdated (auth_version) account
  * clears the session; $required turns "nobody" into 401.
  */
 public static function current(PDO $pdo,bool $required=true):?array {
  $id=$_SESSION['userId']??null;$u=is_string($id)?self::find($pdo,$id):null;
  if($u&&$u['active']&&$u['authVersion']===($_SESSION['authVersion']??null))return $u;
  if(isset($_SESSION['userId']))Auth::clear();
  if($required)throw new AppError('Zaloguj się ponownie.',401);
  return null;
 }
 /** The signed-in account for a peek route (Auth::peek): read only, a stale session is ignored, never cleared. */
 public static function currentPeek(PDO $pdo,array $c):?array {
  $s=Auth::peek($c);if(!$s||!is_string($s['userId']))return null;
  $u=self::find($pdo,$s['userId']);return $u&&$u['active']&&$u['authVersion']===$s['authVersion']?$u:null;
 }
 public static function dummyHash():string {
  if(self::$dummy!==null)return self::$dummy;
  [$hash,$algo]=defined('PASSWORD_ARGON2ID')?[self::DUMMY_ARGON2ID,PASSWORD_ARGON2ID]:[self::DUMMY_BCRYPT,PASSWORD_DEFAULT];
  // A PHP build with other default parameters than the constant gets a fresh hash once per process instead.
  return self::$dummy=password_needs_rehash($hash,$algo)?password_hash(bin2hex(random_bytes(16)),$algo):$hash;
 }
 /**
  * Credentials check with equal cost for unknown, blocked and existing accounts: the password is always verified,
  * the result is looked at afterwards. Returns the account or null (the caller answers with one message for all).
  */
 public static function verifyLogin(PDO $pdo,string $email,string $password):?array {
  $u=self::findByEmail($pdo,$email);$valid=password_verify($password,$u['passwordHash']??self::dummyHash());
  return $u&&$u['active']&&$valid?$u:null;
 }
 /** Creates the user_profiles row when missing (INSERT IGNORE, random public_id, up to 3 tries on a collision); returns the public_id. */
 public static function ensureProfile(PDO $pdo,string $userId):string {
  $q=$pdo->prepare('SELECT public_id FROM user_profiles WHERE user_id=?');
  for($try=0;;$try++){
   $q->execute([$userId]);$pid=$q->fetchColumn();$q->closeCursor();if(is_string($pid))return $pid;
   if($try===3)throw new \RuntimeException('Cannot create the profile row.');
   $now=time();$pdo->prepare('INSERT IGNORE INTO user_profiles (user_id,public_id,created_at,updated_at) VALUES (?,?,?,?)')->execute([$userId,self::publicId(),$now,$now]);
  }
 }
 /** The user_profiles row of an account, created first when missing. */
 public static function profile(PDO $pdo,string $userId):array {
  $q=$pdo->prepare('SELECT * FROM user_profiles WHERE user_id=?');$q->execute([$userId]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if($r)return $r;
  self::ensureProfile($pdo,$userId);$q->execute([$userId]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(!$r)throw new \RuntimeException('Cannot read the profile row.');
  return $r;
 }
 /** 12 random base62 characters (uniform: bytes ≥ 248 are skipped). */
 public static function publicId():string {
  $a='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';$s='';
  while(strlen($s)<12)foreach(str_split(random_bytes(16)) as $b){$n=ord($b);if($n<248&&strlen($s)<12)$s.=$a[$n%62];}
  return $s;
 }
 public static function touchLogin(PDO $pdo,string $userId):void{$pdo->prepare('UPDATE user_profiles SET last_login_at=? WHERE user_id=?')->execute([time(),$userId]);}
 /** bootstrap for a member (§3.3): the workspace shape without any workspace data. */
 public static function memberWorkspace(array $u):array{return ['schemaVersion'=>2,'revision'=>0,'user'=>self::safe($u),'clubs'=>[],'users'=>[],'profiles'=>[],'tournaments'=>[]];}
 public static function safe(array $u):array{return Domain::safeUser($u);}
 /**
  * Whether a profile allows posting (§3.1): first name, last name, username, country and at least one sport. Accepts a
  * user_profiles row (first_name, sports "a,b") or the camelCase projection (firstName, sports [..]); shared by me,
  * Profiles and Chat.
  */
 public static function profileComplete(?array $p):bool {
  if(!$p)return false;$v=fn(string $a,string $b)=>$p[$a]??$p[$b]??null;$filled=fn($x)=>is_string($x)&&trim($x)!=='';
  $sports=$v('sports','sports');$sports=is_array($sports)?$sports:explode(',',(string)$sports);
  return $filled($v('first_name','firstName'))&&$filled($v('last_name','lastName'))&&$filled($v('username','username'))
   &&is_string($c=$v('country','country'))&&preg_match('/^[A-Z]{2}$/D',$c)===1&&count(array_filter($sports,$filled))>0;
 }
}
