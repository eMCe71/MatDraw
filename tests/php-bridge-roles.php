<?php
// Bridge for tests/roles-parity.test.mjs (PLAN-REJESTRACJA-ROLE §12): Domain, Clubs, Rules, Settings and Actors without a
// database, JSON on STDIN, JSON on STDOUT. Dates in Europe/Warsaw like the server (matdraw_config) and the browser demo.
//  execute     {db, flags?, commands:[{actor,type,payload,revision?}]}: sequential Domain::execute on a copy per command
//              (a failure leaves the state as it was); payload strings '@N' become the result id of command N and
//              '#club:Name' the id of the club named Name. Returns {db, results:[{status, result|error, data?}]}.
//  public      {db, flags?, actors:[id]}: Domain::publicData for each account of db.users.
//  stale       {db, cases:[{type, p, expected, actor}]}: Domain::stale.
//  contact     {cases:[string]}: Domain::contact.   clubKey {cases:[mixed]}: Clubs::key.
//  pick        {cases:[{clubs, u, choice, now, counts}]}: Clubs::pick (a new club id becomes 'NEW').
//  athlete     {today, cases:[payload]}: Domain::athleteFields.
//  sameClub    {pairs:[[a,b]]}: Rules::sameClub.   drawCost {athletes, runs}: same-club first-round pairs after makeDraw.
//  drawSlots   {db, athletes, runs}: the slots of Rules::makeDraw(Domain::drawAthletes(db, athletes)) for each run.
//  drawAthletes {db, athletes}: Domain::drawAthletes.
//  settings    {cases:[config]}: Settings::effective twice (idempotence) and Settings::flags.
//  actor       {account, organizer, blockedAt, trustedAt, athletes}: Actors::build.
//  forgetMember {db, users:[id]}: Domain::forgetMember for each account in order.   retain {db, cutoff, limit}: Domain::retain.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
date_default_timezone_set('Europe/Warsaw');
use MatDraw\{Actors,ApiError,AppError,Clubs,Domain,Rules,Settings};
function attempt(callable $fn):array{try{return ['status'=>200,'result'=>$fn()];}catch(AppError $e){return ['status'=>$e->status,'error'=>$e->getMessage()]+($e instanceof ApiError?['data'=>$e->data]:[]);}}
function refs(mixed $v,array $ids,array $db):mixed {
 if(is_string($v)&&preg_match('/^@(\d+)$/D',$v,$m))return $ids[(int)$m[1]]??$v;
 if(is_string($v)&&str_starts_with($v,'#club:')){foreach($db['clubs'] as $c)if($c['name']===substr($v,6))return $c['id'];return $v;}
 if(is_array($v))foreach($v as $k=>$x)$v[$k]=refs($x,$ids,$db);
 return $v;
}
$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$withFlags=fn(array $db)=>isset($in['flags'])?['flags'=>$in['flags']]+$db:$db;
$out=match($in['job']){
 'execute'=>(function()use($in,$withFlags){
  $db=$withFlags($in['db']);$ids=[];$results=[];
  foreach($in['commands'] as $i=>$c){
   $next=$db;$p=refs($c['payload']??[],$ids,$db);
   $r=attempt(function()use(&$next,$c,$p){return Domain::execute($next,$c['actor'],$c['type'],$p,$c['revision']??$next['revision']);});
   if($r['status']===200){$db=$next;$ids[$i]=$r['result']['id']??null;}$results[]=$r;
  }
  unset($db['flags']);return ['db'=>$db,'results'=>$results];
 })(),
 'public'=>(function()use($in,$withFlags){$db=$withFlags($in['db']);$out=[];foreach($in['actors'] as $id){$u=null;foreach($db['users'] as $x)if($x['id']===$id)$u=$x;$out[]=Domain::publicData($db,$u);}return $out;})(),
 'stale'=>array_map(fn($c)=>Domain::stale($in['db'],$c['type'],$c['p'],$c['expected'],$c['actor']??null),$in['cases']),
 'contact'=>array_map(fn($s)=>Domain::contact($s),$in['cases']),
 'clubKey'=>array_map(fn($s)=>Clubs::key($s),$in['cases']),
 'pick'=>array_map(function($c){$r=attempt(fn()=>Clubs::pick($c['clubs'],$c['u'],$c['choice'],$c['now'],$c['counts']??[]));if(isset($r['result']['newClub'])){$r['result']['newClub']['id']='NEW';if($r['result']['clubId']!==Clubs::UNAFFILIATED)$r['result']['clubId']='NEW';}return $r;},$in['cases']),
 'athlete'=>array_map(fn($p)=>attempt(fn()=>Domain::athleteFields($p,$in['today'])),$in['cases']),
 'sameClub'=>array_map(fn($p)=>Rules::sameClub($p[0],$p[1]),$in['pairs']),
 'drawCost'=>(function()use($in){$out=[];$map=array_column($in['athletes'],null,'id');for($i=0;$i<$in['runs'];$i++){$d=Rules::makeDraw($in['athletes']);$n=0;for($s=0;$s<count($d['slots']);$s+=2){[$a,$b]=[$d['slots'][$s],$d['slots'][$s+1]];if($a&&$b&&Rules::sameClub($map[$a],$map[$b]))$n++;}$out[]=$n;}return $out;})(),
 'drawSlots'=>(function()use($in){$out=[];$a=Domain::drawAthletes($in['db'],$in['athletes']);for($i=0;$i<$in['runs'];$i++)$out[]=Rules::makeDraw($a)['slots'];return $out;})(),
 'drawAthletes'=>Domain::drawAthletes($in['db'],$in['athletes']),
 'settings'=>array_map(function($c){$e=Settings::effective(null,$c);return ['effective'=>$e,'again'=>Settings::effective(null,$e)===$e,'flags'=>Settings::flags($e)];},$in['cases']),
 'actor'=>Actors::build($in['account'],$in['organizer'],$in['blockedAt'],$in['trustedAt'],$in['athletes']),
 'forgetMember'=>(function()use($in){$db=$in['db'];$out=[];foreach($in['users'] as $id)$out[]=Domain::forgetMember($db,$id);return ['db'=>$db,'out'=>$out];})(),
 'retain'=>(function()use($in){$db=$in['db'];$out=Domain::retain($db,$in['cutoff'],$in['limit']??200);return ['db'=>$db,'out'=>$out];})(),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
