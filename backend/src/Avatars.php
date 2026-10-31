<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Profile photos (plan §7.5, §4.3, §10). The browser crops to 256×256 and sends WebP or JPEG; the server never trusts it:
 *  1. off (avatars_enabled=false or Capabilities::avatarMode()==='off') → 503 before anything else;
 *  2. at most 524288 bytes (Routes reads max+1);
 *  3. format by content (getimagesizefromstring): JPEG, PNG or WebP only, never SVG or GIF; 64–2048 px per side, at most
 *     4.2 million pixels, and refused when w·h·5 bytes exceed half of memory_limit (-1 = only the pixel limit);
 *  4. GD decodes, applies the EXIF orientation (ext-exif), crops the centre square and writes 256 and 64 px as WebP (82)
 *     or JPEG (85): re-encoding drops EXIF, GPS and anything appended to the file;
 *  5. the name is the first 32 hex characters of SHA-256 of the 256 px file; the directory contains the owner's
 *     public_id: <uploads>/avatars/<first 2 characters>/<public_id>/<hash>-256.webp (and -64), so two people with the
 *     same picture never share a file; directories 0700, files 0600, written to a temporary name and renamed;
 *  6. user_profiles.avatar is updated first, then the previous files are deleted from the same person's directory.
 * v = the first 12 characters of the name; the avatar route serves only to viewers with full access or the owner, in the
 * order of §4.3 (access → target and v → If-None-Match → file). No path ever comes from the request: the directory
 * is built from the public_id stored in the database and the file name from the stored avatar value, both checked
 * against strict patterns.
 */
final class Avatars {
 public const MAX_BYTES=524288,MIN_SIDE=64,MAX_SIDE=2048,MAX_PIXELS=4200000,SIZES=[256,64];
 /** Whether photos can be accepted on this server now. */
 public static function enabled(array $c):bool{return !empty($c['avatars_enabled'])&&Capabilities::avatarMode($c)!=='off';}
 /** The route's own answer for 413/415 before the body is read (§4.3): 503 first while photos are off. */
 public static function reject(array $c,int $status):never {
  if(!self::enabled($c))throw new AppError('Zdjęcia profilowe są chwilowo wyłączone.',503);
  if($status===413)throw new AppError('Plik jest za duży.',413);
  throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
 }
 /** <uploads>/avatars/xx/<public_id>, or null for a malformed public_id. */
 public static function dir(array $c,string $publicId):?string {
  if(!preg_match('/^[A-Za-z0-9]{12}$/D',$publicId))return null;
  return Paths::uploads($c).'/avatars/'.substr($publicId,0,2).'/'.$publicId;
 }
 /** [hash, extension] of a stored avatar value '<32 hex>.webp|jpg', or null. */
 public static function parse(?string $value):?array{return is_string($value)&&preg_match('/^([0-9a-f]{32})\.(webp|jpg)$/D',$value,$m)?[$m[1],$m[2]]:null;}
 /** Decodes, checks and re-encodes $raw; returns ['ext'=>'webp'|'jpg', 256=>bytes, 64=>bytes]. */
 public static function process(array $c,string $raw):array {
  if(!self::enabled($c))throw new AppError('Zdjęcia profilowe są chwilowo wyłączone.',503);
  if(strlen($raw)>self::MAX_BYTES)throw new AppError('Plik jest za duży.',413);
  $info=$raw===''?false:@getimagesizefromstring($raw);
  if(!$info||!in_array($info[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG,IMAGETYPE_WEBP],true)||!in_array($info[2],Capabilities::readable(),true))throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
  [$w,$h]=[(int)$info[0],(int)$info[1]];$mem=Capabilities::memoryLimit();
  if($w<self::MIN_SIDE||$h<self::MIN_SIDE||$w>self::MAX_SIDE||$h>self::MAX_SIDE||$w*$h>self::MAX_PIXELS||($mem>0&&$w*$h*5>intdiv($mem,2)))throw new AppError('Zdjęcie ma niepoprawne wymiary.');
  $src=@imagecreatefromstring($raw);if(!$src)throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
  try{
   if($info[2]===IMAGETYPE_JPEG)$src=self::orient($src,$raw);
   $w=imagesx($src);$h=imagesy($src);$side=min($w,$h);$x=intdiv($w-$side,2);$y=intdiv($h-$side,2);
   $webp=Capabilities::avatarMode($c)==='gd-webp';$out=['ext'=>$webp?'webp':'jpg'];
   foreach(self::SIZES as $size){
    $dst=imagecreatetruecolor($size,$size);
    try{
     imagefill($dst,0,0,(int)imagecolorallocate($dst,255,255,255));imagecopyresampled($dst,$src,0,0,$x,$y,$size,$size,$side,$side);
     ob_start();$ok=$webp?imagewebp($dst,null,82):imagejpeg($dst,null,85);$bytes=(string)ob_get_clean();
     if(!$ok||$bytes==='')throw new \RuntimeException('Cannot encode the avatar.');
     $out[$size]=$bytes;
    }finally{imagedestroy($dst);}
   }
   return $out;
  }finally{imagedestroy($src);}
 }
 /** Applies the EXIF orientation of a JPEG (1–8) when ext-exif is present; metadata itself is never kept. */
 private static function orient(\GdImage $img,string $raw):\GdImage {
  if(!function_exists('exif_read_data'))return $img;
  $exif=@exif_read_data('data://image/jpeg;base64,'.base64_encode($raw));$o=is_array($exif)?(int)($exif['Orientation']??1):1;
  if($o<2||$o>8)return $img;
  if(in_array($o,[2,4,5,7],true))imageflip($img,$o===4?IMG_FLIP_VERTICAL:IMG_FLIP_HORIZONTAL);
  $angle=match($o){3,4=>180,5,6=>270,7,8=>90,default=>0};
  if($angle){$r=imagerotate($img,$angle,0);if($r){imagedestroy($img);return $r;}}
  return $img;
 }
 /**
  * avatar-upload (§4.3): 10 per hour, then process(), atomic write into the owner's directory, the profile row, and the
  * old files removed. Returns {avatar: v}.
  */
 public static function upload(PDO $pdo,array $c,array $u,string $raw):array {
  if(!self::enabled($c))throw new AppError('Zdjęcia profilowe są chwilowo wyłączone.',503);
  Members::limit($pdo,$c,'avatar-upload',$u['id'],10,3600);
  $img=self::process($c,$raw);$p=Accounts::profile($pdo,$u['id']);$dir=self::dir($c,(string)$p['public_id']);
  if($dir===null)throw new \RuntimeException('Invalid public id.');
  $hash=substr(hash('sha256',$img[256]),0,32);$name=$hash.'.'.$img['ext'];
  self::mkdir($dir);
  foreach(self::SIZES as $size)self::write($dir.'/'.$hash.'-'.$size.'.'.$img['ext'],$img[$size]);
  $pdo->prepare('UPDATE user_profiles SET avatar=?,updated_at=? WHERE user_id=?')->execute([$name,time(),$u['id']]);
  if($p['avatar']!==$name)self::removeFiles($dir,$p['avatar']);
  return ['avatar'=>substr($hash,0,12)];
 }
 /** avatar-delete: 30 per hour; the profile loses its photo, then the files go. */
 public static function delete(PDO $pdo,array $c,array $u):array {
  Members::limit($pdo,$c,'avatar-delete',$u['id'],30,3600);
  $p=Accounts::profile($pdo,$u['id']);
  $pdo->prepare('UPDATE user_profiles SET avatar=NULL,updated_at=? WHERE user_id=?')->execute([time(),$u['id']]);
  $dir=self::dir($c,(string)$p['public_id']);if($dir!==null)self::removeFiles($dir,$p['avatar']);
  return ['avatar'=>null];
 }
 /**
  * The avatar route (GET ?id=<public_id>&v=<12 hex>&s=64|256), checks in the order of §4.3: (1) a viewer with full
  * access or the owner, (2) the target by public_id: active account whose avatar starts with v, (3) If-None-Match → 304,
  * (4) the file with its own headers. Every refusal is the same 404, so a stale URL, a guest and a missing photo look alike.
  */
 public static function serve(RouteContext $ctx):never {
  $missing=fn()=>throw new AppError('Nie znaleziono zdjęcia.',404);
  $id=(string)$ctx->query('id');$v=(string)$ctx->query('v');$s=(string)$ctx->query('s');
  $viewer=$ctx->user();if(!$viewer)$missing();
  if(!preg_match('/^[A-Za-z0-9]{12}$/D',$id)||!preg_match('/^[0-9a-f]{12}$/D',$v)||!in_array($s,['64','256'],true))$missing();
  $pdo=$ctx->pdo();
  if(!$ctx->access()['full']){
   $q=$pdo->prepare('SELECT public_id FROM user_profiles WHERE user_id=?');$q->execute([$viewer['id']]);$own=$q->fetchColumn();$q->closeCursor();
   if(!is_string($own)||!hash_equals($own,$id))$missing();
  }
  $q=$pdo->prepare('SELECT p.avatar FROM user_profiles p JOIN users u ON u.id=p.user_id WHERE p.public_id=? AND u.active=1');$q->execute([$id]);$avatar=$q->fetchColumn();$q->closeCursor();
  $file=self::parse(is_string($avatar)?$avatar:null);if(!$file||!str_starts_with($file[0],$v))$missing();
  $etag='"'.$v.'-'.$s.'"';
  $headers=['Cache-Control: private, max-age=31536000, immutable','ETag: '.$etag,'X-Content-Type-Options: nosniff'];
  $match=array_map('trim',explode(',',(string)($_SERVER['HTTP_IF_NONE_MATCH']??'')));
  if(in_array($etag,$match,true)||in_array('W/'.$etag,$match,true)){
   header_remove('Content-Type');foreach($headers as $line)header($line);http_response_code(304);exit;
  }
  $path=self::dir($ctx->config,$id).'/'.$file[0].'-'.$s.'.'.$file[1];
  $bytes=is_file($path)?@file_get_contents($path):false;if(!is_string($bytes))$missing();
  foreach([...$headers,'Content-Type: '.($file[1]==='webp'?'image/webp':'image/jpeg'),"Content-Security-Policy: default-src 'none'; sandbox",'Cross-Origin-Resource-Policy: same-origin','Content-Length: '.strlen($bytes)] as $line)header($line);
  http_response_code(200);echo $bytes;exit;
 }
 /** Creates $dir and missing parents below the uploads directory with mode 0700 (umask does not apply). */
 public static function mkdir(string $dir):void {
  if(is_dir($dir))return;
  $parent=dirname($dir);if(!is_dir($parent))self::mkdir($parent);
  if(!@mkdir($dir,0700)&&!is_dir($dir))throw new \RuntimeException('Cannot create the avatar directory.');
  @chmod($dir,0700);
 }
 /** Atomic write with mode 0600: a temporary name in the same directory, then rename. */
 private static function write(string $path,string $bytes):void {
  $tmp=dirname($path).'/.tmp-'.bin2hex(random_bytes(8));
  try{
   if(@file_put_contents($tmp,$bytes,LOCK_EX)!==strlen($bytes)||!@chmod($tmp,0600)||!@rename($tmp,$path))throw new \RuntimeException('Cannot store the avatar.');
  }finally{if(is_file($tmp))@unlink($tmp);}
 }
 /** Deletes the files of a stored avatar value from one person's directory. */
 public static function removeFiles(string $dir,?string $value):void {
  $f=self::parse($value);if(!$f)return;
  foreach(self::SIZES as $size)@unlink($dir.'/'.$f[0].'-'.$size.'.'.$f[1]);
 }
 /** Deletes a person's whole avatar directory (account deletion, cleanup); only plain files inside are removed. */
 public static function removeOwner(array $c,?string $publicId):void {
  $dir=is_string($publicId)?self::dir($c,$publicId):null;if($dir===null||!is_dir($dir)||is_link($dir))return;
  foreach(scandir($dir)?:[] as $f)if($f!=='.'&&$f!=='..'&&is_file("$dir/$f")&&!is_link("$dir/$f"))@unlink("$dir/$f");
  @rmdir($dir);@rmdir(dirname($dir));
 }
 /**
  * Cleanup for the accounts-cleanup job (§7.5): in each person's directory, files that are not the current avatar and
  * are older than one day; directories whose public_id no longer has a profile row (and is older than one day).
  * At most $budget directory entries and about 2 seconds per run. Returns [files removed, directories removed].
  */
 public static function sweep(PDO $pdo,array $c,int $now,int $budget=5000):array {
  $root=Paths::uploads($c).'/avatars';if(!is_dir($root)||is_link($root))return [0,0];
  $start=microtime(true);$seen=0;$files=0;$dirs=0;$day=86400;
  foreach(scandir($root)?:[] as $prefix){
   if(!preg_match('/^[A-Za-z0-9]{2}$/D',$prefix)||!is_dir("$root/$prefix")||is_link("$root/$prefix"))continue;
   $owners=array_values(array_filter(scandir("$root/$prefix")?:[],fn($d)=>preg_match('/^[A-Za-z0-9]{12}$/D',$d)&&str_starts_with($d,$prefix)));
   if(!$owners){if(filemtime("$root/$prefix")<$now-$day)@rmdir("$root/$prefix");continue;}
   $current=[];
   foreach(array_chunk($owners,200) as $chunk){
    $q=$pdo->prepare('SELECT public_id,avatar FROM user_profiles WHERE public_id IN ('.implode(',',array_fill(0,count($chunk),'?')).')');$q->execute($chunk);
    foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$current[$r['public_id']]=(string)$r['avatar'];
   }
   foreach($owners as $pid){
    if(++$seen>$budget||microtime(true)-$start>2)return [$files,$dirs];
    $dir="$root/$prefix/$pid";if(!is_dir($dir)||is_link($dir))continue;
    if(!array_key_exists($pid,$current)){if(filemtime($dir)<$now-$day){self::removeOwner($c,$pid);$dirs++;}continue;}
    $keep=self::parse($current[$pid]);
    foreach(scandir($dir)?:[] as $f){
     if($f==='.'||$f==='..'||!is_file("$dir/$f"))continue;
     if($keep&&str_starts_with($f,$keep[0].'-'))continue;
     if(filemtime("$dir/$f")<$now-$day&&@unlink("$dir/$f"))$files++;
    }
   }
  }
  return [$files,$dirs];
 }
}
