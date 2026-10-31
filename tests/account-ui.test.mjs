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
 assert.doesNotMatch(src+source('account-boot.js'),/route=username-check|username-check\?|apiUrl\(\{route:'username-check'/);
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
 const {server,url}=await serve(),browser=await chromium.launch(),errors=[];
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
  await page.waitForSelector('#acct-signup-2 .acct-st.ok');assert.equal(await page.inputValue('#acct-signup-2 [name="username"]'),'marta.kowalska');
  assert.equal(await page.inputValue('#acct-signup-2 [name="country"]'),'PL');assert.equal(await page.isChecked('#acct-signup-2 [name="fullName"]'),false);
  await page.click('[data-sport="karate"]');await page.click('[data-sport="taekwondo"]');
  await page.fill('#acct-signup-2 [name="clubText"]','KS Tygrys');
  await page.click('[data-set-lang="en"]');await page.waitForFunction(()=>document.querySelector('#acct-step-title')?.textContent==='Your profile');
  for(const [name,value] of [['firstName','Marta'],['lastName','Kowalska'],['username','marta.kowalska'],['clubText','KS Tygrys'],['country','PL']])assert.equal(await page.inputValue(`#acct-signup-2 [name="${name}"]`),value,name);
  assert.equal(await page.getAttribute('[data-sport="karate"]','aria-pressed'),'true');
  await page.click('[data-set-lang="pl"]');await page.waitForFunction(()=>document.querySelector('#acct-step-title')?.textContent==='Twój profil');
  await shot(page,'php-signup2-1440');
  assert.ok(await mark(page),'mark kept in step 2');
  await page.waitForTimeout(Math.max(0,3500-(Date.now()-begun)));
  await page.click('#acct-signup-2 button[type="submit"]');
  // Step 3 after the reload: plan in PLN, the mark still set.
  await page.waitForSelector('.acct-plan .acct-pay',{timeout:20000});assert.ok(await mark(page),'mark kept in step 3');
  assert.match(spaces(await page.textContent('.acct-plan')),/8,99 zł/);assert.match(await page.textContent('.acct-steps-label'),/Krok 3 z 3/);
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
  await page.evaluate(()=>{location.hash='#chat';});await page.waitForFunction(()=>location.hash==='#profile?tab=security');
  assert.ok(await page.isDisabled('#acct-tab-profile'));await noOverflow(page,'temporary password 390');await shot(page,'php-temporary-390');
  await page.fill('#acct-password-form [name="currentPassword"]',reset.data.temporaryPassword);await page.fill('#acct-password-form [name="password"]','Pomaranczowy-Rower-2028');
  await page.click('#acct-password-form button[type="submit"]');await page.waitForFunction(()=>location.hash!=='#profile?tab=security',null,{timeout:20000});
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
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
