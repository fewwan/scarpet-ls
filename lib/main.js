import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {
    ProposedFeatures,
    ResponseError,
    TextDocumentSyncKind,
    TextDocuments,
    TextEdit,
    createConnection,
} from 'vscode-languageserver/node.js';
import {TextDocument} from 'vscode-languageserver-textdocument';

import {createLibraryResolver} from './imports.js';

import {
    Diagnostic,
    findAllVariableReferences,
    getNodeAt,
    isValidIdentifier,
    parseScript,
    findAllFunctionReferences,
    isFunctionReference,
} from 'scarpet-parser';
import {getHoverContents} from './hover.js';
import {getDefinition} from './definition.js';
import {
    completionResolve,
    getCompletion,
    initializeDefaultItems,
} from './completion.js';
import {getRange} from './utils.js';
import {getDocumentInlayHints} from './inlayHints.js';

const connection = createConnection(ProposedFeatures.all);

// uncaughtExceptionMonitor doesn't prevent crashes, we just inform the
// client before crashing
process.on('uncaughtExceptionMonitor', (error, origin) => {
    try {
        let message = error && error.stack;
        if (!message) message = String(error);
        connection.console.error(`Error in ${origin}: ${message}`);
    } catch {
        /* empty */
    }
});

const documents = new TextDocuments(TextDocument);
/**
 * Cache the AST so it can be reused
 *
 * @type {Map<string, import('scarpet-parser').Node>}
 */
const documentsAst = new Map();

/**
 * Cache of ASTs for library files loaded from disk (not open documents).
 *
 * @type {Map<string, import('scarpet-parser').Node>}
 */
const libraryAst = new Map();

/** @type {string[]} */
let workspaceFolderPaths = [];

/**
 * @typedef {object} InitOptions
 * @property {boolean} [something]
 */

/** @type {import('vscode-languageserver').ClientCapabilities} */
let clientCapabilities;

/**
 * Load and cache the AST of any file, prefering the version of open documents.
 *
 * @param {string} uri
 * @returns {Promise<import('scarpet-parser').Node | undefined>}
 */
async function loadAst(uri) {
    const open = documentsAst.get(uri);
    if (open !== undefined) return open;
    const cached = libraryAst.get(uri);
    if (cached !== undefined) return cached;
    const text = await fs
        .readFile(fileURLToPath(uri), 'utf8')
        .catch(() => undefined);
    if (text === undefined) return undefined;
    const ast = parseScript(text, {diagnostics: []});
    if (ast === undefined) return undefined;
    libraryAst.set(uri, ast);
    return ast;
}

/**
 * Resolve the definition of symbols imported from library modules.
 *
 * @param {string} uri
 * @param {import('scarpet-parser').Node} root
 * @param {string} name
 * @returns {Promise<import('./imports.js').LibraryResolution | undefined>}
 */
const resolveImportedSymbol = createLibraryResolver({
    getWorkspaceFolderPaths: () => workspaceFolderPaths,
    loadAst,
});

connection.onInitialize((init) => {
    clientCapabilities = init.capabilities;
    workspaceFolderPaths = (init.workspaceFolders ?? [])
        .map((folder) => {
            try {
                return fileURLToPath(folder.uri);
            } catch {
                return undefined;
            }
        })
        .filter((folder) => folder !== undefined);
    initializeDefaultItems(clientCapabilities);
    /** @type {import('vscode-languageserver').ServerCapabilities} */
    const capabilities = {
        // JavaScript (and Scarpet) use UTF-16 strings (it is the default in LSP)
        // positionEncoding: PositionEncodingKind.UTF16,
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        completionProvider: {
            triggerCharacters: [':', '~', "'"],
            resolveProvider: true,
            completionItem: {
                labelDetailsSupport: true,
            },
        },
        renameProvider: {
            prepareProvider: true,
        },
        inlayHintProvider: true,
        documentFormattingProvider: true,
    };
    return {capabilities};
});

connection.onInitialized(() => {
    // connection.client.register()
});

documents.onDidChangeContent(({document}) => {
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const ast = parseScript(document.getText(), {diagnostics});
    if (ast === undefined) return;
    documentsAst.set(document.uri, ast);
    connection.sendDiagnostics({uri: document.uri, diagnostics});
});

// connection.languages.inlayHint.on(({textDocument}) => {
//     const ast = documentsAst.get(textDocument.uri);
//     return undefined;
// });

documents.onDidClose(({document}) => {
    documentsAst.delete(document.uri);
    libraryAst.delete(document.uri);
});

connection.onHover(async ({textDocument, position}) => {
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    const offset = document.offsetAt(position);
    const node = getNodeAt(ast, offset);
    if (node === undefined) return undefined;
    return getHoverContents(
        clientCapabilities,
        textDocument.uri,
        ast,
        node,
        resolveImportedSymbol,
    );
});

connection.onDefinition(async ({textDocument, position}) => {
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    const offset = document.offsetAt(position);
    const node = getNodeAt(ast, offset);
    if (node === undefined) return undefined;
    const definition = await getDefinition(
        textDocument.uri,
        ast,
        node,
        resolveImportedSymbol,
    );
    if (definition === undefined) return undefined;
    return [definition];
});

connection.onCompletion(({textDocument, position}) => {
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    const offset = document.offsetAt(position);
    return getCompletion(
        clientCapabilities,
        ast,
        offset,
        position,
        document.getText(),
    );
});

connection.onCompletionResolve(completionResolve);

// connection.onSignatureHelp(({textDocument, position}) => {
//     try {
//         const document = documents.get(textDocument.uri);
//         const root = parsedDocuments.get(textDocument.uri);
//         if (document === undefined || root === undefined) return undefined;
//         const offset = document.offsetAt(position);
//         const call = getCallAt(root, offset);
//         console.log(JSON.stringify(call));
//         if (call === undefined) return undefined;
//         const [func, index] = call;
//         const definition = findFunctionDefinition(root, func, func.name.value);
//         console.log(JSON.stringify(definition?.signature));
//         if (definition === undefined) return undefined;
//         const signature = resolveExpression(definition.signature);
//         if (signature === undefined || signature.kind !== 'FunctionExpression')
//             return undefined;
//         const f = {
//             signatures: [
//                 SignatureInformation.create(
//                     func.name.value,
//                     definition.comment,
//                     ...signature.params.flatMap((param) => {
//                         const variable = resolveExpression(param);
//                         switch (variable?.kind) {
//                             case 'Variable':
//                                 return [
//                                     ParameterInformation.create(
//                                         variable.name,
//                                         variable.name,
//                                     ),
//                                 ];
//                             case 'UnaryExpression':
//                                 if (variable.value?.kind === 'Variable')
//                                     return [
//                                         ParameterInformation.create(
//                                             variable.value.name,
//                                             variable.value.name,
//                                         ),
//                                     ];
//                             // fallthrough
//                             default:
//                                 return [];
//                         }
//                     }),
//                 ),
//             ],
//             activeSignature: 0,
//             activeParameter: index,
//         };
//         console.log(JSON.stringify(f));
//         return f;
//     } catch (e) {
//         console.log(String(e));
//         return undefined;
//     }
// });

connection.onPrepareRename(({textDocument, position}) => {
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    const offset = document.offsetAt(position);
    const node = getNodeAt(ast, offset);
    if (node === undefined) return undefined;
    if (node.kind === 'FunctionExpression') {
        return {range: getRange(node.name), placeholder: node.name.value};
    } else if (node.kind === 'Variable') {
        return {range: getRange(node), placeholder: node.name};
    }
    return undefined;
});

connection.onRenameRequest(({textDocument, position, newName}) => {
    if (!isValidIdentifier(newName))
        return new ResponseError(0, 'Invalid identifier');
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    const offset = document.offsetAt(position);
    const node = getNodeAt(ast, offset);
    if (node === undefined) return undefined;
    if (node.kind === 'Variable') {
        const references = findAllVariableReferences(ast, node);
        return {
            changes: {
                [textDocument.uri]: references.map((node) =>
                    TextEdit.replace(getRange(node), newName),
                ),
            },
        };
    } else if (
        node.kind === 'FunctionExpression' ||
        (node.kind === 'StringLiteral' && isFunctionReference(ast, node))
    ) {
        const references = findAllFunctionReferences(
            ast,
            node,
            node.kind === 'StringLiteral' ? node.value : node.name.value,
        );
        return {
            changes: {
                [textDocument.uri]: references.map((node) =>
                    TextEdit.replace(
                        node.kind === 'FunctionExpression'
                            ? getRange(node.name)
                            : getRange(node),
                        node.kind === 'StringLiteral'
                            ? `'${newName}'`
                            : newName,
                    ),
                ),
            },
        };
    }
    return undefined;
});

connection.languages.inlayHint.on(async ({textDocument, range}) => {
    const document = documents.get(textDocument.uri);
    const ast = documentsAst.get(textDocument.uri);
    if (document === undefined || ast === undefined) return undefined;
    return getDocumentInlayHints(
        ast,
        document.offsetAt(range.start),
        document.offsetAt(range.end),
        resolveImportedSymbol,
        textDocument.uri,
    );
});

documents.listen(connection);
connection.listen();
