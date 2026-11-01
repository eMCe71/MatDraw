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
 * Roles of members (PLAN-REJESTRACJA-ROLE §4, §5.5, §6.6): users.organizer is the member's own switch (sign-up roles,
 * roles()), organizer_blocked_at and organizer_trusted_at/_by are set by the Administrator (adminAction organizer,
 * organizer-trust, organizer-bulk); an athlete profile of the account (profiles.owner_user_id) is created at sign-up
 * without the workspace lock (R19) and otherwise by the athlete routes. erase() forgets the community data of the account
 * (Domain::forgetMember) before the account itself. Accounts created while payments are not enforced carry the
 * free-signup exemption (§3.4), so switching to paid later is a decision about them.
 */
final class Members {
 private const TEMP_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
 public const PAGE=50,SIGNUP_MIN_SECONDS=3,SIGNUP_MAX_SECONDS=7200;
 /** §3.7: duplicate e-mails per network (/64) and hour before every sign-up from it gets 429; organizer roles switched on per network and day; own role changes per hour; accounts in one bulk action. */
 public const DUPLICATE_EMAILS_IP_HOUR=5,ORGANIZERS_IP_DAY=3,ROLES_HOUR=10,BULK_MAX=50;

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
 /**
  * Sign-up is open (signup_enabled) or, while it is off and payments are enforced, the request carries the invite token
  * (the owner's test window of the paid sign-up, ≥ 24 characters; PLAN-REJESTRACJA-ROLE §3.3: never a way around a
  * closed free sign-up). signup_force_off closes both (B6; Settings::effective also drops the token under it).
  */
 public static function signupOpen(array $c,mixed $invite):bool {
  if(!empty($c['signup_force_off']))return false;
  if(!empty($c['signup_enabled']))return true;$t=$c['signup_invite_token']??null;
  return !empty($c['billing_enforce'])&&is_string($t)&&strlen($t)>=24&&is_string($invite)&&hash_equals($t,$invite);
 }
 /** signup-begin {invite?}: 60 per hour per address; stores the server-side start time of the form. */
 public static function signupBegin(PDO $pdo,array $c,array $in):array {
  self::limit($pdo,$c,'signup-begin',ClientIp::bucket($c),60,3600);
  if(!self::signupOpen($c,$in['invite']??null))throw new AppError('Rejestracja jest chwilowo wyłączona.',404);
  $_SESSION['signup_at']=time();return ['ok'=>true];
 }
 /**
  * signup (§3.6): open check, attempt limits per address (/64), the global brake, bot trap and server-measured fill time
  * (one message for both), validation, one transaction users + user_profiles + billing_accounts (not exempt), then
  * sign-in. The global brake (signup_limit_global_hour, 0 = off) counts accounts created in the hour, not attempts: a
  * junk or bot-trap request costs only its own address's quota and can never block everybody else's sign-up.
  */
 public static function signup(PDO $pdo,array $c,array $in):array {
  if(!self::signupOpen($c,$in['invite']??null))throw new AppError('Rejestracja jest chwilowo wyłączona.',404);
  $ip=ClientIp::bucket($c);$global=(int)$c['signup_limit_global_hour'];
  foreach([['signup-ip-hour',$ip,(int)$c['signup_limit_ip_hour'],3600],['signup-ip-day',$ip,(int)$c['signup_limit_ip_day'],86400]] as [$scope,$key,$limit,$window])
   if($s=RateLimit::hit($pdo,$c['app_key'],$scope,$key,$limit,$window))self::tooManySignups($s);
  if($global>0&&($s=RateLimit::peek($pdo,$c['app_key'],'signup-global','all',$global,3600)))self::tooManySignups($s);
  // Duplicate e-mails (§3.7, PS-18): after 5 in an hour every sign-up from this network gets 429, whatever its outcome,
  // so the 409 of a taken address cannot be used to test addresses in bulk.
  if($s=RateLimit::peek($pdo,$c['app_key'],'signup-dup-ip',$ip,self::DUPLICATE_EMAILS_IP_HOUR,3600))self::tooManySignups($s);
  $started=$_SESSION['signup_at']??null;$age=is_int($started)?time()-$started:-1;
  if(!in_array($in['website']??null,[null,''],true)||$age<self::SIGNUP_MIN_SECONDS||$age>self::SIGNUP_MAX_SECONDS)throw new AppError('Nie udało się założyć konta. Spróbuj ponownie.',400);
  // Roles (§4.5): only the two booleans roles.organizer and roles.athlete; every other field of the body is ignored.
  $roles=is_array($in['roles']??null)?$in['roles']:[];$organizer=($roles['organizer']??null)===true;$athlete=($roles['athlete']??null)===true;
  // The organizer place of this network is reserved before the account is written and given back when the sign-up fails
  // (B14: parallel sign-ups could all pass a peek and exceed 3 per day).
  if($organizer)self::reserveOrganizer($pdo,$c,$ip);
  try{
   $email=self::email($in['email']??null);$hash=Domain::password(is_string($in['password']??null)?$in['password']:'');$profile=Profiles::validate($in);
   // The athlete is validated in full before any transaction and without the workspace lock (R19).
   $id=Domain::id();$now=time();$a=$athlete?self::athleteProfile($pdo,$id,is_array($in['athlete']??null)?$in['athlete']:[],$now):null;
   self::create($pdo,$email,$hash,$profile,self::freeSignup($c,$now),$now,null,false,['id'=>$id,'organizer'=>$organizer,
    'also'=>$a?static function()use($pdo,$a){self::insertAthlete($pdo,$a);}:null,
    // Counted when it happens, and over the limit the answer is 429 instead of the 409 (B14: parallel duplicates past a peek learn nothing).
    'duplicateEmail'=>static function()use($pdo,$c,$ip){if($s=RateLimit::hit($pdo,$c['app_key'],'signup-dup-ip',$ip,self::DUPLICATE_EMAILS_IP_HOUR,3600))self::tooManySignups($s);}]);
  }catch(\Throwable $e){if($organizer)RateLimit::refund($pdo,$c['app_key'],'organizer-enable-ip-day',$ip);throw $e;}
  if($global>0)RateLimit::hit($pdo,$c['app_key'],'signup-global','all',$global,3600);
  unset($_SESSION['signup_at']);$u=Accounts::find($pdo,$id);Auth::enter($u,$c);
  $caps=Accounts::sparseCaps(Actors::build($u,$organizer,null,null,$a?[['id'=>$a['profile']['id'],'archived'=>false,'relation'=>$a['profile']['relation']]]:[]));
  return ['user'=>Accounts::safe($u),'csrf'=>$_SESSION['csrf']]+($caps?['caps'=>$caps]:[])+(isset($a['notice'])?['notice'=>$a['notice']]:[]);
 }
 private static function tooManySignups(int $s):never{Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób zakładania konta. Spróbuj ponownie później.',429,['retry'=>$s]);}
 private static function tooManyOrganizers(int $s):never{Routes::retryAfter($s);throw new ApiError('Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.',429,['retry'=>$s]);}
 /** One of the ORGANIZERS_IP_DAY places of network $ip, taken atomically (RateLimit::hit) or 429 (the refused attempt is given back). */
 private static function reserveOrganizer(PDO $pdo,array $c,string $ip):void {
  if($s=RateLimit::hit($pdo,$c['app_key'],'organizer-enable-ip-day',$ip,self::ORGANIZERS_IP_DAY,86400)){RateLimit::refund($pdo,$c['app_key'],'organizer-enable-ip-day',$ip);self::tooManyOrganizers($s);}
 }
 /** billing_accounts of a new account (§3.4): free-signup while payments are not enforced, so the switch to paid later decides about it. */
 private static function freeSignup(array $c,int $now):array{return empty($c['billing_enforce'])?['billing_exempt'=>1,'exempt_reason'=>'free-signup','exempt_at'=>$now]:['billing_exempt'=>0];}
 /**
  * The athlete profile of a sign-up (§4.5, §6.1), validated before any transaction: Domain::athleteFields (422 with the
  * messages of athlete.save), then the club among the clubs read now (Clubs::pick, the quotas of new clubs counted on
  * them; a used-up quota gives 'unaffiliated' with the pending name). Returns {profile, newClub, notice}; the profile has
  * the shape of athlete.save.
  */
 private static function athleteProfile(PDO $pdo,string $userId,array $in,int $now):array {
  $f=Domain::athleteFields($in,date('Y-m-d'));Clubs::ensure($pdo);
  $clubs=array_map([Clubs::class,'fromRow'],$pdo->query('SELECT id,name,verified,created_by,created_at,merged_into FROM clubs')->fetchAll(PDO::FETCH_ASSOC));
  $u=['id'=>$userId,'role'=>'member'];$pick=Clubs::pick($clubs,$u,$f['club'],$now,Clubs::counts($clubs,$u,$now));
  $a=['id'=>Domain::id(),'ownerId'=>$userId,'createdBy'=>$userId,'createdAt'=>$now,'archived'=>false,'name'=>$f['name'],'clubId'=>$pick['clubId'],'birthDate'=>$f['birthDate'],'sex'=>$f['sex'],'weight'=>$f['weight'],'height'=>$f['height'],'gradeType'=>$f['gradeType'],'grade'=>$f['grade'],'events'=>['forms'],'champion'=>false,'relation'=>$f['relation']];
  if(isset($pick['pendingClubName']))$a['pendingClubName']=$pick['pendingClubName'];if($f['relation']==='guardian')$a['guardianDeclaredAt']=$now;
  return ['profile'=>$a,'newClub'=>$pick['newClub']??null,'notice'=>$pick['notice']??null];
 }
 /**
  * Inside the sign-up transaction: the new club (a plain INSERT; a name that collides under the collation, e.g. a parallel
  * sign-up or ß/ss, takes the existing club or its merge target instead) and the profiles row (Repository::profileRow,
  * revision stamp 0: no workspace lock, the global revision does not change).
  */
 private static function insertAthlete(PDO $pdo,array $x):void {
  $a=$x['profile'];$club=$x['newClub'];
  if($club){
   try{$pdo->prepare('INSERT INTO clubs (id,name,verified,created_by,created_at,merged_into) VALUES (?,?,0,?,?,NULL)')->execute([$club['id'],$club['name'],$club['createdBy'],$club['createdAt']]);}
   catch(\PDOException $e){
    if((int)($e->errorInfo[1]??0)!==1062)throw $e;
    $q=$pdo->prepare('SELECT id FROM clubs WHERE name=?');$q->execute([$club['name']]);$existing=$q->fetchColumn();$q->closeCursor();if(!is_string($existing))throw $e;
    $all=array_map([Clubs::class,'fromRow'],$pdo->query('SELECT id,name,verified,created_by,created_at,merged_into FROM clubs')->fetchAll(PDO::FETCH_ASSOC));
    $a['clubId']=Clubs::resolve($all,$existing)['id']??$existing;
   }
  }
  $row=Repository::profileRow($a);$pdo->prepare('INSERT INTO profiles ('.implode(',',array_keys($row)).') VALUES ('.implode(',',array_fill(0,count($row),'?')).')')->execute(array_values($row));
 }
 /**
  * The rows of a new member in one transaction. Duplicates: e-mail → neutral 409 (signup) or the Admin's message, username
  * → 409, public_id collision → new id (3 tries). Returns the user id. $o: id (fixed user id), organizer (users.organizer),
  * also (callable run last inside the transaction: the athlete of a sign-up), duplicateEmail (callable before the 409).
  */
 private static function create(PDO $pdo,string $email,string $hash,array $profile,array $billing,int $now,?int $resetAt,bool $admin=false,array $o=[]):string {
  for($try=0;;$try++){
   $id=$o['id']??Domain::id();$publicId=Accounts::publicId();$organizer=!empty($o['organizer'])?1:0;$also=$o['also']??null;
   try{
    return self::tx($pdo,function()use($pdo,$id,$publicId,$email,$hash,$profile,$billing,$now,$resetAt,$organizer,$also){
     $pdo->prepare("INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version,organizer) VALUES (?,NULL,?,'member',1,?,1,?)")->execute([$id,$email,$hash,$organizer]);
     $cols=$profile+['user_id'=>$id,'public_id'=>$publicId,'created_at'=>$now,'updated_at'=>$now,'last_login_at'=>$resetAt===null?$now:null,'pw_reset_at'=>$resetAt];
     $pdo->prepare('INSERT INTO user_profiles ('.implode(',',array_keys($cols)).') VALUES ('.implode(',',array_fill(0,count($cols),'?')).')')->execute(array_values($cols));
     $b=$billing+['user_id'=>$id,'created_at'=>$now,'updated_at'=>$now];
     $pdo->prepare('INSERT INTO billing_accounts ('.implode(',',array_keys($b)).') VALUES ('.implode(',',array_fill(0,count($b),'?')).')')->execute(array_values($b));
     if($also)$also();
     return $id;
    });
   }catch(\PDOException $e){
    $dup=self::duplicate($e);
    if($dup==='public_id'&&$try<2)continue;
    if($dup==='username')throw new AppError('Ta nazwa użytkownika jest zajęta.',409);
    if($dup==='email'){if(isset($o['duplicateEmail']))($o['duplicateEmail'])();throw $admin?new AppError('Konto z tym adresem e-mail już istnieje.',409):new AppError('Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.',409);}
    throw $e;
   }
  }
 }
 /**
  * username-check {u, firstName?, lastName?, nameDisplay?} (§3.4): only signed in or within 2 h of signup-begin; 30 per
  * 10 min per session and 300 per 10 min per address. Suggestions only for 'taken' (at most 3 free ones), without the
  * full surname unless nameDisplay is 'full' (Profiles::suggestions). The caller's own name counts as available.
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
  return ['status'=>$status,'suggestions'=>$status==='taken'?Profiles::suggestions($pdo,$first,$last,$name,3,$in['nameDisplay']??null):[]];
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
  * runs and does not end (unless $endSubscription), deletion of every Stripe customer of the account (failure →
  * stripe_redact_pending=1), the community data of the account (Domain::forgetMember, see below),
  * then one transaction: chat messages to tombstones, mutes and profile deleted, users anonymised (kept for foreign
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
  // customer_seq > 0: a customer was replaced, so an older one may still exist even when the row names none any more;
  // deleteCustomer deletes every customer the account ever had.
  if($row&&($row['stripe_customer_id']!==null||(int)$row['customer_seq']>0)){
   try{[$called,$ok]=self::bridge('MatDraw\\Billing','deleteCustomer',$pdo,$c,$userId);$redact=!$called||$ok===false?1:0;}
   catch(\Throwable $e){Routes::logThrowable($e,'MatDraw billing delete');$redact=1;}
  }
  // Community data first (PLAN-REJESTRACJA-ROLE §6.6, DR-2, DR-3), in a workspace transaction only when there is some:
  // owned athlete profiles are forgotten; as organizer, upcoming tournaments are hidden by 'system' (self-entries of
  // others detached) and created profiles forgotten. Always ends (entries in brackets with results stay, anonymised);
  // idempotent, so a deletion retried after an error repeats it harmlessly.
  $q=$pdo->prepare('SELECT 1 FROM profiles WHERE owner_user_id=? UNION ALL SELECT 1 FROM profiles WHERE created_by=? UNION ALL SELECT 1 FROM tournaments WHERE created_by=? LIMIT 1');
  $q->execute([$userId,$userId,$userId]);$community=$q->fetchColumn()!==false;$q->closeCursor();
  if($community)(new Repository($pdo))->transaction(fn(array &$db)=>Domain::forgetMember($db,$userId));
  $q=$pdo->prepare('SELECT public_id FROM user_profiles WHERE user_id=?');$q->execute([$userId]);$publicId=$q->fetchColumn();$q->closeCursor();
  $mutes=self::tableExists($pdo,'chat_mutes');$now=time();
  // Hashed before the transaction: tombstoneUser holds chat_channels rows FOR UPDATE until commit, and bcrypt/Argon2 must not stretch that.
  $dead=password_hash(bin2hex(random_bytes(24)),PASSWORD_DEFAULT);
  self::tx($pdo,function()use($pdo,$userId,$actor,$action,$redact,$mutes,$now,$dead){
   // Chat::tombstoneUser joins this transaction (it begins its own only outside one): messages and account go together.
   if(class_exists('MatDraw\\Chat')&&method_exists('MatDraw\\Chat','tombstoneUser'))Chat::tombstoneUser($pdo,$userId);
   if($mutes)$pdo->prepare('DELETE FROM chat_mutes WHERE user_id=?')->execute([$userId]);
   $pdo->prepare('DELETE FROM user_profiles WHERE user_id=?')->execute([$userId]);
   $pdo->prepare("UPDATE users SET email=?,password_hash=?,active=0,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute(['deleted+'.$userId.'@invalid.matbravo',$dead,$userId]);
   $pdo->prepare('INSERT INTO billing_accounts (user_id,stripe_redact_pending,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE billing_exempt=0,exempt_reason=NULL,exempt_by=NULL,exempt_at=NULL,exempt_until=NULL,pending_checkout_id=NULL,pending_checkout_expires=NULL,next_sync_at=NULL,stripe_redact_pending=GREATEST(stripe_redact_pending,?),deleted_at=?,updated_at=?')->execute([$userId,$redact,$now,$now,$now,$redact,$now,$now]);
   self::audit($pdo,$actor,$action,$userId);
  });
  Avatars::removeOwner($c,is_string($publicId)?$publicId:null);
 }

 // ---------------------------------------------------------------- Admin panel (§4.3, §3.2, §3.10)
 /**
  * One page of members (POST {q,filter,page,ownerOf?}): prefix search on e-mail, username and last name; billing filters
  * and the role filters of PLAN-REJESTRACJA-ROLE §5.5 (organizers: the role switched on or blocked; organizers-pending:
  * switched on, not blocked, not confirmed, active; athletes: a profile of the account that is not archived;
  * free-signup: the exemption of the free sign-up period); ownerOf=<tournament id>: the member who created it. Items get
  * the sparse fields caps (when one is true), tournaments (created, when any), upcomingTournaments (dated today or later
  * and not hidden: exactly those that hideTournaments() would hide, when any; F3), freeSignup and trusted (when true), so
  * members without a role keep the item shape of the panel.
  */
 public static function adminList(PDO $pdo,array $c,array $in):array {
  $q=$in['q']??'';if(!is_string($q))$q='';$q=trim($q);if(mb_strlen($q)>100)throw new AppError('Wyszukiwana fraza jest za długa.');
  $filter=$in['filter']??'all';if(!in_array($filter,['all','paid','free','none','problem','muted','organizers','organizers-pending','athletes','free-signup'],true))throw new AppError('Nieznany filtr.');
  $page=$in['page']??1;$page=is_int($page)&&$page>=1&&$page<=100000?$page:1;
  $owner=$in['ownerOf']??null;if($owner!==null&&(!is_string($owner)||!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$owner)))throw new AppError('Niepoprawny formularz.',400);
  $sql="SELECT u.id,u.email,u.active,u.organizer,u.organizer_blocked_at,u.organizer_trusted_at,(SELECT COUNT(*) FROM tournaments t WHERE t.created_by=u.id) AS t_count,(SELECT COUNT(*) FROM tournaments t WHERE t.created_by=u.id AND t.event_date>=? AND t.hidden_by IS NULL) AS t_upcoming,EXISTS(SELECT 1 FROM profiles pr WHERE pr.owner_user_id=u.id AND pr.archived=0) AS athlete,
   p.username,p.first_name,p.last_name,p.country,p.created_at,p.last_login_at,b.user_id AS b_user,b.billing_exempt,b.exempt_reason,b.exempt_until,b.livemode,b.sub_status,b.current_period_start,b.current_period_end,b.cancel_at_period_end,b.sync_error,b.stripe_redact_pending
   FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.role='member' AND b.deleted_at IS NULL".($owner!==null?' AND u.id=(SELECT t.created_by FROM tournaments t WHERE t.id=?)':'');
  $params=$owner!==null?[date('Y-m-d'),$owner]:[date('Y-m-d')];
  if($q!==''){
   // Literal prefix: ! escapes itself, % and _ (the same in MySQL and MariaDB, whatever NO_BACKSLASH_ESCAPES says).
   $like=strtr(mb_strtolower($q),['!'=>'!!','%'=>'!%','_'=>'!_']).'%';
   // username is ascii_bin: a phrase outside ASCII cannot match it, and comparing it would be error 1267 (mix of collations).
   $ascii=!preg_match('/[^\x00-\x7F]/',$like);
   $sql.=" AND (u.email LIKE ? ESCAPE '!'".($ascii?" OR p.username LIKE ? ESCAPE '!'":'')." OR p.last_name LIKE ? ESCAPE '!')";$params=[...$params,...($ascii?[$like,$like,$like]:[$like,$like])];
  }
  $st=$pdo->prepare($sql.' ORDER BY p.created_at DESC,u.id');$st->execute($params);$rows=$st->fetchAll(PDO::FETCH_ASSOC);
  $cfg=array_replace($c,['billing_enforce'=>true]);$now=time();$items=[];
  foreach($rows as $r){
   $billing=$r['b_user']===null?null:$r;$a=Access::compute($billing,['id'=>$r['id'],'role'=>'member'],$cfg,$now);
   $exempt=$a['state']==='free';$sub=Access::subStatus($billing,$c);
   $problem=in_array($a['state'],['past_due','processing'],true)||$sub==='unpaid'||!empty($r['stripe_redact_pending'])||($r['sync_error']??null)!==null;
   $caps=self::caps($r);$free=!empty($r['billing_exempt'])&&$r['exempt_reason']==='free-signup';$tournaments=(int)$r['t_count'];$upcoming=(int)$r['t_upcoming'];
   $keep=match($filter){'paid'=>in_array($a['state'],['active','ending','past_due'],true),'free'=>in_array($a['state'],['free','grace'],true),'none'=>in_array($a['state'],['none','ended'],true),'problem'=>$problem,
    'organizers'=>!empty($r['organizer'])||$caps['organizerBlocked'],'organizers-pending'=>$caps['organizer']&&!$caps['organizerTrusted']&&!empty($r['active']),'athletes'=>$caps['athlete'],'free-signup'=>$free,default=>true};
   if($keep)$items[]=['id'=>$r['id'],'email'=>$r['email'],'username'=>$r['username'],'name'=>trim(($r['first_name']??'').' '.($r['last_name']??'')),'country'=>$r['country'],
    'createdAt'=>$r['created_at']===null?null:(int)$r['created_at'],'lastLoginAt'=>$r['last_login_at']===null?null:(int)$r['last_login_at'],'active'=>(bool)$r['active'],
    'billing'=>['state'=>$a['state'],'until'=>$a['until'],'exempt'=>$exempt,'reason'=>$exempt||$a['state']==='grace'?$r['exempt_reason']:null],'muted'=>false,'mutedUntil'=>null]
    +(in_array(true,$caps,true)?['caps'=>$caps]:[])+($tournaments>0?['tournaments'=>$tournaments]:[])+($upcoming>0?['upcomingTournaments'=>$upcoming]:[])+($free?['freeSignup'=>true]:[])+($caps['organizerTrusted']?['trusted'=>true]:[]);
  }
  if($filter==='muted'){$muted=self::muted($pdo,array_column($items,'id'));$items=array_values(array_filter($items,fn($i)=>array_key_exists($i['id'],$muted)));}
  $total=count($items);$items=array_slice($items,($page-1)*self::PAGE,self::PAGE);
  $muted=$filter==='muted'?$muted:self::muted($pdo,array_column($items,'id'));
  foreach($items as &$i){$i['muted']=array_key_exists($i['id'],$muted);$i['mutedUntil']=$muted[$i['id']]??null;}
  unset($i);
  return ['total'=>$total,'page'=>$page,'items'=>$items];
 }
 /**
  * id => mutedUntil (int, or null for no end) of the muted accounts among $ids (items carry muted:true for both, so a
  * mute without an end differs from no mute), via ChatModeration::mutedIds
  * (chat-backend). Accepts a list of ids or a map id => until|true|null|false from that method.
  */
 private static function muted(PDO $pdo,array $ids):array {
  if(!$ids||!class_exists('MatDraw\\ChatModeration')||!method_exists('MatDraw\\ChatModeration','mutedIds'))return [];
  $r=ChatModeration::mutedIds($pdo,array_values($ids));if(!is_array($r))return [];$out=[];$now=time();
  if(array_is_list($r)){foreach($r as $id)if(is_string($id))$out[$id]=null;return $out;}
  foreach($r as $id=>$until){if($until===false||(is_int($until)&&$until<=$now))continue;$out[(string)$id]=is_int($until)?$until:null;}
  return $out;
 }
 /**
  * The member account $userId (any other role or an unknown id: 404 'Konto nie istnieje.'). A deleted account (billing
  * tombstone with deleted_at, §3.8) is gone too: 404, except for a repeated 'delete', which answers as done ($deleted).
  */
 private static function target(PDO $pdo,mixed $userId,bool &$deleted=false):array {
  $u=is_string($userId)&&$userId!==''?Accounts::find($pdo,$userId):null;
  if(!$u||$u['role']!=='member')throw new AppError('Konto nie istnieje.',404);
  $q=$pdo->prepare('SELECT deleted_at FROM billing_accounts WHERE user_id=?');$q->execute([$u['id']]);$gone=$q->fetchColumn();$q->closeCursor();
  $deleted=$gone!==false&&$gone!==null;
  return $u;
 }
 /**
  * admin-member {action,…}: create (organizer?), active (hideTournaments?), password, email, profile, delete, organizer
  * {blocked, hideTournaments?}, organizer-trust {trusted}, organizer-bulk; members only, every action audited.
  */
 public static function adminAction(RouteContext $ctx,array $admin,array $in):array {
  $pdo=$ctx->pdo();$c=$ctx->config;$action=$in['action']??null;$now=time();
  if($action==='create'){
   $email=self::email($in['email']??null);$given=$in['password']??null;$temp=$given===null||$given===''?self::temporaryPassword():null;
   $hash=Domain::password($temp??(is_string($given)?$given:''));$profile=Profiles::validate($in);
   // Without "free": the free-signup exemption while payments are not enforced (§3.4), else not exempt as before.
   $billing=self::freeSignup($c,$now);$free=($in['free']??false)===true;$organizer=($in['organizer']??false)===true;
   if($free){
    $reason=Text::clean($in['reason']??'');if($reason===null||mb_strlen($reason)>200)Domain::txt(null,'powód',200);
    $billing=['billing_exempt'=>1,'exempt_reason'=>$reason===''?null:$reason,'exempt_by'=>$admin['id'],'exempt_at'=>$now,'exempt_until'=>self::until($in['until']??null,$now)];
   }elseif(!empty($billing['billing_exempt']))$billing['exempt_by']=$admin['id'];
   $id=self::create($pdo,$email,$hash,$profile,$billing,$now,$temp===null?null:$now,true,['organizer'=>$organizer]);
   $note=trim(($free?'free':(!empty($billing['billing_exempt'])?'free-signup':'')).($organizer?' organizer':''));
   self::audit($pdo,$admin['id'],'create',$id,$note===''?null:$note);
   return ['id'=>$id]+($temp===null?[]:['temporaryPassword'=>$temp]);
  }
  if($action==='organizer-bulk')return self::organizerBulk($pdo,$admin,$in);
  $deleted=false;$u=self::target($pdo,$in['userId']??null,$deleted);
  if($deleted){if($action==='delete')return ['id'=>$u['id'],'deleted'=>true];throw new AppError('Konto nie istnieje.',404);}
  switch($action){
   case 'active':
    if(!is_bool($in['active']??null))throw new AppError('Niepoprawny formularz.',400);
    // Blocking the account may hide the person's upcoming tournaments too (§5.5), in a second transaction; the reason is
    // checked before the first one, so a bad reason changes nothing.
    $hide=!$in['active']&&($in['hideTournaments']??false)===true;$reason=$hide?self::hideReason($in['reason']??null):'';
    self::setActive($pdo,$admin,$u['id'],$in['active']);
    return ['id'=>$u['id'],'active'=>$in['active']]+($hide?['hidden'=>self::hideTournaments($pdo,$admin,$u['id'],$reason)]:[]);
   case 'organizer':
    // Take the organizer role away or give it back (§5.5); the person cannot switch it on while blocked.
    if(!is_bool($in['blocked']??null))throw new AppError('Niepoprawny formularz.',400);
    $hide=$in['blocked']&&($in['hideTournaments']??false)===true;$reason=$hide?self::hideReason($in['reason']??null):'';
    self::blockOrganizer($pdo,$admin,$u['id'],$in['blocked']);
    $hidden=$hide?['hidden'=>self::hideTournaments($pdo,$admin,$u['id'],$reason)]:[];
    return ['id'=>$u['id'],'caps'=>Actors::of($pdo,$u)['caps']]+$hidden;
   case 'organizer-trust':
    // Confirm an organizer or take the confirmation back (R16): home page, chat lobby and self-entries of minors.
    if(!is_bool($in['trusted']??null))throw new AppError('Niepoprawny formularz.',400);
    self::tx($pdo,function()use($pdo,$u,$in,$admin,$now){
     $pdo->prepare("UPDATE users SET organizer_trusted_at=?,organizer_trusted_by=? WHERE id=? AND role='member'")->execute($in['trusted']?[$now,$admin['id'],$u['id']]:[null,null,$u['id']]);
     self::audit($pdo,$admin['id'],$in['trusted']?'organizer.trust':'organizer.untrust',$u['id']);
    });
    return ['id'=>$u['id'],'caps'=>Actors::of($pdo,$u)['caps']];
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
 /** active of a member account: auth_version+1 ends every session; audited. */
 private static function setActive(PDO $pdo,array $admin,string $userId,bool $active):void {
  self::tx($pdo,function()use($pdo,$admin,$userId,$active){$pdo->prepare("UPDATE users SET active=?,auth_version=auth_version+1 WHERE id=? AND role='member'")->execute([$active?1:0,$userId]);self::audit($pdo,$admin['id'],'active',$userId,$active?'1':'0');});
 }
 /** organizer_blocked_at = now (the role is taken away; commands read it again under the workspace lock) or NULL; audited organizer.block / organizer.unblock. */
 private static function blockOrganizer(PDO $pdo,array $admin,string $userId,bool $blocked):void {
  self::tx($pdo,function()use($pdo,$admin,$userId,$blocked){
   $pdo->prepare("UPDATE users SET organizer_blocked_at=? WHERE id=? AND role='member'")->execute([$blocked?time():null,$userId]);
   self::audit($pdo,$admin['id'],$blocked?'organizer.block':'organizer.unblock',$userId);
  });
 }
 /** The reason of the Administrator's tournament.hide, checked as Domain checks it (422) before the block or deactivation commits. */
 private static function hideReason(mixed $v):string{$r=Text::clean($v??'');if($r===null||mb_strlen($r)>200)throw new AppError('Sprawdź pole: powód.');return $r;}
 /**
  * tournament.hide with withdrawSelf (§5.5) for every upcoming tournament (date ≥ today) of $userId that is not hidden yet,
  * in one workspace transaction as the Administrator, each audited like the command; returns how many were hidden.
  * $reason is already checked (hideReason).
  */
 private static function hideTournaments(PDO $pdo,array $admin,string $userId,string $reason):int {
  $today=date('Y-m-d');
  return (new Repository($pdo))->transaction(function(array &$db)use($pdo,$admin,$userId,$reason,$today):int{
   $n=0;
   foreach($db['tournaments'] as $t){
    if($t['createdBy']!==$userId||$t['date']<$today||($t['hiddenBy']??null)!==null)continue;
    Domain::execute($db,$admin['id'],'tournament.hide',['tournamentId'=>$t['id'],'hidden'=>true,'withdrawSelf'=>true,'reason'=>$reason],$db['revision']);
    self::audit($pdo,$admin['id'],'tournament.hide',$userId,mb_substr('hidden '.$t['id'].' · '.$t['name'],0,200));$n++;
   }
   return $n;
  });
 }
 /**
  * organizer-bulk {userIds:[…≤50], block?:true, hideTournaments?:bool, deactivate?:bool} (§5.5): for each member account
  * the role block (or its removal with block:false), then its upcoming tournaments hidden and the account blocked when
  * asked, each in its own transactions; one account failing never stops the others (a server error, e.g. a deadlock, is
  * logged and listed like a refusal). The reason is checked once, before any account. {done:[ids], failed:[{id,error}]}.
  */
 private static function organizerBulk(PDO $pdo,array $admin,array $in):array {
  $ids=$in['userIds']??null;
  if(!is_array($ids)||!array_is_list($ids)||!$ids||count($ids)>self::BULK_MAX||array_filter($ids,fn($x)=>!is_string($x))||array_filter([$in['block']??true,$in['hideTournaments']??false,$in['deactivate']??false],fn($x)=>!is_bool($x)))throw new AppError('Niepoprawny formularz.',400);
  $block=($in['block']??true)===true;$hide=$block&&($in['hideTournaments']??false)===true;$deactivate=($in['deactivate']??false)===true;$done=[];$failed=[];
  $reason=$hide?self::hideReason($in['reason']??null):'';
  foreach(array_values(array_unique($ids)) as $id){
   try{
    $deleted=false;$u=self::target($pdo,$id,$deleted);if($deleted)throw new AppError('Konto nie istnieje.',404);
    self::blockOrganizer($pdo,$admin,$u['id'],$block);if($hide)self::hideTournaments($pdo,$admin,$u['id'],$reason);if($deactivate)self::setActive($pdo,$admin,$u['id'],false);
    $done[]=$u['id'];
   }catch(AppError $e){$failed[]=['id'=>$id,'error'=>$e->getMessage()];}
   catch(\Throwable $e){Routes::logThrowable($e,'MatDraw organizer-bulk');$failed[]=['id'=>$id,'error'=>'Błąd serwera. Skontaktuj się z Administratorem.'];}
  }
  return ['done'=>$done,'failed'=>$failed];
 }
 /** caps (§8.2) from a users row with organizer, organizer_blocked_at, organizer_trusted_at and athlete (a profile of the account that is not archived), as Actors::build. */
 private static function caps(array $r):array{return ['organizer'=>!empty($r['organizer'])&&$r['organizer_blocked_at']===null,'organizerBlocked'=>$r['organizer_blocked_at']!==null,'organizerTrusted'=>$r['organizer_trusted_at']!==null,'athlete'=>!empty($r['athlete'])];}
 /** Organizers waiting for the Administrator's confirmation (§5.5 queue, the nav badge of me): the role on, not blocked, not confirmed, account active. */
 public static function pendingOrganizers(PDO $pdo):int{return (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role='member' AND organizer=1 AND organizer_blocked_at IS NULL AND organizer_trusted_at IS NULL AND active=1")->fetchColumn();}
 /**
  * roles {organizer:bool} (§4.5): the member's own organizer switch, 10 changes per hour. Switching on: 403 while the
  * Administrator blocks the role, 3 per day per network (/64, shared with the sign-up). Switching off: 409 while the
  * account has tournaments with open or closed registration, checked and written under the workspace lock, so a command
  * running at the same time cannot add one. Audited as self.organizer (on/off). Returns {caps}.
  */
 public static function roles(PDO $pdo,array $c,array $u,array $in):array {
  if(!is_bool($in['organizer']??null))throw new AppError('Niepoprawny formularz.',400);
  if($s=RateLimit::hit($pdo,$c['app_key'],'roles',$u['id'],self::ROLES_HOUR,3600)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele zmian ról. Spróbuj ponownie później.',429,['retry'=>$s]);}
  $actor=Actors::of($pdo,$u);$on=$in['organizer'];
  if($on&&$actor['caps']['organizerBlocked'])throw new AppError('Administrator wyłączył Ci rolę organizatora.',403);
  if($on===$actor['organizer'])return ['caps'=>$actor['caps']];
  // B10: the role is gained only while sign-up is open (Settings::rolesOpen); switching it off always works.
  if($on&&!Settings::rolesOpen($c))throw new AppError('Role są dostępne po otwarciu rejestracji.',403);
  if($on){
   $ip=ClientIp::bucket($c);self::reserveOrganizer($pdo,$c,$ip);
   try{self::tx($pdo,function()use($pdo,$u){$pdo->prepare("UPDATE users SET organizer=1 WHERE id=? AND role='member' AND organizer_blocked_at IS NULL")->execute([$u['id']]);self::audit($pdo,'self','self.organizer',$u['id'],'on');});}
   catch(\Throwable $e){RateLimit::refund($pdo,$c['app_key'],'organizer-enable-ip-day',$ip);throw $e;}
  }else self::tx($pdo,function()use($pdo,$u){
   $pdo->query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE')->fetchAll();
   $q=$pdo->prepare("SELECT 1 FROM tournaments WHERE created_by=? AND status IN ('open','closed') LIMIT 1");$q->execute([$u['id']]);$running=$q->fetchColumn()!==false;$q->closeCursor();
   if($running)throw new AppError('Masz turnieje z otwartymi lub zamkniętymi zapisami. Zakończ je albo przełącz na roboczy, zanim wyłączysz rolę organizatora.',409);
   $pdo->prepare("UPDATE users SET organizer=0 WHERE id=? AND role='member'")->execute([$u['id']]);self::audit($pdo,'self','self.organizer',$u['id'],'off');
  });
  return ['caps'=>Actors::of($pdo,$u)['caps']];
 }
 /** End of a free period: null, a future epoch second, or 'YYYY-MM-DD' (end of that day, Europe/Warsaw). */
 private static function until(mixed $v,int $now):?int {
  if($v===null||$v==='')return null;
  $t=is_int($v)?$v:strtotime(Domain::date($v).' 23:59:59');
  if(!is_int($t)||$t<=$now)throw new AppError('Podaj poprawną datę.');
  return $t;
 }
}
