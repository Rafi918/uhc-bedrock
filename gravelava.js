// gravelava.js — قبر ztp:gravestone كيان. أدون القبر ينقله بعيد لو المكان خطر،
// فنلقاه بالاسم، ونضمن إنه برّا اللافا وداخل البوردر. صفر تعديل على بلوكات العالم.
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { isOpSafe } from "./util.js";
import { cls } from "./safespot.js";

const GRAVE_ID = "ztp:gravestone";
const NETHER = "minecraft:nether";
const OW     = "minecraft:overworld";

const CFG = {
  passes: [5, 40, 90],
  rings: [4, 8, 14, 22, 32],
  yScan: 16,
  borderMargin: 40,
  sweepTicks: 1200,      // دقيقة
  nearFallback: 160,
  nearScan: 96,
};

const HOT = new Set([
  "minecraft:lava","minecraft:flowing_lava",
  "minecraft:fire","minecraft:soul_fire","minecraft:magma",
]);
const sid = (b) => { try { return b?.typeId ?? ""; } catch { return ""; } };
const get = (dim, x, y, z) => { try { return dim.getBlock({ x, y, z }); } catch { return null; } };
const yLim = (dim) => {
  try { return [dim.heightRange.min + 1, dim.heightRange.max - 2]; } catch {}
  return dim.id === NETHER ? [1, 126] : [-63, 318];
};

function borderInfo(dimId) {
  try {
    const b = State.data.border;
    const half = Number(b?.currentHalf);
    if (!Number.isFinite(half) || half <= 0) return null;
    const sc = dimId === NETHER ? (CONFIG.netherScale ?? 8) : 1;
    return { cx: (b.centerX ?? 0) / sc, cz: (b.centerZ ?? 0) / sc, half: half / sc };
  } catch { return null; }
}
export function outsideBy(dimId, x, z) {
  const b = borderInfo(dimId);
  if (!b) return 0;
  return Math.max(Math.abs(x - b.cx), Math.abs(z - b.cz)) - b.half;
}
function clampInside(dimId, x, z) {
  const b = borderInfo(dimId);
  if (!b) return { x, z };
  const inner = Math.max(8, b.half - CFG.borderMargin);
  return { x: Math.min(b.cx + inner, Math.max(b.cx - inner, x)),
           z: Math.min(b.cz + inner, Math.max(b.cz - inner, z)) };
}

function inDanger(dim, x, y, z) {
  if (HOT.has(sid(get(dim, x, y, z)))) return true;
  if (HOT.has(sid(get(dim, x, y - 1, z)))) return true;
  for (const [ax, az] of [[1,0],[-1,0],[0,1],[0,-1]])
    if (HOT.has(sid(get(dim, x + ax, y, z + az)))) return true;
  return false;
}

function groundAt(dim, x, z, yc) {
  const [lo, hi] = yLim(dim);
  for (let k = 0; k <= CFG.yScan; k++)
    for (const dy of (k === 0 ? [0] : [k, -k])) {
      const y = yc + dy;
      if (y < lo || y > hi - 1) continue;
      if (cls(dim, x, y - 1, z) !== "solid") continue;
      if (cls(dim, x, y, z) !== "air" || cls(dim, x, y + 1, z) !== "air") continue;
      if (inDanger(dim, x, y, z)) continue;
      if (outsideBy(dim.id, x, z) > 0) continue;
      return { x: x + 0.5, y, z: z + 0.5 };
    }
  return null;
}

function groundNear(dim, x0, z0, yHint) {
  const cols = [[0, 0]];
  for (const r of CFG.rings)
    for (const [dx, dz] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]])
      cols.push([dx, dz]);
  for (const [dx, dz] of cols) {
    const x = Math.floor(x0) + dx, z = Math.floor(z0) + dz;
    const hs = [];
    if (Number.isFinite(yHint)) hs.push(Math.floor(yHint));
    if (dim.id !== NETHER) { try { const tb = dim.getTopmostBlock({ x, z }); if (tb) hs.push(tb.y + 1); } catch {} }
    for (const h of hs) { const s = groundAt(dim, x, z, h); if (s) return s; }
  }
  return null;
}

/** يلقى قبر لاعب معيّن — قريب أول (أرخص)، وبعدها كل البُعد */
export function findMyGrave(name, dim = null, near = null) {
  const low = String(name ?? "").toLowerCase();
  const pick = (d, ents) => {
    let best = null;
    for (const e of ents) {
      let tag = ""; try { tag = String(e.nameTag ?? ""); } catch {}
      const mine = !!low && tag.toLowerCase().includes(low);
      const l = e.location;
      const dd = near ? Math.hypot(l.x - near.x, l.z - near.z) : 0;
      if (!mine && near && dd > CFG.nearFallback) continue;
      const score = (mine ? 0 : 1e6) + dd;
      if (!best || score < best.score)
        best = { score, mine, dist: Math.round(dd), dim: d, ent: e,
                 x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) };
    }
    return best;
  };
  const scan = (d, q) => { try { return [...d.getEntities(q)]; } catch { return []; } };

  if (dim && near) {
    const b = pick(dim, scan(dim, { location: near, maxDistance: CFG.nearScan, type: GRAVE_ID }));
    if (b?.mine) return b;
  }
  const dims = [];
  if (dim) dims.push(dim);
  for (const id of [OW, NETHER]) {
    try { const d = world.getDimension(id); if (!dims.some(q => q.id === d.id)) dims.push(d); } catch {}
  }
  let best = null;
  for (const d of dims) {
    const b = pick(d, scan(d, { type: GRAVE_ID }));
    if (b && (!best || b.score < best.score)) best = b;
  }
  return best;
}

function fixOne(dim, e, force = false) {
  const l = e.location;
  const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
  const out = outsideBy(dim.id, x, z);
  const hot = inDanger(dim, x, y, z);
  if (!force && out <= 0 && !hot) return null;

  try { e.addEffect("fire_resistance", 1200, { showParticles: false }); } catch {}
  const anchor = out > 0 ? clampInside(dim.id, x, z) : { x, z };
  const spot = groundNear(dim, anchor.x, anchor.z, out > 0 ? undefined : y);
  const why = (out > 0 ? `برّا البوردر ${Math.ceil(out)} بلوك` : "")
            + (hot ? (out > 0 ? " وبلافا" : "بلافا") : "");
  if (!spot) return { from: { x, y, z }, why, act: "no_spot" };
  try { e.teleport(spot, { dimension: dim }); } catch { return { from: { x, y, z }, why, act: "fail" }; }
  return { from: { x, y, z }, why, act: "moved",
           to: { x: Math.floor(spot.x), y: spot.y, z: Math.floor(spot.z) } };
}

/** للرسبون: يلقى القبر + يطبّق شرط اللافا والبوردر + يرجّع موقعه النهائي */
export function graveSpotFor(name, dim, near) {
  const g = findMyGrave(name, dim, near);
  if (!g) return null;
  let x = g.x, y = g.y, z = g.z, moved = false, why = "";
  try {
    const r = fixOne(g.dim, g.ent, false);
    if (r?.act === "moved") { x = r.to.x; y = r.to.y; z = r.to.z; moved = true; why = r.why; }
  } catch {}
  return { x, y, z, dim: g.dim, mine: g.mine, dist: g.dist, moved, why };
}

world.afterEvents.entityDie.subscribe((ev) => {
  try {
    const p = ev.deadEntity;
    if (!p || p.typeId !== "minecraft:player") return;
    const dim = p.dimension;
    if (dim?.id !== NETHER && dim?.id !== OW) return;
    const at = { x: p.location.x, y: p.location.y, z: p.location.z };
    const nm = p.name;
    for (const t of CFG.passes) {
      system.runTimeout(() => {
        try {
          const g = findMyGrave(nm, dim, at);
          if (!g) return;
          const r = fixOne(g.dim, g.ent, false);
          if (r?.act === "moved")
            console.warn(`[UHC] gravelava(+${t}t) ${nm}: كان ${r.why} │ `
              + `${r.from.x},${r.from.y},${r.from.z} → ${r.to.x},${r.to.y},${r.to.z} ${g.dim.id}`);
          else if (r?.act === "no_spot" || r?.act === "fail")
            console.warn(`[UHC] gravelava(+${t}t) ${nm}: فشل النقل (${r.act}) @ `
              + `${r.from.x},${r.from.y},${r.from.z} — ${r.why}`);
        } catch (e) { console.warn("[UHC] gravelava: " + (e?.message ?? e)); }
      }, Math.max(1, t));
    }
  } catch (e) { console.warn("[UHC] gravelava die: " + (e?.message ?? e)); }
});

system.runInterval(() => {
  try {
    if (CONFIG.graveSweepEnabled === false) return;      // مفتاح تجربة اللاق
    const ph = State.data.phase;
    if (ph !== "GRACE" && ph !== "PLAYING") return;
    for (const id of [OW, NETHER]) {
      let dim, ents = [];
      try { dim = world.getDimension(id); ents = [...dim.getEntities({ type: GRAVE_ID })]; }
      catch { continue; }
      for (const e of ents) {
        try {
          const r = fixOne(dim, e, false);
          if (r?.act === "moved")
            console.warn(`[UHC] gravelava sweep: كان ${r.why} │ ${r.from.x},${r.from.y},${r.from.z}`
              + ` → ${r.to.x},${r.to.y},${r.to.z} ${id}`);
        } catch {}
      }
    }
  } catch {}
}, CFG.sweepTicks);

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  try {
    const p = ev.sourceEntity;
    if (p?.typeId !== "minecraft:player") return;

    if (ev.id === "uhc:mygrave" || ev.id === "uhc:grave") {
      const g = findMyGrave(p.name, p.dimension, p.location);
      if (!g) { p.sendMessage("§7ما لقينا قبر الك"); return; }
      const dd = Math.round(Math.hypot(g.x - p.location.x, g.z - p.location.z));
      const out = outsideBy(g.dim.id, g.x, g.z);
      p.sendMessage(`§eقبرك: §f${g.x} ${g.y} ${g.z} §7(${g.dim.id === NETHER ? "النذر" : "الأوفروورلد"}`
        + `، يبعد عنك §f${dd}§7 بلوك)` + (out > 0 ? ` §cبرّا البوردر ${Math.ceil(out)}` : "")
        + (g.mine ? "" : " §8[أقرب قبر]"));
      return;
    }
    if (ev.id === "uhc:graverescue") {
      if (!isOpSafe(p)) { p.sendMessage("§cللأوبريتر بس"); return; }
      const g = findMyGrave(p.name, p.dimension, p.location);
      if (!g) { p.sendMessage("§7ماكو قبر قريب"); return; }
      const r = fixOne(g.dim, g.ent, true);
      p.sendMessage(r?.act === "moved" ? `§aنقلناه إلى §f${r.to.x} ${r.to.y} ${r.to.z}`
                                       : "§cفشل النقل — ماكو أرض آمنة");
      return;
    }
  } catch (e) { console.warn("[UHC] gravelava cmd: " + (e?.message ?? e)); }
});

console.warn("[UHC] gravelava.js جاهز (بحث بالاسم │ هامش " + CFG.borderMargin
  + " │ مسح كل " + Math.round(CFG.sweepTicks / 20) + "ث)");
