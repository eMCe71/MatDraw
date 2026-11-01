<?php
// Switches the Administrator changes in the panel "Ustawienia" (PLAN-REJESTRACJA-ROLE §3.1, §9.2): one versioned row
// app_settings(id=1) like chat_settings, data as JSON text (signup, payments, organizers, trustRequired, supportEmail,
// stripeCheck), read through MatDraw\Settings only. No starting row: until the Administrator saves, config.php decides
// (Settings::effective; in production sign-up stays off). No floor: the release before this migration ignores the table,
// and a repeated run changes nothing (IF NOT EXISTS).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>8,'name'=>'settings','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->exec("CREATE TABLE IF NOT EXISTS app_settings (
 id TINYINT NOT NULL PRIMARY KEY,
 version INT UNSIGNED NOT NULL,
 data TEXT NOT NULL,
 updated_at BIGINT NOT NULL,
 updated_by VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
 }];
