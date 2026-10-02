/**
 * 库存台账核心逻辑（纯函数，不碰 localStorage / Vue）
 *
 * - 按批次登记：规格、入库日期、包数/卷数、每包张数、采购单价、有效期
 * - 先进先出（FIFO）：从入库最早且规格相同的批次开始扣，一笔消耗可跨多批
 * - 实际成本按扣到的各批分别计价再汇总（不再用固定单价）
 * - 时点结余：某一天/月底每批还剩多少；临期批次优先提示
 * - 消耗 posted 即扣、void 即还（任务删除/重排自动还回），一笔只能扣一次
 */
import type {
  PaperBatch,
  PaperKind,
  StockAllocation,
  StockConsumption,
  StockUnit,
} from './types'

/* ---------------- 日期（YYYY-MM-DD，本地时区，无第三方依赖） ---------------- */

export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime())
}

/** 日期字符串可直接按字典序比较（YYYY-MM-DD） */
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime()
  const db = new Date(`${b}T00:00:00`).getTime()
  return Math.round((db - da) / 86400000)
}

/** 剩余有效期天数（今天 - 有效期），负数表示已过期 */
export function daysToExpire(expireDate: string, today = todayStr()): number | null {
  if (!expireDate) return null
  return daysBetween(today, expireDate)
}

export function monthStartStr(s: string): string {
  return `${s.slice(0, 7)}-01`
}

export function monthEndStr(s: string): string {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const last = new Date(y, m, 0).getDate()
  return `${s.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

/* ---------------- 规格与批次基础计算 ---------------- */

/** 规格匹配键：卷筒只按宽度（同宽不同长度视为同规格）；平张按 宽×高 */
export function specKey(wMm: number, hMm: number, kind: PaperKind): string {
  return kind === 'roll' ? `roll@${Math.round(wMm)}` : `sheet@${Math.round(wMm)}x${Math.round(hMm)}`
}

export function batchSpecKey(b: PaperBatch): string {
  return specKey(b.wMm, b.hMm, b.kind)
}

export function specLabel(wMm: number, hMm: number, kind: PaperKind): string {
  return kind === 'roll' ? `卷筒 宽${Math.round(wMm)}mm` : `${Math.round(wMm)}×${Math.round(hMm)}mm`
}

export const UNIT_LABEL: Record<StockUnit, string> = {
  sheets: '张',
  pack: '包',
  roll: '卷',
}

/** 一批折合多少张 */
export function batchTotalSheets(b: PaperBatch): number {
  return Math.max(0, b.units) * Math.max(1, b.sheetsPerUnit)
}

/** 该批每张成本（分，可能含小数；包/卷价 ÷ 每包/卷张数；散张即每张价） */
export function batchUnitCostCents(b: PaperBatch): number {
  if (b.unit === 'sheets') return b.priceCents
  return b.sheetsPerUnit > 0 ? b.priceCents / b.sheetsPerUnit : 0
}

/* ---------------- FIFO 扣减 ---------------- */

export interface FifoLine {
  batch: PaperBatch
  /** 扣减时点该批结余张数 */
  available: number
  sheets: number
  unitCostCents: number
  lineCostCents: number
}

export interface FifoPlan {
  lines: FifoLine[]
  totalSheets: number
  totalCostCents: number
}

/**
 * 按截至 atDate 的已过账消耗，算每批当时的结余张数。
 * void（含还回）的消耗不参与扣减。
 */
export function availableByBatch(
  batches: PaperBatch[],
  consumptions: StockConsumption[],
  atDate = '9999-12-31',
): Map<string, number> {
  const map = new Map<string, number>()
  for (const b of batches) map.set(b.id, b.inDate <= atDate ? batchTotalSheets(b) : 0)
  for (const c of consumptions) {
    if (c.status !== 'posted') continue
    if (c.date > atDate) continue
    for (const a of c.allocations) {
      map.set(a.batchId, (map.get(a.batchId) ?? 0) - a.sheets)
    }
  }
  return map
}

/**
 * 试算一次 FIFO 扣减（不修改数据）。
 * 库存不足时返回 { error }，调用方应阻止过账。
 * 排序：入库日期最早优先；同日按批次 id 稳定排序（与录入顺序一致）。
 */
export function planFifo(
  batches: PaperBatch[],
  consumptions: StockConsumption[],
  wMm: number,
  hMm: number,
  kind: PaperKind,
  sheets: number,
  opts: { atDate?: string; excludeConsumptionId?: string } = {},
): FifoPlan & { error?: string } {
  if (sheets <= 0 || !Number.isFinite(sheets)) {
    return { lines: [], totalSheets: 0, totalCostCents: 0, error: '扣减张数必须大于 0' }
  }
  const key = specKey(wMm, hMm, kind)
  const atDate = opts.atDate ?? '9999-12-31'
  // 重排还回后重新扣时，把自己原来的扣减先排除（相当于先还回再重扣）
  const prior = consumptions.filter(
    (c) => c.status === 'posted' && c.date <= atDate && c.id !== opts.excludeConsumptionId,
  )
  const used = new Map<string, number>()
  for (const c of prior) {
    for (const a of c.allocations) {
      used.set(a.batchId, (used.get(a.batchId) ?? 0) + a.sheets)
    }
  }
  const candidates = batches
    .filter((b) => batchSpecKey(b) === key && b.inDate <= atDate)
    .map((b) => ({ b, left: batchTotalSheets(b) - (used.get(b.id) ?? 0) }))
    .filter((x) => x.left > 0)
    .sort((x, y) => (x.b.inDate === y.b.inDate ? (x.b.id < y.b.id ? -1 : 1) : x.b.inDate < y.b.inDate ? -1 : 1))

  const lines: FifoLine[] = []
  let need = Math.round(sheets)
  let totalCost = 0
  for (const { b, left } of candidates) {
    if (need <= 0) break
    const take = Math.min(need, left)
    const unitCost = batchUnitCostCents(b)
    const lineCost = take * unitCost
    lines.push({ batch: b, available: left, sheets: take, unitCostCents: unitCost, lineCostCents: lineCost })
    totalCost += lineCost
    need -= take
  }
  if (need > 0) {
    const spec = specLabel(wMm, hMm, kind)
    const stock = candidates.reduce((acc, x) => acc + x.left, 0)
    return {
      lines: [],
      totalSheets: 0,
      totalCostCents: 0,
      error: `${spec} 规格库存不足：本次要扣 ${Math.round(sheets)} 张，FIFO 可用仅 ${stock} 张（${
        sheets - stock
      } 张缺口）。请先在库存台账登记入库，或改用其它规格排样。`,
    }
  }
  return { lines, totalSheets: Math.round(sheets), totalCostCents: totalCost }
}

/** 把 FIFO 试算结果转成持久化的分配明细 */
export function allocationsFromPlan(plan: FifoPlan): StockAllocation[] {
  return plan.lines.map((l) => ({
    batchId: l.batch.id,
    sheets: l.sheets,
    unitCostCents: l.unitCostCents,
    lineCostCents: l.lineCostCents,
  }))
}

/* ---------------- 批次时点结余 / 临期 ---------------- */

export interface BatchBalance {
  batch: PaperBatch
  inSheets: number
  /** atDate 时点结余张数 */
  remaining: number
  /** 已消耗张数（截至 atDate） */
  used: number
  /** 每张成本（分） */
  unitCostCents: number
  /** 结余按批次进价折算的库存金额（分） */
  remainingCostCents: number
  /** 截至 atDate 是否已有入库 */
  existsAt: boolean
  expireInDays: number | null
  /** expired 已过期 / soon 30 天内到期 / ok */
  expireStatus: 'expired' | 'soon' | 'ok' | 'none'
}

export function batchBalances(
  batches: PaperBatch[],
  consumptions: StockConsumption[],
  opts: { atDate?: string; today?: string; warnDays?: number } = {},
): BatchBalance[] {
  const atDate = opts.atDate ?? '9999-12-31'
  const today = opts.today ?? todayStr()
  const warnDays = opts.warnDays ?? 30
  const avail = availableByBatch(batches, consumptions, atDate)
  const usedMap = new Map<string, number>()
  for (const c of consumptions) {
    if (c.status !== 'posted' || c.date > atDate) continue
    for (const a of c.allocations) usedMap.set(a.batchId, (usedMap.get(a.batchId) ?? 0) + a.sheets)
  }
  return batches
    .map((b) => {
      const inSheets = batchTotalSheets(b)
      const remaining = Math.max(0, avail.get(b.id) ?? 0)
      const used = usedMap.get(b.id) ?? 0
      const unit = batchUnitCostCents(b)
      const d = daysToExpire(b.expireDate, today)
      let status: BatchBalance['expireStatus'] = 'none'
      if (d !== null) {
        if (d < 0) status = 'expired'
        else if (d <= warnDays) status = 'soon'
        else status = 'ok'
      }
      return {
        batch: b,
        inSheets,
        remaining,
        used,
        unitCostCents: unit,
        remainingCostCents: remaining * unit,
        existsAt: b.inDate <= atDate,
        expireInDays: d,
        expireStatus: status,
      }
    })
    .sort((a, b2) =>
      a.batch.inDate === b2.batch.inDate
        ? a.batch.id < b2.batch.id
          ? -1
          : 1
        : a.batch.inDate < b2.batch.inDate
          ? -1
          : 1,
    )
}

/** 该先用提示：已过期/临期且仍有结余的批次（按紧急程度排序） */
export function urgentBatches(balances: BatchBalance[]): BatchBalance[] {
  const rank = { expired: 0, soon: 1, ok: 2, none: 3 } as const
  return balances
    .filter((x) => x.remaining > 0 && (x.expireStatus === 'expired' || x.expireStatus === 'soon'))
    .sort((a, b) =>
      rank[a.expireStatus] !== rank[b.expireStatus]
        ? rank[a.expireStatus] - rank[b.expireStatus]
        : (a.expireInDays ?? 0) - (b.expireInDays ?? 0),
    )
}

/* ---------------- 时段报表（实际用量/花费 vs 排样估算） ---------------- */

export interface ConsumptionRow {
  c: StockConsumption
  paperName: string
  fixedCostCents: number
  varianceSheets: number
  varianceCostCents: number
  reasons: string[]
  allocations: Array<{ batch?: PaperBatch; a: StockAllocation }>
}

export interface PeriodReport {
  from: string
  to: string
  rows: ConsumptionRow[]
  totalActualSheets: number
  totalEstimatedSheets: number
  totalVarianceSheets: number
  totalActualCostCents: number
  totalFixedCostCents: number
  /** 实际批次成本 − 固定单价估算（负数 = 用了便宜批次，反而更省） */
  totalVarianceCostCents: number
  postedCount: number
  voidedCount: number
}

/**
 * 时段消耗明细。
 * @param fixedUnitPriceCentsOf 规格 -> 排样当时采用的「固定单价」（分/张），
 *   取任务排样用的相纸库单价；用于回答「不按批次价、按老算法该花多少」。
 */
export function periodReport(
  batches: PaperBatch[],
  consumptions: StockConsumption[],
  from: string,
  to: string,
  fixedUnitPriceCentsOf: (wMm: number, hMm: number, kind: PaperKind) => number = () => 0,
): PeriodReport {
  const batchMap = new Map(batches.map((b) => [b.id, b]))
  const inRange = (c: StockConsumption) => c.date >= from && c.date <= to
  const posted = consumptions.filter((c) => c.status === 'posted' && inRange(c))
  const voided = consumptions.filter((c) => c.status === 'void' && inRange(c))

  const rows: ConsumptionRow[] = posted.map((c) => {
    const fixedPrice = fixedUnitPriceCentsOf(c.wMm, c.hMm, c.kind)
    const fixedCost = fixedPrice * c.actualSheets
    const varianceSheets = c.actualSheets - c.estimatedSheets
    const reasons: string[] = []
    if (varianceSheets > 0) {
      reasons.push(
        `实际比排样当时多耗 ${varianceSheets} 张（排样后重排/清单调整，或登记的实际用纸多于版面）`,
      )
    } else if (varianceSheets < 0) {
      reasons.push(`实际比排样当时少耗 ${-varianceSheets} 张（重排后利用率提高或实际少印）`)
    }
    if (Math.abs(c.actualCostCents - fixedCost) > 0.005 && c.allocations.length > 0) {
      const batchesUsed = new Set(c.allocations.map((a) => a.batchId)).size
      reasons.push(
        batchesUsed > 1
          ? `本次跨 ${batchesUsed} 批取纸，各批进价不同，固定单价算不准`
          : '取到的批次进价与固定单价不一致',
      )
    }
    return {
      c,
      paperName: c.paperName,
      fixedCostCents: fixedCost,
      varianceSheets,
      varianceCostCents: c.actualCostCents - fixedCost,
      reasons,
      allocations: c.allocations.map((a) => ({ batch: batchMap.get(a.batchId), a })),
    }
  })

  const sum = <T>(arr: T[], f: (x: T) => number) => arr.reduce((acc, x) => acc + f(x), 0)
  const totalActualSheets = sum(rows, (r) => r.c.actualSheets)
  const totalEstimatedSheets = sum(rows, (r) => r.c.estimatedSheets)
  const totalActualCost = sum(rows, (r) => r.c.actualCostCents)
  const totalFixedCost = sum(rows, (r) => r.fixedCostCents)
  return {
    from,
    to,
    rows,
    totalActualSheets,
    totalEstimatedSheets,
    totalVarianceSheets: totalActualSheets - totalEstimatedSheets,
    totalActualCostCents: totalActualCost,
    totalFixedCostCents: totalFixedCost,
    totalVarianceCostCents: totalActualCost - totalFixedCost,
    postedCount: posted.length,
    voidedCount: voided.length,
  }
}

/* ---------------- 导出 CSV 行（带批次） ---------------- */

/** 消耗 -> 每个批次一行（成本清单带批次） */
export function costDetailRows(report: PeriodReport): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    [
      '消耗日期',
      '任务',
      '相纸规格',
      '批次号',
      '批次入库日期',
      '批次有效期至',
      '本批扣减张数',
      '本批每张单价（元）',
      '本批成本（元）',
    ],
  ]
  for (const r of report.rows) {
    for (const { batch, a } of r.allocations) {
      rows.push([
        r.c.date,
        r.c.taskName,
        batch ? specLabel(batch.wMm, batch.hMm, batch.kind) : specLabel(r.c.wMm, r.c.hMm, r.c.kind),
        batch?.code ?? `（批次已删除 ${a.batchId}）`,
        batch?.inDate ?? '',
        batch?.expireDate ?? '',
        a.sheets,
        (a.unitCostCents / 100).toFixed(4),
        (a.lineCostCents / 100).toFixed(2),
      ])
    }
  }
  rows.push([])
  rows.push(['统计区间', `${report.from} ~ ${report.to}`])
  rows.push(['消耗笔数（已扣）', report.postedCount])
  rows.push(['实际用纸（张）', report.totalActualSheets])
  rows.push(['排样估算合计（张）', report.totalEstimatedSheets])
  rows.push(['张数差异（实际-估算）', report.totalVarianceSheets])
  rows.push(['实际批次成本合计（元）', (report.totalActualCostCents / 100).toFixed(2)])
  rows.push(['固定单价估算合计（元）', (report.totalFixedCostCents / 100).toFixed(2)])
  rows.push(['成本差异（批次成本-固定单价）（元）', (report.totalVarianceCostCents / 100).toFixed(2)])
  return rows
}

/** 批次台账：入/耗/余 + 临期标记 */
export function batchLedgerRows(balances: BatchBalance[], atDate: string): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    [
      '批次号',
      '规格',
      '入库日期',
      '单位',
      '入库数量',
      '每单位张数',
      '入库总张数',
      `截至 ${atDate} 已耗（张）`,
      `截至 ${atDate} 结余（张）`,
      '采购单价（元）',
      '每张成本（元）',
      '有效期至',
      '效期状态',
      '结余金额（元）',
      '备注',
    ],
  ]
  const statusText = { expired: '已过期', soon: '临期', ok: '正常', none: '未设有效期' } as const
  for (const x of balances) {
    const b = x.batch
    rows.push([
      b.code,
      specLabel(b.wMm, b.hMm, b.kind),
      b.inDate,
      UNIT_LABEL[b.unit],
      b.units,
      b.sheetsPerUnit,
      x.inSheets,
      x.existsAt ? x.used : 0,
      x.existsAt ? x.remaining : 0,
      (b.priceCents / 100).toFixed(2),
      (x.unitCostCents / 100).toFixed(4),
      b.expireDate,
      statusText[x.expireStatus],
      (x.remainingCostCents / 100).toFixed(2),
      b.note,
    ])
  }
  return rows
}

/* ---------------- 批次色（纸面视图标记来自哪一批） ---------------- */

const BATCH_COLORS = [
  '#1f6feb',
  '#e87900',
  '#1a7f4b',
  '#a847c9',
  '#c62828',
  '#00838f',
  '#6d4c41',
  '#455a64',
  '#c2185b',
  '#558b2f',
]

/** 按批次出现顺序给稳定颜色 */
export function batchColorOf(batchIds: string[], batchId: string): string {
  const i = batchIds.indexOf(batchId)
  return BATCH_COLORS[(i < 0 ? 0 : i) % BATCH_COLORS.length]
}
