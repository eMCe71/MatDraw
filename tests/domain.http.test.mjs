// Workspace data of the roles plan on the real database (PLAN-REJESTRACJA-ROLE §4.3, §9, §12; run through scripts/test-http.sh on
// MariaDB and, in CI, MySQL 8.0): club names that collide under the collation, persist() deleting forgotten profiles (or rolling
// back), revision stamps, migrations and the rollback floor of 0007, commands of members through Repository::transaction with the
// actor, organizerSnapshot equal to the full workspace, and the public projection of community tournaments.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client,base,fixture,php} from './helpers/http-client.mjs';
const skip=!base,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const backend=path.join(process.env.MATDRAW_TEST_RELEASE||path.dirname(path.dirname(fileURLToPath(import.meta.url))),'backend');
const migrate=args=>{const r=spawnSync(php,[path.join(backend,'bin','migrate.php'),...args],{encoding:'utf8',env:process.env});return {code:r.status,out:r.stdout.trim(),err:r.stderr.trim()};};
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
const A={sex:'M',birthDate:'1995-04-04',weight:70,height:175,gradeType:'cup',grade:5,events:['forms']},E={events:['forms'],weight:70,height:175,gradeType:'cup',grade:5};
const run=(actor,type,payload,extra={})=>fixture('domain-run',{actor,type,payload,...extra});
before(()=>fixture('reset-limits'));

test('migrate.php twice exits 0; --rollback-floor is 7 with each kind of community data and lower without',{skip},()=>{
 for(let i=0;i<2;i++){const r=migrate([]);assert.equal(r.code,0,r.err);assert.match(r.out,/^Schemat aktualny/);}
 const floor=()=>{const r=migrate(['--rollback-floor']);assert.equal(r.code,0,r.err);return Number(r.out.split('\n').pop());};
 // Other files share this database and may already have left community data (sign-ups, athletes), so the command line is
 // checked against its own start value, and the branches inside one rolled-back transaction that first takes the existing
 // community rows out of the floor query: the result does not depend on the files run before.
 const owner=fixture('member',{email:'floor.owner@domain.test'}),start=floor();
 fixture('domain-floor',{kind:'owned-profile',userId:owner.id});assert.equal(floor(),7,'the command line sees community data');
 // Every branch of the floor query on the real database: an owned profile, a member's profile, tournament and club, a hidden
 // tournament, a merged club; a club created by staff (the demo clubs of seed-athletes) does not block.
 const probe=fixture('domain-floor-probe',{userId:owner.id});assert.ok(probe.before>=1&&probe.before<7,JSON.stringify(probe));
 for(const kind of ['owned-profile','member-profile','member-tournament','hidden-tournament','member-club','merged-club'])assert.deepEqual(probe.kinds[kind],[7,probe.before],kind+' needs code from 0007 on, removed it does not');
 assert.deepEqual(probe.kinds['staff-club'],[probe.before,probe.before],'a staff club does not block');
 assert.equal(floor(),7,'the probe rolled back: the committed row is still there');
 fixture('domain-floor',{kind:'owned-profile',remove:true});assert.equal(floor(),start,'back to the start value');assert.ok(start===7||start===probe.before,String(start));
 assert.deepEqual(fixture('domain-row',{table:'clubs',id:'unaffiliated'}),{id:'unaffiliated',name:'Niezrzeszony',verified:1,created_by:null,created_at:null,merged_into:null},'Clubs::ensure created the row in the first workspace transaction');
});

test('club names colliding under the collation give 409 and leave the existing club unchanged; Kraków/Krakow reuse the club',{skip},async()=>{
 const admin=new Client();await admin.login(...ADMIN);
 const account=async(email,clubName,status=200)=>{const r=await admin.req('command',{type:'account.save',payload:{email,password:PASSWORD,clubName,role:'club'},expectedRevision:admin.data.revision});assert.equal(r.status,status,JSON.stringify(r.data));if(status===200){admin.data=r.data.workspace;return r.data.result;}return r.data;};
 await account('strasse.a@domain.test','Straße Domenowa');const [orig]=fixture('domain-clubs',{names:['Straße Domenowa']});assert.ok(orig&&orig.verified===1);
 const r=await account('strasse.b@domain.test','Strasse Domenowa',409);assert.equal(r.error,'Klub o podobnej nazwie już istnieje. Wybierz go z listy.');
 assert.deepEqual(fixture('domain-clubs',{names:['Straße Domenowa','Strasse Domenowa']}),[orig],'one club, unchanged');
 const p=await admin.req('command',{type:'profile.save',payload:{...A,name:'Kolizja Profilu',clubName:'Strasse Domenowa'},expectedRevision:admin.data.revision});
 assert.deepEqual([p.status,p.data.error],[409,'Klub o podobnej nazwie już istnieje. Wybierz go z listy.']);
 await admin.load();assert.ok(!admin.data.profiles.some(x=>x.name==='Kolizja Profilu'),'the whole command was rolled back');
 // Kraków/Krakow: the same key, so the existing club is chosen; a fullwidth K only collides in the database (409).
 const k=await account('krakow.a@domain.test','Kraków Domenowy'),[kraków]=fixture('domain-clubs',{names:['Kraków Domenowy']});
 const k2=await account('krakow.b@domain.test','krakow domenowy');
 assert.equal(admin.data.users.find(u=>u.id===k2.id).clubId,kraków.id);assert.equal(admin.data.users.find(u=>u.id===k.id).clubId,kraków.id);
 const full=await account('krakow.c@domain.test','Ｋraków Domenowy',409);assert.equal(full.error,'Klub o podobnej nazwie już istnieje. Wybierz go z listy.');
 assert.deepEqual(fixture('domain-clubs',{names:['Kraków Domenowy']}),[kraków]);
});

test('persist() deletes a forgotten profile row, anonymises one kept by a finished tournament, and rolls back when entries remain',{skip},async()=>{
 const admin=new Client();await admin.login(...ADMIN);const clubId=admin.data.user.clubId;
 const gone=(await admin.cmd('profile.save',{...A,name:'Do Zapomnienia',clubId})).id;
 assert.deepEqual(await admin.cmd('profile.forget',{id:gone}),{id:gone,state:'deleted'});assert.equal(fixture('domain-row',{table:'profiles',id:gone}),null,'row deleted');
 const t=(await admin.cmd('tournament.save',{name:'Historia Domeny',city:'Opole',date:day(-1),mat:'Mata 1',status:'open'})).id;
 const kept=(await admin.cmd('profile.save',{...A,name:'Zapomniany Zawodnik',clubId,registration:{...E,tournamentId:t}})).id;
 await admin.cmd('tournament.save',{id:t,name:'Historia Domeny',city:'Opole',date:day(-1),mat:'Mata 1',status:'finished'});
 assert.equal((await admin.cmd('profile.forget',{id:kept})).state,'anonymized');
 const row=fixture('domain-row',{table:'profiles',id:kept}),data=JSON.parse(row.data);
 assert.deepEqual([row.owner_user_id,row.archived,data.name,data.birthDate],[null,1,'Dane usunięte',null]);
 assert.equal(admin.data.tournaments.find(x=>x.id===t).entries[0].name,'Z. Z.','the snapshot keeps initials only');
 const busy=(await admin.cmd('profile.save',{...A,name:'Ze Zgłoszeniem',clubId,registration:{...E,tournamentId:(await admin.cmd('tournament.save',{name:'Otwarty Domeny',city:'Opole',date:day(600),mat:'Mata 1',status:'open'})).id}})).id;
 const broken=fixture('domain-broken-forget',{profileId:busy});assert.match(broken.error,/still has entries/);
 assert.ok(fixture('domain-row',{table:'profiles',id:busy}),'nothing seems deleted');
});

test('revision stamps are stored; a command at an old revision passes for an untouched tournament and fails for a changed one (R15)',{skip},async()=>{
 const admin=new Client(),hall=new Client();await admin.login(...ADMIN);await hall.login(...ADMIN);
 const clubId=admin.data.user.clubId,t=(await admin.cmd('tournament.save',{name:'Stół kontroli',city:'Opole',date:day(610),mat:'Mata 1',status:'open'})).id;
 const pid=(await admin.cmd('profile.save',{...A,name:'Kontrolowany',clubId,registration:{...E,tournamentId:t}})).id;
 assert.equal(fixture('domain-row',{table:'tournaments',id:t}).rev,admin.data.revision);assert.equal(fixture('domain-row',{table:'profiles',id:pid}).rev,admin.data.revision);
 assert.equal(fixture('domain-row',{table:'app_meta'}).revision,admin.data.revision);
 await hall.load();const other=(await admin.cmd('tournament.save',{name:'Pętla',city:'Opole',date:day(620),mat:'Mata 1',status:'draft'})).id;
 for(let i=0;i<3;i++)await admin.cmd('tournament.save',{id:other,name:'Pętla '+'abc'[i],city:'Opole',date:day(620),mat:'Mata 1',status:'draft'});
 await hall.cmd('checkin.save',{tournamentId:t,id:pid,presence:'present',actualWeight:70.5});
 await hall.load();const stale=hall.data.revision;await admin.load();await admin.cmd('checkin.save',{tournamentId:t,id:pid,presence:'pending'});
 await hall.cmd('checkin.save',{tournamentId:t,id:pid,presence:'present',actualWeight:71},409,stale);
 const staff=await admin.cmd('account.save',{email:'stempel@domain.test',password:PASSWORD,clubId,role:'editor'});
 assert.ok(staff.id);assert.equal(fixture('domain-row',{table:'app_meta'}).staff_rev,admin.data.revision,'a staff change stamps staff_rev');
});

test('member commands through Repository::transaction with the actor; organizerSnapshot equals the full workspace; community in public views',{skip},async()=>{
 const org=fixture('member',{email:'organizator@domain.test',profile:true}),ath=fixture('member',{email:'zawodnik@domain.test',profile:true});
 assert.deepEqual(fixture('domain-organizer',{userId:org.id,organizer:true}),{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false});
 const userRow=fixture('domain-row',{table:'users',id:org.id});
 const tr=run(org.id,'tournament.save',{name:'Turniej Społeczności Domeny',city:'Opole',date:day(700),mat:'Mata 1',status:'open'},{config:{organizers_trust_required:true}});assert.equal(tr.status,200,JSON.stringify(tr));
 const t=tr.result.id,own=tr.view.tournaments.find(x=>x.id===t);assert.deepEqual([own.community,own.trusted,own.selfEntry,own.hidden],[true,false,true,false]);
 assert.equal(run(org.id,'tournament.save',{name:'Zapisy: www.spam.pl',city:'Opole',date:day(700),mat:'Mata 1',status:'open'}).status,422);
 // Paused publishing (flags from Settings::effective): the unconfirmed organizer is stopped, a confirmed one publishes even his first tournament.
 const paused={config:{organizers:'paused',organizers_trust_required:true}},conf=fixture('member',{email:'potwierdzony@domain.test'});fixture('domain-organizer',{userId:conf.id,organizer:true,trusted:true});
 assert.deepEqual(run(org.id,'tournament.save',{name:'Wstrzymany',city:'Opole',date:day(701),mat:'Mata 1',status:'open'},paused),{status:409,error:'Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.'});
 const first=run(conf.id,'tournament.save',{name:'Pierwszy Potwierdzony',city:'Opole',date:day(702),mat:'Mata 1',status:'open'},paused);assert.equal(first.status,200,JSON.stringify(first));
 assert.equal(run(conf.id,'tournament.save',{id:first.result.id,name:'Pierwszy Potwierdzony',city:'Opole',date:day(702),mat:'Mata 1',status:'draft'}).status,200,'back to draft for the next files');
 const pr=run(org.id,'profile.save',{...A,name:'Zawodnik Organizatora',club:{name:'Klub Organizatora Domeny'}});assert.equal(pr.status,200,JSON.stringify(pr));
 const p=pr.result.id,prow=fixture('domain-row',{table:'profiles',id:p}),[club]=fixture('domain-clubs',{names:['Klub Organizatora Domeny']});
 assert.deepEqual([prow.created_by,prow.owner_user_id,club.verified,club.created_by],[org.id,null,0,org.id]);
 assert.equal(run(org.id,'entry.save',{...E,tournamentId:t,profileId:p}).status,200);
 const ar=run(ath.id,'athlete.save',{...A,relation:'self',name:'Samodzielna Zawodniczka',sex:'F',club:{none:true}});assert.equal(ar.status,200,JSON.stringify(ar));
 assert.equal(fixture('domain-row',{table:'profiles',id:ar.result.id}).owner_user_id,ath.id);
 // One athlete profile per account (§17): a second one, self or guardian, is refused on the database path too and writes nothing.
 const one={status:409,error:'Na jednym koncie może być tylko jeden zawodnik.'};
 assert.deepEqual(run(ath.id,'athlete.save',{...A,relation:'self',name:'Druga Zawodniczka',sex:'F',club:{none:true}}),one);
 assert.deepEqual(run(ath.id,'athlete.save',{...A,relation:'guardian',name:'Dziecko Zawodniczki',sex:'F',birthDate:'2016-04-04',weight:30,height:130,grade:9,club:{none:true}}),one);
 const se=run(ath.id,'entry.self',{tournamentId:t,profileId:ar.result.id,events:['forms']});assert.equal(se.status,200,JSON.stringify(se));
 assert.deepEqual(fixture('domain-row',{table:'users',id:org.id}),userRow,'member rows are never written by the workspace');
 // 404s for members are identical for missing and unseen tournaments.
 const admin=new Client();await admin.login(...ADMIN);const draft=(await admin.cmd('tournament.save',{name:'Roboczy Domeny',city:'Opole',date:day(710),mat:'Mata 1',status:'draft'})).id;
 const a=run(org.id,'entry.save',{...E,tournamentId:draft,profileId:p}),b=run(org.id,'entry.save',{...E,tournamentId:'missing-id',profileId:p});
 assert.deepEqual([a.status,a.error],[404,'Turniej nie jest dostępny.']);assert.deepEqual(a,b);
 // The organizer's snapshot holds no other people's data and gives the same view as the full workspace: he also entered his
 // athlete into a staff tournament open for self-entries that holds staff entries (O19), and one of his tournaments with a
 // self-entry is hidden by the Administrator (PS-16).
 const ts=(await admin.cmd('tournament.save',{name:'Personel z Zapisami',city:'Opole',date:day(705),mat:'Mata 1',status:'open',selfEntry:true})).id,staffIds=[];
 for(const name of ['Personel Obcy Jeden','Personel Obca Dwa'])staffIds.push((await admin.cmd('profile.save',{...A,name,clubId:admin.data.user.clubId,registration:{...E,tournamentId:ts}})).id);
 assert.equal(run(org.id,'entry.save',{...E,tournamentId:ts,profileId:p}).status,200);
 const t2=run(org.id,'tournament.save',{name:'Ukryty Społeczności Domeny',city:'Opole',date:day(706),mat:'Mata 1',status:'open'}).result.id;
 assert.equal(run(ath.id,'entry.self',{tournamentId:t2,profileId:ar.result.id,events:['forms']}).status,200);
 await admin.load();await admin.cmd('tournament.hide',{tournamentId:t2,hidden:true,reason:'Sprawdzamy'});
 const snap=fixture('domain-snapshot',{userId:org.id});assert.deepEqual(snap.snapshot,snap.full);assert.ok(snap.profiles<snap.allProfiles,`${snap.profiles} of ${snap.allProfiles} profiles`);
 const mine=snap.snapshot.tournaments.find(x=>x.id===t);assert.deepEqual(mine.entries.map(e=>e.name).sort(),['Samodzielna Zawodniczka','Zawodnik Organizatora']);
 assert.deepEqual(snap.snapshot.tournaments.find(x=>x.id===ts).entries.map(e=>e.profileId),[p],'only his entry in the staff tournament');
 const hid=snap.snapshot.tournaments.find(x=>x.id===t2);assert.deepEqual([hid.hidden,hid.entries,hid.activity],[true,[],[]]);
 const raw=JSON.stringify(snap.raw),rawT=id=>snap.raw.tournaments.find(x=>x.id===id);
 for(const x of [...staffIds,'Personel Obcy Jeden','Personel Obca Dwa'])assert.ok(!raw.includes(x),'not in the request memory: '+x);
 assert.deepEqual([rawT(ts).activity,rawT(ts).draws,rawT(t2).activity,rawT(t2).entries],[[],[],[],[]],'no foreign log, no log or self-entries of the hidden tournament');
 assert.ok(rawT(t).activity.length>0,'his own log is there');
 // Staff: the Admin sees the community tournament, an editor does not while the organizer is unconfirmed.
 await admin.load();assert.equal(admin.data.tournaments.find(x=>x.id===t).community,true);assert.ok(!JSON.stringify(admin.data.users).includes(org.email));
 const pub=async q=>{const r=await fetch(base+'?'+q);return {status:r.status,data:await r.json()};};
 const view=await pub('route=public-tournament&id='+t);assert.equal(view.status,200);assert.deepEqual([view.data.tournament.community,view.data.tournament.trusted],[true,false]);
 const slotClubs=view.data.categories.flatMap(c=>c.bracket?.slots||[]).filter(Boolean);assert.deepEqual(slotClubs,[],'no bracket yet');
 assert.equal(view.data.summary.clubs,1,'unaffiliated is not a club; the unverified club is');
 fixture('domain-organizer',{userId:org.id,trusted:true});const trusted=await pub('route=public-tournament&id='+t);assert.equal(trusted.data.tournament.trusted,true);
 // Cleanup for the next files: hidden by the Administrator (status draft, out of every public list).
 await admin.load();await admin.cmd('tournament.hide',{tournamentId:t,hidden:true,reason:'Koniec testu'});await admin.cmd('tournament.hide',{tournamentId:ts,hidden:true});
 const row=fixture('domain-row',{table:'tournaments',id:t});assert.deepEqual([row.status,row.hidden_from,row.hidden_by],['draft','open',admin.data.user.id]);
 assert.equal((await pub('route=public-tournament&id='+t)).status,404);
});
