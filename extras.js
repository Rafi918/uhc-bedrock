// UHC - بوابة النذر + قفل الشات
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { msgAll, msgTo, soundAll, titleAll, overworld, isOpSafe,
         addEffectSafe, formatMs } from "./util.js";

const warned = new Set();
let closedAt = 0;
let chatHook = "none";

function endAt() {
  const s = State.data;
  if (Number.isFinite(s.netherCloseAt) && s.netherCloseAt > 0) return s.netherCloseAt;
  if (!s.gameStartAt) return 0;
  const m = Number(s.netherMinutes ?? CONFIG.netherMinutes ?? 100);
  return m > 0 ? s.gameStartAt + m * 60000 : 0;
}

export function netherOpen() {
  const s = State.data;
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return true;
  const e = endAt();
  return e === 0 || Date.now() < e;
}

export function resetNether() {
  warned.clear();
  closedAt = 0;
  try { State.data.netherCloseAt = 0; State.save(); } catch {}
  try { warned.clear(); closedAt = 0; } catch {}
}

function inNether(p) {
  try { return String(p.dimension.id).includes("nether"); } catch { return false; }
}

function pullOut(p) {
  try {
    const l = p.location;
    const x = Math.round(l.x * 8), z = Math.round(l.z * 8);
    const dim = overworld();
    try { dim.runCommand(`tickingarea add circle ${x} 180 ${z} 2 uhc_no`); } catch {}
    addEffectSafe(p, "slow_falling", 30, 0);
    addEffectSafe(p, "resistance", 20, 4);
    addEffectSafe(p, "fire_resistance", 20, 0);
    p.teleport({ x: x + 0.5, y: 240, z: z + 0.5 }, { dimension: dim });
    msgTo(p, "§cالنذر انسد §8| §7رجعناك للعالم العادي");
    system.runTimeout(() => { try { dim.runCommand("tickingarea remove uhc_no"); } catch {} }, 200);
  } catch {}
}

let lastGid = -1;
function tick() {
  const s = State.data;
  if (s.gameId !== lastGid) { lastGid = s.gameId; warned.clear(); closedAt = 0; }
  if (s.phase !== "GRACE" && s.phase !== "PLAYING") return;
  if (Date.now() < (s.scatterUntil ?? 0)) return;
  const e = endAt();
  if (!e) return;
  const left = e - Date.now();

  if (left > 0) {
    const sec = Math.ceil(left / 1000);
    const marks = [...(CONFIG.netherWarnMarks ?? [1800, 1200, 600, 300, 180, 60, 30, 10])]
      .map(Number).filter(Number.isFinite).sort((a, b) => b - a);
    // 🔧 نافذة الثانية الواحدة كانت تفوّت التحذير لو تأخّرت التكة → نعلن أي علامة عبرناها
    const due = marks.filter((mk) => sec <= mk && !warned.has(mk));
    if (due.length) {
      for (const mk of due) warned.add(mk);
      const urgent = Math.min(...due);
      const txt = netherLeftText(left);        // المتبقي الحقيقي، مو رقم العلامة
      msgAll(`§6§lتحذير §8| §eالنذر ينسد بعد §f${txt}§e — اطلعوا من النذر`);
      soundAll(CONFIG.soundCountdown ?? "note.hat", 1.0, urgent <= 60 ? 0.6 : 1.0);
      if (urgent <= 300) titleAll("§6§lالنذر ينسد", `§e${txt}`,
        { stay: urgent <= 60 ? 40 : 30 });
      console.warn(`[UHC] nether warn: متبقي ${txt} (علامة ${urgent}ث)`);
    }
    return;
  }

  if (closedAt === 0) {
    closedAt = Date.now();
    msgAll("§4§lالنذر انسد §8| §7ماكو دخول بعد هسه");
    titleAll("§4§lالنذر انسد", "§7ماكو دخول بعد هسه", { stay: 70 });
    soundAll(CONFIG.soundFinalDeath ?? "mob.enderdragon.death", 1, 0.8);
  }
  for (const p of world.getPlayers()) if (inNether(p)) pullOut(p);
}

function muteCmd(p, on) {
  try { overworld().runCommand(`ability "${p.name}" mute ${on ? "true" : "false"}`); } catch {}
}

export function applyChatLock() {
  if (chatHook === "chatSend") return;
  const off = State.data.chatOff === true;
  for (const p of world.getPlayers()) muteCmd(p, isOpSafe(p) ? false : off);
}

function handle(ev) {
  const id = ev.id;
  if (id !== "uhc:nether" && id !== "uhc:chat" && id !== "uhc:end") return;
  const who = ev.sourceEntity;
  const isP = who?.typeId === "minecraft:player";
  const op = (!who && !ev.sourceBlock) || (isP && isOpSafe(who));
  const out = [];
  const say = (t) => { if (isP) msgTo(who, t); else out.push(String(t).replace(/§./g, "")); };
  const fin = () => {
    if (!out.length) return;
    import("./bridge.js")
      .then(m => { try { m.Bridge.queueReport("cmd", out.join("\n")); } catch {} })
      .catch(() => {});
  };
  if (!op) { say("§cللاوبريتر بس"); fin(); return; }

  const parts = String(ev.message ?? "").trim().split(/\s+/).filter(Boolean);
  const s = State.data;

  if (id === "uhc:chat") {
    const v = (parts[0] ?? "").toLowerCase();
    if (v !== "on" && v !== "off") {
      say(`§7الشات: ${s.chatOff ? "§cمقفول" : "§aمفتوح"} §8| §f${chatHook}`);
      say("§euhc:chat off §8/ §euhc:chat on");
    } else {
      s.chatOff = v === "off";
      State.save();
      applyChatLock();
      say(s.chatOff ? "§aالشات انقفل" : "§aالشات انفتح");
      msgAll(s.chatOff ? "§7الشات مقفول من الادارة" : "§aالشات انفتح");
    }
    fin(); return;
  }

  if (id === "uhc:end") {
    const v = (parts[0] ?? "").toLowerCase();
    if (v !== "on" && v !== "off") {
      say(`§7الاند: ${s.endOpen === true ? "§aمفتوح" : "§cمقفول"}`);
      say("§euhc:end off §8/ §euhc:end on");
    } else {
      s.endOpen = v === "on";
      State.save();
      say(s.endOpen ? "§eالاند انفتح" : "§aالاند انقفل");
      msgAll(s.endOpen ? "§eالاند مفتوح" : "§7الاند مقفول بهاي المباراة");
    }
    fin(); return;
  }

  const v0 = (parts[0] ?? "").toLowerCase();
  if (v0 === "off") {
    s.netherMinutes = 0; State.save(); resetNether();
    say("§aالنذر مفتوح دايما");
  } else if (v0 === "now") {
    s.netherCloseAt = Date.now() - 1000; State.save();
    say("§aينسد النذر حالا");
  } else {
    const m = Number(parts[0]);
    if (!Number.isFinite(m) || m < 0) {
      const e = endAt();
      say(`§7النذر: ${netherOpen() ? "§aمفتوح" : "§cمسدود"}`);
      if (e) say(`§7المدة §f${s.netherMinutes ?? CONFIG.netherMinutes ?? 100}§7 دقيقة`
        + (netherOpen() ? ` §8| §7ينسد بعد §f${formatMs(e - Date.now())}` : ""));
      say("§7مثال: §euhc:nether 100 §8/ §euhc:nether off");
    } else {
      s.netherMinutes = Math.floor(m); State.save(); resetNether();
      say(`§aالنذر مفتوح §f${Math.floor(m)}§a دقيقة من البداية`);
    }
  }
  fin();
}

system.run(() => {
  try {
    world.beforeEvents.chatSend.subscribe((ev) => {
      try {
        if (State.data.chatOff !== true) return;
        if (isOpSafe(ev.sender)) return;
        ev.cancel = true;
        msgTo(ev.sender, "§cالشات مقفول");
      } catch {}
    });
    chatHook = "chatSend";
  } catch {
    chatHook = "ability";
    console.warn("[UHC] chatSend غير متاح — نستخدم ability mute");
  }
  try {
    system.afterEvents.scriptEventReceive.subscribe((ev) => {
      try { handle(ev); } catch (e) { console.warn("[UHC extras]", e); }
    });
  } catch {}
  try {
    world.afterEvents.playerDimensionChange.subscribe((ev) => {
      try {
        if (netherOpen()) return;
        if (String(ev.toDimension?.id ?? "").includes("nether")) pullOut(ev.player);
      } catch {}
    });
  } catch {}
  try {
    world.afterEvents.playerSpawn.subscribe(() => {
      try { system.runTimeout(() => applyChatLock(), 40); } catch {}
    });
  } catch {}
  system.runInterval(() => { try { tick(); } catch (e) { console.warn("[UHC nether]", e); } }, 20);
  system.runInterval(() => { try { applyChatLock(); } catch {} }, 600);
  console.warn(`[UHC] extras.js جاهز (chat=${chatHook})`);
});


/* ===== المتبقي لقفل النذر — يستخدمه الشريط ===== */
export function netherLeftMs() {
  try {
    const s = State.data;
    if (s.phase !== "GRACE" && s.phase !== "PLAYING") return 0;
    const e = endAt();
    if (!e) return 0;
    return Math.max(0, e - Date.now());
  } catch { return 0; }
}
export function netherLeftText(ms) {
  const tt = Math.max(0, Math.floor((ms ?? netherLeftMs()) / 1000));
  const m = Math.floor(tt / 60), s = tt % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`
                    + `:${String(s).padStart(2, "0")}`;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s} ثانية`;
}
