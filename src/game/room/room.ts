import type { BufferView } from 'xxscreeps/schema';
import type { InspectOptionsStylized } from 'util';
import type { Terrain } from 'xxscreeps/game/terrain';
import type { RoomObject } from 'xxscreeps/game/object';
import type { RoomPosition } from 'xxscreeps/game/position';
import type { FindConstants, FindType, RoomFindOptions } from './find';
import type { LookConstants, TypeOfLook } from './look';
import * as Fn from 'xxscreeps/utility/functional';
import { BufferObject, withOverlay } from 'xxscreeps/schema';
import { getOrSet, removeOne } from 'xxscreeps/utility/utility';
import { iteratee } from 'xxscreeps/utility/iteratee';
import { registerGlobal } from 'xxscreeps/game';
import { shape } from './schema';
import { findHandlers, lookConstants } from './symbols';

export type AnyRoomObject = Room['#objects'][number];

/**
 * An object representing the room in which your units and structures are in. It can be used to look
 * around, find paths, etc. Every `RoomObject` in the room contains its linked `Room` instance in
 * the `room` property.
 */
export class Room extends withOverlay(BufferObject, shape) {
	declare static Terrain: typeof Terrain;

	// TODO: Move to mod
	energyAvailable = 0;
	energyCapacityAvailable = 0;
	#findCache = new Map<number, (RoomObject | RoomPosition)[]>();
	#lookIndex = new Map<string, RoomObject[]>(Fn.map(lookConstants, look => [ look, [] ]));
	#spatialIndex = new Map<number, RoomObject[]>();
	#insertObjects: RoomObject[] = [];
	#removeObjects = new Set<RoomObject>();

	constructor(view: BufferView, offset: number) {
		super(view, offset);
		for (const object of this['#objects']) {
			this._addToIndex(object);
			object['#afterInsert'](this);
		}
	}

	/**
	 * Find all objects of the specified type in the room. Results are cached automatically for the
	 * specified room and type before applying any custom filters. This automatic cache lasts until
	 * the end of the tick.
	 * @param type One of the FIND_* constants
	 * @param opts An object with additional options:
	 *   `filter` - The result list will be filtered using the Lodash.filter method.
	 */
	find<Type extends FindConstants>(type: Type, options: RoomFindOptions<FindType<Type>> = {}): FindType<Type>[] {
		// Check find cache
		const results = getOrSet(this.#findCache, type, () => findHandlers.get(type)?.(this) ?? []);

		// Copy or filter result
		return options.filter ? results.filter(iteratee(options.filter)) : results.slice();
	}

	/**
	 * Returns a plain array of all room objects at a given location.
	 */
	['#lookAt'](pos: RoomPosition): Readonly<AnyRoomObject[]> {
		return (this.#spatialIndex.get(pos['#int']) ?? []) as never[];
	}

	/**
	 * Returns a plain array of all room objects matching `type`
	 */
	['#lookFor']<Look extends LookConstants>(type: Look): Readonly<TypeOfLook<Look>[]> {
		return this.#lookIndex.get(type)! as never[];
	}

	/**
	 * Flushes the cache used by `find` because it sometimes contains user-specific information.
	 */
	['#flushFindCache']() {
		this.#findCache.clear();
	}

	/**
	 * Execute all insert / remove mutations that have been queued with `InsertObject` or
	 * `RemoveObject`.
	 */
	['#flushObjects']() {
		// Bail early if there's no work
		if (this.#insertObjects.length + this.#removeObjects.size === 0) {
			return;
		}
		this.#findCache.clear();
		// Remove objects
		let removeCount = this.#removeObjects.size;
		if (removeCount) {
			for (let ii = this['#objects'].length - 1; ii >= 0; --ii) {
				const object = this['#objects'][ii];
				if (this.#removeObjects.has(object)) {
					object['#afterRemove'](this);
					this._removeFromIndex(object);
					this['#objects'].splice(ii, 1);
					if (--removeCount === 0) {
						break;
					}
				}
			}

			this.#removeObjects.clear();
			if (removeCount !== 0) {
				throw new Error('Removed objects mismatch');
			}
		}
		// Insert objects
		if (this.#insertObjects.length) {
			this['#objects'].push(...this.#insertObjects as never[]);
			for (const object of this.#insertObjects) {
				this._addToIndex(object);
				object['#afterInsert'](this);
			}
			this.#insertObjects = [];
		}
	}

	/**
	 * Queue an object to be inserted into this room. This is flushed via `FlushObjects`.
	 */
	['#insertObject'](object: RoomObject, now = false) {
		if (now) {
			this.#findCache.clear();
			this['#objects'].push(object as never);
			this._addToIndex(object);
			object['#afterInsert'](this);
		} else {
			this.#insertObjects.push(object);
		}
	}

	/**
	 * Queue an object to be removed from this room. This is flushed via `FlushObjects`.
	 */
	['#removeObject'](object: RoomObject) {
		this.#removeObjects.add(object);
	}

	/**
	 * Move an object to a new position within this room. This is reflected in the local room state
	 * immediately.
	 */
	['#moveObject'](object: RoomObject, pos: RoomPosition) {
		const oldPosition = object.pos['#int'];
		const oldList = this.#spatialIndex.get(oldPosition)!;
		if (oldList.length === 1) {
			this.#spatialIndex.delete(oldPosition);
		} else {
			removeOne(oldList, object);
		}
		const posInteger = pos['#int'];
		const newList = this.#spatialIndex.get(posInteger);
		if (newList) {
			newList.push(object);
		} else {
			this.#spatialIndex.set(posInteger, [ object ]);
		}
		object.pos = pos;
	}

	/**
	 * Add an object to the look and spatial indices
	 */
	// TODO: JS private method
	_addToIndex(object: RoomObject) {
		this.#lookIndex.get(object['#lookType'])!.push(object);
		const pos = object.pos['#int'];
		const list = this.#spatialIndex.get(pos);
		if (list) {
			list.push(object);
		} else {
			this.#spatialIndex.set(pos, [ object ]);
		}
	}

	/**
	 * Remove an object from the look and spatial indices
	 */
	// TODO: JS private method
	_removeFromIndex(object: RoomObject) {
		removeOne(this.#lookIndex.get(object['#lookType'])!, object);
		const pos = object.pos['#int'];
		const list = this.#spatialIndex.get(pos)!;
		if (list.length === 1) {
			this.#spatialIndex.delete(pos);
		} else {
			removeOne(list, object);
		}
	}

	/**
	 * Enumerable objects properties like `.storage` and `.controller` are removed from the JSON
	 * serialized data because otherwise there will be circular references.
	 */
	toJSON() {
		const result: any = {};
		for (const ii in this) {
			const value: any = this[ii];
			if (!(typeof value === 'object' && value.room === this)) {
				result[ii] = this[ii];
			}
		}
		return result;
	}

	toString() {
		return `[Room ${this.name}]`;
	}

	[Symbol.for('nodejs.util.inspect.custom')](depth: number, options: InspectOptionsStylized) {
		// Every object has a `room` property so flatten this reference out unless it's a direct
		// inspection
		if (depth === options.depth) {
			return this;
		} else {
			return `[Room ${options.stylize(this.name, 'string')}]`;
		}
	}
}

// Export `Room` to runtime globals
registerGlobal(Room);
declare module 'xxscreeps/game/runtime' {
	interface Global { Room: typeof Room }
}

export function getUsersInRoom(room: Room) {
	const users = new Set<string>();
	for (const objects of room['#objects']) {
		const user = objects['#runnerUser']();
		if (user !== null && user.length > 2) {
			users.add(user);
		}
	}
	return users;
}
