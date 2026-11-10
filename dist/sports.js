/* Martial arts of the home page and their federations (owner's list and order, 2026-11-10): one catalogue for the sport switcher,
 * the tournament form, the filter of the public tournament list and the chat channels per sport. backend/src/Sports.php mirrors the
 * ids, the federations and the channels (tests/sports.test.mjs compares them). Data only: labels are Polish keys shown through T()
 * (English in dist/i18n/home-en.js); federation abbreviations and names are proper names, the same in both languages. The colour
 * of every sport is in tokens.css ([data-sport="…"] sets --sport and --sport-tint; tests/sports.test.mjs checks the contrast).
 *
 * Federations: the bodies that run competitions in Poland, found in the research for the owner (PR description); a sport with
 * fewer than two has no federation filter and no federation channel (its general channel covers everything). Editing a list here
 * and in Sports.php is all a change needs (an unknown federation of a stored tournament is shown as none).
 *
 * Chat (no PL/world split, owner 2026-11-10): every sport has a general channel and, with two or more federations, one channel per
 * federation, slugs '<sport>' and '<sport>-<federation>'. Taekwondo keeps the existing 'taekwondo-pl' channel as its general one, so
 * its Polish conversations stay; the 'taekwondo' (world) and 'general' channels of the old split are retired: their rows and
 * messages stay in the database, nobody sees them (Chat::visibleFor), the moderation panel still reaches their messages.
 *
 * mascot: the MatBravo character dressed for the sport (owner's idea and illustrations, 2026-11-10): src (w × h) stands above the
 * tournament list, tile (tw × th) on the sport's tile of the chooser. Framed like brand/matbravo-welcome.webp (head to mid-thigh, the
 * top 80% of the owner's 670 × 980 PNG). The files in dist/brand/sports are not precached (scripts/build-pwa.mjs DENY): only the
 * chosen sport's figure is fetched; taekwondo keeps the precached default figure (white dobok, blue belt). */

export const DEFAULT_SPORT='taekwondo';
export const SPORTS=[
 {id:'taekwondo',label:'Taekwondo',federations:[['uitf','UITF','ITF Union'],['itf','ITF','International Taekwon-Do Federation'],['wt','WT','World Taekwondo']],mascot:{src:'./brand/matbravo-welcome.webp',w:333,h:488,tile:'./brand/sports/matbravo-taekwondo-tile.webp',tw:164,th:240}},
 {id:'karate',label:'Karate',federations:[['wkf','WKF','World Karate Federation'],['kyokushin','Kyokushin','Kyokushin (IKO, KWF)'],['itkf','ITKF','International Traditional Karate Federation']],mascot:{src:'./brand/sports/matbravo-karate.webp',w:417,h:488,tile:'./brand/sports/matbravo-karate-tile.webp',tw:205,th:240}},
 {id:'boxing',label:'Boks',federations:[['worldboxing','World Boxing','World Boxing'],['iba','IBA','International Boxing Association']],mascot:{src:'./brand/sports/matbravo-boxing.webp',w:417,h:488,tile:'./brand/sports/matbravo-boxing-tile.webp',tw:205,th:240}},
 {id:'judo',label:'Judo',federations:[['ijf','IJF','International Judo Federation']],mascot:{src:'./brand/sports/matbravo-judo.webp',w:417,h:488,tile:'./brand/sports/matbravo-judo-tile.webp',tw:205,th:240}},
 {id:'kickboxing',label:'Kickboxing',federations:[['wako','WAKO','World Association of Kickboxing Organizations']],mascot:{src:'./brand/sports/matbravo-kickboxing.webp',w:417,h:488,tile:'./brand/sports/matbravo-kickboxing-tile.webp',tw:205,th:240}},
 {id:'bjj',label:'Jiu-Jitsu',federations:[['ibjjf','IBJJF','International Brazilian Jiu-Jitsu Federation']],mascot:{src:'./brand/sports/matbravo-bjj.webp',w:417,h:488,tile:'./brand/sports/matbravo-bjj-tile.webp',tw:205,th:240}},
 {id:'muaythai',label:'Muay Thai',federations:[['ifma','IFMA','International Federation of Muaythai Associations'],['wmc','WMC','World Muaythai Council']],mascot:{src:'./brand/sports/matbravo-muaythai.webp',w:417,h:488,tile:'./brand/sports/matbravo-muaythai-tile.webp',tw:205,th:240}},
 {id:'mma',label:'MMA',federations:[['immaf','IMMAF','International Mixed Martial Arts Federation'],['almma','ALMMA','Amatorska Liga MMA']],mascot:{src:'./brand/sports/matbravo-mma.webp',w:417,h:488,tile:'./brand/sports/matbravo-mma-tile.webp',tw:205,th:240}}
];
export const SPORT_IDS=SPORTS.map(s=>s.id);
/** Slugs of the channels of the old PL/world split that the catalogue no longer lists. */
export const RETIRED=['taekwondo','general'];

export const sportOf=id=>SPORTS.find(s=>s.id===id)||null;
/** [id, short name, full name] of the federations of a sport, in display order ([] for an unknown sport). */
export const federationsOf=sport=>sportOf(sport)?.federations||[];
export const federationOf=(sport,fed)=>federationsOf(sport).find(f=>f[0]===fed)||null;
/** Whether the sport has a federation filter and federation channels (two or more federations). */
export const hasFederations=sport=>federationsOf(sport).length>1;
/** The sport of a tournament (stored tournaments before migration 0010 are taekwondo) and its federation (null: none or unknown). */
export const tournamentSport=t=>SPORT_IDS.includes(t?.sport)?t.sport:DEFAULT_SPORT;
export const tournamentFederation=t=>federationOf(tournamentSport(t),t?.federation)?t.federation:null;
/** The general channel of a sport. */
export const generalSlug=sport=>sport==='taekwondo'?'taekwondo-pl':sport;
/** Channels of the chat lobby in display order: {slug, sport, fed} (fed null for the general channel). */
export const LOBBY=SPORTS.flatMap(s=>[{slug:generalSlug(s.id),sport:s.id,fed:null},...(s.federations.length>1?s.federations.map(([f])=>({slug:s.id+'-'+f,sport:s.id,fed:f})):[])]);
export const lobbyOf=slug=>LOBBY.find(c=>c.slug===slug)||null;
/** The martial arts of a member's profile sports that the catalogue knows, in the profile's order (Japanese jiu-jitsu goes with
 * jiu-jitsu, wrestling and 'other' with none). */
export const profileSports=sports=>[...new Set((Array.isArray(sports)?sports:[]).map(s=>s==='jujitsu'?'bjj':s).filter(s=>SPORT_IDS.includes(s)))];
/** The home sport for a member's profile sports: the first one the catalogue knows. */
export const fromProfile=sports=>profileSports(sports)[0]||null;
