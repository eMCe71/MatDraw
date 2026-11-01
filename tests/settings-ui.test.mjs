// Settings and clubs UI of the Administrator (PLAN-REJESTRACJA-ROLE §3.4–§3.6, §5.5, §10.5, §17): the three sign-up modes and their fields,
// the paid option without Stripe, the free-period decision (both group counts, keep / requireFrom), the test-mode confirmation, the
// switch "require confirmation of organizers", the history, the clubs table and the tournament card tools. dist/admin-settings.js and
// dist/admin-clubs.js keep these rules in plain functions, so no browser is needed here (the browser check is in the PHP and demo runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {registry,SafeHtml,h} from '../dist/registry.js';
import {setLanguage} from '../dist/i18n.js';
import {warsawToday} from '../dist/guest-view.js';
import {dayAdd} from '../dist/admin-members.js';
import * as S from '../dist/admin-settings.js';
import * as C from '../dist/admin-clubs.js';

// me.js (imported by settings-boot.js) keeps a BroadcastChannel open, which would keep this process alive: the modules run without it.
globalThis.BroadcastChannel=undefined;
const boot=await import('../dist/settings-boot.js');
setLanguage('pl',{persist:false});
const HOSTILE='<img src=x onerror=alert(1)>';
const english=fn=>{setLanguage('en',{persist:false});try{return fn();}finally{setLanguage('pl',{persist:false});}};
const VIEW=(over={})=>({version:3,signup:'off',payments:'free',organizers:'on',trustRequired:false,mode:'off',effective:{mode:'off',degraded:null},
 support:{email:'hello@matbravo.com',source:'default'},stripe:{enabled:true,mode:'test',check:null},freeSignups:{a:2,b:1,scheduled:{count:0,from:null}},organizersPending:0,
 limits:{organizerDay:3,organizerActive:10,communityDayGlobal:50,organizerProfilesDay:300,clubsDayPerUser:3,clubsDayGlobal:30,minorSelfAge:16,adultAge:18,athletesPerAccount:1,retentionMonths:24},
 history:[],updatedAt:null,updatedBy:null,...over});
const conflict=(code,extra={})=>Object.assign(new Error('x'),{status:409,code,data:{code,...extra}});

test('the settings and clubs pages are registered for the Administrator only and render SafeHtml',()=>{
 for(const id of ['settings','clubs']){
  const page=registry.page(id);assert.ok(page&&page.nav==='admin',id);assert.deepEqual(page.roles,['admin']);
  for(const role of ['editor','club','member'])assert.ok(!registry.navItems({role}).some(i=>i.id===id),role+' '+id);
  assert.ok(registry.navItems({role:'admin'}).some(i=>i.id===id));
 }
 registry.provide('ui',{shell:(content,title)=>h`<main><h1>${title}</h1>${content}</main>`});
 assert.ok(registry.page('settings').render() instanceof SafeHtml);assert.match(registry.page('settings').render().html,/data-settings-root/);
 assert.match(registry.page('clubs').render().html,/data-clubs-root/);
 assert.ok(registry.navItems({role:'admin'}).findIndex(i=>i.id==='clubs')<registry.navItems({role:'admin'}).findIndex(i=>i.id==='settings'));
});

test('mode mapping: off / free / paid to signup and payments, and only changed fields are sent',()=>{
 assert.deepEqual(S.MODES,['off','free','paid']);
 assert.equal(S.modeOf({signup:'off',payments:'paid'}),'off');assert.equal(S.modeOf({signup:'on',payments:'free'}),'free');assert.equal(S.modeOf({signup:'on',payments:'paid'}),'paid');assert.equal(S.modeOf(null),'off');
 assert.deepEqual(S.modeFields('free'),{signup:'on',payments:'free'});
 assert.deepEqual(S.modeFields('paid'),{signup:'on',payments:'paid'});
 assert.deepEqual(S.modeFields('off'),{signup:'off',payments:'free'});
 assert.deepEqual(S.modeFields('off',{paymentsOn:true}),{signup:'off',payments:'paid'},'off with the payments of existing accounts');
 assert.deepEqual(S.modeFields('free',{paymentsOn:true}),{signup:'on',payments:'free'},'the extra switch matters only for off');
 const v=VIEW();
 assert.deepEqual(S.changedFields(v,S.modeFields('off')),{},'nothing changed');
 assert.deepEqual(S.changedFields(v,S.modeFields('free')),{signup:'on'});
 assert.deepEqual(S.changedFields(v,S.modeFields('paid')),{signup:'on',payments:'paid'});
 assert.deepEqual(S.changedFields(v,{supportEmail:'hello@matbravo.com'}),{},'the same help address');
 assert.deepEqual(S.changedFields(v,{organizers:'paused',trustRequired:false}),{organizers:'paused'});
 assert.deepEqual(S.saveBody(v,{signup:'on'}),{version:3,signup:'on'});
 assert.deepEqual(S.saveBody({},{signup:'on'}),{version:0,signup:'on'});
 assert.equal(S.stopsPayments(VIEW({payments:'paid'}),{payments:'free'}),true);assert.equal(S.stopsPayments(v,{payments:'paid'}),false);
 assert.equal(S.modeName('free'),'Otwarta, bezpłatna');english(()=>assert.equal(S.modeName('paid'),'Open, paid'));
});

test('the paid option is disabled with the reason while Stripe is not configured; a stored paid mode stays selectable',()=>{
 const off=S.pageView(VIEW({stripe:{enabled:false,mode:'test',check:null}})).html;
 assert.match(off,/value="paid" disabled aria-describedby="set-paid-why"/);assert.match(off,/id="set-paid-why"[^>]*>Płatności nie są skonfigurowane w config\.php/);
 assert.match(off,/name="payments" value="paid" disabled/,'the payments switch of existing accounts is disabled too');
 assert.match(off,/data-set-act="stripe-check" disabled/);
 const on=S.pageView(VIEW()).html;
 assert.match(on,/value="paid">/);assert.ok(!/value="paid" disabled/.test(on));assert.ok(!/set-paid-why/.test(on));
 assert.equal(S.paidAvailable(VIEW()).ok,true);assert.equal(S.paidAvailable(VIEW({stripe:{enabled:false}})).ok,false);
 const degraded=S.pageView(VIEW({signup:'on',payments:'paid',mode:'paid',stripe:{enabled:false,mode:'test',check:null},effective:{mode:'off',degraded:'billing-missing'}})).html;
 assert.match(degraded,/value="paid" checked>/,'the stored mode stays checked');assert.match(degraded,/class="set-alert" role="alert"/);assert.match(degraded,/Obowiązuje teraz: Wyłączona/);
 assert.match(S.pageView(VIEW({signup:'on',mode:'free',effective:{mode:'off',degraded:'force-off'}})).html,/signup_force_off/);
 // The switch of existing accounts is visible with the mode off only.
 assert.match(on,/data-set-payments>/);assert.match(S.pageView(VIEW({signup:'on',mode:'free'})).html,/data-set-payments hidden>/);
});

test('the decision dialog shows both group counts and sends keep or requireFrom; test mode asks for a confirmation first',async()=>{
 const html=S.decisionView({a:4,b:7}).html;
 assert.match(html,/Grupa A: 4/);assert.match(html,/Grupa B: 7/);assert.match(html,/value="keep" checked/);assert.match(html,/value="requireFrom"/);
 assert.match(html,new RegExp('min="'+dayAdd(warsawToday(),14)+'"'));
 const today='2026-11-01';
 assert.deepEqual(S.decisionBody('keep','',today),{ok:true,freePeriod:{action:'keep'}});
 assert.deepEqual(S.decisionBody('requireFrom','2026-11-15',today),{ok:true,freePeriod:{action:'requireFrom',date:'2026-11-15'}});
 assert.equal(S.decisionBody('requireFrom','2026-11-14',today).ok,false,'less than 14 days');assert.match(S.decisionBody('requireFrom','2026-11-14',today).error,/14 dni/);
 assert.equal(S.decisionBody('requireFrom','jutro',today).ok,false);assert.equal(S.decisionBody('',today).ok,false);
 // The flow against a server stub: Stripe in test mode, then the decision, then the save.
 const sent=[],answers=[conflict('test_mode'),conflict('free_period_decision',{counts:{a:4,b:7}}),VIEW({signup:'on',payments:'paid',mode:'paid',version:4})];
 const io=S.io,before={...io};io.request=async(route,options)=>{sent.push([route,options]);const a=answers.shift();if(a instanceof Error)throw a;return a;};
 try{
  const fields=S.changedFields(VIEW(),S.modeFields('paid'));
  const r1=await S.attempt(VIEW(),fields);assert.deepEqual([r1.ok,r1.kind],[false,'test_mode']);
  const r2=await S.attempt(VIEW(),fields,{confirmTestMode:true});assert.deepEqual([r2.ok,r2.kind,r2.counts],[false,'decision',{a:4,b:7}]);
  const r3=await S.attempt(VIEW(),fields,{confirmTestMode:true,freePeriod:S.decisionBody('requireFrom','2026-12-01',today).freePeriod});assert.equal(r3.ok,true);assert.equal(r3.view.version,4);
  assert.deepEqual(sent.map(([route,o])=>[route,o.method]),[['admin-settings-save','POST'],['admin-settings-save','POST'],['admin-settings-save','POST']]);
  assert.deepEqual(sent[0][1].body,{version:3,signup:'on',payments:'paid'},'no confirmation before it is given');
  assert.deepEqual(sent[1][1].body,{version:3,signup:'on',payments:'paid',confirmTestMode:true});
  assert.deepEqual(sent[2][1].body,{version:3,signup:'on',payments:'paid',confirmTestMode:true,freePeriod:{action:'requireFrom',date:'2026-12-01'}});
  answers.push(conflict('stale'),conflict('stripe_not_ready'),Object.assign(new Error('Brak uprawnień.'),{status:403}));
  assert.equal((await S.attempt(VIEW(),{signup:'on'})).kind,'stale');assert.equal((await S.attempt(VIEW(),{signup:'on'})).kind,'stripe');
  await assert.rejects(S.attempt(VIEW(),{signup:'on'}),/Brak uprawnień/,'403 is not a dialog');
 }finally{Object.assign(io,before);}
 assert.deepEqual(S.bulkBody('2027-01-01'),{action:'requireFrom',scope:'free-signup',date:'2027-01-01'});
 assert.deepEqual(S.outcome(conflict('free_period_decision',{counts:{a:'x',b:-2}})).counts,{a:0,b:0},'counts are numbers');
});

test('organizers: the switch "require confirmation of organizers" with its effect; the queue link only while it is on',()=>{
 const off=S.pageView(VIEW()).html;
 assert.match(off,/name="trustRequired" value="1">/,'off by default (§17)');assert.match(off,/Wymagaj potwierdzenia organizatorów/);
 assert.match(off,/nie ma ich na stronie głównej ani w lobby czatu/);assert.match(off,/każdy organizator bez blokady działa jak potwierdzony/);
 assert.ok(!/data-set-act="pending"/.test(off),'no queue link while confirmation is off');assert.match(off,/kolejka „Do potwierdzenia” nie jest potrzebna/);
 const on=S.pageView(VIEW({trustRequired:true,organizersPending:5})).html;
 assert.match(on,/name="trustRequired" value="1" checked>/);assert.match(on,/Do potwierdzenia: 5/);assert.match(on,/data-set-act="pending"/);
 assert.match(S.pageView(VIEW({organizers:'paused'})).html,/wstrzymanie publikowania nikogo nie zatrzyma/,'pause without confirmation stops nobody: the panel says so');
 assert.ok(!/nikogo nie zatrzyma/.test(S.pageView(VIEW({organizers:'paused',trustRequired:true})).html));
 assert.match(off,/Opublikowane nadchodzące turnieje organizatora<\/dt><dd>10/,'limits are read only');
 assert.deepEqual(S.changedFields(VIEW(),{organizers:'on',trustRequired:true}),{trustRequired:true});
 english(()=>assert.match(S.pageView(VIEW()).html,/Require confirmation of organisers/));
});

test('history: actor labels translated, server codes as words, every value escaped',()=>{
 const items=[{at:1793500000,actor:'Konto usunięte',action:'settings.save',note:'signup=on payments=paid organizers=on trustRequired=1 requireFrom:2026-12-01 a=2 b=3 test'},
  {at:1793400000,actor:'system',action:'tournament.hide',note:'hidden t1 · Puchar <b>'},{at:1793300000,actor:HOSTILE,action:'club.merge',note:'c1 → c2 · '+HOSTILE},
  {at:1793200000,actor:'Edytor',action:'organizer.trust',note:null},{at:1793100000,actor:'self',action:'unknown.code',note:'x'}];
 const html=S.historyView(items).html;
 assert.ok(!html.includes('<img')&&!html.includes('<b>'),html);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(html,/rejestracja otwarta · płatności wymagane · publikowanie włączone · potwierdzanie organizatorów włączone · płatność od .*2026 · grupa A: 2 · grupa B: 3 · Stripe w trybie testowym/);
 assert.match(html,/Ukryto: Puchar &lt;b&gt;/);assert.match(html,/Potwierdzenie organizatora/);assert.match(html,/unknown\.code/);
 english(()=>{
  assert.equal(S.actorLabel('Konto usunięte'),'Deleted account');assert.equal(S.actorLabel('Edytor'),'Editor');assert.equal(S.actorLabel('Członek'),'Member');
  assert.equal(S.actorLabel('system'),'System');assert.equal(S.actorLabel('Marta K.'),'Marta K.','a display name stays as it is');
  assert.equal(S.noteText('settings.save','signup=off payments=free'),'sign-up off · payments off');
 });
 assert.equal(S.noteText('profile.forget','p1 anonymized'),'Dane zanonimizowane');assert.equal(S.noteText('club.adopt','c9 · KS Orzeł · profiles=3'),'KS Orzeł · zawodnicy: 3');
 assert.equal(S.noteText('settings.support','a@b.pl -> c@d.pl'),'a@b.pl -> c@d.pl');
 assert.match(S.historyView([]).html,/Brak zmian/);
 const page=S.pageView(VIEW({support:{email:'"><img src=x>',source:'db'},stripe:{enabled:true,mode:'live',check:{at:1793500000,ok:false,mode:'live',prices:{pln:true,usd:false},error:'price_missing'}},updatedAt:1793500000,updatedBy:'Konto usunięte'})).html;
 assert.ok(!page.includes('<img'));assert.match(page,/PLN: jest · USD: brak/);assert.match(page,/brakuje ceny planu/);assert.match(page,/ustawiony w panelu/);
});

test('clubs: filters, profile counts and creator type; pending names grouped by the club key',()=>{
 const ws={user:{id:'a',role:'admin'},users:[{id:'a',role:'admin'},{id:'e',role:'editor'}],
  clubs:[{id:'unaffiliated',name:'Niezrzeszony',verified:true},{id:'c1',name:'AZS Kraków',verified:true,createdBy:'e'},{id:'c2',name:'KS Tygrys',verified:false,createdBy:'m1',mergedInto:null},{id:'c3',name:'Tygrys KS',verified:false,createdBy:'m2',mergedInto:'c1'},{id:'c4',name:'Old Club',verified:true}],
  profiles:[{id:'p1',clubId:'c1'},{id:'p2',clubId:'c1'},{id:'p3',clubId:'c2'},{id:'p4',clubId:'unaffiliated',pendingClubName:'UKS Smok'},{id:'p5',clubId:'unaffiliated',pendingClubName:' uks  smok '},{id:'p6',clubId:'unaffiliated',pendingClubName:'Klub B'}],tournaments:[]};
 assert.deepEqual(C.clubRows(ws,{filter:'unverified'}).map(r=>[r.club.id,r.profiles,r.creator]),[['c2',1,'member']]);
 assert.deepEqual(C.clubRows(ws,{filter:'all'}).map(r=>[r.club.id,r.state,r.creator]),[['c1','verified','staff'],['c2','unverified','member'],['c4','verified','unknown']],'"Niezrzeszony" never listed; merged in its own filter');
 assert.deepEqual(C.clubRows(ws,{filter:'merged'}).map(r=>[r.club.id,r.into]),[['c3','AZS Kraków']]);
 assert.deepEqual(C.clubRows(ws,{filter:'all',q:'tygrys'}).map(r=>r.club.id),['c2']);
 assert.deepEqual(C.mergeTargets(ws,'c2').map(c=>c.id),['unaffiliated','c1','c4'],'"Niezrzeszony" first, never itself or a merged club');
 const pending=C.pendingNames(ws);
 assert.deepEqual(pending.map(g=>[g.name,g.profileIds]),[['UKS Smok',['p4','p5']],['Klub B',['p6']]]);
 assert.deepEqual(C.adoptBody(pending[0]),{name:'UKS Smok',profileIds:['p4','p5']});
 const page=C.pageView(ws,{filter:'unverified',q:''}).html;
 assert.match(page,/data-clb-act="verify"/);assert.match(page,/Oczekujące nazwy klubów/);assert.match(page,/data-clb-act="adopt"/);assert.match(page,/bieżącą nazwę klubu/);
 const row=C.clubRow({club:{id:'x"1',name:HOSTILE},state:'unverified',profiles:0,creator:'member',into:''}).html;
 assert.ok(!row.includes('<img'));assert.match(row,/data-clb-id="x&quot;1"/);
 assert.ok(!/data-clb-act="(?:rename|merge|verify)"/.test(C.clubRow({club:{id:'m',name:'M'},state:'merged',profiles:0,creator:'unknown',into:'X'}).html),'a merged club has no actions');
});

test('tournament card tools: hide (community), restore, show and confirm the organizer only while confirmation is required',()=>{
 const admin={role:'admin'};
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:true,createdBy:'m'},admin),['hide','owner'],'trustRequired off: every organizer counts as confirmed');
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:false,createdBy:'m'},admin),['hide','owner','trust']);
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:false,hidden:true,createdBy:'m'},admin),['restore','owner','trust']);
 // Integration QA (F3): a blocked organizer (sparse organizerBlocked:true) cannot be confirmed from the card; absent means unknown.
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:false,createdBy:'m',organizerBlocked:true},admin),['hide','owner']);
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:false,hidden:true,createdBy:'m',organizerBlocked:true},admin),['restore','owner']);
 assert.deepEqual(C.toolsFor({id:'t',community:true,trusted:false,createdBy:'m',organizerBlocked:false},admin),['hide','owner','trust']);
 assert.deepEqual(C.toolsFor({id:'t',community:false},admin),[]);assert.deepEqual(C.toolsFor({id:'t',community:false,hidden:true},admin),['restore']);
 assert.deepEqual(C.toolsFor({id:'t',community:true},{role:'editor'}),[]);
 assert.deepEqual(C.hideBody('t1',{reason:'  Fałszywy   turniej ',withdrawSelf:true}),{ok:true,payload:{tournamentId:'t1',hidden:true,reason:'Fałszywy turniej',withdrawSelf:true}});
 assert.deepEqual(C.hideBody('t1',{hidden:false}),{ok:true,payload:{tournamentId:'t1',hidden:false}});
 assert.equal(C.hideBody('t1',{reason:'x'.repeat(201)}).ok,false);assert.equal(C.hideBody('t1',{reason:'ż'.repeat(200)}).ok,true,'characters, not bytes');
 assert.deepEqual(C.trustBody('m1'),{action:'organizer-trust',userId:'m1',trusted:true});
 const t={id:'t"1',name:HOSTILE,community:true,trusted:false,hidden:true,hideReason:HOSTILE,createdBy:'m',entries:[{self:true},{self:false},{self:true}]};
 const tools=C.toolsView(t,admin).html;assert.ok(!tools.includes('<img'));assert.match(tools,/Powód ukrycia: &lt;img/);assert.match(tools,/data-clb-act="t-restore"/);
 const dialog=C.hideView(t).html;assert.ok(!dialog.includes('<img'));assert.match(dialog,/Wycofaj też zgłoszenia samych zawodników \(2\)/);assert.match(dialog,/name="withdrawSelf" checked/);
 assert.equal(C.toolsView(t,{role:'club'}).html,'');
});

test('a refused resend from a dialog: stale closes the dialog and reloads; stripe and error keep the dialog able to try again',async()=>{
 assert.deepEqual(S.refusalPlan('stale',{dialog:true}),{close:true,reload:true,keep:false});
 assert.deepEqual(S.refusalPlan('stripe',{dialog:true}),{close:false,reload:false,keep:true});
 assert.deepEqual(S.refusalPlan('error',{dialog:false}),{close:false,reload:false,keep:false},'a page form keeps nothing pending');
 const log=[],box={textContent:''};let open=false,meRefreshed=0;const replies=[];
 registry.provide('ui',{modal:title=>{open=true;log.push('modal:'+title);},closeModal:()=>{open=false;log.push('close');},toast:m=>log.push('toast:'+m)});
 globalThis.document={querySelector:sel=>sel==='#modal-root .modal'?(open?{}:null):sel==='#modal-root .form-error'?(open?box:null):null};
 const io={...S.io};S.io.request=async(route,o)=>{log.push(route);const r=replies.shift();if(r instanceof Error)throw r;return r;};S.io.refreshMe=()=>{meRefreshed++;};
 const el={closest:()=>null};
 try{
  S.state.view=VIEW();
  replies.push(conflict('test_mode'),conflict('stripe_not_ready'),conflict('test_mode'),conflict('stale'),VIEW({version:4}));
  await S.save(el,{signup:'on',payments:'paid'});assert.equal(open,true);assert.deepEqual(S.pendingSave().fields,{signup:'on',payments:'paid'});
  const p=S.pendingSave();await S.save(el,p.fields,{...p.extra,confirmTestMode:true},p.done);
  assert.equal(open,true,'the test-mode dialog stays');assert.equal(box.textContent,'x');assert.ok(S.pendingSave(),'its confirm button can send again');
  assert.deepEqual(S.pendingSave().extra,{confirmTestMode:true});
  // Another Administrator saved meanwhile: the dialog closes and the page reloads the new version.
  box.textContent='';await S.save(el,{signup:'on',payments:'paid'});const q=S.pendingSave();await S.save(el,q.fields,{...q.extra,confirmTestMode:true},q.done);
  assert.equal(open,false);assert.equal(S.pendingSave(),null);assert.equal(S.state.view.version,4);assert.equal(log.at(-1),'toast:x');assert.equal(log.at(-2),'admin-settings');
  assert.equal(meRefreshed,0,'nothing saved, nothing to refresh');
  // A saved change of the organizer confirmation refreshes me (the nav badge of #members); the help address does not.
  replies.push(VIEW({version:5,trustRequired:true}),VIEW({version:6,trustRequired:true,support:{email:'a@b.pl',source:'db'}}));
  await S.save(el,{trustRequired:true});assert.equal(meRefreshed,1);
  await S.save(el,{supportEmail:'a@b.pl'});assert.equal(meRefreshed,1);
  assert.equal(S.touchesPending({organizers:'paused'}),true);assert.equal(S.touchesPending({signup:'on'}),false);assert.equal(S.touchesPending(null),false);
 }finally{Object.assign(S.io,io);delete globalThis.document;S.state.view=null;}
});

test('confirm organizer on a tournament card: a blocked organizer is reported, not confirmed',()=>{
 assert.deepEqual(C.trustOutcome({id:'m',caps:{organizer:true,organizerTrusted:true}}),{ok:true,message:'Organizator potwierdzony.'});
 const blocked=C.trustOutcome({id:'m',caps:{organizer:false,organizerBlocked:true,organizerTrusted:true}});
 assert.equal(blocked.ok,false);assert.match(blocked.message,/rola organizatora tej osoby jest odebrana/);assert.match(blocked.message,/panelu Członkowie/);
 assert.equal(C.trustOutcome(null).ok,true);
 english(()=>assert.match(C.trustOutcome({caps:{organizerBlocked:true}}).message,/organiser role is taken away/));
});

test('the members nav badge counts organizers waiting for confirmation for the Administrator only',()=>{
 assert.equal(boot.pendingOrganizers({user:{role:'admin'},features:{pendingOrganizers:4}}),4);
 assert.equal(boot.pendingOrganizers({user:{role:'admin'},features:{}}),0);
 assert.equal(boot.pendingOrganizers({user:{role:'editor'},features:{pendingOrganizers:4}}),0);
 assert.equal(boot.pendingOrganizers(null),0);assert.equal(boot.pendingOrganizers({user:{role:'admin'},features:{pendingOrganizers:'x'}}),0);
});
