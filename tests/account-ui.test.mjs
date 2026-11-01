// Account screens (plan §11, §12.12): default country, currency from the country, prices (Intl), ?billing= parsing, crop maths,
// password strength, the CTA matrix from public-config (§6.10), "show my full name" unticked by default, the flow mark contract
// with pwa.js (§9.4, §14.4), Stripe origin checks and what the client may send.
// Browser checks (Playwright + Chromium) run with MATDRAW_BROWSER_TESTS=1: the static demo from dist/ always, and, under
// scripts/test-http.sh (MATDRAW_TEST_URL set), the PHP build with the Stripe stub: sign-up in 3 steps with a language switch in
// step 2, Checkout and the return, portal, cancel, profile, e-mail, password, account deletion with confirmEnd, a temporary
// password and the staff banners. MATDRAW_ACCOUNT_SHOTS=<dir> also saves screenshots of those pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

// me.js keeps a BroadcastChannel open, which would keep this process alive: the modules run without it here.
globalThis.BroadcastChannel=undefined;
const boot=await import('../dist/account-boot.js');
const flow=await import('../dist/account-flow.js');
const crop=await import('../dist/avatar-crop.js');
const {ACCESS,setAccessKind}=await import('../dist/promo.js');
const {t,setLanguage,getLanguage,DICTIONARY}=await import('../dist/i18n.js');
const {registry,h,SafeHtml}=await import('../dist/registry.js');
setLanguage('pl',{persist:false});// Polish keys are the Polish output; English checks switch explicitly.

const root=fileURLToPath(new URL('../dist/',import.meta.url));
const source=file=>readFileSync(root+file,'utf8');
const spaces=s=>String(s).replace(/\s/g,' ');
const inLanguage=(lang,fn)=>{const before=getLanguage();setLanguage(lang,{persist:false});try{return fn();}finally{setLanguage(before,{persist:false});}};
class Store{m=new Map();getItem(k){return this.m.has(k)?this.m.get(k):null;}setItem(k,v){this.m.set(k,String(v));}removeItem(k){this.m.delete(k);}}
// The shell helpers app.js provides (registry.use('ui')), reduced to what the templates need outside a browser.
registry.provide('ui',{T:t,icon:name=>h`<svg data-icon="${name}"></svg>`,shell:(content,title)=>h`<main><h1>${title}</h1>${content}</main>`,mascot:()=>h``,emptyMascot:()=>h``});

test('default country from navigator.languages: the first tag with a region, a bare pl, otherwise none (05 §10.4)',()=>{
 for(const [langs,code] of [[['pl-PL','en'],'PL'],[['en-US'],'US'],[['de-AT','de'],'AT'],[['pl'],'PL'],[['en','pl-PL'],'PL'],[['en'],null],[[],null],
  [['es-419','fr-CA'],'CA'],[['zh-Hant-TW'],'TW'],[['en_GB'],'GB'],[['xx-ZZ','en-IE'],'IE'],['pl-PL','PL'],[[null,undefined,'sv-SE'],'SE']])
  assert.equal(flow.defaultCountry(langs),code,JSON.stringify(langs));
});
test('currency follows the country (PL -> PLN, any other listed country -> USD, no country -> none; plan §6.1)',()=>{
 assert.equal(flow.currencyFor('PL'),'pln');assert.equal(flow.currencyFor('DE'),'usd');assert.equal(flow.currencyFor('US'),'usd');assert.equal(flow.currencyFor('XK'),'usd');
 for(const v of [null,undefined,'','pl','ZZ',1])assert.equal(flow.currencyFor(v),null,String(v));
 assert.equal(boot.priceCurrency('pl'),'pln');assert.equal(boot.priceCurrency('en'),'usd');
});
test('prices are formatted with Intl: own currency with its symbol, the other one with its code (05 §15)',()=>{
 assert.equal(spaces(boot.formatPrice(899,'pln','pl')),'8,99 zł');
 assert.equal(spaces(boot.formatPrice(299,'usd','pl')),'2,99 USD');
 assert.equal(spaces(boot.formatPrice(299,'usd','en')),'$2.99');
 assert.equal(spaces(boot.formatPrice(899,'pln','en')),'PLN 8.99');
 assert.equal(spaces(boot.formatPrice(1000,'PLN','pl')),'10,00 zł');
 for(const [a,c] of [[NaN,'pln'],[899,''],[899,'zl'],[-1,'pln'],['x','usd']])assert.equal(boot.formatPrice(a,c,'pl'),'',String([a,c]));
});
test('?billing= is read, validated and removed from the address without touching other parameters (§6.2)',()=>{
 const id='cs_test_'+'a1B2c3D4e5F6g7';
 assert.deepEqual(boot.parseBillingReturn('?billing=success&session_id='+id),{kind:'success',sessionId:id});
 assert.deepEqual(boot.parseBillingReturn('?billing=success&session_id=cs_test_short'),{kind:'success',sessionId:null},'malformed id is dropped');
 assert.deepEqual(boot.parseBillingReturn('?billing=success&session_id=evt_123'),{kind:'success',sessionId:null});
 assert.deepEqual(boot.parseBillingReturn('?billing=cancel&session_id='+id),{kind:'cancel',sessionId:null});
 assert.deepEqual(boot.parseBillingReturn('?source=pwa&billing=portal'),{kind:'portal',sessionId:null});
 for(const s of ['','?billing=','?billing=paid','?x=1',null])assert.equal(boot.parseBillingReturn(s),null,String(s));
 assert.equal(boot.stripBillingParams('?billing=success&session_id='+id),'');
 assert.equal(boot.stripBillingParams('?source=pwa&billing=portal'),'?source=pwa');
 assert.equal(boot.stripBillingParams('?a=1&billing=cancel&b=2'),'?a=1&b=2');
});
test('crop maths: cover scale, clamped offsets, the source square and zoom around the centre (§7.5)',()=>{
 assert.equal(crop.coverScale(400,300),280/300);assert.equal(crop.coverScale(300,600),280/300);
 const st={w:400,h:300,zoom:1,x:0,y:0};
 assert.deepEqual(crop.sourceRect(st),{sx:50,sy:0,size:300});
 const max=(400*280/300-280)/2;
 assert.deepEqual(crop.clampOffset({...st,x:1000,y:50}),{x:max,y:0},'x up to the overhang, y none');
 assert.deepEqual(crop.clampOffset({...st,x:-1000,y:-50}),{x:-max,y:0});
 const moved=crop.pan(st,-20,0);assert.equal(moved.x,-20);const r=crop.sourceRect(moved);assert.ok(Math.abs(r.sx-(50+20*300/280))<1e-9,'moving the image left shows more of its right side');
 const z=crop.zoomTo({...st,x:30},2);assert.equal(z.zoom,2);assert.equal(z.x,60,'the offset scales with the zoom');
 assert.equal(crop.sourceRect(crop.zoomTo(st,2)).size,150);
 assert.equal(crop.zoomTo(st,9).zoom,crop.ZOOM_MAX);assert.equal(crop.zoomTo(st,0.2).zoom,1);
 const back=crop.zoomTo({...st,zoom:3,x:200,y:100},1);assert.deepEqual([back.x,back.y],[max,0],'zooming out re-clamps');
 for(const s of [st,{w:2000,h:1000,zoom:2.5,x:300,y:-120},{w:64,h:64,zoom:4,x:-9,y:9}]){const c={...s,...crop.clampOffset(s)},q=crop.sourceRect(c);
  assert.ok(q.sx>=-1e-9&&q.sy>=-1e-9&&q.sx+q.size<=s.w+1e-9&&q.sy+q.size<=s.h+1e-9,'the crop stays inside the image '+JSON.stringify(s));}
 assert.ok(crop.checkFile({type:'image/webp',size:1000}));
 assert.throws(()=>crop.checkFile({type:'image/gif',size:10}),/To nie jest obraz/);
 assert.throws(()=>crop.checkFile({type:'image/svg+xml',size:10}),/To nie jest obraz/);
 assert.throws(()=>crop.checkFile({type:'image/png',size:8*1024*1024+1}),/za duży/);
 assert.throws(()=>crop.checkFile(null),/To nie jest obraz/);
});
test('password strength hint: length in bytes as the server counts it, no composition rules (05 §10.2)',()=>{
 const level=p=>flow.passwordStrength(p);
 assert.deepEqual(level('short'),{level:0,key:'short'});assert.deepEqual(level('a'.repeat(73)),{level:0,key:'long'});
 assert.equal(level('aaaaaaaaaaaa').level,1);assert.equal(level('password1234').level,1);assert.equal(level('matbravo2026!').level,1);
 assert.equal(level('kwiatek-rower').level,1);assert.equal(level('Kwiatek-Rower7').level,2);
 assert.equal(level('Zielony Rower Jedzie 2026').level,3);
 assert.equal(level('koń biega po łące szybko').level,3,'a passphrase with Polish letters is very good');
 assert.equal(flow.passwordStrength(null).key,'short');
});
test('CTA matrix from public-config (§6.10): login / paid / free and the guest access card texts',()=>{
 assert.equal(boot.accessKind({signup:false,billing:false}),'login');
 assert.equal(boot.accessKind({signup:false,billing:true}),'login','invite-only test window: nothing is advertised');
 assert.equal(boot.accessKind({signup:true,billing:true}),'paid');
 assert.equal(boot.accessKind({signup:true,billing:false}),'free');
 assert.equal(boot.accessKind(null),'login');
 const login={...ACCESS};delete login.variants;
 try{
  assert.equal(setAccessKind('paid',{price:()=>boot.formatPrice(899,'pln','pl'),translate:t}),'paid');
  assert.equal(ACCESS.cta,'Załóż konto');assert.equal(inLanguage('pl',()=>spaces(ACCESS.note)),'8,99 zł / mies. · anulujesz w dowolnym momencie');
  assert.equal(inLanguage('en',()=>spaces(ACCESS.note)),'8,99 zł / month · cancel at any time','the note is computed when read');
  assert.deepEqual(ACCESS.benefits,['Pisanie we wszystkich czatach','Pełne profile uczestników','Czaty turniejów']);
  setAccessKind('paid',{price:()=>null,translate:t});assert.equal(ACCESS.note,'Rejestracja zajmuje około minuty.','no price: the sign-up note, never the login one');
  setAccessKind('free',{price:()=>'x',translate:t});assert.equal(ACCESS.kind,'free');assert.ok(!/\{price\}|x/.test(ACCESS.note),'no price without payments');
  setAccessKind('nonsense');assert.equal(ACCESS.kind,'login');
  for(const k of Object.keys(login))assert.deepEqual(ACCESS[k],login[k],'login restores '+k);
  for(const v of Object.values(ACCESS.variants))for(const s of [v.eyebrow,v.title,v.text,v.cta,v.note,...v.benefits])assert.ok(Object.hasOwn(DICTIONARY,s),s);
 }finally{setAccessKind('login');}
});
test('staff banners (§3.2, §6.6): free until within 14 days, grace, view only; nothing without enforcement',()=>{
 const now=1_800_000_000,me=(access,role='editor',billing={enabled:true,enforce:true})=>({user:{role},access,billing});
 assert.deepEqual(boot.bannerInfo(me({full:true,state:'free',until:now+10*86400}),now),{kind:'soon',until:now+10*86400});
 assert.equal(boot.bannerInfo(me({full:true,state:'free',until:now+20*86400}),now),null);
 assert.equal(boot.bannerInfo(me({full:true,state:'free',until:null}),now),null);
 assert.deepEqual(boot.bannerInfo(me({full:true,state:'grace',until:now+3*86400}),now),{kind:'grace',until:now+3*86400});
 assert.deepEqual(boot.bannerInfo(me({full:false,state:'none'}),now),{kind:'blocked',until:null});
 assert.equal(boot.bannerInfo(me({full:false,state:'none'},'member'),now),null,'members get the chat CTA instead');
 assert.equal(boot.bannerInfo(me({full:false,state:'none'},'editor',{enabled:true,enforce:false}),now),null);
 assert.equal(boot.bannerInfo(me({full:false,state:'none'},'editor',{enabled:false}),now),null);
});
test('profile fields: "show my full name" is unticked by default and the names travel only in the POST body (§3.4, §7.1)',()=>{
 const f=flow.newFields(null,['pl-PL']);
 assert.equal(f.full,false);assert.equal(f.country,'PL');assert.deepEqual(f.sports,[]);
 const html=String(flow.fieldsView(f,{id:'t',signup:true}));
 assert.match(html,/<input type="checkbox" name="fullName">/,'unticked checkbox');
 assert.match(html,/<input type="checkbox" name="showClub">/);
 Object.assign(f,{first:' Marta ',last:'Kowalska',username:'Marta.K',sports:['karate','taekwondo'],club:'  KS Tygrys ‮'});
 assert.deepEqual(flow.profileBody(f),{firstName:'Marta',lastName:'Kowalska',username:'marta.k',country:'PL',sports:['karate','taekwondo'],clubText:'KS Tygrys',showClub:false,nameDisplay:'initial'});
 assert.equal(flow.profileBody({...f,full:true}).nameDisplay,'full');
 assert.equal(flow.fieldsError(f),null);
 for(const [patch,msg] of [[{first:''},'Sprawdź pole: imię.'],[{last:'<b>'},'Sprawdź pole: nazwisko.'],[{username:'ab'},'Sprawdź pole: nazwa użytkownika.'],[{username:'admin'},'Tej nazwy nie można użyć.'],
  [{country:'ZZ'},'Wybierz kraj z listy.'],[{sports:[]},'Wybierz co najmniej jeden sport.'],[{club:'x'.repeat(101)},'Sprawdź pole: klub lub szkoła.']])
  assert.equal(flow.fieldsError({...f,...patch})?.message,msg,JSON.stringify(patch));
 const p=flow.newFields({firstName:'Ola',lastName:'T',username:'ola.t',country:'DE',sports:['judo'],clubText:null,showClub:true,nameDisplay:'full'});
 assert.deepEqual([p.own,p.touched,p.full,p.showClub,p.country],['ola.t',true,true,true,'DE']);
 const options=flow.countryOptions('pl');assert.deepEqual(options[0],['PL','Polska']);assert.equal(options.length,250);
 const names=options.slice(1).map(o=>o[1]);assert.deepEqual(names,[...names].sort((a,b)=>a.localeCompare(b,'pl-PL')));
 assert.deepEqual(flow.countryOptions('en')[0],['PL','Poland']);
 const src=source('account-flow.js');
 assert.match(src,/request\('username-check',\{method:'POST',body:\{u,firstName:/,'username-check is a POST with the names in the body');
 assert.match(src,/request\('username-check',\{method:'POST',body:\{u,firstName:[^}]*nameDisplay:f\.full\?'full':'initial'\}/,'username-check says whether the full name is shown (the server leaves out full-surname suggestions otherwise)');
 assert.doesNotMatch(src+source('account-boot.js'),/route=username-check|username-check\?|apiUrl\(\{route:'username-check'/);
});
test('username prefill and suggestions never show the full surname by default (plan §7.7, §10: minors, "initial" default)',async()=>{
 const {suggestUsernames,slugName}=await import('../dist/profile-data.js');
 const PEOPLE=[['Marta','Kowalska'],['Łukasz','Żółć'],['Zoë','Brontë-Smith'],['Jan','Nowak'],['Aleksandra','Wiśniewska-Kowalczyk'],['Li','Wu']];
 for(const [first,last] of PEOPLE){
  const l=slugName(last),list=suggestUsernames(first,last,'',{full:false});
  assert.ok(list.length>0,first);
  for(const c of list)assert.ok(!c.includes(l)||l.length<2,c+' contains the surname '+l);
  assert.equal(flow.prefillUsername({first,last,full:false}),list[0]);
  assert.equal(flow.prefillUsername({first,last,full:true}),list[0],'the box does not turn the prefill into the full surname');
 }
 assert.equal(flow.prefillUsername({first:'Marta',last:'Kowalska'}),'marta.k');
 assert.equal(flow.prefillUsername({first:'Łukasz',last:'Żółć'}),'lukasz.z','ASCII-folded');
 assert.deepEqual(suggestUsernames('Marta','Kowalska','marta.k',{full:false}).slice(0,3),['marta_k','marta.k2','martak']);
 assert.deepEqual(suggestUsernames('Marta','Kowalska').slice(0,2),['marta.kowalska','marta_kowalska'],'the default order (server parity) is unchanged');
 // Server suggestions for a taken name: the full-surname ones are hidden unless the person chose to show the full name.
 const server=['marta.kowalska','marta_kowalska','marta.k2','bad name'];
 assert.deepEqual(flow.shownSuggestions(server,{first:'Marta',last:'Kowalska',full:false}),['marta.k2']);
 assert.deepEqual(flow.shownSuggestions(server,{last:'Kowalska',full:true}),['marta.kowalska','marta_kowalska','marta.k2']);
 assert.deepEqual(flow.shownSuggestions(null,{last:'K'}),[]);
 // A short surname is also a substring of the initial-only candidates: those stay, only the full-surname ones are hidden.
 for(const [first,last,want] of [['Alicja','Li',['alicja.l2','alicja.l3']],['Ewa','Wa',['ewa.w2','ewa.w3']],['Marta','Kowalska',['marta.k2','marta.k3']]]){
  const username=suggestUsernames(first,last,'',{full:false})[0],sent=suggestUsernames(first,last,username);
  assert.deepEqual(flow.shownSuggestions(sent,{first,last,username,full:false}),want,first+' '+last);
  for(const x of flow.shownSuggestions(sent,{first,last,username,full:false}))assert.ok(!x.includes(slugName(first)+'.'+slugName(last))&&!x.includes(slugName(first)+'_'+slugName(last))&&x!==slugName(first)+slugName(last),x);
 }
 assert.deepEqual(flow.shownSuggestions(['alicja.li','alicja_li','alicja.l2','alicjali'],{first:'Alicja',last:'Li',username:'alicja.l',full:false}),['alicja.l2']);
 // A long name: the server cuts the full-surname forms to 24 characters, so they no longer contain the whole surname; still hidden.
 for(const [first,last,want] of [['Katarzyna','Szczepańska-Wiśniewska',['katarzyna.s2','katarzyna.s3']],['Małgorzata','Kowalczykowska',['malgorzata.k2','malgorzata.k3']],['Bartłomiej','Brzęczyszczykiewicz',['bartlomiej.b2','bartlomiej.b3']]]){
  const username=flow.prefillUsername({first,last}),sent=suggestUsernames(first,last,username);
  assert.ok(sent.some(x=>x.length===24&&!x.includes(slugName(last))),'the server list has a cut full-surname form: '+sent);
  assert.deepEqual(flow.shownSuggestions(sent,{first,last,username,full:false}),want,first+' '+last);
  assert.deepEqual(flow.shownSuggestions(sent,{first,last,username,full:true}).slice(0,2),sent.slice(0,2),'shown when the full name is');
 }
 assert.deepEqual(flow.shownSuggestions(['marta.kowalskawisniewsk2','marta.k2'],{first:'Marta',last:'Kowalska-Wiśniewska',username:'marta.k',full:false}),['marta.k2']);
 assert.deepEqual(flow.shownSuggestions(['marta.kowalska2'],{first:'Marta',last:'Kowalska',username:'marta.kowalska',full:false}),['marta.kowalska2'],'what the person typed is theirs to extend');
 const html=String(flow.fieldsView(flow.newFields(null,['pl-PL']),{id:'t',signup:true}));
 assert.match(html,/Nazwę użytkownika widzą członkowie czatu\./,'the sign-up says who sees the username');
});
test('member shell: own name, @username and initials from the profile; nothing borrowed from a club (F13)',()=>{
 const me=(profile,role='member')=>({user:{role},profile});
 assert.deepEqual(boot.selfName(me({firstName:' Marta ',lastName:'Kowalska',username:'marta.k'})),{name:'Marta Kowalska',sub:'@marta.k'});
 assert.equal(boot.selfName(me(null)),null,'no profile: the role stays');assert.equal(boot.selfName(me({firstName:'A'},'club')),null,'staff keep role and club');
 assert.equal(boot.selfInitials(me(null)),'');
 const app=source('app.js');
 assert.match(app,/data-self-avatar>\$\{member\?'':initials\(club\?\.name\|\|T\('Klub'\)\)\}/,'no club initials for a member');
 assert.match(app,/member\?T\('Społeczność MatBravo'\):T\('Wspólna baza zawodników i turniejów\.'\)/,'no athlete-database note for members');
});
test('flow mark (plan §9.4): set and removed through the contract key, stale after 30 minutes',()=>{
 const s=new Store();assert.equal(boot.FLOW_MARK,'matdraw.flow.active');
 boot.flowStart(s,1000);assert.equal(s.getItem('matdraw.flow.active'),'1000');assert.ok(boot.flowActive(s,1000+29*60e3));assert.ok(!boot.flowActive(s,1000+31*60e3));
 boot.flowEnd(s);assert.equal(s.getItem('matdraw.flow.active'),null);assert.ok(!boot.flowActive(s));
 boot.saveReturn({kind:'success',sessionId:'cs_test_'+'abcdefghij12'},s,5000);assert.deepEqual(boot.readReturn(s,6000),{kind:'success',sessionId:'cs_test_abcdefghij12'});
 assert.equal(boot.readReturn(s,5000+61*60e3),null,'a return older than an hour is ignored');boot.clearReturn(s);assert.equal(boot.readReturn(s,6000),null);
 const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}};
 assert.doesNotThrow(()=>{boot.flowStart(broken);boot.flowEnd(broken);boot.saveReturn({kind:'cancel'},broken);boot.clearReturn(broken);});assert.equal(boot.flowActive(broken),false);
});
test('return from Stripe keeps the mark until confirm ends, then removes it (success, still processing, cancel, failure)',async()=>{
 const id='cs_test_'+'Zx9Yw8Vu7Ts6';let clock=0;
 const run=async(ret,answers,extra={})=>{
  const s=new Store(),calls=[],marks=[];boot.saveReturn(ret,s,0);
  const request=async(route,options)=>{calls.push([route,options.body]);marks.push(s.getItem(boot.FLOW_MARK)!==null);const a=answers.shift();if(a instanceof Error)throw a;return a;};
  const out=await flow.handleReturn(ret,{request,storage:s,now:()=>clock,wait:async ms=>{clock+=ms;},onState:()=>{},...extra});
  return {out,calls,marks,mark:s.getItem(boot.FLOW_MARK),pending:boot.readReturn(s,1)};
 };
 const active={access:{full:true,state:'active',until:1900000000},status:'active'},incomplete={access:{full:false,state:'processing'},status:'incomplete'};
 clock=0;let r=await run({kind:'success',sessionId:id},[incomplete,incomplete,active]);
 assert.equal(r.out.view,'success');assert.equal(r.out.until,1900000000);assert.deepEqual(r.marks,[true,true,true],'set during every confirm');
 assert.equal(r.mark,null,'removed after confirm');assert.equal(r.pending,null);
 assert.deepEqual(r.calls.map(c=>c[0]),['billing-confirm','billing-confirm','billing-confirm']);assert.deepEqual(r.calls[0][1],{sessionId:id},'only the session id is sent');
 clock=0;r=await run({kind:'success',sessionId:id},Array(20).fill(incomplete));
 assert.equal(r.out.view,'still');assert.equal(r.calls.length,11,'every 3 s for 30 s');assert.equal(r.mark,null);
 clock=0;r=await run({kind:'cancel',sessionId:null},[]);assert.equal(r.out.view,'cancel');assert.equal(r.mark,null);assert.equal(r.calls.length,0);assert.equal(r.pending,null);
 clock=0;r=await run({kind:'success',sessionId:id},[{access:{full:false,state:'ended'},status:'expired'}]);assert.equal(r.out.view,'failed');assert.equal(r.mark,null);
 clock=0;r=await run({kind:'success',sessionId:id},[Object.assign(new Error('Nie można potwierdzić tej płatności.'),{status:403})]);assert.equal(r.out.view,'failed');assert.equal(r.pending,null);
 clock=0;r=await run({kind:'success',sessionId:id},[Object.assign(new Error('Zaloguj się ponownie.'),{status:401})]);
 assert.equal(r.out.view,'expired');assert.notEqual(r.mark,null,'kept while the person logs in again');assert.deepEqual(r.pending,{kind:'success',sessionId:id},'confirm replays after login');
 clock=0;r=await run({kind:'success',sessionId:id},[new Error('Brak połączenia z serwerem.')]);assert.equal(r.out.view,'error');assert.equal(r.mark,null);assert.notEqual(r.pending,null,'kept for "try again"');
 clock=0;r=await run({kind:'success',sessionId:null},[active]);assert.deepEqual(r.calls,[['billing-sync',{}]],'without a session id: billing-sync');
 // Server limits: billing-sync 1 per 10 s (polled every 11 s), billing-confirm 30/h; a 429 waits for data.retry or ends in 'still'.
 const waits=[];clock=0;r=await run({kind:'success',sessionId:null},Array(20).fill(incomplete),{wait:async ms=>{waits.push(ms);clock+=ms;}});
 assert.equal(r.out.view,'still');assert.deepEqual(r.calls.map(c=>c[0]),['billing-sync','billing-sync','billing-sync']);assert.deepEqual(waits,[11000,11000]);
 const limited=retry=>Object.assign(new Error('Zbyt wiele prób płatności. Spróbuj ponownie później.'),{status:429,data:retry==null?{}:{retry}});
 waits.length=0;clock=0;r=await run({kind:'success',sessionId:null},[limited(7),active],{wait:async ms=>{waits.push(ms);clock+=ms;}});
 assert.equal(r.out.view,'success');assert.deepEqual(waits,[7000],'waits for Retry-After');assert.equal(r.mark,null);
 clock=0;r=await run({kind:'success',sessionId:id},[incomplete,limited(3600)]);assert.equal(r.out.view,'still','confirm limit: still processing, not an error');assert.equal(r.mark,null);assert.equal(r.pending,null);
 clock=0;r=await run({kind:'success',sessionId:id},[limited(null)]);assert.equal(r.out.view,'still');
 clock=0;r=await run({kind:'portal',sessionId:null},[active]);assert.equal(r.out.view,'portal');assert.deepEqual(r.calls,[['billing-sync',{}]]);assert.equal(r.mark,null);
 assert.equal(flow.confirmView({access:{full:true,state:'free'},status:'expired'}),'failed','an expired session is a failure even with free access');
 assert.equal(flow.confirmView({access:{full:false},status:'open'}),'processing');assert.equal(flow.confirmView({access:{full:false},status:'canceled'}),'failed');
});
test('Stripe pages open only on their own https origin (§6.2) and the client never sends amounts, currencies or price ids',()=>{
 const ok='https://checkout.stripe.com/c/pay/cs_test_'+'abc#fragment';
 assert.equal(flow.stripeUrl(ok,flow.CHECKOUT_ORIGIN),ok);
 assert.ok(flow.stripeUrl('https://billing.stripe.com/p/session/test_x',flow.PORTAL_ORIGIN));
 for(const bad of ['http://checkout.stripe.com/c/pay/x','https://checkout.stripe.com.evil.test/x','https://evil.test/?https://checkout.stripe.com','javascript:alert(1)',
  'https://user:pw@checkout.stripe.com/x','//checkout.stripe.com/x','https://billing.stripe.com/p/x','',null,undefined])assert.equal(flow.stripeUrl(bad,flow.CHECKOUT_ORIGIN),null,String(bad));
 const src=source('account-flow.js');
 assert.match(src,/const r=await Client\.request\(route,\{method:'POST',body:\{lang:getLanguage\(\)\}\}\),url=stripeUrl\(r\?\.url,origin\);/,'checkout/portal: language only, then the origin check');
 assert.match(src,/if\(!url\)throw new Error\([^)]*\);\n?\s*if\(route==='billing-checkout'\)flowEnd\(\);\n?\s*location\.assign\(url\);/,'location.assign only after the check');
 assert.equal((src.match(/location\.assign\(/g)||[]).length,1,'a single navigation to Stripe');
 const bodies=[...['account-boot.js','account-flow.js'].map(source).join('\n').matchAll(/body:(\{[^}]*\}|[A-Za-z.]+)/g)].map(m=>m[1]);
 assert.ok(bodies.length>=10,bodies.join(' '));
 for(const b of bodies)assert.doesNotMatch(b,/currency|amount|price|lookup/i,'no currency, amount or price in a request body: '+b);
 for(const file of ['account-boot.js','account-flow.js','avatar-crop.js'])assert.doesNotMatch(source(file).replace(/\/\*[\s\S]*?\*\//g,''),/createObjectURL|blob:/,file);
});
test('subscription states (05 §11.3) and the confirmEnd second confirmation for account deletion (§3.8)',()=>{
 const st=(state,extra={})=>flow.subscriptionState({access:{state,until:1764547200,...extra},billing:{enabled:true,hasCustomer:true}});
 assert.match(st('active').text,/^Aktywna do /);assert.ok(st('active').manage);
 assert.match(st('ending').text,/^Kończy się /);assert.match(st('past_due').text,/Problem z płatnością/);
 assert.equal(st('free',{until:null}).text,'Konto darmowe (przyznane przez Administratora)');assert.match(st('free').text,/^Konto darmowe do /);
 assert.equal(st('staff').text,'Konto zespołu MatBravo');assert.ok(st('none').activate);assert.ok(st('ended').activate);assert.ok(st('grace').activate);
 assert.equal(inLanguage('en',()=>st('active').text),'Active until 1 December 2025');
 const src=source('account-flow.js');
 assert.match(src,/error\?\.status===409&&error\.data\?\.confirmEnd/,'409 confirmEnd asks again');
 assert.match(src,/d\.confirmEnd\?\{password,endSubscription:true\}:\{password\}/,'endSubscription only after the second confirmation');
});
test('pages, actions and forms: registered for the right roles, render SafeHtml, acct- form ids (§8.2, §8.3 point 8, §14.3)',()=>{
 for(const id of ['profile','billing'])assert.deepEqual(registry.page(id).roles,['admin','editor','club','member'],id);
 assert.deepEqual(registry.page('signup').roles,['member']);assert.ok(registry.publicPage('signup'));
 for(const id of ['profile','billing','signup']){const out=registry.page(id).render(new URLSearchParams());assert.ok(out instanceof SafeHtml,id);assert.match(String(out),new RegExp('data-acct-page="'+id+'"'));}
 assert.equal(registry.navItems({role:'member'}).filter(i=>['profile','billing','signup'].includes(i.id)).length,0,'no menu items: the sidebar "My account" leads there');
 const ids=[...['account-boot.js','account-flow.js','avatar-crop.js'].map(source).join('\n').matchAll(/<form id="([^"]+)"/g)].map(m=>m[1]);
 assert.ok(ids.length>=6&&ids.every(id=>id.startsWith('acct-')),ids.join());
 const reserved=['login-form','tournament-form','profile-form','entry-form','account-form','password-form','check-form','print-form'];
 assert.ok(ids.every(id=>!reserved.includes(id)));
 const css=source('account.css').replace(/\/\*[\s\S]*?\*\//g,'');
 const selectors=css.replace(/@media[^{]*\{/g,'').replace(/@keyframes[^{]*\{[^}]*\{[^}]*\}[^}]*\}/g,'').split('}').map(r=>r.split('{')[0].trim()).filter(Boolean);
 for(const sel of selectors)for(const part of sel.split(','))assert.match(part.trim(),/acct-|^\[class\*="acct-"\]/,'every rule targets an acct- element: '+part);
});

// ---- Roles at sign-up and in the "Role" tab (PLAN-REJESTRACJA-ROLE §4.5, §6.1, §10.1, §10.2, §17) ----
const athlete=await import('../dist/athlete-form.js');
const {accessFor}=await import('../dist/promo.js');
const TODAY='2026-11-01',FULL={relation:'guardian',name:'Zosia Kowalska',birthDate:'2014-05-05',sex:'F',weight:'40,5',height:'150',gradeType:'cup',grade:'8',club:{none:true}};
const memberMe=(caps={},athletes=[],extra={})=>({user:{id:'u1',role:'member',email:'m@example.test',caps:{organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:false,...caps}},profile:{firstName:'Marta',lastName:'Kowalska',username:'marta.k'},athletes,access:{full:true,state:'open'},billing:{enabled:false},features:{signupMode:'free'},...extra});
const ZOSIA={profileId:'p1',name:'Zosia Kowalska',relation:'guardian',archived:false};

test('sign-up steps follow the ticked roles before the account exists and me.caps after the reload, never a fixed count (§4.5)',()=>{
 assert.deepEqual(flow.signupSteps({athlete:false,organizer:false},false),['account','profile']);
 assert.deepEqual(flow.signupSteps({athlete:false,organizer:true},true),['account','profile','plan'],'the organizer role adds no step');
 assert.deepEqual(flow.signupSteps({athlete:true,organizer:true},false),['account','profile','athlete']);
 assert.deepEqual(flow.signupSteps({athlete:true},true),['account','profile','athlete','plan']);
 assert.deepEqual(flow.signupSteps(null,true),['account','profile','plan']);
 assert.deepEqual(flow.stepLabel(flow.signupSteps({athlete:true},true),'athlete'),{n:3,total:4,name:'Zawodnik'});
 assert.deepEqual(flow.stepLabel(flow.signupSteps({athlete:true},true),'plan'),{n:4,total:4,name:'Plan'});
 assert.deepEqual(flow.stepLabel(flow.signupSteps({},false),'profile'),{n:2,total:2,name:'Profil'});
 // After the reload the plan step counts from me.caps: an athlete account had four steps.
 assert.deepEqual(flow.stepLabel(flow.signupSteps(memberMe({athlete:true}).user.caps,true),'plan'),{n:4,total:4,name:'Plan'});
 assert.deepEqual(flow.stepLabel(flow.signupSteps(memberMe({organizer:true}).user.caps,true),'plan'),{n:3,total:3,name:'Plan'});
 for(const name of Object.values(flow.STEP_LABELS))assert.ok(Object.hasOwn(DICTIONARY,name),name);
 const src=source('account-flow.js');
 assert.match(src,/\$\{s\.roles\.athlete\?T\('Dalej'\):T\('Utwórz konto'\)\}/,'step 2 says "Dalej" while the athlete step follows');
 assert.match(src,/T\('Konto MatBravo: czaty, zgłoszenia do turniejów i własne turnieje\. Wybierz, kim jesteś — możesz to zmienić później\.'\)/,'the new lead');
 assert.doesNotMatch(src,/Konto członka społeczności: czaty, profil i podglądy turniejów/,'the old lead is gone');
 assert.match(src,/roles,\.\.\.\(roles\.athlete\?\{athlete:athleteBody\(s\.athlete\)\}:\{\}\)/,'signup sends roles and the athlete only with the athlete role');
});
test('#signup?as=…&t=… ticks the role and keeps the target in sessionStorage for 30 minutes (§4.5, §10.1)',()=>{
 const q=s=>new URLSearchParams(s);
 assert.deepEqual(boot.parseTarget(q('as=athlete&t=t-winter_2027')),{as:'athlete',t:'t-winter_2027'});
 assert.deepEqual(boot.parseTarget(q('as=organizer')),{as:'organizer',t:null});
 assert.deepEqual(boot.parseTarget(q('as=athlete&t=<x>')),{as:'athlete',t:null},'a malformed tournament id is dropped');
 for(const s of ['','as=admin','as=','t=abc'])assert.equal(boot.parseTarget(q(s)),null,s);
 assert.equal(boot.signupHash({as:'athlete',t:'t-1'}),'#signup?as=athlete&t=t-1');assert.equal(boot.signupHash({as:'organizer',t:'x y'}),'#signup?as=organizer');
 assert.equal(boot.signupHash({}),'#signup');assert.equal(boot.signupHash(null),'#signup');
 const s=new Store();boot.saveTarget({as:'athlete',t:'t-1'},s,1000);assert.equal(boot.TARGET_KEY,'matdraw.signup.target');
 assert.match(boot.TARGET_KEY,/^matdraw\.signup\./,'purged at sign-out with the other matdraw.signup.* keys (me.js)');
 assert.deepEqual(boot.readTarget(s,1000+29*60e3),{as:'athlete',t:'t-1'});assert.equal(boot.readTarget(s,1000+31*60e3),null,'stale after 30 minutes');
 s.setItem(boot.TARGET_KEY,JSON.stringify({as:'athlete',t:'<script>',at:1000}));assert.deepEqual(boot.readTarget(s,2000),{as:'athlete',t:null},'a stored id is checked again');
 boot.clearTarget(s);assert.equal(boot.readTarget(s,2000),null);
 const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}};
 assert.doesNotThrow(()=>{boot.saveTarget({as:'athlete'},broken);boot.clearTarget(broken);});assert.equal(boot.readTarget(broken),null);
});
test('athlete step: "Kogo zgłaszasz?" is required and first, the name is prefilled only for "Siebie" (§6.1, UX-1)',()=>{
 const f=athlete.newAthlete();
 assert.equal(f.relation,null,'no answer is chosen in advance');assert.equal(f.name,'');assert.equal(f.club,null);
 const html=String(athlete.athleteFieldsHtml(f,{id:'t',clubs:[{id:'c1',name:'KS Tygrys'}],today:TODAY}));
 assert.ok(html.indexOf('name="relation"')<html.indexOf('name="athleteName"'),'the relation comes first');
 assert.equal((html.match(/<input type="radio" name="relation" value="(?:self|guardian)" required>/g)||[]).length,2,'both answers required and unticked');
 assert.match(html,/Kogo zgłaszasz\?/);assert.match(html,/Siebie/);assert.match(html,/Moje dziecko lub podopiecznego/);
 assert.match(html,/<input name="athleteName"[^>]* value="">/,'no name before the answer');
 assert.match(html,/<div class="acct-consents" data-acct-athlete-consents><\/div>/,'empty consent slot');
 assert.match(html,/<p class="acct-minor" data-acct-minor aria-live="polite"><\/p>/,'no age message yet');
 assert.match(html,/data-club-picker/);assert.match(html,/value="none"/,'the club picker offers "Niezrzeszony"');
 assert.match(html,/max="2026-11-01"/,'no birth date in the future');
 // The name: "Siebie" fills the account's name, the child never gets it.
 let g=athlete.relationChange(f,'self','Marta Kowalska');assert.equal(g.name,'Marta Kowalska');assert.equal(g.relation,'self');
 g=athlete.relationChange(g,'guardian','Marta Kowalska');assert.equal(g.name,'','the prefilled own name is removed for a child');
 g=athlete.relationChange({...f,name:'Zosia Kowalska'},'self','Marta Kowalska');assert.equal(g.name,'Zosia Kowalska','a typed name is never replaced');
 g=athlete.relationChange({...f,name:'Zosia Kowalska'},'guardian','Marta Kowalska');assert.equal(g.name,'Zosia Kowalska');
 g=athlete.relationChange(f,'guardian','Marta Kowalska');assert.equal(g.name,'','"Moje dziecko" starts with an empty name');
 assert.equal(athlete.relationChange(f,'self','').name,'');assert.equal(athlete.accountName(' Marta ',' Kowalska '),'Marta Kowalska');
 // Editing an existing profile (AthleteView): club, pending club name and the lock of club, birth date and sex.
 const p={id:'p1',name:'Zosia',birthDate:'2014-05-05',sex:'F',weight:40,height:150,gradeType:'cup',grade:8,relation:'guardian',locked:true,club:{id:'c1',name:'KS Tygrys',verified:true,unaffiliated:false,pending:null}};
 assert.deepEqual(athlete.newAthlete(p),{id:'p1',relation:'guardian',name:'Zosia',birthDate:'2014-05-05',sex:'F',weight:'40',height:'150',gradeType:'cup',grade:'8',club:{id:'c1'},clubName:'KS Tygrys',clubVerified:true,prefilled:null,locked:true});
 const unverified=String(athlete.athleteFieldsHtml(athlete.newAthlete({...p,locked:false,club:{id:'c9',name:'UKS Nowy',verified:false,unaffiliated:false,pending:null}}),{id:'t',clubs:[{id:'c1',name:'KS Tygrys'}],today:TODAY}));
 assert.match(unverified,/<option value="c9" selected>UKS Nowy · niezweryfikowany<\/option>/,'the own new club (not in public-clubs yet) stays chosen');
 assert.deepEqual(athlete.newAthlete({...p,club:{id:'unaffiliated',name:'',unaffiliated:true,pending:'UKS Nowy'}}).club,{name:'UKS Nowy'},'a pending name is tried again');
 assert.deepEqual(athlete.newAthlete({...p,club:{id:'unaffiliated',name:'',unaffiliated:true,pending:null}}).club,{none:true});
 const locked=String(athlete.athleteFieldsHtml(athlete.newAthlete(p),{id:'t',clubs:[],today:TODAY}));
 assert.match(locked,/name="birthDate"[^>]* disabled aria-describedby="t-locked"/);assert.match(locked,/name="sex" required disabled/);assert.match(locked,/Klub, datę urodzenia i płeć zmienisz po turnieju/);
});
test('a locked profile with a pending club name saves its other fields: the club goes as \'unaffiliated\', the pending name stays',async()=>{
 const {initialWorkspace,execute}=await import('../dist/workspace.js');
 const PENDING={id:'unaffiliated',name:'',verified:true,unaffiliated:true,pending:'Klub Oczekujący'};
 const f=athlete.newAthlete({id:'p1',name:'Ola',birthDate:'2017-09-12',sex:'F',weight:30,height:130,gradeType:'cup',grade:9,relation:'guardian',locked:true,club:PENDING});
 assert.deepEqual(f.club,{name:'Klub Oczekujący'},'the disabled picker still shows the pending name');
 assert.deepEqual(athlete.athleteBody(f).club,{id:'unaffiliated'},'locked: the club it has now');
 assert.deepEqual(athlete.athleteBody({...f,locked:false}).club,{name:'Klub Oczekujący'},'unlocked: the pending name is tried again');
 assert.deepEqual(athlete.athleteBody(athlete.newAthlete({id:'p1',locked:true,club:{id:'c1',name:'KS',verified:true,unaffiliated:false,pending:null}})).club,{id:'c1'});
 // Against the domain (workspace.js mirrors Domain athlete.save): a child of a parent, unaffiliated with a pending name, entered
 // in an open tournament; the daily quota of new clubs is free again, so a {name} would create a club and be refused (409).
 let db=initialWorkspace();db.users.push({id:'parent',clubId:null,email:'parent@example.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null});
 const run=(actor,type,p)=>{const r=execute(db,actor,type,p);db=r.db;return r.result;};
 const date=new Date(Date.now()+90*864e5).toISOString().slice(0,10);
 const tid=run('demo-admin','tournament.save',{name:'Zapisy Otwarte',city:'Opole',date,mat:'Mata 1',status:'open',selfEntry:true}).id;
 const id=run('parent','athlete.save',{...athlete.athleteBody({...f,id:null,locked:false,club:{none:true}})}).id;
 db.profiles.find(a=>a.id===id).pendingClubName='Klub Oczekujący';
 run('parent','entry.self',{tournamentId:tid,profileId:id,events:['forms']});
 assert.throws(()=>execute(db,'parent','athlete.save',{id,...athlete.athleteBody({...f,locked:false,weight:'31'})}),e=>e.status===409,'the old body: a new club is a change of the club');
 run('parent','athlete.save',{id,...athlete.athleteBody({...f,weight:'31'})});
 const saved=db.profiles.find(a=>a.id===id);
 assert.equal(saved.weight,31);assert.equal(saved.clubId,'unaffiliated');assert.equal(saved.pendingClubName,'Klub Oczekujący','the pending name is kept');
});
test('athlete body and errors: the server\'s fields and messages (Domain::athleteFields mirror), under 16 "Siebie" without a workaround',()=>{
 assert.deepEqual(athlete.athleteBody(FULL),{name:'Zosia Kowalska',birthDate:'2014-05-05',sex:'F',weight:40.5,height:150,gradeType:'cup',grade:8,club:{none:true},relation:'guardian'});
 assert.deepEqual(Object.keys(athlete.athleteBody({...FULL,ownerId:'x',champion:true,events:['fight']})).sort(),['birthDate','club','grade','gradeType','height','name','relation','sex','weight'],'a closed list of fields');
 assert.equal(athlete.athleteBody({...FULL,weight:'',sex:'X',relation:'parent'}).weight,null);assert.equal(athlete.athleteBody({...FULL,sex:'X'}).sex,null);assert.equal(athlete.athleteBody({...FULL,relation:'parent'}).relation,null);
 assert.equal(athlete.athleteError(FULL,TODAY),null);
 const minor=athlete.minorMessage();
 for(const [patch,msg] of [[{relation:null},'Wybierz, kogo zgłaszasz.'],[{name:'  '},'Sprawdź pole: imię i nazwisko.'],[{birthDate:''},'Podaj datę urodzenia.'],[{birthDate:'2027-01-01'},'Sprawdź datę urodzenia.'],
  [{weight:''},'Niepoprawna wartość liczbowa.'],[{weight:'5'},'Wartość liczbowa jest poza zakresem.'],[{height:'300'},'Wartość liczbowa jest poza zakresem.'],[{sex:''},'Sprawdź płeć i rodzaj stopnia.'],
  [{gradeType:'dan',grade:'10'},'Wartość liczbowa jest poza zakresem.'],[{club:null},'Wybierz klub lub wpisz nazwę nowego klubu.'],[{relation:'self'},minor]])
  assert.equal(athlete.athleteError({...FULL,...patch},TODAY)?.message,msg,JSON.stringify(patch));
 assert.equal(athlete.athleteError({...FULL,relation:'self',birthDate:'2010-11-01'},TODAY),null,'16 on the day: allowed');
 assert.equal(athlete.athleteError({...FULL,relation:'self',birthDate:'2010-11-02'},TODAY)?.message,minor,'one day short of 16');
 assert.equal(athlete.athleteError({...FULL,relation:'guardian',birthDate:'2020-01-01'},TODAY),null,'a parent enters a young child');
 // The same messages as the server: the literals of Domain.php.
 const domain=readFileSync(new URL('../backend/src/Domain.php',import.meta.url),'utf8');
 for(const m of [minor,'Wybierz, kogo zgłaszasz.','Podaj datę urodzenia.','Sprawdź datę urodzenia.','Wybierz klub lub wpisz nazwę nowego klubu.',athlete.lockedMessage()])assert.ok(domain.includes("'"+m+"'"),m);
 assert.equal(minor,'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
 for(const lang of ['pl','en'])assert.doesNotMatch(inLanguage(lang,()=>athlete.minorMessage()),/zaznacz|wybierz|Moje dziecko|tick|choose|select|child or/i,'no hint to change the answer ('+lang+')');
 assert.equal(athlete.minorSelf({relation:'self',birthDate:'2012-01-01'},TODAY),true);assert.equal(athlete.minorSelf({relation:'guardian',birthDate:'2012-01-01'},TODAY),false);
 assert.equal(athlete.minorSelf({relation:'self',birthDate:''},TODAY),false);assert.equal(athlete.minorSelf({relation:'self',birthDate:'2012-13-45'},TODAY),false);
 const shown=String(athlete.athleteFieldsHtml({...athlete.newAthlete(),relation:'self',birthDate:'2015-01-01'},{today:TODAY}));
 assert.match(shown,/<p class="acct-minor" data-acct-minor aria-live="polite">Osoby poniżej 16 lat rejestruje rodzic lub opiekun\. Poproś go o założenie konta\.<\/p>/);
});
test('landing after the sign-up (§10.1, UX-3): plan while payments are required, then target tournament, organizer, athlete, chat',()=>{
 const paid=(me,full=false)=>({...me,billing:{enabled:true,enforce:true},access:{full,state:full?'active':'none'}});
 assert.deepEqual(flow.landing(memberMe()),{page:'chat',params:null});
 assert.deepEqual(flow.landing(memberMe({organizer:true})),{page:'tournaments',params:null});
 assert.deepEqual(flow.landing(memberMe({athlete:true},[ZOSIA])),{page:'starts',params:null});
 assert.deepEqual(flow.landing(memberMe({athlete:true,organizer:true},[ZOSIA])),{page:'tournaments',params:null},'both roles: the organizer tools');
 assert.deepEqual(flow.landing(memberMe({athlete:true,organizer:true},[ZOSIA]),{as:'athlete',t:null}),{page:'starts',params:null},'started as an athlete');
 assert.deepEqual(flow.landing(memberMe({athlete:true},[ZOSIA]),{as:'athlete',t:'t-1'}),{page:'guest',params:{t:'t-1',enter:'1'}},'back to the tournament with the entry window');
 assert.deepEqual(flow.landing(memberMe(),{as:'athlete',t:'t-1'}),{page:'chat',params:null},'"Zawodnik" unticked: the target is not used');
 assert.deepEqual(flow.landing(memberMe({organizer:true}),{as:'athlete',t:'t-1'}),{page:'tournaments',params:null},'only "Organizator" ticked after the athlete offer: the organizer tools');
 assert.deepEqual(flow.landing(memberMe({organizer:true,athlete:true},[ZOSIA]),{as:'athlete',t:'t-1'}),{page:'guest',params:{t:'t-1',enter:'1'}},'both roles from the offer: the tournament');
 assert.deepEqual(flow.landing(memberMe({athlete:true}),{as:'athlete',t:'../x'}),{page:'starts',params:null},'a malformed id is ignored');
 assert.deepEqual(flow.landing(paid(memberMe({athlete:true})),{as:'athlete',t:'t-1'}),{page:'signup',params:{step:'3'}},'the plan first');
 assert.deepEqual(flow.landing(paid(memberMe({athlete:true})),{as:'athlete',t:'t-1'},{later:true}),{page:'guest',params:{t:'t-1',enter:'1'}},'"later" skips the plan');
 assert.deepEqual(flow.landing(paid(memberMe({organizer:true}),true)),{page:'tournaments',params:null},'paid with full access');
 assert.deepEqual(flow.landing(null),{page:'chat',params:null});
 const src=source('account-flow.js');
 assert.doesNotMatch(src,/'Konto utworzone\.'\)\);goChat\(\)/,'no fixed chat after the sign-up');
 assert.match(src,/act==='later'\)\{flowEnd\(\);if\(!land\(getMe\(\),\{later:true\}\)\)goChat\(\);\}/,'"Później" uses landing()');
});
test('roleName (§4.5): Organizator, Zawodnik, Opiekun zawodnika, Członek; null for staff',()=>{
 assert.equal(flow.roleName(memberMe({organizer:true},[ZOSIA])),'Organizator');
 assert.equal(flow.roleName(memberMe({athlete:true},[{...ZOSIA,relation:'self'}])),'Zawodnik');
 assert.equal(flow.roleName(memberMe({athlete:true},[ZOSIA])),'Opiekun zawodnika');
 assert.equal(flow.roleName(memberMe({},[{...ZOSIA,archived:true}])),'Członek','an archived profile does not count');
 assert.equal(flow.roleName(memberMe()),'Członek');assert.equal(flow.roleName({user:{role:'editor',caps:{}}}),null);assert.equal(flow.roleName(null),null);
 assert.equal(inLanguage('en',()=>flow.roleName(memberMe({athlete:true},[ZOSIA]))),'Athlete’s guardian');
});
test('"Role" tab states: organizer on, off and blocked (with the support address); one athlete profile, never "add another" (§10.2, §17)',()=>{
 const view=(me,st)=>String(flow.rolesView(me,st));
 let html=view(memberMe());
 assert.match(html,/data-acct-act="organizer-toggle" data-on="true">Włącz rolę organizatora/);assert.match(html,/Rola wyłączona/);
 assert.match(html,/data-acct-act="athlete-add"/,'no profile yet: add one');assert.doesNotMatch(html,/athlete-edit|athlete-forget/);
 html=view(memberMe({organizer:true,athlete:true},[ZOSIA]));
 assert.match(html,/data-acct-act="organizer-toggle" data-on="false">Wyłącz rolę organizatora/);assert.match(html,/Rola włączona/);
 assert.match(html,/Zosia Kowalska/);assert.match(html,/Dziecko lub podopieczny/);
 for(const act of ['athlete-edit','athlete-archive','athlete-forget'])assert.match(html,new RegExp('data-acct-act="'+act+'" data-id="p1"'),act);
 assert.doesNotMatch(html,/athlete-add/,'one athlete profile per account: no "add" once it exists');
 assert.doesNotMatch(html,/kolejn|another/i);
 html=view(memberMe({},[{...ZOSIA,archived:true}]));
 assert.match(html,/data-archived="false">Przywróć profil zawodnika/);assert.match(html,/Zarchiwizowany/);assert.doesNotMatch(html,/athlete-add/,'an archived profile is restored, not replaced');
 html=view(memberMe({organizerBlocked:true}));
 assert.doesNotMatch(html,/organizer-toggle/,'blocked: no switch');assert.match(html,/Administrator wyłączył tę rolę\./);
 assert.equal(flow.rolesState(memberMe({organizerBlocked:true})).organizer.blocked,true);
 assert.deepEqual(flow.rolesState(memberMe({},[ZOSIA])).canAdd,false);assert.deepEqual(flow.rolesState(memberMe()).canAdd,true);
 // The edit form of the tab: the shared athlete form.
 html=view(memberMe({athlete:true},[ZOSIA]),{mode:'edit',f:athlete.newAthlete(),view:null,loading:false,error:''});
 assert.match(html,/<form id="acct-athlete-form"/);assert.match(html,/Kogo zgłaszasz\?/);assert.match(html,/data-acct-act="athlete-cancel"/);
 // The blocked text with the help address from public-config, as a mailto link.
 const src=source('account-flow.js');
 assert.match(src,/T\('Administrator wyłączył tę rolę\.'\)\} \$\{support\?h`\$\{T\('Napisz na'\)\} <a class="acct-link" href="mailto:\$\{support\}">\$\{support\}<\/a>\.`:''\}/);
 assert.match(src,/athleteApi\('athlete-forget',\{profileId:id,password\}\)/,'deleting the athlete data asks for the password');
 assert.match(src,/Client\.request\('roles',\{method:'POST',body:\{organizer:el\.dataset\.on==='true'\}\}\)/,'roles sends only the organizer flag');
 assert.match(src,/athleteApi\('athlete-save',\{\.\.\.\(st\.f\.id\?\{id:st\.f\.id\}:\{\}\),\.\.\.athleteBody\(st\.f\)\}\)/);
 for(const lang of ['pl','en'])inLanguage(lang,()=>{for(const me of [memberMe(),memberMe({organizer:true,athlete:true},[ZOSIA]),memberMe({organizerBlocked:true},[{...ZOSIA,archived:true}])])assert.doesNotMatch(view(me),lang==='en'?/[ąćęłńśźż]/:/\[object|undefined/,lang);});
});
test('banners and offers for the roles: view-only banner for organizers and athletes, join card, athlete CTA of open self-entry tournaments',()=>{
 const me=(caps,access={full:false,state:'none'})=>({user:{role:'member',caps},access,billing:{enabled:true,enforce:true}});
 assert.deepEqual(boot.bannerInfo(me({organizer:true})),{kind:'blocked',until:null,member:'organizer'});
 assert.deepEqual(boot.bannerInfo(me({athlete:true})),{kind:'blocked',until:null,member:'athlete'});
 assert.equal(boot.bannerInfo(me({})),null,'a member without roles gets the chat CTA');
 assert.equal(boot.bannerInfo(me({athlete:true},{full:true,state:'active'})),null);
 assert.match(source('account-boot.js'),/T\('Zgłaszaj się do turniejów'\),T\('Organizuj własne turnieje'\)/,'the join card lists both roles');
 const open={id:'t-1',status:'open',selfEntry:true};
 try{
  setAccessKind('free',{translate:t});
  const a=accessFor(open);assert.equal(a.cta,'Załóż konto zawodnika i zgłoś się');assert.deepEqual(a.target,{as:'athlete',t:'t-1'});assert.equal(a.note,ACCESS.variants.free.note);
  assert.doesNotMatch(a.text,/Konta klubów|Administrator turnieju/,'no club-account sentence');
  for(const t2 of [{...open,selfEntry:false},{...open,status:'closed'},{...open,selfEntry:undefined},null])assert.equal(accessFor(t2).target,null,JSON.stringify(t2));
  setAccessKind('login');assert.equal(accessFor(open).target,null,'no sign-up: the login offer');assert.equal(accessFor(open).cta,'Zaloguj się');
 }finally{setAccessKind('login');}
 assert.match(source('account-boot.js'),/location\.hash=signupHash\(\{as:el\?\.dataset\?\.signupAs,t:el\?\.dataset\?\.tournamentId\}\)/,'the CTA leads to #signup?as=athlete&t=…');
});

// ---- Browser checks ----
let chromium=null;try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const BROWSER=process.env.MATDRAW_BROWSER_TESTS==='1'&&!!chromium,API=process.env.MATDRAW_TEST_URL,SHOTS=process.env.MATDRAW_ACCOUNT_SHOTS;
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const serve=()=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p.endsWith('/'))p+='index.html';
  try{const body=await readFile(join(root,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
const watch=(page,errors)=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/status of 40[0-9]/.test(m.text()))errors.push(m.text());});};
const shot=async(page,name)=>{if(!SHOTS)return;mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:join(SHOTS,name+'.png'),fullPage:true});};
const noOverflow=async(page,what)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'horizontal overflow: '+what);

test('demo in a browser: sign-up shows the demo message, the profile saves to localStorage and keeps a draft across a language switch',{skip:!BROWSER&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 // The server is closed also when Chromium cannot start, so no open handle keeps the test process alive.
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),errors=[];
 try{
  for(const [w,hh] of [[1440,900],[390,844]]){
   const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:'pl-PL'}),page=await ctx.newPage();watch(page,errors);
   await page.goto(url+'#signup');await page.waitForSelector('[data-acct-public] .notice');
   assert.match(await page.textContent('.acct-card'),/niedostępna w wersji demonstracyjnej/);
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('matdraw.flow.active')),null,'no flow mark without a sign-up');
   await noOverflow(page,'demo signup '+w);await shot(page,'demo-signup-'+w);
   await page.click('.acct-card [data-acct-act="to-login"]');await page.waitForSelector('#login-form');
   assert.equal(await page.locator('[data-account-mount="join"] .acct-join').count(),0,'sign-up disabled in the demo: no card');
   await page.click('[data-action="demo-login"][data-role="editor"]');await page.waitForSelector('.app-shell');
   if(w<800)await page.click('.topbar [data-action="menu"]');
   await page.click('[data-action="my-account"]');await page.waitForSelector('#acct-profile-form');
   await noOverflow(page,'demo profile '+w);await shot(page,'demo-profile-'+w);
   await page.fill('#acct-profile-form [name="clubText"]','KS Tygrys Kraków');await page.click('[data-sport="judo"]');
   await page.click('[data-set-lang="en"]');await page.waitForSelector('#acct-tab-profile');
   assert.equal(await page.textContent('#acct-tab-profile'),'Profile');
   assert.equal(await page.inputValue('#acct-profile-form [name="clubText"]'),'KS Tygrys Kraków','the draft survives the language switch');
   assert.equal(await page.getAttribute('[data-sport="judo"]','aria-pressed'),'true');
   await page.click('#acct-profile-form button[type="submit"]');await page.waitForFunction(()=>!!localStorage.getItem('matdraw.profile.demo.demo-editor'));
   const saved=JSON.parse(await page.evaluate(()=>localStorage.getItem('matdraw.profile.demo.demo-editor')));
   assert.equal(saved.clubText,'KS Tygrys Kraków');assert.deepEqual(saved.sports,['taekwondo','judo']);assert.equal(saved.nameDisplay,'initial');
   await page.click('#acct-tab-subscription');await page.waitForSelector('.acct-sub');assert.match(await page.textContent('.acct-sub'),/Payments are turned off/);
   await page.click('#acct-tab-security');await page.waitForSelector('#acct-password-form');
   assert.equal(await page.locator('#acct-email-form').count(),0,'staff change the e-mail through the Administrator');
   await page.click('[data-set-lang="pl"]');await ctx.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});

test('PHP build in a browser: sign-up, Checkout and return, portal, cancel, profile, e-mail, password, deletion, temporary password, staff banner',{skip:(!BROWSER||!API)&&'MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh needed',timeout:300000},async()=>{
 const {fixture,Client}=await import('./helpers/http-client.mjs');
 fixture('reset-limits');
 const app=API.replace(/api\/index\.php$/,''),stubPort=Number(new URL(API).port)+1;
 const stub=async(op,body={})=>{const r=await fetch(`http://127.0.0.1:${stubPort}/__control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...body})});return r.json();};
 const browser=await chromium.launch(),errors=[];
 const context=async(w=1440,hh=900,lang='pl')=>{
  const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:lang==='pl'?'pl-PL':'en-GB'});
  await ctx.addInitScript(l=>{try{if(!localStorage.getItem('matdraw.language'))localStorage.setItem('matdraw.language',l);}catch{}},lang);
  // Stripe-hosted pages: Checkout completes the session in the stub and returns to success_url; the portal returns at once.
  await ctx.route('https://checkout.stripe.com/**',async route=>{const id=new URL(route.request().url()).pathname.split('/').pop();await stub('pay',{sessionId:id});await route.fulfill({status:302,headers:{location:app+'?billing=success&session_id='+id}});});
  await ctx.route('https://billing.stripe.com/**',route=>route.fulfill({status:302,headers:{location:app+'?billing=portal'}}));
  const page=await ctx.newPage();watch(page,errors);return {ctx,page};
 };
 const mark=page=>page.evaluate(()=>sessionStorage.getItem('matdraw.flow.active'));
 try{
  // Home page: sign-up card with the price and the "forgot password" panel with the help address (§8.9, §3.10).
  let {ctx,page}=await context();
  await page.goto(app);await page.waitForSelector('[data-account-mount="join"] .acct-join');
  assert.match(spaces(await page.textContent('.acct-join')),/8,99 zł/);assert.match(spaces(await page.textContent('.acct-join')),/Poza Polską: \$2\.99|Poza Polską: 2,99 USD/);
  await page.click('[data-acct-act="help"]');assert.match(await page.textContent('#acct-help-panel'),/pomoc@example\.test/);
  await shot(page,'php-home-1440');
  // A sign-up left without the "log in" button (another address, Back) forgets what was typed (shared devices, §8.3 point 8).
  await page.click('.acct-join-cta');await page.waitForSelector('#acct-signup-1');
  await page.fill('#acct-signup-1 [name="email"]','someone.else@example.test');await page.fill('#acct-signup-1 [name="password"]','Cudzy-Sekret-2026');
  await page.evaluate(()=>{location.hash='';});await page.waitForSelector('#login-form');
  // The back/forward cache (another site, then Back) keeps the DOM without a 'painted': what was typed is dropped on pagehide and the
  // sign-up starts over on pageshow (Playwright's Chromium has no real bfcache, so the events are dispatched).
  await page.click('.acct-join-cta');await page.waitForSelector('#acct-signup-1');
  await page.fill('#acct-signup-1 [name="email"]','someone.else@example.test');await page.fill('#acct-signup-1 [name="password"]','Cudzy-Sekret-2026');
  assert.deepEqual(await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));document.querySelector('#acct-signup-1').dataset.stale='1';
   return [...document.querySelectorAll('#acct-signup-1 [name="email"],#acct-signup-1 [name="password"]')].map(el=>el.value);}),['',''],'pagehide clears the typed e-mail and password');
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.waitForSelector('#acct-signup-1:not([data-stale])');
  assert.equal(await page.inputValue('#acct-signup-1 [name="password"]'),'','the restored sign-up starts over');assert.ok(await mark(page),'the restored sign-up sets the mark again');
  // A signup-begin answer that arrives after the sign-up was left does not set the flow mark again (pwa.js would hold back updates).
  await page.evaluate(()=>{location.hash='';});await page.waitForSelector('#login-form');assert.equal(await mark(page),null,'mark removed on leaving');
  let release;const held=new Promise(resolve=>{release=resolve;}),isBegin=u=>new URL(u).searchParams.get('route')==='signup-begin';
  await page.route(isBegin,async route=>{await held;await route.continue();});
  const asked=page.waitForRequest(r=>isBegin(r.url()));await page.click('.acct-join-cta');await asked;await page.evaluate(()=>{location.hash='';});await page.waitForSelector('#login-form');
  const answered=page.waitForResponse(r=>isBegin(r.url()));release();await answered;await page.unroute(isBegin);
  await page.evaluate(()=>new Promise(r=>setTimeout(r,200)));assert.equal(await mark(page),null,'a late signup-begin answer leaves no mark');
  // Step 1.
  await page.click('.acct-join-cta');await page.waitForSelector('#acct-signup-1');
  assert.equal(await page.inputValue('#acct-signup-1 [name="email"]'),'','e-mail of the left sign-up is gone');assert.equal(await page.inputValue('#acct-signup-1 [name="password"]'),'','password of the left sign-up is gone');
  const begun=Date.now();assert.ok(await mark(page),'mark set when the sign-up starts');
  const email='e2e.'+Date.now()+'@example.test',password='Zielony-Rower-2026';
  await page.fill('#acct-signup-1 [name="email"]',email);await page.fill('#acct-signup-1 [name="password"]',password);
  assert.match(await page.textContent('#acct-signup-pw-hint'),/Hasło: (dobre|bardzo dobre)/);
  await shot(page,'php-signup1-1440');
  await page.click('#acct-signup-1 button[type="submit"]');await page.waitForSelector('#acct-signup-2');
  // Step 2: suggestion from the names, live check, language switch keeps everything (QA §11 point 1).
  await page.fill('#acct-signup-2 [name="firstName"]','Marta');await page.fill('#acct-signup-2 [name="lastName"]','Kowalska');
  await page.waitForSelector('#acct-signup-2 .acct-st.ok');assert.equal(await page.inputValue('#acct-signup-2 [name="username"]'),'marta.k','the prefill uses the surname initial only (§7.7)');
  assert.equal(await page.inputValue('#acct-signup-2 [name="country"]'),'PL');assert.equal(await page.isChecked('#acct-signup-2 [name="fullName"]'),false);
  await page.click('[data-sport="karate"]');await page.click('[data-sport="taekwondo"]');
  await page.fill('#acct-signup-2 [name="clubText"]','KS Tygrys');
  await page.click('[data-set-lang="en"]');await page.waitForFunction(()=>document.querySelector('#acct-step-title')?.textContent==='Your profile');
  for(const [name,value] of [['firstName','Marta'],['lastName','Kowalska'],['username','marta.k'],['clubText','KS Tygrys'],['country','PL']])assert.equal(await page.inputValue(`#acct-signup-2 [name="${name}"]`),value,name);
  assert.equal(await page.getAttribute('[data-sport="karate"]','aria-pressed'),'true');
  await page.click('[data-set-lang="pl"]');await page.waitForFunction(()=>document.querySelector('#acct-step-title')?.textContent==='Twój profil');
  await shot(page,'php-signup2-1440');
  assert.ok(await mark(page),'mark kept in step 2');
  await page.waitForTimeout(Math.max(0,3500-(Date.now()-begun)));
  await page.click('#acct-signup-2 button[type="submit"]');
  // Step 3 after the reload: plan in PLN, the mark still set.
  await page.waitForSelector('.acct-plan .acct-pay',{timeout:20000});assert.ok(await mark(page),'mark kept in step 3');
  assert.match(spaces(await page.textContent('.acct-plan')),/8,99 zł/);assert.match(await page.textContent('.acct-steps-label'),/Krok 3 z 3/);
  await page.waitForFunction(()=>document.activeElement?.classList.contains('acct-created'),null,{timeout:5000});// focus on "Konto utworzone", not <body>
  await shot(page,'php-signup3-1440');
  const checkout=page.waitForRequest(r=>r.url().includes('route=billing-checkout'));
  await page.click('[data-acct-act="checkout"]');
  assert.deepEqual(JSON.parse((await checkout).postData()),{lang:'pl'},'billing-checkout sends the language only');
  await page.waitForSelector('.acct-return.success',{timeout:30000});
  assert.equal(await mark(page),null,'mark removed after "Done!"');
  assert.equal(await page.evaluate(()=>location.search+'|'+location.hash),'|#billing','parameters removed');
  await shot(page,'php-return-success-1440');
  // Subscription tab and the portal return (billing-sync).
  await page.goto(app+'#profile?tab=subscription');await page.waitForSelector('.acct-sub-state');
  assert.match(await page.textContent('.acct-sub-state'),/Aktywna do/);await shot(page,'php-subscription-1440');
  // The page already shows this address: wait for the real round trip (portal, return, billing-sync, toast) before moving on.
  const portalSync=page.waitForResponse(r=>r.url().includes('route=billing-sync'),{timeout:20000});
  await page.click('.acct-sub [data-acct-act="portal"]');assert.equal((await portalSync).status(),200,'billing-sync after the portal');
  await page.waitForFunction(()=>location.hash==='#profile?tab=subscription'&&!!document.querySelector('.acct-sub-state')&&!!document.querySelector('#toast')?.textContent.includes('Zaktualizowano informacje o subskrypcji.'),null,{timeout:20000});
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('matdraw.billing.return')),null,'portal return handled');
  // Cancel return.
  await page.goto(app+'?billing=cancel');await page.waitForSelector('.acct-return');assert.match(await page.textContent('.acct-return'),/Płatność przerwana/);assert.equal(await mark(page),null);
  // Profile: change the club and the full-name choice.
  await page.goto(app+'#profile');await page.waitForSelector('#acct-profile-form');
  await page.fill('#acct-profile-form [name="clubText"]','UKS Smok');await page.check('#acct-profile-form [name="fullName"]');
  const saved=page.waitForResponse(r=>r.url().includes('route=profile'));await page.click('#acct-profile-form button[type="submit"]');
  const body=(await saved).request().postDataJSON();assert.equal(body.nameDisplay,'full');assert.equal(body.clubText,'UKS Smok');assert.equal((await saved).status(),200);
  await shot(page,'php-profile-1440');
  // An unsaved edit is dropped once another page is shown: coming back shows the saved profile.
  await page.fill('#acct-profile-form [name="clubText"]','Niezapisany Klub');await page.evaluate(()=>{location.hash='#billing';});await page.waitForSelector('.acct-plan');
  await page.evaluate(()=>{location.hash='#profile';});await page.waitForSelector('#acct-profile-form');
  assert.equal(await page.inputValue('#acct-profile-form [name="clubText"]'),'UKS Smok','the saved value, not the left draft');
  // E-mail and password (members), then deletion with the second confirmation (active subscription).
  await page.click('#acct-tab-security');await page.waitForSelector('#acct-email-form');
  const email2='e2e.new.'+Date.now()+'@example.test';
  await page.fill('#acct-email-form [name="email"]',email2);await page.fill('#acct-email-form [name="currentPassword"]',password);
  await page.click('#acct-email-form button[type="submit"]');await page.waitForFunction(e=>document.querySelector('#acct-email-form')?.textContent.includes(e),email2);
  await page.fill('#acct-password-form [name="currentPassword"]',password);await page.fill('#acct-password-form [name="password"]','Niebieski-Rower-2027');
  await page.click('#acct-password-form button[type="submit"]');await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Hasło zostało zmienione'));
  await shot(page,'php-security-1440');
  await page.click('[data-acct-act="delete-open"]');await page.waitForSelector('#acct-delete-form');
  await page.fill('#acct-delete-form [name="password"]','Niebieski-Rower-2027');await page.click('#modal-root button[form="acct-delete-form"]');
  await page.waitForSelector('#acct-delete-form .acct-delete-end:not([hidden])');assert.match(await page.textContent('.acct-delete-end'),/aktywną subskrypcję/);
  await shot(page,'php-delete-confirm-1440');
  await page.click('#modal-root button[form="acct-delete-form"]');await page.waitForSelector('#login-form',{timeout:20000});
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Konto zostało usunięte'));
  await ctx.close();

  // Temporary password (§3.10): forced to #profile?tab=security, other pages blocked until the change.
  const admin=new Client();await admin.login('admin@test.example','AdminForTests2026!');
  const m=fixture('member',{email:'e2e.temp.'+Date.now()+'@example.test',profile:true,exempt:'e2e'});
  const reset=await admin.req('admin-member',{action:'password',userId:m.id});assert.equal(reset.status,200,JSON.stringify(reset.data));
  ({ctx,page}=await context(390,844));
  await page.goto(app);await page.fill('#login-form [name="email"]',m.email);await page.fill('#login-form [name="password"]',reset.data.temporaryPassword);
  await page.click('#login-form button[type="submit"]');await page.waitForSelector('.acct-must',{timeout:20000});
  assert.equal(await page.evaluate(()=>location.hash),'#profile?tab=security');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('acct-must'),null,{timeout:5000});// focus on the notice, not <body>
  await page.evaluate(()=>{location.hash='#chat';});await page.waitForFunction(()=>location.hash==='#profile?tab=security');
  assert.ok(await page.isDisabled('#acct-tab-profile'));await noOverflow(page,'temporary password 390');await shot(page,'php-temporary-390');
  await page.fill('#acct-password-form [name="currentPassword"]',reset.data.temporaryPassword);await page.fill('#acct-password-form [name="password"]','Pomaranczowy-Rower-2028');
  await page.click('#acct-password-form button[type="submit"]');await page.waitForFunction(()=>location.hash!=='#profile?tab=security',null,{timeout:20000});
  await page.waitForFunction(()=>document.activeElement&&document.activeElement!==document.body,null,{timeout:5000});
  assert.match(await page.evaluate(()=>document.activeElement.className+' '+document.activeElement.tagName),/chat-log|H1/,'focus on the chat after the change');
  await ctx.close();

  // Staff banner: free until a date within 14 days (requireFrom), then grace.
  const clubId=admin.data.clubs[0].id,staffEmail='e2e.editor.'+Date.now()+'@example.test';
  const created=await admin.cmd('account.save',{email:staffEmail,clubId,role:'editor',active:true,password:'EditorForTests2026!'});
  const now=Math.floor(Date.now()/1000);fixture('billing',{userId:created.id,billing_exempt:1,exempt_reason:'grandfathered',exempt_until:now+5*86400});
  ({ctx,page}=await context(1440,900));
  await page.goto(app);await page.fill('#login-form [name="email"]',staffEmail);await page.fill('#login-form [name="password"]','EditorForTests2026!');
  await page.click('#login-form button[type="submit"]');await page.waitForSelector('.acct-banner');assert.match(await page.textContent('.acct-banner'),/konto wymaga płatności/);
  await shot(page,'php-staff-banner-1440');
  fixture('billing',{userId:created.id,exempt_until:now-2*86400});await page.reload();await page.waitForSelector('.acct-banner');assert.match(await page.textContent('.acct-banner'),/Karencja do/);
  await page.click('.acct-banner [data-acct-act="plan"]');await page.waitForSelector('.acct-plan');assert.equal(await page.locator('.acct-banner').count(),0,'no banner on the plan page');
  await ctx.close();

  // billing-checkout 409 {portal:true} (Stripe still holds a subscription, e.g. past_due after the grace days): the plan page offers
  // the Customer Portal instead of painting the same checkout button again.
  const payer=fixture('member',{email:'e2e.payer.'+Date.now()+'@example.test',profile:true});
  ({ctx,page}=await context(1440,900));
  await page.goto(app);await page.fill('#login-form [name="email"]',payer.email);await page.fill('#login-form [name="password"]','TestPassword2026!');
  await page.click('#login-form button[type="submit"]');await page.waitForSelector('.app-shell');
  // A member's shell (F13): the own name and @username instead of the role "Członek", initials from the profile.
  await page.waitForFunction(()=>document.querySelector('.sidebar [data-self-name]')?.textContent==='Test Członek');
  assert.match(await page.textContent('.sidebar [data-self-sub]'),/^@e2epayer/);assert.equal(await page.textContent('.sidebar [data-self-avatar]'),'TC');
  await page.goto(app+'#billing');await page.waitForSelector('.acct-plan [data-acct-act="checkout"]');
  const isCheckout=u=>new URL(u).searchParams.get('route')==='billing-checkout';
  await page.route(isCheckout,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Masz już aktywną subskrypcję.',portal:true})}));
  await page.click('.acct-plan [data-acct-act="checkout"]');await page.waitForSelector('.acct-plan [data-acct-act="portal"]');
  assert.match(await page.textContent('.acct-plan h2'),/Masz już aktywną subskrypcję/);assert.equal(await page.locator('.acct-plan [data-acct-act="checkout"]').count(),0,'no second checkout button');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.acctAct),'portal','focus on the portal button');
  const portalAsked=page.waitForRequest(r=>new URL(r.url()).searchParams.get('route')==='billing-portal');await page.click('.acct-plan [data-acct-act="portal"]');await portalAsked;
  await page.unroute(isCheckout);
  await ctx.close();

  // Staff password on #profile while someone else saves (final review F3): account.password reads no workspace data, so a revision
  // conflict is retried once with the fresh revision; a conflict that persists is shown in the form, with what was typed kept.
  const pwEmail='e2e.pw.'+Date.now()+'@example.test';
  const pwUser=await admin.cmd('account.save',{email:pwEmail,clubId,role:'editor',active:true,password:'EditorForTests2026!'});
  fixture('billing',{userId:pwUser.id,billing_exempt:1,exempt_reason:'e2e'});
  ({ctx,page}=await context(1440,900));
  await page.goto(app);await page.fill('#login-form [name="email"]',pwEmail);await page.fill('#login-form [name="password"]','EditorForTests2026!');
  await page.click('#login-form button[type="submit"]');await page.waitForSelector('.app-shell');
  await page.goto(app+'#profile?tab=security');await page.waitForSelector('#acct-password-form');
  await admin.load();await admin.cmd('account.save',{email:'e2e.bump.'+Date.now()+'@example.test',clubId,role:'editor',active:true,password:'EditorForTests2026!'});
  const statuses=[];const onCommand=r=>{if(r.url().includes('route=command'))statuses.push(r.status());};page.on('response',onCommand);
  await page.fill('#acct-password-form [name="currentPassword"]','EditorForTests2026!');await page.fill('#acct-password-form [name="password"]','Zielona-Herbata-2029');
  await page.click('#acct-password-form button[type="submit"]');await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Hasło zostało zmienione'),null,{timeout:20000});
  assert.deepEqual(statuses,[409,200],'the stale revision is retried once');page.off('response',onCommand);
  const old=new Client();await old.req('session');assert.notEqual((await old.req('login',{email:pwEmail,password:'EditorForTests2026!'})).status,200,'the old password no longer works');
  // Every command answers 409: the message is visible in the (re-rendered) form and the typed values stay.
  const isCommand=u=>new URL(u).searchParams.get('route')==='command';
  await page.route(isCommand,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.'})}));
  await page.fill('#acct-password-form [name="currentPassword"]','Zielona-Herbata-2029');await page.fill('#acct-password-form [name="password"]','Czerwona-Herbata-2030');
  await page.click('#acct-password-form button[type="submit"]');
  await page.waitForFunction(()=>document.querySelector('#acct-password-form .form-error')?.textContent.trim().length>0,null,{timeout:20000});
  assert.match(await page.textContent('#acct-password-form .form-error'),/Dane zmieniły się/);
  assert.equal(await page.inputValue('#acct-password-form [name="password"]'),'Czerwona-Herbata-2030','typed values kept');
  await page.unroute(isCommand);
  await ctx.close();
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('demo in a browser: the "Role" tab of the parent and of the organizer, PL and EN, 1440 and 390 px without horizontal scroll',{skip:!BROWSER&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),errors=[];
 try{
  for(const [w,hh] of [[1440,900],[390,844]])for(const lang of ['pl','en']){
   const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:lang==='pl'?'pl-PL':'en-GB'});await ctx.addInitScript(l=>{try{localStorage.setItem('matdraw.language',l);}catch{}},lang);
   const page=await ctx.newPage();watch(page,errors);
   await page.goto(url);await page.click('[data-action="demo-login"][data-role="athlete"]');await page.waitForSelector('.app-shell');
   await page.evaluate(()=>{location.hash='#profile?tab=roles';});await page.waitForSelector('.acct-role');
   assert.equal(await page.getAttribute('#acct-tab-roles','aria-selected'),'true');
   assert.equal(await page.textContent('.acct-role-name'),lang==='pl'?'Opiekun zawodnika':'Athlete’s guardian','role name of a parent');
   assert.equal(await page.locator('[data-acct-act="athlete-add"]').count(),0,'one athlete profile: no add');
   assert.equal(await page.locator('[data-acct-act="athlete-edit"]').count(),1);
   await noOverflow(page,'demo roles parent '+w+' '+lang);await shot(page,`demo-roles-parent-${lang}-${w}`);
   // Keyboard: the tabs move with the arrows (roving tabindex), Role sits between Profil and Subskrypcja.
   await page.focus('#acct-tab-roles');await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>document.activeElement?.id),'acct-tab-profile');
   await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement?.id),'acct-tab-roles');
   await page.click('[data-action="logout"]').catch(()=>{});await ctx.close();
   const ctx2=await browser.newContext({viewport:{width:w,height:hh},locale:lang==='pl'?'pl-PL':'en-GB'});await ctx2.addInitScript(l=>{try{localStorage.setItem('matdraw.language',l);}catch{}},lang);
   const page2=await ctx2.newPage();watch(page2,errors);
   await page2.goto(url);await page2.click('[data-action="demo-login"][data-role="organizer"]');await page2.waitForSelector('.app-shell');
   await page2.evaluate(()=>{location.hash='#profile?tab=roles';});await page2.waitForSelector('.acct-role');
   assert.equal(await page2.getAttribute('[data-acct-act="organizer-toggle"]','data-on'),'false','the organizer can turn the role off');
   assert.equal(await page2.locator('[data-acct-act="athlete-add"]').count(),1,'no athlete profile yet: add one');
   await page2.click('[data-acct-act="athlete-add"]');await page2.waitForSelector('#acct-athlete-form');
   assert.equal(await page2.evaluate(()=>document.activeElement?.name),'relation','focus on "Kogo zgłaszasz?"');
   await page2.check('#acct-athlete-form input[name="relation"][value="self"]');
   assert.equal(await page2.inputValue('#acct-athlete-form [name="athleteName"]'),'Marek Organizator','"Siebie" fills the own name');
   await page2.fill('#acct-athlete-form [name="birthDate"]','2015-03-01');await page2.waitForFunction(()=>document.querySelector('[data-acct-minor]')?.textContent.length>0);
   assert.doesNotMatch(await page2.textContent('[data-acct-minor]'),/zaznacz|tick|Moje dziecko|child or/i);
   await page2.check('#acct-athlete-form input[name="relation"][value="guardian"]');
   assert.equal(await page2.inputValue('#acct-athlete-form [name="athleteName"]'),'','the own name is removed for a child');
   assert.equal(await page2.textContent('[data-acct-minor]'),'','no age message for a child');
   await page2.selectOption('#acct-athlete-form [name="gradeType"]','dan');
   assert.deepEqual(await page2.$$eval('#acct-athlete-form [name="grade"] option',o=>o.map(x=>x.value)),['','1','2','3','4','5','6','7','8','9'],'dan grades 1-9');
   await noOverflow(page2,'demo roles organizer form '+w+' '+lang);await shot(page2,`demo-roles-organizer-form-${lang}-${w}`);
   await page2.click('[data-acct-act="athlete-cancel"]');await page2.waitForSelector('[data-acct-act="athlete-add"]');
   // #profile?tab=roles&add=1 (the athlete call to action) opens the form once: add=1 leaves the address, so "Anuluj" followed by
   // a re-render of the page (language switch) does not open it again; then= stays for the way back until "Anuluj".
   await page2.evaluate(()=>{location.hash='#profile?tab=roles&add=1&then=t-winter-2027';});await page2.waitForSelector('#acct-athlete-form');
   assert.equal(await page2.evaluate(()=>location.hash),'#profile?tab=roles&then=t-winter-2027','add=1 is consumed');
   await page2.click('[data-acct-act="athlete-cancel"]');await page2.waitForSelector('[data-acct-act="athlete-add"]');
   assert.equal(await page2.evaluate(()=>location.hash),'#profile?tab=roles','"Anuluj" drops then');
   const other=lang==='pl'?'en':'pl';await page2.click(`[data-set-lang="${other}"]`);await page2.waitForSelector('[data-acct-act="athlete-add"]');
   assert.equal(await page2.locator('#acct-athlete-form').count(),0,'the cancelled form stays closed after a re-render');
   await page2.click(`[data-set-lang="${lang}"]`);await page2.waitForSelector('[data-acct-act="athlete-add"]');
   await ctx2.close();
   // A sign-up target is dropped once the signed-out sign-up is left, so a later plain sign-up does not land on that tournament.
   const ctx3=await browser.newContext({viewport:{width:w,height:hh}});const page3=await ctx3.newPage();watch(page3,errors);
   await page3.goto(url+'#signup?as=athlete&t=t-winter-2027');await page3.waitForSelector('[data-acct-public]');
   assert.equal(JSON.parse(await page3.evaluate(()=>sessionStorage.getItem('matdraw.signup.target'))||'null')?.t,'t-winter-2027');
   await page3.evaluate(()=>{location.hash='';});await page3.waitForFunction(()=>!document.querySelector('[data-acct-public]'));
   assert.equal(await page3.evaluate(()=>sessionStorage.getItem('matdraw.signup.target')),null,'left: the target is gone');
   await ctx3.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.close();}
});

test('PHP build in a browser: sign-up with the roles, the athlete step, landing and the "Role" tab (§4.5, §10.1, §10.2)',{skip:(!BROWSER||!API)&&'MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh needed',timeout:300000},async()=>{
 const {fixture}=await import('./helpers/http-client.mjs');
 fixture('reset-limits');
 const app=API.replace(/api\/index\.php$/,''),browser=await chromium.launch(),errors=[];
 const tour=fixture('tournament',{name:'E2E Zapisy Zawodników',date:'2031-05-10',status:'open'}).id;
 const title=page=>page.evaluate(()=>[document.activeElement?.id,document.querySelector('.acct-steps-label')?.textContent]);
 try{
  for(const [w,hh,lang] of [[1440,900,'pl'],[390,844,'en']]){
   const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:lang==='pl'?'pl-PL':'en-GB'});
   await ctx.addInitScript(l=>{try{if(!localStorage.getItem('matdraw.language'))localStorage.setItem('matdraw.language',l);}catch{}},lang);
   const page=await ctx.newPage();watch(page,errors);const pl=lang==='pl',both=w>800;
   // 1440: from the athlete offer of a tournament (#signup?as=athlete&t=…), both roles, a child; 390: the organizer only.
   await page.goto(app+(both?'#signup?as=athlete&t='+tour:'#signup'));await page.waitForSelector('#acct-signup-1');
   const begun=Date.now();
   assert.equal(await page.isChecked('#acct-signup-1 [name="role-athlete"]'),both,'as=athlete ticks "Zawodnik"');assert.equal(await page.isChecked('#acct-signup-1 [name="role-organizer"]'),false);
   assert.deepEqual(JSON.parse(await page.evaluate(()=>sessionStorage.getItem('matdraw.signup.target'))||'null')?.t??null,both?tour:null,'the target is kept for the landing');
   await page.check('#acct-signup-1 [name="role-organizer"]');
   assert.match(await page.textContent('.acct-steps-label'),both?(pl?/Krok 1 z 4/:/Step 1 of 4/):/Step 1 of 3/,'the count follows the roles');
   await noOverflow(page,'signup 1 '+w);await shot(page,'php-roles-signup1-'+w);
   const email='e2e.roles.'+w+'.'+Date.now()+'@example.test';
   await page.fill('#acct-signup-1 [name="email"]',email);await page.fill('#acct-signup-1 [name="password"]','Zielony-Rower-2026');
   await page.click('#acct-signup-1 button[type="submit"]');await page.waitForSelector('#acct-signup-2');
   await page.waitForFunction(()=>document.activeElement?.id==='acct-step-title');
   assert.match((await title(page))[1],both?/Krok 2 z 4 · Profil/:/Step 2 of 3 · Profile/);
   assert.match(await page.textContent('#acct-signup-2 button[type="submit"]'),both?/Dalej/:/Create account/);
   // A different person per viewport, so the prefilled username is free in both runs.
   const [first,last]=both?['Marta','Kowalska']:['Olga','Zielińska'];
   await page.fill('#acct-signup-2 [name="firstName"]',first);await page.fill('#acct-signup-2 [name="lastName"]',last);await page.waitForSelector('#acct-signup-2 .acct-st.ok');
   await page.click('[data-sport="taekwondo"]');
   await page.waitForTimeout(Math.max(0,3500-(Date.now()-begun)));
   const signup=page.waitForRequest(r=>new URL(r.url()).searchParams.get('route')==='signup');
   if(both){
    await page.click('#acct-signup-2 button[type="submit"]');await page.waitForSelector('#acct-signup-3');
    await page.waitForFunction(()=>document.activeElement?.id==='acct-step-title');
    assert.match((await title(page))[1],/Krok 3 z 4 · Zawodnik/,'the athlete step');
    assert.equal(await page.evaluate(()=>location.hash),'#signup?step=athlete');
    await page.check('#acct-signup-3 input[name="relation"][value="self"]');assert.equal(await page.inputValue('#acct-signup-3 [name="athleteName"]'),'Marta Kowalska');
    await page.fill('#acct-signup-3 [name="birthDate"]','2014-05-05');await page.waitForFunction(()=>document.querySelector('[data-acct-minor]')?.textContent.length>0);
    assert.equal(await page.textContent('[data-acct-minor]'),'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
    await page.check('#acct-signup-3 input[name="relation"][value="guardian"]');assert.equal(await page.inputValue('#acct-signup-3 [name="athleteName"]'),'');
    await page.fill('#acct-signup-3 [name="athleteName"]','Zosia Kowalska');await page.selectOption('#acct-signup-3 [name="sex"]','F');
    await page.fill('#acct-signup-3 [name="weight"]','40.5');await page.fill('#acct-signup-3 [name="height"]','150');await page.selectOption('#acct-signup-3 [name="grade"]','8');
    await page.check('#acct-signup-3 input[name="athleteClubMode"][value="new"]');await page.fill('#acct-signup-3 [name="athleteClubName"]','UKS Smoki E2E '+Date.now().toString(36));
    // Back and forward keep what was typed.
    await page.click('#acct-signup-3 [data-acct-act="signup-back"]');await page.waitForSelector('#acct-signup-2');await page.click('#acct-signup-2 button[type="submit"]');await page.waitForSelector('#acct-signup-3');
    assert.equal(await page.inputValue('#acct-signup-3 [name="athleteName"]'),'Zosia Kowalska');assert.equal(await page.isChecked('#acct-signup-3 input[name="relation"][value="guardian"]'),true);
    await noOverflow(page,'signup athlete '+w);await shot(page,'php-roles-signup3-'+w);
    await page.click('#acct-signup-3 button[type="submit"]');
   }else{assert.equal(await page.locator('#acct-signup-3').count(),0);await page.click('#acct-signup-2 button[type="submit"]');}
   const body=(await signup).postDataJSON();
   assert.deepEqual(body.roles,{organizer:true,athlete:both});
   if(both){assert.equal(body.athlete.relation,'guardian');assert.equal(body.athlete.name,'Zosia Kowalska');assert.equal(body.athlete.weight,40.5);assert.match(body.athlete.club.name,/^UKS Smoki E2E/);}
   else assert.equal(body.athlete,undefined,'no athlete without the role');
   // Payments are required here: the plan step first, counted from me.caps after the reload; "Później" uses landing().
   await page.waitForSelector('.acct-plan .acct-pay',{timeout:20000});
   assert.match(await page.textContent('.acct-steps-label'),both?/Krok 4 z 4 · Plan/:/Step 3 of 3 · Plan/);
   await noOverflow(page,'plan '+w);
   await page.click('[data-acct-act="later"]');
   if(both){
    await page.waitForFunction(t=>location.hash.startsWith('#guest?t='+t),tour,{timeout:20000});
    assert.equal(new URLSearchParams(await page.evaluate(()=>location.hash.split('?')[1])).get('enter'),'1','the entry window is asked for');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('matdraw.signup.target')),null,'the target is used once');
   }else await page.waitForFunction(()=>location.hash.startsWith('#tournaments'),null,{timeout:20000});
   // The "Role" tab of the new account.
   await page.goto(app+'#profile?tab=roles');await page.waitForSelector('.acct-role [data-acct-act="organizer-toggle"]',{timeout:20000});
   assert.equal(await page.getAttribute('[data-acct-act="organizer-toggle"]','data-on'),'false','the organizer role is on');
   if(both){
    assert.match(await page.textContent('.acct-athletes'),/Zosia Kowalska/);assert.equal(await page.locator('[data-acct-act="athlete-add"]').count(),0);
    assert.equal(await page.textContent('.acct-role-name'),'Organizator');
    await page.click('[data-acct-act="athlete-edit"]');await page.waitForSelector('#acct-athlete-form');
    assert.equal(await page.inputValue('#acct-athlete-form [name="athleteName"]'),'Zosia Kowalska');assert.equal(await page.inputValue('#acct-athlete-form [name="weight"]'),'40.5');
    await page.fill('#acct-athlete-form [name="weight"]','41');
    const saved=page.waitForResponse(r=>new URL(r.url()).searchParams.get('route')==='athlete-save');await page.click('#acct-athlete-form button[type="submit"]');
    assert.equal((await saved).status(),200);await page.waitForSelector('.acct-athletes');
    await shot(page,'php-roles-tab-'+w);
    // Turning the organizer role off reloads the page into the tab.
    await page.click('[data-acct-act="organizer-toggle"]');await page.waitForFunction(()=>document.querySelector('[data-acct-act="organizer-toggle"]')?.dataset.on==='true',null,{timeout:20000});
    assert.equal(await page.textContent('.acct-role-name'),'Opiekun zawodnika');
    // Deleting the athlete data asks for the password.
    await page.click('[data-acct-act="athlete-forget"]');await page.waitForSelector('#acct-athlete-forget-form');
    await page.fill('#acct-athlete-forget-form [name="password"]','Zielony-Rower-2026');await page.click('#modal-root button[form="acct-athlete-forget-form"]');
    await page.waitForSelector('[data-acct-act="athlete-add"]',{timeout:20000});assert.equal(await page.textContent('.acct-role-name'),'Członek');
   }else{assert.equal(await page.locator('[data-acct-act="athlete-add"]').count(),1);await shot(page,'php-roles-tab-'+w);}
   await noOverflow(page,'roles tab '+w);
   await ctx.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
