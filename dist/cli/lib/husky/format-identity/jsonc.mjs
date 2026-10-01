// The formatter-identity gate's own jsonc reader, kept beside it so a change to it is a governed input.
// A comma that only comments and whitespace separate from a closing bracket (a trailing comma).
const TRAILING_COMMA_RE = /^\s*(?:\/\/[^\n\r]*[\n\r]\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/;
/** Parse jsonc: `//` and `/* *\/` comments and trailing commas dropped outside strings; null if invalid. */
export function parseJsonc(text) {
    let out = '';
    // A UTF-8 byte-order mark is not JSON; editors on some platforms write one.
    if (text.startsWith('\uFEFF'))
        text = text.slice(1);
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"')
                j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j;
        }
        else if (c === '/' && text[i + 1] === '/') {
            while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r')
                i++;
        }
        else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end < 0)
                return null;
            i = end + 1;
            out += ' ';
        }
        else if (c !== ',' || !TRAILING_COMMA_RE.test(text.slice(i + 1))) {
            out += c;
        }
    }
    try {
        return JSON.parse(out);
    }
    catch {
        return null;
    }
}
