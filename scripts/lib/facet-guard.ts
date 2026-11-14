import ts from 'typescript';

// Paths are relative to viewer/src: a nested panel.ts is not an exception.
export const FACET_READERS = ['spec-adapter.ts', 'panel.ts'] as const;

function isFacetKey(node: ts.Node): boolean {
    return (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'facets';
}

// Syntax only: opaque object spread/rest is allowed; explicit facet selection or repacking is not.
// Computed identifiers are dynamic keys, even when their variable happens to be named `facets`.
function isLiteralFacetKey(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return isLiteralFacetKey(node.expression);
    return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'facets';
}

function selectsFacets(node: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'facets';
    if (ts.isElementAccessExpression(node)) return isLiteralFacetKey(node.argumentExpression);
    if (ts.isBindingElement(node)) {
        if (node.dotDotDotToken || !ts.isObjectBindingPattern(node.parent)) return false;
        const key = node.propertyName ?? node.name;
        return ts.isComputedPropertyName(key) ? isLiteralFacetKey(key.expression) : isFacetKey(key);
    }
    // Includes assignment destructuring ({ facets: target } = el) and explicit object forwarding.
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        return ts.isComputedPropertyName(node.name) ? isLiteralFacetKey(node.name.expression) : isFacetKey(node.name);
    }
    return false;
}

/** Return one-based violation lines, retaining separate occurrences on the same line. */
export function facetReadLines(file: string, source: string): number[] {
    if (FACET_READERS.some((reader) => reader === file)) return [];
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines: number[] = [];
    const visit = (node: ts.Node): void => {
        if (selectsFacets(node)) lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return lines;
}
