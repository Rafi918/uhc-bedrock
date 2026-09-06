#!/bin/bash
# قياس علمي: ثريد التكة مال BDS بالدلتا (مو متوسط عمر العملية) → CSV + ملخص
set -u
DUR=${1:-60}
OUT=${2:-/root/lag_$(date +%Y%m%d_%H%M%S).csv}
HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)
PID=$(pgrep -f '[b]edrock_server' | head -1)
[ -n "${PID:-}" ] || { echo "✖ ماكو bedrock_server شغال"; exit 1; }

TICK=""
for d in /proc/$PID/task/*; do
  case "$(cat "$d/comm" 2>/dev/null)" in MC_SERV*) TICK=$(basename "$d"); break;; esac
done
[ -n "$TICK" ] || TICK=$(ps -L -o tid=,pcpu= -p "$PID" | sort -k2 -nr | head -1 | awk '{print $1}')

j() { awk '{print $14+$15}' "/proc/$PID/task/$TICK/stat" 2>/dev/null || echo 0; }
a() { awk '{print $14+$15}' "/proc/$PID/stat" 2>/dev/null || echo 0; }
pc() { awk -v x="$2" -v y="$1" -v h="$HZ" 'BEGIN{printf "%.1f",(x-y)*100/h}'; }

echo "PID=$PID │ ثريد التكة=$TICK │ HZ=$HZ │ المدة=${DUR}ث"
START=$(date '+%Y-%m-%d %H:%M:%S')
echo "time,tick_cpu_pct,proc_cpu_pct,rss_mb,threads" > "$OUT"
t0=$(j); p0=$(a)
for _ in $(seq 1 "$DUR"); do
  sleep 1
  t1=$(j); p1=$(a)
  printf '%s,%s,%s,%s,%s\n' "$(date +%H:%M:%S)" "$(pc "$t0" "$t1")" "$(pc "$p0" "$p1")" \
    "$(awk '/^VmRSS/{print int($2/1024)}' /proc/$PID/status 2>/dev/null || echo 0)" \
    "$(ls /proc/$PID/task 2>/dev/null | wc -l)" >> "$OUT"
  t0=$t1; p0=$p1
done

echo; echo "════ ثريد التكة (النسبة من كور واحد) ════"
awk -F, 'NR>1{n++;s+=$2;if($2>mx)mx=$2;if($2>=70)h++}
END{ if(!n){print "  ماكو بيانات";exit}
     printf "  متوسط %.1f%%   أقصى %.1f%%   قمم فوق 70%%: %d من %d\n", s/n, mx, h+0, n;
     if (mx>=95) print "  ⛔ الثريد مشبوع — لاق حقيقي بالتكة";
     else if (h+0>0) print "  ⚠ قمم ضغط — اللاق متقطع";
     else print "  ✅ ثريد التكة مرتاح — اللاق مو من CPU مال السكربتات" }' "$OUT"

echo; echo "════ TPS من اللوق (لازم /scriptevent uhc:tpslog 5) ════"
journalctl -u bds --since "$START" --no-pager -o cat 2>/dev/null \
  | grep -a 'PERF tps=' | tail -20 || echo "  ماكو أسطر PERF"
echo; echo "CSV: $OUT"
