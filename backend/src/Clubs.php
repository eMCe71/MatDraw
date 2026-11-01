<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Club names and the club choice of athletes and organizers (plan §6.3, §5.5). Pure functions shared by Domain (under the
 * workspace lock) and the sign-up (before its own transaction, R19); dist/profile-data.js clubKey() mirrors key() and
 * dist/workspace.js pickClub() mirrors pick() (tests/community.test.mjs, tests/roles-parity.test.mjs).
 * A club is {id, name, verified, createdBy, createdAt, mergedInto} (fromRow() maps a clubs row).
 *  - key(name): comparison key: Text::clean, lower case, Polish letters transliterated, NFD without combining marks, final
 *    sigma as sigma, then only \p{L}\p{N} (letters of any script and digits). "Kraków"/"Krakow" give "krakow"; Cyrillic,
 *    Greek or Korean names keep their letters. A key shorter than 2 characters is not a club name. Differences of the
 *    database collation (ß/ss) are caught by the unique key (1062 → 409 in Repository::persist, PS-11/DR-1).
 *  - pick(clubs, u, choice, now, counts): {none:true} or a name whose key means "no club" → 'unaffiliated'; {id} → that
 *    club (a merged one gives its target; unverified allowed); {name} → the club with the same key (also unverified,
 *    merged → target) or a new unverified club (verified when the Administrator creates it). When a member's daily quota
 *    (CLUBS_DAY_PER_USER, CLUBS_DAY_GLOBAL in Domain) is used up the choice becomes 'unaffiliated' with pendingClubName and
 *    notice 'club-pending' instead of an error (PS-9). Returns {clubId, newClub?, pendingClubName?, notice?}.
 *  - counts(clubs, u, now): the numbers pick() compares with the quotas (unverified clubs created in the last 24 h).
 *  - ensure(pdo): the 'unaffiliated' row ("Niezrzeszony", verified). Repository::transaction calls it under the workspace
 *    lock and the sign-up calls it before choosing; migration 0007 does not insert it, so migrations change no rows.
 */
final class Clubs {
 public const UNAFFILIATED='unaffiliated',NAME='Niezrzeszony',NAME_MAX=100;
 public const NONE_KEYS=['niezrzeszony','niezrzeszona','brak','bezklubu','none'];
 private const TRANSLIT=['ł'=>'l','ś'=>'s','ż'=>'z','ź'=>'z','ą'=>'a','ę'=>'e','ć'=>'c','ń'=>'n','ó'=>'o','ς'=>'σ'];
 public static function key(mixed $name):string {
  $s=Text::clean($name);if($s===null)return '';
  $s=strtr(mb_strtolower($s,'UTF-8'),self::TRANSLIT);
  if(class_exists(\Normalizer::class)){$d=\Normalizer::normalize($s,\Normalizer::FORM_D);if(is_string($d))$s=$d;}
  return (string)preg_replace('/[^\p{L}\p{N}]/u','',(string)preg_replace('/\p{M}/u','',$s));
 }
 public static function fromRow(array $r):array{return ['id'=>$r['id'],'name'=>$r['name'],'verified'=>(bool)($r['verified']??true),'createdBy'=>$r['created_by']??null,'createdAt'=>isset($r['created_at'])?(int)$r['created_at']:null,'mergedInto'=>$r['merged_into']??null];}
 /** The club with this id, following mergedInto (the Administrator's merges are flattened, a few hops at most), or null. */
 public static function resolve(array $clubs,mixed $id):?array {
  if(!is_string($id))return null;$byId=[];foreach($clubs as $c)$byId[$c['id']]=$c;
  for($hop=0;$hop<8&&isset($byId[$id]);$hop++){$c=$byId[$id];if(($c['mergedInto']??null)===null)return $c;$id=$c['mergedInto'];}
  return null;
 }
 public static function counts(array $clubs,array $u,int $now):array {
  $user=0;$global=0;
  foreach($clubs as $c){if(($c['verified']??true)!==false||!is_numeric($c['createdAt']??null)||(int)$c['createdAt']<=$now-86400)continue;$global++;if(($c['createdBy']??null)===($u['id']??null))$user++;}
  return ['user'=>$user,'global'=>$global];
 }
 public static function pick(array $clubs,array $u,array $choice,int $now,array $counts=[]):array {
  $member=($u['role']??null)==='member';
  if(($choice['none']??null)===true)return ['clubId'=>self::UNAFFILIATED];
  if(array_key_exists('id',$choice)){$c=self::resolve($clubs,$choice['id']);if(!$c)throw new AppError('Klub nie istnieje.',404);return ['clubId'=>$c['id']];}
  if(!array_key_exists('name',$choice))throw new AppError('Wybierz klub lub wpisz nazwę nowego klubu.');
  $name=Text::clean($choice['name']);$key=self::key($name);
  if($name===null||mb_strlen($name)<2||mb_strlen($name)>self::NAME_MAX||!preg_match('/\p{L}/u',$name)||mb_strlen($key)<2)throw new AppError('Sprawdź pole: nazwa klubu.');
  if(in_array($key,self::NONE_KEYS,true))return ['clubId'=>self::UNAFFILIATED];
  if($member&&Domain::contact($name))throw new AppError('Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.');
  foreach($clubs as $c)if(self::key($c['name'])===$key&&($t=self::resolve($clubs,$c['id'])))return ['clubId'=>$t['id']];
  if($member&&(($counts['user']??0)>=Domain::CLUBS_DAY_PER_USER||($counts['global']??0)>=Domain::CLUBS_DAY_GLOBAL))return ['clubId'=>self::UNAFFILIATED,'pendingClubName'=>$name,'notice'=>'club-pending'];
  $club=['id'=>Domain::id(),'name'=>$name,'verified'=>($u['role']??null)==='admin','createdBy'=>$u['id']??null,'createdAt'=>$now,'mergedInto'=>null];
  return ['clubId'=>$club['id'],'newClub'=>$club];
 }
 public static function ensure(PDO $pdo):void {
  $q=$pdo->prepare('SELECT 1 FROM clubs WHERE id=?');
  $exists=function()use($q):bool{$q->execute([self::UNAFFILIATED]);$v=$q->fetchColumn();$q->closeCursor();return $v!==false;};
  if($exists())return;
  // The name is unique (utf8mb4_unicode_ci): when a club already uses it, the second name keeps the reserved id.
  foreach([self::NAME,self::NAME.' (bez klubu)'] as $name){$pdo->prepare('INSERT IGNORE INTO clubs (id,name,verified) VALUES (?,?,1)')->execute([self::UNAFFILIATED,$name]);if($exists())return;}
  throw new \RuntimeException('Cannot create the club "unaffiliated": the names "Niezrzeszony" and "Niezrzeszony (bez klubu)" are taken. Rename one of those clubs, then retry.');
 }
}
