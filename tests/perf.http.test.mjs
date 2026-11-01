// Performance budget of PLAN-REJESTRACJA-ROLE §12 (slice integration-qa; run through scripts/test-http.sh, MariaDB 10.6/10.11
// or MySQL 8.0): with 5,000 profiles and 200 tournaments (plus 56 far open tournaments with self-entries) and an organizer
// who owns many community rows (60 tournaments, 1,000 profiles, 1,500 entries, 10 entries in a staff tournament):
//  - diagnostics?probe=perf (Administrator only, 6 per hour) reports the budget measured on this database: Repository load
//    under 400 ms, organizerSnapshot under 50 ms, the query of bootstrap?t&rev under 20 ms (medians of 3 runs);
//  - over HTTP: the organizer's bootstrap?t&rev answers {unchanged:true} in under 20 ms (median of 15 requests), and his full
//    bootstrap equals publicData of the full workspace (organizerSnapshot ≡ load, B2) at this size;
//  - the staff workspace is unaffected by thousands of member accounts: load() stays within the budget and near its time
//    without them, the users query reads the role index, and the Administrator's users list holds staff only;
//  - the athlete view at this size: the open list stops at OPEN_LIMIT, and ?t= keeps the requested tournament (F1).
// Every seeded row carries the run's tag and is removed afterwards (perf-clean), so later files see the usual database.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Client,base,fixture} from './helpers/http-client.mjs';
import {OPEN_LIMIT} from '../dist/athlete-view.js';
const skip=!base,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='PerfPassword2026!';
const TAG='perf'+Array.from(randomBytes(6),b=>'abcdefghijklmnopqrstuvwxyz'[b%26]).join('');
const median=list=>{const s=[...list].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
async function signIn(email,password){const c=new Client();await c.req('session');const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
async function get(route,cookie,params={}){const qs=new URLSearchParams(params).toString();const t0=performance.now();const r=await fetch(base+'?route='+route+(qs?'&'+qs:''),{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{})}});const text=await r.text();const ms=performance.now()-t0;let data=null;try{data=JSON.parse(text);}catch{}return {status:r.status,data,text,ms};}
let admin,org,seed;
/** diagnostics?probe=perf; with best, the faster of two probes per figure (a shared test machine has busy moments). */
async function diagnostics(best=false){
 const probe=async()=>{fixture('reset-limits');const r=await get('diagnostics',admin.cookie,{probe:'perf'});assert.equal(r.status,200,r.text);return r.data.perf;};
 const a=await probe();if(!best)return a;const b=await probe();
 return {...a,loadMs:Math.min(a.loadMs,b.loadMs),organizerSnapshotMs:Math.min(a.organizerSnapshotMs,b.organizerSnapshotMs),unchangedMs:Math.min(a.unchangedMs,b.unchangedMs)};
}

before(async()=>{
 if(skip)return;
 fixture('reset-limits');
 const email=`${TAG}.organizer@perf.example`,m=fixture('member',{email,password:PASSWORD,profile:true,exempt:true});fixture('domain-organizer',{userId:m.id,organizer:true});
 seed=fixture('perf-seed',{tag:TAG,organizerId:m.id,profiles:5000,organizerProfiles:1000,tournaments:200,organizerTournaments:60,entries:25,outside:10,far:55});
 admin=await signIn(...ADMIN);org=Object.assign(await signIn(email,PASSWORD),{id:m.id});
});
after(()=>{if(!skip)fixture('perf-clean',{tag:TAG});});

test('diagnostics?probe=perf: load < 400 ms, organizerSnapshot < 50 ms, the unchanged query < 20 ms at 5,000 profiles and 200 tournaments',{skip},async t=>{
 assert.deepEqual(seed.counts,{profiles:5000,tournaments:256,entries:5010});
 const p=await diagnostics(true);t.diagnostic('perf '+JSON.stringify(p));
 assert.deepEqual(Object.keys(p),['loadMs','organizerSnapshotMs','unchangedMs','counts','budget']);
 assert.deepEqual(p.budget,{loadMs:400,organizerSnapshotMs:50,unchangedMs:20});
 assert.ok(p.counts.profiles>=5000&&p.counts.tournaments>=256&&p.counts.entries>=5000,JSON.stringify(p.counts));
 assert.ok(p.loadMs<p.budget.loadMs,`load ${p.loadMs} ms`);
 assert.ok(typeof p.organizerSnapshotMs==='number'&&p.organizerSnapshotMs<p.budget.organizerSnapshotMs,`organizerSnapshot ${p.organizerSnapshotMs} ms (the organizer with 60 tournaments)`);
 assert.ok(p.unchangedMs<p.budget.unchangedMs,`unchanged ${p.unchangedMs} ms`);
 const text=JSON.stringify(p);assert.ok(!text.includes(org.id)&&!text.includes(TAG),'counts and times only');
 // Admin only, like the other probes.
 assert.equal((await get('diagnostics',org.cookie,{probe:'perf'})).status,403);assert.equal((await get('diagnostics',null,{probe:'perf'})).status,401);
 assert.equal((await get('diagnostics',admin.cookie,{probe:'other'})).status,400);
});

test('the organizer over HTTP: bootstrap?t&rev unchanged in < 20 ms (median of 15); the full bootstrap equals publicData of the whole workspace',{skip},async t=>{
 const full=await get('bootstrap',org.cookie);assert.equal(full.status,200,full.text.slice(0,300));
 const mine=full.data.tournaments.filter(x=>x.createdBy===org.id);assert.equal(mine.length,60,'his 60 tournaments');
 assert.equal(full.data.profiles.length,1000,'his 1,000 profiles, never the 4,000 of the staff');
 const own=full.data.tournaments.find(x=>x.id===seed.organizerTournament);assert.equal(own.entries.length,25);
 const staff=full.data.tournaments.find(x=>x.id===seed.staffTournament);assert.equal(staff.entries.length,10,'only his 10 entries in the staff tournament (O19)');
 assert.ok(staff.entries.every(e=>full.data.profiles.some(p=>p.id===e.profileId))&&!('createdBy' in staff),'his own profiles; no creator of a foreign tournament');
 t.diagnostic(`organizer bootstrap ${Math.round(full.ms)} ms, ${full.text.length} bytes`);
 const times=[];
 for(let i=0;i<15;i++){const r=await get('bootstrap',org.cookie,{t:own.id,rev:String(own.rev)});assert.deepEqual([r.status,r.data],[200,{unchanged:true}]);times.push(r.ms);}
 t.diagnostic(`unchanged median ${median(times).toFixed(1)} ms`);assert.ok(median(times)<20,`unchanged median ${median(times).toFixed(1)} ms`);
 const s=fixture('roles-snapshot',{userId:org.id});assert.deepEqual(s.snapshot,s.full,'organizerSnapshot ≡ publicData(load()) at this size');
});

test('staff: load() unaffected by 3,000 member accounts (role index), the Administrator\'s users are staff only',{skip},async t=>{
 const before=await diagnostics(true);fixture('perf-members',{tag:TAG,count:3000});const after=await diagnostics(true);
 t.diagnostic(`load without members ${before.loadMs} ms, with 3,000 members ${after.loadMs} ms`);
 assert.ok(after.counts.members>=before.counts.members+3000);assert.ok(after.loadMs<after.budget.loadMs,`${after.loadMs} ms`);
 assert.ok(after.loadMs<before.loadMs*1.5+25,`members slow the staff workspace down: ${before.loadMs} → ${after.loadMs} ms`);
 const plan=fixture('perf-explain');assert.ok(plan.some(r=>r.key==='users_role'),'the staff query reads the role index: '+JSON.stringify(plan));
 const b=await get('bootstrap',admin.cookie);assert.equal(b.status,200);t.diagnostic(`staff bootstrap ${Math.round(b.ms)} ms`);
 assert.ok(b.data.users.every(u=>['admin','editor','club'].includes(u.role))&&!b.text.includes(TAG+'.m'),'members never enter the workspace');
});

test('the athlete view at this size: the open list stops at OPEN_LIMIT; ?t= keeps the requested tournament (F1)',{skip},async()=>{
 const email=`${TAG}.athlete@perf.example`,m=fixture('member',{email,password:PASSWORD,profile:true,exempt:true});
 const r=fixture('domain-run',{actor:m.id,type:'athlete.save',payload:{relation:'self',name:'Perf Zawodniczka',birthDate:'1990-01-01',sex:'F',weight:60,height:168,gradeType:'cup',grade:5,club:{none:true}}});assert.equal(r.status,200,JSON.stringify(r));
 const c=await signIn(email,PASSWORD);
 const plain=await get('athlete',c.cookie);assert.equal(plain.status,200,plain.text);
 assert.equal(plain.data.open.length,OPEN_LIMIT);assert.ok(!plain.data.open.some(x=>x.id===seed.target),'the farthest tournament is cut off');
 const kept=await get('athlete',c.cookie,{t:seed.target});assert.equal(kept.status,200,kept.text);
 assert.deepEqual(kept.data.open.map(x=>x.id),[...plain.data.open.map(x=>x.id),seed.target],'appended after the nearest ones');
 assert.deepEqual(kept.data.open.at(-1).profiles,[{id:r.result.id,entered:false,blocked:null}]);
 for(const t of [plain.data.open[0].id,'missing','../x',TAG+'-t0003'])assert.deepEqual((await get('athlete',c.cookie,{t})).data.open,plain.data.open,'nothing changes for '+t);
 assert.equal((await c.req('athlete-entry',{tournamentId:seed.target,profileId:r.result.id,events:['forms'],weight:60,height:168,gradeType:'cup',grade:5})).status,200,'the kept tournament takes the entry');
});
