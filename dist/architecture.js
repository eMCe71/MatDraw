// Language for the static architecture page: shows the PL or EN block (CSS on <html lang>) and drives its PL | EN switcher.
import {LANGUAGES,STORAGE_KEY,getLanguage,setLanguage,onLanguageChange,t} from './i18n.js';
function apply(){
 const lang=getLanguage();
 document.documentElement.lang=lang;
 document.title=t('MatBravo — architektura PHP i MySQL');
 for(const button of document.querySelectorAll('[data-set-lang]'))button.setAttribute('aria-pressed',String(button.dataset.setLang===lang));
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-set-lang]');if(button)setLanguage(button.dataset.setLang);});
window.addEventListener('storage',event=>{if(event.key===STORAGE_KEY&&LANGUAGES.includes(event.newValue))setLanguage(event.newValue,{persist:false});});
onLanguageChange(apply);
apply();
