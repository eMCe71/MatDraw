<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/** One transaction and revision cover cross-tournament/profile invariants. */
final class Repository {
 public function __construct(private PDO $pdo){}
 private static function json(mixed $v):string{return json_encode($v,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);}
 private static function decode(string $v):array{return json_decode($v,true,512,JSON_THROW_ON_ERROR);}
 public function snapshot():array {
  $this->pdo->beginTransaction();
  try{$db=$this->load();$this->pdo->commit();return $db;}catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 public function transaction(callable $fn):mixed {
  $this->pdo->beginTransaction();
  try {
   $this->pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetch();
   $before=$this->load();$next=$before;$result=$fn($next);$this->persist($before,$next);$this->pdo->commit();return $result;
  }catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 /**
  * Read-only data for GuestView: only tournaments that may be public (not drafts, dated $today or later), without
  * creators, mats or activity; entries and draws only for the one requested tournament. Accounts and the athlete
  * database are never read here.
  */
 public function guestTournaments(string $today,?string $id=null):array {
  $this->pdo->beginTransaction();
  try{
   $q=$this->pdo->prepare("SELECT id,name,city,event_date,status FROM tournaments WHERE status IN ('open','closed','finished') AND event_date>=?".($id===null?'':' AND id=?').' ORDER BY event_date,id');
   $q->execute($id===null?[$today]:[$today,$id]);$list=[];
   foreach($q->fetchAll() as $t)$list[]=['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['event_date'],'status'=>$t['status'],'entries'=>[],'draws'=>[]];
   if($id!==null&&$list){
    $e=$this->pdo->prepare('SELECT snapshot FROM entries WHERE tournament_id=? ORDER BY profile_id');$e->execute([$id]);
    foreach($e->fetchAll() as $row)$list[0]['entries'][]=self::decode($row['snapshot']);
    $d=$this->pdo->prepare('SELECT category_key,data FROM draws WHERE tournament_id=? ORDER BY category_key');$d->execute([$id]);
    foreach($d->fetchAll() as $row)$list[0]['draws'][$row['category_key']]=self::decode($row['data']);
   }
   $this->pdo->commit();return $list;
  }catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 private function load():array {
  $db=['schemaVersion'=>2,'revision'=>(int)$this->pdo->query('SELECT revision FROM app_meta WHERE id=1')->fetchColumn(),'clubs'=>[],'users'=>[],'profiles'=>[],'tournaments'=>[]];
  $db['clubs']=$this->pdo->query('SELECT id,name FROM clubs ORDER BY name,id')->fetchAll();
  foreach($this->pdo->query('SELECT * FROM users ORDER BY email,id') as $u)$db['users'][]=['id'=>$u['id'],'clubId'=>$u['club_id'],'email'=>$u['email'],'role'=>$u['role'],'active'=>(bool)$u['active'],'passwordHash'=>$u['password_hash'],'authVersion'=>(int)$u['auth_version']];
  foreach($this->pdo->query('SELECT * FROM profiles ORDER BY id') as $a)$db['profiles'][]=array_replace(self::decode($a['data']),['id'=>$a['id'],'clubId'=>$a['club_id'],'createdBy'=>$a['created_by'],'archived'=>(bool)$a['archived']]);
  $index=[];
  foreach($this->pdo->query('SELECT * FROM tournaments ORDER BY event_date,id') as $t){$index[$t['id']]=count($db['tournaments']);$db['tournaments'][]=['id'=>$t['id'],'createdBy'=>$t['created_by'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['event_date'],'mat'=>$t['mat'],'status'=>$t['status'],'activity'=>self::decode($t['activity']),'entries'=>[],'draws'=>[]];}
  foreach($this->pdo->query('SELECT * FROM entries ORDER BY tournament_id,profile_id') as $e)$db['tournaments'][$index[$e['tournament_id']]]['entries'][]=self::decode($e['snapshot']);
  foreach($this->pdo->query('SELECT * FROM draws ORDER BY tournament_id,category_key') as $d)$db['tournaments'][$index[$d['tournament_id']]]['draws'][$d['category_key']]=self::decode($d['data']);
  return $db;
 }
 private function rows(array $db):array {
  $rows=['clubs'=>[],'users'=>[],'profiles'=>[],'tournaments'=>[],'entries'=>[],'draws'=>[]];
  foreach($db['clubs'] as $c)$rows['clubs'][$c['id']]=['id'=>$c['id'],'name'=>$c['name']];
  foreach($db['users'] as $u)$rows['users'][$u['id']]=['id'=>$u['id'],'club_id'=>$u['clubId'],'email'=>$u['email'],'role'=>$u['role'],'active'=>(int)$u['active'],'password_hash'=>$u['passwordHash'],'auth_version'=>$u['authVersion']];
  foreach($db['profiles'] as $a)$rows['profiles'][$a['id']]=['id'=>$a['id'],'club_id'=>$a['clubId'],'created_by'=>$a['createdBy'],'archived'=>(int)$a['archived'],'data'=>self::json($a)];
  foreach($db['tournaments'] as $t){
   $rows['tournaments'][$t['id']]=['id'=>$t['id'],'created_by'=>$t['createdBy'],'name'=>$t['name'],'city'=>$t['city'],'event_date'=>$t['date'],'mat'=>$t['mat'],'status'=>$t['status'],'activity'=>self::json($t['activity'])];
   foreach($t['entries'] as $e)$rows['entries'][$t['id'].'/'.$e['id']]=['tournament_id'=>$t['id'],'profile_id'=>$e['profileId'],'club_id'=>$e['clubId'],'snapshot'=>self::json($e)];
   foreach($t['draws'] as $key=>$d)$rows['draws'][$t['id'].'/'.$key]=['tournament_id'=>$t['id'],'category_key'=>$key,'data'=>self::json($d)];
  }return $rows;
 }
 private function persist(array $before,array $after):void {
  $a=$this->rows($before);$b=$this->rows($after);
  // Only entries and draws are removed. Accounts/profiles preserve history.
  foreach(['draws'=>'category_key','entries'=>'profile_id'] as $table=>$key)foreach(array_diff_key($a[$table],$b[$table]) as $row)$this->pdo->prepare("DELETE FROM $table WHERE tournament_id=? AND $key=?")->execute([$row['tournament_id'],$row[$key]]);
  foreach($b as $table=>$rows)foreach($rows as $id=>$row){
   if(isset($a[$table][$id])&&$a[$table][$id]===$row)continue;
   $cols=array_keys($row);$update=implode(',',array_map(fn($c)=>"$c=VALUES($c)",$cols));
   $sql="INSERT INTO $table (".implode(',',$cols).') VALUES ('.implode(',',array_fill(0,count($cols),'?')).") ON DUPLICATE KEY UPDATE $update";
   $this->pdo->prepare($sql)->execute(array_values($row));
  }
  $this->pdo->prepare('UPDATE app_meta SET revision=? WHERE id=1')->execute([$after['revision']]);
 }
}
