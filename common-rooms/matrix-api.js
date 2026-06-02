// Matrix homeserver API helpers, kept free of any DOM/session state so they can
// be unit-reasoned in isolation and to keep app.js small.

// Scheme prepended when the user enters a bare domain without a protocol. Kept
// in config (not inlined) so deployment/protocol choices live in one place.
export const DEFAULT_HS_SCHEME = 'https://';

// MSC2666 (mutual rooms) was never stabilized into a released spec version,
// so support is determined solely from the advertised unstable_features.
export const MSC2666_FLAGS = [
    'uk.half-shot.msc2666.query_mutual_rooms',
    'uk.half-shot.msc2666.mutual_rooms',
    'uk.half-shot.msc2666'
];

// Cap on pagination pages to avoid an unbounded loop against a hostile or
// buggy server.
export const MAX_MUTUAL_ROOMS_PAGES = 20;

// Resolve a domain or URL to an https homeserver base URL via .well-known.
// Plaintext http is rejected so credentials/tokens never leave over the wire
// unencrypted, and a .well-known base_url is only trusted if it is https.
export async function resolveHomeserver(domain) {
    domain = (domain || '').trim().replace(/\/+$/, "");
    if (!domain) {
        throw new Error('Please enter a homeserver URL or domain.');
    }

    if (/^http:\/\//i.test(domain)) {
        throw new Error('Insecure http:// homeservers are not allowed. Use https://.');
    }

    let baseUrl = domain;
    if (!/^https:\/\//i.test(baseUrl)) {
        baseUrl = `${DEFAULT_HS_SCHEME}${domain}`;
    }

    let parsedBase;
    try {
        parsedBase = new URL(baseUrl);
    } catch (e) {
        throw new Error('Invalid homeserver URL or domain.');
    }

    try {
        const res = await fetch(`${parsedBase.origin}/.well-known/matrix/client`);
        if (res.ok) {
            const data = await res.json();
            const discovered = data["m.homeserver"] && data["m.homeserver"].base_url;
            if (discovered) {
                const parsed = new URL(discovered);
                if (parsed.protocol === 'https:') {
                    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
                }
                // Discovery pointed somewhere insecure; ignore it.
            }
        }
    } catch (e) {
        // No/invalid .well-known: fall back to the entered https base URL.
        console.warn('.well-known discovery failed; using entered base URL', e);
    }

    return parsedBase.origin;
}

export function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function checkMsc2666Support(hs) {
    const response = await fetch(`${hs}/_matrix/client/versions`);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching versions`);
    const data = await response.json();
    const unstable = data.unstable_features || {};
    const supported = MSC2666_FLAGS.some(flag => unstable[flag] === true);
    return supported
        ? '✅ Server advertises support for MSC2666 (mutual rooms).'
        : '⚠️ Server does not advertise MSC2666 support. The lookup may still fail; try anyway.';
}

export async function fetchMutualRooms(targetUserId, homeserverUrl, authedFetch) {
    // Endpoint variants across Synapse/spec revisions. Path-style endpoints
    // can't carry a batch token, so pagination only applies to query-style.
    const buildEndpoints = (batchToken) => {
        const enc = encodeURIComponent(targetUserId);
        const batch = batchToken ? `&batch_token=${encodeURIComponent(batchToken)}` : '';
        return [
            `${homeserverUrl}/_matrix/client/v1/mutual_rooms?user_id=${enc}${batch}`,
            `${homeserverUrl}/_matrix/client/v3/user/mutual_rooms?user_id=${enc}${batch}`,
            `${homeserverUrl}/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms?user_id=${enc}${batch}`,
            `${homeserverUrl}/_matrix/client/v3/user/${enc}/mutual_rooms`,
            `${homeserverUrl}/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms/${enc}`
        ];
    };

    const joined = [];
    let batchToken = undefined;
    let lastError = '';
    let pages = 0;

    do {
        let pageData = null;
        for (const endpoint of buildEndpoints(batchToken)) {
            try {
                const response = await authedFetch(endpoint);
                if (response.ok) {
                    pageData = await response.json();
                    break;
                }
                if (response.status !== 404 && response.status !== 400) {
                    const errData = await response.json().catch(() => ({}));
                    lastError = errData.error || `HTTP ${response.status}`;
                }
            } catch (err) {
                if (err.message === 'Session expired') throw err;
                lastError = err.message;
            }
        }

        if (!pageData) {
            if (joined.length === 0) {
                throw new Error(lastError || 'Mutual rooms endpoint is not supported by this homeserver or the user was not found.');
            }
            break; // Got at least one page; stop on a failed continuation.
        }

        for (const id of (pageData.joined || [])) joined.push(id);
        batchToken = pageData.next_batch_token;
        pages++;
    } while (batchToken && pages < MAX_MUTUAL_ROOMS_PAGES);

    return { joined, truncated: Boolean(batchToken) };
}
