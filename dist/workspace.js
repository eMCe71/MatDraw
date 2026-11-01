import {EVENTS,initialState,validateAthlete,eligibility,categories,makeDraw,signature,saveWinner,clearWinner} from './engine.js';
import {cleanText,clubKey} from './profile-data.js';
import {initials,warsawToday} from './guest-view.js';
/* Workspace rules of the browser demo: mirror of backend/src/Domain.php and backend/src/Clubs.php (plan §5–§7 of
 * PLAN-REJESTRACJA-ROLE). tests/roles-parity.test.mjs runs the same commands through both and compares statuses, messages of
 * the new paths and the normalised state; Domain::forgetMember and Domain::retain are PHP only. Members of the demo live in
 * db.users (the PHP workspace holds only staff plus the actor of the request); db.flags {organizers, trustRequired} mirrors
 * Settings::flags (missing = 'on', true). Times are epoch seconds, dates Europe/Warsaw (warsawToday). */

export const ROLES={admin:'Administrator',editor:'Edytor',club:'Reprezentant klubu'};
export const STATUSES={draft:'Roboczy',open:'Zapisy otwarte',closed:'Zapisy zamknięte',finished:'Zakończony'};
export class DomainError extends Error {constructor(message,status=422,data){super(message);this.status=status;if(data)this.data=data;}}
const fail=(message,status=422,data)=>{throw new DomainError(message,status,data);};
const find=(list,id,label)=>list.find(x=>x.id===id)||fail(label+' nie istnieje.',404);
const text=(v,label,max=100)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('Sprawdź pole: '+label+'.');return v.trim();};
const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
export const ORGANIZER_DAY=3,ORGANIZER_ACTIVE=10,COMMUNITY_DAY_GLOBAL=50,ORGANIZER_PROFILES_DAY=300,CLUBS_DAY_PER_USER=3,CLUBS_DAY_GLOBAL=30,MINOR_SELF_AGE=16,ADULT_AGE=18,ATHLETES_PER_ACCOUNT=1,RETENTION_MONTHS=24;
export const STAFF=['admin','editor','club'];
export const ORGANIZER_TYPES=['tournament.save','profile.save','profile.archive','profile.forget','entry.save','entry.remove','checkin.save','draw.create','result.save','result.clear'];
/** Web addresses, e-mails and numbers of 9+ digits in texts of members (§5.4); the same pattern as Domain::CONTACT. */
export const CONTACT=/(?:https?:\/\/|www\.|@|(?<![\p{L}\p{N}_])[\p{L}\p{N}-]+\.(?:pl|com|eu|net|org|info|io|me|app|link|ly|gg|online|site|shop|xyz)(?![\p{L}\p{N}_])|\p{Nd}(?:[\s./-]?\p{Nd}){8,})/iu;
export const contact=s=>CONTACT.test(s);
export const UNAFFILIATED='unaffiliated',DELETED='Dane usunięte';
const NONE_KEYS=['niezrzeszony','niezrzeszona','brak','bezklubu','none'];
const TOURNAMENT_SCOPE=['entry.remove','checkin.save','draw.create','result.save','result.clear','tournament.hide'];
/** Log lines that end with an athlete's name, as Domain::NAMED; audit() marks each with the athlete's profileId. */
const NAMED=/^((?:Zgłoszono|Zmieniono zgłoszenie|Zgłoszenie własne|Zmieniono zgłoszenie własne|Zmieniono klub w zgłoszeniu|Kontrola startowa|Wycofano zgłoszenie): )(.+)$/su;
const nowSeconds=()=>Math.floor(Date.now()/1000);
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const has=(o,k)=>isObj(o)&&Object.hasOwn(o,k);
const isset=v=>v!==undefined&&v!==null;
const chars=s=>[...s].length;
const phpTrim=s=>s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g,'');
// PHP-equal validation for the new commands (Domain::txt, Domain::number, Domain::date, Rules::validate): same messages.
const txt=(v,label,max=100)=>{if(typeof v!=='string'||phpTrim(v)===''||chars(phpTrim(v))>max)fail('Sprawdź pole: '+label+'.');return phpTrim(v);};
const NUMERIC=/^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
function number(v,min,max,integer=false){
 if(!(typeof v==='number'||typeof v==='string'&&NUMERIC.test(v)))fail('Niepoprawna wartość liczbowa.');
 const n=Number(v);if(!Number.isFinite(n)||n<min||n>max||integer&&Math.floor(n)!==n)fail('Wartość liczbowa jest poza zakresem.');return integer?Math.trunc(n):n;
}
function dateOf(v){if(typeof v!=='string'||!dateValid(v))fail('Podaj poprawną datę.');return v;}
function rulesValidate(a){
 txt(a.name,'imię i nazwisko');txt(a.club,'klub');
 if(!['M','F'].includes(a.sex)||!['cup','dan'].includes(a.gradeType))fail('Sprawdź płeć i rodzaj stopnia.');
 number(a.age,7,100,true);number(a.weight,10,250);number(a.height,70,250);number(a.grade,1,a.gradeType==='cup'?10:9,true);
 if(!Array.isArray(a.events)||!a.events.length||a.events.length>7)fail('Wybierz co najmniej jedną konkurencję.');
 for(const e of a.events){if(typeof e!=='string'||!Object.hasOwn(EVENTS,e))fail('Nieznana konkurencja.');const x=eligibility(a,e);if(x)fail(x);}
}
export function dateValid(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function ageAt(birthDate,date){if(!dateValid(birthDate)||!dateValid(date))fail('Podaj poprawną datę.');const b=birthDate.split('-').map(Number),d=date.split('-').map(Number);return d[0]-b[0]-(d[1]<b[1]||(d[1]===b[1]&&d[2]<b[2])?1:0);}

// Roles and visibility (§5.7). Without db, profile and tournament rules read the view fields staff, community and trusted,
// so app.js keeps calling managesProfile(user,a) and canEnter(user,t) with workspace objects.
// The PHP bootstrap's user carries only caps {organizer, organizerBlocked} (no organizer/organizerBlockedAt fields), the demo
// users and the domain actors carry the fields: without them the caps decide, so the browser workspace sees its own tournaments.
export const organizer=u=>!!u&&u.role==='member'&&(typeof u.organizer==='boolean'||'organizerBlockedAt' in u?!!u.organizer&&!u.organizerBlockedAt:!!u.caps?.organizer&&!u.caps.organizerBlocked);
export function staffIds(db){const s=Object.create(null);for(const u of db.users)if(STAFF.includes(u.role))s[u.id]=true;return s;}
export const staffProfile=(db,a)=>db?a.ownerId==null&&!!staffIds(db)[a.createdBy]:a?.staff===true;
export const community=(db,t)=>db?!staffIds(db)[t.createdBy]:!!t?.community;
const trustRequired=db=>db?.flags?.trustRequired!==false;
/** A member creator confirmed by the Administrator and not blocked; with flags.trustRequired=false every creator not blocked (§17). */
export function trustedOrganizer(db,userId){
 if(typeof userId!=='string')return false;let o=isObj(db.organizers)&&Object.hasOwn(db.organizers,userId)?db.organizers[userId]:null;
 if(!o){const u=db.users.find(x=>x.id===userId&&x.role==='member');if(u)o={trusted:isset(u.organizerTrustedAt),blocked:isset(u.organizerBlockedAt)};}
 return !!o&&!o.blocked&&(!!o.trusted||!trustRequired(db));
}
export const trusted=(db,t)=>db?!community(db,t)||trustedOrganizer(db,t.createdBy):!t?.community||!!t?.trusted;
export const manages=(user,t)=>!!user&&!!t&&(user.role==='admin'||(user.role==='editor'||organizer(user))&&t.createdBy===user.id);
export const managesTournament=manages;
export function managesProfile(user,a,db){
 if(!user||!a)return false;if(user.role==='admin')return true;
 if(isset(a.ownerId))return a.ownerId===user.id;
 if(user.role==='club')return staffProfile(db,a)&&a.clubId===user.clubId;
 return (user.role==='editor'||organizer(user))&&a.createdBy===user.id;
}
export const outsideEntry=(user,t,db)=>!!user&&!!t&&t.status==='open'&&trusted(db,t)&&(user.role==='club'||user.role==='editor'||organizer(user)&&t.selfEntry===true);
export const canEnter=(user,t,db)=>!!user&&!!t&&t.status!=='finished'&&(manages(user,t)||outsideEntry(user,t,db));
export const canCreateTournament=user=>!!user&&(user.role==='admin'||user.role==='editor'||organizer(user));
const byId=rows=>new Map(rows.map(r=>[r.id,r]));
/** Club of a snapshot read through the Administrator's merges (roots: clubRoots), as Domain::entryVisible (final review B7). */
function entryVisible(db,u,t,e,profiles,roots){
 const a=profiles.get(e.profileId)??null;
 if(u.role==='club'){let id=e.clubId??null;if(id!==u.clubId&&typeof id==='string')id=(roots??clubRoots(db.clubs)).get(id)??id;return id===u.clubId&&!!a&&staffProfile(db,a);}
 if(u.role==='editor')return !community(db,t)||!!a&&!isset(a.ownerId)&&a.createdBy===u.id;
 return organizer(u)&&!!a&&managesProfile(u,a,db);
}
/** Whether user sees tournament t (§5.2): admin and the manager always; others never drafts and only trusted tournaments. */
export function sees(db,u,t,profiles,roots){
 if(u.role==='admin'||manages(u,t))return true;
 if(t.status==='draft'||!trusted(db,t)||!['editor','club','member'].includes(u.role)||u.role==='member'&&!organizer(u))return false;
 if(u.role==='editor'&&!community(db,t))return true;
 if(t.status==='open'&&(u.role!=='member'||t.selfEntry===true))return true;
 profiles??=byId(db.profiles);if(u.role==='club')roots??=clubRoots(db.clubs);return t.entries.some(e=>entryVisible(db,u,t,e,profiles,roots));
}
function profileVisible(db,u,a){return u.role==='admin'?true:u.role==='editor'?staffProfile(db,a):u.role==='club'?staffProfile(db,a)&&a.clubId===u.clubId:organizer(u)&&managesProfile(u,a,db);}
const publicUser=u=>{const {passwordHash,passwordSalt,authVersion,...safe}=u;return safe;};
/** The workspace of user (§5.2 matrix), equal to Domain::publicData; a member without the organizer role gets the empty shape. */
export function publicWorkspace(db,user){
 const role=user.role,admin=role==='admin',out={schemaVersion:2,revision:db.revision,user:publicUser(user),clubs:[],users:[],profiles:[],tournaments:[]};
 if(role==='member'&&!organizer(user))return out;
 const profiles=byId(db.profiles),used=new Set(),roots=role==='club'?clubRoots(db.clubs):null;
 for(const t of db.tournaments){
  if(!sees(db,user,t,profiles,roots))continue;
  const manager=admin||manages(user,t),isCommunity=community(db,t),hidden=isset(t.hiddenBy);
  const entries=t.entries.filter(e=>manager?!(hidden&&!admin&&e.self):entryVisible(db,user,t,e,profiles,roots));for(const e of entries)used.add(e.clubId??'');
  const full=manager||role==='editor'&&!isCommunity;let draws=full?t.draws:{},activity=full?t.activity.map(({text,time})=>({text,time})):[];
  if(manager&&hidden&&!admin){const ids=new Set(entries.map(e=>e.id));draws=Object.fromEntries(Object.entries(draws).filter(([,d])=>d.slots.filter(Boolean).every(x=>ids.has(x))));activity=[];}
  const v={...t,entries,draws,activity,community:isCommunity,trusted:trusted(db,t),selfEntry:t.selfEntry===true,rev:Number(t.rev)||0};
  if(manager){v.hidden=hidden;v.hideReason=t.hideReason??null;}else{delete v.hideReason;delete v.createdAt;}
  if(admin){v.hiddenBy=t.hiddenBy??null;v.hiddenFrom=t.hiddenFrom??null;}else{delete v.hiddenBy;delete v.hiddenFrom;}
  if(!manager&&(isCommunity||role==='member'))delete v.createdBy;
  out.tournaments.push(v);
 }
 for(const a of db.profiles){
  if(!profileVisible(db,user,a))continue;
  const owner=isset(a.ownerId)&&a.ownerId===user.id,v={...a,staff:staffProfile(db,a)};
  if(!admin&&!owner)delete v.ownerId;
  if(!admin&&!owner&&a.createdBy!==user.id)for(const k of ['relation','guardianDeclaredAt','guardianConsentAt','consentBy','pendingClubName'])delete v[k];
  out.profiles.push(v);used.add(a.clubId??'');
 }
 for(const c of db.clubs){
  if(admin){out.clubs.push(c);continue;}
  if(role==='club'?c.id!==user.clubId:!((c.verified!==false&&!isset(c.mergedInto))||used.has(c.id)))continue;
  const {createdBy,createdAt,...rest}=c;out.clubs.push(rest);
 }
 if(admin)out.users=db.users.filter(u=>STAFF.includes(u.role)).map(publicUser);
 return out;
}
/** Tournaments as Repository::guestTournaments() hands them to GuestView: community and trusted flags, and for every entry the current club. */
export function guestTournaments(db){return (db?.tournaments||[]).map(t=>({...t,community:community(db,t),trusted:trusted(db,t),entries:t.entries.map(e=>({...e,currentClub:currentClub(db.clubs||[],e.clubId)}))}));}
/** The club shown publicly for a snapshot's clubId (§5.6): merged → target; name '' for 'unaffiliated', null when unverified. */
export function currentClub(clubs,clubId){const c=resolveClub(clubs,clubId),clubIdNow=c?.id??clubId??null;return {id:clubIdNow,name:clubIdNow===UNAFFILIATED?'':c&&c.verified!==false?c.name:null};}

// Clubs (mirror of Clubs::resolve, Clubs::counts, Clubs::pick).
export function resolveClub(clubs,clubId){
 if(typeof clubId!=='string')return null;const m=byId(clubs);let cur=clubId;
 for(let hop=0;hop<8&&m.has(cur);hop++){const c=m.get(cur);if(!isset(c.mergedInto))return c;cur=c.mergedInto;}
 return null;
}
/** Mirror of Clubs::roots: id → the id resolveClub gives (the end of the merges), the id itself when it resolves to nothing. */
export function clubRoots(clubs){
 const by=new Map(clubs.map(c=>[c.id,c.mergedInto??null])),out=new Map();
 for(const id of by.keys()){let cur=id,root=null;for(let hop=0;hop<8&&by.has(cur);hop++){if(by.get(cur)===null){root=cur;break;}cur=by.get(cur);}out.set(id,root??id);}
 return out;
}
/** Mirror of Domain::drawAthletes (final review B9): athletes of a category with clubKey, the club their snapshot means now (through
 * merges; a renamed club keeps its id), else 'name:'+clubKey(club); engine.js sameClub compares it. Snapshots and signature() stay. */
export function drawAthletes(clubs,athletes){const roots=clubRoots(clubs||[]);return athletes.map(a=>({...a,clubKey:(typeof a.clubId==='string'?roots.get(a.clubId):null)??'name:'+clubKey(a.club??'')}));}
const isNum=v=>typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&NUMERIC.test(v);
export function clubCounts(clubs,u,now){let user=0,global=0;for(const c of clubs){if(c.verified!==false||!isNum(c.createdAt)||Math.trunc(Number(c.createdAt))<=now-86400)continue;global++;if((c.createdBy??null)===(u?.id??null))user++;}return {user,global};}
export function pickClub(clubs,u,choice,now,counts={}){
 const member=u?.role==='member';
 if(choice?.none===true)return {clubId:UNAFFILIATED};
 if(has(choice,'id')){const c=resolveClub(clubs,choice.id);if(!c)fail('Klub nie istnieje.',404);return {clubId:c.id};}
 if(!has(choice,'name'))fail('Wybierz klub lub wpisz nazwę nowego klubu.');
 const name=cleanText(choice.name),key=clubKey(name);
 if(name===null||chars(name)<2||chars(name)>100||!/\p{L}/u.test(name)||chars(key)<2)fail('Sprawdź pole: nazwa klubu.');
 if(NONE_KEYS.includes(key))return {clubId:UNAFFILIATED};
 if(member&&contact(name))fail('Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.');
 for(const c of clubs)if(clubKey(c.name)===key){const t=resolveClub(clubs,c.id);if(t)return {clubId:t.id};}
 if(member&&((counts.user??0)>=CLUBS_DAY_PER_USER||(counts.global??0)>=CLUBS_DAY_GLOBAL))return {clubId:UNAFFILIATED,pendingClubName:name,notice:'club-pending'};
 const club={id:id(),name,verified:STAFF.includes(u?.role),createdBy:u?.id??null,createdAt:now,mergedInto:null};return {clubId:club.id,newClub:club};
}

// Revisions (§5.8).
const revOf=(rows,key)=>{if(typeof key!=='string')return 0;const x=rows.find(r=>r.id===key);return x?Number(x.rev)||0:0;};
/** Mirror of Domain::stale: a command is stale only when the objects it touches changed after the client's revision. */
export function stale(db,type,p,expected,actorId=null){
 const rev=db.revision;if(expected===rev)return false;if(expected>rev)return true;
 if(expected<(Number(db.revFloor)||0))return true;// a revision from before migration 0007 (Domain::stale, final review B8)
 const tour=k=>revOf(db.tournaments,k)>expected,prof=k=>revOf(db.profiles,k)>expected,staff=(Number(db.staffRev)||0)>expected;
 const own=k=>actorId!==null&&db[k].some(x=>x.createdBy===actorId&&!isset(x.ownerId)&&(Number(x.rev)||0)>expected);
 const reg=isObj(p.registration)?p.registration.tournamentId:null;
 if(type==='entry.save')return tour(p.tournamentId)||prof(p.profileId);
 if(TOURNAMENT_SCOPE.includes(type))return tour(p.tournamentId);
 if(type==='tournament.save')return isset(p.id)?tour(p.id):staff||own('tournaments');
 if(type==='profile.save')return (isset(p.id)?prof(p.id):staff||own('profiles'))||tour(reg);
 if(type==='profile.archive'||type==='profile.forget')return prof(p.id);
 if(type.startsWith('account.')||type.startsWith('club.'))return staff;
 return true;
}
const canon=v=>Array.isArray(v)?v.map(canon):isObj(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const same=(a,b)=>a===b||JSON.stringify(canon(a))===JSON.stringify(canon(b));
function stamp(before,db,always=true){
 const R=db.revision+1;let changed=false;
 for(const k of ['tournaments','profiles']){const old=byId(before[k]);if(old.size!==db[k].length)changed=true;for(const x of db[k]){const o=old.get(x.id);if(o&&same(o,x))continue;x.rev=R;changed=true;}}
 const staff=d=>d.users.filter(u=>STAFF.includes(u.role)),clubs=byId(before.clubs);let staffChanged=!same(staff(before),staff(db));
 for(const c of db.clubs)if(clubs.has(c.id)&&!same(clubs.get(c.id),c))staffChanged=true;
 if(staffChanged)db.staffRev=R;changed=changed||staffChanged||clubs.size!==db.clubs.length||!same(before.withdrawals??[],db.withdrawals??[]);
 if(changed||always)db.revision=R;return changed;
}

export function initialWorkspace(legacy){
 const old=legacy?.schemaVersion===1?legacy:initialState();
 const clubs=[...new Set(old.athletes.map(a=>a.club))].map((name,i)=>({id:'club-'+(i+1),name,verified:true}));
 if(!clubs.length)clubs.push({id:'club-1',name:'TKD Warszawa',verified:true});
 const users=[{id:'demo-admin',clubId:clubs[0].id,email:'admin@matdraw.example',role:'admin',active:true,authVersion:1},{id:'demo-editor',clubId:clubs[0].id,email:'editor@matdraw.example',role:'editor',active:true,authVersion:1},{id:'demo-club',clubId:clubs[0].id,email:'club@matdraw.example',role:'club',active:true,authVersion:1},
  // Community accounts of the demo (§10.7): an organizer (not yet confirmed) and a parent with one child's athlete profile.
  {id:'demo-organizer',clubId:null,email:'organizer@matdraw.example',role:'member',active:true,authVersion:1,organizer:true,organizerBlockedAt:null,organizerTrustedAt:null},
  {id:'demo-athlete',clubId:null,email:'athlete@matdraw.example',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null}];
 const profiles=old.athletes.map(a=>({id:a.id,name:a.name,clubId:clubs.find(c=>c.name===a.club).id,sex:a.sex,birthDate:null,legacyAge:a.age,legacyDate:old.tournament.date,weight:a.weight,height:a.height,gradeType:a.gradeType,grade:a.grade,events:a.events,champion:!!a.champion,createdBy:'demo-admin',archived:false}));
 const entries=old.athletes.map(a=>({...a,profileId:a.id,clubId:profiles.find(p=>p.id===a.id).clubId}));
 clubs.push({id:UNAFFILIATED,name:clubs.some(c=>clubKey(c.name)==='niezrzeszony')?'Niezrzeszony (bez klubu)':'Niezrzeszony',verified:true});
 profiles.push({id:'demo-athlete-child',name:'Zuzanna Demo',clubId:clubs[Math.min(1,clubs.length-1)].id,sex:'F',birthDate:'2012-03-08',weight:42,height:152,gradeType:'cup',grade:7,events:['forms'],champion:false,createdBy:'demo-athlete',createdAt:1793484000,archived:false,ownerId:'demo-athlete',relation:'guardian',guardianDeclaredAt:1793484000});
 const t={...old.tournament,id:'t-autumn-2026',status:'open',createdBy:'demo-admin',selfEntry:false,entries,draws:old.draws||{},activity:old.activity||[]};
 const second={id:'t-winter-2027',name:'Puchar Zimy 2027',city:'Kraków',date:'2027-02-20',mat:'Mata 1',status:'open',createdBy:'demo-editor',selfEntry:true,entries:[],draws:{},activity:[]};
 // A further published date and an unpublished draft: the login screen's public list shows the first, never the draft.
 const third={id:'t-gp-gdansk-2026',name:'Grand Prix Pomorza 2026',city:'Gdańsk',date:'2026-12-05',mat:'Mata 1',status:'closed',createdBy:'demo-editor',selfEntry:false,entries:[],draws:{},activity:[]};
 const draft={id:'t-spring-2027',name:'Puchar Wiosny 2027',city:'Wrocław',date:'2027-04-17',mat:'Mata 1',status:'draft',createdBy:'demo-admin',selfEntry:false,entries:[],draws:{},activity:[]};
 return {schemaVersion:2,revision:1,staffRev:1,clubs,users,profiles,tournaments:[t,second,third,draft]};
}
function validateProfile(p){
 const v={...p,age:25,club:'Klub',events:['forms']};validateAthlete(v);
 if(!dateValid(p.birthDate)&&!p.legacyAge)fail('Podaj datę urodzenia.');
 if(p.birthDate&&(p.birthDate<'1900-01-01'||p.birthDate>warsawToday()))fail('Sprawdź datę urodzenia.');
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
/** A log line; profileId marks a line naming an athlete (NAMED), as Domain::audit; publicWorkspace shows text and time only. */
function audit(t,message,profileId=null){t.activity.unshift({text:message,time:new Date().toISOString(),...(isset(profileId)?{profileId}:{})});t.activity=t.activity.slice(0,40);}
function requireManager(user,t){if(!manages(user,t))fail('Brak uprawnień do zarządzania tym turniejem.',403);if(t.status==='finished')fail('Zakończony turniej jest tylko do odczytu.',409);}
// Lookups for members: a missing and an unseen object give the same 404 (PS-15).
function tour(db,u,key,seen=true){if(u.role!=='member')return find(db.tournaments,key,'Turniej');return db.tournaments.find(t=>t.id===key&&(!seen||sees(db,u,t)))||fail('Turniej nie jest dostępny.',404);}
function prof(db,u,key,allowed=false){if(u.role!=='member')return find(db.profiles,key,'Zawodnik');return db.profiles.find(a=>a.id===key&&(allowed||managesProfile(u,a,db)))||fail('Zawodnik nie istnieje.',404);}
const clubChoice=p=>isObj(p.club)?p.club:p.clubName&&!p.clubId?{name:p.clubName}:{id:p.clubId??null};
const within=(rows,now,match)=>rows.filter(x=>isNum(x.createdAt)&&Math.trunc(Number(x.createdAt))>now-86400&&match(x)).map(x=>Math.trunc(Number(x.createdAt)));
const pending=(db,profileId)=>db.tournaments.some(t=>['open','closed'].includes(t.status)&&t.entries.some(e=>e.profileId===profileId));
const inDraw=(t,entryId)=>Object.values(t.draws).some(d=>d.slots.includes(entryId));
/** Mirror of Domain::keepDraws (DR-5, R8; final review B1): an entry in a saved draw is neither changed nor withdrawn, and entryId
 * joins no category with a saved draw, unless the tournament's manager does it. */
function keepDraws(t,old,list,entryId){
 if(old&&inDraw(t,old.id))fail('Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.',409);
 if(list&&categories(list).items.some(c=>Object.hasOwn(t.draws,c.id)&&c.athletes.some(x=>x.id===entryId)))fail('Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.',409);
}
/** Mirror of Domain::guarded: members anywhere, staff in community tournaments (staff in staff tournaments keep the a67ad42 rule). */
const guarded=(db,u,t)=>u.role==='member'||community(db,t);
const unWithdraw=(db,profileId,tournamentId)=>{db.withdrawals=(db.withdrawals||[]).filter(w=>!(w.profileId===profileId&&w.tournamentId===tournamentId));};
const withdrawn=(db,e,tournamentId,by)=>{db.withdrawals.push({profileId:e.profileId,tournamentId,by,at:nowSeconds()});};
const replace=(list,item)=>{const i=list.findIndex(x=>x.id===item.id);if(i<0)list.push(item);else list[i]=item;};
/** Snapshot of profile a for tournament t (§7.2); self-entries (strict) validate numbers like Domain::snapshot. */
function snapshot(db,a,t,p,old,self=false){
 const club=find(db.clubs,a.clubId,'Klub');
 const e=self?{id:a.id,profileId:a.id,clubId:a.clubId,name:a.name,club:club.name,sex:a.sex,age:a.birthDate?ageAt(a.birthDate,t.date):number(p.age,7,100,true),weight:number(p.weight,10,250),height:number(p.height,70,250),gradeType:p.gradeType??null,grade:number(p.grade,1,10,true),events:Array.isArray(p.events)?[...new Set(p.events)]:[],champion:false,presence:old?.presence??'pending',actualWeight:old?.actualWeight??null,self:true}
  :{id:a.id,profileId:a.id,clubId:a.clubId,name:a.name,club:club.name,sex:a.sex,age:a.birthDate?ageAt(a.birthDate,t.date):Number(p.age),weight:Number(p.weight),height:Number(p.height),gradeType:p.gradeType,grade:Number(p.grade),champion:!!p.champion,events:[...new Set(p.events||[])],presence:old?.presence||'pending',actualWeight:old?.actualWeight??null};
 return e;
}
/** Mirror of Domain::athleteFields (§6.1): the fields of athlete.save and the sign-up, with the server's messages. */
export function athleteFields(p,today){
 const relation=p?.relation;if(!['self','guardian'].includes(relation))fail('Wybierz, kogo zgłaszasz.');
 const name=txt(cleanText(p.name),'imię i nazwisko');
 if(!p.birthDate)fail('Podaj datę urodzenia.');const birth=dateOf(p.birthDate);if(birth<'1900-01-01'||birth>today)fail('Sprawdź datę urodzenia.');
 const f={name,birthDate:birth,sex:p.sex??null,weight:number(p.weight,10,250),height:number(p.height,70,250),gradeType:p.gradeType??null,grade:number(p.grade,1,10,true)};
 rulesValidate({...f,age:25,club:'Klub',events:['forms']});
 const c=p.club;
 if(isObj(c)&&c.none===true)f.club={none:true};else if(isObj(c)&&typeof c.id==='string')f.club={id:c.id};else if(isObj(c)&&typeof c.name==='string')f.club={name:c.name};
 else fail('Wybierz klub lub wpisz nazwę nowego klubu.');
 if(relation==='self'&&ageAt(birth,today)<MINOR_SELF_AGE)fail('Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
 f.relation=relation;return f;
}
function organizerLimits(db,user,old,status,date){
 const now=nowSeconds(),today=warsawToday(),isTrusted=trustedOrganizer(db,user.id);
 if(status==='finished'&&date>today)fail('Turniej można zakończyć najwcześniej w dniu zawodów.');
 if(db.flags?.organizers==='paused'&&!isTrusted&&status!=='draft'&&(!old||old.status==='draft'))fail('Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.',409);
 if(!old){
  const mine=within(db.tournaments,now,t=>t.createdBy===user.id);
  if(mine.length>=ORGANIZER_DAY)fail('Limit nowych turniejów: 3 na dobę.',429,{retry:Math.max(1,Math.min(...mine)+86400-now)});
  const all=within(db.tournaments,now,t=>community(db,t)&&!trustedOrganizer(db,t.createdBy));
  if(!isTrusted&&all.length>=COMMUNITY_DAY_GLOBAL)fail('Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.',429,{retry:Math.max(1,Math.min(...all)+86400-now)});
 }
 if(status!=='draft'&&date>=today&&db.tournaments.filter(t=>t.createdBy===user.id&&t.id!==old?.id&&t.status!=='draft'&&t.date>=today&&!isset(t.hiddenBy)).length>=ORGANIZER_ACTIVE)
  fail('Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.',429);
}
// Removal of personal data (§6.6), mirror of Domain::detach and Domain::forgetProfile.
export function detach(t,entryId){
 const e=t.entries.find(x=>x.id===entryId);if(!e)return false;
 const status=isset(t.hiddenBy)?t.hiddenFrom??t.status:t.status;if(status==='finished')return false;
 if(status==='closed'&&categories(t.entries).items.some(c=>Object.hasOwn(t.draws,c.id)&&c.athletes.some(a=>a.id===entryId)))return false;
 const next=structuredClone(t);try{reconcile(next,t.entries.filter(x=>x.id!==entryId));}catch(err){if(err instanceof DomainError)return false;throw err;}
 t.entries=next.entries;t.draws=next.draws;audit(t,'Wycofano zgłoszenie: '+initials(String(e.name)),e.profileId);return true;
}
// Logs never keep a forgotten name: lines marked with the profile in every tournament; unmarked (older) lines by name only where the
// profile has an entry or the actor manages the tournament, namesakes with entries excepted. Snapshots only with useInitials.
export function forgetProfile(db,profileId,useInitials=false,actor=null){
 const i=db.profiles.findIndex(a=>a.id===profileId);if(i<0)return 'missing';
 const names=[...new Set([db.profiles[i].name,...db.tournaments.flatMap(t=>t.entries.filter(e=>e.profileId===profileId).map(e=>e.name))].map(n=>String(n??'')))].filter(n=>n!==''&&n!==DELETED);let left=false;
 for(const t of db.tournaments){
  const entered=t.entries.some(e=>e.profileId===profileId);if(entered&&!detach(t,profileId))left=true;
  if(useInitials)for(const e of t.entries)if(e.profileId===profileId)e.name=initials(String(e.name));
  unname(t,profileId,names,entered||!!actor&&manages(actor,t));
 }
 if(!left){db.profiles.splice(i,1);return 'deleted';}
 Object.assign(db.profiles[i],{name:DELETED,birthDate:null,ownerId:null,relation:null,guardianDeclaredAt:null,guardianConsentAt:null,consentBy:null,pendingClubName:null,archived:true});return 'anonymized';
}
function unname(t,profileId,names,legacy){
 const kept=new Set(t.entries.filter(e=>e.profileId!==profileId).map(e=>String(e.name)));
 for(const x of t.activity){
  const s=String(x.text),mark=x.profileId??null;
  if(mark===profileId){const m=NAMED.exec(s);if(m)x.text=m[1]+initials(m[2]);continue;}
  if(mark!==null||!legacy)continue;
  const n=names.find(n=>!kept.has(n)&&s.endsWith(': '+n));if(n!==undefined)x.text=s.slice(0,s.length-n.length)+initials(n);
 }
}
function apply(db,user,type,p){
 const now=nowSeconds(),today=warsawToday(),member=user.role==='member',admin=user.role==='admin';
 if(type==='account.save'){
  if(user.role!=='admin')fail('Tylko Administrator zarządza kontami.',403);
  const current=p.id?find(db.users,p.id,'Konto'):null;
  const email=text(p.email,'e-mail',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Podaj poprawny e-mail.');
  if(db.users.some(u=>u.id!==current?.id&&u.email.toLowerCase()===email))fail('Konto z tym adresem e-mail już istnieje.',409);
  if(!Object.hasOwn(ROLES,p.role))fail('Wybierz poprawną rolę.');
  let club=db.clubs.find(c=>c.id===p.clubId);
  if(club&&(club.id===UNAFFILIATED||isset(club.mergedInto)))fail('Wybierz klub lub wpisz nazwę nowego klubu.');
  if(!club&&p.clubName){const r=pickClub(db.clubs,user,{name:p.clubName},now);if(r.clubId===UNAFFILIATED)fail('Wybierz klub lub wpisz nazwę nowego klubu.');if(r.newClub)db.clubs.push(r.newClub);club={id:r.clubId};}
  if(!club)fail('Wybierz klub lub wpisz nazwę nowego klubu.');
  const active=p.active!==false;
  if(current?.role==='admin'&&current.active&&(p.role!=='admin'||!active)&&!db.users.some(u=>u.id!==current.id&&u.active&&u.role==='admin'))fail('Musi pozostać co najmniej jeden aktywny Administrator.',409);
  const next={...(current||{id:id(),authVersion:1}),clubId:club.id,email,role:p.role,active};
  if(current&&(current.role!==next.role||current.clubId!==next.clubId||current.active!==active||current.email!==email))next.authVersion++;
  if(current)Object.assign(current,next);else db.users.push(next);
  return {id:next.id};
 }
 if(type==='tournament.save'){
  if(!canCreateTournament(user))fail('Nie możesz tworzyć turniejów.',403);
  const t=isset(p.id)?tour(db,user,p.id):null;
  if(t&&!manages(user,t))fail('Możesz edytować tylko własne turnieje.',403);
  if(!dateValid(p.date))fail('Podaj poprawną datę turnieju.');
  if(!Object.hasOwn(STATUSES,p.status))fail('Niepoprawny status zapisów.');
  if(t&&t.entries.length&&t.date!==p.date)fail('Data turnieju ze zgłoszeniami jest zablokowana. Utwórz nowy turniej, aby zachować poprawny wiek zawodników.',409);
  const data={name:text(cleanText(p.name),'nazwa turnieju'),city:text(cleanText(p.city),'miasto'),date:p.date,mat:text(cleanText(p.mat||'Mata 1'),'mata',50),status:p.status};
  if(member&&[data.name,data.city,data.mat].some(contact))fail('Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.');
  if(t&&isset(t.hiddenBy)&&data.status!=='draft')fail('Turniej ukrył Administrator. Status może zmienić tylko Administrator.',409);
  if(organizer(user))organizerLimits(db,user,t,data.status,data.date);
  data.selfEntry=has(p,'selfEntry')?p.selfEntry===true:t?t.selfEntry===true:organizer(user);
  if(t){Object.assign(t,data);audit(t,'Zaktualizowano ustawienia turnieju.');return {id:t.id};}
  const next={id:id(),createdBy:user.id,createdAt:now,...data,entries:[],draws:{},activity:[]};audit(next,'Utworzono turniej.');db.tournaments.push(next);return {id:next.id};
 }
 if(type==='profile.save'){
  const old=isset(p.id)?prof(db,user,p.id):null;
  if(!old&&member&&!organizer(user))fail('Brak uprawnień.',403);
  if(old&&(!managesProfile(user,old,db)||isset(old.ownerId)&&!admin))fail('Nie możesz edytować tej kartoteki zawodnika.',403);
  let pick=null,choice={},clubId;
  if(user.role==='club'){clubId=user.clubId;find(db.clubs,clubId,'Klub');}
  else{choice=clubChoice(p);pick=pickClub(db.clubs,user,choice,now,member?clubCounts(db.clubs,user,now):{});clubId=pick.clubId;}
  if(old&&old.clubId!==clubId&&!admin)fail('Klub zawodnika może zmienić Administrator.',403);
  if(member&&!old){const made=within(db.profiles,now,a=>a.createdBy===user.id&&!isset(a.ownerId));if(made.length>=ORGANIZER_PROFILES_DAY)fail('Limit nowych zawodników na dziś został osiągnięty.',429,{retry:Math.max(1,Math.min(...made)+86400-now)});}
  const next={...(old||{id:id(),createdBy:user.id,createdAt:now,archived:false,ownerId:null}),name:text(cleanText(p.name),'imię i nazwisko'),clubId,sex:p.sex,birthDate:p.birthDate||null,weight:Number(p.weight),height:Number(p.height),gradeType:p.gradeType,grade:Number(p.grade),events:Array.isArray(p.events)?[...new Set(p.events)]:['forms'],champion:!!p.champion};
  validateProfile(next);
  // Minors added by an organizer need the guardian's consent (§5.3); staff unchanged.
  if(member&&next.birthDate&&ageAt(next.birthDate,today)<MINOR_SELF_AGE){if(p.guardianConsent!==true)fail('Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.');next.guardianConsentAt=now;next.consentBy=user.id;}
  const pendingName=pick?.pendingClubName??(clubId===UNAFFILIATED&&choice.id===UNAFFILIATED?old?.pendingClubName??null:null);
  if(isset(pendingName))next.pendingClubName=pendingName;else delete next.pendingClubName;
  if(pick?.newClub)db.clubs.push(pick.newClub);
  replace(db.profiles,next);
  if(p.registration)apply(db,user,'entry.save',{...p.registration,profileId:next.id});
  return pick?.notice?{id:next.id,notice:pick.notice}:{id:next.id};
 }
 if(type==='profile.archive'){
  const a=prof(db,user,p.id);if(!managesProfile(user,a,db)||isset(a.ownerId)&&!admin)fail('Brak uprawnień do archiwizacji.',403);a.archived=!!p.archived;return {id:a.id};
 }
 if(type==='profile.forget'){
  const a=prof(db,user,p.id);
  if(!admin){
   if(!managesProfile(user,a,db)||isset(a.ownerId)||a.createdBy!==user.id)fail('Brak uprawnień.',403);
   if(db.tournaments.some(t=>t.status==='finished'&&t.entries.some(e=>e.profileId===a.id)))fail('Zawodnik ma zgłoszenia w zakończonych turniejach. Usunięcie danych może zlecić Administrator.',409);
  }
  return {id:a.id,state:forgetProfile(db,a.id,true,user)};
 }
 // Own athlete profiles of a member (§6.1, §4.5, §6.6).
 if(['athlete.save','athlete.archive','athlete.forget','entry.self'].includes(type)&&!member)fail('Brak uprawnień.',403);
 const owned=key=>typeof key==='string'?db.profiles.find(a=>a.id===key&&a.ownerId===user.id)??null:null;
 if(type==='athlete.save'){
  const f=athleteFields(p,today);let old=null;
  if(isset(p.id)){old=owned(p.id);if(!old)fail('Zawodnik nie istnieje.',404);}
  const mine=db.profiles.filter(a=>a.ownerId===user.id);
  if(!old&&mine.length>=ATHLETES_PER_ACCOUNT)fail('Na jednym koncie może być tylko jeden zawodnik.',409);
  if(f.relation==='self'&&mine.some(a=>a.id!==old?.id&&a.relation==='self'))fail('Na koncie jest już Twój własny profil zawodnika.',409);
  const pick=pickClub(db.clubs,user,f.club,now,clubCounts(db.clubs,user,now));
  if(old&&(pick.clubId!==old.clubId||f.birthDate!==(old.birthDate??null)||f.sex!==(old.sex??null))&&pending(db,old.id))fail('Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.',409);
  const a={...(old||{id:id(),ownerId:user.id,createdBy:user.id,createdAt:now}),archived:false,name:f.name,clubId:pick.clubId,birthDate:f.birthDate,sex:f.sex,weight:f.weight,height:f.height,gradeType:f.gradeType,grade:f.grade,events:['forms'],champion:false,relation:f.relation};
  const pendingName=pick.pendingClubName??(pick.clubId===UNAFFILIATED&&f.club.id===UNAFFILIATED?old?.pendingClubName??null:null);
  if(isset(pendingName))a.pendingClubName=pendingName;else delete a.pendingClubName;
  if(f.relation==='guardian')a.guardianDeclaredAt=old?.relation==='guardian'&&isset(old.guardianDeclaredAt)?old.guardianDeclaredAt:now;else delete a.guardianDeclaredAt;
  if(pick.newClub)db.clubs.push(pick.newClub);
  replace(db.profiles,a);
  return pick.notice?{id:a.id,notice:pick.notice}:{id:a.id};
 }
 if(type==='athlete.archive'){
  const a=owned(p.profileId);if(!a)fail('Zawodnik nie istnieje.',404);const archived=p.archived!==false;
  if(archived&&pending(db,a.id))fail('Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.',409);
  a.archived=archived;return {id:a.id};
 }
 if(type==='athlete.forget'){const a=owned(p.profileId);if(!a)fail('Zawodnik nie istnieje.',404);return {id:a.id,state:forgetProfile(db,a.id,true,user)};}
 if(type==='entry.self')return selfEntry(db,user,p,owned);
 // Clubs (§5.5): the Administrator only.
 if(type.startsWith('club.')){
  if(!admin)fail('Brak uprawnień.',403);
  if(type==='club.adopt'){
   const ids=p.profileIds;if(!Array.isArray(ids)||!ids.length||ids.length>500)fail('Wybierz zawodników.');
   const r=pickClub(db.clubs,user,{name:p.name??null},now);if(r.clubId===UNAFFILIATED)fail('Sprawdź pole: nazwa klubu.');
   for(const key of [...new Set(ids)]){const a=find(db.profiles,key,'Zawodnik');a.clubId=r.clubId;delete a.pendingClubName;}
   if(r.newClub)db.clubs.push(r.newClub);return {id:r.clubId};
  }
  const c=find(db.clubs,p.id??null,'Klub');if(c.id===UNAFFILIATED||isset(c.mergedInto))fail('Tego klubu nie można zmienić.',409);
  if(type==='club.save'){
   const next={...c};
   if(has(p,'name')){const name=txt(cleanText(p.name),'nazwa klubu'),key=clubKey(name);if(chars(key)<2||!/\p{L}/u.test(name))fail('Sprawdź pole: nazwa klubu.');if(db.clubs.some(x=>x.id!==c.id&&clubKey(x.name)===key))fail('Klub o takiej nazwie już istnieje. Użyj scalania.',409);next.name=name;}
   if(has(p,'verified'))next.verified=p.verified===true;
   replace(db.clubs,next);return {id:c.id};
  }
  if(type==='club.merge'){
   const into=find(db.clubs,p.into??null,'Klub');if(into.id===c.id||isset(into.mergedInto))fail('Tego klubu nie można zmienić.',409);
   if(into.id===UNAFFILIATED&&db.users.some(x=>STAFF.includes(x.role)&&x.clubId===c.id))fail('Ten klub ma konta personelu. Przypisz je do innego klubu przed scaleniem z „Niezrzeszony”.',409);
   for(const a of db.profiles)if(a.clubId===c.id)a.clubId=into.id;
   for(const x of db.users)if(STAFF.includes(x.role)&&x.clubId===c.id){x.clubId=into.id;x.authVersion++;}
   for(const x of db.clubs)if(x.id===c.id||x.mergedInto===c.id)x.mergedInto=into.id;
   return {id:into.id};
  }
 }
 if(type==='entry.remove')return removeEntry(db,user,p);
 const t=tour(db,user,p.tournamentId);
 if(type==='tournament.hide'){
  if(!admin)fail('Brak uprawnień.',403);const hidden=isset(t.hiddenBy);
  if(p.hidden===true){
   const reason=cleanText(p.reason??'');if(reason===null||chars(reason)>200)fail('Sprawdź pole: powód.');
   if(p.withdrawSelf===true)for(const e of [...t.entries])if(e.self&&detach(t,e.id))withdrawn(db,e,t.id,'admin');
   if(!hidden){t.hiddenFrom=t.status;t.status='draft';t.hiddenBy=user.id;audit(t,'Administrator ukrył turniej.');}
   t.hideReason=reason===''?null:reason;return {id:t.id};
  }
  if(hidden){t.status=Object.hasOwn(STATUSES,t.hiddenFrom??'')?t.hiddenFrom:'draft';t.hiddenBy=null;t.hiddenFrom=null;t.hideReason=null;audit(t,'Administrator przywrócił turniej.');}
  return {id:t.id};
 }
 if(type==='entry.save'){
  if(!canEnter(user,t,db))fail('Zapisy do tego turnieju są zamknięte.',403);
  const manager=manages(user,t),existing=t.entries.find(e=>e.profileId===p.profileId)??null;
  const a=prof(db,user,p.profileId,!!existing&&manager);if(a.archived)fail('Zawodnik jest zarchiwizowany.');
  if(user.role==='club'&&(a.clubId!==user.clubId||!staffProfile(db,a)))fail('Możesz zgłaszać tylko zawodników swojego klubu.',403);
  if(!existing&&user.role==='editor'&&!(community(db,t)?!isset(a.ownerId)&&a.createdBy===user.id:staffProfile(db,a)))fail('Nie możesz zgłosić tego zawodnika.',403);
  if(existing&&!p.update)fail('Ten zawodnik jest już zgłoszony do turnieju.',409);
  if(existing&&!manager&&user.role!=='club'&&a.createdBy!==user.id)fail('Nie możesz zmienić tego zgłoszenia.',403);
  if(existing&&Object.values(t.draws).some(d=>d.slots.includes(existing.id)&&Object.keys(d.results).length))fail('Zawodnik ma zapisane wyniki. Nie można teraz zmieniać zgłoszenia.',409);
  let entry,clubChanged=false;
  if(existing?.self){
   // A self-entry corrected by the manager keeps its identity; only the club may change (verification at check-in, D3).
   entry={id:existing.id,profileId:existing.profileId,clubId:existing.clubId,name:existing.name,club:existing.club,sex:existing.sex,age:existing.age,weight:Number(p.weight),height:Number(p.height),gradeType:p.gradeType,grade:Number(p.grade),champion:false,events:[...new Set(p.events||[])],presence:existing.presence||'pending',actualWeight:existing.actualWeight??null,self:true};
   if(isset(p.clubId)&&p.clubId!==existing.clubId){const c=db.clubs.find(x=>x.id===p.clubId&&!isset(x.mergedInto));if(!c)fail('Klub nie istnieje.',404);entry.clubId=c.id;entry.club=c.name;clubChanged=true;}
  }else entry=snapshot(db,a,t,p,existing);
  validateAthlete(entry);const list=existing?t.entries.map(x=>x.id===entry.id?entry:x):[...t.entries,entry];
  if(!manager&&guarded(db,user,t))keepDraws(t,existing,list,entry.id);
  reconcile(t,list);
  audit(t,clubChanged?'Zmieniono klub w zgłoszeniu: '+entry.name:(existing?'Zmieniono zgłoszenie: ':'Zgłoszono: ')+entry.name,entry.profileId);
  if(!existing)unWithdraw(db,entry.profileId,t.id);return {id:entry.id};
 }
 requireManager(user,t);
 if(type==='checkin.save'){
  const a=find(t.entries,p.id,'Zgłoszenie');if(!['present','pending','absent'].includes(p.presence))fail('Nieprawidłowy status obecności.');
  const w=p.presence==='absent'||p.presence==='pending'?a.actualWeight:Number(p.actualWeight);
  if(p.presence==='present'&&(!Number.isFinite(w)||w<10||w>250))fail('Podaj wagę od 10 do 250 kg.');
  if(Object.values(t.draws).some(d=>d.slots.includes(a.id)&&Object.keys(d.results).length)&&(a.actualWeight!==w||a.presence!==p.presence))fail('Zawodnik ma zapisane wyniki. Najpierw wycofaj wyniki.',409);
  reconcile(t,t.entries.map(x=>x.id===a.id?{...a,actualWeight:w,presence:p.presence}:x));audit(t,'Kontrola startowa: '+a.name,a.profileId);return {id:a.id};
 }
 if(type==='draw.create'){
  const c=categories(t.entries).items.find(c=>c.id===p.categoryId);if(!c||c.type!=='bracket')fail('Nie ma takiej kategorii drabinkowej.');
  const old=t.draws[c.id];if(old&&Object.keys(old.results).length)fail('Nie można losować po zapisaniu wyników.',409);
  const draw=makeDraw(drawAthletes(db.clubs,c.athletes),Math.floor(Math.random()*2147483647));draw.revision=(old?.revision||0)+1;t.draws[c.id]=draw;audit(t,'Zapisano losowanie: '+c.title+' · '+c.subtitle);return {id:c.id};
 }
 if(type==='result.save'||type==='result.clear'){
  const d=t.draws[p.categoryId];if(!d)fail('Najpierw zapisz losowanie.');
  if(type==='result.save')saveWinner(d,p.matchId,p.winnerId);else clearWinner(d,p.matchId);
  audit(t,type==='result.save'?'Zapisano wynik walki.':'Wycofano wynik walki.');return {id:p.matchId};
 }
 fail('Nieznana operacja.',400);
}
/** entry.remove (§5.7): the owner's branch first, then the rules of staff and organizers; a self-entry removed by someone else leaves a tombstone. */
function removeEntry(db,user,p){
 const t=tour(db,user,p.tournamentId,false),e=t.entries.find(x=>x.id===p.id)??null,profile=e?db.profiles.find(a=>a.id===e.profileId)??null:null;
 if(e&&profile&&isset(profile.ownerId)&&profile.ownerId===user.id){
  if(t.status!=='open')fail('Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.',403);
  if(inDraw(t,e.id))fail('Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.',409);
  reconcile(t,t.entries.filter(x=>x.id!==e.id));audit(t,'Wycofano zgłoszenie: '+e.name,e.profileId);return {id:e.id};
 }
 if(user.role==='member'&&!sees(db,user,t))fail('Turniej nie jest dostępny.',404);
 if(!canEnter(user,t,db))fail('Zapisy są zamknięte.',403);
 const a=find(t.entries,p.id,'Zgłoszenie'),owner=find(db.profiles,a.profileId,'Zawodnik');
 const manager=manages(user,t);
 if(!manager&&!(user.role==='club'?(resolveClub(db.clubs,a.clubId)?.id??a.clubId)===user.clubId&&staffProfile(db,owner):!isset(owner.ownerId)&&owner.createdBy===user.id)){if(user.role==='member')fail('Zgłoszenie nie istnieje.',404);fail('Nie możesz wycofać tego zgłoszenia.',403);}
 if(!manager&&guarded(db,user,t))keepDraws(t,a,null,'');
 reconcile(t,t.entries.filter(x=>x.id!==a.id));audit(t,'Wycofano zgłoszenie: '+a.name,a.profileId);
 if(a.self)withdrawn(db,a,t.id,user.role==='admin'?'admin':'organizer');return {id:a.id};
}
/** entry.self (§7.1–§7.2): an athlete enters an own profile; never into a category with a saved draw; minors only in trusted tournaments. */
function selfEntry(db,user,p,owned){
 if(typeof p.profileId!=='string'||p.profileId==='')fail('Najpierw uzupełnij dane zawodnika.',409);
 let a=owned(p.profileId);if(!a)fail('Zawodnik nie istnieje.',404);if(a.archived)fail('Najpierw uzupełnij dane zawodnika.',409);
 const t=db.tournaments.find(x=>x.id===p.tournamentId&&x.status!=='draft');if(!t)fail('Turniej nie jest dostępny.',404);
 if(t.status!=='open'||t.selfEntry!==true||t.date<warsawToday())fail('Zapisy do tego turnieju są zamknięte.',403);
 const old=t.entries.find(e=>e.profileId===a.id)??null,update=p.update===true;
 if(old&&!update)fail('Jesteś już zgłoszony do tego turnieju.',409);if(!old&&update)fail('Zgłoszenie nie istnieje.',404);
 keepDraws(t,old,null,'');
 if(!trusted(db,t)&&(a.relation!=='self'||ageAt(String(a.birthDate),t.date)<ADULT_AGE))fail('Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.',409);
 const measures={weight:p.weight??a.weight,height:p.height??a.height,gradeType:p.gradeType??a.gradeType,grade:p.grade??a.grade};
 if(p.saveToProfile===true){
  const f={weight:number(measures.weight,10,250),height:number(measures.height,70,250),gradeType:measures.gradeType,grade:number(measures.grade,1,10,true)};
  rulesValidate({...f,name:a.name,sex:a.sex,age:25,club:'Klub',events:['forms']});Object.assign(a,f);
 }
 const entry=snapshot(db,a,t,{...measures,events:p.events??null},old,true);rulesValidate(entry);
 const list=old?t.entries.map(e=>e.id===entry.id?entry:e):[...t.entries,entry];
 keepDraws(t,null,list,entry.id);
 reconcile(t,list);audit(t,(old?'Zmieniono zgłoszenie własne: ':'Zgłoszenie własne: ')+entry.name,entry.profileId);
 unWithdraw(db,a.id,t.id);return {id:entry.id,tournamentId:t.id};
}
export function execute(db,actorId,type,p={},expectedRevision=db.revision){
 const user=find(db.users,actorId,'Konto');if(!user.active)fail('Konto jest zablokowane.',403);
 if(stale(db,type,p,expectedRevision,user.id))fail('Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409);
 const next=structuredClone(db);next.withdrawals??=[];const actor=find(next.users,actorId,'Konto');const result=apply(next,actor,type,p);stamp(db,next);
 return {db:next,result};
}
