import { createSandbox, Sandbox } from '~/driver/sandbox';
import * as User from '~/engine/metadata/user';
import type { Shard } from '~/engine/model/shard';
import { getConsoleChannel, loadUserFlagBlob, loadUserMemoryBlob, saveUserFlagBlobForNextTick } from '~/engine/model/user';
import { exchange, filterInPlace, mapInPlace } from '~/lib/utility';
import type { Subscription } from '~/storage/channel';
import { getRunnerUserChannel, RunnerIntent, RunnerUserMessage } from './channel';

export class PlayerInstance {
	private branch: string;
	private readonly consoleChannel: ReturnType<typeof getConsoleChannel>;
	public consoleEval?: string[];
	public intents?: RunnerIntent[];
	private sandbox?: Sandbox;
	private stale = false;
	private readonly userId: string;
	public roomsVisible: Set<string>;

	constructor(
		private readonly shard: Shard,
		user: User.User,
		private readonly channel: Subscription<RunnerUserMessage>,
	) {
		this.branch = user.code.branch;
		this.roomsVisible = user.roomsVisible;
		this.userId = user.id;
		this.consoleChannel = getConsoleChannel(this.shard, this.userId);

		// Listen for various messages probably sent from backend
		channel.listen(message => {
			switch (message.type) {
				case 'code':
					this.branch = message.id;
					this.stale = true;
					break;

				case 'eval':
					(this.consoleEval ?? (this.consoleEval = [])).push(message.expr);
					break;

				case 'intent': {
					(this.intents ?? (this.intents = [])).push(message.intent);
					break;
				}

				default:
			}
		});
	}

	static async create(shard: Shard, userId: string) {
		// Connect to channel, load initial user data
		const [ channel, userBlob ] = await Promise.all([
			getRunnerUserChannel(shard, userId).subscribe(),
			shard.storage.persistence.get(`user/${userId}/info`),
		]);
		const user = User.read(userBlob);
		return new PlayerInstance(shard, user, channel);
	}

	disconnect() {
		this.channel.disconnect();
		this.sandbox?.dispose();
	}

	async run(time: number, roomBlobs: Readonly<Uint8Array>[]) {
		// Dispose the current sandbox if the user has pushed new code
		if (this.stale) {
			this.sandbox!.dispose();
			this.sandbox = undefined;
		}

		// If there's no sandbox load the required data and initialize
		if (!this.sandbox) {
			const [ codeBlob, flagBlob, memoryBlob ] = await Promise.all([
				this.shard.storage.persistence.get(`user/${this.userId}/${this.branch}`),
				loadUserFlagBlob(this.shard, this.userId),
				loadUserMemoryBlob(this.shard, `memory/${this.userId}`),
			]);
			this.sandbox = await createSandbox({
				userId: this.userId,
				codeBlob, flagBlob, memoryBlob,
				terrainBlob: this.shard.terrainBlob,
				writeConsole: (fd, payload) => {
					this.consoleChannel.publish({ type: 'console', log: payload }).catch(console.error);
				},
			});
		}

		// Run the tick
		const result = await (async() => {
			try {
				return await this.sandbox!.run({
					time,
					roomBlobs,
					consoleEval: exchange(this, 'consoleEval'),
					userIntents: exchange(this, 'intents'),
				});
			} catch (err) {
				console.error(err.stack);
				return { flagBlob: undefined, intentBlobs: {}, memory: undefined };
			}
		})();

		// Save runtime results
		const [ savedRoomNames ] = await Promise.all([
			// Save intent blobs
			mapInPlace(Object.entries(result.intentBlobs), async([ roomName, intents ]) => {
				if (this.roomsVisible.has(roomName)) {
					await this.shard.storage.persistence.set(`intents/${roomName}/${this.userId}`, new Uint8Array(intents!));
					return roomName;
				} else {
					console.error(`Runtime sent intent for non-visible room. User: ${this.userId}; Room: ${roomName}; Tick: ${time}`);
				}
			}),

			// Save flags
			// TODO: Maybe some kind of sanity check on the blob since it was generated by a
			// runner?
			result.flagBlob && saveUserFlagBlobForNextTick(this.shard, this.userId, result.flagBlob),

			// Save memory
			result.memory && this.shard.storage.persistence.set(`memory/${this.userId}`, result.memory),
		]);

		// Return affected room
		return [ ...filterInPlace(await Promise.all(savedRoomNames)) ];
	}
}
