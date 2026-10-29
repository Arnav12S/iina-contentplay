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

// Once the player window is closing, mpv's handle is freed. Touching it from a timer
// or a network callback that fires afterwards segfaults IINA (mpv_get_property on a
// null handle, from a JS timer: seen in a crash report). So every delayed callback
// that reads the player checks this first, and closing cancels the pending timers.
let closing = false;
// And a second, independent guard: the player is only "active" between a file
// starting (position change / file loaded) and the end-file that precedes any
// teardown, so a timer that fires in between never touches a freed mpv handle even
// if the window-close event were missed. mpv itself can't be probed safely.
let playerActive = false;
const canTouchPlayer = () => !closing && playerActive;
function teardown(why) {
  closing = true; playerActive = false;
  note("teardown: " + why);
  // The overlay lived in that window; if the player is ever reused, load it again.
  overlayLoaded = false; overlayBound = false; overlayReady = false; pendingShow = null;
  try { clearTimeout(watchTimer); clearTimeout(nextTimer); clearTimeout(infoTimer); } catch (e) {}
}

// The overlay is only made clickable when the user opts in (Settings). IINA's
// PluginOverlayView.hitTest spins a nested run loop while the overlay is clickable,
// which crashes IINA from the window's cursor-update pass (seen as repeated
// EXC_BAD_ACCESS in hitTest). Without clicks, skipping works by a shortcut and
// the auto-skip countdowns instead.
const clickOK = () => pref("clickableOverlay", false) === true;
const KEY_SYMBOLS = { ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", meta: "⌘", cmd: "⌘", command: "⌘", shift: "⇧" };
const keyLabel = (k) => String(k || "").trim().split("+").map((x) => KEY_SYMBOLS[x.trim().toLowerCase()] || x.trim().toUpperCase()).join("");
function skipKeyHint(countdown) {
  const s = keyLabel(preferences.get("kbSkip")), c = keyLabel(preferences.get("kbCancel"));
  return [s && `${s} skip`, c && `${c} ${countdown ? "cancel" : "dismiss"}`].filter(Boolean).join(" · ");
}

// IINA's Log Viewer isn't on disk, so key events are also kept in a small rolling
// file: ~/Library/Application Support/com.colliderli.iina/plugins/.data/<id>/debug.log
const dbgLines = [];
let dbgDirty = false;
function note(msg) {
  try { log.log("ContentPlay " + msg); } catch (e) {}
  dbgLines.push(new Date().toISOString().slice(11, 23) + " " + msg);
  if (dbgLines.length > 250) dbgLines.shift();
  dbgDirty = true;
  flushNotes();
}
function flushNotes() {
  if (!dbgDirty) return;
  dbgDirty = false;
  try { iina.file.write("@data/debug.log", dbgLines.join("\n") + "\n"); } catch (e) {}
}

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

const streamsMemo = {};   // playlist file -> per-item stream lists (fixed for this window's lifetime)
function streamsAt(pos) {
  const file = currentM3u();
  if (!file) return null;
  if (!streamsMemo[file]) {
    const byFile = (parse(preferences.get("streamsByPlaylist")) || {})[file];
    if (Array.isArray(byFile)) streamsMemo[file] = byFile;
  }
  const byItem = streamsMemo[file];
  if (!Array.isArray(byItem)) return null;
  const list = byItem[pos];
  return Array.isArray(list) && list.length ? list : null;
}
function streamsForCurrent() {
  const pos = mpv.getNumber("playlist-pos");
  const list = streamsAt(pos);
  return list ? { pos, list } : null;
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
function applyStream(pos, list, index, seek) {
  const i = ((index % list.length) + list.length) % list.length;
  cursor[(activePlaylistFile || "") + "#" + pos] = i;
  const pick = list[i];
  // seek: undefined = keep the current position, null = start over, number = that time.
  const t = seek === undefined ? mpv.getNumber("time-pos") : seek;
  pendingSeek = t !== null && isFinite(t) && t > 0 ? { time: t } : null;
  markItemStart(true);
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
  rememberStyle(cur.pos, cur.list);
}

// Jump straight to one alternate (picked from the Streams submenu).
function selectStream(index) {
  const cur = streamsForCurrent();
  if (!cur) { iina.core.osd("No alternate streams for this item"); return; }
  applyStream(cur.pos, cur.list, index);
  rememberStyle(cur.pos, cur.list);
}

// A manual stream switch is remembered for the rest of the playlist: later
// episodes whose own pick differs start on the alternate with the same quality and
// source (e.g. "1080p WEB-DL"), when it has one. Failover doesn't count.
const manualStyle = {};   // playlist file -> style key
const styleKey = (label) => String(label || "").split(" · ")[0].trim();
function rememberStyle(pos, list) {
  const k = styleKey(list[curIndex(pos, list.length)].l);
  if (k && activePlaylistFile) manualStyle[activePlaylistFile] = k;
}
// Returns true when it swapped the current (untouched) item to the remembered
// style, which reloads it; the caller then skips the rest of this load.
function applyPreferredStyle() {
  const want = activePlaylistFile && manualStyle[activePlaylistFile];
  if (!want) return false;
  const cur = streamsForCurrent();
  if (!cur || (activePlaylistFile + "#" + cur.pos) in cursor) return false;
  if (styleKey(cur.list[0].l) === want) return false;
  const j = cur.list.findIndex((x) => styleKey(x.l) === want);
  if (j < 1) return false;
  applyStream(cur.pos, cur.list, j, null);
  return true;
}
// "1080p WEB-DL · 2.1GB (1/6)" when an episode starts, so a poor pick is obvious.
function announceStream() {
  const cur = streamsForCurrent();
  if (!cur) return;
  const i = curIndex(cur.pos, cur.list.length), l = cur.list[i].l;
  if (l) try { core.osd(`${l} (${i + 1}/${cur.list.length})`); } catch (e) {}
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
  menu.addItem(menu.item("Skip now", () => skipNow(), kb("kbSkip")));
  menu.addItem(menu.item("Cancel auto-skip / dismiss", () => cancelNow(), kb("kbCancel")));
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
  if (!canTouchPlayer()) return;
  mpv.command("sub-add", [iina.utils.resolvePath(dest), "select", `Subtitles (${want.code.toUpperCase()}, OpenSubtitles)`, want.code]);
  log.log(`ContentPlay loaded ${want.code} subtitles for ${id}`);
}

event.on("mpv.file-loaded", () => {
  if (closing) { closing = false; note("player alive again (file loaded): closing flag reset"); }
  playerActive = true;
  curNp = nowPlaying();
  note(`loaded pos ${mpv.getNumber("playlist-pos")} ${curNp ? curNp.sid : "(not ContentPlay)"} dur ${Math.round(mpv.getNumber("duration") || 0)}s`);
  // Restore position after a stream switch reloaded the same episode; otherwise
  // pick up where a previous session left off.
  if (pendingSeek) {
    const seek = pendingSeek;
    pendingSeek = null;
    mpv.command("seek", [String(seek.time), "absolute"]);
  } else {
    if (applyPreferredStyle()) return;   // reloads on the remembered style; the rest happens then
    announceStream();
    resumeIfSaved(curNp);
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
// "Credits End" / "End of Credits" marks where the credits stop, not where they start.
const RE_CREDITS_END = /credits?[\s-]*(end|over|finish)|end(ing)? of (the )?credits/i;
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
    if (!intro && RE_INTRO.test(t) && c.time < mid && c.end - c.time <= 100) intro = c;   // a longer "Intro" chapter includes the cold open: not the title sequence
    if (!post && RE_POST.test(t)) post = c;
  });
  // Credits: the latest back-half chapter that reads as credits (not a stinger).
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.time >= mid && RE_CREDITS.test(c.title || "") && !RE_POST.test(c.title || "") && !RE_CREDITS_END.test(c.title || "")) { credits = c; break; }
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

// Public skip markers (IntroDB, keyed by IMDb id + season/episode) are the primary
// source; the file's own chapters only cover what IntroDB doesn't have. They are per-release community timings, so
// each is sanity-checked against this file's duration before use (the outro must
// end where this file ends, i.e. the same cut). They drive the same buttons and
// countdowns as chapters. Series only.
const INTRODB = "https://api.introdb.app";
const markerKey = (np) => `m:${np.imdb}:${np.season}:${np.episode}`;
const isSeries = (np) => !!np && np.type !== "movie" && np.season != null && np.episode != null;
function markersFor(np) {
  if (!isSeries(np)) return Promise.resolve(null);
  cacheFor(np.imdb);
  return cached(markerKey(np), async () => {
    const d = await getJson(`${INTRODB}/segments?imdb_id=${np.imdb}&season=${np.season}&episode=${np.episode}`);
    const pick = (x) => (x && typeof x.start_sec === "number" && x.end_sec > x.start_sec ? [x.start_sec, x.end_sec] : null);
    const m = { recap: pick(d && d.recap), intro: pick(d && d.intro), outro: pick(d && d.outro), post: pick(d && d.post_credits) };
    note(`introdb ${np.sid}: intro=${m.intro} recap=${m.recap} outro=${m.outro} post=${m.post}`);
    return m.recap || m.intro || m.outro || m.post ? m : null;
  }).catch((e) => { log.log("ContentPlay markers: " + e.message); return null; });
}
function withMarkers(seg, mk, dur) {
  if (!mk) return seg;
  // Timings are per release. The outro normally runs to the end of the video, so it
  // only lines up with this file's length when both are the same cut; if it doesn't,
  // the intro/recap are probably shifted too, so use none of it.
  if (!(dur > 0)) return seg;
  if (!mk.outro || Math.abs(mk.outro[1] - dur) > 12) {
    note(`markers ignored: ${mk.outro ? "outro ends " + Math.round(mk.outro[1]) + "s" : "no outro"} vs file ${Math.round(dur)}s (different cut)`);
    return seg;
  }
  const mkSeg = (a, title) => ({ title, time: a[0], end: a[1], index: -1, manual: true });
  const fits = (a, frac, min, max) => a && a[1] - a[0] >= min && a[1] - a[0] <= max && (dur <= 0 || a[0] < dur * frac);
  // IntroDB is the primary source: each field it supplies (and that passes the
  // checks) replaces the chapter-derived one; anything it lacks falls back to the
  // file's own chapters.
  const out = seg || { recap: null, intro: null, credits: null, post: null };
  if (fits(mk.recap, 0.3, 5, 300)) out.recap = mkSeg(mk.recap, "Recap");
  if (fits(mk.intro, 0.4, 5, 180)) out.intro = mkSeg(mk.intro, "Intro");
  if (mk.outro[0] >= dur * 0.6) out.credits = mkSeg(mk.outro, "Credits");
  if (out.credits && mk.post && mk.post[0] >= out.credits.time && mk.post[0] < dur - 3) out.post = mkSeg(mk.post, "Post-credits");
  else if (out.credits && out.post && out.post.time < out.credits.time) out.post = null;   // a chapter stinger that no longer follows the credits
  return out.recap || out.intro || out.credits ? out : null;
}
// Before/as an episode loads: markers for this episode and the next, and nothing
// older kept. Re-classifies when this episode's arrive.
function loadMarkers() {
  const cur = nowPlaying(), nxt = nowPlaying(mpv.getNumber("playlist-pos") + 1);
  if (!isSeries(cur)) return;
  cacheFor(cur.imdb);
  const keep = [cur, nxt].filter(isSeries).map(markerKey);
  for (const k of Object.keys(cacheStore)) if (k.startsWith("m:") && !keep.includes(k)) delete cacheStore[k];
  markersFor(cur).then((mk) => {
    if (!canTouchPlayer()) return;
    const n = nowPlaying();
    if (mk && n && n.sid === cur.sid) { computeSegments(); try { tick(); } catch (e) {} }
  });
  if (isSeries(nxt)) markersFor(nxt);
}

function computeSegments() {
  const { list, dur } = readChapters();
  const np = nowPlaying();
  const mk = isSeries(np) ? cget(markerKey(np)) : null;
  seg = withMarkers(classifyChapters(list, dur), mk, dur);
  needReclass = (list.length > 0 || !!mk) && dur <= 0;
  const names = seg ? ["recap", "intro", "credits", "post"].filter((k) => seg[k]).map((k) => k + "@" + Math.round(seg[k].time) + (seg[k].manual ? "(db)" : "")).join(", ") : "none";
  note(`skip markers ${np ? np.sid : "?"}: ${names} (of ${list.length} chapters, ${Math.round(dur)}s)`);
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
  overlay.onMessage("ready", () => { note("overlay webview ready"); onOverlayLoaded(); });
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
    dismissWidget(d && d.kind);
  });
}

function onOverlayLoaded() {
  if (closing || !overlayLoaded) return;
  note(`overlay loaded (ready=${overlayReady})`);
  bindOverlayHandlers();
  try { overlay.show(); overlay.setClickable(false); } catch (e) {}
  if (!overlayReady) overlayReady = true;
  if (pendingShow) { const p = pendingShow; pendingShow = null; sendShow(p.kind, p.total); }
  pushPreload();
  try { tick(); } catch (e) {} // catch up on anything that should already be on screen
}

function sendShow(kind, total) {
  if (!overlayReady) { pendingShow = { kind, total }; return; }
  try {
    overlay.show();
    overlay.postMessage("show", { kind, total, paused: mpv.getFlag("pause"), hint: clickOK() ? "" : skipKeyHint(total > 0) });
    overlay.setClickable(clickOK());
  } catch (e) {}
}
let shownTotal = 0;   // countdown length of the widget on screen (0 = manual button)
function showWidget(kind, total) { shown = kind; shownTotal = total; note(`widget ${kind} countdown ${total}s at ${Math.round(mpv.getNumber("time-pos"))}s`); sendShow(kind, total); }
function hideWidget() {
  if (shown === null && !pendingShow) return;
  shown = null; pendingShow = null;
  if (overlayReady) { try { overlay.postMessage("hide", {}); overlay.setClickable(clickOK() && infoShown); } catch (e) {} }
}

// Shortcut/menu actions for whichever skip card is on screen.
//  skip   -> do it now (skip the intro/recap, go to the next episode), even mid-countdown
//  cancel -> stop a running auto-skip (the card stays as a manual button); on a manual
//            card, dismiss it for this episode
function skipNow() {
  note(`skip pressed (card: ${shown || "none"})`);
  if (!shown) { try { core.osd("Nothing to skip right now"); } catch (e) {} return; }
  onAction(shown, false);
}
function dismissWidget(k) {
  if (k === "recap") recapDone = true;
  else if (k === "intro") introDone = true;
  else nextDone = true;
  hideWidget();
}
function cancelNow() {
  note(`cancel pressed (card: ${shown || "none"}, countdown ${shownTotal}s)`);
  if (!shown) { try { core.osd("Nothing to cancel right now"); } catch (e) {} return; }
  if (shownTotal > 0) {
    note(`countdown cancelled for ${shown}`);
    showWidget(shown, 0);
    try { core.osd("Auto-skip cancelled"); } catch (e) {}
  } else {
    note(`dismissed ${shown}`);
    dismissWidget(shown);
  }
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
  note(`action ${kind}${auto ? " (auto)" : ""} at ${Math.round(mpv.getNumber("time-pos"))}s`);
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
  warmInfo();
  if (!skip.enabled) return;
  seg = null; shown = null; recapDone = introDone = nextDone = false;
  hideWidget();
  computeSegments();
  loadMarkers();
});

event.on("mpv.time-pos.changed", () => { try { tick(); } catch (e) {} });
// The title's data is dropped when another title starts (cacheFor) or the window closes
// (teardown). Not on end-file: that fires after the position has already moved on to
// the next item, so clearing there threw away the next episode's prefetched data.
event.on("iina.window-will-close", () => { teardown("window-will-close"); cacheClear(); flushProgress(); flushNotes(); });
event.on("mpv.shutdown", () => teardown("mpv.shutdown"));
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

function nowPlaying(pos) {
  const lang = langFor();
  const sid = lang && lang.subIds && lang.subIds[pos === undefined ? mpv.getNumber("playlist-pos") : pos];
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

// Everything fetched for the panel is kept for the one title being watched, so
// pausing, re-pausing and moving between its episodes costs no requests. It holds
// a single show or movie at a time: starting another title replaces it, and it is
// dropped when playback ends. Memory only; nothing is written to disk.
let cacheTitle = null, cacheStore = {};
function cacheFor(imdb) {
  if (cacheTitle !== imdb) { cacheTitle = imdb; cacheStore = {}; }
}
function cacheClear() {
  cacheTitle = null; cacheStore = {};
  for (const k of Object.keys(infoCache)) delete infoCache[k];
}
function cget(k) {
  const e = cacheStore[k];
  return e && e.x > Date.now() ? e.v : undefined;
}
// ttl is only for lookups that came back empty, so they are retried soon.
function cset(k, v, ttl) { cacheStore[k] = { v, x: ttl ? Date.now() + ttl : Infinity }; }
// Return the cached value, or run fetch() and keep what it returns. A thrown
// error is not cached (transient); a null/empty result is, but only briefly.
async function cached(k, fetch) {
  const hit = cget(k);
  if (hit !== undefined) return hit;
  const v = await fetch();
  cset(k, v === undefined ? null : v, v ? 0 : 10 * MIN);
  return v;
}
const MIN = 6e4;
// Clear data left on disk by 1.6.0, which cached for days.
try { if (preferences.get("infoCache")) { preferences.set("infoCache", ""); preferences.sync(); } } catch (e) {}

// Only the fields the panel uses, so the cache stays small.
function slimMeta(m) {
  const top = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  return { name: m.name, logo: m.logo, releaseInfo: m.releaseInfo, year: m.year, runtime: m.runtime, genres: top(m.genres, 3),
           director: top(m.director, 3), writer: top(m.writer, 3), cast: top(m.cast, 5), description: String(m.description || "").slice(0, 500),
           imdbRating: m.imdbRating, moviedb_id: m.moviedb_id };
}

// First paint needs only Cinemeta (cached per title, with this and the next few
// episodes alongside); everything else fills in via refresh().
async function buildInfo(np, refresh) {
  const cm = (pref("cinemetaUrl", "https://v3-cinemeta.strem.io") || "").replace(/\/+$/, "");
  const isMovie = np.type === "movie";
  cacheFor(np.imdb);
  const tk = `t:${np.type}:${np.imdb}`, ek = `e:${np.imdb}:${np.season}:${np.episode}`;
  let m = cget(tk), ep = isMovie ? null : cget(ek);
  if (!m || (!isMovie && ep === undefined)) {
    const d = await getJson(`${cm}/meta/${np.type}/${np.imdb}.json`);
    const full = (d && d.meta) || {};
    if (!full.name) throw new Error("no metadata");
    m = slimMeta(full);
    cset(tk, m);
    if (!isMovie) {
      // Keep just this episode and the next few (what playback will reach), each
      // trimmed to what the panel shows. A missing one (not aired/listed yet) is
      // remembered briefly, then rechecked.
      for (const v of full.videos || []) {
        const n = +v.episode - np.episode;
        if (+v.season !== np.season || n < 0 || n > 3) continue;
        cset(`e:${np.imdb}:${v.season}:${v.episode}`, { name: v.name || v.title || "", rating: v.rating || "",
          overview: String(v.overview || v.description || "").slice(0, 300) });
      }
      ep = cget(ek);
      if (ep === undefined) { ep = null; cset(ek, null, 10 * MIN); }
    }
  }
  const R = { imdb: m.imdbRating || "", ep: ep && ep.rating || "", rt: "", lb: null };
  const vm = { clickable: clickOK(), title: m.name, logo: m.logo || "", sub: [m.releaseInfo || m.year, m.runtime, list(m.genres, 3)].filter(Boolean).join(" · "),
               desc: (ep && ep.overview) || m.description || "", rows: [], recs: [], chips: [], note: "" };
  if (ep) vm.episode = { tag: `S${np.season} · E${String(np.episode).padStart(2, "0")}`, name: ep.name || "" };
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
  const omdb = (preferences.get("omdbApiKey") || "").trim();
  const rtHit = cget(`rt:${np.imdb}`);
  if (!omdb && !rtHit) vm.note = "Add an OMDb key in ContentPlay settings to show Rotten Tomatoes.";
  rebuild();

  // Extras run in the background (and come straight from the cache when fresh);
  // each failure just leaves that bit out.
  if (rtHit) { R.rt = rtHit; rebuild(); }
  else if (omdb) cached(`rt:${np.imdb}`, async () => {
    const o = await getJson(`https://www.omdbapi.com/?i=${np.imdb}&apikey=${encodeURIComponent(omdb)}`);
    const rt = ((o && o.Ratings) || []).find((x) => x.Source === "Rotten Tomatoes");
    return rt ? rt.Value : "";
  }).then((rt) => { if (rt) { R.rt = rt; rebuild(); } }).catch((e) => log.log("ContentPlay omdb: " + e.message));
  if (isMovie) cachedLetterboxd(np.imdb).then((r) => { if (r && r.rating) { R.lb = r.rating; rebuild(); } });
  if (ep && m.moviedb_id && (preferences.get("tmdbApiKey") || "").trim()) cached(`te:${m.moviedb_id}:${np.season}:${np.episode}`, async () => {
    const t = await tmdbReq(`/tv/${m.moviedb_id}/season/${np.season}/episode/${np.episode}`);
    const crew = t.crew || [];
    const rows = [];
    const dir = crew.filter((c) => c.job === "Director").map((c) => c.name);
    const wr = crew.filter((c) => c.department === "Writing").map((c) => c.name);
    const gs = (t.guest_stars || []).map((c) => c.name);
    if (dir.length) rows.push(["Director", list(dir, 2)]);
    if (wr.length) rows.push(["Writer", list(wr, 2)]);
    if (gs.length) rows.push(["Guests", list(gs, 4)]);
    return { rows, overview: String(t.overview || "").slice(0, 300) };
  }).then((t) => {
    if (!t) return;
    vm.rows = t.rows.concat(baseRows());
    if (!(ep && ep.overview) && t.overview) vm.desc = t.overview;
    refresh();
  }).catch(() => {});
  cached(`r:${np.type}:${np.imdb}`, () => loadRecs(np, m, cm))
    .then((r) => { if (r && r.recs && r.recs.length) { vm.recs = r.recs; vm.recsTitle = r.title; refresh(); } })
    .catch((e) => log.log("ContentPlay recs: " + e.message));
  return vm;
}

// Letterboxd through the cache; the sidebar's rating lookup shares it.
function cachedLetterboxd(id) {
  return cached(`lb:${id}`, () => fetchLetterboxd(id)).catch(() => null);
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
  infoTimer = setTimeout(() => { if (!canTouchPlayer()) return; showInfoNow().catch((e) => log.log("ContentPlay pause info: " + e.message)); }, pauseInfo.delayMs);
}
// One build per episode, shared by the pause handler and the warm-up.
const infoPending = {};
function getInfo(np) {
  const key = np.sid;
  if (infoCache[key]) return Promise.resolve(infoCache[key]);
  if (!infoPending[key]) {
    const refresh = () => {
      const vm = infoCache[key];
      if (!vm) return;
      if (infoShown && infoKey === key) { try { overlay.postMessage("infoUpdate", vm); } catch (e) {} }
      else pushPreload(key);   // ratings/recommendations that land while playing
    };
    infoPending[key] = buildInfo(np, refresh).then((vm) => {
      const keys = Object.keys(infoCache);
      if (keys.length >= 2) delete infoCache[keys[0]];   // just the current and previous episode
      return (infoCache[key] = vm);
    }).finally(() => { delete infoPending[key]; });
  }
  return infoPending[key];
}

// Give the overlay the current episode's panel (and let it fetch its images) while
// it is playing, so a pause paints at once. Fired by events only: an episode
// loading, its data arriving, or the overlay becoming ready.
function pushPreload(sid) {
  if (!canTouchPlayer() || !overlayReady || infoShown) return;
  const np = nowPlaying();
  const vm = np && (!sid || np.sid === sid) && infoCache[np.sid];
  if (vm) { try { overlay.postMessage("preload", vm); } catch (e) {} }
}
function warmInfo() {
  if (!pauseInfo.enabled) return;
  const np = nowPlaying();
  if (!np) return;
  getInfo(np).then(() => pushPreload(np.sid)).catch((e) => log.log("ContentPlay prefetch: " + e.message));
}
async function showInfoNow() {
  if (!canTouchPlayer()) return;
  if (!mpv.getFlag("pause") || infoShown) return;
  const np = nowPlaying();
  if (!np) return;
  const key = np.sid;
  const vm = await getInfo(np);
  if (!canTouchPlayer()) return;
  // Re-check: the user may have resumed or skipped while we were fetching.
  const now = nowPlaying();
  if (!mpv.getFlag("pause") || !now || now.sid !== key) return;
  infoShown = true; infoKey = key;
  note(`pause info shown for ${key}`);
  try {
    overlay.show();
    overlay.postMessage("info", vm);
    overlay.setClickable(clickOK());
  } catch (e) {}
}
function hideInfo() {
  clearTimeout(infoTimer);
  if (!infoShown) return;
  infoShown = false; infoKey = null;
  if (overlayReady) { try { overlay.postMessage("infoHide", {}); overlay.setClickable(clickOK() && !!shown); } catch (e) {} }
}

// ---------------------------------------------------------------------------
// Playback health: stream failover, next-episode pre-resolve, resume
// ---------------------------------------------------------------------------
// A debrid link can hang, stall or die. When a ContentPlay item stops making
// progress (or never opens), switch to the next ranked alternate and carry on from
// the same spot, a few tries at most; an item that failed outright and was skipped
// by mpv is retried the same way. A minute and a half before an episode ends, the
// next link is resolved ahead of time so the hand-off doesn't wait on the debrid
// service. Playback position is remembered per episode so reopening resumes.
const health = { loadSecs: 45, stallSecs: 20, maxTries: 2, warmSecs: 120 };
const DAY = 864e5;
const tries = {}, warmed = {};
let loadedItem = false, loadedPos = -1, watchTimer = null, watchWhy = "", lastFailover = 0;
let played = null;     // { pos, t, dur } of the item that last loaded
let anyLoaded = false, curNp = null;

// One watchdog at a time, armed by a player event and checked once when it fires:
//  - an item starts loading (playlist-pos changes)   -> "didn't open" unless it loads
//  - the player starts buffering (paused-for-cache)  -> "stalled" unless it recovers
// Nothing runs while playback is healthy. When it fires it re-reads the player's
// own state rather than trusting what it saw when armed (events can arrive in any
// order, and the log showed a healthy episode being reloaded by a late one).
function disarm() { clearTimeout(watchTimer); watchTimer = null; watchWhy = ""; }
function arm(secs, why) {
  disarm();
  watchWhy = why;
  const pos = mpv.getNumber("playlist-pos"), t0 = mpv.getNumber("time-pos");
  watchTimer = setTimeout(() => onWatch(why, pos, t0), secs * 1000);
}
function playing() {   // the file is open and producing frames
  return mpv.getNumber("duration") > 0 && isFinite(mpv.getNumber("time-pos"));
}
function onWatch(why, armedPos, t0) {
  watchTimer = null; watchWhy = "";
  if (!canTouchPlayer()) return;
  try {
    const cur = streamsForCurrent();
    if (!cur || cur.pos !== armedPos) return;                        // moved on to another item
    if (Date.now() - lastFailover < 8000) return;                    // just switched; give the new stream time
    if (why === "stalled") {
      const t = mpv.getNumber("time-pos");
      if (!mpv.getFlag("paused-for-cache") || (isFinite(t) && isFinite(t0) && Math.abs(t - t0) > 0.5)) return;   // recovered
    } else if (playing() || loadedPos === armedPos) return;          // it did open
    failover(cur.pos, why, why === "stalled" ? undefined : null);
  } catch (e) {}
}
function markItemStart(force) {
  const pos = mpv.getNumber("playlist-pos");
  if (!force && pos === loadedPos) return;    // a late position event for an item that already loaded
  loadedItem = false; loadedPos = -1;
  arm(health.loadSecs, "didn't open");
}
event.on("mpv.playlist-pos.changed", () => { playerActive = true; markItemStart(false); });
event.on("mpv.paused-for-cache.changed", () => {
  const buffering = mpv.getFlag("paused-for-cache");
  note(buffering ? "buffering…" : "buffering done");
  if (buffering) { if (loadedItem) arm(health.stallSecs, "stalled"); }
  else if (watchWhy === "stalled") disarm();
});

function failover(pos, why, seek) {
  if (pref("failoverEnabled", true) === false) return false;
  const list = streamsAt(pos);
  if (!list || list.length < 2) return false;
  const key = (activePlaylistFile || "") + "#" + pos;
  const max = Math.min(health.maxTries, list.length - 1), n = tries[key] || 0;
  if (n >= max) return false;
  tries[key] = n + 1;
  lastFailover = Date.now();
  note(`failover (${why}) item ${pos}, try ${n + 1}/${max}`);
  applyStream(pos, list, curIndex(pos, list.length) + 1, seek);
  try { core.osd(`Stream ${why} · switched (try ${n + 1}/${max})`); } catch (e) {}
  return true;
}

// Right after a file loads: did mpv skip an item that failed to open? That shows
// as the next one loading without its predecessor having loaded, right after the
// one before it played to its end (or as item 1 loading first in a fresh list).
event.on("mpv.file-loaded", () => {
  const pos = mpv.getNumber("playlist-pos");
  loadedItem = true; loadedPos = pos;
  armPreResolve();
  if (watchWhy === "didn't open") disarm();
  const prev = played;
  played = { pos, t: 0, dur: mpv.getNumber("duration") || 0 };
  const skipped = pos > 0 && (prev ? prev.pos === pos - 2 && prev.dur > 0 && prev.t > prev.dur - 30 : !anyLoaded && pos === 1);
  anyLoaded = true;
  if (prev && prev.pos !== pos) for (const k of Object.keys(tries)) delete tries[k];   // moved on: forget old failures
  try { if (skipped && streamsAt(pos - 1)) failover(pos - 1, "failed to open", null); } catch (e) {}
});

// Armed when the length becomes known (file loaded / duration reported): fires
// once, when the last warmSecs of the episode begin. If it fires early (paused, or
// the position changed) it re-arms from where playback actually is.
let nextTimer = null;
function armPreResolve() {
  clearTimeout(nextTimer);
  const dur = mpv.getNumber("duration"), t = mpv.getNumber("time-pos");
  if (!(dur > 0) || !hasNext()) return;
  nextTimer = setTimeout(preResolveNext, Math.max(1, dur - (isFinite(t) ? t : 0) - health.warmSecs) * 1000);
}
function preResolveNext() {
  if (!canTouchPlayer() || pref("preResolve", true) === false) return;
  const pos = mpv.getNumber("playlist-pos"), dur = mpv.getNumber("duration"), t = mpv.getNumber("time-pos");
  if (!(dur > 0) || !isFinite(t) || !hasNext()) return;
  if (dur - t > health.warmSecs + 5) { armPreResolve(); return; }
  const key = (activePlaylistFile || "") + "#" + (pos + 1);
  if (warmed[key]) return;
  const url = mpv.getString(`playlist/${pos + 1}/filename`) || "";
  if (!STREAM_URL.test(url)) return;
  warmed[key] = true;
  // First byte only, no redirect-following: it makes the service resolve the link
  // (the slow part) without downloading anything.
  try { iina.utils.exec("/usr/bin/curl", ["-s", "-o", "/dev/null", "-m", "20", "-r", "0-0", url]).catch(() => {}); } catch (e) {}
}
event.on("mpv.duration.changed", () => armPreResolve());

// Resume points: sid -> { t, d, at }. Only episodes/movies opened from ContentPlay,
// only when meaningfully started and not nearly finished; capped and expired.
const PROGRESS_KEY = "progress", PROGRESS_MAX = 40;
let progress = null, progDirty = false, progSaved = 0;
function progLoad() {
  if (!progress) { const p = parse(preferences.get(PROGRESS_KEY)); progress = p && typeof p === "object" ? p : {}; }
  return progress;
}
function noteProgress(np, t, dur) {
  if (pref("resumeEnabled", true) === false) return;
  if (!np || !(dur > 0) || !(t > 0)) return;
  const P = progLoad();
  if (t > dur - 60 || t > dur * 0.93) { if (P[np.sid]) { delete P[np.sid]; progDirty = true; } }   // finished
  else if (t > 45) { P[np.sid] = { t: Math.floor(t), d: Math.floor(dur), at: Date.now() }; progDirty = true; }
}
function flushProgress() {
  if (!progDirty) return;
  const P = progLoad(), now = Date.now();
  for (const k of Object.keys(P)) if (!P[k] || now - P[k].at > 60 * DAY) delete P[k];
  Object.keys(P).sort((a, b) => P[a].at - P[b].at).slice(0, Math.max(0, Object.keys(P).length - PROGRESS_MAX)).forEach((k) => delete P[k]);
  try { preferences.set(PROGRESS_KEY, JSON.stringify(P)); preferences.sync(); } catch (e) {}
  progDirty = false; progSaved = now;
}
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
let resumeWant = null;   // { sid, t, at, tries } until playback is seen at the saved spot
function resumeIfSaved(np) {
  if (pref("resumeEnabled", true) === false) return;
  const e = np && progLoad()[np.sid];
  if (!e || !(e.t > 45) || Date.now() - e.at > 60 * DAY) return;
  const target = Math.max(0, e.t - 5);
  mpv.command("seek", [String(target), "absolute"]);
  resumeWant = { sid: np.sid, t: target, at: Date.now(), tries: 1 };
  note(`resume ${np.sid} -> ${Math.round(target)}s`);
  try { core.osd(`Resumed at ${clock(e.t)}`); } catch (er) {}
}
// A seek right at file-loaded can be dropped (stream not seekable yet, or another
// resume mechanism moving the position); check and repeat it a couple of times.
function checkResume(t) {
  if (!resumeWant) return;
  const w = resumeWant;
  if (!curNp || curNp.sid !== w.sid) { resumeWant = null; return; }
  if (t >= w.t - 3) { note(`resume reached ${Math.round(t)}s`); resumeWant = null; return; }
  if (Date.now() - w.at < 2500) return;
  if (w.tries >= 3) { note(`resume gave up at ${Math.round(t)}s (wanted ${Math.round(w.t)}s)`); resumeWant = null; return; }
  w.tries++; w.at = Date.now();
  note(`resume retry ${w.tries}: at ${Math.round(t)}s, wanted ${Math.round(w.t)}s`);
  mpv.command("seek", [String(w.t), "absolute"]);
}
// "S6E22 · resume 14:10" for the Recently played tiles.
function withResume(list) {
  if (pref("resumeEnabled", true) === false) return list;
  const P = progLoad();
  return list.map((r) => {
    let best = null, bestSid = "";
    for (const sid of Object.keys(P)) if ((sid === r.id || sid.indexOf(r.id + ":") === 0) && (!best || P[sid].at > best.at)) { best = P[sid]; bestSid = sid; }
    if (!best) return r;
    const parts = bestSid.split(":");
    return Object.assign({}, r, { resume: (parts[1] ? `S${parts[1]}E${parts[2]} · ` : "") + `resume ${clock(best.t)}` });
  });
}

event.on("mpv.time-pos.changed", () => {
  try {
    const t = mpv.getNumber("time-pos"), dur = mpv.getNumber("duration");
    if (played && isFinite(t)) { played.t = t; if (!played.dur) played.dur = dur || 0; }
    if (isFinite(t)) checkResume(t);
    noteProgress(curNp, t, dur);
    if (progDirty && Date.now() - progSaved > 60000) flushProgress();
  } catch (e) {}
});
event.on("mpv.pause.changed", () => { if (mpv.getFlag("pause")) flushProgress(); });
event.on("mpv.end-file", () => { playerActive = false; flushProgress(); disarm(); note("end-file"); });

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
  try { const l = JSON.parse(preferences.get("recent") || "[]"); if (Array.isArray(l)) recent = withResume(l); } catch (e) {}
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
    avoidHardSubs: pref("avoidHardSubs", true) !== false,
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
    const r = await cachedLetterboxd(id);
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
