// PHP↔JS parity of the role rules (PLAN-REJESTRACJA-ROLE §12): backend/src/Domain.php, Clubs.php, Rules.php, Settings.php and
// Actors.php against dist/workspace.js, dist/engine.js and dist/profile-data.js, through tests/php-bridge-roles.php.
// Commands: the same statuses and the same normalised state for every command and actor (random ids become tokens in order of
// appearance, draw slots become sets, times are dropped); messages are equal for the new commands and paths, the old differences
// are listed in KNOWN. publicData equals publicWorkspace for every actor on a rich data set, for both values of trustRequired (§17).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {initialWorkspace,execute,publicWorkspace,stale,contact,pickClub,athleteFields,UNAFFILIATED} from '../dist/workspace.js';
import {classify,makeDraw,sameClub} from '../dist/engine.js';
import {clubKey} from '../dist/profile-data.js';
import {warsawToday} from '../dist/guest-view.js';
const php=process.env.PHP_BIN;const skip=!php;
function bridge(input){const r=spawnSync(php,['tests/php-bridge-roles.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const NOW=Math.floor(Date.now()/1000);
const day=n=>warsawToday(new Date(Date.now()+n*864e5));
const yearsAgo=(y,d=0)=>{const [Y,M,D]=day(-d).split('-').map(Number);return String(Y-y)+'-'+String(M).padStart(2,'0')+'-'+String(Math.min(D,28)).padStart(2,'0');};
// Old messages that differ between PHP and the demo (plan §12, DR-10): [PHP, JS]. No new path may add a pair.
const KNOWN=[['Możesz zgłaszać tylko własny klub.','Możesz zgłaszać tylko zawodników swojego klubu.'],['Klub może zmienić Administrator.','Klub zawodnika może zmienić Administrator.'],
 ['Nie możesz edytować tej kartoteki.','Nie możesz edytować tej kartoteki zawodnika.'],['Zawodnik jest już zgłoszony.','Ten zawodnik jest już zgłoszony do turnieju.'],['Brak uprawnień.','Brak uprawnień do archiwizacji.'],
 ['Musi pozostać aktywny Administrator.','Musi pozostać co najmniej jeden aktywny Administrator.'],['Niepoprawny status turnieju.','Niepoprawny status zapisów.'],['Podaj poprawną datę.','Podaj poprawną datę turnieju.'],
 ['Nie ma takiej kategorii.','Nie ma takiej kategorii drabinkowej.'],['Niepoprawny status.','Nieprawidłowy status obecności.'],['Zawodnik ma zapisane wyniki.','Zawodnik ma zapisane wyniki. Nie można teraz zmieniać zgłoszenia.']].map(p=>p.join(' | '));

/** Rich data set: staff, organizers (unconfirmed, confirmed, blocked), an athlete account (u-ath, own profile p-self), a parent account
 * (u-par, child profile p-kid), a second parent account without a profile yet (u-par2), a member without roles, clubs (unverified,
 * merged), staff/organizer/owned profiles and tournaments of staff and community (open with self-entries, hidden, closed with a draw).
 * One athlete profile per account (§17), so each athlete has an account of his own. */
function rich(){
 const db=initialWorkspace(),u=(id,o)=>({id,clubId:null,email:id+'@roles.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null,...o});
 db.users.push(u('u-org1',{organizer:true}),u('u-org2',{organizer:true,organizerTrustedAt:NOW-9000}),u('u-org3',{organizer:true,organizerTrustedAt:NOW-9000,organizerBlockedAt:NOW-500}),u('u-ath'),u('u-mem'),u('u-par'),u('u-par2'),
  {id:'u-club2',clubId:'club-2',email:'club2@roles.test',role:'club',active:true,authVersion:1},{id:'u-editor2',clubId:'club-1',email:'editor2@roles.test',role:'editor',active:true,authVersion:1});
 db.clubs.push({id:'club-x',name:'Klub Nowy',verified:false,createdBy:'u-org1',createdAt:NOW-100,mergedInto:null},{id:'club-m',name:'Klub Scalony',verified:true,createdBy:null,createdAt:null,mergedInto:'club-3'});
 const P=(id,o)=>({id,name:'Zawodnik '+id.slice(2).toUpperCase()+' Testowy',clubId:'club-1',sex:'M',birthDate:'2000-05-05',weight:70,height:175,gradeType:'cup',grade:5,events:['forms'],champion:false,createdBy:'demo-admin',createdAt:NOW-5000,archived:false,ownerId:null,...o});
 db.profiles.push(P('p-ed',{createdBy:'demo-editor'}),P('p-club1',{createdBy:'demo-club'}),P('p-ed2',{createdBy:'demo-editor',clubId:'club-3'}),P('p-club2',{createdBy:'u-club2',clubId:'club-2'}),P('p-o1a',{createdBy:'u-org1',clubId:'club-x'}),
  P('p-o1b',{createdBy:'u-org1',birthDate:yearsAgo(10),sex:'F',weight:35,height:140,grade:8,guardianConsentAt:NOW-4000,consentBy:'u-org1'}),P('p-o2',{createdBy:'u-org2',clubId:'club-2'}),
  P('p-o3',{createdBy:'u-org3'}),P('p-self',{createdBy:'u-ath',ownerId:'u-ath',relation:'self'}),P('p-kid',{createdBy:'u-par',ownerId:'u-par',relation:'guardian',guardianDeclaredAt:NOW-4000,birthDate:yearsAgo(12),sex:'F',weight:42,height:152,grade:7,clubId:UNAFFILIATED}));
 const byId=Object.fromEntries(db.profiles.map(p=>[p.id,p])),club=id=>db.clubs.find(c=>c.id===id).name;
 const ageOn=(b,d)=>{const x=b.split('-').map(Number),y=d.split('-').map(Number);return y[0]-x[0]-(y[1]<x[1]||y[1]===x[1]&&y[2]<x[2]?1:0);};
 const entry=(pid,t,self=false)=>{const a=byId[pid];return {id:a.id,profileId:a.id,clubId:a.clubId,name:a.name,club:club(a.clubId),sex:a.sex,age:ageOn(a.birthDate,t.date),weight:a.weight,height:a.height,gradeType:a.gradeType,grade:a.grade,events:['forms'],champion:false,presence:'pending',actualWeight:null,...(self?{self:true}:{})};};
 const T=(id,createdBy,status,date,o={})=>({id,name:'Turniej '+id,city:'Opole',date,mat:'Mata 1',status,createdBy,createdAt:NOW-200000,selfEntry:true,entries:[],draws:{},activity:[],...o});
 const t1=T('t-staff-self','demo-editor','open',day(30)),t2=T('t-org1','u-org1','open',day(40)),t3=T('t-org2','u-org2','open',day(50)),t4=T('t-org1-hidden','u-org1','draft',day(60),{hiddenBy:'demo-admin',hiddenFrom:'open',hideReason:'Spam'}),
  t5=T('t-org2-closed','u-org2','closed',day(20)),t6=T('t-org3','u-org3','open',day(45));
 t1.entries=[entry('p-ed',t1),entry('p-o1a',t1),entry('p-club2',t1),entry('p-self',t1,true)];
 t2.entries=[entry('p-o1a',t2),entry('p-o1b',t2),entry('p-self',t2,true)];
 t3.entries=[entry('p-o2',t3),entry('p-ed',t3),entry('p-club2',t3),entry('p-kid',t3,true)];
 t4.entries=[entry('p-o1a',t4),entry('p-self',t4,true)];
 t5.entries=[entry('p-o2',t5),entry('p-ed2',t5),entry('p-self',t5,true)];t6.entries=[entry('p-o3',t6)];
 // Saved draws: the senior category of t-staff-self (4 athletes, no results) and of t-org2-closed (one result).
 for(const t of [t1,t5]){const key=classify(t.entries[0],'forms').id,d=makeDraw(t.entries,7);d.seed=null;t.draws[key]=d;}
 const d5=Object.values(t5.draws)[0];d5.slots=['p-o2','p-ed2',null,null,'p-self',null,null,null];d5.results={'0-0':'p-o2'};
 db.tournaments.push(t1,t2,t3,t4,t5,t6);db.revision=10;db.staffRev=4;
 return db;
}
/** Commands over rich(): every command type, every actor, the new error paths. '@N' is the result id of command N, '#club:Name' a club id. */
function commands(){
 const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']},E={events:['forms'],weight:70,height:175,gradeType:'cup',grade:5},T={city:'Łódź',mat:'Mata 1'};
 return [
  ['u-org1','tournament.save',{...T,name:'Turniej Org1 B',date:day(70),status:'open'}],                      // 0 new, self-entries by default
  ['u-org1','tournament.save',{...T,name:'Zapisy na www.spam.pl',date:day(70),status:'open'}],               // 1 CONTACT
  ['u-org1','tournament.save',{...T,id:'@0',name:'Turniej Org1 B',date:day(70),status:'finished'}],          // 2 finished before the day
  ['u-org1','tournament.save',{...T,id:'t-org1-hidden',name:'Ukryty',date:day(60),status:'open'}],           // 3 hidden by the Administrator
  ['u-org1','tournament.save',{...T,id:'t-staff-self',name:'Cudzy',date:day(30),status:'open'}],             // 4 seen, not managed: 403
  ['u-org1','tournament.save',{...T,id:'t-spring-2027',name:'Roboczy',date:day(80),status:'open'}],          // 5 staff draft: 404
  ['u-org1','tournament.save',{...T,id:'missing',name:'Brak',date:day(80),status:'open'}],                   // 6 missing: the same 404
  ['u-org1','profile.save',{...A,name:'Dziecko Organizatora',birthDate:'2016-02-02',sex:'F',weight:30,height:130,grade:9,club:{name:'Тигр Київ'}}], // 7 no consent
  ['u-org1','profile.save',{...A,name:'Dziecko Organizatora',birthDate:'2016-02-02',sex:'F',weight:30,height:130,grade:9,club:{name:'Тигр Київ'},guardianConsent:true}], // 8 new unverified club
  ['u-org1','profile.save',{...A,name:'Dorosły Organizatora',club:{none:true}}],                             // 9 unaffiliated
  ['u-org1','profile.save',{...A,id:'p-self',name:'Cudzy'}],                                                 // 10 not his: 404
  ['u-org1','entry.save',{...E,tournamentId:'@0',profileId:'@9'}],                                           // 11 own tournament
  ['u-org1','entry.save',{...E,tournamentId:'t-staff-self',profileId:'@9',events:['special']}],             // 12 staff tournament open for self-entries (O19)
  ['u-org1','entry.save',{...E,tournamentId:'t-org2',profileId:'@9'}],                                       // 13 trusted community (O19)
  ['u-org1','entry.save',{...E,tournamentId:'t-org3',profileId:'@9'}],                                       // 14 blocked organizer: unseen
  ['u-org1','entry.save',{...E,tournamentId:'t-staff-self',profileId:'p-ed'}],                               // 15 not his profile: 404
  ['u-org1','entry.save',{...E,tournamentId:'t-org1',profileId:'p-self',update:true,clubId:'club-2',weight:71}], // 16 self-entry: identity kept, club changed
  ['u-org1','entry.save',{...E,tournamentId:'t-org1',profileId:'p-self',update:true,clubId:'club-m'}],       // 17 merged club
  ['u-org1','entry.remove',{tournamentId:'t-org1',id:'p-self'}],                                             // 18 tombstone 'organizer'
  ['u-org1','checkin.save',{tournamentId:'t-org1',id:'p-o1a',presence:'present',actualWeight:70.4}],        // 19
  ['u-org1','checkin.save',{tournamentId:'t-org2',id:'p-o2',presence:'present',actualWeight:70}],           // 20 seen, not managed
  ['u-org1','profile.forget',{id:'p-o1b'}],                                                                  // 21 detached and deleted
  ['u-org1','profile.archive',{id:'@9',archived:true}],                                                      // 22
  ['u-org1','account.save',{email:'x@roles.test',role:'editor',clubId:'club-1'}],                            // 23
  ['u-par','entry.self',{tournamentId:'t-staff-self',profileId:'p-kid',events:['forms']}],                   // 24 staff tournament: minors allowed
  ['u-par','entry.self',{tournamentId:'t-org1',profileId:'p-kid',events:['forms']}],                         // 25 minor, unconfirmed organizer
  ['u-ath','entry.self',{tournamentId:'t-org1',profileId:'p-self',events:['forms']}],                        // 26 adult: allowed, tombstone gone
  ['u-ath','entry.self',{tournamentId:'t-org1',profileId:'p-self',events:['forms']}],                        // 27 already entered
  ['u-par','entry.self',{tournamentId:'t-org2-closed',profileId:'p-kid',events:['forms']}],                  // 28 closed: 403
  ['u-par','entry.self',{tournamentId:'t-org1-hidden',profileId:'p-kid',events:['forms']}],                  // 29 hidden: 404
  ['u-par','entry.self',{tournamentId:'t-autumn-2026',profileId:'p-kid',events:['forms']}],                  // 30 no self-entries: 403
  ['u-ath','entry.self',{tournamentId:'t-staff-self',profileId:'p-self',update:true,events:['forms'],weight:72}], // 31 entry in a saved draw: 409
  ['u-ath','entry.remove',{tournamentId:'t-staff-self',id:'p-self'}],                                        // 32 owner, entry in a saved draw: 409
  ['u-par','entry.remove',{tournamentId:'t-staff-self',id:'p-kid'}],                                         // 33 owner, open: 200
  ['u-ath','entry.remove',{tournamentId:'t-org2-closed',id:'p-self'}],                                       // 34 owner, closed: 403
  ['u-ath','athlete.save',{...A,relation:'self',name:'Drugi Ja',club:{id:'club-1'}}],                        // 35 second profile ('self'): one per account
  ['u-par2','athlete.save',{...A,relation:'guardian',name:'Młodsza Córka',birthDate:'2015-03-03',sex:'F',weight:33,height:135,grade:9,club:{name:'Klub Rodzica'}}], // 36 parent account: new unverified club
  ['u-ath','athlete.save',{...A,id:'p-self',relation:'self',name:'Zawodnik SELF Testowy',birthDate:'1999-01-01',club:{id:'club-1'}}], // 37 identity locked
  ['u-ath','athlete.save',{...A,id:'p-self',relation:'self',name:'Nowe Imię',birthDate:'2000-05-05',club:{id:'club-1'}}], // 38 name only
  ['u-ath','athlete.save',{...A,relation:'self',name:'Dziecko Samo',birthDate:'2014-01-01',club:{none:true}}],// 39 under 16
  ['u-ath','athlete.archive',{profileId:'p-self'}],                                                          // 40 pending entries
  ['u-par2','athlete.archive',{profileId:'@36'}],                                                             // 41
  ['u-par2','athlete.forget',{profileId:'@36'}],                                                              // 42 deleted
  ['u-ath','profile.save',{...A,id:'p-self',name:'Przez kartotekę',clubId:'club-1'}],                        // 43 owned: only the Administrator
  ['u-ath','tournament.save',{...T,name:'Nie mogę',date:day(90),status:'draft'}],                            // 44
  ['u-mem','athlete.save',{...A,relation:'self',name:'Członek Zawodnik',club:{name:'Klub Członka'}}],         // 45 new unverified club
  ['u-mem','entry.self',{tournamentId:'t-staff-self',profileId:'@45',events:['forms']}],                     // 46 category with a saved draw: 409
  ['u-mem','entry.self',{tournamentId:'t-org2',profileId:'@45',events:['forms'],saveToProfile:true,weight:73}], // 47
  ['u-mem','entry.self',{tournamentId:'t-org2',profileId:'@45',events:['forms'],update:true,weight:74}],     // 48
  ['demo-club','entry.save',{...E,tournamentId:'t-org2',profileId:'p-club1'}],                                    // 49 club in a trusted community tournament (O1)
  ['demo-club','entry.save',{...E,tournamentId:'t-org1',profileId:'p-club1'}],                                    // 50 unconfirmed: closed for clubs
  ['demo-editor','entry.save',{...E,tournamentId:'t-org2',profileId:'p-ed2'}],                               // 51 editor, own profile (O1)
  ['demo-editor','entry.save',{...E,tournamentId:'t-org2',profileId:'a2'}],                                  // 52 not his profile in a community tournament
  ['demo-editor','entry.save',{...E,tournamentId:'t-staff-self',profileId:'p-o1b'}],                         // 53 missing (forgotten)
  ['demo-editor','entry.save',{...E,tournamentId:'t-staff-self',profileId:'p-o2'}],                          // 54 organizer profile in a staff tournament
  ['demo-editor','entry.remove',{tournamentId:'t-staff-self',id:'p-self'}],                                  // 55 manager removes a self-entry: tombstone
  ['demo-admin','tournament.hide',{tournamentId:'t-org2',hidden:true,reason:' Sprawdzamy ‮organizatora ',withdrawSelf:true}], // 56
  ['u-org2','tournament.save',{...T,id:'t-org2',name:'Turniej t-org2',date:day(50),status:'open'}],          // 57 hidden
  ['demo-admin','tournament.hide',{tournamentId:'t-org2',hidden:false}],                                     // 58 restored to open
  ['demo-admin','tournament.hide',{tournamentId:'t-org2-closed',hidden:true,withdrawSelf:true}],             // 59 closed with a draw: the self-entry stays
  ['demo-admin','tournament.hide',{tournamentId:'t-org2-closed',hidden:false}],                              // 60 back to closed
  ['u-org2','result.clear',{tournamentId:'t-org2-closed',categoryId:'forms|senior|M|cup|6–3 Cup',matchId:'0-0'}], // 61
  ['u-org2','result.save',{tournamentId:'t-org2-closed',categoryId:'forms|senior|M|cup|6–3 Cup',matchId:'0-0',winnerId:'p-ed2'}], // 62
  ['u-org1','profile.save',{...A,name:'Trzeci Klub',club:{name:'Klub Trzeci'}}],                             // 63 third club of the day
  ['u-org1','profile.save',{...A,name:'Czwarty Klub',club:{name:'Klub Czwarty'}}],                           // 64 quota: pending name
  ['demo-admin','club.adopt',{name:'Klub Czwarty',profileIds:['@64']}],                                      // 65
  ['demo-admin','club.save',{id:'club-x',name:'Klub Nowy Sprawdzony',verified:true}],                        // 66
  ['demo-admin','club.save',{id:'club-x',name:'ks tiger krakow'}],                                           // 67 the key of club-2
  ['demo-admin','club.merge',{id:'#club:Тигр Київ',into:'club-2'}],                                          // 68
  ['demo-admin','club.merge',{id:UNAFFILIATED,into:'club-2'}],                                               // 69
  ['u-club2','club.save',{id:'club-2',verified:false}],                                                      // 70
  ['demo-admin','account.save',{id:'u-editor2',email:'editor2@roles.test',role:'editor',clubId:UNAFFILIATED}], // 71
  ['demo-admin','account.save',{id:'u-editor2',email:'editor2@roles.test',role:'editor',clubId:null,clubName:'KS Tiger Krakow'}], // 72 existing club by key
  ['demo-admin','profile.forget',{id:'p-o2'}],                                                               // 73 anonymised (closed tournament with a draw)
  ['demo-editor','profile.forget',{id:'p-ed2'}],                                                             // 74 finished? no: kept in a drawn closed tournament
  ['u-org3','tournament.save',{...T,name:'Zablokowany',date:day(90),status:'draft'}],                        // 75 blocked organizer
  ['u-org1','tournament.save',{...T,name:'Drugi dziś',date:day(71),status:'draft'}],                         // 76 second of the day (with 0)
  ['u-org1','tournament.save',{...T,name:'Trzeci dziś',date:day(72),status:'draft'}],                        // 77 third
  ['u-org1','tournament.save',{...T,name:'Czwarty dziś',date:day(73),status:'draft'}],                       // 78 day limit (t-org1 and t-org1-hidden are older)
  ['demo-admin','checkin.save',{tournamentId:'t-autumn-2026',id:'a1',presence:'present',actualWeight:65},10], // 79 old revision, untouched tournament: fresh (R15)
  ['demo-admin','entry.save',{...E,tournamentId:'t-org1',profileId:'p-ed',events:['forms']},10],            // 80 old revision, changed tournament: stale
  ['demo-admin','profile.save',{...A,name:'Nowy Personel',clubId:'club-1'},10],                              // 81 creation after staff changes (68, 72): stale
  ['u-mem','profile.save',{...A,name:'Bez Roli',club:{none:true}}],                                          // 82 member without the organizer role: 403
  ['u-org3','profile.save',{...A,name:'Zablokowany Zawodnik',club:{name:'Klub Zablokowanego'}}],             // 83 blocked organizer: 403, no club
  ['demo-admin','club.merge',{id:'club-1',into:UNAFFILIATED}],                                               // 84 staff accounts cannot become unaffiliated
  ['demo-admin','club.merge',{id:'#club:Klub Członka',into:UNAFFILIATED}],                                   // 85 a club of athletes only: into unaffiliated
  ['u-par','athlete.save',{...A,relation:'guardian',name:'Drugie Dziecko',birthDate:'2016-04-04',sex:'F',weight:30,height:130,grade:9,club:{none:true}}], // 86 second profile ('guardian')
  ['u-par','athlete.save',{...A,relation:'self',name:'Rodzic Zawodnik',club:{none:true}}],                   // 87 second profile ('self') on a guardian account
  ['u-ath','athlete.save',{...A,relation:'guardian',name:'Dziecko Zawodnika',birthDate:'2016-04-04',sex:'F',weight:30,height:130,grade:9,club:{none:true}}], // 88 'guardian' on a self account
  ['u-par2','athlete.save',{...A,relation:'self',name:'Rodzic Po Usunięciu',club:{none:true}}],             // 89 the profile of 36 was forgotten (42): allowed
  ['u-par2','athlete.archive',{profileId:'@89'}],                                                            // 90
  ['u-par2','athlete.save',{...A,relation:'guardian',name:'Kolejne Dziecko',birthDate:'2016-04-04',sex:'F',weight:30,height:130,grade:9,club:{none:true}}], // 91 an archived profile holds the place
  ['u-par2','athlete.save',{...A,id:'@89',relation:'self',name:'Rodzic Po Usunięciu',club:{none:true}}],    // 92 restored by its id
 ].map(([actor,type,payload,revision])=>({actor,type,payload,...(revision!==undefined?{revision}:{})}));
}
function runJs(db,list,flags){
 let state=structuredClone(db);if(flags)state.flags=flags;const ids=[],results=[];
 const refs=v=>typeof v==='string'&&/^@\d+$/.test(v)?ids[Number(v.slice(1))]??v:typeof v==='string'&&v.startsWith('#club:')?state.clubs.find(c=>c.name===v.slice(6))?.id??v:Array.isArray(v)?v.map(refs):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,refs(x)])):v;
 list.forEach((c,i)=>{try{const out=execute(state,c.actor,c.type,refs(c.payload),c.revision??state.revision);state=out.db;ids[i]=out.result.id??null;results.push({status:200,result:out.result});}catch(e){results.push({status:e.status??422,error:e.message,...(e.data?{data:e.data}:{})});}});
 delete state.flags;return {db:state,results};
}
const HEX=/^[0-9a-f]{32}$/;
// The demo logs results as 'Zapisano wynik walki.' / 'Wycofano wynik walki.', PHP as 'Zaktualizowano wynik walki.' (an old difference).
const RESULT_LOG=['Zapisano wynik walki.','Wycofano wynik walki.'];
const DROP=new Set(['createdAt','guardianConsentAt','guardianDeclaredAt','time','seed','at','passwordHash','passwordSalt','organizers','flags','withdrawalsPurge']);
/** Normalised state: random ids → tokens in order of appearance (sorted keys, lists in order; draw slots last, as sets), no times. */
function normalize(db){
 const map=new Map(),tok=v=>HEX.test(v)?(map.has(v)||map.set(v,'#'+(map.size+1)),map.get(v)):v;
 const walk=(v,key)=>{
  if(typeof v==='string')return key==='text'&&RESULT_LOG.includes(v)?'Zaktualizowano wynik walki.':tok(v);
  if(Array.isArray(v))return key==='slots'?v:v.map(x=>walk(x));
  if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v).sort()){if(DROP.has(k))continue;let x=v[k];if((k==='draws'||k==='results')&&Array.isArray(x)&&!x.length)x={};o[tok(k)]=walk(x,k);}return o;}
  return v;
 };
 const out=walk(db);
 const slots=v=>{if(Array.isArray(v))v.forEach(slots);else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(k==='slots'&&Array.isArray(x))v[k]=x.filter(Boolean).map(tok).sort();else slots(x);}};
 slots(out);return out;
}
function compare(js,ph,list){
 assert.equal(ph.results.length,js.results.length);
 const diff=[];
 list.forEach((c,i)=>{const a=js.results[i],b=ph.results[i];
  if(a.status!==b.status)diff.push(`#${i} ${c.actor} ${c.type}: JS ${a.status} ${a.error||''} / PHP ${b.status} ${b.error||''}`);
  else if(a.error!==b.error&&!KNOWN.includes(b.error+' | '+a.error))diff.push(`#${i} ${c.type}: messages JS "${a.error}" / PHP "${b.error}"`);
 });
 assert.deepEqual(diff,[]);
 assert.deepEqual(normalize(ph.db),normalize(js.db));
}
const ACTORS=['demo-admin','demo-editor','u-editor2','demo-club','u-club2','u-org1','u-org2','u-org3','u-ath','u-par','u-par2','u-mem'];
const ONE='Na jednym koncie może być tylko jeden zawodnik.';
const STATUS=list=>list.map(r=>r.status),ids=run=>run.results.map(r=>r.result?.id??null);

test('commands: equal statuses, messages of the new paths and normalised state in PHP and JS (trustRequired)',{skip},()=>{
 const db=rich(),list=commands(),js=runJs(db,list),ph=bridge({job:'execute',db,commands:list});
 compare(js,ph,list);
 // The scenario means what its comments say (spot checks of the JS side; PHP is equal above).
 const s=STATUS(js.results);
 assert.deepEqual([s[0],s[1],s[2],s[3],s[4],s[5],s[6],s[7],s[8],s[9],s[10]],[200,422,422,409,403,404,404,422,200,200,404]);
 assert.deepEqual([s[11],s[12],s[13],s[14],s[15],s[16],s[17],s[18],s[19],s[20],s[21]],[200,200,200,404,404,200,404,200,200,403,200]);
 assert.deepEqual([s[24],s[25],s[26],s[27],s[28],s[29],s[30],s[31],s[32],s[33],s[34]],[200,409,200,409,403,404,403,409,409,200,403]);
 assert.deepEqual([s[35],s[36],s[37],s[38],s[39],s[40],s[41],s[42],s[43],s[44]],[409,200,409,200,422,409,200,200,403,403]);
 assert.deepEqual([s[46],s[47],s[48],s[49],s[50],s[51],s[52],s[54],s[55]],[409,200,200,200,403,200,403,403,200]);
 assert.deepEqual([s[56],s[57],s[58],s[59],s[60],s[63],s[64],s[65],s[66],s[67],s[68],s[69],s[70],s[71],s[72]],[200,409,200,200,200,200,200,200,200,409,200,409,403,422,200]);
 assert.deepEqual([s[75],s[76],s[77],s[78],s[79],s[80],s[81]],[403,200,200,429,200,409,409]);
 assert.deepEqual([s[82],s[83],s[84],s[85]],[403,403,409,200]);
 assert.deepEqual([s[86],s[87],s[88],s[89],s[90],s[91],s[92]],[409,409,409,200,200,409,200]);
 for(const i of [35,86,87,88,91])assert.equal(js.results[i].error,ONE,'#'+i+': one athlete profile per account (§17)');
 assert.deepEqual(['u-ath','u-par','u-par2'].map(id=>js.db.profiles.filter(p=>p.ownerId===id).length),[1,1,1]);assert.deepEqual([js.results[82].error,js.results[83].error],['Brak uprawnień.','Brak uprawnień.']);
 assert.equal(js.results[84].error,'Ten klub ma konta personelu. Przypisz je do innego klubu przed scaleniem z „Niezrzeszony”.');
 assert.ok(!js.db.clubs.some(c=>c.name==='Klub Zablokowanego')&&!js.db.profiles.some(p=>['Bez Roli','Zablokowany Zawodnik'].includes(p.name)),'nothing created by members without the role');
 const merged=js.db.clubs.find(c=>c.name==='Klub Członka');assert.equal(merged.mergedInto,UNAFFILIATED);assert.equal(js.db.profiles.find(p=>p.id===ids(js)[45]).clubId,UNAFFILIATED);
 assert.ok(js.db.users.filter(u=>['admin','editor','club'].includes(u.role)).every(u=>u.clubId!==UNAFFILIATED),'no staff account is unaffiliated');
 assert.equal(js.results[64].result.notice,'club-pending');assert.deepEqual(ph.results[78].data.retry>0,true);
 assert.equal(js.results[25].error,'Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.');
 const w=js.db.withdrawals.map(x=>[x.profileId===ids(js)[45]?'@45':x.profileId,x.tournamentId,x.by]);
 assert.deepEqual(w,[['p-self','t-staff-self','organizer'],['p-kid','t-org2','admin'],['@45','t-org2','admin']],'tombstones: organizer (55) and admin (56); the one of 18 vanished with the re-entry (26)');
});
test('one athlete profile per account (§17): a second profile, self or guardian, gets the same 409 and message in PHP and JS',{skip},()=>{
 const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5},kid={...A,relation:'guardian',birthDate:'2016-04-04',sex:'F',weight:30,height:130,grade:9,club:{none:true}};
 const list=[
  {actor:'u-ath',type:'athlete.save',payload:{...A,relation:'self',name:'Drugi Ja',club:{none:true}}},          // self account: second 'self'
  {actor:'u-ath',type:'athlete.save',payload:{...kid,name:'Dziecko Zawodnika'}},                                // self account: a 'guardian' one
  {actor:'u-par',type:'athlete.save',payload:{...kid,name:'Drugie Dziecko'}},                                   // guardian account: second child
  {actor:'u-par',type:'athlete.save',payload:{...A,relation:'self',name:'Rodzic Zawodnik',club:{none:true}}},  // guardian account: 'self'
  {actor:'u-par2',type:'athlete.save',payload:{...kid,name:'Jedyne Dziecko'}},                                  // empty account: the first one
  {actor:'u-par2',type:'athlete.save',payload:{...kid,name:'Drugie Dziecko'}},                                  // and the second
  {actor:'u-mem',type:'athlete.save',payload:{...A,relation:'self',name:'Członek Sam',club:{none:true}}},
  {actor:'u-mem',type:'athlete.save',payload:{...A,relation:'self',name:'Członek Drugi',club:{none:true}}},
 ];
 const js=runJs(rich(),list),ph=bridge({job:'execute',db:rich(),commands:list});compare(js,ph,list);
 const want=[409,409,409,409,200,409,200,409];
 assert.deepEqual(STATUS(js.results),want);assert.deepEqual(STATUS(ph.results),want);
 want.forEach((st,i)=>{if(st===409){assert.equal(js.results[i].error,ONE,'JS #'+i);assert.equal(ph.results[i].error,ONE,'PHP #'+i);}});
 for(const r of [js,ph])assert.deepEqual(['u-ath','u-par','u-par2','u-mem'].map(id=>r.db.profiles.filter(p=>p.ownerId===id).length),[1,1,1,1]);
 // Data written before the limit (§17): u-ath also owns a 'guardian' profile. The one-'self' rule still guards edits of it, and
 // a new profile on that account gets the one-athlete message; editing it as 'guardian' still works.
 const legacy=()=>{const db=rich(),kidP=db.profiles.find(p=>p.id==='p-kid');db.profiles.push({...structuredClone(kidP),id:'p-legacy',ownerId:'u-ath',createdBy:'u-ath',name:'Stare Dziecko Testowe'});return db;};
 const old=[
  {actor:'u-ath',type:'athlete.save',payload:{...A,id:'p-legacy',relation:'self',name:'Stare Dziecko Testowe',club:{none:true}}}, // second 'self'
  {actor:'u-ath',type:'athlete.save',payload:{...kid,name:'Trzecie Dziecko'}},                                                   // a new one
  {actor:'u-ath',type:'athlete.save',payload:{...A,relation:'self',name:'Nowy Ja',club:{none:true}}},                             // a new 'self'
  {actor:'u-ath',type:'athlete.save',payload:{...kid,id:'p-legacy',name:'Stare Dziecko Poprawione'}},                             // edit, still 'guardian'
 ];
 const jl=runJs(legacy(),old),pl=bridge({job:'execute',db:legacy(),commands:old});compare(jl,pl,old);
 const wantL=[409,409,409,200];assert.deepEqual(STATUS(jl.results),wantL);assert.deepEqual(STATUS(pl.results),wantL);
 const OWN='Na koncie jest już Twój własny profil zawodnika.';
 for(const r of [jl,pl]){
  assert.deepEqual(r.results.slice(0,3).map(x=>x.error),[OWN,ONE,ONE]);
  const mine=r.db.profiles.filter(p=>p.ownerId==='u-ath').map(p=>[p.id,p.relation,p.name]).sort();
  assert.deepEqual(mine,[['p-legacy','guardian','Stare Dziecko Poprawione'],['p-self','self','Zawodnik SELF Testowy']]);
 }
});
test('commands with trustRequired=false and paused publishing: every organizer not blocked works as confirmed (§17)',{skip},()=>{
 const db=rich(),flags={organizers:'paused',trustRequired:false},T={city:'Łódź',mat:'Mata 1'};
 const list=[
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-org1',profileId:'p-kid',events:['forms']}},                       // minor allowed
  {actor:'u-org1',type:'tournament.save',payload:{...T,name:'Wstrzymane?',date:day(70),status:'open'}},                        // paused does not apply
  {actor:'demo-club',type:'entry.save',payload:{tournamentId:'t-org1',profileId:'p-club1',events:['forms'],weight:70,height:175,gradeType:'cup',grade:5}}, // clubs may enter
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-org3',profileId:'p-kid',events:['forms']}},                        // blocked organizer: still not
 ];
 const js=runJs(db,list,flags),ph=bridge({job:'execute',db,flags,commands:list});compare(js,ph,list);
 assert.deepEqual(STATUS(js.results),[200,200,200,409]);
 const paused={organizers:'paused',trustRequired:true},one=[list[1]],a=runJs(db,one,paused),b=bridge({job:'execute',db,flags:paused,commands:one});compare(a,b,one);
 assert.equal(a.results[0].status,409,'an unconfirmed organizer cannot publish while paused');
 const draft=[{...list[1],payload:{...list[1].payload,status:'draft'}}];assert.equal(runJs(db,draft,paused).results[0].status,200,'drafts are allowed');
});

test('publicData equals publicWorkspace for every actor, before and after the commands, for both trust settings',{skip},()=>{
 const after=runJs(rich(),commands()).db;
 for(const [db,flags] of [[rich(),undefined],[after,undefined],[rich(),{organizers:'on',trustRequired:false}],[after,{organizers:'paused',trustRequired:false}]]){
  const views=bridge({job:'public',db,flags,actors:ACTORS}),state=flags?{...db,flags}:db;
  ACTORS.forEach((id,i)=>assert.deepEqual(views[i],JSON.parse(JSON.stringify(publicWorkspace(state,state.users.find(u=>u.id===id)))),id+' '+JSON.stringify(flags)));
 }
});

test('Domain::stale agrees with the JS table of scopes (§5.8)',{skip},()=>{
 const db=rich();db.revision=20;db.staffRev=12;
 const rev=(k,id,r)=>{db[k].find(x=>x.id===id).rev=r;};
 rev('tournaments','t-org1',18);rev('tournaments','t-staff-self',9);rev('profiles','p-o1a',19);rev('profiles','p-ed',5);rev('tournaments','t-org2',15);
 const cases=[];
 for(const expected of [20,21,19,17,14,11,8])for(const [type,p,actor] of [
  ['entry.save',{tournamentId:'t-org1',profileId:'p-ed'}],['entry.save',{tournamentId:'t-staff-self',profileId:'p-o1a'}],['entry.save',{tournamentId:'t-staff-self',profileId:'p-ed'}],['entry.save',{tournamentId:'missing'}],
  ['entry.remove',{tournamentId:'t-org2'}],['checkin.save',{tournamentId:'t-staff-self'}],['draw.create',{tournamentId:'t-org1'}],['result.save',{tournamentId:'t-org2'}],['result.clear',{tournamentId:'t-autumn-2026'}],['tournament.hide',{tournamentId:'t-org1'}],
  ['tournament.save',{id:'t-org1'}],['tournament.save',{},'u-org1'],['tournament.save',{},'u-org2'],['tournament.save',{},'demo-editor'],
  ['profile.save',{id:'p-o1a'}],['profile.save',{id:'p-ed',registration:{tournamentId:'t-org1'}}],['profile.save',{},'demo-admin'],['profile.save',{},'u-org1'],['profile.save',{registration:{tournamentId:'t-org2'}},'demo-admin'],
  ['profile.archive',{id:'p-o1a'}],['profile.forget',{id:'p-ed'}],['account.save',{}],['account.password',{}],['club.merge',{}],['entry.self',{}],['athlete.save',{}],['unknown',{}]
 ])cases.push({type,p,expected,actor:actor??null});
 const out=bridge({job:'stale',db,cases});
 cases.forEach((c,i)=>assert.equal(out[i],stale(db,c.type,c.p,c.expected,c.actor),JSON.stringify(c)));
 const at=(type,p,expected,actor=null)=>stale(db,type,p,expected,actor);
 assert.equal(at('checkin.save',{tournamentId:'t-staff-self'},14),false,'another tournament changed: still fresh (R15)');
 assert.equal(at('checkin.save',{tournamentId:'t-org1'},14),true);assert.equal(at('anything',{},21),true,'a revision from the future (restored backup)');
 assert.equal(at('tournament.save',{},14,'u-org1'),true,'own tournament changed after the revision: no duplicate creation');assert.equal(at('tournament.save',{},11,'demo-editor'),true,'staff changed after 11');
 assert.equal(at('tournament.save',{},17,'demo-editor'),false);assert.equal(at('account.save',{},11),true);assert.equal(at('account.save',{},12),false);
});

const CONTACT_CASES=[['Puchar Krakowa 2026',false],['Turniej 12.11.2026',false],['Mata 1',false],['Hala MOSiR, ul. Długa 5',false],['Liga 2026/2027',false],['UKS Orły',false],['Gdańsk',false],['Kraków-Nowa Huta',false],['Klub.Sportowy',false],
 ['www.example.org',true],['https://x',true],['http://klub',true],['zapisy@klub',true],['kontakt: klub.pl',true],['Turniej KLUB.COM',true],['600 700 800',true],['+48 600-700-800',true],['PL61109010140000071219812874',true],['żabka.pl',true],['bilety.shop',true],['123456789',true],['12345678',false],['tel. 600700800',true]];
test('CONTACT: shared cases give the same answer in PHP and JS (§5.4)',{skip},()=>{
 const out=bridge({job:'contact',cases:CONTACT_CASES.map(c=>c[0])});
 CONTACT_CASES.forEach(([s,expected],i)=>{assert.equal(contact(s),expected,'JS '+s);assert.equal(out[i],expected,'PHP '+s);});
});
const KEYS=['Kraków','Krakow','KRAKÓW ','Straße','Strasse','Тигр Київ','Дракон Львів','ΟΔΟΣ','οδοσ','태권도 클럽','Łódź','‮Łódź','a','A1','—','',null,7,'Niezrzeszony','Bez klubu','Émile Zola','İstanbul'];
test('Clubs::key equals clubKey; Clubs::pick equals pickClub (Cyrillic, Kraków/Krakow, merged, unaffiliated, pending name, quotas)',{skip},()=>{
 assert.deepEqual(bridge({job:'clubKey',cases:KEYS}),KEYS.map(clubKey));
 assert.equal(clubKey('Kraków'),clubKey('Krakow'));assert.notEqual(clubKey('Тигр Київ'),clubKey('Дракон Львів'));assert.equal(clubKey('ΟΔΟΣ'),clubKey('οδοσ'));
 const clubs=[{id:'c1',name:'KS Kraków',verified:true,mergedInto:null},{id:'c2',name:'Тигр Київ',verified:false,createdBy:'m1',createdAt:NOW-50,mergedInto:null},{id:'c3',name:'Stary Klub',verified:true,mergedInto:'c1'},{id:UNAFFILIATED,name:'Niezrzeszony',verified:true,mergedInto:null}];
 const member={id:'m1',role:'member'},admin={id:'a',role:'admin'},editor={id:'e',role:'editor'};
 const cases=[[member,{id:'c1'}],[member,{id:'c3'}],[member,{id:'nope'}],[member,{none:true}],[member,{name:'ks krakow'}],[member,{name:'stary klub'}],[member,{name:'тигр київ'}],[member,{name:'Niezrzeszona'}],[member,{name:'bez klubu'}],
  [member,{name:'Nowy Klub'}],[admin,{name:'Nowy Klub'}],[editor,{name:'Nowy Klub'}],[member,{name:'x'}],[member,{name:'12'}],[member,{name:'Klub www.klub.pl'}],[admin,{name:'Klub www.klub.pl'}],[member,{}],[member,{name:'Nowy Klub'},{user:3,global:3}],
  [member,{name:'Nowy Klub'},{user:0,global:30}],[editor,{name:'Nowy Klub'},{user:9,global:99}],[member,{name:'ks krakow'},{user:9,global:99}]].map(([u,choice,counts])=>({clubs,u,choice,now:NOW,counts}));
 const js=cases.map(c=>{try{const r=pickClub(c.clubs,c.u,c.choice,c.now,c.counts);if(r.newClub){r.newClub={...r.newClub,id:'NEW'};r.clubId='NEW';}return {status:200,result:r};}catch(e){return {status:e.status,error:e.message};}});
 assert.deepEqual(bridge({job:'pick',cases}),js);
 assert.deepEqual(js.slice(0,9).map(r=>r.result?.clubId??r.status),['c1','c1',404,UNAFFILIATED,'c1','c1','c2',UNAFFILIATED,UNAFFILIATED]);
 assert.deepEqual([js[9].result.newClub.verified,js[10].result.newClub.verified,js[11].result.newClub.verified],[false,true,false]);
 assert.deepEqual([js[17].result,js[18].result.notice,js[19].result.clubId,js[20].result.clubId],[{clubId:UNAFFILIATED,pendingClubName:'Nowy Klub',notice:'club-pending'},'club-pending','NEW','c1']);
 assert.deepEqual([js[12].status,js[13].status,js[14].status,js[15].status,js[16].status],[422,422,422,200,422]);
});
test('athleteFields: the same fields and messages in PHP and JS (§6.1)',{skip},()=>{
 const today=warsawToday(),ok={relation:'self',name:' Ewa ‮Nowak ',birthDate:'1990-01-01',sex:'F',weight:'60.5',height:170,gradeType:'cup',grade:4,club:{id:'c1'},ownerId:'x',champion:true};
 const cases=[ok,{...ok,relation:'guardian',birthDate:'2016-06-06',club:{none:true}},{...ok,relation:'other'},{...ok,name:''},{...ok,birthDate:''},{...ok,birthDate:'2030-01-01'},{...ok,birthDate:'1899-12-31'},{...ok,birthDate:'2001-02-30'},
  {...ok,sex:'X'},{...ok,weight:'abc'},{...ok,weight:5},{...ok,height:300},{...ok,grade:1.5},{...ok,gradeType:'dan',grade:9},{...ok,club:{}},{...ok,club:'c1'},{...ok,club:{name:'Nowy'}},{...ok,birthDate:yearsAgo(15)},{...ok,birthDate:yearsAgo(16)},{...ok,relation:'guardian',birthDate:yearsAgo(3)}];
 const js=cases.map(p=>{try{return {status:200,result:athleteFields(p,today)};}catch(e){return {status:e.status,error:e.message};}});
 assert.deepEqual(bridge({job:'athlete',today,cases}),js);
 assert.deepEqual(js[0].result,{name:'Ewa Nowak',birthDate:'1990-01-01',sex:'F',weight:60.5,height:170,gradeType:'cup',grade:4,club:{id:'c1'},relation:'self'},'closed list of fields');
 assert.equal(js[17].error,'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');assert.equal(js[18].status,200);
 assert.ok(!/zaznacz|opiekun\b.*pole/i.test(js[17].error),'no hint how to get around the age rule');
});
test('Rules::sameClub equals sameClub; unaffiliated athletes are never separated in a PHP draw',{skip},()=>{
 const pairs=[[{club:'A',clubId:'c1'},{club:'A',clubId:'c1'}],[{club:'A',clubId:'c1'},{club:'B',clubId:'c2'}],[{club:'Niezrzeszony',clubId:UNAFFILIATED},{club:'Niezrzeszony',clubId:UNAFFILIATED}],[{club:'A'},{club:'A'}],[{club:'Niezrzeszony',clubId:UNAFFILIATED},{club:'Niezrzeszony'}]];
 assert.deepEqual(bridge({job:'sameClub',pairs}),pairs.map(([a,b])=>sameClub(a,b)));
 const athletes=Array.from({length:8},(_,i)=>({id:'u'+i,club:i<6?'Niezrzeszony':'Klub A',clubId:i<6?UNAFFILIATED:'cA',champion:false}));
 assert.deepEqual(bridge({job:'drawCost',athletes,runs:20}),Array(20).fill(0),'two athletes of Klub A always meet another club or an unaffiliated athlete; unaffiliated pairs cost nothing');
});
test('Settings::effective (wave 1 stub): derived keys, idempotent, flags',{skip},()=>{
 const base={signup_enabled:false,billing_enabled:false,billing_enforce:false,support_email:''};
 const cases=[base,{...base,signup_enabled:true},{...base,signup_enabled:true,billing_enabled:true,billing_enforce:true},{...base,signup_enabled:true,billing_enforce:true},{...base,signup_enabled:true,signup_force_off:true,support_email:'pomoc@x.test'},{...base,organizers:'paused',organizers_trust_required:false}];
 const out=bridge({job:'settings',cases});
 assert.ok(out.every(o=>o.again),'idempotent');
 assert.deepEqual(out.map(o=>o.effective.signup_mode),['off','free','paid','off','off','off']);
 assert.deepEqual(out.map(o=>o.effective.settings_degraded??null),[null,null,null,'billing-missing','force-off',null]);
 assert.deepEqual(out.map(o=>o.effective.support_email),['hello@matbravo.com','hello@matbravo.com','hello@matbravo.com','hello@matbravo.com','pomoc@x.test','hello@matbravo.com']);
 assert.deepEqual(out.map(o=>o.flags),[...Array(5).fill({organizers:'on',trustRequired:false}),{organizers:'paused',trustRequired:false}],'trustRequired defaults to false (owner decision, §17)');
 assert.deepEqual(out.map(o=>o.effective.signup_free_beta),[true,true,false,true,true,true]);
});
test('Actors::build: caps of members and staff',{skip},()=>{
 const account={id:'m',clubId:null,email:'m@x.test',role:'member',active:true,passwordHash:'h',authVersion:1};
 const a=bridge({job:'actor',account,organizer:true,blockedAt:null,trustedAt:5,athletes:[{id:'p1',archived:true,relation:'self'}]});
 assert.deepEqual(a.caps,{organizer:true,organizerBlocked:false,organizerTrusted:true,athlete:false});
 const b=bridge({job:'actor',account,organizer:true,blockedAt:9,trustedAt:null,athletes:[{id:'p1',archived:false,relation:'guardian'}]});
 assert.deepEqual(b.caps,{organizer:false,organizerBlocked:true,organizerTrusted:false,athlete:true});
 assert.deepEqual(bridge({job:'actor',account:{...account,role:'editor'},organizer:true,blockedAt:null,trustedAt:null,athletes:[]}).caps.organizer,false,'staff never get member roles');
});

test('Domain::forgetMember (PHP only): owned profiles forgotten, upcoming tournaments hidden by the system with tombstones, organizer profiles forgotten, idempotent (§6.6)',{skip},()=>{
 const db=rich(),{db:out,out:counts}=bridge({job:'forgetMember',db,users:['u-org1','u-ath','u-par']});
 const t=id=>out.tournaments.find(x=>x.id===id),p=id=>out.profiles.find(x=>x.id===id);
 assert.deepEqual([t('t-org1').status,t('t-org1').hiddenBy,t('t-org1').hiddenFrom],['draft','system','open']);assert.ok(t('t-org1').activity.some(x=>x.text==='Konto organizatora zostało usunięte.'));
 assert.ok(t('t-org1').activity.every(x=>!/Testowy/.test(x.text)),'removed entries are logged with initials');
 assert.deepEqual([t('t-org1-hidden').hiddenBy,t('t-org1-hidden').status],['demo-admin','draft'],'already hidden: unchanged');
 assert.equal(p('p-o1a'),undefined,'organizer profile without remaining entries: deleted');assert.equal(p('p-o1b'),undefined);
 assert.ok(!out.tournaments.some(x=>x.entries.some(e=>['p-o1a','p-o1b'].includes(e.profileId))));
 assert.deepEqual([p('p-self').name,p('p-self').ownerId,p('p-self').archived],['Dane usunięte',null,true],'owned profile kept by the closed tournament with a draw: anonymised');
 assert.ok(t('t-org2-closed').entries.some(e=>e.profileId==='p-self'&&e.name==='Zawodnik SELF Testowy'),'history keeps the name in snapshots (O7)');
 assert.equal(p('p-kid'),undefined,'child profile (parent account) in an open tournament only: deleted');
 assert.deepEqual(out.withdrawals.map(w=>[w.profileId,w.tournamentId,w.by]),[['p-self','t-org1','system']],'other athletes in the hidden tournament');
 assert.deepEqual(counts.map(c=>c.tournaments),[1,0,0]);assert.ok(out.revision>db.revision);
 const again=bridge({job:'forgetMember',db:out,users:['u-org1','u-ath','u-par']});assert.deepEqual(again.db,out,'idempotent: nothing changes, not even the revision');
 assert.deepEqual(again.out.map(c=>c.tournaments),[0,0,0]);
});
/** rich() after commands that write log lines naming athletes: self-entries, withdrawals by the owner, the Administrator and an
 * organizer, check-in, then a rename of p-self and a corrected self-entry (the old name stays only in older lines and snapshots). */
function logged(){
 const P={sex:'M',birthDate:'2000-05-05',weight:70,height:175,gradeType:'cup',grade:5};
 const list=[
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-staff-self',profileId:'p-kid',events:['forms']}},
  {actor:'u-par',type:'entry.remove',payload:{tournamentId:'t-staff-self',id:'p-kid'}},
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-staff-self',profileId:'p-kid',events:['forms']}},
  {actor:'demo-admin',type:'entry.remove',payload:{tournamentId:'t-staff-self',id:'p-kid'}},
  {actor:'u-org1',type:'checkin.save',payload:{tournamentId:'t-org1',id:'p-self',presence:'present',actualWeight:70}},
  {actor:'u-ath',type:'athlete.save',payload:{...P,id:'p-self',relation:'self',name:'Nowe Imię Zawodnika',club:{id:'club-1'}}},
  {actor:'u-ath',type:'entry.self',payload:{tournamentId:'t-org1',profileId:'p-self',events:['forms'],update:true}},
  {actor:'u-org2',type:'entry.remove',payload:{tournamentId:'t-org2',id:'p-ed'}},
 ];
 const out=runJs(rich(),list);assert.deepEqual(STATUS(out.results),list.map(()=>200));return {db:out.db,list};
}
const NAMES=['Zawodnik SELF Testowy','Zawodnik KID Testowy','Nowe Imię Zawodnika'],logs=db=>db.tournaments.flatMap(t=>t.activity.map(x=>x.text));
test('forgetting athletes leaves no full name in tournament logs: earlier names, withdrawals, PHP forgetMember and the JS mirror (§6.6)',{skip},()=>{
 const {db,list}=logged();assert.ok(NAMES.every(n=>logs(db).some(x=>x.endsWith(': '+n))),'every name is in a log before');
 // Account deletion (PHP only): snapshots kept as results history keep the name (O7), logs never.
 const {db:out}=bridge({job:'forgetMember',db,users:['u-ath','u-par']});
 assert.deepEqual(logs(out).filter(x=>NAMES.some(n=>x.includes(n))),[],'no full name in any log');
 assert.ok(out.tournaments.find(t=>t.id==='t-staff-self').activity.some(x=>x.text==='Wycofano zgłoszenie: Z. T.'),'the withdrawal by the Administrator, as initials');
 assert.ok(out.tournaments.find(t=>t.id==='t-org2-closed').entries.some(e=>e.profileId==='p-self'&&e.name==='Zawodnik SELF Testowy'),'a snapshot kept as history keeps its name (O7)');
 assert.ok(logs(out).includes('Wycofano zgłoszenie: Zawodnik ED Testowy'),'other athletes keep their names');
 // A namesake with an entry in the same tournament keeps his line.
 const twin=structuredClone(db),t3=twin.tournaments.find(t=>t.id==='t-org2');t3.entries.find(e=>e.profileId==='p-club2').name='Zawodnik KID Testowy';t3.activity.unshift({text:'Zgłoszono: Zawodnik KID Testowy',time:'2026-01-01T00:00:00.000Z'});
 assert.equal(bridge({job:'forgetMember',db:twin,users:['u-ath','u-par']}).db.tournaments.find(t=>t.id==='t-org2').activity.find(x=>x.text.startsWith('Zgłoszono: ')).text,'Zgłoszono: Zawodnik KID Testowy');
 // A line marked with the namesake's profile keeps his name in every tournament, also where no entry carries it.
 const marked=structuredClone(db);for(const id of ['t-org2','t-autumn-2026'])marked.tournaments.find(t=>t.id===id).activity.unshift({text:'Wycofano zgłoszenie: Zawodnik KID Testowy',time:'2026-01-01T00:00:00.000Z',profileId:'p-club2'});
 const kept=bridge({job:'forgetMember',db:marked,users:['u-ath','u-par']}).db;
 for(const id of ['t-org2','t-autumn-2026'])assert.ok(kept.tournaments.find(t=>t.id===id).activity.some(x=>x.profileId==='p-club2'&&x.text==='Wycofano zgłoszenie: Zawodnik KID Testowy'),id);
 // athlete.forget: the same rule in PHP and JS, snapshots as initials too.
 const more=[...list,{actor:'u-par',type:'athlete.forget',payload:{profileId:'p-kid'}},{actor:'u-ath',type:'athlete.forget',payload:{profileId:'p-self'}}];
 const js=runJs(rich(),more),ph=bridge({job:'execute',db:rich(),commands:more});compare(js,ph,more);
 assert.deepEqual(STATUS(js.results).slice(-2),[200,200]);
 const json=JSON.stringify(js.db.tournaments);assert.ok(NAMES.every(n=>!json.includes(n)),'neither logs nor snapshots name them');
});
test('forgetting a namesake (organizer, athlete, account deletion) writes nothing to tournaments of others; a rename before forgetMember leaves no old name (§6.6)',{skip},()=>{
 const db=rich(),A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']};
 // An unmarked line written before 0007, in a staff tournament where the real athlete has no entry.
 db.tournaments.find(t=>t.id==='t-gp-gdansk-2026').activity.unshift({text:'Wycofano zgłoszenie: Adam Nowak',time:'2026-10-01T10:00:00.000Z'});
 const kid={...A,relation:'guardian',name:'Adam Nowak',birthDate:'2015-03-03',weight:33,height:135,grade:9,club:{none:true}};
 const list=[
  {actor:'demo-admin',type:'entry.remove',payload:{tournamentId:'t-autumn-2026',id:'a1'}},                     // 0 the real Adam Nowak, marked a1
  {actor:'u-org1',type:'profile.save',payload:{...A,name:'Adam Nowak',club:{none:true}}},                      // 1 namesakes
  {actor:'u-org1',type:'profile.forget',payload:{id:'@1'}},
  {actor:'u-par2',type:'athlete.save',payload:kid},                                                             // 3 a parent account
  {actor:'u-par2',type:'athlete.forget',payload:{profileId:'@3'}},
  {actor:'u-par2',type:'athlete.save',payload:kid},                                                             // 5 kept for the account deletion
 ];
 const js=runJs(db,list),ph=bridge({job:'execute',db,commands:list});compare(js,ph,list);assert.deepEqual(STATUS(js.results),list.map(()=>200));
 const t=(d,id)=>d.tournaments.find(x=>x.id===id),staff=d=>['t-autumn-2026','t-gp-gdansk-2026'].map(id=>[t(d,id).rev??0,t(d,id).activity.map(x=>x.text)]);
 assert.deepEqual(staff(ph.db),[[11,['Wycofano zgłoszenie: Adam Nowak']],[0,['Wycofano zgłoszenie: Adam Nowak']]],'only command 0 touched them');
 const {db:out}=bridge({job:'forgetMember',db:ph.db,users:['u-par2']});
 for(const id of ['t-autumn-2026','t-gp-gdansk-2026'])assert.deepEqual(t(out,id),t(ph.db,id),id+': unchanged by the account deletion');
 // A rename and a corrected self-entry: the old name is in no snapshot, its marked lines still lose it.
 const k=db.profiles.find(p=>p.id==='p-kid'),renamed={relation:'guardian',name:'Inna Córka',birthDate:k.birthDate,sex:k.sex,weight:k.weight,height:k.height,gradeType:k.gradeType,grade:k.grade,club:{id:UNAFFILIATED}};
 const steps=[
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-staff-self',profileId:'p-kid',events:['forms']}},
  {actor:'u-par',type:'entry.remove',payload:{tournamentId:'t-staff-self',id:'p-kid'}},
  {actor:'u-par',type:'athlete.save',payload:{...renamed,id:'p-kid'}},
  {actor:'u-par',type:'entry.self',payload:{tournamentId:'t-org2',profileId:'p-kid',events:['forms'],update:true}},
 ];
 const a=runJs(rich(),steps),b=bridge({job:'execute',db:rich(),commands:steps});compare(a,b,steps);assert.deepEqual(STATUS(a.results),steps.map(()=>200));
 const old='Zawodnik KID Testowy',all=d=>d.tournaments.flatMap(x=>x.activity.map(y=>y.text));
 assert.ok(all(b.db).some(x=>x.endsWith(': '+old))&&!b.db.tournaments.some(x=>x.entries.some(e=>e.name===old)),'the old name only in logs');
 assert.deepEqual(all(bridge({job:'forgetMember',db:b.db,users:['u-par']}).db).filter(x=>x.includes(old)||x.includes('Inna Córka')),[],'no old or new name in any log');
 const more=[...steps,{actor:'u-par',type:'athlete.forget',payload:{profileId:'p-kid'}}],c=runJs(rich(),more),d=bridge({job:'execute',db:rich(),commands:more});compare(c,d,more);
 assert.ok(!/Zawodnik KID Testowy|Inna Córka/.test(JSON.stringify(c.db.tournaments)),'athlete.forget: neither logs nor snapshots');
});
test('Domain::retain turns the names in logs of old community tournaments into initials, also of entries withdrawn long ago (§6.7)',{skip},()=>{
 const {db}=logged(),{db:out,out:counts}=bridge({job:'retain',db,cutoff:day(400),limit:0});
 const community=new Set(['t-org1','t-org1-hidden','t-org2','t-org2-closed','t-org3']);
 for(const t of out.tournaments.filter(t=>community.has(t.id)))for(const x of t.activity)assert.doesNotMatch(x.text,/Testowy|Zawodnika/,t.id+': '+x.text);
 assert.ok(out.tournaments.find(t=>t.id==='t-org2').activity.some(x=>x.text==='Wycofano zgłoszenie: Z. T.'),'a withdrawn entry, named in no snapshot');
 assert.ok(out.tournaments.find(t=>t.id==='t-staff-self').activity.some(x=>x.text==='Wycofano zgłoszenie: Zawodnik KID Testowy'),'staff tournaments keep names');
 assert.equal(counts.logs,3);assert.equal(counts.profiles,0);
});
test('Domain::retain (PHP only): idle organizer profiles forgotten up to the limit, community names as initials, tombstones purged (§6.7)',{skip},()=>{
 const db=rich();db.withdrawals=[];
 const {db:out,out:counts}=bridge({job:'retain',db,cutoff:day(400),limit:2});
 assert.equal(counts.profiles,2,'at most the limit per run');
 const left=['p-o1a','p-o1b','p-o2','p-o3'].filter(id=>{const a=out.profiles.find(x=>x.id===id);return a&&a.name!=='Dane usunięte';});assert.equal(left.length,2);
 assert.ok(out.profiles.some(p=>p.id==='p-self'&&p.ownerId==='u-ath')&&out.profiles.some(p=>p.id==='p-kid'&&p.ownerId==='u-par'),'profiles of athlete accounts stay while the account exists');
 assert.ok(out.profiles.some(p=>p.id==='p-ed'),'staff profiles stay');
 for(const id of ['t-org1','t-org2','t-org2-closed','t-org3'])for(const e of out.tournaments.find(t=>t.id===id).entries)assert.match(e.name,/^\p{Lu}\.( \p{Lu}\.)?$/u,id+': '+e.name);
 assert.ok(out.tournaments.find(t=>t.id==='t-staff-self').entries.some(e=>e.name==='Zawodnik ED Testowy'),'staff tournaments keep names');
 assert.ok(counts.snapshots>0);assert.match(out.withdrawalsPurge,/^\d{4}-\d{2}-\d{2}$/);
 const none=bridge({job:'retain',db,cutoff:'2000-01-01'});assert.deepEqual(none.out,{profiles:0,snapshots:0,logs:0});assert.equal(none.db.revision,db.revision,'nothing to retain: no new revision');
});
