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
