// chat-backend units through tests/php-bridge-chat.php (plan §11): ChatGuestView (exact keys; g stable within one day and
// channel and different between days and channels: the documented, not hidden, grouping), the member projection,
// tournamentState/visibleFor (draft, open, grace day for signed-in people only, archive, Admin status), the message text
// (Text::clean, 1–1000 characters), cont, send limits, the polling parser (ch, h, cv, e, before), the 204/COUNT decision,
// settings normalisation, the hosting-health window (the last 60 minutes from hour buckets) and the migration seed
// (lobby and default settings equal to the code).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
const php=process.env.PHP_BIN;
function bridge(input){const r=spawnSync(php,['tests/php-bridge-chat.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const skip=!php;
const KEY='k'.repeat(64),DAY=86_400_000,T0=Date.UTC(2026,9,31,10,0,0);
const expectedG=(key,ms,channel,user)=>parseInt(createHmac('sha256',key).update(`chatghost|${new Date(ms).toISOString().slice(0,10)}|${channel}|${user}`).digest('hex').slice(0,8),16)%5;
const row=(f={})=>({id:7,rev:12,user_id:'u1',body:'Cześć <b>wszystkim</b>',cont:1,state:'visible',created_ms:T0,...f});

test('ChatGuestView: exactly {id,r,t,g,c,b} or the tombstone {id,r,t,g,x}; never the author or a hidden text',{skip},()=>{
 const k=bridge({job:'constants'});
 assert.deepEqual(k.fields,['id','r','t','g','c','b']);assert.deepEqual(k.tombstone,['id','r','t','g','x']);
 const states=['visible','deleted_author','deleted_mod','hidden_review'];
 const out=bridge({job:'guest',cases:states.map(state=>({row:row({state,body:state==='hidden_review'?'ukryta treść':state==='visible'?'Cześć':''}),channel:3,key:KEY}))});
 assert.deepEqual(Object.keys(out[0]),k.fields);assert.deepEqual(out[0],{id:7,r:12,t:T0,g:expectedG(KEY,T0,3,'u1'),c:1,b:'Cześć'});
 assert.deepEqual(out.slice(1).map(m=>[Object.keys(m),m.x]),[[k.tombstone,'author'],[k.tombstone,'mod'],[k.tombstone,'review']]);
 assert.ok(!JSON.stringify(out).includes('ukryta')&&!JSON.stringify(out).includes('u1'),'no hidden text and no user id');
});

test('g is the documented HMAC: the same for one person in one channel on one UTC day, different between days and channels',{skip},()=>{
 const users=Array.from({length:40},(_,i)=>'user-'+i);
 const cases=[];for(const user of users)for(const [ms,channel] of [[T0,3],[T0+3_600_000,3],[T0+DAY,3],[T0,4]])cases.push({key:KEY,ms,channel,user});
 const g=bridge({job:'variant',cases});
 cases.forEach((c,i)=>{assert.equal(g[i],expectedG(c.key,c.ms,c.channel,c.user));assert.ok(g[i]>=0&&g[i]<=4);});
 const per=users.map((_,u)=>g.slice(u*4,u*4+4));
 assert.ok(per.every(([a,b])=>a===b),'stable within one day and channel (grouping is possible there, as documented)');
 assert.ok(per.some(([a,,c])=>a!==c),'another day gives other variants');assert.ok(per.some(([a,,,d])=>a!==d),'another channel gives other variants');
 const other=bridge({job:'variant',cases:users.map(user=>({key:'x'.repeat(64),ms:T0,channel:3,user}))});
 assert.ok(other.some((v,i)=>v!==per[i][0]),'depends on app_key');
 assert.deepEqual(new Set(g).size,5,'five decoration variants');
});

test('member projection: a (public id), o (organiser), c and b, tombstones without text',{skip},()=>{
 const out=bridge({job:'member',cases:[{row:row(),pid:'Xk3P9aQ2LmZt',organizer:false},{row:row(),pid:'Xk3P9aQ2LmZt',organizer:true},{row:row({state:'deleted_mod',body:''}),pid:'Xk3P9aQ2LmZt',organizer:false},{row:row({state:'deleted_author',body:''}),pid:null,organizer:false}]});
 assert.deepEqual(out[0],{id:7,r:12,t:T0,a:'Xk3P9aQ2LmZt',c:1,b:'Cześć <b>wszystkim</b>'},'text stays plain text; the browser escapes it');
 assert.deepEqual(out[1],{id:7,r:12,t:T0,a:'Xk3P9aQ2LmZt',o:1,c:1,b:'Cześć <b>wszystkim</b>'});
 assert.deepEqual(out[2],{id:7,r:12,t:T0,a:'Xk3P9aQ2LmZt',x:'mod'});
 assert.deepEqual(out[3],{id:7,r:12,t:T0,x:'author'},'a deleted account has no a');
});

test('tournament chat lifecycle: draft hidden, open until the day, grace day only for signed-in people, then archive; Admin status',{skip},()=>{
 const today='2026-11-14',member={id:'m',full:false},t=(event_date,status='open')=>({event_date,status});
 const states=bridge({job:'state',cases:[
  [t('2026-11-20','draft'),member],[null,member],[t('2026-11-20'),null],[t('2026-11-14','finished'),null],[t('2026-11-13','closed'),null],[t('2026-11-13'),member],
  [t('2026-11-12'),member],[t('2026-11-12'),null],[t('2026-11-12'),member,2],[t('2026-11-13'),member,0]
 ].map(([tt,viewer,grace])=>({t:tt,today,viewer,grace}))});
 assert.deepEqual(states,['hidden','hidden','open','open','gone','open','archive','gone','open','archive']);
 const lobby=s=>({kind:'lobby',status:s}),tc=s=>({kind:'tournament',status:s});
 const visible=bridge({job:'visible',cases:[
  [lobby('open'),null,null],[lobby('readonly'),null,null],[lobby('closed'),null,member],
  [tc('open'),t('2026-11-20'),null],[tc('readonly'),t('2026-11-20'),null],[tc('closed'),t('2026-11-20'),null],[tc('closed'),t('2026-11-20'),member],
  [tc('open'),t('2026-11-13'),null],[tc('open'),t('2026-11-13'),member],[tc('open'),t('2026-11-01'),member],[tc('readonly'),t('2026-11-01'),member],
  [tc('open'),t('2026-11-20','draft'),{id:'a',full:true,role:'admin'}]
 ].map(([ch,tt,viewer])=>({ch,t:tt,viewer,today}))});
 assert.deepEqual(visible,['open','closed','closed','open','closed',null,'closed',null,'open','archive','closed',null]);
 assert.deepEqual(bridge({job:'shift',cases:[['2026-03-29',-1],['2026-10-25',-1],['2026-01-01',-1],['2026-12-31',1]]}),['2026-03-28','2026-10-24','2025-12-31','2027-01-01'],'DST days and year ends');
});

test('message text: Text::clean (bidi, zero-width, controls), 1–1000 characters, one 422 message for each rule',{skip},()=>{
 const out=bridge({job:'body',cases:[{b:'  Cześć  '},{b:''},{b:'   \n\t '},{b:null},{b:42},{b:'x'.repeat(1000)},{b:'x'.repeat(1001)},{b:'ż'.repeat(1000)},
  {hex:Buffer.from('a‮b​c﻿d⁦e‎f\u0007g','utf8').toString('hex')},{hex:Buffer.from('👩‍👩‍👧','utf8').toString('hex')},{b:'a\n\n\n\n\nb'},{b:Array.from({length:25},(_,i)=>'l'+i).join('\n')}]});
 assert.deepEqual(out.slice(0,8).map(r=>r.ok??[r.status,r.error]),['Cześć',[422,'Wiadomość jest pusta.'],[422,'Wiadomość jest pusta.'],[422,'Wiadomość jest pusta.'],[422,'Wiadomość jest pusta.'],'x'.repeat(1000),[422,'Wiadomość może mieć najwyżej 1000 znaków.'],'ż'.repeat(1000)]);
 assert.equal(out[8].ok,'abcdefg','direction, zero-width and control characters removed');assert.equal(out[9].ok,'👩‍👩‍👧','the emoji joiner stays');
 assert.equal(out[10].ok,'a\n\n\nb','at most two empty lines in a row');assert.equal(out[11].ok.split('\n').length,20,'at most 20 lines');
});

test('cont: previous message visible, same author, under 5 minutes',{skip},()=>{
 const prev=(f={})=>({user_id:'u',created_ms:1000,state:'visible',...f});
 assert.deepEqual(bridge({job:'cont',cases:[{prev:prev(),user:'u',now:300999},{prev:prev(),user:'u',now:301000},{prev:prev(),user:'v',now:2000},{prev:prev({state:'deleted_author'}),user:'u',now:2000},{prev:prev({state:'hidden_review'}),user:'u',now:2000},{prev:null,user:'u',now:2000}]}),[1,0,0,0,0,0]);
});

test('send limits: the gap, per minute and per day give the seconds to wait',{skip},()=>{
 const send={gap:2,perMin:20,perDay:300},N=1_800_000_000_000;
 const r=(f={})=>({day_n:0,day_first:null,last_ms:null,minute_n:0,minute_first:null,...f});
 assert.deepEqual(bridge({job:'wait',cases:[
  {r:r(),send,now:N},{r:r({day_n:1,day_first:N-500,last_ms:N-500,minute_n:1,minute_first:N-500}),send,now:N},{r:r({day_n:1,day_first:N-2000,last_ms:N-2000,minute_n:1,minute_first:N-2000}),send,now:N},
  {r:r({day_n:20,day_first:N-50000,last_ms:N-10000,minute_n:20,minute_first:N-50000}),send,now:N},{r:r({day_n:300,day_first:N-86_000_000,last_ms:N-61000,minute_n:0}),send,now:N},
  {r:r({day_n:1,day_first:N-100,last_ms:N-100,minute_n:1,minute_first:N-100}),send:{gap:0,perMin:20,perDay:300},now:N}
 ]}),[0,2,0,10,400,0]);
});

test('polling query: strict parser of ch (≤ 6), h (≤ 30), cv, e (1–50 of 0/429/503/508) and before (history of one channel)',{skip},()=>{
 const ok=[{},{ch:'12:4511,13:0',cv:'7'},{h:'1:5:9,2:0:0'},{e:'3:429'},{e:'50:0'},{ch:'12:0',before:'99'},{ch:Array.from({length:6},(_,i)=>`${i+1}:0`).join(',')},{h:Array.from({length:30},(_,i)=>`${i+1}:0:0`).join(',')},{route:'public-chat',_:'x'}];
 const bad=[{ch:'12'},{ch:'12:x'},{ch:'0:1'},{ch:'1:1,1:2'},{ch:Array.from({length:7},(_,i)=>`${i+1}:0`).join(',')},{ch:'1:1,'},{ch:'-1:0'},{h:'1:2'},{h:'1:1:1,1:2:2'},{h:Array.from({length:31},(_,i)=>`${i+1}:0:0`).join(',')},
  {cv:'x'},{cv:'-1'},{e:'0:429'},{e:'51:429'},{e:'3:404'},{e:'3'},{before:'9'},{ch:'1:5',before:'9'},{ch:'1:0,2:0',before:'9'},{ch:'1:0',before:'0'},{ch:['1:0']},{cv:{a:1}},{ch:'1:0 '},{ch:'1:99999999999999999999'}];
 const out=bridge({job:'parse',cases:[...ok,...bad]});
 out.slice(0,ok.length).forEach((r,i)=>assert.ok('ok' in r,JSON.stringify(ok[i])+' '+JSON.stringify(r)));
 assert.deepEqual(out[1].ok,{ch:{12:4511,13:0},h:[],cv:7,e:null,before:null});assert.deepEqual(out[2].ok.h,{1:[5,9],2:[0,0]});assert.deepEqual(out[3].ok.e,[3,429]);assert.equal(out[5].ok.before,99);
 out.slice(ok.length).forEach((r,i)=>assert.deepEqual([r.status,r.error],[400,'Niepoprawne zapytanie czatu.'],JSON.stringify(bad[i])));
});

test('poll decision: 204 only when nothing changed (also h); COUNT only for channels whose last message changed',{skip},()=>{
 const channels={1:{rev:10,last_message_id:100},2:{rev:5,last_message_id:50},3:{rev:0,last_message_id:0},4:{rev:7,last_message_id:70}};
 const open={1:'open',2:'open',3:'open'};// 4 exists but is not visible to this viewer
 const d=(q,stale=false,state=open)=>bridge({job:'decide',cases:[{q,channels,state,stale}]})[0];
 assert.deepEqual(d({ch:'1:10',h:'2:40:50',cv:'1'}),{ch:{1:'same'},heads:{2:'same'},none:true},'204 with ch and h');
 assert.deepEqual(d({ch:'1:10',h:'2:40:50'},true).none,false,'stale settings');
 assert.deepEqual(d({ch:'1:10',h:'2:40:49'}),{ch:{1:'same'},heads:{2:'count'},none:false},'knownLast changed: the only COUNT');
 assert.deepEqual(d({ch:'1:9',h:'2:40:50'}),{ch:{1:'since'},heads:{2:'same'},none:false},'ch changed: no COUNT for an unchanged head');
 assert.deepEqual(d({ch:'1:11'}),{ch:{1:'ahead'},heads:[],none:false},'cursor beyond the channel: reload');
 assert.deepEqual(d({ch:'1:0'}).ch,{1:'initial'});assert.deepEqual(d({ch:'3:0'}),{ch:{3:'initial'},heads:[],none:true},'an empty channel loaded from 0 is unchanged (204)');
 assert.deepEqual(d({ch:'3:0,1:9'}).ch,{3:'initial',1:'since'},'… but loaded when anything else is answered');
 assert.deepEqual(d({ch:'4:7,9:0',h:'4:0:70'}),{ch:{4:'gone',9:'gone'},heads:{4:'gone'},none:false},'hidden and missing channels are gone');
 assert.deepEqual(d({ch:'1:0',before:'50'}),{ch:{1:'history'},heads:[],none:false},'history is always answered');
});

test('settings: invalid stored values fall back to the defaults; client fields; presets',{skip},()=>{
 const k=bridge({job:'constants'});
 assert.deepEqual(k.client,['on','t','ms','idle','bg','boost','safety','notice']);
 assert.deepEqual(bridge({job:'client'}),Object.fromEntries(k.client.map(f=>[f,k.defaults[f]])));
 const [empty,bad,good]=bridge({job:'normalize',cases:[null,{on:'yes',t:'ws',ms:[1,2,3,4,5],idle:[600,60,180,1800],bg:5,boost:-1,notice:42,send:{gap:-1,perMin:'x'},autoHide:0,graceDays:99,retentionDays:0},
  {on:false,ms:[5000,10000,30000,60000,120000],notice:'  Przerwa‮ techniczna  ',send:{gap:0},autoHide:5,graceDays:2,extra:1}]});
 assert.deepEqual(empty,k.defaults);assert.deepEqual(bad,k.defaults);
 assert.deepEqual(good,{...k.defaults,on:false,ms:[5000,10000,30000,60000,120000],notice:'Przerwa techniczna',send:{...k.defaults.send,gap:0},autoHide:5,graceDays:2});
 assert.deepEqual(bridge({job:'preset',cases:[k.presets.normal,k.presets.saver,k.presets.emergency,[1000,2000,3000,4000,5000]]}),['normal','saver','emergency','custom']);
 assert.deepEqual(k.presets,{normal:[2500,5000,10000,30000,60000],saver:[5000,10000,30000,60000,120000],emergency:[15000,30000,60000,120000,300000]});
});

test('hosting health: the current hour in full plus the overlapping part of the previous one, never two whole hours',{skip},()=>{
 const H=1_800_000_000,rows=[{hour_at:H-7200,status:429,n:1000},{hour_at:H-3600,status:429,n:100},{hour_at:H,status:429,n:10},{hour_at:String(H-3600),status:'0',n:'36'},{hour_at:H,status:404,n:7}];
 const out=bridge({job:'window',cases:[H,H+900,H+1800,H+3599,H+3600,H+7200].map(now=>({rows,now}))});
 assert.deepEqual(out[0],{429:110,503:0,508:0,0:36},'at the top of the hour the previous hour is the whole window');
 assert.deepEqual(out.map(o=>o[429]),[110,85,60,10,10,0],'10:15 counts three quarters of the 9:00 bucket; two hours back never count');
 assert.deepEqual(out.map(o=>o[0]),[36,27,18,0,0,0],'rows as strings from the database; statuses outside the list ignored');
});

test('migration 0003 seeds the four channels of Chat::LOBBY in order and the default settings of ChatSettings',{skip},()=>{
 const k=bridge({job:'constants'}),src=readFileSync('backend/migrations/0003_chat.php','utf8');
 const seeded=[...src.match(/\$lobby=\[(.*?)\];/)[1].matchAll(/\['([a-z-]+)','(world|pl)',(\d+)\]/g)].map(m=>[m[1],m[2],Number(m[3])]);
 assert.deepEqual(seeded,Object.entries(k.lobby).map(([slug,l])=>[slug,l.scope,l.sort]));
 assert.deepEqual(Object.keys(k.lobby),['taekwondo','taekwondo-pl','karate','general']);
 const json=[...src.match(/\$defaults=('.*?');/s)[1].matchAll(/'([^']*)'/g)].map(m=>m[1]).join('');
 assert.deepEqual(JSON.parse(json),k.defaults);
});

test('moderation texts: comments keep lines, notes and reasons one line; at most 300 characters',{skip},()=>{
 const out=bridge({job:'text',cases:[{s:null,kind:'note'},{s:'  ',kind:'note'},{s:'a\nb',kind:'comment'},{s:'a\nb',kind:'note'},{s:'x'.repeat(300),kind:'reason'},{s:'x'.repeat(301),kind:'reason'},{s:'x'.repeat(301),kind:'comment'},{s:'x'.repeat(301),kind:'note'},{s:5,kind:'note'}]});
 assert.deepEqual(out.map(r=>'ok' in r?r.ok:[r.status,r.error]),[null,null,'a\nb','ab','x'.repeat(300),[422,'Powód może mieć najwyżej 300 znaków.'],[422,'Komentarz może mieć najwyżej 300 znaków.'],[422,'Notatka może mieć najwyżej 300 znaków.'],[400,'Niepoprawny formularz.']]);
});

test('public keys: 16 base62 characters, all different',{skip},()=>{
 const keys=bridge({job:'public-keys',n:200});assert.ok(keys.every(k=>/^[0-9A-Za-z]{16}$/.test(k)));assert.equal(new Set(keys).size,200);
});
