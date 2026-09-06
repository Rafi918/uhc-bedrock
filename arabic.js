// UHC Core - Arabic shaping: Unicode → Presentation Forms + RTL reorder
const M = "ء:FE80|آ:FE81,FE82|أ:FE83,FE84|ؤ:FE85,FE86|إ:FE87,FE88|ئ:FE89,FE8A,FE8B,FE8C|ا:FE8D,FE8E|ب:FE8F,FE90,FE91,FE92|ة:FE93,FE94|ت:FE95,FE96,FE97,FE98|ث:FE99,FE9A,FE9B,FE9C|ج:FE9D,FE9E,FE9F,FEA0|ح:FEA1,FEA2,FEA3,FEA4|خ:FEA5,FEA6,FEA7,FEA8|د:FEA9,FEAA|ذ:FEAB,FEAC|ر:FEAD,FEAE|ز:FEAF,FEB0|س:FEB1,FEB2,FEB3,FEB4|ش:FEB5,FEB6,FEB7,FEB8|ص:FEB9,FEBA,FEBB,FEBC|ض:FEBD,FEBE,FEBF,FEC0|ط:FEC1,FEC2,FEC3,FEC4|ظ:FEC5,FEC6,FEC7,FEC8|ع:FEC9,FECA,FECB,FECC|غ:FECD,FECE,FECF,FED0|ف:FED1,FED2,FED3,FED4|ق:FED5,FED6,FED7,FED8|ك:FED9,FEDA,FEDB,FEDC|ل:FEDD,FEDE,FEDF,FEE0|م:FEE1,FEE2,FEE3,FEE4|ن:FEE5,FEE6,FEE7,FEE8|ه:FEE9,FEEA,FEEB,FEEC|و:FEED,FEEE|ى:FEEF,FEF0|ي:FEF1,FEF2,FEF3,FEF4";
const T = {};
for (const e of M.split("|")) {
  const [c, v] = e.split(":");
  T[c] = v.split(",").map(h => String.fromCharCode(parseInt(h, 16)));
}
const LA = { "ا":["\uFEFB","\uFEFC"], "أ":["\uFEF7","\uFEF8"],
             "إ":["\uFEF9","\uFEFA"], "آ":["\uFEF5","\uFEF6"] };
const MIRROR = { "(":")", ")":"(", "[":"]", "]":"[", "<":">", ">":"<", "{":"}", "}":"{" };
const RE_AR = /[\u0600-\u06FF]/;
const isAr = c => /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(c);
const isMark = c => /[\u064B-\u0652\u0670\u0640]/.test(c);
const joinF = c => !!T[c] && T[c].length === 4;   // يوصل للي بعده
const joinB = c => !!T[c] && T[c].length >= 2;    // يتوصل من قبله

function shape(s) {
  const cs = [...s].filter(c => !isMark(c));
  const out = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], n = cs[i + 1], pv = cs[i - 1];
    if (c === "ل" && n && LA[n]) {
      out.push(LA[n][(pv && joinF(pv)) ? 1 : 0]);
      i++; continue;
    }
    const t = T[c];
    if (!t) { out.push(c); continue; }
    const pj = !!pv && joinF(pv) && t.length >= 2;
    const nj = !!n && joinB(n) && t.length === 4;
    out.push((pj && nj) ? t[3] : pj ? t[1] : nj ? t[2] : t[0]);
  }
  return out.join("");
}

const cache = new Map();

export function ar(text) {
  if (text === undefined || text === null) return text;
  const s = String(text);
  if (!RE_AR.test(s)) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;

  const runs = [];
  let style = "", cur = null;
  const push = (ch, ty) => {
    if (cur && cur.style === style && cur.type === ty) cur.text += ch;
    else { cur = { style, type: ty, text: ch }; runs.push(cur); }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "§" && i + 1 < s.length) {
      const k = s[i + 1].toLowerCase();
      if ("0123456789abcdef".includes(k)) style = "§" + k;
      else if ("lomnkr".includes(k)) style += "§" + k;
      i++; cur = null; continue;
    }
    push(MIRROR[c] ?? c, isAr(c) ? "ar" : "ltr");
  }
  for (const r of runs) if (r.type === "ar") r.text = [...shape(r.text)].reverse().join("");
  runs.reverse();
  const res = runs.map(r => r.style + r.text).join("");
  if (cache.size > 1200) cache.clear();
  cache.set(s, res);
  return res;
}

export function arRaw(t) { return shape(String(t)); }
