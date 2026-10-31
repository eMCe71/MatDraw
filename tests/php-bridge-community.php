<?php
// Bridge for tests/community.test.mjs (plan §11): profile rules, Text::clean, Capabilities and the avatar pipeline of the
// accounts-profiles-backend slice, called with JSON on STDIN, without a database. Binary data travels as base64 and
// invalid UTF-8 as hex.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{Avatars,Capabilities,Config,Profiles,Text};
function attempt(callable $fn):array{try{return ['ok'=>$fn()];}catch(Throwable $e){return ['error'=>$e->getMessage(),'status'=>$e instanceof MatDraw\AppError?$e->status:null];}}
$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$str=fn(array $c)=>isset($c['hex'])?hex2bin($c['hex']):($c['s']??null);
$out=match($in['job']){
 'data'=>['countries'=>Profiles::COUNTRIES,'sports'=>Profiles::SPORTS,'reserved'=>Profiles::RESERVED,'prefixes'=>Profiles::RESERVED_PREFIXES],
 'username'=>array_map(fn($c)=>Profiles::usernameStatus($str($c)),$in['cases']),
 'names'=>array_map(fn($c)=>Profiles::cleanName($str($c)),$in['cases']),
 'slug'=>array_map(fn($c)=>Profiles::slug($str($c)),$in['cases']),
 'candidates'=>array_map(fn($c)=>Profiles::candidates($c[0],$c[1],$c[2]??''),$in['cases']),
 'clean'=>array_map(fn($c)=>Text::clean($str($c),['multiline'=>!empty($c['multiline'])]),$in['cases']),
 'validate'=>array_map(fn($c)=>attempt(fn()=>Profiles::validate($c['in'],!empty($c['partial']))),$in['cases']),
 'own'=>Profiles::own($in['row'],$in['now']),
 'bytes'=>array_map(fn($s)=>Capabilities::bytes($s),$in['values']),
 'avatar'=>(function()use($in){
  $c=array_replace(Config::DEFAULTS,$in['config']??[]);if(isset($in['memory']))ini_set('memory_limit',$in['memory']);
  // A file is base64, or {gen:[w,h]} for a plain PNG made here (large dimensions without a large fixture).
  $gen=function(array $wh):string{$im=imagecreatetruecolor($wh[0],$wh[1]);ob_start();imagepng($im,null,9);imagedestroy($im);return (string)ob_get_clean();};
  return array_map(function($f)use($c,$gen){
   $r=attempt(fn()=>Avatars::process($c,is_array($f)?$gen($f['gen']):base64_decode($f)));if(!isset($r['ok']))return $r;
   $img=$r['ok'];$info=[];
   foreach([256,64] as $s){$g=getimagesizefromstring($img[$s]);$im=imagecreatefromstring($img[$s]);
    $px=fn(int $x,int $y)=>array_values(array_slice(imagecolorsforindex($im,imagecolorat($im,$x,$y)),0,3));
    $info[$s]=['w'=>$g[0],'h'=>$g[1],'mime'=>$g['mime'],'b64'=>base64_encode($img[$s]),'top'=>$px(intdiv($s,2),intdiv($s,10)),'bottom'=>$px(intdiv($s,2),$s-1-intdiv($s,10)),'left'=>$px(intdiv($s,10),intdiv($s,2)),'right'=>$px($s-1-intdiv($s,10),intdiv($s,2))];}
   return ['ok'=>['ext'=>$img['ext'],'sizes'=>$info]];
  },$in['files']);
 })(),
 'mode'=>['mode'=>Capabilities::avatarMode([]),'gd'=>Capabilities::gd(),'readable'=>Capabilities::readable()],
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE);
