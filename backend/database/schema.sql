CREATE TABLE IF NOT EXISTS app_meta (
 id TINYINT PRIMARY KEY,
 revision BIGINT NOT NULL DEFAULT 0,
 schema_version INT NOT NULL DEFAULT 1
) ENGINE=InnoDB;
INSERT IGNORE INTO app_meta (id, revision, schema_version) VALUES (1, 0, 1);

CREATE TABLE IF NOT EXISTS clubs (
 id VARCHAR(40) PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 UNIQUE KEY club_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
 id VARCHAR(40) PRIMARY KEY,
 club_id VARCHAR(40) NOT NULL,
 email VARCHAR(254) NOT NULL,
 role ENUM('admin','editor','club') NOT NULL,
 active TINYINT(1) NOT NULL DEFAULT 1,
 password_hash VARCHAR(255) NOT NULL,
 auth_version INT NOT NULL DEFAULT 1,
 UNIQUE KEY user_email (email),
 FOREIGN KEY (club_id) REFERENCES clubs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
 id VARCHAR(40) PRIMARY KEY,
 club_id VARCHAR(40) NOT NULL,
 created_by VARCHAR(40) NOT NULL,
 archived TINYINT(1) NOT NULL DEFAULT 0,
 data JSON NOT NULL,
 FOREIGN KEY (club_id) REFERENCES clubs(id),
 FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tournaments (
 id VARCHAR(40) PRIMARY KEY,
 created_by VARCHAR(40) NOT NULL,
 name VARCHAR(100) NOT NULL,
 city VARCHAR(100) NOT NULL,
 event_date DATE NOT NULL,
 mat VARCHAR(50) NOT NULL,
 status ENUM('draft','open','closed','finished') NOT NULL,
 activity JSON NOT NULL,
 FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS entries (
 tournament_id VARCHAR(40) NOT NULL,
 profile_id VARCHAR(40) NOT NULL,
 club_id VARCHAR(40) NOT NULL,
 snapshot JSON NOT NULL,
 PRIMARY KEY (tournament_id, profile_id),
 FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
 FOREIGN KEY (profile_id) REFERENCES profiles(id),
 FOREIGN KEY (club_id) REFERENCES clubs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS draws (
 tournament_id VARCHAR(40) NOT NULL,
 category_key VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
 data JSON NOT NULL,
 PRIMARY KEY (tournament_id, category_key),
 FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_limits (
 bucket CHAR(64) CHARACTER SET ascii PRIMARY KEY,
 attempts INT UNSIGNED NOT NULL,
 window_start BIGINT NOT NULL,
 KEY limits_expiry (window_start)
) ENGINE=InnoDB;
