// Preloaded (`node --import`) into every node gate guard-deterministic spawns, so an uncaught throw
// or rejection exits CRASH_EXIT with its first line recorded, instead of Node's verdict-like exit 1.
import { crashExit } from './reason.mts';

process.on('uncaughtException', crashExit);
