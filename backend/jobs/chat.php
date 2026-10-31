<?php
// Chat retention (plan §5.8, §10), hourly, run by MatDraw\Jobs after responses or by bin/cron.php. Batches of 500 rows
// and about 2 seconds of work per run; whatever is left waits for the next run.
//   - messages older than retentionDays (365) are deleted with their reports (ON DELETE CASCADE); msg_count of their
//     channels drops by the number of visible ones removed, under the channel row lock (the lock order of every chat writer),
//     computed in PHP from the locked row (GREATEST(msg_count,?) with a bound value would compare as strings in MySQL 8.0);
//   - chat_mod_log.original_body older than modKeepDays (30) becomes NULL;
//   - expired mutes, resolved reports older than 180 days and chat_health rows older than 14 days are deleted.
// Tournament channels whose history became empty stay (cheap). The log rows themselves stay (no personal text left).
declare(strict_types=1);
use MatDraw\ChatSettings;
return [
 'chat-retention'=>['every'=>3600,'needsFlush'=>false,'run'=>function(PDO $pdo,array $c,int $now):string{
  $d=ChatSettings::get($pdo)['data'];$start=microtime(true);$late=fn()=>microtime(true)-$start>2;
  $cut=($now-$d['retentionDays']*86400)*1000;$messages=0;
  while(!$late()){
   $q=$pdo->prepare('SELECT id,channel_id FROM chat_messages WHERE created_ms<? ORDER BY created_ms,id LIMIT 500');$q->execute([$cut]);$batch=$q->fetchAll(PDO::FETCH_ASSOC);
   if(!$batch)break;
   $byChannel=[];foreach($batch as $r)$byChannel[(int)$r['channel_id']][]=(int)$r['id'];ksort($byChannel);
   foreach($byChannel as $ch=>$ids){
    $pdo->beginTransaction();
    try{
     $l=$pdo->prepare('SELECT msg_count FROM chat_channels WHERE id=? FOR UPDATE');$l->execute([$ch]);$count=(int)$l->fetchColumn();$l->closeCursor();
     $in=implode(',',array_fill(0,count($ids),'?'));
     $v=$pdo->prepare("SELECT COUNT(*) FROM chat_messages WHERE id IN ($in) AND created_ms<? AND state='visible' FOR UPDATE");$v->execute([...$ids,$cut]);$visible=(int)$v->fetchColumn();$v->closeCursor();
     $del=$pdo->prepare("DELETE FROM chat_messages WHERE id IN ($in) AND created_ms<?");$del->execute([...$ids,$cut]);$messages+=$del->rowCount();
     if($visible)$pdo->prepare('UPDATE chat_channels SET msg_count=? WHERE id=?')->execute([max(0,$count-$visible),$ch]);
     $pdo->commit();
    }catch(Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
   }
   if(count($batch)<500)break;
  }
  $step=function(string $sql,array $params)use($pdo,$late):int{$n=0;do{$q=$pdo->prepare($sql.' LIMIT 500');$q->execute($params);$k=$q->rowCount();$n+=$k;}while($k===500&&!$late());return $n;};
  $originals=$step('UPDATE chat_mod_log SET original_body=NULL WHERE original_body IS NOT NULL AND created_at<?',[$now-$d['modKeepDays']*86400]);
  $mutes=$step('DELETE FROM chat_mutes WHERE until_at IS NOT NULL AND until_at<=?',[$now]);
  $reports=$step("DELETE FROM chat_reports WHERE status<>'open' AND resolved_at<?",[$now-180*86400]);
  $health=$step('DELETE FROM chat_health WHERE hour_at<?',[$now-14*86400]);
  return "messages=$messages originals=$originals mutes=$mutes reports=$reports health=$health";
 }],
];
