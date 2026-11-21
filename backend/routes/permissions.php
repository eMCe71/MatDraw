<?php
// The Administrator's permission matrix (panel "Uprawnienia", MatDraw\Permissions): rows are account types, columns permissions,
// globally and per discipline. Stored under the key 'permissions' of the app_settings row (no migration; the settings version
// stays). Every route is admin only (403 before any data is read).
//   admin-permissions       GET  peek    admin                                   → view
//   admin-permissions-save  POST session admin, ≤ 16 KB {version, global, sports} → view; 400; 409 stale
declare(strict_types=1);
use MatDraw\{Permissions,RouteContext};

return [
 'admin-permissions'=>['method'=>'GET','auth'=>'peek','user'=>'admin','handler'=>fn(RouteContext $ctx):array=>Permissions::view($ctx->pdo(),$ctx->file)],
 'admin-permissions-save'=>['method'=>'POST','auth'=>'session','user'=>'admin','max'=>16384,'handler'=>function(RouteContext $ctx):array{
  $u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Permissions::save($pdo,$ctx->file,$u,$ctx->body,time());
 }],
];
