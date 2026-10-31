import {cp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {buildPwa} from './build-pwa.mjs';
const target=path.resolve(process.argv[2]||'build/matdraw-php');
if(!target.endsWith('matdraw-php'))throw Error('Use a dedicated directory ending with matdraw-php.');
await mkdir(target,{recursive:true});
await rm(path.join(target,'public'),{recursive:true,force:true});
await cp('dist',path.join(target,'public'),{recursive:true});
await cp('backend',path.join(target,'backend'),{recursive:true,filter:source=>!/(^|\/)config\.php$|\/public(\/|$)/.test(source)});
await cp('backend/public/api',path.join(target,'public/api'),{recursive:true});
await cp('backend/public/.htaccess',path.join(target,'public/.htaccess'));
await writeFile(path.join(target,'public/runtime-config.js'),"export const CONFIG={mode:'api',apiBase:'./api/index.php'};\n");
await cp('INSTALL-PL.md',path.join(target,'INSTALACJA.md'));
await cp('INSTALL-PL.md',path.join(target,'INSTALL-PL.md'));
await cp('VALIDATION.md',path.join(target,'VALIDATION.md'));
await cp('README.md',path.join(target,'README.md'));
// Last step: fill the service worker template from the final public/ (plan §9.3).
await buildPwa(path.join(target,'public'),{commit:(process.env.GITHUB_SHA||'local').slice(0,7)});
console.log(target);
