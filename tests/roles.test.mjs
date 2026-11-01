// Roles, organizers, athlete profiles and self-entries in the workspace rules (PLAN-REJESTRACJA-ROLE §5–§7, §12), on dist/workspace.js;
// tests/roles-parity.test.mjs checks that backend/src/Domain.php gives the same answers. Covers the §5.2 matrix, the outsideEntry
// truth table, limits and their semantics, CONTACT, entry.self gates, the owner's withdrawal, athlete.save, club choice, the
// self-entry correction by the manager, tournament.hide with tombstones, forgetting profiles in brackets with results and stale().
import test from 'node:test';
import assert from 'node:assert/strict';
import {initialWorkspace,execute,publicWorkspace,outsideEntry,canEnter,manages,managesProfile,staffProfile,community,trusted,organizer,canCreateTournament,stale,contact,pickClub,UNAFFILIATED,DELETED,
 ORGANIZER_DAY,ORGANIZER_ACTIVE,COMMUNITY_DAY_GLOBAL,ORGANIZER_PROFILES_DAY,CLUBS_DAY_PER_USER,CLUBS_DAY_GLOBAL,MINOR_SELF_AGE,ADULT_AGE,ATHLETES_PER_ACCOUNT,RETENTION_MONTHS,ORGANIZER_TYPES,guestTournaments} from '../dist/workspace.js';
import {classify,makeDraw,resolveDraw} from '../dist/engine.js';
import {warsawToday,guestUpcoming,guestTournament} from '../dist/guest-view.js';
const NOW=Math.floor(Date.now()/1000),day=n=>warsawToday(new Date(Date.now()+n*864e5));
const born=years=>{const [y,m,d]=day(0).split('-').map(Number);return (y-years)+'-'+String(m).padStart(2,'0')+'-'+String(Math.min(d,28)).padStart(2,'0');};
const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']},E={events:['forms'],weight:70,height:175,gradeType:'cup',grade:5};
const T={city:'Opole',mat:'Mata 1'};
/** initialWorkspace + an unconfirmed (org1), a confirmed (org2) and a blocked organizer (org3), an athlete account (ath) and a member without roles (mem). */
function world(){
 const db=initialWorkspace(),u=(id,o)=>({id,clubId:null,email:id+'@r.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null,...o});
 db.users.push(u('org1',{organizer:true}),u('org2',{organizer:true,organizerTrustedAt:NOW-100}),u('org3',{organizer:true,organizerTrustedAt:NOW-100,organizerBlockedAt:NOW-50}),u('ath'),u('mem'));
 return db;
}
function run(db,actor,type,payload,revision=db.revision){return execute(db,actor,type,payload,revision);}
function code(fn){try{fn();return 200;}catch(e){return e.status??422;}}
function err(fn){try{fn();return null;}catch(e){return [e.status,e.message];}}
/** Applies commands in order (each on the result of the previous one) and returns {db, ids}. */
function seq(db,list){const ids=[];for(const [actor,type,p] of list){const out=run(db,actor,type,typeof p==='function'?p(ids):p);db=out.db;ids.push(out.result.id);}return {db,ids};}
const view=(db,id)=>publicWorkspace(db,db.users.find(u=>u.id===id));

test('constants are the plan values (§5.4, O5) and organizer commands are listed',()=>{
 assert.deepEqual([ORGANIZER_DAY,ORGANIZER_ACTIVE,COMMUNITY_DAY_GLOBAL,ORGANIZER_PROFILES_DAY,CLUBS_DAY_PER_USER,CLUBS_DAY_GLOBAL,MINOR_SELF_AGE,ADULT_AGE,ATHLETES_PER_ACCOUNT,RETENTION_MONTHS],[3,10,50,300,3,30,16,18,5,24]);
 assert.deepEqual(ORGANIZER_TYPES,['tournament.save','profile.save','profile.archive','profile.forget','entry.save','entry.remove','checkin.save','draw.create','result.save','result.clear']);
});

test('outsideEntry truth table (§5.7) and the same answers from view fields',()=>{
 const db=world();const tour=(createdBy,status,selfEntry)=>({id:'x',createdBy,status,selfEntry,entries:[]});
 const users=Object.fromEntries(db.users.map(u=>[u.id,u]));
 const rows=[ // [tournament, club, editor, org1, org2, mem]
  [tour('demo-admin','open',false),true,true,false,false,false],
  [tour('demo-admin','open',true),true,true,true,true,false],
  [tour('demo-admin','closed',true),false,false,false,false,false],
  [tour('org2','open',true),true,true,true,true,false],    // community, confirmed: club and editor (O1), organizers with selfEntry (O19)
  [tour('org2','open',false),true,true,false,false,false],
  [tour('org1','open',true),false,false,false,false,false],// community, unconfirmed: nobody from outside
  [tour('org3','open',true),false,false,false,false,false],// blocked organizer: not trusted
 ];
 for(const [t,...expected] of rows){
  const actual=['demo-club','demo-editor','org1','org2','mem'].map(id=>outsideEntry(users[id],t,db));
  assert.deepEqual(actual,expected,JSON.stringify(t));
  const v={...t,community:community(db,t),trusted:trusted(db,t)};
  assert.deepEqual(['demo-club','demo-editor','org1','org2','mem'].map(id=>outsideEntry(users[id],v)),expected,'view fields: '+JSON.stringify(v));
 }
 // The unconfirmed organizer manages (and enters) his own tournament; nobody else does.
 const own=tour('org1','open',true);assert.equal(canEnter(users.org1,own,db),true);assert.equal(manages(users.org1,own),true);assert.equal(manages(users.org3,tour('org3','open',true)),false,'blocked');
 assert.equal(canEnter(users['demo-admin'],own,db),true,'admin manages everything');assert.equal(canEnter(users.org1,{...own,status:'finished'},db),false);
 assert.deepEqual(['demo-admin','demo-editor','demo-club','org1','org3','mem'].map(id=>canCreateTournament(users[id])),[true,true,false,true,false,false]);
 assert.equal(organizer(users.org3),false);assert.equal(organizer({...users.org1,role:'editor'}),false,'only members have the organizer role');
 // trustRequired=false (§17): every organizer not blocked works as confirmed.
 const loose={...db,flags:{trustRequired:false}};
 assert.equal(trusted(loose,tour('org1','open',true)),true);assert.equal(trusted(loose,tour('org3','open',true)),false);assert.equal(outsideEntry(users['demo-club'],tour('org1','open',true),loose),true);
});

test('§5.2 matrix: tournaments, entries, profiles, clubs and accounts of every actor',()=>{
 let db=world();
 const {db:d,ids}=seq(db,[
  ['org1','tournament.save',{...T,name:'Org1 open',date:day(30),status:'open'}],                       // 0 community, unconfirmed
  ['org2','tournament.save',{...T,name:'Org2 open',date:day(31),status:'open'}],                       // 1 community, confirmed
  ['org1','profile.save',{...A,name:'Adam Organizatorski',club:{name:'Nowy Klub Org'}}],               // 2 org1 profile, new unverified club
  ['org2','profile.save',{...A,name:'Bartek Drugi',clubId:'club-2'}],                                   // 3 org2 profile
  ['demo-editor','profile.save',{...A,name:'Celina Edytorska',sex:'F',clubId:'club-1'}],              // 4 staff profile of club-1
  ['ath','athlete.save',{...A,relation:'self',name:'Daria Sama',sex:'F',club:{id:'club-1'}}],          // 5 owned profile, club-1
  [ 'org1','entry.save',i=>({...E,tournamentId:i[0],profileId:i[2]})],
  [ 'org2','entry.save',i=>({...E,tournamentId:i[1],profileId:i[3]})],
  [ 'org1','entry.save',i=>({...E,tournamentId:'t-winter-2027',profileId:i[2]})],                     // O19: staff, open, selfEntry
  [ 'demo-editor','entry.save',i=>({...E,tournamentId:i[1],profileId:i[4]})],                         // O1 in a confirmed tournament
  [ 'ath','entry.self',i=>({tournamentId:'t-winter-2027',profileId:i[5],events:['forms']})],
  [ 'ath','entry.self',i=>({tournamentId:i[0],profileId:i[5],events:['forms']})],
  [ 'demo-editor','entry.save',i=>({...E,tournamentId:'t-winter-2027',profileId:i[4]})],
 ]);db=d;const [t1,t2,p1,p2,p3,p4]=ids;
 const tours=v=>v.tournaments.map(t=>t.id),entries=(v,id)=>v.tournaments.find(t=>t.id===id)?.entries.map(e=>e.profileId).sort()??null,profs=v=>v.profiles.map(p=>p.id);
 const admin=view(db,'demo-admin'),editor=view(db,'demo-editor'),club=view(db,'demo-club'),o1=view(db,'org1'),o2=view(db,'org2'),ath=view(db,'ath'),mem=view(db,'mem');
 // Admin: everything; accounts are staff only.
 assert.deepEqual(tours(admin).sort(),db.tournaments.map(t=>t.id).sort());assert.deepEqual(admin.users.map(u=>u.id).sort(),['demo-admin','demo-club','demo-editor']);
 assert.ok(admin.profiles.some(p=>p.id===p4&&p.ownerId==='ath'&&p.relation==='self'),'admin sees owned profiles with owner and relation');
 // Editor: staff profiles only; staff tournaments as before (all entries, O2); community: confirmed only, own entries only, no draws or log.
 assert.ok(!profs(editor).includes(p1)&&!profs(editor).includes(p2)&&!profs(editor).includes(p4)&&profs(editor).includes(p3));
 assert.deepEqual(entries(editor,'t-winter-2027'),[p1,p3,p4].sort(),'staff tournament: every entry, self and organizer ones included (O2)');
 assert.ok(!tours(editor).includes(t1),'unconfirmed community tournament');assert.deepEqual(entries(editor,t2),[p3]);
 const e2=editor.tournaments.find(t=>t.id===t2);assert.deepEqual([e2.community,e2.trusted,e2.activity,Object.keys(e2.draws),e2.createdBy],[true,true,[],[],undefined]);
 // Club: staff profiles of its club; entries of its club and staff profiles only (no self-entries, O10).
 assert.deepEqual(profs(club).filter(id=>[p1,p2,p3,p4].includes(id)),[p3]);assert.ok(club.profiles.every(p=>p.clubId==='club-1'&&p.staff===true));
 assert.deepEqual(entries(club,'t-winter-2027'),[p3],'no self-entry and no organizer profile of the club');
 assert.ok(!tours(club).includes(t1));assert.deepEqual(entries(club,t2),[p3]);assert.deepEqual(club.clubs.map(c=>c.id),['club-1']);
 // Organizer: own tournaments in full, own profiles, other open self-entry tournaments with own entries only.
 assert.deepEqual(profs(o1),[p1]);assert.deepEqual(entries(o1,t1),[p1,p4].sort(),'own tournament: every entry');
 assert.deepEqual(entries(o1,'t-winter-2027'),[p1],'other tournament: only his entries');assert.ok(!tours(o1).includes('t-autumn-2026'),'open without self-entries and without his entries');
 assert.ok(tours(o1).includes(t2)&&entries(o1,t2).length===0,'confirmed community tournament open for self-entries');
 const w=o1.tournaments.find(t=>t.id==='t-winter-2027');assert.deepEqual([w.draws,w.activity,w.createdBy,w.selfEntry],[{},[],undefined,true]);
 assert.equal(o1.users.length,0);assert.ok(o1.clubs.some(c=>c.name==='Nowy Klub Org'&&c.verified===false),'clubs of his profiles even when unverified');
 assert.ok(!o1.clubs.some(c=>c.createdBy!==undefined),'no creators of clubs outside the Admin view');
 assert.deepEqual(entries(o2,t2),[p2,p3].sort());assert.ok(!tours(o2).includes(t1),'unconfirmed tournaments of others are not listed for organizers');
 // Members without the organizer role get the empty shape.
 for(const v of [ath,mem]){for(const k of ['clubs','users','profiles','tournaments'])assert.deepEqual(v[k],[],k);}
 // Privacy sweep: an organizer's workspace holds no name of foreign athletes.
 const json=JSON.stringify(o1);for(const n of ['Bartek Drugi','Celina Edytorska'])assert.ok(!json.includes(n),n);
 assert.ok(!JSON.stringify(o2).includes('Adam Organizatorski')&&!JSON.stringify(o2).includes('Daria Sama'));
 assert.ok(!editor.profiles.some(p=>p.name==='Adam Organizatorski')&&!club.profiles.some(p=>p.name==='Adam Organizatorski'),'organizer profiles reach the editor only as entries in staff tournaments (O2)');
 // Field rules: staff flag for every profile, ownerId only for Admin and owner, hidden fields for managers.
 assert.ok(o1.profiles.every(p=>p.staff===false&&!('ownerId' in p)&&p.createdBy==='org1'));
 assert.ok(editor.profiles.every(p=>!('ownerId' in p)&&!('relation' in p)));
 const own=o1.tournaments.find(t=>t.id===t1);assert.deepEqual([own.hidden,own.hideReason,'hiddenBy' in own,typeof own.createdAt],[false,null,false,'number']);
});

test('limits: day limit, published upcoming limit without drafts and hidden ones, finished only from the day, paused publishing, global limit',()=>{
 let db=world();
 const save=(name,o={})=>['org1','tournament.save',{...T,name,date:day(40),status:'draft',...o}];
 let made=0;const make=(n,o)=>{for(let i=0;i<n;i++)db=run(db,...save('Turniej '+(++made),o)).db;};
 make(3);assert.deepEqual(err(()=>run(db,...save('Czwarty'))),[429,'Limit nowych turniejów: 3 na dobę.']);
 assert.equal(code(()=>run(db,...save('Czwarty'))),429);
 // Drafts and older tournaments do not count to ORGANIZER_ACTIVE; published upcoming ones do, hidden ones not.
 for(const t of db.tournaments)if(t.createdBy==='org1')t.createdAt=NOW-90000;
 const mine=()=>db.tournaments.filter(t=>t.createdBy==='org1');
 for(let i=0;i<9;i++){make(1,{status:'open',date:day(10+i)});for(const t of mine())t.createdAt=NOW-90000;}
 assert.equal(mine().filter(t=>t.status==='open').length,9);
 const draft=mine().find(t=>t.status==='draft');
 const publish=t=>['org1','tournament.save',{...T,id:t.id,name:t.name,date:t.date,status:'open'}];
 db=run(db,...publish(draft)).db;assert.equal(mine().filter(t=>t.status!=='draft').length,10);
 const other=mine().find(t=>t.status==='draft');
 assert.deepEqual(err(()=>run(db,...publish(other))),[429,'Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.']);
 assert.equal(code(()=>run(db,'org1','tournament.save',{...T,id:other.id,name:other.name,date:day(-3),status:'open'})),200,'a past tournament is not upcoming');
 const open=mine().find(t=>t.status==='open'&&t.date>=day(0));Object.assign(open,{hiddenBy:'demo-admin',hiddenFrom:'open',status:'draft'});
 assert.deepEqual(err(()=>run(db,...publish(open))),[409,'Turniej ukrył Administrator. Status może zmienić tylko Administrator.'],'hidden: status locked');
 assert.equal(code(()=>run(db,...publish(other))),200,'a hidden tournament frees its place');
 // Finished only from the day of the tournament.
 const t0=mine().find(t=>t.status==='open'&&t.date>day(0)&&!t.hiddenBy);
 assert.deepEqual(err(()=>run(db,'org1','tournament.save',{...T,id:t0.id,name:t0.name,date:t0.date,status:'finished'})),[422,'Turniej można zakończyć najwcześniej w dniu zawodów.']);
 let fresh=world();fresh=run(fresh,'org1','tournament.save',{...T,name:'Dziś',date:day(0),status:'open'}).db;const today=fresh.tournaments.at(-1);
 assert.equal(code(()=>run(fresh,'org1','tournament.save',{...T,id:today.id,name:'Dziś',date:day(0),status:'finished'})),200);
 // Paused publishing: unconfirmed organizers cannot publish new or draft tournaments; confirmed ones and edits of published ones can.
 const paused={...world(),flags:{organizers:'paused'}};
 assert.deepEqual(err(()=>run(paused,'org1','tournament.save',{...T,name:'Nowy',date:day(5),status:'open'})),[409,'Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.']);
 assert.equal(code(()=>run(paused,'org1','tournament.save',{...T,name:'Nowy',date:day(5),status:'draft'})),200);
 assert.equal(code(()=>run(paused,'org2','tournament.save',{...T,name:'Nowy',date:day(5),status:'open'})),200,'confirmed organizer');
 let p2=run({...world(),flags:{organizers:'on'}},'org1','tournament.save',{...T,name:'Opublikowany',date:day(5),status:'open'}).db;p2.flags={organizers:'paused'};
 const pub=p2.tournaments.at(-1);assert.equal(code(()=>run(p2,'org1','tournament.save',{...T,id:pub.id,name:'Zmieniony',date:day(5),status:'closed'})),200,'published tournaments stay editable');
 // Global limit of new tournaments by unconfirmed organizers (confirmed ones are exempt).
 const g=world();for(let i=0;i<COMMUNITY_DAY_GLOBAL;i++)g.tournaments.push({id:'g'+i,name:'G',city:'X',date:day(9),mat:'M',status:'draft',createdBy:'mem',createdAt:NOW-60,selfEntry:true,entries:[],draws:{},activity:[]});
 assert.deepEqual(err(()=>run(g,'org1','tournament.save',{...T,name:'Ponad limit',date:day(5),status:'draft'})),[429,'Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.']);
 assert.equal(code(()=>run(g,'org2','tournament.save',{...T,name:'Potwierdzony',date:day(5),status:'draft'})),200);
 // Profiles added by organizers: 300 per day.
 const pd=world();for(let i=0;i<ORGANIZER_PROFILES_DAY;i++)pd.profiles.push({id:'pp'+i,name:'P',clubId:'club-1',createdBy:'org1',createdAt:NOW-10,ownerId:null,archived:false});
 assert.deepEqual(err(()=>run(pd,'org1','profile.save',{...A,name:'Za dużo',clubId:'club-1'})),[429,'Limit nowych zawodników na dziś został osiągnięty.']);
 const e=(()=>{try{run(pd,'org1','profile.save',{...A,name:'Za dużo',clubId:'club-1'});}catch(x){return x;}})();assert.ok(e.data.retry>0&&e.data.retry<=86400,'retry in the data');
});

test('CONTACT, Text cleaning and selfEntry defaults of tournament.save',()=>{
 for(const s of ['Turniej na www.zapisy.pl','Zapisy: kontakt@klub','Tel 600 700 800','klub.com','https://matbravo.com'])assert.ok(contact(s),s);
 for(const s of ['Puchar Krakowa 2026','Turniej 12.11.2026','Hala nr 2','Mata 1-2','Kraków'])assert.ok(!contact(s),s);
 let db=world();
 assert.equal(code(()=>run(db,'org1','tournament.save',{...T,name:'Turniej',city:'kontakt@klub.pl',date:day(9),status:'draft'})),422);
 assert.equal(code(()=>run(db,'demo-admin','tournament.save',{...T,name:'Staff www.x.pl',date:day(9),status:'draft'})),200,'staff texts are not checked for contacts');
 db=run(db,'org1','tournament.save',{...T,name:' Turniej ‮Bidi ',date:day(9),status:'draft'}).db;const t=db.tournaments.at(-1);
 assert.deepEqual([t.name,t.selfEntry,t.createdBy,typeof t.createdAt],['Turniej Bidi',true,'org1','number'],'Text::clean, organizer default selfEntry=true');
 db=run(db,'demo-admin','tournament.save',{...T,name:'Personel',date:day(9),status:'draft'}).db;assert.equal(db.tournaments.at(-1).selfEntry,false,'staff default selfEntry=false (R11)');
 db=run(db,'org1','tournament.save',{...T,id:t.id,name:'Turniej',date:day(9),status:'draft'}).db;assert.equal(db.tournaments.find(x=>x.id===t.id).selfEntry,true,'unchanged without the field');
 db=run(db,'org1','tournament.save',{...T,id:t.id,name:'Turniej',date:day(9),status:'draft',selfEntry:false}).db;assert.equal(db.tournaments.find(x=>x.id===t.id).selfEntry,false);
});

test('members get one 404 for missing, draft and hidden tournaments and for profiles they may not see (PS-15)',()=>{
 let db=world();db=run(db,'org2','tournament.save',{...T,name:'Ukryty',date:day(9),status:'open'}).db;const hid=db.tournaments.at(-1);Object.assign(hid,{status:'draft',hiddenBy:'demo-admin',hiddenFrom:'open'});
 const answers=['t-spring-2027',hid.id,'missing'].map(id=>err(()=>run(db,'org1','entry.save',{...E,tournamentId:id,profileId:'a1'})));
 assert.deepEqual(answers,Array(3).fill([404,'Turniej nie jest dostępny.']));
 assert.deepEqual(err(()=>run(db,'ath','entry.self',{tournamentId:'t-spring-2027',profileId:'x',events:['forms']})),[404,'Zawodnik nie istnieje.']);
 const profiles=['a1','missing'].map(id=>err(()=>run(db,'org1','profile.save',{...A,id,name:'X',clubId:'club-1'})));
 assert.deepEqual(profiles,Array(2).fill([404,'Zawodnik nie istnieje.']));
});

test('entry.self gates: saved draws, minors in unconfirmed tournaments, closed, past and duplicate entries; tombstones vanish on re-entry',()=>{
 let db=world();
 const {db:d,ids}=seq(db,[
  ['ath','athlete.save',{...A,relation:'self',name:'Ewa Dorosła',sex:'F',club:{none:true}}],
  ['ath','athlete.save',{...A,relation:'guardian',name:'Ola Mała',sex:'F',birthDate:born(12),weight:40,height:150,grade:8,club:{id:'club-2'}}],
  ['org1','tournament.save',{...T,name:'Niepotwierdzony',date:day(20),status:'open'}],
  ['org2','tournament.save',{...T,name:'Potwierdzony',date:day(21),status:'open'}],
 ]);db=d;const [adult,kid,t1,t2]=ids;
 const self=(t,p,o={})=>run(db,'ath','entry.self',{tournamentId:t,profileId:p,events:['forms'],...o});
 assert.deepEqual(err(()=>self(t1,kid)),[409,'Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.']);
 assert.equal(code(()=>self(t2,kid)),200,'confirmed organizer');assert.equal(code(()=>self(t1,adult)),200,'adult');
 const g={...db,users:db.users.map(u=>u.id==='ath'?u:u)};g.profiles=g.profiles.map(p=>p.id===adult?{...p,relation:'guardian'}:p);
 assert.equal(code(()=>run(g,'ath','entry.self',{tournamentId:t1,profileId:adult,events:['forms']})),409,'a guardian profile counts as a minor (§7.1)');
 assert.equal(code(()=>self(t2,kid,{events:['light']})),422,'event not allowed for the age');
 assert.equal(code(()=>self(t2,kid,{events:'forms'})),422);
 db=self(t2,kid).db;assert.deepEqual(err(()=>self(t2,kid)),[409,'Jesteś już zgłoszony do tego turnieju.']);
 const entry=db.tournaments.find(t=>t.id===t2).entries.find(e=>e.profileId===kid);
 assert.deepEqual([entry.self,entry.champion,entry.club,entry.presence,entry.age],[true,false,'KS Tiger Kraków','pending',12]);
 db=run(db,'ath','entry.self',{tournamentId:t2,profileId:kid,events:['forms'],update:true,weight:41,saveToProfile:true}).db;
 assert.equal(db.profiles.find(p=>p.id===kid).weight,41,'saveToProfile updates the profile in the same command');
 assert.match(db.tournaments.find(t=>t.id===t2).activity[0].text,/^Zmieniono zgłoszenie własne: Ola Mała$/);
 // Closed, past, no self-entries, finished: 403 with one message.
 for(const [name,patch] of [['closed',{status:'closed'}],['past',{date:day(-1)}],['no self-entries',{selfEntry:false}],['finished',{status:'finished'}]]){
  const x=structuredClone(db);Object.assign(x.tournaments.find(t=>t.id===t1),patch);
  assert.deepEqual(err(()=>run(x,'ath','entry.self',{tournamentId:t1,profileId:adult,events:['forms']})),[403,'Zapisy do tego turnieju są zamknięte.'],name);
 }
 // A category with a saved draw takes no self-entry (DR-5): three athletes of the adult's category and their draw.
 const tour=db.tournaments.find(t=>t.id===t2);
 for(const n of [1,2,3]){const p={...A,name:'Seniorka '+n,sex:'F',clubId:'club-'+n};db=seq(db,[['org2','profile.save',p],['org2','entry.save',i=>({...E,tournamentId:t2,profileId:i[0]})]]).db;}
 const cat=classify({age:30,sex:'F',gradeType:'cup',grade:5,weight:70,height:175},'forms').id;
 db=run(db,'org2','draw.create',{tournamentId:t2,categoryId:cat}).db;
 assert.deepEqual(err(()=>self(t2,adult)),[409,'Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.']);
 assert.ok(db.tournaments.find(t=>t.id===t2).draws[cat],'the draw stays');void tour;
 // Archived or missing profiles.
 db=run(db,'ath','athlete.save',{...A,relation:'guardian',name:'Trzecia',sex:'F',birthDate:born(20),club:{none:true}}).db;const third=db.profiles.at(-1).id;
 db=run(db,'ath','athlete.archive',{profileId:third}).db;
 assert.deepEqual(err(()=>self(t1,third)),[409,'Najpierw uzupełnij dane zawodnika.']);assert.deepEqual(err(()=>run(db,'ath','entry.self',{tournamentId:t1,events:['forms']})),[409,'Najpierw uzupełnij dane zawodnika.']);
 assert.equal(code(()=>run(db,'org1','entry.self',{tournamentId:t1,profileId:adult,events:['forms']})),404,'not his profile');
 assert.equal(code(()=>run(db,'demo-admin','entry.self',{tournamentId:t1,profileId:adult,events:['forms']})),403,'staff never self-enter');
});

test('owner withdrawal: open 200 before canEnter, closed 403 with the hint, in a saved draw 409; organizer withdrawal leaves a tombstone',()=>{
 let db=world();
 const {db:d,ids}=seq(db,[['ath','athlete.save',{...A,relation:'self',name:'Ewa Wycofana',sex:'F',club:{none:true}}],['org2','tournament.save',{...T,name:'T',date:day(20),status:'open'}]]);db=d;const [p,t]=ids;
 db=run(db,'ath','entry.self',{tournamentId:t,profileId:p,events:['forms']}).db;
 const closed=structuredClone(db);closed.tournaments.find(x=>x.id===t).status='closed';
 assert.deepEqual(err(()=>run(closed,'ath','entry.remove',{tournamentId:t,id:p})),[403,'Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.']);
 const drawn=structuredClone(db);drawn.tournaments.find(x=>x.id===t).draws.k={slots:[p,null,null,null,null,null,null,null],results:{},signature:'',size:8};
 assert.deepEqual(err(()=>run(drawn,'ath','entry.remove',{tournamentId:t,id:p})),[409,'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.']);
 const out=run(db,'ath','entry.remove',{tournamentId:t,id:p});assert.equal(out.db.tournaments.find(x=>x.id===t).entries.length,0);assert.deepEqual(out.db.withdrawals,[],'no tombstone for the owner');
 const org=run(db,'org2','entry.remove',{tournamentId:t,id:p}).db;assert.deepEqual(org.withdrawals.map(w=>[w.profileId,w.tournamentId,w.by]),[[p,t,'organizer']]);
 const back=run(org,'ath','entry.self',{tournamentId:t,profileId:p,events:['forms']}).db;assert.deepEqual(back.withdrawals,[],'re-entry removes the tombstone');
 assert.equal(code(()=>run(db,'org1','entry.remove',{tournamentId:t,id:p})),404,'unconfirmed outsider: the tournament is not open for him');
});

test('athlete.save: closed fields, age 16 for self, 5 profiles, one self, identity locked while entries are pending',()=>{
 let db=world();const save=p=>run(db,'ath','athlete.save',p);
 assert.deepEqual(err(()=>save({...A,relation:'self',name:'Za Młody',birthDate:born(15),club:{none:true}})),[422,'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.']);
 assert.equal(code(()=>save({...A,relation:'self',name:'Szesnastolatek',birthDate:born(16),club:{none:true}})),200);
 assert.equal(code(()=>save({...A,relation:'other',name:'X',club:{none:true}})),422);
 db=save({...A,relation:'self',name:'Ja Sam',club:{id:'club-1'},ownerId:'org1',createdBy:'org1',champion:true,events:['light'],archived:true}).db;
 const me=db.profiles.at(-1);assert.deepEqual([me.ownerId,me.createdBy,me.champion,me.events,me.archived,me.relation],['ath','ath',false,['forms'],false,'self'],'closed list of fields');
 assert.deepEqual(err(()=>save({...A,relation:'self',name:'Drugi Ja',club:{none:true}})),[409,'Na koncie jest już Twój własny profil zawodnika.']);
 for(let i=0;i<4;i++)db=save({...A,relation:'guardian',name:'Dziecko '+i,birthDate:born(10),weight:35,height:140,grade:9,club:{none:true}}).db;
 assert.equal(db.profiles.filter(p=>p.ownerId==='ath').length,5);
 assert.deepEqual(err(()=>save({...A,relation:'guardian',name:'Szóste',birthDate:born(9),weight:30,height:130,grade:9,club:{none:true}})),[409,'Na jednym koncie może być najwyżej 5 zawodników.']);
 assert.ok(typeof db.profiles.at(-1).guardianDeclaredAt==='number','guardian declaration time is kept (hook for consent)');
 // Identity locked while entries in open or closed tournaments exist; name and measures are free.
 db=run(db,'ath','entry.self',{tournamentId:'t-winter-2027',profileId:me.id,events:['forms']}).db;
 for(const patch of [{birthDate:'1994-01-01'},{sex:'F'},{club:{id:'club-2'}},{club:{none:true}}])assert.equal(code(()=>save({...A,id:me.id,relation:'self',name:'Ja Sam',club:{id:'club-1'},...patch})),409,JSON.stringify(patch));
 db=save({...A,id:me.id,relation:'self',name:'Ja Zmieniony',weight:72,club:{id:'club-1'}}).db;
 assert.deepEqual([db.profiles.find(p=>p.id===me.id).name,db.tournaments.find(t=>t.id==='t-winter-2027').entries.find(e=>e.profileId===me.id).name],['Ja Zmieniony','Ja Sam'],'snapshots do not change');
 assert.equal(code(()=>run(db,'ath','athlete.archive',{profileId:me.id})),409);assert.equal(code(()=>run(db,'org1','athlete.save',{...A,id:me.id,relation:'self',name:'Obcy',club:{none:true}})),404);
});

test('club choice: Cyrillic, Kraków/Krakow, merged clubs, "no club" names and the pending name over the quota',()=>{
 const clubs=[...initialWorkspace().clubs,{id:'m1',name:'Stary',verified:true,mergedInto:'club-3'}],member={id:'m',role:'member'};
 assert.deepEqual(pickClub(clubs,member,{name:'ks tiger krakow'},NOW),{clubId:'club-2'});
 assert.deepEqual(pickClub(clubs,member,{name:'stary'},NOW),{clubId:'club-3'});assert.deepEqual(pickClub(clubs,member,{id:'m1'},NOW),{clubId:'club-3'});
 for(const n of ['Niezrzeszony','niezrzeszona','BRAK','bez klubu','none'])assert.deepEqual(pickClub(clubs,member,{name:n},NOW),{clubId:UNAFFILIATED},n);
 const a=pickClub(clubs,member,{name:'Тигр Київ'},NOW),b=pickClub([...clubs,a.newClub],member,{name:'Дракон Львів'},NOW);
 assert.ok(a.newClub&&b.newClub&&a.newClub.id!==b.newClub.id,'different Cyrillic names are different clubs');assert.equal(a.newClub.verified,false);
 assert.deepEqual(pickClub([...clubs,a.newClub],member,{name:'тигр київ'},NOW),{clubId:a.newClub.id});
 assert.deepEqual(pickClub(clubs,member,{name:'Nowy'},NOW,{user:CLUBS_DAY_PER_USER,global:0}),{clubId:UNAFFILIATED,pendingClubName:'Nowy',notice:'club-pending'});
 // Through profile.save: the fourth new club of an organizer in one day becomes a pending name, adopted later by the Administrator.
 let db=world();for(const n of ['Klub A','Klub B','Klub C','Klub D'])db=run(db,'org1','profile.save',{...A,name:'Zawodnik '+n,club:{name:n}}).db;
 const last=db.profiles.at(-1);assert.deepEqual([last.clubId,last.pendingClubName],[UNAFFILIATED,'Klub D']);
 db=run(db,'demo-admin','club.adopt',{name:'Klub D',profileIds:[last.id]}).db;
 const adopted=db.profiles.find(p=>p.id===last.id),club=db.clubs.find(c=>c.id===adopted.clubId);
 assert.deepEqual([club.name,club.verified,'pendingClubName' in adopted],['Klub D',true,false]);
});

test('self-entry corrected by the manager keeps name, age, sex and profile; the club may change (D3)',()=>{
 let db=world();
 const {db:d,ids}=seq(db,[['ath','athlete.save',{...A,relation:'self',name:'Ewa Weryfikowana',sex:'F',club:{name:'Klub Niepewny'}}],['org2','tournament.save',{...T,name:'T',date:day(20),status:'open'}]]);db=d;const [p,t]=ids;
 db=run(db,'ath','entry.self',{tournamentId:t,profileId:p,events:['forms']}).db;
 db=run(db,'org2','entry.save',{tournamentId:t,profileId:p,update:true,name:'Inna',age:40,sex:'M',events:['forms','special'],weight:69,height:170,gradeType:'cup',grade:4,champion:true,clubId:'club-4'}).db;
 const e=db.tournaments.find(x=>x.id===t).entries[0];
 assert.deepEqual([e.name,e.sex,e.self,e.champion,e.clubId,e.club,e.weight,e.events],['Ewa Weryfikowana','F',true,false,'club-4','Dragon Poznań',69,['forms','special']]);
 assert.equal(db.tournaments.find(x=>x.id===t).activity[0].text,'Zmieniono klub w zgłoszeniu: Ewa Weryfikowana');
 assert.equal(code(()=>run(db,'org2','entry.save',{...E,tournamentId:t,profileId:p,update:true,clubId:'missing'})),404);
 assert.equal(code(()=>run(db,'org2','entry.save',{...E,tournamentId:t,profileId:p})),409,'without update');
 assert.equal(code(()=>run(db,'org1','entry.save',{...E,tournamentId:t,profileId:p,update:true})),404,'not the manager: not his profile');
});

test('tournament.hide: reason, hiddenFrom, the organizer loses self-entries, withdrawSelf tombstones, restore (also finished)',()=>{
 let db=world();
 const {db:d,ids}=seq(db,[['ath','athlete.save',{...A,relation:'self',name:'Ewa Ukryta',sex:'F',club:{none:true}}],['org1','tournament.save',{...T,name:'Podejrzany',date:day(20),status:'open'}],['org1','profile.save',{...A,name:'Własny Organizatora',clubId:'club-1'}]]);
 db=d;const [p,t,own]=ids;db=run(db,'ath','entry.self',{tournamentId:t,profileId:p,events:['forms']}).db;db=run(db,'org1','entry.save',{...E,tournamentId:t,profileId:own}).db;
 assert.equal(code(()=>run(db,'org1','tournament.hide',{tournamentId:t,hidden:true})),403);
 db=run(db,'demo-admin','tournament.hide',{tournamentId:t,hidden:true,reason:' Spam ‮reklam '}).db;let x=db.tournaments.find(y=>y.id===t);
 assert.deepEqual([x.status,x.hiddenFrom,x.hiddenBy,x.hideReason,x.activity[0].text],['draft','open','demo-admin','Spam reklam','Administrator ukrył turniej.']);
 const v=view(db,'org1').tournaments.find(y=>y.id===t);assert.deepEqual([v.hidden,v.hideReason,v.entries.map(e=>e.profileId),v.activity],[true,'Spam reklam',[own],[]],'self-entries and the log are gone for the organizer (PS-16)');
 assert.ok(!JSON.stringify(view(db,'org1')).includes('Ewa Ukryta'));
 assert.equal(code(()=>run(db,'org1','tournament.save',{...T,id:t,name:'Podejrzany',date:day(20),status:'open'})),409);
 assert.equal(code(()=>run(db,'demo-admin','tournament.hide',{tournamentId:t,hidden:true,reason:'x'.repeat(201)})),422);
 db=run(db,'demo-admin','tournament.hide',{tournamentId:t,hidden:true,withdrawSelf:true}).db;x=db.tournaments.find(y=>y.id===t);
 assert.deepEqual([x.entries.map(e=>e.profileId),db.withdrawals.map(w=>[w.profileId,w.by]),x.hideReason],[[own],[[p,'admin']],null]);
 db=run(db,'demo-admin','tournament.hide',{tournamentId:t,hidden:false}).db;x=db.tournaments.find(y=>y.id===t);
 assert.deepEqual([x.status,x.hiddenBy,x.hiddenFrom,x.hideReason,x.activity[0].text],['open',null,null,null,'Administrator przywrócił turniej.']);
 const fin=structuredClone(db);Object.assign(fin.tournaments.find(y=>y.id===t),{status:'finished'});
 const back=run(run(fin,'demo-admin','tournament.hide',{tournamentId:t,hidden:true}).db,'demo-admin','tournament.hide',{tournamentId:t,hidden:false}).db;
 assert.equal(back.tournaments.find(y=>y.id===t).status,'finished','hiddenFrom restores finished');
});

test('profile.forget and athlete.forget always finish: brackets with results keep an anonymised profile and initials (DR-2, DR-3)',()=>{
 let db=world();
 const names=['Anna Kowalska','Beata Nowak','Celina Wiśniewska','Dorota Zielińska'];const ids=[];
 db=run(db,'org2','tournament.save',{...T,name:'Z wynikami',date:day(20),status:'open'}).db;const t=db.tournaments.at(-1).id;
 for(const [i,n] of names.entries()){db=run(db,'org2','profile.save',{...A,name:n,sex:'F',clubId:'club-'+(i+1)}).db;ids.push(db.profiles.at(-1).id);db=run(db,'org2','entry.save',{...E,tournamentId:t,profileId:ids[i]}).db;}
 db=run(db,'org2','profile.save',{...A,name:'Ewa Bez Drabinki',sex:'F',clubId:'club-5',events:['special']}).db;const free=db.profiles.at(-1).id;
 db=run(db,'org2','entry.save',{...E,events:['special'],tournamentId:t,profileId:free}).db;
 const cat=classify({age:30,sex:'F',gradeType:'cup',grade:5,weight:70,height:175},'forms').id;db=run(db,'org2','draw.create',{tournamentId:t,categoryId:cat}).db;
 const m=resolveDraw(db.tournaments.find(x=>x.id===t).draws[cat]).flat().find(x=>x.ready);
 db=run(db,'org2','result.save',{tournamentId:t,categoryId:cat,matchId:m.id,winnerId:m.a}).db;
 const victim=m.a;const out=run(db,'org2','profile.forget',{id:victim});assert.equal(out.result.state,'anonymized');db=out.db;
 const a=db.profiles.find(p=>p.id===victim),e=db.tournaments.find(x=>x.id===t).entries.find(x=>x.profileId===victim);
 assert.deepEqual([a.name,a.birthDate,a.ownerId,a.archived,a.relation],[DELETED,null,null,true,null]);assert.match(e.name,/^\p{Lu}\. \p{Lu}\.$/u);
 assert.ok(db.tournaments.find(x=>x.id===t).draws[cat],'the bracket with a result stays');
 const json=JSON.stringify(db.tournaments.find(x=>x.id===t));const full=names[ids.indexOf(victim)];assert.ok(!json.includes(full),'the name left the log too: '+full);
 const gone=run(db,'org2','profile.forget',{id:free});assert.equal(gone.result.state,'deleted');assert.ok(!gone.db.profiles.some(p=>p.id===free));
 assert.ok(!gone.db.tournaments.find(x=>x.id===t).entries.some(x=>x.profileId===free));
 // A finished tournament keeps history: the organizer cannot forget, the Administrator can (anonymised).
 const fin=structuredClone(db);fin.tournaments.find(x=>x.id===t).status='finished';const other=ids.find(i=>i!==victim);
 assert.deepEqual(err(()=>run(fin,'org2','profile.forget',{id:other})),[409,'Zawodnik ma zgłoszenia w zakończonych turniejach. Usunięcie danych może zlecić Administrator.']);
 assert.equal(run(fin,'demo-admin','profile.forget',{id:other}).result.state,'anonymized');
 assert.equal(code(()=>run(db,'org1','profile.forget',{id:other})),404,'not his profile');
 // athlete.forget: owner only; a profile without entries is deleted.
 let w=world();w=run(w,'ath','athlete.save',{...A,relation:'self',name:'Do Usunięcia',club:{none:true}}).db;const mine=w.profiles.at(-1).id;
 assert.equal(code(()=>run(w,'mem','athlete.forget',{profileId:mine})),404);assert.equal(run(w,'ath','athlete.forget',{profileId:mine}).result.state,'deleted');
});

test('profile.forget: the logs of every tournament lose every name of the profile, an earlier one and one of a withdrawn entry too (§6.6)',()=>{
 let db=world();
 db=seq(db,[['org2','tournament.save',{...T,name:'Dziennik Jeden',date:day(20),status:'open'}],['org2','tournament.save',{...T,name:'Dziennik Dwa',date:day(21),status:'open'}]]).db;const [t1,t2]=db.tournaments.slice(-2).map(t=>t.id);
 db=run(db,'org2','profile.save',{...A,name:'Ala Stara',club:{none:true}}).db;const a=db.profiles.at(-1).id;
 db=seq(db,[['org2','entry.save',{...E,tournamentId:t1,profileId:a}],['org2','entry.save',{...E,tournamentId:t2,profileId:a}],['org2','profile.save',{...A,id:a,name:'Ala Nowa',club:{id:UNAFFILIATED}}],
  ['org2','checkin.save',{tournamentId:t2,id:a,presence:'present',actualWeight:70}],['demo-admin','entry.remove',{tournamentId:t1,id:a}]]).db;
 const text=()=>JSON.stringify(db.tournaments.filter(t=>t.id===t1||t.id===t2));
 assert.ok(text().includes('Wycofano zgłoszenie: Ala Stara')&&text().includes('Kontrola startowa: Ala Stara'),'the snapshot of t2 keeps the old name, t1 has no entry left');
 db=run(db,'org2','profile.forget',{id:a}).db;
 assert.ok(!/Ala (Stara|Nowa)/.test(text()),text());assert.ok(db.tournaments.find(t=>t.id===t1).activity.some(x=>x.text==='Wycofano zgłoszenie: A. S.'));
});

test('profile.save: a member without the organizer role or with a blocked one creates nothing; club.merge into unaffiliated only without staff accounts',()=>{
 const db=world();
 for(const id of ['mem','ath','org3'])assert.deepEqual(err(()=>run(db,id,'profile.save',{...A,name:'Bez Roli',club:{name:'Klub Bez Roli'}})),[403,'Brak uprawnień.'],id);
 let w=run(db,'org1','profile.save',{...A,name:'Bez Klubu Naprawdę',club:{name:'Nie Mam Klubu'}}).db;const p=w.profiles.at(-1),c=w.clubs.find(x=>x.id===p.clubId);
 assert.deepEqual(err(()=>run(w,'demo-admin','club.merge',{id:'club-1',into:UNAFFILIATED})),[409,'Ten klub ma konta personelu. Przypisz je do innego klubu przed scaleniem z „Niezrzeszony”.']);
 w=run(w,'demo-admin','club.merge',{id:c.id,into:UNAFFILIATED}).db;
 assert.deepEqual([w.profiles.find(x=>x.id===p.id).clubId,w.clubs.find(x=>x.id===c.id).mergedInto],[UNAFFILIATED,UNAFFILIATED]);
 assert.equal(pickClub(w.clubs,w.users.find(u=>u.id==='org1'),{name:'nie mam klubu'},NOW).clubId,UNAFFILIATED,'the name now leads to unaffiliated');
 assert.ok(w.users.filter(u=>['admin','editor','club'].includes(u.role)).every(u=>u.clubId!==UNAFFILIATED));
});

test('clubs: verify, rename with the key check, merge re-points profiles and staff, unaffiliated is fixed',()=>{
 let db=world();db=run(db,'org1','profile.save',{...A,name:'Z Nowego',club:{name:'Nowy Klubik'}}).db;const p=db.profiles.at(-1),c=db.clubs.find(x=>x.id===p.clubId);
 assert.equal(code(()=>run(db,'org1','club.save',{id:c.id,verified:true})),403);
 assert.deepEqual(err(()=>run(db,'demo-admin','club.save',{id:c.id,name:'tkd  WARSZAWA'})),[409,'Klub o takiej nazwie już istnieje. Użyj scalania.']);
 assert.deepEqual(err(()=>run(db,'demo-admin','club.save',{id:UNAFFILIATED,name:'Inny'})),[409,'Tego klubu nie można zmienić.']);
 db=run(db,'demo-admin','club.save',{id:c.id,name:'Nowy Klubik Sprawdzony',verified:true}).db;assert.deepEqual(db.clubs.find(x=>x.id===c.id).verified,true);
 const before=db.users.find(u=>u.id==='demo-club').authVersion;
 db=run(db,'demo-admin','club.merge',{id:'club-1',into:c.id}).db;
 assert.ok(db.profiles.filter(x=>x.createdBy==='demo-admin'&&x.clubId==='club-1').length===0);assert.equal(db.users.find(u=>u.id==='demo-club').clubId,c.id);
 assert.equal(db.users.find(u=>u.id==='demo-club').authVersion,before+1,'staff of the merged club sign in again');
 assert.equal(db.clubs.find(x=>x.id==='club-1').mergedInto,c.id);assert.equal(db.tournaments[0].entries.find(e=>e.clubId==='club-1').club,'TKD Warszawa','snapshots keep the old name (PS-10)');
 assert.equal(code(()=>run(db,'demo-admin','club.merge',{id:'club-1',into:'club-2'})),409,'already merged');
 assert.equal(code(()=>run(db,'demo-admin','account.save',{id:'demo-editor',email:'editor@matdraw.example',role:'editor',clubId:'club-1'})),422,'merged clubs cannot be chosen');
 // Guest bracket: the current name of a verified club, null for unverified, '' for unaffiliated.
 const g=guestTournaments(db)[0];assert.equal(g.entries.find(e=>e.clubId==='club-1').currentClub.name,'Nowy Klubik Sprawdzony');
});

test('stale(): another tournament changed keeps the command fresh; the same tournament or staff change makes it stale (§5.8)',()=>{
 let db=world();const r0=db.revision;
 db=run(db,'org1','tournament.save',{...T,name:'Pętla organizatora',date:day(20),status:'open'}).db;
 for(let i=0;i<3;i++)db=run(db,'org1','tournament.save',{...T,id:db.tournaments.at(-1).id,name:'Pętla '+i,date:day(20),status:'open'}).db;
 assert.equal(code(()=>run(db,'demo-admin','checkin.save',{tournamentId:'t-autumn-2026',id:'a1',presence:'present',actualWeight:65},r0)),200,'R15: the hall table is not invalidated');
 assert.equal(code(()=>run(db,'demo-admin','tournament.save',{...T,id:db.tournaments.at(-1).id,name:'X',date:day(20),status:'open'},r0)),409);
 assert.equal(code(()=>run(db,'demo-admin','profile.save',{...A,name:'Nowy',clubId:'club-1'},r0)),200,'creation: staff unchanged');
 db=run(db,'demo-admin','account.save',{id:'demo-editor',email:'editor@matdraw.example',role:'editor',clubId:'club-2'}).db;
 assert.equal(code(()=>run(db,'demo-admin','profile.save',{...A,name:'Nowy',clubId:'club-1'},r0)),409,'staff changed');
 assert.equal(stale(db,'entry.self',{},db.revision-1),true);assert.equal(stale(db,'entry.self',{},db.revision),false);
 // Stamps: changed tournaments and profiles get the new revision, new clubs do not touch staffRev, renamed ones do.
 let s=world();s=run(s,'org1','profile.save',{...A,name:'Stempel',club:{name:'Klub Stempla'}}).db;
 assert.deepEqual([s.profiles.at(-1).rev,s.staffRev,s.revision],[2,1,2]);
 s=run(s,'demo-admin','club.save',{id:s.clubs.at(-1).id,verified:true}).db;assert.deepEqual([s.staffRev,s.revision],[3,3]);
 assert.ok(s.tournaments.every(t=>!t.rev),'untouched tournaments keep no stamp');
});

test('guest projection of community tournaments: sparse fields, home list without unconfirmed ones, bracket clubs (§5.6)',()=>{
 let db=world();db=seq(db,[['org1','tournament.save',{...T,name:'Niepotwierdzony publiczny',date:day(3),status:'open'}],['org2','tournament.save',{...T,name:'Potwierdzony publiczny',date:day(4),status:'open'}]]).db;
 const list=guestTournaments(db),today=day(0),up=guestUpcoming(list,today,20).tournaments;
 assert.ok(!up.some(t=>t.name==='Niepotwierdzony publiczny'));const conf=up.find(t=>t.name==='Potwierdzony publiczny');
 assert.deepEqual(Object.keys(conf).sort(),['city','community','date','id','name','status','trusted']);assert.equal(conf.trusted,true);
 for(const t of up.filter(t=>t.name!=='Potwierdzony publiczny'))assert.deepEqual(Object.keys(t).sort(),['city','date','id','name','status'],'staff tournaments keep five fields');
 const hidden=list.find(t=>t.name==='Niepotwierdzony publiczny');const v=guestTournament(list,hidden.id,today);
 assert.deepEqual([v.tournament.community,v.tournament.trusted],[true,false],'public under its own address');
 assert.deepEqual(guestUpcoming(guestTournaments({...db,flags:{trustRequired:false}}),today,20).tournaments.filter(t=>t.community).length,2,'trustRequired=false lists every organizer not blocked');
 void makeDraw;void staffProfile;void managesProfile;
});
