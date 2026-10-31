/* Profile photo crop dialog (plan §7.5, research 05 §10.5), loaded with account-flow.js.
 * The file (JPG, PNG or WebP, at most 8 MB) is decoded with createImageBitmap and drawn on a 280 px canvas under a round mask; it is
 * moved by dragging, with the arrow keys (4 px, Shift 20 px) or the arrow buttons, zoomed with the slider, the +/- buttons, the
 * keys + and - or the wheel; "Centre" resets the offset. 36 and 96 px previews are canvases too. No URL.createObjectURL and no
 * blob: URLs (the CSP allows img-src 'self' data: only). Result: a 256x256 WebP (0.86) or, without WebP, JPEG (0.88) blob for
 * avatar-upload, a small PNG data: URL for the preview and, on request (demo), a data: URL of at most 30 KB.
 * The geometry is a set of pure functions (tests/account-ui.test.mjs). Templates use h`…` and the ui.modal helper only. */
import {registry,h} from './registry.js';
import {t as T,translateMessage} from './i18n.js';

export const VIEW=280,OUT=256,PREVIEWS=[96,36],MAX_FILE=8*1024*1024,TYPES=['image/jpeg','image/png','image/webp'],ZOOM_MAX=4,STEP=4,BIG_STEP=20,DEMO_MAX=30*1024;
/** Scale at zoom 1: the shorter side fills the view. */
export const coverScale=(w,h,view=VIEW)=>view/Math.min(w,h);
/** The offset (x, y: image centre from the view centre, in view pixels) clamped so that the image always covers the whole view. */
export function clampOffset({w,h,zoom,x,y},view=VIEW){
 const s=coverScale(w,h,view)*zoom,mx=Math.max(0,(w*s-view)/2),my=Math.max(0,(h*s-view)/2);
 return {x:Math.min(mx,Math.max(-mx,x||0))||0,y:Math.min(my,Math.max(-my,y||0))||0};
}
/** The square of the image (in image pixels) that the view shows: what the output canvas draws. */
export function sourceRect({w,h,zoom,x,y},view=VIEW){const s=coverScale(w,h,view)*zoom,size=view/s;return {sx:w/2-x/s-size/2,sy:h/2-y/s-size/2,size};}
/** Zoom between 1 and ZOOM_MAX keeping the point under the view centre in place. */
export function zoomTo(state,zoom,view=VIEW){
 const z=Math.min(ZOOM_MAX,Math.max(1,Number(zoom)||1)),r=z/state.zoom;
 return {...state,zoom:z,...clampOffset({...state,zoom:z,x:state.x*r,y:state.y*r},view)};
}
/** Moves the image by (dx, dy) view pixels, clamped. */
export const pan=(state,dx,dy,view=VIEW)=>({...state,...clampOffset({...state,x:state.x+dx,y:state.y+dy},view)});
/** Throws the message shown for a file that cannot be used (type by MIME, size up to 8 MB). */
export function checkFile(file){
 if(!file||!TYPES.includes(file.type))throw new Error('To nie jest obraz JPG, PNG ani WebP.');
 if(!(file.size<=MAX_FILE))throw new Error('Plik jest za duży (maks. 8 MB).');
 return true;
}

const toBlob=(canvas,type,quality)=>new Promise(resolve=>{try{canvas.toBlob(blob=>resolve(blob),type,quality);}catch{resolve(null);}});
function drawCrop(ctx,bitmap,st,size){
 const s=coverScale(st.w,st.h,VIEW)*st.zoom*size/VIEW,dx=size/2-st.w*s/2+st.x*size/VIEW,dy=size/2-st.h*s/2+st.y*size/VIEW;
 ctx.clearRect(0,0,size,size);ctx.fillStyle='#eaf3fb';ctx.fillRect(0,0,size,size);
 ctx.imageSmoothingQuality='high';ctx.drawImage(bitmap,dx,dy,st.w*s,st.h*s);
}
/** Output canvas of n x n pixels with the cropped square. */
function output(bitmap,st,n){
 const c=document.createElement('canvas');c.width=c.height=n;const g=c.getContext('2d');const r=sourceRect(st);
 g.imageSmoothingQuality='high';g.drawImage(bitmap,r.sx,r.sy,r.size,r.size,0,0,n,n);return c;
}
/** A data: URL of at most DEMO_MAX characters (demo mode keeps the photo in localStorage). */
function smallDataUrl(bitmap,st){
 for(const n of [256,192,128,96])for(const q of [0.8,0.65,0.5]){
  const c=output(bitmap,st,n);let url=c.toDataURL('image/webp',q);if(!url.startsWith('data:image/webp'))url=c.toDataURL('image/jpeg',q);
  if(url.length<=DEMO_MAX)return url;
 }
 return null;
}

/**
 * Opens the crop dialog for a file. onSave({blob,type,preview,dataUrl}) runs on "Save photo" (it may upload; a thrown error is
 * shown in the dialog). options.dataUrl asks for the small data: URL as well. Throws for an unusable file before any dialog.
 */
export async function openCrop(file,{onSave,dataUrl=false}={}){
 checkFile(file);
 let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw new Error('To nie jest obraz JPG, PNG ani WebP.');}
 if(!bitmap.width||!bitmap.height)throw new Error('To nie jest obraz JPG, PNG ani WebP.');
 const ui=registry.use('ui'),icon=(n,c='')=>ui.icon(n,c);
 let st={w:bitmap.width,h:bitmap.height,zoom:1,x:0,y:0},drag=null,busy=false;
 const arrow=(dir,label,name,cls='')=>h`<button type="button" class="acct-crop-btn ${cls}" data-crop="${dir}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
 ui.modal(T('Kadrowanie zdjęcia'),h`<div class="acct-crop"><p class="modal-lead">${T('Przeciągnij zdjęcie albo użyj strzałek. Okrąg pokazuje, co zobaczą inni.')}</p>
<div class="acct-crop-stage"><canvas class="acct-crop-canvas" width="${VIEW}" height="${VIEW}" tabindex="0" role="img" aria-label="${T('Kadr zdjęcia. Strzałki przesuwają zdjęcie, plus i minus zmieniają powiększenie.')}"></canvas></div>
<div class="acct-crop-zoom">${arrow('out',T('Pomniejsz'),'zoom-out')}<label class="acct-crop-range"><span>${T('Powiększenie')}</span><input type="range" min="1" max="${ZOOM_MAX}" step="0.01" value="1" data-crop="zoom"></label>${arrow('in',T('Powiększ'),'zoom-in')}</div>
<div class="acct-crop-pan" role="group" aria-label="${T('Przesuń zdjęcie')}">${arrow('left',T('W lewo'),'left')}${arrow('up',T('W górę'),'down','up')}<button type="button" class="btn small-btn" data-crop="center">${T('Wyśrodkuj')}</button>${arrow('down',T('W dół'),'down')}${arrow('right',T('W prawo'),'right')}</div>
<div class="acct-crop-previews" aria-hidden="true"><canvas class="acct-crop-preview" width="96" height="96"></canvas><canvas class="acct-crop-preview" width="36" height="36"></canvas></div>
<p class="form-error" role="alert"></p></div>`,h`${ui.button(T('Anuluj'),'close-modal')}<button type="button" class="btn primary" data-crop="save">${T('Zapisz zdjęcie')}</button>`);
 const root=document.querySelector('#modal-root .modal'),box=root?.querySelector('.acct-crop');if(!box)return;
 const canvas=box.querySelector('.acct-crop-canvas'),ctx=canvas.getContext('2d'),range=box.querySelector('[data-crop="zoom"]'),errorBox=box.querySelector('.form-error');
 const previews=[...box.querySelectorAll('.acct-crop-preview')].map(c=>[c,c.getContext('2d')]);
 const ratio=Math.min(2,Math.max(1,globalThis.devicePixelRatio||1));canvas.width=canvas.height=Math.round(VIEW*ratio);
 function draw(){
  const size=canvas.width;drawCrop(ctx,bitmap,st,size);
  ctx.save();ctx.fillStyle='rgba(16,36,71,.55)';ctx.beginPath();ctx.rect(0,0,size,size);ctx.arc(size/2,size/2,size/2-1,0,Math.PI*2,true);ctx.fill('evenodd');
  ctx.strokeStyle='#ffffff';ctx.lineWidth=2*ratio;ctx.beginPath();ctx.arc(size/2,size/2,size/2-ratio,0,Math.PI*2);ctx.stroke();ctx.restore();
  for(const [c,g] of previews){g.save();g.beginPath();g.arc(c.width/2,c.height/2,c.width/2,0,Math.PI*2);g.clip();drawCrop(g,bitmap,st,c.width);g.restore();}
  range.value=String(st.zoom);
 }
 const set=next=>{st=next;draw();};
 const move=(dx,dy)=>set(pan(st,dx,dy));
 canvas.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,id:event.pointerId};try{canvas.setPointerCapture(event.pointerId);}catch{}canvas.classList.add('dragging');});
 canvas.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const k=VIEW/canvas.getBoundingClientRect().width;move((event.clientX-drag.x)*k,(event.clientY-drag.y)*k);drag.x=event.clientX;drag.y=event.clientY;});
 const end=()=>{drag=null;canvas.classList.remove('dragging');};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
 canvas.addEventListener('wheel',event=>{event.preventDefault();set(zoomTo(st,st.zoom*(event.deltaY<0?1.08:1/1.08)));},{passive:false});
 canvas.addEventListener('keydown',event=>{
  const d=event.shiftKey?BIG_STEP:STEP,keys={ArrowLeft:[-d,0],ArrowRight:[d,0],ArrowUp:[0,-d],ArrowDown:[0,d]};
  if(keys[event.key]){event.preventDefault();move(...keys[event.key]);}
  else if(event.key==='+'||event.key==='='){event.preventDefault();set(zoomTo(st,st.zoom+0.1));}
  else if(event.key==='-'||event.key==='_'){event.preventDefault();set(zoomTo(st,st.zoom-0.1));}
  else if(event.key==='0'){event.preventDefault();set({...st,x:0,y:0});}
 });
 range.addEventListener('input',()=>set(zoomTo(st,Number(range.value))));
 root.addEventListener('click',async event=>{
  const b=event.target.closest?.('[data-crop]');if(!b||b===range)return;const act=b.dataset.crop;
  if(act==='in')set(zoomTo(st,st.zoom+0.2));else if(act==='out')set(zoomTo(st,st.zoom-0.2));else if(act==='center')set({...st,x:0,y:0});
  else if(act==='left')move(-BIG_STEP,0);else if(act==='right')move(BIG_STEP,0);else if(act==='up')move(0,-BIG_STEP);else if(act==='down')move(0,BIG_STEP);
  else if(act==='save'&&!busy){
   busy=true;b.disabled=true;errorBox.textContent='';
   try{
    const c=output(bitmap,st,OUT);let blob=await toBlob(c,'image/webp',0.86);if(!blob||blob.type!=='image/webp')blob=await toBlob(c,'image/jpeg',0.88);
    if(!blob)throw new Error('Nie udało się wysłać zdjęcia. Spróbuj ponownie.');
    const preview=output(bitmap,st,96).toDataURL('image/png');
    await onSave?.({blob,type:blob.type,preview,dataUrl:dataUrl?smallDataUrl(bitmap,st):null});
    try{bitmap.close?.();}catch{}ui.closeModal();
   }catch(error){errorBox.textContent=translateMessage(String(error?.message||''))||T('Nie udało się wysłać zdjęcia. Spróbuj ponownie.');}
   finally{busy=false;if(b.isConnected)b.disabled=false;}
  }
 });
 draw();canvas.focus({preventScroll:true});
}
