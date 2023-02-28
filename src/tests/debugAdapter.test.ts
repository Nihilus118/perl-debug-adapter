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
			cwd: CWD
		});
	});

	afterEach(async () => {
		await dc.terminateRequest();
		await dc.stop();
	});

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
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 10 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(10);
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
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 10 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			// step into config.pl
			const step = await dc.stepInRequest({ threadId: 1 });
			expect(step.success).toBe(true);
			// expect to be inside of the included script
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(INCLUDED_PERL_SCRIPT);
		});

		test('step over', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 18 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			let trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(18);
			// step over HTTP::Request::new
			const step = await dc.nextRequest({ threadId: 1 });
			expect(step.success).toBe(true);
			// expect to still be inside of the main script
			trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(19);
		});
	});


	describe('variable parsing', () => {
		test('scalar', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 21 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(21);
			const evaluate = await dc.evaluateRequest({ expression: '$dbname' });
			expect(evaluate.success).toBe(true);
			expect(evaluate.body.result).toBe('"testdb"');
		});

		test('array', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 21 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(21);
			const evaluate = await dc.evaluateRequest({ expression: '@list' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(JSON.parse(fs.readFileSync(Path.join(CWD, 'variables', 'list.json')).toString())).toEqual(variable.body);
		});

		test('hash', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 21 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(21);
			const evaluate = await dc.evaluateRequest({ expression: '%grades' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(JSON.parse(fs.readFileSync(Path.join(CWD, 'variables', 'grades.json')).toString())).toEqual(variable.body);
		});

		test('nested object', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 21 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(21);
			// Parsing of Variable values
			const evaluate = await dc.evaluateRequest({ expression: '$res' });
			expect(evaluate.success).toBe(true);
			const variable = await dc.variablesRequest({ variablesReference: evaluate.body.variablesReference });
			expect(variable.success).toBe(true);
			expect(JSON.parse(fs.readFileSync(Path.join(CWD, 'variables', 'res.json')).toString())).toEqual(variable.body.variables[0]);
		});

		test('filehandle', async () => {
			const setBps = await dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 21 }] });
			expect(setBps.success).toBe(true);
			const cont = await dc.continueRequest({ threadId: 1 });
			expect(cont.success).toBe(true);
			const trace = await dc.stackTraceRequest({ threadId: 1 });
			expect(trace.success).toBe(true);
			expect(trace.body.stackFrames[0].source!.path).toBe(PERL_SCRIPT);
			expect(trace.body.stackFrames[0].line).toBe(21);
			const evaluate = await dc.evaluateRequest({ expression: '$logfile' });
			expect(evaluate.success).toBe(true);
			expect(evaluate.body.result).toBe('\\*{"::\\$logfile"}');
		});
	});
});
