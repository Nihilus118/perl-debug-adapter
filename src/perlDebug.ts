import {
	Breakpoint,
	BreakpointEvent, Handles, InitializedEvent, logger, Logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { dirname, join, basename } from 'path';
import { PerlRuntimeWrapper } from './perlRuntimeWrapper';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	debug: boolean;
	stopOnEntry: boolean;
	perlExecutable?: string;
	cwd?: string;
	args?: string[];
	env?: object[];
}

export interface IFunctionBreakpointData {
	name: string,
	condition: string;
}

export interface IBreakpointData {
	file: string,
	line: number,
	id: number,
	condition: string;
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
	private funcBps: IFunctionBreakpointData[] = [];
	private cwd: string = "";

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
		this._runtime.on('breakpointValidated', (bp: [number, number]) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: true, id: bp[0], line: bp[1] } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('breakpointDeleted', (bpId: number) => {
			this.sendEvent(new BreakpointEvent('removed', { id: bpId } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (text: string, category: 'console' | 'important' | 'stdout' | 'stderr' | 'telemetry' = 'console') => {
			this.sendEvent(new OutputEvent(`${text}`, category));
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

		// make VS Code send loadedSourcesRequest request
		response.body.supportsLoadedSourcesRequest = true;

		// make VS Code send SetFunctionBreakpointsRequest request
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsConditionalBreakpoints = true;

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

		// clear parsed variables and reset counters
		this.varsMap.clear();
		this.currentVarRef = 999;
		this.currentBreakpointID = 1;

		// set cwd
		this.cwd = args.cwd || dirname(args.program);

		// setup logger
		logger.setup(Logger.LogLevel.Log, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		await this._runtime.start(
			args.perlExecutable || 'perl',
			args.program,
			!!args.stopOnEntry,
			args.debug || true,
			args.args || [],
			this.bps,
			this.funcBps,
			this.cwd
		);
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// save breakpoints in memory and hand them over in the launch request later
		const argBps = args.breakpoints!;
		this.currentBreakpointID = 1;

		let bps: Breakpoint[] = [];

		for (let i = 0; i < argBps.length; i++) {
			let line = argBps[i].line;
			let success = false;

			// this is only possible if the runtime is currently active
			if (this._runtime.isActive()) {
				// first we clear all existing breakpoints
				for (let i = 0; i < this.bps.length; i++) {
					const bp = this.bps[i];
					const data = await this._runtime.request(`B ${bp.line}`);
					// TODO: Remove after testing
					logger.log(data.join());
				}
				// now we try to set every breakpoint requested
				for (let tries = 0; success === false && tries < 15; tries++) {
					const data = (await this._runtime.request(`b ${args.source.path}:${line} ${argBps[i].condition}`)).join();
					if (data.includes('not breakable')) {
						// try again at the next line
						line++;
					} else {
						// a breakable line was found and the breakpoint set
						success = true;
					}
				}
			} else {
				logger.warn('Can not set breakpoint. Runtime is not active yet');
			}

			const bp = new Breakpoint(success, line, undefined, args.source as Source);
			bp.setId(this.currentBreakpointID);
			this.bps.push({
				id: this.currentBreakpointID,
				line: line,
				file: args.source.path as String,
				condition: argBps[i].condition
			} as IBreakpointData);
			bps.push(bp);

			this.currentBreakpointID++;
		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: bps
		};
		this.sendResponse(response);
	}

	protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
		for (let i = 0; i < args.breakpoints.length; i++) {
			const bp = args.breakpoints[i];
			this.funcBps.push({
				name: bp.name,
				condition: bp.condition || ''
			});

			// this is only possible if the runtime is currently active
			if (this._runtime.isActive()) {
				await this._runtime.request(`b ${bp.name} ${bp.condition}`);

			} else {
				logger.warn('Can not set function breakpoint. Runtime is not active yet');
			}
		}

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
				let nm = line.split(' = ')[1];
				nm = nm.split("'")[0];
				let file = line.split("'")[1];
				if (file.includes('./')) {
					file = join(this.cwd, file);
				}
				file = this._runtime.normalizePathAndCasing(file);
				const fn = new Source(basename(file), file);
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
				new Scope("Globals", this._variableHandles.create('globals'), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		// 1000 => my
		// 1001 => our
		// 1002 => global
		// < 1000 => nested vars
		let vars: string[] = [];
		let vs: Variable[] = [];
		if (args.variablesReference >= 1000) {
			if (args.variablesReference % 2 === 0) {
				vars = (await this._runtime.request(`print STDERR join ('|', sort(keys( % { peek_our(2); }), keys( % { peek_my(2); })))`))[1].split('|');
				logger.log(`Varnames: ${vars.join(', ')}`);
			}
			else if (args.variablesReference % 2 === 1) {
				vars = [
					"@ARGV",
					"@INC",
					"@F",
					"%INC",
					"%ENV",
					"$SIG",
					"$ARG",
					"$NR",
					"$RS",
					"$OFS",
					"$ORS",
					"$LIST_SEPARATOR",
					"$SUBSCRIPT_SEPARATOR",
					"$FORMAT_FORMFEED",
					"$FORMAT_LINE_BREAK_CHARACTERS",
					"$ACCUMULATOR",
					"$CHILD_ERROR",
					"$ERRNO",
					"$EVAL_ERROR",
					"$PID",
					"$UID",
					"$EUID",
					"$GID",
					"$EGID",
					"$PROGRAM_NAME",
					"$PERL_VERSION",
					"$DEBUGGING",
					"$INPLACE_EDIT",
					"$OSNAME",
					"$PERLDB",
					"$BASETIME",
					"$WARNING",
					"$EXECUTABLE_NAME",
					"$ARGV"
				];
			}
			vs = await this.parseVars(vars);
		} else {
			// Get already parsed vars from map
			const newVars = this.varsMap.get(args.variablesReference);
			if (newVars) {
				vs = vs.concat(newVars);
			}
		}

		response.body = {
			variables: vs
		};

		logger.log(`Variables: ${JSON.stringify(vs)}`);

		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
		const varName = args.expression;

		// ensure that a variable is being evaluated
		if (['$', '%', '@'].includes(varName.charAt(0)) === false) {
			response.success = false;
			this.sendResponse(response);
			return;
		}

		// get variable value
		const evaledVar = (await this.parseVars([varName]))[0];

		response.body = {
			result: evaledVar.value,
			variablesReference: evaledVar.variablesReference,
		};

		this.sendResponse(response);
	}

	private async parseVars(varNames: string[]): Promise<Variable[]> {
		let vs: Variable[] = [];
		for (let i = 0; i < varNames.length; i++) {
			let varName = varNames[i];
			let command = `print STDERR (split (/\\(/, \\${varName}))[0]`;
			const perlType = (await this._runtime.request(command))[1];
			logger.log(`Perltype: ${perlType}`);
			if (perlType === 'REF') {
				// add % sign
				varName = `{%${varName}}`;
			}
			if (perlType === 'ARRAY' || perlType === 'HASH') {
				// add % sign
				varName = `\\${varName}`;
			}

			// get variable values as json string
			command = `print STDERR JSON->new->utf8->allow_nonref(1)->allow_blessed(1)->convert_blessed(1)->encode(${varName})`;
			const json = (await this._runtime.request(command))[1];
			logger.log(`${varName} value: ${json}`);

			try {
				const parsed = JSON.parse(json);
				switch (perlType) {
					case 'REF':
						// parent variable
						vs.push(new Variable(varNames[i], json, this.currentVarRef));
						// child variables
						this.parseVariableChilds(parsed);
						break;
					case 'HASH':
						// parent variable
						vs.push(new Variable(varNames[i], json, this.currentVarRef));
						// child variables
						this.parseVariableChilds(parsed);
						break;
					case 'ARRAY':
						// parent variable
						const childVars: Array<any> = parsed;
						vs.push(new Variable(varNames[i], `(${childVars.join(', ')})`, this.currentVarRef));
						// child variables
						let cv: Variable[] = [];
						for (let child in childVars) {
							let value: string;
							// add quotes to strings
							if (isNaN(childVars[child])) {
								value = `"${childVars[child]}"`;
							} else {
								value = `${childVars[child]}`;
							}
							cv.push(new Variable(child, value));
						}
						this.varsMap.set(this.currentVarRef, cv);
						this.currentVarRef--;
						break;
					default:
						// SCALAR
						vs.push(new Variable(varNames[i], `${json}`));
						break;
				}
			}
			catch {
				const output = (await this._runtime.request(`print STDERR Dumper(${varNames[i]})`));
				vs.push(new Variable(varNames[i], output[1].split('$VAR1 = ')[1]));
			}
		}

		// return all vars
		return vs;
	}

	private parseVariableChilds(childs: object) {
		let cv: Variable[] = [];
		const ref = this.currentVarRef;
		this.currentVarRef--;
		for (let child in childs) {
			if (this.isObject(childs[child])) {
				// we have found a new parent
				cv.push(new Variable(`${child}`, `${JSON.stringify(childs[child])}`, this.currentVarRef));
				// call this function recursivly to also parse the childs of a child
				this.parseVariableChilds(childs[child]);
			} else {
				// add child to the list of new childs
				let value: string;
				// add quotes to strings
				if (isNaN(childs[child])) {
					value = `"${childs[child]}"`;
				} else {
					value = `${childs[child]}`;
				}
				cv.push(new Variable(`${child}`, `${value}`));
			}
		}
		this.varsMap.set(ref, cv);
	}

	private isObject(a: any) {
		return (!!a) && (a.constructor === Object);
	};

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// TODO: Check variable and value type
		this._runtime.request(`${args.name} = ${args.value}`);
		response.body = { value: `${args.value}` };
		this.sendResponse(response);
	}

	protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): Promise<void> {
		let sources: Source[] = [];

		const lines = await this._runtime.request('foreach my $INCKEY (keys %INC) { print STDERR $INCKEY . "||" . %INC{$INCKEY} . "\\n" }');
		// remove first and last line
		lines.slice(1, -1).forEach(line => {
			const tmp = line.split('||');
			if (tmp.length === 2) {
				sources.push(new Source(tmp[0], tmp[1]));
			}
		});

		response.body = {
			sources: sources
		};

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
