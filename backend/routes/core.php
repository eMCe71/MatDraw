<?php
// Core routes (plan §4.2–4.3): me (the signed-in person's community state) and public-config (switches for guests).
// Calls into later slices go through class_exists, so this file works before and after them:
//   Capabilities::avatarMode($config): 'gd-webp'|'gd-jpeg'|'off'      (accounts-profiles-backend; absent → 'off')
//   ChatModeration::mutedUntil(PDO,$userId): null|false (not muted) | true (muted, no end) | int (muted until)
//   Chat (class present = chat installed); chat_settings.data.on (§2.4) switches posting off from the Admin panel
//   BillingSync::lazy(PDO,$config,$userId) after the response, when the account's next_sync_at is due (billing-backend)
declare(strict_types=1);
use MatDraw\{Access,Accounts,BillingSync,Capabilities,Chat,ChatModeration,Jobs,RouteContext,Routes};

/** Avatar mode of this server: 'off' while avatars are disabled or the avatar code is not installed. */
$avatarMode=static function(array $c):string{
 if(empty($c['avatars_enabled'])||!class_exists(Capabilities::class)||!method_exists(Capabilities::class,'avatarMode'))return 'off';
 $m=Capabilities::avatarMode($c);return in_array($m,['gd-webp','gd-jpeg'],true)?$m:'off';
};
return [
 'me'=>['method'=>'GET','auth'=>'peek','user'=>'required','handler'=>function(RouteContext $ctx)use($avatarMode):array{
  $c=$ctx->config;$pdo=$ctx->pdo();$u=$ctx->user();$now=time();
  $p=Accounts::profile($pdo,$u['id']);$row=Access::row($pdo,$u['id']);$access=Access::compute($row,$u,$c,$now);
  $complete=Accounts::profileComplete($p);$mustChange=$p['pw_reset_at']!==null;
  $chat=!Routes::chatOff($c)&&class_exists(Chat::class);$chatOn=$chat;
  if($chat){$data=json_decode((string)$pdo->query('SELECT data FROM chat_settings WHERE id=1')->fetchColumn(),true);$chatOn=!is_array($data)||($data['on']??true)!==false;}
  $muted=false;$mutedUntil=null;
  if(class_exists(ChatModeration::class)&&method_exists(ChatModeration::class,'mutedUntil')){
   $m=ChatModeration::mutedUntil($pdo,$u['id']);if($m===true)$muted=true;elseif(is_int($m)&&$m>$now){$muted=true;$mutedUntil=$m;}
  }
  // One reason the composer is closed, the one the person can act on first: a temporary password (§3.10), payment,
  // the profile, a moderator's mute, then the chat being off.
  $block=$mustChange?'password':(!$access['full']?'payment':(!$complete?'profile':($muted?'muted':(!$chatOn?'off':null))));
  $exempt=$u['role']==='admin'||($row?!empty($row['billing_exempt'])&&($row['exempt_until']===null||(int)$row['exempt_until']>$now):in_array($u['role'],['editor','club'],true));
  $live=$c['billing_mode']==='live';$sameMode=$row&&((int)$row['livemode']===1)===$live;
  $billing=empty($c['billing_enabled'])?['enabled'=>false]:['enabled'=>true,'enforce'=>!empty($c['billing_enforce']),'mode'=>$c['billing_mode'],
   'currency'=>Access::currency($row,$p['country'],$c),'amounts'=>$c['billing_amounts'],'exempt'=>$exempt,
   'hasCustomer'=>$sameMode&&$row['stripe_customer_id']!==null,'pending'=>$row!==null&&$row['pending_checkout_id']!==null&&(int)$row['pending_checkout_expires']>$now];
  $changeAt=$p['username_changed_at']!==null&&(int)$p['username_changed_at']+30*86400>$now?(int)$p['username_changed_at']+30*86400:null;
  // After the response: jobs and a due payment sync, both releasing the session first (§3.7, §6.3).
  $syncDue=!empty($c['billing_enabled'])&&$row!==null&&$row['stripe_customer_id']!==null&&$row['next_sync_at']!==null&&(int)$row['next_sync_at']<=$now;
  $userId=$u['id'];
  register_shutdown_function(static function()use($pdo,$c,$syncDue,$userId){
   Jobs::maybe($pdo,$c);
   if($syncDue&&class_exists(BillingSync::class)&&method_exists(BillingSync::class,'lazy')){try{BillingSync::lazy($pdo,$c,$userId);}catch(Throwable $e){Routes::logThrowable($e,'MatDraw billing lazy');}}
  });
  return ['user'=>Accounts::safe($u),
   'profile'=>['publicId'=>$p['public_id'],'username'=>$p['username'],'firstName'=>$p['first_name'],'lastName'=>$p['last_name'],'country'=>$p['country'],
    'sports'=>array_values(array_filter(explode(',',(string)$p['sports']),'strlen')),'clubText'=>$p['club_text'],'showClub'=>(bool)$p['show_club'],'nameDisplay'=>$p['name_display'],
    'avatar'=>is_string($p['avatar'])&&$p['avatar']!==''?substr($p['avatar'],0,12):null,'complete'=>$complete,'usernameChangeAt'=>$changeAt,'mustChangePassword'=>$mustChange],
   'access'=>$access+['canPost'=>$block===null,'block'=>$block,'mutedUntil'=>$mutedUntil],
   'billing'=>$billing,
   'features'=>['signup'=>!empty($c['signup_enabled']),'avatars'=>$avatarMode($c),'chat'=>$chat]];
 }],
 // Switches for the guest pages (§4.3, §6.10): signup is false in invite-only mode; billing means a price is shown
 // (payments enabled and enforced). No secrets and no Stripe mode.
 'public-config'=>['method'=>'GET','auth'=>'public','handler'=>function(RouteContext $ctx)use($avatarMode):array{
  $c=$ctx->config;header('Cache-Control: public, max-age=60');
  return ['signup'=>!empty($c['signup_enabled']),'billing'=>!empty($c['billing_enabled'])&&!empty($c['billing_enforce']),'amounts'=>$c['billing_amounts'],
   'avatars'=>$avatarMode($c)!=='off','support'=>is_string($c['support_email'])&&$c['support_email']!==''?$c['support_email']:null];
 }],
];
