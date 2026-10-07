# `dsh-repetition-suppressor`

[English](README.md) | 中文

功能插件，抑制流式模型输出中的退化性重复 —— 推理模型在自身重复上下文的强化下，输出坍缩成 `ok ok ok ok...` / `好的，马上 好的，马上...` 的那种现象。它包裹 `llm/stream` waterfall 上的每一次流式模型调用，按模型 glob 匹配而非按供应商匹配；当抑制量超过配置的预算时，它发出一个 `error` finish，由 agent loop 转成重试，任务得以继续而非被切断。

插件从不改写请求。loop 构建的请求是 deep-frozen 的 —— 其内容是会话日志的纯函数 —— 监听器可以读但不能改，试图调整该对象上的 `temperature` 或惩罚字段会直接抛异常。因此抑制施加在返回的 `AsyncIterable<StreamChunk>` 上，而不是调用参数上。

## 工作机制

### 两个检测信号

**周期检测。** 对滑动尾部窗口做精确匹配扫描重复单元，抓的是「输出锁死成同一串」的经典退化；命中即进入抑制态，在循环持续期间不再转发 delta。

**塌缩检测。** 同一个窗口还按与周期性无关的两个量打分，补上精确匹配看不见的近周期退化 —— 一小撮词以不规律顺序轮转，不存在任何周期单元，但文本同样已经退化：

- *n-gram 重复率* —— 窗口内已经出现过的 8-gram 占比。八这个长度是标定出来的：取四时合法的结构化输出（JSON 数组、高度相似的代码行）会打到 0.80 左右而被误伤；取八时它们落到 0.68 以下，而真循环仍在 0.87 以上。
- *词表多样性* —— 重复词 token 的占比，token 指字母与数字的极大连续段。仅三个填充词轮转的循环会让它趋近于零，而这恰恰是单靠 n-gram 打分漏掉的情形。

任一信号达到 `collapseThreshold`（默认 0.80）即进入同一个抑制态。

**block-end 全文本重写。** `@deepseek-ai/dsh-llm` 的组装器把 `block-end` 标记为 authoritative —— `assemble()` 返回它携带的 block，并忽略 delta 累积的一切：

```ts
/** Set by `block-end` — authoritative, and freezes the partial. */
block?: ContentBlock
```

适配器对 text 与 reasoning 两种 block 都会发出它，并携带完整文本。**只丢 delta 而不重写 `block-end`，等于没有抑制** —— authoritative 的 block 会把完整循环还原回来。因此插件在 yield 之前重写该 block：周期循环走全文本周期清除，塌缩则截断在塌缩段起点、保留其前的全部内容。重写后的 `block-end` 保留原 `block.type`；流不变量会拿它与 `block-start` 的声明做校验。

### 触发判据

两条路径共用同一套判据。

1. 候选文本必须达到 `minRunChars`（默认 120）。
2. 周期 `p` 从 1 试到 `min(maxPeriod, 长度/2)`。
3. 尾部 `p` 个字符构成单元；**不含字母或数字的单元被跳过** —— 这就是 `-----` 与 `}}}}}` 从不触发的原因。
4. 测量连续精确匹配的次数 `reps`。
5. 命中要求 **`reps >= minRepeats` 且 `reps * p >= minRunChars`**。

第二个条件把两个阈值合成一道长度下限：`reps * p` 即重复段的总长度。`ok ` 需要 40 次，`好的，马上 ` 需要 20 次，单字符需要 120 次。正常强调如 `非常非常非常重要`（周期 2、三次、六字符）远在阈值之下。

delta 路径每累积 `checkEvery`（48）字符对 `window`（1024）尾部求值一次；block-end 路径从偏移 0 起扫描全文。

### 塌缩判据

在尾部 `collapseWindow`（192）字符上打分，要求至少 `collapseMinChars`（96）字符与 `collapseMinTokens`（24）个 token。`gramScore` 或 `tokenCollapseScore` 任一达到 `collapseThreshold` 即判为塌缩。

在 block-end 处用二分定位塌缩起点 —— 前缀里被排除的正常文本越多分数越高，故该量单调 —— 然后截断于该点，并至少保留 32 字符，使完全退化的 block 也仍能产出内容。

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

| 键 | 默认 | 含义 |
|---|---|---|
| `models` | `['*']` | 模型 glob；`['*flash*']` 可收窄 |
| `providers` | `['*']` | provider glob |
| `guardAuxiliary` | `false` | 是否也守 compaction / session-title 调用 |
| `reasoning` / `text` | `true` | 守哪些 delta 通道 |
| `minRepeats` / `minRunChars` | `6` / `120` | 周期命中阈值 |
| `maxPeriod` | `32` | 考虑的最大周期（字符） |
| `window` / `checkEvery` | `1024` / `48` | delta 扫描窗口与频率 |
| `escapeChars` | `256` | 退出抑制态所需的新内容量 |
| `collapse` | `true` | 是否启用塌缩检测 |
| `collapseGram` | `8` | n-gram 长度 |
| `collapseThreshold` | `0.80` | 任一信号触发阈值 |
| `collapseWindow` / `collapseMinChars` | `192` / `96` | 打分窗口与长度下限 |
| `collapseMinTokens` | `24` | 多样性信号的 token 下限 |
| `collapseScanChars` | `8000` | 回溯搜索塌缩起点的范围 |
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

- **早期自愈逃得过检测** —— 周期路径需要 `minRunChars`（120）字符，塌缩路径需要 `collapseMinChars`（96）字符加 `collapseMinTokens`（24）个 token。一旦循环在触到任一门槛之前自己停住，就顺过去了。
- **超出 `maxPeriod` 的周期会被周期路径漏掉** —— 词表小时塌缩路径仍能抓住，但一段长文本被完整重复、其间又夹着多样词汇时，两条路都可能错过。
- **塌缩检测是以召回换精确** —— 阈值是拿 JSON 数组、高度相似的代码行、日志行、数值序列、多行表格与 base64 标定的，它们全部落在 0.68 以下而真循环高于 0.87。若存在与这些样本都不相似的、合法的公式化文本，原则上可能打得更高。
- **抑制不等于终止** —— 除熔断外模型持续生成，生成 token 照常计费。
- **重试会丢弃该次尝试** —— 失败尝试中循环之前产出的内容会丢失。循环响应通常价值很低，但这是一项真实成本。
- **结构上必然的循环无法恢复** —— 重试治不好提示词所要求的循环；配额耗尽后请求按设计失败。
- **`hardStopChars` 支配着这项权衡** —— 更低的取值更早熔断、省下更多生成 token，代价是更多重试。

## 安装

```sh
dsh plugin --profile web add dsh-repetition-suppressor
```

`dsh plugin` 把参数转发给 profile 目录下的 pnpm，并在 pnpm 退出后同步 `dsh.profile.bundles`，因此无需手工编辑清单。重启 dsh 以加载 bundle。若你运行的是其他 profile，把 `web` 换成对应名字。

若你更想从仓库取不锁版本的同一份代码：

```sh
dsh plugin --profile web add https://github.com/wccch-wzz/dsh-repetition-guard/archive/refs/heads/main.tar.gz
```

重启 dsh 以加载 bundle。若你运行的是其他 profile，把 `web` 换成对应名字。

卸载是对称的：

```sh
dsh plugin --profile web remove dsh-repetition-suppressor
```

**在 proot 下，或任何把 hard link 映射成符号链接的容器里，pnpm 的存储无法建链，安装会中断**并报 `failed to import ... No such file or directory`。tarball 在那一步之前就已解包，因此插件文件本身落位正确，只是清单更新丢失 —— 手工补上即可：确认解包目录已在 profile 的 `node_modules/` 中，然后在 `dependencies` 映射与 `dsh.profile.bundles` 里同时声明它。

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

`examples/dynamic-plugin.host.js` 是等价的动态 Cordis 插件，无需重启即在进程内激活，代价是随进程消失。

## 验证

```sh
node tests/guard-test.mjs        # 29 项断言：周期判据边界、误伤防护、性能
node tests/integration-test.mjs  # 26 项断言：加载真实模块、mock Cordis ctx
node tests/collapse-test.mjs     # 26 项断言：塌缩检测、危险样本、回归
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

**v4 → v5。** 精确周期匹配对单元漂移的循环完全失明。三个填充词以不规律顺序轮转永远产生不出周期单元，检测器于是从未触发 —— 实测，一条合成的混排循环原封不动地穿过，1398 字符一个不少。补入 n-gram 重复率与词表多样性两个正交信号。单靠任一个都不够：同一段三词轮转在 8-gram 上只有 0.78，低于 0.80 阈值，因为三词的字母表能构成的相异 gram 太少；而在同一输入上词表多样性是 0.995。

## 许可证

MIT
