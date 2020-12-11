import { Uri } from 'coc.nvim';
import { CancellationToken, FormattingOptions, TextEdit } from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { BaseFormatter } from './baseFormatter';

export class DarkerFormatter extends BaseFormatter {
  constructor() {
    super('darker');
  }

  createTempFile(document: TextDocument): Promise<string> {
    return new Promise<string>((resolve) => {
      resolve(Uri.parse(document.uri).fsPath);
    });
  }

  public formatDocument(document: TextDocument, options: FormattingOptions, token: CancellationToken): Thenable<TextEdit[]> {
    const darkerArgs = ['--diff'];
    if (this.pythonSettings.formatting.darkerArgs.length > 0) {
      darkerArgs.push(...this.pythonSettings.formatting.darkerArgs);
    }
    return super.provideDocumentFormattingEdits(document, options, token, darkerArgs);
  }
}