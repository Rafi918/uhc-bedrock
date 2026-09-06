// UHC - جدول تحرك البوردر (مستقل)
import { system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { Border } from "./border.js";
import { Bridge } from "./bridge.js";
import { titleAll, msgAll, msgTo, soundAll, formatMs, isOpSafe } from "./util.js";

const warned = new Set();

export function steps() {
  const s = State.data;
  if (!Array.isArray(s.shrinkPlan)) s.shrinkPlan = [];
  return s.shrinkPlan;
}

export function amtOf(x, cur) {
  if (Number.isFinite(x.amount) && x.amount > 0) return Math.floor(x.amount);
  if (Number.isFinite(x.toHalf))
    return Math.max(0, cur - Math.max(CONFIG.minBorderHalf, Math.floor(x.toHalf)));
  return 0;
}

function prog() {
  const s = State.data;
  if (!s.plan || s.plan.gameId !== s.gameId) {
    s.plan = { gameId: s.gameId, idx: -1, startAt: 0, resting: true, done: false };
    warned.clear();
  }
  return s.plan;
}

export function resetProg() {
  const s = State.data;
  s.plan = { gameId: s.gameId, idx: -1, startAt: 0, resting: true, done: false };
  warned.clear();
  State.save();
}

function tick() {
  const s = State.data;
  if (s.phase !== "PLAYING") return;
  if (Date.now() < (s.scatterUntil ?? 0)) return;
  const PL = steps();
  if (!PL.length) return;
  const p = prog(), b = s.border, now = Date.now();
  if (p.done) return;
  if (p.idx < 0) { p.idx = 0; p.startAt = now; p.resting = true; State.save(); }
  const x = PL[p.idx];
  if (!x) { p.done = true; State.save(); return; }

  if (p.resting) {
    const rm = Math.max(0, Math.floor(Number(x.rest ?? 0) * 60000));
    const left = p.startAt + rm - now;
    const cur = Math.floor(b.currentHalf);
    const a = amtOf(x, cur);
    if (left > 0) {
      const sec = Math.ceil(left / 1000);
      for (const mk of [60, 30, 10, 5]) {
        if (sec > mk || sec <= mk - 1) continue;
        const k = `${p.idx}:${mk}`;
        if (warned.has(k)) continue;
        warned.add(k);
        if (a > 0) msgAll(`§eالبوردر يصير §f${Math.max(CONFIG.minBorderHalf, cur - a)} §7بعد §f${mk} §7ثانية`);
        soundAll(CONFIG.soundCountdown, 0.7, 1);
      }
      return;
    }
    p.resting = false; p.startAt = now;
    const mn = Math.max(0, Number(x.minutes ?? 0));
    if (a <= 0 || mn <= 0) { p.idx++; p.resting = true; State.save(); return; }
    const r = Border.startShrink({ amount: a, durationMs: Math.floor(mn * 60000), silent: true });
    State.save();
    if (r.ok) {
      titleAll(`§c§lمرحلة ${p.idx + 1} من ${PL.length}`,
        `§7البوردر يصير §f${r.target} §7خلال §f${formatMs(r.durationMs)}`);
      soundAll(CONFIG.soundShrinkStart, 1, 0.8);
      msgAll(`§c§lمرحلة ${p.idx + 1} §8| §7البوردر §f${cur} §8> §c${r.target} §7خلال §f${formatMs(r.durationMs)}`);
      try { Bridge.queueReport("game", `مرحلة ${p.idx + 1}/${PL.length}: ${cur} الى ${r.target} خلال ${formatMs(r.durationMs)}`); } catch {}
    } else { p.idx++; p.resting = true; State.save(); }
    return;
  }

  if (b.shrinking) return;
    if ((b.pausedRemainingMs ?? 0) > 0) return;
  p.idx++; p.startAt = now; p.resting = true;
  if (p.idx >= PL.length) {
    p.done = true; State.save();
    titleAll("§4§lاخر مرحلة", `§7البوردر ثبت على §f${Math.floor(b.currentHalf)}`);
    msgAll(`§4§lاخر حجم للبوردر §f${Math.floor(b.currentHalf)}`);
    return;
  }
  State.save();
  const rr = Math.max(0, Number(PL[p.idx].rest ?? 0) * 60000);
  if (rr > 0) msgAll(`§aالبوردر ثابت §f${Math.floor(b.currentHalf)} §8| §7المرحلة الجاية بعد §f${formatMs(rr)}`);
}

function handle(ev) {
  const id = ev.id;
  if (id !== "uhc:plan" && id !== "uhc:ring") return;
  const who = ev.sourceEntity;
  const isP = who?.typeId === "minecraft:player";
  const op = (!who && !ev.sourceBlock) || (isP && isOpSafe(who));
  const out = [];
  const say = (t) => {
    if (isP) msgTo(who, t);
    else out.push(String(t).replace(/§./g, ""));
  };
  const done = () => {
    if (out.length) { try { Bridge.queueReport("cmd", out.join("\n")); } catch {} }
  };

  const arg = String(ev.message ?? "").trim();
  const parts = arg.split(/\s+/).filter(Boolean);
  const s = State.data, b = s.border;
  const base = () => Math.floor((s.phase === "LOBBY" || s.phase === "ENDED") ? b.startHalf : b.currentHalf);

  if (!op) { say("§cللاوبريتر بس"); done(); return; }

  if (id === "uhc:ring") {
    const lo = Number(parts[0]), hi = Number(parts[1]);
    if (!Number.isFinite(lo) || lo < 0.2 || lo > 0.98) {
      say("§cمثال: §euhc:ring 0.9");
      say("§7او مدى: §euhc:ring 0.85 0.95");
    } else {
      const h = Number.isFinite(hi) ? Math.min(0.98, Math.max(lo, hi)) : lo;
      b.ringMin = lo; b.ringMax = h;
      CONFIG.scatterMinFactor = lo; CONFIG.scatterMaxFactor = h;
      State.save();
      const S = base();
      say(`§aالتوزيع §f${Math.round(S * lo)}§a-§f${Math.round(S * h)}§a من المركز`);
    }
    done(); return;
  }

  const PL = steps();
  const a0 = (parts[0] ?? "show").toLowerCase();

  if (a0 === "add") {
    const mn = Number(parts[1]), am = Number(parts[2]), rs = Number(parts[3] ?? 0);
    if (!Number.isFinite(mn) || mn <= 0 || !Number.isFinite(am) || am <= 0) {
      say("§cمثال: §euhc:plan add 60 1000");
      say("§7= خلال 60 دقيقة ينكمش 1000 بلوك");
      say("§7مع استراحة: §euhc:plan add 60 1000 15");
    } else {
      PL.push({ rest: Math.max(0, Math.floor(rs)), minutes: Math.floor(mn), amount: Math.floor(am) });
      State.save();
      say(`§aمرحلة ${PL.length}: خلال §f${Math.floor(mn)}§a دقيقة ينكمش §f${Math.floor(am)}§a بلوك`
        + (rs > 0 ? ` §7(استراحة ${Math.floor(rs)}د قبلها)` : ""));
    }
    done(); return;
  }
  if (a0 === "rest") {
    const v = Number(parts[1]);
    if (!Number.isFinite(v) || v <= 0) say("§cمثال: §euhc:plan rest 15");
    else {
      PL.push({ rest: Math.floor(v), minutes: 0, amount: 0 });
      State.save();
      say(`§aاستراحة §f${Math.floor(v)}§a دقيقة (خطوة ${PL.length})`);
    }
    done(); return;
  }
  if (a0 === "del") {
    const i = Math.floor(Number(parts[1])) - 1;
    if (!(i >= 0 && i < PL.length)) say(`§cرقم من 1 الى ${PL.length}`);
    else { PL.splice(i, 1); State.save(); say(`§aانشالت الخطوة ${i + 1}`); }
    done(); return;
  }
  if (a0 === "clear") {
    s.shrinkPlan = []; resetProg();
    say("§aالجدول انفرغ — البوردر ما يتحرك تلقائي");
    done(); return;
  }
  if (a0 === "restart") {
    resetProg(); say("§aالجدول يبدأ من المرحلة 1");
    done(); return;
  }
  if (a0 === "auto") {
    const tot = Number(parts[1]), end = Number(parts[2] ?? 100);
    const S = base();
    if (!Number.isFinite(tot) || tot < 8 || !Number.isFinite(end)) {
      say("§cمثال: §euhc:plan auto 120 100");
      say(`§7= يوصل 100 خلال 120 دقيقة (من §f${S}§7)`);
    } else {
      const E = Math.max(CONFIG.minBorderHalf, Math.floor(end));
      if (E >= S) say(`§cالنهاية لازم اصغر من §f${S}`);
      else {
        const cuts = [0.45, 0.72, 0.9, 1];
        const per = tot / cuts.length;
        s.shrinkPlan = cuts.map(c => ({
          rest: Math.max(1, Math.round(per * 0.25)),
          minutes: Math.max(1, Math.round(per * 0.75)),
          toHalf: Math.max(E, Math.round(S - (S - E) * c)),
        }));
        resetProg();
        say(`§aانبنى ${s.shrinkPlan.length} مراحل §8| §f${S} §8الى §f${E} §7خلال §f${Math.round(tot)}§7 دقيقة`);
        say("§7شوفه: §euhc:plan");
      }
    }
    done(); return;
  }

  const S = base();
  say(`§6§lجدول البوردر §8(${PL.length} خطوة) §7من §f${S}`);
  if (!PL.length) {
    say("§7فاضي — البوردر ما يتحرك");
    say("§7تلقائي: §euhc:plan auto 120 100");
    say("§7بيدك: §euhc:plan add 60 1000");
  } else {
    const p = State.data.plan ?? { idx: -1 };
    let cur = S, tot = 0;
    PL.forEach((x, i) => {
      const rs = Math.max(0, Number(x.rest ?? 0));
      const mn = Math.max(0, Number(x.minutes ?? 0));
      const a = amtOf(x, cur);
      const to = Math.max(CONFIG.minBorderHalf, cur - a);
      tot += rs + mn;
      const mk = i === p.idx ? (p.resting ? "§e>" : "§c>") : (i < p.idx ? "§a+" : "§8-");
      if (a <= 0 || mn <= 0) say(`${mk} §7${i + 1}) استراحة §f${rs}§7 دقيقة`);
      else say(`${mk} §7${i + 1}) ${rs > 0 ? `استراحة §f${rs}§7د §8| ` : ""}§f${mn}§7د ينكمش §f${a} §8الى §e${to}`);
      cur = to;
    });
    const lo = b.ringMin ?? CONFIG.scatterMinFactor ?? 0.85;
    const hi = b.ringMax ?? CONFIG.scatterMaxFactor ?? 0.95;
    say(`§7الوقت الكلي §f${formatMs(tot * 60000)} §8| §7النهاية §f${cur}`);
    say(`§7التوزيع §f${Math.round(S * lo)}§7-§f${Math.round(S * hi)}§7 من المركز`);
    if (p.done) say("§aالجدول خلص");
  }
  done();
}

system.run(() => {
  try { system.afterEvents.scriptEventReceive.subscribe((ev) => { try { handle(ev); } catch (e) { console.warn("[UHC plan]", e); } }); } catch (e) { console.warn("[UHC plan] sub:", e); }
  system.runInterval(() => { try { tick(); } catch (e) { console.warn("[UHC plan] tick:", e); } }, 20);
  console.warn("[UHC] plan.js جاهز");
});
