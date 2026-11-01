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
import {warsawToday} from '../dist/guest-view.js';
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
 // Payments off or not enforced (final review F4): a staff account that would need a plan works with full access, so no warning.
 for(const state of ['none','ended','grace'])assert.deepEqual(planBadge({state,until},'staff',{enforced:false}),{text:'Pełny dostęp (płatności wyłączone)',type:'neutral'},state);
 assert.equal(planBadge({state:'none'},'member',{enforced:false}).text,'Bez planu','members keep their plan state');
 assert.equal(planBadge({state:'active',until},'staff',{enforced:false}).type,'success');
 assert.equal(members.paymentsEnforced({billing:false}),false);assert.equal(members.paymentsEnforced({billing:true}),true);assert.equal(members.paymentsEnforced(null),true,'unknown counts as on');
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

// ---- Review round 1: member plan dialog, validation before the commit, paging, country, blocking, currency, bulk count ----
test('the reason is required whenever a plan change would need it, so the browser refuses the form before the account is saved',()=>{
 const {reasonRequired}=members,loaded={reason:'',until:''};
 assert.equal(reasonRequired({free:true,isNew:true,wasExempt:false,loaded,until:''}),true,'new free account');
 assert.equal(reasonRequired({free:true,isNew:false,wasExempt:false,loaded,until:''}),true,'a paying account made free');
 assert.equal(reasonRequired({free:false,isNew:false,wasExempt:true,loaded,until:''}),false,'switch off needs a date, not a reason');
 assert.equal(reasonRequired({free:true,isNew:false,wasExempt:true,loaded,until:''}),false,'grandfathered, nothing edited');
 assert.equal(reasonRequired({free:true,isNew:false,wasExempt:true,loaded,until:'2027-05-01'}),true,'grandfathered, end date edited: the internal reason cannot be reused');
 assert.equal(reasonRequired({free:true,isNew:false,wasExempt:true,loaded:{reason:'Trener',until:'2027-03-01'},until:'2027-05-01'}),false,'a real reason is kept');
 assert.equal(reasonRequired({free:true,isNew:false,wasExempt:true,loaded:{reason:'',until:'2027-03-01'},until:''}),true,'clearing the date of a staff-default account');
});

test('currency override: sent only when it changes and no subscription runs; "" gives back the country rule',()=>{
 const {currencyChange}=members,d=(o={})=>({subStatus:'none',currencyOverride:null,...o});
 assert.deepEqual(currencyChange(d(),'usd'),{action:'currency',currency:'usd'});
 assert.deepEqual(currencyChange(d({currencyOverride:'usd'}),''),{action:'currency',currency:null});
 assert.equal(currencyChange(d({currencyOverride:'usd'}),'usd'),null);assert.equal(currencyChange(d(),''),null);
 assert.equal(currencyChange(d({currencyOverride:'usd'}),'eur').currency,null,'an unknown value never goes to the server as a currency');
 for(const subStatus of ['active','trialing','past_due','incomplete'])assert.equal(currencyChange(d({subStatus}),'usd'),null,subStatus);
 assert.equal(currencyChange(null,'usd'),null);assert.equal(currencyChange(d(),null),null,'select disabled: nothing to send');
});

test('a page past the end is clamped to the last page; the bulk summary counts what the server changes',()=>{
 const {clampPage,grandfathered}=members;
 assert.equal(clampPage({items:[],total:50},2),1,'51 members, the only one of page 2 deleted');
 assert.equal(clampPage({items:[],total:120},9),3);
 assert.equal(clampPage({items:[{id:'a'}],total:51},2),null);assert.equal(clampPage({items:[],total:0},3),null,'an empty list is just empty');
 assert.equal(clampPage({items:[],total:10},1),null);assert.equal(clampPage(null,2),null);
 assert.equal(grandfathered({a:{reason:'grandfathered',exempt:true},b:{reason:'grandfathered',exempt:false},c:{reason:'staff-default',exempt:true},d:{reason:'Sędzia',exempt:true},e:null}),2,
  'the server updates every grandfathered row, also one whose end date has passed (exempt false in the list)');
 assert.equal(grandfathered(null),0);
});

test('a member row offers the Plan dialog; the dialog facts use the member wording',()=>{
 const row=memberRow({id:'u1',email:'a@b.pl',active:true,billing:{state:'none'}}).html;
 assert.match(row,/data-mem-act="plan"[^>]*data-mem-id="u1"|data-mem-id="u1"[^>]*data-mem-act="plan"/);assert.match(row,/>Plan</);
 assert.match(factsView({role:'member',state:'none',subStatus:'none'}).html,/Bez planu/);
 assert.match(factsView({role:'club',state:'none',subStatus:'none'}).html,/Wymaga płatności/);
});

test('the profile-fix country select starts empty for a member without a country, so a save never sets one nobody chose',()=>{
 const {countryOptions}=members,text=list=>list.map(o=>o.html).join('');
 const none=text(countryOptions(null,true));assert.match(none,/^<option value="" selected>—<\/option>/);assert.ok(!/ selected>(?!—)/.test(none),'no country is preselected');
 const pl=text(countryOptions('PL',true));assert.match(pl,/^<option value="">—<\/option>/);assert.match(pl,/<option value="PL" selected>/);
 assert.ok(!text(countryOptions('PL')).includes('value=""'),'the create dialog keeps its default without a blank');
 assert.deepEqual(profileFields({firstName:'',lastName:'',username:'',country:'',clearClub:true},{country:null}),{clubText:''},'an empty choice sends no country');
});

// DOM glue without a browser: fake elements answer the selectors the module uses; the transport is replaced (io), so nothing leaves the process.
function fakeForm({id='',role='club',active='yes',memRole}={}){
 const el=(extra={})=>({value:'',checked:false,disabled:false,required:false,hidden:false,querySelectorAll:()=>[],...extra});
 const n={free:el(),reason:el(),until:el(),from:el({value:warsawToday()}),stop:el(),blockStop:el({checked:true}),currency:el({value:''}),on:el(),off:el(),stopRow:el(),blockRow:el(),fieldset:el(),facts:el(),acts:el()};
 const roleNode=el({value:role}),activeNode=el({value:active}),errorBox=el({textContent:''});
 const by={'[data-mem-bill]':n.fieldset,'[data-mem-free]':n.free,'[name="mem-free"]':n.free,'[data-mem-on]':n.on,'[data-mem-off]':n.off,'[name=mem-reason]':n.reason,'[name="mem-reason"]':n.reason,
  '[name=mem-until]':n.until,'[name="mem-until"]':n.until,'[name=mem-from]':n.from,'[name="mem-from"]':n.from,'[data-mem-stop-row]':n.stopRow,'[name="mem-stop"]':n.stop,'[data-mem-block-row]':n.blockRow,
  '[name="mem-block-stop"]':n.blockStop,'[name="mem-currency"]':n.currency,'[data-mem-facts]':n.facts,'[data-mem-bill-actions]':n.acts};
 const mount={isConnected:true,innerHTML:'',dataset:{accountBilling:id,...(memRole?{memRole}:{})},closest:()=>form,querySelector:s=>by[s]??null};
 const form={dataset:{memId:id},closest:()=>form,querySelector:s=>s==='[name=role]'?(memRole?null:roleNode):s==='[name=active]'?activeNode:s==='[data-account-billing]'?mount:s==='.form-error'?errorBox:null};
 return {mount,form,n,activeNode,errorBox};
}

/** Mounts the plan fields and copies the initial control states from the HTML the module rendered (a real browser would do it). */
async function mounted(f){
 await members.mountAccountBilling(f.mount);
 const tag=name=>f.mount.innerHTML.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))?.[0]||'',val=name=>(tag(name).match(/ value="([^"]*)"/)||[])[1]||'';
 f.n.free.checked=/ checked/.test(tag('mem-free'));f.n.reason.value=val('mem-reason');f.n.until.value=val('mem-until');members.syncBilling(f.mount);return f;
}
/** Runs fn with io.request recording every call; respond(route,body,params) gives the answer (default {ok:true}). Toasts are collected. */
async function withServer(respond,fn){
 const calls=[],toasts=[],oldRequest=members.io.request,oldDemo=members.io.demo,hadDocument='document' in globalThis;
 members.io.demo=false;
 members.io.request=async(route,options)=>{const params=typeof route==='string'?{route}:route,body=options?.body;calls.push({route:params.route,params,body});return respond(params.route,body,params)??{ok:true};};
 registry.provide('ui',{toast:m=>toasts.push(m),closeModal:()=>toasts.push('(closed)'),modal:(title)=>toasts.push('(modal: '+title+')')});
 if(!hadDocument)globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};
 members.forget();
 try{await fn({calls,toasts});}
 finally{members.io.request=oldRequest;members.io.demo=oldDemo;if(!hadDocument)delete globalThis.document;members.forget();}
}
const actions=calls=>calls.filter(c=>c.route==='admin-billing-action').map(c=>c.body);
const detail=(o={})=>({userId:'u7',role:'club',active:true,state:'free',exempt:true,exemptReason:'grandfathered',exemptUntil:null,currency:null,currencyOverride:null,subStatus:'none',subscriptionId:null,cancelAtPeriodEnd:false,customerId:null,dashboardUrl:null,...o});
const billingRoutes=(account,extra={})=>(route,body)=>route==='admin-billing'?(extra.list?{users:{}}:{account,audit:[]}):route==='admin-billing-action'?{ok:true,account,...(extra[body.action]||{})}:null;

test('glue: a new staff account sends require when the switch is off and exempt with the reason when it is on',async()=>{
 await withServer(billingRoutes(detail()),async({calls})=>{
  const off=fakeForm();await members.mountAccountBilling(off.mount);
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u9'},element:off.form});
  assert.deepEqual(actions(calls),[{action:'require',userId:'u9'}],'new / off');
  assert.equal(off.n.reason.required,false);
  calls.length=0;
  const on=fakeForm();await members.mountAccountBilling(on.mount);
  on.n.free.checked=true;on.n.reason.value='  Sędzia klubu ';on.n.until.value='2027-05-01';members.syncBilling(on.mount);
  assert.equal(on.n.reason.required,true,'a new free account needs its reason before the account is saved');
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u10'},element:on.form});
  assert.deepEqual(actions(calls),[{action:'exempt',reason:'Sędzia klubu',until:'2027-05-01',userId:'u10'}],'new / on');
  calls.length=0;
  const admin=fakeForm({role:'admin'});await members.mountAccountBilling(admin.mount);
  await members.onAccountSaved({payload:{role:'admin'},result:{id:'u11'},element:admin.form});
  assert.deepEqual(calls,[],'the Admin role never pays: nothing is sent');
 });
});

test('glue: an existing free staff account switched off sends requireFrom today; unchanged sends nothing; a grandfathered account whose date changes needs a reason first',async()=>{
 await withServer(billingRoutes(detail()),async({calls,toasts})=>{
  const f=await mounted(fakeForm({id:'u7'}));
  assert.deepEqual(calls.map(c=>[c.route,c.params.userId]),[['admin-billing','u7']],'the detail is read once');
  assert.equal(f.n.free.checked,true,'an existing free account shows the switch on');
  assert.equal(f.n.reason.required,false,'still free and nothing edited: no reason needed');
  calls.length=0;
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u7'},element:f.form});
  assert.deepEqual(calls,[],'existing / unchanged -> nothing');
  f.n.until.value='2027-05-01';members.syncBilling(f.mount);
  assert.equal(f.n.reason.required,true,'changing the date of a grandfathered account requires a reason, checked by the browser before the commit');
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u7'},element:f.form});
  assert.deepEqual(calls,[],'a rejected plan sends nothing');assert.ok(toasts.includes('Podaj powód darmowego konta.'));
  calls.length=0;f.n.free.checked=false;members.syncBilling(f.mount);
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[{action:'requireFrom',date:warsawToday(),scope:'user',userId:'u7'}],'existing free / off');
 });
});

test('glue: blocking a staff account with a live subscription offers (and by default sends) the subscription stop',async()=>{
 const live=detail({exempt:false,exemptReason:null,state:'active',subStatus:'active',subscriptionId:'sub_1'});
 await withServer(billingRoutes(live),async({calls})=>{
  const f=await mounted(fakeForm({id:'u7',active:'no'}));
  assert.equal(f.n.blockRow.hidden,false,'the warning is shown when Status becomes Zablokowane');
  await members.onAccountSaved({payload:{role:'club',active:false},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[{action:'cancelAtPeriodEnd',userId:'u7'}]);
  calls.length=0;f.n.blockStop.checked=false;
  await members.onAccountSaved({payload:{role:'club',active:false},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[],'the Admin left the box unticked');
  f.activeNode.value='yes';members.syncBilling(f.mount);assert.equal(f.n.blockRow.hidden,true,'hidden again for an active account');
  f.n.blockStop.checked=true;
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[],'an active account is never stopped');
 });
 await withServer(billingRoutes(detail()),async({calls})=>{
  const f=await mounted(fakeForm({id:'u7',active:'no'}));
  assert.equal(f.n.blockRow.hidden,true,'no live subscription, no warning');
  await members.onAccountSaved({payload:{role:'club',active:false},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[]);
 });
});

test('glue: saving an already blocked staff account never stops its subscription; blocking while making it free stops it once',async()=>{
 const live=detail({exempt:false,exemptReason:null,state:'active',active:false,subStatus:'active',subscriptionId:'sub_1'});
 await withServer(billingRoutes(live),async({calls})=>{
  const f=await mounted(fakeForm({id:'u7',active:'no'}));
  assert.equal(f.n.blockRow.hidden,true,'already blocked: no warning');
  await members.onAccountSaved({payload:{role:'club',active:false},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[],'a later save (club, e-mail, password) sends no billing action');
 });
 const paying=detail({exempt:false,exemptReason:null,state:'active',subStatus:'active',subscriptionId:'sub_1'});
 await withServer(billingRoutes(paying,{exempt:{warnLive:true}}),async({calls,toasts})=>{
  const f=await mounted(fakeForm({id:'u7',active:'no'}));
  f.n.free.checked=true;f.n.reason.value='Stypendium';members.syncBilling(f.mount);
  await members.onAccountSaved({payload:{role:'club',active:false},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[{action:'exempt',reason:'Stypendium',userId:'u7'},{action:'cancelAtPeriodEnd',userId:'u7'}]);
  assert.ok(!toasts.some(m=>/Trwająca subskrypcja/.test(m)),'the subscription was just stopped: no second offer');
 });
});

test('glue: the member Plan dialog makes a paying member free (warnLive -> stop), changes the currency and reports a missing reason before sending',async()=>{
 const paying=detail({role:'member',exempt:false,exemptReason:null,state:'active',subStatus:'active',subscriptionId:'sub_1'});
 await withServer(billingRoutes(paying,{exempt:{warnLive:true}}),async({calls,toasts})=>{
  const f=await mounted(fakeForm({id:'u7',memRole:'member'}));
  assert.equal(f.n.stopRow.hidden,true);f.n.free.checked=true;members.syncBilling(f.mount);
  assert.equal(f.n.stopRow.hidden,false,'a paying member made free: the stop is offered');assert.equal(f.n.reason.required,true);
  calls.length=0;
  await members.FORMS.plan(f.form);
  assert.equal(f.errorBox.textContent,'Podaj powód darmowego konta.');assert.deepEqual(calls,[],'validated before anything is sent');
  f.n.reason.value='Stypendium';f.n.stop.checked=true;
  await members.FORMS.plan(f.form);
  assert.deepEqual(actions(calls),[{action:'exempt',reason:'Stypendium',userId:'u7'},{action:'cancelAtPeriodEnd',userId:'u7'}]);
  assert.ok(calls.some(c=>c.route==='admin-members'),'the list is reloaded');assert.ok(toasts.includes('Zapisano ustawienia płatności.'));
 });
 await withServer(billingRoutes(detail({role:'member',exempt:true,exemptReason:'Stypendium',exemptUntil:Date.parse('2027-03-01T12:00:00Z')/1000})),async({calls})=>{
  const f=await mounted(fakeForm({id:'u7',memRole:'member'}));
  assert.equal(f.n.until.value,'2027-03-01');f.n.free.checked=true;members.syncBilling(f.mount);
  f.n.until.value='';f.n.currency.value='usd';calls.length=0;
  await members.FORMS.plan(f.form);
  assert.deepEqual(actions(calls),[{action:'exempt',reason:'Stypendium',userId:'u7'},{action:'currency',currency:'usd',userId:'u7'}],'the end date removed and the currency set');
  calls.length=0;f.n.free.checked=false;members.syncBilling(f.mount);f.n.currency.value='';
  await members.FORMS.plan(f.form);
  assert.deepEqual(actions(calls),[{action:'requireFrom',date:warsawToday(),scope:'user',userId:'u7'}],'a free member revoked');
 });
});

test('glue: the currency select is locked while a subscription runs and never sends then',async()=>{
 const live=detail({exempt:false,exemptReason:null,state:'active',subStatus:'active',subscriptionId:'sub_1'});
 await withServer(billingRoutes(live),async({calls})=>{
  const f=await mounted(fakeForm({id:'u7'}));
  f.n.currency.value='usd';calls.length=0;
  await members.onAccountSaved({payload:{role:'club',active:true},result:{id:'u7'},element:f.form});
  assert.deepEqual(actions(calls),[]);assert.match(f.mount.innerHTML,/name="mem-currency"[^>]* disabled/);
 });
});

test('sign-out leaves no billing detail behind: forget() is safe to call while a dialog request is pending',async()=>{
 await withServer(billingRoutes(detail()),async()=>{members.forget();members.forget();});
});

// ---- Roles (PLAN-REJESTRACJA-ROLE §5.5, §10.5): badges, filters, organizer actions, the bulk action and the pending badge ----
test('role filters and the ownerOf filter of a tournament card reach admin-members; the route asks for them once',()=>{
 for(const key of ['organizers','organizers-pending','athletes','free-signup']){assert.ok(FILTERS.some(([k])=>k===key),key);assert.equal(listBody({filter:key}).filter,key);}
 assert.deepEqual(listBody({ownerOf:'t-autumn-2026'}),{q:'',filter:'all',page:1,ownerOf:'t-autumn-2026'});
 assert.deepEqual(listBody({ownerOf:'bad id/'}),{q:'',filter:'all',page:1},'an invalid tournament id is dropped');
 assert.deepEqual(listCall({filter:'organizers-pending'}),{route:'admin-members',options:{method:'POST',body:{q:'',filter:'organizers-pending',page:1}}});
 const route=hash=>members.routeFilter(registry.parseRoute(hash).params);
 assert.deepEqual(route('#members?filter=organizers-pending'),{filter:'organizers-pending',ownerOf:null});
 assert.deepEqual(route('#members?ownerOf=t1'),{filter:'all',ownerOf:'t1'});
 assert.equal(route('#members'),null);assert.equal(route('#members?filter=nope'),null);
 assert.match(pageView({q:'',filter:'organizers-pending',page:1,ownerOf:'t1',data:null,error:''}).html,/Organizator wybranego turnieju/);
 assert.match(pageView({q:'',filter:'all',page:1,data:null,error:''}).html,/<option value="organizers-pending">Organizatorzy do potwierdzenia<\/option>/);
});

test('final review F1, F2: the athlete profile of a member row can be erased; the delete dialog warns and offers the initials only with a profile',async()=>{
 const ws={profiles:[{id:'p1',name:'Zosia <b>K</b>',ownerId:'u1'},{id:'p2',name:'Dane usunięte',ownerId:'u1'},{id:'p3',name:'Inny',ownerId:'u9'},{id:'p4',name:'Bez konta',ownerId:null}]};
 assert.deepEqual(members.ownedProfiles('u1',ws).map(p=>p.id),['p1'],'own profiles only, an erased record does not count');
 assert.deepEqual(members.ownedProfiles('u1',null),[]);
 const row=memberRow({id:'u1',email:'a@b.pl',active:true,billing:null,caps:{athlete:true}},{profiles:members.ownedProfiles('u1',ws)}).html;
 assert.match(row,/<button type="button" class="btn small-btn danger-text" data-action="forget-profile" data-id="p1" aria-label="Usuń dane zawodnika: Zosia &lt;b&gt;K&lt;\/b&gt;">Usuń dane zawodnika<\/button>/);
 assert.ok(!/forget-profile/.test(memberRow({id:'u2',email:'b@b.pl',active:true,billing:null}).html),'no erase button without a profile');
 const note=members.deleteAthleteNote(members.ownedProfiles('u1',ws)).html;
 assert.match(note,/Konto ma profil zawodnika \(Zosia &lt;b&gt;K&lt;\/b&gt;\)\. Zgłoszenia do nadchodzących turniejów zostaną wycofane, a gdy losowanie kategorii jest już zapisane, zostaną w nich tylko inicjały\. Wyniki z turniejów, które już się odbyły, zostaną z imieniem i nazwiskiem, widocznym tylko dla organizatora turnieju i MatBravo \(goście widzą inicjały\)\./);
 assert.match(note,/<input type="checkbox" data-mem-initials checked> Zostaw w zachowanych wynikach tylko inicjały zawodnika/,'ticked by default');
 assert.equal(String(members.deleteAthleteNote([]).html??members.deleteAthleteNote([])),'','nothing without a profile');
 assert.match(members.deleteAthleteNote([{id:'p1',name:'Z'}],{forgotten:true}).html,/Dane zawodnika są już usunięte/);
 // The order: the athlete data (profile.forget through the workspace) before the account deletion; a refusal after it says so.
 const {readFileSync}=await import('node:fs'),src=readFileSync(new URL('../dist/admin-members.js',import.meta.url),'utf8');
 const go=src.slice(src.indexOf("'delete-go':"),src.indexOf("'bulk-go':"));
 assert.ok(go.indexOf("ui().commit('profile.forget',{id:p.id})")>0&&go.indexOf("ui().commit('profile.forget'")<go.indexOf("memberCall('delete'"),'profile.forget first');
 assert.match(go,/if\(forgotten\)\{say\(el,T\('Dane zawodnika są już usunięte, w zachowanych wynikach zostały inicjały\. Konta nie usunięto: \{error\}'/);
 assert.match(go,/initials&&!forgotten/,'never erased twice');
});
test('role badges and organizer actions from the sparse fields caps, trusted and freeSignup',()=>{
 const {roleBadges,organizerActions}=members,texts=m=>roleBadges(m).map(b=>b.text);
 assert.deepEqual(texts({}),[],'a member without roles has no badges');
 assert.deepEqual(texts({caps:{organizer:true}}),['Organizator']);
 assert.deepEqual(texts({caps:{organizer:true,organizerTrusted:true},trusted:true}),['Organizator — potwierdzony']);
 assert.deepEqual(texts({caps:{organizer:false,organizerBlocked:true}}),['Organizator — zablokowany']);
 assert.deepEqual(texts({caps:{athlete:true},freeSignup:true}),['Zawodnik','Konto z okresu bezpłatnego']);
 assert.deepEqual(organizerActions({caps:{organizer:true}}),['trust','block']);assert.deepEqual(organizerActions({caps:{organizer:true},trusted:true}),['untrust','block']);
 assert.deepEqual(organizerActions({caps:{organizerBlocked:true}}),['unblock']);assert.deepEqual(organizerActions({caps:{athlete:true}}),[]);
 const row=memberRow({id:'u1',email:'a@b.pl',active:true,billing:{state:'free'},caps:{organizer:true,athlete:true},tournaments:3,freeSignup:true}).html;
 assert.match(row,/Organizator<\/span>/);assert.match(row,/Zawodnik/);assert.match(row,/Konto z okresu bezpłatnego/);assert.match(row,/Turnieje: 3/);
 assert.match(row,/data-mem-act="org-trust"/);assert.match(row,/data-mem-act="org-block"/);assert.match(row,/data-mem-select="u1"/);assert.ok(!/ checked/.test(row));
 assert.match(memberRow({id:'u1',email:'a@b.pl',active:true,billing:null},{selected:true}).html,/data-mem-select="u1" checked/);
 assert.ok(!/org-/.test(memberRow({id:'u2',email:'b@b.pl',active:true,billing:null}).html),'no organizer actions without the role');
 setLanguage('en',{persist:false});try{assert.deepEqual(texts({caps:{organizer:true,organizerTrusted:true}}),['Organizer — confirmed']);}finally{setLanguage('pl',{persist:false});}
});

test('trust, untrust, block and restore of the organizer role, the account block with hidden tournaments, create with the role',()=>{
 assert.deepEqual(members.trustCall('u1',true),{route:'admin-member',options:{method:'POST',body:{action:'organizer-trust',userId:'u1',trusted:true}}});
 assert.deepEqual(members.trustCall('u1',false).options.body,{action:'organizer-trust',userId:'u1',trusted:false});
 assert.deepEqual(members.organizerCall('u1',{blocked:true,hide:true,reason:'Spam'}).options.body,{action:'organizer',userId:'u1',blocked:true,hideTournaments:true,reason:'Spam'});
 assert.deepEqual(members.organizerCall('u1',{blocked:true}).options.body,{action:'organizer',userId:'u1',blocked:true});
 assert.deepEqual(members.organizerCall('u1',{blocked:false,hide:true}).options.body,{action:'organizer',userId:'u1',blocked:false},'restoring never hides');
 assert.deepEqual(members.blockCall('u1',{hide:true,reason:''}).options.body,{action:'active',userId:'u1',active:false,hideTournaments:true,reason:''});
 assert.deepEqual(members.blockCall('u1').options.body,{action:'active',userId:'u1',active:false});
 assert.deepEqual(members.hideReason('  a   b '),{ok:true,reason:'a b'});assert.equal(members.hideReason('x'.repeat(201)).ok,false);
 assert.equal(createBody({email:'a@b.pl',organizer:true}).organizer,true);assert.ok(!('organizer' in createBody({email:'a@b.pl',organizer:false})));
 // The hide option names the count as all tournaments (past and hidden ones included); only upcoming ones not hidden yet are hidden.
 const hide=members.hideFields({tournaments:5}).html;
 assert.match(hide,/Ukryj też jego nadchodzące turnieje \(wszystkie jego turnieje: 5\)/);assert.match(hide,/data-mem-hide checked/);
 assert.ok(!/checked/.test(members.hideFields({tournaments:2},false).html));assert.equal(members.hideFields({}).html??members.hideFields({}),'','no option without tournaments');
});

test('integration QA (F3): the hide option gives the exact number of upcoming tournaments when the server sends it, none at 0',()=>{
 // upcomingTournaments (sparse): the upcoming tournaments not hidden yet, exactly the ones Members::hideTournaments hides.
 const exact=members.hideFields({tournaments:5,upcomingTournaments:2}).html;
 assert.match(exact,/Ukryj też jego nadchodzące turnieje \(2\)/);assert.ok(!/wszystkie jego turnieje/.test(exact));assert.match(exact,/data-mem-reason/);
 const none=members.hideFields({tournaments:5,upcomingTournaments:0});assert.equal(none.html??none,'','no checkbox when nothing would be hidden');
 assert.match(members.hideFields({tournaments:5,upcomingTournaments:'2'}).html,/wszystkie jego turnieje: 5/,'a malformed count falls back to the total');
 assert.deepEqual([members.hideCount({upcomingTournaments:3}),members.hideCount({tournaments:4}),members.hideCount(null)],[{exact:true,n:3},{exact:false,n:4},{exact:false,n:0}]);
 setLanguage('en',{persist:false});try{assert.match(members.hideFields({upcomingTournaments:1}).html,/Also hide their upcoming tournaments \(1\)/);}finally{setLanguage('pl',{persist:false});}
});

test('bulk action: the payload of the selected rows and the done/failed summary',()=>{
 const {bulkCall,bulkSummary,bulkSummaryView,bulkBar,BULK_MAX}=members;
 assert.equal(BULK_MAX,50);
 assert.deepEqual(bulkCall(['u1','u2','u1',''],{reason:'Fałszywe turnieje',deactivate:true}),{ok:true,call:{route:'admin-member',options:{method:'POST',body:{action:'organizer-bulk',userIds:['u1','u2'],block:true,hideTournaments:true,deactivate:true,reason:'Fałszywe turnieje'}}}});
 assert.equal(bulkCall(['u1']).call.options.body.deactivate,false);
 assert.equal(bulkCall([]).ok,false);assert.match(bulkCall([]).error,/co najmniej jedno/);
 assert.equal(bulkCall(Array.from({length:51},(_,i)=>'u'+i)).ok,false);assert.equal(bulkCall(Array.from({length:50},(_,i)=>'u'+i)).ok,true);
 const items=[{id:'u1',name:'Marta K.',email:'m@b.pl'},{id:'u2',name:'',email:HOSTILE}];
 const s=bulkSummary({done:['u1'],failed:[{id:'u2',error:'Konto nie istnieje.'},{id:'u9',error:'Błąd serwera. Skontaktuj się z Administratorem.'}]},items);
 assert.deepEqual(s,{done:['Marta K.'],failed:[{name:HOSTILE,error:'Konto nie istnieje.'},{name:'u9',error:'Błąd serwera. Skontaktuj się z Administratorem.'}]});
 const html=bulkSummaryView(s).html;assert.ok(!html.includes('<img'));assert.match(html,/Zrobione: 1/);assert.match(html,/Nie udało się: 2/);assert.match(html,/Marta K\./);
 setLanguage('en',{persist:false});try{assert.notEqual(bulkSummary({failed:[{id:'u2',error:'Konto nie istnieje.'}]},items).failed[0].error,'Konto nie istnieje.','server messages are translated');}finally{setLanguage('pl',{persist:false});}
 assert.equal(bulkBar(0).html,'');assert.match(bulkBar(3).html,/Zaznaczono: 3/);assert.match(bulkBar(3).html,/data-mem-act="org-bulk"/);
 const list=resultsView({selected:new Set(['a']),data:{items:[{id:'a',email:'a@b.pl',active:true,billing:null},{id:'b',email:'b@b.pl',active:true,billing:null}],total:2,page:1}}).html;
 assert.match(list,/Zaznaczono: 1/);assert.match(list,/data-mem-select="a" checked/);assert.ok(!/data-mem-select="b" checked/.test(list));
});

test('the pending badge: the members menu item shows organizers waiting for confirmation (me.features.pendingOrganizers)',async()=>{
 globalThis.BroadcastChannel=undefined;// me.js (imported by settings-boot.js) would otherwise keep this process alive
 const {pendingOrganizers}=await import('../dist/settings-boot.js');
 assert.equal(pendingOrganizers({user:{role:'admin'},features:{pendingOrganizers:2}}),2);
 assert.equal(pendingOrganizers({user:{role:'admin'},features:{pendingOrganizers:0}}),0,'0 while the confirmation is not required (§17)');
 assert.equal(pendingOrganizers({user:{role:'member'},features:{pendingOrganizers:2}}),0);
 registry.setBadge('members',pendingOrganizers({user:{role:'admin'},features:{pendingOrganizers:2}}));
 assert.equal(registry.navItems({role:'admin'}).find(i=>i.id==='members').badge,2);
 registry.setBadge('members',0);assert.equal(registry.navItems({role:'admin'}).find(i=>i.id==='members').badge,0);
});
