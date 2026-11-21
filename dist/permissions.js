/* The Administrator's permission matrix (panel "Uprawnienia"): mirror of backend/src/Permissions.php (TYPES, PERMS, EDITABLE,
 * FIXED, allows, actor, types, normalize; tests/permissions.test.mjs compares both). Data only, no DOM.
 * Rows are account types, columns permissions; an editable cell is on by default and switching it off takes that ability away,
 * a fixed cell never changes (the Administrator is never limited, nobody gains an ability the code was not built for). Without
 * a stored matrix every answer is the behaviour before the panel. Sport-scoped permissions may differ per discipline; a sport
 * without its own set inherits the global one.
 * The active matrix: workspace.js execute()/publicWorkspace() take db.flags.perms (as Domain does), and the browser app takes
 * workspace.perms of the server's workspace (usePermissions), so buttons match what the server allows. */
import {SPORT_IDS} from './sports.js';

export const TYPES=['admin','editor','club','organizer','athlete','guardian','member','guest'];
export const PERMS={'tournament.create':'sport','tournament.manage':'sport','athletes.manage':'global','entries.submit':'sport','entries.self':'sport','chat.write':'sport','chat.moderate':'global','admin.manage':'global','billing.required':'sport'};
export const EDITABLE={
 editor:['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write','billing.required'],
 club:['athletes.manage','entries.submit','chat.write','billing.required'],
 organizer:['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write','billing.required'],
 athlete:['entries.self','chat.write','billing.required'],
 guardian:['entries.self','chat.write','billing.required'],
 member:['chat.write','billing.required'],
};
/** Editable cells off by default. billing.required ("Paid account") is who needs a subscription while payments are required
 *  (Access::compute on the server): staff free, every kind of member account paying, as before the panel. */
export const OFF_BY_DEFAULT={editor:['billing.required'],club:['billing.required']};
export const FIXED={admin:['tournament.create','tournament.manage','athletes.manage','entries.submit','chat.write','chat.moderate','admin.manage']};
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
let active=null;
/** Makes $matrix the active one (null: none stored). */
export function usePermissions(matrix){active=isObj(matrix)?matrix:null;}
export const activePermissions=()=>active;
export const editable=(type,perm)=>(EDITABLE[type]||[]).includes(perm);
/** The value of a fixed cell, or the default of an editable one (on unless OFF_BY_DEFAULT). */
export const fixedValue=(type,perm)=>editable(type,perm)?!(OFF_BY_DEFAULT[type]||[]).includes(perm):(FIXED[type]||[]).includes(perm);
/** Whether account type $type has $perm in discipline $sport (null: the global set) under $matrix (default: the active one). */
export function allows(type,perm,sport=null,...matrix){
 if(!editable(type,perm))return fixedValue(type,perm);
 const m=matrix.length?matrix[0]:active;if(!isObj(m))return fixedValue(type,perm);
 if(sport!=null&&PERMS[perm]==='sport'){const v=m.sports?.[sport]?.[type]?.[perm];if(typeof v==='boolean')return v;}
 return (m.global?.[type]?.[perm]??fixedValue(type,perm))===true;
}
/** Permissions::paid: an account with the types $types pays in discipline $sport (null: the global set) when any of them pays (column "Paid account"). */
export const paid=(list,matrix,sport=null)=>list.some(t=>allows(t,'billing.required',sport,matrix??null));
/** Domain's rules for an actor the code already allows: admin always, editor and club by their row, a member organizer by the organizers' row. */
export function actor(u,perm,sport=null,isOrganizer=false){
 const role=u?.role;
 if(role==='admin')return true;
 if(role==='editor'||role==='club')return allows(role,perm,sport);
 return role==='member'&&isOrganizer&&allows('organizer',perm,sport);
}
/** Account types of a signed-in account for the chat (Permissions::types). */
export function types(role,organizer=false,relations=[]){
 if(role!=='member')return ['admin','editor','club'].includes(role)?[role]:[];
 const out=[];if(organizer)out.push('organizer');if(relations.includes('self'))out.push('athlete');if(relations.includes('guardian'))out.push('guardian');
 return out.length?out:['member'];
}
function cells(set,sport,base){
 const out={};
 for(const [type,perms] of Object.entries(EDITABLE))for(const perm of perms){
  if(sport&&PERMS[perm]!=='sport')continue;
  const v=isObj(set)?set[type]?.[perm]:undefined;(out[type]??={})[perm]=typeof v==='boolean'?v:(base?.[type]?.[perm]??fixedValue(type,perm));
 }
 return out;
}
/** Permissions::normalize: {global, sports} with every editable cell, or null when nothing is stored. */
export function normalize(d){
 if(!isObj(d)||!isObj(d.global)&&!isObj(d.sports))return null;
 const global=cells(isObj(d.global)?d.global:null,false,null),sports={};
 for(const [slug,set] of Object.entries(isObj(d.sports)?d.sports:{}))if(SPORT_IDS.includes(slug)&&isObj(set))sports[slug]=cells(set,true,global);
 return {global,sports};
}
export const defaults=()=>({global:cells(null,false,null),sports:{}});
