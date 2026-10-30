<?php
declare(strict_types=1);
require_once __DIR__.'/src/Domain.php';
require_once __DIR__.'/src/Rules.php';
require_once __DIR__.'/src/Repository.php';
require_once __DIR__.'/src/Auth.php';

function matdraw_config(): array {
 $path=getenv('MATDRAW_CONFIG')?:__DIR__.'/config.php';
 if(!is_file($path))throw new RuntimeException('Missing server configuration.');
 $c=require $path;
 if(!is_array($c)||strlen($c['app_key']??'')<64||str_starts_with($c['app_key'],'REPLACE_'))throw new RuntimeException('Invalid server configuration.');
 $url=parse_url($c['app_url']??'');
 if(!$url||empty($url['host'])||(($url['scheme']??'')!=='https'&&empty($c['allow_insecure_http'])))throw new RuntimeException('HTTPS app_url required.');
 date_default_timezone_set('Europe/Warsaw');
 return $c;
}
function matdraw_database(array $c): PDO {
 return new PDO($c['db']['dsn'],$c['db']['user'],$c['db']['password'],[
  PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,
  PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC,
  PDO::ATTR_EMULATE_PREPARES=>false,
 ]);
}
