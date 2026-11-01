// Member roles over real PHP and MariaDB/MySQL (PLAN-REJESTRACJA-ROLE §3.7, §4.3–§4.6, §5.5, §6.6–§6.7, §8.1; slice
// accounts-backend; run through scripts/test-http.sh): sign-up with roles (atomic, mass assignment, no workspace lock,
// pending club name at the quota, duplicate e-mail limit), the roles route, the organizer's flow (tournament, limits,
// finished before the date, paused publishing, profile with a new club and guardian consent, entry, check-in with a club
// override, draw, result, #screen with unchanged), revision isolation and the member bucket, the password step-up, the
// JSON leak scan and organizerSnapshot, the Administrator's tools with account_audit, account deletion and the cleanup and
// retention jobs, and the chat lobby. Switches of the effective configuration are set by fixture roles-settings, and the
// assertions that need them read the flags it reports (the effective configuration may come from the database).
import test,{before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
import {categories,resolveDraw} from '../dist/engine.js';
const skip=!base,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
const now=()=>Math.floor(Date.now()/1000);
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const sid=c=>c.cookie.split('=')[1];
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
async function signIn(email,password=PASSWORD){const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
/** A member with a complete profile (full access unless exempt is false); organizer: users.organizer=1; trusted: confirmed by the Administrator. */
function member(prefix,{organizer=false,trusted,exempt=true}={}){
 const email=uniq(prefix)+'@roles.test',m=fixture('member',{email,profile:true,exempt});
 if(organizer||trusted!==undefined)fixture('domain-organizer',{userId:m.id,organizer,...(trusted!==undefined?{trusted}:{})});
 return {...m,email};
}
const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']},E={events:['forms'],weight:70,height:175,gradeType:'cup',grade:5};
const T=(over={})=>({name:'Turniej Ról',city:'Opole',date:day(30),mat:'Mata 1',status:'open',...over});
const command=(c,type,payload,revision=c.data.revision)=>c.req('command',{type,payload,expectedRevision:revision});
const error=(r,status,message)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(message)assert.equal(r.data.error,message);};
/** An athlete member with an own adult profile (domain-run: the command as the athlete routes run it); returns {member, profileId}. */
function athlete(prefix,over={}){
 const m=member(prefix),r=fixture('domain-run',{actor:m.id,type:'athlete.save',payload:{relation:'self',name:'Zawodnik '+uniq('z'),birthDate:'1995-04-04',sex:'M',weight:70,height:175,gradeType:'cup',grade:5,club:{none:true},...over}});
 assert.equal(r.status,200,JSON.stringify(r));return {...m,profileId:r.result.id};
}
const selfEntry=(a,tournamentId)=>{const r=fixture('domain-run',{actor:a.id,type:'entry.self',payload:{tournamentId,profileId:a.profileId,events:['forms']}});assert.equal(r.status,200,JSON.stringify(r));return r;};
const tour=(c,id)=>c.data.tournaments.find(t=>t.id===id);
const audit=since=>fixture('roles-audit',{since});
/**
 * Puts back what fixture roles-settings changed. roles-settings-restore skips the app_settings row when there was none
 * before (old.row null reads as "no table" there), so that row, which only roles-settings wrote, is deleted here.
 */
const restoreSettings=s=>{fixture('roles-settings-restore',{old:s.old});if(s.old.row===null)fixture('settings-reset');};
const admin=async()=>{const c=await signIn(...ADMIN);await c.load();return c;};
const adminList=async(a,body)=>{const r=await a.req('admin-members',{filter:'all',page:1,...body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const adminMember=async(a,body,status=200)=>{const r=await a.req('admin-member',body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
/** Holds the workspace lock (app_meta FOR UPDATE) from another connection for `seconds`; resolves `locked` once it is held. */
function holdLock(seconds){
 const p=spawn(php,[fileURLToPath(new URL('./helpers/fixture.php',import.meta.url))],{env:process.env});let out='';
 const done=new Promise(resolve=>p.on('exit',resolve));
 const locked=new Promise((resolve,reject)=>{p.stdout.on('data',d=>{out+=d;if(out.includes('locked'))resolve();});p.on('exit',code=>reject(new Error(`lock holder exited ${code}: ${out}`)));});
 p.stdin.end(JSON.stringify({job:'roles-hold-lock',payload:{seconds}}));return {locked,done};
}
/** A session that started the sign-up form 10 s ago (server-measured time, §3.6). */
async function begun(){const c=await fresh();const r=await c.req('signup-begin',{});assert.equal(r.status,200,JSON.stringify(r.data));fixture('session-edit',{sid:sid(c),set:{signup_at:now()-10}});return c;}
const signupBody=(over={})=>({email:uniq('rola')+'@roles.test',password:PASSWORD,firstName:'Ola',lastName:'Nowak',username:uniq('ola'),country:'PL',sports:['taekwondo'],clubText:null,showClub:false,website:'',...over});
const athleteBody=(over={})=>({relation:'self',name:'Ola Nowak',birthDate:'1990-05-05',sex:'F',weight:60,height:168,gradeType:'cup',grade:6,club:{none:true},...over});
/** The bracket category of tournament $t that holds every profile of $ids. */
const bracketOf=(t,ids)=>categories(t.entries).items.find(c=>c.type==='bracket'&&ids.every(id=>c.athletes.some(a=>a.profileId===id)));

before(()=>fixture('reset-limits'));
beforeEach(()=>fixture('reset-limits'));

test('sign-up with roles: atomic, mass assignment ignored, no workspace lock, pending club at the quota, duplicate e-mails',{skip},async()=>{
 // A bad athlete creates nothing: the athlete is validated before any transaction.
 let c=await begun();const bad=signupBody();
 error(await c.req('signup',{...bad,roles:{athlete:true,organizer:true},athlete:athleteBody({birthDate:day(-365*12)})}),422,'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
 error(await c.req('signup',{...bad,roles:{athlete:true},athlete:athleteBody({club:{id:'no-such-club'}})}),404,'Klub nie istnieje.');
 error(await c.req('signup',{...bad,roles:{athlete:true},athlete:{...athleteBody(),relation:undefined}}),422,'Wybierz, kogo zgłaszasz.');
 assert.equal(fixture('roles-user',{email:bad.email}),null,'no account after a refused athlete');
 // Mass assignment: only roles.organizer and roles.athlete count; the athlete's fields are a closed list.
 const club='Klub Rodzica '+uniq('k'),good=signupBody({role:'admin',caps:{organizer:true,organizerTrusted:true},organizer_trusted_at:1,organizerTrustedAt:1,organizer_blocked_at:null,ownerId:'x',createdBy:'x',hiddenBy:'x',champion:true,self:true,createdAt:1,rev:99,
  roles:{organizer:true,athlete:true,admin:true,trusted:true}});
 let r=await c.req('signup',{...good,athlete:athleteBody({relation:'guardian',name:'Kuba Nowak',birthDate:day(-365*10),sex:'M',weight:35,height:140,grade:9,ownerId:'evil',createdBy:'evil',champion:true,events:['power'],archived:true,rev:7,id:'chosen-id',club:{name:club}})});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(Object.keys(r.data).sort(),['caps','csrf','user']);
 assert.deepEqual(r.data.caps,{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:true});assert.equal(r.data.user.role,'member');
 const st=fixture('roles-user',{email:good.email});
 assert.deepEqual([st.user.role,st.user.organizer,st.user.organizer_trusted_at,st.user.organizer_blocked_at,st.billing.billing_exempt],['member',1,null,null,0],'paid mode: not exempt');
 assert.equal(st.profiles.length,1);const p=st.profiles[0];
 assert.deepEqual([p.ownerId,p.createdBy,p.archived,p.rev,p.data.champion,p.data.events,p.data.relation,p.data.name,p.data.ownerId,p.data.createdBy],[st.user.id,st.user.id,0,0,false,['forms'],'guardian','Kuba Nowak',st.user.id,st.user.id]);
 assert.notEqual(p.id,'chosen-id');assert.ok(p.data.guardianDeclaredAt>0);
 assert.deepEqual(st.clubs.map(x=>[x.name,x.verified]),[[club,0]],'a new, unverified club');assert.equal(p.clubId,st.clubs[0].id);
 const m=(await c.req('me')).data;assert.deepEqual(m.user.caps,r.data.caps);assert.deepEqual(m.athletes,[{profileId:p.id,name:'Kuba Nowak',relation:'guardian',archived:false}]);
 // The same club name again (another case): the existing club is reused, no second row.
 const same=signupBody();r=await (await begun()).req('signup',{...same,roles:{athlete:true},athlete:athleteBody({club:{name:club.toUpperCase()}})});assert.equal(r.status,200,JSON.stringify(r.data));
 const s2=fixture('roles-user',{email:same.email});assert.deepEqual([s2.profiles[0].clubId,s2.clubs.length,r.data.caps.organizer],[st.clubs[0].id,0,false],'the club of the same key is reused');
 // A name equal only under the collation of clubs.name (utf8mb4_unicode_ci: ß = ss, MariaDB and MySQL 8.0 alike), not
 // under Clubs::key: the plain INSERT gets 1062 and the profile takes the existing club, or the club it was merged into.
 const ad=await admin(),tag=uniq('x'),clubOf=async name=>{const id=(await ad.cmd('profile.save',{...A,name:'Admin '+uniq('p'),clubName:name})).id;await ad.load();return ad.data.profiles.find(x=>x.id===id).clubId;};
 const strasse=await clubOf('Strasse Testowa '+tag),merged=await clubOf('Strasse Druga '+tag),into=await clubOf('Klub Docelowy '+tag);
 await ad.cmd('club.merge',{id:merged,into});
 for(const [name,want] of [['Straße Testowa '+tag,strasse],['Straße Druga '+tag,into]]){
  const b=signupBody();r=await (await begun()).req('signup',{...b,roles:{athlete:true},athlete:athleteBody({club:{name}})});assert.equal(r.status,200,JSON.stringify(r.data));
  const sx=fixture('roles-user',{email:b.email});assert.deepEqual([sx.profiles[0].clubId,sx.clubs.length],[want,0],name);
 }
 // No workspace lock: a sign-up with an athlete ends while another connection holds app_meta FOR UPDATE.
 const hold=holdLock(5);await hold.locked;const waiting=await begun();const t0=performance.now();
 r=await waiting.req('signup',{...signupBody(),roles:{athlete:true},athlete:athleteBody()});const took=performance.now()-t0;await hold.done;
 assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(took<3500,`the sign-up waited for the workspace lock (${Math.round(took)} ms)`);
 // Quota of new clubs used up (30 per day): unaffiliated with the pending name and notice club-pending.
 const filled=fixture('roles-clubs-fill');
 try{
  const name='Klub Oczekujący '+uniq('k'),b=signupBody();
  r=await (await begun()).req('signup',{...b,roles:{athlete:true},athlete:athleteBody({club:{name}})});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.notice,'club-pending');
  const s=fixture('roles-user',{email:b.email});assert.deepEqual([s.profiles[0].clubId,s.profiles[0].data.pendingClubName,s.clubs.length],['unaffiliated',name,0]);
 }finally{fixture('roles-clubs-remove',{ids:filled});}
 // Duplicate e-mails: 5 per hour and network, then 429 for every outcome (taken, free and the bot trap alike).
 fixture('reset-limits');
 for(let i=0;i<5;i++)error(await (await begun()).req('signup',signupBody({email:good.email})),409,'Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.');
 for(const b of [signupBody({email:good.email}),signupBody(),signupBody({website:'x'})]){
  const x=await (await begun()).req('signup',b);error(x,429,'Zbyt wiele prób zakładania konta. Spróbuj ponownie później.');assert.ok(Number(x.headers.get('retry-after'))>0&&x.data.retry>0);
 }
 fixture('reset-limits');
 // An organizer account per network and day: 3 (shared with the roles route).
 for(let i=0;i<3;i++)assert.equal((await (await begun()).req('signup',signupBody({roles:{organizer:true}}))).status,200,'organizer '+i);
 error(await (await begun()).req('signup',signupBody({roles:{organizer:true}})),429,'Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.');
 assert.equal((await (await begun()).req('signup',signupBody())).status,200,'without the organizer role');
});

test('roles: the own organizer switch; open tournaments 409; blocked 403; 10 changes per hour; 3 per network and day; audited',{skip},async()=>{
 const m=member('rolesw'),c=await signIn(m.email);
 error(await c.req('roles',{organizer:'yes'}),400);
 let r=await c.req('roles',{organizer:true});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.deepEqual(r.data.caps,{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false});
 await c.load();assert.equal(c.data.user.caps.organizer,true);
 const t=(await c.cmd('tournament.save',T())).id;
 error(await c.req('roles',{organizer:false}),409,'Masz turnieje z otwartymi lub zamkniętymi zapisami. Zakończ je albo przełącz na roboczy, zanim wyłączysz rolę organizatora.');
 await c.cmd('tournament.save',{...T(),id:t,status:'draft'});
 r=await c.req('roles',{organizer:false});assert.equal(r.status,200);assert.equal(r.data.caps.organizer,false);
 const w=(await c.req('bootstrap')).data;assert.deepEqual([w.tournaments,w.profiles,w.user.caps],[[],[],undefined],'no role: the empty member workspace');
 error(await command(c,'tournament.save',T(),w.revision),403,'Brak uprawnień.');
 const a=await admin();await adminMember(a,{action:'organizer',userId:m.id,blocked:true});
 error(await c.req('roles',{organizer:true}),403,'Administrator wyłączył Ci rolę organizatora.');
 assert.deepEqual((await c.req('bootstrap')).data.user.caps,{organizer:false,organizerBlocked:true,organizerTrusted:false,athlete:false});
 await adminMember(a,{action:'organizer',userId:m.id,blocked:false});
 assert.deepEqual(fixture('roles-user',{email:m.email}).audit.map(x=>[x.actor_id,x.action,x.note]),[['self','self.organizer','on'],['self','self.organizer','off'],[a.data.user.id,'organizer.block',null],[a.data.user.id,'organizer.unblock',null]]);
 // 3 switched on per network and day (the sign-up shares the bucket).
 fixture('reset-limits');
 for(let i=0;i<3;i++){const x=await signIn(member('rolesip').email);assert.equal((await x.req('roles',{organizer:true})).status,200,'on '+i);}
 error(await (await signIn(member('rolesip').email)).req('roles',{organizer:true}),429,'Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.');
 // 10 changes per hour and account (a repeated value counts too).
 fixture('reset-limits');
 for(let i=0;i<10;i++)assert.equal((await c.req('roles',{organizer:false})).status,200,'change '+i);
 const x=await c.req('roles',{organizer:false});error(x,429,'Zbyt wiele zmian ról. Spróbuj ponownie później.');assert.ok(Number(x.headers.get('retry-after'))>0);
 error(await (await signIn(...ADMIN)).req('roles',{organizer:true}),403,'Brak uprawnień.');
});

test('organizer: tournament, limits, finished before the date, paused publishing, profile with a new club and consent, entry, check-in with a club override, draw, result, #screen unchanged',{skip},async()=>{
 const o=member('org',{organizer:true}),c=await signIn(o.email);await c.load();
 assert.deepEqual(c.data.user,{id:o.id,clubId:null,email:o.email,role:'member',active:true,caps:{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false}});
 assert.deepEqual(c.data.users,[],'never staff accounts');
 const t=(await c.cmd('tournament.save',T({name:'Turniej Organizatora'}))).id;
 const flags=fixture('roles-flags');assert.deepEqual([tour(c,t).selfEntry,tour(c,t).community,tour(c,t).status,tour(c,t).trusted],[true,true,'open',!flags.trustRequired]);
 error(await command(c,'tournament.save',{...T({name:'Turniej Organizatora'}),id:t,status:'finished'}),422,'Turniej można zakończyć najwcześniej w dniu zawodów.');
 // 3 new tournaments per day, drafts too.
 await c.cmd('tournament.save',T({name:'Drugi',status:'draft'}));await c.cmd('tournament.save',T({name:'Trzeci',status:'draft'}));
 let r=await command(c,'tournament.save',T({name:'Czwarty',status:'draft'}));error(r,429,'Limit nowych turniejów: 3 na dobę.');assert.ok(r.data.retry>0);
 error(await command(c,'tournament.save',T({name:'Kontakt www.przyklad.pl',status:'draft'})),422,'Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.');
 // Paused publishing (a second, unconfirmed organizer): no new published tournament; drafts and published ones keep working.
 const c2=await signIn(member('orgp',{organizer:true}).email);await c2.load();
 const s=fixture('roles-settings',{organizers:'paused',trustRequired:true});
 try{
  r=await command(c2,'tournament.save',T({name:'Wstrzymany'}));
  if(s.flags.organizers==='paused'&&s.flags.trustRequired)error(r,409,'Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.');else assert.equal(r.status,200);
  await c2.load();await c2.cmd('tournament.save',T({name:'Roboczy',status:'draft'}));
  await c.cmd('tournament.save',{...T({name:'Turniej Organizatora'}),id:t,city:'Opole Wieś'});
 }finally{restoreSettings(s);}
 // A child added by the organizer needs the guardian's consent; a new club is unverified.
 const club='Klub Organizatora '+uniq('k'),kid={name:'Dziecko Testowe',birthDate:day(-365*10-30),sex:'F',weight:35,height:140,gradeType:'cup',grade:8,events:['forms'],clubName:club};
 error(await command(c,'profile.save',kid),422,'Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.');
 const kidId=(await c.cmd('profile.save',{...kid,guardianConsent:true})).id,kp=c.data.profiles.find(x=>x.id===kidId),kc=c.data.clubs.find(x=>x.id===kp.clubId);
 assert.deepEqual([kc.name,kc.verified,kp.staff,kp.relation],[club,false,false,undefined]);assert.ok(kp.guardianConsentAt>0);
 await c.cmd('entry.save',{tournamentId:t,profileId:kidId,events:['forms'],weight:35,height:140,gradeType:'cup',grade:8});
 // Three adults in one category: two of the organizer's profiles and an athlete's self-entry.
 const p1=(await c.cmd('profile.save',{...A,name:'Adam Pierwszy',clubName:club})).id,p2=(await c.cmd('profile.save',{...A,name:'Bartek Drugi',club:{none:true}})).id;
 await c.cmd('entry.save',{tournamentId:t,profileId:p1,...E});await c.cmd('entry.save',{tournamentId:t,profileId:p2,...E});
 const ath=athlete('orgath',{name:'Czesław Własny'});selfEntry(ath,t);
 await c.load();let te=tour(c,t);const own=te.entries.find(e=>e.profileId===ath.profileId);
 assert.deepEqual([own.self,own.name,own.clubId],[true,'Czesław Własny','unaffiliated']);assert.ok(!c.data.profiles.some(x=>x.id===ath.profileId),'the athlete profile itself stays hidden');
 // Check-in: the organizer corrects the club of the self-entry (identity kept), then confirms presence.
 await c.cmd('entry.save',{tournamentId:t,profileId:ath.profileId,update:true,clubId:kc.id,...E,name:'Ktoś Inny',sex:'F'});
 te=tour(c,t);const fixed=te.entries.find(e=>e.profileId===ath.profileId);
 assert.deepEqual([fixed.clubId,fixed.club,fixed.name,fixed.sex,fixed.self],[kc.id,club,'Czesław Własny','M',true]);assert.equal(te.activity[0].text,'Zmieniono klub w zgłoszeniu: Czesław Własny');
 await c.cmd('checkin.save',{tournamentId:t,id:ath.profileId,presence:'present',actualWeight:70.4});
 // Draw and a result.
 const cat=bracketOf(tour(c,t),[p1,p2,ath.profileId]);assert.ok(cat,'one bracket for the three adults');
 await c.cmd('draw.create',{tournamentId:t,categoryId:cat.id});
 const match=resolveDraw(tour(c,t).draws[cat.id]).flat().find(x=>x.ready);await c.cmd('result.save',{tournamentId:t,categoryId:cat.id,matchId:match.id,winnerId:match.a});
 assert.equal(tour(c,t).draws[cat.id].results[match.id],match.a);
 // #screen: ?t&rev answers unchanged without a workspace and without counting; 1500 per hour and session otherwise.
 te=tour(c,t);r=await c.req(`bootstrap&t=${t}&rev=${te.rev}`);assert.deepEqual([r.status,r.data],[200,{unchanged:true}]);
 r=await c.req(`bootstrap&t=${t}&rev=${te.rev-1}`);assert.equal(r.status,200);assert.equal(r.data.tournaments.find(x=>x.id===t).rev,te.rev);
 assert.equal((await c.req(`bootstrap&t=other&rev=${te.rev}`)).data.unchanged,undefined,'an unknown tournament is never unchanged');
 fixture('roles-bucket',{scope:'organizer-bootstrap',key:sid(c),attempts:1500});
 assert.deepEqual((await c.req(`bootstrap&t=${t}&rev=${te.rev}`)).data,{unchanged:true},'unchanged answers are not counted');
 r=await c.req('bootstrap');error(r,429,'Zbyt wiele operacji. Spróbuj ponownie za chwilę.');assert.ok(Number(r.headers.get('retry-after'))>0);
 fixture('reset-limits');
 // Staff get unchanged answers too.
 const a=await admin();assert.deepEqual((await a.req(`bootstrap&t=${t}&rev=${tour(a,t).rev}`)).data,{unchanged:true});
 // Account commands are never organizer commands.
 error(await command(c,'account.password',{id:o.id,currentPassword:PASSWORD,password:'Another-Password-2026'}),403,'Brak uprawnień.');
 error(await command(c,'club.save',{id:kc.id,verified:true}),403,'Brak uprawnień.');
 // Without full access (paid mode): 402, except removing data.
 fixture('billing',{userId:o.id,billing_exempt:0});
 error(await command(c,'tournament.save',T({name:'Bez dostępu',status:'draft'})),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 assert.equal((await command(c,'entry.remove',{tournamentId:t,id:kidId})).status,200,'withdrawing works without full access');
});

test('revision isolation: an organizer at his limit and self-entries in A never make an editor\'s check-in in B stale; the member bucket',{skip},async()=>{
 const a=await admin(),email=uniq('edytor')+'@roles.test';
 await a.cmd('account.save',{email,password:PASSWORD,clubId:a.data.user.clubId,role:'editor'});
 const ed=await signIn(email);await ed.load();
 const tb=(await ed.cmd('tournament.save',T({name:'Turniej B',date:day(20)}))).id,pb=(await ed.cmd('profile.save',{...A,name:'Edward Personel',clubId:a.data.user.clubId})).id;
 await ed.cmd('entry.save',{tournamentId:tb,profileId:pb,...E});
 const o=member('iso',{organizer:true}),c=await signIn(o.email);await c.load();
 const ta=(await c.cmd('tournament.save',T({name:'Turniej A',date:day(21)}))).id,pa=(await c.cmd('profile.save',{...A,name:'Olek Organizatora',club:{none:true}})).id;
 await c.cmd('entry.save',{tournamentId:ta,profileId:pa,...E});
 const athletes=[athlete('isoa'),athlete('isob')];
 let limited=null,checks=0;
 for(let i=0;i<70&&!limited;i++){
  const r=await command(c,'checkin.save',{tournamentId:ta,id:pa,presence:i%2?'present':'pending',actualWeight:70});
  if(r.status===429){limited=r;break;}
  assert.equal(r.status,200,JSON.stringify(r.data));c.data=r.data.workspace;
  // An athlete's change in A makes the organizer's next command in A stale (rightly: the same tournament), so his screen reloads.
  if(i%7===0){const k=i/7,x=athletes[k%2],enter=Math.floor(k/2)%2===0;const r2=fixture('domain-run',{actor:x.id,type:enter?'entry.self':'entry.remove',payload:enter?{tournamentId:ta,profileId:x.profileId,events:['forms']}:{tournamentId:ta,id:x.profileId}});assert.equal(r2.status,200,JSON.stringify(r2));c.data.revision=r2.revision;}
  if(i%5===0){const before=ed.data.revision;await ed.cmd('checkin.save',{tournamentId:tb,id:pb,presence:checks%2?'pending':'present',actualWeight:71});checks++;assert.ok(ed.data.revision>before);}
 }
 assert.ok(limited,'the organizer reached 60 commands per minute');error(limited,429,'Zbyt wiele operacji. Spróbuj ponownie za chwilę.');assert.ok(Number(limited.headers.get('retry-after'))>0);
 assert.ok(checks>=10,'the editor checked in '+checks+' times');
 // The editor's revision is older than the global one after the organizer's commands, and B did not change: no 409.
 const rev=ed.data.revision,moved=fixture('domain-run',{actor:athletes[1].id,type:'athlete.save',payload:{id:athletes[1].profileId,...athleteBody({sex:'M',birthDate:'1995-04-04',name:'Zmienione Imię',weight:71})}});
 assert.equal(moved.status,200,JSON.stringify(moved));assert.ok(moved.revision>rev);
 assert.equal((await command(ed,'checkin.save',{tournamentId:tb,id:pb,presence:'present',actualWeight:72},rev)).status,200);
 // A change in B itself still makes an older revision stale.
 error(await command(ed,'checkin.save',{tournamentId:tb,id:pb,presence:'pending'},rev),409,'Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.');
 // The global bucket of member transactions (120 per minute): 429 with Retry-After for members, staff unaffected.
 fixture('reset-limits');fixture('roles-bucket',{scope:'member-tx',key:'all',attempts:120});
 const full=await command(c,'checkin.save',{tournamentId:ta,id:pa,presence:'present',actualWeight:70});
 error(full,429,'Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.');assert.ok(Number(full.headers.get('retry-after'))>0&&full.data.retry>0);
 await ed.load();assert.equal((await command(ed,'checkin.save',{tournamentId:tb,id:pb,presence:'pending'})).status,200,'staff never wait for the member bucket');
 // Commands refused with 402 (an organizer without a subscription) never take the global budget: it is counted after the 402.
 fixture('reset-limits');fixture('roles-bucket',{scope:'member-tx',key:'all',attempts:119});
 const unpaid=member('isonp',{organizer:true,exempt:false}),np=await signIn(unpaid.email);await np.load();
 for(let i=0;i<3;i++)error(await command(np,'tournament.save',T({name:'Bez Subskrypcji'})),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 await c.load();assert.equal((await command(c,'checkin.save',{tournamentId:ta,id:pa,presence:'pending',actualWeight:70})).status,200,'the last unit of the bucket is still free');
 error(await command(c,'checkin.save',{tournamentId:ta,id:pa,presence:'present',actualWeight:70}),429,'Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.');
 fixture('reset-limits');
});

test('step-up: reauth after 30 idle minutes and after 12 hours, organizer-unlock; the chat and own data stay signed in',{skip},async()=>{
 const o=member('stepup',{organizer:true}),c=await signIn(o.email);await c.load();
 const reauth=r=>{assert.deepEqual([r.status,r.data.error,r.data.code],[401,'Potwierdź hasło, aby otworzyć narzędzia organizatora.','reauth']);assert.ok(r.data.csrf);};
 fixture('session-edit',{sid:sid(c),set:{ws:{at:now()-120,last:now()-31*60}}});
 reauth(await c.req('bootstrap'));reauth(await command(c,'tournament.save',T({status:'draft'})));
 // The session itself is alive: session, me, roles, the chat and the athlete routes (when installed) answer as before.
 assert.equal((await c.req('session')).data.user.id,o.id);assert.equal((await c.req('me')).status,200);
 assert.equal((await c.req('chat-channels')).status,200);
 const athleteRoute=await c.req('athlete');if(athleteRoute.data?.error!=='Nie ma takiej operacji.')assert.equal(athleteRoute.status,200,JSON.stringify(athleteRoute.data));
 reauth(await c.req('bootstrap'));
 // A wrong password is 422 (not 401: the client must not take it for an ended session), with the login limits.
 const wrong=await c.req('organizer-unlock',{password:'Wrong-Password-2026'});error(wrong,422,'Nieprawidłowe hasło.');
 const before=sid(c),csrf=c.csrf,r=await c.req('organizer-unlock',{password:PASSWORD});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.ok,true);assert.notEqual(r.data.csrf,csrf);assert.notEqual(sid(c),before,'a new session id');
 const cookie=r.headers.getSetCookie().at(-1);assert.match(cookie,/expires=/i,'the member cookie keeps its expiry');
 assert.equal((await c.req('bootstrap')).status,200);assert.equal((await command(c,'tournament.save',T({status:'draft'}))).status,200);
 // 12 hours after the password, even while active; a session from before this release (no ws) asks too.
 fixture('session-edit',{sid:sid(c),set:{ws:{at:now()-12*3600-10,last:now()}}});reauth(await c.req('bootstrap'));
 fixture('session-edit',{sid:sid(c),set:{ws:null}});reauth(await c.req('bootstrap'));
 // Login limits on the own e-mail: 8 wrong passwords, then 429.
 fixture('reset-limits');for(let i=0;i<8;i++)error(await c.req('organizer-unlock',{password:'Wrong-Password-2026'}),422);
 error(await c.req('organizer-unlock',{password:PASSWORD}),429,'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.');fixture('reset-limits');
 // A member without the organizer role is never asked; staff cannot use organizer-unlock.
 const plain=await signIn(member('stepplain').email);fixture('session-edit',{sid:sid(plain),set:{ws:{at:0,last:0}}});assert.equal((await plain.req('bootstrap')).status,200);
 error(await (await signIn(...ADMIN)).req('organizer-unlock',{password:ADMIN[1]}),403,'Brak uprawnień.');
});

test('JSON leak scan: organizer, editor and club see no foreign names, birth dates or ids; organizerSnapshot equals the full workspace',{skip},async()=>{
 const a=await admin(),secret={staff:'Tajny Personelowy '+uniq('s'),org2:'Obcy Zawodnik '+uniq('o'),athlete:'Samodzielny Obcy '+uniq('a'),own:'Moja Zawodniczka '+uniq('m')};
 const clubEmail=uniq('klub')+'@roles.test',edEmail=uniq('edytor')+'@roles.test';
 await a.cmd('account.save',{email:clubEmail,password:PASSWORD,clubName:'Klub Szpiega '+uniq('k'),role:'club'});await a.cmd('account.save',{email:edEmail,password:PASSWORD,clubId:a.data.user.clubId,role:'editor'});
 const spyClub=a.data.users.find(u=>u.email===clubEmail).clubId;
 // Staff: a tournament with a staff profile (and self-entries allowed).
 const ts=(await a.cmd('tournament.save',{...T({name:'Turniej Personelu'}),selfEntry:true})).id;
 const ps=(await a.cmd('profile.save',{...A,name:secret.staff,birthDate:'2011-03-17',clubId:a.data.user.clubId,registration:{...E,tournamentId:ts}})).id;
 // A second, confirmed organizer with a profile and an athlete's self-entry (the athlete chose the club of the club account).
 const o2=member('leak2',{organizer:true,trusted:true}),c2=await signIn(o2.email);await c2.load();
 const tf=(await c2.cmd('tournament.save',T({name:'Turniej Obcy'}))).id,pf=(await c2.cmd('profile.save',{...A,name:secret.org2,birthDate:'2012-07-21',club:{none:true},guardianConsent:true})).id;
 await c2.cmd('entry.save',{tournamentId:tf,profileId:pf,events:['forms'],weight:40,height:150,gradeType:'cup',grade:8});
 const x=athlete('leakath',{name:secret.athlete,birthDate:'1993-09-29',club:{id:spyClub}});selfEntry(x,tf);
 // The organizer under test: his tournament and profile, and an entry of his profile in the other organizer's tournament.
 const o1=member('leak1',{organizer:true}),c1=await signIn(o1.email);await c1.load();
 const ta=(await c1.cmd('tournament.save',T({name:'Turniej Własny'}))).id,po=(await c1.cmd('profile.save',{...A,name:secret.own,birthDate:'1996-01-02',club:{none:true}})).id;
 await c1.cmd('entry.save',{tournamentId:ta,profileId:po,...E});await c1.cmd('entry.save',{tournamentId:tf,profileId:po,...E});
 const raw=async c=>JSON.stringify((await c.req('bootstrap')).data);
 const hits=(json,list)=>list.filter(s=>json.includes(s));
 const j1=await raw(c1);
 assert.deepEqual(hits(j1,[secret.staff,'2011-03-17',ps,secret.org2,'2012-07-21',pf,secret.athlete,'1993-09-29',x.profileId,x.id,o2.id]),[],'organizer');
 assert.ok(j1.includes(secret.own)&&j1.includes(tf),'his own data and the tournament he entered');
 const w1=JSON.parse(j1);assert.deepEqual(w1.tournaments.find(t=>t.id===tf).entries.map(e=>e.profileId),[po],'only his entries elsewhere');assert.deepEqual(w1.tournaments.find(t=>t.id===tf).draws,{});
 const ed=await signIn(edEmail),je=await raw(ed);
 assert.deepEqual(hits(je,[secret.org2,'2012-07-21',pf,secret.athlete,'1993-09-29',x.profileId,secret.own,po,o1.id,o2.id]),[],'editor');
 const cl=await signIn(clubEmail),jc=await raw(cl);
 assert.deepEqual(hits(jc,[secret.org2,pf,secret.athlete,x.profileId,secret.own,po,secret.staff,ps]),[],'club representative');
 // organizerSnapshot gives what publicData of the whole workspace gives, and bootstrap sends exactly that.
 const s=fixture('roles-snapshot',{userId:o1.id});assert.deepEqual(s.snapshot,s.full);
 const {user:u1,...rest}=JSON.parse(await raw(c1)),{user:_u,...snap}=s.snapshot;assert.deepEqual(rest,snap);assert.deepEqual(Object.keys(u1),['id','clubId','email','role','active','caps']);
});

test('Administrator: confirm organizers, take the role with hidden tournaments, bulk action, ownerOf, filters, pending count, account_audit',{skip},async()=>{
 const since=now(),a=await admin(),adminId=a.data.user.id;
 const s=fixture('roles-settings',{trustRequired:true});
 try{
  const o=member('adm-org',{organizer:true}),c=await signIn(o.email);await c.load();
  const t1=(await c.cmd('tournament.save',T({name:'Do Ukrycia'}))).id,t2=(await c.cmd('tournament.save',T({name:'Roboczy Do Ukrycia',status:'draft'}))).id;
  const ath=athlete('adm-ath');selfEntry(ath,t1);
  const meA=(await a.req('me')).data;
  if(s.flags.trustRequired)assert.ok(meA.features.pendingOrganizers>=1,JSON.stringify(meA.features));
  const item=async(body)=>(await adminList(a,{q:o.email,...body})).items;
  assert.deepEqual((await item({filter:'organizers-pending'})).map(i=>[i.id,i.caps.organizer,i.tournaments,i.trusted]),[[o.id,true,2,undefined]]);
  assert.deepEqual((await item({filter:'organizers'})).length,1);assert.deepEqual(await item({filter:'athletes'}),[]);
  assert.deepEqual((await adminList(a,{q:ath.email,filter:'athletes'})).items.map(i=>[i.id,i.caps.athlete]),[[ath.id,true]]);
  assert.deepEqual((await adminList(a,{ownerOf:t1})).items.map(i=>i.id),[o.id]);assert.deepEqual((await adminList(a,{ownerOf:'nope'})).items,[]);
  error(await a.req('admin-members',{ownerOf:'x y'}),400);error(await a.req('admin-members',{filter:'organizers-x'}),422,'Nieznany filtr.');
  // Confirm and take the confirmation back.
  let r=await adminMember(a,{action:'organizer-trust',userId:o.id,trusted:true});assert.deepEqual(r,{id:o.id,caps:{organizer:true,organizerBlocked:false,organizerTrusted:true,athlete:false}});
  assert.deepEqual((await item({filter:'organizers-pending'})),[]);assert.equal((await item({}))[0].trusted,true);
  await c.load();assert.equal(tour(c,t1).trusted,true);
  r=await adminMember(a,{action:'organizer-trust',userId:o.id,trusted:false});assert.equal(r.caps.organizerTrusted,false);
  error(await a.req('admin-member',{action:'organizer-trust',userId:o.id,trusted:'yes'}),400);
  // A bad reason (over 200 characters) is refused before anything changes: no block, nothing hidden, nothing audited.
  error(await a.req('admin-member',{action:'organizer',userId:o.id,blocked:true,hideTournaments:true,reason:'x'.repeat(201)}),422,'Sprawdź pole: powód.');
  assert.deepEqual([fixture('domain-row',{table:'users',id:o.id}).organizer_blocked_at,fixture('domain-row',{table:'tournaments',id:t1}).hidden_by],[null,null]);
  // Take the role away and hide the upcoming tournaments; the self-entry is withdrawn with a tombstone.
  r=await adminMember(a,{action:'organizer',userId:o.id,blocked:true,hideTournaments:true,reason:'Podejrzany turniej'});
  assert.deepEqual(r,{id:o.id,caps:{organizer:false,organizerBlocked:true,organizerTrusted:false,athlete:false},hidden:2});
  for(const id of [t1,t2]){const row=fixture('domain-row',{table:'tournaments',id});assert.deepEqual([row.status,row.hidden_by],['draft',adminId]);}
  assert.equal(fixture('domain-row',{table:'tournaments',id:t1}).hidden_from,'open');
  assert.deepEqual(fixture('roles-entries',{tournamentId:t1}).map(e=>e.profileId),[]);assert.deepEqual(fixture('roles-withdrawals',{tournamentId:t1}).map(w=>[w.profile_id,w.by_kind]),[[ath.profileId,'admin']]);
  error(await command(c,'tournament.save',T({status:'draft'}),0),403,'Brak uprawnień.');
  assert.deepEqual((await c.req('bootstrap')).data.user.caps,{organizer:false,organizerBlocked:true,organizerTrusted:false,athlete:false});
  r=await adminMember(a,{action:'organizer',userId:o.id,blocked:false});assert.equal(r.caps.organizer,true);assert.ok(!('hidden' in r));
  // Block the account with its tournaments (the existing active action).
  const o3=member('adm-act',{organizer:true}),c3=await signIn(o3.email);await c3.load();const t3=(await c3.cmd('tournament.save',T({name:'Konto Do Blokady'}))).id;
  error(await a.req('admin-member',{action:'active',userId:o3.id,active:false,hideTournaments:true,reason:'y'.repeat(201)}),422,'Sprawdź pole: powód.');
  assert.deepEqual([fixture('roles-user',{email:o3.email}).user.active,fixture('domain-row',{table:'tournaments',id:t3}).hidden_by],[1,null],'a bad reason leaves the account active');
  assert.deepEqual(await adminMember(a,{action:'active',userId:o3.id,active:false,hideTournaments:true}),{id:o3.id,active:false,hidden:1});
  assert.equal(fixture('domain-row',{table:'tournaments',id:t3}).hidden_by,adminId);
  // Bulk: block and hide for several accounts, one failure does not stop the others.
  const b1=member('bulk',{organizer:true}),b2=member('bulk',{organizer:true});
  const tb=fixture('tournament',{createdBy:b1.id,name:'Zbiorczy',date:day(10)}).id;
  error(await a.req('admin-member',{action:'organizer-bulk',userIds:[b1.id,b2.id],block:true,hideTournaments:true,reason:'z'.repeat(201)}),422,'Sprawdź pole: powód.');
  assert.equal(fixture('domain-row',{table:'users',id:b1.id}).organizer_blocked_at,null,'a bad reason blocks no account');
  r=await adminMember(a,{action:'organizer-bulk',userIds:[b1.id,b2.id,'nope',b1.id],block:true,hideTournaments:true});
  assert.deepEqual(r,{done:[b1.id,b2.id],failed:[{id:'nope',error:'Konto nie istnieje.'}]});
  assert.equal(fixture('domain-row',{table:'tournaments',id:tb}).hidden_by,adminId);assert.ok(fixture('domain-row',{table:'users',id:b2.id}).organizer_blocked_at>0);
  // A server error for one account (a deadlock while blocking it) is logged without personal data and listed; the rest is done.
  const f1=member('bulkf',{organizer:true}),f2=member('bulkf',{organizer:true}),fault=fixture('roles-bulk-fault',{adminId,userIds:[f1.id,f2.id],fault:f1.id});
  assert.deepEqual(fault.result,{done:[f2.id],failed:[{id:f1.id,error:'Błąd serwera. Skontaktuj się z Administratorem.'}]});
  assert.match(fault.log,/MatDraw organizer-bulk: PDOException \S+ SQLSTATE 40001 code 1213/);assert.ok(!fault.log.includes(f1.email)&&!fault.log.includes(f1.id),fault.log);
  assert.deepEqual([fixture('domain-row',{table:'users',id:f1.id}).organizer_blocked_at,fixture('domain-row',{table:'users',id:f2.id}).organizer_blocked_at>0],[null,true]);
  error(await a.req('admin-member',{action:'organizer-bulk',userIds:Array.from({length:51},(_,i)=>'u'+i)}),400);error(await a.req('admin-member',{action:'organizer-bulk',userIds:[]}),400);
  // An account created by the Administrator while payments are not enforced is a free-signup account (sign-up off and
  // payments free: a combination config.php accepts before and after the settings panel).
  const old=fixture('accounts-config',{set:{billing_enforce:false,signup_enabled:false}}),freeEmail=uniq('wolne')+'@roles.test';let free;
  try{free=await adminMember(a,{action:'create',email:freeEmail,firstName:'Wolna',lastName:'Rejestracja',username:uniq('wolna'),country:'PL',sports:['karate'],organizer:true});}
  finally{fixture('accounts-config',{set:old});}
  const fl=(await adminList(a,{filter:'free-signup',q:freeEmail})).items.find(i=>i.id===free.id);assert.deepEqual([fl.freeSignup,fl.caps.organizer,fl.billing.reason],[true,true,'free-signup']);
  // account_audit: every Administrator action on roles and community data, without e-mails.
  const rows=audit(since).filter(x=>x.actor_id===adminId);
  const of=id=>rows.filter(x=>x.target_user_id===id).map(x=>x.action);
  assert.deepEqual(of(o.id),['organizer.trust','organizer.untrust','organizer.block','tournament.hide','tournament.hide','organizer.unblock']);
  assert.deepEqual(of(o3.id),['active','tournament.hide']);assert.deepEqual(of(b1.id),['organizer.block','tournament.hide']);assert.deepEqual(of(free.id),['create']);
  assert.equal(rows.find(x=>x.target_user_id===free.id).note,'free-signup organizer');
  assert.ok(rows.every(x=>!/@/.test(x.note??'')),'no e-mails in notes');
  // The command route audits tournament.hide, club.* and profile.forget of the Administrator.
  await c.load();const t4=(await c.cmd('tournament.save',T({name:'Do Ukrycia Komendą'}))).id;
  const kc=(await c.cmd('profile.save',{...A,name:'Do Zapomnienia Admina',clubName:'Klub Audytu '+uniq('k')})).id;await c.load();const clubId=c.data.profiles.find(p=>p.id===kc).clubId;
  await a.load();const lastId=Math.max(0,...audit(since).map(x=>x.id));
  await a.cmd('tournament.hide',{tournamentId:t4,hidden:true,reason:'Test'});await a.cmd('tournament.hide',{tournamentId:t4,hidden:false});
  await a.cmd('club.save',{id:clubId,verified:true});await a.cmd('profile.forget',{id:kc});
  const cmdRows=fixture('roles-audit',{since,afterId:lastId}).map(x=>[x.action,x.target_user_id,x.note]);
  assert.deepEqual(cmdRows.map(x=>x.slice(0,2)),[['tournament.hide',o.id],['tournament.hide',o.id],['club.save',null],['profile.forget',o.id]]);
  assert.match(cmdRows[0][2],new RegExp('^hidden '+t4+' · Do Ukrycia Komendą$'));assert.match(cmdRows[1][2],/^restored /);assert.equal(cmdRows[3][2],kc+' deleted');
  assert.ok(!cmdRows.some(x=>(x[2]??'').includes('Do Zapomnienia')),'no athlete names in notes');
 }finally{restoreSettings(s);}
});

test('account deletion forgets community data; brackets with results do not block it; accounts-cleanup skips community data; community-retention',{skip},async()=>{
 const o=member('del-org',{organizer:true}),c=await signIn(o.email);await c.load();
 // An athlete in a bracket where another bout has a result: the deletion ends, the bracket stays, the profile is anonymised.
 const t=(await c.cmd('tournament.save',T({name:'Drabinka Usuwania'}))).id,ps=[];
 for(const name of ['Pierwszy Usuwania','Drugi Usuwania','Trzeci Usuwania']){const id=(await c.cmd('profile.save',{...A,name,club:{none:true}})).id;ps.push(id);await c.cmd('entry.save',{tournamentId:t,profileId:id,...E});}
 const x=athlete('del-ath',{name:'Usuwany Zawodnik'});selfEntry(x,t);await c.load();
 const cat=bracketOf(tour(c,t),[...ps,x.profileId]);await c.cmd('draw.create',{tournamentId:t,categoryId:cat.id});
 const other=resolveDraw(tour(c,t).draws[cat.id]).flat().find(m=>m.ready&&m.a!==x.profileId&&m.b!==x.profileId);assert.ok(other,'a bout without the athlete');
 await c.cmd('result.save',{tournamentId:t,categoryId:cat.id,matchId:other.id,winnerId:other.a});const draw=tour(c,t).draws[cat.id];
 const xc=await signIn(x.email);let r=await xc.req('account-delete',{password:PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));
 const row=fixture('domain-row',{table:'profiles',id:x.profileId});assert.equal(row.owner_user_id,null);const data=JSON.parse(row.data);
 assert.deepEqual([data.name,data.birthDate,data.ownerId,data.relation,row.archived],['Dane usunięte',null,null,null,1]);
 await c.load();assert.deepEqual(tour(c,t).draws[cat.id],draw,'the bracket is unchanged');assert.ok(tour(c,t).entries.some(e=>e.profileId===x.profileId));
 // An athlete without entries: the profile row is deleted.
 const y=athlete('del-ath2');r=await (await signIn(y.email)).req('account-delete',{password:PASSWORD});assert.equal(r.status,200);assert.equal(fixture('domain-row',{table:'profiles',id:y.profileId}),null);
 // An organizer: upcoming tournaments hidden by 'system' with self-entries withdrawn, own profiles deleted or anonymised.
 const o2=member('del-org2',{organizer:true}),c2=await signIn(o2.email);await c2.load();
 const t2=(await c2.cmd('tournament.save',T({name:'Turniej Usuniętego'}))).id,t3=(await c2.cmd('tournament.save',T({name:'Historia Usuniętego',status:'draft'}))).id;
 const q=(await c2.cmd('profile.save',{...A,name:'Profil Do Usunięcia',club:{none:true},registration:{...E,tournamentId:t2}})).id;
 const q2=(await c2.cmd('profile.save',{...A,name:'Profil Z Historią',club:{none:true}})).id;
 await c2.cmd('tournament.save',{...T({name:'Historia Usuniętego'}),id:t3,status:'open'});await c2.cmd('entry.save',{tournamentId:t3,profileId:q2,...E});
 fixture('roles-backdate',{tournamentId:t3,date:'2025-03-01',status:'finished'});
 const y2=athlete('del-ath3');selfEntry(y2,t2);
 r=await c2.req('account-delete',{password:PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));
 const t2row=fixture('domain-row',{table:'tournaments',id:t2});assert.deepEqual([t2row.status,t2row.hidden_by,t2row.hidden_from],['draft','system','open']);
 assert.deepEqual(fixture('roles-entries',{tournamentId:t2}),[]);assert.deepEqual(fixture('roles-withdrawals',{tournamentId:t2}).map(w=>[w.profile_id,w.by_kind]),[[y2.profileId,'system']]);
 assert.equal(fixture('domain-row',{table:'profiles',id:q}),null,'deleted');
 const q2row=fixture('domain-row',{table:'profiles',id:q2});assert.deepEqual([JSON.parse(q2row.data).name,q2row.owner_user_id,q2row.archived],['Dane usunięte',null,1]);
 assert.equal(fixture('domain-row',{table:'tournaments',id:t3}).hidden_by,null,'a past tournament stays');
 assert.ok(fixture('domain-row',{table:'users',id:o2.id}),'the anonymised users row stays for the tournaments');
 // accounts-cleanup deletes an abandoned account but never one with community data.
 const old=now()-2000*86400,plain=member('cl-plain',{exempt:false}),org=member('cl-org',{organizer:true,exempt:false}),own=member('cl-own',{exempt:false});
 fixture('tournament',{createdBy:org.id,name:'Porzucony Organizator',date:day(40)});
 const op=fixture('domain-run',{actor:own.id,type:'athlete.save',payload:athleteBody()});assert.equal(op.status,200,JSON.stringify(op));
 for(const m of [plain,org,own])fixture('accounts-profile-age',{userId:m.id,createdAt:old,lastLoginAt:null});
 const result=fixture('accounts-cleanup',{config:{billing_enforce:true,abandoned_member_days:30}});assert.match(result,/^abandoned=on deleted=[1-9]\d* failed=0 /,result);
 assert.equal(fixture('roles-user',{email:plain.email}),null,'the abandoned account is gone');
 assert.ok(fixture('roles-user',{email:org.email})&&fixture('roles-user',{email:own.email}),'accounts with community data stay');
 // community-retention: an organizer's profile whose last tournament is past the cutoff is forgotten; names become initials.
 const o3=member('ret-org',{organizer:true}),c3=await signIn(o3.email);await c3.load();
 const t4=(await c3.cmd('tournament.save',T({name:'Dawny Turniej'}))).id,rp=(await c3.cmd('profile.save',{...A,name:'Rafał Dawny',club:{none:true},registration:{...E,tournamentId:t4}})).id;
 fixture('roles-backdate',{tournamentId:t4,date:'2020-05-05',status:'finished'});
 const ret=fixture('roles-job',{name:'community-retention'});assert.match(ret,/^cutoff=\d{4}-\d{2}-\d{2} profiles=[1-9]\d* snapshots=[1-9]\d* logs=\d+$/,ret);
 const rrow=fixture('domain-row',{table:'profiles',id:rp});assert.deepEqual([JSON.parse(rrow.data).name,rrow.owner_user_id],['Dane usunięte',null]);
 const snap=fixture('roles-entries',{tournamentId:t4}).find(e=>e.profileId===rp).snapshot.name;assert.ok(!snap.includes('Dawny')&&/^R\./.test(snap),snap);
 assert.match(fixture('roles-job',{name:'community-retention'}),/ profiles=0 snapshots=0 /,'idempotent');
});

test('chat lobby: no untrusted community tournaments except the own; o is 2 for an untrusted organizer and 1 once confirmed',{skip},async()=>{
 const s=fixture('roles-settings',{trustRequired:true}),strict=s.flags.trustRequired;
 fixture('chat-settings',{set:{send:{gap:0,perMin:1000,perDay:100000}}});
 try{
  const o=member('chat-org',{organizer:true}),oc=await signIn(o.email);await oc.load();
  const t=(await oc.cmd('tournament.save',T({name:'Czat Społeczności '+uniq('c'),date:day(3)}))).id;
  const reader=await signIn(member('chat-reader').email),a=await admin();
  const listed=async c=>{const r=c?await c.req('chat-channels'):await fetch(base+'?route=public-chat-channels',{headers:{'X-MatBravo-Client':'1'}}).then(async x=>({status:x.status,data:await x.json()}));assert.equal(r.status,200,JSON.stringify(r.data));return r.data.tournaments.find(x=>x.tournamentId===t);};
  assert.equal(!!(await listed(null)),!strict,'guests');assert.equal(!!(await listed(reader)),!strict,'another member');
  const mine=await listed(oc);assert.ok(mine&&mine.id>0,'the organizer sees his own tournament and its channel');
  const cid=()=>randomBytes(16).toString('base64url');
  const sent=await oc.req('chat-send',{t,cid:cid(),b:'Witajcie na turnieju'});assert.equal(sent.status,200,JSON.stringify(sent.data));assert.equal(sent.data.m.o,strict?2:1);
  const feed=async()=>{const r=await reader.req(`chat-feed&ch=${mine.id}:0`);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.ch[mine.id].m.find(m=>m.id===sent.data.m.id);};
  assert.equal((await feed()).o,strict?2:1);
  await adminMember(a,{action:'organizer-trust',userId:o.id,trusted:true});
  assert.ok(await listed(null)&&await listed(reader),'a confirmed organizer is listed');assert.equal((await feed()).o,1);
  const again=await oc.req('chat-send',{t,cid:cid(),b:'Już potwierdzony'});assert.equal(again.data.m.o,1);
  // A blocked organizer's tournaments leave the lobby again (except for himself).
  await adminMember(a,{action:'organizer',userId:o.id,blocked:true});
  assert.equal(!!(await listed(reader)),false);assert.ok(await listed(oc));assert.equal((await feed()).o,2);
 }finally{restoreSettings(s);fixture('chat-settings',{reset:true});}
});
