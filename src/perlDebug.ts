import {
	Breakpoint, Handles, Logger, logger,
	LoggingDebugSession, MemoryEvent, StoppedEvent, TerminatedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { IRuntimeVariableType, PerlRuntimeWrapper, RuntimeVariable } from './PerlRuntimeWrapper';


export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry?: boolean;
	cwd?: string;
	env?: object[];
}

export class PerlDebugSession extends LoggingDebugSession {
	private _runtime: PerlRuntimeWrapper;

	private _variableHandles = new Handles<'locals' | 'globals' | RuntimeVariable>();

	private _cancellationTokens = new Map<number, boolean>();

	private _valuesInHex = false;

	public constructor() {
		super("perl-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new PerlRuntimeWrapper();

		// setup event handlers
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step'));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint'));
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent(false));
		});
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;

		response.body.supportsEvaluateForHovers = true;

		response.body.supportsCancelRequest = true;

		response.body.supportsBreakpointLocationsRequest = true;

		response.body.supportsRestartRequest = true;

		response.body.supportsTerminateRequest = true;

		response.body.supportsSetVariable = true;

		this.sendResponse(response);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		logger.setup(Logger.LogLevel.Verbose, false);

		// start the program in the runtime
		await this._runtime.start(args.program, !!args.stopOnEntry, !args.noDebug);

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): Promise<void> {
		await this._runtime.terminate();
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = args.source.path as string;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = clientLines.map(async l => {
			const { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
			bp.id = id;
			return bp;
		});
		const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		const bps = this._runtime.breakPoints;
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		const stk = await this._runtime.stack();
		this.sendResponse(response);
	}

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

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		const container = this._variableHandles.get(args.variablesReference);
		const rv = container === 'locals'
			? await this._runtime.getLocalVariable(args.name)
			: container instanceof RuntimeVariable && container.value instanceof Array
				? container.value.find(v => v.name === args.name)
				: undefined;

		if (rv) {
			rv.value = this.convertToRuntime(args.value);
			response.body = this.convertFromRuntime(rv);

			if (rv.memory && rv.reference) {
				this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
			}
		}

		this.sendResponse(response);
	}

	//---- helpers
	private convertToRuntime(value: string): IRuntimeVariableType {

		value = value.trim();

		if (value === 'true') {
			return true;
		}
		if (value === 'false') {
			return false;
		}
		if (value[0] === '\'' || value[0] === '"') {
			return value.substring(1, value.length - 2);
		}
		const n = parseFloat(value);
		if (!isNaN(n)) {
			return n;
		}
		return value;
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

	private formatNumber(x: number) {
		return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
	}
}
