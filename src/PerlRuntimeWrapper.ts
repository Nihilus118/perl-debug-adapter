/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { StreamCatcher } from './streamCatcher';

export interface IRuntimeBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IRuntimeStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
	instruction?: number;
}

interface IRuntimeStack {
	count: number;
	frames: IRuntimeStackFrame[];
}

export type IRuntimeVariableType = number | boolean | string | RuntimeVariable[];

export class RuntimeVariable {
	private _memory?: Uint8Array;

	public reference?: number;

	public get value() {
		return this._value;
	}

	public set value(value: IRuntimeVariableType) {
		this._value = value;
		this._memory = undefined;
	}

	public get memory() {
		if (this._memory === undefined && typeof this._value === 'string') {
			this._memory = new TextEncoder().encode(this._value);
		}
		return this._memory;
	}

	constructor(public readonly name: string, private _value: IRuntimeVariableType) { }

	public setMemory(data: Uint8Array, offset = 0) {
		const memory = this.memory;
		if (!memory) {
			return;
		}

		memory.set(data, offset);
		this._memory = memory;
		this._value = new TextDecoder().decode(memory);
	}
}

export class PerlRuntimeWrapper extends EventEmitter {
	// the perl cli session
	private _session!: ChildProcess;
	// helper to run commands and parse output
	private streamCatcher: StreamCatcher;
	private lastArgs: [string, boolean, boolean] | undefined;

	// maps from sourceFile to array of IRuntimeBreakpoint
	private _breakPoints = new Map<string, IRuntimeBreakpoint[]>();
	public get breakPoints() {
		return this._breakPoints;
	}

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private breakpointId = 1;
	private _lastSTDOUT: any;

	constructor() {
		super();
		this.streamCatcher = new StreamCatcher();
	}

	destry() {
		this._session.kill();
	}

	// Start executing the given program.
	public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
		this.lastArgs = [program, stopOnEntry, debug];

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
		];

		this._session = spawn(
			'perl',
			commandArgs,
			spawnOptions
		);

		await this.streamCatcher.launch(
			this._session.stdin!,
			this._session.stderr!
		);

		this._session.stdout!.on('data', (data) => {
			this.emit('output', data.toString());
		});

		await this.request("h\n");

		if (stopOnEntry && debug) {
			await this.step();
		} else {
			await this.continue();
		}
	}

	async request(command: string): Promise<string[]> {
		return await this.streamCatcher.request(command);
	}

	public async continue() {
		const lines = await this.request('c\n');
		const end = lines.join().includes('Debugged program terminated.');
		if (end) {
			this.emit('end');
		}
		this.emit('stopOnBreakpoint');
	}

	public async getBreakpoints() {
		const lines = await this.request("L");
		// TODO: Parse breakpoints
		return lines;
	}

	public async step() {
		await this.request('n\n');
		this.emit('stopOnStep');
	}

	public async stepIn() {
		await this.request('s\n');
		this.emit('stopOnStep');
	}

	public async stepOut() {
		await this.request('r\n');
		this.emit('stopOnStep');
	}

	public async restart() {
		await this.request('q\n');
		await this.start(...this.lastArgs!);
	}

	public async terminate() {
		await this.request('q\n');
		this.emit('end');
	}

	public async clearAllDataBreakpoints() {
		await this.request("B *\n");
	}

	public async setDataBreakpoint(): Promise<boolean> {
		await this.request(`b *\n`);
		// TODO: Validate Breakpoint
		return true;
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public async stack(): Promise<IRuntimeStack> {
		const frames: IRuntimeStackFrame[] = [];

		// Run command and await the Output
		const lines = await this.request('T\n') || [];
		// TODO: Regex to validate data

		return {
			frames: frames,
			count: frames.length
		};
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint> {
		path = this.normalizePathAndCasing(path);
		// remember the set breakpoints
		let bps = this.breakPoints.get(path);
		if (!bps) {
			bps = new Array<IRuntimeBreakpoint>();
			this.breakPoints.set(path, bps);
		}

		// TODO: Set and parse breakpoints
		let success = true;
		while (!success && this._session) {
			const data = (await this.request(`b ${line}\n`)).join("");
			if (data.includes('not breakable')) {
				// try again at the next line
				line++;
			} else {
				// a breakable line was found and the breakpoint set
				success = true;
			}
		}
		const bp: IRuntimeBreakpoint = { verified: success, line, id: this.breakpointId++ };
		bps.push(bp);

		return bp;
	}

	public async clearBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint | undefined> {
		// get all breakpoints for file
		const bps = this.breakPoints.get(this.normalizePathAndCasing(path));
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				await this.request(`B ${bp.line}\n`);
				return bp;
			}
		}
		return undefined;
	}

	public async clearBreakpoints(path: string): Promise<void> {
		// delete all breakpoints
		if (this._session) {
			await this.request('B *\n');
		}
		this.breakPoints.delete(this.normalizePathAndCasing(path));
	}

	public async getGlobalVariables(cancellationToken?: () => boolean): Promise<RuntimeVariable[]> {

		let a: RuntimeVariable[] = [];

		const lines = await this.request('X\n');
		// TODO: parsing
		for (let i = 0; i < lines.length; i++) {
			a.push(new RuntimeVariable(`global_${i}`, i));
			if (cancellationToken && cancellationToken()) {
				break;
			}
		}

		return a;
	}

	public async getLocalVariables(): Promise<RuntimeVariable[]> {
		const lines = await this.request('X\n');
		// TODO: parse data and create RunTimeVariable objects
		let a: RuntimeVariable[] = [];
		return a;
	}

	public async getLocalVariable(name: string): Promise<RuntimeVariable | undefined> {
		const command = `x \\${name}\n`;
		const lines = await this.request(command);
		// TODO: Parse local variables
		if (this._lastSTDOUT) {
			if (!this._lastSTDOUT.includes("empty")) {
				const lines = this._lastSTDOUT!.split("\n");
				const type = lines[0].split(" ")[1].split("(")[0];
				let value = "";
				// TODO: parse stdout and create RunTimeVariable object

				switch (type) {
					case 'SCALAR':
						value = lines[1].split("-> ")[1];
						break;
					case 'ARRAY':

						break;
					case 'HASH':

						break;

					default:
						break;
				}

				let a: RuntimeVariable = new RuntimeVariable(value, type);
				return a;
			}
		}

		return undefined;
	}

	private normalizePathAndCasing(path: string) {
		if (process.platform === 'win32') {
			return path.replace(/\//g, '\\').toLowerCase();
		} else {
			return path.replace(/\\/g, '/');
		}
	}
}
