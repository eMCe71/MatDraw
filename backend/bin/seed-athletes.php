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
 * They belong to six clubs ending in " (demo)", created unverified by the seeding administrator, so they are not on
 * the public club list nor named in public brackets (PLAN-REJESTRACJA-ROLE §6.3). --remove deletes the staff-created
 * profiles without an owner in those clubs, their entries, the draws that contain them and the clubs; it refuses and
 * changes nothing while a demo club holds any other profile or entry (community data) or is a merge target. Clubs with
 * user accounts are never deleted.
 */
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
require_once dirname(__DIR__).'/src/SampleAthletes.php';
use MatDraw\{Clubs,Domain,Repository,Rules,SampleAthletes};

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
  $out($n===null?'No sample data found.':"Removed $n sample athletes, their entries, draws and demo clubs.");
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
   $club=null;foreach($db['clubs'] as $c)if(Clubs::key($c['name'])===Clubs::key($name))$club=$c;
   if($club)foreach($db['profiles'] as $p)if($p['clubId']===$club['id'])throw new RuntimeException('Sample athletes already exist. Run with --remove first.');
   // Unverified and created by the seeding administrator: off the public club list and out of public brackets (§6.3).
   if(!$club){$club=['id'=>Domain::id(),'name'=>$name,'verified'=>false,'createdBy'=>$admin['id'],'createdAt'=>time(),'mergedInto'=>null];$db['clubs'][]=$club;}
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

/**
 * Deletes the demo clubs (only those without accounts) with their staff-created profiles without an owner, the entries of
 * those profiles and the draws that contain them, under the workspace lock. Refuses (RuntimeException, nothing changed)
 * while a demo club holds a profile of a member or with an owner, an entry of another profile, or is a merge target.
 * The revision stamps follow Domain (§5.8): changed tournaments get rev=R, removed clubs staff_rev=R, revision=R.
 */
function remove(PDO $pdo):?int {
 $pdo->beginTransaction();
 try {
  $pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetch();
  $names=SampleAthletes::clubNames();$in=implode(',',array_fill(0,count($names),'?'));
  $q=$pdo->prepare("SELECT c.id FROM clubs c WHERE c.name IN ($in) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.club_id=c.id)");$q->execute($names);
  $clubs=$q->fetchAll(PDO::FETCH_COLUMN);
  if(!$clubs){$pdo->rollBack();return null;}
  $cin=implode(',',array_fill(0,count($clubs),'?'));
  $q=$pdo->prepare("SELECT p.id FROM profiles p JOIN users u ON u.id=p.created_by WHERE p.club_id IN ($cin) AND p.owner_user_id IS NULL AND u.role IN ('admin','editor','club')");$q->execute($clubs);
  $ids=$q->fetchAll(PDO::FETCH_COLUMN);$keep=array_flip($ids);
  $q=$pdo->prepare("SELECT COUNT(*) FROM profiles WHERE club_id IN ($cin)");$q->execute($clubs);$others=(int)$q->fetchColumn()-count($ids);
  $q=$pdo->prepare("SELECT profile_id FROM entries WHERE club_id IN ($cin)");$q->execute($clubs);foreach($q->fetchAll(PDO::FETCH_COLUMN) as $p)if(!isset($keep[$p]))$others++;
  $q=$pdo->prepare("SELECT COUNT(*) FROM clubs WHERE merged_into IN ($cin)");$q->execute($clubs);$others+=(int)$q->fetchColumn();
  if($others)throw new RuntimeException('Demo clubs are used by community profiles; merge or rename them in the app (Kluby) first.');
  $R=(int)$pdo->query('SELECT revision FROM app_meta WHERE id=1')->fetchColumn()+1;$touched=[];
  foreach($pdo->query('SELECT tournament_id,category_key,data FROM draws')->fetchAll() as $d){
   $slots=json_decode($d['data'],true)['slots']??[];
   if(array_intersect_key(array_flip(array_filter($slots,'is_string')),$keep)){$pdo->prepare('DELETE FROM draws WHERE tournament_id=? AND category_key=?')->execute([$d['tournament_id'],$d['category_key']]);$touched[$d['tournament_id']]=true;}
  }
  if($ids){
   $pin=implode(',',array_fill(0,count($ids),'?'));
   $q=$pdo->prepare("SELECT DISTINCT tournament_id FROM entries WHERE profile_id IN ($pin)");$q->execute($ids);foreach($q->fetchAll(PDO::FETCH_COLUMN) as $t)$touched[$t]=true;
   foreach(['entries'=>'profile_id','entry_withdrawals'=>'profile_id','profiles'=>'id'] as $table=>$col)$pdo->prepare("DELETE FROM $table WHERE $col IN ($pin)")->execute($ids);
  }
  $pdo->prepare("DELETE FROM clubs WHERE id IN ($cin)")->execute($clubs);
  if($touched){$tin=implode(',',array_fill(0,count($touched),'?'));$pdo->prepare("UPDATE tournaments SET rev=? WHERE id IN ($tin)")->execute([$R,...array_keys($touched)]);}
  $pdo->prepare('UPDATE app_meta SET revision=?,staff_rev=? WHERE id=1')->execute([$R,$R]);
  $pdo->commit();
  return count($ids);
 }catch(Throwable $e){$pdo->rollBack();throw $e;}
}
