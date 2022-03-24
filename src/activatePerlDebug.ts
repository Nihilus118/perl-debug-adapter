'use strict';

import * as vscode from 'vscode';
import { CancellationToken, DebugConfiguration, ProviderResult, WorkspaceFolder } from 'vscode';
import { PerlDebugSession } from './perlDebug';

export function activatePerlDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	// TODO: Commands anpassen
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.mock-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'perl',
					name: 'Debug File',
					request: 'launch',
					program: targetResource.fsPath,
					stopOnEntry: true
				});
			}
		})
	);

	context.subscriptions.push(vscode.commands.registerCommand('extension.perl-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a perl file in the workspace folder"
		});
	}));

	// register a configuration provider for perl debug type
	const provider = new PerlConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('perl', provider));

	// register a dynamic configuration provider for 'perl' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('perl', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			return [
				{
					name: "Perl Launch",
					request: "launch",
					type: "perl",
					program: "${WorkspaceFolder}/${relativeFile}",
					stopOnEntry: true
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	if (!factory) {
		factory = new InlineDebugAdapterFactory();
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('perl', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
}

class PerlConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'perl') {
				config.type = 'perl';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new PerlDebugSession());
	}
}
