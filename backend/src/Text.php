<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Normalisation of every free text a person writes (plan §5.5, §7.1, §10): chat messages, club text, report comments,
 * moderator notes, mute reasons and the Admin notice. dist/profile-data.js cleanText() mirrors this function exactly
 * (tests/community.test.mjs runs shared cases), so every step is listed here, in order:
 *  1. not a string, or not valid UTF-8 → null (the caller answers with its own message);
 *  2. Unicode NFC when ext-intl is available;
 *  3. multiline: "\r\n" and "\r" become "\n";
 *  4. "\t" becomes a space;
 *  5. every \p{Cc} control character is removed, except "\n" in multiline mode (single-line mode removes "\n" too);
 *  6. every \p{Cf} format character is removed except U+200D (zero-width joiner, keeps emoji sequences): bidi controls
 *     U+202A–U+202E and U+2066–U+2069, marks U+200E, U+200F, U+061C, zero-width U+200B, U+200C, U+2060, U+FEFF, …;
 *  7. leading and trailing white space ([\s\p{Z}], so also U+00A0) is trimmed;
 *  8. multiline only: lines holding only white space become empty, runs of more than 2 empty lines shrink to 2, and a
 *     text of more than 20 lines keeps lines 1–19 and joins the non-empty rest into line 20 with single spaces;
 *     then step 7 again.
 * The result may be ''. Length rules and their messages belong to the caller (e.g. chat: 1–1000 characters, mb_strlen).
 */
final class Text {
 public const MAX_LINES=20,MAX_EMPTY_RUN=2;
 public static function clean(mixed $s,array $options=[]):?string {
  if(!is_string($s)||!mb_check_encoding($s,'UTF-8'))return null;
  $multi=!empty($options['multiline']);
  if(class_exists(\Normalizer::class)){$n=\Normalizer::normalize($s,\Normalizer::FORM_C);if(is_string($n))$s=$n;}
  if($multi)$s=str_replace(["\r\n","\r"],"\n",$s);
  $s=str_replace("\t",' ',$s);
  $s=(string)preg_replace($multi?'/(?!\n)\p{Cc}/u':'/\p{Cc}/u','',$s);
  $s=self::trim((string)preg_replace('/(?!\x{200D})\p{Cf}/u','',$s));
  if(!$multi||!str_contains($s,"\n"))return $s;
  $lines=[];$empty=0;
  foreach(explode("\n",$s) as $line){
   if(self::trim($line)===''){if(++$empty>self::MAX_EMPTY_RUN)continue;$lines[]='';}else{$empty=0;$lines[]=$line;}
  }
  if(count($lines)>self::MAX_LINES){
   $rest=array_values(array_filter(array_map([self::class,'trim'],array_slice($lines,self::MAX_LINES-1)),fn($l)=>$l!==''));
   $lines=[...array_slice($lines,0,self::MAX_LINES-1),implode(' ',$rest)];
  }
  return self::trim(implode("\n",$lines));
 }
 /** Trims [\s\p{Z}] (ASCII white space and every Unicode space separator) at both ends. */
 public static function trim(string $s):string{return (string)preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u','',$s);}
}
