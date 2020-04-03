import { makeResolver } from '~/lib/utility';
import { Channel } from '~/storage/channel';
import { connect, create, Responder, ResponderClient, ResponderHost } from '~/storage/responder';

type Message = 'waiting' | 'unlocked';

export class Mutex {
	private lockedOrPending = false;
	private yieldPromise?: Promise<void>;
	private waitingListener?: () => void;
	private readonly localQueue: (() => void)[] = [];
	constructor(
		private readonly channel: Channel<Message>,
		private readonly lockable: Lock,
	) {}

	static async connect(name: string) {
		const [ channel, lock ] = await Promise.all([
			Channel.connect<Message>(`mutex:channel:${name}`),
			Lock.connect(`mutex:${name}`),
		]);
		return new Mutex(channel, lock);
	}

	static async create(name: string) {
		const [ channel, lock ] = await Promise.all([
			Channel.connect<Message>(`mutex:channel:${name}`),
			Lock.create(`mutex:${name}`),
		]);
		return new Mutex(channel, lock);
	}

	disconnect() {
		this.channel.disconnect();
		this.lockable.disconnect();
	}

	async lock() {
		if (this.lockedOrPending) {
			// Already locked locally
			const [ locked, lockedResolver ] = makeResolver<void>();
			this.localQueue.push(lockedResolver.resolve);
			return locked;
		} else if (this.waitingListener) {
			// If the listener is still attached it means no one else wanted the lock
			this.lockedOrPending = true;
			return;
		}
		this.lockedOrPending = true;
		// If we're yielding send message that we want the lock back
		if (this.yieldPromise) {
			this.channel.publish('waiting');
			await this.yieldPromise;
		}
		// Listen for peers who want the lock
		this.waitingListener = this.channel.listen(message => {
			if (message === 'waiting') {
				this.waitingListener!();
				this.waitingListener = undefined;
				if (!this.lockedOrPending) {
					// If a peer is waiting while this is soft locked then yield next time we try to lock
					this.yieldLock().catch(console.error);
				}
			}
		});
		if (await this.lockable.lock()) {
			// Lock with no contention
			return;
		}
		// Must wait for lock
		const [ locked, lockedResolver ] = makeResolver<void>();
		const tryLock = () => {
			this.lockable.lock().then(locked => {
				if (locked) {
					lockedResolver.resolve();
				} else {
					this.channel.publish('waiting');
				}
			}, lockedResolver.reject);
		};
		// Listen for unlock messages and try to lock again
		const unlisten = this.channel.listen(message => {
			if (message === 'unlocked') {
				tryLock();
			}
		});
		// Also keep trying in case the peer gave up
		const timer = setInterval(tryLock, 500);
		// Wait on the lock
		try {
			tryLock();
			await locked;
		} finally {
			clearInterval(timer);
			unlisten();
		}
	}

	async unlock() {
		if (this.lockedOrPending) {
			// If there's more waiting locally then run them
			if (this.localQueue.length !== 0) {
				const next = this.localQueue.shift();
				next!();
				return;
			}
			this.lockedOrPending = false;
			if (!this.waitingListener) {
				// If there's a peer waiting for the lock then give them a chance to get it
				await this.yieldLock();
			}
		} else {
			throw new Error('Not locked');
		}
	}

	async scope<Type>(callback: () => Promise<Type>): Promise<Type> {
		await this.lock();
		try {
			return await callback();
		} finally {
			await this.unlock();
		}
	}

	private async yieldLock() {
		this.yieldPromise = new Promise(resolve => {
			const finish = () => {
				clearInterval(timer);
				unlisten();
				this.yieldPromise = undefined;
				resolve();
			};
			const timer = setTimeout(finish, 500);
			const unlisten = this.channel.listen(message => {
				if (message === 'unlocked') {
					finish();
				}
			});
		});
		await this.lockable.unlock();
		this.channel.publish('unlocked');
	}
}

abstract class Lock extends Responder {
	abstract lock(): Promise<boolean>;
	abstract unlock(): Promise<void>;

	static connect(name: string): Promise<Lock> {
		return connect(name, LockClient, LockHost);
	}

	static create(name: string): Promise<Lock> {
		return Promise.resolve(create(name, LockHost));
	}

	request(method: 'lock'): Promise<boolean>;
	request(method: 'unlock'): Promise<void>;
	request(method: string) {
		if (method === 'lock') {
			return this.lock();
		} else if (method === 'unlock') {
			return this.unlock();
		} else {
			return Promise.reject(new Error(`Unknown method: ${method}`));
		}
	}
}

const LockHost = ResponderHost(class LockHost extends Lock {
	private locked = false;

	lock() {
		if (this.locked) {
			return Promise.resolve(false);
		}
		return Promise.resolve(this.locked = true);
	}

	unlock() {
		this.locked = false;
		return Promise.resolve();
	}
});

const LockClient = ResponderClient(class LockClient extends Lock {
	lock() {
		return this.request('lock');
	}

	unlock() {
		return this.request('unlock');
	}
});