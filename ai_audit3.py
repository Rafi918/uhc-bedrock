#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""فحص ملفات UHC الحية عبر API متوافق مع OpenAI. المفتاح من ملف، ما يُطبع أبداً."""
import json, os, re, sys, time, pathlib, subprocess, tarfile
import urllib.request, urllib.error
from datetime import datetime

BASE    = os.environ.get("AI_BASE", "https://api.experientiallabs.ai").rstrip("/")
MODEL   = os.environ.get("AI_MODEL", "gpt-6-astra")
KEYF    = os.environ.get("AI_KEYFILE", "/root/.expl_key")
OUTDIR  = pathlib.Path(os.environ.get("AI_OUT", "/root/uhc_audit3"))
PROMPTF = pathlib.Path(os.environ.get("AI_PROMPT", "/root/uhc_audit_prompt2.md"))
SCRIPTS = pathlib.Path("/opt/bds/behavior_packs/UHC_Core_BP/scripts")
BDS     = pathlib.Path("/opt/bds")
BOTDIR  = pathlib.Path("/opt/uhc-bot")
MAXTOK  = int(os.environ.get("AI_MAXTOK", "32000"))
TIMEOUT = int(os.environ.get("AI_TIMEOUT", "1500"))
TEMP    = os.environ.get("AI_TEMP", "")

try: KEY = pathlib.Path(KEYF).read_text().strip()
except Exception as e: sys.exit(f"[x] ماكو مفتاح في {KEYF}: {e}")
if not KEY: sys.exit(f"[x] {KEYF} فارغ")

RED = [
    (re.compile(r'\b(?:sk|xpl|kk)[-_][A-Za-z0-9_\-]{16,}'), '***KEY_REDACTED***'),
    (re.compile(r'\b\d{7,12}:[A-Za-z0-9_\-]{30,}\b'), '***TG_TOKEN_REDACTED***'),
    (re.compile(r'(?im)^(\s*(?:export\s+)?[\w\-]*(?:token|api[_-]?key|apikey|secret|passwo?rd|passwd|auth)[\w\-]*\s*[:=]\s*).+$'), r'\1***REDACTED***'),
    (re.compile(r'(?i)(Bearer\s+)[A-Za-z0-9._\-]{12,}'), r'\1***REDACTED***'),
]
def redact(t):
    for rx, rep in RED: t = rx.sub(rep, t)
    return t

def numbered(p):
    ls = redact(p.read_text(encoding="utf-8", errors="replace")).split("\n")
    w = len(str(len(ls)))
    return "\n".join(f"{i+1:>{w}}| {l}" for i, l in enumerate(ls))

def block(p):
    p = pathlib.Path(p)
    if not p.exists(): return f"\n===== MISSING ON DISK: {p} =====\n"
    st = p.stat()
    ts = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
    return (f"\n===== FILE: {p.name}  ({st.st_size} bytes, mtime {ts}) =====\n"
            f"```\n{numbered(p)}\n```\n")

def run(a, t=60):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=t).stdout
    except Exception as e: return f"(فشل {' '.join(a)}: {e})\n"

def svc_log(svc, cap):
    act = run(["systemctl", "is-active", svc]).strip()
    since = run(["systemctl","show","-p","ActiveEnterTimestamp","--value",svc]).strip().replace('"','')
    if not since: since = "-60 min"
    log = run(["journalctl","-u",svc,"--since",since,"--no-pager","-n","400"])
    head = f"\n===== LOG {svc} (state={act or '?'}, since {since}) =====\n"
    return head + "```\n" + redact(log)[-cap:] + "\n```\n"

def env_ctx():
    keys = ("level-name","level-seed","gamemode","difficulty","allow-cheats","max-players",
            "view-distance","tick-distance","chat-restriction","compression-threshold")
    sp = BDS/"server.properties"
    lines = ""
    if sp.exists():
        for ln in sp.read_text(errors="replace").splitlines():
            if ln.split("=")[0] in keys: lines += ln + "\n"
    return ("\n===== ENV =====\n```\n"
            + run(["systemctl","is-active","bds","uhc-bot"])
            + "\n-- scripts dir --\n" + run(["ls","-la",str(SCRIPTS)])
            + "\n-- key server.properties --\n" + lines + "```\n"
            + block(BDS/"behavior_packs/UHC_Core_BP/manifest.json"))

CORE = ["main.js","state.js","config.js","border.js","teams.js","respawn.js","plan.js"]
MODS = ["extras.js","endlock.js","rejoin.js","anticheat.js","antilag.js",
        "arabic.js","util.js","bridge.js","net.js"]
NEWM = ["safespot.js","gravelava.js","perf.js","spawnprobe.js","graveback.js","config.js"]

def body(name):
    if name == "core":
        return ("### BATCH 1/4 — CORE. المرفق هنا فقط. الوحدات والملفات الجديدة والبوت بدفعات لاحقة.\n"
                + env_ctx() + "".join(block(SCRIPTS/f) for f in CORE) + svc_log("bds", 7000))
    if name == "mods":
        return ("### BATCH 2/4 — MODULES. النواة انفحصت بدفعة منفصلة — لا تعتبرها ناقصة.\n"
                + "".join(block(SCRIPTS/f) for f in MODS) + svc_log("bds", 5000))
    if name == "new":
        return ("### BATCH 3/4 — NEW MODULES (هذي أهم دفعة: كود انكتب اليوم وما انفحص أبداً).\n"
                "ركّز على التداخل مع respawn.js و border.js و main.js، وعلى نمو الـMaps،\n"
                "وعلى تعديل perf.js لـCONFIG وقت التشغيل.\n"
                + "".join(block(SCRIPTS/f) for f in NEWM) + svc_log("bds", 5000))
    if name == "bot":
        return ("### BATCH 4/4 — BOT + BRIDGE. ركّز على auth، rate limit، raw endpoint،\n"
                "ack/session handshake، وتوافق العقد بين bot.py و bridge.js.\n"
                + "".join(block(p) for p in
                          [BOTDIR/"bot.py", BOTDIR/"uhc_state.json",
                           SCRIPTS/"bridge.js", SCRIPTS/"net.js"])
                + svc_log("uhc-bot", 15000))
    sys.exit("[x] batch مجهول: " + name)

SYS = ("أنت مراجع كود سينيور متخصص بـ Minecraft Bedrock Script API 2.x وبايثون. "
       "التزم بتعليمات المستخدم بالحرف، جاوب بالعربية (لهجة عراقية)، وخلّي الكود "
       "وأسماء الملفات والدوال بالإنكليزي. ممنوع تخترع APIs غير موجودة على Bedrock.")

def hdrs(extra=None):
    h = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json",
         "User-Agent": "uhc-audit/3.0"}
    if extra: h.update(extra)
    return h

def post(path, payload, stream, sink):
    req = urllib.request.Request(BASE + path,
        data=json.dumps(payload, ensure_ascii=False).encode(), method="POST",
        headers=hdrs({"Accept": "text/event-stream"} if stream else {"Accept": "application/json"}))
    got = 0
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        if not stream:
            d = json.load(r)
            txt = (d.get("choices") or [{}])[0].get("message", {}).get("content") or ""
            sink(txt); return len(txt)
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"): continue
            data = line[5:].strip()
            if data in ("[DONE]", "DONE"): break
            try: ev = json.loads(data)
            except Exception: continue
            if ev.get("error"):
                raise RuntimeError(json.dumps(ev["error"], ensure_ascii=False)[:300])
            d = (ev.get("choices") or [{}])[0].get("delta") or {}
            txt = d.get("content") or ""
            if txt: got += len(txt); sink(txt)
    return got

def ask(name):
    user = PROMPTF.read_text(encoding="utf-8") + "\n\n" + body(name)
    print(f"[i] {name}: {len(user):,} حرف (~{len(user)//3:,} توكن تقديري)", flush=True)
    msgs = [{"role":"system","content":SYS},{"role":"user","content":user}]
    base = {"model": MODEL, "messages": msgs, "max_tokens": MAXTOK}
    if TEMP:
        try: base["temperature"] = float(TEMP)
        except ValueError: pass
    plans = [({**base, "stream": True}, True,  "stream"),
             ({**base, "stream": False}, False, "non-stream"),
             ({k: v for k, v in base.items() if k != "max_tokens"} | {"stream": True},
              True, "stream/no-max_tokens")]
    OUTDIR.mkdir(parents=True, exist_ok=True)
    out, part = OUTDIR/f"AUDIT_{name}.md", OUTDIR/f"AUDIT_{name}.part"
    for payload, stream, label in plans:
        for attempt in (1, 2, 3):
            try:
                with part.open("w", encoding="utf-8") as fh:
                    n = [0]
                    def sink(t):
                        fh.write(t); fh.flush(); n[0] += len(t)
                        if n[0] % 4000 < len(t): print(".", end="", flush=True)
                    got = post("/v1/chat/completions", payload, stream, sink)
                print()
                if got < 200: raise RuntimeError(f"رد قصير ({got} حرف)")
                part.replace(out)
                print(f"[✓] {name} خلص عبر {label} → {out} ({got:,} حرف)", flush=True)
                return True
            except urllib.error.HTTPError as e:
                msg = redact((e.read().decode("utf-8","replace") or ""))[:250]
                print(f"\n[!] {label} HTTP {e.code}: {msg}", flush=True)
                if e.code in (429,500,502,503,504) and attempt < 3:
                    time.sleep(6*attempt); continue
                break
            except Exception as e:
                print(f"\n[!] {label} فشل: {redact(str(e))[:200]}", flush=True)
                if attempt < 3: time.sleep(5*attempt); continue
                break
    print(f"[x] {name} فشل بكل المحاولات", flush=True)
    return False

def models():
    req = urllib.request.Request(BASE + "/v1/models", headers=hdrs({"Accept":"application/json"}))
    try:
        d = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:
        print("القائمة محجوبة أو فشلت:", redact(str(e))[:200]); return
    ids = sorted(str(m.get("id","")) for m in (d.get("data") or []))
    print("\n".join(ids) or "(ماكو موديلات)")
    print(f"\nالمطلوب '{MODEL}' " + ("موجود ✓" if MODEL in ids else "غير موجود ✗ — استخدم AI_MODEL"))

def ping():
    p = {"model": MODEL, "stream": True, "max_tokens": 64,
         "messages": [{"role":"user","content":"جاوب بكلمة واحدة: جاهز"}]}
    got = post("/v1/chat/completions", p, True, lambda t: sys.stdout.write(t))
    print(f"\n[i] ping ok ({got} حرف)")

def bundle():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    allf = OUTDIR/"AUDIT_ALL.md"
    with allf.open("w", encoding="utf-8") as fh:
        fh.write(f"# UHC AI AUDIT — {datetime.now():%Y-%m-%d %H:%M} — model={MODEL}\n")
        for n in ("core","mods","new","bot"):
            p = OUTDIR/f"AUDIT_{n}.md"
            fh.write(f"\n\n---\n\n# === {n.upper()} ===\n\n")
            fh.write(p.read_text(encoding="utf-8") if p.exists() else "(ماكو تقرير)\n")
    tgz = pathlib.Path("/root/uhc_audit3.tgz")
    with tarfile.open(tgz, "w:gz") as tf: tf.add(OUTDIR, arcname=OUTDIR.name)
    print(f"[✓] {allf}\n[✓] {tgz}")

if __name__ == "__main__":
    a = sys.argv[1:] or ["all"]
    if a[0] == "models": models(); sys.exit(0)
    if a[0] == "ping":   ping();   sys.exit(0)
    if not PROMPTF.exists(): sys.exit(f"[x] ماكو prompt في {PROMPTF}")
    todo = ["new","core","mods","bot"] if a[0] == "all" else a
    ok = all(ask(b) for b in todo)
    bundle()
    sys.exit(0 if ok else 1)
