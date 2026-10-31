// Profile rules shared by PHP and JavaScript (plan §7.1–7.5, §5.5, §11): country codes, sports and reserved names are the
// same lists on both sides; usernames, names, suggestions and cleanText/Text::clean give the same answers for shared
// cases (tests/php-bridge-community.php runs the PHP side). Also: Profiles::validate messages, the own projection,
// Capabilities::bytes and the avatar pipeline on the images of tests/fixtures/avatars (formats, dimensions, memory,
// EXIF orientation and metadata removal, appended data).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {COUNTRIES,SPORTS,SPORT_COLORS,RESERVED,RESERVED_PREFIXES,validateUsername,normalizeUsername,validateName,slugName,suggestUsernames,cleanText} from '../dist/profile-data.js';
const php=process.env.PHP_BIN;const skip=!php;
function bridge(input,ini=[]){const r=spawnSync(php,[...ini.flatMap(v=>['-d',v]),'tests/php-bridge-community.php'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:50_000_000});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const POLISH_LETTERS=/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const fixture=name=>readFileSync(new URL('./fixtures/avatars/'+name,import.meta.url));

test('countries: 249 ISO codes plus XK, identical in PHP and JS, names in both languages',{skip},()=>{
 const data=bridge({job:'data'}),codes=COUNTRIES.map(c=>c[0]);
 assert.equal(COUNTRIES.length,250);assert.deepEqual(codes,data.countries);
 assert.deepEqual(codes,[...codes].sort(),'sorted by code');assert.equal(new Set(codes).size,250);
 for(const code of ['PL','XK','DE','US','UA','GB'])assert.ok(codes.includes(code),code);
 for(const [code,pl,en] of COUNTRIES){
  assert.match(code,/^[A-Z]{2}$/);assert.ok(pl&&en&&pl!==code&&en!==code,code);
  assert.ok(!POLISH_LETTERS.test(en),'Polish letters in English name: '+en);assert.ok(!/[‘’]/.test(pl+en),'plain apostrophes: '+code);
 }
 assert.deepEqual(COUNTRIES.find(c=>c[0]==='PL'),['PL','Polska','Poland']);
 assert.ok(COUNTRIES.some(([,,en])=>/[ÅéôçÉ]/.test(en)),'accented English names such as Åland Islands are kept');
});
test('sports and reserved names are the same lists in PHP and JS',{skip},()=>{
 const data=bridge({job:'data'});
 assert.deepEqual(SPORTS.map(s=>s[0]),data.sports);
 assert.deepEqual(SPORTS.map(s=>s[0]),['taekwondo','karate','judo','kickboxing','bjj','jujitsu','boxing','mma','wrestling','muaythai','other']);
 assert.deepEqual(RESERVED,data.reserved);assert.deepEqual(RESERVED_PREFIXES,data.prefixes);
 assert.deepEqual(SPORT_COLORS.taekwondo,['#00679d','#e8f6fc']);assert.deepEqual(SPORT_COLORS.karate,['#6b4aa0','#f2edfb']);assert.deepEqual(SPORT_COLORS.DEFAULT,['#4d6480','#edf2f7']);
});

const USERNAMES=[
 ['marta.k','valid'],['Marta.K','valid'],['  marta_k  ','valid'],['abc','valid'],['ab','invalid'],['a'.repeat(24),'valid'],['a'.repeat(25),'invalid'],
 ['1marta','invalid'],['_marta','invalid'],['.marta','invalid'],['mar..ta','invalid'],['mar._ta','invalid'],['mar_.ta','invalid'],['marta.','invalid'],['marta_','valid'],
 ['mar__ta','valid'],['m4rta.k2','valid'],['mar-ta','invalid'],['mar ta','invalid'],['żaneta','invalid'],['martaK','invalid'],['','invalid'],[null,'invalid'],[123,'invalid'],
 ['admin','reserved'],['Admin','reserved'],['administrator','reserved'],['admin2','reserved'],['adminek','reserved'],['matbravo','reserved'],['matbravo_pl','reserved'],
 ['mod','reserved'],['modest','valid'],['moderator','reserved'],['root','reserved'],['sedzia','reserved'],['undefined','reserved'],['info','reserved'],['infoline','valid'],['staff','reserved'],['matdraw','reserved'],['matdraw2','valid']
];
test('usernames: shared cases give the same status in PHP and JS (§7.2)',{skip},()=>{
 const out=bridge({job:'username',cases:USERNAMES.map(([s])=>({s}))});
 USERNAMES.forEach(([s,expected],i)=>{assert.equal(validateUsername(s),expected,'JS '+JSON.stringify(s));assert.equal(out[i],expected,'PHP '+JSON.stringify(s));});
 assert.equal(normalizeUsername(' Marta.K '),'marta.k');assert.equal(normalizeUsername(5),null);
});
const NAMES=['Marta','Anna-Maria',"O'Connor",'J. R.','José',' Ewa ','Łukasz','Zoë','Ünal','李','Ольга','a'.repeat(50),'a'.repeat(51),'','  ','-',"'.",'Marta1','Marta\tK','Ma‮rta',' Ewa','Ewa\n','Ma rta',null,7];
test('first and last names: the same rule in PHP and JS (§7.1)',{skip},()=>{
 const out=bridge({job:'names',cases:NAMES.map(s=>({s}))});
 NAMES.forEach((s,i)=>assert.equal(validateName(s),out[i],JSON.stringify(s)));
 assert.equal(validateName('José'),'José','NFC');assert.equal(validateName(' Ewa '),'Ewa');assert.equal(validateName('a'.repeat(51)),null);assert.equal(validateName('-'),null);
 assert.equal(validateName('\uD800abc'),null,'ill-formed text');
});
const PEOPLE=[['Marta','Kowalska','marta.k'],['Łukasz','Żółć',''],['ŁUKASZ','ŚWIĄTEK','lukasz'],['Zoë','Saldaña','zoe'],['Anna Maria','Nowak-Kowalska','annamaria'],['A','B','ab'],['Ab','',''],
 ['Bartłomiej','Wiśniewski-Chrzanowska-Grzębowska',''],['Maximiliana','Konstantynopolitańczykowianeczka','maximiliana.konstantynopo'],['123','Nowak',''],['Admin','Nowak',''],['Matbravo','X',''],['李','王',''],['Ольга','Петрова',''],
 ['Émile','Zola','émile'],['Jean-Luc',"D'Arc",'jean.luc'],['Marta','Kowalska','admin'],['Marta','Kowalska','marta.kowalska'],[null,'Kowalska',''],['Ewa','',null]];
test('username suggestions and transliteration are identical in PHP and JS (§7.2)',{skip},()=>{
 const out=bridge({job:'candidates',cases:PEOPLE});
 PEOPLE.forEach(([f,l,r],i)=>assert.deepEqual(suggestUsernames(f,l,r??''),out[i],JSON.stringify([f,l,r])));
 assert.deepEqual(suggestUsernames('Marta','Kowalska','marta.k').slice(0,3),['marta.kowalska','marta_kowalska','marta.k2']);
 assert.deepEqual(suggestUsernames('Łukasz','Żółć').slice(0,2),['lukasz.zolc','lukasz_zolc'],'ł→l, ż→z, ó→o, ć→c');
 for(const list of out)for(const c of list){assert.equal(validateUsername(c),'valid',c);assert.ok(c.length<=24,c);}
 assert.ok(!suggestUsernames('Marta','Kowalska','marta.kowalska').includes('marta.kowalska'),'the requested name is never suggested');
 // Initial only (the server's suggestions unless the full name is shown; the allow-list of shownSuggestions in dist/account-flow.js).
 const initial=bridge({job:'candidates',cases:PEOPLE,full:false});
 PEOPLE.forEach(([f,l,r],i)=>{
  assert.deepEqual(suggestUsernames(f,l,r??'',{full:false}),initial[i],JSON.stringify([f,l,r,'initial']));
  // Past the first name, at most the surname's initial (the requested name + 2 is the person's own choice).
  const sf=slugName(f??''),sl=slugName(l??''),req=normalizeUsername(r??'')??'';
  if(sl.length>1)for(const c of initial[i])if(!req||!c.startsWith(req.slice(0,22)))assert.ok(!(c.startsWith(sf)?c.slice(sf.length):c).includes(sl.slice(0,2)),c+' contains no cut of the surname');
 });
 assert.deepEqual(initial[0],['marta_k','marta.k2','martak','marta.k3','marta_k2'],'Marta Kowalska, requested marta.k');
 const slugs=['Łódź','ŻÓŁW','Ærøskøbing','Saldaña','Jean-Luc',"O'Neil",'Øystein','Straße'];const php=bridge({job:'slug',cases:slugs.map(s=>({s}))});
 slugs.forEach((s,i)=>assert.equal(slugName(s),php[i],s));assert.equal(slugName('Łódź'),'lodz');
});
const CLEAN=[
 {s:'abc'},{s:'a‮b'},{s:'⁦x⁩'},{s:'​zero'},{s:'﻿bom'},{s:'‎ltr‏'},{s:'؜arabic'},{s:'👨‍👩‍👧'},{s:'   trim　 '},{s:'a\tb'},{s:'\u0007bell'},
 {s:'a\nb'},{s:'a\r\nb\rc',multiline:true},{s:'a\n\n\n\n\nb',multiline:true},{s:'  line  \n   \n x  ',multiline:true},{s:Array.from({length:25},(_,i)=>'l'+i).join('\n'),multiline:true},
 {s:Array.from({length:22},(_,i)=>i>18?'  ':'l'+i).join('\n')+'\nlast',multiline:true},{s:'é'},{s:'\u0085nel'},{s:'a b'},{s:' '},{s:'x⁠y‌z'},{s:'\t\n\r'},{s:'\t\n\r',multiline:true},{s:5},{s:null}
];
test('cleanText mirrors Text::clean: format and control characters, NFC, lines (§5.5)',{skip},()=>{
 const out=bridge({job:'clean',cases:CLEAN});
 CLEAN.forEach((c,i)=>assert.equal(cleanText(c.s,{multiline:!!c.multiline}),out[i],JSON.stringify(c)));
 assert.equal(cleanText('a‮b'),'ab','RLO removed');assert.equal(cleanText('⁦x⁩'),'x','LRI/PDI removed');assert.equal(cleanText('​zero'),'zero');
 assert.equal(cleanText('﻿bom'),'bom');assert.equal(cleanText('‎ltr‏'),'ltr');assert.equal(cleanText('👨‍👩‍👧'),'👨‍👩‍👧','ZWJ kept in emoji');
 assert.equal(cleanText('a\n\n\n\n\nb',{multiline:true}),'a\n\n\nb');assert.equal(cleanText(Array.from({length:25},(_,i)=>'l'+i).join('\n'),{multiline:true}).split('\n').length,20);
 assert.equal(cleanText('\uD800x'),null,'ill-formed (JS) like invalid UTF-8 (PHP)');assert.deepEqual(bridge({job:'clean',cases:[{hex:'61ff62'}]}),[null]);
});

test('Profiles::validate: complete and partial profiles, one message per field',{skip},()=>{
 const ok={firstName:' Marta ',lastName:'Kowalska',username:'Marta.K',country:'PL',sports:['karate','taekwondo','karate'],clubText:' KS ‮Tygrys ',showClub:true};
 const cases=[
  {in:ok},{in:{...ok,nameDisplay:'full',showClub:'yes'}},{in:{...ok,nameDisplay:'bogus',clubText:''}},
  {in:{...ok,username:undefined}},{in:{...ok,username:'admin7'}},{in:{...ok,username:'a b'}},{in:{...ok,country:'pl'}},{in:{...ok,country:'EU'}},
  {in:{...ok,sports:[]}},{in:{...ok,sports:'karate'}},{in:{...ok,sports:['karate','x']}},{in:{...ok,sports:['taekwondo','karate','judo','kickboxing','bjj','mma']}},
  {in:{...ok,firstName:'M4rta'}},{in:{...ok,lastName:''}},{in:{...ok,clubText:'x'.repeat(101)}},{in:{...ok,clubText:7}},
  {in:{username:null,clubText:'  '},partial:true},{in:{lastName:'Nowak'},partial:true},{in:{username:'mod'},partial:true}
 ];
 const out=bridge({job:'validate',cases:cases.map(c=>({in:Object.fromEntries(Object.entries(c.in).filter(([,v])=>v!==undefined)),partial:c.partial}))});
 assert.deepEqual(out[0].ok,{first_name:'Marta',last_name:'Kowalska',username:'marta.k',country:'PL',sports:'karate,taekwondo',club_text:'KS Tygrys',show_club:1,name_display:'initial'});
 assert.equal(out[1].ok.name_display,'full');assert.equal(out[1].ok.show_club,0,'only true shows the club');
 assert.equal(out[2].ok.name_display,'initial');assert.equal(out[2].ok.club_text,null);
 const errors=out.slice(3,16).map(r=>r.error);
 assert.deepEqual(errors,['Sprawdź pole: nazwa użytkownika.','Tej nazwy nie można użyć.','Sprawdź pole: nazwa użytkownika.','Wybierz kraj z listy.','Wybierz kraj z listy.',
  'Wybierz co najmniej jeden sport.','Wybierz co najmniej jeden sport.','Wybierz sport z listy.','Wybierz najwyżej 5 sportów.','Sprawdź pole: imię.','Sprawdź pole: nazwisko.','Sprawdź pole: klub lub szkoła.','Sprawdź pole: klub lub szkoła.']);
 assert.ok(out.slice(3,16).every(r=>r.status===422));
 assert.deepEqual(out[16].ok,{username:null,club_text:null});assert.deepEqual(out[17].ok,{last_name:'Nowak'});assert.equal(out[18].error,'Tej nazwy nie można użyć.');
});
test('Profiles::own has the me.profile shape (§4.3)',{skip},()=>{
 const now=1_800_000_000;const row={public_id:'Xk3P9aQ2LmZt',username:'marta.k',first_name:'Marta',last_name:'Kowalska',country:'PL',sports:'taekwondo,karate',club_text:'KS',show_club:1,name_display:'initial',
  avatar:'9f2c41ab07de0123456789abcdef0123.webp',username_changed_at:now-86400,pw_reset_at:null};
 const p=bridge({job:'own',row,now});
 assert.deepEqual(Object.keys(p),['publicId','username','firstName','lastName','country','sports','clubText','showClub','nameDisplay','avatar','complete','usernameChangeAt','mustChangePassword']);
 assert.deepEqual([p.sports,p.avatar,p.complete,p.usernameChangeAt,p.mustChangePassword,p.showClub],[['taekwondo','karate'],'9f2c41ab07de',true,now+29*86400,false,true]);
 const q=bridge({job:'own',row:{...row,username:null,username_changed_at:now-31*86400,pw_reset_at:now,avatar:null},now});
 assert.deepEqual([q.complete,q.usernameChangeAt,q.mustChangePassword,q.avatar],[false,null,true,null]);
});

test('avatar pipeline: every EXIF orientation 1–8 (mirrored ones too), also with allow_url_fopen=0',{skip},t=>{
 if(bridge({job:'mode'}).mode==='off'){t.skip('GD cannot write avatars');return;}
 // Quadrants of the stored image: R G / B W. The displayed image per EXIF orientation (TL, TR, BL, BR):
 const want={1:'RGBW',2:'GRWB',3:'WBGR',4:'BWRG',5:'RBGW',6:'BRWG',7:'WGBR',8:'GWRB'};
 for(const ini of [[],['allow_url_fopen=0']]){
  const r=bridge({job:'orient'},ini);if(!r.exif){t.skip('no ext-exif');return;}
  assert.equal(r.allowUrlFopen,!ini.length);
  for(const o of Object.keys(want))assert.equal(r[o].join(''),want[o],`orientation ${o} ${ini.join(' ')}`);
 }
});
test('Capabilities: memory_limit parsing and the avatar mode of this PHP build',{skip},()=>{
 assert.deepEqual(bridge({job:'bytes',values:['128M','1G','2g','512K','1048576','-1','',' 64MB ','abc','-5']}),[134217728,1073741824,2147483648,524288,1048576,-1,-1,67108864,-1,-1]);
 const m=bridge({job:'mode'});assert.ok(['gd-webp','gd-jpeg','off'].includes(m.mode));
 if(m.gd.webp)assert.equal(m.mode,'gd-webp');
});
test('avatar pipeline: formats by content, dimensions, memory, EXIF orientation and metadata, appended data',{skip},t=>{
 if(bridge({job:'mode'}).mode!=='gd-webp'){t.skip('GD without WebP');return;}
 const names=['photo.webp','photo.jpg','photo.png','exif-gps.jpg','trailing.jpg','polyglot.jpg','vector.svg','anim.gif','tiny.png','wide.png'];
 const big=Buffer.concat([fixture('photo.png'),Buffer.alloc(600*1024)]);
 const out=bridge({job:'avatar',files:[...names.map(n=>fixture(n).toString('base64')),big.toString('base64')]});
 for(let i=0;i<5;i++){
  const r=out[i];assert.ok(r.ok,names[i]+': '+JSON.stringify(r));assert.equal(r.ok.ext,'webp');
  for(const s of [256,64]){assert.equal(r.ok.sizes[s].w,s);assert.equal(r.ok.sizes[s].h,s);assert.equal(r.ok.sizes[s].mime,'image/webp');}
 }
 const exif=out[3].ok.sizes[256],bytes=Buffer.from(exif.b64,'base64').toString('latin1');
 assert.ok(!/Exif|MatBravoSecretExifMarker|GPS/.test(bytes),'EXIF and GPS removed by re-encoding');
 const red=([r,g,b])=>r>150&&g<90&&b<90,blue=([r,g,b])=>b>150&&r<90&&g<90;
 assert.ok(red(exif.top)&&blue(exif.bottom),'Orientation 6 applied: left half (red) is on top '+JSON.stringify(exif));
 assert.ok(!Buffer.from(out[4].ok.sizes[256].b64,'base64').toString('latin1').includes('MatBravoTrailingPayload'),'appended data removed');
 assert.ok(red(bridge({job:'avatar',files:[fixture('exif-gps.jpg').toString('base64')]})[0].ok.sizes[64].top));
 const errors=out.slice(5).map(r=>[r.status,r.error]);
 assert.deepEqual(errors,[[415,'To nie jest obraz JPG, PNG ani WebP.'],[415,'To nie jest obraz JPG, PNG ani WebP.'],[415,'To nie jest obraz JPG, PNG ani WebP.'],[422,'Zdjęcie ma niepoprawne wymiary.'],[422,'Zdjęcie ma niepoprawne wymiary.'],[413,'Plik jest za duży.']]);
 // w·h·5 above half of memory_limit is refused; -1 means only the pixel limit applies.
 const large={gen:[2048,2000]};
 assert.deepEqual(bridge({job:'avatar',memory:'32M',files:[large,{gen:[1000,1000]}]}).map(r=>r.status??'ok'),[422,'ok'],'2048×2000×5 B > 16 MB, 1000×1000×5 B < 16 MB');
 assert.ok(bridge({job:'avatar',memory:'-1',files:[large]})[0].ok,'no memory limit: only the pixel limit');
 assert.equal(bridge({job:'avatar',files:[{gen:[2048,2051]}]})[0].status,422,'more than 4.2 million pixels');
 const jpg=fixture('photo.jpg').toString('base64');
 assert.deepEqual(bridge({job:'avatar',config:{avatars_enabled:false},files:[jpg]})[0],{error:'Zdjęcia profilowe są chwilowo wyłączone.',status:503});
});
