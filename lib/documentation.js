import {resolveExpression} from 'scarpet-parser';
import {MarkupContent, MarkupKind} from 'vscode-languageserver';

/**
 * @param {string} comment
 * @param {boolean} markdown
 * @returns
 */
function cleanupComment(comment, markdown) {
    let clean = '';
    let lastChar = '\0';
    let nonspace = true;
    let lf = false;
    // Start from 2 ignoring starting slashes //
    for (let i = 2; i < comment.length; i++) {
        const c = comment.charAt(i);
        // Fix whitespaces for plain text
        if (/^\p{White_Space}$/u.test(c)) {
            if (c === '\n') {
                if (lastChar === '\n' && !lf) {
                    clean += markdown ? '\n\n' : '\n';
                    lf = true;
                }
                // skip the // of the next comment line
                i += 2;
            }
            if (nonspace) clean += ' ';
            nonspace = false;
        } else {
            clean += c;
            nonspace = true;
            lf = false;
        }
        lastChar = c;
    }
    return clean.trim();
}

/**
 * Cleanup a doc comment (`///`) for display.
 *
 * Unlike regular comments, doc comments contain markdown so the line structure
 * and indentation are preserved instead of being collapsed into a single line.
 *
 * @param {string} comment
 * @returns
 */
function cleanupDocComment(comment) {
    const lines = comment.split('\n');
    let clean = '';
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.endsWith('\r')) line = line.slice(0, -1);
        // strip the /// prefix and a single following space from each line
        if (line.startsWith('///')) line = line.slice(3);
        else if (line.startsWith('//')) line = line.slice(2);
        if (line.startsWith(' ')) line = line.slice(1);
        clean += line;
        if (i !== lines.length - 1) clean += '\n';
    }
    return clean.trim();
}

/**
 * Get documentation for a symbol using its comment.
 *
 * Doc comments (`///`) are detected by their `///` prefix and rendered as
 * markdown, while regular comments (`//`) are cleaned up for display.
 *
 * @param {string | undefined} syntax
 * @param {string | undefined} comment
 * @param {boolean} markdown
 * @returns {MarkupContent}
 */
export function fromComment(syntax, comment, markdown) {
    let value = syntax
        ? markdown
            ? `\`\`\`scarpet\n${syntax}\n\`\`\`\n\n`
            : `${syntax}\n`
        : '';
    if (comment) {
        value += comment.startsWith('///')
            ? cleanupDocComment(comment)
            : cleanupComment(comment, markdown);
    }
    return {kind: markdown ? MarkupKind.Markdown : MarkupKind.PlainText, value};
}

/**
 * @param {string | undefined} syntax
 * @param {{markdown?: string; plain?: string; deprecated?: string}} documentation
 * @param {boolean} markdown
 */
export function fromBuiltin(syntax, documentation, markdown) {
    let value = syntax
        ? markdown
            ? `\`\`\`scarpet\n${syntax}\n\`\`\`\n\n`
            : `${syntax}\n`
        : '';
    if (documentation.deprecated) {
        value += documentation.deprecated;
        value += markdown ? '\n\n' : '\n';
    }
    if (markdown) {
        if (documentation.markdown) value += documentation.markdown;
    } else {
        if (documentation.plain) value += documentation.plain;
    }
    return {kind: markdown ? MarkupKind.Markdown : MarkupKind.PlainText, value};
}

/**
 * @param {import('scarpet-parser/types/findDefinition.js').VariableDefinition} definition
 * @param {boolean} markdown
 */
export function fromVariable(definition, markdown) {
    return fromComment(
        definition.kind === 'parameter'
            ? definition.variable.name + ' // parameter'
            : definition.variable.name,
        definition.docComment ?? definition.comment,
        markdown,
    );
}

/**
 * @param {string} name
 * @param {{params: {name: string; rest?: boolean}[]}} signature
 */
export function getBuiltinSyntax(name, signature) {
    let syntax = name + '(';
    syntax += signature.params
        .map((param) => (param.rest ? '...' + param.name : param.name))
        .join(', ');
    syntax += ')';
    return syntax;
}

/**
 * @param {string} name
 * @param {import('./builtinsData.js').BuiltinFunction} builtinFunction
 */
export function getBuiltinFunctionSyntax(name, builtinFunction) {
    return (
        builtinFunction.signatures
            ?.map((signature) => getBuiltinSyntax(name, signature))
            .join('\n') ?? name + '()'
    );
}

/**
 * Get the signature or syntax hint for the given function declaration.
 *
 * @param {import('scarpet-parser').FunctionDeclaration} declaration
 */
export function getFunctionSyntax(declaration) {
    let syntax = '';
    const signature = resolveExpression(declaration.signature);
    if (signature?.kind !== 'FunctionExpression') return undefined;
    syntax += signature.name.value;
    syntax += '(';
    /** @type {string[]} */
    const params = [];
    /** @type {string | undefined} */
    let rest = undefined;
    for (const p of signature.params) {
        const param = resolveExpression(p);
        if (param === undefined) continue;
        if (param.kind === 'Variable') {
            params.push(param.name);
        } else if (
            param.kind === 'UnaryExpression' &&
            param.operator === '...' &&
            param.value !== undefined &&
            param.value.kind === 'Variable'
        ) {
            rest = param.value.name;
        }
        // ignore outer or invalid parameters
    }
    syntax += params.join(', ');
    if (rest !== undefined)
        syntax += (params.length !== 0 ? ', ...' : '...') + rest;
    syntax += ')';
    return syntax;
}
