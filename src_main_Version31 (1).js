// Broken link & SEO Auditor scraper (Cheerio + optional Playwright)
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://example.com'],
  maxRequestsPerCrawl = 1000,
  useBrowser = false,
  followInternalOnly = true,
  checkExternalLinks = false,
  concurrency = 10,
  requestTimeoutSecs = 30,
} = input;

// Helper: resolve absolute URL
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

// Link checker: does a simple HEAD then GET fallback to capture status and final URL.
// Note: external link checking can be slow; respect robots and rate limits in production.
async function checkLink(targetUrl, opts = {}) {
  const { timeout = 30000 } = opts;
  const result = {
    url: targetUrl,
    final_url: targetUrl,
    status: null,
    redirect_chain: [],
    error: null,
  };
  try {
    // Try HEAD first (some servers block HEAD); follow redirects
    const headRes = await fetch(targetUrl, { method: 'HEAD', redirect: 'follow', timeout });
    result.status = headRes.status;
    result.final_url = headRes.url || targetUrl;
    // Note: fetch doesn't expose full redirect chain in node fetch - we record original and final
    if (headRes.status >= 400) {
      // fallback to GET to attempt to get status / more info
      const getRes = await fetch(targetUrl, { method: 'GET', redirect: 'follow', timeout });
      result.status = getRes.status;
      result.final_url = getRes.url || result.final_url;
    }
  } catch (err) {
    // Some hosts block HEAD or requests; attempt GET
    try {
      const getRes = await fetch(targetUrl, { method: 'GET', redirect: 'follow', timeout });
      result.status = getRes.status;
      result.final_url = getRes.url || result.final_url;
    } catch (e) {
      result.error = e.message;
      result.status = null;
    }
  }
  // Determine redirect chain: if final_url differs, store both
  if (result.final_url && result.final_url !== targetUrl) {
    result.redirect_chain = [targetUrl, result.final_url];
  } else {
    result.redirect_chain = [targetUrl];
  }
  return result;
}

// SEO heuristics
function analyzeSeo($, url) {
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1 = $('h1').first().text().trim();
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const robots = $('meta[name="robots"]').attr('content') || '';
  // images with missing alt
  const imagesMissingAlt = $('img').filter((i, el) => !$(el).attr('alt') || $(el).attr('alt').trim() === '').length;
  return {
    title,
    metaDescription,
    h1,
    canonical,
    robots,
    imagesMissingAlt,
  };
}

// Storage
const dataset = await Dataset.open();
const kv = await KeyValueStore.open();

// Common enqueue options
function makeEnqueueOptions(request) {
  return {
    globs: ['**/*'],
    transformRequestFunction: (r) => {
      if (followInternalOnly) {
        try {
          const startHost = request.userData.startHost || new URL(request.url).host;
          if (new URL(r.url).host !== startHost) return null;
        } catch (e) {
          return null;
        }
      }
      return r;
    },
    userData: { startHost: request.userData.startHost || (new URL(request.url).host) },
  };
}

const proxyConfiguration = await Actor.createProxyConfiguration();

if (!useBrowser) {
  // Cheerio (fast) mode
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    requestHandlerTimeoutSecs: requestTimeoutSecs,
    async requestHandler({ request, $, enqueueLinks, log }) {
      const url = request.loadedUrl ?? request.url;
      log.info('Processing (cheerio)', { url });

      // Enqueue internal links for crawling (site scan)
      await enqueueLinks(makeEnqueueOptions(request));

      // Basic HTTP status: we can rely on response already being 200 for CheerioCrawler's successful pages,
      // but we may want to perform an explicit status check for the current URL:
      let status = null;
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow' });
        status = res.status;
      } catch (e) {
        status = null;
      }

      // Extract SEO signals
      const seo = analyzeSeo($, url);
      const internalLinks = [];
      const externalLinks = [];
      // collect links on page
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const abs = resolveUrl(url, href);
        if (!abs) return;
        try {
          const host = new URL(abs).host;
          const startHost = request.userData.startHost || new URL(url).host;
          if (host === startHost) internalLinks.push(abs);
          else externalLinks.push(abs);
        } catch (e) {
          externalLinks.push(abs);
        }
      });

      const linkChecks = [];
      // Only check external links if requested (to limit request budget)
      if (checkExternalLinks) {
        for (const l of externalLinks.slice(0, 200)) { // limit checks per page to 200
          linkChecks.push(checkLink(l, { timeout: requestTimeoutSecs * 1000 }));
        }
      }

      // Always check internal links' status (a subset) to find broken pages inside site
      const internalCheckPromises = [];
      for (const l of internalLinks.slice(0, 200)) {
        internalCheckPromises.push(checkLink(l, { timeout: requestTimeoutSecs * 1000 }));
      }

      const externalResults = await Promise.allSettled(linkChecks);
      const internalResults = await Promise.allSettled(internalCheckPromises);

      const externalSummary = externalResults.map((r) => (r.status === 'fulfilled' ? r.value : { url: '', status: null, error: r.reason?.message || String(r.reason) }));
      const internalSummary = internalResults.map((r) => (r.status === 'fulfilled' ? r.value : { url: '', status: null, error: r.reason?.message || String(r.reason) }));

      // Determine broken status for page: if the page itself returned an error or has heavy issues
      const broken = !status || (status >= 400 && status !== 401 && status !== 403);
      const brokenReason = broken ? `HTTP ${status || 'NO_RESPONSE'}` : '';

      // Count images without alt
      const imagesMissingAltCount = seo.imagesMissingAlt;

      // Save page-level record
      const record = {
        url,
        status_code: status,
        final_url: url,
        redirect_chain: [],
        broken,
        broken_reason: brokenReason,
        title: seo.title || '',
        meta_description: seo.metaDescription || '',
        h1: seo.h1 || '',
        canonical: seo.canonical || '',
        robots_noindex: /noindex/i.test(seo.robots || '') ? true : false,
        images_missing_alt_count: imagesMissingAltCount || 0,
        internal_links_count: internalLinks.length,
        external_links_count: externalLinks.length,
        external_link_checks: externalSummary.slice(0, 50),
        internal_link_checks: internalSummary.slice(0, 50),
        load_time_ms: null,
        extracted_at: new Date().toISOString(),
      };

      await dataset.pushData(record);

      // Optionally store full link lists (by canonicalized key) to Key-Value Store for later inspection
      try {
        await kv.setValue(`links/${encodeURIComponent(url)}`, { internalLinks, externalLinks }, { contentType: 'application/json' });
      } catch (e) {
        log.warning('Failed to save link lists to KV', { url, error: e.message });
      }
    },
  });

  // Prepare start requests with host info
  const startRequests = (startUrls || []).map((u) => {
    try {
      const parsed = new URL(u);
      return { url: u, userData: { startHost: parsed.host } };
    } catch (e) {
      return { url: u, userData: {} };
    }
  });

  await crawler.run(startRequests);
} else {
  // Playwright (browser) mode — renders JS and measures load times
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    maxRequestsPerCrawl,
    requestHandlerTimeoutSecs: requestTimeoutSecs,
    async requestHandler({ page, request, enqueueLinks, log }) {
      const url = request.loadedUrl ?? request.url;
      log.info('Processing (playwright)', { url });

      const start = Date.now();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: requestTimeoutSecs * 1000 }).catch(() => {});
      } catch (e) {
        // navigation error
      }
      const end = Date.now();
      const loadTime = end - start;

      // Enqueue internal links
      await enqueueLinks(makeEnqueueOptions(request));

      // Collect DOM and SEO signals from rendered page
      const title = (await page.title().catch(() => '')) || '';
      const metaDescription = await page.locator('meta[name="description"]').first().getAttribute('content').catch(() => '') || '';
      const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim() || '';
      const canonical = await page.locator('link[rel="canonical"]').first().getAttribute('href').catch(() => '') || '';
      const robots = await page.locator('meta[name="robots"]').first().getAttribute('content').catch(() => '') || '';
      const imagesMissingAltCount = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.alt || i.alt.trim() === '').length).catch(() => 0);

      const anchors = await page.$$eval('a[href]', (els) => els.map((a) => a.getAttribute('href')));
      const internalLinks = [];
      const externalLinks = [];
      for (const href of anchors) {
        const abs = resolveUrl(url, href);
        if (!abs) continue;
        try {
          const host = new URL(abs).host;
          const startHost = request.userData.startHost || new URL(url).host;
          if (host === startHost) internalLinks.push(abs);
          else externalLinks.push(abs);
        } catch (e) {
          externalLinks.push(abs);
        }
      }

      const internalCheckPromises = [];
      for (const l of internalLinks.slice(0, 200)) internalCheckPromises.push(checkLink(l, { timeout: requestTimeoutSecs * 1000 }));
      const externalCheckPromises = checkExternalLinks ? externalLinks.slice(0, 200).map((l) => checkLink(l, { timeout: requestTimeoutSecs * 1000 })) : [];

      const internalResults = await Promise.allSettled(internalCheckPromises);
      const externalResults = await Promise.allSettled(externalCheckPromises);

      const internalSummary = internalResults.map((r) => (r.status === 'fulfilled' ? r.value : { url: '', status: null, error: r.reason?.message || String(r.reason) }));
      const externalSummary = externalResults.map((r) => (r.status === 'fulfilled' ? r.value : { url: '', status: null, error: r.reason?.message || String(r.reason) }));

      // Page HTTP status: attempt one fetch
      let status = null;
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow' });
        status = res.status;
      } catch (e) {
        status = null;
      }

      const broken = !status || (status >= 400 && status !== 401 && status !== 403);
      const brokenReason = broken ? `HTTP ${status || 'NO_RESPONSE'}` : '';

      const record = {
        url,
        status_code: status,
        final_url: url,
        redirect_chain: [],
        broken,
        broken_reason: brokenReason,
        title,
        meta_description: metaDescription,
        h1,
        canonical,
        robots_noindex: /noindex/i.test(robots || '') ? true : false,
        images_missing_alt_count: imagesMissingAltCount || 0,
        internal_links_count: internalLinks.length,
        external_links_count: externalLinks.length,
        internal_link_checks: internalSummary.slice(0, 50),
        external_link_checks: externalSummary.slice(0, 50),
        load_time_ms: loadTime,
        extracted_at: new Date().toISOString(),
      };

      await dataset.pushData(record);
      try {
        await kv.setValue(`links/${encodeURIComponent(url)}`, { internalLinks, externalLinks }, { contentType: 'application/json' });
      } catch (e) {
        log.warning('Failed to save link lists to KV', { url, error: e.message });
      }
    },
  });

  const startRequests = (startUrls || []).map((u) => {
    try {
      const parsed = new URL(u);
      return { url: u, userData: { startHost: parsed.host } };
    } catch (e) {
      return { url: u, userData: {} };
    }
  });

  await crawler.run(startRequests);
}

await Actor.exit();