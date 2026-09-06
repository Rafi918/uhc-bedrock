// ============================================================================
//  UHC Core - إدارة الحالة
//  🔧 الجديد: حماية "ما تحفظ قبل ما تقرأ" (كان يمسح لعبة كاملة بعد ريستارت)
//     + overrides: أوامر داخل اللعبة ما تنمسح بأول سنك من البوت
//     + cfgShrink*: سنك البوت ما يخرب انكماش جاري
// ============================================================================
import { world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { clamp } from "./util.js";

const KEY = "uhc:state";
const SCHEMA = 3;
const MAX_JSON = 30000;            // سقف dynamic property ~32KB

const DEFAULTS = {
  schema: SCHEMA,
  gameId: 0,
  phase: "LOBBY",                  // LOBBY | GRACE | PLAYING | ENDED
  gameStartAt: 0,
  endedAt: 0,
  scatterUntil: 0,                 // خلال التوزيع: البوردر والـ HUD يهدون
  syncVersion: -1,
  overrides: {},                   // { damageHearts: true, ... } تعديل داخل اللعبة
  lastBotCfg: {},                  // آخر قيمة شفناها من البوت لكل مفتاح
  border: {
    centerX: 0,
    centerZ: 0,
    currentHalf: 8000,
    startHalf: 8000,
    shrinkAmount: 1000,            // القيمة الفعّالة للانكماش الجاري
    shrinkDurationMs: 10 * 60 * 1000,
    cfgShrinkAmount: 1000,         // إعداد البوت (ما يلمس الجاري)
    cfgShrinkDurationMs: 10 * 60 * 1000,
    shrinkFromHalf: 8000,
    shrinkTargetHalf: 8000,
    shrinkStartAt: 0,
    pausedRemainingMs: 0,
    shrinking: false,
    damage: 2,
  },
  hud: { mode: "actionbar", off: false },      // actionbar | title | scoreboard
  grace: { minutes: 10, endAt: 0, ended: false },
  respawn: { minutes: 90, endAt: 0, announced: false },
  teams: {},                       // { "Red": ["Ali"] } روستر البوت
  participants: {},                // { "Ali": "Red" }   لقطة وقت البدء
  eliminated: [],
  offlineSince: {},
  plan: { idx: -1, startAt: 0, resting: true, done: false },
  chatOff: true,
  netherMinutes: 90,
  winner: null,
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const HUD_MODES = ["actionbar", "title", "scoreboard"];

export const State = {
  data: clone(DEFAULTS),
  _dirty: false,
  _loaded: false,

  load() {
    this._loaded = false;
    try {
      const raw = world.getDynamicProperty(KEY);

      if (raw === undefined || raw === null) {
        // ⚠️ ما نعرف إذا العالم جديد فعلاً أو الـ API بعده مو جاهز.
        //    نسمح بالحفظ بس نسجّل تحذير — init() ينادي load بعد worldLoad.
        console.warn("[UHC] ماكو حالة محفوظة (عالم جديد؟) → افتراضيات");
        this._loaded = true;
        return;
      }
      if (typeof raw !== "string" || !raw) { this._loaded = true; return; }

      const parsed = JSON.parse(raw);

      if (parsed.schema !== SCHEMA) {
        console.warn(`[UHC] schema قديم (${parsed.schema}) → لوبي، والفرق محفوظة`);
        const fresh = clone(DEFAULTS);
        if (parsed.teams && typeof parsed.teams === "object") fresh.teams = parsed.teams;
        if (parsed.border && isNum(parsed.border.startHalf)) {
          fresh.border.startHalf = parsed.border.startHalf;
          fresh.border.currentHalf = parsed.border.startHalf;
          fresh.border.shrinkFromHalf = parsed.border.startHalf;
          fresh.border.shrinkTargetHalf = parsed.border.startHalf;
        }
        this.data = fresh;
        this._loaded = true;
        this.save();
        return;
      }

      const d = clone(DEFAULTS);
      Object.assign(d, parsed);
      d.border = Object.assign(clone(DEFAULTS.border), parsed.border ?? {});
      d.hud = Object.assign(clone(DEFAULTS.hud), parsed.hud ?? {});
      d.grace = Object.assign(clone(DEFAULTS.grace), parsed.grace ?? {});
      d.respawn = Object.assign(clone(DEFAULTS.respawn), parsed.respawn ?? {});
      d.plan = Object.assign(clone(DEFAULTS.plan), parsed.plan ?? {});
      d.teams = (parsed.teams && typeof parsed.teams === "object") ? parsed.teams : {};
      d.participants = (parsed.participants && typeof parsed.participants === "object") ? parsed.participants : {};
      d.offlineSince = (parsed.offlineSince && typeof parsed.offlineSince === "object") ? parsed.offlineSince : {};
      d.overrides = (parsed.overrides && typeof parsed.overrides === "object") ? parsed.overrides : {};
      d.lastBotCfg = (parsed.lastBotCfg && typeof parsed.lastBotCfg === "object") ? parsed.lastBotCfg : {};
      d.eliminated = Array.isArray(parsed.eliminated) ? parsed.eliminated.filter(x => typeof x === "string") : [];
      d.schema = SCHEMA;
      this.data = d;
      this.sanitize();
      this._loaded = true;
    } catch (e) {
      console.warn("[UHC] فشل قراءة الحالة → افتراضيات:", e);
      this.data = clone(DEFAULTS);
      this._loaded = true;
    }
  },

  sanitize() {
    const d = this.data;
    const b = d.border;
    const LIM = 30000000;

    b.centerX = isNum(b.centerX) ? Math.floor(b.centerX) : 0;
    b.centerZ = isNum(b.centerZ) ? Math.floor(b.centerZ) : 0;
    b.currentHalf = clamp(isNum(b.currentHalf) ? b.currentHalf : 3000, CONFIG.minBorderHalf, LIM);
    b.startHalf = clamp(isNum(b.startHalf) ? b.startHalf : b.currentHalf, CONFIG.minBorderHalf, LIM);
    b.shrinkAmount = Math.max(0, isNum(b.shrinkAmount) ? Math.floor(b.shrinkAmount) : 0);
    b.cfgShrinkAmount = Math.max(0, isNum(b.cfgShrinkAmount) ? Math.floor(b.cfgShrinkAmount) : b.shrinkAmount);
    b.shrinkDurationMs = Math.max(1000, isNum(b.shrinkDurationMs) ? Math.floor(b.shrinkDurationMs) : 600000);
    b.cfgShrinkDurationMs = Math.max(1000, isNum(b.cfgShrinkDurationMs) ? Math.floor(b.cfgShrinkDurationMs) : b.shrinkDurationMs);
    b.shrinkTargetHalf = clamp(isNum(b.shrinkTargetHalf) ? b.shrinkTargetHalf : b.currentHalf, CONFIG.minBorderHalf, LIM);
    b.shrinkFromHalf = clamp(isNum(b.shrinkFromHalf) ? b.shrinkFromHalf : b.currentHalf, CONFIG.minBorderHalf, LIM);
    b.shrinkStartAt = isNum(b.shrinkStartAt) ? b.shrinkStartAt : 0;
    b.pausedRemainingMs = Math.max(0, isNum(b.pausedRemainingMs) ? b.pausedRemainingMs : 0);
    b.shrinking = b.shrinking === true;
    b.damage = clamp(isNum(b.damage) ? b.damage : CONFIG.damageOutsideBorder, 0, 40);

    // 🔧 الدقايق والمؤقتات (بدونها endAt = NaN = السماح ما يخلص أبداً)
    d.grace.minutes = clamp(isNum(d.grace.minutes) ? Math.floor(d.grace.minutes) : 10, 0, 600);
    d.respawn.minutes = clamp(isNum(d.respawn.minutes) ? Math.floor(d.respawn.minutes) : 90, 0, 1440);
    if (!isNum(d.grace.endAt)) d.grace.endAt = 0;
    if (!isNum(d.respawn.endAt)) d.respawn.endAt = 0;
    if (!isNum(d.gameStartAt)) d.gameStartAt = 0;
    if (!isNum(d.endedAt)) d.endedAt = 0;
    if (!isNum(d.scatterUntil)) d.scatterUntil = 0;
    if (!isNum(d.gameId)) d.gameId = 0;

    if (!HUD_MODES.includes(d.hud.mode)) d.hud.mode = "actionbar";
    if (!["LOBBY", "GRACE", "PLAYING", "ENDED"].includes(d.phase)) d.phase = "LOBBY";
  },

  save() {
    // 🔧 بدون هذا الشرط، قراءة فاشلة + حفظ = محو لعبة كاملة
    if (!this._loaded) {
      console.warn("[UHC] رفض الحفظ: الحالة ما انقرأت بعد");
      return;
    }
    try {
      const json = JSON.stringify(this.data);
      if (json.length > MAX_JSON) {
        console.warn(`[UHC] ⚠️ حجم الحالة ${json.length} بايت — قريب من السقف`);
      }
      world.setDynamicProperty(KEY, json);
      this._dirty = false;
    } catch (e) { console.warn("[UHC] فشل حفظ الحالة:", e); }
  },

  markDirty() { this._dirty = true; },
  flush() { if (this._dirty) this.save(); },

  // ---------- لاعبين ----------
  isEliminated(name) { return this.data.eliminated.includes(name); },

  eliminate(name) {
    if (this.isEliminated(name)) return false;
    this.data.eliminated.push(name);
    delete this.data.offlineSince[name];
    this.save();
    return true;
  },

  revive(name) {
    const i = this.data.eliminated.indexOf(name);
    if (i === -1) return false;
    this.data.eliminated.splice(i, 1);
    this.save();
    return true;
  },

  isParticipant(name) { return Object.prototype.hasOwnProperty.call(this.data.participants, name); },
  teamOfParticipant(name) { return this.data.participants[name] ?? null; },

  teamOfRoster(name) {
    for (const [team, members] of Object.entries(this.data.teams)) {
      if (Array.isArray(members) && members.includes(name)) return team;
    }
    return null;
  },

  markOverride(key) {
    this.data.overrides[key] = true;
    this.save();
  },

  resetGame() {
    const d = this.data;
    d.phase = "LOBBY";
    d.gameStartAt = 0;
    d.endedAt = 0;
    d.scatterUntil = 0;
    d.participants = {};
    d.eliminated = [];
    d.offlineSince = {};
    d.winner = null;
    d.plan = { idx: -1, startAt: 0, resting: true, done: false };
    d.grace.endAt = 0;
    d.grace.ended = false;
    d.respawn.endAt = 0;
    d.respawn.announced = false;
    d.border.shrinking = false;
    d.border.pausedRemainingMs = 0;
    d.border.shrinkAmount = d.border.cfgShrinkAmount;
    d.border.shrinkDurationMs = d.border.cfgShrinkDurationMs;
    d.border.currentHalf = d.border.startHalf;
    d.border.shrinkFromHalf = d.border.startHalf;
    d.border.shrinkTargetHalf = d.border.startHalf;
    this.save();
  },

  // ---------- مزامنة من البوت ----------
  //  المنطق: التعديل داخل اللعبة يفوز، إلا إذا الأدمن غيّر نفس الإعداد بالبوت فعلاً
  applySync(sync) {
    if (!sync || typeof sync !== "object") return;
    const c = sync.config ?? {};
    const d = this.data;
    const inLobby = d.phase === "LOBBY" || d.phase === "ENDED";

    const field = (key, apply) => {
      const v = c[key];
      if (v === undefined || v === null) return;
      const changed = d.lastBotCfg[key] !== v;
      d.lastBotCfg[key] = v;
      if (changed || !d.overrides[key]) {
        apply(v);
        if (changed) delete d.overrides[key];
      }
    };

    field("borderSize", (v) => {
      if (!isNum(v)) return;
      d.border.startHalf = clamp(Math.floor(v), CONFIG.minBorderHalf, 30000000);
      if (inLobby) {
        d.border.currentHalf = d.border.startHalf;
        d.border.shrinkTargetHalf = d.border.startHalf;
        d.border.shrinkFromHalf = d.border.startHalf;
      }
    });
    field("centerX", (v) => { if (isNum(v)) d.border.centerX = Math.floor(v); });
    field("centerZ", (v) => { if (isNum(v)) d.border.centerZ = Math.floor(v); });

    // 🔧 نكتب على cfg* بس — الانكماش الجاري ما ينلمس
    field("shrinkMinutes", (v) => {
      if (!isNum(v)) return;
      d.border.cfgShrinkDurationMs = Math.max(1, Math.floor(v)) * 60000;
      if (!d.border.shrinking) d.border.shrinkDurationMs = d.border.cfgShrinkDurationMs;
    });
    field("shrinkAmount", (v) => {
      if (!isNum(v)) return;
      d.border.cfgShrinkAmount = Math.max(0, Math.floor(v));
      if (!d.border.shrinking) d.border.shrinkAmount = d.border.cfgShrinkAmount;
    });
    field("damageHearts", (v) => { if (isNum(v)) d.border.damage = clamp(Number(v), 0, 20) * 2; });
    field("hudMode", (v) => { if (HUD_MODES.includes(v)) d.hud.mode = v; });

    field("graceMinutes", (v) => {
      if (!isNum(v)) return;
      d.grace.minutes = clamp(Math.floor(v), 0, 600);
      if (d.phase === "GRACE" && d.gameStartAt) d.grace.endAt = d.gameStartAt + d.grace.minutes * 60000;
    });
    field("respawnMinutes", (v) => {
      if (!isNum(v)) return;
      d.respawn.minutes = clamp(Math.floor(v), 0, 1440);
      if (!inLobby && d.gameStartAt) {
        d.respawn.endAt = d.gameStartAt + d.respawn.minutes * 60000;
        d.respawn.announced = Date.now() >= d.respawn.endAt;
      }
    });

    if (sync.teams && typeof sync.teams === "object") {
      const botTeams = JSON.stringify(sync.teams);
      const changed = d.lastBotCfg.__teams !== botTeams;
      d.lastBotCfg.__teams = botTeams;
      if (changed || !d.overrides.teams) {
        const clean = {};
        for (const [name, members] of Object.entries(sync.teams)) {
          if (typeof name !== "string") continue;
          clean[name] = Array.isArray(members) ? members.filter(m => typeof m === "string") : [];
        }
        d.teams = clean;
        if (changed) delete d.overrides.teams;
      }
    }

    if (isNum(sync.version)) d.syncVersion = sync.version;
    this.sanitize();
    this.save();
  },
};
