// perf.js — مقياس TPS + تجربة A/B مضبوطة
// يشتغل من الشات (لاعب) ومن البوت/الكونسول (بلا مصدر) — المخرَج يروح للاعب أو للوق والبوت
import { world, system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { Bridge } from "./bridge.js";

const WIN = 200;
let last = Date.now(), win = [], acc = null;
let logEvery = 0, logAt = 0, warnAt = 0;

function stats(arr) {
  if (!arr.length) return { avg: 50, p95: 50, worst: 50, tps: 20 };
  const s = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { avg, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
           worst: s[s.length - 1], tps: Math.min(20, 1000 / avg) };
}
function ents(id) {
  try { return [...world.getDimension(id).getEntities()].length; } catch { return -1; }
}

/** مخرَج موحّد: لاعب → شات │ بوت/كونسول → لوق + تقرير للبوت */
function reporter(p) {
  if (p?.typeId === "minecraft:player") return (t) => { try { p.sendMessage(t); } catch {} };
  return (t) => {
    const plain = String(t).replace(/§./g, "");
    console.warn("[UHC] " + plain);
    try { Bridge.queueReport("info", plain); } catch {}
    try { world.sendMessage(t); } catch {}
  };
}

system.runInterval(() => {
  const now = Date.now(), dt = now - last; last = now;
  if (dt <= 0 || dt > 5000) return;
  win.push(dt); if (win.length > WIN) win.shift();
  if (acc) { acc.n++; acc.sum += dt; if (dt > acc.worst) acc.worst = dt; }

  if (logEvery > 0 && now - logAt >= logEvery) {
    logAt = now;
    const q = stats(win);
    console.warn(`[UHC] PERF tps=${q.tps.toFixed(1)} avg=${q.avg.toFixed(1)}`
      + ` p95=${q.p95} worst=${q.worst} pl=${world.getPlayers().length}`
      + ` ow=${ents("minecraft:overworld")} ne=${ents("minecraft:nether")}`);
  } else if (win.length >= WIN && now - warnAt > 60000) {
    const q = stats(win);
    if (q.tps < 18) {
      warnAt = now;
      console.warn(`[UHC] ⚠ لاق: tps=${q.tps.toFixed(1)} avg=${q.avg.toFixed(1)}ms`
        + ` p95=${q.p95} worst=${q.worst} pl=${world.getPlayers().length}`
        + ` ow=${ents("minecraft:overworld")} ne=${ents("minecraft:nether")}`);
    }
  }
}, 1);

const KNOBS = [
  { k: "wall",  l: "جدار الجزيئات",   p: "wallEnabled" },
  { k: "hud",   l: "الشريط + العربي", p: "hudEnabled" },
  { k: "snd",   l: "أصوات البوردر",   p: "soundNearBorderEnabled" },
  { k: "grave", l: "مسح القبور",      p: "graveSweepEnabled" },
];
let busy = false;

async function bench(say, secs) {
  if (busy) { say("§eقياس شغال هسه"); return; }
  busy = true;
  const ticks = Math.max(100, Math.floor(secs * 20));
  const saved = {};
  for (const q of KNOBS) saved[q.p] = CONFIG[q.p];
  const rows = [];
  const measure = async (label) => {
    acc = { n: 0, sum: 0, worst: 0 };
    await system.waitTicks(ticks);
    const a = acc; acc = null;
    const avg = a.n ? a.sum / a.n : 50;
    rows.push({ label, avg, worst: a.worst, tps: Math.min(20, 1000 / avg) });
  };
  try {
    const total = secs * (KNOBS.length + 1) + KNOBS.length;
    say(`§eبدأ القياس §8(${Math.ceil(total / 60)} دقيقة)§e — خلّي اللعب طبيعي`);
    console.warn(`[UHC] PERF bench بدأ: ${secs}ث لكل مرحلة`);
    await measure("الأساس (كل شي شغال)");
    for (const q of KNOBS) {
      CONFIG[q.p] = false;
      await measure("بلا " + q.l);
      CONFIG[q.p] = saved[q.p];
      await system.waitTicks(20);
    }
  } catch (e) { console.warn("[UHC] bench: " + (e?.message ?? e)); }
  finally { for (const q of KNOBS) CONFIG[q.p] = saved[q.p]; busy = false; }

  const base = rows[0];
  const rest = rows.slice(1).map(r => ({ ...r, gain: r.tps - base.tps }))
                   .sort((a, b) => b.gain - a.gain);
  const lines = [`§6نتيجة القياس §8| §fالأساس: §a${base.tps.toFixed(1)} TPS `
    + `§7(${base.avg.toFixed(1)}ms، أسوأ ${base.worst}ms)`];
  for (const r of rest) {
    const c = r.gain >= 1 ? "§c" : r.gain >= 0.4 ? "§e" : "§7";
    lines.push(`${c}${r.label}: §f${r.tps.toFixed(1)} TPS §8| ${c}فرق `
      + `${r.gain >= 0 ? "+" : ""}${r.gain.toFixed(2)}`);
  }
  const top = rest[0];
  lines.push(top && top.gain >= 0.4
    ? `§aالمتهم الأول: §f${top.label} §7(+${top.gain.toFixed(2)} TPS لمن نطفيه)`
    : "§aماكو مفتاح مؤثر — اللاق مو من هذي الوحدات");
  say(lines.join("\n"));
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  try {
    const id = ev.id;
    if (id !== "uhc:tps" && id !== "uhc:tpslog" && id !== "uhc:bench" && id !== "uhc:perf") return;
    const p = ev.sourceEntity;
    const say = reporter(p);                    // ← يشتغل حتى بلا لاعب مصدر
    const arg = String(ev.message ?? "").trim().toLowerCase();

    if (id === "uhc:tps") {
      const q = stats(win);
      const c = q.tps >= 19 ? "§a" : q.tps >= 17 ? "§e" : "§c";
      say(`${c}TPS ${q.tps.toFixed(1)} §8| §7التكة §f${q.avg.toFixed(1)}ms`
        + ` §8| §7p95 §f${q.p95}ms §8| §7أسوأ §f${q.worst}ms`
        + ` §8| §7لاعبين §f${world.getPlayers().length}`
        + ` §8| §7كيانات §f${ents("minecraft:overworld")}§7/§f${ents("minecraft:nether")}`);
      return;
    }
    if (id === "uhc:tpslog") {
      logEvery = (arg === "off" || arg === "0") ? 0 : (Number(arg) || 5) * 1000;
      say(logEvery ? `§aتسجيل TPS كل ${logEvery / 1000}ث → اللوق` : "§7وقف التسجيل");
      return;
    }
    if (id === "uhc:bench") { bench(say, Number(arg) || 20); return; }
    if (id === "uhc:perf") {
      const [k, v] = arg.split(/\s+/);
      const q = KNOBS.find(x => x.k === k);
      if (!q) { say("§7المفاتيح: §f" + KNOBS.map(x => x.k).join(", ")); return; }
      CONFIG[q.p] = !(v === "off" || v === "0" || v === "false");
      say(`§e${q.l}: ${CONFIG[q.p] ? "§aشغال" : "§cمطفي"}`);
      return;
    }
  } catch (e) { console.warn("[UHC] perf cmd: " + (e?.message ?? e)); }
});

console.warn("[UHC] perf.js جاهز (uhc:tps │ uhc:tpslog │ uhc:bench │ uhc:perf)");
