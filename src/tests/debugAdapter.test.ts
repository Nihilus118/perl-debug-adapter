import * as Path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import * as fs from 'fs';

jest.setTimeout(10000);

describe('Perl Debug Adapter', () => {
	const DEBUG_ADAPTER = './out/debugAdapter.js';
	const PROJECT_ROOT = Path.dirname(__dirname);
	const CWD = Path.join(PROJECT_ROOT, 'tests', 'data');
	const PERL_SCRIPT = Path.join(CWD, 'test.pl');
	const INCLUDED_PERL_SCRIPT = Path.join(CWD, 'dbconfig.pl');
	const BROKEN_PERL_SCRIPT = Path.join(CWD, 'exception.pl');

	let dc: DebugClient;
	dc = new DebugClient('node', DEBUG_ADAPTER, 'perl', undefined, true);
	dc.defaultTimeout = 10000;

	beforeEach(async () => {
		await dc.start();
		// launch test script; also await the StoppedEvent('entry') so that the
		// event is fully drained from dc before the test body registers any
		// new waitForEvent('stopped') listeners.
		await Promise.all([
			dc.waitForEvent('stopped'),
			dc.launch({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			}),
		]);
	});

	afterEach(async () => {
		await dc.terminateRequest();
		await dc.stop();
	});

	async function goToLine(line: number): Promise<boolean> {
		const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: line }] });
		if (!setBps.success) {
			return false;
		}
		const cont = await dc.continueRequest({ threadId: 1 });
		if (!cont.success) {
			return false;
		}
		const trace = await dc.stackTraceRequest({ threadId: 1 });
		if (!trace.success || trace.body.stackFrames[0].source!.path !== PERL_SCRIPT || trace.body.stackFrames[0].line !== line) {
			return false;
		}
		return true;
	};

	describe('initialization', () => {
		test('return features', async () => {
			const init = await dc.initializeRequest();
			expect(init.body!.supportsConfigurationDoneRequest).toBe(true);
			expect(init.body!.supportsEvaluateForHovers).toBe(true);
			expect(init.body!.supportsDataBreakpoints).toBe(true);
			expect(init.body!.supportsSetVariable).toBe(true);
			expect(init.body!.supportsLoadedSourcesRequest).toBe(true);
			expect(init.body!.supportsFunctionBreakpoints).toBe(true);
			expect(init.body!.supportsConditionalBreakpoints).toBe(true);
			expect(init.body!.supportsTerminateRequest).toBe(true);
			expect(init.body!.supportsDelayedStackTraceLoading).toBe(false);
		});
	});

	describe('flow control', () => {
		test('stop on entry', async () => {
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			// first breakable line
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(7);
		});

		test('stop on breakpoint', async () => {
			expect(await goToLine(10)).toBe(true);
		});

		test('stop on postponed breakpoint', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: INCLUDED_PERL_SCRIPT }, breakpoints: [{ line: 5 }] });
			expect(setBps.success).toBe(true);
			// Register the listener BEFORE continuing. Because beforeEach already
			// drained the entry stop, this will only catch the NEXT stopped event
			// (the forced stop that fires when dbconfig.pl is loaded and the
			// breakpoint at line 5 is applied).
			const stoppedPromise = dc.waitForEvent('stopped');
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			await stoppedPromise;
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(INCLUDED_PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(5);
		});

		test('stop on entry is not broken by pre-launch breakpoints for other files', async () => {
			// Regression: applying pre-launch breakpoints for non-main-script files
			// triggered a perl5db regex crash on Windows paths, killing the process
			// before StoppedEvent('entry') was ever sent.
			await dc.terminateRequest();
			await dc.stop();
			await dc.start();

			await dc.initializeRequest();

			// IDE sends breakpoints for multiple files during the config phase
			await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 10 }] });
			await dc.setBreakpointsRequest({ source: { path: INCLUDED_PERL_SCRIPT }, breakpoints: [{ line: 5 }] });

			const stoppedPromise = dc.waitForEvent('stopped');

			await dc.launchRequest({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			} as any);

			const stoppedEvent = await stoppedPromise;
			expect(stoppedEvent.body.reason).toBe('entry');

			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(7);
		});

		test('breakpoints set before session launch are hit', async () => {
			// Simulate the IDE behaviour: breakpoints already selected before F5 is pressed.
			// The IDE sends setBreakpoints during the configuration sequence (after InitializedEvent
			// but before launch), so the adapter must not discard them when launchRequest runs.
			await dc.terminateRequest();
			await dc.stop();
			await dc.start();

			// Trigger InitializedEvent by sending the initialize request
			await dc.initializeRequest();

			// Set a breakpoint on line 10 BEFORE the launch request is sent
			await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 10 }] });

			// Register the stopped listener before launching so the event is not missed
			const stoppedPromise = dc.waitForEvent('stopped');

			// Launch without stopOnEntry ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ the only reason to stop should be the pre-set breakpoint
			await dc.launchRequest({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: false,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			} as any);

			await stoppedPromise;

			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(10);
		});

		test('pre-launch breakpoints in multiple files still stop on entry first', async () => {
			await dc.terminateRequest();
			await dc.stop();
			await dc.start();

			await dc.initializeRequest();

			// Simulate VS Code sending all workspace breakpoints before launch.
			const mainSet = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 10 }] });
			expect(mainSet.success).toBe(true);
			const includedSet = await dc.setBreakpointsRequest({ source: { path: INCLUDED_PERL_SCRIPT }, breakpoints: [{ line: 5 }] });
			expect(includedSet.success).toBe(true);
			const printfSet = await dc.setBreakpointsRequest({ source: { path: Path.join(CWD, 'printf.pl') }, breakpoints: [{ line: 11 }] });
			expect(printfSet.success).toBe(true);

			const stoppedPromise = dc.waitForEvent('stopped');

			await dc.launchRequest({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			} as any);

			const stoppedEvent = await stoppedPromise;
			expect(stoppedEvent.body.reason).toBe('entry');

			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(7);
		});

		test('non-main pre-launch breakpoint remains postponed until file is loaded', async () => {
			await dc.terminateRequest();
			await dc.stop();
			await dc.start();

			await dc.initializeRequest();

			const includedSet = await dc.setBreakpointsRequest({ source: { path: INCLUDED_PERL_SCRIPT }, breakpoints: [{ line: 5 }] });
			expect(includedSet.success).toBe(true);

			const entryStopped = dc.waitForEvent('stopped');
			await dc.launchRequest({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			} as any);
			await entryStopped;

			// At entry we are still in test.pl, so dbconfig.pl breakpoints must still be postponed.
			let trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(7);

			const loadedStop = dc.waitForEvent('stopped');
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			await loadedStop;

			trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(INCLUDED_PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(5);
		});

		test('non-main pre-launch breakpoint is eventually hit after file load', async () => {
			await dc.terminateRequest();
			await dc.stop();
			await dc.start();

			await dc.initializeRequest();

			const includedSet = await dc.setBreakpointsRequest({ source: { path: INCLUDED_PERL_SCRIPT }, breakpoints: [{ line: 5 }] });
			expect(includedSet.success).toBe(true);

			const entryStopped = dc.waitForEvent('stopped');
			await dc.launchRequest({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			} as any);
			await entryStopped;

			const loadedStop = dc.waitForEvent('stopped');
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			await loadedStop;

			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(INCLUDED_PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(5);
		});

		test('step into', async () => {
			expect(await goToLine(10)).toBe(true);
			// step into config.pl
			const step = await dc.stepInRequest({ threadId: 1 });
			expect(step.success).toBe(true);
			// expect to be inside of the included script
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(INCLUDED_PERL_SCRIPT);
		});

		test('step over', async () => {
			expect(await goToLine(18)).toBe(true);
			// step over HTTP::Request::new
			const step = await dc.nextRequest({ threadId: 1 });
			expect(step.success).toBe(true);
			// expect to still be inside of the main script
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(19);
		});

		test('terminate on syntax error', async () => {
			// terminate the working script first
			await dc.terminateRequest();
			await dc.stop();
			// now try to launch the script including the syntax error
			await dc.start();
			dc.launch({
				type: 'perl',
				request: 'launch',
				name: 'Perl Debug',
				program: BROKEN_PERL_SCRIPT,
				stopOnEntry: true,
				cwd: CWD,
				transport: 'stdio',
				sortKeys: true,
			}).then(() => {
				fail('launch request should not complete');
			}).catch(() => {
				// make the test pass on error
				expect(true).toBe(true);
			});
		});
	});

	describe('variable parsing', () => {
		test('scalar', async () => {
			expect(await goToLine(21)).toBe(true);
			const evaluate = await dc.evaluateRequest({ expression: '$dbname' });
			expect(evaluate.success).toBe(true);
			expect(evaluate.body.result).toBe('"testdb"');
		});

		test('array', async () => {
			expect(await goToLine(21)).toBe(true);
			const evaluate = await dc.evaluateRequest({ expression: '@list' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(JSON.parse(fs.readFileSync(Path.join(CWD, 'variables', 'list.json')).toString())).toEqual(variable.body);
		});

		test('hash', async () => {
			expect(await goToLine(21)).toBe(true);
			const evaluate = await dc.evaluateRequest({ expression: '%grades' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(variable.body.variables.map((entry) => entry.name)).toEqual(['Bar Foo', 'Foo Bar']);

			const barFoo = variable.body.variables.find((entry) => entry.name === 'Bar Foo');
			expect(barFoo).toBeDefined();
			expect(barFoo?.type).toBe('HASH');
			expect(barFoo?.namedVariables).toBe(3);

			const barFooChildren = await dc.variablesRequest({ variablesReference: barFoo!.variablesReference });
			expect(barFooChildren.success).toBe(true);
			expect(barFooChildren.body.variables.map((entry) => entry.name)).toEqual(['1', 'Art', 'Literature']);

			const art = barFooChildren.body.variables.find((entry) => entry.name === 'Art');
			expect(art).toBeDefined();
			expect(art?.type).toBe('HASH');
			expect(art?.namedVariables).toBe(1);
		});

		test('nested object', async () => {
			expect(await goToLine(21)).toBe(true);
			const evaluate = await dc.evaluateRequest({ expression: '$res' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(variable.body.variables.length).toBeGreaterThan(0);

			const content = variable.body.variables.find((entry) => entry.name === '_content');
			expect(content).toBeDefined();
			expect(content?.type).toBe('SCALAR');
			expect(content?.presentationHint?.kind).toBe('data');
			expect(content?.value.startsWith('"')).toBe(true);

			const responseMetadata = variable.body.variables.map((entry) => entry.name);
			expect(responseMetadata).toContain('_content');
			expect(responseMetadata).toContain('_headers');
			expect(responseMetadata).toContain('_rc');
		});

		test('filehandle', async () => {
			expect(await goToLine(21)).toBe(true);
			const evaluate = await dc.evaluateRequest({ expression: '$logfile' });
			expect(evaluate.success).toBe(true);
			expect(evaluate.body.result).toBe('\\*{"::\\$logfile"}');
		});
	});
});

describe('PerlDebugSession fork handling', () => {
	let session: any;
	let events: any[];

	beforeEach(() => {
		const { PerlDebugSession } = require('../perlDebug');
		session = new PerlDebugSession();
		events = [];
		session.sendEvent = (event: any) => {
			events.push(event);
		};
		session._session = {
			killed: false,
			kill: jest.fn(() => true)
		};
	});

	test('terminates unsupported forked sessions to avoid corrupted state', () => {
		session.activeTransport = 'stdio';
		session.handleSessionOutput('Forked, but do not know how to create a new TTY', 'stderr');

		expect(session._session.kill).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.event === 'terminated')).toBe(true);
		expect(events.some((event) => event.event === 'output' && event.body.category === 'important' && event.body.output.includes('not supported by this adapter'))).toBe(true);
	});

	test('does not terminate on unsupported-fork warning when socket transport is active', () => {
		session.activeTransport = 'socket';
		session.handleSessionOutput('Forked, but do not know how to create a new TTY', 'stderr');

		expect(session._session.kill).not.toHaveBeenCalled();
		expect(events.some((event) => event.event === 'terminated')).toBe(false);
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe('output');
		expect(events[0].body.category).toBe('stderr');
	});

	test('forwards normal process output without terminating the session', () => {
		session.handleSessionOutput('hello from perl\n', 'stdout');

		expect(session._session.kill).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe('output');
		expect(events[0].body.category).toBe('stdout');
		expect(events[0].body.output).toBe('hello from perl\n');
	});
});

describe('PerlDebugSession launch transport setup', () => {
	const PROJECT_ROOT = Path.dirname(__dirname);
	const CWD = Path.join(PROJECT_ROOT, 'tests', 'data');
	const PERL_SCRIPT = Path.join(CWD, 'test.pl');

	afterEach(() => {
		jest.resetModules();
		jest.restoreAllMocks();
		jest.clearAllMocks();
	});

	function createMockChildProcess() {
		const stdoutHandlers = new Map<string, Function[]>();
		const stderrHandlers = new Map<string, Function[]>();
		const processHandlers = new Map<string, Function[]>();
		const stdout: any = {
			on: jest.fn((event: string, handler: Function): any => {
				const handlers = stdoutHandlers.get(event) || [];
				handlers.push(handler);
				stdoutHandlers.set(event, handlers);
				return stdout;
			})
		};

		const stderr: any = {
			on: jest.fn((event: string, handler: Function): any => {
				const handlers = stderrHandlers.get(event) || [];
				handlers.push(handler);
				stderrHandlers.set(event, handlers);
				return stderr;
			})
		};

		const child: any = {
			stdin: {},
			stdout,
			stderr,
			killed: false,
			kill: jest.fn(() => true),
			on: jest.fn((event: string, handler: Function) => {
				const handlers = processHandlers.get(event) || [];
				handlers.push(handler);
				processHandlers.set(event, handlers);
				return child;
			})
		};

		return child;
	}

	function createMockSocketServer(onConnection: Function | undefined, socket: any) {
		const listeners = new Map<string, Function[]>();

		const server: any = {
			on: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				handlers.push(handler);
				listeners.set(event, handlers);
				return server;
			}),
			once: jest.fn((event: string, handler: Function) => {
				const wrapped = (...args: any[]) => {
					server.off(event, wrapped);
					handler(...args);
				};
				return server.on(event, wrapped);
			}),
			off: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				listeners.set(event, handlers.filter((entry) => entry !== handler));
				return server;
			}),
			emit: (event: string, ...args: any[]) => {
				if (event === 'connection' && onConnection) {
					onConnection(...args);
				}
				const handlers = listeners.get(event) || [];
				handlers.forEach((handler) => handler(...args));
			},
			listen: jest.fn((_port: number, _host: string, callback: Function) => {
				callback();
				setImmediate(() => {
					server.emit('connection', socket);
				});
				return server;
			}),
			address: jest.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 })),
			close: jest.fn()
		};

		return server;
	}

	function createMockDuplexSocket() {
		const listeners = new Map<string, Function[]>();
		const socket: any = {
			destroyed: false,
			on: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				handlers.push(handler);
				listeners.set(event, handlers);
				return socket;
			}),
			once: jest.fn((event: string, handler: Function) => {
				const wrapped = (...args: any[]) => {
					socket.off(event, wrapped);
					handler(...args);
				};
				socket.on(event, wrapped);
				return socket;
			}),
			off: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				listeners.set(event, handlers.filter((entry) => entry !== handler));
				return socket;
			}),
			write: jest.fn(() => true),
			destroy: jest.fn(() => {
				socket.destroyed = true;
				socket.emit('close');
			}),
			emit: (event: string, ...args: any[]) => {
				const handlers = listeners.get(event) || [];
				handlers.forEach((handler) => handler(...args));
			}
		};

		return socket;
	}

	function createLaunchResponse() {
		return {
			seq: 1,
			type: 'response',
			request_seq: 1,
			command: 'launch',
			success: true
		} as any;
	}

	function createLaunchArgs(overrides: Record<string, unknown> = {}) {
		return {
			program: PERL_SCRIPT,
			stopOnEntry: true,
			cwd: CWD,
			debug: true,
			type: 'perl',
			request: 'launch',
			name: 'Perl Debug',
			...overrides
		} as any;
	}

	test('uses socket transport by default', async () => {
		jest.resetModules();

		const child = createMockChildProcess();
		const socket = { destroyed: false, destroy: jest.fn() };
		let server: any;
		const spawnMock = jest.fn(() => child);
		const createServerMock = jest.fn((onConnection: Function) => {
			server = createMockSocketServer(onConnection, socket);
			return server;
		});

		jest.doMock('child_process', () => ({
			...jest.requireActual('child_process'),
			spawn: spawnMock
		}));
		jest.doMock('net', () => ({
			...jest.requireActual('net'),
			createServer: createServerMock
		}));

		const { PerlDebugSession } = require('../perlDebug');
		const session = new PerlDebugSession();
		(session as any).streamCatcher = { launch: jest.fn().mockResolvedValue([]), getBuffer: jest.fn(() => []), request: jest.fn() };
		jest.spyOn(session as any, 'request').mockResolvedValue(['ok']);
		session.sendEvent = jest.fn();
		(session as any).logSendResponse = jest.fn();

		await (session as any).launchRequest(createLaunchResponse(), createLaunchArgs());

		expect(createServerMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith(
			'perl',
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					PERLDB_OPTS: 'ReadLine=0 RemotePort=127.0.0.1:43123'
				})
			})
		);
		expect((session as any).streamCatcher.launch).toHaveBeenCalledWith(socket, socket);
	});

	test('uses stdio transport when requested', async () => {
		jest.resetModules();

		const child = createMockChildProcess();
		const spawnMock = jest.fn(() => child);
		const createServerMock = jest.fn();

		jest.doMock('child_process', () => ({
			...jest.requireActual('child_process'),
			spawn: spawnMock
		}));
		jest.doMock('net', () => ({
			...jest.requireActual('net'),
			createServer: createServerMock
		}));

		const { PerlDebugSession } = require('../perlDebug');
		const session = new PerlDebugSession();
		(session as any).streamCatcher = { launch: jest.fn().mockResolvedValue([]), getBuffer: jest.fn(() => []), request: jest.fn() };
		jest.spyOn(session as any, 'request').mockResolvedValue(['ok']);
		session.sendEvent = jest.fn();
		(session as any).logSendResponse = jest.fn();

		await (session as any).launchRequest(createLaunchResponse(), createLaunchArgs({ transport: 'stdio' }));

		expect(createServerMock).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledWith(
			'perl',
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					PERLDB_OPTS: 'ReadLine=0'
				})
			})
		);
		expect((session as any).streamCatcher.launch).toHaveBeenCalledWith(child.stdin, child.stderr);
	});

	test('uses socket transport when requested', async () => {
		jest.resetModules();

		const child = createMockChildProcess();
		const socket = { destroyed: false, destroy: jest.fn() };
		let server: any;
		const spawnMock = jest.fn(() => child);
		const createServerMock = jest.fn((onConnection: Function) => {
			server = createMockSocketServer(onConnection, socket);
			return server;
		});

		jest.doMock('child_process', () => ({
			...jest.requireActual('child_process'),
			spawn: spawnMock
		}));
		jest.doMock('net', () => ({
			...jest.requireActual('net'),
			createServer: createServerMock
		}));

		const { PerlDebugSession } = require('../perlDebug');
		const session = new PerlDebugSession();
		(session as any).streamCatcher = { launch: jest.fn().mockResolvedValue([]), getBuffer: jest.fn(() => []), request: jest.fn() };
		jest.spyOn(session as any, 'request').mockResolvedValue(['ok']);
		session.sendEvent = jest.fn();
		(session as any).logSendResponse = jest.fn();

		await (session as any).launchRequest(createLaunchResponse(), createLaunchArgs({ transport: 'socket' }));

		expect(createServerMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith(
			'perl',
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					PERLDB_OPTS: 'ReadLine=0 RemotePort=127.0.0.1:43123'
				})
			})
		);
		expect((session as any).streamCatcher.launch).toHaveBeenCalledWith(socket, socket);
	});

	test('maps additional socket connections to managed child thread runtimes', async () => {
		jest.resetModules();

		const child = createMockChildProcess();
		const primarySocket = createMockDuplexSocket();
		let server: any;
		const spawnMock = jest.fn(() => child);
		const createServerMock = jest.fn((onConnection: Function) => {
			server = createMockSocketServer(onConnection, primarySocket);
			return server;
		});

		jest.doMock('child_process', () => ({
			...jest.requireActual('child_process'),
			spawn: spawnMock
		}));
		jest.doMock('net', () => ({
			...jest.requireActual('net'),
			createServer: createServerMock
		}));

		const { PerlDebugSession } = require('../perlDebug');
		const session = new PerlDebugSession();
		(session as any).streamCatcher = { launch: jest.fn().mockResolvedValue([]), getBuffer: jest.fn(() => []), request: jest.fn() };
		jest.spyOn(session as any, 'request').mockResolvedValue(['ok']);
		session.sendEvent = jest.fn();
		(session as any).logSendResponse = jest.fn();

		await (session as any).launchRequest(createLaunchResponse(), createLaunchArgs({ transport: 'socket' }));

		const childSocket = createMockDuplexSocket();
		server.emit('connection', childSocket);
		childSocket.emit('data', Buffer.from('DB<1>\n'));
		await new Promise((resolve) => setImmediate(resolve));

		expect(childSocket.destroy).not.toHaveBeenCalled();

		const sentEvents = (session.sendEvent as jest.Mock).mock.calls.map((call) => call[0]);
		const threadEvents = sentEvents.filter((event) => event.event === 'thread');
		expect(threadEvents.some((event) => event.body.reason === 'started')).toBe(true);
		expect(sentEvents.some((event) => event.event === 'output' && event.body.category === 'important' && event.body.output.includes('Attached forked perl5db child transport'))).toBe(true);

		const threadsResponse: any = {
			seq: 2,
			type: 'response',
			request_seq: 2,
			command: 'threads',
			success: true
		};
		(session as any).logSendResponse = jest.fn();
		await (session as any).threadsRequest(threadsResponse);
		expect(threadsResponse.body.threads.some((thread: any) => thread.id === 2)).toBe(true);
	});

	test('sends launch response before initial stopped event on stopOnEntry', async () => {
		jest.resetModules();

		const child = createMockChildProcess();
		const spawnMock = jest.fn(() => child);
		const createServerMock = jest.fn();

		jest.doMock('child_process', () => ({
			...jest.requireActual('child_process'),
			spawn: spawnMock
		}));
		jest.doMock('net', () => ({
			...jest.requireActual('net'),
			createServer: createServerMock
		}));

		const { PerlDebugSession } = require('../perlDebug');
		const session = new PerlDebugSession();
		(session as any).streamCatcher = { launch: jest.fn().mockResolvedValue([]), getBuffer: jest.fn(() => []), request: jest.fn() };
		jest.spyOn(session as any, 'request').mockResolvedValue(['ok']);
		session.sendEvent = jest.fn();
		(session as any).logSendResponse = jest.fn();

		await (session as any).launchRequest(createLaunchResponse(), createLaunchArgs({ stopOnEntry: true, transport: 'stdio' }));

		const events = (session.sendEvent as jest.Mock).mock.calls.map((call) => call[0]);
		const stoppedIndex = events.findIndex((event) => event.event === 'stopped' && event.body.reason === 'entry');
		expect(stoppedIndex).toBeGreaterThanOrEqual(0);

		const stoppedCallOrder = (session.sendEvent as jest.Mock).mock.invocationCallOrder[stoppedIndex];
		const responseCallOrder = (session as any).logSendResponse.mock.invocationCallOrder[0];
		expect(responseCallOrder).toBeLessThan(stoppedCallOrder);
	});
});

describe('PerlDebugSession thread-aware routing', () => {
	let session: any;

	function createThreadAwareMockSocket() {
		const listeners = new Map<string, Function[]>();
		const socket: any = {
			destroyed: false,
			on: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				handlers.push(handler);
				listeners.set(event, handlers);
				return socket;
			}),
			once: jest.fn((event: string, handler: Function) => {
				const wrapped = (...args: any[]) => {
					socket.off(event, wrapped);
					handler(...args);
				};
				socket.on(event, wrapped);
				return socket;
			}),
			off: jest.fn((event: string, handler: Function) => {
				const handlers = listeners.get(event) || [];
				listeners.set(event, handlers.filter((entry) => entry !== handler));
				return socket;
			}),
			write: jest.fn(() => true),
			destroy: jest.fn(() => {
				socket.destroyed = true;
				socket.emit('close');
			}),
			emit: (event: string, ...args: any[]) => {
				const handlers = listeners.get(event) || [];
				handlers.forEach((handler) => handler(...args));
			}
		};

		return socket;
	}

	beforeEach(() => {
		jest.resetModules();
		const { PerlDebugSession } = require('../perlDebug');
		session = new PerlDebugSession();
		session.sendEvent = jest.fn();
		session.logSendResponse = jest.fn();
		session.request = jest.fn().mockResolvedValue([
			'T',
			'@ = main::test called from file \'./test.pl\' line 7',
			'DB<1>'
		]);
		session.parseVars = jest.fn().mockResolvedValue([
			{ name: '$x', value: '1', variablesReference: 0, evaluateName: '$x', presentationHint: { kind: 'data' }, type: 'SCALAR' }
		]);
		session.getExpression = jest.fn().mockReturnValue('$x');
	});

	afterEach(() => {
		jest.restoreAllMocks();
		jest.clearAllMocks();
	});

	test('routes stackTrace request to selected thread runtime', async () => {
		const response: any = { seq: 1, type: 'response', request_seq: 1, command: 'stackTrace', success: true };
		await session.stackTraceRequest(response, { threadId: 2 } as any);

		expect(session.request).toHaveBeenCalledWith('T', 2);
		expect(response.body.stackFrames.length).toBeGreaterThan(0);
	});

	test('parses alternate at-format stack lines to keep source location visible', async () => {
		session.request = jest.fn().mockResolvedValue([
			'T',
			'main::worker at ./fork_socket_manual.pl line 44.',
			'DB<1>'
		]);

		const response: any = { seq: 11, type: 'response', request_seq: 11, command: 'stackTrace', success: true };
		await session.stackTraceRequest(response, { threadId: 1 } as any);

		expect(response.body.stackFrames.length).toBeGreaterThan(0);
		expect(response.body.stackFrames[0].source.path.endsWith('fork_socket_manual.pl')).toBe(true);
		expect(response.body.stackFrames[0].line).toBe(44);
	});

	test('routes scope variables request to thread from frame context', async () => {
		const scopesResponse: any = { seq: 2, type: 'response', request_seq: 2, command: 'scopes', success: true };
		session.frameThreadMap.set(77, 2);
		session.request = jest.fn().mockResolvedValue(['cmd', '', 'DB<1>']);

		session.scopesRequest(scopesResponse, { frameId: 77 } as any);
		const myScopeRef = scopesResponse.body.scopes[0].variablesReference;

		const varsResponse: any = { seq: 3, type: 'response', request_seq: 3, command: 'variables', success: true };
		await session.variablesRequest(varsResponse, { variablesReference: myScopeRef } as any);

		expect(session.request).toHaveBeenCalledWith('print STDERR join ("|", sort(keys( % { PadWalker::peek_my(2); })))', 2);
	});

	test('routes evaluate request to frame thread', async () => {
		const response: any = { seq: 4, type: 'response', request_seq: 4, command: 'evaluate', success: true };
		session.frameThreadMap.set(99, 2);

		await session.evaluateRequest(response, { expression: '$x', frameId: 99 } as any);

		expect(session.parseVars).toHaveBeenCalledWith(['$x'], 2);
	});

	test('routes setVariable request using variablesReference thread mapping', async () => {
		const response: any = { seq: 5, type: 'response', request_seq: 5, command: 'setVariable', success: true };
		session.variableThreadMap.set(123, 2);
		session.request = jest.fn().mockResolvedValue(['cmd', 'DB<1>']);

		await session.setVariableRequest(response, {
			variablesReference: 123,
			name: 'x',
			value: '2'
		} as any);

		expect(session.getExpression).toHaveBeenCalledWith(123, 'x', 2);
		expect((session.request as jest.Mock).mock.calls[0][1]).toBe(2);
	});

	test('rejects duplicate continue while same thread execution command is in-flight', () => {
		session.continue = jest.fn(() => new Promise<void>(() => { return; }));

		const firstResponse: any = { seq: 50, type: 'response', request_seq: 50, command: 'continue', success: true };
		const secondResponse: any = { seq: 51, type: 'response', request_seq: 51, command: 'continue', success: true };

		session.continueRequest(firstResponse, { threadId: 1 } as any);
		session.continueRequest(secondResponse, { threadId: 1 } as any);

		expect(session.continue).toHaveBeenCalledTimes(1);
		expect(secondResponse.success).toBe(false);
		const events = (session.sendEvent as jest.Mock).mock.calls.map((call) => call[0]);
		const continuedEvents = events.filter((event) => event.event === 'continued' && event.body.threadId === 1);
		expect(continuedEvents.length).toBe(1);
		expect(continuedEvents[0].body.allThreadsContinued).toBe(false);
		expect(events.some((event) => event.event === 'output' && event.body.output.includes('Ignored continue request'))).toBe(true);
	});

	test('auto-continues continue-stop when current location has no runtime line breakpoint', async () => {
		session.funcBps = [];
		session.request = jest.fn().mockResolvedValue([
			'c',
			'main::(./dbconfig.pl:4):',
			'DB<11>'
		]);
		session.getStackFrames = jest.fn().mockResolvedValue([
			{ line: 4, source: { path: 'C:\\repo\\dbconfig.pl' } }
		]);
		session.runtimeBreakpointsMap.set(1, new Map([
			['C:\\repo\\fork_socket_manual.pl', [{ id: 1, line: 47, condition: '' }]]
		]));
		session.continue = jest.fn().mockResolvedValue(undefined);

		await session.execute('c', 1);

		expect(session.continue).toHaveBeenCalledWith(1);
		const events = (session.sendEvent as jest.Mock).mock.calls.map((call) => call[0]);
		expect(events.some((event) => event.event === 'stopped')).toBe(false);
	});

	test('synchronizes function breakpoints across all active runtimes', async () => {
		session.streamCatcher.input = {};
		session.runtimes.set(1, { threadId: 1, name: 'thread 1', streamCatcher: {}, isPrimary: true });
		session.runtimes.set(2, { threadId: 2, name: 'thread 2', streamCatcher: {}, isPrimary: false });
		session.request = jest.fn().mockResolvedValue(['cmd', 'ok', 'DB<1>']);

		const response: any = { seq: 6, type: 'response', request_seq: 6, command: 'setFunctionBreakpoints', success: true };
		await session.setFunctionBreakPointsRequest(response, {
			breakpoints: [{ name: 'My::func', condition: '1' }]
		} as any);

		expect(session.request).toHaveBeenCalledWith('b My::func 1', 1);
		expect(session.request).toHaveBeenCalledWith('b My::func 1', 2);
	});

	test('aggregates loaded sources from all runtimes', async () => {
		session.runtimes.set(1, { threadId: 1, name: 'thread 1', streamCatcher: {}, isPrimary: true });
		session.runtimes.set(2, { threadId: 2, name: 'thread 2', streamCatcher: {}, isPrimary: false });
		session.request = jest.fn(async (_cmd: string, threadId: number) => {
			if (threadId === 1) {
				return ['cmd', 'Foo.pm||./lib/Foo.pm', 'DB<1>'];
			}
			return ['cmd', 'Bar.pm||./lib/Bar.pm', 'Foo.pm||./lib/Foo.pm', 'DB<1>'];
		});

		const response: any = { seq: 7, type: 'response', request_seq: 7, command: 'loadedSources', success: true };
		await session.loadedSourcesRequest(response, {} as any);

		expect(session.request).toHaveBeenCalledWith('foreach my $INCKEY (keys %INC) { print STDERR "$INCKEY||$INC{$INCKEY}\\n" }', 1);
		expect(session.request).toHaveBeenCalledWith('foreach my $INCKEY (keys %INC) { print STDERR "$INCKEY||$INC{$INCKEY}\\n" }', 2);
		expect(response.body.sources.length).toBe(2);
	});

	test('syncRuntimeBreakpoints mirrors file and function breakpoints to a child runtime', async () => {
		session.desiredBreakpointsMap.set('C:\\repo\\test.pl', [{ id: 1, line: 10, condition: '1' }]);
		session.funcBps = [{ name: 'My::func', condition: '1' }];
		session.changeFileContext = jest.fn().mockResolvedValue('test.pl');
		session.request = jest.fn().mockResolvedValue(['cmd', 'ok', 'DB<1>']);
		session.runtimeBreakpointsMap.set(2, new Map());
		session.runtimePostponedBreakpointsMap.set(2, new Map());

		await session.syncRuntimeBreakpoints(2);

		expect(session.changeFileContext).toHaveBeenCalledWith('C:\\repo\\test.pl', 2);
		expect(session.request).toHaveBeenCalledWith('b 10 1', 2);
		expect(session.request).toHaveBeenCalledWith('b My::func 1', 2);
	});

	test('applyBreakpointsToRuntime keeps unresolved breakpoints in runtime-postponed map', async () => {
		session.changeFileContext = jest.fn().mockResolvedValue(undefined);
		session.runtimePostponedBreakpointsMap.set(2, new Map());

		await session.applyBreakpointsToRuntime('C:\\repo\\late.pl', [{ id: 1, line: 11, condition: '1' }], 2);

		expect(session.runtimePostponedBreakpointsMap.get(2).get('C:\\repo\\late.pl')).toEqual([{ id: 1, line: 11, condition: '1' }]);
	});

	test('setBreakPointsRequest stores postponed breakpoints for each active runtime', async () => {
		session.streamCatcher.input = {};
		session.runtimes.set(1, { threadId: 1, name: 'thread 1', streamCatcher: {}, isPrimary: true });
		session.runtimes.set(2, { threadId: 2, name: 'thread 2', streamCatcher: {}, isPrimary: false });
		session.runtimePostponedBreakpointsMap.set(1, new Map());
		session.runtimePostponedBreakpointsMap.set(2, new Map());
		session.changeFileContext = jest.fn().mockResolvedValue(undefined);

		const response: any = { seq: 8, type: 'response', request_seq: 8, command: 'setBreakpoints', success: true };
		await session.setBreakPointsRequest(response, {
			source: { path: 'C:\\repo\\late.pl' },
			breakpoints: [{ line: 33, condition: '1' }]
		} as any);

		expect(session.runtimePostponedBreakpointsMap.get(1).has('C:\\repo\\late.pl')).toBe(true);
		expect(session.runtimePostponedBreakpointsMap.get(2).has('C:\\repo\\late.pl')).toBe(true);
	});

	test('changeFileContext treats perl5db regex errors as failure', async () => {
		session.request = jest.fn()
			// basename candidate => not loaded
			.mockResolvedValueOnce(['f fork_socket_manual.pl', "No file matching 'fork_socket_manual.pl' is loaded.", 'DB<1>'])
			// absolute candidate => perl5db regex error on Windows-style backslashes
			.mockResolvedValueOnce([
				'f C:\\repo\\fork_socket_manual.pl',
				'\\C no longer supported in regex; marked by <-- HERE in m/^_<.*C:\\ <-- HERE repo\\fork_socket_manual.pl/ at C:/berrybrew/instance/5.38.0_64/perl/lib/perl5db.pl line 1899.',
				'DB<1>'
			])
			// forward-slash absolute candidate => also not loaded
			.mockResolvedValueOnce(['f C:/repo/fork_socket_manual.pl', "No file matching 'C:/repo/fork_socket_manual.pl' is loaded.", 'DB<1>']);

		const changed = await session.changeFileContext('C:\\repo\\fork_socket_manual.pl', 1);

		expect(changed).toBeUndefined();
		expect(session.request).toHaveBeenCalledTimes(3);
		expect(session.request).toHaveBeenNthCalledWith(1, 'f fork_socket_manual.pl', 1);
		expect(session.request).toHaveBeenNthCalledWith(2, 'f C:\\repo\\fork_socket_manual.pl', 1);
		expect(session.request).toHaveBeenNthCalledWith(3, 'f C:/repo/fork_socket_manual.pl', 1);
	});

	test('runtime postponed overlays are cloned from desired state', () => {
		session.desiredPostponedBreakpointsMap.set('C:\\repo\\late.pl', [{ id: 1, line: 11, condition: '1' }]);

		const runtimePostponed = session.getRuntimePostponedBreakpoints(2);
		runtimePostponed.get('C:\\repo\\late.pl')[0].line = 99;

		expect(session.desiredPostponedBreakpointsMap.get('C:\\repo\\late.pl')[0].line).toBe(11);
	});

	test('applyBreakpointsToRuntime unresolved updates runtime overlay only', async () => {
		session.desiredPostponedBreakpointsMap.set('C:\\repo\\late.pl', [{ id: 1, line: 11, condition: '1' }]);
		session.changeFileContext = jest.fn().mockResolvedValue(undefined);

		await session.applyBreakpointsToRuntime('C:\\repo\\late.pl', [{ id: 2, line: 22, condition: '2' }], 2);

		expect(session.runtimePostponedBreakpointsMap.get(2).get('C:\\repo\\late.pl')).toEqual([{ id: 2, line: 22, condition: '2' }]);
		expect(session.desiredPostponedBreakpointsMap.get('C:\\repo\\late.pl')).toEqual([{ id: 1, line: 11, condition: '1' }]);
	});

	test('clearThreadScopedState removes per-thread frames variables and runtime overlays', () => {
		session.currentStoppedThreadId = 2;
		session.frameThreadMap.set(100, 2);
		session.frameThreadMap.set(101, 1);
		session.variableThreadMap.set(123, 2);
		session.variableThreadMap.set(124, 1);
		session.threadVarRef.set(2, 995);
		session.threadVarRef.set(1, 999);
		session.childVarsMap.set(200999, [{ name: '$x', value: '1', variablesReference: 0 }]);
		session.childVarsMap.set(100999, [{ name: '$y', value: '2', variablesReference: 0 }]);
		session.parentVarsMap.set(200999, { name: '$x', value: '1', variablesReference: 0 });
		session.parentVarsMap.set(100999, { name: '$y', value: '2', variablesReference: 0 });
		session.runtimeBreakpointsMap.set(2, new Map([['C:\\repo\\x.pl', [{ id: 1, line: 5, condition: '' }]]]));
		session.runtimeBreakpointsMap.set(1, new Map([['C:\\repo\\x.pl', [{ id: 2, line: 6, condition: '' }]]]));
		session.runtimePostponedBreakpointsMap.set(2, new Map([['C:\\repo\\x.pl', [{ id: 3, line: 7, condition: '' }]]]));
		session.runtimePostponedBreakpointsMap.set(1, new Map([['C:\\repo\\x.pl', [{ id: 4, line: 8, condition: '' }]]]));

		session.clearThreadScopedState(2);

		expect(session.frameThreadMap.has(100)).toBe(false);
		expect(session.frameThreadMap.has(101)).toBe(true);
		expect(session.variableThreadMap.has(123)).toBe(false);
		expect(session.variableThreadMap.has(124)).toBe(true);
		expect(session.threadVarRef.has(2)).toBe(false);
		expect(session.threadVarRef.has(1)).toBe(true);
		expect(session.childVarsMap.has(200999)).toBe(false);
		expect(session.childVarsMap.has(100999)).toBe(true);
		expect(session.parentVarsMap.has(200999)).toBe(false);
		expect(session.parentVarsMap.has(100999)).toBe(true);
		expect(session.runtimeBreakpointsMap.has(2)).toBe(false);
		expect(session.runtimeBreakpointsMap.has(1)).toBe(true);
		expect(session.runtimePostponedBreakpointsMap.has(2)).toBe(false);
		expect(session.runtimePostponedBreakpointsMap.has(1)).toBe(true);
		expect(session.currentStoppedThreadId).toBe(1);
	});

	test('child runtime close emits thread exit and clears thread state', async () => {
		session.request = jest.fn().mockResolvedValue(['cmd', 'ok', 'DB<1>']);
		session.frameThreadMap.set(501, 2);
		session.variableThreadMap.set(502, 2);
		const { StreamCatcher } = require('../streamCatcher');
		jest.spyOn(StreamCatcher.prototype, 'launch').mockResolvedValue(undefined);
		jest.spyOn(session, 'syncRuntimeBreakpoints').mockResolvedValue(undefined);

		const childSocket = createThreadAwareMockSocket();
		await session.registerChildRuntime(childSocket as any);
		childSocket.emit('close');

		expect(session.runtimes.has(2)).toBe(false);
		expect(session.runtimeBreakpointsMap.has(2)).toBe(false);
		expect(session.runtimePostponedBreakpointsMap.has(2)).toBe(false);
		expect(session.frameThreadMap.has(501)).toBe(false);
		expect(session.variableThreadMap.has(502)).toBe(false);

		const sentEvents = (session.sendEvent as jest.Mock).mock.calls.map((call) => call[0]);
		const threadEvents = sentEvents.filter((event) => event.event === 'thread');
		expect(threadEvents.some((event) => event.body.reason === 'started' && event.body.threadId === 2)).toBe(true);
		expect(threadEvents.some((event) => event.body.reason === 'exited' && event.body.threadId === 2)).toBe(true);
	});

	test('late child attach synchronizes latest desired breakpoints and function breakpoints', async () => {
		session.desiredBreakpointsMap.set('C:\\repo\\test.pl', [{ id: 10, line: 25, condition: '$x > 1' }]);
		session.funcBps = [{ name: 'My::func', condition: '1' }];
		session.changeFileContext = jest.fn().mockResolvedValue('test.pl');
		session.request = jest.fn().mockResolvedValue(['cmd', 'ok', 'DB<1>']);
		const { StreamCatcher } = require('../streamCatcher');
		jest.spyOn(StreamCatcher.prototype, 'launch').mockResolvedValue(undefined);

		const childSocket = createThreadAwareMockSocket();
		await session.registerChildRuntime(childSocket as any);

		expect(session.changeFileContext).toHaveBeenCalledWith('C:\\repo\\test.pl', 2);
		expect(session.request).toHaveBeenCalledWith('b 25 $x > 1', 2);
		expect(session.request).toHaveBeenCalledWith('b My::func 1', 2);
		expect(session.runtimeBreakpointsMap.get(2).get('C:\\repo\\test.pl')).toEqual([{ id: 10, line: 25, condition: '$x > 1' }]);
	});

	test('late child attach initializes postponed overlay from desired state, not primary runtime overlay drift', async () => {
		session.desiredPostponedBreakpointsMap.set('C:\\repo\\late.pl', [{ id: 1, line: 11, condition: 'desired' }]);
		session.runtimePostponedBreakpointsMap.set(1, new Map([
			['C:\\repo\\late.pl', [{ id: 2, line: 22, condition: 'primary-only' }]]
		]));
		session.syncRuntimeBreakpoints = jest.fn().mockResolvedValue(undefined);
		const { StreamCatcher } = require('../streamCatcher');
		jest.spyOn(StreamCatcher.prototype, 'launch').mockResolvedValue(undefined);

		const childSocket = createThreadAwareMockSocket();
		await session.registerChildRuntime(childSocket as any);

		expect(session.runtimePostponedBreakpointsMap.get(2).get('C:\\repo\\late.pl')).toEqual([{ id: 1, line: 11, condition: 'desired' }]);
		expect(session.runtimePostponedBreakpointsMap.get(2).get('C:\\repo\\late.pl')).not.toEqual([{ id: 2, line: 22, condition: 'primary-only' }]);
	});

	test('late child attach after repeated desired breakpoint updates syncs only latest revision', async () => {
		session.desiredBreakpointsMap.set('C:\\repo\\test.pl', [{ id: 1, line: 10, condition: 'old' }]);
		session.desiredBreakpointsMap.set('C:\\repo\\test.pl', [{ id: 2, line: 40, condition: 'latest' }]);
		session.changeFileContext = jest.fn().mockResolvedValue('test.pl');
		session.request = jest.fn().mockResolvedValue(['cmd', 'ok', 'DB<1>']);
		const { StreamCatcher } = require('../streamCatcher');
		jest.spyOn(StreamCatcher.prototype, 'launch').mockResolvedValue(undefined);

		const childSocket = createThreadAwareMockSocket();
		await session.registerChildRuntime(childSocket as any);

		expect(session.request).toHaveBeenCalledWith('b 40 latest', 2);
		expect(session.request).not.toHaveBeenCalledWith('b 10 old', 2);
		expect(session.runtimeBreakpointsMap.get(2).get('C:\\repo\\test.pl')).toEqual([{ id: 2, line: 40, condition: 'latest' }]);
	});
});
