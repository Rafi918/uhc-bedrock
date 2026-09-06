# -*- coding: utf-8 -*-
"""UHC Telegram Control Hub — نسخة كاملة"""
import os, re, json, time, html, secrets, asyncio, logging, itertools, pathlib
from collections import deque
from aiohttp import web
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ForceReply
from telegram.constants import ParseMode
from telegram.error import RetryAfter, TelegramError
from telegram.ext import (Application, CommandHandler, CallbackQueryHandler,
                          MessageHandler, ContextTypes, filters)

BASE = pathlib.Path(__file__).resolve().parent
STATE_FILE = BASE / "uhc_state.json"
ENV_FILE = BASE / ".env"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("uhc-bot")


def load_dotenv(p):
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv(ENV_FILE)
BOT_TOKEN = os.getenv("UHC_BOT_TOKEN", "").strip()
ADMIN_IDS = {int(x) for x in re.findall(r"\d+", os.getenv("UHC_ADMIN_IDS", ""))
             if x != "123456789"}
API_KEY = os.getenv("UHC_API_KEY", "").strip() or secrets.token_urlsafe(24)
HOST = os.getenv("UHC_HOST", "127.0.0.1").strip()
PORT = int(os.getenv("UHC_PORT", "8765"))
SESSION = secrets.token_hex(8)

CMD_TTL, CMD_TTL_CRIT = 90.0, 90.0
CRITICAL = {"start", "stop"}
CMD_CAP, MAX_BODY = 40, 512 * 1024
RATE_WINDOW, RATE_MAX = 10.0, 60
PENDING_TTL, LOW_HP = 300.0, 4
QUIET_TYPES = set()   # cheat دايما يوصل
LOW_HP_ALERTS = False
_last_rep = {"t": 0.0, "txt": ""}

DEFAULT_CONFIG = {"borderSize": 3000, "shrinkMinutes": 10, "shrinkAmount": 1000,
                  "graceMinutes": 10, "damageHearts": 1.5, "respawnMinutes": 90,
                  "hudMode": "actionbar", "centerX": 0, "centerZ": 0}
HUD_AR = {"actionbar": "اللوكيشن بار", "title": "فوق الشاشة", "scoreboard": "منيو جانبي"}
PHASE_AR = {"LOBBY": "لوبي", "GRACE": "فترة سماح", "PLAYING": "شغالة", "ENDED": "خلصت"}

STATE = {"config": dict(DEFAULT_CONFIG), "teams": {}, "commands": [], "sync_version": 1,
         "last_mc_state": None, "last_seen": 0.0, "admin_chat_id": None,
         "dashboard_msg_id": None, "dash_fails": 0, "view": "main",
         "players": [], "low_hp_warned": {}}

_cmd_ids = itertools.count(1)
_tok_seq = itertools.count(1)
_tokens, _rate, pending_input = {}, {}, {}
tg_app = None
report_q = None


# ───────────────────────────── أدوات
def tok(v):
    t = format(next(_tok_seq), "x")
    _tokens[t] = v
    if len(_tokens) > 1000:
        for k in list(_tokens)[:500]:
            _tokens.pop(k, None)
    return t


def untok(t):
    return _tokens.get(t)


def esc(t):
    return html.escape(str(t), quote=False)


def fmt_ms(ms):
    try:
        s = max(0, int(ms) // 1000)
    except Exception:
        return "—"
    h, m, x = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m:02d}:{x:02d}"


def is_admin(uid):
    return uid in ADMIN_IDS


def normalize_team(n):
    return " ".join(n.replace("|", "").strip().split())[:24]


def parse_names(t):
    return [" ".join(p.split()) for p in re.split(r"[,\n؛;]+", t) if p.strip()]


def game_running():
    return (STATE.get("last_mc_state") or {}).get("phase") in ("GRACE", "PLAYING")


def mc_online():
    return (time.time() - STATE["last_seen"]) < 8


def online_list():
    if STATE["players"]:
        return [x["name"] for x in STATE["players"]]
    return list((STATE.get("last_mc_state") or {}).get("online") or [])


def online_set():
    return set(online_list())


def save_state():
    try:
        d = {k: STATE[k] for k in ("config", "teams", "sync_version", "admin_chat_id")}
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(STATE_FILE)
    except Exception as e:
        log.warning("save: %s", e)


def load_state():
    if not STATE_FILE.exists():
        return
    try:
        d = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        c = dict(DEFAULT_CONFIG)
        c.update(d.get("config") or {})
        STATE["config"] = c
        STATE["teams"] = {str(k): [str(x) for x in (v or [])]
                          for k, v in (d.get("teams") or {}).items()}
        STATE["sync_version"] = int(d.get("sync_version") or 1) + 1
        STATE["admin_chat_id"] = d.get("admin_chat_id")
        log.info("انقرأت الحالة: %d فريق", len(STATE["teams"]))
    except Exception as e:
        log.warning("load: %s", e)


def bump_sync():
    STATE["sync_version"] += 1
    save_state()


def cmd_ttl(a):
    return CMD_TTL_CRIT if a in CRITICAL else CMD_TTL


def queue_command(action, args=None):
    now = time.time()
    STATE["commands"] = [c for c in STATE["commands"] if now - c["at"] < cmd_ttl(c["action"])]
    STATE["commands"].append({"id": next(_cmd_ids), "action": action,
                              "args": args or {}, "at": now})
    if len(STATE["commands"]) > CMD_CAP:
        STATE["commands"] = STATE["commands"][-CMD_CAP:]


def claim_admin(uid):
    ADMIN_IDS.add(uid)
    try:
        txt = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
        ids = ",".join(str(x) for x in sorted(ADMIN_IDS))
        if re.search(r"^UHC_ADMIN_IDS=", txt, re.M):
            txt = re.sub(r"^UHC_ADMIN_IDS=.*$", f"UHC_ADMIN_IDS={ids}", txt, flags=re.M)
        else:
            txt += f"\nUHC_ADMIN_IDS={ids}\n"
        ENV_FILE.write_text(txt, encoding="utf-8")
        os.chmod(ENV_FILE, 0o600)
        log.warning("الأدمن انسجّل: %s", uid)
    except Exception as e:
        log.warning("claim: %s", e)


# ───────────────────────────── كيبوردات
def kb_main():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🎮 التحكم باللعبة", callback_data="menu_game")],
        [InlineKeyboardButton("🗺 البوردر والانكماش", callback_data="menu_border")],
        [InlineKeyboardButton("👥 الفرق", callback_data="menu_teams"),
         InlineKeyboardButton("👤 اللاعبين", callback_data="menu_playerlist")],
        [InlineKeyboardButton("📊 الحالة", callback_data="act_status"),
         InlineKeyboardButton("🔄 تحديث", callback_data="menu_main")],
        [InlineKeyboardButton("📢 إعلان", callback_data="ask_announce"),
         InlineKeyboardButton("🔔 التقارير هنا", callback_data="act_register")]])


def kb_game():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🚀 بدء الـ UHC", callback_data="ask_start")],
        [InlineKeyboardButton("🛑 إيقاف اللعبة", callback_data="ask_stop")],
        [InlineKeyboardButton("⏸️ إيقاف الانكماش", callback_data="act_pause"),
         InlineKeyboardButton("▶️ استئناف", callback_data="act_resume")],
        [InlineKeyboardButton("⚡ انكماش فوري", callback_data="menu_shrinknow")],
        [InlineKeyboardButton("↺ رجعة / ☠ استبعاد", callback_data="menu_players")],
        [InlineKeyboardButton("⌨️ أمر مباشر", callback_data="ask_raw")],
        [InlineKeyboardButton("🧹 تنظيف فوري", callback_data="act_clean")],
        [InlineKeyboardButton("🏠 رجوع", callback_data="menu_main")]])


def kb_border():
    c = STATE["config"]
    lk = " 🔒" if game_running() else ""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(f"📐 الحجم: ±{c['borderSize']}{lk}", callback_data="ask_size")],
        [InlineKeyboardButton(f"⏱ الانكماش: -{c['shrinkAmount']}/{c['shrinkMinutes']}د",
                              callback_data="ask_shrink")],
        [InlineKeyboardButton(f"💔 الضرر: {c['damageHearts']}❤/ث", callback_data="ask_damage")],
        [InlineKeyboardButton(f"🕊 السماح: {c['graceMinutes']}د", callback_data="ask_grace")],
        [InlineKeyboardButton(f"💚 الرجعة: {c['respawnMinutes']}د", callback_data="ask_respawn")],
        [InlineKeyboardButton(f"👁 العرض: {HUD_AR.get(c.get('hudMode'), '—')}",
                              callback_data="cycle_hud")],
        [InlineKeyboardButton(f"🎯 المركز: ({c.get('centerX',0)}،{c.get('centerZ',0)})",
                              callback_data="ask_center")],
        [InlineKeyboardButton("⏱ جدول تحرك البوردر", callback_data="menu_plan")],
        [InlineKeyboardButton("🏠 رجوع", callback_data="menu_main")]])


def kb_shrinknow():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("-250", callback_data="sn_250"),
         InlineKeyboardButton("-500", callback_data="sn_500"),
         InlineKeyboardButton("-1000", callback_data="sn_1000")],
        [InlineKeyboardButton("✏️ مخصص", callback_data="ask_sn")],
        [InlineKeyboardButton("🎮 رجوع", callback_data="menu_game")]])


def kb_teams():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ فريق جديد", callback_data="ask_tcreate")],
        [InlineKeyboardButton("🟢 إضافة من الأونلاين", callback_data="menu_online")],
        [InlineKeyboardButton("✏️ إضافة بالكتابة", callback_data="menu_tadd")],
        [InlineKeyboardButton("➖ إزالة لاعب", callback_data="menu_trm")],
        [InlineKeyboardButton("🎲 توزيع تلقائي", callback_data="menu_auto")],
        [InlineKeyboardButton("🗑 حذف فريق", callback_data="menu_tdel")],
        [InlineKeyboardButton("📋 عرض", callback_data="menu_teams"),
         InlineKeyboardButton("🧹 مسح الكل", callback_data="ask_clearteams")],
        [InlineKeyboardButton("🏠 رجوع", callback_data="menu_main")]])


def plan_text():
    mc = STATE.get("last_mc_state") or {}
    bd = mc.get("border") or {}
    cur = round(bd.get("currentHalf", STATE["config"]["borderSize"]))
    return ("⏱ <b>جدول تحرك البوردر</b>\n"
            f"البوردر الحالي: <b>{cur}</b>\n\n"
            "المرحلة = خلال كم دقيقة ينكمش كم بلوك.\n"
            "<i>الردود توصلك كتقرير خلال ثواني.</i>")

def kb_plan():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("⚡ قوالب جاهزة", callback_data="menu_plan_preset")],
        [InlineKeyboardButton("📋 اعرض الجدول", callback_data="plan_show")],
        [InlineKeyboardButton("🤖 بناء تلقائي", callback_data="menu_plan_auto")],
        [InlineKeyboardButton("➕ اضف مرحلة", callback_data="ask_plan_add")],
        [InlineKeyboardButton("😴 اضف استراحة", callback_data="ask_plan_rest")],
        [InlineKeyboardButton("🔄 ابدأ من الاول", callback_data="plan_restart"),
         InlineKeyboardButton("🗑 فرّغ", callback_data="plan_clear")],
        [InlineKeyboardButton("📍 مكان التوزيع", callback_data="ask_ring")],
        [InlineKeyboardButton("🗺 رجوع", callback_data="menu_border")]])

def kb_plan_auto():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("90 دقيقة ← 100", callback_data="pauto_90_100")],
        [InlineKeyboardButton("120 دقيقة ← 100", callback_data="pauto_120_100")],
        [InlineKeyboardButton("150 دقيقة ← 150", callback_data="pauto_150_150")],
        [InlineKeyboardButton("✏️ مخصص", callback_data="ask_plan_auto")],
        [InlineKeyboardButton("⏱ رجوع", callback_data="menu_plan")]])

PRESETS = {
    "std": ("⭐ القياسي 2:50", [(50, 1500), (60, 2500), (60, 3000)]),
    "fast": ("🔥 سريع 1:30", [(30, 3000), (30, 2500), (30, 2000)]),
    "long": ("🐢 طويل 4:00", [(70, 1200), (80, 2000), (90, 3000)]),
    "soft": ("🌱 هادي البداية", [(60, 500), (60, 3000), (60, 3500)]),
}


def kb_plan_preset():
    rows = [[InlineKeyboardButton(v[0], callback_data=f"ppre_{k}")]
            for k, v in PRESETS.items()]
    rows.append([InlineKeyboardButton("⏱ رجوع", callback_data="menu_plan")])
    return InlineKeyboardMarkup(rows)


def preset_text(key):
    nm, steps = PRESETS[key]
    cur = STATE["config"].get("borderSize", 8000)
    out = [f"<b>{nm}</b>", f"من <b>{cur}</b>", ""]
    tot = 0
    for i, (mn, am) in enumerate(steps, 1):
        cur = max(40, cur - am)
        tot += mn
        out.append(f"{i}) <b>{mn}</b>د ينكمش <b>{am}</b> ← <b>{cur}</b>")
    out.append("")
    out.append(f"الوقت <b>{tot // 60}:{tot % 60:02d}:00</b> │ النهاية <b>{cur}</b>")
    return "\n".join(out)


def kb_pick_team(prefix):
    r = [[InlineKeyboardButton(f"🏷 {n} ({len(m)})", callback_data=f"{prefix}|{tok(n)}")]
         for n, m in STATE["teams"].items()]
    r.append([InlineKeyboardButton("👥 رجوع", callback_data="menu_teams")])
    return InlineKeyboardMarkup(r)


def kb_pick_player(team):
    r = [[InlineKeyboardButton(f"👤 {p}", callback_data=f"dp|{tok(team)}|{tok(p)}")]
         for p in STATE["teams"].get(team, [])]
    r.append([InlineKeyboardButton("👥 رجوع", callback_data="menu_teams")])
    return InlineKeyboardMarkup(r)


def kb_online_pick(team):
    asg = {m for v in STATE["teams"].values() for m in v}
    names = [n for n in online_list() if n not in asg]
    r = [[InlineKeyboardButton(f"➕ {n}", callback_data=f"ao|{tok(team)}|{tok(n)}")]
         for n in names[:20]]
    if not r:
        r = [[InlineKeyboardButton("(كل الأونلاين بفرق)", callback_data="menu_teams")]]
    r.append([InlineKeyboardButton("✅ خلصت", callback_data="menu_teams")])
    return InlineKeyboardMarkup(r)


def kb_auto():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("👤 سولو", callback_data="auto_1"),
         InlineKeyboardButton("👥 2v2", callback_data="auto_2")],
        [InlineKeyboardButton("👨‍👩‍👦 3v3", callback_data="auto_3"),
         InlineKeyboardButton("🧑‍🤝‍🧑 4v4", callback_data="auto_4")],
        [InlineKeyboardButton("👥 رجوع", callback_data="menu_teams")]])


def kb_players_menu():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("↺ رجعة لاعب مستبعد", callback_data="menu_revive")],
        [InlineKeyboardButton("☠ استبعاد لاعب", callback_data="menu_out")],
        [InlineKeyboardButton("🎮 رجوع", callback_data="menu_game")]])


def kb_players(kind):
    mc = STATE.get("last_mc_state") or {}
    names = mc.get("eliminated" if kind == "revive" else "alive") or []
    icon = "↺" if kind == "revive" else "☠"
    r = [[InlineKeyboardButton(f"{icon} {n}", callback_data=f"{kind}|{tok(n)}")]
         for n in names[:20]]
    if not r:
        r = [[InlineKeyboardButton("(ماكو أسماء)", callback_data="menu_players")]]
    r.append([InlineKeyboardButton("🎮 رجوع", callback_data="menu_game")])
    return InlineKeyboardMarkup(r)


def kb_plist():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔄 تحديث", callback_data="menu_playerlist")],
        [InlineKeyboardButton("🏠 رجوع", callback_data="menu_main")]])


def kb_confirm(act, back):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ أي", callback_data=f"do_{act}"),
         InlineKeyboardButton("❌ لا", callback_data=back)]])


# ───────────────────────────── نصوص
def dashboard_text():
    c = STATE["config"]
    mc = STATE.get("last_mc_state") or {}
    b = mc.get("border") or {}
    ph = mc.get("phase", "؟")
    L = ["🏠 <b>لوحة تحكم الـ UHC</b>",
         f"اللعبة: {'🟢 متصلة' if mc_online() else '🔴 مقطوعة'} │ "
         f"المرحلة: <b>{esc(PHASE_AR.get(ph, ph))}</b>"]
    if mc.get("scattering"):
        L.append("🌀 <b>التوزيع شغال هسه...</b>")
    if mc:
        cur = round(b.get("currentHalf", c["borderSize"]))
        if b.get("shrinking"):
            L.append(f"🗺 البوردر: ±{cur} 🔥 → ±{b.get('targetHalf', cur)} "
                     f"({b.get('speedPerSec', 0)}/ث، {fmt_ms(b.get('remainingMs'))})")
        elif b.get("pausedMs"):
            L.append(f"🗺 البوردر: ±{cur} ⏸ موقوف")
        else:
            L.append(f"🗺 البوردر: ±{cur} (ثابت)")
        if ph == "GRACE":
            L.append(f"🕊 السماح: {fmt_ms(mc.get('graceMsLeft'))}")
        if mc.get("respawnActive"):
            L.append(f"💚 الرجعة: {fmt_ms(mc.get('respawnMsLeft'))}")
        elif ph in ("GRACE", "PLAYING"):
            L.append("💀 الرجعة: خلصت — الموت نهائي")
        al, pa = mc.get("alive") or [], mc.get("participants") or {}
        if pa:
            L.append(f"❤️ الأحياء: <b>{len(al)}</b>/{len(pa)} │ "
                     f"فرق باقية: {len(mc.get('aliveTeams') or [])}")
        if mc.get("winner"):
            L.append(f"🏆 الفائز: <b>{esc(mc['winner'])}</b>")
    else:
        L.append("⚠️ اللعبة بعدها ما اتصلت.")
    L += ["", f"⚙️ ±{c['borderSize']} │ -{c['shrinkAmount']}/{c['shrinkMinutes']}د │ "
              f"{c['damageHearts']}❤/ث │ سماح {c['graceMinutes']}د │ رجعة {c['respawnMinutes']}د",
          f"👥 الفرق: {len(STATE['teams'])} "
          f"({sum(len(m) for m in STATE['teams'].values())} لاعب) │ "
          f"🟢 أونلاين: {len(online_list())}"]
    return "\n".join(L)


def teams_text():
    if not STATE["teams"]:
        return "لك بعد ماكو فرق. اضغط «➕ فريق جديد» 👇"
    on = online_set()
    el = set((STATE.get("last_mc_state") or {}).get("eliminated") or [])
    o = ["👥 <b>الفرق:</b>"]
    for n, ms in STATE["teams"].items():
        mk = [("☠" if m in el else ("🟢" if m in on else "⚪")) + esc(m) for m in ms]
        o.append(f"• <b>{esc(n)}</b> ({len(ms)}): {'، '.join(mk) or 'فاضي'}")
    o.append("\n🟢 أونلاين │ ⚪ أوفلاين │ ☠ مستبعد")
    return "\n".join(o)


def players_text():
    ps = STATE["players"]
    if not ps:
        nl = online_list()
        if nl:
            return ("👤 <b>الأونلاين:</b>\n" + "\n".join("🟢 " + esc(x) for x in nl)
                    + "\n\n<i>التفاصيل توصل خلال ثواني...</i>")
        return "👤 ماكو ولا لاعب أونلاين."
    b = (STATE.get("last_mc_state") or {}).get("border") or {}
    half, cx, cz = b.get("currentHalf"), b.get("centerX", 0), b.get("centerZ", 0)
    rows = sorted(ps, key=lambda p: (not p.get("alive", True), -(p.get("kills") or 0)))
    o = [f"👤 <b>اللاعبين ({len(ps)})</b>"]
    for p in rows:
        hp = p.get("health")
        h = "—" if hp is None else f"{hp/2:.1f}❤"
        ic = "👁" if not p.get("playing", True) else ("🟢" if p.get("alive", True) else "☠")
        loc, ex = p.get("location") or {}, ""
        if half and loc:
            ex = f" │ بوردر {int(half - max(abs(loc.get('x',0)-cx), abs(loc.get('z',0)-cz)))}m"
        dm = {"nether": " │ 🔥نذر", "the_end": " │ 🌌إند"}.get(p.get("dim", ""), "")
        o.append(f"{ic} <b>{esc(p['name'])}</b> — {h} │ 🗡{p.get('kills',0)}{ex}{dm}")
    ks = sorted([(p["name"], p.get("kills") or 0) for p in ps if (p.get("kills") or 0) > 0],
                key=lambda x: -x[1])
    if ks:
        o.append("\n🗡 <b>الكِلز:</b> " + "، ".join(f"{esc(n)} {k}" for n, k in ks[:8]))
    return "\n".join(o)


# ───────────────────────────── إرسال
async def safe_send(chat, text, **kw):
    if not tg_app:
        return
    for _ in range(3):
        try:
            return await tg_app.bot.send_message(chat, text, parse_mode=ParseMode.HTML, **kw)
        except RetryAfter as e:
            await asyncio.sleep(float(getattr(e, "retry_after", 2)) + 0.5)
        except TelegramError as e:
            log.warning("send: %s", e)
            return


async def show(q, text, kb=None, view="other"):
    STATE["view"] = view
    try:
        return await q.edit_message_text(text, reply_markup=kb, parse_mode=ParseMode.HTML)
    except TelegramError as e:
        if "not modified" not in str(e).lower():
            log.warning("edit: %s", e)


def alert(text):
    if report_q and STATE["admin_chat_id"]:
        try:
            report_q.put_nowait((STATE["admin_chat_id"], text))
        except asyncio.QueueFull:
            pass


async def report_worker():
    while True:
        chat, text = await report_q.get()
        try:
            await safe_send(chat, text)
        except Exception as e:
            log.warning("worker: %s", e)
        finally:
            report_q.task_done()
            await asyncio.sleep(0.4)


# ───────────────────────────── أوامر
async def cmd_start(u: Update, c: ContextTypes.DEFAULT_TYPE):
    uid = u.effective_user.id
    if not ADMIN_IDS:
        claim_admin(uid)
        await u.message.reply_text(
            f"✅ انسجّلت كأدمن (آيدي <code>{uid}</code>).", parse_mode=ParseMode.HTML)
    elif not is_admin(uid):
        log.warning("دخول مرفوض من %s", uid)
        return await u.message.reply_text(
            f"⛔ مالك صلاحية.\nآيديك: <code>{uid}</code>", parse_mode=ParseMode.HTML)
    STATE["admin_chat_id"] = u.effective_chat.id
    STATE["view"] = "main"
    STATE["dash_fails"] = 0
    save_state()
    m = await u.message.reply_text(dashboard_text(), reply_markup=kb_main(),
                                   parse_mode=ParseMode.HTML)
    STATE["dashboard_msg_id"] = m.message_id


async def cmd_id(u: Update, c: ContextTypes.DEFAULT_TYPE):
    await u.message.reply_text(f"آيديك: <code>{u.effective_user.id}</code>",
                               parse_mode=ParseMode.HTML)


async def cmd_key(u: Update, c: ContextTypes.DEFAULT_TYPE):
    if not is_admin(u.effective_user.id):
        return
    m = await u.message.reply_text(f"🔑 <code>{esc(API_KEY)}</code>\n<i>تنمسح بدقيقة</i>",
                                   parse_mode=ParseMode.HTML)
    await asyncio.sleep(60)
    try:
        await m.delete()
    except TelegramError:
        pass


NEEDS_MC = {"do_start", "do_stop", "act_pause", "act_resume", "act_clean"}


async def on_button(u: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = u.callback_query
    uid = q.from_user.id
    if not is_admin(uid):
        return await q.answer("⛔ مالك صلاحية", show_alert=True)
    await q.answer()
    d, c = q.data, STATE["config"]

    if (d in NEEDS_MC or d.startswith(("sn_", "revive|", "out|", "plan_", "pauto_", "ppre_"))) and not mc_online():
        return await show(q, "🔴 <b>اللعبة مو متصلة</b> — الأمر ما راح يوصل.\n"
                             "تأكد إن السيرفر شغال والمفتاح مطابق (/key).", kb_main(), "main")

    nav = {"menu_main": (dashboard_text, kb_main, "main"),
           "menu_game": (lambda: "🎮 <b>التحكم باللعبة:</b>", kb_game, "game"),
           "menu_border": (lambda: "🗺 <b>إعدادات البوردر:</b>" +
                           ("\n⚠️ اللعبة شغالة — التغيير فوري!" if game_running() else ""),
                           kb_border, "border"),
           "menu_teams": (teams_text, kb_teams, "teams"),
           "menu_playerlist": (players_text, kb_plist, "players"),
           "menu_shrinknow": (lambda: "⚡ <b>اختار المقدار:</b>", kb_shrinknow, "game"),
           "menu_players": (lambda: "👤 <b>إدارة اللاعبين:</b>", kb_players_menu, "game"),
           "menu_plan": (plan_text, kb_plan, "plan"),
           "menu_plan_preset": (lambda: "⚡ <b>قوالب جاهزة</b>\n\nضغطة واحدة تبني الجدول كامل:", kb_plan_preset, "plan"),
           "menu_plan_auto": (lambda: "🤖 <b>بناء تلقائي</b>\n\n"
                                      "يقسّم المسافة على 4 مراحل مع استراحات بينها:",
                              kb_plan_auto, "plan")}
    if d in nav:
        f, k, v = nav[d]
        return await show(q, f(), k(), v)

    if d in ("plan_show", "plan_clear", "plan_restart"):
        sub = {"plan_show": "", "plan_clear": " clear", "plan_restart": " restart"}[d]
        queue_command("raw", {"cmd": f"scriptevent uhc:plan{sub}"})
        msg = {"plan_show": "📋 اندز — الجدول يوصلك كتقرير.",
               "plan_clear": "🗑 الجدول انفرغ — البوردر ما يتحرك تلقائي.",
               "plan_restart": "🔄 الجدول يبدأ من المرحلة 1."}[d]
        return await show(q, msg, kb_plan(), "plan")

    if d.startswith("pauto_"):
        _, tt, ee = d.split("_")
        queue_command("raw", {"cmd": f"scriptevent uhc:plan auto {tt} {ee}"})
        return await show(q, f"🤖 جدول: يوصل <b>{ee}</b> خلال <b>{tt}</b> دقيقة.\n"
                             f"التفاصيل توصلك كتقرير.", kb_plan(), "plan")

    if d == "menu_plan_preset_go" or d.startswith("ppre_"):
        key = d[5:] if d.startswith("ppre_") else ""
        if key not in PRESETS:
            return await show(q, "⚡ اختار قالب:", kb_plan_preset(), "plan")
        nm, steps = PRESETS[key]
        queue_command("raw", {"cmd": "scriptevent uhc:plan clear"})
        for mn, am in steps:
            queue_command("raw", {"cmd": f"scriptevent uhc:plan add {mn} {am}"})
        queue_command("raw", {"cmd": "scriptevent uhc:plan"})
        return await show(q, f"✅ انبنى\n\n{preset_text(key)}\n\n"
                             "<i>التفاصيل توصلك كتقرير.</i>", kb_plan(), "plan")

    if d == "menu_revive":
        return await show(q, "↺ اختار اللاعب:", kb_players("revive"))
    if d == "menu_out":
        return await show(q, "☠ اختار اللاعب:", kb_players("out"))
    if d == "menu_auto":
        return await show(q, f"🎲 الأونلاين: {len(online_list())} لاعب\nاختار حجم الفريق:",
                          kb_auto())

    if d == "ask_start":
        if game_running():
            return await show(q, "⚠️ اللعبة شغالة أصلاً.", kb_game())
        if not online_list():
            return await show(q, "⚠️ ماكو ولا لاعب أونلاين.", kb_game())
        asg = {m for v in STATE["teams"].values() for m in v}
        nt = [n for n in online_list() if n not in asg]
        w = f"\n⚠️ بلا فريق (سولو): {esc('، '.join(nt))}" if nt else ""
        z = "\n⚠️ <b>الانكماش صفر</b> — البوردر ما ينكمش!" if c["shrinkAmount"] <= 0 else ""
        return await show(q, f"🚀 <b>متأكد تبدي؟</b>\n±{c['borderSize']} │ "
                             f"-{c['shrinkAmount']}/{c['shrinkMinutes']}د │ "
                             f"سماح {c['graceMinutes']}د │ رجعة {c['respawnMinutes']}د\n"
                             f"الفرق: {len(STATE['teams'])} │ أونلاين: "
                             f"{len(online_list())}{w}{z}\n\n"
                             f"⚠️ يمسح عدة الكل ويوزعهم.", kb_confirm("start", "menu_game"))
    if d == "do_start":
        queue_command("start")
        return await show(q, "🚀 اندز أمر البدء — التوزيع ياخذ لحد دقيقة.", kb_game())
    if d == "ask_stop":
        return await show(q, "🛑 <b>متأكد توقف؟</b>", kb_confirm("stop", "menu_game"))
    if d == "do_stop":
        queue_command("stop")
        return await show(q, "🛑 اندز أمر الإيقاف.", kb_game())
    if d == "ask_clearteams":
        return await show(q, "🧹 <b>تمسح كل الفرق؟</b>", kb_confirm("ct", "menu_teams"))
    if d == "do_ct":
        STATE["teams"].clear()
        bump_sync()
        return await show(q, "🗑️ انمسحت.", kb_teams(), "teams")

    if d == "act_register":
        STATE["admin_chat_id"] = q.message.chat_id
        save_state()
        return await show(q, "✅ التقارير توصلك هنا.", kb_main(), "main")
    if d == "act_status":
        if mc_online():
            queue_command("status")
        return await show(q, dashboard_text() + "\n\n📊 التفاصيل توصلك كتقرير.",
                          kb_main(), "main")
    if d == "act_pause":
        queue_command("pause_shrink")
        return await show(q, "⏸️ اندز.", kb_game())
    if d == "act_resume":
        queue_command("resume_shrink")
        return await show(q, "▶️ اندز.", kb_game())
    if d == "act_clean":
        queue_command("cleardrops")
        return await show(q, "🧹 اندز.", kb_game())
    if d == "cycle_hud":
        o = ["actionbar", "title", "scoreboard"]
        cur = c.get("hudMode", "actionbar")
        n = o[(o.index(cur) + 1) % 3] if cur in o else "actionbar"
        c["hudMode"] = n
        bump_sync()
        queue_command("set_hud", {"mode": n})
        return await show(q, f"👁 العرض: <b>{HUD_AR[n]}</b>", kb_border(), "border")
    if d.startswith("sn_"):
        a = int(d.split("_")[1])
        queue_command("shrink_now", {"amount": a})
        return await show(q, f"⚡ ينكمش فوراً {a} بلوك.", kb_game())

    if d.startswith(("revive|", "out|")):
        kind, t = d.split("|", 1)
        n = untok(t)
        if n is None:
            return await show(q, "⚠️ القائمة قديمة — افتحها من جديد.", kb_players_menu())
        queue_command("revive" if kind == "revive" else "eliminate", {"name": n})
        return await show(q, f"{'↺' if kind=='revive' else '☠'} اندز لـ <b>{esc(n)}</b>.",
                          kb_players_menu())

    if d.startswith("auto_"):
        sz = int(d.split("_")[1])
        ns = online_list()
        if not ns:
            return await show(q, "⚠️ ماكو لاعبين أونلاين.", kb_teams(), "teams")
        secrets.SystemRandom().shuffle(ns)
        STATE["teams"].clear()
        cols = ["Red", "Blue", "Green", "Yellow", "Purple", "Orange",
                "Cyan", "Pink", "Lime", "Gray", "Black", "White"]
        for i in range(0, len(ns), sz):
            k = cols[(i // sz) % len(cols)]
            while k in STATE["teams"]:
                k += "2"
            STATE["teams"][k] = ns[i:i + sz]
        bump_sync()
        return await show(q, f"🎲 {len(STATE['teams'])} فريق:\n\n{teams_text()}",
                          kb_teams(), "teams")

    if d in ("menu_tadd", "menu_trm", "menu_tdel", "menu_online"):
        if not STATE["teams"]:
            return await show(q, "⚠️ سوّي فريق أول 👇", kb_teams(), "teams")
        pr = {"menu_tadd": ("✏️ اختار الفريق:", "at"), "menu_online": ("🟢 اختار الفريق:", "ol"),
              "menu_trm": ("➖ اختار الفريق:", "rt"), "menu_tdel": ("🗑 اختار الفريق:", "dt")}
        t, p = pr[d]
        return await show(q, t, kb_pick_team(p))

    if "|" in d:
        head, rest = d.split("|", 1)
        vals = [untok(x) for x in rest.split("|")]
        if any(v is None for v in vals):
            return await show(q, "⚠️ القائمة قديمة — افتحها من جديد.", kb_teams(), "teams")
        if head == "ol":
            return await show(q, f"🟢 اضغط لاعب حتى يندخل <b>{esc(vals[0])}</b>:",
                              kb_online_pick(vals[0]))
        if head == "ao":
            tm, nm = vals
            for t, ms in STATE["teams"].items():
                if nm in ms and t != tm:
                    ms.remove(nm)
            STATE["teams"].setdefault(tm, [])
            if nm not in STATE["teams"][tm]:
                STATE["teams"][tm].append(nm)
            bump_sync()
            return await show(q, f"✅ <b>{esc(nm)}</b> ← <b>{esc(tm)}</b>\n\n{teams_text()}",
                              kb_online_pick(tm))
        if head == "at":
            pending_input[uid] = {"action": "tadd", "data": {"team": vals[0]}, "at": time.time()}
            return await q.message.reply_text(
                f"👤 أسماء لاعبي <b>{esc(vals[0])}</b>.\n"
                f"⚠️ افصل <b>بفاصلة</b> مو بمسافة:\n<code>Ali Iraq, Omar 99</code>",
                reply_markup=ForceReply(selective=True), parse_mode=ParseMode.HTML)
        if head == "rt":
            if not STATE["teams"].get(vals[0]):
                return await show(q, "⚠️ الفريق فاضي.", kb_teams(), "teams")
            return await show(q, f"➖ شيّل من <b>{esc(vals[0])}</b>:", kb_pick_player(vals[0]))
        if head == "dp":
            tm, pl = vals
            if pl in STATE["teams"].get(tm, []):
                STATE["teams"][tm].remove(pl)
                bump_sync()
            return await show(q, f"✅ انشال <b>{esc(pl)}</b>.\n\n{teams_text()}",
                              kb_teams(), "teams")
        if head == "dt":
            STATE["teams"].pop(vals[0], None)
            bump_sync()
            return await show(q, f"🗑️ انمسح.\n\n{teams_text()}", kb_teams(), "teams")

    asks = {"ask_size": ("size", "📐 حجم البوردر (مثال: <code>3000</code>):"),
            "ask_shrink": ("shrink", "⏱ <b>بلوكات</b> ثم <b>دقايق</b>\n"
                                     "مثال: <code>1000 10</code>"),
            "ask_damage": ("damage", "💔 قلوب/ثانية (مثال: <code>1.5</code>):"),
            "ask_grace": ("grace", "🕊 السماح بالدقايق (مثال: <code>10</code>):"),
            "ask_respawn": ("respawn", "💚 الرجعة بالدقايق (<code>0</code> = نهائي):"),
            "ask_center": ("center", "🎯 <code>x z</code> مثال: <code>0 0</code>"),
            "ask_sn": ("sn", "⚡ شقد بلوك فوراً:"),
            "ask_announce": ("announce", "📢 نص الإعلان:"),
            "ask_tcreate": ("tcreate", "➕ اسم الفريق (مثال: <code>Red</code>):"),
            "ask_plan_add": ("plan_add", "➕ <b>اضف مرحلة</b>\n\n"
                             "اكتب <b>الدقايق</b> ثم <b>البلوكات</b>:\n"
                             "<code>60 1000</code> = خلال 60 دقيقة ينكمش 1000\n\n"
                             "ومع استراحة قبلها:\n<code>60 1000 15</code>"),
            "ask_plan_rest": ("plan_rest", "😴 استراحة بالدقايق (مثال: <code>15</code>):"),
            "ask_plan_auto": ("plan_auto", "🤖 <b>الدقايق الكلية</b> ثم <b>حجم النهاية</b>:\n"
                              "<code>120 100</code>"),
            "ask_ring": ("ring", "📍 <b>مكان التوزيع</b> (نسبة من حجم البوردر)\n"
                         "<code>0.9</code> = كلهم على 90%\n"
                         "<code>0.85 0.95</code> = مدى"),
            "ask_raw": ("raw", "⌨️ <b>أمر مباشر للسيرفر</b> (بلا سلاش)\n\n"
                               "<code>scriptevent uhc:status</code>\n"
                               "<code>give @a diamond_sword</code>\n"
                               "<code>effect @a speed 30 2</code>\n"
                               "<code>time set day</code>\n"
                               "<code>weather clear</code>\n"
                               "<code>tp Ali 100 70 200</code>\n"
                               "<code>op Ali</code>\n\n"
                               "⚠️ ينفّذ على السيرفر مباشرة:")}
    if d in asks:
        a, p = asks[d]
        pending_input[uid] = {"action": a, "data": {}, "at": time.time()}
        return await q.message.reply_text(p, reply_markup=ForceReply(selective=True),
                                          parse_mode=ParseMode.HTML)


async def on_text(u: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = u.effective_user.id
    if not is_admin(uid):
        return
    pend = pending_input.pop(uid, None)
    if not pend:
        return
    if time.time() - pend.get("at", 0) > PENDING_TTL:
        return await u.message.reply_text("⌛ انتهى وقت الطلب.", reply_markup=kb_main())
    a, txt, c = pend["action"], (u.message.text or "").strip(), STATE["config"]
    back = {"size": kb_border, "shrink": kb_border, "damage": kb_border, "grace": kb_border,
            "respawn": kb_border, "center": kb_border, "sn": kb_game, "announce": kb_main,
            "tcreate": kb_teams, "tadd": kb_teams, "raw": kb_game,
            "plan_add": kb_plan, "plan_rest": kb_plan,
            "plan_auto": kb_plan, "ring": kb_plan}
    try:
        if a == "size":
            v = int(txt)
            if not 40 <= v <= 30000000:
                raise ValueError("من 40 إلى 30000000")
            c["borderSize"] = v
            bump_sync()
            queue_command("set_border", {"size": v})
            m = f"📐 البوردر ±{v}." + ("\n⚠️ اللعبة شغالة — انطبق فوراً." if game_running() else "")
        elif a == "shrink":
            p = txt.replace("،", " ").split()
            bl, mn = int(p[0]), int(p[1])
            if mn < 1 or bl < 0:
                raise ValueError("دقايق ≥ 1")
            c["shrinkAmount"], c["shrinkMinutes"] = bl, mn
            bump_sync()
            sp = round(bl / (mn * 60), 2)
            if game_running():
                queue_command("reshrink", {"amount": bl, "durationMs": mn * 60000})
                m = f"🔥 <b>اتطبق فوراً!</b> {bl} بلوك / {mn}د (~{sp}/ث)"
            else:
                m = f"⏳ انحفظ: {bl} بلوك / {mn}د (~{sp}/ث)"
        elif a == "damage":
            h = float(txt.replace(",", "."))
            if not 0 <= h <= 20:
                raise ValueError("من 0 إلى 20")
            c["damageHearts"] = h
            bump_sync()
            queue_command("set_damage", {"hearts": h})
            m = f"💔 {h} قلب/ثانية."
        elif a == "grace":
            v = int(txt)
            if not 0 <= v <= 600:
                raise ValueError("من 0 إلى 600")
            c["graceMinutes"] = v
            bump_sync()
            m = f"🕊️ السماح {v} دقيقة."
        elif a == "respawn":
            v = int(txt)
            if not 0 <= v <= 1440:
                raise ValueError("من 0 إلى 1440")
            c["respawnMinutes"] = v
            bump_sync()
            m = f"💚 الرجعة {v} دقيقة." if v else "💀 الموت نهائي من البداية."
        elif a == "center":
            p = txt.replace("،", " ").split()
            x, z = int(p[0]), int(p[1])
            c["centerX"], c["centerZ"] = x, z
            bump_sync()
            queue_command("set_center", {"x": x, "z": z})
            m = f"🎯 المركز ({x}، {z})."
        elif a == "sn":
            v = int(txt)
            if v < 1:
                raise ValueError("أكبر من صفر")
            queue_command("shrink_now", {"amount": v})
            m = f"⚡ ينكمش {v} بلوك فوراً."
        elif a == "announce":
            if not txt:
                raise ValueError("فاضي")
            queue_command("announce", {"message": txt[:200]})
            m = "📢 وصّلنا الإعلان."
        elif a == "raw":
            if not txt:
                raise ValueError("فاضي")
            queue_command("raw", {"cmd": txt[:250]})
            m = f"⌨️ اندز: <code>{esc(txt[:250])}</code>\nالنتيجة توصلك كتقرير."
        elif a == "plan_add":
            p = txt.replace("،", " ").split()
            mins, amt = int(p[0]), int(p[1])
            rest = int(p[2]) if len(p) > 2 else 0
            if mins < 1 or amt < 1: raise ValueError("ارقام اكبر من صفر")
            queue_command("raw", {"cmd": f"scriptevent uhc:plan add {mins} {amt} {rest}"})
            m = (f"➕ مرحلة: خلال <b>{mins}</b> دقيقة ينكمش <b>{amt}</b> بلوك" + (f"\n😴 استراحة {rest} دقيقة قبلها" if rest else ""))
        elif a == "plan_rest":
            v = int(txt)
            if v < 1: raise ValueError("اكبر من صفر")
            queue_command("raw", {"cmd": f"scriptevent uhc:plan rest {v}"})
            m = f"😴 استراحة <b>{v}</b> دقيقة انضافت"
        elif a == "plan_auto":
            p = txt.replace("،", " ").split()
            tot, end = int(p[0]), int(p[1])
            if tot < 8: raise ValueError("8 دقايق على الاقل")
            queue_command("raw", {"cmd": f"scriptevent uhc:plan auto {tot} {end}"})
            m = f"🤖 جدول: يوصل <b>{end}</b> خلال <b>{tot}</b> دقيقة"
        elif a == "ring":
            p = txt.replace("،", " ").split()
            lo = float(p[0].replace(",", "."))
            hi = float(p[1].replace(",", ".")) if len(p) > 1 else lo
            if not (0.2 <= lo <= 0.98): raise ValueError("من 0.2 الى 0.98")
            queue_command("raw", {"cmd": f"scriptevent uhc:ring {lo} {hi}"})
            m = (f"📍 التوزيع على <b>{int(lo*100)}%</b>" + (f"-<b>{int(hi*100)}%</b>" if hi != lo else "") + " من حجم البوردر")
        elif a == "tcreate":
            n = normalize_team(txt)
            if not n:
                raise ValueError("اسم فاضي")
            if n in STATE["teams"]:
                m = f"⚠️ <b>{esc(n)}</b> موجود."
            else:
                STATE["teams"][n] = []
                bump_sync()
                m = f"✅ انسوّى <b>{esc(n)}</b>."
        elif a == "tadd":
            tm = pend["data"]["team"]
            STATE["teams"].setdefault(tm, [])
            add, mv = [], []
            for n in parse_names(txt):
                for t, ms in STATE["teams"].items():
                    if n in ms and t != tm:
                        ms.remove(n)
                        mv.append(f"{n} (من {t})")
                if n not in STATE["teams"][tm]:
                    STATE["teams"][tm].append(n)
                    add.append(n)
            bump_sync()
            on = online_set()
            unk = [n for n in add if on and n not in on]
            m = f"✅ لـ <b>{esc(tm)}</b>: {esc('، '.join(add)) or '(ماكو جديد)'}"
            if mv:
                m += f"\n↔️ انتقلوا: {esc('، '.join(mv))}"
            if unk:
                m += f"\n⚠️ مو أونلاين (شيّك الإملاء): <b>{esc('، '.join(unk))}</b>"
        else:
            return
        await u.message.reply_text(m, reply_markup=back.get(a, kb_main)(),
                                   parse_mode=ParseMode.HTML)
    except (ValueError, IndexError) as e:
        h = str(e) if str(e) and "invalid literal" not in str(e) else "شيّك الشكل"
        await u.message.reply_text(f"❌ القيمة غلط ({esc(h)}).", reply_markup=kb_main(),
                                   parse_mode=ParseMode.HTML)
    except Exception as e:
        log.exception("on_text")
        await u.message.reply_text(f"❌ خطأ: {esc(type(e).__name__)}", reply_markup=kb_main())


# ───────────────────────────── HTTP
def authorized(r):
    try:
        return secrets.compare_digest(r.headers.get("x-uhc-key", "").encode(),
                                      API_KEY.encode())
    except Exception:
        return False


def rate_ok(r):
    ip, now = r.remote or "?", time.time()
    dq = _rate.setdefault(ip, deque())
    while dq and now - dq[0] > RATE_WINDOW:
        dq.popleft()
    if len(_rate) > 200:
        for k in [k for k, v in _rate.items() if not v]:
            _rate.pop(k, None)
    if len(dq) >= RATE_MAX:
        return False
    dq.append(now)
    return True


async def read_json(r):
    try:
        return await r.json()
    except Exception:
        return {}


async def handle_poll(r):
    if not rate_ok(r):
        return web.json_response({"error": "rate"}, status=429)
    if not authorized(r):
        log.warning("poll مرفوض من %s", r.remote)
        return web.json_response({"error": "unauthorized"}, status=401)
    b = await read_json(r)
    if isinstance(b.get("state"), dict):
        STATE["last_mc_state"] = b["state"]
        STATE["last_seen"] = time.time()
    try:
        ack = int(b.get("ackId") or 0)
    except (TypeError, ValueError):
        ack = 0
    if b.get("session") != SESSION:
        ack = 0
    now = time.time()
    STATE["commands"] = [c for c in STATE["commands"]
                         if c["id"] > ack and now - c["at"] < cmd_ttl(c["action"])]
    out = {"session": SESSION,
           "commands": [{"id": c["id"], "action": c["action"], "args": c["args"]}
                        for c in STATE["commands"]]}
    if int(b.get("syncVersion") or -1) != STATE["sync_version"]:
        out["sync"] = {"version": STATE["sync_version"], "config": STATE["config"],
                       "teams": STATE["teams"]}
    return web.json_response(out)


def check_low_hp():
    w = STATE["low_hp_warned"]
    for p in STATE["players"]:
        n, hp = p["name"], p.get("health")
        if hp is None or not p.get("alive", True) or not p.get("playing", True):
            continue
        if hp <= LOW_HP * 2 and not w.get(n):
            w[n] = True
            alert(f"💔 <b>{esc(n)}</b> دمه <b>{hp/2:.1f}</b> قلب فقط!")
        elif hp > (LOW_HP + 3) * 2 and w.get(n):
            w[n] = False


async def handle_report(r):
    if not rate_ok(r):
        return web.json_response({"error": "rate"}, status=429)
    if not authorized(r):
        return web.json_response({"error": "unauthorized"}, status=401)
    b = await read_json(r)
    STATE["last_seen"] = time.time()
    if isinstance(b.get("state"), dict):
        STATE["last_mc_state"] = b["state"]
    if isinstance(b.get("players"), list):
        STATE["players"] = [p for p in b["players"] if isinstance(p, dict) and p.get("name")]
        if game_running() and LOW_HP_ALERTS:
            check_low_hp()
    reps = [x for x in (b.get("reports") or []) if isinstance(x, dict) and x.get("message")
            and x.get("type") not in QUIET_TYPES]
    now = time.time()
    ded = []
    for x in reps:
        m = str(x["message"])
        if x.get("type") != "cmd" and m == _last_rep["txt"] and now - _last_rep["t"] < 30:
            continue
        _last_rep["txt"], _last_rep["t"] = m, now
        ded.append(x)
    reps = ded
    if STATE["admin_chat_id"] and reps:
        cur, chunks = "", []
        for x in reps:
            blk = esc(x["message"])
            if len(cur) + len(blk) > 3500:
                chunks.append(cur)
                cur = blk
            else:
                cur = f"{cur}\n\n{blk}" if cur else blk
        if cur:
            chunks.append(cur)
        for ch in chunks:
            alert(ch)
    return web.json_response({"ok": True})


async def handle_health(r):
    return web.json_response({"ok": True, "mcOnline": mc_online(), "session": SESSION,
                              "admins": len(ADMIN_IDS)})


async def run_http():
    app = web.Application(client_max_size=MAX_BODY)
    app.router.add_post("/uhc/poll", handle_poll)
    app.router.add_post("/uhc/report", handle_report)
    app.router.add_get("/uhc/health", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, HOST, PORT).start()
    log.info("HTTP على %s:%s (session=%s)", HOST, PORT, SESSION)
    return runner


async def dashboard_updater():
    last = ""
    while True:
        await asyncio.sleep(10)
        cid, mid = STATE["admin_chat_id"], STATE["dashboard_msg_id"]
        if not (cid and mid and tg_app) or STATE["view"] != "main":
            continue
        t = dashboard_text()
        if t == last:
            continue
        try:
            await tg_app.bot.edit_message_text(t, chat_id=cid, message_id=mid,
                                               reply_markup=kb_main(),
                                               parse_mode=ParseMode.HTML)
            last, STATE["dash_fails"] = t, 0
        except TelegramError as e:
            if "not modified" in str(e).lower():
                last = t
                continue
            STATE["dash_fails"] += 1
            if STATE["dash_fails"] >= 3:
                STATE["dashboard_msg_id"] = None


async def main():
    global tg_app, report_q
    if not BOT_TOKEN:
        raise SystemExit("❌ لازم UHC_BOT_TOKEN بملف .env")
    if not ADMIN_IDS:
        log.warning("⚠️ ماكو أدمن — أول واحد يدز /start يصير أدمن تلقائياً")
    report_q = asyncio.Queue(maxsize=400)
    load_state()
    tg_app = Application.builder().token(BOT_TOKEN).build()
    tg_app.add_handler(CommandHandler("start", cmd_start))
    tg_app.add_handler(CommandHandler("id", cmd_id))
    tg_app.add_handler(CommandHandler("key", cmd_key))
    tg_app.add_handler(CallbackQueryHandler(on_button))
    tg_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    runner = await run_http()
    await tg_app.initialize()
    await tg_app.start()
    await tg_app.updater.start_polling(drop_pending_updates=True)
    log.info("البوت شغال. admins=%s", sorted(ADMIN_IDS) or "(ماكو — claim mode)")
    tasks = [asyncio.create_task(dashboard_updater()),
             asyncio.create_task(report_worker())]
    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        for t in tasks:
            t.cancel()
        save_state()
        await tg_app.updater.stop()
        await tg_app.stop()
        await tg_app.shutdown()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("bye")
