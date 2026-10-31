import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {initialWorkspace} from '../dist/workspace.js';
import {classify} from '../dist/engine.js';
const php=process.env.PHP_BIN;
function bridge(input){const r=spawnSync(php,['tests/php-bridge.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
test('PHP classifier agrees with browser across age, sex, grade and weight boundaries',{skip:!php},()=>{
 const cases=[];for(const age of [7,9,10,12,13,15,16,18,19,35,36,44,45,46,55,56])for(const sex of ['M','F'])for(const gradeType of ['cup','dan'])for(const event of ['forms','soft','hogo','semi','light','special','power'])cases.push({athlete:{id:'a',name:'Test',club:'Test',age,sex,gradeType,grade:gradeType==='cup'?6:1,weight:58,height:135,actualWeight:58.2},event});
 const actual=bridge({job:'classify',cases});cases.forEach((c,i)=>{const expected=classify(c.athlete,c.event);assert.equal(!!actual[i].error,!!expected.error,JSON.stringify(c));assert.equal(actual[i].id,expected.id,JSON.stringify(c));});
});
test('PHP draws 3–64 retain all athletes and produce exactly n−1 matches',{skip:!php},()=>{for(const r of bridge({job:'draws'})){assert.equal(r.unique,r.n);assert.equal(r.matches,r.n-1);assert.ok(r.winner);}});
test('PHP role guards, last admin, closed entries and stale writes',{skip:!php},()=>{
 const db=initialWorkspace(),foreign=db.profiles.find(a=>a.clubId!=='club-1');db.tournaments[1].status='closed';
 const commands=[{actor:'demo-club',type:'account.save',payload:{}},{actor:'demo-club',type:'tournament.save',payload:{}},{actor:'demo-club',type:'profile.save',payload:{id:foreign.id}},{actor:'demo-editor',type:'tournament.save',payload:{id:db.tournaments[0].id}},{actor:'demo-admin',type:'account.save',payload:{id:'demo-admin',email:'admin@matdraw.example',role:'editor',clubId:'club-1'}},{actor:'demo-club',type:'entry.save',payload:{tournamentId:db.tournaments[1].id}},{actor:'demo-admin',type:'profile.save',payload:{},revision:0}];
 const out=bridge({job:'commands',db,commands});assert.deepEqual(out.results.map(r=>r.status),[403,403,403,403,409,403,409]);for(const t of out.db.tournaments)if(Array.isArray(t.draws)&&!t.draws.length)t.draws={};assert.deepEqual(out.db,db);
});

// Public guest projection: backend/src/GuestView.php must send exactly what dist/guest-view.js (demo) produces,
// only allow-listed fields, initials instead of names, and nothing for drafts or past tournaments.
import {execute} from '../dist/workspace.js';
import {categories,resolveDraw} from '../dist/engine.js';
import {guestUpcoming,guestTournament,initials} from '../dist/guest-view.js';
function drawn(){
 let db=initialWorkspace();const t=db.tournaments[0];
 for(const c of categories(t.entries).items.filter(c=>c.type==='bracket'&&!c.underfilled))db=execute(db,'demo-admin','draw.create',{tournamentId:t.id,categoryId:c.id}).db;
 const keys=Object.keys(db.tournaments[0].draws);
 keys.forEach((key,k)=>{for(let i=0;i<(k===1?99:2);i++){const m=resolveDraw(db.tournaments[0].draws[key]).flat().find(m=>m.ready);if(!m)break;db=execute(db,'demo-admin','result.save',{tournamentId:t.id,categoryId:key,matchId:m.id,winnerId:i%2?m.a:m.b}).db;}});
 db.tournaments.push({id:'t-past',name:'Turniej miniony',city:'Opole',date:'2026-10-30',mat:'Mata 1',status:'finished',createdBy:'demo-admin',entries:structuredClone(t.entries),draws:{},activity:[]});
 return db;
}
const NAMES=['Jan Kowalski','Łukasz Żak','anna maria kowalska-nowak','  Zofia   Wróbel ','Jean-Luc Picard','Madonna','(Ola) Nowak',"Zoë D'Arcy",'Ewa Lis','Émile Zola','','123'];
test('PHP public projection equals the browser demo projection (list, previews, initials)',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',ids=[...db.tournaments.map(t=>t.id),'missing'];
 for(const limit of [6,2]){
  const out=bridge({job:'guest',tournaments:db.tournaments,today,ids,names:NAMES,limit});
  assert.deepEqual(out.upcoming,guestUpcoming(db.tournaments,today,limit));
  assert.deepEqual(out.tournaments,ids.map(id=>guestTournament(db.tournaments,id,today)));
  assert.deepEqual(out.initials,NAMES.map(initials));
 }
});
test('PHP public projection: allow-listed fields, initials only, no drafts or past dates',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',t=db.tournaments[0];
 const out=bridge({job:'guest',tournaments:db.tournaments,today,ids:[t.id,'t-spring-2027','t-past','t-winter-2027']});
 assert.deepEqual(out.upcoming.tournaments.map(x=>x.id),['t-autumn-2026','t-gp-gdansk-2026','t-winter-2027']);
 for(const x of out.upcoming.tournaments)assert.deepEqual(Object.keys(x).sort(),['city','date','id','name','status']);
 const [view,draft,past,empty]=out.tournaments;
 assert.equal(draft,null);assert.equal(past,null);assert.deepEqual(empty.categories,[]);
 assert.deepEqual(Object.keys(view).sort(),['categories','summary','tournament']);
 assert.deepEqual(Object.keys(view.tournament).sort(),['city','date','id','name','status']);
 assert.deepEqual(Object.keys(view.summary).sort(),['brackets','categories','clubs','entries']);
 assert.ok(view.categories.some(c=>c.state==='finished')&&view.categories.some(c=>c.state==='progress'));
 for(const c of view.categories){assert.deepEqual(Object.keys(c).sort(),['athletes','bracket','code','event','gradeType','state','subtitle','title','type']);for(const s of c.bracket?.slots||[])if(s)assert.deepEqual(Object.keys(s).sort(),['club','initials']);}
 const json=JSON.stringify(out);
 for(const field of ['birthDate','legacyAge','"age"','weight','height','"grade"','presence','champion','email','password','clubId','profileId','createdBy','"mat"','activity','revision','signature','createdAt'])assert.ok(!json.includes(field),field);
 for(const e of t.entries){assert.ok(!json.includes(e.name),e.name);for(const part of e.name.split(' '))assert.ok(!new RegExp('(^|[^\\p{L}])'+part+'([^\\p{L}]|$)','u').test(json),part);}
});
