<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Public (unauthenticated) read-only projection for the login screen and the guest preview.
 * Every field a guest can receive is listed here; nothing is copied wholesale from stored records.
 *  - upcoming():   id, name, date, city, status of tournaments that are not drafts and are dated today or later
 *                  (Europe/Warsaw), nearest first, at most LIMIT.
 *  - tournament(): the same five tournament fields, aggregate counts, categories (code, event, labels, size, state)
 *                  and saved brackets in which every athlete is reduced to initials ("J. K.") and club name.
 * Never sent: full names, birth dates, ages, weights, heights, grades of athletes, check-in/presence, champion flags,
 * e-mails, accounts, entry/profile/club/user ids, creators, mats, activity, revisions, draft or past tournaments.
 * Community tournaments (PLAN-REJESTRACJA-ROLE §5.6; Repository::guestTournaments adds community, trusted and the
 * current club of every entry): the summary gets the sparse fields community:true and trusted (staff tournaments keep
 * exactly the five fields); upcoming() lists only staff tournaments and trusted community ones (the others are public
 * under their own address only); a bracket slot shows the current name of a verified club (after a merge: the target),
 * null for an unverified club and '' for 'unaffiliated'; summary.clubs does not count 'unaffiliated'.
 * Self-entries (§7.1, §10.1): tournament() adds the sparse field selfEntry:true while the tournament takes them (open,
 * self-entries on), so the preview offers "Załóż konto zawodnika i zgłoś się" only there; upcoming() never carries it.
 * categoryList() and bracket() are public for AthleteView (same codes and order as tournament()).
 * dist/guest-view.js mirrors this class for the browser demo; tests/php.test.mjs checks that both agree.
 */
final class GuestView {
 public const LIMIT=6;
 private const STATUSES=['open','closed','finished'];
 private const PREFIX=['forms'=>'UF','soft'=>'SO','hogo'=>'HG','semi'=>'SC','light'=>'LC','special'=>'TS','power'=>'SI'];

 public static function visible(array $t,string $today):bool{return in_array($t['status']??null,self::STATUSES,true)&&is_string($t['date']??null)&&$t['date']>=$today;}
 private static function summary(array $t,bool $detail=false):array{$s=['id'=>(string)$t['id'],'name'=>(string)$t['name'],'date'=>(string)$t['date'],'city'=>(string)$t['city'],'status'=>(string)$t['status']];if(!empty($t['community'])){$s['community']=true;$s['trusted']=!empty($t['trusted']);}if($detail&&$s['status']==='open'&&($t['selfEntry']??false)===true)$s['selfEntry']=true;return $s;}
 private static function listed(array $t):bool{return empty($t['community'])||!empty($t['trusted']);}

 public static function upcoming(array $tournaments,string $today,int $limit=self::LIMIT):array{
  $list=array_values(array_filter($tournaments,fn($t)=>is_array($t)&&self::visible($t,$today)&&self::listed($t)));
  usort($list,fn($a,$b)=>strcmp($a['date'],$b['date'])?:strcmp((string)$a['name'],(string)$b['name'])?:strcmp((string)$a['id'],(string)$b['id']));
  return ['tournaments'=>array_map([self::class,'summary'],array_slice($list,0,$limit))];
 }

 /** "Jan Kowalski" → "J. K."; first given name + last surname; a hyphenated surname keeps both parts ("K.-N."). */
 public static function initials(string $name):string{
  if(class_exists(\Normalizer::class))$name=\Normalizer::normalize($name,\Normalizer::FORM_C)?:$name;
  $words=preg_split('/\s+/u',trim($name),-1,PREG_SPLIT_NO_EMPTY)?:[];
  $letter=static fn(string $w):string=>preg_match('/\p{L}/u',$w,$m)?mb_strtoupper($m[0],'UTF-8').'.':'';
  if(!$words)return '?';
  $last=count($words)>1?implode('-',array_filter(array_map($letter,preg_split('/[-\x{2010}\x{2011}\x{2013}]/u',end($words))?:[]))):'';
  return implode(' ',array_filter([$letter($words[0]),$last]))?:'?';
 }

 /** Club of a public bracket slot: the current club (Repository::guestTournaments), else the snapshot ('' for 'unaffiliated'). */
 private static function slotClub(array $a):?string{
  if(is_array($a['currentClub']??null))return ($a['currentClub']['name']??null)===null?null:(string)$a['currentClub']['name'];
  return ($a['clubId']??null)==='unaffiliated'?'':(string)($a['club']??'');
 }
 /** A saved draw as a public bracket: slots hold only initials and club; winners are slot positions. */
 public static function bracket(mixed $d,array $athletes):?array{
  if(!is_array($d)||!is_array($d['slots']??null)||!in_array($d['size']??null,[8,16,32,64],true)||count($d['slots'])!==$d['size'])return null;
  $byId=[];foreach($athletes as $a)$byId[(string)$a['id']]=$a;
  $slots=[];$position=[];
  foreach(array_values($d['slots']) as $i=>$entryId){
   if($entryId===null){$slots[]=null;continue;}
   $entryId=(string)$entryId;if(!isset($byId[$entryId])||isset($position[$entryId]))return null;
   $position[$entryId]=$i;$slots[]=['initials'=>self::initials((string)$byId[$entryId]['name']),'club'=>self::slotClub($byId[$entryId])];
  }
  if(count($position)!==count($byId))return null;
  $stored=is_array($d['results']??null)?$d['results']:[];$results=[];
  foreach($stored as $match=>$winner)if(is_string($winner)&&isset($position[$winner])&&preg_match('/^\d+-\d+$/D',(string)$match))$results[(string)$match]=$position[$winner];
  $rounds=Rules::resolve(['slots'=>array_values($d['slots']),'results'=>$stored]);$final=end($rounds)[0]['winner']??null;
  return ['state'=>$final?'finished':(count($results)?'progress':'drawn'),'bracket'=>['size'=>$d['size'],'slots'=>$slots,'results'=>(object)$results]];
 }

 public static function tournament(array $tournaments,string $id,string $today):?array{
  $t=null;foreach($tournaments as $x)if(is_array($x)&&($x['id']??null)===$id&&self::visible($x,$today))$t=$x;
  if(!$t)return null;
  $entries=array_values(is_array($t['entries']??null)?$t['entries']:[]);$draws=is_array($t['draws']??null)?$t['draws']:[];
  $categories=array_column(self::categoryList($entries,$draws),'public');$brackets=count(array_filter($categories,fn($c)=>$c['bracket']!==null));
  $clubs=[];foreach($entries as $e){$k=(string)($e['currentClub']['id']??$e['clubId']??$e['club']??'');if($k!=='unaffiliated')$clubs[$k]=true;}
  return ['tournament'=>self::summary($t,true),'summary'=>['entries'=>count($entries),'clubs'=>count($clubs),'categories'=>count($categories),'brackets'=>$brackets],'categories'=>$categories];
 }
 /**
  * Categories of a tournament in public order (the order and codes of categories() in dist/engine.js: event, then size,
  * then id): [{id, athletes (entries), public (the category exactly as tournament() sends it)}].
  */
 public static function categoryList(array $entries,array $draws):array{
  $cats=array_values(Rules::categories(array_values($entries)));$events=array_keys(Rules::EVENTS);
  usort($cats,fn($a,$b)=>array_search($a['event'],$events,true)<=>array_search($b['event'],$events,true)?:count($b['athletes'])<=>count($a['athletes'])?:strcmp($a['id'],$b['id']));
  $counters=[];$out=[];
  foreach($cats as $c){
   $counters[$c['event']]=($counters[$c['event']]??0)+1;$size=count($c['athletes']);
   $b=$c['type']==='bracket'&&$size>=3?self::bracket($draws[$c['id']]??null,$c['athletes']):null;
   $out[]=['id'=>$c['id'],'athletes'=>$c['athletes'],'public'=>['code'=>self::PREFIX[$c['event']].'-'.str_pad((string)$counters[$c['event']],2,'0',STR_PAD_LEFT),'event'=>$c['event'],'type'=>$c['type'],'title'=>$c['title'],'subtitle'=>$c['subtitle'],'gradeType'=>explode('|',$c['id'])[3],'athletes'=>$size,'state'=>$c['type']==='list'?'list':($size<3?'underfilled':($b['state']??'pending')),'bracket'=>$b['bracket']??null]];
  }
  return $out;
 }
}
