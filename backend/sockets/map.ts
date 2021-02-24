import type { Implementation } from 'xxscreeps/util/types';
import * as Room from 'xxscreeps/engine/schema/room';
import type { RoomObject } from 'xxscreeps/game/objects/room-object';
import { Creep } from 'xxscreeps/game/objects/creep';
import { Structure } from 'xxscreeps/game/objects/structures';
import { StructureController } from 'xxscreeps/game/objects/structures/controller';
import { StructureRoad } from 'xxscreeps/game/objects/structures/road';
import { getOrSet } from 'xxscreeps/util/utility';
import { SubscriptionEndpoint } from '../socket';

type Position = [ number, number ];

// Register a map renderer on a `RoomObject` type
const MapRender = Symbol('mapRender');
declare module 'xxscreeps/game/objects/room-object' {
	interface RoomObject {
		[MapRender]?: (object: any) => string | undefined;
	}
}
export function bindMapRenderer<Type extends RoomObject>(object: Implementation<Type>, render: (object: Type) => string | undefined) {
	object.prototype[MapRender] = render;
}
bindMapRenderer(Creep, creep => creep._owner);
bindMapRenderer(Structure, structure => structure._owner ?? undefined);
bindMapRenderer(StructureController, () => 'c');
bindMapRenderer(StructureRoad, () => 'r');

export const mapSubscription: SubscriptionEndpoint = {
	pattern: /^roomMap2:(?<room>[A-Z0-9]+)$/,

	async subscribe(parameters) {
		const roomName = parameters.room;
		if (!this.context.accessibleRooms.has(roomName)) {
			// The client sends subscription requests for rooms that don't exist. Filter those out here to
			// avoid unneeded subscriptions.
			return () => {};
		}
		let lastTickTime = 0;
		let previous = '';
		const update = async() => {
			lastTickTime = Date.now();
			const roomBlob = await this.context.persistence.get(`room/${roomName}`);
			const room = Room.read(roomBlob);
			const response = new Map<string, Position[]>();
			for (const object of room._objects) {
				const record = function() {
					const key = object[MapRender]?.(object);
					if (key !== undefined) {
						return getOrSet(response, key, () => []);
					}
				}();
				record?.push([ object.pos.x, object.pos.y ]);
			}

			const payload = JSON.stringify(response);
			if (payload !== previous) {
				previous = payload;
				this.send(payload);
			}
		};
		await update();
		return this.context.gameChannel.listen(event => {
			if (event.type === 'tick' && Date.now() > lastTickTime + 250) {
				update().catch(error => console.error(error));
			}
		});
	},
};
