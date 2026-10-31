<?php
// Schema migrations from the command line (plan §2.2). Uses config['db_migrate'] when present, otherwise config['db'].
//   php backend/bin/migrate.php                     apply pending migrations
//   php backend/bin/migrate.php --status            STATE=ready|empty CURRENT=n TARGET=n PENDING=n DESTRUCTIVE=n FLOOR=n
//   php backend/bin/migrate.php --dry-run           list what would run, change nothing
//   php backend/bin/migrate.php --allow-destructive also run migrations marked destructive (by hand, after a backup)
//   php backend/bin/migrate.php --rollback-floor    lowest code version the data needs (§2.8), number only
// Exit codes: 0 up to date / applied / database newer than code (warning) / --status and --rollback-floor printed;
// 10 empty database (run the installer); 2 destructive migration waiting; 1 error.
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
require_once dirname(__DIR__).'/src/Migrator.php';
use MatDraw\Migrator;
$opts=getopt('',['status','dry-run','allow-destructive','rollback-floor']);
$out=fn(string $s)=>fwrite(STDOUT,$s."\n");
try{
 $c=matdraw_config();$m=new Migrator(matdraw_database(['db'=>is_array($c['db_migrate']??null)?$c['db_migrate']:$c['db']]),dirname(__DIR__).'/migrations');
 if(isset($opts['rollback-floor'])){$out((string)$m->rollbackFloor());exit(0);}
 $s=$m->status();
 if(isset($opts['status'])){$out(sprintf('STATE=%s CURRENT=%d TARGET=%d PENDING=%d DESTRUCTIVE=%d FLOOR=%d',$s['state'],$s['current'],$s['target'],$s['pending'],$s['destructive'],$s['floor']));exit(0);}
 if($s['state']==='empty'){$out('Baza jest pusta. Uruchom instalator: backend/bin/install.php (INSTALL-PL.md).');exit(10);}
 if($s['current']>$s['target']){$out(sprintf('Uwaga: baza (wersja %d) jest nowsza niż kod (wersja %d). Bez zmian.',$s['current'],$s['target']));exit(0);}
 if($s['destructive']&&!isset($opts['allow-destructive'])){fwrite(STDERR,"Czeka migracja niszcząca. Zrób kopię bazy i uruchom ją ręcznie z --allow-destructive.\n");exit(2);}
 if(!$s['pending']){$out(sprintf('Schemat aktualny (wersja %d).',$s['current']));exit(0);}
 $done=$m->run($out,isset($opts['dry-run']),isset($opts['allow-destructive']));
 $out(isset($opts['dry-run'])?sprintf('[dry-run] Bez zmian. Do zastosowania: %d.',count($done)):sprintf('Schemat: v%d -> v%d',$s['current'],$m->current()));
}catch(PDOException $e){
 // 1205 lock wait timeout (also metadata locks), 1213 deadlock: the old release is writing right now.
 if(in_array($e->errorInfo[1]??null,[1205,1213],true)){fwrite(STDERR,"Baza jest chwilowo zajęta. Ponów wdrożenie za kilka minut.\n");exit(1);}
 fwrite(STDERR,'Błąd bazy danych (SQLSTATE '.($e->errorInfo[0]??$e->getCode()).', kod '.($e->errorInfo[1]??'?').'): '.$e->getMessage()."\n");exit(1);
}catch(Throwable $e){fwrite(STDERR,$e->getMessage()."\n");exit(1);}
