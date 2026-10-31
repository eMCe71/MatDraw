<?php
declare(strict_types=1);
/*
 * Fictional sample athletes for testing. CLI only.
 *
 *   php backend/bin/seed-athletes.php --dry-run [--date=2026-11-14]   preview, no database
 *   php backend/bin/seed-athletes.php [--tournament=ID|"Name"]        add 90 athletes (and enter them)
 *   php backend/bin/seed-athletes.php --list                          list tournaments
 *   php backend/bin/seed-athletes.php --remove                        delete all sample data again
 *
 * Options: --count=90, --seed=2026, --admin=e-mail (default: first active administrator).
 * Athletes are saved through Domain::execute, so the application's own validation applies.
 * They belong to six clubs ending in " (demo)"; --remove deletes those clubs, their profiles,
 * entries and any draws that contain them. Clubs with user accounts are never deleted.
 */
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
require_once dirname(__DIR__).'/src/SampleAthletes.php';
use MatDraw\{Domain,Repository,Rules,SampleAthletes};

$opts=getopt('',['dry-run','list','remove','tournament:','count:','seed:','admin:','date:']);
$out=fn(string $s)=>fwrite(STDOUT,$s."\n");
try {
 $count=(int)($opts['count']??90);$seed=(int)($opts['seed']??2026);
 if($count<1||$count>500)throw new RuntimeException('--count must be 1–500.');

 if(isset($opts['dry-run'])){
  $date=$opts['date']??date('Y-m-d');Domain::date($date);
  summary(SampleAthletes::generate($count,$date,$seed),SampleAthletes::clubNames(),$date,$out);
  exit(0);
 }

 $pdo=matdraw_database(matdraw_config());$repo=new Repository($pdo);

 if(isset($opts['list'])){
  foreach($pdo->query('SELECT id,name,event_date,status FROM tournaments ORDER BY event_date') as $t)$out("{$t['id']}  {$t['event_date']}  {$t['status']}  {$t['name']}");
  exit(0);
 }

 if(isset($opts['remove'])){
  $n=remove($pdo);
  $out($n?"Removed $n sample athletes, their entries, draws and demo clubs.":'No sample data found.');
  exit(0);
 }

 $result=$repo->transaction(function(array &$db)use($opts,$count,$seed,$out){
  $admin=null;
  foreach($db['users'] as $u)if($u['role']==='admin'&&$u['active']&&(!isset($opts['admin'])||$u['email']===mb_strtolower(trim($opts['admin']))))$admin??=$u;
  if(!$admin)throw new RuntimeException(isset($opts['admin'])?'No active administrator with that e-mail.':'No active administrator. Run install.php first.');

  $t=null;
  if(isset($opts['tournament'])){
   foreach($db['tournaments'] as $x)if($x['id']===$opts['tournament']||$x['name']===$opts['tournament'])$t=$x;
   if(!$t)throw new RuntimeException('Tournament not found. Use --list to see ids.');
   if($t['status']==='finished')throw new RuntimeException('That tournament is finished and read-only.');
  }

  $names=SampleAthletes::clubNames();$clubIds=[];
  foreach($names as $name){
   $club=null;foreach($db['clubs'] as $c)if($c['name']===$name)$club=$c;
   if($club)foreach($db['profiles'] as $p)if($p['clubId']===$club['id'])throw new RuntimeException('Sample athletes already exist. Run with --remove first.');
   if(!$club){$club=['id'=>Domain::id(),'name'=>$name];$db['clubs'][]=$club;}
   $clubIds[]=$club['id'];
  }

  $date=$t['date']??date('Y-m-d');
  foreach(SampleAthletes::generate($count,$date,$seed) as $a){
   $p=['name'=>$a['name'],'clubId'=>$clubIds[$a['club']],'birthDate'=>$a['birthDate'],'sex'=>$a['sex'],'weight'=>$a['weight'],'height'=>$a['height'],'gradeType'=>$a['gradeType'],'grade'=>$a['grade'],'events'=>$a['events'],'champion'=>$a['champion']];
   if($t)$p['registration']=['tournamentId'=>$t['id'],'weight'=>$a['weight'],'height'=>$a['height'],'gradeType'=>$a['gradeType'],'grade'=>$a['grade'],'events'=>$a['events'],'champion'=>$a['champion']];
   Domain::execute($db,$admin['id'],'profile.save',$p,$db['revision']);
  }
  if(!$t)return null;
  foreach($db['tournaments'] as $x)if($x['id']===$t['id'])$t=$x;
  return $t;
 });

 $out("Added $count sample athletes in ".count(SampleAthletes::CLUBS).' demo clubs.');
 if($result){
  $sample=array_values(array_filter($result['entries'],fn($e)=>str_ends_with($e['club'],SampleAthletes::SUFFIX)));
  summary($sample,null,$result['date'],$out,$result['name']);
 }else $out('Not entered in a tournament. Add --tournament=ID (see --list) to enter them, or enter them in the app.');
}catch(Throwable $e){fwrite(STDERR,$e->getMessage()."\n");exit(1);}

/** Categories as the rule engine sees them on $date. */
function summary(array $athletes,?array $clubNames,string $date,callable $out,?string $title=null):void {
 $entries=[];
 foreach($athletes as $i=>$a)$entries[]=$a+['id'=>'s'.$i,'age'=>isset($a['age'])?$a['age']:Domain::ageAt($a['birthDate'],$date),'club'=>$clubNames?$clubNames[$a['club']]:$a['club'],'presence'=>'pending'];
 // Same grouping, order and codes as categories() in dist/engine.js.
 $events=array_keys(Rules::EVENTS);$prefix=['forms'=>'UF','soft'=>'SO','hogo'=>'HG','semi'=>'SC','light'=>'LC','special'=>'TS','power'=>'SI'];
 $map=[];$unassigned=[];
 foreach($entries as $a)foreach($a['events'] as $e){$c=Rules::classify($a,$e);if(isset($c['error'])){$unassigned[]="{$a['name']} ($e): {$c['error']}";continue;}$map[$c['id']]??=$c+['n'=>0];$map[$c['id']]['n']++;}
 $cats=array_values($map);
 usort($cats,fn($a,$b)=>array_search($a['event'],$events)<=>array_search($b['event'],$events)?:$b['n']<=>$a['n']?:strcmp($a['id'],$b['id']));
 $counter=[];
 $out(($title?"$title — ":'').count($athletes).' athletes, '.count($cats)." categories, ages on $date:");
 foreach($cats as $c){$code=$prefix[$c['event']].'-'.str_pad((string)($counter[$c['event']]=($counter[$c['event']]??0)+1),2,'0',STR_PAD_LEFT);$out(sprintf('  %-6s %2d  %s · %s',$code,$c['n'],$c['title'],$c['subtitle']).($c['n']<3?'  (under 3)':''));}
 foreach($unassigned as $u)$out("  unassigned: $u");
}

/** Deletes demo clubs (only those without accounts), their profiles, entries and draws containing them. */
function remove(PDO $pdo):int {
 $pdo->beginTransaction();
 try {
  $pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetch();
  $names=SampleAthletes::clubNames();$in=implode(',',array_fill(0,count($names),'?'));
  $q=$pdo->prepare("SELECT c.id FROM clubs c WHERE c.name IN ($in) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.club_id=c.id)");$q->execute($names);
  $clubs=$q->fetchAll(PDO::FETCH_COLUMN);
  if(!$clubs){$pdo->rollBack();return 0;}
  $cin=implode(',',array_fill(0,count($clubs),'?'));
  $q=$pdo->prepare("SELECT id FROM profiles WHERE club_id IN ($cin)");$q->execute($clubs);
  $ids=array_flip($q->fetchAll(PDO::FETCH_COLUMN));
  foreach($pdo->query('SELECT tournament_id,category_key,data FROM draws')->fetchAll() as $d){
   $slots=json_decode($d['data'],true)['slots']??[];
   if(array_intersect_key(array_flip(array_filter($slots,'is_string')),$ids))$pdo->prepare('DELETE FROM draws WHERE tournament_id=? AND category_key=?')->execute([$d['tournament_id'],$d['category_key']]);
  }
  foreach(['entries','profiles','clubs'] as $table)$pdo->prepare("DELETE FROM $table WHERE ".($table==='clubs'?'id':'club_id')." IN ($cin)")->execute($clubs);
  $pdo->exec('UPDATE app_meta SET revision=revision+1 WHERE id=1');
  $pdo->commit();
  return count($ids);
 }catch(Throwable $e){$pdo->rollBack();throw $e;}
}
