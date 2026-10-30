<?php
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{Rules,Domain,AppError};
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
if($input['job']==='classify'){
 $out=[];foreach($input['cases'] as $c)$out[]=Rules::classify($c['athlete'],$c['event']);
}elseif($input['job']==='commands'){
 $db=$input['db'];$out=[];
 foreach($input['commands'] as $c){$next=$db;try{$r=Domain::execute($next,$c['actor'],$c['type'],$c['payload'],$c['revision']??$db['revision']);$db=$next;$out[]=['status'=>200,'result'=>$r];}catch(AppError $e){$out[]=['status'=>$e->status,'error'=>$e->getMessage()];}}
 $out=['db'=>$db,'results'=>$out];
}elseif($input['job']==='draws'){
 $out=[];for($n=3;$n<=64;$n++){$a=[];for($i=0;$i<$n;$i++)$a[]=['id'=>'a'.$i,'club'=>'c'.($i%5),'champion'=>$i===0];$d=Rules::makeDraw($a);$matches=0;while(true){$ready=[];foreach(Rules::resolve($d) as $r)foreach($r as $m)if($m['ready'])$ready[]=$m;if(!$ready)break;foreach($ready as $m){Rules::result($d,$m['id'],$m['a']);$matches++;}}$finished=Rules::resolve($d);$out[]=['n'=>$n,'unique'=>count(array_unique(array_filter($d['slots']))),'matches'=>$matches,'winner'=>end($finished)[0]['winner']];}
}
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
