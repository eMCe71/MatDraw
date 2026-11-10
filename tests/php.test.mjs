import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {initialWorkspace,ageAt} from '../dist/workspace.js';
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
 // The demo's materials hold the file itself (src), a shape the server never stores: the materials test below compares the server's shape.
 for(const x of db.tournaments)delete x.materials;
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
 // Without a sport: the nearest six of every martial art (older app shells ask without one); every demo tournament has a federation.
 assert.deepEqual(out.upcoming.tournaments.map(x=>x.id),['t-autumn-2026','t-gp-gdansk-2026','t-karate-2026','t-bjj-2026','t-boxing-2027','t-mma-2027']);
 for(const x of out.upcoming.tournaments)assert.deepEqual(Object.keys(x).sort(),['city','date','federation','id','name','sport','status']);
 assert.deepEqual(out.upcoming.sports,{taekwondo:3,karate:2,bjj:1,boxing:1,mma:1,muaythai:1},'counts of every listed tournament, not only the six shown');
 assert.equal(out.upcoming.federations,undefined);
 const [view,draft,past,empty]=out.tournaments;
 assert.equal(draft,null);assert.equal(past,null);assert.deepEqual(empty.categories,[]);
 assert.deepEqual(Object.keys(view).sort(),['categories','summary','tournament']);
 assert.deepEqual(Object.keys(view.tournament).sort(),['city','date','federation','id','name','sport','status']);
 assert.deepEqual(Object.keys(view.summary).sort(),['brackets','categories','clubs','entries']);
 assert.ok(view.categories.some(c=>c.state==='finished')&&view.categories.some(c=>c.state==='progress'));
 for(const c of view.categories){assert.deepEqual(Object.keys(c).sort(),['athletes','bracket','code','event','gradeType','state','subtitle','title','type']);for(const s of c.bracket?.slots||[])if(s)assert.deepEqual(Object.keys(s).sort(),['club','initials']);}
 const json=JSON.stringify(out);
 for(const field of ['birthDate','legacyAge','"age"','weight','height','"grade"','presence','champion','email','password','clubId','profileId','createdBy','"mat"','activity','revision','signature','createdAt'])assert.ok(!json.includes(field),field);
 for(const e of t.entries){assert.ok(!json.includes(e.name),e.name);for(const part of e.name.split(' '))assert.ok(!new RegExp('(^|[^\\p{L}])'+part+'([^\\p{L}]|$)','u').test(json),part);}
});

// Home page per martial art (owner 2026-11-10): the public list of one sport (at most SPORT_LIMIT), of one federation with fed; counts
// per sport (the sport switcher) and per federation of the sport (its filter). A stored tournament without a sport, or with one the
// catalogue does not know, is taekwondo; an unknown federation is none. PHP equals the demo.
test('PHP public projection per martial art: sport and federation filters, counts, unknown values',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',base={city:'Opole',mat:'Mata 1',createdBy:'demo-admin',status:'open',entries:[],draws:{},activity:[]};
 db.tournaments.push({...base,id:'t-curling',name:'Nieznany sport',date:'2026-11-25',sport:'curling',federation:'wkf'},{...base,id:'t-odd-fed',name:'Karate bez federacji',date:'2026-11-26',sport:'karate',federation:'itf'},
  {...base,id:'t-judo',name:'Judo',date:'2026-11-27',sport:'judo',federation:'ijf'},...Array.from({length:14},(_,i)=>({...base,id:'t-box-'+i,name:'Boks '+i,date:'2027-05-'+String(10+i),sport:'boxing',federation:i%2?'iba':null})));
 const cases=[[null,null,6],['taekwondo',null,12],['karate',null,12],['karate','kyokushin',12],['karate','itkf',12],['boxing',null,12],['boxing','iba',12],['judo',null,12],['kickboxing',null,12]];
 for(const [sport,fed,limit] of cases){
  const out=bridge({job:'guest',tournaments:db.tournaments,today,ids:[],limit,sport,fed});
  assert.deepEqual(out.upcoming,guestUpcoming(db.tournaments,today,limit,sport,fed),sport+'/'+fed);
 }
 const list=(sport,fed=null)=>guestUpcoming(db.tournaments,today,12,sport,fed);
 assert.deepEqual(list('taekwondo').tournaments.map(t=>t.id),['t-autumn-2026','t-curling','t-gp-gdansk-2026','t-winter-2027'],'an unknown sport is taekwondo');
 assert.equal(list('taekwondo').tournaments[1].federation,undefined,'a federation of another sport is none');
 assert.deepEqual(list('karate').tournaments.map(t=>[t.id,t.federation]),[['t-odd-fed',undefined],['t-karate-2026','wkf'],['t-kyokushin-2027','kyokushin']]);
 assert.deepEqual([list('karate').federations,list('karate','kyokushin').tournaments.map(t=>t.id),list('karate','itkf').tournaments],[{wkf:1,kyokushin:1},['t-kyokushin-2027'],[]]);
 assert.deepEqual([list('boxing').tournaments.length,list('boxing').federations,list('boxing','iba').tournaments.length,list('boxing').sports.boxing],[12,{worldboxing:1,iba:7},7,15],'at most 12 of a sport; the counts cover the whole list');
 assert.deepEqual(list('kickboxing'),{tournaments:[],sports:list(null).sports,federations:{}});
});

// backend/bin/seed-athletes.php: 90 fictional athletes spread evenly over categories the rules allow.
test('PHP sample athletes fill 21 categories with no blocked or underfilled ones',{skip:!php},()=>{
 for(const date of ['2026-11-14','2027-02-28','2028-02-29']){
  const {clubs,athletes}=bridge({job:'samples',count:90,date,seed:2026});
  assert.equal(athletes.length,90);assert.equal(new Set(athletes.map(a=>a.name)).size,90);
  const entries=athletes.map((a,i)=>({...a,id:'s'+i,club:clubs[a.club],age:ageAt(a.birthDate,date),presence:'pending'}));
  const {items,unassigned}=categories(entries);
  assert.deepEqual(unassigned,[]);assert.equal(items.length,21);
  for(const c of items){assert.ok(c.athletes.length>=5,c.id);if(c.type==='bracket')assert.equal(new Set(c.athletes.map(a=>a.club)).size,c.athletes.length,c.id);}
  assert.ok(clubs.every(c=>c.endsWith(' (demo)')));
 }
});

// Community tournaments in the public projection (PLAN-REJESTRACJA-ROLE §5.6): sparse community/trusted fields, the home list
// without unconfirmed organizers, bracket clubs from the current club (verified name, null when unverified, '' unaffiliated).
import {guestTournaments} from '../dist/workspace.js';
test('PHP public projection equals the demo for community tournaments, unverified, merged and unaffiliated clubs',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',now=Math.floor(Date.now()/1000);
 db.users.push({id:'org-u',role:'member',organizer:true,organizerTrustedAt:null,organizerBlockedAt:null},{id:'org-t',role:'member',organizer:true,organizerTrustedAt:now,organizerBlockedAt:null});
 db.clubs.push({id:'c-new',name:'Klub Niezweryfikowany',verified:false},{id:'c-old',name:'Klub Dawny',verified:true,mergedInto:'club-3'});
 const t=db.tournaments[0],[bracketKey]=Object.keys(t.draws),inBracket=new Set(t.draws[bracketKey].slots.filter(Boolean));
 const moved=t.entries.filter(e=>inBracket.has(e.id)).slice(0,3);moved[0].clubId='c-new';moved[1].clubId='unaffiliated';moved[2].clubId='c-old';
 db.tournaments.push({id:'t-community-u',name:'Społeczny',city:'Opole',date:'2026-11-20',mat:'Mata 1',status:'open',createdBy:'org-u',entries:structuredClone(t.entries.slice(0,5)),draws:{},activity:[]},
  {id:'t-community-t',name:'Społeczny potwierdzony',city:'Opole',date:'2026-11-21',mat:'Mata 1',status:'closed',createdBy:'org-t',entries:[],draws:{},activity:[]});
 const list=guestTournaments(db),ids=[t.id,'t-community-u','t-community-t','t-spring-2027'];
 const out=bridge({job:'guest',tournaments:list,today,ids,limit:20});
 assert.deepEqual(out.upcoming,guestUpcoming(list,today,20));assert.deepEqual(out.tournaments,ids.map(id=>guestTournament(list,id,today)));
 assert.ok(!out.upcoming.tournaments.some(x=>x.id==='t-community-u'),'unconfirmed: not on the home list');
 assert.deepEqual(out.upcoming.tournaments.find(x=>x.id==='t-community-t'),{id:'t-community-t',name:'Społeczny potwierdzony',date:'2026-11-21',city:'Opole',status:'closed',sport:'taekwondo',community:true,trusted:true});
 const [staff,community]=out.tournaments;
 assert.deepEqual(Object.keys(staff.tournament).sort(),['city','date','federation','id','name','sport','status'],'staff tournaments keep the five fields, the sport and the federation');
 assert.deepEqual([community.tournament.community,community.tournament.trusted],[true,false],'public under its own address');
 const slots=staff.categories.flatMap(c=>c.bracket?.slots||[]).filter(Boolean),clubs=new Set(slots.map(s=>s.club));
 assert.ok(clubs.has(null)&&clubs.has('')&&!clubs.has('Klub Niezweryfikowany')&&!clubs.has('Klub Dawny'),JSON.stringify([...clubs]));
 for(const s of slots)assert.deepEqual(Object.keys(s).sort(),['club','initials']);
 assert.equal(staff.summary.clubs,new Set(t.entries.map(e=>e.clubId==='c-old'?'club-3':e.clubId).filter(c=>c!=='unaffiliated')).size,'unaffiliated is not a club; a merged club counts as its target');
 // Without currentClub (callers before this plan) the snapshot club is shown, '' for unaffiliated.
 const plain=bridge({job:'guest',tournaments:db.tournaments,today,ids:[t.id]});assert.deepEqual(plain.tournaments,[guestTournament(db.tournaments,t.id,today)]);
});

// Self-entries in the public preview (PLAN-REJESTRACJA-ROLE §7.1, §10.1; follow-up F2): the sparse selfEntry:true while the
// tournament takes self-entries (open, switched on), only in the preview, never on the home list; PHP equals the demo.
test('PHP public projection: sparse selfEntry in the preview of an open tournament with self-entries only (F2)',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',base={city:'Opole',mat:'Mata 1',createdBy:'demo-admin',entries:[],draws:{},activity:[]};
 db.users.push({id:'org-x',role:'member',organizer:true,organizerTrustedAt:null,organizerBlockedAt:null});
 db.tournaments.push({...base,id:'t-self-open',name:'Zapisy własne',date:'2026-11-20',status:'open',selfEntry:true},{...base,id:'t-self-closed',name:'Zapisy zamknięte',date:'2026-11-21',status:'closed',selfEntry:true},
  {...base,id:'t-self-off',name:'Bez zapisów własnych',date:'2026-11-22',status:'open',selfEntry:false},{...base,id:'t-self-org',name:'Społeczny z zapisami',date:'2026-11-23',status:'open',selfEntry:true,createdBy:'org-x'},
  {...base,id:'t-self-draft',name:'Roboczy',date:'2026-11-24',status:'draft',selfEntry:true});
 const list=guestTournaments(db),ids=['t-self-open','t-self-closed','t-self-off','t-self-org','t-self-draft','t-winter-2027',db.tournaments[0].id];
 const out=bridge({job:'guest',tournaments:list,today,ids,limit:20});
 assert.deepEqual(out.upcoming,guestUpcoming(list,today,20));assert.deepEqual(out.tournaments,ids.map(id=>guestTournament(list,id,today)));
 for(const x of out.upcoming.tournaments)assert.ok(!('selfEntry' in x),'never on the home list: '+x.id);
 const [open,closed,off,org,draft,winter,staff]=out.tournaments;
 assert.deepEqual(open.tournament,{id:'t-self-open',name:'Zapisy własne',date:'2026-11-20',city:'Opole',status:'open',sport:'taekwondo',selfEntry:true});
 assert.deepEqual([closed.tournament.selfEntry,off.tournament.selfEntry,draft],[undefined,undefined,null],'closed, switched off, draft');
 assert.deepEqual(org.tournament,{id:'t-self-org',name:'Społeczny z zapisami',date:'2026-11-23',city:'Opole',status:'open',sport:'taekwondo',community:true,trusted:false,selfEntry:true});
 assert.equal(winter.tournament.selfEntry,true,'demo t-winter-2027 takes self-entries');
 assert.deepEqual(Object.keys(staff.tournament).sort(),['city','date','federation','id','name','sport','status'],'a staff tournament without self-entries: no selfEntry field');
});

// Materials in the public projection (PLAN-MATERIALY §2.1, §4): GuestView adds the sparse poster {v,w,h,color} and rules {v,size,type} to
// the summary of the list and of the preview, from the server's meta (f and a rules text never leave), nothing for invalid meta or a closed
// creator (guestTournaments hands no materials over then); dist/guest-view.js gives the same once the frontend half of the
// feature (dist/materials.js) is installed.
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
test('PHP public projection: sparse poster and rules in the list and the preview, never the stored file names',{skip:!php},()=>{
 const db=drawn(),today='2026-10-31',base={city:'Opole',mat:'Mata 1',createdBy:'demo-admin',entries:[],draws:{},activity:[]};
 const P={f:'9'.repeat(32)+'.webp',w:1240,h:1754,c:'#2b4c7e',at:1793484000},R={f:'8'.repeat(32)+'.pdf',b:48000,at:1793484000};
 db.users.push({id:'org-b',role:'member',organizer:true,organizerTrustedAt:1,organizerBlockedAt:1});
 db.tournaments.push({...base,id:'t-poster',name:'Z plakatem',date:'2026-11-20',status:'open',materials:{poster:P,rules:R}},{...base,id:'t-rules',name:'Z regulaminem',date:'2026-11-21',status:'closed',materials:{rules:R}},
  {...base,id:'t-broken',name:'Zepsute materiały',date:'2026-11-22',status:'open',materials:{poster:{...P,f:'x.webp'},rules:{...R,extra:1}}},{...base,id:'t-blocked',name:'Zablokowany',date:'2026-11-23',status:'open',createdBy:'org-b',materials:{poster:P}},
  {...base,id:'t-text',name:'Z regulaminem w tekście',date:'2026-11-24',status:'open',materials:{rules:{t:'Regulamin zawodów\n\n- tajny punkt',at:1793484000}}});
 const list=guestTournaments(db),ids=['t-poster','t-rules','t-broken','t-blocked','t-text'];
 const out=bridge({job:'guest',tournaments:list,today,ids,limit:20});
 const poster={v:'9'.repeat(12),w:1240,h:1754,color:'#2b4c7e'},rules={v:'8'.repeat(12),size:48000,type:'pdf'};
 const listed=id=>out.upcoming.tournaments.find(x=>x.id===id);
 assert.deepEqual(listed('t-poster'),{id:'t-poster',name:'Z plakatem',date:'2026-11-20',city:'Opole',status:'open',sport:'taekwondo',poster,rules});
 assert.deepEqual(listed('t-rules'),{id:'t-rules',name:'Z regulaminem',date:'2026-11-21',city:'Opole',status:'closed',sport:'taekwondo',rules});
 assert.deepEqual(Object.keys(listed('t-broken')).sort(),['city','date','id','name','sport','status'],'invalid meta: nothing');
 const [p,r,broken,blocked,text]=out.tournaments;
 assert.deepEqual([listed('t-text').rules,text.tournament.rules],Array(2).fill({v:createHash('sha256').update('Regulamin zawodów\n\n- tajny punkt').digest('hex').slice(0,12),size:32,type:'text'}),'a typed text: v and size (characters) only');
 assert.deepEqual([p.tournament.poster,p.tournament.rules,r.tournament.poster,r.tournament.rules],[poster,rules,undefined,rules]);
 assert.deepEqual(Object.keys(broken.tournament).sort(),['city','date','id','name','sport','status']);
 assert.equal(blocked.tournament.poster,undefined,'a blocked organizer\'s tournament: the material route refuses its files, so no poster');
 const json=JSON.stringify(out);assert.ok(!json.includes('.webp')&&!json.includes('.pdf')&&!json.includes('"at"')&&!json.includes('tajny punkt'),'stored meta never leaves');
 if(existsSync(new URL('../dist/materials.js',import.meta.url))){
  // The demo may add the text to its own views (it has no material route); the rest equals the server's.
  const server=v=>{const o=JSON.parse(JSON.stringify(v));for(const x of [...(o?.tournaments??[]),o?.tournament].filter(Boolean))if(x.rules)delete x.rules.text;return o;};
  assert.deepEqual(out.upcoming,server(guestUpcoming(list,today,20)));assert.deepEqual(out.tournaments,ids.map(id=>server(guestTournament(list,id,today))));
 }
});
