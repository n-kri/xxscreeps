import type { KeyValProvider, Provider } from './provider';

export class Queue<Type> {
	private currentVersion = 'initial';
	constructor(
		private readonly provider: KeyValProvider,
		private readonly key: string,
		private readonly json: boolean,
	) {}

	static connect<Type extends string = string>(provider: Provider, key: string, json?: false): Queue<Type>;
	static connect<Type>(provider: Provider, key: string, json: true): Queue<Type>;
	static connect(provider: Provider, key: string, json = false) {
		return new Queue<any>(provider.ephemeral, key, json);
	}

	async clear() {
		return this.provider.sflush(this.getKey());
	}

	async pop(): Promise<Type | undefined> {
		const value = await this.provider.spop(this.getKey());
		if (this.json) {
			return value === undefined ? undefined : JSON.parse(value);
		} else {
			return value as any;
		}
	}

	push(entries: Type[]): Promise<unknown> {
		const values = this.json ? entries.map(value => JSON.stringify(value)) : entries;
		return this.provider.sadd(this.getKey(), values as string[]);
	}

	version(version: string) {
		this.currentVersion = version;
	}

	async *[Symbol.asyncIterator]() {
		for (
			let value = await this.pop();
			value !== undefined;
			value = await this.pop()
		) {
			yield value;
		}
	}

	private getKey() {
		return `queue/${this.key}/${this.currentVersion}`;
	}
}
