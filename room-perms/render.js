// View layer: builds all dashboard DOM from a scan's results. Stateless except
// for a shared context object (set once via setRenderContext) holding the view
// models, privacy flag, DOM targets, and the authed-fetch used for avatars.
// Every value comes from an untrusted homeserver, so all output goes through
// textContent / createElement — never innerHTML.

import {
    formatLevel,
    thumbnailEndpoints,
    CATEGORIES,
    CAPABILITIES,
    GRID_KEYS
} from './matrix-api.js';

let ctx = null;

export function setRenderContext(context) {
    ctx = context;
}

export function renderAll() {
    renderStanding();
    renderMatrix();
    renderRoomList();
}

export function renderWhoami() {
    const { whoamiLabel } = ctx.els;
    if (!ctx.userId) { whoamiLabel.textContent = ''; return; }
    whoamiLabel.textContent = ctx.redact ? 'Signed in (hidden for privacy)' : `Signed in as ${ctx.userId}`;
}

function displayName(room) {
    return room.name || room.alias || room.roomId;
}

// Label shown in the UI: anonymized in privacy mode so the page can be shared
// publicly. `index` is assigned per scan for stable numbering.
function roomLabel(room) {
    return ctx.redact ? `Room ${room.index + 1}` : displayName(room);
}

// A horizontal power bar (capped at 100 for display; ∞ shows full).
function powerBar(level) {
    const row = document.createElement('span');
    row.className = 'power-bar';
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${level === Infinity ? 100 : Math.max(0, Math.min(100, level))}%`;
    track.append(fill);
    const val = document.createElement('span');
    val.className = 'bar-value';
    val.textContent = level === Infinity ? '∞' : String(level);
    row.append(track, val);
    return row;
}

function badge(text, cls) {
    const span = document.createElement('span');
    span.className = `badge ${cls || ''}`.trim();
    span.textContent = text;
    return span;
}

// Avatar: a square with the room's initial, optionally backed by a lazily
// loaded thumbnail (see loadAvatars). Falls back to the initial on failure.
function makeAvatar(room) {
    const span = document.createElement('span');
    span.className = 'room-avatar';
    if (ctx.redact) {
        span.textContent = '•'; // initial or image could identify the room
        return span;
    }
    const initial = (displayName(room).replace(/^[#!@]/, '')[0] || '?').toUpperCase();
    span.textContent = initial;
    if (room.avatarMxc) {
        const cached = ctx.avatarCache.get(room.avatarMxc);
        if (cached) setAvatarImage(span, cached);
        else if (cached === undefined) span.dataset.mxc = room.avatarMxc; // not yet attempted
    }
    return span;
}

function setAvatarImage(span, dataUrl) {
    span.textContent = '';
    const img = document.createElement('img');
    img.alt = '';
    img.src = dataUrl;
    span.append(img);
}

function roomHeader(room) {
    const head = document.createElement('div');
    head.className = 'room-head';
    head.append(makeAvatar(room));

    const text = document.createElement('div');
    text.className = 'room-headtext';

    const title = document.createElement('div');
    title.className = 'room-title';
    title.textContent = roomLabel(room);
    text.append(title);

    // The id line (alias/ID + matrix.to link) is identifying — omit it in
    // privacy mode so the page is safe to share.
    if (!ctx.redact) {
        const id = document.createElement('div');
        id.className = 'room-id';
        const idText = document.createElement('span');
        idText.textContent = room.alias ? `${room.alias} · ${room.roomId}` : room.roomId;
        const link = document.createElement('a');
        link.className = 'room-link';
        link.href = `https://matrix.to/#/${encodeURIComponent(room.alias || room.roomId)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'open ↗';
        link.title = 'Open in matrix.to';
        // Inside <summary>: don't toggle the accordion when following the link.
        link.addEventListener('click', e => e.stopPropagation());
        id.append(idText, ' ', link);
        text.append(id);
    }

    const badges = document.createElement('div');
    badges.className = 'badges';
    badges.append(badge(`v${room.version}`, 'badge-version'));
    if (room.roomType === 'm.space') badges.append(badge('Space', 'badge-type'));
    badges.append(badge(room.encrypted ? 'Encrypted' : 'Unencrypted', room.encrypted ? 'badge-enc' : 'badge-plain'));
    if (room.myLevel === Infinity) badges.append(badge('Creator ∞', 'badge-level'));
    text.append(badges);

    head.append(text);
    return head;
}

// Active search + quick-filter applied to the room list (not the all-rooms
// standing summary / matrix grid, which stay a full overview).
function visibleRooms() {
    const q = ctx.els.filterInput.value.trim().toLowerCase();
    const mode = ctx.els.filterMode.value;
    const canPost = room => {
        const c = room.caps.find(x => x.key === 'm.room.message');
        return c ? c.can : true;
    };
    return ctx.rooms.filter(room => {
        if (q) {
            const hay = `${room.name || ''} ${room.alias || ''} ${room.roomId}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        switch (mode) {
            case 'admin': return room.myLevel === Infinity || room.myLevel >= 100;
            case 'mod': return room.myLevel === Infinity || room.myLevel >= 50;
            case 'cantpost': return !canPost(room);
            case 'spaces': return room.roomType === 'm.space';
            default: return true;
        }
    });
}

// Room list: a collapsed <details> accordion per room. The summary carries the
// header, badges, and an inline power bar; the body holds the capabilities.
export function renderRoomList() {
    const { roomListEl, filterCount } = ctx.els;
    roomListEl.replaceChildren();
    const shown = visibleRooms();
    const total = ctx.rooms.length;
    filterCount.textContent = shown.length === total
        ? `${total} room${total === 1 ? '' : 's'}`
        : `${shown.length} of ${total} rooms`;

    for (const room of shown) {
        const card = document.createElement('details');
        card.className = 'room-card';

        const summary = document.createElement('summary');
        summary.append(roomHeader(room));
        summary.append(powerBar(room.myLevel));
        card.append(summary);

        const body = document.createElement('div');
        body.className = 'room-body';
        card.append(body);

        if (room.error) {
            const warn = document.createElement('p');
            warn.className = 'room-note warn';
            warn.textContent = `Could not fully read this room: ${room.error}`;
            body.append(warn);
        }
        if (room.v12plus && !room.privilegedCreator && !room.foundingCreatorKnown) {
            const note = document.createElement('p');
            note.className = 'room-note';
            note.textContent = 'ℹ Room version 12+: a founding creator has unlimited power. The creator could not be confirmed for this room, so your standing may be understated if you created it.';
            body.append(note);
        }

        for (const category of CATEGORIES) {
            const caps = room.caps.filter(c => c.cat === category.key);
            if (caps.length === 0) continue;

            const h = document.createElement('h4');
            h.className = 'cap-cat';
            h.textContent = category.label;
            body.append(h);

            const ul = document.createElement('ul');
            ul.className = 'cap-list';
            for (const c of caps) {
                const li = document.createElement('li');
                li.className = c.can ? 'cap can' : 'cap cannot';

                const glyph = document.createElement('span');
                glyph.className = 'cap-glyph';
                glyph.textContent = c.can ? '✓' : '✗';

                const label = document.createElement('span');
                label.className = 'cap-label';
                label.textContent = c.label;

                const meta = document.createElement('span');
                meta.className = 'cap-meta';
                meta.textContent = `${formatLevel(room.myLevel)} / ${c.required}`;
                if (c.usesDefault) {
                    const def = document.createElement('span');
                    def.className = 'cap-default';
                    def.textContent = 'default';
                    meta.append(' ', def);
                }

                li.append(glyph, label, meta);
                ul.append(li);
            }
            body.append(ul);
        }
        roomListEl.append(card);
    }

    loadAvatars();
}

// Lazily load room avatars in the background (bounded concurrency). Results are
// cached by mxc so re-renders (e.g. filtering) don't refetch. Failures leave
// the initial-letter fallback in place.
function loadAvatars() {
    const pending = Array.from(ctx.els.roomListEl.querySelectorAll('.room-avatar[data-mxc]'));
    let i = 0;
    async function worker() {
        while (i < pending.length) {
            const span = pending[i++];
            const mxc = span.dataset.mxc;
            delete span.dataset.mxc;
            if (ctx.avatarCache.has(mxc)) {
                const cached = ctx.avatarCache.get(mxc);
                if (cached) setAvatarImage(span, cached);
                continue;
            }
            const dataUrl = await fetchAvatarDataUrl(mxc).catch(() => '');
            ctx.avatarCache.set(mxc, dataUrl);
            if (dataUrl) setAvatarImage(span, dataUrl);
        }
    }
    const lanes = Math.min(4, pending.length);
    for (let n = 0; n < lanes; n++) worker();
}

async function fetchAvatarDataUrl(mxc) {
    for (const url of thumbnailEndpoints(mxc, ctx.homeserver(), 64)) {
        try {
            const res = await ctx.authedFetch(url);
            if (!res.ok) continue;
            const blob = await res.blob();
            if (!blob.type.startsWith('image/')) continue;
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            if (err.message === 'Session expired') throw err;
        }
    }
    return '';
}

// CSV export of the full matrix (all rooms × all capabilities + metadata). Not
// affected by privacy mode: it's a file the user downloads, not the shared page.
export function handleExport() {
    if (ctx.rooms.length === 0) return;
    const headers = ['Room ID', 'Name', 'Alias', 'Version', 'Type', 'Encrypted', 'My power level'];
    for (const c of CAPABILITIES) headers.push(c.label);

    const esc = v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [headers.map(esc).join(',')];
    for (const room of ctx.rooms) {
        const row = [
            room.roomId,
            room.name || '',
            room.alias || '',
            room.version,
            room.roomType || 'room',
            room.encrypted ? 'yes' : 'no',
            room.myLevel === Infinity ? 'creator' : room.myLevel
        ];
        for (const cap of CAPABILITIES) {
            const c = room.caps.find(x => x.key === cap.key);
            row.push(!c ? 'n/a' : (c.can ? 'yes' : 'no'));
        }
        lines.push(row.map(esc).join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'room-permissions.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// Rooms × key-permissions grid (inside the collapsed details section).
export function renderMatrix() {
    const panel = ctx.els.matrixBody;
    panel.replaceChildren();

    const cols = GRID_KEYS.map(key => CAPABILITIES.find(c => c.key === key)).filter(Boolean);

    const scroller = document.createElement('div');
    scroller.className = 'grid-scroll';
    const table = document.createElement('table');
    table.className = 'perm-grid';

    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'grid-room-col';
    corner.textContent = 'Room';
    hrow.append(corner);
    const lvlTh = document.createElement('th');
    lvlTh.textContent = 'Power';
    hrow.append(lvlTh);
    for (const col of cols) {
        const th = document.createElement('th');
        th.textContent = col.label;
        hrow.append(th);
    }
    thead.append(hrow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const room of ctx.rooms) {
        const tr = document.createElement('tr');
        const rh = document.createElement('th');
        rh.className = 'grid-room-col';
        rh.scope = 'row';
        rh.textContent = roomLabel(room);
        if (!ctx.redact) rh.title = room.roomId;
        tr.append(rh);

        const lvlTd = document.createElement('td');
        lvlTd.className = 'grid-level';
        lvlTd.textContent = formatLevel(room.myLevel);
        tr.append(lvlTd);

        for (const col of cols) {
            const c = room.caps.find(x => x.key === col.key);
            const td = document.createElement('td');
            td.className = c && c.can ? 'cell can' : 'cell cannot';
            td.textContent = c && c.can ? '✓' : '✗';
            if (c) td.title = `${formatLevel(room.myLevel)} / ${c.required}${c.usesDefault ? ' (default)' : ''}`;
            tr.append(td);
        }
        tbody.append(tr);
    }
    table.append(tbody);
    scroller.append(table);
    panel.append(scroller);
}

// Aggregate standing across all rooms, shown as a header above the list.
export function renderStanding() {
    const panel = ctx.els.standingSummary;
    panel.replaceChildren();

    const buckets = [
        { label: 'Creator (∞ power)', test: r => r.myLevel === Infinity },
        { label: 'Admin (100+)', test: r => r.myLevel !== Infinity && r.myLevel >= 100 },
        { label: 'Moderator (50–99)', test: r => r.myLevel >= 50 && r.myLevel < 100 },
        { label: 'Member (1–49)', test: r => r.myLevel >= 1 && r.myLevel < 50 },
        { label: 'Default (0)', test: r => r.myLevel <= 0 }
    ];
    const counts = buckets.map(b => ({ label: b.label, n: ctx.rooms.filter(b.test).length })).filter(b => b.n > 0);
    const maxCount = Math.max(1, ...counts.map(b => b.n));

    const summary = document.createElement('div');
    summary.className = 'chart-summary';
    const sh = document.createElement('h4');
    sh.className = 'cap-cat';
    sh.textContent = `Standing across ${ctx.rooms.length} room${ctx.rooms.length === 1 ? '' : 's'}`;
    summary.append(sh);
    for (const b of counts) {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const lab = document.createElement('span');
        lab.className = 'bar-label';
        lab.textContent = b.label;
        const track = document.createElement('span');
        track.className = 'bar-track';
        const fill = document.createElement('span');
        fill.className = 'bar-fill';
        fill.style.width = `${Math.round((b.n / maxCount) * 100)}%`;
        track.append(fill);
        const val = document.createElement('span');
        val.className = 'bar-value';
        val.textContent = String(b.n);
        row.append(lab, track, val);
        summary.append(row);
    }
    panel.append(summary);
}
