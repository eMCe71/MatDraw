<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Additive schema migrations for MariaDB 10.6 and MySQL 8.0 (plan §2.1–2.2, §2.8).
 * backend/database/schema.sql is the frozen baseline (version 1); every later change is a file
 * backend/migrations/NNNN_name.php returning ['id'=>N,'name'=>'…','destructive'=>bool,'floor'=>?fn(PDO):bool,'up'=>fn(Migrator):void].
 * Ids are contiguous from 2. Each step inside `up` is idempotent (DDL commits implicitly, so a failed run resumes
 * at the first unapplied step). app_meta.schema_version advances after every migration. Identifiers passed to the
 * helpers come only from constants in migration files and are still checked against a strict pattern.
 */
final class Migrator {
 /** Lock name prefix; the lock is per schema (matdraw_migrate:<database>), so staging and production, or parallel
  *  test databases on one server, never block each other. 16 + 48 characters stay within MySQL's 64-character limit. */
 public const LOCK='matdraw_migrate';
 private const LOCK_SQL="CONCAT('matdraw_migrate:',LEFT(IFNULL(DATABASE(),''),48))";
 private ?array $list=null;private bool $dry=false;private $log=null;
 public function __construct(private PDO $pdo,private string $dir){}
 /** id => path of every migration file, sorted; no database needed. */
 public static function files(string $dir):array {
  $out=[];foreach(glob(rtrim($dir,'/').'/*.php')?:[] as $f){if(!preg_match('/^(\d{4})_[a-z0-9_]+\.php$/D',basename($f),$m))throw new \RuntimeException('Niepoprawna nazwa pliku migracji: '.basename($f));$id=(int)$m[1];if(isset($out[$id]))throw new \RuntimeException("Powtórzony numer migracji $id.");$out[$id]=$f;}
  ksort($out);return $out;
 }
 /** Highest migration id shipped with this code (1 = baseline only, also when the directory is missing). */
 public static function target(string $dir):int{$f=is_dir($dir)?self::files($dir):[];return $f?max(1,max(array_keys($f))):1;}
 /** Loaded and validated definitions, id => array. */
 public function migrations():array {
  if($this->list!==null)return $this->list;$list=[];$expect=2;
  foreach(self::files($this->dir) as $id=>$f){
   if($id!==$expect)throw new \RuntimeException("Numery migracji muszą być ciągłe od 2: brak $expect.");$expect++;
   $m=require $f;
   if(!is_array($m)||($m['id']??null)!==$id||!is_string($m['name']??null)||!is_bool($m['destructive']??null)||!is_callable($m['up']??null)||(isset($m['floor'])&&!is_callable($m['floor'])))throw new \RuntimeException('Niepoprawna definicja migracji: '.basename($f));
   $list[$id]=$m;
  }
  return $this->list=$list;
 }
 public function current():int {
  if(!$this->tableExists('app_meta'))return 0;
  $v=$this->pdo->query('SELECT schema_version FROM app_meta WHERE id=1')->fetchColumn();return $v===false?0:(int)$v;
 }
 /** Ids of migrations newer than the database (empty for an empty database: the installer creates the baseline). */
 public function pending():array{$cur=$this->current();return $cur===0?[]:array_values(array_filter(array_keys($this->migrations()),fn($id)=>$id>$cur));}
 public function status():array {
  $cur=$this->current();$all=$this->migrations();$pending=$cur===0?[]:array_filter(array_keys($all),fn($id)=>$id>$cur);
  return ['state'=>$cur===0?'empty':'ready','current'=>$cur,'target'=>self::target($this->dir),'pending'=>count($pending),'destructive'=>count(array_filter($pending,fn($id)=>$all[$id]['destructive'])),'floor'=>$this->rollbackFloor()];
 }
 /** Lowest code version the data still needs: the highest applied migration whose floor() is true, else 1 (§2.8). */
 public function rollbackFloor():int {
  $cur=$this->current();$floor=1;
  foreach($this->migrations() as $id=>$m)if($id<=$cur&&isset($m['floor'])&&($m['floor'])($this->pdo))$floor=$id;
  return $floor;
 }
 /**
  * Applies pending migrations under a named lock. Returns the applied ids (with $dry: the ids that would run;
  * exec() then only logs its statements). Throws on an empty database, a held lock or a destructive migration
  * without $allowDestructive.
  */
 public function run(callable $log,bool $dry=false,bool $allowDestructive=false):array {
  if($this->current()===0)throw new \RuntimeException('Baza jest pusta. Najpierw uruchom instalator (backend/bin/install.php).');
  $all=$this->migrations();
  $this->pdo->exec('SET SESSION lock_wait_timeout=30');$this->pdo->exec('SET SESSION innodb_lock_wait_timeout=30');
  if((int)$this->pdo->query('SELECT GET_LOCK('.self::LOCK_SQL.',0)')->fetchColumn()!==1)throw new \RuntimeException('Inna migracja jest właśnie w toku. Ponów za chwilę.');
  $this->dry=$dry;$this->log=$log;$done=[];
  try{
   $cur=$this->current();
   foreach($all as $id=>$m){
    if($id<=$cur)continue;
    if($m['destructive']&&!$allowDestructive)throw new \RuntimeException(sprintf('Migracja %04d_%s jest niszcząca. Uruchom ją ręcznie z --allow-destructive po wykonaniu kopii.',$id,$m['name']));
    $log(sprintf('%s %04d_%s',$dry?'[dry-run] Migracja':'Migracja',$id,$m['name']));
    ($m['up'])($this);
    if(!$dry)$this->pdo->prepare('UPDATE app_meta SET schema_version=? WHERE id=1 AND schema_version<?')->execute([$id,$id]);
    $done[]=$id;
   }
  }finally{$this->dry=false;$this->log=null;try{$this->pdo->query('SELECT RELEASE_LOCK('.self::LOCK_SQL.')')->fetchAll();}catch(\Throwable){}}
  return $done;
 }
 // Helpers for migration files. All existence checks use information_schema with TABLE_SCHEMA=DATABASE().
 public function pdo():PDO{return $this->pdo;}
 public function exec(string $sql,array $params=[]):int {
  if($this->dry){($this->log)('  '.preg_replace('/\s+/',' ',trim($sql)));return 0;}
  if(!$params)return (int)$this->pdo->exec($sql);
  $q=$this->pdo->prepare($sql);$q->execute($params);return $q->rowCount();
 }
 private function one(string $sql,array $params):mixed{$q=$this->pdo->prepare($sql);$q->execute($params);$v=$q->fetchColumn();$q->closeCursor();return $v;}
 private static function name(string $n):string{if(!preg_match('/^[a-z][a-z0-9_]{0,63}$/D',$n))throw new \InvalidArgumentException('Niepoprawny identyfikator: '.$n);return $n;}
 public function tableExists(string $table):bool{return $this->one('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table])!==false;}
 public function columnExists(string $table,string $column):bool{return $this->one('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[$table,$column])!==false;}
 public function columnNullable(string $table,string $column):bool{return $this->one('SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[$table,$column])==='YES';}
 public function enumHas(string $table,string $column,string $value):bool {
  $type=(string)$this->one('SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[$table,$column]);
  if(!preg_match('/^enum\((.*)\)$/Dis',$type,$m))return false;preg_match_all("/'((?:[^']|'')*)'/",$m[1],$v);
  return in_array($value,array_map(fn($s)=>str_replace("''","'",$s),$v[1]),true);
 }
 public function indexExists(string $table,string $name):bool{return $this->one('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',[$table,$name])!==false;}
 /** ALTER TABLE … ADD COLUMN only when the column is missing (new columns on old tables must be NULL or have a DEFAULT). */
 public function addColumn(string $table,string $column,string $definition):bool{if($this->columnExists($table,$column))return false;$this->exec('ALTER TABLE '.self::name($table).' ADD COLUMN '.self::name($column).' '.$definition);return true;}
 /** CREATE [UNIQUE] INDEX only when an index with that name is missing. */
 public function addIndex(string $table,string $name,string $columnsSql,bool $unique=false):bool{if($this->indexExists($table,$name))return false;$this->exec('CREATE '.($unique?'UNIQUE ':'').'INDEX '.self::name($name).' ON '.self::name($table).' ('.$columnsSql.')');return true;}
}
