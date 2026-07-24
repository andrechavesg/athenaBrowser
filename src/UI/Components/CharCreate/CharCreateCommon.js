/**
 * UI/Components/CharCreate/CharCreateCommon.js
 *
 * Shared factory for the Character Creation windows.
 *
 * Collapses the CharCreate version siblings (V0, V2, V3, V4) into a single
 * createCharCreate(config) factory. Each version file passes its own
 * htmlText/cssText plus capability flags describing its real differences:
 *   - V0  : stat-allocation polygon (`hasStats`), single-canvas chargen.
 *   - V2  : single-canvas chargen, fixed stats, no polygon.
 *   - V3  : race/gender model (`hasRace`) with CAP-based hairstyle cycling.
 *   - V4  : race/gender model with the grid hairstyle list (`gridHairstyle`).
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 *
 * @author Vincent Thibault
 */

import DB from 'DB/DBManager.js';
import Renderer from 'Renderer/Renderer.js';
import KEYS from 'Controls/KeyEventHandler.js';
import Entity from 'Renderer/Entity/Entity.js';
import SpriteRenderer from 'Renderer/SpriteRenderer.js';
import Camera from 'Renderer/Camera.js';
import Client from 'Core/Client.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import 'UI/Elements/Elements.js';

const TYPE = {
	RACE: 1,
	GENDER: 2,
	HEAD: 3,
	HEADPALETTE: 4,
	DIRECTION: 5,
	DEFAULT: -1
};

const GENDER = {
	FEMALE: 0,
	MALE: 1
};

const RACE = {
	HUMAN: 0,
	DORAM: 4218
};

const DIRECTION = {
	LEFT: 1,
	RIGHT: -1
};

const VALUE = {
	INCREASE: 1,
	DECREASE: -1
};

const CAP = {
	[RACE.HUMAN]: {
		HEAD: {
			MIN: 1,
			MAX: 29
		},
		HEADPALETTE: {
			MIN: 0,
			MAX: 8
		}
	},
	[RACE.DORAM]: {
		HEAD: {
			MIN: 1,
			MAX: 6
		},
		HEADPALETTE: {
			MIN: 0,
			MAX: 7
		}
	}
};

const RACE_MARK = `${DB.INTERFACE_PATH}make_character/select_mark_cha_create.bmp`;

export function createCharCreate(config) {
	const {
		name,
		htmlText,
		cssText,
		hostHeight = 342,
		hostWidth = 576,
		hasStats = false,
		hasRace = false,
		gridHairstyle = false,
		chargenCanvasSelector = '.content canvas',
		graphCanvasSelector = '.graph canvas',
		statButtonsSelector = '.graph ui-button',
		hairArrows = [],
		humanCanvasSelector = '#canvas_human',
		doramCanvasSelector = '#canvas_doram',
		modelCanvasSelector = '#canvas_model',
		nameInputSelector = 'input',
		nameInputEvent = 'mousedown',
		cancelSelectors = ['.cancel'],
		makeSelector = '.make'
	} = config;

	const Component = new GUIComponent(name, cssText);

	Component.render = () => htmlText;

	/**
	 * @var {number} account sex
	 */
	let _accountSex = 0;

	/**
	 * Legacy (V0/V2) state
	 */
	let _graph;
	const _chargen = {
		entity: new Entity(),
		ctx: null,
		render: false,
		tick: 0
	};

	/**
	 * Race (V3/V4) state
	 */
	const _human = {
		entity: new Entity(),
		ctx: null,
		render: false,
		tick: 0
	};

	const _doram = {
		entity: new Entity(),
		ctx: null,
		render: false,
		tick: 0
	};

	const _model = {
		entity: new Entity(),
		ctx: null,
		render: false,
		tick: 0
	};

	/**
	 * Grid stylist (V4) state
	 */
	let _race = 'human';
	let _gender = 'male';
	let _prevhead = 1;
	let _curhead = 1;
	let _prevcolor = 0;
	let _curcolor = 0;
	let _hairPreviewTick = 0;
	const _hairPreview = {
		entity: new Entity()
	};

	const render = hasRace ? renderRace : renderLegacy;

	/**
	 * Initialize UI
	 */
	Component.init = function init() {
		const root = this.getRoot();

		if (hasRace) {
			_human.ctx = root.querySelector(humanCanvasSelector).getContext('2d');
			_doram.ctx = root.querySelector(doramCanvasSelector).getContext('2d');
			_model.ctx = root.querySelector(modelCanvasSelector).getContext('2d');
		} else {
			_chargen.ctx = root.querySelector(chargenCanvasSelector).getContext('2d');
			if (hasStats) {
				_graph = root.querySelector(graphCanvasSelector).getContext('2d');
			}
		}

		this.draggable();

		if (hasRace) {
			// Update cursor
			root.querySelectorAll('input[type="radio"]').forEach(input => {
				input.classList.add('event_add_cursor');
			});
			root.querySelectorAll('label').forEach(label => {
				label.classList.add('event_add_cursor');
			});

			if (gridHairstyle) {
				initRaceGrid(root);
			} else {
				initRaceCap(root);
			}
		} else {
			hairArrows.forEach(({ selector, type, value }) => {
				root.querySelector(selector).addEventListener('mousedown', updateCharacterGeneric(type, value));
			});

			if (hasStats) {
				root.querySelectorAll(statButtonsSelector).forEach(btn => {
					btn.addEventListener('mousedown', function (event) {
						updateStats.call(this, event);
					});
				});
			}
		}

		const input = root.querySelector(nameInputSelector);
		input.addEventListener(nameInputEvent, event => {
			input.focus();
			event.stopImmediatePropagation();
		});

		cancelSelectors.forEach(selector => {
			root.querySelector(selector).addEventListener('click', cancel);
		});
		root.querySelector(makeSelector).addEventListener('click', create);

		if (hasRace) {
			applyRaceMessages(root);
		}
	};

	/**
	 * Setter for AccountSex
	 *
	 * @param {number} sex
	 */
	Component.setAccountSex = function setAccountSex(sex) {
		_accountSex = sex;
	};

	/**
	 * Once add to HTML, start rendering
	 */
	Component.onAppend = function onAppend() {
		this._host.style.top = `${(Renderer.height - hostHeight) / 2}px`;
		this._host.style.left = `${(Renderer.width - hostWidth) / 2}px`;

		if (hasRace) {
			_human.render = true;
			_human.entity.set({
				sex: _accountSex,
				job: RACE.HUMAN,
				head: 1,
				action: 0,
				direction: 5
			});

			_doram.render = true;
			_doram.entity.set({
				sex: _accountSex,
				job: RACE.DORAM,
				head: 1,
				action: 0,
				direction: 5
			});

			_model.render = true;
			_model.entity.set({
				sex: GENDER.MALE,
				job: RACE.HUMAN,
				head: 1,
				headpalette: 0,
				action: 0,
				direction: 4
			});
		} else {
			_chargen.render = true;
			_chargen.entity.set({
				sex: _accountSex,
				job: 0,
				head: 2,
				action: 0
			});
		}

		const root = this.getRoot();
		const input = root.querySelector(nameInputSelector);
		input.value = '';
		input.focus();

		if (hasRace) {
			if (gridHairstyle) {
				_race = 'human';
				_gender = 'male';
				updateRace();
				cleanup();
			} else {
				setDefault();
			}
		}

		Renderer.render(render);

		if (hasStats) {
			updateGraphic();
		}
	};

	/**
	 * Remove component from HTML
	 * Stop rendering
	 */
	Component.onRemove = function onRemove() {
		Renderer.stop(render);
	};

	/**
	 * Key Handler
	 *
	 * @param {object} event
	 * @return {boolean}
	 */
	Component.onKeyDown = function onKeyDown(event) {
		if ((event.which === KEYS.ESCAPE || event.key === 'Escape') && this._host.style.display !== 'none') {
			event.stopImmediatePropagation();
			cancel();
			return false;
		}

		return true;
	};

	/**
	 * Generic function to get a direct proxy to updateCharacterLegacy
	 *
	 * @param {string} type
	 * @param {number} value
	 */
	function updateCharacterGeneric(type, value) {
		return event => {
			updateCharacterLegacy(type, value);
			event.stopImmediatePropagation();
			return false;
		};
	}

	/**
	 * Send back informations to send the packet
	 */
	function create() {
		const root = Component.getRoot();
		const charname = root.querySelector(nameInputSelector).value;

		let str = 1;
		let agi = 1;
		let vit = 1;
		let int = 1;
		let dex = 1;
		let luk = 1;

		if (hasStats) {
			str = parseInt(root.querySelector('.info .str').textContent, 10);
			agi = parseInt(root.querySelector('.info .agi').textContent, 10);
			vit = parseInt(root.querySelector('.info .vit').textContent, 10);
			int = parseInt(root.querySelector('.info .int').textContent, 10);
			dex = parseInt(root.querySelector('.info .dex').textContent, 10);
			luk = parseInt(root.querySelector('.info .luk').textContent, 10);
		}

		if (hasRace) {
			Component.onCharCreationRequest(
				charname,
				str,
				agi,
				vit,
				int,
				dex,
				luk,
				_model.entity.head,
				_model.entity.headpalette,
				_model.entity.job,
				_model.entity.sex
			);
		} else {
			Component.onCharCreationRequest(
				charname,
				str,
				agi,
				vit,
				int,
				dex,
				luk,
				_chargen.entity.head,
				_chargen.entity.headpalette
			);
		}
	}

	/**
	 * Exit the window
	 */
	function cancel() {
		if (hasRace) {
			if (gridHairstyle) {
				cleanup();
			} else {
				setDefault();
			}
		}
		Component.onExitRequest();
	}

	/* ------------------------------------------------------------------ *
	 * Legacy variant (V0 / V2)
	 * ------------------------------------------------------------------ */

	/**
	 * Update character hairstyle and haircolor
	 *
	 * @param {string} type (head or headpalette)
	 * @param {number} increment (-1 or +1)
	 */
	function updateCharacterLegacy(type, increment) {
		switch (type) {
			case 'head': {
				let head = _chargen.entity.head + increment;

				if (head < 2) {
					head = 26;
				}

				if (head > 26) {
					head = 2;
				}

				_chargen.entity.head = head;
				break;
			}

			case 'headpalette':
				_chargen.entity.headpalette += increment;
				_chargen.entity.headpalette %= 10;
				break;
		}

		render();
	}

	/**
	 * Update the stats and polygon
	 */
	function updateStats() {
		const root = Component.getRoot();

		// Can't be upper than 9
		if (root.querySelector(`.info .${this.className}`).textContent === '9') {
			return;
		}

		// Relation table
		const group = {
			str: 'int',
			int: 'str',
			vit: 'dex',
			dex: 'vit',
			luk: 'agi',
			agi: 'luk'
		};

		// Update infos
		root.querySelector(`.info .${this.className}`).textContent++;
		root.querySelector(`.info .${group[this.className]}`).textContent--;

		updateGraphic();
	}

	/**
	 * Update the polygon
	 */
	function updateGraphic() {
		const root = Component.getRoot();

		// Update graphique.
		const ctx = _graph;
		const width = ctx.canvas.width;
		const height = ctx.canvas.height;
		let i;
		const x = width / 2;
		const y = height / 2;
		const list = ['dex', 'agi', 'str', 'vit', 'luk', 'int'];

		ctx.clearRect(0, 0, width, height);
		ctx.save();
		ctx.fillStyle = '#7b94ce';
		ctx.translate(x, y);
		ctx.beginPath();
		ctx.moveTo(0, Math.floor((y / 10) * (parseInt(root.querySelector(`.info .${list[5]}`).textContent) + 1)));

		for (i = 0; i < 6; i++) {
			ctx.rotate((60 * Math.PI) / 180);
			ctx.lineTo(0, Math.floor((y / 10) * (parseInt(root.querySelector(`.info .${list[i]}`).textContent) + 1)));
		}

		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	/**
	 * Rendering the Character (single canvas, camera rotation)
	 */
	function renderLegacy(tick) {
		// Update direction each 500ms
		if (_chargen.tick + 500 < tick) {
			Camera.direction++;
			Camera.direction %= 8;
			_chargen.tick = tick;
		}

		// Rendering
		SpriteRenderer.bind2DContext(_chargen.ctx, 32, 115);
		_chargen.ctx.clearRect(0, 0, _chargen.ctx.canvas.width, _chargen.ctx.canvas.height);
		_chargen.entity.renderEntity();
	}

	/* ------------------------------------------------------------------ *
	 * Race variant shared (V3 / V4)
	 * ------------------------------------------------------------------ */

	/**
	 * Msgstring Texts
	 */
	function applyRaceMessages(root) {
		const resolveMsg = (msgId, fallbackText) => {
			const value = DB.getMessage(msgId - 1, fallbackText);
			if (typeof value !== 'string') return fallbackText;
			const normalized = value.trim();
			if (
				!normalized ||
				/^NO MSG\s+\d+$/i.test(normalized) ||
				/^no character$/i.test(normalized) ||
				/^empty slot/i.test(normalized)
			) {
				return fallbackText;
			}
			return value;
		};
		if (gridHairstyle) {
			root.querySelector('.title').textContent = resolveMsg(3356, 'Create Character');
			const styleTitle = root.querySelector('.style_title');
			if (styleTitle) {
				styleTitle.textContent = resolveMsg(3349, 'Style');
			}
			root.querySelector('.human_title').textContent = resolveMsg(3017, 'Novice');
			root.querySelector('.human_desc').textContent = resolveMsg(
				3021,
				'Balanced Midgard adventurer. Suitable for all new players.'
			);
			root.querySelector('.doram_title').textContent = resolveMsg(3019, 'Doram');
			root.querySelector('.doram_desc').textContent = resolveMsg(
				3022,
				'Lasagna native focused on spirit-based combat.'
			);
			root.querySelector('.hair_style_title').textContent = resolveMsg(3347, 'Hair Style');
			root.querySelector('.hair_color_title').textContent = resolveMsg(3348, 'Hair Color');
			root.querySelector('.return').textContent = resolveMsg(3352, 'Back');
			root.querySelector('.make').textContent = resolveMsg(3346, 'Create');
		} else {
			root.querySelector('.race_select .human .title').textContent = resolveMsg(3017, 'Novice');
			root.querySelector('.race_select .human .desc').textContent = resolveMsg(
				3021,
				'Balanced Midgard adventurer. Suitable for all new players.'
			);
			root.querySelector('.race_select .human .jobs').textContent = resolveMsg(
				3018,
				'Swordsman / Mage / Archer / Acolyte / Merchant / Thief'
			);
			root.querySelector('.race_select .doram .title').textContent = resolveMsg(3019, 'Doram');
			root.querySelector('.race_select .doram .desc').textContent = resolveMsg(
				3022,
				'Lasagna native focused on spirit-based combat.'
			);
			root.querySelector('.race_select .doram .jobs').textContent = resolveMsg(3020, 'Summoner');
		}
	}

	/**
	 * Rendering the Characters (three canvases, action animation)
	 */
	function renderRace(tick) {
		const root = Component.getRoot();

		const humanSelected = gridHairstyle ? _race === 'human' : _model.entity.job === RACE.HUMAN;
		const doramSelected = gridHairstyle ? _race === 'doram' : _model.entity.job === RACE.DORAM;

		if (humanSelected) {
			if (_human.tick + 500 < tick) {
				_human.entity.set({
					action: 1,
					direction: 5
				});
				_human.tick = tick;
			}
		}

		// Rendering
		SpriteRenderer.bind2DContext(_human.ctx, 32, 115);
		_human.ctx.clearRect(0, 0, _human.ctx.canvas.width, _human.ctx.canvas.height);
		_human.entity.renderEntity();

		if (doramSelected) {
			if (_doram.tick + 500 < tick) {
				_doram.entity.set({
					action: 1,
					direction: 5
				});
				_doram.tick = tick;
			}
		}

		// Rendering
		SpriteRenderer.bind2DContext(_doram.ctx, 32, 100);
		_doram.ctx.clearRect(0, 0, _doram.ctx.canvas.width, _doram.ctx.canvas.height);
		_doram.entity.renderEntity();

		// Render the model
		SpriteRenderer.bind2DContext(_model.ctx, 32, 115);
		_model.ctx.clearRect(0, 0, _model.ctx.canvas.width, _model.ctx.canvas.height);
		_model.entity.renderEntity();

		root.querySelector(nameInputSelector).focus();

		if (gridHairstyle) {
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/img_${_race}_on.bmp`, dataURI => {
				root.querySelector(`.${_race}_label`).style.backgroundImage = `url(${dataURI})`;
			});

			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_${_gender}_on.bmp`, dataURI => {
				root.querySelector(`#${_gender}_container`).style.backgroundImage = `url(${dataURI})`;
			});

			Client.loadFile(
				`${DB.INTERFACE_PATH}make_character_ver2/color0${parseInt(_curcolor) + 1}_on.bmp`,
				dataURI => {
					const el = root.querySelector(`.cstyle0${_curcolor}`);
					if (el) {
						el.style.backgroundImage = `url(${dataURI})`;
					}
				}
			);

			const hairPanel = root.querySelector(`#${_race}_${_gender}`);
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_hairstyle_normal.bmp`, dataURI => {
				const el = hairPanel && hairPanel.querySelector(`.style${_prevhead}`);
				if (el) {
					el.style.backgroundImage = `url(${dataURI})`;
				}
			});
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_hairstyle_select.bmp`, dataURI => {
				const el = hairPanel && hairPanel.querySelector(`.style${_curhead}`);
				if (el) {
					el.style.backgroundImage = `url(${dataURI})`;
				}
			});

			// Sprite previews fill the grid when img_hairstyle tiles are missing/stubbed.
			if (!_hairPreviewTick || tick - _hairPreviewTick > 250) {
				_hairPreviewTick = tick;
				paintHairStylePreviews(root);
			}
		}
	}

	/* ------------------------------------------------------------------ *
	 * Race CAP variant (V3)
	 * ------------------------------------------------------------------ */

	function initRaceCap(root) {
		root.querySelector('.race_select #human').addEventListener('click', () => {
			updateCharacterCap(TYPE.RACE, RACE.HUMAN);
		});
		root.querySelector('.race_select #doram').addEventListener('click', () => {
			updateCharacterCap(TYPE.RACE, RACE.DORAM);
		});

		root.querySelector('#style .rot_left').addEventListener('click', () => {
			updateCharacterCap(TYPE.DIRECTION, DIRECTION.LEFT);
		});
		root.querySelector('#style .rot_right').addEventListener('click', () => {
			updateCharacterCap(TYPE.DIRECTION, DIRECTION.RIGHT);
		});

		root.querySelector('#style .gender .button.male').addEventListener('click', () => {
			updateCharacterCap(TYPE.GENDER, GENDER.MALE);
		});
		root.querySelector('#style .gender .button.female').addEventListener('click', () => {
			updateCharacterCap(TYPE.GENDER, GENDER.FEMALE);
		});

		root.querySelector('#style .hairstyle .left').addEventListener('click', () => {
			updateCharacterCap(TYPE.HEAD, VALUE.DECREASE);
		});
		root.querySelector('#style .hairstyle .right').addEventListener('click', () => {
			updateCharacterCap(TYPE.HEAD, VALUE.INCREASE);
		});

		root.querySelector('#style .haircolor .left').addEventListener('click', () => {
			updateCharacterCap(TYPE.HEADPALETTE, VALUE.DECREASE);
		});
		root.querySelector('#style .haircolor .right').addEventListener('click', () => {
			updateCharacterCap(TYPE.HEADPALETTE, VALUE.INCREASE);
		});
	}

	function setDefault() {
		updateCharacterCap(TYPE.DEFAULT, 0);
	}

	/**
	 * Update character hairstyle and haircolor
	 *
	 * @param {number} type
	 * @param {number} value
	 */
	function updateCharacterCap(type, value) {
		const root = Component.getRoot();

		switch (type) {
			case TYPE.GENDER:
				_model.entity.sex = value;

				if (_model.entity.sex == GENDER.MALE) {
					Client.loadFile(`${DB.INTERFACE_PATH}make_character/btn_gender_m_press.bmp`, dataURI => {
						root.querySelector('#male_container').style.backgroundImage = `url(${dataURI})`;
					});
					Client.loadFile(`${DB.INTERFACE_PATH}make_character/btn_gender_f_out.bmp`, dataURI => {
						root.querySelector('#female_container').style.backgroundImage = `url(${dataURI})`;
					});
				} else {
					Client.loadFile(`${DB.INTERFACE_PATH}make_character/btn_gender_m_out.bmp`, dataURI => {
						root.querySelector('#male_container').style.backgroundImage = `url(${dataURI})`;
					});
					Client.loadFile(`${DB.INTERFACE_PATH}make_character/btn_gender_f_press.bmp`, dataURI => {
						root.querySelector('#female_container').style.backgroundImage = `url(${dataURI})`;
					});
				}
				break;

			case TYPE.RACE:
				_model.entity.job = value;
				_model.entity.head = 1;

				if (_model.entity.job === RACE.HUMAN) {
					Client.loadFile(RACE_MARK, dataURI => {
						root.querySelector('.race_select .human label').style.backgroundImage = `url(${dataURI})`;
					});
					root.querySelector('.race_select .doram label').style.backgroundImage = 'none';
				} else {
					root.querySelector('.race_select .human label').style.backgroundImage = 'none';
					Client.loadFile(RACE_MARK, dataURI => {
						root.querySelector('.race_select .doram label').style.backgroundImage = `url(${dataURI})`;
					});
				}

				break;

			case TYPE.DIRECTION:
				_model.entity.direction += value;
				break;

			case TYPE.HEAD: {
				let headval = _model.entity.head + value;
				if (headval > CAP[_model.entity.job].HEAD.MAX) {
					headval = CAP[_model.entity.job].HEAD.MIN;
				}
				if (headval < CAP[_model.entity.job].HEAD.MIN) {
					headval = CAP[_model.entity.job].HEAD.MAX;
				}
				_model.entity.head = headval;
				break;
			}

			case TYPE.HEADPALETTE: {
				let headpaletteval = _model.entity.headpalette + value;
				if (headpaletteval > CAP[_model.entity.job].HEADPALETTE.MAX) {
					headpaletteval = CAP[_model.entity.job].HEADPALETTE.MIN;
				}
				if (headpaletteval < CAP[_model.entity.job].HEADPALETTE.MIN) {
					headpaletteval = CAP[_model.entity.job].HEADPALETTE.MAX;
				}
				_model.entity.headpalette = headpaletteval;
				break;
			}

			case TYPE.DEFAULT:
				updateCharacterCap(TYPE.RACE, RACE.HUMAN);
				updateCharacterCap(TYPE.GENDER, GENDER.MALE);
				_model.entity.headpalette = 0;
				break;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Race grid variant (V4)
	 * ------------------------------------------------------------------ */

	function initRaceGrid(root) {
		// Default stylist
		_race = 'human';
		_gender = 'male';
		_prevhead = 1;
		_curhead = 1;
		_prevcolor = 0;
		_curcolor = 0;

		root.querySelector('.gender .male_button').addEventListener(
			'mousedown',
			updateCharacterGenericGrid('gender', 1)
		);
		root.querySelector('.gender .female_button').addEventListener(
			'mousedown',
			updateCharacterGenericGrid('gender', 0)
		);
		root.querySelector('#style .rot_left').addEventListener(
			'mousedown',
			updateCharacterGenericGrid('direction', 0)
		);
		root.querySelector('#style .rot_right').addEventListener(
			'mousedown',
			updateCharacterGenericGrid('direction', 1)
		);

		root.querySelectorAll('.race').forEach(el => {
			el.addEventListener('click', updateRace);
		});

		// Event delegation for hairstyle buttons
		root.addEventListener('click', event => {
			const hstyleBtn = event.target.closest('.hstyle_button');
			if (hstyleBtn) {
				updateHStyle(hstyleBtn);
				return;
			}
			const hcolorBtn = event.target.closest('.hcolor_button');
			if (hcolorBtn) {
				updateHColor(hcolorBtn);
			}
		});
	}

	/**
	 * Render head sprites into each visible hairstyle cell.
	 * Skin packs often omit img_hairstyle*.bmp; GRF tiles can also be stubs.
	 */
	function paintHairStylePreviews(root) {
		const panel = root.querySelector(`#${_race}_${_gender}`);
		if (!panel || panel.style.display === 'none') {
			return;
		}

		const sex = _gender === 'male' ? GENDER.MALE : GENDER.FEMALE;
		const job = _race === 'human' ? RACE.HUMAN : RACE.DORAM;
		const headpalette = _model.entity.headpalette;

		panel.querySelectorAll('.hstyle_button').forEach(btn => {
			const head = parseInt(btn.getAttribute('for'), 10);
			if (!Number.isFinite(head) || head < 1) {
				return;
			}

			let canvas = btn.querySelector('canvas.hair-preview');
			if (!canvas) {
				canvas = document.createElement('canvas');
				canvas.className = 'hair-preview';
				canvas.width = 36;
				canvas.height = 37;
				canvas.style.cssText =
					'pointer-events:none;display:block;position:absolute;left:0;top:0;width:36px;height:37px;z-index:3;';
				btn.appendChild(canvas);
			}

			const ctx = canvas.getContext('2d');
			_hairPreview.entity.set({
				sex,
				job,
				head,
				headpalette,
				action: 0,
				direction: 4
			});
			SpriteRenderer.bind2DContext(ctx, 18, 30);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			_hairPreview.entity.renderEntity();
		});
	}

	/**
	 * Also apply BMP hairstyle icons when present (under the sprite preview).
	 */
	function loadHairStyleIcons(root) {
		const panel = root.querySelector(`#${_race}_${_gender}`);
		if (!panel) {
			return;
		}

		panel.querySelectorAll('.hstyle_button').forEach(btn => {
			const img = btn.querySelector('ui-image');
			const src = img && img.getAttribute('src');
			if (!src) {
				return;
			}
			Client.loadFile(
				DB.INTERFACE_PATH + src,
				dataURI => {
					if (typeof dataURI === 'string' && dataURI.length > 32) {
						btn.style.backgroundImage = `url(${dataURI})`;
						btn.style.backgroundSize = '36px 37px';
						btn.style.backgroundRepeat = 'no-repeat';
						btn.style.backgroundPosition = 'center';
					}
				},
				() => {
					/* sprite preview covers missing tiles */
				}
			);
		});
	}

	/**
	 * Update model hairstyle
	 */
	function updateHStyle(target) {
		const root = Component.getRoot();
		const type = 'head';
		const value = parseInt(target.getAttribute('for'), 10);
		const hairPanel = root.querySelector(`#${_race}_${_gender}`);

		_prevhead = _model.entity.head;
		Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_hairstyle_normal.bmp`, dataURI => {
			const el = hairPanel && hairPanel.querySelector(`.style${_prevhead}`);
			if (el) {
				el.style.backgroundImage = `url(${dataURI})`;
			}
		});

		_curhead = value;

		updateCharacterGrid(type, value);
	}

	/**
	 * Update model haircolor
	 */
	function updateHColor(target) {
		const root = Component.getRoot();
		const type = 'headpalette';
		const value = parseInt(target.getAttribute('for'));

		_prevcolor = _model.entity.headpalette;

		Client.loadFile(
			`${DB.INTERFACE_PATH}make_character_ver2/color0${parseInt(_prevcolor) + 1}_off.bmp`,
			dataURI => {
				const el = root.querySelector(`.cstyle0${_prevcolor}`);
				if (el) {
					el.style.backgroundImage = `url(${dataURI})`;
				}
			}
		);

		_curcolor = value;

		updateCharacterGrid(type, value);
		paintHairStylePreviews(root);
	}

	/**
	 * Update model race
	 */
	function updateRace() {
		const root = Component.getRoot();
		const select = root.querySelector('.race:checked');
		const type = 'race';
		let value = 0;

		if (select && select.id === 'human_race') {
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/img_human_on.bmp`, dataURI => {
				root.querySelector('.human_label').style.backgroundImage = `url(${dataURI})`;
			});
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/img_doram_off.bmp`, dataURI => {
				root.querySelector('.doram_label').style.backgroundImage = `url(${dataURI})`;
			});
			value = 0;
		}

		if (select && select.id === 'doram_race') {
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/img_human_off.bmp`, dataURI => {
				root.querySelector('.human_label').style.backgroundImage = `url(${dataURI})`;
			});
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/img_doram_on.bmp`, dataURI => {
				root.querySelector('.doram_label').style.backgroundImage = `url(${dataURI})`;
			});
			value = 4218;
		}

		// In between changes of race, it needs to clear everything
		const nextRace = value === 0 ? 'human' : 'doram';
		const nextGender = _gender;
		const nextPanel = root.querySelector(`#${nextRace}_${nextGender}`);
		for (let i = 1; i <= 24; i++) {
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_hairstyle_normal.bmp`, dataURI => {
				const el = nextPanel && nextPanel.querySelector(`.style${i}`);
				if (el) {
					el.style.backgroundImage = `url(${dataURI})`;
				}
			});
		}

		// Reset Head
		_prevhead = 1;
		_curhead = 1;

		updateHstyleList(type, value);
		updateCharacterGrid(type, value);
		loadHairStyleIcons(root);
		paintHairStylePreviews(root);
	}

	/**
	 * Generic function to get a direct proxy to updateCharacterGrid
	 *
	 * @param {string} type
	 * @param {number} value
	 */
	function updateCharacterGenericGrid(type, value) {
		return () => {
			if (type === 'gender') {
				updateHstyleList(type, value);
			}
			updateCharacterGrid(type, value);
		};
	}

	function updateHstyleList(type, value) {
		const root = Component.getRoot();

		switch (type) {
			case 'gender':
				if (value === 1) {
					_gender = 'male';
				} else {
					_gender = 'female';
				}
				break;
			case 'race':
				if (value === 0) {
					_race = 'human';
				} else {
					_race = 'doram';
				}
				break;
		}

		Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_male_off.bmp`, dataURI => {
			root.querySelector('#male_container').style.backgroundImage = `url(${dataURI})`;
		});
		Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_female_off.bmp`, dataURI => {
			root.querySelector('#female_container').style.backgroundImage = `url(${dataURI})`;
		});

		Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/bt_${_gender}_on.bmp`, dataURI => {
			root.querySelector(`#${_gender}_container`).style.backgroundImage = `url(${dataURI})`;
		});

		// Hide everything first still
		root.querySelectorAll('.hair-style').forEach(el => {
			el.style.display = 'none';
		});

		// Show the correct one
		const hairStyleEl = root.querySelector(`#${_race}_${_gender}`);
		if (hairStyleEl) {
			hairStyleEl.style.display = 'block';
		}

		loadHairStyleIcons(root);
		paintHairStylePreviews(root);
	}

	function cleanup() {
		const root = Component.getRoot();

		// Reset Default
		_race = 'human';
		_gender = 'male';
		_prevhead = 1;
		_curhead = 1;
		_prevcolor = 0;
		_curcolor = 0;

		const humanRace = root.querySelector('#human_race');
		if (humanRace) {
			humanRace.checked = true;
		}
		const maleInput = root.querySelector('#male');
		if (maleInput) {
			maleInput.checked = true;
		}
		root.querySelectorAll('.hstyle').forEach(el => {
			el.checked = false;
		});
		const defaultHstyle = root.querySelector('[id="1_human_male"]');
		if (defaultHstyle) {
			defaultHstyle.checked = true;
		}
		const defaultColor = root.querySelector('[id="0_color"]');
		if (defaultColor) {
			defaultColor.checked = true;
		}

		for (let i = 0; i <= 8; i++) {
			Client.loadFile(`${DB.INTERFACE_PATH}make_character_ver2/color0${i + 1}_off.bmp`, dataURI => {
				const el = root.querySelector(`.cstyle0${i}`);
				if (el) {
					el.style.backgroundImage = `url(${dataURI})`;
				}
			});
		}

		updateCharacterGrid('default', 0);
		loadHairStyleIcons(root);
		paintHairStylePreviews(root);
	}

	/**
	 * Update character hairstyle and haircolor
	 *
	 * @param {string} type
	 * @param {number} increment
	 */
	function updateCharacterGrid(type, increment) {
		switch (type) {
			case 'gender':
				_model.entity.sex = increment;
				break;

			case 'race':
				_model.entity.job = increment;
				_model.entity.head = 1;
				break;

			case 'direction':
				if (increment === 0) {
					_model.entity.direction = _model.entity.direction + 1;
				} else {
					_model.entity.direction = _model.entity.direction - 1;
				}
				break;

			case 'head':
				_prevhead = _model.entity.head;
				_model.entity.head = increment;
				break;

			case 'headpalette':
				_model.entity.headpalette = increment;
				break;

			case 'default':
				_model.entity.sex = 1;
				_model.entity.job = 0;
				_model.entity.head = 1;
				_model.entity.headpalette = 0;
				break;
		}
	}

	/**
	 * Callback to define
	 */
	Component.onExitRequest = function OnExitRequest() {};

	/**
	 * Abstract callback to define
	 */
	Component.onCharCreationRequest = function OnCharCreationRequest() {};

	/**
	 * Create component and export it
	 */
	return UIManager.addComponent(Component);
}
