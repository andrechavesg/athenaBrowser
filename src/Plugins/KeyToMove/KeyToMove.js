/**
 * KeyToMove Plugin
 *
 * Enables the player to control the character movement with the arrow keys.
 *
 * This file is a plugin for ROBrowser, (http://www.robrowser.com/).
 *
 * @author Antares
 * Based on Vincent Thibault's gist: https://gist.github.com/vthibault/9d5c08c111db2eabfc37
 */

import glMatrix  from 'Vendors/gl-matrix.js';
import Session   from 'Engine/SessionStorage.js';
import Network   from 'Network/NetworkManager.js';
import PACKET    from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Camera    from 'Renderer/Camera.js';
import KEYS      from 'Controls/KeyEventHandler.js';

const vec2      = glMatrix.vec2;
const mat2      = glMatrix.mat2;

const MOVE = {
	RIGHT: 	KEYS.RIGHT,
	LEFT: 	KEYS.LEFT,
	UP: 	KEYS.UP,
	DOWN: 	KEYS.DOWN
};

let direction = vec2.create();
let rotate    = mat2.create();
let KeyEvent = {};
let targetPos = [0, 0];
let keysDownTimeout = null;

function processKeyDownEvent( event ) {
	if (event.which === MOVE.RIGHT || event.which === MOVE.LEFT || event.which === MOVE.UP || event.which === MOVE.DOWN) {
		if (document.activeElement.tagName === 'INPUT') return true;
		if (document.querySelector('#NpcMenu, #NpcBox')) return true;
		if(Session.Playing && Session.Entity){
			let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
			if(!(Array.from(gamepads).some(gp => gp?.buttons?.slice(12, 16).some(b => b.pressed)))){
				event.stopImmediatePropagation();
				KeyEvent[event.which] = { pressed: true, continuous: event.originalEvent && event.originalEvent.repeat };
				processKeysDown();
				return false;
			}
		}
		return true;
	}
	return true;
}

function processKeyUpEvent( event ) {
	if (event.which === MOVE.RIGHT || event.which === MOVE.LEFT || event.which === MOVE.UP || event.which === MOVE.DOWN) {
		delete KeyEvent[event.which];
	}
}

function processKeysDown(){
	clearTimeout(keysDownTimeout);
	if(Session.Entity && Object.keys(KeyEvent).length > 0){
		direction[0] = 0;
		direction[1] = 0;
		if( KeyEvent[MOVE.RIGHT] && KeyEvent[MOVE.RIGHT].pressed ) direction[0] += ( KeyEvent[MOVE.RIGHT].continuous ? 3 : 1 );
		if( KeyEvent[MOVE.LEFT] && KeyEvent[MOVE.LEFT].pressed ) direction[0] -= ( KeyEvent[MOVE.LEFT].continuous ? 3 : 1 );
		if( KeyEvent[MOVE.UP] && KeyEvent[MOVE.UP].pressed ) direction[1] += ( KeyEvent[MOVE.UP].continuous ? 3 : 1 );
		if( KeyEvent[MOVE.DOWN] && KeyEvent[MOVE.DOWN].pressed ) direction[1] -= ( KeyEvent[MOVE.DOWN].continuous ? 3 : 1 );
		mat2.identity(rotate);
		mat2.rotate(rotate, rotate, -Camera.direction * 45 / 180 * Math.PI);
		vec2.transformMat2( direction, direction, rotate);
		let newPos = [
			Math.round(Session.Entity.position[0] + direction[0]),
			Math.round(Session.Entity.position[1] + direction[1])
		];
		if( targetPos[0] !== newPos[0] || targetPos[1] !== newPos[1] ){
			targetPos[0] = newPos[0];
			targetPos[1] = newPos[1];
			// PACKETVER >= 20180307 expects CZ.REQUEST_MOVE2 (0x035f).
			// Old CZ.REQUEST_MOVE resolves to shuffled 0x0877 on modern
			// packet tables and the map-server disconnects the session.
			let pkt;
			if (PACKETVER.value >= 20180307) {
				pkt = new PACKET.CZ.REQUEST_MOVE2();
			} else {
				pkt = new PACKET.CZ.REQUEST_MOVE();
			}
			pkt.dest[0] = newPos[0];
			pkt.dest[1] = newPos[1];
			Network.sendPacket(pkt);
		}
		keysDownTimeout = setTimeout(processKeysDown, 100);
	}
}

export default function Init(){
	window.addEventListener('keydown', function( event ){
		processKeyDownEvent({ which: event.which || event.keyCode, stopImmediatePropagation: () => event.stopImmediatePropagation(), originalEvent: event });
	});
	window.addEventListener('keyup', function( event ){
		processKeyUpEvent({ which: event.which || event.keyCode });
	});
	return true;
}
