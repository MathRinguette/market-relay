# Market Relay (Railway)

This service keeps Polygon market data off the browser and exposes a single shared relay:

- `GET /prices` -> latest prices + relay state
- `GET /health` -> health + relay state
- `GET /sse` -> optional server-sent events stream

## Env Vars

- `POLYGON_API_KEY` (required)
- `MARKET_RELAY_USE_WEBSOCKETS` (default: `true`)
- `POLYGON_STOCKS_WS_URL` (default: `wss://delayed.polygon.io/stocks`)
- `POLYGON_CRYPTO_WS_URL` (default: `wss://socket.polygon.io/crypto`)
- `PORT` (default: `8080`)

## Local Run

```bash
cd relay
npm install
POLYGON_API_KEY=your_key npm start
```

## Docker

```bash
cd relay
docker build -t market-relay .
docker run -p 8080:8080 -e POLYGON_API_KEY=your_key market-relay
```

## Railway Deploy

1. Create a new Railway project from this repo.
2. Set root directory to `relay`.
3. Ensure the entry file `relay/server.js` exists in the deployed branch.
4. Add env vars above.
5. Set replicas to `1`.
6. Deploy.

## Frontend Wiring

In your app env:

```bash
VITE_MARKET_RELAY_URL=https://your-railway-service.up.railway.app
```

When this value is set, `BackendMarketClient` reads from Railway `/prices`.
