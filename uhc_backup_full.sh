#!/bin/bash
# نسخة احتياطية كاملة بأسماء واضحة: السكربتات + المودات + العالم + البوت + الخدمات
set -uo pipefail
BDS=/opt/bds
BOT=/opt/uhc-bot
TAG=${1:-manual}
TS=$(date +%Y-%m-%d_%H%M)
LV=$(grep -E '^level-name=' $BDS/server.properties | cut -d= -f2- | tr -d '\r')
DEST=/root/backups/uhc_${TS}_${TAG}
mkdir -p "$DEST"/{bds,mods,bot,systemd}
chmod 700 /root/backups "$DEST"

echo "════ نسخة احتياطية → $DEST ════"
echo "العالم الحالي: $LV"

# ── إعدادات السيرفر ──
for f in server.properties allowlist.json whitelist.json permissions.json; do
  [ -f "$BDS/$f" ] && cp -a "$BDS/$f" "$DEST/bds/"
done

# ── الأدونات (بلا vanilla/chemistry/editor) ──
copy_packs() {
  local src="$1" out="$2"; mkdir -p "$out"
  [ -d "$src" ] || return 0
  for d in "$src"/*/; do
    local n; n=$(basename "$d")
    case "$n" in vanilla*|chemistry*|editor*|experimental*|server_*) continue;; esac
    cp -a "$d" "$out/"
    echo "  ✓ $n"
  done
}
echo "-- behavior_packs --"; copy_packs "$BDS/behavior_packs" "$DEST/mods/behavior_packs"
echo "-- resource_packs --"; copy_packs "$BDS/resource_packs" "$DEST/mods/resource_packs"

# ── العالم ──
if [ -d "$BDS/worlds/$LV" ]; then
  mkdir -p "$DEST/bds/worlds"
  cp -a "$BDS/worlds/$LV" "$DEST/bds/worlds/"
  echo "  ✓ العالم $LV ($(du -sh "$BDS/worlds/$LV" | cut -f1))"
else
  echo "  ⚠ ماكو مجلد عالم باسم $LV"
fi

# ── البوت ──
for f in bot.py uhc_state.json .env requirements.txt; do
  [ -f "$BOT/$f" ] && cp -a "$BOT/$f" "$DEST/bot/"
done

# ── الخدمات ──
for u in bds uhc-bot; do
  systemctl cat "$u" > "$DEST/systemd/$u.service.txt" 2>/dev/null
done

# ── المانيفست ──
{
  echo "UHC BACKUP — $TS  ($TAG)"
  echo "==================================================="
  echo "التاريخ      : $(date '+%F %T %Z')"
  echo "العالم       : $LV"
  echo "BDS version  : $(ls $BDS/behavior_packs/ | grep -oP 'vanilla_\K[0-9.]+' | sort -V | tail -1)"
  echo "الخدمات      : bds=$(systemctl is-active bds) uhc-bot=$(systemctl is-active uhc-bot)"
  echo
  echo "── إعدادات مهمة ──"
  grep -E '^(level-name|level-seed|gamemode|difficulty|allow-cheats|max-players|view-distance|tick-distance|chat-restriction|server-port)=' \
    $BDS/server.properties
  echo
  echo "── الأدونات ──"
  for d in "$DEST/mods/behavior_packs"/*/ "$DEST/mods/resource_packs"/*/; do
    [ -d "$d" ] || continue
    m="$d/manifest.json"
    [ -f "$m" ] && printf '%-34s %s\n' "$(basename "$d")" \
      "$(python3 -c "import json,sys;d=json.load(open('$m'));h=d.get('header',{});print(h.get('name','?'),h.get('version','?'))" 2>/dev/null)"
  done
  echo
  echo "── UHC scripts (sha256) ──"
  (cd "$DEST/mods/behavior_packs/UHC_Core_BP/scripts" 2>/dev/null && sha256sum *.js) || echo "(ماكو)"
  echo
  echo "── البوت ──"
  (cd "$DEST/bot" && sha256sum ./* 2>/dev/null | sed 's|\./||')
  echo
  echo "⚠ .env يحتوي مفاتيح — لا ترفع هذا الأرشيف لأي مكان عام"
} > "$DEST/MANIFEST.txt"

# ── سكربت الاستعادة ──
cat > "$DEST/RESTORE.sh" <<'R'
#!/bin/bash
# يرجّع كل شي لحالة هذي النسخة
set -e
D="$(cd "$(dirname "$0")" && pwd)"
BDS=/opt/bds; BOT=/opt/uhc-bot
echo "استعادة من $D"
read -rp "متأكد؟ يكتب فوق /opt/bds و /opt/uhc-bot [اكتب yes]: " a
[ "$a" = "yes" ] || { echo "أُلغي"; exit 1; }
systemctl stop bds uhc-bot || true
cp -a "$D/bds/server.properties" $BDS/
for f in allowlist.json whitelist.json permissions.json; do
  [ -f "$D/bds/$f" ] && cp -a "$D/bds/$f" $BDS/
done
[ -d "$D/mods/behavior_packs" ] && cp -a "$D/mods/behavior_packs/." $BDS/behavior_packs/
[ -d "$D/mods/resource_packs" ] && cp -a "$D/mods/resource_packs/." $BDS/resource_packs/
[ -d "$D/bds/worlds" ] && cp -a "$D/bds/worlds/." $BDS/worlds/
for f in bot.py uhc_state.json .env; do
  [ -f "$D/bot/$f" ] && cp -a "$D/bot/$f" $BOT/
done
chown -R uhc:uhc $BDS $BOT 2>/dev/null || true
systemctl start uhc-bot; sleep 2; systemctl start bds
echo "✔ رجعت. راقب: journalctl -u bds -f"
R
chmod +x "$DEST/RESTORE.sh"

TGZ="/root/backups/uhc_${TS}_${TAG}.tgz"
tar -czf "$TGZ" -C /root/backups "uhc_${TS}_${TAG}"
chmod 600 "$TGZ"

echo
echo "════ خلص ════"
echo "  المجلد : $DEST  ($(du -sh "$DEST" | cut -f1))"
echo "  الأرشيف: $TGZ   ($(du -sh "$TGZ" | cut -f1))"
echo "  للرجوع : bash $DEST/RESTORE.sh"
sed -n '1,12p' "$DEST/MANIFEST.txt"
