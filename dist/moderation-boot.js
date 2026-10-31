/* MatBravo moderation entry (plan §8.1, §12.11): registers the Admin page #moderation with its menu badge of open reports and loads the
 * panel (chat-admin.js) lazily after the page is painted. Imported statically by app.js, so it stays small and has no side effects other
 * than the registrations.
 * Badge: the number of messages with open reports (admin-chat-reports, first page, field total) is read after 'ready' and 'login' and then
 * every 5 minutes while the tab is visible; the open panel updates it itself after every load. Never on #screen, never in the demo. */
import {registry,h,setHtml} from './registry.js';
import {t as T} from './i18n.js';
import * as Client from './client.js';

export const BADGE_MS=300000;
/** Number for the menu badge from an admin-chat-reports answer (messages with open reports). */
export const openReports=data=>Math.max(0,Math.floor(Number(data?.total))||0);
const isAdmin=()=>registry.use('ui')?.getWorkspace?.()?.user?.role==='admin';
const onScreen=()=>typeof location!=='undefined'&&location.hash.startsWith('#screen');
let timer=0,lastAt=0,off=false,flight=null;

/** Reads the count and sets the badge; returns the count or null (not an Admin, demo, hall display, unavailable route or an error). */
export function refreshBadge({now=Date.now}={}){
 if(off||Client.isDemo||!isAdmin()||onScreen())return Promise.resolve(null);
 if(flight)return flight;
 flight=Client.request({route:'admin-chat-reports',status:'open',page:'1'}).then(data=>{lastAt=now();const n=openReports(data);registry.setBadge('moderation',n);return n;},error=>{
  if(error?.status===404||error?.status===403)off=true;
  return null;
 }).finally(()=>{flight=null;});
 return flight;
}
const visible=()=>typeof document==='undefined'||document.visibilityState!=='hidden';
function start(){
 stop();if(Client.isDemo||!isAdmin())return;
 refreshBadge();
 timer=setInterval(()=>{if(visible())refreshBadge();},BADGE_MS);
}
function stop(){if(timer){clearInterval(timer);timer=0;}}

registry.registerPage({
 id:'moderation',icon:'shield',nav:'admin',roles:['admin'],order:70,
 label:()=>T('Moderacja'),title:()=>T('Moderacja'),
 render:()=>registry.use('ui').shell(h`<div class="mod-root" data-mod-root aria-busy="true"><div class="mod-skeleton" aria-hidden="true">${[0,1,2].map(()=>h`<div class="mod-skel-row"></div>`)}</div></div>`,T('Moderacja'),T('Zgłoszenia, wyciszenia i ustawienia czatu'))
});

registry.on('painted',({view,page})=>{
 if(view!=='app'||page!=='moderation')return;
 const root=document.querySelector('[data-mod-root]');if(!root)return;
 import('./chat-admin.js').then(m=>m.mount(root)).catch(error=>{
  try{console.error('MatBravo moderation failed to load',error);}catch{}
  if(root.isConnected){setHtml(root,h`<p class="form-error" role="alert">${T('Nie udało się wczytać panelu moderacji.')}</p>`);root.removeAttribute('aria-busy');}
 });
});
registry.on('ready',start);
registry.on('login',()=>{off=false;start();});
registry.on('logout',()=>{stop();off=false;registry.setBadge('moderation',0);});
if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{
 if(document.visibilityState==='visible'&&timer&&Date.now()-lastAt>=BADGE_MS)refreshBadge();
});
