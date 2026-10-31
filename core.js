/* DiveFolk Logbook core: UDDF in, merged dives, DL7 (.zxu) and CSV out.
   Runs entirely in the browser; files never leave the user's computer. */
(function (root) {
  'use strict';

  const SPLIT_MAX_GAP_SEC = 30 * 60;   // surface break short enough to be the same dive
  const SPLIT_MAX_TANK_DIFF_BAR = 15;  // next dive starts where the last tank left off
  const SPLIT_NO_TANK_GAP_SEC = 5 * 60; // without tank data, only merge very short breaks

  function kids(el, name) {
    return Array.from(el.getElementsByTagNameNS('*', name));
  }
  function first(el, name) {
    const k = el.getElementsByTagNameNS('*', name);
    return k.length ? k[0] : null;
  }
  function num(el, name) {
    const n = first(el, name);
    if (!n || n.textContent.trim() === '') return null;
    const v = parseFloat(n.textContent);
    return isFinite(v) ? v : null;
  }

  // Shearwater writes local wall-clock time but tags it "Z"; treat it as local.
  function parseLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0),
             epoch: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 };
  }
  function fromEpoch(sec) {
    const d = new Date(sec * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
             h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), epoch: sec };
  }
  const p2 = n => String(n).padStart(2, '0');
  const stamp = t => `${t.y}${p2(t.mo)}${p2(t.d)}${p2(t.h)}${p2(t.mi)}${p2(t.s)}`;

  /* Parse one UDDF document (string) into an array of raw dives. */
  function parseUDDF(xmlText, DOMParserImpl, sourceName) {
    const P = DOMParserImpl || root.DOMParser;
    const doc = new P().parseFromString(xmlText, 'text/xml');
    const dc = first(doc, 'divecomputer');
    const computer = {
      model: dc ? (first(dc, 'model') || first(dc, 'name') || {}).textContent || '' : '',
      serial: dc && first(dc, 'serialnumber') ? first(dc, 'serialnumber').textContent : ''
    };
    return kids(doc, 'dive').map(dive => {
      const before = first(dive, 'informationbeforedive');
      const after = first(dive, 'informationafterdive');
      const start = parseLocal(first(before, 'datetime').textContent);
      const samples = kids(dive, 'waypoint').map(w => {
        const tp = first(w, 'tankpressure');
        return {
          t: num(w, 'divetime') || 0,
          depth: num(w, 'depth') || 0,
          tempK: num(w, 'temperature'),
          tankPa: tp && tp.textContent.trim() !== '' ? parseFloat(tp.textContent) : null
        };
      });
      const tank = first(dive, 'tankdata');
      let tankBegin = tank ? num(tank, 'tankpressurebegin') : null;
      let tankEnd = tank ? num(tank, 'tankpressureend') : null;
      if (!tankBegin) tankBegin = null;
      if (!tankEnd) tankEnd = null;
      const temps = samples.map(s => s.tempK).filter(v => v != null && v > 200);
      const duration = num(after, 'diveduration') ||
        (samples.length ? samples[samples.length - 1].t : 0);
      return {
        source: sourceName || '',
        computerNumber: num(before, 'divenumber'),
        start,
        duration,
        end: start.epoch + duration,
        maxDepth: num(after, 'greatestdepth') || Math.max(0, ...samples.map(s => s.depth)),
        minTempK: temps.length ? Math.min(...temps) : null,
        tankBeginBar: tankBegin != null ? tankBegin / 1e5 : null,
        tankEndBar: tankEnd != null ? tankEnd / 1e5 : null,
        samples,
        computer
      };
    });
  }

  /* De-duplicate (same start time) and sort. */
  function normalize(rawDives) {
    const seen = new Map();
    rawDives.forEach(d => { if (!seen.has(d.start.epoch)) seen.set(d.start.epoch, d); });
    return Array.from(seen.values()).sort((a, b) => a.start.epoch - b.start.epoch);
  }

  /* For each dive, should it be joined to the one before it? Returns booleans. */
  function suggestSplits(dives) {
    return dives.map((d, i) => {
      if (i === 0) return false;
      const prev = dives[i - 1];
      const gap = d.start.epoch - prev.end;
      if (gap < 0 || gap > SPLIT_MAX_GAP_SEC) return false;
      if (prev.tankEndBar != null && d.tankBeginBar != null) {
        return Math.abs(d.tankBeginBar - prev.tankEndBar) <= SPLIT_MAX_TANK_DIFF_BAR;
      }
      return gap <= SPLIT_NO_TANK_GAP_SEC;
    });
  }

  /* Combine dives into logged dives. joinPrev[i] = dive i continues dive i-1.
     opts.drop[i] = leave piece i out; opts.shiftHours[headIndex] = clock fix for that dive.
     Each result carries headIndex: the index of the first piece of its group in `dives`. */
  function mergeDives(dives, joinPrev, opts) {
    const o = opts || {};
    const drop = o.drop || [];
    const shiftHours = o.shiftHours || {};
    const groups = [];
    dives.forEach((d, i) => {
      if (i > 0 && joinPrev[i] && groups.length) groups[groups.length - 1].idx.push(i);
      else groups.push({ headIndex: i, idx: [i] });
    });
    return groups.map(gr => {
      const g = gr.idx.filter(i => !drop[i]).map(i => dives[i]);
      if (!g.length) return null;
      const shift = (shiftHours[gr.headIndex] || 0) * 3600;
      const head = g[0], tail = g[g.length - 1];
      const samples = [];
      g.forEach((d, k) => {
        const off = d.start.epoch - head.start.epoch;
        if (k > 0) { // fill the surface break with 10 s surface samples
          const lastT = samples.length ? samples[samples.length - 1].t : 0;
          for (let t = lastT + 10; t < off; t += 10) samples.push({ t, depth: 0, tempK: null, tankPa: null });
        }
        d.samples.forEach(s => samples.push({ ...s, t: s.t + off }));
      });
      const temps = g.map(d => d.minTempK).filter(v => v != null);
      return {
        headIndex: gr.headIndex,
        parts: g.map(d => d.computerNumber),
        sources: g.map(d => d.source),
        clockFixHours: shift / 3600,
        start: shift ? fromEpoch(head.start.epoch + shift) : head.start,
        endTime: fromEpoch(tail.end + shift),
        duration: tail.end - head.start.epoch,
        bottomTime: g.reduce((a, d) => a + d.duration, 0),
        maxDepth: Math.max(...g.map(d => d.maxDepth)),
        minTempK: temps.length ? Math.min(...temps) : null,
        tankBeginBar: head.tankBeginBar,
        tankEndBar: tail.tankEndBar,
        samples,
        computer: head.computer
      };
    }).filter(Boolean);
  }

  const r = (v, n) => (v == null ? '' : String(+v.toFixed(n)));
  const kToC = k => (k == null ? null : k - 273.15);

  /* Build one DL7 (.zxu) file containing every selected dive. */
  function toDL7(logged, opts) {
    const o = Object.assign({ software: 'DiveFolkLogbook^0.2^C', now: new Date() }, opts || {});
    const n = o.now;
    const nowStamp = `${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}${p2(n.getHours())}${p2(n.getMinutes())}${p2(n.getSeconds())}`;
    const comp = (logged[0] && logged[0].computer) || { model: '', serial: '' };
    const out = [];
    out.push(`FSH|^~<>{}|${o.software}|ZXU|${nowStamp}|`);
    out.push(`ZRH|^~<>{}|${comp.model}|${comp.serial}|MFWG|ThM|C|bar|L|`);
    out.push('ZAR{}');
    logged.forEach((d, i) => {
      const seq = i + 1;
      out.push(`ZDH|${seq}|${d.logNumber}|I|Q10S|${stamp(d.start)}||||||`);
      out.push('ZDP{');
      let lastTemp = null;
      d.samples.forEach(s => {
        const tc = kToC(s.tempK);
        if (tc != null) lastTemp = tc;
        const temp = tc != null ? tc : lastTemp;
        const bar = s.tankPa != null && s.tankPa > 0 ? s.tankPa / 1e5 : null;
        // fields: time(min)|depth(m)|gas|pO2|ascent viol|deco viol|ceiling|water temp(C)|warning|tank(bar)|...
        out.push(`|${r(s.t / 60, 4)}|${r(s.depth, 2)}|||||0|${r(temp, 1)}||${r(bar, 1)}||||||`);
      });
      out.push('ZDP}');
      const drop = d.tankBeginBar != null && d.tankEndBar != null ? d.tankBeginBar - d.tankEndBar : null;
      out.push(`ZDT|${seq}|${d.logNumber}|${r(d.maxDepth, 2)}|${stamp(d.endTime)}|${r(kToC(d.minTempK), 1)}|${r(drop, 1)}|`);
    });
    return out.join('\n') + '\n';
  }

  /* Plain summary spreadsheet in US units. */
  function toCSV(logged) {
    const head = ['Dive #', 'Date', 'Start time', 'Duration (min)', 'Max depth (ft)',
                  'Min water temp (F)', 'Start pressure (psi)', 'End pressure (psi)', 'Shearwater dive #s'];
    const rows = logged.map(d => [
      d.logNumber,
      `${d.start.y}-${p2(d.start.mo)}-${p2(d.start.d)}`,
      `${p2(d.start.h)}:${p2(d.start.mi)}`,
      Math.round(d.duration / 60),
      Math.round(d.maxDepth * 3.28084),
      d.minTempK != null ? Math.round(kToC(d.minTempK) * 9 / 5 + 32) : '',
      d.tankBeginBar != null ? Math.round(d.tankBeginBar * 14.5038) : '',
      d.tankEndBar != null ? Math.round(d.tankEndBar * 14.5038) : '',
      d.parts.join(' + ')
    ]);
    return [head, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  }

  const api = { parseUDDF, normalize, suggestSplits, mergeDives, toDL7, toCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DivefolkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
