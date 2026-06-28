/* CCFOLIA 로그 JSON → HTML 변환 사이트 로직 */
(() => {
  'use strict';

  let messages = [];      // 로드된 전체 메시지
  let roomId = '';

  const $ = (sel) => document.querySelector(sel);

  const els = {
    loadInfo: $('#loadInfo'),
    optionsPanel: $('#optionsPanel'),
    outputPanel: $('#outputPanel'),
    optTime: $('#optTime'),
    optStart: $('#optStart'),
    totalCount: $('#totalCount'),
    rangeInfo: $('#rangeInfo'),
    searchText: $('#searchText'),
    searchBtn: $('#searchBtn'),
    searchInfo: $('#searchInfo'),
    modeNum: $('#modeNum'),
    modeText: $('#modeText'),
    rangeNum: $('#rangeNum'),
    rangeText: $('#rangeText'),
    channelList: $('#channelList'),
    preview: $('#preview'),
    copyBtn: $('#copyBtn'),
    downloadBtn: $('#downloadBtn'),
    bookmarklet: $('#bookmarklet'),
  };

  // ── 유틸 ─────────────────────────────────────────────────────
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 색상 값은 style 속성에 들어가므로 안전한 문자만 허용
  const safeColor = (c) => {
    const v = String(c ?? '').trim();
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|[a-zA-Z]+)$/.test(v) ? v : '';
  };

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // 정보(info) 탭: 아바타 없는 시스템/연출용 메시지
  const isInfo = (m) => (m.channelName || m.channel) === 'info';
  // 시스템 메시지: 스탯 변동 등(예: "[ 호은 ] HP : 20 → 19")
  const isSystem = (m) => m.type === 'system';

  // ── 데이터 적용 (파일·postMessage 공통) ──────────────────────
  function applyData(data) {
    const list = Array.isArray(data) ? data : data && data.messages;
    if (!Array.isArray(list)) throw new Error('messages 배열을 찾을 수 없습니다.');
    messages = list;
    roomId = (data && data.roomId) || '';
    onLoaded();
  }

  // ── 파일 로드 ────────────────────────────────────────────────
  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try { applyData(JSON.parse(reader.result)); }
      catch (e) { alert('JSON 을 읽지 못했습니다: ' + e.message); }
    };
    reader.readAsText(file);
  }

  function onLoaded() {
    els.loadInfo.hidden = false;
    els.loadInfo.textContent = `총 ${messages.length}건 로드됨${roomId ? ` (방: ${roomId})` : ''}`;
    // 새 로그를 받으면 출력 범위·검색 상태를 처음으로 되돌린다.
    els.optStart.value = '1';
    els.searchText.value = '';
    setSearchInfo('', '');
    buildChannelFilter();
    els.optionsPanel.hidden = false;
    els.outputPanel.hidden = false;
    render();
  }

  // ── 채널 필터 UI ─────────────────────────────────────────────
  // 분류 기준은 채널명(channelName). 이름이 없으면 channel ID, 그것도 없으면 メイン.
  function channelLabel(m) { return m.channelName || m.channel || 'メイン'; }
  function channelKey(m) { return channelLabel(m); }

  // 필터에 보여줄 사람이 읽기 좋은 이름. 필터 값(key)은 그대로 두고 표시만 바꾼다.
  function channelDisplay(key) {
    const fixed = { main: '메인', 'メイン': '메인', other: '잡담', info: '정보' };
    if (fixed[key]) return fixed[key];
    const secret = /^비밀\((.+)\)$/.exec(key);   // 비밀(A,B) → 🔒A,B
    if (secret) return '🔒' + secret[1];
    return key;
  }

  // 필터 표시 순서: 메인 → 정보 → 잡담 → 비밀 → 그 외(등장 순)
  function channelRank(key) {
    if (key === 'main' || key === 'メイン') return 0;
    if (key === 'info') return 1;
    if (key === 'other') return 2;
    if (/^비밀\(/.test(key)) return 3;
    return 4;
  }

  function buildChannelFilter() {
    const map = new Map();
    for (const m of messages) {
      const k = channelKey(m);
      if (!map.has(k)) map.set(k, channelDisplay(k));
    }
    const ordered = [...map].sort((a, b) => channelRank(a[0]) - channelRank(b[0]));
    els.channelList.innerHTML = '';
    for (const [key, label] of ordered) {
      const id = 'ch_' + btoa(unescape(encodeURIComponent(key))).replace(/[^a-z0-9]/gi, '');
      const wrap = document.createElement('label');
      wrap.className = 'opt';
      wrap.innerHTML = `<input type="checkbox" class="chk-channel" value="${escapeHtml(key)}" id="${id}" checked> ${escapeHtml(label)}`;
      els.channelList.appendChild(wrap);
    }
    els.channelList.querySelectorAll('.chk-channel').forEach(c => c.addEventListener('change', render));
  }

  function enabledChannels() {
    return new Set([...els.channelList.querySelectorAll('.chk-channel:checked')].map(c => c.value));
  }

  // ── 필터 적용 ────────────────────────────────────────────────
  function filtered() {
    const chans = enabledChannels();
    return messages.filter(m => chans.has(channelKey(m)));
  }

  // ── 출력 범위(시작 번호 ~ 끝) ────────────────────────────────
  // 로그가 길 때 'N번째부터 끝까지'만 잘라 끊어서 저장할 수 있게 한다.
  // 번호는 1부터 시작하며, 비었거나 1 미만이면 처음부터 출력.
  function rangeStart(len) {
    let start = parseInt(els.optStart.value, 10);
    if (!Number.isFinite(start) || start < 1) start = 1;
    // len+1 은 '끝 다음'(빈 출력)을 의미. 그보다 큰 값은 끝으로 맞춘다.
    if (len && start > len + 1) start = len + 1;
    return start;
  }

  // 필터를 거친 뒤 시작 번호부터 끝까지 잘라낸 메시지 목록
  function ranged() {
    const all = filtered();
    return all.slice(rangeStart(all.length) - 1);
  }

  // ── 대사로 시작 위치 찾기 ────────────────────────────────────
  // 본문(text)이 입력과 '완전히' 일치하는 메시지를 찾아, 그 '다음'부터 출력되도록
  // 시작 번호를 설정한다. 일치하는 대사가 없으면 안내만 띄운다.
  function searchDialogue() {
    const q = els.searchText.value;
    if (!q) { setSearchInfo('', ''); return; }
    const all = filtered();
    const matches = [];
    all.forEach((m, i) => { if (String(m.text ?? '') === q) matches.push(i); });
    if (!matches.length) {
      setSearchInfo('일치하는 대사가 없습니다.', 'err');
      return;
    }
    const idx = matches[0];                 // 첫 번째 일치 대사
    els.optStart.value = String(idx + 2);   // 그 대사 '다음'부터(1-based)
    setSearchInfo('일치하는 대사를 찾았습니다.', 'ok');
    render();
  }

  function setSearchInfo(text, cls) {
    els.searchInfo.textContent = text;
    els.searchInfo.className = 'search-info' + (cls ? ' ' + cls : '');
  }

  // ── 이어 출력 모드 토글 ──────────────────────────────────────
  // 두 입력(갯수/대사)은 모두 시작 번호(optStart)를 정하는 같은 수단이라,
  // 모드를 바꿔도 현재 출력 범위는 그대로 유지된다. 화면만 하나씩 보여준다.
  function setMode(mode) {
    const isText = mode === 'text';
    els.rangeNum.hidden = isText;
    els.rangeText.hidden = !isText;
    els.modeNum.classList.toggle('active', !isText);
    els.modeText.classList.toggle('active', isText);
  }

  // ── HTML 생성 (ccfolia 스킨 포맷) ────────────────────────────
  const textToHtml = (s) => escapeHtml(s).replace(/\n/g, '<br>');

  const HR = `    <hr style="margin: 0; padding: 0; border: 0; flex-shrink: 0; border-top: 1px solid rgba(255, 255, 255, 0.08);">`;

  // 판정 결과 키워드별 스타일 (대성공 > 대실패)
  const RESULT_STYLES = {
    '대성공': 'color: rgb(255, 215, 0); font-size: 15px; font-weight: bold; text-shadow: rgba(255, 215, 0, 0.8) 0px 0px 5px;',
    '대단한 성공': 'color: rgb(255, 165, 0); font-size: 15px; font-weight: bold;',
    '어려운 성공': 'color: rgb(30, 144, 255); font-size: 15px; font-weight: bold;',
    '보통 성공': 'color: rgb(50, 205, 50); font-size: 15px; font-weight: bold;',
    '실패': 'color: rgb(255, 96, 78); font-size: 15px; font-weight: bold;',
    '대실패': 'color: red; font-size: 15px; font-weight: bold;',
  };

  // 주사위 굴림 정보 추출. extend.roll 이 있으면 판정 메시지로 본다.
  function rollInfo(m) {
    const r = m.extend && m.extend.roll;
    if (!r || typeof r.result !== 'string') return null;
    const full = (m.text || '') + r.result;            // 명령 + 굴림결과
    // result 문자열에서 마지막 결과 키워드(최종 판정)를 추출. 길이 우선 순서로 매칭.
    const re = /(대성공|대단한 성공|어려운 성공|보통 성공|대실패|실패)/g;
    let match, outcome = null;
    while ((match = re.exec(r.result)) !== null) outcome = match[1];
    return { full, outcome };
  }

  // 판정(주사위) 메시지 — 검은 알약 + 결과별 색상
  function judgementHtml(m, roll) {
    const nameColor = safeColor(m.color) || 'rgb(136, 136, 136)';
    const resultStyle = RESULT_STYLES[roll.outcome] || 'color: rgb(221, 221, 221); font-size: 15px; font-weight: bold;';
    return `    <div class="gap" style="display: flow-root; background-color: transparent;">

        <p style="color: rgb(221, 221, 221); padding-left: 0px; display: flow-root; font-style: italic; font-weight: bold; text-align: center; margin: 8px;">
        <span></span> <span style="color: ${nameColor};"></span><span></span> <span style=" background: black; color: white; display: inline-block; padding: 5px 15px; border-radius: 20px; font-size: 14px; font-weight: bold;text-align: center;">
            ${escapeHtml(m.name || '이름없음')} - 판정 </span><span style="${resultStyle}"> ${textToHtml(roll.full)}</span>
      </p>
    </div>
${HR}`;
  }

  // 정보(info) 탭 메시지 — 아바타 대신 "정보" 박스 + 본문만 출력
  function infoHtml(m) {
    return `    <div class="gap" style="display: flex; background-color: #464646;">
        <div class="msg_container"><div style="width: 40px; height: 40px; background: #4d4d4d; border-radius: 5px; display: flex; align-items: center; justify-content: center;">
                        <span style="color: #8d8d8d; font-size: 14px;"> 정보 </span>
                      </div></div>
        <p style="color: rgb(157, 157, 157);">
        <span></span> <span style="color: rgb(136, 136, 136);"></span><span> ${textToHtml(m.text || '')} </span>
      </p>
    </div>
${HR}`;
  }

  // 시스템 메시지 — 빈 아바타 자리 + "system" 이름 + 본문
  function systemHtml(m, opt) {
    const timeTag = (opt.time && m.createdAt) ? `<b> - ${escapeHtml(fmtTime(m.createdAt))}</b>` : '';
    return `    <div class="gap" style="display: flex; background-color: transparent;">
        <div class="msg_container"><img style="width: 40px; border-radius: 5px;"></div>
        <p style="color: rgb(221, 221, 221);">
        <span></span> <span style="color: rgb(136, 136, 136); font-weight: bold;">${escapeHtml(m.name || 'system')}</span>${timeTag}<span> <br> </span><span> ${textToHtml(m.text || '')} </span>
      </p>
    </div>
${HR}`;
  }

  function messageHtml(m, opt) {
    // 정보 탭은 전용 포맷으로 출력
    if (isInfo(m)) return infoHtml(m);
    // 시스템(스탯 변동) 메시지는 전용 포맷으로 출력
    if (isSystem(m)) return systemHtml(m, opt);

    const roll = rollInfo(m);
    // 판정 결과 키워드가 잡히면 판정 전용 포맷으로 출력
    if (roll && roll.outcome) return judgementHtml(m, roll);

    const nameColor = safeColor(m.color) || 'rgb(136, 136, 136)';

    const icon = m.iconUrl
      ? `<img src="${escapeHtml(m.iconUrl)}" alt="${escapeHtml(m.name || '')}" style="width: 40px; height: 40px; object-fit: cover; object-position: top center; border-radius: 5px;" referrerpolicy="no-referrer">`
      : '';

    // <b> 영역: 시간 표시
    const bParts = [];
    if (opt.time && m.createdAt) bParts.push(` - ${escapeHtml(fmtTime(m.createdAt))}`);
    const bTag = bParts.length ? `<b>${bParts.join('')}</b>` : '';

    // 판정 키워드가 없는 주사위(예: 데미지 굴림)는 명령+결과를 본문으로 표시
    const body = roll ? roll.full : (m.text || '');

    return `    <div class="gap" style="display: flex; background-color: transparent;">
        <div class="msg_container">${icon}</div>
        <p style="color: rgb(221, 221, 221);">
        <span></span> <span style="color: ${nameColor}; font-weight: bold;">${escapeHtml(m.name || '이름없음')}</span>${bTag}<span> <br> </span><span> ${textToHtml(body)} </span>
      </p>
    </div>
${HR}`;
  }

  function buildDocument(list) {
    const opt = {
      time: els.optTime.checked,
    };
    const items = list || ranged();
    const rows = items.map(m => messageHtml(m, opt)).join('\n');
    return `
    <html>
      <head>
      <meta charset="UTF-8">
        <style>
${OUTPUT_CSS}
        </style>
      </head>
      <body>
        <div class="ccfolia_wrap">

      <div style="text-align: center; margin-top: 30px;">

      </div>

${rows}

      <div style="text-align: center; margin-top: 30px;">

      </div>

        </div>
      </body>
    </html>`;
  }

  // 결과물에 인라인으로 박히는 CSS (자기완결 HTML)
  const OUTPUT_CSS = `

p{
  margin: 0;
}

b{
  color: gray;
    font-size: 9pt;
    font-weight: 200;
}

  span, b {
    font-size: 16px;
    font-family: 'Arial', sans-serif;
    line-height: 1.5;
  }

  b {
    font-weight: bold;
  }

.ccfolia_wrap {
  position: relative;
  padding: 10px !important;
  background-color: #2c2c2cde;
  color: #fefefe;
}
.msg_container {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.msg_container img {
width: 40px;
}

span:before {
  display: none !important ;
}


.gap{
gap: 15px;
display: flex;
-webkit-box-pack: start;
justify-content: flex-start;
align-items: flex-start;
position: relative;
text-decoration: none;
width: 100%;
box-sizing: border-box;
text-align: left;
padding: 16px 16px;
}
`;

  // ── 렌더 ─────────────────────────────────────────────────────
  function render() {
    const all = filtered();
    const start = rangeStart(all.length);
    const list = all.slice(start - 1);

    // 선택한 탭의 총 개수 / 실제 출력 건수를 안내
    els.totalCount.textContent = String(all.length);
    els.rangeInfo.textContent = !all.length
      ? ''
      : list.length
        ? `→ ${start}~${all.length}번째, ${list.length}건 출력`
        : '→ 출력할 로그가 없습니다 (범위 끝)';

    const html = buildDocument(list);
    els.preview.srcdoc = html;
    els.preview.dataset.html = html;
  }

  function download() {
    const html = els.preview.dataset.html || buildDocument();
    const all = filtered();
    const start = rangeStart(all.length);
    // 일부만 잘라 저장한 경우(시작 번호 > 1) 파일명에 범위를 표시
    const range = start > 1 ? `-${start}~${all.length}` : '';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ccfolia-log${roomId ? '-' + roomId : ''}${range}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copy() {
    const html = els.preview.dataset.html || buildDocument();
    try {
      await navigator.clipboard.writeText(html);
      els.copyBtn.textContent = '복사됨!';
      setTimeout(() => (els.copyBtn.textContent = 'HTML 복사'), 1500);
    } catch {
      alert('클립보드 복사에 실패했습니다. 다운로드를 이용하세요.');
    }
  }

  // ── 이벤트 ───────────────────────────────────────────────────
  // 폴백: collector 가 자동 전달에 실패해 JSON 파일로 떨어진 경우,
  // 페이지 아무 곳에나 그 파일을 끌어다 놓으면 불러온다.
  ['dragenter', 'dragover'].forEach(ev =>
    document.addEventListener(ev, (e) => { e.preventDefault(); }));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  [els.optTime].forEach(c => c.addEventListener('change', render));
  els.optStart.addEventListener('input', render);
  els.searchBtn.addEventListener('click', searchDialogue);
  els.searchText.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchDialogue(); });
  els.modeNum.addEventListener('click', () => setMode('num'));
  els.modeText.addEventListener('click', () => setMode('text'));
  els.downloadBtn.addEventListener('click', download);
  els.copyBtn.addEventListener('click', copy);

  // ── ccfolia 탭에서 직접 전달받기 (postMessage) ───────────────
  // collector(콘솔/북마클릿)가 ccfolia.com 탭에서 이 페이지를 열고 로그를 넘긴다.
  const CCFOLIA_ORIGIN = 'https://ccfolia.com';
  // 로컬 테스트 편의: localhost 에서 돌릴 땐 같은 origin 의 모의 ccfolia 페이지도 신뢰한다.
  // 배포본(github.io 등)에서는 DEV=false 라 오직 ccfolia.com 만 허용된다.
  const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const SENDER_ORIGIN = DEV ? location.origin : CCFOLIA_ORIGIN;
  let received = false;
  window.addEventListener('message', (e) => {
    if (e.origin !== SENDER_ORIGIN || !e.data) return;
    // 수집 진행 상황(건수)을 받아 표시 — 긴 로그도 멈춤 없이 진행됨을 보여준다.
    if (e.data.type === 'trpglog-progress' && !received) {
      els.loadInfo.hidden = false;
      els.loadInfo.textContent = `ccfolia 에서 로그 가져오는 중… ${e.data.count}건`;
      return;
    }
    if (received) return;
    if (e.data.type === 'trpglog-payload') {
      try { applyData(e.data.payload); received = true; }
      catch (err) { alert('받은 데이터를 읽지 못했습니다: ' + err.message); return; }
      const reply = e.source || window.opener;
      if (reply) reply.postMessage({ type: 'trpglog-ack' }, SENDER_ORIGIN);
    }
  });

  // collector 가 이 탭을 열었으면(opener 존재), 준비됐음을 보낸 탭에 알린다.
  // ready 가 한 번에 닿지 않을 수 있어 payload 수신 전까지 잠깐 반복한다.
  if (window.opener) {
    els.loadInfo.hidden = false;
    els.loadInfo.textContent = 'ccfolia 에서 로그를 가져오는 중…';
    let n = 0;
    const ping = () => {
      if (received || n++ > 12) return;
      try { window.opener.postMessage({ type: 'trpglog-ready' }, SENDER_ORIGIN); } catch (e) { /* ignore */ }
      setTimeout(ping, 400);
    };
    ping();
  }

  // ── 북마클릿 링크 구성 ───────────────────────────────────────
  // 같은 도메인의 collector.js 를 받아 javascript: URL 로 인라인한다.
  // (ccfolia 의 CSP 가 외부 스크립트 로드를 막아도 동작하도록 코드를 통째로 넣는다.)
  (async () => {
    if (!els.bookmarklet) return;
    try {
      const res = await fetch('collector.js');
      if (!res.ok) return;
      const code = await res.text();
      // IIFE 로 한 번 더 감싸고 void 로 완료값을 비워(브라우저가 결과로 이동하지 않게) 만든다.
      const wrapped = '(function(){' + code + '\n})();void 0;';
      els.bookmarklet.href = 'javascript:' + encodeURIComponent(wrapped);
    } catch (e) { /* 로컬 file:// 등에서는 무시 */ }
  })();
})();
