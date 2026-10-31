// Shared helpers for the HTTP tests (*.http.test.mjs). Requires the environment set by scripts/test-http.sh:
// MATDRAW_TEST_URL (API endpoint), MATDRAW_CONFIG (test config) and optionally PHP_BIN and MATDRAW_TEST_SHARED_DIR.
// Without MATDRAW_TEST_URL every HTTP test is skipped and fixture() does nothing, so `node --test tests/*.test.mjs`
// stays green on a machine without a database. Fixture credentials are test-only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
export const base=process.env.MATDRAW_TEST_URL;
export const CLIENT_API=1;
export class Client{
 cookie='';csrf='';data=null;
 async req(route,body,extra={}){
  const r=await fetch(base+'?route='+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-MatBravo-Client':String(CLIENT_API),Cookie:this.cookie,'X-CSRF-Token':this.csrf,...extra},...(body?{body:JSON.stringify(body)}:{})});
  const cookie=r.headers.getSetCookie()?.at(-1);if(cookie)this.cookie=cookie.split(';')[0];
  const text=r.status===204?'':await r.text();let data=null;if(text){try{data=JSON.parse(text);}catch{data={raw:text};}}
  if(data?.csrf)this.csrf=data.csrf;return {status:r.status,data,headers:r.headers};
 }
 async login(email,password='TestPassword2026!'){await this.req('session');const r=await this.req('login',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return this.load();}
 async load(){const r=await this.req('bootstrap');assert.equal(r.status,200,JSON.stringify(r.data));this.data=r.data;return r.data;}
 async cmd(type,payload,status=200,revision=this.data.revision){const r=await this.req('command',{type,payload,expectedRevision:revision});assert.equal(r.status,status,JSON.stringify(r.data));if(status===200)this.data=r.data.workspace;return r.data.result;}
}
/**
 * Polls `probe()` until it returns a value deep-equal to `expected` (or until `ms`); returns the last value, so a test
 * asserts on it. For changes the server observes asynchronously, e.g. a rewritten config.php (never a fixed sleep).
 */
export async function eventually(probe,expected,ms=10000,step=100){
 let v;for(const end=Date.now()+ms;;){v=await probe();if(isDeepStrictEqual(v,expected)||Date.now()>=end)return v;await new Promise(r=>setTimeout(r,step));}
}
export const php=process.env.PHP_BIN||'php';
const fixtureScript=fileURLToPath(new URL('./fixture.php',import.meta.url));
/**
 * Runs a test-data job of tests/helpers/fixture.php (and tests/helpers/fixture-*.php) against the test database:
 * member {email,password,profile,exempt}, billing {userId,...billing_accounts columns}, tournament {name,date,status},
 * reset-limits. Returns the job's JSON result. `env` may override MATDRAW_CONFIG (e.g. a second test database).
 */
export function fixture(job,payload={},env={}){
 if(!base)return null;
 const r=spawnSync(php,[fixtureScript],{input:JSON.stringify({job,payload}),encoding:'utf8',env:{...process.env,...env},maxBuffer:10_000_000});
 assert.equal(r.status,0,`fixture ${job}: ${r.stderr||r.stdout}`);return JSON.parse(r.stdout);
}
