<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Stripe webhook signature check (plan §6.4, report 03 §7.2), as the Stripe libraries do it. The header looks like
 * "t=1730380000,v1=<hex>,v1=<hex>,v0=<hex>"; the signed payload is "{t}.{raw body}" and the expected value is
 * HMAC-SHA256 with the whole whsec_… string as the key. Accepted when any v1 equals the expected value of any configured
 * secret (several v1 values and several secrets during a rotation), compared with hash_equals, and the timestamp lies
 * within ±$tolerance seconds (replay window). v0 (test scheme) is ignored. Verify the raw body before decoding it.
 */
final class StripeSignature {
 public const TOLERANCE=300;
 /** @param list<string> $secrets */
 public static function verify(string $payload,string $header,array $secrets,int $tolerance=self::TOLERANCE,?int $now=null):bool {
  $t=null;$sigs=[];
  foreach(explode(',',$header) as $part){[$k,$v]=array_pad(explode('=',trim($part),2),2,'');
   if($k==='t'&&$v!==''&&ctype_digit($v)&&strlen($v)<=12)$t=(int)$v;elseif($k==='v1'&&preg_match('/^[0-9a-f]{64}$/D',$v))$sigs[]=$v;}
  $secrets=array_values(array_filter($secrets,fn($s)=>is_string($s)&&$s!==''));
  if($t===null||!$sigs||!$secrets)return false;
  if(abs(($now??time())-$t)>$tolerance)return false;
  foreach($secrets as $s){$exp=hash_hmac('sha256',$t.'.'.$payload,$s);foreach($sigs as $sig)if(hash_equals($exp,$sig))return true;}
  return false;
 }
}
