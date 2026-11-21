<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * The Administrator's permission matrix (panel "Uprawnienia"): rows are account types, columns are permissions, every
 * editable cell is a checkbox. dist/permissions.js mirrors TYPES, PERMS, EDITABLE, FIXED and allows()
 * (tests/permissions.test.mjs compares both through tests/php-bridge-permissions.php).
 *
 * Account types: admin, editor, club (users.role); organizer, athlete, guardian, member are kinds of a member account
 * (organizer: Domain::organizer; athlete/guardian: an own athlete profile with relation self/guardian; member: a member
 * account with none of these); guest is a visitor who is not signed in.
 *
 * The matrix only narrows what the code already allows: an editable cell is switched on by default and switching it off
 * takes that ability away; a fixed cell (FIXED) cannot change, so the Administrator never locks themselves out and no
 * account type gains an ability the code was not built for. Without a stored matrix every answer is the behaviour of the
 * release before the panel (a fresh deploy changes nothing).
 *
 * Disciplines: permissions with scope 'sport' may differ per martial art (Sports::FEDERATIONS). A sport without its own
 * set inherits the global one; a sport with its own set holds every sport-scoped editable cell. 'global' permissions
 * (athletes, moderation, administration) have one value for all sports.
 *
 * Storage: the key 'permissions' of the existing app_settings row (migration 0008; Settings keeps unknown keys), so no
 * migration is needed and the settings version is not touched: {v, global:{type:{perm:bool}}, sports:{slug:{type:{perm:bool}}}, at, by}.
 * Settings::effective() puts the normalized matrix (or nothing) into the effective configuration ('permissions'),
 * Settings::flags() hands it to Domain as $db['flags']['perms'], and the request's matrix is active() here for code
 * that has no $db (Routes::dispatch, index.php and Domain set it with use()).
 */
final class Permissions {
 public const TYPES=['admin','editor','club','organizer','athlete','guardian','member','guest'];
 /** permission => scope ('sport': may differ per discipline; 'global': one value). */
 public const PERMS=['tournament.create'=>'sport','tournament.manage'=>'sport','athletes.manage'=>'global','entries.submit'=>'sport','entries.self'=>'sport','chat.write'=>'sport','chat.moderate'=>'global','admin.manage'=>'global'];
 /** Cells the Administrator may switch (on by default). Every other cell is fixed (FIXED). */
 public const EDITABLE=[
  'editor'=>['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write'],
  'club'=>['athletes.manage','entries.submit','chat.write'],
  'organizer'=>['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write'],
  'athlete'=>['entries.self','chat.write'],
  'guardian'=>['entries.self','chat.write'],
  'member'=>['chat.write'],
 ];
 /** Fixed cells that are switched on; every other fixed cell is off. */
 public const FIXED=['admin'=>['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write','chat.moderate','admin.manage']];
 public const AUDIT='settings.permissions';
 private static ?array $active=null;

 /** The matrix code without $db reads (null: none stored, the behaviour before the panel). */
 public static function use(?array $matrix):void{self::$active=$matrix;}
 public static function active():?array{return self::$active;}
 public static function editable(string $type,string $perm):bool{return in_array($perm,self::EDITABLE[$type]??[],true);}
 /** The value of a fixed cell (or the default of an editable one: on). */
 public static function fixed(string $type,string $perm):bool{return self::editable($type,$perm)||in_array($perm,self::FIXED[$type]??[],true);}
 /**
  * Whether account type $type has permission $perm in discipline $sport (null: no particular discipline, the global set)
  * under $matrix (default: the active one).
  */
 public static function allows(string $type,string $perm,?string $sport=null,?array $matrix=null):bool {
  if(!self::editable($type,$perm))return self::fixed($type,$perm);
  $m=func_num_args()>=4?$matrix:self::$active;if(!is_array($m))return true;
  if($sport!==null&&(self::PERMS[$perm]??null)==='sport'&&isset($m['sports'][$sport][$type][$perm]))return $m['sports'][$sport][$type][$perm]===true;
  return ($m['global'][$type][$perm]??true)===true;
 }
 /** Whether any of the types $types allows $perm (a member with several kinds of account: the abilities add up). */
 public static function any(array $types,string $perm,?string $sport=null,?array $matrix=null):bool {
  foreach($types as $t)if(func_num_args()>=4?self::allows($t,$perm,$sport,$matrix):self::allows($t,$perm,$sport))return true;
  return false;
 }
 /**
  * The workspace rules of Domain for an actor already allowed by the code (admin, editor, club or a member organizer):
  * admin always; editor and club by their row; a member by the row of organizers (the only member type of these permissions).
  */
 public static function actor(array $u,string $perm,?string $sport=null):bool {
  $role=$u['role']??null;
  if($role==='admin')return true;
  if($role==='editor'||$role==='club')return self::allows($role,$perm,$sport);
  return $role==='member'&&Domain::organizer($u)&&self::allows('organizer',$perm,$sport);
 }
 /**
  * The account types of a signed-in account for the chat: role admin, editor or club as such; a member account is an
  * organizer (role switched on and not blocked), an athlete and/or a guardian (own profiles not archived, by relation),
  * or a plain member when none of these applies.
  */
 public static function types(string $role,bool $organizer=false,array $relations=[]):array {
  if($role!=='member')return in_array($role,['admin','editor','club'],true)?[$role]:[];
  $out=[];if($organizer)$out[]='organizer';
  if(in_array('self',$relations,true))$out[]='athlete';
  if(in_array('guardian',$relations,true))$out[]='guardian';
  return $out?:['member'];
 }

 // ---- Stored matrix -----------------------------------------------------------------------------------------------
 /**
  * {global, sports} from stored data: only known editable cells with boolean values; a sport set only for a known sport
  * and only with sport-scoped cells, filled from the global set where a cell is missing. Null when nothing is stored.
  */
 public static function normalize(mixed $d):?array {
  if(!is_array($d)||!is_array($d['global']??null)&&!is_array($d['sports']??null))return null;
  $global=self::cells($d['global']??null,false,null);$sports=[];
  foreach(is_array($d['sports']??null)?$d['sports']:[] as $slug=>$set)if(is_string($slug)&&Sports::valid($slug)&&is_array($set))$sports[$slug]=self::cells($set,true,$global);
  return ['global'=>$global,'sports'=>$sports];
 }
 /** Every editable cell (sport-scoped only when $sport) from $set, else from $base, else on. */
 private static function cells(mixed $set,bool $sport,?array $base):array {
  $out=[];
  foreach(self::EDITABLE as $type=>$perms)foreach($perms as $perm){
   if($sport&&self::PERMS[$perm]!=='sport')continue;
   $v=is_array($set)?($set[$type][$perm]??null):null;
   $out[$type][$perm]=is_bool($v)?$v:($base[$type][$perm]??true);
  }
  return $out;
 }
 /** The full default matrix (every editable cell on, no sport sets). */
 public static function defaults():array{return ['global'=>self::cells(null,false,null),'sports'=>[]];}
 /** {v, matrix, updatedAt, updatedBy} of the stored data (v 0 and the defaults when nothing is stored). */
 public static function stored(mixed $raw):array {
  $m=self::normalize($raw);$v=is_array($raw)&&is_int($raw['v']??null)&&$raw['v']>0?$raw['v']:0;
  return ['v'=>$m===null?0:$v,'matrix'=>$m??self::defaults(),'updatedAt'=>$m!==null&&is_int($raw['at']??null)?$raw['at']:null,'updatedBy'=>$m!==null&&is_string($raw['by']??null)?$raw['by']:null];
 }

 // ---- Admin panel -------------------------------------------------------------------------------------------------
 /** admin-permissions: {version, global, sports, updatedAt, updatedBy:{name}|null, sportsList}. */
 public static function view(PDO $pdo,array $file):array {
  $s=self::stored(Settings::get($pdo,$file)['stored']['permissions']??null);
  $by=null;if($s['updatedBy']!==null){$q=$pdo->prepare('SELECT email FROM users WHERE id=?');$q->execute([$s['updatedBy']]);$e=$q->fetchColumn();$q->closeCursor();$by=['email'=>$e===false?null:(string)$e];}
  return ['version'=>$s['v'],'global'=>$s['matrix']['global'],'sports'=>(object)$s['matrix']['sports'],'updatedAt'=>$s['updatedAt']===null?null:gmdate('c',$s['updatedAt']),'updatedBy'=>$by,'sportsList'=>array_keys(Sports::FEDERATIONS)];
 }
 /**
  * admin-permissions-save {version, global:{type:{perm:bool}}, sports:{slug:{type:{perm:bool}}}}: every value must be a
  * known editable cell (400 otherwise; a fixed cell can never be sent, so the Administrator cannot lock themselves out),
  * a sport set only sport-scoped cells; the whole matrix replaces the stored one. 409 code stale when the version moved
  * on. One locked write of the settings row (Settings::writeRaw, the settings version stays) and one account_audit line
  * (settings.permissions, visible in "Historia zmian"). Returns view().
  */
 public static function save(PDO $pdo,array $file,array $admin,array $in,int $now):array {
  $bad=fn()=>throw new AppError('Niepoprawny formularz.',400);
  $version=$in['version']??null;if(!is_int($version)||$version<0)$bad();
  $check=function(mixed $set,bool $sport)use($bad):array{
   if(!is_array($set)||array_is_list($set)&&$set!==[])$bad();
   foreach($set as $type=>$perms){
    if(!is_string($type)||!isset(self::EDITABLE[$type])||!is_array($perms)||array_is_list($perms)&&$perms!==[])$bad();
    foreach($perms as $perm=>$v)if(!is_string($perm)||!self::editable($type,$perm)||!is_bool($v)||$sport&&self::PERMS[$perm]!=='sport')$bad();
   }
   return $set;
  };
  $global=$check($in['global']??null,false);$sports=[];
  $rawSports=$in['sports']??[];if(!is_array($rawSports)||array_is_list($rawSports)&&$rawSports!==[])$bad();
  foreach($rawSports as $slug=>$set){if(!is_string($slug)||!Sports::valid($slug))$bad();$sports[$slug]=$check($set,true);}
  $next=self::normalize(['global'=>$global,'sports'=>$sports]);$note='';
  Settings::writeRaw($pdo,function(array $raw)use($version,$next,$admin,$now,&$note):array{
   $cur=self::stored($raw['permissions']??null);if($cur['v']!==$version)throw new ApiError('Uprawnienia zmienił w międzyczasie ktoś inny. Odśwież stronę.',409,['code'=>'stale']);
   $note=self::diff($cur['matrix'],$next);
   $raw['permissions']=['v'=>$cur['v']+1,'global'=>$next['global'],'sports'=>(object)$next['sports'],'at'=>$now,'by'=>$admin['id']];
   return $raw;
  },$now,function()use($pdo,$admin,&$note){Members::audit($pdo,$admin['id'],self::AUDIT,null,mb_substr($note===''?'unchanged':$note,0,200));});
  return self::view($pdo,$file);
 }
 /** A short code of the change for the history (admin-permissions.js permissionsNote shows it in words): "editor.tournament.create=0, karate=own, judo=inherit, karate organizer.chat.write=0". */
 public static function diff(array $old,array $new):string {
  $out=[];
  foreach($new['global'] as $type=>$perms)foreach($perms as $perm=>$v)if(($old['global'][$type][$perm]??true)!==$v)$out[]=$type.'.'.$perm.'='.($v?1:0);
  foreach(array_keys(Sports::FEDERATIONS) as $slug){
   $a=$old['sports'][$slug]??null;$b=$new['sports'][$slug]??null;
   if($a===null&&$b!==null)$out[]=$slug.'=own';elseif($a!==null&&$b===null)$out[]=$slug.'=inherit';
   elseif($a!==null&&$b!==null)foreach($b as $type=>$perms)foreach($perms as $perm=>$v)if(($a[$type][$perm]??true)!==$v)$out[]=$slug.' '.$type.'.'.$perm.'='.($v?1:0);
  }
  return implode(', ',$out);
 }
}
