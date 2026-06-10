// LRC (synced lyrics) parsing. Pure module: no DOM, unit-tested in renderer/tests/.

const STAMP_RE = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/;
const META_RE = /^\[([A-Za-z#]+):([^\]]*)\]\s*$/;
const WORD_RE = /<(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?>\s*([^<]*)/g;

function stampSeconds(m, s, frac) {
  return Number(m) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
}

export function parseLrc(text) {
  const lines = [];
  const meta = {};

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    let rest = raw;
    const stamps = [];
    let m;
    while ((m = STAMP_RE.exec(rest))) {
      stamps.push(stampSeconds(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (stamps.length) {
      let lineText = rest.trim();
      let words;
      if (lineText.includes("<")) {
        // Enhanced LRC: inline <mm:ss.xx> word timestamps.
        const parsed = [...lineText.matchAll(WORD_RE)]
          .map((w) => ({ t: stampSeconds(w[1], w[2], w[3]), text: w[4].trim() }))
          .filter((w) => w.text);
        if (parsed.length) {
          words = parsed;
          lineText = parsed.map((w) => w.text).join(" ");
        }
      }
      for (const t of stamps) lines.push(words ? { t, text: lineText, words } : { t, text: lineText });
    } else if ((m = META_RE.exec(raw.trim()))) {
      meta[m[1].toLowerCase()] = m[2].trim();
    }
  }

  // LRC offset tag is in ms; positive means lyrics should appear earlier.
  const offset = Number.parseInt(meta.offset, 10);
  if (!Number.isNaN(offset) && offset !== 0) {
    for (const line of lines) {
      line.t = Math.max(0, line.t - offset / 1000);
      for (const w of line.words || []) w.t = Math.max(0, w.t - offset / 1000);
    }
  }

  lines.sort((a, b) => a.t - b.t);
  return { lines, meta };
}

// Word-level timing for one line. Real stamps when the LRC is enhanced;
// otherwise words are spread across [line.t, lineEndT) proportionally to
// their length — approximate by design, the post-MVP path is forced alignment.
export function wordTimings(line, lineEndT) {
  if (line.words) return line.words;
  const tokens = line.text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, lineEndT - line.t);
  let acc = 0;
  return tokens.map((text, i) => {
    const t = line.t + (acc / total) * span;
    acc += weights[i];
    return { t, text };
  });
}

// Index of the last line with t <= now, or -1 before the first line.
export function activeLineIndex(lines, now) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= now) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
