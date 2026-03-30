// ============================================================
// 네이버 지식인 스크래핑 서버 v1.0
// ============================================================
// 기존 naver-checker 서버 구조를 기반으로 제작
// 엔드포인트:
//   POST /kin-search  — 키워드로 지식인 질문 URL 수집
//   POST /kin-detail  — 질문 URL에서 제목/본문 추출
//   GET  /health      — 서버 상태 확인
// ============================================================

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;


// ============================================================
// 공유 브라우저 관리 (기존 naver-checker 패턴)
// ============================================================
let sharedBrowser = null;
let lastUsed = 0;

async function getBrowser() {
  // 5분 이상 미사용 시 브라우저 재시작
  if (sharedBrowser && (Date.now() - lastUsed) > 300000) {
    try { await sharedBrowser.close(); } catch (e) {}
    sharedBrowser = null;
  }
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  lastUsed = Date.now();
  return sharedBrowser;
}

// 모바일 컨텍스트 생성 (봇 차단 회피)
async function createMobileContext(browser) {
  return await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
}


// ============================================================
// POST /kin-search — 키워드로 지식인 질문 URL 수집
// ============================================================
// 요청: { "keyword": "위험물산업기사 학점은행제", "maxResults": 10 }
// 응답: { "keyword": "...", "totalResults": N, "questions": [...] }

app.post('/kin-search', async (req, res) => {
  const { keyword, maxResults, channel } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword 필수' });

  const max = maxResults || 10;
  // channel: "all"(기본값) | "search"(통합검색만) | "latest"(최신글만)
  const ch = (channel || 'all').toLowerCase();

  try {
    const browser = await getBrowser();
    const ctx = await createMobileContext(browser);
    const page = await ctx.newPage();
    const allQuestions = [];
    const seen = new Set();

    // ─────────────────────────────────────────
    // 채널 A: 네이버 통합검색 → 지식인 영역
    // ─────────────────────────────────────────
    if (ch === 'all' || ch === 'search') {
    try {
      await page.goto(
        `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );

      // 스크롤해서 지식인 영역 로드 (충분히 내려야 지식인 영역이 나옴)
      // 맨 아래까지 스크롤 → 다시 위로 → 다시 아래로 (lazy load 트리거)
      await page.evaluate(async () => {
        for (let i = 0; i < 15; i++) {
          window.scrollBy(0, 1200);
          await new Promise(r => setTimeout(r, 350));
        }
        // 맨 아래까지 갔다가 잠시 대기
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1000));
        // 다시 위로 갔다가 아래로 (추가 lazy load 트리거)
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1000));
      });
      await page.waitForTimeout(2000);

      // 지식인 링크 추출 — kinItem 컨테이너 단위로 처리
      // 실제 HTML 구조 (2026년 네이버 모바일 통합검색):
      //   div[data-template-id="kinItem"] = 지식인 결과 1개 컨테이너
      //     a[data-heatmap-target=".title"] > span = 질문 제목
      //     a[data-heatmap-target=".answer"] = 답변 미리보기
      //     div[data-sds-comp="Profile"] (답변자 프로필):
      //       span.iFBHctLXA6ggqGF55WRk = 답변자 이름
      //       span[class*="text-type-badge"] = 뱃지 ("지식파트너", "컨설턴트")
      //       span.wf5yhegUPxcbCIBKXgyc = 카테고리 ("학사 행정, 제도")
      const searchResults = await page.evaluate(() => {
        const items = [];
        const seenDocs = new Set();
        
        // kinItem 컨테이너를 직접 찾음
        const kinItems = document.querySelectorAll('[data-template-id="kinItem"]');
        
        for (const item of kinItems) {
          // 질문 제목 링크 (.title)
          const titleLink = item.querySelector('a[data-heatmap-target=".title"]');
          if (!titleLink) continue;
          
          const href = titleLink.href || '';
          if (!href.includes('kin.naver.com')) continue;
          
          // docId로 중복 체크
          const docMatch = href.match(/\/docs\/(\d+)/) || href.match(/docId=(\d+)/);
          const docKey = docMatch ? docMatch[1] : href;
          if (seenDocs.has(docKey)) continue;
          
          // 제목 텍스트
          const titleSpan = titleLink.querySelector('span');
          const title = titleSpan ? titleSpan.textContent.trim().replace(/\s+/g, ' ') : '';
          if (!title || title.length < 3) continue;
          
          // ═════ 답변자 프로필 추출 ═════
          // 답변 영역의 Profile (질문 영역 Profile은 "네이버 지식iN"이므로 제외)
          let answerer = '';
          
          // 답변 미리보기가 있는 영역 안의 Profile만 가져옴
          const answerArea = item.querySelector('a[data-heatmap-target=".answer"]');
          if (answerArea) {
            // 답변 미리보기의 부모에서 Profile 찾기
            const answerContainer = answerArea.parentElement;
            if (answerContainer) {
              const profile = answerContainer.querySelector('[data-sds-comp="Profile"]');
              if (profile) {
                // 이름 추출
                const nameEl = profile.querySelector('[class*="iFBHctLXA6ggqGF55WRk"]') 
                            || profile.querySelector('[class*="profile-info-title"] a span span');
                const name = nameEl ? nameEl.textContent.trim() : '';
                
                // 뱃지 추출 ("지식파트너", "컨설턴트" 등)
                const badgeEl = profile.querySelector('[class*="dbfbgYbwLHuemBLyfJ4V"]')
                             || profile.querySelector('[class*="text-type-badge"]');
                const badge = badgeEl ? badgeEl.textContent.trim() : '';
                
                // 카테고리 추출 ("학사 행정, 제도" 등)
                const catEl = profile.querySelector('[class*="wf5yhegUPxcbCIBKXgyc"]');
                const category = catEl ? catEl.textContent.trim() : '';
                
                // 조합: "이름 [뱃지] (카테고리)"
                if (name && name !== '네이버 지식iN') {
                  const parts = [name];
                  if (badge) parts.push('[' + badge + ']');
                  if (category) parts.push('(' + category + ')');
                  answerer = parts.join(' ');
                }
              }
            }
          }
          
          // Profile을 못 찾았으면 kinItem 전체에서 두 번째 Profile 시도
          // (첫 번째 Profile은 "네이버 지식iN", 두 번째가 답변자)
          if (!answerer) {
            const allProfiles = item.querySelectorAll('[data-sds-comp="Profile"]');
            if (allProfiles.length >= 2) {
              const profile = allProfiles[1]; // 두 번째 = 답변자
              
              const nameEl = profile.querySelector('[class*="iFBHctLXA6ggqGF55WRk"]')
                          || profile.querySelector('[class*="profile-info-title"] a span span');
              const name = nameEl ? nameEl.textContent.trim() : '';
              
              const badgeEl = profile.querySelector('[class*="dbfbgYbwLHuemBLyfJ4V"]')
                           || profile.querySelector('[class*="text-type-badge"]');
              const badge = badgeEl ? badgeEl.textContent.trim() : '';
              
              const catEl = profile.querySelector('[class*="wf5yhegUPxcbCIBKXgyc"]');
              const category = catEl ? catEl.textContent.trim() : '';
              
              if (name && name !== '네이버 지식iN') {
                const parts = [name];
                if (badge) parts.push('[' + badge + ']');
                if (category) parts.push('(' + category + ')');
                answerer = parts.join(' ');
              }
            }
          }
          
          seenDocs.add(docKey);
          items.push({ url: href, title: title, answerer: answerer || '' });
        }
        
        // kinItem이 없으면 기존 방식 폴백 (a[href] 전체 스캔)
        if (items.length === 0) {
          document.querySelectorAll('a[href]').forEach(link => {
            const href = link.href || '';
            if (!href.includes('kin.naver.com')) return;
            if (!href.includes('/qna/') && !href.includes('detail')) return;
            if (href.includes('search') || href.includes('profileLink')) return;
            
            const cleanHref = href.split('?')[0];
            if (seenDocs.has(cleanHref)) return;
            
            const title = link.textContent.trim().replace(/\s+/g, ' ');
            if (title.length > 5 && title.length < 300) {
              seenDocs.add(cleanHref);
              items.push({ url: href, title: title, answerer: '' });
            }
          });
        }
        
        return items;
      });

      for (const item of searchResults) {
        // 모바일 URL 그대로 유지 (m.kin → kin 변환 제거)
        const url = item.url;
        // docId 추출: docId=N 또는 /docs/N 패턴 모두 지원
        const docIdMatch = url.match(/docId=(\d+)/) || url.match(/\/docs\/(\d+)/);
        const key = docIdMatch ? docIdMatch[1] : url;
        if (!seen.has(key)) {
          seen.add(key);
          allQuestions.push({ url: url, title: item.title, channel: '통합검색', answerer: item.answerer || '' });
          if (item.answerer) {
            console.log(`[kin-search] 답변자 감지: ${item.answerer} — ${item.title.substring(0, 30)}`);
          }
        }
      }

      console.log(`[kin-search] 통합검색 "${keyword}": ${allQuestions.length}건`);
    } catch (e) {
      console.log(`[kin-search] 통합검색 오류: ${e.message}`);
    }
    } // end if ch === 'all' || 'search'

    // ─────────────────────────────────────────
    // 채널 B: 지식인 내부 검색 (최신순)
    // ─────────────────────────────────────────
    if (ch === 'all' || ch === 'latest') {
    try {
      await page.goto(
        `https://m.kin.naver.com/mobile/search/searchList.naver?query=${encodeURIComponent(keyword)}&section=kin&sort=date`,
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );
      await page.waitForTimeout(2000);

      // 스크롤해서 더 많은 결과 로드
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) {
          window.scrollBy(0, 1000);
          await new Promise(r => setTimeout(r, 300));
        }
      });
      await page.waitForTimeout(1000);

      const kinResults = await page.evaluate(() => {
        const items = [];
        // 검색 결과 리스트 항목에서 링크 추출
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href || '';
          // 지식인 질문 상세 페이지 링크만 (/qna/ 또는 detail 포함)
          if (!href.includes('/qna/') && !href.includes('detail')) return;
          if (!href.includes('kin.naver.com')) return;
          // 검색 목록 페이지 제외
          if (href.includes('search') || href.includes('searchList')) return;

          const title = link.textContent.trim().replace(/\s+/g, ' ');

          // 필터: 너무 짧거나, 숫자만이거나, 메뉴 텍스트 제외
          if (title.length < 5 || title.length > 300) return;
          if (/^\d+$/.test(title)) return;
          if (/^(답변|채택|더보기|관련|이전|다음|전체|설정|로그인)/.test(title)) return;
          if (/^(공유|저장|신고|나도궁금|답변하기)/.test(title)) return;

          items.push({ url: href, title: title });
        });
        return items;
      });

      let count = 0;
      for (const item of kinResults) {
        if (count >= max) break;

        let url = item.url;
        if (url.startsWith('/')) url = 'https://m.kin.naver.com' + url;
        // 모바일 URL 그대로 유지

        const docIdMatch = url.match(/docId=(\d+)/) || url.match(/\/docs\/(\d+)/);
        const key = docIdMatch ? docIdMatch[1] : url;

        if (!seen.has(key)) {
          seen.add(key);
          allQuestions.push({ url: url, title: item.title, channel: '최신글', answerer: '' });
          count++;
        }
      }

      console.log(`[kin-search] 최신글 "${keyword}": +${count}건 (총 ${allQuestions.length}건)`);
    } catch (e) {
      console.log(`[kin-search] 최신글 오류: ${e.message}`);
    }
    } // end if ch === 'all' || 'latest'

    await page.close();
    await ctx.close();

    return res.json({
      keyword: keyword,
      totalResults: allQuestions.length,
      questions: allQuestions
    });

  } catch (err) {
    console.error(`[kin-search] 치명적 오류: ${err.message}`);
    return res.status(500).json({ error: err.message, questions: [] });
  }
});


// ============================================================
// POST /kin-detail — 질문 URL에서 제목 + 본문 추출
// ============================================================
// 요청: { "url": "https://kin.naver.com/qna/detail.naver?..." }
// 응답: { "url": "...", "title": "...", "body": "...", "answerCount": N, "success": true }

app.post('/kin-detail', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url 필수' });

  try {
    const browser = await getBrowser();
    const ctx = await createMobileContext(browser);
    const page = await ctx.newPage();

    // 모바일 URL로 변환
    let mobileUrl = url;
    
    // /qna/dirs/NNN/docs/NNN 형태 → 여러 URL 형태를 시도
    // 이 형태는 통합검색에서 수집된 단축 URL
    const dirsMatch = url.match(/\/qna\/dirs\/(\d+)\/docs\/(\d+)/);
    const dirId = dirsMatch ? dirsMatch[1] : null;
    const docId = dirsMatch ? dirsMatch[2] : null;
    
    if (dirsMatch) {
      // URL이 이미 m.kin.naver.com이면 그대로, 아니면 모바일로 변환
      if (url.includes('m.kin.naver.com')) {
        mobileUrl = url; // 이미 모바일 URL
      } else {
        mobileUrl = `https://m.kin.naver.com/qna/dirs/${dirId}/docs/${docId}`;
      }
      console.log(`[kin-detail] dirs URL: ${mobileUrl}`);
    } else {
      if (!url.includes('m.kin.naver.com')) {
        mobileUrl = mobileUrl
          .replace('kin.naver.com', 'm.kin.naver.com')
          .replace('m.m.kin', 'm.kin');
      }
    }

    // 페이지 이동 (리다이렉트 따라감)
    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // 리다이렉트 후 최종 URL 확인 (에러 페이지 감지)
    let finalTitle = await page.title();
    
    // "페이지를 찾을 수 없습니다" 감지 → 대안 URL 시도
    if (finalTitle.includes('찾을 수 없') || finalTitle.includes('오류') || finalTitle.includes('Error')) {
      if (dirId && docId) {
        // 시도 2: detail.naver 형태
        const altUrl = `https://m.kin.naver.com/qna/detail.naver?d1id=${dirId}&docId=${docId}`;
        console.log(`[kin-detail] 시도 2: ${altUrl}`);
        await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        finalTitle = await page.title();
      }
    }
    
    // 여전히 실패 → 시도 3: PC URL로
    if (finalTitle.includes('찾을 수 없') || finalTitle.includes('오류') || finalTitle.includes('Error')) {
      if (dirId && docId) {
        const pcUrl = `https://kin.naver.com/qna/detail.naver?d1id=${dirId}&docId=${docId}`;
        console.log(`[kin-detail] 시도 3 (PC): ${pcUrl}`);
        await page.goto(pcUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
      } else {
        const pcUrl = url.replace('m.kin.naver.com', 'kin.naver.com');
        console.log(`[kin-detail] PC URL 재시도: ${pcUrl}`);
        await page.goto(pcUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
      }
    }

    // ── 디버그: 페이지 HTML 구조 로깅 ──
    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[kin-detail] 페이지 로드 완료: ${pageUrl} / title: ${pageTitle}`);

    const result = await page.evaluate(() => {
      let title = '';
      let body = '';
      let answerCount = 0;
      const debug = { titleMethod: '', bodyMethod: '' };

      // ═════ 제목 추출 ═════
      // 실제 구조: div.EndTitle_endTitle__9e1qr 안에 제목 텍스트
      const titleSelectors = [
        // 2026년 모바일 지식인 실제 구조 (확인됨)
        '[class*="EndTitle_endTitle"]',
        '[class*="endTitle"]',
        // 폴백
        '#questionArea [class*="title"]:not([class*="Tag"])',
        '.question_title .title',
        '.c-heading__title',
        'h3.title',
        'h2.title',
      ];

      for (const sel of titleSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const t = el.textContent.trim().replace(/\s+/g, ' ');
            if (t.length > 3 && t.length < 300) {
              title = t;
              debug.titleMethod = sel;
              break;
            }
          }
        } catch (e) {}
      }

      // title 태그 폴백
      if (!title) {
        title = (document.title || '').trim();
        debug.titleMethod = 'document.title';
      }

      // 제목에서 ": 네이버 지식iN" 등 제거
      title = title
        .replace(/\s*:\s*네이버\s*지식iN.*$/i, '')
        .replace(/\s*-\s*네이버\s*지식iN.*$/i, '')
        .replace(/\s*:\s*지식iN.*$/i, '')
        .replace(/\s*-\s*지식iN.*$/i, '')
        .trim();

      // ═════ 질문 본문 추출 ═════
      // 실제 구조: div.QnaEnd_questionDetail__2v8FM 안에 본문
      // 질문 영역: div#questionArea (class: QnaEnd_contentArea__b_Unt QnaEnd_questionArea__w6RgZ)
      // 답변 영역: div.QnaEnd_endAnswerArea__jhIPr (이것 밖에서만 추출)

      const bodySelectors = [
        // 2026년 모바일 지식인 실제 구조 (확인됨)
        '[class*="questionDetail"]',
        '[class*="QnaEnd_questionDetail"]',
        // questionArea 안의 본문 영역
        '#questionArea [class*="questionDetail"]',
        '#questionArea [class*="Detail"]',
        // 폴백
        '.question_area .c-heading__content',
        '.c-heading__content',
        '.endContents',
        '._questionContentsArea',
      ];

      for (const sel of bodySelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // 답변 영역 안에 있는지 확인
            let isInAnswer = false;
            let parent = el.parentElement;
            while (parent) {
              const cls = (parent.className || '').toString();
              const id = (parent.id || '');
              if (/[Aa]nswer/.test(cls) || /[Aa]nswer/.test(id)) { isInAnswer = true; break; }
              parent = parent.parentElement;
            }
            if (isInAnswer) continue;

            const t = el.textContent.trim().replace(/\s+/g, ' ');
            if (t.length > 15) {
              body = t.substring(0, 3000);
              debug.bodyMethod = sel;
              break;
            }
          }
          if (body) break;
        } catch (e) {}
      }

      // questionArea 전체에서 본문 추출 (위에서 못 찾은 경우)
      if (!body || body.length < 15) {
        const qArea = document.querySelector('#questionArea, [class*="questionArea"]');
        if (qArea) {
          // questionArea 안에서 UserInfo, EndTitle, TagList 영역을 제외한 나머지
          const allText = qArea.innerText || '';
          
          // 제목 부분 제거
          let cleaned = allText;
          if (title) {
            const tIdx = cleaned.indexOf(title);
            if (tIdx >= 0) {
              cleaned = cleaned.substring(tIdx + title.length);
            }
          }
          
          // 줄 단위로 정리, 메타 정보 제거
          const lines = cleaned.split('\n')
            .map(l => l.trim())
            .filter(l => {
              if (l.length < 5) return false;
              // 메타 정보 필터링
              if (/^(지식iN|서비스|트렌드|조회수|조회 수|비공개|작성일|Q&A)/.test(l)) return false;
              if (/^\d{4}\.\d{2}\.\d{2}/.test(l)) return false; // 날짜
              if (/^#/.test(l)) return false; // 해시태그
              if (/^(나도 궁금|공유|댓글|좋아요|답변|채택|네트워크|관리)/.test(l)) return false;
              if (/^(정보를 공유|답변하기|답변 등록)/.test(l)) return false;
              return true;
            });

          if (lines.length > 0) {
            body = lines.join(' ').substring(0, 3000);
            debug.bodyMethod = 'questionArea innerText cleanup';
          }
        }
      }

      // ═════ 답변 수 추출 ═════
      // 실제 구조: "답변 3개" 텍스트
      try {
        // 방법 1: "답변 N개" 패턴 매칭
        const fullText = document.body.innerText || '';
        const ansMatch = fullText.match(/답변\s*(\d+)\s*개/);
        if (ansMatch) answerCount = parseInt(ansMatch[1]);
        
        // 방법 2: "N개 답변" 패턴
        if (answerCount === 0) {
          const ansMatch2 = fullText.match(/(\d+)\s*개\s*답변/);
          if (ansMatch2) answerCount = parseInt(ansMatch2[1]);
        }

        // 방법 3: endAnswerArea 관련 셀렉터
        if (answerCount === 0) {
          const ansEl = document.querySelector('[class*="endAnswerArea"], [class*="answer_count"], .answer_count');
          if (ansEl) {
            const m = ansEl.textContent.match(/(\d+)/);
            if (m) answerCount = parseInt(m[1]);
          }
        }
      } catch (e) {}

      return { title, body, answerCount, debug };
    });

    await page.close();
    await ctx.close();

    const success = !!(result.title && result.title.length > 3 && result.body && result.body.length > 10);

    console.log(`[kin-detail] ${success ? '✅' : '❌'} ${(result.title || '').substring(0, 40)} (본문 ${(result.body || '').length}자, 답변 ${result.answerCount}개)`);
    console.log(`[kin-detail] 추출방법 - 제목: ${result.debug?.titleMethod || 'none'}, 본문: ${result.debug?.bodyMethod || 'none'}`);
    if (!success) {
      console.log(`[kin-detail] 페이지 클래스: ${(result.debug?.allClasses || []).join(', ')}`);
    }

    return res.json({
      url: url,
      title: result.title || '(추출 실패)',
      body: result.body || '(추출 실패)',
      answerCount: result.answerCount || 0,
      success: success
    });

  } catch (err) {
    console.error(`[kin-detail] 오류: ${err.message}`);
    return res.status(500).json({
      url: url,
      title: '(서버 오류)',
      body: '(서버 오류)',
      answerCount: 0,
      success: false,
      error: err.message
    });
  }
});


// ============================================================
// GET /health — 서버 상태 확인
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0',
    service: 'kin-scraper',
    uptime: Math.round(process.uptime()) + '초'
  });
});


// ============================================================
// 서버 시작
// ============================================================
app.listen(PORT, () => {
  console.log(`kin-scraper v1.0: 포트 ${PORT} 에서 실행 중`);
});
