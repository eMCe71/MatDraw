/* Demo chat (plan §5.4, §8.8): the same interface as chat-transport.js, backed by localStorage['matdraw.chat.demo.v2'] in this browser.
 * The global channels of the catalogue (sports.js LOBBY: a general channel per martial art and one per federation, ids 1… in its
 * order), a few fictional messages in most of them (some stay empty, as a new channel would be) and in the first upcoming demo
 * tournament; the demo accounts write at once (complete profiles from me.js). Other tabs learn about changes from the 'storage' event
 * instead of polling. Guests get the same guest projection as on the server (no people, decoration variant g), signed-in demo
 * accounts the member projection. v1 (the PL/world channels before 2026-11-10) is dropped. */
import {cleanText} from './profile-data.js';
import {DEFAULT_CFG,normalizeCfg} from './chat-transport.js';
import {LOBBY} from './sports.js';

export const KEY='matdraw.chat.demo.v2';
const OLD_KEY='matdraw.chat.demo.v1';
const PEOPLE={
 DemoMarta001:{n:'Marta K.',u:'marta.k',cc:'PL',sp:['taekwondo','karate'],club:'KS Tygrys Kraków',av:null,mod:false,since:'2026-09'},
 DemoTomek001:{n:'Tomasz W.',u:'tomek.w',cc:'PL',sp:['taekwondo'],club:'UKS Smok Gdańsk',av:null,mod:false,since:'2026-10'},
 DemoLiam0001:{n:'Liam O.',u:'liam.tkd',cc:'IE',sp:['taekwondo'],club:'Dublin ITF',av:null,mod:false,since:'2026-08'},
 DemoAiko0001:{n:'Aiko S.',u:'aiko.s',cc:'JP',sp:['karate'],club:null,av:null,mod:false,since:'2026-10'},
 DemoJonas001:{n:'Jonas B.',u:'jonas.b',cc:'DE',sp:['karate','judo'],club:'Karate Team Berlin',av:null,mod:false,since:'2026-07'},
 DemoEwa00001:{n:'Ewa N.',u:'ewa.n',cc:'PL',sp:['kickboxing'],club:null,av:null,mod:false,since:'2026-10'},
 DemoAdmin001:{n:'Anna D.',u:'anna.demo',cc:'PL',sp:['taekwondo'],club:null,av:null,mod:true,since:'2026-10'},
 DemoKuba0001:{n:'Kuba R.',u:'kuba.boks',cc:'PL',sp:['boxing'],club:'KB Ring Łódź',av:null,mod:false,since:'2026-09'},
 DemoOla00001:{n:'Ola P.',u:'ola.judo',cc:'PL',sp:['judo'],club:'AZS Judo Poznań',av:null,mod:false,since:'2026-08'},
 DemoRafa0001:{n:'Rafael M.',u:'rafa.bjj',cc:'BR',sp:['bjj'],club:'Gracie Barra Wrocław',av:null,mod:false,since:'2026-10'},
 DemoNok00001:{n:'Nok T.',u:'nok.muaythai',cc:'TH',sp:['muaythai'],club:null,av:null,mod:false,since:'2026-07'},
 DemoPiotr001:{n:'Piotr S.',u:'piotr.mma',cc:'PL',sp:['mma','bjj'],club:'Fight Club Katowice',av:null,mod:false,since:'2026-10'}
};
const SEED={
 'taekwondo-pl':[['DemoMarta001','Cześć wszystkim! Ktoś jedzie w sobotę na Puchar Jesieni?'],['DemoTomek001','My jedziemy całą sekcją, 14 zawodników.'],['DemoTomek001','Ważenie od 7:30, warto być wcześniej.'],['DemoEwa00001','Czy kategorie juniorów są już rozpisane?'],['DemoMarta001','Tak, drabinki są w podglądzie turnieju.'],['DemoAdmin001','Przypominam: nie publikujemy danych dzieci ani numerów telefonów.'],['DemoTomek001','Dzięki! Do zobaczenia na macie.'],['DemoMarta001','Powodzenia wszystkim startującym!']],
 'taekwondo-itf':[['DemoLiam0001','Hi all, anyone travelling to the Warsaw open in November?'],['DemoMarta001','Yes! Our club is coming with 10 athletes.'],['DemoLiam0001','Great, see you there. Is the venue close to the station?'],['DemoMarta001','About 15 minutes by tram.'],['DemoJonas001','Rules summary is on https://example.org/rules if anyone needs it.'],['DemoLiam0001','Thanks Jonas.'],['DemoAiko0001','Good luck to everyone competing this weekend.'],['DemoLiam0001','Patterns at 9:00, sparring after lunch.']],
 'karate-wkf':[['DemoAiko0001','Kata practice tonight, anyone joining online?'],['DemoJonas001','I can join after 19:00.'],['DemoAiko0001','Perfect, we start with Heian Shodan.'],['DemoJonas001','Do you know the kumite rules for juniors this season?'],['DemoAiko0001','Same as last year, two minutes per bout.'],['DemoEwa00001','Hello from Poland!'],['DemoJonas001','Welcome Ewa.'],['DemoAiko0001','See you on the mat.']],
 'taekwondo-wt':[['DemoTomek001','Czy na Pucharze Jesieni będą elektroniczne kamizelki?'],['DemoMarta001','Tak, organizator pisał, że cała walka na systemie elektronicznym.'],['DemoTomek001','To trzeba zabrać własne skarpety z czujnikami.'],['DemoAdmin001','Szczegóły sprzętu są w regulaminie turnieju.'],['DemoMarta001','Dzięki, sprawdzę przed wyjazdem.']],
 'taekwondo-uitf':[['DemoMarta001','Hej, czy ktoś startuje w układach na najbliższym turnieju?'],['DemoTomek001','My wystawiamy trzy osoby w juniorach.'],['DemoMarta001','Super, do zobaczenia!']],
 karate:[['DemoJonas001','Hallo from Berlin! Is anyone going to the seminar in December?'],['DemoAiko0001','I am! It is open to every style.'],['DemoEwa00001','Jaki sprzęt polecacie dla początkujących?'],['DemoJonas001','A good karategi and a mouth guard to start with.'],['DemoAiko0001','Welcome to the karate channel, everyone.']],
 'karate-kyokushin':[['DemoJonas001','Who is training for the knockdown tournament in spring?'],['DemoEwa00001','Ja! Trzy razy w tygodniu kondycja i kumite.'],['DemoJonas001','Respect. Osu!'],['DemoMarta001','Powodzenia, trzymamy kciuki.']],
 boxing:[['DemoKuba0001','Cześć! Ktoś zna dobrą salę sparingową w Łodzi?'],['DemoPiotr001','Sprawdź sparingi w sobotę rano, przyjmują gości.'],['DemoKuba0001','Dzięki! Ważenie przed galą jest dzień wcześniej?'],['DemoAdmin001','Godziny ważenia znajdziesz w regulaminie zawodów.'],['DemoKuba0001','Jasne, sprawdzę.'],['DemoEwa00001','Powodzenia na ringu!']],
 'boxing-worldboxing':[['DemoKuba0001','Ktoś startuje w turnieju juniorów w przyszłym miesiącu?'],['DemoPiotr001','Mój klub wystawia dwóch chłopaków.'],['DemoKuba0001','To do zobaczenia przy ringu.']],
 judo:[['DemoOla00001','Randori w piątek otwarte dla gości z innych klubów!'],['DemoJonas001','Great, I will be in Poznań that weekend.'],['DemoOla00001','Zapraszamy, start 18:00.'],['DemoMarta001','Czy dzieci też mogą przyjść?'],['DemoOla00001','Tak, grupa dziecięca ma osobną matę.']],
 kickboxing:[['DemoEwa00001','Witajcie! Szukam klubu kickboxingu w Krakowie.'],['DemoMarta001','Sprawdź sekcję przy naszym klubie, mają grupę początkującą.'],['DemoEwa00001','Dzięki, odezwę się do nich.'],['DemoPiotr001','Polecam też sparingi łączone z muay thai.']],
 bjj:[['DemoRafa0001','Open mat na sobotę: gi o 10:00, no-gi o 12:00.'],['DemoPiotr001','Będę na no-gi.'],['DemoRafa0001','Perfeito! See you there.'],['DemoOla00001','Czy początkujący mogą przyjść?'],['DemoRafa0001','Sim, każdy jest mile widziany.']],
 muaythai:[['DemoNok00001','Sawasdee! Wai kru workshop next Sunday.'],['DemoEwa00001','Brzmi super, czy trzeba się zapisać?'],['DemoNok00001','Yes, just send a message to the club.'],['DemoKuba0001','Ktoś ma polecane rękawice 12 oz?'],['DemoNok00001','Any leather pair that fits your hand well.']],
 'muaythai-ifma':[['DemoNok00001','Amateur rules: shin guards and elbow pads at the next event.'],['DemoEwa00001','Dzięki za info!']],
 mma:[['DemoPiotr001','Cześć! Ktoś startuje w amatorskiej lidze w tym sezonie?'],['DemoKuba0001','Zastanawiam się, robię teraz dużo zapasów.'],['DemoRafa0001','BJJ helps a lot on the ground.'],['DemoPiotr001','Zgadzam się, parter to podstawa.'],['DemoAdmin001','Pamiętajcie o badaniach lekarskich przed zawodami.']],
 'mma-immaf':[['DemoPiotr001','Czy ktoś zna nowe zasady ważenia na zawodach amatorskich?'],['DemoAdmin001','Organizator zawsze podaje je w regulaminie turnieju.'],['DemoPiotr001','Dzięki, sprawdzę.']]
};
const TOURNAMENT_SEED=[['DemoTomek001','Witamy na czacie turnieju! Pytania o harmonogram piszcie tutaj.'],['DemoMarta001','O której zaczyna się ważenie?'],['DemoTomek001','Ważenie 7:30–9:00, sala B.'],['DemoEwa00001','Czy jest parking przy hali?'],['DemoTomek001','Tak, bezpłatny, wjazd od ulicy Sportowej.'],['DemoLiam0001','Good luck everyone!'],['DemoMarta001','Dziękujemy organizatorom za świetne przygotowanie.'],['DemoTomek001','Wyniki pojawią się w podglądzie turnieju.']];

const hash=s=>{let x=2166136261;for(const c of String(s)){x^=c.codePointAt(0);x=Math.imul(x,16777619)>>>0;}return x;};
const day=ms=>new Date(ms).toISOString().slice(0,10);
function read(){try{const raw=localStorage.getItem(KEY);const v=raw?JSON.parse(raw):null;return v&&v.v===2?v:null;}catch{return null;}}
function write(db){try{localStorage.setItem(KEY,JSON.stringify(db));}catch{}}
function seedChannel(list,now,spread){const msgs=[];let prev=null;list.forEach(([u,b],i)=>{const t=now-(list.length-i)*spread-Math.round(hash(b)%60000);msgs.push({id:0,r:0,t,u,c:prev&&prev.u===u&&t-prev.t<300000?1:0,b});prev=msgs.at(-1);});return msgs;}
/** The demo database: created (and seeded) on first use. */
export function database(now=Date.now()){
 let db=read();if(db)return db;
 try{localStorage.removeItem(OLD_KEY);}catch{}
 db={v:2,next:1,channels:{},tours:{},seeded:null};
 LOBBY.forEach(({slug,sport,fed},i)=>{const id=String(i+1);const msgs=seedChannel(SEED[slug]||[],now-(i*900000),i%3===1?420000:1500000);db.channels[id]={kind:'lobby',slug,sport,fed,rev:0,msgs};});
 for(const ch of Object.values(db.channels))for(const m of ch.msgs){m.id=db.next++;m.r=++ch.rev;}
 write(db);return db;
}
const visibleCount=ch=>ch.msgs.filter(m=>!m.x).length;
function project(m,chId,member){
 if(member){const o={id:m.id,r:m.r,t:m.t,a:m.u};return m.x?{...o,x:m.x}:{...o,c:m.c,b:m.b};}
 const o={id:m.id,r:m.r,t:m.t,g:hash('ghost|'+day(m.t)+'|'+chId+'|'+m.u)%5};return m.x?{...o,x:m.x}:{...o,c:m.c,b:m.b};
}
const fail=(message,status,data={})=>Object.assign(new Error(message),{status,data});

/** Same interface as createTransport; opts adds me() (the signed-in demo person or null) and tournaments() (upcoming demo list). */
export function createDemoTransport(opts){
 const env={now:()=>Date.now(),setTimeout:(f,ms)=>setTimeout(f,ms),...opts.env};
 const cfg=normalizeCfg(DEFAULT_CFG),cursors=new Map(),heads=new Map();let stopped=false,cvSent=false,pending=false,lastSend=0;
 const member=()=>opts.mode()==='feed'&&!!opts.me?.();
 const meEntry=()=>{const me=opts.me?.(),p=me?.profile;if(!p)return null;const last=String(p.lastName||'').trim();
  return [p.publicId,{n:(String(p.firstName||'').trim()+(last?' '+(p.nameDisplay==='full'?last:last[0].toUpperCase()+'.'):'')).trim(),u:p.username||null,cc:p.country||null,sp:p.sports||[],club:p.showClub&&p.clubText?p.clubText:null,av:null,mod:me.user?.role==='admin',since:'2026-10'}];};
 const people=ids=>{const out={},own=meEntry();for(const pid of ids){if(own&&pid===own[0])out[pid]=own[1];else if(PEOPLE[pid])out[pid]=PEOPLE[pid];}return out;};
 /** One emulated poll for the current wants; null when nothing changed (204). */
 function answer(){
  const db=database(env.now()),w=opts.wants()||{},ch={},hd={},authors=new Set();
  for(const [id,cursor] of Object.entries(w.ch||{})){
   const c=db.channels[id];if(!c){ch[id]={st:'gone'};continue;}
   const st=c.kind==='tournament'&&c.date&&c.date<day(env.now())&&!member()?null:'open';if(!st){ch[id]={st:'gone'};continue;}
   if(!cursor){const page=c.msgs.slice(-50);ch[id]={rev:c.rev,st,more:false,older:c.msgs.length>50,m:page.map(m=>project(m,id,member()))};page.forEach(m=>authors.add(m.u));}
   else if(cursor<c.rev){const page=c.msgs.filter(m=>m.r>cursor).sort((a,b)=>a.r-b.r);ch[id]={rev:c.rev,st,more:false,m:page.map(m=>project(m,id,member()))};page.forEach(m=>authors.add(m.u));}
   cursors.set(id,c.rev);
  }
  for(const [id,[read,known]] of Object.entries(w.h||{})){
   const c=db.channels[id];if(!c){hd[id]={st:'gone'};continue;}
   const last=c.msgs.at(-1)?.id||0;if(last===known&&heads.get(id)===last)continue;heads.set(id,last);
   hd[id]={last,n:Math.min(100,c.msgs.filter(m=>m.id>read&&!m.x).length)};
  }
  if(!Object.keys(ch).length&&!Object.keys(hd).length&&cvSent)return null;
  const out={cv:1,ch,heads:hd};if(!cvSent){out.cfg=cfg;cvSent=true;}
  if(member())out.people=people(authors);
  return out;
 }
 function deliver(){if(pending||stopped)return;pending=true;env.setTimeout(()=>{pending=false;if(stopped)return;const data=answer();if(data)opts.onData?.(data,{});},0);}
 const onStorage=event=>{if(event.key===KEY||event.key===null)deliver();};
 try{globalThis.window?.addEventListener('storage',onStorage);}catch{}
 env.setTimeout(()=>{if(!stopped){opts.onStatus?.('live');deliver();}},0);
 function mutate(fn){const db=database(env.now());const out=fn(db);write(db);return out;}
 function find(db,messageId){for(const [id,c] of Object.entries(db.channels)){const m=c.msgs.find(x=>x.id===messageId);if(m)return [id,c,m];}return [];}
 return {
  id:'demo',leading:true,solo:true,get status(){return 'live';},get cfg(){return cfg;},get cv(){return 1;},get stopped(){return stopped;},
  update:deliver,poke:deliver,interact(){},
  async history(channel,before){
   const c=database(env.now()).channels[channel];if(!c)return {st:'gone'};
   const older=c.msgs.filter(m=>m.id<before),page=older.slice(-30);
   return {st:'open',older:older.length>30,m:page.map(m=>project(m,channel,member()))};
  },
  async lists(){
   const db=database(env.now()),today=day(env.now());let list=[];try{list=await opts.tournaments?.()||[];}catch{list=[];}
   const tours=[];
   mutate(d=>{
    for(const t of list){
     if(!d.tours[t.id]){const id=String(100+Object.keys(d.tours).length);d.tours[t.id]=id;d.channels[id]={kind:'tournament',tid:t.id,date:t.date,rev:0,msgs:[]};
      if(!d.seeded){d.seeded=t.id;const msgs=seedChannel(TOURNAMENT_SEED,env.now(),600000);for(const m of msgs){m.id=d.next++;m.r=++d.channels[id].rev;}d.channels[id].msgs=msgs;}}
     const c=d.channels[d.tours[t.id]];c.date=t.date;
     tours.push({id:Number(d.tours[t.id]),tournamentId:t.id,title:t.name,date:t.date,city:t.city,sport:t.sport||'taekwondo',fed:t.federation||null,st:t.date>=today?'open':'archive',last:c.msgs.at(-1)?.id||0,count:visibleCount(c)});
    }
   });
   const lobby=LOBBY.map(({slug,sport,fed},i)=>{const c=db.channels[String(i+1)];return {id:i+1,slug,sport,fed,last:c.msgs.at(-1)?.id||0,count:visibleCount(c),st:'open'};});
   return {cv:1,cfg,lobby,tournaments:member()?tours:tours.filter(t=>t.st==='open')};
  },
  async send(body){
   const me=opts.me?.();if(!me?.access?.canPost)throw fail('Ta funkcja wymaga aktywnej subskrypcji.',402);
   const b=cleanText(body?.b,{multiline:true});if(!b)throw fail('Wiadomość jest pusta.',422);
   if([...b].length>1000)throw fail('Wiadomość może mieć najwyżej 1000 znaków.',422);
   const now=env.now();if(now-lastSend<2000)throw fail('Wysyłasz wiadomości zbyt szybko. Spróbuj za chwilę.',429,{retry:2});
   const pid=meEntry()[0];
   const out=mutate(db=>{
    const id=body.ch!=null?String(body.ch):db.tours[body.t];const c=db.channels[id];if(!c)throw fail('Ten czat nie istnieje.',404);
    const old=c.msgs.find(m=>m.u===pid&&m.cid===body.cid);if(old)return {m:project(old,id,true),rev:old.r};
    const prev=c.msgs.at(-1),m={id:db.next++,r:++c.rev,t:now,u:pid,cid:body.cid,c:prev&&prev.u===pid&&!prev.x&&now-prev.t<300000?1:0,b};
    c.msgs.push(m);if(c.msgs.length>400)c.msgs.splice(0,c.msgs.length-400);return {m:project(m,id,true),rev:m.r};
   });
   lastSend=now;const own=meEntry();return {...out,people:{[own[0]]:own[1]}};
  },
  async remove(messageId){
   const me=opts.me?.(),pid=meEntry()?.[0];
   mutate(db=>{const [,c,m]=find(db,messageId);if(!m||m.x)throw fail('Wiadomość nie istnieje.',404);
    if(m.u!==pid&&me?.user?.role!=='admin')throw fail('Brak uprawnień.',403);m.x=m.u===pid?'author':'mod';delete m.b;m.r=++c.rev;});
   return {ok:true};
  },
  async report(messageId){const [,,m]=find(database(env.now()),messageId);if(!m)throw fail('Wiadomość nie istnieje.',404);return {ok:true};},
  stop(){stopped=true;try{globalThis.window?.removeEventListener('storage',onStorage);}catch{}},
  _state:()=>({cursors,heads})
 };
}
