<?php
// Test data jobs of the slice accounts-backend (PLAN-REJESTRACJA-ROLE §12) for tests/roles.http.test.mjs; loaded by
// tests/helpers/fixture.php (CLI, test database only).
//   roles-settings {organizers?,trustRequired?}  switches of the effective configuration: config.php keys organizers and
//                     organizers_trust_required (read by Settings::effective) and, when app_settings exists, the same keys of
//                     its row; returns {old, flags} (flags: Settings::flags of the effective config now)
//   roles-settings-restore {old}                 puts back what roles-settings returned
//   roles-flags {}                               Settings::flags of the effective configuration, nothing changed
//   roles-user {email}                           users row (role columns), owned and created profiles, billing row and audit
//   roles-hold-lock {seconds}                    holds app_meta FOR UPDATE (the workspace lock), prints "locked" first
//   roles-clubs-fill {} / roles-clubs-remove {ids}  unverified clubs created now up to the global daily quota, and their removal
//   roles-bucket {scope,key,attempts}            a rate-limit bucket at `attempts` in a window that starts now
//   roles-snapshot {userId}                      publicData of the organizer snapshot and of the full workspace, both with the effective flags
//   roles-backdate {tournamentId,date,status?}   event date (and status) of a tournament, as if it took place long ago
//   roles-job {name,config?}                     runs one background job once with config overrides; returns its result
//   roles-entries {tournamentId} / roles-withdrawals {tournamentId}  entries rows (snapshots) and withdrawal tombstones
//   roles-audit {since,afterId?}                 account_audit rows from the epoch second `since` (and after the row id afterId)
//   roles-bulk-fault {adminId,userIds,fault}     admin-member organizer-bulk (block) as Members runs it, with a deadlock (1213)
//                     when the role of the account `fault` is blocked; returns {result, log} (log: the error_log lines)
declare(strict_types=1);
use MatDraw\{Actors,Clubs,Domain,Jobs,Members,Repository,RouteContext,Settings};
/** A statement that fails like a deadlock (40001/1213) when it blocks the organizer role of one account (roles-bulk-fault). */
final class FixtureRolesDeadlock extends PDOStatement {
 protected function __construct(private string $userId){}
 public function execute(?array $params=null):bool{
  if(str_starts_with($this->queryString,'UPDATE users SET organizer_blocked_at')&&in_array($this->userId,$params??[],true)){$e=new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock');$e->errorInfo=['40001',1213,'Deadlock found when trying to get lock'];throw $e;}
  return parent::execute($params);
 }
}
function fixture_roles_has(PDO $pdo,string $t):bool{$q=$pdo->prepare('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');$q->execute([$t]);return (bool)$q->fetchColumn();}
function fixture_roles_flags(PDO $pdo):array{return Settings::flags(Settings::effective($pdo,matdraw_config()));}
return [
 'roles-settings'=>function(PDO $pdo,array $p):array{
  $set=[];if(array_key_exists('organizers',$p))$set['organizers']=$p['organizers'];if(array_key_exists('trustRequired',$p))$set['organizers_trust_required']=$p['trustRequired'];
  $old=['config'=>fixture_config_set($set,['organizers','organizers_trust_required'],'roles-settings'),'row'=>false];
  if(fixture_roles_has($pdo,'app_settings')){
   $row=$pdo->query('SELECT * FROM app_settings WHERE id=1')->fetch()?:null;$old['row']=$row;$data=$row?(json_decode((string)$row['data'],true)?:[]):[];
   foreach(['organizers'=>'organizers','trustRequired'=>'trustRequired'] as $k=>$col)if(array_key_exists($k,$p)){if($p[$k]===null)unset($data[$col]);else $data[$col]=$p[$k];}
   $pdo->prepare('INSERT INTO app_settings (id,version,data,updated_at,updated_by) VALUES (1,?,?,?,NULL) ON DUPLICATE KEY UPDATE version=version+1,data=VALUES(data),updated_at=VALUES(updated_at)')->execute([1,json_encode((object)$data),time()]);
  }
  return ['old'=>$old,'flags'=>fixture_roles_flags($pdo)];
 },
 'roles-flags'=>fn(PDO $pdo):array=>fixture_roles_flags($pdo),
 'roles-settings-restore'=>function(PDO $pdo,array $p):array{
  $old=(array)($p['old']??[]);fixture_config_set((array)($old['config']??[]),['organizers','organizers_trust_required'],'roles-settings-restore');
  // array_key_exists, not ??: a missing row was saved as null, and null ?? false would skip the restore.
  if(array_key_exists('row',$old)&&$old['row']!==false&&fixture_roles_has($pdo,'app_settings')){
   if($old['row']===null)$pdo->exec('DELETE FROM app_settings WHERE id=1');
   else{$r=$old['row'];$pdo->prepare('UPDATE app_settings SET version=?,data=?,updated_at=?,updated_by=? WHERE id=1')->execute([$r['version'],$r['data'],$r['updated_at'],$r['updated_by']]);}
  }
  return fixture_roles_flags($pdo);
 },
 'roles-user'=>function(PDO $pdo,array $p):?array{
  $q=$pdo->prepare('SELECT id,role,active,email,organizer,organizer_blocked_at,organizer_trusted_at,organizer_trusted_by FROM users WHERE email=?');$q->execute([mb_strtolower((string)($p['email']??''))]);$u=$q->fetch();if(!$u)return null;
  $rows=function(string $sql,array $v)use($pdo):array{$q=$pdo->prepare($sql);$q->execute($v);return $q->fetchAll();};
  $profiles=array_map(fn($r)=>['id'=>$r['id'],'clubId'=>$r['club_id'],'createdBy'=>$r['created_by'],'ownerId'=>$r['owner_user_id'],'archived'=>(int)$r['archived'],'rev'=>(int)$r['rev'],'data'=>json_decode($r['data'],true)],$rows('SELECT * FROM profiles WHERE owner_user_id=? OR created_by=? ORDER BY id',[$u['id'],$u['id']]));
  return ['user'=>$u,'profiles'=>$profiles,'billing'=>$rows('SELECT billing_exempt,exempt_reason,exempt_by,deleted_at FROM billing_accounts WHERE user_id=?',[$u['id']])[0]??null,
   'audit'=>$rows('SELECT actor_id,action,note FROM account_audit WHERE target_user_id=? ORDER BY id',[$u['id']]),'clubs'=>$rows('SELECT id,name,verified FROM clubs WHERE created_by=? ORDER BY id',[$u['id']])];
 },
 'roles-hold-lock'=>function(PDO $pdo,array $p):array{
  $pdo->beginTransaction();$pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetchAll();
  fwrite(STDOUT,"locked\n");fflush(STDOUT);usleep((int)round((float)($p['seconds']??3)*1e6));$pdo->rollBack();return ['released'=>true];
 },
 'roles-clubs-fill'=>function(PDO $pdo):array{
  $clubs=array_map([Clubs::class,'fromRow'],$pdo->query('SELECT id,name,verified,created_by,created_at,merged_into FROM clubs')->fetchAll());
  $have=Clubs::counts($clubs,['id'=>'-'],time())['global'];$ids=[];
  for($i=$have;$i<Domain::CLUBS_DAY_GLOBAL;$i++){$id=Domain::id();$pdo->prepare('INSERT INTO clubs (id,name,verified,created_by,created_at) VALUES (?,?,0,NULL,?)')->execute([$id,'Klub Limitu '.substr($id,0,10),time()]);$ids[]=$id;}
  return $ids;
 },
 'roles-clubs-remove'=>function(PDO $pdo,array $p):int{$n=0;foreach((array)($p['ids']??[]) as $id){$q=$pdo->prepare('DELETE FROM clubs WHERE id=? AND verified=0');$q->execute([(string)$id]);$n+=$q->rowCount();}return $n;},
 'roles-bucket'=>function(PDO $pdo,array $p,array $c):string{
  $bucket=hash_hmac('sha256',(string)$p['scope'].'|'.(string)$p['key'],$c['app_key']);
  $pdo->prepare('INSERT INTO login_limits (bucket,attempts,window_start) VALUES (?,?,?) ON DUPLICATE KEY UPDATE attempts=VALUES(attempts),window_start=VALUES(window_start)')->execute([$bucket,(int)$p['attempts'],time()]);return $bucket;
 },
 'roles-snapshot'=>function(PDO $pdo,array $p):array{
  $actor=Actors::of($pdo,['id'=>(string)($p['userId']??'')]);$repo=new Repository($pdo);$flags=fixture_roles_flags($pdo);
  $full=$repo->snapshot();$full['users'][]=$actor;$full['flags']=$flags;$part=$repo->organizerSnapshot($actor['id'],date('Y-m-d'));$part['flags']=$flags;
  return ['snapshot'=>Domain::publicData($part,$actor),'full'=>Domain::publicData($full,$actor)];
 },
 'roles-backdate'=>function(PDO $pdo,array $p):int{$q=$pdo->prepare('UPDATE tournaments SET event_date=?,status=COALESCE(?,status) WHERE id=?');$q->execute([Domain::date($p['date']??null),$p['status']??null,(string)($p['tournamentId']??'')]);return $q->rowCount();},
 'roles-job'=>function(PDO $pdo,array $p,array $c):string{
  $job=Jobs::all()[(string)($p['name']??'')]??null;if(!$job)throw new RuntimeException('roles-job: no such job');
  return ($job['run'])($pdo,array_replace($c,(array)($p['config']??[])),time());
 },
 'roles-entries'=>function(PDO $pdo,array $p):array{$q=$pdo->prepare('SELECT profile_id,club_id,snapshot FROM entries WHERE tournament_id=? ORDER BY profile_id');$q->execute([(string)($p['tournamentId']??'')]);return array_map(fn($r)=>['profileId'=>$r['profile_id'],'clubId'=>$r['club_id'],'snapshot'=>json_decode($r['snapshot'],true)],$q->fetchAll());},
 'roles-withdrawals'=>function(PDO $pdo,array $p):array{$q=$pdo->prepare('SELECT profile_id,tournament_id,by_kind FROM entry_withdrawals WHERE tournament_id=? ORDER BY profile_id');$q->execute([(string)($p['tournamentId']??'')]);return $q->fetchAll();},
 'roles-bulk-fault'=>function(PDO $pdo,array $p,array $c):array{
  $ctx=new RouteContext('admin-member',[],$c);$ctx->pdo()->setAttribute(PDO::ATTR_STATEMENT_CLASS,[FixtureRolesDeadlock::class,[(string)($p['fault']??'')]]);
  $log=tempnam(sys_get_temp_dir(),'mdr-log');$was=ini_set('error_log',$log);
  try{$out=Members::adminAction($ctx,['id'=>(string)($p['adminId']??''),'role'=>'admin'],['action'=>'organizer-bulk','userIds'=>(array)($p['userIds']??[]),'block'=>true]);}
  finally{ini_set('error_log',(string)$was);$text=(string)file_get_contents($log);unlink($log);}
  return ['result'=>$out,'log'=>$text];
 },
 'roles-audit'=>function(PDO $pdo,array $p):array{$q=$pdo->prepare('SELECT id,actor_id,action,target_user_id,note FROM account_audit WHERE created_at>=? AND id>? ORDER BY id');$q->execute([(int)($p['since']??0),(int)($p['afterId']??0)]);return array_map(fn($r)=>['id'=>(int)$r['id']]+$r,$q->fetchAll());},
];
