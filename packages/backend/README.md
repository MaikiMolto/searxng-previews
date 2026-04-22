# SearXNG Preview Service - Backend

MVP Screenshot Service für SearXNG Result Previews.

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Copy and configure environment
cp .env.example .env

# Start development server
npm run dev

# Or production
npm start
```

## Docker

```bash
# From repo root
docker-compose up --build
```

## API Endpoints

### GET /preview
Capture a screenshot of a webpage.

**Query Parameters:**
- `url` (required) - URL to capture
- `width` (optional, default: 240) - Thumbnail width in pixels
- `format` (optional, default: webp) - Image format (webp, png, jpeg)

**Response:**
- `200` - Image data
- `400` - Invalid URL or parameters
- `429` - Rate limit exceeded
- `504` - Screenshot timeout

**Headers:**
- `Cache-Control: public, max-age=86400`
- `X-Cache: HIT|MISS`

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "cache": {
    "entries": 123,
    "sizeBytes": 4567890
  },
  "uptime": 3600
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `CORS_ORIGINS` | * | Comma-separated allowed origins |
| `CACHE_TTL_HOURS` | 24 | Cache time-to-live in hours |
| `MAX_CACHE_SIZE_MB` | 500 | Maximum cache size in MB |
| `RATE_LIMIT_PER_MINUTE` | 30 | Requests per minute per IP |
| `BLOCK_PRIVATE_IPS` | true | Block private/local IPs |
| `SCREENSHOT_TIMEOUT` | 10000 | Screenshot timeout in ms |

## Architecture

- **Fastify** - HTTP framework
- **Playwright** - Browser automation
- **LRU-Cache** - In-memory cache metadata
- **Filesystem** - Binary cache storage
