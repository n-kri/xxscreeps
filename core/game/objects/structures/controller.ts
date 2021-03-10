import * as C from 'xxscreeps/game/constants';
import * as Game from 'xxscreeps/game/game';
import { declare, compose, member, struct, variant, withOverlay } from 'xxscreeps/schema';
import * as Structure from '.';

export const DowngradeTime = Symbol('downgradeTime');
export const Progress = Symbol('progress');
export const UpgradeBlockedTime = Symbol('upgradeBlockedTime');

export function format() { return compose(shape, StructureController) }
const shape = declare('Controller', struct(Structure.format, {
	...variant('controller'),
	isPowerEnabled: 'bool',
	level: 'int32',
	// reservation: { username, ticksToEnd }
	safeMode: 'int32',
	safeModeAvailable: 'int32',
	safeModeCooldown: 'int32',
	// sign: { username, text, time, datetime }
	downgradeTime: member(DowngradeTime, 'int32'),
	progress: member(Progress, 'int32'),
	upgradeBlockedTime: member(UpgradeBlockedTime, 'int32'),
}));

export class StructureController extends withOverlay(Structure.Structure, shape) {
	get progress() { return this.level > 0 ? this[Progress] : undefined }
	get progressTotal() { return this.level > 0 && this.level < 8 ? C.CONTROLLER_LEVELS[this.level] : undefined }
	get structureType() { return C.STRUCTURE_CONTROLLER }
	get ticksToDowngrade() { return this[DowngradeTime] === 0 ? undefined : this[DowngradeTime] - Game.time }
	get upgradeBlocked() {
		if (this[UpgradeBlockedTime] === 0 || this[UpgradeBlockedTime] > Game.time) {
			return undefined;
		} else {
			return Game.time - this[UpgradeBlockedTime];
		}
	}

	_upgradePowerThisTick?: number; // processor
}