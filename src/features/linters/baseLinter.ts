// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { CancellationToken, OutputChannel, TextDocument, Uri, workspace } from 'coc.nvim';
import namedRegexp from 'named-js-regexp';
import { firstValueFrom } from 'rxjs';
import { PythonSettings } from '../../configSettings';
import { PythonExecutionService } from '../../processService';
import { ExecutionInfo, ILinter, ILinterInfo, ILintMessage, IPythonSettings, LinterId, LintMessageSeverity, Output } from '../../types';
import { splitLines } from '../../utils';

// Allow negative column numbers (https://github.com/PyCQA/pylint/issues/1822)
const REGEX = '(?<line>\\d+),(?<column>-?\\d+),(?<type>\\w+),(?<code>\\w+\\d+):(?<message>.*)\\r?(\\n|$)';

export interface IRegexGroup {
  line: number;
  column: number;
  code: string;
  message: string;
  type: string;
  file?: string;
}

export function matchNamedRegEx(data: string, regex: string): IRegexGroup | undefined {
  const compiledRegexp = namedRegexp(regex, 'g');
  const rawMatch = compiledRegexp.exec(data);
  if (rawMatch) {
    // @ts-ignore
    return rawMatch.groups() as IRegexGroup;
  }

  return undefined;
}

export function parseLine(line: string, regex: string, linterID: LinterId, colOffset = 0): ILintMessage | undefined {
  const match = matchNamedRegEx(line, regex)!;
  if (!match) {
    return;
  }

  match.line = Number(match.line as any);
  match.column = Number(match.column as any);

  return {
    code: match.code,
    message: match.message,
    column: isNaN(match.column) || match.column <= 0 ? 0 : match.column - colOffset,
    line: match.line,
    type: match.type,
    provider: linterID,
    file: match.file,
  };
}

export abstract class BaseLinter implements ILinter {
  protected readonly isWindows = process.platform === 'win32';

  private _pythonSettings: IPythonSettings;
  private _info: ILinterInfo;

  protected get pythonSettings(): IPythonSettings {
    return this._pythonSettings;
  }

  constructor(info: ILinterInfo, protected readonly outputChannel: OutputChannel, protected readonly columnOffset = 0) {
    this._info = info;
    this._pythonSettings = PythonSettings.getInstance();
  }

  public get info(): ILinterInfo {
    return this._info;
  }

  public async lint(document: TextDocument, cancellation: CancellationToken): Promise<ILintMessage[]> {
    return this.runLinter(document, cancellation);
  }

  protected abstract runLinter(document: TextDocument, cancellation: CancellationToken): Promise<ILintMessage[]>;

  protected parseMessagesSeverity(error: string, categorySeverity: any): LintMessageSeverity {
    if (categorySeverity[error]) {
      const severityName = categorySeverity[error];
      switch (severityName) {
        case 'Error':
          return LintMessageSeverity.Error;
        case 'Hint':
          return LintMessageSeverity.Hint;
        case 'Information':
          return LintMessageSeverity.Information;
        case 'Warning':
          return LintMessageSeverity.Warning;
        default: {
          if (LintMessageSeverity[severityName]) {
            return LintMessageSeverity[severityName] as any as LintMessageSeverity;
          }
        }
      }
    }
    return LintMessageSeverity.Information;
  }

  private async stdinRun(service: PythonExecutionService, executionInfo: ExecutionInfo, document: TextDocument): Promise<Output<string>> {
    let command = executionInfo.execPath;
    let args = executionInfo.args;
    if (executionInfo.moduleName) {
      command = this.pythonSettings.pythonPath;
      args = ['-m', executionInfo.moduleName, ...args];
    }

    const result = service.execObservable(command, args, { cwd: workspace.root });
    result.proc?.stdin?.setDefaultEncoding('utf8');
    result.proc?.stdin?.write(document.getText());
    result.proc?.stdin?.end();

    return firstValueFrom(result.out);
  }

  protected async run(args: string[], document: TextDocument, token: CancellationToken, regEx = REGEX): Promise<ILintMessage[]> {
    if (!this.info.isEnabled(Uri.parse(document.uri))) {
      return [];
    }

    try {
      const pythonToolsExecutionService = new PythonExecutionService();
      const executionInfo = this.info.getExecutionInfo(args, Uri.parse(document.uri));
      this.outputChannel.appendLine(`${'#'.repeat(10)} Run linter ${this.info.id}:`);
      this.outputChannel.appendLine(JSON.stringify(executionInfo));
      this.outputChannel.appendLine('');

      let output = '';
      if (this.info.stdinSupport) {
        const result = await this.stdinRun(pythonToolsExecutionService, executionInfo, document);
        if (result.source === 'stderr') {
          throw new Error(result.out);
        }
        output = result.out;
      } else {
        const result = await pythonToolsExecutionService.exec(executionInfo, { cwd: workspace.root, token });
        output = result.stdout;
      }

      this.outputChannel.append(`${'#'.repeat(10)} Linting Output - ${this.info.id} ${'#'.repeat(10)}\n`);
      this.outputChannel.append(output);
      this.outputChannel.appendLine('');

      return await this.parseMessages(output, document, regEx);
    } catch (error) {
      this.outputChannel.appendLine(`Linting with ${this.info.id} failed:`);
      if (error instanceof Error) {
        this.outputChannel.appendLine(error.message.toString());
      }
      return [];
    }
  }

  protected async parseMessages(output: string, _document: TextDocument, regEx: string) {
    const messages: ILintMessage[] = [];
    const outputLines = splitLines(output, { removeEmptyEntries: false, trim: false });
    for (const line of outputLines) {
      try {
        const msg = parseLine(line, regEx, this.info.id, this.columnOffset);
        if (msg) {
          messages.push(msg);
          if (messages.length >= this.pythonSettings.linting.maxNumberOfProblems) {
            break;
          }
        }
      } catch (err) {
        this.outputChannel.appendLine(`${'#'.repeat(10)} Linter ${this.info.id} failed to parse the line:`);
        this.outputChannel.appendLine(line);
        if (typeof err === 'string') {
          this.outputChannel.appendLine(err);
        } else if (err instanceof Error) {
          this.outputChannel.appendLine(err.message);
        }
      }
    }
    return messages;
  }
}
