// Contracts between slices over real HTTP, PHP and MariaDB/MySQL (plan §11, §12.15 integration-qa; run through
// scripts/test-http.sh with the Stripe stub). Each scenario crosses at least two slices through their public routes:
//  - payment (billing-checkout → stub → billing-confirm) opens chat-send, and me.access.block follows the chat-send order;
//  - a mute of the moderation panel (ChatModeration::mutedUntil/mutedIds) reaches me, chat-send and the muted filter of
//    admin-members; the temporary password of admin-member wins over the mute (payment > profile > password > muted);
//  - admin-member: a free account with a temporary password must change it before the chat; a reset ends every session;
//  - me.billing.currency follows Billing::currencyFor: the profile country, the Admin's override, an ongoing subscription;
//  - diagnostics?probe=stripe runs StripeClient::probe against the stub without sending a key;
//  - account deletion (own and the Admin's) turns messages into tombstones with new revs (Chat::tombstoneUser): no
//    author, no text and no people entry for members and guests;
//  - privacy sweep: members with distinctive e-mails, usernames, names, clubs and public_ids write messages, then every
//    public or guest answer (public, public-tournament, public-config, public-chat-channels, public-chat with every
//    parameter, session, chat-feed of a non-paying member, avatar for a guest) is searched, body and headers, for them.
import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Client,base,fixture} from './helpers/http-client.mjs';
const shared=process.env.MATDRAW_TEST_SHARED_DIR,skip=!base||!shared;
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!',NEW_PASSWORD='Integration-Password-2026';
const stubBase=base?`http://127.0.0.1:${Number(new URL(base).port)+1}`:'';
const GUEST_FIELDS=['id','r','t','g','c','b'],GUEST_TOMB=['id','r','t','g','x'];
const letters=n=>Array.from(randomBytes(n),b=>'abcdefghijklmnopqrstuvwxyz'[b%26]).join('');
const RUN=letters(6);let seq=0;
const cid=()=>randomBytes(16).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);

/** GET with query parameters and an optional cookie; never stores cookies. text is the raw body. */
async function get(route,params={},cookie){
 const qs=new URLSearchParams(params).toString();
 const r=await fetch(base+'?route='+route+(qs?'&'+qs:''),{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{})}});
 const text=r.status===204?'':await r.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
 return {status:r.status,headers:r.headers,data,text};
}
const fresh=async()=>{const c=new Client();await c.req('session');return c;};
async function signIn(email,password=PASSWORD){const c=await fresh();const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;}
async function me(c){const r=await get('me',{},c.cookie);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
const send=(c,target,b)=>c.req('chat-send',{...target,cid:cid(),b});
const error=(r,status,message)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(message)assert.equal(r.data.error,message);};
const stub=async body=>{const r=await fetch(stubBase+'/__control',{method:'POST',body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;};
const since=async(t,method,re)=>(await stub({op:'requests'})).filter(x=>x.at>=t&&(!method||x.method===method)&&(!re||re.test(x.path)));
/** A member from the fixture: complete profile (overrides in profile; false = none), exempt (free, full access) unless exempt:false. */
function member(tag,{profile={},exempt=true,...extra}={}){
 const email=`zq.${tag}.${RUN}${++seq}@integration.example`;
 const full=profile===false?false:{firstName:'Test',lastName:'Integracja',country:'PL',sports:['taekwondo'],...profile};
 return {...fixture('member',{email,password:PASSWORD,profile:full,exempt,...extra}),email};
}
/** A member who has paid through Checkout on the stub (billing-checkout → pay → billing-confirm). */
async function pay(c){
 const r=await c.req('billing-checkout',{});assert.equal(r.status,200,JSON.stringify(r.data));
 const sessionId=new URL(r.data.url).pathname.split('/').pop();await stub({op:'pay',sessionId});
 const ok=await c.req('billing-confirm',{sessionId});assert.equal(ok.status,200,JSON.stringify(ok.data));return ok.data;
}
const adminList=async body=>{const r=await admin.req('admin-members',{filter:'all',page:1,...body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const adminMember=async(body,status=200)=>{const r=await admin.req('admin-member',body);assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
const moderate=async body=>{const r=await admin.req('admin-chat-action',body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const channel=slug=>fixture('chat-channel',{slug});
let admin,general;

before(async()=>{
 if(skip)return;
 fixture('reset-limits');fixture('billing-kv',{set:{stripe_down_until:null}});
 // The send pace is tested by chat.http.test.mjs; here it would only slow the scenarios down.
 fixture('chat-settings',{set:{send:{gap:0,perMin:1000,perDay:100000}}});
 admin=await signIn(...ADMIN);general=channel('general');
});
beforeEach(()=>fixture('reset-limits'));
after(()=>{if(!skip)fixture('chat-settings',{reset:true});});

test('payment opens the chat: 402 and block payment before Checkout, chat-send after billing-confirm',{skip},async()=>{
 const m=member('pay',{exempt:false}),c=await signIn(m.email);
 let a=(await me(c)).access;assert.deepEqual([a.full,a.state,a.block,a.canPost],[false,'none','payment',false]);
 error(await send(c,{ch:general.id},'Przed płatnością'),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 const confirmed=await pay(c);assert.deepEqual([confirmed.access.full,confirmed.access.state,confirmed.status],[true,'active','active']);
 a=(await me(c)).access;assert.deepEqual([a.full,a.state,a.block,a.canPost],[true,'active',null,true]);
 const r=await send(c,{ch:general.id},'Po płatności');assert.equal(r.status,200,JSON.stringify(r.data));
 const pid=(await me(c)).profile.publicId;assert.equal(r.data.m.a,pid);assert.equal(r.data.people[pid].n,'Test I.','the default initial (§7.6)');
 // The order of me.access.block is the order of the chat-send checks: payment first, also for an incomplete profile.
 const both=member('order',{exempt:false,profile:false}),cb=await signIn(both.email);
 assert.equal((await me(cb)).access.block,'payment');error(await send(cb,{ch:general.id},'x'),402);
 fixture('billing',{userId:both.id,billing_exempt:1,exempt_reason:'test',exempt_at:now()});
 assert.equal((await me(cb)).access.block,'profile');error(await send(cb,{ch:general.id},'x'),403,'Uzupełnij profil, aby pisać na czacie.');
});

test('mute: the moderation panel reaches me (block, mutedUntil), chat-send and the muted filter of admin-members',{skip},async()=>{
 const m=member('mute'),c=await signIn(m.email),list=()=>adminList({q:m.email,filter:'muted'});
 assert.equal((await send(c,{ch:general.id},'Zanim wyciszą')).status,200);
 const {until}=await moderate({action:'mute',userId:m.id,duration:'1h',reason:'test integracji'});
 assert.ok(until>=now()+3500&&until<=now()+3700,String(until));
 let a=(await me(c)).access;assert.deepEqual([a.block,a.mutedUntil,a.canPost,a.full],['muted',until,false,true]);
 let r=await send(c,{ch:general.id},'Wyciszony');error(r,403,'Moderator wstrzymał Twoje pisanie.');assert.equal(r.data.until,until);
 let l=await list();assert.deepEqual([l.total,l.items[0].id,l.items[0].muted,l.items[0].mutedUntil],[1,m.id,true,until]);
 assert.deepEqual((await adminList({q:m.email})).items.map(i=>[i.id,i.muted,i.mutedUntil]),[[m.id,true,until]],'the flag on the plain list too');
 // Without an end: muted, but no date.
 await moderate({action:'mute',userId:m.id,duration:'perm'});
 a=(await me(c)).access;assert.deepEqual([a.block,a.mutedUntil],['muted',null]);
 r=await send(c,{ch:general.id},'x');error(r,403);assert.equal(r.data.until,null);
 l=await list();assert.deepEqual([l.items[0].muted,l.items[0].mutedUntil],[true,null]);
 // A temporary password comes before the mute in the block order; the forced redirect follows mustChangePassword.
 const {temporaryPassword}=await adminMember({action:'password',userId:m.id});
 assert.equal((await get('me',{},c.cookie)).status,401,'the reset ended the session');
 const c2=await signIn(m.email,temporaryPassword);const p=await me(c2);
 assert.deepEqual([p.access.block,p.access.mutedUntil,p.profile.mustChangePassword],['password',null,true]);
 error(await send(c2,{ch:general.id},'x'),403,'Najpierw zmień hasło tymczasowe.');
 assert.equal((await c2.req('member-password',{currentPassword:temporaryPassword,password:NEW_PASSWORD})).status,200);
 assert.equal((await me(c2)).access.block,'muted','after the change the mute is the reason again');
 await moderate({action:'unmute',userId:m.id});
 a=(await me(c2)).access;assert.deepEqual([a.block,a.mutedUntil,a.canPost],[null,null,true]);
 assert.equal((await send(c2,{ch:general.id},'Znowu mogę')).status,200);
 assert.equal((await list()).total,0);
 // An expired mute is no mute for any reader (fixture: until in the past).
 fixture('chat-mute',{userId:m.id,untilAt:now()-5});
 assert.equal((await me(c2)).access.block,null);assert.equal((await list()).total,0);assert.equal((await adminList({q:m.email})).items[0].muted,false);
 fixture('chat-mute',{userId:m.id,remove:true});
});

test('admin-member: a free account with a temporary password changes it before writing; a reset ends the sessions',{skip},async()=>{
 const email=`zq.free.${RUN}@integration.example`,username='zqfree'+RUN;
 const made=await adminMember({action:'create',email,firstName:'Bożydar',lastName:'Wolny',username,country:'PL',sports:['karate'],free:true,reason:'Klub partnerski'});
 assert.deepEqual(Object.keys(made).sort(),['id','temporaryPassword']);assert.match(made.temporaryPassword,/^[A-HJ-NP-Za-km-z2-9]{16}$/);
 const item=(await adminList({q:email})).items[0];
 assert.deepEqual([item.id,item.username,item.billing.state,item.billing.exempt,item.billing.reason],[made.id,username,'free',true,'Klub partnerski']);
 const c=await signIn(email,made.temporaryPassword);let m=await me(c);
 assert.deepEqual([m.access.full,m.access.state,m.profile.mustChangePassword,m.profile.complete,m.access.block],[true,'free',true,true,'password']);
 assert.equal(m.billing.exempt,true);
 error(await send(c,{ch:general.id},'Hasło tymczasowe'),403,'Najpierw zmień hasło tymczasowe.');
 const changed=await c.req('member-password',{currentPassword:made.temporaryPassword,password:NEW_PASSWORD});assert.equal(changed.status,200,JSON.stringify(changed.data));
 m=await me(c);assert.deepEqual([m.profile.mustChangePassword,m.access.block,m.access.canPost],[false,null,true]);
 const r=await send(c,{ch:general.id},'Już po zmianie hasła');assert.equal(r.status,200,JSON.stringify(r.data));
 // A reset by the Admin: every session ends, the old password is gone, the new temporary one forces a change again.
 const reset=await adminMember({action:'password',userId:made.id});assert.notEqual(reset.temporaryPassword,made.temporaryPassword);
 assert.equal((await get('me',{},c.cookie)).status,401);
 assert.equal((await (await fresh()).req('login',{email,password:NEW_PASSWORD})).status,401);
 assert.equal((await me(await signIn(email,reset.temporaryPassword))).profile.mustChangePassword,true);
 const audit=fixture('accounts-state',{userId:made.id}).audit.map(x=>x.action);assert.deepEqual(audit,['create','password.reset']);
 // A blocked account cannot sign in, not even with a valid temporary password.
 await adminMember({action:'active',userId:made.id,active:false});
 assert.equal((await (await fresh()).req('login',{email,password:reset.temporaryPassword})).status,401);
});

test('me.billing.currency follows Billing::currencyFor: profile country, the Admin override, then the ongoing subscription',{skip},async()=>{
 const m=member('cur',{exempt:false}),c=await signIn(m.email),currency=async()=>(await me(c)).billing.currency;
 const profile={firstName:'Test',lastName:'Integracja',username:'zqcur'+RUN,country:'DE',sports:['taekwondo'],clubText:null,showClub:false,nameDisplay:'initial'};
 assert.equal(await currency(),'pln','country PL');
 const p=await c.req('profile',profile);assert.equal(p.status,200,JSON.stringify(p.data));assert.equal(await currency(),'usd','country DE (profile route of accounts)');
 const override=async(cur,status=200)=>{const r=await admin.req('admin-billing-action',{action:'currency',userId:m.id,currency:cur});assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 assert.equal((await override('pln')).account.currencyOverride,'pln');assert.equal(await currency(),'pln','the override beats the country');
 assert.equal((await override(null)).account.currencyOverride,null);assert.equal(await currency(),'usd');
 await override('pln');
 // Checkout uses the same rule: the price of the overridden currency, never one chosen by the client.
 const t=Date.now();const paid=await pay(c);assert.equal(paid.billing.currency,'pln');
 const [session]=await since(t,'POST',/^\/v1\/checkout\/sessions$/);
 const pricesById=Object.fromEntries(Object.values((await stub({op:'state'})).prices).map(x=>[x.id,x.lookup_key]));
 assert.equal(pricesById[session.body.line_items[0].price],'matbravo_monthly_pln');
 assert.equal(await currency(),'pln');
 assert.equal((await override('usd',409)).error,'Nie można zmienić waluty trwającej subskrypcji.');
 assert.equal((await c.req('profile',{...profile,country:'US'})).status,200);assert.equal(await currency(),'pln','the subscription currency wins over the country');
 assert.equal(fixture('billing-audit',{userId:m.id,action:'currency.set'}).length,3);
});

test('diagnostics: StripeClient::probe of the billing slice through the Admin route, against the stub and without a key',{skip},async()=>{
 const plain=await get('diagnostics',{},admin.cookie);assert.equal(plain.status,200,JSON.stringify(plain.data));assert.equal(plain.data.stripe,null,'no probe unless asked');
 assert.deepEqual(plain.data.billing,{enabled:true,mode:'test'});assert.equal(plain.data.chat.on,true);
 const t=Date.now();const r=await get('diagnostics',{probe:'stripe'},admin.cookie);assert.equal(r.status,200,JSON.stringify(r.data));
 const {stripe}=r.data;assert.deepEqual([stripe.reachable,stripe.status,stripe.error],[true,401,null]);assert.ok(Number.isInteger(stripe.ms)&&stripe.ms>=0);
 const probes=await since(t,'GET',/^\/v1\/charges$/);assert.equal(probes.length,1);assert.deepEqual([probes[0].probe,probes[0].authorization],[true,null],'the probe never sends a key');
 for(const v of Object.values(r.data))assert.ok(!JSON.stringify(v).includes('rk_test'),'no secret in diagnostics');
 // The probe measures reachability itself: the background circuit breaker (stripe_down_until) does not stop it.
 fixture('billing-kv',{set:{stripe_down_until:String(now()+600)}});
 try{assert.equal((await get('diagnostics',{probe:'stripe'},admin.cookie)).data.stripe.reachable,true);}
 finally{fixture('billing-kv',{set:{stripe_down_until:null}});}
});

test('account deletion: messages become tombstones with new revs; no author, text or people entry for members and guests',{skip},async()=>{
 const author=member('del',{profile:{firstName:'Wiesława',lastName:'Usuwalska',username:'zqdel'+RUN,nameDisplay:'full'}});
 const reader=member('reader'),ca=await signIn(author.email),cr=await signIn(reader.email);
 const start=channel('general').rev;
 for(const b of ['Pierwsza do usunięcia','Druga do usunięcia'])assert.equal((await send(ca,{ch:general.id},b)).status,200);
 const sent=channel('general').rev;
 let f=await get('chat-feed',{ch:`${general.id}:${start}`},cr.cookie);assert.equal(f.status,200,f.text);
 let mine=f.data.ch[general.id].m.filter(x=>x.a===author.publicId);assert.equal(mine.length,2);
 assert.deepEqual([f.data.people[author.publicId].n,f.data.people[author.publicId].u],['Wiesława Usuwalska','zqdel'+RUN]);
 const ids=mine.map(x=>x.id);
 const del=await ca.req('account-delete',{password:PASSWORD});assert.equal(del.status,200,JSON.stringify(del.data));
 assert.equal((await get('me',{},ca.cookie)).status,401);assert.equal((await (await fresh()).req('login',{email:author.email,password:PASSWORD})).status,401);
 // Member view: the two messages again, each with a new rev above the cursor, as tombstones without an author.
 f=await get('chat-feed',{ch:`${general.id}:${sent}`},cr.cookie);assert.equal(f.status,200,f.text);
 const tombs=f.data.ch[general.id].m.filter(x=>ids.includes(x.id));assert.equal(tombs.length,2);
 for(const x of tombs){assert.deepEqual(Object.keys(x),['id','r','t','x']);assert.equal(x.x,'author');assert.ok(x.r>sent);}
 assert.ok(!(author.publicId in f.data.people));
 for(const s of [author.email,author.publicId,'Usuwalska','Wiesława','zqdel'+RUN,author.id])assert.ok(!f.text.includes(s),'member feed leaks '+s);
 // Guest view: the same tombstones in the guest shape.
 const g=await get('public-chat',{ch:`${general.id}:${sent}`});assert.equal(g.status,200);
 for(const x of g.data.ch[general.id].m.filter(x=>ids.includes(x.id)))assert.deepEqual([Object.keys(x),x.x],[GUEST_TOMB,'author']);
 for(const id of ids){const row=fixture('chat-message',{id});assert.deepEqual([row.state,row.body],['deleted_author','']);}
 const state=fixture('accounts-state',{userId:author.id});
 assert.deepEqual([state.user.email,state.user.active,state.profile],[`deleted+${author.id}@invalid.matbravo`,0,null]);
 // The Admin's delete of another member goes through the same path.
 const other=member('admindel'),co=await signIn(other.email);
 const r=await send(co,{ch:general.id},'Usunie mnie Administrator');assert.equal(r.status,200);const before=channel('general').rev;
 assert.deepEqual(await adminMember({action:'delete',userId:other.id}),{id:other.id,deleted:true});
 f=await get('chat-feed',{ch:`${general.id}:${before}`},cr.cookie);
 assert.deepEqual(f.data.ch[general.id].m.filter(x=>x.id===r.data.m.id).map(x=>[x.x,'a' in x]),[['author',false]]);
 assert.equal((await adminList({q:other.email})).total,0,'a deleted account leaves the member list');
});

test('privacy sweep: no public or guest answer carries an e-mail, username, name, club, public_id or internal id',{skip},async()=>{
 const people=[
  member('priv1',{profile:{firstName:'Zq'+letters(7),lastName:'Xq'+letters(8),username:'zqp1'+RUN,nameDisplay:'full',showClub:true,clubText:'Klub Zq'+letters(9)}}),
  member('priv2',{profile:{firstName:'Zq'+letters(7),lastName:'Xq'+letters(8),username:'zqp2'+RUN,country:'DE',sports:['karate','judo']}}),
  member('priv3',{profile:{firstName:'Zq'+letters(7),lastName:'Xq'+letters(8),username:'zqp3'+RUN}}),
 ];
 const nopay=member('priv4',{exempt:false,profile:{firstName:'Zq'+letters(7),lastName:'Xq'+letters(8),username:'zqp4'+RUN}});
 const secrets=[];
 for(const p of [...people,nopay]){
  const s=fixture('accounts-state',{userId:p.id});
  secrets.push(p.email,p.email.split('@')[0],p.id,p.publicId,s.profile.username,s.profile.first_name,s.profile.last_name,...(s.profile.club_text?[s.profile.club_text]:[]));
 }
 const tid=fixture('tournament',{name:'Turniej prywatności',city:'Prywatnowo',date:'2032-03-14'}).id;
 const sessions=await Promise.all(people.map(p=>signIn(p.email)));
 const lobby=['general','taekwondo-pl','karate'].map(channel);
 for(const [i,c] of sessions.entries()){
  for(const ch of lobby)assert.equal((await send(c,{ch:ch.id},`Wiadomość ${i} w ${ch.slug}`)).status,200);
  assert.equal((await send(c,{t:tid},`Turniej ${i}`)).status,200);
 }
 // A tombstone (deleted by its author) and a message hidden by the moderator are part of what guests receive too.
 const gone=await send(sessions[0],{ch:general.id},'Zaraz usunę');assert.equal((await sessions[0].req('chat-delete',{id:gone.data.m.id})).status,200);
 const hidden=await send(sessions[1],{ch:general.id},'Usunie moderator');await moderate({action:'delete',messageId:hidden.data.m.id,note:'test'});
 const tch=fixture('chat-channel',{tournamentId:tid}),ids=[...lobby.map(c=>c.id),tch.id],last=channel('general').last_message_id;
 const answers=[];
 const check=async(label,route,params={},cookie)=>{const r=await get(route,params,cookie);answers.push([label,r]);return r;};
 await check('public','public');
 await check('public-tournament','public-tournament',{id:tid});
 await check('public-config','public-config');
 await check('session','session');
 const lists=await check('public-chat-channels','public-chat-channels');
 assert.ok(lists.data.tournaments.some(t=>t.tournamentId===tid&&t.id===tch.id),'the tournament channel is public');
 const all=ids.map(id=>`${id}:0`).join(',');
 const initial=await check('public-chat initial','public-chat',{ch:all,cv:'0',e:'2:503'});
 for(const id of ids)for(const m of initial.data.ch[id].m)assert.deepEqual(Object.keys(m),'b' in m?GUEST_FIELDS:GUEST_TOMB);
 const shown=Object.fromEntries(initial.data.ch[general.id].m.map(m=>[m.id,m]));
 assert.deepEqual([shown[gone.data.m.id].x,shown[hidden.data.m.id].x],['author','mod'],'both tombstones, without their text');
 await check('public-chat heads','public-chat',{ch:`${general.id}:${channel('general').rev}`,h:ids.slice(1).map(id=>`${id}:0:0`).join(','),cv:'0'});
 await check('public-chat history','public-chat',{ch:`${general.id}:0`,before:String(last)});
 await check('public-chat since','public-chat',{ch:`${general.id}:1`});
 await check('public-chat with a member cookie','public-chat',{ch:all},sessions[0].cookie);
 await check('public-chat-channels with a member cookie','public-chat-channels',{},sessions[0].cookie);
 // Signed in without full access: the guest projection through chat-feed and chat-channels.
 const cn=await signIn(nopay.email);
 const feed=await check('chat-feed without payment','chat-feed',{ch:all,cv:'0'},cn.cookie);
 assert.equal(feed.status,200,feed.text);assert.equal(feed.data.people,undefined);
 for(const id of ids)for(const m of feed.data.ch[id].m)assert.deepEqual(Object.keys(m),'b' in m?GUEST_FIELDS:GUEST_TOMB);
 await check('chat-channels without payment','chat-channels',{},cn.cookie);
 await check('chat-feed without a session','chat-feed',{ch:all});
 await check('avatar for a guest','avatar',{id:people[0].publicId,v:'0123456789ab',s:'64'});
 for(const [label,r] of answers){
  assert.ok([200,204,401,404].includes(r.status),label+': '+r.status);
  // Only the legacy session route hands out a cookie (an anonymous session id, no identity).
  const headers=[...r.headers.entries()].map(([k,v])=>k+': '+v).join('\n');if(label!=='session')assert.equal(r.headers.get('set-cookie'),null,label+': Set-Cookie');
  const hay=(r.text+'\n'+headers).toLowerCase();
  for(const s of secrets)assert.ok(!hay.includes(String(s).toLowerCase()),`${label} leaks ${s}`);
 }
 // Control: the same people are visible to a member with full access (the sweep would notice a leak).
 const full=await get('chat-feed',{ch:all},sessions[2].cookie);
 for(const p of people)assert.ok(full.text.includes(p.publicId),'members see public_ids');
 assert.ok(!full.text.includes(people[0].email)&&!full.text.includes(people[0].id),'never e-mails or internal ids, even for members');
});
