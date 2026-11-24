// Early-spike rider: a pump.fun paper-trading bot for agent-fun/replay/v2.
// The strategy lives in strategy.ts; the wire shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
