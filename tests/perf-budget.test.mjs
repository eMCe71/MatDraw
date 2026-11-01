// The budget rule of tests/perf.http.test.mjs (tests/helpers/perf-budget.mjs): a time under the budget passes, from the
// budget up to 1.5× it is a warning, from 1.5× on it fails; MATDRAW_PERF_STRICT=1 fails at the budget itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SLACK,budgetVerdict,assertBudget} from './helpers/perf-budget.mjs';

test('budgetVerdict: ok under the budget, a warning up to 1.5×, a failure from 1.5× on or at the budget when strict',()=>{
 assert.equal(SLACK,1.5);
 assert.deepEqual([0,41.5,49.9,50,74.9,75,400].map(ms=>budgetVerdict(ms,50)),['ok','ok','ok','warn','warn','fail','fail']);
 assert.deepEqual([41.5,49.9,50,60].map(ms=>budgetVerdict(ms,50,true)),['ok','ok','fail','fail']);
 for(const bad of [null,undefined,NaN,Infinity,-1,'1'])assert.equal(budgetVerdict(bad,50),'fail',String(bad));
});

test('assertBudget: a warning goes to the diagnostics, a failure names the figure, the budget and the limit',()=>{
 const notes=[],t={diagnostic:m=>notes.push(m)};
 assert.equal(assertBudget(t,'organizerSnapshot',41.5,50,{strict:false}),'ok');assert.deepEqual(notes,[]);
 assert.equal(assertBudget(t,'organizerSnapshot',60,50,{strict:false,note:' (60 tournaments)'}),'warn');
 assert.deepEqual(notes,['WARNING organizerSnapshot 60 ms is over its budget of 50 ms (fails from 75 ms) (60 tournaments)']);
 assert.throws(()=>assertBudget(t,'organizerSnapshot',80,50,{strict:false}),{message:/organizerSnapshot 80 ms, budget 50 ms, fails from 75 ms/});
 assert.throws(()=>assertBudget(t,'organizerSnapshot',60,50,{strict:true}),{message:/organizerSnapshot 60 ms, budget 50 ms, fails from 50 ms/});
 assert.throws(()=>assertBudget(t,'organizerSnapshot',null,50,{strict:false}),{message:/organizerSnapshot null ms/},'no organizer measured');
 assert.equal(notes.length,1,'only the warning band writes a diagnostic');
});

test('assertBudget reads MATDRAW_PERF_STRICT when no strict option is given',()=>{
 const t={diagnostic(){}},saved=process.env.MATDRAW_PERF_STRICT;
 try{
  delete process.env.MATDRAW_PERF_STRICT;assert.equal(assertBudget(t,'load',450,400),'warn');
  process.env.MATDRAW_PERF_STRICT='1';assert.throws(()=>assertBudget(t,'load',450,400),/fails from 400 ms/);
 }finally{if(saved===undefined)delete process.env.MATDRAW_PERF_STRICT;else process.env.MATDRAW_PERF_STRICT=saved;}
});
