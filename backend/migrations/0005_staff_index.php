<?php
// Index on users.role: the workspace (Repository::load, every bootstrap, hall screen and command, the latter under the
// app_meta lock) reads the staff accounts only. Without it that query scans every account, members included, so its
// cost grows with the community instead of the club staff. An index never changes data: the release before this
// migration simply ignores it (no floor), and a repeated run finds it and does nothing.
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>5,'name'=>'staff_index','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->addIndex('users','users_role','role');
 }];
