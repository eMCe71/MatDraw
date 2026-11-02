// Tournament materials, frontend (docs/plan/PLAN-MATERIALY.md, sections 1, 2 and 4): dist/materials.js and the projections of
// dist/guest-view.js and dist/athlete-view.js.
//  - Unit checks: addresses of the material route (src in the demo), sizes ("PDF, 1,2 MB"), the PDF sniff (%PDF- at the start,
//    %%EOF at the end), poster file checks and the WebP -> JPEG fallback of the encoder, routing of dropped files, the renderer of
//    typed rules (paragraphs, headings, lists, https links only, escaping), SHA-256 versions as the server computes them, the sparse
//    poster/rules fields of the guest and athlete views, the templates' escaping.
//  - Browser checks on the static demo (MATDRAW_BROWSER_TESTS=1, Playwright + Chromium): a poster and a PDF added in the settings
//    dialog with setInputFiles, the card thumbnail, the guest page with the poster and the rules button, the full-screen preview
//    (dialog, focus trap, Escape, focus back), PDF -> text -> PDF with the reader, a new tournament with waiting files, no horizontal
//    overflow at 393 px. They need the demo command tournament.material of dist/workspace.js (backend slice) and say so when skipped.
//  - PHP build (MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh, MATDRAW_TEST_URL): the Administrator adds a real JPEG and a PDF
//    through the dialog; a guest gets the poster (HTTP 200 image) and the rules (application/pdf); then typed rules, read as a guest.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
globalThis.BroadcastChannel=undefined;// me.js would keep the process alive
const {registry,h,SafeHtml}=await import('../dist/registry.js');
const {t,setLanguage,getLanguage}=await import('../dist/i18n.js');setLanguage('pl',{persist:false});
registry.provide('ui',{T:t,icon:name=>h`<svg data-icon="${name}"></svg>`});
const M=await import('../dist/materials.js');
const {publicMaterials,sha256Hex,demoVersion,guestUpcoming,guestTournament}=await import('../dist/guest-view.js');
const {projectAthleteView,athleteView}=await import('../dist/athlete-view.js');
const Client=await import('../dist/client.js');
const DIST=fileURLToPath(new URL('../dist/',import.meta.url));
const inLanguage=(lang,fn)=>{const before=getLanguage();setLanguage(lang,{persist:false});try{return fn();}finally{setLanguage(before,{persist:false});}};
const MB=1024*1024,NB=' ';
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');

test('sizes: Polish decimal comma, English dot, KB under a megabyte, the limits in whole MB',()=>{
 inLanguage('pl',()=>{
  assert.equal(M.formatSize(1.2*MB),'1,2'+NB+'MB');assert.equal(M.formatSize(4194304),'4'+NB+'MB');assert.equal(M.formatSize(10485760),'10'+NB+'MB');
  assert.equal(M.formatSize(41049),'40'+NB+'KB');assert.equal(M.formatSize(999*1024),'1'+NB+'MB');assert.equal(M.formatSize(0),'1'+NB+'KB');
  assert.equal(M.rulesLabel({type:'pdf',size:1.2*MB}),'Regulamin (PDF, 1,2'+NB+'MB)');
  assert.equal(M.rulesLabel({type:'text',size:500}),'Regulamin','typed rules are just "Regulamin"');
 });
 inLanguage('en',()=>{
  assert.equal(M.formatSize(1.2*MB),'1.2'+NB+'MB');
  assert.equal(M.rulesLabel({type:'pdf',size:1.2*MB}),'Rules (PDF, 1.2'+NB+'MB)');assert.equal(M.rulesLabel({type:'text'}),'Rules');
 });
});

test('addresses: the material route of the contract in API mode, src in the demo, nothing without a version or a src',()=>{
 const t={id:'t-1',name:'Puchar',poster:{v:'0123456789ab',w:1240,h:1754,color:'#494B55'},rules:{v:'ba9876543210',size:41049,type:'pdf'}};
 assert.equal(M.posterUrl(t,'sm',{demo:false}),'./api/index.php?route=material&t=t-1&k=poster&s=sm&v=0123456789ab');
 assert.equal(M.posterUrl(t,'lg',{demo:false}),'./api/index.php?route=material&t=t-1&k=poster&s=lg&v=0123456789ab');
 assert.equal(M.rulesUrl(t,{demo:false}),'./api/index.php?route=material&t=t-1&k=rules&v=ba9876543210');
 assert.equal(M.rulesUrl({...t,rules:{v:'x',size:9,type:'text'}},{demo:false}),'./api/index.php?route=material&t=t-1&k=rules&v=x','typed rules come from the same route');
 assert.equal(M.posterUrl(t,'sm',{demo:true}),null,'the demo has no route');
 const demo={...t,poster:{...t.poster,src:'./demo/poster-demo.webp'},rules:{...t.rules,src:'./demo/regulamin-demo.pdf'}};
 assert.equal(M.posterUrl(demo,'lg',{demo:true}),'./demo/poster-demo.webp');assert.equal(M.rulesUrl(demo,{demo:true}),'./demo/regulamin-demo.pdf');
 assert.equal(M.posterOf(t).color,'#494b55');assert.equal(M.posterOf({poster:{v:'a',w:0,h:5}}),null,'no size, no poster');
 assert.equal(M.posterOf({poster:{v:'a',w:3,h:4,color:'red;x'}}).color,'#e9eff6','a colour that is not #rrggbb is replaced');
 assert.equal(M.rulesOf({rules:{v:'a',size:3}}).type,'pdf');assert.deepEqual(M.rulesOf({rules:{v:'a',size:3,type:'text',text:'x'}}),{v:'a',size:3,type:'text',src:null,text:'x'});
 for(const bad of ['javascript:alert(1)','http://evil.example/x.pdf','../secret.pdf','./demo/../x','data:text/html;base64,PHNjcmlwdD4=',' ./demo/x.pdf'])assert.equal(M.safeSrc(bad),null,bad);
 for(const ok of ['./demo/poster-demo.webp','data:image/jpeg;base64,/9j/4AAQ','data:application/pdf;base64,JVBERi0='])assert.equal(M.safeSrc(ok),ok);
 assert.deepEqual(M.smSize(1240,1754),[480,679]);assert.deepEqual(M.lgSize(1240,1754),[1240,1754]);assert.deepEqual(M.lgSize(4000,3000),[2000,1500]);
 assert.deepEqual(M.fitSize(4032,3024),{w:2400,h:1800});assert.deepEqual(M.fitSize(800,600),{w:800,h:600},'never enlarged');
 assert.deepEqual(M.limitsOf({materials:{poster:4194304,rules:'0'}}),{poster:4194304,rules:0});assert.equal(M.limitsOf({}),null);
 assert.equal(M.slug('Puchar Jesieni 2026 — Łódź'),'puchar-jesieni-2026-lodz');assert.equal(M.slug('***'),'turniej');
});

test('PDF checks: type or extension, size, %PDF- in the first 1024 bytes and %%EOF in the last 2048',async()=>{
 const pdf=readFileSync(DIST+'demo/regulamin-demo.pdf');
 assert.ok(M.isPdfStart(pdf.subarray(0,1024))&&M.hasPdfEnd(pdf.subarray(-2048)));
 assert.ok(M.isPdfStart(Buffer.concat([Buffer.alloc(300,32),Buffer.from('%PDF-1.7')])),'a short preamble is allowed, as readers allow it');
 assert.ok(!M.isPdfStart(Buffer.concat([Buffer.alloc(1100,32),Buffer.from('%PDF-1.7')])));assert.ok(!M.isPdfStart(new TextEncoder().encode('<html>')));
 assert.ok(!M.hasPdfEnd(Buffer.from('%PDF-1.4 truncated')));
 assert.equal(await M.checkRules(new File([pdf],'regulamin.pdf',{type:'application/pdf'})),true);
 assert.equal(await M.checkRules(new File([pdf],'regulamin.pdf',{type:'application/octet-stream'})),true,'phones send octet-stream: the name decides');
 const fails=async(file,max,re)=>{await assert.rejects(M.checkRules(file,max),e=>re.test(e.message)&&e.materials===true);};
 await fails(new File(['x'],'a.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),MB,/musi być plikiem PDF/);
 await fails(new File([],'a.pdf',{type:'application/pdf'}),MB,/pusty/);
 await fails(new File([pdf],'a.pdf',{type:'application/pdf'}),1000,/za duży \(maks\. 1 KB\)/);
 await fails(new File(['<html>not a pdf</html>'],'a.pdf',{type:'application/pdf'}),MB,/nie jest prawidłowy/);
 await fails(new File([pdf.subarray(0,pdf.length-200)],'a.pdf',{type:'application/pdf'}),MB,/niekompletny/);
});

test('poster files: pictures only (no PDF or SVG yet, with a friendly hint), the WebP check and the JPEG 0.88 fallback',async()=>{
 const message=file=>{try{M.checkPosterFile(file);return null;}catch(e){return e.message;}};
 assert.match(message({name:'plakat.pdf',type:'application/pdf',size:10}),/PDF nie jest jeszcze obsługiwany/);
 assert.match(message({name:'plakat.svg',type:'image/svg+xml',size:10}),/SVG/);
 assert.match(message({name:'notatki.txt',type:'text/plain',size:10}),/To nie jest obraz/);
 assert.match(message({name:'ogromny.jpg',type:'image/jpeg',size:M.SOURCE_MAX+1}),/za duże/);
 for(const ok of [{name:'IMG_0001.HEIC',type:'image/heic',size:5*MB},{name:'a.jpg',type:'image/jpeg',size:MB},{name:'a.webp',type:'',size:MB}])assert.equal(message(ok),null,ok.name);
 // The encoder trusts the blob's type: Safari answers toBlob('image/webp') with a PNG, which means "no WebP".
 const calls=[],writer=support=>async(canvas,type,quality)=>{calls.push([type,quality]);return support.includes(type)?{type,size:100}:type==='image/webp'?{type:'image/png',size:900}:null;};
 assert.equal((await M.encode({},0.86,writer(['image/webp','image/jpeg']))).type,'image/webp');assert.deepEqual(calls.splice(0),[['image/webp',0.86]]);
 assert.equal((await M.encode({},0.86,writer(['image/jpeg']))).type,'image/jpeg');assert.deepEqual(calls.splice(0),[['image/webp',0.86],['image/jpeg',0.88]]);
 assert.equal((await M.encode({},0.74,writer(['image/jpeg']))).type,'image/jpeg');assert.deepEqual(calls.splice(0),[['image/webp',0.74],['image/jpeg',0.74]],'later steps lower the JPEG quality too');
 assert.equal(await M.encode({},0.86,writer([])),null,'neither format: the caller explains');
 assert.deepEqual(M.STEPS[0],[2400,0.86]);
 assert.equal(M.averageColor(new Uint8ClampedArray([255,0,0,255,0,0,255,255])),'#800080');assert.equal(M.averageColor([]),'#e9eff6');
 // Dropped or pasted files: a picture to the poster anywhere, a PDF to the rules (on the poster tile it gets the PDF-poster hint).
 const f=(name,type)=>({name,type});
 assert.equal(M.kindFor(f('a.png','image/png'),'rules'),'poster');assert.equal(M.kindFor(f('a.pdf','application/pdf'),null),'rules');
 assert.equal(M.kindFor(f('a.pdf','application/pdf'),'poster'),'poster');assert.equal(M.kindFor(f('a.docx','application/msword'),'rules'),'rules');
 assert.equal(M.kindFor(f('a.docx','application/msword'),null),'poster');
});

test('typed rules: paragraphs, ## headings, - and • lists, 1. lists, https links only, everything else escaped text',()=>{
 const html=s=>String(M.renderRules(s));
 assert.equal(html('Pierwszy akapit.\nDruga linia.\n\nDrugi akapit.'),'<p>Pierwszy akapit.<br>Druga linia.</p><p>Drugi akapit.</p>');
 assert.equal(html('## Zgłoszenia\nDo 7 listopada.'),'<h3>Zgłoszenia</h3><p>Do 7 listopada.</p>');
 assert.equal(html('- jeden\n• dwa\n- trzy'),'<ul><li>jeden</li><li>dwa</li><li>trzy</li></ul>');
 assert.equal(html('1. raz\n2. dwa'),'<ol><li>raz</li><li>dwa</li></ol>');assert.equal(html('3) trzy\n4) cztery'),'<ol start="3"><li>trzy</li><li>cztery</li></ol>');
 assert.equal(html('Lista:\n- a\n- b\nKoniec.'),'<p>Lista:</p><ul><li>a</li><li>b</li></ul><p>Koniec.</p>');
 assert.equal(html('#hashtag i 2026 rok'),'<p>#hashtag i 2026 rok</p>','# without a space is text');
 assert.equal(html('Zobacz https://example.com/a?b=1&c=2.'),'<p>Zobacz <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow ugc">https://example.com/a?b=1&amp;c=2</a>.</p>');
 assert.equal(html('(https://example.com/x)'),'<p>(<a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow ugc">https://example.com/x</a>)</p>','an unmatched bracket stays outside');
 assert.equal(html('https://pl.wikipedia.org/wiki/Taekwondo_(sport)'),'<p><a href="https://pl.wikipedia.org/wiki/Taekwondo_(sport)" target="_blank" rel="noopener noreferrer nofollow ugc">https://pl.wikipedia.org/wiki/Taekwondo_(sport)</a></p>');
 for(const s of ['http://example.com','javascript:alert(1)','data:text/html,<b>x</b>','JAVASCRIPT:alert(1)','https://user:pw@example.com/','ftp://example.com'])assert.ok(!html(s).includes('<a '),s);
 const evil=html('<img src=x onerror=alert(1)>\n## <script>alert(1)</script>\n- "><svg onload=alert(1)>\nhttps://example.com/"onmouseover="alert(1)');
 assert.deepEqual([...new Set([...evil.matchAll(/<(\w+)/g)].map(m=>m[1]))].filter(tag=>!['p','h3','ul','ol','li','a','br'].includes(tag)),[],evil);
 assert.ok(!/<[^>]*\son\w+\s*=/i.test(evil),'no event handler attribute in any tag: '+evil);
 assert.match(evil,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(evil,/<h3>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h3>/);
 assert.ok(M.renderRules('x') instanceof SafeHtml);
 // Cleaning as the server does (Materials::text: CRLF, tabs, controls, at most two empty lines, trimmed) and counting characters.
 assert.equal(M.cleanRulesText('  a\r\nb\rc  \n\n\n\n\nd\u0007\tx  '),'a\nb\nc  \n\n\nd x');
 assert.equal(M.cleanRulesText('  Regulamin\r\n\r\n\r\n\r\n- punkt  '),'Regulamin\n\n\n- punkt','the backend test case');assert.equal(M.cleanRulesText(42),'42');assert.equal(M.cleanRulesText('\ud800'),'','ill-formed text is refused');assert.equal(M.textLength('zażółć 🥋'),8);
});

test('SHA-256 and the sparse poster/rules of the guest and athlete views (PHP shape: f; demo: src; typed text: t)',()=>{
 for(const s of ['','abc','Zażółć gęślą jaźń 🥋','a'.repeat(55),'a'.repeat(56),'a'.repeat(64),'x'.repeat(5000)])assert.equal(sha256Hex(s),sha(s),'length '+s.length);
 assert.match(demoVersion('./demo/x.pdf'),/^[0-9a-f]{12}$/);
 const f='0123456789abcdef0123456789abcdef';
 assert.deepEqual(publicMaterials({poster:{f:f+'.webp',w:1240,h:1754,c:'#494b55',at:1},rules:{f:f+'.pdf',b:41049,at:2}}),{poster:{v:'0123456789ab',w:1240,h:1754,color:'#494b55'},rules:{v:'0123456789ab',size:41049,type:'pdf'}});
 // Exactly the server's meta (Materials::meta): anything else gives nothing, as GuestView and AthleteView.
 for(const bad of [{poster:{f:'x.webp',w:1,h:1,c:'#000000',at:1}},{poster:{f:f+'.webp',w:1,h:1,c:'#ABCDEF',at:1}},{poster:{f:f+'.webp',w:1,h:1,c:'#000000',at:1,extra:1}},{poster:{f:f+'.gif',w:1,h:1,c:'#000000',at:1}},
  {poster:{f:f+'.webp',w:5000,h:1,c:'#000000',at:1}},{rules:{f:f+'.pdf',b:0,at:1}},{rules:{t:'  nieoczyszczony',at:1}},{rules:{t:'x',at:1,v:'a'}},{poster:{src:'https://evil.example/p.webp',w:1,h:1,c:'#000000',at:1}},{poster:{src:'./demo/a.webp',f:f+'.webp',w:1,h:1,c:'#000000',at:1}}])
  assert.deepEqual(publicMaterials(bad),{},JSON.stringify(bad));
 assert.deepEqual(publicMaterials({rules:{t:'## Zasady\n- jeden',at:3}}),{rules:{v:sha('## Zasady\n- jeden').slice(0,12),size:17,type:'text'}},'the text itself never leaves');
 const demo=publicMaterials({poster:{src:'./demo/poster-demo.webp',w:1240,h:1754,c:'#494b55',at:1},rules:{src:'./demo/regulamin-demo.pdf',b:41049,at:1}});
 assert.equal(demo.poster.src,'./demo/poster-demo.webp');assert.equal(demo.rules.src,'./demo/regulamin-demo.pdf');assert.match(demo.poster.v,/^[0-9a-f]{12}$/);
 assert.deepEqual(publicMaterials(null),{});assert.deepEqual(publicMaterials({rules:{t:'',at:1}}),{});
 const base={id:'t1',name:'A',city:'B',date:'2030-06-20',status:'open',selfEntry:true,entries:[],draws:{},materials:{poster:{f:f+'.jpg',w:800,h:600,c:'#102030',at:1}}};
 const plain={...base,id:'t2',materials:undefined};
 const list=guestUpcoming([base,plain],'2030-06-15').tournaments;
 assert.deepEqual(list[0].poster,{v:'0123456789ab',w:800,h:600,color:'#102030'});assert.ok(!('poster' in list[1])&&!('rules' in list[1]),'sparse');
 assert.deepEqual(guestTournament([base],'t1','2030-06-15').tournament.poster,list[0].poster);assert.ok(!('materials' in guestTournament([base],'t1','2030-06-15').tournament));
 const view=projectAthleteView([{id:'p1',name:'Ola',birthDate:'2010-01-01',sex:'F',relation:'guardian'}],[{...base,community:false,trusted:true,closed:false,entries:[{id:'p1',profileId:'p1',name:'Ola',events:['forms']}]}],[],'2030-06-15',{});
 assert.deepEqual(view.open[0].poster,list[0].poster);assert.deepEqual(view.entries[0].tournament.poster,list[0].poster);
 const db={clubs:[],profiles:[{id:'p1',ownerId:'u1',name:'Ola',clubId:null,birthDate:'2010-01-01'}],users:[{id:'org',role:'member',active:true,organizer:true,organizerBlockedAt:null}],flags:{trustRequired:false},tournaments:[{...base,createdBy:'x',entries:[]},{...base,id:'t3',createdBy:'org',entries:[]}]};
 assert.deepEqual(athleteView(db,{id:'u1'},'2030-06-15').open.map(o=>o.poster),[list[0].poster,list[0].poster],'athleteView passes materials on');
 db.users[0].organizerBlockedAt=1;
 assert.deepEqual(athleteView(db,{id:'u1'},'2030-06-15').open.map(o=>o.poster),[list[0].poster,undefined],'a closed creator: no materials (the route refuses its files)');
});

test('templates: thumbnails in a 3:4 frame with intrinsic sizes, lazy; the rules as a PDF link or a reader button; everything escaped',()=>{
 const t={id:'t"1',name:'<b>Puchar</b> & "Jesień"',poster:{v:'v1',w:1240,h:1754,color:'#494b55',src:'./demo/poster-demo.webp'},rules:{v:'v2',size:41049,type:'pdf',src:'./demo/regulamin-demo.pdf'}};
 const thumb=String(M.thumb(t,{cls:'mat-card'}));
 assert.match(thumb,/^<button type="button" class="mat-thumb mat-card" style="--poster:#494b55" data-action="material-preview" data-id="t&quot;1" aria-label="Powiększ plakat: &lt;b&gt;Puchar&lt;\/b&gt; &amp; &quot;Jesień&quot;">/);
 assert.match(thumb,/<img class="mat-img" src="\.\/demo\/poster-demo\.webp" alt="" width="1240" height="1754" loading="lazy" decoding="async">/);
 assert.ok(!thumb.includes('<b>'));
 assert.equal(String(M.thumb({...t,poster:null})),'','no poster, no thumbnail');
 assert.match(String(M.thumb(t,{preview:false})),/^<span class="mat-thumb " style="--poster:#494b55" aria-hidden="true">/);
 const pdf=String(M.rulesLink(t,{cls:'tournament-rules',label:'Regulamin'}));
 assert.match(pdf,/^<a class="tournament-rules" href="\.\/demo\/regulamin-demo\.pdf" target="_blank" rel="noopener" data-mat-open="rules" title="Regulamin \(PDF, 40 KB\)">/);
 const text=String(M.rulesLink({...t,rules:{v:'v3',size:12,type:'text'}},{cls:'btn secondary'}));
 assert.match(text,/^<button type="button" class="btn secondary" data-action="material-rules" data-id="t&quot;1" aria-haspopup="dialog">/);assert.match(text,/<span>Regulamin<\/span><\/button>$/);
 const actions=String(M.guestActions(t));
 assert.match(actions,/<a class="btn secondary mat-download" href="\.\/demo\/poster-demo\.webp" download="plakat-b-puchar-b-jesien" data-mat-open="poster">/);
 assert.match(String(M.guestPoster(t)),/<img class="mat-img" src="\.\/demo\/poster-demo\.webp" alt="Plakat: &lt;b&gt;Puchar&lt;\/b&gt; &amp; &quot;Jesień&quot;" width="1240" height="1754" decoding="async" fetchpriority="high">/);
 const api={...t,poster:{v:'abc',w:4000,h:3000,color:'#000000'}};
 const hero=inLanguage('pl',()=>String(M.guestPoster(api)));
 assert.ok(!hero.includes('src="null"'),'the demo without src draws nothing');
 const apiCard=String(M.cardPoster({id:'x',name:'X'},{manager:false}));assert.match(apiCard,/tournament-symbol/,'no poster and not a manager: the trophy symbol');
});

test('client: XHR upload with the client headers, demo features.materials, the demo command path is the only write in demo mode',async()=>{
 const src=readFileSync(DIST+'client.js','utf8'),fn=src.slice(src.indexOf('export function upload('),src.indexOf('/** Session request for feature routes'));
 assert.match(fn,/new XMLHttpRequest\(\)/);assert.match(fn,/xhr\.upload\.addEventListener\('progress'/);
 for(const h of ['Accept:\'application/json\'','...CLIENT_HEADER','\'Content-Type\':contentType','\'X-CSRF-Token\':csrf'])assert.ok(fn.includes(h),h);
 assert.match(fn,/if\(result\?\.csrf\)csrf=result\.csrf;/);assert.match(fn,/reject\(failure\(result,xhr\.status\)\)/,'errors as call(): status, code, client_outdated');
 assert.deepEqual(Client.DEMO_MATERIALS,{poster:4194304,rules:10485760});
 await assert.rejects(Client.upload({route:'poster-upload',t:'x'},{body:new Blob(['x'])}),/niedostępna w wersji demonstracyjnej/);
 const m=readFileSync(DIST+'materials.js','utf8');
 assert.match(m,/Client\.command\('tournament\.material',\{id,kind,value\}/);
 assert.match(m,/value=\{src:item\.demo\.src,w:item\.demo\.w,h:item\.demo\.h,c:item\.color,at\}/,'demo poster meta as stored: {src,w,h,c,at}');
 assert.match(m,/value=\{t:cleanRulesText\(item\.text\),at\}/,'demo text meta as stored: {t,at}');
 assert.match(m,/value=\{src:'data:application\/pdf;base64,'\+String\(await readDataUrl\(item\)\)\.split\(','\)\[1\],b:item\.size,at\}/,'demo PDF meta as stored: {src,b,at}, the type forced to PDF');
 assert.match(m,/Client\.request\('rules-text',\{method:'POST',body:\{t:id,text:item\.text\}\}\)/);assert.match(m,/Client\.request\('material-delete',\{method:'POST',body:\{t:id,kind\}\}\)/);
 assert.match(m,/Client\.upload\(\{route:routes\[kind\],t:id\}/);assert.match(m,/routes=\{poster:'poster-upload',rules:'rules-upload'\}/);
 const app=readFileSync(DIST+'app.js','utf8');
 assert.match(app,/function applyWorkspace\(res\)\{if\(res\?\.workspace&&!\(Number\(res\.workspace\.revision\)<Number\(workspace\?\.revision\)\)\)\{workspace=res\.workspace;syncState\(\);\}/,'an answer is applied like a command, never an older one');
 assert.match(app,/await Materials\.settled\(form\);const fresh=!form\.dataset\.id;/);assert.match(app,/keep=!await Materials\.flush\(form,result\.id\);/);
 assert.match(readFileSync(DIST+'index.html','utf8'),/<link rel="stylesheet" href="\.\/settings\.css"><link rel="stylesheet" href="\.\/materials\.css">/);
});

test('demo assets: a 1240x1754 WebP poster and a one-page PDF marked as an example, small enough for the demo',()=>{
 const webp=readFileSync(DIST+'demo/poster-demo.webp');
 assert.equal(webp.toString('latin1',0,4),'RIFF');assert.equal(webp.toString('latin1',8,12),'WEBP');assert.ok(webp.length<260000,webp.length+' bytes');
 const chunk=webp.toString('latin1',12,16);let w,hh;
 if(chunk==='VP8 '){w=webp.readUInt16LE(26)&0x3fff;hh=webp.readUInt16LE(28)&0x3fff;}else if(chunk==='VP8L'){const b=webp.readUInt32LE(21);w=(b&0x3fff)+1;hh=((b>>14)&0x3fff)+1;}else{w=1+webp.readUIntLE(24,3);hh=1+webp.readUIntLE(27,3);}
 assert.deepEqual([w,hh],[1240,1754]);
 const pdf=readFileSync(DIST+'demo/regulamin-demo.pdf');
 assert.ok(M.isPdfStart(pdf.subarray(0,1024))&&M.hasPdfEnd(pdf.subarray(-2048)));assert.ok(pdf.length<80000,pdf.length+' bytes');
});

// ---- browser checks ----
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.pdf':'application/pdf','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(DIST,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
/** Whether the demo domain (dist/workspace.js, backend slice) runs tournament.material: before the slices are merged it does not. */
async function demoCommand(){
 try{const {initialWorkspace,execute}=await import('../dist/workspace.js');return execute(initialWorkspace(),'demo-admin','tournament.material',{id:'t-winter-2027',kind:'rules',value:null})?.result?.kind==='rules';}
 catch{return false;}
}
const DEMO_READY=chromium?await demoCommand():false;
const browserSkip=!chromium?'set MATDRAW_BROWSER_TESTS=1 (needs playwright)':!DEMO_READY?'the demo command tournament.material arrives with the backend slice (dist/workspace.js)':false;
const IOS='Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const PHONE={viewport:{width:393,height:852},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:IOS};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
async function open(browser,url,options={}){
 const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block',...options});
 await ctx.addInitScript(()=>{try{localStorage.setItem('matdraw.language','pl');}catch{}});
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('dialog',d=>{errors.push('dialog '+d.message());d.dismiss();});
 await page.goto(url);await page.waitForSelector('[data-action="demo-login"]');return {ctx,page,errors};
}
const login=async(page,role)=>{await page.click(`[data-action="demo-login"][data-role="${role}"]`);await page.waitForSelector('.app-shell');};
const logout=async page=>{await page.evaluate(()=>document.querySelector('[data-action="logout"]')?.click());await page.waitForSelector('[data-action="demo-login"]');};
const settings=async(page,id)=>{await page.click(`main .tournament-card-actions [data-action="edit-tournament"][data-id="${id}"]`);await page.waitForSelector('#tournament-form [data-materials]');};

test('static demo: poster and PDF in the settings dialog, the card, the guest page, the preview dialog and its focus, 393 px',{skip:browserSkip,timeout:240000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch();
 try{
  for(const options of [{},PHONE]){
   const {ctx,page,errors}=await open(browser,url,options),phone=!!options.isMobile;
   await login(page,'admin');await settings(page,'t-winter-2027');
   assert.equal(await page.locator('.mat-poster .mat-pick').count(),1,'an empty poster tile');
   await page.setInputFiles('[data-material-input="poster"]',DIST+'brand/og-image.jpg');
   await page.waitForSelector('.mat-poster [data-action="material-remove"]',{timeout:30000});
   await page.setInputFiles('[data-material-input="rules"]',DIST+'demo/regulamin-demo.pdf');
   await page.waitForSelector('.mat-rules.is-pdf.has-file [data-action="material-remove"]',{timeout:30000});
   assert.match(await page.textContent('.mat-rules .mat-label'),/^Regulamin \(PDF, 40 KB\)$/);
   if(phone)assert.equal(await overflow(page),0,'the dialog with materials fits 393 px');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));
   const card=page.locator('.tournament-card',{has:page.locator('[data-id="t-winter-2027"]')}).first();
   await card.locator('.mat-thumb img').waitFor();
   assert.ok(await card.locator('.mat-thumb img').evaluate(img=>img.complete&&img.naturalWidth>0),'the thumbnail loads');
   assert.equal(await card.locator('.tournament-rules').getAttribute('target'),'_blank');
   // a manager without a poster sees the quiet tile, which opens the dialog at the materials
   const tile=page.locator('.mat-add-tile').first();
   if(await tile.count()){await tile.click();await page.waitForSelector('#tournament-materials');assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'material-pick');await page.keyboard.press('Escape');}
   await logout(page);
   await page.goto(url+'#guest?t=t-winter-2027');await page.click('.promo [data-action="close-modal"]');await page.waitForSelector('.mat-hero img');
   assert.ok(await page.locator('.mat-hero img').evaluate(img=>new Promise(r=>img.complete?r(img.naturalWidth>0):img.addEventListener('load',()=>r(img.naturalWidth>0)))),'the large poster loads');
   assert.match(await page.textContent('.mat-actions'),/Regulamin \(PDF, 40 KB\)/);assert.match(await page.textContent('.mat-actions'),/Pobierz plakat/);
   if(phone)assert.equal(await overflow(page),0,'the guest page with a poster fits 393 px');
   await page.click('.mat-hero');await page.waitForSelector('.mat-viewer[role="dialog"]');
   const dialog=await page.evaluate(()=>{const d=document.querySelector('.mat-viewer');return {modal:d.getAttribute('aria-modal'),label:document.getElementById(d.getAttribute('aria-labelledby'))?.textContent,focus:document.activeElement?.dataset.matViewer,alt:d.querySelector('img').alt,inert:document.querySelector('#app').inert};});
   assert.deepEqual(dialog,{modal:'true',label:'Plakat: Puchar Zimy 2027',focus:'close',alt:'Plakat: Puchar Zimy 2027',inert:true});
   for(let i=0;i<5;i++){await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>!!document.activeElement?.closest('.mat-viewer')),'Tab stays in the preview');}
   await page.keyboard.press('Shift+Tab');assert.ok(await page.evaluate(()=>!!document.activeElement?.closest('.mat-viewer')));
   if(phone)assert.equal(await overflow(page),0,'the preview fits 393 px');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.mat-viewer'));
   assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('mat-hero')),true,'focus returns to the poster');
   assert.equal(await page.evaluate(()=>document.querySelector('#app').inert),false);
   await page.click('.mat-hero');await page.click('.mat-viewer-close');await page.waitForFunction(()=>!document.querySelector('.mat-viewer'));
   assert.deepEqual(errors,[]);await ctx.close();
  }
 }finally{await browser.close();server.close();}
});

test('static demo: rules PDF -> text -> PDF, the reader (393 px, no overflow), a new tournament with waiting files',{skip:browserSkip,timeout:240000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch();
 try{
  const {ctx,page,errors}=await open(browser,url,PHONE);
  await login(page,'admin');await settings(page,'t-winter-2027');
  await page.setInputFiles('[data-material-input="rules"]',DIST+'demo/regulamin-demo.pdf');await page.waitForSelector('.mat-rules.is-pdf.has-file [data-action="material-remove"]',{timeout:30000});
  await page.click('[data-action="material-rules-mode"][data-mode="text"]');await page.waitForSelector('[data-mat-text]');
  assert.match(await page.textContent('.mat-rules .mat-note'),/zastąpi obecny regulamin PDF/);
  assert.equal(await page.$eval('[data-mat-text]',el=>parseFloat(getComputedStyle(el).fontSize)),16,'16px text on a phone');
  await page.fill('[data-mat-text]','## Zgłoszenia\nDo 7 lutego.\n\n- Ważenie od 7:30\n- Start o 9:00\n\nhttps://example.com/kategorie <img src=x onerror=alert(1)>');
  assert.match(await page.textContent('[data-mat-count]'),/^\d+ \/ 20 000 znaków$/);
  await page.click('[data-action="material-text-preview"]');assert.equal(await page.locator('#mat-text-preview li').count(),2);
  await page.click('[data-action="material-text-preview"]');await page.click('[data-action="material-text-save"]');
  await page.waitForSelector('[data-action="material-text-edit"]',{timeout:30000});
  assert.equal(await overflow(page),0);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));
  const chip=page.locator('.tournament-rules[data-id="t-winter-2027"]');assert.equal(await chip.evaluate(el=>el.tagName),'BUTTON');
  await chip.click();await page.waitForSelector('.mat-reader .mat-prose li');
  const reader=await page.evaluate(()=>{const d=document.querySelector('.mat-reader [role="dialog"]');return {modal:d.getAttribute('aria-modal'),title:document.getElementById(d.getAttribute('aria-labelledby'))?.textContent,items:[...d.querySelectorAll('li')].map(x=>x.textContent),link:d.querySelector('.mat-prose a')?.getAttribute('rel'),img:!!d.querySelector('.mat-prose img'),width:d.getBoundingClientRect().width};});
  assert.deepEqual(reader,{modal:'true',title:'Puchar Zimy 2027',items:['Ważenie od 7:30','Start o 9:00'],link:'noopener noreferrer nofollow ugc',img:false,width:393});
  assert.equal(await overflow(page),0,'the reader fits 393 px');
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('tournament-rules')),true);
  await settings(page,'t-winter-2027');await page.click('[data-action="material-rules-mode"][data-mode="pdf"]');
  await page.setInputFiles('[data-material-input="rules"]',DIST+'demo/regulamin-demo.pdf');await page.waitForSelector('.mat-rules.is-pdf.has-file [data-action="material-remove"]',{timeout:30000});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));
  assert.equal(await page.locator('.tournament-rules[data-id="t-winter-2027"]').count(),0,'the PDF is a link again');
  assert.equal(await page.locator('.tournament-card a.tournament-rules').count()>=1,true);
  // a new tournament: the poster and the rules wait and go out once it exists
  await page.click('main .page-heading [data-action="new-tournament"]');await page.waitForSelector('#tournament-form [data-materials]');
  await page.fill('#tournament-form [name="name"]','Turniej z plakatem');await page.fill('#tournament-form [name="city"]','Lublin');await page.fill('#tournament-form [name="date"]','2027-05-15');
  await page.setInputFiles('[data-material-input="poster"]',DIST+'brand/icon-512.png');await page.waitForSelector('.mat-poster .mat-frame img',{timeout:30000});
  await page.click('[data-action="material-rules-mode"][data-mode="text"]');await page.fill('[data-mat-text]','Regulamin nowego turnieju.');
  await page.click('#modal-root button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'),null,{timeout:30000});
  const card=page.locator('.tournament-card',{hasText:'Turniej z plakatem'});
  assert.equal(await card.locator('.mat-thumb img').count(),1);assert.equal(await card.locator('button.tournament-rules').count(),1);
  assert.deepEqual(errors,[]);await ctx.close();
 }finally{await browser.close();server.close();}
});

test('static demo: the seeded demo tournament carries the demo poster and rules (backend seed, PLAN-MATERIALY §3)',{skip:browserSkip,timeout:120000},async()=>{
 const {initialWorkspace}=await import('../dist/workspace.js');const seed=initialWorkspace().tournaments.find(t=>t.id==='t-autumn-2026');
 assert.ok(seed?.materials?.poster&&seed.materials.rules,'t-autumn-2026 has materials');
 const {server,url}=await serve(),browser=await chromium.launch();
 try{
  const {ctx,page,errors}=await open(browser,url);
  await page.goto(url+'#guest?t=t-autumn-2026');await page.click('.promo [data-action="close-modal"]');await page.waitForSelector('.mat-hero img');
  assert.equal(await page.locator('.mat-hero img').evaluate(img=>new Promise(r=>img.complete?r(img.naturalWidth):img.addEventListener('load',()=>r(img.naturalWidth)))),1240);
  const href=await page.getAttribute('.mat-actions a[data-mat-open="rules"]','href');assert.equal(href,'./demo/regulamin-demo.pdf');
  const res=await page.request.get(url+'demo/regulamin-demo.pdf');assert.equal(res.status(),200);assert.match(res.headers()['content-type'],/application\/pdf/);
  assert.deepEqual(errors,[]);await ctx.close();
 }finally{await browser.close();server.close();}
});

// ---- PHP build (scripts/test-http.sh), written against the contract ----
const API=process.env.MATDRAW_TEST_URL;
test('PHP build: the Administrator adds a JPEG and a PDF in the dialog; a guest gets the poster (200 image) and the rules (application/pdf); typed rules read as a guest',{skip:(!chromium||!API)&&'MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh needed',timeout:300000},async()=>{
 const {fixture,Client:Http}=await import('./helpers/http-client.mjs');
 fixture('reset-limits');
 const admin=new Http();await admin.login('admin@test.example','AdminForTests2026!');
 const me=(await admin.req('me')).data,limits=me?.features?.materials;
 assert.ok(limits&&typeof limits.poster==='number'&&typeof limits.rules==='number','me.features.materials {poster, rules}');
 const app=API.replace(/api\/index\.php$/,''),browser=await chromium.launch(),errors=[];
 const name='Materiały E2E '+Date.now().toString(36);
 try{
  const ctx=await browser.newContext({viewport:{width:1280,height:900},locale:'pl-PL'});await ctx.addInitScript(()=>{try{localStorage.setItem('matdraw.language','pl');}catch{}});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app);await page.fill('#login-form input[name="email"]','admin@test.example');await page.fill('#login-form input[name="password"]','AdminForTests2026!');
  await page.click('#login-form button[type="submit"]');await page.waitForSelector('.app-shell',{timeout:20000});
  await page.click('main .page-heading [data-action="new-tournament"]');await page.waitForSelector('#tournament-form [data-materials]');
  await page.fill('#tournament-form [name="name"]',name);await page.fill('#tournament-form [name="city"]','Lublin');
  const date=new Date(Date.now()+40*86400000).toISOString().slice(0,10);await page.fill('#tournament-form [name="date"]',date);await page.selectOption('#tournament-form [name="status"]','open');
  if(limits.poster>0){await page.setInputFiles('[data-material-input="poster"]',DIST+'brand/og-image.jpg');await page.waitForSelector('.mat-poster .mat-frame img',{timeout:30000});}
  if(limits.rules>0){await page.setInputFiles('[data-material-input="rules"]',DIST+'demo/regulamin-demo.pdf');await page.waitForSelector('.mat-rules.has-file',{timeout:30000});}
  await page.click('#modal-root button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'),null,{timeout:60000});
  const id=await page.locator('.tournament-card',{hasText:name}).locator('.tournament-card-actions [data-action="edit-tournament"]').getAttribute('data-id');
  const view=(await admin.load()).tournaments.find(t=>t.id===id);
  if(limits.poster>0){assert.match(view.poster?.v??'',/^[0-9a-f]{12}$/);assert.match(view.poster.color,/^#[0-9a-f]{6}$/);assert.ok(view.poster.w>0&&view.poster.h>0);assert.ok(!('f' in view.poster));}
  if(limits.rules>0)assert.deepEqual(Object.keys(view.rules).sort(),['size','type','v']),assert.equal(view.rules.type,'pdf'),assert.equal(view.rules.size,readFileSync(DIST+'demo/regulamin-demo.pdf').length);
  // a guest: no cookies
  const guest=await browser.newContext({viewport:{width:393,height:852},locale:'pl-PL'});await guest.addInitScript(()=>{try{localStorage.setItem('matdraw.language','pl');}catch{}});
  const g=await guest.newPage();g.on('pageerror',e=>errors.push(e.message));
  await g.goto(app+'#guest?t='+encodeURIComponent(id));await g.click('.promo [data-action="close-modal"]');await g.waitForSelector('#guest-title');
  if(limits.poster>0){
   await g.waitForSelector('.mat-hero img');
   assert.ok(await g.locator('.mat-hero img').evaluate(img=>new Promise(r=>img.complete?r(img.naturalWidth>0):(img.addEventListener('load',()=>r(img.naturalWidth>0)),img.addEventListener('error',()=>r(false))))),'the poster loads for a guest');
   const src=await g.locator('.mat-hero img').getAttribute('src');assert.match(src,/route=material&t=.+&k=poster&s=lg&v=[0-9a-f]{12}$/);
   const res=await g.request.get(new URL(src,app).href);assert.equal(res.status(),200);assert.match(res.headers()['content-type'],/^image\/(webp|jpeg)/);
  }
  if(limits.rules>0){
   const href=await g.getAttribute('.mat-actions a[data-mat-open="rules"]','href');assert.match(href,/route=material&t=.+&k=rules&v=[0-9a-f]{12}$/);
   const res=await g.request.get(new URL(href,app).href);assert.equal(res.status(),200);assert.match(res.headers()['content-type'],/^application\/pdf/);
   assert.equal((await res.body()).subarray(0,5).toString('latin1'),'%PDF-');
  }
  assert.equal(await g.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
  // typed rules replace the PDF; the guest reads them in the reader
  if(limits.rules>0){
   await page.click(`main .tournament-card-actions [data-action="edit-tournament"][data-id="${id}"]`);await page.waitForSelector('#tournament-form [data-materials]');
   await page.click('[data-action="material-rules-mode"][data-mode="text"]');await page.fill('[data-mat-text]','## Zgłoszenia\n- Do końca miesiąca\n- Przez MatBravo');
   await page.click('[data-action="material-text-save"]');await page.waitForSelector('[data-action="material-text-edit"]',{timeout:30000});
   const rules=(await admin.load()).tournaments.find(t=>t.id===id).rules;assert.equal(rules.type,'text');assert.ok(!('text' in rules),'the text is not in the workspace');
   await g.reload();await g.click('.promo [data-action="close-modal"]');await g.waitForSelector('.mat-actions [data-action="material-rules"]');
   await g.click('.mat-actions [data-action="material-rules"]');await g.waitForSelector('.mat-reader .mat-prose li');
   assert.deepEqual(await g.$$eval('.mat-reader .mat-prose li',els=>els.map(e=>e.textContent)),['Do końca miesiąca','Przez MatBravo']);
   const res=await g.request.get(new URL(`api/index.php?route=material&t=${encodeURIComponent(id)}&k=rules&v=${rules.v}`,app).href);
   assert.equal(res.status(),200);assert.match(res.headers()['content-type'],/^text\/plain; charset=utf-8/i);
  }
  await guest.close();await ctx.close();
 }finally{await browser.close();fixture('reset-limits');}
 assert.deepEqual(errors,[]);
});
