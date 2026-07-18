/**
 * Plugins/AutoWalk/AutoWalk.js
 *
 * AutoWalk plugin — a self-contained floating HUD panel (vanilla DOM/CSS,
 * no UIManager dependency) that walks the player automatically in two modes:
 *
 *   • Random   — wanders the current map using the same shuffle-direction
 *                logic as AutoBattle._wander(), but without attacking anything.
 *   • Waypoints — user clicks the map to record a sequence of map coordinates;
 *                 the character walks through them in order, looping forever.
 *
 * Waypoint capture relies on the fact that MapRenderer sets Mouse.world.{x,y}
 * every render frame via Altitude.intersect().  We add a mouseup listener on
 * the game canvas; when waypoint-capture mode is active the current Mouse.world
 * values give us the hovered map cell at the moment the button was released.
 *
 * Usage (plugin convention):
 *   import AutoWalk from 'Plugins/AutoWalk/AutoWalk.js';
 *   AutoWalk();   // called on every map load; safe to call multiple times
 *
 * Map-change hook (call from MapEngine):
 *   import { onMapChange as AutoWalkMapChange } from 'Plugins/AutoWalk/AutoWalk.js';
 *   AutoWalkMapChange();  // clears waypoints, resets index
 *
 * This file is part of the roBrowserLegacy private fork.
 */
import Session  from 'Engine/SessionStorage.js';
import Network  from 'Network/NetworkManager.js';
import PACKET   from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Altitude from 'Renderer/Map/Altitude.js';
import Renderer from 'Renderer/Renderer.js';
import Mouse    from 'Controls/MouseEventHandler.js';

// ── module-level state ────────────────────────────────────────────────────────
let _root          = null;
let _active        = false;
let _mode          = 'random';    // 'random' | 'waypoint'
let _waypoints     = [];          // Array of {x, y}
let _waypointIdx   = 0;
let _addingWP      = false;       // true = next canvas mouseup adds a waypoint
let _walkCooldown  = 0;
let _lastWanderPos = null;
let _intervalId    = null;

const TICK_MS        = 600;
const WANDER_STEP    = 3;
const WANDER_COOL_MS = 1500;
const WAYPOINT_REACH = 3;  // Manhattan distance threshold to "arrive" at waypoint

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when cell (x, y) is walkable according to the loaded GAT data.
 * Falls back to a permissive bounds-only check when Altitude isn't ready yet.
 */
function _isCellWalkable(x, y) {
    try {
        const cellType = Altitude.getCellType(x, y);
        if (cellType === undefined || cellType === null) {
            return x > 0 && y > 0 && x < 512 && y < 512;
        }
        return !!(cellType & Altitude.TYPE.WALKABLE);
    } catch (_) {
        return x > 0 && y > 0 && x < 512 && y < 512;
    }
}

/** Send a REQUEST_MOVE (or REQUEST_MOVE2) packet to (nx, ny). */
function _sendMove(nx, ny) {
    let pkt;
    if (PACKETVER.value >= 20180307) {
        pkt = new PACKET.CZ.REQUEST_MOVE2();
    } else {
        pkt = new PACKET.CZ.REQUEST_MOVE();
    }
    pkt.dest[0] = nx;
    pkt.dest[1] = ny;
    Network.sendPacket(pkt);
}

// ── random walk ───────────────────────────────────────────────────────────────

/**
 * Walk one random step — identical to AutoBattle._wander() but without
 * combat, and using our own cooldown/last-pos trackers.
 */
function _randomWalk() {
    const now = Date.now();
    if (now < _walkCooldown) return;

    const player = Session.Entity;
    if (!player || !player.position) return;

    const px = player.position[0] | 0;
    const py = player.position[1] | 0;

    const s = WANDER_STEP;
    const dirs = [
        [ 0,  s], [ 0, -s], [ s,  0], [-s,  0],
        [ s,  s], [-s,  s], [ s, -s], [-s, -s]
    ];

    // Fisher-Yates shuffle
    for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
    }

    for (const [dx, dy] of dirs) {
        const nx = px + dx;
        const ny = py + dy;

        if (!_isCellWalkable(nx, ny)) continue;
        if (_lastWanderPos && _lastWanderPos[0] === nx && _lastWanderPos[1] === ny) continue;

        _sendMove(nx, ny);
        _lastWanderPos = [nx, ny];
        _walkCooldown  = now + WANDER_COOL_MS;

        console.log('[AutoWalk] random → (' + nx + ',' + ny + ')');
        break;
    }
}

// ── waypoint walk ─────────────────────────────────────────────────────────────

function _waypointWalk() {
    if (_waypoints.length === 0) {
        _randomWalk();
        return;
    }

    const player = Session.Entity;
    if (!player || !player.position) return;

    const target = _waypoints[_waypointIdx];
    const px = player.position[0];
    const py = player.position[1];
    const dist = Math.abs(px - target.x) + Math.abs(py - target.y);

    if (dist < WAYPOINT_REACH) {
        _waypointIdx = (_waypointIdx + 1) % _waypoints.length;
        console.log('[AutoWalk] reached waypoint ' + (_waypointIdx === 0
            ? _waypoints.length - 1 : _waypointIdx - 1) +
            ', advancing to ' + _waypointIdx);
        return;
    }

    const now = Date.now();
    if (now < _walkCooldown) return;

    _sendMove(target.x, target.y);
    _walkCooldown = now + WANDER_COOL_MS;

    console.log('[AutoWalk] waypoint[' + _waypointIdx + '] → (' +
        target.x + ',' + target.y + ') dist=' + dist.toFixed(1));
}

// ── tick ──────────────────────────────────────────────────────────────────────

function _tick() {
    if (!_active) return;
    const player = Session.Entity;
    if (!player || !player.position) {
        console.warn('[AutoWalk] tick: no player entity');
        return;
    }
    if (_mode === 'random') {
        _randomWalk();
    } else {
        _waypointWalk();
    }
}

// ── waypoint capture from canvas mouseup ─────────────────────────────────────

/**
 * Registered on the game canvas once during Init().
 * When _addingWP is true, reads Mouse.world.{x,y} (already set by
 * MapRenderer.onRender → Altitude.intersect) and pushes a new waypoint.
 */
function _onCanvasMouseUp(e) {
    if (!_addingWP) return;
    if (e.button !== 0) return; // left button only

    const wx = Mouse.world.x;
    const wy = Mouse.world.y;

    if (wx < 0 || wy < 0) {
        console.warn('[AutoWalk] waypoint capture: Mouse.world not ready (off-map click?)');
        return;
    }

    const ix = Math.round(wx);
    const iy = Math.round(wy);

    if (!_isCellWalkable(ix, iy)) {
        console.warn('[AutoWalk] waypoint capture: cell (' + ix + ',' + iy + ') is not walkable');
        return;
    }

    _waypoints.push({ x: ix, y: iy });
    console.log('[AutoWalk] added waypoint[' + (_waypoints.length - 1) + '] = (' + ix + ',' + iy + ')');

    if (_root) _refreshWaypointList(_root);
}

// ── DOM panel ─────────────────────────────────────────────────────────────────

const CSS = `
#aw-host {
    position: fixed;
    bottom: 8px;
    right: 100px;
    z-index: 9000;
    font-family: Tahoma, Arial, sans-serif;
    font-size: 12px;
    pointer-events: none;
}
#aw-host * { box-sizing: border-box; }

#aw-toggle {
    pointer-events: all;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid #3a7a4a;
    background: linear-gradient(180deg, rgba(10,40,20,0.92) 0%, rgba(5,20,10,0.92) 100%);
    color: #88ccaa;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    transition: background 0.15s, border-color 0.15s;
    letter-spacing: 0.4px;
}
#aw-toggle:hover { border-color: #5aaa6a; filter: brightness(1.15); }
#aw-toggle.aw-active {
    border-color: #30c060;
    background: linear-gradient(180deg, rgba(10,70,30,0.95) 0%, rgba(5,40,15,0.95) 100%);
    color: #80ff99;
    box-shadow: 0 2px 10px rgba(20,160,60,0.45);
}
#aw-toggle .aw-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #3a7a4a;
    transition: background 0.15s;
}
#aw-toggle.aw-active .aw-dot { background: #30ff70; box-shadow: 0 0 4px #30ff70; }

#aw-panel {
    pointer-events: all;
    position: absolute;
    bottom: 34px;
    right: 0;
    width: 260px;
    border-radius: 8px;
    border: 1px solid #3a7a4a;
    background: rgba(5,15,10,0.97);
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    padding: 8px;
    display: none;
}
#aw-panel.aw-panel-open { display: block; }

.aw-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #55aa77;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    margin-bottom: 8px;
    padding-bottom: 5px;
    border-bottom: 1px solid rgba(58,122,74,0.4);
    text-transform: uppercase;
}
#aw-close { cursor: pointer; color: #3a7a4a; font-size: 14px; line-height: 1; }
#aw-close:hover { color: #80cc99; }

.aw-modes {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
}
.aw-modes button {
    flex: 1;
    padding: 4px 0;
    border-radius: 4px;
    border: 1px solid #2a5a3a;
    background: rgba(10,30,18,0.8);
    color: #5a9a6a;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 0.3px;
    transition: background 0.12s, border-color 0.12s;
}
.aw-modes button:hover { background: rgba(20,60,35,0.9); border-color: #4a8a5a; }
.aw-modes button.aw-mode-active {
    background: rgba(15,80,35,0.9);
    border-color: #30c060;
    color: #80ff99;
}

#aw-waypoint-section { margin-bottom: 8px; }

#aw-waypoint-list {
    max-height: 120px;
    overflow-y: auto;
    margin-bottom: 6px;
}
#aw-waypoint-list::-webkit-scrollbar { width: 4px; }
#aw-waypoint-list::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 2px; }
#aw-waypoint-list::-webkit-scrollbar-thumb { background: #2a5a3a; border-radius: 2px; }

.aw-wp-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 5px;
    border-radius: 3px;
    margin-bottom: 2px;
    background: rgba(10,40,20,0.5);
    border: 1px solid rgba(58,122,74,0.3);
}
.aw-wp-row.aw-wp-current {
    background: rgba(15,70,30,0.7);
    border-color: #30c060;
}
.aw-wp-idx  { color: #3a7a4a; font-size: 9px; min-width: 18px; text-align: center; }
.aw-wp-pos  { color: #88ccaa; font-size: 10px; flex: 1; }
.aw-wp-del  {
    cursor: pointer; color: #7a3a3a; font-size: 12px; line-height: 1;
    padding: 0 3px; border-radius: 2px;
}
.aw-wp-del:hover { color: #ff6666; background: rgba(80,10,10,0.5); }
#aw-wp-empty { color: #2a5a3a; font-size: 10px; text-align: center; padding: 6px 0; }

.aw-btn-row {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
}
.aw-btn-row button {
    flex: 1;
    padding: 4px 0;
    border-radius: 4px;
    border: 1px solid #2a5a3a;
    background: rgba(10,30,18,0.8);
    color: #5a9a6a;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
}
.aw-btn-row button:hover { background: rgba(20,60,35,0.9); border-color: #4a8a5a; }
#aw-add-wp.aw-capturing {
    background: rgba(15,70,35,0.9);
    border-color: #30ff70;
    color: #80ff99;
    animation: aw-blink 0.8s step-start infinite;
}
@keyframes aw-blink { 50% { opacity: 0.5; } }

#aw-start {
    width: 100%;
    padding: 5px 0;
    border-radius: 4px;
    border: 1px solid #2a7a3a;
    background: rgba(10,50,20,0.8);
    color: #55cc77;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.4px;
    cursor: pointer;
}
#aw-start:hover { background: rgba(20,80,35,0.9); border-color: #40aa55; color: #88ffaa; }
#aw-start.aw-running {
    background: rgba(60,15,10,0.9);
    border-color: #c04030;
    color: #ff8877;
}
#aw-start.aw-running:hover { filter: brightness(1.1); }

#aw-route-section {
    margin-top: 8px;
    border-top: 1px solid rgba(58,122,74,0.4);
    padding-top: 6px;
}
.aw-route-map-label {
    color: #3a7a4a;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 5px;
}
.aw-route-bar {
    display: flex;
    gap: 4px;
    margin-bottom: 5px;
}
#aw-route-name {
    flex: 1;
    padding: 3px 5px;
    border-radius: 3px;
    border: 1px solid #2a5a3a;
    background: rgba(10,30,18,0.9);
    color: #88ccaa;
    font-size: 10px;
    outline: none;
}
#aw-route-name::placeholder { color: #2a5a3a; }
#aw-route-name:focus { border-color: #40aa55; }
#aw-save-route {
    padding: 3px 7px;
    border-radius: 3px;
    border: 1px solid #2a5a3a;
    background: rgba(10,50,25,0.9);
    color: #55aa77;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
}
#aw-save-route:hover { border-color: #40aa55; color: #88ffaa; }
#aw-saved-routes {
    max-height: 100px;
    overflow-y: auto;
}
#aw-saved-routes::-webkit-scrollbar { width: 4px; }
#aw-saved-routes::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); border-radius: 2px; }
#aw-saved-routes::-webkit-scrollbar-thumb { background: #2a5a3a; border-radius: 2px; }
.aw-no-routes { color: #2a5a3a; font-size: 10px; text-align: center; padding: 4px 0; }
.aw-route-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 5px;
    border-radius: 3px;
    margin-bottom: 2px;
    background: rgba(10,40,20,0.5);
    border: 1px solid rgba(58,122,74,0.3);
}
.aw-route-name-label { color: #88ccaa; font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aw-route-count { color: #3a7a4a; font-size: 9px; white-space: nowrap; }
.aw-load-btn {
    padding: 1px 5px;
    border-radius: 2px;
    border: 1px solid #2a5a3a;
    background: rgba(10,40,20,0.8);
    color: #55aa77;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
}
.aw-load-btn:hover { border-color: #40aa55; color: #88ffaa; }
.aw-del-btn {
    cursor: pointer;
    color: #7a3a3a;
    font-size: 12px;
    line-height: 1;
    padding: 0 3px;
    border-radius: 2px;
    background: none;
    border: none;
}
.aw-del-btn:hover { color: #ff6666; background: rgba(80,10,10,0.5); }
`;

function _buildDOM() {
    if (!document.getElementById('aw-style')) {
        const style = document.createElement('style');
        style.id = 'aw-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const host = document.createElement('div');
    host.id = 'aw-host';
    host.innerHTML = `
        <div id="aw-panel">
            <div class="aw-header">
                <span>Auto Walk</span>
                <span id="aw-close" title="Close">×</span>
            </div>
            <div class="aw-modes">
                <button id="aw-mode-random"   class="aw-mode-active">Random</button>
                <button id="aw-mode-waypoint">Waypoints</button>
            </div>
            <div id="aw-waypoint-section" style="display:none">
                <div id="aw-waypoint-list">
                    <div id="aw-wp-empty">No waypoints yet</div>
                </div>
                <div class="aw-btn-row">
                    <button id="aw-add-wp">＋ Add (click map)</button>
                    <button id="aw-clear-wp">✕ Clear All</button>
                </div>
                <div id="aw-route-section">
                    <div class="aw-route-map-label" id="aw-route-map-label">Routes for: —</div>
                    <div class="aw-route-bar">
                        <input id="aw-route-name" type="text" placeholder="Route name..." maxlength="30" />
                        <button id="aw-save-route">💾 Save</button>
                    </div>
                    <div id="aw-saved-routes">
                        <div class="aw-no-routes">No saved routes for this map</div>
                    </div>
                </div>
            </div>
            <button id="aw-start">▶ Start</button>
        </div>
        <div id="aw-toggle">
            <span class="aw-dot"></span>
            <span id="aw-label">Auto Walk</span>
        </div>
    `;
    document.body.appendChild(host);
    return host;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── route persistence (localStorage) ─────────────────────────────────────────

const STORAGE_KEY = 'aw_routes';

function _loadAllRoutes() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (e) { return {}; }
}

function _saveAllRoutes(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function _getMapName() {
    try {
        // MapRenderer.currentMap is set by the engine when a map loads
        if (window.MapRenderer && MapRenderer.currentMap) return MapRenderer.currentMap;
    } catch (e) {}
    return 'unknown';
}

function _saveRoute(name) {
    if (!name || !_waypoints.length) return;
    const all = _loadAllRoutes();
    const map = _getMapName();
    if (!all[map]) all[map] = {};
    all[map][name] = _waypoints.map(function (wp) { return { x: wp.x, y: wp.y }; });
    _saveAllRoutes(all);
    _refreshSavedRoutesList(_root);
}

function _loadRoute(name) {
    const all = _loadAllRoutes();
    const map = _getMapName();
    const route = all[map] && all[map][name];
    if (!route) return;
    _waypoints    = route.map(function (wp) { return { x: wp.x, y: wp.y }; });
    _waypointIdx  = 0;
    if (_root) _refreshWaypointList(_root);
}

function _deleteRoute(name) {
    if (!confirm('Delete route "' + name + '"?')) return;
    const all = _loadAllRoutes();
    const map = _getMapName();
    if (all[map]) {
        delete all[map][name];
        if (Object.keys(all[map]).length === 0) delete all[map];
    }
    _saveAllRoutes(all);
    _refreshSavedRoutesList(_root);
}

function _refreshSavedRoutesList(root) {
    if (!root) return;
    const container = root.querySelector('#aw-saved-routes');
    const mapLabel  = root.querySelector('#aw-route-map-label');
    if (!container) return;

    const map       = _getMapName();
    const all       = _loadAllRoutes();
    const mapRoutes = (all[map] && Object.keys(all[map])) || [];

    if (mapLabel) {
        mapLabel.textContent = 'Routes for: ' + (map === 'unknown' ? '—' : map);
    }

    if (mapRoutes.length === 0) {
        container.innerHTML = '<div class="aw-no-routes">No saved routes for this map</div>';
        return;
    }

    container.innerHTML = mapRoutes.map(function (name) {
        var count = all[map][name].length;
        return '<div class="aw-route-row">' +
            '<span class="aw-route-name-label">' + _esc(name) + '</span>' +
            '<span class="aw-route-count">' + count + ' pts</span>' +
            '<button class="aw-load-btn" data-route="' + _esc(name) + '">Load</button>' +
            '<button class="aw-del-btn" data-route="' + _esc(name) + '">×</button>' +
            '</div>';
    }).join('');

    container.querySelectorAll('.aw-load-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { _loadRoute(btn.dataset.route); });
    });
    container.querySelectorAll('.aw-del-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { _deleteRoute(btn.dataset.route); });
    });
}

function _refreshWaypointList(root) {
    const list  = root.querySelector('#aw-waypoint-list');
    const empty = root.querySelector('#aw-wp-empty');
    if (!list) return;

    // Remove all existing wp rows (keep #aw-wp-empty)
    Array.from(list.children).forEach(function (child) {
        if (child.id !== 'aw-wp-empty') child.remove();
    });

    if (_waypoints.length === 0) {
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    _waypoints.forEach(function (wp, idx) {
        const row = document.createElement('div');
        row.className = 'aw-wp-row' + (idx === _waypointIdx ? ' aw-wp-current' : '');
        row.dataset.idx = String(idx);
        row.innerHTML =
            '<div class="aw-wp-idx">' + (idx + 1) + '</div>' +
            '<div class="aw-wp-pos">(' + wp.x + ', ' + wp.y + ')</div>' +
            '<div class="aw-wp-del" data-idx="' + idx + '" title="Remove">×</div>';
        list.appendChild(row);
    });

    list.querySelectorAll('.aw-wp-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const idx = parseInt(btn.dataset.idx, 10);
            _waypoints.splice(idx, 1);
            if (_waypointIdx >= _waypoints.length) _waypointIdx = 0;
            _refreshWaypointList(root);
        });
    });
}

function _setMode(mode, root) {
    _mode = mode;
    const btnRandom  = root.querySelector('#aw-mode-random');
    const btnWP      = root.querySelector('#aw-mode-waypoint');
    const wpSection  = root.querySelector('#aw-waypoint-section');

    if (mode === 'random') {
        btnRandom.classList.add('aw-mode-active');
        btnWP.classList.remove('aw-mode-active');
        wpSection.style.display = 'none';
        _stopCapture(root);
    } else {
        btnWP.classList.add('aw-mode-active');
        btnRandom.classList.remove('aw-mode-active');
        wpSection.style.display = 'block';
        _refreshWaypointList(root);
        _refreshSavedRoutesList(root);
    }
}

function _startCapture(root) {
    _addingWP = true;
    const btn = root.querySelector('#aw-add-wp');
    if (btn) {
        btn.classList.add('aw-capturing');
        btn.textContent = '● Capturing… (click map)';
    }
}

function _stopCapture(root) {
    _addingWP = false;
    const btn = root.querySelector('#aw-add-wp');
    if (btn) {
        btn.classList.remove('aw-capturing');
        btn.textContent = '＋ Add (click map)';
    }
}

function _toggleActive(root) {
    _active = !_active;
    const toggle  = root.querySelector('#aw-toggle');
    const label   = root.querySelector('#aw-label');
    const startBtn = root.querySelector('#aw-start');

    if (_active) {
        toggle.classList.add('aw-active');
        label.textContent = 'Auto Walk ON';
        if (startBtn) {
            startBtn.classList.add('aw-running');
            startBtn.textContent = '⏹ Stop';
        }
        if (!_intervalId) {
            _intervalId = setInterval(_tick, TICK_MS);
        }
    } else {
        toggle.classList.remove('aw-active');
        label.textContent = 'Auto Walk';
        if (startBtn) {
            startBtn.classList.remove('aw-running');
            startBtn.textContent = '▶ Start';
        }
        if (_intervalId) {
            clearInterval(_intervalId);
            _intervalId = null;
        }
        _stopCapture(root);
    }
}

// ── event wiring ──────────────────────────────────────────────────────────────

function _wireEvents(root) {
    const toggle     = root.querySelector('#aw-toggle');
    const panel      = root.querySelector('#aw-panel');
    const closeBtn   = root.querySelector('#aw-close');
    const startBtn   = root.querySelector('#aw-start');
    const btnRandom  = root.querySelector('#aw-mode-random');
    const btnWP      = root.querySelector('#aw-mode-waypoint');
    const addWPBtn   = root.querySelector('#aw-add-wp');
    const clearWPBtn = root.querySelector('#aw-clear-wp');
    const saveRouteBtn  = root.querySelector('#aw-save-route');
    const routeNameInp  = root.querySelector('#aw-route-name');

    // Toggle button: left-click toggles active, right-click opens panel
    toggle.addEventListener('click', function (e) {
        if (e.target === toggle ||
            e.target.classList.contains('aw-dot') ||
            e.target.id === 'aw-label') {
            if (_active) {
                _toggleActive(root);
            } else {
                panel.classList.add('aw-panel-open');
            }
        }
    });

    toggle.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        panel.classList.toggle('aw-panel-open');
    });

    closeBtn.addEventListener('click', function () {
        panel.classList.remove('aw-panel-open');
    });

    startBtn.addEventListener('click', function () {
        _toggleActive(root);
    });

    btnRandom.addEventListener('click', function () { _setMode('random', root); });
    btnWP.addEventListener('click',     function () { _setMode('waypoint', root); });

    addWPBtn.addEventListener('click', function () {
        if (_addingWP) {
            _stopCapture(root);
        } else {
            _startCapture(root);
        }
    });

    clearWPBtn.addEventListener('click', function () {
        _waypoints = [];
        _waypointIdx = 0;
        _refreshWaypointList(root);
    });

    saveRouteBtn.addEventListener('click', function () {
        const name = routeNameInp.value.trim();
        if (!name) { routeNameInp.focus(); return; }
        if (!_waypoints.length) {
            alert('No waypoints to save.');
            return;
        }
        _saveRoute(name);
        routeNameInp.value = '';
    });

    // Canvas mouseup — used for waypoint coordinate capture.
    // Mouse.world.{x,y} is updated by MapRenderer.onRender on every frame,
    // so at mouseup time it holds the last hovered map cell.
    if (Renderer.canvas) {
        Renderer.canvas.addEventListener('mouseup', _onCanvasMouseUp);
    } else {
        // Renderer might not have a canvas yet at init time; wait for it.
        const _waitForCanvas = setInterval(function () {
            if (Renderer.canvas) {
                Renderer.canvas.addEventListener('mouseup', _onCanvasMouseUp);
                clearInterval(_waitForCanvas);
            }
        }, 500);
    }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Call from MapEngine when the player changes maps.
 * Clears all recorded waypoints (they are map-specific) and resets state.
 */
export function onMapChange() {
    _waypoints   = [];
    _waypointIdx = 0;
    _addingWP    = false;
    _lastWanderPos = null;
    _walkCooldown  = 0;
    if (_root) {
        _refreshWaypointList(_root);
        _refreshSavedRoutesList(_root);
        _stopCapture(_root);
    }
    console.log('[AutoWalk] map changed — waypoints cleared');
}

/**
 * Plugin entry point.  Called by MapEngine on every map load; safe to call
 * multiple times (idempotent after first init).
 */
export default function Init() {
    if (_root) {
        // Already initialised — just reset waypoints for the new map
        onMapChange();
        return;
    }
    _root = _buildDOM();
    _wireEvents(_root);
    console.log('[AutoWalk] initialised');
}
