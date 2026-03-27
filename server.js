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
  const { keyword, maxResults } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword 필수' });

  const max = maxResults || 10;

  try {
    const browser = await getBrowser();
    const ctx = await createMobileContext(browser);
    const page = await ctx.newPage();
    const allQuestions = [];
    const seen = new Set();

    // ─────────────────────────────────────────
    // 채널 A: 네이버 통합검색 → 지식인 영역
    // ─────────────────────────────────────────
    try {
      await page.goto(
        `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );

      // 스크롤해서 지식인 영역 로드 (충분히 내려야 지식인 영역이 나옴)
      await page.evaluate(async () => {
        for (let i = 0; i < 10; i++) {
          window.scrollBy(0, 1500);
          await new Promise(r => setTimeout(r, 400));
        }
      });
      await page.waitForTimeout(1500);

      // 지식인 링크 추출
      const searchResults = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href || '';
          if (!href.includes('kin.naver.com')) return;
          // /qna/dirs/ 패턴 (통합검색) 또는 /detail 패턴 모두 허용
          if (!href.includes('/qna/') && !href.includes('detail')) return;
          // 검색 목록 페이지 제외 (질문 상세 페이지만)
          if (href.includes('search') || href.includes('searchList')) return;
          if (href.includes('directoryDetail')) return;

          // 광고/AI 브리핑 제외
          let isAd = false;
          let parent = link;
          while (parent && parent !== document.body) {
            const cls = (parent.className || '').toString().toLowerCase();
            if (/ad_area|sp_nad|sponsored|power_link/.test(cls)) { isAd = true; break; }
            parent = parent.parentElement;
          }
          if (isAd) return;

          const title = link.textContent.trim().replace(/\s+/g, ' ');
          if (title.length > 5 && title.length < 300) {
            items.push({ url: href, title: title });
          }
        });
        return items;
      });

      for (const item of searchResults) {
        const url = item.url.replace('m.kin.naver.com', 'kin.naver.com');
        // docId 추출: docId=N 또는 /docs/N 패턴 모두 지원
        const docIdMatch = url.match(/docId=(\d+)/) || url.match(/\/docs\/(\d+)/);
        const key = docIdMatch ? docIdMatch[1] : url;
        if (!seen.has(key)) {
          seen.add(key);
          allQuestions.push({ url: url, title: item.title, channel: '통합검색' });
        }
      }

      console.log(`[kin-search] 통합검색 "${keyword}": ${allQuestions.length}건`);
    } catch (e) {
      console.log(`[kin-search] 통합검색 오류: ${e.message}`);
    }

    // ─────────────────────────────────────────
    // 채널 B: 지식인 내부 검색 (최신순)
    // ─────────────────────────────────────────
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
        url = url.replace('m.kin.naver.com', 'kin.naver.com');

        const docIdMatch = url.match(/docId=(\d+)/) || url.match(/\/docs\/(\d+)/);
        const key = docIdMatch ? docIdMatch[1] : url;

        if (!seen.has(key)) {
          seen.add(key);
          allQuestions.push({ url: url, title: item.title, channel: '최신글' });
          count++;
        }
      }

      console.log(`[kin-search] 최신글 "${keyword}": +${count}건 (총 ${allQuestions.length}건)`);
    } catch (e) {
      console.log(`[kin-search] 최신글 오류: ${e.message}`);
    }

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
    
    // /qna/dirs/NNN/docs/NNN 형태 → 정규 모바일 URL로 변환
    // 이 형태는 통합검색에서 수집된 단축 URL (PC에서 직접 접속 불가)
    const dirsMatch = url.match(/\/qna\/dirs\/(\d+)\/docs\/(\d+)/);
    if (dirsMatch) {
      const dirId = dirsMatch[1];
      const docId = dirsMatch[2];
      mobileUrl = `https://m.kin.naver.com/mobile/qna/detail.naver?dirId=${dirId}&docId=${docId}`;
      console.log(`[kin-detail] dirs URL 변환: ${url} → ${mobileUrl}`);
    } else {
      mobileUrl = mobileUrl
        .replace('kin.naver.com', 'm.kin.naver.com')
        .replace('m.m.kin', 'm.kin');
    }

    // 페이지 이동 (리다이렉트 따라감)
    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // 리다이렉트 후 최종 URL 확인 (에러 페이지 감지)
    const finalUrl = page.url();
    const finalTitle = await page.title();
    
    // "페이지를 찾을 수 없습니다" 감지
    if (finalTitle.includes('찾을 수 없') || finalTitle.includes('오류') || finalTitle.includes('Error')) {
      // 모바일 URL이 안 되면 PC URL로 재시도
      let pcUrl = url.replace('m.kin.naver.com', 'kin.naver.com');
      console.log(`[kin-detail] 모바일 URL 실패, PC URL로 재시도: ${pcUrl}`);
      await page.goto(pcUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
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
