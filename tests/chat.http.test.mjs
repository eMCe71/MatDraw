// Chat over real PHP and MariaDB/MySQL (plan §11, chat-backend; run through scripts/test-http.sh): channel lists (four
// global channels in a fixed order, public cache, tournaments by visibility, lazy channels), the guest projection
// (exact keys, no personal data in the raw JSON, no cookie, public max-age=2), the member projection (people, private
// no-store), polling (204 also with h, COUNT only after knownLast changed, cursor, tombstones, more, cfg on a new settings
// version, e reports into chat_health, history), sending (idempotent cid, limits with Retry-After, profile, temporary
// password, mute, payment, archive, the settings switch, the chat-off file before the database), the tournament
// lifecycle (draft 404 for everybody, grace day for signed-in people only, archive read only), reports with automatic
// hiding, deletion with and without a copy of the text, Admin actions and settings (health: the last 60 minutes), panel
// actions on messages of a tournament set back to a draft, retention and account tombstones (two-digit msg_count).
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Client,base,fixture} from './helpers/http-client.mjs';
const shared=process.env.MATDRAW_TEST_SHARED_DIR;const skip=!base||!shared;
const ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='MemberPassword2026!',DAY=86_400_000;
const CLIENT=['on','t','ms','idle','bg','boost','safety','notice'],FIELDS=['id','r','t','g','c','b'],TOMB=['id','r','t','g','x'];
const warsaw=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const shift=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const TODAY=skip?'2030-01-01':warsaw(new Date()),now=()=>Math.floor(Date.now()/1000);
const cid=()=>randomBytes(16).toString('base64url');
/** GET with query parameters and an optional cookie; never stores cookies. */
async function get(route,params={},cookie){
 const qs=new URLSearchParams(params).toString();
 const r=await fetch(base+'?route='+route+(qs?'&'+qs:''),{headers:{'X-MatBravo-Client':'1',...(cookie?{Cookie:cookie}:{})}});
 const text=r.status===204?'':await r.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
 return {status:r.status,headers:r.headers,data,text};
}
const signIn=async(email,password=PASSWORD)=>{const c=new Client();await c.req('session');const r=await c.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return c;};
const me=async c=>{const r=await get('me',{},c.cookie);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
const send=(c,ch,b,extra={})=>c.req('chat-send',{ch,cid:cid(),b,...extra});
const error=(r,status,message)=>{assert.equal(r.status,status,JSON.stringify(r.data));if(message)assert.equal(r.data.error,message);};
const member=(email,profile=true,extra={})=>({...fixture('member',{email,password:PASSWORD,profile,exempt:true,...extra}),email});
const U={},C={};let general,karate,admin;
const T={};
before(async()=>{
 if(skip)return;
 fixture('reset-limits');
 // Limits are tested on purpose in one scenario; elsewhere they would only slow the tests down.
 fixture('chat-settings',{set:{send:{gap:0,perMin:1000,perDay:100000}}});
 U.m1=member('czat.zygfryda@test.example',{firstName:'Zygfryda',lastName:'Brzęczyszczykiewicz',username:'zygfryda_b',country:'PL',sports:['taekwondo','karate'],clubText:'KS Tygrys',showClub:true});
 for(const k of ['m2','m3','m4','m5'])U[k]=member(`czat.${k}@test.example`);
 U.nopay=member('czat.nopay@test.example',true,{exempt:false});
 U.incomplete=member('czat.incomplete@test.example',false);
 U.temp=member('czat.temp@test.example',{pwResetAt:now()});
 U.muted=member('czat.muted@test.example');
 for(const k of Object.keys(U))C[k]=await signIn(U[k].email);
 admin=await signIn(...ADMIN);
 general=fixture('chat-channel',{slug:'general'});karate=fixture('chat-channel',{slug:'karate'});
 T.future=fixture('tournament',{name:'Puchar Czatu 2031',date:'2031-05-10'}).id;
 T.draft=fixture('tournament',{name:'Szkic czatu',date:'2031-06-01',status:'draft'}).id;
 T.grace=fixture('tournament',{name:'Wczorajszy turniej',date:shift(TODAY,-1),status:'finished'}).id;
 T.archive=fixture('tournament',{name:'Archiwalny turniej',date:shift(TODAY,-3),status:'closed'}).id;
 T.emptyArchive=fixture('tournament',{name:'Pusty archiwalny',date:shift(TODAY,-4)}).id;
});
after(()=>{
 if(skip)return;
 const flag=path.join(shared,'chat-off');if(existsSync(flag))unlinkSync(flag);
 fixture('chat-table',{table:'chat_channels',hide:false});fixture('chat-settings',{reset:true});
 for(const u of Object.values(U))fixture('chat-mute',{userId:u.id,remove:true});
});

test('public-chat-channels: four global channels in a fixed order, public cache 30 s, no cookie; guests see upcoming tournaments only',{skip},async()=>{
 const r=await get('public-chat-channels');
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'public, max-age=30');assert.equal(r.headers.get('set-cookie'),null);
 assert.deepEqual(Object.keys(r.data),['cv','cfg','lobby','tournaments']);assert.deepEqual(Object.keys(r.data.cfg),CLIENT);
 assert.deepEqual(r.data.lobby.map(l=>[l.slug,l.scope,l.st]),[['taekwondo','world','open'],['taekwondo-pl','pl','open'],['karate','world','open'],['general','world','open']]);
 for(const l of r.data.lobby){assert.deepEqual(Object.keys(l),['id','slug','scope','last','count','st']);assert.equal(typeof l.id,'number');}
 const ids=r.data.tournaments.map(t=>t.tournamentId);
 for(const id of [T.draft,T.grace,T.archive,T.emptyArchive])assert.ok(!ids.includes(id),'guests see neither drafts nor past tournaments');
 assert.deepEqual(r.data.tournaments.find(t=>t.tournamentId===T.future),{id:null,tournamentId:T.future,title:'Puchar Czatu 2031',date:'2031-05-10',city:'Warszawa',st:'open',last:0,count:0},'no channel yet: nothing is written by a public GET');
 const withCookie=await get('public-chat-channels',{},C.m1.cookie);
 assert.equal(withCookie.headers.get('set-cookie'),null);assert.deepEqual(withCookie.data,r.data,'public routes ignore cookies');
 const post=await fetch(base+'?route=public-chat-channels',{method:'POST',headers:{'X-MatBravo-Client':'1'}});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');
});

test('chat-channels (signed in): creates missing channels, adds the grace day and the used archive; 401 without a session',{skip},async()=>{
 const r=await get('chat-channels',{},C.m2.cookie);
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('set-cookie'),null);
 const by=Object.fromEntries(r.data.tournaments.map(t=>[t.tournamentId,t]));
 assert.equal(typeof by[T.future].id,'number');assert.equal(by[T.future].st,'open');assert.equal(by[T.grace].st,'open');assert.equal(typeof by[T.grace].id,'number');
 assert.ok(!(T.draft in by),'never a draft');assert.ok(!(T.archive in by)&&!(T.emptyArchive in by),'an archive that was never written is not listed');
 const archive=fixture('chat-channel',{tournamentId:T.archive});fixture('chat-messages',{channelId:archive.id,userId:U.m1.id,n:2});
 const again=(await get('chat-channels',{},C.nopay.cookie)).data.tournaments;
 const a=again.find(t=>t.tournamentId===T.archive);assert.deepEqual([a.st,a.count,a.id],['archive',2,Number(archive.id)]);
 assert.ok(again.findIndex(t=>t.tournamentId===T.archive)>again.findIndex(t=>t.tournamentId===T.future),'archive after the open chats');
 assert.equal((await get('public-chat-channels')).data.tournaments.find(t=>t.tournamentId===T.future).id,by[T.future].id,'guests now get the channel id');
 error(await get('chat-channels'),401,'Zaloguj się ponownie.');
});

test('public-chat: exact keys, no personal data in the raw JSON, Cache-Control public, max-age=2, no cookie',{skip},async()=>{
 const s1=await send(C.m1,general.id,'Dzień dobry wszystkim!');
 assert.equal(s1.status,200,JSON.stringify(s1.data));assert.deepEqual(Object.keys(s1.data),['m','rev','people']);
 assert.equal(s1.data.m.a,U.m1.publicId);assert.equal(s1.data.m.b,'Dzień dobry wszystkim!');assert.equal(s1.data.rev,s1.data.m.r);
 assert.deepEqual(s1.data.people,{[U.m1.publicId]:{n:'Zygfryda B.',u:'zygfryda_b',cc:'PL',sp:['taekwondo','karate'],club:'KS Tygrys',av:null,mod:false,since:s1.data.people[U.m1.publicId].since}});
 const s2=await send(C.m1,general.id,'Za chwilę to usunę');assert.equal((await C.m1.req('chat-delete',{id:s2.data.m.id})).status,200);
 const r=await get('public-chat',{ch:`${general.id}:0`});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'public, max-age=2');assert.equal(r.headers.get('set-cookie'),null);
 assert.deepEqual(Object.keys(r.data),['cv','cfg','ch','heads']);
 const ch=r.data.ch[general.id];assert.deepEqual(Object.keys(ch),['rev','st','more','older','m']);
 for(const m of ch.m){assert.deepEqual(Object.keys(m),'x' in m?TOMB:FIELDS);assert.ok(m.g>=0&&m.g<=4);}
 assert.ok(ch.m.some(m=>m.id===s1.data.m.id&&m.b==='Dzień dobry wszystkim!'));assert.ok(ch.m.some(m=>m.id===s2.data.m.id&&m.x==='author'&&!('b' in m)));
 for(const secret of [U.m1.email,'Zygfryda','Brzęczyszczykiewicz','zygfryda_b',U.m1.publicId,U.m1.id,'KS Tygrys','Za chwilę'])assert.ok(!r.text.includes(secret),secret);
 const withCookie=await get('public-chat',{ch:`${general.id}:0`},C.m2.cookie);
 assert.equal(withCookie.headers.get('set-cookie'),null);assert.ok(!('people' in withCookie.data)&&!withCookie.text.includes(U.m1.publicId),'a member cookie changes nothing');
});

test('chat-feed: full access gets people with private, no-store; signed in without full access gets the guest projection; 401',{skip},async()=>{
 const s=await send(C.m1,general.id,'Kto jedzie na zawody?');
 const f=await get('chat-feed',{ch:`${general.id}:0`},C.m2.cookie);
 assert.equal(f.status,200,JSON.stringify(f.data));assert.equal(f.headers.get('cache-control'),'private, no-store');assert.equal(f.headers.get('set-cookie'),null);
 assert.deepEqual(Object.keys(f.data),['cv','cfg','ch','heads','people']);
 const m=f.data.ch[general.id].m.find(x=>x.id===s.data.m.id);assert.deepEqual(Object.keys(m),['id','r','t','a','c','b']);assert.equal(m.a,U.m1.publicId);
 assert.deepEqual(f.data.people[U.m1.publicId],s.data.people[U.m1.publicId]);assert.ok(!f.text.includes(U.m1.email)&&!f.text.includes(U.m1.id),'no e-mail and no internal id');
 assert.ok(f.data.ch[general.id].m.filter(x=>'x' in x).every(x=>x.a===U.m1.publicId&&!('b' in x)),'member tombstones keep the author, never the text');
 const n=await get('chat-feed',{ch:`${general.id}:0`},C.nopay.cookie);
 assert.equal(n.status,200);assert.equal(n.headers.get('cache-control'),'private, no-store');assert.deepEqual(Object.keys(n.data),['cv','cfg','ch','heads']);
 for(const x of n.data.ch[general.id].m)assert.deepEqual(Object.keys(x),'x' in x?TOMB:FIELDS);
 assert.ok(!n.text.includes(U.m1.publicId)&&!n.text.includes('Zygfryda'));
 error(await get('chat-feed',{ch:`${general.id}:0`}),401,'Zaloguj się ponownie.');
 error(await get('chat-feed',{ch:`${general.id}:0`},'matdraw_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAA'),401,'Zaloguj się ponownie.');
});

test('polling: 204 without changes (also with h), COUNT only after knownLast changed, cursor, tombstone, more, cfg, e, history',{skip},async()=>{
 const t=fixture('tournament',{name:'Polling 2031',date:'2031-07-01'}).id;const ch=fixture('chat-channel',{tournamentId:t});const id=String(ch.id);
 fixture('chat-messages',{channelId:ch.id,userId:U.m1.id,n:3});
 const cv=String((await get('public-chat')).data.cv);
 const first=await get('chat-feed',{ch:`${id}:0`,cv},C.m2.cookie);
 assert.equal(first.status,200);assert.ok(!('cfg' in first.data),'cfg only for a stale cv');
 assert.deepEqual([first.data.ch[id].rev,first.data.ch[id].m.length,first.data.ch[id].older,first.data.ch[id].more],[3,3,false,false]);
 const k=fixture('chat-channel',{slug:'karate'}),h=`${k.id}:${k.last_message_id}:${k.last_message_id}`;
 let r=await get('chat-feed',{ch:`${id}:3`,h,cv},C.m2.cookie);assert.equal(r.status,204);assert.equal(r.text,'');
 r=await get('public-chat',{ch:`${id}:3`,h,cv});assert.equal(r.status,204);assert.equal(r.headers.get('cache-control'),'public, max-age=2');
 const sent=await send(C.m1,ch.id,'czwarta');assert.equal(sent.status,200,JSON.stringify(sent.data));
 r=await get('chat-feed',{ch:`${id}:3`,h,cv},C.m2.cookie);
 assert.deepEqual(r.data.ch[id].m.map(m=>[m.id,m.r,m.b]),[[sent.data.m.id,4,'czwarta']],'only the change after the cursor');assert.equal(r.data.ch[id].rev,4);
 assert.deepEqual(r.data.heads,{},'unchanged background channel: no COUNT and nothing sent');
 const added=fixture('chat-messages',{channelId:k.id,userId:U.m1.id,n:2});
 r=await get('chat-feed',{ch:`${id}:4`,h,cv},C.m2.cookie);
 assert.equal(r.status,200);assert.deepEqual(r.data.ch,{},'a channel without changes is left out');assert.deepEqual(r.data.heads,{[k.id]:{last:added.last,n:2}});
 r=await get('chat-feed',{h:`${k.id}:${added.last}:${k.last_message_id}`,cv},C.m2.cookie);assert.deepEqual(r.data.heads,{[k.id]:{last:added.last,n:0}},'everything read');
 assert.equal((await C.m1.req('chat-delete',{id:sent.data.m.id})).status,200);
 r=await get('chat-feed',{ch:`${id}:4`,cv},C.m2.cookie);assert.deepEqual(r.data.ch[id].m,[{id:sent.data.m.id,r:5,t:sent.data.m.t,a:U.m1.publicId,x:'author'}]);
 r=await get('public-chat',{ch:`${id}:4`,cv});assert.deepEqual(Object.keys(r.data.ch[id].m[0]),TOMB);assert.equal(r.data.ch[id].m[0].x,'author');
 fixture('chat-messages',{channelId:ch.id,userId:U.m1.id,n:101});
 r=await get('chat-feed',{ch:`${id}:5`,cv},C.m2.cookie);
 assert.deepEqual([r.data.ch[id].more,r.data.ch[id].m.length,r.data.ch[id].rev,r.data.ch[id].m.at(-1).r],[true,100,105,105],'more after 100 changes, the cursor of the last one');
 r=await get('chat-feed',{ch:`${id}:105`,cv},C.m2.cookie);assert.deepEqual([r.data.ch[id].more,r.data.ch[id].m.length,r.data.ch[id].rev],[false,1,106]);
 r=await get('chat-feed',{ch:`${id}:999`,cv},C.m2.cookie);assert.deepEqual([r.data.ch[id].more,r.data.ch[id].m],[true,[]],'a cursor beyond the channel asks for a reload');
 const init=(await get('chat-feed',{ch:`${id}:0`,cv},C.m2.cookie)).data.ch[id];assert.deepEqual([init.m.length,init.older,init.rev],[50,true,106]);
 const hist=(await get('chat-feed',{ch:`${id}:0`,before:String(init.m[0].id),cv},C.m2.cookie)).data.ch[id];
 assert.deepEqual(Object.keys(hist),['st','older','m'],'history carries no cursor');assert.equal(hist.m.length,30);assert.ok(hist.m.every((m,i)=>m.id<init.m[0].id&&(i===0||m.id>hist.m[i-1].id)));
 const v=fixture('chat-settings',{set:{boost:301}}).version;
 r=await get('chat-feed',{ch:`${id}:106`,cv},C.m2.cookie);
 assert.equal(r.status,200);assert.equal(r.data.cv,v);assert.deepEqual(Object.keys(r.data.cfg),CLIENT);assert.equal(r.data.cfg.boost,301);assert.ok(!('send' in r.data.cfg));assert.deepEqual(r.data.ch,{});
 assert.equal((await get('chat-feed',{ch:`${id}:106`,cv:String(v)},C.m2.cookie)).status,204);
 const hour=Math.floor(now()/3600)*3600,count=s=>fixture('chat-health').filter(x=>x.hour_at===hour&&x.status===s).reduce((a,x)=>a+x.n,0);
 const h429=count(429),h0=count(0);
 assert.equal((await get('public-chat',{ch:`${id}:106`,cv:String(v),e:'3:429'})).status,204,'the report rides on a normal poll');
 assert.equal((await get('chat-feed',{e:'2:0',cv:String(v)},C.m2.cookie)).status,204);
 assert.deepEqual([count(429)-h429,count(0)-h0],[3,2]);
 for(const q of [{ch:'1:x'},{ch:`${id}:5`,before:'10'},{e:'51:429'},{e:'2:404'},{h:Array.from({length:31},(_,i)=>`${i+1}:0:0`).join(',')},{ch:Array.from({length:7},(_,i)=>`${i+1}:0`).join(',')}]){
  error(await get('public-chat',q),400,'Niepoprawne zapytanie czatu.');error(await get('chat-feed',q,C.m2.cookie),400,'Niepoprawne zapytanie czatu.');
 }
 error(await fetch(base+'?route=public-chat&ch[]=1:0').then(async x=>({status:x.status,data:await x.json()})),400,'Niepoprawne zapytanie czatu.');
});

test('sending: repeated cid, limits with Retry-After, profile, temporary password, mute (also in me), payment, archive, switches',{skip},async()=>{
 const before=Number(fixture('chat-channel',{slug:'general'}).msg_count),key=cid();
 const a=await C.m1.req('chat-send',{ch:general.id,cid:key,b:'Raz'}),b=await C.m1.req('chat-send',{ch:general.id,cid:key,b:'Raz'});
 assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual(b.data,a.data,'the stored message again');
 const k0=Number(fixture('chat-channel',{slug:'karate'}).msg_count);
 error(await C.m1.req('chat-send',{ch:karate.id,cid:key,b:'Raz'}),400,'Niepoprawny formularz.');// a cid is single-use: never a confirmation from another channel
 assert.equal(Number(fixture('chat-channel',{slug:'karate'}).msg_count),k0);
 assert.equal(Number(fixture('chat-channel',{slug:'general'}).msg_count),before+1);
 fixture('chat-settings',{set:{send:{gap:2}}});
 assert.equal((await send(C.m4,general.id,'pierwsza')).status,200);
 let r=await send(C.m4,general.id,'za szybko');error(r,429,'Wysyłasz wiadomości zbyt szybko. Spróbuj za chwilę.');
 assert.ok(r.data.retry>=1&&r.data.retry<=2);assert.equal(r.headers.get('retry-after'),String(r.data.retry));
 fixture('chat-settings',{set:{send:{gap:0,perMin:2}}});
 assert.equal((await send(C.m4,general.id,'druga')).status,200);
 r=await send(C.m4,general.id,'trzecia');error(r,429);assert.ok(r.data.retry>=1&&r.data.retry<=60);
 // Parallel sends from several sessions of one account (one paid account signed in on six devices) cannot beat the gap:
 // the limit is checked again under the sender's row lock, so exactly one of them is stored.
 fixture('chat-settings',{set:{send:{gap:5,perMin:1000}}});
 const burster=member('czat.burst@test.example'),devices=await Promise.all(Array.from({length:6},()=>signIn(burster.email)));
 const burst=await Promise.all(devices.map((d,i)=>send(d,i%2?karate.id:general.id,'równolegle '+i)));
 assert.deepEqual(burst.map(x=>x.status).sort(),[200,429,429,429,429,429],JSON.stringify(burst.map(x=>[x.status,x.data?.error])));
 fixture('chat-settings',{set:{send:{gap:0,perMin:1000}}});
 error(await send(C.incomplete,general.id,'x'),403,'Uzupełnij profil, aby pisać na czacie.');
 error(await send(C.temp,general.id,'x'),403,'Najpierw zmień hasło tymczasowe.');
 assert.deepEqual([(await me(C.temp)).access.block,(await me(C.temp)).profile.mustChangePassword],['password',true]);
 error(await send(C.nopay,general.id,'x'),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 const until=now()+3600;fixture('chat-mute',{userId:U.muted.id,untilAt:until});
 r=await send(C.muted,general.id,'x');error(r,403,'Moderator wstrzymał Twoje pisanie.');assert.equal(r.data.until,until);
 let m=await me(C.muted);assert.deepEqual([m.access.block,m.access.mutedUntil,m.access.canPost],['muted',until,false]);
 fixture('chat-mute',{userId:U.muted.id,untilAt:null});
 r=await send(C.muted,general.id,'x');error(r,403);assert.equal(r.data.until,null);m=await me(C.muted);assert.deepEqual([m.access.block,m.access.mutedUntil],['muted',null]);
 fixture('chat-mute',{userId:U.muted.id,untilAt:now()-5});assert.equal((await send(C.muted,general.id,'Już mogę')).status,200,'an expired mute does not count');
 assert.deepEqual([(await me(C.muted)).access.block,(await me(C.m1)).access.canPost],[null,true]);
 const archive=fixture('chat-channel',{tournamentId:T.archive});error(await send(C.m1,archive.id,'x'),409,'Ten czat jest tylko do odczytu.');
 error(await C.m1.req('chat-send',{t:T.archive,cid:cid(),b:'x'}),409,'Ten czat jest tylko do odczytu.');
 const fresh=fixture('tournament',{name:'Nowy czat 2031',date:'2031-08-01'}).id;
 r=await C.m1.req('chat-send',{t:fresh,cid:cid(),b:'Pierwsza w turnieju'});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(Number(fixture('chat-message',{id:r.data.m.id}).channel_id),Number(fixture('chat-channel',{tournamentId:fresh}).id),'the channel was created by the first message');
 for(const t of [T.draft,'no-such-tournament'])error(await C.m1.req('chat-send',{t,cid:cid(),b:'x'}),404,'Ten czat nie istnieje.');
 error(await send(C.m1,999999,'x'),404,'Ten czat nie istnieje.');
 error(await C.m1.req('chat-send',{ch:general.id,t:fresh,cid:cid(),b:'x'}),400);
 error(await C.m1.req('chat-send',{ch:general.id,cid:'short',b:'x'}),400);
 error(await send(C.m1,general.id,' \n\t '),422,'Wiadomość jest pusta.');error(await send(C.m1,general.id,'x'.repeat(1001)),422,'Wiadomość może mieć najwyżej 1000 znaków.');
 r=await send(C.m1,general.id,'  a‮b​c  ');assert.equal(r.data.m.b,'abc','bidi and zero-width characters removed before storing');
 const anon=new Client();await anon.req('session');error(await anon.req('chat-send',{ch:general.id,cid:cid(),b:'x'}),401,'Zaloguj się ponownie.');
 fixture('chat-settings',{set:{on:false}});
 r=await send(C.m1,general.id,'x');error(r,503,'Czat jest chwilowo wyłączony. Spróbuj później.');assert.equal(r.data.code,'chat_off');assert.equal(r.headers.get('retry-after'),'300');
 assert.equal((await me(C.m1)).access.block,'off');
 error(await anon.req('chat-send',{ch:general.id,cid:cid(),b:'x'}),503,'Czat jest chwilowo wyłączony. Spróbuj później.');// the switch before the sign-in (§5.5)
 fixture('chat-settings',{set:{on:true}});
});

test('chat-off file: 503 chat_off before the database (also with the channel table gone); the API keeps working otherwise',{skip},async()=>{
 const flag=path.join(shared,'chat-off');
 try{
  fixture('chat-table',{table:'chat_channels',hide:true});
  error(await get('public-chat',{ch:`${general.id}:0`}),503,'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.');
  writeFileSync(flag,'');
  for(const r of [await get('public-chat',{ch:`${general.id}:0`}),await get('public-chat-channels'),await get('chat-feed',{},C.m1.cookie),await send(C.m1,general.id,'x'),await get('admin-chat-settings',{},admin.cookie)]){
   error(r,503,'Czat jest chwilowo wyłączony. Spróbuj później.');assert.equal(r.data.code,'chat_off');assert.equal(r.headers.get('retry-after'),'300');
  }
  assert.equal((await get('me',{},C.m1.cookie)).data.features.chat,false,'me reports the chat as off');
 }finally{if(existsSync(flag))unlinkSync(flag);fixture('chat-table',{table:'chat_channels',hide:false});}
 assert.equal((await get('public-chat',{ch:`${general.id}:0`})).status,200);
});

test('tournament lifecycle: draft 404 for everybody, the grace day only for signed-in people, the archive read only',{skip},async()=>{
 const draft=fixture('chat-channel',{tournamentId:T.draft}),msg=fixture('chat-messages',{channelId:draft.id,userId:U.m1.id,n:1}).messages[0];
 for(const c of [C.m1,C.m2])error(await send(c,draft.id,'x'),404,'Ten czat nie istnieje.');
 for(const c of [C.m1,C.m2,admin]){// the author, another member and the Admin: the draft does not exist for anybody
  error(await c.req('chat-report',{id:msg.id,reason:'spam'}),404,'Wiadomość nie istnieje.');
  error(await c.req('chat-delete',{id:msg.id}),404,'Wiadomość nie istnieje.');
 }
 error(await C.m2.req('chat-report',{id:987654321,reason:'spam'}),404,'Wiadomość nie istnieje.');error(await C.m2.req('chat-delete',{id:987654321}),404,'Wiadomość nie istnieje.');
 assert.deepEqual((await get('chat-feed',{ch:`${draft.id}:0`},C.m2.cookie)).data.ch[draft.id],{st:'gone'});
 assert.deepEqual((await get('public-chat',{ch:`${draft.id}:0`})).data.ch[draft.id],{st:'gone'});
 const grace=fixture('chat-channel',{tournamentId:T.grace});
 assert.equal((await send(C.m2,grace.id,'Gratulacje dla wszystkich!')).status,200,'full access writes on the grace day');
 assert.deepEqual((await get('public-chat',{ch:`${grace.id}:0`})).data.ch[grace.id],{st:'gone'},'guests: gone like GuestView');
 const n=(await get('chat-feed',{ch:`${grace.id}:0`},C.nopay.cookie)).data.ch[grace.id];assert.equal(n.st,'open');assert.deepEqual(Object.keys(n.m[0]),FIELDS);
 const archive=fixture('chat-channel',{tournamentId:T.archive});
 assert.deepEqual((await get('public-chat',{ch:`${archive.id}:0`,h:`${grace.id}:0:0`})).data,{cv:(await get('public-chat')).data.cv,cfg:(await get('public-chat')).data.cfg,ch:{[archive.id]:{st:'gone'}},heads:{[grace.id]:{st:'gone'}}});
 const a=(await get('chat-feed',{ch:`${archive.id}:0`},C.m2.cookie)).data.ch[archive.id];assert.equal(a.st,'archive');assert.equal(a.m.length,2);
 assert.equal((await get('chat-feed',{ch:`${archive.id}:0`},C.nopay.cookie)).data.ch[archive.id].st,'archive','signed in without full access reads the archive too');
 error(await send(C.m2,archive.id,'x'),409,'Ten czat jest tylko do odczytu.');
 assert.equal((await C.m2.req('chat-report',{id:a.m[0].id,reason:'other'})).status,200,'an archived message can still be reported');
});

test('reports: idempotent per person, own and deleted refused, three different people hide the message for review',{skip},async()=>{
 const msg=(await send(C.m1,general.id,'Kupię tanio, pisz na priv')).data.m;
 let r=await C.m2.req('chat-report',{id:msg.id,reason:'spam',comment:'  <b>reklama</b>‮  '});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data,{ok:true});
 assert.equal((await C.m2.req('chat-report',{id:msg.id,reason:'abuse'})).status,200,'a repeated report is accepted and ignored');
 const rows=fixture('chat-reports',{messageId:msg.id});assert.deepEqual(rows.map(x=>[x.reporter_id,x.reason,x.comment,x.status]),[[U.m2.id,'spam','<b>reklama</b>','open']]);
 assert.equal(fixture('chat-message',{id:msg.id}).report_count,1);
 error(await C.m1.req('chat-report',{id:msg.id,reason:'spam'}),403,'Nie możesz zgłosić własnej wiadomości.');
 error(await C.m3.req('chat-report',{id:msg.id,reason:'nonsense'}),422,'Wybierz powód zgłoszenia.');
 error(await C.m3.req('chat-report',{id:msg.id,reason:'spam',comment:'x'.repeat(301)}),422,'Komentarz może mieć najwyżej 300 znaków.');
 error(await C.nopay.req('chat-report',{id:msg.id,reason:'spam'}),402,'Ta funkcja wymaga aktywnej subskrypcji.');
 assert.equal((await C.m3.req('chat-report',{id:msg.id,reason:'harassment'})).status,200);
 assert.equal(fixture('chat-message',{id:msg.id}).state,'visible','two reports: still visible');
 assert.equal((await C.m4.req('chat-report',{id:msg.id,reason:'child_data'})).status,200);
 const hidden=fixture('chat-message',{id:msg.id});assert.equal(hidden.state,'hidden_review');assert.ok(Number(hidden.rev)>msg.r,'a new rev');assert.equal(hidden.body,'Kupię tanio, pisz na priv','kept for review');
 const feed=(await get('chat-feed',{ch:`${general.id}:${Number(hidden.rev)-1}`},C.m2.cookie)).data.ch[general.id].m.find(x=>x.id===msg.id);
 assert.deepEqual(feed,{id:msg.id,r:Number(hidden.rev),t:msg.t,a:U.m1.publicId,x:'review'});
 const guest=(await get('public-chat',{ch:`${general.id}:0`})).data.ch[general.id].m.find(x=>x.id===msg.id);assert.deepEqual(Object.keys(guest),TOMB);assert.equal(guest.x,'review');
 assert.deepEqual(fixture('chat-log',{messageId:msg.id}).map(x=>[x.actor_id,x.action,x.original_body,x.target_user_id]),[['system','auto_hide','Kupię tanio, pisz na priv',U.m1.id]]);
 assert.deepEqual((await C.m5.req('chat-report',{id:msg.id,reason:'spam'})).data,{ok:true},'hidden for review: already waiting for the moderator');
 assert.equal(fixture('chat-reports',{messageId:msg.id}).length,3);assert.equal(fixture('chat-message',{id:msg.id}).report_count,3,'no row and no count from a tombstone');
 const gone=(await send(C.m1,general.id,'Zaraz zniknie')).data.m;await C.m1.req('chat-delete',{id:gone.id});
 error(await C.m2.req('chat-report',{id:gone.id,reason:'spam'}),404,'Wiadomość nie istnieje.');
 error(await C.m2.req('chat-report',{id:'7',reason:'spam'}),400);
 T.hidden=msg.id;
});

test('deleting: the author leaves no copy unless the message was reported; the Admin keeps one; others 403; repeat is ok',{skip},async()=>{
 const a=(await send(C.m1,general.id,'Pomyłka: mój numer to 600 100 200')).data.m;
 assert.deepEqual((await C.m1.req('chat-delete',{id:a.id})).data,{ok:true});
 assert.deepEqual(fixture('chat-log',{messageId:a.id}),[],'no copy of an ordinary deletion of one\'s own message');
 const row=fixture('chat-message',{id:a.id});assert.deepEqual([row.state,row.body],['deleted_author','']);
 const b=(await send(C.m1,general.id,'Zgłoszona i usunięta')).data.m;await C.m2.req('chat-report',{id:b.id,reason:'abuse'});
 assert.equal((await C.m1.req('chat-delete',{id:b.id})).status,200);
 assert.deepEqual(fixture('chat-log',{messageId:b.id}).map(x=>[x.actor_id,x.action,x.original_body]),[[U.m1.id,'delete_author','Zgłoszona i usunięta']]);
 const c=(await send(C.m1,general.id,'Do usunięcia przez moderatora')).data.m;await C.m3.req('chat-report',{id:c.id,reason:'spam'});
 error(await C.m2.req('chat-delete',{id:c.id}),403,'Brak uprawnień.');
 error(await C.m2.req('chat-delete',{id:c.id,note:'x'.repeat(301)}),403,'Brak uprawnień.');// permission before the note
 error(await admin.req('chat-delete',{id:c.id,note:'x'.repeat(301)}),422,'Notatka może mieć najwyżej 300 znaków.');
 assert.equal((await admin.req('chat-delete',{id:c.id,note:'Reklama'})).status,200);
 const adminId=(await me(admin)).user.id;
 assert.deepEqual(fixture('chat-log',{messageId:c.id}).map(x=>[x.actor_id,x.action,x.original_body,x.note]),[[adminId,'delete_mod','Do usunięcia przez moderatora','Reklama']]);
 assert.deepEqual(fixture('chat-reports',{messageId:c.id}).map(x=>x.status),['actioned']);
 const t=(await get('chat-feed',{ch:`${general.id}:0`},C.m2.cookie)).data.ch[general.id].m.find(x=>x.id===c.id);assert.equal(t.x,'mod');
 for(const who of [admin,C.m1])assert.deepEqual((await who.req('chat-delete',{id:c.id})).data,{ok:true},'already deleted');
 error(await C.m1.req('chat-delete',{id:'abc'}),400);
});

test('Admin: report queue with context and mutes, restore, dismiss, mute/unmute, channel status, settings with health; others 403',{skip},async()=>{
 for(const r of [await get('admin-chat-reports',{},C.m1.cookie),await get('admin-chat-settings',{},C.m1.cookie),await C.m1.req('admin-chat-action',{action:'unmute',userId:U.m4.id}),await C.m1.req('admin-chat-settings-save',{on:false})])error(r,403,'Brak uprawnień.');
 error(await get('admin-chat-reports'),401);
 const adminId=(await me(admin)).user.id;
 let r=await get('admin-chat-reports',{},admin.cookie);
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual(Object.keys(r.data),['total','page','items']);
 const item=r.data.items.find(i=>i.message.id===T.hidden);
 assert.deepEqual([item.message.state,item.message.body,item.message.channel.slug,item.author.email,item.author.username,item.reports.count],['hidden_review','Kupię tanio, pisz na priv','general',U.m1.email,'zygfryda_b',3]);
 assert.deepEqual(item.reports.reasons,{spam:1,harassment:1,child_data:1});assert.equal(item.reports.items[0].comment,'<b>reklama</b>');assert.equal(item.muted,null);
 assert.ok(r.data.total>=1);error(await get('admin-chat-reports',{status:'weird'},admin.cookie),400);
 const ctx=(await get('admin-chat-reports',{context:String(T.hidden)},admin.cookie)).data;
 assert.ok(ctx.items.some(i=>i.id===T.hidden)&&ctx.items.length<=5);assert.equal(ctx.items.find(i=>i.id===T.hidden).author.username,'zygfryda_b');
 assert.deepEqual((await admin.req('admin-chat-action',{action:'restore',messageId:T.hidden})).data,{ok:true});
 const back=(await get('chat-feed',{ch:`${general.id}:0`},C.m2.cookie)).data.ch[general.id].m.find(x=>x.id===T.hidden);assert.equal(back.b,'Kupię tanio, pisz na priv');
 error(await admin.req('admin-chat-action',{action:'restore',messageId:T.hidden}),409,'Tej wiadomości nie można przywrócić.');
 assert.equal((await admin.req('admin-chat-action',{action:'dismiss',messageId:T.hidden,note:'W porządku'})).status,200);
 assert.ok(fixture('chat-reports',{messageId:T.hidden}).every(x=>x.status==='dismissed'&&x.resolved_by===adminId));
 assert.ok(!(await get('admin-chat-reports',{},admin.cookie)).data.items.some(i=>i.message.id===T.hidden),'no longer in the open queue');
 assert.ok((await get('admin-chat-reports',{status:'dismissed'},admin.cookie)).data.items.some(i=>i.message.id===T.hidden));
 r=await admin.req('admin-chat-action',{action:'mute',userId:U.m4.id,duration:'24h',reason:'Spam w kanale'});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(Math.abs(r.data.until-(now()+86400))<=5);
 let m=await me(C.m4);assert.deepEqual([m.access.block,m.access.mutedUntil],['muted',r.data.until]);error(await send(C.m4,general.id,'x'),403);
 const list=(await get('admin-chat-reports',{view:'muted'},admin.cookie)).data.items.find(i=>i.user.id===U.m4.id);
 assert.deepEqual([list.until,list.reason,list.createdBy.email],[r.data.until,'Spam w kanale',ADMIN[0]]);
 assert.equal((await admin.req('admin-chat-action',{action:'unmute',userId:U.m4.id})).status,200);m=await me(C.m4);assert.equal(m.access.block,null);
 assert.deepEqual(fixture('chat-log',{targetUserId:U.m4.id}).map(x=>[x.action,x.actor_id]).slice(-2),[['mute',adminId],['unmute',adminId]]);
 error(await admin.req('admin-chat-action',{action:'mute',userId:adminId,duration:'1h'}),422,'Nie można wyciszyć Administratora.');
 error(await admin.req('admin-chat-action',{action:'mute',userId:U.m4.id,duration:'2h'}),422,'Wybierz czas wyciszenia.');
 error(await admin.req('admin-chat-action',{action:'mute',userId:'nobody',duration:'1h'}),404,'Konto nie istnieje.');
 error(await admin.req('admin-chat-action',{action:'explode'}),400,'Nieznana operacja moderacji.');
 const cur=Number(fixture('chat-channel',{slug:'general'}).rev);
 assert.equal((await admin.req('admin-chat-action',{action:'channel',channelId:Number(general.id),status:'readonly'})).status,200);
 r=await get('chat-feed',{ch:`${general.id}:${cur}`},C.m2.cookie);assert.deepEqual([r.data.ch[general.id].st,r.data.ch[general.id].rev,r.data.ch[general.id].m],['closed',cur+1,[]],'pollers learn the new state');
 error(await send(C.m1,general.id,'x'),409,'Ten czat jest tylko do odczytu.');
 assert.equal((await get('public-chat-channels')).data.lobby.find(l=>l.slug==='general').st,'closed');
 error(await admin.req('admin-chat-action',{action:'channel',channelId:Number(general.id),status:'gone'}),422,'Niepoprawny status kanału.');
 assert.equal((await admin.req('admin-chat-action',{action:'channel',channelId:Number(general.id),status:'open'})).status,200);
 const future=fixture('chat-channel',{tournamentId:T.future});
 await admin.req('admin-chat-action',{action:'channel',channelId:Number(future.id),status:'closed'});
 assert.equal((await get('public-chat',{ch:`${future.id}:0`})).data.ch[future.id].st,'gone','closed by the Admin: hidden from guests');
 assert.ok(!(await get('public-chat-channels')).data.tournaments.some(t=>t.tournamentId===T.future));
 assert.equal((await get('chat-feed',{ch:`${future.id}:0`},C.m2.cookie)).data.ch[future.id].st,'closed','signed-in people still read it');
 await admin.req('admin-chat-action',{action:'channel',channelId:Number(future.id),status:'open'});
 const hour=Math.floor(now()/3600)*3600;fixture('chat-health-add',{hourAt:hour-3600,status:508,n:3600});fixture('chat-health-add',{hourAt:hour-7200,status:508,n:500});
 const t0=now(),s=(await get('admin-chat-settings',{},admin.cookie)).data,t1=now();
 assert.deepEqual(Object.keys(s),['version','on','preset','ms','notice','presets','send','autoHide','updatedAt','health']);
 assert.deepEqual(Object.keys(s.health),['0','429','503','508']);assert.ok(s.health['429']>=3&&s.health['0']>=2,'client reports of the polling test');
 if(Math.floor(t1/3600)*3600===hour)assert.ok(s.health['508']>=3600-(t1-hour)&&s.health['508']<=3600-(t0-hour),`the last 60 minutes: the previous hour weighted, two hours back never (${s.health['508']})`);
 for(const at of [hour-3600,hour-7200])fixture('chat-health-add',{hourAt:at,status:508,n:0});
 r=await admin.req('admin-chat-settings-save',{preset:'saver',notice:'  Przerwa‮ o 18:00  ',version:s.version});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual([r.data.version,r.data.preset,r.data.ms,r.data.notice,r.data.on],[s.version+1,'saver',[5000,10000,30000,60000,120000],'Przerwa o 18:00',true]);
 error(await admin.req('admin-chat-settings-save',{on:false,version:s.version}),409,'Ustawienia czatu zmienił w międzyczasie ktoś inny. Odśwież stronę.');
 error(await admin.req('admin-chat-settings-save',{notice:'x'.repeat(301)}),422,'Komunikat może mieć najwyżej 300 znaków.');
 error(await admin.req('admin-chat-settings-save',{preset:'turbo'}),422,'Nieznany tryb tempa czatu.');error(await admin.req('admin-chat-settings-save',{on:'no'}),400);
 const cfg=(await get('public-chat',{cv:String(s.version)})).data;assert.equal(cfg.cv,s.version+1);assert.deepEqual([cfg.cfg.ms,cfg.cfg.notice],[[5000,10000,30000,60000,120000],'Przerwa o 18:00']);
 assert.equal(Number(fixture('chat-settings',{}).data.send.perMin),1000,'saving the panel keeps the server-side values');
 r=await admin.req('admin-chat-settings-save',{preset:'normal',notice:null});assert.deepEqual([r.data.preset,r.data.notice],['normal',null]);
});

test('the moderation panel reaches messages of a tournament set back to a draft; the chat routes still answer 404',{skip},async()=>{
 const t=fixture('tournament',{name:'Cofnięty do szkicu',date:'2031-09-01'}).id,ch=fixture('chat-channel',{tournamentId:t}),m=[];
 for(const text of ['Do odrzucenia','Do usunięcia','Do przywrócenia'])m.push((await send(C.m1,ch.id,text)).data.m);
 for(const x of m)assert.equal((await C.m2.req('chat-report',{id:x.id,reason:'spam'})).status,200);
 for(const who of [C.m3,C.m4])assert.equal((await who.req('chat-report',{id:m[2].id,reason:'abuse'})).status,200);
 assert.equal(fixture('chat-message',{id:m[2].id}).state,'hidden_review');
 assert.equal(fixture('chat-tournament-status',{tournamentId:t,status:'draft'}),1);
 for(const who of [admin,C.m1])error(await who.req('chat-delete',{id:m[1].id}),404,'Wiadomość nie istnieje.');// in the chat the draft does not exist for anybody
 error(await C.m3.req('chat-report',{id:m[0].id,reason:'spam'}),404,'Wiadomość nie istnieje.');
 const queue=(await get('admin-chat-reports',{},admin.cookie)).data.items.map(i=>i.message.id);assert.ok(m.every(x=>queue.includes(x.id)),'still in the open queue');
 assert.deepEqual((await admin.req('admin-chat-action',{action:'dismiss',messageId:m[0].id,note:'Bez zastrzeżeń'})).data,{ok:true});
 assert.deepEqual(fixture('chat-reports',{messageId:m[0].id}).map(x=>x.status),['dismissed']);
 assert.deepEqual((await admin.req('admin-chat-action',{action:'delete',messageId:m[1].id,note:'Spam'})).data,{ok:true});
 const del=fixture('chat-message',{id:m[1].id});assert.deepEqual([del.state,del.body],['deleted_mod','']);assert.deepEqual(fixture('chat-reports',{messageId:m[1].id}).map(x=>x.status),['actioned']);
 assert.deepEqual((await admin.req('admin-chat-action',{action:'restore',messageId:m[2].id})).data,{ok:true});assert.equal(fixture('chat-message',{id:m[2].id}).state,'visible');
 error(await admin.req('admin-chat-action',{action:'restore',messageId:m[0].id}),409,'Tej wiadomości nie można przywrócić.');
 error(await admin.req('admin-chat-action',{action:'dismiss',messageId:987654321}),404,'Wiadomość nie istnieje.');
 const open=(await get('admin-chat-reports',{},admin.cookie)).data.items.map(i=>i.message.id);assert.ok(!m.slice(0,2).some(x=>open.includes(x.id)),'dismissed and deleted leave the open queue');
 fixture('chat-tournament-status',{tournamentId:t,status:'open'});
 const back=(await get('chat-feed',{ch:`${ch.id}:0`},C.m2.cookie)).data.ch[ch.id].m;
 assert.deepEqual(back.map(x=>[x.id,x.b??x.x]),[[m[0].id,'Do odrzucenia'],[m[1].id,'mod'],[m[2].id,'Do przywrócenia']],'reopened: the deleted message stays deleted');
});

test('retention removes old messages, old copies, expired mutes, old reports and health rows; account deletion makes tombstones',{skip},async()=>{
 const t=Date.now(),before=Number(fixture('chat-channel',{slug:'karate'}).msg_count);
 const old=fixture('chat-messages',{channelId:karate.id,userId:U.m3.id,n:2,createdMs:t-366*DAY});
 // Two-digit counts: msg_count 13 − 3 must give 10 (GREATEST(msg_count,'3') compares as strings in MySQL 8.0 and gave 0).
 const rt=fixture('tournament',{name:'Retencja 2031',date:'2031-10-01'}).id,R=fixture('chat-channel',{tournamentId:rt}),count=()=>Number(fixture('chat-channel',{tournamentId:rt}).msg_count);
 fixture('chat-messages',{channelId:R.id,userId:U.m3.id,n:3,createdMs:t-367*DAY});fixture('chat-messages',{channelId:R.id,userId:U.m3.id,n:10});assert.equal(count(),13);
 const reported=(await send(C.m3,karate.id,'Stare zgłoszenie')).data.m;await C.m2.req('chat-report',{id:reported.id,reason:'other'});
 fixture('chat-report-age',{messageId:reported.id,resolvedAt:now()-181*86400});
 fixture('chat-log-age',{messageId:T.hidden,createdAt:now()-31*86400});
 fixture('chat-mute',{userId:U.m5.id,untilAt:now()-60});fixture('chat-mute',{userId:U.m3.id,untilAt:now()+600});
 const oldHour=Math.floor(now()/3600)*3600-15*86400;fixture('chat-health-add',{hourAt:oldHour,status:503,n:4});
 const result=fixture('chat-retention');assert.match(result,/^messages=5 originals=\d+ mutes=\d+ reports=\d+ health=\d+$/,result);
 assert.equal(count(),10,'three old messages out of thirteen');
 for(const x of old.messages)assert.equal(fixture('chat-message',{id:x.id}),null);
 assert.equal(Number(fixture('chat-channel',{slug:'karate'}).msg_count),before+1,'two old messages removed, the new one counted');
 assert.ok(fixture('chat-log',{messageId:T.hidden}).every(x=>x.original_body===null),'copies older than 30 days cleared');
 assert.deepEqual(fixture('chat-reports',{messageId:reported.id}),[],'resolved reports older than 180 days removed');
 assert.equal(fixture('chat-mute-row',{userId:U.m5.id}),null);assert.notEqual(fixture('chat-mute-row',{userId:U.m3.id}),null,'a running mute stays');
 assert.ok(!fixture('chat-health').some(x=>x.hour_at===oldHour));
 fixture('chat-mute',{userId:U.m3.id,remove:true});
 const g0=fixture('chat-channel',{slug:'general'}),k0=fixture('chat-channel',{slug:'karate'});
 const g=fixture('chat-messages',{channelId:general.id,userId:U.m5.id,n:2}),k=fixture('chat-messages',{channelId:karate.id,userId:U.m5.id,n:1});
 const h=fixture('chat-messages',{channelId:karate.id,userId:U.m5.id,n:1,state:'hidden_review',body:'ukryta'});
 const r5=fixture('chat-messages',{channelId:R.id,userId:U.m5.id,n:3});assert.equal(count(),13);
 assert.equal(fixture('chat-tombstone',{userId:U.m5.id}),7);assert.equal(fixture('chat-tombstone',{userId:U.m5.id}),0,'nothing left to change');
 const g1=fixture('chat-channel',{slug:'general'}),k1=fixture('chat-channel',{slug:'karate'});
 assert.deepEqual([Number(g1.msg_count)-Number(g0.msg_count),Number(k1.msg_count)-Number(k0.msg_count)],[0,0],'visible ones counted out again (hidden ones were not counted)');
 assert.equal(count(),10,'13 − 3 with two-digit counts');
 for(const x of [...g.messages,...k.messages,...h.messages,...r5.messages]){const row=fixture('chat-message',{id:x.id});assert.deepEqual([row.state,row.body],['deleted_author','']);assert.ok(Number(row.rev)>x.rev);}
 const feed=(await get('chat-feed',{ch:`${general.id}:${g.rev}`},C.m2.cookie)).data.ch[general.id].m;
 assert.deepEqual(feed.map(x=>[x.id,x.x,x.a]),g.messages.map(x=>[x.id,'author',U.m5.publicId]));
});
