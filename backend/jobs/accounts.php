<?php
// Account background job (plan §3.7, §7.5), run by MatDraw\Jobs after responses or by bin/cron.php, once a day.
// accounts-cleanup:
//  1. Abandoned sign-ups, only while billing_enforce=true (otherwise members have full access and use the chat without
//     paying, so they are not abandoned). A member account is deleted when all of these hold: users.active=1 (deleted and
//     anonymised accounts are skipped), not exempt, no Stripe customer, sub_status 'none' (or no billing row), profile
//     created more than abandoned_member_days ago, last login as old or never, no chat message and no report filed
//     (chat_reports.reporter_id has a foreign key without cascade). At most 50 accounts per run; each in its own
//     transaction and try/catch (an error is logged with class and SQLSTATE only, the next account follows). The
//     transaction locks the account again with the same conditions (FOR UPDATE) and skips it when they no longer hold
//     (a sign-in, a Checkout or an exemption since the list was read). Deleted: chat_mutes, account_audit about the
//     person, user_profiles, billing_accounts, users, then the avatar directory.
//  2. Avatar files (always): in each person's directory, files other than the current photo older than one day, and
//     directories of public_ids without a profile row (Avatars::sweep, at most 5000 directories and about 2 s). A run
//     that stops early stores avatar_next=<public_id> in its result (job_runs.last_result) and the next one resumes there.
// The chat tables are optional (migration 0003 of chat-backend); without them the chat conditions do not apply.
declare(strict_types=1);
use MatDraw\{Avatars,Members,Routes};
return [
 'accounts-cleanup'=>['every'=>86400,'needsFlush'=>false,'run'=>function(PDO $pdo,array $c,int $now):string{
  $deleted=0;$failed=0;$state='off';
  if(!empty($c['billing_enforce'])){
   $state='on';$cut=$now-max(1,(int)$c['abandoned_member_days'])*86400;
   $messages=Members::tableExists($pdo,'chat_messages');$reports=Members::tableExists($pdo,'chat_reports');$mutes=Members::tableExists($pdo,'chat_mutes');
   $from="FROM users u JOIN user_profiles p ON p.user_id=u.id LEFT JOIN billing_accounts b ON b.user_id=u.id
    WHERE u.role='member' AND u.active=1 AND p.created_at<? AND (p.last_login_at IS NULL OR p.last_login_at<?)
     AND (b.user_id IS NULL OR (b.billing_exempt=0 AND b.stripe_customer_id IS NULL AND b.sub_status='none' AND b.deleted_at IS NULL))"
    .($messages?' AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.user_id=u.id)':'')
    .($reports?' AND NOT EXISTS (SELECT 1 FROM chat_reports r WHERE r.reporter_id=u.id)':'');
   $q=$pdo->prepare("SELECT u.id,p.public_id $from ORDER BY p.created_at LIMIT 50");$q->execute([$cut,$cut]);
   foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r){
    try{
     $gone=Members::tx($pdo,function()use($pdo,$r,$mutes,$from,$cut){
      $id=$r['id'];
      $l=$pdo->prepare("SELECT u.id $from AND u.id=? FOR UPDATE");$l->execute([$cut,$cut,$id]);$still=$l->fetchColumn();$l->closeCursor();
      if($still===false)return false;
      if($mutes)$pdo->prepare('DELETE FROM chat_mutes WHERE user_id=?')->execute([$id]);
      $pdo->prepare('DELETE FROM account_audit WHERE target_user_id=?')->execute([$id]);
      $pdo->prepare('DELETE FROM user_profiles WHERE user_id=?')->execute([$id]);
      $pdo->prepare('DELETE FROM billing_accounts WHERE user_id=?')->execute([$id]);
      $pdo->prepare("DELETE FROM users WHERE id=? AND role='member' AND active=1")->execute([$id]);
      return true;
     });
     if($gone){Avatars::removeOwner($c,$r['public_id']);$deleted++;}
    }catch(\Throwable $e){Routes::logThrowable($e,'MatDraw accounts-cleanup');$failed++;}
   }
  }
  $prev=$pdo->query("SELECT last_result FROM job_runs WHERE name='accounts-cleanup'")->fetchColumn();
  [$files,$dirs,$next]=Avatars::sweep($pdo,$c,$now,5000,is_string($prev)&&preg_match('/\bavatar_next=([A-Za-z0-9]{12})\b/',$prev,$m)?$m[1]:null);
  return "abandoned=$state deleted=$deleted failed=$failed avatar_files=$files avatar_dirs=$dirs avatar_next=".($next??'-');
 }],
];
