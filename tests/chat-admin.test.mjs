// Chat moderation panel (plan §5.6, §5.9, §11, §12.11): request bodies of the Admin actions and settings, plain-text rendering of every value
// that comes from the API (report comments, original_body, e-mails, names, titles, the notice), the page registration and the badge helper.
// Node checks run the views as plain functions; the browser check (Playwright + Chromium, MATDRAW_BROWSER_TESTS=1) mounts the real panel in the
// static demo page with a fake API and clicks through the dialogs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registry,h,SafeHtml} from '../dist/registry.js';
import {setLanguage,DICTIONARY} from '../dist/i18n.js';
import * as admin from '../dist/chat-admin.js';
import * as boot from '../dist/moderation-boot.js';

setLanguage('pl',{persist:false});
const {actionBody,settingsBody,changed,muteNotice,hostingHigh,groupReasons,channelTitle,chatHash,personName,listUrl,contextUrl,reportItem,queueView,mutedView,settingsView,HOSTING_429_HINT}=admin;

// ---- A hostile data set: every text field carries markup, a script URL or direction marks ----
const EVIL='<img src=x onerror=alert(1)>',SVG='"><svg onload=alert(2)>',BIDI='‮evil‬',LINK='https://evil.example/phish?x=1';
const item=(over={})=>({
 message:{id:7,channelId:3,channel:{kind:'tournament',slug:null,scope:null,status:'open',tournamentId:'t-1',title:'Puchar '+EVIL,date:'2030-05-01'},state:'visible',body:'Hej '+EVIL+' '+LINK+' '+BIDI,original:null,createdMs:1893500000000,reportCount:3},
 author:{id:'u-9',email:'<b>mail</b>@x.pl',role:'club',active:true,publicId:'abc',username:'user<i>',name:SVG,country:'PL'},muted:null,
 reports:{count:3,reasons:{spam:2,harassment:1},lastAt:1893500100,items:[
  {reason:'spam',comment:EVIL+' '+LINK,status:'open',createdAt:1893500100,reporter:{id:'r1',username:'rep<script>alert(3)</script>'}},
  {reason:'harassment',comment:SVG,status:'open',createdAt:1893500200,reporter:{id:'r2',username:null}}]},
 ...over});
const TEMPLATE_TAGS=new Set(['article','header','h3','time','p','span','blockquote','details','summary','ul','ol','li','q','div','button','a','strong','label','select','option','fieldset','legend','input','textarea','form','section','dl','dt','dd','nav','small']);
/** Tags and attributes of a rendered fragment: text is escaped, so every '<' belongs to the template. */
function parts(safe){
 assert.ok(safe instanceof SafeHtml,'views return SafeHtml');
 const html=safe.html,tags=[...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g)];
 assert.equal((html.match(/</g)||[]).length,tags.length,'every < starts a template tag');
 return {html,names:tags.map(m=>m[1].toLowerCase()),attrs:tags.flatMap(m=>[...m[2].matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)].map(a=>[m[1].toLowerCase(),a[1].toLowerCase(),a[2]]))};
}
function assertPlain(safe,label){
 const {html,names,attrs}=parts(safe);
 for(const n of names)assert.ok(TEMPLATE_TAGS.has(n),label+': unexpected tag <'+n+'>');
 for(const [tag,name,value] of attrs){
  assert.ok(!/^on/.test(name),label+': event attribute '+name);
  if(name==='href')assert.ok(tag==='a'&&/^#chat(\?|$)/.test(value),label+': link '+value);
  if(name==='src'||name==='srcdoc'||name==='style')assert.fail(label+': attribute '+name);
 }
 assert.ok(!html.includes('<img')&&!html.includes('<svg')&&!html.includes('<script')&&!html.includes('<b>')&&!html.includes('<i>'),label+': markup from data');
 assert.ok(!/href="https?:/.test(html),label+': a link to an external address');
 return html;
}

test('rendering: a reported message with hostile texts becomes plain text only (no tags, no links, no handlers)',()=>{
 const html=assertPlain(reportItem(item(),{open:false}),'report item');
 assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'),'the markup is shown as text');
 assert.ok(html.includes(LINK),'a URL stays text');
 assert.ok(html.includes('&lt;b&gt;mail&lt;/b&gt;@x.pl')&&html.includes('user&lt;i&gt;'),'e-mail and user name as text');
 assert.ok(html.includes('rep&lt;script&gt;alert(3)&lt;/script&gt;'),'a reporter name as text');
 assert.ok(html.includes('Puchar &lt;img'),'a tournament title as text');
 assert.ok(html.includes('dir="auto"'),'direction of foreign text is isolated');
});
test('rendering: original_body of a deleted message and the comments of a history item are text; history items have no actions',()=>{
 const deleted=item({message:{...item().message,state:'deleted_mod',body:'',original:'<script>steal()</script> '+LINK}});
 const html=assertPlain(reportItem(deleted),'deleted');
 assert.ok(html.includes('&lt;script&gt;steal()&lt;/script&gt;'));
 assert.ok(!html.includes('data-mod="delete"'),'a deleted message is not deleted again');
 const hist=assertPlain(reportItem(item(),{history:true}),'history');
 for(const a of ['delete','dismiss','mute','channel','restore'])assert.ok(!hist.includes('data-mod="'+a+'"'),a+' is not offered in the history');
 assert.ok(hist.includes('data-mod="ctx"'));
});
test('rendering: actions follow the state of the message and the author',()=>{
 const has=(over,action)=>reportItem(item(over)).html.includes('data-mod="'+action+'"');
 assert.ok(has({},'delete')&&has({},'dismiss')&&has({},'mute')&&has({},'channel'));
 assert.ok(!has({},'restore')&&!has({},'unmute'),'a visible message of an active author');
 assert.ok(has({message:{...item().message,state:'hidden_review'}},'restore'),'restore for hidden_review');
 assert.ok(has({muted:{until:null}},'unmute')&&!has({muted:{until:null}},'mute'),'muted author: restore posting instead of mute');
 assert.ok(!has({author:{...item().author,role:'admin'}},'mute'),'an Admin cannot be muted');
 assert.ok(has({author:{id:'gone'}},'mute'),'an author without a profile can be muted');
});
test('rendering: the open context lists 2 messages before and after as text; the target is marked',()=>{
 const ctx={status:'ready',items:[{id:5,state:'visible',body:'przed '+EVIL,original:null,createdMs:1893499900000,author:{id:'a',username:'x',name:SVG}},{id:7,state:'visible',body:'cel',original:null,createdMs:1893500000000,author:{id:'u-9'}},{id:8,state:'deleted_author',body:'',original:null,createdMs:1893500001000,author:{id:'b'}}]};
 const html=assertPlain(reportItem(item(),{open:true,ctx}),'context');
 assert.ok(html.includes('przed &lt;img'));assert.ok(html.includes('class="mod-ctx-row is-target"'));
 assert.ok(html.includes('Ukryj kontekst'));
 assert.ok(assertPlain(reportItem(item(),{open:true,ctx:{status:'loading'}}),'loading').includes('role="status"'));
 assert.ok(assertPlain(reportItem(item(),{open:true,ctx:{status:'error',message:EVIL}}),'error').includes('&lt;img'));
});
test('rendering: queue, muted list and settings (the notice, names and e-mails) are plain text',()=>{
 const state={open:new Set([7]),ctx:{},historyStatus:'actioned'};
 assertPlain(queueView({total:1,page:1,items:[item()]},state),'queue');
 assertPlain(queueView({total:45,page:2,items:[item()]},state),'queue page 2');
 assert.ok(queueView({total:0,page:1,items:[]},state).html.includes('Społeczność jest w formie'));
 const muted=mutedView({items:[{user:{id:'u',email:'<u>e</u>@x.pl',name:EVIL,username:'z'},until:null,reason:'powód '+EVIL,createdAt:1893500000,createdBy:{id:'a',email:'<i>admin</i>@x.pl'}}]});
 const m=assertPlain(muted,'muted');assert.ok(m.includes('&lt;u&gt;e&lt;/u&gt;@x.pl')&&m.includes('powód &lt;img'));
 const settings={version:4,on:true,preset:'normal',ms:[2500,5000,10000,30000,60000],notice:'</textarea><script>alert(4)</script>'+EVIL,presets:{normal:[2500,5000,10000,30000,60000],saver:[5000,10000,30000,60000,120000],emergency:[15000,30000,60000,120000,300000]},send:{gap:2,perMin:20,perDay:300},autoHide:3,updatedAt:1893500000,health:{429:61,503:2,508:0,0:7}};
 const s=assertPlain(settingsView(settings,{error:EVIL}),'settings');
 assert.ok(s.includes('&lt;/textarea&gt;&lt;script&gt;'),'the notice cannot close the textarea');
 assert.deepEqual(parts(settingsView(settings)).names.filter(n=>n==='textarea'),['textarea','textarea'],'one textarea (opening and closing tag)');
});
test('settings view: switch, preset radios, custom pace, the hosting counter and its orientation threshold',()=>{
 const base={version:1,on:false,preset:'custom',ms:[1000,2000,3000,4000,5000],notice:null,presets:{normal:[2500,5000,10000,30000,60000],saver:[5000,10000,30000,60000,120000],emergency:[15000,30000,60000,120000,300000]},health:{429:HOSTING_429_HINT,503:1,508:2,0:3}};
 const html=settingsView(base).html;
 assert.ok(html.includes('Odpowiedzi hostingu w ostatniej godzinie'));
 assert.ok(!/name="on"[^>]* checked/.test(html),'chat off: switch not checked');
 assert.ok(/value="custom" checked/.test(html)&&html.includes('Własne (ustawione w bazie)'),'a custom pace set in the database is shown and kept');
 assert.equal((html.match(/name="preset"/g)||[]).length,4);
 assert.ok(!html.includes('mod-tile is-warn'),'exactly at the threshold is not above it');
 assert.ok(settingsView({...base,health:{...base.health,429:HOSTING_429_HINT+1}}).html.includes('mod-tile is-warn'));
 assert.equal(hostingHigh({429:50}),false);assert.equal(hostingHigh({429:51}),true);assert.equal(hostingHigh(undefined),false);assert.equal(HOSTING_429_HINT,50);
 assert.ok(settingsView({...base,preset:'normal'}).html.includes('2,5 s · 5 s · 10 s · 30 s · 1 min'),'intervals of the pace presets');
});

test('admin-chat-action bodies: delete, dismiss, restore, mute, unmute, channel (optional texts left out, ids as numbers)',()=>{
 assert.deepEqual(actionBody('delete',{messageId:'7',note:'  spam  '}),{action:'delete',messageId:7,note:'spam'});
 assert.deepEqual(actionBody('delete',{messageId:7,note:'   '}),{action:'delete',messageId:7});
 assert.deepEqual(actionBody('dismiss',{messageId:'7',note:null}),{action:'dismiss',messageId:7});
 assert.deepEqual(actionBody('dismiss',{messageId:7,note:'ok'}),{action:'dismiss',messageId:7,note:'ok'});
 assert.deepEqual(actionBody('restore',{messageId:7,note:'ignored'}),{action:'restore',messageId:7});
 for(const d of ['1h','24h','7d','perm'])assert.deepEqual(actionBody('mute',{userId:'u-9',duration:d,reason:''}),{action:'mute',userId:'u-9',duration:d});
 assert.deepEqual(actionBody('mute',{userId:'u-9',duration:'7d',reason:'<b>x</b>'}),{action:'mute',userId:'u-9',duration:'7d',reason:'<b>x</b>'},'texts are sent as typed; the server cleans them and the panel shows them as text');
 assert.deepEqual(actionBody('unmute',{userId:'u-9'}),{action:'unmute',userId:'u-9'});
 for(const s of ['open','readonly','closed'])assert.deepEqual(actionBody('channel',{channelId:'3',status:s}),{action:'channel',channelId:3,status:s});
 assert.throws(()=>actionBody('mute',{userId:'u',duration:'2h'}),/Wybierz czas wyciszenia/);
 assert.throws(()=>actionBody('mute',{userId:'u',duration:null}),/Wybierz czas wyciszenia/);
 assert.throws(()=>actionBody('channel',{channelId:3,status:'archive'}),/Niepoprawny status kanału/);
 assert.throws(()=>actionBody('channel',{channelId:'x',status:'open'}),/Niepoprawny formularz/);
 assert.throws(()=>actionBody('delete',{messageId:'0'}),/Niepoprawny formularz/);
 assert.throws(()=>actionBody('delete',{messageId:'1; DROP'}),/Niepoprawny formularz/);
 assert.throws(()=>actionBody('delete',{messageId:7,note:'x'.repeat(301)}),/Notatka może mieć najwyżej 300 znaków/);
 assert.doesNotThrow(()=>actionBody('delete',{messageId:7,note:'ą'.repeat(300)}));
 assert.throws(()=>actionBody('mute',{userId:'u',duration:'1h',reason:'x'.repeat(301)}),/Powód może mieć najwyżej 300 znaków/);
 assert.throws(()=>actionBody('ban',{}),/Nieznana operacja moderacji/);
});
test('admin-chat-settings-save bodies: only what changed, always with the loaded version; notice up to 300 characters',()=>{
 const cur={version:4,on:true,preset:'normal',notice:null};
 assert.deepEqual(settingsBody(cur,{on:true,preset:'normal',notice:''}),{version:4});assert.equal(changed(settingsBody(cur,{on:true,preset:'normal',notice:''})),false);
 assert.deepEqual(settingsBody(cur,{on:false,preset:'normal',notice:''}),{version:4,on:false});
 assert.deepEqual(settingsBody(cur,{on:true,preset:'saver',notice:'  '}),{version:4,preset:'saver'});
 assert.deepEqual(settingsBody(cur,{on:true,preset:'emergency',notice:' Przerwa techniczna '}),{version:4,preset:'emergency',notice:'Przerwa techniczna'});
 assert.deepEqual(settingsBody({...cur,notice:'stary'},{on:true,preset:'normal',notice:''}),{version:4,notice:null},'an empty notice clears it (null)');
 assert.deepEqual(settingsBody({...cur,preset:'custom'},{on:true,preset:'custom',notice:null}),{version:4},'a custom pace is never sent back');
 assert.deepEqual(settingsBody(cur,{on:false,preset:'normal',notice:'x'}),{version:4,on:false,notice:'x'});
 assert.ok(changed(settingsBody(cur,{on:false})));
 assert.equal(settingsBody(cur,{on:true,preset:'normal',notice:'ą'.repeat(300)}).notice.length,300);
 assert.throws(()=>settingsBody(cur,{on:true,notice:'x'.repeat(301)}),/Komunikat może mieć najwyżej 300 znaków/);
});
test('request URLs: report queue, history, muted people, context and settings use only ids and paging in the query (no personal data)',()=>{
 assert.deepEqual(listUrl('reports',{page:2}),{route:'admin-chat-reports',status:'open',page:'2'});
 assert.deepEqual(listUrl('history',{page:1,status:'dismissed'}),{route:'admin-chat-reports',status:'dismissed',page:'1'});
 assert.deepEqual(listUrl('muted'),{route:'admin-chat-reports',view:'muted'});
 assert.deepEqual(listUrl('settings'),{route:'admin-chat-settings'});
 assert.deepEqual(contextUrl('7'),{route:'admin-chat-reports',context:'7'});
 assert.throws(()=>contextUrl('7&x=1'),/Niepoprawny formularz/);
});
test('helpers: reasons, channel titles, links to the chat, names, the mute preview',()=>{
 assert.deepEqual(groupReasons({other:1,spam:2,abuse:2,bad:0}),[{reason:'spam',n:2},{reason:'abuse',n:2},{reason:'other',n:1}]);
 assert.deepEqual(groupReasons(undefined),[]);
 assert.equal(channelTitle({kind:'lobby',slug:'taekwondo-pl',scope:'pl'}),'Taekwondo · Polska');
 assert.equal(channelTitle({kind:'lobby',slug:'general',scope:'world'}),'Ogólny · Świat');
 assert.equal(channelTitle({kind:'tournament',title:'Puchar',date:'2030-05-01'}),'Puchar · 2030-05-01');
 assert.equal(chatHash({kind:'lobby',slug:'karate'}),'#chat?c=karate');assert.equal(chatHash({kind:'tournament',tournamentId:'t 1&x'}),'#chat?t=t+1%26x');assert.equal(chatHash(null),'#chat');
 assert.equal(personName({name:'Jan Kot',username:'jan'}),'Jan Kot');assert.equal(personName({username:'jan'}),'@jan');assert.equal(personName({email:'a@b.pl'}),'a@b.pl');assert.equal(personName({id:'x'}),'Konto usunięte lub anonimowe');
 assert.equal(muteNotice('perm'),'Moderator wstrzymał Twoje pisanie bezterminowo.');
 assert.match(muteNotice('1h',Date.UTC(2030,0,1,11,0)/1000),/^Moderator wstrzymał Twoje pisanie do .*13:00\.$/);
 assert.match(muteNotice('7d',Date.UTC(2030,0,1,11,0)/1000),/8 sty/);
 setLanguage('en',{persist:false});
 try{assert.equal(muteNotice('perm'),'A moderator has paused your posting indefinitely.');assert.equal(channelTitle({kind:'lobby',slug:'taekwondo-pl',scope:'pl'}),'Taekwondo · Poland');}finally{setLanguage('pl',{persist:false});}
});
test('every action and tab has an English text (no Polish left in English mode)',()=>{
 setLanguage('en',{persist:false});
 try{
  const html=reportItem(item({message:{...item().message,state:'hidden_review'}})).html+settingsView({version:1,on:true,preset:'saver',ms:[5000,10000,30000,60000,120000],notice:null,presets:{normal:[1000,2000,3000,4000,5000],saver:[5000,10000,30000,60000,120000],emergency:[15000,30000,60000,120000,300000]},health:{429:60}}).html;
  assert.ok(!/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(html.replace(/evil|&lt;[^&]*&gt;/g,'')),'Polish text in English output: '+(html.match(/[^<>]*[ąćęłńóśźż][^<>]*/)||[''])[0]);
  assert.ok(html.includes('Hosting answers in the last hour')&&html.includes('Restore message'));
 }finally{setLanguage('pl',{persist:false});}
});

test('moderation-boot: the page is for the Admin only, in the admin menu, and renders SafeHtml',()=>{
 registry.provide('ui',{shell:(content,title,subtitle)=>h`<main><h1>${title}</h1><p>${subtitle}</p>${content}</main>`,getWorkspace:()=>({user:{role:'admin'}})});
 const page=registry.page('moderation');
 assert.ok(page,'registered');assert.equal(page.nav,'admin');assert.deepEqual(page.roles,['admin']);
 const out=page.render();assert.ok(out instanceof SafeHtml,'render returns SafeHtml');assert.ok(out.html.includes('data-mod-root'));
 assert.ok(registry.navItems({role:'admin'},{}).some(i=>i.id==='moderation'));
 for(const role of ['editor','club','member'])assert.ok(!registry.navItems({role},{}).some(i=>i.id==='moderation'),role);
 assert.equal(registry.title('moderation'),'Moderacja');
 assert.ok(!registry.allows(page,'editor'));
});
test('moderation-boot: the badge shows the number of messages with open reports; the demo makes no request',async()=>{
 assert.equal(boot.openReports({total:3}),3);assert.equal(boot.openReports({total:'4'}),4);assert.equal(boot.openReports({total:-2}),0);assert.equal(boot.openReports(null),0);assert.equal(boot.openReports({total:'x'}),0);
 assert.equal(boot.BADGE_MS,300000);
 assert.equal(await boot.refreshBadge(),null,'demo: no request');
});
test('the dictionary has no moderation text without an English entry',()=>{
 for(const k of ['Moderacja','Wyciszeni','Historia','Odpowiedzi hostingu w ostatniej godzinie','Brak zgłoszeń. Społeczność jest w formie!','Notatka wewnętrzna (opcjonalnie)','Powód (widoczny tylko dla administratorów)'])assert.ok(Object.hasOwn(DICTIONARY,k),k);
});

// ---- Browser check: the real panel against a fake API ----
let chromium=null;try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const runBrowser=process.env.MATDRAW_BROWSER_TESTS==='1';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'"});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
test('panel in a browser: hostile texts stay text, the dialogs send the right bodies, settings save, no CSP violation',{skip:(!runBrowser&&'set MATDRAW_BROWSER_TESTS=1')||(!chromium&&'Playwright is not installed'),timeout:120000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch(),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1280,height:900},locale:'pl-PL'}),page=await ctx.newPage();
  page.on('pageerror',e=>problems.push('pageerror '+e.message));page.on('console',m=>{if(m.type()==='error'||/Content Security Policy/i.test(m.text()))problems.push(m.text());});
  await page.goto(url);await page.waitForSelector('.login-page');
  await page.evaluate(()=>{window.__sec=[];document.addEventListener('securitypolicyviolation',e=>window.__sec.push(e.violatedDirective));});
  await page.evaluate(async({evil,svg,link,bidi})=>{
   const m=await import('./chat-admin.js');
   const host=document.createElement('div');host.id='mod-test-root';host.className='mod-root';document.body.append(host);
   window.__calls=[];
   const item={message:{id:7,channelId:3,channel:{kind:'tournament',status:'open',tournamentId:'t-1',title:'Puchar '+evil,date:'2030-05-01'},state:'visible',body:'Hej '+evil+' '+link+' '+bidi,original:null,createdMs:1893500000000,reportCount:3},
    author:{id:'u-9',email:'<b>mail</b>@x.pl',role:'club',username:'user<i>',name:svg},muted:null,
    reports:{count:2,reasons:{spam:1,other:1},lastAt:1893500100,items:[{reason:'spam',comment:evil,status:'open',createdAt:1893500100,reporter:{id:'r1',username:'rep'}},{reason:'other',comment:svg,status:'open',createdAt:1893500200,reporter:{id:'r2',username:null}}]}};
   let version=3,reports=[item];
   const settings=()=>({version,on:true,preset:'normal',ms:[2500,5000,10000,30000,60000],notice:evil,presets:{normal:[2500,5000,10000,30000,60000],saver:[5000,10000,30000,60000,120000],emergency:[15000,30000,60000,120000,300000]},send:{},autoHide:3,updatedAt:1893500000,health:{429:61,503:2,508:0,0:7}});
   const request=async(route,opts={})=>{
    const params=typeof route==='string'?{route}:route;window.__calls.push({params,method:opts.method||'GET',body:opts.body});
    if(params.route==='admin-chat-reports'&&params.context)return {messageId:7,channelId:3,items:[{id:6,state:'visible',body:'przed '+evil,original:null,createdMs:1893499990000,author:{id:'a',username:'x'}},{id:7,state:'visible',body:'cel',original:null,createdMs:1893500000000,author:{id:'u-9'}}]};
    if(params.route==='admin-chat-reports'&&params.view==='muted')return {items:[{user:{id:'u-5',email:'<i>e</i>@x.pl',name:evil,username:'z'},until:null,reason:evil,createdAt:1893500000,createdBy:{id:'a',email:'admin@x.pl'}}]};
    if(params.route==='admin-chat-reports')return {total:reports.length,page:1,items:reports};
    if(params.route==='admin-chat-settings')return settings();
    if(params.route==='admin-chat-action'){if(opts.body.action==='dismiss')reports=[];return {ok:true};}
    if(params.route==='admin-chat-settings-save'){version++;return {...settings(),...opts.body,notice:opts.body.notice===undefined?evil:opts.body.notice};}
    throw new Error('Nieznana trasa '+params.route);
   };
   m.mount(host,{request,demo:false});
  },{evil:EVIL,svg:SVG,link:LINK,bidi:BIDI});
  await page.waitForSelector('#mod-test-root .mod-item');
  // texts are text: no element came from the data
  assert.equal(await page.locator('#mod-test-root img, #mod-test-root svg, #mod-test-root script, #mod-test-root b, #mod-test-root i, #mod-test-root a[href^="http"]').count(),0);
  assert.equal(await page.locator('#mod-test-root .mod-body').first().innerText(),('Hej '+EVIL+' '+LINK+' '+BIDI));
  assert.ok((await page.locator('#mod-test-root .mod-comment').allTextContents()).includes(EVIL));
  assert.ok((await page.locator('#mod-test-root .mod-email').first().innerText()).includes('<b>mail</b>@x.pl'));
  // context
  await page.click('#mod-test-root [data-mod="ctx"]');await page.waitForSelector('#mod-test-root .mod-ctx-row.is-target');
  assert.equal(await page.locator('#mod-test-root .mod-ctx-row').count(),2);assert.equal(await page.locator('#mod-test-root img').count(),0);
  // mute dialog: preview follows the duration; the body has the chosen duration and the reason
  await page.click('#mod-test-root [data-mod="mute"]');await page.waitForSelector('#mod-mute-form');
  assert.match(await page.locator('[data-mod-preview]').innerText(),/^Moderator wstrzymał Twoje pisanie do /);
  await page.check('#mod-mute-form input[value="perm"]');assert.equal(await page.locator('[data-mod-preview]').innerText(),'Moderator wstrzymał Twoje pisanie bezterminowo.');
  await page.fill('#mod-mute-form [name=reason]','spam w czacie');await page.click('button[form="mod-mute-form"]');
  await page.waitForFunction(()=>!document.querySelector('#mod-mute-form'));
  // delete dialog with a note; dismiss dialog empties the queue
  await page.click('#mod-test-root [data-mod="delete"]');await page.fill('#mod-delete-form [name=note]','powód');await page.click('button[form="mod-delete-form"]');await page.waitForFunction(()=>!document.querySelector('#mod-delete-form'));
  await page.click('#mod-test-root [data-mod="channel"]');await page.check('#mod-channel-form input[value="readonly"]');await page.click('button[form="mod-channel-form"]');await page.waitForFunction(()=>!document.querySelector('#mod-channel-form'));
  await page.click('#mod-test-root [data-mod="dismiss"]');await page.click('button[form="mod-dismiss-form"]');await page.waitForSelector('#mod-test-root .mod-empty');
  const posts=await page.evaluate(()=>window.__calls.filter(c=>c.method==='POST').map(c=>[c.params.route||c.params,c.body]));
  assert.deepEqual(posts,[
   ['admin-chat-action',{action:'mute',userId:'u-9',duration:'perm',reason:'spam w czacie'}],
   ['admin-chat-action',{action:'delete',messageId:7,note:'powód'}],
   ['admin-chat-action',{action:'channel',channelId:3,status:'readonly'}],
   ['admin-chat-action',{action:'dismiss',messageId:7}]]);
  // muted tab and unmute
  await page.click('#mod-tab-muted');await page.waitForSelector('#mod-test-root .mod-muted');
  assert.equal(await page.locator('#mod-test-root img, #mod-test-root i, #mod-test-root script').count(),0);
  await page.click('#mod-test-root [data-mod="unmute"]');
  await page.waitForFunction(()=>window.__calls.some(c=>c.body?.action==='unmute'&&c.body.userId==='u-5'));
  // settings: preset and notice are sent with the loaded version; the counter is shown; the notice is text in the textarea
  await page.click('#mod-tab-settings');await page.waitForSelector('#mod-settings-form');
  assert.equal(await page.inputValue('#mod-notice'),EVIL);
  assert.match(await page.locator('.mod-tile.is-warn').first().innerText(),/429\s+61/);
  await page.check('#mod-settings-form input[value="saver"]');await page.fill('#mod-notice','Przerwa techniczna');await page.click('#mod-settings-form button[type=submit]');
  await page.waitForSelector('.mod-saved');
  assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c.params.route==='admin-chat-settings-save').map(c=>c.body)),[{version:3,preset:'saver',notice:'Przerwa techniczna'}]);
  // keyboard: arrows move between tabs
  await page.focus('#mod-tab-settings');await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.id),'mod-tab-reports');
  assert.deepEqual(await page.evaluate(()=>window.__sec),[],'CSP violations');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'no horizontal scroll');
  await ctx.close();
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});
