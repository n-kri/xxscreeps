import config from 'xxscreeps/config';
import * as User from 'xxscreeps/engine/db/user';
import { checkArguments } from 'xxscreeps/config/arguments';
import { Worker, waitForWorker } from 'xxscreeps/utility/worker';
import { Database, Shard } from 'xxscreeps/engine/db';
import { getConsoleChannel } from 'xxscreeps/engine/runner/model';
import { getServiceChannel } from '.';

const argv = checkArguments({
	boolean: [ 'no-backend', 'no-processor', 'no-runner' ] as const,
	string: [ 'attach-console' ] as const,
});

// Connect to shard
const db = await Database.connect();
const shard = await Shard.connect(db, 'shard0');

try {

	// Attach console for given user
	if (argv['attach-console']) {
		const id = await User.findUserByName(db, argv['attach-console']);
		if (!id) {
			throw new Error(`User: ${argv['attach-console']} not found`);
		}
		const channel = await getConsoleChannel(shard, id).subscribe();
		channel.listen(message => {
			for (const line of JSON.parse(message)) {
				if (line.fd === 1) {
					console.log(line.data);
				} else {
					console.error(line.data);
				}
			}
		});
	}

	// Start main service
	const [ , waitForMain ] = getServiceChannel(shard).listenFor(message => message.type === 'mainConnected');
	const main = import('./main');
	await Promise.race([ main, waitForMain ]);

	// Start workers
	const singleThreaded = config.launcher?.singleThreaded;
	const { services, backend } = await async function() {
		if (singleThreaded) {
			const backend = argv['no-backend'] ? undefined : import('xxscreeps/backend/server');
			const processor = argv['no-processor'] ? undefined : import('./processor');
			const runner = argv['no-runner'] ? undefined : import('./runner');
			const services = Promise.all([ main, processor, runner ]);
			return { services, backend };
		} else {
			const [ backend, processor, runner ] = await Promise.all([
				argv['no-backend'] ? undefined : Worker.create('xxscreeps/backend/server'),
				argv['no-processor'] ? undefined : Worker.create('xxscreeps/engine/service/processor'),
				argv['no-runner'] ? undefined : Worker.create('xxscreeps/engine/service/runner'),
			]);
			const services = Promise.all([ main, processor && waitForWorker(processor), runner && waitForWorker(runner) ]);
			return { services, backend };
		}
	}();
	await Promise.all([
		services.then(() => console.log('💾 Engine shut down successfully.')),
		backend,
	]);

} finally {
	db.disconnect();
	shard.disconnect();
}
