<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * What this PHP build can do for profile photos (plan §7.5). avatarMode(): 'gd-webp' (GD reads JPEG/PNG/WebP and writes
 * WebP) > 'gd-jpeg' (GD writes JPEG only) > 'off'. There is deliberately no mode without GD: a hand-written parser of
 * untrusted image files is a needless risk, and initials always work. avatars_enabled is the caller's switch
 * (routes/core.php, Avatars); this class only describes the server. memoryLimit() parses memory_limit with K/M/G
 * suffixes; -1 (no limit) is returned as -1.
 */
final class Capabilities {
 public static function avatarMode(array $c=[]):string {
  if(!function_exists('imagecreatefromstring')||!function_exists('imagecreatetruecolor')||!function_exists('imagecopyresampled')||!function_exists('getimagesizefromstring'))return 'off';
  $gd=function_exists('gd_info')?gd_info():[];
  if(function_exists('imagewebp')&&!empty($gd['WebP Support']))return 'gd-webp';
  if(function_exists('imagejpeg')&&!empty($gd['JPEG Support']))return 'gd-jpeg';
  return 'off';
 }
 /** IMAGETYPE_* values GD of this build can decode, among JPEG, PNG and WebP (never GIF or SVG). */
 public static function readable():array {
  if(!function_exists('imagetypes'))return [];$t=imagetypes();$out=[];
  foreach([[IMAGETYPE_JPEG,IMG_JPG],[IMAGETYPE_PNG,IMG_PNG],[IMAGETYPE_WEBP,IMG_WEBP]] as [$type,$bit])if($t&$bit)$out[]=$type;
  return $out;
 }
 /** {webp, jpeg, png} support of GD for diagnostics. */
 public static function gd():array {
  $gd=function_exists('gd_info')?gd_info():[];
  return ['webp'=>!empty($gd['WebP Support']),'jpeg'=>!empty($gd['JPEG Support']),'png'=>!empty($gd['PNG Support'])];
 }
 /** memory_limit in bytes, or -1 for no limit. */
 public static function memoryLimit():int{return self::bytes((string)ini_get('memory_limit'));}
 /** "128M" → 134217728, "1G", "512K", "1048576"; "-1" (or any negative) → -1; an empty or unreadable value → -1. */
 public static function bytes(string $value):int {
  $v=trim($value);if($v===''||!preg_match('/^(-?\d+)\s*([KMG]?)B?$/iD',$v,$m))return -1;
  $n=(int)$m[1];if($n<0)return -1;
  return match(strtoupper($m[2])){'K'=>$n*1024,'M'=>$n*1048576,'G'=>$n*1073741824,default=>$n};
 }
}
