/* What a member sees on "Moje starty" (PLAN-REJESTRACJA-ROLE §7.4): mirror of backend/src/AthleteView.php for the browser demo;
 * tests/athlete-view.test.mjs checks that both give the same answer. Data only, no DOM.
 *  projectAthleteView(profiles, tournaments, withdrawals, today, organizers) = AthleteView::project (pure; inputs and answer
 *   are documented there: profiles, entries, withdrawn, open, every key listed).
 *  athleteView(db, user, today, {withdrawals, organizers}) = AthleteView::fromWorkspace: the inputs from a workspace (the demo
 *   keeps tombstones in db.withdrawals and has no organizer names unless given as {userId: {n}}).
 *  publicClubs(clubs) = the public-clubs route: verified clubs that are not merged, by name, at most 2000, plus the id of
 *   'unaffiliated'. */
import {resolveDraw} from './engine.js';
import {categoryList} from './guest-view.js';
import {ADULT_AGE,UNAFFILIATED,ageAt,community,trusted,currentClub,resolveClub} from './workspace.js';

export const RECENT_DAYS=30,ENTRY_LIMIT=100,OPEN_LIMIT=50,WITHDRAWN_LIMIT=100,CLUBS_LIMIT=2000;
export const BY=['organizer','admin','system'];
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const cmp=(a,b)=>a<b?-1:a>b?1:0;
/** The first date whose tournaments still show categories and brackets: today minus RECENT_DAYS (calendar days). */
export function recentFrom(today){return new Date(Date.parse(today+'T00:00:00Z')-RECENT_DAYS*86400000).toISOString().slice(0,10);}
function profileClub(a){
 const c=isObj(a.clubRow)?a.clubRow:null,id=c?.id??a.clubId??null,none=id===UNAFFILIATED;
 return {id,name:none?'':String(c?.name??''),verified:none||!!c&&!!c.verified,unaffiliated:none,pending:typeof a.pendingClubName==='string'?a.pendingClubName:null};
}
function entryClub(e){
 const c=isObj(e.currentClub)?e.currentClub:null,id=c?.id??e.clubId??null,none=id===UNAFFILIATED,verified=none||!!c&&c.name!=null;
 return {id,name:none?'':verified?String(c.name):String(e.club??''),verified,unaffiliated:none};
}
const minorOn=(a,date)=>a.relation!=='self'||typeof a.birthDate!=='string'||ageAt(a.birthDate,date)<ADULT_AGE;
const inDraw=(draws,id)=>Object.values(draws).some(d=>isObj(d)&&Array.isArray(d.slots)&&d.slots.includes(id));
/** Where entry id stands in saved draw d (slots of the public bracket of the same draw), as AthleteView::position. */
export function position(d,id,bracket){
 const slots=[...(d.slots||[])],slot=slots.indexOf(id);if(slot<0)return null;
 let last=null,prev=null;for(const round of resolveDraw({slots,results:isObj(d.results)?d.results:{}}))for(const m of round)if(m.a===id||m.b===id){prev=last;last=m;}
 if(!last)return null;
 const other=last.a===id?last.b:last.a;
 const status=last.settled?(last.winner===id?'champion':'lost'):last.ready?'next':prev&&prev.auto?'bye':prev&&prev.winner===id?'won':'waiting';
 let opponent=null;if((status==='next'||status==='lost')&&typeof other==='string'){const i=slots.indexOf(other);if(i>=0)opponent=bracket.slots[i]??null;}
 return {slot,round:last.round+1,match:last.number,status,opponent};
}
const byDate=newest=>(a,b)=>(newest?cmp(String(b.date),String(a.date)):cmp(String(a.date),String(b.date)))||cmp(String(a.id),String(b.id));
export function projectAthleteView(profiles,tournaments,withdrawals,today,organizers){
 profiles=[...profiles].sort((a,b)=>cmp(String(a.id),String(b.id)));const own=new Map(profiles.map(a=>[String(a.id),a]));
 const pending=new Set(),entered=new Set();
 for(const t of tournaments)for(const e of t.entries||[]){const pid=String(e.profileId??'');entered.add(t.id+'/'+pid);if(own.has(pid)&&['open','closed'].includes(t.status))pending.add(pid);}
 const out={profiles:[],entries:[],withdrawn:[],open:[]};
 for(const a of profiles)out.profiles.push({id:a.id,name:a.name,birthDate:a.birthDate??null,sex:a.sex??null,weight:a.weight??null,height:a.height??null,gradeType:a.gradeType??null,grade:a.grade??null,
  club:profileClub(a),relation:a.relation??null,archived:!!a.archived,minor:typeof a.birthDate!=='string'||ageAt(a.birthDate,today)<ADULT_AGE,locked:pending.has(a.id)});
 const recent=recentFrom(today);
 entries:for(const t of [...tournaments].sort(byDate(true))){
  const mine=(t.entries||[]).filter(e=>own.has(String(e.profileId??''))).sort((a,b)=>cmp(String(a.profileId),String(b.profileId)));if(!mine.length)continue;
  const draws=isObj(t.draws)?t.draws:{},available=t.status!=='draft'&&(t.hiddenBy??null)===null;
  const cats=available&&t.date>=recent?categoryList(t.entries,draws):[];
  for(const e of mine){
   if(out.entries.length>=ENTRY_LIMIT)break entries;
   const a=own.get(String(e.profileId)),withdraw=available&&t.status==='open'&&!inDraw(draws,String(e.id));
   const categories=[];
   for(const c of cats){
    if(!c.athletes.some(x=>x.id===e.id))continue;const p=c.public,d=Object.hasOwn(draws,c.id)?draws[c.id]:null;
    categories.push({event:p.event,code:p.code,title:p.title,subtitle:p.subtitle,type:p.type,state:p.state,athletes:p.athletes,drawn:isObj(d),position:p.bracket!==null&&isObj(d)?position(d,String(e.id),p.bracket):null,bracket:p.bracket});
   }
   out.entries.push({profileId:e.profileId,
    tournament:available?{id:t.id,name:t.name,city:t.city,date:t.date,status:t.status,available:true,community:!!t.community,trusted:!!t.trusted}:{id:t.id,name:t.name,date:t.date,available:false},
    entry:{events:[...(e.events||[])],weight:e.weight??null,height:e.height??null,gradeType:e.gradeType??null,grade:e.grade??null,age:e.age??null,club:entryClub(e),presence:e.presence??'pending',actualWeight:e.actualWeight??null},
    canWithdraw:withdraw,canEdit:withdraw&&t.selfEntry===true&&t.date>=today&&(!!t.trusted||!minorOn(a,t.date)),categories});
  }
 }
 const gone=withdrawals.filter(w=>own.has(String(w.profileId??''))&&BY.includes(w.by)&&!entered.has((w.tournament?.id??'')+'/'+w.profileId))
  .sort((a,b)=>(Math.trunc(b.at)-Math.trunc(a.at))||cmp(String(a.tournament.id),String(b.tournament.id))||cmp(String(a.profileId),String(b.profileId)));
 for(const w of gone.slice(0,WITHDRAWN_LIMIT))out.withdrawn.push({profileId:w.profileId,tournament:{id:w.tournament.id,name:w.tournament.name,date:w.tournament.date},by:w.by,at:Math.trunc(w.at)});
 const open=tournaments.filter(t=>t.status==='open'&&t.selfEntry===true&&(t.hiddenBy??null)===null&&typeof t.date==='string'&&t.date>=today).sort(byDate(false));
 for(const t of open.slice(0,OPEN_LIMIT)){
  const inside=new Set((t.entries||[]).map(e=>String(e.profileId??''))),keys=Object.keys(isObj(t.draws)?t.draws:{}).sort();
  const n=t.community?organizers?.[t.createdBy??'']?.n:null;
  out.open.push({id:t.id,name:t.name,city:t.city,date:t.date,community:!!t.community,trusted:!!t.trusted,organizer:typeof n==='string'&&n!==''?{n}:null,
   profiles:profiles.filter(a=>!a.archived).map(a=>({id:a.id,entered:inside.has(a.id),blocked:!t.trusted&&minorOn(a,t.date)?'minor-untrusted':null})),drawn:keys});
 }
 return out;
}
/** The inputs of projectAthleteView() from a workspace (db.flags for trust, §17), as AthleteView::fromWorkspace. */
export function athleteView(db,user,today,{withdrawals=null,organizers={}}={}){
 const clubs=db.clubs||[],byId=new Map(db.tournaments.map(t=>[t.id,t]));
 const profiles=db.profiles.filter(a=>a.ownerId!=null&&a.ownerId===user.id).map(a=>{const c=resolveClub(clubs,a.clubId??null);return {...a,clubRow:c?{id:c.id,name:c.name,verified:c.verified!==false}:null};});
 const tournaments=db.tournaments.map(t=>({id:t.id,name:t.name,city:t.city,date:t.date,status:t.status,selfEntry:t.selfEntry===true,hiddenBy:t.hiddenBy??null,createdBy:t.createdBy??null,community:community(db,t),trusted:trusted(db,t),
  entries:t.entries.map(e=>({...e,currentClub:currentClub(clubs,e.clubId??null)})),draws:t.draws}));
 const gone=[];for(const w of withdrawals??db.withdrawals??[]){const t=byId.get(w.tournamentId);if(t)gone.push({profileId:w.profileId,tournament:{id:t.id,name:t.name,date:t.date},by:w.by,at:Math.trunc(w.at)});}
 return projectAthleteView(profiles,tournaments,gone,today,organizers);
}
/** The answer of the public-clubs route for the demo: verified, not merged, not 'unaffiliated', by name (Polish order). */
export function publicClubs(clubs){
 const list=(clubs||[]).filter(c=>c.verified!==false&&(c.mergedInto??null)===null&&c.id!==UNAFFILIATED).sort((a,b)=>a.name.localeCompare(b.name,'pl')||cmp(a.id,b.id));
 return {clubs:list.slice(0,CLUBS_LIMIT).map(c=>({id:c.id,name:c.name})),unaffiliated:UNAFFILIATED};
}
