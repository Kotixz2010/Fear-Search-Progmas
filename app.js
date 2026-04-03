// FearSearch App
const CONFIG = {
    API_URL: '/api/servers',
    STEAM_API_URL: '/api/steam/accountdates',
    STEAM_VAC_URL: '/api/steam/vacbans',

    UPDATE_INTERVAL: 5000,
};

// Рекорд стаффа
const STAFF_RECORD = Object.freeze({ count: 810, author: 'молочный' });

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

// Кастомные ники (steamid → ник) — два слоя: серверный (nicknames.json) и пользовательский (localStorage)
let customNicknames = {};
fetch('/nicknames.json').then(r => r.ok ? r.json() : {}).then(d => { customNicknames = d; }).catch(() => {});

// Пользовательские ники — хранятся в localStorage, перекрывают серверные
let userNicknames = JSON.parse(localStorage.getItem('fearsearch_user_nicks') || '{}');

function saveUserNicknames() {
    localStorage.setItem('fearsearch_user_nicks', JSON.stringify(userNicknames));
}

// Получить отображаемый ник: пользовательский > серверный > null
function getCustomNick(steamid) {
    return userNicknames[steamid] || customNicknames[steamid] || null;
}

// Установить/удалить пользовательский ник
function setUserNick(steamid, nick) {
    if (nick && nick.trim()) {
        userNicknames[steamid] = nick.trim();
    } else {
        delete userNicknames[steamid];
    }
    saveUserNicknames();
}

// Показать попап редактирования ника
function editNickPopup(steamid, currentNick, event) {
    event?.stopPropagation();
    // Убираем старый попап если есть
    document.querySelectorAll('.nick-edit-popup').forEach(p => p.remove());

    const popup = document.createElement('div');
    popup.className = 'nick-edit-popup';
    popup.innerHTML = `
        <div class="nick-edit-title">✏️ Кастомный ник</div>
        <input class="nick-edit-input" type="text" value="${escapeHtml(currentNick || '')}" placeholder="Введи ник..." maxlength="32" autofocus>
        <div class="nick-edit-btns">
            <button class="nick-edit-save">Сохранить</button>
            <button class="nick-edit-clear">Убрать</button>
            <button class="nick-edit-cancel">Отмена</button>
        </div>
    `;

    // Позиционируем рядом с курсором
    const rect = event?.target?.getBoundingClientRect?.() || { left: 200, top: 200 };
    popup.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
    popup.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(popup);

    const input = popup.querySelector('.nick-edit-input');
    input.focus();
    input.select();

    const close = () => popup.remove();

    popup.querySelector('.nick-edit-save').onclick = () => {
        setUserNick(steamid, input.value);
        close();
        App.renderColumns();
        StaffManager.render(Object.fromEntries(allPlayers.map(p => [p.steam_id, p])));
        PaidManager.render(Object.fromEntries(allPlayers.map(p => [p.steam_id, p])));
    };
    popup.querySelector('.nick-edit-clear').onclick = () => {
        setUserNick(steamid, '');
        close();
        App.renderColumns();
        StaffManager.render(Object.fromEntries(allPlayers.map(p => [p.steam_id, p])));
        PaidManager.render(Object.fromEntries(allPlayers.map(p => [p.steam_id, p])));
    };
    popup.querySelector('.nick-edit-cancel').onclick = close;
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') popup.querySelector('.nick-edit-save').click();
        if (e.key === 'Escape') close();
    });

    // Закрыть при клике вне
    setTimeout(() => document.addEventListener('click', function handler(e) {
        if (!popup.contains(e.target)) { close(); document.removeEventListener('click', handler); }
    }), 100);
}

// ── AUTH MANAGER ─────────────────────────────
const STAFF_STEAMIDS_EXTRA = new Set([
    '76561198751025670',
    '76561199645130988',
]);

// Владельцы — полный доступ ко всем функциям
const OWNERS = new Set(['76561198751025670', '76561199645130988']);

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
        if (this.user.adminGroup !== null && this.user.adminGroup !== undefined && this.user.adminGroup !== 0) return true;
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
        const isOwner = OWNERS.has(sid);

        // Стафф+Покупные — только для стаффа
        const staffCombinedEl = sel('staff-combined');
        if (staffCombinedEl) staffCombinedEl.style.display = show ? '' : 'none';

        // Норма — всегда видна
        const normaCombinedEl = sel('norma-combined');
        if (normaCombinedEl) normaCombinedEl.style.display = '';

        // Паблик баны — только для овнеров
        const pubEl = document.getElementById('nav-pubchecker') || sel('pubchecker');
        if (pubEl) pubEl.style.display = isOwner ? '' : 'none';

        // Статистика стаффа в объединённой вкладке — кнопка переключения только для овнеров
        const statsBtn = document.querySelector('#tab-norma-combined .combined-tab-btn[data-subtab="staffstats"]');
        if (statsBtn) statsBtn.style.display = isOwner ? '' : 'none';

        // Старые вкладки (скрываем — используем объединённые)
        ['staff','paid','bans','staffstats'].forEach(tab => {
            const el = sel(tab);
            if (el) el.style.display = 'none';
        });
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
                if (res.status === 403 && errData.error === 'frozen') {
                    // Показываем экран заморозки
                    const frozen = document.getElementById('frozen-screen');
                    const frozenName = document.getElementById('frozen-name');
                    if (frozen) frozen.style.display = 'flex';
                    if (frozenName) frozenName.textContent = `${errData.name || ''} · ${errData.group_display_name || errData.group_name || ''}`;
                } else if (res.status === 403) {
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
        // Если нет сохранённого токена — показываем gate
        if (!this.token || !this.user) {
            this.showGate(true);
            return false;
        }
        // Если есть кешированный пользователь — сразу показываем UI, проверяем в фоне
        this.showGate(false);
        this.renderUI();
        // loadAdmins без await — грузим в фоне
        this.loadAdmins().catch(() => {});

        // Фоновая проверка токена — не блокирует запуск
        this._checkTokenInBackground();
        return true;
    },

    async _checkTokenInBackground() {
        try {
            const res = await fetch('/api/fear/me', {
                headers: { 'x-auth-token': this.token },
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                // Только заморозку обрабатываем — всё остальное игнорируем
                if (err.error === 'frozen') {
                    const frozen = document.getElementById('frozen-screen');
                    const frozenName = document.getElementById('frozen-name');
                    if (frozen) frozen.style.display = 'flex';
                    if (frozenName) frozenName.textContent = `${err.name || this.user?.name || ''} · ${err.group_display_name || err.group_name || ''}`;
                    App.stopAutoUpdate();
                }
                // 401/403 и прочие ошибки — НЕ сбрасываем сессию, просто логируем
                console.warn('[auth] background check status:', res.status, err.error || '');
            } else {
                const freshUser = await res.json();
                this.user = { ...this.user, ...freshUser };
                localStorage.setItem('fearsearch_user', JSON.stringify(this.user));
                this.renderUI();
            }
        } catch (e) {
            console.warn('[auth] background check error:', e.message);
        }
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
        StaffTab.updateBadges();
    },

    render(onlineMap) {
        // Теперь рендерим через StaffTab
        StaffTab.tick(allPlayers);
    },

    renderInto(container, onlineMap) {
        container.innerHTML = '';
        if (!AuthManager.hasAccess()) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">🔒</span><p>Требуется доступ</p></div>`;
            return;
        }
        if (this.admins.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">💰</span><p>Нет данных о покупных</p></div>`;
            return;
        }

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
            const offline = group.members.filter(a => !onlineMap[a.steamid]);
            const frozen  = group.members.filter(a => a.is_frozen);
            const color   = COLOR[gname] || 'orange';
            const safeGid = 'p_' + gname.replace(/[^a-zA-Z0-9]/g, '_');

            const section = document.createElement('div');
            section.className = 'staff-section';
            section.innerHTML = `
                <div class="staff-section-head">
                    <span class="col-icon ${color}">💰</span>
                    <span class="staff-group-name">${escapeHtml(group.display)}</span>
                    <span class="staff-group-count ${color}">${online.length} онлайн · ${frozen.length} заморожено · ${group.members.length} всего</span>
                    ${offline.length > 0 ? `<button class="btn-toggle-offline" onclick="PaidManager.toggleOffline(this, '${safeGid}-offline')">Показать оффлайн (${offline.length})</button>` : ''}
                </div>
                <div class="staff-members" id="${safeGid}-online"></div>
                <div class="staff-members" id="${safeGid}-offline" style="display:none"></div>
            `;
            container.appendChild(section);

            const onlineEl  = section.querySelector(`#${safeGid}-online`);
            const offlineEl = section.querySelector(`#${safeGid}-offline`);

            for (const admin of online)  onlineEl.appendChild(this._makeCard(admin, onlineMap[admin.steamid]));
            for (const admin of offline) offlineEl.appendChild(this._makeCard(admin, null));
        }
    },

    _makeCard(admin, player) {
        const isOnline = !!player;
        const card = document.createElement('div');
        card.className = `staff-card ${isOnline ? 'online' : ''} ${admin.is_frozen ? 'frozen' : ''}`;

        const safeId     = escapeHtml(admin.steamid);
        const safeName   = escapeHtml(admin.name);
        const safeAvatar = escapeHtml(admin.avatar_full || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg');
        const frozenBadge = admin.is_frozen ? `<span class="staff-frozen">❄ Заморожен</span>` : '';
        const fearLastSeen = playerLastSeenOnFear[admin.steamid];

        let onlineInfo = '';
        if (isOnline) {
            const safeServer = escapeHtml(player.server?.name || '');
            const safeMap    = escapeHtml(player.server?.map || '');
            const safeAddr   = escapeHtml(`${player.server?.ip}:${player.server?.port}`);
            const teamClass  = player.team === 'ct' ? 'team-ct' : (player.team === 't' ? 'team-t' : 'team-spec');
            const teamLabel  = player.team === 'ct' ? 'CT' : (player.team === 't' ? 'T' : 'SPEC');
            const gameTag    = getServerGameTag(player.server?.ip, player.server?.port);
            onlineInfo = `
                <div class="sc-server-row">
                    <span class="player-team ${teamClass}">${teamLabel}</span>
                    <span class="sc-server-name">${safeServer} ${gameTag}</span>
                </div>
                <div class="sc-map-row">
                    <span class="sc-map">🗺️ ${safeMap}</span>
                    <span class="sc-kd">K/D: ${UI.calculateKD(player.kills, player.deaths)}</span>
                </div>
                <button class="sc-connect-btn" onclick="App.connectToServer('${safeAddr}')">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Connect
                </button>`;
        }

        const lastSeenHtml = !isOnline && fearLastSeen
            ? `<div class="sc-last-seen">👁 ${UI.formatDateTime(fearLastSeen)} <span>(${UI.getTimeAgo(fearLastSeen)})</span></div>`
            : '';

        const displayName = escapeHtml(getCustomNick(admin.steamid) || safeName);

        card.innerHTML = `
            <div class="sc-top">
                <img src="${safeAvatar}" class="sc-avatar ${isOnline ? 'online' : ''}" loading="lazy"
                     onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                <div class="sc-identity">
                    <div class="sc-name">${displayName}${frozenBadge}</div>
                    <div class="sc-steamid" onclick="App.copyToClipboard('${safeId}')">${safeId}</div>
                </div>
                <span class="sc-status ${isOnline ? 'online' : 'offline'}">${isOnline ? '● ОНЛАЙН' : '○ ОФФЛАЙН'}</span>
            </div>
            <div class="sc-body">${onlineInfo}${lastSeenHtml}</div>
            <div class="sc-actions">
                <button class="sc-btn steam" onclick="App.openSteamProfile('${safeId}')">Steam</button>
                <button class="sc-btn fear" onclick="App.openFearProfile('${safeId}')">Fear</button>
            </div>
        `;
        return card;
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

// ── STAFF TAB ────────────────────────────────
const StaffTab = {
    _current: 'staff', // 'staff' | 'paid'

    open() {
        this._current = 'staff';
        // Сбрасываем активную кнопку
        document.querySelectorAll('.staff-new-tab').forEach((b, i) => b.classList.toggle('active', i === 0));
        // Если данных нет — показываем лоадер и грузим
        if (StaffManager.admins.length === 0) {
            const body = document.getElementById('staff-new-body');
            if (body) body.innerHTML = '<div class="loader"><div class="loader-ring"></div><span>Загрузка стаффа...</span></div>';
            StaffManager.load().then(() => { this._render(); this.updateBadges(); });
        } else {
            this._render();
        }
    },

    switch(tab, btn) {
        this._current = tab;
        document.querySelectorAll('.staff-new-tab').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        this._render();
    },

    _render() {
        const body = document.getElementById('staff-new-body');
        if (!body) return;
        body.innerHTML = '';

        const onlineMap = Object.fromEntries(allPlayers.map(p => [p.steam_id, p]));

        if (this._current === 'staff') {
            StaffManager.renderInto(body, onlineMap);
        } else {
            PaidManager.renderInto(body, onlineMap);
        }
    },

    updateBadges() {
        const onlineMap = Object.fromEntries(allPlayers.map(p => [p.steam_id, p]));
        const staffOnline = StaffManager.admins.filter(a => onlineMap[a.steamid]).length;
        const paidOnline  = PaidManager.admins.filter(a => onlineMap[a.steamid]).length;
        const b1 = document.getElementById('staff-badge-staff');
        const b2 = document.getElementById('staff-badge-paid');
        const b3 = document.getElementById('staff-online-badge');
        if (b1) b1.textContent = staffOnline || StaffManager.admins.length;
        if (b2) b2.textContent = paidOnline  || PaidManager.admins.length;
        if (b3) b3.textContent = staffOnline;
    },

    tick(players) {
        this.updateBadges();
        const tab = document.getElementById('tab-staff-combined');
        if (tab && tab.classList.contains('active')) {
            this._render();
        }
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

            // Также грузим покупных из того же файла
            PaidManager.admins = all.filter(a => STAFF_GROUPS_EXCLUDE.includes(a.group_name));
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
        const badge2 = document.getElementById('staff-online-badge2');
        if (badge2) badge2.textContent = count;
    },

    render(onlineMap) {
        // Теперь рендерим через StaffTab
        StaffTab.tick(allPlayers);
    },

    renderInto(container, onlineMap) {
        container.innerHTML = '';

        if (this.admins.length === 0) {
            container.innerHTML = `<div class="empty"><span class="empty-emoji">👮</span><p>Нет данных о стаффе</p></div>`;
            return;
        }

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
            const groupColor = { STAFF: 'cyan', STADMIN: 'purple', STMODER: 'blue', MODER: 'green', MLMODER: 'orange', MEDIA: 'yellow' }[gname] || 'cyan';
            const safeGid = gname.replace(/[^a-zA-Z0-9]/g, '_');

            const section = document.createElement('div');
            section.className = 'staff-section';
            section.innerHTML = `
                <div class="staff-section-head">
                    <span class="col-icon ${groupColor}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                    </span>
                    <span class="staff-group-name">${escapeHtml(group.display)}</span>
                    <span class="staff-group-count ${groupColor}">${online.length} онлайн / ${group.members.length} всего</span>
                </div>
                <div class="staff-members" id="snew-group-${safeGid}"></div>
            `;
            container.appendChild(section);
            const membersEl = section.querySelector(`#snew-group-${safeGid}`);
            for (const admin of [...online, ...offline]) {
                membersEl.appendChild(this._makeCard(admin, onlineMap[admin.steamid]));
            }
        }
    },

    _makeCard(admin, player) {
        const isOnline = !!player;
        const card = document.createElement('div');
        card.className = `staff-card ${isOnline ? 'online' : ''} ${admin.is_frozen ? 'frozen' : ''}`;

        const safeId     = escapeHtml(admin.steamid);
        const safeName   = escapeHtml(admin.name);
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
            const kd         = UI.calculateKD(player.kills, player.deaths);
            onlineInfo = `
                <div class="sc-server-row">
                    <span class="player-team ${teamClass}">${teamLabel}</span>
                    <span class="sc-server-name">${safeServer} ${gameTag}</span>
                </div>
                <div class="sc-map-row">
                    <span class="sc-map">🗺️ ${safeMap}</span>
                    <span class="sc-kd">K/D: ${kd}</span>
                </div>
                <button class="sc-connect-btn" onclick="App.connectToServer('${safeAddr}')">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Connect
                </button>`;
        }

        const lastSeenHtml = !isOnline && fearLastSeenAdmin
            ? `<div class="sc-last-seen">👁 ${UI.formatDateTime(fearLastSeenAdmin)} <span>(${UI.getTimeAgo(fearLastSeenAdmin)})</span></div>`
            : '';

        const displayName = (() => { const cn = getCustomNick(admin.steamid); return cn || safeName; })();

        card.innerHTML = `
            <div class="sc-top">
                <img src="${safeAvatar}" class="sc-avatar ${isOnline ? 'online' : ''}" loading="lazy"
                     onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                <div class="sc-identity">
                    <div class="sc-name">${escapeHtml(displayName)}${frozenBadge}</div>
                    <div class="sc-steamid" onclick="App.copyToClipboard('${safeId}')">${safeId}</div>
                </div>
                <span class="sc-status ${isOnline ? 'online' : 'offline'}">${isOnline ? '● ОНЛАЙН' : '○ ОФФЛАЙН'}</span>
            </div>
            <div class="sc-body">${onlineInfo}${lastSeenHtml}</div>
            <div class="sc-actions">
                <button class="sc-btn steam" onclick="App.openSteamProfile('${safeId}')">Steam</button>
                <button class="sc-btn fear" onclick="App.openFearProfile('${safeId}')">Fear</button>
            </div>
        `;
        return card;
    },

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
        const container = document.getElementById('toast-container') || document.body;

        // Максимум 4 тоста — убираем самый старый (первый снизу = последний в DOM)
        const existing = container.querySelectorAll('.toast');
        if (existing.length >= 4) existing[existing.length - 1].remove();

        const toast = document.createElement('div');
        toast.className = type === 'error' ? 'toast error' : 'toast';
        toast.textContent = message;
        // Новые добавляем в начало (сверху)
        container.insertBefore(toast, container.firstChild);
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
        // Полный цикл (используется при автообновлении)
        const steamIdsNeedingDates = [];
        const steamIdsNeedingVac = [];
        for (const server of servers) {
            if (!server.live_data || !server.live_data.players) continue;
            for (const player of server.live_data.players) {
                if (!playerAccountDates[player.steam_id]) steamIdsNeedingDates.push(player.steam_id);
                if (!playerVacData[player.steam_id]) steamIdsNeedingVac.push(player.steam_id);
            }
        }
        if (steamIdsNeedingDates.length > 0 || steamIdsNeedingVac.length > 0) {
            const [datesResult, vacResult] = await Promise.all([
                steamIdsNeedingDates.length > 0 ? this.fetchExactAccountDates(steamIdsNeedingDates.slice(0, 100)) : Promise.resolve({}),
                steamIdsNeedingVac.length > 0    ? this.fetchVacBans(steamIdsNeedingVac.slice(0, 100))           : Promise.resolve({}),
            ]);
            for (const [steamId, data] of Object.entries(datesResult)) {
                if (data.timecreated) playerAccountDates[steamId] = new Date(data.timecreated * 1000).toISOString();
            }
            if (Object.keys(datesResult).length > 0)
                localStorage.setItem('fearsearch_account_dates', JSON.stringify(playerAccountDates));
            for (const [steamId, data] of Object.entries(vacResult)) playerVacData[steamId] = data;
            if (Object.keys(vacResult).length > 0)
                localStorage.setItem('fearsearch_vac_data', JSON.stringify(playerVacData));
        }
        return this._buildPlayerList(servers);
    },

    // Фаза 1 — мгновенно, только из кеша
    processPlayersQuick(servers) {
        return this._buildPlayerList(servers);
    },

    // Фаза 2 — догружаем Steam API и возвращаем обновлённый список
    async processPlayersSteam(servers) {
        const steamIdsNeedingDates = [];
        const steamIdsNeedingVac = [];
        for (const server of servers) {
            if (!server.live_data || !server.live_data.players) continue;
            for (const player of server.live_data.players) {
                if (!playerAccountDates[player.steam_id]) steamIdsNeedingDates.push(player.steam_id);
                if (!playerVacData[player.steam_id]) steamIdsNeedingVac.push(player.steam_id);
            }
        }
        if (steamIdsNeedingDates.length > 0 || steamIdsNeedingVac.length > 0) {
            const [datesResult, vacResult] = await Promise.all([
                steamIdsNeedingDates.length > 0 ? this.fetchExactAccountDates(steamIdsNeedingDates.slice(0, 100)) : Promise.resolve({}),
                steamIdsNeedingVac.length > 0    ? this.fetchVacBans(steamIdsNeedingVac.slice(0, 100))           : Promise.resolve({}),
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
        }
        if (!DataManager._lastSeenSaved || Date.now() - DataManager._lastSeenSaved > 60000) {
            localStorage.setItem('fearsearch_last_seen', JSON.stringify(playerLastSeenOnFear));
            DataManager._lastSeenSaved = Date.now();
        }
        return this._buildPlayerList(servers);
    },

    _buildPlayerList(servers) {
        const result = [];
        for (const server of servers) {
            if (!server.live_data || !server.live_data.players) continue;
            for (const player of server.live_data.players) {
                const accountDate = playerAccountDates[player.steam_id] ? new Date(playerAccountDates[player.steam_id]) : null;
                const vacInfo = playerVacData[player.steam_id] || null;
                playerLastSeenOnFear[player.steam_id] = new Date().toISOString();
                result.push({
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
        result.sort((a, b) => (b.accountDate?.getTime() || 0) - (a.accountDate?.getTime() || 0));
        return result;
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
    const gameTag        = getServerGameTag(player.server.ip, player.server.port);

    const siteAdmin = StaffManager.adminMap[player.steam_id];
    const siteNick = siteAdmin?.name || null;
    const customNick = getCustomNick(player.steam_id);
    const subNick = customNick || siteNick;
    const siteNickHtml = subNick && subNick !== player.nickname
        ? `<div class="player-site-nick" title="Известен как" onclick="editNickPopup('${escapeHtml(player.steam_id)}', '${escapeHtml(userNicknames[player.steam_id] || '')}', event)">✏️ ${escapeHtml(subNick)}</div>`
        : `<div class="player-site-nick player-site-nick-empty" onclick="editNickPopup('${escapeHtml(player.steam_id)}', '', event)" title="Добавить ник">✏️</div>`;

    const dateStr = UI.formatDate(player.accountDate);
    const dateTimeStr = UI.formatDateTime(player.accountDate);

    card.innerHTML = `
        ${player.isRecentVac ? `
        <div class="vac-badge">
            <span class="vac-badge-icon">🔨</span>
            <span class="vac-badge-text">VAC БАН (${player.vacInfo.numberOfVACBans} шт.) · ${player.vacInfo.daysSinceLastBan} дн. назад</span>
        </div>` : ''}

        <div class="pc-row1">
            <div class="pc-avatar-wrap">
                <img src="${safeAvatarUrl}" class="pc-avatar ${avatarClass}" loading="lazy"
                     onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                ${player.is_admin ? '<span class="pc-admin-dot">ADM</span>' : ''}
            </div>
            <div class="pc-identity">
                <div class="pc-name">${safeNickname}</div>
                ${siteNickHtml}
                <div class="pc-steamid" onclick="App.copyToClipboard('${safeSteamId}')">${safeSteamId}</div>
            </div>
        </div>

        <div class="pc-row2">
            <div class="pc-date-block ${ageClass}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <div>
                    <div class="pc-date-main">${dateStr}</div>
                    <div class="pc-date-ago">${timeAgo}</div>
                </div>
            </div>
            <div class="pc-server-block">
                <div class="pc-server-row">
                    <span class="player-team ${teamClass}">${teamLabel}</span>
                    <span class="pc-server-name">${safeServerName} ${gameTag}</span>
                </div>
                <div class="pc-server-map">🗺️ ${safeServerMap} · 🌐 ${safeAddress}</div>
                ${fearLastSeen ? `<div class="pc-last-seen">👁 ${UI.formatDateTime(fearLastSeen)} <span>(${UI.getTimeAgo(fearLastSeen)})</span></div>` : ''}
            </div>
        </div>

        <div class="pc-stats">
            <div class="pc-stat"><span class="pc-stat-label">Убийства</span><span class="pc-stat-val kills">${player.kills}</span></div>
            <div class="pc-stat"><span class="pc-stat-label">Смерти</span><span class="pc-stat-val deaths">${player.deaths}</span></div>
            <div class="pc-stat"><span class="pc-stat-label">Пинг</span><span class="pc-stat-val ping ${pingClass}">${player.ping}ms</span></div>
        </div>

        <div class="pc-btns1">
            <button class="pc-btn-flat" onclick="App.openSteamProfile('${safeSteamId}')">○ Профиль Steam</button>
            <button class="pc-btn-flat" onclick="App.openFearProfile('${safeSteamId}')">⌂ Профиль Fear</button>
            <button class="pc-btn-flat" onclick="App.copyToClipboard('${safeSteamId}')">⎘ SteamID</button>
        </div>
        <div class="pc-btns2">
            <button class="pc-btn-flat" onclick="App.copyConnect('${safeAddress}')">⚇ IP:PORT</button>
            <button class="pc-btn-primary" onclick="App.connectToServer('${safeAddress}')">▷ Подключиться</button>
        </div>
        <div class="pc-btns3">
            ${player.isClean
                ? `<button class="pc-btn-sm danger" onclick="App.removeCleanPlayer('${safeSteamId}')">✕ Убрать из чистых</button>`
                : `<button class="pc-btn-sm success" onclick="App.addCleanPlayer('${safeSteamId}')">✓ Чистый</button>`
            }
            <button class="pc-btn-sm" onclick="${TrackedManager.data[player.steam_id]
                ? `TrackedManager.remove('${safeSteamId}')`
                : `TrackedManager.add('${safeSteamId}', '${safeNickname}', '${safeAvatarUrl}')`
            }">👁 ${TrackedManager.data[player.steam_id] ? 'Не следить' : 'Следить'}</button>
        </div>
    `;
    return card;
}

const App = {
    async init() {
        this.setupEventListeners();
        this.setupTabs();
        // Убираем тестовую тему если была включена
        document.body.classList.remove('theme-test');
        try { localStorage.removeItem('theme_test'); } catch {}
        // Восстанавливаем состояние сайдбара
        if (localStorage.getItem('fs_sidebar_collapsed') === '1') {
            document.querySelector('.sidebar')?.classList.add('collapsed');
        }
        const authed = await AuthManager.init();
        if (!authed) return;
        await this.startApp();
    },

    // Запускается после успешной авторизации
    async startApp() {
        // Используется при повторной авторизации (без splash)
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
                    StaffStatsManager._updateTicketsCard(StaffStatsManager._ticketMonthly);
                } else if (tab === 'norma-combined') {
                    // Открываем активную подвкладку
                    App._openCombinedSubTab('norma-combined');
                } else if (tab === 'staff-combined') {
                    StaffTab.open();
                } else {
                    BansManager.stopAuto();
                }
                if (tab === 'staffstats') {
                    StaffStatsManager.open();
                }
                if (tab === 'playercheck') {
                    PlayerCheckManager.open();
                }
                if (tab === 'pubchecker') {
                    PubChecker.open();
                } else {
                    PubChecker.close();
                }
                if (tab === 'reports') {
                    ReportsManager.open();
                } else {
                    ReportsManager.close();
                }
                if (tab === 'servers') {
                    ServersManager.open();
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
        StaffTab.tick(allPlayers);
        this._reportSeenAdmins(allPlayers);
        const el = document.getElementById('last-update');
        if (el) el.textContent = new Date().toLocaleTimeString('ru-RU');
        const steamid = AuthManager.user?.steamid || AuthManager.user?.steam_id;
        if (steamid) BansManager._checkNew(steamid);
        // Обновляем вкладку серверов если открыта
        ServersManager.tick(serversData);
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
    _showCsgoPlayers: localStorage.getItem('fearsearch_show_csgo_players') !== '0',

    toggleSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const showBtn = document.querySelector('.sidebar-show-btn');
        if (!sidebar) return;
        const collapsed = sidebar.classList.toggle('collapsed');
        if (showBtn) showBtn.style.display = collapsed ? 'flex' : 'none';
        try { localStorage.setItem('fs_sidebar_collapsed', collapsed ? '1' : '0'); } catch {}
    },

    // Состояние подвкладок
    _combinedSubTabs: { 'norma-combined': 'bans', 'staff-combined': 'staff' },

    switchSubTab(combined, subtab, btn) {
        this._combinedSubTabs[combined] = subtab;
        // Обновляем кнопки
        document.querySelectorAll(`#tab-${combined} .combined-tab-btn`).forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        this._openCombinedSubTab(combined);
    },

    _openCombinedSubTab(combined) {
        // Дефолтные подвкладки для каждого combined
        const DEFAULTS = { 'norma-combined': 'bans', 'staff-combined': 'staff' };
        const VALID = {
            'norma-combined': new Set(['bans', 'staffstats']),
            'staff-combined': new Set(['staff', 'paid'])
        };

        const raw = this._combinedSubTabs[combined];
        const validSubtab = VALID[combined]?.has(raw) ? raw : DEFAULTS[combined];
        if (raw !== validSubtab) this._combinedSubTabs[combined] = validSubtab;

        if (combined === 'norma-combined') {
            // Показываем/скрываем нужный контент через CSS — без переноса DOM
            const bansEl = document.getElementById('tab-bans');
            const statsEl = document.getElementById('tab-staffstats');
            if (bansEl)  { bansEl.classList.toggle('active-panel',  validSubtab === 'bans');       bansEl.style.display  = validSubtab === 'bans'       ? '' : 'none'; }
            if (statsEl) { statsEl.classList.toggle('active-panel', validSubtab === 'staffstats'); statsEl.style.display = validSubtab === 'staffstats' ? '' : 'none'; }

            // Запускаем нужные менеджеры
            if (validSubtab === 'bans') {
                BansManager.startAuto();
                StaffStatsManager._updateTicketsCard(StaffStatsManager._ticketMonthly);
            } else if (validSubtab === 'staffstats') {
                BansManager.stopAuto();
                StaffStatsManager.open();
            }
        } else if (combined === 'staff-combined') {
            // staff-combined использует StaffTab напрямую
            StaffTab.open();
        }

        // Обновляем активную кнопку
        document.querySelectorAll(`#tab-${combined} .combined-tab-btn`).forEach(b => {
            b.classList.toggle('active', b.dataset.subtab === validSubtab);
        });
    },

    // Больше не нужен перенос DOM — оставляем пустым для совместимости
    _returnCombinedDom(combined) {},

    toggleCsgoPlayers(label) {
        this._showCsgoPlayers = !this._showCsgoPlayers;
        try { localStorage.setItem('fearsearch_show_csgo_players', this._showCsgoPlayers ? '1' : '0'); } catch {}
        const track = label?.querySelector('.toggler-track');
        if (track) track.classList.toggle('active', this._showCsgoPlayers);
        this.renderColumns();
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
        // Фильтр CS:GO игроков
        if (!this._showCsgoPlayers) {
            list = list.filter(p => {
                const addr = `${p.server?.ip}:${p.server?.port}`;
                return !CSGO_ADDRS.has(addr);
            });
        }
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

        // Если поиск по steamid и ничего не найдено — показываем подсказку
        if (searchQuery && searchQuery.length >= 5) {
            const allCards = document.querySelectorAll('.player-card');
            const visible = [...allCards].filter(c => !c.classList.contains('hidden'));
            const container = document.getElementById('all-players');
            const hint = document.getElementById('search-offline-hint');
            if (visible.length === 0 && container) {
                if (!hint) {
                    const div = document.createElement('div');
                    div.id = 'search-offline-hint';
                    div.className = 'empty';
                    div.innerHTML = `<span class="empty-emoji">🔍</span><p>Игрок офлайн или не найден</p>`;
                    container.appendChild(div);
                }
            } else if (hint) hint.remove();
        } else {
            const hint = document.getElementById('search-offline-hint');
            if (hint) hint.remove();
        }
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
    showInServers: localStorage.getItem('fearsearch_csgo_show') !== '0',
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
        const steamid = AuthManager.user?.steamid || AuthManager.user?.steam_id || AuthManager.user?.steamId;
        if (!steamid) return;
        this._currentSteamid = steamid;
        // Сразу загружаем при открытии вкладки
        this._fetchAndUpdate(steamid, true);
        // Проверка новых идёт через updateData каждые 5 сек — отдельный таймер не нужен
    },

    stopAuto() {
        if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
    },

    async _checkNew(steamid) {
        if (this._loading) return;
        try {
            const headers = {};
            if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
            const res = await fetch(`/api/fear/punishments/check-new?admin_steamid=${encodeURIComponent(steamid)}`, {
                headers, signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.hasNew) {
                console.log(`[bans] обнаружено ${data.newCount} новых наказаний — обновляем`);
                this._fetchAndUpdate(steamid, false);
            }
        } catch {}
    },

    async _fetchAndUpdate(steamid, firstLoad) {
        if (this._loading) return;
        this._loading = true;

        // Если есть кешированные данные — показываем сразу
        const cached = this._lastResult[steamid];
        const _getEl = (id) => document.getElementById(id);
        if (firstLoad && cached?.bans?.length) {
            this.render(steamid, cached.bans, cached.mutes, true, 0);
        } else if (firstLoad) {
            const statsEl = _getEl('bans-stats');
            const monthsEl = _getEl('bans-months');
            const listEl = _getEl('bans-list');
            if (statsEl) statsEl.style.display = 'none';
            if (monthsEl) monthsEl.style.display = 'none';
            if (listEl) listEl.innerHTML = `<div class="loader"><div class="loader-ring"></div><span>Загружаю наказания...</span></div>`;
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
                this._loadTickets();
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
                const listEl = document.getElementById('bans-list');
                if (listEl) listEl.innerHTML = `<div class="empty"><span class="empty-emoji">❌</span><p>${escapeHtml(e.message)}</p></div>`;
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
        const _getEl = (id) => document.getElementById(id);
        const statsEl  = _getEl('bans-stats');
        const monthsEl = _getEl('bans-months');
        const listEl   = _getEl('bans-list');
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

        // Считаем по месяцам (только не снятые)
        const byMonth = {};
        for (const p of all) {
            if (isRemoved(p)) continue; // снятые не считаем
            const d = new Date(p.created * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            byMonth[key] = (byMonth[key] || 0) + 1;
        }
        const sortedMonths = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));
        const now = new Date();
        const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const thisMonth = byMonth[curKey] || 0;
        const loadedAt = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const activeBans  = bans.filter(b => !isRemoved(b)).length;
        const activeMutes = mutes.filter(b => !isRemoved(b)).length;
        const activeTotal = activeBans + activeMutes; // Всего = активные баны + активные муты (снятые уже вычтены)

        // Рекорд месяца
        const recordKey = Object.entries(byMonth).sort((a,b) => b[1]-a[1])[0];
        const savedRecord = (() => { try { return JSON.parse(localStorage.getItem('fs_norma_record') || 'null'); } catch { return null; } })();
        if (recordKey && (!savedRecord || recordKey[1] > savedRecord.count)) {
            const [rYear, rMonth] = recordKey[0].split('-');
            const rName = new Date(+rYear, +rMonth-1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
            const newRecord = { count: recordKey[1], month: recordKey[0], monthName: rName, name: AuthManager.user?.name || 'Неизвестно' };
            try { localStorage.setItem('fs_norma_record', JSON.stringify(newRecord)); } catch {}
        }
        const record = (() => { try { return JSON.parse(localStorage.getItem('fs_norma_record') || 'null'); } catch { return null; } })();

        statsEl.style.display = 'flex';
        statsEl.innerHTML = `
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-total">${activeTotal}</div>
                <div class="bans-stat-label" id="stat-total-label">Всего</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-bans">${activeBans}</div>
                <div class="bans-stat-label">Банов</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val" id="stat-mutes">${activeMutes}</div>
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
            <div class="bans-stat-card" style="border-color:rgba(96,165,250,.3);background:rgba(96,165,250,.06)">
                <div class="bans-stat-val" id="stat-tickets" style="color:#60a5fa">—</div>
                <div class="bans-stat-label">Тикетов</div>
            </div>
            <div class="bans-stat-card">
                <div class="bans-stat-val">${sortedMonths.length}</div>
                <div class="bans-stat-label">Активных месяцев</div>
            </div>
            ${newCount > 0 ? `<div class="bans-stat-card new"><div class="bans-stat-val">+${newCount}</div><div class="bans-stat-label">Новых</div></div>` : ''}
            <div class="bans-stat-info">${fromCache ? '📦 Кеш · ' : ''}Обновлено: <span id="bans-updated-at">${loadedAt}</span> <button class="bans-refresh-btn" onclick="BansManager.forceRefresh()">🔄 Обновить</button>${OWNERS.has(AuthManager.user?.steamid || AuthManager.user?.steam_id || '') ? ` <button class="bans-refresh-btn" style="background:rgba(168,85,247,.15);border-color:rgba(168,85,247,.3);color:var(--purple);margin-left:4px" onclick="StaffStatsManager._resetTickets()">📥 Загрузить тикеты</button>` : ''}</div>
        `;

        // Восстанавливаем счётчик тикетов из кеша после перерисовки
        if (StaffStatsManager._ticketMonthly) {
            StaffStatsManager._updateTicketsCard(StaffStatsManager._ticketMonthly);
        } else {
            // Пробуем из localStorage
            try {
                const saved = localStorage.getItem('fs_ticket_monthly');
                if (saved) {
                    StaffStatsManager._ticketMonthly = JSON.parse(saved);
                    StaffStatsManager._updateTicketsCard(StaffStatsManager._ticketMonthly);
                }
            } catch {}
        }
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
            { value: '', label: 'Все месяцы', count: all.filter(b => !isRemoved(b)).length },
            ...sortedMonths.map(([key, count]) => {
                const [year, month] = key.split('-');
                const label = new Date(+year, +month - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
                return { value: key, label, count };
            })
        ];
        const curKey2 = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        // По умолчанию — "Все месяцы"
        const defaultOpt = options[0]; // options[0] = "Все месяцы"
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
        // Ищем в активном контейнере
        const body = document.getElementById('tab-bans');
        const sel = body?.querySelector('#bans-month-select') || document.getElementById('bans-month-select');
        if (sel) sel.classList.toggle('open');
    },

    _outsideClick(e) {
        const body = document.getElementById('tab-bans');
        const sel = body?.querySelector('#bans-month-select') || document.getElementById('bans-month-select');
        if (sel && !sel.contains(e.target)) sel.classList.remove('open');
    },

    _selectMonth(steamid, value, count, el) {
        // Обновляем активный пункт
        document.querySelectorAll('.bans-month-option').forEach(o => o.classList.remove('active'));
        el.classList.add('active');
        // Ищем лейбл и селект в активном контейнере
        const body = document.getElementById('tab-bans');
        const labelEl = body?.querySelector('#bans-month-label') || document.getElementById('bans-month-label');
        if (labelEl) {
            const name = el.querySelector('span:first-child').textContent;
            labelEl.innerHTML = `${name} <span style="color:rgba(255,61,61,.8)">(${count})</span>`;
        }
        // Закрываем
        const sel = body?.querySelector('#bans-month-select') || document.getElementById('bans-month-select');
        if (sel) sel.classList.remove('open');
        // Фильтруем — используем _currentSteamid как приоритет
        const sid = this._currentSteamid || steamid || (AuthManager.user?.steamid || AuthManager.user?.steam_id || '');
        this._currentMonthFilter = value;
        this._applyMonthFilter(sid, value);
        // Обновляем счётчик тикетов за выбранный месяц
        if (StaffStatsManager._ticketMonthly) {
            const body2 = document.getElementById('tab-bans');
            const ticketEl = body2?.querySelector('#stat-tickets') || document.getElementById('stat-tickets');
            if (ticketEl) {
                if (value) {
                    ticketEl.textContent = StaffStatsManager._ticketMonthly[value] || 0;
                } else {
                    const total = Object.values(StaffStatsManager._ticketMonthly).reduce((s, v) => s + v, 0);
                    ticketEl.textContent = total;
                }
            }
        }
    },

    async _loadTickets() {
        try {
            const headers = {};
            if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
            // Загружаем все страницы истории тикетов
            let allTickets = [];
            let page = 1;
            while (true) {
                const r = await fetch(`/api/fear/reports/history-all?page=${page}&limit=100`, { headers });
                if (!r.ok) break;
                const data = await r.json();
                const items = Array.isArray(data) ? data : (data.reports || data.data || []);
                if (!items.length) break;
                allTickets = allTickets.concat(items);
                const total = data.total || items.length;
                if (allTickets.length >= total || items.length < 100) break;
                page++;
                if (page > 20) break; // защита
            }
            this._tickets = allTickets;
            this._updateTicketStats();
        } catch {}
    },

    _updateTicketStats() {
        const body = document.getElementById('tab-bans');
        const el = body?.querySelector('#stat-tickets') || document.getElementById('stat-tickets');
        if (!el) return;
        // Приоритет: _ticketMonthly из StaffStatsManager (серверный кеш по месяцам)
        if (StaffStatsManager._ticketMonthly) {
            const month = this._currentMonthFilter;
            if (month) {
                el.textContent = StaffStatsManager._ticketMonthly[month] || 0;
            } else {
                const total = Object.values(StaffStatsManager._ticketMonthly).reduce((s, v) => s + v, 0);
                el.textContent = total;
            }
            return;
        }
        // Fallback: локальный массив тикетов
        if (!this._tickets) return;
        const month = this._currentMonthFilter;
        const filtered = month ? this._tickets.filter(t => {
            const d = new Date(t.created_at || t.created || 0);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            return key === month;
        }) : this._tickets;
        el.textContent = filtered.length;
    },

    _applyMonthFilter(steamid, month) {
        // Используем _currentSteamid как приоритет — он всегда актуален
        const sid = this._currentSteamid || steamid;
        const result = this._lastResult[sid];
        if (!result) {
            console.warn('[BansManager] no data for steamid:', sid, 'keys:', Object.keys(this._lastResult));
            return;
        }
        const all = [...(result.bans || []), ...(result.mutes || [])].sort((a, b) => b.created - a.created);
        // Ищем bans-list в активном контейнере
        const body = document.getElementById('tab-bans');
        const listEl = body?.querySelector('#bans-list') || document.getElementById('bans-list');

        // Фильтруем подмножество
        const subset = month ? all.filter(b => {
            const d = new Date(b.created * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            return key === month;
        }) : all;

        const subBans    = subset.filter(b => b.punish_type === 1 && b.status !== 2).length;
        const subMutes   = subset.filter(b => b.punish_type === 2 && b.status !== 2).length;
        const subRemoved = subset.filter(b => b.status === 2).length;
        const subActive  = subBans + subMutes; // Всего = активные баны + активные муты
        const label = month ? (() => {
            const [y, m] = month.split('-');
            return new Date(+y, +m - 1).toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
        })() : 'Всего';

        // Обновляем карточки по id — ищем в активном контейнере
        const getEl = (id) => body?.querySelector('#' + id) || document.getElementById(id);
        const setCard = (id, val) => { const el = getEl(id); if (el) el.textContent = val; };
        setCard('stat-total', subActive);
        const labelEl2 = getEl('stat-total-label');
        if (labelEl2) labelEl2.textContent = label;
        setCard('stat-bans', subBans);
        setCard('stat-mutes', subMutes);
        setCard('stat-removed', subRemoved);
        // "В этом месяце"
        const thisMonthEl = getEl('stat-thismonth');
        if (thisMonthEl) {
            const now = new Date();
            const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const thisMonthCount = all.filter(b => {
                const d = new Date(b.created * 1000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === curKey && b.status !== 2;
            }).length;
            thisMonthEl.textContent = thisMonthCount;
        }

        const existing = listEl.querySelectorAll('.ban-card');
        existing.forEach(c => c.remove());
        this._renderBanCards(listEl, all, month);
        this._updateTicketStats();
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

// ── MONTH DROPDOWN ───────────────────────────
class MonthDropdown {
  constructor(container, onSelect) {
    this._container = container;
    this._onSelect = onSelect;
    this._abortController = null;
    this._select = container.querySelector('[data-role="month-select"]');
    this._label = container.querySelector('[data-role="month-label"]');
    this._dropdown = container.querySelector('[data-role="month-dropdown"]');
    if (!this._select || !this._dropdown) {
      console.warn('[MonthDropdown] elements not found in container');
    }
  }

  open() {
    if (!this._select || !this._dropdown) return;
    this._select.classList.add('open');
    this._abortController?.abort();
    this._abortController = new AbortController();
    document.addEventListener('click', (e) => {
      if (!this._select.contains(e.target)) this.close();
    }, { signal: this._abortController.signal });
  }

  close() {
    if (!this._select) return;
    this._select.classList.remove('open');
    this._abortController?.abort();
    this._abortController = null;
  }

  toggle() {
    if (this._select && this._select.classList.contains('open')) {
      this.close();
    } else {
      this.open();
    }
  }

  select(monthKey, label) {
    if (this._label) this._label.textContent = label;
    this.close();
    if (this._onSelect) this._onSelect(monthKey);
  }

  destroy() {
    this._abortController?.abort();
    this._abortController = null;
  }
}

// ── STAFF STATS MANAGER ──────────────────────
const StaffStatsManager = {
    _data: {},
    _months: [],
    _selectedMonth: '',
    _loaded: false,
    _loading: false,
    _dropdown: null,
    // Загружаем _ticketMonthly из localStorage при старте — не теряем при обновлении
    _ticketMonthly: (() => {
        try {
            const s = localStorage.getItem('fs_ticket_monthly');
            return s ? JSON.parse(s) : null;
        } catch { return null; }
    })(),

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
        if (!OWNERS.has(sid)) {
            const listEl = document.getElementById('staffstats-list');
            if (listEl) listEl.innerHTML = `<div class="empty"><span class="empty-emoji">🔒</span><p>Нет доступа</p></div>`;
            return;
        }
        // Вставляем значения рекорда
        const recCount = document.getElementById('staff-record-count');
        const recAuthor = document.getElementById('staff-record-author');
        if (recCount) recCount.textContent = STAFF_RECORD.count;
        if (recAuthor) recAuthor.textContent = STAFF_RECORD.author;

        if (this._loaded) { this._buildDropdown(); this._initDropdown(); this._render(); return; }
        // Пробуем загрузить из localStorage кеша
        try {
            const cached = localStorage.getItem('fs_staffstats_cache');
            if (cached) {
                const parsed = JSON.parse(cached);
                this._data = parsed.data || {};
                this._loaded = true;
                this._buildMonths();
                this._buildDropdown();
                this._initDropdown();
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
            const listFallback = document.getElementById('staffstats-list');
            if (listFallback) listFallback.innerHTML = `<div class="empty"><span class="empty-emoji">👮</span><p>Список стаффа не загружен</p></div>`;
            return;
        }

        this._data = {};
        this._loading = true;
        this._loaded = false;

        const _getEl = (id) => document.getElementById(id);
        const progressWrap = _getEl('staffstats-progress');
        const progressFill = _getEl('ss-progress-fill');
        const progressText = _getEl('ss-progress-text');
        const listEl = _getEl('staffstats-list');

        // Показываем прогресс НЕМЕДЛЕННО
        if (progressWrap) { progressWrap.style.display = 'flex'; }
        if (progressFill) { progressFill.style.width = '5%'; }
        if (progressText) { progressText.textContent = `Загружаю данные для ${staff.length} человек...`; }
        if (listEl) { listEl.innerHTML = ''; }

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
                if (progressFill) progressFill.style.width = '100%';
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
                    if (progressFill) progressFill.style.width = Math.round(done / staff.length * 100) + '%';
                    if (progressText) progressText.textContent = `Загружаю ${done} / ${staff.length}...`;
                    if (done % 3 === 0 || done === staff.length) {
                        this._buildMonths(); this._buildDropdown(); this._render();
                    }
                }));
            }
        }

        progressWrap?.style && (progressWrap.style.display = 'none');
        this._loading = false;
        this._loaded = true;
        try {
            localStorage.setItem('fs_staffstats_cache', JSON.stringify({ data: this._data, savedAt: Date.now() }));
        } catch {}

        // Загружаем тикеты инкрементально — с кешем
        await this._loadTicketsIncremental(headers);

        this._buildMonths();
        this._buildDropdown();
        this._initDropdown();
        this._render();
    },

    // Кеш тикетов отдельно от основного кеша
    _TICKETS_CACHE_KEY: 'fs_tickets_cache',

    async _loadTicketsIncremental(headers) {
        // Показываем кеш мгновенно
        try {
            const statsRes = await fetch('/api/fear/reports/norma-stats', { headers, signal: AbortSignal.timeout(5000) });
            if (statsRes.ok) {
                const stats = await statsRes.json();
                if (stats.cached > 0) {
                    console.log(`[tickets] кеш: ${stats.cached} тикетов`);
                    this._ticketMonthly = stats.monthly || {};
                    this._updateTicketsCard(this._ticketMonthly);
                    this._buildMonths();
                    this._buildDropdown();
                    this._render();
                }
            }
        } catch {}

        // Умное обновление — только новые тикеты
        try {
            console.log('[tickets] сканирование новых...');
            const res = await fetch('/api/fear/reports/history-all', { headers, signal: AbortSignal.timeout(15 * 60 * 1000) });
            if (!res.ok) { console.log(`[tickets] scan failed: ${res.status}`); return; }
            const data = await res.json();
            if (data.stats) {
                this._ticketMonthly = data.stats.monthly || {};
                this._updateTicketsCard(this._ticketMonthly);
                console.log(`[tickets] итого: ${data.stats.total_tickets}, новых: ${data.newCount || 0}`);
            }
        } catch (e) { console.warn('[tickets] scan error:', e.message); }

        this._buildMonths();
        this._buildDropdown();
        this._render();
    },

    async _resetTickets() {
        const headers = {};
        if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
        UI.showToast('⏳ Загружаем все тикеты...');
        try {
            console.log('[tickets] полная загрузка с нуля (reset=1)...');
            const res = await fetch('/api/fear/reports/history-all?reset=1', { headers, signal: AbortSignal.timeout(15 * 60 * 1000) });
            if (!res.ok) { UI.showToast(`❌ Ошибка: ${res.status}`, 'error'); return; }
            const data = await res.json();
            if (data.stats) {
                this._ticketMonthly = data.stats.monthly || {};
                this._updateTicketsCard(this._ticketMonthly);
                UI.showToast(`✅ Загружено ${data.stats.total_tickets} тикетов`);
            }
        } catch (e) { UI.showToast('❌ ' + e.message, 'error'); }
        this._buildMonths();
        this._buildDropdown();
        this._render();
    },

    _applyTickets(allTickets) {
        // Группируем по admin_steamid для совместимости
        const ticketsByAdmin = {};
        for (const t of allTickets) {
            const sid = t.admin_steamid || t.closed_by || t.moderator_steamid || '';
            if (!sid) continue;
            if (!ticketsByAdmin[sid]) ticketsByAdmin[sid] = [];
            ticketsByAdmin[sid].push(t);
        }
        for (const sid of Object.keys(this._data)) {
            this._data[sid].tickets = ticketsByAdmin[sid] || [];
        }
        for (const [sid, tickets] of Object.entries(ticketsByAdmin)) {
            if (!this._data[sid]) this._data[sid] = { bans: [], mutes: [], tickets };
            else this._data[sid].tickets = tickets;
        }
    },

    // Обновляет карточку "Тикетов" в BansManager (вкладка Норма)
    _updateTicketsCard(monthly) {
        if (!monthly) return;
        // Сохраняем в localStorage чтобы не терять при обновлении
        try { localStorage.setItem('fs_ticket_monthly', JSON.stringify(monthly)); } catch {}
        // Ищем в активном контейнере
        const body = document.getElementById('tab-bans');
        const el = body?.querySelector('#stat-tickets') || document.getElementById('stat-tickets');
        if (!el) return;
        if (this._selectedMonth) {
            el.textContent = monthly[this._selectedMonth] || 0;
        } else {
            const total = Object.values(monthly).reduce((s, v) => s + v, 0);
            el.textContent = total;
        }
    },

    _buildMonths() {
        const monthSet = new Set();
        for (const { bans, mutes } of Object.values(this._data)) {
            for (const p of [...bans, ...mutes]) {
                const d = new Date((p.created || 0) * 1000);
                if (d.getFullYear() > 2000) monthSet.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
            }
        }
        // Добавляем месяцы из серверного кеша тикетов
        if (this._ticketMonthly) {
            for (const k of Object.keys(this._ticketMonthly)) monthSet.add(k);
        }
        this._months = [...monthSet].sort((a,b) => b.localeCompare(a));
        const now = new Date();
        const curKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
        this._selectedMonth = this._months.includes(curKey) ? curKey : '';
    },

    _buildDropdown() {
        const staff = this.getStaffList();
        const container = document.getElementById('tab-staffstats');
        const dropdown = container?.querySelector('[data-role="month-dropdown"]') ||
                         document.querySelector('[data-role="month-dropdown"]');
        const label    = container?.querySelector('[data-role="month-label"]') ||
                         document.querySelector('[data-role="month-label"]');
        if (!dropdown) return;

        // Считаем ВСЕ наказания за каждый месяц (включая снятые — как на сайте)
        const monthTotals = {};
        for (const { bans, mutes } of Object.values(this._data)) {
            for (const p of [...bans, ...mutes]) {
                const d = new Date((p.created || 0) * 1000);
                if (d.getFullYear() < 2000) continue;
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

    _initDropdown() {
        // Инициализируем MonthDropdown ПОСЛЕ того как _buildDropdown() заполнил DOM
        const container = document.getElementById('tab-staffstats');
        if (!container) return;
        const selectEl = container.querySelector('[data-role="month-select"]');
        if (!selectEl) return;
        this._dropdown?.destroy();
        this._dropdown = new MonthDropdown(container, (monthKey) => {
            this._selectedMonth = monthKey;
            this._render();
        });
    },

    toggleDropdown(triggerEl) {
        // Fallback — scoped поиск если _dropdown ещё не инициализирован
        const select = triggerEl?.closest('[data-role="month-select"]') ||
                       document.querySelector('#tab-staffstats [data-role="month-select"]') ||
                       document.querySelector('[data-role="month-select"]');
        if (!select) return;
        const wasOpen = select.classList.contains('open');
        document.querySelectorAll('[data-role="month-select"].open').forEach(el => el.classList.remove('open'));
        if (!wasOpen) {
            select.classList.add('open');
            const handler = (e) => {
                if (!select.contains(e.target)) {
                    select.classList.remove('open');
                    document.removeEventListener('click', handler);
                }
            };
            setTimeout(() => document.addEventListener('click', handler), 0);
        }
    },

    openCheck() {
        const modal = document.getElementById('player-check-modal');
        if (modal) modal.style.display = 'flex';
        setTimeout(() => document.getElementById('player-check-input')?.focus(), 100);
    },

    closeCheck() {
        const modal = document.getElementById('player-check-modal');
        if (modal) modal.style.display = 'none';
    },

    async checkPlayer() {
        const input = document.getElementById('player-check-input');
        const result = document.getElementById('player-check-result');
        const steamid = input?.value?.trim();
        if (!steamid) return;
        result.innerHTML = `<div style="text-align:center;padding:20px;color:var(--t3)">⏳ Загружаем...</div>`;
        try {
            const headers = {};
            if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
            const res = await fetch(`/api/fear/player-check/${encodeURIComponent(steamid)}`, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) { result.innerHTML = `<div style="color:#ff5050">❌ Ошибка ${res.status}</div>`; return; }
            const d = await res.json();
            const kd = d.kd || (d.kills && d.deaths ? (d.kills/Math.max(d.deaths,1)).toFixed(2) : '—');
            const hs = d.hs ? `${d.hs}%` : '—';
            const playtime = d.playtime ? `${Math.round(d.playtime/60)}ч` : '—';
            const lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleDateString('ru-RU') : (d.last_logoff ? new Date(d.last_logoff).toLocaleDateString('ru-RU') : '—');
            const reg = d.timecreated ? new Date(d.timecreated).toLocaleDateString('ru-RU') : '—';
            const name = d.fear_name || d.steam_name || steamid;
            const avatar = d.fear_avatar || d.steam_avatar || '';
            const group = d.fear_group ? `<span style="background:rgba(168,85,247,.2);color:var(--purple);padding:2px 8px;border-radius:4px;font-size:11px">${escapeHtml(d.fear_group)}</span>` : '';
            const online = d.steam_status > 0 ? `<span style="color:var(--green)">● В сети${d.steam_game ? ' · ' + escapeHtml(d.steam_game) : ''}</span>` : `<span style="color:var(--t3)">● Офлайн</span>`;
            const vacBanned = d.vac?.VACBanned ? `<span style="color:#ff5050;font-weight:700">⚠ VAC БАН (${d.vac.NumberOfVACBans})</span>` : '';
            result.innerHTML = `
                <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;padding:12px;background:var(--card);border-radius:10px">
                    ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:48px;height:48px;border-radius:50%">` : '<div style="width:48px;height:48px;border-radius:50%;background:var(--border)">👤</div>'}
                    <div>
                        <div style="font-size:16px;font-weight:700">${escapeHtml(name)} ${group}</div>
                        <div style="font-size:12px;color:var(--t3);margin:2px 0">${escapeHtml(steamid)}</div>
                        <div style="font-size:12px">${online} ${vacBanned}</div>
                    </div>
                    <div style="margin-left:auto;display:flex;gap:8px">
                        <button onclick="App.openSteamProfile('${escapeHtml(steamid)}')" style="padding:6px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--t2);cursor:pointer;font-size:12px">Steam</button>
                        <button onclick="App.openFearProfile('${escapeHtml(steamid)}')" style="padding:6px 12px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);border-radius:6px;color:var(--purple);cursor:pointer;font-size:12px">Fear</button>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                    ${[
                        ['K/D', kd, d.kills && d.deaths ? `(${d.kills}/${d.deaths})` : ''],
                        ['HS%', hs, ''],
                        ['Наиграно', playtime, ''],
                        ['Последний вход', lastSeen, ''],
                        ['Регистрация', reg, ''],
                        ['Steam Lvl', d.steam_level ?? '—', ''],
                        ['Друзья', d.friends_count ?? '—', ''],
                        ['Профиль', d.profile_state === 3 ? '<span style="color:var(--green)">Публичный</span>' : '<span style="color:#ff5050">Закрытый</span>', ''],
                    ].map(([label, val, sub]) => `
                        <div style="padding:10px;background:var(--card);border:1px solid var(--border);border-radius:8px;text-align:center">
                            <div style="font-size:11px;color:var(--t3);margin-bottom:4px">${label}</div>
                            <div style="font-size:15px;font-weight:700">${val}</div>
                            ${sub ? `<div style="font-size:10px;color:var(--t3)">${sub}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (e) { result.innerHTML = `<div style="color:#ff5050">❌ ${e.message}</div>`; }
    },

    _selectMonth(value, count, el) {
        document.querySelectorAll('.ss-month-option').forEach(o => o.classList.remove('active'));
        el.classList.add('active');
        // Scoped поиск label — ищем в активном контейнере
        const container = document.getElementById('tab-staffstats');
        const label = container?.querySelector('[data-role="month-label"]') ||
                      document.querySelector('[data-role="month-label"]');
        if (label) {
            const name = el.querySelector('span:first-child').textContent;
            label.innerHTML = `${name} <span style="color:rgba(168,85,247,.8)">(${count})</span>`;
        }
        // Закрываем через _dropdown если есть, иначе scoped поиск
        if (this._dropdown) {
            this._dropdown.close();
        } else {
            const select = container?.querySelector('[data-role="month-select"]') ||
                           document.querySelector('[data-role="month-select"]');
            select?.classList.remove('open');
        }
        this._selectedMonth = value;
        this._render();
    },

    _countFor(steamid) {
        const d = this._data[steamid];
        if (!d) return { bans: 0, mutes: 0, removed: 0, total: 0 };

        const filterByMonth = (dateMs) => {
            if (!this._selectedMonth) return true;
            const [y, m] = this._selectedMonth.split('-').map(Number);
            const start = new Date(y, m - 1, 1, 0, 0, 0).getTime();
            const end   = new Date(y, m, 0, 23, 59, 59, 999).getTime();
            return dateMs >= start && dateMs <= end;
        };

        const allBans  = d.bans.filter(p => filterByMonth((p.created || 0) * 1000));
        const allMutes = d.mutes.filter(p => filterByMonth((p.created || 0) * 1000));
        const isRemoved = (p) => p.status === 2;
        const removed = [...allBans, ...allMutes].filter(isRemoved).length;

        // Снятые всегда вычитаются из общего счёта
        const bans  = allBans.filter(p => !isRemoved(p)).length;
        const mutes = allMutes.filter(p => !isRemoved(p)).length;
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

            html += `<div class="ss-row" style="--bar-pct:${barPct}%">
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
            </div>`;
        });

        listEl.innerHTML = html;

        // Закрывать дропдаун при клике вне — управляется через MonthDropdown._abortController
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

// ── EASTER EGG ───────────────────────────────
const EasterEgg = {
    _LS_KEY: 'easter-egg-enabled',

    init() {
        const enabled = localStorage.getItem(this._LS_KEY) === 'true';
        const checkbox = document.getElementById('easter-egg-enabled');
        const btn = document.getElementById('easter-egg-btn');
        if (checkbox) checkbox.checked = enabled;
        if (btn) btn.disabled = !enabled;
    },

    setEnabled(val) {
        localStorage.setItem(this._LS_KEY, String(val));
        const btn = document.getElementById('easter-egg-btn');
        if (btn) btn.disabled = !val;
    },

    trigger() {
        if (localStorage.getItem(this._LS_KEY) !== 'true') return;
        this._showModal();
    },

    _showModal() {
        const existing = document.querySelector('.easter-egg-modal');
        if (existing) { existing.remove(); return; }
        const modal = document.createElement('div');
        modal.className = 'easter-egg-modal';
        modal.innerHTML = `
            <div class="easter-egg-inner">
                <div class="easter-egg-emoji">🥛</div>
                <div class="easter-egg-title">молочныйРейдизан</div>
                <div class="easter-egg-text">
                    Рекорд стаффа: <strong>${STAFF_RECORD.count} наказаний</strong><br>
                    Легенда fearproject.ru
                </div>
                <button onclick="this.closest('.easter-egg-modal').remove()">Закрыть</button>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add('visible'));
    }
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
        // Убираем сохранённый файл с диска если теперь URL
        if (window.electronAPI?.removeBgMedia) window.electronAPI.removeBgMedia();
    },

    loadFromFile(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            const el = document.getElementById('bg-gif');
            if (!el) return;
            el.style.backgroundImage = `url('${e.target.result}')`;
            this._applyGifStyle();
            // Сохраняем через electronAPI (обходим лимит localStorage)
            if (window.electronAPI?.saveBgMedia) {
                await window.electronAPI.saveBgMedia(e.target.result);
                localStorage.setItem('fs_gif_url', '__file__');
            } else {
                localStorage.setItem('fs_gif_url', e.target.result);
            }
            const inp = document.getElementById('gif-url-input');
            if (inp) inp.value = '(файл с диска)';
        };
        reader.readAsDataURL(file);
    },

    removeGif() {
        const el = document.getElementById('bg-gif');
        if (el) { el.style.backgroundImage = ''; el.style.cssText = ''; }
        localStorage.removeItem('fs_gif_url');
        if (window.electronAPI?.removeBgMedia) window.electronAPI.removeBgMedia();
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
        if (gifUrl === '__file__' && window.electronAPI?.loadBgMedia) {
            // Файл с диска — загружаем через electronAPI
            window.electronAPI.loadBgMedia().then(data => {
                if (!data) return;
                const el = document.getElementById('bg-gif');
                if (el) el.style.backgroundImage = `url('${data}')`;
                const inp = document.getElementById('gif-url-input');
                if (inp) inp.value = '(файл с диска)';
                this._applyGifStyle();
            });
        } else if (gifUrl && gifUrl !== '(файл с диска)') {
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

// ── CHECKER MANAGER ──────────────────────────
const CheckerManager = {
    _accounts: [], // { login, steamid }
    _results: {},

    init() {
        const input = document.getElementById('checker-file-input');
        if (input) input.addEventListener('change', (e) => this.loadFile(e.target.files[0]));
    },

    loadFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            this._accounts = this._parseVdf(text);
            if (this._accounts.length === 0) {
                UI.showToast('❌ Не найдено аккаунтов в файле', 'error');
                return;
            }
            UI.showToast(`✅ Загружено ${this._accounts.length} аккаунтов`);
            this._results = {};
            this._renderInitial();
            this._runCheck();
        };
        reader.readAsText(file, 'utf-8');
    },

    _parseVdf(text) {
        const accounts = [];
        const seen = new Set();
        // Ищем паттерн: "login" { "SteamID" "76561..." }
        const blockRe = /"([^"]+)"\s*\{[^}]*"SteamID"\s+"(7656\d{13})"[^}]*\}/gi;
        let m;
        while ((m = blockRe.exec(text)) !== null) {
            if (!seen.has(m[2])) {
                seen.add(m[2]);
                accounts.push({ login: m[1], steamid: m[2] });
            }
        }
        // Fallback — просто ищем все SteamID64
        if (accounts.length === 0) {
            const idRe = /7656\d{13}/g;
            const ids = [...new Set(text.match(idRe) || [])];
            ids.forEach(id => accounts.push({ login: '', steamid: id }));
        }
        return accounts;
    },

    checkManual() {
        const input = document.getElementById('checker-manual-input');
        const val = input?.value.trim();
        if (!val) return;
        // Поддерживаем несколько ID через запятую/пробел/перенос
        const ids = val.split(/[\s,;\n]+/).filter(v => /^7656\d{13}$/.test(v));
        if (ids.length === 0) { UI.showToast('❌ Введи корректный SteamID64', 'error'); return; }
        this._accounts = ids.map(id => ({ login: '', steamid: id }));
        this._results = {};
        this._renderInitial();
        this._runCheck();
        if (input) input.value = '';
    },

    clear() {
        this._accounts = [];
        this._results = {};
        document.getElementById('checker-list').innerHTML = `<div class="empty"><span class="empty-emoji">🔍</span><p>Загрузи config.vdf или введи SteamID</p></div>`;
        document.getElementById('checker-stats-row').style.display = 'none';
        document.getElementById('checker-progress').style.display = 'none';
    },

    _renderInitial() {
        const list = document.getElementById('checker-list');
        list.innerHTML = '';
        for (const acc of this._accounts) {
            list.appendChild(this._makeCard(acc, null));
        }
        document.getElementById('checker-stats-row').style.display = 'flex';
        this._updateStats();
    },

    async _runCheck() {
        const accounts = this._accounts;
        const total = accounts.length;
        const progressWrap = document.getElementById('checker-progress');
        const progressFill = document.getElementById('checker-progress-fill');
        const progressText = document.getElementById('checker-progress-text');

        progressWrap.style.display = 'flex';
        progressFill.style.width = '0%';
        progressText.textContent = `Проверяем 0 / ${total}...`;

        const checkOne = async (acc) => {
            try {
                const res = await fetch('/api/checker/check-one', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ steamid: acc.steamid, token: AuthManager.token })
                });
                if (res.ok) return await res.json();
            } catch {}
            return null;
        };

        // Первый проход — все аккаунты
        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            const info = await checkOne(acc);
            if (info) {
                this._results[acc.steamid] = info;
                this._updateCard(acc.steamid, info);
            }
            const pct = Math.round((i + 1) / total * 100 * 0.7);
            progressFill.style.width = pct + '%';
            progressText.textContent = `Проверяем ${i + 1} / ${total}...`;
            this._updateStats();
            await new Promise(r => setTimeout(r, 120));
        }

        // Повторные проходы (до 9 раз) — только для тех у кого нет бана и fearRegistered не false
        // Если уже забанен — не перепроверяем
        for (let pass = 2; pass <= 10; pass++) {
            const needRecheck = accounts.filter(a => {
                const r = this._results[a.steamid];
                if (!r) return true; // нет данных
                const hasFearBan = r.fearBans?.some(b => b.active !== false);
                if (hasFearBan) return false; // уже забанен на Fear — не перепроверяем
                if (r.fearRegistered === null) return true; // неизвестно — перепроверяем
                return false; // чистый или незарег — не перепроверяем
            });

            if (needRecheck.length === 0) break;

            progressText.textContent = `Проход ${pass}/10: перепроверяем ${needRecheck.length} аккаунтов...`;
            await new Promise(r => setTimeout(r, 300));

            for (let i = 0; i < needRecheck.length; i++) {
                const acc = needRecheck[i];
                const info = await checkOne(acc);
                if (info) {
                    this._results[acc.steamid] = info;
                    this._updateCard(acc.steamid, info);
                }
                const pct = 70 + Math.round((pass - 2) / 8 * 25) + Math.round((i + 1) / needRecheck.length * 3);
                progressFill.style.width = Math.min(pct, 99) + '%';
                this._updateStats();
                await new Promise(r => setTimeout(r, 150));
            }
        }

        progressFill.style.width = '100%';
        progressText.textContent = `✅ Готово! Проверено ${total} аккаунтов`;
        setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
        this._updateStats();
    },

    _makeCard(acc, info) {
        const card = document.createElement('div');
        card.className = 'checker-card status-loading';
        card.id = `checker-card-${acc.steamid}`;

        const status = info ? this._getStatus(info) : 'loading';
        card.className = `checker-card status-${status}`;

        const name = info?.name || acc.login || acc.steamid;
        const avatar = info?.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';
        const statusLabel = { loading: '⏳ Проверяем...', clean: '✅ Чистый', banned: '🔨 Забанен', noreg: '❓ Не зарег.' }[status];
        const statusClass = status;

        const bansHtml = info ? this._renderBans(info) : '';
        const fearBansHtml = info?.fearBans?.length ? this._renderFearBans(info.fearBans) : '';
        const fearHtml = info ? `<span class="checker-fear-reg ${info.fearRegistered === true ? 'yes' : info.fearRegistered === false ? 'no' : 'unknown'}">${info.fearRegistered === true ? '👻 Fear: зарег.' : info.fearRegistered === false ? '👻 Fear: нет' : '👻 Fear: ?'}</span>` : '';

        card.innerHTML = `
            <img src="${escapeHtml(avatar)}" class="checker-card-avatar"
                 onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
            <div class="checker-card-info">
                <div class="checker-card-name">${escapeHtml(name)}</div>
                ${acc.login ? `<div class="checker-card-login">🔑 ${escapeHtml(acc.login)}</div>` : ''}
                <div class="checker-card-steamid" onclick="App.copyToClipboard('${escapeHtml(acc.steamid)}')">${escapeHtml(acc.steamid)}</div>
                ${bansHtml}
                ${fearBansHtml}
            </div>
            <div class="checker-card-status">
                <span class="checker-status-pill ${statusClass}">${statusLabel}</span>
                ${fearHtml}
                <div class="checker-card-btns">
                    <button class="checker-btn-sm steam" onclick="App.openSteamProfile('${escapeHtml(acc.steamid)}')">Steam</button>
                    <button class="checker-btn-sm fear" onclick="App.openFearProfile('${escapeHtml(acc.steamid)}')">Fear</button>
                </div>
            </div>
        `;
        return card;
    },

    _updateCard(sid, info) {
        const acc = this._accounts.find(a => a.steamid === sid) || { login: '', steamid: sid };
        const card = document.getElementById(`checker-card-${sid}`);
        if (!card) return;
        const newCard = this._makeCard(acc, info);
        card.replaceWith(newCard);
    },

    _renderBans(info) {
        const items = [];
        if (info.vacBanned && info.numberOfVACBans > 0) {
            items.push(`<div class="checker-ban-item vac">🔴 VAC бан × ${info.numberOfVACBans} · ${info.daysSinceLastBan} дней назад</div>`);
        }
        if (info.numberOfGameBans > 0) {
            items.push(`<div class="checker-ban-item game">🟠 Game ban × ${info.numberOfGameBans}</div>`);
        }
        if (info.communityBanned) {
            items.push(`<div class="checker-ban-item comm">⚫ Community ban</div>`);
        }
        if (info.economyBan && info.economyBan !== 'none') {
            items.push(`<div class="checker-ban-item comm">💸 Trade ban: ${info.economyBan}</div>`);
        }
        return items.length ? `<div class="checker-card-bans">${items.join('')}</div>` : '';
    },

    _renderFearBans(fearBans) {
        if (!fearBans?.length) return '';
        const items = fearBans.map(b => {
            const reason  = escapeHtml(b.reason || '—');
            const expires = b.permanent
                ? 'навсегда'
                : b.expires
                    ? `до ${new Date(b.expires).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}`
                    : 'навсегда';
            return `<div class="checker-ban-item fear-ban active">
                🚫 Fear: ${reason} · ${expires}
            </div>`;
        });
        return `<div class="checker-card-bans">${items.join('')}</div>`;
    },

    _getStatus(info) {
        if (info.fearBans?.some(b => b.active !== false)) return 'banned';
        if (info.fearRegistered === false) return 'noreg';
        return 'clean';
    },

    _updateStats() {
        const results = Object.values(this._results);
        const banned = results.filter(r =>
            r.fearBans?.some(b => b.active !== false)
        ).length;
        const noreg  = results.filter(r => r.fearRegistered === false).length;
        const clean  = results.filter(r =>
            !r.fearBans?.some(b => b.active !== false) &&
            r.fearRegistered !== false
        ).length;
        document.getElementById('checker-stat-banned').textContent = banned;
        document.getElementById('checker-stat-noreg').textContent  = noreg;
        document.getElementById('checker-stat-clean').textContent  = clean;
        document.getElementById('checker-stat-total').textContent  = this._accounts.length;
    },
};

// ── PUB CHECKER ──────────────────────────────
const PubChecker = {
    _results: {},      // steamid -> { banned, expires, reason, name, avatar, source }
    _timer: null,
    _running: false,
    _sources: new Set(['yooma']),

    open() {
        const sid = AuthManager.user?.steamid || AuthManager.user?.steam_id || '';
        if (!OWNERS.has(sid)) {
            document.getElementById('pubchecker-list').innerHTML =
                `<div class="empty"><span class="empty-emoji">🔒</span><p>Нет доступа</p></div>`;
            return;
        }
        if (!this._timer) this._startTimer();
        this._run();
    },

    close() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    _startTimer() {
        this._timer = setInterval(() => this._run(), 5 * 60 * 1000);
    },

    toggleSource(src, btn) {
        if (this._sources.has(src)) {
            if (this._sources.size === 1) return; // минимум один
            this._sources.delete(src);
            btn.classList.remove('active');
        } else {
            this._sources.add(src);
            btn.classList.add('active');
        }
        this._run();
    },

    refresh() { this._run(); },

    async refreshCache() {
        const text = document.getElementById('pubchecker-progress-text');
        const prog = document.getElementById('pubchecker-progress');
        if (prog) prog.style.display = 'flex';
        if (text) text.textContent = '🔃 Обновляем кеш yooma...';
        try {
            await fetch('/api/pubcheck/yooma/refresh', { method: 'POST' });
            if (text) text.textContent = '⏳ Сканирование запущено (~2-3 мин)';
            setTimeout(() => {
                if (prog) prog.style.display = 'none';
                this._run();
            }, 5000);
        } catch (e) {
            if (text) text.textContent = '❌ ' + e.message;
        }
    },

    // Проверяем игроков через yooma WS — get_profile для каждого
    async _yoomaCheckBrowser(steamids) {
        const results = {};
        const nowSec = Math.floor(Date.now() / 1000);

        return new Promise((resolve) => {
            const pending = new Set(steamids);

            const finish = () => {
                try { ws?.close(); } catch {}
                resolve(results);
            };

            const timer = setTimeout(() => {
                console.log(`[yooma] timeout, got ${Object.keys(results).length}/${steamids.length}`);
                finish();
            }, 30000);

            let ws;
            try {
                ws = new WebSocket('wss://yooma.su/api');
            } catch (e) {
                clearTimeout(timer);
                resolve(results);
                return;
            }

            ws.onopen = () => {
                console.log(`[yooma] connected, sending ${steamids.length} get_profile requests`);
                for (const sid of steamids) {
                    ws.send(JSON.stringify({ type: 'get_profile', steam_id: sid }));
                }
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'get_profile' && msg.profile) {
                        const sid = String(msg.profile.steam_id || '');
                        if (!pending.has(sid)) return;
                        pending.delete(sid);

                        // ban существует → забанен, ban null/отсутствует → чистый
                        const banObj = msg.profile.ban || null;
                        const banExpires = banObj?.expires ?? null;
                        // Активный бан: есть объект ban И (expires=0 или expires > now)
                        const banned = !!(banObj && (banExpires === 0 || banExpires === null || banExpires > nowSec));

                        results[sid] = {
                            steamid: sid,
                            banned,
                            expires: banExpires || null,
                            reason: this._shortReason(null), // reason в get_profile не приходит
                            reasonFull: '—',
                            name: msg.profile.display_name || null,
                            avatar: msg.profile.avatar_hash
                                ? `https://avatars.akamai.steamstatic.com/${msg.profile.avatar_hash}_medium.jpg`
                                : null,
                            source: 'yooma',
                        };

                        if (pending.size === 0) { clearTimeout(timer); finish(); }
                    }
                } catch {}
            };

            ws.onerror = (e) => { console.log('[yooma] WS error:', e.type); clearTimeout(timer); finish(); };
            ws.onclose = () => { clearTimeout(timer); finish(); };
        });
    },

    _shortReason(reason) {
        if (!reason) return '—';
        const r = reason.toLowerCase();
        if (r.includes('haron') || r.includes('anti-cheat') || r.includes('античит')) return 'AC';
        if (r.includes('отказ') || r.includes('проверк')) return 'Отказ';
        if (r.includes('обход')) return 'Обход';
        if (r.includes('чит') || r.includes('hack') || r.includes('cheat')) return 'Читы';
        return reason.slice(0, 30);
    },

    async _run() {
        if (this._running) return;
        this._running = true;

        const steamids = allPlayers.map(p => p.steam_id).filter(Boolean);
        if (steamids.length === 0) {
            this._running = false;
            this._renderEmpty('Нет игроков онлайн');
            return;
        }

        const prog = document.getElementById('pubchecker-progress');
        const fill = document.getElementById('pubchecker-progress-fill');
        const text = document.getElementById('pubchecker-progress-text');
        if (prog) prog.style.display = 'flex';
        if (fill) fill.style.width = '10%';
        if (text) text.textContent = `Проверяем ${steamids.length} игроков на yooma...`;

        try {
            if (this._sources.has('yooma')) {
                // Батчами по 10 — yooma закрывает соединение при большом количестве
                const BATCH = 10;
                for (let i = 0; i < steamids.length; i += BATCH) {
                    const chunk = steamids.slice(i, i + BATCH);
                    if (text) text.textContent = `yooma: ${i}/${steamids.length}...`;
                    const data = await this._yoomaCheckBrowser(chunk);
                    const got = Object.keys(data).length;
                    const banned = Object.values(data).filter(r => r.banned).length;
                    console.log(`[pubcheck] batch ${i}-${i+BATCH}: got ${got}, banned ${banned}`);
                    for (const [sid, info] of Object.entries(data)) {
                        if (info.banned) this._results[sid] = info;
                        else if (!this._results[sid]?.banned) this._results[sid] = info;
                    }
                    if (fill) fill.style.width = Math.round((i + BATCH) / steamids.length * 80) + '%';
                    // Пауза между батчами чтобы не перегружать yooma
                    if (i + BATCH < steamids.length) await new Promise(r => setTimeout(r, 500));
                }
            }
            if (this._sources.has('cs2red')) {
                if (text) text.textContent = 'Проверяем cs2red...';
                const res = await fetch('/api/pubcheck/cs2red', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ steamids })
                });
                if (res.ok) {
                    const data = await res.json();
                    for (const [sid, info] of Object.entries(data)) {
                        if (info.banned) this._results[sid] = info;
                        else if (!this._results[sid]?.banned) this._results[sid] = info;
                    }
                }
            }
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = '✅ Готово';
            setTimeout(() => { if (prog) prog.style.display = 'none'; }, 1500);
        } catch (e) {
            if (text) text.textContent = '❌ Ошибка: ' + e.message;
        }

        this._running = false;
        this._render();
    },    _render() {
        const listEl = document.getElementById('pubchecker-list');
        const statsRow = document.getElementById('pubchecker-stats-row');
        if (!listEl) return;

        // Только игроки онлайн у которых есть результат
        const entries = allPlayers
            .map(p => ({ player: p, info: this._results[p.steam_id] }))
            .filter(e => e.info);

        const banned = entries.filter(e => e.info.banned);
        const total = entries.length;

        if (statsRow) {
            statsRow.style.display = 'flex';
            const el = id => document.getElementById(id);
            if (el('pub-stat-banned')) el('pub-stat-banned').textContent = banned.length;
            if (el('pub-stat-total'))  el('pub-stat-total').textContent  = total;
            if (el('pub-stat-updated')) el('pub-stat-updated').textContent = new Date().toLocaleTimeString('ru-RU');
        }

        // Обновляем бейдж
        const badge = document.getElementById('pubchecker-badge');
        if (badge) {
            badge.textContent = banned.length;
            badge.style.display = banned.length > 0 ? '' : 'none';
        }

        if (entries.length === 0) {
            listEl.innerHTML = `<div class="empty"><span class="empty-emoji">✅</span><p>Нет данных — нажми Обновить</p></div>`;
            return;
        }

        // Сортируем: сначала забаненные
        entries.sort((a, b) => (b.info.banned ? 1 : 0) - (a.info.banned ? 1 : 0));

        listEl.innerHTML = '';
        for (const { player, info } of entries) {
            if (!info.banned) continue; // показываем только забаненных
            const card = document.createElement('div');
            card.className = 'pub-ban-card';
            const avatar = escapeHtml(info.avatar || player.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg');
            const name = escapeHtml(info.name || player.name || player.steam_id);
            const expires = info.expires
                ? `до ${new Date(info.expires * 1000).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}`
                : 'навсегда';
            const srcBadge = `<span class="pub-src-badge ${escapeHtml(info.source)}">${escapeHtml(info.source)}</span>`;
            const server = escapeHtml(player.server?.name || '—');

            card.innerHTML = `
                <img src="${avatar}" class="pub-ban-avatar"
                     onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                <div class="pub-ban-info">
                    <div class="pub-ban-name">${name} ${srcBadge}</div>
                    <div class="pub-ban-steamid" onclick="App.copyToClipboard('${escapeHtml(player.steam_id)}')">${escapeHtml(player.steam_id)}</div>
                    <div class="pub-ban-reason">📋 ${escapeHtml(info.reason || '—')} · ⏱ ${expires}</div>
                    <div class="pub-ban-server">🖥 ${server}</div>
                </div>
                <div class="pub-ban-btns">
                    <button class="btn-steam-small" onclick="App.openSteamProfile('${escapeHtml(player.steam_id)}')">Steam</button>
                    <button class="btn-fear-small" onclick="App.openFearProfile('${escapeHtml(player.steam_id)}')">Fear</button>
                    <button class="btn-fear-small" style="background:rgba(255,165,0,.15);border-color:rgba(255,165,0,.3)"
                            onclick="window.open('https://yooma.su/ru/profile/${escapeHtml(player.steam_id)}','_blank')">Yooma</button>
                </div>
            `;
            listEl.appendChild(card);
        }

        if (listEl.children.length === 0) {
            listEl.innerHTML = `<div class="empty"><span class="empty-emoji">✅</span><p>Забаненных на пабликах нет</p></div>`;
        }
    },

    _renderEmpty(msg) {
        const listEl = document.getElementById('pubchecker-list');
        if (listEl) listEl.innerHTML = `<div class="empty"><span class="empty-emoji">🌐</span><p>${msg}</p></div>`;
    }
};

// ── REPORTS MANAGER ──────────────────────────
const ReportsManager = {
    _reports: [],
    _tab: 'new',
    _timer: null,
    _autoCloseOffline: false,
    _autoCloseTimer: null,
    _settings: JSON.parse(localStorage.getItem('rep_auto_settings') || '{}'),

    _getSettings() {
        // Читаем из localStorage каждый раз — чтобы подхватывать свежие настройки
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem('rep_auto_settings') || '{}'); } catch {}
        const raw = { minAge: 5, maxKd: 999, onlyOffline: false, skipBanned: false, result: 'Нарушение не подтверждено', ...stored };
        return {
            minAge:      parseFloat(raw.minAge)  || 0,
            maxKd:       parseFloat(raw.maxKd)   || 999,
            onlyOffline: raw.onlyOffline === true || raw.onlyOffline === 'true' || raw.onlyOffline === 1,
            skipBanned:  raw.skipBanned  === true || raw.skipBanned  === 'true' || raw.skipBanned  === 1,
            result:      raw.result || 'Нарушение не подтверждено',
        };
    },

    _saveSettings() {
        localStorage.setItem('rep_auto_settings', JSON.stringify(this._settings));
    },

    showSettings() {
        const modal = document.getElementById('reports-close-modal');
        const content = document.getElementById('reports-close-content');
        if (!modal || !content) return;
        const s = this._getSettings();
        content.innerHTML = `
            <div class="rep-settings-modal-inner">
                <div class="rep-settings-header">
                    <span class="rep-settings-icon">⚙️</span>
                    <span class="rep-settings-title">Настройки авто-закрытия</span>
                </div>
                <div class="rep-settings-body">
                    <div class="rep-settings-row">
                        <span class="rep-settings-label">Мин. возраст репорта (мин)<small class="rep-settings-hint">Закрывать если репорт висит дольше N минут (для всех)</small></span>
                        <input type="number" id="rs-min-age" value="${s.minAge}" min="0" max="1440" class="rep-settings-input">
                    </div>
                    <div class="rep-settings-row">
                        <span class="rep-settings-label">Макс. K/D нарушителя<small class="rep-settings-hint">Закрывать если KD &lt; этого значения (только онлайн игроки, 999 = все)</small></span>
                        <input type="number" id="rs-max-kd" value="${s.maxKd}" min="0" max="999" step="0.1" class="rep-settings-input">
                    </div>
                    <div class="rep-settings-row">
                        <span class="rep-settings-label">Закрывать офлайн игроков<small class="rep-settings-hint">☑ Если игрок вышел с сервера — закрыть репорт</small></span>
                        <label class="rep-toggle"><input type="checkbox" id="rs-only-offline" ${s.onlyOffline ? 'checked' : ''}><span class="rep-toggle-slider"></span></label>
                    </div>
                    <div class="rep-settings-row">
                        <span class="rep-settings-label">Забаненные игроки<small class="rep-settings-hint">☑ Банить — закрывать тикеты на забаненных<br>☐ Пропускать — не трогать тикеты на забаненных</small></span>
                        <label class="rep-toggle"><input type="checkbox" id="rs-ban-action" ${!s.skipBanned ? 'checked' : ''}><span class="rep-toggle-slider"></span></label>
                    </div>
                    <div class="rep-settings-row">
                        <span class="rep-settings-label">Причина закрытия</span>
                        <select id="rs-result" class="rep-settings-select">
                            ${['Нарушение не подтверждено','Недостаточно доказательств','Игрок был наказан','Требуется дополнительная проверка'].map(r =>
                                `<option value="${r}" ${s.result === r ? 'selected' : ''}>${r}</option>`
                            ).join('')}
                        </select>
                    </div>
                </div>
                <div class="rep-close-btns">
                    <button class="rep-btn-accept" onclick="ReportsManager._saveSettingsFromModal()">Сохранить</button>
                    <button class="rep-btn-cancel" onclick="ReportsManager.closeCloseModal()">Отмена</button>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
    },

    _saveSettingsFromModal() {
        this._settings.minAge      = parseFloat(document.getElementById('rs-min-age')?.value) || 0;
        this._settings.maxKd       = parseFloat(document.getElementById('rs-max-kd')?.value) || 999;
        this._settings.onlyOffline = document.getElementById('rs-only-offline')?.checked ?? false;
        this._settings.skipBanned  = !(document.getElementById('rs-ban-action')?.checked ?? true);
        this._settings.result      = document.getElementById('rs-result')?.value || 'Нарушение не подтверждено';
        this._saveSettings();
        this.closeCloseModal();
        const s = this._getSettings();
        UI.showToast(`✅ Сохранено: возраст=${s.minAge}мин KD<${s.maxKd} офлайн=${s.onlyOffline}`);
    },

    open() {
        this.refresh();
        const sid = AuthManager.user?.steamid || AuthManager.user?.steam_id || '';
        const isOwner = OWNERS.has(sid);
        const btn = document.getElementById('rep-close-offline-btn');
        if (btn) btn.style.display = isOwner ? '' : 'none';
        const autoBtn = document.getElementById('rep-auto-toggle-btn');
        if (autoBtn) {
            autoBtn.style.display = isOwner ? '' : 'none';
            this._updateAutoBtn();
        }
        const gearBtn = document.getElementById('rep-settings-btn');
        if (gearBtn) gearBtn.style.display = '';
        // Автообновление каждые 5 секунд
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => this._silentRefresh(), 10000); // каждые 10 сек
    },

    async _closeAllOpen(ids) {
        if (!ids?.length) return;
        const modal = document.getElementById('reports-close-modal');
        const content = document.getElementById('reports-close-content');
        if (!modal || !content) return;
        content.innerHTML = `
            <div class="rep-close-title">Закрыть все открытые (${ids.length})</div>
            ${['Нарушение не подтверждено','Недостаточно доказательств','Игрок был наказан','Требуется дополнительная проверка'].map(r => `
                <label class="rep-resolve-option" onclick="document.getElementById('rep-close-verdict').value='${r}'">
                    <input type="radio" name="rep-close-reason" value="${r}"> ${r}
                </label>
            `).join('')}
            <textarea id="rep-close-verdict" class="rep-verdict-input" placeholder="Вердикт (обязательно)..." required></textarea>
            <div class="rep-close-btns">
                <button class="rep-btn-accept" onclick="ReportsManager._doCloseFromModal(${JSON.stringify(ids).replace(/"/g,'&quot;')})">Закрыть все</button>
                <button class="rep-btn-cancel" onclick="ReportsManager.closeCloseModal()">Отмена</button>
            </div>
        `;
        modal.style.display = 'flex';
    },

    close() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        // Авто-закрытие продолжает работать в фоне
    },

    toggleAutoClose() {
        this._autoCloseOffline = !this._autoCloseOffline;
        this._updateAutoBtn();
        if (this._autoCloseOffline) {
            UI.showToast('✅ Авто-закрытие включено');
            // Запускаем СРАЗУ
            this._autoCloseOfflineTick();
            if (this._autoCloseTimer) clearInterval(this._autoCloseTimer);
            // Каждые 5 секунд
            this._autoCloseTimer = setInterval(() => this._autoCloseOfflineTick(), 5000);
        } else {
            UI.showToast('⏹ Авто-закрытие выключено');
            if (this._autoCloseTimer) { clearInterval(this._autoCloseTimer); this._autoCloseTimer = null; }
        }
    },

    _updateAutoBtn() {
        const btn = document.getElementById('rep-auto-toggle-btn');
        if (!btn) return;
        if (this._autoCloseOffline) {
            btn.textContent = '🟢 Авто: вкл';
            btn.style.background = 'rgba(0,230,118,.15)';
            btn.style.borderColor = 'rgba(0,230,118,.4)';
            btn.style.color = 'var(--green)';
        } else {
            btn.textContent = '⚙️ Авто: выкл';
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
        }
    },

    async _autoCloseOfflineTick() {
        const s = this._getSettings();
        console.log(`[auto-close] tick: minAge=${s.minAge} maxKd=${s.maxKd} closeOffline=${s.onlyOffline}`);
        const onlineSids = new Set(allPlayers.map(p => p.steam_id));
        const nowMs = Date.now();
        const toClose = [];

        // Группируем все репорты по intruder_steamid
        const groups = {};
        for (const r of this._reports) {
            if (!groups[r.intruder_steamid]) groups[r.intruder_steamid] = [];
            groups[r.intruder_steamid].push(r);
        }

        console.log(`[auto-close] групп: ${Object.keys(groups).length}, репортов: ${this._reports.length}`);

        for (const [sid, reps] of Object.entries(groups)) {
            // Проверяем бан
            const isBanned = BansManager._lastResult?.[sid]?.bans?.some(b => b.status === 1) || false;
            if (s.skipBanned && isBanned) { console.log(`[auto-close] skip ${sid} забанен`); continue; }

            const isOnline = onlineSids.has(sid);
            const onlinePlayer = allPlayers.find(p => p.steam_id === sid);

            for (const rep of reps) {
                const repAge = (nowMs - new Date(rep.created_at || 0).getTime()) / 60000;
                let shouldClose = false;
                let reason = '';

                // Условие 1: игрок офлайн и включено "Закрывать офлайн"
                if (s.onlyOffline && !isOnline) {
                    shouldClose = true;
                    reason = `офлайн`;
                }

                // Условие 2: игрок онлайн и KD < порога
                if (!shouldClose && isOnline && onlinePlayer && s.maxKd < 999) {
                    const kd = onlinePlayer.deaths > 0
                        ? onlinePlayer.kills / onlinePlayer.deaths
                        : (onlinePlayer.kills || 0);
                    if (kd < s.maxKd) {
                        shouldClose = true;
                        reason = `kd=${kd.toFixed(2)}<${s.maxKd}`;
                    }
                }

                // Условие 3: репорт висит дольше minAge минут (для всех)
                if (!shouldClose && s.minAge > 0 && repAge >= s.minAge) {
                    shouldClose = true;
                    reason = `age=${repAge.toFixed(1)}min>=${s.minAge}min`;
                }

                if (shouldClose) {
                    console.log(`[auto-close] ✅ #${rep.id} причина: ${reason}`);
                    toClose.push(rep.id);
                } else {
                    console.log(`[auto-close] skip #${rep.id} онлайн=${isOnline} age=${repAge.toFixed(1)}min`);
                }
            }
        }

        if (!toClose.length) { console.log('[auto-close] нечего закрывать'); return; }
        console.log(`[auto-close] закрываем ${toClose.length}: ${toClose.join(',')}`);

        const headers = { 'Content-Type': 'application/json' };
        if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
        try {
            const res = await fetch('/api/fear/reports/close-all', {
                method: 'POST', headers,
                body: JSON.stringify({ ticket_ids: toClose, result: s.result })
            });
            const data = await res.json();
            const ok = data.results?.filter(r => r.ok || r.status === 200 || r.status === 201 || r.status === 204).length || 0;
            if (ok > 0) {
                this._reports = this._reports.filter(r => !toClose.includes(r.id));
                this._render();
                UI.showToast(`✅ Авто: закрыто ${ok} тикетов`);
            } else {
                console.log('[auto-close] не закрылось:', JSON.stringify(data.results));
            }
        } catch (e) { console.log('[auto-close] error:', e.message); }
    },

    // Загружаем репорты: новые из /recent, открытые из history?status=open
    async _loadReports() {
        const headers = {};
        if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;

        const [resNew, resOpen] = await Promise.all([
            fetch('/api/fear/reports?status=recent', { headers }).catch(() => null),
            fetch('/api/fear/reports?status=open', { headers }).catch(() => null),
        ]);

        const rawNew  = resNew?.ok  ? await resNew.json().catch(() => null)  : null;
        const rawOpen = resOpen?.ok ? await resOpen.json().catch(() => null) : null;

        if (rawNew === null && rawOpen === null) return null;

        const newArr  = (Array.isArray(rawNew)  ? rawNew  : (rawNew?.reports  || [])).map(r => ({ ...r, _type: 'new' }));
        const openArr = (Array.isArray(rawOpen) ? rawOpen : (rawOpen?.reports || [])).map(r => ({ ...r, _type: 'open' }));

        return [...newArr, ...openArr];
    },

    _updateBadge(reports) {
        const badge = document.getElementById('reports-badge');
        if (!badge) return;
        const cnt = reports.filter(r => r._type === 'new').length;
        badge.textContent = cnt;
        badge.style.display = cnt > 0 ? '' : 'none';
    },

    async _silentRefresh() {
        try {
            const fresh = await this._loadReports();
            // Защита от пропадания: не обновляем если пришёл null или пустой массив при непустом кеше
            if (fresh === null) return;
            if (fresh.length === 0 && this._reports.length > 0) {
                console.log('[reports] silent refresh returned empty, keeping cache');
                return;
            }
            const prev = JSON.stringify(this._reports.map(r => r.id).sort());
            this._reports = fresh;
            this._updateBadge(this._reports);
            const curr = JSON.stringify(this._reports.map(r => r.id).sort());
            if (curr !== prev) this._render();
        } catch {}
    },

    async refresh() {
        const prog = document.getElementById('reports-progress');
        const fill = document.getElementById('reports-progress-fill');
        const text = document.getElementById('reports-progress-text');
        if (prog) prog.style.display = 'flex';
        if (fill) fill.style.width = '20%';
        if (text) text.textContent = 'Загружаем репорты...';

        try {
            const fresh = await this._loadReports();
            if (fresh !== null) {
                this._reports = fresh;
                this._updateBadge(this._reports);
            }
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = `Загружено ${this._reports.length} репортов`;
            setTimeout(() => { if (prog) prog.style.display = 'none'; }, 1000);
        } catch (e) {
            if (text) text.textContent = '❌ ' + e.message;
        }

        this._render();
    },

    switchTab(tab, btn) {
        this._tab = tab;
        document.querySelectorAll('.rep-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._render();
    },

    _getFiltered() {
        const reports = this._reports.filter(r => r._type === this._tab);
        // Группируем по intruder_steamid
        const groups = {};
        for (const r of reports) {
            const sid = r.intruder_steamid;
            if (!groups[sid]) groups[sid] = [];
            groups[sid].push(r);
        }
        return groups;
    },

    _render() {
        const listEl = document.getElementById('reports-list');
        if (!listEl) return;

        const groups = this._getFiltered();
        const entries = Object.entries(groups);

        if (!entries.length) {
            listEl.innerHTML = `<div class="empty"><span class="empty-emoji">✅</span><p>Репортов нет</p></div>`;
            return;
        }

        listEl.innerHTML = '';

        // Кнопка "Закрыть все открытые"
        if (this._tab === 'open' && entries.length > 0) {
            const allOpenIds = entries.flatMap(([, reps]) => reps.map(r => r.id));
            const closeAllBtn = document.createElement('button');
            closeAllBtn.className = 'rep-btn-close-all-open';
            closeAllBtn.textContent = `🔴 Закрыть все открытые (${allOpenIds.length})`;
            closeAllBtn.onclick = () => ReportsManager._closeAllOpen(allOpenIds);
            listEl.appendChild(closeAllBtn);
        }

        // Сортируем по количеству репортов (больше = выше)
        entries.sort((a, b) => b[1].length - a[1].length);

        // Заголовок таблицы
        const header = document.createElement('div');
        header.className = 'rep-table-header';
        header.innerHTML = `
            <span>ДАТА</span>
            <span>НАРУШИТЕЛЬ</span>
            <span>K/D</span>
            <span>ПРИЧИНА</span>
            <span>СЕРВЕР</span>
            <span>ДЕЙСТВИЕ</span>
        `;
        listEl.appendChild(header);

        for (const [sid, reps] of entries) {
            const first = reps[0];
            const count = reps.length;
            const date = new Date(first.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });

            // Ищем игрока онлайн
            const onlinePlayer = allPlayers.find(p => p.steam_id === sid);
            const kd = onlinePlayer ? UI.calculateKD(onlinePlayer.kills, onlinePlayer.deaths) : 'Офлайн';
            const kdClass = onlinePlayer ? 'rep-kd-online' : 'rep-kd-offline';

            const row = document.createElement('div');
            const repColorClass = count >= 5 ? 'rep-row-red' : count >= 3 ? 'rep-row-yellow' : 'rep-row-green';
            // Проверяем бан на Fear
            const isBanned = BansManager._lastResult?.[sid]?.bans?.some(b => b.status === 1) || false;
            const bannedBadge = isBanned ? `<span class="rep-banned-badge">🔨 ЗАБАНЕН</span>` : '';
            row.className = `rep-table-row ${repColorClass} ${isBanned ? 'has-banned' : ''}`;
            row.innerHTML = `
                <div class="rep-date">
                    <div>${date}</div>
                    <div class="rep-count">${count} ${count === 1 ? 'РЕПОРТ' : 'РЕПОРТА'}</div>
                </div>
                <div class="rep-player">
                    <img src="${escapeHtml(first.intruder_avatar || '')}" class="rep-avatar" loading="lazy"
                         onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                    <div>
                        <div class="rep-name">${escapeHtml(first.intruder)} ${bannedBadge}</div>
                        <div class="rep-steamid" onclick="App.copyToClipboard('${escapeHtml(sid)}')">${escapeHtml(sid)}</div>
                    </div>
                </div>
                <div class="rep-kd ${kdClass}">${kd}</div>
                <div class="rep-reason">${escapeHtml(first.reason || '—')}</div>
                <div class="rep-server">
                    <div>${escapeHtml(first.server_name || '—')}</div>
                    ${onlinePlayer ? `<button class="btn-connect-small" onclick="App.connectToServer('${escapeHtml(first.server_ip)}:${first.server_port}')">🎯 Connect</button>` : ''}
                </div>
                <div class="rep-actions">
                    <button class="rep-btn-accept" onclick="ReportsManager.showCloseModal(${JSON.stringify(reps).replace(/"/g, '&quot;')})">Принять все</button>
                    <button class="rep-btn-detail" onclick="ReportsManager.showDetail(${JSON.stringify(reps).replace(/"/g, '&quot;')})">Подробнее</button>
                </div>
            `;
            listEl.appendChild(row);
        }
    },

    showDetail(reps) {
        const modal = document.getElementById('reports-modal');
        const left = document.getElementById('reports-modal-left');
        const right = document.getElementById('reports-modal-right');
        if (!modal) return;

        const first = reps[0];
        const name = escapeHtml(first.intruder);

        // Левая панель — список тикетов
        left.innerHTML = `
            <div class="rep-modal-title">Репорты (${reps.length})<br><small>${name}</small></div>
            ${reps.map((r, i) => `
                <div class="rep-modal-ticket ${i === 0 ? 'active' : ''}" onclick="ReportsManager._selectTicket(${r.id}, this)">
                    <div class="rep-modal-ticket-id">Тикет #${r.id}</div>
                    <div class="rep-modal-ticket-info">Отправитель: ${escapeHtml(r.sender)}</div>
                    <div class="rep-modal-ticket-info">${escapeHtml(r.server_name)}</div>
                </div>
            `).join('')}
        `;

        // Правая панель — первый тикет
        this._renderTicketDetail(right, reps[0], reps);

        modal.style.display = 'flex';
        this._currentReps = reps;
        this._pendingClose = {}; // { ids: [], result: '' }
    },

    _selectTicket(id, el) {
        document.querySelectorAll('.rep-modal-ticket').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        const rep = this._currentReps.find(r => r.id === id);
        if (rep) this._renderTicketDetail(document.getElementById('reports-modal-right'), rep, this._currentReps);
    },

    _renderTicketDetail(container, rep, allReps) {
        const addr = `${rep.server_ip}:${rep.server_port}`;
        const date = new Date(rep.created_at).toLocaleString('ru-RU');
        container.innerHTML = `
            <div class="rep-detail-header">
                <div class="rep-detail-title">Тикет #${rep.id}</div>
                <button class="rep-modal-close" onclick="ReportsManager.closeModal()">✕</button>
            </div>
            <div class="rep-detail-parties">
                <div class="rep-detail-party">
                    <div class="rep-detail-party-label">ОТПРАВИТЕЛЬ</div>
                    <img src="${escapeHtml(rep.sender_avatar || '')}" class="rep-detail-avatar">
                    <div class="rep-detail-party-name">${escapeHtml(rep.sender)}</div>
                    <div class="rep-detail-party-sid">${escapeHtml(rep.sender_steamid)}</div>
                    <div class="rep-detail-party-btns">
                        <button class="btn-fear-small" onclick="App.openFearProfile('${escapeHtml(rep.sender_steamid)}')">Fear</button>
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${escapeHtml(rep.sender_steamid)}')">Steam</button>
                    </div>
                </div>
                <div class="rep-detail-party">
                    <div class="rep-detail-party-label">НАРУШИТЕЛЬ</div>
                    <img src="${escapeHtml(rep.intruder_avatar || '')}" class="rep-detail-avatar">
                    <div class="rep-detail-party-name">${escapeHtml(rep.intruder)}</div>
                    <div class="rep-detail-party-sid">${escapeHtml(rep.intruder_steamid)}</div>
                    <div class="rep-detail-party-btns">
                        <button class="btn-fear-small" onclick="App.openFearProfile('${escapeHtml(rep.intruder_steamid)}')">Fear</button>
                        <button class="btn-steam-small" onclick="App.openSteamProfile('${escapeHtml(rep.intruder_steamid)}')">Steam</button>
                    </div>
                </div>
            </div>
            <div class="rep-detail-server">
                <div>🖥 ${escapeHtml(rep.server_name)} · ${escapeHtml(addr)}</div>
                <button class="btn-connect-small" onclick="App.connectToServer('${escapeHtml(addr)}')">🎯 Connect</button>
                <button class="btn-copy-small" onclick="App.copyToClipboard('connect ${escapeHtml(addr)}')">📋</button>
            </div>
            <div class="rep-detail-meta">📅 ${date} · 📋 ${escapeHtml(rep.reason)}</div>
            <div class="rep-detail-resolve">
                <div class="rep-detail-resolve-title">Выберите решение</div>
                ${['Игрок был наказан', 'Нарушение не подтверждено', 'Недостаточно доказательств', 'Требуется дополнительная проверка'].map(r => `
                    <label class="rep-resolve-option" onclick="document.getElementById('rep-verdict-${rep.id}').value='${r}'">
                        <input type="radio" name="rep-resolve-${rep.id}" value="${r}"> ${r}
                    </label>
                `).join('')}
                <textarea id="rep-verdict-${rep.id}" class="rep-verdict-input" placeholder="Вердикт..."></textarea>
                <div class="rep-detail-btns">
                    <button class="rep-btn-save" onclick="ReportsManager._saveCurrent(${rep.id})">Сохранить для текущего</button>
                    <button class="rep-btn-save-all" onclick="ReportsManager._saveAll(${JSON.stringify(allReps.map(r=>r.id)).replace(/"/g,'&quot;')}, ${rep.id})">Применить ко всем</button>
                </div>
                <div id="rep-pending-info-${rep.id}" class="rep-pending-info" style="display:none"></div>
            </div>
            <div class="rep-detail-footer">
                <button class="rep-btn-accept" onclick="ReportsManager._applyPending()">Применить</button>
                <button class="rep-btn-cancel" onclick="ReportsManager.closeModal()">Отмена</button>
            </div>
        `;
    },

    // Сохранить решение для текущего тикета (без отправки)
    _saveCurrent(ticketId) {
        const radio = document.querySelector(`input[name="rep-resolve-${ticketId}"]:checked`)?.value;
        const text = document.getElementById(`rep-verdict-${ticketId}`)?.value?.trim();
        const result = text || radio;
        if (!result) { UI.showToast('❌ Выбери решение или введи вердикт', 'error'); return; }
        this._pendingClose = { ids: [ticketId], result };
        const info = document.getElementById(`rep-pending-info-${ticketId}`);
        if (info) { info.style.display = 'block'; info.textContent = `✅ Сохранено: "${result}"`; }
        UI.showToast('Сохранено для текущего');
    },

    // Сохранить решение для всех тикетов (без отправки)
    _saveAll(allIds, currentId) {
        const radio = document.querySelector(`input[name="rep-resolve-${currentId}"]:checked`)?.value;
        const text = document.getElementById(`rep-verdict-${currentId}`)?.value?.trim();
        const result = text || radio;
        if (!result) { UI.showToast('❌ Выбери решение или введи вердикт', 'error'); return; }
        this._pendingClose = { ids: allIds, result };
        const info = document.getElementById(`rep-pending-info-${currentId}`);
        if (info) { info.style.display = 'block'; info.textContent = `✅ Применится ко всем (${allIds.length}): "${result}"`; }
        UI.showToast(`Сохранено для ${allIds.length} тикетов`);
    },

    // Применить — реально закрыть
    async _applyPending() {
        if (!this._pendingClose?.ids?.length) {
            UI.showToast('❌ Сначала выбери решение', 'error'); return;
        }
        await this._doClose(this._pendingClose.ids, this._pendingClose.result);
        this._pendingClose = {};
    },

    showCloseModal(reps) {
        const modal = document.getElementById('reports-close-modal');
        const content = document.getElementById('reports-close-content');
        if (!modal) return;

        const ids = reps.map(r => r.id);
        const name = escapeHtml(reps[0].intruder);

        content.innerHTML = `
            <div class="rep-close-title">Закрыть репорты на ${name}</div>
            <div class="rep-close-subtitle">${reps.length} репорт(а)</div>
            ${['Игрок был наказан', 'Нарушение не подтверждено', 'Недостаточно доказательств', 'Требуется дополнительная проверка'].map(r => `
                <label class="rep-resolve-option" onclick="document.getElementById('rep-close-verdict').value='${r}'">
                    <input type="radio" name="rep-close-reason" value="${r}"> ${r}
                </label>
            `).join('')}
            <textarea id="rep-close-verdict" class="rep-verdict-input" placeholder="Вердикт (обязательно)..." required></textarea>
            <div class="rep-close-btns">
                <button class="rep-btn-accept" onclick="ReportsManager._doCloseFromModal(${JSON.stringify(ids).replace(/"/g,'&quot;')})">Закрыть все</button>
                <button class="rep-btn-cancel" onclick="ReportsManager.closeCloseModal()">Отмена</button>
            </div>
        `;
        modal.style.display = 'flex';
    },

    async _doCloseFromModal(ids) {
        const text = document.getElementById('rep-close-verdict')?.value?.trim();
        if (!text) { UI.showToast('❌ Введи вердикт', 'error'); return; }
        this.closeCloseModal();
        await this._doClose(ids, text);
    },

    async _doClose(ids, result) {
        const headers = { 'Content-Type': 'application/json' };
        if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await fetch('/api/fear/reports/close-all', {
                    method: 'POST', headers,
                    body: JSON.stringify({ ticket_ids: ids, result })
                });
                if (!res.ok) {
                    if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
                    UI.showToast(`❌ Ошибка сервера: ${res.status}`, 'error'); return;
                }
                const data = await res.json();
                console.log('[reports] close-all response:', JSON.stringify(data));
                const ok = data.results?.filter(r => r.ok || r.status === 200 || r.status === 201 || r.status === 204).length || 0;
                if (ok > 0) {
                    UI.showToast(`✅ Закрыто ${ok}/${ids.length} репортов`);
                    this._reports = this._reports.filter(r => !ids.includes(r.id));
                    this.closeModal();
                    this.closeCloseModal();
                    this._render();
                    setTimeout(() => this._silentRefresh(), 2000);
                    return;
                }
                const statuses = data.results?.map(r => `${r.id}:${r.status}`).join(', ') || 'нет данных';
                if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
                UI.showToast(`❌ Не удалось закрыть (${statuses})`, 'error');
                return;
            } catch (e) {
                if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
                UI.showToast('❌ Ошибка: ' + e.message, 'error');
            }
        }
    },

    // Закрыть все репорты офлайн игроков (только для владельца)
    closeOfflineConfirm() {
        // Находим офлайн игроков — тех кого нет в allPlayers
        const onlineSids = new Set(allPlayers.map(p => p.steam_id));
        const groups = this._getFiltered();
        const offlineGroups = Object.entries(groups).filter(([sid]) => !onlineSids.has(sid));

        if (!offlineGroups.length) { UI.showToast('Нет офлайн игроков с репортами'); return; }

        const allIds = offlineGroups.flatMap(([, reps]) => reps.map(r => r.id));
        const names = offlineGroups.map(([, reps]) => reps[0].intruder).slice(0, 5).join(', ');

        const modal = document.getElementById('reports-close-modal');
        const content = document.getElementById('reports-close-content');
        if (!modal) return;

        content.innerHTML = `
            <div class="rep-close-title">🔴 Закрыть репорты офлайн игроков</div>
            <div class="rep-close-subtitle">${offlineGroups.length} игроков · ${allIds.length} репортов<br><small style="color:var(--t3)">${names}${offlineGroups.length > 5 ? '...' : ''}</small></div>
            ${['Нарушение не подтверждено', 'Недостаточно доказательств', 'Игрок был наказан', 'Требуется дополнительная проверка'].map(r => `
                <label class="rep-resolve-option" onclick="document.getElementById('rep-close-verdict').value='${r}'">
                    <input type="radio" name="rep-close-reason" value="${r}"> ${r}
                </label>
            `).join('')}
            <textarea id="rep-close-verdict" class="rep-verdict-input" placeholder="Вердикт (обязательно)..." required></textarea>
            <div class="rep-close-btns">
                <button class="rep-btn-accept" onclick="ReportsManager._doCloseFromModal(${JSON.stringify(allIds).replace(/"/g,'&quot;')})">Закрыть все (${allIds.length})</button>
                <button class="rep-btn-cancel" onclick="ReportsManager.closeCloseModal()">Отмена</button>
            </div>
        `;
        modal.style.display = 'flex';
    },

    closeModal() {
        const m = document.getElementById('reports-modal');
        if (m) m.style.display = 'none';
    },

    closeCloseModal() {
        const m = document.getElementById('reports-close-modal');
        if (m) m.style.display = 'none';
    },
};

// ── PLAYER CHECK MANAGER ─────────────────────────────────
const PlayerCheckManager = {
    open() {
        const input = document.getElementById('player-check-input');
        if (input) input.focus();
        // Инициализируем toggle CS:GO
        const toggle = document.getElementById('toggle-csgo-players');
        if (toggle) {
            const track = toggle.querySelector('.toggler-track');
            if (track) track.classList.toggle('active', App._showCsgoPlayers);
        }
    },

    async check() {
        const input = document.getElementById('player-check-input');
        const result = document.getElementById('player-check-result');
        const steamid = input?.value?.trim();
        if (!steamid) return;
        result.innerHTML = `<div style="text-align:center;padding:30px;color:var(--t3)">⏳ Загружаем данные...</div>`;
        try {
            const headers = {};
            if (AuthManager.token) headers['x-auth-token'] = AuthManager.token;
            const res = await fetch(`/api/fear/player-check/${encodeURIComponent(steamid)}`, { headers, signal: AbortSignal.timeout(15000) });
            if (!res.ok) { result.innerHTML = `<div style="color:#ff5050;padding:20px">❌ Ошибка ${res.status}</div>`; return; }
            const d = await res.json();
            this._render(result, d);
        } catch (e) { result.innerHTML = `<div style="color:#ff5050;padding:20px">❌ ${e.message}</div>`; }
    },

    _render(container, d) {
        const kd = d.kd || (d.kills != null && d.deaths != null ? (d.kills / Math.max(d.deaths, 1)).toFixed(2) : '—');
        const hs = d.hs != null ? `${d.hs}%` : '—';
        const playtime = d.playtime ? `${Math.round(d.playtime / 60)}ч` : '—';
        const lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleDateString('ru-RU') : (d.last_logoff ? new Date(d.last_logoff).toLocaleDateString('ru-RU') : '—');
        const reg = d.timecreated ? new Date(d.timecreated).toLocaleDateString('ru-RU') : '—';
        const name = d.fear_name || d.steam_name || d.steamid;
        const avatar = d.fear_avatar || d.steam_avatar || '';
        const group = d.fear_group ? `<span style="background:rgba(168,85,247,.2);color:var(--purple);padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px">${escapeHtml(d.fear_group)}</span>` : '';
        const online = d.steam_status > 0 ? `<span style="color:var(--green)">● В сети${d.steam_game ? ' · ' + escapeHtml(d.steam_game) : ''}</span>` : `<span style="color:var(--t3)">● Офлайн</span>`;
        const vacBanned = d.vac?.VACBanned ? `<span style="color:#ff5050;font-weight:700;margin-left:8px">⚠ VAC БАН (${d.vac.NumberOfVACBans})</span>` : '';
        const profilePublic = d.profile_state === 3;

        const stats = [
            ['K/D', kd, d.kills != null ? `(${d.kills}/${d.deaths})` : ''],
            ['HS%', hs, ''],
            ['Наиграно', playtime, ''],
            ['Последний вход', lastSeen, ''],
            ['Регистрация', reg, ''],
            ['Steam Lvl', d.steam_level ?? '—', ''],
            ['Друзья', d.friends_count ?? '—', ''],
            ['Профиль', profilePublic ? '<span style="color:var(--green)">Публичный</span>' : '<span style="color:#ff5050">Закрытый</span>', ''],
        ];

        container.innerHTML = `
            <div style="display:flex;gap:14px;align-items:center;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:16px">
                ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:56px;height:56px;border-radius:50%;flex-shrink:0">` : `<div style="width:56px;height:56px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:24px">👤</div>`}
                <div style="flex:1;min-width:0">
                    <div style="font-size:17px;font-weight:700">${escapeHtml(name)}${group}</div>
                    <div style="font-size:12px;color:var(--t3);margin:3px 0;cursor:pointer" onclick="App.copyToClipboard('${escapeHtml(d.steamid)}')">${escapeHtml(d.steamid)} 📋</div>
                    <div style="font-size:12px">${online}${vacBanned}</div>
                </div>
                <div style="display:flex;gap:8px;flex-shrink:0">
                    <button onclick="App.openSteamProfile('${escapeHtml(d.steamid)}')" style="padding:7px 14px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);cursor:pointer;font-size:12px">Steam</button>
                    <button onclick="App.openFearProfile('${escapeHtml(d.steamid)}')" style="padding:7px 14px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);border-radius:8px;color:var(--purple);cursor:pointer;font-size:12px">Fear</button>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                ${stats.map(([label, val, sub]) => `
                    <div style="padding:12px;background:var(--card);border:1px solid var(--border);border-radius:10px;text-align:center">
                        <div style="font-size:11px;color:var(--t3);margin-bottom:5px">${label}</div>
                        <div style="font-size:16px;font-weight:700">${val}</div>
                        ${sub ? `<div style="font-size:10px;color:var(--t3);margin-top:2px">${sub}</div>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    },
};

// ── SPLASH ───────────────────────────────────
const Splash = {
    _el:    () => document.getElementById('splash-screen'),
    _bar:   () => document.getElementById('splash-bar'),
    _status:() => document.getElementById('splash-status'),

    setStatus(text, pct) {
        const s = this._status(); if (s) s.textContent = text;
        const b = this._bar();   if (b && pct !== undefined) b.style.width = pct + '%';
    },

    hide() {
        const el = this._el();
        if (el) {
            el.classList.add('hidden');
            setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
        }
    },
};

// ── SERVERS MANAGER ──────────────────────────
const ServersManager = {
    _open: false,
    _activeMode: 'public',

    open() {
        this._open = true;
        this._render();
    },

    setMode(mode, btn) {
        this._activeMode = mode;
        document.querySelectorAll('.srv-mode-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        this._render();
    },

    toggleCsgo(btn) {
        CsgoManager.showInServers = !CsgoManager.showInServers;
        try { localStorage.setItem('fearsearch_csgo_show', CsgoManager.showInServers ? '1' : '0'); } catch {}
        btn.classList.toggle('active', CsgoManager.showInServers);
        this._render();
    },

    tick(servers) {
        const online = (servers || []).reduce((s, srv) => s + (srv.live_data?.players?.length || 0), 0);
        const badge = document.getElementById('servers-online-badge');
        if (badge) badge.textContent = online;
        if (this._open) this._render();
    },

    _getMode(srv) {
        const name = (srv.site_name || srv.name || '').toLowerCase();
        if (name.includes('awp') || name.includes('lego')) return 'awp';
        if (name.includes('minion') || name.includes('mini-game')) return 'minions';
        if (name.includes('old ') || name.includes('cs 1.6') || name.includes('cs1.6')) return 'cs16';
        if (name.includes('fps')) return 'fps';
        return 'public';
    },

    _getMapGroup(srv) {
        const map = (srv.live_data?.map_name || srv.map || '').toLowerCase();
        const name = (srv.site_name || srv.name || '').toLowerCase();
        // Lake и Cache → OTHER
        if (map.includes('lake') || map.includes('cache') || name.includes('lake') || name.includes('cache')) return 'OTHER';
        if (name.includes('random')) return 'RANDOM GAME';
        if (name.includes('sandstone')) return 'SANDSTONE';
        if (name.includes('dust2') || name.includes('dust 2') || map.includes('dust2')) return 'DUST2';
        if (name.includes('mirage') || map.includes('mirage') || map.includes('nirage')) return 'MIRAGE';
        if (name.includes('awp') || name.includes('lego')) return 'AWP LEGO';
        if (name.includes('minion')) return 'MINI-GAMES AND OTHER';
        if (name.includes('old ') || name.includes('cs 1.6') || map.includes('cs16')) return 'CS 1.6';
        if (name.includes('fps')) return 'FPS+';
        return 'OTHER';
    },

    _render() {
        const layout = document.getElementById('servers-layout');
        if (!layout) return;
        if (!serversData || !serversData.length) {
            layout.innerHTML = `<div class="empty"><span class="empty-emoji">🖥️</span><p>Нет данных о серверах</p></div>`;
            return;
        }

        const filtered = this._activeMode === 'all' ? serversData : serversData.filter(srv => this._getMode(srv) === this._activeMode);
        const groups = {};
        for (const srv of filtered) {
            const key = this._getMapGroup(srv);
            if (!groups[key]) groups[key] = [];
            groups[key].push(srv);
        }

        const ORDER = ['RANDOM GAME','MIRAGE','DUST2','SANDSTONE','CS 1.6','FPS+','AWP LEGO','MINI-GAMES AND OTHER','OTHER'];
        const sortedGroups = Object.entries(groups).sort((a,b) => {
            const ia = ORDER.indexOf(a[0]), ib = ORDER.indexOf(b[0]);
            if (ia === -1 && ib === -1) return a[0].localeCompare(b[0]);
            if (ia === -1) return 1; if (ib === -1) return -1;
            return ia - ib;
        });

        const modes = [
            { id: 'all', label: 'Все режимы' },
            { id: 'public', label: 'Public' },
            { id: 'awp', label: 'AWP' },
            { id: 'cs16', label: 'CS:GO' },
            { id: 'minions', label: 'Minions' },
        ];

        const csgoEnabled = CsgoManager.showInServers !== false;
        layout.innerHTML = `<div class="srv-modes">${modes.map(m =>
            `<button class="srv-mode-btn ${this._activeMode === m.id ? 'active' : ''}" onclick="ServersManager.setMode('${m.id}', this)">${m.label}</button>`
        ).join('')}<button class="srv-mode-btn ${csgoEnabled ? 'active' : ''}" style="margin-left:auto" onclick="ServersManager.toggleCsgo(this)">🎮 CS:GO серверы</button></div>`;

        for (const [groupName, servers] of sortedGroups) {
            const totalOnline = servers.reduce((s, srv) => s + (srv.live_data?.players?.length || 0), 0);
            const section = document.createElement('div');
            section.className = 'srv-section';
            section.innerHTML = `
                <div class="srv-section-title">${escapeHtml(groupName)}<span class="srv-section-count ${totalOnline > 0 ? 'online' : ''}">${totalOnline} ●</span></div>
                <div class="srv-grid"></div>
            `;
            layout.appendChild(section);
            const grid = section.querySelector('.srv-grid');
            for (const srv of servers) {
                const players = srv.live_data?.players || [];
                const maxPlayers = srv.live_data?.max_players || srv.max_players || 0;
                const map = srv.live_data?.map_name || srv.map || '';
                const ping = srv.live_data?.ping || srv.ping || 0;
                const addr = `${srv.ip}:${srv.port}`;
                const name = srv.site_name || srv.name || addr;
                const card = document.createElement('div');
                card.className = `srv-card ${players.length > 0 ? 'has-players' : ''}`;
                card.style.backgroundImage = `url(https://fearproject.ru/img/maps/${map}.jpg)`;
                card.onclick = () => ServersManager.showModal(srv);
                card.innerHTML = `
                    <div class="srv-card-overlay"></div>
                    <div class="srv-card-content">
                        <div class="srv-card-name">${escapeHtml(name)}</div>
                        <div class="srv-card-meta">
                            <span class="srv-players ${players.length > 0 ? 'online' : ''}">${players.length} / ${maxPlayers}</span>
                            <span class="srv-map">${escapeHtml(map)}</span>
                            <span class="srv-ping">${ping} мс</span>
                        </div>
                    </div>
                    <div class="srv-card-actions">
                        <button class="srv-btn-play" onclick="event.stopPropagation();App.connectToServer('${escapeHtml(addr)}')">▶</button>
                        <button class="srv-btn-copy" onclick="event.stopPropagation();App.copyToClipboard('connect ${escapeHtml(addr)}')">📋</button>
                    </div>
                `;
                grid.appendChild(card);
            }
        }

        // CSGO серверы (если включено)
        if (CsgoManager.showInServers && CsgoManager.data.length > 0) {
            const csgoSection = document.createElement('div');
            csgoSection.className = 'srv-section';
            const csgoOnline = CsgoManager.data.filter(s => CsgoManager.enabled[s.id]).reduce((s, srv) => s + (srv.playerCount || 0), 0);
            csgoSection.innerHTML = `<div class="srv-section-title">🎮 CS:GO<span class="srv-section-count ${csgoOnline > 0 ? 'online' : ''}">${csgoOnline} ●</span></div><div class="srv-grid"></div>`;
            layout.appendChild(csgoSection);
            const csgoGrid = csgoSection.querySelector('.srv-grid');
            for (const srv of CsgoManager.data.filter(s => CsgoManager.enabled[s.id])) {
                const card = document.createElement('div');
                card.className = 'srv-card';
                card.innerHTML = `
                    <div class="srv-card-header">
                        <div class="srv-card-name">${escapeHtml(srv.serverName || srv.name)}</div>
                        <span class="game-tag csgo">CS:GO</span>
                    </div>
                    <div class="srv-card-meta">
                        <span class="srv-players ${(srv.playerCount||0) > 0 ? 'online' : ''}">${srv.playerCount||0} / ${srv.maxPlayers||0}</span>
                        <span class="srv-map">${escapeHtml(srv.map||'')}</span>
                    </div>
                    <div class="srv-card-actions">
                        <button class="srv-btn-play" onclick="App.connectToServer('${escapeHtml(srv.ip+':'+srv.port)}')">▶</button>
                        <button class="srv-btn-copy" onclick="App.copyToClipboard('connect ${escapeHtml(srv.ip+':'+srv.port)}')">📋</button>
                    </div>
                `;
                csgoGrid.appendChild(card);
            }
        }
    },

    showModal(srv) {
        const modal = document.getElementById('server-modal');
        const content = document.getElementById('server-modal-content');
        if (!modal || !content) return;

        const players = srv.live_data?.players || [];
        const map = srv.live_data?.map_name || srv.map || '';
        const addr = `${srv.ip}:${srv.port}`;
        const name = srv.site_name || srv.name || addr;
        const ping = srv.live_data?.ping || srv.ping || srv.live_data?.server_ping || 0;
        const maxPlayers = srv.live_data?.max_players || srv.max_players || 0;
        const scoreT = srv.live_data?.score_t ?? srv.live_data?.score?.t ?? null;
        const scoreCT = srv.live_data?.score_ct ?? srv.live_data?.score?.ct ?? null;
        const scoreHtml = (scoreT !== null && scoreCT !== null)
            ? `<div class="srv-modal-score">${scoreT} : ${scoreCT}</div>`
            : '';

        const tPlayers = players.filter(p => p.team === 't');
        const ctPlayers = players.filter(p => p.team === 'ct');
        const specPlayers = players.filter(p => p.team !== 't' && p.team !== 'ct');

        const renderPlayer = (p) => {
            const isAdmin = StaffManager.adminMap[p.steam_id] || PaidManager.admins?.find(a => a.steamid === p.steam_id);
            const customNick = getCustomNick(p.steam_id);
            const displayName = customNick || p.nickname;
            const adminBadge = isAdmin ? `<span class="srv-admin-badge">Админ</span>` : '';
            return `
                <div class="srv-player-row" onclick="App.openFearProfile('${escapeHtml(p.steam_id)}')">
                    <img src="${escapeHtml(p.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg')}"
                         class="srv-player-avatar" loading="lazy"
                         onerror="this.src='https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'">
                    <span class="srv-player-name">${escapeHtml(displayName)} ${adminBadge}</span>
                    <span class="srv-player-kd">✂ ${p.kills} ☠ ${p.deaths}</span>
                </div>
            `;
        };

        content.innerHTML = `
            <div class="srv-modal-bg" style="background-image:url(https://fearproject.ru/img/maps/${map}.jpg)"></div>
            <button class="srv-modal-close" onclick="ServersManager.closeModal()">✕</button>
            <div class="srv-modal-header">
                <div class="srv-modal-name">${escapeHtml(name)}</div>
                ${scoreHtml}
                <div class="srv-modal-meta">${players.length} / ${maxPlayers} · Public · ${ping > 0 ? ping + ' мс' : '—'}</div>
            </div>
            <div class="srv-modal-teams">
                <div class="srv-team">
                    <div class="srv-team-title">
                        <span class="srv-team-icon t">🔴</span> Террористы
                        <span class="srv-team-count">${tPlayers.length}/5</span>
                    </div>
                    ${tPlayers.map(renderPlayer).join('') || '<div class="srv-slot-empty">Слот пустой</div>'}
                </div>
                <div class="srv-team">
                    <div class="srv-team-title">
                        <span class="srv-team-icon ct">🔵</span> Спецназ
                        <span class="srv-team-count">${ctPlayers.length}/5</span>
                    </div>
                    ${ctPlayers.map(renderPlayer).join('') || '<div class="srv-slot-empty">Слот пустой</div>'}
                </div>
            </div>
            ${specPlayers.length ? `
                <div class="srv-spec-section">
                    <div class="srv-spec-title">👁 Наблюдатели</div>
                    ${specPlayers.map(renderPlayer).join('')}
                </div>
            ` : ''}
            <button class="srv-modal-connect" onclick="App.connectToServer('${escapeHtml(addr)}')">▶ Подключиться к серверу</button>
            <div class="srv-modal-addr" onclick="App.copyToClipboard('${escapeHtml(addr)}')">${escapeHtml(addr)} 📋</div>
        `;

        modal.style.display = 'flex';
    },

    closeModal() {
        const m = document.getElementById('server-modal');
        if (m) m.style.display = 'none';
    },
};

document.addEventListener('DOMContentLoaded', async () => {
    ParticlesSystem.init();
    SettingsPanel.restore();
    Sidebar.restore();
    EasterEgg.init();
    CheckerManager.init();
    App.setupEventListeners();
    App.setupTabs();

    // Версия
    if (window.electronAPI?.getVersion) {
        window.electronAPI.getVersion().then(v => {
            const el = document.getElementById('app-version');
            if (el) el.textContent = `v${v}`;
        }).catch(() => {});
    }

    // ── Подписываемся на обновления ──
    if (window.electronAPI?.onUpdateStatus) {
        window.electronAPI.onUpdateStatus((data) => {
            if (data.type === 'available') {
                // Показываем экран обновления поверх сплэша
                const s = document.getElementById('update-screen');
                const v = document.getElementById('update-version-text');
                const d = document.getElementById('update-desc');
                if (s) s.style.display = 'flex';
                if (v) v.textContent = `Версия ${data.version}`;
                if (d) d.textContent = '⬇️ Скачиваем обновление...';
                // Обновляем статус сплэша
                Splash.setStatus(`Доступно обновление ${data.version}...`, 30);
            } else if (data.type === 'not-available') {
                Splash.setStatus('Обновлений нет', 40);
            } else if (data.type === 'downloaded') {
                const btn = document.getElementById('update-btn');
                const pt  = document.getElementById('update-progress-text');
                const pf  = document.getElementById('update-progress-fill');
                if (pf) pf.style.width = '100%';
                if (pt) pt.textContent = '✅ Скачано! Устанавливаем...';
                if (btn) btn.style.display = 'block';
                setTimeout(() => window.electronAPI.installUpdate(), 3000);
            }
        });

        window.electronAPI.onDownloadProgress?.((data) => {
            const pf = document.getElementById('update-progress-fill');
            const pt = document.getElementById('update-progress-text');
            if (pf) pf.style.width = data.pct + '%';
            if (pt) pt.textContent = `⬇️ ${data.mbDone} МБ / ${data.mbTotal} МБ · ${data.kbps} КБ/с · ${data.pct}%`;
        });
    }

    // ── Splash: проверка обновлений → авторизация → загрузка всего → скрыть ──
    // Подставляем версию
    if (window.electronAPI?.getVersion) {
        window.electronAPI.getVersion().then(v => {
            const el = document.getElementById('splash-version');
            if (el) el.textContent = 'v' + v;
        }).catch(() => {});
    }
    Splash.setStatus('Проверяем обновления...', 10);
    await new Promise(r => setTimeout(r, 500));

    Splash.setStatus('Авторизация...', 25);
    let authed = false;
    try {
        authed = await AuthManager.init();
    } catch {}

    if (authed) {
        const splashStart = Date.now();

        Splash.setStatus('Загружаем стафф...', 40);
        await StaffManager.load().catch(() => {});
        TrackedManager.render();
        TrackedManager.renderLog();
        TrackedManager.updateBadge();

        Splash.setStatus('Загружаем серверы...', 60);
        serversData = await DataManager.fetchServers().catch(() => []);

        Splash.setStatus('Загружаем игроков...', 80);
        allPlayers = DataManager.processPlayersQuick(serversData);
        App.renderColumns();
        App.updateStats();
        App.filterPlayers();

        // Минимум 3 секунды на splash
        const elapsed = Date.now() - splashStart;
        if (elapsed < 3000) await new Promise(r => setTimeout(r, 3000 - elapsed));

        Splash.setStatus('Готово!', 100);
        await new Promise(r => setTimeout(r, 400));
        Splash.hide();

        // Steam API + полное обновление в фоне
        DataManager.processPlayersSteam(serversData).then(players => {
            allPlayers = players;
            App.renderColumns();
            App.updateStats();
            App.filterPlayers();
            TrackedManager.tick(allPlayers);
            StaffManager.tick(allPlayers);
            PaidManager.tick(allPlayers);
            App._reportSeenAdmins(allPlayers);
            const el = document.getElementById('last-update');
            if (el) el.textContent = new Date().toLocaleTimeString('ru-RU');
        }).catch(() => {});

        App.startAutoUpdate();
    } else {
        Splash.setStatus('Требуется авторизация', 100);
        await new Promise(r => setTimeout(r, 300));
        Splash.hide();
        AuthManager.showGate(true);
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) { App.stopAutoUpdate(); BansManager.stopAuto(); }
    else {
        App.startAutoUpdate(); App.updateData();
        if (document.querySelector('.sidebar-nav-item[data-tab="bans"]')?.classList.contains('active')) {
            BansManager.startAuto();
        }
    }
});
window.App = App;

