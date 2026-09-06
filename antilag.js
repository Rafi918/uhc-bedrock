// ============================================================================
//  UHC Core - مضاد اللاج (مخفف — السيرفر قوي)
//  🔧 الجديد: XP له فلتر عمر (كان ينمسح بلا شرط = إنشانتات تضيع)
//     │ ما نلمس تكدس فيه لاعب قريب │ سقف عمر للسهام
// ============================================================================
import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";

const firstSeen = new Map();
const WHITELIST = new Set(CONFIG.itemWhitelist);

const HOSTILE = [
  "minecraft:zombie", "minecraft:skeleton", "minecraft:creeper",
  "minecraft:spider", "minecraft:cave_spider", "minecraft:enderman",
  "minecraft:witch", "minecraft:slime", "minecraft:drowned",
  "minecraft:husk", "minecraft:stray", "minecraft:phantom",
  "minecraft:magma_cube", "minecraft:zombified_piglin",
];

function entities(dim, types) {
  const out = [];
  for (const t of types) {
    try { out.push(...dim.getEntities({ type: t })); } catch {}
  }
  return out;
}

function ageOf(entity, now) {
  const id = entity.id;
  let t = firstSeen.get(id);
  if (t === undefined) { firstSeen.set(id, now); t = now; }
  return now - t;
}

function itemTypeOf(entity) {
  try { return entity.getComponent("minecraft:item")?.itemStack?.typeId ?? null; }
  catch { return null; }
}

function speedOf(entity) {
  try {
    const v = entity.getVelocity();
    return Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
  } catch { return 1; }
}

export const AntiLag = {
  lastReport: { itemsCleared: 0, xpCleared: 0, projCleared: 0, mobsCleared: 0, at: 0 },

  run() {
    const now = Date.now();
    const report = { itemsCleared: 0, xpCleared: 0, projCleared: 0, mobsCleared: 0, at: now };
    const alive = new Set();

    // مواقع اللاعبين (حتى ما نمسح وحوش/لوت قريب منهم)
    const playerLocs = [];
    for (const p of world.getPlayers()) {
      try { playerLocs.push({ dim: p.dimension.id, x: p.location.x, z: p.location.z }); } catch {}
    }
    const nearPlayer = (dimId, loc, radius) => playerLocs.some(pl =>
      pl.dim === dimId &&
      Math.abs(pl.x - loc.x) < radius && Math.abs(pl.z - loc.z) < radius);

    for (const dimName of CONFIG.antiLagDimensions) {
      let dim;
      try { dim = world.getDimension(dimName); } catch { continue; }
      const dimId = dim.id;

      // 1) أيتمات: الأقدم أولاً + عمر أدنى + whitelist
      const items = entities(dim, ["minecraft:item"]);
      for (const e of items) alive.add(e.id);
      if (items.length > CONFIG.itemCap) {
        const cand = items
          .map(e => ({ e, age: ageOf(e, now), type: itemTypeOf(e) }))
          .filter(o => o.age >= CONFIG.itemMinAgeMs && !WHITELIST.has(o.type))
          .sort((a, b) => b.age - a.age);
        let toRemove = items.length - CONFIG.itemCap;
        for (const o of cand) {
          if (toRemove <= 0) break;
          try { o.e.remove(); toRemove--; report.itemsCleared++; } catch {}
        }
      }

      // 2) XP — 🔧 نفس حماية الأيتمات (قبل كان يمسح أول اللي يرجع)
      const orbs = entities(dim, ["minecraft:xp_orb"]);
      for (const e of orbs) alive.add(e.id);
      if (orbs.length > CONFIG.xpOrbCap) {
        const cand = orbs
          .map(e => ({ e, age: ageOf(e, now) }))
          .filter(o => o.age >= CONFIG.xpOrbMinAgeMs)
          .sort((a, b) => b.age - a.age);
        let toRemove = orbs.length - CONFIG.xpOrbCap;
        for (const o of cand) {
          if (toRemove <= 0) break;
          try { o.e.remove(); toRemove--; report.xpCleared++; } catch {}
        }
      }

      // 3) مقذوفات عالقة بس
      const projs = entities(dim, ["minecraft:arrow", "minecraft:trident"]);
      for (const e of projs) alive.add(e.id);
      if (projs.length > CONFIG.projectileCap) {
        const stuck = projs
          .map(e => ({ e, age: ageOf(e, now), v: speedOf(e) }))
          .filter(o => o.v <= CONFIG.projectileStuckSpeed && o.age >= CONFIG.projectileMinAgeMs)
          .sort((a, b) => b.age - a.age);
        let toRemove = projs.length - CONFIG.projectileCap;
        for (const o of stuck) {
          if (toRemove <= 0) break;
          try { o.e.remove(); toRemove--; report.projCleared++; } catch {}
        }
      }

      // 4) تكدس الوحوش
      const mobs = entities(dim, HOSTILE).filter(e => {
        try { return !e.nameTag; } catch { return true; }
      });
      const cell = Math.max(2, CONFIG.monsterClusterRadius * 2);
      const clusters = new Map();
      for (const m of mobs) {
        let k, loc;
        try {
          loc = m.location;
          k = `${Math.floor(loc.x / cell)}:${Math.floor(loc.z / cell)}`;
        } catch { continue; }
        if (!clusters.has(k)) clusters.set(k, { list: [], loc });
        clusters.get(k).list.push(m);
      }
      for (const { list, loc } of clusters.values()) {
        if (list.length <= CONFIG.monsterClusterCap) continue;
        // 🔧 لاعب قريب؟ خلي الوحوش — لوته
        if (nearPlayer(dimId, loc, CONFIG.mobKeepNearPlayer)) continue;
        let toRemove = list.length - CONFIG.monsterClusterCap;
        for (const e of list) {
          if (toRemove <= 0) break;
          try { e.remove(); toRemove--; report.mobsCleared++; } catch {}
        }
      }
    }

    if (firstSeen.size > 6000) {
      for (const id of [...firstSeen.keys()]) if (!alive.has(id)) firstSeen.delete(id);
    }

    this.lastReport = report;
    const total = report.itemsCleared + report.xpCleared + report.projCleared + report.mobsCleared;
    if (total > 0) {
      console.warn(`[UHC AntiLag] items=${report.itemsCleared} xp=${report.xpCleared} proj=${report.projCleared} mobs=${report.mobsCleared}`);
    }
    return report;
  },
};
