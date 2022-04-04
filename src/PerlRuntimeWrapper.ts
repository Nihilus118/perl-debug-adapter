/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { logger } from '@vscode/debugadapter';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { IBreakpointData } from './perlDebug';
import { StreamCatcher } from './streamCatcher';

export interface IRuntimeBreakpoint {
	line: number;
	verified: boolean;
}

export class PerlRuntimeWrapper extends EventEmitter {
	// the perl cli session
	private _session!: ChildProcess;
	// helper to run commands and parse output
	private streamCatcher: StreamCatcher;
	// max tries to set a breakpoint
	private maxBreakpointTries: number = 10;

	constructor() {
		super();
		this.streamCatcher = new StreamCatcher();
	}

	destry() {
		this._session.kill();
	}

	// Start executing the given program.
	public async start(perlExecutable: string, program: string, stopOnEntry: boolean, debug: boolean, args: string[], bps: IBreakpointData[], argCWD: string): Promise<void> {
		// Spawn perl process and handle errors
		argCWD = this.normalizePathAndCasing(argCWD);
		logger.log(`CWD: ${argCWD}`);
		logger.log(`ENV: ${JSON.stringify(process.env)}`);
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: argCWD,
			env: {
				TERM: 'dumb',
				...process.env,
			},
		};

		program = this.normalizePathAndCasing(program);
		logger.log(`Script: ${program}`);
		const commandArgs = [
			'-d',
			program,
			...args
		];

		logger.log(`Perl executable: ${perlExecutable}`);
		this._session = spawn(
			perlExecutable,
			commandArgs,
			spawnOptions
		);

		this._session.on('error', err => {
			logger.error(`Couldn't start the Debugger! ${err.name} : ${err.message}`);
			this.emit('output', `Couldn't start the Debugger! ${err.name} : ${err.message}`);
			this.emit('end');
			return;
		});

		this._session.stdout!.on('data', (data) => {
			this.emit('output', data.toString());
		});

		await this.streamCatcher.launch(
			this._session.stdin!,
			this._session.stderr!
		);

		// Does the user want to debug the script or just run it?
		if (debug) {
			logger.log('Starting Debug');
			// use PadWalker to access variables in scope and JSON the send data to perlDebug.ts
			const lines = await this.request('use PadWalker qw/peek_our peek_my/; use JSON; use Data::Dumper;');
			if (lines.join().includes('Can\'t locate')) {
				this.emit('output', `Couldn't start the Debugger! Modules JSON, Data::Dumper and PadWalker are required to run this debugger. Please install them and try again.`);
				this.emit('end');
			}
			// set breakpoints
			for (let i = 0; i < bps.length; i++) {
				const id = bps[i].id;
				if (this.normalizePathAndCasing(program) !== this.normalizePathAndCasing(bps[i].file)) {
					// perl5db can not set breakpoints outside of the main file so we delete them
					this.emit('breakpointDeleted', id);
				} else {
					// now try to set the breakpoint
					let line = bps[i].line;
					let success = false;
					for (let tries = 0; success === false; tries++) {
						if (tries > this.maxBreakpointTries) {
							// perl5db could not set the breakpoint
							this.emit('breakpointDeleted', id);
							break;
						}
						// try to set the breakpoint
						const data = (await this.request(`b ${line}`)).join("");
						if (data.includes('not breakable')) {
							// try again at the next line
							line++;
						} else {
							// a breakable line was found and the breakpoint set
							this.emit('breakpointValidated', [true, line, id]);
							success = true;
						}
					}
				}
			}
			logger.log(`StopOnEntry: ${stopOnEntry}`);
			if (stopOnEntry) {
				this.emit('stopOnEntry');
			} else {
				await this.continue();
			}
		} else {
			// Just run
			await this.continue();
		}
	}

	async request(command: string): Promise<string[]> {
		// logger.log(`Command: ${command}`);
		return (await this.streamCatcher.request(command)).filter(function (e) { return e; });
	}

	public async continue() {
		logger.log('continue');
		const lines = await this.request('c');
		const text = lines.join();
		if (text.includes('Debugged program terminated.')) {
			if (text.includes('Died')) {
				this.emit('output', lines.find(e => {
					return e.includes('Died');
				}) as string);
			}
			this.emit('end');
		} else {
			this.emit('stopOnBreakpoint');
		}
	}

	public async getBreakpoints() {
		logger.log('getBreakpoints');
		const lines = await this.request("L b");
		// TODO: Parse breakpoints
		return lines;
	}

	public async step(signal: string = 'stopOnStep') {
		logger.log('step');
		const lines = await this.request('n');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit(signal);
	}

	public async stepIn() {
		logger.log('stepIn');
		const lines = await this.request('s');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit('stopOnStep');
	}

	public async stepOut() {
		logger.log('stepOut');
		const lines = await this.request('r');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit('stopOnStep');
	}


	public normalizePathAndCasing(path: string) {
		if (process.platform === 'win32') {
			return path.replace(/\//g, '\\').toLowerCase();
		} else {
			return path.replace(/\\/g, '/');
		}
	}
}
