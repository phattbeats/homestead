const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/node/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // Bootstrap a tiny local server that serves README.md as HTML
  const README_PATH = '/root/.openclaw/workspace/projects/homestead/README.md';
  const GLOSSARY_PATH = '/root/.openclaw/workspace/projects/homestead/docs/GLOSSARY.md';
  const fs = require('fs');
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const glossary = fs.readFileSync(GLOSSARY_PATH, 'utf8');
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/README.html') {
      // Tiny markdown-ish render via marked? Just render raw HTML-safe with line breaks and convert md links to <a>.
      const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      // Very simple: paragraph split + convert [text](href) to <a>
      let html = esc(readme);
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
      html = html.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g,'<br>')}</p>`).join('\n');
      res.setHeader('Content-Type','text/html');
      res.end(`<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font:16px -apple-system,sans-serif;padding:16px;color:#222}a{color:#0066cc}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}h1,h2{margin:18px 0 8px}</style></head><body>${html}</body></html>`);
    } else if (req.url.startsWith('/docs/GLOSSARY.md')) {
      res.setHeader('Content-Type','text/markdown');
      res.end(glossary);
    } else {
      res.statusCode = 404; res.end('404');
    }
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  // Scroll to "Glossary" section and screenshot
  const link = await page.locator('a:has-text("glossary")').first();
  await link.scrollIntoViewIfNeeded();
  const box = await link.boundingBox();
  console.log('LINK_BOX', JSON.stringify(box));
  // Full-page screenshot, then a tight screenshot around the Glossary section
  await page.screenshot({ path: '/root/.openclaw/workspace/projects/homestead/verify-out/glossary-link-rendered-390.png', fullPage: false });
  // Also navigate to the glossary via the link to prove it lands
  await link.click();
  await page.waitForLoadState('load');
  // When we land on .md the browser will render as text. Screenshot anyway.
  await page.screenshot({ path: '/root/.openclaw/workspace/projects/homestead/verify-out/glossary-link-target-390.png', fullPage: false });
  console.log('OK');
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
