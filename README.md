# UHC Bedrock — Minecraft UHC System

A complete **Ultra Hardcore (UHC)** match system for **Minecraft Bedrock** servers,
built as a modular behavior-pack script pack with an Arabic-first experience,
anti-cheat and performance tooling, and a Python companion bot.

## Features

- **Match flow** — world border control (`border.js`), end-game lock (`endlock.js`),
  respawn/rejoin handling (`respawn.js`, `rejoin.js`), grave return (`graveback.js`)
  and planned game phases (`plan.js`, `main.js`, `config.js`).
- **Anti-cheat** — movement/combat checks in `anticheat.js`, backed by `net.js`
  and shared state (`state.js`, `util.js`).
- **Performance** — `antilag.js` and `perf.js` keep large matches playable;
  `lagprobe.sh` profiles the host from the shell.
- **Arabic support** — full Arabic strings and RTL-aware messages in `arabic.js`.
- **Server bridge** — `bridge.js` links the in-game pack with the Python bot
  (`bot.py`) for state sync and out-of-game control.

## Layout

| File | Role |
|---|---|
| `main.js` / `plan.js` / `config.js` | Match engine, phases, configuration |
| `anticheat.js` / `net.js` / `state.js` | Cheat checks, networking, shared state |
| `border.js` / `endlock.js` | Border shrink and end-game rules |
| `antilag.js` / `perf.js` | Lag control and performance monitoring |
| `arabic.js` | Arabic localization |
| `bridge.js` / `bot.py` | Server bridge and companion bot |
| `manifest.json` | Behavior pack manifest |
| `MANIFEST.txt` | SHA-256 manifest of the shipped scripts |

## Setup

1. Copy the pack into your Bedrock dedicated server `behavior_packs` folder.
2. Enable it in `world_behavior_packs.json` and restart the world.
3. Adjust match settings in `config.js`.
4. (Optional) Run the companion bot with Python 3 and `requirements.txt`.

## License

MIT — see `LICENSE`.
