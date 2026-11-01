// The role contract of me and public-config over real PHP and MariaDB/MySQL (PLAN-REJESTRACJA-ROLE §4.4, §8.1, §8.2,
// §17; run through scripts/test-http.sh): signupMode of both routes comes from Settings::effective (the app_settings row
// wins over config.php) and the two always agree; me carries user.caps and athletes for every account (all false and an
// empty list for staff), features.selfEntry, and features.pendingOrganizers for the Administrator only, which counts the
// organizers awaiting confirmation and is 0 while the confirmation is not required (trustRequired=false). public-config
// keeps its cache headers and carries no personal data. The app_settings row and the switches are put back afterwards.
import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Client,base,fixture} from './helpers/http-client.mjs';
const skip=!base,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='ContractPassword2026!';
let seq=0;const uniq=p=>`${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const NO_CAPS={organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:false};
const FEATURES=['signup','avatars','chat','signupMode','selfEntry','rolesOpen'];
/** A GET without cookies: {status, headers, data}. */
async function guest(route){const r=await fetch(base+'?route='+route,{headers:{'X-MatBravo-Client':'1'}});return {status:r.status,headers:r.headers,data:await r.json()};}
async function signIn(email,password=PASSWORD){const c=new Client();await c.req('session');const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
async function me(c){
 const r=await c.req('me');assert.equal(r.status,200,JSON.stringify(r.data));const m=r.data;
 assert.deepEqual(Object.keys(m),['user','profile','access','billing','features','athletes']);
 assert.deepEqual(Object.keys(m.user),['id','clubId','email','role','active','caps']);
 assert.deepEqual(Object.keys(m.features),m.user.role==='admin'?[...FEATURES,'pendingOrganizers']:FEATURES);
 assert.equal(m.features.selfEntry,true);assert.ok(Array.isArray(m.athletes));
 return m;
}
const member=(prefix,extra={})=>{const email=uniq(prefix)+'@contract.test';return {...fixture('member',{email,password:PASSWORD,profile:true,exempt:true,...extra}),email};};
/**
 * Puts back what fixture roles-settings changed. roles-settings-restore skips the app_settings row when there was none
 * before (old.row null reads as "no table" there), so that row, which only roles-settings wrote, is deleted here.
 */
const restoreSettings=s=>{fixture('roles-settings-restore',{old:s.old});if(s.old.row===null)fixture('settings-reset');};
let admin;
before(async()=>{fixture('reset-limits');fixture('settings-reset');admin=await signIn(ADMIN[0],ADMIN[1]);});
beforeEach(()=>fixture('reset-limits'));
after(()=>fixture('settings-reset'));

test('signupMode of me and public-config comes from Settings::effective; public-config stays public and impersonal',{skip},async()=>{
 const m=await signIn(member('tryb').email),adminId=(await me(admin)).user.id;
 // [stored row or null, signupMode, features.signup / public-config signup, public-config billing (payments enforced)]
 const cases=[[null,'paid',true,true],[{signup:'on',payments:'free'},'free',true,false],[{signup:'off',payments:'paid'},'off',false,true],[{signup:'off',payments:'free'},'off',false,false]];
 try{
  for(const [row,mode,signup,billing] of cases){
   if(row)fixture('settings-set',{data:row});else fixture('settings-reset');
   const label=JSON.stringify(row);
   for(const c of [admin,m]){const f=(await me(c)).features;assert.deepEqual([f.signupMode,f.signup,f.rolesOpen],[mode,signup,mode!=='off'],label);}
   const pc=await guest('public-config');assert.equal(pc.status,200);
   assert.equal(pc.headers.get('cache-control'),'public, max-age=60');assert.equal(pc.headers.get('set-cookie'),null);assert.doesNotMatch(pc.headers.get('vary')||'',/cookie/i);
   assert.deepEqual(Object.keys(pc.data),['signup','signupMode','billing','amounts','avatars','support','roles','rolesOpen'],label);
   assert.deepEqual([pc.data.signupMode,pc.data.signup,pc.data.billing,pc.data.roles,pc.data.rolesOpen],[mode,signup,billing,true,mode!=='off'],label);
   // No personal data: the only e-mail is the support address, and no account e-mail or id appears.
   const text=JSON.stringify(pc.data);assert.deepEqual(text.match(/[^"@\s]+@[^"\s]+/g)||[],pc.data.support?[pc.data.support]:[]);
   assert.ok(!text.includes(ADMIN[0])&&!text.includes(adminId),label);
  }
 }finally{fixture('settings-reset');}
});

test('me: user.caps and athletes for every account, pendingOrganizers for the Administrator only (trustRequired, §17)',{skip},async()=>{
 // Staff: no member roles (§4.2), an empty athlete list.
 const a=await me(admin);assert.deepEqual([a.user.caps,a.athletes],[NO_CAPS,[]]);
 // A member without roles.
 const plain=await me(await signIn(member('bez').email));assert.deepEqual([plain.user.caps,plain.athletes],[NO_CAPS,[]]);
 // An organizer with his own athlete profile: caps from Actors::of, the one profile of the account (§17).
 const o=member('orgath');fixture('domain-organizer',{userId:o.id,organizer:true});
 const saved=fixture('domain-run',{actor:o.id,type:'athlete.save',payload:{relation:'self',name:'Kontrakt Zawodnik',birthDate:'1994-02-03',sex:'M',weight:72,height:178,gradeType:'cup',grade:6,club:{none:true}}});
 assert.equal(saved.status,200,JSON.stringify(saved));
 const oc=await signIn(o.email),om=await me(oc);
 assert.deepEqual(om.user.caps,{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:true});
 assert.deepEqual(om.athletes,[{profileId:saved.result.id,name:'Kontrakt Zawodnik',relation:'self',archived:false}]);
 assert.equal(om.user.id,o.id);
 // pendingOrganizers: counts the organizer while the confirmation is required, never for members, 0 without the requirement.
 const s=fixture('roles-settings',{trustRequired:true});
 try{
  assert.equal(s.flags.trustRequired,true);
  const before=(await me(admin)).features.pendingOrganizers;assert.ok(before>=1,'the new organizer awaits confirmation');
  const o2=member('org2');fixture('domain-organizer',{userId:o2.id,organizer:true});
  assert.equal((await me(admin)).features.pendingOrganizers,before+1,'one COUNT of the organizers awaiting confirmation');
  fixture('domain-organizer',{userId:o2.id,trusted:true});
  assert.equal((await me(admin)).features.pendingOrganizers,before,'a confirmed organizer no longer waits');
  fixture('domain-organizer',{userId:o2.id,trusted:false,blocked:true});
  assert.equal((await me(admin)).features.pendingOrganizers,before,'a blocked organizer does not wait');
  assert.ok(!('pendingOrganizers' in (await me(oc)).features),'members never get the count');
  const off=fixture('roles-settings',{trustRequired:false});assert.equal(off.flags.trustRequired,false);
  assert.equal((await me(admin)).features.pendingOrganizers,0,'trustRequired=false: nobody waits for a confirmation');
 }finally{restoreSettings(s);}
});
