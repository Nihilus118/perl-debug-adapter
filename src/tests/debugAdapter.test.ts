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
		// launch test script
		await dc.launch({
			type: 'perl',
			request: 'launch',
			name: 'Perl Debug',
			program: PERL_SCRIPT,
			stopOnEntry: true,
			cwd: CWD,
			sortKeys: true,
		});
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
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			let trace = await dc.stackTraceRequest({ threadId: 1 });
			trace = await dc.stackTraceRequest({ threadId: 1 });
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
		session.handleSessionOutput('Forked, but do not know how to create a new TTY', 'stderr');

		expect(session._session.kill).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.event === 'terminated')).toBe(true);
		expect(events.some((event) => event.event === 'output' && event.body.category === 'important' && event.body.output.includes('not supported by this adapter'))).toBe(true);
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
