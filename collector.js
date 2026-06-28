/*
 * CCFOLIA 로그 수집기 (collector)
 * ──────────────────────────────────────────────────────────────
 * 사용법 — 두 가지 (둘 다 ccfolia 방 탭 안에서 실행)
 *   ● 북마클릿(추천): 변환기 사이트에서 "코코포리아 로그 가져오기" 버튼을 북마크바로
 *     드래그해 등록한 뒤, ccfolia 방 화면에서 그 북마크를 누른다.
 *   ● 콘솔: ccfolia 방 페이지에서 F12 → Console 에 이 파일 내용을 붙여넣고 Enter.
 *   → 어느 쪽이든 변환기 사이트가 새 탭으로 열리며 로그가 바로 들어간다(파일 불필요).
 *     자동 전달이 막히면(팝업 차단 등) ccfolia-log-<roomId>.json 으로 다운로드되며,
 *     그 JSON 을 변환기에 끌어다 놓아도 된다.
 *
 * 동작 원리
 *   - 로그인 세션의 Firebase 인증 토큰을 IndexedDB(firebaseLocalStorageDb)에서 읽어
 *     Firestore REST API 를 "본인 권한"으로 호출한다.
 *   - rooms/<roomId>/messages 를 끝까지(nextPageToken) 가져온다.
 *   - 비밀 대화는 귓속말이 아니라 별도의 비밀 채널(channelName "비밀(...)")로 구분되며,
 *     접근 권한이 있는 채널의 메시지는 그대로 수집된다.
 *   - 수집한 JSON 은 변환기 탭으로 postMessage 로 직접 넘긴다(파일·서버 경유 없음).
 *   - 진행 상황은 ccfolia 페이지 상단 배너와 변환기 탭에 실시간(수집 건수)으로 표시되므로
 *     로그가 길어도 콘솔 없이 동작 여부를 확인할 수 있다.
 *
 * 주의
 *   - 출력되는 JSON 에는 본문이 포함된다(개인 RP). 외부에 함부로 공유하지 말 것.
 *   - 인증 토큰은 브라우저 안에서만 쓰이며 어디로도 전송되지 않는다.
 */
(async () => {
  const PROJECT_ID = 'ccfolia-160aa';
  // 수집한 로그를 바로 받아 렌더링하는 변환기 사이트
  const CONVERTER_URL = 'https://mandw0103.github.io/MungLog-Pages/';
  const CONVERTER_ORIGIN = new URL(CONVERTER_URL).origin;
  const roomId = location.pathname.match(/rooms\/([^/]+)/)?.[1];
  if (!roomId) { alert('ccfolia 방(rooms/...) 페이지에서 실행하세요.'); return; }

  // ── 진행 상황 배너 (클릭 즉시 피드백) ────────────────────────
  // ccfolia 페이지 상단에 떠서 수집 건수·완료·실패를 보여준다(콘솔 불필요).
  function makeBanner() {
    const wrap = document.createElement('div');
    wrap.setAttribute('style', [
      'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:10px',
      'background:#2c2c2c', 'color:#fff', 'padding:11px 18px', 'border-radius:10px',
      'font:600 14px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'max-width:90vw', 'pointer-events:none',
    ].join(';'));
    const spin = document.createElement('div');
    spin.setAttribute('style', [
      'width:16px', 'height:16px', 'border:2px solid rgba(255,255,255,.3)',
      'border-top-color:#fff', 'border-radius:50%', 'flex-shrink:0',
      'animation:trpglog-spin .8s linear infinite',
    ].join(';'));
    const msg = document.createElement('span');
    const style = document.createElement('style');
    style.textContent = '@keyframes trpglog-spin{to{transform:rotate(360deg)}}';
    wrap.append(spin, msg);
    (document.body || document.documentElement).append(style, wrap);
    const finish = (text, bg, ms) => {
      msg.textContent = text; spin.style.display = 'none'; wrap.style.background = bg;
      setTimeout(() => { wrap.remove(); style.remove(); }, ms);
    };
    return {
      set: (t) => { msg.textContent = t; },
      done: (t) => finish(t, '#1f7a3d', 6000),
      fail: (t) => finish(t, '#a13434', 9000),
    };
  }
  const banner = makeBanner();
  banner.set('로그 수집 준비 중…');

  // ── 변환기 탭을 즉시 연다 ────────────────────────────────────
  // 북마크 클릭 제스처 안에서 열어야 팝업 차단을 피한다. 또 수집이 끝나길 기다리지
  // 않고 미리 열어, 변환기 탭에도 진행 건수를 흘려보낸다.
  let win = null;
  try { win = window.open(CONVERTER_URL, '_blank'); } catch (e) { win = null; }

  // 변환기와의 핸드셰이크 상태
  let converterReady = false, acked = false, sent = false;
  let payload = null;                         // 수집 완료 후 채워짐
  const postPayload = () => {
    if (win && converterReady && payload && !sent) {
      sent = true;
      win.postMessage({ type: 'trpglog-payload', payload }, CONVERTER_ORIGIN);
    }
  };
  const onMsg = (e) => {
    if (e.origin !== CONVERTER_ORIGIN || !e.data) return;
    if (e.data.type === 'trpglog-ready') { converterReady = true; postPayload(); }
    else if (e.data.type === 'trpglog-ack') { acked = true; }
  };
  if (win) window.addEventListener('message', onMsg);
  const postProgress = (n) => {
    if (win && converterReady) win.postMessage({ type: 'trpglog-progress', count: n }, CONVERTER_ORIGIN);
  };

  // ── IndexedDB 헬퍼 ───────────────────────────────────────────
  const openIDB = (n) => new Promise((res, rej) => {
    const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const getAll = (db, s) => new Promise((res, rej) => {
    const q = db.transaction(s, 'readonly').objectStore(s).getAll();
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });

  // ── 인증 토큰 확보 ───────────────────────────────────────────
  let idToken;
  try {
    for (const r of await getAll(await openIDB('firebaseLocalStorageDb'), 'firebaseLocalStorage'))
      if ((r.fbase_key || '').startsWith('firebase:authUser:'))
        idToken = r.value?.stsTokenManager?.accessToken;
  } catch (e) { /* ignore */ }
  if (!idToken) {
    banner.fail('로그인 토큰을 찾지 못했습니다. ccfolia 에 로그인했는지 확인하세요.');
    if (win) win.close();
    return;
  }

  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const H = { Authorization: 'Bearer ' + idToken };

  // ── Firestore REST 값 디코더 ─────────────────────────────────
  const dv = (v) => {
    if (v == null) return v;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return +v.integerValue;
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('mapValue' in v) return df(v.mapValue.fields || {});
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(dv);
    return v;
  };
  const df = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dv(v)]));

  // ── 컬렉션 전체 수집(페이지네이션) ───────────────────────────
  async function fetchAll(col, onProgress) {
    const out = [];
    let pageToken = '';
    do {
      const url = `${base}/rooms/${roomId}/${col}?pageSize=300`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const r = await fetch(url, { headers: H });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.warn(`[수집] ${col} 실패`, r.status, detail);
        throw new Error(`${col} 수집 실패 (${r.status})`);
      }
      const j = await r.json();
      (j.documents || []).forEach(d => out.push({ _id: d.name.split('/').pop(), ...df(d.fields || {}) }));
      pageToken = j.nextPageToken || '';
      if (onProgress) onProgress(out.length);
      console.log(`[수집] ${col}: ${out.length}건...`);
    } while (pageToken);
    return out;
  }

  console.log('%c[ccfolia 수집기] 시작', 'color:#4af;font-weight:bold', { roomId });
  try {
    banner.set('로그 수집 중… 0건');
    const messages = await fetchAll('messages', (n) => {
      banner.set(`로그 수집 중… ${n}건`);
      postProgress(n);
    });

    // createdAt(ISO 문자열) 기준 시간순 정렬
    messages.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    payload = {
      source: 'ccfolia',
      roomId,
      exportedAt: new Date().toISOString(),
      count: messages.length,
      messages,
    };

    // ── 변환기로 전달 ────────────────────────────────────────────
    // 미리 열어둔 변환기 탭에 payload 를 넘기고, ack 가 오면 성공.
    // 팝업이 막혔거나(win 없음) 20초 내 무응답이면 파일 폴백.
    function deliver() {
      return new Promise((resolve) => {
        if (!win) { resolve(false); return; }
        banner.set('변환기로 전달 중…');
        postPayload();                          // ready 면 즉시, 아니면 onMsg 가 ready 때 전송
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (acked) { clearInterval(iv); window.removeEventListener('message', onMsg); resolve(true); }
          else if (Date.now() - t0 > 20000) { clearInterval(iv); window.removeEventListener('message', onMsg); resolve(false); }
        }, 100);
      });
    }

    // ── 파일 다운로드 (폴백) ─────────────────────────────────────
    function downloadFile() {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ccfolia-log-${roomId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return a.download;
    }

    if (await deliver()) {
      banner.done(`완료! 변환기 탭에서 확인하세요 (총 ${messages.length}건)`);
      console.log(`%c완료! 총 ${messages.length}건 → 변환기로 전달됨`, 'color:#0a0;font-weight:bold');
    } else {
      const name = downloadFile();
      banner.fail(`자동 전달이 막혀 파일로 저장했습니다 (${name}). 변환기에 끌어다 놓으세요.`);
      console.log(`%c자동 전달이 막혀 파일로 저장했습니다 (${name}).`, 'color:#fa0;font-weight:bold');
    }
  } catch (err) {
    window.removeEventListener('message', onMsg);
    if (win) win.close();
    const message = err && err.message ? err.message : String(err);
    banner.fail(`로그 수집에 실패했습니다. 다시 로그인하거나 방 권한을 확인하세요. (${message})`);
    console.error('[ccfolia 수집기] 실패', err);
  }
})();
