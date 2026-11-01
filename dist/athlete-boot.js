/* Athlete pages (PLAN-REJESTRACJA-ROLE §7.3–§7.6, §10.3), static part imported by app.js and kept small; the screens live in the
 * lazily loaded athlete-flow.js. Here:
 *  - page #starts "Moje starty" (roles member, visible with caps.athlete of the workspace user or of me, nav global, order 15);
 *  - the AthleteView of the signed-in member (route athlete; Client.athleteRequest answers it in the demo), cached and shared by
 *    the page, the entry window and the preview's call to action: refreshed on entering, after every action and every 60 s while
 *    #starts is visible (only repainted when it changed);
 *  - the menu badge: own starts in the next 7 days (registry.setBadge('starts'));
 *  - after 'painted' {view:'guest', memberPreview:true}: the call to action in [data-athlete-cta] (enter / entered / add data);
 *  - the actions athlete-enter, athlete-edit, athlete-withdraw, athlete-withdraw-confirm, athlete-profile, athlete-refresh and the
 *    form #ath-entry-form (input and change re-check the events and the category preview).
 * Templates: h`…` and setHtml only (tests/xss-scan). */
import {registry,h} from './registry.js';
import * as Client from './client.js';
import {getMe,onMe} from './me.js';
import {t as T} from './i18n.js';
import {warsawToday} from './guest-view.js';
import {upcomingCount,REFRESH_MS,STALE_MS} from './athlete-data.js';

const flow=()=>import('./athlete-flow.js');
const ui=()=>registry.use('ui');
const log=error=>{try{console.error('MatBravo athlete module failed',error);}catch{}};
const signedIn=()=>{try{return ui()?.getWorkspace?.()?.user||null;}catch{return null;}};
/** Whether user may see "Moje starty": a member with an athlete profile, by the workspace's caps or by a fresher me (after the
 * profile was added on the Role tab, me is reloaded before the workspace). */
export function athleteUser(user,me=getMe()){
 if(user?.role!=='member')return false;
 return !!user.caps?.athlete||(me?.user?.id!=null&&me.user.id===user.id&&!!me.user.caps?.athlete);
}
let shown=null;
registry.registerPage({id:'starts',icon:'trophy',nav:'global',roles:['member'],order:15,label:()=>T('Moje starty'),title:()=>T('Moje starty'),
 visible:u=>(shown=athleteUser(u)),
 render:()=>ui().shell(h`<div class="ath-page" data-starts-root aria-busy="true"><p class="muted ath-loading" role="status">${T('Wczytuję Twoje starty…')}</p></div>`,T('Moje starty'),T('Twoje zgłoszenia, drabinki i otwarte turnieje'))});

// ---- The athlete view of the signed-in member (one request at a time; a sign-out drops it) ----
const cache={view:null,at:0,userId:null,pending:null,generation:0};
/** The cached view (null before the first answer or for another user). */
export const cachedView=()=>{const u=signedIn();return u&&cache.userId===u.id?cache.view:null;};
/** Loads the view (route athlete): the cached one while younger than maxAge ms unless force. Resolves to the view; rejects with the
 * request's error (401 and others), which callers pass to ui.handleError or show. Updates the menu badge. */
export function loadView({force=false,maxAge=REFRESH_MS}={}){
 const u=signedIn();if(!athleteUser(u))return Promise.resolve(null);
 if(cache.userId!==u.id){cache.view=null;cache.at=0;cache.userId=u.id;cache.pending=null;}
 if(!force&&cache.view&&Date.now()-cache.at<maxAge)return Promise.resolve(cache.view);
 if(cache.pending)return cache.pending;
 const ticket=cache.generation,id=u.id;
 const run=cache.pending=Client.athleteRequest('athlete').then(view=>{
  if(ticket!==cache.generation||cache.userId!==id)return null;
  cache.view=view&&typeof view==='object'?view:null;cache.at=Date.now();
  registry.setBadge('starts',upcomingCount(cache.view,warsawToday()));return cache.view;
 }).finally(()=>{if(cache.pending===run)cache.pending=null;});
 return run;
}
function forget(){cache.generation++;cache.view=null;cache.at=0;cache.userId=null;cache.pending=null;registry.setBadge('starts',0);stopTimer();}

// ---- Refresh every 60 s while #starts is visible (§7.6) ----
let timer=null;
const onStarts=()=>registry.parseRoute(location.hash).page==='starts'&&!!document.querySelector('[data-starts-root]');
function startTimer(){if(timer)return;timer=setInterval(()=>{if(document.visibilityState==='visible'&&onStarts()&&!document.querySelector('#modal-root .modal'))flow().then(m=>m.refreshStarts()).catch(log);else if(!onStarts())stopTimer();},REFRESH_MS);}
function stopTimer(){if(timer){clearInterval(timer);timer=null;}}

if(typeof document!=='undefined'){
 registry.on('painted',({view,page,memberPreview}={})=>{
  const u=signedIn();
  if(view==='app'){
   if(page==='starts'&&athleteUser(u)){startTimer();flow().then(m=>m.mountStarts()).catch(log);return;}
   stopTimer();if(athleteUser(u))loadView({maxAge:STALE_MS}).catch(()=>{});// the menu badge
  }else if(view==='guest'&&memberPreview&&u?.role==='member'){stopTimer();const mount=document.querySelector('[data-athlete-cta]');if(mount)flow().then(m=>m.mountCta(mount)).catch(log);}
  else stopTimer();
 });
 registry.on('logout',forget);// a new sign-in of another person is caught by cache.userId
 // The menu follows me when it shows the athlete role sooner (or later) than the workspace: one re-render on a change.
 onMe(me=>{const u=signedIn();if(!u||shown===null||document.querySelector('#modal-root .modal')||!document.querySelector('#app-sidebar'))return;if(athleteUser(u,me)!==shown)ui()?.render?.();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&onStarts()&&Date.now()-cache.at>=REFRESH_MS)flow().then(m=>m.refreshStarts()).catch(log);});
 const act=name=>(el,id)=>flow().then(m=>m.action(name,el,id));
 for(const name of ['athlete-enter','athlete-edit','athlete-withdraw','athlete-withdraw-confirm','athlete-profile','athlete-refresh'])registry.registerAction(name,act(name));
 document.addEventListener('submit',event=>{if(event.target?.id!=='ath-entry-form')return;event.preventDefault();const form=event.target,submit=event.submitter;flow().then(m=>m.submitEntry(form,submit)).catch(log);});
 const changed=event=>{const form=event.target?.closest?.('#ath-entry-form');if(form)flow().then(m=>m.entryChanged(form,event.target)).catch(log);};
 document.addEventListener('input',changed);document.addEventListener('change',changed);
}
