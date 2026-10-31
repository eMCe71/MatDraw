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

/** Encouragement in the guest preview. Today it leads to the login form (kind 'login'); a later paid-access offer can
 * reuse the same slot with kind 'paid', its own copy and a price in the note, plus a handler for the 'access-cta' action. */
export const ACCESS={
 kind:'login',
 eyebrow:'Więcej po zalogowaniu',
 title:'Zobacz turniej w pełnej wersji',
 text:'W podglądzie gościa zawodnicy są oznaczeni inicjałami. Po zalogowaniu zobaczysz dane zgodne z uprawnieniami Twojego konta.',
 benefits:['Pełne imiona i nazwiska zawodników','Zgłoszenia i kontrola startowa','Wyniki walk, wydruki i ekran hali'],
 cta:'Zaloguj się',
 note:'Konto zakłada Administrator turnieju.'
};
