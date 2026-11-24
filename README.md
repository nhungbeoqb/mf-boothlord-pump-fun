# mf-boothlord-pump-fun

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nhungbeoqb/mf-boothlord-pump-fun/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/nhungbeoqb/mf-boothlord-pump-fun/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Launch-ladder paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. A single TypeScript program (`main.ts`, Node 22) that paper-trades pump.fun bonding curves on a replay: it buys fresh launches once they show real traction (real SOL >= 3, at least 5 distinct buyers, creator bought <= 1 SOL and never sold, price up at most 30% from creation), takes one small probe per coin, banks half at +60%, and cuts losers with a trailing stop, a -20% hard stop, and a time limit.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (hello, batch, done); the harness drives it. No dependencies, no network, no secrets — everything it runs is in this repository.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
