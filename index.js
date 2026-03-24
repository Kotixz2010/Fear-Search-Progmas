try { require('dotenv').config(); } catch (e) {}

const http = require('http');
const { createApp } = require('./server.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

console.log(`[FearSearch] Starting on PORT=${PORT} (process.env.PORT=${process.env.PORT})`);

const app = createApp();
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
    console.log(`[FearSearch] Server running on http://${HOST}:${PORT}`);
});

// Graceful shutdown для Railway
process.on('SIGTERM', () => {
    console.log('[FearSearch] SIGTERM received, shutting down gracefully');
    server.close(() => process.exit(0));
});
