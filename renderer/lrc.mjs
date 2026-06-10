// LRC (synced lyrics) parsing. Pure module: no DOM, unit-tested in renderer/tests/.

const STAMP_RE = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/;
const META_RE = /^\[([A-Za-z#]+):([^\]]*)\]\s*$/;

export function parseLrc(text) {
  const lines = [];
  const meta = {};

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    let rest = raw;
    const stamps = [];
    let m;
    while ((m = STAMP_RE.exec(rest))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0));
      rest = rest.slice(m[0].length);
    }
    if (stamps.length) {
      const lineText = rest.trim();
      for (const t of stamps) lines.push({ t, text: lineText });
    } else if ((m = META_RE.exec(raw.trim()))) {
      meta[m[1].toLowerCase()] = m[2].trim();
    }
  }

  // LRC offset tag is in ms; positive means lyrics should appear earlier.
  const offset = Number.parseInt(meta.offset, 10);
  if (!Number.isNaN(offset) && offset !== 0) {
    for (const line of lines) line.t = Math.max(0, line.t - offset / 1000);
  }

  lines.sort((a, b) => a.t - b.t);
  return { lines, meta };
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
