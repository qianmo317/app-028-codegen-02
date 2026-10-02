/** 库存台账相关 CSV：成本清单（带批次）、时间段汇总、批次余额、对账 */
import type { BatchBalance, PeriodReport } from './inventory'
import type { Consumption, PaperBatch } from './types'

const yuan = (cents: number) => (cents / 100).toFixed(4)

function batchRef(batches: PaperBatch[], id: string): string {
  return batches.find((b) => b.id === id)?.ref ?? '(批次已删)'
}

/** 单个任务的成本清单：每一张纸一行，带上它实际来自哪个批次（纸面视图的台账版） */
export function taskCostRows(
  taskName: string,
  consumption: Consumption | undefined,
  estimated: number,
  batches: PaperBatch[],
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    ['任务', taskName],
    ['相纸', consumption ? `${consumption.paperName} ${consumption.wMm}x${consumption.hMm}mm` : ''],
    ['排样估的张数', estimated],
    ['实际扣减张数', consumption?.allocs.reduce((s, a) => s + a.units, 0) ?? 0],
    ['实际材料成本（元）', consumption ? yuan(consumption.totalCents) : '0.0000'],
    ['记账时间', consumption ? new Date(consumption.at).toLocaleString() : ''],
    [],
    ['相纸序号', '批次', '规格', '该批单位单价（元）', '该批小计（元）'],
  ]
  if (!consumption || !consumption.allocs.length) {
    rows.push(['—', '（未扣到任何批次：库存不足或该规格未入库）', '', '', ''])
    return rows
  }
  let index = 1
  for (const a of consumption.allocs) {
    const b = batches.find((x) => x.id === a.batchId)
    rows.push([
      `${index}~${index + a.units - 1}`,
      batchRef(batches, a.batchId),
      b ? `${b.paperName} ${b.wMm}x${b.hMm}mm` : '',
      yuan(a.unitPriceCents),
      yuan(a.units * a.unitPriceCents),
    ])
    index += a.units
  }
  rows.push([])
  rows.push(['合计', '', '', '', yuan(consumption.totalCents)])
  return rows
}

/** 时间段实际成本清单：每笔消耗 × 每个批次一行 */
export function periodCostRows(report: PeriodReport): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    ['统计起', new Date(report.from).toLocaleDateString()],
    ['统计止', new Date(report.to).toLocaleDateString()],
    ['实际用纸张数（合计）', report.actualUnits],
    ['排样估的张数（合计）', report.estimatedUnits],
    ['估 - 实 差额（张）', report.diffUnits],
    ['实际材料成本合计（元）', yuan(report.actualCents)],
    [],
    ['消耗时间', '任务', '相纸', '排样估的张数', '实际扣减', '批次', '该批单位单价（元）', '本批扣减', '本批金额（元）'],
  ]
  for (const line of report.lines) {
    const c = line.consumption
    line.allocLines.forEach((a, i) => {
      rows.push([
        i === 0 ? new Date(c.at).toLocaleString() : '',
        i === 0 ? c.taskName : '',
        i === 0 ? `${c.paperName} ${c.wMm}x${c.hMm}mm` : '',
        i === 0 ? line.estimated : '',
        i === 0 ? line.actualUnits : '',
        a.ref,
        yuan(a.unitPriceCents),
        a.units,
        yuan(a.cents),
      ])
    })
    if (!line.allocLines.length) {
      rows.push([new Date(c.at).toLocaleString(), c.taskName, c.paperName, line.estimated, 0, '（库存不足，未扣到批次）', '', 0, '0.0000'])
    }
  }
  rows.push([])
  rows.push(['按批次汇总', '', '', '', '', '批次', '单位单价（元）', '用量', '金额（元）'])
  for (const b of report.batchLines) {
    rows.push(['', '', '', '', '', b.ref, yuan(b.unitPriceCents), b.units, yuan(b.cents)])
  }
  rows.push(['合计', '', '', '', '', '', '', report.actualUnits, yuan(report.actualCents)])
  return rows
}

/** 批次余额表（时间段视角：截至某日每批还剩多少） */
export function batchBalanceRows(
  balances: BatchBalance[],
  atText: string,
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    ['截至', atText],
    [],
    ['批次', '相纸规格', '入库日期', '有效期', '入库(包/卷)', '每包张/每卷切张', '采购单价（元）', '单位单价（元）', '剩余', '已用', '剩余金额（元）', '到期提醒'],
  ]
  for (const x of balances) {
    const b = x.batch
    const warn =
      x.expiryLevel === 0
        ? `已过期 ${Math.abs(x.daysToExpiry ?? 0)} 天`
        : x.expiryLevel === 1
          ? `${x.daysToExpiry} 天内到期，先用！`
          : x.expiryLevel === 2
            ? `${x.daysToExpiry} 天内到期`
            : ''
    rows.push([
      b.ref,
      `${b.paperName} ${b.wMm}x${b.hMm}mm`,
      new Date(b.inAt).toLocaleDateString(),
      b.expiresAt ? new Date(b.expiresAt).toLocaleDateString() : '',
      b.qtyIn,
      b.unitsPer,
      (b.pricePurchaseCents / 100).toFixed(2),
      yuan(b.pricePurchaseCents / b.unitsPer),
      x.remaining,
      x.used,
      yuan(x.remainingCents),
      warn,
    ])
  }
  return rows
}

/** 对账表：每个任务估的张数 vs 实际扣减，差在哪里 */
export function reconcileRows(
  rows: Array<{
    taskName: string
    paperName: string
    estimated: number
    deducted: number
    diff: number
    reasons: string[]
  }>,
  rangeText: string,
): Array<Array<string | number>> {
  return [
    ['对账区间', rangeText],
    [],
    ['任务', '相纸', '排样估的张数', '实际扣减', '差（实-估）', '差异说明'],
    ...rows.map((r) => [
      r.taskName,
      r.paperName,
      r.estimated,
      r.deducted,
      r.diff,
      r.reasons.join('；'),
    ]),
  ]
}
