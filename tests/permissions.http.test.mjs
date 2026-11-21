// The Administrator's permission matrix over real PHP and MariaDB/MySQL (panel "Uprawnienia", MatDraw\Permissions). Run through
// scripts/test-http.sh after tests/http.test.mjs (accounts admin@ and editor@test.example). Scenarios: admin only (403 for staff and
// members, 401 for guests) before any data is read; nothing stored = defaults, version 0; fixed cells, unknown cells, unknown
// disciplines and global permissions in a discipline set are refused (400) and write nothing; a save stores the matrix under the
// key 'permissions' of the app_settings row without touching the settings version, writes the history line settings.permissions
// and takes effect on the next command (the editor cannot create tournaments, in one discipline or everywhere); a stale version is
// refused (409 code stale); the workspace carries the matrix once one is stored. The row is removed afterwards.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client,base,fixture} from './helpers/http-client.mjs';
import {warsawToday} from '../dist/guest-view.js';
import {defaults} from '../dist/permissions.js';
const skip=!base;
const ADMIN=['admin@test.example','AdminForTests2026!'];
const day=n=>warsawToday(new Date(Date.now()+n*864e5));
let admin,editor;
const audit=()=>fixture('settings-audit',{after:0}).filter(r=>r.action==='settings.permissions');
async function view(){const r=await admin.req('admin-permissions');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function save(body,status=200){const r=await admin.req('admin-permissions-save',body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
const tour=(sport,name)=>({name,city:'Opole',date:day(120),mat:'Mata 1',status:'draft',sport});

before(async()=>{if(!base)return;fixture('reset-limits');fixture('settings-reset');admin=new Client();await admin.login(...ADMIN);editor=new Client();await editor.login('editor@test.example');});
after(()=>{if(base)fixture('settings-reset');});

test('admin only; nothing stored: the defaults, version 0, every editable cell on',{skip},async()=>{
 for(const [route,body] of [['admin-permissions'],['admin-permissions-save',{version:0,global:{},sports:{}}]])assert.equal((await editor.req(route,body)).status,403,route);
 const guest=new Client();await guest.req('session');assert.equal((await guest.req('admin-permissions')).status,401);
 const v=await view();
 assert.deepEqual(Object.keys(v).sort(),['global','sports','sportsList','updatedAt','updatedBy','version']);
 assert.deepEqual({version:v.version,updatedAt:v.updatedAt,updatedBy:v.updatedBy},{version:0,updatedAt:null,updatedBy:null});
 assert.deepEqual(v.global,defaults().global);assert.deepEqual(v.sports,{});assert.deepEqual(v.sportsList,['taekwondo','karate','boxing','judo','kickboxing','bjj','muaythai','mma']);
 assert.equal(fixture('settings-row'),null,'nothing written');
 assert.equal('perms' in editor.data,false,'no matrix in the workspace');
});

test('refused before anything is written: fixed cells, unknown cells and disciplines, global permissions in a discipline set',{skip},async()=>{
 const bad=[
  {version:0,global:{admin:{'tournament.manage':false}}},             // the Administrator cannot be limited
  {version:0,global:{editor:{'admin.manage':true}}},                  // no ability the code was not built for
  {version:0,global:{guest:{'chat.write':true}}},
  {version:0,global:{editor:{'tournament.create':'no'}}},
  {version:0,global:{nobody:{'chat.write':false}}},
  {version:0,global:{},sports:{atlantis:{}}},
  {version:0,global:{},sports:{karate:{editor:{'athletes.manage':false}}}},
  {version:'0',global:{}},
  {version:0,global:{editor:[false]}},
  {version:0},
 ];
 for(const body of bad)await save(body,400);
 assert.equal(fixture('settings-row'),null,'nothing written');
});

test('a save takes effect on the next command; the settings version stays; history; stale version',{skip},async()=>{
 // Before: the editor creates tournaments in any discipline.
 await editor.load();const before=await editor.cmd('tournament.save',tour('karate','Uprawnienia przed'));assert.ok(before.id);
 // Karate gets its own set without tournament creation for editors.
 const m=defaults();m.sports.karate={};for(const type of ['editor','club','organizer','athlete','guardian','member'])m.sports.karate[type]={};
 m.sports.karate.editor['tournament.create']=false;
 const v1=await save({version:0,global:m.global,sports:m.sports});
 assert.equal(v1.version,1);assert.equal(v1.sports.karate.editor['tournament.create'],false);assert.equal(v1.sports.karate.editor['chat.write'],true,'filled from the global set');
 assert.ok(v1.updatedAt);assert.equal(v1.updatedBy.email,ADMIN[0]);
 const row=fixture('settings-row');assert.equal(row.version,0,'the settings version is not touched');assert.equal(row.data.permissions.v,1);
 const [line]=audit().slice(-1);assert.equal(line.note,'karate=own');assert.equal(line.actor_id,admin.data.user.id);
 await editor.load();assert.ok(editor.data.perms&&editor.data.perms.sports.karate,'the workspace carries the matrix');
 const r=await editor.req('command',{type:'tournament.save',payload:tour('karate','Uprawnienia karate'),expectedRevision:editor.data.revision});
 assert.equal(r.status,403);assert.equal(r.data.error,'Administrator wyłączył tworzenie turniejów w tej dyscyplinie dla Twojego rodzaju konta.');
 await editor.cmd('tournament.save',tour('judo','Uprawnienia judo'));
 // The Administrator is never limited.
 await admin.load();await admin.cmd('tournament.save',tour('karate','Uprawnienia admin'));
 // A stale version is refused and changes nothing.
 const stale=await admin.req('admin-permissions-save',{version:0,global:defaults().global,sports:{}});
 assert.equal(stale.status,409);assert.equal(stale.data.code,'stale');assert.equal(stale.data.error,'Uprawnienia zmienił w międzyczasie ktoś inny. Odśwież stronę.');
 // Back to the defaults: karate inherits again, the editor creates there.
 const v2=await save({version:1,global:defaults().global,sports:{}});assert.equal(v2.version,2);assert.deepEqual(v2.sports,{});
 assert.equal(audit().slice(-1)[0].note,'karate=inherit');
 await editor.load();await editor.cmd('tournament.save',tour('karate','Uprawnienia po'));
});
