const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

try { require('dotenv').config(); } catch (e) {}

const STEAM_API_KEY = process.env.STEAM_API_KEY || process.env._FSK || '';

// Основной файл со списком (используется приложением напрямую)
const ADMINS_LOCAL_PATH = path.join(__dirname, 'admins.json');
// Кэш в домашней папке (резервная копия)
const ADMINS_CACHE_PATH = path.join(os.homedir(), 'fearsearch_admins.json');

// Группы которые считаются "покупными"
const PAID_GROUPS = new Set(['ADMIN', 'ADMIN+']);
// Группы стаффа
const STAFF_GROUPS = new Set(['STAFF', 'STADMIN', 'STMODER', 'MODER', 'MLMODER', 'MEDIA']);

// Иерархия групп — чем меньше число, тем выше ранг
const GROUP_RANK = {
    'STAFF': 1, 'STADMIN': 2, 'STMODER': 3,
    'MODER': 4, 'MLMODER': 5, 'MEDIA': 6,
    'ADMIN+': 7, 'ADMIN': 8,
};

// ── Загрузка/сохранение ───────────────────────
function loadLocalAdmins() {
    try {
        if (fs.existsSync(ADMINS_LOCAL_PATH)) {
            return JSON.parse(fs.readFileSync(ADMINS_LOCAL_PATH, 'utf8'));
        }
    } catch (e) { console.warn('[admins] local read error:', e.message); }
    return [];
}

function saveLocalAdmins(admins) {
    try {
        fs.writeFileSync(ADMINS_LOCAL_PATH, JSON.stringify(admins, null, 2), 'utf8');
        console.log(`[admins] saved ${admins.length} entries to admins.json`);
    } catch (e) { console.warn('[admins] local write error:', e.message); }
}

function loadAdminsCache() {
    try {
        if (fs.existsSync(ADMINS_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(ADMINS_CACHE_PATH, 'utf8'));
        }
    } catch (e) { console.warn('admins cache read error:', e.message); }
    return null;
}

function saveAdminsCache(data) {
    try {
        fs.writeFileSync(ADMINS_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) { console.warn('admins cache write error:', e.message); }
}

// Нормализация group_name с сайта к нашим константам
function normalizeGroupName(raw) {
    if (!raw) return raw;
    const s = raw.trim();
    // Точное совпадение
    if (PAID_GROUPS.has(s) || STAFF_GROUPS.has(s)) return s;
    // Маппинг русских/альтернативных названий
    const MAP = {
        'Админ+': 'ADMIN+', 'Админ +': 'ADMIN+', 'Admin+': 'ADMIN+',
        'Админ': 'ADMIN', 'Admin': 'ADMIN',
        'Стафф': 'STAFF', 'Staff': 'STAFF',
        'Ст. Администратор': 'STADMIN', 'StAdmin': 'STADMIN',
        'Ст. Модер': 'STMODER', 'StModer': 'STMODER',
        'Модератор': 'MODER', 'Moder': 'MODER',
        'Мл. Модератор': 'MLMODER', 'MlModer': 'MLMODER',
        'Медиа': 'MEDIA', 'Media': 'MEDIA',
    };
    return MAP[s] || s;
}

// ── Мерж: обновляем всех с сайта, но не понижаем стафф ──
// Правила:
//   - Покупные (ADMIN/ADMIN+): всегда перезаписываются с сайта
//   - Стафф: если человек уже есть локально — не понижаем группу (только повышаем или оставляем)
//   - Новые с сайта: добавляются как есть
//   - Удалённые с сайта покупные: удаляются из локального (если сайт вернул полный список)
function mergeAdmins(localAdmins, siteAdmins) {
    const normalized = siteAdmins.map(a => ({ ...a, group_name: normalizeGroupName(a.group_name) }));

    const uniqueGroups = [...new Set(normalized.map(a => a.group_name))];
    console.log('[admins] группы с сайта:', uniqueGroups.join(', '));
    console.log(`[admins] всего с сайта: ${normalized.length}`);

    // Строим карту локальных записей по steamid
    const localMap = {};
    for (const a of localAdmins) localMap[a.steamid] = { ...a };

    // Карта записей с сайта по steamid
    const siteMap = {};
    for (const a of normalized) siteMap[a.steamid] = a;

    let added = 0, updated = 0, kept = 0;
    const result = {};

    // 1. Обрабатываем всех с сайта
    for (const [steamid, siteEntry] of Object.entries(siteMap)) {
        const local = localMap[steamid];

        if (!local) {
            // Новый — добавляем как есть
            result[steamid] = siteEntry;
            added++;
        } else if (PAID_GROUPS.has(siteEntry.group_name)) {
            // Покупной — всегда обновляем с сайта (ник, аватар, заморозка, группа)
            const avatar_full = siteEntry.avatar_full || local.avatar_full;
            result[steamid] = { ...local, ...siteEntry, avatar_full };
            if (local.group_name !== siteEntry.group_name || local.name !== siteEntry.name || local.is_frozen !== siteEntry.is_frozen) updated++;
            else kept++;
        } else {
            // Стафф — не понижаем группу
            const localRank = GROUP_RANK[local.group_name] ?? 99;
            const siteRank  = GROUP_RANK[siteEntry.group_name] ?? 99;
            const avatar_full = siteEntry.avatar_full || local.avatar_full;

            if (siteRank < localRank) {
                // Повышение — обновляем группу
                result[steamid] = { ...local, ...siteEntry, avatar_full };
                console.log(`[admins] повышение: ${siteEntry.name} ${local.group_name} → ${siteEntry.group_name}`);
                updated++;
            } else {
                // Оставляем текущую группу, но обновляем ник/аватар/заморозку
                result[steamid] = { ...local, name: siteEntry.name || local.name, avatar_full, is_frozen: siteEntry.is_frozen ?? local.is_frozen };
                if (local.name !== siteEntry.name) updated++;
                else kept++;
            }
        }
    }

    // 2. Локальные записи которых нет на сайте
    for (const [steamid, local] of Object.entries(localMap)) {
        if (result[steamid]) continue; // уже обработан

        if (PAID_GROUPS.has(local.group_name)) {
            // Покупной которого нет на сайте — удаляем (сайт вернул полный список)
            console.log(`[admins] удалён покупной (нет на сайте): ${local.name} (${steamid})`);
        } else {
            // Стафф которого нет на сайте — оставляем (управляется вручную)
            result[steamid] = local;
            kept++;
        }
    }

    const merged = Object.values(result);
    const staffCount = merged.filter(a => STAFF_GROUPS.has(a.group_name)).length;
    const paidCount  = merged.filter(a => PAID_GROUPS.has(a.group_name)).length;
    console.log(`[admins] merge: staff=${staffCount}, paid=${paidCount}, новых=${added}, обновлено=${updated}, без изменений=${kept}`);
    return { admins: merged, added, updated };
}

// ── Получение списка админов с fearproject ────
// API требует куку access_token — используем https напрямую (fetch игнорирует Cookie к чужим доменам)
async function fetchAdminsFromFear(token) {
    const list = await _httpsGetJson('api.fearproject.ru', '/admins', token);
    if (list && list.length > 0) {
        console.log(`[admins] получено ${list.length} записей`);
        console.log(`[admins] пример:`, JSON.stringify(list[0]).slice(0, 200));
        return list;
    }
    console.log('[admins] /admins вернул пустой список или ошибку');
    return null;
}

// Прямой HTTPS запрос с кукой (обходит ограничения fetch на Cookie заголовок)
function _httpsGetJson(host, path, token) {
    return new Promise((resolve) => {
        const https = require('https');
        const options = {
            hostname: host,
            path: path,
            method: 'GET',
            headers: {
                'Cookie': `access_token=${token}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://fearproject.ru/',
                'Origin': 'https://fearproject.ru',
            },
            timeout: 15000,
        };
        const req = https.request(options, (res) => {
            console.log(`[admins] https ${host}${path} -> ${res.statusCode}`);
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const list = Array.isArray(data) ? data
                        : (data.admins || data.data || data.items || data.list || data.result || []);
                    resolve(list.length > 0 ? list : null);
                } catch (e) {
                    console.log(`[admins] JSON parse error: ${e.message}, body: ${body.slice(0, 100)}`);
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => { console.log(`[admins] https error: ${e.message}`); resolve(null); });
        req.on('timeout', () => { req.destroy(); console.log('[admins] https timeout'); resolve(null); });
        req.end();
    });
}

// Парсинг HTML страницы — ищем JSON данные (Next.js __NEXT_DATA__ или таблицу)
function parseAdminsFromHtml(html) {
    // Вариант 1: Next.js __NEXT_DATA__ JSON
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
        try {
            const nextData = JSON.parse(nextDataMatch[1]);
            const found = findAdminsInObject(nextData);
            if (found && found.length > 0) {
                console.log(`[admins] найдено ${found.length} записей в __NEXT_DATA__`);
                return normalizeAdminsList(found);
            }
        } catch (e) {
            console.log('[admins] __NEXT_DATA__ parse error:', e.message);
        }
    }

    // Вариант 2: inline JSON массив с steamid или steam_id
    const jsonArrayMatch = html.match(/\[\s*\{[^[\]]{10,}"(?:steamid|steam_id)"[^[\]]*\}\s*(?:,\s*\{[^[\]]*\}\s*)*\]/);
    if (jsonArrayMatch) {
        try {
            const arr = JSON.parse(jsonArrayMatch[0]);
            if (Array.isArray(arr) && arr.length > 0 && (arr[0].steamid || arr[0].steam_id)) {
                console.log(`[admins] найдено ${arr.length} записей в inline JSON`);
                return normalizeAdminsList(arr);
            }
        } catch {}
    }

    // Вариант 3: парсинг HTML таблицы
    const admins = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const steamRegex = /76561\d{11}/;
    const rows = html.match(rowRegex) || [];

    for (const row of rows) {
        const cells = [];
        let m;
        cellRegex.lastIndex = 0;
        while ((m = cellRegex.exec(row)) !== null) {
            cells.push(m[1].replace(/<[^>]+>/g, '').trim());
        }
        if (cells.length < 2) continue;
        const steamMatch = row.match(steamRegex);
        if (!steamMatch) continue;
        admins.push({
            steamid: steamMatch[0],
            name: cells.find(c => c.length > 0 && !c.match(/^\d+$/)) || '',
            group_name: cells[cells.length - 1] || '',
            group_display_name: cells[cells.length - 1] || '',
            is_frozen: row.toLowerCase().includes('frozen') || row.includes('заморожен'),
        });
    }

    console.log(`[admins] HTML таблица: ${admins.length} записей`);
    return admins;
}

// Нормализация списка — приводим разные форматы к единому виду
function normalizeAdminsList(list) {
    return list.map(a => {
        const steamid = a.steamid || a.steam_id || a.steamId || '';
        const groupName = normalizeGroupName(a.group_name || a.groupName || a.group || a.role || '');
        const groupDisplay = a.group_display_name || a.groupDisplayName || a.group_title || groupName;
        // Аватар — берём наибольший доступный
        const avatar = a.avatar_full || a.avatarFull || a.avatar_medium || a.avatarMedium || a.avatar || '';
        return {
            steamid,
            name: a.name || a.nickname || a.username || steamid,
            group_name: groupName,
            group_display_name: groupDisplay,
            is_frozen: !!(a.is_frozen || a.isFrozen || a.frozen || false),
            avatar_full: avatar,
            avatar_medium: a.avatar_medium || a.avatarMedium || a.avatar || avatar,
            avatar: a.avatar || avatar,
        };
    }).filter(a => a.steamid && a.steamid.length >= 17);
}

// Рекурсивный поиск массива с admins в объекте
function findAdminsInObject(obj, depth = 0) {
    if (depth > 10) return null;
    if (Array.isArray(obj)) {
        if (obj.length > 0 && obj[0] && (obj[0].steamid || obj[0].steam_id || obj[0].steamId) && (obj[0].group_name || obj[0].groupName || obj[0].group || obj[0].role)) {
            return obj;
        }
        for (const item of obj) {
            const found = findAdminsInObject(item, depth + 1);
            if (found) return found;
        }
    } else if (obj && typeof obj === 'object') {
        // Приоритет ключам с говорящими именами
        const priorityKeys = ['admins', 'administrators', 'list', 'data', 'items', 'result', 'users'];
        for (const key of priorityKeys) {
            if (obj[key]) {
                const found = findAdminsInObject(obj[key], depth + 1);
                if (found) return found;
            }
        }
        for (const key of Object.keys(obj)) {
            if (priorityKeys.includes(key)) continue;
            const found = findAdminsInObject(obj[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// ── Автосинхронизация каждый час ──────────────
let autoSyncTimer = null;
let lastSyncToken = null;
let lastSyncAt = null;
let lastSyncResult = null; // { added, updated, total }

async function syncAdminsFromSite(token) {
    if (!token) return;
    console.log('[admins] запуск синхронизации с fearproject.ru...');
    const siteAdmins = await fetchAdminsFromFear(token);
    if (!siteAdmins || siteAdmins.length === 0) {
        console.warn('[admins] синхронизация не удалась — сайт не вернул данные');
        return null;
    }

    const local = loadLocalAdmins();
    const { admins: merged, added, updated } = mergeAdmins(local, siteAdmins);

    saveLocalAdmins(merged);
    lastSyncAt = new Date().toISOString();
    lastSyncResult = { added, updated, total: merged.length };

    saveAdminsCache({ savedAt: lastSyncAt, total: merged.length, admins: merged, token: lastSyncToken });

    console.log(`[admins] синхронизация завершена: всего ${merged.length}, новых покупных: ${added}, обновлено: ${updated}`);
    return { total: merged.length, added, updated };
}

function startAutoSync(token) {
    lastSyncToken = token;
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    // Каждый час
    autoSyncTimer = setInterval(() => {
        console.log('[admins] плановая синхронизация (каждый час)');
        syncAdminsFromSite(lastSyncToken);
    }, 60 * 60 * 1000);
    console.log('[admins] автосинхронизация запущена (каждый час)');
}

// ── Восстановление токена при старте сервера ──
// Читаем сохранённый токен из кеша и сразу запускаем синхронизацию
function tryRestoreTokenAndSync() {
    try {
        const cache = loadAdminsCache();
        if (cache && cache.token) {
            console.log('[admins] найден сохранённый токен, запускаем синхронизацию при старте...');
            lastSyncToken = cache.token;
            startAutoSync(cache.token);
            // Синхронизируем сразу при старте (через 3 сек чтобы сервер успел подняться)
            setTimeout(() => syncAdminsFromSite(cache.token), 3000);
        } else {
            console.log('[admins] токен не найден в кеше, синхронизация запустится после логина');
        }
    } catch (e) {
        console.warn('[admins] ошибка восстановления токена:', e.message);
    }
}

function createApp() {
    const app = express();

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname)));

    app.use((req, _res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
    });

    // Восстанавливаем токен и запускаем синхронизацию при старте
    tryRestoreTokenAndSync();

    // Прокси для fearproject.ru
    app.get('/api/servers', async (_req, res) => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            const response = await fetch('https://api.fearproject.ru/servers/', {
                headers: { 'User-Agent': 'FearSearch/1.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`FearProject API error: ${response.status}`);
            res.json(await response.json());
        } catch (error) {
            console.error('Error fetching servers:', error);
            res.status(500).json({ error: 'Failed to fetch servers', details: error.message });
        }
    });

    // Даты аккаунтов (батч до 100)
    app.post('/api/steam/accountdates', async (req, res) => {
        const steamIds = req.body.steamids;
        if (!steamIds || !Array.isArray(steamIds) || steamIds.length === 0 || steamIds.length > 100) {
            return res.status(400).json({ error: 'Invalid steamids array (max 100)' });
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamIds.join(',')}`;
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`Steam API error: ${response.status}`);
            const data = await response.json();
            const results = {};
            if (data.response && data.response.players) {
                for (const player of data.response.players) {
                    results[player.steamid] = {
                        timecreated: player.timecreated || null,
                        date: player.timecreated ? new Date(player.timecreated * 1000).toISOString() : null,
                        lastlogoff: player.lastlogoff || null,
                        lastlogoffDate: player.lastlogoff ? new Date(player.lastlogoff * 1000).toISOString() : null,
                    };
                }
            }
            res.json(results);
        } catch (error) {
            console.error('Steam API batch error:', error.message);
            res.json({});
        }
    });

    // VAC баны (батч до 100)
    app.post('/api/steam/vacbans', async (req, res) => {
        const steamIds = req.body.steamids;
        if (!steamIds || !Array.isArray(steamIds) || steamIds.length === 0 || steamIds.length > 100) {
            return res.status(400).json({ error: 'Invalid steamids array (max 100)' });
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamIds.join(',')}`;
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`Steam API error: ${response.status}`);
            const data = await response.json();
            const results = {};
            if (data.players) {
                for (const player of data.players) {
                    results[player.SteamId] = {
                        vacBanned: player.VACBanned,
                        numberOfVACBans: player.NumberOfVACBans,
                        daysSinceLastBan: player.DaysSinceLastBan,
                        numberOfGameBans: player.NumberOfGameBans,
                        communityBanned: player.CommunityBanned,
                        economyBan: player.EconomyBan
                    };
                }
            }
            res.json(results);
        } catch (error) {
            console.error('Steam VAC API error:', error.message);
            res.json({});
        }
    });

    // Steam API - профиль одного игрока (ник + аватар)
    app.get('/api/steam/profile/:steamid', async (req, res) => {
        const steamId = req.params.steamid;
        if (!steamId || steamId.length < 17) return res.status(400).json({ error: 'Invalid SteamID' });
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`Steam API error: ${response.status}`);
            const data = await response.json();
            if (data.response?.players?.length > 0) {
                const p = data.response.players[0];
                return res.json({ nickname: p.personaname, avatar: p.avatarmedium || p.avatar });
            }
            res.status(404).json({ error: 'Not found' });
        } catch (error) {
            res.status(404).json({ error: 'Steam API unavailable' });
        }
    });

    // CSGO серверы — опрос через Steam Master Server / gameserverquery
    app.get('/api/csgo/servers', async (_req, res) => {
        const CSGO_SERVERS = [
            { id: 'mirage1_1', name: 'MIRAGE #1 CSGO', ip: '85.119.149.157', port: 27059 },
            { id: 'mirage1_2', name: 'MIRAGE #1 CSGO', ip: '94.26.255.98',   port: 27030 },
            { id: 'dust1',     name: 'DUST #1 CSGO',   ip: '85.119.149.157', port: 27023 },
            { id: 'lake1',     name: 'LAKE #1 CSGO',   ip: '94.26.255.98',   port: 27029 },
        ];

        const results = await Promise.all(CSGO_SERVERS.map(async (srv) => {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 5000);
                // Steam Web API gameserverquery
                const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${STEAM_API_KEY}&filter=addr\\${srv.ip}:${srv.port}&limit=1`;
                const r = await fetch(url, { signal: controller.signal });
                if (!r.ok) return { ...srv, online: false, players: [], playerCount: 0, maxPlayers: 0, map: '' };
                const data = await r.json();
                const server = data.response?.servers?.[0];
                if (!server) return { ...srv, online: false, players: [], playerCount: 0, maxPlayers: 0, map: '' };
                return {
                    ...srv,
                    online: true,
                    playerCount: server.players || 0,
                    maxPlayers: server.max_players || 0,
                    map: server.map || '',
                    serverName: server.name || srv.name,
                };
            } catch {
                return { ...srv, online: false, players: [], playerCount: 0, maxPlayers: 0, map: '' };
            }
        }));

        res.json(results);
    });

    app.get('/', (_req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    // ── FearProject Auth & Admins ─────────────
    // Проверка профиля по токену + запуск автосинхронизации
    app.get('/api/fear/me', async (req, res) => {
        const token = req.headers['x-auth-token'] || req.query.token;
        if (!token) return res.status(401).json({ error: 'No token' });

        try {
            const profile = await _httpsGetJson('api.fearproject.ru', '/profile', token);
            if (!profile || profile.error) return res.status(401).json({ error: 'Invalid token' });
            // Сохраняем токен и запускаем автосинхронизацию
            lastSyncToken = token;
            saveAdminsCache({ ...(loadAdminsCache() || {}), token });
            startAutoSync(token);
            res.json(profile);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    // Получить список всех админов (из локального файла)
    app.get('/api/fear/admins', async (req, res) => {
        const token = req.headers['x-auth-token'] || req.query.token;
        const forceRefresh = req.query.refresh === '1';

        if (forceRefresh && token) {
            const result = await syncAdminsFromSite(token);
            if (result) {
                const admins = loadLocalAdmins();
                return res.json({ admins, savedAt: lastSyncAt, fromCache: false, synced: true, ...result });
            }
        }

        // Отдаём локальный файл (он всегда актуален — обновляется автосинхронизацией)
        const admins = loadLocalAdmins();
        if (admins.length > 0) {
            return res.json({ admins, savedAt: lastSyncAt, fromCache: false });
        }

        res.status(500).json({ error: 'Could not load admins' });
    });

    // Принудительная синхронизация с сайтом
    app.post('/api/fear/admins/refresh', async (req, res) => {
        const token = req.headers['x-auth-token'] || req.body?.token;
        if (!token) return res.status(401).json({ error: 'No token' });
        const result = await syncAdminsFromSite(token);
        if (result) {
            lastSyncToken = token;
            return res.json({ success: true, savedAt: lastSyncAt, path: ADMINS_LOCAL_PATH, ...result });
        }
        res.status(500).json({ error: 'Failed to sync from fearproject' });
    });

    // Автодобавление новых админов замеченных на серверах
    // Вызывается из app.js при каждом updateData с игроками у которых is_admin=true
    app.post('/api/fear/admins/seen', (req, res) => {
        const players = req.body?.players; // [{ steam_id, nickname, avatar, admin_group }]
        if (!Array.isArray(players) || players.length === 0) return res.json({ added: 0 });

        const local = loadLocalAdmins();
        const localMap = new Set(local.map(a => a.steamid));

        let added = 0;
        for (const p of players) {
            const steamid = String(p.steam_id || '');
            if (!steamid || steamid.length < 17) continue;
            if (localMap.has(steamid)) continue; // уже есть

            // Определяем группу: если сервер вернул admin_group — нормализуем, иначе ADMIN
            const rawGroup = p.admin_group || p.group || '';
            const group_name = normalizeGroupName(rawGroup) || 'ADMIN';
            const group_display_name = group_name === 'ADMIN+' ? 'Админ+' : group_name === 'ADMIN' ? 'Админ' : group_name;

            local.push({
                steamid,
                name: p.nickname || steamid,
                group_name,
                group_display_name,
                is_frozen: false,
                avatar_full: p.avatar || '',
                avatar_medium: p.avatar || '',
                avatar: p.avatar || '',
            });
            localMap.add(steamid);
            added++;
            console.log(`[admins] автодобавлен с сервера: ${p.nickname} (${steamid}) группа=${group_name}`);
        }

        if (added > 0) saveLocalAdmins(local);
        res.json({ added });
    });

    // Статус синхронизации
    app.get('/api/fear/admins/status', (_req, res) => {
        const admins = loadLocalAdmins();
        res.json({
            total: admins.length,
            lastSyncAt,
            lastSyncResult,
            autoSyncActive: !!autoSyncTimer,
            path: ADMINS_LOCAL_PATH
        });
    });

    // ── Диагностика: что реально возвращает /admins API ──
    app.get('/api/fear/admins/debug', async (req, res) => {
        const token = req.headers['x-auth-token'] || req.query.token;
        if (!token) return res.status(401).json({ error: 'No token' });

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Cookie': `access_token=${token}`,
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://fearproject.ru/',
            'Origin': 'https://fearproject.ru',
        };

        const results = {};
        const urls = [
            'https://api.fearproject.ru/admins',
            'https://api.fearproject.ru/admin/admins',
            'https://api.fearproject.ru/admin/list',
        ];

        for (const url of urls) {
            try {
                const ctrl = new AbortController();
                setTimeout(() => ctrl.abort(), 8000);
                const r = await fetch(url, { headers, signal: ctrl.signal });
                const text = await r.text();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch {}
                const list = parsed ? (Array.isArray(parsed) ? parsed : (parsed.admins || parsed.data || parsed.items || [])) : [];
                results[url] = { status: r.status, count: list.length, sample: list[0] || null, raw: text.slice(0, 300) };
            } catch (e) {
                results[url] = { error: e.message };
            }
        }

        res.json(results);
    });

    // ── Диагностика: прямой вызов /admin/punishments/my ──
    app.get('/api/fear/punishments/debug', async (req, res) => {
        const authToken = req.headers['x-auth-token'] || req.query.token;
        if (!authToken) return res.status(401).json({ error: 'No token' });

        const headers = {
            'Accept': 'application/json',
            'Authorization': `Bearer ${authToken}`,
            'Cookie': `access_token=${authToken}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };

        const results = {};

        // Тест 1: /admin/punishments/my?type=1
        try {
            const r = await fetch('https://api.fearproject.ru/admin/punishments/my?type=1', { headers });
            const text = await r.text();
            results.my_type1 = { status: r.status, body: text.slice(0, 500) };
        } catch (e) { results.my_type1 = { error: e.message }; }

        // Тест 2: /admin/punishments/my (без type)
        try {
            const r = await fetch('https://api.fearproject.ru/admin/punishments/my', { headers });
            const text = await r.text();
            results.my_notype = { status: r.status, body: text.slice(0, 500) };
        } catch (e) { results.my_notype = { error: e.message }; }

        // Тест 3: /punishments?page=1 (публичный)
        try {
            const r = await fetch('https://api.fearproject.ru/punishments?page=1&limit=10&type=1', { headers });
            const data = await r.json();
            const items = data.punishments || data.data || data.items || [];
            results.public_p1 = { status: r.status, total: data.total, count: items.length, firstItem: items[0] || null };
        } catch (e) { results.public_p1 = { error: e.message }; }

        // Тест 4: /profile (кто я)
        try {
            const r = await fetch('https://api.fearproject.ru/profile', { headers });
            const data = await r.json();
            results.profile = { status: r.status, steamid: data.steamid, name: data.name, adminGroup: data.adminGroup };
        } catch (e) { results.profile = { error: e.message }; }

        res.json(results);
    });

    // ── Punishments (баны с fearproject.ru) ──────
    // Кеш хранится на диске: ~/fearsearch_bans_<steamid>.json
    const BANS_CACHE_DIR = os.homedir();

    function getBansCachePath(steamid) {
        return path.join(BANS_CACHE_DIR, `fearsearch_bans_${steamid}.json`);
    }

    function loadBansCache(steamid) {
        try {
            const p = getBansCachePath(steamid);
            if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {}
        return null;
    }

    function saveBansCache(steamid, data) {
        try {
            fs.writeFileSync(getBansCachePath(steamid), JSON.stringify(data, null, 2), 'utf8');
        } catch (e) { console.warn('[bans] cache write error:', e.message); }
    }

    app.get('/api/fear/punishments', async (req, res) => {
        const { admin_steamid, token } = req.query;
        const authToken = req.headers['x-auth-token'] || token;
        if (!admin_steamid) return res.status(400).json({ error: 'admin_steamid required' });

        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        };
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            headers['Cookie'] = `access_token=${authToken}`;
        }

        // Кеш с диска (раздельно баны и муты)
        const cached     = loadBansCache(admin_steamid);
        const cachedBans  = (cached?.bans  || []).map(b => ({ ...b, punish_type: 1 }));
        const cachedMutes = (cached?.mutes || []).map(b => ({ ...b, punish_type: 2 }));
        const cachedIds   = new Set([...cachedBans, ...cachedMutes].map(b => `${b.punish_type}_${b.id}`));

        // Загрузка одной страницы публичного API
        const fetchPublicPage = async (page, type) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
                const r = await fetch(`https://api.fearproject.ru/punishments?page=${page}&limit=10&type=${type}`, { headers, signal: controller.signal });
                clearTimeout(timeout);
                if (!r.ok) return { items: [], total: 0 };
                const data = await r.json();
                const items = (data.punishments || data.data || data.items || data.bans || (Array.isArray(data) ? data : []))
                    .map(b => ({ ...b, punish_type: type }));
                return { items, total: parseInt(data.total || '0', 10) };
            } catch { clearTimeout(timeout); return { items: [], total: 0 }; }
        };

        // Полный скан одного типа с умным кешем
        const scanType = async (type, cachedItems) => {
            const cachedTypeIds = new Set(cachedItems.map(b => b.id));
            const first = await fetchPublicPage(1, type);
            const totalPages = first.total > 0 ? Math.ceil(first.total / 10) : 1;
            const BATCH = 50;
            const allItems = [...first.items];

            if (cachedItems.length > 0) {
                let foundOld = first.items.some(b => cachedTypeIds.has(b.id));
                if (!foundOld) {
                    for (let start = 2; start <= totalPages && !foundOld; start += BATCH) {
                        const end = Math.min(start + BATCH - 1, totalPages);
                        const results = await Promise.all(
                            Array.from({ length: end - start + 1 }, (_, i) => fetchPublicPage(start + i, type))
                        );
                        for (const r of results) {
                            for (const item of r.items) {
                                if (cachedTypeIds.has(item.id)) { foundOld = true; break; }
                                allItems.push(item);
                            }
                            if (foundOld) break;
                        }
                    }
                }
                const newItems = allItems.filter(b => String(b.admin_steamid) === String(admin_steamid) && !cachedTypeIds.has(b.id));
                return [...newItems, ...cachedItems];
            }

            // Нет кеша — полный скан
            console.log(`[bans] full scan type=${type}: ${totalPages} pages`);
            for (let start = 2; start <= totalPages; start += BATCH) {
                const end = Math.min(start + BATCH - 1, totalPages);
                const results = await Promise.all(
                    Array.from({ length: end - start + 1 }, (_, i) => fetchPublicPage(start + i, type))
                );
                for (const r of results) allItems.push(...r.items);
                if (start % 500 === 2) console.log(`[bans] type=${type}: ${end}/${totalPages}`);
            }
            return allItems.filter(b => String(b.admin_steamid) === String(admin_steamid));
        };

        // Быстрый метод /admin/punishments/my
        const tryMyPunishments = async () => {
            const fetchMyPage = async (page, type) => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                try {
                    const r = await fetch(`https://api.fearproject.ru/admin/punishments/my?type=${type}&page=${page}`, { headers, signal: controller.signal });
                    clearTimeout(timeout);
                    if (!r.ok) return null;
                    const data = await r.json();
                    const items = (Array.isArray(data) ? data : (data.punishments || data.data || data.items || []))
                        .map(b => ({ ...b, punish_type: type }));
                    return { items, total: parseInt(data.total || '0', 10) };
                } catch { clearTimeout(timeout); return null; }
            };

            const loadAll = async (type) => {
                const first = await fetchMyPage(1, type);
                if (!first) return null;
                const totalPages = first.total > 0 ? Math.ceil(first.total / 10) : 1;
                const all = [...first.items];
                const BATCH = 50;
                for (let start = 2; start <= totalPages; start += BATCH) {
                    const end = Math.min(start + BATCH - 1, totalPages);
                    const results = await Promise.all(
                        Array.from({ length: end - start + 1 }, (_, i) => fetchMyPage(start + i, type))
                    );
                    for (const r of results) if (r) all.push(...r.items);
                }
                return all;
            };

            const [bansItems, mutesItems] = await Promise.all([loadAll(1), loadAll(2)]);
            if (!bansItems && !mutesItems) return null;
            return [...(bansItems || []), ...(mutesItems || [])];
        };

        try {
            let allPunishments = [];
            let method = 'public';

            // /my работает только если запрашиваем свой собственный аккаунт
            // Проверяем: steamid из токена совпадает с запрашиваемым?
            if (authToken) {
                try {
                    const profile = await _httpsGetJson('api.fearproject.ru', '/profile', authToken);
                    if (profile && !profile.error) {
                        const tokenSteamid = String(profile.steamid || profile.steam_id || '');
                        if (tokenSteamid && tokenSteamid === String(admin_steamid)) {
                            const myItems = await tryMyPunishments();
                            if (myItems !== null) {
                                allPunishments = myItems;
                                method = 'my';
                                console.log(`[bans] /my: ${myItems.filter(b=>b.punish_type===1).length} bans, ${myItems.filter(b=>b.punish_type===2).length} mutes`);
                            }
                        } else {
                            console.log(`[bans] чужой аккаунт (${admin_steamid} != ${tokenSteamid}), используем публичный скан`);
                        }
                    }
                } catch (e) { console.log(`[bans] profile check failed: ${e.message}`); }
            }

            if (method === 'public') {
                const [bansResult, mutesResult] = await Promise.all([
                    scanType(1, cachedBans),
                    scanType(2, cachedMutes),
                ]);
                allPunishments = [...bansResult, ...mutesResult];
            }

            allPunishments.sort((a, b) => b.created - a.created);
            const bans  = allPunishments.filter(b => b.punish_type === 1);
            const mutes = allPunishments.filter(b => b.punish_type === 2);
            const newCount = allPunishments.filter(b => !cachedIds.has(`${b.punish_type}_${b.id}`)).length;

            saveBansCache(admin_steamid, { bans, mutes, updatedAt: new Date().toISOString(), method });
            console.log(`[bans] done via ${method}: ${bans.length} bans, ${mutes.length} mutes, +${newCount} new`);
            res.json({ bans, mutes, total: allPunishments.length, newCount, fromCache: (cachedBans.length + cachedMutes.length) > 0, method });

        } catch (e) {
            console.error('[bans] error:', e.message);
            if (cachedBans.length + cachedMutes.length > 0) {
                return res.json({ bans: cachedBans, mutes: cachedMutes, total: cachedBans.length + cachedMutes.length, newCount: 0, fromCache: true, error: e.message });
            }
            res.status(500).json({ error: e.message });
        }
    });

    return app;
}

module.exports = { createApp };
