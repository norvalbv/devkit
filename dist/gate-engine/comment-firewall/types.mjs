export function parseJson(raw) {
    return JSON.parse(raw);
}
export function isJsonObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}
export function isJsonString(value) {
    return Object.prototype.toString.call(value) === '[object String]';
}
export function isJsonInteger(value) {
    return Number.isInteger(value);
}
