#!/bin/bash
# عالم جديد بنفس مواصفات القديم (نفس الأدونات + experiments + كل الإعدادات)
# الاستخدام: uhc_newworld.sh [اسم] [seed|same|random]
set -uo pipefail
BDS=/opt/bds
NEW=${1:-uhc_$(date +%m%d_%H%M)}
SEEDARG=${2:-random}
OLD=$(grep -E '^level-name=' $BDS/server.properties | cut -d= -f2- | tr -d '\r')
OLDDIR="$BDS/worlds/$OLD"; NEWDIR="$BDS/worlds/$NEW"

echo "════ عالم جديد ════"
echo "  من : $OLD"
echo "  إلى: $NEW   (seed=$SEEDARG)"
[ -d "$OLDDIR" ] || { echo "✖ ماكو $OLDDIR"; exit 1; }
[ -e "$NEWDIR" ] && { echo "✖ $NEWDIR موجود — اختر اسم ثاني"; exit 1; }
[ -f "$OLDDIR/level.dat" ] || { echo "✖ ماكو level.dat بالعالم القديم"; exit 1; }

read -rp "نكمل؟ يوقف السيرفر ويبدّل العالم (القديم يبقى محفوظ) [yes]: " a
[ "$a" = "yes" ] || { echo "أُلغي"; exit 1; }

systemctl stop bds; sleep 3
cp -a "$BDS/server.properties" "$BDS/server.properties.bak_$(date +%H%M%S)"

mkdir -p "$NEWDIR"
# level.dat يحمل experiments + إعدادات التوليد │ بلا db/ = خريطة جديدة
cp -a "$OLDDIR/level.dat" "$NEWDIR/level.dat"
[ -f "$OLDDIR/level.dat_old" ] && cp -a "$OLDDIR/level.dat_old" "$NEWDIR/"
printf '%s' "$NEW" > "$NEWDIR/levelname.txt"
# الأدونات مربوطة بالعالم على BDS — لازم ننسخ الربط
for f in world_behavior_packs.json world_resource_packs.json; do
  [ -f "$OLDDIR/$f" ] && cp -a "$OLDDIR/$f" "$NEWDIR/" && echo "  ✓ $f"
done

# ── تبديل السيد داخل level.dat (NBT: TAG_Long "RandomSeed") ──
SEEDOUT="same"
if [ "$SEEDARG" != "same" ]; then
  if [ "$SEEDARG" = "random" ]; then NS=$(( (RANDOM<<48) ^ (RANDOM<<32) ^ (RANDOM<<16) ^ RANDOM ));
  else NS=$SEEDARG; fi
  SEEDOUT=$(python3 - "$NEWDIR/level.dat" "$NS" <<'PY'
import sys, pathlib
p, ns = pathlib.Path(sys.argv[1]), int(sys.argv[2])
b = bytearray(p.read_bytes())
pat = b"\x04" + (10).to_bytes(2, "little") + b"RandomSeed"
hits = [i for i in range(len(b) - len(pat)) if b[i:i+len(pat)] == pat]
if len(hits) != 1:
    print(f"SKIP(RandomSeed={len(hits)})"); sys.exit(0)
o = hits[0] + len(pat)
old = int.from_bytes(b[o:o+8], "little", signed=True)
b[o:o+8] = (ns & (2**64-1)).to_bytes(8, "little")
p.write_bytes(bytes(b))
print(f"{old}→{ns}")
PY
)
  echo "  seed: $SEEDOUT"
  [ "$SEEDARG" != "random" ] || true
  sed -i "s/^level-seed=.*/level-seed=$NS/" $BDS/server.properties
  grep -q '^level-seed=' $BDS/server.properties || echo "level-seed=$NS" >> $BDS/server.properties
fi

sed -i "s/^level-name=.*/level-name=$NEW/" $BDS/server.properties
chown -R uhc:uhc "$NEWDIR" 2>/dev/null || true

echo; echo "-- تشغيل --"
systemctl start bds
sleep 55
L=$(journalctl -u bds --since '60 seconds ago' --no-pager -o cat)

echo; echo "════ التحقق ════"
chk() { printf '  %s %s\n' "$(printf '%s' "$L" | grep -qa "$1" && echo ✅ || echo ❌)" "$2"; }
chk 'Experiment'            "experiments مفعّلة (بدونها السكربتات ما تحمّل)"
chk 'UHC\] جاهز'            "UHC جاهز"
chk 'safespot.js جاهز'      "safespot"
chk 'gravelava.js جاهز'     "gravelava"
chk 'perf.js جاهز'          "perf"
chk 'bridge: server-net'    "الجسر"
printf '  %s العالم = %s\n' "$(grep -q "^level-name=$NEW$" $BDS/server.properties && echo ✅ || echo ❌)" "$NEW"
echo
printf '%s\n' "$L" | grep -aiE 'Experiment|UHC\] init|Error|SyntaxError|not defined|could not load' | tail -12

echo; echo "أخطاء التشغيلة: $(printf '%s\n' "$L" | grep -aciE 'SyntaxError|ReferenceError|TypeError|not defined|could not load')"
echo "الجسر: $(curl -sS --max-time 5 http://127.0.0.1:8765/uhc/health || echo مقطوع)"
echo
echo "للرجوع للعالم القديم:"
echo "  sed -i 's/^level-name=.*/level-name=$OLD/' $BDS/server.properties && systemctl restart bds"
