/* MatBravo registry: pages, public pages, actions, menu items, badges and events contributed by feature modules
 * (chat, moderation, accounts, members, PWA), so that they never edit app.js. No imports: app.js, client.js, me.js and every
 * feature module can import it without cycles.
 *
 * Pages:   registerPage({id,icon,label,nav:'global'|'event'|'admin'|null,roles:['admin','editor','club','member'],order,title,render,visible})
 *          label/title may be strings or functions (called at render time, so they follow the current language); visible(user), when
 *          given, further limits the page to some users of its roles (e.g. u=>!!u?.caps?.athlete), in allows() and navItems();
 *          render(params) returns SafeHtml synchronously (usually ui.shell(placeholder)); modules fill it after 'painted'.
 * Public:  registerPublicPage({id,render(params)}) – a page without a workspace (guest); it writes #app itself.
 * Actions: registerAction(name,handler(el,id,ctx),{public:false}) – the last rung of the data-action ladder in app.js.
 * Events:  'ready','painted','upcoming-painted','login','logout','language','saved','payment-required','client-outdated' (and module
 *          events). 'upcoming-painted' {view:'login',tournaments:[ids]} fires after the async upcoming list is (re)painted.
 * Safe HTML (plan §5.9): h`…${x}…` escapes every interpolation unless it is SafeHtml from another h (arrays are joined);
 *          setHtml(el,safe) is the only innerHTML assignment and rejects plain strings.
 * Helpers: provide(name,value)/use(name); app.js provides 'ui' (T, esc, icon, button, badge, modal, closeModal, toast, navigate,
 *          shell, mascot, emptyMascot, render, commit, handleError, getWorkspace, getState, switchTournament, clubName, bracket).
 *          ui.icon/button/badge/mascot/emptyMascot/shell/bracket return SafeHtml; strings passed to them are escaped.
 * Roles (PLAN-REJESTRACJA-ROLE §10.4): a member with the organizer role (user.caps.organizer) works in the tournament workspace;
 *          communityOnly(user) is a member without it (chat, profile and the athlete's pages only). */

const TOKEN=Symbol('SafeHtml');
export class SafeHtml{
 #html;
 constructor(html,token){if(token!==TOKEN)throw new TypeError('SafeHtml is created only by h`…`.');this.#html=String(html);}
 toString(){return this.#html;}
 get html(){return this.#html;}
}
const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'};
export const escapeHtml=value=>String(value??'').replace(/[&<>"'`]/g,c=>ESC[c]);
const part=value=>value instanceof SafeHtml?value.html:Array.isArray(value)?value.map(part).join(''):value==null||value===false?'':escapeHtml(value);
// The value of an aria-* attribute (aria-pressed="${x}"): ARIA states need the words true/false, an empty value means "undefined".
const ARIA_VALUE=/\saria-[a-z]+=["']$/i;
/** Tagged template: every ${value} is escaped (null/undefined/false give ''), SafeHtml values are kept, arrays are joined.
 * A boolean that is the whole quoted value of an aria-* attribute gives "true"/"false" (aria-selected="${on}"); anywhere else
 * false still gives '' (so ${cond&&h`…`} and real boolean attributes such as ${x?h` disabled`:''} keep working). */
export function h(strings,...values){
 let out=strings[0];
 for(let i=0;i<values.length;i++){const v=values[i];out+=(typeof v==='boolean'&&ARIA_VALUE.test(strings[i])&&/^["']/.test(strings[i+1])?String(v):part(v))+strings[i+1];}
 return new SafeHtml(out,TOKEN);
}
/** Wraps HTML that app.js built with its own escaping (shell, icon, mascot). Feature modules must not call it (tests/xss-scan). */
export const trustedHtml=html=>new SafeHtml(html,TOKEN);
/** The only place that writes innerHTML for feature modules. */
export function setHtml(el,safe){
 if(!(safe instanceof SafeHtml))throw new TypeError('setHtml accepts only SafeHtml from h`…`.');
 el.innerHTML=safe.html;return el;
}

const pages=new Map(),publicPages=new Map(),actions=new Map(),listeners=new Map(),provided=new Map(),badges=new Map();
const ROLE_LIST=['admin','editor','club','member'];
const text=value=>typeof value==='function'?value():value??'';

export function registerPage(def){
 if(!def?.id||typeof def.render!=='function')throw new TypeError('registerPage needs id and render.');
 if(pages.has(def.id))throw new Error('Page already registered: '+def.id);
 pages.set(def.id,{nav:null,roles:ROLE_LIST,order:100,icon:'info',...def});
}
export function registerPublicPage(def){
 if(!def?.id||typeof def.render!=='function')throw new TypeError('registerPublicPage needs id and render.');
 if(publicPages.has(def.id))throw new Error('Public page already registered: '+def.id);
 publicPages.set(def.id,def);
}
export function registerAction(name,handler,{public:isPublic=false}={}){
 if(typeof handler!=='function')throw new TypeError('registerAction needs a handler.');
 if(actions.has(name))throw new Error('Action already registered: '+name);
 actions.set(name,{handler,public:!!isPublic});
}
export const page=id=>pages.get(id)||null;
export const publicPage=id=>publicPages.get(id)||null;
/** A member without the organizer role: no tournament workspace (menu, #screen, redirects to the member's start page). */
export const communityOnly=user=>user?.role==='member'&&!user?.caps?.organizer;
/** A member with the organizer role (caps from me, bootstrap or Actors::of on the server). */
export const organizerUser=user=>user?.role==='member'&&!!user?.caps?.organizer;
const seen=(def,user)=>{if(typeof def.visible!=='function')return true;try{return !!def.visible(user??null);}catch{return false;}};
/** Whether a registered page may be shown to this role (and, for a page with visible(user), to this user). */
export const allows=(def,role,user)=>!!def&&(def.roles||ROLE_LIST).includes(role)&&(def.nav!=='admin'||role==='admin')&&seen(def,user);
/** Menu items for a signed-in user: {id,icon,label,nav,badge}, ordered; 'admin' items only for the admin, 'event' only with a tournament. */
export function navItems(user,{tournament}={}){
 const role=user?.role;
 return [...pages.values()].filter(p=>p.nav&&allows(p,role,user)&&(p.nav!=='event'||!!tournament?.id)).sort((a,b)=>a.order-b.order||String(a.id).localeCompare(String(b.id)))
  .map(p=>({id:p.id,icon:p.icon,label:text(p.label),nav:p.nav,badge:badges.get(p.id)||0}));
}
export const title=id=>{const p=pages.get(id);return p?text(p.title??p.label):'';};
/** Runs a registered action: false when none matches, otherwise a promise of true (await it to catch the handler's errors).
 * Without a session (ctx.public) only public actions run. */
export function handle(action,el,id,ctx={}){
 const a=actions.get(action);if(!a||(ctx.public&&!a.public))return false;
 return Promise.resolve(a.handler(el,id,ctx)).then(()=>true);
}
/** The signed-in user of this role (app.js provides ui.getWorkspace), for callers that pass the role only. */
function signedIn(role){try{const u=provided.get('ui')?.getWorkspace?.()?.user;return u&&u.role===role?u:null;}catch{return null;}}
/** Landing page: staff and organizers keep the tournaments page, other members start in the chat. Without user the signed-in user of
 * that role decides (app.js keeps calling defaultPage(role) in a few templates). */
export function defaultPage(role,user=signedIn(role)){
 if(role!=='member'||organizerUser(user))return 'tournaments';
 if(allows(pages.get('chat'),role,user))return 'chat';
 return [...pages.values()].filter(p=>allows(p,role,user)).sort((a,b)=>a.order-b.order)[0]?.id||'chat';
}
/** Copies text to the clipboard: true when copied, false when the browser refuses (no permission, no secure context, no API);
 * the caller then shows the text selected in a field (the fallback). */
export async function copyText(text,clipboard=globalThis.navigator?.clipboard){
 try{if(typeof clipboard?.writeText!=='function')return false;await clipboard.writeText(String(text));return true;}catch{return false;}
}

/** Updates [data-nav-badge=id] without a render; the value is remembered for the next shell render. */
export function setBadge(id,n){
 const value=Math.max(0,Number(n)||0);if(value)badges.set(id,value);else badges.delete(id);
 const doc=globalThis.document;if(!doc)return;
 const sel='[data-nav-badge="'+(globalThis.CSS?.escape?CSS.escape(id):String(id).replace(/["\\]/g,'\\$&'))+'"]';
 for(const el of doc.querySelectorAll(sel)){el.textContent=badgeText(value);el.hidden=!value;}
}
export const badge=id=>badges.get(id)||0;
export const badgeText=n=>n>99?'99+':String(n||'');

export function on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return()=>listeners.get(event)?.delete(fn);}
/** Calls every listener; one failing module never stops the others or the app. */
export function emit(event,detail={}){
 for(const fn of [...(listeners.get(event)||[])]){try{fn(detail);}catch(error){try{console.error('MatBravo '+event+' listener failed',error);}catch{}}}
}
export function provide(name,value){provided.set(name,value);}
export function use(name){return provided.get(name);}

const ALIASES={czat:'chat'};
/** '#chat?c=taekwondo-pl' -> {page:'chat',params,alias:false}; '#czat' -> {page:'chat',alias:true}. #screen and #guest are returned as they are. */
export function parseRoute(hash){
 const raw=String(hash??'').replace(/^#/,''),q=raw.indexOf('?'),name=(q<0?raw:raw.slice(0,q)).trim(),query=q<0?'':raw.slice(q+1);
 const page=Object.hasOwn(ALIASES,name)?ALIASES[name]:name;
 return {page,params:new URLSearchParams(query),alias:page!==name};
}
/** '#page' or '#page?query' for a page and optional params (object or URLSearchParams). */
export function routeHash(pageId,params){const q=params?new URLSearchParams(params).toString():'';return '#'+pageId+(q?'?'+q:'');}

// ---- Keyboard focus inside dialogs (WCAG 2.1.2, 2.4.3) ----
const FOCUSABLE='a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,audio[controls],video[controls],[tabindex],[contenteditable]:not([contenteditable="false"]),details>summary:first-of-type';
/** Elements of root that Tab stops on, in document order: enabled, not tabindex=-1, rendered (not hidden, display:none, inert or in a
 * closed <details> other than its summary) and, for a radio group, only the checked radio (or the first one when none is checked). */
export function tabbables(root){
 const win=root?.ownerDocument?.defaultView,seen=new Set(),out=[];if(!root?.querySelectorAll)return out;
 for(const el of root.querySelectorAll(FOCUSABLE)){
  if(el.tabIndex<0||el.matches(':disabled')||el.closest('[inert],[hidden]')||!el.getClientRects().length)continue;
  if(win&&win.getComputedStyle(el).visibility==='hidden')continue;
  const closed=el.parentElement?.closest('details:not([open])');if(closed&&!(el.matches('summary')&&el.parentElement===closed))continue;
  if(el.type==='radio'&&el.name){
   const key=(el.form?.id||'')+'|'+el.name;if(seen.has(key))continue;
   const group=[...root.querySelectorAll('input[type=radio]')].filter(r=>r.name===el.name&&r.form===el.form&&!r.matches(':disabled'));
   const pick=group.find(r=>r.checked)||group[0];if(pick!==el&&group.some(r=>r.checked))continue;seen.add(key);out.push(pick);continue;
  }
  out.push(el);
 }
 return out;
}
/** Keeps Tab and Shift+Tab inside root (a modal, a sheet): from the last stop to the first and back, and from anywhere outside
 * (or from an element inside that is not a tab stop, such as the dialog itself) to the nearest stop in that direction. Returns
 * true when it moved the focus. Between the edges the browser's own order is kept (textareas, canvases, radio groups, links). */
export function trapTab(event,root){
 if(event?.key!=='Tab'||!root)return false;
 const doc=root.ownerDocument,items=tabbables(root),active=doc.activeElement,first=items[0],last=items.at(-1);
 if(!items.length){event.preventDefault();return true;}
 let target=null;
 if(!root.contains(active)||active===root)target=event.shiftKey?last:first;
 else if(event.shiftKey?active===first:active===last)target=event.shiftKey?last:first;
 else if(!items.includes(active)){
  const after=items.filter(el=>active.compareDocumentPosition(el)&4);// DOCUMENT_POSITION_FOLLOWING
  if(event.shiftKey&&after.length===items.length)target=last;else if(!event.shiftKey&&!after.length)target=first;
 }
 if(!target)return false;
 event.preventDefault();target.focus();return true;
}

export const registry={SafeHtml,h,setHtml,trustedHtml,escapeHtml,tabbables,trapTab,registerPage,registerPublicPage,registerAction,page,publicPage,allows,navItems,title,handle,defaultPage,communityOnly,organizerUser,copyText,setBadge,badge,badgeText,on,emit,provide,use,parseRoute,routeHash};
