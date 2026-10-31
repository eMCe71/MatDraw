<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Community accounts (role member): sign-up, own password, e-mail and deletion, and the Admin's member panel (plan §3.4,
 * §3.6, §3.8–§3.10, §4.3). Members never enter the workspace (Repository skips them); their rows are users (role member,
 * club_id NULL), user_profiles and billing_accounts. Every change of password, e-mail, active state or deletion raises
 * users.auth_version (all sessions of the account end) and lands in account_audit without e-mails, passwords or texts.
 * Uniqueness is the database's job: a duplicate key (1062) becomes a neutral 409.
 * Calls into slices of the same wave go through class_exists and bridge() (plan §12; checked by integration-qa):
 *   Chat::tombstoneUser(PDO,$userId)                       messages of a deleted account become tombstones (chat-backend)
 *   ChatModeration::mutedIds(PDO,$ids)                     muted members among $ids, for the muted filter (chat-backend)
 *   BillingSync::sync(…)                                   forced payment sync before deleting an account (billing-backend)
 *   Billing::deleteCustomer(…), Billing::pushCustomerEmail(…)  Stripe customer removal and e-mail update (billing-backend)
 * bridge() fills the parameters of those billing methods by type (PDO → connection, array → config, string → user id),
 * so they work whichever of (PDO,$userId) or (PDO,$config,$userId) the billing slice settles on.
 */
final class Members {
 private const TEMP_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
 public const PAGE=50,SIGNUP_MIN_SECONDS=3,SIGNUP_MAX_SECONDS=7200;

 /** One rate-limit attempt (RateLimit::hit) with the generic 429 message. */
 public static function limit(PDO $pdo,array $c,string $scope,string $key,int $limit,int $window):void {
  if($s=RateLimit::hit($pdo,$c['app_key'],$scope,$key,$limit,$window)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób. Spróbuj ponownie później.',429,['retry'=>$s]);}
 }
 /** 'email' | 'username' | 'public_id' | 'other' for a duplicate-key PDOException (1062), else null. The message is only inspected, never logged. */
 public static function duplicate(\PDOException $e):?string {
  if((int)($e->errorInfo[1]??0)!==1062)return null;
  // The key name ends the message ("... for key 'user_email'" in MariaDB, "'users.user_email'" in MySQL 8); the duplicate value before it is ignored.
  $key=preg_match("/for key '(?:[^'.]*\\.)?([A-Za-z0-9_]+)'\\s*$/D",(string)$e->getMessage(),$m)?$m[1]:'';
  return match($key){'user_profiles_username'=>'username','user_profiles_public_id'=>'public_id','user_email'=>'email',default=>'other'};
 }
 /** Lower-case e-mail of at most 254 characters, or 422. */
 public static function email(mixed $v):string {
  $e=is_string($v)?mb_strtolower(trim($v)):'';
  if($e===''||strlen($e)>254||!filter_var($e,FILTER_VALIDATE_EMAIL))throw new AppError('Podaj poprawny e-mail.');
  return $e;
 }
 /** 16 characters without look-alikes (0/O, 1/l/I), for passwords set by the Admin (§3.10). */
 public static function temporaryPassword():string{$a=self::TEMP_ALPHABET;$s='';for($i=0;$i<16;$i++)$s.=$a[random_int(0,strlen($a)-1)];return $s;}
 public static function audit(PDO $pdo,string $actor,string $action,?string $target,?string $note=null):void {
  $pdo->prepare('INSERT INTO account_audit (actor_id,action,target_user_id,note,created_at) VALUES (?,?,?,?,?)')->execute([$actor,$action,$target,$note,time()]);
 }
 /** Runs $fn in a transaction (rolled back on any error). */
 public static function tx(PDO $pdo,callable $fn):mixed{$pdo->beginTransaction();try{$out=$fn();$pdo->commit();return $out;}catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}}
 /** Whether a table exists in this database (optional tables of later migrations: chat). */
 public static function tableExists(PDO $pdo,string $table):bool{$q=$pdo->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');$q->execute([$table]);$v=$q->fetchColumn();$q->closeCursor();return $v!==false;}
 /**
  * Calls $class::$method of another slice when it exists, filling its parameters by type: PDO → $pdo, array → $c,
  * string/int (or untyped) → $userId, any other nullable parameter → null. Returns [called, result].
  */
 public static function bridge(string $class,string $method,PDO $pdo,array $c,string $userId):array {
  if(!class_exists($class)||!method_exists($class,$method))return [false,null];
  $args=[];
  foreach((new \ReflectionMethod($class,$method))->getParameters() as $p){
   $t=$p->getType();$n=$t instanceof \ReflectionNamedType?$t->getName():null;
   if($n===PDO::class||$n==='PDO')$args[]=$pdo;elseif($n==='array')$args[]=$c;elseif($n===null||in_array($n,['string','int','mixed'],true))$args[]=$userId;
   elseif($p->isDefaultValueAvailable())break;elseif($p->allowsNull())$args[]=null;else return [false,null];
  }
  return [true,$class::$method(...$args)];
 }

 // ---------------------------------------------------------------- sign-up (§3.6)
 /** Sign-up is open (signup_enabled) or the request carries the invite token (owner's test window, ≥ 24 characters). */
 public static function signupOpen(array $c,mixed $invite):bool {
  if(!empty($c['signup_enabled']))return true;$t=$c['signup_invite_token'];
  return is_string($t)&&strlen($t)>=24&&is_string($invite)&&hash_equals($t,$invite);
 }
 /** signup-begin {invite?}: 60 per hour per address; stores the server-side start time of the form. */
 public static function signupBegin(PDO $pdo,array $c,array $in):array {
  self::limit($pdo,$c,'signup-begin',ClientIp::bucket($c),60,3600);
  if(!self::signupOpen($c,$in['invite']??null))throw new AppError('Rejestracja jest chwilowo wyłączona.',404);
  $_SESSION['signup_at']=time();return ['ok'=>true];
 }
 /**
  * signup (§3.6): open check, limits per address (/64) and globally, bot trap and server-measured fill time (one
  * message for both), validation, one transaction users + user_profiles + billing_accounts (not exempt), then sign-in.
  */
 public static function signup(PDO $pdo,array $c,array $in):array {
  if(!self::signupOpen($c,$in['invite']??null))throw new AppError('Rejestracja jest chwilowo wyłączona.',404);
  $ip=ClientIp::bucket($c);
  foreach([['signup-ip-hour',$ip,(int)$c['signup_limit_ip_hour'],3600],['signup-ip-day',$ip,(int)$c['signup_limit_ip_day'],86400],['signup-global','all',(int)$c['signup_limit_global_hour'],3600]] as [$scope,$key,$limit,$window])
   if($s=RateLimit::hit($pdo,$c['app_key'],$scope,$key,$limit,$window)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób zakładania konta. Spróbuj ponownie później.',429,['retry'=>$s]);}
  $started=$_SESSION['signup_at']??null;$age=is_int($started)?time()-$started:-1;
  if(!in_array($in['website']??null,[null,''],true)||$age<self::SIGNUP_MIN_SECONDS||$age>self::SIGNUP_MAX_SECONDS)throw new AppError('Nie udało się założyć konta. Spróbuj ponownie.',400);
  $email=self::email($in['email']??null);$hash=Domain::password(is_string($in['password']??null)?$in['password']:'');$profile=Profiles::validate($in);
  $id=self::create($pdo,$email,$hash,$profile,['billing_exempt'=>0],time(),null);
  unset($_SESSION['signup_at']);$u=Accounts::find($pdo,$id);Auth::enter($u,$c);
  return ['user'=>Accounts::safe($u),'csrf'=>$_SESSION['csrf']];
 }
 /**
  * The rows of a new member in one transaction. Duplicates: e-mail → neutral 409 (signup) or the Admin's message, username
  * → 409, public_id collision → new id (3 tries). Returns the user id.
  */
 private static function create(PDO $pdo,string $email,string $hash,array $profile,array $billing,int $now,?int $resetAt,bool $admin=false):string {
  for($try=0;;$try++){
   $id=Domain::id();$publicId=Accounts::publicId();
   try{
    return self::tx($pdo,function()use($pdo,$id,$publicId,$email,$hash,$profile,$billing,$now,$resetAt){
     $pdo->prepare("INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES (?,NULL,?,'member',1,?,1)")->execute([$id,$email,$hash]);
     $cols=$profile+['user_id'=>$id,'public_id'=>$publicId,'created_at'=>$now,'updated_at'=>$now,'last_login_at'=>$resetAt===null?$now:null,'pw_reset_at'=>$resetAt];
     $pdo->prepare('INSERT INTO user_profiles ('.implode(',',array_keys($cols)).') VALUES ('.implode(',',array_fill(0,count($cols),'?')).')')->execute(array_values($cols));
     $b=$billing+['user_id'=>$id,'created_at'=>$now,'updated_at'=>$now];
     $pdo->prepare('INSERT INTO billing_accounts ('.implode(',',array_keys($b)).') VALUES ('.implode(',',array_fill(0,count($b),'?')).')')->execute(array_values($b));
     return $id;
    });
   }catch(\PDOException $e){
    $dup=self::duplicate($e);
    if($dup==='public_id'&&$try<2)continue;
    if($dup==='username')throw new AppError('Ta nazwa użytkownika jest zajęta.',409);
    if($dup==='email')throw $admin?new AppError('Konto z tym adresem e-mail już istnieje.',409):new AppError('Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.',409);
    throw $e;
   }
  }
 }
 /**
  * username-check {u, firstName?, lastName?} (§3.4): only signed in or within 2 h of signup-begin; 30 per 10 min per
  * session and 300 per 10 min per address. Suggestions only for 'taken' (at most 3 free ones). The caller's own name
  * counts as available.
  */
 public static function usernameCheck(PDO $pdo,array $c,?array $u,array $in):array {
  $started=$_SESSION['signup_at']??null;
  if(!$u&&!(is_int($started)&&time()-$started<=self::SIGNUP_MAX_SECONDS))throw new AppError('Najpierw rozpocznij rejestrację.',403);
  self::limit($pdo,$c,'username-session',(string)session_id(),(int)$c['username_check_limit_session'],600);
  self::limit($pdo,$c,'username-ip',ClientIp::bucket($c),(int)$c['username_check_limit_ip'],600);
  $status=Profiles::usernameStatus($in['u']??null);$name=(string)Profiles::normalizeUsername($in['u']??null);
  if($status==='valid')$status=Profiles::taken($pdo,$name,$u['id']??null)?'taken':'available';
  $first=$in['firstName']??null;$last=$in['lastName']??null;
  if($status==='taken'&&$u&&!is_string($first)){$p=Accounts::profile($pdo,$u['id']);$first=$p['first_name'];$last=$p['last_name'];}
  return ['status'=>$status,'suggestions'=>$status==='taken'?Profiles::suggestions($pdo,$first,$last,$name):[]];
 }

 // ---------------------------------------------------------------- own account (§3.8–§3.10)
 /** Password check with the login limits on the account's own e-mail; 422 for a wrong password. */
 private static function confirmPassword(PDO $pdo,array $c,array $u,mixed $password):void {
  Auth::reserveLogin($pdo,$c,$u['email']);
  if(!is_string($password)||!password_verify($password,$u['passwordHash']))throw new AppError('Nieprawidłowe obecne hasło.');
 }
 /** member-password {currentPassword,password}: 10 per hour; new hash, auth_version+1, pw_reset_at cleared, new session. */
 public static function password(PDO $pdo,array $c,array $u,array $in):array {
  self::limit($pdo,$c,'member-password',$u['id'],10,3600);self::confirmPassword($pdo,$c,$u,$in['currentPassword']??null);
  $hash=Domain::password(is_string($in['password']??null)?$in['password']:'');
  self::tx($pdo,function()use($pdo,$u,$hash){
   $pdo->prepare("UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute([$hash,$u['id']]);
   $pdo->prepare('UPDATE user_profiles SET pw_reset_at=NULL,updated_at=? WHERE user_id=?')->execute([time(),$u['id']]);
  });
  Auth::enter(Accounts::find($pdo,$u['id']),$c);return ['csrf'=>$_SESSION['csrf']];
 }
 /** member-email {currentPassword,email} (§3.9): 5 per hour; neutral 409; new session; Stripe customer updated afterwards. */
 public static function changeEmail(RouteContext $ctx,array $u,array $in):array {
  $pdo=$ctx->pdo();$c=$ctx->config;
  self::limit($pdo,$c,'member-email',$u['id'],5,3600);self::confirmPassword($pdo,$c,$u,$in['currentPassword']??null);
  $email=self::email($in['email']??null);
  self::setEmail($pdo,$u['id'],$email,'self','self.email');
  $fresh=Accounts::find($pdo,$u['id']);Auth::enter($fresh,$c);$out=['csrf'=>$_SESSION['csrf'],'user'=>Accounts::safe($fresh)];
  $ctx->releaseSession();self::pushEmail($pdo,$c,$u['id']);
  return $out;
 }
 private static function setEmail(PDO $pdo,string $userId,string $email,string $actor,string $action):void {
  try{self::tx($pdo,function()use($pdo,$userId,$email,$actor,$action){
   $pdo->prepare("UPDATE users SET email=?,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute([$email,$userId]);
   self::audit($pdo,$actor,$action,$userId);
  });}catch(\PDOException $e){if(self::duplicate($e))throw new AppError('Nie można użyć tego adresu e-mail.',409);throw $e;}
 }
 /** After an e-mail change: the Stripe customer gets the new address (billing-backend); a failure asks for a sync. */
 private static function pushEmail(PDO $pdo,array $c,string $userId):void {
  $row=Access::row($pdo,$userId);if(!$row||$row['stripe_customer_id']===null)return;
  try{[$called,$ok]=self::bridge('MatDraw\\Billing','pushCustomerEmail',$pdo,$c,$userId);if(!$called||$ok!==false)return;}
  catch(\Throwable $e){Routes::logThrowable($e,'MatDraw billing email');}
  $pdo->prepare('UPDATE billing_accounts SET next_sync_at=? WHERE user_id=?')->execute([time(),$userId]);
 }
 /** account-delete {password,endSubscription?} (§3.8): 5 per hour, password, then erase(); the session is cleared. */
 public static function deleteOwn(RouteContext $ctx,array $u,array $in):array {
  $pdo=$ctx->pdo();$c=$ctx->config;
  self::limit($pdo,$c,'account-delete',$u['id'],5,3600);self::confirmPassword($pdo,$c,$u,$in['password']??null);
  $ctx->releaseSession();
  self::erase($pdo,$c,$u['id'],'self','self.delete',($in['endSubscription']??false)===true);
  // The account is gone: open the session again (same id, no new file) to drop it and hand out a fresh CSRF token.
  if(session_status()!==PHP_SESSION_ACTIVE)Auth::start($c);
  Auth::clear();return ['ok'=>true,'csrf'=>$_SESSION['csrf']];
 }
 /**
  * Deletes a member account (§3.8, also the Admin's delete): forced payment sync, 409 confirmEnd while a subscription
  * runs and does not end (unless $endSubscription), Stripe customer deletion (failure → stripe_redact_pending=1),
  * chat messages to tombstones, then one transaction: mutes and profile deleted, users anonymised (kept for foreign
  * keys), billing_accounts kept as a tombstone without personal data, account_audit entry; finally the avatar directory.
  */
 public static function erase(PDO $pdo,array $c,string $userId,string $actor,string $action,bool $endSubscription):void {
  $row=Access::row($pdo,$userId);
  if($row&&$row['stripe_customer_id']!==null){
   try{self::bridge('MatDraw\\BillingSync','sync',$pdo,$c,$userId);}catch(\Throwable $e){Routes::logThrowable($e,'MatDraw billing sync');}
   $row=Access::row($pdo,$userId);
  }
  $running=$row&&in_array(Access::subStatus($row,$c),['active','trialing','past_due'],true)&&empty($row['cancel_at_period_end']);
  if($running&&!$endSubscription)throw new ApiError('Masz aktywną subskrypcję. Usunięcie konta zakończy ją od razu, bez zwrotu za bieżący okres.',409,['confirmEnd'=>true]);
  $redact=0;
  if($row&&$row['stripe_customer_id']!==null){
   try{[$called,$ok]=self::bridge('MatDraw\\Billing','deleteCustomer',$pdo,$c,$userId);$redact=!$called||$ok===false?1:0;}
   catch(\Throwable $e){Routes::logThrowable($e,'MatDraw billing delete');$redact=1;}
  }
  if(class_exists('MatDraw\\Chat')&&method_exists('MatDraw\\Chat','tombstoneUser'))Chat::tombstoneUser($pdo,$userId);
  $q=$pdo->prepare('SELECT public_id FROM user_profiles WHERE user_id=?');$q->execute([$userId]);$publicId=$q->fetchColumn();$q->closeCursor();
  $mutes=self::tableExists($pdo,'chat_mutes');$now=time();
  self::tx($pdo,function()use($pdo,$userId,$actor,$action,$redact,$mutes,$now){
   if($mutes)$pdo->prepare('DELETE FROM chat_mutes WHERE user_id=?')->execute([$userId]);
   $pdo->prepare('DELETE FROM user_profiles WHERE user_id=?')->execute([$userId]);
   $pdo->prepare("UPDATE users SET email=?,password_hash=?,active=0,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute(['deleted+'.$userId.'@invalid.matbravo',password_hash(bin2hex(random_bytes(24)),PASSWORD_DEFAULT),$userId]);
   $pdo->prepare('INSERT INTO billing_accounts (user_id,stripe_redact_pending,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE billing_exempt=0,exempt_reason=NULL,exempt_by=NULL,exempt_at=NULL,exempt_until=NULL,pending_checkout_id=NULL,pending_checkout_expires=NULL,next_sync_at=NULL,stripe_redact_pending=GREATEST(stripe_redact_pending,VALUES(stripe_redact_pending)),deleted_at=VALUES(deleted_at),updated_at=VALUES(updated_at)')->execute([$userId,$redact,$now,$now,$now]);
   self::audit($pdo,$actor,$action,$userId);
  });
  Avatars::removeOwner($c,is_string($publicId)?$publicId:null);
 }

 // ---------------------------------------------------------------- Admin panel (§4.3, §3.2, §3.10)
 /** One page of members (POST {q,filter,page}): prefix search on e-mail, username and last name, billing filters. */
 public static function adminList(PDO $pdo,array $c,array $in):array {
  $q=$in['q']??'';if(!is_string($q))$q='';$q=trim($q);if(mb_strlen($q)>100)throw new AppError('Wyszukiwana fraza jest za długa.');
  $filter=$in['filter']??'all';if(!in_array($filter,['all','paid','free','none','problem','muted'],true))throw new AppError('Nieznany filtr.');
  $page=$in['page']??1;$page=is_int($page)&&$page>=1&&$page<=100000?$page:1;
  $sql="SELECT u.id,u.email,u.active,p.username,p.first_name,p.last_name,p.country,p.created_at,p.last_login_at,b.user_id AS b_user,b.billing_exempt,b.exempt_reason,b.exempt_until,b.livemode,b.sub_status,b.current_period_start,b.current_period_end,b.cancel_at_period_end,b.sync_error,b.stripe_redact_pending
   FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.role='member' AND b.deleted_at IS NULL";
  $params=[];
  if($q!==''){
   // Literal prefix: ! escapes itself, % and _ (the same in MySQL and MariaDB, whatever NO_BACKSLASH_ESCAPES says).
   $like=strtr(mb_strtolower($q),['!'=>'!!','%'=>'!%','_'=>'!_']).'%';
   $sql.=" AND (u.email LIKE ? ESCAPE '!' OR p.username LIKE ? ESCAPE '!' OR p.last_name LIKE ? ESCAPE '!')";$params=[$like,$like,$like];
  }
  $st=$pdo->prepare($sql.' ORDER BY p.created_at DESC,u.id');$st->execute($params);$rows=$st->fetchAll(PDO::FETCH_ASSOC);
  $cfg=array_replace($c,['billing_enforce'=>true]);$now=time();$items=[];
  foreach($rows as $r){
   $billing=$r['b_user']===null?null:$r;$a=Access::compute($billing,['id'=>$r['id'],'role'=>'member'],$cfg,$now);
   $exempt=$a['state']==='free';$sub=Access::subStatus($billing,$c);
   $problem=in_array($a['state'],['past_due','processing'],true)||$sub==='unpaid'||!empty($r['stripe_redact_pending'])||($r['sync_error']??null)!==null;
   $keep=match($filter){'paid'=>in_array($a['state'],['active','ending','past_due'],true),'free'=>in_array($a['state'],['free','grace'],true),'none'=>in_array($a['state'],['none','ended'],true),'problem'=>$problem,default=>true};
   if($keep)$items[]=['id'=>$r['id'],'email'=>$r['email'],'username'=>$r['username'],'name'=>trim(($r['first_name']??'').' '.($r['last_name']??'')),'country'=>$r['country'],
    'createdAt'=>$r['created_at']===null?null:(int)$r['created_at'],'lastLoginAt'=>$r['last_login_at']===null?null:(int)$r['last_login_at'],'active'=>(bool)$r['active'],
    'billing'=>['state'=>$a['state'],'until'=>$a['until'],'exempt'=>$exempt,'reason'=>$exempt||$a['state']==='grace'?$r['exempt_reason']:null],'mutedUntil'=>null];
  }
  if($filter==='muted'){$muted=self::muted($pdo,array_column($items,'id'));$items=array_values(array_filter($items,fn($i)=>array_key_exists($i['id'],$muted)));}
  $total=count($items);$items=array_slice($items,($page-1)*self::PAGE,self::PAGE);
  $muted=$filter==='muted'?$muted:self::muted($pdo,array_column($items,'id'));
  foreach($items as &$i)$i['mutedUntil']=$muted[$i['id']]??null;
  unset($i);
  return ['total'=>$total,'page'=>$page,'items'=>$items];
 }
 /**
  * id => mutedUntil (int, or null for no end) of the muted accounts among $ids, via ChatModeration::mutedIds
  * (chat-backend). Accepts a list of ids or a map id => until|true|null|false from that method.
  */
 private static function muted(PDO $pdo,array $ids):array {
  if(!$ids||!class_exists('MatDraw\\ChatModeration')||!method_exists('MatDraw\\ChatModeration','mutedIds'))return [];
  $r=ChatModeration::mutedIds($pdo,array_values($ids));if(!is_array($r))return [];$out=[];$now=time();
  if(array_is_list($r)){foreach($r as $id)if(is_string($id))$out[$id]=null;return $out;}
  foreach($r as $id=>$until){if($until===false||(is_int($until)&&$until<=$now))continue;$out[(string)$id]=is_int($until)?$until:null;}
  return $out;
 }
 /** The member account $userId (any other role or an unknown id: 404 'Konto nie istnieje.'). */
 private static function target(PDO $pdo,mixed $userId):array {
  $u=is_string($userId)&&$userId!==''?Accounts::find($pdo,$userId):null;
  if(!$u||$u['role']!=='member')throw new AppError('Konto nie istnieje.',404);
  return $u;
 }
 /** admin-member {action,…}: create, active, password, email, profile, delete; members only, every action audited. */
 public static function adminAction(RouteContext $ctx,array $admin,array $in):array {
  $pdo=$ctx->pdo();$c=$ctx->config;$action=$in['action']??null;$now=time();
  if($action==='create'){
   $email=self::email($in['email']??null);$given=$in['password']??null;$temp=$given===null||$given===''?self::temporaryPassword():null;
   $hash=Domain::password($temp??(is_string($given)?$given:''));$profile=Profiles::validate($in);
   $billing=['billing_exempt'=>0];
   if(($in['free']??false)===true){
    $reason=Text::clean($in['reason']??'');if($reason===null||mb_strlen($reason)>200)Domain::txt(null,'powód',200);
    $billing=['billing_exempt'=>1,'exempt_reason'=>$reason===''?null:$reason,'exempt_by'=>$admin['id'],'exempt_at'=>$now,'exempt_until'=>self::until($in['until']??null,$now)];
   }
   $id=self::create($pdo,$email,$hash,$profile,$billing,$now,$temp===null?null:$now,true);
   self::audit($pdo,$admin['id'],'create',$id,($in['free']??false)===true?'free':null);
   return ['id'=>$id]+($temp===null?[]:['temporaryPassword'=>$temp]);
  }
  $u=self::target($pdo,$in['userId']??null);
  switch($action){
   case 'active':
    if(!is_bool($in['active']??null))throw new AppError('Niepoprawny formularz.',400);
    self::tx($pdo,function()use($pdo,$u,$in,$admin){$pdo->prepare("UPDATE users SET active=?,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute([$in['active']?1:0,$u['id']]);self::audit($pdo,$admin['id'],'active',$u['id'],$in['active']?'1':'0');});
    return ['id'=>$u['id'],'active'=>$in['active']];
   case 'password':
    $temp=self::temporaryPassword();$hash=Domain::password($temp);Accounts::ensureProfile($pdo,$u['id']);
    self::tx($pdo,function()use($pdo,$u,$hash,$admin,$now){
     $pdo->prepare("UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute([$hash,$u['id']]);
     $pdo->prepare('UPDATE user_profiles SET pw_reset_at=?,updated_at=? WHERE user_id=?')->execute([$now,$now,$u['id']]);
     self::audit($pdo,$admin['id'],'password.reset',$u['id']);
    });
    return ['id'=>$u['id'],'temporaryPassword'=>$temp];
   case 'email':
    $email=self::email($in['email']??null);self::setEmail($pdo,$u['id'],$email,$admin['id'],'email.change');
    $ctx->releaseSession();self::pushEmail($pdo,$c,$u['id']);
    return ['id'=>$u['id'],'email'=>$email];
   case 'profile':
    $fields=array_intersect_key($in,array_flip(['firstName','lastName','username','country','sports','clubText','showClub','nameDisplay']));
    if(!$fields)throw new AppError('Niepoprawny formularz.',400);
    $cols=Profiles::validate($fields,true);Accounts::ensureProfile($pdo,$u['id']);
    if(array_key_exists('username',$cols)&&$cols['username']!==null&&Profiles::taken($pdo,$cols['username'],$u['id']))throw new AppError('Ta nazwa użytkownika jest zajęta.',409);
    $cols['updated_at']=$now;
    try{self::tx($pdo,function()use($pdo,$u,$cols,$admin){
     $pdo->prepare('UPDATE user_profiles SET '.implode(',',array_map(fn($k)=>"$k=?",array_keys($cols))).' WHERE user_id=?')->execute([...array_values($cols),$u['id']]);
     self::audit($pdo,$admin['id'],'profile.fix',$u['id'],implode(',',array_diff(array_keys($cols),['updated_at'])));
    });}catch(\PDOException $e){if(self::duplicate($e)==='username')throw new AppError('Ta nazwa użytkownika jest zajęta.',409);throw $e;}
    return ['id'=>$u['id'],'profile'=>Profiles::own(Accounts::profile($pdo,$u['id']),$now)];
   case 'delete':
    $ctx->releaseSession();self::erase($pdo,$c,$u['id'],$admin['id'],'delete',($in['endSubscription']??false)===true);
    return ['id'=>$u['id'],'deleted'=>true];
  }
  throw new AppError('Nieznana operacja.',400);
 }
 /** End of a free period: null, a future epoch second, or 'YYYY-MM-DD' (end of that day, Europe/Warsaw). */
 private static function until(mixed $v,int $now):?int {
  if($v===null||$v==='')return null;
  $t=is_int($v)?$v:strtotime(Domain::date($v).' 23:59:59');
  if(!is_int($t)||$t<=$now)throw new AppError('Podaj poprawną datę.');
  return $t;
 }
}
