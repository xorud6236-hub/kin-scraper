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

    // ── 디버그: 페이지 HTML 구조 로깅 ──
    const pageUrl = page.url();
    const pageTitle = await page.title();
    console.log(`[kin-detail] 페이지 로드 완료: ${pageUrl} / title: ${pageTitle}`);

    const result = await page.evaluate(() => {
      let title = '';
      let body = '';
      let answerCount = 0;
      const debug = { titleMethod: '', bodyMethod: '', allClasses: [] };

      // ── 디버그: 페이지 내 주요 클래스 수집 ──
      const allEls = document.querySelectorAll('div, section, article, h1, h2, h3');
      const classSet = new Set();
      allEls.forEach(el => {
        const cls = (el.className || '').toString().trim();
        if (cls && cls.length < 80) classSet.add(cls);
      });
      debug.allClasses = Array.from(classSet).slice(0, 30);

      // ═════ 제목 추출 (확장된 셀렉터) ═════
      const titleSelectors = [
        // 모바일 지식인 (2024~2026 구조)
        '.question_title .title',
        '.c-heading__title',
        '.question_area .title',
        'h3.title',
        '.endTitleSection h3',
        'h2.title',
        '.questionTitleArea .title',
        // 추가 패턴
        '.qna_title',
        '.question_title',
        '[class*="question"] [class*="title"]',
        '[class*="heading"] [class*="title"]',
        'h2[class*="title"]',
        'h3[class*="title"]',
        '.title_area h2',
        '.title_area h3',
        // 넓은 범위
        'h2',
        'h3',
      ];

      for (const sel of titleSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // 답변/댓글 영역 안의 제목 제외
            let skip = false;
            let p = el.parentElement;
            while (p) {
              const cls = (p.className || '').toString().toLowerCase();
              if (/answer|reply|comment|cmt/.test(cls)) { skip = true; break; }
              p = p.parentElement;
            }
            if (skip) continue;

            const t = el.textContent.trim().replace(/\s+/g, ' ');
            // 너무 짧거나, 메뉴 텍스트거나, 답변 관련이면 스킵
            if (t.length < 5 || t.length > 300) continue;
            if (/^(답변|댓글|관련|추천|더보기|로그인|나도 궁금|질문자 채택)/.test(t)) continue;
            if (/^(조회|작성일|Q&A|지식인)/.test(t)) continue;

            title = t;
            debug.titleMethod = sel;
            break;
          }
          if (title) break;
        } catch (e) {}
      }

      // title 태그 폴백 (": 네이버 지식iN" 제거)
      if (!title) {
        title = (document.title || '')
          .replace(/\s*:\s*네이버\s*지식iN.*$/i, '')
          .replace(/\s*-\s*네이버\s*지식iN.*$/i, '')
          .replace(/\s*:\s*지식iN.*$/i, '')
          .replace(/\s*-\s*지식iN.*$/i, '')
          .replace(/^\s*Q\.\s*/, '')
          .trim();
        debug.titleMethod = 'document.title fallback';
      }
      // 이미 셀렉터에서 가져온 제목에도 ": 네이버 지식iN" 제거 적용
      title = title
        .replace(/\s*:\s*네이버\s*지식iN.*$/i, '')
        .replace(/\s*-\s*네이버\s*지식iN.*$/i, '')
        .replace(/\s*:\s*지식iN.*$/i, '')
        .replace(/\s*-\s*지식iN.*$/i, '')
        .trim();

      // ═════ 질문 본문 추출 (확장된 셀렉터 + 텍스트 컷) ═════
      const bodySelectors = [
        '.question_area .c-heading__content',
        '.c-heading__content',
        '.question_content',
        '.endContents',
        '.c-heading__body',
        '.question_area .content',
        '._questionContentsArea',
        '.questionDetailArea .content',
        // 추가 패턴
        '.qna_contents',
        '.question_text',
        '[class*="question"] [class*="content"]',
        '[class*="question"] [class*="body"]',
        '[class*="heading"] [class*="content"]',
        '.se-main-container',
        '.content_area',
      ];

      for (const sel of bodySelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            // 답변 영역 안에 있는지 확인
            let isInAnswer = false;
            let parent = el.parentElement;
            while (parent) {
              const cls = (parent.className || '').toString().toLowerCase();
              const id = (parent.id || '').toLowerCase();
              if (/answer|reply_area|answerArea/.test(cls) || /answer/.test(id)) { isInAnswer = true; break; }
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

      // 질문 영역 내 p/span/div 태그 모아서 시도
      if (!body || body.length < 15) {
        const qAreaSelectors = ['.question_area', '.endSection', '.c-heading', '.questionDetailArea', '[class*="question"]'];
        for (const qs of qAreaSelectors) {
          const qArea = document.querySelector(qs);
          if (!qArea) continue;

          // 이 영역이 답변 안에 있는지 확인
          let inAns = false;
          let pp = qArea.parentElement;
          while (pp) {
            if (/answer|reply/.test((pp.className || '').toString().toLowerCase())) { inAns = true; break; }
            pp = pp.parentElement;
          }
          if (inAns) continue;

          const texts = [];
          qArea.querySelectorAll('p, span, div').forEach(el => {
            if (el.children.length > 3) return; // 너무 많은 자식 = 컨테이너
            const t = el.textContent.trim();
            if (t.length > 15 && t.length < 2000 && !/^(답변|댓글|좋아요|조회수|작성일|나도 궁금|공유|신고)/.test(t)) {
              texts.push(t);
            }
          });
          if (texts.length > 0) {
            body = texts.join(' ').substring(0, 3000);
            debug.bodyMethod = qs + ' > p/span/div';
            break;
          }
        }
      }

      // ═════ 최후의 수단: innerText에서 답변 앞부분만 추출 ═════
      if (!body || body.length < 15) {
        const fullText = document.body.innerText || '';

        // "N개 답변", "답변하기", "답변 작성", "답변등록" 앞까지만 자르기
        const cutMarkers = ['개 답변', '답변하기', '답변 작성', '답변등록', '답변 등록', '정보를 공유해 주세요'];
        let cutIdx = fullText.length;
        for (const marker of cutMarkers) {
          const idx = fullText.indexOf(marker);
          if (idx > 30 && idx < cutIdx) cutIdx = idx;
        }
        let questionPart = fullText.substring(0, cutIdx);

        // 제목 찾기 (부분 매칭도 허용)
        let titleIdx = -1;
        if (title && title.length > 5) {
          // 정확한 매칭 시도
          titleIdx = questionPart.indexOf(title);
          // 부분 매칭 (제목 앞 10자로)
          if (titleIdx < 0) {
            const partial = title.substring(0, Math.min(15, title.length));
            titleIdx = questionPart.indexOf(partial);
          }
        }

        if (titleIdx >= 0) {
          const afterTitle = questionPart.substring(titleIdx + title.length);
          // 줄 단위로 분리, 메타 정보 스킵
          const lines = afterTitle.split('\n')
            .map(l => l.trim())
            .filter(l => {
              if (l.length < 10) return false;
              if (/^(조회수|작성일|비공개|프로필|지식iN|서비스|트렌드|#|나도 궁금|Q&A|네트워크)/.test(l)) return false;
              if (/^(공유|댓글|좋아요|답변|채택)/.test(l)) return false;
              return true;
            });
          if (lines.length > 0) {
            body = lines.join(' ').substring(0, 3000);
            debug.bodyMethod = 'innerText cut (title match)';
          }
        }

        // 제목 매칭도 실패하면 메타 정보 이후 첫 긴 텍스트 블록
        if (!body || body.length < 15) {
          const lines = questionPart.split('\n').map(l => l.trim()).filter(l => l.length > 20);
          // 처음 몇 줄은 메뉴/메타이므로 스킵, 실질적인 질문 본문 찾기
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^(조회수|작성일|비공개|프로필|지식iN|서비스|#|나도|Q&A|네트워크|공유)/.test(line)) continue;
            if (line.includes('지식인') && line.length < 30) continue;
            // 이 줄이 질문 본문의 시작일 가능성이 높음
            body = lines.slice(i).join(' ').substring(0, 3000);
            debug.bodyMethod = 'innerText scan (line ' + i + ')';
            break;
          }
        }
      }

      // ═════ 답변 수 추출 ═════
      try {
        const ansEl = document.querySelector('.answer_count, .c-heading-answer__count, [class*="answer_count"]');
        if (ansEl) {
          const m = ansEl.textContent.match(/(\d+)/);
          if (m) answerCount = parseInt(m[1]);
        }
        if (answerCount === 0) {
          const m = (document.body.textContent || '').match(/(\d+)\s*개\s*답변/);
          if (m) answerCount = parseInt(m[1]);
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
