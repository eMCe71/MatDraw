<?php
// Roles of member accounts, athlete profiles, community tournaments and scoped revisions (PLAN-REJESTRACJA-ROLE §9.1, R13).
// Additive only: new columns at the end of existing tables, NULL or with a DEFAULT (instant ADD COLUMN), one non-unique
// index and one new table; no new foreign keys (rule of 0002; tombstones are cleaned by Repository::persist and the
// retention job). Every step is idempotent (Migrator::addColumn/addIndex, IF NOT EXISTS, UPDATE … AND staff_rev=0).
//  users        organizer (the member's own switch), organizer_blocked_at (taken away by the Administrator),
//               organizer_trusted_at/_by (confirmed by the Administrator, R16)
//  profiles     owner_user_id (the account of an athlete; non-unique index, R7), rev (scoped revision stamp, §5.8)
//  clubs        verified (existing clubs: 1), created_by, created_at, merged_into
//  tournaments  created_at, hidden_by, hidden_from, hide_reason, self_entry (existing tournaments: 0, R11), rev
//  app_meta     staff_rev = revision (staff accounts and existing clubs), so the first stale check matches the old one
//  entry_withdrawals  tombstones of self-entries removed by an organizer, the Administrator or the system (UX-7)
// The club 'unaffiliated' ("Niezrzeszony") is not inserted here: migrations change no rows of existing tables
// (tests/isolation.http.test.mjs compares them), so Clubs::ensure() creates it in the first workspace transaction and
// before a sign-up chooses it.
// floor: code older than 0007 would show community data to staff (member profiles and tournaments, owned profiles,
// hidden tournaments, clubs of members, merged clubs); the demo clubs of seed-athletes are created by an Administrator.
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>7,'name'=>'roles','destructive'=>false,
 'floor'=>fn(PDO $pdo):bool=>(bool)$pdo->query("SELECT 1 FROM profiles WHERE owner_user_id IS NOT NULL
  UNION ALL SELECT 1 FROM profiles p JOIN users u ON u.id=p.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM tournaments t JOIN users u ON u.id=t.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM tournaments WHERE hidden_by IS NOT NULL
  UNION ALL SELECT 1 FROM clubs c JOIN users u ON u.id=c.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM clubs WHERE merged_into IS NOT NULL
  LIMIT 1")->fetchColumn(),
 'up'=>function(Migrator $m):void{
  $m->addColumn('users','organizer','TINYINT(1) NOT NULL DEFAULT 0');
  $m->addColumn('users','organizer_blocked_at','BIGINT NULL');
  $m->addColumn('users','organizer_trusted_at','BIGINT NULL');
  $m->addColumn('users','organizer_trusted_by','VARCHAR(40) NULL');
  $m->addColumn('profiles','owner_user_id','VARCHAR(40) NULL');
  $m->addColumn('profiles','rev','BIGINT NOT NULL DEFAULT 0');
  $m->addIndex('profiles','profiles_owner','owner_user_id');
  $m->addColumn('clubs','verified','TINYINT(1) NOT NULL DEFAULT 1');
  $m->addColumn('clubs','created_by','VARCHAR(40) NULL');
  $m->addColumn('clubs','created_at','BIGINT NULL');
  $m->addColumn('clubs','merged_into','VARCHAR(40) NULL');
  $m->addColumn('tournaments','created_at','BIGINT NULL');
  $m->addColumn('tournaments','hidden_by','VARCHAR(40) NULL');
  $m->addColumn('tournaments','hidden_from','VARCHAR(10) CHARACTER SET ascii NULL');
  $m->addColumn('tournaments','hide_reason','VARCHAR(200) NULL');
  $m->addColumn('tournaments','self_entry','TINYINT(1) NOT NULL DEFAULT 0');
  $m->addColumn('tournaments','rev','BIGINT NOT NULL DEFAULT 0');
  $m->addColumn('app_meta','staff_rev','BIGINT NOT NULL DEFAULT 0');
  $m->exec('UPDATE app_meta SET staff_rev=revision WHERE id=1 AND staff_rev=0');
  $m->exec("CREATE TABLE IF NOT EXISTS entry_withdrawals (
 profile_id VARCHAR(40) NOT NULL,
 tournament_id VARCHAR(40) NOT NULL,
 by_kind VARCHAR(12) CHARACTER SET ascii NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY (profile_id, tournament_id),
 KEY entry_withdrawals_tournament (tournament_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
 }];
