/**
 * dsh-repetition-guard — harness 级重复输出抑制器
 *
 * 在 `llm/stream` waterfall 上包裹每一次流式模型调用，扼制思维链与正文的
 * 退化性重复输出（"ok" / "好的" / "马上" 类填充词死循环），节省生成与
 * 上下文 token。按 options.model 匹配，provider 无关。
 *
 * 依据：
 *   packages/llm/llm/src/types.ts      StreamChunk / GenerateOptions 定义
 *   packages/llm/llm/src/assembler.ts  block-end 为 authoritative，优先于 delta 累积
 *   packages/llm/llm/src/index.ts      stream() 经 ctx.waterfall(this,'llm/stream',...)
 *   core/agent-loop/src/agent.ts:339   finish 为 error/aborted 时派发 agent/request-error，
 *                                      返回 {kind:'retry'} 即 continue 重新生成；
 *                                      assistant 消息只在正常 finish 后落库，故重试是干净的
 *
 * 设计要点：
 *   1. delta 层实时抑制 —— 检测到尾部周期重复即丢弃后续重复帧。
 *   2. block-end 层全文本清除 —— block-end 携带的完整文本是权威的，会完全
 *      覆盖 delta 累积；只丢 delta 而不改 block-end 等于没做。
 *   3. 熔断后自动重试 —— 抑制量超阈值时发出 error finish 触发 agent/request-error，
 *      由本插件返回 retry 让 agent loop 重新生成，任务得以继续而非中断。
 *   4. 失败安全 —— 检测层任何异常都降级为纯透传，绝不影响模型调用。
 *   5. 误伤防护 —— 纯符号周期（分隔线、括号、等号）不参与判定；双阈值
 *      （重复次数 + 重复段总字符数）确保正常强调不被命中。
 *
 * 零外部依赖：只用 ctx 与标准 ECMAScript 内置。
 */

export const name = 'repetition-guard'

const DEFAULTS = {
  models: ['*'],
  providers: ['*'],
  guardAuxiliary: false,
  reasoning: true,
  text: true,
  minRepeats: 6,
  minRunChars: 120,
  maxPeriod: 32,
  window: 1024,
  checkEvery: 48,
  escapeChars: 256,
  hardStop: true,
  hardStopChars: 6000,
  // 'retry' 熔断后发 error 触发重试，任务继续（推荐）
  // 'stop'  熔断后静默结束，任务中断（旧行为）
  // 'off'   不熔断，只抑制
  hardStopMode: 'retry',
  maxLoopRetries: 2,
  maxScanChars: 200000,
  verbose: false,
}

/** 熔断重试的 failure code；agent/request-error 监听器据此识别。 */
const LOOP_CODE = 'REPETITION_LOOP'

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

/** 尾部周期检测：流式实时抑制用，只看结尾处的连续重复。 */
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

/** 从 from 起检测周期重复，用于全文本扫描。 */
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

/** 全文本循环清除：任意位置的重复段压缩为一个周期，保留循环前后内容。 */
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

function guardStream(makeInner, options, cfg, stats, log) {
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
                    // 日志拼接必须在独立 try 内：它抛错曾导致 bypass 永久降级，
                    // 使抑制在真正检测到循环的那一刻失效。
                    try {
                      log('loop model=' + model + ' period=' + hit.period
                        + ' reps=' + hit.reps + ' run=' + hit.chars
                        + ' unit=' + JSON.stringify(String(hit.unit).slice(0, 24)), true)
                    } catch (logErr) { /* 日志失败绝不影响抑制 */ }
                  }
                  cleanChars = 0
                } else if (squelching) {
                  cleanChars += cfg.checkEvery
                  if (cleanChars >= cfg.escapeChars) {
                    squelching = false
                    stats.escapes++
                    log('recovered model=' + model)
                  }
                }
              }
            } catch (err) {
              stats.detectorErrors++
              bypass = true
              log('detector failed, bypassing: ' + String(err), true)
              yield chunk
              continue
            }

            if (squelching) {
              squelchChars += chunk.text.length
              stats.suppressedChars += chunk.text.length
              if (cfg.hardStop && cfg.hardStopMode !== 'off' && squelchChars >= cfg.hardStopChars) {
                stats.hardStops++
                if (cfg.hardStopMode === 'retry') {
                  // 发出 error finish，交由 agent/request-error 决定是否重试。
                  // 用 error 而非 stop：stop 会让任务在此静默中断。
                  stats.hardStopsRetry++
                  log('hard stop -> retry model=' + model + ' suppressed=' + squelchChars, true)
                  yield {
                    type: 'finish',
                    reason: {
                      kind: 'error',
                      failure: {
                        message: 'repetition-guard: model degenerated into a repetition loop after '
                          + squelchChars + ' suppressed characters',
                        code: LOOP_CODE,
                      },
                    },
                  }
                } else {
                  stats.hardStopsStop++
                  log('hard stop -> silent model=' + model + ' suppressed=' + squelchChars, true)
                  yield { type: 'finish', reason: { kind: 'stop' } }
                }
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
          if (b !== undefined && b !== null
            && (b.type === 'reasoning' || b.type === 'text')
            && typeof b.text === 'string') {
            const on = b.type === 'reasoning' ? cfg.reasoning : cfg.text
            if (on) {
              try {
                const trimmed = stripCycles(b.text, cfg)
                if (trimmed !== b.text) {
                  stats.blockTrims++
                  stats.suppressedChars += b.text.length - trimmed.length
                  log('block cleaned model=' + model + ' type=' + b.type
                    + ' from=' + b.text.length + ' to=' + trimmed.length, true)
                  yield { type: 'block-end', index: chunk.index, block: { type: b.type, text: trimmed } }
                  continue
                }
              } catch (err) {
                stats.detectorErrors++
                log('block detector failed: ' + String(err), true)
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

/**
 * 安装重复输出抑制器。
 * @param ctx - 拥有监听器生命周期的插件上下文。
 * @param config - cordis.patch.yml 传入的配置，覆盖 {@link DEFAULTS}。
 */
export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config === null || config === undefined ? {} : config)

  const stats = {
    guarded: 0,
    skipped: 0,
    trips: 0,
    escapes: 0,
    hardStops: 0,
    hardStopsRetry: 0,
    hardStopsStop: 0,
    retries: 0,
    retriesExhausted: 0,
    blockTrims: 0,
    suppressedChars: 0,
    detectorErrors: 0,
  }

  /** 每个 turn/step 的循环重试次数；超限即放行默认行为（抛错终止）。 */
  const loopRetries = new Map()

  function log(message, always) {
    if (always !== true && cfg.verbose !== true) return
    try {
      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
        ctx.logger.info('[repetition-guard] ' + message)
      }
    } catch (err) { /* 日志失败不影响抑制 */ }
  }

  ctx.on('llm/stream', (options, next) => {
    try {
      if (options.purpose !== undefined && cfg.guardAuxiliary !== true) {
        stats.skipped++
        return next()
      }
      if (!globMatch(cfg.providers, options.provider) || !globMatch(cfg.models, options.model)) {
        stats.skipped++
        return next()
      }
      stats.guarded++
      return guardStream(() => next(), options, cfg, stats, log)
    } catch (err) {
      // 门禁本身失败绝不阻断模型调用
      stats.detectorErrors++
      log('gate failed, passing through: ' + String(err), true)
      return next()
    }
  })

  // 熔断后的恢复链路：agent-loop 在 finish 为 error/aborted 时派发此 waterfall，
  // 返回 {kind:'retry'} 即 continue 重新生成该 step。assistant 消息只在正常
  // finish 后落库，所以重试不会被上一次的重复内容污染。
  ctx.on('agent/request-error', (payload, next) => {
    try {
      if (payload === undefined || payload === null) return next()
      const failure = payload.failure
      if (failure === undefined || failure.code !== LOOP_CODE) return next()
      if (cfg.hardStopMode !== 'retry') return next()

      const agentId = payload.agent !== undefined && payload.agent !== null ? payload.agent.id : 'x'
      const key = agentId + ':' + payload.turn + ':' + payload.step
      const used = (loopRetries.get(key) || 0) + 1
      if (loopRetries.size > 2048) loopRetries.clear()
      loopRetries.set(key, used)

      if (used > cfg.maxLoopRetries) {
        stats.retriesExhausted++
        log('retry limit reached (' + cfg.maxLoopRetries + ') key=' + key + ', giving up', true)
        return next()
      }
      stats.retries++
      log('retry ' + used + '/' + cfg.maxLoopRetries + ' after loop key=' + key, true)
      return { kind: 'retry' }
    } catch (err) {
      stats.detectorErrors++
      log('retry gate failed: ' + String(err), true)
      return next()
    }
  })

  log('active models=' + JSON.stringify(cfg.models)
    + ' minRepeats=' + cfg.minRepeats
    + ' minRunChars=' + cfg.minRunChars
    + ' hardStopMode=' + cfg.hardStopMode
    + ' hardStopChars=' + cfg.hardStopChars
    + ' maxLoopRetries=' + cfg.maxLoopRetries)
}
