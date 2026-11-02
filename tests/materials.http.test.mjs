// Tournament materials over real PHP and MariaDB/MySQL (PLAN-MATERIALY §2; run through scripts/test-http.sh): poster-upload and
// rules-upload for whoever manages the tournament (a member organizer with the step-up, staff), refusals of everyone else (404
// for members, 403 for staff, 401 for guests), the command route refusing tournament.material, the Administrator removing any
// material (account_audit), the material route (public immutable cache for public tournaments, the same 404 for every refusal,
// private for the managers of drafts, hidden tournaments and those of blocked organizers, 304, the PDF inline with nosniff),
// formats (415), sizes (413, 422), rate limits (429), paid mode (402), files (0600 in 0700 directories named by hashes, the
// previous ones removed after the commit), the sweep of the accounts job and migration 0009 run again. Images are made by
// tests/php-bridge-materials.php with GD (no binary fixtures).
import test,{before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
const skip=!base||!process.env.MATDRAW_TEST_SHARED_DIR,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
const now=()=>Math.floor(Date.now()/1000);
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const sid=c=>c.cookie.split('=')[1];
const MISSING='Turniej nie jest dostępny.';
async function signIn(email,password=PASSWORD){const c=new Client();await c.req('session');const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
/** A member with a complete profile (full access unless exempt is false); organizer: users.organizer=1. */
function member(prefix,{organizer=false,exempt=true}={}){const email=uniq(prefix)+'@materials.test',m=fixture('member',{email,profile:true,exempt});if(organizer)fixture('domain-organizer',{userId:m.id,organizer:true,trusted:true});return {...m,email};}
/** A tournament of $createdBy (fixture, no organizer limits). */
const tournament=(createdBy,over={})=>fixture('tournament',{createdBy,name:'Turniej '+uniq('m'),date:day(30),status:'open',...over}).id;
/** An image made with GD by the bridge: {w, h, format, fill, quadrants, …} (see tests/php-bridge-materials.php). */
function image(gen){const r=spawnSync(php,[path.join(repo,'tests','php-bridge-materials.php')],{input:JSON.stringify({job:'image',gen}),encoding:'utf8',maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr);return Buffer.from(JSON.parse(r.stdout),'base64');}
const PDF=Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
/** A raw upload (poster-upload or rules-upload) as the browser sends it: the session cookie, the CSRF token, raw bytes. */
async function upload(c,route,t,bytes,type){
 const r=await fetch(base+'?route='+route+(t===undefined?'':'&t='+encodeURIComponent(t)),{method:'POST',headers:{'X-MatBravo-Client':'1',Cookie:c?.cookie??'','X-CSRF-Token':c?.csrf??'','Content-Type':type},body:bytes});
 const data=await r.json();if(c&&data?.csrf)c.csrf=data.csrf;return {status:r.status,data,headers:r.headers};
}
const poster=(c,t,bytes=image({w:1200,h:1700,format:'png',quadrants:true}),type='image/png')=>upload(c,'poster-upload',t,bytes,type);
const rules=(c,t,bytes=PDF,type='application/pdf')=>upload(c,'rules-upload',t,bytes,type);
/** GET of the material route (or any route): {status, headers, buf, data}. */
async function get(query,{cookie,headers={}}={}){
 const r=await fetch(base+'?'+query,{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{}),...headers}});
 const buf=Buffer.from(await r.arrayBuffer());let data=null;try{data=JSON.parse(buf.toString('utf8'));}catch{}
 return {status:r.status,headers:r.headers,buf,data};
}
const url=(t,kind,v,s)=>`route=material&t=${encodeURIComponent(t)}&k=${kind}${s?'&s='+s:''}&v=${v}`;
const hashDir=t=>{const h=createHash('sha256').update(t).digest('hex').slice(0,32);return `/materials/${h.slice(0,2)}/${h}`;};
const view=(c,t)=>c.data.tournaments.find(x=>x.id===t);
const notFound=(r,label)=>{assert.equal(r.status,404,label+' '+r.status+' '+r.buf?.toString('utf8').slice(0,80));assert.equal(r.data?.error,MISSING,label);};
let admin;
before(async()=>{fixture('reset-limits');admin=await signIn(...ADMIN);await admin.load();});
beforeEach(()=>fixture('reset-limits'));

test('an organizer uploads a poster and rules to his own tournament (step-up); views carry v, files 0600 in hashed 0700 directories',{skip},async()=>{
 const o=member('org',{organizer:true}),c=await signIn(o.email);await c.load();const t=tournament(o.id);
 const me=(await c.req('me')).data.features.materials;assert.deepEqual(Object.keys(me),['poster','rules']);assert.equal(me.poster,4194304);assert.ok(me.rules>0&&me.rules<=10485760);
 const up=await poster(c,t);assert.equal(up.status,200,JSON.stringify(up.data));
 assert.deepEqual(Object.keys(up.data),['workspace','result']);assert.deepEqual(Object.keys(up.data.result),['poster']);
 const p=up.data.result.poster;assert.deepEqual(Object.keys(p),['v','w','h','color']);assert.match(p.v,/^[0-9a-f]{12}$/);assert.deepEqual([p.w,p.h],[1200,1700]);assert.equal(p.color,'#7f7f7f');
 c.data=up.data.workspace;assert.deepEqual(view(c,t).poster,p);assert.ok(!('materials' in view(c,t)));assert.equal(c.data.user.id,o.id);
 const json=JSON.stringify(up.data);assert.ok(!json.includes('.webp')&&!json.includes('"f"'),'the stored name never leaves');
 const row=fixture('materials-row',{t});assert.ok(row.materials.poster.f.startsWith(p.v));assert.deepEqual(Object.keys(row.materials.poster),['f','w','h','c','at']);
 const files=fixture('materials-files',{t}),hash=row.materials.poster.f.slice(0,32);
 assert.deepEqual([files.dir,files.parent,files.root],['0700','0700','0700']);assert.ok(files.path.endsWith(hashDir(t)),files.path);
 assert.deepEqual(files.files,{[hash+'-lg.webp']:'0600',[hash+'-sm.webp']:'0600'});
 const r=await rules(c,t);assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual(r.data.result,{rules:{v:createHash('sha256').update(PDF).digest('hex').slice(0,12),size:PDF.length,type:'pdf'}});assert.deepEqual(view({data:r.data.workspace},t).poster,p,'the poster stays');
 // A new poster: the files of the previous one go after the commit.
 const next=await poster(c,t,image({w:900,h:1300,format:'jpeg',fill:[10,120,60]}),'image/jpeg');assert.equal(next.status,200,JSON.stringify(next.data));assert.notEqual(next.data.result.poster.v,p.v);
 const left=Object.keys(fixture('materials-files',{t}).files).sort();assert.equal(left.length,3,left.join());assert.ok(left.every(f=>f.startsWith(next.data.result.poster.v)||f.endsWith('.pdf')),left.join());
 // The step-up: 30 minutes without the organizer tools ask for the password again; nothing changes.
 fixture('session-edit',{sid:sid(c),set:{ws:{at:now()-120,last:now()-31*60}}});
 const re=await poster(c,t);assert.deepEqual([re.status,re.data.code],[401,'reauth']);
 const del=await c.req('material-delete',{t,kind:'poster'});assert.deepEqual([del.status,del.data.code],[401,'reauth']);
 assert.equal(fixture('materials-row',{t}).materials.poster.f.slice(0,12),next.data.result.poster.v);
});

test('refusals: other organizers and members 404/403, staff of other tournaments 403, guests 401; the command route refuses the type',{skip},async()=>{
 const o=member('own',{organizer:true}),other=member('other',{organizer:true}),plain=member('plain'),t=tournament(o.id);
 const oc=await signIn(o.email);assert.equal((await poster(oc,t)).status,200);const before=fixture('materials-row',{t});
 const oth=await signIn(other.email);
 for(const r of [await poster(oth,t),await rules(oth,t),await oth.req('material-delete',{t,kind:'poster'}),await poster(oth,'no-such-tournament')])assert.deepEqual([r.status,r.data.error],[404,MISSING]);
 const pl=await signIn(plain.email);for(const r of [await poster(pl,t),await pl.req('material-delete',{t,kind:'rules'})])assert.deepEqual([r.status,r.data.error],[403,'Brak uprawnień.']);
 await admin.load();
 const club=uniq('klub')+'@materials.test',editor=uniq('edytor')+'@materials.test';
 await admin.cmd('account.save',{email:club,password:PASSWORD,clubId:admin.data.user.clubId,role:'club'});await admin.cmd('account.save',{email:editor,password:PASSWORD,clubId:admin.data.user.clubId,role:'editor'});
 for(const email of [club,editor]){const s=await signIn(email);for(const r of [await poster(s,t),await s.req('material-delete',{t,kind:'poster'})])assert.deepEqual([r.status,r.data.error],[403,'Możesz edytować tylko własne turnieje.'],email);
  assert.deepEqual([(await poster(s,'no-such-tournament')).status],[404]);}
 const guest=new Client();await guest.req('session');assert.equal((await poster(guest,t)).status,401);assert.equal((await guest.req('material-delete',{t,kind:'poster'})).status,401);
 assert.equal((await poster(null,t)).status,403,'no CSRF token');
 for(const bad of [undefined,'','../x','a'.repeat(41)])assert.deepEqual([(await poster(oc,bad)).status],[404],String(bad));
 assert.deepEqual([(await oc.req('material-delete',{t,kind:'banner'})).status,(await oc.req('material-delete',{t:['x'],kind:'poster'})).status],[400,404]);
 assert.deepEqual(fixture('materials-row',{t}),before,'nothing changed');
 // The command route never sets materials: the value comes from a file the server stored itself.
 const f='a'.repeat(32)+'.webp',payload={id:t,kind:'poster',value:{f,w:1,h:1,c:'#000000',at:1}};await oc.load();
 for(const c of [admin,oc]){const r=await c.req('command',{type:'tournament.material',payload,expectedRevision:c.data.revision});assert.deepEqual([r.status,r.data.error],[400,'Niepoprawna operacja.']);}
 assert.deepEqual(fixture('materials-row',{t}),before);
});

test('the Administrator removes the material of any tournament (account_audit); files go after the commit; removal is idempotent',{skip},async()=>{
 const o=member('abuse',{organizer:true}),oc=await signIn(o.email),t=tournament(o.id);
 assert.equal((await poster(oc,t)).status,200);assert.equal((await rules(oc,t)).status,200);const since=now()-1;
 await admin.load();const r=await admin.req('material-delete',{t,kind:'poster'});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual(r.data.result,{});assert.ok(!('poster' in view({data:r.data.workspace},t)));assert.equal(view({data:r.data.workspace},t).rules.size,PDF.length);
 assert.deepEqual(Object.keys(fixture('materials-files',{t}).files).filter(f=>!f.endsWith('.pdf')),[],'the poster files are gone');
 const log=fixture('roles-audit',{since}).filter(x=>x.action==='tournament.material');
 assert.deepEqual(log.map(x=>[x.actor_id,x.target_user_id,x.note.split(' · ')[0]]),[[admin.data.user.id,o.id,'poster removed '+t]]);
 assert.equal((await admin.req('material-delete',{t,kind:'poster'})).status,200,'nothing to remove: still 200');
 const own=await oc.req('material-delete',{t,kind:'rules'});assert.equal(own.status,200);assert.deepEqual(fixture('materials-row',{t}).materials,null,'no kind left: NULL');
 assert.equal(fixture('materials-files',{t}).files&&Object.keys(fixture('materials-files',{t}).files).length,0);
 // An Administrator's tournament: no audit (staff data), the Administrator uploads like any manager.
 const at=tournament(admin.data.user.id);assert.equal((await poster(admin,at)).status,200);assert.equal(fixture('roles-audit',{since}).filter(x=>x.action==='tournament.material').length,1);
});

test('the material route: public immutable cache for guests, the same 404 for every refusal, private for managers, 304, PDF inline',{skip},async()=>{
 const o=member('serve',{organizer:true}),oc=await signIn(o.email),stranger=await signIn(member('obcy',{organizer:true}).email),t=tournament(o.id,{name:'Puchar Łodzi 2026'}),draft=tournament(o.id,{status:'draft'});
 const p=(await poster(oc,t)).data.result.poster,pdf=(await rules(oc,t)).data.result.rules,dp=(await poster(oc,draft)).data.result.poster;
 // Public: guests, the cache of a year, the security headers, no cookie.
 for(const s of ['sm','lg']){
  const r=await get(url(t,'poster',p.v,s));assert.equal(r.status,200,r.buf.toString().slice(0,100));
  assert.equal(r.headers.get('content-type'),'image/webp');assert.equal(r.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal(r.headers.get('etag'),`"${p.v}-${s}"`);
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('content-security-policy'),"default-src 'none'; sandbox");assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.buf.subarray(0,4).toString(),'RIFF');assert.equal(Number(r.headers.get('content-length')),r.buf.length);
  const cached=await get(url(t,'poster',p.v,s),{headers:{'If-None-Match':`"${p.v}-${s}"`}});assert.equal(cached.status,304);assert.equal(cached.buf.length,0);assert.equal(cached.headers.get('etag'),`"${p.v}-${s}"`);
 }
 const lg=await get(url(t,'poster',p.v,'lg')),sm=await get(url(t,'poster',p.v,'sm'));assert.ok(lg.buf.length>sm.buf.length,'two sizes');
 const doc=await get(url(t,'rules',pdf.v));assert.equal(doc.status,200);assert.ok(doc.buf.equals(PDF),'the PDF as sent');
 assert.equal(doc.headers.get('content-type'),'application/pdf');assert.equal(doc.headers.get('content-disposition'),'inline; filename="regulamin-puchar-lodzi-2026.pdf"');
 assert.equal(doc.headers.get('x-content-type-options'),'nosniff');assert.equal(doc.headers.get('content-security-policy'),null,'no sandbox: it blocks the PDF viewer');assert.equal(doc.headers.get('etag'),`"${pdf.v}"`);
 assert.equal(doc.headers.get('cache-control'),'public, max-age=31536000, immutable');
 // Every refusal is the same 404: stale or malformed v, sizes, kinds, ids, rules with a size, a missing tournament.
 const other=p.v==='000000000000'?'111111111111':'000000000000';
 for(const q of [url(t,'poster',other,'sm'),url(t,'poster',p.v.toUpperCase(),'sm'),url(t,'poster',p.v.slice(1),'sm'),url(t,'poster',p.v),url(t,'poster',p.v,'md'),url(t,'banner',p.v,'sm'),url(t,'rules',pdf.v,'sm'),
  url(t,'rules',p.v),url('../'+t,'poster',p.v,'sm'),url('missing-id','poster',p.v,'sm'),`route=material&t=${t}&k=poster&s=sm`,url(t,'poster',p.v,'sm')+'&t[]=x'])notFound(await get(q),q);
 // A draft: 404 for guests and strangers (also with a matching ETag), private for its manager and the Administrator.
 const durl=url(draft,'poster',dp.v,'sm');notFound(await get(durl),'guest');notFound(await get(durl,{cookie:stranger.cookie}),'stranger');notFound(await get(durl,{headers:{'If-None-Match':`"${dp.v}-sm"`}}),'guest with an ETag');
 for(const c of [oc,admin]){const r=await get(durl,{cookie:c.cookie});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal(r.headers.get('set-cookie'),null);}
 // Hidden by the Administrator: 404 for guests, private for the managers; restored: public again.
 await admin.load();await admin.cmd('tournament.hide',{tournamentId:t,hidden:true,reason:'Plakat do sprawdzenia'});
 const purl=url(t,'poster',p.v,'lg');notFound(await get(purl),'hidden');notFound(await get(url(t,'rules',pdf.v)),'hidden rules');
 assert.equal((await get(purl,{cookie:oc.cookie})).headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal((await get(purl,{cookie:admin.cookie})).status,200);
 await admin.load();await admin.cmd('tournament.hide',{tournamentId:t,hidden:false});assert.equal((await get(purl)).status,200);
 // A blocked organizer: 404 for guests and for himself (no longer an organizer), private for the Administrator; the guest views lose the poster.
 assert.deepEqual((await get('route=public-tournament&id='+t)).data.tournament.poster,p);
 fixture('domain-organizer',{userId:o.id,blocked:true});
 try{
  notFound(await get(purl),'blocked: guest');notFound(await get(purl,{cookie:oc.cookie}),'blocked: the organizer himself');
  const a=await get(purl,{cookie:admin.cookie});assert.equal(a.status,200);assert.equal(a.headers.get('cache-control'),'private, max-age=31536000, immutable');
  const pub=await get('route=public-tournament&id='+t);assert.equal(pub.status,200);assert.ok(!('poster' in pub.data.tournament)&&!('rules' in pub.data.tournament),'no poster where the files are refused');
 }finally{fixture('domain-organizer',{userId:o.id,blocked:false});}
 // Guests' views: the home list and the preview carry poster and rules; the stored names never.
 const list=(await get('route=public')).data.tournaments.find(x=>x.id===t),pre=(await get('route=public-tournament&id='+t)).data.tournament;
 if(list)assert.deepEqual([list.poster,list.rules],[p,pdf]);assert.deepEqual([pre.poster,pre.rules],[p,pdf]);
 assert.equal((await get('route=public-tournament&id='+draft)).status,404);
 const ws=await oc.load();assert.deepEqual([view(oc,t).poster,view(oc,draft).poster],[p,dp],'the organizer\'s bootstrap');assert.ok(!JSON.stringify(ws).includes('.webp'));
});

test('uploads: content and type (415), dimensions (422), size (413), rate limits (429), paid mode (402); removal without access',{skip},async()=>{
 const o=member('limits',{organizer:true}),c=await signIn(o.email),t=tournament(o.id),max=(await c.req('me')).data.features.materials;
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><script>alert(1)</script></svg>');
 for(const [bytes,type,status,error] of [[svg,'image/png',415,'To nie jest obraz JPG, PNG ani WebP.'],[svg,'image/svg+xml',415,'To nie jest obraz JPG, PNG ani WebP.'],[image({w:400,h:600,format:'gif'}),'image/png',415],
  [image({w:400,h:600,format:'png'}),'image/gif',415],[Buffer.from('<html><body>x</body></html>'),'image/jpeg',415],[image({w:150,h:600,format:'png'}),'image/png',422,'Zdjęcie ma niepoprawne wymiary.'],[image({w:4100,h:300,format:'png'}),'image/png',422]]){
  const r=await poster(c,t,bytes,type);assert.equal(r.status,status,type+' '+JSON.stringify(r.data));if(error)assert.equal(r.data.error,error);
 }
 for(const [bytes,type] of [[Buffer.from('<html>%PDF-1.4</html>'),'application/pdf'],[PDF,'text/html'],[PDF,'application/x-pdf'],[Buffer.concat([PDF,Buffer.alloc(3000,32)]),'application/pdf']]){
  const r=await rules(c,t,bytes,type);assert.deepEqual([r.status,r.data.error],[415,'Nieobsługiwany format danych.'],type);
 }
 const png=image({w:300,h:400,format:'png'});
 const big=await poster(c,t,Buffer.concat([png,Buffer.alloc(max.poster+1-png.length)]));assert.deepEqual([big.status,big.data.error],[413,'Plik jest za duży.']);
 const bigPdf=await rules(c,t,Buffer.concat([PDF,Buffer.alloc(max.rules+1-PDF.length)]));assert.deepEqual([bigPdf.status,bigPdf.data.error],[413,'Plik jest za duży.']);
 assert.deepEqual(fixture('materials-row',{t}).materials,null,'nothing was stored');assert.equal(fixture('materials-files',{t}).dir,null,'no directory either');
 // 30 uploads per hour per account (poster and rules together), then 429 with Retry-After.
 fixture('reset-limits');
 for(let i=0;i<30;i++)assert.equal((await rules(c,t,PDF,'application/pdf')).status,200,'upload '+i);
 const limited=await poster(c,t);assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);assert.equal(limited.data.error,'Zbyt wiele prób. Spróbuj ponownie później.');
 assert.equal((await c.req('rules-text',{t,text:'Regulamin'})).status,429,'the typed rules share the upload limit');
 // 60 removals per hour per account.
 fixture('reset-limits');for(let i=0;i<60;i++)assert.equal((await c.req('material-delete',{t,kind:'poster'})).status,200,'delete '+i);
 assert.equal((await c.req('material-delete',{t,kind:'poster'})).status,429);
 // Paid mode (billing enforced in the test config): an organizer without full access uploads nothing (402), but may remove.
 fixture('reset-limits');
 const unpaid=member('unpaid',{organizer:true,exempt:false}),u=await signIn(unpaid.email),ut=tournament(unpaid.id);
 const r=await poster(u,ut);assert.deepEqual([r.status,r.data.error],[402,'Ta funkcja wymaga aktywnej subskrypcji.']);assert.equal((await rules(u,ut)).status,402);
 await admin.load();assert.equal((await poster(admin,ut)).status,200);
 const del=await u.req('material-delete',{t:ut,kind:'poster'});assert.equal(del.status,200,JSON.stringify(del.data));assert.equal(fixture('materials-row',{t:ut}).materials,null);
 // Staff without full access (a billing row without a subscription): 402 for uploads as for other commands.
 const email=uniq('placacy')+'@materials.test';await admin.cmd('account.save',{email,password:PASSWORD,clubId:admin.data.user.clubId,role:'editor'});
 const ed=admin.data.users.find(x=>x.email===email);fixture('billing',{userId:ed.id,billing_exempt:0,sub_status:'none'});
 const e=await signIn(email),et=tournament(ed.id);assert.equal((await poster(e,et)).status,402);
});

test('rules as a typed text (PLAN-MATERIALY §4): saved cleaned, PDF → text → PDF, text/plain for guests, drafts private, limits',{skip},async()=>{
 const o=member('tekst',{organizer:true}),c=await signIn(o.email),t=tournament(o.id,{name:'Turniej z tekstem'}),draft=tournament(o.id,{status:'draft'});
 const pdf=(await rules(c,t)).data.result.rules;assert.equal(pdf.type,'pdf');assert.equal(Object.keys(fixture('materials-files',{t}).files).length,1);
 // A text replaces the PDF: cleaned (CRLF, at most 2 empty lines, trimmed), its v and size in the answer, the PDF file gone after the commit.
 const raw='  Regulamin zawodów\r\n\r\n\r\n\r\n\r\n## Zasady\n- punkt <b>pierwszy</b> ‮odwrócony\n1. numer\nhttps://example.com/regulamin?a=1&b=2  \n\n';
 const clean='Regulamin zawodów\n\n\n## Zasady\n- punkt <b>pierwszy</b> odwrócony\n1. numer\nhttps://example.com/regulamin?a=1&b=2';
 const s=await c.req('rules-text',{t,text:raw});assert.equal(s.status,200,JSON.stringify(s.data));
 const v=createHash('sha256').update(clean).digest('hex').slice(0,12),text={v,size:[...clean].length,type:'text'};
 assert.deepEqual(s.data.result,{rules:text});assert.deepEqual(view({data:s.data.workspace},t).rules,text);
 assert.ok(!JSON.stringify(s.data).includes('pierwszy'),'the text itself never travels in the workspace');
 assert.deepEqual(fixture('materials-row',{t}).materials.rules,{t:clean,at:fixture('materials-row',{t}).materials.rules.at});
 assert.deepEqual(Object.keys(fixture('materials-files',{t}).files),[],'the replaced PDF goes after the commit');
 // Served to guests as plain text in a sandbox, with the cache, the ETag and the 404s of the PDF.
 const g=await get(url(t,'rules',v));assert.equal(g.status,200,g.buf.toString().slice(0,80));assert.equal(g.buf.toString('utf8'),clean);
 assert.equal(g.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(g.headers.get('content-security-policy'),"default-src 'none'; sandbox");
 assert.equal(g.headers.get('x-content-type-options'),'nosniff');assert.equal(g.headers.get('content-disposition'),'inline; filename="regulamin-turniej-z-tekstem.txt"');
 assert.equal(g.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal(g.headers.get('etag'),`"${v}"`);assert.equal(Number(g.headers.get('content-length')),Buffer.byteLength(clean));
 assert.equal((await get(url(t,'rules',v),{headers:{'If-None-Match':`"${v}"`}})).status,304);
 notFound(await get(url(t,'rules',pdf.v)),'the replaced PDF');notFound(await get(url(t,'rules',v,'sm')),'a size for rules');
 const pre=(await get('route=public-tournament&id='+t)).data.tournament;assert.deepEqual(pre.rules,text);assert.ok(!JSON.stringify(pre).includes('pierwszy'));
 // A draft: 404 for guests, private for its manager.
 const d=await c.req('rules-text',{t:draft,text:'Roboczy regulamin'});assert.equal(d.status,200);const dv=d.data.result.rules.v;
 notFound(await get(url(draft,'rules',dv)),'draft');const own=await get(url(draft,'rules',dv),{cookie:c.cookie});assert.equal(own.status,200);
 assert.equal(own.headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal(own.buf.toString(),'Roboczy regulamin');
 // Lengths: 20 000 characters (multi-byte too), more is 413; nothing left after cleaning is 422; the JSON body has its own bound.
 const max='ż'.repeat(20000),ok=await c.req('rules-text',{t:draft,text:max+'  \n'});assert.equal(ok.status,200,JSON.stringify(ok.data).slice(0,200));assert.equal(ok.data.result.rules.size,20000);
 assert.deepEqual([(await c.req('rules-text',{t:draft,text:max+'ż'})).status],[413]);
 for(const bad of ['   \r\n\t ​',undefined,7,['x']]){const r=await c.req('rules-text',{t:draft,text:bad});assert.deepEqual([r.status,r.data.error],[422,'Wpisz treść regulaminu albo usuń regulamin.'],JSON.stringify(bad));}
 assert.equal((await c.req('rules-text',{t:draft,text:'\u0000'.repeat(20500)})).status,413,'the request body above its bound');
 // Back to a PDF: the text goes with the commit (it has no file), the PDF is stored again.
 const back=await rules(c,t);assert.equal(back.status,200);assert.equal(back.data.result.rules.type,'pdf');
 assert.ok(fixture('materials-row',{t}).materials.rules.f.startsWith(back.data.result.rules.v));notFound(await get(url(t,'rules',v)),'the replaced text');
 // Others: another organizer 404, a guest 401, an organizer without full access 402; the command route refuses a text meta too.
 const other=await signIn(member('inny',{organizer:true}).email);assert.deepEqual([(await other.req('rules-text',{t,text:'Obcy'})).status],[404]);
 const guest=new Client();await guest.req('session');assert.equal((await guest.req('rules-text',{t,text:'Gość'})).status,401);
 const unpaid=member('bezdostepu',{organizer:true,exempt:false}),u=await signIn(unpaid.email);assert.equal((await u.req('rules-text',{t:tournament(unpaid.id),text:'Regulamin'})).status,402);
 await c.load();const r=await c.req('command',{type:'tournament.material',payload:{id:t,kind:'rules',value:{t:'Wpisany',at:1}},expectedRevision:c.data.revision});assert.deepEqual([r.status,r.data.error],[400,'Niepoprawna operacja.']);
 assert.equal(fixture('materials-row',{t}).materials.rules.f.slice(0,12),back.data.result.rules.v);
});

test('the accounts job sweeps materials: unreferenced files older than a day, directories of tournaments that are gone; budget and resume',{skip},async()=>{
 const o=member('sweep',{organizer:true}),c=await signIn(o.email),t=tournament(o.id);
 const p=(await poster(c,t)).data.result.poster;assert.equal((await rules(c,t)).status,200);
 fixture('materials-age',{t,days:3});
 const stray=fixture('materials-stray',{t}),orphan=fixture('materials-orphan',{}),orphan2=fixture('materials-orphan',{});
 // A budget of one directory: the run stops and names where it stopped; the next run resumes after it.
 const first=fixture('materials-sweep',{budget:1});assert.match(first.next,/^[0-9a-f]{32}$/);
 const rest=fixture('materials-sweep',{budget:100000,after:first.next});assert.equal(rest.next,null);
 const again=fixture('materials-sweep',{budget:100000});assert.equal(again.next,null);
 assert.ok(first.dirs+rest.dirs+again.dirs>=2,JSON.stringify([first,rest,again]));
 for(const d of [orphan,orphan2])assert.equal(fixture('materials-exists',{dir:d}),false,'the directory of a tournament that does not exist');
 const left=Object.keys(fixture('materials-files',{t}).files).sort();
 assert.ok(!left.includes(stray.old),'an old unreferenced file');assert.ok(left.includes(stray.fresh),'a fresh unreferenced file stays (an upload in progress)');
 assert.equal(left.filter(f=>f.startsWith(p.v)).length,2,'the current poster stays, also when old');assert.equal(left.filter(f=>f.endsWith('.pdf')).length,2,'the current rules and the fresh file');
 assert.equal((await get(url(t,'poster',p.v,'sm'))).status,200);
 // The job itself reports the sweep (accounts-cleanup).
 const out=fixture('accounts-cleanup',{config:{billing_enforce:false},prev:'material_next=-'});assert.match(out,/ material_files=\d+ material_dirs=\d+ material_next=(-|[0-9a-f]{32})$/);
});

test('migration 0009 again on the test database: nothing changes; the column holds the meta as JSON text',{skip},()=>{
 const backend=path.join(process.env.MATDRAW_TEST_RELEASE||repo,'backend');
 const sql=(code,input='null')=>{const r=spawnSync(php,['-r',`require ${JSON.stringify(path.join(backend,'bootstrap.php'))};$pdo=matdraw_database(matdraw_config());$in=json_decode(stream_get_contents(STDIN),true);echo json_encode((function()use($pdo,$in){${code}})());`],{encoding:'utf8',input,env:process.env});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);};
 const HASH="$t=[];foreach(['tournaments','users','profiles','entries','clubs'] as $n)$t[$n]=hash('sha256',json_encode($pdo->query(\"SELECT * FROM `$n` ORDER BY 1\")->fetchAll(PDO::FETCH_NUM)));return $t;";
 assert.deepEqual(sql("return $pdo->query(\"SELECT LOWER(DATA_TYPE),IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tournaments' AND COLUMN_NAME='materials'\")->fetch(PDO::FETCH_NUM);"),['text','YES']);
 const before=sql(HASH),version=sql("return (int)$pdo->query('SELECT schema_version FROM app_meta WHERE id=1')->fetchColumn();");assert.ok(version>=9);
 sql("$pdo->exec('UPDATE app_meta SET schema_version=8 WHERE id=1');return true;");
 const run=spawnSync(php,[path.join(backend,'bin','migrate.php')],{encoding:'utf8',env:process.env});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/0009_materials/);
 const twice=spawnSync(php,[path.join(backend,'bin','migrate.php')],{encoding:'utf8',env:process.env});assert.match(twice.stdout,/^Schemat aktualny/);
 assert.deepEqual(sql(HASH),before,'the column exists: addColumn does nothing, no row changes');
 assert.equal(sql("return (int)$pdo->query('SELECT schema_version FROM app_meta WHERE id=1')->fetchColumn();"),version);
});
