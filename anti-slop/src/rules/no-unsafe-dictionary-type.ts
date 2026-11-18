import { defineRule } from "@oxlint/plugins";

import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	createTypeEnvironment,
	type TypeEnvironment,
	type UnsafeDictionary,
} from "../shared/dictionary-types.ts";
import { visibleTypeAlias } from "../shared/type-alias-resolution.ts";

import type { ESTree } from "@oxlint/plugins";

const typeNodeKinds: ReadonlySet<string> = new Set([
	"JSDocNonNullableType",
	"JSDocNullableType",
	"JSDocUnknownType",
	"TSAnyKeyword",
	"TSArrayType",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSConditionalType",
	"TSConstructorType",
	"TSFunctionType",
	"TSImportType",
	"TSIndexedAccessType",
	"TSInferType",
	"TSIntersectionType",
	"TSIntrinsicKeyword",
	"TSLiteralType",
	"TSMappedType",
	"TSNamedTupleMember",
	"TSNeverKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSParenthesizedType",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSTemplateLiteralType",
	"TSThisType",
	"TSTupleType",
	"TSTypeLiteral",
	"TSTypeOperator",
	"TSTypePredicate",
	"TSTypeQuery",
	"TSTypeReference",
	"TSUndefinedKeyword",
	"TSUnionType",
	"TSUnknownKeyword",
	"TSVoidKeyword",
]);

function isTypeNode(node: ESTree.Node): node is ESTree.TSType {
	return typeNodeKinds.has(node.type);
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isInsideTypeAliasDeclaration(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSTypeAliasDeclaration") return true;
		current = current.parent;
	}
	return false;
}

/** Per-file memo of type results: each node, and each alias by declaration, classifies once. */
type FileState = {
	readonly environment: TypeEnvironment;
	readonly types: Map<ESTree.TSType, UnsafeDictionary | null>;
	readonly bareUses: Map<ESTree.TSTypeAliasDeclaration, UnsafeDictionary | null>;
	readonly declarationReports: Map<ESTree.TSTypeAliasDeclaration, boolean>;
};

function bareAlias(
	node: ESTree.Node,
	environment: TypeEnvironment,
): ESTree.TSTypeAliasDeclaration | null {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return null;
	const name = typeReferenceName(node);
	return name === null ? null : visibleTypeAlias(name, node, environment.typeAliases);
}

/** A bare alias use classifies exactly as its declaration with defaults applied. */
function classifyUncachedType(node: ESTree.TSType, state: FileState): UnsafeDictionary | null {
	const alias = bareAlias(node, state.environment);
	if (alias === null) return classifyUnsafeDictionary(node, state.environment);
	if (!state.bareUses.has(alias))
		state.bareUses.set(alias, classifyUnsafeDictionary(node, state.environment));
	return state.bareUses.get(alias) ?? null;
}

/** Each type node is classified for itself and again for every type node nested inside it. */
function classifyType(node: ESTree.TSType, state: FileState): UnsafeDictionary | null {
	const cached = state.types.get(node);
	if (cached !== undefined) return cached;
	const result = classifyUncachedType(node, state);
	state.types.set(node, result);
	return result;
}

/** Whether the alias body or one of its type-parameter defaults is itself reported. */
function aliasDeclarationReports(alias: ESTree.TSTypeAliasDeclaration, state: FileState): boolean {
	const cached = state.declarationReports.get(alias);
	if (cached !== undefined) return cached;
	const defaults = (alias.typeParameters?.params ?? []).map((parameter) => parameter.default);
	const reports = [alias.typeAnnotation, ...defaults].some(
		(type) => type != null && classifyType(type, state) !== null,
	);
	state.declarationReports.set(alias, reports);
	return reports;
}

function isPlainAliasConsumerUse(node: ESTree.TSType, state: FileState): boolean {
	const alias = bareAlias(node, state.environment);
	// The declaration already reports; a default unsafe only as a dictionary value reports here.
	return (
		alias !== null &&
		!isInsideTypeAliasDeclaration(node) &&
		aliasDeclarationReports(alias, state)
	);
}

function isInsideTypeParameterConstraint(node: ESTree.TSType): boolean {
	let child: ESTree.Node = node;
	let parent: ESTree.Node | null = child.parent;
	while (parent !== null && parent.type !== "Program") {
		if (parent.type === "TSTypeParameter" && parent.constraint === child) return true;
		child = parent;
		parent = child.parent;
	}
	return false;
}

function shouldReportType(node: ESTree.TSType, state: FileState): boolean {
	if (isInsideTypeParameterConstraint(node)) return false;
	if (isPlainAliasConsumerUse(node, state)) return false;
	if (classifyType(node, state) === null) return false;
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isTypeNode(current) && classifyType(current, state) !== null) return false;
		current = current.parent;
	}
	return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
		},
		messages: {
			unsafeDictionary:
				"This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
		},
	},
	createOnce(context) {
		let state: FileState | null = null;
		const report = (node: ESTree.Node, value: string) => {
			context.report({ node, messageId: "unsafeDictionary", data: { value } });
		};
		const reportIfUnsafe = (node: ESTree.TSType) => {
			if (state === null || !shouldReportType(node, state)) return;
			const unsafe = classifyType(node, state);
			if (unsafe === null) return;
			report(node, unsafe.unsafeValue);
		};

		return {
			Program(node) {
				state = {
					environment: createTypeEnvironment(node, context.sourceCode.visitorKeys),
					types: new Map(),
					bareUses: new Map(),
					declarationReports: new Map(),
				};
			},
			TSTypeReference: reportIfUnsafe,
			TSTypeLiteral: reportIfUnsafe,
			TSMappedType: reportIfUnsafe,
			TSIndexSignature(node) {
				if (
					state === null ||
					node.typeAnnotation === null ||
					node.parent.type === "TSTypeLiteral"
				)
					return;
				const unsafe = classifyUnsafeDictionaryValue(
					node.typeAnnotation.typeAnnotation,
					state.environment,
				);
				if (unsafe !== null && unsafe !== "undecided") report(node, unsafe.unsafeValue);
			},
		};
	},
});
