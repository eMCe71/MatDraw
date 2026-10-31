/* Community state of the signed-in person ("me", plan §4.3 and §8.5): profile, access, billing and feature flags.
 * API mode: GET me after 'ready' and 'login', after the tab becomes visible again (at most every 5 minutes) and after a payment
 * prompt (402). A server without the me route (404) means community features are off, without an error message.
 * Demo mode: the demo accounts are staff/free with complete fictional profiles; edits stay in localStorage.
 * Sign-out on a shared device: purgeSession() clears per-tab drafts and tells other tabs ('reset' on the BroadcastChannel). */
import {registry} from './registry.js';
import * as Client from './client.js';

const REFRESH_MS=300000,CHANNEL='matbravo-session',PURGE=/^matdraw\.(?:chat|signup|billing)\./;
let me=null,loadedAt=0,pending=null,disabled=false,generation=0;
const listeners=new Set();
const workspace=()=>{try{return registry.use('ui')?.getWorkspace?.()||null;}catch{return null;}};
function set(next){me=next;for(const fn of [...listeners]){try{fn(me);}catch(error){try{console.error('MatBravo me listener failed',error);}catch{}}}}

// Demo accounts (plan §8.5): complete profiles, so a demo account can post at once; edits in localStorage['matdraw.profile.demo.<userId>'].
const DEMO_PROFILES={
 'demo-admin':{publicId:'DemoAdmin001',username:'anna.demo',firstName:'Anna',lastName:'Demo',sports:['taekwondo'],clubText:'Klub Demo'},
 'demo-editor':{publicId:'DemoEditor01',username:'piotr.demo',firstName:'Piotr',lastName:'Nowak',sports:['taekwondo'],clubText:'Klub Demo'},
 'demo-club':{publicId:'DemoClub0001',username:'ola.demo',firstName:'Ola',lastName:'Testowa',sports:['taekwondo','karate'],clubText:'Klub Demo'}
};
export const demoProfileKey=userId=>'matdraw.profile.demo.'+userId;
function demoStored(userId){try{const raw=localStorage.getItem(demoProfileKey(userId));const value=raw?JSON.parse(raw):null;return value&&typeof value==='object'?value:{};}catch{return {};}}
function demoMe(user){
 if(!user)return null;
 const base={publicId:'Demo'+String(user.id).replace(/[^A-Za-z0-9]/g,'').slice(-8).padStart(8,'0'),username:'demo',firstName:'Demo',lastName:'Konto',sports:['taekwondo'],clubText:null,...DEMO_PROFILES[user.id]};
 const stored=demoStored(user.id),profile={country:'PL',showClub:false,nameDisplay:'initial',avatar:null,usernameChangeAt:null,mustChangePassword:false,...base,...stored,publicId:base.publicId,complete:true};
 return {user:{id:user.id,clubId:user.clubId??null,email:user.email,role:user.role,active:true},profile,
  access:{full:true,state:user.role==='admin'?'staff':'free',until:null,canPost:true,block:null,mutedUntil:null},
  billing:{enabled:false},features:{signup:false,avatars:'data-url',chat:true},demo:true};
}
/** Demo only: saves profile fields for the signed-in demo account and refreshes me. */
export function saveDemoProfile(patch){
 if(!Client.isDemo||!me)throw new Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.');
 const {publicId:_,complete:__,...fields}=patch||{};const next={...demoStored(me.user.id),...fields};
 try{localStorage.setItem(demoProfileKey(me.user.id),JSON.stringify(next));}catch{}
 set(demoMe(me.user));return me;
}

/** Loads me (deduplicated). Resolves to me or null; never throws: errors keep the previous state. */
export function loadMe({force=false}={}){
 const ws=workspace();
 if(!ws?.user){loadedAt=0;if(me)set(null);return Promise.resolve(null);}
 if(Client.isDemo){set(demoMe(ws.user));loadedAt=Date.now();return Promise.resolve(me);}
 if(disabled)return Promise.resolve(null);
 if(pending)return pending;
 if(!force&&me&&Date.now()-loadedAt<REFRESH_MS)return Promise.resolve(me);
 const ticket=generation;
 pending=Client.request('me').then(data=>{if(ticket===generation){loadedAt=Date.now();set(data&&typeof data==='object'?data:null);}return me;},error=>{
  if(ticket!==generation)return me;
  if(error?.status===404){disabled=true;set(null);}
  else if(error?.status===401){loadedAt=0;set(null);}
  return me;
 }).finally(()=>{pending=null;});
 return pending;
}
export const getMe=()=>me;
/** fn(me) after every change; returns an unsubscribe function. */
export function onMe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
export const canPost=()=>!!me?.access?.canPost;
export const access=()=>me?.access||null;
/** Whether the server has community features (false after a 404 on me). */
export const available=()=>!disabled;
/** Per-person localStorage key (plan §8.3 point 16): '<prefix>.u.<publicId>.<name>', or null when nobody is signed in. */
export const personKey=(prefix,name)=>me?.profile?.publicId?prefix+'.u.'+me.profile.publicId+'.'+name:null;

function forget(){generation++;pending=null;loadedAt=0;if(me)set(null);}
let channel=null;
try{if(typeof BroadcastChannel==='function'){channel=new BroadcastChannel(CHANNEL);channel.onmessage=event=>{if(event?.data==='reset'||event?.data?.type==='reset'){forget();registry.emit('logout',{remote:true});try{location.reload();}catch{}}};}}catch{channel=null;}
/** After sign-out: drop me, per-tab drafts and keys (matdraw.chat.*, matdraw.signup.*, matdraw.billing.* in sessionStorage)
 * and tell the other tabs to reset and reload. */
export function purgeSession(){
 forget();
 try{const keys=[];for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key&&PURGE.test(key))keys.push(key);}for(const key of keys)sessionStorage.removeItem(key);}catch{}
 try{channel?.postMessage({type:'reset'});}catch{}
}

registry.on('ready',()=>{loadMe();});
registry.on('login',()=>{forget();loadMe({force:true});});
registry.on('logout',()=>{forget();});
registry.on('payment-required',()=>{loadMe({force:true});});
try{document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&me&&Date.now()-loadedAt>=REFRESH_MS)loadMe({force:true});});}catch{}

export const meState={loadMe,getMe,onMe,canPost,access,available,personKey,purgeSession,saveDemoProfile,demoProfileKey};
