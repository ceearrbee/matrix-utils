import {
    resolveHomeserver,
    randomState,
    fetchWithTimeout,
    fetchJoinedRooms,
    fetchRoomPerms,
    computeRoomCapabilities
} from './matrix-api.js';
import {
    setRenderContext,
    renderAll,
    renderWhoami,
    renderMatrix,
    renderRoomList,
    handleExport
} from './render.js';

document.addEventListener('DOMContentLoaded', () => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    const loginForm = document.getElementById('login-form');
    const btnSso = document.getElementById('btn-sso');
    const btnLogout = document.getElementById('btn-logout');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnExport = document.getElementById('btn-export');
    const filterInput = document.getElementById('filter-input');
    const filterMode = document.getElementById('filter-mode');
    const filterCount = document.getElementById('filter-count');
    const privacyToggle = document.getElementById('privacy-mode');
    const loginError = document.getElementById('login-error');
    const dashError = document.getElementById('dash-error');
    const whoamiLabel = document.getElementById('whoami');

    const scanStatus = document.getElementById('scan-status');
    const scanText = document.getElementById('scan-text');
    const results = document.getElementById('results');
    const standingSummary = document.getElementById('standing-summary');
    const matrixBody = document.getElementById('matrix-body');
    const roomListEl = document.getElementById('room-list');

    const TOKEN_KEY = 'mx_access_token';
    const HS_KEY = 'mx_hs_url';
    const HS_PENDING_KEY = 'mx_hs_url_pending';
    const SSO_STATE_KEY = 'mx_sso_state';

    const CONCURRENCY = 6;

    let accessToken = sessionStorage.getItem(TOKEN_KEY);
    let homeserverUrl = sessionStorage.getItem(HS_KEY);
    let scanning = false;

    // Shared view state + dependencies handed to the render module.
    const view = {
        rooms: [],
        redact: false, // privacy mode: hide names/addresses/username for sharing
        userId: null,
        avatarCache: new Map(), // mxc -> data URL (or '' when load failed)
        authedFetch,
        homeserver: () => homeserverUrl,
        els: { whoamiLabel, standingSummary, matrixBody, roomListEl, filterInput, filterMode, filterCount }
    };
    setRenderContext(view);

    function setSession(token, hs) {
        accessToken = token;
        homeserverUrl = hs;
        sessionStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(HS_KEY, hs);
    }

    function clearSession() {
        accessToken = null;
        homeserverUrl = null;
        view.userId = null;
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(HS_KEY);
        sessionStorage.removeItem(HS_PENDING_KEY);
        sessionStorage.removeItem(SSO_STATE_KEY);
    }

    // Handle any SSO redirect first, then render the view exactly once.
    checkSsoCallback().then(() => updateView());

    loginForm.addEventListener('submit', handlePasswordLogin);
    btnSso.addEventListener('click', handleSsoLogin);
    btnLogout.addEventListener('click', handleLogout);
    btnRefresh.addEventListener('click', () => runScan());
    btnExport.addEventListener('click', handleExport);
    filterInput.addEventListener('input', renderRoomList);
    filterMode.addEventListener('change', renderRoomList);
    privacyToggle.addEventListener('change', () => {
        view.redact = privacyToggle.checked;
        renderWhoami();
        renderMatrix();
        renderRoomList();
    });

    async function updateView() {
        if (accessToken && homeserverUrl) {
            loginView.classList.add('hidden');
            dashboardView.classList.remove('hidden');
            await ensureSessionReady();
        } else {
            loginView.classList.remove('hidden');
            dashboardView.classList.add('hidden');
        }
    }

    // Resolve who we are, then run the initial scan.
    async function ensureSessionReady() {
        if (!accessToken || !homeserverUrl) return;
        try {
            if (!view.userId) {
                const res = await authedFetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`);
                if (res.ok) {
                    const data = await res.json();
                    view.userId = data.user_id;
                    renderWhoami();
                }
            }
            if (view.rooms.length === 0 && !scanning) await runScan();
        } catch (err) {
            if (err.message !== 'Session expired') showError(dashError, `Could not initialise: ${err.message}`);
        }
    }

    function showError(element, message) {
        element.textContent = message;
        element.classList.remove('hidden');
    }
    function hideError(element) {
        element.classList.add('hidden');
    }

    const MAX_RATELIMIT_RETRIES = 5;
    const MAX_RETRY_WAIT_MS = 30000;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function retryAfterMs(response) {
        let ms = null;
        const body = await response.clone().json().catch(() => ({}));
        if (Number.isFinite(Number(body.retry_after_ms))) ms = Number(body.retry_after_ms);
        if (ms == null) {
            const header = response.headers.get('Retry-After');
            if (header && Number.isFinite(Number(header))) ms = Number(header) * 1000;
        }
        if (ms == null) ms = 2000;
        return Math.min(ms, MAX_RETRY_WAIT_MS);
    }

    async function withRateLimitRetry(doFetch) {
        for (let attempt = 0; ; attempt++) {
            const response = await doFetch();
            if (response.status === 429 && attempt < MAX_RATELIMIT_RETRIES) {
                await delay(await retryAfterMs(response));
                continue;
            }
            return response;
        }
    }

    async function authedFetch(url, options = {}) {
        const opts = { ...options };
        opts.headers = { ...options.headers, 'Authorization': `Bearer ${accessToken}` };
        const response = await withRateLimitRetry(() => fetchWithTimeout(url, opts));
        if (response.status === 401) {
            const body = await response.clone().json().catch(() => ({}));
            if (!body.errcode || body.errcode === 'M_UNKNOWN_TOKEN' || body.soft_logout) {
                clearSession();
                updateView();
                showError(loginError, 'Your session has expired. Please log in again.');
                throw new Error('Session expired');
            }
        }
        return response;
    }

    async function handlePasswordLogin(e) {
        e.preventDefault();
        hideError(loginError);

        const hsInput = document.getElementById('hs-url').value;
        const user = document.getElementById('username').value.trim();
        const pass = document.getElementById('password').value;

        if (!hsInput || !user || !pass) {
            showError(loginError, 'Please fill in all fields.');
            return;
        }

        const btn = loginForm.querySelector('button[type="submit"]');
        try {
            btn.disabled = true;
            btn.textContent = 'Logging in...';

            const hs = await resolveHomeserver(hsInput);
            const response = await withRateLimitRetry(() => fetchWithTimeout(`${hs}/_matrix/client/v3/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: "m.login.password",
                    identifier: { type: "m.id.user", user: user },
                    password: pass
                })
            }));

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Login failed');

            setSession(data.access_token, hs);
            await updateView();
        } catch (err) {
            showError(loginError, err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Login with Password';
        }
    }

    async function handleSsoLogin() {
        hideError(loginError);
        const hsInput = document.getElementById('hs-url').value;
        if (!hsInput) {
            showError(loginError, 'Please enter a homeserver URL or Domain.');
            return;
        }

        btnSso.disabled = true;
        btnSso.textContent = 'Resolving...';

        try {
            const hs = await resolveHomeserver(hsInput);
            const state = randomState();
            sessionStorage.setItem(HS_PENDING_KEY, hs);
            sessionStorage.setItem(SSO_STATE_KEY, state);

            const base = window.location.href.split('?')[0].split('#')[0];
            const redirectUrl = `${base}?state=${encodeURIComponent(state)}`;
            const ssoRedirectUrl = `${hs}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(redirectUrl)}`;
            window.location.href = ssoRedirectUrl;
        } catch (err) {
            showError(loginError, err.message);
            btnSso.disabled = false;
            btnSso.textContent = 'Login with SSO';
        }
    }

    async function checkSsoCallback() {
        const params = new URLSearchParams(window.location.search);
        const loginToken = params.get('loginToken');
        if (!loginToken) return;

        const returnedState = params.get('state');
        const expectedState = sessionStorage.getItem(SSO_STATE_KEY);
        const savedHs = sessionStorage.getItem(HS_PENDING_KEY);

        window.history.replaceState({}, document.title, window.location.pathname);

        if (!savedHs || !expectedState || returnedState !== expectedState) {
            sessionStorage.removeItem(HS_PENDING_KEY);
            sessionStorage.removeItem(SSO_STATE_KEY);
            showError(loginError, 'SSO login could not be verified (state mismatch). Please try again.');
            return;
        }

        try {
            const response = await withRateLimitRetry(() => fetchWithTimeout(`${savedHs}/_matrix/client/v3/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "m.login.token", token: loginToken })
            }));

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'SSO validation failed');

            setSession(data.access_token, savedHs);
        } catch (err) {
            showError(loginError, err.message);
        } finally {
            sessionStorage.removeItem(HS_PENDING_KEY);
            sessionStorage.removeItem(SSO_STATE_KEY);
        }
    }

    async function handleLogout() {
        if (accessToken && homeserverUrl) {
            try {
                await fetchWithTimeout(`${homeserverUrl}/_matrix/client/v3/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
            } catch (e) {
                console.warn('Server-side logout failed; clearing local session anyway', e);
            }
        }
        clearSession();
        view.rooms = [];
        view.redact = false;
        view.avatarCache.clear();
        whoamiLabel.textContent = '';
        filterInput.value = '';
        filterMode.value = 'all';
        privacyToggle.checked = false;
        results.classList.add('hidden');
        standingSummary.replaceChildren();
        matrixBody.replaceChildren();
        roomListEl.replaceChildren();
        updateView();
    }

    async function runScan() {
        if (scanning || !accessToken || !homeserverUrl) return;
        scanning = true;
        hideError(dashError);
        results.classList.add('hidden');
        view.rooms = [];
        btnRefresh.disabled = true;
        setScan(true, 'Listing rooms…');

        try {
            const roomIds = await fetchJoinedRooms(homeserverUrl, authedFetch);
            if (roomIds.length === 0) {
                setScan(false);
                showError(dashError, 'Your account is not joined to any rooms.');
                return;
            }

            let done = 0;
            const total = roomIds.length;
            setScan(true, `Scanned 0 / ${total} rooms…`);

            // Bounded-concurrency worker pool over the room list.
            const queue = roomIds.slice();
            const collected = [];
            async function worker() {
                while (queue.length) {
                    const roomId = queue.shift();
                    const perms = await fetchRoomPerms(roomId, homeserverUrl, authedFetch);
                    const computed = computeRoomCapabilities(perms.powerLevels, perms.createContent, view.userId, perms.foundingCreator);
                    collected.push({
                        roomId,
                        name: perms.name,
                        alias: perms.alias,
                        avatarMxc: perms.avatarMxc,
                        encrypted: perms.encrypted,
                        error: perms.error,
                        ...computed
                    });
                    done++;
                    setScan(true, `Scanned ${done} / ${total} rooms…`);
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

            // Sort by power level (highest first), then by name/id.
            collected.sort((a, b) => {
                if (b.myLevel !== a.myLevel) return b.myLevel - a.myLevel;
                return (a.name || a.alias || a.roomId).localeCompare(b.name || b.alias || b.roomId);
            });
            collected.forEach((room, i) => { room.index = i; }); // stable label numbering
            view.rooms = collected;

            setScan(false);
            renderAll();
            results.classList.remove('hidden');
        } catch (err) {
            setScan(false);
            if (err.message !== 'Session expired') showError(dashError, err.message);
        } finally {
            scanning = false;
            btnRefresh.disabled = false;
        }
    }

    function setScan(active, text) {
        scanStatus.classList.toggle('hidden', !active);
        if (text) scanText.textContent = text;
    }
});
