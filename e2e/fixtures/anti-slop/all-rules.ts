type User = { id: string };
type Handler = () => void;
type UserId = string & { readonly userId: unique symbol };

declare const input: unknown;
declare const operation: (...args: unknown[]) => unknown;
declare const owner: object;
declare const args: unknown[];
declare const key: string;
declare const startHandler: Handler;
declare const value: string;

const chained = input as object as User;
const options = { ...(value ? { value } : {}) };
const handlers: Record<string, Handler> = { start: startHandler };
vi.mock('./store');
function save(record: object) {
  return record;
}
Reflect.apply(operation, owner, args);
Reflect.get(owner, key);
if (typeof input === 'string') console.log(input);
interface UserShape {
  id: string;
}
function handle(payload: unknown) {
  return payload;
}
function loadUser(): unknown {
  return input;
}
type ExternalValue = unknown;
type Metadata = Record<string, unknown>;
declare const loaded: User;
const stored: unknown = loaded;
const restored = stored as User;
const userId = value as UserId;

void [
  chained,
  options,
  handlers,
  save,
  handle,
  loadUser,
  restored,
  userId,
];
