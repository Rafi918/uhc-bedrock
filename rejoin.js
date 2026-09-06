import { safeSpot } from "./safespot.js";
// UHC — يسحب اللاعب داخل البوردر لو رجع وهو بره
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { isSpectatorLike, addEffectSafe, msgTo, dimScale } from "./util.js";

const pend = new Map();
const cool = new Map();

function rescue(p) {
  try {
    const s = State.data;
    if (s.phase !== "PLAYING" && s.phase !== "GRACE") return;
    if (isSpectatorLike(p)) return;
    if (!State.isParticipant(p.name) || State.isEliminated(p.name)) return;
    if (CONFIG.rejoinPullInside === false) return;

    const now = Date.now();
    if (now < (cool.get(p.name) ?? 0)) return;

    const pmax = Number(CONFIG.rejoinPullMaxMinutes ?? 120);
    if (pmax > 0 && s.gameStartAt && now - s.gameStartAt > pmax * 60000) return;

    const b = s.border ?? {};
    const sc = dimScale(p.dimension?.id);
    const cx = (b.centerX ?? 0) / sc;
    const cz = (b.centerZ ?? 0) / sc;
    const half = Math.max(16, (b.currentHalf ?? 8000) / sc);
    const l = p.location;
    const out = Math.max(Math.abs(l.x - cx), Math.abs(l.z - cz)) - half;
    if (out <= 0) return;

    cool.set(p.name, now + 8000);
    const inner = Math.max(8, half - 24);
    const nx = Math.min(cx + inner, Math.max(cx - inner, l.x));
    const nz = Math.min(cz + inner, Math.max(cz - inner, l.z));
    const g = Math.max(6, Number(CONFIG.rejoinGraceSeconds ?? 12));

    addEffectSafe(p, "slow_falling", 25, 0);
    addEffectSafe(p, "resistance", g, 4);
    addEffectSafe(p, "fire_resistance", g + 6, 0);
    p.teleport(safeSpot(p.dimension, { x: nx, y: l.y, z: nz }), { dimension: p.dimension });
    msgTo(p, "\u00A7eالبوردر تحرك وانت غايب \u00A78| \u00A77رجعناك داخله (كنت بره "
             + Math.ceil(out) + " بلوك)");
  } catch (e) { console.warn("[UHC] rejoin:", e?.message ?? e); }
}

system.run(() => {
  try {
    world.afterEvents.playerSpawn.subscribe((ev) => {
      const n = ev.player?.name;
      if (n) pend.set(n, Date.now() + 12000);
    });
  } catch { console.warn("[UHC] rejoin: playerSpawn مو متاح"); }

  system.runInterval(() => {
    if (!pend.size) return;
    const now = Date.now();
    for (const p of world.getPlayers()) {
      if (pend.has(p.name)) rescue(p);
    }
    for (const [n, t] of pend) if (now > t) pend.delete(n);
  }, 20);

  console.warn("[UHC] rejoin.js جاهز");
});
