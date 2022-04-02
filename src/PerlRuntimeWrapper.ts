/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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

	// maps from sourceFile to array of IRuntimeBreakpoint
	private _breakPoints = new Map<string, IRuntimeBreakpoint[]>();
	public get breakPoints() {
		return this._breakPoints;
	}

	constructor() {
		super();
		this.streamCatcher = new StreamCatcher();
	}

	destry() {
		this._session.kill();
	}

	// Start executing the given program.
	public async start(perlExecutable: string, program: string, stopOnEntry: boolean, debug: boolean, args: string[], bps: IBreakpointData[]): Promise<void> {
		// Spawn perl process and handle errors
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: undefined,
			env: {
				TERM: 'dumb',
				...process.env,
			},
		};

		program = this.normalizePathAndCasing(program);
		const commandArgs = [
			'-d',
			program,
			...args
		];

		this._session = spawn(
			perlExecutable,
			commandArgs,
			spawnOptions
		);

		this._session.on('error', err => {
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


		if (debug) {
			// use PadWalker to access variables in scope
			const lines = await this.request('use PadWalker qw/peek_our peek_my/; use JSON;');
			if (lines.join().includes('Can\'t locate')) {
				this.emit('output', `Couldn't start the Debugger! Modules JSON and PadWalker are required to run this debugger. Please install them and try again.`);
				this.emit('end');
			}
			// set breakpoints
			for (let i = 0; i < bps.length; i++) {
				const bp = bps[i];
				let line = bp.line;
				let success = false;
				while (success === false) {
					const data = (await this.request(`b ${line}`)).join("");
					if (data.includes('not breakable')) {
						// try again at the next line
						line++;
					} else {
						// a breakable line was found and the breakpoint set
						this.emit('breakpointValidated', [true, line, bp.id]);
						success = true;
					}
				}
			}
			if (stopOnEntry) {
				this.emit('stopOnEntry');
			} else {
				await this.continue();
			}
		} else {
			await this.continue();
		}
	}

	async request(command: string): Promise<string[]> {
		return (await this.streamCatcher.request(command)).filter(function (e) { return e; });
	}

	public async continue() {
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
		const lines = await this.request("L b");
		// TODO: Parse breakpoints
		return lines;
	}

	public async step(signal: string = 'stopOnStep') {
		const lines = await this.request('n');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit(signal);
	}

	public async stepIn() {
		const lines = await this.request('s');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit('stopOnStep');
	}

	public async stepOut() {
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
