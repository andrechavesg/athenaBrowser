/**
 * Plugins/AutoBattle/AutoBattle.js
 *
 * AutoBattle plugin — initialises a floating HUD panel via vanilla DOM/CSS,
 * with no dependency on GUIComponent or UIManager.
 *
 * Usage (plugin convention):
 *   import AutoBattle from 'Plugins/AutoBattle/AutoBattle.js';
 *   AutoBattle();
 *
 * This file is part of the roBrowserLegacy private fork.
 */
import Session       from 'Engine/SessionStorage.js';
import Entity        from 'Renderer/Entity/Entity.js';
import EntityManager from 'Renderer/EntityManager.js';
import MapRenderer   from 'Renderer/MapRenderer.js';
import Network       from 'Network/NetworkManager.js';
import PACKET        from 'Network/PacketStructure.js';
import PACKETVER     from 'Network/PacketVerManager.js';
import DB            from 'DB/DBManager.js';
import PathFinding   from 'Utils/PathFinding.js';

// ── module-level state ────────────────────────────────────────────────────────
let _active      = false;
let _targetClass = 0;   // 0 = any mob
let _intervalId  = null;
let _root        = null; // the injected container div

const TICK_MS   = 600;
const MAX_RANGE = 14;  // cells

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns null when `name` appears to be a garbled EUC-KR/windows-949 string
 * that was decoded as windows-1252 (latin1).  Such strings contain a high ratio
 * of characters in the 0x80–0xFF range that form non-sensical latin sequences.
 *
 * Heuristic: if more than 30 % of codepoints are outside printable ASCII (0x20–
 * 0x7E) the string is considered garbled and null is returned so callers can
 * fall back to the English MonsterNameTable.
 */
function _sanitizeName(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed || trimmed === 'Unknown') return null;
    let nonAscii = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed.charCodeAt(i);
        if (c < 0x20 || c > 0x7E) nonAscii++;
    }
    if (nonAscii / trimmed.length > 0.30) return null;
    return trimmed;
}

function _sendAttack(target) {
    const player = Session.Entity;
    if (!player || !player.position) return;

    let atkPkt;
    if (PACKETVER.value >= 20180307) {
        atkPkt = new PACKET.CZ.REQUEST_ACT2();
    } else {
        atkPkt = new PACKET.CZ.REQUEST_ACT();
    }
    atkPkt.action    = 7;
    atkPkt.targetGID = target.GID;

    player.lookTo(target.position[0], target.position[1]);
    let dirPkt;
    if (PACKETVER.value >= 20180307) {
        dirPkt = new PACKET.CZ.CHANGE_DIRECTION2();
    } else {
        dirPkt = new PACKET.CZ.CHANGE_DIRECTION();
    }
    dirPkt.headDir = player.headDir;
    dirPkt.dir     = player.direction;
    Network.sendPacket(dirPkt);

    const range = (player.attack_range || 1) + 1;
    const out   = [];
    const count = PathFinding.search(
        player.position[0] | 0,
        player.position[1] | 0,
        target.position[0] | 0,
        target.position[1] | 0,
        range,
        out
    );

    console.log('[AutoBattle] sendAttack: range='+range+' pathCount='+count+
        ' player=('+player.position[0]+'|0,'+player.position[1]+'|0)'+
        ' target=('+target.position[0]+','+target.position[1]+')');

    if (!count) {
        console.warn('[AutoBattle] sendAttack: PathFinding returned 0 (no path)');
        return;
    }

    if (count < 2) {
        console.log('[AutoBattle] sendAttack: in range → sending attack packet');
        Network.sendPacket(atkPkt);
        return;
    }

    console.log('[AutoBattle] sendAttack: out of range → walking to (' +
        out[(count-1)*2] + ',' + out[(count-1)*2+1] + '), queuing attack');
    Session.moveAction = atkPkt;

    let movePkt;
    if (PACKETVER.value >= 20180307) {
        movePkt = new PACKET.CZ.REQUEST_MOVE2();
    } else {
        movePkt = new PACKET.CZ.REQUEST_MOVE();
    }
    movePkt.dest[0] = out[(count - 1) * 2 + 0];
    movePkt.dest[1] = out[(count - 1) * 2 + 1];
    Network.sendPacket(movePkt);
}

function _getNearbyMobs() {
    const player = Session.Entity;
    if (!player || !player.position) return [];

    const px      = player.position[0];
    const py      = player.position[1];
    const rangeSq = MAX_RANGE * MAX_RANGE;
    const mobs    = [];

    EntityManager.forEach(function (e) {
        if (
            e.objecttype !== Entity.TYPE_MOB ||
            e.action === e.ACTION.DIE ||
            e.remove_tick !== 0
        ) return;

        const dx = e.position[0] - px;
        const dy = e.position[1] - py;
        if (dx * dx + dy * dy > rangeSq) return;

        mobs.push(e);
    });

    return mobs;
}

function _findTarget() {
    const mobs = _getNearbyMobs();
    if (!mobs.length) return null;

    let candidates = mobs;
    if (_targetClass > 0) {
        candidates = mobs.filter(m => m.job === _targetClass);
        if (!candidates.length) return null;
    }

    const player = Session.Entity;
    const px = player.position[0];
    const py = player.position[1];

    return candidates.reduce((best, m) => {
        const dx  = m.position[0] - px,    dy  = m.position[1] - py;
        const bdx = best.position[0] - px, bdy = best.position[1] - py;
        return (dx * dx + dy * dy) < (bdx * bdx + bdy * bdy) ? m : best;
    });
}

function _tick() {
    if (!_active) return;
    const player = Session.Entity;
    if (!player || !player.position) {
        console.warn('[AutoBattle] tick: no player entity or position');
        return;
    }
    const target = _findTarget();
    if (!target) return;
    console.log('[AutoBattle] tick → attack GID', target.GID, 'job', target.job,
        'pos', target.position[0], target.position[1]);
    _sendAttack(target);
}

// ── map mob list helpers ──────────────────────────────────────────────────────
function _getCurrentMapName() {
    try {
        return (MapRenderer.currentMap || '').replace(/\.gat$/i, '');
    } catch (_) { return ''; }
}

function _getMobListForMap() {
    const mapName = _getCurrentMapName();
    const byClass = {};

    const naviMobs = DB.getNaviMobTable ? DB.getNaviMobTable() : [];
    for (let i = 0; i < naviMobs.length; i++) {
        const entry = naviMobs[i];
        if (!Array.isArray(entry) || entry.length < 5) continue;
        const entryMap = String(entry[0]).replace(/\.gat$/i, '');
        if (mapName && entryMap !== mapName) continue;
        const classId = Number(entry[3]);
        if (!classId) continue;
        if (!byClass[classId]) {
            // Always prefer English MonsterNameTable; use NaviMobTable name only
            // as a last resort — NaviMobTable names are Korean (EUC-KR) and come
            // out garbled when the charpage is windows-1252.
            const tableName = DB.getMonsterName(classId);
            const naviName  = _sanitizeName(String(entry[4] || ''));
            const name = (tableName !== 'Unknown') ? tableName
                       : naviName                  ? naviName
                       : ('Monster #' + classId);
            byClass[classId] = { classId, name, mapCount: 0, visibleCount: 0 };
        }
        byClass[classId].mapCount++;
    }

    const visible = _getNearbyMobs();
    visible.forEach(function (m) {
        if (!byClass[m.job]) {
            const tableName = DB.getMonsterName(m.job);
            const dispName  = (m.display && m.display.name) ? _sanitizeName(String(m.display.name)) : null;
            const name = (tableName !== 'Unknown') ? tableName
                       : dispName                  ? dispName
                       : ('Monster #' + m.job);
            byClass[m.job] = { classId: m.job, name, mapCount: 0, visibleCount: 0 };
        }
        byClass[m.job].visibleCount++;
    });

    return Object.values(byClass);
}

// ── vanilla DOM panel ─────────────────────────────────────────────────────────
const CSS = `
#ab-host {
    position: fixed;
    bottom: 8px;
    right: 8px;
    z-index: 9000;
    font-family: Tahoma, Arial, sans-serif;
    font-size: 12px;
    pointer-events: none;
}
#ab-host * { box-sizing: border-box; }

#ab-toggle {
    pointer-events: all;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid #4a6a9a;
    background: linear-gradient(180deg, rgba(20,45,90,0.92) 0%, rgba(10,25,55,0.92) 100%);
    color: #b8d4ff;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    transition: background 0.15s, border-color 0.15s;
    letter-spacing: 0.4px;
}
#ab-toggle:hover { border-color: #7aa8e0; filter: brightness(1.15); }
#ab-toggle.ab-active {
    border-color: #e07030;
    background: linear-gradient(180deg, rgba(90,35,10,0.95) 0%, rgba(60,20,5,0.95) 100%);
    color: #ffcc88;
    box-shadow: 0 2px 10px rgba(200,80,20,0.45);
}
#ab-toggle .ab-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4a6a9a;
    transition: background 0.15s;
}
#ab-toggle.ab-active .ab-dot { background: #ff7030; box-shadow: 0 0 4px #ff7030; }

#ab-panel {
    pointer-events: all;
    position: absolute;
    bottom: 34px;
    right: 0;
    width: 260px;
    border-radius: 8px;
    border: 1px solid #4a6a9a;
    background: rgba(8,18,40,0.97);
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    padding: 8px;
    display: none;
}
#ab-panel.ab-panel-open { display: block; }

#ab-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #88aadd;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    margin-bottom: 6px;
    padding-bottom: 5px;
    border-bottom: 1px solid rgba(74,106,154,0.4);
    text-transform: uppercase;
}
#ab-close-panel { cursor: pointer; color: #7090c0; font-size: 14px; line-height: 1; }
#ab-close-panel:hover { color: #b0c8f0; }

#ab-target-label {
    color: #7090c0; font-size: 10px; font-weight: 700;
    letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 4px;
}
#ab-current-target {
    color: #c0d8ff; font-size: 11px; font-weight: 600;
    margin-bottom: 8px; padding: 4px 6px;
    border-radius: 4px; background: rgba(40,70,130,0.35);
}

#ab-mob-list { max-height: 180px; overflow-y: auto; margin-bottom: 8px; }
#ab-mob-list::-webkit-scrollbar { width: 4px; }
#ab-mob-list::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 2px; }
#ab-mob-list::-webkit-scrollbar-thumb { background: #3a5a8a; border-radius: 2px; }

.ab-mob-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 5px; border-radius: 4px; margin-bottom: 2px;
    background: rgba(20,45,90,0.35); border: 1px solid transparent;
    transition: background 0.1s, border-color 0.1s;
}
.ab-mob-row:hover { background: rgba(40,70,140,0.5); border-color: #4a6a9a; }
.ab-mob-row.ab-row-selected { background: rgba(80,40,10,0.5); border-color: #e07030; }

.ab-mob-id  { color: #6080b0; font-size: 9px; font-weight: 600; min-width: 30px; text-align: center; }
.ab-mob-name { color: #c0d8ff; font-size: 11px; font-weight: 600; flex: 1; }
.ab-mob-count { color: #7090c0; font-size: 10px; min-width: 20px; text-align: right; }
.ab-mob-select {
    cursor: pointer; padding: 2px 6px; border-radius: 3px;
    border: 1px solid #3a5a8a; background: rgba(30,60,120,0.6);
    color: #88aadd; font-size: 10px; font-weight: 700;
}
.ab-mob-select:hover { background: rgba(60,100,180,0.7); border-color: #6a9acb; color: #c0d8ff; }
.ab-mob-row.ab-row-selected .ab-mob-select {
    background: rgba(100,40,5,0.7); border-color: #c05020; color: #ffbb66;
}
#ab-any-row { margin-bottom: 6px; }
#ab-no-mobs { color: #5070a0; font-size: 10px; text-align: center; padding: 8px 0; display: none; }

#ab-refresh-btn {
    width: 100%; padding: 4px 0; border-radius: 4px;
    border: 1px solid #3a5a8a; background: rgba(20,45,90,0.6);
    color: #7090c0; font-size: 10px; font-weight: 700;
    letter-spacing: 0.4px; cursor: pointer; text-transform: uppercase;
}
#ab-refresh-btn:hover { background: rgba(40,75,140,0.7); color: #b0c8f0; border-color: #5a8abc; }

.ab-start-any-btn {
    width: 100%; padding: 5px 0; border-radius: 4px;
    border: 1px solid #5a8a3a; background: rgba(20,60,20,0.7);
    color: #88dd88; font-size: 11px; font-weight: 700;
    letter-spacing: 0.4px; cursor: pointer; margin-bottom: 4px;
}
.ab-start-any-btn:hover { background: rgba(40,100,40,0.8); color: #aaffaa; border-color: #7ab85a; }
`;

function _buildDOM() {
    // Inject stylesheet once
    if (!document.getElementById('ab-style')) {
        const style = document.createElement('style');
        style.id = 'ab-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const host = document.createElement('div');
    host.id = 'ab-host';
    host.innerHTML = `
        <div id="ab-panel">
            <div id="ab-panel-header">
                <span>Auto Battle</span>
                <span id="ab-close-panel" title="Close">✕</span>
            </div>
            <div id="ab-target-label">Target</div>
            <div id="ab-current-target">Any monster</div>
            <div id="ab-mob-list">
                <div class="ab-mob-row ab-row-selected" id="ab-any-row" data-class="0">
                    <div class="ab-mob-id">—</div>
                    <div class="ab-mob-name">Any Monster</div>
                    <div class="ab-mob-count"></div>
                    <div class="ab-mob-select" data-class="0">✓ Select</div>
                </div>
            </div>
            <div id="ab-no-mobs">No monsters nearby</div>
            <button id="ab-refresh-btn">↻ Refresh List</button>
        </div>
        <div id="ab-toggle">
            <span class="ab-dot"></span>
            <span id="ab-label">Auto Battle</span>
        </div>
    `;
    document.body.appendChild(host);
    return host;
}

// ── UI event wiring ───────────────────────────────────────────────────────────
function _wireEvents(root) {
    const toggle    = root.querySelector('#ab-toggle');
    const panel     = root.querySelector('#ab-panel');
    const closeBtn  = root.querySelector('#ab-close-panel');
    const refreshBtn= root.querySelector('#ab-refresh-btn');

    toggle.addEventListener('click', function (e) {
        if (e.target === toggle || e.target.classList.contains('ab-dot') || e.target.id === 'ab-label') {
            if (_active) {
                _toggleActive(root);
            } else if (_targetClass > 0) {
                _toggleActive(root);
            } else {
                panel.classList.add('ab-panel-open');
                _refreshList(root);
            }
        }
    });

    toggle.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        panel.classList.toggle('ab-panel-open');
        if (panel.classList.contains('ab-panel-open')) {
            _refreshList(root);
        }
    });

    closeBtn.addEventListener('click', function () {
        panel.classList.remove('ab-panel-open');
    });

    refreshBtn.addEventListener('click', function () { _refreshList(root); });
}

function _toggleActive(root) {
    _active = !_active;
    const toggle = root.querySelector('#ab-toggle');
    const label  = root.querySelector('#ab-label');
    if (_active) {
        toggle.classList.add('ab-active');
        label.textContent = 'Auto Battle ON';
        if (!_intervalId) {
            _intervalId = setInterval(_tick, TICK_MS);
        }
    } else {
        toggle.classList.remove('ab-active');
        label.textContent = 'Auto Battle';
        if (_intervalId) {
            clearInterval(_intervalId);
            _intervalId = null;
        }
    }
}

function _setTarget(classId, name, root) {
    _targetClass = classId;
    const cur = root.querySelector('#ab-current-target');
    if (cur) cur.textContent = name;
    _refreshSelectedRow(root);
}

function _refreshSelectedRow(root) {
    root.querySelectorAll('.ab-mob-row').forEach(function (row) {
        const cls = parseInt(row.dataset.class || '0', 10);
        const btn = row.querySelector('.ab-mob-select');
        if (cls === _targetClass) {
            row.classList.add('ab-row-selected');
            if (btn) btn.textContent = '✓ Select';
        } else {
            row.classList.remove('ab-row-selected');
            if (btn) btn.textContent = 'Select';
        }
    });
}

function _refreshList(root) {
    const list   = root.querySelector('#ab-mob-list');
    const noMobs = root.querySelector('#ab-no-mobs');
    const panel  = root.querySelector('#ab-panel');
    if (!list) return;

    const classes = _getMobListForMap();

    Array.from(list.children).forEach(function (child) {
        if (child.id !== 'ab-any-row') child.remove();
    });

    if (classes.length === 0) {
        noMobs.style.display = 'block';
    } else {
        noMobs.style.display = 'none';
        classes.sort(function (a, b) { return a.name.localeCompare(b.name); });
        classes.forEach(function (info) {
            const row = document.createElement('div');
            row.className = 'ab-mob-row';
            row.dataset.class = String(info.classId);
            const vis = Math.max(0, info.visibleCount);
            const tot = Math.max(0, info.mapCount);
            const countLabel = tot > 0
                ? (vis + ' / ' + tot)
                : (vis > 0 ? '~' + vis : '?');
            row.innerHTML =
                '<div class="ab-mob-id">#' + info.classId + '</div>' +
                '<div class="ab-mob-name">' + _esc(info.name) + '</div>' +
                '<div class="ab-mob-count">' + countLabel + '</div>' +
                '<div class="ab-mob-select" data-class="' + info.classId + '">Select</div>';
            list.appendChild(row);
        });
    }

    list.querySelectorAll('.ab-mob-select').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const cls  = parseInt(btn.dataset.class || '0', 10);
            const name = cls === 0 ? 'Any Monster' : DB.getMonsterName(cls);
            _setTarget(cls, name, root);
            if (cls > 0) {
                panel.classList.remove('ab-panel-open');
                if (!_active) _toggleActive(root);
            }
        });
    });

    _refreshSelectedRow(root);

    if (!root.querySelector('#ab-start-any-btn')) {
        const startAnyBtn = document.createElement('button');
        startAnyBtn.id = 'ab-start-any-btn';
        startAnyBtn.className = 'ab-start-any-btn';
        startAnyBtn.textContent = '▶ Start (Any Monster)';
        startAnyBtn.addEventListener('click', function () {
            _setTarget(0, 'Any Monster', root);
            panel.classList.remove('ab-panel-open');
            if (!_active) _toggleActive(root);
        });
        const refreshBtn = root.querySelector('#ab-refresh-btn');
        refreshBtn.parentNode.insertBefore(startAnyBtn, refreshBtn);
    }
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── plugin entry point ────────────────────────────────────────────────────────
export default function Init() {
    if (_root) return; // already initialised
    _root = _buildDOM();
    _wireEvents(_root);
}
