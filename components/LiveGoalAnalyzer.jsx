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
