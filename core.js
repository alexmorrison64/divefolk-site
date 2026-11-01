/* DiveFolk Logbook core: UDDF and Garmin FIT in, merged dives, DL7 (.zxu) and CSV out.
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

  /* ---------- Garmin and other FIT files ----------
     A small reader for the FIT format, written from Garmin's public protocol
     description. It reads only what a dive log needs. */
  const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
  const FIT_TYPES = { // base type -> [size, reader, invalid value]
    0x00: [1, 'u8', 0xFF], 0x01: [1, 's8', 0x7F], 0x02: [1, 'u8', 0xFF], 0x0A: [1, 'u8', 0],
    0x0D: [1, 'u8', 0xFF], 0x83: [2, 's16', 0x7FFF], 0x84: [2, 'u16', 0xFFFF], 0x8B: [2, 'u16', 0],
    0x85: [4, 's32', 0x7FFFFFFF], 0x86: [4, 'u32', 0xFFFFFFFF], 0x8C: [4, 'u32', 0],
    0x88: [4, 'f32', null], 0x89: [8, 'f64', null]
  };
  // global message -> field numbers we keep
  const FIT_WANT = {
    0: [1, 2, 3],                 // file_id: manufacturer, product, serial
    18: [2, 3, 4, 5, 6, 7],       // session: start, lat, long, sport, sub sport, elapsed
    20: [253, 13, 92],            // record: time, temperature (C), depth (mm)
    34: [253, 5],                 // activity: time, local time
    268: [0, 3, 10, 11],          // dive_summary: reference, max depth, dive #, bottom time
    319: [253, 0, 1],             // tank_update: time, sensor, pressure (0.01 bar)
    323: [0, 1, 2]                // tank_summary: sensor, start, end (0.01 bar)
  };

  function readFIT(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 12) throw new Error('Not a FIT file');
    const hs = u8[0];
    if (String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== '.FIT') throw new Error('Not a FIT file');
    const end = Math.min(u8.length, hs + dv.getUint32(4, true));
    const defs = {}, out = {};
    let p = hs, lastTs = 0;
    const read = (off, kind, le) => {
      switch (kind) {
        case 'u8': return dv.getUint8(off); case 's8': return dv.getInt8(off);
        case 'u16': return dv.getUint16(off, le); case 's16': return dv.getInt16(off, le);
        case 'u32': return dv.getUint32(off, le); case 's32': return dv.getInt32(off, le);
        case 'f32': return dv.getFloat32(off, le); case 'f64': return dv.getFloat64(off, le);
      }
    };
    while (p < end) {
      const h = u8[p++];
      if (h & 0x80) { // compressed timestamp data message
        const def = defs[(h >> 5) & 0x03];
        const off = h & 0x1F;
        lastTs = (off >= (lastTs & 0x1F)) ? (lastTs & ~0x1F) + off : (lastTs & ~0x1F) + off + 0x20;
        if (!def) throw new Error('Damaged FIT file');
        p = dataMsg(def, p, lastTs);
      } else if (h & 0x40) { // definition message
        const le = u8[p + 1] === 0;
        const gnum = dv.getUint16(p + 2, le);
        const n = u8[p + 4];
        p += 5;
        const fields = [];
        for (let i = 0; i < n; i++, p += 3) fields.push({ num: u8[p], size: u8[p + 1], type: u8[p + 2] });
        let devSize = 0;
        if (h & 0x20) { const nd = u8[p++]; for (let i = 0; i < nd; i++, p += 3) devSize += u8[p + 1]; }
        defs[h & 0x0F] = { gnum, le, fields, devSize };
      } else {
        const def = defs[h & 0x0F];
        if (!def) throw new Error('Damaged FIT file');
        p = dataMsg(def, p, null);
      }
    }
    function dataMsg(def, p, ts) {
      const want = FIT_WANT[def.gnum];
      const msg = {};
      for (const f of def.fields) {
        const keep = f.num === 253 || (want && want.includes(f.num));
        const t = FIT_TYPES[f.type];
        if (keep && t && f.size >= t[0]) {
          const v = read(p, t[1], def.le);
          if (v !== t[2] && !(typeof v === 'number' && isNaN(v))) msg[f.num] = v;
        }
        p += f.size;
      }
      p += def.devSize;
      // any message's timestamp anchors later compressed timestamps
      if (msg[253] != null) lastTs = msg[253];
      else if (ts != null) msg[253] = ts;
      if (want) (out[def.gnum] = out[def.gnum] || []).push(msg);
      return p;
    }
    return out;
  }

  const SUB_SPORTS = { 53: 'single gas', 54: 'multi gas', 55: 'gauge', 63: 'CCR' };
  const APNEA = [56, 57, 121];

  /* Parse one FIT file. Returns { kind: 'dive' | 'apnea' | 'other', dives: [...] }. */
  function parseFIT(input, sourceName) {
    const m = readFIT(input);
    const s = (m[18] || [])[0];
    if (!s || s[5] !== 53) return { kind: 'other', dives: [] };
    if (APNEA.includes(s[6])) return { kind: 'apnea', dives: [] };
    const act = (m[34] || [])[0];
    const startUtc = s[2];
    // local time = UTC + the offset the watch recorded; fall back to UTC
    const offset = act && act[5] != null && act[253] != null ? act[5] - act[253] : 0;
    const start = fromEpoch(FIT_EPOCH + startUtc + offset);
    const sum = (m[268] || []).find(x => x[0] === 18) || (m[268] || [])[0] || {};
    const recs = (m[20] || []).filter(r => r[253] != null && r[253] >= startUtc);
    // tank pressure: first sensor only
    const tu = (m[319] || []).filter(x => x[1] != null);
    const sensor = tu.length ? tu[0][0] : null;
    const tank = tu.filter(x => x[0] === sensor);
    let ti = 0;
    const samples = [];
    let lastT = -10;
    recs.forEach(r => {
      const t = r[253] - startUtc;
      while (ti + 1 < tank.length && tank[ti + 1][253] <= r[253]) ti++;
      if (t - lastT < 10) return; // keep one sample every 10 seconds
      lastT = t;
      const bar = tank.length && tank[ti][253] <= r[253] ? tank[ti][1] / 100 : null;
      samples.push({ t, depth: r[92] != null ? r[92] / 1000 : 0,
                     tempK: r[13] != null ? r[13] + 273.15 : null, tankPa: bar != null ? bar * 1e5 : null });
    });
    const ts = (m[323] || []).find(x => sensor == null || x[0] === sensor) || null;
    const temps = recs.map(r => r[13]).filter(v => v != null);
    const lastRec = recs.length ? recs[recs.length - 1][253] - startUtc : 0;
    const duration = sum[11] != null ? Math.round(sum[11] / 1000) : (s[7] != null ? Math.round(s[7] / 1000) : lastRec);
    const fid = (m[0] || [])[0] || {};
    const semi = v => v == null ? null : +(v * 180 / 2147483648).toFixed(6);
    return { kind: 'dive', dives: [{
      source: sourceName || '',
      computerNumber: sum[10] != null ? sum[10] : null,
      start,
      duration,
      end: start.epoch + duration,
      maxDepth: sum[3] != null ? sum[3] / 1000 : Math.max(0, ...samples.map(x => x.depth)),
      minTempK: temps.length ? Math.min(...temps) + 273.15 : null,
      tankBeginBar: ts && ts[1] != null ? ts[1] / 100 : (tank.length ? tank[0][1] / 100 : null),
      tankEndBar: ts && ts[2] != null ? ts[2] / 100 : (tank.length ? tank[tank.length - 1][1] / 100 : null),
      samples,
      computer: { model: fid[1] === 1 ? 'Garmin' : 'FIT', serial: fid[3] != null ? String(fid[3]) : '' },
      gps: s[3] != null && s[4] != null ? { lat: semi(s[3]), lon: semi(s[4]) } : null,
      mode: SUB_SPORTS[s[6]] || '',
      timeIsUTC: !offset
    }] };
  }

  /* ---------- .zip and .gz files (Garmin downloads) ---------- */
  async function inflate(bytes, format) {
    const ds = new DecompressionStream(format);
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function blobBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }
  /* List and open the files inside a zip without loading the whole zip at once. */
  async function zipEntries(blob) {
    const tailLen = Math.min(blob.size, 65557);
    const tail = await blobBytes(blob, blob.size - tailLen, blob.size);
    const tv = new DataView(tail.buffer);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a zip file');
    const cdSize = tv.getUint32(e + 12, true), cdOff = tv.getUint32(e + 16, true);
    if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw new Error('zip64');
    const cd = await blobBytes(blob, cdOff, cdOff + cdSize);
    const cv = new DataView(cd.buffer);
    const list = [];
    for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50;) {
      const method = cv.getUint16(p + 10, true), comp = cv.getUint32(p + 20, true), size = cv.getUint32(p + 24, true);
      const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
      const lho = cv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
      list.push({ name, size, open: async () => {
        const lh = await blobBytes(blob, lho, lho + 30);
        const lv = new DataView(lh.buffer);
        const start = lho + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
        const data = await blobBytes(blob, start, start + comp);
        if (method === 0) return data;
        if (method === 8) return inflate(data, 'deflate-raw');
        throw new Error('Unsupported zip compression');
      } });
      p += 46 + nl + xl + cl;
    }
    return list;
  }

  /* Turn whatever the diver dropped in (UDDF, FIT, .fit.gz, zips, zips inside zips)
     into dive pieces. onProgress(done, total) is optional. */
  async function readDiveFiles(files, opts) {
    const o = opts || {};
    const result = { dives: [], bad: [], other: 0, apnea: 0, files: 0, zip64: [] };
    const queue = files.map(f => ({ name: f.name, blob: f }));
    let done = 0;
    const lower = n => n.toLowerCase();
    while (queue.length) {
      const it = queue.shift();
      const n = lower(it.name);
      try {
        if (it.lazy && n.endsWith('.zip')) it.blob = new Blob([await it.lazy.open()]);
        if (n.endsWith('.zip')) {
          const entries = await zipEntries(it.blob);
          entries.filter(x => /\.(fit|fit\.gz|uddf|zip)$/i.test(x.name) && x.size < 200e6)
            .forEach(x => queue.push({ name: x.name.split('/').pop(), lazy: x }));
          continue;
        }
        let bytes = it.lazy ? await it.lazy.open() : new Uint8Array(await it.blob.arrayBuffer());
        if (n.endsWith('.gz')) bytes = await inflate(bytes, 'gzip');
        result.files++;
        if (n.endsWith('.uddf') || n.endsWith('.xml')) {
          result.dives.push(...parseUDDF(new TextDecoder().decode(bytes), o.DOMParser, it.name));
        } else {
          const r = parseFIT(bytes, it.name);
          if (r.kind === 'dive') result.dives.push(...r.dives);
          else if (r.kind === 'apnea') result.apnea++;
          else result.other++;
        }
      } catch (err) {
        if (String(err.message) === 'zip64') result.zip64.push(it.name); else result.bad.push(it.name);
      }
      done++;
      if (o.onProgress && done % 25 === 0) o.onProgress(done, done + queue.length);
    }
    return result;
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
        computer: head.computer,
        gps: head.gps || null
      };
    }).filter(Boolean);
  }

  const r = (v, n) => (v == null ? '' : String(+v.toFixed(n)));
  const kToC = k => (k == null ? null : k - 273.15);

  /* Build one DL7 (.zxu) file containing every selected dive. */
  function toDL7(logged, opts) {
    const o = Object.assign({ software: 'DiveFolkLogbook^0.3^C', now: new Date() }, opts || {});
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
                  'Min water temp (F)', 'Start pressure (psi)', 'End pressure (psi)', 'Computer dive #s', 'Entry GPS'];
    const rows = logged.map(d => [
      d.logNumber,
      `${d.start.y}-${p2(d.start.mo)}-${p2(d.start.d)}`,
      `${p2(d.start.h)}:${p2(d.start.mi)}`,
      Math.round(d.duration / 60),
      Math.round(d.maxDepth * 3.28084),
      d.minTempK != null ? Math.round(kToC(d.minTempK) * 9 / 5 + 32) : '',
      d.tankBeginBar != null ? Math.round(d.tankBeginBar * 14.5038) : '',
      d.tankEndBar != null ? Math.round(d.tankEndBar * 14.5038) : '',
      d.parts.filter(v => v != null).join(' + '),
      d.gps ? `${d.gps.lat}, ${d.gps.lon}` : ''
    ]);
    return [head, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  }

  /* ---------- Paper logbook rows (from the DiveFolk AI photo prompt) ---------- */
  // The DiveFolk spreadsheet's core columns, in order.
  const PAPER_COLS = ['Dive #', 'Date', 'Time in', 'Time out', 'Bottom time (min)', 'Max depth (ft)',
    'Dive site', 'Location', 'Country', 'Buddy', 'Water temp at depth (°F)', 'Visibility (ft)',
    'Start pressure (psi)', 'End pressure (psi)', 'Weight (lb)', 'Exposure suit', 'Notes'];
  const PAPER_KEYS = ['num', 'date', 'timeIn', 'timeOut', 'minutes', 'depthFt', 'site', 'location',
    'country', 'buddy', 'tempF', 'visFt', 'startPsi', 'endPsi', 'weightLb', 'suit', 'notes'];
  function headerKey(h) {
    const x = h.toLowerCase().replace(/[^a-z#°]+/g, ' ').trim();
    if (/^(dive )?(#|no|num|number)\b|^dive #/.test(x) || x === 'dive' || x === '#') return 'num';
    if (/\bdate\b/.test(x)) return 'date';
    if (/time in|start time|entry time|^start$|^in$/.test(x)) return 'timeIn';
    if (/time out|end time|exit time|^out$/.test(x)) return 'timeOut';
    if (/bottom time|minutes|duration|dive time/.test(x)) return 'minutes';
    if (/depth/.test(x)) return 'depthFt';
    if (/site/.test(x)) return 'site';
    if (/location|town|region/.test(x)) return 'location';
    if (/country/.test(x)) return 'country';
    if (/buddy|partner/.test(x)) return 'buddy';
    if (/temp/.test(x)) return 'tempF';
    if (/vis/.test(x)) return 'visFt';
    if (/start (pressure|psi|bar)|pressure in|air in|psi in|start psi/.test(x)) return 'startPsi';
    if (/end (pressure|psi|bar)|pressure out|air out|psi out|end psi/.test(x)) return 'endPsi';
    if (/weight|lead/.test(x)) return 'weightLb';
    if (/suit|exposure|wetsuit/.test(x)) return 'suit';
    if (/note|comment/.test(x)) return 'notes';
    return null;
  }
  function splitCSVLine(line, delim) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(v => v.trim());
  }
  const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function parseDateText(v) {
    v = (v || '').trim();
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v))) return { y: +m[1], mo: +m[2], d: +m[3] };
    if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(v))) { let y = +m[3]; if (y < 100) y += 2000; return { y, mo: +m[1], d: +m[2] }; }
    if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(v)) && MONTH[m[1].slice(0, 3).toLowerCase()])
      return { y: +m[3], mo: MONTH[m[1].slice(0, 3).toLowerCase()], d: +m[2] };
    if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(v)) && MONTH[m[2].slice(0, 3).toLowerCase()])
      return { y: +m[3], mo: MONTH[m[2].slice(0, 3).toLowerCase()], d: +m[1] };
    return null;
  }
  function parseTimeText(v) {
    v = (v || '').trim().toLowerCase();
    const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?/.exec(v);
    if (!m || (!m[2] && !m[3])) return null;
    let h = +m[1]; const mi = +(m[2] || 0);
    if (m[3] && m[3][0] === 'p' && h < 12) h += 12;
    if (m[3] && m[3][0] === 'a' && h === 12) h = 0;
    return h < 24 && mi < 60 ? h * 60 + mi : null;
  }
  const numText = v => { const m = /-?\d+(?:[.,]\d+)?/.exec(String(v || '').replace(/,(?=\d{3}\b)/g, '')); return m ? parseFloat(m[0].replace(',', '.')) : null; };

  /* Read pasted or saved paper-log rows: CSV, tab-separated (copied from a chat or
     spreadsheet) or a Markdown table. Returns { rows, unknownHeaders }. */
  function parsePaperLog(text) {
    let lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    lines = lines.filter(l => !/^```/.test(l) && !/^\|?\s*:?-{3,}/.test(l));
    if (!lines.length) return { rows: [], unknownHeaders: [] };
    const md = lines[0].startsWith('|');
    const delim = md ? '|' : (lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ','));
    const split = l => { let c = splitCSVLine(l, delim); if (md) c = c.slice(1, c[c.length - 1] === '' ? -1 : undefined); return c; };
    const head = split(lines[0]);
    const keys = head.map(headerKey);
    const unknownHeaders = head.filter((h, i) => h && !keys[i]);
    const rows = lines.slice(1).map(l => {
      const c = split(l), r = {};
      keys.forEach((k, i) => { if (k && c[i] != null && c[i] !== '' && r[k] == null) r[k] = c[i]; });
      r.dateObj = parseDateText(r.date);
      r.timeInMin = parseTimeText(r.timeIn);
      r.depthNum = numText(r.depthFt);
      r.minutesNum = numText(r.minutes);
      return r;
    }).filter(r => Object.keys(r).some(k => !/Obj|Num|Min$/.test(k) && r[k]));
    return { rows, unknownHeaders };
  }

  /* Match paper rows to logged computer dives (after joins and clock fixes).
     Returns pairs: { dive, paper, flags[] } covering every dive and every paper row. */
  function matchPaper(logged, paperRows, opts) {
    const o = Object.assign({ maxClockMin: 150 }, opts || {});
    const dayKey = t => `${t.y}-${t.mo}-${t.d}`;
    const used = new Set(), pairs = [];
    const byDay = {};
    logged.forEach((d, i) => { (byDay[dayKey(d.start)] = byDay[dayKey(d.start)] || []).push(i); });
    const taken = new Set();
    // pass 1: same day, closest start time (allowing for a wrong time zone)
    const cand = [];
    paperRows.forEach((p, pi) => {
      if (!p.dateObj) return;
      (byDay[dayKey(p.dateObj)] || []).forEach(di => {
        const d = logged[di];
        const dMin = d.start.h * 60 + d.start.mi;
        let score = 0, dt = null;
        if (p.timeInMin != null) { dt = Math.abs(dMin - p.timeInMin); if (dt > o.maxClockMin) return; score += dt; }
        if (p.depthNum != null) score += Math.abs(d.maxDepth * 3.28084 - p.depthNum) * 2;
        if (p.minutesNum != null) score += Math.abs(d.duration / 60 - p.minutesNum);
        cand.push({ pi, di, score, dt });
      });
    });
    cand.sort((a, b) => a.score - b.score);
    const link = {};
    cand.forEach(c => { if (!used.has(c.pi) && !taken.has(c.di)) { used.add(c.pi); taken.add(c.di); link[c.di] = c; } });
    // pass 2: same day, no times on paper: pair in order
    paperRows.forEach((p, pi) => {
      if (used.has(pi) || !p.dateObj) return;
      const free = (byDay[dayKey(p.dateObj)] || []).filter(di => !taken.has(di));
      if (free.length) { used.add(pi); taken.add(free[0]); link[free[0]] = { pi, di: free[0], dt: null }; }
    });
    logged.forEach((d, di) => {
      const l = link[di], flags = [];
      if (!l) { pairs.push({ dive: d, paper: null, flags: ['Computer dive with no paper entry'] }); return; }
      const p = paperRows[l.pi];
      if (l.dt != null && l.dt >= 45) {
        const hrs = Math.round(((p.timeInMin) - (d.start.h * 60 + d.start.mi)) / 60);
        flags.push(hrs ? `Paper time is ${Math.abs(hrs)} h ${hrs > 0 ? 'later' : 'earlier'}; try Clock fix ${hrs > 0 ? '+' : ''}${hrs} h` : 'Start times differ');
      }
      if (p.depthNum != null) {
        const ft = d.maxDepth * 3.28084;
        if (Math.abs(ft - p.depthNum) > Math.max(8, 0.15 * ft)) flags.push(`Depth: computer ${Math.round(ft)} ft, paper ${Math.round(p.depthNum)} ft`);
      }
      if (p.minutesNum != null && Math.abs(d.duration / 60 - p.minutesNum) > Math.max(8, 0.25 * p.minutesNum))
        flags.push(`Time: computer ${Math.round(d.duration / 60)} min, paper ${Math.round(p.minutesNum)} min`);
      pairs.push({ dive: d, paper: p, flags });
    });
    paperRows.forEach((p, pi) => {
      if (!used.has(pi)) pairs.push({ dive: null, paper: p, flags: [p.dateObj ? 'Paper entry with no computer dive' : 'Paper entry has no readable date'] });
    });
    const sortKey = x => x.dive ? x.dive.start.epoch : (x.paper.dateObj ? Date.UTC(x.paper.dateObj.y, x.paper.dateObj.mo - 1, x.paper.dateObj.d) / 1000 + (x.paper.timeInMin || 0) * 60 : Infinity);
    return pairs.sort((a, b) => sortKey(a) - sortKey(b));
  }

  /* One merged log in the DiveFolk spreadsheet's column order. Computer data wins for
     depth, time, temperature and pressure; paper wins for everything people write down. */
  function toMergedCSV(pairs) {
    const fmtTime = mins => mins == null ? '' : `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`;
    const head = PAPER_COLS.concat(['Source', 'Please check']);
    const rows = pairs.map(({ dive: d, paper: p, flags }) => {
      p = p || {};
      const date = d ? `${d.start.y}-${p2(d.start.mo)}-${p2(d.start.d)}` : (p.dateObj ? `${p.dateObj.y}-${p2(p.dateObj.mo)}-${p2(p.dateObj.d)}` : (p.date || ''));
      return [
        p.num || (d && d.logNumber) || '',
        date,
        d ? fmtTime(d.start.h * 60 + d.start.mi) : (p.timeIn || ''),
        d ? fmtTime(d.endTime.h * 60 + d.endTime.mi) : (p.timeOut || ''),
        d ? Math.round(d.duration / 60) : (p.minutes || ''),
        d ? Math.round(d.maxDepth * 3.28084) : (p.depthFt || ''),
        p.site || '', p.location || '', p.country || '', p.buddy || '',
        d && d.minTempK != null ? Math.round((d.minTempK - 273.15) * 9 / 5 + 32) : (p.tempF || ''),
        p.visFt || '',
        d && d.tankBeginBar != null ? Math.round(d.tankBeginBar * 14.5038) : (p.startPsi || ''),
        d && d.tankEndBar != null ? Math.round(d.tankEndBar * 14.5038) : (p.endPsi || ''),
        p.weightLb || '', p.suit || '', p.notes || '',
        d && p.dateObj ? 'Computer + paper' : (d ? 'Computer only' : 'Paper only'),
        flags.join('; ')
      ];
    });
    return [head, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  }

  const api = { parsePaperLog, matchPaper, toMergedCSV, PAPER_COLS, parseUDDF, parseFIT, readFIT, zipEntries, readDiveFiles, normalize, suggestSplits, mergeDives, toDL7, toCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DivefolkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
