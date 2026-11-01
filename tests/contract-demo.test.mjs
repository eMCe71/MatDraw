// The demo answers me and public-config with the server's shapes (PLAN-REJESTRACJA-ROLE §8.1, §8.2, §10.7), so the
// wave-3 frontends read the same fields in both modes: user.caps (all false for staff), athletes, features.signupMode
// ('off': no sign-up in the demo), features.selfEntry, features.pendingOrganizers for the Administrator only, and
// public-config with signupMode and roles. The key lists are the ones tests/accounts.http.test.mjs and
// tests/contract.http.test.mjs assert for the server.
import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage=new MemoryStorage();globalThis.sessionStorage=new MemoryStorage();
// me.js keeps a BroadcastChannel open, which would keep this process alive: the modules run without it here.
globalThis.BroadcastChannel=undefined;
const Client=await import('../dist/client.js');
const {registry}=await import('../dist/registry.js');
const Me=await import('../dist/me.js');

const USER=['id','clubId','email','role','active','caps'],CAPS=['organizer','organizerBlocked','organizerTrusted','athlete'];
const FEATURES=['signup','avatars','chat','signupMode','selfEntry'],TOP=['user','profile','access','billing','features','athletes'];
const NO_CAPS={organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:false};
let ws=null;registry.provide('ui',{getWorkspace:()=>ws});
const meOf=async id=>{const u=JSON.parse(localStorage.getItem(Client.dataKey)).users.find(x=>x.id===id);ws={user:{id:u.id,clubId:u.clubId,email:u.email,role:u.role,active:true}};return Me.loadMe({force:true});};

test('demo me: the server shapes of the role fields for staff, the organizer and the parent',async()=>{
 assert.equal(Client.isDemo,true);
 await Client.init();
 const out={};
 for(const id of ['demo-admin','demo-editor','demo-club','demo-organizer','demo-athlete']){
  const m=await meOf(id);out[id]=m;
  assert.deepEqual(Object.keys(m).filter(k=>k!=='demo'),TOP,id);
  assert.deepEqual(Object.keys(m.user),USER,id);assert.deepEqual(Object.keys(m.user.caps),CAPS,id);
  assert.deepEqual(Object.keys(m.features),m.user.role==='admin'?[...FEATURES,'pendingOrganizers']:FEATURES,id);
  assert.equal(m.features.signupMode,'off');assert.equal(m.features.signup,false);assert.equal(m.features.selfEntry,true);
  assert.ok(Array.isArray(m.athletes));
 }
 for(const id of ['demo-admin','demo-editor','demo-club']){assert.deepEqual(out[id].user.caps,NO_CAPS,'staff get no member roles: '+id);assert.deepEqual(out[id].athletes,[]);}
 assert.deepEqual(out['demo-organizer'].user.caps,{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false});assert.deepEqual(out['demo-organizer'].athletes,[]);
 assert.deepEqual(out['demo-athlete'].user.caps,{organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:true});
 assert.deepEqual(out['demo-athlete'].athletes,[{profileId:'demo-athlete-child',name:'Zuzanna Demo',relation:'guardian',archived:false}],'one profile per account (§17)');
 // The demo data get flags {organizers:'on',trustRequired:false} (§17, the server default): nobody waits, as in the me route.
 assert.equal(out['demo-admin'].features.pendingOrganizers,0);
 // With the confirmation required, the unconfirmed demo organizer waits.
 const db=JSON.parse(localStorage.getItem(Client.dataKey));localStorage.setItem(Client.dataKey,JSON.stringify({...db,flags:{organizers:'on',trustRequired:true}}));
 assert.equal((await meOf('demo-admin')).features.pendingOrganizers,1);
 localStorage.setItem(Client.dataKey,JSON.stringify({...db,users:db.users.map(u=>u.id==='demo-organizer'?{...u,organizerTrustedAt:1793484000}:u)}));
 assert.equal((await meOf('demo-admin')).features.pendingOrganizers,0,'a confirmed organizer is not pending');
 assert.equal((await meOf('demo-organizer')).user.caps.organizerTrusted,true);
 localStorage.setItem(Client.dataKey,JSON.stringify(db));
});

test('demo public-config: the server keys, sign-up off, no personal data',async()=>{
 const r=await Client.publicGet({route:'public-config'});
 assert.equal(r.status,200);
 assert.deepEqual(Object.keys(r.data),['signup','signupMode','billing','amounts','avatars','support','roles']);
 assert.deepEqual(r.data,{signup:false,signupMode:'off',billing:false,amounts:{pln:899,usd:299},avatars:false,support:null,roles:true});
 assert.ok(!/@/.test(JSON.stringify(r.data)));
 r.data.signup=true;assert.equal((await Client.publicGet({route:'public-config'})).data.signup,false,'a fresh object each time');
});
