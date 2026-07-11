"use strict";
/*
 * 無頭戰鬥模擬：從 ../index.html 抽出遊戲程式碼，在 node vm 裡大量跑戰鬥，
 * 統計各「場地 × 陀螺組合」的戰鬥長度、必殺(QTE)觸發率與死因分布。
 *
 * 用法： node beyblade/tools/bb-sim.js
 * 調平衡流程：改 index.html 的參數 → 重跑本工具 → 對照 BALANCE.md 的目標值
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];

function makeCtx() {
  const ctx = {
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    performance: { now: () => 0 },
    location: { hostname: "sim" },
    window: { scrollTo: () => {} },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    Math, JSON, Number, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

const driver = `
function runOne(pa, pb, da, db, powA, powB, seed, useUlt, arenaKey){
  arena=ARENAS[arenaKey||"bowl"];
  online=false; picks=[pa,pb]; dirs=[da,db]; powers=[powA,powB];
  rng=mulberry32(seed>>>0);
  tops=[makeTop(0),makeTop(1)];
  sparks=[]; floatTexts=[]; battleOver=false; battleTime=0;
  shake=0; slowmo=0; hitstop=0; flashT=0; suddenShown=false;
  qteDone=false; qteActive=false; pendingUltAccs=null;
  let qteAt=null;
  // 攔截 QTE：記錄時間並以「雙方都按到 0.8」的壓力情境直接套用
  triggerQTE=function(){
    qteDone=true; qteAt=battleTime;
    if(useUlt){
      tops.forEach(t=>{ t.ultAtk=1+1.6*0.8; t.ultDef=1+1.1*0.8; t.ultUntil=battleTime+4; });
      const [ua,ub]=tops;
      if(ua.alive&&ub.alive){
        const ddx=ub.x-ua.x, ddy=ub.y-ua.y, dd=Math.hypot(ddx,ddy)||1;
        ua.vx+=ddx/dd*60; ua.vy+=ddy/dd*60;
        ub.vx-=ddx/dd*60; ub.vy-=ddy/dd*60;
      }
    }
  };
  const STEPS=1/120;
  while(!battleOver && battleTime<45){
    battleTime+=STEPS;
    update(STEPS);
  }
  const [a,b]=tops;
  return {end:battleTime, qteAt, winner:a.alive&&!b.alive?0:(b.alive&&!a.alive?1:-1),
          reason:(a.alive?b:a).reason};
}
runOne`;

const ctx = makeCtx();
const runOne = vm.runInContext(driver, ctx);

// 從遊戲程式碼取得目前的陀螺清單，自動涵蓋新增角色
const order = vm.runInContext("ORDER", ctx);
const matchups = [];
for (let i = 0; i < order.length; i++)
  for (let j = i; j < order.length; j++) matchups.push([order[i], order[j]]);

const arenaKeys = vm.runInContext("ARENA_KEYS", ctx);
for (const ak of arenaKeys) {
  console.log("\n=== 場地: " + ak + " ===");
  console.log("組合           場數  中位長度  QTE觸發率  QTE中位時間  QTE後平均餘命  死因(stop/out/burst)  <5s場比例");
  for (const [pa, pb] of matchups) {
    const ends = [], qtes = [], lives = [];
    const reasons = { stop: 0, out: 0, burst: 0 };
    let trig = 0, n = 0, short = 0, winA = 0, winB = 0, draw = 0;
    for (let seed = 1; seed <= 120; seed++) {
      for (const [powA, powB] of [[0.9,0.7],[0.6,0.6],[1,1],[0.7,0.95]]) {
        const r = runOne(pa, pb, 1, seed%2? -1:1, powA, powB, seed*7919+13, true, ak);
        n++; ends.push(r.end);
        if (r.winner === 0) winA++; else if (r.winner === 1) winB++; else draw++;
        reasons[r.reason] = (reasons[r.reason] || 0) + 1;
        if (r.end < 5) short++;
        if (r.qteAt !== null) { trig++; qtes.push(r.qteAt); lives.push(r.end - r.qteAt); }
      }
    }
    const med = a => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.floor(s.length/2)].toFixed(1):"-"; };
    const avg = a => a.length? (a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):"-";
    console.log(
      (pa+" vs "+pb).padEnd(15), String(n).padStart(4),
      String(med(ends)).padStart(8)+"s", String((trig/n*100).toFixed(0)+"%").padStart(9),
      String(med(qtes)).padStart(10)+"s", String(avg(lives)).padStart(11)+"s",
      ("  "+(reasons.stop||0)+"/"+(reasons.out||0)+"/"+(reasons.burst||0)).padStart(18),
      String((short/n*100).toFixed(0)+"%").padStart(9),
      ("  勝 "+(winA/n*100).toFixed(0)+"/"+(winB/n*100).toFixed(0)+"/和"+(draw/n*100).toFixed(0)+"%")
    );
  }
}
