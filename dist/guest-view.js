/* Public (guest) read-only projection: mirror of backend/src/GuestView.php, used by the browser demo adapter.
 * Every field a guest can see is listed here; tests/php.test.mjs checks that both implementations agree.
 *  - guestUpcoming():   id, name, date, city, status of tournaments that are not drafts and are dated today or later
 *                       (Europe/Warsaw), nearest first, at most UPCOMING_LIMIT.
 *  - guestTournament(): the same five tournament fields, aggregate counts, categories (code, event, labels, size,
 *                       state) and saved brackets in which every athlete is reduced to initials ("J. K.") and club.
 * Never: full names, birth dates, ages, weights, heights, grades of athletes, check-in, champion flags, e-mails,
 * accounts, entry/profile/club/user ids, creators, mats, activity, revisions, draft or past tournaments.
 * Community tournaments (PLAN-REJESTRACJA-ROLE §5.6; guestTournaments() in workspace.js adds community, trusted and the current
 * club of every entry, like Repository::guestTournaments): sparse summary fields community:true and trusted; guestUpcoming()
 * lists staff and trusted community tournaments only; bracket slots show the current verified club, null for an unverified
 * one, '' for 'unaffiliated'; summary.clubs skips 'unaffiliated'. categoryList() and bracket() serve the athlete view.
 * Self-entries (§7.1, §10.1): guestTournament() adds the sparse field selfEntry:true while the tournament takes them (open,
 * self-entries on); guestUpcoming() never carries it. */
import {categories,resolveDraw} from './engine.js';

export const UPCOMING_LIMIT=6;
const STATUSES=['open','closed','finished'];
/** Today's date (YYYY-MM-DD) in Europe/Warsaw, the time zone of the tournaments and of the PHP server. */
export function warsawToday(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day;
}
export const isPublic=(t,today)=>!!t&&STATUSES.includes(t.status)&&typeof t.date==='string'&&t.date>=today;
const compare=(a,b)=>a<b?-1:a>b?1:0;
const summary=(t,detail=false)=>({id:String(t.id),name:String(t.name),date:String(t.date),city:String(t.city),status:String(t.status),...(t.community?{community:true,trusted:!!t.trusted}:{}),...(detail&&String(t.status)==='open'&&t.selfEntry===true?{selfEntry:true}:{})});
const listed=t=>!t.community||!!t.trusted;

export function guestUpcoming(tournaments,today,limit=UPCOMING_LIMIT){
 const list=(tournaments||[]).filter(t=>isPublic(t,today)&&listed(t)).sort((a,b)=>compare(a.date,b.date)||compare(String(a.name),String(b.name))||compare(String(a.id),String(b.id)));
 return {tournaments:list.slice(0,limit).map(t=>summary(t))};
}

/** "Jan Kowalski" → "J. K."; first given name + last surname; a hyphenated surname keeps both parts ("K.-N."). */
export function initials(name){
 const words=String(name??'').normalize('NFC').trim().split(/\s+/u).filter(Boolean);
 const letter=w=>{const m=w.match(/\p{L}/u);return m?m[0].toUpperCase()+'.':'';};
 if(!words.length)return '?';
 const last=words.length>1?words.at(-1).split(/[-‐‑–]/u).map(letter).filter(Boolean).join('-'):'';
 return [letter(words[0]),last].filter(Boolean).join(' ')||'?';
}

/** Club of a public bracket slot: the current club (guestTournaments), else the snapshot ('' for 'unaffiliated'). */
const slotClub=a=>a.currentClub&&typeof a.currentClub==='object'?(a.currentClub.name==null?null:String(a.currentClub.name)):a.clubId==='unaffiliated'?'':String(a.club??'');
/** A saved draw as a public bracket: slots hold only initials and club; winners are slot positions. */
export function bracket(d,athletes){
 if(!d||!Array.isArray(d.slots)||![8,16,32,64].includes(d.size)||d.slots.length!==d.size)return null;
 const byId=new Map(athletes.map(a=>[String(a.id),a])),position=new Map(),slots=[];
 for(const [i,raw] of d.slots.entries()){
  if(raw===null){slots.push(null);continue;}
  const id=String(raw),a=byId.get(id);if(!a||position.has(id))return null;
  position.set(id,i);slots.push({initials:initials(a.name),club:slotClub(a)});
 }
 if(position.size!==byId.size)return null;
 const stored=d.results&&typeof d.results==='object'&&!Array.isArray(d.results)?d.results:{},results={};
 for(const [match,winner] of Object.entries(stored))if(typeof winner==='string'&&position.has(winner)&&/^\d+-\d+$/.test(match))results[match]=position.get(winner);
 const final=resolveDraw({slots:d.slots,results:stored}).at(-1)[0].winner;
 return {state:final?'finished':Object.keys(results).length?'progress':'drawn',bracket:{size:d.size,slots,results}};
}

/** Categories in public order with their codes (mirror of GuestView::categoryList): [{id, athletes, public}]. */
export function categoryList(entries,draws){
 return categories(entries).items.map(c=>{
  const size=c.athletes.length,b=c.type==='bracket'&&size>=3?bracket(Object.hasOwn(draws,c.id)?draws[c.id]:null,c.athletes):null;
  return {id:c.id,athletes:c.athletes,public:{code:c.code,event:c.event,type:c.type,title:c.title,subtitle:c.subtitle,gradeType:c.gradeType,athletes:size,state:c.type==='list'?'list':size<3?'underfilled':b?b.state:'pending',bracket:b?b.bracket:null}};
 });
}
export function guestTournament(tournaments,id,today){
 const t=(tournaments||[]).find(x=>x?.id===id&&isPublic(x,today));if(!t)return null;
 const entries=Array.isArray(t.entries)?t.entries:[],draws=t.draws&&typeof t.draws==='object'?t.draws:{};
 const items=categoryList(entries,draws).map(c=>c.public),brackets=items.filter(c=>c.bracket!==null).length;
 const clubs=new Set(entries.map(e=>String(e.currentClub?.id??e.clubId??e.club??'')).filter(k=>k!=='unaffiliated'));
 return {tournament:summary(t,true),summary:{entries:entries.length,clubs:clubs.size,categories:items.length,brackets},categories:items};
}
