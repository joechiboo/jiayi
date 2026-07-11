#!/usr/bin/env node
"use strict";
/*
 * 平衡驗證腳本：headless 重跑 index.html 的確定性戰鬥模擬，大量對局統計勝率。
 *
 * 用法：
 *   node tools/balance.js                # 全部陀螺互打，每組 2000 場
 *   node tools/balance.js --n 5000       # 每組場數
 *   node tools/balance.js --arena ice    # 只跑特定場地
 *
 * TOPS / ARENAS / BEATS 是從 index.html 即時抽出來的，調參不用改這裡。
 * 但物理公式（update 內容）是手動複製的 —— 如果改了 index.html 的戰鬥公式，
 * 這裡要跟著同步（對照 index.html 的 update()、makeTop()、applyQte()）。
 */
const fs = require("fs");
const path = require("path");

/* ---------- 從 index.html 抽資料 ---------- */
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function extract(name) {
  const m = html.match(new RegExp("const " + name + "\\s*=\\s*([\\s\\S]*?);\\r?\\n"));
  if (!m) throw new Error("index.html 找不到 const " + name);
  return eval("(" + m[1] + ")");
}
const TOPS = extract("TOPS");
const ORDER = extract("ORDER");
const BEATS = extract("BEATS");
const ARENAS = extract("ARENAS");
const ARENA_KEYS = extract("ARENA_KEYS");

/* ---------- 與遊戲相同的常數 / 工具 ---------- */
const STEP = 1 / 120, TOP_R = 24;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function elemMul(a, b) { if (BEATS[a] === b) return 1.45; if (BEATS[b] === a) return 0.7; return 1; }

/* ---------- 玩家輸入模型 ----------
 * 發射力道與 QTE 準度都來自小遊戲按鍵時機，這裡用均勻分布的 off 模擬
 * （雙方同分布，對勝率矩陣公平）。公式與 index.html 的 startTiming/settleQte 相同。 */
function samplePower(irng) { return 0.55 + 0.45 * Math.pow(1 - irng(), 1.7); }
function sampleQteAcc(irng) { return Math.round(Math.pow(1 - irng(), 1.6) * 100) / 100; }

/* ---------- 單場模擬 ---------- */
function simulate(keyA, keyB, seed, arenaKey) {
  const arena = ARENAS[arenaKey || ARENA_KEYS[(seed || 1) % ARENA_KEYS.length]];
  const rng = mulberry32((seed || 1) >>> 0);
  // 玩家輸入用獨立亂數流（實機上輸入來自人手，不吃模擬 rng）
  const irng = mulberry32(((seed || 1) ^ 0x9e3779b9) >>> 0);
  const powers = [samplePower(irng), samplePower(irng)];
  const dirs = [irng() < 0.5 ? -1 : 1, irng() < 0.5 ? -1 : 1];
  const qteAccs = [sampleQteAcc(irng), sampleQteAcc(irng)];

  // 對應 sparkFx/burstFx：每顆火花消耗 3 次 rng（角度、速度、壽命），保持亂數序列一致
  const fx = n => { for (let i = 0; i < n; i++) { rng(); rng(); rng(); } };

  const picks = [keyA, keyB];
  function makeTop(i) {
    const cfg = TOPS[picks[i]];
    return {
      i, key: picks[i], cfg,
      x: (i === 0 ? -1 : 1) * 95, y: (i === 0 ? -1 : 1) * 20,
      vx: 0, vy: 0,
      rpm: 4000 + 4200 * powers[i],
      maxRpm: 4000 + 4200 * powers[i],
      burst: 0, angle: rng() * 6.28, dir: dirs[i] === -1 ? -1 : 1,
      alive: true, reason: "", dashT: 1.2 + rng(),
      ultAtk: 1, ultDef: 1, ultUntil: -1,
      hitCd: 0
    };
  }
  const tops = [makeTop(0), makeTop(1)];
  let battleTime = 0, qteDone = false, battleOver = false;

  function update(dt) {
    // 必殺時機 QTE（本機/連線由玩家按時機條，這裡直接套用取樣準度）
    if (!qteDone && battleTime > 3) {
      const [qa, qb] = tops;
      if (qa.alive && qb.alive) {
        const qdx = qb.x - qa.x, qdy = qb.y - qa.y, qd = Math.hypot(qdx, qdy) || 1;
        const closing = -((qb.vx - qa.vx) * qdx + (qb.vy - qa.vy) * qdy) / qd;
        const need = battleTime > 14 ? 4 : (battleTime > 10 ? 12 : (battleTime > 7 ? 25 : 70));
        if ((qd < TOP_R * 2 + 46 && closing > need) || battleTime > 16) {
          qteDone = true;
          tops.forEach((t, i) => {
            const q = Math.max(0, Math.min(1, qteAccs[i] || 0));
            t.ultAtk = 1 + 1.6 * q;
            t.ultDef = 1 + 1.1 * q;
            t.ultUntil = battleTime + 4;
          });
          const [ua, ub] = tops;
          if (ua.alive && ub.alive) {
            const ddx = ub.x - ua.x, ddy = ub.y - ua.y, dd = Math.hypot(ddx, ddy) || 1;
            ua.vx += ddx / dd * 110; ua.vy += ddy / dd * 110;
            ub.vx -= ddx / dd * 110; ub.vy -= ddy / dd * 110;
          }
          return;
        }
      }
    }
    for (const t of tops) {
      if (!t.alive) continue;
      const c = t.cfg;
      const sudden = battleTime > 22 ? 1 + (battleTime - 22) * 0.65 : 1;
      t.rpm -= (140 + t.rpm * 0.02) * c.decay * arena.decayMul * sudden * dt;
      const k = 1.6 * c.center;
      t.vx += -t.x * k * dt; t.vy += -t.y * k * dt;
      if (arena.hill) {
        const dh = Math.hypot(t.x, t.y) || 1;
        if (dh < 70) {
          const push = (1 - dh / 70) * arena.hill;
          t.vx += t.x / dh * push * dt; t.vy += t.y / dh * push * dt;
        }
      }
      const d0 = Math.hypot(t.x, t.y) || 1;
      const orb = c.orbit * (t.rpm / 8200);
      t.vx += (-t.y / d0) * orb * t.dir * dt; t.vy += (t.x / d0) * orb * t.dir * dt;
      const wild = Math.pow(t.rpm / 8200, 2) * c.jitter;
      const ang = rng() * 6.283;
      t.vx += Math.cos(ang) * wild * dt; t.vy += Math.sin(ang) * wild * dt;
      if (c.dash) {
        t.dashT -= dt;
        const foe = tops[1 - t.i];
        if (t.dashT <= 0 && foe.alive) {
          const dx = foe.x - t.x, dy = foe.y - t.y, d = Math.hypot(dx, dy) || 1;
          const pow = 110 * (0.6 + t.rpm / 8200);
          t.vx += dx / d * pow; t.vy += dy / d * pow;
          t.dashT = 0.9 + rng() * 1.1;
        }
      }
      const damp = Math.exp(-arena.damp * dt);
      t.vx *= damp; t.vy *= damp;
      t.x += t.vx * dt; t.y += t.vy * dt;
      t.angle += t.rpm * 0.004 * dt * 6.283 * t.dir;
      t.hitCd = Math.max(0, t.hitCd - dt);
      const d = Math.hypot(t.x, t.y);
      if (d > arena.R - TOP_R) {
        const nx = t.x / d, ny = t.y / d;
        const vr = t.vx * nx + t.vy * ny;
        const escape = 95 - 45 * (t.rpm / 8200) + arena.escapeAdd + Math.max(0, 40 * (1 - battleTime / 8));
        if (vr > escape) {
          t.alive = false; t.reason = "out";
          fx(14);
        } else {
          t.x = nx * (arena.R - TOP_R); t.y = ny * (arena.R - TOP_R);
          t.vx -= 1.6 * vr * nx; t.vy -= 1.6 * vr * ny;
          t.vx *= 0.7; t.vy *= 0.7;
          if (vr > 25) fx(4);
        }
      }
      if (t.rpm <= 280) { t.rpm = 0; t.alive = false; t.reason = "stop"; }
    }
    const [a, b] = tops;
    if (a.alive && b.alive) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < TOP_R * 2 && a.hitCd <= 0) {
        a.hitCd = b.hitCd = 0.16;
        const nx = dx / (d || 1), ny = dy / (d || 1);
        const overlap = TOP_R * 2 - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const rel = Math.abs((b.vx - a.vx) * nx + (b.vy - a.vy) * ny);
        const ultOn = t => battleTime < t.ultUntil;
        const uAtkA = ultOn(a) ? a.ultAtk : 1, uAtkB = ultOn(b) ? b.ultAtk : 1;
        const uDefA = ultOn(a) ? a.ultDef : 1, uDefB = ultOn(b) ? b.ultDef : 1;
        const ramp = Math.min(1, 0.35 + battleTime * 0.1);
        const dmgTo = (atkT, defT, ua, ud) => {
          const base = 12 + rel * 1.9;
          const ratio = Math.pow(atkT.rpm / Math.max(defT.rpm, 300), 0.55);
          return base * ramp * atkT.cfg.atk * ua / (defT.cfg.def * ud) * elemMul(atkT.key, defT.key) * ratio;
        };
        const dA = dmgTo(b, a, uAtkB, uDefA), dB = dmgTo(a, b, uAtkA, uDefB);
        a.rpm -= dA; b.rpm -= dB;
        const relScale = Math.min(1, rel / 80);
        a.burst += Math.min(uAtkB > 1.5 ? 45 : 24, dA * 0.13 * relScale) / a.cfg.burstRes;
        b.burst += Math.min(uAtkA > 1.5 ? 45 : 24, dB * 0.13 * relScale) / b.cfg.burstRes;
        if (rel > 120 && a.rpm > 5200 && b.rpm > 5200) {
          a.burst += 14 / a.cfg.burstRes; b.burst += 14 / b.cfg.burstRes;
        }
        const kb = (rel * 0.55 + 45);
        const kbA = Math.min(uAtkB > 1.5 ? 260 : 170, kb * b.cfg.atk * uAtkB);
        const kbB = Math.min(uAtkA > 1.5 ? 260 : 170, kb * a.cfg.atk * uAtkA);
        a.vx -= nx * kbA; a.vy -= ny * kbA;
        b.vx += nx * kbB; b.vy += ny * kbB;
        fx(8 + Math.min(10, rel * 0.06));
        if (uAtkA > 1.5 || uAtkB > 1.5) fx(12);
        if (a.ultUntil > 0 || b.ultUntil > 0) a.ultUntil = b.ultUntil = -1;
        if (a.dir !== b.dir) {
          a.rpm = Math.min(a.maxRpm, a.rpm + dB * 0.18);
          b.rpm = Math.min(b.maxRpm, b.rpm + dA * 0.18);
        }
        for (const t of [a, b]) {
          if (t.burst >= 100 && t.alive) {
            t.alive = false; t.reason = "burst";
            fx(30);
          }
        }
      }
    }
    if (!battleOver && (!a.alive || !b.alive)) battleOver = true;
  }

  while (!battleOver && battleTime < 60) {
    battleTime += STEP;
    update(STEP);
  }
  const [a, b] = tops;
  let winner = null;
  if (a.alive && !b.alive) winner = 0;
  else if (b.alive && !a.alive) winner = 1;
  return { winner, reasons: [a.reason, b.reason], time: battleTime };
}

/* ---------- 統計 ---------- */
function pct(x, n) { return (100 * x / n).toFixed(1).padStart(5) + "%"; }

function run(opts) {
  const N = opts.n, keys = opts.keys, arenaKey = opts.arena || null;
  // matchup[a][b] = a 當 1P、b 當 2P 的統計
  const matchup = {};
  for (const a of keys) {
    matchup[a] = {};
    for (const b of keys) {
      const st = { w0: 0, w1: 0, draw: 0, time: 0, loseReason: { out: 0, stop: 0, burst: 0, both: 0 } };
      for (let k = 0; k < N; k++) {
        const seed = opts.seed0 + k * 7919 + 1; // 大步距避免相鄰 seed 相關
        const r = simulate(a, b, seed, arenaKey);
        st.time += r.time;
        if (r.winner === 0) { st.w0++; st.loseReason[r.reasons[1]]++; }
        else if (r.winner === 1) { st.w1++; st.loseReason[r.reasons[0]]++; }
        else { st.draw++; st.loseReason.both++; }
      }
      matchup[a][b] = st;
    }
  }

  const title = k => TOPS[k].emoji + TOPS[k].name;
  console.log("每組場數: " + N + (arenaKey ? "　場地: " + ARENAS[arenaKey].name : "　場地: 依種子輪替（同實機）"));
  console.log("");

  // 對戰矩陣（列=該陀螺的勝率，已平均 1P/2P 兩個方向消除位置偏差）
  console.log("=== 勝率矩陣（列 vs 欄，平均雙邊位置） ===");
  const colW = 16;
  console.log("".padEnd(colW) + keys.map(k => title(k).padEnd(colW)).join(""));
  for (const a of keys) {
    let row = title(a).padEnd(colW);
    for (const b of keys) {
      const s1 = matchup[a][b], s2 = matchup[b][a];
      const wins = s1.w0 + s2.w1, total = 2 * N;
      const draws = s1.draw + s2.draw;
      row += (pct(wins, total) + " (和" + (100 * draws / total).toFixed(1) + "%)").padEnd(colW);
    }
    console.log(row);
  }
  console.log("");

  // 每顆總體勝率（對所有不同對手）
  console.log("=== 總體勝率（不含鏡像） ===");
  for (const a of keys) {
    let w = 0, t = 0, d = 0, dur = 0;
    for (const b of keys) {
      if (b === a) continue;
      w += matchup[a][b].w0 + matchup[b][a].w1;
      d += matchup[a][b].draw + matchup[b][a].draw;
      dur += matchup[a][b].time + matchup[b][a].time;
      t += 2 * N;
    }
    console.log(title(a).padEnd(colW) + "勝率 " + pct(w, t) + "　和局 " + pct(d, t) + "　平均戰局 " + (dur / t).toFixed(1) + "s");
  }
  console.log("");

  // 鏡像對局：檢查位置偏差與同歸於盡率
  console.log("=== 鏡像對局（同陀螺互打） ===");
  for (const a of keys) {
    const s = matchup[a][a];
    console.log(title(a).padEnd(colW) + "1P勝 " + pct(s.w0, N) + "　2P勝 " + pct(s.w1, N) + "　和局 " + pct(s.draw, N) + "　平均 " + (s.time / N).toFixed(1) + "s");
  }
  console.log("");

  // 敗因分布
  console.log("=== 敗因分布（全部對局合計） ===");
  const agg = { out: 0, stop: 0, burst: 0, both: 0 };
  let tot = 0;
  for (const a of keys) for (const b of keys) {
    const lr = matchup[a][b].loseReason;
    for (const k in agg) agg[k] += lr[k];
    tot += N;
  }
  console.log("出界 " + pct(agg.out, tot) + "　停轉 " + pct(agg.stop, tot) + "　爆體 " + pct(agg.burst, tot) + "　同歸於盡 " + pct(agg.both, tot));
}

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : def;
}
const opts = {
  n: parseInt(arg("n", "2000"), 10),
  seed0: parseInt(arg("seed0", "1"), 10),
  arena: arg("arena", null),
  keys: (arg("tops", null) || ORDER.join(",")).split(","),
};
for (const k of opts.keys) if (!TOPS[k]) { console.error("未知陀螺: " + k); process.exit(1); }
if (opts.arena && !ARENAS[opts.arena]) { console.error("未知場地: " + opts.arena); process.exit(1); }
run(opts);