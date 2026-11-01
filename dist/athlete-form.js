/* Athlete step of the sign-up and the athlete form of the "Role" tab (PLAN-REJESTRACJA-ROLE §4.5, §6.1, §10.1, §10.2, §17; UX-1):
 *  - first and required: who is entered (myself / my child or a young athlete in my care) = relation 'self' | 'guardian';
 *  - the athlete's full name, filled from the account's own name only for 'self' (relationChange), never for a child;
 *  - birth date, sex, weight, height, grade type and grade (the ranges of measureFields in app.js and of the server);
 *  - the club through club-picker.js ({id} | {name} | {none:true}); an empty consent slot for the legal session;
 *  - 'self' under 16: the server's own message, which never tells the person to tick the other answer (minorSelf).
 * One athlete profile per account (§17): this form adds the first one or edits it; the interface offers no further profiles.
 * Validation is workspace.js athleteFields (the mirror of Domain::athleteFields), so the messages are the server's.
 * Templates: h`…` only (the values are the person's own data and the club names from public-clubs). */
import {h} from './registry.js';
import {t as T,gradeLabel,translateMessage} from './i18n.js';
import {athleteFields,ageAt,MINOR_SELF_AGE,UNAFFILIATED} from './workspace.js';
import {pickerHtml,readPicker} from './club-picker.js';
import {warsawToday} from './guest-view.js';

export const CLUB_FIELD='athleteClub';
/** The server's messages (Domain athlete.save, §6.1), shown in the form before it is sent. */
export const lockedMessage=()=>T('Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.');
export const minorMessage=()=>T('Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.');
const GRADES={cup:[10,9,8,7,6,5,4,3,2,1],dan:[1,2,3,4,5,6,7,8,9]};

// ---- Pure helpers (tests/account-ui.test.mjs) ----
/** Fields of the form: empty for a new athlete (relation unanswered), or from an AthleteView profile (§7.4) when it is edited.
 * A pending club name (the quota of new clubs was used up) comes back as a new name, so saving tries to create it again; a locked
 * profile (entries in tournaments not yet held) cannot change its club, so athleteBody() sends 'unaffiliated' for it instead. */
export function newAthlete(profile=null){
 if(!profile)return {id:null,relation:null,name:'',birthDate:'',sex:'',weight:'',height:'',gradeType:'cup',grade:'',club:null,prefilled:null,locked:false};
 const c=profile.club||{},club=typeof c.pending==='string'&&c.pending?{name:c.pending}:c.unaffiliated||c.id===UNAFFILIATED?{none:true}:typeof c.id==='string'&&c.id?{id:c.id}:null;
 const n=v=>v==null?'':String(v);
 return {id:String(profile.id),relation:['self','guardian'].includes(profile.relation)?profile.relation:null,name:n(profile.name),birthDate:n(profile.birthDate),sex:['M','F'].includes(profile.sex)?profile.sex:'',
  weight:n(profile.weight),height:n(profile.height),gradeType:profile.gradeType==='dan'?'dan':'cup',grade:n(profile.grade),club,clubName:club?.id&&typeof c.name==='string'?c.name:null,clubVerified:c.verified!==false,prefilled:null,locked:!!profile.locked};
}
/** The account's own full name (first and last name) from sign-up step 2 or the profile; '' without one. */
export const accountName=(first,last)=>[first,last].map(x=>String(x??'').trim()).filter(Boolean).join(' ');
/** The answer to "who is entered" changes (UX-1): 'self' fills an empty name (or one this form filled) with the account's
 * name; 'guardian' removes a name this form filled, so a parent never sends their own name for the child. */
export function relationChange(f,relation,account=''){
 const next={...f,relation:['self','guardian'].includes(relation)?relation:null},name=String(next.name??'').trim(),own=String(account??'').trim();
 if(next.relation==='self'&&own&&(!name||next.name===next.prefilled)){next.name=own;next.prefilled=own;}
 else if(next.relation!=='self'&&next.prefilled&&next.name===next.prefilled){next.name='';next.prefilled=null;}
 return next;
}
/** 'self' with a birth date that makes the person younger than 16 today (§6.1, O3): the form shows minorMessage(). */
export function minorSelf(f,today=warsawToday()){
 if(f?.relation!=='self'||!f.birthDate)return false;
 try{return ageAt(f.birthDate,today)<MINOR_SELF_AGE;}catch{return false;}
}
const num=v=>{const s=String(v??'').trim().replace(',','.');if(s==='')return null;const n=Number(s);return Number.isFinite(n)?n:null;};
/** Body of signup.athlete and athlete-save (§8.2): {name, birthDate, sex, weight, height, gradeType, grade, club, relation};
 * numbers as numbers (a comma is a decimal point), empty fields as null (the server answers with its own message).
 * A locked profile keeps its club: its pending name (the disabled picker shows it as a new name) is sent as {id:'unaffiliated'},
 * the club it has now, so Domain athlete.save sees no club change and keeps pendingClubName (a {name} could create a new club
 * once the daily quota frees up and then be refused as a change of a locked field). */
export function athleteBody(f){
 const club=f?.locked&&typeof f.club?.name==='string'?{id:UNAFFILIATED}:f?.club??null;
 return {name:String(f?.name??'').trim(),birthDate:f?.birthDate||null,sex:['M','F'].includes(f?.sex)?f.sex:null,weight:num(f?.weight),height:num(f?.height),
  gradeType:['cup','dan'].includes(f?.gradeType)?f.gradeType:null,grade:num(f?.grade),club,relation:['self','guardian'].includes(f?.relation)?f.relation:null};
}
/** The first problem of the fields as an Error with the server's message (Domain::athleteFields, translated when shown), or null. */
export function athleteError(f,today=warsawToday()){
 try{athleteFields(athleteBody(f),today);return null;}catch(error){return new Error(String(error?.message||error));}
}
// Every field is checked on its own (final review F4): the field under test with valid stand-ins for the others, so one submit names
// every problem. A problem of the whole (a person under 16 entering themself) comes last, tied to the birth date.
const STAND_IN={relation:'guardian',name:'Ala Test',birthDate:'2000-01-01',sex:'F',weight:40,height:150,gradeType:'cup',grade:1,club:{none:true}};
const FIELD_NAMES={relation:()=>T('kogo zgłaszasz'),name:()=>T('imię i nazwisko'),birthDate:()=>T('data urodzenia'),sex:()=>T('płeć'),weight:()=>T('waga'),height:()=>T('wzrost'),gradeType:()=>T('rodzaj stopnia'),grade:()=>T('stopień'),club:()=>T('klub')};
/** All problems of the fields: [{field, message}] in the order of the form (message: the server's text, translated when shown). */
export function athleteProblems(f,today=warsawToday()){
 const body=athleteBody(f),out=[];
 for(const field of Object.keys(STAND_IN)){
  const probe={...STAND_IN,[field]:body[field]};
  if(field==='grade'&&['cup','dan'].includes(body.gradeType))probe.gradeType=body.gradeType;
  try{athleteFields(probe,today);}catch(error){out.push({field,message:String(error?.message||error)});}
 }
 if(!out.length){const whole=athleteError(f,today);if(whole)out.push({field:'birthDate',message:whole.message});}
 return out;
}
/** One line for the form's alert: the single message, or the names of the fields to check. */
export function problemsSummary(problems){
 if(!problems?.length)return '';
 if(problems.length===1)return translateMessage(problems[0].message);
 return T('Sprawdź pola ({n}): {fields}.',{n:problems.length,fields:problems.map(p=>FIELD_NAMES[p.field]?.()||p.field).join(', ')});
}
const CONTROL={relation:'input[name="relation"]',name:'[name="athleteName"]',birthDate:'[name="birthDate"]',sex:'[name="sex"]',weight:'[name="weight"]',height:'[name="height"]',gradeType:'[name="gradeType"]',grade:'[name="grade"]',club:'[data-club-picker] input,[data-club-picker] select'};
const fieldOf=target=>{const n=target?.name;if(!n)return null;if(n==='athleteName')return 'name';if(target.closest?.('[data-club-picker]'))return 'club';return Object.hasOwn(CONTROL,n)?n:null;};
/** Removes the marks of markAthleteProblems (of one field, or all). */
export function clearAthleteProblems(form,field=null){
 if(!form?.querySelectorAll)return;
 for(const el of form.querySelectorAll('.acct-field-error'))if(!field||el.dataset.field===field)el.remove();
 for(const el of form.querySelectorAll('[aria-invalid]')){
  if(field&&el.dataset.problem!==field)continue;
  el.removeAttribute('aria-invalid');delete el.dataset.problem;
  const ids=(el.getAttribute('aria-describedby')||'').split(' ').filter(x=>x&&!x.includes('-err-'));if(ids.length)el.setAttribute('aria-describedby',ids.join(' '));else el.removeAttribute('aria-describedby');
 }
}
/** Marks every problem at its field (aria-invalid, aria-describedby to a message next to it), focuses the first one and returns
 * the summary for the form's alert. */
export function markAthleteProblems(form,problems){
 clearAthleteProblems(form);let first=null;
 for(const p of problems){
  const controls=[...form.querySelectorAll(CONTROL[p.field]||'[data-none]')];if(!controls.length)continue;
  const id=(form.id||'acct-a')+'-err-'+p.field,note=document.createElement('span');
  note.className='acct-field-error';note.id=id;note.dataset.field=p.field;note.textContent=translateMessage(p.message);
  const host=controls[0].closest('label.field-label')||controls[0].closest('fieldset')||controls[0].parentElement;host.append(note);
  for(const c of controls){c.setAttribute('aria-invalid','true');c.dataset.problem=p.field;c.setAttribute('aria-describedby',[...(c.getAttribute('aria-describedby')||'').split(' ').filter(Boolean),id].join(' '));}
  first??=controls.find(c=>!c.disabled)||null;
 }
 try{first?.focus();}catch{}
 return problemsSummary(problems);
}

// ---- Template ----
const option=(value,label,current)=>h`<option value="${value}"${String(current)===String(value)?h` selected`:''}>${label}</option>`;
export const gradeOptions=(type,current)=>h`<option value=""${current===''||current==null?h` selected`:''}>${T('— wybierz z listy —')}</option>${GRADES[type==='dan'?'dan':'cup'].map(n=>option(n,gradeLabel(n,type==='dan'?'dan':'cup'),current))}`;
/** The fields of the athlete form (inside a <form>). opts: id (prefix of element ids), clubs (for the picker), today. */
export function athleteFieldsHtml(f,{id='acct-a',clubs=[],today=warsawToday()}={}){
 // The profile's own club may be missing from public-clubs (a new, still unverified club): it stays choosable.
 const own=f.club?.id&&f.clubName&&!clubs.some(c=>c?.id===f.club.id)?[...clubs,{id:f.club.id,name:f.clubName,verified:f.clubVerified!==false}]:clubs;
 const locked=!!f.locked,lockAttr=locked?h` disabled aria-describedby="${id}-locked"`:'';
 const relation=[['self',T('Siebie'),T('Zgłaszasz do turniejów siebie.')],['guardian',T('Moje dziecko lub podopiecznego'),T('Jesteś rodzicem lub opiekunem zawodnika.')]];
 return h`<fieldset class="acct-relation" data-acct-relation><legend>${T('Kogo zgłaszasz?')} <span class="acct-req">${T('(wymagane)')}</span></legend><div class="acct-options">${relation.map(([v,label,hint])=>h`<label class="acct-option"><input type="radio" name="relation" value="${v}" required${f.relation===v?h` checked`:''}><span><strong>${label}</strong><small>${hint}</small></span></label>`)}</div></fieldset>
${locked?h`<p class="acct-hint acct-locked" id="${id}-locked">${lockedMessage()}</p>`:''}
<label class="field-label">${T('Imię i nazwisko zawodnika')}<input name="athleteName" maxlength="100" autocomplete="off" required value="${f.name}"></label>
<div class="acct-grid"><label class="field-label">${T('Data urodzenia')}<input name="birthDate" type="date" required min="1900-01-01" max="${today}" value="${f.birthDate}"${lockAttr}></label><label class="field-label">${T('Płeć')}<select name="sex" required${lockAttr}>${option('',T('— wybierz z listy —'),f.sex)}${option('F',T('Kobieta / dziewczynka'),f.sex)}${option('M',T('Mężczyzna / chłopiec'),f.sex)}</select></label></div>
<p class="acct-minor" data-acct-minor aria-live="polite">${minorSelf(f,today)?minorMessage():''}</p>
<div class="acct-grid"><label class="field-label">${T('Waga (kg)')}<input name="weight" type="number" inputmode="decimal" min="10" max="250" step="0.1" required value="${f.weight}"></label><label class="field-label">${T('Wzrost (cm)')}<input name="height" type="number" inputmode="numeric" min="70" max="250" step="1" required value="${f.height}"></label></div>
<div class="acct-grid"><label class="field-label">${T('Rodzaj stopnia')}<select name="gradeType">${option('cup','Cup',f.gradeType)}${option('dan','Dan',f.gradeType)}</select></label><label class="field-label">${T('Stopień')}<select name="grade" required data-acct-grade>${gradeOptions(f.gradeType,f.grade)}</select></label></div>
<div class="acct-club">${pickerHtml({name:CLUB_FIELD,clubs:own,value:f.club,legend:T('Klub'),disabled:locked})}</div>
<p class="acct-hint">${T('Te dane służą do kategorii w turniejach. Zobaczą je organizatorzy turniejów, do których się zgłosisz, i Administrator MatBravo.')}</p>
<div class="acct-consents" data-acct-athlete-consents></div>`;
}
/** Reads the form into f (in place; disabled fields of a locked profile keep their values) and returns f. */
export function readAthlete(form,f){
 const el=form?.elements;if(!el)return f;
 const checked=[...form.querySelectorAll('input[name="relation"]')].find(r=>r.checked);if(checked)f.relation=checked.value;
 if(el.athleteName)f.name=el.athleteName.value;
 for(const k of ['birthDate','sex'])if(el[k]&&!el[k].disabled)f[k]=el[k].value;
 for(const k of ['weight','height','gradeType','grade'])if(el[k])f[k]=el[k].value;
 const picker=form.querySelector('[data-club-picker]');if(picker&&!f.locked)f.club=readPicker(picker);
 return f;
}
/** After an input in the form: the name prefill of "Siebie", the grade list of the grade type and the under-16 message. */
export function syncAthlete(form,f,{account='',today=warsawToday(),target=null}={}){
 if(!form)return f;
 // A change of a field takes its problem mark away (final review F4); the other marks stay until the next submit.
 const changed=fieldOf(target);if(changed){clearAthleteProblems(form,changed);if(changed==='gradeType')clearAthleteProblems(form,'grade');}
 if(target?.name==='relation'){const next=relationChange(f,target.value,account);if(next.name!==f.name&&form.elements.athleteName)form.elements.athleteName.value=next.name;Object.assign(f,next);}
 else{readAthlete(form,f);if(target?.name==='athleteName'&&f.name!==f.prefilled)f.prefilled=null;}
 if(target?.name==='gradeType'){const grade=form.querySelector('[data-acct-grade]');if(grade){const keep=GRADES[f.gradeType==='dan'?'dan':'cup'].includes(Number(f.grade))?f.grade:'';f.grade=keep;grade.replaceChildren(...optionNodes(f.gradeType,keep));}}
 const box=form.querySelector('[data-acct-minor]'),text=minorSelf(f,today)?minorMessage():'';if(box&&box.textContent!==text)box.textContent=text;
 return f;
}
function optionNodes(type,current){
 const make=(value,label)=>{const o=document.createElement('option');o.value=String(value);o.textContent=label;if(String(current)===String(value))o.selected=true;return o;};
 return [make('',T('— wybierz z listy —')),...GRADES[type==='dan'?'dan':'cup'].map(n=>make(n,gradeLabel(n,type==='dan'?'dan':'cup')))];
}
