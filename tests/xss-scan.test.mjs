// Static XSS scan of the community modules (plan §5.9, §10): values from the API reach the DOM only through textContent,
// createTextNode or the escaping h`…` template. HTML sinks are allowed once, inside setHtml in dist/registry.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const read=file=>readFileSync(new URL('../dist/'+file,import.meta.url),'utf8');
// New modules (plan §5.9): registry, me, chat* (with chat-admin), moderation-boot, account*, members-boot, admin-members, avatar-crop, pwa.
const SCOPE=/^(?:registry|me|moderation-boot|members-boot|admin-members|avatar-crop|pwa)\.js$|^(?:chat|account)[\w-]*\.js$/;
const MODULES=readdirSync(new URL('../dist/',import.meta.url)).filter(f=>SCOPE.test(f)).sort();
const RULES=[
 ['innerHTML',/\binnerHTML\b/],
 ['outerHTML',/\bouterHTML\b/],
 ['insertAdjacentHTML',/\binsertAdjacentHTML\b/],
 ['document.write',/\bdocument\s*\.\s*write(?:ln)?\b/],
 ['DOMParser / createContextualFragment',/\bDOMParser\b|\bcreateContextualFragment\b|\bsetHTMLUnsafe\b|\bparseHTMLUnsafe\b/],
 ['script element',/createElement(?:NS)?\s*\([^)]*['"`]script['"`]|<\s*script\b/i],
 ['on* attribute',/setAttribute(?:NS)?\s*\([^)]*?['"`]on[a-z]|\son[a-z]+\s*=\s*["'`{$\\]|\[\s*['"`]on[a-z]+['"`]\s*\]\s*=/i],
 ['trustedHtml outside registry.js',/\btrustedHtml\b/]
];
/** Removes comments (block, and line comments not preceded by ':' as in URLs) so that documentation can name the sinks. */
const code=source=>source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:\\])\/\/.*$/gm,'$1');
/** Rule names violated by a module source. */
export function violations(source){const text=code(source);return RULES.filter(([,re])=>re.test(text)).map(([name])=>name);}
/** registry.js may assign innerHTML once, inside setHtml, and defines trustedHtml; nothing else. */
function registryViolations(source){
 const text=code(source),start=text.indexOf('export function setHtml('),end=text.indexOf('\n}',start);
 const body=start<0||end<0?'':text.slice(start,end),rest=start<0?text:text.slice(0,start)+text.slice(end);
 const out=violations(rest.replace(/export const trustedHtml=[^;]*;/,'').replace(/\btrustedHtml\b/g,''));
 if(!/\.innerHTML=safe\.html/.test(body)||(body.match(/innerHTML/g)||[]).length!==1)out.push('setHtml must be the single innerHTML assignment');
 if(/\binstanceof SafeHtml\b/.test(body)===false)out.push('setHtml must reject values that are not SafeHtml');
 return out;
}

test('the scan covers the community modules that exist',()=>{
 for(const file of ['registry.js','me.js','chat-boot.js','chat-admin.js','moderation-boot.js','account-boot.js','members-boot.js','admin-members.js','pwa.js'])assert.ok(MODULES.includes(file),file);
 for(const file of ['app.js','client.js','i18n.js','chat.css'])assert.ok(!MODULES.includes(file),file);
 assert.ok(SCOPE.test('chat-transport.js')&&SCOPE.test('chat-demo.js')&&SCOPE.test('account-flow.js')&&SCOPE.test('avatar-crop.js'),'future modules are in scope by name');
});

test('no HTML sinks, script elements or on* attributes in the community modules',()=>{
 const found=[];
 for(const file of MODULES){const list=file==='registry.js'?registryViolations(read(file)):violations(read(file));for(const rule of list)found.push(file+': '+rule);}
 assert.deepEqual(found,[]);
});

test('ARIA booleans: the template writes only the words true/false into aria-* values and escapes everything else',async()=>{
 const {h}=await import('../dist/registry.js');
 for(const evil of ['"><img src=x onerror=1>',"' onfocus='x",'`',{toString:()=>'"><svg onload=1>'},['"><b>'],0,NaN])
  assert.match(String(h`<button aria-pressed="${evil}" aria-label='${evil}'>`),/^<button aria-pressed="[^"'<>`]*" aria-label='[^"'<>`]*'>$/,String(evil));
 assert.equal(String(h`<button aria-pressed="${false}">`),'<button aria-pressed="false">');
 // No template in the modules spells an empty ARIA state literally either.
 const found=[];for(const file of MODULES)if(/aria-(?:pressed|selected|checked|expanded)=(?:""|'')/.test(read(file)))found.push(file);
 assert.deepEqual(found,[]);
});

test('the scanner catches deliberate violations (and ignores comments and safe code)',()=>{
 const bad={
  'el.innerHTML=message.text;':'innerHTML','el.innerHTML += x':'innerHTML','node.outerHTML=x':'outerHTML','list.insertAdjacentHTML("beforeend",row)':'insertAdjacentHTML',
  'document.write(x)':'document.write','document . writeln(x)':'document.write','new DOMParser().parseFromString(x,"text/html")':'DOMParser / createContextualFragment',
  'document.createElement("script")':'script element',"const s=`<script src=x></script>`":'script element',
  "img.setAttribute('onerror',code)":'on* attribute',"`<img src=x onerror=${code}>`":'on* attribute',"'<a onclick=\"go()\">'":'on* attribute',"el['onclick']=f":'on* attribute',
  "setHtml(el,trustedHtml(user.name))":'trustedHtml outside registry.js'
 };
 for(const [source,rule] of Object.entries(bad))assert.ok(violations(source).includes(rule),source+' -> '+violations(source));
 const good=['// innerHTML is not used here','/* document.write */ const a=1;',"const url='https://x.example/page';",
  'el.textContent=message.text;','el.append(document.createTextNode(name));','setHtml(el,h`<b>${name}</b>`);','channel.onmessage=event=>reset(event);','button.addEventListener("click",go);',
  "a.href=url.href;a.rel='noopener noreferrer nofollow ugc';","const online=navigator.onLine;"];
 for(const source of good)assert.deepEqual(violations(source),[],source);
 assert.deepEqual(registryViolations('export function setHtml(el,safe){\n if(!(safe instanceof SafeHtml))throw 1;\n el.innerHTML=safe.html;return el;\n}\nexport const trustedHtml=html=>new SafeHtml(html,TOKEN);'),[]);
 assert.ok(registryViolations('export function setHtml(el,safe){\n if(!(safe instanceof SafeHtml))throw 1;\n el.innerHTML=safe.html;\n}\nfunction x(el,s){el.innerHTML=s;}').includes('innerHTML'),'a second innerHTML in registry.js fails');
 assert.ok(registryViolations('export function setHtml(el,safe){\n el.innerHTML=safe.html;\n}').length>0,'setHtml without the SafeHtml check fails');
});
