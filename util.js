// ============================================================================
//  UHC Core - أدوات مشتركة
//  كل شي محاط بـ try/catch: لاعب واحد يفشل ما يوقف اللوب للباقي
// ============================================================================
import { world, system, GameMode, EntityDamageCause } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { ar } from "./arabic.js";

// ---- server 2.x بدّل أعضاء الـ enums لـ PascalCase ----
function pick(obj, name, fallback) {
  if (!obj) return fallback;
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  return obj[name] ?? obj[lower] ?? obj[name.toLowerCase()] ?? fallback;
}

export const GM = {
  survival: pick(GameMode, "Survival", "survival"),
  spectator: pick(GameMode, "Spectator", "spectator"),
  creative: pick(GameMode, "Creative", "creative"),
  adventure: pick(GameMode, "Adventure", "adventure"),
};

export const CAUSE_MAGIC = pick(EntityDamageCause, "Magic", "magic");

function fx(t) { return CONFIG.arabicEnabled === false ? t : ar(t); }

export function overworld() { return world.getDimension("overworld"); }

export function findPlayer(name) {
  try { return world.getPlayers().find(p => p.name === name) ?? null; }
  catch { return null; }
}

// ---------------------------------------------------------------------------
//  وقت
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "--:--";          // 🔧 كان يطبع NaN:NaN
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
//  قفل التايتل — يمنع HUD وضع "title" من مسح التايتلات المهمة
// ---------------------------------------------------------------------------
let titleLockGlobal = 0;
const titleLockPlayer = new Map();

export function lockTitle(ticks = 60, player = null) {
  const until = system.currentTick + ticks;
  if (player) titleLockPlayer.set(player.name, until);
  else titleLockGlobal = until;
}

export function titleLocked(player) {
  const now = system.currentTick;
  if (now < titleLockGlobal) return true;
  if (!player) return false;
  const t = titleLockPlayer.get(player.name);
  return t !== undefined && now < t;
}

// ---------------------------------------------------------------------------
//  رسائل
// ---------------------------------------------------------------------------
export function msgAll(text) {
  try { world.sendMessage(fx(String(text))); } catch (e) { console.warn("[UHC] msgAll:", e); }
}

export function msgTo(player, text) {
  try { player.sendMessage(fx(String(text))); } catch {}
}

export function titleAll(title, subtitle = "", opts = {}) {
  const fadeIn = opts.fadeIn ?? 10, stay = opts.stay ?? 50, fadeOut = opts.fadeOut ?? 15;
  lockTitle(fadeIn + stay + fadeOut + 5);
  for (const p of world.getPlayers()) {
    try {
      p.onScreenDisplay.setTitle(fx(title), {
        subtitle: fx(subtitle), fadeInDuration: fadeIn, stayDuration: stay, fadeOutDuration: fadeOut,
      });
    } catch {}
  }
}

export function titleTo(player, title, subtitle = "") {
  lockTitle(60, player);
  try {
    player.onScreenDisplay.setTitle(fx(title), {
      subtitle: fx(subtitle), fadeInDuration: 5, stayDuration: 45, fadeOutDuration: 10,
    });
  } catch {}
}

export function actionBar(player, text) {
  try { player.onScreenDisplay.setActionBar(fx(text)); } catch {}
}

// ---------------------------------------------------------------------------
//  أصوات
// ---------------------------------------------------------------------------
const lastSoundTick = new Map();

export function soundAll(soundId, volume = 1.0, pitch = 1.0) {
  if (!CONFIG.soundEnabled || !soundId) return;
  for (const p of world.getPlayers()) {
    try { p.playSound(soundId, { volume, pitch }); } catch {}
  }
}

export function soundTo(player, soundId, volume = 1.0, pitch = 1.0) {
  if (!CONFIG.soundEnabled || !soundId) return;
  try { player.playSound(soundId, { volume, pitch }); } catch {}
}

export function soundOnce(player, soundId, intervalTicks, volume = 1.0, pitch = 1.0) {
  if (!CONFIG.soundEnabled || !soundId) return;
  const now = system.currentTick;
  const key = `${player.name}:${soundId}`;
  const last = lastSoundTick.get(key);
  if (last !== undefined && now - last < intervalTicks) return;
  lastSoundTick.set(key, now);
  try { player.playSound(soundId, { volume, pitch }); } catch {}
}

export function forgetPlayer(name) {
  for (const key of [...lastSoundTick.keys()]) {
    if (key.startsWith(`${name}:`)) lastSoundTick.delete(key);
  }
  titleLockPlayer.delete(name);
}

// ---------------------------------------------------------------------------
//  جيم مود / صحة / عدة
// ---------------------------------------------------------------------------
export function setGameMode(player, mode) {
  const value = GM[mode] ?? mode;
  try {
    if (typeof player.setGameMode === "function") { player.setGameMode(value); return true; }
  } catch {}
  try { player.runCommand(`gamemode ${mode} @s`); return true; } catch {}
  return false;
}

export function gameModeOf(player) {
  try {
    if (typeof player.getGameMode === "function") return String(player.getGameMode()).toLowerCase();
  } catch {}
  return "survival";
}

export function isSpectatorLike(player) {
  const gm = gameModeOf(player);
  return gm === "spectator" || gm === "creative";
}

export function isOpSafe(entity) {
  try {
    if (!entity) return false;
    const lvl = entity.commandPermissionLevel;
    if (lvl !== undefined && lvl !== null) return Number(lvl) >= 1;
    if (typeof entity.isOp === "function") return entity.isOp();
    return false;
  } catch { return false; }
}

export function healFull(player) {
  try {
    const hp = player.getComponent("minecraft:health");
    if (hp) hp.setCurrentValue(hp.effectiveMax);
  } catch {}
  try {
    const hunger = player.getComponent("minecraft:player.hunger");
    if (hunger) hunger.setCurrentValue(hunger.effectiveMax ?? 20);
  } catch {}
  try {
    const sat = player.getComponent("minecraft:player.saturation");
    if (sat) sat.setCurrentValue(sat.effectiveMax ?? 20);
  } catch {}
}

export function healthOf(player) {
  try { return Math.round(player.getComponent("minecraft:health")?.currentValue ?? 0); }
  catch { return null; }
}

export function clearEffects(player) {
  try {
    for (const e of player.getEffects()) {
      try { player.removeEffect(e.typeId); } catch {}
    }
  } catch {}
}

// 🔧 الاحتياطي كان يترك الدرع واليد الثانية
const SLOTS = ["Head", "Chest", "Legs", "Feet", "Offhand"];

export function clearInventory(player) {
  let ok = false;
  try { player.runCommand("clear @s"); ok = true; } catch {}
  if (ok) return;
  try { player.getComponent("minecraft:inventory")?.container?.clearAll(); } catch {}
  try {
    const eq = player.getComponent("minecraft:equippable");
    if (eq) for (const s of SLOTS) { try { eq.setEquipment(s, undefined); } catch {} }
  } catch {}
}

export function addEffectSafe(player, type, seconds, amplifier = 0) {
  try {
    player.addEffect(type, Math.max(1, Math.floor(seconds * 20)), {
      amplifier, showParticles: false,
    });
  } catch {}
}

export function setNameTag(player, text) {
  try { player.nameTag = text; } catch {}
}

// ---------------------------------------------------------------------------
//  gamerule
// ---------------------------------------------------------------------------
export function gamerule(rule, value) {
  try { overworld().runCommand(`gamerule ${rule} ${value}`); return true; }
  catch (e) { console.warn(`[UHC] gamerule ${rule} failed:`, e?.message ?? e); return false; }
}

// ---------------------------------------------------------------------------
//  هندسة
// ---------------------------------------------------------------------------
export function dimScale(dimensionId) {
  return String(dimensionId).includes("nether") ? CONFIG.netherScale : 1;
}

export function dist2D(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist3D(a, b) {
  const dx = a.location.x - b.location.x;
  const dy = a.location.y - b.location.y;
  const dz = a.location.z - b.location.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
