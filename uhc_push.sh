#!/bin/bash
# يعيد بناء شجرة الريبو من الملفات الحية + يرفع │ يوقف لو حاجز الأسرار رفض
set -uo pipefail
REPO=/root/uhc_repo
MSG=${1:-"تحديث $(date '+%F %H:%M')"}

python3 /root/mkrepo.py || { echo "✖ البناء فشل (حاجز الأسرار) — ماكو رفع"; exit 1; }

cd "$REPO" || exit 1
if [ ! -d .git ]; then
  git init -b main
  git config user.name  rafi
  git config user.email rafi@example.com
fi
git add -A
if git diff --cached --quiet; then
  echo "ماكو تغييرات — الريبو مطابق للملفات الحية"
else
  git commit -q -m "$MSG"
fi
echo; git log --oneline -3; echo
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main && echo "✔ انرفع لـ$(git remote get-url origin)"
else
  echo "ماكو origin. أضفه:"
  echo "  git remote add origin https://github.com/<اسمك>/uhc-bedrock.git"
  echo "  git push -u origin main      # الباسورد = Personal Access Token"
fi
