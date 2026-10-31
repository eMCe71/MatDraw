// Members UI (plan §11, §12.13): the "Darmowe konto" switch for a new and an existing staff account, the plan change decided after account.save,
// the require-from date (at least 14 days for the grandfathered bulk action), request bodies without personal data in the URL, plan badges
// and texts rendered as plain text. dist/admin-members.js keeps these rules in plain functions, so no browser is needed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registry,SafeHtml,h} from '../dist/registry.js';
import {setLanguage} from '../dist/i18n.js';
import {apiUrl} from '../dist/client.js';
import '../dist/members-boot.js';
import * as members from '../dist/admin-members.js';
const {validateRequireFrom,planBilling,freeToggle,loadedExemption,planBadge,createBody,profileFields,listBody,listCall,memberCall,billingCall,staffListParams,billingDetailParams,memberRow,resultsView,pageView,secretView,factsView,stripeDashboardUrl,cancelable,hasLiveSubscription,dayAdd,validDate,FILTERS,PAGE_SIZE}=members;

setLanguage('pl',{persist:false});
const TODAY='2026-10-31';
const HOSTILE='<img src=x onerror=alert(1)>';

test('the members page is registered for the Admin only and renders SafeHtml',()=>{
 const page=registry.page('members');
 assert.ok(page&&page.nav==='admin');assert.deepEqual(page.roles,['admin']);
 assert.deepEqual(registry.navItems({role:'admin'}).filter(i=>i.id==='members').map(i=>i.nav),['admin']);
 for(const role of ['editor','club','member'])assert.ok(!registry.navItems({role}).some(i=>i.id==='members'),role);
 assert.equal(registry.allows(page,'admin'),true);assert.equal(registry.allows(page,'club'),false);assert.equal(registry.allows(page,'member'),false);
 registry.provide('ui',{shell:(content,title)=>h`<main><h1>${title}</h1>${content}</main>`});
 const out=page.render(new URLSearchParams());
 assert.ok(out instanceof SafeHtml);assert.match(out.html,/data-members-root/);assert.match(out.html,/Członkowie/);
});

test('switch "Darmowe konto": off for a new account, the reported state for an existing one, hidden for the Admin role',()=>{
 assert.deepEqual(freeToggle({isNew:true,role:'club',exempt:true}),{visible:true,checked:false},'a new account is never pre-checked (requirement 4)');
 assert.deepEqual(freeToggle({isNew:true,role:'editor'}),{visible:true,checked:false});
 assert.deepEqual(freeToggle({isNew:false,role:'club',exempt:true}),{visible:true,checked:true},'an existing free account shows on');
 assert.deepEqual(freeToggle({isNew:false,role:'editor',exempt:false}),{visible:true,checked:false},'an existing paying account shows off');
 assert.equal(freeToggle({isNew:false,role:'admin',exempt:true}).visible,false,'the Admin never pays');
});

test('the exemption shown in the form hides the internal reasons and converts the end date to a Warsaw day',()=>{
 assert.deepEqual(loadedExemption({exemptReason:'grandfathered',exemptUntil:null}),{reason:'',until:''});
 assert.deepEqual(loadedExemption({exemptReason:'staff-default'}),{reason:'',until:''});
 assert.deepEqual(loadedExemption({exemptReason:'Sędzia klubu',exemptUntil:Date.parse('2026-12-31T12:00:00Z')/1000}),{reason:'Sędzia klubu',until:'2026-12-31'});
 assert.deepEqual(loadedExemption(null),{reason:'',until:''});
});

test('require-from date: a real date, at least 14 days ahead for the bulk action, today or later for one account',()=>{
 assert.equal(dayAdd(TODAY,14),'2026-11-14');assert.equal(dayAdd('2026-12-25',10),'2027-01-04');assert.equal(dayAdd('2028-02-28',1),'2028-02-29');
 assert.ok(validDate('2028-02-29')&&!validDate('2027-02-29')&&!validDate('2026-13-01')&&!validDate('31.10.2026')&&!validDate('')&&!validDate(null));
 const bulk=date=>validateRequireFrom(date,{scope:'grandfathered',today:TODAY});
 assert.equal(bulk('2026-11-14').ok,true,'exactly 14 days is allowed');
 assert.equal(bulk('2026-11-13').ok,false);assert.match(bulk('2026-11-13').error,/14 dni/);
 assert.equal(bulk(TODAY).ok,false);assert.equal(bulk('2025-01-01').ok,false);
 assert.equal(bulk('2026-02-30').ok,false,'not a calendar date');assert.match(bulk('2026-02-30').error,/poprawną datę/);
 assert.equal(bulk('').ok,false);assert.equal(bulk(undefined).ok,false);assert.equal(bulk('jutro').ok,false);
 const one=date=>validateRequireFrom(date,{scope:'user',today:TODAY});
 assert.equal(one(TODAY).ok,true,'today is allowed for one account (7 days of grace follow)');assert.equal(one('2026-11-01').ok,true);
 assert.equal(one('2026-10-30').ok,false);assert.match(one('2026-10-30').error,/przeszłości/);
 assert.deepEqual(bulk('2027-01-15'),{ok:true,date:'2027-01-15'});
});

test('the plan change after account.save (plan §3.2): new -> exempt with a reason or require; existing free off -> requireFrom today; unchanged -> nothing',()=>{
 const base={today:TODAY,loaded:{reason:'',until:''}};
 // New account.
 assert.deepEqual(planBilling({...base,isNew:true,wasExempt:false,free:false}),{ok:true,call:{action:'require'}},'new and not free -> require');
 assert.deepEqual(planBilling({...base,isNew:true,wasExempt:false,free:true,reason:'  Sędzia  '}),{ok:true,call:{action:'exempt',reason:'Sędzia'}});
 assert.deepEqual(planBilling({...base,isNew:true,wasExempt:false,free:true,reason:'Trener',until:'2027-01-31'}),{ok:true,call:{action:'exempt',reason:'Trener',until:'2027-01-31'}});
 assert.equal(planBilling({...base,isNew:true,wasExempt:false,free:true,reason:'   '}).ok,false,'a free account needs a reason');
 assert.equal(planBilling({...base,isNew:true,wasExempt:false,free:true,reason:'x',until:'2026-10-31'}).ok,false,'the end of the free period must be in the future');
 assert.equal(planBilling({...base,isNew:true,wasExempt:false,free:true,reason:'x',until:'31.12.2026'}).ok,false);
 // Existing free account.
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:true,free:true}),{ok:true,call:null},'still free, nothing edited');
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:true,free:false}),{ok:true,call:{action:'requireFrom',date:TODAY,scope:'user'}},'off -> requireFrom today (grace protects the match day)');
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:true,free:false,from:'2026-12-01'}),{ok:true,call:{action:'requireFrom',date:'2026-12-01',scope:'user'}});
 assert.equal(planBilling({...base,isNew:false,wasExempt:true,free:false,from:'2026-10-01'}).ok,false,'the date cannot be in the past');
 assert.equal(planBilling({...base,isNew:false,wasExempt:true,free:false,from:'abc'}).ok,false);
 const withReason={today:TODAY,loaded:{reason:'Trener',until:'2027-03-01'}};
 assert.deepEqual(planBilling({...withReason,isNew:false,wasExempt:true,free:true,reason:'Trener',until:'2027-03-01'}),{ok:true,call:null});
 assert.deepEqual(planBilling({...withReason,isNew:false,wasExempt:true,free:true,reason:'Trener',until:'2027-06-01'}).call,{action:'exempt',reason:'Trener',until:'2027-06-01'},'a changed end date is saved');
 assert.deepEqual(planBilling({...withReason,isNew:false,wasExempt:true,free:true,reason:'',until:'2027-06-01'}).call,{action:'exempt',reason:'Trener',until:'2027-06-01'},'an empty reason keeps the current one');
 assert.equal(planBilling({...base,isNew:false,wasExempt:true,free:true,reason:'',until:'2027-06-01'}).ok,false,'an internal reason cannot be reused: a real reason is required');
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:true,free:true,reason:'Zasłużony'}).call,{action:'exempt',reason:'Zasłużony'},'staff-default made explicit');
 // Existing paying account.
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:false,free:false}),{ok:true,call:null},'still paying, nothing to send');
 assert.deepEqual(planBilling({...base,isNew:false,wasExempt:false,free:true,reason:'Dar od klubu'}).call,{action:'exempt',reason:'Dar od klubu'});
 assert.equal(planBilling({...base,isNew:false,wasExempt:false,free:true}).ok,false);
});

test('requests: names, ids and bodies only; e-mails, names and search phrases never reach the URL',()=>{
 const email='marta.k+test@example.org',phrase='marta_k%!';
 const list=listCall({q:phrase,filter:'paid',page:3});
 assert.equal(list.route,'admin-members');assert.equal(list.options.method,'POST');
 assert.deepEqual(list.options.body,{q:phrase,filter:'paid',page:3});
 assert.equal(apiUrl(list.route),'./api/index.php?route=admin-members');
 for(const [spec,name] of [[memberCall('email',{userId:'u1',email}),'admin-member'],[memberCall('create',createBody({email,firstName:'Marta',lastName:'Kowalska',username:'Marta.K',country:'PL',sports:['karate'],reason:'Trener'})),'admin-member']]){
  assert.equal(spec.route,name);assert.equal(spec.options.method,'POST');
  const url=apiUrl(spec.route);assert.ok(!url.includes('marta')&&!url.includes('@')&&!url.includes('example'),url);
  assert.ok(JSON.stringify(spec.options.body).includes('marta')||JSON.stringify(spec.options.body).includes('Marta'),'personal data is in the body');
 }
 assert.deepEqual(staffListParams(),{route:'admin-billing',list:'staff'});
 assert.equal(apiUrl(staffListParams()),'./api/index.php?route=admin-billing&list=staff');
 assert.equal(apiUrl(billingDetailParams('u_7')),'./api/index.php?route=admin-billing&userId=u_7','only an opaque id in the query');
 const bulk=billingCall({action:'requireFrom',date:'2027-01-15',scope:'grandfathered'});
 assert.equal(bulk.route,'admin-billing-action');assert.deepEqual(bulk.options.body,{action:'requireFrom',date:'2027-01-15',scope:'grandfathered'});
 assert.ok(!('amount' in bulk.options.body)&&!('price' in bulk.options.body),'no amounts from the client');
});

test('list body is bounded: phrase trimmed to 100 characters, known filters only, page a positive integer',()=>{
 assert.equal(listBody({q:'  '+'a'.repeat(150)}).q.length,100);
 assert.equal(listBody({q:null}).q,'');assert.equal(listBody({filter:'everything'}).filter,'all');
 for(const [key] of FILTERS)assert.equal(listBody({filter:key}).filter,key);
 assert.equal(listBody({page:0}).page,1);assert.equal(listBody({page:2.5}).page,1);assert.equal(listBody({page:'3'}).page,1);assert.equal(listBody({page:7}).page,7);
 assert.deepEqual(listBody(),{q:'',filter:'all',page:1});assert.equal(PAGE_SIZE,50);
});

test('create body: a free account with a reason, a lower-case username and no password (the server makes a temporary one)',()=>{
 const body=createBody({email:' a@b.pl ',firstName:' Anna ',lastName:'Nowak',username:'Anna.N',country:'DE',sports:['judo','karate'],reason:' Sędzia ',until:''});
 assert.deepEqual(body,{email:'a@b.pl',firstName:'Anna',lastName:'Nowak',username:'anna.n',country:'DE',sports:['judo','karate'],free:true,reason:'Sędzia'});
 assert.ok(!('password' in body));
 assert.equal(createBody({sports:'judo'}).sports.length,0);
 assert.equal(createBody({email:'a@b.pl',until:'2027-01-01'}).until,'2027-01-01');
});

test('profile fix sends only what changed; empty names stay as they are; username can be dropped',()=>{
 const item={username:'marta.k',country:'PL'};
 assert.deepEqual(profileFields({firstName:'',lastName:'  ',username:'marta.k',country:'PL'},item),{});
 assert.deepEqual(profileFields({firstName:'Marta',lastName:'',username:'Marta.K2',country:'DE'},item),{firstName:'Marta',username:'marta.k2',country:'DE'});
 assert.deepEqual(profileFields({username:'x',dropUsername:true,clearClub:true},item),{username:null,clubText:''});
});

test('plan badges: every Access state has a text; staff-default is flagged; dates follow the language',()=>{
 const until=Date.parse('2026-12-31T12:00:00Z')/1000;
 const text=(state,extra={},kind)=>planBadge({state,...extra},kind)?.text;
 assert.equal(text('free',{reason:'staff-default'},'staff'),'Darmowe (domyślnie)');assert.equal(planBadge({state:'free',reason:'staff-default'},'staff').type,'warning');
 assert.equal(text('free'),'Darmowe');assert.match(text('free',{until}),/^Darmowe do .*2026/);
 assert.match(text('grace',{until}),/^Karencja do/);assert.match(text('active',{until}),/^Płatne do/);assert.match(text('ending',{until}),/^Kończy się/);
 assert.equal(text('past_due'),'Problem z płatnością');assert.equal(text('processing'),'Płatność w toku');
 assert.equal(text('none',{},'member'),'Bez planu');assert.equal(text('none',{},'staff'),'Wymaga płatności');assert.equal(text('ended',{},'staff'),'Wymaga płatności');assert.equal(text('ended',{},'member'),'Subskrypcja zakończona');
 assert.equal(text('staff'),'Bez płatności');assert.equal(planBadge({state:'open'}),null);assert.equal(planBadge(null),null);
 setLanguage('en',{persist:false});
 try{assert.equal(text('free',{reason:'staff-default'},'staff'),'Free (default)');assert.match(text('active',{until}),/^Paid until .*2026/);assert.equal(text('past_due'),'Payment problem');}
 finally{setLanguage('pl',{persist:false});}
});

test('texts from the API are plain text: e-mails, names, usernames, reasons and sync errors cannot inject markup',()=>{
 const member={id:'u"1',email:HOSTILE,username:'"><script>x</script>',name:HOSTILE,country:'PL',createdAt:1790000000,lastLoginAt:null,active:false,billing:{state:'free',until:null,exempt:true,reason:HOSTILE},muted:true,mutedUntil:1900000000};
 const row=memberRow(member).html;
 assert.ok(!row.includes('<img')&&!row.includes('<script'),row);
 assert.ok(row.includes('&lt;img src=x onerror=alert(1)&gt;'));assert.ok(row.includes('data-mem-id="u&quot;1"'),'ids in attributes are escaped');
 assert.match(row,/Zablokowane/);assert.match(row,/data-page="moderation"/,'a muted member links to moderation');
 const list=resultsView({data:{items:[member],total:120,page:2}}).html;
 assert.ok(!list.includes('<img')&&/Strona 2 z 3/.test(list)&&/Znaleziono: 120/.test(list));
 assert.ok(!resultsView({error:HOSTILE}).html.includes('<img'));
 assert.ok(!pageView({q:'"><img src=x onerror=1>',filter:'all',page:1,data:null,error:''}).html.includes('<img'),'the remembered search phrase is escaped in the input');
 const secret=secretView({email:HOSTILE,password:'Abc<def>123'}).html;
 assert.ok(!secret.includes('<img')&&!secret.includes('<def>'));assert.ok(secret.includes('Abc&lt;def&gt;123'));
 const facts=factsView({state:'active',until:1900000000,subStatus:'active',periodEnd:1900000000,cancelAtPeriodEnd:false,currency:'pln',lastSyncedAt:1790000000,syncError:HOSTILE,mode:'test'}).html;
 assert.ok(!facts.includes('<img'));assert.match(facts,/PLN/);
 assert.ok(!memberRow({...member,muted:false,name:'',username:null,billing:null}).html.includes('undefined'),'missing fields do not print undefined');
});

test('empty and error states of the list',()=>{
 assert.match(resultsView({data:null,error:''}).html,/Wczytuję członków/);
 assert.match(resultsView({data:{items:[],total:0,page:1},error:''}).html,/Brak członków spełniających kryteria/);
 assert.match(resultsView({data:null,error:'Brak uprawnień.'}).html,/Brak uprawnień/);
 const one=resultsView({data:{items:[{id:'a',email:'a@b.pl',active:true,billing:{state:'none'}}],total:1,page:1}}).html;
 assert.ok(!/mem-pager/.test(one),'no pager for a single page');
});

test('the temporary password is shown with the reply address and a copy button, and states that it is shown once',()=>{
 const html=secretView({email:'a@b.pl',password:'Tmp-Passw0rd-1234',created:false}).html;
 assert.ok(html.includes('Tmp-Passw0rd-1234')&&html.includes('a@b.pl'));assert.match(html,/data-mem-act="copy"/);assert.match(html,/data-mem-copy="Tmp-Passw0rd-1234"/);
 assert.match(html,/tylko teraz/);assert.match(html,/nagłówka wiadomości/,'the §3.10 advice: reply to the panel address, not the From header');
 assert.match(secretView({email:'a@b.pl',password:'x',created:true}).html,/Konto zostało utworzone/);
});

test('sign-out (also an expired session) drops the member list, the search phrase and the staff plans from memory',()=>{
 Object.assign(members.state,{q:'marta@example.org',data:{items:[{id:'u1',email:'marta@example.org'}],total:1,page:1},staff:{u2:{state:'free'}}});
 registry.emit('logout',{expired:true});
 assert.equal(members.state.data,null);assert.equal(members.state.q,'');assert.equal(members.state.staff,null);assert.deepEqual([members.state.filter,members.state.page],['all',1]);
});

test('Stripe links: only the dashboard origin; subscription stop only for an ongoing, not yet ending subscription',()=>{
 assert.equal(stripeDashboardUrl('https://dashboard.stripe.com/test/customers/cus_ABC123'),'https://dashboard.stripe.com/test/customers/cus_ABC123');
 assert.equal(stripeDashboardUrl('https://dashboard.stripe.com/customers/cus_ABC123'),'https://dashboard.stripe.com/customers/cus_ABC123');
 for(const bad of ['https://evil.example/customers/cus_1','http://dashboard.stripe.com/customers/cus_1','javascript:alert(1)','https://dashboard.stripe.com.evil.example/customers/cus_1','https://dashboard.stripe.com/customers/cus_1?x=1',null,undefined,''])assert.equal(stripeDashboardUrl(bad),null,String(bad));
 assert.equal(cancelable({subStatus:'active',cancelAtPeriodEnd:false,subscriptionId:'sub_1'}),true);
 assert.equal(cancelable({subStatus:'active',cancelAtPeriodEnd:true,subscriptionId:'sub_1'}),false);
 assert.equal(cancelable({subStatus:'canceled',cancelAtPeriodEnd:false,subscriptionId:'sub_1'}),false);
 assert.equal(cancelable({subStatus:'active',cancelAtPeriodEnd:false,subscriptionId:null}),false);assert.equal(cancelable(null),false);
 assert.equal(hasLiveSubscription({state:'active'}),true);assert.equal(hasLiveSubscription({state:'past_due'}),true);assert.equal(hasLiveSubscription({state:'ending'}),false);assert.equal(hasLiveSubscription({state:'free'}),false);assert.equal(hasLiveSubscription(null),false);
});
