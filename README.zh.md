# `dsh-repetition-guard`

[English](README.md) | 中文

功能插件，抑制流式模型输出中的退化性重复 —— 推理模型在自身重复上下文的强化下，输出坍缩成 `ok ok ok ok...` / `好的，马上 好的，马上...` 的那种现象。它包裹 `llm/stream` waterfall 上的每一次流式模型调用，按模型 glob 匹配而非按供应商匹配；当抑制量超过配置的预算时，它发出一个 `error` finish，由 agent loop 转成重试，任务得以继续而非被切断。

插件从不改写请求。loop 构建的请求是 deep-frozen 的 —— 其内容是会话日志的纯函数 —— 监听器可以读但不能改，试图调整该对象上的 `temperature` 或惩罚字段会直接抛异常。因此抑制施加在返回的 `AsyncIterable<StreamChunk>` 上，而不是调用参数上。

## 工作机制

### 两条防线，均非冗余

**delta 抑制。** 对滑动尾部窗口扫描重复单元，命中即进入抑制态，在循环持续期间不再转发 delta。

**block-end 全文本重写。** `@deepseek-ai/dsh-llm` 的组装器把 `block-end` 标记为 authoritative —— `assemble()` 返回它携带的 block，并忽略 delta 累积的一切：

```ts
/** Set by `block-end` — authoritative, and freezes the partial. */
block?: ContentBlock
```

适配器对 text 与 reasoning 两种 block 都会发出它，并携带完整文本。**只丢 delta 而不重写 `block-end`，等于没有抑制** —— authoritative 的 block 会把完整循环还原回来。因此插件对该 block 跑一次全文本周期清除，并 yield 一个重写后的 `block-end`，保留原 `block.type`；流不变量会拿它与 `block-start` 的声明做校验。

### 触发判据

两条路径共用同一套判据。

1. 候选文本必须达到 `minRunChars`（默认 120）。
2. 周期 `p` 从 1 试到 `min(maxPeriod, 长度/2)`。
3. 尾部 `p` 个字符构成单元；**不含字母或数字的单元被跳过** —— 这就是 `-----` 与 `}}}}}` 从不触发的原因。
4. 测量连续精确匹配的次数 `reps`。
5. 命中要求 **`reps >= minRepeats` 且 `reps * p >= minRunChars`**。

第二个条件把两个阈值合成一道长度下限：`reps * p` 即重复段的总长度。`ok ` 需要 40 次，`好的，马上 ` 需要 20 次，单字符需要 120 次。正常强调如 `非常非常非常重要`（周期 2、三次、六字符）远在阈值之下。

delta 路径每累积 `checkEvery`（48）字符对 `window`（1024）尾部求值一次；block-end 路径从偏移 0 起扫描全文。

### 处置

delta 路径命中即进入抑制态，此后每个 delta 只计数、**不转发** —— UI 不刷屏，文本也从不进入会话日志。当累积到 `escapeChars`（256）字符的非重复内容时退出抑制态，即模型自行恢复。

抑制量达到 `hardStopChars` 时，插件按 `hardStopMode` 行动：

- **`retry`**（默认）—— 发出 `{ type: 'finish', reason: { kind: 'error', failure: { code: 'REPETITION_LOOP' } } }`。agent loop 对 `error` finish 派发 `agent/request-error`，本插件应答 `{ kind: 'retry' }`，于是 loop 的 `while (true)` 重建请求并重新生成。
- **`stop`** —— 发出 `{ kind: 'stop' }`，静默结束任务。保留用于对照；这是 v4 之前的行为。
- **`off`** —— 从不熔断，只抑制。

重试按 `agentId:turn:step` 计数，由 `maxLoopRetries`（默认 2）封顶，超出后适用默认结局，请求失败。结构上必然发生的循环 —— 模型被明确要求重复 —— 会耗尽配额并失败；偶发循环则能恢复。

`reasoning-delta`、`text-delta`、`block-start`、`block-end` 之外的 chunk 原样转发，包括 `usage`、`finish` 与 `tool-call-delta`。检测路径内部的任何异常都会把该条流降级为透传并计数；门禁自身的异常则放行调用而非阻断它。

## 配置

```yaml
- insert:
    - id: repetition-guard
      name: 'dsh-repetition-guard'
      config:
        models: ['*']
        minRepeats: 6
        minRunChars: 120
        maxPeriod: 32
        hardStopMode: 'retry'
        maxLoopRetries: 2
        hardStopChars: 6000
```

| 键 | 默认 | 含义 |
|---|---|---|
| `models` | `['*']` | 模型 glob；`['*flash*']` 可收窄 |
| `providers` | `['*']` | provider glob |
| `guardAuxiliary` | `false` | 是否也守 compaction / session-title 调用 |
| `reasoning` / `text` | `true` | 守哪些 delta 通道 |
| `minRepeats` / `minRunChars` | `6` / `120` | 命中阈值 |
| `maxPeriod` | `32` | 考虑的最大周期（字符） |
| `window` / `checkEvery` | `1024` / `48` | delta 扫描窗口与频率 |
| `escapeChars` | `256` | 退出抑制态所需的新内容量 |
| `hardStop` / `hardStopMode` | `true` / `'retry'` | 是否熔断、如何熔断 |
| `hardStopChars` | `6000` | 触发熔断的抑制量 |
| `maxLoopRetries` | `2` | 每个 turn/step 失败前的重试次数 |
| `maxScanChars` | `200000` | block-end 扫描上限；超出则改用尾部检测 |

## 模型体验

### 模型看到什么

对抑制一无所知。循环是模型自己产生的，插件在下游丢弃了它。重写后的 `block-end` 意味着持久的 assistant 消息携带的是清除后的文本，因此后续轮次读到的是自己输出的压缩版本，而非完整重复。

重试同样不可见。loop 从持久化的表层历史重建同一个请求，而失败的那次尝试没有留下 `assistant/message` —— 失败的 chunk 会被记录以供重放，但从不成为派生消息 —— 所以重试从一份未被污染的历史开始。

### Token 影响

仅抑制并**不**停止生成：模型继续产出，被抑制区间的输出 token 照常计费。省下的是**上下文**：被抑制的文本从不进入会话日志，因此不会在后续每次请求中重新发送。

只有熔断才省生成 token。熔断会 `break` 出流，进而调用上游生成器的 `return()`，让适配器中止 HTTP 请求。

重试是一次新的供应商请求，会为重建的前缀重复输入 token 计费。`maxLoopRetries` 为这项成本设限。

### KV Cache 影响

抑制不改动任何请求，缓存标识不受影响。重试重建的请求保留此前缀，按该供应商的规则可复用缓存，与 `dsh-llm-retry` 对其自身重试的描述一致。

## 已知限制

- **近周期循环会漏检** —— 匹配是精确的，单元一旦漂移（`ok ok 好的 ok ok 好的`）比较即失败。这是刻意的：模糊匹配需要一个容差，而该容差是以此处的漏检换取正常文本上的误报。
- **超出 `maxPeriod` 的周期会漏检** —— 模型完整重复一段 200 字符的推理不会被发现。
- **不足 `minRunChars` 的重复不触发** —— 低于下限的重复被视为正常表达。
- **抑制不等于终止** —— 除熔断外模型持续生成，生成 token 照常计费。
- **重试会丢弃该次尝试** —— 失败尝试中循环之前产出的内容会丢失。循环响应通常价值很低，但这是一项真实成本。
- **结构上必然的循环无法恢复** —— 重试治不好提示词所要求的循环；配额耗尽后请求按设计失败。
- **`hardStopChars` 支配着这项权衡** —— 更低的取值更早熔断、省下更多生成 token，代价是更多重试。

## 安装

作为 dsh profile 的 bundle。把本仓库放进 profile 的 `node_modules/` 并注册：

```json
{
  "dependencies": {
    "dsh-repetition-guard": "file:./node_modules/dsh-repetition-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-repetition-guard"
      ],
      "patchReload": "live"
    }
  }
}
```

重启 dsh。`examples/dynamic-plugin.host.js` 是等价的动态 Cordis 插件，无需重启即在进程内激活，代价是随进程消失。

## 验证

```sh
node tests/guard-test.mjs        # 29 项断言：判据边界、误伤防护、性能
node tests/integration-test.mjs  # 26 项断言：加载真实模块、mock Cordis ctx
```

针对线上 `deepseek-v4.1-flash` 路由（`openai-completions` 协议）的运行时计数：

```
guardedCalls: 8     loopTrips: 8     recoveries: 5     detectorErrors: 0
hardStops: 3        hardStopsRetry: 3    hardStopsStop: 0
retries: 2          retriesExhausted: 1
suppressedChars: 19643
cleanedBlocks: 2
```

`hardStopsStop: 0` 记录的是没有任何一次熔断静默结束任务。`cleanedBlocks: 2` 记录的是 authoritative 的 block-end 路径在真实 token 流上生效，而不只是在测试里。

## 版本演进

**v1 → v2。** 初版把尾部检测跑在 `block-end` 上。当循环后面跟着普通内容时尾部不再是周期性的，检测漏掉，authoritative 的 block 把被抑制的一切还原了回来。实测：delta 转发 510 字符中的 140，组装出的消息仍是 510。改用全文本周期清除。

**v2 → v3。** `detectCycle` 返回 `{period, reps, start, chars}` 却没有 `unit` 字段，而 trip 日志读取了 `hit.unit.slice(0, 24)`。参数求值先于被调函数自身的 `try`，所以日志的防护从未生效：第一次真实检测就抛错，置上流级的 bypass 标志，**恰好在最需要它的那一刻关闭了抑制**。单元测试漏掉了它，因为那份测试跑的是手工复制的算法而非落盘模块；只有直接 import 真实文件的集成测试抓住了它。

**v3 → v4。** 熔断曾发出 `{kind: 'stop'}` 以绕开重试机制，这留下了没有恢复路径的后果 —— 实测，子代理的输出被截在 147 字符，它的下一步从未执行。现在改用带私有 code 的 `error` finish 驱动重试，并由 `maxLoopRetries` 为其设限。

## 许可证

MIT
