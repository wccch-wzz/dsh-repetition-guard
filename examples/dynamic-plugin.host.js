// ═══════════════════════════════════════════════════════════════
// 重复输出抑制器 v3 —— DSH harness 级 llm/stream 中间件（动态 Cordis 插件）
// ═══════════════════════════════════════════════════════════════
//
// 用途：扼制 deepseek-v4.1-flash 等模型思维链与正文的退化性重复输出
//       （"ok" / "好的" / "马上" 类填充词死循环），节省生成与上下文 token。
//
// 层级：llm/stream waterfall —— 包裹每一次流式模型调用，provider 无关。
//       按 options.model 匹配，不绑定任何供应商。
//
// 恢复方式（dsh 重启后动态插件会消失，用本文件重建）：
//   1. cordis_define  plugin.kind = "new", idPrefix = "repgd"
//      code.host = 本文件全部内容（去掉本注释块亦可）
//   2. cordis_run     mode = "run"
//   3. 用 subagent 跑一次，再调用 repetition_guard 工具看 guardedCalls 是否增长
//
// 持久化版本（跨重启，零依赖）见本仓库 lib/index.js
// 与动态版的差异：持久化版不注册 repetition_guard 工具，改用 ctx.logger 输出。
//
// ── 版本演进 ──────────────────────────────────────────────────
// v1 → v2：block-end 从「尾部周期检测」改为「全文本循环清除」。
//   原因：packages/llm/llm/src/assembler.ts:21 注明 block-end 携带的 block 是
//   authoritative，assemble() 优先返回它、完全忽略 delta 累积。仅做尾部检测时，
//   「循环后又接正常内容」会漏检，被抑制的垃圾被 authoritative 的 block-end 完整
//   还原。实测确认：转发=140/原文=510，但 block-end 未改 len=510。
//
// v2 → v3：修复致命的自禁用 bug。detectCycle 返回 {period,reps,start,chars} 却
//   没有 unit 字段，而 trip 日志读取了 hit.unit.slice(0,24)。参数求值发生在
//   log() 调用之前，log 自身的 try/catch 保护不了它 → 一旦真的检测到循环就抛
//   TypeError → bypass=true → 整条流永久降级为透传 → 抑制完全失效。
//   插件恰好在最需要它工作的那一刻自我禁用。
//   该缺陷在「手工复制算法」的单元测试里测不出来，只有直接加载落盘模块的集成
//   测试才暴露。修复：detectCycle 返回 unit；日志拼接包进独立 try。
//
// ── 实测依据 ──────────────────────────────────────────────────
//   packages/llm/llm/src/types.ts      StreamChunk / GenerateOptions 定义
//   packages/llm/llm/src/assembler.ts  block-end 为 authoritative
//   packages/llm/llm/src/index.ts      stream() 经 ctx.waterfall(this,'llm/stream',...)
//   llm-pi-ai/src/stream.ts:152        reasoning block 也发 block-end 携带完整文本
//
// ── 验证 ──────────────────────────────────────────────────────
//   集成测试 14/14（work/repgd-test/integration-test.mjs，加载真实落盘模块）
//   单元测试 29/29（work/repgd-test/guard-test.mjs，算法边界与性能）
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  models: ['*'],            // 模型 glob，provider 无关。收窄示例：['*flash*']
  providers: ['*'],
  guardAuxiliary: false,    // 是否也守 compaction / session-title 辅助调用
  reasoning: true,          // 守思维链
  text: true,               // 守正文
  minRepeats: 6,            // 最小重复次数
  minRunChars: 120,         // 重复段最小总字符数（与 minRepeats 双条件）
  maxPeriod: 32,            // 最大重复周期（字符）
  window: 1024,             // 流式检测滑动窗口
  checkEvery: 48,           // 每累积多少字符检测一次
  escapeChars: 256,         // 抑制中累积多少新内容后判定已恢复
  hardStop: true,           // 抑制过量时熔断
  hardStopChars: 6000,      // 熔断阈值
  maxScanChars: 200000,     // block-end 全量扫描上限，超过则退化为尾部检测
}

const HAS_WORD = /[\p{L}\p{N}]/u
const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g

function escapeRx(s) {
  return s.replace(RX_SPECIAL, '\\$&')
}

function globMatch(patterns, value) {
  if (typeof value !== 'string') return false
  if (!Array.isArray(patterns)) return false
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]
    if (p === '*') return true
    try {
      const rx = new RegExp('^' + p.split('*').map(escapeRx).join('.*') + '$', 'i')
      if (rx.test(value)) return true
    } catch (err) { /* 无效 pattern 视为不匹配 */ }
  }
  return false
}

// 尾部周期检测：流式实时抑制用，只看结尾处的连续重复。
function detectCycle(s, cfg) {
  const n = s.length
  if (n < cfg.minRunChars) return null
  const limit = Math.min(cfg.maxPeriod, n >> 1)
  for (let p = 1; p <= limit; p++) {
    const unit = s.slice(n - p)
    if (!HAS_WORD.test(unit)) continue
    let reps = 1
    let i = n - p
    while (i >= p && s.startsWith(unit, i - p)) {
      reps++
      i -= p
    }
    if (reps >= cfg.minRepeats && reps * p >= cfg.minRunChars) {
      return { period: p, reps: reps, start: i, chars: reps * p, unit: unit }
    }
  }
  return null
}

// 从 from 起检测周期重复，用于全文本扫描。
function cycleAt(s, from, cfg) {
  const n = s.length
  const maxP = Math.min(cfg.maxPeriod, Math.floor((n - from) / cfg.minRepeats))
  for (let p = 1; p <= maxP; p++) {
    if (s.charCodeAt(from) !== s.charCodeAt(from + p)) continue
    const unit = s.slice(from, from + p)
    if (!HAS_WORD.test(unit)) continue
    let reps = 1
    let j = from + p
    while (j + p <= n && s.startsWith(unit, j)) {
      reps++
      j += p
    }
    if (reps >= cfg.minRepeats && reps * p >= cfg.minRunChars) {
      return { period: p, reps: reps, chars: reps * p, unit: unit }
    }
  }
  return null
}

// 全文本循环清除：任意位置的重复段压缩为一个周期，保留循环前后内容。
function stripCycles(s, cfg) {
  const n = s.length
  if (n < cfg.minRunChars) return s
  if (n > cfg.maxScanChars) {
    const hit = detectCycle(s, cfg)
    return hit === null ? s : s.slice(0, Math.max(hit.start, hit.period * 2))
  }
  const parts = []
  let last = 0
  let i = 0
  let changed = false
  while (i < n) {
    const hit = cycleAt(s, i, cfg)
    if (hit !== null) {
      parts.push(s.slice(last, i + hit.period))
      i += hit.chars
      last = i
      changed = true
    } else {
      i++
    }
  }
  if (!changed) return s
  parts.push(s.slice(last))
  return parts.join('')
}

const stats = {
  guarded: 0,
  skipped: 0,
  trips: 0,
  escapes: 0,
  hardStops: 0,
  blockTrims: 0,
  suppressedChars: 0,
  detectorErrors: 0,
  lastModel: null,
  byModel: Object.create(null),
}

function bump(model, field, amount) {
  let m = stats.byModel[model]
  if (m === undefined) {
    m = { trips: 0, hardStops: 0, blockTrims: 0, suppressedChars: 0 }
    stats.byModel[model] = m
  }
  m[field] += amount
}

function guardStream(makeInner, options) {
  const cfg = CONFIG
  const model = options.model
  return (async function* () {
    const inner = makeInner()
    let buf = ''
    let pending = 0
    let squelching = false
    let squelchChars = 0
    let cleanChars = 0
    let bypass = false
    let stopped = false

    try {
      for await (const chunk of inner) {
        const t = chunk.type

        if (bypass) {
          yield chunk
          continue
        }

        if (t === 'reasoning-delta' || t === 'text-delta') {
          const on = t === 'reasoning-delta' ? cfg.reasoning : cfg.text
          if (on) {
            let hit = null
            try {
              buf = (buf + chunk.text).slice(-cfg.window)
              pending += chunk.text.length
              if (pending >= cfg.checkEvery) {
                pending = 0
                hit = detectCycle(buf, cfg)
                if (hit !== null) {
                  if (!squelching) {
                    squelching = true
                    squelchChars = 0
                    stats.trips++
                    bump(model, 'trips', 1)
                  }
                  cleanChars = 0
                } else if (squelching) {
                  cleanChars += cfg.checkEvery
                  if (cleanChars >= cfg.escapeChars) {
                    squelching = false
                    stats.escapes++
                  }
                }
              }
            } catch (err) {
              stats.detectorErrors++
              bypass = true
              console.error('[repetition-guard] detector failed, bypassing', err)
              yield chunk
              continue
            }

            // 日志在检测 try 之外，且自带 try：它抛错绝不能触发 bypass 降级。
            if (hit !== null && squelchChars === 0) {
              try {
                console.log('[repetition-guard] loop model=' + model + ' period=' + hit.period + ' reps=' + hit.reps + ' run=' + hit.chars + ' unit=' + JSON.stringify(String(hit.unit).slice(0, 24)))
              } catch (logErr) { /* 日志失败不影响抑制 */ }
            }

            if (squelching) {
              squelchChars += chunk.text.length
              stats.suppressedChars += chunk.text.length
              bump(model, 'suppressedChars', chunk.text.length)
              if (cfg.hardStop && squelchChars >= cfg.hardStopChars) {
                stats.hardStops++
                bump(model, 'hardStops', 1)
                console.log('[repetition-guard] hard stop model=' + model + ' suppressed=' + squelchChars)
                yield { type: 'finish', reason: { kind: 'stop' } }
                stopped = true
                break
              }
              continue
            }
          }
          yield chunk
          continue
        }

        if (t === 'block-start') {
          squelching = false
          cleanChars = 0
          buf = ''
          pending = 0
          yield chunk
          continue
        }

        // block-end 携带组装层 authoritative 的完整文本，会完全覆盖 delta 累积。
        // 不在这里做全文本清除，前面所有抑制都会被它还原。
        if (t === 'block-end') {
          const b = chunk.block
          if (b !== undefined && b !== null && (b.type === 'reasoning' || b.type === 'text') && typeof b.text === 'string') {
            const on = b.type === 'reasoning' ? cfg.reasoning : cfg.text
            if (on) {
              try {
                const trimmed = stripCycles(b.text, cfg)
                if (trimmed !== b.text) {
                  stats.blockTrims++
                  stats.suppressedChars += b.text.length - trimmed.length
                  bump(model, 'blockTrims', 1)
                  bump(model, 'suppressedChars', b.text.length - trimmed.length)
                  console.log('[repetition-guard] block cleaned model=' + model + ' type=' + b.type + ' from=' + b.text.length + ' to=' + trimmed.length)
                  yield { type: 'block-end', index: chunk.index, block: { type: b.type, text: trimmed } }
                  continue
                }
              } catch (err) {
                stats.detectorErrors++
                console.error('[repetition-guard] block detector failed', err)
              }
            }
          }
          yield chunk
          continue
        }

        yield chunk
      }
    } catch (err) {
      if (!stopped) throw err
    }
  })()
}

return {
  apply(ctx) {
    ctx.on('llm/stream', (options, next) => {
      try {
        if (options.purpose !== undefined && !CONFIG.guardAuxiliary) {
          stats.skipped++
          return next()
        }
        if (!globMatch(CONFIG.providers, options.provider) || !globMatch(CONFIG.models, options.model)) {
          stats.skipped++
          return next()
        }
        stats.guarded++
        stats.lastModel = options.model
        return guardStream(() => next(), options)
      } catch (err) {
        stats.detectorErrors++
        console.error('[repetition-guard] gate failed, passing through', err)
        return next()
      }
    })

    const tool = harness.defineTool({
      name: 'repetition_guard',
      description: 'Read or reset the live repetition-guard counters for this process. The guard wraps every streaming model call at the llm/stream waterfall and suppresses degenerate repetition loops (repeated "ok"/"好的"/"马上" style filler) in both reasoning and visible text. It squelches repeated deltas in real time and rewrites the authoritative block-end with a whole-text cycle strip, so the assembled message cannot restore suppressed text. Returns guarded/skipped call counts, loop trips, recoveries, hard stops, cleaned blocks, and suppressed character counts per model.',
      parameters: {
        action: {
          type: 'string',
          enum: ['stats', 'reset'],
          description: 'stats reads current counters; reset zeroes them.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute(args) {
        const action = args !== null && args !== undefined && args.action === 'reset' ? 'reset' : 'stats'
        if (action === 'reset') {
          stats.guarded = 0
          stats.skipped = 0
          stats.trips = 0
          stats.escapes = 0
          stats.hardStops = 0
          stats.blockTrims = 0
          stats.suppressedChars = 0
          stats.detectorErrors = 0
          stats.byModel = Object.create(null)
        }
        return {
          action: action,
          config: {
            models: CONFIG.models,
            providers: CONFIG.providers,
            guardAuxiliary: CONFIG.guardAuxiliary,
            channels: { reasoning: CONFIG.reasoning, text: CONFIG.text },
            minRepeats: CONFIG.minRepeats,
            minRunChars: CONFIG.minRunChars,
            maxPeriod: CONFIG.maxPeriod,
            escapeChars: CONFIG.escapeChars,
            hardStop: CONFIG.hardStop,
            hardStopChars: CONFIG.hardStopChars,
          },
          counters: {
            guardedCalls: stats.guarded,
            skippedCalls: stats.skipped,
            loopTrips: stats.trips,
            recoveries: stats.escapes,
            hardStops: stats.hardStops,
            cleanedBlocks: stats.blockTrims,
            suppressedChars: stats.suppressedChars,
            detectorErrors: stats.detectorErrors,
            lastModel: stats.lastModel,
          },
          byModel: stats.byModel,
        }
      },
    })

    ctx.effect(() => harness.registerTool(ctx, tool), 'repetition-guard: tool')

    console.log('[repetition-guard] active v3: models=' + JSON.stringify(CONFIG.models) + ' minRepeats=' + CONFIG.minRepeats + ' minRunChars=' + CONFIG.minRunChars + ' hardStopChars=' + CONFIG.hardStopChars)
  },
}
