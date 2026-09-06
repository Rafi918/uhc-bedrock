// ============================================================================
//  UHC Core - الإعدادات العامة
//  ✏️ عدّل: apiKey (لازم يطابق UHC_API_KEY مالة البوت)
//  البوت والسيرفر بنفس الجهاز → botUrl يبقى 127.0.0.1
// ============================================================================
export const CONFIG = {
  // ---------- الجسر ----------
  bridgeEnabled: true,
  botUrl: "http://127.0.0.1:8765",
  apiKey: "b3U6vbjKfpixkfmzMVaIbWttrb9lc2jk",   // ← لازم يطابق UHC_API_KEY بملف .env
  httpTimeoutSeconds: 5,           // server-net يحسبها ثواني
  pollTicks: 40,                   // سؤال البوت (ثانيتين — محلي فرخيص)
  reportTicks: 100,                // دز التقارير (5 ثواني)
  reportQueueCap: 60,
  bridgeMaxBackoffTicks: 200,
  borderTickTicks: 20,
  phaseTickTicks: 20,
  saveFlushTicks: 100,
  spectateCheckTicks: 10,
  antiLagIntervalTicks: 1200,      // مرة كل دقيقة — أكثر من كافي

  // ---------- البوردر ----------
  minBorderHalf: 40,
  netherScale: 8,
  damageOutsideBorder: 2,
  borderWarningDistance: 40,
  // ── سهم البوردر: نسبي لاتجاه نظر اللاعب (↑ قدام، → يمين …)
  //    لو طلعت مربعات فارغة، بدّل بهذي:
  //    ["قدام","قدام يمين","يمين","ورا يمين","ورا","ورا يسار","يسار","قدام يسار"]
  borderArrows: ["↑","↗","→","↘","↓","↙","←","↖"],
  borderCornerBlocks: 100,
  borderTiers: [
    { at: 30,   c: "§4", w: "خطر شديد" },
    { at: 80,   c: "§c", w: "خطر" },
    { at: 200,  c: "§6", w: "تحذير" },
    { at: 500,  c: "§e", w: "قريب" },
    { at: 1500, c: "§a", w: "مرتاح" },
    { at: 9e9,  c: "§b", w: "آمن" },
  ],
  // سماح الخروج: أول borderGraceLenientMinutes دقيقة، الخروج ما يضر إلا بعد
  // borderGraceSeconds ثانية. الرجوع للداخل borderGraceRearmSeconds يرجّع السماح.
  borderGraceSeconds: 15,
  returnBorderMargin: 24,   // هامش داخل البوردر عند الرجعة
  borderGraceLenientMinutes: 90,
  borderGraceRearmSeconds: 30,
  hudEnabled: true,
  scoreboardObjective: "uhc_hud",

  // ---------- السور المرئي ----------
  wallEnabled: true,
  wallViewDistance: 64,
  wallNearDistance: 40,
  wallHalfWidth: 20,
  wallStepX: 4,
  wallBelow: 4,
  wallAbove: 12,
  wallStepY: 5,
  wallPillarSpacing: 8,
  wallPillarHeight: 16,
  wallPillarStep: 4,
  particleBudgetPerPlayer: 90,
  borderParticle: "minecraft:basic_flame_particle",
  // النذر: اللهب يضيع بالضباب الأحمر → جزيء أبيض، ومدى بالبلوكات المحلية
  borderParticleNether: "minecraft:endrod",
  netherWallViewDistance: 48,
  netherWallNearDistance: 20,

  // ---------- الرجعة والسبكتيت ----------
  respawnKeepInventory: false,
  respawnProtectSeconds: 6,
  immediateRespawn: true,
  spectateLockEnabled: false,
  spectateLockDistance: 14,
  offlineEliminateMinutes: 20,
  combatLogSeconds: 15,            // يقطع وهو بقتال → استبعاد فوري (0 = مطفي)
  winCheckEnabled: true,
  endedAutoLobbyMinutes: 2,        // بعد النهاية يرجع للوبي تلقائياً
  releaseAfterEndTicks: 100,       // يرجّع الكل سيرفايفل بعد النهاية

  // ---------- التوزيع ----------
  scatterMargin: 300,
  scatterMinDistance: 350,         // سقف — ينزل تلقائياً لو الخريطة صغيرة
  scatterRounds: 8,
  scatterCandidateTries: 300,
  scatterLoadWaitTicks: 40,
  scatterRetryExtraTicks: 40,      // فشل أول = انتظار زيادة بنفس النقطة
  scatterLiftY: 250,
  scatterSpreadRadius: 2.5,
  scatterMaxSeconds: 90,           // سقف أمان لكل العملية
  teamNameColors: ["§c", "§9", "§a", "§e", "§d", "§6", "§b", "§5", "§2", "§7"],

  // ---------- العدّاد التنازلي ----------
  countdownMarks: [30, 10, 5, 3, 2, 1],

  // ---------- الأصوات ----------
  soundEnabled: true,
  soundNearBorderEnabled: true,
  soundNearBorder: "note.pling",
  soundNearBorderTicks: 60,
  soundOutside: "note.bassattack",
  soundOutsideTicks: 20,
  soundShrinkStart: "ambient.weather.thunder",
  soundShrinkEnd: "random.orb",
  soundGraceEnd: "mob.enderdragon.growl",
  soundGameStart: "ui.toast_challenge_complete",
  soundDeath: "mob.wither.death",
  soundRespawn: "random.totem",
  soundFinalDeath: "mob.enderdragon.death",
  soundWin: "ui.toast_challenge_complete",
  soundCountdown: "note.hat",

  // ---------- مضاد اللاج (مخفف — السيرفر قوي) ----------
  antiLagDimensions: ["overworld", "nether", "the_end"],
  itemCap: 400,
  itemMinAgeMs: 120000,
  itemWhitelist: [
    "minecraft:diamond", "minecraft:diamond_block", "minecraft:netherite_ingot",
    "minecraft:netherite_scrap", "minecraft:ancient_debris", "minecraft:gold_ingot",
    "minecraft:gold_block", "minecraft:golden_apple", "minecraft:enchanted_golden_apple",
    "minecraft:totem_of_undying", "minecraft:elytra", "minecraft:enchanted_book",
    "minecraft:nether_star", "minecraft:emerald", "minecraft:experience_bottle",
  ],
  xpOrbCap: 300,
  xpOrbMinAgeMs: 30000,            // 🔧 كانت تنمسح بلا أي فلتر
  projectileCap: 300,
  projectileStuckSpeed: 0.02,
  projectileMinAgeMs: 10000,
  monsterClusterRadius: 8,
  monsterClusterCap: 50,
  mobKeepNearPlayer: 32,           // ما نلمس تكدس فيه لاعب قريب (لوته)

  // ---------- العربي ----------
  arabicEnabled: true,
  // ---------- السبكتيت المقفل (مضاد الغش) ----------
  spectateLeashDistance: 14,
  spectateBoxHeight: 320,
  spectateBoxRadius: 22,
  // ---------- الرجعة الآمنة ----------
  respawnSearchRadius: 64,
  respawnBuildBox: false,
  platformBlock: "minecraft:stone",

  // ---------- التوزيع بحلقة قرب البوردر ----------
  scatterRingFactor: 0.85,     // 0.85 = الفرق على 85% من نصف القطر (قرب الحد)
  scatterRingJitter: 0.05,
  scatterRingAttempts: 7,
  // ---------- الرجعة ----------
  respawnKeepItems: false,      // يرجّع العدة خلال نافذة الرجعة
  respawnRecoverDrops: false,   // احتياطي: يلقط الأيتمات الطايحة ويرجعها
  respawnChunkWaitTicks: 30,
  respawnBuildBox: false,
  platformBlock: "minecraft:stone",
  respawnSearchRadius: 64,

  // ---------- جدول الانكماش التلقائي ----------
  //  restMinutes = يستريح شقد قبل يبدي │ toHalf = ينكمش لوين │ minutes = مدة الانكماش
  autoShrinkPlan: true,
  shrinkPlan: [
    { rest: 0, minutes: 50, amount: 1500 },
    { rest: 0, minutes: 60, amount: 2500 },
    { rest: 0, minutes: 60, amount: 3000 },
  ],
  // ---------- القبر ----------
  graveEnabled: false,
  graveBlock: "minecraft:chest",
  graveMinY: 45,               // موت أعمق من هيك → القبر يرتفع للسطح (مضاد غش)
  graveSurfaceIfDeep: false,
  graveCaptureRadius: 6,
  // ---------- غرفة الخارجين (بدل السبكتيت) ----------
  losersRoomEnabled: true,
  losersRoomY: 300,
  losersRoomRadius: 6,
  losersGameMode: "adventure",
  showCoordinates: true,
  scatterMinFactor: 0.85,
  scatterMaxFactor: 0.9,
  // ---------- غرفة الخارجين ----------
  losersRoomY: 300,
  losersRoomRadius: 6,
  losersGameMode: "adventure",
  // ---------- الرجعة لمكان الموت (مود القبر يتولى العدة) ----------
  returnRadius: 10,

  // ---------- توافق مود القبر ----------
  graveWaitTicks: 45,        // ننتظر المود يحط القبر قبل ما ننقل اللاعب
  returnRadius: 10,          // نرجعه اقرب ما يمكن للقبر
  buildOnUnsafe: false,      // ممنوع نبني — البناء كان يغطي القبر
  quietRespawn: true,        // ماكو رسائل مننا، رسالة المود تكفي

  // ---------- مضاد الغش ----------
  antiCheat: true,
  acMinBlocks: 1200,
  acDiamondRatio: 220,       // ألماسة لكل اقل من هذا العدد = شبهة
  acDebrisRatio: 400,
  acGoldRatio: 90,
  acReachBlocks: 6.2,        // ضرب من مسافة اكبر = ريتش
  acNukerPerSec: 14,         // بلوكات بالثانية
  acReportCooldownMs: 120000,
  acAuditIntervalTicks: 1200,
  acDiamondCap: 40,          // اكثر من هيك بجيب لاعب واحد = مشبوه
  endEnabled: false,
  endMinutes: 0,
  netherMinutes: 90,
  netherWarnMinutes: 20,
  // تحذيرات النذر بالثواني المتبقية: 30د، 20د، 10د، 5د، 3د، 1د، 30ث، 10ث
  netherWarnMarks: [1800, 1200, 600, 300, 180, 60, 30, 10],
  chatLockedDefault: true,
  losersRoomOffset: 4000,
  rejoinPullMaxMinutes: 120,
  rejoinGraceSeconds: 12,
  rejoinPullInside: true,
  acDupeMinedMultiplier: 10,
  acBuriedEnabled: false,
  acXrayRatio: 120,
};
