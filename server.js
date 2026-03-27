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

      // 스크롤해서 지식인 영역 로드
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) {
          window.scrollBy(0, 1500);
          await new Promise(r => setTimeout(r, 400));
        }
      });
      await page.waitForTimeout(1000);

      // 지식인 링크 추출
      const searchResults = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href || '';
          if (!href.includes('kin.naver.com')) return;
          if (!href.includes('detail')) return;

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
        const docIdMatch = url.match(/docId=(\d+)/);
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
          // 지식인 질문 상세 페이지 링크만
          if (!href.includes('detail')) return;
          if (!href.includes('kin.naver.com') && !href.includes('/qna/')) return;

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

        const docIdMatch = url.match(/docId=(\d+)/);
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
    let mobileUrl = url
      .replace('kin.naver.com', 'm.kin.naver.com')
      .replace('m.m.kin', 'm.kin');

    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      let title = '';
      let body = '';
      let answerCount = 0;

      // ───── 제목 추출 ─────
      const titleSelectors = [
        '.question_title .title',
        '.c-heading__title',
        '.question_area .title',
        'h3.title',
        '.endTitleSection h3',
        'h2.title',
        '.questionTitleArea .title',
      ];

      for (const sel of titleSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const t = el.textContent.trim().replace(/\s+/g, ' ');
            if (t.length > 3 && t.length < 300) { title = t; break; }
          }
        } catch (e) {}
      }

      // title 태그 폴백
      if (!title) {
        title = (document.title || '')
          .replace(/\s*:\s*지식iN.*$/, '')
          .replace(/\s*-\s*지식iN.*$/, '')
          .trim();
      }

      // ───── 질문 본문 추출 (답변 영역 제외) ─────
      const bodySelectors = [
        '.question_area .c-heading__content',
        '.c-heading__content',
        '.question_content',
        '.endContents',
        '.c-heading__body',
        '.question_area .content',
        '._questionContentsArea',
        '.questionDetailArea .content',
      ];

      for (const sel of bodySelectors) {
        try {
          const el = document.querySelector(sel);
          if (!el) continue;

          // 답변 영역 안에 있는지 확인
          let isInAnswer = false;
          let parent = el.parentElement;
          while (parent) {
            const cls = (parent.className || '').toString().toLowerCase();
            if (/answer|reply_area|answerArea/.test(cls)) { isInAnswer = true; break; }
            const id = (parent.id || '').toLowerCase();
            if (/answer/.test(id)) { isInAnswer = true; break; }
            parent = parent.parentElement;
          }

          if (!isInAnswer) {
            const t = el.textContent.trim().replace(/\s+/g, ' ');
            if (t.length > 10) { body = t.substring(0, 3000); break; }
          }
        } catch (e) {}
      }

      // 질문 영역 내 p태그 모아서 시도
      if (!body || body.length < 10) {
        const qArea = document.querySelector('.question_area, .endSection, .c-heading, .questionDetailArea');
        if (qArea) {
          const pTexts = [];
          qArea.querySelectorAll('p, span.txt').forEach(el => {
            // 답변 영역 제외
            let inAnswer = false;
            let p = el.parentElement;
            while (p) {
              const cls = (p.className || '').toString().toLowerCase();
              if (/answer|reply/.test(cls)) { inAnswer = true; break; }
              p = p.parentElement;
            }
            if (!inAnswer) {
              const t = el.textContent.trim();
              if (t.length > 10) pTexts.push(t);
            }
          });
          if (pTexts.length > 0) body = pTexts.join(' ').substring(0, 3000);
        }
      }

      // 최후의 수단: 페이지 텍스트에서 "답변" 앞부분만 추출
      if (!body || body.length < 10) {
        const fullText = document.body.innerText || '';
        // "개 답변" 또는 "답변하기" 앞까지만 자르기
        const cutMarkers = ['개 답변', '답변하기', '답변 작성'];
        let cutIdx = fullText.length;
        for (const marker of cutMarkers) {
          const idx = fullText.indexOf(marker);
          if (idx > 50 && idx < cutIdx) cutIdx = idx;
        }
        const questionPart = fullText.substring(0, cutIdx);

        // 제목 이후부터 추출
        if (title) {
          const titleIdx = questionPart.indexOf(title);
          if (titleIdx >= 0) {
            const afterTitle = questionPart.substring(titleIdx + title.length).trim();
            // 불필요한 메타 정보 건너뛰기 (조회수, 작성일 등)
            const lines = afterTitle.split('\n').filter(l => l.trim().length > 15);
            if (lines.length > 0) {
              body = lines.join(' ').substring(0, 3000);
            }
          }
        }
      }

      // ───── 답변 수 추출 ─────
      try {
        const ansEl = document.querySelector('.answer_count, .c-heading-answer__count');
        if (ansEl) {
          const m = ansEl.textContent.match(/(\d+)/);
          if (m) answerCount = parseInt(m[1]);
        }
        if (answerCount === 0) {
          const m = (document.body.textContent || '').match(/(\d+)\s*개\s*답변/);
          if (m) answerCount = parseInt(m[1]);
        }
      } catch (e) {}

      return { title, body, answerCount };
    });

    await page.close();
    await ctx.close();

    const success = !!(result.title && result.title.length > 3 && result.body && result.body.length > 10);

    console.log(`[kin-detail] ${success ? '✅' : '❌'} ${(result.title || '').substring(0, 40)} (본문 ${(result.body || '').length}자, 답변 ${result.answerCount}개)`);

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
