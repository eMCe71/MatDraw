<?php
declare(strict_types=1);
namespace MatDraw;
final class Rules {
 public const EVENTS=['forms'=>'Układy formalne','soft'=>'Walki soft / kalaki','hogo'=>'Walki Hogo','semi'=>'Walki semi contact','light'=>'Walki light contact','special'=>'Techniki specjalne','power'=>'Testy siły'];
 public static function group(int $age):?string{return $age<7?null:($age<=9?'youth':($age<=12?'cadet':($age<=15?'younger':($age<=18?'junior':($age<=35?'senior':'veteran')))));}
 public static function eligibility(array $a,string $event):?string {
  $g=self::group((int)$a['age']);if(!$g)return 'Brak kategorii dla wieku poniżej 7 lat';
  $allowed=['youth'=>['forms','soft','special'],'cadet'=>['forms','hogo','special'],'younger'=>['forms','semi','special'],'junior'=>['forms','light','special','power'],'senior'=>['forms','light','special','power'],'veteran'=>['forms','light','special','power']];
  if(!in_array($event,$allowed[$g],true))return 'Konkurencja niedostępna w tej grupie wieku';
  if($g==='junior'&&$event==='light'&&$a['gradeType']==='cup'&&$a['grade']>6)return 'Light contact juniorów wymaga co najmniej 6 Cup';
  if($a['gradeType']==='dan'&&$a['age']<16)return 'Kategorie Dan poniżej 16 lat nie są opisane';
  if($a['gradeType']==='dan'&&$a['grade']>($g==='junior'?3:4))return 'Stopień Dan poza kategoriami specyfikacji';
  return null;
 }
 public static function classify(array $a,string $event):array {
  if($e=self::eligibility($a,$event))return ['error'=>$e];
  $group=self::group((int)$a['age']);$groupKey=$group;
  $labels=$a['sex']==='F'?['youth'=>'Młodziczki','cadet'=>'Kadetki','younger'=>'Juniorki młodsze','junior'=>'Juniorki','senior'=>'Seniorki','veteran'=>'Weteranki']:['youth'=>'Młodzicy','cadet'=>'Kadeci','younger'=>'Juniorzy młodsi','junior'=>'Juniorzy','senior'=>'Seniorzy','veteran'=>'Weterani'];
  $ageLabel=$labels[$group];$sexLabel=$a['sex']==='M'?'mężczyźni':'kobiety';
  if($group==='veteran'&&($a['gradeType']==='dan'||in_array($event,['special','power'],true))){if($a['age']===45)return ['error'=>'Wiek 45 lat: nakładające się grupy w regulaminie'];$v=$a['age']<45?'36-45':($a['age']<=55?'45-55':'56+');$groupKey.='-'.$v;$ageLabel.=' '.str_replace('-','–',$v).' lat';}
  if($event==='forms')$band=$a['gradeType']==='dan'?$a['grade'].' Dan':($group==='youth'?($a['grade']>=7?'10–7 Cup':'6–1 Cup'):($a['grade']>=7?'10–7 Cup':($a['grade']>=3?'6–3 Cup':'2–1 Cup')));
  elseif(in_array($event,['soft','hogo'],true)){$bounds=$event==='soft'?[115,125,135]:[135,145,155];$limit=self::limit($bounds,$a['height']);$band=is_finite($limit)?'do '.$limit.' cm':'powyżej '.end($bounds).' cm';}
  elseif(in_array($event,['semi','light'],true)){
   if($event==='semi'&&$a['sex']==='F')return ['error'=>'Juniorki młodsze: niejednoznaczne przedziały wagowe'];
   if($event==='light'&&$a['sex']==='F'&&$a['gradeType']==='cup')return ['error'=>'Kobiety Cup: przedziały 71–75 / 75+ wymagają ustalenia'];
   if($event==='semi')$bounds=[50,55,60,65,70,75];elseif($a['gradeType']==='cup')$bounds=[58,64,70,76,82,88];elseif($a['sex']==='M')$bounds=$group==='junior'?[52,58,63,70]:[54,63,71,80];else $bounds=$group==='junior'?[42,48,53,60]:[52,58,63,70];
   $registered=self::limit($bounds,$a['weight']);$actual=$a['actualWeight']??$a['weight'];$limit=isset($a['actualWeight'])&&$actual>=$a['weight']&&$actual<=$registered+.2+1e-8?$registered:self::limit($bounds,$actual);$band=is_finite($limit)?'do '.$limit.' kg':'powyżej '.end($bounds).' kg';
  }else $band='Lista startowa';
  $type=in_array($event,['special','power'],true)?'list':'bracket';$rank=$type==='list'?'all':$a['gradeType'];
  return ['id'=>implode('|',[$event,$groupKey,$a['sex'],$rank,$band]),'event'=>$event,'type'=>$type,'title'=>self::EVENTS[$event],'subtitle'=>implode(' · ',[$ageLabel,$sexLabel,$band])];
 }
 private static function limit(array $bounds,float|int $value):float|int{foreach($bounds as $v)if($value<=$v)return $v;return INF;}
 public static function validate(array $a):void {
  Domain::txt($a['name']??null,'imię i nazwisko');Domain::txt($a['club']??null,'klub');
  if(!in_array($a['sex']??null,['M','F'],true)||!in_array($a['gradeType']??null,['cup','dan'],true))throw new AppError('Sprawdź płeć i rodzaj stopnia.');
  Domain::number($a['age']??null,7,100,true);Domain::number($a['weight']??null,10,250);Domain::number($a['height']??null,70,250);Domain::number($a['grade']??null,1,$a['gradeType']==='cup'?10:9,true);
  if(!is_array($a['events']??null)||!count($a['events'])||count($a['events'])>7)throw new AppError('Wybierz co najmniej jedną konkurencję.');
  foreach($a['events'] as $event){if(!is_string($event)||!isset(self::EVENTS[$event]))throw new AppError('Nieznana konkurencja.');if($e=self::eligibility($a,$event))throw new AppError($e);}
 }
 public static function categories(array $entries):array{$map=[];foreach($entries as $a){if($a['presence']==='absent')continue;foreach($a['events'] as $e){$c=self::classify($a,$e);if(isset($c['error']))continue;$key=$c['id'];$map[$key]??=$c+['athletes'=>[]];$map[$key]['athletes'][]=$a;}}return $map;}
 public static function signature(array $a):string{$s=array_map(fn($x)=>$x['id'].':'.$x['club'].':'.(!empty($x['champion'])?'true':'false'),$a);sort($s,SORT_STRING);return implode(',',$s);}
 public static function slotOrder(int $size):array{$edge=[0,7,1,6,2,5,3,4];$order=match($size){8=>[0],16=>[0,1],32=>[0,3,1,2],64=>[0,7,3,4,1,6,2,5],default=>throw new AppError('Niepoprawny rozmiar drabinki.')};$r=[];foreach($edge as $p)foreach($order as $s)$r[]=$s*8+($s%2===0?$p:7-$p);return $r;}
 private static function pairs(array $slots,array &$pairs):array{if(count($slots)===1)return array_values(array_filter($slots));$n=intdiv(count($slots),2);$a=self::pairs(array_slice($slots,0,$n),$pairs);$b=self::pairs(array_slice($slots,$n),$pairs);if(count($a)===1&&count($b)===1)$pairs[]=[$a[0],$b[0]];return [...$a,...$b];}
 /** Same club for the draw (§6.3): equal club names, but 'unaffiliated' athletes are never separated (JS sameClub in engine.js). */
 public static function sameClub(array $a,array $b):bool{return ($a['club']??null)===($b['club']??null)&&($a['clubId']??null)!=='unaffiliated'&&($b['clubId']??null)!=='unaffiliated';}
 public static function makeDraw(array $a):array{
  $n=count($a);if($n<3||$n>64)throw new AppError('Drabinka wymaga od 3 do 64 zawodników.');$size=$n<=8?8:2**(int)ceil(log($n,2));$order=array_slice(self::slotOrder($size),0,$n);$map=array_column($a,null,'id');
  for($i=$n-1;$i>0;$i--){$j=random_int(0,$i);[$a[$i],$a[$j]]=[$a[$j],$a[$i]];}$slots=array_fill(0,$size,null);foreach($a as $i=>$p)$slots[$order[$i]]=$p['id'];
  $cost=static function($s)use($map){$pairs=[];self::pairs($s,$pairs);$c=0;foreach($pairs as [$a,$b])if(self::sameClub($map[$a],$map[$b]))$c+=10000;foreach($s as $i=>$id)if($id&&!empty($map[$id]['champion'])&&$s[$i^1])$c+=100;return $c;};$score=$cost($slots);
  for($k=0;$k<2500&&$score>0;$k++){$i=$order[random_int(0,$n-1)];$j=$order[random_int(0,$n-1)];[$slots[$i],$slots[$j]]=[$slots[$j],$slots[$i]];$next=$cost($slots);if($next>$score)[$slots[$i],$slots[$j]]=[$slots[$j],$slots[$i]];else $score=$next;}
  return ['size'=>$size,'slots'=>$slots,'seed'=>null,'results'=>[],'revision'=>1,'signature'=>self::signature($a),'createdAt'=>gmdate('c')];
 }
 public static function resolve(array $d):array{$prev=array_map(fn($id)=>['winner'=>$id,'settled'=>true],$d['slots']);$rounds=[];$number=1;for($r=0;count($prev)>1;$r++){$matches=[];for($i=0;$i<count($prev);$i+=2){$l=$prev[$i];$rt=$prev[$i+1];$key=$r.'-'.intdiv($i,2);$a=$l['winner'];$b=$rt['winner'];$ready=$l['settled']&&$rt['settled'];$record=$d['results'][$key]??null;$valid=$ready&&$a&&$b&&in_array($record,[$a,$b],true);$auto=$ready&&(!$a||!$b);$matches[]=['id'=>$key,'number'=>$number++,'round'=>$r,'index'=>intdiv($i,2),'a'=>$a,'b'=>$b,'aSettled'=>$l['settled'],'bSettled'=>$rt['settled'],'winner'=>$valid?$record:($auto?($a?:$b):null),'auto'=>$auto,'settled'=>$valid||$auto,'ready'=>(bool)($ready&&$a&&$b&&!$valid),'recorded'=>(bool)$valid];}$rounds[]=$matches;$prev=$matches;}return $rounds;}
 public static function result(array &$d,string $key,?string $winner):void{$rounds=self::resolve($d);$match=null;foreach($rounds as $r)foreach($r as $m)if($m['id']===$key)$match=$m;if(!$match)throw new AppError('Nie ma takiej walki.');if($winner&&(!$match['a']||!$match['b']||!$match['aSettled']||!$match['bSettled']||!in_array($winner,[$match['a'],$match['b']],true)))throw new AppError('Zwycięzca musi uczestniczyć w gotowej walce.');$i=$match['index'];for($r=$match['round']+1;$r<count($rounds);$r++){$i=intdiv($i,2);if(isset($d['results'][$r.'-'.$i]))throw new AppError('Najpierw wycofaj wynik w kolejnej rundzie.',409);}if($winner)$d['results'][$key]=$winner;else unset($d['results'][$key]);$d['revision']++;}
}
