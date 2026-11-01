// The performance budget of PLAN-REJESTRACJA-ROLE §12 in tests (tests/perf.http.test.mjs). The budget is a local figure
// (MariaDB 10.6) and stays exact in diagnostics?probe=perf; a test machine is shared (CI runners, MySQL 8.0, parallel runs),
// so a figure fails only from SLACK × budget on and a figure from 1× up to SLACK× is reported as a warning, never a failure.
// MATDRAW_PERF_STRICT=1 fails at the budget itself (to confirm the figures recorded in VALIDATION on a quiet machine).
import assert from 'node:assert/strict';
export const SLACK=1.5;
/** 'ok' under the budget, 'warn' from the budget up to SLACK × budget, 'fail' above that, at the budget when strict, or for no time. */
export function budgetVerdict(ms,budget,strict=false){
 if(typeof ms!=='number'||!Number.isFinite(ms)||ms<0)return 'fail';
 if(ms<budget)return 'ok';
 return !strict&&ms<budget*SLACK?'warn':'fail';
}
/** Asserts a measured time against its budget; a warning goes to the test's diagnostics. Returns the verdict. */
export function assertBudget(t,name,ms,budget,{strict=process.env.MATDRAW_PERF_STRICT==='1',note=''}={}){
 const verdict=budgetVerdict(ms,budget,strict),limit=strict?budget:budget*SLACK;
 if(verdict==='warn')t.diagnostic(`WARNING ${name} ${ms} ms is over its budget of ${budget} ms (fails from ${limit} ms)${note}`);
 assert.ok(verdict!=='fail',`${name} ${ms} ms, budget ${budget} ms, fails from ${limit} ms${note}`);
 return verdict;
}
