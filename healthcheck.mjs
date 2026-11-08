const port = process.env.PORT || process.env.CAPTAIN_PORT || 8080;
const url = process.env.HEALTH_URL || `http://127.0.0.1:${port}/healthz`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    console.error(`healthcheck failed: HTTP ${res.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`healthcheck failed: ${error.message}`);
  process.exit(1);
}
