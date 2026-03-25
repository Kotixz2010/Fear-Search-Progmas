// FearSearch App
const CONFIG = {
    API_URL: '/api/servers',
    STEAM_API_URL: '/api/steam/accountdates',
    STEAM_VAC_URL: '/api/steam/vacbans',

    UPDATE_INTERVAL: 5000,
};

// State
let serversData = [];
let allPlayers = [];
let cleanPlayers = new Set(JSON.parse(localStorage.getItem('fearsearch_clean_players') || '[]'));
let playerAccountDates = JSON.parse(localStorage.getItem('fearsearch_account_dates') || '{}');
let playerVacData = JSON.parse(localStorage.getItem('fearsearch_vac_data') || '{}');
// Последний раз замечен на серверах FearProject (steamid → ISO timestamp)
let playerLastSeenOnFear = JSON.parse(localStorage.getItem('fearsearch_last_seen') || '{}');
let searchQuery = '';
let updateTimer = null;
let showUnconfigured = true;

// ── AUTH MANAGER ─────────────────────────────
// SteamID пользователей которым показывается вкладка "Стафф" и "Покупные"
// Сюда можно добавить steamid вручную (дополнительно к тем кто есть в admins.json)
const STAFF_STEAMIDS_EXTRA = new Set([
    '76561198751025670',
]);

// Группы которые считаются "Стафф" (получают доступ к вкладкам Стафф и Покупные)
const STAFF_GROUPS = new Set(['STAFF', 'STADMIN', 'STMODER', 'MODER', 'MLMODER', 'MEDIA']);

const AuthManager = {
    token: localStorage.getItem('fearsearch_token') || null,
    user:  JSON.parse(localStorage.getItem('fearsearch_user') || 'null'),
    adminsRefreshTimer: null,

    hasAccess() {
        if (!this.user) return false;
        const sid = this.user.steamid || this.user.steam_id || this.user.steamId || '';
        if (STAFF_STEAMIDS_EXTRA.has(sid)) return true;
        if (this.user.adminGroup !== null && this.user.adminGroup !== undefined) return true;
        // JWT fallback — проверяем admins.json
        const entry = StaffManager.adminMap[sid];
        return !!(entry);
    },

    isStaff() {
        if (!this.user) return false;
        // Получаем steamid из любого возможного поля
        const sid = this.user.steamid || this.user.steam_id || this.user.steamId || '';
        // Ручной список — проверяем сразу
        if (STAFF_STEAMIDS_EXTRA.has(sid)) return true;
        // Проверяем группу из admins.json (загружается в StaffManager)
        const entry = StaffManager.adminMap[sid];
        if (entry && STAFF_GROUPS.has(entry.group_name)) return true;
        return false;
    },

    getRoleLabel() {
        if (!this.user) return '';
        return this.isStaff() ? 'Стафф' : 'Администратор';
    },

    // Показываем/скрываем вкладки в зависимости от роли
    applyTabVisibility() {
        const sel = (tab) => document.querySelector(`.sidebar-nav-item[data-tab="${tab}"]`);
        const show = this.isStaff();
        const sid = this.user?.steamid || this.user?.steam_id || '';

        // Вкладки только для стаффа
        ['staff','paid','bans'].forEach(tab => {
            const el = sel(tab);
            if (el) el.style.display = show ? '' : 'none';
        });

        // Статистика стаффа — только для конкретных steamid
        const STAFFSTATS_WHITELIST = new Set(['76561198751025670', '76561199645130988']);
        const statsEl = sel('staffstats');
        if (statsEl) statsEl.style.display = (show && STAFFSTATS_WHITELIST.has(sid)) ? '' : 'none';
    },

    // Показать/скрыть gate
    showGate(show) {
        const gate = document.getElementById('auth-gate');
        if (gate) gate.style.display = show ? 'flex' : 'none';
    },

    setGateError(msg) {
        const el = document.getElementById('gate-error');
        if (el) el.textContent = msg;
    },

    // Вход по токену введённому вручную
    async loginWithToken() {
        const input = document.getElementById('gate-token-input');
        const btn   = document.getElementById('gate-btn');
        const token = input?.value.trim();

        if (!token) { this.setGateError('Введи токен'); return; }

        this.setGateError('');
        if (btn) { btn.disabled = true; btn.textContent = 'Проверяю...'; }

        try {
            const res = await fetch('/api/fear/me', {
                headers: { 'x-auth-token': token }
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                if (res.status === 403) {
                    this.setGateError(
                        `У аккаунта "${errData.name || ''}" нет прав администратора.\nКупи права на fearproject.ru`
                    );
                } else {
                    this.setGateError('Неверный токен или нет доступа. Проверь и попробуй снова.');
                }
                return;
            }

            const user = await res.json();

            // Получаем steamid из любого поля
            const sid = user.steamid || user.steam_id || user.steamId || '';

            // Фиксируем имя если не пришло
            if (!user.name && !user.nickname) user.name = sid;

            // Всё ок — сохраняем и открываем UI
            this.token = token;
            this.user  = user;
            localStorage.setItem('fearsearch_token', token);
            localStorage.setItem('fearsearch_user', JSON.stringify(user));

            this.showGate(false);
            this.renderUI();
            UI.showToast(`✅ Добро пожаловать, ${user.name || user.nickname}!`);
            this.loadAdmins(); // не await — грузим в фоне
            App.startApp();

        } catch (e) {
            this.setGateError('Ошибка соединения: ' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Войти'; }
        }
    },

    logout() {
        this.token = null;
        this.user  = null;
        localStorage.removeItem('fearsearch_token');
        localStorage.removeItem('fearsearch_user');
        localStorage.removeItem('fearsearch_fear_admins');
        this.renderUI();
        PaidManager.render([]);
        App.stopAutoUpdate();
        this.showGate(true);
        // Очищаем поле
        const input = document.getElementById('gate-token-input');
        if (input) input.value = '';
        this.setGateError('');
    },

    renderUI() {
        const loggedOut = document.getElementById('auth-logged-out');
        const loggedIn  = document.getElementById('auth-logged-in');
        if (!loggedOut || !loggedIn) return;

        if (this.user) {
            loggedOut.style.display = 'none';
            loggedIn.style.display  = 'flex';
            const avatar = document.getElementById('auth-avatar');
            const name   = document.getElementById('auth-name');
            const role   = document.getElementById('auth-role');
            if (avatar) avatar.src = this.user.avatar_medium || this.user.avatar || '';
            if (name)   name.textContent = this.user.name || '—';
            if (role) {
                role.textContent = this.getRoleLabel();
                role.className = 'auth-role has-access';
            }
            this.applyTabVisibility();
        } else {
            loggedOut.style.display = 'flex';
            loggedIn.style.display  = 'none';
        }
    },

    async loadAdmins() {
        if (!this.token) return;
        try {
            const res = await fetch('/api/fear/admins', {
                headers: { 'x-auth-token': this.token }
            });
            if (res.ok) {
                const data = await res.json();
                this.processAdmins(data.admins || data);
                console.log(`[admins] loaded ${(data.admins || data).length}, savedAt: ${data.savedAt}`);
            } else {
                const local = await fetch('/admins.json');
                if (local.ok) this.processAdmins(await local.json());
            }
        } catch {
            try {
                const local = await fetch('/admins.json');
                if (local.ok) this.processAdmins(await local.json());
            } catch {}
        }

        // Сразу запускаем синхронизацию с сайтом в фоне (не блокируем UI)
        this._syncInBackground();

        // Автообновление каждый час
        if (this.adminsRefreshTimer) clearInterval(this.adminsRefreshTimer);
        this.adminsRefreshTimer = setInterval(() => this.refreshAdmins(), 60 * 60 * 1000);
    },

    // Фоновая синхронизация — не блокирует запуск, показывает тост если есть изменения
    async _syncInBackground() {
        if (!this.token) return;
        try {
            const res = await fetch('/api/fear/admins/refresh', {
                method: 'POST',
                headers: { 'x-auth-token': this.token, 'Content-Type': 'application/json' }
            });
            if (res.ok) {
                const data = await res.json();
                console.log(`[admins] startup sync: total=${data.total}, added=${data.added}, updated=${data.updated}`);
                // Перезагружаем список после синхронизации
                const adminsRes = await fetch('/api/fear/admins', {
                    headers: { 'x-auth-token': this.token }
                });
                if (adminsRes.ok) {
                    const adminsData = await adminsRes.json();
                    this.processAdmins(adminsData.admins || adminsData);
                    if (data.added > 0 || data.updated > 0) {
                        UI.showToast(`🔄 Список обновлён: +${data.added} новых, ${data.updated} изменено`);
                    }
                }
            }
        } catch (e) {
            console.warn('[admins] startup sync failed:', e.message);
        }
    },

    async refreshAdmins() {
        if (!this.token) return;
        try {
            const res = await fetch('/api/fear/admins/refresh', {
                method: 'POST',
                headers: { 'x-auth-token': this.token, 'Content-Type': 'application/json' }
            });
            if (res.ok) {
                const data = await res.json();
                console.log(`[admins] refreshed: ${data.total} entries`);
                if (data.added > 0) {
                    UI.showToast(`🔄 Синхронизация: +${data.added} новых`);
                }
                // Перезагружаем список без запуска нового refresh
                const adminsRes = await fetch('/api/fear/admins', {
                    headers: { 'x-auth-token': this.token }
                });
                if (adminsRes.ok) {
                    const adminsData = await adminsRes.json();
                    this.processAdmins(adminsData.admins || adminsData);
                }
            }
        } catch (e) {
            console.warn('[admins] refresh failed:', e.message);
        }
    },

    processAdmins(admins) {
        if (!Array.isArray(admins)) return;
        const PAID_GROUPS = ['ADMIN', 'ADMIN+'];

        PaidManager.admins = admins.filter(a => PAID_GROUPS.includes(a.group_name));
        StaffManager.admins = admins.filter(a => !PAID_GROUPS.includes(a.group_name));
        StaffManager.adminMap = {};
        for (const a of StaffManager.admins) StaffManager.adminMap[a.steamid] = a;

        // Помечаем всех известных админов как уже проверенных — не будем их снова отправлять
        for (const a of admins) App._seenAdminIds.add(a.steamid);

        const onlineMap = {};
        for (const p of allPlayers) onlineMap[p.steam_id] = p;
        StaffManager.render(onlineMap);
        PaidManager.render(onlineMap);
        AuthManager.renderUI();
    },

    async init() {
        // Если нет сохранённого токена — показываем gate и не запускаем ничего
        if (!this.token || !this.user) {
            this.showGate(true);
            return false; // сигнал App.init что надо остановиться
        }
        this.showGate(false);
        this.renderUI();
        await this.loadAdmins();
        return true;
    }
};

// ── PAID ADMINS MANAGER ───────────────────────
const PaidManager = {
    admins: [],
    _openOffline: new Set(), // запоминаем открытые оффлайн-секции

    async _fetchLastlogoff() {
        const missing = this.admins.map(a => a.steamid).filter(id => !playerVacData[id]?.lastlogoff);
        if (missing.length === 0) return;
        for (let i = 0; i < missing.length; i += 100) {
            try {
                const res = await fetch('/api/steam/accountdates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ steamids: missing.slice(i, i + 100) })
                });
                if (!res.ok) continue;
                const data = await res.json();
                for (const [id, d] of Object.entries(data)) {
                    if (d.lastlogoff) playerVacData[id] = { ...(playerVacData[id] || {}), lastlogoff: new Date(d.lastlogoff * 1000).toISOString() };
                }
                localStorage.setItem('fearsearch_vac_data', JSON.stringify(playerVacData));
            } catch {}
        }
    },

    tick(players) {
        const onlineMap = {};
        for (const p of players) onlineMap[p.steam_id] = p;
        const count = this.admins.filter(a => onlineMap[a.steamid]).length;
        const badge = document.getElementById('paid-online-badge');
        if (badge) badge.textContent = count;
        this.render(onlineMap);
    },

    render(onlineMap) {
        const container = document.getElementById('paid-groups');
        if (!container) return;
        if (!AuthManager.hasAccess()) return;

        if (this.admins.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">💰</span><p>Загрузка списка администраторов...</p></div>`;
            return;
        }

        // Сохраняем состояние открытых оффлайн-секций
        container.querySelectorAll('[id$="-offline"]').forEach(el => {
            if (el.style.display !== 'none') this._openOffline.add(el.id);
            else this._openOffline.delete(el.id);
        });

        container.innerHTML = '';

        // Группируем: сначала ADMIN+, потом ADMIN
        const grouped = {};
        for (const a of this.admins) {
            const key = a.group_name || 'ADMIN';
            if (!grouped[key]) grouped[key] = { display: a.group_display_name || key, members: [] };
            grouped[key].members.push(a);
        }

        const ORDER = ['ADMIN+', 'ADMIN'];
        const COLOR = { 'ADMIN+': 'pink', 'ADMIN': 'orange' };

        for (const gname of ORDER) {
            const group = grouped[gname];
            if (!group) continue;

            const online  = group.members.filter(a => onlineMap[a.steamid]);
            const frozen  = group.members.filter(a => a.is_frozen);
            const offline = group.members.filter(a => !onlineMap[a.steamid]);
            const color   = COLOR[gname] || 'orange';
            // Безопасный id без спецсимволов
            const safeGid = gname.replace(/[^a-zA-Z0-9]/g, '_');

            const section = document.createElement('div');
            section.className = 'staff-section';
            section.innerHTML = `
                <div class="staff-section-head">
                    <span class="col-icon ${color}">💰</span>
                    <span class="staff-group-name">${escapeHtml(group.display)}</span>
                    <span class="staff-group-count ${color}">${online.length} онлайн · ${frozen.length} заморожено · ${group.members.length} всего</span>
                    ${offline.length > 0 ? `<button class="btn-toggle-offline" onclick="PaidManager.toggleOffline(this, 'paid-grp-${safeGid}-offline')">Показать оффлайн (${offline.length})</button>` : ''}
                </div>
                <div class="staff-members" id="paid-grp-${safeGid}"></div>
                <div class="staff-members" id="paid-grp-${safeGid}-offline" style="${this._openOffline.has(`paid-grp-${safeGid}-offline`) ? '' : 'display:none'}"></div>
            `;
            container.appendChild(section);
            // Восстанавливаем текст кнопки если секция открыта
            if (this._openOffline.has(`paid-grp-${safeGid}-offline`)) {
                const btn = section.querySelector('.btn-toggle-offline');
                if (btn) btn.textContent = `Скрыть оффлайн (${offline.length})`;
            }

            const membersEl = document.getElementById(`paid-grp-${safeGid}`);
            const offlineEl = document.getElementById(`paid-grp-${safeGid}-offline`);
            for (const admin of online) {
                const player = onlineMap[admin.steamid];
                const isOnline = !!player;
                const card = document.createElement('div');
                card.className = `staff-card ${isOnline ? 'online' : ''} ${admin.is_frozen ? 'frozen' : ''}`;

                const safeId     = escapeHtml(admin.steamid);
                const safeName   = escapeHtml(admin.name);
                const safeAvatar = escapeHtml(admin.avatar_full || admin.avatar_medium || admin.avatar || '');
                const frozenBadge = admin.is_frozen ? `<span class="staff-frozen">❄ Заморожен</span>` : '';
                const fearLastSeenAdmin = playerLastSeenOnFear[admin.steamid];

                let onlineInfo = '';
                if (isOnline) {
                    const safeServer = escapeHtml(player.server?.name || '');
                    const safeMap    = escapeHtml(player.server?.map || '');
                    const safeAddr   = escapeHtml(`${player.server?.ip}:${player.server?.port}`);
                    const teamClass  = player.team === 'ct' ? 'team-ct' : (player.team === 't' ? 'team-t' : 'team-spec');
                    const teamLabel  = player.team === 'ct' ? 'CT' : (player.team === 't' ? 'T' : 'SPEC');
                    const gameTag    = getServerGameTag(player.server?.ip, player.server?.port);
                    onlineInfo = `
                        <div class="staff-online-info">
                            <span class="player-team ${teamClass}">${teamLabel}</span>
                            <span class="staff-server">�️ ${safeServer} ${gameTag}</span>
                            <span class="staff-map">🗺️ ${safeMap}</span>
                            <span class="staff-kd">K/D: ${UI.calculateKD(player.kills, player.deaths)}</span>
                            <button class="btn-connect-small" onclick="App.connectToServer('${safeAddr}')">🎯 Connect</button>
                        </div>`;
                }

                const lastSeenHtml = !isOnline && fearLastSeenAdmin
                    ? `<div class="staff-last-seen">👁 Последний раз на серверах: ${UI.formatDateTime(fearLastSeenAdmin)} <span>(${UI.getTimeAgo(fearLastSeenAdmin)})</span></div>`
                    : '';

                card.innerHTML = `
                    <img src="${safeAvatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'}"
                         class="staff-avatar ${isOnline ? 'online' : ''}" loading="lazy"
                         onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                    <div class="staff-info">
                        <div class="staff-name">${safeName} ${frozenBadge}</div>
                        <div class="staff-steamid" onclick="App.copyToClipboard('${safeId}')">${safeId}</div>
                        ${onlineInfo}
                        ${lastSeenHtml}
                    </div>
                    <div class="staff-status-col">
                        <span class="status-pill ${isOnline ? 'online' : 'offline'}">${isOnline ? '● ОНЛАЙН' : '○ ОФФЛАЙН'}</span>
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${safeId}')">Steam</button>
                        <button class="btn-fear-small" onclick="App.openFearProfile('${safeId}')">Fear</button>
                    </div>
                `;
                membersEl.appendChild(card);
            }

            // Оффлайн карточки — в скрытый блок
            for (const admin of offline) {
                const card = document.createElement('div');
                card.className = `staff-card ${admin.is_frozen ? 'frozen' : ''}`;

                const safeId      = escapeHtml(admin.steamid);
                const safeName    = escapeHtml(admin.name);
                const safeAvatar  = escapeHtml(admin.avatar_full || admin.avatar_medium || admin.avatar || '');
                const frozenBadge = admin.is_frozen ? `<span class="staff-frozen">❄ Заморожен</span>` : '';
                const fearLastSeenAdmin = playerLastSeenOnFear[admin.steamid];
                const lastSeenHtml = fearLastSeenAdmin
                    ? `<div class="staff-last-seen">👁 Последний раз на серверах: ${UI.formatDateTime(fearLastSeenAdmin)} <span>(${UI.getTimeAgo(fearLastSeenAdmin)})</span></div>`
                    : '';

                card.innerHTML = `
                    <img src="${safeAvatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'}"
                         class="staff-avatar" loading="lazy"
                         onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                    <div class="staff-info">
                        <div class="staff-name">${safeName} ${frozenBadge}</div>
                        <div class="staff-steamid" onclick="App.copyToClipboard('${safeId}')">${safeId}</div>
                        ${lastSeenHtml}
                    </div>
                    <div class="staff-status-col">
                        <span class="status-pill offline">○ ОФФЛАЙН</span>
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${safeId}')">Steam</button>
                        <button class="btn-fear-small" onclick="App.openFearProfile('${safeId}')">Fear</button>
                    </div>
                `;
                offlineEl.appendChild(card);
            }
        }
    },

    toggleOffline(btn, id) {
        const el = document.getElementById(id);
        if (!el) return;
        const visible = el.style.display !== 'none';
        el.style.display = visible ? 'none' : 'grid';
        const count = btn.textContent.match(/\d+/)?.[0] || '';
        btn.textContent = visible ? `Показать оффлайн (${count})` : `Скрыть оффлайн (${count})`;
        // Сохраняем состояние
        if (visible) this._openOffline.delete(id);
        else this._openOffline.add(id);
    }
};

// ── STAFF MANAGER ────────────────────────────
const STAFF_GROUPS_ORDER = ['STAFF', 'STADMIN', 'STMODER', 'MODER', 'MLMODER', 'MEDIA'];
const STAFF_GROUPS_EXCLUDE = ['ADMIN', 'ADMIN+'];

const StaffManager = {
    admins: [],   // все записи из admins.json (отфильтрованные)
    adminMap: {}, // steamid -> admin

    async load() {
        try {
            const res = await fetch('/admins.json');
            if (!res.ok) throw new Error('not found');
            const all = await res.json();
            this.admins = all.filter(a => !STAFF_GROUPS_EXCLUDE.includes(a.group_name));
            this.adminMap = {};
            for (const a of this.admins) this.adminMap[a.steamid] = a;
        } catch (e) {
            console.warn('admins.json not loaded:', e.message);
        }
        // Подгружаем lastlogoff для всех стафф
        this._fetchLastlogoff();
    },

    async _fetchLastlogoff() {
        const missing = this.admins.map(a => a.steamid).filter(id => !playerVacData[id]?.lastlogoff);
        if (missing.length === 0) return;
        for (let i = 0; i < missing.length; i += 100) {
            try {
                const res = await fetch('/api/steam/accountdates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ steamids: missing.slice(i, i + 100) })
                });
                if (!res.ok) continue;
                const data = await res.json();
                for (const [id, d] of Object.entries(data)) {
                    if (d.lastlogoff) playerVacData[id] = { ...(playerVacData[id] || {}), lastlogoff: new Date(d.lastlogoff * 1000).toISOString() };
                }
                localStorage.setItem('fearsearch_vac_data', JSON.stringify(playerVacData));
            } catch {}
        }
    },

    // Вызывается после каждого updateData
    tick(players) {
        const onlineMap = {};
        for (const p of players) onlineMap[p.steam_id] = p;
        this.render(onlineMap);
        this.updateBadge(onlineMap);
    },

    updateBadge(onlineMap) {
        const count = this.admins.filter(a => onlineMap[a.steamid]).length;
        const badge = document.getElementById('staff-online-badge');
        if (badge) badge.textContent = count;
    },

    render(onlineMap) {
        const container = document.getElementById('staff-groups');
        if (!container) return;
        container.innerHTML = '';

        if (this.admins.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">👮</span><p>Нет данных о стаффе</p></div>`;
            return;
        }

        // Группируем по group_name в нужном порядке
        const grouped = {};
        for (const a of this.admins) {
            if (!grouped[a.group_name]) grouped[a.group_name] = { display: a.group_display_name, members: [] };
            grouped[a.group_name].members.push(a);
        }

        for (const gname of STAFF_GROUPS_ORDER) {
            const group = grouped[gname];
            if (!group) continue;

            const online = group.members.filter(a => onlineMap[a.steamid]);
            const offline = group.members.filter(a => !onlineMap[a.steamid]);

            const section = document.createElement('div');
            section.className = 'staff-section';

            const groupColor = { STAFF: 'cyan', STADMIN: 'purple', STMODER: 'blue', MODER: 'green', MLMODER: 'orange', MEDIA: 'yellow' }[gname] || 'cyan';

            section.innerHTML = `
                <div class="staff-section-head">
                    <span class="col-icon ${groupColor}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                    </span>
                    <span class="staff-group-name">${escapeHtml(group.display)}</span>
                    <span class="staff-group-count ${groupColor}">${online.length} онлайн / ${group.members.length} всего</span>
                </div>
                <div class="staff-members" id="staff-group-${gname}"></div>
            `;
            container.appendChild(section);

            const membersEl = section.querySelector(`#staff-group-${gname}`);

            // Сначала онлайн, потом оффлайн
            for (const admin of [...online, ...offline]) {
                const player = onlineMap[admin.steamid];
                const isOnline = !!player;
                const card = document.createElement('div');
                card.className = `staff-card ${isOnline ? 'online' : ''}`;

                const safeId   = escapeHtml(admin.steamid);
                const safeName = escapeHtml(admin.name);
                const safeAvatar = escapeHtml(admin.avatar_full || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg');
                const frozenBadge = admin.is_frozen ? `<span class="staff-frozen">❄ Заморожен</span>` : '';
                const fearLastSeenAdmin = playerLastSeenOnFear[admin.steamid];

                let onlineInfo = '';
                if (isOnline) {
                    const safeServer = escapeHtml(player.server?.name || '');
                    const safeMap    = escapeHtml(player.server?.map || '');
                    const safeAddr   = escapeHtml(`${player.server?.ip}:${player.server?.port}`);
                    const teamClass  = player.team === 'ct' ? 'team-ct' : (player.team === 't' ? 'team-t' : 'team-spec');
                    const teamLabel  = player.team === 'ct' ? 'CT' : (player.team === 't' ? 'T' : 'SPEC');
                    const gameTag    = getServerGameTag(player.server?.ip, player.server?.port);
                    onlineInfo = `
                        <div class="staff-online-info">
                            <span class="player-team ${teamClass}">${teamLabel}</span>
                            <span class="staff-server">🖥️ ${safeServer} ${gameTag}</span>
                            <span class="staff-map">🗺️ ${safeMap}</span>
                            <span class="staff-kd">K/D: ${UI.calculateKD(player.kills, player.deaths)}</span>
                            <button class="btn-connect-small" onclick="App.connectToServer('${safeAddr}')">🎯 Connect</button>
                        </div>`;
                }

                const lastSeenHtml = !isOnline && fearLastSeenAdmin
                    ? `<div class="staff-last-seen">👁 Последний раз на серверах: ${UI.formatDateTime(fearLastSeenAdmin)} <span>(${UI.getTimeAgo(fearLastSeenAdmin)})</span></div>`
                    : '';

                card.innerHTML = `
                    <img src="${safeAvatar}" class="staff-avatar ${isOnline ? 'online' : ''}" loading="lazy"
                         onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                    <div class="staff-info">
                        <div class="staff-name">${safeName} ${frozenBadge}</div>
                        <div class="staff-steamid" onclick="App.copyToClipboard('${safeId}')">${safeId}</div>
                        ${onlineInfo}
                        ${lastSeenHtml}
                    </div>
                    <div class="staff-status-col">
                        <span class="status-pill ${isOnline ? 'online' : 'offline'}">${isOnline ? '● ОНЛАЙН' : '○ ОФФЛАЙН'}</span>
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${safeId}')">Steam</button>
                        <button class="btn-fear-small" onclick="App.openFearProfile('${safeId}')">Fear</button>
                    </div>
                `;
                membersEl.appendChild(card);
            }
        }
    }
};

// ── TRACKED MANAGER ─────────────────────────
const TrackedManager = {
    // { steamId: { nickname, avatar, addedAt, lastSeen, online, server } }
    data: JSON.parse(localStorage.getItem('fearsearch_tracked') || '{}'),
    log:  JSON.parse(localStorage.getItem('fearsearch_tracked_log') || '[]'),

    save() {
        localStorage.setItem('fearsearch_tracked', JSON.stringify(this.data));
    },
    saveLog() {
        // Храним последние 500 записей
        if (this.log.length > 500) this.log = this.log.slice(-500);
        localStorage.setItem('fearsearch_tracked_log', JSON.stringify(this.log));
    },

    addEntry(type, steamId, text, extra = '') {
        const nickname = this.data[steamId]?.nickname || steamId;
        this.log.unshift({ type, steamId, nickname, text, extra, time: new Date().toISOString() });
        this.saveLog();
        this.renderLog();
    },

    add(steamId, nickname, avatar) {
        if (this.data[steamId]) { UI.showToast('Уже отслеживается'); return; }
        this.data[steamId] = {
            nickname: nickname || steamId,
            avatar: avatar || '',
            addedAt: new Date().toISOString(),
            lastSeen: null,
            online: false,
            server: null
        };
        this.save();
        this.addEntry('added', steamId, 'добавлен в отслеживаемые');
        this.render();
        this.updateBadge();
        UI.showToast(`👁 ${nickname || steamId} отслеживается`);
    },

    remove(steamId) {
        delete this.data[steamId];
        this.save();
        this.render();
        this.updateBadge();
        UI.showToast('Игрок удалён из отслеживаемых');
    },

    async addBySteamId() {
        const input = document.getElementById('track-input');
        const steamId = input?.value.trim();
        if (!steamId || steamId.length < 17) {
            UI.showToast('Введи корректный Steam ID (17 цифр)', 'error');
            return;
        }
        if (this.data[steamId]) { UI.showToast('Уже отслеживается'); return; }

        // Пробуем получить ник из уже загруженных игроков
        const existing = allPlayers.find(p => p.steam_id === steamId);
        if (existing) {
            this.add(steamId, existing.nickname, existing.avatar);
        } else {
            // Запрашиваем через Steam API
            try {
                const res = await fetch('/api/steam/accountdates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ steamids: [steamId] })
                });
                // Используем summaries endpoint для получения ника
                const summRes = await fetch(`/api/steam/profile/${steamId}`);
                if (summRes.ok) {
                    const d = await summRes.json();
                    this.add(steamId, d.nickname, d.avatar);
                } else {
                    this.add(steamId, steamId, '');
                }
            } catch {
                this.add(steamId, steamId, '');
            }
        }
        if (input) input.value = '';
    },

    // Вызывается после каждого updateData
    tick(players) {
        const onlineIds = new Set(players.map(p => p.steam_id));
        let changed = false;

        for (const [steamId, tracked] of Object.entries(this.data)) {
            const player = players.find(p => p.steam_id === steamId);
            const wasOnline = tracked.online;
            const nowOnline = !!player;

            // Обновляем ник если изменился
            if (player && player.nickname && player.nickname !== tracked.nickname) {
                const oldNick = tracked.nickname;
                tracked.nickname = player.nickname;
                tracked.avatar = player.avatar || tracked.avatar;
                this.addEntry('rename', steamId, `сменил ник: "${oldNick}" → "${player.nickname}"`);
                changed = true;
            }

            // Обновляем аватар
            if (player && player.avatar) tracked.avatar = player.avatar;

            if (!wasOnline && nowOnline) {
                // Вошёл онлайн
                tracked.online = true;
                tracked.lastSeen = new Date().toISOString();
                tracked.server = player.server?.name || null;
                this.addEntry('online', steamId, 'вошёл на сервер', player.server?.name || '');
                changed = true;
            } else if (wasOnline && !nowOnline) {
                // Вышел
                tracked.online = false;
                tracked.lastSeen = new Date().toISOString();
                tracked.server = null;
                this.addEntry('offline', steamId, 'покинул сервер');
                changed = true;
            } else if (nowOnline && player.server?.name !== tracked.server) {
                // Сменил сервер
                const oldServer = tracked.server;
                tracked.server = player.server?.name || null;
                this.addEntry('server', steamId, `сменил сервер: "${oldServer}" → "${tracked.server}"`);
                changed = true;
            }
        }

        if (changed) { this.save(); this.render(); }
    },

    render() {
        const container = document.getElementById('tracked-list');
        if (!container) return;
        container.innerHTML = '';

        const entries = Object.entries(this.data);
        if (entries.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">👁</span><p>Добавь игроков для отслеживания</p></div>`;
            return;
        }

        // Сначала онлайн, потом оффлайн
        entries.sort((a, b) => (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0));

        for (const [steamId, t] of entries) {
            const item = document.createElement('div');
            item.className = `tracked-item ${t.online ? 'online' : ''}`;

            const avatarUrl = t.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';
            const safeName = escapeHtml(t.nickname);
            const safeId   = escapeHtml(steamId);
            const safeServer = escapeHtml(t.server || '');
            const lastSeen = t.lastSeen ? UI.getTimeAgo(t.lastSeen) : 'никогда';

            item.innerHTML = `
                <img src="${escapeHtml(avatarUrl)}" class="tracked-avatar" loading="lazy">
                <div class="tracked-info">
                    <div class="tracked-name">${safeName}</div>
                    <div class="tracked-steamid">${safeId}</div>
                </div>
                <div class="tracked-status">
                    <span class="status-pill ${t.online ? 'online' : 'offline'}">${t.online ? '● ОНЛАЙН' : '○ ОФФЛАЙН'}</span>
                    <span class="tracked-server">${t.online ? safeServer : lastSeen}</span>
                </div>
                <button class="tracked-remove" onclick="TrackedManager.remove('${safeId}')" title="Удалить">✕</button>
            `;
            container.appendChild(item);
        }
    },

    renderLog() {
        const container = document.getElementById('tracked-log');
        if (!container) return;
        container.innerHTML = '';

        if (this.log.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">📋</span><p>События появятся здесь</p></div>`;
            return;
        }

        const icons = { online: '🟢', offline: '⚫', rename: '✏️', server: '🔀', added: '➕' };

        for (const entry of this.log) {
            const el = document.createElement('div');
            el.className = `log-entry ${entry.type}`;
            const time = new Date(entry.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const date = new Date(entry.time).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
            el.innerHTML = `
                <span class="log-icon">${icons[entry.type] || '•'}</span>
                <div class="log-body">
                    <span class="log-name">${escapeHtml(entry.nickname)}</span>
                    <span class="log-text"> ${escapeHtml(entry.text)}</span>
                    ${entry.extra ? `<span class="log-text" style="color:var(--t3)"> — ${escapeHtml(entry.extra)}</span>` : ''}
                </div>
                <span class="log-time">${date} ${time}</span>
            `;
            container.appendChild(el);
        }
    },

    clearLog() {
        this.log = [];
        this.saveLog();
        this.renderLog();
    },

    updateBadge() {
        const badge = document.getElementById('tracked-badge');
        if (badge) badge.textContent = Object.keys(this.data).length;
        const count = document.getElementById('tracked-count');
        if (count) count.textContent = Object.keys(this.data).length;
    }
};

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const SteamUtils = {
    toSteamID3(steamId64) {
        if (!steamId64 || steamId64.length < 17) return null;
        const accountId = BigInt(steamId64) - BigInt('76561197960265728');
        return `[U:1:${accountId.toString()}]`;
    },
    toSteamID(steamId64) {
        if (!steamId64 || steamId64.length < 17) return null;
        const accountId = BigInt(steamId64) - BigInt('76561197960265728');
        const y = accountId % BigInt(2);
        const z = accountId / BigInt(2);
        return `STEAM_0:${y}:${z.toString()}`;
    },
    isUnconfiguredProfile(avatarUrl) {
        if (!avatarUrl) return true;
        return avatarUrl.includes('fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb');
    }
};

const UI = {
    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = type === 'error' ? 'toast error' : 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    },
    formatDate(date) {
        if (!date) return 'Неизвестно';
        return new Date(date).toLocaleString('ru-RU', {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    },
    formatDateTime(date) {
        if (!date) return 'Неизвестно';
        return new Date(date).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    },
    getTimeAgo(date) {
        if (!date) return 'неизвестно';
        const now = new Date();
        const diff = Math.max(0, now - new Date(date));
        const seconds = Math.floor(diff / 1000) % 60;
        const minutes = Math.floor(diff / (1000 * 60)) % 60;
        const hours   = Math.floor(diff / (1000 * 60 * 60)) % 24;
        const days    = Math.floor(diff / (1000 * 60 * 60 * 24));
        const parts = [];
        if (days    > 0) parts.push(`${days} ${this.declOfNum(days,    ['день','дня','дней'])}`);
        if (hours   > 0) parts.push(`${hours} ${this.declOfNum(hours,  ['час','часа','часов'])}`);
        if (minutes > 0) parts.push(`${minutes} ${this.declOfNum(minutes, ['минута','минуты','минут'])}`);
        if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${this.declOfNum(seconds, ['секунда','секунды','секунд'])}`);
        return parts.join(', ') + ' назад';
    },
    declOfNum(n, titles) {
        return titles[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];
    },
    getAccountAgeClass(date) {
        if (!date) return '';
        const days = Math.floor((new Date() - new Date(date)) / (1000 * 60 * 60 * 24));
        if (days < 30) return 'new';
        if (days < 365) return 'medium';
        return 'old';
    },
    calculateKD(kills, deaths) {
        if (deaths === 0) return kills > 0 ? kills.toFixed(2) : '0.00';
        return (kills / deaths).toFixed(2);
    },
    getPingClass(ping) {
        if (ping > 100) return 'ping-high';
        if (ping > 60) return 'ping-medium';
        return '';
    }
};

const DataManager = {
    async fetchServers() {
        try {
            const response = await fetch(CONFIG.API_URL);
            if (response.ok) return await response.json();
        } catch (error) { console.error('Error fetching servers:', error); }
        return [];
    },
    async fetchExactAccountDates(steamIds) {
        if (steamIds.length === 0) return {};
        try {
            const response = await fetch(CONFIG.STEAM_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ steamids: steamIds })
            });
            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            return await response.json();
        } catch (error) { console.warn('Failed to fetch exact dates:', error); return {}; }
    },
    async fetchVacBans(steamIds) {
        if (steamIds.length === 0) return {};
        try {
            const response = await fetch(CONFIG.STEAM_VAC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ steamids: steamIds })
            });
            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            return await response.json();
        } catch (error) { console.warn('Failed to fetch VAC bans:', error); return {}; }
    },
    async processPlayers(servers) {
        const players = [];
        const steamIdsNeedingDates = [];
        const steamIdsNeedingVac = [];
        for (const server of servers) {
            if (!server.live_data || !server.live_data.players) continue;
            for (const player of server.live_data.players) {
                if (!playerAccountDates[player.steam_id]) steamIdsNeedingDates.push(player.steam_id);
                if (!playerVacData[player.steam_id]) steamIdsNeedingVac.push(player.steam_id);
            }
        }

        // Запрашиваем даты и VAC параллельно
        const [datesResult, vacResult] = await Promise.all([
            steamIdsNeedingDates.length > 0
                ? this.fetchExactAccountDates(steamIdsNeedingDates.slice(0, 100))
                : Promise.resolve({}),
            steamIdsNeedingVac.length > 0
                ? this.fetchVacBans(steamIdsNeedingVac.slice(0, 100))
                : Promise.resolve({}),
        ]);

        for (const [steamId, data] of Object.entries(datesResult)) {
            if (data.timecreated) playerAccountDates[steamId] = new Date(data.timecreated * 1000).toISOString();
            if (data.lastlogoff) playerVacData[steamId] = { ...(playerVacData[steamId] || {}), lastlogoff: new Date(data.lastlogoff * 1000).toISOString() };
        }
        if (Object.keys(datesResult).length > 0)
            localStorage.setItem('fearsearch_account_dates', JSON.stringify(playerAccountDates));

        for (const [steamId, data] of Object.entries(vacResult)) playerVacData[steamId] = data;
        if (Object.keys(vacResult).length > 0)
            localStorage.setItem('fearsearch_vac_data', JSON.stringify(playerVacData));
        for (const server of servers) {
            if (!server.live_data || !server.live_data.players) continue;
            for (const player of server.live_data.players) {
                const accountDate = playerAccountDates[player.steam_id] ? new Date(playerAccountDates[player.steam_id]) : null;
                const vacInfo = playerVacData[player.steam_id] || null;
                // Обновляем время последнего появления на серверах Fear
                playerLastSeenOnFear[player.steam_id] = new Date().toISOString();
                players.push({
                    ...player,
                    server: { id: server.id, name: server.site_name, ip: server.ip, port: server.port, map: server.live_data.map_name },
                    accountDate, vacInfo,
                    isRecentVac: vacInfo && vacInfo.vacBanned && vacInfo.daysSinceLastBan <= 30,
                    isUnconfigured: SteamUtils.isUnconfiguredProfile(player.avatar),
                    isClean: cleanPlayers.has(player.steam_id),
                    steamId3: SteamUtils.toSteamID3(player.steam_id),
                    steamId: SteamUtils.toSteamID(player.steam_id)
                });
            }
        }
        // Сохраняем lastSeen раз в минуту чтобы не спамить localStorage
        if (!DataManager._lastSeenSaved || Date.now() - DataManager._lastSeenSaved > 60000) {
            localStorage.setItem('fearsearch_last_seen', JSON.stringify(playerLastSeenOnFear));
            DataManager._lastSeenSaved = Date.now();
        }
        players.sort((a, b) => (b.accountDate?.getTime() || 0) - (a.accountDate?.getTime() || 0));
        return players;
    },
    saveCleanPlayers() {
        localStorage.setItem('fearsearch_clean_players', JSON.stringify([...cleanPlayers]));
    }
};

function createPlayerCard(player) {
    const card = document.createElement('div');
    card.className = `player-card ${player.isUnconfigured ? 'unconfigured' : ''} ${player.isClean ? 'clean' : ''} ${player.isRecentVac ? 'vac-banned' : ''}`;
    card.dataset.steamid = player.steam_id;
    card.dataset.nickname = player.nickname.toLowerCase();

    const kd = UI.calculateKD(player.kills, player.deaths);
    const pingClass = UI.getPingClass(player.ping);
    const ageClass = UI.getAccountAgeClass(player.accountDate);
    const timeAgo = UI.getTimeAgo(player.accountDate);
    const fearLastSeen = playerLastSeenOnFear[player.steam_id];
    const avatarClass = player.isRecentVac ? 'vac' : (player.isUnconfigured ? 'unconfigured' : (player.isClean ? 'clean' : ''));
    const avatarUrl = player.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';
    const teamClass = player.team === 'ct' ? 'team-ct' : (player.team === 't' ? 'team-t' : 'team-spec');
    const teamLabel = player.team === 'ct' ? 'CT' : (player.team === 't' ? 'T' : 'SPEC');
    const safeNickname   = escapeHtml(player.nickname);
    const safeSteamId    = escapeHtml(player.steam_id);
    const safeServerName = escapeHtml(player.server.name);
    const safeServerMap  = escapeHtml(player.server.map);
    const safeAddress    = escapeHtml(`${player.server.ip}:${player.server.port}`);
    const safeAvatarUrl  = escapeHtml(avatarUrl);

    card.innerHTML = `
        ${player.is_admin ? '<span class="admin-badge">ADMIN</span>' : ''}
        ${player.isRecentVac ? `
        <div class="vac-badge">
            <span class="vac-badge-icon">🔨</span>
            <span class="vac-badge-text">VAC БАН (${player.vacInfo.numberOfVACBans} шт.)</span>
            <span class="vac-badge-days">${player.vacInfo.daysSinceLastBan} дн. назад</span>
        </div>` : ''}
        <div class="player-header">
            <img src="${safeAvatarUrl}" alt="Avatar" class="player-avatar ${avatarClass}" loading="lazy">
            <div class="player-info">
                <div class="player-nickname" title="${safeNickname}">${safeNickname}</div>
                <div class="player-steamid" onclick="App.copyToClipboard('${safeSteamId}')">${safeSteamId}</div>
            </div>
            <span class="player-team ${teamClass}">${teamLabel}</span>
        </div>
        <div class="account-age ${ageClass}">
            <div class="account-main">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Steam аккаунт создан: <span class="account-date">${UI.formatDate(player.accountDate)}</span>
            </div>
            <div class="account-ago">(${timeAgo})</div>
        </div>
        ${fearLastSeen ? `<div class="last-seen">👁 Последний раз на серверах: <span>${UI.formatDateTime(fearLastSeen)}</span> <span class="last-seen-ago">(${UI.getTimeAgo(fearLastSeen)})</span></div>` : ''}
        <div class="player-stats">
            <div class="stat"><span class="stat-name">Kills</span><span class="stat-value-kills">${player.kills}</span></div>
            <div class="stat"><span class="stat-name">Deaths</span><span class="stat-value-deaths">${player.deaths}</span></div>
            <div class="stat"><span class="stat-name">K/D</span><span class="stat-value-kd">${kd}</span></div>
            <div class="stat"><span class="stat-name">Ping</span><span class="stat-value-ping ${pingClass}">${player.ping}ms</span></div>
        </div>
        <div class="player-actions">
            <button class="btn-steam" onclick="App.openSteamProfile('${safeSteamId}')">🎮 Steam</button>
            <button class="btn-fear" onclick="App.openFearProfile('${safeSteamId}')">🌐 Fear</button>
            <button class="btn-connect" onclick="App.connectToServer('${safeAddress}')">🎯 Connect</button>
            <button class="btn-copy" onclick="App.copyConnect('${safeAddress}')">📋 Copy</button>
        </div>
        <div class="player-actions">
            ${player.isClean
                ? `<button class="btn-remove" onclick="App.removeCleanPlayer('${safeSteamId}')">❌ Убрать из чистых</button>`
                : `<button class="btn-clean" onclick="App.addCleanPlayer('${safeSteamId}')">✅ Добавить в чистые</button>`
            }
        </div>
        <div class="player-actions">
            ${TrackedManager.data[player.steam_id]
                ? `<button class="btn-untrack" onclick="TrackedManager.remove('${safeSteamId}')">👁 Не отслеживать</button>`
                : `<button class="btn-track" onclick="TrackedManager.add('${safeSteamId}', '${safeNickname}', '${safeAvatarUrl}')">👁 Отслеживать</button>`
            }
        </div>
        <div class="server-info">🖥️ <span class="server-name">${safeServerName}</span> | 🗺️ ${safeServerMap} ${getServerGameTag(player.server.ip, player.server.port)}</div>
    `;
    return card;
}

const App = {
    async init() {
        this.setupEventListeners();
        this.setupTabs();
        const authed = await AuthManager.init();
        if (!authed) return; // ждём пока пользователь введёт токен
        await this.startApp();
    },

    // Запускается после успешной авторизации
    async startApp() {
        await StaffManager.load();
        TrackedManager.render();
        TrackedManager.renderLog();
        TrackedManager.updateBadge();
        await this.updateData();
        this.startAutoUpdate();
    },
    setupTabs() {
        // Поддерживаем и sidebar-nav-item и старые tab-btn
        document.querySelectorAll('.sidebar-nav-item, .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                document.querySelectorAll('.sidebar-nav-item, .tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active', 'tab-enter'));
                btn.classList.add('active');
                const tabEl = document.getElementById(`tab-${tab}`);
                if (tabEl) {
                    tabEl.classList.add('active');
                    requestAnimationFrame(() => tabEl.classList.add('tab-enter'));
                }
                if (tab === 'bans') {
                    BansManager.startAuto();
                } else {
                    BansManager.stopAuto();
                }
                if (tab === 'staffstats') {
                    StaffStatsManager.open();
                }
            });
        });
        // Enter в поле добавления
        document.getElementById('track-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') TrackedManager.addBySteamId();
        });
        document.getElementById('bans-steamid-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') BansManager.search();
        });
    },

    setupEventListeners() {
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value.toLowerCase().trim();
                this.filterPlayers();
            });
        }
        const toggleAutoupdate = document.getElementById('toggle-autoupdate');
        if (toggleAutoupdate) {
            toggleAutoupdate.addEventListener('click', () => {
                if (updateTimer) {
                    this.stopAutoUpdate();
                    toggleAutoupdate.querySelector('span').textContent = 'Запуск';
                } else {
                    this.startAutoUpdate();
                    this.updateData();
                    toggleAutoupdate.querySelector('span').textContent = 'Пауза';
                }
            });
        }
        const toggleUnconfigured = document.getElementById('toggle-unconfigured');
        if (toggleUnconfigured) {
            toggleUnconfigured.addEventListener('click', () => {
                showUnconfigured = !showUnconfigured;
                const track = toggleUnconfigured.querySelector('.toggler-track');
                if (track) track.classList.toggle('active', showUnconfigured);
                this.renderAllPlayersColumn();
            });
        }
    },
    async updateData() {
        serversData = await DataManager.fetchServers();
        allPlayers = await DataManager.processPlayers(serversData);
        this.renderColumns();
        this.updateStats();
        this.filterPlayers();
        TrackedManager.tick(allPlayers);
        StaffManager.tick(allPlayers);
        PaidManager.tick(allPlayers);
        // Автодобавление новых админов замеченных на серверах
        this._reportSeenAdmins(allPlayers);
        const el = document.getElementById('last-update');
        if (el) el.textContent = new Date().toLocaleTimeString('ru-RU');
    },

    // Отправляем на сервер игроков с is_admin=true которых может не быть в admins.json
    // Steamid которые уже проверены и есть в списке — не отправляем повторно
    _seenAdminIds: new Set(),

    async _reportSeenAdmins(players) {
        const admins = players.filter(p => p.is_admin);
        if (admins.length === 0) return;

        // Фильтруем только тех кого ещё не проверяли
        const unknown = admins.filter(p => !this._seenAdminIds.has(p.steam_id));
        if (unknown.length === 0) return;

        try {
            const res = await fetch('/api/fear/admins/seen', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ players: unknown.map(p => ({
                    steam_id: p.steam_id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    admin_group: p.admin_group || p.group || '',
                })) })
            });
            if (res.ok) {
                const data = await res.json();
                // Помечаем всех как проверенных (независимо от результата)
                for (const p of unknown) this._seenAdminIds.add(p.steam_id);

                if (data.added > 0) {
                    console.log(`[admins] автодобавлено с серверов: ${data.added}`);
                    await AuthManager.loadAdmins();
                    UI.showToast(`➕ Новых админов добавлено: ${data.added}`);
                }
            }
        } catch {}
    },
    renderColumns() {
        this.renderAllPlayersColumn();
        this.renderUnconfiguredColumn();
        this.renderCleanColumn();
    },
    renderAllPlayersColumn() {
        const container = document.getElementById('all-players');
        if (!container) return;
        container.innerHTML = '';
        let list = showUnconfigured ? allPlayers : allPlayers.filter(p => !p.isUnconfigured);
        list = list.filter(p => !p.isClean);
        if (list.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">😕</span><p>Нет игроков онлайн</p></div>`;
        } else { list.forEach(p => container.appendChild(createPlayerCard(p))); }
    },
    renderUnconfiguredColumn() {
        const container = document.getElementById('unconfigured-players');
        if (!container) return;
        container.innerHTML = '';
        const list = allPlayers.filter(p => p.isUnconfigured && !p.isClean);
        if (list.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">✅</span><p>Нет ненастроенных профилей</p></div>`;
        } else { list.forEach(p => container.appendChild(createPlayerCard(p))); }
    },
    renderCleanColumn() {
        const container = document.getElementById('clean-players');
        if (!container) return;
        container.innerHTML = '';
        const list = allPlayers.filter(p => p.isClean);
        if (list.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">👻</span><p>Добавляй игроков кнопкой ниже</p></div>`;
        } else { list.forEach(p => container.appendChild(createPlayerCard(p))); }
    },
    filterPlayers() {
        document.querySelectorAll('.player-card').forEach(card => {
            if (!searchQuery) { card.classList.remove('hidden'); return; }
            const steamid  = card.dataset.steamid?.toLowerCase() || '';
            const nickname = card.dataset.nickname || '';
            card.classList.toggle('hidden', !steamid.includes(searchQuery) && !nickname.includes(searchQuery));
        });
    },
    updateStats() {
        const el = (id) => document.getElementById(id);
        if (el('server-count'))       el('server-count').textContent       = serversData.length;
        if (el('player-count'))       el('player-count').textContent       = allPlayers.length;
        if (el('unconfigured-count')) el('unconfigured-count').textContent = allPlayers.filter(p => p.isUnconfigured).length;
        if (el('clean-count'))        el('clean-count').textContent        = allPlayers.filter(p => p.isClean).length;
        if (el('all-count'))          el('all-count').textContent          = allPlayers.length;
    },
    startAutoUpdate() {
        if (updateTimer) clearInterval(updateTimer);
        updateTimer = setInterval(() => this.updateData(), CONFIG.UPDATE_INTERVAL);
    },
    stopAutoUpdate() {
        if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
    },
    openSteamProfile(steamId64) { window.open(`https://steamcommunity.com/profiles/${steamId64}`, '_blank'); },
    openFearProfile(steamId64)  { window.open(`https://fearproject.ru/profile/${steamId64}`, '_blank'); },
    connectToServer(address) {
        window.location.href = `steam://connect/${address}`;
        UI.showToast(`Подключение к ${address}...`);
    },
    copyConnect(address) { this.copyToClipboard(`connect ${address}`); },
    async copyToClipboard(text) {
        try { await navigator.clipboard.writeText(text); UI.showToast('Скопировано!'); }
        catch { UI.showToast('Ошибка копирования', 'error'); }
    },
    addCleanPlayer(steamId) {
        cleanPlayers.add(steamId);
        DataManager.saveCleanPlayers();
        const player = allPlayers.find(p => p.steam_id === steamId);
        if (player) player.isClean = true;
        this.renderColumns(); this.updateStats();
        UI.showToast('Игрок добавлен в чистые ✅');
    },
    removeCleanPlayer(steamId) {
        cleanPlayers.delete(steamId);
        DataManager.saveCleanPlayers();
        const player = allPlayers.find(p => p.steam_id === steamId);
        if (player) player.isClean = false;
        this.renderColumns(); this.updateStats();
        UI.showToast('Игрок убран из чистых ❌');
    }
};

// ── CSGO MANAGER ─────────────────────────────
const CSGO_SERVERS_CONFIG = [
    { id: 'mirage1_1', name: 'MIRAGE #1',  ip: '85.119.149.157', port: 27059 },
    { id: 'mirage1_2', name: 'MIRAGE #1',  ip: '94.26.255.98',   port: 27030 },
    { id: 'dust1',     name: 'DUST #1',    ip: '85.119.149.157', port: 27023 },
    { id: 'lake1',     name: 'LAKE #1',    ip: '94.26.255.98',   port: 27029 },
];

// Множество адресов CSGO серверов для быстрой проверки
const CSGO_ADDRS = new Set(CSGO_SERVERS_CONFIG.map(s => `${s.ip}:${s.port}`));

function getServerGameTag(serverIp, serverPort) {
    const addr = `${serverIp}:${serverPort}`;
    if (CSGO_ADDRS.has(addr)) return `<span class="game-tag csgo">CS:GO</span>`;
    return `<span class="game-tag cs2">CS2</span>`;
}

const CsgoManager = {
    // Какие серверы включены (по id)
    enabled: JSON.parse(localStorage.getItem('fearsearch_csgo_enabled') || 'null') || 
             Object.fromEntries(CSGO_SERVERS_CONFIG.map(s => [s.id, true])),
    data: [],
    timer: null,

    saveEnabled() {
        localStorage.setItem('fearsearch_csgo_enabled', JSON.stringify(this.enabled));
    },

    toggle(id) {
        this.enabled[id] = !this.enabled[id];
        this.saveEnabled();
        this.renderToggles();
        this.renderServers();
    },

    async refresh() {
        try {
            const res = await fetch('/api/csgo/servers');
            if (res.ok) this.data = await res.json();
        } catch {}
        this.renderServers();
        this.updateBadge();
    },

    updateBadge() {
        const total = this.data
            .filter(s => this.enabled[s.id])
            .reduce((sum, s) => sum + (s.playerCount || 0), 0);
        const badge = document.getElementById('csgo-online-badge');
        if (badge) badge.textContent = total;
    },

    renderToggles() {
        const container = document.getElementById('csgo-servers-toggle');
        if (!container) return;
        container.innerHTML = '';
        for (const srv of CSGO_SERVERS_CONFIG) {
            const on = this.enabled[srv.id];
            const btn = document.createElement('button');
            btn.className = `csgo-toggle-btn ${on ? 'active' : ''}`;
            btn.textContent = srv.name + ' · ' + srv.ip + ':' + srv.port;
            btn.onclick = () => this.toggle(srv.id);
            container.appendChild(btn);
        }
    },

    renderServers() {
        const container = document.getElementById('csgo-servers');
        if (!container) return;
        container.innerHTML = '';

        const visible = this.data.filter(s => this.enabled[s.id]);
        if (visible.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">🎮</span><p>Нет активных серверов</p></div>`;
            return;
        }

        for (const srv of visible) {
            const card = document.createElement('div');
            card.className = `csgo-server-card ${srv.online ? 'online' : 'offline'}`;
            const addr = escapeHtml(`${srv.ip}:${srv.port}`);
            card.innerHTML = `
                <div class="csgo-server-head">
                    <span class="csgo-status-dot ${srv.online ? 'online' : 'offline'}"></span>
                    <span class="csgo-server-name">${escapeHtml(srv.name)}</span>
                    <span class="csgo-server-map">${escapeHtml(srv.map || '—')}</span>
                    <span class="csgo-player-count">${srv.online ? `${srv.playerCount}/${srv.maxPlayers}` : 'Офлайн'}</span>
                    <button class="btn-connect-small" onclick="App.connectToServer('${addr}')">🎯 Connect</button>
                    <button class="btn-copy-small" onclick="App.copyConnect('${addr}')">📋</button>
                </div>
                <div class="csgo-server-addr">${addr}</div>
            `;
            container.appendChild(card);
        }
    },

    init() {
        this.renderToggles();
        this.refresh();
        // Обновляем каждые 30 секунд
        this.timer = setInterval(() => this.refresh(), 30000);
    },

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
};

// ── BANS MANAGER ─────────────────────────────
const BansManager = {
    _lastResult: {},
    _autoTimer: null,
    _currentSteamid: null,
    _loading: false,

    // Запуск автообновления (вызывается при переключении на вкладку Баны)
    startAuto() {
        if (!AuthManager.isStaff()) return;
        const steamid = AuthManager.user?.steamid || AuthManager.user?.steam_id || AuthManager.user?.steamId;
        if (!steamid) return;
        this._currentSteamid = steamid;
        // Сразу загружаем
        this._fetchAndUpdate(steamid, true);
        // Потом каждые 5 секунд
        if (this._autoTimer) clearInterval(this._autoTimer);
        this._autoTimer = setInterval(() => this._fetchAndUpdate(steamid, false), 5000);
    },

    stopAuto() {
        if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
    },

    async _fetchAndUpdate(steamid, firstLoad) {
        if (this._loading) return;
        this._loading = true;

        if (firstLoad) {
            document.getElementById('bans-stats').style.display = 'none';
            document.getElementById('bans-months').style.display = 'none';
            document.getElementById('bans-list').innerHTML = `<div class="loader"><div class="loader-ring"></div><span>Загружаю наказания...</span></div>`;
        }

        try {
            const headers = {};
            if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;

            const res = await fetch(`/api/fear/punishments?admin_steamid=${encodeURIComponent(steamid)}${this._forceRefresh ? '&force=1' : ''}`, {
                headers,
                signal: AbortSignal.timeout(10 * 60 * 1000)
            });
            this._forceRefresh = false;
            if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
            const data = await res.json();
            const bans  = data.bans  || [];
            const mutes = data.mutes || [];

            const prev = this._lastResult[steamid];
            this._lastResult[steamid] = { bans, mutes };

            if (firstLoad) {
                // Первая загрузка — полный рендер
                this.render(steamid, bans, mutes, data.fromCache, data.newCount || 0);
            } else {
                // Последующие — только обновляем статистику если изменилось
                const prevTotal = (prev?.bans?.length || 0) + (prev?.mutes?.length || 0);
                const newTotal  = bans.length + mutes.length;
                if (newTotal !== prevTotal) {
                    // Появились новые — полный перерендер с тостом
                    const diff = newTotal - prevTotal;
                    if (diff > 0) UI.showToast(`+${diff} новых наказаний`);
                    this.render(steamid, bans, mutes, data.fromCache, data.newCount || 0);
                } else {
                    // Просто обновляем время в статистике
                    this._updateTimestamp();
                }
            }
        } catch (e) {
            if (firstLoad) {
                document.getElementById('bans-list').innerHTML = `<div class="empty"><span class="empty-emoji">❌</span><p>${escapeHtml(e.message)}</p></div>`;
            }
        } finally {
            this._loading = false;
        }
    },

    _updateTimestamp() {
        const el = document.getElementById('bans-updated-at');
        if (el) el.textContent = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    render(steamid, bans, mutes, fromCache, newCount = 0) {
        const statsEl  = document.getElementById('bans-stats');
        const monthsEl = document.getElementById('bans-months');
        const listEl   = document.getElementById('bans-list');
        const all = [...bans, ...mutes].sort((a, b) => b.created - a.created);

        // Снятые = status=2 (Разбанен/Размучен — снят вручную)
        // status=1 = Активен, status=4 = Истёк срок
        const isRemoved = (b) => b.status === 2;
        const removedCount = all.filter(isRemoved).length;
        // Диагностика — логируем уникальные значения status
        const statuses = [...new Set(all.map(b => b.status))];
        console.log('[bans] статусы в данных:', statuses, '| снятых:', removedCount, '| пример:', JSON.stringify(all[0]).slice(0,200));
        // Логируем первую запись со статусом 4
        const s4 = all.find(b => b.status === 4);
        if (s4) console.log('[bans] пример status=4:', JSON.stringify(s4));
        // Логируем ВСЕ ключи первой записи чтобы найти поле снятия
        if (all[0]) console.log('[bans] все ключи записи:', Object.keys(all[0]).join(', '));
        // Ищем запись с ID 115993 (тот что был разбанен на скрине)
        const knownUnban = all.find(b => b.id === 115993 || String(b.id) === '115993');
        if (knownUnban) console.log('[bans] запись 115993 (разбанен):', JSON.stringify(knownUnban));

        // Считаем по месяцам (все наказания)
        const byMonth = {};
        for (const p of all) {
            const d = new Date(p.created * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            byMonth[key] = (byMonth[key] || 0) + 1;
        }
        const sortedMonths = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));
        const now = new Date();
        const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const thisMonth = byMonth[curKey] || 0;
        const loadedAt = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        statsEl.style.display = 'flex';
        statsEl.innerHTML = `
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-total">${all.length}</div>
                <div class="bans-stat-label" id="stat-total-label">Всего</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-bans">${bans.length}</div>
                <div class="bans-stat-label">Банов</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-mutes">${mutes.length}</div>
                <div class="bans-stat-label">Мутов</div>
            </div>
            <div class="bans-stat-card highlight">
                <div class="bans-stat-val" id="stat-thismonth">${thisMonth}</div>
                <div class="bans-stat-label">В этом месяце</div>
            </div>
            <div class="bans-stat-card" style="border-color:rgba(0,230,118,.3);background:rgba(0,230,118,.06)">
                <div class="bans-stat-val" id="stat-removed" style="color:var(--green)">${removedCount}</div>
                <div class="bans-stat-label">Снятые</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val">${sortedMonths.length}</div>
                <div class="bans-stat-label">Активных месяцев</div>
            </div>
            ${newCount > 0 ? `<div class="bans-stat-card new"><div class="bans-stat-val">+${newCount}</div><div class="bans-stat-label">Новых</div></div>` : ''}
            <div class="bans-stat-info">${fromCache ? '📦 Кеш · ' : ''}Обновлено: <span id="bans-updated-at">${loadedAt}</span> <button class="bans-refresh-btn" onclick="BansManager.forceRefresh()">🔄 Обновить</button></div>
        `;

        // ── По месяцам ──
        monthsEl.style.display = 'block';
        monthsEl.innerHTML = `<div class="bans-months-title">По месяцам</div><div class="bans-months-grid">` +
            sortedMonths.map(([key, count]) => {
                const [year, month] = key.split('-');
                const monthName = new Date(+year, +month - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
                const isThis = key === curKey;
                return `<div class="bans-month-item ${isThis ? 'current' : ''}">
                    <span class="bans-month-name">${monthName}</span>
                    <span class="bans-month-count">${count}</span>
                </div>`;
            }).join('') + `</div>`;

        // ── Список наказаний ──
        listEl.innerHTML = '';
        if (all.length === 0) {
            listEl.innerHTML = `<div class="empty"><span class="empty-emoji">✅</span><p>Наказаний не найдено</p></div>`;
            return;
        }

        // Фильтр по месяцу — кастомный дропдаун
        const filterWrap = document.createElement('div');
        filterWrap.className = 'bans-filter';
        const options = [
            { value: '', label: 'Все месяцы', count: all.length },
            ...sortedMonths.map(([key, count]) => {
                const [year, month] = key.split('-');
                const label = new Date(+year, +month - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
                return { value: key, label, count };
            })
        ];
        const curKey2 = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const defaultOpt = options.find(o => o.value === curKey2) || options[0];
        filterWrap.innerHTML = `
            <div class="bans-month-select" id="bans-month-select">
                <div class="bans-month-selected" onclick="BansManager._toggleDropdown()">
                    <span id="bans-month-label">${defaultOpt.label} <span style="color:rgba(255,61,61,.8)">(${defaultOpt.count})</span></span>
                    <span class="bans-month-arrow">▼</span>
                </div>
                <div class="bans-month-dropdown" id="bans-month-dropdown">
                    ${options.map(o => `
                        <div class="bans-month-option${o.value === defaultOpt.value ? ' active' : ''}"
                             data-value="${o.value}"
                             onclick="BansManager._selectMonth('${steamid}', '${o.value}', ${o.count}, this)">
                            <span>${o.label}</span>
                            <span class="opt-count">${o.count}</span>
                        </div>`).join('')}
                </div>
            </div>
        `;
        listEl.appendChild(filterWrap);
        // Закрывать при клике вне
        document.addEventListener('click', BansManager._outsideClick, { once: false });
        // Применяем дефолтный месяц
        BansManager._currentMonthFilter = defaultOpt.value;

        this._renderBanCards(listEl, all, defaultOpt.value);
    },

    _currentMonthFilter: '',
    _currentSteamid: '',
    _forceRefresh: false,
    _innerTab: 'all', // 'all' | 'removed'

    switchInner(tab, btn) {
        this._innerTab = tab;
        document.querySelectorAll('.bans-inner-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Перерендерим текущие данные
        const steamid = this._currentSteamid || (AuthManager.user?.steamid || AuthManager.user?.steam_id);
        if (!steamid || !this._lastResult[steamid]) return;
        const { bans, mutes } = this._lastResult[steamid];
        const all = [...bans, ...mutes].sort((a, b) => b.created - a.created);
        const listEl = document.getElementById('bans-list');
        const existing = listEl.querySelectorAll('.ban-card, .bans-filter');
        existing.forEach(c => c.remove());
        if (tab === 'removed') {
            const removed = all.filter(b => b.status === 0);
            this._renderBanCards(listEl, removed, '');
        } else {
            this._applyMonthFilter(steamid, this._currentMonthFilter);
        }
    },

    forceRefresh() {
        this._forceRefresh = true;
        const steamid = AuthManager.user?.steamid || AuthManager.user?.steam_id;
        if (steamid) this._fetchAndUpdate(steamid, true);
    },

    _toggleDropdown() {
        const sel = document.getElementById('bans-month-select');
        if (sel) sel.classList.toggle('open');
    },

    _outsideClick(e) {
        const sel = document.getElementById('bans-month-select');
        if (sel && !sel.contains(e.target)) sel.classList.remove('open');
    },

    _selectMonth(steamid, value, count, el) {
        // Обновляем активный пункт
        document.querySelectorAll('.bans-month-option').forEach(o => o.classList.remove('active'));
        el.classList.add('active');
        // Обновляем лейбл
        const labelEl = document.getElementById('bans-month-label');
        if (labelEl) {
            const name = el.querySelector('span:first-child').textContent;
            labelEl.innerHTML = `${name} <span style="color:rgba(255,61,61,.8)">(${count})</span>`;
        }
        // Закрываем
        const sel = document.getElementById('bans-month-select');
        if (sel) sel.classList.remove('open');
        // Фильтруем
        this._currentMonthFilter = value;
        this._applyMonthFilter(steamid, value);
    },

    _applyMonthFilter(steamid, month) {
        const result = this._lastResult[steamid];
        const all = [...(result?.bans || []), ...(result?.mutes || [])].sort((a, b) => b.created - a.created);
        const listEl = document.getElementById('bans-list');

        // Фильтруем подмножество
        const subset = month ? all.filter(b => {
            const d = new Date(b.created * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            return key === month;
        }) : all;

        const subBans    = subset.filter(b => b.punish_type === 1).length;
        const subMutes   = subset.filter(b => b.punish_type === 2).length;
        const subRemoved = subset.filter(b => b.status === 2).length;
        const label = month ? (() => {
            const [y, m] = month.split('-');
            return new Date(+y, +m - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
        })() : 'Всего';

        // Обновляем карточки по id
        const setCard = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setCard('stat-total', subset.length);
        const labelEl2 = document.getElementById('stat-total-label');
        if (labelEl2) labelEl2.textContent = label;
        setCard('stat-bans', subBans);
        setCard('stat-mutes', subMutes);
        setCard('stat-removed', subRemoved);
        // "В этом месяце" — показываем только если выбраны все
        const thisMonthEl = document.getElementById('stat-thismonth');
        if (thisMonthEl) {
            const now = new Date();
            const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const thisMonthCount = all.filter(b => {
                const d = new Date(b.created * 1000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === curKey;
            }).length;
            thisMonthEl.textContent = thisMonthCount;
        }

        const existing = listEl.querySelectorAll('.ban-card');
        existing.forEach(c => c.remove());
        this._renderBanCards(listEl, all, month);
    },

    filterByMonth(steamid) {
        // legacy — не используется, оставлен для совместимости
        this._applyMonthFilter(steamid, this._currentMonthFilter);
    },

    _renderBanCards(container, bans, monthFilter) {
        const filtered = monthFilter
            ? bans.filter(b => {
                const d = new Date(b.created * 1000);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                return key === monthFilter;
            })
            : bans;

        for (const ban of filtered) {
            const card = document.createElement('div');
            card.className = 'ban-card';

            const isMute = ban.punish_type === 2;
            const typeLabel = isMute
                ? `<span class="ban-type-badge mute">🔇 Мут</span>`
                : `<span class="ban-type-badge ban">🔨 Бан</span>`;

            const createdDate = UI.formatDateTime(new Date(ban.created * 1000).toISOString());
            // expires: если 0/null но есть duration — считаем сами (created + duration)
            // если duration тоже 0 — это перманентный бан
            let expiresDate;
            if (ban.expires && ban.expires > 0) {
                expiresDate = UI.formatDateTime(new Date(ban.expires * 1000).toISOString());
            } else if (ban.duration && ban.duration > 0) {
                expiresDate = UI.formatDateTime(new Date((ban.created + ban.duration) * 1000).toISOString());
            } else {
                expiresDate = 'Навсегда';
            }
            const duration = this._formatDuration(ban.duration);
            const isRemovedBan = ban.status === 2;
            const status = isRemovedBan
                         ? '<span class="ban-status unbanned">Разбанен</span>'
                         : ban.status === 1 ? '<span class="ban-status active">Активен</span>'
                         : '<span class="ban-status expired">Истёк</span>';
            const avatar = escapeHtml(ban.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg');

            card.innerHTML = `
                <img src="${avatar}" class="ban-avatar ${isMute ? 'mute' : ''} ban-avatar-clickable" loading="lazy"
                     onclick="App.openFearProfile('${escapeHtml(ban.steamid || '')}')" title="Открыть профиль на Fear"
                     onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                <div class="ban-info">
                    <div class="ban-name">${escapeHtml(ban.name || '—')} ${typeLabel}</div>
                    <div class="ban-steamid" onclick="App.copyToClipboard('${escapeHtml(ban.steamid || '')}')">${escapeHtml(ban.steamid || '—')}</div>
                    <div class="ban-reason">📋 ${escapeHtml(ban.reason || '—')}</div>
                    <div class="ban-meta">⏱ ${duration} · 📅 ${createdDate} · до ${expiresDate}</div>
                </div>
                <div class="ban-status-col">
                    ${status}
                    <div class="ban-btns">
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${escapeHtml(ban.steamid || '')}')">Steam</button>
                        <button class="btn-fear-small" onclick="App.openFearProfile('${escapeHtml(ban.steamid || '')}')">Fear</button>
                    </div>
                </div>
            `;
            container.appendChild(card);
        }
    },

    _formatDuration(seconds) {
        if (!seconds || seconds <= 0) return 'Навсегда';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        if (d > 0) return `${d} ${UI.declOfNum(d, ['день','дня','дней'])}`;
        if (h > 0) return `${h} ${UI.declOfNum(h, ['час','часа','часов'])}`;
        return `${seconds} сек`;
    }
};

// ── STAFF STATS MANAGER ──────────────────────
const StaffStatsManager = {
    _data: {},        // steamid -> { bans, mutes }
    _months: [],      // все доступные месяцы ['2026-03', ...]
    _selectedMonth: '',  // '' = все время
    _loaded: false,
    _loading: false,

    // Группы стаффа (без медиа, без STAFF и STADMIN)
    STAFF_GROUPS: new Set(['STMODER', 'MODER', 'MLMODER']),
    // Whitelist — только эти steamid из STAFF показываем
    STAFF_WHITELIST: new Set(['76561199826620628']),

    getStaffList() {
        return StaffManager.admins.filter(a => {
            if (a.group_name === 'STAFF' || a.group_name === 'STADMIN') {
                return this.STAFF_WHITELIST.has(a.steamid);
            }
            return this.STAFF_GROUPS.has(a.group_name);
        });
    },

    open() {
        // Проверяем доступ
        const sid = AuthManager.user?.steamid || AuthManager.user?.steam_id || '';
        const WHITELIST = new Set(['76561198751025670', '76561199645130988']);
        if (!WHITELIST.has(sid)) {
            document.getElementById('staffstats-list').innerHTML =
                `<div class="empty"><span class="empty-emoji">🔒</span><p>Нет доступа</p></div>`;
            return;
        }
        if (this._loaded) { this._render(); return; }
        // Пробуем загрузить из localStorage кеша
        try {
            const cached = localStorage.getItem('fs_staffstats_cache');
            if (cached) {
                const parsed = JSON.parse(cached);
                this._data = parsed.data || {};
                this._loaded = true;
                this._buildMonths();
                this._buildDropdown();
                this._render();
                // Показываем кеш сразу, потом тихо обновляем в фоне
                const age = Date.now() - (parsed.savedAt || 0);
                if (age > 30 * 60 * 1000) this.refresh(); // обновляем если старше 30 мин
                return;
            }
        } catch {}
        this.refresh();
    },

    async refresh() {
        const staff = this.getStaffList();
        if (staff.length === 0) {
            document.getElementById('staffstats-list').innerHTML =
                `<div class="empty"><span class="empty-emoji">👮</span><p>Список стаффа не загружен</p></div>`;
            return;
        }

        this._data = {};
        this._loading = true;
        this._loaded = false;

        const progressWrap = document.getElementById('staffstats-progress');
        const progressFill = document.getElementById('ss-progress-fill');
        const progressText = document.getElementById('ss-progress-text');

        progressWrap.style.display = 'flex';
        progressFill.style.width = '5%';
        progressText.textContent = `Загружаю данные для ${staff.length} человек...`;

        const headers = {};
        if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;

        try {
            // Один bulk запрос для всего стаффа
            const steamids = staff.map(m => m.steamid).join(',');
            const res = await fetch(`/api/fear/punishments/bulk?steamids=${encodeURIComponent(steamids)}`, {
                headers, signal: AbortSignal.timeout(10 * 60 * 1000)
            });

            if (res.ok) {
                const data = await res.json();
                for (const member of staff) {
                    const d = data[member.steamid];
                    if (d) {
                        this._data[member.steamid] = { bans: d.bans || [], mutes: d.mutes || [] };
                    } else {
                        this._data[member.steamid] = { bans: [], mutes: [] };
                    }
                }
                progressFill.style.width = '100%';
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn('[staffstats] bulk failed, fallback to individual:', e.message);
            // Fallback — грузим по одному батчами по 6
            let done = 0;
            const BATCH = 6;
            for (let i = 0; i < staff.length; i += BATCH) {
                const chunk = staff.slice(i, i + BATCH);
                await Promise.all(chunk.map(async (member) => {
                    try {
                        const r = await fetch(`/api/fear/punishments/by-admin?admin_steamid=${encodeURIComponent(member.steamid)}`, {
                            headers, signal: AbortSignal.timeout(3 * 60 * 1000)
                        });
                        if (r.ok) {
                            const d = await r.json();
                            this._data[member.steamid] = { bans: d.bans || [], mutes: d.mutes || [] };
                        } else {
                            this._data[member.steamid] = { bans: [], mutes: [] };
                        }
                    } catch {
                        this._data[member.steamid] = { bans: [], mutes: [] };
                    }
                    done++;
                    progressFill.style.width = Math.round(done / staff.length * 100) + '%';
                    progressText.textContent = `Загружаю ${done} / ${staff.length}...`;
                    if (done % 3 === 0 || done === staff.length) {
                        this._buildMonths(); this._buildDropdown(); this._render();
                    }
                }));
            }
        }

        progressWrap.style.display = 'none';
        this._loading = false;
        this._loaded = true;
        try {
            localStorage.setItem('fs_staffstats_cache', JSON.stringify({ data: this._data, savedAt: Date.now() }));
        } catch {}
        this._buildMonths();
        this._buildDropdown();
        this._render();
    },

    _buildMonths() {
        const monthSet = new Set();
        for (const { bans, mutes } of Object.values(this._data)) {
            for (const p of [...bans, ...mutes]) {
                const d = new Date(p.created * 1000);
                monthSet.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
            }
        }
        this._months = [...monthSet].sort((a,b) => b.localeCompare(a));
        // Дефолт — текущий месяц если есть
        const now = new Date();
        const curKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
        this._selectedMonth = this._months.includes(curKey) ? curKey : '';
    },

    _buildDropdown() {
        const staff = this.getStaffList();
        const dropdown = document.getElementById('ss-month-dropdown');
        const label    = document.getElementById('ss-month-label');
        if (!dropdown) return;

        // Считаем кол-во наказаний за каждый месяц (по всему стаффу)
        const monthTotals = {};
        for (const { bans, mutes } of Object.values(this._data)) {
            for (const p of [...bans, ...mutes]) {
                const d = new Date(p.created * 1000);
                const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                monthTotals[k] = (monthTotals[k] || 0) + 1;
            }
        }
        const totalAll = Object.values(this._data).reduce((s, d) => s + d.bans.length + d.mutes.length, 0);

        const options = [
            { value: '', label: 'Всё время', count: totalAll },
            ...this._months.map(k => {
                const [y, m] = k.split('-');
                const name = new Date(+y, +m-1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
                return { value: k, label: name, count: monthTotals[k] || 0 };
            })
        ];

        dropdown.innerHTML = options.map(o => `
            <div class="ss-month-option${o.value === this._selectedMonth ? ' active' : ''}"
                 onclick="StaffStatsManager._selectMonth('${o.value}', ${o.count}, this)">
                <span>${o.label}</span>
                <span class="opt-count">${o.count}</span>
            </div>`).join('');

        const cur = options.find(o => o.value === this._selectedMonth) || options[0];
        if (label) label.innerHTML = `${cur.label} <span style="color:rgba(168,85,247,.8)">(${cur.count})</span>`;
    },

    toggleDropdown() {
        document.getElementById('ss-month-select')?.classList.toggle('open');
    },

    _selectMonth(value, count, el) {
        document.querySelectorAll('.ss-month-option').forEach(o => o.classList.remove('active'));
        el.classList.add('active');
        const label = document.getElementById('ss-month-label');
        if (label) {
            const name = el.querySelector('span:first-child').textContent;
            label.innerHTML = `${name} <span style="color:rgba(168,85,247,.8)">(${count})</span>`;
        }
        document.getElementById('ss-month-select')?.classList.remove('open');
        this._selectedMonth = value;
        this._render();
    },

    _countFor(steamid) {
        const d = this._data[steamid];
        if (!d) return { bans: 0, mutes: 0, removed: 0, total: 0 };
        const filter = p => {
            if (!this._selectedMonth) return true;
            const k = new Date(p.created * 1000);
            return `${k.getFullYear()}-${String(k.getMonth()+1).padStart(2,'0')}` === this._selectedMonth;
        };
        const allBans  = d.bans.filter(filter);
        const allMutes = d.mutes.filter(filter);
        const bans   = allBans.length;
        const mutes  = allMutes.length;
        // status === 2 — снят вручную (Разбанен/Размучен)
        const isRemoved = (p) => p.status === 2;
        const removed = [...allBans, ...allMutes].filter(isRemoved).length;
        return { bans, mutes, removed, total: bans + mutes };
    },

    _groupLabel(group_name) {
        const MAP = { STAFF:'Стафф', STADMIN:'Ст. Администратор', STMODER:'Ст. Модер', MODER:'Модератор', MLMODER:'Мл. Модератор' };
        return MAP[group_name] || group_name;
    },

    _render() {
        const listEl = document.getElementById('staffstats-list');
        if (!listEl) return;

        const staff = this.getStaffList();
        if (staff.length === 0) {
            listEl.innerHTML = `<div class="empty"><span class="empty-emoji">👮</span><p>Нет данных</p></div>`;
            return;
        }

        // Считаем и сортируем
        const rows = staff.map(m => ({ ...m, ..._countFor_wrap(m.steamid, this) }))
            .sort((a, b) => b.total - a.total || b.bans - a.bans);

        const maxTotal = rows[0]?.total || 1;

        let html = `<div class="ss-row ss-row-header">
            <span>#</span><span></span><span>Стафф</span>
            <span style="text-align:center">Баны</span>
            <span style="text-align:center">Муты</span>
            <span style="text-align:center">Снятые</span>
            <span style="text-align:center">Всего</span>
        </div>`;

        rows.forEach((m, i) => {
            const rank = i + 1;
            const rankClass = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
            const avatar = m.avatar_full
                ? `<img class="ss-avatar ss-avatar-clickable" src="${escapeHtml(m.avatar_full)}" loading="lazy" onclick="App.openFearProfile('${escapeHtml(m.steamid)}')" title="Открыть профиль на Fear">`
                : `<div class="ss-avatar-placeholder ss-avatar-clickable" onclick="App.openFearProfile('${escapeHtml(m.steamid)}')" title="Открыть профиль на Fear">👤</div>`;
            const barPct = maxTotal > 0 ? Math.round(m.total / maxTotal * 100) : 0;

            html += `<div class="ss-row">
                <span class="ss-rank ${rankClass}">${rank}</span>
                ${avatar}
                <div class="ss-info">
                    <div class="ss-name">${escapeHtml(m.name)}</div>
                    <div class="ss-group">${this._groupLabel(m.group_name)}</div>
                </div>
                <div class="ss-stat"><span class="ss-stat-val bans">${m.bans}</span><span class="ss-stat-label">Баны</span></div>
                <div class="ss-stat"><span class="ss-stat-val mutes">${m.mutes}</span><span class="ss-stat-label">Муты</span></div>
                <div class="ss-stat"><span class="ss-stat-val" style="color:var(--green)">${m.removed}</span><span class="ss-stat-label">Снятые</span></div>
                <div class="ss-stat"><span class="ss-stat-val total">${m.total}</span><span class="ss-stat-label">Всего</span></div>
                <div class="ss-bar-wrap"><div class="ss-bar" style="width:${barPct}%"></div></div>
            </div>`;
        });

        listEl.innerHTML = html;

        // Закрывать дропдаун при клике вне
        document.addEventListener('click', (e) => {
            const sel = document.getElementById('ss-month-select');
            if (sel && !sel.contains(e.target)) sel.classList.remove('open');
        });
    },
};

function _countFor_wrap(steamid, mgr) { return mgr._countFor(steamid); }

// ── PARTICLES SYSTEM ─────────────────────────
const ParticlesSystem = {
    canvas: null, ctx: null, particles: [], raf: null,
    enabled: true, type: 'stars', count: 60, sizeMultiplier: 1.0,

    init() {
        this.canvas = document.getElementById('particles-canvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => { this.resize(); this.spawn(); });
        this.spawn();
        this.loop();
    },

    resize() {
        if (!this.canvas) return;
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
    },

    spawn() {
        this.particles = [];
        for (let i = 0; i < this.count; i++) this.addParticle(true);
    },

    addParticle(random = false) {
        const s = this.sizeMultiplier;
        this.particles.push({
            x: Math.random() * window.innerWidth,
            y: random ? Math.random() * window.innerHeight : window.innerHeight + 20,
            size: (Math.random() * 3 + 1.5) * s,
            opacity: Math.random() * 0.55 + 0.15,
            speedX: (Math.random() - 0.5) * 0.5,
            speedY: -(Math.random() * 0.6 + 0.2),
            rotation: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.025,
            wobble: Math.random() * Math.PI * 2,
            wobbleSpeed: Math.random() * 0.018 + 0.004,
            twinkle: Math.random() * Math.PI * 2,
            twinkleSpeed: Math.random() * 0.05 + 0.02,
        });
    },

    // ── Формы ──
    drawStar(ctx, x, y, r, rot) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const outer = (i * 4 * Math.PI) / 5 - Math.PI / 2;
            const inner = outer + Math.PI / 5;
            if (i === 0) ctx.moveTo(Math.cos(outer) * r, Math.sin(outer) * r);
            else ctx.lineTo(Math.cos(outer) * r, Math.sin(outer) * r);
            ctx.lineTo(Math.cos(inner) * r * 0.42, Math.sin(inner) * r * 0.42);
        }
        ctx.closePath(); ctx.fill(); ctx.restore();
    },

    drawSnowflake(ctx, x, y, r, rot) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        ctx.lineWidth = r * 0.18;
        ctx.strokeStyle = ctx.fillStyle;
        for (let i = 0; i < 6; i++) {
            const a = (i * Math.PI) / 3;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            // Ветки
            const bx = Math.cos(a) * r * 0.55, by = Math.sin(a) * r * 0.55;
            const ba = a + Math.PI / 2;
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(ba) * r * 0.28, by + Math.sin(ba) * r * 0.28);
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - Math.cos(ba) * r * 0.28, by - Math.sin(ba) * r * 0.28);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawDot(ctx, x, y, r) {
        // Точка с ореолом
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
        grad.addColorStop(0, ctx.fillStyle);
        grad.addColorStop(0.4, ctx.fillStyle);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r * 2, 0, Math.PI * 2);
        ctx.fill();
    },

    drawSakura(ctx, x, y, r, rot) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        for (let i = 0; i < 5; i++) {
            ctx.save(); ctx.rotate((i * Math.PI * 2) / 5);
            ctx.beginPath();
            ctx.ellipse(0, -r * 0.65, r * 0.32, r * 0.58, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.restore();
        }
        // Центр
        ctx.beginPath(); ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    },

    drawHeart(ctx, x, y, r, rot) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, r * 0.3);
        ctx.bezierCurveTo(-r * 1.1, -r * 0.4, -r * 1.1, -r * 1.2, 0, -r * 0.5);
        ctx.bezierCurveTo(r * 1.1, -r * 1.2, r * 1.1, -r * 0.4, 0, r * 0.3);
        ctx.closePath(); ctx.fill(); ctx.restore();
    },

    drawDiamond(ctx, x, y, r, rot) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r * 0.6, 0);
        ctx.lineTo(0, r); ctx.lineTo(-r * 0.6, 0);
        ctx.closePath(); ctx.fill(); ctx.restore();
    },

    loop() {
        if (!this.ctx) { this.raf = requestAnimationFrame(() => this.loop()); return; }
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (!this.enabled) { this.raf = requestAnimationFrame(() => this.loop()); return; }

        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent1').trim() || '#a855f7';

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.wobble += p.wobbleSpeed;
            p.twinkle += p.twinkleSpeed;
            p.x += p.speedX + Math.sin(p.wobble) * 0.35;
            p.y += p.speedY;
            p.rotation += p.rotSpeed;

            if (p.y < -30) { this.particles.splice(i, 1); this.addParticle(); continue; }

            // Мерцание для звёзд
            const twinkleOpacity = this.type === 'stars' ? p.opacity * (0.7 + 0.3 * Math.sin(p.twinkle)) : p.opacity;
            ctx.globalAlpha = twinkleOpacity;
            ctx.fillStyle = accent;

            const r = p.size;
            switch (this.type) {
                case 'stars':    this.drawStar(ctx, p.x, p.y, r * 1.8, p.rotation); break;
                case 'snow':     this.drawSnowflake(ctx, p.x, p.y, r * 2.2, p.rotation); break;
                case 'dots':     this.drawDot(ctx, p.x, p.y, r * 0.8); break;
                case 'sakura':   this.drawSakura(ctx, p.x, p.y, r * 2.2, p.rotation); break;
                case 'hearts':   this.drawHeart(ctx, p.x, p.y, r * 1.4, p.rotation); break;
                case 'diamonds': this.drawDiamond(ctx, p.x, p.y, r * 1.8, p.rotation); break;
                default:         this.drawStar(ctx, p.x, p.y, r * 1.8, p.rotation);
            }
        }
        ctx.globalAlpha = 1;
        this.raf = requestAnimationFrame(() => this.loop());
    },

    setEnabled(v) {
        this.enabled = v;
        if (!v && this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    },
    setType(t) { this.type = t; this.spawn(); },
    setCount(n) { this.count = Math.max(10, Math.min(200, n)); this.spawn(); },
    setSizeMultiplier(v) { this.sizeMultiplier = v; this.spawn(); },
};

// ── SETTINGS PANEL ───────────────────────────
const SettingsPanel = {
    _open: false,

    setZoom(v) {
        const factor = parseInt(v, 10) / 100;
        // Нативный зум Electron — масштабирует всё без обрезки
        if (window.electronAPI?.setZoom) {
            window.electronAPI.setZoom(factor);
        }
        document.body.style.zoom = '';
        const lbl = document.getElementById('zoom-val');
        if (lbl) lbl.textContent = parseInt(v) + '%';
        const slider = document.getElementById('zoom-slider');
        if (slider) slider.value = v;
        localStorage.setItem('fs_zoom', v);
    },

    toggle() {
        this._open = !this._open;
        document.getElementById('settings-panel')?.classList.toggle('open', this._open);
        document.getElementById('settings-overlay')?.classList.toggle('open', this._open);
    },

    setTheme(theme, btn) {
        document.documentElement.setAttribute('data-theme', theme === 'default' ? '' : theme);
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('fs_theme', theme);
        // Перезапускаем частицы чтобы подхватили новый цвет
        ParticlesSystem.spawn();
    },

    toggleParticles(v) {
        ParticlesSystem.setEnabled(v);
        localStorage.setItem('fs_particles', v ? '1' : '0');
    },

    setParticlesType(t) {
        ParticlesSystem.setType(t);
        localStorage.setItem('fs_particles_type', t);
    },

    setParticlesCount(v) {
        ParticlesSystem.setCount(parseInt(v));
        const lbl = document.getElementById('particles-count-val');
        if (lbl) lbl.textContent = v;
        localStorage.setItem('fs_particles_count', v);
    },

    setParticlesSize(v) {
        const factor = v / 10;
        ParticlesSystem.setSizeMultiplier(factor);
        const lbl = document.getElementById('particles-size-val');
        if (lbl) lbl.textContent = factor.toFixed(1) + 'x';
        localStorage.setItem('fs_particles_size', v);
    },

    // ── Гифка ──
    _applyGifStyle() {
        const el = document.getElementById('bg-gif');
        if (!el || !el.style.backgroundImage || el.style.backgroundImage === 'none') return;
        const x   = document.getElementById('gif-x')?.value   || 50;
        const y   = document.getElementById('gif-y')?.value   || 50;
        const sz  = document.getElementById('gif-size')?.value || 300;
        const rad = document.getElementById('gif-radius')?.value || 12;
        el.style.position   = 'fixed';
        el.style.width      = sz + 'px';
        el.style.height     = sz + 'px';
        el.style.left       = x + '%';
        el.style.top        = y + '%';
        el.style.transform  = 'translate(-50%, -50%)';
        el.style.borderRadius = rad + 'px';
        el.style.backgroundSize   = 'cover';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.zIndex     = '0';
        el.style.pointerEvents = 'none';
    },

    applyGif() {
        const url = document.getElementById('gif-url-input')?.value.trim();
        if (!url) return;
        const el = document.getElementById('bg-gif');
        if (!el) return;
        el.style.backgroundImage = `url('${url}')`;
        this._applyGifStyle();
        localStorage.setItem('fs_gif_url', url);
    },

    loadFromFile(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const el = document.getElementById('bg-gif');
            if (!el) return;
            el.style.backgroundImage = `url('${e.target.result}')`;
            this._applyGifStyle();
            localStorage.setItem('fs_gif_url', e.target.result);
            const inp = document.getElementById('gif-url-input');
            if (inp) inp.value = '(файл с диска)';
        };
        reader.readAsDataURL(file);
    },

    removeGif() {
        const el = document.getElementById('bg-gif');
        if (el) { el.style.backgroundImage = ''; el.style.cssText = ''; }
        localStorage.removeItem('fs_gif_url');
        const inp = document.getElementById('gif-url-input');
        if (inp) inp.value = '';
    },

    setGifOpacity(v) {
        const el = document.getElementById('bg-gif');
        if (el) el.style.opacity = v / 100;
        const lbl = document.getElementById('gif-opacity-val');
        if (lbl) lbl.textContent = v + '%';
        localStorage.setItem('fs_gif_opacity', v);
    },

    setGifSize(v) {
        const lbl = document.getElementById('gif-size-val');
        if (lbl) lbl.textContent = v + 'px';
        localStorage.setItem('fs_gif_size', v);
        this._applyGifStyle();
    },

    setGifXY() {
        const x = document.getElementById('gif-x')?.value || 50;
        const y = document.getElementById('gif-y')?.value || 50;
        const lx = document.getElementById('gif-x-val');
        const ly = document.getElementById('gif-y-val');
        if (lx) lx.textContent = x + '%';
        if (ly) ly.textContent = y + '%';
        localStorage.setItem('fs_gif_x', x);
        localStorage.setItem('fs_gif_y', y);
        this._applyGifStyle();
    },

    setGifRadius(v) {
        const lbl = document.getElementById('gif-radius-val');
        if (lbl) lbl.textContent = v + 'px';
        localStorage.setItem('fs_gif_radius', v);
        this._applyGifStyle();
    },

    // Устаревший метод — оставляем для совместимости
    setGifPosition(pos) { localStorage.setItem('fs_gif_pos', pos); },
    _applyGifPos() { this._applyGifStyle(); },

    restore() {
        // Масштаб
        const zoom = localStorage.getItem('fs_zoom');
        if (zoom) this.setZoom(zoom);

        // Тема
        const theme = localStorage.getItem('fs_theme') || 'default';
        if (theme !== 'default') {
            document.documentElement.setAttribute('data-theme', theme);
            document.querySelector(`.theme-btn[data-theme="${theme}"]`)?.classList.add('active');
            document.querySelector('.theme-btn[data-theme="default"]')?.classList.remove('active');
        }

        // Частицы
        const pe = localStorage.getItem('fs_particles');
        if (pe === '0') {
            ParticlesSystem.setEnabled(false);
            const cb = document.getElementById('particles-enabled');
            if (cb) cb.checked = false;
        }
        const pt = localStorage.getItem('fs_particles_type');
        if (pt) {
            ParticlesSystem.setType(pt);
            const sel = document.getElementById('particles-type');
            if (sel) sel.value = pt;
        }
        const pc = localStorage.getItem('fs_particles_count');
        if (pc) {
            this.setParticlesCount(pc);
            const rng = document.getElementById('particles-count');
            if (rng) rng.value = pc;
        }
        const ps = localStorage.getItem('fs_particles_size');
        if (ps) {
            this.setParticlesSize(ps);
            const rng = document.getElementById('particles-size');
            if (rng) rng.value = ps;
        }

        // Гифка
        const gifUrl = localStorage.getItem('fs_gif_url');
        if (gifUrl && gifUrl !== '(файл с диска)') {
            const inp = document.getElementById('gif-url-input');
            if (inp) inp.value = gifUrl;
            const el = document.getElementById('bg-gif');
            if (el) el.style.backgroundImage = `url('${gifUrl}')`;
        }
        const gifOp = localStorage.getItem('fs_gif_opacity');
        if (gifOp) {
            this.setGifOpacity(gifOp);
            const rng = document.getElementById('gif-opacity');
            if (rng) rng.value = gifOp;
        }
        // Восстанавливаем позицию/размер
        const restoreSlider = (id, key, fn) => {
            const v = localStorage.getItem(key);
            if (v) { const el = document.getElementById(id); if (el) el.value = v; if (fn) fn(v); }
        };
        restoreSlider('gif-size',   'fs_gif_size',   null);
        restoreSlider('gif-x',      'fs_gif_x',      null);
        restoreSlider('gif-y',      'fs_gif_y',      null);
        restoreSlider('gif-radius', 'fs_gif_radius', null);
        if (gifUrl) this._applyGifStyle();
    },
};

// ── SIDEBAR ──────────────────────────────────
const Sidebar = {
    toggle() {
        const sb = document.getElementById('sidebar');
        if (!sb) return;
        const collapsed = sb.classList.toggle('collapsed');
        localStorage.setItem('fs_sidebar_collapsed', collapsed ? '1' : '0');
    },
    restore() {
        if (localStorage.getItem('fs_sidebar_collapsed') === '1') {
            document.getElementById('sidebar')?.classList.add('collapsed');
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
    ParticlesSystem.init();
    SettingsPanel.restore();
    Sidebar.restore();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { App.stopAutoUpdate(); BansManager.stopAuto(); }
    else {
        App.startAutoUpdate(); App.updateData();
        // Если вкладка баны активна — возобновляем
        if (document.querySelector('.sidebar-nav-item[data-tab="bans"]')?.classList.contains('active')) {
            BansManager.startAuto();
        }
    }
});
window.App = App;

