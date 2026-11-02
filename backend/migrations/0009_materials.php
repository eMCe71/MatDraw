<?php
// Tournament materials (PLAN-MATERIALY §2.1, §4): tournaments.materials holds the poster and rules meta as JSON text
// {"poster":{f,w,h,c,at},"rules":{f,b,at}|{t,at}} (MatDraw\Materials; NULL = none). MEDIUMTEXT, not TEXT: a typed rules text
// of 20 000 characters takes up to 80 000 bytes in UTF-8, above the 65 535 bytes of TEXT. Additive only: one column at the
// end, NULL (instant ADD COLUMN), through Migrator::addColumn, so a repeated run changes nothing and no existing row changes.
// No floor: the release before this migration reads tournaments with SELECT * into explicit fields and writes them with
// explicit columns, so it ignores the column (a tournament keeps its materials while that release runs).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>9,'name'=>'materials','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->addColumn('tournaments','materials','MEDIUMTEXT NULL');
 }];
