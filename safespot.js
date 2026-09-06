// safespot.js — نقطة وقوف متحقق منها + حرس الاختناق
// ⚠️ الاختناق = بلوكات صلبة فقط. حساب اللافا يسبب حلقة لا نهائية (نمسح → تسيح → نمسح).
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";

const NETHER = "minecraft:nether";
const AIR  = new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air"]);
const PASS = new Set([
  "minecraft:short_grass","minecraft:grass","minecraft:tall_grass","minecraft:fern",
  "minecraft:snow_layer","minecraft:vine","minecraft:torch","minecraft:dead_bush",
  "minecraft:red_flower","minecraft:yellow_flower","minecraft:crimson_roots",
  "minecraft:warped_roots","minecraft:nether_sprouts",
]);
const BAD = new Set([
  "minecraft:lava","minecraft:flowing_lava","minecraft:fire","minecraft:soul_fire",
  "minecraft:magma","minecraft:water","minecraft:flowing_water","minecraft:cactus",
  "minecraft:powder_snow","minecraft:campfire","minecraft:soul_campfire",
  "minecraft:sweet_berry_bush","minecraft:wither_rose","minecraft:pointed_dripstone",
]);

const band = (id) => (id === NETHER ? [6, 118] : [-60, 310]);
const mat  = (id) => (id === NETHER ? "minecraft:netherrack"
                                    : (CONFIG.platformBlock ?? "minecraft:stone"));

/** ⚰ أي بلوك عنده inventory = قبر أو صندوق — ممنوع نلمسه */
export function hasInv(b) {
  try { if (!!b.getComponent("minecraft:inventory")) return true; } catch {}
  try { return /grave|chest|barrel|shulker|hopper|furnace/i.test(b.typeId); } catch { return false; }
}

export function cls(dim, x, y, z) {
  let b, id;
  try { b = dim.getBlock({ x, y, z }); } catch { return "unknown"; }
  if (!b) return "unknown";
  try { id = b.typeId; } catch { return "unknown"; }
  if (BAD.has(id))  return "bad";
  if (AIR.has(id))  return "air";
  if (PASS.has(id)) return "pass";
  return "solid";
}
const free = (c) => c === "air" || c === "pass";

function scanColumn(dim, x, z, yc, lo, hi, R, strict) {
  let unknown = 0;
  for (let k = 0; k <= R; k++)
    for (const dy of (k === 0 ? [0] : [-k, k])) {
      const y = yc + dy;
      if (y < lo || y > hi) continue;
      const f = cls(dim, x, y, z);
      if (f === "unknown") { if (++unknown > 24) return null; continue; }
      if (f !== "solid") continue;
      if (!free(cls(dim, x, y + 1, z)) || !free(cls(dim, x, y + 2, z))) continue;
      if (strict) {
        let danger = false;
        for (const [ax, az] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          for (const ay of [0, 1, 2])
            if (cls(dim, x + ax, y + ay, z + az) === "bad") { danger = true; break; }
          if (danger) break;
        }
        if (danger) continue;
      }
      return { x: x + 0.5, y: y + 1, z: z + 0.5 };
    }
  return null;
}

function findAirGap(dim, x, z, yc, lo, hi, R) {
  for (let k = 0; k <= R; k++)
    for (const dy of (k === 0 ? [0] : [-k, k])) {
      const y = yc + dy;
      if (y < lo || y > hi - 1) continue;
      if (free(cls(dim, x, y, z)) && free(cls(dim, x, y + 1, z)))
        return { x: x + 0.5, y: y + 0.1, z: z + 0.5 };
    }
  return null;
}

const RINGS = [[3,0],[-3,0],[0,3],[0,-3],[6,6],[-6,6],[6,-6],[-6,-6],[10,0],[-10,0],[0,10],[0,-10]];

export function buildPad(dim, x0, z0, yHint) {
  const id = dim.id, [lo, hi] = band(id), m = mat(id);
  const x = Math.floor(x0), z = Math.floor(z0);
  const y = Math.max(lo + 2, Math.min(hi - 4, Math.floor(yHint ?? (id === NETHER ? 40 : 80))));
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
    try { const b = dim.getBlock({ x: x + dx, y, z: z + dz });
          if (b && !hasInv(b)) b.setType(m); } catch {}
  for (let dy = 1; dy <= 2; dy++)
    try { const b = dim.getBlock({ x, y: y + dy, z });
          if (b && !hasInv(b)) b.setType("minecraft:air"); } catch {}
  console.warn(`[UHC] safespot: منصة مبنية @ ${x},${y},${z} ${id} (ماكو مكان صالح)`);
  return { x: x + 0.5, y: y + 1, z: z + 0.5 };
}

/** يرجع دائماً مكان. mode = strict|relaxed|ring|air|pad */
export function safeSpot(dim, loc, opt = {}) {
  try {
    const R = opt.radius ?? 24;
    const [lo, hi] = band(dim.id);
    const x = Math.floor(loc?.x ?? 0), z = Math.floor(loc?.z ?? 0);
    const yc = Math.max(lo, Math.min(hi, Math.floor(loc?.y ?? 64)));

    let s = scanColumn(dim, x, z, yc, lo, hi, R, true);
    if (s) return (s.mode = "strict", s);
    s = scanColumn(dim, x, z, yc, lo, hi, R, false);
    if (s) return (s.mode = "relaxed", s);
    for (const [dx, dz] of RINGS) {
      s = scanColumn(dim, x + dx, z + dz, yc, lo, hi, R, true)
       ?? scanColumn(dim, x + dx, z + dz, yc, lo, hi, R, false);
      if (s) return (s.mode = "ring", s);
    }
    s = findAirGap(dim, x, z, yc, lo, hi, R);
    if (s && CONFIG.buildOnUnsafe === false) {
      console.warn(`[UHC] safespot: جيب هوا @ ${x},${Math.floor(s.y)},${z} ${dim.id} (بلا بناء)`);
      s.mode = "air"; return s;
    }
    const p = buildPad(dim, x, z, yc); p.mode = "pad"; return p;
  } catch (e) {
    console.warn("[UHC] safeSpot: " + (e?.message ?? e));
    const p = buildPad(dim, loc?.x ?? 0, loc?.z ?? 0, loc?.y); p.mode = "pad"; return p;
  }
}

/* ===== حرس الاختناق ===== */
const gmOf = (p) => { try { return String(p.getGameMode?.() ?? p.gameMode ?? ""); } catch { return ""; } };

export function freeIfStuck(p) {
  try {
    const dim = p.dimension, l = p.location;
    const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
    let opened = 0;
    for (const dy of [0, 1])
      try {
        const b = dim.getBlock({ x, y: y + dy, z });
        if (b && !hasInv(b) && cls(dim, x, y + dy, z) === "solid") {
          b.setType("minecraft:air"); opened++;
        }
      } catch {}
    p.teleport({ x: x + 0.5, y: y + 0.02, z: z + 0.5 }, { dimension: dim });
    try {
      p.addEffect("resistance", 100, { amplifier: 1, showParticles: false });
      p.addEffect("slow_falling", 100, { showParticles: false });
    } catch {}
    console.warn(`[UHC] فكّينا ${p.name} من داخل بلوك @ ${x},${y},${z} ${dim.id} (فتحنا ${opened})`);
    return opened > 0;
  } catch (e) { console.warn("[UHC] freeIfStuck: " + (e?.message ?? e)); return false; }
}

const st = new Map();
system.runInterval(() => {
  const now = Date.now();
  for (const p of world.getPlayers()) {
    try {
      const gm = gmOf(p);
      if (gm.includes("creative") || gm.includes("spectator")) { st.delete(p.id); continue; }
      const dim = p.dimension, l = p.location;
      const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);

      // 🔴 صلب فقط — اللافا ضرر مو حشر
      if (cls(dim, x, y, z) !== "solid" || cls(dim, x, y + 1, z) !== "solid") {
        st.delete(p.id); continue;
      }
      let r = st.get(p.id);
      if (!r) { r = { n: 0, tries: 0, mute: 0 }; st.set(p.id, r); }
      if (now < r.mute) continue;
      if (++r.n < 2) continue;
      r.n = 0;
      freeIfStuck(p);
      if (++r.tries >= 3) {
        r.tries = 0; r.mute = now + 60000;
        console.warn(`[UHC] safespot: ما كدرنا نفكّ ${p.name} @ ${x},${y},${z} ${dim.id} — تهدئة 60ث`);
      }
    } catch {}
  }
}, 20);

try { world.afterEvents.playerLeave.subscribe((ev) => st.delete(ev.playerId)); } catch {}

console.warn("[UHC] safespot.js جاهز (صلب فقط │ build="
  + (CONFIG.buildOnUnsafe === false ? "off" : "on") + ")");
