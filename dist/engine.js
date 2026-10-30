/* MatDraw prototype domain rules. Unresolved source rules remain blocked. */
export const EVENTS = {
  forms: 'Układy formalne', soft: 'Walki soft / kalaki', hogo: 'Walki Hogo',
  semi: 'Walki semi contact', light: 'Walki light contact', special: 'Techniki specjalne', power: 'Testy siły'
};
export const RULE_ISSUES = [
  {id:'bronze', title:'Brązowy medal', detail:'Dokument mówi o jednym brązowym medaliście, ale nie określa walki o 3. miejsce ani repasaży. Drabinka wyznacza finał; brąz pozostaje nierozstrzygnięty.'},
  {id:'female-semi', title:'Juniorki młodsze — waga', detail:'Przedziały „do 45 kg” i „41–50 kg” nakładają się. Automatyczne przypisanie do tych kategorii jest wstrzymane.'},
  {id:'female-light', title:'Kobiety Cup — granica 75 kg', detail:'Przedziały „71–75 kg” i „75 i wyżej” obejmują 75 kg. Te starty wymagają decyzji przed losowaniem.'},
  {id:'veterans', title:'Weterani — wiek 45 lat', detail:'Grupy 36–45 i 45–55 nakładają się. Wiek 45 lat przy kategoriach Dan i konkurencjach punktowych wymaga ustalenia.'},
  {id:'tolerance', title:'Tolerancja 200 g i końce przedziałów', detail:'Do demonstracji przyjmujemy ciągłe limity (np. >58 do 64 kg), a przy ważeniu dopuszczamy do 200 g nad górnym limitem zgłoszonej kategorii. To interpretacja do potwierdzenia przez trenera.'},
  {id:'draw', title:'Wolne losy i większe drabinki', detail:'Dla 9–16 osób stosujemy kolejność z ilustracji trenera. Rozszerzenie na 17–64 osoby i priorytet mistrzów wymagają akceptacji. Powyżej 64 osób losowanie jest zablokowane.'},
  {id:'lists', title:'Listy technik specjalnych i testów siły', detail:'Brakuje wzoru listy i zasad punktacji z regulaminu. Dostępna jest robocza lista startowa, bez obliczania miejsc.'},
  {id:'age', title:'Wiek, kategorie Dan i retencja', detail:'Do ustalenia: wiek w dniu zawodów czy rocznikowo, start zawodników Dan poniżej 16 lat, znaczenie soft/kalaki oraz termin usuwania danych po zawodach.'}
];
export function ageGroup(age) {
  if(age<7) return null;
  return age<=9?['youth','Młodzicy']:age<=12?['cadet','Kadeci']:age<=15?['younger','Juniorzy młodsi']:age<=18?['junior','Juniorzy']:age<=35?['senior','Seniorzy']:['veteran','Weterani'];
}
export function eligibility(a,event){
  const group=ageGroup(a.age)?.[0];
  if(!group)return 'Brak kategorii dla wieku poniżej 7 lat';
  const allowed={youth:['forms','soft','special'],cadet:['forms','hogo','special'],younger:['forms','semi','special'],junior:['forms','light','special','power'],senior:['forms','light','special','power'],veteran:['forms','light','special','power']};
  if(!allowed[group].includes(event))return 'Konkurencja niedostępna w tej grupie wieku';
  if(group==='junior'&&event==='light'&&a.gradeType==='cup'&&a.grade>6)return 'Light contact juniorów wymaga co najmniej 6 Cup';
  if(a.gradeType==='dan'&&a.age<16)return 'Kategorie Dan poniżej 16 lat nie są opisane';
  if(a.gradeType==='dan'&&(a.grade>(group==='junior'?3:4)))return 'Stopień Dan poza kategoriami specyfikacji';
  return null;
}
const femaleLabel={youth:'Młodziczki',cadet:'Kadetki',younger:'Juniorki młodsze',junior:'Juniorki',senior:'Seniorki',veteran:'Weteranki'};
export function classify(a,event){
  const error=eligibility(a,event);
  if(error)return {error};
  const [group,ageLabel]=ageGroup(a.age);
  const sexLabel=a.sex==='M'?'mężczyźni':'kobiety';
  let groupKey=group, groupText=a.sex==='F'?femaleLabel[group]:ageLabel;
  if(group==='veteran'&&(a.gradeType==='dan'||['special','power'].includes(event))){
    if(a.age===45)return {error:'Wiek 45 lat: nakładające się grupy w regulaminie'};
    const band=a.age<45?'36-45':a.age<=55?'45-55':'56+';
    groupKey+='-'+band; groupText+=' '+band.replaceAll('-','–')+' lat';
  }
  let band='',limit=null,dimension=null;
  if(event==='forms'){
    band=a.gradeType==='dan'?a.grade+' Dan':group==='youth'?(a.grade>=7?'10–7 Cup':'6–1 Cup'):(a.grade>=7?'10–7 Cup':a.grade>=3?'6–3 Cup':'2–1 Cup');
  }else if(event==='soft'||event==='hogo'){
    const bounds=event==='soft'?[115,125,135]:[135,145,155];
    limit=bounds.find(b=>a.height<=b)??Infinity;
    band=Number.isFinite(limit)?'do '+limit+' cm':'powyżej '+bounds.at(-1)+' cm'; dimension='height';
  }else if(event==='semi'||event==='light'){
    if(event==='semi'&&a.sex==='F')return {error:'Juniorki młodsze: niejednoznaczne przedziały wagowe'};
    if(event==='light'&&a.sex==='F'&&a.gradeType==='cup')return {error:'Kobiety Cup: przedziały 71–75 / 75+ wymagają ustalenia'};
    let bounds;
    if(event==='semi')bounds=[50,55,60,65,70,75];
    else if(a.gradeType==='cup')bounds=[58,64,70,76,82,88];
    else if(a.sex==='M')bounds=group==='junior'?[52,58,63,70]:[54,63,71,80];
    else bounds=group==='junior'?[42,48,53,60]:[52,58,63,70];
    const registered=bounds.find(b=>a.weight<=b)??Infinity;
    const actual=a.actualWeight??a.weight;
    limit=(a.actualWeight!=null&&actual>=a.weight&&actual<=registered+0.2+1e-8)?registered:(bounds.find(b=>actual<=b)??Infinity);
    band=Number.isFinite(limit)?'do '+limit+' kg':'powyżej '+bounds.at(-1)+' kg'; dimension='weight';
  }else band='Lista startowa';
  const type=['special','power'].includes(event)?'list':'bracket';
  const rank=type==='list'?'all':a.gradeType;
  const id=[event,groupKey,a.sex,rank,band].join('|');
  return {id,event,title:EVENTS[event],ageLabel:groupText,sexLabel,band,gradeType:rank,type,limit,dimension,subtitle:[groupText,sexLabel,band].join(' · ')};
}
export function categories(athletes){
  const map=new Map();const unassigned=[];
  for(const a of athletes){
    if(a.presence==='absent')continue;
    for(const event of a.events){
      const c=classify(a,event);
      if(c.error){unassigned.push({athlete:a,event,reason:c.error});continue;}
      if(!map.has(c.id))map.set(c.id,{...c,athletes:[]});
      map.get(c.id).athletes.push(a);
    }
  }
  const ordered=[...map.values()].sort((a,b)=>Object.keys(EVENTS).indexOf(a.event)-Object.keys(EVENTS).indexOf(b.event)||b.athletes.length-a.athletes.length||a.id.localeCompare(b.id));
  const counters={};
  const prefix={forms:'UF',soft:'SO',hogo:'HG',semi:'SC',light:'LC',special:'TS',power:'SI'};
  ordered.forEach(c=>{c.code=prefix[c.event]+'-'+String(counters[c.event]=(counters[c.event]||0)+1).padStart(2,'0');c.underfilled=c.athletes.length<3;});
  return {items:ordered,unassigned};
}
export function slotOrder(size){
  if(![8,16,32,64].includes(size))throw Error('Obsługiwane wielkości: 8, 16, 32, 64');
  const edge=[0,7,1,6,2,5,3,4];
  const sections=size/8;
  const order=sections===1?[0]:sections===2?[0,1]:sections===4?[0,3,1,2]:[0,7,3,4,1,6,2,5];
  return edge.flatMap(p=>order.map(s=>s*8+(s%2===0?p:7-p)));
}
function rng(seed){let s=seed>>>0;return()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function shuffle(a,random){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
export function firstPairs(slots){
  const pairs=[];
  function walk(s){if(s.length===1)return s.filter(Boolean);const a=walk(s.slice(0,s.length/2)),b=walk(s.slice(s.length/2));if(a.length===1&&b.length===1)pairs.push([a[0],b[0]]);return [...a,...b];}
  walk(slots);return pairs;
}
export function makeDraw(athletes,seed=1){
  if(athletes.length<3)throw Error('Minimum 3 zawodników. Kategoria wymaga decyzji organizatora.');
  if(athletes.length>64)throw Error('Powyżej 64 zawodników — regulamin wymaga doprecyzowania.');
  const size=athletes.length<=8?8:2**Math.ceil(Math.log2(athletes.length));
  const order=slotOrder(size).slice(0,athletes.length),random=rng(seed);
  const byId=Object.fromEntries(athletes.map(a=>[a.id,a]));
  const slots=Array(size).fill(null);shuffle(athletes,random).forEach((a,i)=>slots[order[i]]=a.id);
  const cost=s=>firstPairs(s).reduce((n,p)=>n+(byId[p[0]].club===byId[p[1]].club?10000:0),0)+s.reduce((n,id,i)=>n+(id&&byId[id].champion&&s[i^1]?100:0),0);
  let score=cost(slots);
  for(let k=0;k<2500;k++){
    const i=order[Math.floor(random()*order.length)],j=order[Math.floor(random()*order.length)];
    [slots[i],slots[j]]=[slots[j],slots[i]];const next=cost(slots);
    if(next>score)[slots[i],slots[j]]=[slots[j],slots[i]];else score=next;
    if(score===0)break;
  }
  return {size,slots,seed,results:{},revision:1,signature:signature(athletes),createdAt:new Date().toISOString()};
}
export function signature(a){return a.map(x=>[x.id,x.club,!!x.champion].join(':')).sort().join(',');}
export function resolveDraw(draw){
  let previous=draw.slots.map(id=>({winner:id,settled:true}));const rounds=[];let number=1;
  for(let round=0;previous.length>1;round++){
    const matches=[];
    for(let i=0;i<previous.length;i+=2){
      const left=previous[i],right=previous[i+1],id=round+'-'+i/2;
      const a=left.winner,b=right.winner;const ready=left.settled&&right.settled;
      const recorded=draw.results[id];
      const valid=ready&&a&&b&&[a,b].includes(recorded);
      const auto=ready&&(!a||!b);const winner=valid?recorded:auto?(a||b):null;
      matches.push({id,number:number++,round,index:i/2,a,b,aSettled:left.settled,bSettled:right.settled,winner,auto:!!auto,settled:!!(valid||auto),ready:!!(ready&&a&&b&&!valid),recorded:!!valid});
    }
    rounds.push(matches);previous=matches;
  }
  return rounds;
}
export function saveWinner(draw,id,winner){
  const rounds=resolveDraw(draw),m=rounds.flat().find(m=>m.id===id);
  if(!m||!m.a||!m.b||!m.aSettled||!m.bSettled)throw Error('Najpierw rozstrzygnij wcześniejsze walki.');
  if(![m.a,m.b].includes(winner))throw Error('Zwycięzca musi uczestniczyć w tej walce.');
  let index=m.index;
  for(let r=m.round+1;r<rounds.length;r++){index=Math.floor(index/2);if(draw.results[r+'-'+index])throw Error('Najpierw wycofaj wynik w kolejnej rundzie.');}
  draw.results[id]=winner;draw.revision++;
}
export function clearWinner(draw,id){
  const [r,i]=id.split('-').map(Number);let index=i;
  for(let round=r+1;round<Math.log2(draw.size);round++){index=Math.floor(index/2);if(draw.results[round+'-'+index])throw Error('Najpierw wycofaj wynik w kolejnej rundzie.');}
  delete draw.results[id];draw.revision++;
}
export function clubConflicts(draw,athletes){const map=Object.fromEntries(athletes.map(a=>[a.id,a]));return firstPairs(draw.slots).filter(([a,b])=>map[a]?.club===map[b]?.club).length;}
export function fingerprintCounts(athletes){const {items,unassigned}=categories(athletes);return {athletes:athletes.length,active:athletes.filter(a=>a.presence!=='absent').length,clubs:new Set(athletes.map(a=>a.club)).size,categories:items.length,alerts:items.filter(c=>c.underfilled).length,unassigned:unassigned.length};}
export function validateAthlete(a){
  if(!a.name?.trim()||!a.club?.trim())throw Error('Podaj imię i nazwisko oraz klub.');
  if(!['M','F'].includes(a.sex)||!['cup','dan'].includes(a.gradeType))throw Error('Sprawdź płeć i rodzaj stopnia.');
  if(!Number.isInteger(a.age)||a.age<7||a.age>100)throw Error('Wiek musi wynosić od 7 do 100 lat.');
  if(!Number.isFinite(a.weight)||a.weight<10||a.weight>250||!Number.isFinite(a.height)||a.height<70||a.height>250)throw Error('Sprawdź wagę (10–250 kg) i wzrost (70–250 cm).');
  if(!Number.isInteger(a.grade)||a.grade<1||a.grade>(a.gradeType==='cup'?10:9))throw Error('Sprawdź stopień zawodnika.');
  if(!Array.isArray(a.events)||!a.events.length||a.events.some(e=>!EVENTS[e]))throw Error('Wybierz co najmniej jedną konkurencję.');
  const issues=a.events.map(e=>eligibility(a,e)).filter(Boolean);if(issues.length)throw Error(issues[0]);
  return true;
}
export function initialState(){
  const athletes=[];let n=0;
  const add=(name,club,age,sex,gradeType,grade,weight,height,events,presence='pending',champion=false)=>athletes.push({id:'a'+ ++n,name,club,age,sex,gradeType,grade,weight,height,events,presence,champion,actualWeight:presence==='present'?weight:null});
  const clubs=['TKD Warszawa','KS Tiger Kraków','UKS Gdańsk','Dragon Poznań','TKD Łódź','Centrum Wrocław'];
  ['Adam Nowak','Michał Kowalski','Jan Wiśniewski','Piotr Zieliński','Kacper Wójcik','Tomasz Kamiński','Jakub Lewandowski','Paweł Dąbrowski','Filip Mazur'].forEach((name,i)=>add(name,clubs[i%6],20+i,'M','dan',1,65+i,174+i,['forms'],i<7?'present':'pending',i===0));
  ['Antoni Krawczyk','Aleksander Szymański','Maksymilian Woźniak','Szymon Kozłowski','Wojciech Jankowski','Mateusz Wojciechowski'].forEach((name,i)=>add(name,clubs[i%6],16+i%3,'M','cup',3+i%3,59+i*.7,172+i,['light'],'present',i===1));
  ['Leon Kaczmarek','Franciszek Piotrowski','Stanisław Grabowski','Mikołaj Zając'].forEach((name,i)=>add(name,clubs[i%4],10+i%3,'M','cup',7,35+i,137+i*2,['hogo'],i<2?'present':'pending'));
  ['Oliwier Król','Ignacy Wieczorek','Marcel Jabłoński'].forEach((name,i)=>add(name,clubs[i%3],7+i,'M','cup',8,25+i,120+i*3,['forms'],'present'));
  add('Zofia Wróbel',clubs[0],17,'F','dan',2,55,166,['forms'],'present');
  add('Bartosz Nowicki',clubs[2],25,'M','dan',2,60,172,['light'],'pending');
  add('Łukasz Sikora',clubs[1],27,'M','dan',1,62,175,['light'],'pending');
  ['Natalia Lis','Julia Pawlak','Maja Michalak','Hanna Adamczyk','Alicja Dudek'].forEach((name,i)=>add(name,clubs[i%5],19+i,'F','cup',4,57+i,165+i,['special'],i<4?'present':'pending'));
  ['Kamil Wróblewski','Dawid Walczak','Dominik Stępień','Oskar Baran'].forEach((name,i)=>add(name,clubs[i%4],24+i,'M','cup',2,75+i,180+i,['power'],i<3?'present':'pending'));
  add('Lena Górska',clubs[3],14,'F','cup',4,44,158,['semi'],'pending');
  return {schemaVersion:1,tournament:{name:'Puchar Jesieni 2026',city:'Warszawa',date:'2026-11-14',mat:'Mata 1'},athletes,draws:{},activity:[],updatedAt:Date.now()};
}
