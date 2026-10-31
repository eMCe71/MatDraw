<?php
declare(strict_types=1);
// Domain.php also defines AppError, the base of every API error; every other class MatDraw\X loads from src/X.php.
require_once __DIR__.'/src/Domain.php';
spl_autoload_register(static function(string $class):void{
 if(!str_starts_with($class,'MatDraw\\'))return;$name=substr($class,8);
 if(preg_match('/^[A-Za-z0-9]+$/D',$name)&&is_file($file=__DIR__.'/src/'.$name.'.php'))require_once $file;
});

/** config.php merged over MatDraw\Config::DEFAULTS (Załącznik A) and validated (§6.8); throws RuntimeException. */
function matdraw_config(): array {
 $path=MatDraw\Config::path();
 if(!is_file($path))throw new RuntimeException('Missing server configuration.');
 $c=require $path;
 if(!is_array($c)||!is_string($c['app_key']??null)||strlen($c['app_key'])<64||str_starts_with($c['app_key'],'REPLACE_'))throw new RuntimeException('Invalid server configuration.');
 $url=parse_url($c['app_url']??'');
 if(!$url||empty($url['host'])||(($url['scheme']??'')!=='https'&&empty($c['allow_insecure_http'])))throw new RuntimeException('HTTPS app_url required.');
 $c=array_replace(MatDraw\Config::DEFAULTS,$c);MatDraw\Config::validate($c);
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
