import {Hover} from 'vscode-languageserver/node.js';
import {readFile} from 'node:fs/promises';
import {
    findFunctionDefinition,
    findVariableDefinition,
    isFunctionReference,
} from 'scarpet-parser';

import {getRange} from './utils.js';
import {
    fromBuiltin,
    fromComment,
    fromVariable,
    getFileHeaderDocComment,
    getBuiltinFunctionSyntax,
    getBuiltinSyntax,
    getFunctionSyntax,
} from './documentation.js';
import data from './builtinsData.js';
import {
    findImportModuleParam,
    findImportSymbolParam,
    getSearchDirectories,
    findModuleFileInDirectories,
} from './imports.js';

/**
 * @param {boolean} useMarkdown
 * @param {import('scarpet-parser').HexLiteral
 *     | import('scarpet-parser').NumberLiteral} node
 * @returns {Hover}
 */
function getNumberHover(useMarkdown, node) {
    let syntax = '';
    const value = node.value.value.toString();
    const point = value.length - Number(node.value.scale);
    syntax += value.slice(0, point);
    if (node.value.scale !== 0n) {
        syntax += '.';
        syntax += value.slice(point);
    }
    if (node.value.scale === 0n) {
        syntax += ' (0x' + node.value.value.toString(16).toUpperCase() + ')';
    }
    return {
        contents: fromComment(syntax, undefined, useMarkdown),
        range: getRange(node),
    };
}

/**
 * @param {boolean} useMarkdown
 * @param {string} filePath
 * @returns {Promise<Hover | undefined>}
 */
async function getFileHeaderHover(useMarkdown, filePath) {
    const text = await readFile(filePath, 'utf8').catch(() => undefined);
    if (text === undefined) return undefined;
    const doc = getFileHeaderDocComment(text);
    if (doc === undefined) return undefined;
    return {
        contents: fromComment(undefined, `///\n${doc}`, useMarkdown),
    };
}

/**
 * @param {boolean} useMarkdown
 * @param {import('scarpet-parser').FunctionDeclaration} declaration
 * @returns {Hover | undefined}
 */
function getSymbolHover(useMarkdown, declaration) {
    const syntax = getFunctionSyntax(declaration);
    if (syntax === undefined) return undefined;
    return {
        contents: fromComment(
            syntax,
            declaration.docComment ?? declaration.comment,
            useMarkdown,
        ),
    };
}

/**
 * @param {boolean} useMarkdown
 * @param {import('./imports.js').LibraryVariable} variable
 * @returns {Hover}
 */
function getVariableHover(useMarkdown, variable) {
    return {
        contents: fromComment(
            variable.variable.name,
            variable.docComment ?? variable.comment,
            useMarkdown,
        ),
    };
}

/**
 * @param {import('vscode-languageserver').ClientCapabilities} clientCapabilities
 * @param {string} uri
 * @param {import('scarpet-parser').Node} root
 * @param {import('scarpet-parser').Node} node
 * @param {(
 *     uri: string,
 *     root: import('scarpet-parser').Node,
 *     name: string,
 * ) => Promise<import('./imports.js').LibraryResolution | undefined>} resolveImportedSymbol
 * @param {import('./imports.js').LibraryResolverOptions} libraryOptions
 * @returns {Promise<Hover | undefined>}
 */
export async function getHoverContents(
    clientCapabilities,
    uri,
    root,
    node,
    resolveImportedSymbol,
    libraryOptions,
) {
    const useMarkdown = Boolean(clientCapabilities.general?.markdown);
    switch (node.kind) {
        case 'FunctionExpression': {
            const range = getRange(node.name);
            const name = node.name.value;
            // function call
            const callback = data.callbacks[name];
            if (callback !== undefined)
                return {
                    contents: fromBuiltin(
                        getBuiltinSyntax(name, callback),
                        callback,
                        useMarkdown,
                    ),
                    range,
                };
            const builtinFunction = data.functions[name];
            if (builtinFunction !== undefined)
                return {
                    contents: fromBuiltin(
                        getBuiltinFunctionSyntax(name, builtinFunction),
                        builtinFunction,
                        useMarkdown,
                    ),
                    range,
                };
            const definition = findFunctionDefinition(
                root,
                node,
                node.name.value,
            );
            if (definition !== undefined) {
                const syntax = getFunctionSyntax(definition);
                if (syntax === undefined) break;
                return {
                    contents: fromComment(
                        syntax,
                        definition.docComment ?? definition.comment,
                        useMarkdown,
                    ),
                    range,
                };
            }
            const resolved = await resolveImportedSymbol(uri, root, name);
            if (resolved?.declaration !== undefined) {
                const syntax = getFunctionSyntax(resolved.declaration);
                if (syntax === undefined) break;
                return {
                    contents: fromComment(
                        syntax,
                        resolved.declaration.docComment ??
                            resolved.declaration.comment,
                        useMarkdown,
                    ),
                    range,
                };
            }
            if (resolved?.variable !== undefined) {
                return {
                    contents: fromComment(
                        resolved.variable.variable.name,
                        resolved.variable.docComment ??
                            resolved.variable.comment,
                        useMarkdown,
                    ),
                    range,
                };
            }
            break;
        }
        // case 'FunctionDeclaration': {
        //     const signature = resolveExpression(node.signature);
        //     // console.log(signature.name.value in data.constants);
        //     if (
        //         signature !== undefined &&
        //         signature.kind === 'FunctionExpression' &&
        //         signature.name.value in data.callbacks
        //     ) {
        //         return getCallbackHover(
        //             useMarkdown,
        //             data.callbacks[signature.name.value],
        //             signature,
        //         );
        //     }
        //     return getFunctionHover(useMarkdown, node, node);
        // }
        case 'Variable': {
            const definition = findVariableDefinition(root, node);
            if (definition !== undefined) {
                return {
                    contents: fromVariable(definition, useMarkdown),
                    range: getRange(node),
                };
            }
            const resolved = await resolveImportedSymbol(uri, root, node.name);
            if (resolved?.variable !== undefined) {
                return {
                    contents: fromComment(
                        resolved.variable.variable.name,
                        resolved.variable.docComment ??
                            resolved.variable.comment,
                        useMarkdown,
                    ),
                    range: getRange(node),
                };
            }
            if (resolved?.declaration !== undefined) {
                const syntax = getFunctionSyntax(resolved.declaration);
                if (syntax === undefined) break;
                return {
                    contents: fromComment(
                        syntax,
                        resolved.declaration.docComment ??
                            resolved.declaration.comment,
                        useMarkdown,
                    ),
                    range: getRange(node),
                };
            }
            break;
        }
        case 'Constant': {
            const constant = data.constants[node.name];
            if (constant === undefined) break;
            return {
                contents: fromBuiltin(node.name, constant, useMarkdown),
                range: getRange(node),
            };
        }
        // case 'Parameter':
        // case 'OuterParameter':
        // case 'RestParameter':
        //     return getVariableHover(useMarkdown, node, node);
        case 'HexLiteral':
        case 'NumberLiteral':
            return getNumberHover(useMarkdown, node);
        case 'StringLiteral': {
            // Import module name hover: show file header doc comment.
            const moduleImport = findImportModuleParam(root, node);
            if (moduleImport !== undefined) {
                const searchDirs = getSearchDirectories(
                    uri,
                    libraryOptions.getWorkspaceFolderPaths,
                );
                const filePath = await findModuleFileInDirectories(
                    searchDirs,
                    moduleImport.module,
                );
                if (filePath !== undefined) {
                    return getFileHeaderHover(useMarkdown, filePath);
                }
                break;
            }
            // Import symbol name hover: show the symbol's doc comment.
            const symbolImport = findImportSymbolParam(root, node);
            if (symbolImport !== undefined) {
                const resolved = await resolveImportedSymbol(
                    uri,
                    root,
                    node.value,
                );
                if (resolved?.declaration !== undefined) {
                    return getSymbolHover(
                        useMarkdown,
                        resolved.declaration,
                    );
                }
                if (resolved?.variable !== undefined) {
                    return getVariableHover(
                        useMarkdown,
                        resolved.variable,
                    );
                }
                break;
            }
            // StringLiteral function call (e.g. call('fn')).
            if (isFunctionReference(root, node)) {
                const range = getRange(node);
                const name = node.value;
                // function call
                const builtinFunction = data.functions[name];
                if (builtinFunction !== undefined)
                    return {
                        contents: fromBuiltin(
                            getBuiltinFunctionSyntax(name, builtinFunction),
                            builtinFunction,
                            useMarkdown,
                        ),
                        range,
                    };
                const definition = findFunctionDefinition(root, node, name);
                if (definition !== undefined) {
                    const syntax = getFunctionSyntax(definition);
                    if (syntax === undefined) break;
                    return {
                        contents: fromComment(
                            syntax,
                            definition.docComment ?? definition.comment,
                            useMarkdown,
                        ),
                        range,
                    };
                }
                const resolved = await resolveImportedSymbol(uri, root, name);
                if (resolved?.declaration !== undefined) {
                    const syntax = getFunctionSyntax(resolved.declaration);
                    if (syntax === undefined) break;
                    return {
                        contents: fromComment(
                            syntax,
                            resolved.declaration.docComment ??
                                resolved.declaration.comment,
                            useMarkdown,
                        ),
                        range,
                    };
                }
                if (resolved?.variable !== undefined) {
                    return {
                        contents: fromComment(
                            resolved.variable.variable.name,
                            resolved.variable.docComment ??
                                resolved.variable.comment,
                            useMarkdown,
                        ),
                        range,
                    };
                }
                break;
            }
            break;
        }
    }
    return undefined;
}
