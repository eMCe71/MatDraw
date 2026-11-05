<?php
// Bridge for tests/materials.test.mjs (PLAN-MATERIALY §2.3): MatDraw\Materials without a database, JSON on STDIN, JSON on STDOUT.
// Binary data travels as base64. Images are made here with GD (no binary fixtures in the repository):
//   {gen:{w, h, format:'png'|'jpeg'|'webp'|'gif', fill:[r,g,b], alpha:true (fully transparent PNG), quadrants:true (R G / B W),
//         orientation:1–8 (a JPEG APP1 segment with only Orientation), exif:true (an APP1 segment with a marker text),
//         trailing:'text' (appended after the image)}}
//  image    {gen}: the generated file (base64), for HTTP tests.
//  process  {config, memory?, files:[{b64}|{gen}]}: Materials::process for each (memory_limit set after the files are made);
//           per result the meta and, per output (lg, sm), width, height, mime, size, whether 'Exif' or the marker survives,
//           and the colours at the centres of the four quadrants.
//  pdf      {config, files:[{b64}|{text}]}: Materials::pdf (meta or error and status).
//  meta     {cases:[{kind, v}]}: Materials::meta.   view {cases:[m]}: Materials::view.   fileName {names, ext}: Materials::fileName.
//  text     {cases:[mixed]}: Materials::text.   textMeta {cases:[mixed]}: Materials::textMeta (t, or error and status).
//  limits   {config}: posterMax, rulesMax, limits, bodyLimit, the poster-upload and rules-upload max of the route registry.
//  dir      {config, ids}: Materials::dir for each id.
//  fit      {cases:[[w,h,maxW,maxH]]}: Materials::fit.
//  inviteField, inviteMeta: the organizer's invitation (see the jobs).
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{AppError,Config,Materials,Routes};
function attempt(callable $fn):array{try{return ['ok'=>$fn()];}catch(AppError $e){return ['error'=>$e->getMessage(),'status'=>$e->status];}}
function gen(array $g):string {
 [$w,$h]=[(int)$g['w'],(int)$g['h']];$im=imagecreatetruecolor($w,$h);
 if(!empty($g['alpha'])){imagesavealpha($im,true);imagealphablending($im,false);imagefill($im,0,0,imagecolorallocatealpha($im,0,0,0,127));}
 else imagefill($im,0,0,(int)imagecolorallocate($im,...($g['fill']??[51,102,153])));
 if(!empty($g['quadrants']))foreach([[0,0,[255,0,0]],[1,0,[0,255,0]],[0,1,[0,0,255]],[1,1,[255,255,255]]] as [$x,$y,$rgb])imagefilledrectangle($im,$x*intdiv($w,2),$y*intdiv($h,2),$x?$w-1:intdiv($w,2)-1,$y?$h-1:intdiv($h,2)-1,(int)imagecolorallocate($im,...$rgb));
 ob_start();
 match($g['format']??'png'){'png'=>imagepng($im,null,9),'jpeg'=>imagejpeg($im,null,95),'webp'=>imagewebp($im,null,90),'gif'=>imagegif($im)};
 $bytes=(string)ob_get_clean();imagedestroy($im);
 if(($g['format']??'')==='jpeg'&&(isset($g['orientation'])||!empty($g['exif']))){
  // Big-endian TIFF: IFD0 with Orientation (and an ImageDescription marker), as tests/fixtures/avatars/make.php does.
  $desc="MatBravoPosterExifMarker\0";$o=(int)($g['orientation']??1);
  $tiff=empty($g['exif'])?"MM\x00\x2A\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00".chr($o)."\x00\x00\x00\x00\x00\x00"
   :'MM'.pack('nN',42,8).pack('n',2).pack('nnN',0x010E,2,strlen($desc)).pack('N',8+2+2*12+4).pack('nnN',0x0112,3,1).pack('n',$o)."\0\0".pack('N',0).$desc;
  $bytes=substr($bytes,0,2)."\xFF\xE1".pack('n',strlen($tiff)+8)."Exif\0\0".$tiff.substr($bytes,2);
 }
 return $bytes.($g['trailing']??'');
}
$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$cfg=fn()=>array_replace(Config::DEFAULTS,$in['config']??[]);
$file=fn(array $f)=>isset($f['gen'])?gen($f['gen']):(isset($f['text'])?(string)$f['text']:base64_decode((string)$f['b64']));
$out=match($in['job']){
 'image'=>base64_encode(gen($in['gen'])),
 'process'=>(function()use($in,$cfg,$file){
  $raws=array_map($file,$in['files']);if(isset($in['memory']))ini_set('memory_limit',(string)$in['memory']);$c=$cfg();
  return array_map(function(string $raw)use($c){
   $r=attempt(fn()=>Materials::process($c,$raw));if(!isset($r['ok']))return $r;
   $outs=[];
   foreach($r['ok']['files'] as $name=>$bytes){
    $g=getimagesizefromstring($bytes);$im=imagecreatefromstring($bytes);[$w,$h]=[imagesx($im),imagesy($im)];
    $px=function(int $x,int $y)use($im){$c=imagecolorsforindex($im,imagecolorat($im,$x,$y));return match(true){$c['red']>200&&$c['green']>200&&$c['blue']>200=>'W',$c['red']>200&&$c['green']<80&&$c['blue']<80=>'R',$c['green']>200&&$c['red']<80=>'G',$c['blue']>200&&$c['red']<80=>'B',default=>sprintf('#%02x%02x%02x',$c['red'],$c['green'],$c['blue'])};};
    $outs[preg_match('/-(lg|sm)\./',$name,$m)?$m[1]:$name]=['name'=>$name,'w'=>$w,'h'=>$h,'mime'=>$g['mime'],'size'=>strlen($bytes),'exif'=>str_contains($bytes,'Exif')||str_contains($bytes,'MatBravoPosterExifMarker'),'trailing'=>str_contains($bytes,'MatBravoTrailingPayload'),
     'quadrants'=>[$px(intdiv($w,4),intdiv($h,4)),$px(intdiv(3*$w,4),intdiv($h,4)),$px(intdiv($w,4),intdiv(3*$h,4)),$px(intdiv(3*$w,4),intdiv(3*$h,4))]];
    imagedestroy($im);
   }
   return ['ok'=>['meta'=>$r['ok']['meta'],'files'=>$outs,'hash'=>substr(hash('sha256',$r['ok']['files'][array_key_first($r['ok']['files'])]),0,32)]];
  },$raws);
 })(),
 'pdf'=>(function()use($in,$cfg,$file){$c=$cfg();return array_map(fn($f)=>attempt(fn()=>Materials::pdf($c,$file($f))['meta']+['hash'=>substr(hash('sha256',$file($f)),0,32)]),$in['files']);})(),
 'meta'=>array_map(fn($x)=>Materials::meta((string)$x['kind'],$x['v']),$in['cases']),
 'view'=>array_map(fn($m)=>(object)Materials::view($m),$in['cases']),
 'fileName'=>array_map(fn($n)=>Materials::fileName((string)$n,(string)($in['ext']??'pdf')),$in['names']),
 'text'=>array_map(fn($s)=>Materials::text($s),$in['cases']),
 'textMeta'=>array_map(fn($s)=>attempt(fn()=>Materials::textMeta($s)['t']),$in['cases']),
 'limits'=>(function()use($cfg){$c=$cfg();$routes=Routes::all();return ['posterMax'=>Materials::posterMax($c),'rulesMax'=>Materials::rulesMax($c),'limits'=>Materials::limits($c),'body'=>Materials::bodyLimit(),
  'routes'=>array_map(fn($n)=>[$routes[$n]['method'],$routes[$n]['auth'],$routes[$n]['user'],$routes[$n]['max']??null,$routes[$n]['types']??null],['poster-upload'=>'poster-upload','rules-upload'=>'rules-upload','rules-text'=>'rules-text','material-delete'=>'material-delete','material'=>'material'])];})(),
 'dir'=>(function()use($in,$cfg){$c=$cfg();return array_map(fn($id)=>Materials::dir($c,(string)$id),$in['ids']);})(),
 'fit'=>array_map(fn($x)=>Materials::fit(...$x),$in['cases']),
 // The organizer's invitation (PLAN-MATERIALY §6): inviteField {cases:[[key, raw]]}, inviteMeta {cases:[[style, fields]]} (meta without at, or error and status), inviteJson {cases:[meta]}.
 'inviteField'=>array_map(fn($x)=>Materials::inviteField((string)$x[0],$x[1]),$in['cases']),
 'inviteMeta'=>array_map(fn($x)=>attempt(function()use($x){$m=Materials::inviteMeta($x[0],$x[1]);unset($m['at']);return $m;}),$in['cases']),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
