// Fills the service worker template of a release (plan §9.3, research 04 §1.4.5). build-php.mjs calls buildPwa(<target>/public) as its last
// step, after runtime-config.js is final; by hand: node scripts/build-pwa.mjs <public dir>.
// The build number is a hash of the template and of the shell files' names and contents only (never the commit or the time), so a release
// that changes only backend/ keeps the same sw.js and shows nobody an update bar. Each precache entry carries its SHA-256, which the worker
// checks on install. Fails on missing or duplicated markers, a missing required file and a precache above 1.5 MB.
import {readFile,writeFile,readdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import {pathToFileURL} from 'node:url';
// Never precached: demo-only and documentation files, large images not needed offline, server-side and private paths, any PHP script
// (its executed output would never match the source checksum and every install would fail), dotfiles, and the worker's own update probes.
// Manifests and offline.html are part of the shell.
export const DENY=[/^architecture\./,/^promo\//,/^vendor\//,/^brand\/og-image\./,/^fonts\/OFL/,/^screenshots\//,/^(?:api|u|live)(?:\/|$)/,/\.(?:php\d?|phtml|phar)$/i,/(?:^|\/)\./,/^favicon\.ico$/,/^sw\.js$/,/^version\.json$/];
export const REQUIRED=['index.html','offline.html','manifest.webmanifest','manifest.en.webmanifest','app.js','runtime-config.js','lang-boot.js'];
export const LIMIT=1.5*1024*1024;
const BUILD_MARK="/*@build*/'dev'",LIST_MARK='/*@precache*/[]';
const count=(s,m)=>s.split(m).length-1,sha=b=>createHash('sha256').update(b).digest('hex');
// Regular files only: a symlink (for example an uploads link added on the server) is never followed into the precache.
const walk=async d=>(await Promise.all((await readdir(d,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(d,e.name)):e.isFile()?[path.join(d,e.name)]:[]))).flat();

export async function buildPwa(pub,{commit='local'}={}){
 const files=(await walk(pub)).map(f=>path.relative(pub,f).split(path.sep).join('/')).sort();
 const shell=files.filter(f=>!DENY.some(r=>r.test(f)));
 for(const f of REQUIRED)if(!shell.includes(f))throw Error(`build-pwa: ${f} is missing from ${pub}`);
 const tpl=await readFile(path.join(pub,'sw.js'),'utf8');
 if(count(tpl,BUILD_MARK)!==1||count(tpl,LIST_MARK)!==1)throw Error('build-pwa: sw.js template markers missing or duplicated (was the release built twice?)');
 let bytes=0;const entries=[];
 for(const f of shell){const body=await readFile(path.join(pub,f));bytes+=body.length;entries.push(['./'+f,sha(body)]);}
 if(bytes>LIMIT)throw Error(`build-pwa: precache is ${bytes} bytes, above the ${LIMIT} byte budget; add large files to DENY`);
 const h=createHash('sha256').update(tpl);for(const [u,s] of entries)h.update(u+'\0'+s+'\n');
 const build=h.digest('hex').slice(0,12);
 const sw=tpl.replace(BUILD_MARK,()=>JSON.stringify(build)).replace(LIST_MARK,()=>JSON.stringify(entries));
 await writeFile(path.join(pub,'sw.js'),sw);
 await writeFile(path.join(pub,'version.json'),JSON.stringify({build,commit:String(commit),files:entries.length})+'\n');
 return {build,urls:entries.map(([u])=>u),bytes};
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 if(!process.argv[2])throw Error('Usage: node scripts/build-pwa.mjs <public dir>');
 const r=await buildPwa(path.resolve(process.argv[2]),{commit:(process.env.GITHUB_SHA||'local').slice(0,7)});
 console.log(`sw.js build ${r.build}: ${r.urls.length} files, ${r.bytes} bytes precached`);
}
