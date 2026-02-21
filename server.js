import cors from 'cors';
import express from 'express';
import WebSocket from 'ws';

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';
const POLYGON_REST = 'https://api.polygon.io';

const STOCKS_WS_URL = process.env.POLYGON_STOCKS_WS_URL || 'wss://delayed.polygon.io/stocks';
const CRYPTO_WS_URL = process.env.POLYGON_CRYPTO_WS_URL || 'wss://socket.polygon.io/crypto';
const USE_WEBSOCKETS = (process.env.MARKET_RELAY_USE_WEBSOCKETS ?? 'true').toLowerCase() !== 'false';

const PORT = Number(process.env.PORT || 8080);
const WS_STALE_MS = Number(process.env.WS_STALE_MS || 20000);
const MAX_CONN_COOLDOWN_MS = Number(process.env.MAX_CONN_COOLDOWN_MS || 60000);
const THROTTLE_COOLDOWN_MS = Number(process.env.THROTTLE_COOLDOWN_MS || 60000);
const MAX_BACKOFF_MS = Number(process.env.MAX_BACKOFF_MS || 120000);
const FOREX_POLL_INTERVAL_MS = Number(process.env.FOREX_POLL_INTERVAL_MS || 15000);
const LIVE_FALLBACK_INTERVAL_MS = Number(process.env.LIVE_FALLBACK_INTERVAL_MS || 15000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 8000);

const ASSET_CATALOG = {
  BTC: { ticker: 'X:BTCUSD', type: 'crypto' },
  ETH: { ticker: 'X:ETHUSD', type: 'crypto' },
  SOL: { ticker: 'X:SOLUSD', type: 'crypto' },
  DOGE: { ticker: 'X:DOGEUSD', type: 'crypto' },
  ADA: { ticker: 'X:ADAUSD', type: 'crypto' },
  XRP: { ticker: 'X:XRPUSD', type: 'crypto' },
  EURUSD: { ticker: 'C:EURUSD', type: 'forex' },
  GBPUSD: { ticker: 'C:GBPUSD', type: 'forex' },
  JPYUSD: { ticker: 'C:JPYUSD', type: 'forex' },
  AUDUSD: { ticker: 'C:AUDUSD', type: 'forex' },
  CADUSD: { ticker: 'C:CADUSD', type: 'forex' },
  GOLD: { ticker: 'C:XAUUSD', type: 'commodity' },
  SILVER: { ticker: 'C:XAGUSD', type: 'commodity' },
  AAPL: { ticker: 'AAPL', type: 'stock' },
  TSLA: { ticker: 'TSLA', type: 'stock' },
  GOOGL: { ticker: 'GOOGL', type: 'stock' },
  MSFT: { ticker: 'MSFT', type: 'stock' },
  AMZN: { ticker: 'AMZN', type: 'stock' },
  NFLX: { ticker: 'NFLX', type: 'stock' },
  DIS: { ticker: 'DIS', type: 'stock' },
  NVDA: { ticker: 'NVDA', type: 'stock' },
};

const CRYPTO_SYMBOLS = Object.entries(ASSET_CATALOG).filter(([, a]) => a.type === 'crypto').map(([s]) => s);
const STOCK_SYMBOLS = Object.entries(ASSET_CATALOG).filter(([, a]) => a.type === 'stock').map(([s]) => s);
const REST_SYMBOLS = Object.entries(ASSET_CATALOG).filter(([, a]) => a.type === 'forex' || a.type === 'commodity').map(([s]) => s);

const prices = {};
const prevPrices = {};
const sseClients = new Set();
const activeStreams = {};

let forexPollRunning = false;
let liveFallbackPollRunning = false;

function makeStreamState(url) {
  return {
    url,
    connected: false,
    authenticated: false,
    reconnectAttempts: 0,
    lastStatus: 'idle',
    lastError: null,
    lastConnectTs: 0,
    lastMessageTs: 0,
    maxConnectionsHit: false,
  };
}

const relayState = {
  startedAt: Date.now(),
  websocketEnabled: USE_WEBSOCKETS && Boolean(POLYGON_API_KEY),
  websocketDisabledUntil: 0,
  websocketDisableReason: null,
  streams: {
    stocks: makeStreamState(STOCKS_WS_URL),
    crypto: makeStreamState(CRYPTO_WS_URL),
  },
  polling: {
    forexIntervalMs: FOREX_POLL_INTERVAL_MS,
    liveFallbackIntervalMs: LIVE_FALLBACK_INTERVAL_MS,
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundPrice(price, digits) {
  return Number.parseFloat(Number(price).toFixed(digits));
}

function toCryptoPair(ticker) {
  const raw = String(ticker || '').replace(/^X:/, '').toUpperCase();
  if (raw.includes('-')) return raw;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}-USD`;
  return raw;
}

function normalizeCryptoPair(pair) {
  const raw = String(pair || '').toUpperCase();
  if (!raw) return '';
  if (raw.includes('-')) return raw;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}-USD`;
  return raw;
}

const CRYPTO_PAIR_TO_SYMBOL = Object.fromEntries(
  CRYPTO_SYMBOLS.map((symbol) => [toCryptoPair(ASSET_CATALOG[symbol].ticker), symbol]),
);

function relaySnapshot() {
  return {
    startedAt: relayState.startedAt,
    websocketEnabled: relayState.websocketEnabled,
    websocketDisabledUntil: relayState.websocketDisabledUntil,
    websocketDisableReason: relayState.websocketDisableReason,
    streams: relayState.streams,
    polling: relayState.polling,
  };
}

function broadcastSseEvent(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function setPrice(symbol, price, changeOverride) {
  if (!Number.isFinite(price) || price <= 0) return;

  const prev = prevPrices[symbol] || price;
  const change = changeOverride !== undefined
    ? changeOverride
    : prev > 0
      ? Number.parseFloat((((price - prev) / prev) * 100).toFixed(2))
      : 0;

  prices[symbol] = { price, change, ts: Date.now() };
  prevPrices[symbol] = price;

  broadcastSseEvent({ symbol, price, change });
}

function disableWebsocketsTemporarily(reason, ms) {
  const until = Date.now() + ms;
  relayState.websocketDisabledUntil = Math.max(relayState.websocketDisabledUntil, until);
  relayState.websocketDisableReason = reason;
}

function nextReconnectDelay(attempt, minMs = 1000) {
  const exp = Math.min(minMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = exp * (0.75 + Math.random() * 0.5);
  const cooldownWait = Math.max(0, relayState.websocketDisabledUntil - Date.now());
  return Math.max(jitter, cooldownWait);
}

function wsStreamHealthy(streamName) {
  if (!relayState.websocketEnabled) return false;
  const s = relayState.streams[streamName];
  if (!s || !s.authenticated) return false;
  return Date.now() - s.lastMessageTs < WS_STALE_MS;
}

class PolygonStream {
  constructor(streamName, url, onAuth, onData) {
    this.streamName = streamName;
    this.url = url;
    this.onAuth = onAuth;
    this.onData = onData;
    this.state = relayState.streams[streamName];
    this.ws = null;
    this.reconnectTimer = null;
  }

  scheduleReconnect(minDelay = 1000) {
    if (!relayState.websocketEnabled) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.state.reconnectAttempts += 1;
    const delay = nextReconnectDelay(this.state.reconnectAttempts, minDelay);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close(code, reason) {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(code, reason);
      }
    } catch (_) {}
  }

  handleStatus(msg) {
    const status = msg.status || 'unknown';
    const message = String(msg.message || '');
    const combined = `${status} ${message}`.toLowerCase();
    this.state.lastStatus = message ? `${status}: ${message}` : status;

    if (status === 'connected') {
      this.ws?.send(JSON.stringify({ action: 'auth', params: POLYGON_API_KEY }));
      return;
    }

    if (status === 'auth_success') {
      this.state.authenticated = true;
      this.state.reconnectAttempts = 0;
      this.state.maxConnectionsHit = false;
      this.onAuth(this.ws);
      return;
    }

    if (status === 'auth_failed') {
      this.state.lastError = 'auth_failed';
      disableWebsocketsTemporarily('auth_failed', MAX_CONN_COOLDOWN_MS);
      this.close(4001, 'auth_failed');
      return;
    }

    if (status === 'error') {
      if (combined.includes('max') && combined.includes('connection')) {
        this.state.maxConnectionsHit = true;
        this.state.lastError = 'max_connections';
        disableWebsocketsTemporarily('max_connections', MAX_CONN_COOLDOWN_MS);
        this.close(4002, 'max_connections');
        return;
      }

      if (combined.includes('too many') || combined.includes('throttle') || combined.includes('rate limit')) {
        this.state.lastError = 'throttled';
        disableWebsocketsTemporarily('throttled', THROTTLE_COOLDOWN_MS);
        this.close(4003, 'throttled');
      }
    }
  }

  connect() {
    if (!relayState.websocketEnabled) return;

    const cooldownWait = relayState.websocketDisabledUntil - Date.now();
    if (cooldownWait > 0) {
      this.scheduleReconnect(cooldownWait);
      return;
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    this.state.connected = false;
    this.state.authenticated = false;
    this.state.lastConnectTs = Date.now();
    this.state.lastStatus = 'connecting';

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.state.connected = true;
      this.state.lastStatus = 'socket_open';
      this.state.lastConnectTs = Date.now();
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;

      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const msgs = JSON.parse(text);
        if (!Array.isArray(msgs)) return;

        for (const msg of msgs) {
          if (msg.ev === 'status') {
            this.handleStatus(msg);
          } else {
            this.state.lastMessageTs = Date.now();
            this.onData(msg);
          }
        }
      } catch (err) {
        this.state.lastError = `parse_error: ${String(err?.message || err)}`;
      }
    });

    ws.on('error', () => {
      if (this.ws !== ws) return;
      this.state.lastError = 'socket_error';
    });

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.state.connected = false;
      this.state.authenticated = false;
      this.state.lastStatus = `closed:${code}`;
      this.scheduleReconnect(1000);
    });
  }

  start() {
    this.connect();
  }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pollForexSymbol(symbol) {
  const asset = ASSET_CATALOG[symbol];
  if (!asset) return;

  const url = `${POLYGON_REST}/v2/snapshot/locale/global/markets/forex/tickers/${asset.ticker}?apiKey=${POLYGON_API_KEY}`;
  const data = await fetchJson(url);
  if (!data?.ticker) return;

  const price = data.ticker.lastTrade?.p || data.ticker.day?.c;
  const prevClose = data.ticker.prevDay?.c || data.ticker.day?.o;
  if (!Number.isFinite(price) || price <= 0) return;

  const change = prevClose > 0
    ? Number.parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2))
    : 0;
  setPrice(symbol, roundPrice(price, 5), change);
}

async function pollStockSymbol(symbol) {
  const asset = ASSET_CATALOG[symbol];
  if (!asset) return;

  const url = `${POLYGON_REST}/v2/snapshot/locale/us/markets/stocks/tickers/${asset.ticker}?apiKey=${POLYGON_API_KEY}`;
  const data = await fetchJson(url);
  if (!data?.ticker) return;

  const price = data.ticker.lastTrade?.p || data.ticker.day?.c || data.ticker.prevDay?.c;
  const prevClose = data.ticker.prevDay?.c || data.ticker.day?.o;
  if (!Number.isFinite(price) || price <= 0) return;

  const change = prevClose > 0
    ? Number.parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2))
    : 0;
  setPrice(symbol, roundPrice(price, 4), change);
}

async function pollCryptoSymbol(symbol) {
  const asset = ASSET_CATALOG[symbol];
  if (!asset) return;

  const url = `${POLYGON_REST}/v2/snapshot/locale/global/markets/crypto/tickers/${asset.ticker}?apiKey=${POLYGON_API_KEY}`;
  const data = await fetchJson(url);
  if (!data?.ticker) return;

  const price = data.ticker.lastTrade?.p || data.ticker.day?.c;
  const prevClose = data.ticker.prevDay?.c || data.ticker.day?.o;
  if (!Number.isFinite(price) || price <= 0) return;

  const change = prevClose > 0
    ? Number.parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2))
    : 0;
  setPrice(symbol, roundPrice(price, 6), change);
}

async function pollAllForex() {
  for (const symbol of REST_SYMBOLS) {
    await pollForexSymbol(symbol);
    await sleep(1000);
  }
}

async function pollLiveFallback() {
  const pollStocks = !wsStreamHealthy('stocks');
  const pollCrypto = !wsStreamHealthy('crypto');
  if (!pollStocks && !pollCrypto) return;

  const symbols = [];
  if (pollStocks) symbols.push(...STOCK_SYMBOLS);
  if (pollCrypto) symbols.push(...CRYPTO_SYMBOLS);

  for (const symbol of symbols) {
    const type = ASSET_CATALOG[symbol]?.type;
    if (type === 'stock') await pollStockSymbol(symbol);
    if (type === 'crypto') await pollCryptoSymbol(symbol);
    await sleep(250);
  }
}

function startForexPolling() {
  if (!POLYGON_API_KEY) return;

  const run = async () => {
    if (forexPollRunning) return;
    forexPollRunning = true;
    try {
      await pollAllForex();
    } finally {
      forexPollRunning = false;
    }
  };

  run();
  setInterval(run, FOREX_POLL_INTERVAL_MS);
}

function startLiveFallbackPolling() {
  if (!POLYGON_API_KEY) return;

  const run = async () => {
    if (liveFallbackPollRunning) return;
    liveFallbackPollRunning = true;
    try {
      await pollLiveFallback();
    } finally {
      liveFallbackPollRunning = false;
    }
  };

  run();
  setInterval(run, LIVE_FALLBACK_INTERVAL_MS);
}

function startWebsockets() {
  if (!relayState.websocketEnabled) return;

  const cryptoParams = CRYPTO_SYMBOLS.map((s) => `XAS.${toCryptoPair(ASSET_CATALOG[s].ticker)}`).join(',');
  const stocksParams = STOCK_SYMBOLS.map((s) => `A.${s}`).join(',');

  activeStreams.crypto = new PolygonStream(
    'crypto',
    CRYPTO_WS_URL,
    (ws) => ws?.send(JSON.stringify({ action: 'subscribe', params: cryptoParams })),
    (msg) => {
      if (msg.ev === 'XAS' && msg.pair) {
        const symbol = CRYPTO_PAIR_TO_SYMBOL[normalizeCryptoPair(msg.pair)];
        if (symbol && Number.isFinite(msg.c) && msg.c > 0) {
          setPrice(symbol, roundPrice(msg.c, 6));
        }
      }
    },
  );

  activeStreams.stocks = new PolygonStream(
    'stocks',
    STOCKS_WS_URL,
    (ws) => ws?.send(JSON.stringify({ action: 'subscribe', params: stocksParams })),
    (msg) => {
      if ((msg.ev === 'A' || msg.ev === 'AM') && msg.sym && Number.isFinite(msg.c) && msg.c > 0) {
        setPrice(msg.sym, roundPrice(msg.c, 4));
      }
      if (msg.ev === 'Q' && msg.sym) {
        const bid = Number(msg.bp);
        const ask = Number(msg.ap);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          setPrice(msg.sym, roundPrice((bid + ask) / 2, 4));
        }
      }
    },
  );

  activeStreams.crypto.start();
  activeStreams.stocks.start();
}

function startRelay() {
  if (!POLYGON_API_KEY) {
    relayState.websocketEnabled = false;
    relayState.websocketDisableReason = 'missing_polygon_api_key';
    console.error('[relay] POLYGON_API_KEY missing.');
  } else if (!USE_WEBSOCKETS) {
    relayState.websocketEnabled = false;
    relayState.websocketDisableReason = 'websockets_disabled_by_env';
  }

  startWebsockets();
  startForexPolling();
  startLiveFallbackPolling();
}

const app = express();
app.use(cors());

app.get('/health', (_req, res) => {
  res.json({ ok: true, relay: relaySnapshot() });
});

app.get(['/prices', '/'], (_req, res) => {
  res.json({ prices, relay: relaySnapshot() });
});

app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', prices, relay: relaySnapshot() })}\n\n`);

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {}
  }, 30000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

startRelay();

app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
