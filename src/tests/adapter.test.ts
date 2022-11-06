import * as assert from 'assert';
import * as Path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';

describe('Perl Debug Adapter', () => {

	const DEBUG_ADAPTER = './out/debugAdapter.js';
	const PROJECT_ROOT = Path.dirname(Path.dirname(__dirname));
	const CWD = Path.join(PROJECT_ROOT, 'src', 'tests', 'data');
	const PERL_SCRIPT = Path.join(CWD, 'test.pl');
	const INCLUDED_PERL_SCRIPT = Path.join(CWD, 'dbconfig.pl');

	let dc: DebugClient;

	beforeEach(() => {
		dc = new DebugClient('node', DEBUG_ADAPTER, 'perl');
		return dc.start();
	});

	afterEach(() => {
		dc.stop();
	});

	test('should stop inside main file', () => {
		return dc.hitBreakpoint(
			{ type: 'perl', program: PERL_SCRIPT, cwd: CWD, stopOnEntry: false },
			// breakpoint is set inside the main script and the line is breakable
			{ path: PERL_SCRIPT, line: 13 }
		);
	});

	test('should set breakpoint at next breakable line', () => {
		return dc.launch({ program: PERL_SCRIPT, cwd: CWD, stopOnEntry: true }).then((resp) => {
			assert.strictEqual(resp.success, true);
			dc.setBreakpointsRequest({ source: { path: PERL_SCRIPT }, breakpoints: [{ line: 20 }] }).then((resp) => {
				assert.strictEqual(resp.success, true);
				// line 20 is not breakable so we expect the breakpoint to be set on line 21 instead
				assert.strictEqual(resp.body.breakpoints[0].line, 21);
			});
		}).catch((err) => {
			assert.fail(err);
		});
	});

	test('should stop inside included file', () => {
		return dc.hitBreakpoint(
			{ type: 'perl', program: PERL_SCRIPT, cwd: CWD, stopOnEntry: false },
			// breakpoint is set inside a script that gets required by the main program
			{ path: INCLUDED_PERL_SCRIPT, line: 4 }
		);
	});

});
