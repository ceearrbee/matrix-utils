// Matrix homeserver API helpers and the power-level permission model for the
// room-permissions inspector. Kept free of DOM/session state so the permission
// logic can be unit-tested in isolation (see matrix-api.test.js).
//
// The app is read-only: it lists every room the account is joined to and, for
// each, works out the account's power level and what that level can and cannot
// do, plus which power-level keys are explicitly set versus falling back to the
// Matrix spec defaults.

export const DEFAULT_HS_SCHEME = 'https://';

export const DEFAULT_TIMEOUT_MS = 30000;

// fetch() with an abort-based timeout so a hung homeserver can't stall the UI.
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s. The homeserver may be slow or unreachable.`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

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
    } catch {
        throw new Error('Invalid homeserver URL or domain.');
    }

    try {
        const res = await fetchWithTimeout(`${parsedBase.origin}/.well-known/matrix/client`);
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

// True when the room version uses the v12+ "creators have infinite,
// unrepresentable power level" model (MSC4289). Non-numeric / unstable version
// strings are treated as pre-v12 for the purposes of creator handling.
export function isCreatorPrivilegedVersion(version) {
    const n = parseInt(version, 10);
    return Number.isInteger(n) && String(n) === String(version).trim() && n >= 12;
}

// Permission model.

// Coerce a value to a finite number, else return the default.
function num(v, dflt) {
    return Number.isFinite(Number(v)) ? Number(v) : dflt;
}

// Level for a simple top-level power-levels key (kick/ban/redact/invite).
// `explicit` records whether the key was present, so the UI can mark levels
// that fell back to a spec default.
function topLevel(pl, key, specDefault) {
    const v = pl ? pl[key] : undefined;
    if (Number.isFinite(Number(v))) return { value: Number(v), explicit: true };
    return { value: specDefault, explicit: false };
}

// Level required to send an event of `type`: the per-event override if present,
// otherwise the category default (events_default for messages, state_default
// for state events), otherwise the spec default.
function eventLevel(pl, type, categoryDefaultKey, specDefault) {
    const events = (pl && pl.events) || {};
    if (Number.isFinite(Number(events[type]))) return { value: Number(events[type]), explicit: true };
    const cd = pl ? pl[categoryDefaultKey] : undefined;
    if (Number.isFinite(Number(cd))) return { value: Number(cd), explicit: true };
    return { value: specDefault, explicit: false };
}

// Level required to trigger a notification (e.g. @room).
function notifLevel(pl, key, specDefault) {
    const notif = (pl && pl.notifications) || {};
    if (Number.isFinite(Number(notif[key]))) return { value: Number(notif[key]), explicit: true };
    return { value: specDefault, explicit: false };
}

function cap(key, label, cat, level, opts) {
    return { key, label, cat, level, ...opts };
}

// Ordered capability descriptors. Each `level(pl)` returns { value, explicit }.
// This single table drives the list, the matrix grid, and the chart.
export const CAPABILITIES = [
    cap('m.room.message', 'Send messages', 'messaging', pl => eventLevel(pl, 'm.room.message', 'events_default', 0)),
    cap('m.reaction', 'Send reactions', 'messaging', pl => eventLevel(pl, 'm.reaction', 'events_default', 0)),

    cap('invite', 'Invite users', 'membership', pl => topLevel(pl, 'invite', 0)),

    cap('kick', 'Kick (remove) users', 'moderation', pl => topLevel(pl, 'kick', 50)),
    cap('ban', 'Ban users', 'moderation', pl => topLevel(pl, 'ban', 50)),
    cap('redact', 'Redact others’ messages', 'moderation', pl => topLevel(pl, 'redact', 50)),

    cap('notifications.room', 'Notify the whole room (@room)', 'notifications', pl => notifLevel(pl, 'room', 50)),

    cap('state_default', 'Send custom state events', 'state', pl => topLevel(pl, 'state_default', 50)),
    cap('m.room.pinned_events', 'Pin messages', 'state', pl => eventLevel(pl, 'm.room.pinned_events', 'state_default', 50)),
    cap('m.space.child', 'Add/remove rooms in this space', 'state', pl => eventLevel(pl, 'm.space.child', 'state_default', 50), { spaceOnly: true }),
    cap('m.room.name', 'Change room name', 'state', pl => eventLevel(pl, 'm.room.name', 'state_default', 50)),
    cap('m.room.topic', 'Change room topic', 'state', pl => eventLevel(pl, 'm.room.topic', 'state_default', 50)),
    cap('m.room.avatar', 'Change room avatar', 'state', pl => eventLevel(pl, 'm.room.avatar', 'state_default', 50)),
    cap('m.room.canonical_alias', 'Change the main address', 'state', pl => eventLevel(pl, 'm.room.canonical_alias', 'state_default', 50)),
    cap('m.room.power_levels', 'Change permissions', 'state', pl => eventLevel(pl, 'm.room.power_levels', 'state_default', 50)),
    cap('m.room.history_visibility', 'Change history visibility', 'state', pl => eventLevel(pl, 'm.room.history_visibility', 'state_default', 50)),
    cap('m.room.join_rules', 'Change who can join', 'state', pl => eventLevel(pl, 'm.room.join_rules', 'state_default', 50)),
    cap('m.room.server_acl', 'Change server ACLs', 'state', pl => eventLevel(pl, 'm.room.server_acl', 'state_default', 50)),
    cap('m.room.encryption', 'Enable encryption', 'state', pl => eventLevel(pl, 'm.room.encryption', 'state_default', 50)),
    cap('m.room.tombstone', 'Upgrade / tombstone the room', 'state', pl => eventLevel(pl, 'm.room.tombstone', 'state_default', 50))
];

export const CATEGORIES = [
    { key: 'messaging', label: 'Messaging' },
    { key: 'membership', label: 'Membership' },
    { key: 'moderation', label: 'Moderation' },
    { key: 'notifications', label: 'Notifications' },
    { key: 'state', label: 'Room settings (state events)' }
];

// Compact subset shown as columns in the rooms × permissions grid.
export const GRID_KEYS = [
    'm.room.message', 'invite', 'kick', 'ban', 'redact',
    'm.room.name', 'm.room.power_levels', 'm.room.tombstone'
];

// True only for the v12+ "infinite power" creator model. A creator is the
// create-event *sender* (the founding creator) or any user in
// `additional_creators`. The single-state-event endpoint does not return the
// sender, so callers pass the resolved founding creator separately (fetched via
// full room state for v12+ rooms); when unknown, only additional_creators can
// be matched and the UI surfaces a caveat.
export function isPrivilegedCreator(createContent, userId, foundingCreator = null) {
    if (!createContent || !userId) return false;
    if (!isCreatorPrivilegedVersion(String(createContent.room_version || '1'))) return false;
    if (foundingCreator && foundingCreator === userId) return true;
    return Array.isArray(createContent.additional_creators) && createContent.additional_creators.includes(userId);
}

// The account's power level in a room. v12+ privileged creators have infinite
// power; everyone else is users[userId] ?? users_default ?? 0.
export function myLevel(pl, createContent, userId, foundingCreator = null) {
    if (isPrivilegedCreator(createContent, userId, foundingCreator)) return Infinity;
    const users = (pl && pl.users) || {};
    if (Number.isFinite(Number(users[userId]))) return Number(users[userId]);
    return num(pl && pl.users_default, 0);
}

// Human-friendly power level (Infinity becomes the creator glyph).
export function formatLevel(n) {
    return n === Infinity ? '∞' : String(n);
}

// Given a room's power_levels content (or null), its create content (or null),
// and the account's user id, return everything the views need.
export function computeRoomCapabilities(pl, createContent, userId, foundingCreator = null) {
    const create = createContent || {};
    const version = String(create.room_version || '1');
    const v12plus = isCreatorPrivilegedVersion(version);
    const privilegedCreator = isPrivilegedCreator(create, userId, foundingCreator);
    const level = myLevel(pl, create, userId, foundingCreator);
    const hadPowerLevels = Boolean(pl) && Object.keys(pl).length > 0;

    const isSpace = create.type === 'm.space';
    const caps = CAPABILITIES
        .filter(c => !c.spaceOnly || isSpace) // m.space.child only matters in spaces
        .map(c => {
            const { value, explicit } = c.level(pl || {});
            return {
                key: c.key,
                label: c.label,
                cat: c.cat,
                required: value,
                can: level >= value,
                usesDefault: !explicit
            };
        });

    return {
        version,
        v12plus,
        roomType: create.type || null,
        privilegedCreator,
        // For v12+ rooms, true once the founding creator (create sender) is known
        // so the UI can drop the "may be understated" caveat.
        foundingCreatorKnown: !v12plus || foundingCreator != null,
        recordedCreator: create.creator === userId, // pre-v11 informational only
        additionalCreators: Array.isArray(create.additional_creators) ? create.additional_creators : [],
        myLevel: level,
        hadPowerLevels,
        caps
    };
}

// Network helpers take an authedFetch so they stay free of session state.

export async function fetchJoinedRooms(hs, authedFetch) {
    const res = await authedFetch(`${hs}/_matrix/client/v3/joined_rooms`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not list joined rooms (HTTP ${res.status}).`);
    }
    const data = await res.json();
    return Array.isArray(data.joined_rooms) ? data.joined_rooms : [];
}

// Fetch the content of a single state event. Returns null when the room has no
// such event (404); throws on other failures so the caller can record them.
async function fetchStateContent(roomId, type, hs, authedFetch) {
    const res = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// Read the sender (founding creator) of a room's m.room.create event. The
// single-state-event endpoint omits the sender, so we read full room state and
// pick it out. Heavier (pulls members), so callers should only use this for
// v12+ rooms, where founding-creator status grants infinite power.
async function fetchCreateSender(roomId, hs, authedFetch) {
    const res = await authedFetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`);
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events)) return null;
    const create = events.find(e => e.type === 'm.room.create' && (e.state_key === '' || e.state_key == null));
    return create ? (create.sender || null) : null;
}

// Fetch just the state needed to judge permissions for one room. Light and
// size-independent (never pulls the member list) — except for v12+ rooms, where
// we additionally read full state once to resolve the founding creator. Never
// throws for an ordinary per-room failure — records it in `error` so one bad
// room can't abort the sweep — but re-throws 'Session expired' to stop everything.
export async function fetchRoomPerms(roomId, hs, authedFetch) {
    const result = {
        roomId, name: null, alias: null, avatarMxc: null,
        powerLevels: null, createContent: null, encrypted: false,
        foundingCreator: null, error: null
    };

    try {
        result.createContent = await fetchStateContent(roomId, 'm.room.create', hs, authedFetch);
    } catch (err) {
        if (err.message === 'Session expired') throw err;
        result.error = err.message;
    }

    try {
        result.powerLevels = await fetchStateContent(roomId, 'm.room.power_levels', hs, authedFetch);
    } catch (err) {
        if (err.message === 'Session expired') throw err;
        if (!result.error) result.error = err.message;
    }

    try {
        const name = await fetchStateContent(roomId, 'm.room.name', hs, authedFetch);
        if (name && name.name) result.name = name.name;
    } catch (err) {
        if (err.message === 'Session expired') throw err;
    }

    try {
        const ca = await fetchStateContent(roomId, 'm.room.canonical_alias', hs, authedFetch);
        if (ca && ca.alias) result.alias = ca.alias;
    } catch (err) {
        if (err.message === 'Session expired') throw err;
    }

    try {
        const av = await fetchStateContent(roomId, 'm.room.avatar', hs, authedFetch);
        if (av && typeof av.url === 'string') result.avatarMxc = av.url;
    } catch (err) {
        if (err.message === 'Session expired') throw err;
    }

    try {
        const enc = await fetchStateContent(roomId, 'm.room.encryption', hs, authedFetch);
        result.encrypted = Boolean(enc && enc.algorithm);
    } catch (err) {
        if (err.message === 'Session expired') throw err;
    }

    // Resolve the founding creator only where it can grant infinite power (v12+).
    if (result.createContent && isCreatorPrivilegedVersion(String(result.createContent.room_version || '1'))) {
        try {
            result.foundingCreator = await fetchCreateSender(roomId, hs, authedFetch);
        } catch (err) {
            if (err.message === 'Session expired') throw err;
        }
    }

    return result;
}

export function parseMxc(mxc) {
    const m = /^mxc:\/\/([^/]+)\/([^/?#]+)/.exec(mxc || '');
    return m ? { serverName: m[1], mediaId: m[2] } : null;
}

// Candidate thumbnail endpoints for an mxc URI: authenticated media first
// (MSC3916 / current spec), then the legacy unauthenticated path for older
// servers. Both are tried with the bearer token; the legacy one ignores it.
export function thumbnailEndpoints(mxc, hs, size = 64) {
    const p = parseMxc(mxc);
    if (!p) return [];
    const q = `width=${size}&height=${size}&method=crop`;
    const sn = encodeURIComponent(p.serverName);
    const mid = encodeURIComponent(p.mediaId);
    return [
        `${hs}/_matrix/client/v1/media/thumbnail/${sn}/${mid}?${q}`,
        `${hs}/_matrix/media/v3/thumbnail/${sn}/${mid}?${q}`
    ];
}
