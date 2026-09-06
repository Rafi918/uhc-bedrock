// graveback.js — يرجّع اللاعب لعند قبره بمكان متحقق منه بدل رسبون بعيد/داخل بلوك
import { world, system } from "@minecraft/server";
import { safeSpot, freeIfStuck } from "./safespot.js";

const NETHER = "minecraft:nether";
const KEY = "uhc:deaths";

const CFG = {
  enabled: false,   // معطّل: respawn.js يتولى الرجعة والرسائل
  autoOnRespawn: true,
  afterTicks: 75,        // ننطي respawn.js وقت يخلص قبلنا
  driftBlocks: 24,       // أبعد من هيچ عن نقطة الموت = نرجّعه
  staleMinutes: 15,      // سجل أقدم من هيچ نتجاهله (ريستارت قديم)
  marginBlocks: 24,      // هامش داخل البوردر
  keepLast: 40,
  roomX: 4000, roomZ: 4000,   // غرفة الخاسرين — ممنوع نلمس أحد بيها
};

let deaths = {};
try { deaths = JSON.parse(world.getDynamicProperty(KEY) ?? "{}") || {}; } catch { deaths = {}; }
function save() {
  try {
    const k = Object.keys(deaths);
    if (k.length > CFG.keepLast)
      for (const n of k.sort((a,b) => (deaths[a].t||0)-(deaths[b].t||0)).slice(0, k.length-CFG.keepLast))
        delete deaths[n];
    world.setDynamicProperty(KEY, JSON.stringify(deaths));
  } catch (e) { console.warn("[UHC] graveback save: " + (e?.message ?? e)); }
}
export function clearDeaths() { deaths = {}; save(); }   // نادِها عند بدء مباراة

/* البوردر من uhc:state — قراءة فقط، بلا import حتى ما نكسر الباك */
function borderInfo(dimId) {
  try {
    const raw = world.getDynamicProperty("uhc:state");
    if (typeof raw !== "string") return null;
    const st = JSON.parse(raw);
    const b = st?.border ?? st?.b ?? st;
    const half = Number(b?.currentHalf ?? b?.size ?? b?.borderSize);
    if (!Number.isFinite(half) || half <= 0) return null;
    const sc = dimId === NETHER ? 8 : 1;
    return { cx: Number(b?.centerX ?? 0)/sc, cz: Number(b?.centerZ ?? 0)/sc,
             half: Math.max(16, half/sc) };
  } catch { return null; }
}
function clampIn(dimId, x, z) {
  const b = borderInfo(dimId);
  if (!b) return { x, z };
  const inner = Math.max(8, b.half - CFG.marginBlocks);
  return { x: Math.min(b.cx + inner, Math.max(b.cx - inner, x)),
           z: Math.min(b.cz + inner, Math.max(b.cz - inner, z)) };
}

function gmOf(p) { try { return String(p.getGameMode?.() ?? p.gameMode ?? ""); } catch { return ""; } }
function inRoom(p) {
  try {
    const l = p.location;
    return Math.abs(l.x - CFG.roomX) < 96 && Math.abs(l.z - CFG.roomZ) < 96 && l.y > 200;
  } catch { return false; }
}
/* المستبعَد ما نلمسه: أدفنتشر/سبكتيتر/كريتف أو داخل الغرفة */
function protectedNow(p) {
  const gm = gmOf(p);
  return gm.includes("adventure") || gm.includes("spectator") || gm.includes("creative") || inRoom(p);
}

/* ================= تسجيل الموت ================= */
world.afterEvents.entityDie.subscribe((ev) => {
  if (!CFG.enabled) return;
  try {
    const p = ev.deadEntity;
    if (!p || p.typeId !== "minecraft:player") return;
    const dimId = p.dimension?.id;
    if (dimId !== NETHER && dimId !== "minecraft:overworld") return;
    const l = p.location;
    const c = clampIn(dimId, l.x, l.z);
    deaths[p.name] = { d: dimId, x: c.x, y: l.y, z: c.z, t: Date.now(),
                       rx: Math.floor(l.x), rz: Math.floor(l.z) };
    save();
    console.warn(`[UHC] death ${p.name} @ ${Math.floor(l.x)},${Math.floor(l.y)},`
               + `${Math.floor(l.z)} ${dimId}`);
  } catch (e) { console.warn("[UHC] graveback die: " + (e?.message ?? e)); }
});

/* ================= الرجعة ================= */
export function backToDeath(p, why = "auto") {
  try {
    const r = deaths[p.name];
    if (!r) return false;
    if (Date.now() - (r.t ?? 0) > CFG.staleMinutes * 60000) { delete deaths[p.name]; save(); return false; }
    const dim = world.getDimension(r.d);
    const spot = safeSpot(dim, { x: r.x, y: r.y, z: r.z });
    p.teleport(spot, { dimension: dim, keepVelocity: false });
    try {
      p.addEffect("resistance", 140, { amplifier: 1, showParticles: false });
      p.addEffect("slow_falling", 140, { showParticles: false });
      if (r.d === NETHER) p.addEffect("fire_resistance", 240, { showParticles: false });
    } catch {}
    delete deaths[p.name]; save();
    system.runTimeout(() => { try { freeIfStuck(p); } catch {} }, 8);   // ضمان أخير
    console.warn(`[UHC] graveback(${why}) ${p.name} → ${Math.floor(spot.x)},`
               + `${Math.floor(spot.y)},${Math.floor(spot.z)} ${r.d}`);
    try { p.sendMessage("\u00A7aرجعناك عند قبرك \u00A78| \u00A77شوف الصندوق حولك"); } catch {}
    return true;
  } catch (e) { console.warn("[UHC] backToDeath: " + (e?.message ?? e)); return false; }
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!CFG.enabled || !CFG.autoOnRespawn || ev.initialSpawn) return;
  const p = ev.player;
  system.runTimeout(() => {
    try {
      if (!p || protectedNow(p)) return;          // مستبعَد → لا نلمسه
      const r = deaths[p.name];
      if (!r || r.q) return;
      const same = p.dimension?.id === r.d;
      const l = p.location;
      const drift = same ? Math.hypot(l.x - r.x, l.z - r.z) : 1e9;
      if (drift <= CFG.driftBlocks) { r.q = 1; save(); return; }  // قريب أصلاً
      backToDeath(p, `drift=${Math.round(drift)}`);
    } catch (e) { console.warn("[UHC] graveback spawn: " + (e?.message ?? e)); }
  }, CFG.afterTicks);
});

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  try {
    const p = ev.sourceEntity;
    if (ev.id === "uhc:back") {
      if (p?.typeId === "minecraft:player")
        p.sendMessage(backToDeath(p, "manual") ? "\u00A7aتم" : "\u00A7cماكو سجل موت صالح");
    } else if (ev.id === "uhc:death") {
      if (p?.typeId !== "minecraft:player") return;
      const r = deaths[p.name];
      p.sendMessage(r ? `\u00A7eقبرك: \u00A7f${r.rx} ${Math.floor(r.y)} ${r.rz} `
                        + `\u00A77(${r.d === NETHER ? "نذر" : "أوفروورلد"})`
                      : "\u00A77ماكو سجل موت.");
    }
  } catch {}
});

console.warn("[UHC] graveback.js جاهز");
