<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Client address for rate limits (plan §3.5). REMOTE_ADDR, unless config names a proxy header (trusted_proxy_header,
 * e.g. 'X-Forwarded-For') and REMOTE_ADDR is one of trusted_proxies (IPs or CIDR ranges): then the right-most address
 * of that header that is not itself a trusted proxy. Off by default. bucket() groups IPv6 by /64 (one household or
 * phone network), so a single device cannot evade limits by rotating its interface id; IPv4 is used unchanged.
 * Buckets are only ever stored as HMACs (RateLimit), never as addresses.
 */
final class ClientIp {
 public static function get(array $c):string {
  $remote=(string)($_SERVER['REMOTE_ADDR']??'');$h=$c['trusted_proxy_header']??null;$proxies=(array)($c['trusted_proxies']??[]);
  if(is_string($h)&&preg_match('/^[A-Za-z0-9-]{1,64}$/D',$h)&&$remote!==''&&self::trusted($remote,$proxies)){
   $value=$_SERVER['HTTP_'.strtoupper(str_replace('-','_',$h))]??'';
   foreach(array_reverse(explode(',',is_string($value)?$value:'')) as $ip){
    $ip=trim($ip);if(!filter_var($ip,FILTER_VALIDATE_IP))break;
    if(!self::trusted($ip,$proxies))return $ip;
   }
  }
  return $remote;
 }
 public static function bucket(array $c):string{return self::bucketOf(self::get($c));}
 /** IPv4 (also IPv4-mapped IPv6) unchanged, IPv6 as "<prefix>::/64", anything else 'unknown'. */
 public static function bucketOf(string $ip):string {
  $bin=filter_var($ip,FILTER_VALIDATE_IP)?inet_pton($ip):false;if($bin===false)return 'unknown';
  if(strlen($bin)===4)return (string)inet_ntop($bin);
  if(str_starts_with($bin,str_repeat("\0",10)."\xff\xff"))return (string)inet_ntop(substr($bin,12));
  return inet_ntop(substr($bin,0,8).str_repeat("\0",8)).'/64';
 }
 /** Whether $ip equals an entry of $list or lies in one of its CIDR ranges. */
 public static function trusted(string $ip,array $list):bool {
  $bin=filter_var($ip,FILTER_VALIDATE_IP)?inet_pton($ip):false;if($bin===false)return false;
  foreach($list as $entry){
   if(!is_string($entry))continue;[$net,$bits]=array_pad(explode('/',trim($entry),2),2,null);
   $n=filter_var($net,FILTER_VALIDATE_IP)?inet_pton($net):false;if($n===false||strlen($n)!==strlen($bin))continue;
   $max=strlen($n)*8;$bits=$bits===null?$max:(ctype_digit($bits)?(int)$bits:-1);if($bits<0||$bits>$max)continue;
   $full=intdiv($bits,8);$rest=$bits%8;
   if(substr($bin,0,$full)!==substr($n,0,$full))continue;
   if($rest&&((ord($bin[$full])^ord($n[$full]))&(0xff<<(8-$rest)&0xff)))continue;
   return true;
  }
  return false;
 }
}
