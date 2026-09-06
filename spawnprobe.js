// spawnprobe.js — يفحص مركز البوردر: يابسة أو بحر
import { world, system } from "@minecraft/server";
import { State } from "./state.js";

const OW = "minecraft:overworld";
const WET = new Set([
  "minecraft:water","minecraft:flowing_water","minecraft:ice","minecraft:packed_ice",
  "minecraft:blue_ice","minecraft:frosted_ice","minecraft:kelp","minecraft:seagrass",
  "minecraft:tall_seagrass",
]);

let seq = 0, busy = false;

function taAdd(dim, x, z) {
  const n = "uhcp" + (++seq % 100);
  try {
    const r = dim.runCommand(`tickingarea add circle ${Math.floor(x)} 64 ${Math.floor(z)} 4 ${n}`);
    return (r && r.successCount >= 1) ? n : null;
  } catch { return null; }
}
function taDel(dim, n) { if (n) { try { dim.runCommand(`tickingarea remove ${n}`); } catch {} } }

function sampleArea(dim, cx, cz, R, step) {
  let land = 0, water = 0, unknown = 0;
  const kinds = new Map();
  for (let dx = -R; dx <= R; dx += step)
    for (let dz = -R; dz <= R; dz += step) {
      let id = "";
      try {
        const b = dim.getTopmostBlock({ x: cx + dx, z: cz + dz });
        id = b ? String(b.typeId ?? "") : "";
      } catch { unknown++; continue; }
      if (!id) { unknown++; continue; }
      kinds.set(id, (kinds.get(id) ?? 0) + 1);
      if (WET.has(id)) water++; else land++;
    }
  const tot = land + water;
  const top = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => k.replace("minecraft:", "") + "×" + v).join(", ");
  return { land, water, unknown, pct: tot ? Math.round(water * 100 / tot) : -1, top };
}
const verdict = (p) => p < 0 ? "مجهول" : p >= 60 ? "بحر" : p >= 25 ? "ساحل" : "يابسة";

export async function probeSpawn(say) {
  if (busy) return null;
  busy = true;
  const dim = world.getDimension(OW);
  const b = State.data.border;
  const cx = Math.floor(b?.centerX ?? 0), cz = Math.floor(b?.centerZ ?? 0);
  const out = [];
  const spots = [
    ["المركز",   cx,       cz,       48, 8],
    ["شمال400",  cx,       cz - 400, 16, 8],
    ["جنوب400",  cx,       cz + 400, 16, 8],
    ["شرق400",   cx + 400, cz,       16, 8],
    ["غرب400",   cx - 400, cz,       16, 8],
  ];
  try {
    for (const [label, x, z, R, st] of spots) {
      const ta = taAdd(dim, x, z);
      await system.waitTicks(ta ? 40 : 10);
      const q = sampleArea(dim, x, z, R, st);
      taDel(dim, ta);
      out.push({ label, ...q });
      console.warn(`[UHC] SPAWN ${label} @ ${x},${z} → ${verdict(q.pct)}`
        + ` (ماي ${q.pct}% │ ${q.top || "؟"})`);
      await system.waitTicks(5);
    }
  } catch (e) { console.warn("[UHC] spawnprobe: " + (e?.message ?? e)); }
  finally { busy = false; }

  const c = out[0];
  const far = out.slice(1).filter(q => q.pct >= 0);
  const avg = far.length ? Math.round(far.reduce((a, q) => a + q.pct, 0) / far.length) : -1;
  const line = `SPAWN VERDICT: المركز=${verdict(c?.pct ?? -1)} (${c?.pct ?? -1}% ماي)`
    + ` │ محيط400=${verdict(avg)} (${avg}% ماي)`;
  console.warn("[UHC] " + line);
  if (say) say("§e" + line);
  return { center: c, avg };
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "uhc:spawncheck") return;
  const p = ev.sourceEntity;
  const say = (t) => {
    if (p?.typeId === "minecraft:player") { try { p.sendMessage(t); } catch {} }
    else { try { world.sendMessage(t); } catch {} }
  };
  say("§7نفحص المركز… 10 ثواني");
  probeSpawn(say);
});

// فحص تلقائي مرة واحدة لمن يشتغل عالم بالـLOBBY
system.runTimeout(() => {
  try { if (State.data?.phase === "LOBBY") probeSpawn(null); } catch {}
}, 200);

console.warn("[UHC] spawnprobe.js جاهز (uhc:spawncheck)");
