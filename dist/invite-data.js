/* The organizer's invitation (docs/plan/PLAN-MATERIALY.md §6), data side: mirror of Materials::INVITE_FIELDS, INVITE_STYLES,
 * inviteField(), the invite branch of Materials::meta and Materials::inviteJson (tests/materials.test.mjs runs shared cases).
 * Stored meta: {s:<style>, d:{<field>:<text>, …}, at}; d holds 1–13 fields in the order of INVITE_FIELDS, each a fixed point of
 * inviteField() of 1–max characters (code points). Shared by dist/workspace.js (the demo's domain), dist/guest-view.js (the views)
 * and dist/invite.js (editor and card). No imports, so every module may load it. */
/** key => [max characters, multiline] (Bogdan's template, in its order). */
export const INVITE_FIELDS=Object.freeze({event:[120,false],venue:[160,false],street:[120,false],dates:[80,false],except:[300,false],special:[800,true],women:[500,true],men:[500,true],open:[80,false],close:[80,false],note:[500,true],closing:[60,false],sign:[160,false]});
export const INVITE_KEYS=Object.freeze(Object.keys(INVITE_FIELDS));
export const INVITE_STYLES=Object.freeze(['classic','gala','sport']);
const ILL_FORMED=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const trimText=s=>s.replace(/^[\s\p{Z}]+|[\s\p{Z}]+$/gu,'');
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Characters as the server counts them (code points, mb_strlen). */
export const chars=s=>[...String(s)].length;
/** Materials::text: CRLF/CR → LF, tab → space, controls but LF and format characters but U+200D removed, NFC, white-space-only lines
 * empty, at most 2 empty lines in a row, trimmed. Not a string or ill-formed: null. */
function multiline(raw){
 if(typeof raw!=='string'||ILL_FORMED.test(raw))return null;
 const s=raw.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\t/g,' ').replace(/(?!\n)\p{Cc}/gu,'').replace(/(?!‍)\p{Cf}/gu,'').normalize('NFC');
 const lines=[];let empty=0;
 for(const line of s.split('\n')){if(trimText(line)===''){if(++empty>2)continue;lines.push('');}else{empty=0;lines.push(line);}}
 return trimText(lines.join('\n'));
}
/** Materials::inviteField: one field as stored (single-line fields: every run of line breaks becomes one space); null for an
 * unknown key or a value that is not a string; may give ''. */
export function inviteField(key,raw){
 if(!Object.hasOwn(INVITE_FIELDS,key))return null;const t=multiline(raw);if(t===null)return null;
 return INVITE_FIELDS[key][1]?t:t.replace(/\n+/g,' ');
}
/** The invite branch of Materials::meta: {s,d,at} with d in canonical order when v is exactly valid, else null. strict false (views)
 * only checks that each field is free of what inviteField removes (writes stay strict). */
export function inviteCheck(v,strict=true){
 if(!isObj(v)||Object.keys(v).sort().join()!=='at,d,s'||!INVITE_STYLES.includes(v.s)||!isObj(v.d)||!Number.isInteger(v.at)||v.at<0||v.at>9999999999)return null;
 const keys=Object.keys(v.d);if(!keys.length)return null;
 for(const k of keys){
  const x=v.d[k];if(!Object.hasOwn(INVITE_FIELDS,k)||typeof x!=='string')return null;const [max,multi]=INVITE_FIELDS[k];
  const ok=strict?inviteField(k,x)===x:!ILL_FORMED.test(x)&&!/\r|(?!\n)\p{Cc}|(?!‍)\p{Cf}/u.test(x)&&(multi||!x.includes('\n'));
  const n=ok?chars(x):0;if(!ok||n<1||n>max)return null;
 }
 const d={};for(const k of INVITE_KEYS)if(Object.hasOwn(v.d,k))d[k]=v.d[k];
 return {s:v.s,d,at:v.at};
}
/** Materials::inviteJson: the text whose SHA-256 gives the invite's version (style and fields, never at). */
export const inviteJson=i=>JSON.stringify({s:i.s,d:i.d});
/** The fields of a form cleaned as invite-save cleans them: {d, error}; d without empty fields, error 'empty' or the key that is too long. */
export function inviteFields(fields){
 const d={};
 for(const k of INVITE_KEYS){const t=inviteField(k,fields?.[k]??'');if(!t)continue;if(chars(t)>INVITE_FIELDS[k][0])return {d,error:k};d[k]=t;}
 return {d,error:Object.keys(d).length?null:'empty'};
}
