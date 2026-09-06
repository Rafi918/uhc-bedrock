import { netherLeftMs, netherLeftText } from "./extras.js";
// ============================================================================
//  UHC Core - البوردر الديناميكي
//  🔧 الجديد: يهدى خلال التوزيع │ السايدبار ما يفشي مواقع اللاعبين ويتنظف كامل
//     │ وضع title يحترم قفل التايتل │ سرعة الانكماش تظهر صح
// ============================================================================
import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { isRespawnActive, respawnTimeLeft, Respawn } from "./respawn.js";
import {
  titleAll, soundAll, soundOnce, actionBar, formatMs,
  dimScale, isSpectatorLike, clamp, CAUSE_MAGIC, titleLocked,
} from "./util.js";

export function shrinkInfo() {
  const b = State.data.border;
  if (!b.shrinking || b.shrinkDurationMs <= 0) {
    return {
      active: false, remainingMs: 0, remainingBlocks: 0,
      speedPerSec: 0, target: Math.floor(b.shrinkTargetHalf),
    };
  }
  const elapsed = clamp(Date.now() - b.shrinkStartAt, 0, b.shrinkDurationMs);
  const remainingMs = b.shrinkDurationMs - elapsed;
  const totalBlocks = Math.max(0, b.shrinkFromHalf - b.shrinkTargetHalf);
  return {
    active: true,
    remainingMs,
    remainingBlocks: Math.ceil(Math.max(0, b.currentHalf - b.shrinkTargetHalf)),
    speedPerSec: Math.round((totalBlocks / (b.shrinkDurationMs / 1000)) * 10) / 10,
    target: Math.floor(b.shrinkTargetHalf),
  };
}




/** كل شي ببلوكات البُعد المحلي │ ex,ez = اتجاه الأمان */

/** ↑ امشِ قدام │ → لفّ يمين │ ↘ ورا-يمين … */

/* ===== سهم البوردر: دقيق ونسبي لاتجاه نظر اللاعب ===== */
const ARROWS_DEF = ["↑","↗","→","↘","↓","↙","←","↖"];

function tierFor(d) {
  for (const q of (CONFIG.borderTiers ?? [])) if (d <= q.at) return q;
  return { c: "§b", w: "آمن" };
}

/** كل شي ببلوكات البُعد المحلي │ ex,ez = اتجاه الأمان */
function edgeReport(b, loc, sc) {
  const s = sc || 1;
  const half = b.currentHalf / s, cx = b.centerX / s, cz = b.centerZ / s;
  const dx = loc.x - cx, dz = loc.z - cz;
  const distX = half - Math.abs(dx), distZ = half - Math.abs(dz);
  const corner = CONFIG.borderCornerBlocks ?? 100;
  let ex = 0, ez = 0;
  if (distX <= distZ + corner) ex = dx > 0 ? -1 : (dx < 0 ? 1 : 0);
  if (distZ <= distX + corner) ez = dz > 0 ? -1 : (dz < 0 ? 1 : 0);
  if (ex === 0 && ez === 0) ez = -1;
  const raw = Math.min(distX, distZ);
  return { raw, d: Math.max(0, Math.ceil(raw)), ex, ez, tier: tierFor(raw) };
}

/** ↑ قدام │ → يمين │ ↘ ورا-يمين … */
function arrowFor(player, r) {
  const A = CONFIG.borderArrows ?? ARROWS_DEF;
  let v = { x: 0, z: 1 };
  try { const q = player.getViewDirection(); if (q) v = { x: q.x, z: q.z }; } catch {}
  const vl = Math.hypot(v.x, v.z);
  if (vl < 1e-6) return A[0] ?? "↑";
  const fx = v.x / vl, fz = v.z / vl, rx = -fz, rz = fx;
  const el = Math.hypot(r.ex, r.ez) || 1;
  const tx = r.ex / el, tz = r.ez / el;
  const ang = Math.atan2(tx * rx + tz * rz, tx * fx + tz * fz) * 180 / Math.PI;
  let k = Math.round(ang / 45); if (k < 0) k += 8;
  return A[k % 8] ?? A[0] ?? "↑";
}
function outArrow(player, b, sc) { return arrowFor(player, edgeReport(b, player.location, sc)); }

export const Border = {
  // ---------------------------------------------------------------- انكماش
  startShrink(opts = {}) {
    const b = State.data.border;
    const amount = Math.max(0, Math.floor(opts.amount ?? b.cfgShrinkAmount ?? b.shrinkAmount));
    const durationMs = Math.max(1000, Math.floor(opts.durationMs ?? b.cfgShrinkDurationMs ?? b.shrinkDurationMs));

    if (amount <= 0) return { ok: false, reason: "no_amount" };
    if (b.currentHalf <= CONFIG.minBorderHalf) return { ok: false, reason: "at_minimum" };

    b.shrinkFromHalf = b.currentHalf;
    b.shrinkTargetHalf = Math.max(CONFIG.minBorderHalf, b.currentHalf - amount);
    b.shrinkAmount = amount;
    b.shrinkDurationMs = durationMs;
    b.shrinkStartAt = Date.now();
    b.pausedRemainingMs = 0;
    b.shrinking = true;
    State.save();

    if (!opts.silent) {
      titleAll("§c§l⚠ البوردر بدأ ينكمش!",
        `§7-${amount} بلوك خلال ${formatMs(durationMs)} → ±${Math.floor(b.shrinkTargetHalf)}`);
      soundAll(CONFIG.soundShrinkStart, 1.0, 0.8);
    }
    return { ok: true, amount, durationMs, target: Math.floor(b.shrinkTargetHalf) };
  },

  pauseShrink() {
    const b = State.data.border;
    if (!b.shrinking) return false;
    b.pausedRemainingMs = Math.max(0, b.shrinkStartAt + b.shrinkDurationMs - Date.now());
    b.shrinking = false;
    State.save();
    return true;
  },

  resumeShrink() {
    const b = State.data.border;
    if (b.shrinking) return false;
    if (b.shrinkTargetHalf >= b.currentHalf - 0.01) return false;

    if (b.pausedRemainingMs <= 0) {
      b.currentHalf = Math.max(CONFIG.minBorderHalf, b.shrinkTargetHalf);
      State.save();
      return true;
    }
    b.shrinkFromHalf = b.currentHalf;
    b.shrinkDurationMs = b.pausedRemainingMs;
    b.shrinkStartAt = Date.now();
    b.pausedRemainingMs = 0;
    b.shrinking = true;
    State.save();
    return true;
  },

  finishShrink() {
    const b = State.data.border;
    b.shrinking = false;
    b.pausedRemainingMs = 0;
    b.currentHalf = Math.max(CONFIG.minBorderHalf, b.shrinkTargetHalf);
    b.shrinkAmount = b.cfgShrinkAmount;
    b.shrinkDurationMs = b.cfgShrinkDurationMs;
    State.save();
    titleAll("§a§lالبوردر ثبت", `§7الحجم §f${Math.floor(b.currentHalf)}`);
    soundAll(CONFIG.soundShrinkEnd, 1.0, 1.2);
  },

  // يرجع { value, cancelled } — cancelled = ألغينا انكماش جاري
  setSize(half, { alsoStart = true } = {}) {
    const b = State.data.border;
    const cancelled = b.shrinking;
    const v = clamp(Math.floor(half), CONFIG.minBorderHalf, 30000000);
    b.currentHalf = v;
    b.shrinkFromHalf = v;
    b.shrinkTargetHalf = v;
    b.shrinking = false;
    b.pausedRemainingMs = 0;
    if (alsoStart) b.startHalf = v;
    State.save();
    return { value: v, cancelled };
  },

  // ---------------------------------------------------------------- مسافات
  signedDistanceOut(player) {
    const b = State.data.border;
    const s = dimScale(player.dimension.id);
    const dx = Math.abs(player.location.x * s - b.centerX);
    const dz = Math.abs(player.location.z * s - b.centerZ);
    return Math.max(dx, dz) - b.currentHalf;
  },

  isOutside(player) { return this.signedDistanceOut(player) > 0; },

  // ---------------------------------------------------------------- الدورة
  tick() {
    const s = State.data;
    if (s.phase === "LOBBY" || s.phase === "ENDED") { this.clearSidebar(); return; }
    // 🔧 خلال التوزيع: ماكو ضرر ولا HUD ولا جزيئات (اللاعبين طايرين بالسمى)
    if (Date.now() < (s.scatterUntil ?? 0)) return;

    const b = s.border;
    const now = Date.now();

    if (b.shrinking && b.shrinkDurationMs > 0) {
      const t = clamp((now - b.shrinkStartAt) / b.shrinkDurationMs, 0, 1);
      const span = b.shrinkFromHalf - b.shrinkTargetHalf;
      b.currentHalf = Math.max(CONFIG.minBorderHalf, b.shrinkFromHalf - span * t);
      if (t >= 1) this.finishShrink();
      else State.markDirty();
    }

    const info = shrinkInfo();
    const graceActive = s.phase === "GRACE" && now < s.grace.endAt;
    const damage = b.damage ?? CONFIG.damageOutsideBorder;
    const mode = s.hud?.mode ?? "actionbar";

    // 🔧 سماح الخروج — أول فترة من المباراة الضرر ما يبدي فوراً
    const lenient = s.gameStartAt === 0 ||
      (now - s.gameStartAt) < (CONFIG.borderGraceLenientMinutes ?? 90) * 60000;
    const allowMs = lenient ? Math.max(0, (CONFIG.borderGraceSeconds ?? 0) * 1000) : 0;
    const rearmMs = Math.max(0, (CONFIG.borderGraceRearmSeconds ?? 30) * 1000);
    const seen = new Set();

    for (const p of world.getPlayers()) {
      let dist;
      try { dist = this.signedDistanceOut(p); } catch { continue; }

      const passive = isSpectatorLike(p) || State.isEliminated(p.name);

      seen.add(p.name);

      if (!passive && !graceActive && dist > 0) {
        const nm = p.name;
        const sc = dimScale(p.dimension.id) || 1;
        const away = Math.ceil(dist / sc);          // بلوكات البُعد المحلي مو وحدات أوفروورلد
        let rec = this._outSince.get(nm);
        if (!rec) { rec = { t0: now, back: 0 }; this._outSince.set(nm, rec); }
        else if (rec.back) rec.back = 0;            // رجع وطلع قبل ما يكمل مدة إعادة التسليح
        const left = (allowMs > 0 && rec.t0) ? (rec.t0 + allowMs - now) : 0;

        if (left > 0) {
          actionBar(p, `§e§l⚠ بره البوردر §8| §fالضرر يبدي بعد §c${Math.ceil(left / 1000)}§f ثانية `
                     + `§8| §7بعيد §f${away} §7بلوك`);
          soundOnce(p, CONFIG.soundNearBorder, 20, 0.8, 1.6);
        } else {
          try { p.applyDamage(damage, { cause: CAUSE_MAGIC }); } catch {}
          actionBar(p, `§c§lبره البوردر §8| §cارجع §8| §7يبعد عنك §f${away} §a${outArrow(p, b, sc)}`);
          soundOnce(p, CONFIG.soundOutside, CONFIG.soundOutsideTicks, 1.0, 0.6);
        }
      } else {
        const rec = this._outSince.get(p.name);
        if (rec) {
          if (passive) this._outSince.delete(p.name);
          else if (!rec.back) rec.back = now;                       // أول تكة جوّه
          else if (now - rec.back >= rearmMs) this._outSince.delete(p.name);   // رجّعنا السماح
          else rec.t0 = 0;                                         // السماح مستهلك
        }
        // 🔧 الأكشن بار يشتغل دايماً — حتى بوضع scoreboard (المسافة شخصية)
        if (CONFIG.hudEnabled !== false && State.data.hud?.off !== true) {
          this.renderHud(p, this.hudText(p, dist, info, graceActive, passive), mode);
        }
        if (!passive && CONFIG.soundNearBorderEnabled && dist > -CONFIG.borderWarningDistance && dist <= 0) {
          const closeness = clamp(1 - (-dist / CONFIG.borderWarningDistance), 0, 1);
          const pitch = 0.8 + closeness * 0.8;
          const interval = Math.max(20, Math.floor(CONFIG.soundNearBorderTicks * (1 - closeness * 0.6)));
          soundOnce(p, CONFIG.soundNearBorder, interval, 0.7, pitch);
        }
      }

      if (CONFIG.wallEnabled) {
        try { this.drawBorderNear(p); } catch {}
      }
    }

    if (this._outSince.size)
      for (const k of this._outSince.keys()) if (!seen.has(k)) this._outSince.delete(k);

    if (mode === "scoreboard") { try { this.sidebarTick(info, graceActive); } catch {} }
    else this.clearSidebar();
  },

  hudText(player, dist, info, graceActive, passive) {
    const s = State.data, b = s.border;
    const sc = dimScale(player.dimension.id) || 1;
    const alive = Respawn.aliveCount();
    if (passive) return `§cخرجت من اللعبة §8| §7عايشين §a${alive}`;

    const r = edgeReport(b, player.location, sc), T = r.tier;
    let t = `${T.c}${T.w} §8| ${T.c}يبعد عنك §f${r.d} §a${arrowFor(player, r)}`;
    if (sc !== 1) {
      let _nl = 0;
      try { _nl = netherLeftMs(); } catch {}
      t += _nl > 0 ? ` §8| §cالنذر ينسد §f${netherLeftText(_nl)}` : " §8(نذر)";
    }
    if (graceActive) t += ` §8| §aسماح ${formatMs(s.grace.endAt - Date.now())}`;
    t += isRespawnActive() ? ` §8| §aترجع ${respawnTimeLeft()}` : " §8| §cموت نهائي";
    t += ` §8| §aعايشين ${alive}`;
    return t;
  },



  // ------------------------------------------------- عرض
  renderHud(player, text, mode) {
    if (mode === "title") {
      if (titleLocked(player)) return;          // 🔧 ما نمسح التايتلات المهمة
      try {
        player.onScreenDisplay.setTitle(" ", {
          subtitle: text, fadeInDuration: 0, stayDuration: 25, fadeOutDuration: 0,
        });
      } catch {}
      return;
    }
    actionBar(player, text);
  },

  _outSince: new Map(),
  _sbShown: false,
  _sbLines: [],

  clearSidebar() {
    // 🔧 ما نعتمد على _sbShown (يصفّر بالريستارت والسايدبار يبقى معلق)
    if (this._sbShown === false && this._sbLines.length === 0) {
      try {
        if (!world.scoreboard.getObjective(CONFIG.scoreboardObjective)) return;
      } catch { return; }
    }
    this._sbShown = false;
    this._sbLines = [];
    try { world.scoreboard.clearObjectiveAtDisplaySlot("Sidebar"); } catch {}
    try { world.scoreboard.removeObjective(CONFIG.scoreboardObjective); } catch {}
  },

  // ⚠️ السكوربورد عام للكل → معلومات مشتركة بس، ماكو مواقع لاعبين
  sidebarTick(info, grace) {
    const sb = world.scoreboard, id = CONFIG.scoreboardObjective;
    let obj;
    try { obj = sb.getObjective(id); } catch {}
    if (!obj) { try { obj = sb.addObjective(id, "§6UHC"); } catch { return; } }
    if (!this._sbShown) {
      try { sb.setObjectiveAtDisplaySlot("Sidebar", { objective: obj }); } catch {}
      this._sbShown = true;
    }
    const s = State.data, b = s.border;
    const L = [`§eالبوردر §f${Math.floor(b.currentHalf)}`];
    const moved = Math.max(0, Math.floor((b.startHalf ?? b.currentHalf) - b.currentHalf));
    if (moved > 0) L.push(`§7تحرك §f${moved}`);
    if (info.active) {
      L.push(`§c${info.speedPerSec} §7بالثانية`);
      L.push(`§7الهدف §f${info.target}`);
    } else if (grace) L.push(`§aسماح §f${formatMs(s.grace.endAt - Date.now())}`);
    L.push(isRespawnActive() ? `§aترجع §f${respawnTimeLeft()}` : "§cموت نهائي");
    L.push(`§aعايشين §f${Respawn.aliveCount()}`);

    const cl = L.map(x => x.slice(0, 40));
    if (cl.length === this._sbLines.length && cl.every((x, i) => x === this._sbLines[i])) return;
    const want = new Set(cl);
    try {
      for (const q of obj.getScores())
        if (!want.has(q.participant?.displayName ?? ""))
          { try { obj.removeParticipant(q.participant); } catch {} }
    } catch {}
    let n = cl.length;
    for (const x of cl) { try { obj.setScore(x, n--); } catch {} }
    this._sbLines = cl;
  },


  // ------------------------------------------------------- السور المرئي
  drawBorderNear(player) {
    const b = State.data.border;
    const dim = player.dimension;
    const did = dim.id;
    if (did !== "minecraft:overworld" && did !== "minecraft:nether") return;  // الإند ماكو بوردر
    const sc = dimScale(did) || 1;

    // كل شي بإحداثيات البُعد المحلي — النذر 1:8
    const cx = b.centerX / sc, cz = b.centerZ / sc, half = b.currentHalf / sc;
    const viewD = sc === 1 ? CONFIG.wallViewDistance : (CONFIG.netherWallViewDistance ?? 48);
    const nearD = sc === 1 ? CONFIG.wallNearDistance : (CONFIG.netherWallNearDistance ?? 20);
    const particle = sc === 1
      ? CONFIG.borderParticle
      : (CONFIG.borderParticleNether ?? "minecraft:endrod");

    const loc = player.location;
    const px = Math.floor(loc.x), py = Math.floor(loc.y), pz = Math.floor(loc.z);

    let yMin = -64, yMax = 320;
    try { yMin = dim.heightRange.min + 1; yMax = dim.heightRange.max - 1; } catch {}

    const edges = [
      { fixed: cx + half, axis: "x" },
      { fixed: cx - half, axis: "x" },
      { fixed: cz + half, axis: "z" },
      { fixed: cz - half, axis: "z" },
    ];
    let best = edges[0], bestDist = Infinity;
    for (const e of edges) {
      const d = e.axis === "x" ? Math.abs(loc.x - e.fixed) : Math.abs(loc.z - e.fixed);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    if (bestDist > viewD) return;

    let view = { x: 0, y: 0, z: 0 };
    try { view = player.getViewDirection(); } catch {}
    const along = best.axis === "x" ? view.z : view.x;
    const center = (best.axis === "x" ? pz : px) + Math.round(along * 12);
    const fixed = Math.floor(best.fixed);

    let budget = CONFIG.particleBudgetPerPlayer;
    const emit = (pos) => {
      if (budget-- <= 0) return false;
      if (pos.y < yMin || pos.y > yMax) return true;   // سقف البدروك مال النذر
      try { dim.spawnParticle(particle, pos); } catch {}
      return true;
    };

    if (bestDist <= nearD) {
      for (let y = py - CONFIG.wallBelow; y <= py + CONFIG.wallAbove; y += CONFIG.wallStepY) {
        for (let o = -CONFIG.wallHalfWidth; o <= CONFIG.wallHalfWidth; o += CONFIG.wallStepX) {
          const c = center + o;
          if (!emit(best.axis === "x" ? { x: fixed, y, z: c } : { x: c, y, z: fixed })) return;
        }
      }
    } else {
      const span = CONFIG.wallHalfWidth * 2;
      for (let o = -span; o <= span; o += CONFIG.wallPillarSpacing) {
        const c = center + o;
        for (let y = py - 2; y <= py + CONFIG.wallPillarHeight; y += CONFIG.wallPillarStep) {
          if (!emit(best.axis === "x" ? { x: fixed, y, z: c } : { x: c, y, z: fixed })) return;
        }
      }
    }
  },


  statusText() {
    const b = State.data.border;
    const info = shrinkInfo();
    let t = `البوردر: ±${Math.floor(b.currentHalf)} عند (${b.centerX}, ${b.centerZ})`;
    if (info.active) {
      t += ` | ينكمش ${info.speedPerSec} بلوك/ث → ±${info.target} خلال ${formatMs(info.remainingMs)}`;
    }
    return t;
  },
};
