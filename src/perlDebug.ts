import {
	Breakpoint,
	BreakpointEvent, Handles, InitializedEvent, logger, Logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { basename, dirname, join } from 'path';
import { ansiSeq, StreamCatcher } from './streamCatcher';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry: boolean;
	perlExecutable?: string;
	debug?: boolean;
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

export interface IRuntimeBreakpoint {
	line: number;
	verified: boolean;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;
	private currentVarRef = 999;
	private currentBreakpointID = 1;

	private _configurationDone = new Subject();

	private _variableHandles = new Handles<'my' | 'our' | 'special'>();
	private childVarsMap = new Map<number, Variable[]>();
	private parentVarsMap = new Map<number, Variable>();
	private bps: IBreakpointData[] = [];
	private funcBps: IFunctionBreakpointData[] = [];
	private cwd: string = "";

	// the perl cli session
	private _session!: ChildProcess;
	// helper to run commands and parse output
	private streamCatcher: StreamCatcher = new StreamCatcher;
	// max tries to set a breakpoint
	private maxBreakpointTries: number = 10;

	public constructor() {
		super("perl-debug.txt");

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * This function is used to send commands to the perl5db-process
	 * and receive the output of it.
	 */
	async request(command: string): Promise<string[]> {
		logger.log(`Command: ${command}`);
		return (await this.streamCatcher.request(command));
	}

	/**
	 * This function normalizes paths depending on the OS the debugger is running on.
	 */
	private normalizePathAndCasing(path: string) {
		if (process.platform === 'win32') {
			return path.replace(/\//g, '\\').toLowerCase();
		} else {
			return path.replace(/\\/g, '/');
		}
	}

	/**
	 * Checks if the perl5db-runtime is currently active.
	 */
	public isActive(): boolean {
		const type = typeof this.streamCatcher.input;
		if (type !== 'undefined' && this.streamCatcher.input) {
			return true;
		} else {
			return false;
		}
	}

	/**
	 * This function is called after every step to check if we reached the script end or an error.
	 */
	private async isEnd(lines: string[], event: string) {
		const text = lines.join();

		// did the script die?
		if (text.includes('Debugged program terminated.')) {
			// ensure that every script output is send to the debug console before closing the session
			await this.request('sleep(.5)');
			this.sendEvent(new TerminatedEvent());
		}

		this.sendEvent(new StoppedEvent(event, PerlDebugSession.threadId));;
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

		this.currentBreakpointID = 1;

		// set cwd
		this.cwd = args.cwd || dirname(args.program);

		// setup logger
		logger.setup(Logger.LogLevel.Warn, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		// Spawn perl process and handle errors
		args.cwd = this.normalizePathAndCasing(args.cwd || dirname(args.program));
		logger.log(`CWD: ${args.cwd}`);
		logger.log(`ENV: ${JSON.stringify(process.env)}`);
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: args.cwd,
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

		args.program = this.normalizePathAndCasing(args.program);
		logger.log(`Script: ${args.program}`);
		const commandArgs = [
			'-d',
			args.program,
			...args.args || []
		];

		args.perlExecutable = args.perlExecutable || 'perl';
		logger.log(`Perl executable: ${args.perlExecutable}`);
		this._session = spawn(
			args.perlExecutable,
			commandArgs,
			spawnOptions
		);

		this._session.on('error', err => {
			const text = `Couldn not spawn the child process! Command: ${args.perlExecutable}\nError: ${err.name} : ${err.message}`;
			logger.error(text);
			this.sendEvent(new OutputEvent(text, 'important'));
			this.sendEvent(new TerminatedEvent());
			return;
		});

		this._session.on('exit', code => {
			const text = `Could not start the debugging session! Script may contains errors. Code: ${code}`;
			logger.error(text);
			this.sendEvent(new OutputEvent(text, 'important'));
			this.sendEvent(new TerminatedEvent());
			return;
		});

		// send the script output to the debug console
		this._session.stdout!.on('data', (data) => {
			this.sendEvent(new OutputEvent(data.toString().replace(ansiSeq, ''), 'stdout'));
		});

		await this.streamCatcher.launch(
			this._session.stdin!,
			this._session.stderr!
		);

		// does the user want to debug the script or just run it?
		if (args.debug === true || args.debug === undefined) {
			logger.log('Starting Debug');
			// use PadWalker to access variables in scope and JSON the send data to perlDebug.ts
			let lines = await this.request('use PadWalker qw/peek_our peek_my/; use Data::Dumper;');
			if (lines.join().includes('Can\'t locate')) {
				this.sendEvent(new OutputEvent(`Could not load required modules:\n${lines.join('\n')}`, 'important'));
				this.sendEvent(new TerminatedEvent());
			}
			// set breakpoints
			for (let i = 0; i < this.bps.length; i++) {
				const id = this.bps[i].id;
				const file = this.normalizePathAndCasing(this.bps[i].file);
				const condition = this.bps[i].condition;
				let line = this.bps[i].line;
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
						this.sendEvent(new BreakpointEvent('changed', { verified: true, id: id, line: line } as DebugProtocol.Breakpoint));
						success = true;
					}
				}
			}
			// set function breakpoints
			for (let i = 0; i < this.funcBps.length; i++) {
				const bp = this.funcBps[i];
				const data = (await this.request(`b ${bp.name} ${bp.condition}`))[1];
				if (data.includes('not found')) {
					this.sendEvent(new OutputEvent(`Could not set function breakpoint:\n${data}`, 'important'));
				}
			}

			logger.log(`StopOnEntry: ${args.stopOnEntry}`);
			if (args.stopOnEntry) {
				this.sendEvent(new StoppedEvent('entry', PerlDebugSession.threadId));
			} else {
				await this.continue();
			}
		} else {
			// Just run
			logger.log('Running script');
			await this.continue();
		}

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
			if (this.isActive()) {
				// first we clear all existing breakpoints
				for (let i = 0; i < this.bps.length; i++) {
					const bp = this.bps[i];
					await this.request(`B ${bp.line}`);
				}
				// now we try to set every breakpoint requested
				for (let tries = 0; success === false && tries < 15; tries++) {
					const data = (await this.request(`b ${args.source.path}:${line} ${argBps[i].condition}`)).join();
					if (data.includes('not breakable')) {
						// try again at the next line
						line++;
					} else {
						// a breakable line was found and the breakpoint set
						success = true;
					}
				}
			} else {
				logger.log('Can not set breakpoint. Runtime is not active yet');
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
			if (this.isActive()) {
				await this.request(`b ${bp.name} ${bp.condition}`);
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
		const stackTrace = /^[@|.]\s=\s(.*)\scalled\sfrom\sfile\s'(.*)'\sline\s(\d+)/;

		const lines = (await this.request('T')).slice(1, -1);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const matched = line.match(stackTrace);
			if (matched) {
				let file = line.split("called from file")[1];
				if (file.includes('./')) {
					file = join(this.cwd, file);
				}
				file = this.normalizePathAndCasing(matched[2]);
				const fn = new Source(basename(file), file);
				stackFrames.push(new StackFrame(i, matched[1], fn, +matched[3]));
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
				new Scope("My", this._variableHandles.create('my'), false),
				new Scope("Our", this._variableHandles.create('our'), false),
				new Scope("Specials", this._variableHandles.create('special'), true)
			]
		};
		// clear parsed variables and reset counter
		this.parentVarsMap.clear();
		this.childVarsMap.clear();
		this.currentVarRef = 999;
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		let vars: string[] = [];
		let vs: Variable[] = [];
		const handle = this._variableHandles.get(args.variablesReference);
		// < 1000 => nested vars
		if (args.variablesReference >= 1000) {
			if (handle === 'my') {
				vars = (await this.request(`print STDERR join ('|', sort(keys( % { PadWalker::peek_my(2); })))`))[1].split('|');
				logger.log(`Varnames: ${vars.join(', ')}`);
			}
			if (handle === 'our') {
				vars = (await this.request(`print STDERR join ('|', sort(keys( % { PadWalker::peek_our(2); })))`))[1].split('|');
				logger.log(`Varnames: ${vars.join(', ')}`);
			}
			else if (handle === 'special') {
				vars = [
					"%ENV",
					"@ARGV",
					"@INC",
					"@F",
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
			const newVars = this.childVarsMap.get(args.variablesReference);
			if (newVars) {
				vs = vs.concat(newVars);
			}
		}

		response.body = {
			variables: vs
		};

		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
		let varName = args.expression;

		// ensure that a variable is being evaluated
		if (['$', '%', '@'].includes(varName.charAt(0)) === false) {
			response.success = false;
			this.sendResponse(response);
			return;
		}

		if (varName.startsWith('@')) {
			varName = `[${varName}]`;
		} else if (varName.startsWith('%')) {
			varName = `{${varName}}`;
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
			if (varName.startsWith('@')) {
				varName = `[${varName}]`;
			} else if (varName.startsWith('%')) {
				varName = `{${varName}}`;
			}

			let varDump = (await this.request(`print STDERR Data::Dumper->new([${varName}], [])->Deepcopy(1)->Sortkeys(1)->Indent(1)->Terse(0)->Trailingcomma(1)->Useqq(1)->Dump()`)).filter(e => { return e !== ''; }).slice(1, -1);
			try {
				if (varDump[0]) {
					varDump[0] = varDump[0].replace(/=/, '=>');
					const matched = varDump[0].match(this.isScalar);
					if (matched && varDump.length === 1) {
						vs.push({
							name: varNames[i],
							value: `${matched[2]}`,
							variablesReference: 0
						});
					} else {
						this.currentVarRef--;
						const matched = varDump[varDump.length - 1].trim().match(this.isVarEnd);
						const value = `${(matched![1] === '}' ? 'HASH' : 'ARRAY')}${(matched![3] ? ` ${matched![3]}` : '')}`;
						const newVar: Variable = {
							name: varNames[i],
							value: value,
							variablesReference: this.currentVarRef
						};
						vs.push(newVar);
						this.parentVarsMap.set(this.currentVarRef, newVar);
						await this.parseDumper(varDump.slice(1, -1));
					}
				} else {
					vs.push({
						name: varNames[i],
						value: 'undef',
						variablesReference: 0
					});
				}
			} catch (error: any) {
				logger.error(`Error parsing variable ${varNames[i]}: ${error}`);
				vs.push({
					name: varNames[i],
					value: 'undef',
					variablesReference: 0
				});
			}
		}

		// return all vars
		return vs;
	}

	// Regexp for parsing the output of Data::Dumper
	private isScalar = /"?(.*)"?\s=>?\s(undef|".*"|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\}|\\\*\{".*\"})[,|;]/;
	private isNewNested = /"(.*)"\s=>?\s(bless\(\s)?(\[|\{)/;
	private isNestedArrayPosition = /^(\{|\[)$/;
	private isArrayPosition = /^(undef|".*"|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\})[,|;]/;
	private isVarEnd = /^(\}|\]),?(\s?'(.*)'\s\))?[,|;]/;
	// Parse output of Data::Dumper
	private async parseDumper(lines: string[]): Promise<[number, string]> {
		let cv: Variable[] = [];
		let varType = "";
		let arrayIndex = 0;
		const ref = this.currentVarRef;
		this.currentVarRef--;

		let i: number;
		for (i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			let matched = line.match(this.isVarEnd);
			if (matched) {
				varType = `${(matched[1] === '}' ? 'HASH' : 'ARRAY')}${(matched[3] ? ` ${matched[3]}` : '')}`;
				break;
			} else {
				matched = line.match(this.isScalar);
				if (matched) {
					cv.push({
						name: matched[1].replace(/"/, ''),
						value: matched[2],
						variablesReference: 0
					});
					continue;
				}
				matched = line.match(this.isArrayPosition);
				if (matched) {
					cv.push({
						name: `${arrayIndex}`,
						value: matched[1],
						variablesReference: 0
					});
					arrayIndex++;
					continue;
				}
				matched = line.match(this.isNestedArrayPosition);
				if (matched) {
					const newVar: Variable = {
						name: `${arrayIndex}`,
						value: '',
						variablesReference: this.currentVarRef
					};
					this.parentVarsMap.set(this.currentVarRef, newVar);
					const parsed = await this.parseDumper(lines.slice(i + 1));
					i += parsed[0];
					newVar.value = parsed[1];
					cv.push(newVar);
					arrayIndex++;
					continue;
				}
				matched = line.match(this.isNewNested);
				if (matched) {
					const newVar: Variable = {
						name: matched[1],
						value: '',
						variablesReference: this.currentVarRef
					};
					this.parentVarsMap.set(this.currentVarRef, newVar);
					const parsed = await this.parseDumper(lines.slice(i + 1));
					i += parsed[0];
					newVar.value = parsed[1];
					cv.push(newVar);
					continue;
				}
				logger.error(`Error: ${line}`);
			}
		}
		this.childVarsMap.set(ref, cv);
		return [i + 1, varType];
	}

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		let currentVarRef = args.variablesReference;
		let expressionToChange: string = args.name;

		if (this.parentVarsMap.has(currentVarRef)) {
			let lastParent: Variable | undefined = this.childVarsMap.get(currentVarRef)!.find(e => { return e.name === args.name; });
			let parentVars: Variable[] = [lastParent!];
			let parent: Variable | undefined;
			while ((parent = this.parentVarsMap.get(currentVarRef)) && lastParent) {
				const childsOfParent = this.childVarsMap.get(currentVarRef);
				if (parent && childsOfParent!.includes(lastParent)) {
					parentVars.push(parent);
					// we need to store the last parent variable to find the parent of the lastParent
					lastParent = parent;
				}
				currentVarRef++;
			}
			// Now we can build the expression
			parentVars = parentVars.reverse();
			let currentType = parentVars[0].value.match(/(^ARRAY|^HASH)/)![1];
			for (let i = 0; i < parentVars.length; i++) {
				const parentVar = parentVars[i];
				if (i === 0) {
					expressionToChange = `${parentVar.name.replace(/^%/, '$')}`;
				} else {
					switch (currentType) {
						case 'ARRAY':
							expressionToChange = `${expressionToChange}[${parentVar.name}]`;
							break;
						case 'HASH':
							expressionToChange = `${(expressionToChange.endsWith(']') ? `${expressionToChange}->` : expressionToChange)}{'${parentVar.name}'}`;
							break;
						default:
							logger.error(`error: ${currentType}`);
							break;
					}
					currentType = parentVar.value.match(/(^ARRAY|^HASH|.*)/)![1];
				}
			}
		}
		const lines = (await this.request(`${expressionToChange} = ${args.value}`)).filter(e => { return e !== ''; });
		if (lines.slice(1, -1).length > 0) {
			this.sendEvent(new OutputEvent(`Error setting value: ${lines.join(' ')}`, 'important'));
			response.success = false;
		} else {
			const value = (await this.request(`print STDERR Data::Dumper->new([${(expressionToChange.startsWith('@') ? `[${expressionToChange}]` : (expressionToChange.startsWith('%') ? `{${expressionToChange}}` : expressionToChange))}], [])->Useqq(1)->Terse(1)->Dump()`)).slice(1, -1).join(' ');
			response.body = { value: `${value}` };
		}
		this.sendResponse(response);
	}

	protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): Promise<void> {
		let sources: Source[] = [];

		const lines = await this.request('foreach my $INCKEY (keys %INC) { print STDERR $INCKEY . "||" . %INC{$INCKEY} . "\\n" }');
		// remove first and last line
		lines.filter(e => { return e !== ''; }).slice(1, -1).forEach(line => {
			const tmp = line.split('||');
			if (tmp.length === 2) {
				sources.push(new Source(tmp[0], tmp[1].replace(/^\.\//, `${this.cwd}/`)));
			}
		});

		response.body = {
			sources: sources
		};

		this.sendResponse(response);
	}

	public async continue() {
		const lines = await this.request('c');
		const scriptOutput = lines.slice(1, lines.findIndex(e => { return e.match(/main::.*|Debugged program terminated/); }));
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.sendEvent(new OutputEvent(scriptOutput.join('\n'), 'stderr'));
		}
		await this.isEnd(lines, 'breakpoint');
	}

	public async step(signal: string = 'step') {
		const lines = await this.request('n');
		const scriptOutput = lines.slice(1, lines.findIndex(e => { return e.match(/main::.*|Debugged program terminated/); }));
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.sendEvent(new OutputEvent(scriptOutput.join('\n'), 'stderr'));
		}
		await this.isEnd(lines, signal);
	}

	public async stepIn() {
		const lines = await this.request('s');
		const scriptOutput = lines.slice(1, lines.findIndex(e => { return e.match(/main::.*|Debugged program terminated/); }));
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.sendEvent(new OutputEvent(scriptOutput.join('\n'), 'stderr'));
		}
		await this.isEnd(lines, 'step');
	}

	public async stepOut() {
		const lines = await this.request('r');
		const scriptOutput = lines.slice(1, lines.findIndex(e => { return e.match(/main::.*|Debugged program terminated/); }));
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.sendEvent(new OutputEvent(scriptOutput.join('\n'), 'stderr'));
		}
		await this.isEnd(lines, 'step');
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.step();
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this.stepIn();
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): Promise<void> {
		await this.stepOut();
		this.sendResponse(response);
	}

	protected async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): Promise<void> {
		await this.streamCatcher.destroy();
		this.sendResponse(response);
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): Promise<void> {
		await this.request('q');
		await this.streamCatcher.destroy();
		this.sendResponse(response);
	}
}
