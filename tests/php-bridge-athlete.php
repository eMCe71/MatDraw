<?php
// Bridge for tests/athlete-view.test.mjs (PLAN-REJESTRACJA-ROLE §7.4, §12): AthleteView without a database, called with JSON
// on STDIN. Jobs: workspace (fromWorkspace for each {user, today}), project (project of given inputs), position (saved draws).
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{AthleteView,GuestView};
$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$out=match($in['job']){
 'workspace'=>array_map(fn($c)=>AthleteView::fromWorkspace($in['db'],['id'=>$c['user']],$c['today'],$c['withdrawals']??null,$c['organizers']??[]),$in['cases']),
 'project'=>AthleteView::project($in['profiles'],$in['tournaments'],$in['withdrawals'],$in['today'],$in['organizers']),
 'position'=>array_map(function($c){$b=GuestView::bracket($c['draw'],$c['athletes']);return ['bracket'=>$b,'position'=>$b?AthleteView::position($c['draw'],$c['id'],$b['bracket']):null];},$in['cases']),
 'recent'=>array_map([AthleteView::class,'recentFrom'],$in['dates']),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
