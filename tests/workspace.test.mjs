import test from 'node:test';
import assert from 'node:assert/strict';
import {initialWorkspace,execute,publicWorkspace,ageAt} from '../dist/workspace.js';
const seed=()=>initialWorkspace();
const run=(db,user,type,p,rev=db.revision)=>execute(db,user,type,p,rev);
const data={name:'Zawodnik Testowy',clubId:'club-1',sex:'M',birthDate:'2010-02-01',weight:58,height:172,gradeType:'cup',grade:6,events:['forms'],champion:false};
const register=(db,profileId,tournamentId,user='demo-club')=>run(db,user,'entry.save',{...data,profileId,tournamentId});
test('one profile can enter many tournaments; age and check-in are isolated',()=>{
 let {db,result}=run(seed(),'demo-club','profile.save',data);const id=result.id;
 db=register(db,id,'t-autumn-2026').db;db=register(db,id,'t-winter-2027').db;
 assert.equal(db.tournaments[0].entries.at(-1).age,16);assert.equal(db.tournaments[1].entries[0].age,17);
 db=run(db,'demo-admin','checkin.save',{tournamentId:'t-autumn-2026',id,presence:'present',actualWeight:59}).db;
 assert.equal(db.tournaments[0].entries.at(-1).actualWeight,59);assert.equal(db.tournaments[1].entries[0].actualWeight,null);
 db=run(db,'demo-club','profile.save',{...data,id,name:'Nowe nazwisko',weight:61}).db;
 assert.equal(db.tournaments[0].entries.at(-1).name,data.name);assert.equal(db.tournaments[1].entries[0].weight,58);
 assert.throws(()=>register(db,id,'t-winter-2027'),e=>e.status===409);
});
test('club cannot escalate privileges, access foreign profiles, results or create tournaments',()=>{
 const db=seed(),foreign=db.profiles.find(p=>p.clubId!=='club-1');
 const cases=[['account.save',{role:'admin'}],['tournament.save',{}],['profile.save',{...data,id:foreign.id}],['entry.save',{...data,profileId:foreign.id,tournamentId:'t-winter-2027'}],['draw.create',{tournamentId:'t-autumn-2026',categoryId:'x'}],['checkin.save',{tournamentId:'t-autumn-2026',id:foreign.id}]];
 for(const [type,p]of cases)assert.throws(()=>run(db,'demo-club',type,p),e=>e.status===403,type);
 const view=publicWorkspace(db,db.users.find(u=>u.id==='demo-club'));
 assert.equal(view.users.length,0);assert.ok(view.profiles.every(p=>p.clubId==='club-1'));assert.ok(view.tournaments.every(t=>t.entries.every(e=>e.clubId==='club-1')));
 assert.ok(!JSON.stringify(view).includes('authVersion'));
});
test('editor owns new tournaments and profiles, cannot edit other organizer or users',()=>{
 const original=seed();assert.throws(()=>run(original,'demo-editor','tournament.save',{...original.tournaments[0]}),e=>e.status===403);
 const {db,result}=run(original,'demo-editor','tournament.save',{name:'Nowy turniej',city:'Łódź',date:'2027-05-10',mat:'Mata 1',status:'open'});
 assert.equal(db.tournaments.at(-1).createdBy,'demo-editor');assert.ok(result.id);
 assert.throws(()=>run(db,'demo-editor','account.save',{}),e=>e.status===403);
});
test('closed and finished registration, date locks, revision conflicts and last administrator',()=>{
 let db=seed();db.tournaments[1].status='closed';assert.throws(()=>register(db,db.profiles[0].id,'t-winter-2027'),e=>e.status===403);
 db.tournaments[0].status='finished';assert.throws(()=>run(db,'demo-admin','checkin.save',{tournamentId:db.tournaments[0].id}),e=>e.status===409);
 assert.throws(()=>run(db,'demo-admin','tournament.save',{...db.tournaments[0],date:'2027-01-01'}),e=>e.status===409);
 assert.throws(()=>run(db,'demo-admin','profile.save',data,db.revision-1),e=>e.status===409);
 assert.throws(()=>run(db,'demo-admin','account.save',{id:'demo-admin',email:'admin@matdraw.example',clubId:'club-1',role:'editor',active:true}),e=>e.status===409);
});
test('combined creation and registration rolls back on invalid event; club is server-derived',()=>{
 const db=seed(),count=db.profiles.length;
 assert.throws(()=>run(db,'demo-club','profile.save',{...data,registration:{...data,tournamentId:'t-winter-2027',events:['soft']}}));
 assert.equal(db.profiles.length,count);
 const out=run(db,'demo-club','profile.save',{...data,clubId:'club-2'});assert.equal(out.db.profiles.at(-1).clubId,'club-1');
 assert.throws(()=>run(db,'demo-club','profile.save',{...data,events:['invented']}));
 assert.equal(ageAt('2010-11-15','2026-11-14'),15);assert.equal(ageAt('2010-11-15','2026-11-15'),16);
});

// Public guest projection (login screen list and read-only preview) – dist/guest-view.js mirrors backend/src/GuestView.php.
import {guestUpcoming,guestTournament,initials,warsawToday,UPCOMING_LIMIT} from '../dist/guest-view.js';
import {categories,resolveDraw} from '../dist/engine.js';
const TODAY='2026-10-31';
const tour=(id,date,status,name=id)=>({id,name,city:'Miasto',date,status,mat:'Mata 2',createdBy:'demo-admin',entries:[],draws:{},activity:[{text:'Utworzono turniej.',time:'2026-10-01T10:00:00Z'}]});
/** Demo workspace with every possible bracket drawn and some results, i.e. the richest public preview. */
function drawnWorkspace(){
 let db=seed();const t=db.tournaments[0];
 for(const c of categories(t.entries).items.filter(c=>c.type==='bracket'&&!c.underfilled))db=run(db,'demo-admin','draw.create',{tournamentId:t.id,categoryId:c.id}).db;
 for(const key of Object.keys(db.tournaments[0].draws))for(let i=0;i<3;i++){const m=resolveDraw(db.tournaments[0].draws[key]).flat().find(m=>m.ready);if(!m)break;db=run(db,'demo-admin','result.save',{tournamentId:t.id,categoryId:key,matchId:m.id,winnerId:m.b}).db;}
 return db;
}
const FORBIDDEN=['birthDate','legacyAge','"age"','weight','height','"grade"','presence','champion','email','password','authVersion','clubId','profileId','createdBy','"mat"','activity','revision','signature','seed','createdAt','users','profiles'];
const wordIn=(text,word)=>new RegExp('(^|[^\\p{L}])'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^\\p{L}]|$)','u').test(text);
function assertNoPersonalData(json,entries){
 for(const field of FORBIDDEN)assert.ok(!json.includes(field),'public data contains '+field);
 for(const e of entries){assert.ok(!json.includes(e.name),'full name in public data: '+e.name);for(const part of e.name.split(/\s+/))if(part.length>2)assert.ok(!wordIn(json,part),'name part in public data: '+part);}
}
test('public list: only published tournaments dated today or later, nearest first, at most 6, five fields each',()=>{
 const list=[tour('past','2026-10-30','open'),tour('today','2026-10-31','finished'),tour('draft','2026-11-01','draft'),tour('b','2026-11-02','closed','B'),tour('a','2026-11-02','open','A'),tour('odd','2026-11-02','archived'),...[3,4,5,6,7].map(d=>tour('later'+d,'2026-12-0'+d,'open'))];
 const out=guestUpcoming(list,TODAY);
 assert.equal(UPCOMING_LIMIT,6);assert.deepEqual(Object.keys(out),['tournaments']);
 assert.deepEqual(out.tournaments.map(t=>t.id),['today','a','b','later3','later4','later5']);
 for(const t of out.tournaments)assert.deepEqual(Object.keys(t).sort(),['city','date','id','name','status']);
 assert.deepEqual(guestUpcoming(seed().tournaments,TODAY).tournaments.map(t=>t.id),['t-autumn-2026','t-gp-gdansk-2026','t-winter-2027'],'demo: the draft is never listed');
 assert.deepEqual(guestUpcoming(list,'2027-01-01').tournaments,[]);
});
test('guest preview: allowed fields only, athletes reduced to initials and club, drafts and past dates unavailable',()=>{
 const db=drawnWorkspace(),t=db.tournaments[0],view=guestTournament(db.tournaments,t.id,TODAY);
 assert.deepEqual(Object.keys(view).sort(),['categories','summary','tournament']);
 assert.deepEqual(view.tournament,{id:t.id,name:t.name,date:t.date,city:t.city,status:t.status});
 assert.deepEqual(view.summary,{entries:35,clubs:6,categories:8,brackets:4});
 const codes=categories(t.entries).items.map(c=>c.code);assert.deepEqual(view.categories.map(c=>c.code),codes,'same codes as the signed-in view');
 for(const c of view.categories){
  assert.deepEqual(Object.keys(c).sort(),['athletes','bracket','code','event','gradeType','state','subtitle','title','type']);
  assert.ok(['finished','progress','drawn','pending','underfilled','list'].includes(c.state),c.state);
  if(!c.bracket)continue;
  assert.deepEqual(Object.keys(c.bracket).sort(),['results','size','slots']);
  const filled=c.bracket.slots.filter(Boolean);assert.equal(filled.length,c.athletes);
  for(const s of filled){assert.deepEqual(Object.keys(s).sort(),['club','initials']);assert.match(s.initials,/^\p{Lu}\.( \p{Lu}\.(-\p{Lu}\.)*)?$/u);}
  for(const [match,slot] of Object.entries(c.bracket.results)){assert.match(match,/^\d+-\d+$/);assert.ok(Number.isInteger(slot)&&c.bracket.slots[slot],match);}
 }
 assert.ok(view.categories.some(c=>c.state==='progress'||c.state==='finished'),'results are reflected');
 assertNoPersonalData(JSON.stringify(view),t.entries);
 assert.equal(guestTournament(db.tournaments,'t-spring-2027',TODAY),null,'draft');
 assert.equal(guestTournament(db.tournaments,t.id,'2026-11-15'),null,'past');
 assert.equal(guestTournament(db.tournaments,'missing',TODAY),null);
 const empty=guestTournament(db.tournaments,'t-winter-2027',TODAY);assert.deepEqual(empty.categories,[]);assert.deepEqual(empty.summary,{entries:0,clubs:0,categories:0,brackets:0});
});
test('initials: first given name and last surname, diacritics kept, hyphenated surnames, no other text',()=>{
 const cases={'Jan Kowalski':'J. K.','Łukasz Żak':'Ł. Ż.','anna maria kowalska-nowak':'A. K.-N.','  Zofia   Wróbel ':'Z. W.','Jean-Luc Picard':'J. P.','Madonna':'M.','(Ola) Nowak':'O. N.',"Zoë D'Arcy":'Z. D.','Ewa Lis':'E. L.','':'?','123':'?'};
 for(const [name,expected] of Object.entries(cases))assert.equal(initials(name),expected,name);
 assert.equal(initials('Émile Zola'),'É. Z.','combining accents are composed');
});
test('Warsaw date for the public cut-off, across midnight and daylight saving time',()=>{
 assert.equal(warsawToday(new Date('2026-10-31T22:30:00Z')),'2026-10-31');
 assert.equal(warsawToday(new Date('2026-10-31T23:30:00Z')),'2026-11-01');
 assert.equal(warsawToday(new Date('2026-07-01T22:30:00Z')),'2026-07-02');
});

// Roles plan (PLAN-REJESTRACJA-ROLE §5.8, §10.7): revision stamps and the demo workspace.
import {guestTournaments,stale} from '../dist/workspace.js';
test('initialWorkspace: unaffiliated club, verified clubs, staffRev, demo organizer and athlete accounts, self-entries in t-winter-2027 only',()=>{
 const db=seed();
 assert.equal(db.staffRev,1);assert.equal(db.revision,1);
 assert.deepEqual(db.clubs.at(-1),{id:'unaffiliated',name:'Niezrzeszony',verified:true});assert.ok(db.clubs.every(c=>c.verified===true));
 assert.deepEqual(db.tournaments.map(t=>[t.id,t.selfEntry]),[['t-autumn-2026',false],['t-winter-2027',true],['t-gp-gdansk-2026',false],['t-spring-2027',false]]);
 const org=db.users.find(u=>u.id==='demo-organizer'),ath=db.users.find(u=>u.id==='demo-athlete');
 assert.deepEqual([org.role,org.organizer,org.organizerTrustedAt,ath.role,ath.organizer],['member',true,null,'member',false]);
 const kid=db.profiles.find(p=>p.ownerId==='demo-athlete');assert.equal(db.profiles.filter(p=>p.ownerId==='demo-athlete').length,1,'one athlete profile per account (§17)');
 assert.deepEqual([kid.relation,kid.createdBy,ageAt(kid.birthDate,'2026-11-01'),db.tournaments.some(t=>t.entries.some(e=>e.profileId===kid.id))],['guardian','demo-athlete',14,false]);
 // The staff views are unchanged by the demo members: no member account, no owned profile outside the Admin view.
 const admin=publicWorkspace(db,db.users[0]);assert.deepEqual(admin.users.map(u=>u.id),['demo-admin','demo-editor','demo-club']);
 assert.ok(!publicWorkspace(db,db.users[1]).profiles.some(p=>p.id===kid.id));assert.ok(admin.profiles.some(p=>p.id===kid.id));
 assert.deepEqual(publicWorkspace(db,ath).profiles,[],'a member without the organizer role has the empty workspace');
});
test('revision stamps: changed tournaments and profiles get the new revision, staffRev follows staff accounts and existing clubs',()=>{
 let db=seed();
 db=run(db,'demo-admin','checkin.save',{tournamentId:'t-autumn-2026',id:'a1',presence:'present',actualWeight:65}).db;
 assert.deepEqual([db.revision,db.tournaments[0].rev,db.tournaments[1].rev,db.staffRev],[2,2,undefined,1]);
 const profileOut=run(db,'demo-club','profile.save',data);db=profileOut.db;
 assert.deepEqual([db.revision,db.profiles.find(p=>p.id===profileOut.result.id).rev,db.staffRev],[3,3,1],'a new profile is stamped, staff unchanged');
 db=run(db,'demo-admin','account.save',{id:'demo-editor',email:'editor@matdraw.example',role:'editor',clubId:'club-2'}).db;assert.deepEqual([db.revision,db.staffRev],[4,4]);
 db=run(db,'demo-admin','account.save',{email:'nowy@matdraw.example',role:'club',clubName:'Nowy Klub Demo'}).db;
 assert.deepEqual([db.revision,db.staffRev],[5,5],'a new staff account is a staff change; its new club alone would not be');
 // The stale table: an old revision is fine for an untouched tournament, refused for a changed one.
 assert.equal(stale(db,'checkin.save',{tournamentId:'t-winter-2027'},1),false);assert.equal(stale(db,'checkin.save',{tournamentId:'t-autumn-2026'},1),true);
 assert.throws(()=>run(db,'demo-admin','checkin.save',{tournamentId:'t-winter-2027',id:'x',presence:'pending'},1),e=>e.status===404,'not stale: the 404 of the missing entry follows');
 assert.throws(()=>run(db,'demo-admin','checkin.save',{tournamentId:'t-autumn-2026',id:'a1',presence:'pending'},1),e=>e.status===409);
});
test('guestTournaments: community flags and the current club of every entry, as Repository::guestTournaments',()=>{
 const db=seed();db.clubs.push({id:'c-new',name:'Nowy',verified:false},{id:'c-old',name:'Stary',verified:true,mergedInto:'club-2'});
 db.tournaments[0].entries[0].clubId='c-new';db.tournaments[0].entries[1].clubId='c-old';db.tournaments[0].entries[2].clubId='unaffiliated';
 const [t]=guestTournaments(db);assert.deepEqual([t.community,t.trusted],[false,true]);
 assert.deepEqual(t.entries.slice(0,4).map(e=>e.currentClub),[{id:'c-new',name:null},{id:'club-2',name:'KS Tiger Kraków'},{id:'unaffiliated',name:''},{id:t.entries[3].clubId,name:db.clubs.find(c=>c.id===t.entries[3].clubId).name}]);
 assert.equal(db.tournaments[0].entries[0].currentClub,undefined,'the workspace is not changed');
});

// ---- Wave 2 (organizer-frontend, §10.4, §10.7, DR-14): a demo stored by an earlier release is upgraded in place ----
class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
/** The demo as the release before PLAN-REJESTRACJA-ROLE stored it: no "Niezrzeszony", no verified/selfEntry/rev/staffRev, no members. */
function preRelease(db){
 const old=structuredClone(db);delete old.staffRev;delete old.flags;
 old.clubs=old.clubs.filter(c=>c.id!=='unaffiliated').map(({verified,...c})=>c);
 old.tournaments=old.tournaments.map(({selfEntry,rev,...t})=>t);
 old.users=old.users.filter(u=>u.role!=='member').map(({organizer,organizerBlockedAt,organizerTrustedAt,...u})=>u);
 old.profiles=old.profiles.filter(p=>!p.ownerId);return old;
}
test('upgradeDemo: a pre-release stored demo gets the new fields, the flags of full automation and the community accounts; a second run changes nothing',async()=>{
 globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
 const {upgradeDemo}=await import('../dist/client.js');
 const old=preRelease(seed());
 assert.equal(upgradeDemo(old),true);
 assert.ok(old.clubs.some(c=>c.id==='unaffiliated'&&c.verified===true),'the "Niezrzeszony" club');assert.ok(old.clubs.every(c=>c.verified===true));
 assert.ok(old.tournaments.every(t=>t.selfEntry===false&&t.rev===0),'existing tournaments: no self-entries (R11), rev 0');
 assert.equal(old.staffRev,old.revision);assert.deepEqual(old.flags,{organizers:'on',trustRequired:false},'§17: organizers trusted without confirmation in the demo');
 const org=old.users.find(u=>u.id==='demo-organizer'),athlete=old.users.find(u=>u.id==='demo-athlete');
 assert.deepEqual([org.role,org.organizer,org.email,athlete.role,athlete.organizer],['member',true,'organizer@matdraw.example','member',false]);
 const own=old.profiles.filter(p=>p.ownerId==='demo-athlete');assert.equal(own.length,1,'one athlete profile per account (§17)');assert.equal(own[0].relation,'guardian');
 const once=structuredClone(old);assert.equal(upgradeDemo(old),false,'idempotent');assert.deepEqual(old,once);
 // A current demo (initialWorkspace) only gains the flags; data the person changed is kept.
 const fresh=seed();fresh.tournaments[1].selfEntry=true;fresh.clubs[0].verified=false;assert.equal(upgradeDemo(fresh),true);
 assert.deepEqual([fresh.tournaments[1].selfEntry,fresh.clubs[0].verified,fresh.users.length],[true,false,5]);assert.equal(upgradeDemo(fresh),false);
 // An account with the e-mail of a demo member already there (someone made it) is not duplicated.
 const taken=preRelease(seed());taken.users.push({id:'x1',email:'organizer@matdraw.example',role:'editor',clubId:'club-1',active:true,authVersion:1});upgradeDemo(taken);
 assert.equal(taken.users.filter(u=>u.email==='organizer@matdraw.example').length,1);
 for(const bad of [null,{},{users:[]},'x'])assert.equal(upgradeDemo(bad),false);
});
test('init() upgrades a stored pre-release demo once, keeps the staff passwords and enables the organizer and athlete demo logins',async()=>{
 globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
 const Client=await import('../dist/client.js');localStorage.clear();sessionStorage.clear();
 assert.equal(await Client.init(),null,'a new demo, nobody signed in');
 const stored=JSON.parse(localStorage.getItem(Client.dataKey)),old=preRelease(stored);
 old.tournaments[0].name='Turniej zmieniony przez osobę';localStorage.setItem(Client.dataKey,JSON.stringify(old));
 await Client.init();const upgraded=localStorage.getItem(Client.dataKey),db=JSON.parse(upgraded);
 assert.equal(db.tournaments[0].name,'Turniej zmieniony przez osobę','the person\'s data stays');
 assert.equal(db.users.find(u=>u.id==='demo-admin').passwordHash,stored.users.find(u=>u.id==='demo-admin').passwordHash,'staff passwords unchanged');
 assert.ok(db.users.filter(u=>u.role==='member').every(u=>u.passwordHash&&u.passwordSalt),'the new demo accounts have passwords');
 await Client.init();assert.equal(localStorage.getItem(Client.dataKey),upgraded,'a second start writes nothing');
 const o=await Client.login('organizer@matdraw.example','MatDrawDemo2026!');
 assert.deepEqual([o.user.role,o.user.caps.organizer,o.user.caps.athlete],['member',true,false]);
 assert.deepEqual(o.tournaments,[],'upgraded tournaments have no self-entries (R11), so an organizer sees none of the staff tournaments');
 assert.ok(!JSON.stringify(o).includes('Zuzanna'),'no other account\'s athlete');
 const created=await Client.command('tournament.save',{name:'Puchar Organizatora',city:'Opole',date:'2027-03-14',status:'open',mat:'Mata 1'},o.revision);
 const mine=created.workspace.tournaments.find(t=>t.id===created.result.id);assert.deepEqual([mine.selfEntry,mine.community,mine.trusted],[true,true,true],'trustRequired=false: trusted at once');
 const a=await Client.login('athlete@matdraw.example','MatDrawDemo2026!');
 assert.deepEqual([a.user.role,a.user.caps.organizer,a.user.caps.athlete,a.tournaments.length,a.profiles.length],['member',false,true,0,0],'an athlete has no workspace');
 assert.deepEqual(Client.demoActor('demo-athlete').athletes.map(x=>[x.name,x.relation,x.archived]),[['Zuzanna Demo','guardian',false]]);
 // The hall screen's polling: {unchanged:true} while the tournament's rev is the same.
 await Client.login('editor@matdraw.example','MatDrawDemo2026!');const ws=await Client.bootstrap(),t=ws.tournaments.find(x=>x.id==='t-winter-2027');
 assert.deepEqual(await Client.bootstrap({t:t.id,rev:t.rev}),{unchanged:true});assert.ok((await Client.bootstrap({t:t.id,rev:t.rev+1})).tournaments,'another rev: the workspace');
 assert.ok((await Client.bootstrap({t:'missing',rev:0})).tournaments);
});
