'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  // /real/ 以下で開いたときは本人専用モード（NAR実データ）の API を使う
  const REAL_MODE = /^\/real(\/|$)/.test(location.pathname);
  const API = REAL_MODE ? '/real/api' : '/api';
  const state = { tracks: [], track: null, races: [], raceNo: null, data: null, sort: 'rank', source: null };
  let requestSeq = 0;

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const pct = (p) => (isNum(p) ? (p * 100).toFixed(1) : '-');
  const fmtOdds = (o) => (isNum(o) ? o.toFixed(1) : '-');
  const fmtEv = (ev) => (isNum(ev) ? ev.toFixed(2) : '-');

  async function getJson(path) {
    const res = await fetch(API + path, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (body.dataStatus) renderSource(body.dataStatus);
    if (!res.ok) throw new Error(body.error || `通信エラー (${res.status})`);
    return body;
  }

  // ---------- 実データ / モック の表示 ----------
  const fmtClock = (iso) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  function renderSource(ds) {
    const badge = $('source-badge');
    const note = $('source-note');
    badge.hidden = false;
    badge.classList.toggle('real', !ds.mock);
    badge.classList.toggle('fallback', Boolean(ds.fallback));
    let text;
    let detail = '';
    if (!ds.mock) {
      text = '実データ';
      detail = `NAR公式データ（${ds.fetchedAt ? `${fmtClock(ds.fetchedAt)} 取得・最大5分ごとに更新` : '取得済み'}）`;
      if (ds.warnings && ds.warnings.length) detail += ' ⚠ ' + ds.warnings.join(' / ');
    } else if (ds.fallback) {
      text = 'モック';
      detail = `⚠ 実データを取得できなかったため、サンプルデータ（架空）を表示中: ${ds.reason || ''}`;
    } else {
      text = 'モック';
      detail = 'サンプルデータ（架空のレース）を表示中';
    }
    badge.textContent = text;
    badge.title = detail;
    note.textContent = detail;
    note.classList.toggle('warn', Boolean(ds.fallback || (ds.warnings && ds.warnings.length)));
    // 実データ ⇔ モックが切り替わったら競馬場一覧から読み直す
    if (state.source && state.source !== ds.source) {
      state.source = ds.source;
      init();
      return;
    }
    state.source = ds.source;
  }

  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text || '';
    el.classList.toggle('error', Boolean(isError));
  }

  // ---------- URL hash (#ooi-3) で共有できるようにする ----------
  function readHash() {
    const m = /^#([a-z0-9_]+)(?:-(\d+))?$/i.exec(location.hash);
    return m ? { track: m[1], race: m[2] ? Number(m[2]) : null } : {};
  }
  function writeHash() {
    if (state.track && state.raceNo) history.replaceState(null, '', `#${state.track}-${state.raceNo}`);
  }

  // ---------- selectors ----------
  function renderTracks() {
    $('track-tabs').innerHTML = state.tracks
      .map(
        (t) =>
          `<button type="button" class="chip${t.id === state.track ? ' active' : ''}" role="tab" aria-selected="${t.id === state.track}" data-track="${esc(t.id)}">${esc(t.name)}</button>`,
      )
      .join('');
  }

  function renderRaces() {
    $('race-tabs').innerHTML = state.races
      .map((r) => {
        const active = r.raceNo === state.raceNo;
        const sub = r.skip ? '見送り' : esc(r.startTime || '');
        return `<button type="button" class="chip${active ? ' active' : ''}${r.skip ? ' skip' : ''}" role="tab" aria-selected="${active}" data-race="${r.raceNo}">${r.raceNo}R<span class="chip-sub">${sub}</span></button>`;
      })
      .join('');
    const activeChip = $('race-tabs').querySelector('.active');
    if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  async function selectTrack(trackId, raceNo) {
    state.track = trackId;
    renderTracks();
    setStatus('読み込み中…');
    const seq = ++requestSeq;
    try {
      const { races } = await getJson(`/races?track=${encodeURIComponent(trackId)}`);
      if (seq !== requestSeq) return;
      state.races = races;
      const target = races.find((r) => r.raceNo === raceNo) || races[0];
      if (!target) {
        state.raceNo = null;
        renderRaces();
        clearRace();
        setStatus('この競馬場のレースはありません');
        return;
      }
      await selectRace(target.raceNo);
    } catch (e) {
      if (seq === requestSeq) setStatus(e.message, true);
    }
  }

  async function selectRace(raceNo) {
    state.raceNo = raceNo;
    renderRaces();
    writeHash();
    setStatus('読み込み中…');
    const seq = ++requestSeq;
    try {
      const data = await getJson(`/race?track=${encodeURIComponent(state.track)}&race=${raceNo}`);
      if (seq !== requestSeq) return;
      state.data = data;
      setStatus('');
      renderRace();
    } catch (e) {
      if (seq === requestSeq) setStatus(e.message, true);
    }
  }

  function clearRace() {
    $('race-info').innerHTML = '';
    $('summary').innerHTML = '';
    $('horses').innerHTML = '';
  }

  // ---------- race ----------
  function horseLabel(h) {
    if (!h) return '<span class="none">該当なし</span>';
    const mark = h.mark ? `<span class="mark ${esc(h.mark)}">${markSymbol(h.mark)}</span>` : '';
    return `${mark}${esc(h.number)} ${esc(h.name)}`;
  }
  function markSymbol(key) {
    return { honmei: '◎', taikou: '○', tanana: '▲', renka: '△', ana: '☆' }[key] || '';
  }
  function pickSub(h) {
    if (!h) return '';
    return `勝率${pct(h.winProb)}% / ${fmtOdds(h.odds)}倍 / 期待値${fmtEv(h.ev)}`;
  }

  function renderRace() {
    const { race, summary } = state.data;
    $('race-info').innerHTML = `<strong>${esc(race.trackName)} ${esc(race.raceNo)}R ${esc(race.name || '')}</strong><br>${esc(race.surface || '')}${esc(race.distance ?? '-')}m ・ 馬場:${esc(race.going || '-')} ・ ${esc(race.headcount)}頭 ・ 発走 ${esc(race.startTime || '-')}`;

    const v = summary.verdict;
    const verdict = `
      <div class="verdict${v.skip ? ' skip' : ''}">
        <div class="verdict-title">${v.skip ? '⚠ ' : '✔ '}${esc(v.message)}</div>
        ${v.reasons.length ? `<ul>${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>`;

    const pick = (label, h, extra = '') => `
      <div class="pick card ${extra}">
        <div class="pick-label">${label}</div>
        <div class="pick-main">${horseLabel(h)}</div>
        <div class="pick-sub">${pickSub(h)}</div>
      </div>`;

    const list = (label, items, fmt, extra = 'wide') => `
      <div class="pick card ${extra}">
        <div class="pick-label">${label}</div>
        ${items.length ? `<ul class="pick-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '<div class="none">該当なし</div>'}
      </div>`;

    $('summary').innerHTML = `
      ${verdict}
      <div class="summary-grid">
        ${pick('本命（一番勝ちそう）', summary.honmei)}
        ${pick('対抗', summary.taikou)}
        ${pick('穴馬（妙味あり）', summary.ana)}
        ${list('危険な人気馬', summary.dangerous, (h) => `${horseLabel(h)} <span class="pick-sub">${esc(h.popularity)}番人気・期待値${fmtEv(h.ev)}</span>`, '')}
        ${list('単勝候補（買う価値）', summary.winCandidates, (h) => `${horseLabel(h)} <span class="pick-sub">期待値<b>${fmtEv(h.ev)}</b>・${fmtOdds(h.odds)}倍</span>`)}
        ${list('馬連 組み合わせ候補', summary.quinellaCandidates, (q) => `<b>${esc(q.label)}</b> <span class="pick-sub">${esc(q.names.join(' - '))}（${esc(q.note)}）</span>`)}
      </div>`;

    renderHorses();
  }

  function sortedHorses() {
    const hs = state.data.horses.slice();
    if (state.sort === 'number') hs.sort((a, b) => a.number - b.number);
    else if (state.sort === 'ev') hs.sort((a, b) => (b.prediction.ev ?? -1) - (a.prediction.ev ?? -1) || a.prediction.rank - b.prediction.rank);
    else hs.sort((a, b) => a.prediction.rank - b.prediction.rank);
    return hs;
  }

  function recentHtml(h) {
    const fin = Array.isArray(h.recentFinishes) ? h.recentFinishes : [];
    const mar = Array.isArray(h.recentMargins) ? h.recentMargins : [];
    if (!fin.some(isNum)) return '<div>近走: データなし</div>';
    const items = fin
      .map((f, i) => {
        if (!isNum(f)) return '<span>-</span>';
        const cls = f === 1 ? 'win' : f <= 3 ? 'place' : '';
        const m = isNum(mar[i]) ? ` title="着差 ${mar[i]}秒"` : '';
        return `<span class="${cls}"${m}>${f}</span>`;
      })
      .join('');
    return `<div>近5走（左が前走）<div class="recent">${items}</div></div>`;
  }

  function recText(rec) {
    if (!rec || !isNum(rec.starts)) return '-';
    return `${rec.starts}戦${rec.wins ?? 0}勝 (3着内${rec.places ?? 0})`;
  }

  function renderHorses() {
    const labels = state.data.meta.factorLabels;
    $('horses').innerHTML = sortedHorses()
      .map((h) => {
        const p = h.prediction;
        const evKey = p.evRating.key;
        const cardCls = evKey === 'high' ? 'ev-high' : evKey === 'value' ? 'ev-value' : '';
        const mark = p.mark ? `<div class="mark ${esc(p.mark)}" title="${esc(p.markLabel)}">${esc(p.markSymbol)}</div>` : '<div class="mark empty">・</div>';
        const frame = isNum(h.frame) && h.frame >= 1 && h.frame <= 8 ? h.frame : 1;
        const wChange = isNum(h.weight) && isNum(h.lastWeight) && h.weight !== h.lastWeight ? `(${h.weight > h.lastWeight ? '+' : ''}${h.weight - h.lastWeight})` : '';
        const factors = Object.entries(p.factors)
          .map(([k, v]) => `<span>${esc(labels[k] || k)}</span><span class="fbar"><span style="width:${isNum(v) ? v : 0}%"></span></span><span>${isNum(v) ? v : 'データなし'}</span>`)
          .join('');
        return `
        <article class="horse card ${cardCls}">
          <div class="horse-top">
            ${mark}
            <div class="num f${frame}">${esc(h.number)}</div>
            <div class="horse-name">
              <div class="name">${esc(h.name)}</div>
              <div class="sub">${esc(h.jockey || '騎手未定')} ・ ${isNum(h.weight) ? h.weight : '-'}kg${esc(wChange)} ・ ${p.popularity ? `${p.popularity}番人気` : '人気-'}</div>
            </div>
          </div>
          <div class="stats">
            <div class="stat"><div class="stat-label">予測勝率</div><div class="stat-value">${pct(p.winProb)}<small>%</small></div></div>
            <div class="stat"><div class="stat-label">単勝オッズ</div><div class="stat-value">${fmtOdds(h.odds)}<small>${isNum(h.odds) ? '倍' : ''}</small></div></div>
            <div class="stat ev ${esc(evKey)}"><div class="stat-label">期待値</div><div class="stat-value">${fmtEv(p.ev)}</div><div class="stat-note">${esc(p.evRating.label)}</div></div>
            <div class="stat"><div class="stat-label">予想指数</div><div class="stat-value">${isNum(p.index) ? p.index.toFixed(0) : '-'}</div></div>
          </div>
          <div class="bar" aria-hidden="true"><span style="width:${isNum(p.index) ? p.index : 0}%"></span></div>
          <ul class="reasons">
            ${p.reasons.map((r) => `<li class="${r.type}"><span class="ico">${r.type === 'plus' ? '＋' : '－'}</span><span>${esc(r.text)}</span></li>`).join('')}
          </ul>
          <details class="details">
            <summary>詳しいデータ</summary>
            ${recentHtml(h)}
            ${h.careerRecord ? `<div>全成績: ${esc(recText(h.careerRecord))}${isNum(h.bodyWeight) ? ` ／ 馬体重: ${h.bodyWeight}kg${isNum(h.bodyWeightDiff) ? `(${h.bodyWeightDiff > 0 ? '+' : ''}${h.bodyWeightDiff})` : ''}` : ''}</div>` : ''}
            <div>同距離: ${esc(recText(h.sameDistanceRecord))} ／ 当地: ${esc(recText(h.trackRecord))}</div>
            <div>馬場適性: ${isNum(h.surfaceAptitude) ? '★'.repeat(h.surfaceAptitude) : '-'} ／ 騎手評価: ${isNum(h.jockeyRating) ? h.jockeyRating : '-'} ／ クラス評価: ${isNum(h.classRating) ? h.classRating : '-'} ／ 休養: ${isNum(h.restDays) ? h.restDays + '日' : '-'}</div>
            <div class="factors">${factors}</div>
          </details>
        </article>`;
      })
      .join('') || '<div class="none">出走馬データがありません</div>';
  }

  // ---------- events ----------
  $('track-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-track]');
    if (btn && btn.dataset.track !== state.track) selectTrack(btn.dataset.track);
  });
  $('race-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-race]');
    if (btn) selectRace(Number(btn.dataset.race));
  });
  document.querySelector('.sort').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn || !state.data) return;
    state.sort = btn.dataset.sort;
    document.querySelectorAll('.sort button').forEach((b) => b.classList.toggle('active', b === btn));
    renderHorses();
  });

  async function init() {
    setStatus('読み込み中…');
    try {
      const { tracks } = await getJson('/tracks');
      state.tracks = tracks;
      if (!tracks.length) {
        setStatus(REAL_MODE && state.source === 'nar' ? '本日のNAR開催データはありません' : '競馬場データがありません');
        return;
      }
      const hash = readHash();
      const initial = tracks.find((t) => t.id === hash.track) || tracks[0];
      await selectTrack(initial.id, hash.race);
    } catch (e) {
      setStatus(`データを取得できませんでした: ${e.message}`, true);
    }
  }

  init();
})();
