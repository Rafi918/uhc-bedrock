// ============================================================================
//  UHC Core - جسر البوت
//  🔧 الجديد: بصمة جلسة + ack محفوظ بالعالم
//     (قبل: ريستارت البوت = أوامر ما توصل │ ريستارت السيرفر = تنفيذ أمر قديم)
// ============================================================================
import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { State } from "./state.js";
import { healthOf } from "./util.js";

const P_ACK = "uhc:bridgeAck";

let netPost = null;
let netStatus = "unloaded";       // unloaded | ready | unavailable
let polling = false;
let flushing = false;
let failures = 0;
let skipTicks = 0;
let lastAppliedId = 0;
let botSession = null;
let pendingReports = [];

function loadAck() {
  try {
    const raw = world.getDynamicProperty(P_ACK);
    if (typeof raw === "string" && raw) {
      const o = JSON.parse(raw);
      botSession = o.session ?? null;
      lastAppliedId = Number(o.id) || 0;
      console.warn(`[UHC] ack محفوظ: session=${botSession} id=${lastAppliedId}`);
    }
  } catch {}
}

function saveAck() {
  try { world.setDynamicProperty(P_ACK, JSON.stringify({ session: botSession, id: lastAppliedId })); }
  catch {}
}

async function ensureNet() {
  if (netStatus === "ready") return true;
  if (netStatus === "unavailable") return false;
  try {
    const mod = await import("./net.js");
    netPost = mod.post;
    netStatus = "ready";
    console.warn("[UHC] bridge: server-net جاهز.");
    return true;
  } catch (e) {
    netStatus = "unavailable";
    console.warn("[UHC] الجسر مطفي (server-net غير متاح):", e?.message ?? e);
    console.warn("[UHC] لازم Beta APIs مفعّلة + permissions.json. اللعبة تكمل بـ /scriptevent uhc:help");
    return false;
  }
}

function request(path, body) {
  return netPost(`${CONFIG.botUrl}${path}`, CONFIG.apiKey, body, CONFIG.httpTimeoutSeconds);
}

function onFail(e) {
  failures++;
  const backoff = Math.min(
    CONFIG.bridgeMaxBackoffTicks,
    CONFIG.pollTicks * Math.pow(2, Math.min(6, failures)),
 );
  skipTicks = Math.max(1, Math.floor(backoff / CONFIG.pollTicks));
  if (Bridge.online || failures === 1) console.warn("[UHC] البوت مو موجود:", e?.message ?? e);
  Bridge.online = false;
}

export const Bridge = {
  online: false,
  onCommand: null,
  getState: null,

  init() { loadAck(); },

  async poll() {
    if (!CONFIG.bridgeEnabled) return;
    if (polling) return;
    if (skipTicks > 0) { skipTicks--; return; }

    polling = true;                            // 🔧 القفل قبل await ensureNet
    try {
      if (!(await ensureNet())) return;

      const res = await request("/uhc/poll", {
        session: botSession,
        ackId: lastAppliedId,
        syncVersion: State.data.syncVersion,
        state: this.getState ? this.getState() : { phase: State.data.phase },
      });
      this.online = true;
      failures = 0;

      // 🔧 بوت جديد (ريستارت) → نصفّر عدّاد الأوامر
      if (res.session && res.session !== botSession) {
        console.warn(`[UHC] جلسة بوت جديدة → تصفير ack (${botSession} → ${res.session})`);
        botSession = res.session;
        lastAppliedId = 0;
        saveAck();
      }

      if (res.sync) {
        try { State.applySync(res.sync); } catch (e) { console.warn("[UHC] sync error:", e); }
      }

      if (Array.isArray(res.commands) && res.commands.length) {
        let advanced = false;
        for (const cmd of res.commands) {
          const id = Number(cmd?.id ?? 0);
          if (!id || id <= lastAppliedId) continue;
          lastAppliedId = id;
          advanced = true;
          if (!this.onCommand) continue;
          try { this.onCommand(cmd); }
          catch (e) { console.warn(`[UHC] cmd ${cmd.action} error:`, e); }
        }
        if (advanced) saveAck();
      }
    } catch (e) {
      onFail(e);
    } finally {
      polling = false;
    }
  },

  queueReport(type, message, extra = {}) {
    pendingReports.push({ type, message: String(message), at: Date.now(), ...extra });
    if (pendingReports.length > CONFIG.reportQueueCap) {
      pendingReports = pendingReports.slice(-CONFIG.reportQueueCap);
    }
  },

  async flushReports() {
    if (!CONFIG.bridgeEnabled || flushing) return;
    if (skipTicks > 0) return;                 // 🔧 يحترم نفس الـ backoff
    if (netStatus === "unavailable") { pendingReports = []; return; }

    flushing = true;
    let batch = [];
    try {
      if (!(await ensureNet())) return;
      batch = pendingReports;
      pendingReports = [];
      await request("/uhc/report", {
        session: botSession,
        reports: batch,
        state: this.getState ? this.getState() : undefined,
        players: world.getPlayers().map(p => {
          let loc = { x: 0, y: 0, z: 0 }, dim = "?";
          try { loc = p.location; dim = p.dimension.id; } catch {}
          let kills = 0;
          try { kills = world.scoreboard.getObjective("uhc_kills")?.getScore(p) ?? 0; } catch {}
          return {
            name: p.name,
            health: healthOf(p),
            kills,
            alive: !State.isEliminated(p.name),
            playing: State.isParticipant(p.name),
            dim: String(dim).replace("minecraft:", ""),
            location: { x: Math.round(loc.x), y: Math.round(loc.y), z: Math.round(loc.z) },
          };
        }),
      });
      this.online = true;
      failures = 0;
      batch = [];
    } catch (e) {
      if (batch.length) pendingReports = batch.concat(pendingReports).slice(-CONFIG.reportQueueCap);
      onFail(e);
    } finally {
      flushing = false;
    }
  },

  status() {
    return {
      enabled: CONFIG.bridgeEnabled, net: netStatus, online: this.online,
      queued: pendingReports.length, session: botSession, ack: lastAppliedId,
    };
  },
};
