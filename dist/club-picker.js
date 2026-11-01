/* Club picker (PLAN-REJESTRACJA-ROLE §10.4, UX-12), shared by the organizer's athlete form and check-in (app.js) and the athlete step of
 * the sign-up (athlete-form.js): one radio group "from the list" / "my club is not on the list" / "unaffiliated (no club)" with the field
 * of the chosen option shown below it. "Z listy" is a native <select> below COMBO_THRESHOLD clubs and an ARIA 1.2 combobox from it
 * (text field role=combobox with aria-expanded, aria-controls, aria-activedescendant; listbox of options carrying data-id; filtering
 * by clubKey; arrows, Enter, Escape, Home/End). While a new name is typed, a club with a matching key is offered ("did you mean").
 * The result has the shape Clubs::pick takes: {id}, {name} or {none:true} (null while nothing is chosen).
 * API: pickerHtml(opts) -> SafeHtml; readPicker(root) -> choice; pure helpers listClubs, filterClubs, suggestClub, comboKey, clubChoice.
 * Behaviour comes from listeners on document (CSP: no inline handlers), so a picker works wherever its HTML is inserted. */
import {h,setHtml} from './registry.js';
import {t as T} from './i18n.js';
import {clubKey} from './profile-data.js';

export const COMBO_THRESHOLD=300,UNAFFILIATED='unaffiliated',SHOWN=50;
const collator=(()=>{try{return new Intl.Collator('pl',{sensitivity:'base'});}catch{return null;}})();
const byName=(a,b)=>collator?collator.compare(a.name,b.name):String(a.name).localeCompare(String(b.name));
/** Clubs that can be chosen from the list: not merged into another and not "Niezrzeszony" (its own radio option), sorted by name. */
export const listClubs=clubs=>(Array.isArray(clubs)?clubs:[]).filter(c=>c&&typeof c.id==='string'&&c.id!==UNAFFILIATED&&!c.mergedInto&&typeof c.name==='string').sort(byName);
/** Clubs whose key contains the query's key, those starting with it first; at most limit. An empty query gives the first ones. */
export function filterClubs(list,query,limit=SHOWN){
 const key=clubKey(String(query??''));if(!key)return list.slice(0,limit);
 const starts=[],within=[];for(const c of list){const k=clubKey(c.name);if(k.startsWith(key))starts.push(c);else if(k.includes(key))within.push(c);}
 return [...starts,...within].slice(0,limit);
}
/** The club a typed new name probably means: equal key, else (3+ characters) a key starting with it, else (4+) one containing it. */
export function suggestClub(list,name){
 const key=clubKey(String(name??''));if(key.length<2)return null;
 return list.find(c=>clubKey(c.name)===key)||(key.length>=3?list.find(c=>clubKey(c.name).startsWith(key)):null)||(key.length>=4?list.find(c=>clubKey(c.name).includes(key)):null)||null;
}
/** Keyboard of the combobox (ARIA APG, editable combobox with list autocomplete). state {open, active (-1 none), count}; returns the next
 * state with handled (prevent the default), pick (index chosen with Enter) and clear (Escape on a closed list empties the field). */
export function comboKey(state,key){
 const {open=false,active=-1,count=0}=state||{},last=count-1,out={open,active,count,handled:false,pick:null,clear:false};
 if(key==='ArrowDown'){out.handled=true;if(!count)return {...out,open:true};return {...out,open:true,active:!open||active<0?0:Math.min(active+1,last)};}
 if(key==='ArrowUp'){out.handled=true;if(!count)return {...out,open:true};return {...out,open:true,active:!open||active<0?last:Math.max(active-1,0)};}
 if((key==='Home'||key==='End')&&open&&count)return {...out,handled:true,active:key==='Home'?0:last};
 if(key==='Enter'&&open&&active>=0&&active<count)return {...out,handled:true,open:false,pick:active};
 if(key==='Escape'){if(open)return {...out,handled:true,open:false,active:-1};return {...out,handled:true,clear:true};}
 return out;
}
/** Choice from the picker's values: mode 'list' with an id, 'new' with a name, 'none'; null while incomplete. */
export function clubChoice({mode,id,name}={}){
 if(mode==='none')return {none:true};
 if(mode==='new'){const n=String(name??'').trim();return n?{name:n}:null;}
 if(mode==='list'){if(id===UNAFFILIATED)return {none:true};return typeof id==='string'&&id!==''?{id}:null;}
 return null;
}
const initialMode=(value,list,allowNew)=>value?.none===true||value===UNAFFILIATED||value?.id===UNAFFILIATED?'none':allowNew&&typeof value?.name==='string'&&value.name?'new':'list';
const initialId=value=>typeof value==='string'?value:typeof value?.id==='string'?value.id:'';

/** The picker. opts: name (field prefix, default 'club'), clubs, value ({id}|{name}|{none:true}|clubId), allowNew (default true),
 * threshold (combobox from this many clubs), legend, disabled. Field names: <name>Mode, <name>Id, <name>Name. */
export function pickerHtml({name='club',clubs=[],value=null,allowNew=true,threshold=COMBO_THRESHOLD,legend=null,disabled=false}={}){
 const list=listClubs(clubs);lastClubs.set(String(name),list);const mode=initialMode(value,list,allowNew),id=initialId(value),pid='cp-'+String(name).replace(/[^\w-]/g,''),combo=list.length>=threshold;
 const current=list.find(c=>c.id===id)||null,modes=[['list',T('Z listy')],...(allowNew?[['new',T('Mojego klubu nie ma na liście')]]:[]),['none',T('Niezrzeszony (bez klubu)')]];
 const radios=modes.map(([v,label])=>h`<label class="cp-mode"><input type="radio" name="${name}Mode" value="${v}"${mode===v?h` checked`:''}${disabled?h` disabled`:''} data-cp-mode><span>${label}</span></label>`);
 const listField=combo
  ?h`<label class="cp-label" for="${pid}-input">${T('Wybierz klub')}</label><div class="cp-combo"><input id="${pid}-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${pid}-list" autocomplete="off" spellcheck="false" maxlength="100" value="${current?.name||''}" placeholder="${T('Wpisz nazwę klubu')}"${disabled?h` disabled`:''} data-cp-input><ul id="${pid}-list" class="cp-list" role="listbox" aria-label="${T('Kluby')}" hidden data-cp-list></ul><input type="hidden" name="${name}Id" value="${current?.id||''}" data-cp-value></div><span class="sr-only" aria-live="polite" data-cp-status></span>`
  :h`<label class="cp-label" for="${pid}-select">${T('Wybierz klub')}</label><select id="${pid}-select" name="${name}Id"${disabled?h` disabled`:''} data-cp-select><option value="">${T('— wybierz klub —')}</option>${list.map(c=>h`<option value="${c.id}"${c.id===current?.id?h` selected`:''}>${c.name}${c.verified===false?' · '+T('niezweryfikowany'):''}</option>`)}</select>`;
 const newField=allowNew?h`<div class="cp-panel" data-cp-panel="new"${mode==='new'?'':h` hidden`}><label class="cp-label" for="${pid}-name">${T('Nazwa nowego klubu')}</label><input id="${pid}-name" name="${name}Name" maxlength="100" autocomplete="off" value="${mode==='new'?value.name:''}"${disabled?h` disabled`:''} data-cp-name><p class="cp-match" data-cp-match hidden></p><p class="cp-hint">${T('Nowy klub zapiszemy jako niezweryfikowany. Administrator MatBravo sprawdzi nazwę.')}</p></div>`:'';
 return h`<fieldset class="club-picker span-two" data-club-picker data-name="${name}" data-threshold="${threshold}"><legend>${legend||T('Klub')}</legend><div class="cp-modes">${radios}</div><div class="cp-panel" data-cp-panel="list"${mode==='list'?'':h` hidden`}>${listField}</div>${newField}<div class="cp-panel" data-cp-panel="none"${mode==='none'?'':h` hidden`}><p class="cp-hint">${T('Zawodnik startuje bez klubu. Osób niezrzeszonych nie rozdzielamy w losowaniu.')}</p></div></fieldset>`;
}

// ---- Behaviour (document listeners; state lives in the DOM) ----
const clubsOf=new WeakMap(),lastClubs=new Map();// lastClubs: the list of the latest pickerHtml per field name (the combobox has no <option>s)
/** Clubs of a mounted picker: given by the caller once (attach) or read back from the native select. */
export function attach(root,clubs){if(root)clubsOf.set(root,listClubs(clubs));return root;}
const pickerOf=el=>el?.closest?.('[data-club-picker]')||null;
const listOf=root=>clubsOf.get(root)||[];
/** The choice of a picker element (the fieldset or any element inside it). */
export function readPicker(el){
 const root=pickerOf(el)||el?.querySelector?.('[data-club-picker]');if(!root)return null;
 const mode=root.querySelector('[data-cp-mode]:checked')?.value,field=root.querySelector('[data-cp-select],[data-cp-value]');
 return clubChoice({mode,id:field?.value??'',name:root.querySelector('[data-cp-name]')?.value??''});
}
function showMode(root,mode){for(const panel of root.querySelectorAll('[data-cp-panel]'))panel.hidden=panel.dataset.cpPanel!==mode;}
function setOpen(input,open){const list=input.parentElement.querySelector('[data-cp-list]');input.setAttribute('aria-expanded',String(open));list.hidden=!open;if(!open)input.removeAttribute('aria-activedescendant');}
function options(input){return [...input.parentElement.querySelectorAll('[data-cp-list] [role="option"]')];}
function setActive(input,index){
 const opts=options(input);opts.forEach((o,i)=>o.setAttribute('aria-selected',String(i===index)));
 if(index>=0&&opts[index]){input.setAttribute('aria-activedescendant',opts[index].id);opts[index].scrollIntoView?.({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
}
function fill(input){
 const root=pickerOf(input),list=root.querySelector('[data-cp-list]'),found=filterClubs(listOf(root),input.value),status=root.querySelector('[data-cp-status]');
 setHtml(list,found.length?h`${found.map((c,i)=>h`<li id="${list.id}-o${i}" role="option" aria-selected="false" data-id="${c.id}">${c.name}${c.verified===false?h` <small>${T('niezweryfikowany')}</small>`:''}</li>`)}`:h`<li class="cp-empty" role="presentation">${T('Brak pasujących klubów.')}</li>`);
 if(status)status.textContent=T('{n} klubów',{n:found.length});
}
function choose(input,option){
 const root=pickerOf(input),value=root.querySelector('[data-cp-value]'),club=listOf(root).find(c=>c.id===option?.dataset.id);
 if(!club)return;value.value=club.id;input.value=club.name;setOpen(input,false);input.dispatchEvent(new Event('change',{bubbles:true}));
}
function selectClub(root,id){
 const radio=root.querySelector('[data-cp-mode][value="list"]');if(radio){radio.checked=true;showMode(root,'list');}
 const select=root.querySelector('[data-cp-select]');
 if(select){select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));select.focus();return;}
 const input=root.querySelector('[data-cp-input]'),club=listOf(root).find(c=>c.id===id);if(!input||!club)return;
 root.querySelector('[data-cp-value]').value=club.id;input.value=club.name;input.focus();input.dispatchEvent(new Event('change',{bubbles:true}));
}
function suggest(input){
 const root=pickerOf(input),box=root.querySelector('[data-cp-match]');if(!box)return;
 const club=suggestClub(listOf(root),input.value);
 if(!club){box.hidden=true;setHtml(box,h``);return;}
 setHtml(box,h`<span>${T('Czy chodzi o: {name}?',{name:club.name})}</span> <button type="button" class="btn secondary small-btn" data-cp-use="${club.id}">${T('Wybierz ten klub')}</button>`);box.hidden=false;
}
const readOptions=root=>[...root.querySelectorAll('[data-cp-select] option')].filter(o=>o.value).map(o=>({id:o.value,name:o.textContent.replace(/ · .*$/,'')}));
const state=input=>{const opts=options(input);return {open:input.getAttribute('aria-expanded')==='true',active:opts.findIndex(o=>o.getAttribute('aria-selected')==='true'),count:opts.length};};
function ensureClubs(root){if(!clubsOf.has(root))clubsOf.set(root,root.querySelector('[data-cp-select]')?readOptions(root):lastClubs.get(root.dataset.name)||[]);}

if(typeof document!=='undefined'){
 document.addEventListener('change',event=>{const el=event.target;if(!el.matches?.('[data-cp-mode]'))return;const root=pickerOf(el);showMode(root,el.value);});
 document.addEventListener('input',event=>{
  const el=event.target,root=pickerOf(el);if(!root)return;ensureClubs(root);
  if(el.matches('[data-cp-input]')){root.querySelector('[data-cp-value]').value='';const exact=listOf(root).find(c=>clubKey(c.name)===clubKey(el.value));if(exact)root.querySelector('[data-cp-value]').value=exact.id;fill(el);setOpen(el,true);setActive(el,-1);}
  else if(el.matches('[data-cp-name]'))suggest(el);
 });
 document.addEventListener('keydown',event=>{
  const el=event.target;if(!el.matches?.('[data-cp-input]')||event.altKey||event.ctrlKey||event.metaKey)return;
  ensureClubs(pickerOf(el));const before=state(el);if(!before.open&&(event.key==='ArrowDown'||event.key==='ArrowUp'))fill(el);
  const next=comboKey(state(el),event.key);if(!next.handled)return;
  event.preventDefault();if(event.key==='Escape'&&before.open)event.stopPropagation();// Escape closes the list, not the dialog around it
  if(next.clear){el.value='';pickerOf(el).querySelector('[data-cp-value]').value='';return;}
  if(next.pick!==null){choose(el,options(el)[next.pick]);return;}
  setOpen(el,next.open);setActive(el,next.active);
 },true);
 document.addEventListener('pointerdown',event=>{if(event.target.closest?.('[data-cp-list] [role="option"]'))event.preventDefault();});// keeps the focus in the field
 document.addEventListener('click',event=>{
  const option=event.target.closest?.('[data-cp-list] [role="option"]');
  if(option){ensureClubs(pickerOf(option));const input=pickerOf(option).querySelector('[data-cp-input]');choose(input,option);input.focus();return;}
  const use=event.target.closest?.('[data-cp-use]');if(use){const root=pickerOf(use);ensureClubs(root);selectClub(root,use.dataset.cpUse);}
 });
 document.addEventListener('focusout',event=>{const el=event.target;if(el.matches?.('[data-cp-input]')&&!el.parentElement.contains(event.relatedTarget))setOpen(el,false);});
}
