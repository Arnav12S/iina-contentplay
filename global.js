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
    downloadQuality: (preferences.get("downloadQuality") || "").trim(),
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
let showDownloadsOnReady = false;   // Plugins ▸ Downloads… opens the panel on its Downloads view
function openPanel() {
  win.loadFile("ui/panel.html");

  win.onMessage("ready", () => {
    sendState();
    if (showDownloadsOnReady) { showDownloadsOnReady = false; toUI("showDownloads", {}); }
  });

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
  win.onMessage("download", async (d) => { await dlLoaded; toUI("dlAdded", dlAdd(d && d.items)); });
  win.onMessage("dlAction", (a) => dlAction(a));
  win.onMessage("dlGet", async () => { await dlLoaded; await dlCheckFiles(); toUI("downloads", dlView()); });
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
// Downloads. Each one is a detached curl (run by a small bash worker) that
// writes "<file>.part" and renames it when complete, so it keeps going when the
// panel or player closes, carries on across an IINA restart, and resumes from
// where it stopped. A failed stream falls through to the next alternate. The
// list lives in ~/Library/Application Support/ContentPlay/downloads.json (its
// stream links carry the debrid key, like streamsByPlaylist does).
// ---------------------------------------------------------------------------
const DL_WORKER = String.raw`# ContentPlay download worker: fetches one URL to "$dest", resuming any
# "$dest.part". Leaves <state>/<id>.hdr (response headers, for the total size),
# <id>.err (curl's message) and, when it ends on its own, <id>.rc (exit code).
id=$1; url=$2; dest=$3; s=$4
part="$dest.part"; c=
trap '[ -n "$c" ] && kill "$c" 2>/dev/null; exit 143' TERM INT HUP
rm -f "$s/$id.rc"
mkdir -p "$(dirname "$dest")" || { echo 73 > "$s/$id.rc"; exit 73; }
get() {
  curl -L -f -sS --retry 5 --retry-delay 5 --connect-timeout 20 --speed-limit 1024 --speed-time 120 \
       -A "Mozilla/5.0 (Macintosh) ContentPlay" "$@" -D "$s/$id.hdr" -o "$part" "$url" 2> "$s/$id.err" &
  c=$!; wait "$c"; rc=$?; c=
}
get -C -
# 33: the server ignored the resume range; start the file over.
if [ $rc -eq 33 ]; then rm -f "$part"; get; fi
# 416: nothing left to fetch, the .part is already whole.
if [ $rc -eq 22 ] && grep -q "^HTTP/[0-9.]* 416" "$s/$id.hdr" 2>/dev/null; then rc=0; fi
if [ $rc -eq 0 ]; then mv -f "$part" "$dest" || rc=74; fi
echo $rc > "$s/$id.rc"
`;
// args: state dir, then (id pid dest) triples -> "id|bytes|alive|rc|total|error"
const DL_STATUS = String.raw`s=$1; shift
while [ $# -ge 3 ]; do
  id=$1; pid=$2; f=$3; shift 3
  b=$(stat -f%z "$f.part" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
  a=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && a=1
  rc=$(cat "$s/$id.rc" 2>/dev/null)
  t=$(tr -d '\r' < "$s/$id.hdr" 2>/dev/null | awk '/^HTTP\//{r="";l=""} tolower($1)=="content-range:"{n=split($3,x,"/"); r=x[n]} tolower($1)=="content-length:"{l=$2} END{print (r!=""&&r!="*")?r:l+0}')
  e=; [ -n "$rc" ] && [ "$rc" != 0 ] && e=$(tail -n 1 "$s/$id.err" 2>/dev/null | tr '|\n' '  ')
  echo "$id|$b|$a|$rc|$t|$e"
done
`;
// Runs a bash snippet with H (home), A (our support folder), S (worker state)
// and xp (expand a leading ~) defined. utils.exec gives an empty environment,
// so home comes from the password database. Values are positional args, never
// spliced into the script.
function sh(script, args) {
  const pre = 'H=~; [ -n "$H" ] || eval "H=~$(id -un)"; A="$H/Library/Application Support/ContentPlay"; S="$A/dl"; mkdir -p "$S"; ' +
    'xp() { case $1 in "~") printf %s "$H";; "~/"*) printf %s "$H/${1#"~/"}";; *) printf %s "$1";; esac; }; ';
  return utils.exec("/bin/bash", ["-c", pre + script, "cp"].concat((args || []).map(String)));
}

// Timers: IINA provides setTimeout to plugin scripts; fall back to a sleep
// process just in case, since the poll and saves depend on it.
const later = typeof setTimeout === "function"
  ? (fn, ms) => setTimeout(fn, ms)
  : (fn, ms) => { utils.exec("/bin/sleep", [String(ms / 1000)]).then(fn, fn); return 1; };

let dl = [];
let dlPollTimer = null, dlSaveTimer = null, dlPolling = false;
const dlMax = () => Math.max(1, Math.min(6, parseInt(pref("maxDownloads", "2"), 10) || 2));
const dlDir = () => (pref("downloadDir", "~/Movies/ContentPlay") || "").trim() || "~/Movies/ContentPlay";
const dlFind = (id) => dl.find((d) => d.id === id);
const pad2 = (n) => String(n).padStart(2, "0");

async function dlLoad() {
  try {
    const r = await sh('cat "$A/downloads.json" 2>/dev/null; true');
    const list = JSON.parse((r.stdout || "").trim() || "[]");
    if (Array.isArray(list)) dl = list.filter((d) => d && d.id && d.sid);
  } catch (e) { log.log("ContentPlay downloads list unreadable: " + e.message); }
  try { await sh('printf "%s" "$1" > "$A/cp-dl.sh"; printf "%s" "$2" > "$A/cp-dlstat.sh"', [DL_WORKER, DL_STATUS]); }
  catch (e) { log.error("ContentPlay couldn't install the download worker: " + e.message); }
  await dlCheckFiles();
  // Downloads that were running when IINA quit are either still going (curl is
  // detached), finished, or died with the Mac; the poll sorts out which.
  dlPump();
  dlPoll();
}
const dlLoaded = dlLoad();

function dlSave() {
  if (dlSaveTimer) return;   // a save is already scheduled; it writes the latest list
  dlSaveTimer = later(() => {
    dlSaveTimer = null;
    sh('printf "%s" "$1" > "$A/downloads.json.tmp" && mv -f "$A/downloads.json.tmp" "$A/downloads.json"', [JSON.stringify(dl)])
      .catch((e) => log.error("ContentPlay couldn't save downloads: " + e.message));
  }, 300);
}

// What the panels see: no stream links (they carry the debrid key).
function dlView() {
  return dl.map((d) => ({
    id: d.id, sid: d.sid, imdb: d.imdb, kind: d.kind, show: d.show, title: d.title, season: d.season, episode: d.episode,
    year: d.year, poster: d.poster, label: (d.alts[d.alt] || {}).l || "", status: d.status, got: d.got || 0, total: d.total || 0,
    speed: Math.round(d.speed || 0), error: d.error || "", path: d.path || "", alt: d.alt, alts: d.alts.length,
  }));
}
function dlBroadcast() {
  const v = dlView();
  try { toUI("downloads", v); } catch (e) {}
  try { global.postMessage(null, "cp-downloads", v); } catch (e) {}
}
function dlNotify(text) {
  utils.exec("/usr/bin/osascript", ["-e", "on run a", "-e", 'display notification (item 1 of a) with title "ContentPlay"', "-e", "end run", text]).catch(() => {});
}

// "Show (Year)" or "Show S01E02 · Title", for lists and notifications.
function dlName(d) {
  if (d.kind === "movie") return d.show + (d.year ? ` (${d.year})` : "");
  return `${d.show} S${pad2(d.season)}E${pad2(d.episode)}` + (d.title ? ` · ${d.title}` : "");
}
// Library layout media servers understand:
//   Movies/Title (Year).mkv
//   TV/Show/Season 01/Show - S01E02 - Title.mkv
const clean = (s) => String(s || "").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120);
function dlRel(d, url) {
  let ext = "mkv";
  try {
    const last = decodeURIComponent(String(url).split("?")[0].split("/").pop() || "");
    const m = last.match(/\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i);
    if (m) ext = m[1].toLowerCase();
  } catch (e) {}
  const show = clean(d.show) || d.imdb;
  if (d.kind === "movie") {
    const t = show + (d.year ? ` (${d.year})` : "");
    return `Movies/${t}.${ext}`;
  }
  const ep = `S${pad2(d.season)}E${pad2(d.episode)}`;
  return `TV/${show}/Season ${pad2(d.season)}/${show} - ${ep}${d.title ? " - " + clean(d.title) : ""}.${ext}`;
}

function dlPump() {
  let running = dl.filter((d) => d.status === "downloading").length;
  for (const d of dl) {
    if (running >= dlMax()) break;
    if (d.status === "queued") { running++; dlStart(d); }
  }
}

async function dlStart(d) {
  const alt = d.alts[d.alt];
  if (!alt) { dlFailed(d, "No working stream left to try"); return; }
  d.status = "downloading"; d.error = ""; d.speed = 0;
  try {
    // A paused download keeps its path (and its .part); a new one goes under
    // the download folder as it is set now.
    const r = d.path
      ? await sh('dest=$3; nohup /bin/bash "$A/cp-dl.sh" "$1" "$2" "$dest" "$S" >/dev/null 2>&1 & printf "%s\\n%s" "$!" "$dest"', [d.id, alt.u, d.path])
      : await sh('dest="$(xp "$3")/$4"; nohup /bin/bash "$A/cp-dl.sh" "$1" "$2" "$dest" "$S" >/dev/null 2>&1 & printf "%s\\n%s" "$!" "$dest"', [d.id, alt.u, dlDir(), dlRel(d, alt.u)]);
    const [pid, dest] = String(r.stdout || "").split("\n");
    if (r.status !== 0 || !pid || !dest) throw new Error((r.stderr || "").trim() || "couldn't start");
    if (d.status !== "downloading") { sh('kill -TERM "$1" 2>/dev/null', [pid]); return; }   // paused/cancelled meanwhile
    d.pid = pid; d.path = dest; d.lastGot = d.got || 0; d.lastAt = Date.now();
  } catch (e) {
    dlFailed(d, "Couldn't start: " + e.message);
  }
  dlSave(); dlBroadcast(); dlPoll();
}

function dlFailed(d, msg) {
  d.status = "failed"; d.error = msg; d.speed = 0; d.pid = null;
  if (d.path) sh('rm -f "$1.part"', [d.path]);
  d.path = null; d.got = 0; d.total = 0;
  dlNotify("Download failed: " + dlName(d));
}

// Once a second while anything is downloading: sizes, speed, and what to do
// with workers that have ended.
function dlPoll() {
  if (dlPollTimer || dlPolling) return;
  dlPollTimer = later(dlTick, 1000);
}
async function dlTick() {
  dlPollTimer = null;
  const act = dl.filter((d) => d.status === "downloading" && d.pid && d.path);
  if (!act.length) return;
  dlPolling = true;
  let out = "";
  try {
    const args = [];
    act.forEach((d) => args.push(d.id, d.pid, d.path));
    out = (await sh('/bin/bash "$A/cp-dlstat.sh" "$S" "$@"', args)).stdout || "";
  } catch (e) { log.log("ContentPlay download status failed: " + e.message); }
  dlPolling = false;
  const now = Date.now();
  let changed = false;
  for (const line of out.trim().split("\n")) {
    const [id, bytes, alive, rc, total, err] = line.split("|");
    const d = dlFind(id);
    if (!d || d.status !== "downloading") continue;   // paused or cancelled meanwhile
    const b = +bytes || 0;
    if (+total) d.total = +total;
    if (alive === "1") {
      const dt = (now - (d.lastAt || now)) / 1000;
      if (dt >= 0.5 && b >= (d.lastGot || 0)) {
        const sp = (b - (d.lastGot || 0)) / dt;
        d.speed = d.speed ? d.speed * 0.6 + sp * 0.4 : sp;
      }
      d.got = b; d.lastGot = b; d.lastAt = now;
      continue;
    }
    changed = true;
    d.pid = null; d.speed = 0;
    if (rc === "0") {
      d.status = "done"; d.got = d.total = d.total || b; d.finished = now; d.restarts = 0;
      sh('rm -f "$S/$1".*', [d.id]);
      log.log("ContentPlay downloaded " + d.path);
      dlNotify("Downloaded " + dlName(d));
    } else if (rc) {
      log.log(`ContentPlay download ${dlName(d)} failed on stream ${d.alt + 1}: rc ${rc} ${err || ""}`);
      if (d.alt + 1 < d.alts.length) {
        // Try the next alternate from scratch.
        sh('rm -f "$1.part" "$S/$2".*', [d.path, d.id]);
        d.alt++; d.path = null; d.got = 0; d.total = 0; d.status = "queued";
      } else {
        dlFailed(d, (err || "").replace(/^curl: \(\d+\)\s*/, "").trim() || "Download failed (code " + rc + ")");
      }
    } else if ((d.restarts = (d.restarts || 0) + 1) <= 3) {
      d.status = "queued";   // the worker died (Mac restarted, killed): resume from the .part
    } else {
      dlFailed(d, "Download kept stopping unexpectedly");
    }
  }
  if (changed) { dlSave(); dlPump(); }
  dlBroadcast();
  dlPoll();
}

// Done files that were moved or deleted outside ContentPlay show as missing.
async function dlCheckFiles() {
  const done = dl.filter((d) => (d.status === "done" || d.status === "missing") && d.path);
  if (!done.length) return;
  try {
    const r = await sh('for f; do [ -e "$f" ] && echo 1 || echo 0; done', done.map((d) => d.path));
    const ok = String(r.stdout || "").trim().split("\n");
    let changed = false;
    done.forEach((d, i) => {
      const s = ok[i] === "1" ? "done" : "missing";
      if (d.status !== s) { d.status = s; changed = true; }
    });
    if (changed) dlSave();
  } catch (e) {}
}

// items: [{ sid, imdb, kind, show, title, season, episode, year, poster, alts: [{u,l}], lang, recent }]
function dlAdd(items) {
  let added = 0, dup = 0;
  for (const it of items || []) {
    if (!it || !it.sid || !Array.isArray(it.alts) || !it.alts.length) continue;
    const ex = dl.find((x) => x.sid === it.sid);
    if (ex && ex.status !== "failed" && ex.status !== "missing") { dup++; continue; }
    if (ex) dl.splice(dl.indexOf(ex), 1);
    dl.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), sid: it.sid, imdb: it.imdb,
      kind: it.kind === "movie" ? "movie" : "episode", show: it.show || it.imdb, title: it.title || "",
      season: it.season || 0, episode: it.episode || 0, year: it.year || "", poster: it.poster || "",
      alts: it.alts.filter((a) => a && a.u).slice(0, 8), alt: 0, lang: it.lang || null, recent: it.recent || null,
      status: "queued", got: 0, total: 0, speed: 0, error: "", path: null, pid: null, restarts: 0, added: Date.now(),
    });
    added++;
  }
  if (added) { dlSave(); dlPump(); }
  dlBroadcast();
  return { added, dup };
}

// Play a download (and, for an episode, the downloaded episodes after it) as a
// normal ContentPlay playlist, so languages, skips and resume all still apply.
async function dlPlay(d) {
  if (!d || d.status !== "done") return;
  let group = [d];
  if (d.kind === "episode") {
    group = dl.filter((x) => x.kind === "episode" && x.imdb === d.imdb && x.status === "done" &&
                             (x.season > d.season || (x.season === d.season && x.episode >= d.episode)))
              .sort((a, b) => a.season - b.season || a.episode - b.episode);
  }
  const lines = ["#EXTM3U"];
  group.forEach((g) => { lines.push("#EXTINF:-1," + (g.kind === "movie" ? dlName(g) : `S${g.season}E${pad2(g.episode)}` + (g.title ? " · " + g.title : ""))); lines.push(g.path); });
  const lang = Object.assign({ alang: "eng,en", slang: "eng,en" }, d.lang || {}, {
    type: d.kind === "movie" ? "movie" : "series", subIds: group.map((g) => g.sid),
  });
  const name = (d.kind === "movie" ? dlName(d) : `${d.show} S${d.season} from E${pad2(d.episode)}`) + " (downloaded)";
  await openPlaylist(name, lines.join("\n") + "\n", lang, group.map((g) => [{ u: g.path, l: "Downloaded" }]));
  addRecent(d.recent);
}

async function dlAction(a) {
  await dlLoaded;
  const act = a && a.action, d = dlFind(a && a.id);
  const stop = (x) => { const pid = x.pid; x.pid = null; x.speed = 0; if (pid) return sh('kill -TERM "$1" 2>/dev/null; true', [pid]); };
  try {
    if (act === "pause" && d && (d.status === "downloading" || d.status === "queued")) {
      d.status = "paused"; await stop(d);
    } else if (act === "resume" && d && d.status === "paused") {
      d.status = "queued"; d.restarts = 0;
    } else if (act === "retry" && d && (d.status === "failed" || d.status === "missing")) {
      Object.assign(d, { status: "queued", alt: 0, path: null, got: 0, total: 0, error: "", restarts: 0 });
    } else if (act === "cancel" && d) {
      await stop(d);
      if (d.path && d.status !== "done") sh('rm -f "$1.part"', [d.path]);
      sh('rm -f "$S/$1".*', [d.id]);
      dl.splice(dl.indexOf(d), 1);
    } else if (act === "remove" && d && d.status !== "downloading") {
      sh('rm -f "$S/$1".*', [d.id]);
      dl.splice(dl.indexOf(d), 1);
    } else if (act === "trash" && d && d.status === "done") {
      // Into the Trash (recoverable), then drop now-empty Season/show folders.
      await sh('f=$1; t="$H/.Trash/$(basename "$f")"; [ -e "$t" ] && t="$H/.Trash/$(date +%H%M%S) $(basename "$f")"; mv "$f" "$t" && ' +
               'p=$(dirname "$f"); rmdir "$p" 2>/dev/null && rmdir "$(dirname "$p")" 2>/dev/null; true', [d.path]);
      dl.splice(dl.indexOf(d), 1);
    } else if (act === "reveal" && d && d.path) {
      await sh('[ -e "$1" ] && open -R "$1" || open -R "$1.part"', [d.path]);
    } else if (act === "play" && d) {
      await dlPlay(d);
    } else if (act === "folder") {
      await sh('d=$(xp "$1"); mkdir -p "$d" && open "$d"', [dlDir()]);
    } else if (act === "pauseAll") {
      for (const x of dl) if (x.status === "downloading" || x.status === "queued") { x.status = "paused"; await stop(x); }
    } else if (act === "resumeAll") {
      dl.forEach((x) => { if (x.status === "paused") { x.status = "queued"; x.restarts = 0; } });
    } else if (act === "clearDone") {
      dl = dl.filter((x) => x.status !== "done");
    } else if (act === "check") {
      await dlCheckFiles();
    }
  } catch (e) {
    log.error("ContentPlay download action " + act + " failed: " + e.message);
  }
  dlSave(); dlPump(); dlBroadcast();
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

// Downloads from a player (its Sidebar tab, or Plugins ▸ Download this).
global.onMessage("cp-download", async (d, player) => {
  await dlLoaded;
  reply(player, "cp-dlAdded", Object.assign(dlAdd(d && d.items), { src: d && d.src }));
});
global.onMessage("cp-dlAction", (a) => dlAction(a));
global.onMessage("cp-dlGet", async (d, player) => { await dlLoaded; await dlCheckFiles(); reply(player, "cp-downloads", dlView()); });

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
menu.addItem(menu.item("Downloads…", () => { showDownloadsOnReady = true; openPanel(); }));

log.log("ContentPlay global entry loaded.");
