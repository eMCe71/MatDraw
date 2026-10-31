// Registry of feature pages/actions/menu items, routes, events and the safe HTML template (plan §8.2, §5.9), plus dictionary merging (§8.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import {registry,h,setHtml,SafeHtml,trustedHtml,escapeHtml,parseRoute,routeHash,registerPage,registerPublicPage,registerAction,navItems,page,publicPage,handle,defaultPage,setBadge,badge,on,emit,provide,use,title,allows} from '../dist/registry.js';
import {mergeDictionaries,collisions,DICTIONARY,t,setLanguage} from '../dist/i18n.js';
setLanguage('pl',{persist:false});

test('parseRoute: page and query, the #czat alias, #screen and #guest untouched',()=>{
 const chat=parseRoute('#chat?c=taekwondo-pl');assert.equal(chat.page,'chat');assert.equal(chat.params.get('c'),'taekwondo-pl');assert.equal(chat.alias,false);
 const alias=parseRoute('#czat?t=t-1&x=a%20b');assert.equal(alias.page,'chat');assert.equal(alias.alias,true);assert.equal(alias.params.get('t'),'t-1');assert.equal(alias.params.get('x'),'a b');
 assert.equal(parseRoute('#czat').page,'chat');
 const screen=parseRoute('#screen?tournament=t-autumn-2026&category=forms%7C1');assert.equal(screen.page,'screen');assert.equal(screen.params.get('category'),'forms|1');assert.equal(screen.alias,false);
 const guest=parseRoute('#guest?t=t-winter-2027');assert.equal(guest.page,'guest');assert.equal(guest.params.get('t'),'t-winter-2027');
 for(const [hash,pageId] of [['#draws','draws'],['',''],['#',''],[null,''],[undefined,''],['tournaments','tournaments'],['#profile?tab=security','profile']])assert.equal(parseRoute(hash).page,pageId,String(hash));
 assert.equal(parseRoute('').params.toString(),'');
 assert.equal(routeHash('chat'),'#chat');assert.equal(routeHash('chat',{c:'karate pl'}),'#chat?c=karate+pl');assert.equal(routeHash('profile',new URLSearchParams('tab=security')),'#profile?tab=security');assert.equal(routeHash('draws',{}),'#draws');
});

test('h escapes every interpolation, keeps nested SafeHtml, joins arrays; setHtml accepts only SafeHtml',()=>{
 const evil='<img src=x onerror="alert(1)">',quote=`"'><svg onload=1>\``;
 const out=h`<p title="${quote}">${evil}</p>`;
 assert.ok(out instanceof SafeHtml);
 assert.equal(String(out),'<p title="&quot;&#39;&gt;&lt;svg onload=1&gt;&#96;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
 assert.ok(!/<img|<svg/.test(out.html));
 const inner=h`<b>${'A & B'}</b>`;assert.equal(String(h`<div>${inner}</div>`),'<div><b>A &amp; B</b></div>','SafeHtml from another h is kept');
 assert.equal(String(h`<ul>${['<x>',h`<li>ok</li>`]}</ul>`),'<ul>&lt;x&gt;<li>ok</li></ul>','arrays are joined, items escaped or kept');
 assert.equal(String(h`${null}${undefined}${false}${0}${''}`),'0','null, undefined and false give nothing');
 assert.equal(String(h`${t('Czat')}`),'Czat','T() results are plain strings and are escaped like any other');
 assert.equal(String(h`${{toString:()=>'<i>'}}`),'&lt;i&gt;','objects are not trusted because of toString');
 // ARIA states (WCAG 4.1.2): a boolean as the quoted value of an aria-* attribute is "true"/"false", never the empty "undefined".
 const on=true,off=false;
 assert.equal(String(h`<button aria-pressed="${off}" aria-selected='${on}' aria-expanded="${!on}" aria-checked="${off}">`),
  `<button aria-pressed="false" aria-selected='true' aria-expanded="false" aria-checked="false">`);
 assert.equal(String(h`<b aria-label="${off}">${off}</b><i title="${off}" data-x="${off}"></i>`),'<b aria-label="false"></b><i title="" data-x=""></i>','only aria-* values, not text or other attributes');
 assert.equal(String(h`<b aria-pressed="x ${off}" class="${off&&'on'}">${off&&h`<i></i>`}</b>`),'<b aria-pressed="x " class=""></b>','false inside a longer value or a condition still gives nothing');
 assert.equal(String(h`<button${off?h` disabled`:''}${on?h` hidden`:''}>`),'<button hidden>','real boolean attributes keep the attribute-or-nothing form');
 assert.equal(String(h`<b aria-pressed="${'true" onclick="x'}" aria-label="${null}">`),'<b aria-pressed="true&quot; onclick=&quot;x" aria-label="">','strings in aria values are escaped as before');
 assert.equal(escapeHtml(`<&>"'`),'&lt;&amp;&gt;&quot;&#39;');
 assert.throws(()=>new SafeHtml('<b>forged</b>'),TypeError,'SafeHtml cannot be constructed outside the registry');
 const el={innerHTML:''};
 setHtml(el,h`<em>${'<script>'}</em>`);assert.equal(el.innerHTML,'<em>&lt;script&gt;</em>');
 assert.throws(()=>setHtml(el,'<img onerror=1>'),TypeError);assert.throws(()=>setHtml(el,{html:'<b>'}),TypeError);assert.throws(()=>setHtml(el,null),TypeError);
 assert.equal(el.innerHTML,'<em>&lt;script&gt;</em>','a rejected value never reaches innerHTML');
 assert.equal(String(trustedHtml('<svg></svg>')),'<svg></svg>');
});

test('menu items follow the declared roles; admin items only for the admin; event items only with a tournament',()=>{
 registerPage({id:'qa-club',icon:'chat',label:'Club page',nav:'global',roles:['admin','club'],order:20,render:()=>h`<p>club</p>`});
 registerPage({id:'qa-everyone',icon:'globe',label:()=>t('Czat'),nav:'global',roles:['admin','editor','club','member'],order:10,title:()=>'Everyone',render:()=>h``});
 registerPage({id:'qa-admin',icon:'shield',label:'Admin page',nav:'admin',roles:['admin','club'],order:5,render:()=>h``});
 registerPage({id:'qa-event',icon:'chat',label:'Event page',nav:'event',roles:['admin','editor','club'],order:1,render:()=>h``});
 registerPage({id:'qa-hidden',label:'No menu',nav:null,roles:['member'],render:()=>h``});
 const ids=(role,tournament)=>navItems({role},{tournament}).map(x=>x.id);
 assert.deepEqual(ids('admin'),['qa-admin','qa-everyone','qa-club']);
 assert.deepEqual(ids('admin',{id:'t1'}),['qa-event','qa-admin','qa-everyone','qa-club']);
 assert.deepEqual(ids('club',{id:'t1'}),['qa-event','qa-everyone','qa-club'],'nav:admin is never shown to a club, even when listed in roles');
 assert.deepEqual(ids('editor'),['qa-everyone']);
 assert.deepEqual(ids('member',{id:'t1'}),['qa-everyone']);
 assert.deepEqual(ids(undefined),[]);
 assert.equal(navItems({role:'admin'}).find(x=>x.id==='qa-everyone').label,'Czat','labels may be functions evaluated at render time');
 assert.equal(title('qa-everyone'),'Everyone');assert.equal(title('qa-club'),'Club page');assert.equal(title('nope'),'');
 assert.ok(allows(page('qa-hidden'),'member'));assert.ok(!allows(page('qa-hidden'),'admin'));assert.ok(!allows(page('qa-admin'),'club'));assert.ok(!allows(null,'admin'));
 assert.equal(page('missing'),null);assert.equal(String(page('qa-club').render()),'<p>club</p>');
 assert.throws(()=>registerPage({id:'qa-club',render:()=>h``}),/already registered/);
 assert.throws(()=>registerPage({id:'qa-broken'}),TypeError);
});

test('default pages: staff keep tournaments, a member starts in the chat',()=>{
 assert.equal(defaultPage('admin'),'tournaments');assert.equal(defaultPage('club'),'tournaments');
 registerPage({id:'qa-member-first',label:'Member',nav:'global',roles:['member'],order:1,render:()=>h``});
 assert.equal(defaultPage('member'),'qa-member-first','without a chat page the first page open to members');
 registerPage({id:'chat',label:'Chat',nav:'global',roles:['admin','editor','club','member'],order:50,render:()=>h``});
 assert.equal(defaultPage('member'),'chat');
});

test('actions: unknown actions are not handled; public context runs only public actions',async()=>{
 const calls=[];
 registerAction('qa-private',(el,id,ctx)=>{calls.push(['private',el,id,ctx]);});
 registerAction('qa-public',async(el,id)=>{calls.push(['public',id]);},{public:true});
 registerAction('qa-fails',async()=>{throw new Error('boom');});
 assert.equal(handle('qa-unknown',{},'x',{}),false);
 assert.equal(handle('qa-private',{},'x',{public:true}),false,'a session action never runs for a guest');
 assert.equal(await handle('qa-private','EL','id1',{workspace:1}),true);
 assert.equal(await handle('qa-public',null,'id2',{public:true}),true);
 assert.deepEqual(calls,[['private','EL','id1',{workspace:1}],['public','id2']]);
 await assert.rejects(handle('qa-fails',null,null,{}),/boom/,'handler errors reach the caller (app.js handleError)');
 assert.throws(()=>registerAction('qa-public',()=>{}),/already registered/);
 registerPublicPage({id:'qa-signup',render(){}});assert.ok(publicPage('qa-signup'));assert.equal(publicPage('qa-club'),null);
});

test('events, badges and provided helpers',()=>{
 const seen=[];
 const off=on('qa-event',detail=>seen.push(['a',detail.n]));
 on('qa-event',()=>{throw new Error('module failure');});
 on('qa-event',detail=>seen.push(['c',detail.n]));
 const error=console.error;console.error=()=>{};
 try{emit('qa-event',{n:1});off();emit('qa-event',{n:2});}finally{console.error=error;}
 assert.deepEqual(seen,[['a',1],['c',1],['c',2]],'one failing listener does not stop the others');
 for(const name of ['ready','painted','login','logout','language','saved','payment-required','client-outdated'])assert.doesNotThrow(()=>emit(name,{}));
 setBadge('qa-club',3);assert.equal(badge('qa-club'),3);assert.equal(navItems({role:'club'}).find(x=>x.id==='qa-club').badge,3);
 setBadge('qa-club',0);assert.equal(badge('qa-club'),0);setBadge('qa-club',150);assert.equal(registry.badgeText(badge('qa-club')),'99+');
 provide('qa',{x:1});assert.deepEqual(use('qa'),{x:1});assert.equal(use('nothing'),undefined);
 assert.equal(registry.h,h);assert.equal(registry.parseRoute,parseRoute);
});

test('dictionary merge: first wins, a collision is listed (no exception), the shipped dictionaries have none',()=>{
 const fn=()=>'x';
 const {dictionary,collisions:found}=mergeDictionaries([['a.js',{x:'One',y:'Two',p:{one:'1',other:'n'},f:fn}],['b.js',{x:'One',y:'Other',z:'Three',p:{one:'1',other:'n'},f:fn}],['c.js',null]]);
 assert.deepEqual(dictionary,{x:'One',y:'Two',p:{one:'1',other:'n'},f:fn,z:'Three'});
 assert.deepEqual(found,[{key:'y',kept:'a.js',ignored:'b.js'}],'equal duplicates are not collisions');
 assert.deepEqual(collisions,[]);
 assert.equal(DICTIONARY['Członek'],'Member');assert.equal(DICTIONARY['Turnieje'],'Tournaments');
});

test('app.js paints registered pages through setHtml, so a page that returns a plain string throws instead of injecting it',async()=>{
 const {readFileSync}=await import('node:fs');const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
 assert.match(app,/let own=registry\.allows\(reg,role\);\n if\(own\)\{try\{registry\.setHtml\(app,reg\.render\(registry\.parseRoute\(location\.hash\)\.params\)\);\}catch\(error\)\{[^\n]*own=false;\}\}\n if\(!own\)app\.innerHTML=member\?memberHome\(\):\(pages\[ui\.page\]\|\|tournamentsPage\)\(\);/,'a page that throws or returns a string falls back to the built-in page instead of stopping render()');
 assert.ok(!/innerHTML=String\(own\?/.test(app),'no direct innerHTML for registered pages');
 registerPage({id:'qa-plain-string',label:'QA',roles:['member'],render:()=>'<img src=x onerror="alert(1)">'});
 const el={innerHTML:''};assert.throws(()=>setHtml(el,page('qa-plain-string').render(new URLSearchParams())),TypeError);assert.equal(el.innerHTML,'');
});

test('app.js: after a 401 the view follows the hash (public page, guest flow or login), and a member preview is dropped',async()=>{
 const {readFileSync}=await import('node:fs');const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
 const branch=app.match(/if\(error\.status===401\)\{[^\n]*\}/)?.[0]||'';
 assert.match(branch,/workspace=null;closeModal\(\);if\(guest\?\.memberPreview\)\{guest=null;promo=null;\}renderPublic\(error\.message\);return;/);
 assert.ok(!/renderLogin\(/.test(branch),'no login page drawn under a hash that names a public page');
 assert.match(app,/function renderPublic\(message=''\)\{/);assert.match(app,/if\(!id\)\{guest=null;promo=null;renderLogin\(message\);return;\}/);
});
