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
test('real PHP/MySQL: public guest routes are GET-only, cookie-free, read-only and show initials instead of names',{skip:!base},async()=>{
 const admin=new Client();await admin.login('admin@test.example','AdminForTests2026!');
 const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));
 const make=async(name,date,status)=>(await admin.cmd('tournament.save',{name,city:'Gdańsk',date,mat:'Mata 3',status})).id;
 const open=await make('Publiczny otwarty',day(1),'open'),closed=await make('Publiczny zamknięty',day(2),'closed'),draft=await make('Publiczny roboczy',day(1),'draft'),past=await make('Publiczny miniony',day(-3),'open');
 const athlete={clubId:admin.data.user.clubId,birthDate:'1998-05-05',sex:'F',weight:60,height:168,gradeType:'dan',grade:1,events:['forms'],champion:false};
 for(const name of ['Zofia Żak-Nowicka','Łucja Ostrowska','Anna Maria Kowalczyk'])await admin.cmd('profile.save',{...athlete,name,registration:{...athlete,tournamentId:open}});
 await admin.cmd('draw.create',{tournamentId:open,categoryId:'forms|senior|F|dan|1 Dan'});
 const revision=admin.data.revision;
 const pub=async(query,init={})=>{const r=await fetch(base+'?'+query,init);return {status:r.status,data:await r.json(),headers:r.headers};};
 const list=await pub('route=public');
 assert.equal(list.status,200,JSON.stringify(list.data));assert.equal(list.headers.get('set-cookie'),null);assert.match(list.headers.get('cache-control'),/public/);
 const ids=list.data.tournaments.map(t=>t.id),dates=list.data.tournaments.map(t=>t.date);
 assert.ok(ids.includes(open)&&ids.indexOf(open)<ids.indexOf(closed),JSON.stringify(ids));assert.ok(!ids.includes(draft)&&!ids.includes(past));
 assert.ok(ids.length<=6);assert.deepEqual([...dates].sort(),dates);assert.ok(dates.every(d=>d>=day(0)));
 for(const t of list.data.tournaments)assert.deepEqual(Object.keys(t).sort(),['city','date','id','name','status']);
 const view=await pub('route=public-tournament&id='+open);
 assert.equal(view.status,200,JSON.stringify(view.data));assert.equal(view.headers.get('set-cookie'),null);
 assert.deepEqual(view.data.tournament,{id:open,name:'Publiczny otwarty',date:day(1),city:'Gdańsk',status:'open'});
 assert.deepEqual(view.data.summary,{entries:3,clubs:1,categories:1,brackets:1});
 const [category]=view.data.categories;assert.equal(category.code,'UF-01');assert.equal(category.state,'drawn');assert.equal(category.athletes,3);
 const slots=category.bracket.slots.filter(Boolean);
 assert.deepEqual(slots.map(s=>s.initials).sort(),['A. K.','Z. Ż.-N.','Ł. O.'].sort());assert.ok(slots.every(s=>s.club==='Test Warszawa'&&Object.keys(s).length===2));
 const json=JSON.stringify(view.data)+JSON.stringify(list.data);
 for(const word of ['Zofia','Nowicka','Łucja','Ostrowska','Anna','Kowalczyk','1998','birthDate','weight','height','presence','champion','email','passwordHash','clubId','createdBy','Mata 3','activity','revision'])assert.ok(!json.includes(word),word);
 for(const id of [draft,past,'missing','../x']){const r=await pub('route=public-tournament&id='+encodeURIComponent(id));assert.equal(r.status,404);assert.equal(r.data.error,'Turniej nie jest dostępny.');assert.equal(r.headers.get('set-cookie'),null);}
 const post=await pub('route=public',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');
 await admin.load();assert.equal(admin.data.revision,revision,'public routes never write');
});
