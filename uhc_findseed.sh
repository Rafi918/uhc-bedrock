#!/bin/bash
# يجرّب سيدات ويفحص المركز │ ما يحذف شي │ يوقف عند أول يابسة
set -uo pipefail
BDS=/opt/bds
TRIES=${1:-5}
OLD=$(grep -E '^level-name=' $BDS/server.properties | cut -d= -f2- | tr -d '\r')
TPL="$BDS/worlds/$OLD"
LOG=/root/seedhunt_$(date +%H%M%S).txt

[ -f "$TPL/level.dat" ] || { echo "ماكو level.dat بـ$TPL"; exit 1; }
echo "القالب: $OLD │ محاولات: $TRIES │ السجل: $LOG"
read -rp "نكمل؟ [yes]: " a
[ "$a" = yes ] || exit 1

seedpatch() {
  python3 - "$1" "$2" <<'PY'
import sys, pathlib
p, ns = pathlib.Path(sys.argv[1]), int(sys.argv[2])
b = bytearray(p.read_bytes())
pat = b"\x04" + (10).to_bytes(2, "little") + b"RandomSeed"
h = [i for i in range(len(b) - len(pat)) if b[i:i+len(pat)] == pat]
if len(h) != 1:
    print("SKIP")
else:
    o = h[0] + len(pat)
    b[o:o+8] = (ns & (2**64 - 1)).to_bytes(8, "little")
    p.write_bytes(bytes(b))
    print("OK")
PY
}

KEEP=""
KEEPSEED=""
for i in $(seq 1 "$TRIES"); do
  NEW="uhc_try${i}_$(date +%H%M%S)"
  NDIR="$BDS/worlds/$NEW"
  NS=$(( (RANDOM << 48) ^ (RANDOM << 32) ^ (RANDOM << 16) ^ RANDOM ))
  echo
  echo "── $i/$TRIES │ $NEW │ seed=$NS"

  systemctl stop bds
  sleep 2
  mkdir -p "$NDIR"
  cp -a "$TPL/level.dat" "$NDIR/level.dat"
  printf '%s' "$NEW" > "$NDIR/levelname.txt"
  for f in world_behavior_packs.json world_resource_packs.json; do
    [ -f "$TPL/$f" ] && cp -a "$TPL/$f" "$NDIR/"
  done

  if [ "$(seedpatch "$NDIR/level.dat" "$NS")" != OK ]; then
    echo "  ما كدرنا نبدّل السيد — وقفنا"
    rm -rf "$NDIR"
    break
  fi

  sed -i "s/^level-name=.*/level-name=$NEW/" $BDS/server.properties
  chown -R uhc:uhc "$NDIR" 2>/dev/null || true
  systemctl start bds
  sleep 72

  V=$(journalctl -u bds --since '78 seconds ago' --no-pager -o cat \
      | grep -a 'SPAWN VERDICT' | tail -1)
  journalctl -u bds --since '78 seconds ago' --no-pager -o cat \
    | grep -a 'SPAWN ' | sed 's/^.*\[UHC\] /  /' | tee -a "$LOG"
  printf '%s │ %s │ %s\n' "$NEW" "$NS" "${V:-ماكو نتيجة}" >> "$LOG"

  if printf '%s' "$V" | grep -qa 'المركز=يابسة'; then
    echo "  ✅ مقبول"
    KEEP="$NEW"
    KEEPSEED="$NS"
    break
  fi
  echo "  ✗ $(printf '%s' "$V" | grep -oa 'المركز=[^ ]*' || echo 'ماكو نتيجة')"
done

echo
if [ -n "$KEEP" ]; then
  systemctl stop bds
  sleep 2
  sed -i "s/^level-name=.*/level-name=$KEEP/" $BDS/server.properties
  if grep -q '^level-seed=' $BDS/server.properties; then
    sed -i "s/^level-seed=.*/level-seed=$KEEPSEED/" $BDS/server.properties
  else
    echo "level-seed=$KEEPSEED" >> $BDS/server.properties
  fi
  systemctl start bds
  sleep 50
  echo "✅ العالم: $KEEP │ seed=$KEEPSEED"
else
  systemctl stop bds
  sleep 2
  sed -i "s/^level-name=.*/level-name=$OLD/" $BDS/server.properties
  systemctl start bds
  sleep 50
  echo "✗ ماكو مركز يابسة بـ$TRIES محاولات — رجعنا $OLD"
fi

journalctl -u bds --since '55 seconds ago' --no-pager -o cat \
  | grep -aiE 'Experiment|UHC\] init|SPAWN VERDICT|Error|not defined' | tail -8
echo
grep -E '^(level-name|level-seed)=' $BDS/server.properties
echo
echo "السجل: $LOG"
echo "العوالم المجرَّبة تبقى بـ$BDS/worlds — امسح المرفوضة يدوي:"
ls -d $BDS/worlds/uhc_try* 2>/dev/null || true
