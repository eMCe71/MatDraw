// AthleteView (PLAN-REJESTRACJA-ROLE §7.4, R9): backend/src/AthleteView.php and its mirror dist/athlete-view.js give the same
// answer on a workspace built by the JS domain (states of entries, positions in brackets, category codes, tombstones, the open
// list), the answer has exactly the listed keys and carries no other person's data. tests/php-bridge-athlete.php runs PHP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {initialWorkspace,execute} from '../dist/workspace.js';
import {classify} from '../dist/engine.js';
import {athleteView,projectAthleteView,position,recentFrom,publicClubs,OPEN_LIMIT} from '../dist/athlete-view.js';
import {bracket} from '../dist/guest-view.js';
const php=process.env.PHP_BIN;const skip=!php;
function bridge(input){const r=spawnSync(php,['tests/php-bridge-athlete.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const json=v=>JSON.parse(JSON.stringify(v));
const keys=o=>Object.keys(o).sort();
const TODAY='2030-06-15';

/** A workspace with staff and community tournaments in every state the athlete view distinguishes (dates in 2030). */
function scenario(){
 let db=initialWorkspace();
 db.users.push({id:'org-u',clubId:null,email:'u@example.test',role:'member',active:true,authVersion:1,organizer:true,organizerBlockedAt:null,organizerTrustedAt:null},
  {id:'org-t',clubId:null,email:'t@example.test',role:'member',active:true,authVersion:1,organizer:true,organizerBlockedAt:null,organizerTrustedAt:1790000000},
  {id:'ath',clubId:null,email:'ath@example.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null},
  {id:'parent',clubId:null,email:'parent@example.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null});
 const run=(actor,type,p)=>{const r=execute(db,actor,type,p);db=r.db;return r.result;};
 const t=(actor,name,date,extra={})=>run(actor,'tournament.save',{name,city:'Opole',date,mat:'Mata 1',status:'open',...extra}).id;
 const ids={};
 ids.open=t('demo-admin','Otwarty z losowaniem','2030-06-20',{selfEntry:true});
 ids.plain=t('demo-admin','Otwarty bez losowania','2030-06-22',{selfEntry:true});
 ids.closed=t('demo-admin','Zamknięty','2030-06-25',{selfEntry:true});
 ids.old=t('demo-admin','Dawny','2030-03-01',{selfEntry:true});
 ids.hidden=t('demo-admin','Ukryty','2030-06-28',{selfEntry:true});
 ids.past=t('demo-admin','Po terminie','2030-06-10',{selfEntry:true});
 ids.recent=t('demo-admin','Niedawny','2030-06-05',{selfEntry:true});
 ids.noSelf=t('demo-admin','Bez samodzielnych','2030-06-30',{selfEntry:false});
 ids.untrusted=t('org-u','Społeczny niepotwierdzony','2030-07-01');
 ids.trusted=t('org-t','Społeczny potwierdzony','2030-07-02');
 ids.withdrawn=t('org-t','Wycofany przez organizatora','2030-07-05');
 // The adult athlete (own profile, a new unverified club) and a parent with a child (guardian, unaffiliated, pending club name).
 const self=run('ath','athlete.save',{name:'Adam Własny',birthDate:'1998-04-02',sex:'M',weight:70,height:178,gradeType:'cup',grade:5,club:{name:'Klub Nowy Testowy'},relation:'self'}).id;
 const child=run('parent','athlete.save',{name:'Ola Dziecko',birthDate:'2017-09-12',sex:'F',weight:30,height:130,gradeType:'cup',grade:9,club:{none:true},relation:'guardian'}).id;
 db.profiles.find(a=>a.id===child).pendingClubName='Klub Oczekujący';
 // Staff athletes in the same category as the adult athlete (forms, seniors, men, 6–3 Cup) in the tournaments with brackets.
 const staff=[];for(const [i,name] of ['Piotr Inny','Marek Obcy','Jan Trzeci','Kamil Czwarty'].entries())
  staff.push(run('demo-admin','profile.save',{name,clubId:'club-1',birthDate:'199'+(5+i)+'-01-0'+(i+1),sex:'M',weight:72,height:180,gradeType:'cup',grade:4+i%2,events:['forms']}).id);
 const enter=(actor,tournamentId,profileId,events=['forms'])=>run(actor,'entry.self',{tournamentId,profileId,events});
 for(const tid of [ids.open,ids.recent])for(const pid of staff)run('demo-admin','entry.save',{tournamentId:tid,profileId:pid,weight:72,height:180,gradeType:'cup',grade:5,events:['forms']});
 for(const tid of [ids.open,ids.plain,ids.closed,ids.old,ids.hidden,ids.recent,ids.trusted,ids.withdrawn])enter('ath',tid,self);
 enter('parent',ids.trusted,child);
 const category=classify({age:32,sex:'M',gradeType:'cup',grade:5,weight:70,height:178},'forms').id;
 run('demo-admin','draw.create',{tournamentId:ids.open,categoryId:category});
 run('demo-admin','draw.create',{tournamentId:ids.recent,categoryId:category});
 // Every ready fight of the recent tournament gets a result, the first side wins: a champion and losers.
 for(let more=true;more;){more=false;const d=db.tournaments.find(x=>x.id===ids.recent).draws[category];
  for(const pair of nextReady(d)){run('demo-admin','result.save',{tournamentId:ids.recent,categoryId:category,matchId:pair.id,winnerId:pair.a});more=true;}}
 run('demo-admin','tournament.save',{id:ids.closed,name:'Zamknięty',city:'Opole',date:'2030-06-25',mat:'Mata 1',status:'closed'});
 run('demo-admin','tournament.save',{id:ids.old,name:'Dawny',city:'Opole',date:'2030-03-01',mat:'Mata 1',status:'finished'});
 run('demo-admin','tournament.save',{id:ids.recent,name:'Niedawny',city:'Opole',date:'2030-06-05',mat:'Mata 1',status:'finished'});
 run('demo-admin','tournament.hide',{tournamentId:ids.hidden,hidden:true,reason:'Sprawdzamy'});
 run('org-t','entry.remove',{tournamentId:ids.withdrawn,id:self});
 return {db,ids,self,child,staff,category};
}
import {resolveDraw} from '../dist/engine.js';
function nextReady(d){return resolveDraw(d).flat().filter(m=>m.ready).slice(0,1);}
const S=scenario();
const CASES=[{user:'ath',today:TODAY},{user:'parent',today:TODAY},{user:'ath',today:'2030-04-15'},{user:'demo-admin',today:TODAY},{user:'org-t',today:TODAY,organizers:{'org-u':{n:'Ula U.'},'org-t':{n:'Tomasz T.'}}}];

test('PHP and JS give the same athlete view on the same workspace',{skip},()=>{
 const js=CASES.map(c=>json(athleteView(S.db,{id:c.user},c.today,{organizers:c.organizers??{}})));
 const out=bridge({job:'workspace',db:S.db,cases:CASES});
 for(const [i,c] of CASES.entries())assert.deepEqual(out[i],js[i],JSON.stringify(c));
 assert.deepEqual(out.map(v=>[v.profiles.length,v.entries.length,v.withdrawn.length,v.open.length]),[[1,7,1,5],[1,1,0,5],[1,7,1,6],[0,0,0,5],[0,0,0,5]],'the cases are not empty');
 assert.ok(out[0].entries.some(e=>e.categories.some(c=>c.position&&c.bracket)),'a position in a bracket is compared');
 assert.deepEqual(bridge({job:'recent',dates:['2030-06-15','2030-03-01','2028-03-30','2027-01-10']}),['2030-06-15','2030-03-01','2028-03-30','2027-01-10'].map(recentFrom));
 assert.equal(recentFrom('2030-03-01'),'2030-01-30');
});

test('states of the athlete own entries: open, drawn, closed, old, hidden, finished with results, tombstones',()=>{
 const v=athleteView(S.db,{id:'ath'},TODAY),by=Object.fromEntries(v.entries.map(e=>[e.tournament.id,e]));
 assert.deepEqual(keys(v),['entries','open','profiles','withdrawn']);
 assert.deepEqual(v.entries.map(e=>e.tournament.name),['Społeczny potwierdzony','Ukryty','Zamknięty','Otwarty bez losowania','Otwarty z losowaniem','Niedawny','Dawny'],'newest first');
 const plain=by[S.ids.plain];assert.equal(plain.canWithdraw,true);assert.equal(plain.canEdit,true);
 assert.deepEqual(plain.categories.map(c=>[c.code,c.state,c.drawn,c.position,c.bracket]),[['UF-01','underfilled',false,null,null]]);
 const drawn=by[S.ids.open];assert.equal(drawn.canWithdraw,false,'in a saved draw');assert.equal(drawn.canEdit,false);
 assert.equal(drawn.categories.length,1);const c=drawn.categories[0];
 assert.equal(c.drawn,true);assert.equal(c.state,'drawn');assert.equal(c.athletes,5);assert.equal(c.code,'UF-01');
 assert.ok(['next','bye'].includes(c.position.status),c.position.status);assert.equal(c.bracket.slots[c.position.slot].initials,'A. W.');
 if(c.position.status==='next')assert.deepEqual(keys(c.position.opponent),['club','initials']);else assert.equal(c.position.opponent,null);
 const closed=by[S.ids.closed];assert.equal(closed.tournament.status,'closed');assert.equal(closed.canWithdraw,false);assert.equal(closed.canEdit,false);
 const old=by[S.ids.old];assert.deepEqual(old.categories,[],'older than 30 days: summary only');assert.equal(old.tournament.status,'finished');
 const hidden=by[S.ids.hidden];assert.deepEqual(hidden.tournament,{id:S.ids.hidden,name:'Ukryty',date:'2030-06-28',available:false});assert.deepEqual(hidden.categories,[]);assert.equal(hidden.canWithdraw,false);
 const recent=by[S.ids.recent];assert.equal(recent.categories[0].state,'finished');assert.ok(['champion','lost'].includes(recent.categories[0].position.status));
 const community=by[S.ids.trusted];assert.equal(community.tournament.community,true);assert.equal(community.tournament.trusted,true);
 assert.deepEqual(community.entry.club,{id:community.entry.club.id,name:'Klub Nowy Testowy',verified:false,unaffiliated:false},'own unverified club by its snapshot name');
 assert.deepEqual(v.withdrawn,[{profileId:S.self,tournament:{id:S.ids.withdrawn,name:'Wycofany przez organizatora',date:'2030-07-05'},by:'organizer',at:v.withdrawn[0].at}]);
 assert.equal(v.profiles[0].locked,true);assert.equal(v.profiles[0].minor,false);
 assert.deepEqual(v.profiles[0].club,{id:v.profiles[0].club.id,name:'Klub Nowy Testowy',verified:false,unaffiliated:false,pending:null});
});

test('the open list: self-entries on, not hidden, not past; trust and minors; drawn categories; organizer names only when given',()=>{
 const organizers={'org-u':{n:'Ula U.'},'org-t':{n:'Tomasz T.'}};
 const v=athleteView(S.db,{id:'parent'},TODAY,{organizers}),open=Object.fromEntries(v.open.map(t=>[t.id,t]));
 assert.deepEqual(v.open.map(t=>t.name),['Otwarty z losowaniem','Otwarty bez losowania','Społeczny niepotwierdzony','Społeczny potwierdzony','Wycofany przez organizatora']);
 assert.equal(open[S.ids.untrusted].trusted,false);assert.deepEqual(open[S.ids.untrusted].organizer,{n:'Ula U.'});assert.deepEqual(open[S.ids.untrusted].profiles,[{id:S.child,entered:false,blocked:'minor-untrusted'}]);
 assert.deepEqual(open[S.ids.trusted].profiles,[{id:S.child,entered:true,blocked:null}]);assert.equal(open[S.ids.open].organizer,null,'staff tournaments name no creator');
 assert.deepEqual(open[S.ids.open].drawn,[S.category]);assert.deepEqual(open[S.ids.plain].drawn,[]);
 const child=v.profiles[0];assert.equal(child.minor,true);assert.equal(child.relation,'guardian');
 assert.deepEqual(child.club,{id:'unaffiliated',name:'',verified:true,unaffiliated:true,pending:'Klub Oczekujący'});
 const adult=athleteView(S.db,{id:'ath'},TODAY).open.find(t=>t.id===S.ids.untrusted);assert.deepEqual(adult.profiles,[{id:S.self,entered:false,blocked:null}],'an adult self profile may enter an untrusted tournament');
 const trusting={...S.db,flags:{trustRequired:false}};
 assert.equal(athleteView(trusting,{id:'parent'},TODAY).open.find(t=>t.id===S.ids.untrusted).profiles[0].blocked,null,'trustRequired=false trusts every organizer (§17)');
 assert.deepEqual(athleteView(S.db,{id:'demo-admin'},TODAY).profiles,[],'an account without own profiles');
});

test('exact keys and no other person\'s data in the answer',()=>{
 const v=athleteView(S.db,{id:'ath'},TODAY);
 assert.deepEqual(keys(v.profiles[0]),['archived','birthDate','club','gradeType','grade','height','id','locked','minor','name','relation','sex','weight'].sort());
 for(const e of v.entries){
  assert.deepEqual(keys(e),['canEdit','canWithdraw','categories','entry','profileId','tournament']);
  assert.deepEqual(keys(e.tournament),e.tournament.available?['available','city','community','date','id','name','status','trusted']:['available','date','id','name']);
  assert.deepEqual(keys(e.entry),['actualWeight','age','club','events','grade','gradeType','height','presence','weight']);assert.deepEqual(keys(e.entry.club),['id','name','unaffiliated','verified']);
  for(const c of e.categories){
   assert.deepEqual(keys(c),['athletes','bracket','code','drawn','event','position','state','subtitle','title','type']);
   if(c.position)assert.deepEqual(keys(c.position),['match','opponent','round','slot','status']);
   if(c.bracket){assert.deepEqual(keys(c.bracket),['results','size','slots']);for(const s of c.bracket.slots)if(s)assert.deepEqual(keys(s),['club','initials']);}
  }
 }
 for(const t of v.open){assert.deepEqual(keys(t),['city','community','date','drawn','id','name','organizer','profiles','trusted']);for(const p of t.profiles)assert.deepEqual(keys(p),['blocked','entered','id']);}
 for(const w of v.withdrawn){assert.deepEqual(keys(w),['at','by','profileId','tournament']);assert.deepEqual(keys(w.tournament),['date','id','name']);}
 const raw=JSON.stringify(v);
 for(const secret of ['Piotr Inny','Marek Obcy','Jan Trzeci','Kamil Czwarty','Ola Dziecko',S.child,...S.staff,'demo-admin','org-t','org-u','@','Sprawdzamy','1995-01-01','Mata 1','"activity"','"createdBy"','"rev"','"mat"'])assert.ok(!raw.includes(secret),secret);
});

/** Hand-made draws for every position status: 5 athletes in 8 slots (three byes), results in order. Fights: 1 a–b, 2 c–bye,
 * 3 d–bye, 4 e–bye, 5 (1)–c, 6 d–e, 7 (5)–(6). */
function draws(){
 const ath=id=>{const U=id.toUpperCase();return {id,name:U+'nna '+U+'owska',club:'Klub '+id,clubId:'c-'+id,currentClub:{id:'c-'+id,name:id==='e'?null:'Klub '+id}};};
 const athletes=['a','b','c','d','e'].map(ath),slots=['a','b','c',null,'d',null,'e',null];
 const base={size:8,slots,results:{},signature:'x'},champ={...base,results:{'0-0':'a','1-0':'a','1-1':'d','2-0':'a'}};
 return {athletes,cases:[
  [base,'a','next'],[base,'c','bye'],[base,'d','next'],[{...base,results:{'0-0':'a','1-0':'a'}},'a','won'],[{...base,results:{'0-0':'a'}},'b','lost'],
  [champ,'a','champion'],[champ,'d','lost'],[{...base,results:{'0-0':'a','1-0':'c'}},'a','lost'],[{...base,results:{'0-0':'a'}},'c','next'],[base,'x',null]
 ]};
}
test('positions in a bracket: next, bye, won, lost, champion; opponent only for next and lost (PHP = JS)',{skip},()=>{
 const {athletes,cases}=draws();
 const js=cases.map(([d,id])=>{const b=bracket(d,athletes);return json({bracket:b,position:b?position(d,id,b.bracket):null});});
 for(const [i,[,id,status]] of cases.entries())assert.equal(js[i].position?.status??null,status,id+' '+i);
 assert.deepEqual(js[0].position,{slot:0,round:1,match:1,status:'next',opponent:{initials:'B. B.',club:'Klub b'}});
 assert.deepEqual(js[1].position,{slot:2,round:2,match:5,status:'bye',opponent:null},'c waits for the winner of fight 1 after a bye');
 assert.deepEqual(js[2].position,{slot:4,round:2,match:6,status:'next',opponent:{initials:'E. E.',club:null}},'an unverified club stays hidden');
 assert.deepEqual(js[3].position,{slot:0,round:3,match:7,status:'won',opponent:null});
 assert.deepEqual(js[4].position.opponent,{initials:'A. A.',club:'Klub a'});assert.deepEqual(js[5].position,{slot:0,round:3,match:7,status:'champion',opponent:null});
 assert.deepEqual(js[6].position.opponent,{initials:'A. A.',club:'Klub a'});assert.deepEqual(js[7].position,{slot:0,round:2,match:5,status:'lost',opponent:{initials:'C. C.',club:'Klub c'}});
 assert.deepEqual(bridge({job:'position',cases:cases.map(([draw,id])=>({draw,id,athletes}))}),js);
});

test('project() of hand-made inputs (build() shape: own entries only in old tournaments, draw keys only in open ones) is the same in PHP and JS',{skip},()=>{
 const profiles=[{id:'p1',name:'Ewa Testowa',birthDate:'2014-02-03',sex:'F',weight:40,height:150,gradeType:'cup',grade:8,clubId:'gone',relation:'guardian',archived:false,clubRow:null},
  {id:'p0',name:'Ewa Starsza',birthDate:'1990-02-03',sex:'F',weight:60,height:168,gradeType:'dan',grade:1,clubId:'k',relation:'self',archived:true,clubRow:{id:'k',name:'Klub K',verified:true}}];
 const entry={id:'p1',profileId:'p1',clubId:'gone',name:'Ewa Testowa',club:'Stary Klub',sex:'F',age:16,weight:40,height:150,gradeType:'cup',grade:8,events:['forms'],presence:'present',actualWeight:40.5,self:true,currentClub:{id:'gone',name:null}};
 const tournaments=[{id:'t1',name:'Stary',city:'X',date:'2029-01-01',status:'finished',selfEntry:true,hiddenBy:null,createdBy:'s',community:false,trusted:true,entries:[entry],draws:{}},
  {id:'t2',name:'Otwarty',city:'Y',date:'2030-07-01',status:'open',selfEntry:true,hiddenBy:null,createdBy:'m',community:true,trusted:false,entries:[],draws:{'forms|junior|F|cup|10–7 Cup':true,'forms|cadet|F|cup|6–3 Cup':true}}];
 const withdrawals=[{profileId:'p1',tournament:{id:'t9',name:'Dawniej',date:'2029-05-05'},by:'system',at:5},{profileId:'p1',tournament:{id:'t8',name:'Inny',date:'2029-05-06'},by:'hacker',at:6},{profileId:'zz',tournament:{id:'t8',name:'Inny',date:'2029-05-06'},by:'admin',at:7}];
 const js=json(projectAthleteView(profiles,tournaments,withdrawals,TODAY,{m:{n:'Marta K.'}}));
 assert.deepEqual(bridge({job:'project',profiles,tournaments,withdrawals,today:TODAY,organizers:{m:{n:'Marta K.'}}}),js);
 assert.deepEqual(js.profiles.map(p=>p.id),['p0','p1']);assert.deepEqual(js.profiles[1].club,{id:'gone',name:'',verified:false,unaffiliated:false,pending:null});
 assert.deepEqual(js.entries[0].entry.club,{id:'gone',name:'Stary Klub',verified:false,unaffiliated:false});
 assert.deepEqual(js.withdrawn.map(w=>w.by),['system'],'only own profiles and known kinds');
 assert.deepEqual(js.open[0].drawn,['forms|cadet|F|cup|6–3 Cup','forms|junior|F|cup|10–7 Cup']);assert.deepEqual(js.open[0].organizer,{n:'Marta K.'});
 assert.deepEqual(js.open[0].profiles,[{id:'p1',entered:false,blocked:'minor-untrusted'}],'archived profiles are not offered');
});

test('include (?t= of the athlete route): a qualifying tournament beyond OPEN_LIMIT is appended; others change nothing (PHP = JS)',{skip},()=>{
 const profiles=[{id:'p1',name:'Ewa Testowa',birthDate:'1990-02-03',sex:'F',weight:60,height:168,gradeType:'cup',grade:5,clubId:'unaffiliated',relation:'self',archived:false,clubRow:null}];
 const day=n=>new Date(Date.parse(TODAY+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
 const t=(id,date,over={})=>({id,name:'Turniej '+id,city:'Opole',date,status:'open',selfEntry:true,hiddenBy:null,createdBy:'s',community:false,trusted:true,entries:[],draws:{},...over});
 const tournaments=[...Array.from({length:OPEN_LIMIT+2},(_,i)=>t('o'+String(i).padStart(3,'0'),day(1+i))),t('draft',day(99),{status:'draft'}),t('closed',day(99),{status:'closed'}),
  t('noself',day(99),{selfEntry:false}),t('hidden',day(99),{hiddenBy:'a'}),t('past',day(-1))];
 const last='o'+String(OPEN_LIMIT+1).padStart(3,'0'),run=include=>{const js=json(projectAthleteView(profiles,tournaments,[],TODAY,{},include));
  assert.deepEqual(bridge({job:'project',profiles,tournaments,withdrawals:[],today:TODAY,organizers:{},include}),js,String(include));return js.open.map(x=>x.id);};
 const plain=run(null);assert.equal(plain.length,OPEN_LIMIT);assert.ok(!plain.includes(last));
 assert.deepEqual(run(last),[...plain,last],'the requested tournament comes last, after the nearest ones');
 for(const id of ['o000','draft','closed','noself','hidden','past','missing'])assert.deepEqual(run(id),plain,id);
 const db=json(S.db);assert.deepEqual(athleteView(db,{id:'ath'},TODAY,{include:'missing'}),athleteView(db,{id:'ath'},TODAY),'the workspace form takes include too');
});

test('publicClubs (demo of public-clubs): verified, not merged, without unaffiliated, by Polish name',()=>{
 const clubs=[{id:'b',name:'Łódź Klub',verified:true},{id:'a',name:'Lublin',verified:true},{id:'u',name:'Nowy',verified:false},{id:'m',name:'Scalony',verified:true,mergedInto:'a'},{id:'unaffiliated',name:'Niezrzeszony',verified:true}];
 assert.deepEqual(publicClubs(clubs),{clubs:[{id:'a',name:'Lublin'},{id:'b',name:'Łódź Klub'}],unaffiliated:'unaffiliated'});
 assert.deepEqual(publicClubs(initialWorkspace().clubs).clubs.map(c=>c.id).includes('unaffiliated'),false);
});
