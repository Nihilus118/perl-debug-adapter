import {
	Breakpoint,
	BreakpointEvent, Handles, InitializedEvent, Logger, logger,
	LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { PerlRuntimeWrapper } from './perlRuntimeWrapper';


export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	debug: boolean;
	stopOnEntry: boolean;
	perlExecutable?: string;
	args?: string[];
	cwd?: string;
	env?: object[];
}

export interface IBreakpointData {
	line: number,
	id: number;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;
	private currentVarRef = 999;
	private currentBreakpointID = 1;

	private _configurationDone = new Subject();

	private _runtime: PerlRuntimeWrapper;

	private _variableHandles = new Handles<'locals' | 'globals'>();
	private varsMap = new Map<number, Variable[]>();
	private bps: IBreakpointData[] = [];

	public constructor() {
		super("perl-debug.txt");

		this._runtime = new PerlRuntimeWrapper();

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnException', (exception) => {
			this.sendEvent(new StoppedEvent(`exception(${exception})`, PerlDebugSession.threadId));
			this.sendEvent(
				new StoppedEvent("postfork", PerlDebugSession.threadId)
			);
		});
		this._runtime.on('breakpointValidated', (bp: [boolean, number, number]) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp[0], line: bp[1], id: bp[2] } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (text: string) => {
			this.sendEvent(new OutputEvent(`${text}`));
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// clear parsed variables
		this.varsMap.clear();
		this.currentVarRef = 999;

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		await this._runtime.start(
			args.perlExecutable || 'perl',
			args.program,
			!!args.stopOnEntry,
			args.debug, args.args || [],
			this.bps
		);
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// save breakpoints in memory
		const clientLines = args.lines || [];

		// set breakpoints inside the debugger
		let bps: Breakpoint[] = [];
		this.currentBreakpointID = 1;
		for (let i = 0; i < clientLines.length; i++) {
			const bp = new Breakpoint(false, clientLines[i]);
			bp.setId(this.currentBreakpointID);
			this.bps.push({ id: this.currentBreakpointID, line: clientLines[i] } as IBreakpointData);
			bps.push(bp);
			this.currentBreakpointID++;
		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: bps
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(PerlDebugSession.threadId, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		let stackFrames: StackFrame[] = [];

		const lines = await this._runtime.request('T');
		let count = 1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('@')) {
				// TODO: More detailed parsing of stack frames
				let nm = line.split(' = ')[1];
				nm = nm.split("'")[0];
				const fn = new Source(line.split("'")[1]);
				const ln = line.split('line ')[1];
				stackFrames.push(new StackFrame(count, nm, fn, +ln));
				count++;
			}
		}

		response.body = {
			stackFrames: stackFrames,
			totalFrames: stackFrames.length
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Locals", this._variableHandles.create('locals'), false),
				// new Scope("Globals", this._variableHandles.create('globals'), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		response.body = {
			variables: await this.parseVars(args.variablesReference)
		};

		this.sendResponse(response);
	}

	private async parseVars(ref: number): Promise<Variable[]> {
		let vs: Variable[] = [];

		// Get all top level vars
		if (ref >= 1000) {
			const lines = await this._runtime.request("y");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// we reached a new variable
				if (line.includes(' = ')) {
					const type = line.charAt(0);
					let newVars: Variable;
					switch (type) {
						case '$':
							// Parse hashes
							newVars = this.parseScalar(lines, i);
							break;
						case '@':
							// Parse lists
							newVars = this.parseList(lines, i);
							break;
						case '%':
							// Parse hashes
							newVars = this.parseHash(lines, i);
							break;
						default:
							newVars = this.parseScalar(lines, i);
							break;
					}
					// add new variables to list
					vs.push(newVars);
				}
			}
		} else {
			// Get already parsed vars from map
			const newVars = this.varsMap.get(ref);
			if (newVars) {
				vs = vs.concat(newVars);
			}
		}

		// return all vars
		return vs;
	}

	private parseScalar(lines: string[], i: number): Variable {
		const tmp = lines[i].split(' = ');
		return new Variable(tmp[0], tmp[1]);
	}

	private parseList(lines: string[], i: number): Variable {
		const name = lines[i].split(' = ')[0];
		const ref = this.currentVarRef;
		const v = new Variable(name, '', ref);

		// parse child variables
		let cv: Variable[] = [];
		let parsed = false;
		for (let j = i + 1; parsed === false; j++) {
			const line = lines[j].trim();

			if (line === ')') {
				parsed = true;
			} else {
				// add new variables to list
				const tmp = line.split(' ');
				let newVar: Variable;
				switch (tmp[0].charAt(0)) {
					case '@':
						newVar = this.parseList(lines, j);
						break;
					case '%':
						newVar = this.parseHash(lines, j);
						break;
					default:
						newVar = new Variable(tmp[0], tmp[2]);
						break;
				}
				cv.push(newVar);
			}
		}

		this.varsMap.set(ref, cv);

		this.currentVarRef--;

		return v;
	}

	private parseHash(lines: string[], i: number): Variable {
		const name = lines[i].split(' = ')[0];
		const ref = this.currentVarRef;
		const v = new Variable(name, '', ref);

		// parse child variables
		let cv: Variable[] = [];
		let parsed = false;
		for (let j = i + 1; parsed === false; j++) {
			const line = lines[j].trim();

			if (line === ')') {
				parsed = true;
			}
			else if (line === 'empty hash') {
				parsed = true;
				v.value = 'empty hash';
			}
			else {
				// add new variables to list
				const tmp = line.split(' => ');
				let newVar: Variable;
				switch (tmp[0].charAt(0)) {
					case '@':
						newVar = this.parseList(lines, j);
						break;
					case '%':
						newVar = this.parseHash(lines, j);
						break;
					default:
						newVar = new Variable(tmp[0], tmp[1]);
						break;
				}
				cv.push(newVar);
			}
		}

		this.varsMap.set(ref, cv);

		this.currentVarRef--;

		return v;
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// TODO: Check variable and value type
		this._runtime.request(`${args.name} = ${args.value}`);
		response.body = { value: `${args.value}` };
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this._runtime.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this._runtime.step();
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): Promise<void> {
		await this._runtime.stepOut();
		this.sendResponse(response);
	}
}
