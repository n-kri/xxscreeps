import type { Shard } from './shard';
import { Channel } from 'xxscreeps/storage/channel';
import { makeReader } from 'xxscreeps/schema';
import * as Flag from 'xxscreeps/engine/runner/flag';
import * as Visual from 'xxscreeps/game/visual';

type ConsoleMessage =
	{ type: 'log'; value: string } |
	{ type: 'error'; value: string } |
	{ type: 'result'; value: string };

export function getConsoleChannel(shard: Shard, user: string) {
	return new Channel<ConsoleMessage>(shard.pubsub, `user/${user}/console`);
}

/**
 * Load the unparsed flag blob for a user
 */
export async function loadUserFlagBlob(shard: Shard, user: string) {
	try {
		return await shard.blob.getBuffer(`user/${user}/flags`);
	} catch (err) {}
}

/**
 * Load a user's flags and return the game objects
 */
export async function loadUserFlags(shard: Shard, user: string) {
	const flagBlob = await loadUserFlagBlob(shard, user);
	if (flagBlob) {
		return Flag.read(flagBlob);
	} else {
		return Object.create(null) as never;
	}
}

/**
 * Save a user's processed flag blob
 */
export async function saveUserFlagBlobForNextTick(shard: Shard, user: string, flagBlob: Readonly<Uint8Array>) {
	await shard.blob.set(`user/${user}/flags`, flagBlob);
	await getFlagChannel(shard, user).publish({ type: 'updated' });
}

const visualsReader = makeReader(Visual.schema);
export async function loadVisuals(shard: Shard, user: string, time: number) {
	const fragment = `visual${time % 2}`;
	try {
		return visualsReader(await shard.blob.getBuffer(`user/${user}/${fragment}`));
	} catch (err) {}
}

export async function saveVisualsBlob(shard: Shard, user: string, time: number, visual: Readonly<Uint8Array> | undefined) {
	const fragment = `visual${time % 2}`;
	if (visual) {
		await shard.blob.set(`user/${user}/${fragment}`, visual);
	} else {
		try {
			await shard.blob.del(`user/${user}/${fragment}`);
		} catch (err) {}
	}
}

/**
 * Return a reference to the user's flag channel
 */
type UserFlagMessage = { type: 'updated' };
export function getFlagChannel(shard: Shard, user: string) {
	return new Channel<UserFlagMessage>(shard.pubsub, `user/${user}/flags`);
}

//
// User memory functions
export async function loadUserMemoryBlob(shard: Shard, user: string) {
	return shard.blob.getBuffer(`memory/${user}`).catch(() => undefined);
}