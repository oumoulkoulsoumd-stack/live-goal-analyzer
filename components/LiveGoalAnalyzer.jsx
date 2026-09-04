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
