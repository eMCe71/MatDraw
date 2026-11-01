<?php
// Test data jobs of the slice data-domain (PLAN-REJESTRACJA-ROLE §12) for tests/domain.http.test.mjs; loaded by
// tests/helpers/fixture.php. Wave 1 has no routes for members yet, so domain-run executes a command the way the member
// routes will (Repository::transaction with the actor from Actors::of and the flags of Settings::effective).
declare(strict_types=1);
use MatDraw\{Actors,AppError,Domain,Repository,Settings};
const FIXTURE_DOMAIN_ROWS=['tournaments'=>'id,created_by,status,self_entry,hidden_by,hidden_from,rev','profiles'=>'id,club_id,created_by,owner_user_id,archived,rev,data','clubs'=>'id,name,verified,created_by,created_at,merged_into','users'=>'id,role,organizer,organizer_blocked_at,organizer_trusted_at,auth_version,password_hash'];
return [
 // One row (or null) of tournaments, profiles, clubs or users by id; app_meta without an id.
 'domain-row'=>function(PDO $pdo,array $p):?array{
  $table=(string)($p['table']??'');
  if($table==='app_meta')return $pdo->query('SELECT revision,staff_rev,schema_version FROM app_meta WHERE id=1')->fetch()?:null;
  if(!isset(FIXTURE_DOMAIN_ROWS[$table]))throw new RuntimeException('domain-row: table');
  $q=$pdo->prepare('SELECT '.FIXTURE_DOMAIN_ROWS[$table]." FROM $table WHERE id=?");$q->execute([(string)($p['id']??'')]);$r=$q->fetch();return $r?:null;
 },
 // Clubs whose name equals one of the names under the database collation (the unique key club_name compares the same way).
 'domain-clubs'=>function(PDO $pdo,array $p):array{
  $out=[];$q=$pdo->prepare('SELECT id,name,verified,created_by,merged_into FROM clubs WHERE name=? ORDER BY id');
  foreach((array)($p['names']??[]) as $n){$q->execute([(string)$n]);foreach($q->fetchAll() as $r)$out[$r['id']]=$r;}
  return array_values($out);
 },
 // Role columns of a member: organizer (0/1), trusted and blocked (true sets the time, false clears it).
 'domain-organizer'=>function(PDO $pdo,array $p):array{
  $id=(string)($p['userId']??'');$set=[];$v=[];
  if(isset($p['organizer'])){$set[]='organizer=?';$v[]=$p['organizer']?1:0;}
  foreach(['trusted'=>'organizer_trusted_at','blocked'=>'organizer_blocked_at'] as $k=>$col)if(array_key_exists($k,$p)){$set[]="$col=?";$v[]=$p[$k]?time():null;}
  if($set){$v[]=$id;$pdo->prepare('UPDATE users SET '.implode(',',$set)." WHERE id=? AND role='member'")->execute($v);}
  return Actors::of($pdo,['id'=>$id])['caps'];
 },
 // A command of any account through Repository::transaction($fn, actor, flags), as the member routes will run it.
 'domain-run'=>function(PDO $pdo,array $p,array $c):array{
  $actor=Actors::of($pdo,['id'=>(string)($p['actor']??'')]);$flags=Settings::flags(Settings::effective($pdo,array_replace($c,(array)($p['config']??[]))));
  try{
   return (new Repository($pdo))->transaction(function(array &$db)use($p,$actor){
    $result=Domain::execute($db,$actor['id'],(string)$p['type'],(array)($p['payload']??[]),isset($p['revision'])?(int)$p['revision']:(int)$db['revision']);
    return ['status'=>200,'result'=>$result,'revision'=>$db['revision'],'view'=>Domain::publicData($db,$actor)];
   },$actor,$flags);
  }catch(AppError $e){return ['status'=>$e->status,'error'=>$e->getMessage()];}
 },
 // persist() refuses to drop a profile that still has entries: the whole transaction rolls back.
 'domain-broken-forget'=>function(PDO $pdo,array $p):array{
  $id=(string)($p['profileId']??'');
  try{(new Repository($pdo))->transaction(function(array &$db)use($id){$db['profiles']=array_values(array_filter($db['profiles'],fn($a)=>$a['id']!==$id));$db['revision']++;});return ['error'=>null];}
  catch(Throwable $e){return ['error'=>$e->getMessage(),'class'=>get_class($e)];}
 },
 // publicData of the organizer snapshot and of the full workspace for the same actor (they must be equal, B2).
 'domain-snapshot'=>function(PDO $pdo,array $p):array{
  $actor=Actors::of($pdo,['id'=>(string)($p['userId']??'')]);$repo=new Repository($pdo);
  $full=$repo->snapshot();$full['users'][]=$actor;$part=$repo->organizerSnapshot($actor['id'],date('Y-m-d'));
  return ['snapshot'=>Domain::publicData($part,$actor),'full'=>Domain::publicData($full,$actor),'profiles'=>count($part['profiles']),'allProfiles'=>count($full['profiles'])];
 },
 // A profile owned by an account, written directly (the floor of 0007); remove deletes it again.
 'domain-owned-profile'=>function(PDO $pdo,array $p):array{
  $id=(string)($p['id']??Domain::id());
  if(!empty($p['remove'])){$pdo->prepare('DELETE FROM profiles WHERE id=?')->execute([$id]);return ['id'=>$id];}
  $user=(string)$p['userId'];$data=['id'=>$id,'name'=>'Profil Właściciela','clubId'=>'unaffiliated','sex'=>'F','birthDate'=>'2000-01-01','weight'=>60,'height'=>165,'gradeType'=>'cup','grade'=>5,'events'=>['forms'],'champion'=>false,'createdBy'=>$user,'ownerId'=>$user,'relation'=>'self','archived'=>false];
  $pdo->prepare('INSERT INTO profiles (id,club_id,created_by,archived,data,owner_user_id) VALUES (?,?,?,?,?,?)')->execute([$id,'unaffiliated',$user,0,json_encode($data,JSON_UNESCAPED_UNICODE),$user]);
  return ['id'=>$id];
 },
];
