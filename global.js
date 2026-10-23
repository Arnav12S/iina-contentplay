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

const { preferences, menu, utils, global } = iina;
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

const pref = (key, fallback) => {
  const v = preferences.get(key);
  return v === undefined || v === null || v === "" ? fallback : v;
};

const toUI = (name, data) => win.postMessage(name, data);
const status = (message) => toUI("status", { message });

// Everything the panel needs to resolve streams. The panel does the network
// work, so it gets the full config; only the keyboard shortcuts stay here.
function sendState() {
  const provider = debridProvider();
  toUI("state", {
    debridConfigured: !!debridKey(),
    debridKey: debridKey(),
    debridProvider: provider,
    debridName: DEBRID[provider],
    torrentioOptions: (preferences.get("torrentioOptions") || "").trim(),
    preferredQuality: pref("preferredQuality", "720p"),
    understoodLangs: pref("understoodLangs", "en,hi,te"),
    audioPriority: pref("audioPriority", "orig,te,en"),
    subtitleLangs: pref("subtitleLangs", "en"),
    avoid3D: pref("avoid3D", true) !== false,
    avoidHDR: pref("avoidHDR", true) !== false,
    maxAlternates: parseInt(pref("maxAlternates", "6"), 10) || 6,
    concurrency: parseInt(pref("concurrency", "6"), 10) || 6,
    cinemetaUrl: (pref("cinemetaUrl", "https://v3-cinemeta.strem.io") || "").trim(),
    torrentioUrl: (pref("torrentioUrl", "https://torrentio.strem.fun") || "").trim(),
    recent: loadRecent(),
  });
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

// ---------------------------------------------------------------------------
// Panel. loadFile() clears every onMessage listener, so the listeners must be
// registered after it, on each open.
// ---------------------------------------------------------------------------
function openPanel() {
  win.loadFile("ui/panel.html");

  win.onMessage("ready", () => sendState());

  win.onMessage("open", async ({ name, text, recent, lang, streams }) => {
    try {
      status("Opening in IINA…");
      await openPlaylist(name, text, lang, streams);
      addRecent(recent);
      sendState();
      status("Now playing in IINA");
    } catch (e) {
      log.error("ContentPlay open failed: " + e.message);
      status("Couldn’t open in IINA: " + e.message);
    }
  });

  win.setProperty({ title: "Search", resizable: true });
  win.setFrame(440, 680);
  win.open();
}

function closePanel() {
  win.close();
}

// ---------------------------------------------------------------------------
// Menu (global items are always available, even on the welcome window).
// Shortcuts come from preferences so they can be rebound; a blank value just
// registers the item without a key.
// ---------------------------------------------------------------------------
const kb = (key) => {
  const v = (preferences.get(key) || "").trim();
  return v ? { keyBinding: v } : {};
};
menu.addItem(menu.item("Search…", openPanel, kb("kbOpenPanel")));
menu.addItem(menu.item("Close Search", closePanel, kb("kbClosePanel")));

log.log("ContentPlay global entry loaded.");
