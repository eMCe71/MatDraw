<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * What a route handler gets (plan §4.1): the route name and definition, config, the parsed JSON body (session POST) or
 * the raw body (upload, webhook), a lazily opened database connection and the signed-in account for the route's mode
 * (peek: read-only, never clears a session; session/upload: a stale session is cleared; public/webhook: always null).
 * releaseSession() closes a started session before slow work (Stripe calls, work after the response), so other
 * requests of the same person are not blocked by the session lock.
 * config is the effective configuration (Settings::effective, computed by Routes::dispatch with the connection it opened,
 * which pdo() then reuses); file is the raw config.php (the Admin's settings panel and diagnostics show where a value
 * comes from). Routes without the overlay (guests without a cookie, webhook) get the raw file as both.
 */
final class RouteContext {
 private ?PDO $pdo;
 private array|false|null $user=false;
 private ?array $access=null;
 public readonly array $file;
 public function __construct(public readonly string $name,public readonly array $route,public readonly array $config,public readonly array $body=[],private readonly ?string $raw=null,?PDO $pdo=null,?array $file=null){$this->pdo=$pdo;$this->file=$file??$config;}
 public function pdo():PDO{return $this->pdo??=\matdraw_database($this->config);}
 public function user():?array {
  // The connection opens only when the cookie or session names an account (a guest costs no database connection).
  $pdo=fn():PDO=>$this->pdo();
  if($this->user===false)$this->user=match($this->route['auth']){'peek'=>Accounts::currentPeek($pdo,$this->config),'session','upload'=>Accounts::current($pdo,false),default=>null};
  return $this->user;
 }
 /** Access::of() of the signed-in account (401 without one), computed once. */
 public function access():array {
  $u=$this->user();if(!$u)throw new AppError('Zaloguj się ponownie.',401);
  return $this->access??=Access::of($this->pdo(),$u,$this->config);
 }
 /** A body field (session POST). */
 public function input(string $key):mixed{return $this->body[$key]??null;}
 /** Raw request body (upload, webhook); '' for other modes. */
 public function raw():string{return $this->raw??'';}
 /** A query parameter, only as a string (arrays are ignored). Never put personal data into a URL (§4.1). */
 public function query(string $key):?string{$v=$_GET[$key]??null;return is_string($v)?$v:null;}
 /** The CSRF token of a started session (for answers that hand it to the client). */
 public function csrf():?string{$t=$_SESSION['csrf']??null;return is_string($t)?$t:null;}
 public function releaseSession():void{if(session_status()===PHP_SESSION_ACTIVE)session_write_close();}
}
