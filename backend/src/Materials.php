<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Tournament materials (PLAN-MATERIALY §2, §4): a poster (image) and the rules (a PDF or a typed text) of one tournament,
 * pattern of Avatars. Stored meta (tournaments.materials, migration 0009; Domain and dist/workspace.js call it materials):
 *   poster {f:"<32 hex>.webp|jpg", w, h (the lg image), c:"#rrggbb" (average colour), at}
 *   rules  {f:"<32 hex>.pdf", b (bytes), at} (PDF) or {t:"<text>", at} (text, a fixed point of text(), 1–TEXT_MAX characters)
 * every key optional, none = no materials (NULL); one rules item, saving one kind of rules replaces the other. meta() is the
 * one strict check (Domain::execute of tournament.material, the views, the file route, the sweep); view() is the sparse outside
 * shape poster {v, w, h, color} / rules {v, size, type:'pdf'|'text'} (v = 12 hex of SHA-256 of the file or the text, size =
 * bytes of the PDF or characters of the text); f and the text never leave through the views (the material route serves them).
 * dist/workspace.js mirrors meta(), view() and text() (materialMeta, materialsView, rulesText; the demo also takes src instead
 * of f and adds src, and the text, to the view).
 * Poster (process): format by content (getimagesizefromstring: JPEG, PNG or WebP that GD reads, never SVG or GIF), 200–4096 px
 * per side, at most 12 Mpx, refused when the decoded source (twice when the EXIF orientation needs imagerotate) and both outputs
 * at 5 bytes per pixel need more than half of memory_limit (-1: only the pixel limit); EXIF orientation applied, transparency
 * on white, re-encoded (WebP 80, else JPEG 85: Capabilities::avatarMode), which drops EXIF, GPS and appended bytes. lg: longer
 * side at most 2000 px, sm: inside 480×720, never enlarged, never cropped; the name is 32 hex of SHA-256 of the lg file.
 * Rules PDF (pdf): '%PDF-' in the first 1024 bytes and '%%EOF' in the last 2048, at most rulesMax(); stored as sent, named by
 * SHA-256 of the bytes. Rules text (text): Text::clean's steps for multiline text without its line limit. Files:
 * <uploads>/materials/<h[0..1]>/<h>/<hash>-lg.<ext>, <hash>-sm.<ext>, <hash>.pdf, where h = 32 hex of SHA-256 of the tournament
 * id: no path ever comes from the request; directories 0700, files 0600, written to a temporary name and renamed. Limits:
 * posterMax() = min(4 MB, post_max_size − 64 KB), rulesMax() = min(10 MB, post_max_size − 64 KB) (post_max_size 0 or -1: no
 * server bound); limits() is me.features.materials (0 while the kind cannot be stored here).
 * Writes (upload, saveText, delete; routes/materials.php): one Repository::transaction with Domain::execute of
 * tournament.material at the current revision (the command route refuses that type: only these routes set it, from what the
 * server checked itself). A member organizer as in the command route: caps.organizer (again under the lock), Auth::stepUp, full
 * access (402) and the member budget (MemberTx) for uploads and texts; staff without full access 402 for them. Removal never
 * needs full access and never waits for the budget (the own data rule R12: a poster may show people). Before any file work a
 * key lookup refuses whoever does not manage the tournament (members: 404 'Turniej nie jest dostępny.', staff: 403/404 as
 * tournament.save); Domain decides again under the lock. Files are written before the transaction (a failed one leaves files
 * the sweep removes), the files of the previous value (a PDF replaced by a PDF or a text) after the commit, unless a newer
 * commit refers to them again. The Administrator's writes on a member's tournament go to account_audit (action
 * tournament.material, note "<kind> set|removed <id> · <name>").
 * serve(): every refusal is the same 404 ('Turniej nie jest dostępny.'), checked in this order: parameters (t, k, v, s for
 * the poster only), the tournament and the stored item with v, then the reader: public (not a draft, not hidden, a member
 * creator neither blocked as organizer nor deactivated) or a viewer who manages it; If-None-Match → 304; then the file or text.
 * sweep() runs in the accounts-cleanup job like Avatars::sweep.
 */
final class Materials {
 public const KINDS=['poster','rules'];
 public const POSTER_MAX=4194304,RULES_MAX=10485760,POST_MARGIN=65536,TEXT_MAX=20000;
 public const MIN_SIDE=200,MAX_SIDE=4096,MAX_PIXELS=12000000,LG=2000,SM_W=480,SM_H=720,MAX_AT=9999999999;
 /** Tournament ids (the shape of every route's ids). */
 public const ID='/^[A-Za-z0-9_-]{1,40}$/D';

 // Limits and switches.
 /** Bytes of a request body this PHP accepts: post_max_size − 64 KB; post_max_size 0 or -1 (no limit) → PHP_INT_MAX. */
 public static function bodyLimit():int{$p=Capabilities::bytes((string)ini_get('post_max_size'));return $p<=0?PHP_INT_MAX:$p-self::POST_MARGIN;}
 /** Largest poster upload in bytes ($c: the configuration of the call, the limit itself depends on this PHP only). */
 public static function posterMax(array $c=[]):int{return max(0,min(self::POSTER_MAX,self::bodyLimit()));}
 /** Largest rules document in bytes. */
 public static function rulesMax(array $c=[]):int{return max(0,min(self::RULES_MAX,self::bodyLimit()));}
 /** Whether files can be stored: <uploads>/materials (or, before the first file, the uploads directory) is a writable directory. */
 public static function writable(array $c):bool {
  try{$up=Paths::uploads($c);}catch(\RuntimeException){return false;}
  $dir=$up.'/materials';return is_dir($dir)?!is_link($dir)&&is_writable($dir):is_dir($up)&&is_writable($up);
 }
 /** Posters need GD (Capabilities::avatarMode, independent of the profile photo switch) and a writable directory. */
 public static function posterOn(array $c):bool{return Capabilities::avatarMode($c)!=='off'&&self::writable($c);}
 /** me.features.materials: {poster, rules} in bytes, 0 while that kind cannot be stored on this server (a rules text needs no file). */
 public static function limits(array $c):array{return ['poster'=>self::posterOn($c)?self::posterMax($c):0,'rules'=>self::writable($c)?self::rulesMax($c):0];}
 /**
  * The answer of an upload route for 413/415 before the body is read (Routes::raw, no context yet): 503 first while that
  * kind cannot be stored. $c defaults to config.php: only uploads_dir is read, never a switch of the effective configuration.
  */
 public static function reject(string $kind,int $status,?array $c=null):never {
  $c??=\matdraw_config();
  if($kind==='poster'?!self::posterOn($c):!self::writable($c))throw new AppError('Funkcje społecznościowe są chwilowo niedostępne.',503);
  if($status===413)throw new AppError('Plik jest za duży.',413);
  if($kind==='poster')throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
  throw new AppError('Nieobsługiwany format danych.',415);
 }

 // Stored meta and its views (mirrored by dist/workspace.js).
 /** The stored meta of $kind when $v is exactly valid (keys, types, ranges, patterns), with its keys in order; else null. */
 public static function meta(string $kind,mixed $v):?array {
  if(!is_array($v))return null;$keys=array_map('strval',array_keys($v));sort($keys,SORT_STRING);
  $int=static fn(mixed $x,int $min,int $max):bool=>is_int($x)&&$x>=$min&&$x<=$max;
  if($kind==='poster')return $keys===['at','c','f','h','w']&&is_string($v['f'])&&preg_match('/^[0-9a-f]{32}\.(?:webp|jpg)$/D',$v['f'])&&$int($v['w'],1,self::MAX_SIDE)&&$int($v['h'],1,self::MAX_SIDE)
   &&is_string($v['c'])&&preg_match('/^#[0-9a-f]{6}$/D',$v['c'])&&$int($v['at'],0,self::MAX_AT)?['f'=>$v['f'],'w'=>$v['w'],'h'=>$v['h'],'c'=>$v['c'],'at'=>$v['at']]:null;
  if($kind!=='rules')return null;
  if($keys===['at','b','f'])return is_string($v['f'])&&preg_match('/^[0-9a-f]{32}\.pdf$/D',$v['f'])&&$int($v['b'],1,self::RULES_MAX)&&$int($v['at'],0,self::MAX_AT)?['f'=>$v['f'],'b'=>$v['b'],'at'=>$v['at']]:null;
  return $keys===['at','t']&&is_string($v['t'])&&self::text($v['t'])===$v['t']&&self::chars($v['t'])>=1&&self::chars($v['t'])<=self::TEXT_MAX&&$int($v['at'],0,self::MAX_AT)?['t'=>$v['t'],'at'=>$v['at']]:null;
 }
 /** Characters (code points) of a UTF-8 string. */
 private static function chars(string $s):int{return mb_strlen($s,'UTF-8');}
 /** Sparse outside fields of a tournament's materials: poster {v, w, h, color} and rules {v, size, type}, only for valid meta. */
 public static function view(mixed $m):array {
  if(!is_array($m))return [];$out=[];
  if($p=self::meta('poster',$m['poster']??null))$out['poster']=['v'=>substr($p['f'],0,12),'w'=>$p['w'],'h'=>$p['h'],'color'=>$p['c']];
  if($r=self::meta('rules',$m['rules']??null))$out['rules']=isset($r['f'])?['v'=>substr($r['f'],0,12),'size'=>$r['b'],'type'=>'pdf']:['v'=>substr(hash('sha256',$r['t']),0,12),'size'=>self::chars($r['t']),'type'=>'text'];
  return $out;
 }
 /**
  * A rules text as stored: Text::clean's steps for multiline text without its line limit, ordered so that the result is a
  * fixed point (meta() checks text(t) === t): not a string or not UTF-8 → null; "\r\n" and "\r" → "\n", "\t" → " ", every
  * \p{Cc} but "\n" and every \p{Cf} but U+200D removed, then NFC (ext-intl), lines holding only white space become empty,
  * runs of more than 2 empty lines shrink to 2, white space trimmed at both ends ([\s\p{Z}], Text::trim). May give ''.
  */
 public static function text(mixed $raw):?string {
  if(!is_string($raw)||!mb_check_encoding($raw,'UTF-8'))return null;
  $s=str_replace(["\r\n","\r","\t"],["\n","\n",' '],$raw);
  $s=(string)preg_replace(['/(?!\n)\p{Cc}/u','/(?!\x{200D})\p{Cf}/u'],'',$s);
  if(class_exists(\Normalizer::class)){$n=\Normalizer::normalize($s,\Normalizer::FORM_C);if(is_string($n))$s=$n;}
  $lines=[];$empty=0;
  foreach(explode("\n",$s) as $line){if(Text::trim($line)===''){if(++$empty>Text::MAX_EMPTY_RUN)continue;$lines[]='';}else{$empty=0;$lines[]=$line;}}
  return Text::trim(implode("\n",$lines));
 }
 /** The tournaments.materials column as an array, or null (NULL, empty or unreadable). */
 public static function decode(mixed $v):?array {
  if(!is_string($v)||$v==='')return null;
  try{$m=json_decode($v,true,8,JSON_THROW_ON_ERROR);}catch(\JsonException){return null;}
  return is_array($m)&&$m!==[]?$m:null;
 }
 /** File names of a stored value of $kind: poster [<hash>-lg.<ext>, <hash>-sm.<ext>], rules PDF [<hash>.pdf]; [] for a text or invalid meta. */
 public static function files(string $kind,mixed $meta):array{$m=self::meta($kind,$meta);return isset($m['f'])?self::names($kind,$m['f']):[];}
 /** File names of the stored file value $f ('<32 hex>.<ext>') of $kind; [] for another shape. */
 private static function names(string $kind,string $f):array {
  if(!preg_match($kind==='poster'?'/^([0-9a-f]{32})\.(webp|jpg)$/D':'/^([0-9a-f]{32})\.pdf$/D',$f,$m))return [];
  return $kind==='poster'?["$m[1]-lg.$m[2]","$m[1]-sm.$m[2]"]:["$m[1].pdf"];
 }

 // Files.
 /** 32 hex of SHA-256 of a tournament id: its directory name. */
 public static function hash(string $id):string{return substr(hash('sha256',$id),0,32);}
 /** <uploads>/materials (RuntimeException for an uploads directory inside the docroot, Paths::uploads). */
 public static function root(array $c):string{return Paths::uploads($c).'/materials';}
 /** <uploads>/materials/<h[0..1]>/<h> of tournament $id, or null for an id of another shape. */
 public static function dir(array $c,string $id):?string{if(!preg_match(self::ID,$id))return null;$h=self::hash($id);return self::root($c).'/'.substr($h,0,2).'/'.$h;}
 /** Creates $dir and missing parents with mode 0700 (umask does not apply). */
 private static function mkdir(string $dir):void {
  if(is_dir($dir))return;
  $parent=dirname($dir);if(!is_dir($parent))self::mkdir($parent);
  if(!@mkdir($dir,0700)&&!is_dir($dir))throw new \RuntimeException('Cannot create the materials directory.');
  @chmod($dir,0700);
 }
 /** Atomic write with mode 0600: a temporary name in the same directory, then rename. */
 private static function write(string $path,string $bytes):void {
  $tmp=dirname($path).'/.tmp-'.bin2hex(random_bytes(8));
  try{
   if(@file_put_contents($tmp,$bytes,LOCK_EX)!==strlen($bytes)||!@chmod($tmp,0600)||!@rename($tmp,$path))throw new \RuntimeException('Cannot store the material.');
  }finally{if(is_file($tmp))@unlink($tmp);}
 }
 /** Deletes the files of the stored file value $f of $kind from one tournament's directory. */
 private static function removeFiles(string $dir,string $kind,string $f):void{foreach(self::names($kind,$f) as $name)if(is_file("$dir/$name")&&!is_link("$dir/$name"))@unlink("$dir/$name");}
 /** Deletes one tournament directory (plain files only), then its prefix directory when empty; returns the files removed. */
 private static function removeDir(string $dir):int {
  $n=0;if(!is_dir($dir)||is_link($dir))return 0;
  foreach(scandir($dir)?:[] as $f)if($f!=='.'&&$f!=='..'&&is_file("$dir/$f")&&!is_link("$dir/$f")&&@unlink("$dir/$f"))$n++;
  @rmdir($dir);@rmdir(dirname($dir));return $n;
 }

 // Processing.
 /** Poster: checks and re-encodes $raw; returns ['meta'=>{f,w,h,c,at}, 'files'=>[name=>bytes]] (lg and sm). */
 public static function process(array $c,string $raw):array {
  if(!self::posterOn($c))throw new AppError('Funkcje społecznościowe są chwilowo niedostępne.',503);
  if(strlen($raw)>self::posterMax($c))throw new AppError('Plik jest za duży.',413);
  $info=$raw===''?false:@getimagesizefromstring($raw);
  if(!$info||!in_array($info[2],[IMAGETYPE_JPEG,IMAGETYPE_PNG,IMAGETYPE_WEBP],true)||!in_array($info[2],Capabilities::readable(),true))throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
  [$w,$h]=[(int)$info[0],(int)$info[1]];
  if($w<self::MIN_SIDE||$h<self::MIN_SIDE||$w>self::MAX_SIDE||$h>self::MAX_SIDE||$w*$h>self::MAX_PIXELS)throw new AppError('Zdjęcie ma niepoprawne wymiary.');
  $o=$info[2]===IMAGETYPE_JPEG?Avatars::orientation($raw):1;[$uw,$uh]=$o>=5?[$h,$w]:[$w,$h];
  [$lw,$lh]=self::fit($uw,$uh,self::LG,self::LG);[$sw,$sh]=self::fit($uw,$uh,self::SM_W,self::SM_H);
  $mem=Capabilities::memoryLimit();$need=$w*$h*5*(Avatars::rotates($o)?2:1)+($lw*$lh+$sw*$sh)*5;
  if($mem>0&&$need>intdiv($mem,2))throw new AppError('Zdjęcie ma niepoprawne wymiary.');
  $src=@imagecreatefromstring($raw);if(!$src)throw new AppError('To nie jest obraz JPG, PNG ani WebP.',415);
  $webp=Capabilities::avatarMode($c)==='gd-webp';$ext=$webp?'webp':'jpg';
  try{
   $src=Avatars::rotate($src,$o);
   $img=self::scaled($src,$lw,$lh);try{$lg=self::encode($img,$webp);}finally{imagedestroy($img);}
   $img=self::scaled($src,$sw,$sh);try{$sm=self::encode($img,$webp);$color=self::average($img);}finally{imagedestroy($img);}
  }finally{imagedestroy($src);}
  $hash=substr(hash('sha256',$lg),0,32);
  return ['meta'=>['f'=>$hash.'.'.$ext,'w'=>$lw,'h'=>$lh,'c'=>$color,'at'=>time()],'files'=>["$hash-lg.$ext"=>$lg,"$hash-sm.$ext"=>$sm]];
 }
 /** [w, h] of a $w×$h image fitted inside $maxW×$maxH, never enlarged, at least 1 px. */
 public static function fit(int $w,int $h,int $maxW,int $maxH):array{$s=min(1,$maxW/$w,$maxH/$h);return [max(1,(int)round($w*$s)),max(1,(int)round($h*$s))];}
 /** $src scaled to $dw×$dh on white (transparent parts become white). */
 private static function scaled(\GdImage $src,int $dw,int $dh):\GdImage {
  $dst=imagecreatetruecolor($dw,$dh);imagefill($dst,0,0,(int)imagecolorallocate($dst,255,255,255));
  imagecopyresampled($dst,$src,0,0,0,0,$dw,$dh,imagesx($src),imagesy($src));return $dst;
 }
 /** WebP 80 or JPEG 85 bytes of $img. */
 private static function encode(\GdImage $img,bool $webp):string {
  ob_start();$ok=$webp?imagewebp($img,null,80):imagejpeg($img,null,85);$bytes=(string)ob_get_clean();
  if(!$ok||$bytes==='')throw new \RuntimeException('Cannot encode the poster.');
  return $bytes;
 }
 /** The average colour of $img as '#rrggbb' (the image resampled to one pixel). */
 private static function average(\GdImage $img):string {
  $one=imagecreatetruecolor(1,1);
  try{imagecopyresampled($one,$img,0,0,0,0,1,1,imagesx($img),imagesy($img));$rgb=imagecolorat($one,0,0);}finally{imagedestroy($one);}
  return sprintf('#%02x%02x%02x',($rgb>>16)&255,($rgb>>8)&255,$rgb&255);
 }
 /** Rules PDF: checks it by content and size; returns ['meta'=>{f,b,at}, 'files'=>[name=>bytes]] (the bytes as sent). */
 public static function pdf(array $c,string $raw):array {
  if(!self::writable($c))throw new AppError('Funkcje społecznościowe są chwilowo niedostępne.',503);
  $n=strlen($raw);if($n>self::rulesMax($c))throw new AppError('Plik jest za duży.',413);
  if($n===0||!str_contains(substr($raw,0,1024),'%PDF-')||!str_contains(substr($raw,-2048),'%%EOF'))throw new AppError('Nieobsługiwany format danych.',415);
  $hash=substr(hash('sha256',$raw),0,32);
  return ['meta'=>['f'=>$hash.'.pdf','b'=>$n,'at'=>time()],'files'=>["$hash.pdf"=>$raw]];
 }
 /** Rules text: the stored meta {t, at} of a typed text (text()), 422 when nothing is left, 413 above TEXT_MAX characters. */
 public static function textMeta(mixed $raw):array {
  $t=self::text($raw);if($t===null||$t==='')throw new AppError('Wpisz treść regulaminu albo usuń regulamin.');
  if(self::chars($t)>self::TEXT_MAX)throw new AppError('Żądanie jest zbyt duże.',413);
  return ['t'=>$t,'at'=>time()];
 }

 // Routes.
 private static function tournamentId(mixed $id):string{if(!is_string($id)||!preg_match(self::ID,$id))throw new AppError('Turniej nie jest dostępny.',404);return $id;}
 /**
  * Who writes (before any file work): a member organizer (caps, step-up, full access when $paid) or staff (full access when
  * $paid), and a key lookup of the tournament's creator: members who do not manage it get 404 (never more about it), staff
  * 404 for a missing tournament and 403 for another's, as tournament.save. Returns the member actor (Actors::of) or null.
  */
 private static function writer(RouteContext $ctx,string $id,bool $paid):?array {
  $pdo=$ctx->pdo();$c=$ctx->config;$u=$ctx->user();$member=$u['role']==='member';$actor=$u;
  if($member){$actor=Actors::of($pdo,$u);if(!$actor['caps']['organizer'])throw new AppError('Brak uprawnień.',403);Auth::stepUp($c);}
  if($paid&&!Access::of($pdo,$u,$c)['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
  $q=$pdo->prepare('SELECT created_by FROM tournaments WHERE id=?');$q->execute([$id]);$by=$q->fetchColumn();$q->closeCursor();
  if($by===false)throw $member?new AppError('Turniej nie jest dostępny.',404):new AppError('Turniej nie istnieje.',404);
  if(!Domain::manages($actor,['createdBy'=>$by]))throw $member?new AppError('Turniej nie jest dostępny.',404):new AppError('Możesz edytować tylko własne turnieje.',403);
  return $member?$actor:null;
 }
 /**
  * tournament.material in one workspace transaction (the member actor again under the lock, as the command route); returns
  * {workspace (as the command route), view (the outside fields of the kind or null), previous (the replaced file or null)}.
  */
 private static function commit(RouteContext $ctx,?array $actor,string $id,string $kind,?array $meta):array {
  $pdo=$ctx->pdo();$c=$ctx->config;$u=$ctx->user();$budget=$actor!==null&&$meta!==null;
  if($budget)MemberTx::check($pdo,$c,$u['id']);
  $out=(new Repository($pdo))->transaction(function(array &$db)use($pdo,$u,$actor,$id,$kind,$meta){
   if($actor!==null){$now=Actors::of($pdo,$u);if(!$now['caps']['organizer'])throw new AppError('Brak uprawnień.',403);}
   $had=false;foreach($db['tournaments'] as $x)if($x['id']===$id)$had=isset($x['materials'][$kind]);
   $result=Domain::execute($db,$u['id'],'tournament.material',['id'=>$id,'kind'=>$kind,'value'=>$meta],(int)$db['revision']);
   $t=null;foreach($db['tournaments'] as $x)if($x['id']===$id)$t=$x;
   if($actor!==null)$ws=array_replace(Domain::publicData($db,$now),['user'=>Accounts::withCaps($u,$now)]);
   else{
    $me=Domain::entity($db['users'],$u['id'],'Konto');$ws=Domain::publicData($db,$me);
    // The Administrator on a member's tournament (abuse): account_audit, inside the transaction, as index.php admin_audit; a removal of nothing is no event.
    if($me['role']==='admin'&&($meta!==null||$had)&&is_string($t['createdBy']??null)&&!isset(Domain::staffIds($db)[$t['createdBy']]))
     Members::audit($pdo,$me['id'],'tournament.material',$t['createdBy'],mb_substr($kind.' '.($meta===null?'removed':'set').' '.$id.' · '.$t['name'],0,200));
   }
   return ['workspace'=>$ws,'view'=>self::view($t['materials']??null)[$kind]??null,'previous'=>$result['previous']];
  },$actor,Settings::flags($c));
  if($budget)MemberTx::count($pdo,$c);
  if($out['previous']!==null)self::cleanup($pdo,$c,$id,$kind,$out['previous']);
  return $out;
 }
 /** After a commit: the files of the replaced value $previous go, unless a newer commit refers to that file again. */
 private static function cleanup(PDO $pdo,array $c,string $id,string $kind,string $previous):void {
  $q=$pdo->prepare('SELECT materials FROM tournaments WHERE id=?');$q->execute([$id]);$now=self::decode($q->fetchColumn());$q->closeCursor();
  if((self::meta($kind,$now[$kind]??null)['f']??null)===$previous)return;
  $dir=self::dir($c,$id);if($dir!==null)self::removeFiles($dir,$kind,$previous);
 }
 /** poster-upload, rules-upload (?t=<id>, raw bytes): 30 per hour per account (with rules-text). Returns {workspace, result:{<kind>: view}}. */
 public static function upload(RouteContext $ctx,string $kind):array {
  $c=$ctx->config;$pdo=$ctx->pdo();$u=$ctx->user();
  if($kind==='poster'?!self::posterOn($c):!self::writable($c))throw new AppError('Funkcje społecznościowe są chwilowo niedostępne.',503);
  $id=self::tournamentId($ctx->query('t'));
  Members::limit($pdo,$c,'material-upload',$u['id'],30,3600);
  $actor=self::writer($ctx,$id,true);
  $file=$kind==='poster'?self::process($c,$ctx->raw()):self::pdf($c,$ctx->raw());
  $dir=self::dir($c,$id);if($dir===null)throw new AppError('Turniej nie jest dostępny.',404);
  self::mkdir($dir);foreach($file['files'] as $name=>$bytes)self::write("$dir/$name",$bytes);
  $out=self::commit($ctx,$actor,$id,$kind,$file['meta']);
  return ['workspace'=>$out['workspace'],'result'=>[$kind=>$out['view']]];
 }
 /** rules-text {t, text}: the typed rules (replaces a PDF, whose file goes after the commit); limits of rules-upload. */
 public static function saveText(RouteContext $ctx):array {
  $c=$ctx->config;$pdo=$ctx->pdo();$u=$ctx->user();
  $id=self::tournamentId($ctx->input('t'));
  Members::limit($pdo,$c,'material-upload',$u['id'],30,3600);
  $actor=self::writer($ctx,$id,true);$meta=self::textMeta($ctx->input('text'));
  $out=self::commit($ctx,$actor,$id,'rules',$meta);
  return ['workspace'=>$out['workspace'],'result'=>['rules'=>$out['view']]];
 }
 /** material-delete {t, kind}: 60 per hour per account. Returns {workspace, result:{}}. */
 public static function delete(RouteContext $ctx):array {
  $c=$ctx->config;$pdo=$ctx->pdo();$u=$ctx->user();
  $id=self::tournamentId($ctx->input('t'));$kind=$ctx->input('kind');if(!in_array($kind,self::KINDS,true))throw new AppError('Niepoprawna operacja.',400);
  Members::limit($pdo,$c,'material-delete',$u['id'],60,3600);
  $out=self::commit($ctx,self::writer($ctx,$id,false),$id,$kind,null);
  return ['workspace'=>$out['workspace'],'result'=>new \stdClass()];
 }
 /** "regulamin-<words of the name>.<ext>": ASCII letters and digits, words joined by '-', at most 60 characters ('turniej' when empty). */
 public static function fileName(string $name,string $ext='pdf'):string {
  $words=array_filter(array_map([Profiles::class,'slug'],preg_split('/[\s\p{P}\p{S}]+/u',$name)?:[]),'strlen');
  $slug=trim(substr(implode('-',$words),0,60),'-');
  return 'regulamin-'.($slug!==''?$slug:'turniej').'.'.$ext;
 }
 /** Whether the signed-in viewer (if any) manages a tournament created by $createdBy (Domain::manages with the member's roles). */
 private static function managedBy(RouteContext $ctx,?string $createdBy):bool {
  $u=$ctx->user();if(!$u)return false;
  return Domain::manages($u['role']==='member'?Actors::of($ctx->pdo(),$u):$u,['createdBy'=>$createdBy]);
 }
 /** The material route (GET ?t, k, s (poster: sm|lg), v): the file or text, or the same 404 for every refusal (see the class comment). */
 public static function serve(RouteContext $ctx):never {
  $missing=static fn()=>throw new AppError('Turniej nie jest dostępny.',404);
  $id=$ctx->query('t');$k=$ctx->query('k');$s=$ctx->query('s');$v=$ctx->query('v');
  if(!is_string($id)||!preg_match(self::ID,$id)||!in_array($k,self::KINDS,true)||!is_string($v)||!preg_match('/^[0-9a-f]{12}$/D',$v)||($k==='poster'?!in_array($s,['sm','lg'],true):$s!==null))$missing();
  $q=$ctx->pdo()->prepare('SELECT t.name,t.status,t.hidden_by,t.created_by,t.materials,u.role,u.active,u.organizer_blocked_at FROM tournaments t LEFT JOIN users u ON u.id=t.created_by WHERE t.id=?');
  $q->execute([$id]);$t=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();if(!$t)$missing();
  $meta=self::meta($k,self::decode($t['materials'])[$k]??null);$view=self::view([$k=>$meta])[$k]??null;
  if(!$meta||!$view||!hash_equals($view['v'],$v))$missing();
  $public=$t['status']!=='draft'&&$t['hidden_by']===null&&!($t['role']==='member'&&($t['organizer_blocked_at']!==null||(int)$t['active']!==1));
  if(!$public&&!self::managedBy($ctx,$t['created_by']))$missing();
  $etag='"'.$v.($k==='poster'?'-'.$s:'').'"';
  $headers=['Cache-Control: '.($public?'public':'private').', max-age=31536000, immutable','ETag: '.$etag,'X-Content-Type-Options: nosniff','Cross-Origin-Resource-Policy: same-origin'];
  $match=array_map('trim',explode(',',(string)($_SERVER['HTTP_IF_NONE_MATCH']??'')));
  if(in_array($etag,$match,true)||in_array('W/'.$etag,$match,true)){header_remove('Content-Type');foreach($headers as $line)header($line);http_response_code(304);exit;}
  $sandbox="Content-Security-Policy: default-src 'none'; sandbox";
  if(isset($meta['t'])){
   // A typed text: plain text, never HTML, in a sandbox.
   foreach([...$headers,'Content-Type: text/plain; charset=utf-8','Content-Disposition: inline; filename="'.self::fileName((string)$t['name'],'txt').'"',$sandbox,'Content-Length: '.strlen($meta['t'])] as $line)header($line);
   http_response_code(200);echo $meta['t'];exit;
  }
  [$hash,$ext]=explode('.',$meta['f']);
  $path=self::dir($ctx->config,$id).'/'.($k==='poster'?"$hash-$s.$ext":"$hash.pdf");
  $size=is_file($path)&&!is_link($path)?@filesize($path):false;if($size===false)$missing();
  // The PDF without a sandbox (it blocks the browser's PDF viewer).
  $type=$k==='rules'?['Content-Type: application/pdf','Content-Disposition: inline; filename="'.self::fileName((string)$t['name']).'"']:['Content-Type: '.($ext==='webp'?'image/webp':'image/jpeg'),$sandbox];
  foreach([...$headers,...$type,'Content-Length: '.$size] as $line)header($line);
  http_response_code(200);readfile($path);exit;
 }

 /**
  * Cleanup for the accounts-cleanup job: in each tournament directory, files that the tournament's current materials do not
  * name and that are older than one day (also temporary files of interrupted writes, and the PDF of rules now typed as text);
  * directories whose tournament no longer exists (older than one day); empty prefix directories older than one day. At most
  * $budget tournament directories and about $seconds per run, in name order, resuming after $after (the last directory the
  * previous run visited). Returns [files removed, directories removed, cursor]: the last directory visited when the run
  * stopped early, else null.
  */
 public static function sweep(PDO $pdo,array $c,int $now,int $budget=5000,?string $after=null,float $seconds=1.0):array {
  try{$root=self::root($c);}catch(\RuntimeException){return [0,0,null];}
  if(!is_dir($root)||is_link($root))return [0,0,null];
  if($after!==null&&!preg_match('/^[0-9a-f]{32}$/D',$after))$after=null;
  // Directory name => file names in use, for every tournament (ids are hashed here: no path is ever built from a directory name).
  $keep=[];foreach($pdo->query('SELECT id,materials FROM tournaments') as $r){$m=self::decode($r['materials'])??[];$keep[self::hash((string)$r['id'])]=array_flip([...self::files('poster',$m['poster']??null),...self::files('rules',$m['rules']??null)]);}
  $start=microtime(true);$seen=0;$files=0;$dirs=0;$day=86400;$last=$after;$from=$after===null?'':substr($after,0,2);
  foreach(scandir($root)?:[] as $prefix){
   if(!preg_match('/^[0-9a-f]{2}$/D',$prefix)||strcmp($prefix,$from)<0||!is_dir("$root/$prefix")||is_link("$root/$prefix"))continue;
   $all=array_values(array_filter(scandir("$root/$prefix")?:[],fn($d)=>preg_match('/^[0-9a-f]{32}$/D',$d)&&str_starts_with($d,$prefix)));
   if(!$all){if(@filemtime("$root/$prefix")<$now-$day)@rmdir("$root/$prefix");continue;}
   foreach($after===null?$all:array_filter($all,fn($d)=>strcmp($d,$after)>0) as $h){
    if(++$seen>$budget||microtime(true)-$start>$seconds)return [$files,$dirs,$last];
    $last=$h;$dir="$root/$prefix/$h";if(!is_dir($dir)||is_link($dir))continue;
    if(!isset($keep[$h])){if(@filemtime($dir)<$now-$day){$files+=self::removeDir($dir);$dirs++;}continue;}
    foreach(scandir($dir)?:[] as $f){
     if($f==='.'||$f==='..'||isset($keep[$h][$f])||!is_file("$dir/$f")||is_link("$dir/$f"))continue;
     if(@filemtime("$dir/$f")<$now-$day&&@unlink("$dir/$f"))$files++;
    }
   }
  }
  return [$files,$dirs,null];
 }
}
