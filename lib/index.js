/**
 * dsh-repetition-guard — harness 级重复输出抑制器
 *
 * 在 `llm/stream` waterfall 上包裹每一次流式模型调用，扼制思维链与正文的
 * 退化性重复输出，节省生成与上下文 token。按 options.model 匹配，provider 无关。
 *
 * 两道检测并行，针对两类不同的退化形态：
 *
 *   1. 周期检测 —— 尾部周期重复，用精确 startsWith 匹配。
 *      抓「输出锁死成同一串」的经典退化。命中后 stripCycles 只保留一个周期。
 *
 *   2. 塌缩检测 —— n-gram 重复率超过阈值。
 *      抓「同一小组词以不规律顺序无限复用」的近周期退化，这是精确匹配的盲区。
 *      4-gram 会把合法的结构化输出（JSON 数组、相似代码行）误判到 0.80，
 *      8-gram 则把它们压到 0.68 以下而真循环仍稳在 0.87 以上，故取 g=8。
 *      命中后按塌缩起点截断，保留循环之前的有效内容。
 *
 * 依据：
 *   packages/llm/llm/src/types.ts      StreamChunk / GenerateOptions 定义
 *   packages/llm/llm/src/assembler.ts  block-end 为 authoritative，优先于 delta 累积
 *   packages/llm/llm/src/index.ts      stream() 经 ctx.waterfall(this,'llm/stream',...)
 *   core/agent-loop/src/agent.ts:339   finish 为 error/aborted 时派发 agent/request-error，
 *                                      返回 {kind:'retry'} 即 continue 重新生成；
 *                                      assistant 消息只在正常 finish 后落库，故重试干净
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

  // ── 周期检测 ──
  minRepeats: 6,
  minRunChars: 120,
  maxPeriod: 32,
  window: 1024,
  checkEvery: 48,
  escapeChars: 256,

  // ── 塌缩检测 ──
  collapse: true,
  collapseGram: 8,
  collapseThreshold: 0.80,
  collapseWindow: 192,
  collapseMinChars: 96,
  collapseScanChars: 8000,
  collapseMinTokens: 24,

  // ── 熔断与恢复 ──
  hardStop: true,
  hardStopChars: 6000,
  // 'retry' 熔断后发 error 触发重试，任务继续（推荐）
  // 'stop'  熔断后静默结束，任务中断
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

// ── 周期检测 ────────────────────────────────────────────────

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

/** 全文本周期清除：任意位置的重复段压缩为一个周期，保留循环前后内容。 */
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

// ── 塌缩检测 ────────────────────────────────────────────────

/**
 * 区间 [from, to) 内重复出现的 n-gram 占比。
 * 只统计含字母或数字的 gram，排除分隔线与代码括号这类纯符号区。
 */
function gramScore(s, from, to, g) {
  const start = from < 0 ? 0 : from
  const end = to > s.length ? s.length : to
  if (end - start < g * 4) return 0
  const seen = new Set()
  let dup = 0
  let total = 0
  for (let i = start; i + g <= end; i++) {
    const gram = s.slice(i, i + g)
    if (!HAS_WORD.test(gram)) continue
    total++
    if (seen.has(gram)) dup++
    else seen.add(gram)
  }
  return total === 0 ? 0 : dup / total
}


const RX_NONWORD = /[^\p{L}\p{N}]+/u

/**
 * 词表塌缩分：窗口内非重复 token 的占比越低分越高。
 * 补 n-gram 的盲区 —— 词表极小的循环（如三个词不规律轮转）其 8-gram
 * 组合数太少，重复率未必过线，但 token 多样性必然塌到接近零。
 * 正常结构化输出（JSON、代码）token 多样，此分不会高。
 */
function tokenCollapseScore(s, from, to, cfg) {
  const seg = s.slice(from < 0 ? 0 : from, to > s.length ? s.length : to)
  const parts = seg.split(RX_NONWORD)
  let total = 0
  const seen = new Set()
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i]
    if (t.length === 0) continue
    total++
    if (seen.size < 4096) seen.add(t)
  }
  if (total < cfg.collapseMinTokens) return 0
  return 1 - seen.size / total
}

/** 两种塌缩信号取高者，量纲统一到 0..1。 */
function collapseScore(s, from, to, cfg) {
  const g = gramScore(s, from, to, cfg.collapseGram)
  const t = tokenCollapseScore(s, from, to, cfg)
  return g > t ? g : t
}

/** 尾部窗口的塌缩分（两种信号取高）。 */
function tailCollapseScore(s, cfg) {
  const from = s.length - cfg.collapseWindow
  return collapseScore(s, from < 0 ? 0 : from, s.length, cfg)
}

/**
 * 定位塌缩段的起点：找最小的 i，使 s[i..] 的塌缩分仍达阈值。
 * 分数随 i 增大而升高（前缀里的正常文本被移出），故可二分。
 * 返回 -1 表示整段不构成塌缩。
 */
function findCollapseStart(s, cfg) {
  const n = s.length
  if (n < cfg.collapseMinChars) return -1
  const floor = n > cfg.collapseScanChars ? n - cfg.collapseScanChars : 0
  if (tailCollapseScore(s, cfg) < cfg.collapseThreshold) return -1
  let lo = floor
  let hi = n - cfg.collapseMinChars
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (collapseScore(s, mid, n, cfg) >= cfg.collapseThreshold) hi = mid
    else lo = mid + 1
  }
  return lo
}

function guardStream(makeInner, options, cfg, stats, log) {
  const model = options.model
  return (async function* () {
    const inner = makeInner()
    let buf = ''
    let pending = 0
    let squelching = false
    let squelchMode = ''
    let squelchChars = 0
    let cleanChars = 0
    let bypass = false
    let stopped = false

    function trip(mode, detail) {
      if (!squelching) {
        squelching = true
        squelchMode = mode
        squelchChars = 0
        stats.trips++
        if (mode === 'cycle') stats.cycleTrips++
        else stats.collapseTrips++
        try { log('tripped by ' + mode + ' model=' + model + ' ' + detail, true) } catch (logErr) { /* 日志失败不影响抑制 */ }
      }
      cleanChars = 0
    }

    try {
      for await (const chunk of inner) {
        const t = chunk.type

        if (bypass) { yield chunk; continue }

        if (t === 'reasoning-delta' || t === 'text-delta') {
          const on = t === 'reasoning-delta' ? cfg.reasoning : cfg.text
          if (on) {
            try {
              buf = (buf + chunk.text).slice(-cfg.window)
              pending += chunk.text.length
              if (pending >= cfg.checkEvery) {
                pending = 0
                const hit = detectCycle(buf, cfg)
                if (hit !== null) {
                  trip('cycle', 'period=' + hit.period + ' reps=' + hit.reps + ' run=' + hit.chars
                    + ' unit=' + JSON.stringify(String(hit.unit).slice(0, 24)))
                } else if (cfg.collapse && tailCollapseScore(buf, cfg) >= cfg.collapseThreshold) {
                  if (!squelching) trip('collapse', 'gram=' + cfg.collapseGram + ' score>=' + cfg.collapseThreshold)
                  cleanChars = 0
                } else if (squelching) {
                  cleanChars += cfg.checkEvery
                  if (cleanChars >= cfg.escapeChars) {
                    squelching = false
                    squelchMode = ''
                    stats.escapes++
                  }
                }
              }
            } catch (err) {
              stats.detectorErrors++
              bypass = true
              try { log('detector failed, bypassing: ' + String(err), true) } catch (logErr) { /* ignore */ }
              yield chunk
              continue
            }

            if (squelching) {
              squelchChars += chunk.text.length
              stats.suppressedChars += chunk.text.length
              if (cfg.hardStop && cfg.hardStopMode !== 'off' && squelchChars >= cfg.hardStopChars) {
                stats.hardStops++
                if (cfg.hardStopMode === 'retry') {
                  stats.hardStopsRetry++
                  try { log('hard stop -> retry model=' + model + ' suppressed=' + squelchChars, true) } catch (logErr) { /* ignore */ }
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
                  try { log('hard stop -> silent model=' + model + ' suppressed=' + squelchChars, true) } catch (logErr) { /* ignore */ }
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
          squelchMode = ''
          cleanChars = 0
          buf = ''
          pending = 0
          yield chunk
          continue
        }

        // block-end 携带组装层 authoritative 的完整文本，会完全覆盖 delta 累积。
        // 不在这里做清除，前面所有抑制都会被它还原。
        if (t === 'block-end') {
          const b = chunk.block
          if (b !== undefined && b !== null
            && (b.type === 'reasoning' || b.type === 'text')
            && typeof b.text === 'string') {
            const on = b.type === 'reasoning' ? cfg.reasoning : cfg.text
            if (on) {
              try {
                let out = stripCycles(b.text, cfg)
                let how = out !== b.text ? 'cycle' : ''
                if (cfg.collapse) {
                  const cs = findCollapseStart(out, cfg)
                  if (cs >= 0) {
                    // 至少留一小段，避免产出空 block
                    const keep = cs > 32 ? cs : 32
                    if (keep < out.length) {
                      out = out.slice(0, keep)
                      how = how === '' ? 'collapse' : 'cycle+collapse'
                    }
                  }
                }
                if (out !== b.text) {
                  stats.blockTrims++
                  if (how.indexOf('collapse') >= 0) stats.collapseTrims++
                  stats.suppressedChars += b.text.length - out.length
                  try {
                    log('block cleaned by ' + how + ' model=' + model + ' type=' + b.type
                      + ' from=' + b.text.length + ' to=' + out.length, true)
                  } catch (logErr) { /* ignore */ }
                  yield { type: 'block-end', index: chunk.index, block: { type: b.type, text: out } }
                  continue
                }
              } catch (err) {
                stats.detectorErrors++
                try { log('block detector failed: ' + String(err), true) } catch (logErr) { /* ignore */ }
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
    cycleTrips: 0,
    collapseTrips: 0,
    escapes: 0,
    hardStops: 0,
    hardStopsRetry: 0,
    hardStopsStop: 0,
    retries: 0,
    retriesExhausted: 0,
    blockTrims: 0,
    collapseTrims: 0,
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
      try { log('gate failed, passing through: ' + String(err), true) } catch (logErr) { /* ignore */ }
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
        try { log('retry limit reached (' + cfg.maxLoopRetries + ') key=' + key + ', giving up', true) } catch (logErr) { /* ignore */ }
        return next()
      }
      stats.retries++
      try { log('retry ' + used + '/' + cfg.maxLoopRetries + ' after loop key=' + key, true) } catch (logErr) { /* ignore */ }
      return { kind: 'retry' }
    } catch (err) {
      stats.detectorErrors++
      try { log('retry gate failed: ' + String(err), true) } catch (logErr) { /* ignore */ }
      return next()
    }
  })

  log('active models=' + JSON.stringify(cfg.models)
    + ' cycle(minRepeats=' + cfg.minRepeats + ',minRunChars=' + cfg.minRunChars + ')'
    + ' collapse=' + cfg.collapse + '(g=' + cfg.collapseGram + ',T=' + cfg.collapseThreshold + ')'
    + ' hardStopMode=' + cfg.hardStopMode
    + ' hardStopChars=' + cfg.hardStopChars
    + ' maxLoopRetries=' + cfg.maxLoopRetries)
}
