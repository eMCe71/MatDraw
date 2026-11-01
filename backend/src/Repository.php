<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * One transaction and revision cover cross-tournament/profile invariants (PLAN-REJESTRACJA-ROLE §4.3, R5).
 * Members (role member) never enter the workspace as data: transaction($fn, $actor) puts the member actor of the request
 * into $db['users'] for $fn only, and rows() skips every member. Read-only parts of $db: organizers {userId:{trusted,
 * blocked}} (members who created tournaments), flags (Settings::flags, from the caller), withdrawals (tombstones the
 * command writes) and withdrawalsPurge (Domain::retain). persist() inserts new keys with a plain INSERT and updates
 * changed rows with UPDATE … WHERE key (never an upsert that could take over another club by its unique name), maps a
 * duplicate key to 409, deletes profiles missing from the result after entries and draws, and writes the revision stamps.
 */
final class Repository {
 private const KEYS=['clubs'=>['id'],'profiles'=>['id'],'tournaments'=>['id'],'entries'=>['tournament_id','profile_id'],'draws'=>['tournament_id','category_key']];
 public function __construct(private PDO $pdo){}
 /** Placeholders for an IN list of $values. */
 private static function in(array $values):string{return implode(',',array_fill(0,count($values),'?'));}
 private static function json(mixed $v):string{return json_encode($v,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);}
 private static function decode(string $v):array{return json_decode($v,true,512,JSON_THROW_ON_ERROR);}
 public function snapshot():array {
  $this->pdo->beginTransaction();
  try{$db=$this->load();$this->pdo->commit();return $db;}catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 /**
  * Runs $fn(&$db) under the workspace lock and persists the result. $actor: the account of the request (Actors::of); a
  * member is in $db['users'] while $fn runs and never written. $flags: Settings::flags(effective config) for Domain.
  */
 public function transaction(callable $fn,?array $actor=null,?array $flags=null):mixed {
  $this->pdo->beginTransaction();
  try {
   $this->pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetch();
   Clubs::ensure($this->pdo);
   $before=$this->load();$next=$before;$member=$actor!==null&&($actor['role']??null)==='member';
   if($member){$next['users']=array_values(array_filter($next['users'],fn($u)=>$u['id']!==$actor['id']));$next['users'][]=$actor;}
   if($flags!==null)$next['flags']=$flags;
   $result=$fn($next);
   if($member)$next['users']=array_values(array_filter($next['users'],fn($u)=>($u['role']??null)!=='member'));
   $this->persist($before,$next);$this->pdo->commit();return $result;
  }catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 /**
  * Read-only data for GuestView: only tournaments that may be public (not drafts, dated $today or later), without
  * creators, mats or activity; entries and draws only for the one requested tournament. Accounts and the athlete
  * database are never read here. selfEntry is the tournament's switch (GuestView::tournament shows it while open, F2);
  * community/trusted come from the creator's row (§5.6; trusted follows $flags trustRequired, §17) and every entry gets currentClub {id, name}: the merge target, name null for an unverified club
  * and '' for 'unaffiliated' (PS-10: snapshots keep the name of the moment of entry, the public view the current one).
  */
 public function guestTournaments(string $today,?string $id=null,?array $flags=null):array {
  $this->pdo->beginTransaction();
  try{
   $q=$this->pdo->prepare("SELECT t.id,t.name,t.city,t.event_date,t.status,t.self_entry,u.role,u.organizer_trusted_at,u.organizer_blocked_at FROM tournaments t LEFT JOIN users u ON u.id=t.created_by WHERE t.status IN ('open','closed','finished') AND t.event_date>=?".($id===null?'':' AND t.id=?').' ORDER BY t.event_date,t.id');
   $q->execute($id===null?[$today]:[$today,$id]);$list=[];$any=($flags['trustRequired']??true)===false;
   foreach($q->fetchAll() as $t){
    $community=!in_array($t['role'],Domain::STAFF,true);$trusted=!$community||$t['organizer_blocked_at']===null&&($t['organizer_trusted_at']!==null||$any);
    $list[]=['id'=>$t['id'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['event_date'],'status'=>$t['status'],'selfEntry'=>(int)$t['self_entry']===1,'community'=>$community,'trusted'=>$trusted,'entries'=>[],'draws'=>[]];
   }
   if($id!==null&&$list){
    $e=$this->pdo->prepare('SELECT e.snapshot,c.id cid,c.verified,m.id mid,m.name mname,m.verified mverified,c.name cname FROM entries e LEFT JOIN clubs c ON c.id=e.club_id LEFT JOIN clubs m ON m.id=c.merged_into WHERE e.tournament_id=? ORDER BY e.profile_id');$e->execute([$id]);
    foreach($e->fetchAll() as $row){
     $s=self::decode($row['snapshot']);[$cid,$name,$verified]=$row['mid']!==null?[$row['mid'],$row['mname'],$row['mverified']]:[$row['cid']??($s['clubId']??null),$row['cname'],$row['verified']];
     $s['currentClub']=['id'=>$cid,'name'=>$cid===Clubs::UNAFFILIATED?'':($verified!==null&&(int)$verified===1?(string)$name:null)];$list[0]['entries'][]=$s;
    }
    $d=$this->pdo->prepare('SELECT category_key,data FROM draws WHERE tournament_id=? ORDER BY category_key');$d->execute([$id]);
    foreach($d->fetchAll() as $row)$list[0]['draws'][$row['category_key']]=self::decode($row['data']);
   }
   $this->pdo->commit();return $list;
  }catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 private static function club(array $c):array{return ['id'=>$c['id'],'name'=>$c['name'],'verified'=>(bool)$c['verified'],'createdBy'=>$c['created_by'],'createdAt'=>$c['created_at']===null?null:(int)$c['created_at'],'mergedInto'=>$c['merged_into']];}
 private static function profile(array $a):array{return array_replace(self::decode($a['data']),['id'=>$a['id'],'clubId'=>$a['club_id'],'createdBy'=>$a['created_by'],'archived'=>(bool)$a['archived'],'ownerId'=>$a['owner_user_id'],'rev'=>(int)$a['rev']]);}
 private static function tournament(array $t):array{return ['id'=>$t['id'],'createdBy'=>$t['created_by'],'createdAt'=>$t['created_at']===null?null:(int)$t['created_at'],'name'=>$t['name'],'city'=>$t['city'],'date'=>$t['event_date'],'mat'=>$t['mat'],'status'=>$t['status'],'selfEntry'=>(bool)$t['self_entry'],'hiddenBy'=>$t['hidden_by'],'hiddenFrom'=>$t['hidden_from'],'hideReason'=>$t['hide_reason'],'rev'=>(int)$t['rev'],'activity'=>self::decode($t['activity']),'entries'=>[],'draws'=>[]];}
 private function meta():array{$m=$this->pdo->query('SELECT revision,staff_rev FROM app_meta WHERE id=1')->fetch();return [(int)$m['revision'],(int)$m['staff_rev']];}
 /** Members who created tournaments: {id:{trusted, blocked}} (Domain::trustedOrganizer). */
 private function organizers():array{$o=[];foreach($this->pdo->query("SELECT id,organizer_trusted_at,organizer_blocked_at FROM users WHERE role='member' AND id IN (SELECT created_by FROM tournaments)") as $u)$o[$u['id']]=['trusted'=>$u['organizer_trusted_at']!==null,'blocked'=>$u['organizer_blocked_at']!==null];return $o;}
 private function staff():array{$users=[];foreach($this->pdo->query("SELECT * FROM users WHERE role IN ('admin','editor','club') ORDER BY email,id") as $u)$users[]=['id'=>$u['id'],'clubId'=>$u['club_id'],'email'=>$u['email'],'role'=>$u['role'],'active'=>(bool)$u['active'],'passwordHash'=>$u['password_hash'],'authVersion'=>(int)$u['auth_version']];return $users;}
 private function clubs():array{return array_map([self::class,'club'],$this->pdo->query("SELECT id,name,verified,created_by,created_at,merged_into FROM clubs ORDER BY id='unaffiliated',name,id")->fetchAll());}
 private function load():array {
  [$revision,$staffRev]=$this->meta();
  // Members (community accounts) never enter the workspace: Domain and the JS workspace see staff only. The staff roles are
  // listed (not role<>'member', which MySQL/MariaDB cannot read through an ENUM index): with the users_role index
  // (migration 0005) this is a range read of the staff rows, whatever the number of members.
  $db=['schemaVersion'=>2,'revision'=>$revision,'staffRev'=>$staffRev,'clubs'=>$this->clubs(),'users'=>$this->staff(),'profiles'=>[],'tournaments'=>[],'organizers'=>$this->organizers(),'withdrawals'=>[]];
  foreach($this->pdo->query('SELECT * FROM profiles ORDER BY id') as $a)$db['profiles'][]=self::profile($a);
  $index=[];
  foreach($this->pdo->query('SELECT * FROM tournaments ORDER BY event_date,id') as $t){$index[$t['id']]=count($db['tournaments']);$db['tournaments'][]=self::tournament($t);}
  foreach($this->pdo->query('SELECT * FROM entries ORDER BY tournament_id,profile_id') as $e)$db['tournaments'][$index[$e['tournament_id']]]['entries'][]=self::decode($e['snapshot']);
  foreach($this->pdo->query('SELECT * FROM draws ORDER BY tournament_id,category_key') as $d)$db['tournaments'][$index[$d['tournament_id']]]['draws'][$d['category_key']]=self::decode($d['data']);
  return $db;
 }
 /**
  * The workspace part an organizer may see (B2, DR-6), for bootstrap of a member organizer: staff accounts, every club,
  * own tournaments with all entries and draws, other tournaments that are open for self-entries or hold his entries with
  * only his entries, no draws and no log, his own profiles, organizers and revisions. Entries and logs of other people's
  * tournaments never reach the memory of the request; self-entries and the log of his tournaments hidden by the
  * Administrator are dropped too. Domain::publicData() of this snapshot equals publicData() of load() for this
  * organizer (tests/domain.http.test.mjs). $today is accepted for the plan's signature; the selection has no date rule,
  * like publicData.
  */
 public function organizerSnapshot(string $userId,?string $today=null):array {
  $this->pdo->beginTransaction();
  try{
   [$revision,$staffRev]=$this->meta();
   $db=['schemaVersion'=>2,'revision'=>$revision,'staffRev'=>$staffRev,'clubs'=>$this->clubs(),'users'=>$this->staff(),'profiles'=>[],'tournaments'=>[],'organizers'=>$this->organizers(),'withdrawals'=>[]];
   $q=$this->pdo->prepare('SELECT * FROM profiles WHERE created_by=? OR owner_user_id=? ORDER BY id');$q->execute([$userId,$userId]);foreach($q->fetchAll() as $a)$db['profiles'][]=self::profile($a);
   // Where his profiles are entered: keys only, from the profiles indexes (created_by, owner) and the covering profile_id index of
   // entries (an OR or a subquery over all profiles, or full entry rows, would read far more: the §12 budget).
   $q=$this->pdo->prepare('SELECT e.tournament_id,e.profile_id FROM profiles p JOIN entries e ON e.profile_id=p.id WHERE p.created_by=? UNION ALL SELECT e.tournament_id,e.profile_id FROM profiles p JOIN entries e ON e.profile_id=p.id WHERE p.owner_user_id=? AND p.created_by<>?');
   $q->execute([$userId,$userId,$userId]);$keys=$q->fetchAll();$entered=array_values(array_unique(array_column($keys,'tournament_id')));
   // The log (it names athletes) and the hide reason only of his own tournaments, the log not of the hidden ones: publicData shows nothing more.
   $q=$this->pdo->prepare("SELECT id,created_by,created_at,name,city,event_date,mat,status,self_entry,rev,hidden_by,hidden_from,CASE WHEN created_by=? THEN hide_reason END AS hide_reason,CASE WHEN created_by=? AND hidden_by IS NULL THEN activity ELSE '[]' END AS activity FROM tournaments WHERE created_by=? OR (status='open' AND self_entry=1 AND hidden_by IS NULL)".($entered?' OR id IN ('.self::in($entered).')':'').' ORDER BY event_date,id');
   $q->execute([$userId,$userId,$userId,...$entered]);$index=[];
   foreach($q->fetchAll() as $t){$index[$t['id']]=count($db['tournaments']);$db['tournaments'][]=self::tournament($t);}
   $q=$this->pdo->prepare('SELECT e.* FROM entries e JOIN tournaments t ON t.id=e.tournament_id WHERE t.created_by=? ORDER BY e.tournament_id,e.profile_id');$q->execute([$userId]);$rows=$q->fetchAll();
   // His entries in other people's tournaments (few): the rows of exactly those keys, ordered like load() (tournament, then profile).
   $outside=[];foreach($keys as $k)if(isset($index[$k['tournament_id']])&&$db['tournaments'][$index[$k['tournament_id']]]['createdBy']!==$userId)$outside[$k['tournament_id']."\n".$k['profile_id']]=$k;
   if($outside){
    $ts=array_values(array_unique(array_column($outside,'tournament_id')));$ps=array_values(array_unique(array_column($outside,'profile_id')));
    $q=$this->pdo->prepare('SELECT * FROM entries WHERE tournament_id IN ('.self::in($ts).') AND profile_id IN ('.self::in($ps).') ORDER BY tournament_id,profile_id');$q->execute([...$ts,...$ps]);
    foreach($q->fetchAll() as $e)if(isset($outside[$e['tournament_id']."\n".$e['profile_id']]))$rows[]=$e;
   }
   foreach($rows as $e){$t=&$db['tournaments'][$index[$e['tournament_id']]];$s=self::decode($e['snapshot']);if($t['createdBy']!==$userId||$t['hiddenBy']===null||empty($s['self']))$t['entries'][]=$s;unset($t);}
   $q=$this->pdo->prepare('SELECT d.* FROM draws d JOIN tournaments t ON t.id=d.tournament_id WHERE t.created_by=? ORDER BY d.tournament_id,d.category_key');$q->execute([$userId]);
   foreach($q->fetchAll() as $d)$db['tournaments'][$index[$d['tournament_id']]]['draws'][$d['category_key']]=self::decode($d['data']);
   $this->pdo->commit();return $db;
  }catch(\Throwable $e){$this->pdo->rollBack();throw $e;}
 }
 /** The profiles row of a workspace profile (shared by rows() and the sign-up, which inserts an athlete profile itself, R19). */
 public static function profileRow(array $a):array{return ['id'=>$a['id'],'club_id'=>$a['clubId'],'created_by'=>$a['createdBy'],'archived'=>(int)!empty($a['archived']),'owner_user_id'=>$a['ownerId']??null,'rev'=>(int)($a['rev']??0),'data'=>self::json($a)];}
 /** Rows per table; missing keys get their defaults, so callers that build $db by hand (install.php, seed-athletes.php) keep working. */
 private function rows(array $db):array {
  $rows=['clubs'=>[],'users'=>[],'profiles'=>[],'tournaments'=>[],'entries'=>[],'draws'=>[]];
  foreach($db['clubs'] as $c)$rows['clubs'][$c['id']]=['id'=>$c['id'],'name'=>$c['name'],'verified'=>(int)(($c['verified']??true)!==false),'created_by'=>$c['createdBy']??null,'created_at'=>$c['createdAt']??null,'merged_into'=>$c['mergedInto']??null];
  foreach($db['users'] as $u){if(($u['role']??null)==='member')continue;$rows['users'][$u['id']]=['id'=>$u['id'],'club_id'=>$u['clubId'],'email'=>$u['email'],'role'=>$u['role'],'active'=>(int)$u['active'],'password_hash'=>$u['passwordHash'],'auth_version'=>$u['authVersion']];}
  foreach($db['profiles'] as $a)$rows['profiles'][$a['id']]=self::profileRow($a);
  foreach($db['tournaments'] as $t){
   $rows['tournaments'][$t['id']]=['id'=>$t['id'],'created_by'=>$t['createdBy'],'name'=>$t['name'],'city'=>$t['city'],'event_date'=>$t['date'],'mat'=>$t['mat'],'status'=>$t['status'],'activity'=>self::json($t['activity']),'created_at'=>$t['createdAt']??null,'hidden_by'=>$t['hiddenBy']??null,'hidden_from'=>$t['hiddenFrom']??null,'hide_reason'=>$t['hideReason']??null,'self_entry'=>(int)(($t['selfEntry']??false)===true),'rev'=>(int)($t['rev']??0)];
   foreach($t['entries'] as $e)$rows['entries'][$t['id'].'/'.$e['id']]=['tournament_id'=>$t['id'],'profile_id'=>$e['profileId'],'club_id'=>$e['clubId'],'snapshot'=>self::json($e)];
   foreach($t['draws'] as $key=>$d)$rows['draws'][$t['id'].'/'.$key]=['tournament_id'=>$t['id'],'category_key'=>$key,'data'=>self::json($d)];
  }return $rows;
 }
 /** A statement of persist(): a duplicate key is the friendly 409 (on clubs: a club with a similar name), never the PDO text. */
 private function write(string $table,string $sql,array $values):int {
  try{$q=$this->pdo->prepare($sql);$q->execute($values);return $q->rowCount();}
  catch(\PDOException $e){if(($e->errorInfo[1]??null)===1062)throw new AppError($table==='clubs'?'Klub o podobnej nazwie już istnieje. Wybierz go z listy.':'Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409);throw $e;}
 }
 private function persist(array $before,array $after):void {
  $a=$this->rows($before);$b=$this->rows($after);
  foreach(['draws'=>'category_key','entries'=>'profile_id'] as $table=>$key)foreach(array_diff_key($a[$table],$b[$table]) as $row)$this->pdo->prepare("DELETE FROM $table WHERE tournament_id=? AND $key=?")->execute([$row['tournament_id'],$row[$key]]);
  foreach($after['withdrawals']??[] as $w)$this->pdo->prepare('INSERT INTO entry_withdrawals (profile_id,tournament_id,by_kind,created_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE by_kind=VALUES(by_kind),created_at=VALUES(created_at)')->execute([$w['profileId'],$w['tournamentId'],$w['by'],$w['at']]);
  if(is_string($after['withdrawalsPurge']??null))$this->pdo->prepare('DELETE w FROM entry_withdrawals w JOIN tournaments t ON t.id=w.tournament_id WHERE t.event_date<?')->execute([$after['withdrawalsPurge']]);
  // Profiles removed by Domain (forgetProfile) leave after their entries; nothing may only seem deleted (DR-2).
  foreach(array_keys(array_diff_key($a['profiles'],$b['profiles'])) as $id){
   $q=$this->pdo->prepare('DELETE FROM profiles WHERE id=? AND NOT EXISTS (SELECT 1 FROM entries WHERE profile_id=?)');$q->execute([$id,$id]);
   if($q->rowCount()===0)throw new \RuntimeException('A forgotten profile still has entries; nothing was saved.');
   $this->pdo->prepare('DELETE FROM entry_withdrawals WHERE profile_id=?')->execute([$id]);
  }
  foreach($b as $table=>$rows)foreach($rows as $id=>$row){
   if(isset($a[$table][$id])&&$a[$table][$id]===$row)continue;
   if($table==='users'){$this->persistUser($row,$a['users'][$id]??null);continue;}
   if(!isset($a[$table][$id])){
    $cols=array_keys($row);$this->write($table,"INSERT INTO $table (".implode(',',$cols).') VALUES ('.implode(',',array_fill(0,count($cols),'?')).')',array_values($row));
    if($table==='entries')$this->pdo->prepare('DELETE FROM entry_withdrawals WHERE profile_id=? AND tournament_id=?')->execute([$row['profile_id'],$row['tournament_id']]);
    continue;
   }
   $keys=self::KEYS[$table];$set=array_diff_key($row,array_flip($keys));
   $this->write($table,"UPDATE $table SET ".implode(',',array_map(fn($c)=>"$c=?",array_keys($set)))." WHERE ".implode(' AND ',array_map(fn($c)=>"$c=?",$keys)),[...array_values($set),...array_map(fn($c)=>$row[$c],$keys)]);
  }
  $this->pdo->prepare('UPDATE app_meta SET revision=?,staff_rev=? WHERE id=1')->execute([$after['revision'],(int)($after['staffRev']??$before['staffRev']??0)]);
 }
 /**
  * Accounts are never upserted (§2.6): an upsert hitting the unique e-mail of a member, which load() does not see,
  * would take over that row. New ids are inserted, changed rows are updated only while they are not members, and a
  * duplicate key on this statement is the friendly 409 (transaction() then rolls everything back).
  * A changed e-mail of a staff account with a Stripe customer (a paying club, §3.9) makes its billing row due now: the
  * next sync (billing-due, the lazy sync after me) gives the customer the new address, so receipts and payment
  * reminders do not keep going to the old one until the period ends. No Stripe call runs inside this transaction.
  */
 private function persistUser(array $u,?array $old):void {
  $exists=$old!==null;
  if($exists&&$old['email']!==$u['email'])$this->pdo->prepare('UPDATE billing_accounts SET next_sync_at=?,updated_at=? WHERE user_id=? AND stripe_customer_id IS NOT NULL AND deleted_at IS NULL')->execute([time(),time(),$u['id']]);
  try{
   if($exists)$this->pdo->prepare("UPDATE users SET club_id=?,email=?,role=?,active=?,password_hash=?,auth_version=? WHERE id=? AND role<>'member'")->execute([$u['club_id'],$u['email'],$u['role'],$u['active'],$u['password_hash'],$u['auth_version'],$u['id']]);
   else $this->pdo->prepare('INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES (?,?,?,?,?,?,?)')->execute([$u['id'],$u['club_id'],$u['email'],$u['role'],$u['active'],$u['password_hash'],$u['auth_version']]);
  }catch(\PDOException $e){if(($e->errorInfo[1]??null)===1062)throw new AppError('Konto z tym adresem e-mail już istnieje.',409);throw $e;}
 }
}
