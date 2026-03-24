try { require('dotenv').config(); } catch (e) {}

const http = require('http');
const { createApp } = require('./server.js');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Railway требует 0.0.0.0

const app = createApp();
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
    console.log(`[FearSearch] Server running on http://${HOST}:${PORT}`);
});
