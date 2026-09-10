import {
    findFunctionDefinition,
    findVariableDefinition,
    isFunctionReference,
    resolveExpression,
} from 'scarpet-parser';
import {getRange} from './utils.js';

/**
 * @param {string} uri
 * @param {import('scarpet-parser').FunctionDeclaration} node
 * @param {import('scarpet-parser').Node} reference
 */
function getFunctionLink(uri, node, reference) {
    const signature = resolveExpression(node.signature) ?? node.signature;
    return {
        originSelectionRange:
            reference.kind === 'FunctionExpression'
                ? getRange(reference.name)
                : getRange(reference),
        targetRange: getRange(node),
        targetSelectionRange:
            signature.kind === 'FunctionExpression'
                ? getRange(signature.name)
                : getRange(signature),
        targetUri: uri,
    };
}

/**
 * @param {string} uri
 * @param {import('scarpet-parser').Node} root
 * @param {import('scarpet-parser').Node} node
 * @param {(
 *     uri: string,
 *     root: import('scarpet-parser').Node,
 *     name: string,
 * ) => Promise<import('./imports.js').LibraryResolution | undefined>} resolveImportedSymbol
 * @returns {Promise<
 *     import('vscode-languageserver').DefinitionLink | undefined
 * >}
 */
export async function getDefinition(uri, root, node, resolveImportedSymbol) {
    /** @param {import('./imports.js').LibraryResolution} resolved */
    function getLibraryLink(resolved) {
        if (resolved.declaration !== undefined) {
            return getFunctionLink(resolved.uri, resolved.declaration, node);
        }
        if (resolved.variable !== undefined) {
            return {
                originSelectionRange:
                    node.kind === 'FunctionExpression'
                        ? getRange(node.name)
                        : getRange(node),
                targetRange: getRange(resolved.variable.variable),
                targetSelectionRange: getRange(resolved.variable.variable),
                targetUri: resolved.uri,
            };
        }
        return undefined;
    }
    switch (node.kind) {
        case 'Variable': {
            const definition = findVariableDefinition(root, node);
            if (definition !== undefined) {
                return {
                    originSelectionRange: getRange(node),
                    targetRange: getRange(definition.variable),
                    targetSelectionRange: getRange(definition.variable),
                    targetUri: uri,
                };
            }
            const resolved = await resolveImportedSymbol(uri, root, node.name);
            if (resolved === undefined) return undefined;
            return getLibraryLink(resolved);
        }
        case 'FunctionDeclaration':
            return getFunctionLink(uri, node, node);
        case 'FunctionExpression': {
            const definition = findFunctionDefinition(
                root,
                node,
                node.name.value,
            );
            if (definition !== undefined)
                return getFunctionLink(uri, definition, node);
            const resolved = await resolveImportedSymbol(
                uri,
                root,
                node.name.value,
            );
            if (resolved === undefined) return undefined;
            return getLibraryLink(resolved);
        }
        case 'StringLiteral':
            if (isFunctionReference(root, node)) {
                const definition = findFunctionDefinition(
                    root,
                    node,
                    node.value,
                );
                if (definition !== undefined)
                    return getFunctionLink(uri, definition, node);
                const resolved = await resolveImportedSymbol(
                    uri,
                    root,
                    node.value,
                );
                if (resolved === undefined) return undefined;
                return getLibraryLink(resolved);
            }
            break;
    }
    return undefined;
}
