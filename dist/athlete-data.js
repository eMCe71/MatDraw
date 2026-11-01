/* Data of the athlete's pages (PLAN-REJESTRACJA-ROLE §7.3–§7.6, §10.3): pure functions over the AthleteView answer (route athlete,
 * dist/athlete-view.js in the demo) and the rules engine. No DOM and no texts: the interface (athlete-flow.js) turns the codes into
 * T() texts; engine messages (eligibility, classify) stay Polish and are shown through translateMessage. tests/athlete-ui.test.mjs.
 *  eventOptions(profile, measures, tournament) = the events of the entry window: allowed, ineligible on the tournament day (with the
 *   engine's reason) or in a category whose draw is saved (tournament.drawn of the open list), with the category preview.
 *  entryStatus(item) = the card status of an own entry (§7.6); positionStatus(category) = the line of a saved draw.
 *  upcomingCount(view, today) = own starts in the next 7 days (menu badge); ctaFor(view, tournamentId, caps) = the preview CTA;
 *  unavailableReason(tournament, today, {truncated}) = why the preview offers no self-entry. */
import {EVENTS,classify,eligibility} from './engine.js';
import {ageAt,dateValid} from './workspace.js';
import {OPEN_LIMIT} from './athlete-view.js';

export const EVENT_KEYS=Object.keys(EVENTS);
export const REFRESH_MS=60000,BADGE_DAYS=7,STALE_MS=300000;
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const cmp=(a,b)=>a<b?-1:a>b?1:0;
/** date + n calendar days (YYYY-MM-DD, UTC arithmetic like recentFrom in athlete-view.js). */
export const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
/** Age on the tournament day, or null without a valid birth date (an anonymised profile). */
export function entryAge(profile,date){try{return dateValid(profile?.birthDate)&&dateValid(date)?ageAt(profile.birthDate,date):null;}catch{return null;}}
const num=v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
/** The measures of the entry window from a profile or an entry snapshot: {weight,height,gradeType,grade}. */
export const measuresOf=a=>({weight:a?.weight??null,height:a?.height??null,gradeType:a?.gradeType==='dan'?'dan':'cup',grade:a?.grade??null});
/** Whether measures are inside the server's ranges (Rules::validate): weight 10–250 kg, height 70–250 cm, grade 1–10 Cup / 1–9 Dan. */
export function measuresValid(m){
 const w=num(m?.weight),h=num(m?.height),g=num(m?.grade);
 return Number.isFinite(w)&&w>=10&&w<=250&&Number.isFinite(h)&&h>=70&&h<=250&&['cup','dan'].includes(m?.gradeType)&&Number.isInteger(g)&&g>=1&&g<=(m.gradeType==='cup'?10:9);
}
/** The candidate entry for the rules engine (classify, eligibility) on the tournament day. */
export function candidate(profile,measures,date){
 const age=entryAge(profile,date),valid=measuresValid(measures);
 return {age,sex:profile?.sex,gradeType:measures?.gradeType,grade:num(measures?.grade),weight:num(measures?.weight),height:num(measures?.height),actualWeight:null,valid};
}
/** The events of the entry window, in engine order: [{event, state:'allowed'|'ineligible'|'drawn', reason, category, note}].
 * ineligible: the engine's eligibility message for the age and grade on the tournament day (reason, Polish engine text);
 * drawn: the category the entry would join already has a saved draw (tournament.drawn, category ids; the server refuses, §7.1);
 * category {id,title,subtitle} with valid measures, null otherwise; note: a classify message when the engine cannot place the
 * entry (the organizer decides; the entry is still accepted, as on the server). */
export function eventOptions(profile,measures,tournament){
 const a=candidate(profile,measures,tournament?.date),drawn=new Set(Array.isArray(tournament?.drawn)?tournament.drawn:[]);
 return EVENT_KEYS.map(event=>{
  if(!Number.isInteger(a.age))return {event,state:'ineligible',reason:'Podaj poprawną datę.',category:null,note:null};
  const reason=eligibility(a,event);if(reason)return {event,state:'ineligible',reason,category:null,note:null};
  if(!a.valid)return {event,state:'allowed',reason:null,category:null,note:null};
  const c=classify(a,event);if(c.error)return {event,state:'allowed',reason:null,category:null,note:c.error};
  const category={id:c.id,title:c.title,subtitle:c.subtitle};
  return drawn.has(c.id)?{event,state:'drawn',reason:null,category,note:null}:{event,state:'allowed',reason:null,category,note:null};
 });
}
/** The chosen events that can be sent (allowed ones only, engine order). */
export const chosenEvents=(options,events)=>options.filter(o=>o.state==='allowed'&&events.includes(o.event)).map(o=>o.event);
/** Category preview of the chosen events: [{event,subtitle}] (subtitle '' when the measures are incomplete or the organizer decides). */
export const categoryPreview=(options,events)=>options.filter(o=>o.state==='allowed'&&events.includes(o.event)).map(o=>({event:o.event,subtitle:o.category?.subtitle??'',note:o.note}));

/** Card status of an own entry (§7.6): {code, weight?}. Codes: paused (draft or hidden: "the organizer or the Administrator paused
 * this tournament"), finished, absent, present (checked in, weight = the actual weight), closed (waiting for check-in), accepted. */
export function entryStatus(item){
 const t=item?.tournament||{},e=item?.entry||{};
 if(t.available===false)return {code:'paused'};
 if(t.status==='finished')return {code:'finished'};
 if(e.presence==='absent')return {code:'absent'};
 if(e.presence==='present')return {code:'present',weight:e.actualWeight??e.weight??null};
 if(t.status==='closed')return {code:'closed'};
 return {code:'accepted'};
}
/** The line of a category with a saved draw (AthleteView position): {code:'next'|'waiting'|'bye'|'won'|'lost'|'champion', match,
 * round, opponent:{initials,club}|null} or null without a draw. */
export function positionStatus(c){
 const p=c?.position;if(!isObj(p)||!['next','waiting','bye','won','lost','champion'].includes(p.status))return null;
 return {code:p.status,match:Number(p.match)||null,round:Number(p.round)||null,opponent:isObj(p.opponent)?{initials:String(p.opponent.initials??''),club:p.opponent.club??null}:null};
}
/** Own entries for the page: coming ones first (nearest first), then the earlier ones (newest first, as the server sends them). */
export function sortEntries(entries,today){
 const list=Array.isArray(entries)?[...entries]:[],date=x=>String(x?.tournament?.date??'');
 const coming=list.filter(x=>date(x)>=today).sort((a,b)=>cmp(date(a),date(b))||cmp(String(a.tournament.id),String(b.tournament.id)));
 return [...coming,...list.filter(x=>date(x)<today)];
}
/** Own starts in the next BADGE_DAYS days (today included): available tournaments that are not finished; the menu badge (§7.6). */
export function upcomingCount(view,today){
 const end=addDays(today,BADGE_DAYS);
 return (view?.entries||[]).filter(x=>{const t=x?.tournament||{};return t.available!==false&&t.status!=='finished'&&typeof t.date==='string'&&t.date>=today&&t.date<end;}).length;
}
/** Profiles that can enter (not archived), in the view's order. */
export const activeProfiles=view=>(view?.profiles||[]).filter(p=>!p.archived);
export const openItem=(view,id)=>(view?.open||[]).find(t=>t.id===id)||null;
export const entryItem=(view,id,profileId)=>(view?.entries||[]).find(x=>x?.tournament?.id===id&&(profileId==null||x.profileId===profileId))||null;
/** Call to action in a member's tournament preview (§10.3): {kind:'add'} for a member without an athlete profile, only when the
 * tournament is on the open list of view (the route athlete answers members without a profile too: open, self-entry, future and
 * not hidden), so nobody is asked for a child's data where a self-entry would be refused; {kind:'entered',profileId,canEdit} when
 * a profile is entered; {kind:'enter',profileId} when the open list allows it; {kind:'blocked',reason:'minor-untrusted'}, or
 * reason 'closed' when the open item takes no new self-entry (entriesClosed: the organizer was blocked or deactivated, R1.6);
 * {kind:'unavailable'} otherwise (the caller explains it from the tournament status). selfEntry false (features.selfEntry) and a
 * member without a profile outside the open list give null: no call to action at all. */
export function ctaFor(view,id,{athlete=false,selfEntry=true,rolesOpen=true}={}){
 if(selfEntry===false)return null;
 // Without an athlete profile the member is asked for one only while roles are open (me.features.rolesOpen).
 if(!athlete)return rolesOpen&&openItem(view,id)&&!openItem(view,id).entriesClosed?{kind:'add'}:null;
 const entered=entryItem(view,id);if(entered)return {kind:'entered',profileId:entered.profileId,canEdit:!!entered.canEdit};
 const t=openItem(view,id);if(!t)return {kind:'unavailable'};if(t.entriesClosed)return {kind:'blocked',reason:'closed'};
 const rows=(t.profiles||[]).filter(p=>!p.entered),free=rows.find(p=>!p.blocked);
 if(free)return {kind:'enter',profileId:free.id};
 if(rows.length)return {kind:'blocked',reason:rows[0].blocked};
 return {kind:'unavailable'};
}
/** Whether the open list of view may be cut at OPEN_LIMIT (the nearest tournaments first), so a later one can be missing from it. */
export const openTruncated=view=>(view?.open||[]).length>=OPEN_LIMIT;
/** Why a tournament outside the open list takes no self-entry: 'finished', 'closed' (not open or dated before today), 'off' (open,
 * but the organizer did not switch self-entries on) or 'later' instead of 'off' when the open list is cut (truncated: openTruncated),
 * because then the tournament may take self-entries and only be past the list's end. */
export function unavailableReason(t,today,{truncated=false}={}){
 if(!t)return 'closed';if(t.status==='finished')return 'finished';
 return t.status!=='open'||typeof t.date!=='string'||t.date<today?'closed':truncated?'later':'off';
}
/** Body of athlete-entry (§7.2) from the window's values: numbers as numbers, events in engine order, only the listed fields. */
export function entryBody({tournamentId,profileId,events,weight,height,gradeType,grade,saveToProfile,update}){
 const body={tournamentId:String(tournamentId),profileId:String(profileId),events:EVENT_KEYS.filter(e=>(events||[]).includes(e)),weight:num(weight),height:num(height),gradeType:gradeType==='dan'?'dan':'cup',grade:num(grade),saveToProfile:saveToProfile===true};
 if(update===true)body.update=true;
 return body;
}
