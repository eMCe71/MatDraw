<?php
// Chat (plan §2.4, §5): channels, messages, reports, mutes, moderation log, settings and hosting health counters.
// Every step is idempotent. New tables reference users(id) and tournaments(id) as VARCHAR(40) utf8mb4_unicode_ci,
// exactly like the referenced columns; no foreign key is added to an existing table. Times are BIGINT computed in PHP
// (epoch seconds in *_at, milliseconds in *_ms). Names and descriptions of the global channels live in code
// (MatDraw\Chat::LOBBY) and in the dictionaries, never in the database. No floor: the release before this migration
// simply ignores the chat tables, so a rollback stays safe.
declare(strict_types=1);
use MatDraw\Migrator;
/** 16 random base62 characters (uniform; bytes ≥ 248 are skipped): public_key, reserved for the static beacon (§5.11). */
$key=static function():string{$a='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';$s='';while(strlen($s)<16)foreach(str_split(random_bytes(24)) as $b){$n=ord($b);if($n<248&&strlen($s)<16)$s.=$a[$n%62];}return $s;};
return ['id'=>3,'name'=>'chat','destructive'=>false,
 'up'=>function(Migrator $m)use($key):void{
  // Channels. kind lobby: slug + scope (world|pl), fixed sort; kind tournament: tournament_id, created lazily (§5.2).
  // rev: +1 on every change in the channel (new, deleted, hidden, restored message; status change) = the polling cursor;
  // last_message_id: newest message id; msg_count: number of visible messages; status: the Admin's manual override.
  $m->exec("CREATE TABLE IF NOT EXISTS chat_channels (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 kind ENUM('lobby','tournament') NOT NULL,
 slug VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
 scope ENUM('world','pl') NULL,
 sort SMALLINT NOT NULL DEFAULT 0,
 tournament_id VARCHAR(40) NULL,
 public_key CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
 last_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 msg_count INT UNSIGNED NOT NULL DEFAULT 0,
 status ENUM('open','readonly','closed') NOT NULL DEFAULT 'open',
 created_at BIGINT NOT NULL,
 UNIQUE KEY chat_channels_slug (slug),
 UNIQUE KEY chat_channels_tournament (tournament_id),
 UNIQUE KEY chat_channels_key (public_key),
 CONSTRAINT fk_chat_channels_tournament FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // The four global channels (requirement 1, §5.1), in the owner's order. INSERT IGNORE keeps it idempotent; a slug that
  // a public_key collision kept out is retried with a new key.
  $lobby=[['taekwondo','world',10],['taekwondo-pl','pl',20],['karate','world',30],['general','world',40]];$now=time();
  $m->exec("INSERT IGNORE INTO chat_channels (kind,slug,scope,sort,public_key,created_at) VALUES ('lobby',?,?,?,?,?),('lobby',?,?,?,?,?),('lobby',?,?,?,?,?),('lobby',?,?,?,?,?)",
   array_merge(...array_map(fn($l)=>[$l[0],$l[1],$l[2],$key(),$now],$lobby)));
  if($m->tableExists('chat_channels'))foreach($lobby as [$slug,$scope,$sort])for($try=0;$try<3;$try++){
   $q=$m->pdo()->prepare('SELECT 1 FROM chat_channels WHERE slug=?');$q->execute([$slug]);$has=$q->fetchColumn();$q->closeCursor();
   if($has)break;
   $m->exec("INSERT IGNORE INTO chat_channels (kind,slug,scope,sort,public_key,created_at) VALUES ('lobby',?,?,?,?,?)",[$slug,$scope,$sort,$key(),$now]);
  }
  // Messages. id = display order; rev = channel rev of the last change of this message (polling index); client_id =
  // idempotency key from the browser; body '' once deleted (a copy goes to chat_mod_log only for moderation, §5.5);
  // cont = same author as the previous visible message, less than 5 minutes earlier (computed under the channel lock).
  $m->exec("CREATE TABLE IF NOT EXISTS chat_messages (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 channel_id INT UNSIGNED NOT NULL,
 rev BIGINT UNSIGNED NOT NULL,
 user_id VARCHAR(40) NOT NULL,
 client_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 body VARCHAR(1000) NOT NULL,
 cont TINYINT(1) NOT NULL DEFAULT 0,
 state ENUM('visible','deleted_author','deleted_mod','hidden_review') NOT NULL DEFAULT 'visible',
 report_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
 created_ms BIGINT UNSIGNED NOT NULL,
 changed_ms BIGINT UNSIGNED NULL,
 UNIQUE KEY chat_messages_channel_rev (channel_id,rev),
 UNIQUE KEY chat_messages_idem (user_id,client_id),
 KEY chat_messages_channel_id (channel_id,id),
 KEY chat_messages_user_time (user_id,created_ms),
 KEY chat_messages_created (created_ms),
 CONSTRAINT fk_chat_messages_channel FOREIGN KEY (channel_id) REFERENCES chat_channels(id),
 CONSTRAINT fk_chat_messages_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // Reports: one per person and message; removed together with the message by the retention job (cascade).
  $m->exec("CREATE TABLE IF NOT EXISTS chat_reports (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 message_id BIGINT UNSIGNED NOT NULL,
 reporter_id VARCHAR(40) NOT NULL,
 reason ENUM('spam','abuse','harassment','child_data','other') NOT NULL,
 comment VARCHAR(300) NULL,
 status ENUM('open','dismissed','actioned') NOT NULL DEFAULT 'open',
 created_at BIGINT NOT NULL,
 resolved_by VARCHAR(40) NULL,
 resolved_at BIGINT NULL,
 UNIQUE KEY chat_reports_once (message_id,reporter_id),
 KEY chat_reports_status (status,created_at),
 KEY chat_reports_reporter (reporter_id),
 CONSTRAINT fk_chat_reports_message FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
 CONSTRAINT fk_chat_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // Mutes: until_at NULL = without an end.
  $m->exec("CREATE TABLE IF NOT EXISTS chat_mutes (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 until_at BIGINT NULL,
 reason VARCHAR(300) NULL,
 created_by VARCHAR(40) NOT NULL,
 created_at BIGINT NOT NULL,
 CONSTRAINT fk_chat_mutes_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // Moderation log without foreign keys (it outlives the retention of messages). actor_id: users.id | 'system';
  // action: delete_mod, delete_author, auto_hide, restore, dismiss, mute, unmute, settings, channel_status;
  // original_body is cleared after modKeepDays (chat-retention).
  $m->exec("CREATE TABLE IF NOT EXISTS chat_mod_log (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 actor_id VARCHAR(40) NOT NULL,
 action VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 message_id BIGINT UNSIGNED NULL,
 target_user_id VARCHAR(40) NULL,
 note VARCHAR(300) NULL,
 original_body VARCHAR(1000) NULL,
 created_at BIGINT NOT NULL,
 KEY chat_mod_log_time (created_at),
 KEY chat_mod_log_target (target_user_id,created_at),
 KEY chat_mod_log_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // One settings row: tuning and the switch, versioned (cv). JSON kept as TEXT (no JSON type differences between engines).
  $m->exec("CREATE TABLE IF NOT EXISTS chat_settings (
 id TINYINT NOT NULL PRIMARY KEY,
 version INT UNSIGNED NOT NULL,
 data TEXT NOT NULL,
 updated_at BIGINT NOT NULL,
 updated_by VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // Defaults of §2.4 as they were when this migration was written (later code merges its own defaults over them).
  $defaults='{"on":true,"t":"poll","ms":[2500,5000,10000,30000,60000],"idle":[60,180,600,1800],"bg":30000,"boost":300,"safety":60000,"notice":null,'
   .'"send":{"gap":2,"perMin":20,"perDay":300},"autoHide":3,"retentionDays":365,"modKeepDays":30,"graceDays":1}';
  $m->exec('INSERT IGNORE INTO chat_settings (id,version,data,updated_at) VALUES (1,1,?,?)',[$defaults,$now]);
  // Hosting answers reported by clients (§5.10): hour, status (429|503|508|0 = not JSON or network error), count.
  // No IP address and no account.
  $m->exec("CREATE TABLE IF NOT EXISTS chat_health (
 hour_at BIGINT NOT NULL,
 status SMALLINT UNSIGNED NOT NULL,
 n INT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY (hour_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
 }];
