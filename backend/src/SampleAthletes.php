<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Fictional sample athletes for testing (backend/bin/seed-athletes.php).
 * Athlete i goes to planned category i % count(PLAN), so 90 athletes give 5 in each of 18 categories,
 * plus three list categories from second events. Every planned category avoids the blocked rules
 * (female semi contact, female Cup light contact, Dan under 16, veteran age 45).
 */
final class SampleAthletes {
 /** Marks the sample clubs; --remove deletes only clubs with this suffix. */
 public const SUFFIX=' (demo)';
 public const CLUBS=['UKS Orlik','KS Smok','Akademia Tygrys','TKD Feniks','Klub Sokół','UKS Jastrząb'];
 /** event, sex, age range, grade type, grade range, optional weight/height range, second event. */
 public const PLAN=[
  ['forms','M',[7,9],'cup',[7,10],null,null,'special'],
  ['forms','F',[7,9],'cup',[7,10]],
  ['soft','M',[7,9],'cup',[8,10],null,[116,125]],
  ['soft','F',[7,9],'cup',[8,10],null,[126,135]],
  ['forms','M',[10,12],'cup',[3,6]],
  ['forms','F',[10,12],'cup',[7,9]],
  ['hogo','M',[10,12],'cup',[5,9],null,[136,145]],
  ['hogo','F',[10,12],'cup',[5,9],null,[136,145]],
  ['forms','M',[13,15],'cup',[3,6]],
  ['semi','M',[13,15],'cup',[3,7],[50.5,55]],
  ['forms','F',[13,15],'cup',[1,2]],
  ['light','M',[16,18],'cup',[1,6],[58.5,64]],
  ['forms','F',[16,18],'dan',[1,1]],
  ['light','M',[19,35],'cup',[1,6],[64.5,70],null,'power'],
  ['light','M',[19,35],'dan',[1,2],[63.5,71],null,'power'],
  ['light','F',[19,35],'dan',[1,3],[52.5,58],null,'special'],
  ['forms','F',[19,35],'cup',[3,6],null,null,'special'],
  ['forms','M',[36,50],'cup',[7,10]],
 ];
 private const MALE=['Adam','Antoni','Bartosz','Borys','Dawid','Dominik','Filip','Franciszek','Hubert','Igor','Jakub','Jan','Julian','Kacper','Karol','Kamil','Krystian','Leon','Maciej','Marcel','Mateusz','Michał','Mikołaj','Nikodem','Oliwer','Oskar','Patryk','Paweł','Piotr','Radosław','Stanisław','Szymon','Tadeusz','Tymon','Wiktor','Witold','Wojciech','Zbigniew'];
 private const FEMALE=['Agata','Aleksandra','Alicja','Amelia','Anna','Antonina','Barbara','Emilia','Ewa','Gabriela','Hanna','Helena','Iga','Julia','Joanna','Kalina','Karolina','Katarzyna','Laura','Lena','Liliana','Magdalena','Maja','Marta','Michalina','Natalia','Nina','Oliwia','Pola','Róża','Weronika','Wiktoria','Zofia','Zuzanna'];
 /** Masculine and feminine form of each surname. */
 private const SURNAMES=[['Nowak','Nowak'],['Kowalski','Kowalska'],['Wiśniewski','Wiśniewska'],['Wójcik','Wójcik'],['Kamiński','Kamińska'],['Lewandowski','Lewandowska'],['Zieliński','Zielińska'],['Szymański','Szymańska'],['Woźniak','Woźniak'],['Dąbrowski','Dąbrowska'],['Kozłowski','Kozłowska'],['Jankowski','Jankowska'],['Mazur','Mazur'],['Kwiatkowski','Kwiatkowska'],['Krawczyk','Krawczyk'],['Piotrowski','Piotrowska'],['Grabowski','Grabowska'],['Nowakowski','Nowakowska'],['Pawłowski','Pawłowska'],['Michalski','Michalska'],['Adamczyk','Adamczyk'],['Dudek','Dudek'],['Zając','Zając'],['Wieczorek','Wieczorek'],['Jabłoński','Jabłońska'],['Król','Król'],['Majewski','Majewska'],['Olszewski','Olszewska'],['Jaworski','Jaworska'],['Malinowski','Malinowska'],['Stępień','Stępień'],['Górski','Górska'],['Rutkowski','Rutkowska'],['Sikora','Sikora'],['Baran','Baran'],['Ostrowski','Ostrowska'],['Czarnecki','Czarnecka'],['Sadowski','Sadowska']];

 public static function clubNames():array {return array_map(fn($n)=>$n.self::SUFFIX,self::CLUBS);}

 /**
  * @param string $date reference date (tournament day): ages are exact on this day
  * @return list<array{name:string,sex:string,birthDate:string,weight:float,height:float,gradeType:string,grade:int,events:list<string>,champion:bool,club:int}>
  */
 public static function generate(int $count,string $date,int $seed):array {
  mt_srand($seed);
  $out=[];$used=[];$ref=new \DateTimeImmutable($date);
  for($i=0;$i<$count;$i++){
   $k=$i%count(self::PLAN);$round=intdiv($i,count(self::PLAN));
   [$event,$sex,$ages,$gradeType,$grades,$weights,$heights,$second]=self::PLAN[$k]+[5=>null,6=>null,7=>null];
   do{
    $s=self::SURNAMES[mt_rand(0,count(self::SURNAMES)-1)][$sex==='M'?0:1];
    $first=$sex==='M'?self::MALE[mt_rand(0,count(self::MALE)-1)]:self::FEMALE[mt_rand(0,count(self::FEMALE)-1)];
    $name="$first $s";
   }while(isset($used[$name]));
   $used[$name]=true;
   $age=mt_rand($ages[0],$ages[1]);
   // Born 0–360 days before the birthday that makes them $age on the reference date.
   $birth=$ref->modify("-$age years")->modify('-'.mt_rand(0,360).' days')->format('Y-m-d');
   if($weights){
    $weight=self::decimal($weights[0],$weights[1]);
    $height=round(sqrt($weight/self::bmi($age,$sex))*100);
   }else{
    $height=$heights?mt_rand($heights[0],$heights[1]):self::height($age,$sex);
    $weight=round(self::bmi($age,$sex)*($height/100)**2,1);
   }
   $out[]=['name'=>$name,'sex'=>$sex,'birthDate'=>$birth,'weight'=>$weight,'height'=>(float)$height,'gradeType'=>$gradeType,'grade'=>mt_rand($grades[0],$grades[1]),
    'events'=>$second?[$event,$second]:[$event],
    // One seeded champion in every third bracket category.
    'champion'=>$round===0&&$k%3===1&&!in_array($event,['special','power'],true),
    // Consecutive athletes of a category come from different clubs.
    'club'=>($k+$round)%count(self::CLUBS)];
  }
  return $out;
 }
 private static function decimal(float $min,float $max):float {return round($min+($max-$min)*mt_rand()/mt_getrandmax(),1);}
 private static function bmi(int $age,string $sex):float {
  $base=$age<=12?16.0:($age<=18?19.5:($sex==='M'?22.5:21.0));
  return $base+mt_rand(-10,15)/10;
 }
 private static function height(int $age,string $sex):int {
  $h=$age<=15?77+6*$age:($sex==='M'?178:166);
  if($age<=15&&$sex==='F'&&$age>=13)$h-=4;
  return (int)$h+mt_rand(-6,6);
 }
}
