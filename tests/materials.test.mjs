// Tournament materials (PLAN-MATERIALY §2, §4) without a database: the poster pipeline of backend/src/Materials.php (formats by
// content, EXIF orientation, transparency on white, average colour, sizes never enlarged, metadata dropped, refusals, memory), the
// PDF check, the rules text (Materials::text against rulesText), the limits against post_max_size, the directory names, the file
// names, the strict meta and the views (PHP against dist/workspace.js), AthleteView's sparse fields and the demo (src instead of
// f, the text in the view). tests/php-bridge-materials.php runs PHP and makes every image with GD (no binary fixtures); the HTTP
// side is tests/materials.http.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {initialWorkspace,execute,publicWorkspace,guestTournaments,materialMeta,materialsView,rulesText,MATERIAL_KINDS,POSTER_MAX,RULES_MAX,RULES_TEXT_MAX} from '../dist/workspace.js';
const php=process.env.PHP_BIN;const skip=!php;
const FRONTEND=existsSync(new URL('../dist/materials.js',import.meta.url));
function bridge(input,ini=[],script='tests/php-bridge-materials.php'){const r=spawnSync(php,[...ini.flatMap(v=>['-d',v]),script],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:100_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const uploads=mkdtempSync(path.join(tmpdir(),'md-materials-'));
test.after(()=>rmSync(uploads,{recursive:true,force:true}));
const config={uploads_dir:uploads},off={uploads_dir:path.join(uploads,'missing')};
const gen=(w,h,format='png',more={})=>({gen:{w,h,format,...more}});
const sha=b=>createHash('sha256').update(b).digest('hex').slice(0,32);
const P={f:'9'.repeat(32)+'.webp',w:1240,h:1754,c:'#2b4c7e',at:1793484000},R={f:'8'.repeat(32)+'.pdf',b:48000,at:1793484000};

test('poster: re-encoded lg (longer side ≤ 2000) and sm (inside 480×720), never enlarged or cropped, average colour, named by the lg hash',{skip},()=>{
 const [big,tall,small,clear,jpeg]=bridge({job:'process',config,files:[gen(2400,1600,'png',{quadrants:true}),gen(1000,3000,'png',{fill:[51,102,153]}),gen(300,400,'webp',{fill:[200,30,40]}),gen(300,400,'png',{alpha:true}),gen(640,480,'jpeg',{quadrants:true})]});
 const dims=r=>[r.ok.meta.w,r.ok.meta.h,r.ok.files.lg.w,r.ok.files.lg.h,r.ok.files.sm.w,r.ok.files.sm.h];
 assert.deepEqual(dims(big),[2000,1333,2000,1333,480,320]);assert.deepEqual(dims(tall),[667,2000,667,2000,240,720]);
 assert.deepEqual(dims(small),[300,400,300,400,300,400],'smaller than both sizes: never enlarged');assert.deepEqual(dims(jpeg),[640,480,640,480,480,360]);
 assert.deepEqual([big.ok.files.lg.quadrants,big.ok.files.sm.quadrants],[['R','G','B','W'],['R','G','B','W']],'the whole poster, not cropped');
 assert.equal(big.ok.meta.c,'#7f7f7f','the average of red, green, blue and white');assert.equal(tall.ok.meta.c,'#336699');assert.equal(clear.ok.meta.c,'#ffffff','transparency on white');
 assert.deepEqual(clear.ok.files.lg.quadrants,['W','W','W','W']);
 for(const r of [big,tall,small,clear,jpeg]){
  const {meta,files,hash}=r.ok;assert.match(meta.f,/^[0-9a-f]{32}\.(webp|jpg)$/);assert.equal(meta.f.slice(0,32),hash,'the name is the hash of the lg file');
  assert.deepEqual(Object.keys(meta),['f','w','h','c','at']);assert.ok(Number.isInteger(meta.at)&&Math.abs(meta.at-Date.now()/1000)<60);assert.match(meta.c,/^#[0-9a-f]{6}$/);
  const ext=meta.f.split('.')[1];assert.deepEqual([files.lg.name,files.sm.name],[`${hash}-lg.${ext}`,`${hash}-sm.${ext}`]);
  assert.equal(files.lg.mime,ext==='webp'?'image/webp':'image/jpeg');assert.equal(files.sm.mime,files.lg.mime);
 }
});
test('poster: every EXIF orientation 1–8 is applied (sides swapped for 5–8), EXIF and appended bytes are gone',{skip},t=>{
 // Quadrants of the stored image: R G / B W. The displayed image per EXIF orientation (TL, TR, BL, BR), as tests/community.test.mjs.
 const want={1:'RGBW',2:'GRWB',3:'WBGR',4:'BWRG',5:'RBGW',6:'BRWG',7:'WGBR',8:'GWRB'};
 const out=bridge({job:'process',config,files:[...Object.keys(want).map(o=>gen(400,300,'jpeg',{quadrants:true,orientation:Number(o),exif:true})),gen(400,300,'jpeg',{quadrants:true,trailing:'MatBravoTrailingPayload<?php echo 1; ?><script>alert(1)</script>'})]});
 if(out[5].ok.files.lg.w===400){t.skip('no ext-exif');return;}
 Object.entries(want).forEach(([o,q],i)=>{const r=out[i].ok;assert.equal(r.files.lg.quadrants.join(''),q,'orientation '+o);assert.deepEqual([r.meta.w,r.meta.h],Number(o)>=5?[300,400]:[400,300],'orientation '+o);
  assert.equal(r.files.lg.exif||r.files.sm.exif,false,'no EXIF in the stored files');});
 assert.equal(out[8].ok.files.lg.trailing||out[8].ok.files.sm.trailing,false,'appended bytes removed by re-encoding');
});
test('poster refusals: SVG, GIF, HTML, empty (415); sides 200–4096 and at most 12 Mpx (422); memory_limit (422); too big (413); off (503)',{skip},()=>{
 const svg={text:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><script>alert(1)</script></svg>'};
 const out=bridge({job:'process',config,files:[svg,gen(400,600,'gif'),{text:'<html><body>%PDF-</body></html>'},{text:''},gen(199,400),gen(400,199),gen(4097,300),gen(300,4097),gen(4000,3001),gen(200,200)]});
 assert.deepEqual(out.map(r=>r.status??200),[415,415,415,415,422,422,422,422,422,200]);
 assert.equal(out[0].error,'To nie jest obraz JPG, PNG ani WebP.');assert.equal(out[4].error,'Zdjęcie ma niepoprawne wymiary.');
 // Memory (as Avatars): the decoded source and both outputs at 5 bytes per pixel must fit in half of memory_limit.
 const mem=m=>bridge({job:'process',config,memory:m,files:[gen(2400,2400)]})[0];
 assert.deepEqual([mem('64M').status,mem('64M').error],[422,'Zdjęcie ma niepoprawne wymiary.']);assert.ok(mem('256M').ok,'enough memory');
 // post_max_size 1M: at most 1 MiB − 64 KiB.
 const limit=1048576-65536,png=bridge({job:'image',gen:{w:300,h:300,format:'png'}}),pad=n=>Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(n-Buffer.from(png,'base64').length)]).toString('base64');
 const sized=bridge({job:'process',config,files:[{b64:pad(limit)},{b64:pad(limit+1)}]},['post_max_size=1M']);
 assert.deepEqual(sized.map(r=>r.status??200),[200,413]);assert.equal(sized[1].error,'Plik jest za duży.');
 assert.deepEqual(bridge({job:'process',config:off,files:[gen(300,300)]})[0],{error:'Funkcje społecznościowe są chwilowo niedostępne.',status:503},'no writable directory');
});
test('rules: a PDF by content (%PDF- in the first 1024 bytes, %%EOF in the last 2048), stored as sent and named by its hash',{skip},()=>{
 const pdf='%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n',junk='\x00'.repeat(500);
 const files=[pdf,junk+pdf,'x'.repeat(1100)+pdf,pdf+'y'.repeat(2100),'<html>%PDF-1.4</html>','%PDF-1.4 no end','',pdf.replace('%%EOF','%EOF')];
 const out=bridge({job:'pdf',config,files:files.map(text=>({text}))});
 assert.deepEqual(out.map(r=>r.status??200),[200,200,415,415,415,415,415,415]);assert.equal(out[2].error,'Nieobsługiwany format danych.');
 for(const i of [0,1]){const r=out[i].ok;assert.deepEqual(Object.keys(r),['f','b','at','hash']);assert.equal(r.f,r.hash+'.pdf');assert.equal(r.b,Buffer.byteLength(files[i],'latin1'));assert.equal(r.hash,sha(Buffer.from(files[i],'utf8')));}
 const limit=1048576-65536,body=n=>({text:pdf+'%'.repeat(n-pdf.length-7)+'\n%%EOF\n'});
 assert.deepEqual(bridge({job:'pdf',config,files:[body(limit),body(limit+1)]},['post_max_size=1M']).map(r=>r.status??200),[200,413]);
 assert.deepEqual(bridge({job:'pdf',config:off,files:[{text:pdf}]})[0].status,503);
});
test('limits: min(4 MB / 10 MB, post_max_size − 64 KB), 0 or -1 without a bound; features 0 without GD or a directory; the routes',{skip},()=>{
 const at=(post,cfg=config)=>bridge({job:'limits',config:cfg},post?['post_max_size='+post]:[]);
 const d=at('8M');assert.deepEqual([d.posterMax,d.rulesMax,d.limits],[4194304,8388608-65536,{poster:4194304,rules:8388608-65536}]);
 assert.deepEqual(d.routes,{'poster-upload':['POST','upload','required',4194304,['image/jpeg','image/png','image/webp']],'rules-upload':['POST','upload','required',8323072,['application/pdf']],
  'rules-text':['POST','session','required',20000*6+1024,null],'material-delete':['POST','session','required',1024,null],'material':['GET','peek','optional',null,null]});
 for(const post of ['0','-1','64M'])assert.deepEqual(at(post).limits,{poster:POSTER_MAX,rules:RULES_MAX},post);
 assert.deepEqual(at('1M').limits,{poster:983040,rules:983040});
 const tiny=at('32K');assert.deepEqual([tiny.limits,tiny.routes['poster-upload'][3],tiny.routes['rules-upload'][3]],[{poster:0,rules:0},1,1],'nothing fits: 0, and the routes still have a valid maximum');
 assert.deepEqual(at('8M',off).limits,{poster:0,rules:0},'no writable uploads directory');
 assert.deepEqual([POSTER_MAX,RULES_MAX,MATERIAL_KINDS],[4194304,10485760,['poster','rules']]);
});
test('directories: <uploads>/materials/<h[0..1]>/<h> with h = 32 hex of SHA-256 of the tournament id; other ids get none',{skip},()=>{
 const ids=['t-autumn-2026','0123456789abcdef0123456789abcdef','A_b-1','../etc','a/b','',' x','x'.repeat(41),'zażółć'];
 const out=bridge({job:'dir',config,ids});
 for(const [i,id] of ids.slice(0,3).entries()){const h=createHash('sha256').update(id).digest('hex').slice(0,32);assert.equal(out[i],`${uploads}/materials/${h.slice(0,2)}/${h}`);}
 assert.deepEqual(out.slice(3),Array(6).fill(null));
});
test('the rules file name: regulamin-<ASCII words of the tournament name>.pdf (.txt for a text)',{skip},()=>{
 const names=['Puchar Jesieni 2026','Łódź Cup — Żak & Wróbel','','"; rm -rf /','Turniej '+'bardzo-długi '.repeat(10),'李 王'];
 const out=bridge({job:'fileName',names});
 assert.deepEqual(out.slice(0,4),['regulamin-puchar-jesieni-2026.pdf','regulamin-lodz-cup-zak-wrobel.pdf','regulamin-turniej.pdf','regulamin-rm-rf.pdf']);
 for(const n of out){assert.match(n,/^regulamin-[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/);assert.ok(n.length<=74,n);}
 assert.deepEqual(bridge({job:'fileName',names:names.slice(0,1),ext:'txt'}),['regulamin-puchar-jesieni-2026.txt']);
});

// The rules text (PLAN-MATERIALY §4): Materials::text equals rulesText (Text::clean's steps without its line limit, a fixed point).
const TEXTS=['Regulamin zawodów','  Regulamin  \n','a\r\nb\rc','a\n\n\n\n\nb','a\n \n\t\n   \nb','\tWiersz\tz\ttabulatorem ','x\u202Ey\u2066z\u200By\uFEFF','👨\u200D👩\u200D👧 rodzina','e\u0301 → é','e\u200C\u0301',
 Array.from({length:40},(_,i)=>'linia '+(i+1)).join('\n'),'a\u0007b\u0000c\u0085d','\u00A0\u3000 spacje \u2028','','   \n\n  ','## Nagłówek\n\n- punkt\n1. numer\nhttps://example.com/regulamin?a=1&b=2','<script>alert(1)</script>',null,7,['x']];
test('rules text: Materials::text equals rulesText; the stored text is a fixed point; textMeta: 422 when empty, 413 above 20 000 characters',{skip},()=>{
 const out=bridge({job:'text',cases:TEXTS});
 TEXTS.forEach((s,i)=>assert.deepEqual(out[i],rulesText(s),JSON.stringify(s)));
 assert.deepEqual(out.slice(0,6),['Regulamin zawodów','Regulamin','a\nb\nc','a\n\n\nb','a\n\n\nb','Wiersz z tabulatorem']);
 assert.equal(out[6],'xyzy','bidi and zero-width characters removed');assert.equal(out[7],'👨\u200D👩\u200D👧 rodzina','the zero-width joiner of emoji stays');assert.equal(out[9],'é','format characters go before NFC, so the result is a fixed point');
 assert.equal(out[10].split('\n').length,40,'no line limit (unlike chat texts)');assert.deepEqual([out[11],out[13],out[14],out[17],out[18],out[19]],['abcd','','',null,null,null]);
 assert.equal(out[16],'<script>alert(1)</script>','kept as text: it is served as text/plain and shown as text, never as HTML');
 for(const s of out.filter(x=>typeof x==='string'))assert.equal(rulesText(s),s,'fixed point');
 const long='a'.repeat(RULES_TEXT_MAX),r=bridge({job:'textMeta',cases:['  Regulamin\r\n',long,long+'b','  \n ','',null,'a\n'+'\u0301'.repeat(3)]});
 assert.deepEqual(r.map(x=>x.status??200),[200,200,413,422,422,422,200]);assert.deepEqual([r[0].ok,r[3].error],['Regulamin','Wpisz treść regulaminu albo usuń regulamin.']);
 assert.equal(RULES_TEXT_MAX,20000);
});

// The strict meta and the views: Materials::meta/view against materialMeta/materialsView (the server's shape); src only in the demo.
const T={t:'Regulamin zawodów\n\n- punkt pierwszy',at:1793484000};
const META=[['poster',P],['rules',R],['poster',R],['rules',P],['banner',P],['poster',null],['poster',[P]],['poster','x'],['poster',{}],['poster',{...P,f:P.f.toUpperCase()}],['poster',{...P,f:'9'.repeat(32)+'.jpg'}],['poster',{...P,f:'9'.repeat(32)+'.png'}],
 ['poster',{...P,f:'9'.repeat(32)+'.webp\n'}],['poster',{...P,f:'/'+P.f}],['poster',{...P,w:0}],['poster',{...P,w:4096,h:1}],['poster',{...P,h:4097}],['poster',{...P,w:12.5}],['poster',{...P,w:'1240'}],['poster',{...P,c:'#2B4C7E'}],['poster',{...P,c:'#2b4c7'}],
 ['poster',{...P,at:0}],['poster',{...P,at:9999999999}],['poster',{...P,at:10000000000}],['poster',{...P,at:-1}],['poster',{...P,at:true}],['poster',{...P,x:1}],['poster',(({at,...x})=>x)(P)],['poster',{...P,src:'./demo/a.webp'}],
 ['rules',{...R,b:1}],['rules',{...R,b:10485760}],['rules',{...R,b:10485761}],['rules',{...R,b:0}],['rules',{...R,f:'8'.repeat(32)+'.pdf.pdf'}],['rules',{f:R.f,b:1}],['rules',{...R,w:1}],
 ['rules',T],['rules',{t:'x',at:0}],['rules',{t:'a'.repeat(20000),at:1}],['rules',{t:'a'.repeat(20001),at:1}],['rules',{t:'',at:1}],['rules',{t:' x',at:1}],['rules',{t:'a\r\nb',at:1}],['rules',{t:'a\n\n\n\nb',at:1}],['rules',{t:'a\u202Eb',at:1}],
 ['rules',{t:'e\u0301',at:1}],['rules',{t:7,at:1}],['rules',{t:'x'}],['rules',{t:'x',at:1,f:R.f}],['rules',{t:'x',b:1,at:1}],['rules',{...T,src:'./demo/a.pdf'}],['poster',T]];
test('meta and views: Materials::meta and Materials::view equal materialMeta and materialsView for the server\'s shape (PDF and text rules)',{skip},()=>{
 const out=bridge({job:'meta',cases:META.map(([kind,v])=>({kind,v}))});
 META.forEach(([kind,v],i)=>assert.deepEqual(out[i],materialMeta(kind,v),JSON.stringify([kind,v]).slice(0,120)));
 assert.deepEqual(out.map(x=>x!==null),[true,true,false,false,false,false,false,false,false,false,true,false,false,false,false,true,false,false,false,false,false,true,true,false,false,false,false,false,false,true,true,false,false,false,false,false,
  true,true,true,false,false,false,false,false,false,false,false,false,false,false,false,false]);
 assert.deepEqual(Object.keys(materialMeta('poster',{at:P.at,c:P.c,h:P.h,w:P.w,f:P.f})),['f','w','h','c','at'],'keys in order');
 const cases=[{poster:P,rules:R},{poster:P},{rules:R},{rules:T},{poster:P,rules:T},{rules:{t:'Zażółć 🙂',at:1}},{poster:{...P,f:'bad'},rules:R},{poster:R},null,[],'x',{},{poster:P,rules:R,extra:{}}];
 // The demo view also carries the text (it has no material route to fetch it from); the server's never does.
 const server=v=>{const o=structuredClone(v);if(o.rules)delete o.rules.text;return o;};
 assert.deepEqual(bridge({job:'view',cases}),cases.map(m=>server(materialsView(m))));
 assert.deepEqual(materialsView({poster:P,rules:R}),{poster:{v:'999999999999',w:1240,h:1754,color:'#2b4c7e'},rules:{v:'888888888888',size:48000,type:'pdf'}});
 const text=createHash('sha256').update(T.t).digest('hex').slice(0,12);
 assert.deepEqual(materialsView({rules:T}),{rules:{v:text,size:[...T.t].length,type:'text',text:T.t}});
 assert.deepEqual(bridge({job:'view',cases:[{rules:{t:'Zażółć 🙂',at:1}}]})[0].rules,{v:createHash('sha256').update('Zażółć 🙂').digest('hex').slice(0,12),size:8,type:'text'},'characters, not bytes');
});
test('the demo keeps the file itself (src: a file of dist/demo or a data URL) and adds it to the view; anything else is refused',()=>{
 const data='data:image/webp;base64,'+Buffer.from('RIFF....WEBPVP8 ').toString('base64'),pdf='data:application/pdf;base64,'+Buffer.from('%PDF-1.4 %%EOF').toString('base64');
 const ok=[['poster',{src:'./demo/poster-demo.webp',w:1240,h:1754,c:'#2b4c7e',at:1}],['poster',{src:data,w:10,h:20,c:'#000000',at:1}],['poster',{src:'./demo/a-b.jpg',w:1,h:1,c:'#ffffff',at:0}],['rules',{src:'./demo/regulamin-demo.pdf',b:48000,at:1}],['rules',{src:pdf,b:14,at:1}]];
 for(const [kind,v] of ok)assert.deepEqual(materialMeta(kind,v),v,kind+' '+v.src.slice(0,30));
 const bad=['https://example.com/p.webp','//example.com/p.webp','./demo/../x.webp','./demo/P.webp','../demo/p.webp','javascript:alert(1)','blob:http://x/1','data:image/svg+xml;base64,PHN2Zz4=','data:text/html;base64,PGI+','data:image/webp,raw',
  data+'\n','./demo/p.pdf',data+'A'.repeat(Math.ceil(POSTER_MAX/3)*4)];
 for(const src of bad)assert.equal(materialMeta('poster',{src,w:1,h:1,c:'#000000',at:1}),null,src.slice(0,40));
 for(const src of ['./demo/r.webp','data:image/webp;base64,AAAA','https://x/r.pdf'])assert.equal(materialMeta('rules',{src,b:1,at:1}),null,src);
 assert.equal(materialMeta('poster',{src:'./demo/a.webp',f:P.f,w:1,h:1,c:'#000000',at:1}),null,'f and src together');
 const view=materialsView({poster:ok[0][1],rules:ok[3][1]});
 assert.deepEqual(Object.keys(view.poster),['v','w','h','color','src']);assert.deepEqual(Object.keys(view.rules),['v','size','type','src']);assert.equal(view.rules.type,'pdf');
 assert.match(view.poster.v,/^[0-9a-f]{12}$/);assert.notEqual(view.poster.v,view.rules.v);assert.deepEqual(materialsView({poster:ok[0][1]}).poster.v,view.poster.v,'stable');
 assert.deepEqual([view.poster.src,view.rules.src,view.rules.size],['./demo/poster-demo.webp','./demo/regulamin-demo.pdf',48000]);
});
test('account deletion (Domain::forgetMember) drops the materials of every tournament the person created, others keep theirs',{skip},()=>{
 // final review of the materials, point 3: a poster may show people (R12); the sweep then deletes the unreferenced files.
 const db=initialWorkspace(),base=db.tournaments.find(x=>x.id==='t-winter-2027');
 const mk=(id,date,status)=>({...structuredClone(base),id,createdBy:'u-gone',date,status,entries:[],draws:{},hiddenBy:null,materials:{poster:P,rules:R}});
 db.tournaments.push(mk('t-gone-past','2020-05-05','finished'),mk('t-gone-next','2099-05-05','open'));
 const r=spawnSync(php,['tests/php-bridge-roles.php'],{input:JSON.stringify({job:'forgetMember',db,users:['u-gone']}),encoding:'utf8',maxBuffer:100_000_000});
 assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout).db;
 for(const id of ['t-gone-past','t-gone-next'])assert.ok(!('materials' in out.tournaments.find(x=>x.id===id)),id);
 assert.ok(out.tournaments.find(x=>x.id==='t-autumn-2026').materials,'a tournament of someone else keeps its materials');
});
test('demo seed and commands: t-autumn-2026 has the demo poster and rules; tournament.material sets a data URL, removes, refuses others',()=>{
 let db=initialWorkspace();const t=db.tournaments.find(x=>x.id==='t-autumn-2026');
 assert.deepEqual(t.materials,{poster:{src:'./demo/poster-demo.webp',w:1240,h:1754,c:'#4c4e59',at:1793484000},rules:{src:'./demo/regulamin-demo.pdf',b:41049,at:1793484000}});
 // The seed matches the real demo files: their byte size and the GD average colour Materials::poster would compute.
 assert.equal(statSync(new URL('../dist/demo/regulamin-demo.pdf',import.meta.url)).size,41049);
 assert.ok(db.tournaments.filter(x=>x.id!=='t-autumn-2026').every(x=>!('materials' in x)));
 for(const id of ['demo-admin','demo-editor','demo-club']){
  const v=publicWorkspace(db,db.users.find(u=>u.id===id)).tournaments.find(x=>x.id==='t-autumn-2026');
  assert.ok(!('materials' in v),id);assert.deepEqual([v.poster.w,v.poster.h,v.poster.color,v.poster.src,v.rules.size,v.rules.src],[1240,1754,'#4c4e59','./demo/poster-demo.webp',41049,'./demo/regulamin-demo.pdf'],id);
 }
 assert.ok(guestTournaments(db).find(x=>x.id==='t-autumn-2026').materials,'the guest view gets the materials of a staff tournament');
 const src='data:image/jpeg;base64,'+Buffer.from('\xff\xd8\xff').toString('base64');
 const r=execute(db,'demo-admin','tournament.material',{id:'t-autumn-2026',kind:'poster',value:{src,w:800,h:1131,c:'#102030',at:2}});db=r.db;
 assert.deepEqual(r.result,{kind:'poster',previous:null},'a demo file has no f');assert.equal(publicWorkspace(db,db.users[0]).tournaments.find(x=>x.id==='t-autumn-2026').poster.src,src);
 for(const [actor,p,status] of [['demo-club',{id:'t-autumn-2026',kind:'poster',value:null},403],['demo-editor',{id:'t-autumn-2026',kind:'rules',value:null},403],['demo-organizer',{id:'t-spring-2027',kind:'poster',value:null},404],
  ['demo-admin',{id:'t-autumn-2026',kind:'poster',value:{src:'https://evil.example/p.webp',w:1,h:1,c:'#000000',at:1}},400],['demo-admin',{id:'t-autumn-2026',kind:'poster',value:{src,w:1,h:1,c:'#000000',at:1,onload:'x'}},400]])
  assert.throws(()=>execute(db,actor,'tournament.material',p),e=>e.status===status,actor+' '+JSON.stringify(p).slice(0,60));
 db=execute(db,'demo-admin','tournament.material',{id:'t-autumn-2026',kind:'poster',value:null}).db;db=execute(db,'demo-admin','tournament.material',{id:'t-autumn-2026',kind:'rules',value:null}).db;
 assert.ok(!('materials' in db.tournaments.find(x=>x.id==='t-autumn-2026')));
 const own=execute(db,'demo-organizer','tournament.save',{name:'Turniej z plakatem',city:'Opole',date:'2027-06-01',mat:'Mata 1',status:'draft'});db=own.db;
 db=execute(db,'demo-organizer','tournament.material',{id:own.result.id,kind:'rules',value:{src:'./demo/regulamin-demo.pdf',b:48000,at:3}}).db;
 const mine=()=>publicWorkspace(db,db.users.find(u=>u.id==='demo-organizer')).tournaments.find(x=>x.id===own.result.id);
 assert.deepEqual([mine().rules.size,mine().rules.type],[48000,'pdf'],'the organizer\'s own draft');
 // A typed text replaces the PDF (one rules item); the demo view carries the text, cleaned by rulesText as the server's route cleans it.
 const text=rulesText('  Regulamin\r\n\r\n\r\n\r\n- punkt  ');
 let x=execute(db,'demo-organizer','tournament.material',{id:own.result.id,kind:'rules',value:{t:text,at:4}});db=x.db;
 assert.deepEqual([x.result,mine().rules.type,mine().rules.text,mine().rules.size],[{kind:'rules',previous:null},'text','Regulamin\n\n\n- punkt',19]);assert.ok(!('src' in mine().rules));
 assert.throws(()=>execute(db,'demo-organizer','tournament.material',{id:own.result.id,kind:'rules',value:{t:'  Regulamin\r\n',at:4}}),e=>e.status===400,'an uncleaned text');
 x=execute(db,'demo-organizer','tournament.material',{id:own.result.id,kind:'rules',value:{src:'./demo/regulamin-demo.pdf',b:48000,at:5}});db=x.db;
 assert.deepEqual([x.result.previous,mine().rules.type,'text' in mine().rules],[null,'pdf',false],'back to a PDF');
});

// AthleteView (PLAN-MATERIALY §2.1): available entries and the open list carry the sparse views; hidden, draft and closed-creator
// tournaments do not. dist/athlete-view.js gives the same once the frontend half (dist/materials.js) is installed.
test('AthleteView: poster and rules in entries[].tournament and open[] where everyone may read the files',{skip},async()=>{
 let db=initialWorkspace();
 db.users.push({id:'ath',clubId:null,email:'ath@example.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null},
  {id:'org',clubId:null,email:'org@example.test',role:'member',active:true,authVersion:1,organizer:true,organizerBlockedAt:null,organizerTrustedAt:1790000000});
 const run=(actor,type,p)=>{const r=execute(db,actor,type,p);db=r.db;return r.result;};
 const T=(actor,name,date)=>run(actor,'tournament.save',{name,city:'Opole',date,mat:'Mata 1',status:'open',selfEntry:true}).id;
 const a=T('demo-admin','Z plakatem','2030-07-01'),b=T('demo-admin','Ukryty z plakatem','2030-07-02'),c=T('org','Organizatora','2030-07-03'),d=T('demo-admin','Bez materiałów','2030-07-04');
 for(const id of [a,b,c])run('demo-admin','tournament.material',{id,kind:'poster',value:P});run('demo-admin','tournament.material',{id:a,kind:'rules',value:R});
 const text={t:'Regulamin turnieju organizatora',at:5};run('org','tournament.material',{id:c,kind:'rules',value:text});
 const self=run('ath','athlete.save',{name:'Adam Własny',birthDate:'1998-04-02',sex:'M',weight:70,height:178,gradeType:'cup',grade:5,club:{none:true},relation:'self'}).id;
 for(const id of [a,b,c,d])run('ath','entry.self',{tournamentId:id,profileId:self,events:['forms']});
 run('demo-admin','tournament.hide',{tournamentId:b,hidden:true,reason:'Sprawdzamy'});
 const views=state=>bridge({job:'workspace',db:state,cases:[{user:'ath',today:'2030-06-15'}]},[],'tests/php-bridge-athlete.php')[0];
 const v=views(db),entry=id=>v.entries.find(e=>e.tournament.id===id).tournament,open=id=>v.open.find(o=>o.id===id);
 const poster={v:'9'.repeat(12),w:1240,h:1754,color:'#2b4c7e'},rules={v:'8'.repeat(12),size:48000,type:'pdf'};
 assert.deepEqual([entry(a).poster,entry(a).rules,open(a).poster,open(a).rules],[poster,rules,poster,rules]);
 const typed={v:createHash('sha256').update(text.t).digest('hex').slice(0,12),size:text.t.length,type:'text'};
 assert.deepEqual([entry(c).poster,open(c).poster,entry(c).rules,open(c).rules],[poster,poster,typed,typed],'a typed text: its size and v, never the text');assert.ok(!('poster' in entry(d))&&!('poster' in open(d)));
 assert.deepEqual(Object.keys(entry(b)).sort(),['available','date','id','name'],'a hidden tournament: nothing more');assert.equal(open(b),undefined);
 // A blocked organizer (closedCreator): the material route refuses the files, so the view has no poster.
 const blocked=structuredClone(db);blocked.users.find(u=>u.id==='org').organizerBlockedAt=1790000001;
 const w=views(blocked);assert.ok(!('poster' in w.entries.find(e=>e.tournament.id===c).tournament));assert.ok(!('poster' in (w.open.find(o=>o.id===c)??{})));
 assert.ok(!JSON.stringify(v).includes('.webp')&&!JSON.stringify(v).includes('.pdf')&&!JSON.stringify(v).includes(text.t),'stored names and the text never leave');
 // The demo's view may carry the text (no material route there); everything else equals the server's.
 if(FRONTEND){const {athleteView}=await import('../dist/athlete-view.js');const js=JSON.parse(JSON.stringify(athleteView(db,{id:'ath'},'2030-06-15')));
  for(const o of [...js.entries.map(e=>e.tournament),...js.open])if(o.rules)delete o.rules.text;assert.deepEqual(js,v);}
});
