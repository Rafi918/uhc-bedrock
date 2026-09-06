// UHC Core - كشف الغش السلوكي
// ⚠️ كشف مو منع: البيدروك ما يسمح بإخفاء بيانات البلوكات (ماكو anti-xray حقيقي)
//    نراقب النِسَب والسلوك ونبلّغ الادارة — القرار النهائي بيدك
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";

const STONEY = new Set([
  "minecraft:stone","minecraft:deepslate","minecraft:cobblestone","minecraft:cobbled_deepslate",
  "minecraft:andesite","minecraft:diorite","minecraft:granite","minecraft:tuff",
  "minecraft:dirt","minecraft:gravel","minecraft:netherrack","minecraft:basalt",
  "minecraft:blackstone","minecraft:end_stone","minecraft:sand","minecraft:sandstone",
  "minecraft:calcite","minecraft:smooth_basalt","minecraft:dripstone_block",
]);

const ORE = {
  diamond: ["minecraft:diamond_ore","minecraft:deepslate_diamond_ore"],
  debris:  ["minecraft:ancient_debris"],
  gold:    ["minecraft:gold_ore","minecraft:deepslate_gold_ore","minecraft:nether_gold_ore"],
  emerald: ["minecraft:emerald_ore","minecraft:deepslate_emerald_ore"],
};
const ORE_OF = {};
for (const [k, v] of Object.entries(ORE)) for (const id of v) ORE_OF[id] = k;

const st = new Map();   // name -> إحصاء
const flagged = new Map();

function rec(name) {
  let s = st.get(name);
  if (!s) {
    s = { stone:0, diamond:0, debris:0, gold:0, emerald:0,
          hidden:0, breaks:[], lastReport:0, maxDia:0 };
    st.set(name, s);
  }
  return s;
}

let notify = null;
export function setNotify(fn) { notify = fn; }

function report(name, kind, text) {
  const s = rec(name);
  const now = Date.now();
  const key = `${name}:${kind}`;
  const last = flagged.get(key) ?? 0;
  if (now - last < (CONFIG.acReportCooldownMs ?? 120000)) return;
  flagged.set(key, now);
  s.lastReport = now;
  console.warn(`[UHC-AC] ${name} :: ${kind} :: ${text}`);
  if (notify) { try { notify(name, kind, text); } catch {} }
}

// عرق مدفون كامل = مؤشر x-ray قوي
function buriedFaces(dim, loc) {
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  let solid = 0;
  for (const [dx,dy,dz] of dirs) {
    try {
      const b = dim.getBlock({ x: loc.x+dx, y: loc.y+dy, z: loc.z+dz });
      if (b && !b.isAir && !b.isLiquid) solid++;
    } catch {}
  }
  return solid;
}

export const AntiCheat = {
  onBreak(ev) {
    if (CONFIG.antiCheat === false) return;
    const s0 = State.data;
    if (s0.phase !== "GRACE" && s0.phase !== "PLAYING") return;
    let name, id, dim, loc;
    try {
      name = ev.player.name;
      id = ev.brokenBlockPermutation?.type?.id ?? "";
      dim = ev.dimension ?? ev.player.dimension;
      loc = ev.block?.location;
    } catch { return; }
    if (!State.isParticipant(name)) return;

    const s = rec(name);
    const now = Date.now();
    s.breaks.push(now);
    if (s.breaks.length > 40) s.breaks.shift();

    // نيوكر
    const win = s.breaks.filter(t => now - t < 1000).length;
    if (win >= (CONFIG.acNukerPerSec ?? 14))
      report(name, "nuker", `${win} بلوك بثانية واحدة`);

    if (STONEY.has(id)) { s.stone++; return; }
    const ok = ORE_OF[id];
    if (!ok) return;
    s[ok]++;

    if (CONFIG.acBuriedEnabled !== false && loc && dim && buriedFaces(dim, loc) >= 5) s.hidden++;

    if (s.stone < (CONFIG.acMinBlocks ?? 250)) return;

    const chk = [
      ["diamond", CONFIG.acXrayRatio ?? CONFIG.acDiamondRatio ?? 220, "الماس"],
      ["debris",  CONFIG.acDebrisRatio  ?? 400, "نيثرايت"],
      ["gold",    CONFIG.acGoldRatio    ?? 90,  "ذهب"],
    ];
    for (const [k, lim, ar] of chk) {
      if (s[k] < 4) continue;
      const ratio = Math.round(s.stone / s[k]);
      if (ratio < lim)
        report(name, `xray_${k}`,
          `${ar}: ${s[k]} من ${s.stone} بلوك (1:${ratio}) │ المتوقع 1:${lim}+`);
    }
    if (s.hidden >= 8 && s.hidden / Math.max(1, s.diamond + s.debris + s.gold) > 0.7)
      report(name, "xray_buried",
        `${s.hidden} عرق مدفون كامل من ${s.diamond + s.debris + s.gold}`);
  },

  onHurt(ev) {
    if (CONFIG.antiCheat === false) return;
    if (State.data.phase !== "PLAYING") return;
    try {
      const v = ev.hurtEntity, a = ev.damageSource?.damagingEntity;
      if (!a || a.typeId !== "minecraft:player" || v?.typeId !== "minecraft:player") return;
      if (String(ev.damageSource?.cause ?? "") !== "entityAttack") return;
      const dx = a.location.x - v.location.x;
      const dy = a.location.y - v.location.y;
      const dz = a.location.z - v.location.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const lim = CONFIG.acReachBlocks ?? 6.2;
      if (d > lim) report(a.name, "reach", `ضرب من ${d.toFixed(1)} بلوك (الحد ${lim})`);
    } catch {}
  },

  // تدقيق دوري للأغراض النادرة — يكشف التدبيل
  audit() {
    if (CONFIG.antiCheat === false) return;
    const s0 = State.data;
    if (s0.phase !== "GRACE" && s0.phase !== "PLAYING") return;
    const cap = CONFIG.acDiamondCap ?? 40;
    for (const p of world.getPlayers()) {
      if (!State.isParticipant(p.name)) continue;
      let dia = 0, gap = 0;
      try {
        const c = p.getComponent("minecraft:inventory")?.container;
        if (!c) continue;
        for (let i = 0; i < c.size; i++) {
          const it = c.getItem(i);
          if (!it) continue;
          const t = it.typeId;
          if (t === "minecraft:diamond" || t === "minecraft:diamond_block")
            dia += it.amount * (t.endsWith("_block") ? 9 : 1);
          else if (t === "minecraft:enchanted_golden_apple") gap += it.amount;
        }
      } catch { continue; }
      const s = rec(p.name);
      const mined = s.diamond;
      if (dia > cap && dia > mined * (CONFIG.acDupeMinedMultiplier ?? 3) + 16)
        report(p.name, "dupe_diamond",
          `${dia} الماس بالجيب بس عدّن ${mined} عرق فقط`);
      if (gap >= 3) report(p.name, "gapple", `${gap} تفاح ذهبي مسحور`);
      s.maxDia = Math.max(s.maxDia, dia);
    }
  },

  statsOf(name) {
    const s = st.get(name);
    if (!s) return null;
    const r = (k) => s[k] ? `1:${Math.round(s.stone / s[k])}` : "-";
    return `${name} │ حجر ${s.stone} │ الماس ${s.diamond} (${r("diamond")}) │ `
         + `ذهب ${s.gold} (${r("gold")}) │ نيثرايت ${s.debris} │ مدفون ${s.hidden}`;
  },

  top(limit = 8) {
    return [...st.entries()]
      .filter(([, s]) => s.stone > 60)
      .sort((a, b) => (b[1].diamond + b[1].debris) - (a[1].diamond + a[1].debris))
      .slice(0, limit)
      .map(([n]) => this.statsOf(n));
  },

  reset() { st.clear(); flagged.clear(); },
};
