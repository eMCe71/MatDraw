/* Promotional content shown to guests. Replace these objects to change the copy; no other code changes are needed.
 * Text follows the gettext rule of the app: the Polish text is the key, its English version goes to i18n-en.js
 * (tests/i18n.test.mjs fails for any text here without an English entry). Icons are names from icons.js.
 * No external links, images, scripts or tracking: the page CSP allows only the app's own files. */

/** Advertisement shown after a guest picks a tournament from "Upcoming tournaments". Closing it opens the guest preview.
 * KYORUVO is an invented brand; it does not refer to any real company. The photo is a generated image (dist/promo/);
 * its warm colours deliberately differ from the MatBravo blues so the ad reads as a separate brand. */
export const AD={
 kind:'advertisement',
 label:'Reklama',
 brand:'KYORUVO',
 eyebrow:'Sprzęt do taekwondo',
 headline:'Sprzęt, który wytrzyma cały sezon.',
 text:'Doboki, rękawice i ochraniacze dla zawodników, trenerów i całych sekcji — od pierwszego treningu po finał.',
 image:{src:'./promo/kyoruvo-storefront-1200.webp',small:'./promo/kyoruvo-storefront-720.webp',width:1200,height:800,
  alt:'Witryna sklepu KYORUVO z dobokami, pasami, kaskami i rękawicami, widziana z ulicy'},
 products:[
  {icon:'dobok',title:'Doboki',text:'Lekkie, przewiewne, z haftem klubu'},
  {icon:'glove',title:'Rękawice',text:'Otwarte i zamknięte, od rozmiarów dziecięcych'},
  {icon:'foot',title:'Ochraniacze stóp i goleni',text:'Lekka pianka, pewne zapięcie'},
  {icon:'helmet',title:'Kaski',text:'Regulowane, z wentylacją'}
 ],
 offer:'Pakiety klubowe: jedno zamówienie dla całej sekcji',
 cta:'Sklep online wkrótce',
 disclaimer:'Przykładowa reklama. Marka KYORUVO i jej oferta są fikcyjne.'
};

/** Encouragement in the guest preview (access card). The top-level texts are the shown ones; account-boot.js picks the variant at
 * run time from public-config (plan §6.10: kind 'login' without sign-up, 'paid' with sign-up and payments, 'free' with sign-up
 * without payments) through setAccessKind(). Every text, the variants included, needs an English entry (tests/i18n.test.mjs). */
export const ACCESS={
 kind:'login',
 eyebrow:'Więcej po zalogowaniu',
 title:'Zobacz turniej w pełnej wersji',
 text:'W podglądzie gościa zawodnicy są oznaczeni inicjałami. Po zalogowaniu zobaczysz dane zgodne z uprawnieniami Twojego konta.',
 benefits:['Pełne imiona i nazwiska zawodników','Zgłoszenia i kontrola startowa','Wyniki walk, wydruki i ekran hali'],
 cta:'Zaloguj się',
 note:'Konto zakłada Administrator turnieju.',
 // The note of 'paid' carries the monthly price ({price}, formatted for the interface language by account-boot.js).
 variants:{
  paid:{eyebrow:'Konto MatBravo',title:'Dołącz do rozmowy o turnieju',
   text:'Załóż konto, aby pisać na czacie turnieju i widzieć, kto rozmawia. Konta klubów nadal zakłada Administrator turnieju.',
   benefits:['Pisanie we wszystkich czatach','Pełne profile uczestników','Czaty turniejów'],cta:'Załóż konto',note:'{price} / mies. · anulujesz w dowolnym momencie'},
  free:{eyebrow:'Konto MatBravo',title:'Dołącz do rozmowy o turnieju',
   text:'Załóż konto, aby pisać na czacie turnieju i widzieć, kto rozmawia. Konta klubów nadal zakłada Administrator turnieju.',
   benefits:['Pisanie we wszystkich czatach','Pełne profile uczestników','Czaty turniejów'],cta:'Załóż konto',note:'Rejestracja zajmuje około minuty.'}
 }
};
const FIELDS=['eyebrow','title','text','benefits','cta','note'],INITIAL=Object.fromEntries(FIELDS.map(k=>[k,ACCESS[k]]));
/** Switches the access card to kind 'login' | 'paid' | 'free' (unknown kinds give 'login'). options.price() returns the formatted
 * monthly price for the current language and options.translate is T(); the note of 'paid' is then computed when it is read, so
 * a language switch shows the right price (the computed note is final text: T() of it changes nothing). Without a price the
 * note of 'free' is shown: the card still offers a sign-up. */
export function setAccessKind(kind,{price,translate}={}){
 const variant=kind==='paid'||kind==='free'?ACCESS.variants[kind]:INITIAL;
 ACCESS.kind=variant===INITIAL?'login':kind;
 for(const k of FIELDS)if(k!=='note')ACCESS[k]=variant[k];
 const label=typeof price==='function'&&ACCESS.kind==='paid'?price:null,fill=(text,p)=>translate?translate(text,{price:p}):text.replace('{price}',p);
 delete ACCESS.note;
 Object.defineProperty(ACCESS,'note',label?{configurable:true,enumerable:true,get:()=>{const p=label();return p?fill(variant.note,p):ACCESS.variants.free.note;}}:{configurable:true,enumerable:true,writable:true,value:variant.note});
 return ACCESS.kind;
}
