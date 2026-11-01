// Athlete routes on the real database (PLAN-REJESTRACJA-ROLE §6–§8, §11–§12; run through scripts/test-http.sh): public-clubs,
// athlete-save (age rule, profile cap, one own profile, identity lock, closed field list), athlete-entry (open, closed, without
// self-entries, past, hidden/draft/missing with one 404, repeat, drawn category, minors in untrusted tournaments, events),
// athlete-withdraw and tombstones, the athlete view (equal to the workspace projection, no other person's data),
// athlete-forget, paid mode (only entering needs full access; correcting an own entry does not, R12), the limits (429, 413)
// and seed-athletes with its safe --remove (one rule for demo clubs, earlier demo clubs unverified).
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client,CLIENT_API,base,fixture,php} from './helpers/http-client.mjs';
import {ATHLETES_PER_ACCOUNT} from '../dist/workspace.js';
import {classify} from '../dist/engine.js';
const skip=!base,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='TestPassword2026!';
const backend=path.join(process.env.MATDRAW_TEST_RELEASE||path.dirname(path.dirname(fileURLToPath(import.meta.url))),'backend');
const seed=args=>{const r=spawnSync(php,[path.join(backend,'bin','seed-athletes.php'),...args],{encoding:'utf8',env:process.env});return {code:r.status,out:r.stdout.trim(),err:r.stderr.trim()};};
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
const yearsAgo=(n,d=0)=>{const [y,m,dd]=day(d).split('-');return (Number(y)-n)+'-'+m+'-'+dd;};
const SELF={name:'Adam Zgłaszający',birthDate:'1995-04-04',sex:'M',weight:70,height:175,gradeType:'cup',grade:5,club:{none:true},relation:'self'};
const ENTRY={events:['forms']},STAFF={sex:'M',birthDate:'1996-05-05',weight:72,height:180,gradeType:'cup',grade:5,events:['forms']};
const CATEGORY=classify({age:30,sex:'M',gradeType:'cup',grade:5,weight:70,height:175},'forms').id;
let n=0;
/** A member (free account unless paid) signed in. */
async function member(label,{paid=false}={}){const email=`${label}.${++n}.${Date.now()}@athletes.test`;const m=fixture('member',{email,profile:true,exempt:!paid});const c=new Client();await c.login(email,PASSWORD);c.id=m.id;c.email=email;return c;}
async function admin(){const c=new Client();await c.login(...ADMIN);return c;}
async function tournament(a,name,{date=day(30),status='open',selfEntry=true}={}){await a.load();return (await a.cmd('tournament.save',{name,city:'Opole',date,mat:'Mata 1',status,selfEntry})).id;}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
/** The raw body of a POST with the client's session (byte-for-byte comparisons). */
async function rawPost(c,route,body){const r=await fetch(base+'?route='+route,{method:'POST',headers:{'Content-Type':'application/json','X-MatBravo-Client':String(CLIENT_API),Cookie:c.cookie,'X-CSRF-Token':c.csrf},body:JSON.stringify(body)});return {status:r.status,text:await r.text()};}
const run=(actor,type,payload)=>fixture('domain-run',{actor,type,payload});
before(()=>fixture('reset-limits'));

test('public-clubs: verified clubs that are not merged, cached 300 s, without unaffiliated',{skip},async()=>{
 const a=await admin(),clubs=async()=>{const r=await fetch(base+'?route=public-clubs',{headers:{'X-MatBravo-Client':String(CLIENT_API)}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'public, max-age=300');assert.equal(r.headers.get('set-cookie'),null);return r.json();};
 const m=await member('clubs');ok(await m.req('athlete-save',{...SELF,club:{name:'Klub Niezweryfikowany Atletów'}}));
 await a.cmd('profile.save',{...STAFF,name:'Kluby Pierwszy',clubName:'Klub Zweryfikowany Atletów'});
 await a.cmd('profile.save',{...STAFF,name:'Kluby Drugi',clubName:'Klub Scalany Atletów'});
 const ids=Object.fromEntries((await a.load()).clubs.map(c=>[c.name,c.id]));
 await a.cmd('club.merge',{id:ids['Klub Scalany Atletów'],into:ids['Klub Zweryfikowany Atletów']});
 const out=await clubs(),names=out.clubs.map(c=>c.name);
 assert.equal(out.unaffiliated,'unaffiliated');assert.deepEqual(Object.keys(out).sort(),['clubs','unaffiliated']);
 for(const c of out.clubs)assert.deepEqual(Object.keys(c).sort(),['id','name']);
 assert.ok(names.includes('Test Warszawa')&&names.includes('Klub Zweryfikowany Atletów'),JSON.stringify(names));
 for(const hidden of ['Klub Niezweryfikowany Atletów','Klub Scalany Atletów','Niezrzeszony'])assert.ok(!names.includes(hidden),hidden);
 assert.ok(!out.clubs.some(c=>c.id==='unaffiliated'));
 assert.deepEqual(names,[...names].sort((x,y)=>x.localeCompare(y,'pl')),'by name');
 await a.cmd('club.save',{id:ids['Klub Niezweryfikowany Atletów'],verified:true});
 assert.ok((await clubs()).clubs.some(c=>c.name==='Klub Niezweryfikowany Atletów'),'verified by the Administrator → listed');
});

test('athlete-save: under-16 self refused, guardian kept, profile cap, one own profile, identity lock, closed field list',{skip},async()=>{
 const a=await admin(),m=await member('save');
 const young=ok(await m.req('athlete-save',{...SELF,birthDate:yearsAgo(15)}),422);
 assert.equal(young.error,'Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
 const child=ok(await m.req('athlete-save',{...SELF,name:'Ola Podopieczna',birthDate:yearsAgo(15),sex:'F',relation:'guardian',ownerId:'someone',createdBy:'someone',champion:true,archived:true,events:['hogo']}));
 assert.deepEqual(Object.keys(child).sort(),['caps','profile']);assert.equal(child.caps.athlete,true);
 assert.equal(child.profile.relation,'guardian');assert.equal(child.profile.minor,true);assert.equal(child.profile.archived,false);
 assert.deepEqual(child.profile.club,{id:'unaffiliated',name:'',verified:true,unaffiliated:true,pending:null});
 const row=fixture('athlete-row',{id:child.profile.id});
 assert.equal(row.owner_user_id,m.id);assert.equal(row.created_by,m.id);assert.equal(row.archived,0);assert.equal(row.data.champion,false);assert.deepEqual(row.data.events,['forms']);assert.ok(row.data.guardianDeclaredAt>0);
 // The cap of ATHLETES_PER_ACCOUNT profiles (the constant of the domain, §17: 1 after the owner's decision).
 let made=1,last;for(;made<=ATHLETES_PER_ACCOUNT;made++){last=await m.req('athlete-save',{...SELF,name:'Kolejny Podopieczny',birthDate:yearsAgo(10),relation:'guardian'});if(last.status!==200)break;}
 assert.equal(made,ATHLETES_PER_ACCOUNT,'profiles created before the cap');assert.equal(last.status,409,JSON.stringify(last.data));
 if(ATHLETES_PER_ACCOUNT===5)assert.equal(last.data.error,'Na jednym koncie może być najwyżej 5 zawodników.');
 // One own ('self') profile per account.
 const s=await member('self');const own=ok(await s.req('athlete-save',SELF)).profile;assert.equal(own.minor,false);
 const second=ok(await s.req('athlete-save',{...SELF,name:'Drugi Ja'}),409);
 if(ATHLETES_PER_ACCOUNT>1)assert.equal(second.error,'Na koncie jest już Twój własny profil zawodnika.');
 // Identity lock while an entry is pending: club, birth date and sex 409; name and measures may change.
 const t=await tournament(a,'Blokada Tożsamości');ok(await s.req('athlete-entry',{tournamentId:t,profileId:own.id,...ENTRY}));
 for(const change of [{birthDate:'1994-04-04'},{sex:'F'},{club:{name:'Klub Po Zmianie'}}]){
  const r=ok(await s.req('athlete-save',{...SELF,id:own.id,...change}),409);
  assert.equal(r.error,'Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.');
 }
 const renamed=ok(await s.req('athlete-save',{...SELF,id:own.id,name:'Adam Poprawiony',weight:71}));assert.equal(renamed.profile.name,'Adam Poprawiony');assert.equal(renamed.profile.locked,true);
 const other=await member('other');assert.equal(ok(await other.req('athlete-save',{...SELF,id:own.id}),404).error,'Zawodnik nie istnieje.');
 assert.equal(ok(await other.req('athlete-archive',{profileId:own.id}),404).error,'Zawodnik nie istnieje.');
 assert.equal(ok(await s.req('athlete-archive',{profileId:own.id}),409).error,'Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.');
 assert.equal(ok(await a.req('athlete-save',SELF),403).error,'Brak uprawnień.','staff have no athlete routes');
});

test('athlete-entry: open 200; closed, without self-entries and past 403; hidden, draft and missing one 404; repeat, drawn 409; events 422',{skip},async()=>{
 const a=await admin(),m=await member('entry');const own=ok(await m.req('athlete-save',SELF)).profile.id;
 const open=await tournament(a,'Zgłoszenia Otwarte'),closed=await tournament(a,'Zgłoszenia Zamknięte',{status:'closed'}),noSelf=await tournament(a,'Zgłoszenia Bez Samodzielnych',{selfEntry:false});
 const past=await tournament(a,'Zgłoszenia Po Terminie',{date:day(-1)}),draft=await tournament(a,'Zgłoszenia Robocze',{status:'draft'}),hidden=await tournament(a,'Zgłoszenia Ukryte');
 await a.cmd('tournament.hide',{tournamentId:hidden,hidden:true,reason:'Sprawdzamy organizatora'});
 const r=ok(await m.req('athlete-entry',{tournamentId:open,profileId:own,...ENTRY,weight:71}));
 assert.equal(r.ok,true);assert.equal(r.entry.tournament.id,open);assert.equal(r.entry.profileId,own);assert.equal(r.entry.canWithdraw,true);assert.equal(r.entry.canEdit,true);
 assert.deepEqual(r.entry.entry.events,['forms']);assert.equal(r.entry.entry.weight,71);assert.equal(r.entry.categories[0].state,'underfilled');
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:open,profileId:own,...ENTRY}),409).error,'Jesteś już zgłoszony do tego turnieju.');
 const updated=ok(await m.req('athlete-entry',{tournamentId:open,profileId:own,events:['forms','special'],update:true}));assert.deepEqual(updated.entry.entry.events,['forms','special']);
 for(const t of [closed,noSelf,past])assert.equal(ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}),403).error,'Zapisy do tego turnieju są zamknięte.');
 const missing=[];for(const t of [hidden,draft,'0'.repeat(32)]){const x=await rawPost(m,'athlete-entry',{tournamentId:t,profileId:own,...ENTRY});assert.equal(x.status,404);missing.push(x.text);}
 assert.equal(new Set(missing).size,1,'hidden, draft and missing are indistinguishable: '+missing.join(' | '));assert.equal(JSON.parse(missing[0]).error,'Turniej nie jest dostępny.');
 const other=await tournament(a,'Zgłoszenia Konkurencje');
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:other,profileId:own,events:['hogo']}),422).error,'Konkurencja niedostępna w tej grupie wieku');
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:other,profileId:'0'.repeat(32),...ENTRY}),404).error,'Zawodnik nie istnieje.');
 // A category with a saved draw takes no self-entry (DR-5); the draw stays.
 const drawn=await tournament(a,'Zgłoszenia Wylosowane');
 for(const name of ['Staff Pierwszy Losowany','Staff Drugi Losowany','Staff Trzeci Losowany'])await a.cmd('profile.save',{...STAFF,name,clubId:a.data.user.clubId,registration:{tournamentId:drawn,weight:72,height:180,gradeType:'cup',grade:5,events:['forms']}});
 await a.cmd('draw.create',{tournamentId:drawn,categoryId:CATEGORY});
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:drawn,profileId:own,...ENTRY}),409).error,'Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.');
 assert.ok((await a.load()).tournaments.find(t=>t.id===drawn).draws[CATEGORY],'the draw is kept');
 const view=ok(await m.req('athlete'));const offer=view.open.find(t=>t.id===drawn);assert.deepEqual(offer.drawn,[CATEGORY]);assert.deepEqual(offer.profiles,[{id:own,entered:false,blocked:null}]);
 const raw=JSON.stringify(view);for(const s of ['Staff Pierwszy Losowany','Staff Drugi','admin@test.example','Sprawdzamy'])assert.ok(!raw.includes(s),s);
});

test('minors enter only trusted tournaments; an adult self profile may enter an untrusted one',{skip},async()=>{
 const org=fixture('member',{email:`org.${Date.now()}@athletes.test`,profile:true});fixture('domain-organizer',{userId:org.id,organizer:true});
 const created=run(org.id,'tournament.save',{name:'Społeczny Atletów',city:'Opole',date:day(20),mat:'Mata 1',status:'open'});assert.equal(created.status,200,JSON.stringify(created));
 // A blocked organizer is never trusted, whatever trustRequired says (§17).
 fixture('domain-organizer',{userId:org.id,blocked:true});const t=created.result.id;
 const parent=await member('parent');const child=ok(await parent.req('athlete-save',{...SELF,name:'Zosia Mała',birthDate:yearsAgo(12),sex:'F',grade:8,relation:'guardian'})).profile.id;
 assert.equal(ok(await parent.req('athlete-entry',{tournamentId:t,profileId:child,...ENTRY}),409).error,'Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.');
 const offer=ok(await parent.req('athlete')).open.find(x=>x.id===t);assert.equal(offer.community,true);assert.equal(offer.trusted,false);assert.deepEqual(offer.profiles,[{id:child,entered:false,blocked:'minor-untrusted'}]);
 assert.deepEqual(offer.organizer,{n:'Test C.'},'the organizer\'s display name (O11)');
 const adult=await member('adult');const own=ok(await adult.req('athlete-save',SELF)).profile.id;
 const r=ok(await adult.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));assert.equal(r.entry.tournament.trusted,false);assert.equal(r.entry.tournament.community,true);
});

test('an organizer neither confirmed nor blocked: trusted only without trustRequired; build() equals the workspace for both values',{skip},async()=>{
 const org=fixture('member',{email:`org.u.${Date.now()}@athletes.test`,profile:true});fixture('domain-organizer',{userId:org.id,organizer:true});
 const created=run(org.id,'tournament.save',{name:'Społeczny Niepotwierdzony',city:'Opole',date:day(22),mat:'Mata 1',status:'open'});assert.equal(created.status,200,JSON.stringify(created));const t=created.result.id;
 const parent=await member('parent.u');const child=ok(await parent.req('athlete-save',{...SELF,name:'Ala Niepotwierdzona',birthDate:yearsAgo(11),sex:'F',grade:8,relation:'guardian'})).profile.id;
 for(const required of [true,false]){
  const check=fixture('athlete-view-check',{userId:parent.id,config:{organizers_trust_required:required}});assert.equal(check.flags.trustRequired,required);
  assert.deepEqual(check.build,check.workspace,'build() = fromWorkspace(), trustRequired '+required);
  const offer=check.build.open.find(x=>x.id===t);assert.equal(offer.community,true);assert.equal(offer.trusted,!required);
  assert.deepEqual(offer.profiles,[{id:child,entered:false,blocked:required?'minor-untrusted':null}],'trustRequired '+required);
 }
 // The routes follow the configured switch; Domain takes the minor under trustRequired=false (§17) and refuses under true.
 const required=fixture('athlete-view-check',{userId:parent.id}).flags.trustRequired;
 assert.equal(ok(await parent.req('athlete')).open.find(x=>x.id===t).trusted,!required);
 const r=await parent.req('athlete-entry',{tournamentId:t,profileId:child,...ENTRY});assert.equal(r.status,required?409:200,JSON.stringify(r.data));
 const other=fixture('domain-run',{actor:parent.id,type:'entry.self',payload:{tournamentId:t,profileId:child,...ENTRY},config:{organizers_trust_required:!required}});
 assert.equal(other.status,required?200:409,JSON.stringify(other));
 assert.equal(ok(await parent.req('athlete')).entries.filter(e=>e.tournament.id===t).length,1,'entered once');
});

test('athlete-withdraw: open 200, closed 403, only own profiles; a withdrawal by the organizer leaves a tombstone',{skip},async()=>{
 const a=await admin(),m=await member('withdraw');const own=ok(await m.req('athlete-save',SELF)).profile.id;
 const open=await tournament(a,'Wycofanie Otwarte'),later=await tournament(a,'Wycofanie Zamykane');
 ok(await m.req('athlete-entry',{tournamentId:open,profileId:own,...ENTRY}));
 assert.deepEqual(ok(await m.req('athlete-withdraw',{tournamentId:open,profileId:own})),{ok:true});
 assert.ok(!ok(await m.req('athlete')).entries.some(e=>e.tournament.id===open));assert.deepEqual(fixture('athlete-withdrawals',{profileId:own}),[],'no tombstone for the own withdrawal');
 ok(await m.req('athlete-entry',{tournamentId:later,profileId:own,...ENTRY}));
 await a.load();await a.cmd('tournament.save',{id:later,name:'Wycofanie Zamykane',city:'Opole',date:day(30),mat:'Mata 1',status:'closed'});
 assert.equal(ok(await m.req('athlete-withdraw',{tournamentId:later,profileId:own}),403).error,'Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.');
 const other=await member('intruder');assert.equal(ok(await other.req('athlete-withdraw',{tournamentId:later,profileId:own}),404).error,'Zawodnik nie istnieje.');
 // An organizer withdraws the self-entry in his tournament: a tombstone that the athlete sees; entering again removes it.
 const org=fixture('member',{email:`org.w.${Date.now()}@athletes.test`,profile:true});fixture('domain-organizer',{userId:org.id,organizer:true});
 const t=run(org.id,'tournament.save',{name:'Turniej Organizatora Wycofanie',city:'Opole',date:day(25),mat:'Mata 1',status:'open'}).result.id;
 ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));
 assert.equal(run(org.id,'entry.remove',{tournamentId:t,id:own}).status,200);
 assert.deepEqual(fixture('athlete-withdrawals',{profileId:own}),[{tournament_id:t,by_kind:'organizer'}]);
 const gone=ok(await m.req('athlete')).withdrawn;assert.equal(gone.length,1);
 assert.deepEqual({...gone[0],at:0},{profileId:own,tournament:{id:t,name:'Turniej Organizatora Wycofanie',date:day(25)},by:'organizer',at:0});
 ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));assert.deepEqual(ok(await m.req('athlete')).withdrawn,[]);assert.deepEqual(fixture('athlete-withdrawals',{profileId:own}),[]);
 // The Administrator's withdrawal is marked 'admin'.
 await a.load();await a.cmd('entry.remove',{tournamentId:t,id:own});assert.equal(ok(await m.req('athlete')).withdrawn[0].by,'admin');
});

test('the athlete view equals the workspace projection and carries no other person\'s data',{skip},async()=>{
 const a=await admin(),m=await member('view');const own=ok(await m.req('athlete-save',{...SELF,name:'Widok Własny'})).profile.id;
 const t=await tournament(a,'Widok Turniej');
 for(const name of ['Obcy Pierwszy Widok','Obcy Drugi Widok','Obcy Trzeci Widok'])await a.cmd('profile.save',{...STAFF,name,clubId:a.data.user.clubId,registration:{tournamentId:t,weight:72,height:180,gradeType:'cup',grade:5,events:['forms']}});
 ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));
 await a.load();await a.cmd('draw.create',{tournamentId:t,categoryId:CATEGORY});
 const check=fixture('athlete-view-check',{userId:m.id});assert.deepEqual(check.build,check.workspace,'build() = fromWorkspace(load())');
 const view=ok(await m.req('athlete'));assert.deepEqual(view,check.build);
 const e=view.entries.find(x=>x.tournament.id===t),c=e.categories[0];
 assert.equal(c.drawn,true);assert.equal(c.athletes,4);assert.ok(c.position&&['next','bye'].includes(c.position.status),JSON.stringify(c.position));assert.equal(e.canWithdraw,false,'inside a saved draw');
 assert.equal(ok(await m.req('athlete-withdraw',{tournamentId:t,profileId:own}),409).error,'Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.');
 const ws=await a.load(),others=ws.tournaments.find(x=>x.id===t).entries.filter(x=>x.profileId!==own);
 const raw=JSON.stringify(view);
 for(const x of others){assert.ok(!raw.includes(x.name),x.name);assert.ok(!raw.includes(x.profileId),'profile id of another athlete');}
 for(const s of ['admin@test.example',ws.user.id,'Mata 1','"activity"','"createdBy"'])assert.ok(!raw.includes(s),s);
 const guest=await fetch(base+'?route=athlete',{headers:{'X-MatBravo-Client':String(CLIENT_API)}});assert.equal(guest.status,401);
 assert.equal(ok(await a.req('athlete'),403).error,'Brak uprawnień.');
});

test('athlete-forget removes a profile without history and anonymises one with a finished tournament',{skip},async()=>{
 const a=await admin(),m=await member('forget');const own=ok(await m.req('athlete-save',SELF)).profile.id;
 assert.equal(ok(await m.req('athlete-forget',{profileId:own,password:'wrong password!'}),422).error,'Nieprawidłowe obecne hasło.');
 const other=await member('forget.other');assert.equal(ok(await other.req('athlete-forget',{profileId:own,password:PASSWORD}),404).error,'Zawodnik nie istnieje.');
 const r=ok(await m.req('athlete-forget',{profileId:own,password:PASSWORD}));assert.equal(r.caps.athlete,false);assert.equal(fixture('athlete-row',{id:own}),null,'row deleted');
 const k=await member('forget.kept');const kept=ok(await k.req('athlete-save',{...SELF,name:'Zenon Historyczny'})).profile.id;
 const t=await tournament(a,'Zapomnienie Historia',{date:day(5)});ok(await k.req('athlete-entry',{tournamentId:t,profileId:kept,...ENTRY}));
 await a.load();await a.cmd('tournament.save',{id:t,name:'Zapomnienie Historia',city:'Opole',date:day(5),mat:'Mata 1',status:'finished'});
 ok(await k.req('athlete-forget',{profileId:kept,password:PASSWORD}));
 const row=fixture('athlete-row',{id:kept});assert.equal(row.owner_user_id,null);assert.equal(row.data.name,'Dane usunięte');assert.equal(row.data.birthDate,null);assert.equal(row.archived,1);
 const entry=(await a.load()).tournaments.find(x=>x.id===t).entries.find(e=>e.profileId===kept);assert.equal(entry.name,'Z. H.','the result stays with initials');
 assert.deepEqual(ok(await k.req('athlete')).entries,[],'the account no longer owns the profile');
});

test('paid mode: athlete-entry 402; withdraw, save, archive, forget and the view work without full access',{skip},async()=>{
 const a=await admin(),m=await member('paid');const t=await tournament(a,'Płatny Tryb');
 const own=ok(await m.req('athlete-save',SELF)).profile.id;ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));
 fixture('billing',{userId:m.id,billing_exempt:0,exempt_reason:null,exempt_until:null});
 const t2=await tournament(a,'Płatny Tryb Drugi');
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:t2,profileId:own,...ENTRY}),402).error,'Zgłoszenia do turniejów wymagają aktywnego konta.');
 assert.equal(ok(await m.req('athlete-entry',{tournamentId:'0'.repeat(32),profileId:own,...ENTRY}),402).error,'Zgłoszenia do turniejów wymagają aktywnego konta.','402 comes first: nothing to probe');
 // R12: correcting the own entry without new events needs no full access; a new event or no entry to correct is entering.
 const fixed=ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,events:['forms'],weight:73,update:true}));assert.equal(fixed.entry.entry.weight,73);
 for(const body of [{tournamentId:t,profileId:own,events:['forms','special'],update:true},{tournamentId:t2,profileId:own,...ENTRY,update:true}])
  assert.equal(ok(await m.req('athlete-entry',body),402).error,'Zgłoszenia do turniejów wymagają aktywnego konta.',JSON.stringify(body));
 const free=await member('paid.other');assert.equal(ok(await free.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY,update:true}),404).error,'Zawodnik nie istnieje.','another account never corrects it');
 ok(await m.req('athlete'));ok(await m.req('athlete-save',{...SELF,id:own,name:'Adam Niepłacący'}));
 ok(await m.req('athlete-withdraw',{tournamentId:t,profileId:own}));
 assert.deepEqual(ok(await m.req('athlete-archive',{profileId:own,archived:true})).caps.athlete,false);ok(await m.req('athlete-archive',{profileId:own,archived:false}));
 ok(await m.req('athlete-forget',{profileId:own,password:PASSWORD}));assert.equal(fixture('athlete-row',{id:own}),null);
});

test('limits: athlete-forget 5/h, the global bucket of member transactions 429 with Retry-After, athlete-entry over 4 KB 413',{skip},async()=>{
 fixture('reset-limits');
 try{
  const m=await member('limits');const own=ok(await m.req('athlete-save',SELF)).profile.id;
  for(let i=0;i<5;i++)assert.equal(ok(await m.req('athlete-forget',{profileId:own,password:'wrong password!'}),422).error,'Nieprawidłowe obecne hasło.');
  const sixth=await m.req('athlete-forget',{profileId:own,password:PASSWORD});assert.equal(sixth.status,429,JSON.stringify(sixth.data));
  assert.equal(sixth.data.error,'Zbyt wiele prób. Spróbuj ponownie później.');assert.ok(sixth.data.retry>0);assert.equal(sixth.headers.get('retry-after'),String(sixth.data.retry));
  assert.ok(fixture('athlete-row',{id:own}),'the profile stays');
  const a=await admin(),t=await tournament(a,'Limity Atletów');
  fixture('athlete-member-tx',{attempts:120});
  for(const [route,body] of [['athlete-entry',{tournamentId:t,profileId:own,...ENTRY}],['athlete-save',{...SELF,id:own,weight:71}],['athlete-withdraw',{tournamentId:t,profileId:own}]]){
   const r=await m.req(route,body);assert.equal(r.status,429,route+' '+JSON.stringify(r.data));assert.equal(r.data.error,'Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.');
   assert.ok(r.data.retry>0&&r.data.retry<=60,route);assert.equal(r.headers.get('retry-after'),String(r.data.retry));
  }
  assert.ok(!ok(await m.req('athlete')).entries.length,'nothing entered');
  fixture('reset-limits');
  const big=await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY,note:'x'.repeat(4200)});assert.equal(big.status,413);assert.equal(big.data.error,'Żądanie jest zbyt duże.');
  ok(await m.req('athlete-entry',{tournamentId:t,profileId:own,...ENTRY}));
 }finally{fixture('reset-limits');}
});

test('seed-athletes: demo clubs unverified; --remove refuses while a community profile uses one; seed and remove round trip',{skip},async()=>{
 const a=await admin();
 // One rule for seeding and --remove: a club that only resembles a demo name (Clubs::key) stops the seeding until renamed.
 await a.load();await a.cmd('profile.save',{...STAFF,name:'Podobny Klubowicz',clubName:'KS Smok Demo'});
 const clash=seed(['--count=12','--seed=7']);assert.equal(clash.code,1);assert.equal(clash.err,'The club "KS Smok Demo" resembles the demo club "KS Smok (demo)"; rename it in the app (Kluby) first.');
 assert.deepEqual(fixture('athlete-demo').clubs,[],'nothing seeded');
 const similar=(await a.load()).clubs.find(c=>c.name==='KS Smok Demo').id;await a.cmd('club.save',{id:similar,name:'KS Smok Inny'});
 const added=seed(['--count=12','--seed=7']);assert.equal(added.code,0,added.err);
 const demo=fixture('athlete-demo');assert.equal(demo.clubs.length,6);assert.equal(demo.profiles,12);
 for(const c of demo.clubs){assert.equal(c.verified,0,c.name);assert.equal(c.created_by,a.data.user.id);}
 const publicDemo=async()=>(await (await fetch(base+'?route=public-clubs',{headers:{'X-MatBravo-Client':String(CLIENT_API)}})).json()).clubs.filter(c=>c.name.endsWith(' (demo)')).length;
 assert.equal(await publicDemo(),0,'demo clubs are not public');
 // Demo clubs of an earlier version stayed verified (0007: DEFAULT 1): any run unverifies them first, even one that refuses.
 fixture('athlete-demo-verify');assert.equal(await publicDemo(),6);const stale=fixture('athlete-demo').revision;
 const repeat=seed(['--count=12','--seed=7']);assert.equal(repeat.code,1);assert.equal(repeat.err,'Sample athletes already exist. Run with --remove first.');assert.equal(repeat.out,'Unverified 6 demo clubs (off the public club list).');
 const hidden=fixture('athlete-demo');assert.equal(await publicDemo(),0);for(const c of hidden.clubs)assert.equal(c.verified,0,c.name);
 assert.equal(Number(hidden.revision.revision),Number(stale.revision)+1);assert.equal(hidden.revision.staff_rev,hidden.revision.revision);assert.equal(hidden.profiles,12);
 const m=await member('demo');const own=ok(await m.req('athlete-save',{...SELF,club:{id:demo.clubs[0].id}})).profile;assert.equal(own.club.verified,false);
 const used=fixture('athlete-demo');assert.equal(used.profiles,13);
 const refused=seed(['--remove']);assert.equal(refused.code,1);assert.match(refused.err,/^Demo clubs are used by community profiles; merge or rename them in the app \(Kluby\) first\.$/);
 assert.deepEqual(fixture('athlete-demo'),used,'nothing changed, not even the revision');
 ok(await m.req('athlete-save',{...SELF,id:own.id,club:{none:true}}));
 const before=fixture('athlete-demo').revision,removed=seed(['--remove']);assert.equal(removed.code,0,removed.err);assert.equal(removed.out,'Removed 12 sample athletes, their entries, draws and demo clubs.');
 const after=fixture('athlete-demo');assert.deepEqual([after.clubs,after.profiles],[[],0]);assert.equal(Number(after.revision.revision),Number(before.revision)+1);assert.equal(after.revision.staff_rev,after.revision.revision);
 assert.ok(fixture('athlete-row',{id:own.id}),'the community profile stays');
 assert.equal(seed(['--remove']).out,'No sample data found.');
 // With entries in a tournament: --remove deletes them too and stamps the tournament (scoped revisions, §5.8).
 const t=await tournament(a,'Demo Turniej',{date:day(40)}),again=seed(['--count=6','--tournament='+t]);assert.equal(again.code,0,again.err);
 assert.deepEqual([fixture('athlete-demo').profiles,fixture('athlete-demo').entries],[6,6]);
 const gone=seed(['--remove']);assert.equal(gone.code,0,gone.err);const demoAfter=fixture('athlete-demo');assert.deepEqual([demoAfter.clubs.length,demoAfter.entries],[0,0]);
 assert.equal(Number(fixture('domain-row',{table:'tournaments',id:t}).rev),Number(demoAfter.revision.revision));assert.deepEqual((await a.load()).tournaments.find(x=>x.id===t).entries,[]);
});
