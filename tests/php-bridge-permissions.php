<?php
// Bridge for tests/permissions.test.mjs: Permissions without a database, JSON on STDIN, JSON on STDOUT.
//  constants  {}: TYPES, PERMS, EDITABLE, FIXED and the sports.
//  allows     {matrix, cases:[[type, perm, sport|null]]}: Permissions::allows under the given matrix (null: none stored).
//  normalize  {cases:[mixed]}: Permissions::normalize.
//  types      {cases:[[role, organizer, relations]]}: Permissions::types.
//  diff       {cases:[[old, new]]}: Permissions::diff.
//  creator    {matrix, users:[u], sports:[slug|null]}: Domain::canCreateTournament for each user and sport.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{Domain,Permissions,Sports};
$in=json_decode(stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR);
$out=match($in['job']){
 'constants'=>['types'=>Permissions::TYPES,'perms'=>Permissions::PERMS,'editable'=>Permissions::EDITABLE,'fixed'=>Permissions::FIXED,'sports'=>array_keys(Sports::FEDERATIONS)],
 'allows'=>array_map(fn($c)=>Permissions::allows($c[0],$c[1],$c[2],$in['matrix']),$in['cases']),
 'normalize'=>array_map(fn($d)=>Permissions::normalize($d),$in['cases']),
 'types'=>array_map(fn($c)=>Permissions::types($c[0],$c[1],$c[2]),$in['cases']),
 'diff'=>array_map(fn($c)=>Permissions::diff($c[0],$c[1]),$in['cases']),
 'creator'=>(function()use($in){Permissions::use($in['matrix']);$o=[];foreach($in['users'] as $u)foreach($in['sports'] as $s)$o[]=Domain::canCreateTournament($u,$s);return $o;})(),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
