import { config } from './config.js';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, stream, args) {
  if ((LEVELS[level] ?? 99) > threshold) return;
  const stamp = new Date().toISOString();
  stream(`${stamp} ${level.toUpperCase().padEnd(5)}`, ...args);
}

export const log = {
  error: (...a) => emit('error', console.error, a),
  warn: (...a) => emit('warn', console.warn, a),
  info: (...a) => emit('info', console.log, a),
  debug: (...a) => emit('debug', console.log, a),
};
