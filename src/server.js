
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();
require("./recrawler");

const { crawlPage, crawlSite, extractPage } = require("./crawler");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, "../data/index.json");

let searchRequests = 0;
let crawlRequests = 0;
let extractRequests = 0;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "../public")));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Try again later."
  }
});

function requireApiKey(req, res, next) {
  const expectedKey = process.env.INDEX_API_KEY;
  const providedKey = req.get("x-api-key") || "";

  if (!expectedKey) {
    return res.status(500).json({
      success: false,
      error: "API key is not configured."
    });
  }

  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(providedKey);

  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return res.status(401).json({
      success: false,
      error: "Invalid or missing API key."
    });
  }

  next();
}

app.use("/v1", apiLimiter, requireApiKey);

function requireAdminKey(req, res, next) {
  const expectedKey = process.env.INDEX_ADMIN_KEY;
  const providedKey = req.get("x-admin-key") || "";

  if (!expectedKey) {
    return res.status(500).json({
      error: "Admin key is not configured."
    });
  }

  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(providedKey);

  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return res.status(401).json({
      error: "Invalid admin key."
    });
  }

  next();
}

// Admin statistics
app.get("/admin/api/stats", requireAdminKey, (req, res) => {
  try {
    const pages = fs.existsSync(INDEX_FILE)
      ? JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"))
      : [];

    if (!Array.isArray(pages)) {
      return res.status(500).json({
        error: "Invalid search index."
      });
    }

    res.set("Cache-Control", "no-store");

    res.json({
      status: "Running",
      indexedPages: pages.length,
      searchRequests,
      crawlRequests,
      extractRequests,
      pages: pages.map(page => ({
        title: page.title || "Untitled",
        url: page.url || "",
        crawledAt: page.crawledAt || null
      }))
    });
  } catch (error) {
    console.error("Admin stats error:", error.message);

    res.status(500).json({
      error: "Could not read search index."
    });
  }
});

// Home
app.get("/", (req, res) => {
  res.json({
    name: "INDEX Search API",
    version: "0.4.0",
    status: "running",
    endpoints: [
      "/",
      "/health",
      "/admin.html",
      "/admin/api/stats",
      "/v1/search?q=example",
      "/v1/crawl",
      "/v1/crawl-site",
      "/v1/extract"
    ],
    authentication: "Send your API key in the x-api-key header."
  });
});

// Health
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "INDEX Search API",
    status: "running"
  });
});

// Extract webpage content for AI applications
app.post("/v1/extract", async (req, res) => {
  extractRequests++;

  try {
    const { url } = req.body || {};

    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({
        success: false,
        error: "Provide a URL in the JSON body."
      });
    }

    const result = await extractPage(url.trim());

    res.set("Cache-Control", "no-store");

    res.json(result);
  } catch (error) {
    console.error("Extraction error:", error.message);

    res.status(400).json({
      success: false,
      error: error.message || "Unable to extract webpage content."
    });
  }
});

// Crawl one page
app.post("/v1/crawl", async (req, res) => {
  crawlRequests++;

  try {
    const { url } = req.body || {};

    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({
        success: false,
        error: "Provide a URL in the JSON body."
      });
    }

    const result = await crawlPage(url.trim());

    res.json({
      success: true,
      indexed: result
    });
  } catch (error) {
    console.error("Crawl error:", error.message);

    res.status(400).json({
      success: false,
      error: error.message || "Unable to crawl the webpage."
    });
  }
});

// Crawl a website
app.post("/v1/crawl-site", async (req, res) => {
  crawlRequests++;

  try {
    const { url, maxPages } = req.body || {};

    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({
        success: false,
        error: "Provide a starting URL."
      });
    }

    const result = await crawlSite(url.trim(), maxPages);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error("Site crawl error:", error.message);

    res.status(400).json({
      success: false,
      error: error.message || "Unable to crawl the website."
    });
  }
});

// Tokenize text for BM25
function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

// Search indexed pages
app.get("/v1/search", (req, res) => {
  searchRequests++;

  const rawQuery = String(req.query.q || "").trim();

  if (!rawQuery) {
    return res.status(400).json({
      success: false,
      error: "Provide a query using ?q=your-query"
    });
  }

  if (rawQuery.length > 200) {
    return res.status(400).json({
      success: false,
      error: "Search query must be 200 characters or fewer."
    });
  }

  try {
    const index = fs.existsSync(INDEX_FILE)
      ? JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"))
      : [];

    if (!Array.isArray(index)) {
      throw new Error("The index file must contain a JSON array.");
    }

    const queryTerms = [...new Set(tokenize(rawQuery))];

    if (queryTerms.length === 0) {
      return res.json({
        success: true,
        query: rawQuery,
        total: 0,
        ranking: "BM25",
        results: []
      });
    }

    const documents = index.map(page => {
      const title = String(page.title || "");
      const description = String(page.description || "");
      const text = String(page.text || "");

      const titleTokens = tokenize(title);
      const descriptionTokens = tokenize(description);
      const bodyTokens = tokenize(text);

      const allTokens = [
        ...titleTokens,
        ...descriptionTokens,
        ...bodyTokens
      ];

      return {
        title,
        url: String(page.url || ""),
        description,
        titleTokens,
        descriptionTokens,
        allTokens,
        length: allTokens.length
      };
    });

    const documentCount = documents.length;

    const averageLength = documentCount
      ? documents.reduce((sum, doc) => sum + doc.length, 0) /
        documentCount
      : 0;

    const k1 = 1.2;
    const b = 0.75;
    const documentFrequency = new Map();

    for (const term of queryTerms) {
      documentFrequency.set(
        term,
        documents.filter(doc => doc.allTokens.includes(term)).length
      );
    }

    const results = documents
      .map(doc => {
        let score = 0;
        let matchedTerms = 0;

        for (const term of queryTerms) {
          const frequency = doc.allTokens.filter(
            token => token === term
          ).length;

          if (frequency === 0) continue;

          matchedTerms++;

          const df = documentFrequency.get(term) || 0;

          const idf = Math.log(
            1 + (documentCount - df + 0.5) / (df + 0.5)
          );

          const lengthFactor = averageLength > 0
            ? 1 - b + b * (doc.length / averageLength)
            : 1;

          const bm25 =
            idf *
            (frequency * (k1 + 1)) /
            (frequency + k1 * lengthFactor);

          const titleFrequency = doc.titleTokens.filter(
            token => token === term
          ).length;

          const descriptionFrequency = doc.descriptionTokens.filter(
            token => token === term
          ).length;

          score += bm25;
          score += titleFrequency * 2;
          score += descriptionFrequency * 0.5;
        }

        return {
          title: doc.title,
          url: doc.url,
          description: doc.description,
          content: doc.allTokens.length
            ? String(
                index.find(page => page.url === doc.url)?.text || ""
              ).slice(0, 500)
            : "",
          score: Math.round(score * 1000) / 1000,
          matchedTerms,
          totalQueryTerms: queryTerms.length
        };
      })
      .filter(result => result.score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        a.title.localeCompare(b.title)
      )
      .slice(0, 10);

    res.json({
      success: true,
      query: rawQuery,
      total: results.length,
      ranking: "BM25",
      results
    });
  } catch (error) {
    console.error("Search error:", error.message);

    res.status(500).json({
      success: false,
      error: "Unable to search the local index."
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`INDEX Search API running at http://localhost:${PORT}`);
});
