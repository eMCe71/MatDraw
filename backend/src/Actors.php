<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * The actor of a member's own request (plan §4.3, R4–R5): two queries by key instead of the workspace. The account has the
 * workspace shape (Accounts::fromRow) plus organizer, organizerBlockedAt, organizerTrustedAt, athletes [{id, archived,
 * relation}] and caps {organizer, organizerBlocked, organizerTrusted, athlete}. Repository::transaction($fn, $actor) puts
 * a member actor into $db['users'] for the command only; rows() never writes members.
 *  caps.organizer   role member, users.organizer=1 and no organizer_blocked_at (Domain::organizer)
 *  caps.athlete     at least one profile with owner_user_id = id and archived = 0
 *  caps.organizerTrusted  organizer_trusted_at is set (confirmed by the Administrator, R16)
 */
final class Actors {
 public static function of(PDO $pdo,array $u):array {
  $q=$pdo->prepare('SELECT id,club_id,email,role,active,password_hash,auth_version,organizer,organizer_blocked_at,organizer_trusted_at FROM users WHERE id=?');$q->execute([$u['id']??null]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(!$r)throw new AppError('Konto nie istnieje.',404);
  $a=$pdo->prepare('SELECT id,archived,data FROM profiles WHERE owner_user_id=? ORDER BY id');$a->execute([$r['id']]);$athletes=[];
  foreach($a->fetchAll(PDO::FETCH_ASSOC) as $p){$d=json_decode((string)$p['data'],true);$athletes[]=['id'=>$p['id'],'archived'=>(bool)$p['archived'],'relation'=>is_array($d)&&in_array($d['relation']??null,['self','guardian'],true)?$d['relation']:null];}
  return self::build(Accounts::fromRow($r),(bool)$r['organizer'],isset($r['organizer_blocked_at'])?(int)$r['organizer_blocked_at']:null,isset($r['organizer_trusted_at'])?(int)$r['organizer_trusted_at']:null,$athletes);
 }
 /** Pure part of of(): the account with its role fields and caps. */
 public static function build(array $account,bool $organizer,?int $blockedAt,?int $trustedAt,array $athletes):array {
  $u=$account+['organizer'=>$organizer,'organizerBlockedAt'=>$blockedAt,'organizerTrustedAt'=>$trustedAt,'athletes'=>array_values($athletes)];
  $u['caps']=['organizer'=>Domain::organizer($u),'organizerBlocked'=>$blockedAt!==null,'organizerTrusted'=>$trustedAt!==null,'athlete'=>(bool)array_filter($u['athletes'],fn($x)=>!$x['archived'])];
  return $u;
 }
}
