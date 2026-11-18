import { defineRule } from "#oxlint-plugins";

import {
	classifyUnsafeDictionaryValue,
	classifyWideningTarget,
	createTypeEnvironment,
	isKnownEvidenceExpression,
	type TypeEnvironment,
	type Undecided,
	type WideningTarget,
} from "../shared/dictionary-types.ts";
import {
	containsUnknownType,
	functionParameterBindingName,
	functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { resolveVariable } from "../shared/scope.ts";
import { hasSameTypeBindings, visibleTypeAlias } from "../shared/type-alias-resolution.ts";

import type { ESTree, SourceCode, Variable } from "#oxlint-plugins";

type FunctionExpression = ESTree.ArrowFunctionExpression | ESTree.Function;

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
		? definition.node
		: null;
}

const onlyInitializingWrites = new WeakMap<Variable, boolean>();

function hasOnlyInitializingWrites(variable: Variable): boolean {
	let result = onlyInitializingWrites.get(variable);
	if (result === undefined) {
		result = variable.references.every((reference) => reference.init || !reference.isWrite());
		onlyInitializingWrites.set(variable, result);
	}
	return result;
}

function isStableConstVariable(variable: Variable, declarator: ESTree.VariableDeclarator): boolean {
	return (
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		hasOnlyInitializingWrites(variable)
	);
}

/**
 * Whether a binding's initializer asserts a broad type, as `{} as Record<string, T>` does. An
 * undecided assertion counts too: it stops evidence at the source, so it can never cause a report.
 */
function hasBroadAssertionInitializer(
	initializer: ESTree.Expression,
	environment: TypeEnvironment,
): boolean {
	let current = initializer;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "TSSatisfiesExpression"
	) {
		current = current.expression;
	}
	return (
		(current.type === "TSAsExpression" || current.type === "TSTypeAssertion") &&
		classifyWideningTarget(current.typeAnnotation, environment) !== null
	);
}

function hasKnownEvidence(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	environment: TypeEnvironment,
	visitedVariables = new Set<Variable>(),
): boolean {
	if (isKnownEvidenceExpression(expression)) return true;
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	// A broad or undecided annotation or assertion on the source is judged at its own declaration.
	if (
		annotationTarget(variableTypeAnnotation(sourceCode, variable), environment) !== null ||
		hasBroadAssertionInitializer(declarator.init, environment)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return hasKnownEvidence(sourceCode, declarator.init, environment, visitedVariables);
}

function isFunctionExpression(node: ESTree.Node): node is FunctionExpression {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "TSDeclareFunction" ||
		node.type === "TSEmptyBodyFunctionExpression"
	);
}

function definedFunction(variable: Variable): FunctionExpression | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	if (definition === undefined) return null;
	if (definition.type === "FunctionName" && isFunctionExpression(definition.node)) {
		return definition.node;
	}
	if (definition.type !== "Variable" || definition.node.type !== "VariableDeclarator") {
		return null;
	}
	const initializer = definition.node.init;
	if (initializer === null) return null;
	const unwrappedInitializer = unwrapExpression(initializer);
	return isFunctionExpression(unwrappedInitializer) ? unwrappedInitializer : null;
}

/** The local function a call runs, if `accepts` it; the reassignment scan runs only after that check. */
function localFunctionForCall(
	sourceCode: SourceCode,
	callee: ESTree.Expression,
	accepts: (owner: FunctionExpression) => boolean,
): FunctionExpression | null {
	const unwrapped = unwrapExpression(callee);
	if (isFunctionExpression(unwrapped)) return accepts(unwrapped) ? unwrapped : null;
	if (unwrapped.type !== "Identifier") return null;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null) return null;
	const owner = definedFunction(variable);
	return owner !== null && accepts(owner) && hasOnlyInitializingWrites(variable) ? owner : null;
}

function hasReturnType(owner: FunctionExpression): boolean {
	return owner.returnType !== undefined && owner.returnType !== null;
}

function variableTypeAnnotation(
	sourceCode: SourceCode,
	variable: Variable,
): ESTree.TSTypeAnnotation | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	if (definition === undefined) return null;
	if (
		definition.type === "Variable" &&
		definition.node.type === "VariableDeclarator" &&
		definition.node.id.type === "Identifier"
	) {
		return definition.node.id.typeAnnotation ?? null;
	}
	if (definition.type !== "Parameter" || !isFunctionExpression(definition.node)) {
		return null;
	}
	const parameter = definition.node.params.find(
		(candidate) =>
			functionParameterBindingName(candidate, sourceCode) === variable.name,
	);
	return parameter === undefined ? null : (functionParameterTypeAnnotation(parameter) ?? null);
}

function hasInformativeType(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): boolean {
	// An undecided type is not known to be informative.
	return classifyUnsafeDictionaryValue(type, environment) === null;
}

function unwrapParenthesizedType(type: ESTree.TSType): ESTree.TSType {
	let current = type;
	while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
	return current;
}

function typeText(sourceCode: SourceCode, type: ESTree.TSType): string {
	// Drop whitespace between tokens but keep it inside string literal types, where it is the value.
	return sourceCode
		.getText(unwrapParenthesizedType(type))
		.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\s+/g, (_, literal?: string) => literal ?? "");
}

const literalTypeKeywords: Partial<Record<string, ESTree.TSType["type"]>> = {
	bigint: "TSBigIntKeyword",
	boolean: "TSBooleanKeyword",
	number: "TSNumberKeyword",
	string: "TSStringKeyword",
};

function literalTypeKeyword(type: ESTree.TSType): ESTree.TSType["type"] | null {
	if (type.type === "TSTemplateLiteralType") return "TSStringKeyword";
	if (type.type !== "TSLiteralType") return null;
	const literal = type.literal.type === "UnaryExpression" ? type.literal.argument : type.literal;
	if (literal.type === "TemplateLiteral") return "TSStringKeyword";
	return literal.type === "Literal" ? (literalTypeKeywords[typeof literal.value] ?? null) : null;
}

function isNullishType(type: ESTree.TSType): boolean {
	return type.type === "TSNullKeyword" || type.type === "TSUndefinedKeyword";
}

type PredicateCheck = {
	readonly environment: TypeEnvironment;
	readonly nonNull: boolean;
	readonly predicate: ESTree.TSType;
	readonly predicateText: string;
	readonly resolvedAliases: Map<ESTree.TSTypeAliasDeclaration, boolean>;
	readonly sourceCode: SourceCode;
};

/** Deeper alias chains count as narrowable: a missed report, never a false one. */
const maxPredicateAliasDepth = 64;

/** Whether every value of a declared type already satisfies the guard's predicate type. */
function typeSatisfiesPredicate(
	check: PredicateCheck,
	type: ESTree.TSType,
	resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): boolean {
	const current = unwrapParenthesizedType(type);
	if (
		typeText(check.sourceCode, current) === check.predicateText &&
		hasSameTypeBindings(current, check.predicate, check.environment.typeAliases)
	) {
		return true;
	}
	if (current.type === "TSUnionType") {
		return current.types.every(
			(member) =>
				(check.nonNull && isNullishType(member)) ||
				typeSatisfiesPredicate(check, member, resolvingAliases),
		);
	}
	const literalKeyword = literalTypeKeyword(current);
	if (literalKeyword !== null) return literalKeyword === unwrapParenthesizedType(check.predicate).type;
	if (
		current.type !== "TSTypeReference" ||
		current.typeName.type !== "Identifier" ||
		current.typeArguments
	) {
		return false;
	}
	const alias = visibleTypeAlias(current.typeName.name, current, check.environment.typeAliases);
	if (
		alias === null ||
		alias.typeParameters ||
		resolvingAliases.has(alias) ||
		resolvingAliases.size >= maxPredicateAliasDepth
	) {
		return false;
	}
	let satisfies = check.resolvedAliases.get(alias);
	if (satisfies === undefined) {
		satisfies = typeSatisfiesPredicate(
			check,
			alias.typeAnnotation,
			new Set(resolvingAliases).add(alias),
		);
		check.resolvedAliases.set(alias, satisfies);
	}
	return satisfies;
}

function declaredTypeMatchesPredicate(
	sourceCode: SourceCode,
	type: ESTree.TSType,
	predicate: ESTree.TSType | null,
	environment: TypeEnvironment,
	nonNull: boolean,
): boolean {
	if (predicate === null) return false;
	const check: PredicateCheck = {
		environment,
		nonNull,
		predicate,
		predicateText: typeText(sourceCode, predicate),
		resolvedAliases: new Map(),
		sourceCode,
	};
	return typeSatisfiesPredicate(check, type, new Set()) && hasInformativeType(type, environment);
}

function isOptionalParameterAnnotation(annotation: ESTree.TSTypeAnnotation): boolean {
	// Oxlint types `Identifier.optional` as `false`, but an optional parameter (`value?: T`) sets it.
	return annotation.parent.type === "Identifier" && Boolean(annotation.parent.optional);
}

/** `as const` keeps the asserted expression's own type, so the expression stays the evidence. */
function isConstType(type: ESTree.TSType): boolean {
	return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeName.name === "const";
}

/** Whether a guard call cannot narrow its argument: a known value, or a declared type the predicate already holds. */
function isRedundantGuardArgument(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	predicate: ESTree.TSType | null,
	environment: TypeEnvironment,
	nonNull = false,
	visitedVariables = new Set<Variable>(),
): boolean {
	if (
		expression.type === "ParenthesizedExpression" ||
		expression.type === "TSSatisfiesExpression" ||
		((expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") &&
			isConstType(expression.typeAnnotation))
	) {
		return isRedundantGuardArgument(
			sourceCode,
			expression.expression,
			predicate,
			environment,
			nonNull,
			visitedVariables,
		);
	}
	if (expression.type === "TSNonNullExpression") {
		return isRedundantGuardArgument(
			sourceCode,
			expression.expression,
			predicate,
			environment,
			true,
			visitedVariables,
		);
	}
	if (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") {
		return declaredTypeMatchesPredicate(
			sourceCode,
			expression.typeAnnotation,
			predicate,
			environment,
			nonNull,
		);
	}
	if (expression.type === "CallExpression") {
		const returnType = localFunctionForCall(sourceCode, expression.callee, hasReturnType)?.returnType
			?.typeAnnotation;
		return (
			returnType !== undefined &&
			declaredTypeMatchesPredicate(sourceCode, returnType, predicate, environment, nonNull)
		);
	}
	if (expression.type !== "Identifier") return isKnownEvidenceExpression(expression);
	const variable = resolveVariable(sourceCode, expression);
	if (variable === null || visitedVariables.has(variable)) return false;
	const annotation = variableTypeAnnotation(sourceCode, variable);
	if (annotation !== null) {
		return (
			(nonNull || !isOptionalParameterAnnotation(annotation)) &&
			declaredTypeMatchesPredicate(
				sourceCode,
				annotation.typeAnnotation,
				predicate,
				environment,
				nonNull,
			)
		);
	}
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return isRedundantGuardArgument(
		sourceCode,
		declarator.init,
		predicate,
		environment,
		nonNull,
		visitedVariables,
	);
}

/** The predicate type of a non-generic guard; a generic guard's predicate names its own type parameters. */
function guardPredicateType(owner: FunctionExpression): ESTree.TSType | null {
	const predicate = owner.returnType?.typeAnnotation;
	if (predicate?.type !== "TSTypePredicate" || (owner.typeParameters?.params.length ?? 0) > 0) {
		return null;
	}
	return predicate.typeAnnotation?.typeAnnotation ?? null;
}

function isTypePredicateFunction(owner: FunctionExpression): boolean {
	return owner.returnType?.typeAnnotation.type === "TSTypePredicate";
}

function typePredicateSubjectIndex(
	sourceCode: SourceCode,
	owner: FunctionExpression,
): number | null {
	const predicate = owner.returnType?.typeAnnotation;
	if (predicate?.type !== "TSTypePredicate" || predicate.parameterName.type !== "Identifier") {
		return null;
	}
	const predicateParameterName = predicate.parameterName.name;
	const index = owner.params.findIndex(
		(parameter) =>
			functionParameterBindingName(parameter, sourceCode) === predicateParameterName,
	);
	return index === -1 ? null : index;
}

function annotationTarget(
	annotation: ESTree.TSTypeAnnotation | null | undefined,
	environment: TypeEnvironment,
): WideningTarget | Undecided | null {
	return annotation === null || annotation === undefined
		? null
		: classifyWideningTarget(annotation.typeAnnotation, environment);
}

function enclosingFunction(node: ESTree.Node): FunctionExpression | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function sourceKeyName(sourceCode: SourceCode, key: ESTree.PropertyKey): string {
	if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return sourceCode.getText(key);
}

function functionName(sourceCode: SourceCode, owner: FunctionExpression | null): string {
	if (owner === null) return "anonymous function";
	if (owner.id !== null) return owner.id.name;
	const parent = owner.parent;
	if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return parent.id.name;
	if (parent.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
	return "anonymous function";
}

function isEmptyObjectExpression(expression: ESTree.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}

function isDictionaryAccumulatorTarget(destination: WideningTarget): boolean {
	return destination.kind === "open dictionary" || destination.kind === "generic container";
}

function hasParentAssertion(node: ESTree.Node): boolean {
	return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWideningRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
		},
		messages: {
			widening:
				"The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const reportFlow = (
			expression: ESTree.Expression,
			destination: WideningTarget | Undecided | null,
			subject: string,
		) => {
			if (destination === null || destination === "undecided" || environment === null) return;
			if (
				isDictionaryAccumulatorTarget(destination) &&
				isEmptyObjectExpression(expression)
			) {
				return;
			}
			if (!hasKnownEvidence(context.sourceCode, expression, environment)) return;
			context.report({
				node: expression,
				messageId: "widening",
				data: { subject, target: destination.kind },
			});
		};

		const targetFromAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined) =>
			environment === null ? null : annotationTarget(annotation, environment);

		return {
			Program(node) {
				environment = createTypeEnvironment(
					node,
					context.sourceCode.visitorKeys,
				);
			},
			VariableDeclarator(node) {
				if (node.init === null || node.id.type !== "Identifier") return;
				reportFlow(
					node.init,
					targetFromAnnotation(node.id.typeAnnotation),
					`binding \`${node.id.name}\``,
				);
			},
			PropertyDefinition(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AccessorProperty(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AssignmentExpression(node) {
				if (node.operator !== "=" || node.left.type !== "Identifier") return;
				const variable = resolveVariable(context.sourceCode, node.left);
				if (variable === null) return;
				const declarator = variableDeclarator(variable);
				if (declarator === null || declarator.id.type !== "Identifier") return;
				reportFlow(
					node.right,
					targetFromAnnotation(declarator.id.typeAnnotation),
					`binding \`${declarator.id.name}\``,
				);
			},
			CallExpression(node) {
				if (environment === null) return;
				const owner = localFunctionForCall(context.sourceCode, node.callee, isTypePredicateFunction);
				if (owner === null) return;
				const parameterIndex = typePredicateSubjectIndex(context.sourceCode, owner);
				if (parameterIndex === null) return;
				const parameter = owner.params[parameterIndex];
				const argument = node.arguments[parameterIndex];
				if (parameter === undefined || argument === undefined || argument.type === "SpreadElement") {
					return;
				}
				const parameterAnnotation = functionParameterTypeAnnotation(parameter);
				if (
					parameterAnnotation === null ||
					parameterAnnotation === undefined ||
					!containsUnknownType(parameterAnnotation.typeAnnotation)
				) {
					return;
				}
				if (
					!isRedundantGuardArgument(
						context.sourceCode,
						argument,
						guardPredicateType(owner),
						environment,
					)
				) {
					return;
				}
				context.report({
					node: argument,
					messageId: "widening",
					data: {
						subject: `argument for parameter \`${functionParameterBindingName(parameter, context.sourceCode)}\` of \`${functionName(context.sourceCode, owner)}\``,
						target: "unknown",
					},
				});
			},
			ReturnStatement(node) {
				if (node.argument === null) return;
				const owner = enclosingFunction(node);
				reportFlow(
					node.argument,
					targetFromAnnotation(owner?.returnType),
					`return value of \`${functionName(context.sourceCode, owner)}\``,
				);
			},
			ArrowFunctionExpression(node) {
				if (node.body.type === "BlockStatement") return;
				reportFlow(
					node.body,
					targetFromAnnotation(node.returnType),
					`return value of \`${functionName(context.sourceCode, node)}\``,
				);
			},
			TSAsExpression(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
			TSTypeAssertion(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
		};
	},
});
