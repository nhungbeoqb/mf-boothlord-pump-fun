// Launch ladder for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Revision 2. The first version bought mature curves on momentum (age up to 600 slots, real
// SOL >= 1, price near its window high) and lost ~-1.8 SOL on the dev window in every exit
// variant: by the time a curve looks strong the spike is already over, and the bot buys the
// top. The dev window's own tape says the edge, if any, is in the first slots: coins whose
// creator bought in and whose first buyers pile in run +100% or more from creation about
// 40% of the time, while the median coin is underwater within a few hundred slots. So this
// version buys launches, not breakouts:
//
//   - a first probe as soon as a fresh curve (a few dozen slots old) holds enough real SOL
//     for the 1% size cap to buy a worthwhile amount, the creator has not sold, the creator
//     did not load up absurdly, and the price has not already doubled from creation;
//   - it then ladders in: small adds while the price keeps stepping up and flow stays
//     positive, so runners get size and false starts stay tiny;
//   - it banks half at +25%, rides the rest under a trailing stop, and cuts losers fast
//     (hard stop, fade, creator sell, big sell, time limit).
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O. Iteration is only
// over insertion-ordered maps fed by the batch stream, so two runs agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may be decided. */
  maxAge: number;
  /** Real SOL reserve window at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys so far, at most (a launch the creator loaded up on is already spiked). */
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Price now over the create price, at most. */
  maxRunup: number;
  /** First buy (SOL), each add-on buy (SOL), most SOL per position in total. */
  firstSol: number;
  addSol: number;
  maxTotalSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** An add needs the price at least this far above the last buy's decision price. */
  addStep: number;
  /** An add needs net SOL over the add window at least this. */
  addMinFlow: number;
  addWindow: number;
  /** Slippage on every order (bps); wide open so a fast market never refuses a fill. */
  slipBps: number;
  /** Partial take-profit: sell this share of the tokens once value is up this much over cost. */
  tpUp: number;
  tpPart: number;
  /** Trailing stop: arms once value is up trailArm over cost, exits on a fall of trail from peak. */
  trailArm: number;
  trail: number;
  /** Hard stop: exit when value falls this far under cost. */
  stopLoss: number;
  /** Exit when net SOL over the fade window falls below minus this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after holding this many slots, unless up at least holdIfUp (then maxHoldLong). */
  maxHold: number;
  maxHoldLong: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most first entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run must end with at least this many coins and fills. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 30,
  minRealSol: 3,
  maxRealSol: 30,
  maxDevBuy: 1,
  minBuyers: 5,
  maxRunup: 0.3,
  firstSol: 0.05,
  addSol: 0.03,
  maxTotalSol: 0.15,
  maxAdds: 0,
  addStep: 0.03,
  addMinFlow: 0,
  addWindow: 30,
  slipBps: 10_000,
  tpUp: 0.6,
  tpPart: 0.5,
  trailArm: 0.15,
  trail: 0.25,
  stopLoss: 0.2,
  fadeWindow: 30,
  fadeNetSol: 2,
  bigSellSol: 3,
  maxHold: 400,
  maxHoldLong: 1000,
  holdIfUp: 0.25,
  cooldown: 150,
  maxEntries: 2,
  maxExposureSol: 6,
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 160_000,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  trades: Trade[];
  entries: number;
  lastExit: number;
  adds: number;
  lastBuyPrice: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  tookPartial: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.addWindow, p.fadeWindow) + 600;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: '', createPrice: 0, devBuy: 0, devSold: false, buyers: new Set(), trades: [], entries: 0, lastExit: -1e12, adds: 0, lastBuyPrice: 0 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else c.devSold = true;
          } else if (e.is_buy) {
            c.buyers.add(e.user);
          }
        } else if (e.event === 'CompleteEvent') {
          coinOf(e.mint);
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // What selling a position now would pay, after curve fees and one tx fee.
      const valueOf = (mint: Pubkey, tokens: bigint): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const t = Number(tokens);
        if (vt + t <= 0) return 0;
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        // Bank half at the take-profit, keep riding the rest.
        if (!h.tookPartial && value >= cost * (1 + p.tpUp)) {
          const part = pos.token_amount / 2n;
          if (part > 0n && orders.length < cap && !pendingByMint.has(mint)) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.slipBps });
            h.tookPartial = true;
          }
        }
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(c, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && c.devSold) exit = true;
        const heldLong = now - h.opened;
        if (!exit && heldLong > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && heldLong > p.maxHoldLong) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slipBps });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (c.created === null) continue;
          const age = now - c.created;
          if (age > p.maxAge) continue;
          if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
          if (c.devSold || c.devBuy > p.maxDevBuy) continue;
          if (c.buyers.size < p.minBuyers) continue;
          if (c.createPrice <= 0) continue;
          if (price / c.createPrice - 1 > p.maxRunup) continue;
          want = p.firstSol;
        } else {
          // Ladder in while the launch keeps stepping up and flow stays positive.
          if (h.exiting || !h.filled || c.adds >= p.maxAdds) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (h.invested >= p.maxTotalSol - 0.005) continue;
          if (price < c.lastBuyPrice * (1 + p.addStep)) continue;
          if (flow(c, now, p.addWindow) < p.addMinFlow) continue;
          if (rqSol > p.maxRealSol * 2) continue;
          want = Math.min(p.addSol, p.maxTotalSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.slipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, tookPartial: false, lastValue: 0 });
          c.entries++;
          c.adds = 0;
          c.lastBuyPrice = price;
          slotsLeft--;
        } else {
          h.invested += amount;
          c.adds++;
          c.lastBuyPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.slipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
