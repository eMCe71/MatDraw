// Martial arts of the home page (owner 2026-11-10): dist/sports.js and backend/src/Sports.php agree (ids, federations, the chat
// lobby, the retired channels of the old PL/world split), every sport has an English label, a colour pair with readable contrast and
// its mascot files with the declared sizes (not precached); tournament.save checks the sport and the federation the same way in the
// demo (dist/workspace.js) and in PHP (Domain).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {SPORTS,SPORT_IDS,DEFAULT_SPORT,RETIRED,LOBBY,federationsOf,federationOf,hasFederations,generalSlug,lobbyOf,tournamentSport,tournamentFederation,profileSports,fromProfile} from '../dist/sports.js';
import {t as T,setLanguage,getLanguage} from '../dist/i18n.js';
import {initialWorkspace,execute} from '../dist/workspace.js';
import {DENY} from '../scripts/build-pwa.mjs';
const php=process.env.PHP_BIN;
const read=file=>readFileSync(new URL('../'+file,import.meta.url));

test('the catalogue: the owner\'s eight martial arts in order, federations, chat channels per sport, the retired PL/world ones',()=>{
 assert.deepEqual(SPORT_IDS,['taekwondo','karate','boxing','judo','kickboxing','bjj','muaythai','mma']);assert.equal(DEFAULT_SPORT,'taekwondo');
 assert.deepEqual(SPORTS.map(s=>s.label),['Taekwondo','Karate','Boks','Judo','Kickboxing','Jiu-Jitsu','Muay Thai','MMA']);
 for(const s of SPORTS){
  assert.ok(s.federations.every(f=>f.length===3&&/^[a-z]+$/.test(f[0])&&f[1]&&f[2]),s.id);assert.equal(new Set(s.federations.map(f=>f[0])).size,s.federations.length,s.id);
  // A sport with two or more federations has a filter and a channel per federation; with one, only its general channel.
  const channels=LOBBY.filter(c=>c.sport===s.id);
  assert.deepEqual(channels.map(c=>c.fed),[null,...(hasFederations(s.id)?s.federations.map(f=>f[0]):[])],s.id);
  assert.equal(channels[0].slug,generalSlug(s.id));
 }
 assert.equal(generalSlug('taekwondo'),'taekwondo-pl','Taekwondo keeps the Polish conversations of its old channel');
 assert.deepEqual(RETIRED,['taekwondo','general']);assert.ok(RETIRED.every(slug=>!lobbyOf(slug)));
 assert.equal(new Set(LOBBY.map(c=>c.slug)).size,LOBBY.length);assert.ok(LOBBY.every(c=>/^[a-z-]{3,40}$/.test(c.slug)));
 assert.deepEqual(federationsOf('curling'),[]);assert.equal(federationOf('karate','itf'),null);
 // Stored tournaments before migration 0010 have no sport: taekwondo, no federation; a federation of another sport is none.
 assert.deepEqual([tournamentSport({}),tournamentSport({sport:'curling'}),tournamentSport({sport:'mma'}),tournamentFederation({federation:'itf'}),tournamentFederation({sport:'karate',federation:'itf'}),tournamentFederation({sport:'karate',federation:'wkf'})],['taekwondo','taekwondo','mma','itf',null,'wkf']);
 // Profile sports (athlete profiles): Japanese jiu-jitsu goes with jiu-jitsu, wrestling and other with none.
 assert.deepEqual([profileSports(['wrestling','jujitsu','bjj','karate']),fromProfile(['other']),fromProfile(null),fromProfile(['judo','mma'])],[['bjj','karate'],null,null,'judo']);
});

test('PHP Sports mirrors dist/sports.js: ids, federations, the lobby in display order, the retired channels, the default',{skip:!php},()=>{
 const r=spawnSync(php,['-r',"require 'backend/bootstrap.php';echo json_encode(['default'=>MatDraw\\Sports::DEFAULT,'federations'=>MatDraw\\Sports::FEDERATIONS,'lobby'=>MatDraw\\Sports::LOBBY,'retired'=>MatDraw\\Sports::RETIRED,'order'=>array_map(fn($s)=>MatDraw\\Sports::order($s),['taekwondo-pl','mma-almma','taekwondo','general',null])]);"],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr||r.stdout);const k=JSON.parse(r.stdout);
 assert.equal(k.default,DEFAULT_SPORT);
 assert.deepEqual(k.federations,Object.fromEntries(SPORTS.map(s=>[s.id,s.federations.map(f=>f[0])])));
 assert.deepEqual(Object.entries(k.lobby),LOBBY.map(c=>[c.slug,[c.sport,c.fed]]));
 assert.deepEqual(k.retired,RETIRED);
 assert.deepEqual(k.order.slice(0,2),[0,LOBBY.length-1]);assert.ok(k.order.slice(2).every(n=>n>LOBBY.length),'retired and unknown slugs sort last');
});

test('every sport and the texts of the home page have English labels; federation names are proper names',()=>{
 const before=getLanguage();setLanguage('en',{persist:false});
 try{
  assert.deepEqual(SPORTS.map(s=>T(s.label)),['Taekwondo','Karate','Boxing','Judo','Kickboxing','Jiu-Jitsu','Muay Thai','MMA']);
  assert.deepEqual([T('Czat · {sport}',{sport:'Judo'}),T('{n} turniejów',{n:1}),T('{n} turniejów',{n:3}),T('Brak turniejów federacji {federation}',{federation:'WKF'}),T('Wybierz sztukę walki')],['Chat · Judo','1 tournament','3 tournaments','No WKF tournaments','Choose your martial art']);
 }finally{setLanguage(before,{persist:false});}
 setLanguage('pl',{persist:false});
 try{assert.deepEqual([1,2,5,22].map(n=>T('{n} turniejów',{n})),['1 turniej','2 turnieje','5 turniejów','22 turnieje']);}finally{setLanguage(before,{persist:false});}
});

// WCAG 1.4.3: white text on --sport (the selected chat tab and chip), navy text on --sport-tint (the pressed federation chip, the
// chosen sport on phones, the next date) and --sport-tint as text on the navy columns of the home page.
const luminance=hex=>{const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4);return 0.2126*r+0.7152*g+0.0722*b;};
const contrast=(a,b)=>{const [x,y]=[luminance(a),luminance(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
test('colours per martial art (tokens.css): one pair per sport, readable on white, under navy text and on the navy columns',()=>{
 const css=read('dist/tokens.css').toString(),pairs={};
 const base=css.match(/:root,\[data-sport\]\{--sport:(#[0-9a-f]{6});--sport-tint:(#[0-9a-f]{6})\}/);assert.ok(base,'default pair on :root and [data-sport]');pairs.taekwondo=[base[1],base[2]];
 for(const m of css.matchAll(/\[data-sport="([a-z]+)"\]\{--sport:(#[0-9a-f]{6});--sport-tint:(#[0-9a-f]{6})\}/g))pairs[m[1]]=[m[2],m[3]];
 assert.deepEqual(Object.keys(pairs).sort(),[...SPORT_IDS].sort());
 assert.equal(new Set(Object.values(pairs).map(p=>p[0])).size,SPORT_IDS.length,'a different colour for every sport');
 for(const [sport,[fill,tint]] of Object.entries(pairs)){
  assert.ok(contrast(fill,'#ffffff')>=4.5,sport+' white on '+fill+': '+contrast(fill,'#ffffff').toFixed(2));
  assert.ok(contrast(tint,'#0b1d3a')>=4.5,sport+' navy on '+tint+': '+contrast(tint,'#0b1d3a').toFixed(2));
  for(const navy of ['#102447','#183460'])assert.ok(contrast(tint,navy)>=4.5,sport+' '+tint+' on '+navy+': '+contrast(tint,navy).toFixed(2));
 }
});

const webpSize=buf=>{
 assert.equal(buf.toString('latin1',0,4),'RIFF');assert.equal(buf.toString('latin1',8,12),'WEBP');const kind=buf.toString('latin1',12,16);
 if(kind==='VP8X')return [buf.readUIntLE(24,3)+1,buf.readUIntLE(27,3)+1];
 if(kind==='VP8 ')return [buf.readUInt16LE(26)&0x3fff,buf.readUInt16LE(28)&0x3fff];
 if(kind==='VP8L'){const b=buf.readUInt32LE(21);return [(b&0x3fff)+1,((b>>>14)&0x3fff)+1];}
 throw new Error('not a WebP: '+kind);
};
test('mascots: a figure and a chooser tile per sport, WebP of the declared size, light, not precached (only the chosen sport loads)',()=>{
 for(const s of SPORTS){
  const m=s.mascot;assert.ok(m,s.id);
  for(const [src,w,h,max] of [[m.src,m.w,m.h,60000],[m.tile,m.tw,m.th,20000]]){
   assert.match(src,/^\.\/brand\/(?:sports\/)?[\w.-]+\.webp$/,s.id);
   const file='dist/'+src.slice(2);assert.ok(existsSync(new URL('../'+file,import.meta.url)),file);
   const buf=read(file);assert.deepEqual(webpSize(buf),[w,h],file);assert.ok(buf.length<=max,file+' '+buf.length+' bytes');
   if(src.startsWith('./brand/sports/'))assert.ok(DENY.some(r=>r.test(src.slice(2))),file+' stays out of the precache');
  }
  assert.equal(m.h,488,'every figure has the height of the default one: '+s.id);
 }
 assert.equal(SPORTS[0].mascot.src,'./brand/matbravo-welcome.webp','taekwondo keeps the precached default figure');
});

// tournament.save (Domain::execute / workspace.js execute): the sport and the federation are checked against the catalogue, kept
// when the payload leaves them out, and a new sport drops a federation it does not have.
const SAVE={name:'Puchar Testowy',city:'Opole',date:'2027-03-20',status:'draft',mat:'Mata 1'};
const commands=[
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'karate',federation:'wkf'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'judo'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'boxing',federation:''}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'curling'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'karate',federation:'itf'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:null}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,sport:'mma',federation:7}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,id:'t-autumn-2026',name:'Puchar Jesieni 2026',city:'Warszawa',date:'2026-11-14',status:'open'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,id:'t-winter-2027',name:'Puchar Zimy 2027',city:'Kraków',date:'2027-02-20',status:'open',sport:'karate'}},
 {actor:'demo-admin',type:'tournament.save',payload:{...SAVE,id:'t-gp-gdansk-2026',name:'Grand Prix Pomorza 2026',city:'Gdańsk',date:'2026-12-05',status:'closed',sport:'taekwondo'}}
];
function demoRun(db){
 const out=[];
 for(const c of commands){try{const r=execute(db,c.actor,c.type,c.payload);db=r.db;out.push({status:200,result:r.result});}catch(e){out.push({status:e.status,error:e.message});}}
 return {db,results:out};
}
const shape=db=>db.tournaments.map(t=>[t.name,t.sport??null,t.federation??null]);
test('tournament.save: sport and federation from the catalogue, kept when left out, the federation dropped with a new sport (demo)',()=>{
 const {db,results}=demoRun(initialWorkspace());
 assert.deepEqual(results.map(r=>r.status),[200,200,200,422,422,422,422,200,200,200,200]);
 assert.deepEqual(results.slice(3,7).map(r=>r.error),['Wybierz sztukę walki z listy.','Wybierz federację z listy.','Wybierz sztukę walki z listy.','Wybierz federację z listy.']);
 const created=db.tournaments.slice(-4).map(t=>[t.sport,t.federation]);
 assert.deepEqual(created,[['karate','wkf'],['judo',null],['boxing',null],['taekwondo',null]],'a new tournament without a sport is taekwondo');
 const by=id=>db.tournaments.find(t=>t.id===id);
 assert.deepEqual([[by('t-autumn-2026').sport,by('t-autumn-2026').federation],[by('t-winter-2027').sport,by('t-winter-2027').federation],[by('t-gp-gdansk-2026').sport,by('t-gp-gdansk-2026').federation]],[['taekwondo','itf'],['karate',null],['taekwondo','wt']],'kept when left out; a new sport drops the old federation; the same sport keeps it');
});
test('tournament.save: PHP Domain gives the same statuses, messages and stored sport and federation as the demo',{skip:!php},()=>{
 const db=initialWorkspace(),demo=demoRun(structuredClone(db));
 const r=spawnSync(php,['tests/php-bridge.php'],{input:JSON.stringify({job:'commands',db,commands}),encoding:'utf8',maxBuffer:10_000_000});
 assert.equal(r.status,0,r.stderr||r.stdout);const out=JSON.parse(r.stdout);
 assert.deepEqual(out.results.map(x=>[x.status,x.error??null]),demo.results.map(x=>[x.status,x.error??null]));
 assert.deepEqual(shape(out.db),shape(demo.db));
});
