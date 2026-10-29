// ContentPlay — MAIN entry (runs inside each player window).
//
// Playback happens via an .m3u playlist opened by the global entry, so the
// native IINA playlist drives next-episode and the #EXTINF titles label each
// item. This entry:
//   * applies the audio/subtitle languages the panel chose for that playlist
//     (see langPlan in ui/panel.html);
//   * downloads subtitles from OpenSubtitles when the stream has none;
//   * lets you switch the playing episode to another resolved stream (the panel
//     keeps a ranked list per item) via the Plugins menu / a shortcut, so a bad
//     auto-pick (e.g. a 3D side-by-side file) can be swapped without leaving.
//
// on_load runs before mpv picks tracks, so alang/slang set here apply to the
// file being opened.

const { mpv, preferences, event, menu, http, overlay, core, sidebar } = iina;
const log = iina.console;

function parse(json) {
  try {
    return JSON.parse(json || "null");
  } catch (e) {
    return null;
  }
}
function pref(key, fallback) {
  const v = preferences.get(key);
  return v === undefined || v === null || v === "" ? fallback : v;
}

// The ContentPlay .m3u this window is playing. Captured the first time mpv
// reports a matching playlist-path and then reused, because switching a stream
// (loadfile replace) drops the m3u association on that one entry.
let activePlaylistFile = null;
const M3U_RE = /\/ContentPlay\/([^/]+\.m3u)$/;
function currentM3u() {
  const pos = mpv.getNumber("playlist-pos");
  const from = pos >= 0 ? mpv.getString(`playlist/${pos}/playlist-path`) || "" : "";
  const m = from.match(M3U_RE);
  if (m) activePlaylistFile = m[1];
  return activePlaylistFile;
}

// The language plan for this playlist. If mpv can't say which playlist a file
// came from, fall back to the newest plan, but only for Torrentio stream links
// (every debrid service is proxied behind the same /resolve/ path) so other
// videos keep IINA's own languages.
const STREAM_URL = /torrentio\.strem\.fun\/resolve\/|real-debrid\.com\/|rdeb\.io\//;
function langFor() {
  const file = currentM3u();
  if (file) {
    const map = parse(preferences.get("langByPlaylist")) || {};
    return map[file] || parse(preferences.get("lastLang"));
  }
  if (STREAM_URL.test(mpv.getString("stream-open-filename") || "")) return parse(preferences.get("lastLang"));
  return null;
}

mpv.addHook("on_load", 50, () => {
  const lang = langFor();
  if (!lang) return;
  mpv.set("alang", lang.alang);
  mpv.set("slang", lang.slang);
  // Wanted subtitles even when the audio language matches them.
  mpv.set("subs-with-matching-audio", "yes");
  log.log(`ContentPlay languages: audio ${lang.alang} · subs ${lang.slang}`);
});

// ---------------------------------------------------------------------------
// Switch the current episode to another resolved stream
// ---------------------------------------------------------------------------
// Per-item cursor: which alternate (index into the stored list) each playlist
// position is currently showing. Position 0 of every list is what the .m3u used.
const cursor = {};
let pendingSeek = null;   // { time } to restore after a switch reloads the file

function streamsForCurrent() {
  const file = currentM3u();
  if (!file) return null;
  const map = parse(preferences.get("streamsByPlaylist")) || {};
  const byItem = map[file];
  if (!Array.isArray(byItem)) return null;
  const pos = mpv.getNumber("playlist-pos");
  const list = byItem[pos];
  return Array.isArray(list) && list.length ? { pos, list } : null;
}

function curIndex(pos, len) {
  const key = (activePlaylistFile || "") + "#" + pos;
  return key in cursor ? cursor[key] : 0;
}

// Load a specific alternate (by absolute index) for the current item, keeping
// the rest of the playlist so next-episode still works.
//
// `loadfile replace` would wipe the whole playlist down to the new file, so we
// instead rebuild just the current slot: append the new URL, move it next to the
// current entry, drop the old entry, and play the new one in its place. Only
// append/move/remove/playlist-pos are used, which every mpv version supports.
function applyStream(pos, list, index) {
  const i = ((index % list.length) + list.length) % list.length;
  cursor[(activePlaylistFile || "") + "#" + pos] = i;
  const pick = list[i];
  const t = mpv.getNumber("time-pos");
  pendingSeek = isFinite(t) && t > 0 ? { time: t } : null;
  log.log(`ContentPlay stream ${i + 1}/${list.length}: ${pick.l || pick.u}`);

  const count = mpv.getNumber("playlist-count");   // before append; new lands at index `count`
  mpv.command("loadfile", [pick.u, "append"]);
  if (count !== pos + 1) mpv.command("playlist-move", [String(count), String(pos + 1)]);  // new -> right after current
  mpv.set("playlist-pos", pos + 1);                // play the new entry
  mpv.command("playlist-remove", [String(pos)]);   // drop old; new slides into slot `pos`
  iina.core.osd(`Stream ${i + 1}/${list.length}${pick.l ? " · " + pick.l : ""}`);
}

// Cycle relative to the current alternate (keyboard shortcuts / menu).
function switchStream(dir) {
  const cur = streamsForCurrent();
  if (!cur) { iina.core.osd("No alternate streams for this item"); return; }
  if (cur.list.length < 2) { iina.core.osd(`Only one stream · ${cur.list[0].l || ""}`.trim()); return; }
  applyStream(cur.pos, cur.list, curIndex(cur.pos, cur.list.length) + dir);
}

// Jump straight to one alternate (picked from the Streams submenu).
function selectStream(index) {
  const cur = streamsForCurrent();
  if (!cur) { iina.core.osd("No alternate streams for this item"); return; }
  applyStream(cur.pos, cur.list, index);
}

function kb(key) {
  const v = (preferences.get(key) || "").trim();
  return v ? { keyBinding: v } : {};
}

// The plugin menu is rebuilt whenever a file loads so the Streams submenu lists
// the alternates for the episode that's actually playing, with a check on the
// one in use. These main-entry items are separate from the global Search items
// added in global.js.
//
// IMPORTANT: menu.forceUpdate() must NOT run while the plugin is still being
// loaded (it locks the menu controller recursively and crashes IINA). So at load
// we only add the items statically (no removeAllItems, no forceUpdate), exactly
// like a normal plugin; the dynamic rebuild with forceUpdate happens later, from
// the file-loaded event, which fires well after initialization.
function rebuildMenu(live) {
  if (live) { try { menu.removeAllItems(); } catch (e) {} }
  menu.addItem(menu.item("Next stream", () => switchStream(1), kb("kbNextStream")));
  menu.addItem(menu.item("Previous stream", () => switchStream(-1), kb("kbPrevStream")));

  const streams = menu.item("Streams");
  let cur = null;
  try { cur = streamsForCurrent(); } catch (e) {}
  if (cur && cur.list.length) {
    const at = curIndex(cur.pos, cur.list.length);
    cur.list.forEach((s, i) => {
      const label = (s.l && s.l.trim()) || "Stream " + (i + 1);
      streams.addSubMenuItem(menu.item(label, () => selectStream(i), { selected: i === at }));
    });
  } else {
    streams.addSubMenuItem(menu.item("No alternate streams", null, { enabled: false }));
  }
  menu.addItem(streams);
  if (live) { try { menu.forceUpdate(); } catch (e) {} }
}

// Static build at load — no forceUpdate (would crash during plugin init).
rebuildMenu(false);

// ---------------------------------------------------------------------------
// Subtitles when the stream has none, in the first configured subtitle language
// ---------------------------------------------------------------------------
const SUB_NAMES = {
  en: /english/i, es: /spanish|espa[nñ]ol/i, fr: /french|fran[cç]ais/i, de: /german|deutsch/i,
  it: /italian/i, pt: /portuguese|portugu[eê]s/i, ru: /russian/i, hi: /hindi/i, te: /telugu/i,
  ta: /tamil/i, ja: /japanese/i, ko: /korean/i, zh: /chinese|mandarin|cantonese/i, ar: /arabic/i
};
function subLang() {
  const code = (pref("subtitleLangs", "en").split(",")[0] || "en").trim().toLowerCase();
  return { code, re: SUB_NAMES[code] || new RegExp(code, "i") };
}

function hasSubsFor(want) {
  const n = mpv.getNumber("track-list/count");
  for (let i = 0; i < n; i++) {
    if (mpv.getString(`track-list/${i}/type`) !== "sub") continue;
    const lang = (mpv.getString(`track-list/${i}/lang`) || "").toLowerCase();
    const title = mpv.getString(`track-list/${i}/title`) || "";
    if (lang === want.code || lang.indexOf(want.code) === 0 || want.re.test(title) || want.re.test(lang)) return true;
  }
  return false;
}

async function loadSubs(type, id, want) {
  const base = (pref("opensubtitlesUrl", "https://opensubtitles-v3.strem.io") || "").replace(/\/+$/, "");
  const res = await http.get(`${base}/subtitles/${type}/${id}.json`);
  const body = typeof res.data === "object" && res.data ? res.data : parse(res.text || res.data) || {};
  const codeRe = new RegExp("^(" + want.code + "|" + want.code + "[a-z])$", "i");
  const subs = (body.subtitles || []).filter((s) => s.url && (codeRe.test(s.lang || "") || want.re.test(s.lang || "")));
  if (!subs.length) {
    iina.core.osd("No subtitles found");
    return;
  }
  const dest = `@tmp/contentplay-${id.replace(/[^\w]+/g, "_")}-${want.code}.srt`;
  await http.download(subs[0].url, dest);
  mpv.command("sub-add", [iina.utils.resolvePath(dest), "select", `Subtitles (${want.code.toUpperCase()}, OpenSubtitles)`, want.code]);
  log.log(`ContentPlay loaded ${want.code} subtitles for ${id}`);
}

event.on("mpv.file-loaded", () => {
  // Restore position after a stream switch reloaded the same episode.
  if (pendingSeek) {
    const seek = pendingSeek;
    pendingSeek = null;
    mpv.command("seek", [String(seek.time), "absolute"]);
  }

  // Reflect the now-playing episode's alternates in the menu. Safe here:
  // file-loaded fires after plugin initialization, so forceUpdate won't deadlock.
  rebuildMenu(true);

  const lang = langFor();
  const id = lang && lang.subIds && lang.subIds[mpv.getNumber("playlist-pos")];
  if (!id) return;
  const want = subLang();
  if (hasSubsFor(want)) return;
  loadSubs(lang.type, id, want).catch((e) => log.error("ContentPlay subtitles failed: " + e.message));
});

// ---------------------------------------------------------------------------
// Skip Recap / Skip Intro / Next Episode — driven by the file's own chapters
// ---------------------------------------------------------------------------
// Many WEB-DL releases embed named chapter markers ("Recap", "Intro"/"Opening
// Credits", "End Credits", sometimes a post-credits chapter). IINA already shows
// them in the scrubber; here we read `chapter-list` and classify those markers
// so an in-player overlay (ui/overlay.html) can offer Netflix-style controls:
//
//   * Recap   → a "Skip Recap" button for the length of the recap chapter.
//   * Intro   → a "Skip Intro" button with a countdown that auto-skips at 0.
//   * Credits → jump to the post-credits scene if the file has one (then a
//               "Next Episode" button), else auto-advance to the next episode.
//
// Nothing is hardcoded per show: a file with no (or unrecognised) chapters
// simply shows nothing. All timing comes from the file.
const skip = {
  enabled: pref("skipEnabled", true) !== false,
  introSecs: Math.max(0, parseInt(pref("autoSkipIntroSecs", "5"), 10) || 0),
  autoNext: pref("autoPlayNext", true) !== false,
  nextSecs: Math.max(0, parseInt(pref("nextUpCountdownSecs", "8"), 10) || 0),
};

const RE_RECAP = /recap|previously|story so far|last time on/i;
const RE_INTRO = /\b(intro|introduction|opening|op|theme|main title|title sequence|titles)\b/i;
const RE_CREDITS = /\b(end ?credits|closing credits|credits|ending|outro|ed|fin)\b/i;
const RE_POST = /post[\s-]?credit|mid[\s-]?credit|stinger|after[\s-]?credit|tag scene/i;

// Read the file's chapters as [{ title, time, index, end }], sorted by time.
function readChapters() {
  let raw = [];
  try {
    const n = mpv.getNative("chapter-list");
    if (Array.isArray(n)) raw = n.map((c) => ({ title: c.title || "", time: +c.time || 0 }));
  } catch (e) {}
  if (!raw.length) {
    const count = mpv.getNumber("chapters");
    for (let i = 0; i < count; i++) {
      raw.push({ title: mpv.getString(`chapter-list/${i}/title`) || "", time: mpv.getNumber(`chapter-list/${i}/time`) || 0 });
    }
  }
  raw.sort((a, b) => a.time - b.time);
  const dur = mpv.getNumber("duration") || 0;
  raw.forEach((c, i) => {
    c.index = i;
    c.end = i + 1 < raw.length ? raw[i + 1].time : dur || c.time;
  });
  return { list: raw, dur };
}

// Pick the recap/intro/credits/post-credits chapters out of the list. Title
// heuristics are disambiguated by position: "Opening Credits" near the start is
// the intro, "End Credits" in the back half are the credits.
function classifyChapters(list, dur) {
  if (!list.length) return null;
  const mid = dur ? dur / 2 : Infinity;
  let recap = null, intro = null, credits = null, post = null;
  list.forEach((c) => {
    const t = c.title || "";
    if (!recap && RE_RECAP.test(t)) recap = c;
    if (!intro && RE_INTRO.test(t) && c.time < mid) intro = c;
    if (!post && RE_POST.test(t)) post = c;
  });
  // Credits: the latest back-half chapter that reads as credits (not a stinger).
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.time >= mid && RE_CREDITS.test(c.title || "") && !RE_POST.test(c.title || "")) { credits = c; break; }
  }
  // No explicitly-named stinger: infer one as a real chapter that plays *after*
  // the credits (>8s of content, not the trailing few seconds of the file).
  if (credits && !post) {
    post = list.find((c) => c.index > credits.index && c.end - c.time > 8 && c.time < dur - 3) || null;
  }
  if (post && credits && post.index <= credits.index) post = null;
  if (!recap && !intro && !credits) return null;
  return { recap, intro, credits, post };
}

// Per-episode state. `shown` is the widget currently on screen; the *Done flags
// stop a widget re-appearing after it has been actioned or dismissed.
let seg = null;
let shown = null;
let recapDone = false, introDone = false, nextDone = false;
// Classifying credits needs the runtime, which a network stream may not report
// until after file-loaded. When it was still 0 we recompute on the first tick
// that has a real duration.
let needReclass = false;

function computeSegments() {
  const { list, dur } = readChapters();
  seg = classifyChapters(list, dur);
  needReclass = list.length > 0 && dur <= 0;
  const names = seg ? ["recap", "intro", "credits", "post"].filter((k) => seg[k]).map((k) => k + "@" + Math.round(seg[k].time)).join(", ") : "none";
  log.log(`ContentPlay skip markers: ${names} (of ${list.length} chapters)`);
}

// Overlay plumbing. Follows the pattern proven by iina-cinemode / iina-auto-skip:
//   * load the file on iina.window-loaded;
//   * bind onMessage handlers + call show() once the overlay webview is loaded —
//     signalled by the iina.plugin-overlay-loaded event (with a setTimeout and
//     the webview's own "ready" message as fallbacks). Crucially, show() is NOT
//     gated on the webview handshake: the webview may not run until it is shown,
//     so waiting for its "ready" before calling show() would deadlock.
let infoShown = false;   // paused info panel currently on screen (see below)
let overlayLoaded = false, overlayBound = false, overlayReady = false, pendingShow = null;

function ensureOverlay() {
  if (overlayLoaded) return;
  if (!overlay) return;
  overlayLoaded = true;
  try {
    overlay.loadFile("ui/overlay.html");
  } catch (e) {
    overlayLoaded = false;
    log.error("ContentPlay overlay load failed: " + e.message);
    return;
  }
  setTimeout(onOverlayLoaded, 700); // fallback if plugin-overlay-loaded never fires
}

// loadFile() clears existing listeners, so handlers are bound only after it.
function bindOverlayHandlers() {
  if (overlayBound) return;
  overlayBound = true;
  overlay.onMessage("ready", () => onOverlayLoaded());
  // A "More like this" poster was clicked: hand it to the sidebar panel, which
  // runs the normal open flow (episodes for a series, play for a movie).
  overlay.onMessage("rec", (r) => {
    if (!r || !r.id) return;
    try { ensureSidebar(); sidebar.show(); } catch (e) {}
    setTimeout(() => { try { sidebar.postMessage("openTitle", r); } catch (e) {} }, 300);
  });
  overlay.onMessage("action", (d) => onAction(d && d.kind, d && d.auto));
  // Dismissed (✕): keep playing the segment and don't offer it again this episode.
  overlay.onMessage("dismiss", (d) => {
    const k = d && d.kind;
    if (k === "recap") recapDone = true;
    else if (k === "intro") introDone = true;
    else nextDone = true;
    hideWidget();
  });
}

function onOverlayLoaded() {
  if (!overlayLoaded) return;
  bindOverlayHandlers();
  try { overlay.show(); overlay.setClickable(false); } catch (e) {}
  if (!overlayReady) overlayReady = true;
  if (pendingShow) { const p = pendingShow; pendingShow = null; sendShow(p.kind, p.total); }
  try { tick(); } catch (e) {} // catch up on anything that should already be on screen
}

function sendShow(kind, total) {
  if (!overlayReady) { pendingShow = { kind, total }; return; }
  try {
    overlay.show();
    overlay.postMessage("show", { kind, total, paused: mpv.getFlag("pause") });
    overlay.setClickable(true);
  } catch (e) {}
}
function showWidget(kind, total) { shown = kind; sendShow(kind, total); }
function hideWidget() {
  if (shown === null && !pendingShow) return;
  shown = null; pendingShow = null;
  if (overlayReady) { try { overlay.postMessage("hide", {}); overlay.setClickable(infoShown); } catch (e) {} }
}

function hasNext() {
  const pos = mpv.getNumber("playlist-pos");
  const n = mpv.getNumber("playlist-count");
  return pos >= 0 && n > pos + 1;
}
// Seek by absolute time — mpv.set("chapter", n) does not reliably move playback
// through IINA's plugin API, but an absolute seek (as used elsewhere here) does.
// Letterboxd rating for an IMDb id, or null. /imdb/<id>/ redirects to the film
// page, whose JSON-LD carries the aggregateRating. Best-effort: any failure is null.
async function fetchLetterboxd(id) {
  try {
    const res = await http.get(`https://letterboxd.com/imdb/${id}/`, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" } });
    const html = String(res.text || res.data || "");
    const agg = html.match(/"aggregateRating":\{[^}]*?"ratingValue":([\d.]+)/) || html.match(/"ratingValue":([\d.]+)[^}]*?"@type":"AggregateRating"/);
    const cnt = html.match(/"aggregateRating":\{[^}]*?"ratingCount":(\d+)/);
    const url = html.match(/<meta property="og:url" content="([^"]+)"/);
    return agg ? { rating: parseFloat(agg[1]), count: cnt ? parseInt(cnt[1], 10) : 0, url: url ? url[1] : "" } : null;
  } catch (e) { log.log("ContentPlay letterboxd lookup failed: " + e.message); return null; }
}

function seekTo(time) {
  mpv.command("seek", [String(time + 0.2), "absolute"]);
}
function goNext() {
  if (hasNext()) mpv.command("playlist-next", ["force"]);
}

// A widget (or its countdown) was actioned.
function onAction(kind, auto) {
  if (kind === "recap" && seg && seg.recap) { seekTo(seg.recap.end); recapDone = true; }
  else if (kind === "intro" && seg && seg.intro) { seekTo(seg.intro.end); introDone = true; }
  else if (kind === "next") { nextDone = true; hideWidget(); goNext(); return; }
  hideWidget();
}

function inSeg(t, s) { return t >= s.time && t < s.end - 0.3; }

// Entering the credits: skip to the post-credits scene if there is one (then a
// manual Next button — the native playlist still auto-advances at end of file),
// otherwise offer the "Up next" card that auto-advances after a countdown.
function enterCredits() {
  nextDone = true;
  if (seg.post) {
    seekTo(seg.post.time);
    try { core.osd("Skipping to post-credits scene"); } catch (e) {}
    if (hasNext()) showWidget("next", 0);
  } else if (hasNext()) {
    showWidget("next", skip.autoNext ? skip.nextSecs : 0);
  }
}

// Decide which widget (if any) belongs on screen at the current time.
function tick() {
  if (!skip.enabled) return;
  if (needReclass && mpv.getNumber("duration") > 0) computeSegments();
  if (!seg) return;
  const t = mpv.getNumber("time-pos");
  if (!isFinite(t)) return;
  let want = null;
  if (shown === "next") want = "next"; // sticky: stays up until a click or the next file
  else if (seg.recap && !recapDone && inSeg(t, seg.recap)) want = "recap";
  else if (seg.intro && !introDone && inSeg(t, seg.intro)) want = "intro";
  else if (seg.credits && !nextDone && t >= seg.credits.time) want = "next";
  if (want === shown) return;
  if (want === "recap") showWidget("recap", 0);
  else if (want === "intro") showWidget("intro", skip.introSecs);
  else if (want === "next") enterCredits();
  else hideWidget();
}

// overlay.loadFile throws until the player window exists, so load it on
// window-loaded (and again, harmlessly, on the first file-loaded as a fallback).
event.on("iina.window-loaded", () => { if (skip.enabled || pauseInfo.enabled) ensureOverlay(); });
// IINA fires this once the overlay webview has finished loading — the reliable
// moment to bind handlers and show the overlay.
event.on("iina.plugin-overlay-loaded", () => onOverlayLoaded());

event.on("mpv.file-loaded", () => {
  if (skip.enabled || pauseInfo.enabled) ensureOverlay();
  hideInfo();
  if (!skip.enabled) return;
  seg = null; shown = null; recapDone = introDone = nextDone = false;
  hideWidget();
  computeSegments();
});

event.on("mpv.time-pos.changed", () => { try { tick(); } catch (e) {} });
event.on("mpv.pause.changed", () => {
  if (overlayReady && shown) overlay.postMessage("pause", { paused: mpv.getFlag("pause") });
  if (mpv.getFlag("pause")) scheduleInfo(); else hideInfo();
});

// ---------------------------------------------------------------------------
// Paused info panel — what you're watching, while it's paused
// ---------------------------------------------------------------------------
// After ~1s paused, the overlay shows the title's summary, ratings (IMDb from
// Cinemeta; Rotten Tomatoes with an OMDb key; Letterboxd for movies), cast and
// crew, and a "More like this" row. It only appears for ContentPlay playlists
// (the stored subIds say which title/episode is playing). Ratings and
// recommendations arrive after the first paint and refresh the open panel.
const pauseInfo = { enabled: pref("pauseInfo", true) !== false, delayMs: 1100 };
const infoCache = {};   // sid -> view-model (mutated as extra data arrives)
let infoTimer = null, infoKey = null;
const TMDB_API = "https://api.themoviedb.org/3";

async function getJson(url, opts) {
  const res = await http.get(url, opts);
  if (res.statusCode && res.statusCode >= 400) throw new Error("HTTP " + res.statusCode);
  return typeof res.data === "object" && res.data ? res.data : parse(res.text || res.data);
}
const list = (a, n) => (a || []).filter(Boolean).slice(0, n).join(", ");

function nowPlaying() {
  const lang = langFor();
  const sid = lang && lang.subIds && lang.subIds[mpv.getNumber("playlist-pos")];
  if (!sid) return null;
  const [imdb, season, episode] = String(sid).split(":");
  if (!/^tt\d+$/.test(imdb)) return null;
  return { sid, imdb, type: lang.type === "movie" ? "movie" : "series", season: season ? +season : null, episode: episode ? +episode : null };
}

function tmdbReq(path) {
  const k = (preferences.get("tmdbApiKey") || "").trim();
  if (!k) return Promise.reject(new Error("no tmdb key"));
  const bearer = /\./.test(k) && k.length > 80;
  return getJson(TMDB_API + path + (bearer ? "" : (path.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(k)),
    bearer ? { headers: { Authorization: "Bearer " + k } } : undefined);
}

// First paint needs only Cinemeta; everything else fills in via refresh().
async function buildInfo(np, refresh) {
  const cm = (pref("cinemetaUrl", "https://v3-cinemeta.strem.io") || "").replace(/\/+$/, "");
  const d = await getJson(`${cm}/meta/${np.type}/${np.imdb}.json`);
  const m = (d && d.meta) || {};
  if (!m.name) throw new Error("no metadata");
  const isMovie = np.type === "movie";
  const ep = isMovie ? null : (m.videos || []).find((v) => +v.season === np.season && +v.episode === np.episode);
  const R = { imdb: m.imdbRating || "", ep: ep && ep.rating || "", rt: "", lb: null };
  const vm = { title: m.name, logo: m.logo || "", sub: [m.releaseInfo || m.year, m.runtime, list(m.genres, 3)].filter(Boolean).join(" · "),
               desc: (ep && (ep.overview || ep.description)) || m.description || "", rows: [], recs: [], chips: [], note: "" };
  if (ep) vm.episode = { tag: `S${np.season} · E${String(np.episode).padStart(2, "0")}`, name: ep.name || ep.title || "" };
  const rebuild = () => {
    vm.chips = [];
    if (R.ep) vm.chips.push({ k: "ep", label: "Episode", value: R.ep, note: "/ 10" });
    if (R.imdb) vm.chips.push({ k: "imdb", label: "IMDb", value: R.imdb, note: isMovie ? "" : "series" });
    if (R.rt) vm.chips.push({ k: "rt", label: "RT", value: R.rt });
    if (R.lb) vm.chips.push({ k: "lb", label: "LB", value: R.lb.toFixed(1), note: "/ 5" });
    refresh();
  };
  const baseRows = () => {
    const rows = [];
    if (isMovie) { if (m.director && m.director.length) rows.push(["Director", list(m.director, 3)]); }
    else if (m.writer && m.writer.length) rows.push(["Creator", list(m.writer, 3)]);
    if (isMovie && m.writer && m.writer.length) rows.push(["Writer", list(m.writer, 3)]);
    if (m.cast && m.cast.length) rows.push([ep ? "Series cast" : "Cast", list(m.cast, 5)]);
    return rows;
  };
  vm.rows = baseRows();
  if (!(pref("omdbApiKey", "") || "").trim()) vm.note = "Add an OMDb key in ContentPlay settings to show Rotten Tomatoes.";
  rebuild();

  // Extras run in the background; each failure just leaves that bit out.
  const omdb = (preferences.get("omdbApiKey") || "").trim();
  if (omdb) getJson(`https://www.omdbapi.com/?i=${np.imdb}&apikey=${encodeURIComponent(omdb)}`).then((o) => {
    const rt = ((o && o.Ratings) || []).find((x) => x.Source === "Rotten Tomatoes");
    if (rt) { R.rt = rt.Value; rebuild(); }
  }).catch((e) => log.log("ContentPlay omdb: " + e.message));
  if (isMovie) fetchLetterboxd(np.imdb).then((r) => { if (r && r.rating) { R.lb = r.rating; rebuild(); } });
  if (ep && m.moviedb_id) tmdbReq(`/tv/${m.moviedb_id}/season/${np.season}/episode/${np.episode}`).then((t) => {
    const crew = t.crew || [];
    const dir = crew.filter((c) => c.job === "Director").map((c) => c.name);
    const wr = crew.filter((c) => c.department === "Writing").map((c) => c.name);
    const gs = (t.guest_stars || []).map((c) => c.name);
    const rows = [];
    if (dir.length) rows.push(["Director", list(dir, 2)]);
    if (wr.length) rows.push(["Writer", list(wr, 2)]);
    if (gs.length) rows.push(["Guests", list(gs, 4)]);
    vm.rows = rows.concat(baseRows());
    if (!ep.overview && t.overview) vm.desc = t.overview;
    refresh();
  }).catch(() => {});
  loadRecs(np, m, cm).then((r) => { if (r.recs.length) { vm.recs = r.recs; vm.recsTitle = r.title; refresh(); } }).catch((e) => log.log("ContentPlay recs: " + e.message));
  return vm;
}

// TMDB's own recommendations when a key is set (each needs its IMDb id so it can
// be opened); otherwise, the top-rated titles in the same first genre from Cinemeta.
async function loadRecs(np, m, cm) {
  const media = np.type === "movie" ? "movie" : "tv";
  if ((preferences.get("tmdbApiKey") || "").trim() && m.moviedb_id) {
    try {
      const r = await tmdbReq(`/${media}/${m.moviedb_id}/recommendations`);
      const items = ((r && r.results) || []).filter((x) => x.poster_path).slice(0, 9);
      const out = (await Promise.all(items.map(async (x) => {
        try {
          const e = await tmdbReq(`/${media}/${x.id}/external_ids`);
          return e && e.imdb_id ? { id: e.imdb_id, type: np.type, name: x.title || x.name || "", poster: "https://image.tmdb.org/t/p/w185" + x.poster_path,
                                    releaseInfo: String(x.release_date || x.first_air_date || "").slice(0, 4) } : null;
        } catch (e) { return null; }
      }))).filter(Boolean).slice(0, 6);
      if (out.length) return { recs: out, title: "More like this" };
    } catch (e) { log.log("ContentPlay tmdb recs: " + e.message); }
  }
  const g = (m.genres || [])[0];
  if (!g) return { recs: [], title: "" };
  const c = await getJson(`${cm}/catalog/${np.type}/imdbRating/genre=${encodeURIComponent(g)}.json`);
  const recs = ((c && c.metas) || []).filter((x) => x.id !== np.imdb && x.poster).slice(0, 6)
    .map((x) => ({ id: x.id, type: np.type, name: x.name || "", poster: x.poster, releaseInfo: x.releaseInfo || x.year || "" }));
  return { recs, title: `Top rated in ${g}` };
}

function scheduleInfo() {
  clearTimeout(infoTimer);
  if (!pauseInfo.enabled || !overlayReady) return;
  infoTimer = setTimeout(() => { showInfoNow().catch((e) => log.log("ContentPlay pause info: " + e.message)); }, pauseInfo.delayMs);
}
async function showInfoNow() {
  if (!mpv.getFlag("pause") || infoShown) return;
  const np = nowPlaying();
  if (!np) return;
  const key = np.sid;
  const refresh = () => { if (infoShown && infoKey === key && infoCache[key]) { try { overlay.postMessage("infoUpdate", infoCache[key]); } catch (e) {} } };
  if (!infoCache[key]) infoCache[key] = await buildInfo(np, refresh);
  // Re-check: the user may have resumed or skipped while we were fetching.
  const now = nowPlaying();
  if (!mpv.getFlag("pause") || !now || now.sid !== key) return;
  infoShown = true; infoKey = key;
  try {
    overlay.show();
    overlay.postMessage("info", infoCache[key]);
    overlay.setClickable(true);
  } catch (e) {}
}
function hideInfo() {
  clearTimeout(infoTimer);
  if (!infoShown) return;
  infoShown = false; infoKey = null;
  if (overlayReady) { try { overlay.postMessage("infoHide", {}); overlay.setClickable(!!shown); } catch (e) {} }
}

// ---------------------------------------------------------------------------
// Sidebar tab — the same Discover/Search panel, inside the player window
// ---------------------------------------------------------------------------
// Declared in Info.json ("sidebarTab"). It loads ui/panel.html — the exact same
// UI the standalone Search window uses — so there is one panel, not two. Playing
// from here opens a fresh player, identical to the Search window; the streaming
// flow is untouched.
//
// The webview speaks the surface-agnostic panel protocol: it posts "ready"/"open"
// and listens for "state"/"status". We answer "ready" locally with state built
// from preferences (a main entry can read them — no bus round-trip to stall), and
// only "open" needs the global entry (to write the .m3u + spawn the player):
//   ready -> push state locally
//   open  -> cp-open (global) ; its cp-status/cp-state replies -> status/state
let sidebarLoaded = false;

// The panel's config/state. The standalone Search window gets this from the
// global entry (global.buildState); the sidebar builds the same shape here from
// preferences, because a main entry can read them directly — no message-bus
// round-trip to stall. The two live in isolated JS contexts and can't share a
// function, so this mirrors global.buildState(); keep them in step.
const DEBRID_NAMES = {
  realdebrid: "Real-Debrid", torbox: "TorBox", alldebrid: "AllDebrid", premiumize: "Premiumize",
  debridlink: "Debrid-Link", offcloud: "Offcloud", easydebrid: "EasyDebrid", putio: "Put.io",
};
function sidebarState() {
  const p = (preferences.get("debridProvider") || "").trim();
  const provider = DEBRID_NAMES[p] ? p : "realdebrid";
  let key = (preferences.get("debridApiKey") || "").trim();
  if (!key && provider === "realdebrid") key = (preferences.get("rdApiKey") || "").trim();
  let recent = [];
  try { const l = JSON.parse(preferences.get("recent") || "[]"); if (Array.isArray(l)) recent = l; } catch (e) {}
  return {
    debridConfigured: !!key, debridKey: key, debridProvider: provider, debridName: DEBRID_NAMES[provider],
    torrentioOptions: (preferences.get("torrentioOptions") || "").trim(),
    preferredQuality: pref("preferredQuality", "720p"),
    understoodLangs: pref("understoodLangs", "en,hi,te"),
    audioPriority: pref("audioPriority", "orig,te,en"),
    subtitleLangs: pref("subtitleLangs", "en"),
    discoverLang: (preferences.get("discoverLang") || "").trim(),
    tmdbApiKey: (preferences.get("tmdbApiKey") || "").trim(),
    omdbApiKey: (preferences.get("omdbApiKey") || "").trim(),
    avoid3D: pref("avoid3D", true) !== false,
    avoidHDR: pref("avoidHDR", true) !== false,
    maxAlternates: parseInt(pref("maxAlternates", "6"), 10) || 6,
    concurrency: parseInt(pref("concurrency", "6"), 10) || 6,
    cinemetaUrl: (pref("cinemetaUrl", "https://v3-cinemeta.strem.io") || "").trim(),
    torrentioUrl: (pref("torrentioUrl", "https://torrentio.strem.fun") || "").trim(),
    recent: recent,
  };
}

// Post-open refresh from the global entry (updated Recently-played / status),
// bound once. The initial state is pushed locally on the webview's "ready".
iina.global.onMessage("cp-state", (d) => { try { sidebar.postMessage("state", d); } catch (e) {} });
iina.global.onMessage("cp-status", (d) => { try { sidebar.postMessage("status", d); } catch (e) {} });

function ensureSidebar() {
  if (sidebarLoaded || !sidebar) { if (!sidebar) log.error("ContentPlay: iina.sidebar unavailable (sidebarTab in Info.json?)"); return; }
  sidebarLoaded = true;
  try {
    sidebar.loadFile("ui/panel.html");
    log.log("ContentPlay sidebar loaded ui/panel.html");
  } catch (e) {
    sidebarLoaded = false;
    log.error("ContentPlay sidebar load failed: " + e.message);
    return;
  }
  // loadFile() clears existing listeners, so (re)bind the webview handlers after.
  sidebar.onMessage("ready", () => {
    log.log("ContentPlay sidebar webview ready → pushing state");
    try { sidebar.postMessage("state", sidebarState()); } catch (e) { log.error("ContentPlay sidebar state push failed: " + e.message); }
  });
  sidebar.onMessage("open", (payload) => {
    try { sidebar.postMessage("status", { message: "Opening in IINA…" }); } catch (e) {}
    try { iina.global.postMessage("cp-open", payload); } catch (e) {}
  });
  // Letterboxd has no API and its pages send no CORS headers, so the webview
  // can't read them; fetch here and send back just the rating (movies only).
  sidebar.onMessage("lbRating", async (d) => {
    const id = d && /^tt\d+$/.test(d.id || "") ? d.id : null;
    if (!id) return;
    const r = await fetchLetterboxd(id);
    try { sidebar.postMessage("lbRating", r ? { id, rating: r.rating, count: r.count, url: r.url } : { id }); } catch (e) {}
  });
  // Persist a Discover choice (language) or the TMDB key. A main entry can write
  // prefs directly; only these whitelisted keys are allowed.
  sidebar.onMessage("savePref", (d) => {
    if (!d || (d.key !== "discoverLang" && d.key !== "tmdbApiKey")) return;
    try { preferences.set(d.key, typeof d.value === "string" ? d.value : ""); preferences.sync(); } catch (e) {}
  });
}

// Load it once the window exists (loadFile throws earlier, like the overlay),
// with the first file-loaded as a harmless retry (ensureSidebar is idempotent).
// Not auto-shown: the user opens the ContentPlay sidebar tab when they want it.
event.on("iina.window-loaded", () => ensureSidebar());
event.on("mpv.file-loaded", () => ensureSidebar());

log.log("ContentPlay main entry ready.");
