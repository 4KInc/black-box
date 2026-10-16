// HTML for the replay. No scripts at all: the server sends `script-src 'none'`, and the page the
// agent bought from is shown in a sandboxed iframe, so nothing recorded can run here.
//
// The look is a flight recorder and its incident report: graphite, one flight-recorder orange,
// B612 (the typeface Airbus drew for cockpit displays) for text and data, Barlow Condensed for
// placards. Facts are an annunciator panel, the rules a decision ladder, the events a recorder
// tape. Motion is CSS only (cross-document view transitions, scroll-driven reveals) and is off
// under prefers-reduced-motion.

import { toValue } from '../engine/actions.mjs';
import { FACT_KEYS, MERCHANT_CONDITIONS, RECORD_CHECKS, RULES, VERDICT } from '../engine/verdict.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c, cur = 'USD') => (Number.isInteger(c) ? `$${toValue(c)}${cur === 'USD' ? '' : ' ' + cur}` : '–');
const time = (iso) => (iso ? esc(String(iso).replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')) : '–');
const clock = (iso) => (iso ? esc(String(iso).slice(11, 19)) : '––:––:––');
const day = (iso) => (iso ? esc(String(iso).slice(0, 10)) : '');
const short = (h, n = 12) => `${esc(String(h).slice(0, n))}…`;
const label = (v) => (v === VERDICT.HUMAN ? 'NEEDS A HUMAN' : v);
const vtName = (hash) => `r${String(hash).slice(0, 12)}`;

const WHO = {
  [VERDICT.MERCHANT]: 'The merchant pays',
  [VERDICT.AGENT]: 'The agent operator pays',
  [VERDICT.USER]: 'The purchase stands',
  [VERDICT.HUMAN]: 'A person decides',
};

// Annunciator captions (short, placard style) and what each lamp means.
const FACT = {
  hashesMatch: ['HASH = CUSTOM_ID', 'Record hash equals the PayPal custom_id, and every stored page matches its hash'],
  signaturesValid: ['SIGNATURES', 'Every page signature verifies (RFC 9421, Ed25519)'],
  keyOnShopDomain: ['KEY ON DOMAIN', "The signing key was published on the shop's own domain"],
  payeeMatches: ['PAYEE MATCH', 'The signed merchant ID equals the PayPal payee'],
  signedBeforeOrder: ['SIGNED < ORDER', 'Every page was signed before the PayPal order existed'],
  mandateSigned: ['MANDATE PASSKEY', 'The paying user approved the mandate with their enrolled passkey (or the order predates passkeys)'],
  mandateBroken: ['MANDATE BROKEN', "The purchase breaks the user's mandate"],
  concealedInReadChannel: ['HIDDEN TEXT', 'Text hidden from people, inside what the agent reads'],
  namesPurchasedItem: ['NAMES ITEM', 'That hidden text names the item that was bought'],
  inModelInput: ['READ BY MODEL', 'That hidden text reached the model'],
  merchantOwned: ['MERCHANT OWNED', "That hidden text is the merchant's own (signed, self-contained, no third party)"],
  aiInjectionFlag: ['AI FLAG', 'The AI flagger quoted agent-directed text that names the item bought (can only lead to NEEDS A HUMAN)'],
  unattributedHiddenText: ['UNATTRIBUTED', 'Hidden text the agent read that cannot be pinned on the merchant'],
};
const SIGNALS = FACT_KEYS.filter((k) => !RECORD_CHECKS.includes(k) && !MERCHANT_CONDITIONS.includes(k) && k !== 'mandateBroken');

// Lamp state: integrity checks are green when they hold and red when they fail; everything else
// is dark when false and lit (amber for caution, orange for the merchant's cause) when true.
function lamp(key, value) {
  if (RECORD_CHECKS.includes(key)) return value ? 'ok' : 'fault';
  if (!value) return 'off';
  return MERCHANT_CONDITIONS.includes(key) ? 'cause' : 'caution';
}

const NOISE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

// Shared with the mandate screen, so the two read as one product.
export const CSS = `
@font-face{font-family:B612;src:url(/fonts/B612-400.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:B612;src:url(/fonts/B612-700.woff2) format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:"B612 Mono";src:url(/fonts/B612Mono-400.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"B612 Mono";src:url(/fonts/B612Mono-700.woff2) format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:"Barlow Condensed";src:url(/fonts/BarlowCondensed-500.woff2) format("woff2");font-weight:500;font-display:swap}
@font-face{font-family:"Barlow Condensed";src:url(/fonts/BarlowCondensed-600.woff2) format("woff2");font-weight:600;font-display:swap}
@font-face{font-family:"Barlow Condensed";src:url(/fonts/BarlowCondensed-700.woff2) format("woff2");font-weight:700;font-display:swap}
@view-transition{navigation:auto}
:root{color-scheme:dark;
  --bg:oklch(.155 .006 250);--bg-1:oklch(.185 .007 250);--bg-2:oklch(.215 .008 250);--bg-3:oklch(.255 .009 250);
  --rule:oklch(.30 .009 250);--rule-2:oklch(.38 .01 250);
  --ink:oklch(.95 .012 85);--ink-2:oklch(.78 .012 85);--ink-3:oklch(.58 .012 85);
  --orange:oklch(.71 .19 45);--amber:oklch(.83 .15 82);--green:oklch(.80 .17 150);--red:oklch(.66 .21 27);--cyan:oklch(.80 .11 222);
  --display:"Barlow Condensed","Arial Narrow",sans-serif;--sans:B612,ui-sans-serif,system-ui,sans-serif;--mono:"B612 Mono",ui-monospace,Menlo,monospace;
  --pad:clamp(14px,3.2vw,32px)}
.MERCHANT{--c:var(--red)}.AGENT{--c:var(--amber)}.USER{--c:var(--cyan)}.NEEDS_A_HUMAN{--c:var(--ink)}.PASS{--c:var(--green)}.FAIL{--c:var(--red)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--bg);-webkit-text-size-adjust:100%;scroll-padding-top:72px}
body{margin:0;min-height:100vh;overflow-x:hidden;color:var(--ink);font:400 14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;
  background:${NOISE},radial-gradient(1200px 520px at 50% -180px,oklch(.24 .03 45 / .55),transparent 70%),var(--bg)}
a{color:inherit;text-underline-offset:3px;text-decoration-color:var(--rule-2)}
a:hover{text-decoration-color:var(--orange)}
:focus-visible{outline:2px solid var(--orange);outline-offset:3px}
h1,h2,h3{text-wrap:balance;margin:0}p{text-wrap:pretty}
.mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.k{color:var(--ink-3)}
.skip{position:absolute;left:-999px}.skip:focus{left:var(--pad);top:8px;z-index:9;background:var(--orange);color:#140600;padding:6px 10px}

/* ---- bar ---- */
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:18px;padding:12px var(--pad);
  border-bottom:1px solid var(--rule);background:oklch(.155 .006 250 / .82);backdrop-filter:blur(10px) saturate(1.2)}
.mark{display:flex;align-items:center;gap:10px;text-decoration:none;font:700 19px/1 var(--display);letter-spacing:.14em;view-transition-name:mark}
.unit{width:18px;height:13px;background:var(--orange);border-radius:2px;position:relative;box-shadow:0 0 18px oklch(.71 .19 45 / .45)}
.unit::before,.unit::after{content:"";position:absolute;top:3px;bottom:3px;width:2px;background:oklch(.2 .05 45)}
.unit::before{left:4px}.unit::after{right:4px}
.sub{font:400 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
.bar nav{margin-left:auto;display:flex;gap:4px}
.bar nav a{font:600 15px/1 var(--display);letter-spacing:.12em;text-transform:uppercase;text-decoration:none;color:var(--ink-2);padding:8px 12px;border:1px solid transparent;border-radius:2px}
.bar nav a:hover{color:var(--ink);border-color:var(--rule)}
.bar nav a[aria-current=page]{color:var(--ink);border-color:var(--rule-2);background:var(--bg-2)}
@media (max-width:640px){.sub{display:none}.bar{gap:10px}}

main{max-width:1240px;margin:0 auto;padding:clamp(18px,3vw,34px) var(--pad) 96px}

/* ---- placards and sections ---- */
.eyebrow{font:400 11px/1.4 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3)}
.eyebrow b{color:var(--orange);font-weight:400}
.sec{margin-top:clamp(36px,6vw,64px)}
.sec>header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-top:1px solid var(--rule);padding-top:14px;margin-bottom:16px}
.sec>header h2{font:600 clamp(24px,3.4vw,34px)/1 var(--display);letter-spacing:.04em;text-transform:uppercase}
.sec>header .n{font:400 12px/1 var(--mono);color:var(--orange);letter-spacing:.1em}
.sec>header p{flex-basis:100%;margin:2px 0 0;color:var(--ink-2);max-width:78ch}
.panel{background:linear-gradient(180deg,var(--bg-1),oklch(.17 .006 250));border:1px solid var(--rule);border-radius:4px;padding:clamp(14px,2vw,20px)}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}

/* ---- probable cause plate ---- */
.cause{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,400px);gap:0;border:1px solid var(--rule-2);border-radius:4px;overflow:hidden;
  background:linear-gradient(105deg,oklch(from var(--c) l c h / .10),transparent 46%),var(--bg-1)}
.cause::before{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:var(--c);box-shadow:0 0 24px var(--c)}
.cause .main{padding:clamp(18px,3vw,30px) clamp(18px,3vw,34px)}
.cause .v{font:700 clamp(54px,10vw,112px)/.86 var(--display);letter-spacing:.01em;color:var(--c);margin:10px 0 4px;text-transform:uppercase}
.cause .who{font:600 clamp(18px,2.2vw,24px)/1.2 var(--display);letter-spacing:.06em;text-transform:uppercase;margin:6px 0 10px}
.cause .why{color:var(--ink-2);max-width:62ch;margin:0}
.cause .pp{border-left:1px solid var(--rule);padding:clamp(18px,3vw,28px);background:oklch(.17 .006 250 / .6);display:flex;flex-direction:column;gap:6px;justify-content:center}
.cause .pp .amt{font:700 clamp(30px,4vw,44px)/1 var(--display);letter-spacing:.02em}
.cause .pp .amt small{display:block;font:600 14px/1.3 var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2);margin-top:6px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 11.5px/1.5 var(--mono);color:var(--ink-3);margin-top:8px}
.kv b{color:var(--ink-2);font-weight:400;overflow-wrap:anywhere}
@media (max-width:860px){.cause{grid-template-columns:1fr}.cause .pp{border-left:0;border-top:1px solid var(--rule)}}
.crumbs{display:flex;gap:10px 18px;flex-wrap:wrap;margin-bottom:14px;font:400 11px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.crumbs span b{color:var(--ink-2);font-weight:400}

/* ---- budget gauge ---- */
.mandate-line{font:600 clamp(20px,2.6vw,28px)/1.15 var(--display);letter-spacing:.02em;margin:8px 0 12px}
.seal{display:inline-flex;align-items:center;gap:8px;font:400 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;padding:7px 10px;border:1px solid var(--c);color:var(--c);border-radius:2px}
.seal.ok{--c:var(--green)}.seal.bad{--c:var(--red)}.seal.legacy{--c:var(--ink-3)}
.gauge{margin-top:16px}
.gauge .track{position:relative;height:26px;border:1px solid var(--rule-2);border-radius:2px;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 1px),var(--rule) calc(10% - 1px) 10%),var(--bg)}
.gauge .fill{position:absolute;inset:3px auto 3px 3px;background:var(--ink-3);border-radius:1px}
.gauge .over{position:absolute;top:3px;bottom:3px;background:repeating-linear-gradient(135deg,var(--red) 0 6px,oklch(.5 .17 27) 6px 12px);border-radius:1px}
.gauge .cap{position:absolute;top:-6px;bottom:-6px;width:2px;background:var(--amber);box-shadow:0 0 10px var(--amber)}
.gauge .legend{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:8px;font:400 11px/1.4 var(--mono);color:var(--ink-3);letter-spacing:.06em;text-transform:uppercase}
.gauge .legend b{color:var(--ink);font-weight:400}
.verdictline{margin-top:10px;font:400 12px/1.5 var(--mono)}
.verdictline.bad{color:var(--red)}.verdictline.good{color:var(--green)}

/* ---- channels ---- */
.contrast{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:14px;margin-bottom:14px}
.contrast .panel{display:flex;flex-direction:column;gap:8px}
.contrast .price{font:700 clamp(40px,6vw,64px)/.95 var(--display);letter-spacing:.01em}
.contrast .price small{display:block;font:500 16px/1.3 var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);margin-top:6px}
.contrast blockquote{margin:0;font:400 15px/1.55 var(--sans);color:var(--ink)}
@media (max-width:860px){.contrast{grid-template-columns:1fr}}
.ch{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-bottom:8px;font:400 11px/1.45 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.ch i{font-style:normal;white-space:nowrap;color:var(--bg);background:var(--ink-2);padding:3px 6px;border-radius:2px}
.ch.two i{background:var(--orange)}
.ch a{margin-left:auto;color:var(--orange);text-decoration:none}
iframe{display:block;width:100%;height:600px;border:1px solid var(--rule-2);border-radius:4px;background:#fff}
pre.input{margin:0;height:600px;overflow:auto;white-space:pre-wrap;background:var(--bg);border:1px solid var(--rule-2);border-radius:4px;padding:14px;font:400 12px/1.6 var(--mono);color:var(--ink-2);scrollbar-color:var(--rule-2) transparent}
mark{background:oklch(.71 .19 45 / .22);color:var(--ink);box-shadow:inset 0 -2px 0 var(--orange);border-radius:1px;padding:0 1px;scroll-margin:60px}
@media (max-width:860px){iframe,pre.input{height:440px}}
.cvr{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;margin-top:14px;border-left:2px solid var(--orange);padding:12px 16px;background:var(--bg-1)}
.cvr .who{font:400 11px/1.5 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--orange);white-space:nowrap}
.cvr p{margin:0;font:400 14px/1.6 var(--mono);color:var(--ink)}
@media (max-width:640px){.cvr{grid-template-columns:1fr;gap:4px}}

/* ---- findings, chips ---- */
.finding+.finding{margin-top:12px}
.finding q{display:block;margin:8px 0 12px;font:400 15px/1.6 var(--sans);quotes:"“" "”"}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:7px;font:400 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:6px 8px;border:1px solid var(--rule-2);border-radius:2px;color:var(--ink-3)}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rule-2)}
.chip.on{color:var(--ink)}.chip.on::before{background:var(--orange);box-shadow:0 0 8px var(--orange)}
.chip.ok{color:var(--ink)}.chip.ok::before{background:var(--green);box-shadow:0 0 8px var(--green)}
.chip.bad{color:var(--red);border-color:oklch(.66 .21 27 / .5)}.chip.bad::before{background:var(--red)}
.empty{color:var(--ink-3);font:400 12px/1.5 var(--mono);letter-spacing:.06em;text-transform:uppercase}

/* ---- annunciator panel ---- */
.ann{container-type:inline-size}
.ann .groups{display:grid;grid-template-columns:5fr 1fr 4fr 2fr;gap:14px}
@container (max-width:900px){.ann .groups{grid-template-columns:1fr 1fr}}
@container (max-width:520px){.ann .groups{grid-template-columns:1fr}}
.ann h3{font:400 10.5px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}
.lamps{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:6px}
.lampc{position:relative;min-height:66px;padding:10px 9px 8px;border:1px solid var(--rule);border-radius:3px;background:oklch(.13 .005 250);
  font:700 12px/1.15 var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);display:flex;flex-direction:column;justify-content:space-between}
.lampc small{font:400 10px/1 var(--mono);letter-spacing:.06em;color:var(--ink-3);opacity:.8}
.lampc.ok{--l:var(--green)}.lampc.fault{--l:var(--red)}.lampc.caution{--l:var(--amber)}.lampc.cause{--l:var(--orange)}
.lampc:not(.off){color:var(--l);border-color:oklch(from var(--l) l c h / .55);background:radial-gradient(120% 90% at 50% 0%,oklch(from var(--l) l c h / .20),transparent 70%),oklch(.14 .01 250);
  box-shadow:inset 0 0 0 1px oklch(from var(--l) l c h / .10),0 0 22px oklch(from var(--l) l c h / .12);text-shadow:0 0 10px oklch(from var(--l) l c h / .55)}
.lampc:not(.off) small{color:var(--l)}

/* ---- decision ladder ---- */
ol.ladder{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ol.ladder li{display:grid;grid-template-columns:44px 150px minmax(0,1fr);align-items:center;gap:14px;padding:11px 14px;border:1px solid var(--rule);border-radius:3px;color:var(--ink-3);background:var(--bg-1)}
ol.ladder li .n{font:700 22px/1 var(--display);color:var(--ink-3)}
ol.ladder li .tag{font:700 13px/1 var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--c);opacity:.6}
ol.ladder li.fired{color:var(--ink);border-color:var(--c);background:linear-gradient(90deg,oklch(from var(--c) l c h / .14),transparent 60%),var(--bg-1);box-shadow:0 0 0 1px oklch(from var(--c) l c h / .25)}
ol.ladder li.fired .n,ol.ladder li.fired .tag{color:var(--c);opacity:1}
ol.ladder li.fired .tag::after{content:"  ◀ FIRED";letter-spacing:.1em}
@media (max-width:640px){ol.ladder li{grid-template-columns:32px 1fr;}ol.ladder li>span:last-child{grid-column:1/-1}}

/* ---- recorder tape ---- */
ol.tape{list-style:none;margin:0;padding:0 0 0 18px;border-left:1px solid var(--rule-2);position:relative}
ol.tape li{position:relative;display:grid;grid-template-columns:96px 84px minmax(0,1fr);gap:12px;padding:9px 0;border-bottom:1px dashed var(--rule)}
ol.tape li::before{content:"";position:absolute;left:-22px;top:15px;width:7px;height:7px;border-radius:50%;background:var(--bg);border:1px solid var(--rule-2)}
ol.tape li.hot::before{background:var(--orange);border-color:var(--orange);box-shadow:0 0 10px var(--orange)}
ol.tape .t{font:400 12px/1.5 var(--mono);color:var(--ink-3)}
ol.tape .ev{font:700 12px/1.6 var(--display);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2)}
ol.tape li.hot .ev{color:var(--orange)}
@media (max-width:640px){ol.tape li{grid-template-columns:76px 1fr}ol.tape li>span:last-child{grid-column:1/-1}}

/* ---- integrity ---- */
.hasheq{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:baseline;font:400 12px/1.5 var(--mono)}
.hasheq .eq{color:var(--green);font-size:16px}.hasheq .ne{color:var(--red);font-size:16px}
.problems{margin:12px 0 0;padding-left:18px;color:var(--red);font:400 12px/1.6 var(--mono)}

/* ---- recordings ---- */
.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:clamp(18px,4vw,48px);align-items:end;padding:clamp(10px,3vw,30px) 0 0}
.hero h1{font:700 clamp(46px,8.4vw,104px)/.86 var(--display);letter-spacing:.005em;text-transform:uppercase}
.hero h1 em{font-style:normal;color:var(--orange)}
.hero p{color:var(--ink-2);margin:0 0 10px;max-width:60ch}
.hero .stats{display:flex;gap:22px;flex-wrap:wrap;margin-top:12px}
.hero .stat b{display:block;font:700 34px/1 var(--display);color:var(--ink)}
.hero .stat span{font:400 10.5px/1.4 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
@media (max-width:860px){.hero{grid-template-columns:1fr}}
.recs{container-type:inline-size;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.rec{display:flex;flex-direction:column;gap:12px;text-decoration:none;padding:16px;border:1px solid var(--rule);border-radius:4px;
  background:linear-gradient(180deg,var(--bg-1),oklch(.165 .006 250));transition:border-color .18s,transform .18s,background .18s}
.rec:hover{border-color:var(--rule-2);transform:translateY(-2px);background:linear-gradient(180deg,var(--bg-2),var(--bg-1))}
.rec .top{display:flex;align-items:center;gap:10px}
.rec .dot{width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 12px var(--c)}
.rec .vv{font:700 15px/1 var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--c)}
.rec .rl{font:400 11px/1 var(--mono);color:var(--ink-3)}
.rec .when{margin-left:auto;font:400 11px/1 var(--mono);color:var(--ink-3)}
.rec .model{font:600 22px/1.05 var(--display);letter-spacing:.02em;overflow-wrap:anywhere}
.rec .item{color:var(--ink-2);font-size:13px}
.rec .mini{position:relative;height:6px;background:var(--bg);border:1px solid var(--rule);border-radius:1px}
.rec .mini i{position:absolute;top:0;bottom:0;left:0;background:var(--ink-3)}
.rec .mini u{position:absolute;top:0;bottom:0;background:var(--red)}
.rec .mini s{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--amber)}
.rec .foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px dashed var(--rule);padding-top:10px;font:400 11px/1.4 var(--mono);color:var(--ink-3)}
.rec .foot b{color:var(--green);font-weight:400}
.rec .foot .live{color:var(--orange)}

/* ---- bench ---- */
.matrix{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;margin-top:18px}
.matrix a{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:9px 8px;border:1px solid var(--rule);border-radius:3px;text-decoration:none;background:var(--bg-1);font:700 15px/1 var(--display);letter-spacing:.06em}
.matrix a i{width:100%;height:4px;background:var(--c);box-shadow:0 0 10px var(--c);border-radius:1px}
.matrix a small{font:400 9.5px/1 var(--mono);letter-spacing:.08em;color:var(--green)}
.matrix a.fail small{color:var(--red)}
.matrix a:hover{border-color:var(--rule-2)}
.cases{display:grid;gap:8px}
.case{display:grid;grid-template-columns:58px minmax(0,1fr) 210px 70px;gap:16px;align-items:start;padding:14px 16px;border:1px solid var(--rule);border-radius:4px;background:var(--bg-1);text-decoration:none}
.case:hover{border-color:var(--rule-2);background:var(--bg-2)}
.case .id{font:700 22px/1 var(--display);color:var(--orange);letter-spacing:.04em}
.case h3{font:600 19px/1.15 var(--display);letter-spacing:.02em;margin-bottom:4px}
.case p{margin:0;color:var(--ink-2);font-size:13px}
.case .got{font:700 14px/1.2 var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--c)}
.case .got small{display:block;font:400 11px/1.5 var(--mono);letter-spacing:0;text-transform:none;color:var(--ink-3);margin-top:4px}
.case .res{font:700 14px/1 var(--display);letter-spacing:.12em;color:var(--c);text-align:right}
@media (max-width:760px){.case{grid-template-columns:44px minmax(0,1fr)}.case .got,.case .res{grid-column:2;text-align:left}}
.benchcard{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;margin-bottom:16px;padding:12px 16px;border:1px dashed var(--rule-2);border-radius:4px}
.benchcard .id{font:700 26px/1 var(--display);color:var(--orange)}
.benchcard h2{font:600 20px/1.15 var(--display);letter-spacing:.02em}
.benchcard p{margin:4px 0 0;color:var(--ink-2);font-size:13px}
.benchcard .res{font:700 16px/1 var(--display);letter-spacing:.12em;color:var(--c);text-align:right}
.benchcard .res small{display:block;font:400 10.5px/1.5 var(--mono);letter-spacing:0;color:var(--ink-3);margin-top:6px;max-width:28ch}
@media (max-width:760px){.benchcard{grid-template-columns:1fr}.benchcard .res{text-align:left}}

footer.foot{margin-top:72px;border-top:1px solid var(--rule);padding-top:18px;color:var(--ink-3);font:400 11px/1.7 var(--mono);letter-spacing:.04em;max-width:90ch}

/* ---- motion (CSS only) ---- */
@media (prefers-reduced-motion:no-preference){
  @supports (animation-timeline:view()){
    .sec,.rec,.case{animation:rise linear both;animation-timeline:view();animation-range:entry 0% cover 18%}
    @keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
  }
  .lampc:not(.off){animation:warm .9s ease-out both}
  @keyframes warm{from{filter:brightness(.4)}60%{filter:brightness(1.25)}to{filter:none}}
  ::view-transition-old(root),::view-transition-new(root){animation-duration:.22s}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}@view-transition{navigation:none}}
`;

function layout(title, body, { active = '' } = {}) {
  const nav = (href, text, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${text}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><a class="mark" href="/"><span class="unit" aria-hidden="true"></span>BLACK BOX</a><span class="sub">flight recorder for AI shopping agents</span>
<nav aria-label="Sections">${nav('/', 'Recordings', 'recordings')}${nav('/bench', 'Case bench', 'bench')}</nav></header>
<main id="main">${body}</main></body></html>`;
}

// Raw model input, escaped, with each hidden text marked. Whitespace may differ between the
// page and the model input, so the match is word by word.
export function highlight(text, needles) {
  const ranges = [];
  for (const n of needles) {
    const words = String(n).trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) continue;
    for (const m of text.matchAll(new RegExp(words.join('\\s+'), 'g'))) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  let out = '';
  let at = 0;
  merged.forEach(([s, e], i) => {
    out += esc(text.slice(at, s)) + `<mark${i === 0 ? ' id="hidden"' : ''}>${esc(text.slice(s, e))}</mark>`;
    at = e;
  });
  return { html: out + esc(text.slice(at)), count: merged.length };
}

export const pageHtml = (record) => Buffer.from(record.fetches[record.purchase.page_index].body_b64, 'base64').toString('utf8');
const decisionOf = (record) => record.decisions.at(-1) ?? {};
const chip = (state, text) => `<span class="chip ${state}">${esc(text)}</span>`;
const buyerCredit = (p) => p?.after?.moneyMovements.find((m) => m.party === 'BUYER' && m.type === 'CREDIT');

const paypalStatus = (p) => {
  const credit = buyerCredit(p);
  if (credit) return `${money(credit.amount.cents, credit.amount.currency)} refunded to the buyer`;
  return p.executed ? `${p.executed.action} sent` : `${p.after?.status ?? 'open'}, not yet acted on`;
};

const planText = (plan) => (plan.action === 'none' ? 'No automatic action' : `${plan.action}${plan.refundCents ? ' ' + money(plan.refundCents) : ''}`);
const expectText = (e) => `${label(e.verdict)}, rule ${e.rule}, ${e.action}${e.refundCents ? ' ' + money(e.refundCents) : ''}${e.broken?.length ? `; breaks ${e.broken.join(', ')}` : ''}`;

// Price against budget, as fractions of a common scale, for the gauges.
function gaugeScale(paidCents, capCents) {
  const scale = Math.max(paidCents, capCents) * 1.12 || 1;
  const pct = (c) => `${((c / scale) * 100).toFixed(2)}%`;
  return { fill: pct(Math.min(paidCents, capCents)), cap: pct(capCents), overFrom: pct(capCents), overW: pct(Math.max(0, paidCents - capCents)), over: paidCents > capCents };
}

function mandateSentence(m) {
  const a = m.item?.attributes ?? {};
  const what = [a.color, m.item?.category].filter(Boolean).join(' ');
  const size = a.size ? `, size ${a.size}` : '';
  return `Buy one ${what}${size}, at most ${money(m.maxTotalCents, m.currency)}${m.signedShopsOnly ? ', from shops that sign their pages' : ''}.`;
}

// ---------------------------------------------------------------- recordings

// intro: optional HTML shown above the list (the public site uses it).
export function indexPage(rows, { intro = '' } = {}) {
  const live = rows.filter(({ c }) => c.paypal?.executed).length;
  const cards = rows.map(({ c, j }) => {
    const d = decisionOf(c.record);
    const v = j.verdict.verdict;
    const paid = j.order.capturedCents;
    const cap = c.record.mandate.maxTotalCents;
    const g = gaugeScale(paid, cap);
    return `<a class="rec ${v}" href="/case/${c.hash}">
<div class="top"><span class="dot" style="view-transition-name:${vtName(c.hash)}"></span><span class="vv">${label(v)}</span><span class="rl">rule ${j.verdict.rule}</span><span class="when">${day(c.record.purchase.at)}</span></div>
<div class="model">${esc(d.model ?? 'unknown model')}</div>
<div class="item">${esc(j.product?.name ?? c.record.purchase.sku)} · ${money(paid)} <span class="k">on a ${money(cap)} budget</span></div>
<div class="mini" aria-hidden="true"><i style="width:${g.fill}"></i>${g.over ? `<u style="left:${g.overFrom};width:${g.overW}"></u>` : ''}<s style="left:${g.cap}"></s></div>
<div class="foot">${c.paypal ? `<span class="live">PAYPAL ${esc(c.paypal.disputeId)}</span><b>${esc(paypalStatus(c.paypal))}</b>` : `<span>PREVIEW · no dispute</span><span>${esc(planText(j.plan))}</span>`}</div></a>`;
  }).join('');
  const empty = '<p class="empty">No recordings yet. Run the agent (node agent/run.mjs) to make one.</p>';
  return layout('Black Box · recordings', `${intro || `<section class="hero"><div><div class="eyebrow"><b>●</b> Recordings</div><h1>Every purchase, <em>on tape</em></h1></div>
<div><p>Each recording is what an AI shopping agent saw and decided, sealed into its PayPal order. Open one to replay it and see who pays.</p></div></section>`}
<section class="sec"><header><span class="n">${String(rows.length).padStart(2, '0')}</span><h2>Recordings</h2>${live ? `<p>${live} ${live === 1 ? 'was' : 'were'} disputed and settled through PayPal in the sandbox.</p>` : ''}</header>
<div class="recs">${cards || empty}</div></section>`, { active: 'recordings' });
}

// ---------------------------------------------------------------- case

function causePanel(c, j) {
  const p = c.paypal;
  if (!p) {
    return `<div class="eyebrow">Preview · no dispute filed</div>
<div class="amt">${esc(planText(j.plan))}<small>if disputed as ${esc(j.reason.replaceAll('_', ' ').toLowerCase())}</small></div>
<p class="k" style="margin:4px 0 0;font-size:12.5px">${esc(j.plan.note)}</p>`;
  }
  const credit = buyerCredit(p);
  const refund = p.after?.refundTransactions?.[0];
  return `<div class="eyebrow"><b>●</b> PayPal ${p.executed ? 'carried it out' : 'dispute open'}</div>
${p.executed ? `<div class="amt">${credit ? money(credit.amount.cents, credit.amount.currency) : esc(p.executed.action)}<small>${credit ? 'back to the buyer' : 'sent to PayPal'}</small></div>` : `<div class="amt">${esc(planText(j.plan))}<small>planned, not yet executed</small></div>`}
<div class="kv"><span>dispute</span><b>${esc(p.disputeId)}</b>
${p.executed ? `<span>action</span><b>${esc(p.executed.action)} · HTTP ${esc(p.executed.httpStatus)}</b><span>at</span><b>${time(p.executed.at)}</b>` : ''}
${refund ? `<span>refund</span><b>${esc(refund.id)}</b>` : ''}
${p.trigger ? `<span>trigger</span><b>${esc(p.trigger)}</b>` : ''}
${p.after?.outcome ? `<span>closed</span><b>${esc(p.after.outcome.code)}${p.after.outcome.reason ? ` · ${esc(p.after.outcome.reason)}` : ''}</b>` : ''}</div>`;
}

function tape(c, j) {
  const r = c.record;
  const items = [];
  r.fetches.forEach((f) => items.push([f.fetched_at, 'Fetch', `<span class="mono">${esc(f.path)}</span> from ${esc(f.authority)} · signature ${f.verification?.ok ? `valid <span class="k mono">key ${short(f.verification.keyid)}</span>` : '<span style="color:var(--red)">invalid</span>'}`]));
  r.model_inputs.forEach((m) => items.push([m.at, 'Model in', `${m.text.length.toLocaleString('en-US')} characters sent to the model <span class="k mono">sha256 ${short(m.sha256)}</span>`]));
  r.decisions.forEach((d) => items.push([d.at, 'Decision', `<b>${esc(d.model)}</b>: ${esc(d.action)} <span class="mono">${esc(d.sku ?? '')}</span>`, true]));
  items.push([r.purchase.at, 'Seal', `Record sealed, sent to checkout at ${money(r.purchase.price_cents)} <span class="k mono">custom_id ${short(c.hash)}</span>`]);
  const p = c.paypal;
  if (p) {
    if (p.orderCreatedAt) items.push([p.orderCreatedAt, 'Order', `PayPal order <span class="mono">${esc(p.orderId)}</span>, capture <span class="mono">${esc(p.captureId)}</span> ${money(p.captured?.cents)}`]);
    items.push([p.filedAt, 'Dispute', `${c.bench ? 'Bench dispute' : 'Buyer filed'} <span class="mono">${esc(p.disputeId)}</span>: ${esc(p.reason)}`]);
    if (p.executed) items.push([p.executed.at, 'Verdict', `<b>${label(j.verdict.verdict)}</b> (rule ${j.verdict.rule}), Black Box sent <span class="mono">${esc(p.executed.action)}</span>`, true]);
    for (const m of p.after?.moneyMovements ?? []) items.push([p.executed?.at, 'Money', `${esc(m.party)} ${esc(m.type)} ${money(m.amount?.cents)} <span class="k">${esc(m.reason)}</span>`]);
    if (p.after?.outcome) items.push([p.after.updatedAt, 'Closed', `<b>${esc(p.after.outcome.code)}</b> ${esc(p.after.outcome.reason ?? '')}${p.after.outcome.refunded ? `, ${money(p.after.outcome.refunded.cents)} refunded` : ''}`, true]);
  }
  return `<ol class="tape">${items.map(([at, ev, h, hot]) => `<li${hot ? ' class="hot"' : ''}><span class="t" title="${time(at)}">${clock(at)}</span><span class="ev">${ev}</span><span>${h}</span></li>`).join('')}</ol>`;
}

function section(n, title, note, body) {
  return `<section class="sec"><header><span class="n">${n}</span><h2>${title}</h2>${note ? `<p>${note}</p>` : ''}</header>${body}</section>`;
}

export function casePage(c, j) {
  const r = c.record;
  const d = decisionOf(r);
  const v = j.verdict.verdict;
  const needles = [...j.findings.filter((f) => f.inModelInput).map((f) => f.text), ...(j.flagger?.passages ?? []).map((p) => p.quote)];
  const inputs = r.model_inputs.map((m) => highlight(m.text, needles));
  const marked = inputs.reduce((n, i) => n + i.count, 0);
  const m = r.mandate;
  const integrity = RECORD_CHECKS.every((k) => j.facts[k]);
  const pageSrc = `${c.bench ? `/bench/${esc(c.bench.id)}` : `/case/${c.hash}`}/page`;

  const b = c.benchResult;
  const benchCard = b ? `<section class="benchcard ${b.pass ? 'PASS' : 'FAIL'}"><span class="id">${esc(b.def.id)}</span>
<div><div class="eyebrow"><a href="/bench">Case bench</a> · ${esc(b.def.kind)}</div><h2>${esc(b.def.title)}</h2><p>${esc(b.def.story)}</p>
${b.mismatches.map((x) => `<p style="color:var(--red)">${esc(x)}</p>`).join('')}</div>
<div class="res">${b.pass ? 'PASS' : 'FAIL'}<small>expected ${esc(expectText(b.def.expect))}</small></div></section>` : '';

  const crumbs = `<div class="crumbs"><span>Recording <b>${short(c.hash, 16)}</b></span><span>Agent <b>${esc(d.model ?? 'unknown')}</b></span>
<span>Bought <b>${time(r.purchase.at)}</b></span>${c.paypal ? `<span>PayPal <b>${esc(c.paypal.disputeId)}</b></span>` : ''}</div>`;

  const cause = `<section class="cause ${v}" style="view-transition-name:${vtName(c.hash)}"><div class="main">
<div class="eyebrow">Probable cause · rule ${j.verdict.rule} of ${RULES.length}${j.preview ? ' · preview' : ''}</div>
<h1 class="v">${label(v)}</h1><p class="who">${WHO[v]}</p><p class="why">${esc(j.verdict.why)}</p></div>
<div class="pp">${causePanel(c, j)}</div></section>`;

  // 1. the mandate and the money
  const paid = j.order.capturedCents;
  const g = gaugeScale(paid, m.maxTotalCents);
  const seal = j.mandateAuth?.legacy
    ? '<span class="seal legacy">Unsigned · order predates passkey mandates</span>'
    : j.facts.mandateSigned ? `<span class="seal ok">◆ Passkey · ${esc(j.mandateAuth?.reason ?? 'approved')}</span>` : `<span class="seal bad">✕ Passkey · ${esc(j.mandateAuth?.reason ?? 'not approved')}</span>`;
  const overLine = j.mandate.violations.length
    ? j.mandate.violations.map((x) => `<div class="verdictline bad">✕ ${esc(x.code === 'OVER_CAP' ? `Over budget: paid ${money(paid)}, cap ${money(m.maxTotalCents)}, ${money(paid - m.maxTotalCents)} over` : `${x.code}: ${x.detail}`)}</div>`).join('')
    : '<div class="verdictline good">✓ Within the mandate</div>';
  const mandate = section('1.0', 'The mandate', 'What the user let the agent do, and what it actually spent.', `<div class="grid2">
<div class="panel"><div class="eyebrow">Authorised</div><p class="mandate-line">${esc(mandateSentence(m))}</p>${seal}
<div class="k mono" style="margin-top:12px">mandate sha256 ${short(r.mandate_hash, 20)}</div></div>
<div class="panel"><div class="eyebrow">Spent</div><p class="mandate-line">${esc(j.product?.name ?? r.purchase.sku)} · ${money(paid)}</p>
<div class="gauge"><div class="track" role="img" aria-label="Paid ${money(paid)} against a budget of ${money(m.maxTotalCents)}"><div class="fill" style="width:${g.fill}"></div>${g.over ? `<div class="over" style="left:${g.overFrom};width:${g.overW}"></div>` : ''}<div class="cap" style="left:${g.cap}"></div></div>
<div class="legend"><span>budget <b>${money(m.maxTotalCents)}</b></span><span>paid <b>${money(paid)}</b></span></div></div>${overLine}</div></div>`);

  // 2. the two channels
  const found = j.findings.find((f) => f.inModelInput && f.namesPurchasedItem) ?? j.findings.find((f) => f.inModelInput);
  const flagged = j.flaggedPassages.find((p) => p.namesPurchasedItem);
  const hiddenRead = found ?? (flagged && { text: flagged.quote, method: 'flagged by the AI flagger; code did not find it hidden' });
  const contrast = `<div class="contrast"><div class="panel"><div class="ch"><i>CH 1</i>Shown to a person</div>
<div class="price">${money(j.product?.priceCents ?? r.purchase.price_cents)}<small>${esc(j.product?.name ?? r.purchase.sku)}</small></div></div>
<div class="panel"><div class="ch two"><i>CH 2</i>${hiddenRead ? `Hidden from people, read by the agent · ${esc(hiddenRead.method)}` : 'Read by the agent'}</div>
${hiddenRead ? `<blockquote><mark>“${esc(hiddenRead.text)}”</mark></blockquote>` : '<p class="empty">Nothing hidden that names this item.</p>'}</div></div>`;
  const channels = section('2.0', 'Two channels', 'The page a shopper sees and the text the model received, side by side.', `${contrast}<div class="grid2">
<div><div class="ch"><i>CH 1</i>The signed page, as a shopper sees it · scripts off</div>
<iframe sandbox="" referrerpolicy="no-referrer" loading="lazy" title="Recorded product page" src="${pageSrc}"></iframe></div>
<div><div class="ch two"><i>CH 2</i>Exact model input, from the record${marked ? `<a href="#hidden">${marked} hidden passage${marked > 1 ? 's' : ''} highlighted ↓</a>` : ''}</div>
<pre class="input" tabindex="0">${inputs.map((i) => i.html).join('\n\n')}</pre></div></div>
${d.reason ? `<div class="cvr"><span class="who">${esc(d.model)}</span><p>“${esc(d.reason)}”</p></div>` : ''}`);

  // 3. hidden text and the flagger
  const findings = j.findings.length ? j.findings.map((f) => `<div class="panel finding"><div class="eyebrow">Hidden by <b>${esc(f.method)}</b>${f.thirdPartyIssuer ? ` · signed by third party ${esc(f.thirdPartyIssuer)}` : ''}</div>
<q>${esc(f.text)}</q><div class="chips">${chip(f.concealedInReadChannel ? 'on' : '', 'Hidden from people')}${chip(f.namesPurchasedItem ? 'on' : '', 'Names the item')}
${chip(f.inModelInput ? 'on' : '', 'Reached the model')}${chip(f.signedByMerchant ? 'on' : '', 'Merchant-signed')}${chip(f.selfContained ? 'on' : '', 'Self-contained page')}${chip(f.thirdPartySigned ? 'bad' : 'on', f.thirdPartySigned ? 'Third-party signature' : 'No third party')}</div></div>`).join('')
    : '<div class="panel"><p class="empty">Code found no hidden text on the purchased page.</p></div>';
  const flagger = j.flagger ? `<div class="panel" style="margin-top:12px"><div class="eyebrow">AI flagger · <b>${esc(j.flagger.model)}</b> · can only send a case to a person</div>
${j.flaggedPassages.length ? j.flaggedPassages.map((p) => `<q class="finding" style="display:block;margin:12px 0 8px">${esc(p.quote)}</q><div class="k" style="font-size:12.5px;margin-bottom:8px">${esc(p.reason)}</div>
<div class="chips">${chip('ok', 'Found word for word in the model input')}${chip(p.namesPurchasedItem ? 'on' : '', p.namesPurchasedItem ? 'Names the item bought: counts' : 'Other product: ignored for this purchase')}</div>`).join('') : '<p class="empty" style="margin-top:10px">Found no text aimed at automated buyers.</p>'}</div>`
    : '<div class="panel" style="margin-top:12px"><p class="empty">AI flagger not run for this case: the verdict is code-only.</p></div>';
  const hidden = section('3.0', 'Hidden text', 'What code found concealed on the page, and what the AI flagger quoted.', findings + flagger);

  // 4. annunciator panel
  const group = (title, keys) => `<div><h3>${title}</h3><div class="lamps">${keys.map((k) => `<div class="lampc ${lamp(k, j.facts[k])}" title="${esc(FACT[k][1])}" role="img" aria-label="${esc(FACT[k][1])}: ${j.facts[k]}">${esc(FACT[k][0])}<small>${j.facts[k] ? 'TRUE' : 'FALSE'}</small></div>`).join('')}</div></div>`;
  const panel = section('4.0', 'Annunciator', 'The 13 facts code checked. Green holds, red failed, amber cautions, orange points at the merchant.', `<div class="panel ann"><div class="groups">
${group('Record integrity', RECORD_CHECKS)}${group('Mandate', ['mandateBroken'])}${group('Merchant cause · all four', MERCHANT_CONDITIONS)}${group('Other signals', SIGNALS)}</div></div>`);

  // 5. decision ladder
  const ladder = section('5.0', 'Decision', 'Six rules, written as code. Exactly one fires, checked over every combination of the facts.', `<ol class="ladder">
${RULES.map((rule) => `<li class="${rule.verdict}${rule.n === j.verdict.rule ? ' fired' : ''}"><span class="n">${rule.n}</span><span class="tag">${label(rule.verdict)}</span><span>${esc(rule.why)}</span></li>`).join('')}</ol>`);

  // 6. tape and integrity
  const tapeSec = section('6.0', 'Recorder tape', 'Every event, from the first page fetched to the money moving.', `<div class="panel">${tape(c, j)}</div>`);
  const same = c.hash === j.order.customId;
  const proof = section('7.0', 'Integrity', 'The record hash must equal the custom_id PayPal holds, which cannot change after payment.', `<div class="panel">
<div class="hasheq"><span class="k">record</span><span>${esc(c.hash)}</span><span class="${same ? 'eq' : 'ne'}">${same ? '=' : '≠'}</span><span></span><span class="k">PayPal</span><span>${esc(j.order.customId ?? '')}</span></div>
<div class="chips" style="margin-top:14px">${chip(same ? 'ok' : 'bad', same ? 'Hashes equal' : 'Hashes differ')}${chip(integrity ? 'ok' : 'bad', integrity ? 'All record checks pass' : 'Record broken')}</div>
${j.integrityProblems.length ? `<ul class="problems">${j.integrityProblems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<div class="k mono" style="margin-top:12px">source ${esc(c.source)}</div></div>`);

  return layout(`${label(v)} · ${d.model ?? 'replay'} · Black Box`, `${benchCard}${crumbs}${cause}${mandate}${channels}${hidden}${panel}${ladder}${tapeSec}${proof}`, { active: c.bench ? 'bench' : 'recordings' });
}

// ---------------------------------------------------------------- bench

const SECTIONS = [
  ['recorded', 'Recorded runs', "Real agent runs, sealed by the recorder, with the model's own output."],
  ['passkey', 'Passkey mandates', 'The buyer approved the budget with Touch ID. Records after the passkey cutoff must carry that approval.'],
  ['flagger', 'The AI flagger', 'Its real, recorded answers. It can only send a case to a person, and only quotes that name the item bought count.'],
  ['attack', 'Attacks on the record', 'A real record with one thing forged or swapped. Each must fail exactly the checks named.'],
];

export function benchPage(results) {
  const passed = results.filter((r) => r.pass).length;
  const all = passed === results.length;
  const matrix = `<div class="matrix">${results.map((r) => `<a class="${r.got.verdict}${r.pass ? '' : ' fail'}" href="/bench/${esc(r.def.id)}" title="${esc(r.def.title)}">${esc(r.def.id)}<i></i><small>${r.pass ? 'PASS' : 'FAIL'}</small></a>`).join('')}</div>`;
  const row = (r) => `<a class="case" href="/bench/${esc(r.def.id)}"><span class="id">${esc(r.def.id)}</span>
<div><h3>${esc(r.def.title)}</h3><p>${esc(r.def.story)}</p></div>
<div class="got ${r.got.verdict}">${label(r.got.verdict)} · rule ${r.got.rule}<small>${esc(r.got.action === 'none' ? 'no automatic action' : r.got.action)}${r.got.refundCents ? ' ' + money(r.got.refundCents) : ''} · ${esc(r.def.reason.replaceAll('_', ' ').toLowerCase())}${r.got.broken ? `<br>breaks ${esc(r.got.broken)}` : ''}</small></div>
<div class="res ${r.pass ? 'PASS' : 'FAIL'}">${r.pass ? 'PASS' : 'FAIL'}${r.mismatches.map((x) => `<small style="display:block;color:var(--red);font:400 10px/1.4 var(--mono)">${esc(x)}</small>`).join('')}</div></a>`;
  const n = (i) => `${i + 1}.0`;
  return layout('Black Box · case bench', `<section class="hero"><div><div class="eyebrow"><b>●</b> Case bench · offline, no keys</div>
<h1><em style="color:var(--${all ? 'green' : 'red'})">${passed}/${results.length}</em> cases<br>exactly as expected</h1></div>
<div><p>Each case fixes in advance the verdict, the rule and the PayPal action code must produce, and for attacks exactly which record checks must fail. Every verdict and every rule is covered. Re-run it with <span class="mono">npm run bench</span>.</p>${matrix}</div></section>
${SECTIONS.map(([kind, title, note], i) => section(n(i), title, note, `<div class="cases">${results.filter((r) => r.def.kind === kind).map(row).join('')}</div>`)).join('')}`, { active: 'bench' });
}
