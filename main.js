import "./spawnprobe.js";
import "./perf.js";
import "./gravelava.js";
import { clearDeaths } from "./graveback.js";
import "./endlock.js";
import "./rejoin.js";
import { steps as pSteps } from "./plan.js";
import { resetNether } from "./extras.js";
// ============================================================================
//  UHC Core - الملف الرئيسي
//  🔧 الجديد: worldLoad له الأولوية (قبل كان system.run يقرأ الحالة بدري
//     ويمسح لعبة كاملة) │ إلغاء البدء لو انوقف وسط التوزيع │ الساعة تبدي
//     بعد ما ينزلون │ عدّاد تنازلي │ combat-log │ فك الكل بعد النهاية
// ============================================================================
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { Border, shrinkInfo } from "./border.js";
import { Teams } from "./teams.js";
import { AntiLag } from "./antilag.js";
import { Bridge } from "./bridge.js";
import { AntiCheat, setNotify } from "./anticheat.js";
import { Respawn, isRespawnActive, respawnTimeLeft, noteCombat } from "./respawn.js";
import {
  titleAll, msgAll, msgTo, soundAll, soundTo, formatMs, gamerule,
  setGameMode, healFull, clearEffects, clearInventory, addEffectSafe,
  forgetPlayer, clamp, findPlayer, isOpSafe, setNameTag, overworld,
} from "./util.js";
import { ar, arRaw } from "./arabic.js";

let scriptOut = [];
let booted = false;
let starting = false;
let countdownDone = new Set();

// ---------------------------------------------------------------------------
//  أدوات
// ---------------------------------------------------------------------------
function report(type, message) {
  try { Bridge.queueReport(type, message); } catch {}
}

function ensureKillsObjective(reset = false) {
  try {
    if (reset) { try { world.scoreboard.removeObjective("uhc_kills"); } catch {} }
    if (!world.scoreboard.getObjective("uhc_kills")) {
      world.scoreboard.addObjective("uhc_kills", "Kills");
    }
  } catch {}
}

function teamLabel(key) {
  if (!key) return null;
  return key.startsWith("solo:") ? `سولو ${key.slice(5)}` : key;
}

function restoreGamerules() {
  gamerule("pvp", "true");
  gamerule("keepinventory", "false");
  gamerule("naturalregeneration", "true");
  gamerule("doimmediaterespawn", "false");     // 🔧 كانت تبقى معدّلة
  gamerule("showdeathmessages", "true");
}

// ---------------------------------------------------------------------------
//  بدء
// ---------------------------------------------------------------------------
async function startGame() {
  try { clearDeaths(); } catch {}
  if (starting) { report("error", "⏳ التوزيع شغال هسه، اصبر."); return; }
  const s = State.data;
  if (s.phase === "GRACE" || s.phase === "PLAYING") {
    report("error", "⚠️ اللعبة شغالة أصلاً. أوقفها أول.");
    return;
  }
  if (world.getPlayers().length === 0) {
    report("error", "⚠️ ماكو ولا لاعب أونلاين.");
    return;
  }

  starting = true;
  const myGame = (s.gameId ?? 0) + 1;

  try {
    const b = s.border;
    b.currentHalf = b.startHalf;
    b.shrinkFromHalf = b.startHalf;
    b.shrinkTargetHalf = b.startHalf;
    b.shrinkAmount = b.cfgShrinkAmount;
    b.shrinkDurationMs = b.cfgShrinkDurationMs;
    b.shrinking = false;
    b.pausedRemainingMs = 0;

    s.gameId = myGame;
    s.eliminated = [];
    s.offlineSince = {};
    s.participants = {};
    s.winner = null;
    s.endedAt = 0;
    s.phase = "GRACE";
    s.gameStartAt = 0;                          // تنظبط بعد التوزيع
    s.grace.endAt = 0;
    s.grace.ended = false;
    s.respawn.endAt = 0;
    s.respawn.announced = false;
    // 🔧 وقت النذر يُفرض من config.js كل مباراة — الحالة المحفوظة ما تفوز
    s.netherMinutes = CONFIG.netherMinutes ?? 90;
    s.netherCloseAt = 0;
    s.scatterUntil = Date.now() + (CONFIG.scatterMaxSeconds + 15) * 1000;
    countdownDone = new Set();
    State.save();

    gamerule("pvp", "false");
    gamerule("naturalregeneration", "true");
    gamerule("doweathercycle", "true");
    gamerule("dodaylightcycle", "true");
    gamerule("showdeathmessages", "true");
    gamerule("showcoordinates", CONFIG.showCoordinates === false ? "false" : "true");
    gamerule("doimmediaterespawn", CONFIG.immediateRespawn ? "true" : "false");
    gamerule("keepinventory", "false");   // مود القبر يتولى العدة

    ensureKillsObjective(true);
    Respawn.reset();
    AntiCheat.reset();
    try { resetNether(); } catch {}          // تحذيرات النذر ترجع بالمباراة الجديدة

    for (const p of world.getPlayers()) {
      try { if (p.hasTag("uhc_exempt")) continue; } catch {}
      clearInventory(p);
      clearEffects(p);
      healFull(p);
    }

    titleAll("§6§lتوزيع اللاعبين", "§7ثبت مكانك، تنتقل بعد ثواني", { stay: 120 });
    const res = await Teams.scatterAll();

    // 🔧 انوقفت اللعبة وسط التوزيع؟ نلغي بلا ما نكتب فوق حالة اللوبي
    if (State.data.gameId !== myGame || State.data.phase !== "GRACE" || res.aborted) {
      console.warn("[UHC] البدء انلغى وسط التوزيع");
      report("error", "🛑 البدء انلغى (انوقفت اللعبة وسط التوزيع).");
      return;
    }

    // 🔧 الساعة تبدي بعد ما ينزلون فعلاً
    s.participants = res.participants;
    s.gameStartAt = Date.now();
    s.grace.endAt = s.gameStartAt + s.grace.minutes * 60000;
    s.respawn.endAt = s.gameStartAt + s.respawn.minutes * 60000;
    s.respawn.announced = s.respawn.minutes <= 0;
    s.scatterUntil = 0;
    State.save();

    titleAll("§6§lبدأت المباراة",
      `§aسماح ${s.grace.minutes} دقيقة §8| §aترجع ${s.respawn.minutes} دقيقة`);
    soundAll(CONFIG.soundGameStart, 1.0, 1.0);
    msgAll(`§6§lبدأت المباراة §8| §7البوردر §f${Math.floor(b.currentHalf)} §8| §7سماح §f${s.grace.minutes} §7دقيقة §8| §7لاعبين §f${Object.keys(s.participants).length}`);

    if (b.cfgShrinkAmount <= 0) {
      msgAll("§eتنبيه: البوردر ثابت ولا يتحرك — ظبط الجدول من البوت");
    }

    report("game",
      `🎮 اللعبة بدأت!\n` +
      `${res.teams} فريق + ${res.solos} سولو (${res.teleported} لاعب)\n` +
      `سماح: ${s.grace.minutes} د │ 💚 رجعة: ${s.respawn.minutes} د │ البوردر: ±${Math.floor(b.currentHalf)}\n` +
      (res.ring ? `📍 التوزيع على حلقة بنصف قطر ${res.ring} من المركز\n` : "") +
      (res.failed.length ? `⚠️ توزيع احتياطي: ${res.failed.join("، ")}\n` : "") +
      (b.cfgShrinkAmount <= 0 ? `⚠️ مقدار الانكماش صفر — البوردر ثابت!\n` : "") +
      `الأحياء: ${Respawn.aliveCount()}`);
  } catch (e) {
    console.warn("[UHC] startGame failed:", e);
    report("error", `❌ فشل البدء: ${e?.message ?? e}`);
    State.data.scatterUntil = 0;
    State.save();
  } finally {
    starting = false;
  }
}

// ---------------------------------------------------------------------------
//  المراحل
// ---------------------------------------------------------------------------
function endGrace() {
  const s = State.data;
  if (s.phase !== "GRACE") return;
  s.phase = "PLAYING";
  s.grace.ended = true;
  State.save();

  gamerule("pvp", "true");
  titleAll("§c§lبدأ القتال", "§7خلص السماح والبوردر يتحرك");
  soundAll(CONFIG.soundGraceEnd, 1.0, 0.9);

  const r = Border.startShrink({ silent: true });
  if (r.ok) {
    msgAll(`§c§lبدأ القتال §8| §7البوردر يصير §f${r.target} §7خلال §f${formatMs(r.durationMs)}`);
  } else {
    msgAll("§c§lبدأ القتال §8| §7البوردر ثابت");
  }
  report("game", `⚔️ خلصت فترة السماح! الـ PVP اشتغل.\n` +
    (r.ok
      ? `🗺 الانكماش: -${r.amount} بلوك خلال ${formatMs(r.durationMs)} → ±${r.target}`
      : `⚠️ الانكماش ما بدأ (${r.reason === "no_amount" ? "المقدار صفر — ظبطه من 🗺" : r.reason})`));
}

function endRespawnWindow() {
  const s = State.data;
  if (s.respawn.announced) return;
  s.respawn.announced = true;
  State.save();

  gamerule("keepinventory", "false");
  for (const nm of Object.keys(s.offlineSince)) s.offlineSince[nm] = Date.now();
  State.save();
  titleAll("§4§lالموت صار نهائي", "§7اللي يموت يخرج من المباراة");
  soundAll(CONFIG.soundFinalDeath, 1.0, 0.9);
  msgAll("§4§lالموت صار نهائي §8| §7اللي يموت يخرج من المباراة");
  report("game", `💀 انتهت فترة الرجعة! أي موت نهائي.\nالأحياء: ${Respawn.aliveCount()}`);
}

function killsTable(limit = 10) {
  try {
    const obj = world.scoreboard.getObjective("uhc_kills");
    if (!obj) return "";
    const rows = obj.getScores()
      .map(sc => ({ name: sc.participant?.displayName ?? "?", score: sc.score }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (!rows.length) return "";
    return "\n🗡 الكِلز:\n" + rows.map((r, i) => `${i + 1}. ${r.name} — ${r.score}`).join("\n");
  } catch { return ""; }
}

function endGame(winnerKey) {
  const s = State.data;
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;
  s.phase = "ENDED";
  s.endedAt = Date.now();
  s.winner = winnerKey ?? null;
  s.border.shrinking = false;
  State.save();

  gamerule("pvp", "false");
  const label = teamLabel(winnerKey);
  const members = winnerKey ? Respawn.teamRoster(winnerKey) : [];
  const duration = formatMs(Date.now() - (s.gameStartAt || Date.now()));

  if (label) {
    titleAll(`§6§lفاز ${label}`, `§7مدة المباراة §f${duration}`, { stay: 140 });
    msgAll(`§6§lالفائز §e${label} §8| §f${members.join(", ")} §8| §7${duration}`);
  } else {
    titleAll("§7خلصت المباراة", "§7ماكو فائز", { stay: 120 });
    msgAll("§7خلصت اللعبة بلا فائز.");
  }
  soundAll(CONFIG.soundWin, 1.0, 1.0);

  report("game",
    `🏆 خلصت اللعبة!\n` +
    (label ? `الفائز: ${label} (${members.join("، ") || "—"})\n` : "ماكو فائز\n") +
    `المدة: ${duration} │ المستبعدين: ${s.eliminated.length}` +
    killsTable());

  // 🔧 نفك الكل من السبكتيت (قبل كانوا يبقون محشورين للأبد)
  system.runTimeout(() => {
    for (const p of world.getPlayers()) {
      setGameMode(p, "survival");
      healFull(p);
      clearEffects(p);
      addEffectSafe(p, "resistance", 20, 4);
      addEffectSafe(p, "slow_falling", 15, 0);
    }
    gamerule("naturalregeneration", "true");
    msgAll("§aرجعنا الكل سيرفايفل — انتظروا المباراة الجديدة");
  }, CONFIG.releaseAfterEndTicks);
}

function stopGame(reason = "") {
  Respawn.reset();
  Border.clearSidebar();
  State.resetGame();
  restoreGamerules();

  for (const p of world.getPlayers()) {
    setGameMode(p, "survival");
    setNameTag(p, p.name);
    clearEffects(p);
    healFull(p);
  }
  titleAll("§7توقفت المباراة", "§7رجعنا للوبي");
  report("game", `🛑 اللعبة توقفت. رجعنا للوبي.${reason ? `\n(${reason})` : ""}`);
}

// ---------------------------------------------------------------------------
//  الحلقة المنطقية
// ---------------------------------------------------------------------------
function announceCountdown(kind, secondsLeft, label) {
  for (const mark of CONFIG.countdownMarks) {
    if (secondsLeft > mark || secondsLeft <= mark - 1) continue;
    const key = `${kind}:${mark}`;
    if (countdownDone.has(key)) return;
    countdownDone.add(key);
    if (mark >= 10) {
      msgAll(`§e${label} §7بعد §f${mark} §7ثانية`);
      soundAll(CONFIG.soundCountdown, 0.7, 1.0);
    } else {
      titleAll(`§c§l${mark}`, `§e${label}`, { fadeIn: 0, stay: 12, fadeOut: 4 });
      soundAll(CONFIG.soundCountdown, 1.0, 0.6 + (5 - mark) * 0.15);
    }
    return;
  }
}


// ---------------------------------------------------------------------------
//  جدول الانكماش التلقائي — يشتغل لحاله بعد ما تضغط بدء
// ---------------------------------------------------------------------------

function phaseTick() {
  const s = State.data;

  // نهاية اللعبة → رجوع تلقائي للوبي
  if (s.phase === "ENDED") {
    if (CONFIG.endedAutoLobbyMinutes > 0 && s.endedAt &&
        Date.now() - s.endedAt > CONFIG.endedAutoLobbyMinutes * 60000) {
      stopGame("رجوع تلقائي بعد نهاية اللعبة");
    }
    return;
  }
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;
  if (starting) return;                        // 🔧 ما نبدي مراحل وهم بالتوزيع
  if (Date.now() < (s.scatterUntil ?? 0)) return;

  const now = Date.now();

  if (s.phase === "GRACE") {
    announceCountdown("grace", Math.ceil((s.grace.endAt - now) / 1000), "يبدأ القتال");
    if (now >= s.grace.endAt) endGrace();
  }
  if (s.respawn.minutes > 0 && !s.respawn.announced) {
    announceCountdown("respawn", Math.ceil((s.respawn.endAt - now) / 1000), "يصير الموت نهائي");
    if (now >= s.respawn.endAt) endRespawnWindow();
  }

  // 🔧 مصالحة الأوفلاين: لاعب طلع وسط التوزيع ما كان ينتسجل
  const onlineSet = new Set(world.getPlayers().map(p => p.name));
  for (const name of Object.keys(s.participants)) {
    if (onlineSet.has(name) || State.isEliminated(name)) continue;
    if (!s.offlineSince[name]) { s.offlineSince[name] = now; State.markDirty(); }
  }

  if (CONFIG.offlineEliminateMinutes > 0 && !isRespawnActive()) {
    const limit = CONFIG.offlineEliminateMinutes * 60000;
    for (const [name, since] of Object.entries(s.offlineSince)) {
      if (now - since < limit) continue;
      delete s.offlineSince[name];
      if (!State.isParticipant(name) || State.isEliminated(name)) { State.markDirty(); continue; }
      State.eliminate(name);
      msgAll(`§7${name} §7انقطع طويل §8— خرج من المباراة`);
      report("death", `⌛ ${name} انقطع أكثر من ${CONFIG.offlineEliminateMinutes} دقيقة → انستبعد.\nالأحياء: ${Respawn.aliveCount()}`);
    }
  }


  const win = Respawn.checkWin();
  if (win) endGame(win.winner);
}

// ---------------------------------------------------------------------------
//  الأحداث
// ---------------------------------------------------------------------------
const CAUSE_AR = {
  fall: "طيحة", lava: "لافا", fire: "نار", fireTick: "نار",
  drowning: "غرق", suffocation: "خنقة", magic: "البوردر/سحر",
  entityExplosion: "انفجار", blockExplosion: "انفجار",
  entityAttack: "ضرب", projectile: "سهم", starve: "جوع",
  freezing: "برد", void: "الفراغ", contact: "كاكتس/شوك",
  wither: "ويثر", lightning: "صاعقة", selfDestruct: "نفسه",
};

function onEntityDie(ev) {
  const dead = ev.deadEntity;
  if (!dead || dead.typeId !== "minecraft:player") return;
  const s = State.data;
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;

  let name;
  try { name = dead.name; } catch { return; }

  const src = ev.damageSource;
  const killer = src?.damagingEntity;
  const killerName = killer?.typeId === "minecraft:player" ? killer.name : null;
  const causeKey = String(src?.cause ?? "");
  const cause = CAUSE_AR[causeKey] ?? causeKey ?? "؟";

  if (killerName && killerName !== name && State.isParticipant(killerName)) {
    try { world.scoreboard.getObjective("uhc_kills")?.addScore(killer, 1); } catch {}
  }

  const r = Respawn.handleDeath(dead);
  if (r.ignored) return;                       // 🔧 غير مشارك

  const team = teamLabel(State.teamOfParticipant(name));
  const by = killerName ? `قتله ${killerName}` : `السبب: ${cause}`;

  if (r.willRespawn) {
    soundAll(CONFIG.soundDeath, 0.5, 1.0);
    msgAll(`§e${name} §7مات §a— يرجع`);
    report("death",
      `↺ ${name} مات — راح يرجع 💚\n${by}${team ? ` │ فريق ${team}` : ""}\n` +
      `تنتهي الرجعة بعد ${respawnTimeLeft()}`);
  } else {
    soundAll(CONFIG.soundFinalDeath, 0.8, 0.8);
    msgAll(`§c§l${name} §cخرج من المباراة §8| §7عايشين §a${Respawn.aliveCount()}`);
    report("death",
      `💀 ${name} مات نهائياً\n${by}${team ? ` │ فريق ${team}` : ""}\n` +
      `👁 صار سبكتيت │ الأحياء: ${Respawn.aliveCount()} │ الفرق الحية: ${Respawn.aliveTeams().size}`);
    const win = Respawn.checkWin();
    if (win) system.runTimeout(() => endGame(win.winner), 40);
  }
}

function onEntityHurt(ev) {
  const s = State.data;
  if (s.phase !== "PLAYING") return;
  const hurt = ev.hurtEntity;
  if (!hurt || hurt.typeId !== "minecraft:player") return;
  const src = ev.damageSource?.damagingEntity;
  if (src?.typeId !== "minecraft:player") return;
  try {
    const ta = State.teamOfParticipant(hurt.name);
    const tb = State.teamOfParticipant(src.name);
    if (ta && tb && ta === tb) return;        // نفس الفريق — مو قتال
    noteCombat(hurt.name);
    noteCombat(src.name);
  } catch {}
}

function onPlayerLeave(name) {
  const r = Respawn.handleLeave(name);
  forgetPlayer(name);
  if (r?.combatLog) {
    msgAll(`§c${name} §7قطع وهو بقتال §8— خرج من المباراة`);
    report("death", `⚔ ${name} combat-log (قطع خلال ${CONFIG.combatLogSeconds} ثانية من القتال) → انستبعد.\nالأحياء: ${Respawn.aliveCount()}`);
    const win = Respawn.checkWin();
    if (win) system.runTimeout(() => endGame(win.winner), 40);
  }
}

// ---------------------------------------------------------------------------
//  أوامر البوت
// ---------------------------------------------------------------------------
function handleCommand(cmd) {
  const a = cmd.action;
  const args = cmd.args ?? {};
  console.warn(`[UHC] bot cmd: ${a} ${JSON.stringify(args)}`);
  const s = State.data;
  const b = s.border;

  switch (a) {
    case "start":
      startGame().catch(e => console.warn("[UHC] start error:", e));
      break;

    case "stop": stopGame("أمر من البوت"); break;

    case "pause_shrink":
      report("info", Border.pauseShrink()
        ? `⏸️ الانكماش وقف على ±${Math.floor(b.currentHalf)} (${formatMs(b.pausedRemainingMs)})`
        : "⚠️ الانكماش أصلاً واقف.");
      break;

    case "resume_shrink":
      report("info", Border.resumeShrink()
        ? `▶️ الانكماش رجع — باقي ${formatMs(b.shrinkDurationMs)} لـ ±${Math.floor(b.shrinkTargetHalf)}`
        : "⚠️ ماكو انكماش موقوف.");
      break;

    case "reshrink": {
      if (s.phase !== "PLAYING" && s.phase !== "GRACE") {
        report("error", "⚠️ اللعبة مو شغالة.");
        break;
      }
      const amount = Math.max(1, Math.floor(Number(args.amount ?? b.cfgShrinkAmount)));
      const durationMs = Math.max(1000, Math.floor(Number(args.durationMs ?? b.cfgShrinkDurationMs)));
      const r = Border.startShrink({ amount, durationMs });
      report("info", r.ok
        ? `🔥 انكماش جديد: -${r.amount} بلوك خلال ${formatMs(r.durationMs)} (من ±${Math.floor(b.shrinkFromHalf)} إلى ±${r.target})`
        : `⚠️ ما انطبق (${r.reason})`);
      break;
    }

    case "shrink_now": {
      const amount = Math.max(1, Math.floor(Number(args.amount ?? b.cfgShrinkAmount)));
      const r = Border.setSize(Math.max(CONFIG.minBorderHalf, b.currentHalf - amount), { alsoStart: false });
      titleAll("§c§lالبوردر تحرك", `§7الحجم §f${r.value}`);
      soundAll(CONFIG.soundShrinkStart, 1.0, 1.0);
      report("info", `⚡ البوردر انكمش فوراً إلى ±${r.value}` +
        (r.cancelled ? "\n⚠️ الانكماش الجاري انلغى." : ""));
      break;
    }

    case "set_border": {
      const size = Number(args.size);
      if (!Number.isFinite(size)) break;
      const running = s.phase === "GRACE" || s.phase === "PLAYING";
      const r = Border.setSize(size, { alsoStart: !running });
      report("info", `📐 البوردر اتظبط على ±${r.value}` +
        (running ? " (وسط اللعبة!)" : "") +
        (r.cancelled ? "\n⚠️ الانكماش الجاري انلغى." : ""));
      break;
    }

    case "set_center": {
      const x = Math.floor(Number(args.x ?? 0)), z = Math.floor(Number(args.z ?? 0));
      if (!Number.isFinite(x) || !Number.isFinite(z)) break;
      b.centerX = x; b.centerZ = z; State.save();
      report("info", `🎯 مركز البوردر (${x}، ${z})`);
      break;
    }

    case "set_hud": {
      const mode = String(args.mode ?? "actionbar");
      if (!["actionbar", "title", "scoreboard"].includes(mode)) break;
      s.hud = s.hud ?? { mode: "actionbar" };
      s.hud.mode = mode;
      State.save();
      if (mode !== "scoreboard") Border.clearSidebar();
      report("info", `👁 العرض صار: ${
        mode === "actionbar" ? "اللوكيشن بار" : mode === "title" ? "فوق الشاشة" : "المنيو الجانبي"}`);
      break;
    }

    case "set_damage": {
      const hearts = clamp(Number(args.hearts ?? 1.5), 0, 20);
      b.damage = hearts * 2;
      State.save();
      report("info", `💔 ضرر البوردر ${hearts} قلب/ثانية`);
      break;
    }

    case "cleardrops": {
      const r = AntiLag.run();
      report("info", `🧹 أغراض -${r.itemsCleared}، XP -${r.xpCleared}، سهام -${r.projCleared}، وحوش -${r.mobsCleared}`);
      break;
    }

    case "announce": {
      const msg = String(args.message ?? "").slice(0, 200);
      if (!msg) break;
      titleAll("§eاعلان", `§f${msg}`);
      msgAll(`§e§l[الادارة] §f${msg}`);
      soundAll("note.pling", 1.0, 1.5);
      break;
    }

    case "revive": {
      const name = String(args.name ?? "");
      if (!name) break;
      if (!State.revive(name)) { report("error", `⚠️ ${name} مو مستبعد.`); break; }
      const p = findPlayer(name);
      if (p) {
        // 🔧 نقل آمن — كاميرا السبكتيت ممكن تكون جوه الأرض
        Respawn.releaseFromSpectate(p);
        msgTo(p, "§aرجعت للمباراة");
        soundTo(p, CONFIG.soundRespawn, 1.0, 1.0);
      }
      msgAll(`§a${name} §7رجع للمباراة`);
      report("info", `✅ ${name} انرجّع. الأحياء: ${Respawn.aliveCount()}`);
      break;
    }

    case "eliminate": {
      const name = String(args.name ?? "");
      if (!name || State.isEliminated(name)) break;
      if (!State.isParticipant(name)) { report("error", `⚠️ ${name} مو مشارك.`); break; }
      State.eliminate(name);
      const p = findPlayer(name);
      if (p) Respawn.forceSpectate(p);
      msgAll(`§c${name} §7خرج بقرار الادارة`);
      report("info", `☠ ${name} انستبعد يدوياً. الأحياء: ${Respawn.aliveCount()}`);
      const win = Respawn.checkWin();
      if (win) endGame(win.winner);
      break;
    }

    case "raw": {
      const cmd = String(args.cmd ?? "").slice(0, 250).replace(/^\//, "").trim();
      if (!cmd) break;
      try {
        const r = overworld().runCommand(cmd);
        console.warn(`[UHC] raw ok: ${cmd}`);
        report("info", `⌨️ نُفّذ: ${cmd}\n✅ تم (${r?.successCount ?? 1})`);
      } catch (e) {
        console.warn(`[UHC] raw FAIL: ${cmd} → ${e?.message ?? e}`);
        report("error", `⌨️ فشل: ${cmd}\n✖ ${e?.message ?? e}\nℹ️ أوامر مثل op/stop/whitelist ما تنفّذ من السكربت — استخدم permissions.json`);
      }
      break;
    }

    case "arabic": {
      State.data.hud = State.data.hud ?? {};
      const on = args.on !== false;
      CONFIG.arabicEnabled = on;
      report("info", on ? "🔤 التشكيل العربي مفعّل" : "🔤 انطفى — النص خام");
      break;
    }

    case "status": report("status", buildStatusText()); break;

    default: console.warn(`[UHC] أمر مجهول: ${a}`);
  }
}

// ---------------------------------------------------------------------------
//  الحالة للبوت
// ---------------------------------------------------------------------------
function buildStatePayload() {
  const s = State.data;
  const b = s.border;
  const info = shrinkInfo();
  return {
    gameId: s.gameId,
    phase: s.phase,
    scattering: Date.now() < (s.scatterUntil ?? 0),
    border: {
      centerX: b.centerX, centerZ: b.centerZ,
      currentHalf: Math.floor(b.currentHalf),
      targetHalf: Math.floor(b.shrinkTargetHalf),
      shrinking: b.shrinking,
      pausedMs: b.pausedRemainingMs,
      remainingMs: info.remainingMs,
      speedPerSec: info.speedPerSec,
      damageHearts: (b.damage ?? CONFIG.damageOutsideBorder) / 2,
    },
    hudMode: s.hud?.mode ?? "actionbar",
    graceMsLeft: Math.max(0, s.grace.endAt - Date.now()),
    respawnMsLeft: Math.max(0, s.respawn.endAt - Date.now()),
    respawnActive: isRespawnActive(),
    alive: Respawn.aliveNames(),
    aliveTeams: [...Respawn.aliveTeams()],
    eliminated: [...s.eliminated],
    participants: s.participants,
    overrides: Object.keys(s.overrides ?? {}),
    winner: s.winner,
    online: world.getPlayers().map(p => p.name),
  };
}

function buildStatusText() {
  const s = State.data;
  const b = s.border;
  const info = shrinkInfo();
  const online = new Set(world.getPlayers().map(p => p.name));

  const groups = {};
  for (const [name, team] of Object.entries(s.participants)) (groups[team] ??= []).push(name);
  const roster = Object.keys(groups).length ? groups : s.teams;

  const teamsText = Object.entries(roster).map(([key, members]) => {
    const alive = members.filter(m => !State.isEliminated(m)).length;
    const list = members.map(m =>
      State.isEliminated(m) ? `☠${m}` : (online.has(m) ? `🟢${m}` : `⚪${m}`)).join("، ");
    return `• ${teamLabel(key)} [${alive}/${members.length}]: ${list}`;
  }).join("\n") || "• (ماكو فرق)";

  const br = Bridge.status();

  return (
    `📊 حالة الـ UHC\n` +
    `المرحلة: ${s.phase}${Date.now() < (s.scatterUntil ?? 0) ? " (يتوزعون)" : ""}\n` +
    `البوردر: ±${Math.floor(b.currentHalf)} عند (${b.centerX}، ${b.centerZ})\n` +
    (info.active
      ? `الانكماش: ${info.speedPerSec} بلوك/ث → ±${info.target} خلال ${formatMs(info.remainingMs)}\n`
      : `الانكماش: واقف${b.pausedRemainingMs > 0 ? ` (موقوف، ${formatMs(b.pausedRemainingMs)})` : ""}\n`) +
    (s.phase === "GRACE" ? `السماح: ${formatMs(s.grace.endAt - Date.now())}\n` : "") +
    `الرجعة: ${isRespawnActive() ? `💚 شغالة (${respawnTimeLeft()})` : "💀 موت نهائي"}\n` +
    `الأحياء: ${Respawn.aliveCount()} / ${Object.keys(s.participants).length} │ أونلاين: ${online.size}\n` +
    `الفرق الحية: ${Respawn.aliveTeams().size}\n` +
    `الضرر بره البوردر: ${(b.damage ?? CONFIG.damageOutsideBorder) / 2} ❤/ثانية\n` +
    `الجسر: ${br.net}${br.online ? " متصل" : " مقطوع"} (ack ${br.ack})\n` +
    `الفرق:\n${teamsText}`
 );
}

// ---------------------------------------------------------------------------
//  أوامر داخل اللعبة
// ---------------------------------------------------------------------------
const HELP = [
  "§6أوامر UHC §7(/scriptevent uhc:...)",
  "§euhc:start §7بدء │ §euhc:stop §7إيقاف │ §euhc:status §7الحالة",
  "§euhc:border 3000 §7حجم │ §euhc:center §7المركز على مكانك",
  "§euhc:shrink 1000 10 §7ينكمش 1000 خلال 10 دقايق",
  "§euhc:pause §7/ §euhc:resume",
  "§euhc:grace 10 §7/ §euhc:respawn 90 §7دقايق",
  "§euhc:damage 1.5 §7قلوب/ثانية │ §euhc:hud scoreboard",
  "§euhc:team Red Ali,Omar §7فريق (بفواصل) │ §euhc:clearteams",
  "§euhc:revive Ali §7/ §euhc:out Ali",
  "§euhc:spec §7/ §euhc:unspec §7مشاهدة/رجوع (أوبريتر)",
  "§euhc:clean §7تنظيف │ §euhc:bridge §7حالة الجسر",
  "§euhc:testar §7فحص العربي │ §euhc:ar off §7إطفاء التشكيل",
  "§euhc:ring 0.85 §7بعد التوزيع │ §euhc:plan §7جدول الانكماش",
  "§euhc:coords on §8/ §euhc:coords off §7الإحداثيات",
  "§euhc:ac §7تقرير التعدين │ §euhc:acheck اسم §7لاعب محدد",
].join("\n");

function onScriptEventInner(ev) {
  if (!ev.id.startsWith("uhc:")) return;
  const sub = ev.id.slice(4);
  const who = ev.sourceEntity;
  const isPlayer = who?.typeId === "minecraft:player";
  // 🔧 قبل: أي مصدر مو لاعب = أوبريتر (كوماند بلوك يكدر يوقف اللعبة)
  const fromConsole = !who && !ev.sourceBlock;
  const op = fromConsole || (isPlayer && isOpSafe(who));

  const say = (t) => {
    const clean = String(t).replace(/§./g, "");
    if (isPlayer) msgTo(who, t);
    else { console.warn(clean); scriptOut.push(clean); }
  };
  const arg = String(ev.message ?? "").trim();
  const parts = arg.split(/\s+/).filter(Boolean);
  const s = State.data;

  if (sub === "help") return say(HELP);

  if (sub === "status") {
    // 🔧 ما نفشي الأحياء لغير الأوبريتر وسط اللعبة
    if (!op && (s.phase === "GRACE" || s.phase === "PLAYING")) {
      return say(`§6البوردر ±${Math.floor(s.border.currentHalf)} §7│ الأحياء ${Respawn.aliveCount()}`);
    }
    return say(`§6${buildStatusText()}`);
  }
  if (sub === "teams") {
    if (!op && (s.phase === "GRACE" || s.phase === "PLAYING")) {
      const mine = State.teamOfParticipant(isPlayer ? who.name : "");
      return say(mine ? `§6فريقك: ${teamLabel(mine)}` : "§7ماكو فريق");
    }
    const t = Object.entries(s.teams).map(([n, m]) => `${n}: ${m.join("، ")}`).join(" | ") || "ماكو فرق";
    return say(`§6${t}`);
  }
  if (sub === "bridge") return say(`§6${JSON.stringify(Bridge.status())}`);

  if (!op) return say("§c⛔ هذا الأمر للأوبريتر بس.");

  switch (sub) {
    case "start": startGame().catch(e => console.warn(e)); break;
    case "stop": stopGame("أمر داخل اللعبة"); break;

    case "clean": {
      const r = AntiLag.run();
      say(`§a🧹 أغراض -${r.itemsCleared} │ XP -${r.xpCleared} │ سهام -${r.projCleared} │ وحوش -${r.mobsCleared}`);
      break;
    }

    case "border": {
      const v = Number(parts[0]);
      if (!Number.isFinite(v)) return say("§cمثال: uhc:border 3000");
      const r = Border.setSize(v);
      State.markOverride("borderSize");
      say(`§a📐 البوردر ±${r.value}${r.cancelled ? " §e(الانكماش الجاري انلغى)" : ""}`);
      break;
    }

    case "center": {
      if (!isPlayer) return say("§cلازم لاعب.");
      s.border.centerX = Math.floor(who.location.x);
      s.border.centerZ = Math.floor(who.location.z);
      State.markOverride("centerX"); State.markOverride("centerZ");
      say(`§a🎯 المركز (${s.border.centerX}، ${s.border.centerZ})`);
      break;
    }

    case "shrink": {
      const amount = Number(parts[0]), minutes = Number(parts[1] ?? 10);
      if (!Number.isFinite(amount) || !Number.isFinite(minutes) || minutes < 1) {
        return say("§cمثال: uhc:shrink 1000 10");
      }
      s.border.cfgShrinkAmount = Math.max(0, Math.floor(amount));
      s.border.cfgShrinkDurationMs = Math.max(1, Math.floor(minutes)) * 60000;
      State.markOverride("shrinkAmount"); State.markOverride("shrinkMinutes");
      if (s.phase === "PLAYING" || s.phase === "GRACE") {
        const r = Border.startShrink();
        say(r.ok ? `§a🔥 -${r.amount} خلال ${formatMs(r.durationMs)} → ±${r.target}` : `§c${r.reason}`);
      } else {
        s.border.shrinkAmount = s.border.cfgShrinkAmount;
        s.border.shrinkDurationMs = s.border.cfgShrinkDurationMs;
        State.save();
        say(`§a⏳ انحفظ: -${amount} خلال ${minutes} د`);
      }
      break;
    }

    case "hud": {
      const mode = parts[0] ?? "actionbar";
      if (mode === "on" || mode === "off") {
        s.hud = s.hud ?? { mode: "actionbar", off: false };
        s.hud.off = mode === "off";
        State.save();
        if (s.hud.off) Border.clearSidebar();
        say(s.hud.off ? "§e✔ الشريط انطفى" : "§a✔ الشريط اشتغل");
        break;
      }
      if (!["actionbar", "title", "scoreboard"].includes(mode)) {
        return say("§cمثال: uhc:hud actionbar | title | scoreboard | on | off");
      }
      handleCommand({ action: "set_hud", args: { mode } });
      State.markOverride("hudMode");
      say(`§a👁 العرض: ${mode}`);
      break;
    }

    case "pause": say(Border.pauseShrink() ? "§a⏸️ وقف" : "§7أصلاً واقف"); break;
    case "resume": say(Border.resumeShrink() ? "§a▶️ رجع" : "§7ماكو شي موقوف"); break;

    case "grace": {
      const m = Number(parts[0]);
      if (!Number.isFinite(m) || m < 0) return say("§cمثال: uhc:grace 10");
      s.grace.minutes = clamp(Math.floor(m), 0, 600);
      if (s.phase === "GRACE" && s.gameStartAt) s.grace.endAt = s.gameStartAt + s.grace.minutes * 60000;
      State.markOverride("graceMinutes");
      say(`§a🕊 السماح ${s.grace.minutes} د`);
      break;
    }

    case "respawn": {
      const m = Number(parts[0]);
      if (!Number.isFinite(m) || m < 0) return say("§cمثال: uhc:respawn 90");
      s.respawn.minutes = clamp(Math.floor(m), 0, 1440);
      if (s.gameStartAt && s.phase !== "LOBBY") {
        s.respawn.endAt = s.gameStartAt + s.respawn.minutes * 60000;
        s.respawn.announced = Date.now() >= s.respawn.endAt;
      }
      State.markOverride("respawnMinutes");
      say(`§a💚 الرجعة ${s.respawn.minutes} د`);
      break;
    }

    case "damage": {
      const h = Number(parts[0]);
      if (!Number.isFinite(h)) return say("§cمثال: uhc:damage 1.5");
      s.border.damage = clamp(h, 0, 20) * 2;
      State.markOverride("damageHearts");
      say(`§a💔 ${h} قلب/ثانية`);
      break;
    }

    case "team": {
      const name = parts[0];
      if (!name) return say("§cمثال: uhc:team Red Ali,Omar");
      const rest = arg.slice(arg.indexOf(name) + name.length).trim();
      const members = rest ? rest.split(",").map(x => x.trim()).filter(Boolean) : [];
      for (const [t, list] of Object.entries(s.teams)) {
        if (t === name) continue;
        s.teams[t] = (list ?? []).filter(m => !members.includes(m));
      }
      s.teams[name] = members;
      State.markOverride("teams");
      say(`§a👥 ${name}: ${members.join("، ") || "فاضي"}`);
      report("info", `👥 تعديل فرق من داخل اللعبة: ${name} = ${members.join("، ") || "فاضي"}\n(⚠️ ينلغى لو عدّلت الفرق من البوت)`);
      break;
    }

    case "clearteams":
      s.teams = {};
      State.markOverride("teams");
      say("§a🗑 انمسحت الفرق");
      break;

    case "revive": {
      const n = parts.join(" ");
      if (!n) return say("§cمثال: uhc:revive Ali");
      handleCommand({ action: "revive", args: { name: n } });
      say(`§a↺ ${n}`);
      break;
    }

    case "out": {
      const n = parts.join(" ");
      if (!n) return say("§cمثال: uhc:out Ali");
      handleCommand({ action: "eliminate", args: { name: n } });
      say(`§c☠ ${n}`);
      break;
    }

    case "testar": {
      const t = "البوردر ينكمش — انتبه للاعبين الأحياء";
      say("§8── فحص العربي ──");
      say("§7[1 خام] §f" + t);
      say("§7[2 مصلّح] §f" + ar(t));
      say("§7[3 أشكال بس] §f" + arRaw(t));
      say("§8إذا رقم 2 مقروء ومتصل → §aشغّل التشكيل§8. إذا مربعات → §euhc:ar off");
      break;
    }

    case "ar": {
      const v = (parts[0] ?? "").toLowerCase();
      CONFIG.arabicEnabled = !(v === "off" || v === "0" || v === "false");
      say(CONFIG.arabicEnabled ? "§a✔ التشكيل مفعّل" : "§e✔ انطفى — النص خام");
      break;
    }

    case "coords": {
      const v = (parts[0] ?? "on").toLowerCase();
      const on = !(v === "off" || v === "0" || v === "false");
      CONFIG.showCoordinates = on;
      gamerule("showcoordinates", on ? "true" : "false");
      say(on ? "§a✔ الإحداثيات ظاهرة للكل" : "§e✔ الإحداثيات انطفت");
      break;
    }

    case "ac": {
      const rows = AntiCheat.top(10);
      if (!rows.length) return say("§7ماكو بيانات تعدين بعد");
      say("§6§lتقرير التعدين §8(النسبة الطبيعية للالماس 1:800+)");
      for (const r of rows) say("§7" + r);
      break;
    }

    case "acheck": {
      const nm = parts.join(" ");
      const r = nm ? AntiCheat.statsOf(nm) : null;
      say(r ? "§6" + r : "§7ماكو بيانات لهذا اللاعب");
      break;
    }

    case "room": {
      say("§7نبني غرفة الخارجين...");
      Respawn.prepRoom().then((c) => {
        if (isPlayer) msgTo(who, `§aالغرفة جاهزة §f${c.x} ${c.y} ${c.z}`);
        report("info", `🏠 غرفة الخارجين جاهزة عند ${c.x} ${c.y} ${c.z}`);
      }).catch((e) => report("error", "✖ فشل بناء الغرفة: " + (e?.message ?? e)));
      break;
    }

    case "edge": {
      if (!isPlayer) return say("§cلازم لاعب.");
      const eb = s.border;
      const H = Math.floor(eb.currentHalf);
      const M = Math.max(0, H - 10);
      const k = (parts[0] ?? "").toLowerCase();
      const ya = Number(parts[1]);
      const ey = Number.isFinite(ya) ? Math.floor(ya) : 120;
      const T = {
        e: [M, 0, "شرق"], w: [-M, 0, "غرب"], s: [0, M, "جنوب"], n: [0, -M, "شمال"],
        ne: [M, -M, "شمال شرق"], nw: [-M, -M, "شمال غرب"],
        se: [M, M, "جنوب شرق"], sw: [-M, M, "جنوب غرب"], c: [0, 0, "المركز"],
      }[k];
      if (!T) {
        say(`§7البوردر §f${H} §7من المركز §8| §7الضلع §f${H * 2}`);
        say("§euhc:edge e §8/ §ew §8/ §es §8/ §en §8/ §ec");
        say("§7زوايا: §ene §8/ §enw §8/ §ese §8/ §esw §8| §7ارتفاع: §euhc:edge e 90");
        break;
      }
      setGameMode(who, "creative");
      who.teleport({ x: eb.centerX + T[0] + 0.5, y: ey, z: eb.centerZ + T[1] + 0.5 },
                   { dimension: overworld() });
      say(`§a${T[2]} §8| §f${eb.centerX + T[0]} ${ey} ${eb.centerZ + T[1]} §8| §7كريتف`);
      break;
    }

    case "spec": {
      if (!isPlayer) return say("§cلازم لاعب.");
      setGameMode(who, "spectator");
      say("§7👁 صرت مشاهد. §euhc:unspec§7 للرجوع.");
      break;
    }

    case "unspec": {
      if (!isPlayer) return say("§cلازم لاعب.");
      Respawn.releaseFromSpectate(who, { anchor: null });
      say("§a✅ رجعت سيرفايفل.");
      break;
    }

    default: if (!["plan", "ring", "nether", "chat", "end"].includes(sub)) say(HELP);
  }
}

// الرد يرجع للبوت
function onScriptEvent(ev) {
  scriptOut = [];
  try { onScriptEventInner(ev); }
  catch (e) {
    const em = e?.message ?? String(e);
    console.warn(`[UHC] أمر ${ev.id} فشل:`, em);
    scriptOut.push("✖ خطأ: " + em);
  }
  finally {
    if (scriptOut.length) {
      try { Bridge.queueReport("cmd", `⌨️ ${ev.id}\n` + scriptOut.join("\n")); } catch {}
      scriptOut = [];
    }
  }
}

// ---------------------------------------------------------------------------
//  التشغيل
// ---------------------------------------------------------------------------
function subscribeEvents() {
  const sub = (label, fn) => {
    try { fn(); } catch (e) { console.warn(`[UHC] subscribe ${label} فشل:`, e?.message ?? e); }
  };

  sub("blockBreak", () => world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try { AntiCheat.onBreak(ev); } catch {}
  }));

  sub("entityDie", () => world.afterEvents.entityDie.subscribe((ev) => {
    try { onEntityDie(ev); } catch (e) { console.warn("[UHC] die:", e); }
  }));

  sub("entityHurt", () => world.afterEvents.entityHurt.subscribe((ev) => {
    try { onEntityHurt(ev); } catch {}
    try { AntiCheat.onHurt(ev); } catch {}
  }));

  sub("playerSpawn", () => world.afterEvents.playerSpawn.subscribe((ev) => {
    try {
      if (ev.initialSpawn) Respawn.handleJoin(ev.player);
      else Respawn.handlePlayerRespawn(ev.player);
    } catch (e) { console.warn("[UHC] spawn:", e); }
  }));

  sub("playerLeave", () => world.afterEvents.playerLeave.subscribe((ev) => {
    try { onPlayerLeave(ev.playerName); } catch (e) { console.warn("[UHC] leave:", e); }
  }));

  sub("scriptEvent", () => system.afterEvents.scriptEventReceive.subscribe((ev) => {
    try { onScriptEvent(ev); } catch (e) { console.warn("[UHC] scriptevent:", e); }
  }));
}

function registerLoops() {
  const loop = (label, fn, ticks) => {
    system.runInterval(() => {
      try { fn(); } catch (e) { console.warn(`[UHC] loop ${label}:`, e?.message ?? e); }
    }, ticks);
  };

  loop("border", () => Border.tick(), CONFIG.borderTickTicks);
  loop("phase", () => phaseTick(), CONFIG.phaseTickTicks);
  loop("spectate", () => Respawn.tick(), CONFIG.spectateCheckTicks);
  loop("antilag", () => AntiLag.run(), CONFIG.antiLagIntervalTicks);
  loop("audit", () => AntiCheat.audit(), CONFIG.acAuditIntervalTicks ?? 1200);
  loop("save", () => State.flush(), CONFIG.saveFlushTicks);   // 🔧 الحفظ هنا بس

  if (CONFIG.bridgeEnabled) {
    Bridge.onCommand = handleCommand;
    Bridge.getState = buildStatePayload;
    loop("poll", () => { Bridge.poll(); }, CONFIG.pollTicks);
    loop("report", () => { Bridge.flushReports(); }, CONFIG.reportTicks);
  }
}

function init() {
  State.load();
  Bridge.init();
  const s = State.data;
  console.warn(`[UHC] init: phase=${s.phase} border=±${Math.floor(s.border.currentHalf)} gameId=${s.gameId}`);

  // التوزيع كان شغال وقت الريستارت → ما نكدر نكمله
  if (s.scatterUntil && Date.now() < s.scatterUntil) {
    console.warn("[UHC] ريستارت وسط التوزيع → رجوع للوبي");
    s.scatterUntil = 0;
    State.resetGame();
    restoreGamerules();
    report("error", "⚠️ السيرفر سوى ريستارت وسط التوزيع — رجعنا للوبي. ابدأ من جديد.");
  } else {
    s.scatterUntil = 0;
  }

  if (s.phase === "GRACE" && s.gameStartAt && Date.now() >= s.grace.endAt) {
    console.warn("[UHC] ريستارت بعد نهاية السماح → نطبقها هسه");
    endGrace();
  }
  if ((s.phase === "GRACE" || s.phase === "PLAYING") && s.respawn.minutes > 0 &&
      !s.respawn.announced && Date.now() >= s.respawn.endAt) {
    endRespawnWindow();
  }
  if (s.phase === "PLAYING" || s.phase === "GRACE") {
    gamerule("pvp", s.phase === "PLAYING" ? "true" : "false");
    gamerule("naturalregeneration", "true");
    gamerule("doimmediaterespawn", CONFIG.immediateRespawn ? "true" : "false");
    gamerule("keepinventory", "false");
    if (s.border.shrinking) {
      console.warn(`[UHC] الانكماش يكمل → ±${Math.floor(s.border.shrinkTargetHalf)}`);
    }
    report("info", `♻️ السيرفر رجع. ${s.phase} │ البوردر ±${Math.floor(s.border.currentHalf)} │ الأحياء ${Respawn.aliveCount()}`);
  } else if (s.phase === "ENDED") {
    Border.clearSidebar();
  }

  gamerule("showcoordinates", CONFIG.showCoordinates === false ? "false" : "true");
  setNotify((who, kind, txt) => {
    report("cheat", `🚨 شبهة غش\nاللاعب: ${who}\nالنوع: ${kind}\n${txt}`);
  });
  subscribeEvents();
  registerLoops();
  console.warn("[UHC] جاهز. /scriptevent uhc:help");
}

function boot() {
  if (booted) return;
  booted = true;
  try { init(); }
  catch (e) { console.warn("[UHC] init فشل:", e); }
}

// 🔧 worldLoad له الأولوية: قراءة dynamic properties قبله مو مضمونة،
//    وقراءة فاشلة + حفظ = محو لعبة كاملة. system.run صار احتياطي بس.
let gotWorldLoad = false;
try {
  world.afterEvents.worldLoad.subscribe(() => { gotWorldLoad = true; boot(); });
} catch (e) {
  console.warn("[UHC] worldLoad غير متاح:", e?.message ?? e);
}
system.runTimeout(() => {
  if (!gotWorldLoad) { console.warn("[UHC] ماكو worldLoad → تشغيل احتياطي"); boot(); }
}, 20);
