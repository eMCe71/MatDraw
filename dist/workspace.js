import {EVENTS,initialState,validateAthlete,categories,makeDraw,signature,saveWinner,clearWinner} from './engine.js';

export const ROLES={admin:'Administrator',editor:'Edytor',club:'Reprezentant klubu'};
export const STATUSES={draft:'Roboczy',open:'Zapisy otwarte',closed:'Zapisy zamknięte',finished:'Zakończony'};
export class DomainError extends Error {constructor(message,status=422){super(message);this.status=status;}}
const fail=(message,status=422)=>{throw new DomainError(message,status);};
const find=(list,id,label)=>list.find(x=>x.id===id)||fail(label+' nie istnieje.',404);
const text=(v,label,max=100)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('Sprawdź pole: '+label+'.');return v.trim();};
const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
export function dateValid(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function ageAt(birthDate,date){if(!dateValid(birthDate)||!dateValid(date))fail('Podaj poprawną datę.');const b=birthDate.split('-').map(Number),d=date.split('-').map(Number);return d[0]-b[0]-(d[1]<b[1]||(d[1]===b[1]&&d[2]<b[2])?1:0);}
export const managesTournament=(user,t)=>!!user&&(user.role==='admin'||user.role==='editor'&&t?.createdBy===user.id);
export const managesProfile=(user,a)=>!!user&&(user.role==='admin'||user.role==='club'&&a?.clubId===user.clubId||user.role==='editor'&&a?.createdBy===user.id);
export const canEnter=(user,t)=>!!user&&t&&t.status!=='finished'&&(managesTournament(user,t)||t.status==='open');
const publicUser=u=>{const {passwordHash,passwordSalt,authVersion,...safe}=u;return safe;};
export function publicWorkspace(db,user){
 const own=a=>user.role!=='club'||a.clubId===user.clubId;
 return {schemaVersion:2,revision:db.revision,user:publicUser(user),clubs:db.clubs.filter(c=>user.role!=='club'||c.id===user.clubId),users:user.role==='admin'?db.users.map(publicUser):[],profiles:db.profiles.filter(own),tournaments:db.tournaments.filter(t=>managesTournament(user,t)||t.status!=='draft'&&(user.role!=='club'||t.status==='open'||t.entries.some(own))).map(t=>({...t,entries:t.entries.filter(own),draws:user.role==='club'?{}:t.draws,activity:user.role==='club'?[]:t.activity}))};
}
export function initialWorkspace(legacy){
 const old=legacy?.schemaVersion===1?legacy:initialState();
 const clubs=[...new Set(old.athletes.map(a=>a.club))].map((name,i)=>({id:'club-'+(i+1),name}));
 if(!clubs.length)clubs.push({id:'club-1',name:'TKD Warszawa'});
 const users=[{id:'demo-admin',clubId:clubs[0].id,email:'admin@matdraw.example',role:'admin',active:true,authVersion:1},{id:'demo-editor',clubId:clubs[0].id,email:'editor@matdraw.example',role:'editor',active:true,authVersion:1},{id:'demo-club',clubId:clubs[0].id,email:'club@matdraw.example',role:'club',active:true,authVersion:1}];
 const profiles=old.athletes.map(a=>({id:a.id,name:a.name,clubId:clubs.find(c=>c.name===a.club).id,sex:a.sex,birthDate:null,legacyAge:a.age,legacyDate:old.tournament.date,weight:a.weight,height:a.height,gradeType:a.gradeType,grade:a.grade,events:a.events,champion:!!a.champion,createdBy:'demo-admin',archived:false}));
 const entries=old.athletes.map(a=>({...a,profileId:a.id,clubId:profiles.find(p=>p.id===a.id).clubId}));
 const t={...old.tournament,id:'t-autumn-2026',status:'open',createdBy:'demo-admin',entries,draws:old.draws||{},activity:old.activity||[]};
 const second={id:'t-winter-2027',name:'Puchar Zimy 2027',city:'Kraków',date:'2027-02-20',mat:'Mata 1',status:'open',createdBy:'demo-editor',entries:[],draws:{},activity:[]};
 // A further published date and an unpublished draft: the login screen's public list shows the first, never the draft.
 const third={id:'t-gp-gdansk-2026',name:'Grand Prix Pomorza 2026',city:'Gdańsk',date:'2026-12-05',mat:'Mata 1',status:'closed',createdBy:'demo-editor',entries:[],draws:{},activity:[]};
 const draft={id:'t-spring-2027',name:'Puchar Wiosny 2027',city:'Wrocław',date:'2027-04-17',mat:'Mata 1',status:'draft',createdBy:'demo-admin',entries:[],draws:{},activity:[]};
 return {schemaVersion:2,revision:1,clubs,users,profiles,tournaments:[t,second,third,draft]};
}
function validateProfile(p){
 const v={...p,age:25,club:'Klub',events:['forms']};validateAthlete(v);
 if(!dateValid(p.birthDate)&&!p.legacyAge)fail('Podaj datę urodzenia.');
 if(p.birthDate&&(p.birthDate<'1900-01-01'||p.birthDate>new Date().toISOString().slice(0,10)))fail('Sprawdź datę urodzenia.');
 text(p.name,'imię i nazwisko');
 if(!p.events.length||p.events.some(e=>!Object.hasOwn(EVENTS,e)))fail('Wybierz poprawne konkurencje.');
}
function reconcile(t,nextEntries){
 const cats=categories(nextEntries).items;
 for(const [key,d] of Object.entries(t.draws)){
  const c=cats.find(c=>c.id===key);
  if(!c||c.underfilled||signature(c.athletes)!==d.signature){if(Object.keys(d.results).length)fail('Ta zmiana narusza kategorię z wynikami. Najpierw wycofaj zależne wyniki.',409);delete t.draws[key];}
 }
 t.entries=nextEntries;
}
function audit(t,message){t.activity.unshift({text:message,time:new Date().toISOString()});t.activity=t.activity.slice(0,40);}
function requireManager(user,t){if(!managesTournament(user,t))fail('Brak uprawnień do zarządzania tym turniejem.',403);if(t.status==='finished')fail('Zakończony turniej jest tylko do odczytu.',409);}
function apply(db,user,type,p){
 if(type==='account.save'){
  if(user.role!=='admin')fail('Tylko Administrator zarządza kontami.',403);
  const current=p.id?find(db.users,p.id,'Konto'):null;
  const email=text(p.email,'e-mail',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Podaj poprawny e-mail.');
  if(db.users.some(u=>u.id!==current?.id&&u.email.toLowerCase()===email))fail('Konto z tym adresem e-mail już istnieje.',409);
  if(!Object.hasOwn(ROLES,p.role))fail('Wybierz poprawną rolę.');
  let club=db.clubs.find(c=>c.id===p.clubId);
  if(!club&&p.clubName){const name=text(p.clubName,'nazwa klubu');club=db.clubs.find(c=>c.name.toLocaleLowerCase('pl')===name.toLocaleLowerCase('pl'));if(!club){club={id:id(),name};db.clubs.push(club);}}
  if(!club)fail('Wybierz klub lub wpisz nazwę nowego klubu.');
  const active=p.active!==false;
  if(current?.role==='admin'&&current.active&&(p.role!=='admin'||!active)&&!db.users.some(u=>u.id!==current.id&&u.active&&u.role==='admin'))fail('Musi pozostać co najmniej jeden aktywny Administrator.',409);
  const next={...(current||{id:id(),authVersion:1}),clubId:club.id,email,role:p.role,active};
  if(current&&(current.role!==next.role||current.clubId!==next.clubId||current.active!==active||current.email!==email))next.authVersion++;
  if(current)Object.assign(current,next);else db.users.push(next);
  return {id:next.id};
 }
 if(type==='tournament.save'){
  if(!['admin','editor'].includes(user.role))fail('Nie możesz tworzyć turniejów.',403);
  const t=p.id?find(db.tournaments,p.id,'Turniej'):null;
  if(t&&!managesTournament(user,t))fail('Możesz edytować tylko własne turnieje.',403);
  if(!dateValid(p.date))fail('Podaj poprawną datę turnieju.');
  if(!Object.hasOwn(STATUSES,p.status))fail('Niepoprawny status zapisów.');
  if(t&&t.entries.length&&t.date!==p.date)fail('Data turnieju ze zgłoszeniami jest zablokowana. Utwórz nowy turniej, aby zachować poprawny wiek zawodników.',409);
  const data={name:text(p.name,'nazwa turnieju'),city:text(p.city,'miasto'),date:p.date,mat:text(p.mat||'Mata 1','mata',50),status:p.status};
  if(t){Object.assign(t,data);audit(t,'Zaktualizowano ustawienia turnieju.');return {id:t.id};}
  const next={...data,id:id(),createdBy:user.id,entries:[],draws:{},activity:[]};audit(next,'Utworzono turniej.');db.tournaments.push(next);return {id:next.id};
 }
 if(type==='profile.save'){
  const old=p.id?find(db.profiles,p.id,'Zawodnik'):null;
  if(old&&!managesProfile(user,old))fail('Nie możesz edytować tej kartoteki zawodnika.',403);
  const clubId=user.role==='club'?user.clubId:p.clubId;find(db.clubs,clubId,'Klub');
  if(old&&old.clubId!==clubId&&user.role!=='admin')fail('Klub zawodnika może zmienić Administrator.',403);
  const next={...(old||{id:id(),createdBy:user.id,archived:false}),name:text(p.name,'imię i nazwisko'),clubId,sex:p.sex,birthDate:p.birthDate||null,weight:Number(p.weight),height:Number(p.height),gradeType:p.gradeType,grade:Number(p.grade),events:Array.isArray(p.events)?[...new Set(p.events)]:['forms'],champion:!!p.champion};
  validateProfile(next);
  if(old)Object.assign(old,next);else db.profiles.push(next);
  if(p.registration)apply(db,user,'entry.save',{...p.registration,profileId:next.id});
  return {id:next.id};
 }
 if(type==='profile.archive'){
  const a=find(db.profiles,p.id,'Zawodnik');if(!managesProfile(user,a))fail('Brak uprawnień do archiwizacji.',403);a.archived=!!p.archived;return {id:a.id};
 }
 const t=find(db.tournaments,p.tournamentId,'Turniej');
 if(type==='entry.save'){
  if(!canEnter(user,t))fail('Zapisy do tego turnieju są zamknięte.',403);
  const a=find(db.profiles,p.profileId,'Zawodnik');if(a.archived)fail('Zawodnik jest zarchiwizowany.');
  if(user.role==='club'&&a.clubId!==user.clubId)fail('Możesz zgłaszać tylko zawodników swojego klubu.',403);
  const existing=t.entries.find(e=>e.profileId===a.id);
  if(existing&&!p.update)fail('Ten zawodnik jest już zgłoszony do turnieju.',409);
  if(existing&&user.role==='editor'&&!managesTournament(user,t)&&a.createdBy!==user.id)fail('Nie możesz zmienić tego zgłoszenia.',403);
  if(existing&&Object.values(t.draws).some(d=>d.slots.includes(existing.id)&&Object.keys(d.results).length))fail('Zawodnik ma zapisane wyniki. Nie można teraz zmieniać zgłoszenia.',409);
  const club=find(db.clubs,a.clubId,'Klub');
  const entry={id:a.id,profileId:a.id,clubId:a.clubId,name:a.name,club:club.name,sex:a.sex,age:a.birthDate?ageAt(a.birthDate,t.date):Number(p.age),weight:Number(p.weight),height:Number(p.height),gradeType:p.gradeType,grade:Number(p.grade),champion:!!p.champion,events:[...new Set(p.events||[])],presence:existing?.presence||'pending',actualWeight:existing?.actualWeight??null};
  validateAthlete(entry);reconcile(t,existing?t.entries.map(x=>x.id===entry.id?entry:x):[...t.entries,entry]);audit(t,(existing?'Zmieniono zgłoszenie: ':'Zgłoszono: ')+entry.name);return {id:entry.id};
 }
 if(type==='entry.remove'){
  if(!canEnter(user,t))fail('Zapisy są zamknięte.',403);
  const a=find(t.entries,p.id,'Zgłoszenie');
  if(!managesTournament(user,t)&&(user.role==='club'?a.clubId!==user.clubId:find(db.profiles,a.profileId,'Zawodnik').createdBy!==user.id))fail('Nie możesz wycofać tego zgłoszenia.',403);
  reconcile(t,t.entries.filter(x=>x.id!==a.id));audit(t,'Wycofano zgłoszenie: '+a.name);return {id:a.id};
 }
 requireManager(user,t);
 if(type==='checkin.save'){
  const a=find(t.entries,p.id,'Zgłoszenie');if(!['present','pending','absent'].includes(p.presence))fail('Nieprawidłowy status obecności.');
  const w=p.presence==='absent'||p.presence==='pending'?a.actualWeight:Number(p.actualWeight);
  if(p.presence==='present'&&(!Number.isFinite(w)||w<10||w>250))fail('Podaj wagę od 10 do 250 kg.');
  if(Object.values(t.draws).some(d=>d.slots.includes(a.id)&&Object.keys(d.results).length)&&(a.actualWeight!==w||a.presence!==p.presence))fail('Zawodnik ma zapisane wyniki. Najpierw wycofaj wyniki.',409);
  reconcile(t,t.entries.map(x=>x.id===a.id?{...a,actualWeight:w,presence:p.presence}:x));audit(t,'Kontrola startowa: '+a.name);return {id:a.id};
 }
 if(type==='draw.create'){
  const c=categories(t.entries).items.find(c=>c.id===p.categoryId);if(!c||c.type!=='bracket')fail('Nie ma takiej kategorii drabinkowej.');
  const old=t.draws[c.id];if(old&&Object.keys(old.results).length)fail('Nie można losować po zapisaniu wyników.',409);
  const draw=makeDraw(c.athletes,Math.floor(Math.random()*2147483647));draw.revision=(old?.revision||0)+1;t.draws[c.id]=draw;audit(t,'Zapisano losowanie: '+c.title+' · '+c.subtitle);return {id:c.id};
 }
 if(type==='result.save'||type==='result.clear'){
  const d=t.draws[p.categoryId];if(!d)fail('Najpierw zapisz losowanie.');
  if(type==='result.save')saveWinner(d,p.matchId,p.winnerId);else clearWinner(d,p.matchId);
  audit(t,type==='result.save'?'Zapisano wynik walki.':'Wycofano wynik walki.');return {id:p.matchId};
 }
 fail('Nieznana operacja.',400);
}
export function execute(db,actorId,type,p={},expectedRevision=db.revision){
 const user=find(db.users,actorId,'Konto');if(!user.active)fail('Konto jest zablokowane.',403);
 if(expectedRevision!==db.revision)fail('Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409);
 const next=structuredClone(db),actor=find(next.users,actorId,'Konto');const result=apply(next,actor,type,p);next.revision++;
 return {db:next,result};
}
