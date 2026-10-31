<?php
// Pure-PDO database dump for hosts without mysqldump/mariadb-dump (plan §9.6, report 04 §2.a.3).
//   php backend/bin/dump.php > db.sql            plain SQL on STDOUT (deploy-remote.sh pipes it through gzip)
//   php backend/bin/dump.php --auto [--dir=PATH] daily copy for cron: <base>/backups/db-<date>-daily.sql.gz, where
//                                                <base> is the parent of the shared/ directory holding config.php
// --auto does nothing when a db-*.sql.gz younger than 20 h exists, writes the file as *.tmp (mode 600, directory 700),
// accepts it only when it is valid gzip ending with the "Dump completed" marker, then deletes db-*.sql.gz copies
// older than 30 days while always keeping the newest one.
// One REPEATABLE READ transaction gives a consistent snapshot; rows are streamed with an unbuffered query, so a
// large table (chat history) never sits in memory. Restore: drop all MatDraw tables (or use an empty database),
// import, then run migrate.php (DEPLOY-PL.md).
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
const DUMP_FRESH_SECONDS=72000,DUMP_KEEP_DAYS=30,DUMP_BATCH_BYTES=262144;
$opts=getopt('',['auto','dir:']);
/** Writes the whole dump through $write. */
function matdraw_dump(PDO $pdo,callable $write):void {
 $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY,false);
 $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');$pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
 $all=function(string $sql,array $p=[])use($pdo):array{if($p){$q=$pdo->prepare($sql);$q->execute($p);}else $q=$pdo->query($sql);$r=$q->fetchAll(PDO::FETCH_NUM);$q->closeCursor();return $r;};
 $id=fn(string $n)=>'`'.str_replace('`','``',$n).'`';
 $write("-- MatDraw database dump (backend/bin/dump.php)\n-- Server: ".$pdo->getAttribute(PDO::ATTR_SERVER_VERSION)."\n/*!40101 SET NAMES utf8mb4 */;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nSET time_zone='+00:00';\n\n");
 foreach($all("SHOW FULL TABLES WHERE Table_type='BASE TABLE'") as [$table]){
  $create=$all('SHOW CREATE TABLE '.$id($table))[0][1];
  // Binary columns are written as hex literals so no byte passes through the connection character set;
  // generated columns are recomputed on import.
  $binary=[];foreach($all('SELECT COLUMN_NAME,DATA_TYPE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[$table]) as [$col,$type,$extra])if(!preg_match('/GENERATED|VIRTUAL|STORED/i',(string)$extra))$binary[$col]=(bool)preg_match('/blob|binary/i',$type);
  $write("DROP TABLE IF EXISTS ".$id($table).";\n$create;\n");
  $head='INSERT INTO '.$id($table).' ('.implode(',',array_map($id,array_keys($binary))).') VALUES ';$buf='';
  $q=$pdo->query('SELECT '.implode(',',array_map($id,array_keys($binary))).' FROM '.$id($table));
  while($row=$q->fetch(PDO::FETCH_ASSOC)){
   $vals=[];foreach($row as $col=>$v)$vals[]=$v===null?'NULL':(is_int($v)||is_float($v)?var_export($v,true):(($binary[$col]??false)?($v===''?"''":'0x'.bin2hex($v)):$pdo->quote((string)$v)));
   $buf.=($buf===''?$head:',').'('.implode(',',$vals).')';
   if(strlen($buf)>=DUMP_BATCH_BYTES){$write($buf.";\n");$buf='';}
  }
  $q->closeCursor();if($buf!=='')$write($buf.";\n");$write("\n");
 }
 $pdo->exec('COMMIT');
 $write("SET UNIQUE_CHECKS=1;\nSET FOREIGN_KEY_CHECKS=1;\n-- Dump completed on ".date('Y-m-d H:i:s')."\n");
}
try{
 $c=matdraw_config();
 if(!isset($opts['auto'])){matdraw_dump(matdraw_database($c),function(string $s){fwrite(STDOUT,$s);});exit(0);}
 // --auto: the backups directory sits next to shared/ (~/matdraw/backups), outside the docroot and the release.
 if(isset($opts['dir']))$dir=rtrim((string)$opts['dir'],'/');
 else{
  $cfg=realpath(getenv('MATDRAW_CONFIG')?:dirname(__DIR__).'/config.php');
  if(!$cfg||basename(dirname($cfg))!=='shared')throw new RuntimeException('Nie można ustalić katalogu kopii: config.php nie leży w katalogu shared/. Podaj --dir=/ścieżka/do/backups.');
  $dir=dirname($cfg,2).'/backups';
 }
 if(!is_dir($dir)&&!mkdir($dir,0700,true))throw new RuntimeException("Nie można utworzyć katalogu $dir.");
 chmod($dir,0700);
 $now=time();$copies=glob($dir.'/db-*.sql.gz')?:[];usort($copies,fn($a,$b)=>filemtime($b)<=>filemtime($a));
 if($copies&&$now-filemtime($copies[0])<DUMP_FRESH_SECONDS){fwrite(STDOUT,'Kopia bazy jest aktualna: '.basename($copies[0])."\n");exit(0);}
 $out=$dir.'/db-'.date('YmdHis',$now).'-daily.sql.gz';for($n=2;file_exists($out);$n++)$out=$dir.'/db-'.date('YmdHis',$now)."-daily-$n.sql.gz";$tmp=$out.'.tmp';
 $old=umask(0077);$gz=gzopen($tmp,'wb6');umask($old);if(!$gz)throw new RuntimeException("Nie można zapisać $tmp.");chmod($tmp,0600);
 try{matdraw_dump(matdraw_database($c),function(string $s)use($gz,$tmp){if(gzwrite($gz,$s)!==strlen($s))throw new RuntimeException("Błąd zapisu $tmp.");});}
 catch(Throwable $e){gzclose($gz);@unlink($tmp);throw $e;}
 gzclose($gz);
 // Accept only a complete copy: the gzip stream reads to the end and its tail carries the marker.
 $in=gzopen($tmp,'rb');$tail='';while(!gzeof($in)){$chunk=gzread($in,65536);if($chunk===false){$tail='';break;}$tail=substr($tail.$chunk,-400);}gzclose($in);
 if(!str_contains($tail,'-- Dump completed on ')){@unlink($tmp);throw new RuntimeException('Kopia bazy jest niekompletna. Nic nie zapisano.');}
 rename($tmp,$out);chmod($out,0600);
 fwrite(STDOUT,'Kopia bazy: '.$out.' ('.filesize($out)." B)\n");
 // Retention: delete copies older than 30 days, never the newest.
 $copies=glob($dir.'/db-*.sql.gz')?:[];usort($copies,fn($a,$b)=>filemtime($b)<=>filemtime($a));
 foreach(array_slice($copies,1) as $f)if($now-filemtime($f)>DUMP_KEEP_DAYS*86400&&unlink($f))fwrite(STDOUT,'Usunięto starą kopię: '.basename($f)."\n");
}catch(PDOException $e){fwrite(STDERR,'Błąd bazy danych (SQLSTATE '.($e->errorInfo[0]??$e->getCode()).'). Kopia nie powstała.'."\n");exit(1);}
catch(Throwable $e){fwrite(STDERR,$e->getMessage()."\n");exit(1);}
