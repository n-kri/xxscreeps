import type ivm from 'isolated-vm';
import lodash from 'lodash';
import { inspect } from 'util';

import { Creep } from '~/game/objects/creep';
import { Game } from '~/game/game';
import { RoomPosition } from '~/game/position';
import { Room } from '~/game/room';
import { Source } from '~/game/objects/source';

import * as Constants from '~/game/constants';
import { gameContext, IntentManager } from '~/game/context';
import * as Memory from '~/game/memory';
import { loadTerrainFromBuffer } from '~/game/map';
import * as PathFinder from '~/game/path-finder';
import * as UserCode from '~/engine/metadata/code';
import { BufferView } from '~/lib/schema/buffer-view';

import { setupConsole, Writer } from './console';

// Sets up prototype overlays
import '~/engine/schema/room';

declare const global: any;

// Global lodash compatibility
global._ = lodash;

// Export prototypes
global.Creep = Creep;
global.RoomPosition = RoomPosition;
global.Source = Source;
Memory.initialize(new Uint16Array(1));

/**
 * TODO: lock these
 * JSON - stringify/parse
 * Math - max/min
 * global - Object, Array, TypedArrays, ArrayBuffer, SharedArrayBuffer
 * Symbol.iterator
 */

// Export constants
for (const [ identifier, value ] of Object.entries(Constants)) {
	global[identifier] = value;
}

let require: (name: string) => any;
let writeConsole: Writer;
export function initialize(
	compileModule: (source: string, filename: string) => ((...args: any[]) => any),
	userId: string,
	codeBlob: Readonly<Uint8Array>,
	terrain: Readonly<Uint8Array>,
	_writeConsole: Writer,
) {
	// Set up console
	setupConsole(writeConsole = _writeConsole);
	// Load terrain
	loadTerrainFromBuffer(terrain);
	// Set up user information
	const { modules } = UserCode.read(codeBlob);
	if (!modules.has('main')) {
		modules.set('main', '');
	}
	gameContext.userId = userId;
	// Set up global `require`
	const cache = Object.create(null);
	global.require = require = name => {
		// Check cache
		const cached = cache[name];
		if (cached !== undefined) {
			if (cached === null) {
				throw new Error(`Circular reference to module: ${name}`);
			}
			return cached;
		}
		const code = modules.get(name);
		if (code === undefined) {
			throw new Error(`Unknown module: ${name}`);
		}
		cache[name] = null;
		// Compile module and execute
		const module = {
			exports: {} as any,
		};
		const moduleFunction = compileModule(`(function(module,exports){${code}\n})`, `${name}.js`);
		const run = () => moduleFunction.apply(module, [ module, module.exports ]);
		try {
			run();
		} catch (err) {
			Object.defineProperty(cache, name, { get: () => { throw err } });
			throw err;
		}
		if (name === 'main' && module.exports.loop === undefined) {
			// If user doesn't have `loop` it means the first tick already run. Simulate a proper `loop`
			// method which runs the second time this is called.
			const loop = () => run();
			module.exports.loop = () => module.exports.loop = loop;
		}
		// Cache executed module and release code string (maybe it frees memory?)
		cache[name] = module.exports;
		modules.delete(name);
		return module.exports;
	};
}

export function initializeIsolated(
	isolate: ivm.Isolate,
	context: ivm.Context,
	userId: string,
	codeBlob: Readonly<Uint8Array>,
	terrain: Readonly<Uint8Array>,
	writeConsoleRef: ivm.Reference<(fd: number, payload: string) => void>,
) {
	const compileModule = (source: string, filename: string) => {
		const script = isolate.compileScriptSync(source, { filename });
		return script.runSync(context, { reference: true }).deref();
	};
	const writeConsole = (fd: number, payload: string) =>
		writeConsoleRef.applySync(undefined, [ fd, payload ]);
	return initialize(compileModule, userId, codeBlob, terrain, writeConsole);
}

export function tick(time: number, roomBlobs: Readonly<Uint8Array>[], consoleEval?: string[]) {
	// Reset context
	gameContext.intents = new IntentManager;
	// Build game object
	const rooms = roomBlobs.map(buffer =>
		new Room(BufferView.fromTypedArray(buffer)));
	global.Game = new Game(time, rooms);
	// Run player loop
	require('main').loop();
	// Run console expressions
	const consoleResults = consoleEval?.map(expr => {
		try {
			writeConsole(1, inspect(new Function('expr', 'return eval(expr)')(expr), { colors: true }), true);
		} catch (err) {
			writeConsole(2, err.stack, true);
		}
	});

	const memoryString = Memory.flush();
	PathFinder.flush();
	// Return JSON'd intents
	const intents = function() {
		const intents: Dictionary<SharedArrayBuffer> = Object.create(null);
		const { intentsByRoom } = gameContext.intents;
		const roomNames = Object.keys(intentsByRoom);
		const { length } = roomNames;
		for (let ii = 0; ii < length; ++ii) {
			const roomName = roomNames[ii];
			const json = JSON.stringify(intentsByRoom[roomName]);
			const buffer = new SharedArrayBuffer(json.length * 2);
			const uint16 = new Uint16Array(buffer);
			for (let ii = 0; ii < json.length; ++ii) {
				uint16[ii] = json.charCodeAt(ii);
			}
			intents[roomName] = buffer;
		}
		return intents;
	}();
	return { intents, consoleResults };
}
