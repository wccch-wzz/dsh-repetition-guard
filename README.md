# dsh-repetition-guard

DeepSeek Harness 的**重复输出抑制器**：在 `llm/stream` 层拦截并扼制大模型思维链与正文的退化性重复输出（`ok` / `好的` / `马上` 这类填充词死循环），节省生成与上下文 token。

**provider 无关，按模型匹配** —— 不绑定任何供应商，配一行 glob 即可作用在整个 harness 上。

```
guardedCalls: 24    loopTrips: 4    suppressedChars: 8524
cleanedBlocks: 2    hardStops: 1    recoveries: 1    detectorErrors: 0
```

以上是真实模型（`deepseek-v4.1-flash`）上的实测计数，非模拟。

## 它解决什么问题

推理模型在长思维链中会陷入**退化循环**（degeneration）：logits 被上下文里的重复模式自我强化，输出坍缩成同一片段的无限重复。表现就是刷屏式的 `ok ok ok ok...`、`好的，马上 好的，马上...`。

代价有两层：生成时烧 token，更贵的是这些垃圾**进入会话历史**，此后每一轮请求都要重新携带，成倍放大。

## 为什么必须在 llm/stream 层

`llm/stream` 是 Cordis 的 waterfall 事件，包裹**每一次**流式模型调用：

```ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

它是唯一的流式咽喉，所有 provider、所有会话、主对话与子代理都从这里过。

**但注意**：loop 构建的请求是 deep-frozen 的（内容被设计为会话日志的纯函数），listener 只能读不能改。所以实现方式是**包装返回的 `AsyncIterable`**，而不是修改 `temperature` 之类的请求参数 —— 后者会直接抛异常。

## 两条防线，缺一不可

### 防线一：delta 实时抑制

累积滑动窗口，检测尾部的周期重复，命中后丢弃后续重复帧。

### 防线二：block-end 全文本清除

**这一层是必需的，不是冗余。** `packages/llm/llm/src/assembler.ts` 里写着：

```ts
/** Set by `block-end` — authoritative, and freezes the partial. */
block?: ContentBlock
```

```ts
private assemble(partial: PartialBlock, index: number): ContentBlock {
  if (partial.block) return partial.block   // block-end 优先，完全忽略 delta 累积
```

而 `llm-pi-ai/src/stream.ts` 证实 reasoning block 也发 block-end 且携带完整文本：

```ts
case 'thinking_end':
  yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
```

**只丢 delta 而不重写 block-end，抑制会被它整个还原。** 实测复现过：delta 层转发只剩 140/510 字符，但组装出的消息仍是完整的 510 字符。

所以防线二用 `stripCycles` 做全文本循环清除：把**任意位置**的重复段压缩为一个周期，保留循环前后的有效内容。重写时保留原 `block.type` —— `llm/src/invariant.ts` 会校验 block-end 的类型必须等于 block-start 声明的类型。

## 触发规则

### 门禁（决定这次调用是否被守）

按顺序三道，任一不过即原样放行：

1. `options.purpose !== undefined` 且 `guardAuxiliary` 为假 —— compaction / session-title 这类辅助调用默认不守
2. provider 不匹配 `providers` glob
3. 模型不匹配 `models` glob

默认 `['*']` 对两者都是全匹配，实际为全守。

### 判据

两条路径共用同一套判据。

1. 前置门：文本长度 < `minRunChars`（默认 120）→ 不判
2. 枚举周期 `p` 从 1 到 `min(maxPeriod, 长度/2)`
3. 取尾部 `p` 个字符作 `unit`；**`unit` 不含字母或数字就跳过该周期**（`/[\p{L}\p{N}]/u`）—— 这是 `-----`、`}}}}}` 不触发的原因
4. 数 `unit` 连续精确匹配的次数 `reps`
5. **命中条件：`reps ≥ minRepeats` 且 `reps × p ≥ minRunChars`**

双阈值的实际含义（`reps × p` 就是重复段总字符数）：

| 循环形态 | 周期 p | 需要重复次数 |
|---|---|---|
| `aaaaaaaa...` | 1 | ≥ 120 |
| `ok ok ok ...` | 3 | ≥ 40 |
| `好的，马上 好的，马上 ...` | 6 | ≥ 20 |

两条必须同时满足。所以「非常非常非常重要」（周期 2、3 次、6 字符）安全，「哈哈哈哈」也安全。

### 两条路径的作用面

- **delta 检测**：只作用于 `reasoning-delta` 与 `text-delta`，每累积 `checkEvery`（48）字符检测一次，窗口上限 `window`（1024）
- **block-end 清除**：只作用于 `block.type` 为 `reasoning`/`text` 且 `text` 是字符串的 block，从位置 0 全文本扫描

## 处理办法

### delta 路径：四级处置

1. **命中** —— 进入抑制态，记 `trips`
2. **抑制** —— 抑制期内每个 delta 累加计数并**不转发**。UI 不刷屏、内容不进会话历史
3. **熔断** —— 抑制量达 `hardStopChars`（默认 6000）时，发出 `{type:'finish', reason:{kind:'stop'}}` 并终止流。终止会触发上游 generator 的 `return()`，adapter 据此 abort HTTP —— **这是唯一真正省生成 token 的动作**。用 `stop` 而非 `aborted`，避免 `llm-retry` 把它当失败重试（重试只会再循环一次）
4. **恢复** —— 抑制期内若检测不再命中，累积 `escapeChars`（256）后退出抑制态，恢复正常转发

遇到 `block-start` 时重置全部状态（新 block 意味着上一段结束）。

### block-end 路径

计算 `stripCycles(text)`。若与原文不同则重写该 block-end 并计数；相同则原样透传。

### 原样透传

`usage`、`finish`、`tool-call-delta`、`block-start`，以及任何未知 chunk 类型。

### 失败安全

1. delta 检测抛异常 → 该条流此后纯透传（仅本条流，非全局降级）
2. block-end 检测抛异常 → 该 block 原样透传，仅计数
3. 门禁本身抛异常 → 原样放行，绝不阻断模型调用

## 一个重要语义区别

delta 抑制期间**模型仍在生成**，生成 token 照付。省下的是**上下文 token** —— 被抑制的内容不进会话历史，后续每轮不再携带。

真正省生成 token 的只有熔断那一刀。想更激进就把 `hardStopChars` 降到 1500 左右。

## 安装

作为 dsh profile 的 bundle 安装。把本仓库放进 profile 的 `node_modules/`，然后在 profile 的 `package.json` 里注册：

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

重启 dsh 生效。

仓库里的 `examples/dynamic-plugin.host.js` 是等价的**动态 Cordis 插件**版本，不需要重启，用 `cordis_define` + `cordis_run` 即可在当前进程内激活，代价是进程重启后消失。两者算法同源。

## 配置

改 `cordis.patch.yml` 的 `config:` 段。`patchReload: live` 时多数情况免重启。

| 键 | 默认 | 说明 |
|---|---|---|
| `models` | `['*']` | 模型 glob，`['*flash*']` 可收窄 |
| `providers` | `['*']` | provider glob |
| `guardAuxiliary` | `false` | 是否也守 compaction / session-title |
| `reasoning` | `true` | 守思维链通道 |
| `text` | `true` | 守正文通道 |
| `minRepeats` | `6` | 最小重复次数 |
| `minRunChars` | `120` | 重复段最小总字符数 |
| `maxPeriod` | `32` | 最大重复周期（字符） |
| `window` | `1024` | delta 检测滑动窗口 |
| `checkEvery` | `48` | 每累积多少字符检测一次 |
| `escapeChars` | `256` | 判定已恢复所需的新内容量 |
| `hardStop` | `true` | 是否启用熔断 |
| `hardStopChars` | `6000` | 熔断阈值 |
| `maxScanChars` | `200000` | block-end 全量扫描上限 |
| `verbose` | `false` | 详细日志 |

## 验证

```sh
node tests/guard-test.mjs        # 29 项：算法边界、误伤防护、性能
node tests/integration-test.mjs  # 14 项：加载真实模块 + mock ctx
```

真实模型上的运行时计数（`deepseek-v4.1-flash`，`openai-completions` 协议）：

```
guardedCalls: 24    skippedCalls: 0    loopTrips: 4
recoveries: 1       hardStops: 1       cleanedBlocks: 2
suppressedChars: 8524                  detectorErrors: 0
```

`cleanedBlocks: 2` 证明 block-end 路径在真实 token 流上生效；`suppressedChars: 8524` 是真实抑制量。

## 已知边界

- **近周期循环会漏检**：若重复片段有微小变化（`ok ok 好的 ok ok 好的` 里周期漂移），精确匹配失败
- **周期超过 32 字符会漏检**：例如整段 200 字符推理的重复
- **不足 120 字符的重复不触发**：阈值以下视为正常表达
- **抑制的是内容，不是停止生成**：除熔断外模型仍在生成，省的是上下文 token

## 踩过的坑

### v1 → v2：block-end 是 authoritative

初版只在 block-end 上做尾部周期检测。当「循环后又接正常内容」时尾部不是循环，检测漏掉，被抑制的垃圾被 authoritative 的 block-end 完整还原。实测：delta 转发 140/510，组装结果仍是 510 字符。

改为全文本循环清除。

### v2 → v3：一个会自我禁用的致命 bug

`detectCycle` 返回 `{period, reps, start, chars}` 却没有 `unit` 字段，而 trip 日志读取了 `hit.unit.slice(0, 24)`。**参数求值发生在 `log()` 自身的 try/catch 之前**，所以一旦真的检测到循环就抛 `TypeError` → `bypass = true` → 整条流永久降级为透传 → **抑制完全失效**。

插件恰好在最需要它工作的那一刻自我禁用。

更值得记的是：**这个 bug 骗过了单元测试**，因为那份测试跑的是手工复制的算法副本，没带那行日志。只有直接 import 落盘模块的集成测试才把它揪出来。

**能被证伪的测试才算测试。**

## License

MIT
