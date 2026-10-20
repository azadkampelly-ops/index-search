
const robotsParser = require("robots-parser");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const INDEX_FILE = path.join(__dirname, "../data/index.json");
const QUEUE_FILE = path.join(__dirname, "../data/crawl-queue.json");

const robotsCache = new Map();
const sitemapDiscoveredHosts = new Set();

const MAX_PAGES = 10;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_TEXT = 100000;
const MAX_QUEUE_SIZE = 10000;
const MAX_SITEMAPS_PER_HOST = 10;
const MAX_SITEMAP_URLS = 1000;
const MAX_REDIRECTS = 5;

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split(".").map(Number);

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
      (a === 203 && b === 0 && c === 113) ||
      (a === 255 && b === 255 && c === 255 && d === 255)
    );
  }

  if (net.isIPv6(ip)) {
    const value = ip.toLowerCase();

    if (value.startsWith("::ffff:")) {
      return false;
    }

    const first = parseInt(value.split(":")[0] || "0", 16);

    if (first < 0x2000 || first > 0x3fff) {
      return false;
    }

    const parts = value.split(":");

    if (first === 0x2001 && parts[1] === "db8") {
      return false;
    }

    return true;
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
      throw new Error("Private or non-public IP addresses are not allowed.");
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
    throw new Error("The hostname resolves to a non-public address.");
  }

  return url;
}

async function readLimitedBody(response, maxBytes, errorMessage) {
  if (!response.body) {
    throw new Error("The response body is empty.");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error(errorMessage);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(errorMessage);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function getRobotsPolicy(origin) {
  if (robotsCache.has(origin)) {
    return robotsCache.get(origin);
  }

  const robotsUrl = `${origin}/robots.txt`;
  let policy;

  try {
    const safeUrl = await validatePublicUrl(robotsUrl);

    const response = await fetch(safeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent": "INDEXSearchBot/0.1"
      }
    });

    if (response.status === 404) {
      policy = robotsParser(robotsUrl, "");
    } else if (response.ok) {
      const text = await readLimitedBody(
        response,
        MAX_ROBOTS_BYTES,
        "robots.txt exceeded the size limit."
      );

      policy = robotsParser(robotsUrl, text);
    } else {
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      throw new Error("Could not retrieve robots.txt.");
    }
  } catch {
    throw new Error("Unable to verify robots.txt policy.");
  }

  robotsCache.set(origin, policy);
  return policy;
}

async function canCrawl(value) {
  const url = new URL(value);
  const policy = await getRobotsPolicy(url.origin);

  return policy.isAllowed(value, "INDEXSearchBot") !== false;
}

async function fetchPage(value) {
  let url = await validatePublicUrl(value);
  const visited = new Set();
  let redirects = 0;

  while (true) {
    if (visited.has(url.href)) {
      throw new Error("Redirect loop detected.");
    }

    visited.add(url.href);

    if (!(await canCrawl(url.href))) {
      throw new Error("robots.txt disallows crawling this page.");
    }

    url = await validatePublicUrl(url.href);

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "INDEXSearchBot/0.1"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      if (!location) {
        throw new Error("Redirect has no destination URL.");
      }

      if (redirects >= MAX_REDIRECTS) {
        throw new Error("Maximum redirect limit exceeded.");
      }

      let nextUrl;

      try {
        nextUrl = new URL(location, url);
      } catch {
        throw new Error("Invalid redirect destination.");
      }

      if (!["http:", "https:"].includes(nextUrl.protocol)) {
        throw new Error("Unsupported redirect protocol.");
      }

      if (nextUrl.username || nextUrl.password) {
        throw new Error(
          "Redirect URLs containing credentials are not allowed."
        );
      }

      url = await validatePublicUrl(nextUrl.href);
      redirects++;
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      throw new Error("Unsupported HTTP redirect/status.");
    }

    if (!response.ok) {
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      throw new Error(`Website returned HTTP ${response.status}`);
    }

    const type = response.headers.get("content-type") || "";

    if (
      !type.toLowerCase().includes("text/html") &&
      !type.toLowerCase().includes("application/xhtml+xml")
    ) {
      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      throw new Error("This URL does not return HTML.");
    }

    return readLimitedBody(
      response,
      MAX_BYTES,
      "The webpage exceeded the size limit."
    );
  }
}

async function fetchSmallText(value, maxBytes = MAX_SITEMAP_BYTES) {
  const url = await validatePublicUrl(value);

  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "INDEXSearchBot/0.1"
    }
  });

  if (response.status >= 300 && response.status < 400) {
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    throw new Error("Redirects are disabled.");
  }

  if (!response.ok) {
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    throw new Error(`HTTP ${response.status}`);
  }

  return readLimitedBody(
    response,
    maxBytes,
    "Response exceeded the size limit."
  );
}

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return [];

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));

  if (!Array.isArray(index)) {
    throw new Error("The search index must be a JSON array.");
  }

  return index;
}

function savePage(index, document) {
  const position = index.findIndex(page => page.url === document.url);

  if (position >= 0) {
    index[position] = document;
  } else {
    index.push(document);
  }

  fs.mkdirSync(path.dirname(INDEX_FILE), {
    recursive: true
  });

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function readCrawlQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));

  if (!Array.isArray(queue)) {
    throw new Error("Invalid crawl queue format.");
  }

  return queue;
}

function saveCrawlQueue(queue) {
  fs.mkdirSync(path.dirname(QUEUE_FILE), {
    recursive: true
  });

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function addDiscoveredUrls(urls, sourceUrl) {
  const queue = readCrawlQueue();
  const knownUrls = new Set(queue.map(item => item.url));
  let added = 0;

  for (const value of urls) {
    if (queue.length >= MAX_QUEUE_SIZE) break;

    try {
      const url = new URL(value);

      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (url.username || url.password) continue;

      url.hash = "";
      const normalizedUrl = url.href;

      if (knownUrls.has(normalizedUrl)) continue;

      queue.push({
        url: normalizedUrl,
        sourceUrl,
        status: "pending",
        discoveredAt: new Date().toISOString()
      });

      knownUrls.add(normalizedUrl);
      added++;
    } catch {
      // Ignore malformed URLs.
    }
  }

  saveCrawlQueue(queue);
  return added;
}

function extractDocument(html, url) {
  const $ = cheerio.load(html);

  $("script, style, noscript, nav, footer, header").remove();

  const title = $("title").text().trim() || url.hostname;
  const description = $('meta[name="description"]').attr("content") || "";
  const text = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url: url.href,
    title,
    description,
    text: text.slice(0, MAX_TEXT),
    crawledAt: new Date().toISOString()
  };
}

function extractLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, element) => {
    try {
      const link = new URL($(element).attr("href"), pageUrl);
      link.hash = "";

      if (
        ["http:", "https:"].includes(link.protocol) &&
        !link.username &&
        !link.password
      ) {
        links.push(link.href);
      }
    } catch {
      // Ignore malformed URLs.
    }
  });

  return [...new Set(links)];
}

async function getSitemapLocations(siteUrl) {
  const site = new URL(siteUrl);
  const robotsUrl = `${site.origin}/robots.txt`;
  const locations = [`${site.origin}/sitemap.xml`];

  try {
    const text = await fetchSmallText(robotsUrl, MAX_ROBOTS_BYTES);

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)/i);

      if (match) locations.push(match[1]);
    }
  } catch {
    // Try the default sitemap location anyway.
  }

  return [...new Set(locations)].slice(0, MAX_SITEMAPS_PER_HOST);
}

async function discoverFromSitemap(sitemapUrl, sourceUrl, state) {
  if (state.sitemapsVisited.has(sitemapUrl)) return;
  if (state.sitemapsVisited.size >= MAX_SITEMAPS_PER_HOST) return;
  if (state.urlsFound >= MAX_SITEMAP_URLS) return;

  state.sitemapsVisited.add(sitemapUrl);

  try {
    const xml = await fetchSmallText(sitemapUrl, MAX_SITEMAP_BYTES);
    const $ = cheerio.load(xml, { xmlMode: true });

    const nestedSitemaps = [];
    const pageUrls = [];

    $("sitemap loc").each((_, element) => {
      const location = $(element).text().trim();
      if (location) nestedSitemaps.push(location);
    });

    $("url loc").each((_, element) => {
      const location = $(element).text().trim();
      if (location) pageUrls.push(location);
    });

    for (const nested of nestedSitemaps) {
      if (
        state.sitemapsVisited.size >= MAX_SITEMAPS_PER_HOST ||
        state.urlsFound >= MAX_SITEMAP_URLS
      ) {
        break;
      }

      await discoverFromSitemap(nested, sourceUrl, state);
    }

    if (pageUrls.length) {
      const remaining = MAX_SITEMAP_URLS - state.urlsFound;
      const selected = pageUrls.slice(0, remaining);
      const validUrls = [];

      for (const value of selected) {
        try {
          const parsed = await validatePublicUrl(value);
          validUrls.push(parsed.href);
        } catch {
          // Ignore invalid or unsafe sitemap entries.
        }
      }

      const added = addDiscoveredUrls(validUrls, sourceUrl);
      state.urlsFound += validUrls.length;

      if (added) {
        console.log(
          `INDEX Sitemap: queued ${added} URLs from ${sitemapUrl}`
        );
      }
    }
  } catch (error) {
    console.warn(
      "INDEX Sitemap: skipped",
      sitemapUrl,
      "-",
      error.message
    );
  }
}

// Updated: returns discovery results and resets the host on fatal errors.
async function discoverSitemaps(siteUrl) {
  const url = await validatePublicUrl(siteUrl);
  const hostname = url.hostname;

  if (sitemapDiscoveredHosts.has(hostname)) {
    return {
      success: true,
      hostname,
      sitemapsChecked: 0,
      urlsFound: 0,
      skipped: true,
      message: "Sitemap discovery already completed."
    };
  }

  sitemapDiscoveredHosts.add(hostname);

  const state = {
    sitemapsVisited: new Set(),
    urlsFound: 0
  };

  try {
    const locations = await getSitemapLocations(url.href);

    for (const sitemapUrl of locations) {
      if (
        state.sitemapsVisited.size >= MAX_SITEMAPS_PER_HOST ||
        state.urlsFound >= MAX_SITEMAP_URLS
      ) {
        break;
      }

      await discoverFromSitemap(sitemapUrl, url.href, state);
    }

    return {
      success: true,
      hostname,
      sitemapsChecked: state.sitemapsVisited.size,
      urlsFound: state.urlsFound
    };
  } catch (error) {
    sitemapDiscoveredHosts.delete(hostname);
    throw error;
  }
}

async function crawlPage(value) {
  const url = await validatePublicUrl(value);
  const html = await fetchPage(url.href);
  const document = extractDocument(html, url);

  const index = readIndex();
  savePage(index, document);

  const links = extractLinks(html, url.href);
  const added = addDiscoveredUrls(links, url.href);

  if (added) {
    console.log(
      `INDEX URL Discovery: queued ${added} URLs from ${url.href}`
    );
  }

  const sitemapResult = await discoverSitemaps(url.href);

  return {
    url: document.url,
    title: document.title,
    charactersIndexed: document.text.length,
    sitemap: sitemapResult
  };
}

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

  const sitemap = await discoverSitemaps(start.href);
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

      const html = await fetchPage(url.href);
      const document = extractDocument(html, url);

      const index = readIndex();
      savePage(index, document);

      results.push({
        url: document.url,
        title: document.title,
        charactersIndexed: document.text.length
      });

      const links = extractLinks(html, url.href);

      const sameHostLinks = links.filter(link => {
        try {
          return new URL(link).hostname === start.hostname;
        } catch {
          return false;
        }
      });

      for (const link of sameHostLinks) {
        if (!seen.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      const newlyQueued = addDiscoveredUrls(links, url.href);

      if (newlyQueued) {
        console.log(
          `INDEX URL Discovery: queued ${newlyQueued} URLs from ${url.href}`
        );
      }
    } catch (error) {
      results.push({
        url: current,
        error: error.message
      });
    }
  }

  return {
    startUrl: start.href,
    sitemap,
    pagesProcessed: results.filter(
      item => !item.error && !item.skipped
    ).length,
    results
  };
}

module.exports = {
  crawlPage,
  crawlSite,
  extractPage,
  readCrawlQueue,
  addDiscoveredUrls,
  discoverSitemaps
};
