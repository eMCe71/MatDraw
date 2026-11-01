/* Chat entry points (plan §8.1, §8.9, §12.10): small and static, app.js imports it; the interface itself (chat.js) loads lazily.
 * Pages: #chat for every signed-in role (global menu, unread badge), "Czat turnieju" in the tournament menu (staff, organizers), the public #chat
 * for guests. After 'painted' it mounts [data-chat-mount=home|tournament|strip|page] (the home card only when it comes within 200 px of
 * the viewport) and fills [data-chat-tournament-link]; [data-chat-count] is filled after 'painted' and after 'upcoming-painted',
 * because the upcoming list arrives asynchronously and is refreshed. Nothing is mounted on #screen (no 'painted' there). */
import {registry,h,setHtml} from './registry.js';
import {t as T} from './i18n.js';

let pending=null,loaded=null;
/** chat.js, loaded once (a failed load is retried on the next paint). */
export function load(){
 pending??=import('./chat.js').catch(error=>{pending=null;try{console.error('MatBravo chat failed to load',error);}catch{}return null;});
 return pending;
}
const ui=()=>registry.use('ui');
const shell=(content,title,subtitle)=>ui()?.shell?ui().shell(content,title,subtitle):content;

registry.registerPage({id:'chat',icon:'chat',label:()=>T('Czat'),nav:'global',roles:['admin','editor','club','member'],order:10,title:()=>T('Czat'),
 render:()=>shell(h`<div class="chat-page-mount" data-chat-mount="page"></div>`,T('Czat'),T('Społeczność MatBravo'))});
// A member reaches it only with a tournament in the workspace (an organizer, PLAN-REJESTRACJA-ROLE §10.4): event pages need one;
// visible() keeps a member without the organizer role (athlete, chat only) out of it also on a typed #event-chat.
registry.registerPage({id:'event-chat',icon:'chat',label:()=>T('Czat turnieju'),nav:'event',roles:['admin','editor','club','member'],order:50,title:()=>T('Czat turnieju'),visible:u=>!registry.communityOnly(u),
 render:()=>{const t=ui()?.getState?.()?.tournament;return shell(h`<div class="chat-page-mount" data-chat-mount="page" data-tournament="${t?.id||''}"></div>`,T('Czat turnieju'),t?.name||'');}});
// Guests: the public full chat (#chat, #chat?c=<slug>, #chat?t=<tournamentId>) with the guest bar.
registry.registerPublicPage({id:'chat',render:()=>{
 const app=document.querySelector('#app');
 const paint=m=>{if(!m||registry.parseRoute(location.hash).page!=='chat'||ui()?.getWorkspace?.())return;setHtml(app,m.publicFrame());m.scan();};
 if(pending&&loaded){paint(loaded);return;}
 setHtml(app,h`<div class="app-loading">${T('Wczytywanie czatu…')}</div>`);load().then(m=>{loaded=m;paint(m);});
}});

function near(el,fn){
 if(typeof IntersectionObserver!=='function'){fn();return;}
 const io=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){io.disconnect();fn();}},{rootMargin:'200px'});io.observe(el);
}
const run=fn=>load().then(m=>{if(m){loaded=m;fn(m);}});
registry.on('painted',({view}={})=>{
 const d=document,home=d.querySelector('[data-chat-mount="home"]');
 if(view==='login'){if(home)near(home,()=>run(m=>m.scan()));if(d.querySelector('[data-chat-count]'))run(m=>m.fillCounts());return;}
 if(view==='app'||d.querySelector('[data-chat-mount],[data-chat-tournament-link],[data-chat-tab-count],[data-chat-count]'))run(m=>m.scan());
});
registry.on('upcoming-painted',()=>run(m=>m.fillCounts()));
