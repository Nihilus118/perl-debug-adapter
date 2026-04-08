import {
	Breakpoint, ContinuedEvent, Handles, InitializedEvent, logger, Logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, ThreadEvent, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as Net from 'net';
import { basename, dirname, join } from 'path';
import { Readable } from 'stream';
import { Writable } from 'stream';
import { ansiSeq, StreamCatcher } from './streamCatcher';
import unescapeJs from 'unescape-js';
import * as path from 'path';

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry: boolean;
	perlExecutable?: string;
	debug?: boolean;
	cwd?: string;
	args?: string[];
	env?: { [key: string]: string; };
	threaded?: boolean;
	trace?: boolean;
	escapeSpecialChars?: boolean;
	perl5db?: string;
	maxArrayElements?: number;
	maxHashElements?: number;
	sortKeys?: boolean;
	deepcopy?: boolean;
	wrapperCommand?: string[];
	transport?: 'stdio' | 'socket';
}

interface IFunctionBreakpointData {
	name: string,
	condition: string;
}

interface IBreakpointData {
	line: number,
	id: number,
	condition: string;
}

interface IDebuggerRuntime {
	threadId: number;
	name: string;
	streamCatcher: StreamCatcher;
	isPrimary: boolean;
	socket?: Net.Socket;
}

interface IScopeHandle {
	scope: 'my' | 'our' | 'special';
	threadId: number;
}

interface IContainerMeta {
	expression: string;
	type: 'ARRAY' | 'HASH';
	total: number;
}

interface IChunkMeta {
	parentExpression: string;
	type: 'ARRAY' | 'HASH';
	start: number;
	end: number;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;
	private static readonly variableRefStart = 10000;
	private static readonly maxVariableDumpContinueTries = 25;
	private currentBreakpointID = 1;

	private _variableHandles = new Handles<IScopeHandle>();
	private childVarsMap = new Map<number, Variable[]>();
	private parentVarsMap = new Map<number, Variable>();
	private varExpressionMap = new Map<number, string>();
	private containerMetaMap = new Map<number, IContainerMeta>();
	private chunkMetaMap = new Map<number, IChunkMeta>();
	private frameThreadMap = new Map<number, number>();
	private variableThreadMap = new Map<number, number>();
	private threadVarRef = new Map<number, number>();
	private frameIdSeed = 1;
	private currentStoppedThreadId = PerlDebugSession.threadId;
	private desiredBreakpointsMap = new Map<string, IBreakpointData[]>();
	private desiredPostponedBreakpointsMap = new Map<string, IBreakpointData[]>();
	private runtimeBreakpointsMap = new Map<number, Map<string, IBreakpointData[]>>();
	private runtimePostponedBreakpointsMap = new Map<number, Map<string, IBreakpointData[]>>();
	private funcBps: IFunctionBreakpointData[] = [];
	private cwd = '';
	private escapeSpecialChars = false;

	// the perl cli session
	private _session!: ChildProcess;
	// helper to run commands and parse output
	private streamCatcher: StreamCatcher = new StreamCatcher;
	private runtimes = new Map<number, IDebuggerRuntime>();
	// max tries to set a breakpoint
	private maxBreakpointTries: number = 10;

	private maxArrayElements: number = 100;
	private maxHashElements: number = 100;

	private sortKeys: boolean = false;

	private deepcopy: boolean = false;
	private terminatedDueToUnsupportedFork = false;
	private debuggerServer?: Net.Server;
	private debuggerSocket?: Net.Socket;
	private nextChildThreadId = 2;
	private executionInProgressThreads = new Set<number>();
	private forcedTopFrameByThread = new Map<number, { path: string; line: number }>();
	private activeTransport: 'stdio' | 'socket' = 'stdio';

	constructor() {
		super('perl-debug.txt');

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * 
	 * @param event 
	 * 
	 * This function logs an event before sending it to the debug client
	 */
	protected logSendEvent(event: DebugProtocol.Event): void {
		this.sendEvent(event);
		logger.log(`Event sent: ${JSON.stringify(event)}`);
	}

	/**
	 * 
	 * @param response 
	 * 
	 * This function logs a response before sending it to the debug client
	 */
	protected logSendResponse(response: DebugProtocol.Response): void {
		super.sendResponse(response);
		logger.log(`Response sent: ${JSON.stringify(response)}`);
	}

	/**
	 * This function is used to send commands to the perl5db-process
	 * and receive the output as an array of strings.
	 */
	private getRuntime(threadId: number): IDebuggerRuntime {
		const runtime = this.runtimes.get(threadId);
		if (!runtime) {
			throw new Error(`No debugger runtime found for thread ${threadId}.`);
		}
		return runtime;
	}

	private registerPrimaryRuntime(output: Readable): void {
		this.runtimes.set(PerlDebugSession.threadId, {
			threadId: PerlDebugSession.threadId,
			name: 'thread 1',
			streamCatcher: this.streamCatcher,
			isPrimary: true,
			socket: output instanceof Net.Socket ? output : undefined
		});
		this.runtimeBreakpointsMap.set(PerlDebugSession.threadId, new Map());
		this.runtimePostponedBreakpointsMap.set(PerlDebugSession.threadId, this.cloneBreakpointsMap(this.desiredPostponedBreakpointsMap));
	}

	private cloneBreakpoints(bps: IBreakpointData[]): IBreakpointData[] {
		return bps.map((bp) => ({ ...bp }));
	}

	private cloneBreakpointsMap(source: Map<string, IBreakpointData[]>): Map<string, IBreakpointData[]> {
		const copy = new Map<string, IBreakpointData[]>();
		source.forEach((bps, scriptPath) => {
			copy.set(scriptPath, this.cloneBreakpoints(bps));
		});
		return copy;
	}

	private normalizePathKey(filePath: string): string {
		return this.normalizePathAndCasing(filePath);
	}

	private getPathMappedBreakpoints(
		map: Map<string, IBreakpointData[]>,
		scriptPath: string
	): IBreakpointData[] | undefined {
		const normalizedPath = this.normalizePathKey(scriptPath);
		const direct = map.get(normalizedPath);
		if (direct) {
			return direct;
		}

		if (process.platform === 'win32') {
			const lower = normalizedPath.toLowerCase();
			const entries = Array.from(map.entries());
			for (let i = 0; i < entries.length; i++) {
				const [existingPath, bps] = entries[i];
				if (this.normalizePathKey(existingPath).toLowerCase() === lower) {
					return bps;
				}
			}
		}

		return undefined;
	}

	private samePath(left?: string, right?: string): boolean {
		if (!left || !right) {
			return false;
		}
		return this.normalizePathKey(left) === this.normalizePathKey(right);
	}

	private setDesiredBreakpoints(scriptPath: string, bps: IBreakpointData[]): void {
		const normalizedPath = this.normalizePathKey(scriptPath);
		this.desiredBreakpointsMap.set(normalizedPath, this.cloneBreakpoints(bps));
	}

	private getDesiredBreakpoints(scriptPath: string): IBreakpointData[] {
		return this.cloneBreakpoints(this.getPathMappedBreakpoints(this.desiredBreakpointsMap, scriptPath) || []);
	}

	private setDesiredPostponedBreakpoints(scriptPath: string, bps: IBreakpointData[]): void {
		const normalizedPath = this.normalizePathKey(scriptPath);
		this.desiredPostponedBreakpointsMap.set(normalizedPath, this.cloneBreakpoints(bps));
	}

	private deleteDesiredPostponedBreakpoints(scriptPath: string): void {
		const normalizedPath = this.normalizePathKey(scriptPath);
		this.desiredPostponedBreakpointsMap.delete(normalizedPath);
	}

	private getDesiredPostponedEntries(): [string, IBreakpointData[]][] {
		return Array.from(this.desiredPostponedBreakpointsMap.entries())
			.map(([scriptPath, bps]) => [scriptPath, this.cloneBreakpoints(bps)]);
	}

	private getRuntimeBreakpoints(threadId: number): Map<string, IBreakpointData[]> {
		if (!this.runtimeBreakpointsMap.has(threadId)) {
			this.runtimeBreakpointsMap.set(threadId, new Map());
		}
		return this.runtimeBreakpointsMap.get(threadId)!;
	}

	private getRuntimePostponedBreakpoints(threadId: number): Map<string, IBreakpointData[]> {
		if (!this.runtimePostponedBreakpointsMap.has(threadId)) {
			this.runtimePostponedBreakpointsMap.set(threadId, this.cloneBreakpointsMap(this.desiredPostponedBreakpointsMap));
		}
		return this.runtimePostponedBreakpointsMap.get(threadId)!;
	}

	private getScopedVarRef(threadId: number, varRef: number): number {
		return threadId * 100000 + varRef;
	}

	private peekVarRef(threadId: number): number {
		if (!this.threadVarRef.has(threadId)) {
			this.threadVarRef.set(threadId, PerlDebugSession.variableRefStart);
		}
		return this.threadVarRef.get(threadId)!;
	}

	private consumeVarRef(threadId: number): number {
		const nextRef = this.peekVarRef(threadId);
		this.threadVarRef.set(threadId, nextRef + 1);
		return nextRef;
	}

	private clearThreadScopedState(threadId: number): void {
		this.threadVarRef.delete(threadId);
		this.runtimeBreakpointsMap.delete(threadId);
		this.runtimePostponedBreakpointsMap.delete(threadId);

		this.frameThreadMap.forEach((mappedThreadId, frameId) => {
			if (mappedThreadId === threadId) {
				this.frameThreadMap.delete(frameId);
			}
		});

		this.variableThreadMap.forEach((mappedThreadId, variableRef) => {
			if (mappedThreadId === threadId) {
				this.variableThreadMap.delete(variableRef);
			}
		});

		this.childVarsMap.forEach((_variables, scopedVarRef) => {
			if (Math.trunc(scopedVarRef / 100000) === threadId) {
				this.childVarsMap.delete(scopedVarRef);
			}
		});
		this.parentVarsMap.forEach((_variable, scopedVarRef) => {
			if (Math.trunc(scopedVarRef / 100000) === threadId) {
				this.parentVarsMap.delete(scopedVarRef);
			}
		});
		this.varExpressionMap.forEach((_expression, scopedVarRef) => {
			if (Math.trunc(scopedVarRef / 100000) === threadId) {
				this.varExpressionMap.delete(scopedVarRef);
			}
		});
		this.containerMetaMap.forEach((_meta, scopedVarRef) => {
			if (Math.trunc(scopedVarRef / 100000) === threadId) {
				this.containerMetaMap.delete(scopedVarRef);
			}
		});
		this.chunkMetaMap.forEach((_meta, scopedVarRef) => {
			if (Math.trunc(scopedVarRef / 100000) === threadId) {
				this.chunkMetaMap.delete(scopedVarRef);
			}
		});

		if (this.currentStoppedThreadId === threadId) {
			this.currentStoppedThreadId = PerlDebugSession.threadId;
		}
	}

	private async registerChildRuntime(socket: Net.Socket): Promise<void> {
		const threadId = this.nextChildThreadId++;
		const childCatcher = new StreamCatcher();
		this.runtimes.set(threadId, {
			threadId,
			name: `thread ${threadId}`,
			streamCatcher: childCatcher,
			isPrimary: false,
			socket
		});
		this.runtimeBreakpointsMap.set(threadId, new Map());
		this.runtimePostponedBreakpointsMap.set(threadId, this.cloneBreakpointsMap(this.desiredPostponedBreakpointsMap));

		this.logSendEvent(new ThreadEvent('started', threadId));

		socket.once('close', () => {
			if (this.runtimes.delete(threadId)) {
				this.clearThreadScopedState(threadId);
				this.logSendEvent(new ThreadEvent('exited', threadId));
			}
		});

		try {
			await childCatcher.launch(socket, socket);
			await this.syncRuntimeBreakpoints(threadId);
			this.logSendEvent(new OutputEvent(
				`Attached forked perl5db child transport to thread ${threadId}.\n`,
				'important'
			));
			// Child is sitting at DB<n> prompt after sync - start it running.
			// execute('c') will resolve when the child next stops (breakpoint/step/exit).
			// Track in executionInProgressThreads to block duplicate continues until the
			// first StoppedEvent is emitted.
			this.executionInProgressThreads.add(threadId);
			this.logSendEvent(new ContinuedEvent(threadId, false));
			this.continue(threadId).catch((error) => {
				if (this.runtimes.has(threadId)) {
					this.logSendEvent(new OutputEvent(
						`Child runtime thread ${threadId} continue error: ${error}\n`,
						'important'
					));
				}
			}).finally(() => {
				this.executionInProgressThreads.delete(threadId);
			});
		} catch (error) {
			this.logSendEvent(new OutputEvent(
				`Failed to initialize forked perl5db child transport for thread ${threadId}: ${error}\n`,
				'important'
			));
			socket.destroy();
		}
	}

	private async syncRuntimeBreakpoints(threadId: number): Promise<void> {
		const desiredEntries = Array.from(this.desiredBreakpointsMap.entries())
			.map(([scriptPath, bps]) => [scriptPath, this.cloneBreakpoints(bps)] as [string, IBreakpointData[]]);
		for (let i = 0; i < desiredEntries.length; i++) {
			const [scriptPath, bps] = desiredEntries[i];
			await this.applyBreakpointsToRuntime(scriptPath, bps, threadId);
		}

		for (let i = 0; i < this.funcBps.length; i++) {
			const bp = this.funcBps[i];
			await this.request(`b ${bp.name} ${bp.condition}`, threadId);
		}
	}

	private async request(command: string, threadId: number = PerlDebugSession.threadId): Promise<string[]> {
		const runtime = this.getRuntime(threadId);
		logger.log(`Command: ${command}`);
		const response = await runtime.streamCatcher.request(command);
		logger.log(`Response for command ${command}: ${response.join('\n')}`);
		return response;
	}

	private handleSessionOutput(data: string, category: 'stdout' | 'stderr'): void {
		const output = data.replace(ansiSeq, '');
		this.logSendEvent(new OutputEvent(output, category));

		if (this.activeTransport === 'stdio' && output.includes('Forked, but do not know how to create a new TTY')) {
			this.handleUnsupportedFork();
		}
	}

	private handleUnsupportedFork(): void {
		if (this.terminatedDueToUnsupportedFork) {
			return;
		}

		this.terminatedDueToUnsupportedFork = true;
		this.logSendEvent(new OutputEvent(
			'Forked Perl debugging is not supported by this adapter because perl5db requires a separate TTY for child debuggers. The session has been stopped to avoid corrupted state.',
			'important'
		));

		if (this._session && !this._session.killed) {
			this._session.kill();
		}

		this.logSendEvent(new TerminatedEvent());
	}
	private cleanupDebuggerTransport(): void {
		this.activeTransport = 'stdio';
		this.frameThreadMap.clear();
		this.variableThreadMap.clear();
		this.threadVarRef.clear();
		this.executionInProgressThreads.clear();
		this.parentVarsMap.clear();
		this.childVarsMap.clear();
		this.runtimeBreakpointsMap.clear();
		this.runtimePostponedBreakpointsMap.clear();

		this.runtimes.forEach((runtime) => {
			if (runtime.socket && !runtime.socket.destroyed) {
				runtime.socket.destroy();
			}
		});
		this.runtimes.clear();

		if (this.debuggerSocket && !this.debuggerSocket.destroyed) {
			this.debuggerSocket.destroy();
		}
		this.debuggerSocket = undefined;

		if (this.debuggerServer) {
			this.debuggerServer.close();
		}
		this.debuggerServer = undefined;
	}

	private buildPerlDbOptions(remotePort?: string): string {
		const options = ['ReadLine=0'];
		if (remotePort) {
			options.push(`RemotePort=${remotePort}`);
		}
		return options.join(' ');
	}

	private async createSocketTransport(): Promise<{ remotePort: string; socketPromise: Promise<Net.Socket>; }> {
		const server = Net.createServer((socket) => {
			if (this.debuggerSocket) {
				this.registerChildRuntime(socket).catch((error) => {
					this.logSendEvent(new OutputEvent(`Could not register child runtime: ${error}\n`, 'important'));
					socket.destroy();
				});
				return;
			}

			this.debuggerSocket = socket;
		});
		this.debuggerServer = server;

		const socketPromise = new Promise<Net.Socket>((resolve, reject) => {
			server.once('connection', (socket) => {
				this.debuggerSocket = socket;
				resolve(socket);
			});
			server.once('error', reject);
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				resolve();
			});
		});

		const address = server.address() as Net.AddressInfo;
		return {
			remotePort: `127.0.0.1:${address.port}`,
			socketPromise
		};
	}

	private async waitForDebuggerSocket(socketPromise: Promise<Net.Socket>): Promise<Net.Socket> {
		return new Promise<Net.Socket>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Timed out waiting for perl5db to connect to the socket transport.'));
			}, 5000);

			socketPromise.then((socket) => {
				clearTimeout(timeout);
				resolve(socket);
			}).catch((error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}
	/**
	 * This function normalizes paths depending on the OS the debugger is running on.
	 */
	private normalizePathAndCasing(pathStr: string): string {
		if (process.platform === 'win32') {
			pathStr = pathStr.replace(/\//g, '\\');
			pathStr = path.win32.normalize(pathStr);
			const matched = pathStr.match(/(^[a-z])(:[\\/].*)/);
			if (matched) {
				pathStr = `${matched[1].toUpperCase()}${matched[2]}`;
			}
			return pathStr;
		}
		return path.posix.normalize(pathStr.replace(/\\/g, '/'));
	}

	/**
	 * Changes the file context inside the perl5db-process.
	 */
	private async changeFileContext(filePath: string, threadId: number = PerlDebugSession.threadId): Promise<string | undefined> {
		const normalizedPath = this.normalizePathAndCasing(filePath).replace(/^\.\.\/+/g, '');
		const candidates = Array.from(new Set([
			basename(normalizedPath),
			normalizedPath,
			normalizedPath.replace(/\\{1,2}/g, '/')
		].filter((candidate) => candidate.length > 0)));

		let lastError = '';
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i];
			const data = (await this.request(`f ${candidate}`, threadId))[1];
			const noFileMatch = data.match(/^No file matching '.*' is loaded\./);
			// perl5db can emit hard errors for Windows-style absolute paths (e.g.
			// "\\C no longer supported in regex") which must be treated as failure.
			const hasError = /no longer supported in regex|\sat\s.*perl5db\.pl\sline\s\d+\.?|END failed--call queue aborted\./i.test(data);
			if (!noFileMatch && !hasError) {
				logger.log(`Successfully changed file context to ${candidate}: ${data}`);
				return candidate;
			}
			lastError = data;
		}

		if (lastError) {
			logger.log(`Could not change file context: ${lastError}`);
		}
		return undefined;
	}

	/**
	 * Sets breakpoints in a given perl file.
	 */
	private async setBreakpointsInFile(filePath: string, bps: DebugProtocol.SourceBreakpoint[], threadId: number = PerlDebugSession.threadId): Promise<Breakpoint[]> {
		const setBps: Breakpoint[] = [];
		const mapBps: IBreakpointData[] = [];

		for (let i = 0; i < bps.length; i++) {
			let success = false;
			let line = bps[i].line;
			for (let tries = 0; success === false && tries < this.maxBreakpointTries; tries++) {
				const data = (await this.request(`b ${line} ${bps[i].condition}`, threadId)).join('');
				if (data.includes('not breakable')) {
					// try again at the next line
					line++;
				} else {
					// a breakable line was found and the breakpoint set
					success = true;
				}
			}
			const bp = new Breakpoint(success, line, undefined, new Source(filePath, filePath));
			bp.setId(this.currentBreakpointID);
			setBps.push(bp);
			// filling the array for the breakpoints map
			mapBps.push({
				id: this.currentBreakpointID,
				line: line,
				condition: bps[i].condition || ''
			});

			this.currentBreakpointID++;
		}

		// save breakpoints inside the map
		const normalizedPath = this.normalizePathKey(filePath);
		this.setDesiredBreakpoints(normalizedPath, mapBps);
		this.getRuntimeBreakpoints(threadId).set(normalizedPath, this.cloneBreakpoints(mapBps));
		// clear postponed breakpoints for this runtime
		this.getRuntimePostponedBreakpoints(threadId).delete(normalizedPath);
		this.deleteDesiredPostponedBreakpoints(normalizedPath);

		return setBps;
	}

	/**
	 * Removes all breakpoints in a given perl file.
	 */
	private async removeBreakpointsInFile(filePath: string, threadId: number = PerlDebugSession.threadId) {
		const scriptPath = this.normalizePathKey(filePath);
		const runtimeBps = this.getRuntimeBreakpoints(threadId);

		const bps = this.getPathMappedBreakpoints(runtimeBps, scriptPath);
		if (bps && (await this.changeFileContext(scriptPath, threadId))) {
			for (let i = 0; i < bps.length; i++) {
				// remove the breakpoint inside the debugger
				await this.request(`B ${bps[i].line}`, threadId);
			}
		}

		runtimeBps.delete(scriptPath);
	}

	private async applyBreakpointsToRuntime(scriptPath: string, bps: IBreakpointData[], threadId: number): Promise<void> {
		const normalizedPath = this.normalizePathKey(scriptPath);
		if (!(await this.changeFileContext(scriptPath, threadId))) {
			this.getRuntimePostponedBreakpoints(threadId).set(normalizedPath, this.cloneBreakpoints(bps));
			return;
		}
		await this.removeBreakpointsInFile(scriptPath, threadId);
		for (let i = 0; i < bps.length; i++) {
			await this.request(`b ${bps[i].line} ${bps[i].condition}`, threadId);
		}
		this.getRuntimeBreakpoints(threadId).set(normalizedPath, this.cloneBreakpoints(bps));
		this.getRuntimePostponedBreakpoints(threadId).delete(normalizedPath);
	}

	/**
	 * Checks if the perl5db-runtime is currently active.
	 * Requires the primary runtime to be registered: streamCatcher.launch() sets
	 * this.streamCatcher.input on its very first line, before awaiting perl's first
	 * prompt, so isActive() would return true during the startup window when runtimes
	 * is still empty. Requiring runtimes.has(threadId) closes that window.
	 */
	private isActive(): boolean {
		return !!(this.runtimes.has(PerlDebugSession.threadId) && this.streamCatcher.input);
	}

	/**
	 * Builds a variables expression using its parents ID and name.
	 */
	private getExpression(id: number, expression: string, threadId: number = PerlDebugSession.threadId): string {
		let lastParent: Variable | undefined = this.childVarsMap.get(this.getScopedVarRef(threadId, id))?.find(e => { return e.name === expression; });
		if (lastParent) {
			let parentVars: Variable[] = [lastParent!];
			let parent: Variable | undefined;
			while ((parent = this.parentVarsMap.get(this.getScopedVarRef(threadId, id))) && lastParent) {
				const childrenOfParent = this.childVarsMap.get(this.getScopedVarRef(threadId, id));
				if (parent && childrenOfParent!.includes(lastParent)) {
					parentVars.push(parent);
					// we need to store the last parent variable to find the parent of the lastParent
					lastParent = parent;
				}
				id++;
			}
			// Now we can build the expression
			let currentType = parentVars[parentVars.length - 1].value.match(/^(ARRAY|HASH)/)![1];
			for (let i = parentVars.length - 1; i > -1; i--) {
				const parentVar = parentVars[i];
				if (i === parentVars.length - 1) {
					if (parentVar.name.startsWith('$')) {
						// if a nested variable starts with a dollar sign it has to be an object so the arrow is necessary
						expression = `${parentVar.name}->`;
					} else if (parentVar.name.match(/^[%|@]/)) {
						// accessing hash and array values requires a dollar sign at the start
						expression = `${parentVar.name.replace(/^[%|@]/, '$')}`;
					} else {
						expression = parentVar.name;
					}
				} else {
					switch (currentType) {
						case 'ARRAY':
							expression = `${expression}[${parentVar.name}]`;
							break;
						case 'HASH':
							expression = `${(expression.endsWith(']') ? `${expression}->` : expression)}{'${parentVar.name}'}`;
							break;
						default:
							logger.error(`Unknown variable type: ${currentType}`);
							break;
					}
					currentType = parentVar.value.match(/(^ARRAY|^HASH|.*)/)![1];
				}
			}
		}
		return expression;
	}

	private normalizeExpressionForContainer(expression: string): string {
		if (expression.startsWith('[') && expression.endsWith(']')) {
			return this.normalizeExpressionForContainer(expression.slice(1, -1));
		}
		if (expression.startsWith('{') && expression.endsWith('}')) {
			return this.normalizeExpressionForContainer(expression.slice(1, -1));
		}
		if (expression.startsWith('@') || expression.startsWith('%')) {
			return `$${expression.slice(1)}`;
		}
		return expression;
	}

	private buildIndexedExpression(parentExpression: string, index: number): string {
		const normalized = this.normalizeExpressionForContainer(parentExpression);
		return `${normalized}[${index}]`;
	}

	private buildNamedExpression(parentExpression: string, key: string): string {
		const normalized = this.normalizeExpressionForContainer(parentExpression);
		const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		return `${(normalized.endsWith(']') ? `${normalized}->` : normalized)}{'${escaped}'}`;
	}

	private buildHashKeySliceExpression(parentExpression: string, start: number, end: number): string {
		const keysSource = parentExpression.startsWith('%')
			? `keys ${parentExpression}`
			: `do { my $__h = ${this.normalizeExpressionForContainer(parentExpression)}; keys %{$__h} }`;
		return `do { my @k = ${keysSource}; my $all_numeric = 1; for my $k (@k) { if ($k !~ /^-?\\d+$/) { $all_numeric = 0; last; } } @k = $all_numeric ? sort { $a <=> $b } @k : sort { $a cmp $b } @k; @k[${start}..${end}] }`;
	}

	private hasDebuggerCommandError(lines: string[]): boolean {
		const payload = lines.slice(1, -1).filter((line) => line !== '');
		if (payload.length === 0) {
			return false;
		}
		return payload.some((line) => /syntax error|Compilation failed|Undefined subroutine|Modification of a read-only value attempted|Can't locate|Can't use|Can't modify|no longer supported in regex|\sat\s.*line\s\d+\.?/i.test(line));
	}

	private countChar(line: string, charToCount: string): number {
		let count = 0;
		for (let i = 0; i < line.length; i++) {
			if (line.charAt(i) === charToCount) {
				count++;
			}
		}
		return count;
	}

	private skipNestedBlock(lines: string[], startIndex: number, openChar: string): number {
		const closeChar = openChar === '{' ? '}' : ']';
		let depth = this.countChar(lines[startIndex], openChar) - this.countChar(lines[startIndex], closeChar);
		let index = startIndex;
		while (depth > 0 && index + 1 < lines.length) {
			index++;
			const current = lines[index];
			depth += this.countChar(current, openChar);
			depth -= this.countChar(current, closeChar);
		}
		return index;
	}

	private toDumperExpression(expression: string): string {
		if (expression.startsWith('@')) {
			return `[${expression}]`;
		}
		if (expression.startsWith('%')) {
			return `{${expression}}`;
		}
		return expression;
	}

	private buildOutputPrintCommand(payload: string): string {
		if (this.activeTransport === 'socket') {
			return `print {$DB::OUT} ${payload}`;
		}
		return `print STDERR ${payload}`;
	}

	private extractCommandPayload(lines: string[]): string[] {
		return lines
			.filter((line) => line !== '')
			.slice(1, -1)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	private async getContainerSize(expression: string, type: 'ARRAY' | 'HASH', threadId: number): Promise<number> {
		const normalized = this.normalizeExpressionForContainer(expression);
		let perlExpr: string;
		if (type === 'ARRAY') {
			if (expression.startsWith('@')) {
				perlExpr = `scalar(${expression})`;
			} else {
				perlExpr = `do { my $__v = ${normalized}; ref($__v) eq 'ARRAY' ? scalar(@{$__v}) : 0 }`;
			}
		} else {
			if (expression.startsWith('%')) {
				perlExpr = `scalar(keys ${expression})`;
			} else {
				perlExpr = `do { my $__v = ${normalized}; ref($__v) eq 'HASH' ? scalar(keys %{$__v}) : 0 }`;
			}
		}

		const payload = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`${perlExpr} . "\\n"`), threadId));
		if (payload.length === 0) {
			return 0;
		}
		const parsed = parseInt(payload[payload.length - 1], 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	private createChunkNodesForContainer(ref: number, threadId: number, meta: IContainerMeta): Variable[] {
		const chunkSize = meta.type === 'HASH' ? this.maxHashElements : this.maxArrayElements;
		if (chunkSize <= 0 || meta.total <= chunkSize) {
			return [];
		}

		const scopedRef = this.getScopedVarRef(threadId, ref);
		const chunks: DebugProtocol.Variable[] = [];
		for (let start = 0; start < meta.total; start += chunkSize) {
			const end = Math.min(start + chunkSize, meta.total) - 1;
			const chunkRef = this.consumeVarRef(threadId);
			this.variableThreadMap.set(chunkRef, threadId);
			this.chunkMetaMap.set(this.getScopedVarRef(threadId, chunkRef), {
				parentExpression: meta.expression,
				type: meta.type,
				start,
				end
			});
			chunks.push({
				name: meta.type === 'HASH' ? `[keys ${start}..${end}]` : `[${start}..${end}]`,
				value: `${meta.type} CHUNK`,
				type: meta.type,
				variablesReference: chunkRef,
				// Keep evaluateName on the container expression to avoid bogus expressions
				// like $large_array[[0..99]].
				evaluateName: this.normalizeExpressionForContainer(meta.expression),
				presentationHint: { kind: 'data' }
			});
		}
		this.childVarsMap.set(scopedRef, chunks as Variable[]);
		return chunks as Variable[];
	}

	private shouldExposeContainerCount(type: 'ARRAY' | 'HASH', total: number): boolean {
		const chunkSize = type === 'HASH' ? this.maxHashElements : this.maxArrayElements;
		return chunkSize <= 0 || total <= chunkSize;
	}

	private async loadChunkChildren(chunkRef: number, threadId: number, chunk: IChunkMeta): Promise<Variable[]> {
		if (chunk.type === 'ARRAY') {
			const parentExpr = chunk.parentExpression;
			const dumpExpr = parentExpr.startsWith('@')
				? `[@{[ ${parentExpr}[${chunk.start}..${chunk.end}] ]}]`
				: `[ @{ ${this.normalizeExpressionForContainer(parentExpr)} }[${chunk.start}..${chunk.end}] ]`;
			const varDump = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`Data::Dumper->new([${dumpExpr}], [])->Deepcopy(${this.deepcopy ? '1' : '0'})->Indent(1)->Terse(0)->Sortkeys(${this.sortKeys ? '1' : '0'})->Useqq(1)->Dump()`), threadId));
			if (varDump.length === 0) {
				this.childVarsMap.set(this.getScopedVarRef(threadId, chunkRef), []);
				return [];
			}
			this.parseDumper(varDump.slice(1, -1), threadId, chunkRef, `@chunk`);
			const vars = this.childVarsMap.get(this.getScopedVarRef(threadId, chunkRef)) || [];
			for (let i = 0; i < vars.length; i++) {
				vars[i].name = `${chunk.start + i}`;
				(vars[i] as DebugProtocol.Variable).evaluateName = this.buildIndexedExpression(parentExpr, chunk.start + i);
			}
			this.childVarsMap.set(this.getScopedVarRef(threadId, chunkRef), vars);
			return vars;
		}

		const parentExpr = chunk.parentExpression;
		const keysExpr = this.buildHashKeySliceExpression(parentExpr, chunk.start, chunk.end);
		const keysPayload = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`join("\\t", ${keysExpr}) . "\\n"`), threadId));
		const keys = keysPayload.length > 0 ? keysPayload[keysPayload.length - 1].split('\t').filter((k) => k.length > 0) : [];
		const vars: DebugProtocol.Variable[] = [];
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const valueExpr = this.buildNamedExpression(parentExpr, key);
			const one = await this.parseVars([valueExpr], threadId);
			if (one.length > 0) {
				const entry = one[0];
				entry.name = key;
				(entry as DebugProtocol.Variable).evaluateName = valueExpr;
				vars.push(entry);
			}
		}
		this.childVarsMap.set(this.getScopedVarRef(threadId, chunkRef), vars as Variable[]);
		return vars as Variable[];
	}

	private async loadContainerChildren(ref: number, threadId: number): Promise<Variable[] | undefined> {
		const scopedRef = this.getScopedVarRef(threadId, ref);
		const chunk = this.chunkMetaMap.get(scopedRef);
		if (chunk) {
			return this.loadChunkChildren(ref, threadId, chunk);
		}

		const meta = this.containerMetaMap.get(scopedRef);
		if (meta) {
			const chunkNodes = this.createChunkNodesForContainer(ref, threadId, meta);
			if (chunkNodes.length > 0) {
				return chunkNodes;
			}
		}

		const expression = this.varExpressionMap.get(scopedRef);
		if (!expression) {
			return undefined;
		}

		const dumpExpression = this.toDumperExpression(expression);
		const varDump = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`Data::Dumper->new([${dumpExpression}], [])->Deepcopy(${this.deepcopy ? '1' : '0'})->Indent(1)->Terse(0)->Sortkeys(${this.sortKeys ? '1' : '0'})->Useqq(1)->Dump()`), threadId));

		if (varDump.length === 0) {
			this.childVarsMap.set(scopedRef, []);
			return [];
		}

		this.parseDumper(varDump.slice(1, -1), threadId, ref, expression);
		return this.childVarsMap.get(scopedRef);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsDataBreakpoints = true;
		response.body.supportsSetVariable = true;
		response.body.supportsLoadedSourcesRequest = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsTerminateRequest = true;
		response.body.supportsDelayedStackTraceLoading = false;

		this.logSendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.logSendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments): Promise<void> {
		let launchResponseSent = false;
		const sendLaunchResponseOnce = () => {
			if (!launchResponseSent) {
				this.logSendResponse(response);
				launchResponseSent = true;
			}
		};

		this.terminatedDueToUnsupportedFork = false;
		this.nextChildThreadId = 2;
		this.cleanupDebuggerTransport();

		// reset breakpointID and clear maps
		this.currentBreakpointID = 1;
		// desiredPostponedBreakpointsMap is intentionally NOT cleared here: the IDE sends
		// setBreakpoints during the configuration sequence (after InitializedEvent but before
		// launch), and those breakpoints must survive into the launch body where they are
		// applied to the freshly-started runtime.
		this.desiredBreakpointsMap.clear();

		// set cwd
		args.cwd = this.normalizePathAndCasing(args.cwd || dirname(args.program));
		this.cwd = args.cwd;

		this.escapeSpecialChars = args.escapeSpecialChars || false;

		// setup logger
		if (args.trace === true) {
			logger.setup(Logger.LogLevel.Log, false);
		} else {
			logger.setup(Logger.LogLevel.Warn, false);
		}

		// set max array and hash depth
		this.maxArrayElements = args.maxArrayElements || 100;
		this.maxHashElements = args.maxHashElements || 100;

		// set sortkeys
		this.sortKeys = args.sortKeys || false;

		// set deepcopy
		this.deepcopy = args.deepcopy || false;

		// start the program in the runtime
		// Spawn perl process and handle errors
		logger.log(`CWD: ${args.cwd}`);
		const transport = args.transport || 'socket';
		this.activeTransport = transport;
		let remotePort: string | undefined;
		let socketPromise: Promise<Net.Socket> | undefined;
		if (transport === 'socket') {
			const socketTransport = await this.createSocketTransport();
			remotePort = socketTransport.remotePort;
			socketPromise = socketTransport.socketPromise;
		}

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...args.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			PERL5DB: args.perl5db,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			COLUMNS: '80',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			LINES: '25',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			TERM: 'dumb',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			PERLDB_OPTS: this.buildPerlDbOptions(remotePort)
		};
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: args.cwd,
			env: env,
			stdio: 'pipe'
		};

		args.program = this.normalizePathAndCasing(args.program);
		logger.log(`Script: ${args.program}`);
		const commandArgs = [
			(args.threaded === true ? '-dt' : '-d'),
			args.program,
			...args.args || []
		];

		// was the last session already killed?
		if (this._session && !this._session.killed) {
			this._session.kill();
		}

		// launch the debugger
		args.perlExecutable = args.perlExecutable || 'perl';
		let spawnCommand = args.perlExecutable;
		let spawnArgs = commandArgs;
		if (args.wrapperCommand && Array.isArray(args.wrapperCommand) && args.wrapperCommand.length > 0) {
			spawnCommand = args.wrapperCommand[0];
			spawnArgs = [
				...args.wrapperCommand.slice(1),
				args.perlExecutable,
				...commandArgs
			];
			logger.log(`Wrapper command detected: ${args.wrapperCommand.join(' ')}`);
			logger.log(`Full command: ${spawnCommand} ${spawnArgs.join(' ')}`);
		} else {
			logger.log(`Perl executable: ${args.perlExecutable}`);
		}
		this._session = spawn(
			spawnCommand,
			spawnArgs,
			spawnOptions
		);

		this._session.on('error', err => {
			const text = `Could not spawn the child process! Command: ${args.perlExecutable}\nCode: ${err.name}\nError: ${err.message}`;
			logger.error(text);
			this.logSendEvent(new OutputEvent(text, 'important'));
			this.logSendEvent(new TerminatedEvent());
			return;
		});

		this._session.on('close', code => {
			this.cleanupDebuggerTransport();
			if (code === 255) {
				this.logSendEvent(new OutputEvent(`${this.streamCatcher.getBuffer().splice(0, 7).join('\n')}\n`, 'stderr'));
				this.logSendEvent(new TerminatedEvent());
			}
			return;
		});

		this._session.on('exit', code => {
			this.cleanupDebuggerTransport();
			if (code === 255) {
				const text = `Could not start the debugging session! Script may contains errors. Code: ${code}\n${this.streamCatcher.getBuffer().splice(0, 7).join('\n')}\n`;
				this.logSendEvent(new OutputEvent(text, 'stderr'));
				this.logSendEvent(new TerminatedEvent());
			}
			return;
		});

		this._session.stdout!.on('data', (data) => {
			this.handleSessionOutput(data.toString(), 'stdout');
		});
		this._session.stderr!.on('data', (data) => {
			this.handleSessionOutput(data.toString(), 'stderr');
		});

		let debuggerOutput: Readable = this._session.stderr!;
		if (socketPromise) {
			try {
				debuggerOutput = await this.waitForDebuggerSocket(socketPromise);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown socket transport error.';
				this.logSendEvent(new OutputEvent(`Could not establish the perl5db socket transport: ${message}\n`, 'important'));
				this.cleanupDebuggerTransport();
				if (this._session && !this._session.killed) {
					this._session.kill();
				}
				response.success = false;
				sendLaunchResponseOnce();
				return;
			}
		}

		let debuggerInput: Writable = this._session.stdin!;
		if (transport === 'socket') {
			debuggerInput = debuggerOutput as unknown as Writable;
		}

		await this.streamCatcher.launch(
			debuggerInput,
			debuggerOutput
		);
		this.registerPrimaryRuntime(debuggerOutput);
		sendLaunchResponseOnce();

		// does the user want to debug the script or just run it?
		if (args.debug === true || args.debug === undefined) {
			logger.log('Starting debugging');

			// do not print any preview to the debug console
			await this.request('package DB; $DB::preview = 0;');

			// diesable tracing
			await this.request('notrace');

			// do not print return values on return-command
			await this.request('o PrintRet=0');

			// avoid stopping in END-frame internals when the debugged script exits
			await this.request('o inhibit_exit=1');

			// disable buffering to STDOUT
			await this.request('$| = 1');

			// stop when loading a new file and check if we can call continue after the stop
			await this.request('package DB; *DB::postponed = sub { return sub { if ( \'GLOB\' eq ref(\\$_[0]) && $_[0] =~ /<(.*)\\s*$/s) { if ($DB::single == 0) { print STDERR "continue "; } $DB::single = 1; print STDERR "loaded source $1\\n"; } } ; }->(\\\\&DB::postponed)');

			// use PadWalker to list variables in scope and Data::Dumper for accessing variable values
			const lines = await this.request('use PadWalker qw/peek_our peek_my/; use Data::Dumper;');
			if (lines.join().includes('Can\'t locate')) {
				this.logSendEvent(new OutputEvent(`Could not load required modules:\n${lines.join('\n')}`, 'important'));
				this.logSendEvent(new TerminatedEvent());
				return;
			}

			// Apply pre-launch breakpoints for the main script only. At this point only
			// the main script is guaranteed to be loaded in perl5db; breakpoints for other
			// files remain in desiredPostponedBreakpointsMap and are applied when those
			// files are loaded via the DB::postponed hook.
			const mainScriptKey = this.normalizePathKey(args.program);
			for (const [scriptPath, bps] of this.getDesiredPostponedEntries()) {
				if (!this.samePath(scriptPath, mainScriptKey)) {
					continue;
				}
				const fileChanged = await this.changeFileContext(scriptPath, PerlDebugSession.threadId);
				if (bps && fileChanged) {
					await this.setBreakpointsInFile(scriptPath, bps, PerlDebugSession.threadId);
				}
			}

			// set function breakpoints
			for (let i = 0; i < this.funcBps.length; i++) {
				const bp = this.funcBps[i];
				const data = (await this.request(`b ${bp.name} ${bp.condition}`, PerlDebugSession.threadId))[1];
				if (data.includes('not found')) {
					this.logSendEvent(new OutputEvent(`Could not set function breakpoint:\n${data}`, 'important'));
				}
			}

			// stop on entry or continue?
			logger.log(`StopOnEntry: ${args.stopOnEntry}`);
			if (args.stopOnEntry) {
				this.logSendEvent(new StoppedEvent('entry', PerlDebugSession.threadId));
			} else {
				this.logSendEvent(new ContinuedEvent(PerlDebugSession.threadId));
				this.continue().catch((error) => {
					this.logSendEvent(new OutputEvent(`Continue failed on primary runtime: ${error}\n`, 'important'));
				});
			}
			return;
		} else {
			// Just run
			this.logSendEvent(new ContinuedEvent(PerlDebugSession.threadId));
			this.continue().catch((error) => {
				this.logSendEvent(new OutputEvent(`Continue failed on primary runtime: ${error}\n`, 'important'));
			});
			return;
		}
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// save breakpoints in memory and either hand them over in the launch request later or set them now if the runtime is active
		const scriptPath = args.source.path as string;
		const argBps = args.breakpoints!;
		this.currentBreakpointID = 1;

		// setting breakpoints is only possible if the runtime is currently active and the script is already loaded
		const active = this.isActive();
		const currentFrames = active ? await this.getStackFrames(PerlDebugSession.threadId) : [];
		const currentPath = currentFrames[0]?.source?.path;
		const currentMatchesTarget = this.samePath(currentPath, scriptPath);
		let loadedNow = false;
		if (active && currentMatchesTarget) {
			const activeContextPath = await this.changeFileContext(scriptPath, PerlDebugSession.threadId);
			const expectedBase = basename(scriptPath).toLowerCase();
			loadedNow = !!activeContextPath && basename(activeContextPath).toLowerCase() === expectedBase;
		}
		if (active && loadedNow) {
			// first we clear all existing breakpoints inside the file on primary runtime
			await this.removeBreakpointsInFile(scriptPath, PerlDebugSession.threadId);
			// now we try to set every breakpoint requested on primary runtime
			response.body = {
				breakpoints: await this.setBreakpointsInFile(scriptPath, argBps, PerlDebugSession.threadId)
			};

			// mirror breakpoints to attached child runtimes
			const childRuntimes = Array.from(this.runtimes.values()).filter((runtime) => runtime.threadId !== PerlDebugSession.threadId);
			for (let i = 0; i < childRuntimes.length; i++) {
				const runtime = childRuntimes[i];
				await this.applyBreakpointsToRuntime(scriptPath, this.getDesiredBreakpoints(scriptPath), runtime.threadId);
			}
		} else {
			logger.log('Can not set breakpoints. Runtime is not active yet or file not yet loaded');
			// save breakpoints inside the map
			const bps: Breakpoint[] = [];
			const mapBps: IBreakpointData[] = [];
			argBps.forEach(bp => {
				mapBps.push({
					id: this.currentBreakpointID,
					line: bp.line,
					condition: bp.condition || ''
				});

				bps.push(new Breakpoint(true, bp.line, undefined, new Source(scriptPath, scriptPath)));

				this.currentBreakpointID++;

			});
			this.setDesiredPostponedBreakpoints(scriptPath, mapBps);
			const normalizedPath = this.normalizePathKey(scriptPath);
			const runtimes = Array.from(this.runtimes.values());
			for (let i = 0; i < runtimes.length; i++) {
				this.getRuntimePostponedBreakpoints(runtimes[i].threadId).set(normalizedPath, this.cloneBreakpoints(mapBps));
			}
			response.body = {
				breakpoints: bps
			};
		}

		this.logSendResponse(response);
	}

	protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
		for (let i = 0; i < args.breakpoints.length; i++) {
			const bp = args.breakpoints[i];
			this.funcBps.push({
				name: bp.name,
				condition: bp.condition || ''
			});

			if (this.isActive()) {
				const runtimes = Array.from(this.runtimes.values());
				for (let r = 0; r < runtimes.length; r++) {
					await this.request(`b ${bp.name} ${bp.condition}`, runtimes[r].threadId);
				}
			} else {
				logger.warn('Can not set function breakpoint. Runtime is not active yet');
			}
		}

		this.logSendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		const threads = Array.from(this.runtimes.values())
			.map((runtime) => ({ id: runtime.threadId, name: runtime.name }))
			.sort((a, b) => a.id - b.id);

		response.body = {
			threads: threads.length > 0 ? threads : [{ id: PerlDebugSession.threadId, name: 'thread 1' }]
		};
		this.logSendResponse(response);
	}

	private async getStackFrames(threadId: number = PerlDebugSession.threadId): Promise<StackFrame[]> {
		let stackFrames: StackFrame[] = [];
		const stackTrace = /^[@|.]\s=\s(.*)\scalled\sfrom\sfile\s'(.*)'\sline\s(\d+)/;
		const stackTraceDoubleQuote = /^[@|.]\s=\s(.*)\scalled\sfrom\sfile\s"(.*)"\sline\s(\d+)/;
		const stackTraceUnquoted = /^[@|.]\s=\s(.*)\scalled\sfrom\sfile\s([^\s]+)\sline\s(\d+)/;
		const atFormat = /^(.*)\sat\s(.*)\sline\s(\d+)\.?$/;
		const evalTrace = /^\((eval\s\d+)\)\[(.*):(\d+)\]$/;

		const lines = (await this.request('T', threadId)).slice(1, -1);
		for (let i = 0; i < lines.length; i++) {
			const traceLine = lines[i];
			const matched = traceLine.match(stackTrace)
				|| traceLine.match(stackTraceDoubleQuote)
				|| traceLine.match(stackTraceUnquoted)
				|| traceLine.match(atFormat);
			if (matched) {
				let name = matched[1];
				let file = matched[2];
				let lineNumber = +matched[3];
				const isEval = file.match(evalTrace);
				if (isEval) {
					name += ' (' + isEval[1] + ')';
					file = isEval[2];
					lineNumber = +isEval[3];
				}
				file = this.normalizePathAndCasing(file);
				if (file.startsWith('.') || !path.isAbsolute(file)) {
					file = join(this.cwd, file);
				}
				const fn = new Source(basename(file), file);
				const frameId = this.frameIdSeed++;
				this.frameThreadMap.set(frameId, threadId);
				stackFrames.push(new StackFrame(frameId, name, fn, lineNumber));
			}
		}

		const normalizedCwd = this.normalizePathKey(this.cwd);
		const workspaceFrames = stackFrames.filter((frame) => {
			const framePath = frame.source?.path;
			return !!framePath && this.normalizePathKey(framePath).startsWith(normalizedCwd);
		});
		if (workspaceFrames.length > 0) {
			const nonWorkspaceFrames = stackFrames.filter((frame) => {
				const framePath = frame.source?.path;
				return !(!!framePath && this.normalizePathKey(framePath).startsWith(normalizedCwd));
			});
			stackFrames = workspaceFrames.concat(nonWorkspaceFrames);
		}

		return stackFrames;
	}

	private createSyntheticFrame(threadId: number, name: string, filePath: string, line: number): StackFrame {
		const frameId = this.frameIdSeed++;
		this.frameThreadMap.set(frameId, threadId);
		const source = new Source(basename(filePath), filePath);
		return new StackFrame(frameId, name, source, line);
	}

	private prependForcedStackFrame(threadId: number, stackFrames: StackFrame[]): StackFrame[] {
		const forcedTopFrame = this.forcedTopFrameByThread.get(threadId);
		if (!forcedTopFrame) {
			return stackFrames;
		}
		const forced = this.createSyntheticFrame(threadId, 'main::loaded_source', forcedTopFrame.path, forcedTopFrame.line);
		return [forced].concat(stackFrames);
	}


	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		const threadId = args.threadId || PerlDebugSession.threadId;
		this.currentStoppedThreadId = threadId;
		let stackFrames = await this.getStackFrames(threadId);
		// prependForcedStackFrame handles the genuine "file just loaded, here is the breakpoint
		// location" case (forcedTopFrameByThread set by execute handler). The former
		// prependPostponedFallbackFrame was removed: it fired incorrectly whenever there were
		// pre-launch pending breakpoints in runtimePostponedBreakpointsMap, masking the real
		// entry-stop or breakpoint-stop location.
		stackFrames = this.prependForcedStackFrame(threadId, stackFrames);

		response.body = {
			stackFrames: stackFrames,
			totalFrames: stackFrames.length
		};
		this.logSendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const threadId = this.frameThreadMap.get(args.frameId) || this.currentStoppedThreadId;
		const myRef = this._variableHandles.create({ scope: 'my', threadId });
		const ourRef = this._variableHandles.create({ scope: 'our', threadId });
		const specialRef = this._variableHandles.create({ scope: 'special', threadId });
		this.variableThreadMap.set(myRef, threadId);
		this.variableThreadMap.set(ourRef, threadId);
		this.variableThreadMap.set(specialRef, threadId);

		response.body = {
			scopes: [
				new Scope('My', myRef, false),
				new Scope('Our', ourRef, false),
				new Scope('Specials', specialRef, true)
			]
		};
		this.threadVarRef.set(threadId, PerlDebugSession.variableRefStart);
		this.logSendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, _request?: DebugProtocol.Request): Promise<void> {
		let varNames: string[] = [];
		let parsedVars: Variable[] = [];
		const threadId = this.variableThreadMap.get(args.variablesReference) || this.currentStoppedThreadId;
		const handle = this._variableHandles.get(args.variablesReference);
		if (handle) {
			if (handle.scope === 'my') {
				const payload = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand('join ("|", sort(keys( % { PadWalker::peek_my(2); }))) . "\\n"'), threadId));
				varNames = payload.length > 0 ? payload[payload.length - 1].split('|') : [''];
				logger.log(`Varnames: ${varNames.join(', ')}`);
			}
			if (handle.scope === 'our') {
				const payload = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand('join ("|", sort(keys( % { PadWalker::peek_our(2); }))) . "\\n"'), threadId));
				varNames = payload.length > 0 ? payload[payload.length - 1].split('|') : [''];
				logger.log(`Varnames: ${varNames.join(', ')}`);
			}
			else if (handle.scope === 'special') {
				varNames = [
					'%ENV',
					'@ARGV',
					'@INC',
					'@F',
					'$SIG',
					'$ARG',
					'$NR',
					'$RS',
					'$OFS',
					'$ORS',
					'$LIST_SEPARATOR',
					'$SUBSCRIPT_SEPARATOR',
					'$FORMAT_FORMFEED',
					'$FORMAT_LINE_BREAK_CHARACTERS',
					'$ACCUMULATOR',
					'$CHILD_ERROR',
					'$ERRNO',
					'$EVAL_ERROR',
					'$PID',
					'$UID',
					'$EUID',
					'$GID',
					'$EGID',
					'$PROGRAM_NAME',
					'$PERL_VERSION',
					'$DEBUGGING',
					'$INPLACE_EDIT',
					'$OSNAME',
					'$PERLDB',
					'$BASETIME',
					'$WARNING',
					'$EXECUTABLE_NAME',
					'$ARGV'
				];
			}
			if (varNames[0] !== '') {
				try {
					parsedVars = await this.parseVars(varNames, threadId);
				} catch (error) {
					this.logSendEvent(new OutputEvent(`Could not parse variables ${varNames}: ${error}`, 'stderr'));
					response.success = false;
					this.logSendResponse(response);
					return;
				}
			}
		} else {
			// get already parsed vars from map
			let newVars: DebugProtocol.Variable[] | undefined = this.childVarsMap.get(this.getScopedVarRef(threadId, args.variablesReference));
			if (!newVars) {
				newVars = await this.loadContainerChildren(args.variablesReference, threadId);
			}
			// build expressions only for the variables which are displayed as it can be kinda costly
			if (newVars) {
				for (let i = 0; i < newVars.length; i++) {
					if (!newVars[i].evaluateName) {
						newVars[i].evaluateName = this.getExpression(args.variablesReference, newVars[i].name, threadId);
					}
				}
				parsedVars = parsedVars.concat(newVars);
			}
		}

		response.body = {
			variables: parsedVars
		};

		this.logSendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
		const threadId = args.frameId ? (this.frameThreadMap.get(args.frameId) || this.currentStoppedThreadId) : this.currentStoppedThreadId;
		let varName: string;
		// check if a variable is being evaluated
		if (['$', '%', '@'].includes(args.expression.charAt(0))) {
			varName = args.expression;
		} else if (args.context === 'repl' && this._session.stdin?.writable) {
			// the user entered a command which is most likely meant to be sent to the stdin of the session
			response.success = this._session.stdin.write(`${args.expression}\n`);
			return;
		} else {
			response.success = false;
			this.logSendResponse(response);
			return;
		}

		// get variable value
		const evaledVar: DebugProtocol.Variable = (await this.parseVars([varName], threadId))[0];
		evaledVar.evaluateName = this.getExpression(evaledVar.variablesReference, evaledVar.name, threadId);

		try {
			response.body = {
				result: evaledVar.value,
				variablesReference: evaledVar.variablesReference,
			};
		} catch (error) {
			logger.error(`Could not evaluate ${varName}: ${error}`);
			response.success = false;
		}
		this.logSendResponse(response);
	}

	private async parseVars(varNames: string[], threadId: number = PerlDebugSession.threadId): Promise<Variable[]> {
		let vs: DebugProtocol.Variable[] = [];
		for (let i = 0; i < varNames.length; i++) {
			const originalExpression = varNames[i];
			if (originalExpression.startsWith('@') || originalExpression.startsWith('%')) {
				const ref = this.consumeVarRef(threadId);
				this.variableThreadMap.set(ref, threadId);
				this.varExpressionMap.set(this.getScopedVarRef(threadId, ref), originalExpression);
				const containerType = originalExpression.startsWith('@') ? 'ARRAY' : 'HASH';
				const total = await this.getContainerSize(originalExpression, containerType, threadId);
				this.containerMetaMap.set(this.getScopedVarRef(threadId, ref), {
					expression: originalExpression,
					type: containerType,
					total
				});
				const newVar: DebugProtocol.Variable = {
					name: originalExpression,
					value: containerType,
					variablesReference: ref,
					evaluateName: originalExpression,
					presentationHint: { kind: 'baseClass' }
				};
				if (containerType === 'HASH' && this.shouldExposeContainerCount(containerType, total)) {
					newVar.namedVariables = total;
				} else if (containerType === 'ARRAY' && this.shouldExposeContainerCount(containerType, total)) {
					newVar.indexedVariables = total;
				}
				vs.push(newVar);
				this.parentVarsMap.set(this.getScopedVarRef(threadId, ref), newVar);
				continue;
			}

			const dumpExpression = this.toDumperExpression(originalExpression);
			let varDump = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`Data::Dumper->new([${dumpExpression}], [])->Deepcopy(${this.deepcopy ? '1' : '0'})->Indent(1)->Terse(0)->Sortkeys(${this.sortKeys ? '1' : '0'})->Useqq(1)->Dump()`), threadId));
			try {
				let continueTries = 0;
				while (true) {
					// Continue every time we reach a breakpoint during this call until we have proper output
					if (varDump[0] && varDump[0].match(/^\$VAR1\s=\s.*/)) {
						break;
					} else if (varDump[0] && varDump[0].match(/^.* at .* line \d+\.$/)) {
						varDump = [];
						break;
					} else if (continueTries >= PerlDebugSession.maxVariableDumpContinueTries) {
						logger.error(`Reached max variable dump retries for ${originalExpression}`);
						varDump = [];
						break;
					} else {
						logger.log('Reached breakpoint while dumping variable');
						// check if we reached the end
						if (varDump.join().includes('Debugged program terminated.')) {
							// ensure that every script output is send to the debug console before closing the session
							await this.request('sleep(.5)', threadId);
							this.logSendEvent(new TerminatedEvent());
							return [new Variable(originalExpression, '')];
						}
						continueTries++;
						varDump = (await this.request('c', threadId)).filter(e => { return e !== ''; }).slice(1, -1);
					}
				}
			} catch (error) {
				// Log error and continue with parsing the next variable
				logger.error(`Could not parse variable ${originalExpression}: ${varDump.join('\n')}`);
				this.consumeVarRef(threadId);
				continue;
			}
			try {
				if (varDump[0]) {
					varDump[0] = varDump[0].replace(/=/, '=>');
					const matched = varDump[0].match(this.isNamedVariable);
					if (matched && varDump.length === 1) {
						if (!this.escapeSpecialChars) {
							matched[2] = unescapeJs(matched[2]);
						}
						vs.push({
							name: varNames[i],
							value: `${matched[2]}`,
							variablesReference: 0,
							evaluateName: varNames[i],
							presentationHint: { kind: 'data' },
							type: 'SCALAR'
						});
					} else {
						const ref = this.consumeVarRef(threadId);
						this.variableThreadMap.set(ref, threadId);
						this.varExpressionMap.set(this.getScopedVarRef(threadId, ref), originalExpression);
						this.varExpressionMap.set(this.getScopedVarRef(threadId, ref), originalExpression);
						const matched = varDump[varDump.length - 1].trim().match(this.isVarEnd);
						if (matched) {
							const type = `${(matched[1] === '}' ? 'HASH' : 'ARRAY')}${(matched[3] ? ` ${matched[3]}` : '')}`;
							const containerType = type.startsWith('HASH') ? 'HASH' : (type.startsWith('ARRAY') ? 'ARRAY' : undefined);
							let total = 0;
							if (containerType) {
								total = await this.getContainerSize(originalExpression, containerType, threadId);
								this.containerMetaMap.set(this.getScopedVarRef(threadId, ref), {
									expression: originalExpression,
									type: containerType,
									total
								});
							}
							const newVar: DebugProtocol.Variable = {
								name: varNames[i],
								value: type,
								variablesReference: ref,
								evaluateName: varNames[i],
								presentationHint: { kind: 'baseClass' }
							};
							if (type.startsWith('HASH') && this.shouldExposeContainerCount('HASH', total)) {
								newVar.namedVariables = total;
							} else if (type.startsWith('ARRAY') && this.shouldExposeContainerCount('ARRAY', total)) {
								newVar.indexedVariables = total;
							}
							vs.push(newVar);
							this.parentVarsMap.set(this.getScopedVarRef(threadId, ref), newVar);
						} else {
							logger.error(`Could not parse variable end for ${varNames[i]}: ${varDump[varDump.length - 1]}`);
							vs.push({
								name: varNames[i],
								value: 'undef',
								variablesReference: 0,
								presentationHint: { kind: 'data' },
								type: 'UNDEF'
							});
						}
					}
				} else {
					vs.push({
						name: varNames[i],
						value: 'undef',
						variablesReference: 0,
						presentationHint: { kind: 'data' },
						type: 'UNDEF'
					});
				}
			} catch (error: any) {
				logger.error(`Error parsing variable ${varNames[i]}: ${error}`);
				vs.push({
					name: varNames[i],
					value: 'undef',
					variablesReference: 0,
					presentationHint: { kind: 'data' },
					type: 'UNDEF'
				});
			}
		}


		// return all vars
		return vs;
	}

	// Regexp for parsing the output of Data::Dumper
	private isNamedVariable = /"?(.*)"?\s=>?\s(undef|".*"|'.*'|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\}|\\\*\{".*\"}|\\{1,2}\*.*)[,|;]?$/;
	private isIndexedVariable = /^(undef|".*"|'.*'|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\})[,|;]?/;
	private isNestedHash = /^(.*?)\s=>?\s(?:bless\(\s*)?(\[|\{)\s*$/;
	private isNestedArray = /^(bless\(\s*)?(\{|\[)$/;
	private isVarEnd = /^(\}|\]),?(\s?'(.*)'\s\))?[,|;]?/;
	// Parse output of Data::Dumper
	private parseDumper(lines: string[], threadId: number = PerlDebugSession.threadId, refOverride?: number, parentExpression?: string): { parsedLines: number, varType: string, numChildVars: number; } {
		let childVars: DebugProtocol.Variable[] = [];
		let varType: string = '';
		const ref: number = typeof refOverride === 'number' ? refOverride : this.consumeVarRef(threadId);

		let i: number;
		for (i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmedLine = line.trim();
			let matched = trimmedLine.match(this.isVarEnd);
			if (matched) {
				varType = `${(matched[1] === '}' ? 'HASH' : 'ARRAY')}${(matched[3] ? ` ${matched[3]}` : '')}`;
				break;
			}

			matched = trimmedLine.match(this.isNamedVariable);
			if (matched) {
				const childExpression = parentExpression ? this.buildNamedExpression(parentExpression, matched[1].replace(/"/, '')) : undefined;
				childVars.push({
					name: matched[1].replace(/"/, ''),
					value: matched[2],
					variablesReference: 0,
					evaluateName: childExpression,
					presentationHint: { kind: 'data' },
					type: 'SCALAR'
				});
				continue;
			}
			matched = trimmedLine.match(this.isNestedHash);
			if (matched) {
				const childRef = this.consumeVarRef(threadId);
				const keyName = (matched[1] || '').replace(/^['"]|['"]$/g, '');
				const openChar = matched[2];
				const childExpression = parentExpression ? this.buildNamedExpression(parentExpression, keyName) : undefined;
				const newVar: DebugProtocol.Variable = {
					name: keyName,
					value: 'HASH',
					type: 'HASH',
					variablesReference: childRef,
					evaluateName: childExpression,
					presentationHint: { kind: 'innerClass' }
				};
				this.parentVarsMap.set(this.getScopedVarRef(threadId, childRef), newVar);
				this.variableThreadMap.set(childRef, threadId);
				if (childExpression) {
					this.varExpressionMap.set(this.getScopedVarRef(threadId, childRef), childExpression);
				}
				childVars.push(newVar);
				i = this.skipNestedBlock(lines, i, openChar);
				continue;
			}
			matched = trimmedLine.match(this.isIndexedVariable);
			if (matched) {
				const nextIndex = childVars.length;
				const childExpression = parentExpression ? this.buildIndexedExpression(parentExpression, nextIndex) : undefined;
				childVars.push({
					name: `${nextIndex}`,
					value: matched[1],
					variablesReference: 0,
					evaluateName: childExpression,
					presentationHint: { kind: 'data' },
					type: 'SCALAR'
				});
				continue;
			}
			matched = trimmedLine.match(this.isNestedArray);
			if (matched) {
				const childRef = this.consumeVarRef(threadId);
				const nextIndex = childVars.length;
				const openChar = matched[2];
				const childExpression = parentExpression ? this.buildIndexedExpression(parentExpression, nextIndex) : undefined;
				const newVar: DebugProtocol.Variable = {
					name: `${nextIndex}`,
					value: 'ARRAY',
					type: 'ARRAY',
					variablesReference: childRef,
					evaluateName: childExpression,
					presentationHint: { kind: 'innerClass' }
				};
				this.parentVarsMap.set(this.getScopedVarRef(threadId, childRef), newVar);
				this.variableThreadMap.set(childRef, threadId);
				if (childExpression) {
					this.varExpressionMap.set(this.getScopedVarRef(threadId, childRef), childExpression);
				}
				childVars.push(newVar);
				i = this.skipNestedBlock(lines, i, openChar);
				continue;
			}
			if (line.trim() !== '') {
				childVars.push({
					name: `${childVars.length}`,
					value: line.trim(),
					variablesReference: 0,
					presentationHint: { kind: 'data' },
					type: 'SCALAR'
				});
			}
		}
		let finalChildren = childVars;
		const chunkSize = varType.startsWith('HASH') ? this.maxHashElements : this.maxArrayElements;
		if (chunkSize > 0 && childVars.length > chunkSize) {
			const chunks: DebugProtocol.Variable[] = [];
			for (let start = 0; start < childVars.length; start += chunkSize) {
				const end = Math.min(start + chunkSize, childVars.length);
				const chunkRef = this.consumeVarRef(threadId);
				this.variableThreadMap.set(chunkRef, threadId);
				this.childVarsMap.set(this.getScopedVarRef(threadId, chunkRef), childVars.slice(start, end));
				chunks.push({
					name: varType.startsWith('HASH') ? `[keys ${start}..${end - 1}]` : `[${start}..${end - 1}]`,
					value: `${varType} CHUNK`,
					type: varType.startsWith('HASH') ? 'HASH' : 'ARRAY',
					variablesReference: chunkRef,
					presentationHint: { kind: 'data' }
				});
			}
			finalChildren = chunks;
		}

		this.childVarsMap.set(this.getScopedVarRef(threadId, ref), finalChildren);
		const parsedLines = i < lines.length ? i + 1 : i;
		return { parsedLines: parsedLines, varType: varType, numChildVars: childVars.length };
	}

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		const threadId = this.variableThreadMap.get(args.variablesReference) || this.currentStoppedThreadId;
		const scopedRef = this.getScopedVarRef(threadId, args.variablesReference);
		let loadedChildren = this.childVarsMap.get(scopedRef) || [];
		let loadedChild = loadedChildren.find((entry) => entry.name === args.name) as DebugProtocol.Variable | undefined;
		if (!loadedChild) {
			const refreshedChildren = await this.loadContainerChildren(args.variablesReference, threadId);
			if (refreshedChildren) {
				loadedChildren = refreshedChildren;
				loadedChild = loadedChildren.find((entry) => entry.name === args.name) as DebugProtocol.Variable | undefined;
			}
		}
		const expressionToChange = loadedChild?.evaluateName || this.getExpression(args.variablesReference, args.name, threadId);
		const lines = (await this.request(`${expressionToChange} = ${args.value}`, threadId)).filter(e => { return e !== ''; });
		if (this.hasDebuggerCommandError(lines)) {
			this.logSendEvent(new OutputEvent(`Error setting value: ${lines.join(' ')}`, 'important'));
			response.success = false;
		} else {
			const value = this.extractCommandPayload(await this.request(this.buildOutputPrintCommand(`Data::Dumper->new([${(expressionToChange.startsWith('@') ? `[${expressionToChange}]` : (expressionToChange.startsWith('%') ? `{${expressionToChange}}` : expressionToChange))}], [])->Useqq(1)->Terse(1)->Dump()`), threadId)).join(' ');
			const trimmedValue = value.trim();
			if (loadedChild) {
				loadedChild.value = trimmedValue;
			}
			response.body = { value: `${trimmedValue}` };
		}
		this.logSendResponse(response);
	}

	protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): Promise<void> {
		const uniqueSources = new Map<string, Source>();
		const runtimes = Array.from(this.runtimes.values());
		for (let i = 0; i < runtimes.length; i++) {
			const runtime = runtimes[i];
			const lines = await this.request(`foreach my $INCKEY (keys %INC) { ${this.buildOutputPrintCommand('"$INCKEY||$INC{$INCKEY}\\n"')} }`, runtime.threadId);
			// remove first and last line
			lines.filter(e => { return e !== ''; }).slice(1, -1).forEach(line => {
				const tmp = line.split('||');
				if (tmp.length === 2) {
					const fullPath = tmp[1].replace(/^\.\//, `${this.cwd}/`);
					if (!uniqueSources.has(fullPath)) {
						uniqueSources.set(fullPath, new Source(tmp[0], fullPath));
					}
				}
			});
		}

		response.body = {
			sources: Array.from(uniqueSources.values())
		};

		this.logSendResponse(response);
	}

	private async execute(cmd: string, threadId: number = PerlDebugSession.threadId): Promise<void> {
		const lines = await this.request(cmd, threadId);
		this.forcedTopFrameByThread.delete(threadId);
		const index = lines.findIndex(e => { return e.match(/^main::.*|^Debugged program terminated.*|^(continue\s)?loaded source.*/); });
		const scriptOutput = lines.slice(1, index);
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.logSendEvent(new OutputEvent(scriptOutput.join('\n') + '\n', 'stderr'));
		}
		// check if we reached the end
		if (lines.join().includes('Debugged program terminated.')) {
			if (threadId === PerlDebugSession.threadId) {
				// ensure that every script output is send to the debug console before closing the session
				await this.request('sleep(.5)', threadId);
				this.logSendEvent(new TerminatedEvent());
			} else {
				// Send 'q' to the child perl5db so the child OS process actually exits.
				// This unblocks waitpid() in the parent and causes the socket 'close' event
				// to fire, which emits ThreadEvent('exited') and cleans up thread state.
				const runtime = this.runtimes.get(threadId);
				if (runtime?.socket && !runtime.socket.destroyed) {
					runtime.socket.write('q\n');
				}
			}
			return;
		}
		// the reason why the debugger paused the execution
		let reason: string;
		const newSource = lines.find(ln => { return ln.match(/loaded source/); });
		let loadedSourceHasPostponedBreakpoints = false;
		let loadedSourcePathForStop: string | undefined;
		let loadedSourcePreferredLine: number | undefined;
		if (newSource) {
			// set breakpoints in newly loaded file
			const matched = newSource.match(/loaded source (.*)/);
			if (matched) {
				let scriptPath = matched[1]!;
				if (scriptPath.match(/^\./)) {
					scriptPath = join(this.cwd, scriptPath);
				}
				scriptPath = this.normalizePathKey(scriptPath);
				const bps = this.getPathMappedBreakpoints(this.getRuntimePostponedBreakpoints(threadId), scriptPath);
				loadedSourceHasPostponedBreakpoints = !!(bps && bps.length > 0);
				loadedSourcePathForStop = scriptPath;
				if (bps && bps.length > 0) {
					loadedSourcePreferredLine = bps[0].line;
				}
				if (bps) {
					const fileChanged = await this.changeFileContext(scriptPath, threadId);
					if (!fileChanged) {
						reason = 'new source';
						this.currentStoppedThreadId = threadId;
						this.logSendEvent(new StoppedEvent(reason, threadId));
						return;
					}
					const appliedBreakpoints = await this.setBreakpointsInFile(scriptPath, bps, threadId);
					const hasUnresolved = appliedBreakpoints.some((bp) => !bp.verified);
					if (hasUnresolved) {
						this.currentStoppedThreadId = threadId;
						this.logSendEvent(new StoppedEvent('breakpoint', threadId));
						return;
					}
					// check if we already reached a breakpoint at current position
					// this can happen if the breakpoint is located at the first breakable line inside a file
					const currentLine = (await this.getStackFrames(threadId))[0].line;
					const runtimeBps = this.getPathMappedBreakpoints(this.getRuntimeBreakpoints(threadId), scriptPath) || bps;
					for (let i = 0; i < runtimeBps.length; i++) {
						const bp = runtimeBps[i];
						if (bp.line === currentLine) {
							this.logSendEvent(new StoppedEvent('breakpoint', threadId));
							return;
						}
					}
				}
			}
			if (cmd === 'c' && loadedSourceHasPostponedBreakpoints) {
				await this.request('sleep(.05)', threadId);
				if (loadedSourcePathForStop && loadedSourcePreferredLine) {
					this.forcedTopFrameByThread.set(threadId, {
						path: loadedSourcePathForStop,
						line: loadedSourcePreferredLine
					});
				}
				reason = 'breakpoint';
			} else if (newSource.startsWith('continue') && (cmd === 'n' || cmd === 'c')) {
				// Keep running for step-over or continue without postponed breakpoints.
				await this.continue(threadId);
				return;
			} else {
				// else we stop on reaching a new source
				reason = 'new source';
			}
		} else {
			const stoppedLocation = lines.find((line) => line.match(/^main::\((.*):(\d+)\):/));
			const matchedLocation = stoppedLocation?.match(/^main::\((.*):(\d+)\):/);
			if (matchedLocation) {
				let stoppedPath = matchedLocation[1];
				const isRelativeStoppedPath = stoppedPath.match(/^\./) !== null;
				if (isRelativeStoppedPath) {
					stoppedPath = join(this.cwd, stoppedPath);
				}

				const normalizedStoppedPath = this.normalizePathKey(stoppedPath);
				const normalizedCwd = this.normalizePathKey(this.cwd);
				const inWorkspace = normalizedStoppedPath.startsWith(normalizedCwd);

				if (!inWorkspace) {
					if (cmd === 'n') {
						await this.next(threadId);
					} else if (cmd === 'c') {
						await this.continue(threadId);
					}
					return;
				}

				if (cmd === 'c' && this.funcBps.length === 0 && isRelativeStoppedPath) {
					const stoppedLine = +matchedLocation[2];
					const runtimeBps = this.getPathMappedBreakpoints(this.getRuntimeBreakpoints(threadId), normalizedStoppedPath) || [];
					const isRealLineBreakpoint = runtimeBps.some((bp) => bp.line === stoppedLine);
					if (!isRealLineBreakpoint) {
						await this.continue(threadId);
						return;
					}
				}
			}

			if (cmd === 'c') {
				reason = 'breakpoint';
			} else {
				reason = 'step';
			}
		}
		this.currentStoppedThreadId = threadId;
		this.logSendEvent(new StoppedEvent(reason, threadId));
	}

	private async continue(threadId: number = PerlDebugSession.threadId): Promise<void> {
		await this.execute('c', threadId);
	}

	private pause(threadId: number = PerlDebugSession.threadId): boolean {
		if (threadId !== PerlDebugSession.threadId) {
			const runtime = this.runtimes.get(threadId);
			if (runtime?.socket && !runtime.socket.destroyed) {
				return runtime.socket.write('\u0003');
			}
			return false;
		}
		return this._session.kill('SIGINT');
	}

	private async next(threadId: number = PerlDebugSession.threadId): Promise<void> {
		await this.execute('n', threadId);
	}

	private async stepIn(threadId: number = PerlDebugSession.threadId): Promise<void> {
		await this.execute('s', threadId);
	}

	private async stepOut(threadId: number = PerlDebugSession.threadId): Promise<void> {
		await this.execute('r', threadId);
	}

	private runExecutionControlRequest(
		threadId: number,
		response: DebugProtocol.Response,
		requestName: string,
		run: () => Promise<void>
	): void {
		if (this.executionInProgressThreads.has(threadId)) {
			response.success = false;
			this.logSendEvent(new OutputEvent(
				`Ignored ${requestName} request for thread ${threadId} because another execution command is already running.\n`,
				'important'
			));
			this.logSendResponse(response);
			return;
		}

		this.executionInProgressThreads.add(threadId);
		this.logSendEvent(new ContinuedEvent(threadId, false));
		run().then(() => {
			this.logSendResponse(response);
		}).catch(() => {
			response.success = false;
			this.logSendResponse(response);
		}).finally(() => {
			this.executionInProgressThreads.delete(threadId);
		});
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
		const threadId = _args.threadId || PerlDebugSession.threadId;
		this.runExecutionControlRequest(threadId, response, 'continue', () => this.continue(threadId));
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
		const threadId = _args.threadId || PerlDebugSession.threadId;
		if (!this.pause(threadId)) {
			response.success = false;
		}
		this.logSendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
		const threadId = _args.threadId || PerlDebugSession.threadId;
		this.runExecutionControlRequest(threadId, response, 'next', () => this.next(threadId));
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
		const threadId = _args.threadId || PerlDebugSession.threadId;
		this.runExecutionControlRequest(threadId, response, 'stepIn', () => this.stepIn(threadId));
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments, _request?: DebugProtocol.Request): void {
		const threadId = _args.threadId || PerlDebugSession.threadId;
		this.runExecutionControlRequest(threadId, response, 'stepOut', () => this.stepOut(threadId));
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, _args: DebugProtocol.TerminateArguments, _request?: DebugProtocol.Request): void {
		this.cleanupDebuggerTransport();
		if (this._session) {
			this._session.kill();
		}
		this.logSendEvent(new TerminatedEvent(false));
		this.logSendResponse(response);
	}
}
