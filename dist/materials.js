/* Tournament materials (docs/plan/PLAN-MATERIALY.md): the poster and the rules of a tournament; the rules are a PDF or a typed text.
 * Contract (sections 2 and 4): every tournament view may carry the sparse fields poster {v,w,h,color} and rules {v,size,type} with
 * type 'pdf' (size in bytes) or 'text' (size in characters); the demo adds src (files) and text (typed rules).
 *  - Addresses: api/index.php?route=material&t=<id>&k=poster&s=sm|lg&v=<v> and ...&k=rules&v=<v> (the PDF, or the text as text/plain,
 *    fetched only when someone reads it); the demo uses src and text.
 *  - Writing: poster-upload and rules-upload (raw bytes, XMLHttpRequest through Client.upload for the progress bar), rules-text (JSON
 *    {t,text}) and material-delete (JSON). Each answers like the command route, {workspace,result}; ui.applyWorkspace puts the workspace
 *    in place exactly as a command does. The demo runs the domain command tournament.material with the stored meta (Materials::meta,
 *    src instead of f): poster {src,w,h,c,at} (a JPEG data URL of at most 1200 px), PDF {src,b,at} (a data URL), text {t,at} (t as
 *    rulesText cleans it); value null removes.
 *  - Poster in the browser: EXIF orientation (createImageBitmap with imageOrientation from-image, else an <img> from a data URL: the
 *    CSP allows no blob: images), at most 2400 px on the longer side, WebP checked by the blob's type, else JPEG 0.88 (Safari encodes
 *    no WebP); never cropped; transparency on white; the average colour for the frame behind the picture.
 *  - PDF: by type or extension, at most features.materials.rules bytes, %PDF- at the start and %%EOF at the end.
 *  - Text: 1 to 20 000 characters; shown by renderRules (paragraphs, ## headings, - and 1. lists, https links) from escaped text only.
 *  - Templates (h`...` only, tests/xss-scan): thumbnails in a fixed 3:4 frame (contain, on the poster colour), the guest page's large
 *    poster, the rules link or button, the "Materials" section of the tournament dialog with its controller, the full-screen poster
 *    preview and the rules reader (dialogs with a focus trap; focus returns to the opener).
 * Pure helpers are exported for tests/materials-ui.test.mjs. */
import {registry,h,setHtml} from './registry.js';
import * as Client from './client.js';
import {getMe,loadMe} from './me.js';
import {rulesText} from './guest-view.js';
import {t as T,locale,translateMessage} from './i18n.js';

export const KINDS=['poster','rules'];
export const POSTER_EDGE=2400,DEMO_EDGE=1200,PREVIEW_EDGE=480,MIN_SIDE=200,SOURCE_MAX=40*1024*1024;
export const SM_BOX=[480,720],LG_EDGE=2000,TEXT_MAX=20000;
export const DEFAULT_LIMITS={poster:4194304,rules:10485760};
/** The demo keeps files in this browser's storage (a few MB in all): larger documents are refused before they are read. */
export const DEMO_RULES_MAX=3*1024*1024;
/** Encoding steps of a poster: [longer edge, WebP quality]; JPEG uses 0.88 at the first step, then the step's quality. */
export const STEPS=[[POSTER_EDGE,0.86],[POSTER_EDGE,0.74],[1800,0.72]];
const HEX=/^#[0-9a-f]{6}$/i,FALLBACK_COLOR='#e9eff6';
const ui=()=>registry.use('ui');
const icon=(name,cls='')=>ui()?.icon?.(name,cls)??'';
const int=v=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):0;};
const failure=message=>{const e=new Error(message);e.materials=true;return e;};

// ---- Data and addresses ----
/** A src the demo may put into an attribute: an image or PDF data URL, or a file of this installation (./demo/...). */
export function safeSrc(src){
 if(typeof src!=='string')return null;
 if(/^data:(?:image\/(?:jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(src))return src;
 if(/^\.\/(?:[\w-]+\/)*[\w.-]+$/.test(src)&&!src.includes('..'))return src;
 return null;
}
/** The sparse poster of a tournament view, checked: {v,w,h,color,src} or null. */
export function posterOf(t){
 const p=t?.poster;if(!p||typeof p!=='object')return null;
 const w=int(p.w),hh=int(p.h);if(!(w>0&&hh>0))return null;
 return {v:String(p.v??''),w,h:hh,color:HEX.test(String(p.color))?String(p.color).toLowerCase():FALLBACK_COLOR,src:safeSrc(p.src)};
}
/** The sparse rules of a tournament view, checked: {v,size,type:'pdf'|'text',src,text} or null (a view without type is a PDF). */
export function rulesOf(t){
 const r=t?.rules;if(!r||typeof r!=='object')return null;
 const type=r.type==='text'?'text':'pdf';
 return {v:String(r.v??''),size:Math.max(0,int(r.size)),type,src:type==='pdf'?safeSrc(r.src):null,text:type==='text'&&typeof r.text==='string'?r.text:null};
}
/** Address of a material (contract 2.1): src in the demo, else the material route with the version. size is 'sm' or 'lg' (poster). */
export function materialUrl(id,kind,item,{demo=Client.isDemo,size='sm'}={}){
 if(!item||!KINDS.includes(kind))return null;
 if(item.src)return item.src;
 if(demo)return null;
 return Client.apiUrl(kind==='poster'?{route:'material',t:String(id),k:'poster',s:size==='lg'?'lg':'sm',v:item.v}:{route:'material',t:String(id),k:'rules',v:item.v});
}
export const posterUrl=(t,size='sm',opts={})=>materialUrl(t?.id,'poster',posterOf(t),{...opts,size});
export const rulesUrl=(t,opts={})=>materialUrl(t?.id,'rules',rulesOf(t),opts);
/** Whether the rules of t can be shown here: typed rules always (the reader loads them), a PDF when it has an address. */
export const rulesReadable=(t,{demo=Client.isDemo}={})=>{const r=rulesOf(t);return !!r&&(r.type==='text'||!!rulesUrl(t,{demo}));};
/** Pixel size of the server's sm file (fits 480x720) and lg file (longer side at most 2000 px), never enlarged. */
export function smSize(w,hh){const s=Math.min(1,SM_BOX[0]/w,SM_BOX[1]/hh);return [Math.max(1,Math.round(w*s)),Math.max(1,Math.round(hh*s))];}
export function lgSize(w,hh){const s=Math.min(1,LG_EDGE/Math.max(w,hh));return [Math.max(1,Math.round(w*s)),Math.max(1,Math.round(hh*s))];}
/** Width and height that fit into edge on the longer side (never enlarged). */
export function fitSize(w,hh,edge=POSTER_EDGE){const s=Math.min(1,edge/Math.max(w,hh));return {w:Math.max(1,Math.round(w*s)),h:Math.max(1,Math.round(hh*s))};}

// ---- Texts ----
/** "1,2 MB" (Polish decimal comma) or "1.2 MB"; under about a megabyte in KB. A no-break space keeps the unit with the number. */
export function formatSize(bytes,loc=locale()){
 const b=Math.max(0,Number(bytes)||0),KB=1024,MB=KB*KB;
 if(b>=0.95*MB){const n=b/MB;return new Intl.NumberFormat(loc,{maximumFractionDigits:n<10?1:0}).format(n)+'\u00a0MB';}
 return new Intl.NumberFormat(loc,{maximumFractionDigits:0}).format(Math.max(1,Math.round(b/KB)))+'\u00a0KB';
}
/** "Regulamin (PDF, 1,2 MB)" for a PDF, "Regulamin" for typed rules. */
export const rulesLabel=r=>r?.type==='text'?T('Regulamin'):T('Regulamin (PDF, {size})',{size:formatSize(r?.size)});
/** A file name for downloads: the tournament's name without diacritics, lower case, words joined with "-". */
export function slug(name){
 const s=String(name??'').replace(/[\u0141\u0142]/g,c=>c==='\u0141'?'L':'l').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);
 return s||'turniej';
}
export const posterFileName=t=>T('plakat')+'-'+slug(t?.name);

// ---- Typed rules ----
/** The text as the server keeps it (Materials::text, mirrored by rulesText of guest-view.js); '' for a value it refuses. */
export function cleanRulesText(s){return rulesText(String(s??''))??'';}
/** Length in characters (code points, as the server counts). */
export const textLength=s=>[...String(s??'')].length;
const URL_RE=/https:\/\/[^\s<>"'`]+/g;
/** Escaped text with https:// addresses as links (new tab, no referrer, no ranking credit). Trailing punctuation and an unmatched
 * closing bracket stay outside the link; anything that is not a valid https URL stays text (http:, javascript:, data: never link). */
export function inlineHtml(text){
 const s=String(text??''),out=[];let last=0;
 for(const m of s.matchAll(URL_RE)){
  let url=m[0];
  for(;;){if(/[.,;:!?\u2026'"\u201d\u00bb]$/.test(url)){url=url.slice(0,-1);continue;}if(url.endsWith(')')&&url.split('(').length<url.split(')').length){url=url.slice(0,-1);continue;}break;}
  let ok=false;try{const u=new URL(url);ok=u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password;}catch{}
  if(!ok)continue;
  out.push(s.slice(last,m.index),h`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow ugc">${url}</a>`);last=m.index+url.length;
 }
 out.push(s.slice(last));
 return h`${out}`;
}
/** Blocks of typed rules: an empty line ends a paragraph or a list; "## " (or "#", "###") a heading; "- ", "* ", "• " or "– " a bullet;
 * "1. " or "1) " a numbered list (its first number is kept); other lines of a paragraph are joined with line breaks. */
export function rulesBlocks(text){
 const blocks=[];let cur=null;const close=()=>{if(cur)blocks.push(cur);cur=null;};
 for(const raw of cleanRulesText(text).split('\n')){
  const line=raw.trim();let m;
  if(!line){close();continue;}
  if((m=/^#{1,3}\s+(.+)$/.exec(line))){close();blocks.push({type:'h',text:m[1]});continue;}
  if((m=/^[-*\u2022\u2013]\s+(.+)$/.exec(line))){if(cur?.type!=='ul'){close();cur={type:'ul',items:[]};}cur.items.push(m[1]);continue;}
  if((m=/^(\d{1,3})[.)]\s+(.+)$/.exec(line))){if(cur?.type!=='ol'){close();cur={type:'ol',start:Number(m[1]),items:[]};}cur.items.push(m[2]);continue;}
  if(cur?.type==='p')cur.lines.push(line);else{close();cur={type:'p',lines:[line]};}
 }
 close();return blocks;
}
/** Typed rules as SafeHtml (headings are h3: the reader's title is the h2). User text never becomes markup. */
export function renderRules(text){
 const li=items=>items.map(i=>h`<li>${inlineHtml(i)}</li>`);
 return h`${rulesBlocks(text).map(b=>b.type==='h'?h`<h3>${inlineHtml(b.text)}</h3>`:b.type==='ul'?h`<ul>${li(b.items)}</ul>`:b.type==='ol'?h`<ol${b.start!==1?h` start="${b.start}"`:''}>${li(b.items)}</ol>`:h`<p>${b.lines.map((l,i)=>i?h`<br>${inlineHtml(l)}`:inlineHtml(l))}</p>`)}`;
}
const texts=new Map();
/** The typed rules of t: from the view (the demo's workspace), from the demo's data, else from the material route (text/plain), kept
 * per version. Throws a message when they cannot be read. */
export async function loadRulesText(t){
 const r=rulesOf(t);if(!r||r.type!=='text')return '';
 if(r.text!==null)return r.text;
 const unreadable=()=>failure(T('Nie udało się wczytać regulaminu. Sprawdź połączenie i spróbuj ponownie.'));
 if(Client.isDemo){const text=Client.demoRulesText(String(t.id));if(typeof text!=='string')throw unreadable();return text;}
 const key=String(t.id)+'|'+r.v;if(texts.has(key))return texts.get(key);
 let res;try{res=await fetch(rulesUrl(t,{demo:false}),{credentials:'same-origin',headers:{Accept:'text/plain','X-MatBravo-Client':String(Client.CLIENT_API)}});}catch{throw unreadable();}
 if(!res.ok)throw unreadable();
 const text=await res.text();texts.set(key,text);return text;
}

// ---- Limits (me.features.materials) ----
/** {poster,rules} in bytes (0 = switched off on this server) or null when the server has no materials (an older server, me missing). */
export function limitsOf(features){
 const m=features?.materials;if(!m||typeof m!=='object')return null;
 const n=v=>Math.max(0,int(v));return {poster:n(m.poster),rules:n(m.rules)};
}
export const limits=()=>limitsOf(getMe()?.features);

// ---- PDF checks ----
const ascii=s=>[...s].map(c=>c.charCodeAt(0));
const find=(bytes,pattern,from,to)=>{outer:for(let i=Math.max(0,from);i+pattern.length<=to;i++){for(let j=0;j<pattern.length;j++)if(bytes[i+j]!==pattern[j])continue outer;return i;}return -1;};
const PDF_START=ascii('%PDF-'),PDF_END=ascii('%%EOF');
const bytesOf=x=>x instanceof Uint8Array?x:x instanceof ArrayBuffer?new Uint8Array(x):ArrayBuffer.isView(x)?new Uint8Array(x.buffer,x.byteOffset,x.byteLength):new Uint8Array(0);
/** %PDF- within the first 1024 bytes (where readers and the server look for it). */
export function isPdfStart(head){const b=bytesOf(head);return find(b,PDF_START,0,Math.min(b.length,1024))>=0;}
/** %%EOF within the last 2048 bytes (a complete file, as the server checks). */
export function hasPdfEnd(tail){const b=bytesOf(tail);return find(b,PDF_END,Math.max(0,b.length-2048),b.length)>=0;}
/** Whether a file is offered as a PDF (type or .pdf name; phones often send application/octet-stream). */
export const looksPdf=file=>/^application\/(?:x-)?pdf$/i.test(String(file?.type||''))||/\.pdf$/i.test(String(file?.name||''));
/** Throws a message for a rules file that cannot be used; resolves true otherwise. */
export async function checkRules(file,max=DEFAULT_LIMITS.rules){
 if(!file)throw failure(T('Wybierz plik PDF.'));
 if(!looksPdf(file))throw failure(T('Regulamin musi być plikiem PDF.'));
 if(!(file.size>0))throw failure(T('Ten plik PDF jest pusty.'));
 if(file.size>max)throw failure(T('Plik PDF jest za duży (maks. {size}).',{size:formatSize(max)}));
 const head=await file.slice(0,1024).arrayBuffer();
 if(!isPdfStart(head))throw failure(T('To nie jest prawidłowy plik PDF.'));
 const tail=await file.slice(Math.max(0,file.size-2048)).arrayBuffer();
 if(!hasPdfEnd(tail))throw failure(T('Plik PDF jest niekompletny. Zapisz go ponownie i spróbuj jeszcze raz.'));
 return true;
}

// ---- Poster preparation ----
/** Average colour of RGBA pixels (already on white) as #rrggbb. */
export function averageColor(data){
 let r=0,g=0,b=0,n=0;for(let i=0;i+3<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];n++;}
 if(!n)return FALLBACK_COLOR;const hex=v=>Math.round(v/n).toString(16).padStart(2,'0');return '#'+hex(r)+hex(g)+hex(b);
}
const toBlob=(canvas,type,quality)=>new Promise(resolve=>{try{canvas.toBlob(blob=>resolve(blob||null),type,quality);}catch{resolve(null);}});
/** WebP when the browser really writes WebP (the blob's type says so), else JPEG at 0.88 (first step) or the step's quality. */
export async function encode(canvas,quality=STEPS[0][1],write=toBlob){
 let blob=await write(canvas,'image/webp',quality);
 if(blob&&blob.type==='image/webp')return blob;
 blob=await write(canvas,'image/jpeg',quality>=STEPS[0][1]?0.88:quality);
 return blob&&blob.type==='image/jpeg'?blob:null;
}
const readDataUrl=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.addEventListener('load',()=>resolve(String(r.result)),{once:true});r.addEventListener('error',()=>reject(r.error||new TypeError()),{once:true});r.readAsDataURL(blob);});
function imageFrom(file){
 return readDataUrl(file).then(url=>new Promise((resolve,reject)=>{const img=new Image();img.decoding='async';img.addEventListener('load',()=>resolve(img),{once:true});img.addEventListener('error',()=>reject(new TypeError()),{once:true});img.src=url;}));
}
/** Decoded picture turned by its EXIF orientation: an ImageBitmap, else an <img> (data URL: no blob: in the CSP). */
async function decode(file){
 if(typeof createImageBitmap==='function'){try{const b=await createImageBitmap(file,{imageOrientation:'from-image'});if(b.width&&b.height)return b;}catch{}}
 const img=await imageFrom(file);if(!img.naturalWidth||!img.naturalHeight)throw new TypeError();return img;
}
const sizeOf=source=>({w:source.naturalWidth||source.width||0,h:source.naturalHeight||source.height||0});
function canvasOf(w,hh){const c=document.createElement('canvas');c.width=w;c.height=hh;return c;}
/** The picture at w x h on white (transparent posters stay readable on every background). */
function paint(source,w,hh){
 const c=canvasOf(w,hh),g=c.getContext('2d');g.fillStyle='#ffffff';g.fillRect(0,0,w,hh);g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.drawImage(source,0,0,w,hh);return c;
}
function colorOf(canvas){try{const c=paint(canvas,12,16);return averageColor(c.getContext('2d').getImageData(0,0,12,16).data);}catch{return FALLBACK_COLOR;}}
/** A JPEG data URL of the canvas at most edge px long, under limit characters when a lower quality allows it. */
function jpegUrl(canvas,edge,limit=Infinity){
 const s=fitSize(canvas.width,canvas.height,edge),c=s.w===canvas.width&&s.h===canvas.height?canvas:paint(canvas,s.w,s.h);
 let url='';for(const q of [0.84,0.76,0.66,0.56]){url=c.toDataURL('image/jpeg',q);if(url.length<=limit)break;}
 return {url,w:s.w,h:s.h};
}
/** Throws the message for a file that is not a usable picture before anything is decoded. */
export function checkPosterFile(file){
 if(!file)throw failure(T('Wybierz zdjęcie plakatu.'));
 const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase();
 if(looksPdf(file))throw failure(T('Plakat w PDF nie jest jeszcze obsługiwany. Zapisz plakat jako obraz JPG lub PNG i dodaj go ponownie.'));
 if(type==='image/svg+xml'||name.endsWith('.svg'))throw failure(T('Plakat SVG nie jest obsługiwany. Wybierz obraz JPG, PNG lub WebP.'));
 if(type?!type.startsWith('image/'):!/\.(?:jpe?g|png|webp|heic|heif|avif|gif|bmp)$/.test(name))throw failure(T('To nie jest obraz. Wybierz zdjęcie JPG, PNG lub WebP.'));
 if(file.size>SOURCE_MAX)throw failure(T('To zdjęcie jest za duże (ponad {size}). Wybierz mniejsze.',{size:formatSize(SOURCE_MAX)}));
 return true;
}
/** The poster ready to send: {blob,type,w,h,color,preview,previewW,previewH,demo:{src,w,h}|null}. Throws a message (not an image,
 * too small, too large even after compression). max: features.materials.poster. */
export async function preparePoster(file,{max=DEFAULT_LIMITS.poster,demo=Client.isDemo}={}){
 checkPosterFile(file);
 let source;
 try{source=await decode(file);}
 catch{throw failure(/hei[cf]/.test(String(file.type)+String(file.name).toLowerCase())?T('Ta przeglądarka nie otwiera zdjęć HEIC. Wybierz zdjęcie prosto z telefonu albo zapisz je jako JPG.'):T('Nie udało się odczytać tego obrazu. Wybierz zdjęcie JPG, PNG lub WebP.'));}
 try{
  const {w,h:hh}=sizeOf(source);
  for(const [edge,quality] of STEPS){
   const size=fitSize(w,hh,edge);
   if(Math.min(size.w,size.h)<MIN_SIDE)throw failure(T('Plakat jest za mały: krótszy bok musi mieć co najmniej {px} px.',{px:MIN_SIDE}));
   const canvas=paint(source,size.w,size.h),blob=await encode(canvas,quality);
   if(!blob)throw failure(T('Ta przeglądarka nie potrafi przygotować plakatu. Spróbuj w innej przeglądarce.'));
   if(blob.size>max)continue;
   const preview=jpegUrl(canvas,PREVIEW_EDGE),out={blob,type:blob.type,w:size.w,h:size.h,color:colorOf(canvas),preview:preview.url,previewW:preview.w,previewH:preview.h,demo:null};
   if(demo){const d=jpegUrl(canvas,DEMO_EDGE,450000);out.demo={src:d.url,w:d.w,h:d.h};}
   return out;
  }
  throw failure(T('Plakat jest za duży nawet po zmniejszeniu (maks. {size}). Wybierz mniejszy plik.',{size:formatSize(max)}));
 }finally{try{source.close?.();}catch{}}
}

// ---- Sending ----
const routes={poster:'poster-upload',rules:'rules-upload'};
/** The message of a failed send, in the current language. */
export function messageOf(error){
 if(error?.materials)return error.message;
 if(error?.status===413)return T('Plik jest za duży dla serwera.');
 if(/quota/i.test(String(error?.name)+String(error?.message)))return T('Wersja demonstracyjna przechowuje pliki w tej przeglądarce i ten się nie mieści. Wybierz mniejszy plik.');
 return translateMessage(String(error?.message||''))||T('Nie udało się zapisać materiału. Spróbuj ponownie.');
}
/** The answer {workspace,result} of a write (API route or demo command), applied like a command's answer. */
function applied(res){ui()?.applyWorkspace?.(res);return res?.result??null;}
const reauth=fn=>ui()?.reauth?ui().reauth(fn):fn();
const demoCommand=(id,kind,value)=>{const ws=ui()?.getWorkspace?.();return Client.command('tournament.material',{id,kind,value},Number(ws?.revision)||0);};
/** Sends a prepared poster ({blob,...}), a checked PDF (File) or typed rules ({type:'text',text}) for tournament id. onProgress(0..1)
 * while bytes go out. */
export async function sendMaterial(kind,id,item,{onProgress}={}){
 const text=kind==='rules'&&item?.type==='text';
 if(Client.isDemo){
  const at=Math.floor(Date.now()/1000);let value;
  if(kind==='poster')value={src:item.demo.src,w:item.demo.w,h:item.demo.h,c:item.color,at};
  else if(text)value={t:cleanRulesText(item.text),at};
  else value={src:'data:application/pdf;base64,'+String(await readDataUrl(item)).split(',')[1],b:item.size,at};
  onProgress?.(1);return applied(await demoCommand(id,kind,value));
 }
 if(text)return applied(await reauth(()=>Client.request('rules-text',{method:'POST',body:{t:id,text:item.text}})));
 const body=kind==='poster'?item.blob:item,type=kind==='poster'?item.type:'application/pdf';
 return applied(await reauth(()=>Client.upload({route:routes[kind],t:id},{body,contentType:type,onProgress})));
}
/** Removes the poster or the rules of tournament id (material-delete, or the demo command with value null). */
export async function removeMaterial(kind,id){
 if(Client.isDemo)return applied(await demoCommand(id,kind,null));
 return applied(await reauth(()=>Client.request('material-delete',{method:'POST',body:{t:id,kind}})));
}

// ---- Thumbnails, guest page, links ----
/** Tournaments whose poster or rules were drawn, for the preview and reader actions (the buttons carry only the id). */
const known=new Map();
function remember(t){if(!t?.id)return;known.set(String(t.id),{id:String(t.id),name:String(t.name??''),poster:t.poster,rules:t.rules});}
const colorStyle=p=>h`--poster:${p.color}`;
/** <img> of the sm file inside a 3:4 frame: lazy, async, intrinsic size against layout shift. */
function smImg(t,p,alt=''){
 const [w,hh]=p.src?[p.w,p.h]:smSize(p.w,p.h);
 return h`<img class="mat-img" src="${posterUrl(t,'sm')}" alt="${alt}" width="${w}" height="${hh}" loading="lazy" decoding="async">`;
}
/** A poster thumbnail in a 3:4 frame that opens the full-screen preview; '' without a poster. cls: size variant (card, row, list). */
export function thumb(t,{cls='',preview=true}={}){
 const p=posterOf(t);if(!p||!posterUrl(t,'sm'))return '';remember(t);
 if(!preview)return h`<span class="mat-thumb ${cls}" style="${colorStyle(p)}" aria-hidden="true">${smImg(t,p)}</span>`;
 return h`<button type="button" class="mat-thumb ${cls}" style="${colorStyle(p)}" data-action="material-preview" data-id="${t.id}" aria-label="${T('Powiększ plakat: {name}',{name:t.name})}">${smImg(t,p)}<span class="mat-thumb-zoom" aria-hidden="true">${icon('expand')}</span></button>`;
}
/** The rules: a PDF as a link that opens in a new tab, typed rules as a button that opens the reader. cls picks the look. */
export function rulesLink(t,{cls='mat-rules-link',label=null}={}){
 const r=rulesOf(t);if(!r||!rulesReadable(t))return '';remember(t);
 if(r.type==='text')return h`<button type="button" class="${cls}" data-action="material-rules" data-id="${t.id}" aria-haspopup="dialog">${icon('file')}<span>${label??rulesLabel(r)}</span></button>`;
 return h`<a class="${cls}" href="${rulesUrl(t)}" target="_blank" rel="noopener" data-mat-open="rules" title="${rulesLabel(r)}">${icon('file')}<span>${label??rulesLabel(r)}</span></a>`;
}
/** Card of a tournament (tournaments page): the thumbnail, for a manager without a poster the quiet "Add poster" tile (unless the
 * account details already say the server takes no posters: before they load the tile shows, like available()), else the trophy. */
export function cardPoster(t,{manager=false}={}){
 const p=posterOf(t);
 if(p&&posterUrl(t,'sm'))return thumb(t,{cls:'mat-card'});
 if(manager&&(!getMe()||limits()?.poster>0))return h`<button type="button" class="mat-thumb mat-card mat-add-tile" data-action="edit-tournament" data-id="${t.id}" data-focus="materials" aria-label="${T('Dodaj plakat: {name}',{name:t.name})}">${icon('image')}<span>${T('Dodaj plakat')}</span></button>`;
 return h`<span class="tournament-symbol">${icon('trophy')}</span>`;
}
/** The guest page's large poster (lg, with sm for small screens) that opens the full-screen preview; '' without a poster. */
export function guestPoster(t){
 const p=posterOf(t);if(!p)return '';const lg=posterUrl(t,'lg');if(!lg)return '';remember(t);
 const [sw]=smSize(p.w,p.h),[lw,lh]=p.src?[p.w,p.h]:lgSize(p.w,p.h);
 const srcset=p.src?'':h` srcset="${posterUrl(t,'sm')} ${sw}w, ${lg} ${lw}w" sizes="(max-width: 650px) 100vw, 340px"`;
 return h`<button type="button" class="mat-hero${p.w>p.h?' is-wide':''}" style="${colorStyle(p)}" data-action="material-preview" data-id="${t.id}" aria-label="${T('Powiększ plakat: {name}',{name:t.name})}"><img class="mat-img" src="${lg}"${srcset} alt="${T('Plakat: {name}',{name:t.name})}" width="${lw}" height="${lh}" decoding="async" fetchpriority="high"><span class="mat-hero-zoom" aria-hidden="true">${icon('expand')}<span>${T('Powiększ')}</span></span></button>`;
}
/** Buttons under the guest page's heading: the rules and "Download the poster"; '' when there is neither. */
export function guestActions(t){
 const r=rulesLink(t,{cls:'btn secondary mat-rules-btn'}),p=posterOf(t),lg=p?posterUrl(t,'lg'):null;
 const download=lg?h`<a class="btn secondary mat-download" href="${lg}" download="${posterFileName(t)}" data-mat-open="poster">${icon('download')}<span>${T('Pobierz plakat')}</span></a>`:'';
 return r||download?h`<div class="mat-actions">${r}${download}</div>`:'';
}

// ---- Dialogs over the page: the poster preview and the rules reader ----
let viewer=null;
/** Shows a modal layer (role dialog, aria-modal, labelled by its heading) with a focus trap; Escape, the close button and a click on
 * the backdrop close it; everything else in the page is inert meanwhile. */
function openLayer(content,{opener,id,action,focus='.mat-viewer-close'}){
 closeLayer(false);
 const root=document.createElement('div');root.className='mat-viewer-root';setHtml(root,content);
 const background=[...document.querySelectorAll('body > *')].filter(el=>!el.inert);
 document.body.append(root);document.body.classList.add('mat-viewer-open');for(const el of background)el.inert=true;
 const dialog=root.querySelector('[role="dialog"]');viewer={root,dialog,opener,background,id:String(id),action};
 root.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeLayer();return;}
  if(event.key==='Tab'){event.stopPropagation();registry.trapTab(event,dialog);}
 });
 root.addEventListener('click',event=>{
  const hit=event.target.closest?.('[data-mat-viewer]'),act=hit?.dataset.matViewer;
  if(act==='close'||act==='backdrop'&&hit===event.target){event.preventDefault();closeLayer();}
 });
 root.querySelector(focus)?.focus({preventScroll:true});
 return root;
}
/** Closes the open layer; focus goes back to the control that opened it (or its twin after a repaint). */
export function closeLayer(refocus=true){
 if(!viewer)return;const {root,opener,background,id,action}=viewer;viewer=null;
 for(const el of background)el.inert=false;
 root.remove();document.body.classList.remove('mat-viewer-open');
 if(!refocus)return;
 const twin=opener?.isConnected?opener:document.querySelector(`[data-action="${action}"][data-id="${CSS.escape(id)}"]`);
 twin?.focus?.({preventScroll:true});
}
export const closePreview=closeLayer;
export const layerOpen=()=>!!viewer;
/** The full-screen preview of tournament t's poster: lg fitted to the screen, "Download the poster" and "Open in full size". */
export function openPreview(t,opener=null){
 const p=posterOf(t),lg=p?posterUrl(t,'lg'):null;if(!lg||typeof document==='undefined')return false;
 const [w,hh]=p.src?[p.w,p.h]:lgSize(p.w,p.h),title=T('Plakat: {name}',{name:t.name});
 openLayer(h`<div class="mat-viewer" role="dialog" aria-modal="true" aria-labelledby="mat-viewer-title" tabindex="-1"><header class="mat-viewer-bar"><h2 id="mat-viewer-title">${title}</h2><button type="button" class="mat-viewer-close" data-mat-viewer="close" aria-label="${T('Zamknij podgląd')}" title="${T('Zamknij podgląd')}">${icon('close')}</button></header><div class="mat-viewer-stage" data-mat-viewer="backdrop" style="${colorStyle(p)}"><img class="mat-img" src="${lg}" alt="${title}" width="${w}" height="${hh}" decoding="async"></div><footer class="mat-viewer-actions"><a class="btn mat-viewer-btn" href="${lg}" download="${posterFileName(t)}" data-mat-open="poster">${icon('download')}<span>${T('Pobierz plakat')}</span></a><a class="btn mat-viewer-btn" href="${lg}" target="_blank" rel="noopener" data-mat-open="poster">${icon('external')}<span>${T('Otwórz w pełnym rozmiarze')}</span></a></footer></div>`,{opener,id:t.id,action:'material-preview'});
 return true;
}
/** The reader of typed rules: a readable sheet (full screen on phones) that loads the text when it opens. */
export function openReader(t,opener=null){
 const r=rulesOf(t);if(!r||r.type!=='text'||typeof document==='undefined')return false;
 const root=openLayer(h`<div class="mat-viewer mat-reader" data-mat-viewer="backdrop"><section class="mat-sheet" role="dialog" aria-modal="true" aria-labelledby="mat-reader-title" tabindex="-1"><header class="mat-sheet-bar"><div class="mat-sheet-title"><span class="mat-sheet-eyebrow">${icon('file')}<span>${T('Regulamin zawodów')}</span></span><h2 id="mat-reader-title">${t.name}</h2></div><button type="button" class="mat-viewer-close mat-sheet-close" data-mat-viewer="close" aria-label="${T('Zamknij regulamin')}" title="${T('Zamknij regulamin')}">${icon('close')}</button></header><div class="mat-sheet-body" data-mat-reader tabindex="0" aria-labelledby="mat-reader-title" aria-busy="true"><p class="mat-sheet-state" role="status">${T('Wczytywanie regulaminu…')}</p></div></section></div>`,{opener,id:t.id,action:opener?.dataset?.action||'material-rules'});
 const body=root.querySelector('[data-mat-reader]'),current=viewer;
 const fill=()=>loadRulesText(t).then(text=>{if(viewer!==current)return;setHtml(body,h`<div class="mat-prose">${renderRules(text)}</div>`);body.removeAttribute('aria-busy');},error=>{
  if(viewer!==current)return;body.removeAttribute('aria-busy');
  setHtml(body,h`<div class="mat-sheet-state" role="alert"><p>${messageOf(error)}</p><button type="button" class="btn secondary" data-mat-retry>${icon('refresh')}<span>${T('Spróbuj ponownie')}</span></button></div>`);
  body.querySelector('[data-mat-retry]')?.addEventListener('click',()=>{body.setAttribute('aria-busy','true');setHtml(body,h`<p class="mat-sheet-state" role="status">${T('Wczytywanie regulaminu…')}</p>`);fill();},{once:true});
 });
 fill();return true;
}

// ---- Opening data: URLs (demo uploads) ----
// Browsers refuse to open data: URLs in a tab; the demo's own files open as blob: documents in a new tab instead (a tab, never an
// <img>: the CSP keeps blob: out of images).
function dataBlob(url){
 const m=/^data:([^;,]+);base64,(.*)$/.exec(url);if(!m)return null;
 const bin=atob(m[2]),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
 return new Blob([bytes],{type:m[1]});
}
function openData(href,download){
 const blob=dataBlob(href);if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;if(download)a.download=download;else{a.target='_blank';a.rel='noopener';}
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}

// ---- The "Materials" section of the tournament dialog ----
/* Controller of the one open tournament dialog: id (null for a new tournament: files wait in queue and go out after tournament.save),
 * ops (running send or removal per kind: {phase,progress,preview,promise}), queue (a prepared poster or a checked PDF that waits or
 * failed), confirm (the kind whose removal asks for confirmation), error and done (messages per kind), mode (the rules' kind chosen in
 * the switch: 'pdf' or 'text') and text (the editor: value, saved text, open, loading, preview). */
let ctl=null,live=null;
const tournamentOf=id=>id?ui()?.getWorkspace?.()?.tournaments?.find(x=>x.id===id)||null:null;
const busy=kind=>!!ctl?.ops[kind];
const fresh=(id,t=null)=>{const r=rulesOf(t);return {id,ops:{poster:null,rules:null},queue:{poster:null,rules:null},confirm:null,error:{poster:'',rules:''},done:{poster:'',rules:''},notice:'',form:null,section:null,mode:r?.type==='text'?'text':'pdf',text:{value:'',saved:r?.text??null,open:false,loading:false,preview:false}};};
/** Reads a message out while the dialog stays (its own live region; the toast would cover the dialog's buttons on a phone). */
function announce(message){
 if(typeof document==='undefined'||!message)return;
 if(!live?.isConnected){live=document.createElement('p');live.className='sr-only';live.setAttribute('role','status');live.setAttribute('aria-live','polite');document.body.append(live);}
 live.textContent='';setTimeout(()=>{if(live)live.textContent=message;},50);
}
function posterBlock(t,lim){
 const op=ctl.ops.poster,queued=ctl.queue.poster,existing=posterOf(t),err=ctl.error.poster,done=ctl.done.poster;
 const off=lim&&lim.poster===0;
 const preview=op?.preview?{src:op.preview,w:op.w,h:op.h,color:op.color}:queued?{src:queued.preview,w:queued.previewW,h:queued.previewH,color:queued.color}:null;
 let frame;
 if(preview)frame=h`<span class="mat-frame" style="--poster:${preview.color}"><img class="mat-img" src="${preview.src}" alt="${T('Podgląd plakatu')}" width="${preview.w}" height="${preview.h}" decoding="async"></span>`;
 else if(existing)frame=h`<span class="mat-frame" style="${colorStyle(existing)}">${smImg(t,existing,T('Plakat: {name}',{name:t.name}))}</span>`;
 else if(off)frame=h`<span class="mat-frame mat-frame-off">${icon('image')}</span>`;
 else frame=h`<button type="button" class="mat-frame mat-pick" data-action="material-pick" data-kind="poster">${icon('image')}<strong>${T('Dodaj plakat')}</strong><small class="mat-drop-hint">${T('albo upuść plik tutaj')}</small></button>`;
 let buttons='';
 if(op)buttons='';
 else if(ctl.confirm==='poster')buttons=h`<span class="mat-confirm-text">${T('Usunąć plakat?')}</span><button type="button" class="btn small-btn mat-danger" data-action="material-remove-confirm" data-kind="poster">${T('Usuń plakat')}</button><button type="button" class="btn small-btn" data-action="material-remove-cancel" data-kind="poster">${T('Anuluj')}</button>`;
 else if(queued&&ctl.id)buttons=h`<button type="button" class="btn small-btn" data-action="material-retry" data-kind="poster">${icon('refresh')}<span>${T('Wyślij ponownie')}</span></button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="poster">${T('Usuń')}</button>`;
 else if(queued||existing)buttons=h`<button type="button" class="btn small-btn" data-action="material-pick" data-kind="poster">${T('Zmień')}</button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="poster">${T('Usuń')}</button>`;
 const note=queued&&!ctl.id?T('Wyślemy go zaraz po utworzeniu turnieju.'):off?T('Ten serwer nie przyjmuje teraz plakatów.'):T('JPG, PNG lub WebP, także zdjęcie z telefonu. Zmniejszymy je i obrócimy automatycznie, bez przycinania.');
 return h`<div class="mat-poster" data-material-drop="poster"><div class="mat-frame-box">${frame}${op?progressHtml('poster',op):''}</div><div class="mat-side"><strong class="mat-label">${T('Plakat')}</strong><p class="mat-note">${note}</p>${buttons?h`<div class="mat-buttons">${buttons}</div>`:''}<p class="mat-error" role="alert" id="mat-error-poster">${err}</p>${done?h`<p class="mat-done">${icon('check')}<span>${done}</span></p>`:''}</div><input type="file" accept="image/*" hidden data-material-input="poster" tabindex="-1"></div>`;
}
const fmt=n=>new Intl.NumberFormat(locale()).format(n);
/** An example of typed rules as the field's placeholder (lines of the formatting guide). */
const PLACEHOLDER=()=>[T('## Zgłoszenia'),T('Zgłoszenia przyjmujemy do 7 listopada.'),'',T('- Ważenie od 7:30'),T('- Start o 9:00')].join('\n');
const countText=n=>T('{n} / {max} znaków',{n:fmt(n),max:fmt(TEXT_MAX)});
/** The text editor of the rules row: field with a character counter, a short formatting guide and a preview toggle. */
function editorHtml(){
 const x=ctl.text,n=textLength(cleanRulesText(x.value)),over=n>TEXT_MAX,op=ctl.ops.rules;
 if(x.loading)return h`<div class="mat-editor"><p class="mat-note" role="status">${T('Wczytywanie regulaminu…')}</p></div>`;
 const save=ctl.id&&!op?h`<button type="button" class="btn small-btn primary mat-text-save" data-action="material-text-save">${T('Zapisz regulamin')}</button>${x.saved!==null?h`<button type="button" class="btn small-btn" data-action="material-text-cancel">${T('Anuluj')}</button>`:''}`:'';
 return h`<div class="mat-editor" data-mat-editor><div class="mat-editor-bar"><label class="mat-editor-label" for="mat-text">${T('Treść regulaminu')}</label><button type="button" class="mat-preview-toggle" data-action="material-text-preview" aria-pressed="${x.preview}" aria-controls="mat-text-preview">${icon(x.preview?'pencil':'eye')}<span>${x.preview?T('Edytuj'):T('Podgląd regulaminu')}</span></button></div><textarea id="mat-text" class="mat-textarea" data-mat-text rows="9" spellcheck="true" aria-describedby="mat-text-count mat-text-help"${x.preview?h` hidden`:''}${op?h` readonly`:''} placeholder="${PLACEHOLDER()}">${x.value}</textarea><div class="mat-prose mat-text-preview" id="mat-text-preview"${x.preview?'':h` hidden`}>${x.preview?(n?renderRules(x.value):h`<p class="mat-note">${T('Wpisz treść, aby zobaczyć podgląd.')}</p>`):''}</div><div class="mat-editor-foot"><p class="mat-help" id="mat-text-help"><code>## </code>${T('nagłówek')} · <code>- </code>${T('punkt')} · <code>1. </code>${T('lista numerowana')} · ${T('pusta linia: nowy akapit')} · <code>https://</code> ${T('link')}</p><span class="mat-count${over?' is-over':''}" id="mat-text-count" data-mat-count>${countText(n)}</span></div>${save?h`<div class="mat-buttons">${save}</div>`:''}</div>`;
}
function rulesBlock(t,lim){
 const op=ctl.ops.rules,queued=ctl.queue.rules,existing=rulesOf(t),err=ctl.error.rules,done=ctl.done.rules,off=lim&&lim.rules===0,mode=ctl.mode,x=ctl.text;
 const max=lim?.rules||DEFAULT_LIMITS.rules,pdfMax=Client.isDemo?Math.min(max,DEMO_RULES_MAX):max;
 const pdfQueued=queued&&queued.type!=='text'?queued:null;
 const editing=mode==='text'&&(x.open||!existing||existing.type!=='text'||!ctl.id);
 const switcher=off?'':h`<div class="mat-switch" role="group" aria-label="${T('Rodzaj regulaminu')}"><button type="button" data-action="material-rules-mode" data-mode="pdf" aria-pressed="${mode==='pdf'}">PDF</button><button type="button" data-action="material-rules-mode" data-mode="text" aria-pressed="${mode==='text'}">${T('Tekst')}</button></div>`;
 let title,note='',buttons='',type='pdf';
 if(mode==='pdf'){
  const shown=op?.file?{size:op.file.size,type:'pdf'}:pdfQueued?{size:pdfQueued.size,type:'pdf'}:existing?.type==='pdf'?existing:null;
  title=shown?rulesLabel(shown):T('Regulamin zawodów');
  note=op?'':pdfQueued&&!ctl.id?T('Wyślemy go zaraz po utworzeniu turnieju.'):pdfQueued?T('Nie wysłano. Spróbuj ponownie.'):existing?.type==='pdf'?T('Otwiera się w nowej karcie.'):existing?.type==='text'?T('Teraz regulamin jest tekstem. Dodany plik PDF go zastąpi.'):off?T('Ten serwer nie przyjmuje teraz regulaminów.'):T('PDF do {size}: regulamin albo komunikat organizacyjny.',{size:formatSize(pdfMax)});
  if(op)buttons='';
  else if(ctl.confirm==='rules')buttons=confirmRules();
  else if(pdfQueued&&ctl.id)buttons=h`<button type="button" class="btn small-btn" data-action="material-retry" data-kind="rules">${icon('refresh')}<span>${T('Wyślij ponownie')}</span></button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="rules">${T('Usuń')}</button>`;
  else if(pdfQueued)buttons=h`<button type="button" class="btn small-btn" data-action="material-pick" data-kind="rules">${T('Zmień')}</button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="rules">${T('Usuń')}</button>`;
  else if(existing?.type==='pdf')buttons=h`${rulesLink(t,{cls:'btn small-btn mat-open',label:T('Otwórz')})}<button type="button" class="btn small-btn" data-action="material-pick" data-kind="rules">${T('Zmień')}</button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="rules">${T('Usuń')}</button>`;
  else if(!off)buttons=h`<button type="button" class="btn small-btn mat-side-pick" data-action="material-pick" data-kind="rules">${icon('plus')}<span>${T('Dodaj regulamin (PDF)')}</span></button>`;
 }else{
  type='text';title=existing?.type==='text'&&!editing?rulesLabel(existing):T('Regulamin zawodów');
  if(!ctl.id)note=T('Zapiszemy go razem z turniejem.');
  else if(editing&&existing?.type==='pdf')note=T('Zapisanie tekstu zastąpi obecny regulamin PDF.');
  else if(!editing)note=T('Tekst, {n} znaków. Otwiera się w czytelnym oknie.',{n:existing.size});
  if(op&&!editing)buttons='';
  else if(ctl.confirm==='rules')buttons=confirmRules();
  else if(!editing)buttons=h`${rulesLink(t,{cls:'btn small-btn mat-open',label:T('Otwórz')})}<button type="button" class="btn small-btn" data-action="material-text-edit">${T('Edytuj')}</button><button type="button" class="btn small-btn" data-action="material-remove" data-kind="rules">${T('Usuń')}</button>`;
 }
 const progress=op?progressHtml('rules',op):'',inEditor=mode==='text'&&editing;
 const has=mode==='pdf'?!!(op?.file||pdfQueued||existing?.type==='pdf'):existing?.type==='text'||!!textLength(x.value);
 return h`<div class="mat-rules${has?' has-file':''} is-${type}" data-material-drop="rules"><span class="mat-doc" aria-hidden="true">${icon('file')}<small>${type==='pdf'?'PDF':T('TEKST')}</small></span><div class="mat-side"><div class="mat-rules-top"><strong class="mat-label">${title}</strong>${switcher}</div>${note?h`<p class="mat-note">${note}</p>`:''}${inEditor?'':progress}${buttons?h`<div class="mat-buttons">${buttons}</div>`:''}<p class="mat-error" role="alert" id="mat-error-rules">${err}</p>${done?h`<p class="mat-done">${icon('check')}<span>${done}</span></p>`:''}</div>${inEditor?h`<div class="mat-editor-box">${editorHtml()}${progress}</div>`:''}<input type="file" accept="application/pdf,.pdf" hidden data-material-input="rules" tabindex="-1"></div>`;
}
const confirmRules=()=>h`<span class="mat-confirm-text">${T('Usunąć regulamin?')}</span><button type="button" class="btn small-btn mat-danger" data-action="material-remove-confirm" data-kind="rules">${T('Usuń regulamin')}</button><button type="button" class="btn small-btn" data-action="material-remove-cancel" data-kind="rules">${T('Anuluj')}</button>`;
const PHASES=()=>({prepare:T('Przygotowuję zdjęcie…'),check:T('Sprawdzam plik…'),upload:T('Wysyłanie…'),save:T('Zapisywanie…'),remove:T('Usuwanie…')});
function progressHtml(kind,op){
 const pct=Math.round(Math.max(0,Math.min(1,op.progress||0))*100),label=kind==='poster'?T('Wysyłanie plakatu'):T('Wysyłanie regulaminu');
 const text=op.phase==='upload'?PHASES().upload+' '+pct+'%':PHASES()[op.phase]||'';
 const determinate=op.phase==='upload';
 return h`<div class="mat-progress${determinate?'':' is-busy'}" data-mat-progress="${kind}"><div class="mat-bar" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100"${determinate?h` aria-valuenow="${pct}"`:''} aria-valuetext="${text}"><span style="--pct:${determinate?pct:100}%"></span></div><small class="mat-progress-text">${text}</small></div>`;
}
/** Whether the tournament dialog shows the section: always in the demo; on a server whose me says nothing about materials (an older
 * server) never; while me is still loading it is shown (the server checks every write). */
export const available=()=>Client.isDemo||!getMe()||!!limits();
function sectionBody(t){
 const lim=limits();
 return h`<section class="mat-section" id="tournament-materials" data-materials aria-labelledby="mat-title" tabindex="-1"><div class="mat-head"><h3 id="mat-title">${T('Materiały')}</h3><p>${T('Plakat i regulamin zobaczą goście, zawodnicy i kluby na stronie turnieju.')}</p></div>${ctl.notice?h`<div class="notice mat-notice" role="alert">${icon('alert')}<p>${ctl.notice}</p></div>`:''}<div class="mat-grid">${posterBlock(t||{},lim)}${rulesBlock(t||{},lim)}</div></section>`;
}
/** The "Materials" section (SafeHtml) of a tournament dialog that opens now for t (null: a new tournament); '' when the server has
 * none. A dialog opened again while a send of the same tournament still runs keeps showing that send. */
export function sectionHtml(t){
 if(!available())return h``;
 const id=t?.id??null;
 if(!(ctl&&id&&ctl.id===id&&(ctl.ops.poster||ctl.ops.rules)))ctl=fresh(id,t);
 return sectionBody(t);
}
/** Starts the controller for the open tournament dialog (after the modal is in the page). */
export function mount(form){
 const section=form?.querySelector('[data-materials]');if(!section){ctl=null;return;}
 const id=form.dataset.id||null;if(!ctl||ctl.id!==id)ctl=fresh(id,tournamentOf(id));
 ctl.form=form;ctl.section=section;
 if(!Client.isDemo&&!getMe())loadMe().then(()=>{if(ctl?.section?.isConnected)repaint();});
}
/** Draws the section again from the workspace and the controller, keeping the keyboard focus on the same control. */
function repaint(c=ctl){
 if(!c?.section||c!==ctl)return;
 const section=c.section,t=tournamentOf(c.id),field=section.querySelector('[data-mat-text]'),caret=field&&document.activeElement===field?[field.selectionStart,field.selectionEnd]:null;
 const next=()=>{const box=document.createElement('div');setHtml(box,sectionBody(t));const drawn=box.firstElementChild;if(!drawn)return;section.replaceChildren(...drawn.childNodes);};
 const twin=registry.keepFocus(section,next,{fallback:place=>place?.querySelector('[data-action="material-pick"],[data-action="material-remove"],[data-action="material-text-edit"],.mat-label')});
 if(caret&&twin?.matches?.('[data-mat-text]'))try{twin.setSelectionRange(caret[0],caret[1]);}catch{}
}
/** Scrolls the section into view and focuses its first control (the card's "Add poster" tile opens the dialog here). */
export function focusSection(){
 const s=document.querySelector('#tournament-materials');if(!s)return;
 try{s.scrollIntoView({block:'center'});}catch{}
 (s.querySelector('[data-action="material-pick"][data-kind="poster"]')||s)?.focus({preventScroll:true});
}
/** The typed rules waiting in the editor: their text when the switch is on "Text" and something new was typed, else null. */
function pendingText(c=ctl){
 if(!c||c.mode!=='text')return null;
 const field=c.section?.querySelector('[data-mat-text]');if(field)c.text.value=field.value;
 const text=cleanRulesText(c.text.value);if(!text)return null;
 return text===cleanRulesText(c.text.saved??'')&&c.id?null:text;
}
/** Whether a new tournament has files or typed rules waiting for its id. */
export const queued=form=>!!ctl&&ctl.form===form&&(!!ctl.queue.poster||!!ctl.queue.rules||!!pendingText());
/** Before the dialog's form saves: running sends end first (the form then saves at the revision they left); typed rules not saved yet
 * are saved now in an existing tournament. Throws (the form shows the message) when they cannot be. */
export async function settled(form){
 if(!ctl||ctl.form!==form)return;
 await Promise.allSettled(KINDS.map(k=>ctl.ops[k]?.promise).filter(Boolean));
 if(ctl.id&&pendingText()!==null&&!await saveText())throw failure(ctl.error.rules||T('Nie udało się zapisać materiału. Spróbuj ponownie.'));
}
/** After tournament.save of a new tournament: sends the waiting poster, then the rules (the PDF or the typed text chosen in the
 * switch); true when every one arrived. */
export async function flush(form,id){
 if(!ctl||ctl.form!==form)return true;
 const c=ctl,text=pendingText(c);c.id=id;
 if(c.mode==='text')c.queue.rules=text?{type:'text',text}:null;else if(c.queue.rules?.type==='text')c.queue.rules=null;
 let ok=true;
 for(const kind of KINDS){const item=c.queue[kind];if(!item)continue;if(!await run(kind,item))ok=false;}
 if(!ok){c.notice=T('Turniej jest już utworzony. Nie wszystkie materiały udało się wysłać: spróbuj ponownie poniżej albo później w ustawieniach turnieju.');repaint(c);}
 return ok;
}
/** Sends one item (a prepared poster, a checked PDF or typed rules) of the controller's tournament with the progress bar; true on
 * success. A failed file waits in the queue for "Send again"; failed text stays in the editor. */
async function run(kind,item){
 const c=ctl,id=c.id,text=item?.type==='text';
 const op={phase:text?'save':'upload',progress:0,text,preview:kind==='poster'?item.preview:null,w:item.previewW,h:item.previewH,color:item.color,file:kind==='rules'&&!text?item:null};
 c.ops[kind]=op;c.error[kind]='';c.done[kind]='';c.confirm=null;c.notice='';repaint(c);
 let resolve;op.promise=new Promise(r=>{resolve=r;});
 try{
  await sendMaterial(kind,id,item,{onProgress:p=>{op.progress=p;if(p>=1)op.phase='save';progressPaint(c,kind,op);}});
  c.queue[kind]=null;c.done[kind]=kind==='poster'?T('Plakat zapisany.'):T('Regulamin zapisany.');
  if(text){c.text.saved=item.text;c.text.value=item.text;c.text.open=false;c.text.preview=false;}
  afterWrite(c,c.done[kind]);
  return true;
 }catch(error){
  if(error?.status===401&&error?.code!=='reauth'||error?.status===402){c.ops[kind]=null;resolve();await ui()?.handleError?.(error);return false;}
  c.error[kind]=messageOf(error);if(c.id&&!text)c.queue[kind]=item;
  return false;
 }finally{c.ops[kind]=null;resolve();repaint(c);}
}
/** Updates only the progress bar (no repaint: the focus and the screen reader stay where they are). */
function progressPaint(c,kind,op){
 const box=c?.section?.querySelector(`[data-mat-progress="${kind}"]`);if(!box)return;
 const tmp=document.createElement('div');setHtml(tmp,progressHtml(kind,op));const next=tmp.firstElementChild;if(next)box.replaceWith(next);
}
/** After a write: the dialog's revision follows the new workspace (its next save is not stale) and the page behind is drawn again.
 * The result is read out in the dialog, or shown as a toast when the dialog was closed meanwhile. A dialog of the same tournament
 * opened again in the meantime shows the new state. */
function afterWrite(c,message){
 const ws=ui()?.getWorkspace?.();
 const follow=x=>{if(ws&&x?.form?.isConnected)for(const el of [x.form,x.form.closest('.modal')])if(el)el.dataset.revision=ws.revision;};
 follow(c);ui()?.render?.();
 if(ctl&&ctl!==c&&ctl.id===c.id&&ctl.section?.isConnected){follow(ctl);repaint(ctl);}
 if(c.form?.isConnected||ctl?.section?.isConnected&&ctl.id===c.id)announce(message);else ui()?.toast?.(message);
}
/** A file chosen, dropped or pasted for kind: checked (and prepared) first, then sent, or queued for a new tournament. A PDF moves the
 * rules switch to "PDF". */
export async function take(kind,file){
 if(!ctl?.section||!KINDS.includes(kind))return;
 const c=ctl;
 if(busy(kind)){c.error[kind]=T('Poczekaj, aż skończy się poprzednie wysyłanie.');repaint(c);return;}
 const lim=limits()||DEFAULT_LIMITS;
 if(kind==='rules')c.mode='pdf';
 c.error[kind]='';c.done[kind]='';c.confirm=null;c.notice='';
 const op={phase:kind==='poster'?'prepare':'check',progress:0,preview:null};let resolve;op.promise=new Promise(r=>{resolve=r;});
 c.ops[kind]=op;repaint(c);
 let item;
 try{
  if(kind==='poster'){if(!(lim.poster>0))throw failure(T('Ten serwer nie przyjmuje teraz plakatów.'));item=await preparePoster(file,{max:lim.poster});}
  else{
   if(!(lim.rules>0))throw failure(T('Ten serwer nie przyjmuje teraz regulaminów.'));
   await checkRules(file,Client.isDemo?Math.min(lim.rules,DEMO_RULES_MAX):lim.rules);item=file;
  }
 }catch(error){c.ops[kind]=null;resolve();c.error[kind]=messageOf(error);repaint(c);showError(c,kind);return;}
 c.ops[kind]=null;resolve();
 if(!c.id){c.queue[kind]=item;repaint(c);return;}
 if(!await run(kind,item))showError(c,kind);
}
/** Saves the typed rules of the editor; true on success. Checks the length first (1 to 20 000 characters). */
async function saveText(){
 const c=ctl;if(!c?.id||busy('rules'))return false;
 const field=c.section?.querySelector('[data-mat-text]');if(field)c.text.value=field.value;
 const text=cleanRulesText(c.text.value),n=textLength(text);
 if(!n){c.error.rules=T('Wpisz treść regulaminu.');repaint(c);showError(c,'rules');return false;}
 if(n>TEXT_MAX){c.error.rules=T('Regulamin może mieć najwyżej {max} znaków (teraz {n}).',{max:fmt(TEXT_MAX),n:fmt(n)});repaint(c);showError(c,'rules');return false;}
 if(!(limits()||DEFAULT_LIMITS).rules){c.error.rules=T('Ten serwer nie przyjmuje teraz regulaminów.');repaint(c);return false;}
 const ok=await run('rules',{type:'text',text});if(!ok)showError(c,'rules');return ok;
}
/** Opens the editor for the saved typed rules (their text is read first on the server). */
async function editText(){
 const c=ctl;if(!c)return;const t=tournamentOf(c.id);
 c.text.open=true;c.text.preview=false;c.error.rules='';c.done.rules='';
 if(c.text.saved===null){
  c.text.loading=true;repaint(c);
  try{const text=await loadRulesText(t);c.text.saved=text;c.text.value=text;}catch(error){c.error.rules=messageOf(error);c.text.open=false;}
  c.text.loading=false;
 }else c.text.value=c.text.saved;
 repaint(c);c.section?.querySelector('[data-mat-text]')?.focus();
}
/** After a failure the message is read out (role=alert) and stays next to the controls; nothing steals the focus. */
function showError(c,kind){try{c?.section?.querySelector('#mat-error-'+kind)?.scrollIntoView?.({block:'nearest'});}catch{}}
/** Removes kind: a waiting file only leaves the queue (nothing changes on the server); a saved one is removed after the confirmation. */
async function remove(kind){
 const c=ctl;if(!c||busy(kind))return;
 c.confirm=null;c.error[kind]='';c.done[kind]='';
 if(c.queue[kind]){c.queue[kind]=null;repaint(c);return;}
 const op={phase:'remove',progress:0,text:kind==='rules'&&c.mode==='text'};let resolve;op.promise=new Promise(r=>{resolve=r;});c.ops[kind]=op;repaint(c);
 try{
  await removeMaterial(kind,c.id);c.done[kind]=kind==='poster'?T('Plakat usunięty.'):T('Regulamin usunięty.');
  if(kind==='rules')Object.assign(c.text,{value:'',saved:null,open:false,preview:false});
  afterWrite(c,c.done[kind]);
 }catch(error){if(error?.status===401&&error?.code!=='reauth'||error?.status===402){c.ops[kind]=null;resolve();await ui()?.handleError?.(error);return;}c.error[kind]=messageOf(error);}
 finally{c.ops[kind]=null;resolve();repaint(c);}
}
const looksImage=file=>String(file?.type||'').startsWith('image/')||!file?.type&&/\.(?:jpe?g|png|webp|heic|heif|avif|gif|bmp)$/i.test(String(file?.name||''));
/** Where a dropped or pasted file goes: a picture to the poster wherever it lands, a PDF to the rules (on the poster tile it gets the
 * message that PDF posters are not supported yet), anything else to the zone it landed on (whose check explains the refusal). */
export function kindFor(file,zone=null){
 if(looksPdf(file))return zone==='poster'?'poster':'rules';
 if(looksImage(file))return 'poster';
 return zone==='rules'?'rules':'poster';
}
function route(files,zone){for(const file of files)take(kindFor(file,zone),file);}

// ---- Events ----
registry.registerAction('material-preview',(el,id)=>{const t=known.get(String(id));if(t)openPreview(t,el);},{public:true});
registry.registerAction('material-rules',(el,id)=>{const t=known.get(String(id));if(t)openReader(t,el);},{public:true});
registry.registerAction('material-pick',el=>{
 if(!ctl?.section)return;const kind=el.dataset.kind;if(!KINDS.includes(kind)||busy(kind))return;
 const input=ctl.section.querySelector(`[data-material-input="${kind}"]`);input?.click();
});
registry.registerAction('material-remove',el=>{
 const kind=el.dataset.kind;if(!ctl||!KINDS.includes(kind)||busy(kind))return;
 if(ctl.queue[kind]&&!(kind==='rules'&&ctl.mode==='text')){remove(kind);return;}
 ctl.confirm=kind;ctl.error[kind]='';ctl.done[kind]='';repaint();ctl.section?.querySelector(`[data-action="material-remove-confirm"][data-kind="${kind}"]`)?.focus();
});
registry.registerAction('material-remove-confirm',el=>remove(el.dataset.kind));
registry.registerAction('material-remove-cancel',el=>{const kind=el.dataset.kind;if(!ctl)return;ctl.confirm=null;repaint();ctl.section?.querySelector(`[data-action="material-remove"][data-kind="${kind}"]`)?.focus();});
registry.registerAction('material-retry',el=>{const kind=el.dataset.kind,c=ctl,item=c?.queue[kind];if(item&&c.id&&!busy(kind))run(kind,item).then(ok=>{if(!ok)showError(c,kind);});});
registry.registerAction('material-rules-mode',el=>{
 const mode=el.dataset.mode;if(!ctl||!['pdf','text'].includes(mode)||ctl.mode===mode||busy('rules'))return;
 if(mode==='pdf'){const field=ctl.section?.querySelector('[data-mat-text]');if(field)ctl.text.value=field.value;}
 ctl.mode=mode;ctl.confirm=null;ctl.error.rules='';ctl.done.rules='';
 if(mode==='text'&&rulesOf(tournamentOf(ctl.id))?.type!=='text')ctl.text.open=true;
 repaint();
});
registry.registerAction('material-text-edit',()=>editText());
registry.registerAction('material-text-save',()=>saveText());
registry.registerAction('material-text-cancel',()=>{if(!ctl)return;Object.assign(ctl.text,{value:ctl.text.saved??'',open:false,preview:false});ctl.error.rules='';repaint();ctl.section?.querySelector('[data-action="material-text-edit"]')?.focus();});
registry.registerAction('material-text-preview',()=>{
 if(!ctl)return;const field=ctl.section?.querySelector('[data-mat-text]');if(field)ctl.text.value=field.value;
 ctl.text.preview=!ctl.text.preview;repaint();ctl.section?.querySelector('[data-action="material-text-preview"]')?.focus();
});

if(typeof document!=='undefined'){
 document.addEventListener('change',event=>{
  const input=event.target.closest?.('[data-material-input]');if(!input||!ctl?.section?.contains(input))return;
  const file=input.files?.[0],kind=input.dataset.materialInput;input.value='';if(file)take(kind,file);
 });
 // Typing in the rules field: the value is kept and the counter follows (the field itself is never redrawn while typing).
 document.addEventListener('input',event=>{
  const field=event.target;if(!field?.matches?.('[data-mat-text]')||!ctl?.section?.contains(field))return;
  ctl.text.value=field.value;const n=textLength(cleanRulesText(field.value)),count=ctl.section.querySelector('[data-mat-count]');
  if(count){count.textContent=countText(n);count.classList.toggle('is-over',n>TEXT_MAX);}
  if(ctl.error.rules){ctl.error.rules='';const box=ctl.section.querySelector('#mat-error-rules');if(box)box.textContent='';}
 });
 // Drag and drop on the section (desktop): the zone under the pointer lights up; a file dropped elsewhere in the dialog is ignored
 // instead of replacing the page with it.
 const zoneOf=event=>event.target.closest?.('[data-material-drop]')||null;
 const hasFiles=event=>[...(event.dataTransfer?.types||[])].includes('Files');
 let lit=null;const light=zone=>{if(lit===zone)return;lit?.classList.remove('is-drop');lit=zone;lit?.classList.add('is-drop');};
 document.addEventListener('dragover',event=>{
  if(!ctl?.section?.isConnected||!hasFiles(event))return;event.preventDefault();
  const zone=zoneOf(event),inside=ctl.section.contains(event.target);
  event.dataTransfer.dropEffect=zone||inside?'copy':'none';light(zone&&ctl.section.contains(zone)?zone:null);
 });
 document.addEventListener('dragleave',event=>{if(lit&&!lit.contains(event.relatedTarget))light(null);});
 document.addEventListener('drop',event=>{
  if(!ctl?.section?.isConnected||!hasFiles(event))return;event.preventDefault();light(null);
  if(!ctl.section.contains(event.target))return;
  route([...(event.dataTransfer.files||[])].slice(0,2),zoneOf(event)?.dataset.materialDrop||null);
 });
 // Pasting a picture (or a PDF) adds it only inside the materials section and never into a text field: "Copy image" puts the file
 // next to text/html, so a paste into the tournament name must not replace the poster.
 document.addEventListener('paste',event=>{
  if(!ctl?.section?.isConnected)return;const files=[...(event.clipboardData?.files||[])];if(!files.length)return;
  const target=event.target instanceof Element?event.target:null;
  if(!target||!ctl.section.contains(target)||target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
  if(event.clipboardData.getData('text/plain'))return;
  event.preventDefault();route(files.slice(0,2),null);
 });
 // A picture that cannot be loaded (removed meanwhile, offline) leaves the frame in the poster colour with an icon.
 document.addEventListener('error',event=>{const img=event.target;if(img?.classList?.contains('mat-img'))img.closest('.mat-thumb,.mat-frame,.mat-hero,.mat-viewer-stage')?.classList.add('is-broken');},true);
 document.addEventListener('click',event=>{
  const a=event.target.closest?.('a[data-mat-open]');if(!a)return;const href=a.getAttribute('href')||'';
  if(href.startsWith('data:')){event.preventDefault();openData(href,a.getAttribute('download'));}
 });
 // A send still running when the dialog closes finishes in the background and reports with a toast; signing out forgets it all.
 registry.on('logout',()=>{ctl=null;texts.clear();closeLayer(false);});
}
