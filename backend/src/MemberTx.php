<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * The budget of member transactions under the workspace lock (PLAN-REJESTRACJA-ROLE §3.7, final review B2); staff never
 * count. Organizer commands (index.php) and the athlete routes (routes/athletes.php) call:
 *  - check() before the lock: 429 'Serwer jest teraz mocno obciążony…' while the global bucket of committed member writes
 *    (member-tx, GLOBAL per WINDOW, all members together) is full (peek, nothing counted); then the attempt is counted in
 *    the account's own bucket (member-tx-account, ACCOUNT per WINDOW, 429 'Zbyt wiele operacji…'): one account takes the
 *    workspace lock at most ACCOUNT times a minute, so fewer than GLOBAL/ACCOUNT (4) accounts can never fill the global
 *    bucket by themselves (two junk-flooding organizers could, before B2);
 *  - count() after the transaction committed (outside it, so the bucket row is never locked with the workspace): only
 *    committed writes use the global bucket, so refused or invalid commands (403, 404, 409, 422, junk payloads) never
 *    take it away from other members.
 * Removing own data (REMOVAL: withdrawing an entry, forgetting a profile) is never refused by either bucket (R12); the
 * routes' own limits per account stay.
 */
final class MemberTx {
 public const GLOBAL=120,ACCOUNT=30,WINDOW=60;
 public const REMOVAL=['entry.remove','profile.forget','athlete.forget'];
 public static function exempt(string $type):bool{return in_array($type,self::REMOVAL,true);}
 public static function check(PDO $pdo,array $c,string $userId):void {
  if($s=RateLimit::peek($pdo,$c['app_key'],'member-tx','all',self::GLOBAL,self::WINDOW)){Routes::retryAfter($s);throw new ApiError('Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.',429,['retry'=>$s]);}
  if($s=RateLimit::hit($pdo,$c['app_key'],'member-tx-account',$userId,self::ACCOUNT,self::WINDOW)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele operacji. Spróbuj ponownie za chwilę.',429,['retry'=>$s]);}
 }
 public static function count(PDO $pdo,array $c):void{RateLimit::hit($pdo,$c['app_key'],'member-tx','all',self::GLOBAL,self::WINDOW);}
}
