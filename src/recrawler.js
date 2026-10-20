
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const {
  crawlPage,
  readCrawlQueue
} = require("./crawler");

const QUEUE_FILE = path.join(
  __dirname,
  "../data/crawl-queue.json"
);

// Crawl settings
const INTERVAL = 30 * 1000;
const MAX_PAGES_PER_RUN = 10;
const MAX_RETRIES = 5;
const DELAY_BETWEEN_SITES = 5000;
const DELAY_SAME_SITE = 30 * 1000;
const PROCESSING_TIMEOUT = 5 * 60 * 1000;

// Prevent overlapping processing runs.
let running = false;

// Track last crawl time for each hostname.
const lastCrawlByHost = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function saveQueue(queue) {
  fs.mkdirSync(path.dirname(QUEUE_FILE), {
    recursive: true
  });

  fs.writeFileSync(
    QUEUE_FILE,
    JSON.stringify(queue, null, 2)
  );
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getRetryDelay(attempts) {
  // Exponential backoff: 30s, 60s, 120s, then up to 5 minutes.
  return Math.min(
    30 * 1000 * Math.pow(2, Math.max(0, attempts - 1)),
    5 * 60 * 1000
  );
}

function isEligible(item, now) {
  if (item.status === "pending") {
    const retryAfter = item.retryAfter
      ? Date.parse(item.retryAfter)
      : 0;

    return !retryAfter || retryAfter <= now;
  }

  if (item.status === "processing") {
    const startedAt = item.startedAt
      ? Date.parse(item.startedAt)
      : 0;

    // Recover records interrupted by a server restart.
    return (
      !startedAt ||
      now - startedAt > PROCESSING_TIMEOUT
    );
  }

  if (item.status === "failed") {
    // Retry failed records only if they have attempts remaining.
    return (item.attempts || 0) < MAX_RETRIES;
  }

  return false;
}

async function processPendingQueue() {
  const queue = readCrawlQueue();
  const now = Date.now();

  const pending = queue
    .filter(item => isEligible(item, now))
    .slice(0, MAX_PAGES_PER_RUN);

  if (!pending.length) {
    console.log("INDEX Crawler: no eligible URLs.");
    return;
  }

  console.log(
    `INDEX Crawler: processing ${pending.length} URLs.`
  );

  for (const item of pending) {
    const currentQueue = readCrawlQueue();

    const current = currentQueue.find(
      entry => entry.url === item.url
    );

    if (!current || !isEligible(current, Date.now())) {
      continue;
    }

    const hostname = getHostname(current.url);

    if (!hostname) {
      current.status = "failed";
      current.lastError = "Invalid URL.";
      current.completedAt = new Date().toISOString();
      saveQueue(currentQueue);
      continue;
    }

    // Count an interrupted processing attempt before retrying.
    if (current.status === "processing") {
      current.attempts = (current.attempts || 0) + 1;
    }

    // Stop retrying when the attempt limit has been reached.
    if ((current.attempts || 0) >= MAX_RETRIES) {
      current.status = "failed";
      current.lastError =
        current.lastError ||
        "Maximum retries reached.";

      current.completedAt = new Date().toISOString();
      delete current.retryAfter;
      saveQueue(currentQueue);
      continue;
    }

    // Enforce a minimum delay between requests to the same hostname.
    const lastRequest = lastCrawlByHost.get(hostname) || 0;

    const waitForHost = Math.max(
      0,
      DELAY_SAME_SITE - (Date.now() - lastRequest)
    );

    if (waitForHost > 0) {
      console.log(
        `INDEX Crawler: waiting ${Math.ceil(waitForHost / 1000)}s for ${hostname}`
      );

      await sleep(waitForHost);
    }

    // Re-read queue after waiting to avoid overwriting newer changes.
    const latestQueue = readCrawlQueue();

    const latest = latestQueue.find(
      entry => entry.url === item.url
    );

    if (!latest || !isEligible(latest, Date.now())) {
      continue;
    }

    // Preserve the attempt count computed above.
    if (current.status === "processing") {
      latest.attempts = current.attempts;
    }

    latest.status = "processing";
    latest.startedAt = new Date().toISOString();
    delete latest.retryAfter;

    saveQueue(latestQueue);

    lastCrawlByHost.set(hostname, Date.now());

    try {
      const result = await crawlPage(latest.url);

      const updatedQueue = readCrawlQueue();
      const updated = updatedQueue.find(
        entry => entry.url === latest.url
      );

      if (updated) {
        updated.status = "completed";
        updated.completedAt = new Date().toISOString();
        updated.lastError = null;
        delete updated.retryAfter;
        delete updated.startedAt;
      }

      saveQueue(updatedQueue);

      console.log(
        `INDEX Crawler: completed ${latest.url}`,
        result.title ? `- ${result.title}` : ""
      );
    } catch (error) {
      const updatedQueue = readCrawlQueue();

      const updated = updatedQueue.find(
        entry => entry.url === latest.url
      );

      if (updated) {
        updated.attempts = (updated.attempts || 0) + 1;

        updated.lastError = String(
          error.message || error
        ).slice(0, 500);

        delete updated.startedAt;

        if (updated.attempts >= MAX_RETRIES) {
          updated.status = "failed";
          updated.completedAt = new Date().toISOString();
          delete updated.retryAfter;

          console.warn(
            `INDEX Crawler: maximum retries reached for ${latest.url}: ${updated.lastError}`
          );
        } else {
          updated.status = "pending";

          const delay = getRetryDelay(updated.attempts);

          updated.retryAfter = new Date(
            Date.now() + delay
          ).toISOString();

          console.warn(
            `INDEX Crawler: retry ${updated.attempts}/${MAX_RETRIES} for ${latest.url}; waiting ${Math.round(delay / 1000)}s. Reason: ${updated.lastError}`
          );
        }
      }

      saveQueue(updatedQueue);
    }

    await sleep(DELAY_BETWEEN_SITES);
  }
}

async function recrawlIndexedPages() {
  if (running) {
    console.log(
      "INDEX Crawler: previous run is still active."
    );
    return;
  }

  running = true;

  try {
    await processPendingQueue();
  } catch (error) {
    console.error(
      "INDEX Crawler: queue processing error:",
      error.message
    );
  } finally {
    running = false;
  }
}

// Run at startup, then periodically.
recrawlIndexedPages();

const timer = setInterval(
  recrawlIndexedPages,
  INTERVAL
);

if (typeof timer.unref === "function") {
  timer.unref();
}

module.exports = {
  processPendingQueue,
  recrawlIndexedPages
};
