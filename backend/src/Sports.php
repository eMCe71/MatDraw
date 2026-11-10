<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Martial arts of the home page and their federations (owner's list and order, 2026-11-10): the server half of dist/sports.js
 * (ids, federations and chat channels; names and colours live in the browser). tests/sports.test.mjs checks that both agree.
 *  - tournaments.sport / tournaments.federation (migration 0010): Domain validates them on tournament.save, GuestView filters the
 *    public list by them, Chat lists the tournament channels with them.
 *  - LOBBY: the global chat channels per sport, slug => [sport, federation or null], in display order (Chat::lists). A sport
 *    with fewer than two federations has only its general channel. Taekwondo keeps the existing 'taekwondo-pl' row as its general
 *    channel; RETIRED are the channels of the old PL/world split: rows and messages stay, nobody sees them (Chat::visibleFor).
 *    Channels missing in the database are created when a signed-in person reads the lists (migrations never insert rows of
 *    existing tables: CI back-compat job); guests see them as {id: null} until then.
 */
final class Sports {
 public const DEFAULT='taekwondo';
 /** sport => federation ids in display order. */
 public const FEDERATIONS=[
  'taekwondo'=>['uitf','itf','wt'],
  'karate'=>['wkf','kyokushin','itkf'],
  'boxing'=>['worldboxing','iba'],
  'judo'=>['ijf'],
  'kickboxing'=>['wako'],
  'bjj'=>['ibjjf'],
  'muaythai'=>['ifma','wmc'],
  'mma'=>['immaf','almma'],
 ];
 public const LOBBY=[
  'taekwondo-pl'=>['taekwondo',null],'taekwondo-uitf'=>['taekwondo','uitf'],'taekwondo-itf'=>['taekwondo','itf'],'taekwondo-wt'=>['taekwondo','wt'],
  'karate'=>['karate',null],'karate-wkf'=>['karate','wkf'],'karate-kyokushin'=>['karate','kyokushin'],'karate-itkf'=>['karate','itkf'],
  'boxing'=>['boxing',null],'boxing-worldboxing'=>['boxing','worldboxing'],'boxing-iba'=>['boxing','iba'],
  'judo'=>['judo',null],
  'kickboxing'=>['kickboxing',null],
  'bjj'=>['bjj',null],
  'muaythai'=>['muaythai',null],'muaythai-ifma'=>['muaythai','ifma'],'muaythai-wmc'=>['muaythai','wmc'],
  'mma'=>['mma',null],'mma-immaf'=>['mma','immaf'],'mma-almma'=>['mma','almma'],
 ];
 public const RETIRED=['taekwondo','general'];

 public static function valid(mixed $sport):bool{return is_string($sport)&&isset(self::FEDERATIONS[$sport]);}
 public static function federationValid(string $sport,mixed $fed):bool{return is_string($fed)&&in_array($fed,self::FEDERATIONS[$sport]??[],true);}
 /** The sport of a stored tournament (taekwondo before migration 0010 or for an unknown value) and its federation (null: none or unknown). */
 public static function of(array $t):string{return self::valid($t['sport']??null)?$t['sport']:self::DEFAULT;}
 public static function federationOf(array $t):?string{$fed=$t['federation']??null;return self::federationValid(self::of($t),$fed)?$fed:null;}
 /** Position of a lobby slug in the display order (Chat::lists), PHP_INT_MAX for one the catalogue does not list. */
 public static function order(?string $slug):int{$i=$slug===null?false:array_search($slug,array_keys(self::LOBBY),true);return $i===false?PHP_INT_MAX:$i;}
}
