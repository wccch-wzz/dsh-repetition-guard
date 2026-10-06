# `dsh-repetition-suppressor`

English | [中文](README.zh.md)

Function plugin that suppresses degenerate repetition in streaming model output — the `ok ok ok ok...` / `好的，马上 好的，马上...` collapse that reasoning models fall into when logits are reinforced by their own repeated context. It wraps every streaming model call at the `llm/stream` waterfall, matches by model glob rather than by provider, and when suppression exceeds a configured budget it emits an `error` finish that the agent loop converts into a retry, so the task continues instead of being cut off.

The plugin never rewrites the request. A loop-built request is deep-frozen — its content is a pure function of the session log — so listeners may read it but not mutate it, and a plugin that tries to adjust `temperature` or a penalty field on that object throws. Suppression is therefore applied to the returned `AsyncIterable<StreamChunk>`, not to the call parameters.

## How it works

### Two defenses, neither redundant

**Delta suppression.** A sliding tail window is scanned for a repeating unit. On a hit the plugin enters a squelch state and stops forwarding deltas for the duration of the loop.

**Whole-text block-end rewrite.** `@deepseek-ai/dsh-llm`'s assembler marks the `block-end` chunk as authoritative — `assemble()` returns its carried block and ignores everything the deltas accumulated:

```ts
/** Set by `block-end` — authoritative, and freezes the partial. */
block?: ContentBlock
```

Adapters emit it for both text and reasoning blocks, carrying the complete text. **Dropping deltas without rewriting `block-end` suppresses nothing** — the authoritative block restores the full loop. The plugin therefore runs a whole-text cycle strip over the block and yields a rewritten `block-end` preserving the original `block.type`, which the stream invariant checks against the `block-start` declaration.

### Trigger rule

Both paths share one predicate.

1. The candidate text must reach `minRunChars` (default 120).
2. Periods `p` from 1 through `min(maxPeriod, length/2)` are tried.
3. The tail `p` characters form the unit; **a unit containing no letter or digit is skipped** — this is why `-----` and `}}}}}` never trigger.
4. The count of consecutive exact matches `reps` is measured.
5. A hit requires **`reps >= minRepeats` and `reps * p >= minRunChars`**.

The second condition makes the two thresholds a single length floor: `reps * p` is the total repeated run. `ok ` needs 40 repetitions, `好的，马上 ` needs 20, a single character needs 120. Normal emphasis such as `非常非常非常重要` (period 2, three repetitions, six characters) stays far below.

The delta path evaluates this every `checkEvery` (48) accumulated characters against a `window` (1024) tail; the block-end path scans the whole text from offset 0.

### Handling

On the delta path a hit enters squelch, and each subsequent delta is counted and **not forwarded** — the UI does not flood and the text never enters the session log. The state exits once `escapeChars` (256) characters of non-repeating content accumulate, meaning the model recovered on its own.

When the suppressed volume reaches `hardStopChars`, the plugin acts according to `hardStopMode`:

- **`retry`** (default) — yields `{ type: 'finish', reason: { kind: 'error', failure: { code: 'REPETITION_LOOP' } } }`. The agent loop dispatches `agent/request-error` for an `error` finish, and this plugin answers `{ kind: 'retry' }`, so the loop's `while (true)` rebuilds the request and generates again.
- **`stop`** — yields `{ kind: 'stop' }`, ending the task silently. Kept for comparison; this is the pre-v4 behavior.
- **`off`** — never trips; suppression only.

Retries are counted per `agentId:turn:step` and capped by `maxLoopRetries` (default 2), after which the default outcome applies and the request fails. A loop that is structurally guaranteed — the model was explicitly asked to repeat — exhausts the cap and fails; a transient loop recovers.

Chunks other than `reasoning-delta`, `text-delta`, `block-start` and `block-end` are forwarded untouched, including `usage`, `finish` and `tool-call-delta`. Any exception inside the detection path degrades that single stream to pass-through and is counted; an exception in the gate itself passes the call through rather than blocking it.

## Configuration

```yaml
- insert:
    - id: repetition-guard
      name: 'dsh-repetition-suppressor'
      config:
        models: ['*']
        minRepeats: 6
        minRunChars: 120
        maxPeriod: 32
        hardStopMode: 'retry'
        maxLoopRetries: 2
        hardStopChars: 6000
```

| Key | Default | Meaning |
|---|---|---|
| `models` | `['*']` | Model glob; `['*flash*']` narrows it |
| `providers` | `['*']` | Provider glob |
| `guardAuxiliary` | `false` | Also guard compaction / session-title calls |
| `reasoning` / `text` | `true` | Which delta channels are guarded |
| `minRepeats` / `minRunChars` | `6` / `120` | Hit thresholds |
| `maxPeriod` | `32` | Largest period considered, in characters |
| `window` / `checkEvery` | `1024` / `48` | Delta scan window and cadence |
| `escapeChars` | `256` | New content needed to leave squelch |
| `hardStop` / `hardStopMode` | `true` / `'retry'` | Whether and how to trip |
| `hardStopChars` | `6000` | Suppressed volume that trips |
| `maxLoopRetries` | `2` | Retries per turn/step before failing |
| `maxScanChars` | `200000` | Block-end scan ceiling; above it the tail check is used |

## Model Experience

### What the model sees

Nothing about the suppression. The model produced the loop; the plugin dropped it downstream. The rewritten `block-end` means the durable assistant message carries the stripped text, so a later turn reads a compressed version of its own output rather than the full repetition.

A retry is likewise invisible. The loop rebuilds the same request from durable surface history, and the failed attempt left no `assistant/message` — failed chunks are recorded for replay but never become derived messages — so the retry starts from an uncontaminated history.

### Token effect

Suppression alone does **not** stop generation: the model keeps producing, and output tokens for the suppressed span are still billed. What is saved is **context**: the suppressed text never enters the session log, so it is not re-sent on every subsequent request.

Generation tokens are saved only when the plugin trips. Tripping `break`s out of the stream, which calls the upstream generator's `return()` and lets the adapter abort the HTTP request.

A retry is a new provider request and repeats input-token billing for the reconstructed prefix. `maxLoopRetries` bounds that cost.

### KV Cache effect

Suppression does not alter any request, so cache identity is untouched. A retry reconstructs a request preserving the prior prefix and is eligible for provider cache reuse under that provider's rules, exactly as `dsh-llm-retry` describes for its own retries.

## Known Limitations

- **Near-periodic loops are missed** — the match is exact, so a unit that drifts (`ok ok 好的 ok ok 好的`) fails the comparison. Deliberately so: fuzzy matching would need a tolerance that trades this miss against false positives on legitimate prose.
- **Periods beyond `maxPeriod` are missed** — a model repeating a 200-character reasoning paragraph in full is not detected.
- **Runs under `minRunChars` do not trigger** — a repetition shorter than the floor is treated as ordinary expression.
- **Suppression is not termination** — except when tripping, the model keeps generating and the generation tokens are still billed.
- **A retry discards the attempt** — content produced before the loop in the failed attempt is lost. A looping response is usually low-value, but this is a real cost.
- **Structurally guaranteed loops are unrecoverable** — retries cannot fix a loop the prompt demands; the cap is reached and the request fails by design.
- **`hardStopChars` governs the tradeoff** — a lower value trips earlier and saves more generation tokens at the cost of more retries.

## Installation

```sh
dsh plugin --profile web add dsh-repetition-suppressor
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory and reconciles `dsh.profile.bundles` once pnpm exits, so no manifest editing is needed. Restart dsh to load the bundle. Substitute your own profile name for `web` if you run a different one.

The same code straight from the repository, if you prefer an unpinned source:

```sh
dsh plugin --profile web add https://github.com/wccch-wzz/dsh-repetition-guard/archive/refs/heads/main.tar.gz
```

Restart dsh to load the bundle. Substitute your own profile name for `web` if you run a different one.

Removal is the mirror image:

```sh
dsh plugin --profile web remove dsh-repetition-suppressor
```

**Under proot, or any container that maps hard links to symlinks, pnpm's store cannot link and the install aborts** with `failed to import ... No such file or directory`. The tarball is unpacked before that step, so the plugin files land correctly and only the manifest update is lost — finish by hand: confirm the unpacked directory sits in the profile's `node_modules/`, then declare it in both the `dependencies` map and `dsh.profile.bundles`.

```json
{
  "dependencies": {
    "dsh-repetition-suppressor": "file:./node_modules/dsh-repetition-suppressor"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-repetition-suppressor"]
    }
  }
}
```

`examples/dynamic-plugin.host.js` is an equivalent dynamic Cordis plugin that activates in-process without a restart, at the cost of disappearing with the process.

## Verification

```sh
node tests/guard-test.mjs        # 29 assertions: predicate boundaries, false-positive guards, performance
node tests/integration-test.mjs  # 26 assertions: loads the real module, mocks a Cordis ctx
```

Runtime counters against a live `deepseek-v4.1-flash` route speaking `openai-completions`:

```
guardedCalls: 8     loopTrips: 8     recoveries: 5     detectorErrors: 0
hardStops: 3        hardStopsRetry: 3    hardStopsStop: 0
retries: 2          retriesExhausted: 1
suppressedChars: 19643
cleanedBlocks: 2
```

`hardStopsStop: 0` records that no trip ended a task silently. `cleanedBlocks: 2` records that the authoritative block-end path fired on real token streams, not only in tests.

## Version History

**v1 → v2.** The first version ran the tail check against `block-end`. When a loop was followed by ordinary content the tail was no longer periodic, the check missed, and the authoritative block restored everything that had been suppressed. Measured: deltas forwarded 140 of 510 characters, assembled message still 510. Replaced with the whole-text cycle strip.

**v2 → v3.** `detectCycle` returned `{period, reps, start, chars}` without a `unit` field, while the trip log read `hit.unit.slice(0, 24)`. Argument evaluation precedes the callee's own `try`, so the log's guard never applied: the first genuine detection threw, set the stream-wide bypass flag, and **disabled suppression at exactly the moment it was needed**. The unit test missed it because it exercised a hand-copied algorithm rather than the shipped module; only the integration test that imports the real file caught it.

**v3 → v4.** Tripping emitted `{kind: 'stop'}` to avoid the retry machinery, which left no recovery path — measured, a subagent's output was cut at 147 characters and its next step never ran. Now an `error` finish with a private code drives the retry, and `maxLoopRetries` bounds it.

## License

MIT
