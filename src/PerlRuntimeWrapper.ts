/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { logger } from '@vscode/debugadapter';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { IBreakpointData, IFunctionBreakpointData } from './perlDebug';
import { ansiSeq, StreamCatcher } from './streamCatcher';

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

	destroy() {
		this._session.kill();
	}

	// Start executing the given program.
	public async start(perlExecutable: string, program: string, stopOnEntry: boolean, debug: boolean, args: string[], bps: IBreakpointData[], funcBps: IFunctionBreakpointData[], argCWD: string): Promise<void> {
		// Spawn perl process and handle errors
		argCWD = this.normalizePathAndCasing(argCWD);
		logger.log(`CWD: ${argCWD}`);
		logger.log(`ENV: ${JSON.stringify(process.env)}`);
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: argCWD,
			env: {
				...process.env,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				COLUMNS: '80',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				LINES: '25',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				TERM: 'dumb'
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

		// save the last output in case of an error
		let output: string = "";
		this._session.stderr!.on('data', (data) => {
			output = data.toString();
		});

		this._session.on('exit', code => {
			// print the error if we can not start the debugger
			logger.error(`Could not start the debugging session! Code: ${code}\n${output}`);
			this.emit('end');
			return;
		});

		// send the script output to the debug console
		this._session.stdout!.on('data', (data) => {
			this.emit('output', data.toString().replace(ansiSeq, ''));
		});

		await this.streamCatcher.launch(
			this._session.stdin!,
			this._session.stderr!
		);

		// does the user want to debug the script or just run it?
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
				const file = this.normalizePathAndCasing(bps[i].file);
				const condition = bps[i].condition;
				let line = bps[i].line;
				let success = false;
				// try to set the breakpoint
				for (let tries = 0; success === false && tries < this.maxBreakpointTries; tries++) {
					// try to set the breakpoint
					const data = (await this.request(`b ${file}:${line} ${condition}`)).join("");
					if (data.includes('not breakable')) {
						// try again at the next line
						line++;
					} else {
						// a breakable line was found and the breakpoint set
						this.emit('breakpointValidated', [id, line]);
						success = true;
					}
				}
			}
			// set function breakpoints
			for (let i = 0; i < funcBps.length; i++) {
				const bp = funcBps[i];
				const data = (await this.request(`b ${bp.name} ${bp.condition}`))[1];
				if (data.includes('not found')) {
					// try again at the next line
					this.emit('OutputEvent', data, 'stderr');
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
		logger.log(`Command: ${command}`);
		return (await this.streamCatcher.request(command)).filter(e => { return e !== ''; });
	}

	public async getBreakpoints() {
		const lines = await this.request("L b");
		// TODO: Parse breakpoints
		return lines;
	}

	private isEnd(lines: string[], event: string): boolean {
		const text = lines.join();

		if (text.includes('Debugged program terminated.')) {
			// did the script die?
			const index = lines.findIndex(e => {
				return e.includes('Debugged program terminated.');
			});
			lines = lines.slice(1, index);
			this.emit('output', lines.join('\n'));
			this.emit('end');
			return true;
		}

		this.emit(event);
		return false;
	}

	public async continue() {
		this.isEnd(await this.request('c'), 'stopOnBreakpoint');
	}

	public async step(signal: string = 'stopOnStep') {
		this.isEnd(await this.request('n'), signal);
	}

	public async stepIn() {
		this.isEnd(await this.request('s'), 'stopOnStep');
	}

	public async stepOut() {
		this.isEnd(await this.request('r'), 'stopOnStep');
	}

	public isActive(): boolean {
		const type = typeof this.streamCatcher.input;
		if (type !== 'undefined' && this.streamCatcher.input) {
			return true;
		} else {
			return false;
		}
	}

	public normalizePathAndCasing(path: string) {
		if (process.platform === 'win32') {
			return path.replace(/\//g, '\\').toLowerCase();
		} else {
			return path.replace(/\\/g, '/');
		}
	}
}
