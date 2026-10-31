<?php
// Copy to config.php, outside the public document root. Never commit real secrets.
return [
 'app_url' => 'https://matbravo.com',
 'db' => [
  'dsn' => 'mysql:host=localhost;dbname=matdraw;charset=utf8mb4',
  'user' => 'matdraw',
  'password' => 'REPLACE_WITH_DATABASE_PASSWORD',
 ],
 // Generate with: php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
 'app_key' => 'REPLACE_WITH_RANDOM_64_HEX_CHARACTERS',
 'allow_insecure_http' => false,
 'session_idle_seconds' => 1800,
 'session_max_seconds' => 43200,
];
