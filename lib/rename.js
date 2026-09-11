import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
    findAllFunctionReferences,
    findAllVariableReferences,
    isFunctionReference,
    resolveExpression,
} from 'scarpet-parser';

import {getRange} from './utils.js';
import {findScriptFiles, getImports} from './imports.js';

/**
 * @typedef {import('vscode-languageserver').TextEdit} TextEdit
 * @typedef {import('./imports.js').LibraryResolution} LibraryResolution
 * @typedef {import('scarpet-parser').Node} Node
 * @typedef {import('scarpet-parser').FunctionExpression | import('scarpet-parser').StringLiteral} FunctionReferenceNode
 */

/**
 * @typedef {object} LibraryContext
 * @property {() => string[]} getWorkspaceFolderPaths
 * @property {(uri: string) => Promise<Node | undefined>} loadAst
 * @property {(
 *     uri: string,
 *     root: Node,
 *     name: string,
 * ) => Promise<LibraryResolution | undefined>} resolveImportedSymbol
 */

/**
 * Compute the common ancestor directory of two file paths.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function commonAncestor(a, b) {
    const pa = a.split(path.sep);
    const pb = b.split(path.sep);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    if (i === 0) return path.sep;
    return pa.slice(0, i).join(path.sep);
}

/**
 * Add a grouped text edit, skipping exact duplicates.
 *
 * @param {Map<string, TextEdit[]>} edits
 * @param {string} uri
 * @param {TextEdit} edit
 */
function pushEdit(edits, uri, edit) {
    const {range} = edit;
    const existing = edits.get(uri) ?? [];
    for (const e of existing) {
        if (
            e.range.start.line === range.start.line &&
            e.range.start.character === range.start.character &&
            e.range.end.line === range.end.line &&
            e.range.end.character === range.end.character &&
            e.newText === edit.newText
        ) {
            return;
        }
    }
    existing.push(edit);
    edits.set(uri, existing);
}

/**
 * The name of a symbol as declared in a library, preserving the `global_`
 * prefix when it is present.
 *
 * @param {LibraryResolution} resolved
 * @returns {string | undefined}
 */
function libraryName(resolved) {
    if (resolved.declaration !== undefined) {
        const sig = resolveExpression(resolved.declaration.signature);
        return sig?.kind === 'FunctionExpression' ? sig.name.value : undefined;
    }
    if (resolved.variable !== undefined) {
        return resolved.variable.variable.name;
    }
    return undefined;
}

/**
 * Rename a library symbol across the project.
 *
 * The symbol is renamed in the library file itself, and in every script file
 * under the common ancestor of the source and library directories that imports
 * the module: function/variable references and the `'name'` argument of the
 * matching `import(...)` calls.
 *
 * @param {string} sourceUri
 * @param {string} name
 * @param {string} newName
 * @param {LibraryResolution} resolved
 * @param {LibraryContext} context
 * @returns {Promise<{changes: Record<string, TextEdit[]>} | undefined>}
 */
async function renameLibrarySymbol(
    sourceUri,
    name,
    newName,
    resolved,
    context,
) {
    const libName = libraryName(resolved);
    if (libName === undefined) return undefined;
    let newLibName = newName;
    if (libName.startsWith('global_')) newLibName = `global_${newName}`;

    const libAst = await context.loadAst(resolved.uri);
    if (libAst === undefined) return undefined;

    /** @type {Map<string, TextEdit[]>} */
    const edits = new Map();

    // The library file itself: declaration and internal references.
    if (resolved.declaration !== undefined) {
        const sig = resolveExpression(resolved.declaration.signature);
        if (sig?.kind === 'FunctionExpression') {
            const refs = findAllFunctionReferences(libAst, sig, libName);
            for (const ref of refs) {
                pushEdit(edits, resolved.uri, {
                    range:
                        ref.kind === 'FunctionExpression'
                            ? getRange(ref.name)
                            : getRange(ref),
                    newText:
                        ref.kind === 'StringLiteral'
                            ? `'${newLibName}'`
                            : newLibName,
                });
            }
        }
    } else if (resolved.variable !== undefined) {
        const refs = findAllVariableReferences(
            libAst,
            resolved.variable.variable,
        );
        for (const ref of refs) {
            pushEdit(edits, resolved.uri, {
                range: getRange(ref),
                newText: newLibName,
            });
        }
    }

    // Every importer of the module.
    const libPath = fileURLToPath(resolved.uri);
    const workspaceFolders = context.getWorkspaceFolderPaths();
    const searchDirs =
        workspaceFolders.length > 0
            ? workspaceFolders
            : [commonAncestor(
                  path.dirname(fileURLToPath(sourceUri)),
                  path.dirname(libPath),
              )];
    for (const filePath of await findScriptFiles(searchDirs)) {
        if (filePath === libPath) continue;
        const fileUri = pathToFileURL(filePath).href;
        const fileAst = await context.loadAst(fileUri);
        if (fileAst === undefined) continue;
        const imports = getImports(fileAst).filter(
            (imp) => imp.module === resolved.module,
        );
        if (imports.length === 0) continue;

        // References to the renamed symbol in this file.
        if (resolved.declaration !== undefined) {
            const refs = findAllFunctionReferences(
                fileAst,
                /** @type {FunctionReferenceNode} */ ({}),
                name,
            );
            for (const ref of refs) {
                pushEdit(edits, fileUri, {
                    range:
                        ref.kind === 'FunctionExpression'
                            ? getRange(ref.name)
                            : getRange(ref),
                    newText:
                        ref.kind === 'StringLiteral'
                            ? `'${newName}'`
                            : newName,
                });
            }
        } else if (resolved.variable !== undefined) {
            const refs = findAllVariableReferences(
                fileAst,
                resolved.variable.variable,
            );
            for (const ref of refs) {
                pushEdit(edits, fileUri, {
                    range: getRange(ref),
                    newText: newName,
                });
            }
        }

        // The symbol list of the import calls themselves.
        for (const imp of imports) {
            if (imp.symbols === undefined) continue;
            // Skip the first param (module name).
            for (const param of imp.node.params.slice(1)) {
                const arg = resolveExpression(param);
                if (arg?.kind !== 'StringLiteral') continue;
                if (arg.value !== name && arg.value !== libName) continue;
                pushEdit(edits, fileUri, {
                    range: getRange(arg),
                    newText: `'${newName}'`,
                });
            }
        }
    }

    if (edits.size === 0) return undefined;
    return {changes: Object.fromEntries(edits)};
}

/**
 * Rename a symbol, propagating the change to library files and importers when
 * the symbol resolves to a library.
 *
 * @param {string} uri
 * @param {import('scarpet-parser').Node} root
 * @param {import('scarpet-parser').Node | undefined} node
 * @param {string} newName
 * @param {LibraryContext} context
 * @returns {Promise<{changes: Record<string, TextEdit[]>} | undefined>}
 */
export async function getWorkspaceRename(
    uri,
    root,
    node,
    newName,
    context,
) {
    if (node === undefined) return undefined;
    if (node.kind === 'Variable') {
        return renameSameFile(
            uri,
            findAllVariableReferences(root, node).map((ref) => ({
                range: getRange(ref),
                newText: newName,
            })),
        );
    }
    if (
        node.kind === 'FunctionExpression' ||
        (node.kind === 'StringLiteral' && isFunctionReference(root, node))
    ) {
        const name =
            node.kind === 'StringLiteral' ? node.value : node.name.value;
        const resolved = await context.resolveImportedSymbol(uri, root, name);
        if (resolved !== undefined && resolved.uri !== uri) {
            return renameLibrarySymbol(
                uri,
                name,
                newName,
                resolved,
                context,
            );
        }
        return renameSameFile(
            uri,
            findAllFunctionReferences(root, node, name).map((ref) => ({
                range:
                    ref.kind === 'FunctionExpression'
                        ? getRange(ref.name)
                        : getRange(ref),
                newText:
                    ref.kind === 'StringLiteral'
                        ? `'${newName}'`
                        : newName,
            })),
        );
    }
    return undefined;
}

/**
 * @param {string} uri
 * @param {TextEdit[]} edits
 * @returns {{changes: Record<string, TextEdit[]>} | undefined}
 */
function renameSameFile(uri, edits) {
    if (edits.length === 0) return undefined;
    return {changes: {[uri]: edits}};
}