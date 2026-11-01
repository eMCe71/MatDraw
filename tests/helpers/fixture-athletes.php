<?php
// Test data jobs of the slice athlete-backend (PLAN-REJESTRACJA-ROLE §6–§8, §12) for tests/athletes.http.test.mjs; loaded by
// tests/helpers/fixture.php.
declare(strict_types=1);
use MatDraw\{Actors,AthleteView,Domain,People,Repository,Settings};
return [
 // AthleteView::build() of a member and fromWorkspace() of the full workspace with every tombstone and organizer name (equal, §7.4).
 'athlete-view-check'=>function(PDO $pdo,array $p,array $c):array{
  $u=Actors::of($pdo,['id'=>(string)($p['userId']??'')]);$flags=Settings::flags(Settings::effective($pdo,$c));$today=date('Y-m-d');
  $db=(new Repository($pdo))->snapshot();$db['flags']=$flags;
  $gone=array_map(fn($r)=>['profileId'=>$r['profile_id'],'tournamentId'=>$r['tournament_id'],'by'=>$r['by_kind'],'at'=>(int)$r['created_at']],$pdo->query('SELECT * FROM entry_withdrawals')->fetchAll(PDO::FETCH_ASSOC));
  $creators=[];foreach($db['tournaments'] as $t)if(Domain::community($db,$t))$creators[]=$t['createdBy'];
  $names=[];foreach(People::project($pdo,$creators) as $id=>$x)if(isset($x['n']))$names[$id]=['n'=>$x['n']];
  return ['build'=>AthleteView::build($pdo,$u,$today,$flags),'workspace'=>AthleteView::fromWorkspace($db,$u,$today,$gone,$names)];
 },
 // One profiles row (data decoded) or null.
 'athlete-row'=>function(PDO $pdo,array $p):?array{
  $q=$pdo->prepare('SELECT id,club_id,created_by,owner_user_id,archived,data FROM profiles WHERE id=?');$q->execute([(string)($p['id']??'')]);$r=$q->fetch(PDO::FETCH_ASSOC);
  if(!$r)return null;$r['data']=json_decode((string)$r['data'],true);return $r;
 },
 // Tombstones of a profile.
 'athlete-withdrawals'=>function(PDO $pdo,array $p):array{$q=$pdo->prepare('SELECT tournament_id,by_kind FROM entry_withdrawals WHERE profile_id=? ORDER BY tournament_id');$q->execute([(string)($p['profileId']??'')]);return $q->fetchAll(PDO::FETCH_ASSOC);},
 // The demo clubs of seed-athletes (names ending in " (demo)") and the number of profiles and entries in them.
 'athlete-demo'=>function(PDO $pdo):array{
  $clubs=$pdo->query("SELECT id,name,verified,created_by FROM clubs WHERE name LIKE '% (demo)' ORDER BY name")->fetchAll(PDO::FETCH_ASSOC);$ids=array_column($clubs,'id');
  $count=function(string $table)use($pdo,$ids):int{if(!$ids)return 0;$q=$pdo->prepare("SELECT COUNT(*) FROM $table WHERE club_id IN (".implode(',',array_fill(0,count($ids),'?')).')');$q->execute($ids);return (int)$q->fetchColumn();};
  return ['clubs'=>$clubs,'profiles'=>$count('profiles'),'entries'=>$count('entries'),'revision'=>$pdo->query('SELECT revision,staff_rev FROM app_meta WHERE id=1')->fetch(PDO::FETCH_ASSOC)];
 },
];
