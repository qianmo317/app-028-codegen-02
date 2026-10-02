/**
 * 批次库存台账核心：入库、先进先出（FIFO）扣减、余额、有效期提醒、时间段对账。
 * 纯函数、无 Vue 依赖，方便自检断言。
 */
import type {
  BatchAlloc,
  Consumption,
  Paper,
  PaperBatch,
} from './types'
import { newId } from './library'
import { round } from './units'

const EPS = 1e-6

/** 规格匹配键：按物理尺寸（宽高双向）+ 纸张种类；自定义相纸也能对上 */
export function specKey(wMm: number, hMm: number, kind: string): string {
  return `${kind}:${Math.min(wMm, hMm)}x${Math.max(wMm, hMm)}`
}

export function batchKeyOf(b: PaperBatch): string {
  return specKey(b.wMm, b.hMm, b.kind)
}

export function paperKeyOf(p: Paper): string {
  return specKey(p.wMm, p.hMm, p.kind)
}

export function sameSpec(b: PaperBatch, p: Paper): boolean {
  return batchKeyOf(b) === paperKeyOf(p)
}

/** 单位单价（每"张/切张"多少分）= 每包/每卷采购价 ÷ 每包张数/每卷可切张数 */
export function unitPriceCents(b: PaperBatch): number {
  return b.unitsPer > 0 ? b.pricePurchaseCents / b.unitsPer : 0
}

/** 入库总单位数（包数 × 每包张数 / 卷数 × 每卷可切张数） */
export function batchTotalUnits(b: PaperBatch): number {
  return b.qtyIn * b.unitsPer
}

export interface ConsumptionInput {
  taskId: string
  taskName: string
  paper: Paper
  /** 排样定下的张数（估的张数，也是想要扣的张数） */
  units: number
  at?: number
}

export interface ConsumptionIssue {
  level: 'error' | 'warn'
  message: string
}

export interface ConsumptionResult {
  consumption: Consumption
  /** 不足或异常提示（不阻断扣减，仍按实际库存扣） */
  issues: ConsumptionIssue[]
}

/**
 * 先进先出扣减：只在同规格批次里，按入库日期从早到晚（同日按登记先后）扣。
 * 库存不足时把能扣的扣完，差的部分在 issues 里报出来。
 */
export function consumeFifo(
  batches: PaperBatch[],
  consumptions: Consumption[],
  input: ConsumptionInput,
): ConsumptionResult {
  const at = input.at ?? Date.now()
  const active = consumptions.filter((c) => c.status === 'active' && c.taskId !== input.taskId)
  const need = Math.max(0, input.units)
  const key = paperKeyOf(input.paper)

  // 当前各批剩余（截至扣减时刻：只算此前 active 的消耗）
  const remain = new Map<string, number>()
  for (const b of batches) {
    if (batchKeyOf(b) !== key) continue
    let r = batchTotalUnits(b)
    for (const c of active) {
      if (c.at > at) continue
      for (const a of c.allocs) {
        if (a.batchId === b.id) r -= a.units
      }
    }
    remain.set(b.id, Math.max(0, round(r)))
  }

  const order = batches
    .filter((b) => batchKeyOf(b) === key)
    .sort((a, b) => a.inAt - b.inAt || a.id.localeCompare(b.id))

  const allocs: BatchAlloc[] = []
  let got = 0
  for (const b of order) {
    const left = remain.get(b.id) ?? 0
    if (left <= EPS) continue
    const take = round(Math.min(left, need - got))
    if (take <= EPS) break
    allocs.push({ batchId: b.id, units: take, unitPriceCents: round(unitPriceCents(b)) })
    got = round(got + take)
    if (need - got <= EPS) break
  }

  const issues: ConsumptionIssue[] = []
  if (!order.length) {
    issues.push({
      level: 'error',
      message: `台账里没有与「${input.paper.name} ${input.paper.wMm}×${input.paper.hMm}mm」同规格的批次，这次没有扣到库存——请先在库存台账里登记入库`,
    })
  } else if (need - got > EPS) {
    issues.push({
      level: 'error',
      message: `库存不足：需要 ${need} 张，只扣到 ${got} 张，缺 ${round(need - got)} 张；已扣的 ${got} 张已按先进先出记账，请尽快补入库`,
    })
  }
  const nearExp = order.find(
    (b) => b.expiresAt > 0 && b.expiresAt < b.inAt + 1000 * 60 * 60 * 24 * 60,
  )

  const totalCents = round(allocs.reduce((acc, a) => acc + a.units * a.unitPriceCents, 0))
  const consumption: Consumption = {
    id: newId('use'),
    taskId: input.taskId,
    taskName: input.taskName,
    paperId: input.paper.id,
    paperName: input.paper.name,
    wMm: input.paper.wMm,
    hMm: input.paper.hMm,
    kind: input.paper.kind,
    at,
    unitsEstimated: need,
    allocs,
    totalCents,
    status: 'active',
  }
  if (nearExp) {
    issues.push({
      level: 'warn',
      message: `有批次临近有效期，领用前请先核对「库存台账」页的先用提示（FIFO 按入库先后扣，不会自动改用快到期的批次）`,
    })
  }
  return { consumption, issues }
}

/** 退还一笔消耗（不删历史，只置为 reverted，库存自动回补） */
export function revertConsumption(
  c: Consumption,
  reason: string,
  at: number = Date.now(),
): Consumption {
  return { ...c, status: 'reverted', revertedAt: at, reason }
}

/** 该批在给定时刻的剩余单位数（只统计 at 之前 active、未退还的消耗） */
export function batchRemainingAt(
  b: PaperBatch,
  consumptions: Consumption[],
  at: number = Date.now(),
): number {
  let used = 0
  for (const c of consumptions) {
    if (c.status !== 'active' || c.at > at) continue
    for (const a of c.allocs) if (a.batchId === b.id) used += a.units
  }
  return round(batchTotalUnits(b) - used)
}

/** 该批在给定时刻之前已用单位数 */
export function batchUsedAt(
  b: PaperBatch,
  consumptions: Consumption[],
  at: number = Date.now(),
): number {
  let used = 0
  for (const c of consumptions) {
    if (c.status !== 'active' || c.at > at) continue
    for (const a of c.allocs) if (a.batchId === b.id) used += a.units
  }
  return round(used)
}

export interface BatchBalance {
  batch: PaperBatch
  totalUnits: number
  remaining: number
  used: number
  /** 剩余库存按该批单位单价计的金额（分） */
  remainingCents: number
  /** 0=已过期，1=30 天内到期，2=90 天内到期，3=正常/无有效期 */
  expiryLevel: 0 | 1 | 2 | 3
  daysToExpiry: number | null
  /** 建议优先使用（快到期且还有库存） */
  shouldUseFirst: boolean
}

const DAY = 1000 * 60 * 60 * 24

export function expiryInfo(b: PaperBatch, remaining: number, now: number): Pick<BatchBalance, 'expiryLevel' | 'daysToExpiry' | 'shouldUseFirst'> {
  if (!b.expiresAt) return { expiryLevel: 3, daysToExpiry: null, shouldUseFirst: false }
  const days = Math.ceil((b.expiresAt - now) / DAY)
  let level: BatchBalance['expiryLevel'] = 3
  if (days < 0) level = 0
  else if (days <= 30) level = 1
  else if (days <= 90) level = 2
  return { expiryLevel: level, daysToExpiry: days, shouldUseFirst: remaining > EPS && level <= 2 }
}

/** 截至某时刻每批还剩多少 + 到期提醒 */
export function batchBalances(
  batches: PaperBatch[],
  consumptions: Consumption[],
  at: number = Date.now(),
): BatchBalance[] {
  return batches.map((b) => {
    const remaining = batchRemainingAt(b, consumptions, at)
    const used = round(batchTotalUnits(b) - remaining)
    const up = unitPriceCents(b)
    const exp = expiryInfo(b, remaining, at)
    return {
      batch: b,
      totalUnits: batchTotalUnits(b),
      remaining,
      used,
      remainingCents: round(remaining * up),
      ...exp,
    }
  })
}

/* ---------------- 时间段统计与对账 ---------------- */

export interface PeriodRange {
  /** 含 */
  from: number
  /** 含（当日 24 点由调用方自行扩展） */
  to: number
}

export interface PeriodBatchLine {
  batchId: string
  ref: string
  paperName: string
  units: number
  unitPriceCents: number
  cents: number
}

export interface PeriodConsumptionLine {
  consumption: Consumption
  allocLines: PeriodBatchLine[]
  estimated: number
  actualUnits: number
  totalCents: number
  complete: boolean
  /** 与排样估的张数的差：actual - estimated（负数 = 库存没扣够） */
  diffUnits: number
}

export interface PeriodReport {
  from: number
  to: number
  lines: PeriodConsumptionLine[]
  /** 按批汇总的实际成本清单（导出用） */
  batchLines: PeriodBatchLine[]
  actualUnits: number
  actualCents: number
  estimatedUnits: number
  /** 估 - 实的总差（正数 = 有没扣到的纸） */
  diffUnits: number
}

export function inPeriod(ts: number, r: PeriodRange): boolean {
  return ts >= r.from && ts <= r.to
}

/** 时间段台账：实际用了多少张、各批分别多少钱、与估的张数差多少 */
export function periodReport(
  batches: PaperBatch[],
  consumptions: Consumption[],
  range: PeriodRange,
): PeriodReport {
  const batchById = new Map(batches.map((b) => [b.id, b]))
  const lines: PeriodConsumptionLine[] = []
  const agg = new Map<string, PeriodBatchLine>()
  let actualUnits = 0
  let actualCents = 0
  let estimatedUnits = 0

  for (const c of consumptions) {
    if (c.status !== 'active' || !inPeriod(c.at, range)) continue
    const allocLines: PeriodBatchLine[] = c.allocs.map((a) => {
      const b = batchById.get(a.batchId)
      const line: PeriodBatchLine = {
        batchId: a.batchId,
        ref: b?.ref ?? '(批次已删)',
        paperName: b?.paperName ?? c.paperName,
        units: a.units,
        unitPriceCents: a.unitPriceCents,
        cents: round(a.units * a.unitPriceCents),
      }
      const prev = agg.get(a.batchId)
      if (prev) {
        prev.units = round(prev.units + line.units)
        prev.cents = round(prev.cents + line.cents)
      } else {
        agg.set(a.batchId, { ...line })
      }
      return line
    })
    const u = c.allocs.reduce((s, a) => s + a.units, 0)
    actualUnits = round(actualUnits + u)
    actualCents = round(actualCents + c.totalCents)
    estimatedUnits += c.unitsEstimated
    lines.push({
      consumption: c,
      allocLines,
      estimated: c.unitsEstimated,
      actualUnits: round(u),
      totalCents: c.totalCents,
      complete: u >= c.unitsEstimated - EPS,
      diffUnits: round(u - c.unitsEstimated),
    })
  }
  lines.sort((a, b) => a.consumption.at - b.consumption.at)
  const batchLines = [...agg.values()].sort((a, b) => a.ref.localeCompare(b.ref, 'zh'))
  return {
    from: range.from,
    to: range.to,
    lines,
    batchLines,
    actualUnits: round(actualUnits),
    actualCents: round(actualCents),
    estimatedUnits,
    diffUnits: round(estimatedUnits - actualUnits),
  }
}

/* ---------------- 估的张数 vs 实际扣减 对账 ---------------- */

export interface ReconRow {
  taskId: string
  taskName: string
  paperName: string
  /** 排样当时/当前估的张数 */
  estimated: number
  /** 已扣减张数（active） */
  deducted: number
  diff: number
  reasons: string[]
}

/**
 * 全量对账：每个有排样结果的任务一行，指出估的张数和实际扣减差在哪。
 * - 台账无此规格批次：完全没扣
 * - 库存不足：只扣到一部分
 * - 重排/换纸后没重新记账：扣减时估的张数对不上当前排样
 * - 已退还：删除任务或重排导致的还库，active 为 0
 */
export function reconcile(
  tasks: Array<{ id: string; name: string; paperName: string; sheets: number; createdAt: number }>,
  consumptions: Consumption[],
  range?: PeriodRange,
): ReconRow[] {
  const rows: ReconRow[] = []
  for (const t of tasks) {
    if (range && !inPeriod(t.createdAt, range)) continue
    const all = consumptions.filter((c) => c.taskId === t.id)
    const active = all.filter((c) => c.status === 'active')
    const reverted = all.filter((c) => c.status === 'reverted')
    const deducted = round(active.reduce((s, c) => s + c.allocs.reduce((q, a) => q + a.units, 0), 0))
    const estimatedSnap = active.reduce((s, c) => Math.max(s, c.unitsEstimated), 0)
    const diff = round(deducted - t.sheets)
    const reasons: string[] = []
    if (reverted.length && !active.length) {
      reasons.push(`已退还 ${reverted.length} 笔（${reverted.map((c) => c.reason ?? '退还').join('、')}），库存已回补`)
    }
    if (!active.length && !reverted.length) {
      reasons.push('排样后尚未扣减台账（可能该规格还没入库）')
    } else if (active.length) {
      const last = active[active.length - 1]
      if (last.allocs.length === 0) reasons.push('台账中没有同规格批次，一笔都没扣到')
      else if (t.sheets - deducted > EPS) reasons.push('库存不足，有张数没扣够')
      if (estimatedSnap !== t.sheets) {
        reasons.push(`扣减时排样估 ${estimatedSnap} 张，当前排样 ${t.sheets} 张——重排/换纸后需要重新记账`)
      }
    }
    if (Math.abs(diff) <= EPS && reasons.length === 0) reasons.push('一致')
    rows.push({
      taskId: t.id,
      taskName: t.name,
      paperName: t.paperName,
      estimated: t.sheets,
      deducted,
      diff,
      reasons,
    })
  }
  return rows
}

/** 一张相纸（按排样顺序 0..n-1）来自哪个批次：在已完成扣减里按顺序找 */
export function batchOfSheet(consumptions: Consumption[], taskId: string, sheetIndex: number) {
  const c = consumptions.find((x) => x.taskId === taskId && x.status === 'active')
  if (!c) return undefined
  let cursor = 0
  for (const a of c.allocs) {
    const start = cursor
    cursor += a.units
    if (sheetIndex >= start && sheetIndex < cursor - EPS) {
      return { alloc: a, consumption: c, last: sheetIndex >= cursor - 1 - EPS && sheetIndex <= cursor - EPS }
    }
  }
  return undefined
}

/** 任务当前 active 扣减（可能没有） */
export function activeConsumptionOf(consumptions: Consumption[], taskId: string): Consumption | undefined {
  return consumptions.find((c) => c.taskId === taskId && c.status === 'active')
}

/** 给批次一个稳定的柔和底色（纸面批次角标用） */
const BATCH_COLORS = ['#e3f2fd', '#e8f5e9', '#fff8e1', '#fce4ec', '#f3e5f5', '#e0f7fa', '#efebe9', '#f1f8e9']
export function batchColor(batchId: string): string {
  let h = 0
  for (let i = 0; i < batchId.length; i++) h = (h * 31 + batchId.charCodeAt(i)) | 0
  return BATCH_COLORS[Math.abs(h) % BATCH_COLORS.length]
}

/* ---------------- 日期工具 ---------------- */

export function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayEnd(ts: number): number {
  return dayStart(ts) + DAY - 1
}

export function toDateInput(ts: number): string {
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function fromDateInput(s: string): number {
  return s ? dayStart(new Date(`${s}T00:00:00`).getTime()) : 0
}

export function formatDate(ts: number): string {
  if (!ts) return '—'
  return toDateInput(ts)
}

export function formatUnits(n: number): string {
  return round(n).toString()
}
