// PL/EN interface: language detection, dictionary coverage and display-time translation of rules and server messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import vm from 'node:vm';
import {DICTIONARY as EN,collisions,DICTIONARY_SOURCES} from '../dist/i18n.js';
import {detectLanguage,resolveLanguage,setLanguage,getLanguage,t,ruleLabel,ruleText,translateMessage,formatNumber,gradeLabel,locale,STORAGE_KEY} from '../dist/i18n.js';
import {EVENTS,RULE_ISSUES,classify,eligibility} from '../dist/engine.js';
import {ROLES,STATUSES} from '../dist/workspace.js';
import {AD,ACCESS} from '../dist/promo.js';

const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const literal="'((?:[^'\\\\]|\\\\.)*)'";
const all=(source,pattern)=>[...source.matchAll(new RegExp(pattern,'g'))].map(m=>m[1]);
const POLISH_LETTERS=/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const placeholders=text=>[...String(text).matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
const english=fn=>{const before=getLanguage();setLanguage('en',{persist:false});try{return fn();}finally{setLanguage(before,{persist:false});}};
const polish=fn=>{const before=getLanguage();setLanguage('pl',{persist:false});try{return fn();}finally{setLanguage(before,{persist:false});}};
// Proper names that legitimately keep Polish letters in English text.
const NAMES=/Bogusław/g;
const list=dir=>existsSync(new URL('../'+dir,import.meta.url))?readdirSync(new URL('../'+dir,import.meta.url)).sort():[];
// Interface modules scanned for T('…') keys, thrown messages and stray Polish (plan §8.6): every dist/*.js except the rules engine,
// domain/demo data, dictionaries, boot scripts, the service worker, the registry (no texts) and data-only modules.
const NOT_UI=new Set(['engine.js','workspace.js','guest-view.js','lang-boot.js','runtime-config.js','sw.js','registry.js','profile-data.js','chat-demo.js']);
const UI_MODULES=list('dist').filter(f=>f.endsWith('.js')&&!/^i18n/.test(f)&&!NOT_UI.has(f)).map(f=>'dist/'+f);
// promo.js holds the advertisement and the access offer as Polish data shown through T(); the promotional test below covers those
// two objects. Only their literals are exempt: the rest of promo.js is scanned like any interface module (plan §8.6 point 3).
const DATA_OBJECTS={'dist/promo.js':['AD','ACCESS']};
/** Removes the object literal of each `export const NAME={…}` (balanced braces, quotes respected); throws when one is missing. */
function stripDataObjects(code,names){
 for(const name of names){
  const start=code.search(new RegExp('export const '+name+'=\\{'));if(start<0)throw new Error('data object not found: '+name);
  let i=code.indexOf('{',start),depth=0,quote=null;
  for(;i<code.length;i++){const c=code[i];if(quote){if(c==='\\')i++;else if(c===quote)quote=null;}else if(c==="'"||c==='"'||c==='`')quote=c;else if(c==='{')depth++;else if(c==='}'&&--depth===0)break;}
  code=code.slice(0,start)+'export const '+name+'={}'+code.slice(i+1);
 }
 return code;
}
const uiSource=file=>DATA_OBJECTS[file]?stripDataObjects(read(file),DATA_OBJECTS[file]):read(file);
const PHP_MESSAGE_FILES=[...['backend/src','backend/routes','backend/jobs'].flatMap(dir=>list(dir).filter(f=>f.endsWith('.php')).map(f=>dir+'/'+f)),'backend/public/api/index.php'];
const stripTexts=code=>code.replace(new RegExp("\\b[tT]\\(\\s*"+literal,'g'),'T(').replace(new RegExp("\\b(?:Error|DomainError)\\(\\s*"+literal,'g'),'Error(').replace(/Język \/ Language/g,'');

test('browser language: Polish preference gives PL, anything else gives EN',()=>{
 for(const value of ['pl','pl-PL','PL-pl','pl_PL',' pl-PL ',['pl-PL','en-US'],['pl'],[undefined,'','pl']])assert.equal(detectLanguage(value),'pl',JSON.stringify(value));
 for(const value of ['en-US','en','de-DE','uk-UA','plk','',null,undefined,[],[undefined,''],['en-GB','pl-PL'],['de','pl']])assert.equal(detectLanguage(value),'en',JSON.stringify(value));
});
test('a remembered manual choice wins over detection; invalid stored values are ignored',()=>{
 assert.equal(resolveLanguage('en',['pl-PL']),'en');
 assert.equal(resolveLanguage('pl',['en-US']),'pl');
 assert.equal(resolveLanguage('de',['pl-PL']),'pl');
 assert.equal(resolveLanguage(null,['fr-FR']),'en');
 assert.equal(STORAGE_KEY,'matdraw.language');
});
test('lang-boot.js (early <html lang>) follows the same rule as i18n.js',()=>{
 const code=read('dist/lang-boot.js');
 const cases=[[null,['pl-PL','en']],[null,['en-US','pl']],[null,[]],[null,['pl']],['en',['pl-PL']],['pl',['en-US']],['xx',['pl-PL']],['xx',['de-DE']]];
 for(const [saved,languages] of cases){
  const html={lang:'pl'};
  const window={localStorage:{getItem:key=>key===STORAGE_KEY?saved:null},navigator:{languages,language:languages[0]}};
  vm.runInNewContext(code,{window,document:{documentElement:html}});
  assert.equal(html.lang,resolveLanguage(saved,languages),JSON.stringify([saved,languages]));
 }
 const html={lang:'pl'};vm.runInNewContext(code,{window:{get localStorage(){throw Error('blocked');},navigator:{languages:[],language:'pl-PL'}},document:{documentElement:html}});
 assert.equal(html.lang,'pl','falls back to navigator.language and survives blocked storage');
});

test('the interface modules are found and the per-feature dictionaries merge without collisions',()=>{
 for(const file of ['dist/app.js','dist/architecture.js','dist/client.js','dist/me.js'])assert.ok(UI_MODULES.includes(file),file);
 for(const file of ['dist/registry.js','dist/engine.js','dist/i18n.js','dist/i18n-en.js'])assert.ok(!UI_MODULES.includes(file),file);
 assert.deepEqual(DICTIONARY_SOURCES.map(([name])=>name),['i18n-en.js',...['shell','accounts','chat','moderation','members','billing','home','pwa'].map(f=>'i18n/'+f+'-en.js')]);
 assert.deepEqual(collisions,[],'the same key with different English text in two dictionaries');
 assert.ok(PHP_MESSAGE_FILES.includes('backend/src/Domain.php')&&PHP_MESSAGE_FILES.includes('backend/public/api/index.php'));
});
test('every T()/t() key used in the interface has an English entry with the same placeholders',()=>{
 const used=new Map();
 for(const file of UI_MODULES)for(const key of all(read(file),"\\b[tT]\\(\\s*"+literal))used.set(key,file);
 assert.ok(used.size>300,'expected the whole UI to be wrapped, found '+used.size);
 const missing=[...used.keys()].filter(k=>!Object.hasOwn(EN,k));
 assert.deepEqual(missing,[],'missing English entries');
 for(const [key,value] of Object.entries(EN)){
  const forms=typeof value==='object'?[value.one,value.other]:typeof value==='function'?[]:[value];
  for(const form of forms){
   assert.equal(typeof form,'string',key);
   assert.deepEqual(placeholders(form).filter(p=>p!=='n'||placeholders(key).includes('n')),placeholders(key),'placeholders differ: '+key);
   assert.ok(!POLISH_LETTERS.test(form.replace(NAMES,'')),'Polish letters in English text: '+form);
  }
 }
});
test('no visible Polish text in interface modules outside T() (thrown messages are translated when shown)',()=>{
 const left=UI_MODULES.flatMap(file=>stripTexts(uiSource(file)).split('\n').filter(line=>POLISH_LETTERS.test(line)).map(line=>file+': '+line.trim().slice(0,160)));
 assert.deepEqual(left,[]);
});
test('promo.js: only the AD and ACCESS literals are exempt from the Polish-text rule',()=>{
 const stripped=uiSource('dist/promo.js');
 assert.ok(!/Reklama|Zaloguj/.test(stripped)&&/export const AD=\{\}/.test(stripped)&&/export const ACCESS=\{\}/.test(stripped),'data objects removed');
 const planted=stripDataObjects(read('dist/promo.js')+"\nexport const label='Zgłoś';\n",['AD','ACCESS']);
 assert.ok(planted.split('\n').some(line=>POLISH_LETTERS.test(line)),'interface text added next to the data is still scanned');
 assert.throws(()=>stripDataObjects('export const OTHER={};',['AD']),/not found/);
});
test('Polish output is the key itself (unchanged behaviour); English uses plural forms',()=>{
 polish(()=>{
  assert.equal(t('{n} klubów',{n:1}),'1 klubów');
  assert.equal(t('Walka {n}: {a} i {b}. {status}',{n:3,a:'A',b:'B',status:'Gotowa'}),'Walka 3: A i B. Gotowa');
  assert.equal(ruleText('Seniorzy · mężczyźni · do 63 kg'),'Seniorzy · mężczyźni · do 63 kg');
  assert.equal(translateMessage('Konto nie istnieje.'),'Konto nie istnieje.');
  assert.equal(gradeLabel(6,'cup'),'6 Cup');assert.equal(locale(),'pl-PL');assert.equal(formatNumber(65.2),'65,2');
 });
 english(()=>{
  assert.equal(t('{n} klubów',{n:1}),'1 club');assert.equal(t('{n} klubów',{n:2}),'2 clubs');assert.equal(t('{n} klubów',{n:0}),'0 clubs');
  assert.equal(t('Turnieje'),'Tournaments');assert.equal(t('Nieznany tekst'),'Nieznany tekst');
  assert.equal(gradeLabel(6,'cup'),'6th Gup');assert.equal(gradeLabel(1,'dan'),'1st Dan');assert.equal(gradeLabel(2,'dan'),'2nd Dan');assert.equal(gradeLabel(3,'cup'),'3rd Gup');
  assert.equal(locale(),'en-GB');assert.equal(formatNumber(65.2),'65.2');
 });
});

test('Polish plurals (one/few/many) for the community count texts; the key stays the English dictionary key',async()=>{
 const {plural,pluralCategory,PL_FORMS}=await import('../dist/i18n.js');
 assert.deepEqual([0,1,2,3,4,5,11,12,14,21,22,24,25,104,112].map(pluralCategory),['many','one','few','few','few','many','many','many','many','many','few','few','many','few','many']);
 assert.equal(plural(3,{one:'znak',few:'znaki',many:'znaków'}),'znaki');assert.equal(plural(7,{one:'a',many:'b'}),'b','a missing form falls back to many');
 for(const [key,forms] of Object.entries(PL_FORMS)){
  assert.ok(Object.hasOwn(EN,key),'English entry for '+key);
  assert.deepEqual(Object.keys(forms).sort(),['few','many','one'],key);
  for(const form of Object.values(forms))assert.deepEqual(placeholders(form),placeholders(key),key);
  assert.ok(Object.values(forms).includes(key),'one of the forms is the key itself: '+key);
 }
 polish(()=>{
  assert.equal(t('Czat turnieju: {n} wiadomości',{n:1}),'Czat turnieju: 1 wiadomość');assert.equal(t('Czat turnieju: {n} wiadomości',{n:2}),'Czat turnieju: 2 wiadomości');
  assert.equal(t('{n} nieprzeczytanych',{n:1}),'1 nieprzeczytana');assert.equal(t('{n} nieprzeczytanych',{n:3}),'3 nieprzeczytane');assert.equal(t('{n} nieprzeczytanych',{n:12}),'12 nieprzeczytanych');
  assert.equal(t('Archiwum · {n} zakończone',{n:1}),'Archiwum · 1 zakończony');assert.equal(t('Archiwum · {n} zakończone',{n:5}),'Archiwum · 5 zakończonych');
  assert.equal(t('Zostało {n} znaków',{n:1}),'Został 1 znak');assert.equal(t('Zostało {n} znaków',{n:22}),'Zostały 22 znaki');assert.equal(t('Zostało {n} znaków',{n:50}),'Zostało 50 znaków');
  assert.equal(t('Zostało {n} znaków'),'Zostało {n} znaków','without a count the key is returned as before');
 });
 english(()=>{assert.equal(t('Czat turnieju: {n} wiadomości',{n:1}),'Tournament chat: 1 message');assert.equal(t('Zostało {n} znaków',{n:2}),'2 characters left');});
});
test('rule-engine labels: all events, roles, statuses and open rule issues are translated',()=>english(()=>{
 for(const [map,name] of [[EVENTS,'EVENTS'],[ROLES,'ROLES'],[STATUSES,'STATUSES']])for(const value of Object.values(map))assert.ok(Object.hasOwn(EN,value),name+': '+value);
 for(const issue of RULE_ISSUES){assert.ok(Object.hasOwn(EN,issue.title),issue.id);assert.ok(Object.hasOwn(EN,issue.detail),issue.id);}
}));
test('every category the engine can produce is fully translated, and its id stays Polish/unchanged',()=>english(()=>{
 const seen=new Set();let checked=0;
 for(const age of [7,8,9,10,12,13,15,16,17,18,19,25,35,36,40,44,45,46,50,55,56,70])for(const sex of ['M','F'])for(const gradeType of ['cup','dan'])for(const grade of gradeType==='cup'?[10,8,7,6,4,3,2,1]:[1,2,3,4])
  for(const weight of [30,45,50,53,58,61,66,72,80,95])for(const height of [110,120,130,140,150,160])for(const event of Object.keys(EVENTS)){
   const a={age,sex,gradeType,grade,weight,height,actualWeight:null};const c=classify(a,event);
   if(c.error){const out=translateMessage(c.error);assert.notEqual(out,c.error,c.error);assert.ok(!POLISH_LETTERS.test(out),out);continue;}
   if(seen.has(c.id))continue;seen.add(c.id);checked++;
   for(const label of [c.title,c.ageLabel,c.sexLabel,c.band]){const out=ruleLabel(label);assert.ok(!POLISH_LETTERS.test(out)&&!/\b(do|powyżej|lat|Cup|Lista)\b/.test(out),label+' -> '+out);}
   const subtitle=ruleText(c.subtitle);assert.ok(!POLISH_LETTERS.test(subtitle)&&!/\b(do|lat|Cup)\b/.test(subtitle),c.subtitle+' -> '+subtitle);
   assert.equal(c.id.split('|')[0],event,'ids are not affected by translation');
  }
 assert.ok(checked>100,'categories checked: '+checked);
 assert.equal(ruleText('Weterani 36–45 lat · mężczyźni · do 63 kg'),'Veterans 36–45 years · male · up to 63 kg');
 assert.equal(ruleText('Kadetki · kobiety · powyżej 155 cm'),'Cadets · female · over 155 cm');
 assert.equal(ruleLabel('10–7 Cup'),'10th–7th Gup');assert.equal(ruleLabel('2 Dan'),'2nd Dan');assert.equal(ruleLabel('Lista startowa'),'Start list');
 assert.equal(eligibility({age:12,sex:'M',gradeType:'cup',grade:6},'light'),'Konkurencja niedostępna w tej grupie wieku','engine messages stay Polish');
}));

test('every message the PHP API, the demo adapter and the rules engine can send has an English translation',()=>english(()=>{
 // PHP: every source, route and job file (plan §8.6 point 4); JS: Error/DomainError messages of every interface module (point 5).
 const php=PHP_MESSAGE_FILES.map(read).join('\n');
 const js={engine:read('dist/engine.js'),workspace:read('dist/workspace.js'),ui:UI_MODULES.map(read).join('\n')};
 const messages=new Set([
  ...all(php,"new (?:AppError|ApiError)\\("+literal+"\\s*[,)]"),...all(php,"'error'=>"+literal),...all(read('backend/src/Rules.php'),"return "+literal+";"),...all(read('backend/src/Rules.php'),"\\['error'=>"+literal),
  ...all(js.engine,"Error\\("+literal+"\\)"),...all(js.engine,"return "+literal+";"),...all(js.engine,"\\{error:"+literal+"\\}"),
  ...all(js.workspace,"fail\\("+literal+"\\s*[,)]"),...all(js.ui,"\\b(?:Error|DomainError)\\(\\s*"+literal+"\\s*[,)]")
 ]);
 assert.ok(messages.size>80,'messages found: '+messages.size);
 // Messages built from a template and a field/entity label.
 const fields=new Set([...all(php,"(?:self|Domain)::txt\\((?:[^()]|\\([^()]*\\))*?,\\s*"+literal),...all(js.workspace,"\\btext\\([^;]*?,"+literal)]);
 const entities=new Set([...all(php,"entity\\([^;]*?,"+literal+"\\)"),...all(js.workspace,"\\bfind\\([^;]*?,"+literal+"\\)")]);
 assert.ok(fields.has('imię i nazwisko')&&fields.has('nazwa turnieju')&&entities.has('Zgłoszenie'),JSON.stringify([...fields,...entities]));
 for(const field of fields)messages.add('Sprawdź pole: '+field+'.');
 for(const entity of entities)messages.add(entity+' nie istnieje.');
 const untranslated=[];
 for(const message of messages){const out=translateMessage(message);if(out===message||POLISH_LETTERS.test(out))untranslated.push(message+' -> '+out);}
 assert.deepEqual(untranslated,[]);
 assert.equal(translateMessage('Some unexpected error'),'Some unexpected error','unknown messages are shown unchanged');
}));
test('activity entries stored in Polish by PHP and the demo adapter are translated for display',()=>english(()=>{
 const sources=read('backend/src/Domain.php')+read('dist/workspace.js');
 const parts=[...sources.matchAll(/audit\(\$?\w+,([^;]*)\)/g)].flatMap(m=>all(m[1],literal)).filter(s=>s.includes(' ')&&s!==' · ');
 assert.ok(parts.length>=8,JSON.stringify(parts));
 const category=classify({age:25,sex:'F',gradeType:'dan',grade:1,weight:60,height:170},'forms');
 for(const part of new Set(parts)){
  const sample=part.endsWith(': ')?part+(part.startsWith('Zapisano losowanie')?category.title+' · '+category.subtitle:'Anna Nowak'):part;
  const out=translateMessage(sample);assert.notEqual(out,sample,sample);assert.ok(!POLISH_LETTERS.test(out),out);
 }
 assert.equal(translateMessage('Zapisano losowanie: Układy formalne · Seniorki · kobiety · 1 Dan'),'Draw saved: Patterns · Seniors · female · 1st Dan');
 assert.equal(translateMessage('Zgłoszono: Łukasz Żak'),'Entered: Łukasz Żak','names are kept');
}));

test('promotional texts (dist/promo.js: advertisement and login/access offer) all have English entries',()=>english(()=>{
 const strings=[];
 const walk=(value,key)=>{if(['kind','brand','icon','src','small','width','height'].includes(key))return;if(typeof value==='string')strings.push(value);else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))walk(v,Array.isArray(value)?key:k);};
 walk(AD);walk(ACCESS);
 assert.ok(strings.length>=20,'texts found: '+strings.length);
 const missing=strings.filter(s=>!Object.hasOwn(EN,s));assert.deepEqual(missing,[]);
 for(const s of strings){const out=t(s);assert.notEqual(out,s);assert.ok(!POLISH_LETTERS.test(out),out);}
 assert.match(t(AD.disclaimer),/fictional/,'the advertisement says the brand is fictional in both languages');
 assert.match(AD.disclaimer,/fikcyjn/);
 assert.ok(AD.image&&AD.image.alt&&Object.hasOwn(EN,AD.image.alt),'the advertisement photo has a translated description');
}));
