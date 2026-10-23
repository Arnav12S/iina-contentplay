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

const { mpv, preferences, event, menu, http } = iina;
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

log.log("ContentPlay main entry ready.");
