## What are Apify Actors?

- Actors are serverless cloud programs packaged as Docker images that accept JSON input, perform an action, and produce structured JSON output.

Broken link & SEO Auditor scraper notes
- This Actor crawls a site (CheerioCrawler by default) and audits pages for:
  - broken links / HTTP status codes and (optionally) external link checks
  - redirect chains and final URLs
  - on-page SEO signals: title, meta description, H1, canonical tag, robots noindex
  - missing image alt attributes
  - internal / external link counts
  - simple load time measurement in Playwright mode
- Use `useBrowser=true` for JS-heavy sites (slower but more accurate). Default Cheerio mode is much faster for static sites.
- External link checks can dramatically increase request volume and runtime — enable only when required.
- Respect robots.txt and Terms of Service; add rate-limiting and proxies for production runs.
- For large sites, consider incremental crawling (store last-seen checks in Key-Value store) and scanning via sitemap-based inputs.

Quick local setup and exact commands (copy/paste)
1) Create directory and open it
- mkdir broken-link-seo-auditor-scraper
- cd broken-link-seo-auditor-scraper

2) Create files
- Paste the file contents shown above into the corresponding paths (.actor/*, src/main.js, package.json, Dockerfile, AGENTS.md).

3) Install dependencies
- npm install

4) Run the Actor locally
- apify run

5) Log in to the Apify platform
- apify login

6) Push the Actor to Apify platform
- apify push

Recommended next improvements (pick one)
- Add a sitemap-driven mode that only audits URLs discovered in sitemaps (efficient for large sites).
- Implement incremental mode: store previous audit results in Key-Value store and only recheck changed pages.
- Add more SEO rules (duplicate titles across pages, hreflang validation, structured data/JSON-LD checks).
- Add report generation (CSV export, aggregated failure counts, categories of SEO issues).
- Add better redirect-chain capture (use Playwright network events or a proxy to capture full chain).

Which next improvement would you like me to implement now?