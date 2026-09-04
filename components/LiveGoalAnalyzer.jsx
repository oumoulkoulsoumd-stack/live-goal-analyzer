"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

// ============================================================
// LIVE GOAL ANALYZER — MVP
// Outil d'analyse statistique de matchs en direct.
// Ne prédit jamais un but avec certitude — voir page Méthodologie.
// ============================================================

const TEAM_PAIRS = [
  ["Manchester United", "Chelsea", "Premier League"],
  ["Real Madrid", "Valence", "LaLiga"],
  ["Arsenal", "Liverpool", "Premier League"],
  ["AC Milan", "Naples", "Serie A"],
  ["Lyon", "Marseille", "Ligue 1"],
  ["Porto", "Benfica", "Liga Portugal"],
];

// V2 — Tirs cadrés / xG / Corners sont désormais le cœur du moteur.
// Tirs totaux, possession et attaques dangereuses restent des facteurs
// complémentaires (affichés, utilisés pour les raisons) mais ne pèsent
// plus directement dans la somme pondérée principale.
const DEFAULT_WEIGHTS = {
  sot: 40,     // 🎯 tirs cadrés — indicateur principal
  xg: 30,      // ⚽ xG — indicateur principal
  corners: 20, // 🚩 corners — indicateur principal
  recent: 10,  // 📈 dynamique offensive récente (5/10/15 dernières minutes)
};

// Seuils utilisés pour détecter une convergence réelle (et pas un simple volume)
const CONVERGENCE_STRONG_SHARE = 60; // part minimale pour parler de "domination"
const CONVERGENCE_MIN_DIFF = { sot: 2, corners: 2, xg: 0.4 };
// Multiplicateur appliqué à l'écart par rapport à 50 selon le nombre
// d'indicateurs principaux (sur 3 : tirs cadrés, xG, corners) qui convergent
// réellement vers la même équipe. Peu de convergence => signal ramené vers
// la neutralité (évite les faux signaux du type "10 corners mais 1 tir cadré").
const CONVERGENCE_MULTIPLIER = { 0: 0.55, 1: 0.75, 2: 0.95, 3: 1.1 };

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function share(a, b) { const t = a + b; return t <= 0 ? 50 : clamp((a / t) * 100, 0, 100); }

const INDICATOR_LABELS = { sot: "tirs cadrés", xg: "xG", corners: "corners" };

// Convertit une charge utile brute de FootballDataService (déjà normalisée par
// l'adaptateur du fournisseur choisi) vers le format interne utilisé par le
// moteur. Toute statistique absente est listée dans `missing` — elle est
// exclue du calcul de pression, jamais inventée à une valeur par défaut.
function normalizeLiveMatch(raw) {
  const isMissing = (v) => v === null || v === undefined;
  const missing = [];
  if (isMissing(raw.sot_home) || isMissing(raw.sot_away)) missing.push("sot");
  if (isMissing(raw.xg_home) || isMissing(raw.xg_away)) missing.push("xg");
  if (isMissing(raw.corners_home) || isMissing(raw.corners_away)) missing.push("corners");

  return {
    id: raw.id,
    home: raw.home_team, away: raw.away_team, competition: raw.competition,
    minute: raw.minute ?? 0,
    scoreHome: raw.score_home ?? 0, scoreAway: raw.score_away ?? 0,
    shotsHome: raw.shots_home ?? 0, shotsAway: raw.shots_away ?? 0,
    // 0 ici est un placeholder neutre : la clé correspondante est dans
    // `missing` et le moteur l'ignore, il ne l'utilise jamais comme donnée réelle.
    sotHome: raw.sot_home ?? 0, sotAway: raw.sot_away ?? 0,
    cornersHome: raw.corners_home ?? 0, cornersAway: raw.corners_away ?? 0,
    possessionHome: raw.possession_home ?? 50,
    xgHome: raw.xg_home ?? 0, xgAway: raw.xg_away ?? 0,
    dangerousHome: raw.dangerous_home ?? 0, dangerousAway: raw.dangerous_away ?? 0,
    fouls: raw.fouls ?? 0, yellow: raw.yellow ?? 0, red: raw.red ?? 0,
    missing,
    bias: 0.5,
    history: [],
    finished: raw.status === "finished",
  };
}

function signalLevel(score) {
  if (score >= 90) return { label: "Très fort", emoji: "🔥", tone: "veryhigh" };
  if (score >= 75) return { label: "Fort", emoji: "🟢", tone: "high" };
  if (score >= 60) return { label: "Intéressant", emoji: "🟠", tone: "mid" };
  if (score >= 40) return { label: "Modéré", emoji: "🟡", tone: "low" };
  return { label: "Faible", emoji: "⚪", tone: "verylow" };
}

const TONE_STYLES = {
  veryhigh: { bar: "bg-red-500", text: "text-red-400", badge: "bg-red-500/15 text-red-400 border-red-500/30" },
  high:     { bar: "bg-emerald-500", text: "text-emerald-400", badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  mid:      { bar: "bg-orange-500", text: "text-orange-400", badge: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  low:      { bar: "bg-amber-400", text: "text-amber-300", badge: "bg-amber-400/15 text-amber-300 border-amber-400/30" },
  verylow:  { bar: "bg-slate-500", text: "text-slate-400", badge: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
};

function makeInitialMatch(id, [home, away, competition]) {
  const minute = 12 + Math.floor(Math.random() * 20);
  const bias = Math.random(); // qui a l'ascendant au départ
  return {
    id, home, away, competition, minute,
    scoreHome: 0, scoreAway: 0,
    shotsHome: Math.floor(bias * 6), shotsAway: Math.floor((1 - bias) * 6),
    sotHome: Math.floor(bias * 3), sotAway: Math.floor((1 - bias) * 3),
    cornersHome: Math.floor(bias * 3), cornersAway: Math.floor((1 - bias) * 3),
    possessionHome: Math.round(40 + bias * 20),
    xgHome: +(bias * 0.9).toFixed(2), xgAway: +((1 - bias) * 0.9).toFixed(2),
    dangerousHome: Math.floor(bias * 8), dangerousAway: Math.floor((1 - bias) * 8),
    fouls: Math.floor(Math.random() * 6),
    yellow: 0, red: 0,
    missing: [], // en mode démo, toutes les statistiques sont toujours disponibles
    bias,
    history: [], // {minute, homeShare, sotHome, sotAway, goal}
    lastAlertScore: 0,
    finished: false,
  };
}

// Dynamique récente : combine tirs cadrés + corners sur une fenêtre donnée
// (5 / 10 / 15 dernières minutes simulées), car une accélération conjointe
// des deux est un signal plus fiable qu'une seule statistique qui grimpe seule.
function recentWindowDelta(history, minute, windowMin) {
  const recent = history.filter(h => h.minute > minute - windowMin);
  if (recent.length < 2) return { sotHome: 0, sotAway: 0, cornersHome: 0, cornersAway: 0 };
  const first = recent[0], last = recent[recent.length - 1];
  return {
    sotHome: Math.max(last.sotHome - first.sotHome, 0),
    sotAway: Math.max(last.sotAway - first.sotAway, 0),
    cornersHome: Math.max((last.cornersHome ?? 0) - (first.cornersHome ?? 0), 0),
    cornersAway: Math.max((last.cornersAway ?? 0) - (first.cornersAway ?? 0), 0),
  };
}

function recentDynamicShare(history, minute) {
  const d10 = recentWindowDelta(history, minute, 10);
  const sotShare = share(d10.sotHome, d10.sotAway);
  const cornersShare = share(d10.cornersHome, d10.cornersAway);
  // Une accélération des tirs cadrés compte davantage que celle des corners seuls
  return sotShare * 0.65 + cornersShare * 0.35;
}

// Détecte la convergence réelle des indicateurs principaux disponibles vers
// l'équipe dominante — le cœur de la logique "anti faux signal". Un indicateur
// listé dans m.missing est simplement ignoré (jamais compté ni comme fort, ni
// comme faible).
function computeConvergence(m, dominant) {
  const missing = m.missing || [];
  const domShare = (v) => (dominant === "home" ? v : 100 - v);

  const sotStrong = !missing.includes("sot") &&
    domShare(share(m.sotHome, m.sotAway)) >= CONVERGENCE_STRONG_SHARE &&
    (dominant === "home" ? m.sotHome - m.sotAway : m.sotAway - m.sotHome) >= CONVERGENCE_MIN_DIFF.sot;
  const cornersStrong = !missing.includes("corners") &&
    domShare(share(m.cornersHome, m.cornersAway)) >= CONVERGENCE_STRONG_SHARE &&
    (dominant === "home" ? m.cornersHome - m.cornersAway : m.cornersAway - m.cornersHome) >= CONVERGENCE_MIN_DIFF.corners;
  const xgStrong = !missing.includes("xg") &&
    domShare(share(m.xgHome, m.xgAway)) >= CONVERGENCE_STRONG_SHARE &&
    (dominant === "home" ? m.xgHome - m.xgAway : m.xgAway - m.xgHome) >= CONVERGENCE_MIN_DIFF.xg;

  const count = [sotStrong, cornersStrong, xgStrong].filter(Boolean).length;
  return {
    count, sotStrong, cornersStrong, xgStrong,
    sotDiff: dominant === "home" ? m.sotHome - m.sotAway : m.sotAway - m.sotHome,
    cornersDiff: dominant === "home" ? m.cornersHome - m.cornersAway : m.cornersAway - m.cornersHome,
    xgDiff: dominant === "home" ? m.xgHome - m.xgAway : m.xgAway - m.xgHome,
  };
}

// Le moteur ne pondère que les indicateurs réellement disponibles : une
// statistique absente de l'API est retirée du calcul et les poids restants
// sont renormalisés — jamais remplacée par une valeur inventée.
function computePressure(m, weights) {
  const missing = m.missing || [];
  const candidates = [
    { key: "sot", w: weights.sot, val: share(m.sotHome, m.sotAway) },
    { key: "xg", w: weights.xg, val: share(m.xgHome, m.xgAway) },
    { key: "corners", w: weights.corners, val: share(m.cornersHome, m.cornersAway) },
  ].filter((c) => !missing.includes(c.key));

  const recentUsable = !(missing.includes("sot") && missing.includes("corners"));
  const recentShare = recentUsable ? recentDynamicShare(m.history, m.minute) : 50;
  if (recentUsable) candidates.push({ key: "recent", w: weights.recent, val: recentShare });

  const total = candidates.reduce((s, c) => s + c.w, 0) || 1;
  const homeShare = candidates.reduce((s, c) => s + c.val * c.w, 0) / total;

  const dominant = homeShare >= 50 ? "home" : "away";
  const baseScore = dominant === "home" ? homeShare : 100 - homeShare;

  const convergence = computeConvergence(m, dominant);
  const multiplier = CONVERGENCE_MULTIPLIER[convergence.count];
  const adjustedScore = clamp(50 + (baseScore - 50) * multiplier, 0, 100);

  return {
    score: Math.round(adjustedScore),
    dominant,
    homeShare: Math.round(dominant === "home" ? adjustedScore : 100 - adjustedScore),
    recentShare: Math.round(recentShare),
    convergence,
    missingLabels: missing.map((k) => INDICATOR_LABELS[k]).filter(Boolean),
  };
}

function convergenceReasons(m, pressure) {
  const team = pressure.dominant === "home" ? m.home : m.away;
  const c = pressure.convergence;
  const reasons = [];
  if (c.sotStrong) reasons.push(`🎯 Forte domination des tirs cadrés (+${c.sotDiff})`);
  if (c.cornersStrong) reasons.push(`🚩 Domination des corners (+${c.cornersDiff})`);
  if (c.xgStrong) reasons.push(`⚽ xG nettement supérieur (+${c.xgDiff.toFixed(2)})`);
  if (pressure.recentShare > 58) reasons.push("📈 Pression offensive en augmentation");
  if (reasons.length === 0) reasons.push(`Domination limitée à un seul indicateur — signal prudent pour ${team}`);
  return reasons;
}

function aiAnalysis(m, pressure) {
  const team = pressure.dominant === "home" ? m.home : m.away;
  const sig = signalLevel(pressure.score);
  const sotH = m.sotHome, sotA = m.sotAway;
  const dominantSot = pressure.dominant === "home" ? sotH : sotA;
  const otherSot = pressure.dominant === "home" ? sotA : sotH;
  const xgLead = pressure.dominant === "home" ? m.xgHome - m.xgAway : m.xgAway - m.xgHome;
  const trendUp = pressure.recentShare > 58;
  const c = pressure.convergence;

  const convergencePhrase = c.count >= 2
    ? "Plusieurs indicateurs clés convergent simultanément vers cette équipe. "
    : "La domination repose surtout sur un seul indicateur — la convergence reste limitée. ";

  return `${m.minute}e minute. ${team} domine actuellement les statistiques offensives (${dominantSot} tirs cadrés contre ${otherSot}${xgLead > 0.15 ? `, avec un avantage d'xG de +${xgLead.toFixed(2)}` : ""}). ${convergencePhrase}${trendUp ? "La pression offensive s'est accentuée au cours des 10 dernières minutes. " : "La dynamique récente reste stable. "}Signal : ${sig.label.toUpperCase()}. Le contexte statistique est favorable à une poursuite de la pression de ${team}, mais ne garantit pas qu'un but sera marqué.`;
   }
function tickMatch(m) {
  if (m.finished || m.minute >= 90) return { ...m, finished: true };
  const next = { ...m };
  next.minute = m.minute + 1;

  // Chaque équipe a une probabilité d'action liée à son "bias" courant + un peu de hasard
  const driftedBias = clamp(m.bias + (Math.random() - 0.5) * 0.06, 0.15, 0.85);
  next.bias = driftedBias;

  const homeActs = Math.random() < 0.55;
  const actingHomeProb = driftedBias;
  const homeIsActing = Math.random() < actingHomeProb;

  if (Math.random() < 0.75) { // un tir se produit cette minute
    if (homeIsActing) {
      next.shotsHome += 1;
      if (Math.random() < 0.5) { next.sotHome += 1; next.xgHome = +(next.xgHome + 0.05 + Math.random() * 0.15).toFixed(2); }
      else next.xgHome = +(next.xgHome + 0.02 + Math.random() * 0.05).toFixed(2);
    } else {
      next.shotsAway += 1;
      if (Math.random() < 0.5) { next.sotAway += 1; next.xgAway = +(next.xgAway + 0.05 + Math.random() * 0.15).toFixed(2); }
      else next.xgAway = +(next.xgAway + 0.02 + Math.random() * 0.05).toFixed(2);
    }
  }
  if (Math.random() < 0.2) { if (homeIsActing) next.cornersHome += 1; else next.cornersAway += 1; }
  if (homeIsActing) next.dangerousHome += Math.floor(Math.random() * 3);
  else next.dangerousAway += Math.floor(Math.random() * 3);

  next.possessionHome = clamp(Math.round(m.possessionHome + (driftedBias - 0.5) * 4 + (Math.random() - 0.5) * 3), 28, 72);

  if (Math.random() < 0.02) next.fouls += 1;
  if (Math.random() < 0.006) { if (homeIsActing) next.yellow += 1; else next.yellow += 1; }
  if (Math.random() < 0.001) next.red += 1;

  // Chance de but, influencée par la pression du moment
  const tempPressure = computePressure(next, DEFAULT_WEIGHTS);
  const goalChance = Math.pow(tempPressure.score / 100, 3) * 0.05;
  let goal = null;
  if (Math.random() < goalChance) {
    if (tempPressure.dominant === "home") next.scoreHome += 1; else next.scoreAway += 1;
    goal = tempPressure.dominant;
  }

  // On conserve tirs cadrés / corners / xG / minute / score à chaque relevé :
  // c'est exactement l'ensemble de variables à corréler statistiquement plus
  // tard avec la fréquence de but dans les 5/10/15 minutes suivantes (V2/V3).
  next.history = [...m.history, {
    minute: next.minute,
    homeShare: tempPressure.homeShare,
    sotHome: next.sotHome, sotAway: next.sotAway,
    cornersHome: next.cornersHome, cornersAway: next.cornersAway,
    xgHome: next.xgHome, xgAway: next.xgAway,
    scoreHome: next.scoreHome, scoreAway: next.scoreAway,
    convergenceCount: tempPressure.convergence.count,
    goal,
  }];
  return next;
}

// ---------------- UI atoms ----------------

function StatBar({ label, home, away, homeLabel, awayLabel, format = (x) => x }) {
  const total = home + away || 1;
  const homePct = (home / total) * 100;
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-slate-400 mb-1 font-mono">
        <span>{format(home)}</span>
        <span className="text-slate-500">{label}</span>
        <span>{format(away)}</span>
      </div>
      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex">
        <div className="h-full bg-sky-500" style={{ width: `${homePct}%` }} />
        <div className="h-full bg-orange-500" style={{ width: `${100 - homePct}%` }} />
      </div>
    </div>
  );
}

function SignalBadge({ score }) {
  const sig = signalLevel(score);
  const t = TONE_STYLES[sig.tone];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${t.badge}`}>
      {sig.emoji} {sig.label}
    </span>
  );
}

function PressureBar({ score }) {
  const sig = signalLevel(score);
  const t = TONE_STYLES[sig.tone];
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>Pression offensive</span>
        <span className="font-mono text-slate-200">{score}/100</span>
      </div>
      <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${t.bar} transition-all duration-500`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function MatchCard({ m, pressure, onOpen }) {
  const team = pressure.dominant === "home" ? m.home : m.away;
  return (
    <button onClick={() => onOpen(m.id)} className="text-left w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 hover:border-slate-600 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-slate-500">{m.competition}</span>
        <span className="text-[11px] font-mono text-red-400 flex items-center gap-1">● {m.minute}'</span>
      </div>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-slate-100 text-sm leading-tight">{m.home}<br />{m.away}</div>
        <div className="font-mono text-2xl font-bold text-slate-100">{m.scoreHome} - {m.scoreAway}</div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 text-xs text-slate-400 font-mono mb-3">
        <div>🎯 SOT&nbsp; {m.sotHome} - {m.sotAway}</div>
        <div>xG&nbsp;&nbsp;&nbsp; {m.xgHome.toFixed(2)} - {m.xgAway.toFixed(2)}</div>
        <div>Corners {m.cornersHome} - {m.cornersAway}</div>
        <div>Poss. {m.possessionHome}% - {100 - m.possessionHome}%</div>
      </div>
      <PressureBar score={pressure.score} />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">Équipe dominante : <span className="text-slate-300">{team}</span></span>
        <SignalBadge score={pressure.score} />
      </div>
      {pressure.missingLabels.length > 0 && (
        <div className="mt-2 text-[10px] text-amber-400/80">⚠️ Indisponible : {pressure.missingLabels.join(", ")}</div>
      )}
    </button>
  );
}

function Dashboard({ matches, pressures, filters, setFilters, weights, onOpen }) {
  const filtered = matches.filter((m) => {
    const p = pressures[m.id];
    if (filters.half === "1" && m.minute > 45) return false;
    if (filters.half === "2" && m.minute <= 45) return false;
    if (filters.minuteBand === "45-60" && !(m.minute >= 45 && m.minute <= 60)) return false;
    if (filters.minuteBand === "60-75" && !(m.minute > 60 && m.minute <= 75)) return false;
    if (filters.minuteBand === "75-90" && !(m.minute > 75 && m.minute <= 90)) return false;
    if (filters.draw && m.scoreHome !== m.scoreAway) return false;
    if (filters.oneGoalGap && Math.abs(m.scoreHome - m.scoreAway) !== 1) return false;
    if (filters.highPressure && p.score < 75) return false;
    const sot = Math.max(m.sotHome, m.sotAway);
    if (sot < filters.minSot) return false;
    return true;
  });

  const liveCount = matches.length;
  const highPressureCount = matches.filter((m) => pressures[m.id].score >= 75).length;
  const goalsRecent = matches.reduce((acc, m) => acc + m.history.filter(h => h.goal && h.minute > m.minute - 10).length, 0);
  const activeSignals = matches.filter((m) => pressures[m.id].score >= 60).length;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryTile emoji="🔴" label="Matchs LIVE" value={liveCount} />
        <SummaryTile emoji="🔥" label="Forte pression" value={highPressureCount} />
        <SummaryTile emoji="⚽" label="Buts récents (10')" value={goalsRecent} />
        <SummaryTile emoji="📊" label="Signaux actifs" value={activeSignals} />
      </div>

      <FilterBar filters={filters} setFilters={setFilters} />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
        {filtered.map((m) => (
          <MatchCard key={m.id} m={m} pressure={pressures[m.id]} onOpen={onOpen} />
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full text-center text-slate-500 py-12 text-sm">Aucun match ne correspond à ces filtres.</div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ emoji, label, value }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      <div className="text-2xl mb-1">{emoji}</div>
      <div className="text-2xl font-bold font-mono text-slate-100">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function FilterBar({ filters, setFilters }) {
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const chip = (active) => `text-xs px-3 py-1.5 rounded-full border transition-colors ${active ? "bg-orange-500/15 border-orange-500/40 text-orange-300" : "bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-600"}`;
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <button className={chip(filters.half === "all")} onClick={() => set("half", "all")}>Tous</button>
      <button className={chip(filters.half === "1")} onClick={() => set("half", "1")}>1re mi-temps</button>
      <button className={chip(filters.half === "2")} onClick={() => set("half", "2")}>2e mi-temps</button>
      <button className={chip(filters.minuteBand === "45-60")} onClick={() => set("minuteBand", filters.minuteBand === "45-60" ? "all" : "45-60")}>45–60'</button>
      <button className={chip(filters.minuteBand === "60-75")} onClick={() => set("minuteBand", filters.minuteBand === "60-75" ? "all" : "60-75")}>60–75'</button>
      <button className={chip(filters.minuteBand === "75-90")} onClick={() => set("minuteBand", filters.minuteBand === "75-90" ? "all" : "75-90")}>75–90'</button>
      <button className={chip(filters.draw)} onClick={() => set("draw", !filters.draw)}>Score nul</button>
      <button className={chip(filters.oneGoalGap)} onClick={() => set("oneGoalGap", !filters.oneGoalGap)}>Écart d'1 but</button>
      <button className={chip(filters.highPressure)} onClick={() => set("highPressure", !filters.highPressure)}>Forte pression</button>
      <select value={filters.minSot} onChange={(e) => set("minSot", Number(e.target.value))} className="text-xs bg-slate-900 border border-slate-800 rounded-full px-3 py-1.5 text-slate-300">
        <option value={0}>Tirs cadrés ≥ 0</option>
        <option value={3}>≥ 3</option>
        <option value={5}>≥ 5</option>
        <option value={7}>≥ 7</option>
        <option value={10}>≥ 10</option>
      </select>
    </div>
  );
          }
function MatchDetail({ m, pressure, onBack }) {
  const chartData = m.history.filter((_, i) => i % 1 === 0).map(h => ({
    minute: h.minute, "Domicile": h.homeShare, "Extérieur": 100 - h.homeShare,
  }));
  return (
    <div>
      <button onClick={onBack} className="text-sm text-slate-400 hover:text-slate-200 mb-4">← Retour au dashboard</button>
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xs text-slate-500 mb-1">{m.competition}</div>
          <h2 className="text-xl font-bold text-slate-100">{m.home} vs {m.away}</h2>
          <div className="text-slate-400 text-sm mt-1">{m.minute}' — Score {m.scoreHome} - {m.scoreAway}</div>
        </div>
        <SignalBadge score={pressure.score} />
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
        <PressureBar score={pressure.score} />
        {pressure.missingLabels.length > 0 && (
          <p className="text-xs text-amber-400 mt-3">⚠️ Certaines statistiques ne sont pas disponibles : {pressure.missingLabels.join(", ")}. Le score a été recalculé uniquement à partir des données disponibles.</p>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-200 mb-3">AI MATCH ANALYSIS</h3>
        <p className="text-sm text-slate-300 leading-relaxed">{aiAnalysis(m, pressure)}</p>
        <p className="text-[11px] text-slate-500 mt-3 border-t border-slate-800 pt-2">Score de pression statistique — ce n'est pas une probabilité garantie de but.</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <SignalBadge score={pressure.score} />
          <span className="text-sm text-slate-300">Équipe dominante : <strong className="text-slate-100">{pressure.dominant === "home" ? m.home : m.away}</strong></span>
        </div>
        <div className="text-xs text-slate-500 mb-1">Raisons (convergence des indicateurs principaux)</div>
        <ul className="text-sm text-slate-300 space-y-1">
          {convergenceReasons(m, pressure).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {pressure.convergence.count <= 1 && (
          <p className="text-[11px] text-amber-400/90 mt-2">⚠️ Convergence faible : ce signal repose sur peu d'indicateurs principaux réellement alignés — traité comme un signal prudent, pas comme une preuve de but imminent.</p>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-200 mb-3">Statistiques générales</h3>
        <StatBar label="Tirs" home={m.shotsHome} away={m.shotsAway} />
        <StatBar label="Tirs cadrés" home={m.sotHome} away={m.sotAway} />
        <StatBar label="Corners" home={m.cornersHome} away={m.cornersAway} />
        <StatBar label="xG" home={m.xgHome} away={m.xgAway} format={(x) => x.toFixed(2)} />
        <StatBar label="Attaques dangereuses" home={m.dangerousHome} away={m.dangerousAway} />
        <StatBar label="Possession" home={m.possessionHome} away={100 - m.possessionHome} format={(x) => `${x}%`} />
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-slate-200 mb-3">Évolution de la pression (part de domination %)</h3>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="minute" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="Domicile" stroke="#38bdf8" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="Extérieur" stroke="#fb923c" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function TopSignals({ matches, pressures, onOpen }) {
  const ranked = [...matches].sort((a, b) => pressures[b.id].score - pressures[a.id].score);
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-100 mb-4">TOP LIVE SIGNALS</h2>
      <div className="space-y-2">
        {ranked.map((m, i) => {
          const p = pressures[m.id];
          const sig = signalLevel(p.score);
          return (
            <button key={m.id} onClick={() => onOpen(m.id)} className="w-full flex items-center justify-between bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 hover:border-slate-600">
              <div className="flex items-center gap-3">
                <span className="text-slate-500 font-mono text-sm w-5">{i + 1}.</span>
                <span className="text-lg">{sig.emoji}</span>
                <span className="text-sm text-slate-200">{m.home} – {m.away}</span>
              </div>
              <span className="font-mono text-sm text-slate-300">{p.score}/100</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AlertsPanel({ alerts, alertsEnabled, setAlertsEnabled }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-100">Alertes</h2>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input type="checkbox" checked={alertsEnabled} onChange={(e) => setAlertsEnabled(e.target.checked)} />
          Alertes activées
        </label>
      </div>
      <div className="space-y-2">
        {alerts.length === 0 && <div className="text-sm text-slate-500">Aucune alerte pour le moment.</div>}
        {alerts.slice().reverse().map((a, i) => (
          <div key={i} className="bg-slate-900 border border-red-500/30 rounded-xl px-4 py-3">
            <div className="text-sm font-semibold text-red-400 mb-1">🔥 NOUVEAU SIGNAL FORT</div>
            <div className="text-sm text-slate-200">{a.match}</div>
            <div className="text-xs text-slate-500 font-mono mt-1">Minute {a.minute}' · Pressure Score {a.score}/100</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryView({ matches }) {
  const rows = matches.flatMap((m) => m.history.slice(-6).map((h) => ({
    match: `${m.home} – ${m.away}`, minute: h.minute, homeShare: h.homeShare, sot: `${h.sotHome}-${h.sotAway}`, goal: h.goal,
  })));
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-100 mb-4">Historique de session</h2>
      <p className="text-xs text-slate-500 mb-3">Dernières observations enregistrées pour chaque match en cours (démo). En production, ces relevés sont persistés en base (table <span className="font-mono">live_statistics</span> / <span className="font-mono">pressure_scores</span>).</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="text-slate-500 border-b border-slate-800">
            <tr><th className="py-2 pr-4">Match</th><th className="py-2 pr-4">Minute</th><th className="py-2 pr-4">Part domicile</th><th className="py-2 pr-4">SOT</th><th className="py-2">But</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-900 text-slate-300">
                <td className="py-2 pr-4">{r.match}</td>
                <td className="py-2 pr-4 font-mono">{r.minute}'</td>
                <td className="py-2 pr-4 font-mono">{r.homeShare}%</td>
                <td className="py-2 pr-4 font-mono">{r.sot}</td>
                <td className="py-2">{r.goal ? "⚽" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BacktestView({ matches, threshold, setThreshold }) {
  const results = useMemo(() => {
    const allSnaps = matches.flatMap((m) => m.history.map((h, idx) => ({ ...h, matchId: m.id, idx, full: m.history })));
    const hits = allSnaps.filter((s) => Math.max(s.homeShare, 100 - s.homeShare) >= threshold);
    let within5 = 0, within10 = 0, within15 = 0, delays = [];
    hits.forEach((s) => {
      const future = s.full.filter((h2) => h2.minute > s.minute && h2.minute <= s.minute + 15 && h2.goal);
      if (future.length > 0) {
        const delay = future[0].minute - s.minute;
        delays.push(delay);
        if (delay <= 5) within5++;
        if (delay <= 10) within10++;
        if (delay <= 15) within15++;
      }
    });
    const n = hits.length || 1;
    return {
      n: hits.length,
      pct5: Math.round((within5 / n) * 100),
      pct10: Math.round((within10 / n) * 100),
      pct15: Math.round((within15 / n) * 100),
      avgDelay: delays.length ? (delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1) : "—",
    };
  }, [matches, threshold]);

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-100 mb-2">Backtest</h2>
      <p className="text-xs text-slate-500 mb-4">Calculé sur les observations de la session démo en cours (échantillon limité). Un backtest de production s'appuie sur l'historique complet en base de données.</p>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm text-slate-400">Seuil Pressure Score ≥</span>
        {[60, 70, 80, 90].map((t) => (
          <button key={t} onClick={() => setThreshold(t)} className={`text-xs px-3 py-1 rounded-full border ${threshold === t ? "bg-orange-500/15 border-orange-500/40 text-orange-300" : "bg-slate-900 border-slate-800 text-slate-400"}`}>{t}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <SummaryTile emoji="📈" label="Situations observées" value={results.n} />
        <SummaryTile emoji="⏱️" label="But sous 5 min" value={`${results.pct5}%`} />
        <SummaryTile emoji="⏱️" label="But sous 10 min" value={`${results.pct10}%`} />
        <SummaryTile emoji="⏱️" label="But sous 15 min" value={`${results.pct15}%`} />
      </div>
      <div className="text-sm text-slate-400 mb-4">Délai moyen avant but : <span className="font-mono text-slate-200">{results.avgDelay} min</span></div>
      <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-3">Les performances historiques ne garantissent pas les performances futures.</p>
    </div>
  );
}

function SettingsView({ weights, setWeights }) {
  const set = (k, v) => setWeights((w) => ({ ...w, [k]: v }));
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const labels = { sot: "🎯 Tirs cadrés", xg: "⚽ xG", corners: "🚩 Corners", recent: "📈 Dynamique offensive récente (5/10/15')" };
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-100 mb-2">Paramètres — Pondération du Pressure Score Engine</h2>
      <p className="text-xs text-slate-500 mb-4">Version 2 : tirs cadrés, xG et corners sont les indicateurs principaux (poids ci-dessous) ; tirs totaux, possession et attaques dangereuses restent des facteurs complémentaires affichés sur la fiche match mais non pondérés directement. Ces pondérations sont ajustables après backtesting — elles ne sont pas scientifiquement définitives.</p>
      <div className="space-y-4 max-w-md">
        {Object.keys(weights).map((k) => (
          <div key={k}>
            <div className="flex justify-between text-sm text-slate-300 mb-1">
              <span>{labels[k]}</span>
              <span className="font-mono">{weights[k]}%</span>
            </div>
            <input type="range" min={0} max={60} value={weights[k]} onChange={(e) => set(k, Number(e.target.value))} className="w-full accent-orange-500" />
          </div>
        ))}
      </div>
      <div className={`mt-4 text-sm font-mono ${total === 100 ? "text-emerald-400" : "text-red-400"}`}>Total : {total}% {total !== 100 && "(devrait être 100%)"}</div>
    </div>
  );
}

function Methodology() {
  return (
    <div className="prose prose-invert max-w-none text-sm text-slate-300 space-y-4">
      <h2 className="text-lg font-bold text-slate-100">Méthodologie</h2>
      <p><strong className="text-slate-100">Pressure Score.</strong> Le Pressure Score (0–100) mesure la part de domination statistique d'une équipe sur son adversaire à un instant donné du match, à partir d'une somme pondérée de ses indicateurs principaux.</p>
      <p><strong className="text-slate-100">Indicateurs principaux (V2).</strong> Tirs cadrés (40%), xG (30%) et corners (20%) forment le cœur du moteur, complétés par la dynamique offensive récente sur 5/10/15 minutes (10%). Tirs totaux, possession et attaques dangereuses restent des facteurs complémentaires : ils enrichissent l'analyse et les "raisons" affichées, mais ne pèsent plus directement dans le score. Une statistique indisponible est simplement exclue du calcul — elle n'est jamais inventée.</p>
      <p><strong className="text-slate-100">Convergence plutôt que volume.</strong> Le moteur ne se contente pas d'additionner les statistiques : il vérifie combien des 3 indicateurs principaux (tirs cadrés, xG, corners) pointent réellement et fortement vers la même équipe. Beaucoup de corners avec très peu de tirs cadrés et un xG faible ne produit donc pas un signal très fort — le score est ramené vers la neutralité en l'absence de convergence. À l'inverse, une équipe qui cumule tirs cadrés élevés, xG élevé, plusieurs corners et une dynamique récente en hausse voit son score amplifié.</p>
      <p><strong className="text-slate-100">Dynamique récente.</strong> Une accélération conjointe des tirs cadrés et des corners dans les 5 à 15 dernières minutes est un signal fort d'intention offensive immédiate — elle est intégrée séparément au score et citée parmi les raisons du signal.</p>
      <p><strong className="text-slate-100">Limites du modèle.</strong> Le Pressure Score V2 reste un score pondéré avec règles de convergence manuelles, non calibré statistiquement. Il ne tient pas compte du contexte tactique, de la fatigue, ou d'événements comme un carton rouge, sinon de façon indirecte.</p>
      <p><strong className="text-slate-100">Signal statistique ≠ probabilité réelle.</strong> Un score de 90/100 signifie une domination statistique exceptionnellement nette et convergente — pas une probabilité de 90% qu'un but soit marqué. Une vraie probabilité (P(but | données live)) nécessite un modèle entraîné et validé sur des données historiques (version 3/4 de la feuille de route).</p>
      <p><strong className="text-slate-100">Vers une calibration statistique.</strong> Chaque relevé enregistre déjà tirs cadrés, corners, xG, minute et score des deux équipes. Une fois suffisamment de données historiques réunies, ces combinaisons pourront être corrélées statistiquement à la fréquence réelle de but dans les 5, 10 et 15 minutes suivantes (V2 de la feuille de route) — sans jamais présenter le résultat comme une certitude.</p>
      <p><strong className="text-slate-100">Performances historiques.</strong> Les résultats de backtest affichés dans l'application décrivent ce qui s'est produit par le passé sur l'échantillon disponible. Ils ne garantissent pas les performances futures.</p>
      <h3 className="text-slate-100 font-semibold pt-2">Feuille de route de l'algorithme</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li>V1 — Score pondéré (indicateurs répartis)</li>
        <li>V2 — Tirs cadrés / xG / corners au cœur du modèle + règles de convergence (actuel)</li>
        <li>V3 — Calibration statistique sur données historiques, modèle probabiliste</li>
        <li>V4 — Machine learning</li>
      </ul>
    </div>
  );
        }
function formatElapsed(seconds) {
  if (seconds < 5) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds}s`;
  return `il y a ${Math.floor(seconds / 60)} min`;
}

// ---------------- FootballDataService ----------------
// Couche d'accès aux données réelles. Le frontend n'appelle JAMAIS l'API
// football directement (pas de clé API côté client) — il appelle une route
// serveur (ex. Next.js API route) qui, elle, détient FOOTBALL_API_KEY et
// interroge le fournisseur choisi (voir api-live-matches.example.ts fourni
// à part). Cette fonction ne fabrique jamais de données : en cas d'échec,
// elle remonte l'erreur telle quelle, sans repli sur des matchs simulés.
async function fetchLiveMatches() {
  const res = await fetch("/api/live-matches");
  if (!res.ok) throw new Error(`API indisponible (${res.status})`);
  const payload = await res.json();
  return payload.matches.map(normalizeLiveMatch);
}

// ---------------- Root ----------------

export default function LiveGoalAnalyzer() {
  const [mode, setMode] = useState("demo"); // "demo" | "live"
  const [matches, setMatches] = useState(() => TEAM_PAIRS.map((p, i) => makeInitialMatch(i, p)));
  const [view, setView] = useState("dashboard");
  const [selectedId, setSelectedId] = useState(null);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [filters, setFilters] = useState({ half: "all", minuteBand: "all", draw: false, oneGoalGap: false, highPressure: false, minSot: 0 });
  const [alerts, setAlerts] = useState([]);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [threshold, setThreshold] = useState(80);
  const [running, setRunning] = useState(true);
  const [liveStatus, setLiveStatus] = useState("idle"); // idle | loading | ok | error
  const [liveError, setLiveError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [elapsedNow, setElapsedNow] = useState(Date.now());
  const alertsEnabledRef = useRef(alertsEnabled);
  alertsEnabledRef.current = alertsEnabled;

  // Mode démo : simulation locale, comme avant.
  useEffect(() => {
    if (mode !== "demo" || !running) return;
    const id = setInterval(() => {
      setMatches((prev) => {
        const updated = prev.map((m) => (m.finished ? m : tickMatch(m)));
        updated.forEach((m) => {
          const before = prev.find((p) => p.id === m.id);
          if (!before) return;
          const prevScore = computePressure(before, weights).score;
          const newScore = computePressure(m, weights).score;
          if (alertsEnabledRef.current && newScore >= 75 && newScore - prevScore >= 12) {
            setAlerts((al) => [...al, { match: `${m.home} – ${m.away}`, minute: m.minute, score: newScore }]);
          }
        });
        return updated;
      });
    }, 2500);
    return () => clearInterval(id);
  }, [mode, running, weights]);

  // Mode LIVE : interroge le backend à fréquence raisonnable (respecte le
  // rate limiting du fournisseur), fusionne l'historique déjà accumulé pour
  // chaque match plutôt que de le repartir de zéro, et n'affiche jamais de
  // données simulées si l'appel échoue.
  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    const poll = async () => {
      setLiveStatus((s) => (s === "idle" ? "loading" : s));
      try {
        const fresh = await fetchLiveMatches();
        if (cancelled) return;
        setMatches((prev) => fresh.map((f) => {
          const before = prev.find((p) => p.id === f.id);
          const withHistory = before ? { ...f, history: before.history } : f;
          const p = computePressure(withHistory, weights);
          withHistory.history = [...withHistory.history, {
            minute: withHistory.minute, homeShare: p.homeShare,
            sotHome: withHistory.sotHome, sotAway: withHistory.sotAway,
            cornersHome: withHistory.cornersHome, cornersAway: withHistory.cornersAway,
            xgHome: withHistory.xgHome, xgAway: withHistory.xgAway,
            scoreHome: withHistory.scoreHome, scoreAway: withHistory.scoreAway,
            convergenceCount: p.convergence.count, goal: null,
          }];
          if (before) {
            const prevScore = computePressure(before, weights).score;
            if (alertsEnabledRef.current && p.score >= 75 && p.score - prevScore >= 12) {
              setAlerts((al) => [...al, { match: `${f.home} – ${f.away}`, minute: f.minute, score: p.score }]);
            }
          }
          return withHistory;
        }));
        setLiveStatus("ok");
        setLiveError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (cancelled) return;
        // IMPORTANT : on ne bascule jamais sur des données simulées ici.
        setLiveStatus("error");
        setLiveError(e.message || "Erreur inconnue");
      }
    };
    poll();
    // Fréquence raisonnable — à ajuster selon le plan du fournisseur choisi.
    const id = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [mode, weights]);

  useEffect(() => {
    const id = setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pressures = useMemo(() => {
    const map = {};
    matches.forEach((m) => { map[m.id] = computePressure(m, weights); });
    return map;
  }, [matches, weights]);

  const nav = [
    ["dashboard", "Dashboard"],
    ["live", "Matchs Live"],
    ["top", "Analyse"],
    ["history", "Historique"],
    ["backtest", "Statistiques"],
    ["settings", "Paramètres"],
    ["methodology", "Méthodologie"],
  ];

  const openMatch = (id) => { setSelectedId(id); setView("detail"); };
  const selected = matches.find((m) => m.id === selectedId);
  const displayedMatches = mode === "live" && liveStatus !== "ok" ? [] : matches;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="border-b border-slate-800 sticky top-0 bg-slate-950/95 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚽</span>
            <span className="font-black tracking-tight text-slate-100">LIVE GOAL ANALYZER</span>
            {mode === "demo" ? (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30 ml-1">MODE DÉMO — DONNÉES SIMULÉES</span>
            ) : (
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ml-1 ${liveStatus === "ok" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : liveStatus === "error" ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-slate-700/30 text-slate-300 border-slate-600/40"}`}>
                DONNÉES RÉELLES — LIVE {liveStatus === "ok" && lastUpdated ? `· ${formatElapsed(Math.round((elapsedNow - lastUpdated) / 1000))}` : liveStatus === "loading" ? "· connexion…" : liveStatus === "error" ? "· indisponible" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full border border-slate-700 overflow-hidden text-xs">
              <button onClick={() => setMode("demo")} className={`px-3 py-1.5 ${mode === "demo" ? "bg-slate-800 text-slate-100" : "text-slate-400"}`}>Démo</button>
              <button onClick={() => setMode("live")} className={`px-3 py-1.5 ${mode === "live" ? "bg-slate-800 text-slate-100" : "text-slate-400"}`}>Live réel</button>
            </div>
            {mode === "demo" ? (
              <button onClick={() => setRunning((r) => !r)} className="text-xs px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500">
                {running ? "⏸ Pause" : "▶ Reprendre"}
              </button>
            ) : (
              <button onClick={() => { setLiveStatus("loading"); fetchLiveMatches().then((fresh) => { setMatches(fresh); setLiveStatus("ok"); setLastUpdated(Date.now()); }).catch((e) => { setLiveStatus("error"); setLiveError(e.message); }); }} className="text-xs px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500">
                ⟳ Actualiser
              </button>
            )}
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto">
          {nav.map(([key, label]) => (
            <button key={key} onClick={() => { setView(key); }} className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap ${view === key || (view === "detail" && key === "live") ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {mode === "live" && liveStatus === "error" && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 mb-6">
            <div className="text-red-400 font-semibold text-sm mb-1">Données réelles indisponibles</div>
            <p className="text-xs text-slate-400">{liveError}. Le dashboard n'affiche pas de matchs tant que la connexion à l'API réelle n'est pas rétablie — aucune donnée simulée n'est utilisée en mode Live réel. Vérifiez la configuration de FootballDataService (FOOTBALL_API_KEY, FOOTBALL_API_BASE_URL côté serveur).</p>
          </div>
        )}
        {mode === "live" && liveStatus === "loading" && matches.length === 0 && (
          <div className="text-center text-slate-500 py-16 text-sm">Connexion aux données réelles…</div>
        )}
        {view === "dashboard" && <Dashboard matches={displayedMatches} pressures={pressures} filters={filters} setFilters={setFilters} weights={weights} onOpen={openMatch} />}
        {view === "live" && <Dashboard matches={displayedMatches} pressures={pressures} filters={filters} setFilters={setFilters} weights={weights} onOpen={openMatch} />}
        {view === "detail" && selected && <MatchDetail m={selected} pressure={pressures[selected.id]} onBack={() => setView("dashboard")} />}
        {view === "top" && <TopSignals matches={displayedMatches} pressures={pressures} onOpen={openMatch} />}
        {view === "history" && <HistoryView matches={displayedMatches} />}
        {view === "backtest" && <BacktestView matches={displayedMatches} threshold={threshold} setThreshold={setThreshold} />}
        {view === "settings" && (
          <div className="space-y-8">
            <SettingsView weights={weights} setWeights={setWeights} />
            <AlertsPanel alerts={alerts} alertsEnabled={alertsEnabled} setAlertsEnabled={setAlertsEnabled} />
          </div>
        )}
        {view === "methodology" && <Methodology />}
      </main>
    </div>
  );
      }function formatElapsed(seconds) {
  if (seconds < 5) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds}s`;
  return `il y a ${Math.floor(seconds / 60)} min`;
}

// ---------------- FootballDataService ----------------
// Couche d'accès aux données réelles. Le frontend n'appelle JAMAIS l'API
// football directement (pas de clé API côté client) — il appelle une route
// serveur (ex. Next.js API route) qui, elle, détient FOOTBALL_API_KEY et
// interroge le fournisseur choisi (voir api-live-matches.example.ts fourni
// à part). Cette fonction ne fabrique jamais de données : en cas d'échec,
// elle remonte l'erreur telle quelle, sans repli sur des matchs simulés.
async function fetchLiveMatches() {
  const res = await fetch("/api/live-matches");
  if (!res.ok) throw new Error(`API indisponible (${res.status})`);
  const payload = await res.json();
  return payload.matches.map(normalizeLiveMatch);
}

// ---------------- Root ----------------

export default function LiveGoalAnalyzer() {
  const [mode, setMode] = useState("demo"); // "demo" | "live"
  const [matches, setMatches] = useState(() => TEAM_PAIRS.map((p, i) => makeInitialMatch(i, p)));
  const [view, setView] = useState("dashboard");
  const [selectedId, setSelectedId] = useState(null);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [filters, setFilters] = useState({ half: "all", minuteBand: "all", draw: false, oneGoalGap: false, highPressure: false, minSot: 0 });
  const [alerts, setAlerts] = useState([]);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [threshold, setThreshold] = useState(80);
  const [running, setRunning] = useState(true);
  const [liveStatus, setLiveStatus] = useState("idle"); // idle | loading | ok | error
  const [liveError, setLiveError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [elapsedNow, setElapsedNow] = useState(Date.now());
  const alertsEnabledRef = useRef(alertsEnabled);
  alertsEnabledRef.current = alertsEnabled;

  // Mode démo : simulation locale, comme avant.
  useEffect(() => {
    if (mode !== "demo" || !running) return;
    const id = setInterval(() => {
      setMatches((prev) => {
        const updated = prev.map((m) => (m.finished ? m : tickMatch(m)));
        updated.forEach((m) => {
          const before = prev.find((p) => p.id === m.id);
          if (!before) return;
          const prevScore = computePressure(before, weights).score;
          const newScore = computePressure(m, weights).score;
          if (alertsEnabledRef.current && newScore >= 75 && newScore - prevScore >= 12) {
            setAlerts((al) => [...al, { match: `${m.home} – ${m.away}`, minute: m.minute, score: newScore }]);
          }
        });
        return updated;
      });
    }, 2500);
    return () => clearInterval(id);
  }, [mode, running, weights]);

  // Mode LIVE : interroge le backend à fréquence raisonnable (respecte le
  // rate limiting du fournisseur), fusionne l'historique déjà accumulé pour
  // chaque match plutôt que de le repartir de zéro, et n'affiche jamais de
  // données simulées si l'appel échoue.
  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    const poll = async () => {
      setLiveStatus((s) => (s === "idle" ? "loading" : s));
      try {
        const fresh = await fetchLiveMatches();
        if (cancelled) return;
        setMatches((prev) => fresh.map((f) => {
          const before = prev.find((p) => p.id === f.id);
          const withHistory = before ? { ...f, history: before.history } : f;
          const p = computePressure(withHistory, weights);
          withHistory.history = [...withHistory.history, {
            minute: withHistory.minute, homeShare: p.homeShare,
            sotHome: withHistory.sotHome, sotAway: withHistory.sotAway,
            cornersHome: withHistory.cornersHome, cornersAway: withHistory.cornersAway,
            xgHome: withHistory.xgHome, xgAway: withHistory.xgAway,
            scoreHome: withHistory.scoreHome, scoreAway: withHistory.scoreAway,
            convergenceCount: p.convergence.count, goal: null,
          }];
          if (before) {
            const prevScore = computePressure(before, weights).score;
            if (alertsEnabledRef.current && p.score >= 75 && p.score - prevScore >= 12) {
              setAlerts((al) => [...al, { match: `${f.home} – ${f.away}`, minute: f.minute, score: p.score }]);
            }
          }
          return withHistory;
        }));
        setLiveStatus("ok");
        setLiveError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (cancelled) return;
        // IMPORTANT : on ne bascule jamais sur des données simulées ici.
        setLiveStatus("error");
        setLiveError(e.message || "Erreur inconnue");
      }
    };
    poll();
    // Fréquence raisonnable — à ajuster selon le plan du fournisseur choisi.
    const id = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [mode, weights]);

  useEffect(() => {
    const id = setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pressures = useMemo(() => {
    const map = {};
    matches.forEach((m) => { map[m.id] = computePressure(m, weights); });
    return map;
  }, [matches, weights]);

  const nav = [
    ["dashboard", "Dashboard"],
    ["live", "Matchs Live"],
    ["top", "Analyse"],
    ["history", "Historique"],
    ["backtest", "Statistiques"],
    ["settings", "Paramètres"],
    ["methodology", "Méthodologie"],
  ];

  const openMatch = (id) => { setSelectedId(id); setView("detail"); };
  const selected = matches.find((m) => m.id === selectedId);
  const displayedMatches = mode === "live" && liveStatus !== "ok" ? [] : matches;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="border-b border-slate-800 sticky top-0 bg-slate-950/95 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚽</span>
            <span className="font-black tracking-tight text-slate-100">LIVE GOAL ANALYZER</span>
            {mode === "demo" ? (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/30 ml-1">MODE DÉMO — DONNÉES SIMULÉES</span>
            ) : (
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ml-1 ${liveStatus === "ok" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : liveStatus === "error" ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-slate-700/30 text-slate-300 border-slate-600/40"}`}>
                DONNÉES RÉELLES — LIVE {liveStatus === "ok" && lastUpdated ? `· ${formatElapsed(Math.round((elapsedNow - lastUpdated) / 1000))}` : liveStatus === "loading" ? "· connexion…" : liveStatus === "error" ? "· indisponible" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full border border-slate-700 overflow-hidden text-xs">
              <button onClick={() => setMode("demo")} className={`px-3 py-1.5 ${mode === "demo" ? "bg-slate-800 text-slate-100" : "text-slate-400"}`}>Démo</button>
              <button onClick={() => setMode("live")} className={`px-3 py-1.5 ${mode === "live" ? "bg-slate-800 text-slate-100" : "text-slate-400"}`}>Live réel</button>
            </div>
            {mode === "demo" ? (
              <button onClick={() => setRunning((r) => !r)} className="text-xs px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500">
                {running ? "⏸ Pause" : "▶ Reprendre"}
              </button>
            ) : (
              <button onClick={() => { setLiveStatus("loading"); fetchLiveMatches().then((fresh) => { setMatches(fresh); setLiveStatus("ok"); setLastUpdated(Date.now()); }).catch((e) => { setLiveStatus("error"); setLiveError(e.message); }); }} className="text-xs px-3 py-1.5 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500">
                ⟳ Actualiser
              </button>
            )}
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto">
          {nav.map(([key, label]) => (
            <button key={key} onClick={() => { setView(key); }} className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap ${view === key || (view === "detail" && key === "live") ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {mode === "live" && liveStatus === "error" && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 mb-6">
            <div className="text-red-400 font-semibold text-sm mb-1">Données réelles indisponibles</div>
            <p className="text-xs text-slate-400">{liveError}. Le dashboard n'affiche pas de matchs tant que la connexion à l'API réelle n'est pas rétablie — aucune donnée simulée n'est utilisée en mode Live réel. Vérifiez la configuration de FootballDataService (FOOTBALL_API_KEY, FOOTBALL_API_BASE_URL côté serveur).</p>
          </div>
        )}
        {mode === "live" && liveStatus === "loading" && matches.length === 0 && (
          <div className="text-center text-slate-500 py-16 text-sm">Connexion aux données réelles…</div>
        )}
        {view === "dashboard" && <Dashboard matches={displayedMatches} pressures={pressures} filters={filters} setFilters={setFilters} weights={weights} onOpen={openMatch} />}
        {view === "live" && <Dashboard matches={displayedMatches} pressures={pressures} filters={filters} setFilters={setFilters} weights={weights} onOpen={openMatch} />}
        {view === "detail" && selected && <MatchDetail m={selected} pressure={pressures[selected.id]} onBack={() => setView("dashboard")} />}
        {view === "top" && <TopSignals matches={displayedMatches} pressures={pressures} onOpen={openMatch} />}
        {view === "history" && <HistoryView matches={displayedMatches} />}
        {view === "backtest" && <BacktestView matches={displayedMatches} threshold={threshold} setThreshold={setThreshold} />}
        {view === "settings" && (
          <div className="space-y-8">
            <SettingsView weights={weights} setWeights={setWeights} />
            <AlertsPanel alerts={alerts} alertsEnabled={alertsEnabled} setAlertsEnabled={setAlertsEnabled} />
          </div>
        )}
        {view === "methodology" && <Methodology />}
      </main>
    </div>
  );
}
