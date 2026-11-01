// Athlete pages (PLAN-REJESTRACJA-ROLE §7.3–§7.6, §10.3, §10.7): allowed events and the category preview on the tournament day
// (athlete-data.js on the rules engine), ineligible and drawn events as text with the reason, the card of every own-entry status
// (accepted, closed, present, absent, a saved draw with the own slot, finished, paused by the Administrator, withdrawn by the
// organizer and by the Administrator), canWithdraw/canEdit, the withdraw question, the privacy notice of staff and community
// tournaments, the preview's call to action, the menu badge and the demo adapter Client.athleteRequest (enter t-winter-2027 and
// withdraw). Browser checks (Playwright + Chromium) run with MATDRAW_BROWSER_TESTS=1: the static demo at 1440x900 and 390x844 in
// PL and EN (accessibility snapshot: every control has a name; the own slot in a bracket; no horizontal scroll; no CSP or console
// errors) and the API mode against a stub server (402 of athlete-entry leads to #billing; a correction without new events is sent
// with update:true).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

class MemoryStorage{#m=new Map();get length(){return this.#m.size;}key(i){return [...this.#m.keys()][i]??null;}getItem(k){return this.#m.has(k)?this.#m.get(k):null;}setItem(k,v){this.#m.set(k,String(v));}removeItem(k){this.#m.delete(k);}clear(){this.#m.clear();}}
globalThis.localStorage??=new MemoryStorage();globalThis.sessionStorage??=new MemoryStorage();
globalThis.BroadcastChannel=undefined;// me.js would keep the process alive
const {registry,h,SafeHtml}=await import('../dist/registry.js');
const {t,setLanguage,getLanguage}=await import('../dist/i18n.js');setLanguage('pl',{persist:false});
const data=await import('../dist/athlete-data.js');
const flow=await import('../dist/athlete-flow.js');
const Client=await import('../dist/client.js');
const {initialWorkspace,execute}=await import('../dist/workspace.js');
const {athleteView}=await import('../dist/athlete-view.js');
const {classify}=await import('../dist/engine.js');
const DIST=fileURLToPath(new URL('../dist/',import.meta.url));
const inLanguage=(lang,fn)=>{const before=getLanguage();setLanguage(lang,{persist:false});try{return fn();}finally{setLanguage(before,{persist:false});}};
const text=safe=>String(safe).replace(/<[^>]+>/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
// The shell helpers app.js provides (registry.use('ui')), reduced to what the templates need; ui.bracket records the own slot.
registry.provide('ui',{T:t,icon:name=>h`<svg data-icon="${name}"></svg>`,emptyMascot:()=>h``,bracket:(c,{highlight}={})=>h`<div class="bracket-stub" data-code="${c.code}" data-highlight="${highlight}"></div>`});

const TODAY='2030-06-15';
const CHILD={id:'p1',name:'Ola Test',birthDate:'2018-05-01',sex:'F',weight:30,height:130,gradeType:'cup',grade:9,relation:'guardian'};

test('events of the entry window: allowed ones with the category preview, ineligible ones with the engine reason, drawn ones',()=>{
 const t={id:'t1',date:'2030-06-20',drawn:[]};
 const options=data.eventOptions(CHILD,data.measuresOf(CHILD),t);
 assert.deepEqual(options.map(o=>[o.event,o.state]),[['forms','allowed'],['soft','ineligible'],['hogo','allowed'],['semi','ineligible'],['light','ineligible'],['special','allowed'],['power','ineligible']],'cadets (12 on the tournament day): forms, hogo, special');
 assert.equal(options.find(o=>o.event==='soft').reason,'Konkurencja niedostępna w tej grupie wieku');
 assert.equal(options.find(o=>o.event==='forms').category.subtitle,'Kadetki · kobiety · 10–7 Cup');
 assert.equal(options.find(o=>o.event==='hogo').category.subtitle,'Kadetki · kobiety · do 135 cm');
 assert.deepEqual(data.categoryPreview(options,['forms','hogo','soft']).map(r=>r.subtitle),['Kadetki · kobiety · 10–7 Cup','Kadetki · kobiety · do 135 cm'],'only allowed events are previewed');
 assert.deepEqual(data.chosenEvents(options,['soft','forms']),['forms'],'an ineligible event is never sent');
 // A category with a saved draw (the open list's drawn ids) is not possible: the server refuses (§7.1, DR-5).
 const drawn=data.eventOptions(CHILD,data.measuresOf(CHILD),{...t,drawn:[classify({...CHILD,age:12},'forms').id]});
 assert.equal(drawn.find(o=>o.event==='forms').state,'drawn');assert.equal(drawn.find(o=>o.event==='hogo').state,'allowed');
 // The age is the age on the tournament day; grade rules of the engine (light contact of juniors needs 6 Cup or better).
 const junior={...CHILD,birthDate:'2013-01-01',sex:'M',grade:7};
 const light=data.eventOptions(junior,data.measuresOf(junior),{date:'2030-06-20'}).find(o=>o.event==='light');
 assert.equal(light.state,'ineligible');assert.equal(light.reason,'Light contact juniorów wymaga co najmniej 6 Cup');
 assert.equal(data.eventOptions(junior,{...data.measuresOf(junior),grade:5},{date:'2030-06-20'}).find(o=>o.event==='light').state,'allowed');
 // Female younger juniors in semi contact: allowed, but the engine cannot place them (the organizer decides).
 const teen={...CHILD,birthDate:'2016-01-01'},semi=data.eventOptions(teen,data.measuresOf(teen),{date:'2030-06-20'}).find(o=>o.event==='semi');
 assert.equal(semi.state,'allowed');assert.equal(semi.category,null);assert.equal(semi.note,'Juniorki młodsze: niejednoznaczne przedziały wagowe');
 // Measures outside the server's ranges: no preview (no wrong category), eligibility still shown; no birth date: nothing allowed.
 const bad=data.eventOptions(CHILD,{...data.measuresOf(CHILD),weight:'5'},t);
 assert.ok(bad.filter(o=>o.state==='allowed').every(o=>o.category===null));assert.equal(data.measuresValid({weight:'5',height:130,gradeType:'cup',grade:9}),false);
 assert.equal(data.measuresValid({weight:'30.5',height:'130',gradeType:'dan',grade:'9'}),true);assert.equal(data.measuresValid({weight:30,height:130,gradeType:'dan',grade:10}),false);
 assert.ok(data.eventOptions({...CHILD,birthDate:null},data.measuresOf(CHILD),t).every(o=>o.state==='ineligible'));
});

test('the window shows impossible events as text with the reason (no disabled inputs) tied by aria-describedby; preview and notice',()=>{
 const t={id:'t1',name:'Puchar <Testowy>',city:'Opole',date:'2030-06-20',community:false,trusted:true,organizer:null,drawn:[classify({...CHILD,age:12},'hogo').id],profiles:[{id:'p1',entered:false,blocked:null}]};
 const html=String(flow.entryHtml({tournament:t,profile:CHILD,profiles:[CHILD],item:null,update:false}));
 assert.ok(!/disabled/.test(html),'no disabled fields that screen readers skip');
 assert.match(html,/<p class="ath-event ath-event-off" id="ath-ev-soft">.*Walki soft \/ kalaki.*Niedostępne: Konkurencja niedostępna w tej grupie wieku/);
 assert.match(html,/id="ath-ev-hogo">.*Niedostępne: losowanie tej kategorii już się odbyło\. Zgłoszenie może dodać organizator\./);
 const described=html.match(/data-ath-events-box aria-describedby="([^"]+)"/)[1].split(' ');
 assert.deepEqual(described,['ath-ev-soft','ath-ev-hogo','ath-ev-semi','ath-ev-light','ath-ev-power']);
 for(const id of described)assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(html,/<input type="checkbox" name="events" value="forms" aria-describedby="ath-ev-forms">/);assert.match(html,/<small id="ath-ev-forms">Kadetki · kobiety · 10–7 Cup<\/small>/);
 assert.match(html,/name="saveToProfile" checked/,'"Zapisz też w profilu" ticked by default');
 assert.match(html,/data-consent-slot hidden/,'empty consent slot');
 assert.ok(html.includes('Puchar &lt;Testowy&gt;')&&!html.includes('<Testowy>'),'API values are escaped');
 assert.match(text(flow.previewHtml(data.eventOptions(CHILD,data.measuresOf(CHILD),t),['forms'],true)),/Układy formalne Kadetki · kobiety · 10–7 Cup/);
 assert.match(text(flow.previewHtml([],[],true)),/Wybierz konkurencję/);
 // Editing an own entry: the entry's events and measures are the defaults.
 const item={profileId:'p1',tournament:t,entry:{events:['special'],weight:31,height:131,gradeType:'cup',grade:8},canEdit:true};
 const edit=String(flow.entryHtml({tournament:t,profile:CHILD,profiles:[CHILD],item,update:true}));
 assert.match(edit,/value="special" checked/);assert.match(edit,/name="weight"[^>]*value="31"/);assert.match(edit,/data-update="yes"/);
 inLanguage('en',()=>{const en=text(flow.entryHtml({tournament:t,profile:CHILD,profiles:[CHILD],item:null,update:false}));assert.match(en,/Not available: Event not available in this age group/);assert.match(en,/Also save in the profile/);});
});

test('privacy notice for every tournament: staff, confirmed and unconfirmed community organizers (with the organizer name)',()=>{
 const base='Dane zgłoszenia (imię i nazwisko, wiek, płeć, waga, wzrost, stopień, klub) zobaczą organizatorzy turnieju i Administrator MatBravo. W publicznej drabince widać tylko inicjały i klub.';
 assert.deepEqual(flow.noticeTexts({community:false,trusted:true}),[base,'Turniej prowadzi zespół MatBravo.']);
 assert.deepEqual(flow.noticeTexts({community:true,trusted:false,organizer:{n:'Ula U.'}}),[base,'Organizator: Ula U. Turniej społeczności — organizator niepotwierdzony przez MatBravo.']);
 assert.deepEqual(flow.noticeTexts({community:true,trusted:true,organizer:null}),[base,'Turniej społeczności — prowadzi go członek MatBravo, nie zespół MatBravo.']);
 inLanguage('en',()=>{const [a,b]=flow.noticeTexts({community:true,trusted:false,organizer:{n:'Ula U.'}});assert.match(a,/^The /);assert.equal(b,'Organizer: Ula U. Community tournament — the organizer is not confirmed by MatBravo.');});
});

/** A workspace with the child's own entries in every state of §7.6 (dates in 2030, staff tournaments unless stated). */
function scenario(){
 let db=initialWorkspace();
 db.users.push({id:'parent',clubId:null,email:'parent@example.test',role:'member',active:true,authVersion:1,organizer:false,organizerBlockedAt:null,organizerTrustedAt:null},
  {id:'org-t',clubId:null,email:'t@example.test',role:'member',active:true,authVersion:1,organizer:true,organizerBlockedAt:null,organizerTrustedAt:1790000000});
 const run=(actor,type,p)=>{const r=execute(db,actor,type,p);db=r.db;return r.result;};
 const tour=(actor,name,date,extra={})=>run(actor,'tournament.save',{name,city:'Opole',date,mat:'Mata 1',status:'open',selfEntry:true,...extra}).id;
 const status=(id,name,date,s)=>run('demo-admin','tournament.save',{id,name,city:'Opole',date,mat:'Mata 1',status:s,selfEntry:true});
 const child=run('parent','athlete.save',{name:'Ola Test',birthDate:'2018-05-01',sex:'F',weight:30,height:130,gradeType:'cup',grade:9,club:{none:true},relation:'guardian'}).id;
 const enter=id=>run('parent','entry.self',{tournamentId:id,profileId:child,events:['forms']});
 const ids={open:tour('demo-admin','Otwarty','2030-06-20'),closed:tour('demo-admin','Zamknięty','2030-06-21'),present:tour('demo-admin','Obecna','2030-06-22'),absent:tour('demo-admin','Nieobecna','2030-06-23'),
  drawn:tour('demo-admin','Z losowaniem','2030-06-24'),finished:tour('demo-admin','Zakończony','2030-06-10'),hidden:tour('demo-admin','Ukryty','2030-06-25'),
  byOrganizer:tour('org-t','Społeczny','2030-06-26'),byAdmin:tour('demo-admin','Wycofany przez Admina','2030-06-27')};
 for(const id of Object.values(ids))enter(id);
 for(const [k,name,date] of [['closed','Zamknięty','2030-06-21'],['present','Obecna','2030-06-22'],['absent','Nieobecna','2030-06-23']])status(ids[k],name,date,'closed');
 run('demo-admin','checkin.save',{tournamentId:ids.present,id:child,presence:'present',actualWeight:31.5});
 run('demo-admin','checkin.save',{tournamentId:ids.absent,id:child,presence:'absent'});
 for(const [i,name] of ['Ala Pierwsza','Basia Druga','Celina Trzecia'].entries()){
  const pid=run('demo-admin','profile.save',{name,clubId:'club-1',birthDate:'2018-0'+(i+2)+'-01',sex:'F',weight:30,height:130,gradeType:'cup',grade:8,events:['forms']}).id;
  run('demo-admin','entry.save',{tournamentId:ids.drawn,profileId:pid,weight:30,height:130,gradeType:'cup',grade:8,events:['forms']});
 }
 run('demo-admin','draw.create',{tournamentId:ids.drawn,categoryId:classify({...CHILD,age:12},'forms').id});
 status(ids.finished,'Zakończony','2030-06-10','finished');
 run('demo-admin','tournament.hide',{tournamentId:ids.hidden,hidden:true,reason:'Sprawdzamy'});
 run('org-t','entry.remove',{tournamentId:ids.byOrganizer,id:child});
 run('demo-admin','entry.remove',{tournamentId:ids.byAdmin,id:child});
 return {db,ids,child};
}
const S=scenario();
const cards=html=>Object.fromEntries(String(html).split('<article class="panel ath-card').slice(1).map(c=>[text(c.match(/<h3[^>]*>(.*?)<\/h3>/)[1]),c]));

test('"Moje starty": the card of every status (§7.6) including paused, withdrawn by the organizer and by the Administrator',()=>{
 const view=athleteView(S.db,{id:'parent'},TODAY),html=flow.startsHtml(view,{today:TODAY}),by=cards(html);
 assert.ok(html instanceof SafeHtml);
 const status=name=>text(by[name].match(/<p class="ath-status[^"]*">(.*?)<\/p>/)[1]);
 assert.equal(status('Otwarty'),'Zgłoszenie przyjęte');
 assert.equal(status('Zamknięty'),'Zapisy zamknięte — czekaj na kontrolę startową');
 assert.equal(status('Obecna'),'Obecność potwierdzona · waga 31,5 kg');
 assert.equal(status('Nieobecna'),'Nieobecna na kontroli startowej','the Polish form follows the athlete');
 assert.equal(status('Zakończony'),'Turniej zakończony');
 assert.equal(status('Ukryty'),'Turniej wstrzymany');assert.match(text(by.Ukryty),/Organizator lub Administrator wstrzymał ten turniej\. Twoje zgłoszenie zostaje zapisane\./);
 assert.ok(!/Sprawdzamy|Opole|Układy/.test(by.Ukryty),'a paused tournament shows only its name and date');
 // canWithdraw / canEdit come from the server: an open tournament allows both, a closed one and a saved draw neither.
 const buttons=name=>[/data-action="athlete-edit"/.test(by[name]),/data-action="athlete-withdraw"/.test(by[name])];
 assert.deepEqual(buttons('Otwarty'),[true,true]);
 for(const name of ['Zamknięty','Obecna','Nieobecna','Z losowaniem','Zakończony','Ukryty'])assert.deepEqual(buttons(name),[false,false],name);
 assert.match(by['Zamknięty'],/Zapisy są zamknięte\. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej\./);
 // A saved draw: the line of the own fight and the read-only bracket with the own slot (ui.bracket highlight).
 const item=view.entries.find(e=>e.tournament.id===S.ids.drawn),c=item.categories[0];
 assert.equal(c.drawn,true);assert.ok(Number.isInteger(c.position.slot));
 assert.match(by['Z losowaniem'],new RegExp('<div class="bracket-stub" data-code="'+c.code+'" data-highlight="'+c.position.slot+'"></div>'));
 assert.match(text(by['Z losowaniem']),new RegExp(flow.positionText(data.positionStatus(c),'F').replace(/[()]/g,'\\$&')));
 // Tombstones: who withdrew the entry.
 const gone=text(String(html).split('id="ath-gone-title"')[1].split('</section>')[0]);
 assert.match(gone,/Społeczny .*Zgłoszenie wycofane przez organizatora/);assert.match(gone,/Wycofany przez Admina .*Zgłoszenie wycofane przez Administratora/);
 // Coming starts first, nearest first; the finished one after them.
 assert.deepEqual(Object.keys(by),['Otwarty','Zamknięty','Obecna','Nieobecna','Z losowaniem','Ukryty','Zakończony']);
 inLanguage('en',()=>{const en=cards(flow.startsHtml(view,{today:TODAY}));assert.match(text(en.Obecna),/Attendance confirmed · weight 31\.5 kg/);assert.match(text(en.Ukryty),/Tournament paused/);});
});

test('statuses, draw lines and tombstone texts; the withdraw question (§7.3)',()=>{
 const st=(item)=>data.entryStatus(item).code;
 assert.equal(st({tournament:{available:false,status:'open'},entry:{}}),'paused');
 assert.equal(st({tournament:{available:true,status:'finished'},entry:{presence:'present'}}),'finished');
 assert.equal(st({tournament:{available:true,status:'closed'},entry:{presence:'absent'}}),'absent');
 assert.deepEqual(data.entryStatus({tournament:{available:true,status:'closed'},entry:{presence:'present',actualWeight:44.2,weight:45}}),{code:'present',weight:44.2});
 assert.equal(st({tournament:{available:true,status:'closed'},entry:{presence:'pending'}}),'closed');
 assert.equal(st({tournament:{available:true,status:'open'},entry:{presence:'pending'}}),'accepted');
 const line=(status,opponent=null)=>flow.positionText(data.positionStatus({position:{slot:2,round:1,match:3,status,opponent}}),'M');
 assert.equal(line('next',{initials:'J. K.',club:'TKD Warszawa'}),'Losowanie: walka 3, runda 1, przeciwnik J. K. (TKD Warszawa)');
 assert.equal(line('next',{initials:'J. K.',club:null}),'Losowanie: walka 3, runda 1, przeciwnik J. K.','an unverified club is not shown');
 assert.equal(line('next',{initials:'J. K.',club:''}),'Losowanie: walka 3, runda 1, przeciwnik J. K. (Niezrzeszony)');
 assert.equal(line('waiting'),'Losowanie: walka 3, runda 1, przeciwnik jeszcze nieznany');
 assert.equal(line('bye'),'Wolny los · następna walka 3, runda 1');assert.equal(line('won'),'Wygrana · następna walka 3, runda 1');
 assert.equal(line('lost'),'Porażka');assert.equal(line('champion'),'Zwycięzca kategorii');assert.equal(data.positionStatus({position:null}),null);
 assert.deepEqual(['organizer','admin','system'].map(flow.withdrawnText),['Zgłoszenie wycofane przez organizatora','Zgłoszenie wycofane przez Administratora','Zgłoszenie wycofane, bo turniej odwołano']);
 assert.equal(flow.withdrawQuestion('Puchar Zimy 2027'),'Wycofać zgłoszenie z Puchar Zimy 2027? Po zamknięciu zapisów nie zgłosisz się ponownie.');
 inLanguage('en',()=>{assert.equal(flow.withdrawnText('admin'),'Entry withdrawn by the Administrator');assert.equal(line('champion'),'Category winner');assert.match(flow.withdrawQuestion('X'),/^Withdraw the entry from X\?/);});
});

test('open tournaments: enter, entered, minor-untrusted explanation, community badge and organizer; menu badge for 7 days',()=>{
 const view={profiles:[{id:'p1',name:'Ola',archived:false,club:{},sex:'F'}],entries:[],withdrawn:[],open:[
  {id:'a',name:'Staff',city:'Opole',date:'2030-06-20',community:false,trusted:true,organizer:null,profiles:[{id:'p1',entered:false,blocked:null}],drawn:[]},
  {id:'b',name:'Społeczny',city:'Opole',date:'2030-06-21',community:true,trusted:false,organizer:{n:'Ula U.'},profiles:[{id:'p1',entered:false,blocked:'minor-untrusted'}],drawn:[]},
  {id:'c',name:'Zgłoszony',city:'Opole',date:'2030-06-22',community:true,trusted:true,organizer:null,profiles:[{id:'p1',entered:true,blocked:null}],drawn:[]}]};
 const html=String(flow.startsHtml(view,{today:TODAY})),rows=Object.fromEntries(html.split('<article class="ath-open"').slice(1).map(r=>[text(r.match(/<h3[^>]*>(.*?)<\/h3>/)[1]),r]));
 assert.match(rows.Staff,/data-action="athlete-enter" data-id="a" data-profile="p1" aria-label="Zgłoś się: Staff">Zgłoś się</);
 assert.ok(!/athlete-enter/.test(rows['Społeczny']));assert.match(text(rows['Społeczny']),/Turniej społeczności Organizator niepotwierdzony Organizator: Ula U\. .*Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora\./);
 assert.match(text(rows['Zgłoszony']),/Na liście zgłoszeń/);assert.ok(!/athlete-enter/.test(rows['Zgłoszony']));
 assert.ok(!/athlete-enter/.test(String(flow.startsHtml(view,{today:TODAY,selfEntry:false}))),'features.selfEntry false: no enter buttons');
 assert.ok(!/Dodaj zawodnika|Dodaj kolejnego/.test(html)&&!/athlete-profile/.test(html),'one athlete per account: no "add another" and no switcher');
 const entries=[['2030-06-15','open',true],['2030-06-21','closed',true],['2030-06-22','open',true],['2030-06-14','open',true],['2030-06-18','finished',true],['2030-06-16','draft',false]].map(([date,status,available])=>({tournament:{date,status,available}}));
 assert.equal(data.upcomingCount({entries},TODAY),2,'today and the 21st; not the 22nd, the past, finished or paused');
 assert.equal(data.addDays('2030-12-29',7),'2031-01-05');
});

test('call to action in a member preview: add data, enter, entered, blocked, unavailable with the reason',()=>{
 const view={profiles:[{id:'p1',name:'Ola'}],entries:[{profileId:'p1',tournament:{id:'x'},canEdit:true}],open:[{id:'o',profiles:[{id:'p1',entered:false,blocked:null}]},{id:'m',profiles:[{id:'p1',entered:false,blocked:'minor-untrusted'}]}]};
 // A member without a profile is asked for the athlete's data only where a self-entry is possible (the open list of the route).
 assert.deepEqual(data.ctaFor({open:[{id:'o',profiles:[]}]},'o',{athlete:false}),{kind:'add'});
 assert.equal(data.ctaFor({open:[{id:'o',profiles:[]}]},'off',{athlete:false}),null,'open, but without self-entries: no call to action');
 assert.equal(data.ctaFor(null,'o',{athlete:false}),null,'no open list (the request failed): no call to action');
 assert.deepEqual(data.ctaFor(view,'o',{athlete:true}),{kind:'enter',profileId:'p1'});
 assert.deepEqual(data.ctaFor(view,'x',{athlete:true}),{kind:'entered',profileId:'p1',canEdit:true});
 assert.deepEqual(data.ctaFor(view,'m',{athlete:true}),{kind:'blocked',reason:'minor-untrusted'});
 assert.deepEqual(data.ctaFor(view,'z',{athlete:true}),{kind:'unavailable'});assert.equal(data.ctaFor(view,'o',{athlete:true,selfEntry:false}),null);
 assert.deepEqual([{status:'finished',date:'2030-01-01'},{status:'closed',date:'2030-07-01'},{status:'open',date:'2030-01-01'},{status:'open',date:'2030-07-01'},null].map(x=>data.unavailableReason(x,TODAY)),['finished','closed','closed','off','closed']);
 // An open list cut at OPEN_LIMIT does not prove that self-entries are off.
 const many={open:Array.from({length:50},(_,i)=>({id:'t'+i,profiles:[]}))};assert.equal(data.openTruncated(many),true);assert.equal(data.openTruncated(view),false);assert.equal(data.openTruncated(null),false);
 assert.deepEqual([{status:'open',date:'2030-07-01'},{status:'closed',date:'2030-07-01'},{status:'finished',date:'2030-07-01'}].map(x=>data.unavailableReason(x,TODAY,{truncated:true})),['later','closed','finished']);
 assert.equal(data.ctaFor(many,'beyond',{athlete:false}),null);
 assert.match(text(flow.ctaHtml({kind:'unavailable'},'z',{reason:'later'})),/Tego turnieju nie ma jeszcze na Twojej liście „Otwarte turnieje”\./);
 assert.doesNotMatch(text(flow.ctaHtml({kind:'unavailable'},'z',{reason:'later'})),/nie włączył/);
 const add=String(flow.ctaHtml({kind:'add'},'t<1>'));assert.match(add,/href="#profile\?tab=roles&amp;add=1&amp;then=t%3C1%3E">Dodaj dane zawodnika, aby się zgłosić</);
 assert.match(text(flow.ctaHtml({kind:'enter',profileId:'p1'},'o',{view})),/Zapisy są otwarte Zgłoś zawodnika: Ola\..*Zgłoś się/);
 assert.match(String(flow.ctaHtml({kind:'entered',profileId:'p1',canEdit:true},'x',{view})),/Zgłoszenie przyjęte: Ola.*data-action="athlete-edit".*href="#starts">Moje starty</s);
 assert.match(text(flow.ctaHtml({kind:'unavailable'},'z',{reason:'off'})),/Organizator nie włączył samodzielnych zgłoszeń\./);
 assert.match(text(flow.ctaHtml({kind:'unavailable'},'z',{reason:'closed'})),/Zapisy do tego turnieju są zamknięte\./);
 assert.equal(String(flow.ctaHtml(null,'z')),'');
});

test('athlete-entry body: listed fields only, numbers, events in engine order, update only for a correction',()=>{
 assert.deepEqual(data.entryBody({tournamentId:'t',profileId:'p',events:['special','forms','bogus'],weight:'30.5',height:'130',gradeType:'cup',grade:'9',saveToProfile:true,update:false,ownerId:'x'}),
  {tournamentId:'t',profileId:'p',events:['forms','special'],weight:30.5,height:130,gradeType:'cup',grade:9,saveToProfile:true});
 assert.equal(data.entryBody({tournamentId:'t',profileId:'p',events:[],weight:1,height:1,gradeType:'dan',grade:1,update:true}).update,true);
});

test('demo adapter: the athlete demo enters t-winter-2027, sees the entry, corrects it and withdraws it locally',async()=>{
 localStorage.clear();sessionStorage.clear();
 await Client.init();await Client.login('athlete@matdraw.example','MatDrawDemo2026!');
 let view=await Client.athleteRequest('athlete');
 assert.deepEqual(view.profiles.map(p=>[p.name,p.relation]),[['Zuzanna Demo','guardian']]);
 const open=view.open.find(t=>t.id==='t-winter-2027');assert.ok(open,'t-winter-2027 takes self-entries');assert.deepEqual(open.profiles.map(p=>[p.entered,p.blocked]),[[false,null]]);
 const pid=view.profiles[0].id,options=data.eventOptions(view.profiles[0],data.measuresOf(view.profiles[0]),open);
 const events=data.chosenEvents(options,['forms','soft']);assert.deepEqual(events,['forms']);
 const r=await Client.athleteRequest('athlete-entry',data.entryBody({tournamentId:'t-winter-2027',profileId:pid,events,...data.measuresOf(view.profiles[0]),saveToProfile:true}));
 assert.equal(r.ok,true);assert.equal(r.entry.tournament.id,'t-winter-2027');assert.deepEqual(r.entry.entry.events,['forms']);assert.equal(r.entry.canWithdraw,true);
 await assert.rejects(Client.athleteRequest('athlete-entry',data.entryBody({tournamentId:'t-winter-2027',profileId:pid,events,...data.measuresOf(view.profiles[0])})),e=>e.status===409&&e.message==='Jesteś już zgłoszony do tego turnieju.');
 const fixed=await Client.athleteRequest('athlete-entry',data.entryBody({tournamentId:'t-winter-2027',profileId:pid,events,...data.measuresOf(view.profiles[0]),weight:43,saveToProfile:false,update:true}));
 assert.equal(fixed.entry.entry.weight,43);
 view=await Client.athleteRequest('athlete');assert.equal(view.profiles[0].weight,42,'saveToProfile false keeps the profile');assert.equal(view.profiles[0].locked,true);
 assert.equal(data.ctaFor(view,'t-winter-2027',{athlete:true}).kind,'entered');
 await assert.rejects(Client.athleteRequest('athlete-withdraw',{tournamentId:'t-winter-2027',profileId:'someone-else'}),e=>e.status===404);
 assert.deepEqual(await Client.athleteRequest('athlete-withdraw',{tournamentId:'t-winter-2027',profileId:pid}),{ok:true});
 view=await Client.athleteRequest('athlete');assert.equal(view.entries.length,0);assert.equal(view.withdrawn.length,0,'an own withdrawal leaves no tombstone');
 assert.equal(view.open.find(t=>t.id==='t-winter-2027').profiles[0].entered,false);
 assert.equal((await Client.athleteRequest('public-clubs')).unaffiliated,'unaffiliated');
 await assert.rejects(Client.athleteRequest('bogus'),e=>e.status===400);
 // A member without an athlete profile (the demo organizer): the open list has t-winter-2027 (self-entries on) and not
 // t-autumn-2026 (open, self-entries off), so the preview asks for the athlete's data only in the first one.
 await Client.logout();await Client.login('organizer@matdraw.example','MatDrawDemo2026!');
 view=await Client.athleteRequest('athlete');assert.deepEqual(view.profiles,[]);assert.deepEqual(view.entries,[]);
 assert.ok(view.open.some(t=>t.id==='t-winter-2027'));assert.ok(!view.open.some(t=>t.id==='t-autumn-2026'));
 assert.deepEqual(data.ctaFor(view,'t-winter-2027',{athlete:false}),{kind:'add'});assert.equal(data.ctaFor(view,'t-autumn-2026',{athlete:false}),null);
 await Client.logout();await Client.login('editor@matdraw.example','MatDrawDemo2026!');
 await assert.rejects(Client.athleteRequest('athlete'),e=>e.status===403,'staff have no athlete view');
 await Client.logout();
});

test('registry: #starts for members with an athlete profile (workspace caps or a fresher me), nav global, order 15',async()=>{
 const {athleteUser}=await import('../dist/athlete-boot.js');
 const def=registry.page('starts');assert.equal(def.nav,'global');assert.equal(def.order,15);assert.deepEqual(def.roles,['member']);
 assert.equal(registry.allows(def,'member',{role:'member',caps:{athlete:true}}),true);assert.equal(registry.allows(def,'member',{role:'member',caps:{athlete:false}}),false);
 assert.equal(athleteUser({id:'u',role:'member',caps:{athlete:false}},{user:{id:'u',caps:{athlete:true}}}),true,'me knows the new profile before the workspace');
 assert.equal(athleteUser({id:'u',role:'member',caps:{athlete:false}},{user:{id:'v',caps:{athlete:true}}}),false,'never another person\'s me');
 assert.equal(athleteUser({id:'u',role:'admin',caps:{athlete:true}}),false);
});

// ---- Browser checks ----
let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.ico':'image/x-icon'};
/** Static server of dist/; api (optional) answers /api/index.php and switches runtime-config.js to the API mode. */
const serve=api=>new Promise(resolve=>{
 const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');let p=decodeURIComponent(u.pathname);if(p.endsWith('/'))p+='index.html';
  if(api&&p==='/api/index.php'){let body='';for await(const c of req)body+=c;const [status,out]=api(u.searchParams.get('route'),req.method,body?JSON.parse(body):null);res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(out));return;}
  if(api&&p==='/runtime-config.js'){res.writeHead(200,{'Content-Type':TYPES['.js'],'Content-Security-Policy':CSP});res.end("export const CONFIG={mode:'api',apiBase:'./api/index.php'};");return;}
  if(p==='/sw.js'){res.writeHead(404);res.end();return;}
  try{const body=await readFile(join(DIST,normalize(p).replace(/^(\.\.[\/\\])+/,'')));res.writeHead(200,{'Content-Type':TYPES[extname(p)]||'application/octet-stream','Content-Security-Policy':CSP});res.end(body);}
  catch{res.writeHead(404);res.end();}
 }).listen(0,'127.0.0.1',()=>resolve({server,url:'http://127.0.0.1:'+server.address().port+'/'}));
});
/** Controls in root without an accessible name (Playwright's accessibility snapshot of the page). */
async function unnamed(page,selector){
 const snap=await page.locator(selector).ariaSnapshot();
 return snap.split('\n').filter(l=>/^\s*- (button|checkbox|textbox|spinbutton|combobox|radio|link)\b/.test(l)&&!/^\s*- \w+ "[^"]+"/.test(l)&&!/^\s*- link:/.test(l));
}
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
/** Adds three staff athletes to the child's category of t-winter-2027 and saves a draw (demo data in localStorage). */
async function drawWinter(page){
 await page.evaluate(async()=>{
  const W=await import('./workspace.js'),E=await import('./engine.js');let db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));
  const run=(type,p)=>{const r=W.execute(db,'demo-admin',type,p);db=r.db;return r.result;};
  for(const [i,name] of ['Ala Pierwsza','Basia Druga','Celina Trzecia'].entries()){const id=run('profile.save',{name,clubId:db.clubs[i%2].id,birthDate:'2012-0'+(i+2)+'-01',sex:'F',weight:42,height:150,gradeType:'cup',grade:8,events:['forms']}).id;
   run('entry.save',{tournamentId:'t-winter-2027',profileId:id,weight:42,height:150,gradeType:'cup',grade:8,events:['forms']});}
  const c=E.classify({age:14,sex:'F',gradeType:'cup',grade:7,weight:42,height:152},'forms');run('draw.create',{tournamentId:'t-winter-2027',categoryId:c.id});
  localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));
 });
}

test('demo in a browser (PL 1440, EN 390): #starts, the entry window by keyboard, names of every control, a draw with the own slot, withdraw',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:240000},async()=>{
 const {server,url}=await serve(),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  for(const [w,hh,lang] of [[1440,900,'pl'],[390,844,'en']]){
   const ctx=await browser.newContext({viewport:{width:w,height:hh},locale:lang==='pl'?'pl-PL':'en-GB',serviceWorkers:'block'});
   await ctx.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));});
   const page=await ctx.newPage();page.on('pageerror',e=>problems.push(w+': '+e.message));page.on('console',m=>{if(m.type()==='error')problems.push(w+': '+m.text());});
   await page.goto(url);await page.click('[data-action="demo-login"][data-role="athlete"]');await page.waitForSelector('.app-shell');
   // Phones: the member lands in the full-screen chat, whose own button opens the menu.
   if(w<800)await page.click('.chat-back[data-action="menu"]');
   await page.locator('[data-page="starts"]').filter({visible:true}).first().click();await page.waitForSelector('.ath-profile');
   assert.equal(await page.locator('h1').innerText(),lang==='pl'?'Moje starty':'My competitions');
   assert.equal(await page.locator('.ath-profile h2').innerText(),'Zuzanna Demo');
   assert.deepEqual(await unnamed(page,'#main'),[],'every control of #starts has a name');
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-starts-root],[data-starts-root] *')].some(el=>[...el.attributes].some(a=>/2012-03-08|"birthDate"/.test(a.value)))),false,'the view (birth date) is not copied into attributes');
   assert.equal(await page.getAttribute('[data-starts-root]','data-ath-key'),null);
   // The entry window, opened and filled by keyboard.
   await page.locator('.ath-open [data-action="athlete-enter"][data-id="t-winter-2027"]').focus();await page.keyboard.press('Enter');
   await page.waitForSelector('#ath-entry-form');
   assert.equal(await page.locator('#ath-entry-form input[name="events"][value="soft"]').count(),0,'an ineligible event is text, not a field');
   assert.match(await page.locator('#ath-ev-soft').innerText(),lang==='pl'?/Niedostępne: Konkurencja niedostępna w tej grupie wieku/:/Not available: Event not available in this age group/);
   assert.ok((await page.getAttribute('[data-ath-events-box]','aria-describedby')).split(' ').includes('ath-ev-soft'));
   assert.deepEqual(await unnamed(page,'.modal'),[],'every control of the entry window has a name');
   const snap=await page.locator('.modal').ariaSnapshot();
   assert.match(snap,lang==='pl'?/checkbox "Układy formalne Juniorki młodsze · kobiety · 10–7 Cup"/:/checkbox "Patterns Younger juniors · female · 10th–7th Gup"/);
   assert.match(snap,lang==='pl'?/checkbox "Zapisz też w profilu/:/checkbox "Also save in the profile/);
   await page.locator('#ath-entry-form input[value="forms"]').focus();await page.keyboard.press('Space');
   await page.waitForFunction(()=>/10/.test(document.querySelector('[data-ath-preview]').textContent));
   assert.match(await page.locator('[data-ath-preview]').innerText(),lang==='pl'?/Juniorki młodsze · kobiety · 10–7 Cup/:/Younger juniors · female · 10th–7th Gup/);
   await page.fill('#ath-entry-form [name="grade"]','5');await page.waitForFunction(()=>/6–3|6th–3rd/.test(document.querySelector('[data-ath-preview]').textContent));
   assert.equal(await page.isChecked('#ath-entry-form input[value="forms"]'),true,'a measure change keeps the ticks');
   await page.fill('#ath-entry-form [name="grade"]','7');
   assert.equal(await overflow(page),0,'no horizontal scroll with the window open');
   await page.click('.modal-actions button[type="submit"]');await page.waitForSelector('.ath-card');
   assert.match(await page.locator('.ath-card .ath-status').innerText(),lang==='pl'?/Zgłoszenie przyjęte/:/Entry accepted/);
   assert.equal(await page.locator('.ath-card [data-action="athlete-withdraw"]').count(),1);
   // The member preview of the same tournament says the athlete is entered.
   await page.goto(url+'#guest?t=t-winter-2027');await page.waitForSelector('.ath-cta-done');
   assert.match(await page.locator('.ath-cta').innerText(),lang==='pl'?/Zgłoszenie przyjęte: Zuzanna Demo/:/Entry accepted: Zuzanna Demo/);
   assert.deepEqual(await unnamed(page,'.ath-cta'),[]);
   // A saved draw: the own slot is marked in the read-only bracket; no withdraw any more.
   await drawWinter(page);await page.goto(url+'#starts');await page.reload();await page.waitForSelector('.ath-card .ath-bracket');
   assert.equal(await page.locator('.ath-card .fighter.is-own').count(),1,'the own slot');
   assert.equal(await page.locator('.ath-card [data-action="athlete-withdraw"]').count(),0,'in a saved draw only the organizer withdraws');
   assert.match(await page.locator('.ath-pos').innerText(),lang==='pl'?/Losowanie: walka|Wolny los/:/Draw: fight|Bye/);
   assert.equal(await overflow(page),0,'no horizontal scroll with a bracket');
   // Withdraw after the draw is gone: reset the draw in the demo data, confirm in the dialog.
   await page.evaluate(()=>{const db=JSON.parse(localStorage.getItem('matdraw.workspace.v2'));db.tournaments.find(t=>t.id==='t-winter-2027').draws={};localStorage.setItem('matdraw.workspace.v2',JSON.stringify(db));});
   await page.reload();await page.waitForSelector('.ath-card [data-action="athlete-withdraw"]');
   await page.click('.ath-card [data-action="athlete-withdraw"]');await page.waitForSelector('[data-action="athlete-withdraw-confirm"]');
   assert.match(await page.locator('.modal-body').innerText(),lang==='pl'?/Wycofać zgłoszenie z Puchar Zimy 2027\? Po zamknięciu zapisów nie zgłosisz się ponownie\./:/Withdraw the entry from Puchar Zimy 2027\?/);
   await page.click('[data-action="athlete-withdraw-confirm"]');await page.waitForSelector('.ath-empty');
   assert.equal(await page.locator('.ath-card').count(),0);
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('matdraw.workspace.v2')).tournaments.find(t=>t.id==='t-winter-2027').entries.some(e=>e.profileId==='demo-athlete-child')),false,'withdrawn in the local demo data');
   assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
   if(lang==='pl')await page.click('[data-set-lang="pl"]');
   await ctx.close();
  }
  // A member without an athlete profile (the demo organizer): "add athlete data" only where self-entries are on.
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();
  page.on('pageerror',e=>problems.push('organizer: '+e.message));page.on('console',m=>{if(m.type()==='error')problems.push('organizer: '+m.text());});
  await page.goto(url);await page.click('[data-action="demo-login"][data-role="organizer"]');await page.waitForSelector('.app-shell');
  await page.goto(url+'#guest?t=t-winter-2027');await page.waitForSelector('.ath-cta');
  assert.match(await page.locator('.ath-cta').innerText(),/Dodaj dane zawodnika, aby się zgłosić/);
  await page.goto(url+'#guest?t=t-autumn-2026');await page.waitForSelector('.guest-stats [data-athlete-cta], [data-athlete-cta]',{state:'attached'});await page.waitForTimeout(500);
  assert.equal(await page.locator('.ath-cta').count(),0,'t-autumn-2026 is open without self-entries: no call to action');
  await ctx.close();
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});

test('API mode in a browser: 402 of athlete-entry leads to #billing; a correction without new events is sent with update:true',{skip:!chromium&&'MATDRAW_BROWSER_TESTS=1 and Playwright needed',timeout:120000},async()=>{
 const caps={organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:true};
 const user={id:'u-ath',clubId:null,email:'ath@example.test',role:'member',active:true,caps};
 const ws={schemaVersion:2,revision:3,user,clubs:[],users:[],profiles:[],tournaments:[]};
 const profile={id:'p1',name:'Adam Własny',birthDate:'1998-04-02',sex:'M',weight:70,height:178,gradeType:'cup',grade:5,club:{id:'c1',name:'Klub Testowy',verified:true,unaffiliated:false,pending:null},relation:'self',archived:false,minor:false,locked:true};
 const entry={profileId:'p1',tournament:{id:'t2',name:'Turniej Zgłoszony',city:'Opole',date:'2099-05-02',status:'open',available:true,community:false,trusted:true},entry:{events:['forms'],weight:70,height:178,gradeType:'cup',grade:5,age:101,club:{id:'c1',name:'Klub Testowy',verified:true,unaffiliated:false},presence:'pending',actualWeight:null},canWithdraw:true,canEdit:true,categories:[]};
 const view={profiles:[profile],entries:[entry],withdrawn:[],open:[{id:'t1',name:'Turniej Płatny',city:'Opole',date:'2099-05-01',community:false,trusted:true,organizer:null,profiles:[{id:'p1',entered:false,blocked:null}],drawn:[]},{id:'t2',name:'Turniej Zgłoszony',city:'Opole',date:'2099-05-02',community:false,trusted:true,organizer:null,profiles:[{id:'p1',entered:true,blocked:null}],drawn:[]}]};
 const sent=[];
 const api=(route,method,body)=>{
  if(route==='session')return [200,{user,csrf:'c1'}];
  if(route==='bootstrap')return [200,ws];
  if(route==='me')return [200,{user,profile:{publicId:'Ath000000001',username:'adam',firstName:'Adam',lastName:'W',sports:['taekwondo'],country:'PL',complete:true,showClub:false,nameDisplay:'initial',avatar:null,mustChangePassword:false},access:{full:false,state:'none',until:null,canPost:false,block:null,mutedUntil:null},billing:{enabled:true,enforce:true},features:{signup:true,signupMode:'paid',selfEntry:true,chat:true,avatars:false},athletes:[{profileId:'p1',name:'Adam Własny',relation:'self',archived:false}]}];
  if(route==='athlete')return [200,view];
  if(route==='athlete-entry'){sent.push(body);return body.update?[200,{ok:true,entry}]:[402,{error:'Zgłoszenia do turniejów wymagają aktywnego konta.'}];}
  if(route==='public-config')return [200,{signup:true,signupMode:'paid',billing:true,amounts:{pln:899,usd:299},avatars:false,support:'hello@matbravo.com',roles:true}];
  return [404,{error:'Nie ma takiej operacji.'}];};
 const {server,url}=await serve(api),browser=await chromium.launch().catch(e=>{server.close();throw e;}),problems=[];
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'pl-PL',serviceWorkers:'block'}),page=await ctx.newPage();page.on('pageerror',e=>problems.push(e.message));
  await page.goto(url+'#starts');await page.waitForSelector('.ath-card');
  // A correction of the own entry (no new events) works without full access (R12).
  await page.click('.ath-card [data-action="athlete-edit"]');await page.waitForSelector('#ath-entry-form[data-update="yes"]');
  await page.fill('#ath-entry-form [name="weight"]','71');await page.click('.modal-actions button[type="submit"]');await page.waitForSelector('.modal',{state:'detached'});
  assert.deepEqual(sent.at(-1),{tournamentId:'t2',profileId:'p1',events:['forms'],weight:71,height:178,gradeType:'cup',grade:5,saveToProfile:true,update:true});
  // A new entry in paid mode without full access: 402 -> the payment prompt (#billing).
  await page.click('.ath-open [data-action="athlete-enter"][data-id="t1"]');await page.waitForSelector('#ath-entry-form');
  await page.check('#ath-entry-form input[value="forms"]');await page.click('.modal-actions button[type="submit"]');
  await page.waitForFunction(()=>location.hash.startsWith('#billing'));
  assert.equal(sent.at(-1).update,undefined);assert.equal(await page.locator('#ath-entry-form').count(),0,'the window is closed');
  await ctx.close();
  assert.deepEqual(problems,[]);
 }finally{await browser.close();server.close();}
});
