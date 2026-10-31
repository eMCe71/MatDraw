<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Public projection of members for viewers with full access only (plan §7.6); guests and non-paying viewers get none
 * (ChatGuestView, §5.4). One query users ⋈ user_profiles for all ids. An entry is
 *   {pid, n, u, cc, sp, club, av, mod, since}
 * pid: public_id; n: "First L." by default (name_display initial), "First Last" only with name_display full;
 * u: username; cc: country; sp: sports list; club: club text only with show_club=1, else null; av: avatar version
 * (first 12 characters of the file name) or null; mod: role admin; since: YYYY-MM of the profile's created_at.
 * A blocked account (active=0) is {pid, inactive:true}. An account without a profile row (deleted, §3.8) is absent.
 * Never included: e-mail, internal id (only the map key), any role except the mod flag, workspace club, billing state.
 */
final class People {
 /** id => entry, for the given internal user ids (duplicates and unknown ids are ignored). */
 public static function project(PDO $pdo,array $userIds):array {
  $ids=array_values(array_unique(array_filter($userIds,fn($v)=>is_string($v)&&$v!=='')));$out=[];
  foreach(array_chunk($ids,500) as $chunk){
   $q=$pdo->prepare('SELECT u.id,u.role,u.active,p.public_id,p.username,p.first_name,p.last_name,p.country,p.sports,p.club_text,p.show_club,p.name_display,p.avatar,p.created_at FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id IN ('.implode(',',array_fill(0,count($chunk),'?')).')');
   $q->execute($chunk);
   foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$out[$r['id']]=self::entry($r);
  }
  return $out;
 }
 /** The entry for one joined row (pure; used by project()). */
 public static function entry(array $r):array {
  if(!(int)$r['active'])return ['pid'=>$r['public_id'],'inactive'=>true];
  return ['pid'=>$r['public_id'],'n'=>self::name($r['first_name']??null,$r['last_name']??null,($r['name_display']??'initial')==='full'),'u'=>$r['username']??null,'cc'=>$r['country']??null,
   'sp'=>array_values(array_filter(explode(',',(string)($r['sports']??'')),'strlen')),'club'=>(int)($r['show_club']??0)&&($r['club_text']??'')!==''?$r['club_text']:null,
   'av'=>is_string($r['avatar']??null)&&$r['avatar']!==''?substr($r['avatar'],0,12):null,'mod'=>($r['role']??'')==='admin','since'=>date('Y-m',(int)($r['created_at']??0))];
 }
 /** "Marta K." (initial) or "Marta Kowalska" (full); the initial is the first character of the last name, upper case. */
 public static function name(?string $first,?string $last,bool $full):string {
  $first=trim((string)$first);$last=trim((string)$last);
  if($last==='')return $first;
  if($full)return trim($first.' '.$last);
  return trim($first.' '.mb_strtoupper(mb_substr($last,0,1)).'.');
 }
}
