<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Directories outside the release (plan §3.5, §7.5, §9.7). The deploy replaces the docroot and backend/ on every release,
 * so user data lives next to config.php: in production backend/config.php links to ~/matdraw/shared/config.php, which
 * makes shared() ~/matdraw/shared, sessions ~/matdraw/shared/sessions, uploads ~/matdraw/shared/uploads and backups
 * ~/matdraw/backups. No path is ever built from user input.
 */
final class Paths {
 /** Directory of the real config.php: flag files (maintenance, chat-off) and jobs-tick live here. */
 public static function shared(array $c):string{$p=Config::path();return dirname(realpath($p)?:$p);}
 /**
  * Own session directory or null: session_dir from config, else <shared>/sessions; only an existing, writable
  * directory outside the docroot. Null means PHP's default save path, which housekeeping never touches.
  */
 public static function ownSessions(array $c):?string {
  $dir=is_string($c['session_dir']??null)&&$c['session_dir']!==''?$c['session_dir']:self::shared($c).'/sessions';
  $real=realpath($dir);if($real===false||!is_dir($real)||!is_writable($real)||self::inDocroot($dir))return null;
  return $real;
 }
 /** Where PHP keeps session files for this app (own directory, else the configured save path without the "N;MODE;" prefix). */
 public static function sessions(array $c):string{return self::ownSessions($c)??self::savePath((string)session_save_path())[0];}
 /** [directory, subdirectory depth] of a session.save_path value "path", "N;path" or "N;MODE;path". */
 public static function savePath(string $value):array {
  $parts=explode(';',$value);$dir=array_pop($parts);$depth=count($parts)?(int)$parts[0]:0;
  return [$dir!==''?$dir:sys_get_temp_dir(),$depth];
 }
 /** Avatar storage: uploads_dir, else <shared>/uploads. Refuses a directory inside the docroot (RuntimeException). */
 public static function uploads(array $c):string {
  $dir=is_string($c['uploads_dir']??null)&&$c['uploads_dir']!==''?$c['uploads_dir']:self::shared($c).'/uploads';
  if(self::inDocroot($dir))throw new \RuntimeException('The uploads directory must be outside the public document root.');
  return self::resolve($dir);
 }
 /** ~/matdraw/backups when config.php lies in a directory named shared (the deploy layout, as in bin/dump.php), else null. */
 public static function backups(array $c):?string{$s=self::shared($c);return basename($s)==='shared'?dirname($s).'/backups':null;}
 /** Every directory the web server may serve (DOCUMENT_ROOT and the release/site public directories), as given and resolved. */
 public static function docroots():array {
  $out=[];$site=dirname(__DIR__,2);
  foreach([$_SERVER['DOCUMENT_ROOT']??'',$site.'/public',$site.'/public_html'] as $d)if(is_string($d)&&$d!==''&&($r=realpath($d))!==false&&is_dir($r)){$out[$r]=$r;$l=self::lexical($d);$out[$l]=$l;}
  return array_values($out);
 }
 /** Whether $path lies in a docroot, compared both as written (a symlink inside the docroot is served) and resolved. */
 public static function inDocroot(string $path):bool {
  foreach(array_unique([self::lexical($path),self::resolve($path)]) as $p)foreach(self::docroots() as $root)if($p===$root||str_starts_with($p,rtrim($root,'/').'/'))return true;
  return false;
 }
 /** Absolute path with "." and ".." removed without looking at the file system. */
 public static function lexical(string $path):string {
  if($path===''||$path[0]!=='/')$path=getcwd().'/'.$path;$out=[];
  foreach(explode('/',$path) as $part){if($part===''||$part==='.')continue;if($part==='..')array_pop($out);else $out[]=$part;}
  return '/'.implode('/',$out);
 }
 /** Absolute path with symlinks and ".." of the longest existing prefix resolved (the rest may not exist yet). */
 public static function resolve(string $path):string {
  if($path===''||$path[0]!=='/')$path=getcwd().'/'.$path;
  $rest=[];$p=$path;
  while(($real=realpath($p))===false){$b=basename($p);if($b!==''&&$b!=='.')array_unshift($rest,$b);$parent=dirname($p);if($parent===$p){$real='/';break;}$p=$parent;}
  $out=rtrim($real,'/');
  foreach($rest as $part){if($part==='..'){$out=dirname($out);continue;}$out.='/'.$part;}
  return $out===''?'/':$out;
 }
}
