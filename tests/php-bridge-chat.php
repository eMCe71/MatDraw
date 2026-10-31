<?php
// Bridge for tests/chat.test.mjs (plan §11): chat functions called with JSON on STDIN, no database.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{Chat,ChatGuestView,ChatModeration,ChatSettings};
date_default_timezone_set('Europe/Warsaw');
/** ['ok'=>value] or ['error'=>message,'status'=>http status]. */
function attempt(callable $fn):array{try{return ['ok'=>$fn()];}catch(MatDraw\AppError $e){return ['error'=>$e->getMessage(),'status'=>$e->status]+($e instanceof MatDraw\ApiError?['data'=>$e->data]:[]);}}
$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$out=match($in['job']){
 'constants'=>['lobby'=>Chat::LOBBY,'defaults'=>ChatSettings::DEFAULTS,'client'=>ChatSettings::CLIENT,'presets'=>ChatSettings::PRESETS,'fields'=>ChatGuestView::FIELDS,'tombstone'=>ChatGuestView::TOMBSTONE],
 'guest'=>array_map(fn($c)=>ChatGuestView::message($c['row'],$c['channel'],$c['key']),$in['cases']),
 'variant'=>array_map(fn($c)=>ChatGuestView::variant($c['key'],$c['ms'],$c['channel'],$c['user']),$in['cases']),
 'member'=>array_map(fn($c)=>Chat::memberMessage($c['row'],$c['pid'],$c['organizer']),$in['cases']),
 'state'=>array_map(fn($c)=>Chat::tournamentState($c['t'],$c['today'],$c['viewer'],$c['grace']??1),$in['cases']),
 'visible'=>array_map(fn($c)=>Chat::visibleFor($c['ch'],$c['t'],$c['viewer'],$c['today'],$c['grace']??1),$in['cases']),
 'shift'=>array_map(fn($c)=>Chat::shiftDate($c[0],$c[1]),$in['cases']),
 'body'=>array_map(fn($c)=>attempt(fn()=>Chat::body(isset($c['hex'])?hex2bin($c['hex']):$c['b'])),$in['cases']),
 'cont'=>array_map(fn($c)=>Chat::cont($c['prev'],$c['user'],$c['now']),$in['cases']),
 'wait'=>array_map(fn($c)=>Chat::wait($c['r'],$c['send'],$c['now']),$in['cases']),
 'parse'=>array_map(fn($q)=>attempt(fn()=>Chat::parseQuery($q)),$in['cases']),
 'decide'=>array_map(fn($c)=>Chat::decide(Chat::parseQuery($c['q']),$c['channels'],$c['state'],$c['stale']),$in['cases']),
 'normalize'=>array_map(fn($d)=>ChatSettings::normalize($d),$in['cases']),
 'client'=>ChatSettings::client(ChatSettings::DEFAULTS),
 'preset'=>array_map(fn($ms)=>ChatSettings::preset($ms),$in['cases']),
 'text'=>array_map(fn($c)=>attempt(fn()=>ChatModeration::text($c['s'],$c['kind'])),$in['cases']),
 'public-keys'=>array_map(fn()=>Chat::publicKey(),range(1,$in['n'])),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
