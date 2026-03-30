// ============================================================
// 패스트포텐 마케팅 자동화 MVP v6 — Google Apps Script
// ============================================================
// v5 대비 변경:
// 1. 적합성 점수 / 품질등급 제거 → 사람이 직접 검수
// 2. 수집 시 상태 = "검수대기" → 사람이 "대기"로 바꾼 것만 답변 생성
// 3. 키워드별 마지막 활성일 체크 → 오늘 이미 수집한 키워드 스킵
// 4. docId 중복 체크에 /docs/ 패턴 추가
// ============================================================
// 플로우:
//   Phase 1 실행 → 질문 수집 (상태: 검수대기)
//   → 사람이 시트에서 검수 (답변할 것 = "대기", 불필요 = "스킵")
//   → Phase 2 실행 → "대기" 상태인 질문에만 답변 생성
//   → Phase 3 실행 → 블로그 생성
// ============================================================

var EXEC_START_TIME = null;
var TIME_LIMIT_SEC = 330; // 5.5분

function isTimeUp() {
  if (!EXEC_START_TIME) return false;
  return (Date.now() - EXEC_START_TIME) / 1000 > TIME_LIMIT_SEC;
}

function elapsedSec() {
  if (!EXEC_START_TIME) return 0;
  return Math.round((Date.now() - EXEC_START_TIME) / 1000);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🚀 패스트포텐')
    .addItem('▶ Phase 1: 질문 수집 (전체)', 'runPhase1')
    .addItem('▶ Phase 1: 통합검색만 수집', 'runPhase1Search')
    .addItem('▶ Phase 1: 최신글만 수집', 'runPhase1Latest')
    .addSeparator()
    .addItem('▶ Phase 2: 답변 생성 (대기 상태만)', 'runPhase2')
    .addItem('▶ Phase 3: 블로그 생성', 'runPhase3')
    .addSeparator()
    .addItem('⚙ 설정 확인', 'checkSettings')
    .addItem('🧪 서버 상태 확인', 'checkServer')
    .addToUi();
}

// ===== 설정 =====
function getConfig(key) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('설정');
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return '';
}

function checkSettings() {
  var apiKey = getConfig('CLAUDE_API_KEY');
  var serverUrl = getConfig('PLAYWRIGHT_SERVER_URL');
  var ui = SpreadsheetApp.getUi();
  var issues = [];
  if (!apiKey || apiKey === '여기에_API_키_입력') issues.push('CLAUDE_API_KEY 미설정');
  if (!serverUrl) issues.push('PLAYWRIGHT_SERVER_URL 미설정');
  if (issues.length > 0) {
    ui.alert('⚠️ 설정 필요', issues.join('\n'), ui.ButtonSet.OK);
    return false;
  }
  ui.alert('✅ 설정 확인 완료', '서버: ' + serverUrl + '\nAPI 키: ' + apiKey.substring(0, 15) + '...', ui.ButtonSet.OK);
  return true;
}

function checkServer() {
  var serverUrl = getConfig('PLAYWRIGHT_SERVER_URL');
  var ui = SpreadsheetApp.getUi();
  try {
    var resp = UrlFetchApp.fetch(serverUrl + '/health', { muteHttpExceptions: true });
    ui.alert('서버 상태', resp.getContentText(), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('❌ 서버 연결 실패', e.message, ui.ButtonSet.OK);
  }
}

// ===== Playwright 서버 호출 =====
function callPlaywright(endpoint, payload) {
  var serverUrl = getConfig('PLAYWRIGHT_SERVER_URL');
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  var resp = UrlFetchApp.fetch(serverUrl + endpoint, options);
  if (resp.getResponseCode() !== 200) {
    throw new Error('서버 HTTP ' + resp.getResponseCode());
  }
  return JSON.parse(resp.getContentText());
}

// ===== Claude API =====
function callClaude(systemPrompt, userMessage, maxTokens) {
  maxTokens = maxTokens || 2000;
  var apiKey = getConfig('CLAUDE_API_KEY');
  var model = getConfig('CLAUDE_MODEL') || 'claude-sonnet-4-20250514';

  var options = {
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
    var json = JSON.parse(response.getContentText());
    if (json.error) return { success: false, error: json.error.message };
    return { success: true, text: json.content[0].text };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ===== 팩트 룰북 =====
function getRulebook(keyword) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('팩트룰북');
  var data = sheet.getDataRange().getValues();
  var commonRule = '', matchedRule = '';
  var kw = keyword.toLowerCase();

  for (var i = 1; i < data.length; i++) {
    var cat = String(data[i][0] || '').toLowerCase();
    var rule = String(data[i][1] || '');
    if (cat === '공통') { commonRule = rule; continue; }
    if (kw.indexOf('사회복지사') >= 0 && cat.indexOf('사회복지사') >= 0) { matchedRule = rule; break; }
    if (kw.indexOf('보육교사') >= 0 && cat.indexOf('보육교사') >= 0) { matchedRule = rule; break; }
    if (kw.indexOf('산업기사') >= 0 && cat === '산업기사') { matchedRule = rule; break; }
    if (kw.indexOf('기사') >= 0 && kw.indexOf('산업기사') < 0 && cat === '기사') { matchedRule = rule; break; }
    if (kw.indexOf('기능사') >= 0 && cat === '기능사') { matchedRule = rule; break; }
    if (kw.indexOf('전문학사') >= 0 && cat === '전문학사') { matchedRule = rule; break; }
    if ((kw.indexOf('학사') >= 0 || kw.indexOf('학위') >= 0) && kw.indexOf('전문학사') < 0 && cat === '학사') { matchedRule = rule; break; }
    if (kw.indexOf('편입') >= 0 && cat === '편입') { matchedRule = rule; break; }
    if (kw.indexOf('대학원') >= 0 && cat === '대학원') { matchedRule = rule; break; }
    if (kw.indexOf('검정고시') >= 0 && cat === '검정고시') { matchedRule = rule; break; }
  }

  var result = '## 공통\n' + commonRule;
  if (matchedRule) result += '\n\n## 상세\n' + matchedRule;
  return result;
}

// ===== 유틸리티 =====
function getExistingUrls(sheet) {
  var urls = {};
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var url = String(data[i][3] || '').trim();
    if (url) {
      urls[url] = true;
      var m = url.match(/docId=(\d+)/) || url.match(/\/docs\/(\d+)/);
      if (m) urls[m[1]] = true;
    }
  }
  return urls;
}

function getNextEmptyRow(sheet) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (!data[i][1] && !data[i][3] && !data[i][4]) return i + 1;
  }
  return data.length + 1;
}

function getTodayStr() {
  var now = new Date();
  var kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return Utilities.formatDate(kst, 'GMT', 'yyyy-MM-dd');
}


// ===============================================
// PHASE 1: 지식인 질문 수집
// ===============================================
function runPhase1() {
  _runPhase1WithChannel('all', '전체 (통합검색 + 최신글)');
}

function runPhase1Search() {
  _runPhase1WithChannel('search', '통합검색만');
}

function runPhase1Latest() {
  _runPhase1WithChannel('latest', '최신글만');
}

function _runPhase1WithChannel(channel, channelLabel) {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Phase 1 시작', '수집 모드: ' + channelLabel + '\n오늘 이미 수집한 키워드는 건너뜁니다.', ui.ButtonSet.OK);
  var result = runPhase1Internal(channel);
  var msg = '수집: ' + result.collected + '건 (통합검색 ' + result.fromSearch + ', 최신글 ' + result.fromKin + ')\n처리 키워드: ' + result.keywordsProcessed + '개 / 스킵(이미 수집): ' + result.keywordsSkipped + '개';
  if (result.timedOut) msg += '\n\n⏰ 시간 제한 도달. 다음 실행 시 남은 키워드부터 이어서 처리됩니다.';
  ui.alert('Phase 1 완료', msg, ui.ButtonSet.OK);
}

function runPhase1Internal(channel) {
  channel = channel || 'all';
  EXEC_START_TIME = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var kwSheet = ss.getSheetByName('키워드관리');
  var ansSheet = ss.getSheetByName('지식인답변');
  var kwData = kwSheet.getDataRange().getValues();
  var existingUrls = getExistingUrls(ansSheet);
  var maxPerKw = parseInt(getConfig('키워드당_최신글_수집수')) || 10;
  var todayStr = getTodayStr();

  var totalCollected = 0, fromSearch = 0, fromKin = 0;
  var keywordsProcessed = 0, keywordsSkipped = 0;
  var timedOut = false;

  for (var i = 1; i < kwData.length; i++) {
    if (isTimeUp()) {
      Logger.log('⏰ 시간 제한 (' + elapsedSec() + '초)');
      timedOut = true;
      break;
    }

    var keyword = String(kwData[i][1] || '').trim();
    var status = String(kwData[i][8] || '').trim();
    if (!keyword || status !== '활성') continue;

    // 오늘 이미 수집한 키워드 스킵 (G열 = 마지막 활성일)
    var lastActiveDate = String(kwData[i][6] || '').trim();
    if (lastActiveDate && lastActiveDate.substring(0, 10) === todayStr) {
      keywordsSkipped++;
      continue;
    }

    Logger.log('=== [' + elapsedSec() + '초] 키워드: ' + keyword + ' ===');
    keywordsProcessed++;

    try {
      var searchResult = callPlaywright('/kin-search', { keyword: keyword, maxResults: maxPerKw, channel: channel });
      Logger.log('서버 수집 [' + channel + ']: ' + searchResult.totalResults + '건');

      var questions = searchResult.questions || [];

      for (var j = 0; j < questions.length; j++) {
        if (isTimeUp()) { timedOut = true; break; }

        var q = questions[j];
        var docIdMatch = q.url.match(/docId=(\d+)/) || q.url.match(/\/docs\/(\d+)/);
        var docId = docIdMatch ? docIdMatch[1] : null;
        if (existingUrls[q.url] || (docId && existingUrls[docId])) continue;

        var detail;
        try {
          detail = callPlaywright('/kin-detail', { url: q.url });
        } catch (e) {
          Logger.log('  상세 스크래핑 실패: ' + e.message);
          detail = { title: q.title || '(추출 실패)', body: '(추출 실패)', answerCount: 0, success: false };
        }

        var nextRow = getNextEmptyRow(ansSheet);
        ansSheet.getRange(nextRow, 1).setValue(nextRow - 1);
        ansSheet.getRange(nextRow, 2).setValue(keyword);
        ansSheet.getRange(nextRow, 3).setValue(q.channel);
        ansSheet.getRange(nextRow, 4).setValue(q.url);
        ansSheet.getRange(nextRow, 5).setValue(detail.title || q.title);
        ansSheet.getRange(nextRow, 6).setValue(detail.body || '');
        ansSheet.getRange(nextRow, 7).setValue(detail.answerCount || 0);
        ansSheet.getRange(nextRow, 11).setValue(detail.success ? '검수대기' : '스크래핑실패');

        existingUrls[q.url] = true;
        if (docId) existingUrls[docId] = true;
        totalCollected++;
        if (q.channel === '통합검색') fromSearch++;
        else fromKin++;

        Utilities.sleep(1500);
      }

      // 키워드 시트 업데이트
      kwSheet.getRange(i + 1, 5).setValue(questions.length);
      kwSheet.getRange(i + 1, 7).setValue(todayStr);

    } catch (e) {
      Logger.log('Phase 1 Error [' + keyword + ']: ' + e.toString());
    }

    if (timedOut) break;
  }

  return {
    collected: totalCollected, fromSearch: fromSearch, fromKin: fromKin,
    keywordsProcessed: keywordsProcessed, keywordsSkipped: keywordsSkipped,
    timedOut: timedOut, elapsed: elapsedSec()
  };
}


// ===============================================
// PHASE 2: 답변 생성 (대기 상태만)
// ===============================================
function runPhase2() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Phase 2 시작', '"대기" 상태인 질문에 대해 답변을 생성합니다.', ui.ButtonSet.OK);
  var result = runPhase2Internal();
  var msg = '답변 생성: ' + result.generated + '건';
  if (result.failed > 0) msg += ' / 실패: ' + result.failed + '건';
  if (result.timedOut) msg += '\n\n⏰ 시간 제한 도달. 다음 실행 시 남은 행부터 이어서 처리됩니다.';
  ui.alert('Phase 2 완료', msg, ui.ButtonSet.OK);
}

function runPhase2Internal() {
  EXEC_START_TIME = EXEC_START_TIME || Date.now();
  var ansSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('지식인답변');
  var data = ansSheet.getDataRange().getValues();
  var generated = 0, failed = 0;
  var timedOut = false;

  for (var i = 1; i < data.length; i++) {
    if (isTimeUp()) {
      Logger.log('⏰ Phase 2 시간 제한 (' + elapsedSec() + '초)');
      timedOut = true;
      break;
    }

    var status = String(data[i][10] || '').trim();
    var keyword = String(data[i][1] || '').trim();
    var url = String(data[i][3] || '').trim();
    var qTitle = String(data[i][4] || '').trim();
    var qBody = String(data[i][5] || '').trim();

    if (status !== '대기' || !keyword || !url) continue;

    // 본문이 없으면 재시도
    if (!qBody || qBody.length < 10 || qBody === '(추출 실패)') {
      try {
        var detail = callPlaywright('/kin-detail', { url: url });
        if (detail.title) { qTitle = detail.title; ansSheet.getRange(i + 1, 5).setValue(qTitle); }
        if (detail.body) { qBody = detail.body; ansSheet.getRange(i + 1, 6).setValue(qBody); }
        if (!detail.success) {
          ansSheet.getRange(i + 1, 11).setValue('스크래핑실패');
          failed++;
          continue;
        }
      } catch (e) {
        ansSheet.getRange(i + 1, 11).setValue('스크래핑실패');
        failed++;
        continue;
      }
      Utilities.sleep(1500);
    }

    try {
      var rulebook = getRulebook(keyword);
      var answer = generateAnswer(keyword, qTitle, qBody, rulebook);

      if (answer.success) {
        ansSheet.getRange(i + 1, 9).setValue(answer.text);
        ansSheet.getRange(i + 1, 11).setValue('답변완료');
        generated++;
        Logger.log('  [행' + (i+1) + '] 답변 생성 완료');
      } else {
        ansSheet.getRange(i + 1, 11).setValue('생성실패');
        failed++;
        Logger.log('  [행' + (i+1) + '] 생성 실패: ' + answer.error);
      }
      Utilities.sleep(2000);
    } catch (e) {
      Logger.log('Phase 2 err row ' + (i + 1) + ': ' + e);
      ansSheet.getRange(i + 1, 11).setValue('생성실패');
      failed++;
    }
  }

  return { generated: generated, failed: failed, timedOut: timedOut };
}

function generateAnswer(keyword, title, body, rulebook) {
  var systemPrompt = '당신은 학점은행제 전문 상담사입니다. 네이버 지식인에서 자격증·학위·편입 관련 질문에 답변합니다.\n\n'
    + '## 최우선 원칙\n'
    + '1. 팩트 룰북에 있는 내용만 사실로 작성\n'
    + '2. 확인 안 된 정보는 [검수: ○○ 확인 필요] 표기 — 절대 임의 작성 금지\n'
    + '3. 학점은행제 기간/학점/비용 단정적 수치 금지 → "개인 상황에 따라 다름" + 상담 권유\n'
    + '4. 브랜드명·전화번호·URL·카톡ID 본문 직접 노출 금지\n'
    + '5. 질문을 끝까지 읽고, 질문자가 진짜 궁금한 것에만 정확히 답변\n\n'
    + '## 답변 구조 (3블록)\n'
    + '1. 도입 (1~2문장) — 아래 6패턴 중 택 1, 매번 다르게\n'
    + '   ① 직진형: 결론 먼저\n'
    + '   ② 공감형: 질문자 상황 공감\n'
    + '   ③ 경험형: "비슷한 문의 많다"\n'
    + '   ④ 정리형: 질문 요약 후 답변\n'
    + '   ⑤ 칭찬형: 질문자 관심 인정\n'
    + '   ⑥ 핵심선제시형: 핵심 조건 바로 제시\n'
    + '2. 핵심 답변 (본문 70~80%) — 팩트 룰북 기반, 질문자 학력별 분기\n'
    + '   - 학력 명확 → 해당 케이스만 상세히\n'
    + '   - 학력 불명 → 학력별 분기 간결 정리 + "상담 추천"\n'
    + '   - 자연스럽게 학점은행제 연결 (교육부 인정, 온라인 가능, 직장 병행)\n'
    + '3. 마무리 (1~2문장) — CTA 또는 순수 마무리\n\n'
    + '## 톤 (A/B/C 중 택 1, 매번 변형)\n'
    + '- A: 약간 격식 (~입니다 위주)\n'
    + '- B: 표준 해요체 (~이에요 위주)\n'
    + '- C: 약간 캐주얼 (~거든요, ~잖아요)\n'
    + '- 이모지 사용 금지. 볼드(**텍스트**)만 강조에 사용.\n\n'
    + '## CTA (70% 확률로 아래 중 택 1, 답변 맨 끝에만)\n'
    + '① "본인 학력에 맞는 구체적인 루트가 궁금하시면 전문 상담사에게 상담받아보시는 것도 좋아요."\n'
    + '② "더 궁금하신 부분 있으시면 편하게 문의해주세요."\n'
    + '③ "구체적인 학점 설계는 전문가와 1:1로 상담받아보시는 걸 추천드려요."\n'
    + '④ "본인 상황에 맞는 최단기 루트가 궁금하시면 무료 상담 한번 받아보세요."\n'
    + '⑤ (30%) CTA 없이: "도움이 되셨으면 좋겠어요!" / "좋은 결과 있으시길 바라요!"\n\n'
    + '## 삭제 방지 규칙 (중요)\n'
    + '- 600자 초과 금지 (긴 답변 = GPT/매크로 인식 → 삭제)\n'
    + '- 과도한 소제목·목차 구조 금지\n'
    + '- 복붙 느낌 금지 — 질문에 맞춤형으로 작성\n'
    + '- 질문을 읽지 않은 듯한 일반론 답변 금지\n\n'
    + '## 금지어\n'
    + '경로, 솔루션, 무조건, 확실히, 100%, 반드시, 최저가, 업계 최고, 보장합니다, 단 며칠 만에, 취업 보장, 합격 보장, 너무 쉽습니다, (브랜드명), (연락처/URL)\n\n'
    + '## 답변 길이\n'
    + '250~600자. 단순 질문 250~350자, 보통 350~500자, 복합 500~600자.\n\n'
    + '## 출력\n'
    + '답변 본문 (일반 텍스트) + 하단 검수 메모\n\n'
    + '검수 메모 형식:\n'
    + '---\n'
    + '[검수 메모]\n'
    + '- 질문 유형: / 질문자 학력: / 매칭 룰북: / 도입 패턴: / 톤: / CTA:\n'
    + '- [검수 필요 항목]: (플레이스홀더 목록 또는 "없음")\n'
    + '- 글자수: 약 ○○○자\n'
    + '---\n\n'
    + '## 팩트 룰북\n' + rulebook;

  var userMsg = '질문 제목: ' + title + '\n질문 내용: ' + body + '\n\n위 질문에 대해 답변을 작성해주세요.\n답변 하단에 [검수 메모]도 함께 출력해주세요.';

  return callClaude(systemPrompt, userMsg, 1500);
}


// ===============================================
// PHASE 3: 블로그 생성
// ===============================================
function runPhase3() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Phase 3 시작', '블로그 글 생성을 시작합니다.', ui.ButtonSet.OK);
  var result = runPhase3Internal();
  ui.alert('Phase 3 완료', '블로그 ' + result.count + '건 생성', ui.ButtonSet.OK);
}

function runPhase3Internal() {
  EXEC_START_TIME = EXEC_START_TIME || Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ansSheet = ss.getSheetByName('지식인답변');
  var blogSheet = ss.getSheetByName('블로그관리');
  var ansData = ansSheet.getDataRange().getValues();
  var groups = {};

  for (var i = 1; i < ansData.length; i++) {
    var kw = String(ansData[i][1] || '').trim();
    var t = String(ansData[i][4] || '').trim();
    var b = String(ansData[i][5] || '').trim();
    var a = String(ansData[i][8] || '').trim();
    if (!kw || !t || !a) continue;
    if (!groups[kw]) groups[kw] = [];
    groups[kw].push({ title: t, body: b, answer: a });
  }

  var blogCount = 0;
  var topKw = [];
  for (var k in groups) topKw.push([k, groups[k]]);
  topKw.sort(function (a, b) { return b[1].length - a[1].length; });
  topKw = topKw.slice(0, 2);

  for (var x = 0; x < topKw.length; x++) {
    if (isTimeUp()) break;

    var keyword = topKw[x][0];
    var questions = topKw[x][1];
    var qText = questions.slice(0, 5).map(function (q, i) { return '질문 ' + (i + 1) + ': ' + q.title + '\n내용: ' + q.body; }).join('\n\n');
    var rulebook = getRulebook(keyword);
    var blogResult = generateBlog(keyword, qText, rulebook);

    if (blogResult.success) {
      try {
        var p = JSON.parse(blogResult.text.replace(/```json|```/g, '').trim());
        var nr = getNextEmptyRow(blogSheet);
        blogSheet.getRange(nr, 1).setValue(nr - 1);
        blogSheet.getRange(nr, 2).setValue(keyword);
        blogSheet.getRange(nr, 3).setValue('질문기반');
        blogSheet.getRange(nr, 4).setValue(p.title_wp || '');
        blogSheet.getRange(nr, 5).setValue(p.body_wp || '');
        blogSheet.getRange(nr, 7).setValue('대기');
        blogSheet.getRange(nr, 8).setValue(p.title_naver || '');
        blogSheet.getRange(nr, 9).setValue(p.body_naver || '');
        blogSheet.getRange(nr, 10).setValue((p.tags_naver || []).join(', '));
        blogSheet.getRange(nr, 12).setValue('대기');
        blogCount++;
      } catch (e) { Logger.log('Blog parse: ' + e); }
    }
    Utilities.sleep(3000);
  }

  return { count: blogCount };
}

function generateBlog(keyword, questionsText, rulebook) {
  var systemPrompt = '당신은 패스트포텐의 수석 카피라이터입니다.\n'
    + '지식인 질문 기반 블로그 글 2개를 동시에 작성합니다.\n\n'
    + '## JSON 형식으로만 응답\n'
    + '{"title_wp":"WP제목","body_wp":"HTML본문","title_naver":"네이버제목","body_naver":"텍스트본문","tags_naver":["태그1","태그2","태그3","태그4","태그5"]}\n\n'
    + '## [A] 워드프레스 (HTML)\n'
    + '- <div class="fp-wrap">으로 감싸기\n'
    + '- 소제목: <h2> + 이모지 (📋, 🚀, ⏱️, 🚨, 💡)\n'
    + '- 강조박스: <div style="background:#f0f4ff;border-left:4px solid #2E75B6;padding:16px 20px;margin:20px 0;border-radius:8px;">\n'
    + '- 체크리스트: <ul><li> 사용\n'
    + '- 중요문구: <strong>\n'
    + '- 인라인 <style> 절대 금지\n'
    + '- 2000~3000자\n'
    + '- 구조: 공감 도입 → 핵심 정보(소제목 3~4개) → 실전 팁 → 주의사항 → CTA\n'
    + '- CTA: <div style="background:#1B3A5C;color:white;padding:24px 28px;border-radius:12px;text-align:center;margin-top:32px;"><h3 style="margin:0 0 12px;">나에게 맞는 준비 플랜이 궁금하다면?</h3><p style="margin:0 0 16px;opacity:0.9;">전담 1:1 상담으로 최단기간 최적 플랜을 무료로 확인해 보세요.</p><a href="https://m.site.naver.com/1LaX2" style="display:inline-block;background:white;color:#1B3A5C;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">📞 무료 상담 신청하기</a></div>\n\n'
    + '## [B] 네이버 (텍스트)\n'
    + '- HTML 태그 절대 금지, 줄바꿈으로 구분\n'
    + '- 톤: 친근한 대화체\n'
    + '- 【소제목】 기호 + 이모지\n'
    + '- 1200~1800자\n'
    + '- CTA: "카카오톡에서 패스트포텐 검색!"\n\n'
    + '## 팩트 룰북\n' + rulebook + '\n\n'
    + '## 금지어\n경로, 솔루션, 무조건, 확실히, 100%, 반드시, 보장합니다';
  return callClaude(systemPrompt, '키워드: ' + keyword + '\n\n' + questionsText, 4096);
}
