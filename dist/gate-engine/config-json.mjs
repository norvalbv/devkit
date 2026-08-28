/** Parse a config snapshot into one named object contract; malformed input never weakens a gate. */
export function parseJsonObject(contents, label) {
    let parsed;
    try {
        parsed = JSON.parse(contents);
    }
    catch (error) {
        throw new Error(`${label} is not valid JSON: ${String(error)}`);
    }
    if (Object.prototype.toString.call(parsed) !== '[object Object]')
        throw new Error(`${label} must be a JSON object.`);
    // SAFETY: the object-tag check proves a non-null, non-array JSON object; callers provide the
    // named raw contract, and the config resolver validates every field before using it.
    return parsed;
}
