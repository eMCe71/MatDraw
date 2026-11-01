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
// The roles plan (PLAN-REJESTRACJA-ROLE, wave 4) adds the scenarios at the end of this file: free mode from the Admin panel
// through sign-up with roles, publishing, self-entries, check-in, draw and results; the JSON leak scan of every role; the
// Administrator's block with hidden tournaments; free → paid with groups A and B; account deletion; staff unchanged.
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
const day=n=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw'}).format(new Date(Date.now()+n*864e5));

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
 // Tomorrow: route=public lists only the 6 nearest tournaments and the other files plant many later ones.
 const tid=fixture('tournament',{name:'Turniej prywatności',city:'Prywatnowo',date:day(1)}).id;
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
 // Every answer has its expected status, so a route that stops answering (an empty 404) cannot pass the sweep.
 const check=async(label,route,params={},cookie,status=200)=>{const r=await get(route,params,cookie);assert.equal(r.status,status,label+': '+r.text);answers.push([label,r]);return r;};
 const pub=await check('public','public');
 assert.ok(pub.data.tournaments.some(t=>t.id===tid&&t.name==='Turniej prywatności'),'the planted tournament is public: '+pub.text);
 const one=await check('public-tournament','public-tournament',{id:tid});
 assert.deepEqual([one.data.tournament.id,one.data.tournament.name,one.data.tournament.city],[tid,'Turniej prywatności','Prywatnowo']);
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
 assert.equal(feed.data.people,undefined);
 for(const id of ids)for(const m of feed.data.ch[id].m)assert.deepEqual(Object.keys(m),'b' in m?GUEST_FIELDS:GUEST_TOMB);
 await check('chat-channels without payment','chat-channels',{},cn.cookie);
 await check('chat-feed without a session','chat-feed',{ch:all},undefined,401);
 await check('avatar for a guest','avatar',{id:people[0].publicId,v:'0123456789ab',s:'64'},undefined,404);
 for(const [label,r] of answers){
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

// ---------------------------------------------------------------------------------------------------------------------
// Roles, organizers and self-entries (PLAN-REJESTRACJA-ROLE §11, §12, slice integration-qa): every scenario goes through
// the public routes of several slices (settings-backend → accounts-backend → data-domain → athlete-backend):
//  - free mode switched on in the Admin panel; sign-up with roles (athlete self, guardian, organizer) gets the free-signup
//    exemption; the organizer publishes at once (trustRequired=false: home list, chat lobby, preview with selfEntry);
//    self-entry, correction, withdrawal and a new entry; check-in with a club override, draw, results; the athlete view,
//    the organizer's workspace and the public preview agree (initials and current clubs only);
//  - the JSON leak scan of bootstrap, commands, athlete, me and the admin routes for every role;
//  - the Administrator blocks an organizer and hides his tournaments (guests, chat lobby, athlete view, tombstones,
//    admin-members upcomingTournaments and organizerBlocked in the admin workspace, F3);
//  - free → paid with the decision about groups A and B (Stripe stub): free-period accounts keep access, a paid-mode sign-up
//    pays through Checkout before entering, correction and withdrawal never need payment (R12);
//  - account deletion forgets community data (an athlete; an organizer: hidden tournament, tombstones 'system');
//  - staff unchanged: workspace shape and defaults, revision isolation (R15), self-entries seen by the editor (O2), never
//    by the club (O10).
import {categories,resolveDraw} from '../dist/engine.js';
import {readdirSync,readFileSync} from 'node:fs';
const RPASS='RolesPassword2026!';
let rseq=0;const rtag=p=>`${p}${RUN}${(++rseq).toString(36)}`;
/** A session that started the sign-up form 10 s ago (the server-measured fill time, §3.6). */
async function begun(){const c=await fresh();const r=await c.req('signup-begin',{});assert.equal(r.status,200,JSON.stringify(r.data));fixture('session-edit',{sid:c.cookie.split('=')[1],set:{signup_at:now()-10}});return c;}
/** Sign-up through the public routes; the client stays signed in (id, email and caps of the answer). */
async function signUp(over={}){
 const c=await begun(),body={email:`zr.${rtag('s')}@integration.example`,password:RPASS,firstName:'Rola',lastName:'Integracyjna',username:rtag('r'),country:'PL',sports:['taekwondo'],clubText:null,showClub:false,website:'',...over};
 const r=await c.req('signup',body);assert.equal(r.status,200,JSON.stringify(r.data));return Object.assign(c,{id:r.data.user.id,email:body.email,caps:r.data.caps??null});
}
const adult=(name,over={})=>({relation:'self',name,birthDate:'1994-05-06',sex:'F',weight:60,height:168,gradeType:'cup',grade:5,club:{none:true},...over});
const ENTRY={events:['forms'],weight:60,height:168,gradeType:'cup',grade:5},ADULT={sex:'F',birthDate:'1994-05-06',weight:60,height:168,gradeType:'cup',grade:5,events:['forms']};
const TOUR=(name,over={})=>({name,city:'Integracja',date:day(0),mat:'Mata 1',status:'open',...over});
async function settingsSave(body,status=200){const v=await get('admin-settings',{},admin.cookie);assert.equal(v.status,200,v.text);const r=await admin.req('admin-settings-save',{version:v.data.version,...body});assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
const freeMode=async()=>{const v=await settingsSave({signup:'on',payments:'free',organizers:'on',trustRequired:false});assert.equal(v.mode,'free');return v;};
async function view(c,t){const r=await get('athlete',t?{t}:{},c.cookie);assert.equal(r.status,200,r.text);return r.data;}
const call=async(c,route,body,status=200,message)=>{const r=await c.req(route,body);error(r,status,message);return r.data;};
const cmd=(c,type,payload)=>c.req('command',{type,payload,expectedRevision:c.data.revision});
const tourOf=(c,id)=>c.data.tournaments.find(t=>t.id===id);
async function staffAccount(role,over={}){
 await admin.load();const email=`zr.${rtag(role)}@integration.example`,r=await admin.cmd('account.save',{email,role,password:RPASS,...over});
 const c=await signIn(email,RPASS);await c.load();return Object.assign(c,{id:r.id,email});
}
after(()=>{if(!skip)fixture('settings-reset');});

test('roles end to end in free mode: sign-up with roles, publishing at once, self-entry, correction and withdrawal, check-in with a club override, draw and results; the views agree',{skip},async()=>{
 fixture('settings-reset');await freeMode();
 const pc=(await get('public-config')).data;assert.deepEqual([pc.signup,pc.signupMode,pc.billing,pc.roles],[true,'free',false,true]);
 // Sign-up with roles (accounts-backend), the athlete validated by Domain::athleteFields and Clubs::pick (data-domain), the free-signup exemption (settings-backend).
 const club='Klub Integracji '+RUN;
 const ath=await signUp({roles:{athlete:true},athlete:adult('Iga Samodzielna'+RUN,{club:{name:club}})});
 const par=await signUp({roles:{athlete:true},athlete:adult('Kuba Podopieczny'+RUN,{relation:'guardian',birthDate:day(-365*11),sex:'M',weight:38,height:145,grade:9})});
 const org=await signUp({roles:{organizer:true}});
 assert.deepEqual(ath.caps,{organizer:false,organizerBlocked:false,organizerTrusted:false,athlete:true});assert.equal(par.caps.athlete,true);
 assert.deepEqual(org.caps,{organizer:true,organizerBlocked:false,organizerTrusted:false,athlete:false});
 for(const c of [ath,par,org]){
  const m=await me(c);assert.deepEqual([m.access.full,m.features.signupMode,m.billing.enforce],[true,'free',false],c.email);
  assert.equal(fixture('roles-user',{email:c.email}).billing.exempt_reason,'free-signup','the free period marks the account (§3.4)');
 }
 let av=await view(ath);const selfId=av.profiles[0].id;
 assert.deepEqual(av.profiles[0].club,{id:av.profiles[0].club.id,name:club,verified:false,unaffiliated:false,pending:null},'a new club from the sign-up, unverified');
 const kidId=(await view(par)).profiles[0].id;
 // The organizer publishes at once (D2; trustRequired=false, §17); self-entries are on by default for organizers (R11).
 await org.load();assert.deepEqual(org.data.user.caps,org.caps);assert.deepEqual(org.data.users,[]);
 const tname='000 Integracja Ról '+RUN,t=(await org.cmd('tournament.save',TOUR(tname))).id;
 assert.deepEqual(['status','selfEntry','community','trusted'].map(k=>tourOf(org,t)[k]),['open',true,true,true]);
 let pv=await get('public-tournament',{id:t});
 assert.deepEqual(pv.data.tournament,{id:t,name:tname,date:day(0),city:'Integracja',status:'open',community:true,trusted:true,selfEntry:true},'F2: the preview offers the self-entry');
 const home=(await get('public')).data.tournaments;assert.ok(home.some(x=>x.id===t)||home.length===6&&home.every(x=>x.date<=day(0)),'on the home list (trusted community)');
 assert.ok((await get('public-chat-channels')).data.tournaments.some(x=>x.tournamentId===t),'and in the chat lobby');
 const open=(await view(ath)).open.find(x=>x.id===t);
 assert.deepEqual(open&&[open.community,open.trusted,open.organizer,open.profiles],[true,true,{n:'Rola I.'},[{id:selfId,entered:false,blocked:null}]]);
 assert.equal((await view(ath,t)).open.filter(x=>x.id===t).length,1,'?t= keeps it once (F1)');
 // Self-entry, correction (R12), withdrawal and a new entry (the tombstone of the own withdrawal never shows).
 let r=await call(ath,'athlete-entry',{tournamentId:t,profileId:selfId,...ENTRY});
 assert.deepEqual([r.ok,r.entry.tournament.id,r.entry.entry.weight,r.entry.entry.club.name,r.entry.entry.club.verified,r.entry.canWithdraw],[true,t,60,club,false,true]);
 await call(ath,'athlete-entry',{tournamentId:t,profileId:selfId,...ENTRY},409,'Jesteś już zgłoszony do tego turnieju.');
 r=await call(ath,'athlete-entry',{tournamentId:t,profileId:selfId,...ENTRY,weight:61.5,update:true});assert.equal(r.entry.entry.weight,61.5);
 await call(ath,'athlete-withdraw',{tournamentId:t,profileId:selfId});
 av=await view(ath);assert.ok(!av.entries.some(e=>e.tournament.id===t));assert.equal(av.open.find(x=>x.id===t).profiles[0].entered,false);assert.deepEqual(av.withdrawn,[]);
 await call(ath,'athlete-entry',{tournamentId:t,profileId:selfId,...ENTRY,weight:61.5});
 // A guardian's child: allowed because every organizer counts as confirmed while trustRequired is false (§17).
 await call(par,'athlete-entry',{tournamentId:t,profileId:kidId,events:['forms'],weight:38,height:145,gradeType:'cup',grade:9});
 // The organizer's workspace: the self-entries as snapshots, never the athletes' profiles or birth dates (§5.2).
 await org.load();let tv=tourOf(org,t);
 assert.deepEqual(tv.entries.map(e=>[e.profileId,e.self]).sort(),[[kidId,true],[selfId,true]].sort());
 assert.ok(!org.data.profiles.some(p=>p.id===selfId||p.id===kidId),'never the athletes\' profiles');
 assert.ok(!JSON.stringify(org.data).includes('1994-05-06'),'no birth date of a self-entry');
 // Two adults of the organizer in the same category, then registration closed: the athlete can no longer withdraw (§7.3).
 const p1=(await org.cmd('profile.save',{...ADULT,name:'Ola Pierwsza'+RUN,club:{none:true}})).id,p2=(await org.cmd('profile.save',{...ADULT,name:'Ewa Druga'+RUN,clubName:'Klub Organizatora '+RUN})).id;
 for(const id of [p1,p2])await org.cmd('entry.save',{tournamentId:t,profileId:id,...ENTRY});
 error(await cmd(org,'profile.save',{...ADULT,name:'Zła Rejestracja'+RUN,club:{none:true},registration:'x'}),404,'Turniej nie jest dostępny.');// was a TypeError: 500
 await org.cmd('tournament.save',{...TOUR(tname),id:t,status:'closed'});
 assert.equal((await view(ath)).entries.find(e=>e.tournament.id===t).canWithdraw,false);
 await call(ath,'athlete-withdraw',{tournamentId:t,profileId:selfId},403,'Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.');
 // Check-in: the organizer corrects the club of the self-entry to a verified one (D3), the identity stays; presence for all.
 const verified=org.data.clubs.find(x=>x.name==='Test Warszawa');assert.ok(verified,'the verified club of the installation is offered');
 await org.cmd('entry.save',{tournamentId:t,profileId:selfId,update:true,clubId:verified.id,...ENTRY,weight:61.5,name:'Ktoś Inny',sex:'M'});
 tv=tourOf(org,t);const fixed=tv.entries.find(e=>e.profileId===selfId);
 assert.deepEqual([fixed.clubId,fixed.club,fixed.name,fixed.sex,fixed.self],[verified.id,'Test Warszawa','Iga Samodzielna'+RUN,'F',true]);
 for(const id of [selfId,p1,p2])await org.cmd('checkin.save',{tournamentId:t,id,presence:'present',actualWeight:60.2});
 assert.equal((await view(ath)).entries.find(e=>e.tournament.id===t).entry.club.name,'Test Warszawa','the athlete sees the corrected club');
 // Draw and every result; the athlete wins each fight.
 const cat=categories(tourOf(org,t).entries).items.find(c=>c.type==='bracket'&&[selfId,p1,p2].every(id=>c.athletes.some(a=>a.profileId===id)));assert.ok(cat,'one bracket for the three adults');
 await org.cmd('draw.create',{tournamentId:t,categoryId:cat.id});
 for(let m;(m=resolveDraw(tourOf(org,t).draws[cat.id]).flat().find(x=>x.ready));)await org.cmd('result.save',{tournamentId:t,categoryId:cat.id,matchId:m.id,winnerId:m.a===selfId||m.b===selfId?selfId:m.a});
 await org.cmd('tournament.save',{...TOUR(tname),id:t,status:'finished'});
 // The athlete view: champion, the bracket with initials and current clubs; the preview shows the same bracket.
 av=await view(ath);const mine=av.entries.find(e=>e.tournament.id===t),drawn=mine.categories.find(c=>c.drawn);
 assert.deepEqual([mine.tournament.status,drawn.position.status,mine.canWithdraw,mine.canEdit],['finished','champion',false,false]);
 assert.deepEqual(drawn.bracket.slots.filter(Boolean).map(s=>s.club).sort(),['','Test Warszawa',null].sort(),'verified name, unaffiliated empty, unverified null');
 pv=await get('public-tournament',{id:t});assert.equal(pv.data.tournament.selfEntry,undefined,'no self-entry once finished');
 assert.deepEqual(pv.data.categories.find(c=>c.code===drawn.code).bracket,drawn.bracket,'the athlete view shows the public bracket');
 for(const name of ['Samodzielna','Pierwsza','Druga','Podopieczny'])assert.ok(!pv.text.includes(name+RUN),name);
});

test('JSON leak scan: bootstrap, commands, athlete, me and the admin routes of every role carry nothing outside its scope',{skip},async()=>{
 await freeMode();
 const ed=await staffAccount('editor',{clubName:'Klub Edytora '+RUN}),cl=await staffAccount('club',{clubName:'Klub Przedstawiciela '+RUN});
 const A=await signUp({roles:{organizer:true}}),B=await signUp({roles:{organizer:true}});
 const X=await signUp({roles:{athlete:true},athlete:adult('Xawery Samodzielny'+RUN,{sex:'M',birthDate:'1987-11-23'})});
 const G=await signUp({roles:{athlete:true},athlete:adult('Gaja Dziecięca'+RUN,{relation:'guardian',birthDate:'2014-09-29',weight:35,height:140,grade:9})});
 const M=await signUp({});
 const xId=(await view(X)).profiles[0].id,gId=(await view(G)).profiles[0].id;
 // Staff: a profile of the club account's club (by the Administrator), the editor's own profile, the editor's open tournament with self-entries.
 await admin.load();const sp=(await admin.cmd('profile.save',{...ADULT,name:'Stanisław Kadrowy'+RUN,birthDate:'1985-03-17',sex:'M',clubId:cl.data.user.clubId})).id;
 await ed.load();const ep=(await ed.cmd('profile.save',{...ADULT,name:'Edward Redakcyjny'+RUN,birthDate:'1986-04-18',sex:'M',clubId:ed.data.user.clubId})).id;
 const ts=(await ed.cmd('tournament.save',TOUR('Turniej Kadry '+RUN,{selfEntry:true,date:day(5)}))).id;await ed.cmd('entry.save',{tournamentId:ts,profileId:ep,...ENTRY});
 await cl.load();await cl.cmd('entry.save',{tournamentId:ts,profileId:sp,...ENTRY});
 // Organizers: own tournaments and profiles; A also enters his profile into the staff tournament (O19).
 await A.load();const ta=(await A.cmd('tournament.save',TOUR('Turniej Agaty '+RUN,{date:day(6)}))).id;
 const ap=(await A.cmd('profile.save',{...ADULT,name:'Agata Organizatorska'+RUN,birthDate:'2000-05-19',club:{none:true}})).id;
 await A.cmd('entry.save',{tournamentId:ta,profileId:ap,...ENTRY});await A.cmd('entry.save',{tournamentId:ts,profileId:ap,...ENTRY});
 await B.load();const tb=(await B.cmd('tournament.save',TOUR('Turniej Bogusława '+RUN,{date:day(7)}))).id;
 const bp=(await B.cmd('profile.save',{...ADULT,name:'Bogusław Obcy'+RUN,birthDate:'2002-06-20',sex:'M',club:{none:true}})).id;await B.cmd('entry.save',{tournamentId:tb,profileId:bp,...ENTRY});
 // Athletes: X in the staff tournament and in B's, the child in A's.
 for(const tid of [ts,tb])await call(X,'athlete-entry',{tournamentId:tid,profileId:xId,...ENTRY});
 await call(G,'athlete-entry',{tournamentId:ta,profileId:gId,events:['forms'],weight:35,height:140,gradeType:'cup',grade:9});
 const P={sp:[sp,'Kadrowy'+RUN,'1985-03-17'],ep:[ep,'Redakcyjny'+RUN,'1986-04-18'],ap:[ap,'Organizatorska'+RUN,'2000-05-19'],bp:[bp,'Obcy'+RUN,'2002-06-20'],x:[xId,'Samodzielny'+RUN,'1987-11-23'],g:[gId,'Dziecięca'+RUN,'2014-09-29']};
 const emails={ed:ed.email,cl:cl.email,A:A.email,B:B.email,X:X.email,G:G.email,M:M.email,admin:'admin@test.example'};
 // What each role may see (§5.2): whole profiles; entries (name and id of the snapshot, never a birth date); its own e-mail.
 const scope={A:{profiles:['ap'],entries:['g'],emails:['A']},B:{profiles:['bp'],entries:['x'],emails:['B']},ed:{profiles:['sp','ep'],entries:['ap','x'],emails:['ed']},
  cl:{profiles:['sp'],entries:[],emails:['cl']},X:{profiles:['x'],entries:[],emails:['X']},G:{profiles:['g'],entries:[],emails:['G']},M:{profiles:[],entries:[],emails:['M']},guest:{profiles:[],entries:[],emails:[]}};
 const leak=(label,text,s)=>{
  for(const [k,[id,name,birth]] of Object.entries(P)){
   if(s.profiles.includes(k))continue;
   if(!s.entries.includes(k)){assert.ok(!text.includes(name),`${label}: name of ${k}`);assert.ok(!text.includes(id),`${label}: id of ${k}`);}
   assert.ok(!text.includes(birth),`${label}: birth date of ${k}`);
  }
  for(const [k,e] of Object.entries(emails))if(!s.emails.includes(k))assert.ok(!text.includes(e),`${label}: e-mail of ${k}`);
 };
 const commands={A:()=>cmd(A,'tournament.save',{...TOUR('Turniej Agaty '+RUN,{date:day(6)}),id:ta,city:'Opole'}),B:()=>cmd(B,'tournament.save',{...TOUR('Turniej Bogusława '+RUN,{date:day(7)}),id:tb,city:'Opole'}),
  ed:()=>cmd(ed,'tournament.save',{...TOUR('Turniej Kadry '+RUN,{date:day(5)}),id:ts,city:'Opole'}),cl:()=>cmd(cl,'entry.save',{tournamentId:ts,profileId:sp,...ENTRY,weight:61,update:true})};
 for(const [k,c] of Object.entries({A,B,ed,cl,X,G,M})){
  const texts=[];
  const b=await c.req('bootstrap');assert.equal(b.status,200,k);c.data=b.data;texts.push(['bootstrap',JSON.stringify(b.data)]);
  if(commands[k]){const r=await commands[k]();assert.equal(r.status,200,k+' '+JSON.stringify(r.data));texts.push(['command',JSON.stringify(r.data)]);}
  const athlete=await get('athlete',{},c.cookie);assert.equal(athlete.status,['ed','cl'].includes(k)?403:200,k+' athlete');texts.push(['athlete',athlete.text]);
  const m=await get('me',{},c.cookie);assert.equal(m.status,200,k+' me');texts.push(['me',m.text]);
  for(const [route,body] of [['admin-members',{filter:'all',page:1}],['admin-member',{action:'organizer-trust',userId:A.id,trusted:true}]]){const r=await c.req(route,body);error(r,403,'Brak uprawnień.');texts.push([route,JSON.stringify(r.data)]);}
  for(const route of ['admin-settings','diagnostics','admin-billing','admin-chat-reports']){const r=await get(route,{},c.cookie);assert.equal(r.status,403,`${k} ${route}`);texts.push([route,r.text]);}
  for(const [label,text] of texts)leak(`${k} ${label}`,text,scope[k]);
 }
 for(const tid of [ts,ta,tb]){const r=await get('public-tournament',{id:tid});assert.equal(r.status,200);leak('guest '+tid,r.text,scope.guest);}
 // Every admin route of the registry (backend/routes/*.php) answers 403 to members and to staff other than the Administrator (§11).
 const routes=new URL('../backend/routes/',import.meta.url),admins=readdirSync(routes).filter(f=>f.endsWith('.php'))
  .flatMap(f=>[...readFileSync(new URL(f,routes),'utf8').matchAll(/'(admin-[a-z-]+|diagnostics)'=>\['method'=>'(GET|POST)'/g)].map(m=>[m[1],m[2]]));
 assert.ok(admins.length>=12,JSON.stringify(admins));
 for(const [k,c] of Object.entries({A,ed,cl,X,M}))for(const [route,method] of admins){const r=method==='GET'?await get(route,{},c.cookie):await c.req(route,{});assert.equal(r.status,403,`${route} for ${k}: ${JSON.stringify(r.data)}`);}
 assert.equal(fixture('roles-user',{email:A.email}).user.organizer_trusted_at,null,'the refused admin-member changed nothing');
 // The Administrator: everything, but the workspace accounts are staff only (members never enter it, R5).
 const ab=await admin.req('bootstrap');assert.ok(ab.data.users.every(u=>['admin','editor','club'].includes(u.role)));
 for(const k of ['A','B','X','G','M'])assert.ok(!JSON.stringify(ab.data).includes(emails[k]),'admin workspace: e-mail of '+k);
 // organizerSnapshot (what reaches the memory of an organizer's request) equals publicData of the full workspace (B2).
 for(const o of [A,B]){const s=fixture('roles-snapshot',{userId:o.id});assert.deepEqual(s.snapshot,s.full);}
});

test('the Administrator blocks an organizer and hides his tournaments: guests, chat lobby, athlete view and tombstones follow; admin-members and the admin workspace show it (F3)',{skip},async()=>{
 await freeMode();
 const O=await signUp({roles:{organizer:true}}),X=await signUp({roles:{athlete:true},athlete:adult('Hanna Ukryta'+RUN)});const xId=(await view(X)).profiles[0].id;
 await O.load();const t1=(await O.cmd('tournament.save',TOUR('Turniej Do Ukrycia '+RUN,{date:day(4)}))).id;
 await O.cmd('tournament.save',TOUR('Roboczy Do Ukrycia '+RUN,{date:day(8),status:'draft'}));
 const t3=(await O.cmd('tournament.save',TOUR('Dawny '+RUN,{date:day(9),status:'draft'}))).id;fixture('roles-backdate',{tournamentId:t3,date:day(-20)});
 await call(X,'athlete-entry',{tournamentId:t1,profileId:xId,...ENTRY});
 const item=async()=>(await adminList({q:O.email})).items.find(i=>i.id===O.id);
 let it=await item();assert.deepEqual([it.tournaments,it.upcomingTournaments,it.caps.organizer],[3,2,true],'F3: exactly the tournaments a hide would hide (upcoming, not hidden)');
 await admin.load();assert.equal(tourOf(admin,t1).organizerBlocked,undefined,'F3: sparse, only while blocked');
 const missing=await get('public-tournament',{id:'0'.repeat(32)});
 const r=await adminMember({action:'organizer',userId:O.id,blocked:true,hideTournaments:true,reason:'Podejrzany turniej'});
 assert.deepEqual([r.hidden,r.caps.organizer,r.caps.organizerBlocked],[2,false,true]);
 it=await item();assert.deepEqual([it.tournaments,'upcomingTournaments' in it,it.caps.organizerBlocked],[3,false,true],'nothing left to hide');
 await admin.load();const at=tourOf(admin,t1);
 assert.deepEqual([at.status,at.hidden,at.hideReason,at.hiddenFrom,at.organizerBlocked,at.trusted],['draft',true,'Podejrzany turniej','open',true,false]);
 // The organizer: no tools, and the role cannot be switched back on.
 const b=await O.req('bootstrap');assert.deepEqual([b.status,b.data.tournaments,b.data.user.caps],[200,[],{organizer:false,organizerBlocked:true,organizerTrusted:false,athlete:false}]);
 error(await O.req('command',{type:'tournament.save',payload:TOUR('Nowy '+RUN),expectedRevision:b.data.revision}),403,'Brak uprawnień.');
 await call(O,'roles',{organizer:true},403,'Administrator wyłączył Ci rolę organizatora.');
 // Guests get the 404 of a missing id; the lobby and the athlete's open list lose it; the athlete's entry left with a tombstone.
 const gone=await get('public-tournament',{id:t1});assert.deepEqual([gone.status,gone.text],[missing.status,missing.text]);
 assert.ok(!(await get('public-chat-channels')).data.tournaments.some(x=>x.tournamentId===t1));
 const av=await view(X,t1);assert.ok(!av.open.some(x=>x.id===t1)&&!av.entries.some(e=>e.tournament.id===t1));
 assert.deepEqual(av.withdrawn.filter(w=>w.tournament.id===t1).map(w=>[w.profileId,w.by]),[[xId,'admin']],'withdrawSelf: the tombstone names the Administrator');
 await call(X,'athlete-entry',{tournamentId:t1,profileId:xId,...ENTRY},404,'Turniej nie jest dostępny.');
 // Unblocked: the role returns; the tournaments stay hidden until the Administrator restores them.
 await adminMember({action:'organizer',userId:O.id,blocked:false});await O.load();assert.equal(O.data.user.caps.organizer,true);
 error(await cmd(O,'tournament.save',{...TOUR('Turniej Do Ukrycia '+RUN,{date:day(4)}),id:t1}),409,'Turniej ukrył Administrator. Status może zmienić tylko Administrator.');
 await admin.load();await admin.cmd('tournament.hide',{tournamentId:t1,hidden:false});
 assert.equal((await get('public-tournament',{id:t1})).data.tournament.status,'open');assert.equal((await item()).upcomingTournaments,1,'restored; the draft stays hidden');
});

test('free → paid with the decision about groups A and B (Stripe stub): free-period accounts keep access; a paid-mode sign-up pays through Checkout before entering; correction and withdrawal never need payment (R12)',{skip},async()=>{
 await freeMode();
 const O=await signUp({roles:{organizer:true}}),Y=await signUp({roles:{athlete:true},athlete:adult('Joanna Wolna'+RUN)});const yId=(await view(Y)).profiles[0].id;
 const madeEmail=`zr.${rtag('adm')}@integration.example`,made=await adminMember({action:'create',email:madeEmail,firstName:'Adam',lastName:'Zakładany',username:rtag('a'),country:'PL',sports:['karate'],password:RPASS});
 const W=member('grupab',{exempt:false});
 await O.load();const t=(await O.cmd('tournament.save',TOUR('Turniej Płatności '+RUN,{date:day(10)}))).id;
 await call(Y,'athlete-entry',{tournamentId:t,profileId:yId,...ENTRY});
 // Free mode: Checkout is refused while payments are not required.
 const ck=await Y.req('billing-checkout',{});assert.deepEqual([ck.status,ck.data.code],[409,'not_required']);
 // The switch: test mode confirmed, then the decision about both groups (Billing::freePeriodSet over every live member).
 let r=await settingsSave({payments:'paid'},409);assert.equal(r.code,'test_mode');
 const set=fixture('settings-free-set');
 for(const [label,id] of [['sign-up',Y.id],['organizer',O.id],['created by the Administrator',made.id]])assert.ok(set.a.includes(id),'group A: '+label);
 assert.ok(set.b.includes(W.id),'group B: an account without access');
 r=await settingsSave({payments:'paid',confirmTestMode:true},409);assert.deepEqual([r.code,r.counts],['free_period_decision',{a:set.a.length,b:set.b.length}]);
 r=await settingsSave({payments:'paid',confirmTestMode:true,freePeriod:{action:'keep'}});assert.deepEqual([r.mode,r.effective.mode],['paid','paid']);
 for(const [label,c] of [['sign-up',Y],['organizer',O],['group B',await signIn(W.email)],['created by the Administrator',await signIn(madeEmail,RPASS)]]){const m=await me(c);assert.deepEqual([m.access.full,m.billing.enforce],[true,true],label);}
 const pc=(await get('public-config')).data;assert.deepEqual([pc.signupMode,pc.billing],['paid',true]);
 // A sign-up in paid mode: no exemption; athlete-entry 402 until Checkout; the profile can be corrected without paying.
 const P=await signUp({roles:{athlete:true},athlete:adult('Paula Płacąca'+RUN)});const pId=(await view(P)).profiles[0].id;
 assert.equal((await me(P)).access.full,false);
 await call(P,'athlete-entry',{tournamentId:t,profileId:pId,...ENTRY},402,'Zgłoszenia do turniejów wymagają aktywnego konta.');
 await call(P,'athlete-save',{id:pId,...adult('Paula Płacąca'+RUN,{weight:62})});
 await pay(P);assert.equal((await me(P)).access.full,true);
 await call(P,'athlete-entry',{tournamentId:t,profileId:pId,...ENTRY,weight:62});
 // R12: without access a correction and a withdrawal still work; a new event needs payment.
 fixture('billing',{userId:Y.id,billing_exempt:0,exempt_reason:null});assert.equal((await me(Y)).access.full,false);
 await call(Y,'athlete-entry',{tournamentId:t,profileId:yId,...ENTRY,weight:60.5,update:true});
 await call(Y,'athlete-entry',{tournamentId:t,profileId:yId,...ENTRY,events:['forms','power'],update:true},402,'Zgłoszenia do turniejów wymagają aktywnego konta.');
 await call(Y,'athlete-withdraw',{tournamentId:t,profileId:yId});
 // The organizer without access: commands 402 except removing data; the athlete sees who withdrew the entry.
 fixture('billing',{userId:O.id,billing_exempt:0,exempt_reason:null});await O.load();
 error(await cmd(O,'tournament.save',TOUR('Bez dostępu '+RUN,{status:'draft'})),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 assert.equal((await cmd(O,'entry.remove',{tournamentId:t,id:pId})).status,200,'withdrawing works without full access');
 assert.deepEqual((await view(P)).withdrawn.filter(w=>w.tournament.id===t).map(w=>w.by),['organizer']);
 fixture('settings-reset');
});

test('account deletion forgets community data through the routes: an athlete, then an organizer (hidden tournament, tombstones system)',{skip},async()=>{
 await freeMode();
 const O=await signUp({roles:{organizer:true}}),V=await signUp({roles:{athlete:true},athlete:adult('Wanda Odchodząca'+RUN)}),S=await signUp({roles:{athlete:true},athlete:adult('Sabina Zostająca'+RUN)});
 const vId=(await view(V)).profiles[0].id,sId=(await view(S)).profiles[0].id;
 await O.load();const t=(await O.cmd('tournament.save',TOUR('Turniej Usuwania '+RUN,{date:day(12)}))).id;
 const op=(await O.cmd('profile.save',{...ADULT,name:'Olga Organizatora'+RUN,club:{none:true}})).id;await O.cmd('entry.save',{tournamentId:t,profileId:op,...ENTRY});
 for(const [c,id] of [[V,vId],[S,sId]])await call(c,'athlete-entry',{tournamentId:t,profileId:id,...ENTRY});
 // The athlete deletes the account: the profile row and the entry go; the log keeps initials only.
 await call(V,'account-delete',{password:RPASS});
 assert.equal(fixture('athlete-row',{id:vId}),null,'the profile row is deleted (no history to keep)');
 await O.load();const tv=tourOf(O,t);assert.ok(!tv.entries.some(e=>e.profileId===vId));assert.ok(!JSON.stringify(tv.activity).includes('Odchodząca'+RUN),'initials only in the log');
 assert.equal((await get('me',{},V.cookie)).status,401);
 // The organizer deletes the account: the upcoming tournament is hidden by 'system', the remaining self-entry leaves with a tombstone 'system', his profiles are forgotten.
 await call(O,'account-delete',{password:RPASS});
 const row=fixture('domain-row',{table:'tournaments',id:t});assert.deepEqual([row.status,row.hidden_by,row.hidden_from],['draft','system','open']);
 assert.equal(fixture('athlete-row',{id:op}),null,'the organizer\'s profile is forgotten');
 const sv=await view(S);assert.deepEqual(sv.withdrawn.filter(w=>w.tournament.id===t).map(w=>w.by),['system']);assert.ok(!sv.open.some(x=>x.id===t)&&!sv.entries.some(e=>e.tournament.id===t));
 assert.equal((await get('public-tournament',{id:t})).status,404);
 assert.equal(fixture('roles-user',{email:O.email}),null,'the e-mail left with the account');
});

test('staff unchanged: workspace shape and defaults, revision isolation from members (R15), self-entries seen by the editor (O2) and never by the club (O10)',{skip},async()=>{
 await freeMode();
 const ed=await staffAccount('editor',{clubName:'Klub Redakcji '+RUN}),cl=await staffAccount('club',{clubName:'Klub Stały '+RUN});
 assert.deepEqual(Object.keys(ed.data).sort(),['clubs','profiles','revision','schemaVersion','tournaments','user','users']);
 assert.deepEqual(ed.data.user,{id:ed.id,clubId:ed.data.user.clubId,email:ed.email,role:'editor',active:true},'no caps for staff');assert.deepEqual(ed.data.users,[]);
 await admin.load();const pc=(await admin.cmd('profile.save',{...ADULT,name:'Cezary Klubowy'+RUN,sex:'M',clubId:cl.data.user.clubId})).id;
 await ed.load();const a=(await ed.cmd('tournament.save',TOUR('Turniej Redakcji A '+RUN,{date:day(15)}))).id,b=(await ed.cmd('tournament.save',TOUR('Turniej Redakcji B '+RUN,{date:day(16),selfEntry:true}))).id;
 assert.deepEqual([tourOf(ed,a).selfEntry,tourOf(ed,b).selfEntry,tourOf(ed,a).community,tourOf(ed,a).trusted],[false,true,false,true],'staff tournaments take self-entries only when asked (R11)');
 const pe=(await ed.cmd('profile.save',{...ADULT,name:'Paweł Redakcyjny'+RUN,sex:'M',clubId:ed.data.user.clubId})).id;await ed.cmd('entry.save',{tournamentId:a,profileId:pe,...ENTRY});
 const rev=ed.data.revision;// the editor's check-in form stays open at this revision
 const X=await signUp({roles:{athlete:true},athlete:adult('Zofia Własna'+RUN)});const xId=(await view(X)).profiles[0].id;
 await call(X,'athlete-entry',{tournamentId:a,profileId:xId,...ENTRY},403,'Zapisy do tego turnieju są zamknięte.');
 await call(X,'athlete-entry',{tournamentId:b,profileId:xId,...ENTRY});
 const O=await signUp({roles:{organizer:true}});await O.load();const ot=(await O.cmd('tournament.save',TOUR('Turniej Obok '+RUN,{date:day(17)}))).id;
 for(let i=0;i<3;i++)await O.cmd('tournament.save',{...TOUR('Turniej Obok '+RUN,{date:day(17)}),id:ot,city:'Miasto '+i});
 // R15: the check-in in A at the old revision passes; a command on B, changed by the self-entry since, is stale.
 let r=await ed.req('command',{type:'checkin.save',payload:{tournamentId:a,id:pe,presence:'present',actualWeight:60},expectedRevision:rev});assert.equal(r.status,200,JSON.stringify(r.data));
 r=await ed.req('command',{type:'tournament.save',payload:{...TOUR('Turniej Redakcji B '+RUN,{date:day(16)}),id:b},expectedRevision:rev});error(r,409,'Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.');
 await ed.load();assert.deepEqual(tourOf(ed,b).entries.map(e=>[e.profileId,e.self]),[[xId,true]],'the editor sees the self-entry (O2)');assert.ok(!ed.data.profiles.some(p=>p.id===xId),'never the athlete\'s profile');
 await cl.load();await cl.cmd('entry.save',{tournamentId:b,profileId:pc,...ENTRY});
 assert.deepEqual(tourOf(cl,b).entries.map(e=>e.profileId),[pc],'the club sees its own entry only (O10)');
 const oc=tourOf(cl,ot);assert.ok(oc&&oc.community===true&&oc.entries.length===0&&!('createdBy' in oc),'a community tournament without its entries or creator');
 await admin.load();assert.ok(admin.data.users.every(u=>['admin','editor','club'].includes(u.role))&&!admin.data.users.some(u=>u.id===X.id||u.id===O.id),'members never enter the workspace');
});
