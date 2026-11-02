<?php
// Test-only fixture jobs of tournament materials (PLAN-MATERIALY; loaded by tests/helpers/fixture.php; CLI, test database only).
//   materials-row {t}          the stored materials (decoded) and the revision stamp of tournament t
//   materials-files {t}        files of the tournament's materials directory with their modes, the modes of the directory and
//                              of its prefix directory, and its path (dir null when there is none)
//   materials-age {t, days, keep?}  sets the mtime of the directory and its files (except names starting with keep) $days back
//   materials-stray {t}        an unreferenced file two days old and a fresh one in the tournament's directory
//   materials-orphan {}        a directory with one file for a tournament id that does not exist, two days old; returns its name
//   materials-sweep {budget, after?}  Materials::sweep: {files, dirs, next}
//   materials-exists {dir}     whether <uploads>/materials/<dir[0..1]>/<dir> exists
declare(strict_types=1);
use MatDraw\{Domain,Materials};
function fixture_materials_dir(array $c,string $t):string{$d=Materials::dir($c,$t);if($d===null)throw new RuntimeException('materials: invalid tournament id');return $d;}
return [
 'materials-row'=>function(PDO $pdo,array $p):?array{
  $q=$pdo->prepare('SELECT materials,rev FROM tournaments WHERE id=?');$q->execute([(string)($p['t']??'')]);$r=$q->fetch(PDO::FETCH_ASSOC);
  return $r?['materials'=>Materials::decode($r['materials']),'raw'=>$r['materials'],'rev'=>(int)$r['rev']]:null;
 },
 'materials-files'=>function(PDO $pdo,array $p,array $c):array{
  $dir=fixture_materials_dir($c,(string)($p['t']??''));clearstatcache();if(!is_dir($dir))return ['dir'=>null,'files'=>new stdClass(),'path'=>$dir];
  $files=[];foreach(scandir($dir) as $f)if($f!=='.'&&$f!=='..')$files[$f]=sprintf('%04o',fileperms("$dir/$f")&0777);ksort($files);
  return ['dir'=>sprintf('%04o',fileperms($dir)&0777),'parent'=>sprintf('%04o',fileperms(dirname($dir))&0777),'root'=>sprintf('%04o',fileperms(dirname($dir,2))&0777),'files'=>(object)$files,'path'=>$dir];
 },
 'materials-age'=>function(PDO $pdo,array $p,array $c):array{
  $dir=fixture_materials_dir($c,(string)($p['t']??''));$t=time()-(int)($p['days']??2)*86400;$keep=(string)($p['keep']??'');$out=[];
  foreach(scandir($dir) as $f)if($f!=='.'&&$f!=='..'&&($keep===''||!str_starts_with($f,$keep))){touch("$dir/$f",$t);$out[]=$f;}
  touch($dir,$t);return $out;
 },
 'materials-stray'=>function(PDO $pdo,array $p,array $c):array{
  $dir=fixture_materials_dir($c,(string)($p['t']??''));$old=str_repeat('0',32).'-lg.webp';$fresh=str_repeat('1',32).'.pdf';
  file_put_contents("$dir/$old",'x');touch("$dir/$old",time()-2*86400);file_put_contents("$dir/$fresh",'y');return ['old'=>$old,'fresh'=>$fresh];
 },
 'materials-orphan'=>function(PDO $pdo,array $p,array $c):string{
  $id='gone-'.Domain::id();$dir=fixture_materials_dir($c,$id);if(!is_dir($dir))mkdir($dir,0700,true);
  file_put_contents("$dir/".str_repeat('2',32).'.pdf','z');$t=time()-2*86400;touch("$dir/".str_repeat('2',32).'.pdf',$t);touch($dir,$t);
  return basename($dir);
 },
 'materials-sweep'=>function(PDO $pdo,array $p,array $c):array{
  [$files,$dirs,$next]=Materials::sweep($pdo,$c,time(),(int)($p['budget']??5000),isset($p['after'])?(string)$p['after']:null);
  return ['files'=>$files,'dirs'=>$dirs,'next'=>$next];
 },
 'materials-exists'=>function(PDO $pdo,array $p,array $c):bool{$d=(string)($p['dir']??'');if(!preg_match('/^[0-9a-f]{32}$/D',$d))throw new RuntimeException('materials-exists');clearstatcache();return is_dir(Materials::root($c).'/'.substr($d,0,2).'/'.$d);},
];
