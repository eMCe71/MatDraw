// The Administrator's permission matrix (panel "Uprawnienia"): backend/src/Permissions.php against dist/permissions.js (constants,
// allows, normalize, types, diff), the rules of Domain.php and dist/workspace.js under a stored matrix (the same statuses and messages
// for the same commands, through tests/php-bridge-roles.php), the guarantees (no stored matrix = the behaviour before the panel; fixed
// cells never change, so the Administrator cannot be limited), the "Moje starty" filter and the pure model of dist/admin-permissions.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {TYPES,PERMS,EDITABLE,FIXED,OFF_BY_DEFAULT,allows,normalize,types,defaults,usePermissions,editable,paid} from '../dist/permissions.js';
import {initialWorkspace,execute,publicWorkspace,canCreateTournament,manages,outsideEntry,managesProfile} from '../dist/workspace.js';
import {projectAthleteView} from '../dist/athlete-view.js';
import {SPORT_IDS} from '../dist/sports.js';
import {draftOf,cellValue,cellOpen,setCell,setOwn,changes,saveBody,permissionsNote} from '../dist/admin-permissions.js';
import {warsawToday} from '../dist/guest-view.js';
import {setLanguage} from '../dist/i18n.js';
setLanguage('pl',{persist:false});

const php=process.env.PHP_BIN;const skip=!php;
const call=(script,input)=>{const r=spawnSync(php,[script],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);};
const perm=input=>call('tests/php-bridge-permissions.php',input);
const roles=input=>call('tests/php-bridge-roles.php',input);
/** PHP encodes an empty map as []: compare maps and empty lists alike. */
const plain=v=>Array.isArray(v)?(v.length?v.map(plain):{}):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)])):v;
const off=(set)=>{const m=defaults();for(const [type,perms] of Object.entries(set))for(const [p,v] of Object.entries(perms))m.global[type][p]=v;return m;};
const day=n=>warsawToday(new Date(Date.now()+n*864e5));

test('PHP and JS share the matrix: account types, permissions and their scope, editable and fixed cells, disciplines',{skip},()=>{
 const c=perm({job:'constants'});
 assert.deepEqual(c.types,TYPES);assert.deepEqual(c.perms,PERMS);assert.deepEqual(c.editable,EDITABLE);assert.deepEqual(c.fixed,FIXED);assert.deepEqual(plain(c.offByDefault),OFF_BY_DEFAULT);assert.deepEqual(c.sports,SPORT_IDS);
 // Every editable cell belongs to a known type and permission; the Administrator and guests have no editable cell (no lock-out).
 for(const [type,perms] of Object.entries(EDITABLE)){assert.ok(TYPES.includes(type));for(const p of perms)assert.ok(PERMS[p],p);}
 assert.ok(!EDITABLE.admin&&!EDITABLE.guest);
});

test('allows: no stored matrix = the behaviour before the panel; fixed cells never change; a discipline without its own set inherits the global one',{skip},()=>{
 const m=off({editor:{'tournament.create':false},organizer:{'chat.write':false}});
 m.sports.karate={editor:{'tournament.create':true,'tournament.manage':false,'entries.submit':true,'chat.write':true},club:{'entries.submit':false,'chat.write':true},
  organizer:{'tournament.create':true,'tournament.manage':true,'entries.submit':true,'chat.write':true},athlete:{'entries.self':false,'chat.write':true},guardian:{'entries.self':true,'chat.write':true},member:{'chat.write':true}};
 // A matrix that tries to switch fixed cells (the Administrator's) changes nothing.
 const hostile={...m,global:{...m.global,admin:{'tournament.manage':false,'admin.manage':false},guest:{'chat.write':true}}};
 const cases=[];for(const type of TYPES)for(const p of Object.keys(PERMS))for(const s of [null,'karate','judo'])cases.push([type,p,s]);
 for(const matrix of [null,m,hostile]){
  const ph=perm({job:'allows',matrix,cases}),js=cases.map(([t,p,s])=>allows(t,p,s,matrix));
  assert.deepEqual(js,ph);
 }
 // Without a matrix every editable cell is on and the fixed ones keep their values: what the code allowed before the panel.
 for(const [t,p] of cases.map(([t,p])=>[t,p]))assert.equal(allows(t,p,null,null),editable(t,p)?!(OFF_BY_DEFAULT[t]||[]).includes(p):(FIXED[t]||[]).includes(p),t+' '+p);
 assert.equal(allows('admin','tournament.manage',null,hostile),true);assert.equal(allows('admin','admin.manage','karate',hostile),true);assert.equal(allows('guest','chat.write',null,hostile),false);
 assert.equal(allows('editor','tournament.create',null,m),false);assert.equal(allows('editor','tournament.create','karate',m),true,'karate has its own set');
 assert.equal(allows('editor','tournament.create','judo',m),false,'judo inherits the global set');
 assert.equal(allows('club','athletes.manage','karate',m),true,'a global permission ignores the discipline');
 assert.equal(allows('athlete','entries.self','karate',m),false);assert.equal(allows('athlete','entries.self','judo',m),true);
});

test('column "Paid account": defaults are the rule before the panel; Access::compute decides by account type, an individual decision wins',{skip},()=>{
 // Defaults: staff free, every kind of member account paying, the Administrator and guests fixed free.
 for(const [type,want] of Object.entries({admin:false,editor:false,club:false,organizer:true,athlete:true,guardian:true,member:true,guest:false}))assert.equal(allows(type,'billing.required',null,null),want,type);
 assert.equal(defaults().global.editor['billing.required'],false);assert.equal(defaults().global.member['billing.required'],true);
 const m=off({editor:{'billing.required':true},organizer:{'billing.required':false},member:{'billing.required':false}});
 const hostile={...m,global:{...m.global,admin:{'billing.required':true}}};
 const lists=[['admin'],['editor'],['club'],['organizer'],['athlete'],['organizer','athlete'],['member'],['guest']];
 for(const matrix of [null,m,hostile])assert.deepEqual(perm({job:'paid',matrix,cases:lists}),lists.map(l=>paid(l,matrix)),'paid() PHP = JS');
 assert.deepEqual(lists.map(l=>paid(l,m)),[false,true,false,false,true,true,false,false]);
 const now=1_800_000_000,cfg={billing_enforce:true,billing_mode:'test',billing_grace_days:7},M={...cfg,permissions:m};
 const pm=off({member:{'billing.required':false}});pm.sports.bjj={};pm.sports.karate={};
 for(const type of Object.keys(EDITABLE))for(const p of EDITABLE[type])if(PERMS[p]==='sport'){(pm.sports.bjj[type]??={})[p]=pm.global[type][p];(pm.sports.karate[type]??={})[p]=pm.global[type][p];}
 pm.sports.bjj.athlete['billing.required']=false;pm.sports.bjj.editor['billing.required']=true;pm.sports.karate.member['billing.required']=true;
 const P={...cfg,permissions:pm};
 const user=(role,typesList)=>({id:'u1',role,...(typesList?{types:typesList}:{})});
 const checkout={billing_exempt:0,exempt_by:null,exempt_until:null,livemode:0,sub_status:'none'};
 const cases=[
  ['no matrix: editor without a row is free',null,user('editor'),cfg,'free'],
  ['no matrix: club without a row is free',null,user('club'),cfg,'free'],
  ['no matrix: a plain member pays',null,user('member',['member']),cfg,'none'],
  ['no matrix: an organizer pays even with types loaded',null,user('member',['organizer']),cfg,'none'],
  ['matrix: editor marked paid needs a subscription',null,user('editor'),M,'none'],
  ['matrix: club keeps its default (free)',null,user('club'),M,'free'],
  ['matrix: plain member marked free',null,user('member',['member']),M,'free'],
  ['matrix: organizer free with a checkout row',checkout,user('member',['organizer']),M,'free'],
  ['matrix: organizer who is also an athlete pays (athlete paid)',null,user('member',['organizer','athlete']),M,'none'],
  ['matrix: kinds not loaded = pays, as before',null,user('member'),M,'none'],
  ['matrix: "Wymagaj płatności" for this person wins',{...checkout,exempt_by:'u_admin'},user('member',['member']),M,'none'],
  ['matrix: a running subscription still shows as active',{...checkout,sub_status:'active',current_period_end:now+86400,cancel_at_period_end:0},user('member',['member']),M,'active'],
  ['matrix: an expired individual exemption is a decision for this person',{...checkout,billing_exempt:1,exempt_by:'u_admin',exempt_until:now-30*86400},user('member',['member']),M,'none'],
  ['matrix: payments off in Ustawienia, nobody pays',null,user('editor'),{...M,billing_enforce:false},'open'],
  ['hostile matrix: the Administrator never pays',null,user('admin'),{...cfg,permissions:hostile},'staff'],
  // Per discipline: athletes pay in general but not in BJJ; plain members are free in general but pay in karate.
  ['per discipline: athlete in BJJ is free',null,user('member',['athlete']),P,'free','bjj'],
  ['per discipline: athlete in karate pays',null,user('member',['athlete']),P,'none','karate'],
  ['per discipline: athlete outside any discipline has partial (full) access',null,user('member',['athlete']),P,'partial'],
  ['per discipline: plain member in karate pays',null,user('member',['member']),P,'none','karate'],
  ['per discipline: plain member in judo (inherits the free global set)',null,user('member',['member']),P,'free','judo'],
  ['per discipline: organizer pays everywhere (no own set frees him)',null,user('member',['organizer']),P,'none'],
  ['per discipline: athlete with a subscription is active in karate',{...checkout,sub_status:'active',current_period_end:now+86400,cancel_at_period_end:0},user('member',['athlete']),P,'active','karate'],
  ['per discipline: editor without a row free in judo, pays in BJJ',null,user('editor'),P,'none','bjj'],
  ['per discipline: editor outside disciplines is partial',null,user('editor'),P,'partial'],
 ];
 const out=perm({job:'access',cases:cases.map(([,row,u,c,,sport])=>({row,user:u,cfg:c,now,sport:sport??null}))});
 cases.forEach(([name,,,,state],i)=>{assert.equal(out[i].state,state,name);assert.equal(out[i].full,!['none','ended','processing'].includes(state),name);});
 assert.deepEqual(perm({job:'varies',cases:[cfg,M,P,{...P,billing_enforce:false}]}),[false,false,true,false]);
});

test('normalize, account types of a member and the history note agree in PHP and JS',{skip},()=>{
 const inputs=[null,'x',[],{},{global:{editor:{'tournament.create':false,'admin.manage':false},admin:{'tournament.create':false},nobody:{x:true}}},
  {global:{},sports:{karate:{organizer:{'chat.write':false,'athletes.manage':false}},atlantis:{editor:{'chat.write':false}}}},{sports:{judo:'x'}}];
 assert.deepEqual(perm({job:'normalize',cases:inputs}).map(plain),inputs.map(normalize).map(plain));
 const n=normalize({global:{editor:{'tournament.create':false,'admin.manage':false}}});
 assert.equal(n.global.editor['tournament.create'],false);assert.equal(n.global.editor['admin.manage'],undefined,'a fixed cell is never stored');assert.equal(n.global.admin,undefined);
 const k=normalize({global:{editor:{'chat.write':false}},sports:{karate:{organizer:{'chat.write':false,'athletes.manage':false}}}});
 assert.equal(k.sports.karate.editor['chat.write'],false,'a missing cell of a discipline set comes from the global set');assert.equal(k.sports.karate.organizer['athletes.manage'],undefined,'only sport-scoped cells');
 const tc=[['admin',false,[]],['editor',true,['self']],['club',false,[]],['member',false,[]],['member',true,[]],['member',false,['guardian']],['member',true,['self','guardian']],['guest',false,[]]];
 assert.deepEqual(perm({job:'types',cases:tc}),tc.map(c=>types(...c)));
 assert.deepEqual(types('member',true,['self','guardian']),['organizer','athlete','guardian']);assert.deepEqual(types('member',false,[]),['member']);
 const a=defaults(),b=setOwn(setCell(draftOf({global:a.global,sports:{}}),'editor','tournament.create','all',false),'karate',true);
 const c=setCell(b,'organizer','chat.write','karate',false);
 const [d]=perm({job:'diff',cases:[[a,c]]});assert.equal(d,'editor.tournament.create=0, karate=own');
 const [d2]=perm({job:'diff',cases:[[b,c]]});assert.equal(d2,'karate organizer.chat.write=0');
 const [d3]=perm({job:'diff',cases:[[c,a]]});assert.equal(d3,'editor.tournament.create=1, karate=inherit');
 assert.equal(permissionsNote('editor.tournament.create=0, karate=own'),'Edytor: Tworzy turnieje wyłączone · Karate: własny zestaw');
 assert.equal(permissionsNote('karate organizer.chat.write=0'),'Karate · Organizator: Pisze na czacie wyłączone');
 assert.equal(permissionsNote('unchanged'),'bez zmian');
});

test('the "Nowy turniej" rule: creation in at least one discipline, PHP and JS alike',{skip},()=>{
 const users=[{id:'a',role:'admin'},{id:'e',role:'editor'},{id:'c',role:'club'},{id:'o',role:'member',organizer:true,organizerBlockedAt:null},{id:'m',role:'member',organizer:false}];
 const none=off({editor:{'tournament.create':false},organizer:{'tournament.create':false}});
 const judo=setCell(setOwn(none,'judo',true),'organizer','tournament.create','judo',true);
 for(const matrix of [null,none,judo]){
  const sports=[null,'judo','karate'],ph=perm({job:'creator',matrix,users,sports});
  usePermissions(matrix);const js=users.flatMap(u=>sports.map(s=>canCreateTournament(u,s)));usePermissions(null);
  assert.deepEqual(js,ph,JSON.stringify(matrix?.sports));
 }
 usePermissions(judo);
 assert.equal(canCreateTournament(users[3]),true,'organizer: judo only');assert.equal(canCreateTournament(users[3],'karate'),false);assert.equal(canCreateTournament(users[1]),false,'editor: nowhere');
 assert.equal(canCreateTournament(users[0],'karate'),true,'the Administrator always');
 usePermissions(null);
});

/** Runs commands through workspace.js and Domain.php under the same flags and compares statuses, messages and the state. */
function both(db,flags,list){
 let jdb=structuredClone({...db,flags});const js=[];
 for(const [actor,type,payload] of list){try{const r=execute(jdb,actor,type,payload);jdb=r.db;js.push({status:200,result:r.result});}catch(e){js.push({status:e.status||500,error:e.message});}}
 usePermissions(null);
 const ph=roles({job:'execute',db,flags,commands:list.map(([actor,type,payload])=>({actor,type,payload}))});
 assert.deepEqual(js.map(r=>[r.status,r.error??null]),ph.results.map(r=>[r.status,r.error??null]),JSON.stringify(list.map(c=>c[1])));
 return js;
}

test('Domain.php and workspace.js apply the matrix the same way: tournaments, athletes, entries and self-entries per discipline',{skip},()=>{
 const db=initialWorkspace(),flags={organizers:'on',trustRequired:false};
 const clubProfile=db.profiles.find(p=>p.ownerId==null&&p.clubId===db.users.find(u=>u.id==='demo-club').clubId).id;
 const T={city:'Łódź',mat:'Mata 1'},A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms'],club:{none:true}};
 const E={events:['forms'],weight:42,height:152,gradeType:'cup',grade:7};
 const list=[
  ['demo-editor','tournament.save',{...T,name:'Turniej TKD',date:day(90),status:'open',sport:'taekwondo'}],     // 0
  ['demo-editor','tournament.save',{...T,name:'Turniej Karate',date:day(90),status:'open',sport:'karate'}],     // 1
  ['demo-organizer','tournament.save',{...T,name:'Turniej Judo',date:day(90),status:'open',sport:'judo'}],      // 2
  ['demo-organizer','tournament.save',{...T,name:'Turniej Boks',date:day(90),status:'open',sport:'boxing'}],    // 3
  ['demo-admin','tournament.save',{...T,name:'Turniej Admina',date:day(90),status:'open',sport:'karate'}],      // 4
  ['demo-editor','tournament.save',{...T,id:'t-karate-2026',name:'Puchar Mazowsza Karate',date:'2026-12-12',status:'open'}], // 5 run (karate)
  ['demo-editor','tournament.save',{...T,id:'t-winter-2027',name:'Puchar Zimy 2027',date:'2027-02-20',status:'open'}],         // 6 run (taekwondo)
  ['demo-editor','tournament.save',{...T,id:'t-winter-2027',name:'Puchar Zimy 2027',date:'2027-02-20',status:'open',sport:'karate'}], // 7 move to karate
  ['demo-club','entry.save',{...E,age:25,weight:70,height:175,gradeType:'cup',grade:5,tournamentId:'t-winter-2027',profileId:clubProfile}], // 8 club entry
  ['demo-club','profile.save',{...A,name:'Nowy Zawodnik Klubu'}],                                               // 9 club adds an athlete
  ['demo-athlete','entry.self',{...E,tournamentId:'t-winter-2027',profileId:'demo-athlete-child'}],             // 10 guardian self-entry (taekwondo)
 ];
 // No stored matrix: the behaviour before the panel.
 const before=both(db,flags,list);
 assert.deepEqual(before.map(r=>r.status),[200,200,200,200,200,200,200,200,200,200,200]);
 // A stored matrix: editors create nowhere, organizers only in judo (own set), editors do not run karate, clubs neither enter nor add athletes, guardians no self-entries.
 let m=off({editor:{'tournament.create':false},organizer:{'tournament.create':false},club:{'entries.submit':false,'athletes.manage':false},guardian:{'entries.self':false}});
 m=setCell(setOwn(m,'judo',true),'organizer','tournament.create','judo',true);
 m=setCell(setOwn(m,'karate',true),'editor','tournament.manage','karate',false);
 const after=both(db,{...flags,perms:m},list);
 assert.deepEqual(after.map(r=>r.status),[403,403,200,403,200,403,200,403,403,403,403]);
 assert.equal(after[0].error,'Administrator wyłączył tworzenie turniejów w tej dyscyplinie dla Twojego rodzaju konta.');
 assert.equal(after[5].error,'Możesz edytować tylko własne turnieje.');
 assert.equal(after[7].error,'Nie możesz przenieść turnieju do dyscypliny, w której nie prowadzisz turniejów.');
 assert.equal(after[8].error,'Zapisy do tego turnieju są zamknięte.');
 assert.equal(after[9].error,'Administrator wyłączył dodawanie zawodników dla Twojego rodzaju konta.');
 assert.equal(after[10].error,'Administrator wyłączył zgłoszenia własne w tej dyscyplinie.');
 // The same switched off only in karate leaves taekwondo self-entries alone.
 const karateOnly=setCell(setOwn(defaults(),'karate',true),'guardian','entries.self','karate',false);
 assert.deepEqual(both(db,{...flags,perms:karateOnly},[list[10]]).map(r=>r.status),[200]);
});

test('the workspace carries the matrix only when one is stored, PHP and JS alike; the browser rules follow it',{skip},()=>{
 const db=initialWorkspace(),m=off({editor:{'tournament.manage':false}});for(const t of db.tournaments)delete t.materials;// the demo's materials (src) never reach PHP
 const actors=['demo-admin','demo-editor','demo-club','demo-organizer','demo-athlete'];
 for(const flags of [{organizers:'on',trustRequired:false},{organizers:'on',trustRequired:false,perms:m}]){
  const ph=roles({job:'public',db,flags,actors}),js=actors.map(id=>publicWorkspace({...db,flags},db.users.find(u=>u.id===id)));usePermissions(null);
  assert.deepEqual(js.map(plain),ph.map(plain));
  for(const w of ph)assert.equal('perms' in w,!!flags.perms);
 }
 const editor=db.users.find(u=>u.id==='demo-editor'),winter=db.tournaments.find(t=>t.id==='t-winter-2027');
 usePermissions(m);assert.equal(manages(editor,winter),false);usePermissions(null);assert.equal(manages(editor,winter),true);
 const club=db.users.find(u=>u.id==='demo-club'),autumn=db.tournaments.find(t=>t.id==='t-autumn-2026'),p=db.profiles.find(x=>x.clubId===club.clubId&&x.ownerId==null);
 usePermissions(off({club:{'entries.submit':false,'athletes.manage':false}}));assert.equal(outsideEntry(club,autumn,db),false);assert.equal(managesProfile(club,p,db),false);
 usePermissions(null);assert.equal(outsideEntry(club,autumn,db),true);assert.equal(managesProfile(club,p,db),true);
});

test('"Moje starty" offers no tournament the own profiles may not enter (JS mirror of AthleteView::project)',()=>{
 const today=day(0),t=(id,sport)=>({id,name:id,city:'X',date:day(10),status:'open',sport,selfEntry:true,hiddenBy:null,createdBy:'demo-editor',community:false,trusted:true,closed:false,entries:[],draws:{}});
 const profiles=[{id:'p1',name:'Z',birthDate:'2012-03-08',sex:'F',weight:40,height:150,gradeType:'cup',grade:7,relation:'guardian',archived:false,clubId:'unaffiliated',clubRow:null}];
 const list=[t('a','taekwondo'),t('b','karate')];
 usePermissions(setCell(setOwn(defaults(),'karate',true),'guardian','entries.self','karate',false));
 assert.deepEqual(projectAthleteView(profiles,list,[],today,{},null).open.map(x=>x.id),['a']);
 usePermissions(null);
 assert.deepEqual(projectAthleteView(profiles,list,[],today,{},null).open.map(x=>x.id),['a','b']);
});

test('admin-permissions.js model: inherited and fixed cells are locked, own sets copy the global set, changes are counted',()=>{
 const view={version:3,global:defaults().global,sports:{}},d=draftOf(view);
 assert.equal(cellOpen(d,'admin','tournament.manage','all'),false);assert.equal(cellValue(d,'admin','admin.manage','all'),true);assert.equal(cellValue(d,'guest','chat.write','all'),false);
 assert.equal(cellOpen(d,'editor','tournament.create','all'),true);assert.equal(cellOpen(d,'editor','tournament.create','karate'),false,'inherits until it has its own set');
 const g=setCell(d,'editor','chat.write','all',false);assert.equal(changes(d,g),1);assert.equal(cellValue(g,'editor','chat.write','karate'),false,'karate shows the inherited value');
 const k=setOwn(g,'karate',true);assert.equal(k.sports.karate.editor['chat.write'],false,'the own set starts as a copy');assert.equal(changes(g,k),1);
 assert.equal(cellOpen(k,'editor','athletes.manage','karate'),false,'a global permission is changed only in the global tab');
 const k2=setCell(k,'editor','chat.write','karate',true);assert.equal(cellValue(k2,'editor','chat.write','karate'),true);assert.equal(cellValue(k2,'editor','chat.write','all'),false);
 assert.equal(setCell(k2,'admin','admin.manage','all',false),k2,'a fixed cell does not change');
 assert.deepEqual(Object.keys(saveBody(view,k2)),['version','global','sports']);assert.equal(saveBody(view,k2).version,3);
 assert.equal(changes(k2,setOwn(k2,'karate',false)),1);
});
