// ContentPlay — GLOBAL entry (always available, no player window needed).
//
// The panel webview (ui/panel.html) does all the network work via fetch:
// Cinemeta for search/metadata and Torrentio (configured with your debrid
// service key) for streams. It assembles an .m3u playlist of resolved links and
// sends it here. This entry only does the privileged parts:
//   * share the debrid service + key + Torrentio options with the panel
//   * write the .m3u to disk
//   * open it in a new player with createPlayerInstance, where mpv plays it as
//     a native playlist (auto-advances to the next episode)

const { preferences, menu, utils, global, http } = iina;
const log = iina.console;
const win = iina.standaloneWindow;

// Debrid services Torrentio can resolve through. The key is the Torrentio
// config option (e.g. `torbox=<token>`); the name is just for the UI/status.
// Torrentio proxies them all behind the same /resolve/ links, so adding one is
// purely configuration — no new network code.
const DEBRID = {
  realdebrid: "Real-Debrid",
  torbox: "TorBox",
  alldebrid: "AllDebrid",
  premiumize: "Premiumize",
  debridlink: "Debrid-Link",
  offcloud: "Offcloud",
  easydebrid: "EasyDebrid",
  putio: "Put.io",
};

// Selected provider, defaulting to Real-Debrid if unset or unknown.
const debridProvider = () => {
  const p = (preferences.get("debridProvider") || "").trim();
  return DEBRID[p] ? p : "realdebrid";
};
// The token for the selected provider. Falls back to the legacy Real-Debrid-only
// `rdApiKey` field (pre-multi-debrid versions) so existing setups keep working —
// but only while Real-Debrid is the provider, since that token is RD-specific.
const debridKey = () => {
  const k = (preferences.get("debridApiKey") || "").trim();
  if (k) return k;
  return debridProvider() === "realdebrid" ? (preferences.get("rdApiKey") || "").trim() : "";
};

// One-time migration: pre-1.1.0 stored the token under `rdApiKey`. Copy it into
// the new service-agnostic `debridApiKey` so it shows in the settings field
// instead of looking blank (and "lost") after the update. Runs at plugin load,
// before the panel or prefs page reads anything.
(function migrateLegacyKey() {
  const legacy = (preferences.get("rdApiKey") || "").trim();
  const current = (preferences.get("debridApiKey") || "").trim();
  if (legacy && !current) {
    preferences.set("debridApiKey", legacy);
    if (!(preferences.get("debridProvider") || "").trim()) preferences.set("debridProvider", "realdebrid");
    preferences.sync();
    log.log("ContentPlay migrated Real-Debrid token to debridApiKey.");
  }
})();

const pref = (key, fallback) => {
  const v = preferences.get(key);
  return v === undefined || v === null || v === "" ? fallback : v;
};

const toUI = (name, data) => win.postMessage(name, data);
const status = (message) => toUI("status", { message });

// Keys the panel UI is allowed to persist (so a Discover choice survives restarts
// — and so the TMDB key can be saved reliably from the panel, since IINA's
// settings page drops writes to keys it didn't register at install). Writes go
// straight to disk with sync().
const SAVEABLE = { discoverLang: true, tmdbApiKey: true };
function savePref(key, value) {
  if (!SAVEABLE[key]) return;
  preferences.set(key, typeof value === "string" ? value : "");
  preferences.sync();
}

// Everything the panel needs to resolve streams and browse catalogs. The panel
// does the network work, so it gets the full config. Built once here and shared
// by both surfaces that show the panel UI (ui/panel.html): the standalone Search
// window (below) and the per-player Sidebar tab (index.js relays this over the
// global↔instance message bus, so there is only ever one copy of this config).
// "S6E22 · resume 14:10" on a Recently played tile, from the resume points the
// player (index.js) keeps in the "progress" preference.
function withResume(list) {
  let P = {};
  try { P = JSON.parse(preferences.get("progress") || "{}") || {}; } catch (e) {}
  return list.map((r) => {
    let best = null, bestSid = "";
    for (const sid of Object.keys(P)) if ((sid === r.id || sid.indexOf(r.id + ":") === 0) && (!best || P[sid].at > best.at)) { best = P[sid]; bestSid = sid; }
    if (!best) return r;
    const parts = bestSid.split(":");
    const clock = Math.floor(best.t / 60) + ":" + String(Math.floor(best.t % 60)).padStart(2, "0");
    return Object.assign({}, r, { resume: (parts[1] ? "S" + parts[1] + "E" + parts[2] + " · " : "") + "resume " + clock });
  });
}

// Remove a title from Recently played, along with its resume points.
function removeRecent(id) {
  if (!id) return;
  preferences.set("recent", JSON.stringify(loadRecent().filter((r) => r.id !== id)));
  try {
    const P = JSON.parse(preferences.get("progress") || "{}") || {};
    for (const sid of Object.keys(P)) if (sid === id || sid.indexOf(id + ":") === 0) delete P[sid];
    preferences.set("progress", JSON.stringify(P));
  } catch (e) {}
  preferences.sync();
}

function buildState() {
  const provider = debridProvider();
  return {
    debridConfigured: !!debridKey(),
    debridKey: debridKey(),
    debridProvider: provider,
    debridName: DEBRID[provider],
    torrentioOptions: (preferences.get("torrentioOptions") || "").trim(),
    preferredQuality: pref("preferredQuality", "720p"),
    understoodLangs: pref("understoodLangs", "en,hi,te"),
    audioPriority: pref("audioPriority", "orig,te,en"),
    subtitleLangs: pref("subtitleLangs", "en"),
    // Discovery: which understood language to feature, and the optional TMDB key
    // that makes language/genre filtering actually re-rank the Discover boards.
    discoverLang: (preferences.get("discoverLang") || "").trim(),
    tmdbApiKey: (preferences.get("tmdbApiKey") || "").trim(),
    avoid3D: pref("avoid3D", true) !== false,
    avoidHDR: pref("avoidHDR", true) !== false,
    avoidHardSubs: pref("avoidHardSubs", true) !== false,
    maxAlternates: parseInt(pref("maxAlternates", "6"), 10) || 6,
    concurrency: parseInt(pref("concurrency", "6"), 10) || 6,
    cinemetaUrl: (pref("cinemetaUrl", "https://v3-cinemeta.strem.io") || "").trim(),
    torrentioUrl: (pref("torrentioUrl", "https://torrentio.strem.fun") || "").trim(),
    recent: withResume(loadRecent()),
  };
}
function sendState() {
  toUI("state", buildState());
}

// Recently played titles, newest first, shown on the empty search screen.
// Kept in preferences so they survive restarts (webview storage may not).
const RECENT_MAX = 8;
function loadRecent() {
  try {
    const list = JSON.parse(preferences.get("recent") || "[]");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}
function addRecent(item) {
  if (!item || !item.id) return;
  const list = [item].concat(loadRecent().filter((r) => r.id !== item.id));
  preferences.set("recent", JSON.stringify(list.slice(0, RECENT_MAX)));
  preferences.sync();
}

// Write the playlist to ~/Library/Caches/ContentPlay/<name> and echo its
// absolute path. `~` rather than $HOME: utils.exec runs with an empty
// environment, but bash tilde expansion still resolves via the password db.
// The m3u text is a positional arg, so the shell never interprets it.
async function writeFile(name, text) {
  const script =
    'd=~/Library/Caches/ContentPlay; mkdir -p "$d"; f="$d/$1"; ' +
    'printf "%s" "$2" > "$f"; printf "%s" "$f"';
  const res = await utils.exec("/bin/bash", ["-c", script, "cp", name, text]);
  if (res.status !== 0) throw new Error(res.stderr || "exit " + res.status);
  return res.stdout.trim();
}

// Audio/subtitle languages per playlist file, read by the main entry (index.js)
// when each file loads. The newest is also kept as a fallback in case mpv
// can't report which playlist a file came from.
const LANG_MAX = 20;
function saveLang(file, lang) {
  if (!lang) return;
  let map = {};
  try {
    map = JSON.parse(preferences.get("langByPlaylist") || "{}") || {};
  } catch (e) {}
  delete map[file];
  map[file] = lang;
  const keys = Object.keys(map);
  keys.slice(0, Math.max(0, keys.length - LANG_MAX)).forEach((k) => delete map[k]);
  preferences.set("langByPlaylist", JSON.stringify(map));
  preferences.set("lastLang", JSON.stringify(lang));
  preferences.sync();
}

// Alternate streams per playlist file: streams[n] is the ranked list of
// candidates [{ u, l }] for playlist item n (n = mpv playlist position), the
// first being the one written into the .m3u. index.js reads this to switch the
// playing episode to another stream. Streams are bulkier than langs (full RD
// URLs), so keep fewer playlists around.
const STREAMS_MAX = 8;
function saveStreams(file, streams) {
  if (!streams || !streams.length) return;
  let map = {};
  try {
    map = JSON.parse(preferences.get("streamsByPlaylist") || "{}") || {};
  } catch (e) {}
  delete map[file];
  map[file] = streams;
  const keys = Object.keys(map);
  keys.slice(0, Math.max(0, keys.length - STREAMS_MAX)).forEach((k) => delete map[k]);
  preferences.set("streamsByPlaylist", JSON.stringify(map));
  preferences.sync();
}

// Open in a fresh player. A plain absolute path (not a file:// URL) is what
// createPlayerInstance's path handling expects. enablePlugins keeps your other
// plugins (subtitles, scrobblers) active in that window.
async function openPlaylist(name, text, lang, streams) {
  const safe = (name || "contentplay").replace(/[^\w.\-]+/g, "_");
  const file = safe.endsWith(".m3u") ? safe : safe + ".m3u";
  const path = await writeFile(file, text);
  saveLang(file, lang);
  saveStreams(file, streams);
  log.log("ContentPlay opening: " + path);
  global.createPlayerInstance({ url: path, enablePlugins: true });
  return file;
}

// The privileged "play this" step, shared by both surfaces (Search window and
// Sidebar tab): write the .m3u, remember the title, open a fresh player. Callers
// report status their own way (the window updates its footer; the sidebar relay
// messages the originating player). Keeping this in one place is why the sidebar
// needs no duplicate of the open/recent logic.
async function handleOpen(payload) {
  const { name, text, recent, lang, streams } = payload || {};
  await openPlaylist(name, text, lang, streams);
  addRecent(recent);
}

// IMDb's title suggestions (popularity-ranked, typo-tolerant) for the panel's
// search. The endpoint sends no CORS headers, so the webview can't fetch it
// itself; only the fields the panel uses are sent back.
async function imdbSuggest(q) {
  const s = String(q || "").trim().toLowerCase().slice(0, 100);
  if (!s) return [];
  const res = await http.get(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(s)}.json`);
  if (res.statusCode && res.statusCode >= 400) throw new Error("HTTP " + res.statusCode);
  const d = typeof res.data === "object" && res.data ? res.data : JSON.parse(res.text || res.data || "{}");
  return (d.d || []).filter((x) => /^tt\d+$/.test(x.id || "")).map((x) => ({
    id: x.id, l: x.l, qid: x.qid, y: x.y, yr: x.yr, rank: x.rank, img: x.i && x.i.imageUrl,
  }));
}

// ---------------------------------------------------------------------------
// Panel. loadFile() clears every onMessage listener, so the listeners must be
// registered after it, on each open.
// ---------------------------------------------------------------------------
function openPanel() {
  win.loadFile("ui/panel.html");

  win.onMessage("ready", () => sendState());

  win.onMessage("open", async (payload) => {
    try {
      status("Opening in IINA…");
      await handleOpen(payload);
      sendState();
      status("Now playing in IINA");
    } catch (e) {
      log.error("ContentPlay open failed: " + e.message);
      status("Couldn’t open in IINA: " + e.message);
    }
  });

  win.onMessage("savePref", (d) => savePref(d && d.key, d && d.value));
  win.onMessage("removeRecent", (d) => removeRecent(d && d.id));
  win.onMessage("imdbSuggest", async (d) => {
    if (!d || !d.key) return;
    try { toUI("imdbSuggest", { key: d.key, items: await imdbSuggest(d.q) }); }
    catch (e) { log.log("ContentPlay IMDb search failed: " + e.message); toUI("imdbSuggest", { key: d.key, failed: true }); }
  });

  win.setProperty({ title: "ContentPlay", resizable: true });
  win.setFrame(760, 720);   // wide enough for the Discover poster grid
  win.open();
}

function closePanel() {
  win.close();
}

// ---------------------------------------------------------------------------
// Sidebar relay. The Sidebar tab (index.js, per-player) shows the same panel UI
// but, being a main entry, can't write files or spawn players. It builds its own
// (read-only) state from preferences, so the only thing it forwards here is the
// privileged "open" — which runs the shared handleOpen and then sends the player
// a fresh state so its Recently-played updates. `player` (the sender's instance
// id) can be absent for an ordinary window; null then broadcasts to all, which
// still reaches the right sidebar (each window relays only to its own).
// ---------------------------------------------------------------------------
const reply = (player, name, data) => global.postMessage(player != null ? player : null, name, data);
global.onMessage("cp-open", async (payload, player) => {
  try {
    await handleOpen(payload);
    reply(player, "cp-status", { message: "Now playing in IINA" });
    reply(player, "cp-state", buildState());   // refresh Recently played
  } catch (e) {
    log.error("ContentPlay sidebar open failed: " + e.message);
    reply(player, "cp-status", { message: "Couldn’t open in IINA: " + e.message });
  }
});

// ---------------------------------------------------------------------------
// Menu (global items are always available, even on the welcome window).
// Shortcuts come from preferences so they can be rebound; a blank value just
// registers the item without a key.
// ---------------------------------------------------------------------------
const kb = (key) => {
  const v = (preferences.get(key) || "").trim();
  return v ? { keyBinding: v } : {};
};
menu.addItem(menu.item("Discover & Search…", openPanel, kb("kbOpenPanel")));
menu.addItem(menu.item("Close Window", closePanel, kb("kbClosePanel")));

log.log("ContentPlay global entry loaded.");
