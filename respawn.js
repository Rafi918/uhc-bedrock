import { graveSpotFor } from "./gravelava.js";
import { safeSpot } from "./safespot.js";
// UHC Core - الرجعة لمكان الموت + غرفة الخارجين
// ⚰ ماكو قبر من عندنا — العدة تطيح طبيعي (مود القبر الخارجي يتولاها)
//    شغلتنا: نرجّع اللاعب قرب مكان موته حتى يوصل قبره
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { setGameMode, healFull, clearEffects, addEffectSafe, isOpSafe,
         titleTo, actionBar, soundTo, msgTo, formatMs, dist3D,
         isSpectatorLike, overworld, gamerule } from "./util.js";

const P_PEND = "uhc:pending", P_LOC = "uhc:deathloc", P_GID = "uhc:gameid", P_ROOM = "uhc:room";
const BAD = new Set(["minecraft:lava","minecraft:flowing_lava","minecraft:water",
  "minecraft:flowing_water","minecraft:fire","minecraft:soul_fire","minecraft:magma",
  "minecraft:cactus","minecraft:powder_snow","minecraft:sweet_berry_bush",
  "minecraft:wither_rose","minecraft:campfire","minecraft:soul_campfire"]);

const lastCombat = new Map();
let lastKeep = 0, roomGame = -1, roomTry = 0, taSeq = 0;

export function noteCombat(n) { lastCombat.set(n, Date.now()); }
export function isRespawnActive() {
  const s = State.data;
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return false;
  if (s.respawn.minutes <= 0) return false;
  return Date.now() < s.respawn.endAt;
}
export function respawnTimeLeft() { return formatMs(State.data.respawn.endAt - Date.now()); }

const gp = (p,k) => { try { return p.getDynamicProperty(k); } catch { return undefined; } };
const spr = (p,k,v) => { try { p.setDynamicProperty(k,v); } catch {} };
const setB = (dim,x,y,z,t) => {
  try { const b = dim.getBlock({x,y,z}); if (b) { b.setType(t); return true; } } catch {}
  try { dim.runCommand(`setblock ${x} ${y} ${z} ${t.replace("minecraft:","")}`); return true; } catch {}
  return false;
};

function colSafe(dim, x, z, startY) {
  const top = Math.min(startY + 10, dim.heightRange.max - 3);
  for (let y = top; y > dim.heightRange.min + 1; y--) {
    try {
      const u = dim.getBlock({x,y:y-1,z}), f = dim.getBlock({x,y,z}), h = dim.getBlock({x,y:y+1,z});
      if (!u || !f || !h) continue;
      if (!f.isAir || !h.isAir) continue;
      if (u.isAir || u.isLiquid || BAD.has(u.typeId)) continue;
      return y;
    } catch {}
  }
  return null;
}

function safeSpotNearLegacy(dim, loc) {
  const cx = Math.floor(loc.x), cz = Math.floor(loc.z), sy = Math.floor(loc.y);
  const R = CONFIG.returnRadius ?? 24;
  for (const r of [0,1,2,3,5,7,R]) {
    if (r > R) break;
    const q = Math.round(r * 0.7);
    const pts = r === 0 ? [[0,0]] : [[r,0],[-r,0],[0,r],[0,-r],[q,q],[-q,-q],[q,-q],[-q,q]];
    for (const [dx,dz] of pts) {
      const y = colSafe(dim, cx+dx, cz+dz, sy);
      if (y !== null) return { x:cx+dx+0.5, y, z:cz+dz+0.5 };
    }
  }
  return null;
}

export function buildSafeBox() { return null; }   // مطفي: كان يغطي القبر

// ═══════════ غرفة الخارجين ═══════════
function roomCenter() {
  const b = State.data.border;
  const O = CONFIG.losersRoomOffset ?? 4000;
  return { x: Math.floor(b.centerX) + O, y: CONFIG.losersRoomY ?? 300, z: Math.floor(b.centerZ) + O };
}

// 🔧 fill بأمرين بدل 1000 setblock (اللي كان يفشل بتشنك مو محمّل)
async function ensureRoom() {
  const c = roomCenter();
  if (roomGame === State.data.gameId) return c;
  if (roomTry > 0 && roomTry > Date.now() - 5000) return c;
  roomTry = Date.now();
  const dim = overworld(), R = CONFIG.losersRoomRadius ?? 6;
  try { dim.runCommand(`tickingarea add circle ${c.x} ${c.y} ${c.z} 2 uhc_room`); } catch {}
  await system.waitTicks(20);
  let ok = false;
  try {
    dim.runCommand(`fill ${c.x-R} ${c.y-1} ${c.z-R} ${c.x+R} ${c.y+4} ${c.z+R} stone hollow`);
    ok = true;
  } catch (e) { console.warn("[UHC] room fill:", e?.message ?? e); }
  if (ok) {
    try { dim.runCommand(`fill ${c.x-2} ${c.y+4} ${c.z-2} ${c.x+2} ${c.y+4} ${c.z+2} sea_lantern`); } catch {}
    roomGame = State.data.gameId;
    console.warn(`[UHC] غرفة الخارجين انبنت عند ${c.x} ${c.y} ${c.z}`);
  }
  return c;
}

// الرجعة: ننتظر مود القبر يحط القبر، وبعدها ننقل اللاعب اقرب مكان آمن
// ⚠️ ممنوع نبني اي بلوك — البناء كان يغطي القبر ويطير الغراض
async function safeReturn(player, loc) {
  const dim = world.getDimension(loc.dim ?? "overworld");
  const NETH = "minecraft:nether";
  const sc = (dim.id === NETH) ? (CONFIG.netherScale ?? 8) : 1;
  const death = { x: loc.x, y: loc.y, z: loc.z };

  const tas = [];
  const taAdd = (x, y, z) => {
    const n = "uhcr" + (++taSeq % 10000);
    try {
      dim.runCommand(`tickingarea add circle ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} 2 ${n}`);
      tas.push(n);
    } catch (e) { console.warn("[UHC] respawn ta: " + (e?.message ?? e)); }
  };
  const taClear = () => {
    for (const n of tas) { try { dim.runCommand(`tickingarea remove ${n}`); } catch {} }
    tas.length = 0;
  };
  const inBorder = (x, z) => {
    const b = State.data.border;
    const inn = Math.max(8, (b.currentHalf / sc) - (CONFIG.returnBorderMargin ?? 24));
    const cx = b.centerX / sc, cz = b.centerZ / sc;
    return { x: Math.min(cx + inn, Math.max(cx - inn, x)),
             z: Math.min(cz + inn, Math.max(cz - inn, z)) };
  };

  try { setGameMode(player, "survival"); } catch {}
  addEffectSafe(player, "resistance", 25, 4);
  addEffectSafe(player, "fire_resistance", 30, 0);
  addEffectSafe(player, "slow_falling", 20, 0);

  // 1) نحمّل قطعة الموت — بدونها getEntities ما يشوف القبر أبداً
  taAdd(death.x, death.y, death.z);
  // ولو الموت كان برّا البوردر: نحمّل الهدف الداخلي كذلك (القبر ينتقل له)
  const pre = inBorder(death.x, death.z);
  if (Math.abs(pre.x - death.x) > 1 || Math.abs(pre.z - death.z) > 1)
    taAdd(pre.x, death.y, pre.z);

  await system.waitTicks(CONFIG.graveWaitTicks ?? 45);

  // 2) القبر بالاسم + شرط اللافا والبوردر (gravelava يسحبه داخل لو كان برّا)
  let g = null;
  try { g = graveSpotFor(player.name, dim, death); }
  catch (e) { console.warn("[UHC] respawn grave: " + (e?.message ?? e)); }
  if (g && g.dim?.id !== dim.id) g = null;

  let target;
  if (g) {
    const c = inBorder(g.x + 0.5, g.z + 0.5);
    target = { x: c.x, y: g.y, z: c.z };
    console.warn(`[UHC] respawn: جنب القبر @ ${g.x},${g.y},${g.z} ${dim.id}`
      + (g.mine ? " (بالاسم)" : ` (أقرب ${g.dist})`) + (g.moved ? " [نقلناه]" : ""));
  } else {
    const c = inBorder(death.x, death.z);
    target = { x: c.x, y: death.y, z: c.z };
    console.warn(`[UHC] respawn: ماكو قبر → مكان الموت @ ${Math.floor(death.x)},`
      + `${Math.floor(death.y)},${Math.floor(death.z)} ${dim.id}`
      + (Math.abs(c.x - death.x) > 1 || Math.abs(c.z - death.z) > 1 ? " [قصّينا داخل البوردر]" : ""));
  }

  // 3) نحمّل قطعة الهدف قبل البحث عن أرض
  taAdd(target.x, target.y, target.z);
  await system.waitTicks(20);

  const spot = safeSpotNear(dim, target);
  if (spot) {
    try { player.teleport(spot, { dimension: dim }); } catch {}
  } else {
    try {
      player.teleport({ x: target.x, y: Math.min(target.y + 40, 300), z: target.z },
                      { dimension: dim });
      addEffectSafe(player, "slow_falling", 30, 0);
      addEffectSafe(player, "fire_resistance", 40, 0);
    } catch {}
  }

  healFull(player);
  clearEffects(player);
  const gs = Math.max(5, CONFIG.respawnProtectSeconds ?? 6);
  addEffectSafe(player, "resistance", gs, 4);
  addEffectSafe(player, "fire_resistance", gs + 8, 0);
  addEffectSafe(player, "regeneration", 2, 1);

  titleTo(player, "§aرجعت للحياة", `§7الرجعة تنتهي بعد §f${respawnTimeLeft()}`);
  soundTo(player, CONFIG.soundRespawn, 1.0, 1.0);
  try {
    if (g) {
      const dd = Math.max(0, Math.round(dist3D(player.location,
        { x: g.x + 0.5, y: g.y, z: g.z + 0.5 })));
      msgTo(player, `§a✔ رجعناك جنب قبرك §8| §eالإحداثيات: §f${g.x} ${g.y} ${g.z}`
        + ` §8| §7يبعد عنك §f${dd}§7 بلوك`);
      if (g.moved) msgTo(player, `§6⚠ قبرك كان ${g.why} §8| §aنقلناه لمكان آمن داخل البوردر`);
      msgTo(player, "§7افتح القبر وخُذ أغراضك");
    } else {
      msgTo(player, `§eمكان موتك: §f${Math.floor(death.x)} ${Math.floor(death.y)} `
        + `${Math.floor(death.z)} §8| §7ما لقينا القبر — اكتب §fuhc:mygrave`);
    }
  } catch {}

  await system.waitTicks(40);
  taClear();
}

export const Respawn = {
  prepRoom() { roomGame = -1; roomTry = 0; return ensureRoom(); },

  handleDeath(p) {
    const s = State.data, n = p.name;
    if (!State.isParticipant(n)) return { ignored:true, willRespawn:true };
    const l = p.location;
    spr(p, P_LOC, JSON.stringify({x:l.x, y:l.y, z:l.z, dim:p.dimension.id}));
    spr(p, P_GID, s.gameId);
    lastCombat.delete(n);
    if (isRespawnActive()) { spr(p, P_PEND, true); return { ignored:false, willRespawn:true }; }
    spr(p, P_PEND, false);
    State.eliminate(n);
    return { ignored:false, willRespawn:false };
  },

  handlePlayerRespawn(p) {
    const s = State.data;
    if (s.phase === "LOBBY") return;
    if (gp(p, P_PEND) === true && gp(p, P_GID) === s.gameId) {
      spr(p, P_PEND, false);
      let loc = null;
      try { const r = gp(p, P_LOC); if (typeof r === "string" && r) loc = JSON.parse(r); } catch {}
      if (!loc) { healFull(p); return; }
      system.runTimeout(() => safeReturn(p, loc).catch(e => console.warn("[UHC] return:", e)), 8);
      return;
    }
    if (State.isEliminated(p.name)) system.runTimeout(() => this.toRoom(p), 10);
  },

  handleJoin(p) {
    const s = State.data, n = p.name;
    if (s.offlineSince[n]) { delete s.offlineSince[n]; State.markDirty(); }
    if (s.phase === "LOBBY" || s.phase === "ENDED") return;
    if (State.isEliminated(n)) { system.runTimeout(() => this.toRoom(p), 20); return; }
    if (!State.isParticipant(n)) {
      if (isOpSafe(p)) {
        system.runTimeout(() => msgTo(p, "§7انت مو مشارك │ §euhc:unspec§7 للرجوع"), 20);
        return;
      }
      system.runTimeout(() => this.toRoom(p, true), 20);
    }
  },

  handleLeave(n) {
    const s = State.data;
    const t = lastCombat.get(n) ?? 0;
    lastCombat.delete(n);
    if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;
    if (!State.isParticipant(n) || State.isEliminated(n)) return;
    if (CONFIG.combatLogSeconds > 0 && !isRespawnActive() &&
        Date.now() - t < CONFIG.combatLogSeconds * 1000) {
      State.eliminate(n); return { combatLog:true };
    }
    s.offlineSince[n] = Date.now(); State.save();
    return { combatLog:false };
  },

  // 🔧 تنبيه واحد بس — كان يتكرر كل نص ثانية
  toRoom(p, visitor = false) {
    ensureRoom().then((c) => {
      try {
        setGameMode(p, CONFIG.losersGameMode ?? "adventure");
        p.teleport({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, { dimension: overworld() });
        clearEffects(p);
        healFull(p);
        addEffectSafe(p, "resistance", 3000, 4);
        addEffectSafe(p, "saturation", 3000, 0);
        const tag = `${State.data.gameId}:${visitor ? "v" : "o"}`;
        if (gp(p, P_ROOM) !== tag) {
          spr(p, P_ROOM, tag);
          if (visitor) titleTo(p, "§7غرفة الانتظار", "§7انت مو مشارك بهاي اللعبة");
          else {
            titleTo(p, "§cخرجت من اللعبة", "§7انتظر النتيجة هنا");
            msgTo(p, "§cخرجت نهائيا §8| §7ممنوع تنطي معلومات للعايشين");
          }
        }
      } catch (e) { console.warn("[UHC] room:", e); }
    }).catch(() => {});
  },

  forceSpectate(p) { this.toRoom(p); },

  releaseFromSpectate(p, { anchor = null } = {}) {
    try {
      spr(p, P_ROOM, "");
      setGameMode(p, "survival");
      const b = State.data.border;
      const t = anchor ?? this.aliveTeammates(p.name)[0] ?? null;
      if (t) p.teleport(safeSpotNear(t.dimension, t.location)
        ?? {x:t.location.x, y:t.location.y+1, z:t.location.z}, { dimension: t.dimension });
      else {
        p.teleport({x:b.centerX+0.5, y:250, z:b.centerZ+0.5}, { dimension: overworld() });
        addEffectSafe(p, "slow_falling", 25, 0);
      }
      healFull(p); clearEffects(p);
      addEffectSafe(p, "resistance", 8, 4);
      addEffectSafe(p, "slow_falling", 12, 0);
      return true;
    } catch (e) { console.warn("[UHC] release:", e); return false; }
  },

  aliveTeammates(n) {
    const t = State.teamOfParticipant(n);
    if (!t) return [];
    return world.getPlayers().filter(p =>
      p.name !== n && State.teamOfParticipant(p.name) === t && !State.isEliminated(p.name));
  },

  tick() {
    const s = State.data;
    if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;
    if (Date.now() < (s.scatterUntil ?? 0)) return;
    if (Date.now() - lastKeep > 60000) {
      lastKeep = Date.now();
      gamerule("keepinventory", "false");   // مود القبر يتولى العدة
    }
    if (s.eliminated.length === 0) return;

    const c = roomCenter(), R = (CONFIG.losersRoomRadius ?? 6) + 2;
    for (const p of world.getPlayers()) {
      if (!State.isEliminated(p.name)) continue;
      try {
        if (isSpectatorLike(p) && CONFIG.losersGameMode !== "spectator")
          setGameMode(p, CONFIG.losersGameMode ?? "adventure");
        const out = p.dimension.id !== "minecraft:overworld" ||
                    Math.abs(p.location.x - c.x) > R || Math.abs(p.location.z - c.z) > R ||
                    Math.abs(p.location.y - c.y) > 8;
        if (out) this.toRoom(p);
        else actionBar(p, `§cخرجت من اللعبة §8| §7عايشين §a${this.aliveCount()} §8| §7فرق §f${this.aliveTeams().size}`);
      } catch {}
    }
  },

  aliveNames() { return Object.keys(State.data.participants).filter(n => !State.isEliminated(n)); },
  aliveCount() { return this.aliveNames().length; },
  aliveTeams() {
    const st = new Set();
    for (const n of this.aliveNames()) { const t = State.teamOfParticipant(n); if (t) st.add(t); }
    return st;
  },
  teamRoster(k) {
    return Object.entries(State.data.participants).filter(([,t]) => t===k).map(([n]) => n);
  },
  checkWin() {
    const s = State.data;
    if (!CONFIG.winCheckEnabled || s.phase !== "PLAYING") return null;
    if (Object.keys(s.participants).length < 2) return null;
    if (isRespawnActive()) return null;
    const t = this.aliveTeams();
    return t.size > 1 ? null : { winner: t.size === 1 ? [...t][0] : null };
  },
  reset() {
    lastCombat.clear(); roomGame = -1; roomTry = 0;
    for (const p of world.getPlayers()) {
      spr(p, P_PEND, false); spr(p, P_GID, -1); spr(p, P_LOC, ""); spr(p, P_ROOM, "");
    }
  },
};


/* patched: ما يرجع null أبداً — السطر 124 القديم صار كود ميت */
export function safeSpotNear(dim, loc) {
  return safeSpot(dim, loc, { radius: CONFIG.returnRadius ?? 12 });
}
