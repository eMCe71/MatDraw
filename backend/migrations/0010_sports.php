<?php
// Martial art and federation of a tournament (home page per martial art, owner 2026-11-10; MatDraw\Sports): tournaments.sport
// (an id of Sports::FEDERATIONS, every existing tournament is taekwondo) and tournaments.federation (an id of that sport's list,
// NULL = none). Additive only: two columns at the end, through Migrator::addColumn (instant ADD COLUMN with a DEFAULT or NULL), so
// a repeated run changes nothing and no existing row changes. The chat channels per sport are not inserted here (the CI back-compat
// job forbids new rows in existing tables): Chat::lists creates the missing ones for the first signed-in reader.
// No floor: the release before this migration reads tournaments into explicit fields and writes them with explicit columns, so it
// ignores both columns (a tournament it creates gets taekwondo and no federation).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>10,'name'=>'sports','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->addColumn('tournaments','sport',"VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'taekwondo'");
  $m->addColumn('tournaments','federation','VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL');
 }];
