/* Members feature, static part (plan §8.1, §8.3 point 12): registers the Admin page "Members" and wakes the lazy module
 * admin-members.js (import() on demand) for the Admin only:
 *  - page #members: after 'painted' the module draws the list into [data-members-root];
 *  - staff accounts panel: after 'painted' it fills [data-billing-badge] (plan badges);
 *  - the account form (a modal, which app.js does not announce with 'painted'): a MutationObserver on #modal-root mounts the plan fields into
 *    [data-account-billing]; after 'saved' of the account form the module sends the plan change (result.id).
 * Nothing runs for other roles, and nothing is requested in the demo (no server). */
import {registry,h} from './registry.js';
import * as Client from './client.js';
import {t as T} from './i18n.js';

const lazy=()=>import('./admin-members.js');
const isAdmin=()=>registry.use('ui')?.getWorkspace?.()?.user?.role==='admin';
const log=error=>{try{console.error('MatBravo members module failed',error);}catch{}};

registry.registerPage({
 id:'members',icon:'users',nav:'admin',roles:['admin'],order:70,
 label:()=>T('Członkowie'),title:()=>T('Członkowie'),
 render:()=>registry.use('ui').shell(h`<div class="mem-page" data-members-root><p class="muted mem-loading" role="status">${T('Wczytuję członków…')}</p></div>`,T('Członkowie'),T('Konta członków, plany i hasła tymczasowe'))
});

registry.on('painted',({view,page})=>{
 if(view!=='app'||!isAdmin())return;
 if(page==='members')lazy().then(m=>m.mountMembersPage()).catch(log);
 else if(page==='accounts'&&!Client.isDemo)lazy().then(m=>m.fillStaffBadges()).catch(log);
});
registry.on('saved',detail=>{
 if(detail?.form!=='account-form'||Client.isDemo||!isAdmin())return;
 lazy().then(m=>m.onAccountSaved(detail)).catch(log);
});

function watchModals(){
 const modalRoot=document.querySelector('#modal-root');if(!modalRoot||typeof MutationObserver!=='function')return;
 new MutationObserver(()=>{
  const mount=modalRoot.querySelector('[data-account-billing]:not([data-mem-mounted])');
  if(mount&&isAdmin()&&!Client.isDemo)lazy().then(m=>m.mountAccountBilling(mount)).catch(log);
 }).observe(modalRoot,{childList:true,subtree:true});
}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchModals,{once:true});else watchModals();}
