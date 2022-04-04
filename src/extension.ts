'use strict';

import { logger } from '@vscode/debugadapter';
import * as Net from 'net';
import * as vscode from 'vscode';
import { activatePerlDebug } from './activatePerlDebug';
import { PerlDebugSession } from './perlDebug';

export function activate(context: vscode.ExtensionContext) {

	// run the debug adapter as a server inside the extension and communicate via a socket
	activatePerlDebug(context, new PerlDebugAdapterServerDescriptorFactory());

}

export function deactivate() {
	// nothing to do
}

class PerlDebugAdapterServerDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new PerlDebugSession();
				session.setRunAsServer(true);
				session.start(socket as NodeJS.ReadableStream, socket);
			}).listen(0);
		}

		logger.log('Connecting to Debug server');
		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((this.server.address() as Net.AddressInfo).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}
