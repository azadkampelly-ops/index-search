# INDEX Search API v0.4.0

INDEX Search is a website crawling, content extraction, and search API with BM25 ranking.

## Base URL

Local development:

`http://localhost:3000`

For production, replace this with your deployed HTTPS API URL.

## Authentication

All `/v1` endpoints require an API key in the `x-api-key` header.

Keep your API key private. Do not expose it in frontend JavaScript or commit it to GitHub.

## 1. Search indexed pages

**Endpoint:** `GET /v1/search?q=example`

Searches pages already present in the index using BM25 ranking.

### PowerShell example

```powershell
$key = Read-Host "Enter API key"

Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/search?q=example" `
  -Headers @{ "x-api-key" = $key }
```

### Example response

```json
{
  "success": true,
  "query": "example",
  "count": 1,
  "results": [
    {
      "title": "Example Domain",
      "url": "https://example.com/",
      "score": 1.25,
      "content": "This domain is for use in documentation examples..."
    }
  ]
}
```

The response is illustrative; actual results and scores depend on the index.

**Important:** Search returns indexed content. Crawl pages before searching for them.

## 2. Crawl a webpage

**Endpoint:** `POST /v1/crawl`

Fetches and indexes a webpage.

### Request body

```json
{
  "url": "https://example.com/"
}
```

### PowerShell example

```powershell
$key = Read-Host "Enter API key"

$body = @{
  url = "https://example.com/"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/crawl" `
  -Method Post `
  -Headers @{ "x-api-key" = $key } `
  -ContentType "application/json" `
  -Body $body
```

## 3. Crawl a website

**Endpoint:** `POST /v1/crawl-site`

Crawls a website, subject to the crawler's restrictions and page limits.

### Request body

```json
{
  "url": "https://www.iana.org/",
  "maxPages": 5
}
```

### PowerShell example

```powershell
$key = Read-Host "Enter API key"

$body = @{
  url = "https://www.iana.org/"
  maxPages = 5
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/crawl-site" `
  -Method Post `
  -Headers @{ "x-api-key" = $key } `
  -ContentType "application/json" `
  -Body $body
```

The actual number of crawled pages depends on the website, crawler limits, and available links.

## 4. Extract webpage content

**Endpoint:** `POST /v1/extract`

Extracts readable text and metadata from a webpage and returns them as JSON. This endpoint does not necessarily add the page to the search index.

### Request body

```json
{
  "url": "https://example.com/"
}
```

### PowerShell example

```powershell
$key = Read-Host "Enter API key"

$body = @{
  url = "https://example.com/"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/extract" `
  -Method Post `
  -Headers @{ "x-api-key" = $key } `
  -ContentType "application/json" `
  -Body $body
```

### Example response

```json
{
  "success": true,
  "url": "https://example.com/",
  "description": "",
  "content": "This domain is for use in documentation examples...",
  "characters": 156,
  "extractedAt": "2026-10-20T10:10:26.491Z"
}
```

The example values are illustrative. The response contains the extracted page's actual metadata and text.

## 5. Health check

**Endpoint:** `GET /health`

Checks whether the API server is running. This endpoint does not require an API key.

### PowerShell example

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3000/health"
```

## 6. Rate limits

The API currently limits requests to **30 requests per minute per client IP** on the protected API routes.

Excess requests receive HTTP `429 Too Many Requests`.

## 7. Common errors

| HTTP status | Meaning |
|---|---|
| `400` | Invalid or missing request data |
| `401` | Invalid or missing API key |
| `404` | Endpoint or resource not found |
| `429` | Rate limit exceeded |
| `500` | Server-side error |

Exact error responses depend on the endpoint and failure.

## 8. Security notes

- Use HTTPS for production deployments.
- Keep API keys and admin keys private.
- Do not put secret API keys in browser-side code.
- Only crawl websites you are permitted to access.
- Respect website crawling policies and applicable terms.
- Review URL validation and network-access protections before exposing crawling or extraction endpoints publicly.

## Version

**INDEX Search API v0.4.0**

This document describes the current local API implementation. Verify endpoint behavior and response fields against the running server before publishing it as a production API specification.
