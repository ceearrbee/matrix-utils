import {
    resolveHomeserver,
    randomState,
    fetchRoomVersionCapabilities,
    planUpgrade,
    performUpgrade,
    fetchWithTimeout
} from './matrix-api.js';

document.addEventListener('DOMContentLoaded', () => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    const loginForm = document.getElementById('login-form');
    const btnSso = document.getElementById('btn-sso');
    const btnLogout = document.getElementById('btn-logout');
    const loginError = document.getElementById('login-error');

    const upgradeForm = document.getElementById('upgrade-form');
    const roomIdInput = document.getElementById('room-id');
    const versionSelect = document.getElementById('room-version');
    const encryptionModeSelect = document.getElementById('encryption-mode');
    const inviteModeSelect = document.getElementById('invite-mode');
    const tombstoneMessageInput = document.getElementById('tombstone-message');
    const upgradeError = document.getElementById('upgrade-error');
    const whoamiLabel = document.getElementById('whoami');

    const planContainer = document.getElementById('plan-container');
    const planList = document.getElementById('plan-list');
    const confirmAck = document.getElementById('confirm-ack');
    const confirmAckText = document.getElementById('confirm-ack-text');

    const DEFAULT_ACK_TEXT = 'I understand this is irreversible: the old room will be tombstoned and frozen, and any members are invited (not force-joined) to the new room.';
    const ORPHAN_ACK_TEXT = 'I understand I likely lack permission to tombstone the old room: a new room may be created that the old room will not link to, leaving an orphan. I want to proceed anyway.';
    const btnPerform = document.getElementById('btn-perform');
    const btnDownload = document.getElementById('btn-download');
    const btnCancel = document.getElementById('btn-cancel');

    const logContainer = document.getElementById('log-container');
    const logList = document.getElementById('log-list');
    const logBusy = document.getElementById('log-busy');
    const resultSummary = document.getElementById('result-summary');

    const TOKEN_KEY = 'mx_access_token';
    const HS_KEY = 'mx_hs_url';
    const HS_PENDING_KEY = 'mx_hs_url_pending';
    const SSO_STATE_KEY = 'mx_sso_state';

    let accessToken = sessionStorage.getItem(TOKEN_KEY);
    let homeserverUrl = sessionStorage.getItem(HS_KEY);
    let operatorUserId = null;
    let pendingUpgrade = null; // { createBody, byType, oldRoomId }

    function setSession(token, hs) {
        accessToken = token;
        homeserverUrl = hs;
        sessionStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(HS_KEY, hs);
    }

    function clearSession() {
        accessToken = null;
        homeserverUrl = null;
        operatorUserId = null;
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(HS_KEY);
        sessionStorage.removeItem(HS_PENDING_KEY);
        sessionStorage.removeItem(SSO_STATE_KEY);
    }

    // Handle any SSO redirect first, then render the view exactly once so two
    // concurrent session-init passes can't race.
    checkSsoCallback().then(() => updateView());

    loginForm.addEventListener('submit', handlePasswordLogin);
    btnSso.addEventListener('click', handleSsoLogin);
    btnLogout.addEventListener('click', handleLogout);
    upgradeForm.addEventListener('submit', handlePreview);
    btnCancel.addEventListener('click', resetToForm);
    confirmAck.addEventListener('change', () => { btnPerform.disabled = !confirmAck.checked; });
    btnPerform.addEventListener('click', handlePerform);
    btnDownload.addEventListener('click', handleDownloadPlan);

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

    // Resolve who we are and populate the room-version dropdown once logged in.
    async function ensureSessionReady() {
        if (!accessToken || !homeserverUrl) return;
        try {
            if (!operatorUserId) {
                const res = await authedFetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`);
                if (res.ok) {
                    const data = await res.json();
                    operatorUserId = data.user_id;
                    whoamiLabel.textContent = `Signed in as ${operatorUserId}`;
                }
            }
            if (versionSelect.options.length === 0) {
                const caps = await fetchRoomVersionCapabilities(homeserverUrl, authedFetch);
                populateVersions(caps);
            }
        } catch (err) {
            if (err.message !== 'Session expired') {
                showError(upgradeError, `Could not initialise: ${err.message}`);
            }
        }
    }

    function populateVersions(caps) {
        versionSelect.replaceChildren();
        // Sort numeric versions descending; keep non-numeric (unstable) at the end.
        const entries = Object.keys(caps.available).sort((a, b) => {
            const na = parseInt(a, 10), nb = parseInt(b, 10);
            const aNum = Number.isInteger(na) && String(na) === a;
            const bNum = Number.isInteger(nb) && String(nb) === b;
            if (aNum && bNum) return nb - na;
            if (aNum) return -1;
            if (bNum) return 1;
            return a.localeCompare(b);
        });
        for (const v of entries) {
            const opt = document.createElement('option');
            opt.value = v;
            const stability = caps.available[v] === 'stable' ? '' : ' (unstable)';
            const isDefault = v === caps.default ? ' (server default)' : '';
            opt.textContent = `Version ${v}${stability}${isDefault}`;
            if (v === caps.default) opt.selected = true;
            versionSelect.append(opt);
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

    // Wait before retrying a 429: retry_after_ms, then Retry-After (seconds),
    // then a default. Capped.
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

    // Retry a fetch on HTTP 429 until the server stops or the cap is hit.
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

    // Authenticated fetch: timeout, rate-limit retry, and forced logout on an
    // invalidated token.
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
        resetToForm();
        versionSelect.replaceChildren();
        whoamiLabel.textContent = '';
        roomIdInput.value = '';
        updateView();
    }

    function resetToForm() {
        pendingUpgrade = null;
        planContainer.classList.add('hidden');
        logContainer.classList.add('hidden');
        resultSummary.classList.add('hidden');
        resultSummary.replaceChildren();
        confirmAck.checked = false;
        btnPerform.disabled = true;
        upgradeForm.classList.remove('hidden');
    }

    async function handlePreview(e) {
        e.preventDefault();
        hideError(upgradeError);
        logContainer.classList.add('hidden');
        logList.replaceChildren();
        resultSummary.classList.add('hidden');
        resultSummary.replaceChildren();

        const oldRoomId = roomIdInput.value.trim();
        const targetVersion = versionSelect.value;
        const encryptionMode = encryptionModeSelect.value;
        const inviteMode = inviteModeSelect.value;
        const tombstoneMessage = tombstoneMessageInput.value;

        if (!oldRoomId) {
            showError(upgradeError, 'Please enter the room ID to upgrade.');
            return;
        }
        if (!targetVersion) {
            showError(upgradeError, 'No target room version selected.');
            return;
        }
        if (!operatorUserId) {
            showError(upgradeError, 'Still resolving your account; please try again in a moment.');
            return;
        }

        const submitBtn = upgradeForm.querySelector('button[type="submit"]');
        try {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Reading room...';

            const { body, plan, byType, invite } = await planUpgrade({
                oldRoomId, hs: homeserverUrl, authedFetch, operatorUserId, targetVersion, encryptionMode, inviteMode
            });
            pendingUpgrade = { createBody: body, byType, oldRoomId, tombstoneMessage, invite };
            renderPlan(plan, oldRoomId);
            upgradeForm.classList.add('hidden');
            planContainer.classList.remove('hidden');
        } catch (err) {
            if (err.message !== 'Session expired') showError(upgradeError, err.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Preview Upgrade';
        }
    }

    // DOM APIs only: every value comes from an untrusted homeserver and must
    // never become HTML.
    function renderPlan(plan, oldRoomId) {
        planList.replaceChildren();
        const items = [];

        items.push(['Old room', oldRoomId]);
        items.push(['New room version', plan.targetVersion + (plan.v12plus ? ' (creator-privileged)' : '')]);
        if (plan.name) items.push(['Name carried over', plan.name]);

        if (plan.wasEncrypted && !plan.willBeEncrypted) {
            items.push(['Encryption', 'Will be removed: the new room is unencrypted. Old messages are not migrated or decrypted.']);
        } else if (plan.willBeEncrypted && plan.wasEncrypted) {
            items.push(['Encryption', 'Kept (new room stays encrypted).']);
        } else if (plan.willBeEncrypted && !plan.wasEncrypted) {
            items.push(['Encryption', 'Will be enabled: the old room is unencrypted; the new room will be encrypted.']);
        } else {
            items.push(['Encryption', 'Old room is not encrypted; new room stays unencrypted.']);
        }

        const inviteLabel = plan.inviteMode === 'none'
            ? 'Nobody (only you)'
            : `${plan.inviteCount}${plan.inviteMode === 'joined' ? ' (currently-joined only)' : ''}`;
        items.push(['Members to invite', inviteLabel]);
        items.push(['Power levels', plan.preservesPowerLevels ? 'Copied from the old room' : 'Server defaults (old room had none)']);
        if (plan.v12plus && plan.additionalCreators.length > 0) {
            items.push(['Preserved creators (infinite power)', plan.additionalCreators.join(', ')]);
        }
        items.push(['Carried state', plan.carriedStateTypes.length ? plan.carriedStateTypes.join(', ') : 'none']);
        if (plan.roomType === 'm.space') {
            items.push(['⚠ Room type', 'This is a Space. Child rooms and hierarchy are not migrated.']);
        }
        if (!plan.canTombstone) {
            items.push(['⚠ Tombstone rights', `You appear to lack permission to tombstone the old room (your power level ${plan.operatorPowerLevel}, need ${plan.requiredTombstoneLevel}). The new room would be created but the old room would not link to it.`]);
        }

        confirmAckText.textContent = plan.canTombstone ? DEFAULT_ACK_TEXT : ORPHAN_ACK_TEXT;

        for (const [k, v] of items) {
            const li = document.createElement('li');
            const key = document.createElement('span');
            key.className = 'plan-key';
            key.textContent = k;
            const val = document.createElement('span');
            val.className = 'plan-val';
            val.textContent = v;
            li.append(key, val);
            planList.append(li);
        }
    }

    async function handlePerform() {
        if (!pendingUpgrade) return;
        const tombstoneMessage = pendingUpgrade.tombstoneMessage;
        planContainer.classList.add('hidden');
        logContainer.classList.remove('hidden');
        logList.replaceChildren();
        resultSummary.classList.add('hidden');
        resultSummary.replaceChildren();
        setBusy(true);

        try {
            const newRoomId = await performUpgrade({
                oldRoomId: pendingUpgrade.oldRoomId,
                hs: homeserverUrl,
                authedFetch,
                createBody: pendingUpgrade.createBody,
                byType: pendingUpgrade.byType,
                invite: pendingUpgrade.invite,
                tombstoneMessage,
                log: appendLog
            });
            appendLog('done', `Upgrade complete. New room: ${newRoomId}`);
            renderSummary('success', 'Upgrade complete.', newRoomId);
        } catch (err) {
            if (err.message !== 'Session expired') {
                appendLog('error', err.message);
                // err.newRoomId is set when the new room was created but
                // tombstoning failed; surface it so it isn't orphaned.
                renderSummary('failure', err.message, err.newRoomId || null);
            }
        } finally {
            pendingUpgrade = null;
            setBusy(false);
        }
    }

    function setBusy(busy) {
        logList.setAttribute('aria-busy', busy ? 'true' : 'false');
        logBusy.classList.toggle('hidden', !busy);
    }

    // DOM APIs only: the room ID comes from an untrusted homeserver.
    function renderSummary(kind, message, newRoomId) {
        resultSummary.replaceChildren();
        resultSummary.classList.remove('hidden', 'summary-success', 'summary-failure');
        resultSummary.classList.add(kind === 'success' ? 'summary-success' : 'summary-failure');

        const heading = document.createElement('h3');
        heading.textContent = kind === 'success' ? 'Done' : 'Something went wrong';
        const para = document.createElement('p');
        para.textContent = message;
        resultSummary.append(heading, para);

        if (newRoomId) {
            const row = document.createElement('div');
            row.className = 'room-link-row';

            const link = document.createElement('a');
            link.className = 'room-link';
            link.href = `https://matrix.to/#/${encodeURIComponent(newRoomId)}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = newRoomId;

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'btn btn-small';
            copyBtn.textContent = 'Copy ID';
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(newRoomId);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy ID'; }, 1500);
                } catch {
                    copyBtn.textContent = 'Copy failed';
                }
            });

            row.append(link, copyBtn);
            resultSummary.append(row);
        }

        const restart = document.createElement('button');
        restart.type = 'button';
        restart.className = 'btn';
        restart.textContent = 'Upgrade another room';
        restart.addEventListener('click', resetToForm);
        resultSummary.append(restart);
    }

    function handleDownloadPlan() {
        if (!pendingUpgrade) return;
        const payload = {
            oldRoomId: pendingUpgrade.oldRoomId,
            tombstoneMessage: (pendingUpgrade.tombstoneMessage || '').trim() || 'This room has been upgraded.',
            createRoom: pendingUpgrade.createBody,
            invite: pendingUpgrade.invite || []
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'room-reforge-plan.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    function appendLog(level, message) {
        const li = document.createElement('li');
        li.className = `log-line log-${level}`;
        const tag = document.createElement('span');
        tag.className = 'log-tag';
        tag.textContent = ({ info: '…', ok: '✓', warn: '⚠', error: '✕', done: '★' })[level] || '•';
        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = new Date().toLocaleTimeString();
        const text = document.createElement('span');
        text.className = 'log-text';
        text.textContent = message;
        li.append(tag, time, text);
        logList.append(li);
    }
});
