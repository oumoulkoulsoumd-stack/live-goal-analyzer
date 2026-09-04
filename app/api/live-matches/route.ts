// EXEMPLE DE RÉFÉRENCE — route serveur qui appelle Sportmonks. La clé API
// (FOOTBALL_API_KEY) reste ici, côté serveur, jamais exposée au frontend.
//
// Variables d'environnement attendues (ajoutées sur Vercel, jamais dans le code) :
//   FOOTBALL_API_KEY=xxxxxxxxxxxxxxxx
//   FOOTBALL_API_BASE_URL=https://api.sportmonks.com/v3/football

async function fetchFromSportmonks() {
  const base = process.env.FOOTBALL_API_BASE_URL;
  const key = process.env.FOOTBALL_API_KEY;
  if (!base || !key) {
    throw new Error("FOOTBALL_API_KEY ou FOOTBALL_API_BASE_URL manquant côté serveur");
  }

  const url = `${base}/livescores?api_token=${key}&include=statistics;events;xgfixture;participants`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Sportmonks a répondu ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function findStat(statistics, typeName, teamId) {
  const row = statistics?.find((s) => s.type?.name === typeName && s.participant_id === teamId);
  return row ? row.data?.value ?? null : null;
}

function normalizeSportmonksFixture(fixture) {
  const home = fixture.participants?.find((p) => p.meta?.location === "home");
  const away = fixture.participants?.find((p) => p.meta?.location === "away");
  const stats = fixture.statistics;

  const xgHome = fixture.xgfixture?.find((x) => x.participant_id === home?.id)?.data?.value ?? null;
  const xgAway = fixture.xgfixture?.find((x) => x.participant_id === away?.id)?.data?.value ?? null;

  return {
    id: String(fixture.id),
    home_team: home?.name ?? "Domicile",
    away_team: away?.name ?? "Extérieur",
    competition: fixture.league?.name ?? "",
    minute: fixture.periods?.find((p) => p.ticking)?.minutes ?? null,
    status: fixture.state?.short_name === "FT" ? "finished" : "live",
    score_home: fixture.scores?.find((s) => s.participant_id === home?.id && s.description === "CURRENT")?.score?.goals ?? null,
    score_away: fixture.scores?.find((s) => s.participant_id === away?.id && s.description === "CURRENT")?.score?.goals ?? null,
    shots_home: findStat(stats, "Shots Total", home?.id),
    shots_away: findStat(stats, "Shots Total", away?.id),
    sot_home: findStat(stats, "Shots On Target", home?.id),
    sot_away: findStat(stats, "Shots On Target", away?.id),
    corners_home: findStat(stats, "Corners", home?.id),
    corners_away: findStat(stats, "Corners", away?.id),
    possession_home: findStat(stats, "Ball Possession %", home?.id),
    xg_home: xgHome,
    xg_away: xgAway,
    dangerous_home: findStat(stats, "Dangerous Attacks", home?.id),
    dangerous_away: findStat(stats, "Dangerous Attacks", away?.id),
    fouls: (findStat(stats, "Fouls", home?.id) ?? 0) + (findStat(stats, "Fouls", away?.id) ?? 0),
    yellow: (findStat(stats, "Yellowcards", home?.id) ?? 0) + (findStat(stats, "Yellowcards", away?.id) ?? 0),
    red: (findStat(stats, "Redcards", home?.id) ?? 0) + (findStat(stats, "Redcards", away?.id) ?? 0),
  };
}

let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 20_000;

export async function GET() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return Response.json({ matches: cache.data, cached: true });
  }

  try {
    const raw = await fetchFromSportmonks();
    const matches = (raw.data ?? []).map(normalizeSportmonksFixture);
    cache = { data: matches, ts: now };
    return Response.json({ matches, cached: false });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Erreur inconnue" },
      { status: 502 }
    );
  }
}
