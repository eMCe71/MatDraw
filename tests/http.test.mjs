// Requires an isolated initialized test DB, PHP server, and MATDRAW_TEST_URL.
// Fixture credentials are test-only; never deploy test database/configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
const base=process.env.MATDRAW_TEST_URL;
class Client{
 cookie='';csrf='';data=null;
 async req(route,body,extra={}){const r=await fetch(base+'?route='+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:this.cookie,'X-CSRF-Token':this.csrf,...extra},...(body?{body:JSON.stringify(body)}:{})});const cookie=r.headers.getSetCookie()?.at(-1);if(cookie)this.cookie=cookie.split(';')[0];const data=await r.json();if(data.csrf)this.csrf=data.csrf;return {status:r.status,data};}
 async login(email,password='TestPassword2026!'){await this.req('session');const r=await this.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return this.load();}
 async load(){const r=await this.req('bootstrap');assert.equal(r.status,200,JSON.stringify(r.data));this.data=r.data;return r.data;}
 async cmd(type,payload,status=200,revision=this.data.revision){const r=await this.req('command',{type,payload,expectedRevision:revision});assert.equal(r.status,status,JSON.stringify(r.data));if(status===200)this.data=r.data.workspace;return r.data.result;}
}
test('real PHP/MySQL: sessions, role isolation, multiple tournaments, atomicity and concurrency',{skip:!base},async()=>{
 const admin=new Client(),rep=new Client(),editor=new Client(),other=new Client();
 assert.equal((await admin.req('bootstrap')).status,401);
 await admin.login('admin@test.example','AdminForTests2026!');
 assert.equal((await admin.req('command',{type:'tournament.save',payload:{},expectedRevision:admin.data.revision},{'X-CSRF-Token':'wrong'})).status,403);
 const account=await admin.cmd('account.save',{email:'club@test.example',password:'TestPassword2026!',clubName:'Test Kraków',role:'club'});
 await admin.cmd('account.save',{email:'editor@test.example',password:'TestPassword2026!',clubId:admin.data.user.clubId,role:'editor'});
 await admin.cmd('account.save',{email:'other@test.example',password:'TestPassword2026!',clubName:'Test Poznań',role:'club'});
 const tour={name:'Turniej pierwszy',city:'Warszawa',date:'2027-01-10',mat:'Mata 1',status:'open'};
 const t1=(await admin.cmd('tournament.save',tour)).id,t2=(await admin.cmd('tournament.save',{...tour,name:'Turniej drugi',date:'2027-03-10'})).id;
 await rep.login('club@test.example');await editor.login('editor@test.example');await other.login('other@test.example');
 await rep.cmd('tournament.save',tour,403);await editor.cmd('account.save',{},403);
 await editor.cmd('tournament.save',{...tour,id:t1},403);
 const a={name:'Testowy Zawodnik',birthDate:'2010-02-01',sex:'M',weight:60,height:170,gradeType:'cup',grade:6,events:['forms'],clubId:admin.data.user.clubId};
 const pid=(await rep.cmd('profile.save',a)).id;
 assert.equal(rep.data.profiles[0].clubId,rep.data.user.clubId);
 for(const tournamentId of [t1,t2])await rep.cmd('entry.save',{...a,profileId:pid,tournamentId});
 assert.equal(rep.data.tournaments.find(t=>t.id===t1).entries[0].age,16);assert.equal(rep.data.tournaments.find(t=>t.id===t2).entries[0].age,17);
 await rep.cmd('entry.save',{...a,profileId:pid,tournamentId:t1},409);
 await other.load();assert.equal(other.data.profiles.length,0);assert.ok(other.data.tournaments.every(t=>t.entries.length===0));
 await other.cmd('entry.save',{...a,profileId:pid,tournamentId:t1},403);
 await rep.cmd('checkin.save',{tournamentId:t1,id:pid,presence:'absent'},403);
 await admin.load();await admin.cmd('checkin.save',{tournamentId:t1,id:pid,presence:'present',actualWeight:61});
 assert.equal(admin.data.tournaments.find(t=>t.id===t2).entries[0].actualWeight,null);
 await rep.load();await rep.cmd('profile.save',{...a,id:pid,name:'Nowe nazwisko',weight:64});
 assert.equal(rep.data.tournaments.find(t=>t.id===t1).entries[0].name,a.name);
 const count=rep.data.profiles.length;await rep.cmd('profile.save',{...a,registration:{...a,tournamentId:t1,events:['soft']}},422);await rep.load();assert.equal(rep.data.profiles.length,count);
 await admin.load();await admin.cmd('tournament.save',{...tour,id:t1,date:'2027-01-11'},409);
 await admin.cmd('tournament.save',{...tour,id:t1,status:'closed'});await rep.load();await rep.cmd('entry.remove',{tournamentId:t1,id:pid},403);
 await admin.cmd('tournament.save',{...tour,id:t1,status:'finished'});await admin.cmd('checkin.save',{tournamentId:t1,id:pid,presence:'absent'},409);
 const a2=new Client();await a2.login('admin@test.example','AdminForTests2026!');await admin.load();
 const revision=admin.data.revision;
 const writes=await Promise.all([admin.req('command',{type:'tournament.save',payload:{...tour,name:'Równoczesny A'},expectedRevision:revision}),a2.req('command',{type:'tournament.save',payload:{...tour,name:'Równoczesny B'},expectedRevision:revision})]);
 assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
 await admin.load();await admin.cmd('account.save',{id:admin.data.user.id,email:admin.data.user.email,clubId:admin.data.user.clubId,role:'club'},409);
 const user=admin.data.users.find(u=>u.id===account.id);await admin.cmd('account.save',{...user,active:false});assert.equal((await rep.req('bootstrap')).status,401);
 await admin.cmd('account.save',{...user,active:true,password:'NewTestPassword2026!'});assert.equal((await rep.req('login',{email:user.email,password:'TestPassword2026!'})).status,401);
 assert.ok(!JSON.stringify(admin.data).includes('passwordHash'));assert.ok(!JSON.stringify(admin.data).includes('authVersion'));
 await admin.req('logout',{});assert.equal((await admin.req('bootstrap')).status,401);
});
