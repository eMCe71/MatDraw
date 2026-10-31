/* MatBravo interface language (PL / EN).
 * Gettext style: the Polish text in the code is the key and the Polish output; English lives in i18n-en.js and dist/i18n/*-en.js.
 * A missing English entry falls back to the Polish key, so Polish behaviour does not depend on this module.
 * Rule-engine labels and server messages stay Polish in data/API and are translated only for display. */
import BASE from './i18n-en.js';
import SHELL from './i18n/shell-en.js';
import ACCOUNTS from './i18n/accounts-en.js';
import CHAT from './i18n/chat-en.js';
import MODERATION from './i18n/moderation-en.js';
import MEMBERS from './i18n/members-en.js';
import BILLING from './i18n/billing-en.js';
import HOME from './i18n/home-en.js';
import PWA from './i18n/pwa-en.js';

const same=(a,b)=>a===b||(a&&b&&typeof a==='object'&&typeof b==='object'&&JSON.stringify(a)===JSON.stringify(b));
/** Merges per-feature dictionaries, first one wins. A key repeated with a different value is not fatal (one phrase must not stop
 * the app); it is listed in collisions, which the tests require to be empty. */
export function mergeDictionaries(sources){
 const dictionary={},collisions=[],origin={};
 for(const [name,dict] of sources)for(const [key,value] of Object.entries(dict||{})){
  if(!Object.hasOwn(dictionary,key)){dictionary[key]=value;origin[key]=name;}
  else if(!same(dictionary[key],value))collisions.push({key,kept:origin[key],ignored:name});
 }
 return {dictionary,collisions};
}
export const DICTIONARY_SOURCES=[['i18n-en.js',BASE],['i18n/shell-en.js',SHELL],['i18n/accounts-en.js',ACCOUNTS],['i18n/chat-en.js',CHAT],['i18n/moderation-en.js',MODERATION],['i18n/members-en.js',MEMBERS],['i18n/billing-en.js',BILLING],['i18n/home-en.js',HOME],['i18n/pwa-en.js',PWA]];
const merged=mergeDictionaries(DICTIONARY_SOURCES);
/** All English entries (i18n-en.js and dist/i18n/*-en.js). */
export const DICTIONARY=merged.dictionary;
export const collisions=merged.collisions;

export const LANGUAGES=['pl','en'];
export const STORAGE_KEY='matdraw.language';
const LOCALES={pl:'pl-PL',en:'en-GB'};

/** Polish browser preference (pl, pl-PL, pl_PL…) gives PL; anything else, or nothing, gives EN. */
export function detectLanguage(preferred){
 const list=(Array.isArray(preferred)?preferred:[preferred]).filter(x=>typeof x==='string'&&x.trim());
 return /^pl(?:[-_]|$)/i.test(list[0]?.trim()||'')?'pl':'en';
}
/** A remembered manual choice wins over browser detection. */
export function resolveLanguage(saved,preferred){return LANGUAGES.includes(saved)?saved:detectLanguage(preferred);}
function savedLanguage(){try{return globalThis.localStorage?.getItem(STORAGE_KEY)??null;}catch{return null;}}
function browserLanguages(){try{const n=globalThis.navigator;return n?.languages?.length?[...n.languages]:[n?.language];}catch{return [];}}

let current=resolveLanguage(savedLanguage(),browserLanguages());
const listeners=new Set();
function applyDocumentLanguage(){try{if(globalThis.document?.documentElement)globalThis.document.documentElement.lang=current;}catch{}}
applyDocumentLanguage();

export const getLanguage=()=>current;
export const locale=()=>LOCALES[current];
export function onLanguageChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}
/** Switches the language; persist=false is used when another window already stored the choice. */
export function setLanguage(lang,{persist=true}={}){
 if(!LANGUAGES.includes(lang))return current;
 if(persist){try{globalThis.localStorage?.setItem(STORAGE_KEY,lang);}catch{}}
 if(lang===current)return current;
 current=lang;applyDocumentLanguage();
 for(const fn of listeners)fn(lang);
 return current;
}

const fill=(text,params)=>params?String(text).replace(/\{(\w+)\}/g,(m,k)=>Object.hasOwn(params,k)?String(params[k]):m):String(text);
export const hasTranslation=key=>Object.hasOwn(DICTIONARY,key);
const PL_RULES=typeof Intl==='object'&&typeof Intl.PluralRules==='function'?new Intl.PluralRules('pl-PL'):null;
/** Polish plural category of a count: 'one' (1), 'few' (2–4, 22–24, … but not 12–14) or 'many' (0, 5–21, 25…); fractions 'few'. */
export function pluralCategory(n){
 const x=Number(n);if(!Number.isFinite(x))return 'many';
 const c=PL_RULES?PL_RULES.select(x):null;if(c==='one'||c==='few'||c==='many')return c;if(c==='other')return 'few';
 const i=Math.abs(Math.trunc(x));return x!==Math.trunc(x)?'few':i===1?'one':i%10>=2&&i%10<=4&&(i%100<12||i%100>14)?'few':'many';
}
/** Polish form for a count: plural(5,{one:'wiadomość',few:'wiadomości',many:'wiadomości'}) (a missing form falls back to many). */
export const plural=(n,forms)=>forms[pluralCategory(n)]??forms.many??forms.few??forms.one;
/** Polish forms of keys with a count {n}: the key stays the Polish text looked up in the English dictionaries; t() picks the form. */
export const PL_FORMS={
 'Czat turnieju: {n} wiadomości':{one:'Czat turnieju: {n} wiadomość',few:'Czat turnieju: {n} wiadomości',many:'Czat turnieju: {n} wiadomości'},
 '{n} nieprzeczytanych':{one:'{n} nieprzeczytana',few:'{n} nieprzeczytane',many:'{n} nieprzeczytanych'},
 'Archiwum · {n} zakończone':{one:'Archiwum · {n} zakończony',few:'Archiwum · {n} zakończone',many:'Archiwum · {n} zakończonych'},
 'Zostało {n} znaków':{one:'Został {n} znak',few:'Zostały {n} znaki',many:'Zostało {n} znaków'}
};
/** t('Polish text {n}',{n}) – Polish keys with a count use PL_FORMS; English entries may be a string, {one,other} (chosen by
 * params.n) or a function. */
export function t(key,params){
 if(current==='pl'){const forms=Object.hasOwn(PL_FORMS,key)&&params&&params.n!=null?PL_FORMS[key]:null;return fill(forms?plural(params.n,forms):key,params);}
 if(!Object.hasOwn(DICTIONARY,key))return fill(key,params);
 const entry=DICTIONARY[key];
 if(typeof entry==='function')return String(entry(params||{}));
 if(entry&&typeof entry==='object')return fill(params?.n===1?entry.one:entry.other,params);
 return fill(entry,params);
}

export const formatNumber=(value,digits=1)=>Number(value).toLocaleString(locale(),{minimumFractionDigits:digits,maximumFractionDigits:digits});
export function ordinal(n){if(current==='pl')return String(n);const v=Math.abs(n)%100;return n+(v>=11&&v<=13?'th':({1:'st',2:'nd',3:'rd'}[v%10]||'th'));}
/** Grade type name: Polish ITF "Cup" is "Gup" in English; Dan is the same in both. */
export const gradeName=type=>type==='dan'?'Dan':current==='pl'?'Cup':'Gup';
export const gradeLabel=(grade,type)=>current==='pl'?grade+' '+gradeName(type):ordinal(grade)+' '+gradeName(type);

/** One label fragment produced by engine.js / Rules.php (event, age group, sex, weight/height class, grade band). */
export function ruleLabel(text){
 if(current==='pl'||text==null)return text;
 const s=String(text);let m;
 if(Object.hasOwn(DICTIONARY,s))return t(s);
 if((m=s.match(/^(do|powyżej) (\d+(?:[.,]\d+)?) (kg|cm)$/)))return t(m[1]==='do'?'do {value} {unit}':'powyżej {value} {unit}',{value:m[2],unit:m[3]});
 if((m=s.match(/^(\d+)–(\d+) Cup$/)))return ordinal(+m[1])+'–'+ordinal(+m[2])+' '+gradeName('cup');
 if((m=s.match(/^(\d+) (Dan|Cup)$/)))return gradeLabel(+m[1],m[2].toLowerCase());
 if((m=s.match(/^(.+) (\d+–\d+|\d+\+) lat$/))&&Object.hasOwn(DICTIONARY,m[1]))return t('{group} {range} lat',{group:t(m[1]),range:m[2]});
 return s;
}
/** Category subtitles and titles joined with " · " (e.g. "Seniorzy · mężczyźni · do 63 kg"). */
export const ruleText=text=>current==='pl'||text==null?text:String(text).split(' · ').map(ruleLabel).join(' · ');

// Server/domain messages with a variable part. Captured parts are translated by the given function or kept (names).
const TEMPLATES=[
 ['Sprawdź pole: {field}.',{field:t}],
 ['{entity} nie istnieje.',{entity:t}],
 ['Zgłoszono: {name}',{}],
 ['Zmieniono zgłoszenie: {name}',{}],
 ['Wycofano zgłoszenie: {name}',{}],
 ['Kontrola startowa: {name}',{}],
 ['Zapisano losowanie: {category}',{category:ruleText}]
].map(([key,convert])=>{const names=[];const source='^'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\\\{(\w+)\\\}/g,(m,name)=>{names.push(name);return '(.+)';})+'$';return {key,names,convert,re:new RegExp(source,'s')};});
/** Translates a message that arrives in Polish from the API, the demo adapter, the rules engine or stored activity. Unknown text is returned unchanged. */
export function translateMessage(message){
 if(current==='pl'||message==null)return message;
 const s=String(message);
 if(Object.hasOwn(DICTIONARY,s))return t(s);
 for(const {key,names,convert,re} of TEMPLATES){const m=s.match(re);if(!m)continue;const params={};names.forEach((name,i)=>{params[name]=convert[name]?convert[name](m[i+1]):m[i+1];});return t(key,params);}
 return s;
}
