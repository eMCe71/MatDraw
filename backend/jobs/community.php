<?php
// Retention of community data (PLAN-REJESTRACJA-ROLE §6.7, R18), run by MatDraw\Jobs after responses or by bin/cron.php,
// once a day. community-retention: Settings::effective first (bin/cron.php passes config.php as it is), then one workspace
// transaction with Domain::retain($db, today − RETENTION_MONTHS, 200):
//  1. profiles created by organizers (no owner account, creator not staff) whose last tournament, or creation without
//     entries, is older than the cutoff are forgotten (deleted, or anonymised while an entry stays in history);
//  2. names in entries and log lines of community tournaments dated before the cutoff become initials;
//  3. withdrawal tombstones of tournaments more than 30 days past are purged.
// Profiles of athlete accounts stay as long as the account (their owner deletes them). At most 200 profiles per run; the
// result (job_runs.last_result) holds counts only, never personal data. A run with nothing to change does not raise the
// workspace revision (Domain::retain stamps only changes).
declare(strict_types=1);
use MatDraw\{Domain,Repository,Settings};
return [
 'community-retention'=>['every'=>86400,'needsFlush'=>false,'run'=>function(PDO $pdo,array $c,int $now):string{
  $c=Settings::effective($pdo,$c);
  $cutoff=(new DateTimeImmutable('@'.$now))->setTimezone(new DateTimeZone(date_default_timezone_get()))->modify('-'.Domain::RETENTION_MONTHS.' months')->format('Y-m-d');
  $out=(new Repository($pdo))->transaction(fn(array &$db)=>Domain::retain($db,$cutoff,200),null,Settings::flags($c));
  return "cutoff=$cutoff profiles={$out['profiles']} snapshots={$out['snapshots']} logs={$out['logs']}";
 }],
];
