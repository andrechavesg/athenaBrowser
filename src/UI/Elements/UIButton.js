/**
 * UI/Elements/UIButton.js
 *
 * <ui-button bg="btn_ok.bmp" hover="btn_ok_a.bmp" down="btn_ok_b.bmp">OK</ui-button>
 *
 * Replaces: <button data-background="btn_ok.bmp" data-hover="btn_ok_a.bmp" data-down="btn_ok_b.bmp">
 *
 * @author AoShinHo
 */

import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import Targa from 'Loaders/Targa.js';

/**
 * Korean BMP buttons → English text labels.
 * Keys are filename stems (without path prefix, case-insensitive).
 */
const KOREAN_BMP_LABELS = {
	btn_ok: 'OK',
	btn_ok_dis: 'OK',
	btn_cancel: 'Cancel',
	btn_del: 'Delete',
	btn_close: 'Close',
	btn_make: 'Create',
	btn_next: 'Next',
	btn_sell: 'Sell',
	btn_buy: 'Buy',
	btn_use: 'Use',
	btn_back: 'Back'
};

/**
 * Shared CSS injected once into document <head> for ui-button native styling.
 */
const _NATIVE_BTN_STYLE = `
ui-button.native-eng {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	background: linear-gradient(to bottom, #d0dff0, #a8c0dc) !important;
	background-image: none !important;
	border: 1px solid #2a5080 !important;
	border-radius: 3px !important;
	color: #1a3258 !important;
	font-family: inherit;
	font-size: 9px;
	font-weight: 700;
	cursor: pointer;
	letter-spacing: 0.2px;
	box-sizing: border-box;
	opacity: 1 !important;
}
ui-button.native-eng:hover {
	background: linear-gradient(to bottom, #e0eeff, #c0d8f0) !important;
}
ui-button.native-eng:active,
ui-button.native-eng.is-down {
	background: linear-gradient(to bottom, #a8c0dc, #d0dff0) !important;
}
ui-button.native-eng[disabled] {
	opacity: 0.5 !important;
	cursor: default !important;
}
`;

let _styleInjected = false;
function _injectStyle() {
	if (_styleInjected) return;
	_styleInjected = true;
	const style = document.createElement('style');
	style.textContent = _NATIVE_BTN_STYLE;
	document.head.appendChild(style);
}

/**
 * Return the English label if 'bg' points to a known Korean BMP, else null.
 * Matches on the filename stem (last path segment, no extension).
 */
function _koreanBmpLabel(bg) {
	if (!bg) return null;
	const stem = bg
		.replace(/.*[\\/]/, '')
		.replace(/\.bmp$/i, '')
		.toLowerCase();
	return KOREAN_BMP_LABELS[stem] || null;
}

class UIButton extends HTMLElement {
	connectedCallback() {
		if (this._initialized) return;
		this._initialized = true;
		const bg = this.getAttribute('bg');
		const hover = this.getAttribute('hover');
		const down = this.getAttribute('down');

		const label = _koreanBmpLabel(bg);
		if (label !== null) {
			// Native English button — no BMP loading
			_injectStyle();
			this.classList.add('native-eng');
			if (!this.textContent.trim()) {
				this.textContent = label;
			}
			this.addEventListener('mousedown', () => this.classList.add('is-down'));
			this.addEventListener('mouseup', () => this.classList.remove('is-down'));
			this.addEventListener('mouseout', () => this.classList.remove('is-down'));
			this.addEventListener(
				'click',
				e => {
					if (this.disabled) {
						e.stopImmediatePropagation();
						e.preventDefault();
					}
				},
				true
			);
			return;
		}

		let bgUri = null,
			hoverUri = null,
			downUri = null;
		const state = { hover: false, down: false };

		const update = () => {
			if (this.disabled) {
				if (bgUri) {
					this.style.backgroundImage = `url(${bgUri})`;
				}
				this.style.opacity = '0.5';
				this.style.cursor = 'default';
				return;
			}
			this.style.opacity = '';
			this.style.cursor = '';
			if (state.down && downUri) {
				this.style.backgroundImage = `url(${downUri})`;
			} else if (state.hover && hoverUri) {
				this.style.backgroundImage = `url(${hoverUri})`;
			} else if (bgUri) {
				this.style.backgroundImage = `url(${bgUri})`;
			} else {
				this.style.backgroundImage = '';
			}
		};
		this._update = update;
		const loadBmp = (path, cb) => {
			if (!path) return;
			Client.loadFile(DB.INTERFACE_PATH + path, dataURI => {
				if (dataURI instanceof ArrayBuffer) {
					try {
						const tga = new Targa();
						tga.load(new Uint8Array(dataURI));
						cb(tga.getDataURL());
					} catch (e) {
						console.error(e.message);
					}
				} else {
					cb(dataURI);
				}
			});
		};

		loadBmp(bg, uri => {
			bgUri = uri;
			update();
		});
		loadBmp(hover, uri => {
			hoverUri = uri;
		});
		loadBmp(down, uri => {
			downUri = uri;
		});

		this.addEventListener('mouseover', () => {
			if (this.disabled) return;
			state.hover = true;
			update();
		});
		this.addEventListener('mouseout', () => {
			state.hover = false;
			state.down = false;
			update();
		});
		this.addEventListener('mousedown', () => {
			if (this.disabled) return;
			state.down = true;
			update();
		});
		this.addEventListener('mouseup', () => {
			state.down = false;
			update();
		});
		this.addEventListener(
			'click',
			e => {
				if (this.disabled) {
					e.stopImmediatePropagation();
					e.preventDefault();
				}
			},
			true
		);
	}
	get disabled() {
		return this.hasAttribute('disabled');
	}

	set disabled(val) {
		if (val) {
			this.setAttribute('disabled', '');
		} else {
			this.removeAttribute('disabled');
		}
	}
	static get observedAttributes() {
		return ['disabled'];
	}

	attributeChangedCallback(name) {
		if (name === 'disabled' && this._initialized) {
			// Reset hover/down state when becoming disabled
			// The update() closure is inside connectedCallback, so we need a reference
			if (this._update) this._update();
		}
	}
}

customElements.define('ui-button', UIButton);
export default UIButton;
