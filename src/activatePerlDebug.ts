'use strict';

import * as vscode from 'vscode';
import { DebugConfiguration, ProviderResult, WorkspaceFolder } from 'vscode';

const VARIABLE_REGEXP = /((\$|@|%)(?![0-9]+)(?![0-9]+[a-z]*$)[a-z0-9_]+)((\->)?(\{"[a-z0-9_\s]+"\}|\{'[a-z0-9_\s]+'\}|\[\d+\]|\{\$[a-z0-9_]+\}|::[a-z0-9_]+))*/gi;

export function activatePerlDebug(context: vscode.ExtensionContext, factory: vscode.DebugAdapterDescriptorFactory) {

	context.subscriptions.push(
		vscode.commands.registerCommand('extension.perl-debug.runEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				return vscode.debug.startDebugging(undefined, {
					type: 'perl',
					name: 'Run File',
					request: 'launch',
					program: targetResource.fsPath,
					debug: false
				},
					{ noDebug: true }
				);
			}
			return;
		}),
		vscode.commands.registerCommand('extension.perl-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				return vscode.debug.startDebugging(undefined, {
					type: 'perl',
					name: 'Run File',
					request: 'launch',
					program: targetResource.fsPath,
					stopOnEntry: true,
					debug: true
				});
			}
			return;
		})
	);

	const provider = new PerlConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('perl', provider));

	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('perl', {
		provideDebugConfigurations(): ProviderResult<DebugConfiguration[]> {
			return [
				{
					type: 'perl',
					name: 'Launch',
					request: 'launch',
					program: '${workspaceFolder}/${relativeFile}',
					stopOnEntry: true,
					debug: true
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('perl', factory));

	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('perl', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {

			const line = document.lineAt(position.line).text;

			let m: RegExpExecArray | null;
			while (m = VARIABLE_REGEXP.exec(line)) {
				const varRange = new vscode.Range(position.line, m.index, position.line, m.index + m[1].length);

				if (varRange.contains(position)) {
					return new vscode.EvaluatableExpression(varRange);
				}
			}
			return undefined;
		}
	}));

	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('perl', {

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext): vscode.ProviderResult<vscode.InlineValue[]> {

			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
				const line = document.lineAt(l);
				do {
					var m = VARIABLE_REGEXP.exec(line.text);
					if (m) {
						const varName = m[0];
						const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);

						// value determined via expression evaluation
						allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
					}
				} while (m);
			}
			return allValues;
		}
	}));
}

class PerlConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'perl') {
				config.type = 'perl';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${workspaceFolder}/${relativeFile}';
				config.stopOnEntry = true;
				config.debug = true;
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage('Cannot find a program to debug').then(_ => {
				// abort launch
				return undefined;
			});
		}

		return config;
	}
}
