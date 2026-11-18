import type { ESTree } from "#oxlint-plugins";

import {
	createExpansionBudget,
	createTypeAliasEnvironment,
	hasVisibleTypeBinding,
	isExpansionBudgetSpent,
	isTopLevelTypeBinding,
	spendExpansion,
	visibleTypeAlias,
	type ExpansionBudget,
	type TypeAliasEnvironment as LexicalTypeAliasEnvironment,
} from "./type-alias-resolution.ts";

const BUILT_INS = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

type TypeAliasEnvironment = ReadonlyMap<string, ResolvedType>;
/** The aliases being expanded, innermost first; extending it shares the outer list. */
type ResolvingAliases = {
	readonly alias: ESTree.TSTypeAliasDeclaration;
	readonly outer: ResolvingAliases;
} | null;

/** A type with the type-parameter bindings and alias expansions active where it was written. */
type ResolvedType = {
	readonly type: ESTree.TSType;
	readonly substitutions: TypeAliasEnvironment;
	readonly resolvingAliases: ResolvingAliases;
};

export type UnsafeDictionary = {
	readonly kind: "unsafe-dictionary";
	readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

export type WideningTargetKind =
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

export type WideningTarget = {
	readonly kind: WideningTargetKind;
};

/** A type that expands past the alias-expansion budget; callers must not report on it. */
export type Undecided = "undecided";

export type TypeEnvironment = {
	readonly interfaces: ReadonlyMap<string, readonly ESTree.TSInterfaceDeclaration[]>;
	readonly typeAliases: LexicalTypeAliasEnvironment;
};

type UnsafeValue = UnsafeDictionary["unsafeValue"];

/** Per-file results for parameterless aliases, recorded only from walks that expanded every alias. */
type AliasMemo = {
	readonly dictionaryValues: Map<ESTree.TSTypeAliasDeclaration, readonly ResolvedType[]>;
	readonly unsafeValues: Map<ESTree.TSTypeAliasDeclaration, UnsafeValue | null>;
};

/** One bounded classification: its shared expansion budget and each resumed binding's result. */
type Walk = {
	readonly budget: ExpansionBudget;
	readonly environment: TypeEnvironment;
	readonly aliases: AliasMemo;
	readonly broadKeys: Map<ResolvedType, boolean>;
	readonly unsafeValues: Map<ResolvedType, UnsafeValue | null>;
	/** Aliases left unexpanded, by recursion or the spent budget; a result under one is partial. */
	cutAliases: number;
};

const aliasMemos = new WeakMap<TypeEnvironment, AliasMemo>();

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

export function createTypeEnvironment(
	program: ESTree.Program,
	visitorKeys: Readonly<Record<string, readonly string[]>>,
): TypeEnvironment {
	const interfaces = new Map<string, ESTree.TSInterfaceDeclaration[]>();

	for (const statement of program.body) {
		const declaration = declaredStatement(statement);
		if (declaration?.type !== "TSInterfaceDeclaration") continue;
		const declarations = interfaces.get(declaration.id.name) ?? [];
		declarations.push(declaration);
		interfaces.set(declaration.id.name, declarations);
	}

	return {
		interfaces,
		typeAliases: createTypeAliasEnvironment(program, visitorKeys),
	};
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(
	name: string,
	use: ESTree.Node,
	environment: TypeEnvironment,
): boolean {
	return (
		BUILT_INS.has(name) &&
		!hasVisibleTypeBinding(name, use, environment.typeAliases)
	);
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
	let current = type;
	while (
		current.type === "TSParenthesizedType" ||
		(current.type === "TSTypeOperator" && current.operator === "readonly")
	) {
		current = current.typeAnnotation;
	}
	return current;
}

function isNeverType(type: ESTree.TSType): boolean {
	return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
	return (
		member.type === "TSPropertySignature" &&
		member.optional === true &&
		member.typeAnnotation !== null &&
		member.typeAnnotation !== undefined &&
		isNeverType(member.typeAnnotation.typeAnnotation)
	);
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
	return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
	if (declarations.length !== 1) return false;
	const [type] = declarations;
	return (
		type !== undefined &&
		type.extends.length === 0 &&
		(type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
	);
}

function fileAliasMemo(environment: TypeEnvironment): AliasMemo {
	const cached = aliasMemos.get(environment);
	if (cached !== undefined) return cached;
	const memo = { dictionaryValues: new Map(), unsafeValues: new Map() };
	aliasMemos.set(environment, memo);
	return memo;
}

function createWalk(environment: TypeEnvironment): Walk {
	return {
		budget: createExpansionBudget(),
		environment,
		aliases: fileAliasMemo(environment),
		broadKeys: new Map(),
		unsafeValues: new Map(),
		cutAliases: 0,
	};
}

function isResolving(
	resolvingAliases: ResolvingAliases,
	alias: ESTree.TSTypeAliasDeclaration,
): boolean {
	for (let current = resolvingAliases; current !== null; current = current.outer) {
		if (current.alias === alias) return true;
	}
	return false;
}

/** A negative answer from a walk that left aliases unexpanded is undecided, not safe. */
function decided<T>(walk: Walk, result: T | null): T | Undecided | null {
	return result === null && isExpansionBudgetSpent(walk.budget) ? "undecided" : result;
}

/** A resumed binding's result depends only on the binding, so each resolves once per walk. */
function resumeOnce<T>(
	memo: Map<ResolvedType, T>,
	binding: ResolvedType,
	resolve: () => T,
): T {
	const cached = memo.get(binding);
	if (cached !== undefined) return cached;
	const result = resolve();
	memo.set(binding, result);
	return result;
}

/** Bind an alias argument in the context where it was written; a bare parameter reuses its binding. */
function boundArgument(
	type: ESTree.TSType,
	written: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): ResolvedType {
	const unwrapped = unwrapTransparentType(type);
	const name = unwrapped.type === "TSTypeReference" ? typeReferenceName(unwrapped) : null;
	return (
		(name === null ? undefined : written.get(name)) ?? {
			type,
			substitutions: written,
			resolvingAliases,
		}
	);
}

function aliasSubstitution(
	alias: ESTree.TSTypeAliasDeclaration,
	type: ESTree.TSTypeReference,
	base: TypeAliasEnvironment,
	baseResolving: ResolvingAliases,
	aliasResolving: ResolvingAliases,
): TypeAliasEnvironment | null {
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const next = new Map<string, ResolvedType>();
	for (const [index, parameter] of parameters.entries()) {
		const explicitArgument = arguments_[index];
		const argument = explicitArgument ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		// A default sees only the parameters declared before it, so `<T = T>` cannot bind to itself.
		next.set(
			parameter.name.name,
			explicitArgument === undefined
				? boundArgument(argument, new Map(next), aliasResolving)
				: boundArgument(argument, base, baseResolving),
		);
	}
	return next;
}

/** Expand an alias that is not already being expanded, binding its arguments. */
function expandVisibleAlias(
	walk: Walk,
	alias: ESTree.TSTypeAliasDeclaration,
	reference: ESTree.TSTypeReference,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): ResolvedType | null {
	if (isResolving(resolvingAliases, alias) || !spendExpansion(walk.budget)) {
		walk.cutAliases += 1;
		return null;
	}
	const nextResolving = { alias, outer: resolvingAliases };
	const nextSubstitutions = aliasSubstitution(
		alias,
		reference,
		substitutions,
		resolvingAliases,
		nextResolving,
	);
	return nextSubstitutions === null
		? null
		: { type: alias.typeAnnotation, substitutions: nextSubstitutions, resolvingAliases: nextResolving };
}

function expandAlias(
	walk: Walk,
	reference: ESTree.TSTypeReference,
	name: string,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): ResolvedType | null {
	const alias = visibleTypeAlias(name, reference, walk.environment.typeAliases);
	return alias === null
		? null
		: expandVisibleAlias(walk, alias, reference, substitutions, resolvingAliases);
}

/** A parameterless alias binds nothing, so its body classifies the same at every bare reference. */
function sharedAlias(
	alias: ESTree.TSTypeAliasDeclaration,
	reference: ESTree.TSTypeReference,
	resolvingAliases: ResolvingAliases,
): ESTree.TSTypeAliasDeclaration | null {
	return alias.typeParameters?.params.length ||
		reference.typeArguments?.params.length ||
		isResolving(resolvingAliases, alias)
		? null
		: alias;
}

/** Keep a shared alias's result for the file only when its walk left no alias unexpanded. */
function remember<T>(
	walk: Walk,
	memo: Map<ESTree.TSTypeAliasDeclaration, T>,
	alias: ESTree.TSTypeAliasDeclaration | null,
	cutAliases: number,
	result: T,
): T {
	if (alias !== null && walk.cutAliases === cutAliases) memo.set(alias, result);
	return result;
}

function unsafeDirectValue(
	walk: Walk,
	type: ESTree.TSType,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): UnsafeValue | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return "unknown";
	if (unwrapped.type === "TSAnyKeyword") return "any";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
		return "empty-object";
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some(
			(member) => unsafeDirectValue(walk, member, substitutions, resolvingAliases) !== null,
		)
			? "union"
			: null;
	}
	if (unwrapped.type === "TSIntersectionType") {
		const unsafeMembers = unwrapped.types.map((member) =>
			unsafeDirectValue(walk, member, substitutions, resolvingAliases),
		);
		if (unsafeMembers.includes("any")) return "any";
		return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
			? unsafeMembers[0]
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: unsafeDirectValue(walk, wrapped, substitutions, resolvingAliases);
	}
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return resumeOnce(walk.unsafeValues, substitution, () =>
			unsafeDirectValue(
				walk,
				substitution.type,
				substitution.substitutions,
				substitution.resolvingAliases,
			),
		);
	}
	const interfaceDeclarations = walk.environment.interfaces.get(name);
	if (
		interfaceDeclarations !== undefined &&
		isTopLevelTypeBinding(name, unwrapped, walk.environment.typeAliases)
	) {
		return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
	}
	const alias = visibleTypeAlias(name, unwrapped, walk.environment.typeAliases);
	if (alias === null) return null;
	const shared = sharedAlias(alias, unwrapped, resolvingAliases);
	const cached = shared === null ? undefined : walk.aliases.unsafeValues.get(shared);
	if (cached !== undefined) return cached;
	const cutAliases = walk.cutAliases;
	const body = expandVisibleAlias(walk, alias, unwrapped, substitutions, resolvingAliases);
	if (body === null) return null;
	const result = unsafeDirectValue(walk, body.type, body.substitutions, body.resolvingAliases);
	return remember(walk, walk.aliases.unsafeValues, shared, cutAliases, result);
}

/** A mapped type's key binder shadows any outer binding of its name inside the value type. */
function withoutBinding(substitutions: TypeAliasEnvironment, name: string): TypeAliasEnvironment {
	if (!substitutions.has(name)) return substitutions;
	const next = new Map(substitutions);
	next.delete(name);
	return next;
}

function dictionaryValueTypes(
	walk: Walk,
	type: ESTree.TSType,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): readonly ResolvedType[] {
	const unwrapped = unwrapTransparentType(type);

	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.flatMap((member): readonly ResolvedType[] =>
			member.type === "TSIndexSignature" && member.typeAnnotation !== null
				? [{ type: member.typeAnnotation.typeAnnotation, substitutions, resolvingAliases }]
				: [],
		);
	}

	if (unwrapped.type === "TSMappedType") {
		return unwrapped.typeAnnotation === null
			? []
			: [
					{
						type: unwrapped.typeAnnotation,
						substitutions: withoutBinding(substitutions, unwrapped.key.name),
						resolvingAliases,
					},
				];
	}

	if (unwrapped.type !== "TSTypeReference") return [];
	const name = typeReferenceName(unwrapped);
	if (name === null) return [];

	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return dictionaryValueTypes(
			walk,
			substitution.type,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
	}

	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? []
			: dictionaryValueTypes(walk, wrapped, substitutions, resolvingAliases);
	}

	if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
		const value = unwrapped.typeArguments?.params[1] ?? null;
		return value === null ? [] : [{ type: value, substitutions, resolvingAliases }];
	}

	if (
		(name === "Pick" || name === "Omit") &&
		isBuiltIn(name, unwrapped, walk.environment)
	) {
		const source = unwrapped.typeArguments?.params[0];
		return source === undefined
			? []
			: dictionaryValueTypes(walk, source, substitutions, resolvingAliases);
	}

	const alias = visibleTypeAlias(name, unwrapped, walk.environment.typeAliases);
	if (alias === null) return [];
	const shared = sharedAlias(alias, unwrapped, resolvingAliases);
	const cached = shared === null ? undefined : walk.aliases.dictionaryValues.get(shared);
	if (cached !== undefined) return cached;
	const cutAliases = walk.cutAliases;
	const body = expandVisibleAlias(walk, alias, unwrapped, substitutions, resolvingAliases);
	if (body === null) return [];
	const result = dictionaryValueTypes(walk, body.type, body.substitutions, body.resolvingAliases);
	return remember(walk, walk.aliases.dictionaryValues, shared, cutAliases, result);
}

function unsafeDictionary(walk: Walk, type: ESTree.TSType): UnsafeDictionary | null {
	for (const value of dictionaryValueTypes(walk, type, new Map(), null)) {
		const unsafeValue = unsafeDirectValue(
			walk,
			value.type,
			value.substitutions,
			value.resolvingAliases,
		);
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return null;
}

export function classifyUnsafeDictionaryValue(
	valueType: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | Undecided | null {
	const walk = createWalk(environment);
	const unsafeValue = unsafeDirectValue(walk, valueType, new Map(), null);
	return decided(walk, unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue });
}

/** Classify a dictionary type; an alias past the expansion budget stays unexpanded and adds no finding. */
export function classifyUnsafeDictionary(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | null {
	return unsafeDictionary(createWalk(environment), type);
}

function wideningTarget(walk: Walk, type: ESTree.TSType): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: unwrapped.members.length > 0
				? { kind: "anonymous object" }
				: null;
	}
	if (unwrapped.type === "TSMappedType") return { kind: "open dictionary" };
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined ? null : wideningTarget(walk, wrapped);
	}
	if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
		return hasBroadRecordKey(walk, unwrapped, new Map(), null)
			? { kind: "open dictionary" }
			: null;
	}
	const expanded = expandAlias(walk, unwrapped, name, new Map(), null);
	if (expanded === null) return null;
	const resolved = classifyAliasBroadTarget(
		walk,
		expanded.type,
		expanded.substitutions,
		expanded.resolvingAliases,
	);
	// Only a generic alias binds parameters; it reads as a container of whatever it is given.
	if (expanded.substitutions.size === 0) return resolved;
	return resolved?.kind === "open dictionary" ? { kind: "generic container" } : null;
}

export function classifyWideningTarget(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): WideningTarget | Undecided | null {
	const walk = createWalk(environment);
	return decided(walk, wideningTarget(walk, type));
}

function hasBroadRecordKey(
	walk: Walk,
	type: ESTree.TSTypeReference,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): boolean {
	const key = type.typeArguments?.params[0];
	return key === undefined || isBroadMappedKey(walk, key, substitutions, resolvingAliases);
}

function isBroadMappedKey(
	walk: Walk,
	type: ESTree.TSType,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): boolean {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword" ||
		unwrapped.type === "TSAnyKeyword"
	) {
		return true;
	}
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some((member) =>
			isBroadMappedKey(walk, member, substitutions, resolvingAliases),
		);
	}
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return resumeOnce(walk.broadKeys, substitution, () =>
			isBroadMappedKey(
				walk,
				substitution.type,
				substitution.substitutions,
				substitution.resolvingAliases,
			),
		);
	}
	if (name === "PropertyKey" && isBuiltIn(name, unwrapped, walk.environment)) return true;
	const expanded = expandAlias(walk, unwrapped, name, substitutions, resolvingAliases);
	return (
		expanded !== null &&
		isBroadMappedKey(walk, expanded.type, expanded.substitutions, expanded.resolvingAliases)
	);
}

function classifyAliasBroadTarget(
	walk: Walk,
	type: ESTree.TSType,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return isBroadMappedKey(walk, unwrapped.constraint, substitutions, resolvingAliases)
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return classifyAliasBroadTarget(
			walk,
			substitution.type,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, unwrapped, walk.environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(walk, wrapped, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltIn(name, unwrapped, walk.environment)) {
		return hasBroadRecordKey(walk, unwrapped, substitutions, resolvingAliases)
			? { kind: "open dictionary" }
			: null;
	}
	const expanded = expandAlias(walk, unwrapped, name, substitutions, resolvingAliases);
	return expanded === null
		? null
		: classifyAliasBroadTarget(
				walk,
				expanded.type,
				expanded.substitutions,
				expanded.resolvingAliases,
			);
}

export function isPopulatedObjectExpression(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current.type === "ObjectExpression" && current.properties.length > 0;
}

export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression" ||
		current.type === "TSSatisfiesExpression"
	) {
		current = current.expression;
	}
	if (current.type === "ObjectExpression") return true;
	return (
		current.type === "ArrayExpression" ||
		current.type === "ArrowFunctionExpression" ||
		current.type === "ClassExpression" ||
		current.type === "FunctionExpression" ||
		current.type === "NewExpression" ||
		current.type === "Literal" ||
		current.type === "TemplateLiteral" ||
		current.type === "UnaryExpression"
	);
}
