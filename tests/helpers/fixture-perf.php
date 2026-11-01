<?php
// Test data jobs of the performance budget (PLAN-REJESTRACJA-ROLE §12, slice integration-qa) for tests/perf.http.test.mjs;
// loaded by tests/helpers/fixture.php (CLI, test database only). Every row carries the tag of the run as its id prefix
// ("<tag>-…"), so perf-clean removes exactly what perf-seed and perf-members wrote, also after a failed run.
//   perf-seed {tag, organizerId, profiles, organizerProfiles, tournaments, organizerTournaments, entries, outside, far}
//       profiles (organizerProfiles of them created by the organizer, the rest by the first Administrator), regular
//       tournaments (organizerTournaments of them by the organizer, statuses in turn, dated from tomorrow on) with
//       `entries` entries each from the creator's profiles, `outside` of the organizer's profiles entered into the first
//       staff tournament (open, O19), and `far` open tournaments with self-entries dated from 2060-01-01 plus one more
//       (target) on 2061-06-30, all by the Administrator; one plain INSERT per 400 rows. Returns {target,
//       organizerTournament, staffTournament, counts}.
//   perf-members {tag, count}     member accounts without profile rows (role member, the staff workspace never reads them)
//   perf-clean {tag}              deletes every row of the tag (chat channels of its tournaments first), then raises the revision
//   perf-explain {}               EXPLAIN of the staff query of Repository::load (the key it uses)
declare(strict_types=1);
/** INSERT of many rows, 400 per statement. */
function fixture_perf_insert(PDO $pdo,string $table,array $cols,array $rows):void {
 $one='('.implode(',',array_fill(0,count($cols),'?')).')';
 foreach(array_chunk($rows,400) as $chunk)$pdo->prepare("INSERT INTO $table (".implode(',',$cols).') VALUES '.implode(',',array_fill(0,count($chunk),$one)))->execute(array_merge(...$chunk));
}
function fixture_perf_tag(array $p):string{$t=(string)($p['tag']??'');if(!preg_match('/^[a-z]{4,12}$/D',$t))throw new RuntimeException('perf: tag');return $t;}
return [
 'perf-seed'=>function(PDO $pdo,array $p):array{
  $tag=fixture_perf_tag($p);$org=(string)($p['organizerId']??'');$now=time();
  $admin=(string)$pdo->query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")->fetchColumn();
  $club=$pdo->query("SELECT id,name FROM clubs WHERE verified=1 AND merged_into IS NULL AND id<>'unaffiliated' ORDER BY id LIMIT 1")->fetch(PDO::FETCH_ASSOC);
  $nP=(int)($p['profiles']??5000);$nOP=(int)($p['organizerProfiles']??1000);$nT=(int)($p['tournaments']??200);$nOT=(int)($p['organizerTournaments']??60);$nE=(int)($p['entries']??25);$far=(int)($p['far']??55);$outside=(int)($p['outside']??10);
  $sexes=['M','F'];$profiles=[];$own=['org'=>[],'staff'=>[]];$byId=[];
  for($i=0;$i<$nP;$i++){
   $id=sprintf('%s-p%05d',$tag,$i);$by=$i<$nOP?$org:$admin;$sex=$sexes[$i%2];$birth=sprintf('%04d-%02d-%02d',1980+$i%25,1+$i%12,1+$i%28);
   $a=['id'=>$id,'name'=>'Perf Zawodnik '.$i,'clubId'=>$club['id'],'createdBy'=>$by,'createdAt'=>$now,'archived'=>false,'ownerId'=>null,'birthDate'=>$birth,'sex'=>$sex,'weight'=>50+$i%40,'height'=>160+$i%30,'gradeType'=>'cup','grade'=>1+$i%10,'events'=>['forms'],'champion'=>false];
   $profiles[]=[$id,$club['id'],$by,0,json_encode($a,JSON_UNESCAPED_UNICODE),null,0];$own[$i<$nOP?'org':'staff'][]=$id;$byId[$id]=$a;
  }
  fixture_perf_insert($pdo,'profiles',['id','club_id','created_by','archived','data','owner_user_id','rev'],$profiles);
  $statuses=['open','closed','finished','draft'];$tournaments=[];$entries=[];$orgFirst=null;
  for($i=0;$i<$nT;$i++){
   $id=sprintf('%s-t%04d',$tag,$i);$mine=$i<$nOT;$by=$mine?$org:$admin;$status=$statuses[$i%4];$orgFirst??=$mine?$id:null;
   $tournaments[]=[$id,$by,'Perf Turniej '.$i,'Perfowo',date('Y-m-d',strtotime('+'.(1+$i%300).' days')),'Mata 1',$status,'[]',$now,(int)($status==='open'),0];
   $pool=$own[$mine?'org':'staff'];$start=($i*$nE)%max(1,count($pool)-$nE);
   foreach(array_slice($pool,$start,$nE) as $pid){$a=$byId[$pid];
    $entries[]=[$id,$pid,$club['id'],json_encode(['id'=>$pid,'profileId'=>$pid,'clubId'=>$club['id'],'name'=>$a['name'],'club'=>$club['name'],'sex'=>$a['sex'],'age'=>30,'weight'=>$a['weight'],'height'=>$a['height'],'gradeType'=>'cup','grade'=>$a['grade'],'events'=>['forms'],'champion'=>false,'presence'=>'pending','actualWeight'=>null],JSON_UNESCAPED_UNICODE)];}
  }
  // The organizer's entries in the first staff tournament (open, created right after his): his entries in other people's tournaments.
  $staffFirst=sprintf('%s-t%04d',$tag,$nOT);
  foreach(array_slice($own['org'],0,$outside) as $pid){$a=$byId[$pid];$entries[]=[$staffFirst,$pid,$club['id'],json_encode(['id'=>$pid,'profileId'=>$pid,'clubId'=>$club['id'],'name'=>$a['name'],'club'=>$club['name'],'sex'=>$a['sex'],'age'=>30,'weight'=>$a['weight'],'height'=>$a['height'],'gradeType'=>'cup','grade'=>$a['grade'],'events'=>['forms'],'champion'=>false,'presence'=>'pending','actualWeight'=>null],JSON_UNESCAPED_UNICODE)];}
  // Far open tournaments (ages stay within the rules for adults born from 1980 on), the last one the target of ?t=.
  for($i=0;$i<=$far;$i++){$id=$i<$far?sprintf('%s-f%03d',$tag,$i):$tag.'-target';$tournaments[]=[$id,$admin,$i<$far?'Perf Daleki '.$i:'Perf Cel','Perfowo',$i<$far?date('Y-m-d',strtotime('2060-01-01 +'.$i.' days')):'2061-06-30','Mata 1','open','[]',$now,1,0];}
  fixture_perf_insert($pdo,'tournaments',['id','created_by','name','city','event_date','mat','status','activity','created_at','self_entry','rev'],$tournaments);
  fixture_perf_insert($pdo,'entries',['tournament_id','profile_id','club_id','snapshot'],$entries);
  $pdo->exec('UPDATE app_meta SET revision=revision+1 WHERE id=1');
  return ['target'=>$tag.'-target','organizerTournament'=>$orgFirst,'staffTournament'=>$staffFirst,'counts'=>['profiles'=>count($profiles),'tournaments'=>count($tournaments),'entries'=>count($entries)]];
 },
 'perf-members'=>function(PDO $pdo,array $p):array{
  $tag=fixture_perf_tag($p);$n=(int)($p['count']??3000);$rows=[];
  // Not a password hash: these accounts never sign in.
  for($i=0;$i<$n;$i++)$rows[]=[sprintf('%s-m%05d',$tag,$i),null,sprintf('%s.m%05d@perf.example',$tag,$i),'member',1,'-',1,0];
  fixture_perf_insert($pdo,'users',['id','club_id','email','role','active','password_hash','auth_version','organizer'],$rows);
  return ['members'=>$n];
 },
 'perf-clean'=>function(PDO $pdo,array $p):array{
  $like=fixture_perf_tag($p).'-%';$n=[];
  $run=function(string $key,string $sql,int $times=1)use($pdo,$like,&$n){$q=$pdo->prepare($sql);$q->execute(array_fill(0,$times,$like));$n[$key]=$q->rowCount();};
  $run('messages','DELETE m FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id WHERE c.tournament_id LIKE ?');
  $run('channels','DELETE FROM chat_channels WHERE tournament_id LIKE ?');
  $run('withdrawals','DELETE FROM entry_withdrawals WHERE tournament_id LIKE ? OR profile_id LIKE ?',2);
  $run('draws','DELETE FROM draws WHERE tournament_id LIKE ?');
  $run('entries','DELETE FROM entries WHERE tournament_id LIKE ? OR profile_id LIKE ?',2);
  $run('tournaments','DELETE FROM tournaments WHERE id LIKE ?');
  $run('profiles','DELETE FROM profiles WHERE id LIKE ?');
  $run('users',"DELETE FROM users WHERE id LIKE ? AND role='member'");
  $pdo->exec('UPDATE app_meta SET revision=revision+1 WHERE id=1');
  return $n;
 },
 'perf-explain'=>function(PDO $pdo):array{
  return $pdo->query("EXPLAIN SELECT * FROM users WHERE role IN ('admin','editor','club') ORDER BY email,id")->fetchAll(PDO::FETCH_ASSOC);
 },
];
