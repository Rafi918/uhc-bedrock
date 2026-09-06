// UHC — قفل الإند (ينسحب للأوفرورلد)
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { isSpectatorLike, isOpSafe, addEffectSafe, msgTo } from "./util.js";

const END = "minecraft:the_end";
const cool = new Map();

function blocked() {
  const s = State.data;
  if (s.endOpen === true) return false;
  if (CONFIG.endEnabled === true) return false;
  return s.phase === "GRACE" || s.phase === "PLAYING";
}

function skip(p) {
  try {
    if (isSpectatorLike(p)) return true;                       // أوبريتر يتفقد
    if (isOpSafe(p) && !State.isParticipant(p.name)) return true;
  } catch {}
  return false;
}

function pull(p) {
  try {
    if (!blocked() || skip(p)) return;
    const now = Date.now();
    if (now < (cool.get(p.name) ?? 0)) return;
    cool.set(p.name, now + 4000);

    const b = State.data.border ?? {};
    addEffectSafe(p, "slow_falling", 30, 0);
    addEffectSafe(p, "resistance", 20, 4);
    addEffectSafe(p, "fire_resistance", 20, 0);
    p.teleport({ x: (b.centerX ?? 0) + 0.5, y: 220, z: (b.centerZ ?? 0) + 0.5 },
               { dimension: world.getDimension("minecraft:overworld") });
    msgTo(p, "\u00A7cالاند مقفول بهاي المباراة");
  } catch (e) { console.warn("[UHC] endlock:", e?.message ?? e); }
}

system.run(() => {
  try {
    world.afterEvents.playerDimensionChange.subscribe((ev) => {
      try {
        if (String(ev.toDimension?.id) !== END) return;
        system.runTimeout(() => pull(ev.player), 10);
      } catch {}
    });
  } catch { console.warn("[UHC] endlock: dimensionChange مو متاح — الفحص الدوري بس"); }

  system.runInterval(() => {
    try {
      if (!blocked()) return;
      for (const p of world.getPlayers()) {
        try { if (String(p.dimension?.id) === END) pull(p); } catch {}
      }
    } catch {}
  }, 40);

  console.warn("[UHC] endlock.js جاهز");
});
