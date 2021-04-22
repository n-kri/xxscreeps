import type { InspectOptionsStylized } from 'util';
import type { LooseBoolean } from 'xxscreeps/utility/types';

import GameMap, { getTerrainAt } from 'xxscreeps/game/map';
import * as C from '../constants';
import * as Fn from 'xxscreeps/utility/functional';
import * as Memory from '../memory';
import * as PathFinder from '../path-finder';

import { Direction, RoomPosition, extractPositionId, fetchPositionArgument, getOffsetsFromDirection } from '../position';

import { BufferObject } from 'xxscreeps/schema/buffer-object';
import { BufferView, withOverlay } from 'xxscreeps/schema';
import { iteratee } from 'xxscreeps/engine/util/iteratee';

import { registerGlobal } from 'xxscreeps/game';
import { AfterInsert, AfterRemove, LookType, RoomObject, RunnerUser } from 'xxscreeps/game/object';
import { getRoomTerrain } from '../map';
import { RoomVisual } from '../visual';

import { EventLogSymbol } from './event-log';
import { FindConstants, FindType, findHandlers } from './find';
import { LookConstants, TypeOfLook, lookConstants } from './look';
import { shape } from './schema';
import { FlushFindCache, LookFor, MoveObject, Objects, InsertObject, RemoveObject } from './symbols';
import { iterateArea } from '../position/direction';

export type AnyRoomObject = RoomObject | InstanceType<typeof Room>[typeof Objects][number];

export type { LookConstants };

type LookForResult<Type extends LookConstants> = {
	[key in LookConstants]: TypeOfLook<Type>;
} & {
	type: Type;
};

export type LookForType<Type extends RoomObject> = {
	[key in LookConstants]: Type extends TypeOfLook<key> ? Type : never;
} & {
	type: never;
};

type LookAtArea<Type> = Record<number, Record<number, Type[]>>;

export type FindPathOptions = PathFinder.RoomSearchOptions & {
	serialize?: boolean;
};
export type RoomFindOptions<Type = any> = {
	filter?: string | object | ((object: Type) => LooseBoolean);
};

export type RoomPath = {
	x: number;
	y: number;
	dx: -1 | 0 | 1;
	dy: -1 | 0 | 1;
	direction: Direction;
}[];

export class Room extends withOverlay(BufferObject, shape) {
	get memory() {
		const memory = Memory.get();
		const rooms = memory.rooms ?? (memory.rooms = {});
		return rooms[this.name] ?? (rooms[this.name] = {});
	}

	// TODO: Put in mods
	energyAvailable = 0;
	energyCapacityAvailable = 0;

	constructor(view: BufferView, offset: number) {
		super(view, offset);
		for (const object of this[Objects] as RoomObject[]) {
			object[AfterInsert](this);
			this._addToLookIndex(object);
		}
	}

	/**
	 * Find all objects of the specified type in the room. Results are cached automatically for the
	 * specified room and type before applying any custom filters. This automatic cache lasts until
	 * the end of the tick.
	 * @param type One of the FIND_* constants
	 * @param opts
	 */
	find<Type extends FindConstants>(
		type: Type,
		options: RoomFindOptions<FindType<Type>> = {},
	): FindType<Type>[] {
		// Check find cache
		let results = this.#findCache.get(type);
		if (results === undefined) {
			this.#findCache.set(type, results = findHandlers.get(type)?.(this) ?? []);
		}

		// Copy or filter result
		return (options.filter === undefined ? results.slice() : results.filter(iteratee(options.filter))) as never;
	}

	/**
	 * Find the exit direction en route to another room. Please note that this method is not required
	 * for inter-room movement, you can simply pass the target in another room into Creep.moveTo
	 * method.
	 * @param room Another room name or room object
	 */
	findExitTo(room: Room | string) {
		const route = GameMap.findRoute(this, room);
		if (typeof route === 'object') {
			return route[0].exit;
		} else {
			return route;
		}
	}

	/**
	 * Find an optimal path inside the room between fromPos and toPos using Jump Point Search algorithm.
	 * @param origin The start position
	 * @param goal The end position
	 * @param options
	 */
	findPath(origin: RoomPosition, goal: RoomPosition, options?: FindPathOptions & { serialize?: false }): RoomPath;
	findPath(origin: RoomPosition, goal: RoomPosition, options?: FindPathOptions & { serialize: true }): string;
	findPath(origin: RoomPosition, goal: RoomPosition, options?: FindPathOptions & { serialize?: boolean }): RoomPath | string;
	findPath(origin: RoomPosition, goal: RoomPosition, options: FindPathOptions & { serialize?: boolean } = {}) {

		// Delegate to `PathFinder` and convert the result
		const result = PathFinder.roomSearch(origin, [ goal ], options);
		const path: any[] = [];
		let previous = origin;
		for (const pos of result.path) {
			if (pos.roomName !== this.name) {
				break;
			}
			path.push({
				x: pos.x,
				y: pos.y,
				dx: pos.x - previous.x,
				dy: pos.y - previous.y,
				direction: previous.getDirectionTo(pos),
			});
			previous = pos;
		}
		if (options.serialize) {
			return this.serializePath(path);
		}
		return path;
	}

	/**
	 * Serialize a path array into a short string representation, which is suitable to store in memory
	 * @param path A path array retrieved from Room.findPath
	 */
	serializePath(path: RoomPath) {
		if (!Array.isArray(path)) {
			throw new Error('`path` is not an array');
		}
		if (path.length === 0) {
			return '';
		}
		if (path[0].x < 0 || path[0].y < 0) {
			throw new Error('path coordinates cannot be negative');
		}
		let result = `${path[0].x}`.padStart(2, '0') + `${path[0].y}`.padStart(2, '0');
		for (const step of path) {
			result += step.direction;
		}
		return result;
	}

	/**
	 * Deserialize a short string path representation into an array form
	 * @param path A serialized path string
	 */
	deserializePath(path: string) {
		if (typeof path !== 'string') {
			throw new Error('`path` is not a string');
		}
		const result: RoomPath = [];
		if (path.length === 0) {
			return result;
		}

		let x = Number(path.substr(0, 2));
		let y = Number(path.substr(2, 2));
		if (Number.isNaN(x) || Number.isNaN(y)) {
			throw new Error('`path` is not a valid serialized path string');
		}
		for (let ii = 4; ii < path.length; ++ii) {
			const direction = Number(path[ii]) as Direction;
			const { dx, dy } = getOffsetsFromDirection(direction);
			if (ii > 4) {
				x += dx;
				y += dy;
			}
			result.push({
				x, y,
				dx, dy,
				direction,
			});
		}
		return result;
	}

	/**
	 * Get a Room.Terrain object which provides fast access to static terrain data. This method works
	 * for any room in the world even if you have no access to it.
	 */
	getTerrain() {
		return getRoomTerrain(this.name)!;
	}

	/**
	 * Get the list of objects at the specified room position.
	 * @param type One of the `LOOK_*` constants
	 * @param x X position in the room
	 * @param y Y position in the room
	 * @param target Can be a RoomObject or RoomPosition
	 */
	lookAt(...args: [ x: number, y: number ] | [ target: RoomObject | RoomPosition ]): LookForResult<LookConstants>[] {
		const { pos } = fetchPositionArgument(this.name, ...args);
		if (!pos || pos.roomName !== this.name) {
			return [];
		}
		return [ ...Fn.map(
			this._getSpatialIndex().get(extractPositionId(pos)) ?? [],
			object => {
				const type = object[LookType];
				return { type, [type]: object };
			}),
			{ type: 'terrain', terrain: getTerrainAt(pos) } ] as never;
	}

	/**
	 * Get an object with the given type at the specified room position.
	 * @param type One of the `LOOK_*` constants
	 * @param x X position in the room
	 * @param y Y position in the room
	 * @param target Can be a RoomObject or RoomPosition
	 */
	lookForAt<Type extends LookConstants>(type: Type, x: number, y: number): TypeOfLook<Type>[];
	lookForAt<Type extends LookConstants>(type: Type, target: RoomObject | RoomPosition): TypeOfLook<Type>[];
	lookForAt<Type extends LookConstants>(
		type: Type, ...rest: [ number, number ] | [ RoomObject | RoomPosition ]
	) {
		const { pos } = fetchPositionArgument(this.name, ...rest);
		if (!pos || pos.roomName !== this.name) {
			return [];
		}
		if (type === C.LOOK_TERRAIN) {
			return [ getTerrainAt(pos) ];
		}
		if (!lookConstants.has(type)) {
			return C.ERR_INVALID_ARGS as any;
		}
		return [ ...Fn.filter(
			this._getSpatialIndex().get(extractPositionId(pos)) ?? [],
			object => object[LookType] === type) ];
	}

	/**
	 * Get the list of objects at the specified room area.
	 * @param top The top Y boundary of the area.
	 * @param left The left X boundary of the area.
	 * @param bottom The bottom Y boundary of the area.
	 * @param right The right X boundary of the area.
	 * @param asArray Set to true if you want to get the result as a plain array.
	 */
	lookAtArea(top: number, left: number, bottom: number, right: number, asArray?: false): LookAtArea<LookForResult<LookConstants>>;
	lookAtArea(top: number, left: number, bottom: number, right: number, asArray: true): LookForResult<LookConstants>[];
	lookAtArea(top: number, left: number, bottom: number, right: number, asArray = false) {
		const size = (bottom - top + 1) * (right - left + 1);
		const objects: Iterable<any> = (() => {
			if (size < this[Objects].length) {
				// Iterate all objects
				return Fn.filter(this[Objects], object =>
					object.pos.x >= left && object.pos.x <= right &&
					object.pos.y >= top && object.pos.y <= bottom);
			} else {
				// Filter on spatial index
				return Fn.concat(Fn.map(iterateArea(this.name, top, left, bottom, right), pos =>
					this._getSpatialIndex().get(extractPositionId(pos)) ?? []));
			}
		})();
		const terrain = this.getTerrain();
		const results = Fn.concat(
			// Iterate objects
			Fn.map(objects, object => ({ x: object.pos.x, y: object.pos.y, [object[LookType]]: object })),
			// Add terrain data
			Fn.map(iterateArea(this.name, top, left, bottom, right), pos =>
				({ x: pos.x, y: pos.y, terrain: terrain._getType(pos.x, pos.y) })));
		return withAsArray(results, top, left, bottom, right, asArray, true) as never;
	}

	/**
	 * Get the list of objects with the given type at the specified room area.
	 * @param type One of the `LOOK_*` constants.
	 * @param top The top Y boundary of the area.
	 * @param left The left X boundary of the area.
	 * @param bottom The bottom Y boundary of the area.
	 * @param right The right X boundary of the area.
	 * @param asArray Set to true if you want to get the result as a plain array.
	 */
	lookForAtArea<Type extends LookConstants>(type: Type, top: number, left: number, bottom: number, right: number, asArray?: false):
		LookAtArea<(LookForResult<Type> & { x: number; y: number })>;
	lookForAtArea<Type extends LookConstants>(type: Type, top: number, left: number, bottom: number, right: number, asArray: true):
		(LookForResult<Type> & { x: number; y: number })[];
	lookForAtArea<Type extends LookConstants>(type: Type, top: number, left: number, bottom: number, right: number, asArray = false) {
		const size = (bottom - top + 1) * (right - left + 1);
		const results: Iterable<any> = (() => {
			if (type === C.LOOK_TERRAIN) {
				// Simply return terrain data
				const terrain = this.getTerrain();
				return Fn.map(iterateArea(this.name, top, left, bottom, right),
					pos => ({ x: pos.x, y: pos.y, terrain: terrain._getType(pos.x, pos.y) }));
			} else {
				const objects = (() => {
					const objects = this.#lookIndex.get(type)!;
					if (size < objects.length) {
						// Iterate all objects by type
						return Fn.filter(objects, object =>
							object.pos.x >= left && object.pos.x <= right &&
							object.pos.y >= top && object.pos.y <= bottom);
					} else {
						// Filter on spatial index
						return Fn.concat(Fn.map(iterateArea(this.name, top, left, bottom, right), pos =>
							Fn.filter(this._getSpatialIndex().get(extractPositionId(pos)) ?? [],
								object => object[LookType] === type)));
					}
				})();
				// Add position and type information
				return Fn.map(objects, object => ({ x: object.pos.x, y: object.pos.y, [type]: object }));
			}
		})();
		return withAsArray(results, top, left, bottom, right, asArray, false);
	}

	/**
	 * Returns an array of events happened on the previous tick in this room.
	 * @param raw Return as JSON string.
	 */
	getEventLog(raw?: boolean) {
		if (raw) {
			throw new Error('Don\'t use this');
		} else {
			return this[EventLogSymbol];
		}
	}

	/**
	 * A `RoomVisual` object for this room. You can use this object to draw simple shapes (lines,
	 * circles, text labels) in the room.
	 */
	get visual() {
		const value = new RoomVisual(this.name);
		Object.defineProperty(this, 'visual', { value });
		return value;
	}

	//
	// Private functions
	[LookFor]<Look extends LookConstants>(this: this, type: Look): TypeOfLook<Look>[] {
		return this.#lookIndex.get(type)! as never[];
	}

	//
	// Private mutation functions
	[FlushFindCache]() {
		this.#findCache.clear();
	}

	[InsertObject](object: RoomObject) {
		// Add to objects & look index then flush find caches
		this[Objects].push(object as never);
		this._addToLookIndex(object);
		/* const findTypes = lookToFind[lookType];
		for (const find of findTypes) {
			this.#findCache.delete(find);
		} */
		this.#findCache.clear();
		// Update spatial look cache if it exists
		if (this.#lookSpatialIndex.size) {
			const pos = extractPositionId(object.pos);
			const list = this.#lookSpatialIndex.get(pos);
			if (list) {
				list.push(object);
			} else {
				this.#lookSpatialIndex.set(pos, [ object ]);
			}
		}
		object[AfterInsert](this);
	}

	[RemoveObject](object: RoomObject) {
		// Remove from objects & look index then flush find caches
		removeOne(this[Objects], object as never);
		this._removeFromLookIndex(object);
		/* const findTypes = lookToFind[lookType];
		for (const find of findTypes) {
			this.#findCache.delete(find);
		} */
		this.#findCache.clear();
		// Update spatial look cache if it exists
		if (this.#lookSpatialIndex.size) {
			const pos = extractPositionId(object.pos);
			const list = this.#lookSpatialIndex.get(pos)!;
			if (list.length === 1) {
				this.#lookSpatialIndex.delete(pos);
			} else {
				removeOne(list, object);
			}
		}
		object[AfterRemove](this);
	}

	[MoveObject](object: RoomObject, pos: RoomPosition) {
		if (this.#lookSpatialIndex.size) {
			const oldPosition = extractPositionId(object.pos);
			const oldList = this.#lookSpatialIndex.get(oldPosition)!;
			if (oldList.length === 1) {
				this.#lookSpatialIndex.delete(oldPosition);
			} else {
				removeOne(oldList, object);
			}
			const posInteger = extractPositionId(pos);
			const newList = this.#lookSpatialIndex.get(posInteger);
			if (newList) {
				newList.push(object);
			} else {
				this.#lookSpatialIndex.set(posInteger, [ object ]);
			}
		}
		object.pos = pos;
	}

	_objectsAt(pos: RoomPosition) {
		return this._getSpatialIndex().get(extractPositionId(pos)) ?? [];
	}

	private _addToLookIndex(object: RoomObject) {
		this.#lookIndex.get(object[LookType])!.push(object);
	}

	private _removeFromLookIndex(object: RoomObject) {
		removeOne(this.#lookIndex.get(object[LookType])!, object);
	}

	// Returns objects indexed by position
	private _getSpatialIndex() {
		if (this.#lookSpatialIndex.size) {
			return this.#lookSpatialIndex;
		}
		for (const object of this[Objects]) {
			const pos = extractPositionId(object.pos);
			const list = this.#lookSpatialIndex.get(pos);
			if (list) {
				list.push(object);
			} else {
				this.#lookSpatialIndex.set(pos, [ object ]);
			}
		}
		return this.#lookSpatialIndex;
	}

	//
	// Debug utilities
	private toJSON() {
		const result: any = {};
		for (const ii in this) {
			if (!(this[ii] instanceof RoomObject)) {
				result[ii] = this[ii];
			}
		}
		return result;
	}

	private toString() {
		return `[Room ${this.name}]`;
	}

	private [Symbol.for('nodejs.util.inspect.custom')](depth: number, options: InspectOptionsStylized) {
		// Every object has a `room` property so flatten this reference out unless it's a direct
		// inspection
		if (depth === options.depth) {
			return this;
		} else {
			return `[Room ${options.stylize(this.name, 'string')}]`;
		}
	}

	#findCache = new Map<number, (RoomObject | RoomPosition)[]>();
	#lookIndex = new Map<string, RoomObject[]>(
		Fn.map(lookConstants, look => [ look, [] ]));
	#lookSpatialIndex = new Map<number, RoomObject[]>();
}

// Export `Room` to runtime globals
registerGlobal(Room);
declare module 'xxscreeps/game/runtime' {
	interface Global { Room: typeof Room }
}

//
// Utilities
function removeOne<Type>(list: Type[], element: Type) {
	const index = list.indexOf(element);
	if (index === -1) {
		throw new Error('Removed object was not found');
	}
	list.splice(index, 1);
}

export function getUsersInRoom(room: Room) {
	const users = new Set<string>();
	for (const objects of room[Objects]) {
		const user = objects[RunnerUser]();
		if (user !== null && user.length > 2) {
			users.add(user);
		}
	}
	return users;
}

function withAsArray(values: Iterable<{ x: number; y: number }>, top: number, left: number, bottom: number, right: number, asArray: boolean, nest: boolean) {
	if (asArray) {
		return [ ...values ];
	} else {
		const results: LookAtArea<any> = {};
		for (let yy = top; yy <= bottom; ++yy) {
			const row: Record<number, any[]> = results[yy] = {};
			if (nest) {
				for (let xx = left; xx <= right; ++xx) {
					row[xx] = [];
				}
			}
		}
		for (const value of values) {
			(results[value.y][value.x] ??= []).push(value);
		}
		return results;
	}
}
