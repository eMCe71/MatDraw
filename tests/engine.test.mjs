import test from 'node:test';
import assert from 'node:assert/strict';
import {slotOrder,makeDraw,resolveDraw,saveWinner,clearWinner,clubConflicts,fingerprintCounts,sameClub,firstPairs,initialState,categories,classify,validateAthlete,eligibility} from '../dist/engine.js';
const roster=n=>Array.from({length:n},(_,i)=>({id:'p'+i,name:'Zawodnik '+i,club:'Klub '+i%6,champion:false}));
test('Nine-person placement matches the coach diagram, including the ninth position',()=>{assert.deepEqual(slotOrder(16).slice(0,9),[0,15,7,8,1,14,6,9,2]);assert.deepEqual(slotOrder(8),[0,7,1,6,2,5,3,4]);});
test('Every size has unique positions, correct athlete counts and exactly n-1 played matches',()=>{
 for(let n=3;n<=64;n++){
  const draw=makeDraw(roster(n),137+n);
  assert.equal(new Set(draw.slots.filter(Boolean)).size,n);
  assert.equal(slotOrder(draw.size).length,draw.size);
  assert.equal(new Set(slotOrder(draw.size)).size,draw.size);
  let played=0;
  for(let step=0;step<10;step++){
   const ready=resolveDraw(draw).flat().filter(x=>x.ready);if(!ready.length)break;
   for(const m of ready){saveWinner(draw,m.id,m.a);played++;}
  }
  assert.equal(played,n-1,`size ${n}`);
  assert.ok(resolveDraw(draw).at(-1)[0].winner);
 }
});
test('Reproducible draw seed, distinct seeds and champion preference when a bye exists',()=>{
 const a=roster(9);a[0].champion=true;
 const d=makeDraw(a,100);assert.deepEqual(d.slots,makeDraw(a,100).slots);
 assert.notDeepEqual(d.slots,makeDraw(a,101).slots);
 assert.equal(d.slots[d.slots.indexOf('p0')^1],null);
 assert.equal(clubConflicts(d,a),0);
});
test('Small and oversized categories are blocked',()=>{assert.throws(()=>makeDraw(roster(2)),/Minimum 3/);assert.throws(()=>makeDraw(roster(65)),/64/);});
test('Winners must participate; unready finals are blocked; later results cannot be invalidated silently',()=>{
 const d=makeDraw(roster(4),5);const first=resolveDraw(d).flat().find(x=>x.ready);
 assert.throws(()=>saveWinner(d,first.id,'outside'),/uczestniczyć/);
 assert.throws(()=>saveWinner(d,'2-0','p0'),/Najpierw/);
 for(let s=0;s<5;s++)for(const m of resolveDraw(d).flat().filter(x=>x.ready))saveWinner(d,m.id,m.a);
 assert.throws(()=>clearWinner(d,first.id),/kolejnej/);
 clearWinner(d,'2-0');assert.equal(resolveDraw(d).at(-1)[0].winner,null);
});
test('200 g check-in tolerance is applied to the registered weight ceiling',()=>{
 const a={...initialState().athletes[9],weight:64,actualWeight:64.2};
 assert.equal(classify(a,'light').band,'do 64 kg');
 assert.equal(classify({...a,actualWeight:64.3},'light').band,'do 70 kg');
 assert.equal(classify({...a,actualWeight:58},'light').band,'do 58 kg');
 assert.equal(classify({...a,weight:58.5,actualWeight:null},'light').band,'do 64 kg');
});
test('Absence removes all entries, changing weight moves only weight-based events',()=>{
 const a={...initialState().athletes[9],id:'test',weight:64,actualWeight:null,events:['forms','light','special']};
 assert.equal(categories([a]).items.length,3);
 assert.equal(categories([{...a,presence:'absent'}]).items.length,0);
 const after={...a,actualWeight:65};
 assert.equal(classify(a,'forms').id,classify(after,'forms').id);
 assert.equal(classify(a,'special').id,classify(after,'special').id);
 assert.notEqual(classify(a,'light').id,classify(after,'light').id);
});
test('Ambiguous and omitted rules are not silently guessed',()=>{
 const base=initialState().athletes[9];
 assert.ok(classify({...base,age:14,sex:'F'},'semi').error);
 assert.ok(classify({...base,sex:'F'},'light').error);
 assert.ok(classify({...base,age:45,gradeType:'dan',grade:1},'forms').error);
 assert.ok(classify({...base,age:12,gradeType:'dan',grade:1},'forms').error);
 assert.ok(eligibility({...base,grade:7},'light'));
});
test('Height limits are continuous and adult Cup classes match the source thresholds',()=>{
 const a={...initialState().athletes[0],age:10,gradeType:'cup',grade:7,height:145};
 assert.equal(classify(a,'hogo').band,'do 145 cm');
 assert.equal(classify({...a,height:145.1},'hogo').band,'do 155 cm');
 assert.equal(classify({...a,age:19,weight:88.1,actualWeight:null},'light').band,'powyżej 88 kg');
});
test('Sample counts are derived from real sample records',()=>{
 const s=initialState(),c=categories(s.athletes);assert.equal(s.athletes.length,35);assert.equal(c.items.length,8);assert.equal(c.unassigned.length,1);assert.equal(c.items.filter(x=>x.underfilled).length,2);
});
test('Form validation rejects missing, invalid and age-incompatible entries',()=>{
 const a=initialState().athletes[9];assert.equal(validateAthlete(a),true);
 assert.throws(()=>validateAthlete({...a,name:''}));assert.throws(()=>validateAthlete({...a,weight:NaN}));assert.throws(()=>validateAthlete({...a,events:[]}));assert.throws(()=>validateAthlete({...a,age:8}));
});
test('Unaffiliated athletes are never separated: their pairs cost nothing, conflicts and club counts skip them (PLAN-REJESTRACJA-ROLE §6.3)',()=>{
 const free=(id,o={})=>({id,name:'Bez Klubu '+id,club:'Niezrzeszony',clubId:'unaffiliated',champion:false,...o});
 assert.equal(sameClub(free('a'),free('b')),false);assert.equal(sameClub({club:'A',clubId:'c1'},{club:'A',clubId:'c1'}),true);assert.equal(sameClub({club:'A'},{club:'B'}),false);
 const all=Array.from({length:8},(_,i)=>free('u'+i));
 for(const seed of [1,2,3]){const d=makeDraw(all,seed);assert.equal(clubConflicts(d,all),0);assert.equal(firstPairs(d.slots).length,4);}
 // Six unaffiliated and two of Klub A: the two always meet someone else, as if the unaffiliated were six different clubs.
 const mixed=[...all.slice(0,6),{id:'k1',name:'K 1',club:'Klub A',clubId:'cA'},{id:'k2',name:'K 2',club:'Klub A',clubId:'cA'}];
 for(const seed of [4,5,6,7])assert.equal(clubConflicts(makeDraw(mixed,seed),mixed),0);
 const counts=fingerprintCounts([...mixed.map(a=>({...a,age:20,sex:'M',gradeType:'cup',grade:5,weight:70,height:175,events:['forms'],presence:'pending'}))]);
 assert.equal(counts.clubs,1,'Niezrzeszony is not a club');
});
