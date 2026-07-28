import { types as utilTypes } from 'node:util';
export function dataRecord(value) {
    try {
        if (value === null ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            utilTypes.isProxy(value))
            return null;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const record = {};
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== 'string')
                return null;
            const descriptor = descriptors[key];
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
                return null;
            Object.defineProperty(record, key, {
                configurable: true,
                enumerable: true,
                value: descriptor.value,
                writable: true,
            });
        }
        return record;
    }
    catch {
        return null;
    }
}
export function exactData(value, expected) {
    const actual = dataRecord(value);
    if (!actual)
        return false;
    const keys = Object.keys(expected);
    return (Object.keys(actual).length === keys.length &&
        keys.every((key) => Object.hasOwn(actual, key) && actual[key] === expected[key]));
}
