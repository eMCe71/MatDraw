// Browser regressions of the integration QA of PLAN-REJESTRACJA-ROLE (wave 4) on the PHP build with the Stripe stub, in Chromium:
//  - an organizer's own tournament is managed in the browser (the bootstrap user carries only caps): "Kopiuj link do zapisów",
//    the count of own tournaments and the first-run step "Utwórz turniej" done;
//  - the guest access card (F2): the athlete offer with its sign-up target only when the guest view says selfEntry:true, the
//    sign-up offer otherwise (the field is sparse: absent means no offer);
//  - landing after an athlete's sign-up from the offer (F6): #guest?t=…&enter=1 opens the entry window and the entry is sent;
//  - the keyboard focus after a save in the Administrator's panels: Ustawienia (the form's submit button), Członkowie (the same
//    row's opposite action), Kluby (the same action of the same club, or the selected filter, also after adopting a pending
//    club name) instead of <body>;
//  - no console error, CSP violation or horizontal scroll at 390 px and on desktop, PL and EN.
// Run: MATDRAW_BROWSER_TESTS=1 scripts/test-http.sh <port> <db> tests/qa-roles-browser.test.mjs (skipped otherwise).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

let chromium=null;if(process.env.MATDRAW_BROWSER_TESTS==='1')try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}
const API=process.env.MATDRAW_TEST_URL,ADMIN=['admin@test.example','AdminForTests2026!'],PASSWORD='Zielony-Rower-2026';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const letters=n=>Array.from({length:n},()=>'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random()*26)]).join('');
const route=r=>new URL(r.url()).searchParams.get('route');

test('PHP build in a browser: organizer tools, guest offer (F2), entry window after the sign-up (F6), focus after admin saves',{skip:(!chromium||!API)&&'MATDRAW_BROWSER_TESTS=1 under scripts/test-http.sh needed',timeout:420000},async()=>{
 const {fixture}=await import('./helpers/http-client.mjs');
 fixture('reset-limits');
 const app=API.replace(/api\/index\.php$/,''),browser=await chromium.launch(),problems=[],settingsBefore=fixture('settings-row');
 const open=async({width=1440,height=900,lang='pl'}={})=>{
  const ctx=await browser.newContext({viewport:{width,height},locale:lang==='pl'?'pl-PL':'en-GB',serviceWorkers:'block'});
  await ctx.addInitScript(l=>{try{localStorage.setItem('matdraw.language',l);}catch{}window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));},lang);
  const page=await ctx.newPage();
  page.on('pageerror',e=>problems.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error'&&!/status of 4\d\d/.test(m.text()))problems.push('console: '+m.text().slice(0,200));});
  return {ctx,page};
 };
 const noOverflow=async(page,what)=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0,'horizontal overflow: '+what);
 const noCsp=async page=>assert.deepEqual(await page.evaluate(()=>window.__csp),[]);
 const login=async(page,email,password)=>{fixture('reset-limits');await page.goto(app);await page.fill('#login-form input[name="email"]',email);await page.fill('#login-form input[name="password"]',password);await page.click('#login-form button[type="submit"]');await page.waitForSelector('.app-shell',{timeout:20000});};
 const focused=page=>page.evaluate(()=>{const a=document.activeElement;return {tag:a?.tagName,form:a?.closest('form')?.dataset.setForm||null,mem:a?.dataset.memAct||null,row:a?.parentElement?.closest('[data-mem-id]')?.dataset.memId||null,clb:a?.dataset.clbAct||null,clbId:a?.dataset.clbId||null,filter:a?.dataset.clbFilter||null};});
 /** Sign-up through the three or four steps; athlete: {club:'none'|'new'} adds the athlete step ("Siebie", an adult). */
 const signup=async(page,{hash='#signup',organizer=false,athlete=null}={})=>{
  await page.goto(app+hash);await page.waitForSelector('#acct-signup-1');
  if(organizer)await page.check('#acct-signup-1 [name="role-organizer"]');
  if(athlete&&!await page.isChecked('#acct-signup-1 [name="role-athlete"]'))await page.check('#acct-signup-1 [name="role-athlete"]');
  const email='e2e.qa.'+letters(8)+'@example.test',begun=Date.now();
  await page.fill('#acct-signup-1 [name="email"]',email);await page.fill('#acct-signup-1 [name="password"]',PASSWORD);
  await page.click('#acct-signup-1 button[type="submit"]');await page.waitForSelector('#acct-signup-2');
  await page.fill('#acct-signup-2 [name="firstName"]','Qa'+letters(5));await page.fill('#acct-signup-2 [name="lastName"]','Test'+letters(5));
  await page.waitForSelector('#acct-signup-2 .acct-st.ok');await page.click('[data-sport="taekwondo"]');
  await page.waitForTimeout(Math.max(0,3500-(Date.now()-begun)));
  await page.click('#acct-signup-2 button[type="submit"]');
  if(athlete){
   await page.waitForSelector('#acct-signup-3');
   await page.check('#acct-signup-3 input[name="relation"][value="self"]');await page.fill('#acct-signup-3 [name="birthDate"]','1993-03-03');
   await page.selectOption('#acct-signup-3 [name="sex"]','M');await page.fill('#acct-signup-3 [name="weight"]','72');await page.fill('#acct-signup-3 [name="height"]','180');
   await page.selectOption('#acct-signup-3 [name="grade"]','3');
   if(athlete.club==='new'){await page.check('#acct-signup-3 input[name="athleteClubMode"][value="new"]');await page.fill('#acct-signup-3 [name="athleteClubName"]',athlete.clubName);}
   else await page.check('#acct-signup-3 input[name="athleteClubMode"][value="none"]');
   await page.click('#acct-signup-3 button[type="submit"]');
  }
  return email;
 };
 try{
  // 1. Ustawienia: open sign-up for free; after every save the focus is back on the submit button of the form it came from.
  { const {ctx,page}=await open({width:1024,height:800,lang:'pl'});await login(page,...ADMIN);
    await page.goto(app+'#settings');await page.waitForSelector('[data-set-form="mode"]',{timeout:20000});
    // A mode change that stops payments asks first (the dialog's button saves); either way the focus ends on the mode form's button.
    const saveMode=async(mode,keyboard)=>{
     await page.check(`[data-set-form="mode"] input[value="${mode}"]`);const saved=page.waitForResponse(r=>route(r)==='admin-settings-save');
     if(keyboard){await page.focus('[data-set-form="mode"] button[type="submit"]');await page.keyboard.press('Enter');}else await page.click('[data-set-form="mode"] button[type="submit"]');
     const confirm=page.locator('#modal-root [data-set-act="confirm-go"]');
     await Promise.race([saved,confirm.waitFor({timeout:5000}).then(()=>confirm.click()).catch(()=>{})]);
     assert.equal((await saved).status(),200);await page.waitForFunction(()=>!document.querySelector('#modal-root .modal'));await sleep(300);
     assert.deepEqual([(await focused(page)).tag,(await focused(page)).form],['BUTTON','mode'],'focus after saving the mode '+mode);
    };
    await saveMode('off',true);await saveMode('free',false);
    for(const on of [true,false]){
     if(on)await page.check('[name="trustRequired"]');else await page.uncheck('[name="trustRequired"]');
     await page.click('[data-set-form="organizers"] button[type="submit"]');
     await page.waitForFunction(v=>document.querySelector('[name="trustRequired"]')?.checked===v&&!!document.querySelector('.set-pending')===v,on);await sleep(200);
     assert.equal((await focused(page)).form,'organizers');
    }
    assert.match(await page.textContent('[aria-labelledby="set-h-history"]'),/potwierdzanie organizatorów włączone/);
    await noOverflow(page,'settings 1024');await noCsp(page);await ctx.close();}
  // 2. Organizer at 390 px (EN): the own tournament is managed (copy link) although the bootstrap user has only caps.
  let tid;
  { const {ctx,page}=await open({width:390,height:844,lang:'en'});
    await signup(page,{organizer:true});await page.waitForFunction(()=>location.hash.startsWith('#tournaments'),null,{timeout:25000});
    await page.click('[data-action="new-tournament"]');await page.waitForSelector('#tournament-form');
    assert.equal(await page.inputValue('#tournament-form [name="status"]'),'open');assert.equal(await page.isChecked('#tournament-form [name="selfEntry"]'),true);
    await page.fill('#tournament-form [name="name"]','QA Roles Cup '+letters(4));await page.fill('#tournament-form [name="date"]','2031-07-12');await page.fill('#tournament-form [name="city"]','Gdańsk');
    const saved=page.waitForResponse(r=>route(r)==='command');await page.click('#modal-root button[form="tournament-form"]');assert.equal((await saved).status(),200);
    await page.waitForSelector('#modal-root .modal',{state:'detached'});await page.goto(app+'#tournaments');
    await page.waitForSelector('[data-action="copy-link"]',{timeout:15000});
    tid=await page.getAttribute('[data-action="copy-link"]','data-id');assert.ok(tid);
    assert.equal(await page.evaluate(id=>{const card=document.querySelector(`[data-action="copy-link"][data-id="${id}"]`),others=document.querySelector('.tournament-section');return !others||!(others.compareDocumentPosition(card)&4);},tid),true,'the own tournament is not listed among other organizers\' ones');
    assert.equal(await page.textContent('.workspace-summary div:first-child strong'),'1','one own tournament');
    assert.equal(await page.locator('.first-run-steps li.done').count(),1,'"Create tournament" is done');
    await noOverflow(page,'organizer tournaments 390');await noCsp(page);await ctx.close();}
  // 3. Guest access card (F2): the sign-up offer without selfEntry in the guest view, the athlete offer with its target with it.
  { const {ctx,page}=await open({width:1440,height:900,lang:'pl'});
    const card=async(force)=>{
     await page.unroute('**/api/index.php?route=public-tournament*').catch(()=>{});
     if(force!==undefined)await page.route('**/api/index.php?route=public-tournament*',async r=>{const res=await r.fetch(),body=await res.json();if(force===null)delete body.tournament.selfEntry;else body.tournament.selfEntry=force;await r.fulfill({response:res,json:body});});
     await page.goto(app+'#guest?t='+tid);await page.reload();await page.waitForSelector('.modal.promo');await page.click('.promo .promo-actions [data-action="close-modal"]');
     await page.waitForSelector('.access-card');return page.evaluate(()=>{const b=document.querySelector('.access-cta');return {title:document.querySelector('#access-title').textContent,as:b.dataset.signupAs??null,t:b.dataset.tournamentId??null};});
    };
    const off=await card(null);assert.deepEqual([off.as,off.t],[null,null]);assert.equal(off.title,'Dołącz do rozmowy o turnieju');
    assert.equal((await card(false)).as,null);
    const on=await card(true);assert.deepEqual(on,{title:'Zgłoś się do tego turnieju',as:'athlete',t:tid});
    assert.match(await page.textContent('.access-card'),/Załóż konto zawodnika i zgłoś się/);assert.ok(!/Konta klubów nadal zakłada/.test(await page.textContent('.access-card')));
    await noOverflow(page,'guest offer');
    await page.click('.access-cta');await page.waitForFunction(t=>location.hash==='#signup?as=athlete&t='+t,tid);
    assert.equal(await page.isChecked('#acct-signup-1 [name="role-athlete"]'),true);
    await ctx.close();}
  // 4. Athlete sign-up from the offer (F6): landing on #guest?t=…&enter=1 opens the entry window once; the entry is sent.
  const clubName='UKS QA '+letters(6);
  { const {ctx,page}=await open({width:1440,height:900,lang:'pl'});
    await signup(page,{hash:'#signup?as=athlete&t='+tid,athlete:{club:'new',clubName}});
    await page.waitForSelector('#ath-entry-form',{timeout:25000});
    assert.equal(await page.evaluate(()=>location.hash),'#guest?t='+tid,'enter=1 is consumed');
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('#modal-root')),true,'the focus is in the window');
    await page.locator('#ath-entry-form input[name="events"]').first().check();
    const sent=page.waitForResponse(r=>route(r)==='athlete-entry');await page.click('#modal-root button[form="ath-entry-form"]');assert.equal((await sent).status(),200);
    await page.waitForSelector('#ath-entry-form',{state:'detached'});
    await page.waitForFunction(()=>/Zgłoszenie przyjęte/.test(document.querySelector('[data-athlete-cta]')?.textContent||''),null,{timeout:15000});
    await noOverflow(page,'member preview');await noCsp(page);await ctx.close();}
  // A pending club name for Kluby (step 6): with the day's quota of new clubs used up, an athlete's new club stays a pending name.
  const pendingName='UKS Oczekujący '+letters(6);
  { const {ctx,page}=await open({width:1440,height:900,lang:'pl'});const filled=fixture('roles-clubs-fill');
    try{const sent=page.waitForResponse(r=>route(r)==='signup'&&r.request().method()==='POST',{timeout:60000});
     const email=await signup(page,{hash:'#signup?as=athlete',athlete:{club:'new',clubName:pendingName}});assert.equal((await sent).status(),200);
     const u=fixture('roles-user',{email});assert.deepEqual([u.profiles[0].clubId,u.profiles[0].data.pendingClubName],['unaffiliated',pendingName]);}
    finally{fixture('roles-clubs-remove',{ids:filled});}
    await ctx.close();}
  // 5. Członkowie: confirm and take the organizer role by keyboard; the focus moves to the opposite action of the same row.
  { const {ctx,page}=await open({width:1440,height:900,lang:'pl'});await login(page,...ADMIN);
    await page.goto(app+'#members');await page.waitForSelector('.mem-toolbar select[name="filter"]',{timeout:20000});
    await page.selectOption('.mem-toolbar select[name="filter"]','organizers');await page.click('.mem-toolbar button[type="submit"]');
    await page.waitForSelector('.mem-row [data-mem-act="org-trust"]',{timeout:15000});
    const id=await page.locator('.mem-row:has([data-mem-act="org-trust"])').first().getAttribute('data-mem-id');
    const row=`.mem-row[data-mem-id="${id}"]`;
    await page.focus(`${row} [data-mem-act="org-trust"]`);await page.keyboard.press('Enter');
    await page.waitForSelector(`${row} [data-mem-act="org-untrust"]`);await sleep(200);
    assert.deepEqual([(await focused(page)).mem,(await focused(page)).row],['org-untrust',id]);
    await page.focus(`${row} [data-mem-act="org-block"]`);await page.keyboard.press('Enter');await page.waitForSelector('[data-mem-act="org-block-go"]');
    await page.click('[data-mem-act="org-block-go"]');await page.waitForSelector(`${row} [data-mem-act="org-unblock"]`);await sleep(200);
    assert.deepEqual([(await focused(page)).mem,(await focused(page)).row],['org-unblock',id],'after the dialog');
    await page.focus(`${row} [data-mem-act="org-unblock"]`);await page.keyboard.press('Enter');await page.waitForSelector(`${row} [data-mem-act="org-block"]`);await sleep(200);
    assert.equal((await focused(page)).mem,'org-block');
    await noOverflow(page,'members');
  // 6. Kluby: rename keeps the focus on the club's "Zmień nazwę"; a verified club leaves the unverified list, the filter takes it.
    await page.goto(app+'#clubs');await page.waitForSelector('[data-clubs-root] .clb-toolbar',{timeout:15000});
    await page.click('[data-clb-filter="unverified"]');
    const verify=page.locator('.clb-row',{hasText:clubName}).locator('[data-clb-act="verify"]');await verify.waitFor();const cid=await verify.getAttribute('data-clb-id');
    await verify.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>/Klub zweryfikowany/.test(document.querySelector('#toast')?.textContent||''));await sleep(300);
    assert.equal((await focused(page)).filter,'unverified','the verified club left the list');
    await page.click('[data-clb-filter="all"]');await page.focus(`[data-clb-act="rename"][data-clb-id="${cid}"]`);await page.keyboard.press('Enter');
    await page.waitForSelector('#clb-rename-form');await page.fill('#clb-rename-form [name="name"]',clubName+' Nowa');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>/Nazwa klubu zmieniona/.test(document.querySelector('#toast')?.textContent||''));await sleep(300);
    assert.deepEqual([(await focused(page)).clb,(await focused(page)).clbId],['rename',cid]);
    // Adopt: "Utwórz klub i przypisz" carries only the name key (the row leaves the list): the focus goes to the selected filter.
    const adopt=page.locator('.clb-row-pending',{hasText:pendingName}).locator('[data-clb-act="adopt"]');await adopt.focus();await page.keyboard.press('Enter');
    await page.waitForSelector('[data-clb-act="adopt-go"]');await page.focus('[data-clb-act="adopt-go"]');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>/Klub utworzony/.test(document.querySelector('#toast')?.textContent||''));await sleep(300);
    assert.equal(await page.locator('.clb-row-pending',{hasText:pendingName}).count(),0,'the pending name was adopted');
    assert.deepEqual([(await focused(page)).tag,(await focused(page)).filter],['BUTTON','all'],'after adopt');
    await noOverflow(page,'clubs');await noCsp(page);await ctx.close();}
  assert.deepEqual(problems,[]);
 }finally{
  await browser.close();
  if(settingsBefore)fixture('settings-set',{data:settingsBefore.data,version:settingsBefore.version});else fixture('settings-reset');
  fixture('reset-limits');
 }
});
