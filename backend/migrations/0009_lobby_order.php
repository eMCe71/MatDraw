<?php
// Order of the global chat channels (owner's request, 2026-11-01): Taekwondo Polska first, then Taekwondo, Karate and
// Ogólny (world). Only chat_channels.sort of the two Taekwondo channels changes; Chat::LOBBY carries the same values.
// No floor: the release before this migration only shows the channels in its own order, and a repeated run changes
// nothing (the UPDATE sets fixed values).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>9,'name'=>'lobby_order','destructive'=>false,
 'up'=>function(Migrator $m):void{
  if(!$m->tableExists('chat_channels'))return;
  foreach([['taekwondo-pl',10],['taekwondo',20],['karate',30],['general',40]] as [$slug,$sort])
   $m->exec("UPDATE chat_channels SET sort=? WHERE kind='lobby' AND slug=?",[$sort,$slug]);
 }];
