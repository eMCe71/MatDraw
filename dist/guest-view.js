/* Public (guest) read-only projection: mirror of backend/src/GuestView.php, used by the browser demo adapter.
 * Every field a guest can see is listed here; tests/php.test.mjs checks that both implementations agree.
 *  - guestUpcoming():   id, name, date, city, status, sport (and the sparse federation) of tournaments that are not drafts and
 *                       are dated today or later (Europe/Warsaw), nearest first: at most UPCOMING_LIMIT of every sport, or with
 *                       sport at most SPORT_LIMIT of that sport (of one federation with fed); counts sports {id: n} and, with
 *                       sport, federations {id: n} (GuestView::upcoming).
 *  - guestTournament(): the same tournament fields, aggregate counts, categories (code, event, labels, size,
 *                       state) and saved brackets in which every athlete is reduced to initials ("J. K.") and club.
 * Never: full names, birth dates, ages, weights, heights, grades of athletes, check-in, champion flags, e-mails,
 * accounts, entry/profile/club/user ids, creators, mats, activity, revisions, draft or past tournaments.
 * Community tournaments (PLAN-REJESTRACJA-ROLE §5.6; guestTournaments() in workspace.js adds community, trusted and the current
 * club of every entry, like Repository::guestTournaments): sparse summary fields community:true and trusted; guestUpcoming()
 * lists staff and trusted community tournaments only; bracket slots show the current verified club, null for an unverified
 * one, '' for 'unaffiliated'; summary.clubs skips 'unaffiliated'. categoryList() and bracket() serve the athlete view.
 * Self-entries (§7.1, §10.1): guestTournament() adds the sparse field selfEntry:true while the tournament takes them (open,
 * self-entries on); guestUpcoming() never carries it.
 * Materials (PLAN-MATERIALY §2.1, §4): both add the sparse fields poster {v,w,h,color} and rules {v,size,type} (publicMaterials) from
 * the stored meta, checked exactly as Materials::meta does (materialMeta of dist/workspace.js; invalid meta gives nothing): poster
 * {f,w,h,c,at}, rules {f,b,at} (PDF) or {t,at} (typed text, a fixed point of rulesText); the demo keeps src instead of f and passes it
 * on. v is the first 12 characters of f (its hash), of the text's SHA-256, or a hash of a demo src (as the demo workspace); size is
 * the PDF's bytes or the text's characters. Neither f nor the text ever leaves: the demo reads typed rules from its own data. */
import {categories,resolveDraw} from './engine.js';
import {inviteCheck,inviteJson} from './invite-data.js';
import {tournamentSport,tournamentFederation} from './sports.js';

export const UPCOMING_LIMIT=6,SPORT_LIMIT=12;
const STATUSES=['open','closed','finished'];
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Mirror of Materials::meta and Materials::text (the backend's materialMeta and rulesText in dist/workspace.js).
const MATERIAL_SIDE=4096,MATERIAL_AT=9999999999,POSTER_MAX=4194304,RULES_MAX=10485760,RULES_TEXT_MAX=20000;
const MATERIAL_FILE={poster:/^[0-9a-f]{32}\.(?:webp|jpg)$/,rules:/^[0-9a-f]{32}\.pdf$/};
const DEMO_SRC={poster:/^(?:\.\/demo\/[a-z0-9-]{1,60}\.(?:webp|jpg|jpeg)|data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2})$/,rules:/^(?:\.\/demo\/[a-z0-9-]{1,60}\.pdf|data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2})$/};
const DEMO_SRC_LENGTH={poster:Math.ceil(POSTER_MAX/3)*4+32,rules:Math.ceil(RULES_MAX/3)*4+40};
const has=(o,k)=>isObj(o)&&Object.hasOwn(o,k);
const intIn=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const keysAre=(o,keys)=>Object.keys(o).sort().join()===[...keys].sort().join();
const ILL_FORMED=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const trimText=s=>s.replace(/^[\s\p{Z}]+|[\s\p{Z}]+$/gu,'');
/** A typed rules text as the server stores it (Text::clean's steps for multiline text): CRLF/CR to LF, tab to space, controls but LF
 * and format characters but U+200D removed, NFC, white-space-only lines empty, at most 2 empty lines in a row, trimmed; null for a
 * value that is not a string or is ill-formed. */
export function rulesText(raw){
 if(typeof raw!=='string'||ILL_FORMED.test(raw))return null;
 const s=raw.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\t/g,' ').replace(/(?!\n)\p{Cc}/gu,'').replace(/(?!\u200D)\p{Cf}/gu,'').normalize('NFC');
 const lines=[];let empty=0;
 for(const line of s.split('\n')){if(trimText(line)===''){if(++empty>2)continue;lines.push('');}else{empty=0;lines.push(line);}}
 return trimText(lines.join('\n'));
}
/** The stored meta of kind when v is exactly valid, else null (Materials::meta). */
function materialMeta(kind,v){
 if(!isObj(v)||!['poster','rules','invite'].includes(kind))return null;
 if(kind==='invite')return inviteCheck(v,false);
 if(kind==='rules'&&has(v,'t')){const t=v.t,n=typeof t==='string'?[...t].length:0;return keysAre(v,['t','at'])&&typeof t==='string'&&rulesText(t)===t&&n>=1&&n<=RULES_TEXT_MAX&&intIn(v.at,0,MATERIAL_AT)?{t,at:v.at}:null;}
 const demo=!has(v,'f')&&has(v,'src'),key=demo?'src':'f',file=v[key];
 if(typeof file!=='string'||(demo?file.length>DEMO_SRC_LENGTH[kind]||!DEMO_SRC[kind].test(file):!MATERIAL_FILE[kind].test(file)))return null;
 if(kind==='poster')return keysAre(v,[key,'w','h','c','at'])&&intIn(v.w,1,MATERIAL_SIDE)&&intIn(v.h,1,MATERIAL_SIDE)&&typeof v.c==='string'&&/^#[0-9a-f]{6}$/.test(v.c)&&intIn(v.at,0,MATERIAL_AT)?{[key]:file,w:v.w,h:v.h,c:v.c,at:v.at}:null;
 return keysAre(v,[key,'b','at'])&&intIn(v.b,1,RULES_MAX)&&intIn(v.at,0,MATERIAL_AT)?{[key]:file,b:v.b,at:v.at}:null;
}
/** v of a demo file: 12 hex characters of a hash of its address (length, beginning and end: a data URL may be megabytes). */
export function demoVersion(src){
 const s=src.length+':'+src.slice(0,4096)+src.slice(-4096);let a=0x811c9dc5,b=0x9e3779b9;
 for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^c,0x5bd1e995)>>>0;}
 return (a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0')).slice(0,12);
}
// SHA-256 (FIPS 180-4) of a string's UTF-8 bytes, synchronous: the version of typed rules, as the server computes it.
const PRIMES=(n,root)=>{const out=[];for(let x=2;out.length<n;x++){let prime=true;for(let d=2;d*d<=x;d++)if(x%d===0){prime=false;break;}if(prime)out.push(Math.floor((root(x)%1)*2**32)>>>0);}return out;};
const SHA_K=PRIMES(64,Math.cbrt),SHA_H=PRIMES(8,Math.sqrt);
const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
export function sha256Hex(text){
 const bytes=new TextEncoder().encode(String(text)),size=((bytes.length+9+63)>>6)<<6,buf=new Uint8Array(size);buf.set(bytes);buf[bytes.length]=0x80;
 const view=new DataView(buf.buffer),bits=bytes.length*8;view.setUint32(size-8,Math.floor(bits/2**32));view.setUint32(size-4,bits>>>0);
 const H=[...SHA_H],W=new Uint32Array(64);
 for(let o=0;o<size;o+=64){
  for(let i=0;i<16;i++)W[i]=view.getUint32(o+i*4);
  for(let i=16;i<64;i++){const a=W[i-15],b=W[i-2];W[i]=(W[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+W[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))>>>0;}
  let [a,b,c,d,e,f,g,hh]=H;
  for(let i=0;i<64;i++){
   const t1=(hh+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+SHA_K[i]+W[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
   hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
  }
  [a,b,c,d,e,f,g,hh].forEach((x,i)=>{H[i]=(H[i]+x)>>>0;});
 }
 return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
/** The public fields of a tournament's materials (sparse: {} without any): poster {v,w,h,color[,src]}, rules {v,size,type[,src]}. */
export function publicMaterials(m){
 const out={};if(!isObj(m))return out;
 const p=materialMeta('poster',m.poster),r=materialMeta('rules',m.rules),i=materialMeta('invite',m.invite);
 if(p)out.poster={v:p.f?p.f.slice(0,12):demoVersion(p.src),w:p.w,h:p.h,color:p.c,...(p.src?{src:p.src}:{})};
 if(r)out.rules=has(r,'t')?{v:sha256Hex(r.t).slice(0,12),size:[...r.t].length,type:'text'}:{v:r.f?r.f.slice(0,12):demoVersion(r.src),size:r.b,type:'pdf',...(r.src?{src:r.src}:{})};
 if(i)out.invite={v:sha256Hex(inviteJson(i)).slice(0,12),style:i.s};
 return out;
}
/** Today's date (YYYY-MM-DD) in Europe/Warsaw, the time zone of the tournaments and of the PHP server. */
export function warsawToday(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day;
}
export const isPublic=(t,today)=>!!t&&STATUSES.includes(t.status)&&typeof t.date==='string'&&t.date>=today;
const compare=(a,b)=>a<b?-1:a>b?1:0;
const summary=(t,detail=false)=>({id:String(t.id),name:String(t.name),date:String(t.date),city:String(t.city),status:String(t.status),sport:tournamentSport(t),...(tournamentFederation(t)?{federation:tournamentFederation(t)}:{}),...(t.community?{community:true,trusted:!!t.trusted}:{}),...(detail&&String(t.status)==='open'&&t.selfEntry===true?{selfEntry:true}:{}),...publicMaterials(t.materials)});
const listed=t=>!t.community||!!t.trusted;

export function guestUpcoming(tournaments,today,limit=UPCOMING_LIMIT,sport=null,fed=null){
 const list=(tournaments||[]).filter(t=>isPublic(t,today)&&listed(t)).sort((a,b)=>compare(a.date,b.date)||compare(String(a.name),String(b.name))||compare(String(a.id),String(b.id)));
 const sports={},feds={};
 for(const t of list){const s=tournamentSport(t),f=tournamentFederation(t);sports[s]=(sports[s]||0)+1;if(s===sport&&f)feds[f]=(feds[f]||0)+1;}
 const shown=sport===null?list:list.filter(t=>tournamentSport(t)===sport&&(fed===null||tournamentFederation(t)===fed));
 return {tournaments:shown.slice(0,limit).map(t=>summary(t)),sports,...(sport===null?{}:{federations:feds})};
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
