import {
	BreakpointEvent, Handles, InitializedEvent, Logger, logger,
	LoggingDebugSession, MemoryEvent, OutputEvent, Scope, Source, StoppedEvent, TerminatedEvent, Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { basename } from 'path';
import { IRuntimeBreakpoint, PerlRuntimeWrapper, RuntimeVariable } from './perlRuntimeWrapper';


export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry?: boolean;
	debug?: boolean;
	cwd?: string;
	env?: object[];
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;

	// private _breakpointId = 1000;

	// private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

	private _configurationDone = new Subject();

	private _runtime: PerlRuntimeWrapper;

	private _variableHandles = new Handles<'locals' | 'globals' | RuntimeVariable>();

	private _cancellationTokens = new Map<number, boolean>();
	private _reportProgress: boolean | undefined;
	private _useInvalidatedEvent: boolean | undefined;

	public constructor() {
		super("perl-debug.txt");

		this._runtime = new PerlRuntimeWrapper();

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		// setup event handlers
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnInstructionBreakpoint', () => {
			this.sendEvent(new StoppedEvent('instruction breakpoint', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, PerlDebugSession.threadId));
			} else {
				this.sendEvent(new StoppedEvent('exception', PerlDebugSession.threadId));
			}
		});
		this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
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

		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code support data breakpoints
		// response.body.supportsDataBreakpoints = true;

		// make VS Code send cancel request
		// response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		// response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code send exceptionInfo request
		// response.body.supportsExceptionInfoRequest = true;

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

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		await this._runtime.start(args.program, !!args.stopOnEntry, !args.noDebug);
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: []
		};
		this.sendResponse(response);
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): Promise<void> {

		response.body = {
			breakpoints: []
		};

		this.sendResponse(response);
	}

	protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {

		let namedException: string | undefined = undefined;
		let otherExceptions = false;

		if (args.filterOptions) {
			for (const filterOption of args.filterOptions) {
				switch (filterOption.filterId) {
					case 'namedException':
						namedException = args.filterOptions[0].condition;
						break;
					case 'otherExceptions':
						otherExceptions = true;
						break;
				}
			}
		}

		if (args.filters) {
			if (args.filters.indexOf('otherExceptions') >= 0) {
				otherExceptions = true;
			}
		}

		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		response.body = {
			exceptionId: 'Exception ID',
			description: 'This is a descriptive description of the exception.',
			breakMode: 'always',
			details: {
				message: 'Message contained in the exception.',
				typeName: 'Short type name of the exception object',
				stackTrace: 'stack frame 1\nstack frame 2',
			}
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

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		response.body = {
			stackFrames: [],
			// 4 options for 'totalFrames':
			//omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
			totalFrames: 0			// stk.count is the correct size, should result in a max. of two requests
			//totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
			//totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
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

	// protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
	// 	const variable = this._variableHandles.get(Number(memoryReference));
	// 	if (typeof variable === 'object') {
	// 		const decoded = base64.toByteArray(data);
	// 		variable.setMemory(decoded, offset);
	// 		response.body = { bytesWritten: decoded.length };
	// 	} else {
	// 		response.body = { bytesWritten: 0 };
	// 	}

	// 	this.sendResponse(response);
	// 	this.sendEvent(new InvalidatedEvent(['variables']));
	// }

	// protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
	// 	const variable = this._variableHandles.get(Number(memoryReference));
	// 	if (typeof variable === 'object' && variable.memory) {
	// 		const memory = variable.memory.subarray(
	// 			Math.min(offset, variable.memory.length),
	// 			Math.min(offset + count, variable.memory.length),
	// 		);

	// 		response.body = {
	// 			address: offset.toString(),
	// 			data: base64.fromByteArray(memory),
	// 			unreadableBytes: count - memory.length
	// 		};
	// 	} else {
	// 		response.body = {
	// 			address: offset.toString(),
	// 			data: '',
	// 			unreadableBytes: count
	// 		};
	// 	}

	// 	this.sendResponse(response);
	// }

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		let vs: RuntimeVariable[] = [];

		const v = this._variableHandles.get(args.variablesReference);
		if (v === 'locals') {
			vs = await this._runtime.getLocalVariables();
		} else if (v === 'globals') {
			if (request) {
				this._cancellationTokens.set(request.seq, false);
				vs = await this._runtime.getGlobalVariables(() => !!this._cancellationTokens.get(request.seq));
				this._cancellationTokens.delete(request.seq);
			} else {
				vs = await this._runtime.getGlobalVariables();
			}
		} else if (v && Array.isArray(v.value)) {
			vs = v.value;
		}

		response.body = {
			variables: vs.map(v => this.convertFromRuntime(v))
		};
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {

		this.sendEvent(new MemoryEvent("test", 0, 1));

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._runtime.stepIn();
		this.sendResponse(response);
	}

	private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {

		let dapVariable: DebugProtocol.Variable = {
			name: v.name,
			value: '???',
			type: typeof v.value,
			variablesReference: 0,
			evaluateName: '$' + v.name
		};

		if (v.name.indexOf('lazy') >= 0) {
			// a "lazy" variable needs an additional click to retrieve its value

			dapVariable.value = 'lazy var';		// placeholder value
			v.reference ??= this._variableHandles.create(new RuntimeVariable('', [new RuntimeVariable('', v.value)]));
			dapVariable.variablesReference = v.reference;
			dapVariable.presentationHint = { lazy: true };
		} else {

			if (Array.isArray(v.value)) {
				dapVariable.value = 'Object';
				v.reference ??= this._variableHandles.create(v);
				dapVariable.variablesReference = v.reference;
			} else {

				switch (typeof v.value) {
					case 'number':
						if (Math.round(v.value) === v.value) {
							dapVariable.value = this.formatNumber(v.value);
							(<any>dapVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution
							dapVariable.type = 'integer';
						} else {
							dapVariable.value = v.value.toString();
							dapVariable.type = 'float';
						}
						break;
					case 'string':
						dapVariable.value = `"${v.value}"`;
						break;
					case 'boolean':
						dapVariable.value = v.value ? 'true' : 'false';
						break;
					default:
						dapVariable.value = typeof v.value;
						break;
				}
			}
		}

		if (v.memory) {
			v.reference ??= this._variableHandles.create(v);
			dapVariable.memoryReference = String(v.reference);
		}

		return dapVariable;
	}

	private formatAddress(x: number, pad = 8) {
		return true ? '0x' + x.toString(16).padStart(8, '0') : x.toString(10);
	}

	private formatNumber(x: number) {
		return true ? '0x' + x.toString(16) : x.toString(10);
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}
