import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TVDB_API_KEY = process.env.TVDB_API_KEY || '';
const WEBHOOKS = (process.env.WEBHOOKS || '').split(',').map(s => s.trim()).filter(Boolean);

const account = {
  id: Number(process.env.PLEX_ACCOUNT_ID || ''),
  title: process.env.PLEX_ACCOUNT_TITLE || '',
  thumb: process.env.PLEX_ACCOUNT_THUMB || ''
};

const serverInfo = {
  title: process.env.PLEX_SERVER_TITLE || '',
  uuid: process.env.PLEX_SERVER_UUID || ''
};

const playerInfo = {
  local: true,
  publicAddress: '',
  title: process.env.PLEX_PLAYER_TITLE || 'PHONE',
  uuid: process.env.PLEX_PLAYER_UUID || 'mobile-relay'
};

// --- TVDB ---

let tvdbToken = null;
let tvdbTokenFetchedAt = 0;

async function tvdbLogin() {
  const body = { apikey: TVDB_API_KEY };
  if (process.env.TVDB_PIN) body.pin = process.env.TVDB_PIN;

  const r = await fetch('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));
  const token = data?.data?.token;
  if (!r.ok || !token) throw new Error(`TVDB login failed: ${r.status}`);

  tvdbToken = token;
  tvdbTokenFetchedAt = Date.now();
}

async function tvdbRefresh() {
  const r = await fetch('https://api4.thetvdb.com/v4/refresh_token', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${tvdbToken}`
    }
  });

  const data = await r.json().catch(() => ({}));
  const token = data?.data?.token || data?.token;
  if (!r.ok || !token) throw new Error(`TVDB refresh failed: ${r.status}`);

  tvdbToken = token;
  tvdbTokenFetchedAt = Date.now();
}

async function ensureTvdbToken() {
  if (!tvdbToken) {
    await tvdbLogin();
    return;
  }

  const ageHours = (Date.now() - tvdbTokenFetchedAt) / 36e5;
  if (ageHours > 20) {
    try {
      await tvdbRefresh();
    } catch {
      tvdbToken = null;
      await tvdbLogin();
    }
  }
}

async function fetchTvdbId(remoteId) {
  if (!TVDB_API_KEY) return null;
  if (!remoteId) return null;

  await ensureTvdbToken();

  const request = async () => {
    const url = `https://api4.thetvdb.com/v4/search/remoteid/${encodeURIComponent(remoteId)}`;
    return fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tvdbToken}`
      }
    });
  };

  let r = await request();

  if (r.status === 401) {
    tvdbToken = null;
    await tvdbLogin();
    r = await request();
  }

  if (!r.ok) return null;

  const data = await r.json().catch(() => ({}));
  const item = data?.data?.[0];

  return item?.movie?.id ?? item?.series?.id ?? item?.episode?.id ?? item?.people?.id ?? item?.season?.id ?? null;

}

// --- Health ---

app.get('/health', (_req, res) => {
  res.json({ ok: true, tmdb: Boolean(TMDB_API_KEY), tvdb: Boolean(TVDB_API_KEY), webhooks: WEBHOOKS.length });
});

// --- TMDB ---

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'movie');
    const year = String(req.query.year || '').trim();
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    if (!q) return res.status(400).json({ error: 'Missing q' });
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    url.searchParams.set('query', q);
    if (year && endpoint === 'movie') url.searchParams.set('year', year);
    if (year && endpoint === 'tv') url.searchParams.set('first_air_date_year', year);
    const r = await fetch(url);
    const data = await r.json();
    const results = (data.results || []).slice(0, 12).map(item => ({
      id: item.id,
      type: endpoint,
      title: endpoint === 'movie' ? item.title : item.name,
      originalTitle: endpoint === 'movie' ? item.original_title : item.original_name,
      year: (endpoint === 'movie' ? item.release_date : item.first_air_date || '').slice(0, 4),
      overview: item.overview,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : null
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function tmdbDetails(type, id) {
  const endpoint = type === 'tv' ? 'tv' : 'movie';
  const detailsUrl = new URL(`https://api.themoviedb.org/3/${endpoint}/${id}`);
  detailsUrl.searchParams.set('api_key', TMDB_API_KEY);
  detailsUrl.searchParams.set('append_to_response', 'external_ids,credits');
  const r = await fetch(detailsUrl);
  if (!r.ok) throw new Error(`TMDb details failed: ${r.status}`);
  return r.json();
}

async function postWebhook(url, payload) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  try {
    const r = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(500)
    });
    return { url, ok: r.ok, status: r.status };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { url, ok: false, status: timedOut ? 'timeout' : 'failed', error: e.message };
  }
}

// --- Movie payload ---

async function guidArrayForMovie(details) {
  const out = [];
  const imdbId = details.external_ids?.imdb_id;
  const tmdbId = details.id;
  const tvdbId = details.external_ids?.tvdb_id;

  if (imdbId) out.push({ id: `imdb://${imdbId}` });
  if (tmdbId) out.push({ id: `tmdb://${tmdbId}` });

  if (tvdbId) {
    out.push({ id: `tvdb://${tvdbId}` });
  } else if (imdbId) {
    try {
      const fetchedTvdbId = await fetchTvdbId(imdbId);
      if (fetchedTvdbId) out.push({ id: `tvdb://${fetchedTvdbId}` });
      else console.warn(`No TVDB id found for imdbId ${imdbId}`);
    } catch (e) {
      console.warn(`TVDB lookup failed for imdbId ${imdbId}: ${e.message}`);
    }
  }

  return out;
}

async function buildMoviePayload(details) {
  const title = details.title || details.original_title;
  const originalTitle = details.original_title || details.title;
  const year = Number((details.release_date || '').slice(0, 4)) || null;
  const guid = `plex://movie/tmdb-${details.id}`;
  const slug = `${(originalTitle || title || 'movie').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${year || ''}`;
  return {
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w342${details.poster_path}` : null,
    event: 'media.scrobble',
    user: true,
    owner: true,
    Account: account,
    Server: serverInfo,
    Player: playerInfo,
    Metadata: {
      librarySectionType: 'movie',
      ratingKey: String(details.id),
      key: `/library/metadata/${details.id}`,
      guid,
      slug,
      type: 'movie',
      title,
      originalTitle,
      librarySectionTitle: process.env.PLEX_LIBRARY_MOVIES_TITLE || 'Films',
      librarySectionID: Number(process.env.PLEX_LIBRARY_MOVIES_ID || 2),
      librarySectionKey: `/library/sections/${process.env.PLEX_LIBRARY_MOVIES_ID || 2}`,
      summary: details.overview || '',
      Director: (details.credits?.crew || []).filter(x => x.job === 'Director').slice(0,1).map(x => ({ tag: x.name })),
      audienceRating: details.vote_average || 0,
      viewCount: 1,
      lastViewedAt: Math.floor(Date.now() / 1000),
      year,
      tagline: details.tagline || '',
      duration: details.runtime ? details.runtime * 60 * 1000 : 0,
      originallyAvailableAt: details.release_date || '',
      addedAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      Guid: await guidArrayForMovie(details)
    }
  };
}

app.get('/api/payload/movie/:id', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const details = await tmdbDetails('movie', req.params.id);
    res.json(await buildMoviePayload(details));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/movie/:id', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const details = await tmdbDetails('movie', req.params.id);
    const payload = await buildMoviePayload(details);
    const results = [];
    const results = await Promise.all(WEBHOOKS.map(url => postWebhook(url, payload)));
    // for (const url of WEBHOOKS) {
    //   try {
    //     const form = new FormData();
    //     form.append('payload', JSON.stringify(payload));
    //     const r = await fetch(url, {
    //       method: 'POST',
    //       body: form
    //     });
    //     results.push({ url, ok: r.ok, status: r.status });
    //   } catch (e) {
    //     results.push({ url, ok: false, error: e.message });
    //   }
    // }
    res.json({ sent: results, payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Episode payload ---

async function tmdbEpisodeDetails(showId, seasonNumber, episodeNumber) {
  const url = new URL(`https://api.themoviedb.org/3/tv/${showId}/season/${seasonNumber}/episode/${episodeNumber}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('append_to_response', 'external_ids,credits');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TMDb episode details failed: ${r.status}`);
  return r.json();
}

function guidArrayForEpisode(showDetails, episodeDetails) {
  const out = [];
  if (episodeDetails.external_ids?.imdb_id) out.push({ id: `imdb://${episodeDetails.external_ids.imdb_id}` });
  if (episodeDetails.id) out.push({ id: `tmdb://${episodeDetails.id}` });
  if (episodeDetails.external_ids?.tvdb_id) out.push({ id: `tvdb://${episodeDetails.external_ids.tvdb_id}` });
  return out;
}

function buildEpisodePayload(showDetails, episodeDetails, seasonNumber, episodeNumber) {
  const showTitle = showDetails.name || showDetails.original_name;
  const episodeTitle = episodeDetails.name;
  const originalTitle = episodeDetails.name;
  const year = Number((showDetails.first_air_date || '').slice(0, 4)) || null;
  return {
    poster: showDetails.poster_path ? `https://image.tmdb.org/t/p/w342${showDetails.poster_path}` : null,
    event: 'media.scrobble',
    user: true,
    owner: true,
    Account: account,
    Server: serverInfo,
    Player: playerInfo,
    Metadata: {
      librarySectionType: 'show',
      ratingKey: String(episodeDetails.id),
      key: `/library/metadata/${episodeDetails.id}`,
      parentRatingKey: `${showDetails.id}-s${seasonNumber}`,
      grandparentRatingKey: String(showDetails.id),
      guid: `plex://episode/tmdb-${episodeDetails.id}`,
      parentGuid: `plex://season/tmdb-${showDetails.id}-${seasonNumber}`,
      grandparentGuid: `plex://show/tmdb-${showDetails.id}`,
      grandparentSlug: (showTitle || 'show').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      type: 'episode',
      title: episodeTitle,
      grandparentKey: `/library/metadata/${showDetails.id}`,
      parentKey: `/library/metadata/${showDetails.id}/season/${seasonNumber}`,
      librarySectionTitle: process.env.PLEX_LIBRARY_SHOWS_TITLE || 'Séries TV',
      librarySectionID: Number(process.env.PLEX_LIBRARY_SHOWS_ID || 3),
      librarySectionKey: `/library/sections/${process.env.PLEX_LIBRARY_SHOWS_ID || 3}`,
      grandparentTitle: showTitle,
      parentTitle: `Season ${seasonNumber}`,
      originalTitle,
      summary: episodeDetails.overview || '',
      index: Number(episodeNumber),
      parentIndex: Number(seasonNumber),
      audienceRating: episodeDetails.vote_average || 0,
      viewCount: 1,
      lastViewedAt: Math.floor(Date.now() / 1000),
      year,
      duration: episodeDetails.runtime ? episodeDetails.runtime * 60 * 1000 : 0,
      originallyAvailableAt: episodeDetails.air_date || '',
      addedAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      Guid: guidArrayForEpisode(showDetails, episodeDetails)
    }
  };
}

app.get('/api/tv/:id/seasons', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const showDetails = await tmdbDetails('tv', req.params.id);
    const seasons = (showDetails.seasons || [])
      .filter(s => Number(s.season_number) > 0)
      .map(s => ({
        seasonNumber: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodeCount: s.episode_count || 0,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w185${s.poster_path}` : null
      }));
    res.json({
      showId: showDetails.id,
      showTitle: showDetails.name || showDetails.original_name,
      seasons
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tv/:id/season/:season/episodes', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const url = new URL(`https://api.themoviedb.org/3/tv/${req.params.id}/season/${req.params.season}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`TMDb season details failed: ${r.status}`);
    const data = await r.json();
    const episodes = (data.episodes || []).map(ep => ({
      episodeNumber: ep.episode_number,
      seasonNumber: ep.season_number,
      name: ep.name,
      airDate: ep.air_date || '',
      runtime: ep.runtime || 0,
      still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null
    }));
    res.json({
      seasonNumber: data.season_number,
      seasonName: data.name,
      episodes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/payload/episode', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const showId = req.query.showId;
    const season = req.query.season;
    const episode = req.query.episode;
    if (!showId || !season || !episode) return res.status(400).json({ error: 'Missing showId, season, or episode' });
    const showDetails = await tmdbDetails('tv', showId);
    const episodeDetails = await tmdbEpisodeDetails(showId, season, episode);
    res.json(buildEpisodePayload(showDetails, episodeDetails, season, episode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/episode', async (req, res) => {
  try {
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'TMDB_API_KEY missing' });
    const { showId, season, episode } = req.body || {};
    if (!showId || !season || !episode) return res.status(400).json({ error: 'Missing showId, season, or episode' });
    const showDetails = await tmdbDetails('tv', showId);
    const episodeDetails = await tmdbEpisodeDetails(showId, season, episode);
    const payload = buildEpisodePayload(showDetails, episodeDetails, season, episode);
    const results = await Promise.all(WEBHOOKS.map(url => postWebhook(url, payload)));
    // const results = [];
    // for (const url of WEBHOOKS) {
    //   try {
    //     const form = new FormData();
    //     form.append('payload', JSON.stringify(payload));
    //     const r = await fetch(url, {
    //       method: 'POST',
    //       body: form
    //     });
    //     results.push({ url, ok: r.ok, status: r.status });
    //   } catch (e) {
    //     results.push({ url, ok: false, error: e.message });
    //   }
    // }
    res.json({ sent: results, payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`scrobble relay listening on ${PORT}`));
