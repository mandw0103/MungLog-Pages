/* CCFOLIA 로그 JSON → HTML 변환 사이트 로직 */
(() => {
  'use strict';

  let messages = [];      // 로드된 전체 메시지
  let roomId = '';

  // ── 컷인(로그 사이 이미지) 상태 ──────────────────────────────
  let cutins = [];           // [{ id, afterId, src }] — afterId 메시지 _id(또는 TOP) 뒤에 삽입
  let insertMode = false;    // 컷인 삽입 모드(미리보기에 슬롯/삭제버튼 표시)
  let reorderMode = false;   // 순서 바꾸기 모드(미리보기에 드래그 핸들 표시)
  let orderDirty = false;    // 재정렬로 messages 순서가 바뀌어 미리보기 컷인 앵커 속성이 낡았는지
  let pendingAfterId = null; // 슬롯 클릭으로 고른 삽입 위치(파일 선택 대기)
  let cutinSeq = 0;          // 컷인 고유 id 카운터
  let preserveScroll = 0;    // 재렌더 시 유지할 미리보기 스크롤 위치
  let freshLoad = false;     // 새 로그를 받은 직후엔 스크롤을 맨 위로
  const TOP = '__top__';     // 맨 위(첫 메시지 앞) 앵커

  // ImgBB API 키. 사용자가 직접 입력해 브라우저(localStorage)에 저장한다.
  // 컷인 이미지는 이 키로 ImgBB 에 올려 '짧은 링크'로 넣어 HTML 을 가볍게 유지한다(렉 해소).
  // 키가 없으면 이미지를 넣을 수 없다. 발급: https://api.imgbb.com/ → Get API key
  const IMGBB_KEY_LS = 'trpglog-imgbb-key';    // 저장된 API 키
  const IMGBB_ASKED_LS = 'trpglog-imgbb-asked'; // 설정 모달을 한 번이라도 다뤘는지(자동 재노출 방지)
  const getImgbbKey = () => { try { return localStorage.getItem(IMGBB_KEY_LS) || ''; } catch (e) { return ''; } };
  const markImgbbAsked = () => { try { localStorage.setItem(IMGBB_ASKED_LS, '1'); } catch (e) {} };
  const imgbbAsked = () => { try { return localStorage.getItem(IMGBB_ASKED_LS) === '1'; } catch (e) { return false; } };
  function setImgbbKey(v) {
    try { localStorage.setItem(IMGBB_KEY_LS, v); } catch (e) {}
    markImgbbAsked();
  }
  function clearImgbbKey() {
    try { localStorage.removeItem(IMGBB_KEY_LS); } catch (e) {}
    markImgbbAsked();
  }

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
    modeToggle: $('#modeToggle'),
    rangeNum: $('#rangeNum'),
    rangeText: $('#rangeText'),
    channelList: $('#channelList'),
    preview: $('#preview'),
    copyBtn: $('#copyBtn'),
    downloadBtn: $('#downloadBtn'),
    bookmarklet: $('#bookmarklet'),
    cutinBtn: $('#cutinBtn'),
    cutinToggle: $('#cutinToggle'),
    cutinFile: $('#cutinFile'),
    reorderToggle: $('#reorderToggle'),
    imgbbSettingsBtn: $('#imgbbSettingsBtn'),
    imgbbModal: $('#imgbbModal'),
    imgbbKeyInput: $('#imgbbKeyInput'),
    imgbbState: $('#imgbbState'),
    imgbbSaveBtn: $('#imgbbSaveBtn'),
    imgbbClearBtn: $('#imgbbClearBtn'),
    imgbbCloseBtn: $('#imgbbCloseBtn'),
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
    // 컷인 앵커로 쓸 안정적인 _id 보장(수집기 JSON 엔 항상 있으나, 없으면 순번으로 채움)
    messages.forEach((m, i) => { if (m._id == null) m._id = 'm' + i; });
    // 새 로그를 받으면 이전 컷인·삽입/순서 모드는 초기화한다(예전 메시지를 가리키므로).
    cutins = [];
    insertMode = false;
    reorderMode = false;
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
    els.loadInfo.textContent = `→ ${messages.length}건 로드${roomId ? ` (방: ${roomId})` : ''}`;
    // 새 로그를 받으면 출력 범위·검색 상태를 처음으로 되돌린다.
    els.optStart.value = '1';
    els.searchText.value = '';
    setSearchInfo('', '');
    syncCutinUI();
    syncReorderUI();
    buildChannelFilter();
    els.optionsPanel.hidden = false;
    els.outputPanel.hidden = false;
    updateModeIndicator();   // 패널이 보이게 된 뒤 밑줄 위치를 잡는다
    freshLoad = true;   // 새 로그는 맨 위부터 보여준다(스크롤 복원 건너뜀)
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

  // 메인 채널 여부 (필터 기본 선택 기준)
  function isMainChannel(key) { return key === 'main' || key === 'メイン'; }

  // 필터 표시 순서: 메인 → 정보 → 잡담 → 비밀 → 그 외(등장 순)
  function channelRank(key) {
    if (isMainChannel(key)) return 0;
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
    // 시작 시엔 메인 탭만 선택된 상태로 둔다(나머지는 사용자가 직접 체크).
    for (const [key, label] of ordered) {
      const id = 'ch_' + btoa(unescape(encodeURIComponent(key))).replace(/[^a-z0-9]/gi, '');
      const wrap = document.createElement('label');
      wrap.className = 'opt';
      const checked = isMainChannel(key) ? ' checked' : '';
      wrap.innerHTML = `<input type="checkbox" class="chk-channel" value="${escapeHtml(key)}" id="${id}"${checked}><span class="opt-label">${escapeHtml(label)}</span>`;
      els.channelList.appendChild(wrap);
    }
    els.channelList.querySelectorAll('.chk-channel').forEach(c => c.addEventListener('change', render));
  }

  function enabledChannels() {
    return new Set([...els.channelList.querySelectorAll('.chk-channel:checked')].map(c => c.value));
  }

  // ── 필터 적용 ────────────────────────────────────────────────
  // 본문(대사)이 비어 출력할 게 없는 로그(예: 편집으로 내용이 지워진 메시지)는
  // 출력에서 통째로 제외한다. 주사위/판정은 굴림 결과가 곧 내용이므로 비어도 남긴다.
  function isEmptyLog(m) {
    if (rollInfo(m)) return false;
    return String(m.text ?? '').trim() === '';
  }

  function filtered() {
    const chans = enabledChannels();
    return messages.filter(m => chans.has(channelKey(m)) && !isEmptyLog(m));
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
      setSearchInfo('일치하는 대사가 없습니다.', '');   // hint 와 같은 색(muted)으로 안내
      return;
    }
    const idx = matches[0];                 // 첫 번째 일치 대사
    els.optStart.value = String(idx + 2);   // 그 대사 '다음'부터(1-based)
    setSearchInfo('', '');                  // 일치하면 별도 안내 없이 바로 반영
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
    updateModeIndicator();
  }

  // 밑줄(::after)의 너비·위치를 활성 탭에 맞춰 CSS 변수로 넘긴다(슬라이드는 CSS 가 처리).
  // 옵션 패널이 숨겨져 있으면 측정이 0 이므로, 보일 때(onLoaded) 다시 호출한다.
  function updateModeIndicator() {
    const active = els.modeText.classList.contains('active') ? els.modeText : els.modeNum;
    if (!active.offsetParent && !active.offsetWidth) return;   // 아직 안 보임 → 건너뜀
    els.modeToggle.style.setProperty('--ind-w', active.offsetWidth + 'px');
    els.modeToggle.style.setProperty('--ind-x', active.offsetLeft + 'px');
  }

  // ── HTML 생성 (ccfolia 스킨 포맷) ────────────────────────────
  const textToHtml = (s) => escapeHtml(s).replace(/\n/g, '<br>');

  const HR = `    <hr style="margin: 0 16px; padding: 0; border: 0; flex-shrink: 0; border-top: 1px solid rgba(255, 255, 255, 0.08);">`;

  // 판정 결과 키워드별 스타일.
  // 성공 = 초록 계열(등급 높을수록 더 밝고 선명), 실패 = 빨강 계열.
  // 대성공·대실패는 글로우(text-shadow)로 크리티컬/펌블을 강조한다.
  const RESULT_STYLES = {
    '대성공': 'color: #56FC9A; font-size: 15px; font-weight: bold; text-shadow: rgba(86, 252, 154, 0.8) 0px 0px 5px;',
    '대단한 성공': 'color: #00FE02; font-size: 15px; font-weight: bold;',
    '어려운 성공': 'color: #00DC00; font-size: 15px; font-weight: bold;',
    '보통 성공': 'color: #009A00; font-size: 15px; font-weight: bold;',
    '실패': 'color: #CE0004; font-size: 15px; font-weight: bold;',
    '대실패': 'color: rgb(255, 45, 45); font-size: 15px; font-weight: bold; text-shadow: rgba(255, 45, 45, 0.85) 0px 0px 6px;',
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

  // 판정(주사위) 메시지 — 다른 로그와 통일된 좌측 정렬 레이아웃.
  // 아바타 자리엔 "판정" 박스(정보 탭과 동일 형태), 이름은 메인 대사처럼 표기,
  // 본문(명령+굴림결과)은 결과 키워드별 색상으로 강조한다.
  function judgementHtml(m, roll, opt) {
    const nameColor = safeColor(m.color) || 'rgb(136, 136, 136)';
    const resultStyle = RESULT_STYLES[roll.outcome] || 'color: rgb(221, 221, 221); font-size: 15px; font-weight: bold;';
    const timeTag = (opt && opt.time && m.createdAt) ? `<b> - ${escapeHtml(fmtTime(m.createdAt))}</b>` : '';
    return `    <div class="gap" style="display: flex; background-color: transparent;">
        <div class="msg_container"><div style="width: 40px; height: 40px; background: #4d4d4d; border-radius: 0; display: flex; align-items: center; justify-content: center;">
                        <span style="color: #8d8d8d; font-size: 14px;"> 판정 </span>
                      </div></div>
        <p style="color: rgb(221, 221, 221);">
        <span></span> <span style="color: ${nameColor}; font-weight: bold;">${escapeHtml(m.name || '이름없음')}</span>${timeTag}<span> <br> </span><span style="${resultStyle}"> ${textToHtml(roll.full)} </span>
      </p>
    </div>
${HR}`;
  }

  // 정보(info) 탭 메시지 — 아바타 대신 "정보" 박스 + 본문만 출력
  function infoHtml(m) {
    return `    <div class="gap" style="display: flex; align-items: center; background-color: #464646;">
        <div class="msg_container"><div style="width: 40px; height: 40px; background: #4d4d4d; border-radius: 0; display: flex; align-items: center; justify-content: center;">
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
        <div class="msg_container"><img style="width: 40px; border-radius: 0;"></div>
        <p style="color: rgb(221, 221, 221);">
        <span></span> <span style="color: rgb(136, 136, 136); font-weight: bold;">${escapeHtml(m.name || 'system')}</span>${timeTag}<span> <br> </span><span style="font-weight: bold;"> ${textToHtml(m.text || '')} </span>
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
    if (roll && roll.outcome) return judgementHtml(m, roll, opt);

    // 메인 탭 메시지
    const nameColor = safeColor(m.color) || 'rgb(136, 136, 136)';

    const icon = m.iconUrl
      ? `<img src="${escapeHtml(m.iconUrl)}" alt="${escapeHtml(m.name || '')}" style="width: 40px; height: 40px; object-fit: cover; object-position: top center; border-radius: 0;" referrerpolicy="no-referrer">`
      : '';

    // <b> 영역: 시간 표시
    const bParts = [];
    if (opt.time && m.createdAt) bParts.push(` - ${escapeHtml(fmtTime(m.createdAt))}`);
    const bTag = bParts.length ? `<b>${bParts.join('')}</b>` : '';

    // 판정 키워드가 없는 주사위(예: 데미지 굴림)는 명령+결과를 본문으로 표시.
    // 주사위 본문은 판정처럼 볼드 처리하고, 일반 대사는 기본 굵기로 둔다.
    const body = roll ? roll.full : (m.text || '');
    const bodyStyle = roll ? ' style="font-weight: bold;"' : '';

    return `    <div class="gap" style="display: flex; background-color: transparent;">
        <div class="msg_container">${icon}</div>
        <p style="color: rgb(221, 221, 221);">
        <span></span> <span style="color: ${nameColor}; font-weight: bold;">${escapeHtml(m.name || '이름없음')}</span>${bTag}<span> <br> </span><span${bodyStyle}> ${textToHtml(body)} </span>
      </p>
    </div>
${HR}`;
  }

  // ── 컷인(로그 사이 이미지) HTML ──────────────────────────────
  // 일반 로그(.gap)와 같은 좌우 패딩·아래 구분선(HR)을 써서 여백을 로그와 맞춘다.
  // 이미지는 가운데 정렬하고, 가로가 넘치면 100%로 축소해 영역 안에 들어오게 한다.
  function cutinHtml(c, opt) {
    // 삭제 버튼·드래그 핸들·식별자는 미리보기에서만 — 다운로드 HTML 엔 들어가지 않는다.
    const del = opt.preview
      ? `<button type="button" class="cutin-del" data-id="${c.id}" title="컷인 삭제">🗑</button>`
      : '';
    const handle = opt.preview ? REORDER_HANDLE : '';   // 순서 바꾸기 모드에서 컷인도 독립적으로 이동
    const cid = opt.preview ? ` data-cutin-id="${c.id}"` : '';
    // 업로드 중이면 자리 표시 박스, 완료되면 이미지(외부 링크일 수 있어 referrer 미전송).
    const inner = c.uploading
      ? `<div style="padding: 24px; color: rgb(200, 160, 175); font-size: 14px;">이미지 업로드 중…</div>`
      : `<img src="${c.src}" alt="컷인" style="max-width: 100%; border-radius: 5px; display: block;" referrerpolicy="no-referrer">`;
    return `    <div class="gap cutin"${cid} style="display: flex; justify-content: center; background-color: transparent; position: relative;">
        ${del}${inner}${handle}
    </div>
${HR}`;
  }

  // afterId 앵커에 달린 컷인들(삽입 순서 유지).
  // 다운로드(clean)에는 아직 업로드 중인 자리 표시는 포함하지 않는다.
  function cutinsFor(anchor, opt) {
    return cutins.filter(c => c.afterId === anchor && (opt.preview || !c.uploading));
  }

  // 메시지 행 + 컷인을 한 줄씩 엮는다.
  // 삽입 모드(preview)에선 슬롯을 일일이 그리지 않고, 각 행에 위/아래 삽입 앵커만
  // 심어 둔다. 실제 파란 띠는 마우스에 가까운 경계 한 곳에만 JS 로 띄운다(가벼움).
  // 순서 바꾸기 모드에서 각 메시지 행 우측에 붙는 드래그 핸들(≡). 미리보기에서만 넣고,
  // reorder-mode 일 때만 보인다. .gap(position:relative) 기준으로 CSS 가 우측에 절대배치한다.
  const REORDER_HANDLE = '<span class="reorder-handle" aria-hidden="true">&#9776;</span>';

  function buildRows(items, opt) {
    const rows = [];
    cutinsFor(TOP, opt).forEach(c => rows.push(cutinHtml(c, opt)));
    let prevMid = TOP;                       // 직전 메시지 _id(맨 위는 TOP)
    for (const m of items) {
      let row = messageHtml(m, opt);
      if (opt.preview) {
        // 행 위쪽 경계 = 직전 메시지 뒤(=이 메시지 앞), 아래쪽 경계 = 이 메시지 뒤
        const attrs = ` data-mid="${escapeHtml(m._id)}"`
          + ` data-top-after="${escapeHtml(prevMid)}" data-bottom-after="${escapeHtml(m._id)}"`;
        row = row.replace('<div class="gap"', '<div class="gap"' + attrs);
        // 드래그 핸들을 .gap 닫는 태그 직전(</p> 뒤)에 넣는다. 모든 메시지 타입이 동일 종료 형태.
        row = row.replace('</p>\n    </div>', '</p>' + REORDER_HANDLE + '\n    </div>');
      }
      rows.push(row);
      cutinsFor(m._id, opt).forEach(c => rows.push(cutinHtml(c, opt)));
      prevMid = m._id;
    }
    return rows.join('\n');
  }

  function buildDocument(list, view) {
    const opt = {
      time: els.optTime.checked,
      preview: !!(view && view.preview),
    };
    const items = list || ranged();
    const rows = buildRows(items, opt);
    const extraCss = opt.preview ? PREVIEW_CSS : '';
    // 마우스에 가까운 경계에 띄울 삽입 슬롯(미리보기 전용, JS 가 위치를 옮긴다)
    const bandEl = opt.preview ? '<div id="cutin-band">+ 여기에 컷인 삽입</div>' : '';
    // 순서 바꾸기 드래그 중 삽입 위치를 보여주는 가로선(미리보기 전용, JS 가 위치를 옮긴다)
    const lineEl = opt.preview ? '<div id="reorder-line"></div>' : '';
    // 미리보기는 사이트 테마(어두운/밝은)에 맞춰 배경·스크롤바를 통일한다.
    // 다운로드 HTML(preview=false)에는 넣지 않아 ccfolia 스킨 원본을 유지한다.
    const themeChrome = opt.preview
      ? `\n:root { color-scheme: ${(view && view.theme) === 'light' ? 'light' : 'dark'}; }\nhtml, body { background: ${(view && view.bg) || '#2c2c2c'}; }`
      : '';
    return `
    <html>
      <head>
      <meta charset="UTF-8">
        <style>
${OUTPUT_CSS}${extraCss}${themeChrome}
        </style>
      </head>
      <body>
${bandEl}${lineEl}
        <div class="ccfolia_wrap">

${rows}

        </div>
      </body>
    </html>`;
  }

  // 결과물에 인라인으로 박히는 CSS (자기완결 HTML)
  const OUTPUT_CSS = `

p{
  margin: 0;
}

  span {
    font-size: 14px;
    font-family: "Roboto", "Helvetica", "Arial", sans-serif;
    line-height: 1.5;
  }

  /* 시간(caption): 이름 옆 회색 소형 텍스트 */
  b {
    color: #757575;
    font-size: 12px;
    font-weight: 400;
    font-family: "Roboto", "Helvetica", "Arial", sans-serif;
  }

.ccfolia_wrap {
  position: relative;
  padding: 10px !important;
  background-color: #474747;   /* 불투명 — 테마별 backdrop 이 비쳐 색이 달라지지 않게 */
  color: #fefefe;
}
.msg_container {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 0;
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
gap: 16px;
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

  // 미리보기(삽입 모드)에서만 끼워 넣는 CSS — 삽입 슬롯·컷인 윤곽·삭제 버튼.
  // 다운로드 HTML 에는 포함되지 않는다.
  // 삽입 보조 UI 는 항상 DOM 에 있지만, body.insert-mode 일 때만 보이게 한다.
  // (삽입 모드 토글을 reload 없이 클래스만으로 처리해 깜빡임을 없애기 위함)
  const PREVIEW_CSS = `
body.insert-mode .ccfolia_wrap{ cursor: pointer; }
/* 마우스에 가까운 로그 경계 한 곳에만 뜨는 삽입 슬롯(점선 네모 + 안내문) */
#cutin-band{
  position: absolute;
  left: 16px;
  right: 16px;
  transform: translateY(-50%);
  display: none;
  z-index: 5;
  pointer-events: none;
  box-sizing: border-box;
  text-align: center;
  color: rgb(255, 205, 222);
  font-size: 13px;
  padding: 6px;
  border: 1px dashed rgb(232, 92, 140);
  border-radius: 6px;
  background: rgba(220, 0, 78, 0.18);
}
body.insert-mode .cutin{ outline: 1px dashed rgba(220, 0, 78, 0.45); outline-offset: -4px; }
.cutin-del{
  display: none;
  position: absolute;
  top: 8px;
  right: 24px;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 14px;
  z-index: 2;
}
body.insert-mode .cutin-del{ display: block; }
.cutin-del:hover{ background: rgba(180, 50, 50, 0.85); }

/* 순서 바꾸기 — 각 로그 우측 드래그 핸들(≡). reorder-mode 일 때만 보인다. */
.reorder-handle{
  display: none;
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  color: #bbb;
  font-size: 18px;
  line-height: 1;
  padding: 6px 8px;
  z-index: 3;
}
body.reorder-mode .reorder-handle{ display: block; }
.reorder-handle:hover{ color: #fff; }
.reorder-handle:active{ cursor: grabbing; }
/* 드래그 중인 원본 행은 흐리게 */
.gap.reorder-dragging{ opacity: 0.4; }
/* 드롭 위치(삽입 경계)를 보여주는 가로선 */
#reorder-line{
  position: absolute;
  left: 16px;
  right: 16px;
  height: 2px;
  background: rgb(232, 92, 140);
  display: none;
  z-index: 6;
  pointer-events: none;
}
`;

  // ── 렌더 ─────────────────────────────────────────────────────
  function render() {
    orderDirty = false;   // 전체 재렌더는 항상 최신 순서·앵커로 그린다
    const all = filtered();
    const start = rangeStart(all.length);
    const list = all.slice(start - 1);

    // 선택한 탭의 총 개수 / 실제 출력 건수를 안내
    els.totalCount.textContent = String(all.length);
    els.rangeInfo.textContent = !all.length
      ? ''
      : list.length
        ? `→ ${list.length}건 출력 (${start}~${all.length}번째)`
        : '→ 출력할 로그가 없습니다 (범위 끝)';

    // srcdoc 을 새로 쓰면 iframe 이 reload 되어 스크롤이 맨 위로 튄다.
    // 현재 위치를 저장해 두고 load 후 복원한다(새 로그 직후엔 맨 위로).
    const win = els.preview.contentWindow;
    preserveScroll = freshLoad ? 0 : (win ? (win.scrollY || 0) : 0);
    freshLoad = false;

    // 다운로드·복사에 쓸 깨끗한 HTML(컷인 포함, 삽입 보조 UI 제외)
    els.preview.dataset.html = buildDocument(list, { preview: false });
    // 미리보기는 삽입 보조 UI(띠·삭제버튼·앵커)를 항상 포함해 그린다.
    // 삽입 모드 on/off 는 body.insert-mode 클래스로만 토글하므로 reload(깜빡임)가 없다.
    // 현재 사이트 테마와 배경(--panel)을 넘겨 미리보기 배경·스크롤바를 통일한다.
    const rootStyle = getComputedStyle(document.documentElement);
    els.preview.srcdoc = buildDocument(list, {
      preview: true,
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      bg: rootStyle.getPropertyValue('--panel').trim() || '#2c2c2c',
    });
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

  // 복사 성공 피드백용 체크(✓) 아이콘. 원본 복사 아이콘은 최초 1회만 저장해 복원한다
  // (연타로 체크 상태일 때 innerHTML 을 캡처해 아이콘이 사라지는 것을 방지).
  const CHECK_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  let copyIconHTML = null;
  let copyResetT = 0;

  async function copy() {
    const html = els.preview.dataset.html || buildDocument();
    try {
      await navigator.clipboard.writeText(html);
      // 아이콘 버튼이라 textContent 대신 아이콘을 잠깐 체크로 바꿔 피드백을 준다.
      if (copyIconHTML == null) copyIconHTML = els.copyBtn.innerHTML;
      clearTimeout(copyResetT);
      els.copyBtn.innerHTML = CHECK_SVG;
      els.copyBtn.title = '복사됨!';
      copyResetT = setTimeout(() => {
        els.copyBtn.innerHTML = copyIconHTML;
        els.copyBtn.title = 'HTML 복사';
      }, 1500);
    } catch {
      alert('클립보드 복사에 실패했습니다. 다운로드를 이용하세요.');
    }
  }

  // ── 컷인 삽입/삭제 ───────────────────────────────────────────
  // 버튼 라벨·활성 표시를 현재 모드에 맞춘다.
  function syncCutinUI() {
    // 활성 여부는 버튼 색(.active)으로만 표시하고, 라벨은 바꾸지 않는다.
    els.cutinBtn.classList.toggle('active', insertMode);
  }

  function toggleInsertMode() {
    insertMode = !insertMode;
    pendingAfterId = null;
    // 순서 바꾸기와 상호 배타 — 컷인 삽입을 켜면 순서 모드를 끈다.
    if (insertMode && reorderMode) reorderMode = false;
    syncCutinUI();
    syncReorderUI();
    // 순서가 바뀐 뒤 컷인 삽입을 켜면, 낡은 컷인 앵커 속성을 새로 그려 갱신한다(한 번의 리로드).
    // 그 외엔 reload 없이 body 클래스만 토글 → 스크롤 유지, 깜빡임 없음.
    if (insertMode && orderDirty) render();
    else applyPreviewModeClasses();
    // 삽입 모드를 처음 켰는데 저장된 ImgBB 키가 없으면, 한 번 설정 모달로 미리 안내한다.
    // (키는 실제로 이미지를 넣을 때 경계 클릭 시점에서도 다시 확인한다.)
    if (insertMode && !getImgbbKey() && !imgbbAsked()) openImgbbModal();
  }

  // ── 순서 바꾸기(드래그 재정렬) 모드 ─────────────────────────
  // 버튼 라벨·활성 표시를 현재 모드에 맞춘다.
  function syncReorderUI() {
    // 활성 여부는 버튼 색(.active)으로만 표시하고, 라벨은 바꾸지 않는다.
    els.reorderToggle.classList.toggle('active', reorderMode);
  }

  function toggleReorderMode() {
    reorderMode = !reorderMode;
    // 컷인 삽입과 상호 배타 — 순서 모드를 켜면 컷인 삽입을 끈다.
    if (reorderMode && insertMode) { insertMode = false; pendingAfterId = null; }
    syncCutinUI();
    syncReorderUI();
    applyPreviewModeClasses();
  }

  // 두 모드(insert-mode·reorder-mode)의 body 클래스와, 꺼진 모드의 떠 있던 보조 UI(띠·표시선)를
  // reload 없이 한 번에 반영한다. 토글 어느 쪽에서 호출해도 결과가 일관되게 유지된다.
  function applyPreviewModeClasses() {
    const doc = els.preview.contentDocument;
    if (!doc || !doc.body) return;
    doc.body.classList.toggle('insert-mode', insertMode);
    doc.body.classList.toggle('reorder-mode', reorderMode);
    if (!insertMode) {
      const band = doc.getElementById('cutin-band');
      if (band) band.style.display = 'none';   // 끄면 떠 있던 띠를 즉시 감춘다
    }
    if (!reorderMode) {
      const line = doc.getElementById('reorder-line');
      if (line) line.style.display = 'none';   // 끄면 떠 있던 삽입 표시선을 즉시 감춘다
    }
  }

  // ── ImgBB API 키 설정 모달 ───────────────────────────────────
  // 저장 상태에 맞춰 다이얼로그 내용을 갱신한다(저장된 키는 마스킹해 보여주고 삭제 버튼 노출).
  function syncImgbbModal() {
    const key = getImgbbKey();
    els.imgbbKeyInput.value = key;
    els.imgbbClearBtn.hidden = !key;
    els.imgbbState.textContent = key
      ? `현재 저장된 키: ${maskKey(key)}`
      : '저장된 키가 없습니다.';
  }

  // 키 노출을 줄이려 앞 4·뒤 4 자만 보여준다(짧으면 그대로).
  function maskKey(k) {
    return k.length <= 10 ? k : k.slice(0, 4) + '…' + k.slice(-4);
  }

  function openImgbbModal() {
    syncImgbbModal();
    els.imgbbModal.hidden = false;
    els.imgbbKeyInput.focus();
  }

  function closeImgbbModal() {
    els.imgbbModal.hidden = true;
    markImgbbAsked();   // 닫는 순간(× · 배경 클릭 포함)에도 '다뤘음'으로 표시해 자동 재노출을 막는다
  }

  function saveImgbbKey() {
    const v = els.imgbbKeyInput.value.trim();
    if (v) setImgbbKey(v); else clearImgbbKey();
    closeImgbbModal();
  }

  // 이미지를 ImgBB 에 올려 링크를 받는다(브라우저 직접 업로드).
  async function uploadToImgbb(file, key) {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key), {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error('ImgBB 업로드 실패 (' + res.status + ')');
    const j = await res.json();
    const url = j && j.data && (j.data.url || j.data.display_url);
    if (!url) throw new Error('ImgBB 응답에 링크가 없습니다.');
    return url;   // 짧은 https 링크(i.ibb.co/...)
  }

  // 컷인 src 결정: ImgBB 에 올려 '짧은 링크'를 받는다. 키가 없거나 업로드에 실패하면
  // 예외를 던져(addCutin 이 자리 표시를 지우고 안내) 이미지가 들어가지 않게 한다.
  async function resolveCutinSrc(file) {
    const key = getImgbbKey();
    if (!key) throw new Error('ImgBB API 키가 설정되지 않았습니다.');
    return uploadToImgbb(file, key);
  }

  function addCutin(file) {
    if (pendingAfterId == null) return;
    const afterId = pendingAfterId;
    pendingAfterId = null;
    // 업로드는 시간이 걸리므로 자리 표시용 컷인을 먼저 넣어 진행 상태를 보여준다.
    const id = ++cutinSeq;
    cutins.push({ id, afterId, src: '', uploading: true });
    render();
    resolveCutinSrc(file)
      .then(src => {
        const c = cutins.find(x => x.id === id);
        if (c) { c.src = src; c.uploading = false; }
        render();
      })
      .catch(err => {
        cutins = cutins.filter(x => x.id !== id);   // 실패한 자리 표시는 제거
        render();
        alert('이미지를 넣지 못했습니다: ' + err.message);
      });
  }

  function removeCutin(id) {
    cutins = cutins.filter(c => String(c.id) !== String(id));
    render();
  }

  // ── 순서 바꾸기: 모델(messages) 이동 ─────────────────────────
  // draggedId 메시지를 afterId(메시지 _id 또는 TOP) '바로 뒤'로 옮긴다.
  // 실제로 순서가 바뀔 때만 true(무변화면 false → 호출부가 DOM·다운로드 갱신을 건너뜀).
  function moveMessage(draggedId, afterId) {
    if (afterId === draggedId) return false;             // 자기 뒤로는 옮길 수 없음
    const from = messages.findIndex(m => m._id === draggedId);
    if (from < 0) return false;
    if (afterId === TOP) {
      if (from === 0) return false;                      // 이미 맨 앞
    } else {
      const ai = messages.findIndex(m => m._id === afterId);
      if (ai < 0) return false;
      if (ai === from - 1) return false;                 // 이미 afterId 바로 뒤 → 무변화
    }
    const [item] = messages.splice(from, 1);
    let to = 0;
    if (afterId !== TOP) to = messages.findIndex(m => m._id === afterId) + 1;  // 제거 후 재계산
    messages.splice(to, 0, item);
    return true;
  }

  // ── 순서 바꾸기: DOM 순회 헬퍼 ──────────────────────────────
  // '메시지 블록' = 그 메시지 행(.gap[data-mid]) + 뒤따르는 hr·컷인(다음 메시지 행 직전까지).
  // 메시지를 옮길 때의 '드롭 목표 끝'을 잡는 데 쓴다(그 블록 뒤에 삽입).
  function collectBlock(row) {
    const block = [row];
    let n = row.nextSibling;
    while (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('gap') && n.hasAttribute('data-mid')) break;
      block.push(n);
      n = n.nextSibling;
    }
    return block;
  }

  // '단일 행 블록' = 그 행(.gap) + 뒤따르는 hr·공백(다음 .gap 직전까지).
  // 메시지든 컷인이든 '자기 한 줄'만 잘라 옮길 때 쓴다(메시지는 딸린 컷인을 데려가지 않음).
  function collectBlockAny(row) {
    const block = [row];
    let n = row.nextSibling;
    while (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('gap')) break;
      block.push(n);
      n = n.nextSibling;
    }
    return block;
  }

  function prevMessageRow(row) {
    let n = row.previousElementSibling;
    while (n) {
      if (n.classList && n.classList.contains('gap') && n.hasAttribute('data-mid')) return n;
      n = n.previousElementSibling;
    }
    return null;
  }

  // 이 노드보다 위에 있는 가장 가까운 메시지 행. 없으면 null(=맨 위, TOP 구역).
  function anchorMessageRow(node) {
    let n = node.previousElementSibling;
    while (n) {
      if (n.classList && n.classList.contains('gap') && n.hasAttribute('data-mid')) return n;
      n = n.previousElementSibling;
    }
    return null;
  }
  // 위 앵커 메시지의 _id(없으면 TOP) — 컷인이 현재 DOM 위치에서 어느 메시지에 속하는지.
  function anchorMessageId(node) {
    const r = anchorMessageRow(node);
    return r ? r.getAttribute('data-mid') : TOP;
  }

  // 같은 afterId 그룹의 컷인 배열 순서를 DOM 순서(idOrder)에 맞춰 재배치한다.
  // 그룹 밖 항목(숨은 컷인 포함)은 건드리지 않아, 필터로 안 보이는 컷인이 유실되지 않는다.
  function reorderCutinGroup(afterId, idOrder) {
    const rank = new Map(idOrder.map((id, i) => [String(id), i]));
    const group = cutins.filter(c => c.afterId === afterId)
      .sort((a, b) => (rank.has(String(a.id)) ? rank.get(String(a.id)) : 0)
                    - (rank.has(String(b.id)) ? rank.get(String(b.id)) : 0));
    let gi = 0;
    for (let i = 0; i < cutins.length; i++) {
      if (cutins[i].afterId === afterId) cutins[i] = group[gi++];
    }
  }

  // 미리보기 reload 직후: 스크롤 복원 + 현재 모드 클래스 반영 + 핸들러 연결.
  function onPreviewLoad() {
    const win = els.preview.contentWindow;
    if (win) win.scrollTo(0, preserveScroll);
    applyPreviewModeClasses();   // 두 모드(insert/reorder) 클래스를 새 문서에 다시 입힌다
    wirePreview();
  }

  // 삽입 보조 UI 는 항상 DOM 에 있으므로 핸들러도 항상 연결하되, 동작은 insertMode 로 막는다.
  function wirePreview() {
    const doc = els.preview.contentDocument;
    const win = els.preview.contentWindow;
    if (!doc || !win) return;
    const band = doc.getElementById('cutin-band');

    // 삭제 버튼은 자기 클릭만 처리하고 삽입으로 번지지 않게 막는다.
    doc.querySelectorAll('.cutin-del').forEach(el =>
      el.addEventListener('click', (ev) => { ev.stopPropagation(); removeCutin(el.dataset.id); }));

    let curAfter = null;   // 현재 띠가 가리키는 삽입 위치(afterId)
    let raf = 0;
    const hide = () => { if (band) band.style.display = 'none'; curAfter = null; };

    doc.addEventListener('mousemove', (e) => {
      if (raf) return;                          // rAF 로 1프레임당 한 번만 계산
      raf = win.requestAnimationFrame(() => {
        raf = 0;
        if (!band || !insertMode) { hide(); return; }   // 삽입 모드 아닐 땐 띠를 띄우지 않음
        const node = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
        const row = node && node.closest ? node.closest('.gap[data-mid]') : null;
        if (!row) { hide(); return; }
        const rect = row.getBoundingClientRect();
        const topHalf = e.clientY < rect.top + rect.height / 2;   // 위/아래 절반으로 경계 결정
        curAfter = topHalf ? row.dataset.topAfter : row.dataset.bottomAfter;
        const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
        band.style.top = (topHalf ? rect.top : rect.bottom) + scrollTop + 'px';
        band.style.display = 'block';
      });
    });
    doc.addEventListener('mouseleave', hide);

    // 경계 근처를 클릭하면 그 위치에 컷인을 넣는다(삭제 버튼 클릭은 위에서 가로챔).
    doc.addEventListener('click', (e) => {
      if (!insertMode) return;
      const node = e.target && e.target.nodeType === 1 ? e.target : null;
      if (node && node.closest && node.closest('.cutin-del')) return;
      if (curAfter == null) return;
      // 컷인은 ImgBB 업로드로만 넣는다. 키가 없으면 넣지 못하므로 경고 후 설정 모달로 안내한다.
      if (!getImgbbKey()) {
        alert('ImgBB API 키가 없어 이미지를 넣을 수 없습니다.\n먼저 ImgBB 키를 설정해 주세요.');
        openImgbbModal();
        return;
      }
      pendingAfterId = curAfter;
      els.cutinFile.value = '';                 // 같은 파일 다시 선택해도 change 가 뜨도록
      els.cutinFile.click();
    });

    // ── 순서 바꾸기(드래그 재정렬) ──────────────────────────────
    // 커스텀 포인터 드래그: 핸들을 잡으면 드롭 위치 표시선을 띄우고, 화면 가장자리에서
    // 자동 스크롤한다. 메시지와 컷인(이미지) 모두 독립적으로 옮길 수 있다.
    //  · 메시지: 자기 한 줄만 옮기고(딸린 컷인은 제자리에 남음), 메시지 블록 경계에만 스냅.
    //  · 컷인:  아무 로그 사이로든 옮기며, 새 위치의 위 메시지에 다시 앵커된다.
    // 드롭 때 모델과 DOM 을 함께 갱신한다(리로드 없음).
    const line = doc.getElementById('reorder-line');
    const wrap = doc.querySelector('.ccfolia_wrap');
    let dragRow = null;                 // 드래그 중인 행(.gap)
    let dragKind = null;                // 'msg' | 'cutin'
    let dragMsgId = null, dragCutinId = null;
    let dragBlock = null, dragBlockSet = null;   // 실제로 옮길 노드들(자기 한 줄)
    let dropRef = null;                 // 이 노드 앞에 삽입(null=맨 끝)
    let dropValid = false;
    let lastX = 0, lastY = 0;
    let moveRaf = 0;
    let autoRaf = 0, autoDir = 0, autoStep = 0;

    const EDGE = 48, MAX_STEP = 26;

    function stopAutoScroll() {
      if (autoRaf) { win.cancelAnimationFrame(autoRaf); autoRaf = 0; }
      autoDir = 0;
    }

    function invalidate() { dropValid = false; dropRef = null; if (line) line.style.display = 'none'; }
    function showLine(lineY) {
      dropValid = true;
      const scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
      line.style.top = (lineY + scrollTop) + 'px';
      line.style.display = 'block';
    }
    // dropRef 가 드래그 블록 내부면 무효(자기 안으로는 못 넣음). null(맨 끝)은 유효.
    function refInsideBlock() { return dropRef != null && dragBlockSet.has(dropRef); }

    // lastX/lastY(뷰포트 좌표) 아래 행을 찾아 드롭 위치(dropRef)·표시선을 갱신한다.
    function updateDrop() {
      if (!dragRow || !line || !wrap) return;
      const el = doc.elementFromPoint(lastX, lastY);
      const hover = el && el.closest ? el.closest('.gap') : null;
      if (!hover || dragBlockSet.has(hover)) { invalidate(); return; }

      if (dragKind === 'msg') {
        // (1) 드래그 중인 '자기 이미지' 위에서는 그 이미지들 사이/뒤로 세밀 스냅
        //     → 로그를 자기에게 붙은 이미지 아래(또는 사이)로 내릴 수 있게 한다.
        if (!hover.hasAttribute('data-mid') && hover.classList.contains('cutin')
            && anchorMessageId(hover) === dragMsgId) {
          const rect = hover.getBoundingClientRect();
          const topHalf = lastY < rect.top + rect.height / 2;
          dropRef = topHalf ? hover : collectBlockAny(hover).slice(-1)[0].nextSibling;
          if (refInsideBlock()) { invalidate(); return; }
          showLine(topHalf ? rect.top : rect.bottom);
          return;
        }
        // (2) 그 외에는 다른 메시지 블록(메시지+딸린 컷인) 경계에만 스냅
        //     (남의 이미지 그룹을 쪼개는 위치는 허용하지 않는다 — 모델로 표현 불가)
        const mrow = hover.hasAttribute('data-mid') ? hover : anchorMessageRow(hover);
        if (!mrow) {   // 첫 메시지 위(TOP) 구역
          const first = wrap.querySelector('.gap[data-mid]');
          if (!first || dragBlockSet.has(first)) { invalidate(); return; }
          dropRef = first;
          showLine(first.getBoundingClientRect().top);
          return;
        }
        if (dragBlockSet.has(mrow)) { invalidate(); return; }
        const block = collectBlock(mrow);
        let lastEl = mrow;
        block.forEach(n => { if (n.nodeType === 1) lastEl = n; });
        const top = mrow.getBoundingClientRect().top;
        const bottom = lastEl.getBoundingClientRect().bottom;
        if (lastY < (top + bottom) / 2) {          // 위 절반 → 이 블록 앞
          dropRef = mrow;
          if (refInsideBlock()) { invalidate(); return; }
          showLine(top);
        } else {                                    // 아래 절반 → 이 블록 뒤(딸린 컷인 다음)
          dropRef = block[block.length - 1].nextSibling;
          if (refInsideBlock()) { invalidate(); return; }
          showLine(bottom);
        }
      } else {
        // 컷인: 아무 행(메시지·컷인) 경계에나 스냅
        const rect = hover.getBoundingClientRect();
        if (lastY < rect.top + rect.height / 2) {
          dropRef = hover;
          if (refInsideBlock()) { invalidate(); return; }
          showLine(rect.top);
        } else {
          const b = collectBlockAny(hover);
          dropRef = b[b.length - 1].nextSibling;
          if (refInsideBlock()) { invalidate(); return; }
          showLine(rect.bottom);
        }
      }
    }

    // 포인터가 뷰포트 상/하단 가까이면 근접도에 비례한 속도로 계속 스크롤한다(먼 거리 이동용).
    function manageAutoScroll() {
      if (!dragRow) { stopAutoScroll(); return; }
      const h = win.innerHeight || doc.documentElement.clientHeight;
      let dir = 0, prox = 0;
      if (lastY < EDGE) { dir = -1; prox = (EDGE - lastY) / EDGE; }
      else if (lastY > h - EDGE) { dir = 1; prox = (lastY - (h - EDGE)) / EDGE; }
      if (!dir) { stopAutoScroll(); return; }
      autoDir = dir;
      autoStep = Math.max(1, Math.ceil(MAX_STEP * Math.min(1, prox)));
      if (!autoRaf) {
        const loop = () => {
          if (!dragRow || !autoDir) { autoRaf = 0; return; }
          win.scrollBy(0, autoDir * autoStep);
          updateDrop();                 // 스크롤 후 표시선 재계산(고정된 lastX/lastY 기준)
          autoRaf = win.requestAnimationFrame(loop);
        };
        autoRaf = win.requestAnimationFrame(loop);
      }
    }

    function moveBlockBefore(block, ref) { for (const n of block) wrap.insertBefore(n, ref); }

    function endDrag() {
      if (!dragRow) return;
      stopAutoScroll();
      const kind = dragKind, rowEl = dragRow, block = dragBlock;
      const valid = dropValid, ref = dropRef;
      const msgId = dragMsgId, cutinId = dragCutinId;
      rowEl.classList.remove('reorder-dragging');
      if (line) line.style.display = 'none';
      dragRow = null; dragKind = null; dragBlock = null; dragBlockSet = null;
      dropRef = null; dropValid = false; dragMsgId = null; dragCutinId = null;
      if (!valid || !wrap) return;
      const esc = (s) => (win.CSS && win.CSS.escape) ? win.CSS.escape(s) : s;

      let changed = false;
      if (kind === 'msg') {
        // 이 메시지에 붙어 있던 이미지들(이동 후 위치에 따라 앵커를 다시 계산할 대상)
        const ownIds = cutins.filter(c => c.afterId === msgId).map(c => String(c.id));
        moveBlockBefore(block, ref);                         // 메시지 한 줄만 이동(딸린 이미지는 남음)
        // 메시지 순서를 DOM(이동 결과)에 맞춘다 — 위 메시지 뒤로. 순서가 그대로면 no-op.
        const prev = prevMessageRow(rowEl);
        moveMessage(msgId, prev ? prev.getAttribute('data-mid') : TOP);
        // 이 메시지의 이미지들: 새 DOM 위치 기준으로 앵커를 다시 잡는다.
        //  · 메시지가 이미지 위로 갔으면 이미지는 그대로 메시지에 붙고,
        //  · 메시지가 이미지 아래로 내려갔으면 그 이미지는 '이전 메시지'로 앵커된다.
        const affected = new Set([msgId]);
        ownIds.forEach(id => {
          const node = wrap.querySelector('.gap.cutin[data-cutin-id="' + esc(id) + '"]');
          const c = cutins.find(x => String(x.id) === id);
          if (!node || !c) return;
          c.afterId = anchorMessageId(node);
          affected.add(c.afterId);
        });
        affected.forEach(a => reorderCutinGroup(a, cutinIdsForAnchorInDom(a)));
        changed = true;
      } else {
        // 컷인: DOM 이동 후 새 위치의 위 메시지로 afterId·형제 순서를 재계산
        moveBlockBefore(block, ref);
        const newAfter = anchorMessageId(rowEl);
        const c = cutins.find(x => String(x.id) === String(cutinId));
        if (c) c.afterId = newAfter;
        reorderCutinGroup(newAfter, cutinIdsForAnchorInDom(newAfter));
        changed = true;
      }
      if (changed) {
        orderDirty = true;                          // 컷인 앵커 속성이 낡음(다음 컷인 모드 진입 때 재렌더)
        els.preview.dataset.html = buildDocument();     // 다운로드·복사용 HTML 을 새 순서로 갱신(문자열만)
      }
    }

    // 현재 DOM 에서 afterId 그룹에 속한 컷인 id 목록(위→아래 순)
    function cutinIdsForAnchorInDom(afterId) {
      const ids = [];
      wrap.querySelectorAll('.gap.cutin[data-cutin-id]').forEach(node => {
        if (anchorMessageId(node) === afterId) ids.push(node.getAttribute('data-cutin-id'));
      });
      return ids;
    }

    // 핸들 pointerdown 만 드래그 시작(이벤트 위임 — 행 수가 많아도 리스너 하나).
    doc.addEventListener('pointerdown', (e) => {
      if (!reorderMode) return;
      const handle = e.target && e.target.closest ? e.target.closest('.reorder-handle') : null;
      if (!handle) return;
      const row = handle.closest('.gap');
      if (!row || !wrap) return;
      e.preventDefault();
      dragRow = row;
      dragKind = row.hasAttribute('data-mid') ? 'msg' : 'cutin';
      dragMsgId = dragKind === 'msg' ? row.getAttribute('data-mid') : null;
      dragCutinId = dragKind === 'cutin' ? row.getAttribute('data-cutin-id') : null;
      dragBlock = collectBlockAny(row);            // 자기 한 줄만(메시지는 딸린 컷인 제외)
      dragBlockSet = new Set(dragBlock);
      dropRef = null; dropValid = false;
      lastX = e.clientX; lastY = e.clientY;
      row.classList.add('reorder-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      updateDrop();
    });

    doc.addEventListener('pointermove', (e) => {
      if (!dragRow) return;
      lastX = e.clientX; lastY = e.clientY;
      if (moveRaf) return;                        // rAF 로 1프레임당 한 번만 계산
      moveRaf = win.requestAnimationFrame(() => {
        moveRaf = 0;
        updateDrop();
        manageAutoScroll();
      });
    });

    doc.addEventListener('pointerup', endDrag);
    doc.addEventListener('pointercancel', endDrag);
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
  els.reorderToggle.addEventListener('click', toggleReorderMode);
  // 분할 버튼 — 왼쪽(컷인 삽입) 은 삽입 모드 토글, 오른쪽(편집 아이콘) 은 ImgBB 키 설정 모달.
  els.cutinToggle.addEventListener('click', toggleInsertMode);
  els.imgbbSettingsBtn.addEventListener('click', openImgbbModal);
  els.cutinFile.addEventListener('change', () => {
    const f = els.cutinFile.files && els.cutinFile.files[0];
    if (f) addCutin(f);
  });
  // ImgBB 키 설정 모달 — 저장/삭제/닫기로 갱신·종료.
  els.imgbbSaveBtn.addEventListener('click', saveImgbbKey);
  els.imgbbClearBtn.addEventListener('click', () => { clearImgbbKey(); syncImgbbModal(); });
  els.imgbbCloseBtn.addEventListener('click', closeImgbbModal);
  els.imgbbKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveImgbbKey(); });
  // 오버레이(다이얼로그 바깥) 클릭·Esc 로 닫기
  els.imgbbModal.addEventListener('click', (e) => { if (e.target === els.imgbbModal) closeImgbbModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.imgbbModal.hidden) closeImgbbModal(); });
  // 북마클릿 버튼: 북마크바로 끌어당기는 동안엔 :hover 가 유지되지 않을 수 있어
  // dragstart/dragend 로 .dragging 을 붙였다 떼어 그동안 빨강을 유지한다.
  if (els.bookmarklet) {
    els.bookmarklet.addEventListener('dragstart', () => els.bookmarklet.classList.add('dragging'));
    els.bookmarklet.addEventListener('dragend', () => els.bookmarklet.classList.remove('dragging'));
  }
  // 미리보기가 다시 그려질 때마다 스크롤 복원 + 슬롯·삭제 핸들러를 새로 연결한다.
  els.preview.addEventListener('load', onPreviewLoad);
  // 사이트 테마(어두운/밝은)가 바뀌면 미리보기 배경·스크롤바도 다시 맞춘다.
  new MutationObserver(() => { if (messages.length) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

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
