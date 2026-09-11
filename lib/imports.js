import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {resolveExpression} from 'scarpet-parser';

/**
 * @typedef {object} LibraryImport
 * @property {string} module
 * @property {Set<string> | undefined} symbols - Imported symbols, or
 *   `undefined` if the whole module is imported.
 * @property {import('scarpet-parser').FunctionExpression} node
 * @property {import('scarpet-parser').StringLiteral} moduleNode
 */

/**
 * @typedef {object} LibraryVariable
 * @property {import('scarpet-parser').Variable} variable
 * @property {string | undefined} comment
 * @property {string | undefined} docComment
 */

/**
 * @typedef {object} LibraryResolution
 * @property {string} uri
 * @property {string} module
 * @property {import('scarpet-parser').FunctionDeclaration} [declaration]
 * @property {LibraryVariable} [variable]
 */

const LIBRARY_EXTENSIONS = ['sc', 'scl'];

const SKIP_DIRECTORIES = new Set([
    '.git',
    '.venv',
    '.cache',
    'node_modules',
    'dist',
    'build',
    'target',
]);

/**
 * Recursively visit every node of the AST.
 *
 * Returning `false` from the visitor stops descending into that node.
 *
 * @param {import('scarpet-parser').Node | undefined} node
 * @param {(node: import('scarpet-parser').Node) => void | false} visit
 */
export function walkNode(node, visit) {
    if (node === undefined || node === null || typeof node.kind !== 'string')
        return;
    if (visit(node) === false) return;
    switch (node.kind) {
        case 'BinaryExpression':
            walkNode(node.lvalue, visit);
            if (node.rvalue !== undefined) walkNode(node.rvalue, visit);
            break;
        case 'ParenthesisedExpression':
        case 'UnaryExpression':
            if (node.value !== undefined) walkNode(node.value, visit);
            break;
        case 'FunctionDeclaration':
            walkNode(node.signature, visit);
            if (node.body !== undefined) walkNode(node.body, visit);
            break;
        case 'FunctionExpression':
        case 'MapLiteral':
        case 'ListLiteral':
            for (const param of node.params) {
                walkNode(param, visit);
            }
            break;
        default:
            break;
    }
}

const importsCache = new WeakMap();

/**
 * Extract every `import(...)` call from the AST.
 *
 * @param {import('scarpet-parser').Node} root
 * @returns {LibraryImport[]}
 */
export function getImports(root) {
    const cached = importsCache.get(root);
    if (cached !== undefined) return cached;
    /** @type {LibraryImport[]} */
    const imports = [];
    walkNode(root, (node) => {
        if (node.kind !== 'FunctionExpression' || node.name.value !== 'import')
            return;
        const [moduleNode, ...args] = node.params;
        if (moduleNode === undefined || moduleNode.kind !== 'StringLiteral')
            return false;
        const symbols = new Set();
        let all = args.length === 0;
        for (const arg of args) {
            if (
                arg.kind === 'UnaryExpression' &&
                arg.operator === '...' &&
                arg.value !== undefined &&
                arg.value.kind === 'FunctionExpression' &&
                arg.value.name.value === 'import'
            ) {
                // import('lib', ...import('lib')) imports the whole module
                all = true;
                continue;
            }
            if (arg.kind !== 'StringLiteral') continue;
            symbols.add(arg.value);
        }
        imports.push({
            module: moduleNode.value,
            symbols: all ? undefined : symbols,
            node,
            moduleNode,
        });
        // don't descend into the import arguments, so nested
        // `...import('lib')` wildcard expressions are not double counted.
        return false;
    });
    importsCache.set(root, imports);
    return imports;
}

/**
 * Find the imports that could provide the given symbol.
 *
 * Imports listing the symbol explicitly are returned before whole-module
 * imports. Whole-module imports are returned before imports of unrelated
 * symbols so unmatched names can still be searched.
 *
 * @param {import('scarpet-parser').Node} root
 * @param {string} name
 * @returns {LibraryImport[]}
 */
export function findImports(root, name) {
    /** @type {LibraryImport[]} */
    const explicit = [];
    /** @type {LibraryImport[]} */
    const all = [];
    for (const imp of getImports(root)) {
        if (imp.symbols === undefined) all.push(imp);
        else if (imp.symbols.has(name)) explicit.push(imp);
    }
    return [...explicit, ...all];
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isFile(filePath) {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

/**
 * Recursively search a directory tree for a file matching a module name,
 * prefering the shallowest match.
 *
 * @param {string} dir
 * @param {string} module
 * @param {number} depth
 * @param {string[]} result
 */
async function findInDirectory(dir, module, depth, result) {
    if (depth > 5) return;
    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const stats = await fs.stat(full).catch(() => undefined);
        if (stats === undefined) continue;
        // Some filesystems report dirents without type information, so the
        // type is always resolved with `fs.stat` rather than the dirent flags.
        if (stats.isDirectory()) {
            if (SKIP_DIRECTORIES.has(name)) continue;
            await findInDirectory(full, module, depth + 1, result);
        } else if (
            stats.isFile() &&
            (name === `${module}.sc` || name === `${module}.scl`)
        ) {
            result.push(full);
        }
    }
}

/**
 * Resolve a module name to a file path.
 *
 * The module name is used verbatim as the file stem: only files named
 * `<module>.sc`/`<module>.scl` are considered, regardless of where they live in
 * the directory tree. Files in `dir` itself take precedence, then the
 * shallowest match below it wins.
 *
 * @param {string} dir
 * @param {string} module
 * @returns {Promise<string | undefined>}
 */
async function findModuleFile(dir, module) {
    for (const ext of LIBRARY_EXTENSIONS) {
        const direct = path.join(dir, `${module}.${ext}`);
        if (await isFile(direct)) return direct;
    }
    /** @type {string[]} */
    const found = [];
    await findInDirectory(dir, module, 0, found);
    found.sort((a, b) => {
        const depthDiff = a.split(path.sep).length - b.split(path.sep).length;
        if (depthDiff !== 0) return depthDiff;
        return a.localeCompare(b);
    });
    return found[0];
}

/**
 * Find a function declaration matching the given name anywhere in a tree,
 * falling back to the `global_` prefixed variant.
 *
 * @param {import('scarpet-parser').Node} root
 * @param {string} name
 * @returns {import('scarpet-parser').FunctionDeclaration | undefined}
 */
function findFunctionDeclarationInTree(root, name) {
    /** @type {import('scarpet-parser').FunctionDeclaration | undefined} */
    let exact;
    /** @type {import('scarpet-parser').FunctionDeclaration | undefined} */
    let prefixed;
    walkNode(root, (node) => {
        if (exact !== undefined && prefixed !== undefined) return false;
        if (node.kind !== 'FunctionDeclaration') return undefined;
        const signature = resolveExpression(node.signature);
        if (
            signature === undefined ||
            signature.kind !== 'FunctionExpression'
        ) {
            return undefined;
        }
        if (signature.name.value === name) {
            exact ??= node;
        } else if (signature.name.value === `global_${name}`) {
            prefixed ??= node;
        }
        return undefined;
    });
    return exact ?? prefixed;
}

/**
 * Find a variable assignment matching the given name anywhere in a tree.
 *
 * @param {import('scarpet-parser').Node} root
 * @param {string} name
 * @returns {LibraryVariable | undefined}
 */
function findVariableDefinitionInTree(root, name) {
    /** @type {LibraryVariable | undefined} */
    let result;
    walkNode(root, (node) => {
        if (result !== undefined) return false;
        if (node.kind !== 'BinaryExpression') return;
        if (
            node.operator !== '=' &&
            node.operator !== '+=' &&
            node.operator !== '<>'
        )
            return;
        const target = resolveExpression(node.lvalue);
        if (target === undefined || target.kind !== 'Variable') return;
        if (target.name !== name && target.name !== `global_${name}`) return;
        result = {
            variable: target,
            comment: node.comment,
            docComment: node.docComment,
        };
        return false;
    });
    return result;
}

/**
 * @typedef {object} LibraryResolverOptions
 * @property {() => string[]} getWorkspaceFolderPaths
 * @property {(
 *     uri: string,
 * ) => Promise<import('scarpet-parser').Node | undefined>} loadAst
 */

/**
 * Compute the directories to search for library modules: the importing file's
 * directory and its ancestors (nearest first), followed by any workspace
 * folders.
 *
 * @param {string} sourceUri
 * @param {() => string[]} getWorkspaceFolderPaths
 * @returns {string[]}
 */
export function getSearchDirectories(sourceUri, getWorkspaceFolderPaths) {
    const sourceDir = path.dirname(fileURLToPath(sourceUri));
    /** @type {string[]} */
    const searchDirs = [];
    for (
        let dir = sourceDir;
        dir !== path.dirname(dir) && searchDirs.length < 8;
        dir = path.dirname(dir)
    ) {
        searchDirs.push(dir);
    }
    const seen = new Set(searchDirs);
    for (const folder of getWorkspaceFolderPaths()) {
        if (!seen.has(folder)) {
            seen.add(folder);
            searchDirs.push(folder);
        }
    }
    return searchDirs;
}

/**
 * Recursively collect every script file in a directory tree.
 *
 * @param {string} dir
 * @param {number} depth
 * @param {string[]} result
 */
async function findScriptFilesInDirectory(dir, depth, result) {
    if (depth > 5) return;
    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const stats = await fs.stat(full).catch(() => undefined);
        if (stats === undefined) continue;
        if (stats.isDirectory()) {
            if (SKIP_DIRECTORIES.has(name)) continue;
            await findScriptFilesInDirectory(full, depth + 1, result);
        } else if (
            stats.isFile() &&
            LIBRARY_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`))
        ) {
            result.push(full);
        }
    }
}

/**
 * Collect every script file reachable from the given search directories.
 *
 * @param {string[]} searchDirs
 * @returns {Promise<string[]>}
 */
export async function findScriptFiles(searchDirs) {
    /** @type {string[]} */
    const files = [];
    const seen = new Set();
    for (const dir of searchDirs) {
        /** @type {string[]} */
        const result = [];
        await findScriptFilesInDirectory(dir, 0, result);
        for (const file of result) {
            if (!seen.has(file)) {
                seen.add(file);
                files.push(file);
            }
        }
    }
    return files;
}

/**
 * Find a library module file in the given search directories.
 *
 * @param {string[]} searchDirs
 * @param {string} module
 * @returns {Promise<string | undefined>}
 */
export async function findModuleFileInDirectories(searchDirs, module) {
    for (const dir of searchDirs) {
        const filePath = await findModuleFile(dir, module);
        if (filePath !== undefined) return filePath;
    }
    return undefined;
}

/**
 * Collect the names of all function declarations in a tree.
 *
 * @param {import('scarpet-parser').Node} root
 * @returns {string[]}
 */
function collectFunctionNames(root) {
    /** @type {Set<string>} */
    const names = new Set();
    walkNode(root, (node) => {
        if (node.kind !== 'FunctionDeclaration') return undefined;
        const sig = resolveExpression(node.signature);
        if (sig?.kind === 'FunctionExpression') names.add(sig.name.value);
        return undefined;
    });
    return [...names];
}

/**
 * Collect the names of all variable definitions in a tree.
 *
 * @param {import('scarpet-parser').Node} root
 * @returns {string[]}
 */
function collectVariableNames(root) {
    /** @type {Set<string>} */
    const names = new Set();
    walkNode(root, (node) => {
        if (node.kind !== 'BinaryExpression') return undefined;
        if (
            node.operator !== '=' &&
            node.operator !== '+=' &&
            node.operator !== '<>'
        )
            return undefined;
        const target = resolveExpression(node.lvalue);
        if (target?.kind !== 'Variable') return undefined;
        names.add(target.name);
        return undefined;
    });
    return [...names];
}

/**
 * Collect every symbol provided by a file's library imports.
 *
 * The returned map holds the resolution for every imported symbol (explicitly
 * listed symbols, or all functions and variables for whole-module imports),
 * keyed by symbol name.
 *
 * @param {string} sourceUri
 * @param {import('scarpet-parser').Node} sourceRoot
 * @param {LibraryResolverOptions} options
 * @returns {Promise<Map<string, LibraryResolution>>}
 */
export async function getImportedSymbols(sourceUri, sourceRoot, options) {
    const {getWorkspaceFolderPaths, loadAst} = options;
    const searchDirs = getSearchDirectories(sourceUri, getWorkspaceFolderPaths);
    /** @type {Map<string, LibraryResolution>} */
    const symbols = new Map();
    for (const imp of getImports(sourceRoot)) {
        const filePath = await findModuleFileInDirectories(
            searchDirs,
            imp.module,
        );
        if (filePath === undefined) continue;
        const targetUri = pathToFileURL(filePath).href;
        if (targetUri === sourceUri) continue;
        const ast = await loadAst(targetUri);
        if (ast === undefined) continue;
        /** @type {string[]} */
        const names =
            imp.symbols === undefined
                ? [...collectFunctionNames(ast), ...collectVariableNames(ast)]
                : [...imp.symbols];
        for (const name of names) {
            if (symbols.has(name)) continue;
            const declaration = findFunctionDeclarationInTree(ast, name);
            if (declaration !== undefined) {
                symbols.set(name, {
                    uri: targetUri,
                    module: imp.module,
                    declaration,
                });
                continue;
            }
            const variable = findVariableDefinitionInTree(ast, name);
            if (variable !== undefined) {
                symbols.set(name, {
                    uri: targetUri,
                    module: imp.module,
                    variable,
                });
            }
        }
    }
    return symbols;
}

/**
 * Create a resolver that finds the definition of a symbol imported from a
 * library module, reading the library files from disk.
 *
 * @param {LibraryResolverOptions} options
 * @returns {(
 *     uri: string,
 *     root: import('scarpet-parser').Node,
 *     name: string,
 * ) => Promise<LibraryResolution | undefined>}
 */
export function createLibraryResolver({getWorkspaceFolderPaths, loadAst}) {
    /**
     * @param {string} sourceUri
     * @param {import('scarpet-parser').Node} sourceRoot
     * @param {string} name
     * @returns {Promise<LibraryResolution | undefined>}
     */
    return async function resolveImportedSymbol(sourceUri, sourceRoot, name) {
        const imports = findImports(sourceRoot, name);
        if (imports.length === 0) return undefined;
        const searchDirs = getSearchDirectories(
            sourceUri,
            getWorkspaceFolderPaths,
        );
        for (const imp of imports) {
            const filePath = await findModuleFileInDirectories(
                searchDirs,
                imp.module,
            );
            if (filePath === undefined) continue;
            const targetUri = pathToFileURL(filePath).href;
            if (targetUri === sourceUri) continue;
            const ast = await loadAst(targetUri);
            if (ast === undefined) continue;
            const declaration = findFunctionDeclarationInTree(ast, name);
            if (declaration !== undefined) {
                return {uri: targetUri, module: imp.module, declaration};
            }
            const variable = findVariableDefinitionInTree(ast, name);
            if (variable !== undefined) {
                return {uri: targetUri, module: imp.module, variable};
            }
        }
        return undefined;
    };
}
