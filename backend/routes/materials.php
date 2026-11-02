<?php
// Tournament materials (PLAN-MATERIALY §2.2, §4; backend/src/Materials.php): a poster and the rules (a PDF or a typed text).
//   poster-upload    POST upload ?t=<id>, raw JPEG/PNG/WebP up to Materials::posterMax (4 MB, less when post_max_size is
//                    lower): {workspace, result:{poster:{v,w,h,color}}}; 503 while posters cannot be stored (no GD, no
//                    writable uploads directory)                                            material-upload 30/h per account
//   rules-upload     POST upload ?t=<id>, raw PDF up to Materials::rulesMax (10 MB, at most post_max_size − 64 KB):
//                    {workspace, result:{rules:{v,size,type:'pdf'}}}                        (shared with poster-upload)
//   rules-text       POST session {t, text}: the typed rules (Materials::text, 1–20 000 characters; nothing left: 422 'Wpisz
//                    treść regulaminu albo usuń regulamin.'): {workspace, result:{rules:{v,size,type:'text'}}}   (shared)
//   material-delete  POST session {t, kind:'poster'|'rules'}: {workspace, result:{}}       material-delete 60/h per account
//   material         GET peek, user optional ?t, k=poster|rules, s=sm|lg (poster only), v: the file or the text, or one 404
//                    for every refusal
// Saving rules of one kind replaces the other (one rules item per tournament; a replaced PDF goes after the commit).
// Writes run tournament.material through Domain::execute under the workspace lock for whoever manages the tournament: a
// member organizer as in the command route (caps.organizer again under the lock, Auth::stepUp, full access (402) and the
// member budget MemberTx for uploads and texts), staff with full access for them (402 otherwise); removal never needs full
// access. The workspace in the answer is the one the command route gives. The command route refuses tournament.material (400).
declare(strict_types=1);
use MatDraw\{Materials,RouteContext};
return [
 'poster-upload'=>['method'=>'POST','auth'=>'upload','types'=>['image/jpeg','image/png','image/webp'],'max'=>max(1,Materials::posterMax()),
  'reject'=>static fn(int $status)=>Materials::reject('poster',$status),
  'handler'=>fn(RouteContext $ctx):array=>Materials::upload($ctx,'poster')],
 'rules-upload'=>['method'=>'POST','auth'=>'upload','types'=>['application/pdf'],'max'=>max(1,Materials::rulesMax()),
  'reject'=>static fn(int $status)=>Materials::reject('rules',$status),
  'handler'=>fn(RouteContext $ctx):array=>Materials::upload($ctx,'rules')],
 // JSON of at most TEXT_MAX characters, each escaped to at most 6 bytes, and the other fields.
 'rules-text'=>['method'=>'POST','auth'=>'session','max'=>Materials::TEXT_MAX*6+1024,'handler'=>fn(RouteContext $ctx):array=>Materials::saveText($ctx)],
 'material-delete'=>['method'=>'POST','auth'=>'session','max'=>1024,'handler'=>fn(RouteContext $ctx):array=>Materials::delete($ctx)],
 // Guests get the same 404 as everyone who may not read the file (user optional, never 401), see Materials::serve.
 'material'=>['method'=>'GET','auth'=>'peek','user'=>'optional','handler'=>fn(RouteContext $ctx)=>Materials::serve($ctx)],
];
