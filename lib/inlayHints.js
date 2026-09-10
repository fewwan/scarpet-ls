import {InlayHint} from 'vscode-languageserver';
import {resolveExpression} from 'scarpet-parser';
import data from './builtinsData.js';

/**
 * Collect all user-defined function declarations in the AST.
 *
 * Returns a map of function name → array of parameter names, with `...` vararg
 * parameters excluded (they cannot be hinted).
 *
 * @param {import('scarpet-parser').Node} ast
 * @returns {Map<string, string[]>}
 */
function collectDeclarations(ast) {
    /** @type {Map<string, string[]>} */
    const declarations = new Map();
    (function walk(node) {
        if (
            node === undefined ||
            node === null ||
            typeof node.kind !== 'string'
        )
            return;
        if (node.kind === 'FunctionDeclaration') {
            const sig = resolveExpression(node.signature);
            if (sig?.kind === 'FunctionExpression') {
                /** @type {string[]} */
                const params = [];
                for (const p of sig.params) {
                    const resolved = resolveExpression(p);
                    if (
                        resolved?.kind === 'Variable' &&
                        resolved.name !== '...'
                    ) {
                        params.push(resolved.name);
                    }
                }
                declarations.set(sig.name.value, params);
            }
            if (node.body !== undefined) walk(node.body);
            return;
        }
        for (const [, v] of Object.entries(node)) {
            if (Array.isArray(v)) {
                for (const c of v) walk(c);
            } else if (
                v &&
                typeof v === 'object' &&
                typeof v.kind === 'string'
            ) {
                walk(v);
            }
        }
    })(ast);
    return declarations;
}

/**
 * @param {import('scarpet-parser').Node} ast
 * @param {number} start
 * @param {number} end
 * @param {InlayHint[]} inlayHints
 * @param {Map<string, string[]>} [declarations]
 */
export function getInlayHints(ast, start, end, inlayHints, declarations) {
    switch (ast.kind) {
        case 'BinaryExpression':
            getInlayHints(ast.lvalue, start, end, inlayHints, declarations);
            if (ast.rvalue !== undefined)
                getInlayHints(ast.rvalue, start, end, inlayHints, declarations);
            break;
        case 'ParenthesisedExpression':
        case 'UnaryExpression':
            if (ast.value !== undefined)
                getInlayHints(ast.value, start, end, inlayHints, declarations);
            break;
        case 'FunctionDeclaration':
            if (ast.body !== undefined)
                getInlayHints(ast.body, start, end, inlayHints, declarations);
            break;
        case 'FunctionExpression': {
            if (ast.params.length !== 0) {
                /** @type {{name: string}[] | undefined} */
                let hintParams;
                const builtinFunction = data.functions[ast.name.value];
                if (
                    builtinFunction !== undefined &&
                    builtinFunction.signatures
                ) {
                    const signature = builtinFunction.signatures.find(
                        (signature) =>
                            signature.params.length === ast.params.length,
                    );
                    if (signature !== undefined) hintParams = signature.params;
                }
                if (hintParams === undefined && declarations !== undefined) {
                    const decl =
                        declarations.get(ast.name.value) ??
                        declarations.get(`global_${ast.name.value}`);
                    if (decl !== undefined)
                        hintParams = decl.map((name) => ({name}));
                }
                if (hintParams !== undefined) {
                    const count = Math.min(
                        hintParams.length,
                        ast.params.length,
                    );
                    for (let i = 0; i < count; i++) {
                        const param = ast.params[i];
                        if (
                            param.start.offset >= start &&
                            param.end.offset < end
                        )
                            inlayHints.push({
                                label: String(hintParams[i].name) + ':',
                                position: {
                                    line: param.start.line,
                                    character: param.start.character,
                                },
                                paddingRight: true,
                            });
                    }
                }
                for (const param of ast.params)
                    getInlayHints(param, start, end, inlayHints, declarations);
            }
        }
    }
}

/**
 * @param {import('scarpet-parser').Node} ast
 * @param {number} start
 * @param {number} end
 * @returns {InlayHint[]}
 */
export function getDocumentInlayHints(ast, start, end) {
    /** @type {InlayHint[]} */
    const inlayHints = [];
    const declarations = collectDeclarations(ast);
    getInlayHints(ast, start, end, inlayHints, declarations);
    return inlayHints;
}
