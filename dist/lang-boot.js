/* Sets <html lang> before the first paint, so static pages show the right language without a flash.
 * Classic script (no inline code under the CSP). Same rule as resolveLanguage() in i18n.js – keep them in sync
 * (tests/i18n.test.mjs compares both): remembered choice first, otherwise Polish browser = pl, anything else = en. */
(function(){
 var lang=null;
 try{lang=window.localStorage.getItem('matdraw.language');}catch(e){}
 if(lang!=='pl'&&lang!=='en'){
  var n=window.navigator||{},list=n.languages&&n.languages.length?n.languages:[n.language],first='';
  for(var i=0;i<list.length;i++){if(typeof list[i]==='string'&&list[i].replace(/\s/g,'')){first=list[i].replace(/^\s+|\s+$/g,'');break;}}
  lang=/^pl(?:[-_]|$)/i.test(first)?'pl':'en';
 }
 document.documentElement.lang=lang;
})();
