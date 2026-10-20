
const robotsParser = require("robots-parser");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const INDEX_FILE = path.join(__dirname, "../data/index.json");
const robotsCache = new Map();

const MAX_PAGES = 10;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 100000;

async function canCrawl(url) {
  const target = new URL(url);
  const origin = target.origin;

  if (!robotsCache.has(origin)) {
    const robotsUrl = `${origin}/robots.txt`;
    let policy;

    try {
      const response = await fetch(robotsUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "INDEXSearchBot/0.1" }
      });

      if (response.status === 404) {
        policy = robotsParser(robotsUrl, "");
      } else if (response.ok) {
        const text = await response.text();
        policy = robotsParser(robotsUrl, text);
      } else {
        return false;
      }
    } catch {
      return false;
    }

    robotsCache.set(origin, policy);
  }

  return robotsCache.get(origin).isAllowed(
    url,
    "INDEXSearchBot"
  ) !== false;
}

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();

    if (
      value.startsWith("::") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value === "::1"
    ) {
      return false;
    }

    return value.startsWith("2") || value.startsWith("3");
  }

  return false;
}

async function validatePublicUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Provide a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  const host = url.hostname.toLowerCase();

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Private hostnames are not allowed.");
  }

  if (net.isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new Error("Private IP addresses are not allowed.");
    }

    return url;
  }

  let addresses;

  try {
    addresses = await dns.lookup(host, {
      all: true,
      verbatim: true
    });
  } catch {
    throw new Error("The hostname could not be resolved.");
  }

  if (
    !addresses.length ||
    addresses.some(address => !isPublicAddress(address.address))
  ) {
    throw new Error("The hostname is not allowed.");
  }

  return url;
}

async function fetchPage(value) {
  const url = await validatePublicUrl(value);

  if (!(await canCrawl(url.href))) {
    throw new Error("robots.txt disallows crawling this page.");
  }

  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "INDEXSearchBot/0.1"
    }
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("Redirects are disabled for crawler safety.");
  }

  if (!response.ok) {
    throw new Error(`Website returned HTTP ${response.status}`);
  }

  const type = response.headers.get("content-type") || "";

  if (!type.toLowerCase().includes("text/html")) {
    throw new Error("This URL does not return HTML.");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_BYTES) {
    throw new Error("The webpage is too large.");
  }

  if (!response.body) {
    throw new Error("The webpage returned an empty response.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.length;

      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("The webpage exceeded the size limit.");
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return [];

  const index = JSON.parse(
    fs.readFileSync(INDEX_FILE, "utf8")
  );

  if (!Array.isArray(index)) {
    throw new Error("The search index must be a JSON array.");
  }

  return index;
}

function savePage(index, document) {
  const position = index.findIndex(
    page => page.url === document.url
  );

  if (position >= 0) {
    index[position] = document;
  } else {
    index.push(document);
  }

  fs.mkdirSync(path.dirname(INDEX_FILE), {
    recursive: true
  });

  fs.writeFileSync(
    INDEX_FILE,
    JSON.stringify(index, null, 2)
  );
}

function extractDocument(html, url) {
  const $ = cheerio.load(html);

  $("script, style, noscript, nav, footer, header").remove();

  const title = $("title").text().trim() || url.hostname;

  const description =
    $('meta[name="description"]').attr("content") || "";

  const text = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url: url.href,
    title,
    description,
    text: text.slice(0, MAX_TEXT),
    crawledAt: new Date().toISOString()
  };
}

async function crawlPage(value) {
  const url = await validatePublicUrl(value);
  const html = await fetchPage(url.href);
  const document = extractDocument(html, url);

  const index = readIndex();
  savePage(index, document);

  return {
    url: document.url,
    title: document.title,
    charactersIndexed: document.text.length
  };
}

// Extract webpage content for AI applications without saving it.
async function extractPage(value) {
  const url = await validatePublicUrl(value);
  const html = await fetchPage(url.href);
  const document = extractDocument(html, url);

  return {
    success: true,
    url: document.url,
    title: document.title,
    description: document.description,
    content: document.text,
    characters: document.text.length,
    extractedAt: new Date().toISOString()
  };
}

async function crawlSite(startUrl, maxPages = MAX_PAGES) {
  const start = await validatePublicUrl(startUrl);

  const limit = Math.max(
    1,
    Math.min(Number(maxPages) || MAX_PAGES, MAX_PAGES)
  );

  const queue = [start.href];
  const seen = new Set();
  const results = [];

  while (queue.length && seen.size < limit) {
    const current = queue.shift();

    if (seen.has(current)) continue;
    seen.add(current);

    try {
      const url = await validatePublicUrl(current);

      if (url.hostname !== start.hostname) continue;

      if (!(await canCrawl(url.href))) {
        results.push({
          url: url.href,
          skipped: "Disallowed by robots.txt"
        });
        continue;
      }

      const html = await fetchPage(url.href);
      const document = extractDocument(html, url);

      const index = readIndex();
      savePage(index, document);

      results.push({
        url: document.url,
        title: document.title,
        charactersIndexed: document.text.length
      });

      const $ = cheerio.load(html);

      $("a[href]").each((_, element) => {
        try {
          const link = new URL(
            $(element).attr("href"),
            url.href
          );

          link.hash = "";

          if (
            ["http:", "https:"].includes(link.protocol) &&
            link.hostname === start.hostname &&
            !seen.has(link.href) &&
            !queue.includes(link.href)
          ) {
            queue.push(link.href);
          }
        } catch {
          // Ignore malformed links.
        }
      });
    } catch (error) {
      results.push({
        url: current,
        error: error.message
      });
    }
  }

  return {
    startUrl: start.href,
    pagesProcessed: results.filter(
      item => !item.error && !item.skipped
    ).length,
    results
  };
}

module.exports = {
  crawlPage,
  crawlSite,
  extractPage
};
