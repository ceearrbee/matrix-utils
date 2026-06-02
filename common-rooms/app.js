esimport {
    resolveHomeserver,
    randomState,
    checkMsc2666Support,
    fetchMutualRooms
} from './matrix-api.js';

document.addEventListener('DOMContentLoaded', () => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    const loginForm = document.getElementById('login-form');
    const btnSso = document.getElementById('btn-sso');
    const btnLogout = document.getElementById('btn-logout');
    const btnTest = document.getElementById('btn-test');
    const btnTestLogin = document.getElementById('btn-test-login');
    const loginError = document.getElementById('login-error');
    const testSupportResult = document.getElementById('test-support-result');
    const searchForm = document.getElementById('search-form');
    const searchError = document.getElementById('search-error');
    const resultsContainer = document.getElementById('results-container');
    const resultsTitle = document.getElementById('results-title');
    const roomsList = document.getElementById('rooms-list');
    const loader = document.getElementById('loader');

    const TOKEN_KEY = 'mx_access_token';
    const HS_KEY = 'mx_hs_url';
    const HS_PENDING_KEY = 'mx_hs_url_pending';
    const SSO_STATE_KEY = 'mx_sso_state';

    let accessToken = sessionStorage.getItem(TOKEN_KEY);
    let homeserverUrl = sessionStorage.getItem(HS_KEY);

    function setSession(token, hs) {
        accessToken = token;
        homeserverUrl = hs;
        sessionStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(HS_KEY, hs);
    }

    function clearSession() {
        accessToken = null;
        homeserverUrl = null;
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(HS_KEY);
        sessionStorage.removeItem(HS_PENDING_KEY);
        sessionStorage.removeItem(SSO_STATE_KEY);
    }

    checkSsoCallback();
    updateView();

    loginForm.addEventListener('submit', handlePasswordLogin);
    btnSso.addEventListener('click', handleSsoLogin);
    btnLogout.addEventListener('click', handleLogout);
    btnTest.addEventListener('click', handleTestSupport);
    btnTestLogin.addEventListener('click', handleLoginTestSupport);
    searchForm.addEventListener('submit', handleSearch);

    function updateView() {
        if (accessToken && homeserverUrl) {
            loginView.classList.add('hidden');
            dashboardView.classList.remove('hidden');
        } else {
            loginView.classList.remove('hidden');
            dashboardView.classList.add('hidden');
        }
    }

    function showError(element, message) {
        element.textContent = message;
        element.classList.remove('hidden');
    }

    function hideError(element) {
        element.classList.add('hidden');
    }

    // Authenticated fetch wrapper: forces logout on an invalidated token so the
    // app never gets stuck holding a dead session.
    async function authedFetch(url, options = {}) {
        const opts = { ...options };
        opts.headers = { ...(options.headers || {}), 'Authorization': `Bearer ${accessToken}` };
        const response = await fetch(url, opts);
        if (response.status === 401) {
            const body = await response.clone().json().catch(() => ({}));
            if (!body.errcode || body.errcode === 'M_UNKNOWN_TOKEN' || body.soft_logout) {
                clearSession();
                resultsContainer.classList.add('hidden');
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

            const response = await fetch(`${hs}/_matrix/client/v3/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: "m.login.password",
                    identifier: { type: "m.id.user", user: user },
                    password: pass
                })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Login failed');

            setSession(data.access_token, hs);
            updateView();
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

        // Always scrub the token/state from the URL and storage before doing
        // anything else, regardless of outcome.
        window.history.replaceState({}, document.title, window.location.pathname);

        if (!savedHs || !expectedState || returnedState !== expectedState) {
            sessionStorage.removeItem(HS_PENDING_KEY);
            sessionStorage.removeItem(SSO_STATE_KEY);
            showError(loginError, 'SSO login could not be verified (state mismatch). Please try again.');
            return;
        }

        try {
            const response = await fetch(`${savedHs}/_matrix/client/v3/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: "m.login.token",
                    token: loginToken
                })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'SSO validation failed');

            setSession(data.access_token, savedHs);
            updateView();
        } catch (err) {
            showError(loginError, err.message);
        } finally {
            sessionStorage.removeItem(HS_PENDING_KEY);
            sessionStorage.removeItem(SSO_STATE_KEY);
        }
    }

    async function handleLogout() {
        // Best-effort server-side invalidation so the token can't be replayed.
        if (accessToken && homeserverUrl) {
            try {
                await fetch(`${homeserverUrl}/_matrix/client/v3/logout`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
            } catch (e) {
                // Network error on server-side logout is non-fatal: we still
                // clear local state below. Log for diagnostics rather than
                // swallowing it silently.
                console.warn('Server-side logout failed; clearing local session anyway', e);
            }
        }
        clearSession();
        resultsContainer.classList.add('hidden');
        roomsList.replaceChildren();
        document.getElementById('target-user-id').value = '';
        hideError(testSupportResult);
        updateView();
    }

    async function handleTestSupport() {
        hideError(testSupportResult);
        testSupportResult.classList.remove('hidden');
        testSupportResult.textContent = 'Testing server support...';
        try {
            testSupportResult.textContent = await checkMsc2666Support(homeserverUrl);
        } catch (err) {
            testSupportResult.textContent = `Failed to test server support: ${err.message}`;
        }
    }

    async function handleLoginTestSupport() {
        hideError(loginError);
        const hsInput = document.getElementById('hs-url').value;
        if (!hsInput) {
            showError(loginError, 'Please enter a homeserver URL or Domain.');
            return;
        }

        btnTestLogin.disabled = true;
        btnTestLogin.textContent = 'Testing...';
        try {
            const hs = await resolveHomeserver(hsInput);
            showError(loginError, await checkMsc2666Support(hs));
        } catch (err) {
            showError(loginError, `Failed to test server support: ${err.message}`);
        } finally {
            btnTestLogin.disabled = false;
            btnTestLogin.textContent = 'Test Server';
        }
    }

    async function handleSearch(e) {
        e.preventDefault();
        hideError(searchError);
        const targetUserId = document.getElementById('target-user-id').value.trim();

        if (!targetUserId) {
            showError(searchError, 'Please enter a target user ID.');
            return;
        }

        resultsContainer.classList.remove('hidden');
        loader.classList.remove('hidden');
        roomsList.replaceChildren();
        resultsTitle.textContent = `Finding mutual rooms...`;

        try {
            const { joined, truncated } = await fetchMutualRooms(targetUserId, homeserverUrl, authedFetch);

            if (joined.length === 0) {
                resultsTitle.textContent = 'No mutual rooms found.';
                return;
            }

            const suffix = truncated ? ' (showing first pages)' : '';
            resultsTitle.textContent = `Found ${joined.length} mutual room${joined.length === 1 ? '' : 's'}${suffix}:`;
            renderRooms(joined);
        } catch (err) {
            if (err.message !== 'Session expired') {
                showError(searchError, err.message);
            }
            resultsTitle.textContent = '';
        } finally {
            loader.classList.add('hidden');
        }
    }

    // Build the room list with DOM APIs only. Room IDs/names/aliases come from
    // an untrusted homeserver and must never be treated as HTML.
    function renderRooms(roomIds) {
        roomsList.replaceChildren();

        for (const roomId of roomIds) {
            const li = document.createElement('li');
            li.className = 'room-item';

            const nameEl = document.createElement('div');
            nameEl.className = 'room-name';
            nameEl.textContent = 'Loading...';

            const idEl = document.createElement('div');
            idEl.className = 'room-id';
            idEl.textContent = roomId;

            li.append(nameEl, idEl);
            roomsList.append(li);

            authedFetch(`${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`)
                .then(async response => {
                    if (response.ok) {
                        const data = await response.json();
                        nameEl.textContent = data.name || 'Unnamed Room';
                    } else {
                        nameEl.textContent = 'Private / Unnamed Room';
                    }
                })
                .catch(() => { nameEl.textContent = 'Unknown Room'; });

            // Fetch canonical alias (friendly address).
            authedFetch(`${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.canonical_alias`)
                .then(async response => {
                    if (!response.ok) return;
                    const data = await response.json();
                    let aliases = [];
                    if (data.alias) aliases.push(data.alias);
                    if (Array.isArray(data.alt_aliases)) aliases = aliases.concat(data.alt_aliases);
                    if (aliases.length > 0) {
                        idEl.textContent = `${aliases.join(', ')} (${roomId})`;
                    }
                })
                .catch(() => {});
        }
    }
});
