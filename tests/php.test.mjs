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
