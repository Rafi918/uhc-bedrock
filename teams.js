// UHC - الفرق + التوزيع على محيط مربع (عدل لكل الفرق)
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { titleTo, setGameMode, healFull, clearEffects, addEffectSafe,
         isSpectatorLike, shuffle, setNameTag } from "./util.js";

const BAD = new Set([
  "minecraft:lava", "minecraft:flowing_lava", "minecraft:water",
  "minecraft:flowing_water", "minecraft:fire", "minecraft:soul_fire",
  "minecraft:magma", "minecraft:cactus", "minecraft:powder_snow",
  "minecraft:sweet_berry_bush", "minecraft:wither_rose",
]);

function groundY(dim, x, z) {
  try {
    const top = dim.getTopmostBlock({ x, z });
    if (!top) return null;
    if (top.isLiquid || BAD.has(top.typeId)) return null;
    if (top.y <= dim.heightRange.min + 2) return null;
    if (top.y >= dim.heightRange.max - 3) return null;
    const a = dim.getBlock({ x, y: top.y + 1, z });
    if (a && !a.isAir) return null;
    return top.y + 1;
  } catch { return null; }
}

// نقطة على محيط مربع — البوردر مربع فالدائرة كانت تظلم اللي ينزل على المحور
function squareRing(cx, cz, R, tt) {
  const u = ((tt % 1) + 1) % 1;
  const seg = u * 4;
  const i = Math.floor(seg);
  const f = seg - i;
  const p = -R + f * 2 * R;
  if (i === 0) return { x: cx + p, z: cz - R };
  if (i === 1) return { x: cx + R, z: cz + p };
  if (i === 2) return { x: cx - p, z: cz + R };
  return { x: cx - R, z: cz - p };
}

function lift(players, dim, c) {
  for (const p of players) {
    try {
      setGameMode(p, "survival");
      addEffectSafe(p, "resistance", 45, 4);
      addEffectSafe(p, "slow_falling", 45, 0);
      addEffectSafe(p, "fire_resistance", 45, 0);
      p.teleport({ x: c.x + 0.5, y: CONFIG.scatterLiftY ?? 250, z: c.z + 0.5 },
                 { dimension: dim });
    } catch {}
  }
}

function place(players, dim, x, y, z, label, color) {
  let i = 0;
  const n = Math.max(1, players.length);
  for (const p of players) {
    const a = (i++ / n) * Math.PI * 2;
    const r = n > 1 ? (CONFIG.scatterSpreadRadius ?? 2.5) : 0;
    const px = Math.floor(x + Math.cos(a) * r);
    const pz = Math.floor(z + Math.sin(a) * r);
    const py = groundY(dim, px, pz) ?? y;
    try {
      p.teleport({ x: px + 0.5, y: py, z: pz + 0.5 }, { dimension: dim });
      healFull(p);
      if (color) setNameTag(p, color + p.name);
      titleTo(p, "§6" + label, "§7بالتوفيق");
    } catch (e) { console.warn("[UHC] place:", e?.message ?? e); }
  }
  const list = [...players];
  system.runTimeout(() => {
    for (const p of list) { try { clearEffects(p); } catch {} }
  }, 70);
}

export const Teams = {
  list() {
    return Object.entries(State.data.teams).map(([name, m]) =>
      ({ name, members: Array.isArray(m) ? m : [] }));
  },

  playersInTeam(t) {
    const m = State.data.teams[t] ?? [];
    const on = world.getPlayers();
    return m.map(x => on.find(p => p.name === x)).filter(Boolean);
  },

  colorFor(i) {
    const c = CONFIG.teamNameColors ?? ["§c", "§9", "§a", "§e", "§d", "§6", "§b", "§5"];
    return c[i % c.length] ?? "§f";
  },

  buildGroups() {
    const g = [];
    const asg = new Set();
    let ci = 0;
    for (const { name } of this.list()) {
      const ps = this.playersInTeam(name);
      if (!ps.length) continue;
      for (const p of ps) asg.add(p.name);
      g.push({ key: name, label: "فريق " + name, players: ps,
               solo: false, color: this.colorFor(ci++) });
    }
    for (const p of world.getPlayers()) {
      if (asg.has(p.name)) continue;
      if (isSpectatorLike(p)) continue;
      try { if (p.hasTag("uhc_exempt")) continue; } catch {}
      g.push({ key: "solo:" + p.name, label: "سولو", players: [p],
               solo: true, color: this.colorFor(ci++) });
    }
    return shuffle(g);
  },

  async scatterAll() {
    const b = State.data.border;
    const dim = world.getDimension("overworld");
    const res = { teams: 0, solos: 0, teleported: 0, failed: [],
                  participants: {}, ring: 0 };

    let pending = this.buildGroups();
    if (!pending.length) return res;
    for (const g of pending)
      for (const p of g.players) res.participants[p.name] = g.key;

    const n = pending.length;
    const FM = b.ringMin ?? CONFIG.scatterMinFactor ?? 0.85;
    const FX = b.ringMax ?? CONFIG.scatterMaxFactor ?? 0.9;
    const HARD = Math.max(64, b.currentHalf - 60);
    const R0 = Math.min(HARD, b.currentHalf * ((FM + FX) / 2));
    const base = Math.random();
    res.ring = Math.round(R0);

    pending.forEach((g, i) => { g._t = base + i / n; g._try = 0; });

    const deadline = Date.now() + (CONFIG.scatterMaxSeconds ?? 90) * 1000;
    const rounds = CONFIG.scatterRingAttempts ?? 7;

    for (let round = 0; round < rounds && pending.length; round++) {
      if (Date.now() > deadline) { console.warn("[UHC] scatter deadline"); break; }
      const picks = new Map();
      const roundR = Math.min(HARD,
        b.currentHalf * (FM + Math.random() * Math.max(0, FX - FM)));

      for (const g of pending) {
        const jit = g._try === 0 ? 0 : (Math.random() - 0.5) * (0.55 / n);
        const rr = Math.min(HARD, roundR * (1 - g._try * 0.035));
        const pt = squareRing(b.centerX, b.centerZ, rr, g._t + jit);
        const x = Math.floor(pt.x);
        const z = Math.floor(pt.z);
        picks.set(g.key, { x, z });
        lift(g.players, dim, { x, z });
        g._try++;
      }

      await system.waitTicks((CONFIG.scatterLoadWaitTicks ?? 40) + (round ? 20 : 0));
      if (State.data.phase === "LOBBY") { res.aborted = true; return res; }

      const next = [];
      for (const g of pending) {
        const c = picks.get(g.key);
        const y = c ? groundY(dim, c.x, c.z) : null;
        if (y === null) { next.push(g); continue; }
        place(g.players, dim, c.x, y, c.z, g.label, g.color);
        res.teleported += g.players.length;
        if (g.solo) res.solos++; else res.teams++;
      }
      pending = next;
    }

    for (const g of pending) {
      const rr = Math.min(HARD, R0 * 0.6);
      const pt = squareRing(b.centerX, b.centerZ, rr, g._t ?? 0);
      const x = Math.floor(pt.x);
      const z = Math.floor(pt.z);
      lift(g.players, dim, { x, z });
      await system.waitTicks(CONFIG.scatterLoadWaitTicks ?? 40);
      if (State.data.phase === "LOBBY") { res.aborted = true; return res; }
      const y = groundY(dim, x, z) ?? 90;
      place(g.players, dim, x, y, z, g.label, g.color);
      res.teleported += g.players.length;
      res.failed.push(g.key);
      if (g.solo) res.solos++; else res.teams++;
    }
    return res;
  },
};
