
const fs = require("fs");
const path = require("path");
const { crawlPage } = require("./crawler");

const INDEX_FILE = path.join(__dirname, "../data/index.json");
const INTERVAL = 6 * 60 * 60 * 1000;
let running = false;

async function recrawlIndexedPages() {
  if (running) return;
  running = true;

  try {
    if (!fs.existsSync(INDEX_FILE)) return;

    const pages = JSON.parse(
      fs.readFileSync(INDEX_FILE, "utf8")
    );

    if (!Array.isArray(pages)) {
      throw new Error("Invalid search index format.");
    }

    const urls = [...new Set(
      pages
        .map(page => page.url)
        .filter(url => typeof url === "string")
    )].slice(0, 10);

    console.log(`INDEX Recrawler: refreshing ${urls.length} pages`);

    for (const url of urls) {
      try {
        const result = await crawlPage(url);
        console.log("Refreshed:", result.url);
      } catch (error) {
        console.log("Skipped:", url, "-", error.message);
      }
    }
  } catch (error) {
    console.error("Recrawler error:", error.message);
  } finally {
    running = false;
  }
}

const timer = setInterval(recrawlIndexedPages, INTERVAL);
timer.unref();

module.exports = { recrawlIndexedPages };
