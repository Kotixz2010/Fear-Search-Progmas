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

// Получение JSON-объекта (не списка) — для /profile и подобных эндпоинтов
function _httpsGetJsonObject(host, path, token) {
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
            console.log(`[auth] profile ${host}${path} -> ${res.statusCode}`);
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    console.log(`[auth] profile response: steamid=${data.steamid}, adminGroup=${data.adminGroup}`);
                    resolve(data);
                } catch (e) {
                    console.log(`[auth] profile parse error: ${e.message}, body: ${body.slice(0, 200)}`);
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => { console.log(`[auth] profile error: ${e.message}`); resolve(null); });
        req.on('timeout', () => { req.destroy(); console.log('[auth] profile timeout'); resolve(null); });
        req.end();
    });
}

// Запрос с Authorization: Bearer (альтернативный метод авторизации)
function _httpsGetJsonBearer(host, path, token) {
    return new Promise((resolve) => {
        const https = require('https');
        const options = {
            hostname: host,
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://fearproject.ru/',
                'Origin': 'https://fearproject.ru',
            },
            timeout: 15000,
        };
        const req = https.request(options, (res) => {
            console.log(`[auth] bearer ${host}${path} -> ${res.statusCode}`);
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// Парсим JWT payload — берём steamid/client_id из токена без обращения к API
function _parseJwtProfile(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        console.log('[auth] JWT payload:', JSON.stringify(payload));
        // fearproject кладёт steamid в client_id или steamid
        const steamid = String(payload.client_id || payload.steamid || payload.steam_id || payload.sub || '');
        if (!steamid || steamid.length < 17) return null;

        // Ищем в admins.json — берём имя/аватар если есть, но не блокируем вход
        const adminEntry = _getAdminEntryFromLocal(steamid);

        return {
            steamid,
            steam_id: steamid,
            name: adminEntry?.name || payload.name || payload.nickname || steamid,
            adminGroup: adminEntry?.group_name || 'ADMIN', // даём доступ если токен валидный JWT
            avatar_medium: adminEntry?.avatar_full || payload.avatar || '',
            avatar: adminEntry?.avatar_full || payload.avatar || '',
            _fromJwt: true,
        };
    } catch (e) {
        console.log('[auth] JWT parse error:', e.message);
        return null;
    }
}

// Ищем запись пользователя в локальном admins.json
function _getAdminEntryFromLocal(steamid) {
    try {
        const admins = loadLocalAdmins();
        return admins.find(a => String(a.steamid) === String(steamid)) || null;
    } catch { return null; }
}

function _getAdminGroupFromLocal(steamid) {
    const entry = _getAdminEntryFromLocal(steamid);
    return entry ? entry.group_name : null;
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

    // Прокси для fearproject.ru — с кешем на 4 секунды
    let _serversCache = null;
    let _serversCacheAt = 0;
    app.get('/api/servers', async (_req, res) => {
        // Отдаём кеш если он свежее 4 секунд
        if (_serversCache && Date.now() - _serversCacheAt < 4000) {
            return res.json(_serversCache);
        }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const response = await fetch('https://api.fearproject.ru/servers/', {
                headers: { 'User-Agent': 'FearSearch/1.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`FearProject API error: ${response.status}`);
            _serversCache = await response.json();
            _serversCacheAt = Date.now();
            res.json(_serversCache);
        } catch (error) {
            // Отдаём старый кеш если есть
            if (_serversCache) return res.json(_serversCache);
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
            const timeout = setTimeout(() => controller.abort(), 4000);
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
            const timeout = setTimeout(() => controller.abort(), 4000);
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
            const timeout = setTimeout(() => controller.abort(), 4000);
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
            // Получаем профиль — используем правильный метод для объекта (не списка)
            let profile = await _httpsGetJsonObject('api.fearproject.ru', '/profile', token);

            // Если не вышло через Cookie — пробуем Bearer
            if (!profile || profile.error) {
                profile = await _httpsGetJsonBearer('api.fearproject.ru', '/profile', token);
            }

            // Последний fallback — парсим JWT напрямую
            if (!profile || profile.error) {
                profile = _parseJwtProfile(token);
            }

            if (!profile) {
                return res.status(401).json({ error: 'Invalid token' });
            }

            // Проверяем adminGroup — должна быть не null и не 0
            const adminGroup = profile.adminGroup;
            const sid = profile.steamid || profile.steam_id || '';
            const isManualStaff = sid === '76561198751025670'; // владелец всегда имеет доступ
            if (!isManualStaff && (adminGroup === null || adminGroup === undefined || adminGroup === 0)) {
                return res.status(403).json({ error: 'No admin rights', name: profile.name, adminGroup });
            }

            // Если JWT fallback и нет имени — подтягиваем из Steam API
            if (profile._fromJwt && profile.name === sid && STEAM_API_KEY) {
                try {
                    const steamRes = await fetch(
                        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${sid}`,
                        { signal: AbortSignal.timeout(5000) }
                    );
                    if (steamRes.ok) {
                        const steamData = await steamRes.json();
                        const p = steamData.response?.players?.[0];
                        if (p) {
                            profile.name = p.personaname || profile.name;
                            profile.avatar_medium = p.avatarmedium || profile.avatar_medium;
                            profile.avatar = p.avatar || profile.avatar;
                        }
                    }
                } catch {}
            }

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

    // ── Bulk загрузка наказаний для всего стаффа за один проход ──
    // Грузит все наказания сервера один раз и фильтрует по списку steamid
    app.get('/api/fear/punishments/bulk', async (req, res) => {
        const authToken = req.headers['x-auth-token'] || req.query.token;
        const steamids = (req.query.steamids || '').split(',').filter(Boolean);
        if (!steamids.length) return res.status(400).json({ error: 'steamids required' });

        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Authorization': `Bearer ${authToken}`,
            'Cookie': `access_token=${authToken}`,
            'Referer': 'https://fearproject.ru/',
        };

        const steamidSet = new Set(steamids.map(String));
        const result = {}; // steamid -> { bans: [], mutes: [] }
        for (const sid of steamids) result[sid] = { bans: [], mutes: [] };

        const extractItems = (data) => {
            if (Array.isArray(data)) return data;
            return data.punishments || data.data || data.items || data.bans || [];
        };

        const scanType = async (type) => {
            // Первая страница — узнаём total
            const first = await fetch(
                `https://api.fearproject.ru/punishments?type=${type}&page=1&limit=100`,
                { headers, signal: AbortSignal.timeout(15000) }
            ).then(r => r.ok ? r.json() : null).catch(() => null);

            if (!first) return;
            const items = extractItems(first);
            const total = parseInt(first.total || '0', 10) || items.length;
            const totalPages = Math.max(1, Math.ceil(total / 100));
            console.log(`[bulk] type=${type}: total=${total} pages=${totalPages}`);

            // Обрабатываем первую страницу
            for (const b of items) {
                const sid = String(b.admin_steamid || b.adminSteamid || b.admin?.steamid || '');
                if (steamidSet.has(sid)) {
                    result[sid][type === 1 ? 'bans' : 'mutes'].push({ ...b, punish_type: type });
                }
            }

            // Грузим остальные страницы батчами по 20
            const BATCH = 20;
            for (let p = 2; p <= totalPages; p += BATCH) {
                const batch = Array.from({ length: Math.min(BATCH, totalPages - p + 1) }, (_, i) =>
                    fetch(`https://api.fearproject.ru/punishments?type=${type}&page=${p+i}&limit=100`, { headers, signal: AbortSignal.timeout(15000) })
                        .then(r => r.ok ? r.json() : null).catch(() => null)
                );
                const pages = await Promise.all(batch);
                for (const page of pages) {
                    if (!page) continue;
                    for (const b of extractItems(page)) {
                        const sid = String(b.admin_steamid || b.adminSteamid || b.admin?.steamid || '');
                        if (steamidSet.has(sid)) {
                            result[sid][type === 1 ? 'bans' : 'mutes'].push({ ...b, punish_type: type });
                        }
                    }
                }
            }
        };

        try {
            // Грузим баны и муты параллельно
            await Promise.all([scanType(1), scanType(2)]);

            // Сохраняем кеш для каждого
            for (const [sid, data] of Object.entries(result)) {
                saveBansCache(sid, { ...data, updatedAt: new Date().toISOString(), method: 'bulk' });
            }

            const summary = Object.fromEntries(
                Object.entries(result).map(([sid, d]) => [sid, { bans: d.bans.length, mutes: d.mutes.length }])
            );
            console.log('[bulk] done:', JSON.stringify(summary));
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Наказания конкретного стаффа — прямой запрос к API ──
    app.get('/api/fear/punishments/by-admin', async (req, res) => {
        const { admin_steamid } = req.query;
        const authToken = req.headers['x-auth-token'] || req.query.token;
        if (!admin_steamid) return res.status(400).json({ error: 'admin_steamid required' });

        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Authorization': `Bearer ${authToken}`,
            'Cookie': `access_token=${authToken}`,
            'Referer': 'https://fearproject.ru/',
        };

        const extractItems = (data) => {
            if (Array.isArray(data)) return data;
            return data.punishments || data.data || data.items || data.bans || [];
        };

        const fetchPage = async (type, page) => {
            try {
                const r = await fetch(
                    `https://api.fearproject.ru/punishments?admin_steamid=${admin_steamid}&type=${type}&page=${page}&limit=100`,
                    { headers, signal: AbortSignal.timeout(15000) }
                );
                if (!r.ok) { console.log(`[by-admin] ${type} p${page} -> ${r.status}`); return null; }
                return await r.json();
            } catch (e) { console.log(`[by-admin] fetch error: ${e.message}`); return null; }
        };

        const loadType = async (type) => {
            const first = await fetchPage(type, 1);
            if (!first) return [];
            const items = extractItems(first);
            const total = parseInt(first.total || '0', 10) || items.length;
            const totalPages = Math.max(1, Math.ceil(total / 100));
            console.log(`[by-admin] ${admin_steamid} type=${type}: total=${total} pages=${totalPages}`);
            const all = [...items];

            for (let p = 2; p <= totalPages; p += 10) {
                const batch = Array.from({ length: Math.min(10, totalPages - p + 1) }, (_, i) =>
                    fetchPage(type, p + i)
                );
                const results = await Promise.all(batch);
                for (const r of results) {
                    if (r) all.push(...extractItems(r));
                }
            }

            // Фильтруем строго по steamid
            const filtered = all.filter(b => {
                const sid = String(b.admin_steamid || b.adminSteamid || b.admin?.steamid || '');
                return sid === String(admin_steamid);
            }).map(b => ({ ...b, punish_type: type }));

            console.log(`[by-admin] ${admin_steamid} type=${type}: got ${all.length} total, ${filtered.length} for this admin`);
            return filtered;
        };

        try {
            const [bans, mutes] = await Promise.all([loadType(1), loadType(2)]);
            // Дедупликация по id
            const dedupById = (arr) => {
                const seen = new Set();
                return arr.filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; });
            };
            const cleanBans  = dedupById(bans);
            const cleanMutes = dedupById(mutes);
            saveBansCache(admin_steamid, { bans: cleanBans, mutes: cleanMutes, updatedAt: new Date().toISOString(), method: 'by-admin' });
            res.json({ bans: cleanBans, mutes: cleanMutes, total: cleanBans.length + cleanMutes.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    // Использует публичный API с фильтром по steamid — быстрее чем полный скан
    app.get('/api/fear/punishments/stats', async (req, res) => {
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

        // Пробуем API с фильтром по steamid напрямую
        const fetchFiltered = async (type) => {
            try {
                // Пробуем с параметром admin_steamid
                const r = await fetch(
                    `https://api.fearproject.ru/punishments?admin_steamid=${admin_steamid}&type=${type}&limit=1`,
                    { headers, signal: AbortSignal.timeout(8000) }
                );
                if (!r.ok) return null;
                const data = await r.json();
                const total = parseInt(data.total || '0', 10);
                if (total > 0) return total; // API поддерживает фильтр
                return null;
            } catch { return null; }
        };

        // Если API поддерживает фильтр — используем его (быстро)
        const [bansTotal, mutesTotal] = await Promise.all([fetchFiltered(1), fetchFiltered(2)]);

        if (bansTotal !== null || mutesTotal !== null) {
            // Грузим все записи с фильтром
            const fetchAll = async (type, total) => {
                if (!total) return [];
                const pages = Math.ceil(total / 100);
                const all = [];
                for (let p = 1; p <= pages; p += 10) {
                    const batch = Array.from({ length: Math.min(10, pages - p + 1) }, (_, i) =>
                        fetch(`https://api.fearproject.ru/punishments?admin_steamid=${admin_steamid}&type=${type}&page=${p+i}&limit=100`, { headers, signal: AbortSignal.timeout(10000) })
                            .then(r => r.ok ? r.json() : null).catch(() => null)
                    );
                    const results = await Promise.all(batch);
                    for (const r of results) {
                        if (!r) continue;
                        all.push(...(r.punishments || r.data || r.items || []).map(b => ({ ...b, punish_type: type })));
                    }
                }
                return all;
            };
            const [bans, mutes] = await Promise.all([
                fetchAll(1, bansTotal || 0),
                fetchAll(2, mutesTotal || 0),
            ]);
            saveBansCache(admin_steamid, { bans, mutes, updatedAt: new Date().toISOString(), method: 'filtered' });
            return res.json({ bans, mutes, total: bans.length + mutes.length, fromCache: false, method: 'filtered' });
        }

        // Fallback — берём из кеша или делаем полный скан через основной эндпоинт
        const cached = loadBansCache(admin_steamid);
        if (cached?.bans?.length || cached?.mutes?.length) {
            const bans  = (cached.bans  || []).map(b => ({ ...b, punish_type: 1 }));
            const mutes = (cached.mutes || []).map(b => ({ ...b, punish_type: 2 }));
            return res.json({ bans, mutes, total: bans.length + mutes.length, fromCache: true, method: 'cache' });
        }

        res.json({ bans: [], mutes: [], total: 0, fromCache: false, method: 'none' });
    });

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

        const LIMIT = 100; // максимум на страницу

        // Кеш с диска
        const cached      = loadBansCache(admin_steamid);
        const cachedBans  = (cached?.bans  || []).map(b => ({ ...b, punish_type: 1 }));
        const cachedMutes = (cached?.mutes || []).map(b => ({ ...b, punish_type: 2 }));
        const cachedIds   = new Set([...cachedBans, ...cachedMutes].map(b => `${b.punish_type}_${b.id}`));

        // Если есть кеш — сразу отдаём его, фоновое обновление не делаем (слишком долго)
        // Кеш обновляется только при первом запросе или принудительно
        if (cachedBans.length + cachedMutes.length > 0 && req.query.force !== '1') {
            console.log(`[bans] serving from cache: ${cachedBans.length} bans, ${cachedMutes.length} mutes`);
            return res.json({
                bans: cachedBans, mutes: cachedMutes,
                total: cachedBans.length + cachedMutes.length,
                newCount: 0, fromCache: true, method: cached?.method || 'cache'
            });
        }

        // Загрузка одной страницы
        const fetchPage = async (url) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const r = await fetch(url, { headers, signal: controller.signal });
                clearTimeout(timeout);
                if (!r.ok) return null;
                return await r.json();
            } catch { clearTimeout(timeout); return null; }
        };

        // Быстрый метод — /admin/punishments/my (только свой аккаунт)
        const tryMyPunishments = async () => {
            const loadType = async (type) => {
                const first = await fetchPage(`https://api.fearproject.ru/admin/punishments/my?type=${type}&page=1&limit=${LIMIT}`);
                if (!first) return null;
                const items = (Array.isArray(first) ? first : (first.punishments || first.data || first.items || [])).map(b => ({ ...b, punish_type: type }));
                const total = parseInt(first.total || items.length, 10);
                const totalPages = Math.ceil(total / LIMIT) || 1;
                const all = [...items];
                // Грузим остальные страницы параллельно батчами по 20
                for (let p = 2; p <= totalPages; p += 20) {
                    const batch = Array.from({ length: Math.min(20, totalPages - p + 1) }, (_, i) =>
                        fetchPage(`https://api.fearproject.ru/admin/punishments/my?type=${type}&page=${p+i}&limit=${LIMIT}`)
                    );
                    const results = await Promise.all(batch);
                    for (const r of results) {
                        if (!r) continue;
                        const pg = (Array.isArray(r) ? r : (r.punishments || r.data || r.items || [])).map(b => ({ ...b, punish_type: type }));
                        all.push(...pg);
                    }
                }
                return all;
            };
            const [bans, mutes] = await Promise.all([loadType(1), loadType(2)]);
            if (!bans && !mutes) return null;
            return [...(bans || []), ...(mutes || [])];
        };

        // Публичный скан — ищем наказания конкретного админа по всем страницам
        const scanPublic = async (type, cachedItems) => {
            const cachedTypeIds = new Set(cachedItems.map(b => b.id));
            const first = await fetchPage(`https://api.fearproject.ru/punishments?page=1&limit=${LIMIT}&type=${type}`);
            if (!first) return cachedItems;
            const total = parseInt(first.total || '0', 10);
            const totalPages = Math.ceil(total / LIMIT) || 1;
            const allItems = (first.punishments || first.data || first.items || []).map(b => ({ ...b, punish_type: type }));

            // Если есть кеш — ищем только новые (до первого совпадения)
            if (cachedItems.length > 0) {
                let foundOld = allItems.some(b => cachedTypeIds.has(b.id));
                for (let p = 2; p <= totalPages && !foundOld; p += 20) {
                    const batch = Array.from({ length: Math.min(20, totalPages - p + 1) }, (_, i) =>
                        fetchPage(`https://api.fearproject.ru/punishments?page=${p+i}&limit=${LIMIT}&type=${type}`)
                    );
                    const results = await Promise.all(batch);
                    for (const r of results) {
                        if (!r) continue;
                        const pg = (r.punishments || r.data || r.items || []).map(b => ({ ...b, punish_type: type }));
                        for (const item of pg) {
                            if (cachedTypeIds.has(item.id)) { foundOld = true; break; }
                            allItems.push(item);
                        }
                        if (foundOld) break;
                    }
                }
                const newItems = allItems.filter(b => String(b.admin_steamid) === String(admin_steamid) && !cachedTypeIds.has(b.id));
                return [...newItems, ...cachedItems];
            }

            // Нет кеша — полный скан параллельно
            console.log(`[bans] full public scan type=${type}: ${totalPages} pages`);
            for (let p = 2; p <= totalPages; p += 20) {
                const batch = Array.from({ length: Math.min(20, totalPages - p + 1) }, (_, i) =>
                    fetchPage(`https://api.fearproject.ru/punishments?page=${p+i}&limit=${LIMIT}&type=${type}`)
                );
                const results = await Promise.all(batch);
                for (const r of results) {
                    if (!r) continue;
                    allItems.push(...(r.punishments || r.data || r.items || []).map(b => ({ ...b, punish_type: type })));
                }
            }
            return allItems.filter(b => String(b.admin_steamid) === String(admin_steamid));
        };

        try {
            let allPunishments = [];
            let method = 'public';

            // Пробуем /my — работает только для своего аккаунта
            if (authToken) {
                try {
                    const profile = await _httpsGetJsonObject('api.fearproject.ru', '/profile', authToken);
                    const tokenSteamid = String(profile?.steamid || profile?.steam_id || '');
                    if (tokenSteamid && tokenSteamid === String(admin_steamid)) {
                        const myItems = await tryMyPunishments();
                        if (myItems !== null) {
                            // /my возвращает только свои наказания — фильтруем на всякий случай
                            allPunishments = myItems.filter(b =>
                                !b.admin_steamid || String(b.admin_steamid) === String(admin_steamid)
                            );
                            method = 'my';
                            console.log(`[bans] /my: ${allPunishments.filter(b=>b.punish_type===1).length} bans, ${allPunishments.filter(b=>b.punish_type===2).length} mutes`);
                        }
                    }
                } catch (e) { console.log(`[bans] profile check failed: ${e.message}`); }
            }

            if (method === 'public') {
                const [bansResult, mutesResult] = await Promise.all([
                    scanPublic(1, cachedBans),
                    scanPublic(2, cachedMutes),
                ]);
                allPunishments = [...bansResult, ...mutesResult];
            }

            allPunishments.sort((a, b) => b.created - a.created);
            // Дедупликация по id + фильтрация по admin_steamid
            const dedup = (arr, type) => {
                const seen = new Set();
                return arr.filter(b => {
                    if (b.punish_type !== type) return false;
                    if (b.admin_steamid && String(b.admin_steamid) !== String(admin_steamid)) return false;
                    if (seen.has(b.id)) return false;
                    seen.add(b.id);
                    return true;
                });
            };
            const bans  = dedup(allPunishments, 1);
            const mutes = dedup(allPunishments, 2);
            const newCount = [...bans, ...mutes].filter(b => !cachedIds.has(`${b.punish_type}_${b.id}`)).length;

            saveBansCache(admin_steamid, { bans, mutes, updatedAt: new Date().toISOString(), method });
            console.log(`[bans] done via ${method}: ${bans.length} bans, ${mutes.length} mutes, +${newCount} new`);
            // Логируем уникальные статусы для диагностики
            const allItems = [...bans, ...mutes];
            const statusMap = {};
            for (const b of allItems) { statusMap[b.status] = (statusMap[b.status] || 0) + 1; }
            console.log('[bans] статусы:', JSON.stringify(statusMap), '| пример записи:', JSON.stringify(allItems[0]).slice(0, 300));
            res.json({ bans, mutes, total: bans.length + mutes.length, newCount, fromCache: false, method });

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
