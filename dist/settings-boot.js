/* Administrator's settings and clubs pages (PLAN-REJESTRACJA-ROLE §10.5), static part: registers #settings and #clubs (nav 'admin')
 * and wakes the lazy modules for the Administrator only:
 *  - #settings: after 'painted' admin-settings.js draws the panel into [data-settings-root] (server only; the demo gets the demo message);
 *  - #clubs: after 'painted' admin-clubs.js draws the clubs table into [data-clubs-root] (workspace commands, works in the demo too);
 *  - #tournaments: after 'painted' admin-clubs.js fills the card tools in [data-tournament-admin] (app.js tournamentsPage);
 *  - the nav badge of #members: organizers waiting for confirmation (me.features.pendingOrganizers, Administrator only; the server
 *    reports 0 while the confirmation is not required, organizers.trustRequired=false, §17).
 * Nothing runs for other roles. */
import {registry,h} from './registry.js';
import {onMe} from './me.js';
import {t as T} from './i18n.js';

const settings=()=>import('./admin-settings.js'),clubs=()=>import('./admin-clubs.js');
const isAdmin=()=>registry.use('ui')?.getWorkspace?.()?.user?.role==='admin';
const log=error=>{try{console.error('MatBravo settings module failed',error);}catch{}};
/** The number on the "Members" menu item: organizers waiting for the Administrator's confirmation (0 for anyone else). */
export const pendingOrganizers=me=>me?.user?.role==='admin'?Math.max(0,Math.trunc(Number(me?.features?.pendingOrganizers))||0):0;

registry.registerPage({
 id:'clubs',icon:'flag',nav:'admin',roles:['admin'],order:75,
 label:()=>T('Kluby'),title:()=>T('Kluby'),
 render:()=>registry.use('ui').shell(h`<div class="clb-page" data-clubs-root><p class="muted" role="status">${T('Wczytuję kluby…')}</p></div>`,T('Kluby'),T('Weryfikacja, nazwy i scalanie klubów'))
});
registry.registerPage({
 id:'settings',icon:'settings',nav:'admin',roles:['admin'],order:90,
 label:()=>T('Ustawienia'),title:()=>T('Ustawienia'),
 render:()=>registry.use('ui').shell(h`<div class="set-page" data-settings-root><p class="muted" role="status">${T('Wczytuję ustawienia…')}</p></div>`,T('Ustawienia'),T('Rejestracja, płatności, organizatorzy i adres pomocy'))
});

registry.on('painted',({view,page})=>{
 if(view!=='app'||!isAdmin())return;
 if(page==='settings')settings().then(m=>m.mountSettingsPage()).catch(log);
 else if(page==='clubs')clubs().then(m=>m.mountClubsPage()).catch(log);
 else if(page==='tournaments'&&typeof document!=='undefined'&&document.querySelector('[data-tournament-admin]'))clubs().then(m=>m.mountTournamentTools()).catch(log);
});
onMe(me=>registry.setBadge('members',pendingOrganizers(me)));
registry.on('logout',()=>registry.setBadge('members',0));
